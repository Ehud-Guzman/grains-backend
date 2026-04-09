// ── STRUCTURED LOGGER ─────────────────────────────────────────────────────────
// Production  → JSON lines (easy to ingest by log aggregators)
// Development → readable [LEVEL] prefix with colour-like formatting
//
// Usage:
//   const logger = require('./logger');
//   logger.info('Order created', { requestId, branchId, orderId });
//   logger.error('Payment failed', { requestId, branchId, err });

const isProd = process.env.NODE_ENV === 'production';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? (isProd ? LEVELS.info : LEVELS.debug);

const write = (level, message, meta = {}) => {
  if (LEVELS[level] > MIN_LEVEL) return;

  // Never log sensitive fields
  const { password, token, refreshToken, accessToken, ...safeMeta } = meta;

  if (isProd) {
    // Structured JSON — one line per log entry
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...safeMeta,
    };
    // Errors: serialise the stack if an Error object was passed as `err`
    if (safeMeta.err instanceof Error) {
      entry.err = { message: safeMeta.err.message, stack: safeMeta.err.stack };
    }
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    const prefix = `[${level.toUpperCase()}]`;
    const context = Object.keys(safeMeta).length
      ? ' ' + JSON.stringify(safeMeta, (k, v) => (v instanceof Error ? v.message : v))
      : '';
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      `${prefix} ${message}${context}`
    );
  }
};

const logger = {
  error: (message, meta) => write('error', message, meta),
  warn:  (message, meta) => write('warn',  message, meta),
  info:  (message, meta) => write('info',  message, meta),
  debug: (message, meta) => write('debug', message, meta),

  // Convenience: build a child logger pre-filled with request context
  // Usage: const log = logger.child(req);  log.info('doing thing');
  child: (req) => ({
    error: (message, meta) => write('error', message, { requestId: req.requestId, branchId: req.branchId || req.user?.branchId, userId: req.user?.id, ...meta }),
    warn:  (message, meta) => write('warn',  message, { requestId: req.requestId, branchId: req.branchId || req.user?.branchId, userId: req.user?.id, ...meta }),
    info:  (message, meta) => write('info',  message, { requestId: req.requestId, branchId: req.branchId || req.user?.branchId, userId: req.user?.id, ...meta }),
    debug: (message, meta) => write('debug', message, { requestId: req.requestId, branchId: req.branchId || req.user?.branchId, userId: req.user?.id, ...meta }),
  }),
};

module.exports = logger;
