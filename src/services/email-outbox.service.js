import { randomUUID } from 'node:crypto';
import { prisma } from '../config/db.js';
import { emailConfig } from '../config/email.js';
import { logger } from '../utils/logger.js';
import { orderEmailService } from './order-email.service.js';

export const EMAIL_OUTBOX_TYPE = 'ORDER_PROCESSING';
export const MAX_ATTEMPTS = 5;
export const BASE_BACKOFF_MS = 30 * 1000;
export const MAX_BACKOFF_MS = 10 * 60 * 1000;
export const STALE_LOCK_MS = 5 * 60 * 1000;
export const IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;

const ORDER_EMAIL_SELECT = {
  id: true,
  reference: true,
  email: true,
  subtotalKobo: true,
  deliveryFeeKobo: true,
  totalKobo: true,
  currency: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  requiresManualReview: true,
  processingEmailSentAt: true,
  createdAt: true,
  items: {
    select: {
      productName: true,
      unitPriceKobo: true,
      quantity: true,
    },
  },
};

export function shouldSendProcessingEmail(order) {
  return (
    order?.fulfillmentStatus === 'PROCESSING' &&
    order.paymentStatus === 'PAID' &&
    !order.requiresManualReview &&
    !order.processingEmailSentAt
  );
}

export function dedupeKeyForOrder(orderId) {
  return `order-processing:${orderId}`;
}

function backoffForAttempt(attempts) {
  return Math.min(
    BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
    MAX_BACKOFF_MS
  );
}

function truncateError(error) {
  const message = error?.message || String(error);
  return message.slice(0, 1000);
}

function isIdempotencyExpired(job, now) {
  const firstAttempt = job.firstAttemptAt ?? job.lastAttemptAt ?? job.createdAt;

  if (!firstAttempt) {
    return false;
  }

  return now.getTime() - new Date(firstAttempt).getTime() >= IDEMPOTENCY_TTL_MS;
}

async function markOutboxSent(tx, job, { sentAt, providerMessageId = null }) {
  const updated = await tx.emailOutbox.updateMany({
    where: { id: job.id, status: 'SENDING' },
    data: {
      status: 'SENT',
      sentAt,
      providerMessageId,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });

  if (updated.count !== 1) {
    const error = new Error(
      `Email outbox job '${job.id}' was not in SENDING state during finalization`
    );
    error.code = 'OUTBOX_FINALIZE_FAILED';
    throw error;
  }
}

async function finalizeOutboxJob(job, order, { sentAt, providerMessageId }) {
  await prisma.$transaction(async (tx) => {
    if (!order.processingEmailSentAt) {
      const marker = await tx.order.updateMany({
        where: { id: order.id, processingEmailSentAt: null },
        data: { processingEmailSentAt: sentAt },
      });

      if (marker.count !== 1) {
        const current = await tx.order.findUnique({
          where: { id: order.id },
          select: { processingEmailSentAt: true },
        });

        if (!current?.processingEmailSentAt) {
          const error = new Error(
            `Processing email marker was not recorded for order '${order.reference}'`
          );
          error.code = 'EMAIL_MARKER_NOT_RECORDED';
          throw error;
        }
      }
    }

    await markOutboxSent(tx, job, { sentAt, providerMessageId });
  });
}

async function finalizeAlreadyMarkedOutboxJob(job, order) {
  await prisma.$transaction(async (tx) => {
    await markOutboxSent(tx, job, {
      sentAt: order.processingEmailSentAt ?? new Date(),
    });
  });
}

async function scheduleRetry(job, error, now) {
  let status = 'PENDING';
  let nextAttemptAt = new Date(now.getTime() + backoffForAttempt(job.attempts));

  if (isIdempotencyExpired(job, now)) {
    status = 'UNCERTAIN';
  } else if (!error.retryable) {
    status = 'FAILED';
  } else if (job.attempts >= MAX_ATTEMPTS) {
    status = error.ambiguous ? 'UNCERTAIN' : 'FAILED';
  }

  const updated = await prisma.emailOutbox.updateMany({
    where: { id: job.id, status: 'SENDING' },
    data: {
      status,
      nextAttemptAt: status === 'PENDING' ? nextAttemptAt : job.nextAttemptAt,
      lockedAt: null,
      lockedBy: null,
      lastError: truncateError(error),
    },
  });

  if (updated.count !== 1) {
    logger.warn(
      { outboxJobId: job.id, requestedStatus: status },
      'Email outbox retry state could not be recorded'
    );
  }

  return { status, nextAttemptAt };
}

async function markJobFailed(job, message) {
  await prisma.emailOutbox.updateMany({
    where: { id: job.id, status: 'SENDING' },
    data: {
      status: 'FAILED',
      lockedAt: null,
      lockedBy: null,
      lastError: message,
    },
  });
}

export const emailOutboxService = {
  async enqueueOrderProcessingEmail(tx, order, { now = new Date() } = {}) {
    if (!shouldSendProcessingEmail(order)) {
      return null;
    }

    const dedupeKey = dedupeKeyForOrder(order.id);

    await tx.emailOutbox.createMany({
      data: [
        {
          orderId: order.id,
          type: EMAIL_OUTBOX_TYPE,
          dedupeKey,
          idempotencyKey: randomUUID(),
          nextAttemptAt: now,
        },
      ],
      skipDuplicates: true,
    });

    await tx.emailOutbox.updateMany({
      where: { dedupeKey, status: 'FAILED' },
      data: {
        status: 'PENDING',
        attempts: 0,
        firstAttemptAt: null,
        lastAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        nextAttemptAt: now,
        lastError: null,
      },
    });

    return null;
  },

  async claimNextOutboxJob({ workerId, now = new Date() }) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = await prisma.emailOutbox.findFirst({
        where: {
          status: 'PENDING',
          nextAttemptAt: { lte: now },
        },
        orderBy: { nextAttemptAt: 'asc' },
      });

      if (!candidate) {
        return null;
      }

      const claim = await prisma.emailOutbox.updateMany({
        where: {
          id: candidate.id,
          status: 'PENDING',
          nextAttemptAt: { lte: now },
        },
        data: {
          status: 'SENDING',
          attempts: candidate.attempts + 1,
          firstAttemptAt: candidate.firstAttemptAt ?? now,
          lastAttemptAt: now,
          lockedAt: now,
          lockedBy: workerId,
        },
      });

      if (claim.count === 1) {
        return {
          ...candidate,
          status: 'SENDING',
          attempts: candidate.attempts + 1,
          firstAttemptAt: candidate.firstAttemptAt ?? now,
          lastAttemptAt: now,
          lockedAt: now,
          lockedBy: workerId,
        };
      }
    }

    return null;
  },

  async recoverStaleSendingJobs({ now = new Date() } = {}) {
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const staleJobs = await prisma.emailOutbox.findMany({
      where: {
        status: 'SENDING',
        lockedAt: { lt: staleBefore },
      },
    });

    for (const job of staleJobs) {
      const order = await prisma.order.findUnique({
        where: { id: job.orderId },
        select: { processingEmailSentAt: true },
      });

      if (order?.processingEmailSentAt) {
        await prisma.emailOutbox.updateMany({
          where: {
            id: job.id,
            status: 'SENDING',
            lockedAt: { lt: staleBefore },
          },
          data: {
            status: 'SENT',
            sentAt: order.processingEmailSentAt,
            lockedAt: null,
            lockedBy: null,
            lastError: null,
          },
        });
        continue;
      }

      const ambiguous = isIdempotencyExpired(job, now);
      const exhausted = job.attempts >= MAX_ATTEMPTS;

      if (ambiguous || exhausted) {
        await prisma.emailOutbox.updateMany({
          where: {
            id: job.id,
            status: 'SENDING',
            lockedAt: { lt: staleBefore },
          },
          data: {
            status: 'UNCERTAIN',
            lockedAt: null,
            lockedBy: null,
            lastError: ambiguous
              ? 'Brevo idempotency window expired before the send was finalized'
              : 'Maximum delivery attempts reached while delivery was ambiguous',
          },
        });
        continue;
      }

      await prisma.emailOutbox.updateMany({
        where: {
          id: job.id,
          status: 'SENDING',
          lockedAt: { lt: staleBefore },
        },
        data: {
          status: 'PENDING',
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: now,
          lastError: 'Recovered stale SENDING job after worker restart',
        },
      });
    }

    return staleJobs.length;
  },

  async processNextOutboxJob({ workerId, now = new Date() }) {
    if (!emailConfig.enabled) {
      return { status: 'disabled' };
    }

    const job = await this.claimNextOutboxJob({ workerId, now });

    if (!job) {
      return null;
    }

    const order = await prisma.order.findUnique({
      where: { id: job.orderId },
      select: ORDER_EMAIL_SELECT,
    });

    if (!order) {
      await markJobFailed(job, 'Order no longer exists');
      return { status: 'failed', jobId: job.id };
    }

    if (order.processingEmailSentAt) {
      await finalizeAlreadyMarkedOutboxJob(job, order);
      return { status: 'sent', jobId: job.id, alreadyMarked: true };
    }

    if (!shouldSendProcessingEmail(order)) {
      await markJobFailed(
        job,
        'Order is no longer eligible for the processing email'
      );
      return { status: 'failed', jobId: job.id };
    }

    let result;

    try {
      result = await orderEmailService.sendOrderProcessingEmail(order, {
        idempotencyKey: job.idempotencyKey,
      });
    } catch (error) {
      if (error.duplicate) {
        try {
          await finalizeOutboxJob(job, order, {
            sentAt: now,
            providerMessageId: null,
          });
          return { status: 'sent', jobId: job.id, duplicate: true };
        } catch (finalizeError) {
          logger.error(
            { err: finalizeError, outboxJobId: job.id },
            'Brevo accepted the email but the outbox marker could not be recorded'
          );
          return {
            status: 'finalization_failed',
            jobId: job.id,
            error: finalizeError,
          };
        }
      }

      const retry = await scheduleRetry(job, error, now);
      logger.warn(
        {
          err: error,
          outboxJobId: job.id,
          orderReference: order.reference,
          status: retry.status,
          attempts: job.attempts,
        },
        'Order processing email delivery attempt failed'
      );
      return { status: retry.status, jobId: job.id, error };
    }

    try {
      await finalizeOutboxJob(job, order, {
        sentAt: now,
        providerMessageId: result?.messageId ?? null,
      });
    } catch (error) {
      logger.error(
        { err: error, outboxJobId: job.id, orderReference: order.reference },
        'Brevo accepted the email but the outbox marker could not be recorded'
      );
      return { status: 'finalization_failed', jobId: job.id, error };
    }

    return {
      status: 'sent',
      jobId: job.id,
      providerMessageId: result?.messageId ?? null,
    };
  },
};
