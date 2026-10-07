'use strict';
// SQLite via node:sqlite (stdlib, zero deps, zero extra process).
// ponytail: ceiling = single-writer local demo; upgrade path = Postgres + SELECT ... FOR UPDATE
// when multi-node / concurrent writers across processes are needed.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'database', 'kursi.db');

function open(dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed'))
);
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tiers (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  section_id INTEGER REFERENCES sections(id),
  name TEXT NOT NULL,             -- early-bird | regular | vip
  price_cents INTEGER NOT NULL,   -- integer minor units, IDR
  starts_at TEXT,                 -- window validity (tier price resolved at checkout)
  ends_at TEXT
);
CREATE TABLE IF NOT EXISTS seats (
  id INTEGER PRIMARY KEY,
  section_id INTEGER NOT NULL REFERENCES sections(id),
  row TEXT NOT NULL,
  num INTEGER NOT NULL,
  label TEXT NOT NULL,            -- 'A1'
  blocked INTEGER NOT NULL DEFAULT 0,
  accessible INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_seat_label ON seats(section_id, label);
-- ONE source of truth for the invariant: one seat = at most one active hold OR one paid ticket.
CREATE TABLE IF NOT EXISTS seat_state (
  seat_id INTEGER PRIMARY KEY REFERENCES seats(id),
  state TEXT NOT NULL DEFAULT 'free' CHECK (state IN ('free','held','sold')),
  hold_id INTEGER,
  ticket_id INTEGER,
  resold INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY,
  seats_json TEXT NOT NULL,        -- [seat_id,...] all-or-nothing block
  expires_at INTEGER NOT NULL,     -- epoch ms
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','converted','expired','cancelled'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  hold_id INTEGER REFERENCES holds(id),
  user_key TEXT NOT NULL,          -- anonymised buyer identity (no PII in demo)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','refunded')),
  total_cents INTEGER NOT NULL,
  lines_json TEXT NOT NULL DEFAULT '[]',
  promo_code TEXT,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL,          -- midtrans | mock
  provider_txn_id TEXT,            -- idempotency key on callback
  status TEXT NOT NULL DEFAULT 'created',
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_txn ON payments(provider, provider_txn_id)
  WHERE provider_txn_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  seat_id INTEGER NOT NULL REFERENCES seats(id),
  code TEXT NOT NULL UNIQUE,       -- signed opaque QR payload (HMAC), no guessable seq
  price_snapshot_cents INTEGER NOT NULL, -- immutable: tier at checkout time
  used_at INTEGER,
  scan_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scan_log (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER,
  code TEXT NOT NULL,
  ok INTEGER NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS promos (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('percent','fixed')),
  value INTEGER NOT NULL,
  starts_at INTEGER,
  ends_at INTEGER,
  event_id INTEGER REFERENCES events(id),
  cap_total INTEGER NOT NULL,          -- per-event cap (K)
  cap_per_customer INTEGER NOT NULL,
  used_total INTEGER NOT NULL DEFAULT 0 -- incremented conditionally: WHERE used_total < cap_total
);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY,
  promo_id INTEGER NOT NULL REFERENCES promos(id),
  user_key TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  at INTEGER NOT NULL,
  UNIQUE (promo_id, order_id)
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  policy TEXT NOT NULL CHECK (policy IN ('full','partial_fee','fee_only')),
  refund_cents INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settlement_runs (
  id INTEGER PRIMARY KEY,
  ran_at INTEGER NOT NULL,
  gross_cents INTEGER NOT NULL,
  fees_cents INTEGER NOT NULL,
  refunds_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  net_cents INTEGER NOT NULL,
  balanced INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
`);
}

// Seed: one event, one seat map, one promo, box-office + online channels.
function seed(db) {
  if (db.prepare('SELECT COUNT(*) c FROM events').get().c > 0) return;
  const now = Date.now();
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
  tx(() => {
    const ev = db.prepare("INSERT INTO events(name,venue,starts_at,status) VALUES(?,?,?,?)")
      .run('Konsert Pengantin Terakhir', 'Istora Senayan, Jakarta', '2026-11-14T19:30:00+07:00', 'published');
    const evId = ev.lastInsertRowid;
    const tiers = [
      // price_cents = IDR minor units: Rp450.000 = 45_000_000
      ['T1', 'Festival', 1, 'early-bird', 45_000_000, '2026-09-01', '2026-10-01'],
      ['T2', 'Festival', 1, 'regular', 60_000_000, '2026-10-01', '2026-11-14'],
      ['T3', 'VIP', 2, 'vip', 125_000_000, '2026-09-01', '2026-11-14'],
    ];
    const secIds = {};
    for (const secName of ['Festival', 'VIP']) {
      const s = db.prepare('INSERT INTO sections(event_id,name) VALUES(?,?)').run(evId, secName);
      secIds[secName] = s.lastInsertRowid;
    }
    for (const [, secName, , name, price, s0, s1] of tiers) {
      db.prepare('INSERT INTO tiers(event_id,section_id,name,price_cents,starts_at,ends_at) VALUES(?,?,?,?,?,?)')
        .run(evId, secIds[secName], name, price, s0, s1);
    }
    const seatIns = db.prepare('INSERT INTO seats(section_id,row,num,label,blocked,accessible) VALUES(?,?,?,?,?,?)');
    for (const [secName, rows, cols] of [['Festival', 6, 10], ['VIP', 3, 6]]) {
      for (let r = 0; r < rows; r++) {
        for (let c = 1; c <= cols; c++) {
          const label = String.fromCharCode(65 + r) + c;
          const id = seatIns.run(secIds[secName], String.fromCharCode(65 + r), c, label, 0, 0).lastInsertRowid;
          db.prepare("INSERT INTO seat_state(seat_id,state) VALUES(?,'free')").run(id);
        }
      }
    }
    // blocked + accessible seats to exercise the seat map rendering
    db.prepare("UPDATE seats SET blocked=1 WHERE section_id=? AND label='A10'").run(secIds['Festival']);
    db.prepare("UPDATE seats SET accessible=1 WHERE section_id=? AND label='F1'").run(secIds['Festival']);
    db.prepare(`INSERT INTO promos(code,kind,value,starts_at,ends_at,event_id,cap_total,cap_per_customer,used_total)
                VALUES('HEMAT20','percent',20,'2026-09-01','2026-11-14',?,3,1,0)`)
      .run(evId);
    db.prepare("INSERT INTO audit_log(actor,action,detail,at) VALUES('system','seed','one event / one map / one promo',?)").run(now);
  });
}

const h = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = { open, seed, DB_PATH, h };
