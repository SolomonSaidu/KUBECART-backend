import { z } from 'zod';

export const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const createCategorySchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens').optional(),
  description: z.string().nullable().optional(),
});

export const createProductSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().min(1),
  priceKobo: z.number().int().positive('Price must be a positive integer in kobo'),
  currency: z.string().default('NGN'),
  stock: z.number().int().nonnegative('Stock must be non-negative').default(0),
  isActive: z.boolean().default(true),
  images: z.array(
    z.object({
      url: z.string().url(),
      sortOrder: z.number().int().default(0),
      isPrimary: z.boolean().default(false),
    })
  ).max(10).optional().default([]),
});

export const updateProductSchema = z.object({
  categoryId: z.string().uuid().optional(),
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase alphanumeric with hyphens').optional(),
  description: z.string().min(1).optional(),
  priceKobo: z.number().int().positive().optional(),
  currency: z.string().optional(),
  stock: z.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
  images: z.array(
    z.object({
      url: z.string().url(),
      sortOrder: z.number().int().default(0),
      isPrimary: z.boolean().default(false),
    })
  ).max(10).optional(),
});
