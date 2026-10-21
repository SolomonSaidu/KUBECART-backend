-- CreateEnum
CREATE TYPE "StatusField" AS ENUM ('ORDER', 'PAYMENT', 'FULFILLMENT');

-- CreateTable
CREATE TABLE "OrderStatusHistory" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "adminId" TEXT,
    "field" "StatusField" NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderStatusHistory_orderId_createdAt_idx" ON "OrderStatusHistory"("orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE;
