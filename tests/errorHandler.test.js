// Client errors (401/403/404/409/validation) are normal traffic and must not be logged as errors;
// real faults (5xx) must be, with the stack. (2026-10 audit: ~1,800 "error" lines from 2,400 requests.)
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../src/utils/logger');
const { errorHandler, AppError } = require('../src/middleware/errorHandler.middleware');

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

describe('errorHandler log levels', () => {
  let warns, errors, originalWarn, originalError;
  beforeEach(() => {
    warns = []; errors = [];
    originalWarn = logger.warn; originalError = logger.error;
    logger.warn = (m, meta) => warns.push({ m, meta });
    logger.error = (m, meta) => errors.push({ m, meta });
  });
  afterEach(() => { logger.warn = originalWarn; logger.error = originalError; });

  const run = (err) => {
    const res = makeRes();
    errorHandler(err, { requestId: 'r1', user: { id: 'u1' }, method: 'GET', originalUrl: '/x' }, res, () => {});
    return res;
  };

  test('403 / 404 / 409 / 400 AppErrors are warnings and keep their status and code', () => {
    for (const [status, code] of [[400, 'BAD'], [401, 'NO_TOKEN'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'CONFLICT']]) {
      const res = run(new AppError('nope', status, code));
      assert.equal(res.statusCode, status);
      assert.equal(res.body.error, code);
    }
    assert.equal(errors.length, 0, 'no ERROR-level lines for client errors');
    assert.equal(warns.length, 5);
    assert.equal(warns[0].meta.code, 'BAD');
    assert.equal(warns[0].meta.err, undefined, 'no stack for an expected client error');
  });

  test('malformed ids, validation errors and duplicate keys are warnings too', () => {
    run(Object.assign(new Error('cast'), { name: 'CastError' }));
    run(Object.assign(new Error('invalid'), { name: 'ValidationError', errors: {} }));
    run(Object.assign(new Error('dup'), { code: 11000 }));
    assert.equal(errors.length, 0);
    assert.equal(warns.length, 3);
  });

  test('a 5xx is logged at ERROR with the error object, and the client gets a generic message', () => {
    const boom = new Error('database exploded');
    const res = run(boom);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'An unexpected error occurred');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].meta.err, boom);
    assert.equal(warns.length, 0);
  });

  test('a deliberate 503 AppError (conflict budget exhausted) is a server-side error', () => {
    const res = run(new AppError('try again', 503, 'TRANSACTION_CONFLICT'));
    assert.equal(res.statusCode, 503);
    assert.equal(errors.length, 1);
  });
});
