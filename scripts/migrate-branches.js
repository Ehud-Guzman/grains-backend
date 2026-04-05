/**
 * migrate-branches.js
 *
 * Run once to bootstrap multi-tenancy:
 *  1. Creates your first branch
 *  2. Assigns all existing staff/supervisor/admin users to it
 *  3. Stamps branchId on all existing Products, Orders, StockLogs, ActivityLogs
 *  4. Creates a default Settings document for the branch
 *
 * Usage:
 *   cd backend
 *   node scripts/migrate-branches.js
 *
 * Override defaults with env vars before running:
 *   BRANCH_NAME="Vittorios Main Branch" BRANCH_SLUG="main" BRANCH_LOCATION="Bungoma, Kenya" node scripts/migrate-branches.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

// ── MODELS ────────────────────────────────────────────────────────────────────
const Branch      = require('../src/models/Branch');
const User        = require('../src/models/User');
const Product     = require('../src/models/Product');
const Order       = require('../src/models/Order');
const StockLog    = require('../src/models/StockLog');
const ActivityLog = require('../src/models/ActivityLog');
const Settings    = require('../src/models/Settings');
const OrderCounter = require('../src/models/OrderCounter');

const BRANCH_NAME     = process.env.BRANCH_NAME     || 'Main Branch';
const BRANCH_SLUG     = process.env.BRANCH_SLUG     || 'main';
const BRANCH_LOCATION = process.env.BRANCH_LOCATION || 'Bungoma, Kenya';
const BRANCH_PHONE    = process.env.BRANCH_PHONE    || '';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  // ── 1. Create the branch (skip if already exists) ─────────────────────────
  let branch = await Branch.findOne({ slug: BRANCH_SLUG });
  if (branch) {
    console.log(`ℹ️  Branch "${branch.name}" (${branch.slug}) already exists — skipping creation`);
  } else {
    branch = await Branch.create({
      name: BRANCH_NAME,
      slug: BRANCH_SLUG,
      location: BRANCH_LOCATION,
      phone: BRANCH_PHONE,
      isActive: true,
      isDefault: true
    });
    console.log(`✅ Created branch: "${branch.name}" (id: ${branch._id})`);
  }

  const branchId = branch._id;

  // ── 2. Assign all staff/supervisor/admin to this branch ────────────────────
  const staffRoles = ['staff', 'supervisor', 'admin'];
  const staffWithoutBranch = await User.find({ role: { $in: staffRoles }, branchId: null });
  if (staffWithoutBranch.length) {
    await User.updateMany(
      { role: { $in: staffRoles }, branchId: null },
      { $set: { branchId } }
    );
    console.log(`✅ Assigned ${staffWithoutBranch.length} staff/admin users to "${branch.name}"`);
    staffWithoutBranch.forEach(u => console.log(`   → ${u.name} (${u.role})`));
  } else {
    console.log('ℹ️  No unassigned staff/admin users found');
  }

  // ── 3. Stamp branchId on Products ─────────────────────────────────────────
  const productsToUpdate = await Product.countDocuments({ branchId: null });
  if (productsToUpdate) {
    await Product.updateMany({ branchId: null }, { $set: { branchId } });
    console.log(`✅ Stamped branchId on ${productsToUpdate} products`);
  } else {
    console.log('ℹ️  All products already have a branchId');
  }

  // ── 4. Stamp branchId on Orders ───────────────────────────────────────────
  const ordersToUpdate = await Order.countDocuments({ branchId: null });
  if (ordersToUpdate) {
    await Order.updateMany({ branchId: null }, { $set: { branchId } });
    console.log(`✅ Stamped branchId on ${ordersToUpdate} orders`);
  } else {
    console.log('ℹ️  All orders already have a branchId');
  }

  // ── 5. Stamp branchId on StockLogs ────────────────────────────────────────
  const stockLogsToUpdate = await StockLog.countDocuments({ branchId: null });
  if (stockLogsToUpdate) {
    await StockLog.updateMany({ branchId: null }, { $set: { branchId } });
    console.log(`✅ Stamped branchId on ${stockLogsToUpdate} stock logs`);
  } else {
    console.log('ℹ️  All stock logs already have a branchId');
  }

  // ── 6. Stamp branchId on ActivityLogs ────────────────────────────────────
  const activityLogsToUpdate = await ActivityLog.countDocuments({ branchId: null });
  if (activityLogsToUpdate) {
    await ActivityLog.updateMany({ branchId: null }, { $set: { branchId } });
    console.log(`✅ Stamped branchId on ${activityLogsToUpdate} activity logs`);
  } else {
    console.log('ℹ️  All activity logs already have a branchId');
  }

  // ── 7. Migrate old OrderCounter → new per-branch format ───────────────────
  const oldCounter = await OrderCounter.findById('order_counter');
  if (oldCounter) {
    const newCounterId = `counter_${branchId}_${oldCounter.year}`;
    const exists = await OrderCounter.findById(newCounterId);
    if (!exists) {
      await OrderCounter.create({
        _id: newCounterId,
        branchId,
        year: oldCounter.year,
        seq: oldCounter.seq
      });
      console.log(`✅ Migrated order counter (seq: ${oldCounter.seq}) to branch format`);
    }
    await OrderCounter.findByIdAndDelete('order_counter');
    console.log('✅ Removed old order_counter document');
  } else {
    console.log('ℹ️  No legacy order counter to migrate');
  }

  // ── 8. Create default Settings for this branch ────────────────────────────
  const settingsId = `settings_${branchId}`;
  const existingSettings = await Settings.findById(settingsId);
  if (!existingSettings) {
    // Copy from old singleton if it exists
    const oldSettings = await Settings.findById('app_settings');
    if (oldSettings) {
      const { _id, ...rest } = oldSettings.toObject();
      await Settings.create({ _id: settingsId, branchId, ...rest });
      console.log('✅ Migrated existing settings to branch settings');
      await Settings.findByIdAndDelete('app_settings');
      console.log('✅ Removed old singleton settings document');
    } else {
      await Settings.create({ _id: settingsId, branchId });
      console.log('✅ Created default settings for branch');
    }
  } else {
    console.log('ℹ️  Branch settings already exist');
  }

  console.log('\n🎉 Migration complete!');
  console.log(`\nBranch ID: ${branchId}`);
  console.log('You can now log in as superadmin — it will auto-enter without branch selection (since there\'s only one branch, or you\'ll see the branch picker).');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('❌ Migration failed:', err.message);
  console.error(err);
  process.exit(1);
});
