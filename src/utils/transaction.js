const mongoose = require('mongoose');
const logger = require('./logger');
const { AppError } = require('../middleware/errorHandler.middleware');

// Abort a transaction only if one is still open. Calling abortTransaction() after a
// successful commit throws MongoTransactionError, and when that happens inside a
// catch block it REPLACES the real error: the caller saw a transaction error for
// what was actually a failed notification or log write, and a batch job (auto-cancel)
// died on the first order whose post-commit step failed.
const safeAbort = async (session) => {
  if (!session || !session.inTransaction()) return;
  try {
    await session.abortTransaction();
  } catch (err) {
    logger.error('[transaction] abort failed', { err: err.message });
  }
};

const isTransientTransactionError = (err) =>
  typeof err?.hasErrorLabel === 'function' && err.hasErrorLabel('TransientTransactionError');

// Two overlapping transactions that write the same document do not queue: MongoDB aborts the
// second one at once with a WriteConflict, labelled TransientTransactionError, and the documented
// handling is to run the whole transaction again. Every order on a branch writes that branch's
// OrderCounter and the product lines it reserves, so without a retry any two customers checking
// out at the same moment meant one of them got a raw 500 (reproduced: 10 simultaneous orders on
// one branch -> 1 created, 9 failed).
//
// Orders on one branch all write that branch's counter, so they genuinely queue: N overlapping
// checkouts need N rounds, and the last in line has to survive N-1 collisions. A failed attempt is
// cheap (it dies on its first write), so there is plenty of headroom - 10 attempts spread over
// roughly a second covers a burst of ~10 simultaneous orders; beyond that the customer gets a clear
// "try again" (503) instead of a raw error.
const MAX_ATTEMPTS = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 20ms, 40ms, 80ms ... capped at 300ms, scaled by 0.3-1.0 of random jitter so the losers of one
// collision do not all come back at the same instant and collide again.
const backoffMs = (attempt) => {
  const ceiling = Math.min(300, 20 * 2 ** (attempt - 2));
  return Math.round(ceiling * (0.3 + Math.random() * 0.7));
};

/**
 * Run `work(session, attempt)` inside a transaction, re-running it from scratch whenever MongoDB
 * reports a transient conflict.
 *
 * `work` therefore MUST be safe to run more than once:
 *   - read every document it changes INSIDE the callback, with `{ session }` (never reuse a document
 *     loaded before the call - an aborted attempt leaves it half-modified in memory);
 *   - do not send notifications, write the activity log or emit events inside it - do those with the
 *     returned value, after this function resolves (that is, after the commit).
 *
 * Resolves with whatever `work` returned on the attempt that committed. Errors that are not
 * transient (AppError, validation, ...) are thrown unchanged on the first attempt.
 */
const runTransaction = async (work, { maxAttempts = MAX_ATTEMPTS, ...transactionOptions } = {}) => {
  const session = await mongoose.startSession();
  let attempt = 0;
  let result;

  try {
    await session.withTransaction(async () => {
      attempt += 1;
      if (attempt > 1) await sleep(backoffMs(attempt));

      try {
        result = await work(session, attempt);
      } catch (err) {
        if (attempt >= maxAttempts && isTransientTransactionError(err)) {
          // The driver only retries a MongoError that carries the transient label, so converting
          // it to an AppError both stops the retry loop (otherwise it would keep going for up to
          // two minutes) and gives the caller something the API can answer with.
          logger.warn('[transaction] giving up after repeated write conflicts', { attempts: attempt, err: err.message });
          throw new AppError(
            'We are handling a lot of requests right now. Please try again in a moment.',
            503,
            'TRANSACTION_CONFLICT'
          );
        }
        throw err;
      }
    }, transactionOptions);
  } finally {
    session.endSession();
  }

  return result;
};

module.exports = { safeAbort, runTransaction, isTransientTransactionError };
