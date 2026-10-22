import { tokenUtil } from '../utils/token.util.js';
import { csrfUtil } from '../utils/csrf.util.js';
import { prisma } from '../config/db.js';

function unauthorized(res, req, message) {
  return res.status(401).json({
    error: 'Unauthorized',
    message,
    requestId: req.id,
  });
}

function forbiddenCsrf(res, req) {
  return res.status(403).json({
    error: 'Forbidden',
    message: 'Missing or invalid CSRF token',
    requestId: req.id,
  });
}

export const requireAdmin = async (req, res, next) => {
  try {
    let token = null;
    let tokenFromCookie = false;

    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.admin_token) {
      token = req.cookies.admin_token;
      tokenFromCookie = true;
    }

    if (!token) {
      return unauthorized(res, req, 'Authentication token required');
    }

    if (
      tokenFromCookie &&
      csrfUtil.requiresValidation(req) &&
      !csrfUtil.isValid(req)
    ) {
      return forbiddenCsrf(res, req);
    }

    const payload = tokenUtil.verifyToken(token);
    if (!payload || !payload.adminId) {
      return unauthorized(res, req, 'Invalid or expired authentication token');
    }

    const admin = await prisma.admin.findUnique({
      where: { id: payload.adminId },
      select: { id: true, email: true, name: true },
    });

    if (!admin) {
      return unauthorized(res, req, 'Admin account not found or deactivated');
    }

    req.admin = admin;
    req.authMethod = tokenFromCookie ? 'cookie' : 'bearer';
    next();
  } catch (err) {
    next(err);
  }
};

export const requireCsrfForCookieAuth = (req, res, next) => {
  if (req.cookies?.admin_token && !csrfUtil.isValid(req)) {
    return forbiddenCsrf(res, req);
  }

  next();
};
