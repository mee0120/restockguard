// PayPal REST client: Orders v2, Payouts, order tracking, webhook verification.
//
// PAYPAL_MODE=sandbox (default) talks to api-m.sandbox.paypal.com.
// PAYPAL_MODE=mock keeps everything in memory so the app runs without keys
// (used by the tests and for local UI work). Live mode is not supported on purpose.
import crypto from 'node:crypto';

const MODE = process.env.PAYPAL_MODE || 'sandbox';
const BASE = 'https://api-m.sandbox.paypal.com';
export const isMock = () => (process.env.PAYPAL_MODE || MODE) === 'mock';
export const clientId = () => process.env.PAYPAL_CLIENT_ID || 'mock-client-id';

let token = null;
let tokenExp = 0;

async function accessToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set');
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal auth failed: ${r.status}`);
  const j = await r.json();
  token = j.access_token;
  tokenExp = Date.now() + j.expires_in * 1000;
  return token;
}

async function api(method, path, body, requestId) {
  const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;   // PayPal-side idempotency
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) {
    const err = new Error(`PayPal ${method} ${path} -> ${r.status} ${data.name || ''} ${data.message || ''}`.trim());
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- mock state ----------
const mock = { orders: new Map(), payouts: new Map() };
const mid = (p) => p + crypto.randomBytes(6).toString('hex').toUpperCase();

// ---------- Orders (customer pays the store) ----------
export async function createOrder({ sku, name, qty, unitPrice }) {
  const value = (unitPrice * qty).toFixed(2);
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: sku,
      description: name.slice(0, 120),
      amount: {
        currency_code: 'USD', value,
        breakdown: { item_total: { currency_code: 'USD', value } },
      },
      items: [{ name: name.slice(0, 120), sku, quantity: String(qty), unit_amount: { currency_code: 'USD', value: unitPrice.toFixed(2) } }],
    }],
  };
  if (isMock()) {
    const id = mid('MOCKORDER');
    mock.orders.set(id, { id, status: 'CREATED', body });
    return { id, status: 'CREATED' };
  }
  return api('POST', '/v2/checkout/orders', body, crypto.randomUUID());
}

/** Capture after the buyer approved. Returns {captureId, payerEmail, shipTo, amount, status}. */
export async function captureOrder(orderId) {
  let data;
  if (isMock()) {
    const o = mock.orders.get(orderId);
    if (!o) throw new Error('unknown mock order');
    o.status = 'COMPLETED';
    data = {
      id: orderId, status: 'COMPLETED',
      payer: { email_address: 'buyer@personal.example.com', name: { given_name: 'Test', surname: 'Buyer' } },
      purchase_units: [{
        shipping: { name: { full_name: 'Test Buyer' }, address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', admin_area_1: 'CA', postal_code: '95131', country_code: 'US' } },
        payments: { captures: [{ id: mid('MOCKCAP'), status: 'COMPLETED', amount: o.body.purchase_units[0].amount }] },
      }],
    };
  } else {
    data = await api('POST', `/v2/checkout/orders/${orderId}/capture`, {}, `capture-${orderId}`);
  }
  const pu = data.purchase_units?.[0] || {};
  const cap = pu.payments?.captures?.[0] || {};
  const a = pu.shipping?.address || {};
  return {
    status: data.status,
    captureId: cap.id,
    amount: Number(cap.amount?.value || 0),
    payerEmail: data.payer?.email_address || '',
    shipTo: [pu.shipping?.name?.full_name, a.address_line_1, a.admin_area_2, a.admin_area_1, a.postal_code, a.country_code]
      .filter(Boolean).join(', '),
  };
}

// ---------- Payouts (the store pays its supplier) ----------
/**
 * One payout per customer order. sender_batch_id = "po-<orderId>" so PayPal itself
 * refuses a second payout for the same order even if our own check were bypassed.
 */
export async function paySupplier({ orderId, receiver, amount, note }) {
  const senderBatchId = `po-${orderId}`.slice(0, 127);
  const body = {
    sender_batch_header: { sender_batch_id: senderBatchId, email_subject: 'Purchase order payment', email_message: note },
    items: [{
      recipient_type: 'EMAIL', receiver, note, sender_item_id: orderId,
      amount: { value: amount.toFixed(2), currency: 'USD' },
    }],
  };
  if (isMock()) {
    if (mock.payouts.has(senderBatchId)) {
      const e = new Error('SENDER_BATCH_ID_ALREADY_USED');
      e.status = 400;
      throw e;
    }
    const res = { batch_header: { payout_batch_id: mid('MOCKBATCH'), batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: senderBatchId } } };
    mock.payouts.set(senderBatchId, res);
    return res;
  }
  return api('POST', '/v1/payments/payouts', body);
}

export async function getPayout(batchId) {
  if (isMock()) return { batch_header: { payout_batch_id: batchId, batch_status: 'SUCCESS' } };
  return api('GET', `/v1/payments/payouts/${batchId}`);
}

// ---------- Tracking back to the customer's order ----------
export async function addTracking({ orderId, captureId, trackingNumber, carrier }) {
  const body = {
    capture_id: captureId, tracking_number: trackingNumber,
    carrier: 'OTHER', carrier_name_other: carrier, notify_payer: false,
  };
  if (isMock()) return { id: orderId, status: 'TRACKED' };
  return api('POST', `/v2/checkout/orders/${orderId}/track`, body, `track-${orderId}`);
}

// ---------- Webhooks ----------
export async function verifyWebhook(headers, event) {
  if (isMock()) return true;
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const res = await api('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: event,
  });
  return res.verification_status === 'SUCCESS';
}
