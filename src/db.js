// SQLite storage (Node's built-in node:sqlite, no native build step).
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY, name TEXT, gtin TEXT, price REAL, stock INTEGER,
  reorder_point INTEGER DEFAULT 0, image TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,              -- PayPal order id
  sku TEXT, qty INTEGER, sale_total REAL, customer TEXT, ship_to TEXT,
  capture_id TEXT, status TEXT,     -- created / paid / sourcing / purchased / held / blocked / failed
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS quotes (
  order_id TEXT, supplier TEXT, item_name TEXT, match TEXT, unit_cost REAL,
  shipping REAL, landed REAL, eta_days INTEGER, in_stock INTEGER, rank INTEGER,
  rejected_reason TEXT
);
CREATE TABLE IF NOT EXISTS purchases (
  order_id TEXT PRIMARY KEY,        -- one purchase per customer order (idempotency)
  supplier TEXT, amount REAL, payout_batch_id TEXT, payout_status TEXT,
  tracking TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  order_id TEXT, at TEXT, action TEXT, reason TEXT, explanation TEXT, checks TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  order_id TEXT PRIMARY KEY, supplier TEXT, amount REAL, reasons TEXT,
  status TEXT, created_at TEXT, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, type TEXT, received_at TEXT   -- webhook de-duplication
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
`;

export function openDb(path = process.env.DB_PATH || 'restockguard.db') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

export function getSetting(db, k, fallback = null) {
  const row = db.prepare('SELECT v FROM settings WHERE k=?').get(k);
  return row ? JSON.parse(row.v) : fallback;
}

export function setSetting(db, k, v) {
  db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .run(k, JSON.stringify(v));
}
