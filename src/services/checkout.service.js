import { prisma } from '../config/db.js';
import { env } from '../config/env.js';
import { randomBytes } from 'node:crypto';

export const checkoutService = {
  generateReference() {
    // Generate a secure, URL-safe random order reference e.g., KBC-A1B2C3D4E5F6
    return `KBC-${randomBytes(6).toString('hex').toUpperCase()}`;
  },

  async createOrder({ email, phone, shippingAddress, items, idempotencyKey }) {
    // 1. Idempotency Check
    if (idempotencyKey) {
      const existingOrder = await prisma.order.findUnique({
        where: { idempotencyKey },
        include: {
          items: true,
        },
      });

      if (existingOrder) {
        return {
          order: existingOrder,
          isDuplicate: true,
        };
      }
    }

    // 2. Fetch current products from database to ensure fresh authoritative prices and active status
    const productIds = items.map((i) => i.productId);
    const uniqueIds = Array.from(new Set(productIds));

    const products = await prisma.product.findMany({
      where: {
        id: { in: uniqueIds },
        isActive: true,
      },
    });

    const productMap = new Map(products.map((p) => [p.id, p]));

    // Check if any product is missing or inactive
    for (const item of items) {
      const product = productMap.get(item.productId);
      if (!product) {
        const error = new Error(`Product '${item.productId}' not found or is currently inactive`);
        error.statusCode = 400;
        throw error;
      }
    }

    // 3. Server-side subtotal calculation in integer minor units (kobo)
    let subtotalKobo = 0;
    const orderItemsData = items.map((item) => {
      const product = productMap.get(item.productId);
      const lineTotal = product.priceKobo * item.quantity;
      subtotalKobo += lineTotal;

      return {
        productId: product.id,
        productName: product.name, // Snapshot
        unitPriceKobo: product.priceKobo, // Snapshot
        quantity: item.quantity,
      };
    });

    const deliveryFeeKobo = env.DEFAULT_DELIVERY_FEE_KOBO;
    const totalKobo = subtotalKobo + deliveryFeeKobo;
    const reference = this.generateReference();

    // 4. Create Order and OrderItems atomically
    const order = await prisma.order.create({
      data: {
        reference,
        email,
        phone,
        shippingAddress,
        subtotalKobo,
        deliveryFeeKobo,
        totalKobo,
        currency: 'NGN',
        status: 'PENDING',
        paymentStatus: 'UNPAID',
        fulfillmentStatus: 'UNFULFILLED',
        idempotencyKey: idempotencyKey || null,
        items: {
          create: orderItemsData,
        },
      },
      include: {
        items: true,
      },
    });

    return {
      order,
      isDuplicate: false,
    };
  },

  async getOrderByReference(reference) {
    return prisma.order.findUnique({
      where: { reference },
      select: {
        reference: true,
        subtotalKobo: true,
        deliveryFeeKobo: true,
        totalKobo: true,
        currency: true,
        status: true,
        paymentStatus: true,
        fulfillmentStatus: true,
        createdAt: true,
        items: {
          select: {
            productName: true,
            unitPriceKobo: true,
            quantity: true,
          },
        },
      },
    });
  },
};
