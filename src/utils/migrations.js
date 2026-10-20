// One-off data migrations that run at startup and are remembered (GlobalSettings.migrations.<name>), so each
// runs once per database. They must be idempotent: a crash half-way simply re-runs from the start next boot.
const mongoose = require('mongoose');
const logger = require('./logger');

const MIGRATIONS = [
  {
    name: 'user-ordered-branch-ids-v1',
    // Fill User.orderedBranchIds from existing orders (new orders maintain it themselves).
    run: async () => {
      const Order = require('../models/Order');
      const User = require('../models/User');
      const rows = await Order.aggregate([
        { $match: { userId: { $ne: null }, branchId: { $ne: null } } },
        { $group: { _id: '$userId', branches: { $addToSet: '$branchId' } } },
      ]).allowDiskUse(true);
      let batch = [];
      const flush = async () => {
        if (batch.length) await User.bulkWrite(batch, { ordered: false });
        batch = [];
      };
      for (const row of rows) {
        batch.push({ updateOne: { filter: { _id: row._id }, update: { $addToSet: { orderedBranchIds: { $each: row.branches } } } } });
        if (batch.length >= 500) await flush();
      }
      await flush();
      return rows.length;
    },
  },
  {
    name: 'payment-branch-id-v1',
    // Fill Payment.branchId from the order each payment belongs to (new payments get it on save).
    run: async () => {
      const Payment = require('../models/Payment');
      const Order = require('../models/Order');
      let fixed = 0;
      for (;;) {
        const batch = await Payment.collection.find({ branchId: { $in: [null, undefined] } }, { projection: { orderId: 1 } }).limit(1000).toArray();
        if (!batch.length) break;
        const orders = await Order.find({ _id: { $in: batch.map(p => p.orderId) } }).select('branchId').lean();
        const branchOf = new Map(orders.map(o => [String(o._id), o.branchId]));
        const ops = batch.map(p => ({
          updateOne: { filter: { _id: p._id }, update: { $set: { branchId: branchOf.get(String(p.orderId)) || false } } },
        }));
        await Payment.collection.bulkWrite(ops, { ordered: false });
        fixed += batch.length;
        if (batch.length < 1000) break;
      }
      // Payments whose order is gone were marked `false` above only to stop re-selecting them; store null.
      await Payment.collection.updateMany({ branchId: false }, { $set: { branchId: null } });
      return fixed;
    },
  },
  {
    name: 'drop-redundant-indexes-v1',
    // Indexes that are strict prefixes of another index only cost write speed and memory (2026-10 audit,
    // F-22). Dropping is safe: the longer index answers the same queries. Missing indexes are ignored.
    run: async () => {
      const targets = [
        ['orders', { branchId: 1 }], ['orders', { branchId: 1, status: 1 }],
        ['payments', { status: 1 }],
        ['products', { branchId: 1 }], ['products', { branchId: 1, isActive: 1 }],
        ['users', { branchId: 1 }],
        ['activitylogs', { action: 1 }],
      ];
      let dropped = 0;
      for (const [collection, key] of targets) {
        try {
          await mongoose.connection.collection(collection).dropIndex(key);
          dropped += 1;
        } catch { /* not there (already gone, or never created) */ }
      }
      return dropped;
    },
  },
];

const runMigrations = async () => {
  const col = mongoose.connection.collection('globalsettings');
  const doc = await col.findOne({ _id: 'global' });
  const done = doc?.migrations || {};
  for (const m of MIGRATIONS) {
    if (done[m.name]) continue;
    try {
      const count = await m.run();
      await col.updateOne({ _id: 'global' }, { $set: { [`migrations.${m.name}`]: new Date() } }, { upsert: true });
      logger.info(`[migrations] ${m.name} done`, { affected: count });
    } catch (err) {
      logger.error(`[migrations] ${m.name} FAILED - will retry on next start`, { err: err.message });
    }
  }
};

module.exports = { runMigrations, MIGRATIONS };
