const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../src/services/productImportExport.service');

test('validateHeaders accepts the current template headers', () => {
  assert.doesNotThrow(() => __private.validateHeaders(__private.HEADER_ROW));
});

test('validateHeaders rejects outdated headers', () => {
  assert.throws(
    () => __private.validateHeaders(['Wrong Header']),
    /Invalid import template/
  );
});

test('buildMergedVarieties preserves existing images when import has none', () => {
  const merged = __private.buildMergedVarieties(
    [{
      varietyName: 'Yellow Beans',
      description: 'Existing description',
      imageURLs: ['https://example.com/existing.jpg'],
      packaging: [{ size: '50kg', priceKES: 1000, stock: 10, lowStockThreshold: 5, quoteOnly: false }]
    }],
    [{
      varietyName: 'Yellow Beans',
      description: 'Imported description',
      imageURLs: [],
      packaging: [{ size: '50kg', priceKES: 1200, stock: null, lowStockThreshold: 8, quoteOnly: false }]
    }]
  );

  assert.equal(merged[0].imageURLs[0], 'https://example.com/existing.jpg');
  assert.equal(merged[0].packaging[0].priceKES, 1200);
  assert.equal(merged[0].packaging[0].stock, 10);
});
