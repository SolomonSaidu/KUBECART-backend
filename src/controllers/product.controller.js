import { productService } from '../services/product.service.js';
import { productQuerySchema, slugParamSchema } from '../validators/catalogue.validator.js';

export const productController = {
  async getProducts(req, res, next) {
    try {
      const validatedQuery = productQuerySchema.parse(req.query);
      const result = await productService.getProducts(validatedQuery);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async getProductBySlug(req, res, next) {
    try {
      const { slug } = slugParamSchema.parse(req.params);
      const product = await productService.getProductBySlug(slug);

      if (!product) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Product '${slug}' not found`,
          requestId: req.id,
        });
      }

      res.status(200).json({
        data: product,
      });
    } catch (err) {
      next(err);
    }
  },
};
