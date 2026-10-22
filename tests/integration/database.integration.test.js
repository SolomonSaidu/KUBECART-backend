import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIntegration = testDatabaseUrl ? describe : describe.skip;

describeIntegration('Disposable PostgreSQL integration checks', () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 4 });
  const createdCategoryIds = [];
  const createdProductIds = [];
  const createdOrderIds = [];

  beforeAll(async () => {
    await pool.query('SELECT 1');
  });

  afterEach(async () => {
    if (createdCategoryIds.length > 0) {
      await pool.query(
        'DELETE FROM "InventoryMovement" WHERE "productId" = ANY($1::text[])',
        [createdProductIds]
      );
      await pool.query(
        'DELETE FROM "Order" WHERE "id" = ANY($1::text[])',
        [createdOrderIds]
      );
      await pool.query(
        'DELETE FROM "Product" WHERE "id" = ANY($1::text[])',
        [createdProductIds]
      );
      await pool.query(
        'DELETE FROM "Category" WHERE "id" = ANY($1::text[])',
        [createdCategoryIds]
      );
    }

    createdCategoryIds.length = 0;
    createdProductIds.length = 0;
    createdOrderIds.length = 0;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createProduct(stock = 1) {
    const categoryId = randomUUID();
    const productId = randomUUID();
    const suffix = randomUUID();

    createdCategoryIds.push(categoryId);
    createdProductIds.push(productId);

    await pool.query(
      'INSERT INTO "Category" ("id", "name", "slug", "updatedAt") VALUES ($1, $2, $3, NOW())',
      [categoryId, `Category ${suffix}`, `category-${suffix}`]
    );
    await pool.query(
      `INSERT INTO "Product"
        ("id", "categoryId", "name", "slug", "description", "priceKobo", "stock", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        productId,
        categoryId,
        `Product ${suffix}`,
        `product-${suffix}`,
        'Integration test product',
        1000,
        stock,
      ]
    );

    return productId;
  }

  it('applies all migrations to a clean disposable database', async () => {
    const result = await pool.query(
      `SELECT
         to_regclass('"Order"') AS orders,
         to_regclass('"InventoryMovement"') AS movements,
         to_regclass('"InventoryMovement_dedupeKey_key"') AS movement_dedupe_index`
    );

    expect(result.rows[0].orders).not.toBeNull();
    expect(result.rows[0].movements).not.toBeNull();
    expect(result.rows[0].movement_dedupe_index).not.toBeNull();
  });

  it('enforces the inventory movement dedupe key under real PostgreSQL concurrency', async () => {
    const productId = await createProduct(5);
    const dedupeKey = `sale:${randomUUID()}`;

    await pool.query(
      `INSERT INTO "InventoryMovement"
        ("id", "productId", "quantity", "type", "dedupeKey")
       VALUES ($1, $2, -1, 'SALE', $3)`,
      [randomUUID(), productId, dedupeKey]
    );

    await expect(
      pool.query(
        `INSERT INTO "InventoryMovement"
          ("id", "productId", "quantity", "type", "dedupeKey")
         VALUES ($1, $2, -1, 'SALE', $3)`,
        [randomUUID(), productId, dedupeKey]
      )
    ).rejects.toMatchObject({ code: '23505' });

    await expect(
      pool.query(
        `INSERT INTO "InventoryMovement"
          ("id", "productId", "quantity", "type", "dedupeKey")
         VALUES ($1, $2, -1, 'SALE', NULL),
                ($3, $2, -1, 'SALE', NULL)`,
        [randomUUID(), productId, randomUUID()]
      )
    ).resolves.toBeDefined();
  });

  it('prevents overselling with a conditional stock decrement', async () => {
    const productId = await createProduct(1);

    const decrement = () =>
      pool.query(
        `UPDATE "Product"
         SET "stock" = "stock" - 1
         WHERE "id" = $1 AND "stock" >= 1
         RETURNING "stock"`,
        [productId]
      );

    const results = await Promise.all([decrement(), decrement()]);
    const updatedRows = results.reduce(
      (total, result) => total + result.rowCount,
      0
    );

    expect(updatedRows).toBe(1);

    const persisted = await pool.query(
      'SELECT "stock" FROM "Product" WHERE "id" = $1',
      [productId]
    );
    expect(persisted.rows[0].stock).toBe(0);
  });

  it('enforces unique order idempotency keys and permits multiple NULL keys', async () => {
    const idempotencyKey = `idem-${randomUUID()}`;
    const insertOrder = (id, key) =>
      pool.query(
        `INSERT INTO "Order"
          ("id", "reference", "email", "phone", "shippingAddress",
           "subtotalKobo", "deliveryFeeKobo", "totalKobo", "idempotencyKey", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 1000, 0, 1000, $6, NOW())`,
        [id, `KBC-${randomUUID()}`, 'test@example.com', '+2348000000000', 'Test address', key]
      );

    const firstOrderId = randomUUID();
    const secondOrderId = randomUUID();
    createdOrderIds.push(firstOrderId, secondOrderId);

    await insertOrder(firstOrderId, idempotencyKey);
    await expect(insertOrder(secondOrderId, idempotencyKey)).rejects.toMatchObject({
      code: '23505',
    });

    const nullKeyOrderOne = randomUUID();
    const nullKeyOrderTwo = randomUUID();
    createdOrderIds.push(nullKeyOrderOne, nullKeyOrderTwo);

    await expect(insertOrder(nullKeyOrderOne, null)).resolves.toBeDefined();
    await expect(insertOrder(nullKeyOrderTwo, null)).resolves.toBeDefined();
  });
});
