const mongoose = require('mongoose');

const connectDB = async () => {
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

    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`MongoDB connection failed: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
