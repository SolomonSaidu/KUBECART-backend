import { paymentService } from '../services/payment.service.js';
import { paystackClient } from '../utils/paystack.client.js';
import {
  initializePaymentSchema,
  verifyPaymentParamSchema,
} from '../validators/payment.validator.js';

export const paymentController = {
  /**
   * POST /api/v1/payments/initialize
   */
  async initialize(req, res, next) {
    try {
      const validated = initializePaymentSchema.parse(req.body);
      const result = await paymentService.initializePayment(validated);

      res.status(200).json({
        message: 'Payment initialized successfully',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/v1/payments/verify/:reference
   */
  async verify(req, res, next) {
    try {
      const { reference } = verifyPaymentParamSchema.parse(req.params);
      const result = await paymentService.verifyPayment(reference);

      res.status(200).json({
        message: 'Payment verified successfully',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/v1/payments/webhook
   */
  async webhook(req, res, next) {
    try {
      const signature = req.headers['x-paystack-signature'];
      const rawBody = req.rawBody || req.body;

      // Verify HMAC-SHA512 signature using raw body
      const isValid = paystackClient.verifyWebhookSignature(rawBody, signature);
      if (!isValid) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid Paystack webhook signature',
        });
      }

      // Parse payload
      let event;
      if (Buffer.isBuffer(rawBody)) {
        event = JSON.parse(rawBody.toString('utf8'));
      } else if (typeof rawBody === 'string') {
        event = JSON.parse(rawBody);
      } else {
        event = rawBody;
      }

      const result = await paymentService.processWebhookEvent(event);

      // Paystack expects a 200 OK response
      res.status(200).json({
        received: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  },
};
