import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().transform((v) => parseInt(v, 10)).default('3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(32),
  PAYSTACK_SECRET_KEY: z.string().startsWith('sk_test_').or(z.string().startsWith('sk_live_')),
  PAYSTACK_PUBLIC_KEY: z.string().startsWith('pk_test_').or(z.string().startsWith('pk_live_')),
  INVENTORY_RESERVATION_MINUTES: z.string().transform((v) => parseInt(v, 10)).default('15'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
