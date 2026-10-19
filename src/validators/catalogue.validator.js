import { z } from 'zod';

export const productQuerySchema = z.object({
  page: z.string().optional().default('1').transform((v) => Math.max(1, parseInt(v, 10) || 1)),
  limit: z.string().optional().default('12').transform((v) => Math.min(50, Math.max(1, parseInt(v, 10) || 12))),
  search: z.string().optional(),
  categorySlug: z.string().optional(),
  categoryId: z.string().optional(),
  sort: z.enum(['newest', 'price:asc', 'price:desc', 'name:asc']).optional().default('newest'),
});

export const slugParamSchema = z.object({
  slug: z.string().min(1),
});
