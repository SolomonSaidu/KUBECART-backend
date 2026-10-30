import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { emailConfig } from '../config/email.js';
import { logger } from '../utils/logger.js';
import { emailOutboxService } from '../services/email-outbox.service.js';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_MAX_JOBS_PER_TICK = 10;

function defaultWorkerId() {
  return `${os.hostname()}:${process.pid}:${randomUUID()}`;
}

export function createEmailOutboxWorker({
  workerId = defaultWorkerId(),
  intervalMs = DEFAULT_INTERVAL_MS,
  maxJobsPerTick = DEFAULT_MAX_JOBS_PER_TICK,
  service = emailOutboxService,
  config = emailConfig,
} = {}) {
  let timer = null;
  let running = null;
  let stopped = false;

  async function runOnce() {
    if (!config.enabled) {
      return { status: 'disabled', processed: 0 };
    }

    await service.recoverStaleSendingJobs();

    let processed = 0;

    for (let i = 0; i < maxJobsPerTick; i += 1) {
      if (stopped) {
        break;
      }

      const result = await service.processNextOutboxJob({ workerId });

      if (!result) {
        break;
      }

      if (result.status === 'disabled') {
        return { status: 'disabled', processed };
      }

      processed += 1;
    }

    return { status: 'ok', processed };
  }

  function start() {
    if (!config.enabled) {
      logger.warn(
        { missing: config.missing },
        'Email outbox worker not started because email delivery is not configured'
      );
      return false;
    }

    if (timer) {
      return true;
    }

    stopped = false;

    const tick = () => {
      if (running) {
        return;
      }

      running = runOnce()
        .catch((error) => {
          logger.error({ err: error }, 'Email outbox worker tick failed');
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
    workerId,
    start,
    stop,
    runOnce,
    isRunning: () => Boolean(timer),
  };
}

export const emailOutboxWorker = createEmailOutboxWorker();
