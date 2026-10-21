import { orderService } from '../services/order.service.js';
import {
  orderListQuerySchema,
  orderReferenceParamSchema,
  updateFulfillmentSchema,
} from '../validators/order.validator.js';

export const orderController = {
  async listOrders(req, res, next) {
    try {
      const query = orderListQuerySchema.parse(req.query);
      const result = await orderService.listOrders(query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async getOrder(req, res, next) {
    try {
      const { reference } = orderReferenceParamSchema.parse(req.params);
      const order = await orderService.getOrderByReference(reference);

      if (!order) {
        return res.status(404).json({
          error: 'Not Found',
          message: `Order with reference '${reference}' not found`,
          requestId: req.id,
        });
      }

      res.status(200).json({ data: order });
    } catch (err) {
      next(err);
    }
  },

  async updateFulfillment(req, res, next) {
    try {
      const { reference } = orderReferenceParamSchema.parse(req.params);
      const data = updateFulfillmentSchema.parse(req.body);
      const result = await orderService.transitionFulfillment(
        reference,
        data,
        req.admin.id
      );

      res.status(200).json({
        message: result.isNoOp
          ? `Order is already ${data.status}`
          : `Order fulfilment updated to ${data.status}`,
        data: result.order,
      });
    } catch (err) {
      next(err);
    }
  },
};
