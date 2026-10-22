import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { getSupabaseClient } from '../utils/supabase.client.js';
import { logger } from '../utils/logger.js';

export const SIGNED_URL_EXPIRES_IN_SECONDS = 60 * 60;

function storageError(message) {
  const error = new Error(message);
  error.statusCode = 502;
  return error;
}

function normalizeBaseUrl() {
  return env.SUPABASE_URL.replace(/\/+$/, '');
}

function encodeObjectPath(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function buildStorageReferenceUrl(path) {
  return `${normalizeBaseUrl()}/storage/v1/object/authenticated/${encodeURIComponent(
    env.SUPABASE_BUCKET
  )}/${encodeObjectPath(path)}`;
}

export const storageService = {
  buildObjectPath(productId, extension) {
    return `products/${productId}/${randomUUID()}.${extension}`;
  },

  async uploadProductImage({ productId, buffer, mimeType, extension }) {
    const path = this.buildObjectPath(productId, extension);
    const bucket = getSupabaseClient().storage.from(env.SUPABASE_BUCKET);

    const { error } = await bucket.upload(path, buffer, {
      cacheControl: '31536000',
      contentType: mimeType,
      upsert: false,
    });

    if (error) {
      throw storageError('Unable to upload image to storage');
    }

    try {
      const signedUrl = await this.createSignedUrl(path);
      return {
        path,
        signedUrl,
        referenceUrl: buildStorageReferenceUrl(path),
      };
    } catch (error) {
      await this.removeObject(path).catch((cleanupError) => {
        logger.error(
          { err: cleanupError, storagePath: path },
          'Failed to remove orphaned storage object'
        );
      });
      throw error;
    }
  },

  async createSignedUrl(path) {
    const { data, error } = await getSupabaseClient()
      .storage.from(env.SUPABASE_BUCKET)
      .createSignedUrl(path, SIGNED_URL_EXPIRES_IN_SECONDS);

    if (error || !data?.signedUrl) {
      throw storageError('Unable to create signed image URL');
    }

    return data.signedUrl;
  },

  async createSignedUrls(paths) {
    const { data, error } = await getSupabaseClient()
      .storage.from(env.SUPABASE_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_EXPIRES_IN_SECONDS);

    if (error || !Array.isArray(data)) {
      throw storageError('Unable to create signed image URLs');
    }

    return data;
  },

  async removeObject(path) {
    const { error } = await getSupabaseClient()
      .storage.from(env.SUPABASE_BUCKET)
      .remove([path]);

    if (error) {
      throw storageError('Unable to remove image from storage');
    }
  },

  async signProducts(products) {
    if (!Array.isArray(products) || products.length === 0) {
      return products;
    }

    const storagePaths = [
      ...new Set(
        products.flatMap((product) =>
          (product?.images ?? [])
            .filter((image) => image.storagePath)
            .map((image) => image.storagePath)
        )
      ),
    ];

    if (storagePaths.length === 0) {
      return products;
    }

    let signedUrls;
    try {
      signedUrls = await this.createSignedUrls(storagePaths);
    } catch (error) {
      logger.warn({ err: error }, 'Failed to create signed image URLs');
      return products;
    }

    const urlByPath = new Map(
      signedUrls
        .filter((item) => item.path && item.signedUrl)
        .map((item) => [item.path, item.signedUrl])
    );

    return products.map((product) => {
      if (!product?.images?.length) {
        return product;
      }

      return {
        ...product,
        images: product.images.map((image) => {
          const signedUrl = image.storagePath
            ? urlByPath.get(image.storagePath)
            : null;

          return signedUrl ? { ...image, url: signedUrl } : image;
        }),
      };
    });
  },

  async signProductImages(product) {
    if (!product?.images?.length) {
      return product;
    }

    const images = await Promise.all(
      product.images.map(async (image) => {
        if (!image.storagePath) {
          return image;
        }

        try {
          return {
            ...image,
            url: await this.createSignedUrl(image.storagePath),
          };
        } catch (error) {
          logger.warn(
            { err: error, imageId: image.id },
            'Failed to create signed image URL; returning stored reference'
          );
          return image;
        }
      })
    );

    return { ...product, images };
  },
};
