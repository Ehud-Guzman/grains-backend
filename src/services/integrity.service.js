// ── INTEGRITY SCAN ────────────────────────────────────────────────────────────
// Read-only checks for the kinds of inconsistency this system can actually develop:
// stock reservations that outlived their order, payments that disagree with orders,
// accounts and branches that are half-configured.
//
// It never changes anything. A finding says what is wrong and where to look; putting it
// right is done on the normal screens, where the usual rules and audit entries apply.
// Each check runs independently, so one failing check can't hide the others.

const Branch = require('../models/Branch');
const User = require('../models/User');
const Order = require('../models/Order');
const Payment = require('../models/Payment');
const Product = require('../models/Product');
const Settings = require('../models/Settings');
const Coupon = require('../models/Coupon');
const { ROLES } = require('../utils/constants');

const EXAMPLES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

const orderExample = (o) => ({
  id: String(o._id),
  label: o.orderRef,
  detail: `${o.status} · ${o.paymentStatus || 'unpaid'} · KES ${Math.round(o.total || 0).toLocaleString('en-KE')}`,
  link: `/admin/orders/${o._id}`,
});

// Each check: { id, title, severity, hint, run() -> { count, examples } }
const CHECKS = [
  {
    id: 'leaked-reservation',
    title: 'Stock still held for cancelled or rejected orders',
    severity: 'high',
    hint: 'These orders are over but their reserved stock was never returned, so the shelf may show less than is really there. Count the shelf and correct the level with a stock adjustment.',
    run: async () => {
      const filter = { status: { $in: ['cancelled', 'rejected'] }, stockReservationStatus: 'held' };
      const [count, rows] = await Promise.all([
        Order.countDocuments(filter),
        Order.find(filter).sort({ createdAt: -1 }).limit(EXAMPLES).select('orderRef status paymentStatus total').lean(),
      ]);
      return { count, examples: rows.map(orderExample) };
    },
  },
  {
    id: 'reservation-mismatch',
    title: 'Approved orders whose stock was returned or never marked used',
    severity: 'medium',
    hint: 'An order that moved past approval should have its stock marked as used. "Released" here means the stock went back on the shelf while the order carried on, so it may be oversold.',
    run: async () => {
      const filter = {
        status: { $in: ['approved', 'preparing', 'out_for_delivery', 'completed'] },
        stockReservationStatus: { $in: ['held', 'released'] },
      };
      const [count, rows] = await Promise.all([
        Order.countDocuments(filter),
        Order.find(filter).sort({ createdAt: -1 }).limit(EXAMPLES).select('orderRef status paymentStatus total stockReservationStatus').lean(),
      ]);
      return { count, examples: rows.map(o => ({ ...orderExample(o), detail: `${o.status} · stock ${o.stockReservationStatus}` })) };
    },
  },
  {
    id: 'paid-without-payment',
    title: 'Orders marked paid with no successful payment record',
    severity: 'high',
    hint: 'The order says it was paid but there is no payment behind it. Check the M-Pesa statement before releasing goods. (Looks at the last 30 days.)',
    run: async () => {
      // Last 30 days only: older history is settled and the $lookup is the expensive part (a year of paid
      // orders took ~3 s; a month is well under half a second).
      const since = new Date(Date.now() - 30 * DAY_MS);
      const rows = await Order.aggregate([
        { $match: { paymentStatus: 'paid', createdAt: { $gte: since } } },
        // localField/foreignField form: MongoDB walks the payments.orderId index for each order instead of
        // evaluating an $expr per candidate (3.4 s -> well under a second at 40k orders).
        { $lookup: { from: 'payments', localField: '_id', foreignField: 'orderId', pipeline: [
          { $match: { status: 'paid' } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ], as: 'paid' } },
        { $match: { paid: { $size: 0 } } },
        { $sort: { createdAt: -1 } },
        { $project: { orderRef: 1, status: 1, paymentStatus: 1, total: 1 } },
      ]);
      return { count: rows.length, examples: rows.slice(0, EXAMPLES).map(orderExample) };
    },
  },
  {
    id: 'late-mpesa-success',
    title: 'M-Pesa money that arrived after the payment had already failed',
    severity: 'high',
    hint: 'Safaricom confirmed a payment the system had given up on. The customer paid; reconcile it against their order (or refund them).',
    run: async () => {
      // receivedAt is always set with lateSuccessMeta; asking for it lets the partial index answer (a `$ne: null`
      // test on the whole object scanned every payment).
      const filter = { 'lateSuccessMeta.receivedAt': { $exists: true } };
      const [count, rows] = await Promise.all([
        Payment.countDocuments(filter),
        Payment.find(filter).sort({ updatedAt: -1 }).limit(EXAMPLES).populate('orderId', 'orderRef').lean(),
      ]);
      return {
        count,
        examples: rows.map(p => ({
          id: String(p._id),
          label: p.orderId?.orderRef || 'Unknown order',
          detail: `KES ${Math.round(p.amount || 0).toLocaleString('en-KE')} · ${p.mpesaPhone || 'no phone'}`,
          link: p.orderId?._id ? `/admin/orders/${p.orderId._id}` : null,
        })),
      };
    },
  },
  {
    id: 'stuck-payment',
    title: 'M-Pesa payments pending for over an hour',
    severity: 'medium',
    hint: 'The customer was prompted but nothing came back. Either they walked away or the callback was lost — check the M-Pesa statement.',
    run: async () => {
      const filter = { status: 'pending', method: 'mpesa', createdAt: { $lt: new Date(Date.now() - 60 * 60 * 1000), $gte: new Date(Date.now() - 30 * DAY_MS) } };
      const [count, rows] = await Promise.all([
        Payment.countDocuments(filter),
        Payment.find(filter).sort({ createdAt: -1 }).limit(EXAMPLES).populate('orderId', 'orderRef').lean(),
      ]);
      return {
        count,
        examples: rows.map(p => ({
          id: String(p._id),
          label: p.orderId?.orderRef || 'Unknown order',
          detail: `KES ${Math.round(p.amount || 0).toLocaleString('en-KE')} · since ${new Date(p.createdAt).toLocaleString('en-KE')}`,
          link: p.orderId?._id ? `/admin/orders/${p.orderId._id}` : null,
        })),
      };
    },
  },
  {
    id: 'closed-order-paid',
    title: 'Cancelled or rejected orders still marked as paid',
    severity: 'high',
    hint: 'Money was taken for an order that is now closed, and nothing flags a refund. Return the customer\'s money and mark the payment refunded (this is exactly what a payment arriving during a cancellation used to leave behind).',
    run: async () => {
      const filter = { status: { $in: ['cancelled', 'rejected'] }, paymentStatus: 'paid' };
      const [count, rows] = await Promise.all([
        Order.countDocuments(filter),
        Order.find(filter).sort({ createdAt: -1 }).limit(EXAMPLES).select('orderRef status paymentStatus total').lean(),
      ]);
      return { count, examples: rows.map(orderExample) };
    },
  },
  {
    id: 'paid-payment-unpaid-order',
    title: 'Successful payments whose order does not show as paid',
    severity: 'high',
    hint: 'A payment was recorded as paid but its order says otherwise, so approval or completion may be blocked. Check the order and confirm the payment on it. (Looks at the last 30 days.)',
    run: async () => {
      const since = new Date(Date.now() - 30 * DAY_MS);
      const rows = await Payment.aggregate([
        { $match: { status: 'paid', createdAt: { $gte: since } } },
        { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'order' } },
        { $unwind: '$order' },
        { $match: { 'order.paymentStatus': { $nin: ['paid', 'refunded'] } } },
        { $sort: { createdAt: -1 } },
        { $project: { amount: 1, orderRef: '$order.orderRef', orderId: '$order._id', orderPayment: '$order.paymentStatus' } },
      ]);
      return {
        count: rows.length,
        examples: rows.slice(0, EXAMPLES).map(r => ({
          id: String(r._id), label: r.orderRef, detail: `payment paid, order ${r.orderPayment} · KES ${Math.round(r.amount || 0).toLocaleString('en-KE')}`, link: `/admin/orders/${r.orderId}`,
        })),
      };
    },
  },
  {
    id: 'payment-amount-mismatch',
    title: 'M-Pesa payments whose amount differs from the order total',
    severity: 'medium',
    hint: 'The amount requested from the customer should be the order total rounded up to a whole shilling. A difference means the order was changed after payment was requested. (Looks at the last 30 days.)',
    run: async () => {
      const since = new Date(Date.now() - 30 * DAY_MS);
      const rows = await Payment.aggregate([
        { $match: { method: 'mpesa', status: { $in: ['paid', 'pending'] }, createdAt: { $gte: since } } },
        { $lookup: { from: 'orders', localField: 'orderId', foreignField: '_id', as: 'order' } },
        { $unwind: '$order' },
        { $match: { $expr: { $ne: ['$amount', { $ceil: '$order.total' }] } } },
        { $sort: { createdAt: -1 } },
        { $project: { amount: 1, orderRef: '$order.orderRef', orderId: '$order._id', total: '$order.total' } },
      ]);
      return {
        count: rows.length,
        examples: rows.slice(0, EXAMPLES).map(r => ({
          id: String(r._id), label: r.orderRef, detail: `payment KES ${r.amount} vs order KES ${r.total}`, link: `/admin/orders/${r.orderId}`,
        })),
      };
    },
  },
  {
    id: 'coupon-usage-drift',
    title: 'Coupons whose "times used" does not match the orders that used them',
    severity: 'medium',
    hint: 'usedCount should equal the number of orders that hold the coupon (cancelled and rejected ones give it back). A mismatch can stop a coupon early or let it run past its limit.',
    run: async () => {
      const held = await Order.aggregate([
        // `$type: 'string'` (not `$ne: null`) so the partial couponCode index answers this instead of a full scan.
        { $match: { couponCode: { $type: 'string' }, status: { $nin: ['cancelled', 'rejected'] } } },
        { $group: { _id: { branchId: '$branchId', code: '$couponCode' }, n: { $sum: 1 } } },
      ]);
      const heldBy = new Map(held.map(h => [`${h._id.branchId}:${h._id.code}`, h.n]));
      const coupons = await Coupon.find().select('code branchId usedCount').lean();
      const drift = coupons
        .map(c => ({ c, actual: heldBy.get(`${c.branchId}:${c.code}`) || 0 }))
        .filter(({ c, actual }) => (c.usedCount || 0) !== actual);
      return {
        count: drift.length,
        examples: drift.slice(0, EXAMPLES).map(({ c, actual }) => ({
          id: String(c._id), label: c.code, detail: `recorded ${c.usedCount || 0} uses, ${actual} orders hold it`, link: '/admin/coupons',
        })),
      };
    },
  },
  {
    id: 'etims-pending-stuck',
    title: 'eTIMS invoices stuck "pending" for over an hour',
    severity: 'medium',
    hint: 'An invoice is claimed as pending just before it is sent to KRA. If it stays pending the process probably stopped half-way; check whether KRA has it, then resubmit from the order.',
    run: async () => {
      const filter = { etimsStatus: 'pending', updatedAt: { $lt: new Date(Date.now() - 60 * 60 * 1000), $gte: new Date(Date.now() - 30 * DAY_MS) } };
      const [count, rows] = await Promise.all([
        Order.countDocuments(filter),
        Order.find(filter).sort({ updatedAt: -1 }).limit(EXAMPLES).select('orderRef status paymentStatus total').lean(),
      ]);
      return { count, examples: rows.map(orderExample) };
    },
  },
  {
    id: 'negative-stock',
    title: 'Products with negative stock',
    severity: 'high',
    hint: 'Stock should never go below zero. Count the shelf and correct it with a stock adjustment.',
    run: async () => {
      const rows = await Product.aggregate([
        { $unwind: '$varieties' },
        { $unwind: '$varieties.packaging' },
        { $match: { 'varieties.packaging.stock': { $lt: 0 } } },
        { $project: { name: 1, variety: '$varieties.varietyName', size: '$varieties.packaging.size', stock: '$varieties.packaging.stock' } },
        { $limit: 200 },
      ]);
      return {
        count: rows.length,
        examples: rows.slice(0, EXAMPLES).map(r => ({
          id: String(r._id), label: r.name, detail: `${r.variety} · ${r.size} · stock ${r.stock}`, link: `/admin/products/${r._id}/edit`,
        })),
      };
    },
  },
  {
    id: 'staff-branch',
    title: 'Staff accounts pointing at no branch, or a branch that is gone',
    severity: 'medium',
    hint: 'Such an account signs in but can do no branch work. Assign it to a branch in User Management.',
    run: async () => {
      const branchIds = (await Branch.find().select('_id').lean()).map(b => b._id);
      const filter = {
        role: { $in: [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.DRIVER] },
        $or: [{ branchId: null }, { branchId: { $nin: branchIds } }],
      };
      const [count, rows] = await Promise.all([
        User.countDocuments(filter),
        User.find(filter).limit(EXAMPLES).select('name role branchId phone').lean(),
      ]);
      return {
        count,
        examples: rows.map(u => ({ id: String(u._id), label: u.name, detail: `${u.role} · ${u.branchId ? 'branch missing' : 'no branch'}`, link: '/admin/users' })),
      };
    },
  },
  {
    id: 'branch-setup',
    title: 'Branch set-up problems',
    severity: 'high',
    hint: 'The shop needs exactly one active default branch, and every active branch needs settings.',
    run: async () => {
      const branches = await Branch.find().lean();
      const active = branches.filter(b => b.isActive);
      const defaults = active.filter(b => b.isDefault);
      const settingsIds = new Set((await Settings.find().select('_id').lean()).map(s => s._id));
      const examples = [];
      if (active.length && defaults.length === 0) examples.push({ id: 'no-default', label: 'No default branch', detail: 'The storefront falls back to the first active branch.', link: '/admin/branches' });
      if (defaults.length > 1) examples.push({ id: 'many-defaults', label: 'More than one default branch', detail: defaults.map(b => b.name).join(', '), link: '/admin/branches' });
      for (const b of active) {
        if (!settingsIds.has(`settings_${b._id}`)) examples.push({ id: String(b._id), label: b.name, detail: 'No settings document yet (created on first use)', link: '/admin/branches' });
      }
      return { count: examples.length, examples };
    },
  },
  {
    id: 'etims-stuck',
    title: 'eTIMS invoices that KRA has not accepted for over a week',
    severity: 'medium',
    hint: 'The automatic retry stops after 7 days. These need the manual resubmit on the order, or a look at the credentials.',
    run: async () => {
      const filter = { etimsStatus: 'failed', updatedAt: { $lt: new Date(Date.now() - 7 * DAY_MS) } };
      const [count, rows] = await Promise.all([
        Order.countDocuments(filter),
        Order.find(filter).sort({ updatedAt: -1 }).limit(EXAMPLES).select('orderRef status paymentStatus total').lean(),
      ]);
      return { count, examples: rows.map(orderExample) };
    },
  },
];

const runScan = async () => {
  const startedAt = Date.now();
  const results = await Promise.all(CHECKS.map(async (check) => {
    try {
      const { count, examples } = await check.run();
      return { id: check.id, title: check.title, severity: check.severity, hint: check.hint, ok: count === 0, count, examples };
    } catch (err) {
      return { id: check.id, title: check.title, severity: check.severity, hint: check.hint, ok: false, count: 0, examples: [], error: `Could not run: ${err.message}` };
    }
  }));
  return {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    problems: results.filter(r => !r.ok).length,
    checks: results,
  };
};

module.exports = { CHECKS, runScan };
