import { logger } from '../utils/logger.js';
import { orderExpirationService } from '../services/order-expiration.service.js';

const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_BATCH_SIZE = 50;

export function createOrderExpirationWorker({
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  service = orderExpirationService,
} = {}) {
  let timer = null;
  let running = null;
  let stopped = false;

  async function runOnce() {
    const result = await service.expireUnpaidOrders({ limit: batchSize });

    if (result.failures.length > 0) {
      logger.error(
        {
          failures: result.failures.map((failure) => ({
            orderId: failure.orderId,
            err: failure.error,
          })),
        },
        'Order expiration worker failed to expire some orders'
      );
    }

    if (result.expiredOrders > 0) {
      logger.info(
        {
          expiredOrders: result.expiredOrders,
          releasedReservations: result.releasedReservations,
          releasedQuantity: result.releasedQuantity,
        },
        'Order expiration worker released expired unpaid orders'
      );
    }

    return result;
  }

  function start() {
    if (timer) {
      return true;
    }

    stopped = false;

    const tick = () => {
      if (running || stopped) {
        return;
      }

      running = runOnce()
        .catch((error) => {
          logger.error({ err: error }, 'Order expiration worker tick failed');
        })
        .finally(() => {
          running = null;
        });
    };

    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    tick();

    return true;
  }

  async function stop() {
    stopped = true;

    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    if (running) {
      await running;
    }
  }

  return {
    start,
    stop,
    runOnce,
    isRunning: () => Boolean(timer),
  };
}

export const orderExpirationWorker = createOrderExpirationWorker();
