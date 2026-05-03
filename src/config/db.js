const mongoose = require('mongoose');
const logger = require('../utils/logger');
const { DB_RETRY } = require('../utils/constants');

const connectDB = async (retries = DB_RETRY.MAX_RETRIES, delayMs = DB_RETRY.BASE_DELAY_MS) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await mongoose.connect(process.env.MONGODB_URI, {
        // Connection pool — how many simultaneous DB operations are allowed.
        // Render free tier has limited RAM; 10 is a safe ceiling.
        maxPoolSize: 10,
        minPoolSize: 2,

        // How long to wait for a connection from the pool before giving up.
        serverSelectionTimeoutMS: 10000,

        // How long a socket can be idle before being closed.
        socketTimeoutMS: 45000,

        // Drop and retry the connection if the initial connect takes too long.
        connectTimeoutMS: 10000,
      });

      logger.info(`MongoDB connected: ${conn.connection.host}`);

      mongoose.connection.on('disconnected', () =>
        logger.error('MongoDB disconnected — attempting to reconnect')
      );
      mongoose.connection.on('error', (err) =>
        logger.error('MongoDB runtime error', { err: err.message })
      );
      mongoose.connection.on('reconnected', () =>
        logger.info('MongoDB reconnected')
      );

      return;
    } catch (error) {
      logger.error(`MongoDB connection attempt ${attempt}/${retries} failed`, { err: error.message });
      if (attempt === retries) {
        logger.error('All MongoDB connection attempts exhausted. Exiting.');
        process.exit(1);
      }
      const backoffMs = delayMs * (2 ** (attempt - 1));
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
};

module.exports = connectDB;
