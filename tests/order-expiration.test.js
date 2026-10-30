import { describe, it, expect, vi, beforeEach } from 'vitest';
import { orderExpirationService } from '../src/services/order-expiration.service.js';
import { createOrderExpirationWorker } from '../src/workers/order-expiration.worker.js';
import { prisma } from '../src/config/db.js';

const PRODUCT_ID = '123e4567-e89b-12d3-a456-426614174001';
const NOW = new Date('2026-10-30T12:00:00.000Z');

function makeOrder(overrides = {}) {
  return {
    id: 'ord-1',
    reference: 'KBC-EXPIRETEST01',
    paymentStatus: 'UNPAID',
    status: 'PENDING',
    fulfillmentStatus: 'UNFULFILLED',
    createdAt: new Date('2026-10-30T11:40:00.000Z'),
    reservations: [
      {
        id: 'res-1',
        orderId: 'ord-1',
        productId: PRODUCT_ID,
        quantity: 2,
        status: 'ACTIVE',
        expiresAt: new Date('2026-10-30T11:59:00.000Z'),
      },
    ],
    ...overrides,
  };
}

function makeTx(order, overrides = {}) {
  return {
    order: {
      findUnique: vi.fn().mockResolvedValue(order),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inventoryReservation: {
      findMany: vi.fn().mockResolvedValue(
        order.reservations.filter((reservation) => reservation.status === 'ACTIVE')
      ),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    product: { update: vi.fn() },
    orderStatusHistory: { createMany: vi.fn() },
    ...overrides,
  };
}

function useTransaction(tx) {
  return vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) => {
    return callback(tx);
  });
}

describe('Order expiration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('cancels a due unpaid order, restores stock, and records both transitions', async () => {
    const order = makeOrder();
    const tx = makeTx(order);
    useTransaction(tx);

    const result = await orderExpirationService.expireUnpaidOrder('ord-1', {
      now: NOW,
      reservationMinutes: 15,
    });

    expect(result).toEqual({
      orderId: 'ord-1',
      reference: 'KBC-EXPIRETEST01',
      releasedReservations: 1,
      releasedQuantity: 2,
    });
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ord-1',
        paymentStatus: 'UNPAID',
        status: 'PENDING',
        fulfillmentStatus: 'UNFULFILLED',
      },
      data: {
        status: 'CANCELLED',
        fulfillmentStatus: 'CANCELLED',
      },
    });
    expect(tx.inventoryReservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'res-1',
        status: 'ACTIVE',
        expiresAt: { lte: NOW },
      },
      data: { status: 'EXPIRED' },
    });
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID },
      data: { stock: { increment: 2 } },
    });
    expect(tx.orderStatusHistory.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          orderId: 'ord-1',
          field: 'ORDER',
          fromStatus: 'PENDING',
          toStatus: 'CANCELLED',
          note: expect.stringContaining('automatically expired'),
        }),
        expect.objectContaining({
          orderId: 'ord-1',
          field: 'FULFILLMENT',
          fromStatus: 'UNFULFILLED',
          toStatus: 'CANCELLED',
          note: expect.stringContaining('automatically cancelled'),
        }),
      ],
    });
  });

  it('never expires or releases a paid order', async () => {
    const order = makeOrder({ paymentStatus: 'PAID', status: 'CONFIRMED' });
    const tx = makeTx(order);
    useTransaction(tx);

    const result = await orderExpirationService.expireUnpaidOrder('ord-1', {
      now: NOW,
      reservationMinutes: 15,
    });

    expect(result).toBeNull();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryReservation.updateMany).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.createMany).not.toHaveBeenCalled();
  });

  it('does nothing when payment or cancellation wins the conditional order claim', async () => {
    const order = makeOrder();
    const tx = makeTx(order, {
      order: {
        findUnique: vi.fn().mockResolvedValue(order),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    useTransaction(tx);

    const result = await orderExpirationService.expireUnpaidOrder('ord-1', {
      now: NOW,
      reservationMinutes: 15,
    });

    expect(result).toBeNull();
    expect(tx.inventoryReservation.updateMany).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.orderStatusHistory.createMany).not.toHaveBeenCalled();
  });

  it('waits until every active reservation for the order has expired', async () => {
    const order = makeOrder({
      reservations: [
        {
          id: 'res-old',
          orderId: 'ord-1',
          productId: PRODUCT_ID,
          quantity: 1,
          status: 'ACTIVE',
          expiresAt: new Date('2026-10-30T11:59:00.000Z'),
        },
        {
          id: 'res-future',
          orderId: 'ord-1',
          productId: PRODUCT_ID,
          quantity: 1,
          status: 'ACTIVE',
          expiresAt: new Date('2026-10-30T12:05:00.000Z'),
        },
      ],
    });
    const tx = makeTx(order);
    useTransaction(tx);

    const result = await orderExpirationService.expireUnpaidOrder('ord-1', {
      now: NOW,
      reservationMinutes: 15,
    });

    expect(result).toBeNull();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('restores stock and writes history only once when two workers race', async () => {
    const state = {
      orderStatus: 'PENDING',
      fulfillmentStatus: 'UNFULFILLED',
      reservationStatus: 'ACTIVE',
      stock: 10,
      historyRows: 0,
    };
    let lock = Promise.resolve();
    const serialize = (fn) => {
      const run = lock.then(fn, fn);
      lock = run.catch(() => {});
      return run;
    };

    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) => {
      return serialize(async () => {
        const order = makeOrder({
          reservations: [
            {
              id: 'res-race',
              orderId: 'ord-1',
              productId: PRODUCT_ID,
              quantity: 2,
              status: state.reservationStatus,
              expiresAt: new Date('2026-10-30T11:59:00.000Z'),
            },
          ],
          status: state.orderStatus,
          fulfillmentStatus: state.fulfillmentStatus,
        });

        const tx = {
          order: {
            findUnique: vi.fn().mockResolvedValue(order),
            updateMany: vi.fn(async () => {
              if (state.orderStatus !== 'PENDING') {
                return { count: 0 };
              }

              state.orderStatus = 'CANCELLED';
              state.fulfillmentStatus = 'CANCELLED';
              return { count: 1 };
            }),
          },
          inventoryReservation: {
            findMany: vi.fn(async () => {
              if (state.reservationStatus !== 'ACTIVE') {
                return [];
              }

              return order.reservations;
            }),
            updateMany: vi.fn(async () => {
              if (state.reservationStatus !== 'ACTIVE') {
                return { count: 0 };
              }

              state.reservationStatus = 'EXPIRED';
              return { count: 1 };
            }),
          },
          product: {
            update: vi.fn(async ({ data }) => {
              state.stock += data.stock.increment;
            }),
          },
          orderStatusHistory: {
            createMany: vi.fn(async ({ data }) => {
              state.historyRows += data.length;
            }),
          },
        };

        return callback(tx);
      });
    });

    const [first, second] = await Promise.all([
      orderExpirationService.expireUnpaidOrder('ord-1', {
        now: NOW,
        reservationMinutes: 15,
      }),
      orderExpirationService.expireUnpaidOrder('ord-1', {
        now: NOW,
        reservationMinutes: 15,
      }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(state.stock).toBe(12);
    expect(state.reservationStatus).toBe('EXPIRED');
    expect(state.orderStatus).toBe('CANCELLED');
    expect(state.historyRows).toBe(2);
  });

  it('expires unpaid orders that never created an active reservation after the window', async () => {
    const order = makeOrder({ reservations: [] });
    const tx = makeTx(order);
    useTransaction(tx);

    const result = await orderExpirationService.expireUnpaidOrder('ord-1', {
      now: NOW,
      reservationMinutes: 15,
    });

    expect(result).toMatchObject({
      orderId: 'ord-1',
      releasedReservations: 0,
      releasedQuantity: 0,
    });
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('scans a bounded batch and isolates per-order failures', async () => {
    vi.spyOn(prisma.order, 'findMany').mockResolvedValue([
      { id: 'ord-1', reference: 'KBC-1' },
      { id: 'ord-2', reference: 'KBC-2' },
    ]);

    const expireSpy = vi
      .spyOn(orderExpirationService, 'expireUnpaidOrder')
      .mockResolvedValueOnce({
        orderId: 'ord-1',
        reference: 'KBC-1',
        releasedReservations: 1,
        releasedQuantity: 2,
      })
      .mockRejectedValueOnce(new Error('boom'));

    const result = await orderExpirationService.expireUnpaidOrders({
      limit: 2,
      now: NOW,
      reservationMinutes: 15,
    });

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: expect.objectContaining({
          paymentStatus: 'UNPAID',
          status: 'PENDING',
          fulfillmentStatus: 'UNFULFILLED',
        }),
      })
    );
    expect(expireSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      scanned: 2,
      expiredOrders: 1,
      releasedReservations: 1,
      releasedQuantity: 2,
    });
    expect(result.failures).toHaveLength(1);
  });
});

describe('Order expiration worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs a bounded batch on demand', async () => {
    const service = {
      expireUnpaidOrders: vi.fn().mockResolvedValue({
        scanned: 0,
        expiredOrders: 0,
        releasedReservations: 0,
        releasedQuantity: 0,
        expired: [],
        failures: [],
      }),
    };
    const worker = createOrderExpirationWorker({ service, batchSize: 7 });

    const result = await worker.runOnce();

    expect(service.expireUnpaidOrders).toHaveBeenCalledWith({ limit: 7 });
    expect(result.expiredOrders).toBe(0);
  });

  it('does not overlap ticks and stop waits for the in-flight run', async () => {
    let resolveRun;
    const service = {
      expireUnpaidOrders: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRun = resolve;
          })
      ),
    };
    const worker = createOrderExpirationWorker({
      service,
      intervalMs: 100000,
    });

    expect(worker.start()).toBe(true);
    expect(worker.start()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.expireUnpaidOrders).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = worker.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopped).toBe(false);

    resolveRun({
      scanned: 0,
      expiredOrders: 0,
      releasedReservations: 0,
      releasedQuantity: 0,
      expired: [],
      failures: [],
    });
    await stopPromise;

    expect(stopped).toBe(true);
    expect(worker.isRunning()).toBe(false);
  });
});
