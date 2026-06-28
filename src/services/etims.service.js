// ── ETIMS SERVICE ─────────────────────────────────────────────────────────────
// Submits fiscal invoices to KRA's eTIMS OSDC API after payment confirmation.
// Credentials are read from GlobalSettings (configured via superadmin UI).
//
// KRA eTIMS OSDC docs: https://etims.kra.go.ke/documentation
// Sandbox:    https://etims-sbx.kra.go.ke/etims-api
// Production: https://etims.kra.go.ke/etims-api
//
// All calls are fire-and-forget — they never block the order/payment flow.

const axios = require('axios');
const Order                = require('../models/Order');
const globalSettingsService = require('./globalSettings.service');
const logger               = require('../utils/logger');
const { PAYMENT_METHODS, PAYMENT_STATUSES, ORDER_STATUSES } = require('../utils/constants');

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const PAYMENT_TYPE_CODES = {
  [PAYMENT_METHODS.MPESA]:    '02', // Mobile Money
  [PAYMENT_METHODS.PICKUP]:   '01', // Cash
  [PAYMENT_METHODS.DELIVERY]: '01', // Cash on delivery
};

// UNSPSC commodity code for cereal grains — refine per-product if needed
const ITEM_CLASS_CODE = '50221700';

// ── BUILD REQUEST PAYLOAD ─────────────────────────────────────────────────────
const buildPayload = (order, tin, bhfId) => {
  const vatEnabled = order.vatEnabled === true;
  const vatRate    = vatEnabled ? (Number(order.vatRate) || 0) : 0;

  const now    = new Date();
  const cfmDt  = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14); // YYYYMMDDHHmmss
  const salesDt = new Date(order.createdAt).toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD

  const itemList = order.orderItems.map((item, idx) => {
    const taxblAmt = vatEnabled && vatRate > 0
      ? Math.round((item.lineTotal / (1 + vatRate / 100)) * 100) / 100
      : item.lineTotal;
    const taxAmt = vatEnabled ? Math.round((item.lineTotal - taxblAmt) * 100) / 100 : 0;

    return {
      itemSeq:   idx + 1,
      itemCd:    item.productId.toString(),
      itemClsCd: ITEM_CLASS_CODE,
      itemNm:    `${item.productName} - ${item.variety} ${item.packaging}`,
      bcd:       '',
      pkgUnt:    'KG',
      qty:       item.quantity,
      prc:       item.unitPrice,
      splyAmt:   item.lineTotal,
      dcRt:      0,
      dcAmt:     0,
      taxblAmt,
      taxTyCd:   vatEnabled && vatRate > 0 ? 'B' : 'E', // B = 16% VAT, E = exempt
      taxAmt,
      totAmt:    item.lineTotal,
    };
  });

  return {
    tin,
    bhfId,
    invcNo:      0,
    orgInvcNo:   0,
    custTin:     order.buyerKraPin || null,
    custNm:      null,
    rcptTyCd:    'S',    // S = Sale
    pmtTyCd:     PAYMENT_TYPE_CODES[order.paymentMethod] || '01',
    salesSttsCd: '02',   // 02 = Approved
    cfmDt,
    salesDt,
    totItemCnt:  itemList.length,
    taxblAmtA: 0,
    taxblAmtB: vatEnabled ? order.subtotal : 0,
    taxblAmtC: 0,
    taxblAmtD: 0,
    taxblAmtE: vatEnabled ? 0 : order.subtotal,
    taxRtA: 0,  taxRtB: vatRate, taxRtC: 0, taxRtD: 0, taxRtE: 0,
    taxAmtA: 0, taxAmtB: order.vatAmount || 0, taxAmtC: 0, taxAmtD: 0, taxAmtE: 0,
    totTaxblAmt: order.subtotal,
    totTaxAmt:   order.vatAmount || 0,
    totAmt:      order.total,
    remark:      order.specialInstructions || order.orderRef,
    itemList,
  };
};

// ── SUBMIT INVOICE ────────────────────────────────────────────────────────────
const submitInvoice = async (orderId) => {
  const global = await globalSettingsService.getSettings();
  const { enabled, baseUrl, tin, bhfId = '00', deviceId } = global.etims || {};

  if (!enabled || !baseUrl || !tin || !deviceId) {
    logger.debug('[eTIMS] Skipping — not enabled or credentials not configured');
    return;
  }

  const order = await Order.findById(orderId)
    .select('orderRef orderItems subtotal deliveryFee vatEnabled vatRate vatAmount total paymentMethod specialInstructions createdAt etimsStatus etimsInvoiceNumber status paymentStatus buyerKraPin')
    .lean();

  if (!order) {
    logger.error('[eTIMS] Order not found', { orderId });
    return;
  }

  // Idempotency — also check etimsInvoiceNumber in case etimsStatus was manually reset
  if (order.etimsStatus === 'submitted' || order.etimsInvoiceNumber) {
    logger.info('[eTIMS] Already submitted, skipping', { orderId, orderRef: order.orderRef, invoiceNo: order.etimsInvoiceNumber });
    return;
  }

  // Only invoice orders in a valid terminal state
  if (!['out_for_delivery', 'completed'].includes(order.status)) {
    logger.warn('[eTIMS] Skipping — order not in invoiceable state', { orderId, status: order.status });
    return;
  }

  // Never invoice an unpaid order
  if (order.paymentStatus !== PAYMENT_STATUSES.PAID) {
    logger.warn('[eTIMS] Skipping — order payment not confirmed', { orderId, paymentStatus: order.paymentStatus });
    return;
  }

  await Order.findByIdAndUpdate(orderId, { etimsStatus: 'pending' });

  try {
    const payload  = buildPayload(order, tin, bhfId);
    const response = await axios.post(`${baseUrl}/saveTrnsSaleOsdc`, payload, {
      headers: {
        'Content-Type': 'application/json',
        tin,
        bhfId,
        dvcSrNo: deviceId,
      },
      timeout: 15_000,
    });

    const resultCd = response.data?.resultCd;
    if (resultCd !== '000') {
      throw new Error(`eTIMS error: ${response.data?.resultMsg} (code ${resultCd})`);
    }

    const { rcptNo, rcptSign, intrlData, tradeIvtNo } = response.data.data || {};

    await Order.findByIdAndUpdate(orderId, {
      etimsStatus:        'submitted',
      etimsInvoiceNumber: String(tradeIvtNo ?? rcptNo ?? ''),
      etimsControlNumber: rcptSign ?? intrlData ?? '',
    });

    logger.info('[eTIMS] Invoice submitted', {
      orderId,
      orderRef:  order.orderRef,
      invoiceNo: tradeIvtNo ?? rcptNo,
    });

  } catch (err) {
    await Order.findByIdAndUpdate(orderId, { etimsStatus: 'failed' });
    logger.error('[eTIMS] Submission failed', { orderId, orderRef: order.orderRef, err: err.message });
    throw err;
  }
};

module.exports = { submitInvoice };
