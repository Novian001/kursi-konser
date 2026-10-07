# KursiKonser

Reserved-seat event ticketing with a **provably oversell-free** inventory core.
One event, one seat map, tiered time-window pricing, atomic multi-seat holds with
10-minute expiry, simulated/Midtrans payment, promo codes with atomic caps,
single-use QR entry, refunds, and money reconciliation.

Built for a 2 CPU / 2 GB VPS. Zero deps beyond Node 22 stdlib + SQLite in the
backend; frontend is Vite + React 19.

## Stack

- **Backend** — Node 22, `node:http` (no framework), `node:sqlite` (stdlib, WAL).
- **DB** — SQLite single file. (ponytail: ceiling = single-writer local deployment;
  upgrade path = Postgres `SELECT … FOR UPDATE` when multi-node concurrent writers
  arrive. All concurrency claims are single atomic statements, so they port intact.)
- **Frontend** — Vite 7 + React 19, seat-map grid, QR tickets, phone-camera gate scan.
- **Payment** — `mock` (zero-cost deterministic) or `midtrans` (sandbox/live, env-flag flip).

## Run

```bash
# backend (port 8787)
node backend/server.js
# override DB / payment:
DB_PATH=/tmp/kursi.db PAY_PROVIDER=mock PORT=8787 node backend/server.js
# Midtrans live: PAY_PROVIDER=midtrans MIDTRANS_SERVER_KEY=... MIDTRANS_IS_PRODUCTION=true

# frontend
cd frontend && npm install && API_PROXY=http://127.0.0.1:8787 npx vite --port 5173

# tests (13, no framework)
node --test backend/test/
```

## The four concurrency claims (each is a runnable test)

| Claim | Mechanism | Test |
|---|---|---|
| Oversell impossible | `UPDATE seat_state SET state='held' WHERE state='free'` — one seat, one winner; all-or-nothing block rolls back in a tx | `oversell race`, `hold atomicity` |
| Expired hold freeable | read-time expiry inside the hold tx; sweeper is cleanup-only, correctness never depends on it | `expired hold releases seat` |
| Promo cap never over K | conditional increment `WHERE used_total < cap_total` | `promo cap K of N` |
| Single-use QR | `UPDATE tickets SET used_at=? WHERE used_at IS NULL` — first scan wins, second rejected + logged | `concurrent double scan`, `forged QR` |

Plus: idempotent payment callback replay, callback amount never trusted over stored
total, price snapshot frozen at checkout (tier edits never rewrite history), refund
frees seat flagged resold, settlement invariant
`Σ splits == gross` and `gross == net + fees + tax + refunds` and
`Σ ticket snapshots − Σ discounts == gross` — with an injected discrepancy caught.

## API

```
GET  /event            seat map + tiers + live seat states
POST /hold             {seats:[id...]} → hold (all-or-nothing, 10 min)
POST /checkout         {hold_id, user_key, promo_code} → order pending + payment intent
POST /pay/mock/confirm {order_id}                        → pay (mock driver)
POST /pay/callback     Midtrans-signed callback (disabled in mock mode)
POST /gate/scan        {code, gate} → admit/reject, single-use, logged
POST /refund           {ticket_id, policy: full|partial_fee|fee_only}
POST /settle           reconciliation statement (throws if books don't balance)
GET  /tickets/:order   issued tickets (+QR payload)
```

## Roles / flow

Buyer → pick seats → hold (countdown) → checkout (promo applied server-side) →
pay (mock now, Midtrans later) → QR ticket → gate scan (phone camera) → one admit,
reject + log on re-scan. Admin → settle. Box office shares the same inventory
(same seats table) — no second source of truth to race against.

## Payment

Default is the zero-cost `mock` driver (no network, no keys — works offline).
Midtrans is wired in `backend/payment.js`: sandbox/live via
`MIDTRANS_IS_PRODUCTION`, `MIDTRANS_SERVER_KEY`; callback signature verified
(`sha512(order_id+status_code+gross_amount+key)`); amount re-checked against the
stored total. Flip `PAY_PROVIDER` and the code path changes, nothing else.

## Honest deployment status

Built and tested locally (13/13). Source on
[`Novian001/kursi-konser`](https://github.com/Novian001/kursi-konser).
**Frontend live:** https://kursi-konser-topaz.vercel.app (Vercel project root =
`frontend/`, build config in `vercel.json`).
Production is frontend-only by design: the backend (`node:sqlite`,
single-writer, single process) stays GitHub-only per deployment policy and runs
locally per the Run section — so `/api/*` answers 404 on Vercel and the app
renders an error banner instead of a seat map.
Seeded demo data: one concert, 78 seats
(Festival 6×10, VIP 3×6), tiers early-bird/regular/VIP, promo `HEMAT20`
(20%, cap 3). Box-office channel shares the same seat rows; the cashier flow is
the same hold→checkout→pay path.

## Docs

- `docs/architecture.md` — module map, data model, hold invariant, failure modes.
- `docs/screenshots/` — seat map + gate reject (verified live in browser QA).