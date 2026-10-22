import { prisma } from '../config/db.js';
import { storageService } from './storage.service.js';

export const categoryService = {
  async getAllCategories() {
    return prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: { products: { where: { isActive: true } } },
        },
      },
    });
  },

  async getCategoryBySlug(slug) {
    const category = await prisma.category.findUnique({
      where: { slug },
      include: {
        products: {
          where: { isActive: true },
          include: { images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] } },
        },
      },
    });

    if (!category) {
      return null;
    }

    return {
      ...category,
      products: await storageService.signProducts(category.products),
    };
  },
};
