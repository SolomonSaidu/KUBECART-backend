import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/db.js';
import { tokenUtil } from '../src/utils/token.util.js';
import { storageService } from '../src/services/storage.service.js';
import { MAX_PRODUCT_IMAGE_BYTES } from '../src/utils/image.util.js';

const productId = '123e4567-e89b-12d3-a456-426614174000';
const replaceImageId = '123e4567-e89b-12d3-a456-426614174001';
const validToken = tokenUtil.generateToken({ adminId: 'admin-1', email: 'admin@test.com' });
const pngBuffer = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);

function authenticateAdmin() {
  return vi.spyOn(prisma.admin, 'findUnique').mockResolvedValue({
    id: 'admin-1',
    email: 'admin@test.com',
    name: 'Admin',
  });
}

function mockUploadedImage(overrides = {}) {
  return {
    path: `products/${productId}/new-image.png`,
    signedUrl: 'https://storage.test/signed/new-image.png',
    referenceUrl: 'https://storage.test/reference/new-image.png',
    ...overrides,
  };
}

describe('Admin product image uploads', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    authenticateAdmin();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unauthenticated uploads before parsing multipart data', async () => {
    const uploadSpy = vi.spyOn(storageService, 'uploadProductImage');

    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .attach('image', pngBuffer, { filename: 'product.png', contentType: 'image/png' });

    expect(res.status).toBe(401);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('uploads a valid PNG, stores the private object path, and returns a signed URL', async () => {
    const uploaded = mockUploadedImage();
    vi.spyOn(prisma.product, 'findUnique').mockResolvedValue({ id: productId, images: [] });
    vi.spyOn(storageService, 'uploadProductImage').mockResolvedValue(uploaded);

    const tx = {
      productImage: {
        create: vi.fn().mockResolvedValue({
          id: 'image-1',
          productId,
          url: uploaded.referenceUrl,
          storagePath: uploaded.path,
          isPrimary: true,
          sortOrder: 0,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) => callback(tx));

    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .set('Authorization', `Bearer ${validToken}`)
      .field('isPrimary', 'true')
      .attach('image', pngBuffer, { filename: 'product.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.data.url).toBe(uploaded.signedUrl);
    expect(res.body.data.storagePath).toBe(uploaded.path);
    expect(storageService.uploadProductImage).toHaveBeenCalledWith({
      productId,
      buffer: pngBuffer,
      mimeType: 'image/png',
      extension: 'png',
    });
    expect(tx.productImage.updateMany).toHaveBeenCalledWith({
      where: { productId, isPrimary: true },
      data: { isPrimary: false },
    });
    expect(tx.productImage.create).toHaveBeenCalledWith({
      data: {
        productId,
        url: uploaded.referenceUrl,
        storagePath: uploaded.path,
        isPrimary: true,
        sortOrder: 0,
      },
    });
  });

  it('derives the image type from file contents instead of trusting the filename or MIME type', async () => {
    const uploadSpy = vi.spyOn(storageService, 'uploadProductImage');

    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .set('Authorization', `Bearer ${validToken}`)
      .attach('image', Buffer.from('not actually an image'), {
        filename: 'fake.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Unsupported image format');
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('rejects a request without an image file', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .set('Authorization', `Bearer ${validToken}`)
      .field('isPrimary', 'true');

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Image file is required');
  });

  it('rejects files larger than 5 MB', async () => {
    const oversized = Buffer.concat([pngBuffer, Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES)]);

    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .set('Authorization', `Bearer ${validToken}`)
      .attach('image', oversized, { filename: 'large.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    expect(res.body.message).toContain('5 MB');
  });

  it('returns 404 without uploading when the product does not exist', async () => {
    vi.spyOn(prisma.product, 'findUnique').mockResolvedValue(null);
    const uploadSpy = vi.spyOn(storageService, 'uploadProductImage');

    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .set('Authorization', `Bearer ${validToken}`)
      .attach('image', pngBuffer, { filename: 'product.png', contentType: 'image/png' });

    expect(res.status).toBe(404);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('rejects an eleventh image unless an existing image is replaced', async () => {
    vi.spyOn(prisma.product, 'findUnique').mockResolvedValue({
      id: productId,
      images: Array.from({ length: 10 }, (_, index) => ({
        id: `image-${index}`,
        storagePath: `old-${index}.png`,
        isPrimary: index === 0,
        sortOrder: index,
      })),
    });
    const uploadSpy = vi.spyOn(storageService, 'uploadProductImage');

    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .set('Authorization', `Bearer ${validToken}`)
      .attach('image', pngBuffer, { filename: 'product.png', contentType: 'image/png' });

    expect(res.status).toBe(409);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('returns 502 and does not write the database when storage upload fails', async () => {
    vi.spyOn(prisma.product, 'findUnique').mockResolvedValue({ id: productId, images: [] });
    const storageError = new Error('Unable to upload image to storage');
    storageError.statusCode = 502;
    vi.spyOn(storageService, 'uploadProductImage').mockRejectedValue(storageError);
    const transactionSpy = vi.spyOn(prisma, '$transaction');

    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .set('Authorization', `Bearer ${validToken}`)
      .attach('image', pngBuffer, { filename: 'product.png', contentType: 'image/png' });

    expect(res.status).toBe(502);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('removes the newly uploaded object when the database write fails', async () => {
    const uploaded = mockUploadedImage();
    vi.spyOn(prisma.product, 'findUnique').mockResolvedValue({ id: productId, images: [] });
    vi.spyOn(storageService, 'uploadProductImage').mockResolvedValue(uploaded);
    vi.spyOn(storageService, 'removeObject').mockResolvedValue();
    vi.spyOn(prisma, '$transaction').mockRejectedValue(new Error('Database unavailable'));

    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .set('Authorization', `Bearer ${validToken}`)
      .attach('image', pngBuffer, { filename: 'product.png', contentType: 'image/png' });

    expect(res.status).toBe(500);
    expect(storageService.removeObject).toHaveBeenCalledWith(uploaded.path);
  });

  it('replaces an existing image and only removes the old object after the database update succeeds', async () => {
    const uploaded = mockUploadedImage();
    vi.spyOn(prisma.product, 'findUnique').mockResolvedValue({
      id: productId,
      images: [
        {
          id: replaceImageId,
          storagePath: 'products/old-image.png',
          isPrimary: true,
          sortOrder: 3,
        },
      ],
    });
    vi.spyOn(storageService, 'uploadProductImage').mockResolvedValue(uploaded);
    vi.spyOn(storageService, 'removeObject').mockResolvedValue();

    const tx = {
      productImage: {
        update: vi.fn().mockResolvedValue({
          id: replaceImageId,
          productId,
          url: uploaded.referenceUrl,
          storagePath: uploaded.path,
          isPrimary: true,
          sortOrder: 3,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) => callback(tx));

    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .set('Authorization', `Bearer ${validToken}`)
      .field('replaceImageId', replaceImageId)
      .attach('image', pngBuffer, { filename: 'product.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.data.url).toBe(uploaded.signedUrl);
    expect(storageService.removeObject).toHaveBeenCalledWith('products/old-image.png');
    expect(tx.productImage.update).toHaveBeenCalledWith({
      where: { id: replaceImageId },
      data: {
        url: uploaded.referenceUrl,
        storagePath: uploaded.path,
        isPrimary: true,
        sortOrder: 3,
      },
    });
  });

  it('does not remove the old object when a replacement database write fails', async () => {
    const uploaded = mockUploadedImage();
    vi.spyOn(prisma.product, 'findUnique').mockResolvedValue({
      id: productId,
      images: [{ id: replaceImageId, storagePath: 'products/old-image.png', isPrimary: true, sortOrder: 1 }],
    });
    vi.spyOn(storageService, 'uploadProductImage').mockResolvedValue(uploaded);
    vi.spyOn(storageService, 'removeObject').mockResolvedValue();
    vi.spyOn(prisma, '$transaction').mockRejectedValue(new Error('Database unavailable'));

    const res = await request(app)
      .post(`/api/v1/admin/products/${productId}/image`)
      .set('Authorization', `Bearer ${validToken}`)
      .field('replaceImageId', replaceImageId)
      .attach('image', pngBuffer, { filename: 'product.png', contentType: 'image/png' });

    expect(res.status).toBe(500);
    expect(storageService.removeObject).toHaveBeenCalledTimes(1);
    expect(storageService.removeObject).toHaveBeenCalledWith(uploaded.path);
    expect(storageService.removeObject).not.toHaveBeenCalledWith('products/old-image.png');
  });
});

describe('Product image response signing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a fresh signed URL for images stored in the private bucket', async () => {
    vi.spyOn(prisma.product, 'findFirst').mockResolvedValue({
      id: 'prod-1',
      slug: 'signed-product',
      name: 'Signed Product',
      category: null,
      images: [
        {
          id: 'image-1',
          url: 'https://storage.test/reference/private.png',
          storagePath: 'products/prod-1/private.png',
          isPrimary: true,
          sortOrder: 0,
        },
      ],
    });
    vi.spyOn(storageService, 'createSignedUrl').mockResolvedValue(
      'https://storage.test/signed/private.png'
    );

    const res = await request(app).get('/api/v1/products/signed-product');

    expect(res.status).toBe(200);
    expect(res.body.data.images[0].url).toBe('https://storage.test/signed/private.png');
    expect(storageService.createSignedUrl).toHaveBeenCalledWith('products/prod-1/private.png');
  });

  it('batch-signs private images in product listings', async () => {
    vi.spyOn(prisma, '$transaction').mockResolvedValue([
      1,
      [
        {
          id: 'prod-1',
          slug: 'signed-product',
          name: 'Signed Product',
          category: null,
          images: [
            {
              id: 'image-1',
              url: 'https://storage.test/reference/private.png',
              storagePath: 'products/prod-1/private.png',
              isPrimary: true,
              sortOrder: 0,
            },
            {
              id: 'image-2',
              url: 'https://img.test/external.png',
              storagePath: null,
              isPrimary: false,
              sortOrder: 1,
            },
          ],
        },
      ],
    ]);
    vi.spyOn(storageService, 'createSignedUrls').mockResolvedValue([
      {
        path: 'products/prod-1/private.png',
        signedUrl: 'https://storage.test/signed/private.png',
      },
    ]);

    const res = await request(app).get('/api/v1/products');

    expect(res.status).toBe(200);
    expect(res.body.data[0].images[0].url).toBe('https://storage.test/signed/private.png');
    expect(res.body.data[0].images[1].url).toBe('https://img.test/external.png');
    expect(storageService.createSignedUrls).toHaveBeenCalledWith([
      'products/prod-1/private.png',
    ]);
  });
});
