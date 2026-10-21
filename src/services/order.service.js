import { prisma } from '../config/db.js';
import { inventoryService } from './inventory.service.js';

const ORDER_SUMMARY_SELECT = {
  id: true,
  reference: true,
  email: true,
  subtotalKobo: true,
  deliveryFeeKobo: true,
  totalKobo: true,
  currency: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  requiresManualReview: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: { items: true },
  },
};

// Deliberately excludes Payment.webhookRaw so raw gateway payloads never reach admins.
const ORDER_DETAIL_SELECT = {
  ...ORDER_SUMMARY_SELECT,
  phone: true,
  shippingAddress: true,
  items: {
    select: {
      id: true,
      productId: true,
      productName: true,
      unitPriceKobo: true,
      quantity: true,
    },
  },
  payments: {
    select: {
      id: true,
      reference: true,
      externalId: true,
      amountKobo: true,
      currency: true,
      status: true,
      gateway: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  reservations: {
    select: {
      id: true,
      productId: true,
      quantity: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  statusHistory: {
    select: {
      id: true,
      field: true,
      fromStatus: true,
      toStatus: true,
      note: true,
      createdAt: true,
      admin: {
        select: { id: true, email: true, name: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  },
};

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function assertTransitionAllowed(order, targetStatus) {
  if (targetStatus === 'PROCESSING') {
    if (order.fulfillmentStatus !== 'UNFULFILLED') {
      throw conflict(
        `Cannot move order from ${order.fulfillmentStatus} to PROCESSING`
      );
    }
    if (order.paymentStatus !== 'PAID') {
      throw conflict('Order must be paid before it can be processed');
    }
    if (order.requiresManualReview) {
      throw conflict('Order requires manual review and cannot be processed');
    }
  }

  if (targetStatus === 'FULFILLED') {
    if (order.fulfillmentStatus !== 'PROCESSING') {
      throw conflict(
        `Cannot move order from ${order.fulfillmentStatus} to FULFILLED`
      );
    }
    if (order.paymentStatus !== 'PAID') {
      throw conflict('Order must be paid before it can be fulfilled');
    }
    if (order.requiresManualReview) {
      throw conflict('Order requires manual review and cannot be fulfilled');
    }
  }

  if (targetStatus === 'CANCELLED') {
    if (!['UNFULFILLED', 'PROCESSING'].includes(order.fulfillmentStatus)) {
      throw conflict(
        `Cannot cancel an order that is already ${order.fulfillmentStatus}`
      );
    }
    if (order.paymentStatus === 'PAID') {
      throw conflict(
        'Paid orders cannot be cancelled until a refund workflow is available'
      );
    }
  }
}

export const orderService = {
  async listOrders({
    page = 1,
    limit = 20,
    status,
    paymentStatus,
    fulfillmentStatus,
    requiresManualReview,
    search,
    sort = 'newest',
  }) {
    const where = {};

    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (fulfillmentStatus) where.fulfillmentStatus = fulfillmentStatus;
    if (requiresManualReview !== undefined) {
      where.requiresManualReview = requiresManualReview;
    }
    if (search) {
      where.OR = [
        { reference: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const orderByMap = {
      newest: { createdAt: 'desc' },
      oldest: { createdAt: 'asc' },
      'total:desc': { totalKobo: 'desc' },
      'total:asc': { totalKobo: 'asc' },
    };

    const [total, orders] = await prisma.$transaction([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: orderByMap[sort],
        select: ORDER_SUMMARY_SELECT,
      }),
    ]);

    return {
      data: orders,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  },

  async getOrderByReference(reference) {
    return prisma.order.findUnique({
      where: { reference },
      select: ORDER_DETAIL_SELECT,
    });
  },

  /**
   * Applies an admin fulfilment transition. The optimistic claim on the order
   * row plus conditional reservation updates make repeated/concurrent
   * cancellations restore stock at most once.
   */
  async transitionFulfillment(reference, { status, note }, adminId) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { reference },
        select: ORDER_DETAIL_SELECT,
      });

      if (!order) {
        const error = new Error(`Order with reference '${reference}' not found`);
        error.statusCode = 404;
        throw error;
      }

      // Repeated identical transitions are safe no-ops.
      if (order.fulfillmentStatus === status) {
        return { order, isNoOp: true };
      }

      assertTransitionAllowed(order, status);

      const claimWhere = {
        id: order.id,
        fulfillmentStatus: order.fulfillmentStatus,
      };

      if (status === 'CANCELLED') {
        claimWhere.paymentStatus = { not: 'PAID' };
      } else {
        claimWhere.paymentStatus = 'PAID';
        claimWhere.requiresManualReview = false;
      }

      const claim = await tx.order.updateMany({
        where: claimWhere,
        data: {
          fulfillmentStatus: status,
          ...(status === 'CANCELLED' ? { status: 'CANCELLED' } : {}),
        },
      });

      if (claim.count !== 1) {
        throw conflict(
          'Order state changed while processing this request; reload and retry'
        );
      }

      if (status === 'CANCELLED') {
        await inventoryService.releaseOrderReservationsTx(tx, order.id);
      }

      const history = [];
      if (status === 'CANCELLED' && order.status !== 'CANCELLED') {
        history.push({
          orderId: order.id,
          adminId,
          field: 'ORDER',
          fromStatus: order.status,
          toStatus: 'CANCELLED',
          note: note ?? null,
        });
      }
      history.push({
        orderId: order.id,
        adminId,
        field: 'FULFILLMENT',
        fromStatus: order.fulfillmentStatus,
        toStatus: status,
        note: note ?? null,
      });

      await tx.orderStatusHistory.createMany({ data: history });

      const updatedOrder = await tx.order.findUnique({
        where: { reference },
        select: ORDER_DETAIL_SELECT,
      });

      return { order: updatedOrder, isNoOp: false };
    });
  },
};
