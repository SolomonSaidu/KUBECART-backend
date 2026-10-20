import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import app from '../src/app.js';
import { prisma } from '../src/config/db.js';
import { paystackClient } from '../src/utils/paystack.client.js';
import { paymentService } from '../src/services/payment.service.js';
import { inventoryService } from '../src/services/inventory.service.js';
import { env } from '../src/config/env.js';

describe('Milestone 7 — Paystack Integration', () => {
  const dummyOrderId = '123e4567-e89b-12d3-a456-426614174099';
  const dummyOrderRef = 'KBC-TEST123456';
  const dummyPaymentRef = 'PAY-KBC-TEST123456-ABCD1234';

  beforeEach(() => {
    vi.restoreAllMocks();
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

      const mockTx = {
        payment: {
          findUnique: vi.fn().mockResolvedValue(mockPayment),
          update: vi.fn().mockResolvedValue({ ...mockPayment, status: 'SUCCESS' }),
        },
        order: {
          update: vi.fn().mockResolvedValue({ ...mockPayment.order, paymentStatus: 'PAID', status: 'CONFIRMED' }),
        },
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));
      vi.spyOn(inventoryService, 'consumeOrReconcileReservations').mockResolvedValue({
        success: true,
        requiresManualReview: false,
      });

      const res = await request(app).get(`/api/v1/payments/verify/${dummyPaymentRef}`);

      expect(res.status).toBe(200);
      expect(mockTx.payment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { status: 'SUCCESS', externalId: '998877' },
      });
      expect(mockTx.order.update).toHaveBeenCalledWith({
        where: { id: dummyOrderId },
        data: { paymentStatus: 'PAID', status: 'CONFIRMED' },
      });
      expect(inventoryService.consumeOrReconcileReservations).toHaveBeenCalledWith(dummyOrderId);
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
          update: vi.fn().mockResolvedValue({ ...mockPayment, status: 'SUCCESS' }),
        },
        order: {
          update: vi.fn().mockResolvedValue({ ...mockPayment.order, paymentStatus: 'PAID' }),
        },
      };
      vi.spyOn(prisma, '$transaction').mockImplementation(async (cb) => cb(mockTx));
      vi.spyOn(inventoryService, 'consumeOrReconcileReservations').mockResolvedValue({
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
        reference: dummyPaymentRef,
        status: 'SUCCESS',
      });

      const verifySpy = vi.spyOn(paystackClient, 'verifyTransaction');

      const res = await request(app)
        .post('/api/v1/payments/webhook')
        .set('x-paystack-signature', signature)
        .set('Content-Type', 'application/json')
        .send(payloadString);

      expect(res.status).toBe(200);
      expect(res.body.handled).toBe(true);
      expect(res.body.isDuplicate).toBe(true);
      expect(verifySpy).not.toHaveBeenCalled();
    });
  });
});
