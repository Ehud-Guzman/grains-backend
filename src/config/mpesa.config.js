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

// ── TOKEN CACHE ───────────────────────────────────────────────────────────────
// Tokens are valid for 3600s — we cache for 55 minutes to be safe.
// Note: this cache is per-process. In PM2 cluster mode each worker fetches
// its own token independently; that is acceptable since Daraja tokens are
// stateless and the extra OAuth calls are cheap.
let tokenCache = { token: null, expiresAt: 0 };

// In-flight fetch promise — prevents multiple concurrent requests on startup
// or after a restart from all racing to fetch the same token simultaneously.
let fetchInFlight = null;

// ── CIRCUIT BREAKER ───────────────────────────────────────────────────────────
// After FAILURE_THRESHOLD consecutive Daraja failures the circuit opens and
// all STK push attempts fail immediately (fast-fail) for RECOVERY_WINDOW_MS.
// This prevents customers queueing 30-second timeouts when Safaricom is down.
const FAILURE_THRESHOLD  = 3;
const RECOVERY_WINDOW_MS = 60_000; // 1 minute

let circuitState = { failures: 0, openUntil: 0 };

const isCircuitOpen = () => {
  if (circuitState.openUntil && Date.now() < circuitState.openUntil) return true;
  // Recovery window expired — reset so the next attempt goes through (half-open)
  if (circuitState.openUntil && Date.now() >= circuitState.openUntil) {
    circuitState.openUntil = 0;
  }
  return false;
};

const recordSuccess = () => { circuitState.failures = 0; circuitState.openUntil = 0; };
const recordFailure = () => {
  circuitState.failures += 1;
  if (circuitState.failures >= FAILURE_THRESHOLD) {
    circuitState.openUntil = Date.now() + RECOVERY_WINDOW_MS;
  }
};

const getEnv  = () => process.env.MPESA_ENV || 'sandbox';
const getUrls = () => DARAJA_URLS[getEnv()] || DARAJA_URLS.sandbox;

// ── TOKEN FETCH ───────────────────────────────────────────────────────────────
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
    token:     res.data.access_token,
    expiresAt: Date.now() + (55 * 60 * 1000)
  };
};

// ── GET TOKEN (mutex + circuit breaker) ───────────────────────────────────────
const getDarajaToken = async () => {
  // Serve from cache if still valid
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  // Circuit open — Daraja is unreachable, fail fast instead of hanging
  if (isCircuitOpen()) {
    throw new Error('M-Pesa is temporarily unavailable. Please try again in a moment.');
  }

  // If a fetch is already in-flight, wait for it rather than firing a duplicate
  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = fetchToken()
    .then(result => {
      tokenCache    = result;
      fetchInFlight = null;
      recordSuccess();
      return result.token;
    })
    .catch(err => {
      fetchInFlight = null;
      recordFailure();
      throw err;
    });

  return fetchInFlight;
};

// Invalidate cache (call after credential rotation or env switch)
const invalidateTokenCache = () => {
  tokenCache    = { token: null, expiresAt: 0 };
  fetchInFlight = null;
  circuitState  = { failures: 0, openUntil: 0 };
};

module.exports = { getDarajaToken, getUrls, getEnv, invalidateTokenCache };
