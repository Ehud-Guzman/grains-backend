const logger = require('./logger');

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

module.exports = { safeAbort };
