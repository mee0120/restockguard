// End-to-end flows in PayPal mock mode (no keys, no network).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.PAYPAL_MODE = 'mock';
process.env.LLM_API_KEY = '';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-')), 'test.db');

const { app, db } = await import('../src/server.js');
const { handlePaidOrder } = await import('../src/agent.js');
const { setSupplierCost, resetSupplierCosts } = await import('../src/catalog.js');
let base;
before(async () => {
  await new Promise((r) => { const s = app.listen(0, () => { base = `http://127.0.0.1:${s.address().port}`; s.unref(); r(); }); });
});
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(base + p).then((r) => r.json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function buy(sku, qty = 1) {
  const { id } = await post('/api/orders', { sku, qty });
  const c = await post(`/api/orders/${id}/capture`, {});
  assert.equal(c.status, 'paid');
  for (let i = 0; i < 50; i++) {
    const d = await get(`/api/orders/${id}`);
    if (!['paid', 'sourcing'].includes(d.order.status)) return d;
    await wait(20);
  }
  throw new Error('agent did not finish');
}

test('coffee: skips the cheaper new supplier, buys from A, adds tracking', async () => {
  resetSupplierCosts();
  const d = await buy('COF-1KG');
  assert.equal(d.order.status, 'purchased');
  assert.equal(d.purchase.supplier, 'A');
  assert.equal(d.purchase.amount, 23.5);
  assert.ok(d.purchase.tracking);
  assert.match(d.decisions.at(-1).reason + d.decisions.map((x) => x.reason).join(), /Skipped cheaper: Supplier C/);
  assert.ok(d.quotes.some((q) => q.supplier === 'B' && /arrives in 8 days/.test(q.rejected_reason)));
});

test('matcha: buys direct from Japan (GTIN match)', async () => {
  const d = await buy('MAT-100');
  assert.equal(d.order.status, 'purchased');
  assert.equal(d.purchase.supplier, 'B');
});

test('2 earbuds: above the per-order limit -> waits for the owner, approval pays', async () => {
  const d = await buy('EAR-PRO', 2);
  assert.equal(d.order.status, 'held');
  const dash = await get('/api/dashboard');
  assert.ok(dash.approvals.find((a) => a.order_id === d.order.id));
  const r = await post(`/api/approvals/${d.order.id}`, { approve: true });
  assert.equal(r.action, 'buy');
  const again = await post(`/api/approvals/${d.order.id}`, { approve: true });
  assert.equal(again.action, 'skip');
});

test('supplier price rise that would lose money -> blocked, nothing paid', async () => {
  setSupplierCost('A', 'A-1002', 30);           // bottle now costs more than we sell it for
  const d = await buy('BOT-750');
  assert.equal(d.order.status, 'blocked');
  assert.equal(d.purchase, null);
  assert.match(d.decisions.at(-1).reason, /no offer keeps the 20% margin/);
  resetSupplierCosts();
});

test('duplicate event for the same order never pays twice', async () => {
  const d = await buy('COF-1KG');
  db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(d.order.id);   // simulate a replayed webhook
  const r = await handlePaidOrder(db, d.order.id);
  assert.equal(r.action, 'skip');
  const n = db.prepare('SELECT COUNT(*) n FROM purchases WHERE order_id=?').get(d.order.id).n;
  assert.equal(n, 1);
});
