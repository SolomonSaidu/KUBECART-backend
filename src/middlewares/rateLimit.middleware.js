import rateLimit from 'express-rate-limit';

const rateLimitResponse = (message) => ({
  error: 'Too Many Requests',
  message,
});

const commonOptions = {
  standardHeaders: true,
  legacyHeaders: false,
};

export const apiLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * 60 * 1000,
  max: 300,
  skip: (req) =>
    req.path === '/health' ||
    req.path === '/health/ready' ||
    req.path === '/payments/webhook',
  message: rateLimitResponse('Too many requests. Please try again later.'),
});

export const adminLoginLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: rateLimitResponse(
    'Too many login attempts. Please try again after 15 minutes.'
  ),
});

export const adminBootstrapLimiter = rateLimit({
  ...commonOptions,
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: rateLimitResponse(
    'Too many bootstrap attempts. Please try again later.'
  ),
});

export const checkoutLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: rateLimitResponse(
    'Too many checkout attempts. Please try again later.'
  ),
});

export const paymentLimiter = rateLimit({
  ...commonOptions,
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: rateLimitResponse(
    'Too many payment requests. Please try again later.'
  ),
});
