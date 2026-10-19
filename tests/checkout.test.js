import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/db.js';

describe('Milestone 5 — Checkout & Order Creation', () => {
  const dummyProdId1 = '123e4567-e89b-12d3-a456-426614174001';
  const dummyProdId2 = '123e4567-e89b-12d3-a456-426614174002';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/v1/checkout - Validation', () => {
    it('rejects checkout with missing customer email or invalid format', async () => {
      const res = await request(app)
        .post('/api/v1/checkout')
        .send({
          email: 'invalid-email',
          phone: '+2348012345678',
          shippingAddress: '123 Lagos St, Victoria Island',
          items: [{ productId: dummyProdId1, quantity: 1 }],
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('issues');
    });

    it('rejects checkout with non-positive item quantity', async () => {
      const res = await request(app)
        .post('/api/v1/checkout')
        .send({
          email: 'guest@kubecart.test',
          phone: '+2348012345678',
          shippingAddress: '123 Lagos St, Victoria Island',
          items: [{ productId: dummyProdId1, quantity: 0 }],
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('issues');
    });

    it('rejects checkout with empty items list', async () => {
      const res = await request(app)
        .post('/api/v1/checkout')
        .send({
          email: 'guest@kubecart.test',
          phone: '+2348012345678',
          shippingAddress: '123 Lagos St, Victoria Island',
          items: [],
        });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('issues');
    });
  });

  describe('POST /api/v1/checkout - Server-side Calculations & Order Creation', () => {
    it('calculates subtotal, applies flat-rate delivery fee, and snapshots items', async () => {
      // Mock active products in DB with server-authoritative prices
      vi.spyOn(prisma.product, 'findMany').mockResolvedValue([
        {
          id: dummyProdId1,
          name: 'Keyboard',
          priceKobo: 2500000, // 25,000 NGN
          isActive: true,
        },
        {
          id: dummyProdId2,
          name: 'Mousepad',
          priceKobo: 500000, // 5,000 NGN
          isActive: true,
        },
      ]);

      const mockCreatedOrder = {
        id: 'ord-123',
        reference: 'KBC-1A2B3C4D5E6F',
        email: 'guest@kubecart.test',
        phone: '+2348012345678',
        shippingAddress: '123 Lagos St',
        subtotalKobo: 5500000, // (2500000 * 2) + 500000
        deliveryFeeKobo: 150000, // 1,500 NGN flat rate
        totalKobo: 5650000,
        currency: 'NGN',
        status: 'PENDING',
        paymentStatus: 'UNPAID',
        fulfillmentStatus: 'UNFULFILLED',
        items: [
          {
            id: 'item-1',
            productId: dummyProdId1,
            productName: 'Keyboard',
            unitPriceKobo: 2500000,
            quantity: 2,
          },
          {
            id: 'item-2',
            productId: dummyProdId2,
            productName: 'Mousepad',
            unitPriceKobo: 500000,
            quantity: 1,
          },
        ],
      };

      vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) => {
        const tx = {
          product: {
            findUnique: vi.fn().mockImplementation(({ where }) => {
              return { id: where.id, stock: 10, name: 'Sample' };
            }),
            update: vi.fn(),
          },
          order: {
            create: vi.fn().mockResolvedValue(mockCreatedOrder),
          },
        };
        return callback(tx);
      });

      const res = await request(app)
        .post('/api/v1/checkout')
        .send({
          email: 'guest@kubecart.test',
          phone: '+2348012345678',
          shippingAddress: '123 Lagos St',
          // Note: client-supplied price or total is intentionally not accepted
          items: [
            { productId: dummyProdId1, quantity: 2 },
            { productId: dummyProdId2, quantity: 1 },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.subtotalKobo).toBe(5500000);
      expect(res.body.data.deliveryFeeKobo).toBe(150000);
      expect(res.body.data.totalKobo).toBe(5650000);
      expect(res.body.data.reference).toMatch(/^KBC-[A-F0-9]{12}$/);
      expect(res.body.data.paymentStatus).toBe('UNPAID');
      expect(res.body.data.fulfillmentStatus).toBe('UNFULFILLED');
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('rejects checkout when product does not exist or is inactive', async () => {
      vi.spyOn(prisma.product, 'findMany').mockResolvedValue([]);

      const res = await request(app)
        .post('/api/v1/checkout')
        .send({
          email: 'guest@kubecart.test',
          phone: '+2348012345678',
          shippingAddress: '123 Lagos St',
          items: [{ productId: dummyProdId1, quantity: 1 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('not found or is currently inactive');
    });

    it('handles idempotent retries with same Idempotency-Key safely', async () => {
      const idempotencyKey = 'idem-unique-key-123';
      const existingOrder = {
        id: 'ord-123',
        reference: 'KBC-EXISTING1234',
        email: 'guest@kubecart.test',
        phone: '+2348012345678',
        shippingAddress: '123 Lagos St',
        subtotalKobo: 2500000,
        deliveryFeeKobo: 150000,
        totalKobo: 2650000,
        currency: 'NGN',
        idempotencyKey,
        items: [],
      };

      vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(existingOrder);
      const createSpy = vi.spyOn(prisma.order, 'create');

      const res = await request(app)
        .post('/api/v1/checkout')
        .set('Idempotency-Key', idempotencyKey)
        .send({
          email: 'guest@kubecart.test',
          phone: '+2348012345678',
          shippingAddress: '123 Lagos St',
          items: [{ productId: dummyProdId1, quantity: 1 }],
        });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('idempotent request');
      expect(res.body.data.reference).toBe('KBC-EXISTING1234');
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/checkout/:reference - Order Lookup', () => {
    it('returns order details by public reference', async () => {
      const mockOrder = {
        reference: 'KBC-1A2B3C4D5E6F',
        subtotalKobo: 2500000,
        deliveryFeeKobo: 150000,
        totalKobo: 2650000,
        currency: 'NGN',
        status: 'PENDING',
        paymentStatus: 'UNPAID',
        fulfillmentStatus: 'UNFULFILLED',
        createdAt: new Date().toISOString(),
        items: [{ productName: 'Keyboard', unitPriceKobo: 2500000, quantity: 1 }],
      };

      vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(mockOrder);

      const res = await request(app).get('/api/v1/checkout/KBC-1A2B3C4D5E6F');

      expect(res.status).toBe(200);
      expect(res.body.data.reference).toBe('KBC-1A2B3C4D5E6F');
    });

    it('returns 404 when order reference is not found', async () => {
      vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(null);

      const res = await request(app).get('/api/v1/checkout/KBC-UNKNOWN');

      expect(res.status).toBe(404);
      expect(res.body.message).toContain('KBC-UNKNOWN');
    });
  });
});
