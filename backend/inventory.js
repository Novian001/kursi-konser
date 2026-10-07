'use strict';
// Inventory core: the four concurrency claims live here.
// All claims = single SQL statement with a WHERE guard. Statement-level atomicity
// (SQLite serialises writers under WAL) makes double-sell impossible without locks.
const crypto = require('node:crypto');

const MIN = 60_000;                 // hold TTL = 10 min (single knob, change here)
const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 10 * MIN);
const QR_SECRET = process.env.QR_SECRET || 'dev-qr-secret-change-in-prod'; // prod: env only

const now = () => Date.now();
const reason = (code, msg) => Object.assign(new Error(msg), { status: code });

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// --- CLAIM 1 + 2: all-or-nothing multi-seat hold with read-time expiry ---
function holdSeats(db, seatIds) {
  seatIds = [...new Set(seatIds)];
  if (!seatIds.length) throw reason(400, 'no seats');
  return tx(db, () => {
    const t = now();
    // read-time expiry: a stale 'held' row whose hold has expired is claimable NOW.
    // (sweeper only cleans; correctness never depends on it running)
    const cleared = db.prepare(
      `UPDATE seat_state SET state='free', hold_id=NULL
        WHERE state='held' AND hold_id IN (SELECT id FROM holds WHERE expires_at < ?)`)
      .run(t).changes;
    const h = db.prepare('INSERT INTO holds(seats_json,expires_at,created_at) VALUES(?,?,?)')
      .run(JSON.stringify(seatIds), t + HOLD_TTL_MS, t);
    const claim = db.prepare(
      `UPDATE seat_state SET state='held', hold_id=?
        WHERE seat_id=? AND state='free'`);
    let claimed = 0;
    for (const sid of seatIds) claimed += claim.run(h.lastInsertRowid, sid).changes;
    // all-or-nothing: any miss throws → ROLLBACK releases every seat claimed in this tx
    if (claimed !== seatIds.length) throw reason(409, 'seat unavailable');
    return { hold_id: h.lastInsertRowid, expires_at: t + HOLD_TTL_MS, cleared };
  });
}

function holdActive(db, holdId) {
  const h = db.prepare('SELECT * FROM holds WHERE id=?').get(holdId);
  if (!h) throw reason(404, 'hold not found');
  if (h.status === 'converted') return h;
  if (h.expires_at < now()) throw reason(410, 'hold expired');
  if (h.status !== 'active') throw reason(409, 'hold not active');
  return h;
}

// --- price tier resolved at checkout, snapshotted onto ticket ---
function tierFor(db, sectionId) {
  const t = now();
  const ymd = new Date(t).toISOString().slice(0, 10);
  const row = db.prepare(
    `SELECT * FROM tiers WHERE section_id=?
       AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)
     ORDER BY price_cents ASC LIMIT 1`)
    .get(sectionId, ymd, ymd);
  if (!row) throw reason(409, 'no active tier for seat');
  return row;
}

// --- CLAIM 3: promo cap — conditional increment, never over K ---
function redeemPromo(db, code, userKey, orderId) {
  const p = db.prepare('SELECT * FROM promos WHERE code=?').get((code || '').toUpperCase());
  if (!p) throw reason(404, 'promo not found');
  const ymd = new Date(now()).toISOString().slice(0, 10);
  if (p.starts_at && p.starts_at > ymd || p.ends_at && p.ends_at < ymd) throw reason(409, 'promo window closed');
  const mine = db.prepare('SELECT COUNT(*) c FROM redemptions WHERE promo_id=? AND user_key=?')
    .get(p.id, userKey).c;
  if (mine >= p.cap_per_customer) throw reason(409, 'per-customer cap reached');
  // the K-guard: succeeds only while used_total < cap_total, atomically.
  const bumped = db.prepare('UPDATE promos SET used_total=used_total+1 WHERE id=? AND used_total < cap_total')
    .run(p.id).changes;
  if (!bumped) throw reason(409, 'promo cap reached');
  try {
    db.prepare('INSERT INTO redemptions(promo_id,user_key,order_id,at) VALUES(?,?,?,?)')
      .run(p.id, userKey, orderId, now());
  } catch (e) {
    db.prepare('UPDATE promos SET used_total=used_total-1 WHERE id=?').run(p.id); // unique(order,promo) bounce-back
    throw reason(409, 'promo already redeemed for this order');
  }
  return p;
}

function priceOf(p, baseCents) {
  if (!p) return 0;
  return p.kind === 'percent'
    ? Math.round(baseCents * p.value / 100)
    : Math.min(p.value, baseCents);
}

// --- checkout: order pending + payment intent. Seats stay held. ---
function checkout(db, { holdId, userKey, promoCode }) {
  return tx(db, () => {
    const h = holdActive(db, holdId);
    const seats = JSON.parse(h.seats_json);
    // re-assert all still held by this hold (guards holdId reuse / expiry race inside tx)
    for (const sid of seats) {
      const s = db.prepare('SELECT state,hold_id FROM seat_state WHERE seat_id=?').get(sid);
      if (s.state !== 'held' || s.hold_id !== holdId) throw reason(409, 'seat lost hold');
    }
    let base = 0;
    const lines = seats.map((sid) => {
      const seat = db.prepare('SELECT * FROM seats WHERE id=?').get(sid);
      const tier = tierFor(db, seat.section_id);
      base += tier.price_cents;
      return { seat_id: sid, label: seat.label, price_cents: tier.price_cents, tier: tier.name };
    });
    const order = db.prepare('INSERT INTO orders(hold_id,user_key,status,total_cents,lines_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(holdId, userKey, 'pending', base, JSON.stringify(lines), now());
    const orderId = order.lastInsertRowid;
    let discount = 0;
    if (promoCode) discount = priceOf(redeemPromo(db, promoCode, userKey, orderId), base);
    const total = base - discount;
    db.prepare('UPDATE orders SET total_cents=?, promo_code=?, discount_cents=? WHERE id=?')
      .run(total, promoCode ? promoCode.toUpperCase() : null, discount, orderId);
    db.prepare('INSERT INTO payments(order_id,provider,provider_txn_id,status,amount_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(orderId, process.env.PAY_PROVIDER || 'mock', null, 'created', total, now(), now());
    return { order_id: orderId, total_cents: total, base_cents: base, discount_cents: discount, lines,
             expires_at: h.expires_at };
  });
}

// --- CLAIM 4 guard path: pay → convert hold → issue tickets (idempotent per txn) ---
function settlePaid(db, { orderId, providerTxnId, amountCents }) {
  return tx(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!order) throw reason(404, 'order not found');
    // idempotency: replay of the SAME provider txn is a no-op, not a double issue
    const seen = db.prepare('SELECT id FROM payments WHERE provider=? AND provider_txn_id=?')
      .get(process.env.PAY_PROVIDER || 'mock', providerTxnId);
    if (seen) return { order_id: orderId, status: order.status, replay: true };
    if (order.status === 'paid') return { order_id: orderId, status: 'paid', replay: true };
    if (order.status !== 'pending') throw reason(409, `order ${order.status}`);
    // amount from STORED total — callback amount never trusted over it
    if (amountCents !== undefined && amountCents !== order.total_cents) throw reason(409, 'amount mismatch');
    if (order.hold_id) {
      const h = db.prepare('SELECT * FROM holds WHERE id=?').get(order.hold_id);
      const seats = JSON.parse(h.seats_json);
      for (const sid of seats) {
        const s = db.prepare('SELECT state,hold_id FROM seat_state WHERE seat_id=?').get(sid);
        if (s.state !== 'held' || s.hold_id !== h.id) {
          // hold expired between pending and pay: seats may be gone — never oversell
          throw reason(409, 'hold lapsed, seats released');
        }
      }
      // ticket snapshot: price lines frozen at checkout (order.lines_json), never re-resolved
      const lines = JSON.parse(order.lines_json);
      for (const l of lines) {
        const code = signCode(orderId, l.seat_id);
        db.prepare(`INSERT INTO tickets(order_id,seat_id,code,price_snapshot_cents) VALUES(?,?,?,?)`)
          .run(orderId, l.seat_id, code, l.price_cents);
        // CLAIM 1 final: conditional hold→sold, single statement, WHERE guard
        const moved = db.prepare(`UPDATE seat_state SET state='sold', ticket_id=(SELECT id FROM tickets WHERE code=?)
                                    WHERE seat_id=? AND state='held' AND hold_id=?`)
          .run(code, l.seat_id, h.id).changes;
        if (moved !== 1) throw reason(409, 'seat claim lost');
      }
      db.prepare("UPDATE holds SET status='converted' WHERE id=?").run(h.id);
    }
    db.prepare("UPDATE orders SET status='paid', paid_at=? WHERE id=?").run(now(), orderId);
    db.prepare(`UPDATE payments SET status='paid', provider_txn_id=?, updated_at=?
                 WHERE order_id=? AND status='created'`).run(providerTxnId, now(), orderId);
    return { order_id: orderId, status: 'paid' };
  });
}

// --- CLAIM 4: single-use QR — scan_count guarded in one statement ---
function scanTicket(db, code, gate) {
  const t = db.prepare('SELECT * FROM tickets WHERE code=?').get(code);
  const at = now();
  const log = (ok, why) => db.prepare('INSERT INTO scan_log(ticket_id,code,ok,reason,at) VALUES(?,?,?,?,?)')
    .run(t ? t.id : null, code, ok ? 1 : 0, why, at);
  if (!verifyCode(code)) { log(0, 'bad signature'); throw reason(400, 'invalid QR'); }
  if (!t) { log(0, 'unknown'); throw reason(404, 'ticket not found'); }
  // refunded/cancelled order → ticket dead even though row exists
  const ord = db.prepare('SELECT status FROM orders WHERE id=?').get(t.order_id);
  if (!ord || ord.status !== 'paid') { log(0, `order ${ord ? ord.status : 'missing'}`); throw reason(409, 'ticket not valid (order not paid)'); }
  // atomic single-use: only the first scan flips used_at; concurrent second gets changes=0
  const flipped = db.prepare('UPDATE tickets SET used_at=? WHERE id=? AND used_at IS NULL').run(at, t.id).changes;
  if (!flipped) {
    db.prepare('UPDATE tickets SET scan_count=scan_count+1 WHERE id=?').run(t.id);
    log(0, `duplicate scan #${t.scan_count + 1} at ${new Date(t.used_at).toISOString()}`);
    throw reason(409, 'ticket already used');
  }
  db.prepare('UPDATE tickets SET scan_count=scan_count+1 WHERE id=?').run(t.id);
  log(1, `admitted by ${gate || 'unknown'}`);
  const seat = db.prepare('SELECT s.label, sec.name sec FROM seats s JOIN sections sec ON sec.id=s.section_id WHERE s.id=?').get(t.seat_id);
  return { ok: true, seat: seat.label, section: seat.sec };
}

// --- refund: policy-driven, seat re-enters inventory flagged resold ---
function refundTicket(db, ticketId, policy) {
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
    if (!t) throw reason(404, 'ticket not found');
    if (db.prepare('SELECT id FROM refunds WHERE ticket_id=?').get(ticketId)) throw reason(409, 'already refunded');
    const price = t.price_snapshot_cents;
    const policyAmt = { full: price, partial_fee: Math.round(price * 0.9), fee_only: 0 }[policy];
    if (policyAmt === undefined) throw reason(400, 'unknown policy');
    db.prepare('INSERT INTO refunds(ticket_id,policy,refund_cents,at) VALUES(?,?,?,?)').run(ticketId, policy, policyAmt, now());
    db.prepare("UPDATE orders SET status='refunded' WHERE id=? AND status='paid'").run(t.order_id);
    // seat returns: hold→free (resold=1 marks it ever went out and came back)
    const moved = db.prepare(`UPDATE seat_state SET state='free', hold_id=NULL, ticket_id=NULL, resold=1
                                WHERE seat_id=? AND state='sold' AND ticket_id=?`).run(t.seat_id, ticketId).changes;
    if (moved !== 1) throw reason(409, 'seat not in sold state');
    // ticket row kept (refunds FK references it); scan rejects it via order status below
    audit(db, 'refund', JSON.stringify({ ticketId, policy, policyAmt }));
    return { refunded_cents: policyAmt, policy };
  });
}

// --- settlement invariant: Σ(split_organizer + split_platform) over paid orders
//     == collected, and collected - fees - tax - refunds == net, no gap.
//     Plus 3-way reconciliation: money vs tickets vs seats sold. ---
function settle(db, { feeBps = 200, taxBps = 1100, organizerShareBps = 7000 } = {}) {
  return tx(db, () => {
    // gross = every order that ever collected money (paid + later refunded).
    // refunds are an outflow against gross; excluding refunded orders from gross while
    // counting their refunds made net artificially negative.
    const allOrders = db.prepare("SELECT id,total_cents,status FROM orders WHERE status IN ('paid','refunded')").all();
    const gross = allOrders.reduce((a, o) => a + o.total_cents, 0);
    const activeOrders = allOrders.filter((o) => o.status === 'paid');
    const active = activeOrders.reduce((a, o) => a + o.total_cents, 0);
    const refunds = db.prepare('SELECT COALESCE(SUM(refund_cents),0) s FROM refunds').get().s;
    // splits computed per order (integer math, rounding drift absorbed by platform)
    let splitOrg = 0, splitPlat = 0;
    for (const o of allOrders) {
      const org = Math.round(o.total_cents * organizerShareBps / 10000);
      splitOrg += org;
      splitPlat += o.total_cents - org;
    }
    const fees = Math.round(gross * feeBps / 10000);
    const tax = Math.round(gross * taxBps / 10000);
    const net = gross - fees - tax - refunds;
    // invariant A: money in == splits
    const invA = splitOrg + splitPlat === gross;
    // invariant B: gross out == net + fees + tax + refunds
    const invB = net + fees + tax + refunds === gross;
    // invariant C1: Σ ticket snapshots + Σ discounts over ever-paid orders == gross.
    // catches price-snapshot drift or a ticket issued outside a paid order.
    // invariant C2: ACTIVE tickets (order still paid) == seats currently sold.
    const seatsSold = db.prepare("SELECT COUNT(*) c FROM seat_state WHERE state='sold'").get().c;
    const snapAll = db.prepare(`SELECT COALESCE(SUM(t.price_snapshot_cents),0) s
                                FROM tickets t JOIN orders o ON o.id=t.order_id
                               WHERE o.status IN ('paid','refunded')`).get().s;
    const discountsAll = db.prepare("SELECT COALESCE(SUM(discount_cents),0) s FROM orders WHERE status IN ('paid','refunded')").get().s;
    const snapActive = db.prepare(`SELECT COUNT(*) c FROM tickets t JOIN orders o ON o.id=t.order_id
                                   WHERE o.status='paid'`).get().c;
    const invC1 = snapAll - discountsAll === gross; // order total = snapshot - discount
    const invC2 = snapActive === seatsSold;
    const ok = invA && invB && invC1 && invC2 && net >= 0;
    const r = db.prepare(`INSERT INTO settlement_runs(ran_at,gross_cents,fees_cents,refunds_cents,tax_cents,net_cents,balanced)
                          VALUES(?,?,?,?,?,?,?)`).run(now(), gross, fees, refunds, tax, net, ok ? 1 : 0);
    audit(db, 'settlement', JSON.stringify({ run: r.lastInsertRowid, ok, invA, invB, invC1, invC2, ticketsActive: snapActive, seatsSold, orders: allOrders.length }));
    if (!ok) throw reason(500, `settlement reconciliation failed: ${JSON.stringify({ invA, invB, invC1, invC2, net })}`);
    return { run_id: r.lastInsertRowid, gross, collected_active: active, split_organizer: splitOrg, split_platform: splitPlat,
             fees, tax, refunds, net, tickets: snapActive, seats_sold: seatsSold };
  });
}

// --- signed opaque QR: HMAC, no guessable sequence ---
const b64u = (b) => Buffer.from(b, 'base64url');
function signCode(orderId, seatId) {
  const body = `${orderId}.${seatId}.${crypto.randomUUID()}`;
  const sig = crypto.createHmac('sha256', QR_SECRET).update(body).digest('base64url').slice(0, 22);
  return `${body}.${sig}`;
}
function verifyCode(code) {
  const parts = String(code || '').split('.');
  if (parts.length !== 4) return false;
  const expect = crypto.createHmac('sha256', QR_SECRET).update(parts.slice(0, 3).join('.')).digest('base64url').slice(0, 22);
  const a = Buffer.from(parts[3]); const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function audit(db, action, detail, actor = 'system') {
  db.prepare('INSERT INTO audit_log(actor,action,detail,at) VALUES(?,?,?,?)').run(actor, action, detail, now());
}

// sweeper: cleanup ONLY — correctness never depends on it (read-time expiry handles that)
function sweep(db) {
  return db.prepare(
    `UPDATE seat_state SET state='free', hold_id=NULL
      WHERE state='held' AND hold_id IN (SELECT id FROM holds WHERE expires_at < ?)`)
    .run(now()).changes;
}

module.exports = { holdSeats, holdActive, checkout, settlePaid, scanTicket, refundTicket,
                   settle, sweep, signCode, verifyCode, redeemPromo, audit, HOLD_TTL_MS };
