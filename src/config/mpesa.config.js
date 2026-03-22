// ── DARAJA API CONFIG ─────────────────────────────────────────────────────────
// Handles OAuth token fetching and caching for Safaricom Daraja API

const axios = require('axios');

const DARAJA_URLS = {
  sandbox: {
    oauth:   'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    stkpush: 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
  },
  production: {
    oauth:   'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    stkpush: 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
  }
};

// In-memory token cache
let tokenCache = { token: null, expiresAt: 0 };

const getEnv = () => process.env.MPESA_ENV || 'sandbox';
const getUrls = () => DARAJA_URLS[getEnv()] || DARAJA_URLS.sandbox;

// Fetch a fresh OAuth token from Safaricom
const fetchToken = async () => {
  const key    = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error('MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET are not set in .env');
  }

  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');

  const res = await axios.get(getUrls().oauth, {
    headers: { Authorization: `Basic ${credentials}` },
    timeout: 10000
  });

  return {
    token: res.data.access_token,
    // Safaricom tokens expire in 3600s — cache for 55 mins to be safe
    expiresAt: Date.now() + (55 * 60 * 1000)
  };
};

// Get token — returns cached if still valid, fetches fresh if not
const getDarajaToken = async () => {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  tokenCache = await fetchToken();
  return tokenCache.token;
};

// Invalidate cache (call after credential rotation)
const invalidateTokenCache = () => {
  tokenCache = { token: null, expiresAt: 0 };
};

module.exports = { getDarajaToken, getUrls, getEnv, invalidateTokenCache };