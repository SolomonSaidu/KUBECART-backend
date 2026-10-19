import { z } from 'zod';

export const checkoutItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive('Quantity must be at least 1'),
});

export const checkoutSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(7).max(20),
  shippingAddress: z.string().min(5).max(500),
  items: z.array(checkoutItemSchema).min(1, 'Order must contain at least one item'),
});
