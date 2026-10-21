-- Additive payment/inventory idempotency fields.
ALTER TABLE "Order" ADD COLUMN "inventoryReconciledAt" TIMESTAMP(3);

ALTER TABLE "InventoryMovement" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "InventoryMovement_dedupeKey_key" ON "InventoryMovement"("dedupeKey");

-- Mark orders that already completed inventory reconciliation (or need none)
-- so retries do not reprocess them. Paid orders with no reconciliation
-- evidence remain NULL and can be repaired by the recovery path.
UPDATE "Order" AS o
SET "inventoryReconciledAt" = CURRENT_TIMESTAMP
WHERE o."status" = 'CANCELLED'
   OR o."fulfillmentStatus" = 'CANCELLED'
   OR (
        o."paymentStatus" = 'PAID'
        AND (
             EXISTS (
                 SELECT 1
                 FROM "InventoryMovement" AS m
                 WHERE m."reference" = o."id"
                   AND m."type" = 'SALE'
             )
             OR EXISTS (
                 SELECT 1
                 FROM "InventoryReservation" AS r
                 WHERE r."orderId" = o."id"
                   AND r."status" = 'CONSUMED'
             )
        )
   );
