# Release Readiness

This checklist covers Milestone 9 hardening for the Kubecart backend. It must be reviewed by the owner before production release.

## Release scope

- Backend REST API only. No frontend is included.
- Product images support validated HTTP(S) URL metadata and private Supabase Storage uploads. Uploads use magic-byte and size validation, randomized object keys, and signed read URLs. Malware scanning and image transformation remain out of scope.
- Paystack remains the only payment provider. Production live keys require explicit owner approval.

## Security controls

- Helmet security headers are enabled.
- CORS uses an explicit comma-separated allowlist in `CORS_ORIGIN`. Wildcard origins are not supported with credentials.
- JSON request bodies are limited to 10 KB. Oversized and malformed bodies return safe `413` and `400` responses.
- Global API rate limits apply to `/api/v1`; stricter limits apply to login, bootstrap, checkout, and payment routes. Paystack webhooks are excluded from the global limiter so provider retries are not blocked.
- Admin login is limited to 5 attempts per 15 minutes per IP.
- Admin cookie authentication uses HttpOnly, SameSite=Lax cookies and requires a matching `x-csrf-token` header for state-changing requests. Bearer-token requests do not require CSRF.
- Admin bootstrap is not public registration. Run bootstrap only from a trusted network immediately after initial deployment, or use the documented seed procedure.
- Production `500` responses do not expose stack traces or internal error messages.
- Pino redacts authorization, cookie, CSRF, Paystack signature, password, and token fields from structured logs.
- Run `npm run audit` and resolve or document every critical/high advisory before release.

## Runtime configuration

Required environment variables:

- `NODE_ENV=production`
- `PORT`
- `LOG_LEVEL`
- `DATABASE_URL`
- `CORS_ORIGIN` (comma-separated origins)
- `SESSION_SECRET` (at least 32 random characters)
- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_PUBLIC_KEY`
- `INVENTORY_RESERVATION_MINUTES`
- `DEFAULT_DELIVERY_FEE_KOBO`

Set `TRUST_PROXY=true` only when the API is behind a trusted reverse proxy that sets `X-Forwarded-For`. Do not enable it for direct internet traffic.

Set `TEST_DATABASE_URL` only for disposable integration tests. Its database name must contain `test`.

## Health checks

- `GET /api/v1/health` is a liveness check and does not touch the database.
- `GET /api/v1/health/ready` checks PostgreSQL with a 2-second timeout and returns `503` when the database is unavailable.

Use readiness for load-balancer routing and liveness for process supervision.

## Graceful shutdown

The server handles `SIGTERM`, `SIGINT`, `unhandledRejection`, and `uncaughtException`. Shutdown stops accepting connections, closes idle connections, disconnects Prisma, drains the PostgreSQL pool, and exits. A 10-second timeout forces exit if cleanup hangs.

## Clean-environment startup

Use a disposable or reviewed database. Never run reset commands against production.

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm start
```

Verify:

```bash
curl http://localhost:3000/api/v1/health
curl http://localhost:3000/api/v1/health/ready
```

## Automated checks

```bash
npm test
npm run test:integration
npm run audit
```

`npm run test:integration` requires `TEST_DATABASE_URL`. It refuses to run unless the target database name contains `test` and is different from `DATABASE_URL`. The script creates the database if the current role permits it, runs `prisma migrate deploy`, then executes the integration tests.

## Load test

Start the API, then run:

```bash
npm run load:test -- --url http://localhost:3000/api/v1/health --concurrency 20 --duration 10
```

The script reports request count, errors, status distribution, and p50/p95/p99 latency. Record the result with the release evidence. A health-endpoint load test validates process and HTTP capacity only; run a separate, approved test against read-only catalogue endpoints for database-path capacity.

## Backup and restore

Use PostgreSQL-native tools with credentials supplied through the environment, not shell history.

Backup:

```bash
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" > kubecart-$(date +%Y%m%d-%H%M%S).dump
```

Restore into a disposable database first:

```bash
createdb kubecart_restore_test
pg_restore --clean --if-exists --no-owner --no-acl --dbname kubecart_restore_test kubecart-YYYYMMDD-HHMMSS.dump
psql kubecart_restore_test -c 'SELECT COUNT(*) FROM "Order";'
```

After validation, restore production using the owner-approved maintenance procedure. Never restore over a live production database without a verified backup and explicit approval.

Recommended retention:

- Daily full backups retained for at least 14 days.
- Weekly full backups retained for at least 8 weeks.
- Encrypted off-site copies.
- Restore drill at least quarterly.

## Release checklist

- [ ] Owner approves release scope and Paystack live-key use.
- [ ] Production secrets are set outside the repository.
- [ ] `CORS_ORIGIN` contains only trusted frontend origins.
- [ ] `TRUST_PROXY` matches the hosting topology.
- [ ] `npm ci` and `npx prisma migrate deploy` succeed from a clean environment.
- [ ] `npm test` passes.
- [ ] `npm run test:integration` passes against a disposable database.
- [ ] `npm run audit` has no undocumented critical/high findings.
- [ ] Health and readiness checks pass through the production ingress.
- [ ] Graceful shutdown is verified in the hosting environment.
- [ ] Backup completed and a restore drill passed.
- [ ] Load-test result recorded.
- [ ] Logs are collected without credentials or customer payloads.
- [ ] Known limitations below are accepted or assigned an owner.

## Known limitations and follow-ups

These are documented risks from the payment/inventory review. None are hidden by this hardening pass.

- High: A process crash after payment commit but before inventory reconciliation leaves a paid order with `inventoryReconciledAt = NULL`. A duplicate verification/webhook can recover it, but there is no scheduled background recovery job. Mitigation: monitor paid orders with `inventoryReconciledAt = NULL` and retry reconciliation before release.
- Medium: The expiry sweeper does not exclude paid orders. Reconciliation normally corrects stock by deducting the resulting shortage, but the crash window above can leave stock temporarily restored. Mitigation: add paid-order exclusion and a recovery job in the next correctness milestone.
- Medium: Expiry and cancellation are claimed conditionally, but reconciliation across multiple products is not a single serialized order-level lock under every interleaving. Live-PostgreSQL tests cover the core conditional updates; add adversarial multi-product concurrency tests before high-volume launch.
- Medium: Non-success verification paths can overwrite a concurrently successful payment status with `FAILED` or `ABANDONED`. Mitigation: add a conditional non-success update that never overwrites `SUCCESS`, plus a recovery test.
- Medium: The schema does not prevent multiple successful payment attempts for the same order. Mitigation: add a database-level invariant or enforce one successful payment per order in the payment service.
- Low: `dedupeKey` conflicts on inconsistent legacy data can permanently fail a retry. Reconcile historical movements before enabling the recovery job.
- Low: `releaseReservation` is read-then-write but is not used by production flows. Remove it or convert it to the conditional pattern before reuse.
- Test coverage: most service tests use mocked Prisma calls. The disposable-PostgreSQL suite covers migrations, unique constraints, idempotency keys, dedupe keys, and conditional stock decrement, but not every payment/inventory interleaving.
- Scope: binary image uploads are limited to JPEG, PNG, and WebP under 5 MB, validated by magic bytes with randomized private-bucket object keys. Add malware scanning and image transformation before accepting untrusted, high-volume uploads. The configured bucket is private and signed URLs expire after one hour.
