const Branch = require('../models/Branch');
const { AppError } = require('../middleware/errorHandler.middleware');

// Every branch gets a short, unique code that prefixes its order references (NAI-2026-0153).
//
// Why this exists: Order.orderRef carries a unique index across ALL branches, but each branch counts
// its own orders from 1. Two branches therefore both tried to issue ORD-2026-0001; the second one
// hit a duplicate-key error, and because the failed transaction also rolled its counter back it
// retried the same reference forever - a branch other than the first to take an order could never
// place one. With a distinct code per branch the references can never collide.
//
// The code is derived from the slug the first time it is needed and then stored on the branch, so it
// never changes afterwards (references already issued must stay valid). The unique index on
// Branch.code makes the claim race-safe: if two branches want the same letters, the loser simply
// takes the next candidate.

// 'ORD' prefixes every order reference issued before branch codes existed (ORD-2026-0152), and
// 'INT' prefixes stock-intake references - neither may be handed out as a branch code.
const RESERVED = new Set(['ORD', 'INT']);

const cache = new Map(); // branchId (string) -> code

const lettersOnly = (value) => String(value || '').toUpperCase().replace(/[^A-Z]/g, '');

// "nairobi-branch" -> NAI, NAIR, NAIRO, NAIROBI, then NAI2, NAI3 ... (all within the model's 2-8 chars)
const candidateCodes = (branch) => {
  const firstWord = String(branch.slug || '').split(/[^a-zA-Z]+/).find(Boolean);
  let base = lettersOnly(firstWord) || lettersOnly(branch.name);
  if (base.length < 3) base = `${base}${lettersOnly(branch.slug)}${lettersOnly(branch.name)}XXX`.slice(0, 3);
  base = base.slice(0, 8);

  const candidates = [];
  for (let len = 3; len <= base.length; len++) candidates.push(base.slice(0, len));
  const stem = base.slice(0, 3);
  for (let n = 2; n <= 99; n++) candidates.push(`${stem}${n}`);

  return [...new Set(candidates)].filter((code) => !RESERVED.has(code));
};

const getBranchCode = async (branchId) => {
  const key = String(branchId);
  const cached = cache.get(key);
  if (cached) return cached;

  const branch = await Branch.findById(branchId).select('code slug name').lean();
  if (!branch) throw new AppError('Branch not found', 404, 'BRANCH_NOT_FOUND');
  if (branch.code) {
    cache.set(key, branch.code);
    return branch.code;
  }

  for (const candidate of candidateCodes(branch)) {
    try {
      const { matchedCount } = await Branch.updateOne(
        { _id: branch._id, code: { $exists: false } },
        { $set: { code: candidate } }
      );
      if (matchedCount === 0) {
        // A concurrent request assigned one first - use theirs, never overwrite it.
        const fresh = await Branch.findById(branch._id).select('code').lean();
        if (!fresh) throw new AppError('Branch not found', 404, 'BRANCH_NOT_FOUND');
        if (fresh.code) {
          cache.set(key, fresh.code);
          return fresh.code;
        }
        continue;
      }
      cache.set(key, candidate);
      return candidate;
    } catch (err) {
      if (err.code !== 11000) throw err; // 11000: another branch already owns this candidate - try the next
    }
  }

  throw new AppError('Could not assign an order-reference code to this branch', 500, 'BRANCH_CODE_UNAVAILABLE');
};

// For tests and for after a database restore (a restored branch may carry a different code).
const resetBranchCodeCache = () => cache.clear();

module.exports = { getBranchCode, resetBranchCodeCache, candidateCodes };
