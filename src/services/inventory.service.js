import { prisma } from '../config/db.js';
import { env } from '../config/env.js';

const INVENTORY_INSUFFICIENT_STOCK = 'INVENTORY_INSUFFICIENT_STOCK';

function insufficientStockError() {
  const error = new Error(
    'Insufficient stock or unresolvable items while reconciling paid order'
  );
  error.code = INVENTORY_INSUFFICIENT_STOCK;
  return error;
}

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
   * Releases all ACTIVE reservations for an order inside a caller-owned
   * transaction. Each reservation is claimed with a conditional update so
   * concurrent or repeated cancellation attempts restore stock at most once.
   */
  async releaseOrderReservationsTx(tx, orderId) {
    const reservations = await tx.inventoryReservation.findMany({
      where: { orderId, status: 'ACTIVE' },
    });

    const released = [];

    for (const reservation of reservations) {
      const claim = await tx.inventoryReservation.updateMany({
        where: { id: reservation.id, status: 'ACTIVE' },
        data: { status: 'RELEASED' },
      });

      if (claim.count !== 1) {
        continue;
      }

      await tx.product.update({
        where: { id: reservation.productId },
        data: { stock: { increment: reservation.quantity } },
      });

      released.push(reservation);
    }

    return released;
  },

  /**
   * Releases all expired ACTIVE reservations and restores inventory.
   * The ACTIVE -> EXPIRED transition is claimed conditionally so concurrent
   * sweepers, cancellations, or payments cannot restore the same stock twice.
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
        const claim = await tx.inventoryReservation.updateMany({
          where: {
            id: res.id,
            status: 'ACTIVE',
            expiresAt: { lt: now },
          },
          data: { status: 'EXPIRED' },
        });

        if (claim.count !== 1) {
          return null;
        }

        await tx.product.update({
          where: { id: res.productId },
          data: { stock: { increment: res.quantity } },
        });

        return { ...res, status: 'EXPIRED' };
      });

      if (result) {
        released.push(result);
      }
    }

    return released;
  },

  /**
   * Idempotently reconciles inventory for a paid order.
   *
   * The order row is claimed with `inventoryReconciledAt = NULL` so only one
   * request performs the side effects. Already CONSUMED reservations count as
   * covered; ACTIVE reservations are conditionally consumed; only the
   * remaining shortage is deducted from current stock. The claim and all stock
   * or movement writes roll back together on failure, allowing a safe retry.
   */
  async reconcilePaidOrderInventory(orderId) {
    try {
      return await prisma.$transaction(async (tx) => {
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

        if (
          order.status === 'CANCELLED' ||
          order.fulfillmentStatus === 'CANCELLED'
        ) {
          if (!order.requiresManualReview || !order.inventoryReconciledAt) {
            await tx.order.update({
              where: { id: order.id },
              data: {
                requiresManualReview: true,
                ...(order.inventoryReconciledAt
                  ? {}
                  : { inventoryReconciledAt: new Date() }),
              },
            });
          }

          return {
            success: false,
            requiresManualReview: true,
            cancelled: true,
            alreadyReconciled: Boolean(order.inventoryReconciledAt),
          };
        }

        if (order.paymentStatus !== 'PAID') {
          return {
            success: false,
            requiresManualReview: order.requiresManualReview,
            notPaid: true,
            alreadyReconciled: false,
          };
        }

        const claim = await tx.order.updateMany({
          where: {
            id: orderId,
            paymentStatus: 'PAID',
            inventoryReconciledAt: null,
            status: { not: 'CANCELLED' },
            fulfillmentStatus: { not: 'CANCELLED' },
          },
          data: { inventoryReconciledAt: new Date() },
        });

        if (claim.count === 0) {
          const current = await tx.order.findUnique({
            where: { id: orderId },
            select: {
              status: true,
              fulfillmentStatus: true,
              requiresManualReview: true,
              inventoryReconciledAt: true,
            },
          });

          if (!current) {
            const error = new Error(`Order ${orderId} not found`);
            error.statusCode = 404;
            throw error;
          }

          const isCancelled =
            current.status === 'CANCELLED' ||
            current.fulfillmentStatus === 'CANCELLED';

          return {
            success: !isCancelled && !current.requiresManualReview,
            requiresManualReview:
              isCancelled || current.requiresManualReview,
            cancelled: isCancelled,
            alreadyReconciled: Boolean(current.inventoryReconciledAt),
          };
        }

        const requiredByProduct = new Map();
        for (const item of order.items) {
          if (!item.productId) {
            throw insufficientStockError();
          }

          requiredByProduct.set(
            item.productId,
            (requiredByProduct.get(item.productId) || 0) + item.quantity
          );
        }

        const coveredByProduct = new Map();
        for (const reservation of order.reservations) {
          if (reservation.status === 'CONSUMED') {
            coveredByProduct.set(
              reservation.productId,
              (coveredByProduct.get(reservation.productId) || 0) +
                reservation.quantity
            );
          }
        }

        for (const reservation of order.reservations) {
          if (reservation.status !== 'ACTIVE') {
            continue;
          }

          const required = requiredByProduct.get(reservation.productId) || 0;
          const covered = coveredByProduct.get(reservation.productId) || 0;

          if (covered >= required) {
            continue;
          }

          const reservationClaim = await tx.inventoryReservation.updateMany({
            where: { id: reservation.id, status: 'ACTIVE' },
            data: { status: 'CONSUMED' },
          });

          if (reservationClaim.count !== 1) {
            continue;
          }

          coveredByProduct.set(
            reservation.productId,
            covered + reservation.quantity
          );

          await tx.inventoryMovement.create({
            data: {
              productId: reservation.productId,
              quantity: -reservation.quantity,
              type: 'SALE',
              reference: order.id,
              dedupeKey: `sale:${order.id}:reservation:${reservation.id}`,
            },
          });
        }

        for (const [productId, requiredQuantity] of requiredByProduct.entries()) {
          const shortage =
            requiredQuantity - (coveredByProduct.get(productId) || 0);

          if (shortage <= 0) {
            continue;
          }

          const decrement = await tx.product.updateMany({
            where: {
              id: productId,
              stock: { gte: shortage },
            },
            data: { stock: { decrement: shortage } },
          });

          if (decrement.count !== 1) {
            throw insufficientStockError();
          }

          await tx.inventoryMovement.create({
            data: {
              productId,
              quantity: -shortage,
              type: 'SALE',
              reference: order.id,
              dedupeKey: `sale:${order.id}:shortage:${productId}`,
            },
          });
        }

        return {
          success: true,
          requiresManualReview: false,
          alreadyReconciled: false,
        };
      });
    } catch (err) {
      if (err.code !== INVENTORY_INSUFFICIENT_STOCK) {
        throw err;
      }

      const marked = await prisma.order.updateMany({
        where: {
          id: orderId,
          paymentStatus: 'PAID',
          inventoryReconciledAt: null,
          status: { not: 'CANCELLED' },
          fulfillmentStatus: { not: 'CANCELLED' },
        },
        data: {
          requiresManualReview: true,
          inventoryReconciledAt: new Date(),
        },
      });

      return {
        success: false,
        requiresManualReview: true,
        insufficientStock: true,
        alreadyReconciled: marked.count === 0,
      };
    }
  },

  async consumeOrReconcileReservations(orderId) {
    return inventoryService.reconcilePaidOrderInventory(orderId);
  },
};
