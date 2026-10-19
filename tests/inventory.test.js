import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inventoryService } from '../src/services/inventory.service.js';
import { checkoutService } from '../src/services/checkout.service.js';
import { prisma } from '../src/config/db.js';

describe('Milestone 6 — Inventory Reservations & Concurrency', () => {
  const dummyProdId = '123e4567-e89b-12d3-a456-426614174001';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Reservation Expiry & Release', () => {
    it('releases active expired reservations and increments product stock exactly once', async () => {
      const expiredRes = {
        id: 'res-1',
        productId: dummyProdId,
        quantity: 2,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() - 1000), // Past
      };

      vi.spyOn(prisma.inventoryReservation, 'findMany').mockResolvedValue([expiredRes]);

      const mockTx = {
        inventoryReservation: {
          findUnique: vi.fn().mockResolvedValue(expiredRes),
          update: vi.fn().mockResolvedValue({ ...expiredRes, status: 'EXPIRED' }),
        },
        product: {
          update: vi.fn().mockResolvedValue({ id: dummyProdId, stock: 12 }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) => {
        return callback(mockTx);
      });

      const released = await inventoryService.releaseExpiredReservations();

      expect(released).toHaveLength(1);
      expect(mockTx.product.update).toHaveBeenCalledWith({
        where: { id: dummyProdId },
        data: { stock: { increment: 2 } },
      });
      expect(mockTx.inventoryReservation.update).toHaveBeenCalledWith({
        where: { id: 'res-1' },
        data: { status: 'EXPIRED' },
      });
    });

    it('does not release reservations that are not ACTIVE or already expired', async () => {
      vi.spyOn(prisma.inventoryReservation, 'findMany').mockResolvedValue([]);

      const released = await inventoryService.releaseExpiredReservations();
      expect(released).toEqual([]);
    });
  });

  describe('Reservation Release on Cancellation', () => {
    it('releases active reservation on demand and restores stock', async () => {
      const activeRes = {
        id: 'res-2',
        productId: dummyProdId,
        quantity: 3,
        status: 'ACTIVE',
      };

      const mockTx = {
        inventoryReservation: {
          findUnique: vi.fn().mockResolvedValue(activeRes),
          update: vi.fn().mockResolvedValue({ ...activeRes, status: 'RELEASED' }),
        },
        product: {
          update: vi.fn().mockResolvedValue({ id: dummyProdId, stock: 10 }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.releaseReservation('res-2');

      expect(result.status).toBe('RELEASED');
      expect(mockTx.product.update).toHaveBeenCalledWith({
        where: { id: dummyProdId },
        data: { stock: { increment: 3 } },
      });
    });
  });

  describe('Late Payment Reconciliation Scenario', () => {
    it('consumes reservations and writes SALE audit movement when all reservations are active', async () => {
      const order = {
        id: 'ord-100',
        items: [{ productId: dummyProdId, quantity: 1 }],
        reservations: [
          {
            id: 'res-10',
            productId: dummyProdId,
            quantity: 1,
            status: 'ACTIVE',
          },
        ],
      };

      const mockTx = {
        order: { findUnique: vi.fn().mockResolvedValue(order) },
        inventoryReservation: { update: vi.fn() },
        inventoryMovement: { create: vi.fn() },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.consumeOrReconcileReservations('ord-100');

      expect(result).toEqual({ success: true, requiresManualReview: false });
      expect(mockTx.inventoryReservation.update).toHaveBeenCalledWith({
        where: { id: 'res-10' },
        data: { status: 'CONSUMED' },
      });
      expect(mockTx.inventoryMovement.create).toHaveBeenCalledWith({
        data: {
          productId: dummyProdId,
          quantity: -1,
          type: 'SALE',
          reference: 'ord-100',
        },
      });
    });

    it('fulfills late payment after reservation expiry if stock is still available', async () => {
      const order = {
        id: 'ord-200',
        items: [{ productId: dummyProdId, quantity: 2 }],
        reservations: [
          {
            id: 'res-20',
            productId: dummyProdId,
            quantity: 2,
            status: 'EXPIRED',
          },
        ],
      };

      const mockTx = {
        order: { findUnique: vi.fn().mockResolvedValue(order) },
        product: {
          findUnique: vi.fn().mockResolvedValue({ id: dummyProdId, stock: 5 }), // Stock available
          update: vi.fn(),
        },
        inventoryMovement: { create: vi.fn() },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.consumeOrReconcileReservations('ord-200');

      expect(result).toEqual({ success: true, requiresManualReview: false });
      expect(mockTx.product.update).toHaveBeenCalledWith({
        where: { id: dummyProdId },
        data: { stock: { decrement: 2 } },
      });
      expect(mockTx.inventoryMovement.create).toHaveBeenCalled();
    });

    it('flags order for manual review when stock is unavailable after reservation expiry (never oversell)', async () => {
      const order = {
        id: 'ord-300',
        items: [{ productId: dummyProdId, quantity: 5 }],
        reservations: [
          {
            id: 'res-30',
            productId: dummyProdId,
            quantity: 5,
            status: 'EXPIRED',
          },
        ],
      };

      const mockTx = {
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          update: vi.fn(),
        },
        product: {
          findUnique: vi.fn().mockResolvedValue({ id: dummyProdId, stock: 1 }), // Insufficient stock!
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.consumeOrReconcileReservations('ord-300');

      expect(result).toEqual({ success: false, requiresManualReview: true });
      expect(mockTx.order.update).toHaveBeenCalledWith({
        where: { id: 'ord-300' },
        data: { requiresManualReview: true },
      });
    });
  });
});
