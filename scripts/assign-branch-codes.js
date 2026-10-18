/**
 * assign-branch-codes.js
 *
 * Order references are <BRANCH CODE>-<year>-<number> (NAI-2026-0153). Each branch gets its code
 * automatically from its slug the first time it takes an order, and new branches get one when they
 * are created - so running this is OPTIONAL. It just gives the branches that already exist their code
 * now, so you can see (and check) them before the first order instead of after.
 *
 * Safe to run any number of times: a branch that already has a code keeps it, and a code is never
 * changed once assigned (references already issued carry it).
 *
 * Usage:
 *   cd backend
 *   node scripts/assign-branch-codes.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Branch = require('../src/models/Branch');
const { getBranchCode } = require('../src/utils/branchCode');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  // Build the unique index on Branch.code first, so two branches can never be given the same code.
  await Branch.init();

  const branches = await Branch.find({}).sort({ createdAt: 1 }).select('name slug code').lean();
  if (branches.length === 0) console.log('No branches found.');

  for (const branch of branches) {
    const had = branch.code;
    const code = await getBranchCode(branch._id);
    console.log(`${(branch.name || '').padEnd(24)} ${(branch.slug || '').padEnd(24)} ${code}${had ? '  (already set)' : '  (assigned now)'}`);
  }

  console.log('\nNew order references for each branch will start with its code, e.g. ' +
    (branches.length ? `${await getBranchCode(branches[0]._id)}-${new Date().getFullYear()}-0001` : 'NAI-2026-0001') + '.');
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
