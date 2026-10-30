import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, validateEnv } from '../src/config/env.js';
import { buildEmailConfig } from '../src/config/email.js';
import { orderEmailService } from '../src/services/order-email.service.js';

function makeOrder(overrides = {}) {
  return {
    id: 'ord-1',
    reference: 'KBC-ABC123',
    email: 'customer@kubecart.test',
    subtotalKobo: 2500000,
    deliveryFeeKobo: 150000,
    totalKobo: 2650000,
    currency: 'NGN',
    createdAt: new Date('2026-10-21T10:00:00.000Z'),
    items: [
      {
        productName: 'Wireless Keyboard',
        unitPriceKobo: 2000000,
        quantity: 1,
      },
      {
        productName: 'Mousepad',
        unitPriceKobo: 250000,
        quantity: 2,
      },
    ],
    ...overrides,
  };
}

describe('Order processing email', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds a branded HTML and plain-text email with order details and tracking link', () => {
    const order = makeOrder();
    const email = orderEmailService.buildOrderProcessingEmail(order);
    const trackingUrl = `${env.FRONTEND_URL.replace(/\/+$/, '')}/order`;

    expect(email.subject).toContain('KBC-ABC123');
    expect(email.htmlContent).toContain('#f5f7fb');
    expect(email.htmlContent).toContain('#ff6b35');
    expect(email.htmlContent).toContain('Payment confirmed');
    expect(email.htmlContent).toContain('Wireless Keyboard');
    expect(email.htmlContent).toContain('Mousepad');
    expect(email.htmlContent).toContain('Qty 2');
    expect(email.htmlContent).toContain('₦26,500.00');
    expect(email.htmlContent).toContain('Track Your Order');
    expect(email.htmlContent).toContain(`href="${trackingUrl}"`);

    expect(email.textContent).toContain('Wireless Keyboard x 1: ₦20,000.00');
    expect(email.textContent).toContain('Mousepad x 2: ₦5,000.00');
    expect(email.textContent).toContain('Total: ₦26,500.00');
    expect(email.textContent).toContain(`Track Your Order: ${trackingUrl}`);
  });

  it('escapes customer and product values interpolated into the HTML', () => {
    const email = orderEmailService.buildOrderProcessingEmail(
      makeOrder({
        reference: '<script>alert(1)</script>',
        items: [
          {
            productName: '<img src=x onerror=alert(1)>',
            unitPriceKobo: 100000,
            quantity: 1,
          },
        ],
      })
    );

    expect(email.htmlContent).not.toContain('<script>');
    expect(email.htmlContent).not.toContain('<img src=x');
    expect(email.htmlContent).toContain('&lt;script&gt;');
    expect(email.htmlContent).toContain('&lt;img src=x');
  });

  it('sends the transactional email through Brevo without exposing credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: 'brevo-message-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const order = makeOrder();
    const result = await orderEmailService.sendOrderProcessingEmail(order, {
      idempotencyKey: 'idem-123',
    });

    expect(result).toEqual({ messageId: 'brevo-message-1' });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(options.headers['api-key']).toBe(env.BREVO_API_KEY);
    expect(body.to).toEqual([{ email: 'customer@kubecart.test' }]);
    expect(body.subject).toContain('KBC-ABC123');
    expect(body.htmlContent).toContain('Track Your Order');
    expect(body.textContent).toContain('Track Your Order:');
    expect(body.tags).toEqual(['order-processing']);
    expect(body.headers).toEqual({ idempotencyKey: 'idem-123' });
  });

  it('treats a Brevo duplicate idempotency response as already accepted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'duplicate_parameter' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      orderEmailService.sendOrderProcessingEmail(makeOrder(), {
        idempotencyKey: 'idem-duplicate',
      })
    ).rejects.toMatchObject({
      code: 'BREVO_DUPLICATE',
      duplicate: true,
      retryable: false,
    });
  });

  it('allows API startup without Brevo configuration', () => {
    const source = { ...process.env };
    delete source.BREVO_API_KEY;
    delete source.EMAIL_FROM;
    delete source.FRONTEND_URL;

    expect(validateEnv(source).success).toBe(true);
    expect(buildEmailConfig({})).toMatchObject({
      enabled: false,
      missing: ['BREVO_API_KEY', 'EMAIL_FROM', 'FRONTEND_URL'],
    });
  });
});
