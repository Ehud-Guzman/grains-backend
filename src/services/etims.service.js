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
const activityLogService  = require('./activityLog.service');
const { PAYMENT_METHODS, PAYMENT_STATUSES, ORDER_STATUSES, LOG_ACTIONS } = require('../utils/constants');
const { EAT_OFFSET_MS } = require('../utils/businessTime');

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const PAYMENT_TYPE_CODES = {
  [PAYMENT_METHODS.MPESA]:    '02', // Mobile Money
  [PAYMENT_METHODS.PICKUP]:   '01', // Cash
  [PAYMENT_METHODS.DELIVERY]: '01', // Cash on delivery
};

// KRA's "refund reason" code for a credit note. The list is KRA's, not ours: check the code for "cancelled / other" in the
// eTIMS code table you were given at onboarding and set ETIMS_REFUND_REASON_CODE before turning eTIMS on in production.
const REFUND_REASON_CODE = process.env.ETIMS_REFUND_REASON_CODE || '13';
const CREDIT_NOTE_LEASE_MS = 5 * 60 * 1000; // a claim older than this is a crashed attempt and may be retaken

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
  const rounding        = Number(order.roundingAdjustment) || 0;

  // Dates are on the Nairobi clock, like the VAT report's month buckets. In UTC an order placed 00:00-03:00 EAT
  // was filed under the previous day (and, on the 1st, the previous month) - 2026-10 audit, F-16.
  const inEAT = (date) => new Date(new Date(date).getTime() + EAT_OFFSET_MS).toISOString();
  const cfmDt  = inEAT(new Date()).replace(/[-:T.Z]/g, '').slice(0, 14); // YYYYMMDDHHmmss
  const salesDt = inEAT(order.createdAt).slice(0, 10).replace(/-/g, ''); // YYYYMMDD

  // Allocate couponDiscount and vatAmount across items to the cent using the
  // largest-remainder (Hamilton) method: floor each item's proportional share,
  // then hand out the leftover cents one at a time to the items with the largest
  // fractional remainder. This keeps sum(itemDiscounts) === couponDiscount and
  // sum(itemTaxes) === vatAmount exactly, while bounding any single item's
  // rounding overshoot to at most 1 cent — unlike dumping the whole remainder on
  // an arbitrary "last" item, which could push that item's discount past its own
  // lineTotal (producing a negative taxable base) or its tax far from
  // taxblAmt × rate on orders with many lines.
  const items = order.orderItems;
  const isTaxableItem = item => item.taxable !== false;

  // ── Discount allocation ──
  const discRawCents = items.map(item => (subtotal > 0 ? couponDiscount * (item.lineTotal / subtotal) * 100 : 0));
  const discFlooredCents = discRawCents.map(Math.floor);
  let discRemainderCents = Math.round(couponDiscount * 100) - discFlooredCents.reduce((a, b) => a + b, 0);
  const discOrder = items
    .map((_, idx) => idx)
    .sort((a, b) => (discRawCents[b] - discFlooredCents[b]) - (discRawCents[a] - discFlooredCents[a]));
  const itemDiscountCents = [...discFlooredCents];
  for (let i = 0; i < discRemainderCents && i < discOrder.length; i++) itemDiscountCents[discOrder[i]] += 1;
  const itemDiscounts = itemDiscountCents.map(c => c / 100);

  // Post-discount taxable base per item (defensive floor — largest-remainder keeps
  // per-item overshoot to ≤1 cent, so this should never actually clamp in practice).
  const taxblAmts = items.map((item, idx) => Math.max(0, Math.round((item.lineTotal - itemDiscounts[idx]) * 100) / 100));

  // ── Tax allocation — shared by post-discount taxable base, not gross lineTotal,
  // so it tracks the same base order.vatAmount was itself computed from. ──
  const taxableBaseTotal = items.reduce((sum, item, idx) => sum + (isTaxableItem(item) ? taxblAmts[idx] : 0), 0);
  const taxEnabled = vatEnabled && vatRate > 0;
  const taxRawCents = items.map((item, idx) =>
    (taxEnabled && isTaxableItem(item) && taxableBaseTotal > 0)
      ? vatAmount * (taxblAmts[idx] / taxableBaseTotal) * 100
      : 0
  );
  const taxFlooredCents = taxRawCents.map(Math.floor);
  let taxRemainderCents = taxEnabled ? Math.round(vatAmount * 100) - taxFlooredCents.reduce((a, b) => a + b, 0) : 0;
  const taxOrder = items
    .map((_, idx) => idx)
    .filter(idx => isTaxableItem(items[idx]))
    .sort((a, b) => (taxRawCents[b] - taxFlooredCents[b]) - (taxRawCents[a] - taxFlooredCents[a]));
  const itemTaxCents = [...taxFlooredCents];
  for (let i = 0; i < taxRemainderCents && i < taxOrder.length; i++) itemTaxCents[taxOrder[i]] += 1;
  const itemTaxes = itemTaxCents.map(c => c / 100);

  const itemList = items.map((item, idx) => {
    const isTaxable = isTaxableItem(item);
    const itemDiscount = itemDiscounts[idx];
    const taxblAmt = taxblAmts[idx];
    const itemTax = itemTaxes[idx];
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
      taxTyCd:   taxEnabled && isTaxable ? 'B' : 'E', // B = 16% VAT, E = exempt
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

  // The few cents the total was rounded up by to a whole shilling are charged to the customer, so the invoice carries
  // them as their own exempt line - without it the items would add up to less than totAmt.
  if (rounding > 0) {
    itemList.push({
      itemSeq:   itemList.length + 1,
      itemCd:    'ROUNDING',
      itemClsCd: ITEM_CLASS_CODE,
      itemNm:    'Rounding to whole shilling',
      bcd:       '',
      pkgUnt:    'U',
      qty:       1,
      prc:       rounding,
      splyAmt:   rounding,
      dcRt:      0,
      dcAmt:     0,
      taxblAmt:  rounding,
      taxTyCd:   'E',
      taxAmt:    0,
      totAmt:    rounding,
    });
    taxblAmtE += rounding;
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
    .select('orderRef orderItems subtotal deliveryFee couponDiscount vatEnabled vatRate vatAmount roundingAdjustment total paymentMethod specialInstructions createdAt etimsStatus etimsInvoiceNumber status paymentStatus buyerKraPin')
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

  // Atomic claim: the checks above are read-then-act and can race (the 30-min
  // retry job firing at the same moment as a manual admin resubmit, or a
  // double-click), which would otherwise submit the same order to KRA twice.
  // Only the invocation whose findOneAndUpdate actually matches (i.e. wins the
  // race) proceeds — a second concurrent caller's filter fails once the first
  // has already flipped etimsStatus to 'pending'.
  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      etimsStatus: { $nin: ['submitted', 'pending'] },
      $or: [{ etimsInvoiceNumber: null }, { etimsInvoiceNumber: '' }, { etimsInvoiceNumber: { $exists: false } }],
    },
    { $set: { etimsStatus: 'pending' } }
  );
  if (!claimed) {
    logger.info('[eTIMS] Skipping — already claimed/submitted by a concurrent invocation', { orderId, orderRef: order.orderRef });
    return;
  }

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

// ── SUBMIT A CREDIT NOTE ──────────────────────────────────────────────────────
// An invoice KRA already holds for an order that was then cancelled or rejected is reversed by a credit note: the same
// saveTrnsSaleOsdc call with receipt type 'R' (refund), pointing back at the original invoice. Mirrors submitInvoice:
// skips quietly when eTIMS is off, claims the order so two callers can't file it twice, and on failure leaves the order
// in the "credit notes to file" list (status stays 'required', the error is kept for the screen) for the retry job or an
// admin. On success the order is marked 'issued' with KRA's reference. Returns { filed, reason?, reference? }.
// NOT yet exercised against KRA's sandbox (eTIMS is still on development): the field names follow the invoice call and
// KRA's refund convention, and the reason code is configurable - confirm both with a sandbox credit note before going live.
const submitCreditNote = async (orderId) => {
  const global = await globalSettingsService.getSettings();
  const { enabled, baseUrl, tin, bhfId = '00', deviceId } = global.etims || {};
  if (!enabled || !baseUrl || !tin || !deviceId) return { filed: false, reason: 'disabled' };

  const order = await Order.findById(orderId)
    .select('orderRef branchId orderItems subtotal deliveryFee couponDiscount vatEnabled vatRate vatAmount roundingAdjustment total paymentMethod specialInstructions createdAt etimsInvoiceNumber etimsCreditNoteStatus buyerKraPin')
    .lean();
  if (!order) return { filed: false, reason: 'not_found' };
  if (order.etimsCreditNoteStatus !== 'required' || !order.etimsInvoiceNumber) return { filed: false, reason: 'not_required' };

  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      etimsCreditNoteStatus: 'required',
      $or: [{ etimsCreditNoteClaimedAt: null }, { etimsCreditNoteClaimedAt: { $lt: new Date(Date.now() - CREDIT_NOTE_LEASE_MS) } }],
    },
    { $set: { etimsCreditNoteClaimedAt: new Date() } }
  );
  if (!claimed) return { filed: false, reason: 'in_progress' };

  try {
    const original = Number(order.etimsInvoiceNumber);
    const base = buildPayload(order, tin, bhfId);
    const payload = {
      ...base,
      rcptTyCd:  'R',                                  // R = refund (credit note)
      orgInvcNo: Number.isFinite(original) ? original : 0,
      rfdRsnCd:  REFUND_REASON_CODE,
      rfdDt:     base.cfmDt,
      remark:    `Credit note for ${order.orderRef}`,
    };
    const response = await axios.post(`${baseUrl}/saveTrnsSaleOsdc`, payload, {
      headers: { 'Content-Type': 'application/json', tin, bhfId, dvcSrNo: deviceId },
      timeout: 15_000,
    });
    const resultCd = response.data?.resultCd;
    if (resultCd !== '000') throw new Error(`eTIMS error: ${response.data?.resultMsg} (code ${resultCd})`);

    const { rcptNo, tradeIvtNo } = response.data.data || {};
    const reference = String(tradeIvtNo ?? rcptNo ?? 'ACCEPTED').toUpperCase();
    await Order.updateOne(
      { _id: orderId, etimsCreditNoteStatus: 'required' },
      { $set: { etimsCreditNoteStatus: 'issued', etimsCreditNoteRef: reference, etimsCreditNoteAt: new Date(), etimsCreditNoteError: null, etimsCreditNoteClaimedAt: null } }
    );
    await activityLogService.log({
      actorId:    order._id,
      actorRole:  'system',
      action:     LOG_ACTIONS.ETIMS_CREDIT_NOTE_ISSUED,
      branchId:   order.branchId,
      targetId:   order._id,
      targetType: 'Order',
      detail:     { orderRef: order.orderRef, creditNoteRef: reference, mode: 'automatic' },
    }).catch(err => logger.error('[eTIMS] Activity log failed on credit note', { err: err.message }));
    logger.info('[eTIMS] Credit note submitted', { orderId, orderRef: order.orderRef, reference });
    return { filed: true, reference };
  } catch (err) {
    await Order.updateOne(
      { _id: orderId },
      { $set: { etimsCreditNoteClaimedAt: null, etimsCreditNoteError: String(err.message).slice(0, 300) } }
    );
    logger.error('[eTIMS] Credit note submission failed', { orderId, orderRef: order.orderRef, err: err.message });
    throw err;
  }
};

module.exports = { submitInvoice, submitCreditNote, buildPayload };
