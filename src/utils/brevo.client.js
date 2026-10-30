import { assertEmailConfigured, emailConfig } from '../config/email.js';

const BREVO_BASE_URL = 'https://api.brevo.com/v3';
const DUPLICATE_CODES = new Set([
  'duplicate_parameter',
  'duplicate_request',
  'Request already processed',
]);

export class EmailDeliveryError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.code = options.code ?? 'EMAIL_DELIVERY_ERROR';
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? true;
    this.ambiguous = options.ambiguous ?? false;
    this.duplicate = options.duplicate ?? false;
    this.details = options.details;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function isTimeoutError(error) {
  return (
    error?.name === 'TimeoutError' ||
    error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR' ||
    error?.code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

function parseSender(value) {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);

  if (match) {
    return {
      name: match[1].replace(/^"|"$/g, '') || 'Kubecart',
      email: match[2].trim(),
    };
  }

  return { name: 'Kubecart', email: value.trim() };
}

export const brevoClient = {
  async sendTransactionalEmail({
    to,
    subject,
    htmlContent,
    textContent,
    tags,
    idempotencyKey,
  }) {
    assertEmailConfigured();

    let response;

    try {
      response = await fetch(`${BREVO_BASE_URL}/smtp/email`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'api-key': emailConfig.apiKey,
        },
        body: JSON.stringify({
          sender: parseSender(emailConfig.from),
          to,
          subject,
          htmlContent,
          textContent,
          ...(tags ? { tags } : {}),
          ...(idempotencyKey
            ? { headers: { idempotencyKey } }
            : {}),
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      throw new EmailDeliveryError(
        isTimeoutError(error)
          ? 'Brevo request timed out; delivery is uncertain'
          : 'Brevo request failed before a response was received',
        {
          code: isTimeoutError(error)
            ? 'BREVO_TIMEOUT'
            : 'BREVO_NETWORK_ERROR',
          retryable: true,
          ambiguous: true,
          cause: error,
        }
      );
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.status === 400 && DUPLICATE_CODES.has(data?.code)) {
      throw new EmailDeliveryError(
        'Brevo already accepted an email for this idempotency key',
        {
          code: 'BREVO_DUPLICATE',
          statusCode: 400,
          retryable: false,
          duplicate: true,
          details: data,
        }
      );
    }

    if (!response.ok) {
      throw new EmailDeliveryError(
        data?.message || 'Failed to send transactional email',
        {
          code: data?.code || 'BREVO_SEND_FAILED',
          statusCode: response.status >= 500 ? 502 : response.status,
          retryable:
            response.status === 429 || response.status >= 500,
          ambiguous: response.status >= 500,
          details: data,
        }
      );
    }

    return data;
  },
};
