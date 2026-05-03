// test-mongo.js
require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('../utils/logger');

const MONGO_URI = process.env.MONGO_URI;

async function testConnection() {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    logger.info('MongoDB connected successfully');
    await mongoose.connection.close();
  } catch (err) {
    logger.error('MongoDB connection failed', { err: err.message });
  }
}

testConnection();
