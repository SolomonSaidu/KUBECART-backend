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

    // 4. Create Order, OrderItems, and Inventory Reservations atomically in a transaction
    const order = await prisma.$transaction(async (tx) => {
      // Check stock and reserve
      for (const item of items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { id: true, stock: true, name: true },
        });

        if (!product || product.stock < item.quantity) {
          const error = new Error(
            `Insufficient stock for '${product ? product.name : item.productId}'. Available: ${
              product ? product.stock : 0
            }, Requested: ${item.quantity}`
          );
          error.statusCode = 409;
          throw error;
        }

        // Decrement stock
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.quantity } },
        });
      }

      const reservationMinutes = env.INVENTORY_RESERVATION_MINUTES;
      const expiresAt = new Date(Date.now() + reservationMinutes * 60 * 1000);

      const createdOrder = await tx.order.create({
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
          reservations: {
            create: items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              status: 'ACTIVE',
              expiresAt,
            })),
          },
        },
        include: {
          items: true,
          reservations: true,
        },
      });

      return createdOrder;
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
