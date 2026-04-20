require('dotenv').config();
const mongoose = require('mongoose');

require('../src/models/Branch');
require('../src/models/User');
require('../src/models/Guest');
require('../src/models/Product');
require('../src/models/Order');
require('../src/models/Payment');
require('../src/models/StockLog');
require('../src/models/ActivityLog');
require('../src/models/OrderCounter');
require('../src/models/Settings');
require('../src/models/TokenBlacklist');

const syncIndexes = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected for index sync');

  const db = mongoose.connection;

  // These fields use partialFilterExpression (not sparse) so explicit null values
  // must be removed from documents before the unique index can be built.
  // Safe to unset — null means "not set" for all three fields.
  const unsetNulls = [
    { collection: 'users',    field: 'email' },
    { collection: 'payments', field: 'mpesaTransactionId' },
    { collection: 'payments', field: 'checkoutRequestId' },
  ];
  for (const { collection, field } of unsetNulls) {
    const result = await db.collection(collection).updateMany(
      { [field]: null },
      { $unset: { [field]: '' } }
    );
    if (result.modifiedCount > 0) {
      console.log(`Unset null ${collection}.${field} on ${result.modifiedCount} documents`);
    }
  }

  // Drop old indexes so syncIndexes() can recreate them with correct options
  const forceDrop = [
    { collection: 'users',    index: 'email_1' },
    { collection: 'payments', index: 'mpesaTransactionId_1' },
    { collection: 'payments', index: 'checkoutRequestId_1' },
  ];
  for (const { collection, index } of forceDrop) {
    try {
      await db.collection(collection).dropIndex(index);
      console.log(`Dropped stale index ${collection}.${index}`);
    } catch (e) {
      if (e.codeName !== 'IndexNotFound') console.warn(`  skipped ${collection}.${index}: ${e.message}`);
    }
  }

  const modelNames = mongoose.modelNames();

  for (const modelName of modelNames) {
    const model = mongoose.model(modelName);
    console.log(`Syncing indexes for ${modelName}...`);
    await model.syncIndexes();
  }

  console.log('All indexes synced successfully');
  await mongoose.connection.close();
};

syncIndexes()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('Index sync failed:', error.message);
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    process.exit(1);
  });
