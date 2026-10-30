import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { inventoryService } from './inventory.service.js';

const ORDER_EXPIRED_NOTE =
  'Order automatically expired after the payment window elapsed; inventory reservations released';
const FULFILLMENT_EXPIRED_NOTE =
  'Fulfillment automatically cancelled because the unpaid order expired';

function fallbackDeadline(createdAt, reservationMinutes) {
  return new Date(
    new Date(createdAt).getTime() + reservationMinutes * 60 * 1000
  );
}

function orderIsDue(order, now, reservationMinutes) {
  const active = order.reservations.filter((reservation) => {
    return reservation.status === 'ACTIVE';
  });

  if (active.length === 0) {
    return fallbackDeadline(order.createdAt, reservationMinutes) <= now;
  }

  return active.every((reservation) => {
    return new Date(reservation.expiresAt) <= now;
  });
}

function candidateWhere(now, fallbackCutoff) {
  return {
    paymentStatus: 'UNPAID',
    status: 'PENDING',
    fulfillmentStatus: 'UNFULFILLED',
    OR: [
      {
        reservations: {
          some: {
            status: 'ACTIVE',
            expiresAt: { lte: now },
          },
          none: {
            status: 'ACTIVE',
            expiresAt: { gt: now },
          },
        },
      },
      {
        reservations: {
          none: { status: 'ACTIVE' },
        },
        createdAt: { lte: fallbackCutoff },
      },
    ],
  };
}

export const orderExpirationService = {
  /**
   * Cancels one due unpaid order and releases all of its expired reservations
   * inside a single transaction. The conditional order update is the
   * serialization point: payment verification, admin cancellation, another
   * worker instance, or a retry cannot both claim the same order.
   */
  async expireUnpaidOrder(
    orderId,
    {
      now = new Date(),
      reservationMinutes = env.INVENTORY_RESERVATION_MINUTES,
    } = {}
  ) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          reservations: true,
        },
      });

      if (!order) {
        return null;
      }

      if (
        order.paymentStatus !== 'UNPAID' ||
        order.status !== 'PENDING' ||
        order.fulfillmentStatus !== 'UNFULFILLED'
      ) {
        return null;
      }

      if (!orderIsDue(order, now, reservationMinutes)) {
        return null;
      }

      const claim = await tx.order.updateMany({
        where: {
          id: order.id,
          paymentStatus: 'UNPAID',
          status: 'PENDING',
          fulfillmentStatus: 'UNFULFILLED',
        },
        data: {
          status: 'CANCELLED',
          fulfillmentStatus: 'CANCELLED',
        },
      });

      if (claim.count !== 1) {
        return null;
      }

      const released = await inventoryService.releaseExpiredReservationsTx(tx, {
        orderId: order.id,
        now,
      });

      await tx.orderStatusHistory.createMany({
        data: [
          {
            orderId: order.id,
            adminId: null,
            field: 'ORDER',
            fromStatus: order.status,
            toStatus: 'CANCELLED',
            note: ORDER_EXPIRED_NOTE,
          },
          {
            orderId: order.id,
            adminId: null,
            field: 'FULFILLMENT',
            fromStatus: order.fulfillmentStatus,
            toStatus: 'CANCELLED',
            note: FULFILLMENT_EXPIRED_NOTE,
          },
        ],
      });

      return {
        orderId: order.id,
        reference: order.reference,
        releasedReservations: released.length,
        releasedQuantity: released.reduce((total, reservation) => {
          return total + reservation.quantity;
        }, 0),
      };
    });
  },

  /**
   * Processes a bounded batch of due orders. Each order has its own
   * transaction, so one failure does not roll back or block unrelated orders.
   */
  async expireUnpaidOrders({
    limit = 50,
    now = new Date(),
    reservationMinutes = env.INVENTORY_RESERVATION_MINUTES,
  } = {}) {
    const fallbackCutoff = new Date(
      now.getTime() - reservationMinutes * 60 * 1000
    );

    const candidates = await prisma.order.findMany({
      where: candidateWhere(now, fallbackCutoff),
      select: { id: true, reference: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    const expired = [];
    const failures = [];

    for (const candidate of candidates) {
      try {
        const result = await orderExpirationService.expireUnpaidOrder(
          candidate.id,
          { now, reservationMinutes }
        );

        if (result) {
          expired.push(result);
        }
      } catch (error) {
        failures.push({ orderId: candidate.id, error });
      }
    }

    return {
      scanned: candidates.length,
      expiredOrders: expired.length,
      releasedReservations: expired.reduce((total, result) => {
        return total + result.releasedReservations;
      }, 0),
      releasedQuantity: expired.reduce((total, result) => {
        return total + result.releasedQuantity;
      }, 0),
      expired,
      failures,
    };
  },
};
