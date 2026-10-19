# Kubecart Agent Rules — Mandatory Workflow

These rules apply to every AI agent working in this repository. Read `GEMINI.md` and this file before making changes.

## 1. Non-negotiable rules

1. Use **pure JavaScript ES modules only**. Do not create `.ts` or `.tsx` files, add TypeScript, or convert the project to TypeScript.
2. This repository is **backend only**. Do not build frontend pages, React components, or UI assets.
3. Use Express, PostgreSQL, Prisma, Zod, Vitest, Supertest, and Paystack only for payments unless the owner approves a change.
4. Do not implement multiple milestones in one large unreviewed change.
5. Do not claim tests passed unless you ran them and observed the result.
6. Do not skip tests to save time. Every implementation step must have tests, and the relevant tests must pass before proceeding.
7. Do not invent business policies. If a decision is missing, document the question and propose a conservative default for owner approval.
8. Never expose secrets, customer personal data, stack traces, or payment credentials in logs or API responses.
9. Never run destructive database commands against a database with user data. Do not use `prisma migrate reset` except against a disposable local test database with explicit approval.
10. Do not make unrelated refactors or add dependencies without explaining why.

## 2. Mandatory workflow for every task

For each milestone or requested change:

1. Read `GEMINI.md`, `gemini-rules.md`, `README.md`, and `AGENT_PROGRESS.md`.
2. Inspect the existing repository, `package.json`, Prisma version, schema, migrations, and tests before editing.
3. State the task goal, assumptions, files expected to change, and tests to add/run.
4. If a critical business rule is unclear, stop and ask the owner or record the unresolved decision instead of silently guessing.
5. Implement only the approved step.
6. Add or update automated tests for the behavior and relevant failure cases.
7. Run the focused tests, then the full test suite when practical.
8. Fix failures caused by the change and rerun the tests. Do not hide failures, weaken assertions, or delete tests merely to get a green result.
9. Inspect the diff for unrelated changes, secrets, unsafe SQL, logging of sensitive data, and generated files.
10. Update documentation and `AGENT_PROGRESS.md` with the result, exact commands, test totals, known gaps, and next milestone.
11. Report what changed, what was tested, actual results, and anything not verified.
12. Wait for owner review/approval before starting the next milestone.

A step is **not complete** if tests were not run or any required test is failing.

## 3. Prerequisites and installation

### Prerequisites

- Install a currently supported Node.js LTS release from the official Node.js website. Confirm installation with `node --version` and `npm --version`.
- Install PostgreSQL locally or use an approved managed PostgreSQL database. Ensure the database is running and create a dedicated development database and user.
- Use Git and the repository's agreed package manager. This project defaults to npm.
- Obtain Paystack test keys only when the payment milestone begins. Never put live keys in development or tests.
- If it already exist skip it.

### Bootstrap commands

Run these from the repository root. If a repository or `package.json` already exists, inspect it first and do not overwrite existing work.

```bash
npm init -y
npm pkg set type=module
npm install express dotenv zod @prisma/client helmet cors pino pino-http express-rate-limit
npm install -D prisma vitest supertest
```

Initialize Prisma only if the project has not already been initialized:

```bash
npx prisma init
```

**Prisma version rule:** Before setup, inspect `npx prisma --version` and the installed Prisma documentation. Recent Prisma versions may require a different generator, client adapter, or configuration from older tutorials. Choose a compatible Prisma/PostgreSQL setup, document the choice, and follow the official instructions for that exact version. Do not mix examples from incompatible Prisma versions. Install any required PostgreSQL driver/adapter only after verifying it is required for the selected version.

Add scripts appropriate to the installed dependencies, for example:

```json
{
  "scripts": {
    "dev": "node --watch src/server.js",
    "start": "node src/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:deploy": "prisma migrate deploy",
    "db:studio": "prisma studio"
  }
}
```

Adjust Prisma commands only if the installed version requires it; document any difference. Do not overwrite an existing `package.json` without reviewing it.

Create `.env` from `.env.example`, then configure a local PostgreSQL URL. Never commit `.env`.

```bash
# Windows PowerShell
Copy-Item .env.example .env

# macOS/Linux
cp .env.example .env
```

After the schema is approved, run the documented migration and client-generation commands. Do not run migrations against production during development.

## 4. Required implementation order

Implement one milestone at a time and follow the test gate after each one.

### Milestone 1 — Foundation

- Establish the JavaScript ES-module project and scripts.
- Create `app.js` (Express configuration) and `server.js` (process startup).
- Add environment validation, JSON body limits, Helmet, explicit CORS, structured logging, request IDs, not-found handling, and centralized error handling.
- Add `/api/v1/health`.
- Keep app construction separate from listening so Supertest can import the app without opening a network port.
- Tests: health response, unknown route, malformed input/error response, environment validation, and app import without listening.
- Gate: run all tests and confirm the server starts locally.

### Milestone 2 — Database and schema

- Design Admin, Category, Product, ProductImage, Order, OrderItem, Payment, InventoryMovement, and InventoryReservation (or a documented equivalent).
- Use constraints, indexes, foreign keys, and explicit status fields.
- Store prices safely and snapshot purchased product name and unit price in OrderItem.
- Add migrations and seed only safe development data.
- Tests: schema/migration succeeds on a disposable test database; constraints and core data relationships work.
- Gate: migration and tests pass. Never reset a non-disposable database.

### Milestone 3 — Catalogue APIs

- Add category and active-product listing, details, search/filter, and bounded pagination.
- Validate query parameters with Zod.
- Do not expose inactive products through public endpoints.
- Tests: success, empty results, pagination boundaries, invalid query, unknown slug, inactive product, and database failure handling.
- Gate: focused and full test suite pass.

### Milestone 4 — Admin authentication and catalogue management

- Provide a secure first-admin bootstrap/seed procedure; no public admin registration.
- Hash passwords using Argon2id or another owner-approved modern password hash.
- Use secure HTTP-only cookies/sessions for a browser admin client, or document and implement a reviewed alternative. If cookie auth is used, add appropriate CSRF protection.
- Apply login rate limiting and enforce authorization on every admin endpoint.
- Add product/category create, update, deactivate, and safe image metadata management.
- Tests: correct login, wrong password, validation errors, rate limiting, missing auth, forbidden actions, and CRUD authorization.
- Gate: all relevant tests pass; no secrets in repository.

### Milestone 5 — Checkout and order creation

- Accept product IDs, quantities, customer contact details, and delivery details; do not accept authoritative prices or totals from the client.
- Fetch current products and calculate subtotal, delivery fee, total, and currency on the server.
- Define delivery-fee rules with the owner before implementation.
- Create order and item snapshots atomically; use a unique, non-guessable public reference.
- Add idempotency to avoid duplicate orders on retry. Define the idempotency key format, scope, storage, and replay behavior.
- Tests: invalid customer details, missing/inactive products, invalid quantities, manipulated client totals, delivery calculation, duplicate requests, and transaction rollback.
- Gate: all tests pass; no payment can be assumed successful at this stage.

### Milestone 6 — Inventory reservations

- Implement temporary reservations with a documented expiry duration.
- Use transactions and concurrency controls (for example, conditional stock updates or row locking supported by the chosen approach) to prevent overselling.
- Release expired/failed reservations exactly once.
- Keep an inventory movement/audit record for stock changes.
- Define late Paystack success after reservation expiry before coding that scenario. Do not automatically fulfil an order without available stock.
- Tests: concurrent attempts to buy the last unit, reservation expiry, repeated release, cancellation/failure, and late-payment handling.
- Gate: concurrency tests pass against PostgreSQL, not only mocked database calls.

### Milestone 7 — Paystack integration

- Use **Paystack only**. Use test keys for development and test mode first.
- Store `PAYSTACK_SECRET_KEY` only on the backend in environment configuration.
- Initialize a transaction server-side with the server-calculated amount, currency, customer email where required, and a unique reference tied to the order.
- Persist the pending payment and reference before relying on callbacks. Handle provider/network failures and retries safely.
- Verify a transaction through Paystack's server-side verification endpoint. Check exact expected reference, amount in minor units, currency, and successful provider status before marking paid.
- Validate webhook signatures using the exact raw request body and Paystack's documented HMAC-SHA512 method with the secret key. Configure the raw-body route before JSON parsing for that webhook endpoint, without accidentally changing parsing for other routes.
- Treat webhooks as at-least-once: duplicate events must be safe. Verify transaction state with Paystack when required; do not trust arbitrary fields or a browser redirect.
- Update payment/order/inventory state transactionally and exactly once after verification.
- Do not call Paystack while holding a long-running database transaction.
- Never log secret keys, full webhook payloads containing sensitive data, or credentials.
- Tests must cover: successful verification; wrong reference; wrong amount; wrong currency; failed/pending transaction; invalid signature; duplicate webhook; out-of-order events; provider timeout; verification API failure; replayed requests; and late payment after reservation expiry.
- Use mocked provider responses for routine automated tests and a separate explicit sandbox integration test with test credentials. Never run real charges in automated tests.
- Gate: all payment tests pass and a sandbox flow is manually verified. No live payment keys until owner approval.

### Milestone 8 — Order administration and fulfilment

- Add order list/search/filter and order detail endpoints with pagination.
- Keep payment status distinct from fulfilment status.
- Enforce valid state transitions and authorization.
- Record status changes and inventory adjustments.
- Limit public order status responses to non-sensitive information.
- Tests: allowed/disallowed transitions, unauthorized access, privacy, pagination, and repeated actions.
- Gate: all tests pass.

### Milestone 9 — Hardening and release readiness

- Add upload validation/storage protections if image uploads are in scope.
- Add security headers, CORS allowlist, rate limits, payload limits, safe error responses, and dependency audit.
- Add structured logging, health checks, graceful shutdown, and documented backup/restore procedures.
- Run tests against a disposable test database and run a basic load test.
- Test migration and startup from a clean environment using documented commands.
- Tests: full suite, critical integration tests, security checks, and restore procedure where feasible.
- Gate: no known critical/high-risk issue left undocumented; owner reviews release checklist.

## 5. Paystack-specific prohibitions

**Never:**

- Trust the frontend redirect, query string, screenshot, or client-submitted status as proof of payment.
- Mark an order paid just because transaction initialization succeeded.
- Expose the Paystack secret key to a browser or include it in an API response.
- Accept an amount supplied by the client as authoritative.
- Skip reference, amount, currency, or status verification.
- Process a webhook without validating its signature.
- Fulfil an order twice because a webhook was retried.
- assume a webhook arrives exactly once or in order.
- silently treat a network timeout as payment failure or payment success; represent uncertainty and verify safely.
- make live charges in automated tests.

## 6. General coding rules

- Use clear JavaScript names and small, focused functions.
- Use async/await and pass asynchronous errors to centralized Express error handling.
- Validate all untrusted input at the API boundary.
- Keep controllers thin and business logic in services.
- Keep secrets out of Git; update `.env.example` with names and safe placeholders only.
- Do not log passwords, tokens, payment secrets, or unnecessary personal data.
- Do not disable or weaken tests to make a build pass.
- Do not use `any` (TypeScript-specific) or add TypeScript tooling.
- Do not add Redis, queues, a second database, microservices, or another payment provider without owner approval.
- Do not change API contracts or business rules silently; document and review changes.

## 7. Final report format

At the end of every milestone, report:

- **Milestone and scope**
- **Files created/changed**
- **Dependencies added and why**
- **Database migrations**
- **Commands actually run**
- **Test results** (pass/fail counts and any skipped tests)
- **Security/payment considerations**
- **Known limitations or unresolved questions**
- **Updated `AGENT_PROGRESS.md`**
- **Recommended next step** (do not start it until approval)
