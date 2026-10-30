import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import app from '../src/app.js';
import { prisma } from '../src/config/db.js';
import { paystackClient } from '../src/utils/paystack.client.js';
import { paymentService } from '../src/services/payment.service.js';
import { inventoryService } from '../src/services/inventory.service.js';
import { orderEmailService } from '../src/services/order-email.service.js';
import { env } from '../src/config/env.js';

describe('Milestone 7 — Paystack Integration', () => {
  const dummyOrderId = '123e4567-e89b-12d3-a456-426614174099';
  const dummyOrderRef = 'KBC-TEST123456';
  const dummyPaymentRef = 'PAY-KBC-TEST123456-ABCD1234';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(orderEmailService, 'sendOrderProcessingEmail').mockResolvedValue({
      messageId: 'unexpected-email',
    });
  });

  describe('POST /api/v1/payments/initialize', () => {
    it('successfully initializes Paystack transaction and returns authorization URL', async () => {
      const mockOrder = {
        id: dummyOrderId,
        reference: dummyOrderRef,
        email: 'customer@example.com',
        totalKobo: 500000,
        currency: 'NGN',
        paymentStatus: 'UNPAID',
        status: 'PENDING',
        reservations: [
          {
            id: 'res-1',
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          },
        ],
      };

      vi.spyOn(paymentService, 'generatePaymentReference').mockReturnValue(dummyPaymentRef);
      vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(mockOrder);
      vi.spyOn(prisma.payment, 'create').mockResolvedValue({
        id: 'pay-1',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: 'PENDING',
      });

      vi.spyOn(paystackClient, 'initializeTransaction').mockResolvedValue({
        authorization_url: 'https://checkout.paystack.com/auth_test',
        access_code: 'access_code_123',
        reference: dummyPaymentRef,
      });

      const res = await request(app)
        .post('/api/v1/payments/initialize')
        .send({
          orderReference: dummyOrderRef,
          callbackUrl: 'http://localhost:5173/callback',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.authorizationUrl).toBe('https://checkout.paystack.com/auth_test');
      expect(res.body.data.reference).toBe(dummyPaymentRef);
      expect(paystackClient.initializeTransaction).toHaveBeenCalledWith({
        email: 'customer@example.com',
        amountKobo: 500000,
        reference: dummyPaymentRef,
        callbackUrl: 'http://localhost:5173/callback',
      });
    });

    it('rejects initialization if order does not exist', async () => {
      vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(null);

      const res = await request(app)
        .post('/api/v1/payments/initialize')
        .send({ orderReference: 'KBC-NONEXISTENT' });

      expect(res.status).toBe(404);
      expect(res.body.message).toContain('not found');
    });

    it('rejects initialization if order is already paid', async () => {
      vi.spyOn(prisma.order, 'findUnique').mockResolvedValue({
        id: dummyOrderId,
        reference: dummyOrderRef,
        paymentStatus: 'PAID',
        reservations: [],
      });

      const res = await request(app)
        .post('/api/v1/payments/initialize')
        .send({ orderReference: dummyOrderRef });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('already paid');
    });

    it('rejects initialization if inventory reservations have expired', async () => {
      vi.spyOn(prisma.order, 'findUnique').mockResolvedValue({
        id: dummyOrderId,
        reference: dummyOrderRef,
        paymentStatus: 'UNPAID',
        status: 'PENDING',
        reservations: [
          {
            id: 'res-1',
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() - 1000), // Expired
          },
        ],
      });

      const res = await request(app)
        .post('/api/v1/payments/initialize')
        .send({ orderReference: dummyOrderRef });

      expect(res.status).toBe(410);
      expect(res.body.message).toContain('expired');
    });
  });

  describe('GET /api/v1/payments/verify/:reference', () => {
    it('verifies successful Paystack transaction and marks order PAID transactionally', async () => {
      const mockPayment = {
        id: 'pay-1',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: 'PENDING',
        order: {
          id: dummyOrderId,
          paymentStatus: 'UNPAID',
          status: 'PENDING',
          items: [],
          reservations: [],
        },
      };

      vi.spyOn(prisma.payment, 'findUnique').mockResolvedValue(mockPayment);
      vi.spyOn(paystackClient, 'verifyTransaction').mockResolvedValue({
        status: 'success',
        id: 998877,
        reference: dummyPaymentRef,
        amount: 500000,
        currency: 'NGN',
      });

      const updatedOrder = {
        ...mockPayment.order,
        paymentStatus: 'PAID',
        status: 'CONFIRMED',
      };

      const mockTx = {
        payment: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(mockPayment)
            .mockResolvedValueOnce({ ...mockPayment, status: 'SUCCESS' }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
        order: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(mockPayment.order)
            .mockResolvedValueOnce(updatedOrder),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
        orderStatusHistory: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));
      vi.spyOn(inventoryService, 'reconcilePaidOrderInventory').mockResolvedValue({
        success: true,
        requiresManualReview: false,
      });

      const res = await request(app).get(`/api/v1/payments/verify/${dummyPaymentRef}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isCancelledOrder).toBe(false);
      expect(orderEmailService.sendOrderProcessingEmail).not.toHaveBeenCalled();
      expect(res.body.data.reconciliation.success).toBe(true);
      expect(mockTx.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-1', status: { not: 'SUCCESS' } },
        data: { status: 'SUCCESS', externalId: '998877' },
      });
      expect(mockTx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: dummyOrderId,
          status: { not: 'CANCELLED' },
          fulfillmentStatus: { not: 'CANCELLED' },
        },
        data: { paymentStatus: 'PAID', status: 'CONFIRMED' },
      });
      expect(mockTx.order.update).not.toHaveBeenCalled();
      expect(inventoryService.reconcilePaidOrderInventory).toHaveBeenCalledWith(dummyOrderId);
      expect(mockTx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: dummyOrderId,
          field: 'PAYMENT',
          fromStatus: 'UNPAID',
          toStatus: 'PAID',
          note: null,
        },
      });
      expect(mockTx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: dummyOrderId,
          field: 'ORDER',
          fromStatus: 'PENDING',
          toStatus: 'CONFIRMED',
        },
      });
    });

    it('keeps an already cancelled order cancelled when payment is verified late', async () => {
      const cancelledOrder = {
        id: dummyOrderId,
        paymentStatus: 'UNPAID',
        status: 'CANCELLED',
        fulfillmentStatus: 'CANCELLED',
        requiresManualReview: false,
        items: [],
        reservations: [{ id: 'res-1', status: 'RELEASED' }],
      };

      const mockPayment = {
        id: 'pay-late',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: 'PENDING',
        order: cancelledOrder,
      };

      const updatedOrder = {
        ...cancelledOrder,
        paymentStatus: 'PAID',
        requiresManualReview: true,
      };

      vi.spyOn(prisma.payment, 'findUnique').mockResolvedValue(mockPayment);
      vi.spyOn(paystackClient, 'verifyTransaction').mockResolvedValue({
        status: 'success',
        id: 998877,
        reference: dummyPaymentRef,
        amount: 500000,
        currency: 'NGN',
      });

      const mockTx = {
        payment: {
          findUnique: vi.fn().mockResolvedValue(mockPayment),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
        order: {
          findUnique: vi.fn().mockResolvedValue(cancelledOrder),
          updateMany: vi.fn(),
          update: vi.fn().mockResolvedValue(updatedOrder),
        },
        orderStatusHistory: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));
      const reconcileSpy = vi
        .spyOn(inventoryService, 'reconcilePaidOrderInventory')
        .mockResolvedValue({ success: true, requiresManualReview: false });

      const res = await request(app).get(`/api/v1/payments/verify/${dummyPaymentRef}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isCancelledOrder).toBe(true);
      expect(res.body.data.reconciliation).toEqual({
        success: false,
        requiresManualReview: true,
        skipped: true,
        reason: 'Order is cancelled; verified payment requires manual refund review',
      });

      expect(mockTx.payment.updateMany).toHaveBeenCalledWith({
        where: { id: 'pay-late', status: { not: 'SUCCESS' } },
        data: { status: 'SUCCESS', externalId: '998877' },
      });
      expect(mockTx.order.updateMany).not.toHaveBeenCalled();
      expect(mockTx.order.update).toHaveBeenCalledWith({
        where: { id: dummyOrderId },
        data: {
          paymentStatus: 'PAID',
          requiresManualReview: true,
          inventoryReconciledAt: expect.any(Date),
        },
      });
      expect(mockTx.order.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CONFIRMED' }),
        })
      );
      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(mockTx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: dummyOrderId,
          field: 'PAYMENT',
          fromStatus: 'UNPAID',
          toStatus: 'PAID',
          note: 'Verified payment received for a cancelled order; manual refund review required',
        },
      });
      expect(mockTx.orderStatusHistory.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ field: 'ORDER' }),
        })
      );
    });

    it('handles a cancellation racing with verification without reconfirming the order', async () => {
      const activeOrder = {
        id: dummyOrderId,
        paymentStatus: 'UNPAID',
        status: 'PENDING',
        fulfillmentStatus: 'UNFULFILLED',
        requiresManualReview: false,
        items: [],
        reservations: [{ id: 'res-1', status: 'ACTIVE' }],
      };

      const mockPayment = {
        id: 'pay-race',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: 'PENDING',
        order: activeOrder,
      };

      const cancelledOrder = {
        ...activeOrder,
        status: 'CANCELLED',
        fulfillmentStatus: 'CANCELLED',
        paymentStatus: 'PAID',
        requiresManualReview: true,
      };

      vi.spyOn(prisma.payment, 'findUnique').mockResolvedValue(mockPayment);
      vi.spyOn(paystackClient, 'verifyTransaction').mockResolvedValue({
        status: 'success',
        id: 998877,
        reference: dummyPaymentRef,
        amount: 500000,
        currency: 'NGN',
      });

      const mockTx = {
        payment: {
          findUnique: vi.fn().mockResolvedValue(mockPayment),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
        order: {
          findUnique: vi.fn().mockResolvedValue(activeOrder),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          update: vi.fn().mockResolvedValue(cancelledOrder),
        },
        orderStatusHistory: {
          create: vi.fn().mockResolvedValue({}),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));
      const reconcileSpy = vi
        .spyOn(inventoryService, 'reconcilePaidOrderInventory')
        .mockResolvedValue({ success: true, requiresManualReview: false });

      const res = await request(app).get(`/api/v1/payments/verify/${dummyPaymentRef}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isCancelledOrder).toBe(true);
      expect(mockTx.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: dummyOrderId,
          status: { not: 'CANCELLED' },
          fulfillmentStatus: { not: 'CANCELLED' },
        },
        data: { paymentStatus: 'PAID', status: 'CONFIRMED' },
      });
      expect(mockTx.order.update).toHaveBeenCalledWith({
        where: { id: dummyOrderId },
        data: {
          paymentStatus: 'PAID',
          requiresManualReview: true,
          inventoryReconciledAt: expect.any(Date),
        },
      });
      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(res.body.data.order.status).toBe('CANCELLED');
    });

    it('recovers pending inventory reconciliation for an already successful payment', async () => {
      vi.spyOn(prisma.payment, 'findUnique').mockResolvedValue({
        id: 'pay-recovery',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: 'SUCCESS',
        order: {
          id: dummyOrderId,
          paymentStatus: 'PAID',
          status: 'CONFIRMED',
          fulfillmentStatus: 'UNFULFILLED',
          requiresManualReview: false,
          inventoryReconciledAt: null,
          items: [],
          reservations: [],
        },
      });

      const verifySpy = vi.spyOn(paystackClient, 'verifyTransaction');
      const reconcileSpy = vi
        .spyOn(inventoryService, 'reconcilePaidOrderInventory')
        .mockResolvedValue({ success: true, requiresManualReview: false });

      const res = await request(app).get(`/api/v1/payments/verify/${dummyPaymentRef}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isAlreadyProcessed).toBe(true);
      expect(res.body.data.reconciliation.success).toBe(true);
      expect(verifySpy).not.toHaveBeenCalled();
      expect(reconcileSpy).toHaveBeenCalledWith(dummyOrderId);
    });

    it('processes concurrent duplicate verifications exactly once', async () => {
      const state = {
        paymentStatus: 'PENDING',
        orderStatus: 'PENDING',
        orderPaymentStatus: 'UNPAID',
        historyRows: 0,
        orderTransitions: 0,
      };

      let lock = Promise.resolve();
      const serialize = (fn) => {
        const run = lock.then(fn, fn);
        lock = run.catch(() => {});
        return run;
      };

      const baseOrder = {
        id: dummyOrderId,
        status: 'PENDING',
        fulfillmentStatus: 'UNFULFILLED',
        paymentStatus: 'UNPAID',
        requiresManualReview: false,
        inventoryReconciledAt: null,
        items: [],
        reservations: [],
      };

      vi.spyOn(prisma.payment, 'findUnique').mockResolvedValue({
        id: 'pay-race',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: 'PENDING',
        order: baseOrder,
      });

      vi.spyOn(paystackClient, 'verifyTransaction').mockResolvedValue({
        status: 'success',
        id: 998877,
        reference: dummyPaymentRef,
        amount: 500000,
        currency: 'NGN',
      });

      const reconcileSpy = vi
        .spyOn(inventoryService, 'reconcilePaidOrderInventory')
        .mockResolvedValue({ success: true, requiresManualReview: false });

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) =>
        serialize(async () =>
          callback({
            payment: {
              findUnique: vi.fn(async () => ({
                id: 'pay-race',
                orderId: dummyOrderId,
                reference: dummyPaymentRef,
                status: state.paymentStatus,
              })),
              updateMany: vi.fn(async () => {
                if (state.paymentStatus === 'SUCCESS') return { count: 0 };
                state.paymentStatus = 'SUCCESS';
                return { count: 1 };
              }),
            },
            order: {
              findUnique: vi.fn(async () => ({
                ...baseOrder,
                status: state.orderStatus,
                paymentStatus: state.orderPaymentStatus,
              })),
              updateMany: vi.fn(async () => {
                if (state.orderStatus === 'CANCELLED') return { count: 0 };
                state.orderStatus = 'CONFIRMED';
                state.orderPaymentStatus = 'PAID';
                state.orderTransitions += 1;
                return { count: 1 };
              }),
            },
            orderStatusHistory: {
              create: vi.fn(async () => {
                state.historyRows += 1;
              }),
            },
          })
        )
      );

      const [first, second] = await Promise.all([
        paymentService.verifyPayment(dummyPaymentRef),
        paymentService.verifyPayment(dummyPaymentRef),
      ]);

      expect(
        [first.isAlreadyProcessed, second.isAlreadyProcessed].sort()
      ).toEqual([false, true]);
      expect(state.paymentStatus).toBe('SUCCESS');
      expect(state.orderStatus).toBe('CONFIRMED');
      expect(state.orderPaymentStatus).toBe('PAID');
      expect(state.orderTransitions).toBe(1);
      expect(state.historyRows).toBe(3);
      expect(reconcileSpy).toHaveBeenCalledTimes(2);
    });

    it('rejects verification if amount in minor units does not match expected amount', async () => {
      const mockPayment = {
        id: 'pay-1',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: 'PENDING',
        order: { id: dummyOrderId, paymentStatus: 'UNPAID' },
      };

      vi.spyOn(prisma.payment, 'findUnique').mockResolvedValue(mockPayment);
      vi.spyOn(prisma.payment, 'update').mockResolvedValue({});
      vi.spyOn(prisma.order, 'update').mockResolvedValue({});

      vi.spyOn(paystackClient, 'verifyTransaction').mockResolvedValue({
        status: 'success',
        id: 998877,
        reference: dummyPaymentRef,
        amount: 200000, // Tampered or wrong amount!
        currency: 'NGN',
      });

      const res = await request(app).get(`/api/v1/payments/verify/${dummyPaymentRef}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('amount mismatch');
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: dummyOrderId },
        data: { requiresManualReview: true },
      });
    });

    it('rejects verification if currency does not match NGN', async () => {
      const mockPayment = {
        id: 'pay-1',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: 'PENDING',
        order: { id: dummyOrderId, paymentStatus: 'UNPAID' },
      };

      vi.spyOn(prisma.payment, 'findUnique').mockResolvedValue(mockPayment);
      vi.spyOn(prisma.payment, 'update').mockResolvedValue({});
      vi.spyOn(prisma.order, 'update').mockResolvedValue({});

      vi.spyOn(paystackClient, 'verifyTransaction').mockResolvedValue({
        status: 'success',
        id: 998877,
        reference: dummyPaymentRef,
        amount: 500000,
        currency: 'USD', // Currency mismatch!
      });

      const res = await request(app).get(`/api/v1/payments/verify/${dummyPaymentRef}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('currency mismatch');
    });

    it('rejects verification if Paystack transaction status is failed or pending', async () => {
      const mockPayment = {
        id: 'pay-1',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: 'PENDING',
        order: { id: dummyOrderId, paymentStatus: 'UNPAID' },
      };

      vi.spyOn(prisma.payment, 'findUnique').mockResolvedValue(mockPayment);
      vi.spyOn(prisma.payment, 'update').mockResolvedValue({});

      vi.spyOn(paystackClient, 'verifyTransaction').mockResolvedValue({
        status: 'failed',
        id: 998877,
        reference: dummyPaymentRef,
        amount: 500000,
        currency: 'NGN',
      });

      const res = await request(app).get(`/api/v1/payments/verify/${dummyPaymentRef}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Payment not successful');
    });
  });

  describe('POST /api/v1/payments/webhook', () => {
    it('rejects webhook with invalid HMAC-SHA512 signature', async () => {
      const payload = JSON.stringify({ event: 'charge.success', data: { reference: dummyPaymentRef } });

      const res = await request(app)
        .post('/api/v1/payments/webhook')
        .set('x-paystack-signature', 'invalid_signature_hash')
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.message).toContain('Invalid Paystack webhook signature');
    });

    it('processes verified charge.success webhook and marks payment SUCCESS', async () => {
      const payloadObj = {
        event: 'charge.success',
        data: {
          id: 112233,
          reference: dummyPaymentRef,
          amount: 500000,
          currency: 'NGN',
          status: 'success',
        },
      };

      const payloadString = JSON.stringify(payloadObj);
      const signature = crypto
        .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
        .update(payloadString)
        .digest('hex');

      const mockPayment = {
        id: 'pay-1',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: 'PENDING',
        order: {
          id: dummyOrderId,
          paymentStatus: 'UNPAID',
          status: 'PENDING',
          items: [],
          reservations: [],
        },
      };

      vi.spyOn(prisma.payment, 'findUnique').mockResolvedValue(mockPayment);
      vi.spyOn(prisma.payment, 'update').mockResolvedValue(mockPayment);
      vi.spyOn(paystackClient, 'verifyTransaction').mockResolvedValue(payloadObj.data);

      const mockTx = {
        payment: {
          findUnique: vi.fn().mockResolvedValue(mockPayment),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
        order: {
          findUnique: vi
            .fn()
            .mockResolvedValueOnce(mockPayment.order)
            .mockResolvedValueOnce({
              ...mockPayment.order,
              paymentStatus: 'PAID',
              status: 'CONFIRMED',
            }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          update: vi.fn(),
        },
        orderStatusHistory: {
          create: vi.fn().mockResolvedValue({}),
        },
      };
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));
      vi.spyOn(inventoryService, 'reconcilePaidOrderInventory').mockResolvedValue({
        success: true,
        requiresManualReview: false,
      });

      const res = await request(app)
        .post('/api/v1/payments/webhook')
        .set('x-paystack-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      expect(res.body.isDuplicate).toBe(false);
    });

    it('processes concurrent duplicate webhook events exactly once', async () => {
      const state = {
        paymentStatus: 'PENDING',
        orderStatus: 'PENDING',
        orderPaymentStatus: 'UNPAID',
        historyRows: 0,
        orderTransitions: 0,
      };

      let lock = Promise.resolve();
      const serialize = (fn) => {
        const run = lock.then(fn, fn);
        lock = run.catch(() => {});
        return run;
      };

      const baseOrder = {
        id: dummyOrderId,
        status: 'PENDING',
        fulfillmentStatus: 'UNFULFILLED',
        paymentStatus: 'UNPAID',
        requiresManualReview: false,
        inventoryReconciledAt: null,
        items: [],
        reservations: [],
      };

      vi.spyOn(prisma.payment, 'findUnique').mockImplementation(async () => ({
        id: 'pay-webhook-race',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        amountKobo: 500000,
        currency: 'NGN',
        status: state.paymentStatus,
        order: baseOrder,
      }));
      vi.spyOn(prisma.payment, 'update').mockResolvedValue({});

      vi.spyOn(paystackClient, 'verifyTransaction').mockResolvedValue({
        status: 'success',
        id: 998877,
        reference: dummyPaymentRef,
        amount: 500000,
        currency: 'NGN',
      });

      vi.spyOn(inventoryService, 'reconcilePaidOrderInventory').mockResolvedValue({
        success: true,
        requiresManualReview: false,
      });

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) =>
        serialize(async () =>
          callback({
            payment: {
              findUnique: vi.fn(async () => ({
                id: 'pay-webhook-race',
                orderId: dummyOrderId,
                reference: dummyPaymentRef,
                status: state.paymentStatus,
              })),
              updateMany: vi.fn(async () => {
                if (state.paymentStatus === 'SUCCESS') return { count: 0 };
                state.paymentStatus = 'SUCCESS';
                return { count: 1 };
              }),
            },
            order: {
              findUnique: vi.fn(async () => ({
                ...baseOrder,
                status: state.orderStatus,
                paymentStatus: state.orderPaymentStatus,
              })),
              updateMany: vi.fn(async () => {
                if (state.orderStatus === 'CANCELLED') return { count: 0 };
                state.orderStatus = 'CONFIRMED';
                state.orderPaymentStatus = 'PAID';
                state.orderTransitions += 1;
                return { count: 1 };
              }),
            },
            orderStatusHistory: {
              create: vi.fn(async () => {
                state.historyRows += 1;
              }),
            },
          })
        )
      );

      const event = {
        event: 'charge.success',
        data: {
          id: 998877,
          reference: dummyPaymentRef,
          amount: 500000,
          currency: 'NGN',
          status: 'success',
        },
      };

      const results = await Promise.all([
        paymentService.processWebhookEvent(event),
        paymentService.processWebhookEvent(event),
      ]);

      expect(results.every((r) => r.handled)).toBe(true);
      expect(state.paymentStatus).toBe('SUCCESS');
      expect(state.orderStatus).toBe('CONFIRMED');
      expect(state.orderTransitions).toBe(1);
      expect(state.historyRows).toBe(3);
    });

    it('handles duplicate webhook event idempotently without re-processing', async () => {
      const payloadObj = {
        event: 'charge.success',
        data: {
          id: 112233,
          reference: dummyPaymentRef,
          amount: 500000,
          currency: 'NGN',
          status: 'success',
        },
      };

      const payloadString = JSON.stringify(payloadObj);
      const signature = crypto
        .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
        .update(payloadString)
        .digest('hex');

      // Payment already SUCCESS
      vi.spyOn(prisma.payment, 'findUnique').mockResolvedValue({
        id: 'pay-1',
        orderId: dummyOrderId,
        reference: dummyPaymentRef,
        status: 'SUCCESS',
      });
      vi.spyOn(prisma.order, 'findUnique').mockResolvedValue({
        id: dummyOrderId,
        status: 'CONFIRMED',
        fulfillmentStatus: 'UNFULFILLED',
        paymentStatus: 'PAID',
        requiresManualReview: false,
      });

      const verifySpy = vi.spyOn(paystackClient, 'verifyTransaction');
      const reconcileSpy = vi
        .spyOn(inventoryService, 'reconcilePaidOrderInventory')
        .mockResolvedValue({ success: true, requiresManualReview: false });

      const res = await request(app)
        .post('/api/v1/payments/webhook')
        .set('x-paystack-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(res.status).toBe(200);
      expect(res.body.handled).toBe(true);
      expect(res.body.isDuplicate).toBe(true);
      expect(verifySpy).not.toHaveBeenCalled();
      expect(reconcileSpy).toHaveBeenCalledWith(dummyOrderId);
    });
  });
});
