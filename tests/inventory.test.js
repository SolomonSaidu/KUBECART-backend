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
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
      expect(mockTx.inventoryReservation.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'res-1',
          status: 'ACTIVE',
          expiresAt: { lt: expect.any(Date) },
        },
        data: { status: 'EXPIRED' },
      });
    });

    it('does not release reservations that are not ACTIVE or already expired', async () => {
      vi.spyOn(prisma.inventoryReservation, 'findMany').mockResolvedValue([]);

      const released = await inventoryService.releaseExpiredReservations();
      expect(released).toEqual([]);
    });

    it('restores stock only once when two sweepers race for the same reservation', async () => {
      const state = { stock: 10, status: 'ACTIVE' };
      const expiredRes = {
        id: 'res-race',
        productId: dummyProdId,
        quantity: 2,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() - 1000),
      };

      vi.spyOn(prisma.inventoryReservation, 'findMany').mockResolvedValue([expiredRes]);

      let lock = Promise.resolve();
      const serialize = (fn) => {
        const run = lock.then(fn, fn);
        lock = run.catch(() => {});
        return run;
      };

      const mockTx = {
        inventoryReservation: {
          updateMany: vi.fn(async ({ where }) => {
            if (state.status !== where.status) return { count: 0 };
            state.status = 'EXPIRED';
            return { count: 1 };
          }),
        },
        product: {
          update: vi.fn(async () => {
            state.stock += expiredRes.quantity;
            return { id: dummyProdId, stock: state.stock };
          }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) =>
        serialize(async () => callback(mockTx))
      );

      const [first, second] = await Promise.all([
        inventoryService.releaseExpiredReservations(),
        inventoryService.releaseExpiredReservations(),
      ]);

      expect([first.length, second.length].sort()).toEqual([0, 1]);
      expect(state.stock).toBe(12);
      expect(mockTx.product.update).toHaveBeenCalledTimes(1);
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
    function paidOrder(overrides = {}) {
      return {
        id: 'ord-100',
        paymentStatus: 'PAID',
        status: 'CONFIRMED',
        fulfillmentStatus: 'UNFULFILLED',
        requiresManualReview: false,
        inventoryReconciledAt: null,
        items: [{ productId: dummyProdId, quantity: 1 }],
        reservations: [
          {
            id: 'res-10',
            productId: dummyProdId,
            quantity: 1,
            status: 'ACTIVE',
          },
        ],
        ...overrides,
      };
    }

    function reconcileTx(order, overrides = {}) {
      return {
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
        inventoryReservation: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        inventoryMovement: { create: vi.fn() },
        product: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        ...overrides,
      };
    }

    it('consumes active reservations without decrementing stock again', async () => {
      const order = paidOrder();
      const mockTx = reconcileTx(order);

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.reconcilePaidOrderInventory('ord-100');

      expect(result).toEqual({
        success: true,
        requiresManualReview: false,
        alreadyReconciled: false,
      });
      expect(mockTx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'ord-100',
          paymentStatus: 'PAID',
          status: { not: 'CANCELLED' },
          fulfillmentStatus: { not: 'CANCELLED' },
          inventoryReconciledAt: null,
        },
        data: { inventoryReconciledAt: expect.any(Date) },
      });
      expect(mockTx.inventoryReservation.updateMany).toHaveBeenCalledWith({
        where: { id: 'res-10', status: 'ACTIVE' },
        data: { status: 'CONSUMED' },
      });
      expect(mockTx.product.updateMany).not.toHaveBeenCalled();
      expect(mockTx.inventoryMovement.create).toHaveBeenCalledWith({
        data: {
          productId: dummyProdId,
          quantity: -1,
          type: 'SALE',
          reference: 'ord-100',
          dedupeKey: 'sale:ord-100:reservation:res-10',
        },
      });
    });

    it('fulfills late payment after reservation expiry if stock is still available', async () => {
      const order = paidOrder({
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
      });

      const mockTx = reconcileTx(order);

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.reconcilePaidOrderInventory('ord-200');

      expect(result).toEqual({
        success: true,
        requiresManualReview: false,
        alreadyReconciled: false,
      });
      expect(mockTx.product.updateMany).toHaveBeenCalledWith({
        where: { id: dummyProdId, stock: { gte: 2 } },
        data: { stock: { decrement: 2 } },
      });
      expect(mockTx.inventoryMovement.create).toHaveBeenCalledWith({
        data: {
          productId: dummyProdId,
          quantity: -2,
          type: 'SALE',
          reference: 'ord-200',
          dedupeKey: 'sale:ord-200:shortage:' + dummyProdId,
        },
      });
    });

    it('counts consumed, active, and expired reservations without double-counting stock', async () => {
      const order = paidOrder({
        id: 'ord-mixed',
        items: [{ productId: dummyProdId, quantity: 3 }],
        reservations: [
          {
            id: 'res-consumed',
            productId: dummyProdId,
            quantity: 1,
            status: 'CONSUMED',
          },
          {
            id: 'res-active',
            productId: dummyProdId,
            quantity: 1,
            status: 'ACTIVE',
          },
          {
            id: 'res-expired',
            productId: dummyProdId,
            quantity: 1,
            status: 'EXPIRED',
          },
        ],
      });

      const mockTx = reconcileTx(order);

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.reconcilePaidOrderInventory('ord-mixed');

      expect(result.success).toBe(true);
      expect(mockTx.product.updateMany).toHaveBeenCalledTimes(1);
      expect(mockTx.product.updateMany).toHaveBeenCalledWith({
        where: { id: dummyProdId, stock: { gte: 1 } },
        data: { stock: { decrement: 1 } },
      });
      expect(mockTx.inventoryMovement.create).toHaveBeenCalledTimes(2);
      expect(mockTx.inventoryMovement.create).toHaveBeenCalledWith({
        data: {
          productId: dummyProdId,
          quantity: -1,
          type: 'SALE',
          reference: 'ord-mixed',
          dedupeKey: 'sale:ord-mixed:reservation:res-active',
        },
      });
      expect(mockTx.inventoryMovement.create).toHaveBeenCalledWith({
        data: {
          productId: dummyProdId,
          quantity: -1,
          type: 'SALE',
          reference: 'ord-mixed',
          dedupeKey: 'sale:ord-mixed:shortage:' + dummyProdId,
        },
      });
    });

    it('is a no-op when all reservations were already consumed', async () => {
      const order = paidOrder({
        id: 'ord-consumed',
        items: [{ productId: dummyProdId, quantity: 1 }],
        reservations: [
          {
            id: 'res-done',
            productId: dummyProdId,
            quantity: 1,
            status: 'CONSUMED',
          },
        ],
      });

      const mockTx = reconcileTx(order);

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.reconcilePaidOrderInventory('ord-consumed');

      expect(result.success).toBe(true);
      expect(mockTx.product.updateMany).not.toHaveBeenCalled();
      expect(mockTx.inventoryReservation.updateMany).not.toHaveBeenCalled();
      expect(mockTx.inventoryMovement.create).not.toHaveBeenCalled();
    });

    it('flags order for manual review when stock is unavailable after reservation expiry (never oversell)', async () => {
      const order = paidOrder({
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
      });

      const mockTx = reconcileTx(order, {
        product: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      });
      const reviewSpy = vi
        .spyOn(prisma.order, 'updateMany')
        .mockResolvedValue({ count: 1 });

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.reconcilePaidOrderInventory('ord-300');

      expect(result).toEqual({
        success: false,
        requiresManualReview: true,
        alreadyReconciled: false,
        insufficientStock: true,
      });
      expect(reviewSpy).toHaveBeenCalledWith({
        where: {
          id: 'ord-300',
          paymentStatus: 'PAID',
          status: { not: 'CANCELLED' },
          fulfillmentStatus: { not: 'CANCELLED' },
          inventoryReconciledAt: null,
        },
        data: {
          requiresManualReview: true,
          inventoryReconciledAt: expect.any(Date),
        },
      });
      expect(mockTx.inventoryMovement.create).not.toHaveBeenCalled();
    });

    it('never deducts stock or consumes reservations for a cancelled order', async () => {
      const order = paidOrder({
        id: 'ord-400',
        status: 'CANCELLED',
        fulfillmentStatus: 'CANCELLED',
        items: [{ productId: dummyProdId, quantity: 2 }],
        reservations: [
          {
            id: 'res-40',
            productId: dummyProdId,
            quantity: 2,
            status: 'ACTIVE',
          },
        ],
      });

      const mockTx = reconcileTx(order);

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.reconcilePaidOrderInventory('ord-400');

      expect(result).toEqual({
        success: false,
        requiresManualReview: true,
        cancelled: true,
        alreadyReconciled: false,
      });
      expect(mockTx.order.update).toHaveBeenCalledWith({
        where: { id: 'ord-400' },
        data: {
          requiresManualReview: true,
          inventoryReconciledAt: expect.any(Date),
        },
      });
      expect(mockTx.product.updateMany).not.toHaveBeenCalled();
      expect(mockTx.inventoryReservation.updateMany).not.toHaveBeenCalled();
      expect(mockTx.inventoryMovement.create).not.toHaveBeenCalled();
    });

    it('rolls back a failed reconciliation and safely retries it', async () => {
      const state = {
        stock: 10,
        inventoryReconciledAt: null,
        movements: [],
      };
      let failNextMovement = true;
      let lock = Promise.resolve();

      const serialize = (fn) => {
        const run = lock.then(fn, fn);
        lock = run.catch(() => {});
        return run;
      };

      const buildTx = () => ({
        order: {
          findUnique: vi.fn(async () => ({
            id: 'ord-retry',
            paymentStatus: 'PAID',
            status: 'CONFIRMED',
            fulfillmentStatus: 'UNFULFILLED',
            requiresManualReview: false,
            inventoryReconciledAt: state.inventoryReconciledAt,
            items: [{ productId: dummyProdId, quantity: 5 }],
            reservations: [
              {
                id: 'res-retry',
                productId: dummyProdId,
                quantity: 5,
                status: 'EXPIRED',
              },
            ],
          })),
          updateMany: vi.fn(async () => {
            if (state.inventoryReconciledAt) return { count: 0 };
            state.inventoryReconciledAt = new Date();
            return { count: 1 };
          }),
        },
        inventoryReservation: { updateMany: vi.fn() },
        product: {
          updateMany: vi.fn(async ({ data }) => {
            if (state.stock < data.stock.decrement) return { count: 0 };
            state.stock -= data.stock.decrement;
            return { count: 1 };
          }),
        },
        inventoryMovement: {
          create: vi.fn(async ({ data }) => {
            if (failNextMovement) {
              failNextMovement = false;
              throw new Error('movement write failed');
            }
            state.movements.push(data);
          }),
        },
      });

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) =>
        serialize(async () => {
          const snapshot = {
            stock: state.stock,
            inventoryReconciledAt: state.inventoryReconciledAt,
            movements: [...state.movements],
          };

          try {
            return await callback(buildTx());
          } catch (error) {
            state.stock = snapshot.stock;
            state.inventoryReconciledAt = snapshot.inventoryReconciledAt;
            state.movements = snapshot.movements;
            throw error;
          }
        })
      );

      await expect(
        inventoryService.reconcilePaidOrderInventory('ord-retry')
      ).rejects.toThrow('movement write failed');

      expect(state.stock).toBe(10);
      expect(state.inventoryReconciledAt).toBeNull();
      expect(state.movements).toHaveLength(0);

      const result = await inventoryService.reconcilePaidOrderInventory('ord-retry');

      expect(result.success).toBe(true);
      expect(state.stock).toBe(5);
      expect(state.inventoryReconciledAt).toBeInstanceOf(Date);
      expect(state.movements).toHaveLength(1);
    });

    it('treats a lost reconciliation claim as already reconciled', async () => {
      const order = paidOrder({
        id: 'ord-claimed',
        inventoryReconciledAt: new Date(),
      });

      const mockTx = reconcileTx(order, {
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          update: vi.fn(),
        },
      });

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));

      const result = await inventoryService.reconcilePaidOrderInventory('ord-claimed');

      expect(result).toEqual({
        success: true,
        requiresManualReview: false,
        alreadyReconciled: true,
        cancelled: false,
      });
      expect(mockTx.product.updateMany).not.toHaveBeenCalled();
      expect(mockTx.inventoryMovement.create).not.toHaveBeenCalled();
    });
  });
});
