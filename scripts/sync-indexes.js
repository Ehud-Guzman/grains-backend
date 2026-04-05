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
