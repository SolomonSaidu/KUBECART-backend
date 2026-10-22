import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

/**
 * Parse and validate a string env var as a non-negative integer.
 * Throws a descriptive error if the value is not a safe integer or is negative,
 * preventing silent string-to-number coercion bugs (e.g. "150000" passed as-is
 * turning numeric addition into string concatenation).
 */
function intEnvVar(name) {
  return z
    .string()
    .transform((v) => {
      const n = parseInt(v, 10);
      if (!Number.isInteger(n) || !Number.isFinite(n) || n < 0) {
        throw new Error(
          `${name} must be a non-negative integer, got: "${v}"`
        );
      }
      return n;
    })
    .pipe(z.number().int().nonnegative());
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: intEnvVar("PORT").default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  DATABASE_URL: z.string().url(),
  CORS_ORIGIN: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    )
    .pipe(
      z
        .array(z.string().url())
        .min(1, "CORS_ORIGIN must contain at least one origin")
    ),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SESSION_SECRET: z.string().min(32),
  PAYSTACK_SECRET_KEY: z
    .string()
    .startsWith("sk_test_")
    .or(z.string().startsWith("sk_live_")),
  PAYSTACK_PUBLIC_KEY: z
    .string()
    .startsWith("pk_test_")
    .or(z.string().startsWith("pk_live_")),
  // Inventory reservation window in minutes; must be a positive integer.
  INVENTORY_RESERVATION_MINUTES: intEnvVar("INVENTORY_RESERVATION_MINUTES").default(15),
  // Flat delivery fee in kobo (integer minor units); must be a non-negative integer.
  // Default: 150000 kobo = 1,500 NGN.
  DEFAULT_DELIVERY_FEE_KOBO: intEnvVar("DEFAULT_DELIVERY_FEE_KOBO").default(150000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
