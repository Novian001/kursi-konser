# KursiKonser — Architecture

## Module map

```
backend/
  db.js         schema + seed (node:sqlite, WAL, FK on). One source of truth.
  inventory.js  ALL concurrency logic lives here (holds, checkout, pay, scan,
                refund, settle). Every claim = one atomic statement w/ WHERE guard.
  payment.js    provider interface: mock | midtrans (signature verify + idempotent settle)
  server.js     node:http monolith, JSON routes, path-match router
  test/         13 node:test + assert files, no framework
frontend/
  src/App.jsx       view router (map | checkout | tickets | gate | admin)
  src/SeatMap.jsx   seat grid: <button> per seat, 44px targets, a11y labels
  src/Checkout.jsx  promo via server (client never computes totals)
  src/Tickets.jsx   QR renders signed opaque ticket code
  src/Gate.jsx      phone camera scan: BarcodeDetector → fallback jsQR → manual input
  src/api.js        thin fetch client (/api → backend via vite proxy / vercel rewrite)
database/         single SQLite file (gitignored)
docs/
```

## Data model (core)

- `events → sections → seats` (seat = row + num + label + blocked/accessible)
- `tiers` (price per section, time-window; resolved at checkout, snapshotted)
- `seat_state` — the INVARIANT table: `state ∈ free|held|sold`, one row per seat,
  unique → one seat is at most one active hold OR one paid ticket
- `holds` (block of seat_ids, expires_at) · `orders` (pending|paid|refunded, lines_json
  = price snapshot) · `payments` (provider_txn_id UNIQUE = idempotency key)
- `tickets` (opaque HMAC-signed code, UNIQUE; scan_count) · `scan_log` (every accept AND reject)
- `promos` (cap_total, used_total; conditional increment) · `redemptions` (unique per order)
- `refunds` (policy: full|partial_fee|fee_only) · `settlement_runs` (each run balances or throws)
- `audit_log` (seed, refund, settlement)

## The hold invariant

> At any instant: for every seat, at most ONE live claim across **both** channels
> (online and box office share the same `seat_state` rows). A claim is either an
> unexpired hold or a paid ticket.

Implementation — three atomic statements, no application-lock dance:

1. **Claim:** `UPDATE seat_state SET state='held', hold_id=? WHERE seat_id=? AND state='free'`
   → exactly one winner; the loser's UPDATE changes 0 rows.
2. **Expiry:** same tx first runs
   `UPDATE seat_state … WHERE state='held' AND hold_id IN (SELECT id FROM holds WHERE expires_at < NOW)`
   → an expired hold is free **at read time**; the sweeper only tidies, correctness never waits for it.
3. **Sell:** `UPDATE seat_state SET state='sold', ticket_id=… WHERE seat_id=? AND state='held' AND hold_id=?`
   → payment converts only its own hold; a hold that lapsed between pending and pay
   throws instead of selling the seat twice.

All three within `BEGIN IMMEDIATE` (SQLite serialises writers under WAL).

## Failure modes + how they're caught

| Failure | Guard |
|---|---|
| Double-sell at expiry boundary | read-time expiry + statement-level WHERE guard (test 1, 3) |
| Partial hold leaks seats | all-or-nothing in one tx; miss → ROLLBACK (test 2) |
| Promo cap oversubscribed | `WHERE used_total < cap_total` conditional increment (test 4) |
| QR reuse / forgery | HMAC-signed opaque code + atomic `used_at` flip + `verifyCode` (tests 5, 11) |
| Callback replay | UNIQUE provider_txn_id → second identical callback is a no-op (test 6) |
| Callback amount lies | stored `total_cents` authoritative (test 7) |
| Tier edit rewrites history | price snapshot in `orders.lines_json` (test 8) |
| Money doesn't balance | settlement invariant A/B/C (tests 9, 13) |
| Refund double-spend / replay | `refunds` FK + seat re-enter with `resold=1`; dead ticket (test 10) |
| Fake midtrans callback | signature `sha512(order_id+status_code+gross+key)` (test 12) |

## Deployment

Frontend → Vercel (GitHub = source of truth; `vercel.json` rewrites `/api/*` to the
backend URL). Backend stays GitHub-only — **never a permanent backend on the VPS**
(2 CPU / 2 GB). Payment is mock/sandbox so no backend hosting is required for a
credible demo. `docs/screenshots/*` captured live in browser QA.

## Scope cuts (ponytail)

Waiting-room throttle, best-available auto-assign, ticket PDF, ticket transfer,
multi-event marketplaces: none needed for the core claim; each is a clean extension
point (throttle in server.js, auto-assign in inventory.js), add when a client asks.