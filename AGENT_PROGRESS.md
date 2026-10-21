# Kubecart Agent Progress

> The agent must update this file after every milestone. Do not mark a milestone complete unless the relevant tests were actually run and passed.

## Current state

- Current milestone: 9 — Hardening and release readiness
- Status: Milestone 8 complete; payment/inventory consistency hardening applied
- Last updated: 2026-10-21
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
| 9 | Hardening and release readiness | Not started | Not run |

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
- Product images: max 10 images per product.

## Open questions

- Confirm production hosting and backup requirements.

## Milestone reports

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
