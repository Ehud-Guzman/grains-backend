// 2026-10 audit F-47: delivery-zone bands must be a clean sequence.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateDeliveryZones } = require('../src/validators/settings.validator');

const check = (zones, body = {}) => {
  try { return { ok: validateDeliveryZones(zones, { req: { body } }) === true }; }
  catch (e) { return { ok: false, message: e.message }; }
};
const band = (name, minKm, maxKm, fee = 100) => ({ name, minKm, maxKm, fee });

describe('validateDeliveryZones', () => {
  test('contiguous bands starting at 0 are fine, in any array order', () => {
    assert.equal(check([band('A', 0, 5), band('B', 5, 15), band('C', 15, 40)]).ok, true);
    assert.equal(check([band('C', 15, 40), band('A', 0, 5), band('B', 5, 15)]).ok, true);
  });
  test('overlaps, gaps, inverted and negative bands are rejected with a plain explanation', () => {
    assert.match(check([band('A', 0, 10), band('B', 5, 20)]).message, /overlap/i);
    assert.match(check([band('A', 0, 5), band('B', 8, 20)]).message, /gap between 5 km and 8 km/);
    assert.match(check([band('A', 0, 5), band('B', 5, 5)]).message, /greater than its start/);
    assert.match(check([band('A', -1, 5)]).message, /0 or more/);
    assert.match(check([band('A', 2, 5)]).message, /start at 0 km/);
  });
  test('a delivery radius inside the last band is rejected (the bug that shipped once)', () => {
    const zones = [band('A', 0, 10), band('B', 10, 50)];
    assert.match(check(zones, { maxDeliveryKm: 10 }).message, /could never be used/);
    assert.equal(check(zones, { maxDeliveryKm: 50 }).ok, true);
    assert.equal(check(zones).ok, true, 'radius not part of this update: not checked');
  });
  test('older name-and-fee-only zones, and empty lists, are left alone', () => {
    assert.equal(check([{ name: 'Town', fee: 100 }]).ok, true);
    assert.equal(check([]).ok, true);
  });
});
