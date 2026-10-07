'use strict';
// Payment: one interface, two drivers.
//   - 'midtrans'  real gateway (sandbox or live), signature-verified callback
//   - 'mock'      deterministic fake provider (tests / demo, zero cost)
// Flip via env: PAY_PROVIDER, MIDTRANS_SERVER_KEY, MIDTRANS_IS_PRODUCTION, MIDTRANS_MERCHANT_ID.
const crypto = require('node:crypto');

const IS_PROD = String(process.env.MIDTRANS_IS_PRODUCTION || 'false') === 'true';
const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || '';
const API = IS_PROD
  ? 'https://api.midtrans.com/v2'
  : 'https://api.sandbox.midtrans.com/v2';

const provider = () =>
  (process.env.PAY_PROVIDER || (SERVER_KEY ? 'midtrans' : 'mock'));

// create payment intent (Snap/Core API charge)
async function createCharge({ orderId, amountCents, customer }) {
  const p = provider();
  if (p === 'mock') {
    return { provider: 'mock', orderId, amountCents, redirect: `/pay/mock/${orderId}` };
  }
  if (!SERVER_KEY) throw Object.assign(new Error('MIDTRANS_SERVER_KEY missing'), { status: 500 });
  const res = await fetch(`${API}/charge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Basic ' + Buffer.from(SERVER_KEY + ':').toString('base64'),
    },
    body: JSON.stringify({
      transaction_details: { order_id: String(orderId), gross_amount: amountCents },
      customer_details: customer ? { first_name: customer } : undefined,
      payment_type: 'gopay', // test instrument in sandbox; VA/QRIS enabled when live
    }),
  });
  const j = await res.json();
  if (!res.ok) throw Object.assign(new Error(j.status_message || 'charge failed'), { status: 502 });
  return { provider: 'midtrans', orderId, amountCents, redirect: j.redirect_url, raw: j };
}

// callback verification — Midtrans signature: sha512(order_id + status_code + gross_amount + SERVER_KEY)
function verifyCallback({ orderId, statusCode, grossAmount, signatureKey }) {
  if (provider() === 'mock') return true; // mock driver has no external attacker surface
  if (!SERVER_KEY) return false;
  const expect = crypto.createHash('sha512')
    .update(String(orderId) + String(statusCode) + String(grossAmount) + SERVER_KEY)
    .digest('hex');
  const a = Buffer.from(String(signatureKey || ''));
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// success verdict from a verified callback payload
function isSuccess(payload) {
  if (provider() === 'mock') return payload.status === 'settlement';
  return payload.transaction_status === 'capture' || payload.transaction_status === 'settlement';
}

module.exports = { createCharge, verifyCallback, isSuccess, provider };
