// Shared test-data builders for backend service tests.
const mongoose = require('mongoose');
const Branch = require('../../src/models/Branch');
const Product = require('../../src/models/Product');
const User = require('../../src/models/User');
const Settings = require('../../src/models/Settings');
const settingsService = require('../../src/services/settings.service');

let counter = 0;
const unique = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

const createBranch = async (overrides = {}) => {
  return Branch.create({
    name: 'Test Branch',
    slug: unique('branch'),
    isActive: true,
    isDefault: true,
    ...overrides,
  });
};

// Settings are cached in-process by settings.service — always invalidate
// after writing directly to the DB in a test, or getSettings() will return stale data.
const createSettings = async (branchId, overrides = {}) => {
  const settings = await Settings.create({
    _id: `settings_${branchId}`,
    branchId,
    ...overrides,
  });
  settingsService.invalidateCache(branchId);
  return settings;
};

const createUser = async (branchId, overrides = {}) => {
  return User.create({
    name: 'Test User',
    phone: `07${String(Date.now()).slice(-8)}`,
    passwordHash: 'not-a-real-hash',
    role: 'customer',
    branchId,
    ...overrides,
  });
};

// One product, one variety, one packaging line — enough for a single-item order.
const createProduct = async (branchId, createdBy, overrides = {}) => {
  const packagingOverrides = overrides.packaging || {};
  delete overrides.packaging;

  return Product.create({
    name: 'Test Maize',
    category: 'Cereals',
    branchId,
    createdBy,
    varieties: [{
      varietyName: 'Yellow',
      packaging: [{
        size: '50kg',
        priceKES: 1000,
        stock: 100,
        lowStockThreshold: 10,
        quoteOnly: false,
        ...packagingOverrides,
      }],
    }],
    ...overrides,
  });
};

const cartItemFor = (product, { variety = 'Yellow', packaging = '50kg', quantity = 1 } = {}) => ({
  productId: product._id.toString(),
  variety,
  packaging,
  quantity,
});

const objectId = () => new mongoose.Types.ObjectId();

module.exports = {
  createBranch,
  createSettings,
  createUser,
  createProduct,
  cartItemFor,
  objectId,
};
