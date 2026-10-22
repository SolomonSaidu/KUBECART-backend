import { Router } from 'express';
import { adminController } from '../controllers/admin.controller.js';
import { orderController } from '../controllers/order.controller.js';
import {
  requireAdmin,
  requireCsrfForCookieAuth,
} from '../middlewares/auth.middleware.js';
import {
  adminBootstrapLimiter,
  adminLoginLimiter,
} from '../middlewares/rateLimit.middleware.js';

const router = Router();

// Public bootstrap and authentication routes
router.post('/bootstrap', adminBootstrapLimiter, adminController.bootstrap);
router.post('/login', adminLoginLimiter, adminController.login);
router.post('/logout', requireCsrfForCookieAuth, adminController.logout);

// Protected admin profile route
router.get('/me', requireAdmin, adminController.me);

// Protected Category CRUD routes
router.post('/categories', requireAdmin, adminController.createCategory);
router.put('/categories/:id', requireAdmin, adminController.updateCategory);
router.delete('/categories/:id', requireAdmin, adminController.deleteCategory);

// Protected Product CRUD & activation routes
router.post('/products', requireAdmin, adminController.createProduct);
router.put('/products/:id', requireAdmin, adminController.updateProduct);
router.patch('/products/:id/deactivate', requireAdmin, adminController.deactivateProduct);
router.patch('/products/:id/activate', requireAdmin, adminController.activateProduct);

// Protected order administration and fulfilment routes
router.get('/orders', requireAdmin, orderController.listOrders);
router.get('/orders/:reference', requireAdmin, orderController.getOrder);
router.patch('/orders/:reference/fulfillment', requireAdmin, orderController.updateFulfillment);

export default router;
