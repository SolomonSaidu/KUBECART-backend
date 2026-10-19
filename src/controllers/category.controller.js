import { categoryService } from '../services/category.service.js';
import { slugParamSchema } from '../validators/catalogue.validator.js';

export const categoryController = {
  async getCategories(req, res, next) {
    try {
      const categories = await categoryService.getAllCategories();
      res.status(200).json({
        data: categories,
      });
    } catch (err) {
      next(err);
    }
  },

  async getCategoryBySlug(req, res, next) {
    try {
      const { slug } = slugParamSchema.parse(req.params);
      const category = await categoryService.getCategoryBySlug(slug);

      if (!category) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Category '${slug}' not found`,
          requestId: req.id,
        });
      }

      res.status(200).json({
        data: category,
      });
    } catch (err) {
      next(err);
    }
  },
};
