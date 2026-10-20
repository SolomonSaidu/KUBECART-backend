import crypto from 'node:crypto';
import { env } from '../config/env.js';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';

export const paystackClient = {
  /**
   * Initializes a transaction on Paystack
   * https://paystack.com/docs/api/transaction/#initialize
   */
  async initializeTransaction({ email, amountKobo, reference, callbackUrl }) {
    const url = `${PAYSTACK_BASE_URL}/transaction/initialize`;

    const body = {
      email,
      amount: amountKobo, // Paystack expects integer minor units (kobo)
      reference,
      currency: 'NGN',
    };

    if (callbackUrl) {
      body.callback_url = callbackUrl;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok || !data.status) {
      const error = new Error(data.message || 'Failed to initialize Paystack transaction');
      error.statusCode = response.status || 502;
      error.details = data;
      throw error;
    }

    return data.data; // { authorization_url, access_code, reference }
  },

  /**
   * Verifies a transaction on Paystack
   * https://paystack.com/docs/api/transaction/#verify
   */
  async verifyTransaction(reference) {
    const url = `${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      },
    });

    const data = await response.json();

    if (!response.ok || !data.status) {
      const error = new Error(data.message || 'Failed to verify Paystack transaction');
      error.statusCode = response.status || 502;
      error.details = data;
      throw error;
    }

    return data.data; // { status, reference, amount, currency, id, etc. }
  },

  /**
   * Verifies webhook HMAC-SHA512 signature using raw request body
   */
  verifyWebhookSignature(rawBody, signature) {
    if (!signature || !rawBody) {
      return false;
    }

    const computedSignature = crypto
      .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
      .update(rawBody)
      .digest('hex');

    // Constant time comparison to prevent timing attacks
    if (computedSignature.length !== signature.length) {
      return false;
    }

    return crypto.timingSafeEqual(Buffer.from(computedSignature), Buffer.from(signature));
  },
};
