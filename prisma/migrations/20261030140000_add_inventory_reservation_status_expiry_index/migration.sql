-- Additive index for the scheduled unpaid-order expiration sweep.
CREATE INDEX "InventoryReservation_status_expiresAt_idx" ON "InventoryReservation"("status", "expiresAt");
