import { prisma } from '../config/db.js';
import { passwordUtil } from '../utils/password.util.js';
import { tokenUtil } from '../utils/token.util.js';

export const adminService = {
  async bootstrapAdmin({ email, password, name }) {
    const existingCount = await prisma.admin.count();
    if (existingCount > 0) {
      const error = new Error('Admin account already exists. Bootstrap is only permitted for initial setup.');
      error.statusCode = 409;
      throw error;
    }

    const passwordHash = await passwordUtil.hashPassword(password);
    return prisma.admin.create({
      data: {
        email,
        passwordHash,
        name,
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
      },
    });
  },

  async login({ email, password }) {
    const admin = await prisma.admin.findUnique({
      where: { email },
    });

    if (!admin) {
      const error = new Error('Invalid email or password');
      error.statusCode = 401;
      throw error;
    }

    const isValid = await passwordUtil.verifyPassword(admin.passwordHash, password);
    if (!isValid) {
      const error = new Error('Invalid email or password');
      error.statusCode = 401;
      throw error;
    }

    const token = tokenUtil.generateToken({ adminId: admin.id, email: admin.email });

    return {
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
      },
    };
  },

  // Category management
  async createCategory(data) {
    return prisma.category.create({
      data,
    });
  },

  async updateCategory(id, data) {
    return prisma.category.update({
      where: { id },
      data,
    });
  },

  async deleteCategory(id) {
    return prisma.category.delete({
      where: { id },
    });
  },

  // Product management
  async createProduct({ images = [], ...productData }) {
    return prisma.product.create({
      data: {
        ...productData,
        images: {
          create: images,
        },
      },
      include: {
        category: true,
        images: true,
      },
    });
  },

  async updateProduct(id, { images, ...productData }) {
    return prisma.$transaction(async (tx) => {
      if (images) {
        await tx.productImage.deleteMany({
          where: { productId: id },
        });

        await tx.productImage.createMany({
          data: images.map((img) => ({
            ...img,
            productId: id,
          })),
        });
      }

      return tx.product.update({
        where: { id },
        data: productData,
        include: {
          category: true,
          images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
        },
      });
    });
  },

  async deactivateProduct(id) {
    return prisma.product.update({
      where: { id },
      data: { isActive: false },
    });
  },

  async activateProduct(id) {
    return prisma.product.update({
      where: { id },
      data: { isActive: true },
    });
  },
};
