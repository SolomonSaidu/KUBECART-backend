import { prisma } from '../config/db.js';
import { storageService } from './storage.service.js';

export const productService = {
  async getProducts({ page = 1, limit = 12, search, categorySlug, categoryId, sort = 'newest' }) {
    const skip = (page - 1) * limit;
    const where = { isActive: true };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (categoryId) {
      where.categoryId = categoryId;
    } else if (categorySlug) {
      where.category = { slug: categorySlug };
    }

    let orderBy = { createdAt: 'desc' };
    if (sort === 'price:asc') {
      orderBy = { priceKobo: 'asc' };
    } else if (sort === 'price:desc') {
      orderBy = { priceKobo: 'desc' };
    } else if (sort === 'name:asc') {
      orderBy = { name: 'asc' };
    }

    const [total, products] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          category: true,
          images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
        },
      }),
    ]);

    const signedProducts = await storageService.signProducts(products);

    return {
      data: signedProducts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  },

  async getProductBySlug(slug) {
    const product = await prisma.product.findFirst({
      where: {
        slug,
        isActive: true,
      },
      include: {
        category: true,
        images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
      },
    });

    return storageService.signProductImages(product);
  },
};
