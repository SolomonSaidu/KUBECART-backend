import multer from 'multer';
import { MAX_PRODUCT_IMAGE_BYTES } from '../utils/image.util.js';

const productImageParser = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PRODUCT_IMAGE_BYTES,
    files: 1,
    fields: 4,
    parts: 5,
  },
}).single('image');

export function productImageUpload(req, res, next) {
  productImageParser(req, res, (error) => {
    if (error) {
      return next(error);
    }

    return next();
  });
}
