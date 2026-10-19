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

Copy `.env.example` to `.env` and update local values:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```bash
# macOS/Linux
cp .env.example .env
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

Once the application files and npm scripts have been implemented:

```bash
npm run dev
npm test
```

Run a focused test file with:

```bash
npx vitest run path/to/test-file.test.js
```

Do not assume scripts or tests exist until they have been added. Follow `gemini-rules.md` for the milestone workflow and exact test gates.

## Scope

Backend only; no frontend. Paystack is the only payment provider for the MVP. Read `GEMINI.md` and `gemini-rules.md` before implementation.
