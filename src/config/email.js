import { env } from './env.js';

const EMAIL_ENV_KEYS = ['BREVO_API_KEY', 'EMAIL_FROM', 'FRONTEND_URL'];

export function buildEmailConfig(source = {}) {
  const missing = EMAIL_ENV_KEYS.filter(
    (key) => typeof source[key] !== 'string' || source[key].trim() === ''
  );

  return Object.freeze({
    enabled: missing.length === 0,
    missing,
    apiKey: source.BREVO_API_KEY,
    from: source.EMAIL_FROM,
    frontendUrl: source.FRONTEND_URL,
  });
}

export const emailConfig = buildEmailConfig(env);

export function assertEmailConfigured(config = emailConfig) {
  if (config.enabled) {
    return;
  }

  const error = new Error(
    `Email delivery is not configured: missing ${config.missing.join(', ')}`
  );
  error.code = 'EMAIL_NOT_CONFIGURED';
  error.statusCode = 503;
  throw error;
}
