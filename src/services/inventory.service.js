import { prisma } from '../config/db.js';
import { env } from '../config/env.js';

export const inventoryService = {
  /**
   * Reserves stock for an order atomically using a database transaction.
   * Decrements product.stock and records InventoryReservation with an expiry time.
   */
  async reserveStockForOrder(tx, { orderId, items }) {
    const reservationMinutes = env.INVENTORY_RESERVATION_MINUTES;
    const expiresAt = new Date(Date.now() + reservationMinutes * 60 * 1000);
    const reservations = [];

    for (const item of items) {
      // Conditional stock decrement to prevent overselling
      const product = await tx.product.findUnique({
        where: { id: item.productId },
        select: { id: true, stock: true, name: true },
      });

      if (!product || product.stock < item.quantity) {
        const error = new Error(
          `Insufficient stock for product '${product ? product.name : item.productId}'. Available: ${
            product ? product.stock : 0
          }, Requested: ${item.quantity}`
        );
        error.statusCode = 409;
        throw error;
      }

      // Decrement stock
      await tx.product.update({
        where: { id: item.productId },
        data: {
          stock: { decrement: item.quantity },
        },
      });

      // Record reservation
      const reservation = await tx.inventoryReservation.create({
        data: {
          orderId,
          productId: item.productId,
          quantity: item.quantity,
          status: 'ACTIVE',
          expiresAt,
        },
      });

      reservations.push(reservation);
    }

    return reservations;
  },

  /**
   * Releases an active reservation and restores product stock.
   * Can be called on order cancellation or checkout abandonment.
   */
  async releaseReservation(reservationId) {
    return prisma.$transaction(async (tx) => {
      const reservation = await tx.inventoryReservation.findUnique({
        where: { id: reservationId },
      });

      if (!reservation || reservation.status !== 'ACTIVE') {
        return null;
      }

      await tx.product.update({
        where: { id: reservation.productId },
        data: {
          stock: { increment: reservation.quantity },
        },
      });

      return tx.inventoryReservation.update({
        where: { id: reservationId },
        data: { status: 'RELEASED' },
      });
    });
  },

  /**
   * Releases all expired ACTIVE reservations and restores inventory.
   * Ensures expired reservations are restored exactly once.
   */
  async releaseExpiredReservations() {
    const now = new Date();
    const expiredReservations = await prisma.inventoryReservation.findMany({
      where: {
        status: 'ACTIVE',
        expiresAt: { lt: now },
      },
    });

    const released = [];

    for (const res of expiredReservations) {
      const result = await prisma.$transaction(async (tx) => {
        // Double check status inside transaction
        const current = await tx.inventoryReservation.findUnique({
          where: { id: res.id },
        });

        if (!current || current.status !== 'ACTIVE') {
          return null;
        }

        await tx.product.update({
          where: { id: current.productId },
          data: {
            stock: { increment: current.quantity },
          },
        });

        return tx.inventoryReservation.update({
          where: { id: current.id },
          data: { status: 'EXPIRED' },
        });
      });

      if (result) {
        released.push(result);
      }
    }

    return released;
  },

  /**
   * Handles payment confirmation:
   * Consumes reservations and creates InventoryMovement records for audit.
   * If reservations expired, checks current stock:
   * - If stock is available, re-deducts stock and fulfills.
   * - If stock is no longer available, marks order as `requiresManualReview = true`.
   */
  async consumeOrReconcileReservations(orderId) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          reservations: true,
          items: true,
        },
      });

      if (!order) {
        const error = new Error(`Order ${orderId} not found`);
        error.statusCode = 404;
        throw error;
      }

      const activeReservations = order.reservations.filter((r) => r.status === 'ACTIVE');
      const hasExpired = order.reservations.some((r) => r.status === 'EXPIRED');

      if (activeReservations.length === order.items.length) {
        // Normal path: all reservations are still ACTIVE
        for (const res of activeReservations) {
          await tx.inventoryReservation.update({
            where: { id: res.id },
            data: { status: 'CONSUMED' },
          });

          await tx.inventoryMovement.create({
            data: {
              productId: res.productId,
              quantity: -res.quantity,
              type: 'SALE',
              reference: order.id,
            },
          });
        }

        return { success: true, requiresManualReview: false };
      }

      // Late payment after reservation expiry scenario
      let canFulfill = true;
      for (const item of order.items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { stock: true },
        });

        if (!product || product.stock < item.quantity) {
          canFulfill = false;
          break;
        }
      }

      if (canFulfill) {
        // Deduct from remaining stock
        for (const item of order.items) {
          await tx.product.update({
            where: { id: item.productId },
            data: {
              stock: { decrement: item.quantity },
            },
          });

          await tx.inventoryMovement.create({
            data: {
              productId: item.productId,
              quantity: -item.quantity,
              type: 'SALE',
              reference: order.id,
            },
          });
        }

        return { success: true, requiresManualReview: false };
      } else {
        // Cannot fulfill: mark order for manual review/refund without overselling
        await tx.order.update({
          where: { id: order.id },
          data: { requiresManualReview: true },
        });

        return { success: false, requiresManualReview: true };
      }
    });
  },
};
