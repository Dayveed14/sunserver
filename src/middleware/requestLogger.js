import crypto from 'node:crypto';

// Gives every request an id (also sent back in X-Request-Id, so a customer can quote it) and writes one JSON line
// per request when it finishes. It logs the path without the query string and never logs bodies, cookies or headers.
export function requestLogger(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/api/health' || req.path === '/health') return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    if (!(process.env.NODE_ENV === 'production' || process.env.LOG_REQUESTS === '1')) return; // quiet in development and tests
    console.log(JSON.stringify({ level, msg: 'request', id: req.id, method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Math.round(ms), userId: req.user?.id ?? null, ip: req.ip }));
  });
  next();
}
