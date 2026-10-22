import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
  fail(
    'TEST_DATABASE_URL is required. Point it at a disposable PostgreSQL database whose name contains "test".'
  );
}

let testUrl;
try {
  testUrl = new URL(testDatabaseUrl);
} catch {
  fail('TEST_DATABASE_URL is not a valid PostgreSQL URL.');
}

const databaseName = decodeURIComponent(testUrl.pathname.replace(/^\//, ''));

if (!databaseName || !/^[a-zA-Z0-9_]+$/.test(databaseName)) {
  fail('TEST_DATABASE_URL must use a simple database name containing only letters, numbers, and underscores.');
}

if (!databaseName.toLowerCase().includes('test')) {
  fail('Refusing to run: TEST_DATABASE_URL database name must contain "test".');
}

if (testUrl.pathname === new URL(process.env.DATABASE_URL || 'postgresql://localhost/postgres').pathname) {
  fail('Refusing to run: TEST_DATABASE_URL must not point at DATABASE_URL.');
}

const adminUrl = new URL(testUrl.toString());
adminUrl.pathname = '/postgres';

const client = new pg.Client({ connectionString: adminUrl.toString() });

try {
  await client.connect();
  const existing = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [databaseName]
  );

  if (existing.rowCount === 0) {
    await client.query(`CREATE DATABASE "${databaseName}"`);
    console.log(`Created disposable test database "${databaseName}".`);
  }
} catch (error) {
  fail(`Could not prepare the disposable test database: ${error.message}`);
} finally {
  await client.end().catch(() => {});
}

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const useShell = process.platform === 'win32';
const baseEnv = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  TEST_DATABASE_URL: testDatabaseUrl,
};

const migrate = spawnSync(
  executable,
  ['prisma', 'migrate', 'deploy'],
  { env: baseEnv, stdio: 'inherit', shell: useShell }
);

if (migrate.status !== 0) {
  fail('prisma migrate deploy failed for the disposable test database.');
}

const tests = spawnSync(
  executable,
  ['vitest', 'run', 'tests/integration', '--reporter=dot'],
  { env: baseEnv, stdio: 'inherit', shell: useShell }
);

process.exit(tests.status ?? 1);
