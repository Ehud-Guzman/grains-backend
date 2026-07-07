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
// Every figure here is derived from the order's OWN stored subtotal/couponDiscount/
// vatAmount/deliveryFee/total (never recomputed from live product prices). Discount
// is allocated proportionally across all items by value share; VAT (order.vatAmount)
// is allocated only across items snapshotted as taxable (item.taxable !== false) —
// exempt lines (e.g. by-products) get taxTyCd 'E' and zero tax. Largest-remainder
// correction on the last item of each group keeps sum(itemList.totAmt) reconciling
// exactly to order.total and taxblAmtB/E reconciling to taxAmtB.
const buildPayload = (order, tin, bhfId) => {
  const vatEnabled = order.vatEnabled === true;
  const vatRate    = vatEnabled ? (Number(order.vatRate) || 0) : 0;
  const subtotal        = Number(order.subtotal) || 0;
  const couponDiscount  = Number(order.couponDiscount) || 0;
  const deliveryFee     = Number(order.deliveryFee) || 0;
  const vatAmount       = Number(order.vatAmount) || 0;

  const now    = new Date();
  const cfmDt  = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14); // YYYYMMDDHHmmss
  const salesDt = new Date(order.createdAt).toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD

  // VAT is only owed on taxable lines (e.g. by-products are exempt) — allocate
  // order.vatAmount across taxable items only, largest-remainder on the last one.
  const taxableItemsTotal = order.orderItems
    .filter(item => item.taxable !== false)
    .reduce((sum, item) => sum + item.lineTotal, 0);
  const lastTaxableIdx = order.orderItems.reduce(
    (lastIdx, item, idx) => (item.taxable !== false ? idx : lastIdx), -1
  );

  let allocatedDiscount = 0;
  let allocatedTax = 0;

  const itemList = order.orderItems.map((item, idx) => {
    const isLast = idx === order.orderItems.length - 1;
    const isTaxable = item.taxable !== false;
    const share = subtotal > 0 ? item.lineTotal / subtotal : 0;

    const itemDiscount = isLast
      ? Math.round((couponDiscount - allocatedDiscount) * 100) / 100
      : Math.round(couponDiscount * share * 100) / 100;
    allocatedDiscount += itemDiscount;

    const taxblAmt = Math.max(0, Math.round((item.lineTotal - itemDiscount) * 100) / 100);

    const taxShare = taxableItemsTotal > 0 ? item.lineTotal / taxableItemsTotal : 0;
    const itemTax = vatEnabled && vatRate > 0 && isTaxable
      ? (idx === lastTaxableIdx ? Math.round((vatAmount - allocatedTax) * 100) / 100 : Math.round(vatAmount * taxShare * 100) / 100)
      : 0;
    allocatedTax += itemTax;

    const dcRt = item.lineTotal > 0 ? Math.round((itemDiscount / item.lineTotal) * 10000) / 100 : 0;

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
      dcRt,
      dcAmt:     itemDiscount,
      taxblAmt,
      taxTyCd:   vatEnabled && vatRate > 0 && isTaxable ? 'B' : 'E', // B = 16% VAT, E = exempt
      taxAmt:    itemTax,
      totAmt:    Math.round((taxblAmt + itemTax) * 100) / 100,
    };
  });

  // Sum taxable/exempt lines from the items just built, before the delivery-fee
  // line (always exempt) is appended — keeps taxblAmtB/E self-reconciling with itemList.
  let taxblAmtB = 0;
  let taxblAmtE = 0;
  order.orderItems.forEach((item, idx) => {
    const isTaxed = vatEnabled && vatRate > 0 && item.taxable !== false;
    if (isTaxed) taxblAmtB += itemList[idx].taxblAmt;
    else taxblAmtE += itemList[idx].taxblAmt;
  });

  // Delivery fee sits outside the VAT base in order.service.js's own total formula
  // (total = subtotal + deliveryFee + vatAmount - couponDiscount), so it's never
  // taxed — represented as its own exempt line rather than folded into taxed items.
  if (deliveryFee > 0) {
    itemList.push({
      itemSeq:   itemList.length + 1,
      itemCd:    'DELIVERY-FEE',
      itemClsCd: ITEM_CLASS_CODE,
      itemNm:    'Delivery Fee',
      bcd:       '',
      pkgUnt:    'U',
      qty:       1,
      prc:       deliveryFee,
      splyAmt:   deliveryFee,
      dcRt:      0,
      dcAmt:     0,
      taxblAmt:  deliveryFee,
      taxTyCd:   'E',
      taxAmt:    0,
      totAmt:    deliveryFee,
    });
    taxblAmtE += deliveryFee;
  }

  taxblAmtB = Math.round(taxblAmtB * 100) / 100;
  taxblAmtE = Math.round(taxblAmtE * 100) / 100;

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
    taxblAmtB,
    taxblAmtC: 0,
    taxblAmtD: 0,
    taxblAmtE,
    taxRtA: 0,  taxRtB: vatRate, taxRtC: 0, taxRtD: 0, taxRtE: 0,
    taxAmtA: 0, taxAmtB: vatAmount, taxAmtC: 0, taxAmtD: 0, taxAmtE: 0,
    totTaxblAmt: Math.round((taxblAmtB + taxblAmtE) * 100) / 100,
    totTaxAmt:   vatAmount,
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
    .select('orderRef orderItems subtotal deliveryFee couponDiscount vatEnabled vatRate vatAmount total paymentMethod specialInstructions createdAt etimsStatus etimsInvoiceNumber status paymentStatus buyerKraPin')
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
