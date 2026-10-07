'use strict';
// Monolith HTTP API. stdlib only (node:http) — no framework, one process.
const http = require('node:http');
const crypto = require('node:crypto');
const { open, seed } = require('./db');
const inv = require('./inventory');
const pay = require('./payment');

const db = open();
seed(db);
const PORT = Number(process.env.PORT || 8787);

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const fail = (res, e) => json(res, e.status || 500, { error: e.message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) reject(Object.assign(new Error('too big'), { status: 413 })); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
  });
}

const routes = {
  // seat map with live state (read-time expiry applied by holdSeats; cheap sweep keeps view clean)
  'GET /event': () => {
    inv.sweep(db);
    const event = db.prepare("SELECT * FROM events WHERE status='published' LIMIT 1").get();
    const tiers = db.prepare('SELECT * FROM tiers WHERE event_id=?').all(event.id);
    const seats = db.prepare(`SELECT ss.seat_id id, s.label, s.row, s.blocked, s.accessible,
                                      sec.name section, ss.state, ss.resold, ss.hold_id
                               FROM seats s JOIN sections sec ON sec.id=s.section_id
                               JOIN seat_state ss ON ss.seat_id=s.id
                              WHERE sec.event_id=?`).all(event.id);
    return { event, tiers, seats };
  },
  'POST /hold': async (req) => {
    const { seats, user_key } = await readBody(req);
    return inv.holdSeats(db, seats || []);
  },
  'POST /checkout': async (req) => {
    const b = await readBody(req);
    const c = inv.checkout(db, { holdId: b.hold_id, userKey: b.user_key || 'anon', promoCode: b.promo_code });
    const charge = await pay.createCharge({ orderId: c.order_id, amountCents: c.total_cents, customer: b.user_key });
    return { ...c, payment: { provider: charge.provider, redirect: charge.redirect } };
  },
  // mock driver: buyer "pays" here (sandbox stand-in for Midtrans redirect)
  'POST /pay/mock/confirm': async (req) => {
    const { order_id } = await readBody(req);
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(order_id);
    if (!order) throw Object.assign(new Error('order not found'), { status: 404 });
    const txn = 'mock-' + crypto.randomUUID();
    return inv.settlePaid(db, { orderId: order_id, providerTxnId: txn, amountCents: order.total_cents });
  },
  // gateway callback (Midtrans). Signature verified BEFORE touching state.
  'POST /pay/callback': async (req) => {
    // mock provider has no external gateway: callbacks are not a real attack surface,
    // so accepting them would only forge a paid state. Reject outright.
    if (pay.provider() === 'mock') throw Object.assign(new Error('callbacks disabled in mock mode'), { status: 403 });
    const b = await readBody(req);
    if (!pay.verifyCallback({ orderId: b.order_id, statusCode: b.status_code,
                              grossAmount: b.gross_amount, signatureKey: b.signature_key })) {
      throw Object.assign(new Error('bad signature'), { status: 401 });
    }
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(b.order_id));
    if (!order) throw Object.assign(new Error('order not found'), { status: 404 });
    if (!pay.isSuccess(b)) return { ok: true, noted: b.transaction_status || b.status };
    // amount check against STORED total, not callback claim
    return inv.settlePaid(db, { orderId: order.id, providerTxnId: b.transaction_id || b.order_id,
                                amountCents: order.total_cents });
  },
  'POST /gate/scan': async (req) => {
    const { code, gate } = await readBody(req);
    return inv.scanTicket(db, code, gate);
  },
  'POST /refund': async (req) => {
    const { ticket_id, policy } = await readBody(req);
    return inv.refundTicket(db, ticket_id, policy);
  },
  'POST /settle': async () => inv.settle(db),
  'GET /tickets/:order': (req, m) => db.prepare(
    `SELECT t.id, t.code, s.label seat, o.total_cents, o.status
       FROM tickets t JOIN seats s ON s.id=t.seat_id JOIN orders o ON o.id=t.order_id
      WHERE t.order_id=?`).all(Number(m[1])),
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  try {
    for (const [pattern, handler] of Object.entries(routes)) {
      const [mMethod, mPath] = pattern.split(' ');
      if (req.method !== mMethod) continue;
      const rx = new RegExp('^' + mPath.replace(/:[^/]+/g, '([^/]+)') + '$');
      const m = url.pathname.match(rx);
      if (m) return json(res, 200, await handler(req, m));
    }
    json(res, 404, { error: `no route ${key}` });
  } catch (e) { fail(res, e); }
}).listen(PORT, () => console.log(`kursi-konser api on :${PORT} provider=${pay.provider()}`));
