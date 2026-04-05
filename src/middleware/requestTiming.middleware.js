const DEFAULT_SLOW_THRESHOLD_MS = 1200;

const requestTiming = (req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const finishedAt = process.hrtime.bigint();
    const durationMs = Number(finishedAt - startedAt) / 1_000_000;
    const threshold = Number(process.env.SLOW_REQUEST_THRESHOLD_MS) || DEFAULT_SLOW_THRESHOLD_MS;
    const rounded = durationMs.toFixed(1);

    if (durationMs >= threshold) {
      console.warn(
        `[SLOW REQUEST] ${req.method} ${req.originalUrl} ${res.statusCode} - ${rounded}ms`
      );
    }
  });

  next();
};

module.exports = { requestTiming };
