import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/db.js';

describe('Milestone 3 — Public Catalogue APIs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Categories API', () => {
    it('GET /api/v1/categories - returns list of categories', async () => {
      const mockCategories = [
        {
          id: 'cat-1',
          name: 'Electronics',
          slug: 'electronics',
          description: 'Electronic devices',
          _count: { products: 3 },
        },
      ];

      vi.spyOn(prisma.category, 'findMany').mockResolvedValue(mockCategories);

      const res = await request(app).get('/api/v1/categories');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: mockCategories });
      expect(prisma.category.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
        include: {
          _count: {
            select: { products: { where: { isActive: true } } },
          },
        },
      });
    });

    it('GET /api/v1/categories/:slug - returns single category when found', async () => {
      const mockCategory = {
        id: 'cat-1',
        name: 'Electronics',
        slug: 'electronics',
        description: 'Electronic devices',
        products: [
          {
            id: 'prod-1',
            name: 'Laptop',
            slug: 'laptop',
            isActive: true,
            images: [],
          },
        ],
      };

      vi.spyOn(prisma.category, 'findUnique').mockResolvedValue(mockCategory);

      const res = await request(app).get('/api/v1/categories/electronics');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: mockCategory });
      expect(prisma.category.findUnique).toHaveBeenCalledWith({
        where: { slug: 'electronics' },
        include: {
          products: {
            where: { isActive: true },
            include: { images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] } },
          },
        },
      });
    });

    it('GET /api/v1/categories/:slug - returns 404 when category does not exist', async () => {
      vi.spyOn(prisma.category, 'findUnique').mockResolvedValue(null);

      const res = await request(app).get('/api/v1/categories/non-existent');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Not Found');
      expect(res.body.message).toContain('non-existent');
      expect(res.body).toHaveProperty('requestId');
    });

    it('GET /api/v1/categories - forwards internal database error to error handler', async () => {
      vi.spyOn(prisma.category, 'findMany').mockRejectedValue(new Error('DB failure'));

      const res = await request(app).get('/api/v1/categories');

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('message', 'DB failure');
    });
  });

  describe('Products API', () => {
    it('GET /api/v1/products - returns paginated product list with default values', async () => {
      const mockProducts = [
        {
          id: 'prod-1',
          name: 'Wireless Mouse',
          slug: 'wireless-mouse',
          priceKobo: 500000,
          currency: 'NGN',
          isActive: true,
          category: { id: 'cat-1', name: 'Electronics', slug: 'electronics' },
          images: [],
        },
      ];

      vi.spyOn(prisma, '$transaction').mockResolvedValue([1, mockProducts]);

      const res = await request(app).get('/api/v1/products');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: mockProducts,
        pagination: {
          page: 1,
          limit: 12,
          total: 1,
          totalPages: 1,
        },
      });
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('GET /api/v1/products - applies search, category filters, and sorting', async () => {
      vi.spyOn(prisma, '$transaction').mockResolvedValue([0, []]);

      const res = await request(app).get(
        '/api/v1/products?search=gadget&categorySlug=electronics&sort=price:asc&page=2&limit=10'
      );

      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 0,
        totalPages: 1,
      });
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('GET /api/v1/products - rejects invalid query parameters with 400 Bad Request', async () => {
      const res = await request(app).get('/api/v1/products?sort=invalid-sort');

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error', 'Bad Request');
      expect(res.body).toHaveProperty('issues');
    });

    it('GET /api/v1/products/:slug - returns product detail by slug', async () => {
      const mockProduct = {
        id: 'prod-1',
        name: 'Wireless Mouse',
        slug: 'wireless-mouse',
        priceKobo: 500000,
        currency: 'NGN',
        isActive: true,
        category: { id: 'cat-1', name: 'Electronics', slug: 'electronics' },
        images: [{ id: 'img-1', url: 'https://img.test/1.jpg', isPrimary: true }],
      };

      vi.spyOn(prisma.product, 'findFirst').mockResolvedValue(mockProduct);

      const res = await request(app).get('/api/v1/products/wireless-mouse');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: mockProduct });
      expect(prisma.product.findFirst).toHaveBeenCalledWith({
        where: { slug: 'wireless-mouse', isActive: true },
        include: {
          category: true,
          images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
        },
      });
    });

    it('GET /api/v1/products/:slug - returns 404 when product is not found or inactive', async () => {
      vi.spyOn(prisma.product, 'findFirst').mockResolvedValue(null);

      const res = await request(app).get('/api/v1/products/inactive-or-missing');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error', 'Not Found');
      expect(res.body.message).toContain('inactive-or-missing');
      expect(res.body).toHaveProperty('requestId');
    });
  });
});
