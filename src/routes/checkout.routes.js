import { Router } from 'express';
import { checkoutController } from '../controllers/checkout.controller.js';
import { checkoutLimiter } from '../middlewares/rateLimit.middleware.js';

const router = Router();

router.post('/', checkoutLimiter, checkoutController.checkout);
router.get('/:reference', checkoutController.getOrder);

export default router;
