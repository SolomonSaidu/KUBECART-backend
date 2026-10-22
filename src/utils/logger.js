import pino from 'pino';
import { env } from '../config/env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-paystack-signature"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'password',
  'token',
  'csrfToken',
  'SUPABASE_SECRET_KEY',
  'supabaseSecretKey',
  'config.SUPABASE_SECRET_KEY',
  'env.SUPABASE_SECRET_KEY',
];

export function createLogger({ transport, destination } = {}) {
  const options = {
    level: env.LOG_LEVEL,
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
    ...(transport ? { transport } : {}),
  };

  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger({
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
          },
        }
      : undefined,
});
