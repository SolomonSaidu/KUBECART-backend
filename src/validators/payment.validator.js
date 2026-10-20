import { z } from 'zod';

export const initializePaymentSchema = z.object({
  orderReference: z.string().min(1, 'Order reference is required'),
  callbackUrl: z.string().url().optional(),
});

export const verifyPaymentParamSchema = z.object({
  reference: z.string().min(1, 'Payment reference is required'),
});
