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
export const shopLimiter = limiter(15, 300, 'Too many requests. Please try again shortly.');
export const requestLimiter = limiter(15, 30, 'Too many requests sent. Please try again later.');
export const checkoutLimiter = limiter(15, 40, 'Too many checkout attempts. Please wait a few minutes and try again.');
export const payVerifyLimiter = limiter(15, 60, 'Too many payment checks. Please wait a moment.');
export const orderActionLimiter = limiter(15, 300, 'Too many actions. Please slow down.');
export const dispatchLimiter = limiter(15, 60, 'Too many requests from this link. Please try again shortly.');
export const webhookLimiter = limiter(1, 600, 'Too many webhook calls.');
