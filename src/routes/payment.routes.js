import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller.js';

const router = Router();

router.post('/initialize', paymentController.initialize);
router.get('/verify/:reference', paymentController.verify);
router.post('/webhook', paymentController.webhook);

export default router;
