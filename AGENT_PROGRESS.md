# Kubecart Agent Progress

> The agent must update this file after every milestone. Do not mark a milestone complete unless the relevant tests were actually run and passed.

## Current state

- Current milestone: 7 — Paystack initialization, verification, webhooks
- Status: Milestone 6 complete
- Last updated: 2026-10-19
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
| 7 | Paystack initialization, verification, webhooks | Not started | Not run |
| 8 | Order administration and fulfilment | Not started | Not run |
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
- Currency: NGN, amounts stored and verified in kobo.
- Product images: max 10 images per product.

## Open questions

- Confirm production hosting and backup requirements.

## Milestone reports

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
