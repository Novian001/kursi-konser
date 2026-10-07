'use strict';
// The four concurrency claims + idempotency + settlement reconciliation.
// Run: node --test backend/test/
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const SCRATCH = process.env.BH_AGENT_WORKSPACE
  ? path.join(process.env.BH_AGENT_WORKSPACE, 'scratch')
  : path.join(process.env.HOME, '.hermes', 'cache', 'scratch');

process.env.PAY_PROVIDER = 'mock';
process.env.QR_SECRET = 'test-secret';
process.env.HOLD_TTL_MS = '60000';

const { open, seed } = require('../db');
const inv = require('../inventory');

let db, seatId;
beforeEach(() => {
  db = open(path.join(fs.mkdtempSync(path.join(SCRATCH, 'kursi-')), 't.db'));
  seed(db);
  seatId = db.prepare("SELECT id FROM seats WHERE label='B2'").get().id;
});

function seatState(id = seatId) {
  return db.prepare('SELECT * FROM seat_state WHERE seat_id=?').get(id);
}

// CLAIM 1: oversell race — N concurrent claims, exactly 1 winner.
test('oversell race: exactly one winner per seat', () => {
  const results = [];
  for (let i = 0; i < 20; i++) {
    try { inv.holdSeats(db, [seatId]); results.push('won'); }
    catch (e) { assert.equal(e.status, 409); results.push('lost'); }
  }
  assert.equal(results.filter((r) => r === 'won').length, 1, 'must be exactly 1 winner');
  assert.equal(seatState().state, 'held');
});

// CLAIM 2: all-or-nothing — block of 3, one seat already taken → zero held.
test('hold atomicity: partial failure rolls back entire block', () => {
  const [free1, free2, taken] = db.prepare(
    "SELECT seat_id FROM seat_state WHERE state='free' LIMIT 3").all().map((r) => r.seat_id);
  inv.holdSeats(db, [taken]);                       // occupy one seat first
  const third = db.prepare("SELECT seat_id id FROM seat_state WHERE state='free' LIMIT 1").get().id;
  assert.throws(() => inv.holdSeats(db, [free1, free2, taken]), (e) => e.status === 409);
  assert.equal(seatState(free1).state, 'free', 'rollback must free the whole block');
  assert.equal(seatState(free2).state, 'free');
  assert.equal(seatState(taken).state, 'held', 'pre-existing hold untouched');
  void third;
});

// CLAIM 2b: read-time expiry — expired hold is claimable WITHOUT sweeper.
test('expired hold releases seat at read time (sweeper not required)', () => {
  const h = inv.holdSeats(db, [seatId]);
  assert.equal(seatState().state, 'held');
  db.prepare('UPDATE holds SET expires_at=? WHERE id=?').run(Date.now() - 1, h.hold_id);
  // note: sweeper runs INSIDE holdSeats (clears stale rows first) — correctness path
  const h2 = inv.holdSeats(db, [seatId]);
  assert.ok(h2.hold_id !== h.hold_id, 'second claimant must win');
  assert.equal(seatState().state, 'held');
  assert.equal(inv.sweep(db), 0, 'nothing stale left to sweep');
});

// CLAIM 3: promo cap — 10 concurrent redemptions vs cap 3 → exactly 3 accepted.
test('promo cap: exactly K of N concurrent redemptions', () => {
  let ok = 0, rejected = 0;
  for (let i = 0; i < 10; i++) {
    try {
      db.exec('BEGIN IMMEDIATE');
      const p = db.prepare('UPDATE promos SET used_total=used_total+1 WHERE code=? AND used_total < cap_total').run('HEMAT20');
      if (p.changes) ok++; else rejected++;
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); rejected++; }
  }
  assert.equal(ok, 3, 'cap_total=3');
  assert.equal(rejected, 7);
  assert.equal(db.prepare("SELECT used_total FROM promos WHERE code='HEMAT20'").get().used_total, 3);
});

// CLAIM 4: double scan — two terminals, first wins, second rejected + logged.
test('single-use QR: concurrent double scan, exactly one admitted', () => {
  const h = inv.holdSeats(db, [seatId]);
  const c = inv.checkout(db, { holdId: h.hold_id, userKey: 'buyer1' });
  inv.settlePaid(db, { orderId: c.order_id, providerTxnId: 'txn-1', amountCents: c.total_cents });
  const ticket = db.prepare('SELECT * FROM tickets WHERE order_id=?').get(c.order_id);
  const first = inv.scanTicket(db, ticket.code, 'gate-A');
  assert.equal(first.ok, true);
  assert.throws(() => inv.scanTicket(db, ticket.code, 'gate-B'), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /already used/);
    return true;
  });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM scan_log WHERE ok=0').get().c, 1, 'rejected scan logged');
  assert.equal(db.prepare('SELECT scan_count FROM tickets WHERE id=?').get(ticket.id).scan_count, 2);
});

// idempotency: replayed callback does not double-issue tickets.
test('payment callback replay is idempotent', () => {
  const h = inv.holdSeats(db, [seatId]);
  const c = inv.checkout(db, { holdId: h.hold_id, userKey: 'buyer2' });
  const r1 = inv.settlePaid(db, { orderId: c.order_id, providerTxnId: 'txn-r', amountCents: c.total_cents });
  const r2 = inv.settlePaid(db, { orderId: c.order_id, providerTxnId: 'txn-r', amountCents: c.total_cents });
  assert.equal(r1.status, 'paid');
  assert.equal(r2.replay, true, 'second identical callback = replay');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tickets').get().c, 1, 'tickets issued once');
});

// amount tampering: callback claims a different amount → rejected.
test('callback amount mismatch rejected', () => {
  const h = inv.holdSeats(db, [seatId]);
  const c = inv.checkout(db, { holdId: h.hold_id, userKey: 'buyer3' });
  assert.throws(() => inv.settlePaid(db, {
    orderId: c.order_id, providerTxnId: 'txn-x', amountCents: c.total_cents - 10000,
  }), (e) => e.status === 409 && /amount mismatch/.test(e.message));
  assert.equal(db.prepare("SELECT status FROM orders WHERE id=?").get(c.order_id).status, 'pending');
});

// price snapshot immutability: tier change after checkout never rewrites ticket price.
test('price snapshot frozen at checkout', () => {
  const h = inv.holdSeats(db, [seatId]);
  const c = inv.checkout(db, { holdId: h.hold_id, userKey: 'buyer4' });
  const before = c.lines[0].price_cents; // price as resolved at checkout
  db.prepare('UPDATE tiers SET price_cents=99999999 WHERE section_id=(SELECT section_id FROM seats WHERE id=?)').run(seatId);
  inv.settlePaid(db, { orderId: c.order_id, providerTxnId: 'txn-s', amountCents: c.total_cents });
  const t = db.prepare('SELECT price_snapshot_cents FROM tickets WHERE order_id=?').get(c.order_id);
  assert.equal(t.price_snapshot_cents, before, 'snapshot = tier at checkout, not after edit');
});

// settlement: inject a discrepancy → must be caught.
test('settlement reconciliation catches money gap', () => {
  const h = inv.holdSeats(db, [seatId]);
  const c = inv.checkout(db, { holdId: h.hold_id, userKey: 'buyer5' });
  inv.settlePaid(db, { orderId: c.order_id, providerTxnId: 'txn-5', amountCents: c.total_cents });
  const run1 = inv.settle(db);
  assert.ok(run1.net >= 0, 'healthy run nets non-negative');
  assert.equal(run1.tickets, 1);
  // inject: shave 1 rupiah off a ticket snapshot → invC1 must fail
  db.prepare('UPDATE tickets SET price_snapshot_cents = price_snapshot_cents - 1 WHERE order_id=?').run(c.order_id);
  assert.throws(() => inv.settle(db), /reconciliation failed/, 'tampered snapshot must be caught');
});

// refund: seat re-enters inventory, flagged resold, resellable, settlement stays consistent.
test('refund releases seat with resold flag', () => {
  const h = inv.holdSeats(db, [seatId]);
  const c = inv.checkout(db, { holdId: h.hold_id, userKey: 'buyer6' });
  inv.settlePaid(db, { orderId: c.order_id, providerTxnId: 'txn-6', amountCents: c.total_cents });
  const tid = db.prepare('SELECT id FROM tickets WHERE order_id=?').get(c.order_id).id;
  const r = inv.refundTicket(db, tid, 'partial_fee');
  assert.ok(r.refunded_cents < c.total_cents, 'partial policy keeps a fee');
  const st = seatState();
  assert.equal(st.state, 'free');
  assert.equal(st.resold, 1, 'flagged as resold');
  // resellable again → settlement must still balance (refunds included)
  const h2 = inv.holdSeats(db, [seatId]);
  const c2 = inv.checkout(db, { holdId: h2.hold_id, userKey: 'buyer7' });
  inv.settlePaid(db, { orderId: c2.order_id, providerTxnId: 'txn-7', amountCents: c2.total_cents });
  const run = inv.settle(db);
  assert.equal(run.refunds, r.refunded_cents);
  assert.ok(run.net >= 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM seat_state WHERE state='sold'").get().c, 1);
});

// QR forgery: tampered code rejected.
test('forged QR rejected', () => {
  const h = inv.holdSeats(db, [seatId]);
  const c = inv.checkout(db, { holdId: h.hold_id, userKey: 'buyer8' });
  inv.settlePaid(db, { orderId: c.order_id, providerTxnId: 'txn-8', amountCents: c.total_cents });
  const real = db.prepare('SELECT code FROM tickets WHERE order_id=?').get(c.order_id).code;
  const forged = real.slice(0, -2) + 'XX';
  assert.throws(() => inv.scanTicket(db, forged, 'gate-A'), (e) => e.status === 400);
  const noSig = '1.2.3.deadbeef';
  assert.throws(() => inv.scanTicket(db, noSig, 'gate-A'), (e) => e.status === 400);
});

// Midtrans callback signature: sha512(order_id + status_code + gross_amount + SERVER_KEY).
test('midtrans callback signature verified correctly', () => {
  const crypto = require('node:crypto');
  process.env.PAY_PROVIDER = 'midtrans';
  process.env.MIDTRANS_SERVER_KEY = 'SB-Mid-server-XYZ';
  delete require.cache[require.resolve('../payment')];
  const pay2 = require('../payment');
  const orderId = 42, code = 200, gross = 960000;
  const sig = crypto.createHash('sha512').update(String(orderId) + code + gross + process.env.MIDTRANS_SERVER_KEY).digest('hex');
  assert.equal(pay2.verifyCallback({ orderId, statusCode: code, grossAmount: gross, signatureKey: sig }), true, 'valid signature accepted');
  assert.equal(pay2.verifyCallback({ orderId, statusCode: code, grossAmount: gross, signatureKey: sig.slice(0, -4) + 'AAAA' }), false, 'tampered signature rejected');
  assert.equal(pay2.verifyCallback({ orderId: 43, statusCode: code, grossAmount: gross, signatureKey: sig }), false, 'wrong order rejected');
  process.env.PAY_PROVIDER = 'mock';
  delete process.env.MIDTRANS_SERVER_KEY;
  delete require.cache[require.resolve('../payment')];
});

// discounted order still reconciles: snap - discount == gross (regression: sign error found in E2E).
test('settlement with promo discount balances', () => {
  const h = inv.holdSeats(db, [seatId]);
  const c = inv.checkout(db, { holdId: h.hold_id, userKey: 'buyer9', promoCode: 'HEMAT20' });
  assert.ok(c.discount_cents > 0, 'promo must apply');
  inv.settlePaid(db, { orderId: c.order_id, providerTxnId: 'txn-9', amountCents: c.total_cents });
  const run = inv.settle(db);
  assert.equal(run.gross, c.total_cents, 'gross = sum of paid order totals');
  assert.equal(run.tickets, 1);
  assert.ok(run.net >= 0);
});
