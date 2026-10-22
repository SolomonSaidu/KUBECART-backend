import { prisma } from '../config/db.js';
import { passwordUtil } from '../utils/password.util.js';
import { tokenUtil } from '../utils/token.util.js';
import { logger } from '../utils/logger.js';
import { storageService } from './storage.service.js';

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export const adminService = {
  async bootstrapAdmin({ email, password, name }) {
    const existingCount = await prisma.admin.count();
    if (existingCount > 0) {
      throw httpError('Admin account already exists. Bootstrap is only permitted for initial setup.', 409);
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
      throw httpError('Invalid email or password', 401);
    }

    const isValid = await passwordUtil.verifyPassword(admin.passwordHash, password);
    if (!isValid) {
      throw httpError('Invalid email or password', 401);
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
    let replacedStoragePaths = [];

    const product = await prisma.$transaction(async (tx) => {
      if (images) {
        const existingImages = await tx.productImage.findMany({
          where: { productId: id, storagePath: { not: null } },
          select: { storagePath: true },
        });
        replacedStoragePaths = existingImages.map((image) => image.storagePath);

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

    await Promise.allSettled(
      replacedStoragePaths.map(async (storagePath) => {
        try {
          await storageService.removeObject(storagePath);
        } catch (error) {
          logger.warn(
            { err: error, storagePath },
            'Failed to remove replaced product image from storage'
          );
        }
      })
    );

    return product;
  },

  async uploadProductImage(productId, { buffer, mimeType, extension }, options) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { images: true },
    });

    if (!product) {
      throw httpError('Product not found', 404);
    }

    const replaceImageId = options.replaceImageId;
    const replacedImage = replaceImageId
      ? product.images.find((image) => image.id === replaceImageId)
      : null;

    if (replaceImageId && !replacedImage) {
      throw httpError('Image to replace was not found for this product', 404);
    }

    if (!replacedImage && product.images.length >= 10) {
      throw httpError('A product can have at most 10 images', 409);
    }

    const uploaded = await storageService.uploadProductImage({
      productId,
      buffer,
      mimeType,
      extension,
    });

    const isPrimary = options.isPrimary ?? replacedImage?.isPrimary ?? false;
    const sortOrder =
      options.sortOrder ??
      replacedImage?.sortOrder ??
      (product.images.length > 0
        ? Math.max(...product.images.map((image) => image.sortOrder)) + 1
        : 0);

    let image;

    try {
      image = await prisma.$transaction(async (tx) => {
        if (isPrimary) {
          await tx.productImage.updateMany({
            where: { productId, isPrimary: true },
            data: { isPrimary: false },
          });
        }

        if (replacedImage) {
          return tx.productImage.update({
            where: { id: replacedImage.id },
            data: {
              url: uploaded.referenceUrl,
              storagePath: uploaded.path,
              isPrimary,
              sortOrder,
            },
          });
        }

        return tx.productImage.create({
          data: {
            productId,
            url: uploaded.referenceUrl,
            storagePath: uploaded.path,
            isPrimary,
            sortOrder,
          },
        });
      });
    } catch (error) {
      await storageService.removeObject(uploaded.path).catch((cleanupError) => {
        logger.error(
          { err: cleanupError, storagePath: uploaded.path },
          'Failed to remove orphaned uploaded image'
        );
      });
      throw error;
    }

    if (replacedImage?.storagePath) {
      try {
        await storageService.removeObject(replacedImage.storagePath);
      } catch (error) {
        logger.warn(
          { err: error, storagePath: replacedImage.storagePath },
          'Failed to remove replaced product image from storage'
        );
      }
    }

    return {
      ...image,
      url: uploaded.signedUrl,
    };
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
