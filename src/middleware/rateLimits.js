import rateLimit from 'express-rate-limit';

const tooMany = (message) => ({ error: { code: 'RATE_LIMITED', message } });

const limiter = (windowMinutes, limit, message) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: tooMany(message),
  });

export const authLimiter = limiter(15, 30, 'Too many attempts. Please wait a few minutes and try again.');
export const otpLimiter = limiter(15, 20, 'Too many code attempts. Please wait a few minutes and try again.');
export const estimateLimiter = limiter(15, 120, 'Too many assessments from this connection. Please try again shortly.');
