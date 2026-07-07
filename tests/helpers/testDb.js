// Spins up an in-memory MongoDB replica set for tests that need real
// multi-document transactions (order/stock/coupon services all use sessions).
// A single-node replica set is the minimum topology that supports transactions.
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let replSet;

const connect = async () => {
  // launchTimeout is generous because the first run on a machine downloads the
  // MongoDB binary (one-time; cached afterwards under mongodb-memory-server's cache dir).
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ launchTimeout: 120_000 }],
  });
  const uri = replSet.getUri();
  await mongoose.connect(uri);

  // Mongoose builds indexes in the background right after connecting. If a
  // transaction starts before that finishes, MongoDB throws "due to catalog
  // changes; please retry" — wait for every already-registered model's index
  // build to finish first so tests don't race it.
  await Promise.all(Object.values(mongoose.connection.models).map((m) => m.init()));
};

const disconnect = async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
};

// Drops all collections between tests so each test starts from a clean DB.
const clearDatabase = async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
};

module.exports = { connect, disconnect, clearDatabase };
