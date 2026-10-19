import { adminService } from '../services/admin.service.js';
import {
  adminLoginSchema,
  createCategorySchema,
  updateCategorySchema,
  createProductSchema,
  updateProductSchema,
} from '../validators/admin.validator.js';
import { env } from '../config/env.js';

export const adminController = {
  async bootstrap(req, res, next) {
    try {
      const { email, password, name } = req.body;
      if (!email || !password || !name) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Email, password, and name are required for bootstrap',
          requestId: req.id,
        });
      }

      const admin = await adminService.bootstrapAdmin({ email, password, name });
      res.status(201).json({
        message: 'Admin bootstrapped successfully',
        data: admin,
      });
    } catch (err) {
      next(err);
    }
  },

  async login(req, res, next) {
    try {
      const credentials = adminLoginSchema.parse(req.body);
      const { token, admin } = await adminService.login(credentials);

      // Set HttpOnly cookie
      res.cookie('admin_token', token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      });

      res.status(200).json({
        message: 'Login successful',
        token,
        admin,
      });
    } catch (err) {
      next(err);
    }
  },

  async logout(req, res) {
    res.clearCookie('admin_token');
    res.status(200).json({
      message: 'Logged out successfully',
    });
  },

  async me(req, res) {
    res.status(200).json({
      admin: req.admin,
    });
  },

  // Category management
  async createCategory(req, res, next) {
    try {
      const data = createCategorySchema.parse(req.body);
      const category = await adminService.createCategory(data);
      res.status(201).json({ data: category });
    } catch (err) {
      next(err);
    }
  },

  async updateCategory(req, res, next) {
    try {
      const { id } = req.params;
      const data = updateCategorySchema.parse(req.body);
      const category = await adminService.updateCategory(id, data);
      res.status(200).json({ data: category });
    } catch (err) {
      next(err);
    }
  },

  async deleteCategory(req, res, next) {
    try {
      const { id } = req.params;
      await adminService.deleteCategory(id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },

  // Product management
  async createProduct(req, res, next) {
    try {
      const data = createProductSchema.parse(req.body);
      const product = await adminService.createProduct(data);
      res.status(201).json({ data: product });
    } catch (err) {
      next(err);
    }
  },

  async updateProduct(req, res, next) {
    try {
      const { id } = req.params;
      const data = updateProductSchema.parse(req.body);
      const product = await adminService.updateProduct(id, data);
      res.status(200).json({ data: product });
    } catch (err) {
      next(err);
    }
  },

  async deactivateProduct(req, res, next) {
    try {
      const { id } = req.params;
      const product = await adminService.deactivateProduct(id);
      res.status(200).json({ data: product });
    } catch (err) {
      next(err);
    }
  },

  async activateProduct(req, res, next) {
    try {
      const { id } = req.params;
      const product = await adminService.activateProduct(id);
      res.status(200).json({ data: product });
    } catch (err) {
      next(err);
    }
  },
};
