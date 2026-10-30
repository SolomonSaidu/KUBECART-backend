import { assertEmailConfigured, emailConfig } from '../config/email.js';
import { brevoClient } from '../utils/brevo.client.js';

const COLORS = {
  background: '#f5f7fb',
  panel: '#ffffff',
  card: '#f7f8ff',
  accent: '#ff6b35',
  dark: '#1a1f2c',
  text: '#172033',
  muted: '#67758b',
  line: '#e9edf5',
  success: '#16804b',
  successBackground: '#e9f7ef',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatMoney(kobo, currency = 'NGN') {
  const amount = (Number(kobo) || 0) / 100;
  const formatted = amount.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return currency === 'NGN' ? `₦${formatted}` : `${currency} ${formatted}`;
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('en-NG', {
    dateStyle: 'long',
    timeZone: 'Africa/Lagos',
  }).format(date);
}

function trackingUrl() {
  return `${emailConfig.frontendUrl.replace(/\/+$/, '')}/order`;
}

function buildItemRows(order) {
  return (order.items ?? [])
    .map((item) => {
      const quantity = Number(item.quantity) || 0;
      const lineTotal = (Number(item.unitPriceKobo) || 0) * quantity;

      return `
        <tr>
          <td style="padding:16px 0;border-bottom:1px solid ${COLORS.line};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:22px;color:${COLORS.text};">
            <span style="font-weight:600;">${escapeHtml(item.productName || 'Item')}</span>
            <span style="display:block;margin-top:2px;font-size:13px;line-height:20px;color:${COLORS.muted};">Qty ${quantity}</span>
          </td>
          <td align="right" style="padding:16px 0;border-bottom:1px solid ${COLORS.line};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:22px;font-weight:600;color:${COLORS.text};white-space:nowrap;">
            ${escapeHtml(formatMoney(lineTotal, order.currency))}
          </td>
        </tr>`;
    })
    .join('');
}

function buildHtml(order) {
  const reference = escapeHtml(order.reference);
  const orderDate = formatDate(order.createdAt);
  const orderUrl = escapeHtml(trackingUrl());
  const deliveryFee = formatMoney(order.deliveryFeeKobo, order.currency);
  const itemRows = buildItemRows(order);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>Your Kubecart order is being processed</title>
    <style>
      @media only screen and (max-width: 620px) {
        .email-shell { padding: 20px 12px !important; }
        .email-panel { border-radius: 18px !important; }
        .email-section { padding: 24px 20px !important; }
        .email-heading { font-size: 28px !important; line-height: 34px !important; }
        .email-button { display: block !important; width: 100% !important; box-sizing: border-box !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:${COLORS.background};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      Your payment is confirmed and Kubecart is preparing order ${reference}.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.background};">
      <tr>
        <td class="email-shell" align="center" style="padding:36px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;">
            <tr>
              <td style="padding:0 8px 18px 8px;">
                <span style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:24px;line-height:30px;font-weight:800;letter-spacing:-0.04em;color:${COLORS.dark};">
                  Kube<span style="color:${COLORS.accent};">cart</span>
                </span>
              </td>
            </tr>
            <tr>
              <td class="email-panel" style="background-color:${COLORS.panel};border-radius:24px;overflow:hidden;box-shadow:0 18px 45px rgba(23,32,51,0.08);">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td class="email-section" style="padding:38px 40px 10px 40px;">
                      <p style="margin:0 0 12px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;line-height:18px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${COLORS.accent};">
                        Order update
                      </p>
                      <h1 class="email-heading" style="margin:0 0 14px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.04em;color:${COLORS.dark};">
                        We're getting your order ready
                      </h1>
                      <p style="margin:0 0 22px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:16px;line-height:26px;color:${COLORS.muted};">
                        Your payment has been confirmed, and our team is now preparing your items for delivery.
                      </p>
                      <span style="display:inline-block;padding:8px 12px;border-radius:999px;background-color:${COLORS.successBackground};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;line-height:18px;font-weight:700;color:${COLORS.success};">
                        Payment confirmed
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td class="email-section" style="padding:28px 40px 8px 40px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLORS.card};border-radius:16px;">
                        <tr>
                          <td style="padding:22px 24px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                              <tr>
                                <td style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;line-height:20px;color:${COLORS.muted};">
                                  Order number
                                </td>
                                <td align="right" style="font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;line-height:20px;color:${COLORS.muted};">
                                  ${orderDate ? 'Order date' : ''}
                                </td>
                              </tr>
                              <tr>
                                <td style="padding-top:4px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:16px;line-height:24px;font-weight:700;color:${COLORS.dark};">
                                  ${reference}
                                </td>
                                <td align="right" style="padding-top:4px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:24px;font-weight:600;color:${COLORS.text};">
                                  ${escapeHtml(orderDate)}
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td class="email-section" style="padding:18px 40px 0 40px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td colspan="2" style="padding:0 0 4px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;line-height:18px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${COLORS.muted};">
                            Your items
                          </td>
                        </tr>
                        ${itemRows || `<tr><td style="padding:16px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:22px;color:${COLORS.text};">Your order items</td></tr>`}
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td class="email-section" style="padding:10px 40px 0 40px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td style="padding:8px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.muted};">
                            Subtotal
                          </td>
                          <td align="right" style="padding:8px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.text};">
                            ${escapeHtml(formatMoney(order.subtotalKobo, order.currency))}
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.muted};">
                            Delivery
                          </td>
                          <td align="right" style="padding:8px 0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:22px;color:${COLORS.text};">
                            ${Number(order.deliveryFeeKobo) === 0 ? 'Free' : escapeHtml(deliveryFee)}
                          </td>
                        </tr>
                        <tr>
                          <td style="padding:14px 0 4px 0;border-top:1px solid ${COLORS.line};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:16px;line-height:24px;font-weight:700;color:${COLORS.dark};">
                            Total
                          </td>
                          <td align="right" style="padding:14px 0 4px 0;border-top:1px solid ${COLORS.line};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:18px;line-height:24px;font-weight:800;color:${COLORS.dark};">
                            ${escapeHtml(formatMoney(order.totalKobo, order.currency))}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td class="email-section" align="center" style="padding:26px 40px 10px 40px;">
                      <a class="email-button" href="${orderUrl}" style="display:inline-block;padding:15px 28px;border-radius:999px;background-color:${COLORS.accent};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:22px;font-weight:700;color:#ffffff;text-decoration:none;">
                        Track Your Order
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td class="email-section" style="padding:10px 40px 36px 40px;">
                      <p style="margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:13px;line-height:22px;color:${COLORS.muted};text-align:center;">
                        This email was sent because your Kubecart order was paid and is now being processed.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 8px 0 8px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:12px;line-height:20px;color:${COLORS.muted};text-align:center;">
                Kubecart &middot; Quality picks, delivered with care.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildText(order) {
  const lines = [
    'Your Kubecart order is being processed',
    '',
    'Your payment has been confirmed, and our team is now preparing your items for delivery.',
    '',
    `Order number: ${order.reference}`,
    order.createdAt ? `Order date: ${formatDate(order.createdAt)}` : null,
    '',
    'Your items:',
    ...(order.items ?? []).map((item) => {
      const quantity = Number(item.quantity) || 0;
      const lineTotal = (Number(item.unitPriceKobo) || 0) * quantity;
      return `- ${item.productName || 'Item'} x ${quantity}: ${formatMoney(lineTotal, order.currency)}`;
    }),
    '',
    `Subtotal: ${formatMoney(order.subtotalKobo, order.currency)}`,
    `Delivery: ${Number(order.deliveryFeeKobo) === 0 ? 'Free' : formatMoney(order.deliveryFeeKobo, order.currency)}`,
    `Total: ${formatMoney(order.totalKobo, order.currency)}`,
    '',
    `Track Your Order: ${trackingUrl()}`,
    '',
    'This email was sent because your Kubecart order was paid and is now being processed.',
    'Kubecart - Quality picks, delivered with care.',
  ];

  return lines.filter((line) => line !== null).join('\n');
}

export const orderEmailService = {
  buildOrderProcessingEmail(order) {
    return {
      subject: `Your Kubecart order ${order.reference} is being processed`,
      htmlContent: buildHtml(order),
      textContent: buildText(order),
    };
  },

  async sendOrderProcessingEmail(order, { idempotencyKey } = {}) {
    assertEmailConfigured();
    const content = this.buildOrderProcessingEmail(order);

    return brevoClient.sendTransactionalEmail({
      to: [{ email: order.email }],
      ...content,
      tags: ['order-processing'],
      idempotencyKey,
    });
  },
};
