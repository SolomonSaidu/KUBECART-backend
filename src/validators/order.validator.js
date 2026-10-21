import { z } from 'zod';

const orderStatusSchema = z.enum(['PENDING', 'CONFIRMED', 'CANCELLED']);
const paymentStatusSchema = z.enum(['UNPAID', 'PAID', 'REFUNDED']);
const fulfillmentStatusSchema = z.enum(['UNFULFILLED', 'PROCESSING', 'FULFILLED', 'CANCELLED']);

export const orderListQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .default('1')
    .transform((v) => Math.max(1, parseInt(v, 10) || 1)),
  limit: z
    .string()
    .optional()
    .default('20')
    .transform((v) => Math.min(100, Math.max(1, parseInt(v, 10) || 20))),
  status: orderStatusSchema.optional(),
  paymentStatus: paymentStatusSchema.optional(),
  fulfillmentStatus: fulfillmentStatusSchema.optional(),
  requiresManualReview: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  search: z.string().trim().min(1).max(255).optional(),
  sort: z.enum(['newest', 'oldest', 'total:desc', 'total:asc']).optional().default('newest'),
});

export const orderReferenceParamSchema = z.object({
  reference: z.string().trim().min(1).max(100),
});

// Strict schema so admin requests cannot smuggle writable payment or review fields.
export const updateFulfillmentSchema = z
  .object({
    status: z.enum(['PROCESSING', 'FULFILLED', 'CANCELLED']),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
