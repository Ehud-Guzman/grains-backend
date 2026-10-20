// 2026-10 audit F-24: one pooled transport with timeouts, and a daily budget that keeps room for
// sign-in / password-reset codes and security alerts when order notifications would use it all.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mailer = require('../src/utils/mailer');

const fake = () => {
  const sent = [];
  return { sent, sendMail: async (m) => { sent.push(m); return { messageId: 'x' }; } };
};

describe('mailer', () => {
  let t;
  beforeEach(() => {
    process.env.EMAIL_DAILY_LIMIT = '10';
    process.env.EMAIL_CRITICAL_RESERVE = '3';
    mailer._resetBudget();
    t = fake();
    mailer._setTransporter(t);
  });
  afterEach(() => {
    delete process.env.EMAIL_DAILY_LIMIT;
    delete process.env.EMAIL_CRITICAL_RESERVE;
    mailer._setTransporter(undefined);
  });

  test('ordinary mail stops at limit minus reserve; critical mail may use the reserve; nothing passes the limit', async () => {
    for (let i = 0; i < 7; i++) assert.deepEqual(await mailer.sendMail({ to: `c${i}@x.com` }), { sent: true });
    assert.deepEqual(await mailer.sendMail({ to: 'late@x.com' }), { sent: false, reason: 'daily_limit' });
    for (let i = 0; i < 3; i++) assert.deepEqual(await mailer.sendMail({ to: `otp${i}@x.com` }, { critical: true }), { sent: true });
    assert.deepEqual(await mailer.sendMail({ to: 'otp@x.com' }, { critical: true }), { sent: false, reason: 'daily_limit' });
    assert.equal(t.sent.length, 10);
  });

  test('a send that fails does not spend the budget', async () => {
    mailer._setTransporter({ sendMail: async () => { throw new Error('smtp down'); } });
    await assert.rejects(mailer.sendMail({ to: 'a@x.com' }), /smtp down/);
    assert.equal(mailer.stats().sentToday, 0);
  });

  test('a message with several recipients counts each, and no recipient is a no-op', async () => {
    await mailer.sendMail({ to: 'a@x.com, b@x.com, c@x.com' });
    assert.equal(mailer.stats().sentToday, 3);
    assert.deepEqual(await mailer.sendMail({ to: '' }), { sent: false, reason: 'no_recipient' });
  });

  test('without Gmail credentials it reports not_configured instead of throwing', async () => {
    mailer._setTransporter(null);
    assert.deepEqual(await mailer.sendMail({ to: 'a@x.com' }), { sent: false, reason: 'not_configured' });
    assert.equal(mailer.isConfigured(), false);
  });
});
