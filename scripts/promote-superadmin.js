#!/usr/bin/env node
/**
 * Break-glass superadmin recovery.
 *
 * There is deliberately no API route for this: promoting an account to
 * superadmin is done only by an existing superadmin via
 * PATCH /api/admin/users/:id/role. That leaves a real operational gap — if the
 * sole superadmin is locked out (lost credentials, locked account, or a bad
 * changeRole that left nobody holding the role), there is no sanctioned way
 * back in and recovery means editing MongoDB by hand. This script is that way
 * back in, for whoever has shell access to the server or the connection string.
 *
 * READ-ONLY unless --confirm is passed. Never prints secrets.
 *
 * Usage
 *   node scripts/promote-superadmin.js --list
 *   node scripts/promote-superadmin.js --phone 0712345678 --unlock
 *   node scripts/promote-superadmin.js --phone 0712345678 --promote --confirm
 *   node scripts/promote-superadmin.js --email owner@example.com --promote --unlock --confirm
 *
 * Flags
 *   --list              Show every superadmin, plus locked staff accounts.
 *   --phone <number>    Target account by phone (07…, +254…, 254… all match).
 *   --email <address>   Target account by email (case-insensitive).
 *   --promote           Set the target's role to superadmin.
 *   --unlock            Clear isLocked and failedLoginCount.
 *   --reason "<text>"   Recorded in the activity log. Strongly recommended.
 *   --confirm           Actually write. Without it this is a dry run.
 *
 * Every write bumps tokenValidAfter so access tokens already issued under the
 * old role stop working immediately (see auth.middleware.js).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const os = require('os');
const mongoose = require('mongoose');
const User = require('../src/models/User');
const ActivityLog = require('../src/models/ActivityLog');
const { ROLES, LOG_ACTIONS } = require('../src/utils/constants');
const { bumpTokenValidAfter } = require('../src/utils/tokenValidAfter');
const { phoneVariants } = require('../src/utils/mpesaHelpers');

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const get = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const USAGE = `
Break-glass superadmin recovery — see the header of this file.

  node scripts/promote-superadmin.js --list
  node scripts/promote-superadmin.js --phone 0712345678 --promote --confirm
  node scripts/promote-superadmin.js --email owner@example.com --unlock --confirm

Flags: --list | --phone <n> | --email <e> | --promote | --unlock
       --reason "<text>" | --confirm
`;

const listAccounts = async () => {
  const superadmins = await User.find({ role: ROLES.SUPERADMIN })
    .select('name phone email role isLocked lastLoginAt')
    .lean();

  console.log(`\nSuperadmins (${superadmins.length}):`);
  if (superadmins.length === 0) {
    console.log('  NONE — this system currently has no superadmin. Recover with:');
    console.log('  --phone <number> --promote --confirm\n');
  }
  superadmins.forEach((u) => {
    console.log(`  - ${u.name}  ${u.phone}${u.email ? `  ${u.email}` : ''}`);
    console.log(`      id=${u._id}  locked=${u.isLocked === true}  lastLogin=${u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : 'never'}`);
  });

  // Locked staff accounts are the other common lockout cause.
  const locked = await User.find({
    isLocked: true,
    role: { $in: [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.ADMIN] },
  }).select('name phone role').lean();

  if (locked.length > 0) {
    console.log(`\nLocked staff accounts (${locked.length}):`);
    locked.forEach((u) => console.log(`  - ${u.name}  ${u.phone}  role=${u.role}  id=${u._id}`));
  }
  console.log('');
};

const findTarget = async () => {
  const phone = get('phone')
  const email = get('email')
  if (!phone && !email) return null

  if (phone) {
    // User.phone is stored in whichever form it was submitted in across the
    // app's history — phoneVariants() returns every stored form so the lookup
    // works regardless of when the account was created.
    return User.findOne({ phone: { $in: phoneVariants(phone) } })
  }
  return User.findOne({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
}

const main = async () => {
  if (has('help') || argv.length === 0) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set — check backend/.env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.name} (${mongoose.connection.host})`);

  // --list is read-only and safe to run at any time.
  if (has('list')) {
    await listAccounts();
    await mongoose.connection.close();
    return;
  }

  const target = await findTarget();
  if (!target) {
    console.error('\nNo matching account. Pass --phone <number> or --email <address>.');
    console.error('Run with --list to see the current superadmins.\n');
    await mongoose.connection.close();
    process.exit(1);
  }

  const promote = has('promote');
  const unlock = has('unlock');
  if (!promote && !unlock) {
    console.error('\nNothing to do — pass --promote and/or --unlock (or --list).\n');
    await mongoose.connection.close();
    process.exit(1);
  }

  console.log(`\nTarget: ${target.name}  ${target.phone}  role=${target.role}  locked=${target.isLocked === true}`);

  const updates = {};
  if (promote && target.role !== ROLES.SUPERADMIN) updates.role = ROLES.SUPERADMIN;
  if (unlock) {
    updates.isLocked = false;
    updates.failedLoginCount = 0;
  }

  if (Object.keys(updates).length === 0) {
    console.log('Already in the requested state — no change needed.\n');
    await mongoose.connection.close();
    return;
  }

  console.log('Planned changes:', JSON.stringify(updates));
  if (!has('confirm')) {
    console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.\n');
    await mongoose.connection.close();
    return;
  }

  const previousRole = target.role;
  // Kill tokens already issued under the old role/permissions.
  updates.tokenValidAfter = bumpTokenValidAfter();
  Object.assign(target, updates);
  await target.save();

  // ActivityLog.actorId is `required`, so an out-of-band CLI action has no
  // natural actor. The schema does allow actorRole 'system', so we record that
  // and put the real accountability trail (operator + host + stated reason) in
  // `detail`. ADMIN_ROLE_CHANGED is reused so the existing log viewer renders
  // this correctly without touching the LOG_ACTIONS enum.
  await ActivityLog.create({
    actorId: target._id,
    actorRole: 'system',
    action: LOG_ACTIONS.ADMIN_ROLE_CHANGED,
    targetId: target._id,
    targetType: 'User',
    branchId: target.branchId || null,
    detail: {
      via: 'scripts/promote-superadmin.js (out-of-band CLI)',
      operator: os.userInfo().username,
      host: os.hostname(),
      reason: get('reason') || '(none given)',
      name: target.name,
      previousRole,
      newRole: target.role,
      unlocked: unlock || undefined,
    },
  });

  console.log(`\nDone. ${target.name} is now role=${target.role}${unlock ? ', unlocked' : ''}.`);
  console.log('Recorded in the activity log as a system action.');
  console.log('Any access token already issued to this account is now invalid.\n');

  await mongoose.connection.close();
};

main().catch(async (err) => {
  console.error('\n[fatal]', err.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
