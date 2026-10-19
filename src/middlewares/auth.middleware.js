import { tokenUtil } from '../utils/token.util.js';
import { prisma } from '../config/db.js';

export const requireAdmin = async (req, res, next) => {
  try {
    let token = null;

    // Support both HttpOnly cookie and Bearer header
    if (req.cookies && req.cookies.admin_token) {
      token = req.cookies.admin_token;
    } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication token required',
        requestId: req.id,
      });
    }

    const payload = tokenUtil.verifyToken(token);
    if (!payload || !payload.adminId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired authentication token',
        requestId: req.id,
      });
    }

    const admin = await prisma.admin.findUnique({
      where: { id: payload.adminId },
      select: { id: true, email: true, name: true },
    });

    if (!admin) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Admin account not found or deactivated',
        requestId: req.id,
      });
    }

    req.admin = admin;
    next();
  } catch (err) {
    next(err);
  }
};
