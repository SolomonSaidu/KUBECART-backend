import crypto from 'node:crypto';
import { prisma } from '../config/db.js';
import { paystackClient } from '../utils/paystack.client.js';
import { inventoryService } from './inventory.service.js';

function cancelledReconciliation() {
  return {
    success: false,
    requiresManualReview: true,
    skipped: true,
    reason: 'Order is cancelled; verified payment requires manual refund review',
  };
}

export const paymentService = {
  /**
   * Generates a unique payment reference tied to an order.
   */
  generatePaymentReference(orderReference) {
    const randomSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `PAY-${orderReference}-${randomSuffix}`;
  },

  /**
   * Initializes a payment for an order.
   * Note: We NEVER hold an open database transaction while making network calls to Paystack.
   */
  async initializePayment({ orderReference, callbackUrl }) {
    // 1. Fetch order
    const order = await prisma.order.findUnique({
      where: { reference: orderReference },
      include: {
        reservations: true,
      },
    });

    if (!order) {
      const error = new Error(`Order with reference '${orderReference}' not found`);
      error.statusCode = 404;
      throw error;
    }

    if (order.paymentStatus === 'PAID') {
      const error = new Error('Order is already paid');
      error.statusCode = 400;
      throw error;
    }

    if (order.status === 'CANCELLED') {
      const error = new Error('Cannot pay for a cancelled order');
      error.statusCode = 400;
      throw error;
    }

    // Check if there are active reservations
    const hasActiveReservation = order.reservations.some(
      (r) => r.status === 'ACTIVE' && new Date(r.expiresAt) > new Date()
    );

    if (!hasActiveReservation && order.reservations.length > 0) {
      const error = new Error('Inventory reservations for this order have expired. Please create a new order.');
      error.statusCode = 410; // Gone / Expired
      throw error;
    }

    // 2. Generate unique payment reference
    const paymentReference = this.generatePaymentReference(order.reference);

    // 3. Persist pending payment record in database before contacting Paystack
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        reference: paymentReference,
        amountKobo: order.totalKobo,
        currency: order.currency,
        status: 'PENDING',
        gateway: 'PAYSTACK',
      },
    });

    // 4. Call Paystack outside of any database transaction
    try {
      const paystackData = await paystackClient.initializeTransaction({
        email: order.email,
        amountKobo: order.totalKobo,
        reference: paymentReference,
        callbackUrl,
      });

      return {
        paymentId: payment.id,
        reference: paymentReference,
        authorizationUrl: paystackData.authorization_url,
        accessCode: paystackData.access_code,
      };
    } catch (err) {
      // Mark payment failed if initialization failed
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED' },
      });
      throw err;
    }
  },

  /**
   * Verifies payment server-side and finalizes order/inventory state transactionally.
   */
  async verifyPayment(paymentReference) {
    // 1. Fetch local payment record and associated order
    const payment = await prisma.payment.findUnique({
      where: { reference: paymentReference },
      include: {
        order: {
          include: {
            items: true,
            reservations: true,
          },
        },
      },
    });

    if (!payment) {
      const error = new Error(`Payment with reference '${paymentReference}' not found`);
      error.statusCode = 404;
      throw error;
    }

    // Idempotency: if already SUCCESS, recover any pending inventory work.
    if (payment.status === 'SUCCESS' && payment.order.paymentStatus === 'PAID') {
      const isCancelledOrder =
        payment.order.status === 'CANCELLED' ||
        payment.order.fulfillmentStatus === 'CANCELLED';

      const reconciliation = isCancelledOrder
        ? cancelledReconciliation()
        : await inventoryService.reconcilePaidOrderInventory(payment.orderId);

      return {
        isAlreadyProcessed: true,
        isCancelledOrder,
        payment,
        order: payment.order,
        reconciliation,
      };
    }

    // 2. Call Paystack verify endpoint (outside DB transaction)
    const paystackData = await paystackClient.verifyTransaction(paymentReference);

    // 3. Strict Invariant Checks:
    // a. Status must be "success"
    if (paystackData.status !== 'success') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: paystackData.status === 'failed' ? 'FAILED' : 'ABANDONED',
          externalId: paystackData.id ? String(paystackData.id) : null,
        },
      });

      const error = new Error(`Payment not successful. Paystack status: ${paystackData.status}`);
      error.statusCode = 400;
      throw error;
    }

    // b. Amount must match expected amount in kobo exactly
    if (paystackData.amount !== payment.amountKobo) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED' },
      });
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { requiresManualReview: true },
      });

      const error = new Error(
        `Payment amount mismatch: expected ${payment.amountKobo} kobo, received ${paystackData.amount} kobo`
      );
      error.statusCode = 400;
      throw error;
    }

    // c. Currency must match expected currency
    if (paystackData.currency !== payment.currency) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED' },
      });
      await prisma.order.update({
        where: { id: payment.orderId },
        data: { requiresManualReview: true },
      });

      const error = new Error(
        `Payment currency mismatch: expected ${payment.currency}, received ${paystackData.currency}`
      );
      error.statusCode = 400;
      throw error;
    }

    // 4. Update Payment, Order, and Inventory transactionally
    const result = await prisma.$transaction(async (tx) => {
      const currentPayment = await tx.payment.findUnique({
        where: { id: payment.id },
      });

      if (!currentPayment) {
        const error = new Error(`Payment ${payment.id} not found`);
        error.statusCode = 404;
        throw error;
      }

      const paymentClaim = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: { not: 'SUCCESS' },
        },
        data: {
          status: 'SUCCESS',
          externalId: paystackData.id ? String(paystackData.id) : null,
        },
      });

      if (paymentClaim.count === 0) {
        const processedPayment = await tx.payment.findUnique({
          where: { id: payment.id },
        });

        const processedOrder = await tx.order.findUnique({
          where: { id: payment.orderId },
        });

        return {
          isAlreadyProcessed: true,
          isCancelledOrder: Boolean(
            processedOrder &&
              (processedOrder.status === 'CANCELLED' ||
                processedOrder.fulfillmentStatus === 'CANCELLED')
          ),
          payment: processedPayment,
          order: processedOrder,
        };
      }

      const currentOrder = await tx.order.findUnique({
        where: { id: payment.orderId },
      });

      if (!currentOrder) {
        const error = new Error(`Order ${payment.orderId} not found`);
        error.statusCode = 404;
        throw error;
      }

      const updatedPayment = await tx.payment.findUnique({
        where: { id: payment.id },
      });

      const initiallyCancelled =
        currentOrder.status === 'CANCELLED' ||
        currentOrder.fulfillmentStatus === 'CANCELLED';

      let updatedOrder;
      let paymentReceivedForCancelledOrder = initiallyCancelled;

      if (initiallyCancelled) {
        // Money was received, but the order stays cancelled. Flag it for
        // explicit refund/manual handling instead of resurrecting the order.
        updatedOrder = await tx.order.update({
          where: { id: payment.orderId },
          data: {
            paymentStatus: 'PAID',
            requiresManualReview: true,
            inventoryReconciledAt: new Date(),
          },
        });
      } else {
        // Only confirm if the order is still active. This prevents a
        // cancellation committed concurrently from being overwritten.
        const claim = await tx.order.updateMany({
          where: {
            id: payment.orderId,
            status: { not: 'CANCELLED' },
            fulfillmentStatus: { not: 'CANCELLED' },
          },
          data: {
            paymentStatus: 'PAID',
            status: 'CONFIRMED',
          },
        });

        if (claim.count === 0) {
          // A cancellation won the race after our initial read.
          paymentReceivedForCancelledOrder = true;
          updatedOrder = await tx.order.update({
            where: { id: payment.orderId },
            data: {
              paymentStatus: 'PAID',
              requiresManualReview: true,
              inventoryReconciledAt: new Date(),
            },
          });
        } else {
          updatedOrder = await tx.order.findUnique({
            where: { id: payment.orderId },
          });

          if (!updatedOrder) {
            const error = new Error(`Order ${payment.orderId} not found`);
            error.statusCode = 404;
            throw error;
          }
        }
      }

      // Record actual transitions in the same transaction as the state changes.
      if (currentPayment.status !== 'SUCCESS') {
        await tx.orderStatusHistory.create({
          data: {
            orderId: payment.orderId,
            field: 'PAYMENT',
            fromStatus: currentPayment.status,
            toStatus: 'SUCCESS',
          },
        });
      }

      if (currentOrder.paymentStatus !== 'PAID') {
        await tx.orderStatusHistory.create({
          data: {
            orderId: payment.orderId,
            field: 'PAYMENT',
            fromStatus: currentOrder.paymentStatus,
            toStatus: 'PAID',
            note: paymentReceivedForCancelledOrder
              ? 'Verified payment received for a cancelled order; manual refund review required'
              : null,
          },
        });
      }

      if (
        !paymentReceivedForCancelledOrder &&
        currentOrder.status !== 'CONFIRMED'
      ) {
        await tx.orderStatusHistory.create({
          data: {
            orderId: payment.orderId,
            field: 'ORDER',
            fromStatus: currentOrder.status,
            toStatus: 'CONFIRMED',
          },
        });
      }

      return {
        isAlreadyProcessed: false,
        isCancelledOrder: paymentReceivedForCancelledOrder,
        payment: updatedPayment,
        order: updatedOrder,
      };
    });

    if (result.isAlreadyProcessed) {
      const reconciliation = result.isCancelledOrder
        ? cancelledReconciliation()
        : await inventoryService.reconcilePaidOrderInventory(payment.orderId);

      return { ...result, reconciliation };
    }

    // 5. Cancelled orders must never have inventory re-deducted or be fulfilled.
    if (result.isCancelledOrder) {
      return {
        ...result,
        reconciliation: cancelledReconciliation(),
      };
    }

    // 6. Reconcile or consume inventory reservations
    const reconciliation = await inventoryService.reconcilePaidOrderInventory(payment.orderId);

    return {
      isAlreadyProcessed: false,
      isCancelledOrder: false,
      payment: result.payment,
      order: result.order,
      reconciliation,
    };
  },

  /**
   * Processes verified Paystack webhook event idempotently.
   */
  async processWebhookEvent(event) {
    if (event.event !== 'charge.success') {
      // Ignore unhandled events safely
      return { handled: false, message: `Ignored event '${event.event}'` };
    }

    const { reference } = event.data;
    if (!reference) {
      return { handled: false, message: 'Missing reference in webhook payload' };
    }

    // Find the payment by reference
    const payment = await prisma.payment.findUnique({
      where: { reference },
    });

    if (!payment) {
      return { handled: false, message: `Payment with reference '${reference}' not found in database` };
    }

    // If already processed, respond safely and idempotently. A duplicate is
    // still allowed to finish inventory reconciliation if it previously failed.
    if (payment.status === 'SUCCESS') {
      const order = await prisma.order.findUnique({
        where: { id: payment.orderId },
      });

      if (!order) {
        return { handled: true, isDuplicate: true };
      }

      const isCancelled =
        order.status === 'CANCELLED' ||
        order.fulfillmentStatus === 'CANCELLED';

      const reconciliation = isCancelled
        ? cancelledReconciliation()
        : order.paymentStatus === 'PAID'
          ? await inventoryService.reconcilePaidOrderInventory(order.id)
          : undefined;

      return {
        handled: true,
        isDuplicate: true,
        ...(reconciliation ? { reconciliation } : {}),
      };
    }

    // Save webhook raw payload on payment record
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        webhookRaw: event,
      },
    });

    // Run standard verification & reconciliation logic
    const verifyResult = await this.verifyPayment(reference);
    return { handled: true, isDuplicate: false, result: verifyResult };
  },
};
