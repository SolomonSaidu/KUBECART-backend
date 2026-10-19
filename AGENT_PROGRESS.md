# Kubecart Agent Progress

> The agent must update this file after every milestone. Do not mark a milestone complete unless the relevant tests were actually run and passed.

## Current state

- Current milestone: 1 — Foundation
- Status: Not started
- Last updated: Not started
- Owner approval to proceed: Pending

## Milestones

| # | Milestone | Status | Test evidence |
|---|---|---|---|
| 1 | Foundation and test infrastructure | Not started | Not run |
| 2 | Database schema and migrations | Not started | Not run |
| 3 | Public product/category APIs | Not started | Not run |
| 4 | Admin authentication and catalogue management | Not started | Not run |
| 5 | Checkout and order creation | Not started | Not run |
| 6 | Inventory reservations and concurrency | Not started | Not run |
| 7 | Paystack initialization, verification, webhooks | Not started | Not run |
| 8 | Order administration and fulfilment | Not started | Not run |
| 9 | Hardening and release readiness | Not started | Not run |

## Decision log

- Language: JavaScript ES modules; no TypeScript.
- Scope: backend API only; no frontend.
- Framework: Express.js.
- Database: PostgreSQL.
- ORM: Prisma, configured for the installed version.
- Validation: Zod.
- Tests: Vitest + Supertest.
- Payment provider: Paystack only.
- Inventory: temporary reservations are planned; owner must approve reservation expiry and late-payment policy.
- Delivery pricing: requires owner confirmation before checkout implementation.
- Currency: must be explicitly agreed; if NGN, store and verify amounts in kobo.

## Open questions

- Confirm delivery-fee calculation and supported delivery areas.
- Confirm currency (likely NGN, but must be explicitly configured).
- Approve reservation expiry and policy for late successful payments.
- Confirm admin session/authentication approach.
- Confirm product image storage provider and credentials before upload implementation.
- Confirm production hosting and backup requirements.

## Milestone report template

### Milestone:
### Status:
### Files created/changed:
### Dependencies added:
### Migrations:
### Commands actually run:
### Test results:
- Passed:
- Failed:
- Skipped:
### Security/payment review:
### Known limitations:
### Open decisions:
### Next proposed milestone:
### Owner approval:
