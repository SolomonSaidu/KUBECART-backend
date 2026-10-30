# Kubecart Backend

Backend-only REST API for Kubecart. Built with Node.js, Express, JavaScript ES modules, PostgreSQL, Prisma, Paystack, Brevo transactional email, and Supabase Storage.

## Requirements

- Supported Node.js LTS release
- npm
- PostgreSQL development database
- Git
- Paystack test credentials only when implementing/testing payments

## Install

Clone/open the repository and inspect existing files before running initialization commands. If `package.json` does not exist yet:

```bash
npm init -y
npm pkg set type=module
npm install express dotenv zod @prisma/client helmet cors pino pino-http express-rate-limit
npm install -D prisma vitest supertest
npx prisma init
```

Check `npx prisma --version` and follow setup instructions for that exact Prisma version. Prisma's configuration and PostgreSQL client setup vary by major version. Add a required PostgreSQL driver/adapter only after confirming the selected version needs it.

## Configure environment

Copy `env.example` to `.env` and update local values:

```powershell
# Windows PowerShell
Copy-Item env.example .env
```

```bash
# macOS/Linux
cp env.example .env
```

Never commit `.env` or real credentials.

Product-image uploads require these server-side Supabase values:

- `SUPABASE_URL` - project URL
- `SUPABASE_SECRET_KEY` - server-side secret key, never exposed to clients
- `SUPABASE_BUCKET` - storage bucket name

The bucket is expected to be private. Product responses contain short-lived signed image URLs
instead of permanent public URLs.

Order-processing emails are optional. Configure all three values to enable delivery:

- `BREVO_API_KEY` - server-side Brevo API key, never exposed to clients
- `EMAIL_FROM` - verified sender, for example `Kubecart <orders@example.com>`
- `FRONTEND_URL` - frontend base URL used in the email tracking link

If any of these values is missing, the API still starts but the email outbox worker is disabled
and no order-processing emails are sent.

## Database

1. Start PostgreSQL.
2. Create a dedicated local development database and least-privilege user.
3. Set `DATABASE_URL` in `.env`.
4. After the Prisma schema is reviewed, generate the client and apply a development migration using commands compatible with the installed Prisma version, typically:

```bash
npx prisma generate
npx prisma migrate dev --name init
```

Never run development reset commands against production or a database containing valuable data. Production deployments should use reviewed migrations, typically `prisma migrate deploy`.

The current migrations include product image storage, the email outbox and order email marker, and the inventory reservation expiry index. Apply all pending migrations before starting the API. Do not apply migrations to production without the normal review and rollout process.

## Run and test

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm run dev
```

The API process also starts two database-backed background workers:

- Email outbox worker - sends queued order-processing emails; disabled unless Brevo is configured.
- Order expiration worker - cancels due unpaid orders and releases expired inventory.

Both workers stop during graceful shutdown. They use conditional database claims, so multiple API instances can run them safely without a separate Redis queue or worker service.

Run the full automated suite:

```bash
npm test
```

Run a focused test file with:

```bash
npx vitest run path/to/test-file.test.js
```

Run the disposable-PostgreSQL integration suite after setting `TEST_DATABASE_URL` to a test-only database:

```bash
npm run test:integration
```

Run a basic load test against a running API:

```bash
npm run load:test -- --url http://localhost:3000/api/v1/health --concurrency 20 --duration 10
```

Check dependencies before release:

```bash
npm run audit
```

Health endpoints:

- `GET /api/v1/health` - liveness
- `GET /api/v1/health/ready` - PostgreSQL readiness (returns `503` when unavailable)

## Product image uploads

Administrators upload images with the protected multipart endpoint:

```text
POST /api/v1/admin/products/:productId/image
```

- File field: `image` (JPEG, PNG, or WebP, maximum 5 MB)
- Optional fields: `isPrimary`, `sortOrder`, `replaceImageId`
- Use `replaceImageId` to atomically replace an existing product image. The old object is removed
  only after the database update succeeds.
- A product can have at most 10 images.
- The object is stored under `products/:productId/` in the configured private bucket.
- Product responses sign stored images for one hour. Existing external HTTP(S) image URLs remain
  supported.

Apply the additive `ProductImage.storagePath` migration before using uploads against a database.
Do not apply migrations to production without the normal review and rollout process.

## Transactional order emails

When an administrator moves a paid order without manual review to `PROCESSING`, the API enqueues an order-processing email in the same database transaction. The email includes the order reference, item snapshots, totals, and a tracking link to `FRONTEND_URL`.

Delivery is handled by a database-backed outbox worker:

- Each order has one processing-email dedupe key, and `Order.processingEmailSentAt` prevents duplicate sends.
- Brevo receives a stable idempotency key so retries do not send the same email twice.
- Failed sends retry up to five attempts with exponential backoff from 30 seconds to 10 minutes.
- Stale `SENDING` jobs are recovered after five minutes.
- If delivery cannot be proven after the 30-minute idempotency window, the job is marked `UNCERTAIN` instead of being resent.

Email is disabled safely when `BREVO_API_KEY`, `EMAIL_FROM`, or `FRONTEND_URL` is missing. The outbox and order marker require additive migrations.

## Automatic unpaid-order expiration

Unpaid orders are cancelled after `INVENTORY_RESERVATION_MINUTES` (default 15). The expiration worker runs every 60 seconds and processes up to 50 due orders per tick.

- Expired orders use the existing `CANCELLED` order and fulfilment statuses and receive explicit automatic-expiration history notes.
- Expired `ACTIVE` reservations become `EXPIRED`, and their stock is restored exactly once.
- The order is claimed with a conditional database update, so payment verification, cancellation, or another worker instance cannot also expire it.
- Paid and manual-review orders are never released by the expiration worker.
- A late successful Paystack payment after cancellation is still recorded as paid with `requiresManualReview = true`; inventory is not automatically reconciled.
- Checkout and reservation stock deductions use conditional database updates to prevent concurrent overselling.
- The additive `InventoryReservation(status, expiresAt)` index supports the expiration sweep.

The worker is safe to run on multiple API instances and stops during graceful shutdown.

## Security

`CORS_ORIGIN` is a comma-separated allowlist. Admin cookie authentication requires an `x-csrf-token` header for state-changing requests. JSON bodies are limited to 10 KB, rate limits apply per route group, and production errors do not expose stack traces. See `docs/RELEASE_READINESS.md` for deployment, backup/restore, and release checklist details.

## Scope

Backend only; no frontend. Paystack is the only payment provider for the MVP. Product image metadata, Supabase Storage binary uploads, Brevo order-processing emails, and automatic unpaid-order expiry are supported. Read `GEMINI.md` and `gemini-rules.md` before implementation.
