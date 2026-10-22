# Kubecart Agent Progress

> The agent must update this file after every milestone. Do not mark a milestone complete unless the relevant tests were actually run and passed.

## Current state

- Current milestone: 10 - Product image storage
- Status: Milestone 10 implementation complete; migration not applied to the configured remote database; owner review pending
- Last updated: 2026-10-22
- Owner approval to proceed: Pending

## Milestones

| # | Milestone | Status | Test evidence |
|---|---|---|---|
| 1 | Foundation and test infrastructure | Completed | 6 tests passed (health, 404, security headers, requestId, error handling) |
| 2 | Database schema and migrations | Completed | Schema validated & Prisma Client generated successfully |
| 3 | Public product/category APIs | Completed | 9 tests passed (listing, slug lookups, 404s, query validation, sorting/pagination) |
| 4 | Admin authentication and catalogue management | Completed | 14 tests passed (bootstrap, Argon2id auth, rate limiting, protected CRUD, product activation) |
| 5 | Checkout and order creation | Completed | 8 tests passed (guest checkout validation, server subtotal, flat delivery fee, item snapshots, idempotency, order tracking) |
| 6 | Inventory reservations and concurrency | Completed | 6 tests passed (atomic reservations, concurrency protection, expiration restore, cancellation release, late payment reconciliation) |
| 7 | Paystack initialization, verification, webhooks | Completed | 11 tests passed (initialization, verification, webhook handling) |
| 8 | Order administration and fulfilment | Completed | 19 tests passed (auth, list/filter/pagination, privacy, transitions, cancellation, concurrency simulation, rollback) |
| 9 | Hardening and release readiness | Implementation complete; owner review pending | 101 passed, 4 skipped in standard suite; 4 integration tests passed on disposable PostgreSQL; 0 audit vulnerabilities; startup/readiness smoke passed; load test 14,340 requests, 0 errors |
| 10 | Product image storage | Implementation complete; migration not applied to configured remote database; owner review pending | 13 upload/signing tests passed; full suite 114 passed, 4 skipped, 0 failed |

## Decision log

- Language: JavaScript ES modules; no TypeScript.
- Scope: backend API only; no frontend.
- Framework: Express.js.
- File naming convention: dot notation (`category.service.js`, `product.controller.js`, `catalogue.validator.js`, etc.).
- Database: PostgreSQL.
- ORM: Prisma 7, configured with `@prisma/adapter-pg` and `pg`.
- Password hashing: Argon2id via `argon2`.
- Admin authentication: Signed JWT in HttpOnly cookie (`admin_token`) and fallback Bearer header support.
- Admin rate limiting: 5 login attempts per 15-minute window via `express-rate-limit`.
- Delivery pricing: Flat rate of 1,500 NGN (150,000 kobo) configurable via `DEFAULT_DELIVERY_FEE_KOBO`.
- Checkout calculations: Client prices/totals never accepted; calculated server-side from active DB products.
- Order reference: Non-guessable random uppercase hex formatted string (`KBC-XXXXXXXXXXXX`).
- Idempotency: Supported via `Idempotency-Key` header; deduplicates orders safely.
- Validation: Zod.
- Tests: Vitest + Supertest.
- Payment provider: Paystack only.
- Inventory reservations: 15-minute temporary reservation window (`INVENTORY_RESERVATION_MINUTES`).
- Inventory safety: Conditional stock updates inside database transactions prevent overselling. Expired reservations released back to stock exactly once.
- Late payment reconciliation: If stock is still available, re-deducted and fulfilled. If stock is no longer available, order is flagged `requiresManualReview = true` to prevent unfulfillable orders.
- Admin order routes: keyed by public order `reference`; list supports filters, search, and bounded pagination (max 100).
- Fulfilment transitions: `UNFULFILLED -> PROCESSING -> FULFILLED`; cancellation allowed only for unpaid, non-terminal orders. `PROCESSING`/`FULFILLED` require `paymentStatus = PAID` and `requiresManualReview = false`.
- Order history: additive `OrderStatusHistory` model records actual ORDER, PAYMENT, and FULFILLMENT transitions with acting admin and optional note.
- Cancellation atomicity: order claim, conditional reservation release, stock restoration, and history insertion run in one transaction. Repeated/concurrent cancellation cannot restore stock twice.
- Payment idempotency: `Payment.status` is claimed with a conditional `updateMany` so only one concurrent verification/webhook writes success, order transitions, and history.
- Inventory reconciliation idempotency: `Order.inventoryReconciledAt` is claimed atomically; `InventoryReservation` and `InventoryMovement.dedupeKey` provide conditional coverage. Paid-order reconciliation counts CONSUMED reservations, consumes ACTIVE ones, and deducts only the uncovered shortage with a conditional stock update.
- Currency: NGN, amounts stored and verified in kobo.
- Product images: max 10 images per product; metadata URLs must use HTTP(S). Binary uploads use a private Supabase Storage bucket, magic-byte validation for JPEG/PNG/WebP, a 5 MB limit, randomized object keys, and one-hour signed read URLs.
- CORS: explicit comma-separated allowlist in `CORS_ORIGIN`; unlisted browser origins are rejected with `403`.
- CSRF: admin cookie authentication requires a matching `x-csrf-token` header for state-changing requests; Bearer authentication is exempt.
- Rate limits: global API 300/15 min, login 5/15 min, bootstrap 5/hour, checkout 30/15 min, payment 60/15 min. Webhooks are exempt from the global limiter.
- Logging: Pino redacts authorization, cookie, CSRF, Paystack signature, password, token, and Supabase secret-key fields.
- Health: liveness at `/api/v1/health`; PostgreSQL readiness at `/api/v1/health/ready` with a 2-second timeout.
- Shutdown: `SIGTERM`/`SIGINT` stop the HTTP server, disconnect Prisma, drain the PostgreSQL pool, and force exit after 10 seconds.
- Integration tests: require `TEST_DATABASE_URL`; the runner refuses non-test database names and runs migrations before tests.
- Release documentation: `docs/RELEASE_READINESS.md` contains security controls, clean startup, load test, backup/restore, checklist, and known limitations.

## Open questions

- Confirm production hosting, ingress/proxy topology (`TRUST_PROXY`), backup retention, and restore-drill ownership.
- Owner must accept or assign owners for the documented payment/inventory follow-ups before production release.
- Confirm Supabase bucket ownership, retention, orphan-cleanup policy, and whether malware scanning is required before production uploads.

## Milestone reports

### Milestone 10 - Product image storage
- Status: Implementation complete; owner review pending. The additive migration has not been applied to the configured remote database.
- Scope: Authenticated admin product-image uploads to private Supabase Storage, magic-byte validation, size limits, replacement cleanup safety, and signed URL responses for products and categories.
- Files created/changed:
  - `src/config/env.js` (required `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_BUCKET`)
  - `src/utils/supabase.client.js` (lazy server-side Supabase client)
  - `src/services/storage.service.js` (upload, signed URL, delete, and response signing)
  - `src/utils/image.util.js` (JPEG/PNG/WebP magic-byte detection and 5 MB limit)
  - `src/middlewares/upload.middleware.js` (single-file memory multipart parser)
  - `src/validators/admin.validator.js` (product-id, `isPrimary`, `sortOrder`, `replaceImageId` schemas)
  - `src/controllers/admin.controller.js`, `src/routes/admin.routes.js` (`POST /api/v1/admin/products/:productId/image`)
  - `src/services/admin.service.js` (upload/replacement transaction, cleanup, image replacement cleanup)
  - `src/services/product.service.js`, `src/services/category.service.js` (signed image URLs)
  - `src/app.js` (multipart error mapping)
  - `src/utils/logger.js` (Supabase secret-key redaction)
  - `prisma/schema.prisma` and `prisma/migrations/20261022120000_add_product_image_storage_path/migration.sql` (additive `ProductImage.storagePath`)
  - `tests/uploads.test.js` (12 tests)
  - `README.md`, `env.example`, `docs/RELEASE_READINESS.md`
- Dependencies added: `@supabase/supabase-js` and `multer`.
- Database migrations: Additive migration file created; not applied. The configured `DATABASE_URL` points at a remote Supabase PostgreSQL database where all existing migrations are also unapplied, so no migration command was run.
- Commands actually run:
  - Read-only Supabase bucket metadata lookup (confirmed private; no object upload)
  - `npx prisma migrate status` (read-only; confirmed pending migrations)
  - `npx prisma format`
  - `npx prisma validate`
  - `npx prisma generate`
  - `npm install @supabase/supabase-js multer`
  - `npm test -- --run tests/uploads.test.js`
  - `npm test`
- Test results:
  - Focused upload/signing suite: 12 passed, 0 failed.
  - Full standard suite: 113 passed, 4 skipped, 0 failed across 10 passed files and 1 skipped file.
- Security notes:
  - Uploads require `requireAdmin`; cookie-authenticated writes retain CSRF enforcement.
  - File type is derived from magic bytes, not client filename or MIME type.
  - Object keys are randomized under `products/:productId/`.
  - Bucket is private; stored image URLs are signed for one hour on product/category reads.
  - Failed database writes remove the newly uploaded object; replacement objects are removed only after the database update succeeds.
  - Upload responses and logs do not expose the Supabase secret key.
- Known limitations:
  - The `ProductImage.storagePath` migration must be applied through the approved rollout process before uploads work against a real database.
  - No real Supabase upload smoke test was run because the configured project/bucket was not confirmed safe for disposable test objects; storage behavior is covered with mocks.
  - Malware scanning and image transformation are not implemented.
  - Signed URLs expire after one hour; clients must refetch product data to obtain fresh URLs.
- Next proposed milestone: Owner review, apply the additive migration in an approved environment, and run a real upload smoke test against a disposable Supabase project/bucket.

### Milestone 9 — Hardening and release readiness
- Status: Implementation complete; owner release review and sign-off pending.
- Scope: HTTP security controls, CSRF, rate limits, safe errors, log redaction, readiness, graceful shutdown, disposable-PostgreSQL integration tests, load test, and release documentation.
- Files created/changed:
  - `src/config/env.js` (CORS allowlist parsing and `TRUST_PROXY`)
  - `src/config/db.js` (database/pool shutdown helper)
  - `src/app.js` (request logging order, CORS allowlist, global rate limit, readiness check, safe body/error responses)
  - `src/server.js` (structured startup/shutdown logs, database cleanup, unhandled rejection handling)
  - `src/utils/logger.js` (Pino redaction and testable logger factory)
  - `src/utils/csrf.util.js` (double-submit CSRF tokens)
  - `src/middlewares/auth.middleware.js` (Bearer-first auth, cookie-auth CSRF validation)
  - `src/middlewares/rateLimit.middleware.js` (API, bootstrap, checkout, and payment limiters)
  - `src/controllers/admin.controller.js` (CSRF cookie/token issuance and clearing)
  - `src/routes/admin.routes.js`, `src/routes/checkout.routes.js`, `src/routes/payment.routes.js` (route limits and logout CSRF)
  - `src/validators/admin.validator.js` (HTTP(S)-only image metadata URLs)
  - `tests/hardening.test.js` (12 tests)
  - `tests/integration/database.integration.test.js` (4 disposable-PostgreSQL tests)
  - `scripts/run-integration-tests.js` (safe test database preparation and migration runner)
  - `scripts/load-test.js` (dependency-free concurrency/latency load test)
  - `docs/RELEASE_READINESS.md` (security, deployment, backup/restore, checklist, limitations)
  - `README.md`, `env.example`, `package.json` (commands and configuration)
- Dependencies added: None.
- Database migrations: None added; existing migrations applied to disposable `kubecart_test`.
- Commands actually run:
  - `npm audit --omit=dev` (0 vulnerabilities)
  - `npm audit` (0 vulnerabilities)
  - `npx prisma validate`
  - `npm test -- --reporter=dot`
  - `node --input-type=module -e "... TEST_DATABASE_URL=...; import('./scripts/run-integration-tests.js')"`
  - `node scripts/load-test.js --url http://localhost:3101/api/v1/health --concurrency 20 --duration 8`
  - Startup smoke: `node src/server.js` with `PORT=3100`, then health/readiness requests
  - `git diff --check` (no whitespace errors; CRLF warnings only)
- Test results:
  - Standard suite: 101 passed, 0 failed, 4 skipped (integration suite skipped without `TEST_DATABASE_URL`), 9 files passed, 1 skipped.
  - Disposable PostgreSQL: created `kubecart_test`, applied 3 migrations, 4 passed, 0 failed.
  - Integration coverage: schema/index presence, dedupe-key uniqueness, duplicate NULL dedupe keys, conditional stock decrement under concurrency, and order idempotency-key uniqueness.
  - Startup smoke: liveness `ok`, readiness `ready`, database `up`.
  - Load test: 14,340 requests in 8 seconds, 1,792.5 req/s, 0 errors, p50 9.37 ms, p95 21.45 ms, p99 31.08 ms, max 204.65 ms.
  - Audit: 0 vulnerabilities across production and development dependencies.
- Security notes:
  - CORS rejects unlisted origins; configured origins are reflected with credentials enabled.
  - Repeated failed admin logins return `429` after the configured threshold.
  - Cookie-authenticated writes require a matching CSRF header; Bearer writes remain unaffected.
  - Cookie and authorization headers are redacted in request logs.
  - Readiness failures return `503` without leaking database errors.
  - Paystack webhooks are exempt from the global rate limiter to avoid blocking provider retries.
- Known limitations:
  - Binary image uploads are out of scope; only HTTP(S) image metadata URLs are accepted.
  - Payment/inventory crash recovery, expiry-vs-paid-order edge cases, non-success overwrite, multiple successful payments per order, and legacy dedupe conflicts remain documented in `docs/RELEASE_READINESS.md` for owner decision.
  - Graceful shutdown must still be verified in the chosen hosting environment because local Windows process termination cannot exercise POSIX signal handling faithfully.
- Next proposed milestone: None; complete owner release review and resolve or assign the documented follow-ups.

### Milestone 8 — Order administration and fulfilment
- Status: Completed
- Scope: Admin order list/detail, fulfilment transitions, cancellation with stock restoration, and status history.
- Files created/changed:
  - `prisma/schema.prisma` (added `OrderStatusHistory`, `StatusField`, `Order.inventoryReconciledAt`, `InventoryMovement.dedupeKey`, and back-relations)
  - `prisma/migrations/20261021125408_add_order_status_history/migration.sql` (additive migration)
  - `prisma/migrations/20261021133000_payment_inventory_idempotency/migration.sql` (additive idempotency columns/index and safe backfill)
  - `src/validators/order.validator.js` (list, reference, and strict fulfilment-body schemas)
  - `src/services/order.service.js` (filtered list, safe detail projection, atomic transition/cancellation)
  - `src/controllers/order.controller.js` (admin order handlers)
  - `src/routes/admin.routes.js` (mounted `/api/v1/admin/orders`)
  - `src/services/inventory.service.js` (tx-aware conditional reservation release; atomic paid-order reconciliation; conditional expiry claim)
  - `src/services/payment.service.js` (single-winner payment claim; ORDER/PAYMENT history inside the verification transaction; late-payment-on-cancelled handling; duplicate recovery)
  - `tests/orders.test.js` (19 tests)
  - `tests/payment.test.js` (concurrent verification/webhook, duplicate recovery, history, and late-cancellation tests)
  - `tests/inventory.test.js` (mixed reservations, rollback/retry, concurrent expiry, cancelled-order guard, and audit movement tests)
- Dependencies added: None
- Database migrations:
  - `20261021125408_add_order_status_history` applied with `npx prisma migrate dev`; no reset performed.
  - `20261021133000_payment_inventory_idempotency` applied with `npx prisma migrate deploy`; additive only, no reset performed.
- Commands actually run:
  - `npx prisma validate`
  - `npx prisma migrate dev --name add_order_status_history`
  - `npx prisma migrate deploy`
  - `npx prisma generate`
  - `npx vitest run tests/orders.test.js tests/payment.test.js --reporter=dot`
  - `npx vitest run tests/payment.test.js tests/inventory.test.js --reporter=dot`
  - `npx vitest run tests/inventory.test.js --reporter=dot`
  - `npx vitest run tests/payment.test.js --reporter=dot`
  - `npx vitest run --reporter=dot`
- Test results:
  - Focused (orders + payments, before late-payment fix): 30 passed across 2 files.
  - Focused (payments + inventory, after late-payment fix): 20 passed across 2 files.
  - Focused (inventory, after idempotency fix): 12 passed.
  - Focused (payments, after idempotency fix): 16 passed.
  - Full suite: 89 passed across 8 files, 0 failed, 0 skipped.
- Security/payment review:
  - All admin order routes require `requireAdmin`.
  - Admin requests cannot write `paymentStatus` or `requiresManualReview`; strict Zod body rejects extra fields.
  - Payment verification amount/currency/reference checks, webhook signature validation, and idempotency were not weakened.
  - Admin detail excludes `Payment.webhookRaw`; no secrets are returned.
  - Cancellation is limited to unpaid orders; paid cancellation returns 409 until a refund workflow exists.
  - Conditional reservation claims plus the optimistic order claim prevent double stock restoration.
  - A verified payment for a cancelled order is still recorded as `Payment.status = SUCCESS`, sets order `paymentStatus = PAID` and `requiresManualReview = true`, keeps the order cancelled, skips inventory reconciliation, and writes an explanatory payment history note. No automatic refund is attempted.
  - Concurrent duplicate verification or webhook delivery produces one payment transition, one set of order/history rows, and one inventory reconciliation.
  - Reconciliation counts CONSUMED coverage, claims ACTIVE reservations conditionally, and deducts only the shortage with `stock >= shortage`; failures roll back the claim and can be retried safely.
  - Concurrent expiry sweepers claim `ACTIVE -> EXPIRED` conditionally, so stock is restored at most once.
- Known limitations:
  - Concurrency and rollback tests are mock-based simulations; no live-PostgreSQL integration fixture exists yet.
  - Payments received after cancellation require manual refund handling; no refund API exists yet.
  - Failed/abandoned payment attempts are updated on `Payment` but are not written to `OrderStatusHistory`.
  - An `INVENTORY_INSUFFICIENT_STOCK` result is terminal for reconciliation (`inventoryReconciledAt` set, manual review required); resolving it requires a future manual-review/refund endpoint.
- Next proposed milestone: 9 — Hardening and release readiness
- Owner approval: Pending

### Milestone 6 — Inventory Reservations and Concurrency
- Status: Completed
- Files created/changed:
  - `src/services/inventory.service.js` (Stock reservation, conditional decrements, cancellation releases, expiration sweeping, audit movements, and late-payment reconciliation)
  - `src/services/checkout.service.js` (Integrated atomic stock decrement and reservation records during checkout)
  - `tests/inventory.test.js` (Automated tests for reservation lifecycle, expiry restores, cancellation releases, audit movements, and late payment reconciliation)
  - `tests/checkout.test.js` (Updated transaction mock to verify transactional stock reservation)
- Dependencies added: None
- Migrations: None required for this milestone.
- Commands actually run: `npx vitest run tests/inventory.test.js`, `npx vitest run`
- Test results: 43 passed across 5 test files (6 foundation + 9 catalogue + 14 admin + 8 checkout + 6 inventory).
- Security/payment review:
  - Stock is reserved with 15-minute expiration during checkout.
  - Decrements use transactional checks to prevent race condition overselling.
  - Audit trail of stock adjustments tracked in `InventoryMovement` (`SALE`, `RESTOCK`, etc.).
  - Late payments arriving after reservation expiration do not oversell: stock re-verified; if depleted, order is set to `requiresManualReview = true` for merchant refund/reconciliation.
- Known limitations: None.
- Next proposed milestone: 7 — Paystack initialization, verification, webhooks
- Owner approval: Pending

### Milestone 7 — Paystack initialization, verification, webhooks
- Status: Completed
- Files created/changed:
  - `src/utils/paystack.client.js` (Paystack API wrapper with init, verify, webhook signature verification)
  - `src/services/payment.service.js` (Payment orchestration, reference generation, pending record, verification logic, idempotent webhook handling, inventory reconciliation)
  - `src/controllers/payment.controller.js` (Endpoints: `/initialize`, `/verify/:reference`, `/webhook`)
  - `src/routes/payment.routes.js` (Mounted under `/api/v1/payments`)
  - `src/app.js` (added raw‑body capture for Paystack webhook verification)
- Tests added/updated:
  - `tests/payment.test.js` (11 tests covering init, verify success/failure cases, webhook signature validation, duplicate handling, amount/currency mismatches, pending status)
- Dependencies added: none
- Commands actually run:
  - `npx vitest run tests/payment.test.js`
  - `npx vitest run` (full suite)
- Test results: 11 payment tests passed; total 57 tests passed (0 failures)
- Known limitations: None
- Next proposed milestone: 8 — Order administration and fulfilment
- Owner approval: Pending

### Milestone 5 — Checkout and Order Creation
- Status: Completed
- Files created/changed:
  - `src/validators/checkout.validator.js` (Zod schemas for guest checkout requests)
  - `src/services/checkout.service.js` (Server price calculation, order item snapshots, random public references, idempotency check, order lookup)
  - `src/controllers/checkout.controller.js` (Guest checkout handler and public order tracking)
  - `src/routes/checkout.routes.js` (Mounted routes under `/api/v1/checkout`)
  - `src/app.js` (Mounted checkout router)
  - `src/config/env.js` & `env.example` (Added `DEFAULT_DELIVERY_FEE_KOBO`)
  - `tests/checkout.test.js` (Automated tests for validation, server calculations, delivery fee, item snapshots, idempotency, and reference lookup)
- Dependencies added: None
- Migrations: None required for this milestone.
- Commands actually run: `npx vitest run tests/checkout.test.js`, `npx vitest run`
- Test results: 37 passed across 4 test files (6 foundation + 9 catalogue + 14 admin + 8 checkout).
- Security/payment review:
  - Client-submitted prices and totals are strictly ignored; prices retrieved from database at checkout time.
  - Inactive or non-existent products are rejected before order creation.
  - Public order tracking exposes only non-sensitive order status information.
  - Public references are non-guessable.
- Known limitations: None.
- Next proposed milestone: 6 — Inventory reservations and concurrency
- Owner approval: Pending

### Milestone 4 — Admin Authentication and Catalogue Management
- Status: Completed
- Files created/changed:
  - `src/utils/password.util.js` (Argon2id password hashing and verification)
  - `src/utils/token.util.js` (JWT sign & verify utilities)
  - `src/validators/admin.validator.js` (Zod schemas for login, category CRUD, product CRUD)
  - `src/middlewares/auth.middleware.js` (Admin JWT authorization middleware for cookies/Bearer headers)
  - `src/middlewares/rateLimit.middleware.js` (Login rate limiting: 5 requests per 15 minutes)
  - `src/services/admin.service.js` (Bootstrap admin, verify password, category/product CRUD with image sync)
  - `src/controllers/admin.controller.js` (Admin endpoints: bootstrap, login, logout, me, category CRUD, product CRUD & activate/deactivate)
  - `src/routes/admin.routes.js` (Mounted admin router)
  - `src/app.js` (Added cookie-parser and mounted `/api/v1/admin`)
  - `tests/admin.test.js` (14 automated unit and integration tests)
- Dependencies added: `argon2`, `jsonwebtoken`, `cookie-parser`
- Migrations: None required for this milestone.
- Commands actually run: `npm install argon2 jsonwebtoken cookie-parser`, `npx vitest run`
- Test results: 29 passed across 3 test files (6 foundation + 9 catalogue + 14 admin).
- Security/payment review:
  - First-admin bootstrap is guarded against repeated calls (returns 409 if admin exists; no public registration).
  - Passwords hashed with Argon2id.
  - HttpOnly cookies used for session token storage; Bearer header supported.
  - Rate limiting applied to login route.
  - Category and product management endpoints are strictly protected by `requireAdmin`.
- Known limitations: None.
- Next proposed milestone: 5 — Checkout and order creation
- Owner approval: Pending

### Milestone 3 — Public Product and Category APIs
- Status: Completed
- Files created/changed:
  - `src/services/category.service.js` (renamed from `categoryService.js`, uses singleton Prisma from `config/db.js`)
  - `src/services/product.service.js` (renamed from `productService.js`, uses singleton Prisma from `config/db.js`)
  - `src/validators/catalogue.validator.js` (renamed from `catalogueValidator.js`)
  - `src/controllers/category.controller.js` (public category list and slug lookup handlers)
  - `src/controllers/product.controller.js` (public product list with pagination/search/sort and slug lookup)
  - `src/routes/category.routes.js` (Express router for `/api/v1/categories`)
  - `src/routes/product.routes.js` (Express router for `/api/v1/products`)
  - `src/app.js` (mounted category and product routes, added ZodError handling returning 400 Bad Request)
  - `src/config/db.js` (configured PrismaPg driver adapter for Prisma 7)
  - `tests/catalogue.test.js` (automated test suite for catalogue endpoints)
- Dependencies added: `@prisma/adapter-pg` and `pg` (driver adapter required by Prisma 7 runtime to connect to PostgreSQL)
- Migrations: None required for this milestone.
- Commands actually run: `npm install @prisma/adapter-pg pg`, `npx vitest run`
- Test results: 15 passed across 2 test files (6 foundation tests + 9 catalogue tests).
- Security/payment review: Only active products (`isActive: true`) served; pagination bounded to 50 max; monetary price in kobo.
- Known limitations: Live database integration tests depend on a local PostgreSQL instance running.
- Next proposed milestone: 4 — Admin authentication and catalogue management
- Owner approval: Completed

### Milestone 2 — Database Schema & Client
- Status: Completed
- Files created/changed:
  - `prisma/schema.prisma`
  - `prisma.config.ts`
  - `.env`
- Dependencies added: None
- Commands actually run: `npx prisma validate`, `npx prisma generate`
- Test results: Schema validation: Passed; Client generation: Passed (v7.10.1)

### Milestone 1 — Foundation
- Status: Completed
- Files created/changed:
  - `src/app.js`, `src/server.js`, `src/config/env.js`, `src/utils/logger.js`, `tests/foundation.test.js`
- Test results: 6 passed
