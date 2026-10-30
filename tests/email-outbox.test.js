import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../src/config/db.js';
import {
  emailOutboxService,
  dedupeKeyForOrder,
  shouldSendProcessingEmail,
  MAX_ATTEMPTS,
  STALE_LOCK_MS,
  IDEMPOTENCY_TTL_MS,
} from '../src/services/email-outbox.service.js';
import { orderEmailService } from '../src/services/order-email.service.js';
import { EmailDeliveryError } from '../src/utils/brevo.client.js';
import { createEmailOutboxWorker } from '../src/workers/email-outbox.worker.js';

function makeOrder(overrides = {}) {
  return {
    id: 'ord-1',
    reference: 'KBC-ABC123',
    email: 'customer@kubecart.test',
    subtotalKobo: 2500000,
    deliveryFeeKobo: 150000,
    totalKobo: 2650000,
    currency: 'NGN',
    status: 'PENDING',
    paymentStatus: 'PAID',
    fulfillmentStatus: 'PROCESSING',
    requiresManualReview: false,
    processingEmailSentAt: null,
    createdAt: new Date('2026-10-30T10:00:00.000Z'),
    items: [],
    ...overrides,
  };
}

function makeJob(overrides = {}) {
  return {
    id: 'job-1',
    orderId: 'ord-1',
    type: 'ORDER_PROCESSING',
    dedupeKey: 'order-processing:ord-1',
    idempotencyKey: 'idem-1',
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date('2026-10-30T10:00:00.000Z'),
    firstAttemptAt: null,
    lastAttemptAt: null,
    lockedAt: null,
    lockedBy: null,
    sentAt: null,
    providerMessageId: null,
    lastError: null,
    createdAt: new Date('2026-10-30T10:00:00.000Z'),
    updatedAt: new Date('2026-10-30T10:00:00.000Z'),
    ...overrides,
  };
}

function mockOutboxJob(job) {
  vi.spyOn(prisma.emailOutbox, 'findFirst').mockImplementation(async () =>
    job.status === 'PENDING' ? { ...job } : null
  );
  vi.spyOn(prisma.emailOutbox, 'updateMany').mockImplementation(
    async ({ where, data }) => {
      if (where.id && where.id !== job.id) return { count: 0 };
      if (where.dedupeKey && where.dedupeKey !== job.dedupeKey) {
        return { count: 0 };
      }
      if (where.status && job.status !== where.status) return { count: 0 };
      Object.assign(job, data);
      return { count: 1 };
    }
  );
}

function mockFinalizeTx({ markerCount = 1, outboxCount = 1 } = {}) {
  const tx = {
    order: {
      updateMany: vi.fn().mockResolvedValue({ count: markerCount }),
      findUnique: vi.fn().mockResolvedValue(
        markerCount === 1 ? null : { processingEmailSentAt: null }
      ),
    },
    emailOutbox: {
      updateMany: vi.fn().mockResolvedValue({ count: outboxCount }),
    },
  };

  vi.spyOn(prisma, '$transaction').mockImplementation(async (callback) =>
    callback(tx)
  );

  return tx;
}

describe('Email outbox', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('only enqueues eligible PROCESSING orders with a stable dedupe key', async () => {
    const tx = {
      emailOutbox: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const now = new Date('2026-10-30T10:00:00.000Z');

    expect(
      await emailOutboxService.enqueueOrderProcessingEmail(
        tx,
        makeOrder({ processingEmailSentAt: new Date() }),
        { now }
      )
    ).toBeNull();
    expect(tx.emailOutbox.createMany).not.toHaveBeenCalled();

    await emailOutboxService.enqueueOrderProcessingEmail(tx, makeOrder(), {
      now,
    });

    const [call] = tx.emailOutbox.createMany.mock.calls;
    expect(call[0]).toEqual({
      data: [
        {
          orderId: 'ord-1',
          type: 'ORDER_PROCESSING',
          dedupeKey: dedupeKeyForOrder('ord-1'),
          idempotencyKey: expect.any(String),
          nextAttemptAt: now,
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.emailOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dedupeKey: dedupeKeyForOrder('ord-1'), status: 'FAILED' },
        data: expect.objectContaining({ status: 'PENDING', attempts: 0 }),
      })
    );
    expect(
      shouldSendProcessingEmail(
        makeOrder({ requiresManualReview: true })
      )
    ).toBe(false);
  });

  it('lets only one worker claim a due job', async () => {
    const job = makeJob();
    mockOutboxJob(job);

    const [first, second] = await Promise.all([
      emailOutboxService.claimNextOutboxJob({ workerId: 'worker-a' }),
      emailOutboxService.claimNextOutboxJob({ workerId: 'worker-b' }),
    ]);

    const claims = [first, second].filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe('SENDING');
    expect(job.status).toBe('SENDING');
    expect(job.attempts).toBe(1);
    expect(['worker-a', 'worker-b']).toContain(job.lockedBy);
  });

  it('sends once, records the order marker, and marks the outbox SENT', async () => {
    const job = makeJob();
    const order = makeOrder();
    const now = new Date('2026-10-30T10:05:00.000Z');
    mockOutboxJob(job);
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(order);
    const send = vi
      .spyOn(orderEmailService, 'sendOrderProcessingEmail')
      .mockResolvedValue({ messageId: 'brevo-message-1' });
    const tx = mockFinalizeTx();

    const result = await emailOutboxService.processNextOutboxJob({
      workerId: 'worker-a',
      now,
    });

    expect(result).toMatchObject({
      status: 'sent',
      jobId: 'job-1',
      providerMessageId: 'brevo-message-1',
    });
    expect(send).toHaveBeenCalledWith(order, {
      idempotencyKey: 'idem-1',
    });
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', processingEmailSentAt: null },
      data: { processingEmailSentAt: now },
    });
    expect(tx.emailOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'SENDING' },
      data: expect.objectContaining({
        status: 'SENT',
        sentAt: now,
        providerMessageId: 'brevo-message-1',
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      }),
    });
  });

  it('keeps the job SENDING when the order marker cannot be recorded', async () => {
    const job = makeJob();
    const order = makeOrder();
    mockOutboxJob(job);
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(order);
    vi.spyOn(orderEmailService, 'sendOrderProcessingEmail').mockResolvedValue({
      messageId: 'brevo-message-1',
    });
    mockFinalizeTx({ markerCount: 0 });

    const result = await emailOutboxService.processNextOutboxJob({
      workerId: 'worker-a',
    });

    expect(result.status).toBe('finalization_failed');
    expect(job.status).toBe('SENDING');
  });

  it('treats a Brevo duplicate as already accepted and records the marker', async () => {
    const job = makeJob();
    mockOutboxJob(job);
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(makeOrder());
    vi.spyOn(orderEmailService, 'sendOrderProcessingEmail').mockRejectedValue(
      new EmailDeliveryError('duplicate', {
        duplicate: true,
        retryable: false,
      })
    );
    const tx = mockFinalizeTx();

    const result = await emailOutboxService.processNextOutboxJob({
      workerId: 'worker-a',
    });

    expect(result).toMatchObject({ status: 'sent', duplicate: true });
    expect(tx.order.updateMany).toHaveBeenCalledOnce();
    expect(tx.emailOutbox.updateMany).toHaveBeenCalledOnce();
  });

  it('retries with the same idempotency key and applies exponential backoff', async () => {
    const job = makeJob();
    mockOutboxJob(job);
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(makeOrder());
    const send = vi
      .spyOn(orderEmailService, 'sendOrderProcessingEmail')
      .mockRejectedValue(
        new EmailDeliveryError('timeout', {
          retryable: true,
          ambiguous: true,
        })
      );

    const firstNow = new Date('2026-10-30T10:00:00.000Z');
    const first = await emailOutboxService.processNextOutboxJob({
      workerId: 'worker-a',
      now: firstNow,
    });

    expect(first.status).toBe('PENDING');
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(1);
    expect(job.nextAttemptAt.getTime()).toBe(firstNow.getTime() + 30_000);

    const secondNow = new Date(job.nextAttemptAt);
    const second = await emailOutboxService.processNextOutboxJob({
      workerId: 'worker-a',
      now: secondNow,
    });

    expect(second.status).toBe('PENDING');
    expect(job.attempts).toBe(2);
    expect(job.nextAttemptAt.getTime()).toBe(secondNow.getTime() + 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1]).toEqual({ idempotencyKey: 'idem-1' });
    expect(send.mock.calls[1][1]).toEqual({ idempotencyKey: 'idem-1' });
  });

  it('marks an ambiguous send UNCERTAIN after the retry limit is exhausted', async () => {
    const job = makeJob({
      attempts: MAX_ATTEMPTS - 1,
      firstAttemptAt: new Date('2026-10-30T10:00:00.000Z'),
    });
    mockOutboxJob(job);
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(makeOrder());
    vi.spyOn(orderEmailService, 'sendOrderProcessingEmail').mockRejectedValue(
      new EmailDeliveryError('timeout', {
        retryable: true,
        ambiguous: true,
      })
    );

    const result = await emailOutboxService.processNextOutboxJob({
      workerId: 'worker-a',
      now: new Date('2026-10-30T10:10:00.000Z'),
    });

    expect(result.status).toBe('UNCERTAIN');
    expect(job.status).toBe('UNCERTAIN');
  });

  it('marks a retry UNCERTAIN after the Brevo idempotency window expires', async () => {
    const now = new Date('2026-10-30T10:40:00.000Z');
    const job = makeJob({
      attempts: 1,
      firstAttemptAt: new Date(now.getTime() - IDEMPOTENCY_TTL_MS - 1),
    });
    mockOutboxJob(job);
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValue(makeOrder());
    vi.spyOn(orderEmailService, 'sendOrderProcessingEmail').mockRejectedValue(
      new EmailDeliveryError('timeout', {
        retryable: true,
        ambiguous: true,
      })
    );

    const result = await emailOutboxService.processNextOutboxJob({
      workerId: 'worker-a',
      now,
    });

    expect(result.status).toBe('UNCERTAIN');
    expect(job.status).toBe('UNCERTAIN');
  });

  it('recovers a stale SENDING job without double-sending', async () => {
    const now = new Date('2026-10-30T10:10:00.000Z');
    const job = makeJob({
      status: 'SENDING',
      attempts: 1,
      firstAttemptAt: new Date('2026-10-30T10:05:00.000Z'),
      lockedAt: new Date(now.getTime() - STALE_LOCK_MS - 1),
      lockedBy: 'dead-worker',
    });
    mockOutboxJob(job);
    vi.spyOn(prisma.emailOutbox, 'findMany').mockResolvedValue([job]);
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValue({
      processingEmailSentAt: null,
    });

    const recovered = await emailOutboxService.recoverStaleSendingJobs({ now });

    expect(recovered).toBe(1);
    expect(job.status).toBe('PENDING');
    expect(job.lockedAt).toBeNull();
    expect(job.lockedBy).toBeNull();
    expect(job.nextAttemptAt).toEqual(now);
  });

  it('marks a stale SENDING job SENT when the order marker already exists', async () => {
    const now = new Date('2026-10-30T10:10:00.000Z');
    const marker = new Date('2026-10-30T10:04:00.000Z');
    const job = makeJob({
      status: 'SENDING',
      attempts: 1,
      lockedAt: new Date(now.getTime() - STALE_LOCK_MS - 1),
      lockedBy: 'dead-worker',
    });
    mockOutboxJob(job);
    vi.spyOn(prisma.emailOutbox, 'findMany').mockResolvedValue([job]);
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValue({
      processingEmailSentAt: marker,
    });

    await emailOutboxService.recoverStaleSendingJobs({ now });

    expect(job.status).toBe('SENT');
    expect(job.sentAt).toEqual(marker);
  });

  it('marks an expired stale SENDING job UNCERTAIN instead of resending', async () => {
    const now = new Date('2026-10-30T10:45:00.000Z');
    const job = makeJob({
      status: 'SENDING',
      attempts: 1,
      firstAttemptAt: new Date(now.getTime() - IDEMPOTENCY_TTL_MS - 1),
      lockedAt: new Date(now.getTime() - STALE_LOCK_MS - 1),
      lockedBy: 'dead-worker',
    });
    mockOutboxJob(job);
    vi.spyOn(prisma.emailOutbox, 'findMany').mockResolvedValue([job]);
    vi.spyOn(prisma.order, 'findUnique').mockResolvedValue({
      processingEmailSentAt: null,
    });

    await emailOutboxService.recoverStaleSendingJobs({ now });

    expect(job.status).toBe('UNCERTAIN');
  });

  it('does not start the worker when email configuration is missing', async () => {
    const service = {
      recoverStaleSendingJobs: vi.fn(),
      processNextOutboxJob: vi.fn(),
    };
    const worker = createEmailOutboxWorker({
      config: {
        enabled: false,
        missing: ['BREVO_API_KEY', 'EMAIL_FROM', 'FRONTEND_URL'],
      },
      service,
    });

    expect(worker.start()).toBe(false);
    expect(await worker.runOnce()).toEqual({ status: 'disabled', processed: 0 });
    expect(service.recoverStaleSendingJobs).not.toHaveBeenCalled();
  });

  it('stops gracefully and waits for an in-flight tick', async () => {
    const service = {
      recoverStaleSendingJobs: vi.fn().mockResolvedValue(0),
      processNextOutboxJob: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(null), 20))
      ),
    };
    const worker = createEmailOutboxWorker({
      config: { enabled: true, missing: [] },
      service,
      intervalMs: 100000,
    });

    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 1));

    let stopped = false;
    const stopPromise = worker.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);

    await stopPromise;
    expect(stopped).toBe(true);
    expect(worker.isRunning()).toBe(false);
    expect(service.recoverStaleSendingJobs).toHaveBeenCalled();
  });
});
