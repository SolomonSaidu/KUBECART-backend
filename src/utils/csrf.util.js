import { randomBytes, timingSafeEqual } from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokensMatch(cookieToken, headerToken) {
  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string') {
    return false;
  }

  const cookieBuffer = Buffer.from(cookieToken);
  const headerBuffer = Buffer.from(headerToken);

  if (cookieBuffer.length !== headerBuffer.length) {
    return false;
  }

  return timingSafeEqual(cookieBuffer, headerBuffer);
}

export const csrfUtil = {
  generateToken() {
    return randomBytes(32).toString('hex');
  },

  requiresValidation(req) {
    return !SAFE_METHODS.has(req.method);
  },

  isValid(req) {
    return tokensMatch(req.cookies?.admin_csrf, req.headers['x-csrf-token']);
  },
};
