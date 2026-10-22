# Kubecart Backend

Backend-only REST API for Kubecart. Built with Node.js, Express, JavaScript ES modules, PostgreSQL, Prisma, and Paystack.

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

## Run and test

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
npm run dev
```

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

## Security

`CORS_ORIGIN` is a comma-separated allowlist. Admin cookie authentication requires an `x-csrf-token` header for state-changing requests. JSON bodies are limited to 10 KB, rate limits apply per route group, and production errors do not expose stack traces. See `docs/RELEASE_READINESS.md` for deployment, backup/restore, and release checklist details.

## Scope

Backend only; no frontend. Paystack is the only payment provider for the MVP. Product images are URL metadata only; binary uploads are out of scope. Read `GEMINI.md` and `gemini-rules.md` before implementation.
