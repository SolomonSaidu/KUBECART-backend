# Kubecart Backend — Project Brief

## Project identity

**Project:** Kubecart  
**Component:** Backend API only  
**Status:** MVP development  
**Language:** Pure JavaScript (ES modules). **Do not use TypeScript.**  
**Runtime/framework:** Node.js LTS + Express.js  
**Database:** PostgreSQL  
**ORM:** Prisma  
**Payments:** Paystack only

## What Kubecart is

Kubecart is an e-commerce website for a business to sell products online. This repository contains only the backend. There is no frontend in scope yet. The backend must expose a documented REST API that a future storefront and admin dashboard can consume.

Customers must eventually be able to browse products, check out as guests, pay through Paystack, and receive an order reference/status. Authorized administrators must be able to manage products, categories, stock, and order fulfilment.

## Goals

1. Build a reliable, secure, testable REST API.
2. Support product and category browsing, search, filtering, and pagination.
3. Support guest checkout without customer accounts.
4. Calculate prices, delivery fees, and totals on the server.
5. Integrate Paystack safely: initialize payments server-side, verify transactions server-side, and process authenticated webhooks idempotently.
6. Keep payment state, order state, and fulfilment state distinct.
7. Protect stock from overselling using database transactions and temporary reservations.
8. Provide protected admin authentication and endpoints for product, category, inventory, order, and payment management.
9. Include automated tests at every implementation milestone.
10. Provide clear setup, migration, testing, deployment, and recovery documentation.

## Required stack

- Node.js LTS
- Express.js
- JavaScript ES modules; `"type": "module"` in `package.json`
- PostgreSQL
- Prisma ORM, using setup and client-generation instructions matching the installed Prisma version
- Zod for request and environment validation
- Vitest and Supertest for automated tests
- Paystack as the only payment provider in the MVP
- Pino or another agreed structured logger
- Helmet and explicitly configured CORS
- Product image storage may use Supabase Storage or another client-approved object store; do not store large image files in PostgreSQL.

Do not add TypeScript, a frontend, MongoDB, Redis, queues, microservices, or a second payment provider unless the project owner explicitly approves the change.

## Architectural approach

Use a modular monolith: one Express application with clearly separated feature modules. Keep route handlers thin, put business rules in services, validate all external input, and keep database access organized.

Suggested modules:
- auth/admins
- products
- categories
- checkout
- orders
- payments
- inventory
- uploads

Use `/api/v1` as the REST API prefix. Use migrations for schema changes. Do not reset or destroy a database containing data.

## Core data concepts

The schema will likely include:
- Admin
- Category
- Product
- ProductImage
- Order
- OrderItem (including product name and unit-price snapshots)
- Payment
- InventoryMovement
- InventoryReservation (or equivalent reservation fields/model)

Use foreign keys, appropriate unique constraints, indexes, and database transactions. Store money in integer minor units (kobo for NGN) or an appropriate exact decimal type. Never use JavaScript floating-point arithmetic for money. Persist currency explicitly.

## Payment and inventory invariants

- Never trust client-submitted prices, subtotals, delivery fees, totals, payment statuses, or stock availability.
- The server retrieves current product prices and calculates the payable amount.
- A browser redirect or frontend success message is not proof of payment.
- Verify Paystack transactions server-side and check the expected reference, amount, currency, and successful status.
- Validate Paystack webhook signatures using the exact raw request body and the documented signature method.
- Handle duplicate webhooks and retry requests idempotently.
- Do not mark an order paid before independent verification.
- Keep payment status separate from fulfilment status.
- Reserve stock for a documented, configurable period during checkout; release expired/failed reservations safely.
- Define and test the late-payment-after-reservation-expiry scenario. Never silently fulfil an order that cannot be supplied.
- Use database concurrency controls and transactions to prevent overselling.
- Do not hold a database transaction open while waiting for a network request to Paystack.

## Out of scope for this MVP

- Frontend/storefront/admin UI
- Customer accounts and profiles
- Multiple payment providers
- Courier integrations/live tracking
- Loyalty, reviews, referrals, personalized recommendations
- Microservices and premature distributed infrastructure

## Definition of done

A milestone is complete only when:
1. Its code is implemented in the agreed scope.
2. Relevant automated tests were actually run and passed.
3. Existing tests still pass.
4. The agent reports files changed, commands run, results, and remaining limitations.
5. Documentation and `AGENT_PROGRESS.md` are updated.
6. The owner has reviewed and approved the milestone before the next begins.

See `gemini-rules.md` for mandatory implementation and agent-workflow rules. See `README.md` for setup commands.
