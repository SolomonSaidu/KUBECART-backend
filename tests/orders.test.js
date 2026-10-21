import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/db.js';
import { tokenUtil } from '../src/utils/token.util.js';
import { orderService } from '../src/services/order.service.js';

const adminToken = tokenUtil.generateToken({
  adminId: 'admin-1',
  email: 'admin@kubecart.test',
});

function mockAdmin() {
  vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
    id: 'admin-1',
    email: 'admin@kubecart.test',
    name: 'Admin',
  });
}

function makeOrder(overrides = {}) {
  return {
    id: 'ord-1',
    reference: 'KBC-ABC123',
    email: 'customer@kubecart.test',
    phone: '+2348012345678',
    shippingAddress: '1 Test Street, Lagos',
    subtotalKobo: 2500000,
    deliveryFeeKobo: 150000,
    totalKobo: 2650000,
    currency: 'NGN',
    status: 'PENDING',
    paymentStatus: 'UNPAID',
    fulfillmentStatus: 'UNFULFILLED',
    requiresManualReview: false,
    createdAt: new Date('2026-10-21T10:00:00.000Z'),
    updatedAt: new Date('2026-10-21T10:00:00.000Z'),
    items: [],
    payments: [],
    reservations: [],
    statusHistory: [],
    _count: { items: 0 },
    ...overrides,
  };
}

function mockTransaction(tx) {
  vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) =>
    callback(tx)
  );
  return tx;
}

describe('Milestone 8 — Order administration and fulfilment', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Authorization', () => {
    it('rejects unauthenticated order list, detail, and fulfilment requests', async () => {
      const listRes = await request(app).get('/api/v1/admin/orders');
      const detailRes = await request(app).get('/api/v1/admin/orders/KBC-ABC123');
      const patchRes = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .send({ status: 'PROCESSING' });

      expect(listRes.status).toBe(401);
      expect(detailRes.status).toBe(401);
      expect(patchRes.status).toBe(401);
    });
  });

  describe('GET /api/v1/admin/orders', () => {
    it('returns a paginated, filtered order list', async () => {
      mockAdmin();
      const summary = makeOrder();

      const countSpy = vi
        .spyOn(prisma.order, 'count')
        .mockReturnValue(Promise.resolve(1));
      const findSpy = vi
        .spyOn(prisma.order, 'findMany')
        .mockReturnValue(Promise.resolve([summary]));
      vi.spyOn(prisma, '$transaction').mockResolvedValue([1, [summary]]);

      const res = await request(app)
        .get('/api/v1/admin/orders')
        .query({
          page: 2,
          limit: 10,
          status: 'PENDING',
          paymentStatus: 'UNPAID',
          fulfillmentStatus: 'UNFULFILLED',
          requiresManualReview: 'false',
          search: 'KBC-ABC',
          sort: 'total:desc',
        })
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 1,
        totalPages: 1,
      });
      expect(countSpy).toHaveBeenCalled();
      expect(findSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'PENDING',
            paymentStatus: 'UNPAID',
            fulfillmentStatus: 'UNFULFILLED',
            requiresManualReview: false,
            OR: [
              { reference: { contains: 'KBC-ABC', mode: 'insensitive' } },
              { email: { contains: 'KBC-ABC', mode: 'insensitive' } },
            ],
          },
          skip: 10,
          take: 10,
          orderBy: { totalKobo: 'desc' },
        })
      );
    });

    it('returns an empty result with one total page', async () => {
      mockAdmin();
      vi.spyOn(prisma.order, 'count').mockReturnValue(Promise.resolve(0));
      vi.spyOn(prisma.order, 'findMany').mockReturnValue(Promise.resolve([]));
      vi.spyOn(prisma, '$transaction').mockResolvedValue([0, []]);

      const res = await request(app)
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.pagination.totalPages).toBe(1);
    });

    it('rejects invalid filter values', async () => {
      mockAdmin();

      const res = await request(app)
        .get('/api/v1/admin/orders?status=DELIVERED')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('issues');
    });
  });

  describe('GET /api/v1/admin/orders/:reference', () => {
    it('returns order detail without raw webhook payloads', async () => {
      mockAdmin();
      const detail = makeOrder({
        payments: [
          {
            id: 'pay-1',
            reference: 'PAY-KBC-ABC123',
            externalId: '998877',
            amountKobo: 2650000,
            currency: 'NGN',
            status: 'SUCCESS',
            gateway: 'PAYSTACK',
          },
        ],
      });
      const findSpy = vi
        .spyOn(prisma.order, 'findUnique')
        .mockResolvedValue(detail);

      const res = await request(app)
        .get('/api/v1/admin/orders/KBC-ABC123')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.reference).toBe('KBC-ABC123');
      expect(res.body.data.payments[0].webhookRaw).toBeUndefined();

      const query = findSpy.mock.calls[0][0];
      expect(query.select.payments.select.webhookRaw).toBeUndefined();
      expect(query.select.email).toBe(true);
    });

    it('returns 404 for an unknown reference', async () => {
      mockAdmin();
      vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(null);

      const res = await request(app)
        .get('/api/v1/admin/orders/KBC-UNKNOWN')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/admin/orders/:reference/fulfillment', () => {
    it('moves a paid order from UNFULFILLED to PROCESSING and records history', async () => {
      mockAdmin();
      const order = makeOrder({ paymentStatus: 'PAID' });
      const updated = makeOrder({
        paymentStatus: 'PAID',
        fulfillmentStatus: 'PROCESSING',
      });

      const tx = mockTransaction({
        order: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(order)
            .mockResolvedValueOnce(updated),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        inventoryReservation: { findMany: vi.fn(), updateMany: vi.fn() },
        product: { update: vi.fn() },
        orderStatusHistory: { createMany: vi.fn() },
      });

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'PROCESSING', note: 'Packing started' });

      expect(res.status).toBe(200);
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'ord-1',
          fulfillmentStatus: 'UNFULFILLED',
          paymentStatus: 'PAID',
          requiresManualReview: false,
        },
        data: { fulfillmentStatus: 'PROCESSING' },
      });
      expect(tx.orderStatusHistory.createMany).toHaveBeenCalledWith({
        data: [
          {
            orderId: 'ord-1',
            adminId: 'admin-1',
            field: 'FULFILLMENT',
            fromStatus: 'UNFULFILLED',
            toStatus: 'PROCESSING',
            note: 'Packing started',
          },
        ],
      });
      expect(tx.product.update).not.toHaveBeenCalled();
    });

    it('moves a paid PROCESSING order to FULFILLED', async () => {
      mockAdmin();
      const order = makeOrder({
        paymentStatus: 'PAID',
        fulfillmentStatus: 'PROCESSING',
      });
      const updated = makeOrder({
        paymentStatus: 'PAID',
        fulfillmentStatus: 'FULFILLED',
      });

      const tx = mockTransaction({
        order: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(order)
            .mockResolvedValueOnce(updated),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        inventoryReservation: { findMany: vi.fn(), updateMany: vi.fn() },
        product: { update: vi.fn() },
        orderStatusHistory: { createMany: vi.fn() },
      });

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'FULFILLED' });

      expect(res.status).toBe(200);
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'ord-1',
          fulfillmentStatus: 'PROCESSING',
          paymentStatus: 'PAID',
          requiresManualReview: false,
        },
        data: { fulfillmentStatus: 'FULFILLED' },
      });
    });

    it('rejects skipping directly from UNFULFILLED to FULFILLED', async () => {
      mockAdmin();
      const order = makeOrder({ paymentStatus: 'PAID' });

      const tx = mockTransaction({
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          updateMany: vi.fn(),
        },
        inventoryReservation: { findMany: vi.fn(), updateMany: vi.fn() },
        product: { update: vi.fn() },
        orderStatusHistory: { createMany: vi.fn() },
      });

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'FULFILLED' });

      expect(res.status).toBe(409);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects transitions out of the terminal FULFILLED state', async () => {
      mockAdmin();
      const order = makeOrder({
        paymentStatus: 'PAID',
        fulfillmentStatus: 'FULFILLED',
      });

      const tx = mockTransaction({
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          updateMany: vi.fn(),
        },
        inventoryReservation: { findMany: vi.fn(), updateMany: vi.fn() },
        product: { update: vi.fn() },
        orderStatusHistory: { createMany: vi.fn() },
      });

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'PROCESSING' });

      expect(res.status).toBe(409);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects PROCESSING when the order is unpaid', async () => {
      mockAdmin();
      const order = makeOrder({ paymentStatus: 'UNPAID' });

      const tx = mockTransaction({
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          updateMany: vi.fn(),
        },
        inventoryReservation: { findMany: vi.fn(), updateMany: vi.fn() },
        product: { update: vi.fn() },
        orderStatusHistory: { createMany: vi.fn() },
      });

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'PROCESSING' });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('must be paid');
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects processing when the order requires manual review', async () => {
      mockAdmin();
      const order = makeOrder({
        paymentStatus: 'PAID',
        requiresManualReview: true,
      });

      const tx = mockTransaction({
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          updateMany: vi.fn(),
        },
        inventoryReservation: { findMany: vi.fn(), updateMany: vi.fn() },
        product: { update: vi.fn() },
        orderStatusHistory: { createMany: vi.fn() },
      });

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'PROCESSING' });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('manual review');
      expect(tx.order.updateMany).not.toHaveBeenCalled();
    });

    it('cancels an unpaid order, restores reserved stock, and records both transitions', async () => {
      mockAdmin();
      const reservation = {
        id: 'res-1',
        productId: 'prod-1',
        quantity: 2,
        status: 'ACTIVE',
      };
      const order = makeOrder({ reservations: [reservation] });
      const updated = makeOrder({
        status: 'CANCELLED',
        fulfillmentStatus: 'CANCELLED',
        reservations: [{ ...reservation, status: 'RELEASED' }],
      });

      const tx = mockTransaction({
        order: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(order)
            .mockResolvedValueOnce(updated),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        inventoryReservation: {
          findMany: vi.fn().mockResolvedValue([reservation]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        product: { update: vi.fn() },
        orderStatusHistory: { createMany: vi.fn() },
      });

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'CANCELLED', note: 'Customer requested cancellation' });

      expect(res.status).toBe(200);
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'ord-1',
          fulfillmentStatus: 'UNFULFILLED',
          paymentStatus: { not: 'PAID' },
        },
        data: { fulfillmentStatus: 'CANCELLED', status: 'CANCELLED' },
      });
      expect(tx.inventoryReservation.findMany).toHaveBeenCalledWith({
        where: { orderId: 'ord-1', status: 'ACTIVE' },
      });
      expect(tx.inventoryReservation.updateMany).toHaveBeenCalledWith({
        where: { id: 'res-1', status: 'ACTIVE' },
        data: { status: 'RELEASED' },
      });
      expect(tx.product.update).toHaveBeenCalledWith({
        where: { id: 'prod-1' },
        data: { stock: { increment: 2 } },
      });
      expect(tx.orderStatusHistory.createMany).toHaveBeenCalledWith({
        data: [
          {
            orderId: 'ord-1',
            adminId: 'admin-1',
            field: 'ORDER',
            fromStatus: 'PENDING',
            toStatus: 'CANCELLED',
            note: 'Customer requested cancellation',
          },
          {
            orderId: 'ord-1',
            adminId: 'admin-1',
            field: 'FULFILLMENT',
            fromStatus: 'UNFULFILLED',
            toStatus: 'CANCELLED',
            note: 'Customer requested cancellation',
          },
        ],
      });
    });

    it('rejects cancelling a paid order without touching inventory', async () => {
      mockAdmin();
      const order = makeOrder({ paymentStatus: 'PAID' });

      const tx = mockTransaction({
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          updateMany: vi.fn(),
        },
        inventoryReservation: { findMany: vi.fn(), updateMany: vi.fn() },
        product: { update: vi.fn() },
        orderStatusHistory: { createMany: vi.fn() },
      });

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'CANCELLED' });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('refund workflow');
      expect(tx.inventoryReservation.findMany).not.toHaveBeenCalled();
    });

    it('treats a repeated cancellation as a no-op without restoring stock again', async () => {
      mockAdmin();
      const order = makeOrder({
        status: 'CANCELLED',
        fulfillmentStatus: 'CANCELLED',
      });

      const tx = mockTransaction({
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          updateMany: vi.fn(),
        },
        inventoryReservation: { findMany: vi.fn(), updateMany: vi.fn() },
        product: { update: vi.fn() },
        orderStatusHistory: { createMany: vi.fn() },
      });

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'CANCELLED' });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('already CANCELLED');
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(tx.inventoryReservation.findMany).not.toHaveBeenCalled();
      expect(tx.product.update).not.toHaveBeenCalled();
      expect(tx.orderStatusHistory.createMany).not.toHaveBeenCalled();
    });

    it('rejects admin attempts to write payment or review fields', async () => {
      mockAdmin();

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'PROCESSING', paymentStatus: 'PAID' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('issues');
    });

    it('returns 409 when the optimistic state claim loses a race', async () => {
      mockAdmin();
      const order = makeOrder();

      const tx = mockTransaction({
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        inventoryReservation: { findMany: vi.fn(), updateMany: vi.fn() },
        product: { update: vi.fn() },
        orderStatusHistory: { createMany: vi.fn() },
      });

      const res = await request(app)
        .patch('/api/v1/admin/orders/KBC-ABC123/fulfillment')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'CANCELLED' });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('state changed');
      expect(tx.inventoryReservation.findMany).not.toHaveBeenCalled();
    });
  });

  describe('Transaction safety (simulated, not live PostgreSQL)', () => {
    it('restores stock exactly once when two cancellations race', async () => {
      const reservation = {
        id: 'res-1',
        productId: 'prod-1',
        quantity: 2,
        status: 'ACTIVE',
      };
      const state = {
        stock: 10,
        reservationStatus: 'ACTIVE',
        order: makeOrder({ reservations: [reservation] }),
        history: [],
      };

      let queue = Promise.resolve();
      const withLock = (fn) => {
        const run = queue.then(fn);
        queue = run.catch(() => {});
        return run;
      };

      const tx = {
        order: {
          findUnique: vi.fn().mockImplementation(async () => ({
            ...state.order,
            reservations: [
              { ...reservation, status: state.reservationStatus },
            ],
          })),
          updateMany: vi.fn().mockImplementation(async ({ where, data }) => {
            if (state.order.fulfillmentStatus !== where.fulfillmentStatus) {
              return { count: 0 };
            }
            state.order.fulfillmentStatus = data.fulfillmentStatus;
            if (data.status) state.order.status = data.status;
            return { count: 1 };
          }),
        },
        inventoryReservation: {
          findMany: vi.fn().mockImplementation(async () =>
            state.reservationStatus === 'ACTIVE' ? [reservation] : []
          ),
          updateMany: vi.fn().mockImplementation(async () => {
            if (state.reservationStatus !== 'ACTIVE') return { count: 0 };
            state.reservationStatus = 'RELEASED';
            return { count: 1 };
          }),
        },
        product: {
          update: vi.fn().mockImplementation(async ({ data }) => {
            state.stock += data.stock.increment;
          }),
        },
        orderStatusHistory: {
          createMany: vi.fn().mockImplementation(async ({ data }) => {
            state.history.push(...data);
          }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) =>
        withLock(() => callback(tx))
      );

      const results = await Promise.allSettled([
        orderService.transitionFulfillment(
          'KBC-ABC123',
          { status: 'CANCELLED' },
          'admin-1'
        ),
        orderService.transitionFulfillment(
          'KBC-ABC123',
          { status: 'CANCELLED' },
          'admin-1'
        ),
      ]);

      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      expect(state.stock).toBe(12);
      expect(state.reservationStatus).toBe('RELEASED');
      expect(
        state.history.filter((h) => h.field === 'FULFILLMENT')
      ).toHaveLength(1);
    });

    it('propagates a transaction failure so stock restoration is rolled back', async () => {
      const reservation = {
        id: 'res-1',
        productId: 'prod-1',
        quantity: 2,
        status: 'ACTIVE',
      };
      const state = { stock: 10 };
      const order = makeOrder({ reservations: [reservation] });

      const tx = {
        order: {
          findUnique: vi.fn().mockResolvedValue(order),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        inventoryReservation: {
          findMany: vi.fn().mockResolvedValue([reservation]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        product: {
          update: vi.fn().mockImplementation(async ({ data }) => {
            state.stock += data.stock.increment;
          }),
        },
        orderStatusHistory: {
          createMany: vi.fn().mockRejectedValue(new Error('history insert failed')),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) => {
        const snapshot = state.stock;
        try {
          return await callback(tx);
        } catch (err) {
          state.stock = snapshot;
          throw err;
        }
      });

      await expect(
        orderService.transitionFulfillment(
          'KBC-ABC123',
          { status: 'CANCELLED' },
          'admin-1'
        )
      ).rejects.toThrow('history insert failed');

      expect(state.stock).toBe(10);
    });
  });
});
