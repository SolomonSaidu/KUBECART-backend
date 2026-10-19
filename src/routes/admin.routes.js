import { Router } from 'express';
import { adminController } from '../controllers/admin.controller.js';
import { requireAdmin } from '../middlewares/auth.middleware.js';
import { adminLoginLimiter } from '../middlewares/rateLimit.middleware.js';

const router = Router();

// Public bootstrap and authentication routes
router.post('/bootstrap', adminController.bootstrap);
router.post('/login', adminLoginLimiter, adminController.login);
router.post('/logout', adminController.logout);

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

export default router;
