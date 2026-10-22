import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller.js';
import { paymentLimiter } from '../middlewares/rateLimit.middleware.js';

const router = Router();

router.post('/initialize', paymentLimiter, paymentController.initialize);
router.get('/verify/:reference', paymentLimiter, paymentController.verify);
router.post('/webhook', paymentController.webhook);

export default router;
