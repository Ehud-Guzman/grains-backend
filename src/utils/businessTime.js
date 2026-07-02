// Kenya business-time helpers. The API server runs in UTC (Render), but all
// business-day boundaries (dashboard KPIs, reports, VAT months, driver stats)
// must follow the Nairobi clock — otherwise orders placed 00:00–03:00 EAT are
// counted in the previous day. Kenya is UTC+3 year-round with no DST, so a
// fixed offset is safe and avoids a timezone-library dependency.
const NAIROBI_TZ = 'Africa/Nairobi'; // for MongoDB aggregation date operators
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

// Pattern: shift the instant into the EAT frame, snap it there using UTC
// accessors, then shift back to a real UTC instant.
const startOfDayEAT = (date = new Date()) => {
  const shifted = new Date(date.getTime() + EAT_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - EAT_OFFSET_MS);
};

const endOfDayEAT = (date = new Date()) => {
  const shifted = new Date(date.getTime() + EAT_OFFSET_MS);
  shifted.setUTCHours(23, 59, 59, 999);
  return new Date(shifted.getTime() - EAT_OFFSET_MS);
};

const startOfMonthEAT = (date = new Date()) => {
  const shifted = new Date(date.getTime() + EAT_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - EAT_OFFSET_MS);
};

module.exports = { NAIROBI_TZ, startOfDayEAT, endOfDayEAT, startOfMonthEAT };
