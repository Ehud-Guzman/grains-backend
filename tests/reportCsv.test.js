// CSV export: the formula-injection guard must protect text, not corrupt numbers, and dates must be
// on the Nairobi clock. (2026-10 audit: 2,209 cells like "'-7" in the stock-movement export, and the
// Nairobi day of 18 Oct printed as "Sat Oct 17 2026 21:00:00 GMT+0000" on the UTC server.)
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { toCSV } = require('../src/services/report.service');

const col = (key, label = key) => ({ key, label });

describe('toCSV', () => {
  test('negative numbers stay numbers (no apostrophe)', () => {
    const csv = toCSV([{ qty: -7, profit: -1250.5, zero: 0 }], [col('qty'), col('profit'), col('zero')]);
    const row = csv.split('\n')[1];
    assert.equal(row, '"-7","-1250.5","0"');
  });

  test('user-controlled text that starts like a formula is neutralised', () => {
    for (const bad of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
      const csv = toCSV([{ name: bad }], [col('name')]);
      assert.ok(csv.split('\n')[1].startsWith('"\''), `not guarded: ${JSON.stringify(bad)} -> ${csv.split('\n')[1]}`);
    }
  });

  test('ordinary text is untouched and embedded quotes are doubled', () => {
    const csv = toCSV([{ name: 'Maize "Grade 1"', note: 'plain' }], [col('name'), col('note')]);
    assert.equal(csv.split('\n')[1], '"Maize ""Grade 1""","plain"');
  });

  test('dates print on the Nairobi clock, whatever the server timezone is', () => {
    // 21:00 UTC on the 17th is Nairobi midnight starting the 18th (a report "day" bucket).
    const bucket = new Date('2026-10-17T21:00:00.000Z');
    // A timestamp with a time of day: 06:45 UTC = 09:45 in Nairobi.
    const stamp = new Date('2026-10-18T06:45:35.000Z');
    const csv = toCSV([{ day: bucket, at: stamp }], [col('day'), col('at')]);
    assert.equal(csv.split('\n')[1], '"2026-10-18","2026-10-18 09:45"');
  });

  test('nested keys, null and undefined', () => {
    const csv = toCSV([{ a: { b: 5 }, c: null }], [col('a.b'), col('c'), col('missing')]);
    assert.equal(csv.split('\n')[1], '"5","",""');
  });

  test('an empty result is just the header row', () => {
    assert.equal(toCSV([], [col('x', 'X'), col('y', 'Y')]), 'X,Y\n');
  });
});
