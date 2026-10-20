import crypto from 'node:crypto';
import { prisma } from '../config/db.js';
import { paystackClient } from '../utils/paystack.client.js';
import { inventoryService } from './inventory.service.js';

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

    // Idempotency: if already SUCCESS, return early
    if (payment.status === 'SUCCESS' && payment.order.paymentStatus === 'PAID') {
      return {
        isAlreadyProcessed: true,
        payment,
        order: payment.order,
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
      // Re-fetch inside transaction for concurrency safety
      const currentPayment = await tx.payment.findUnique({
        where: { id: payment.id },
      });

      if (currentPayment.status === 'SUCCESS') {
        return { isAlreadyProcessed: true };
      }

      // Update payment record
      const updatedPayment = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'SUCCESS',
          externalId: paystackData.id ? String(paystackData.id) : null,
        },
      });

      // Update order status
      const updatedOrder = await tx.order.update({
        where: { id: payment.orderId },
        data: {
          paymentStatus: 'PAID',
          status: 'CONFIRMED',
        },
      });

      return {
        isAlreadyProcessed: false,
        payment: updatedPayment,
        order: updatedOrder,
      };
    });

    if (result.isAlreadyProcessed) {
      return result;
    }

    // 5. Reconcile or consume inventory reservations
    const reconciliation = await inventoryService.consumeOrReconcileReservations(payment.orderId);

    return {
      isAlreadyProcessed: false,
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

    // If already processed, respond safely and idempotently
    if (payment.status === 'SUCCESS') {
      return { handled: true, isDuplicate: true };
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
