import { checkoutService } from '../services/checkout.service.js';
import { checkoutSchema } from '../validators/checkout.validator.js';

export const checkoutController = {
  async checkout(req, res, next) {
    try {
      const validatedData = checkoutSchema.parse(req.body);
      const idempotencyKey = req.headers['idempotency-key'] || null;

      const { order, isDuplicate } = await checkoutService.createOrder({
        ...validatedData,
        idempotencyKey,
      });

      res.status(isDuplicate ? 200 : 201).json({
        message: isDuplicate ? 'Order retrieved (idempotent request)' : 'Order created successfully',
        data: order,
      });
    } catch (err) {
      next(err);
    }
  },

  async getOrder(req, res, next) {
    try {
      const { reference } = req.params;
      const order = await checkoutService.getOrderByReference(reference);

      if (!order) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Order with reference '${reference}' not found`,
          requestId: req.id,
        });
      }

      res.status(200).json({
        data: order,
      });
    } catch (err) {
      next(err);
    }
  },
};
