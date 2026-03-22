const mongoose = require('mongoose');

// Stores invalidated refresh tokens until they naturally expire
// TTL index auto-deletes documents after the token expiry window
const tokenBlacklistSchema = new mongoose.Schema({
  token:     { type: String, required: true, unique: true },
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true }
});

// MongoDB auto-deletes documents when expiresAt is reached
tokenBlacklistSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
tokenBlacklistSchema.index({ token: 1 }, { unique: true });

module.exports = mongoose.model('TokenBlacklist', tokenBlacklistSchema);