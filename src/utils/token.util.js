import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

const JWT_EXPIRES_IN = '24h';

export const tokenUtil = {
  generateToken(payload) {
    return jwt.sign(payload, env.SESSION_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });
  },

  verifyToken(token) {
    try {
      return jwt.verify(token, env.SESSION_SECRET);
    } catch {
      return null;
    }
  },
};
