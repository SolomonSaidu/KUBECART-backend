import { prisma } from '../config/db.js';

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
    return prisma.category.findUnique({
      where: { slug },
      include: {
        products: {
          where: { isActive: true },
          include: { images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] } },
        },
      },
    });
  },
};
