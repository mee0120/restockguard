import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, now } from './db.js';
import { PRODUCTS, SUPPLIER_IDS, supplierFeed, setSupplierCost, resetSupplierCosts } from './catalog.js';
import * as paypal from './paypal.js';
import { handlePaidOrder, decideApproval, spentToday } from './agent.js';
import { getPolicy, savePolicy } from './policy.js';
import { policyFromText, llmEnabled } from './llm.js';

const db = openDb();
const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(here, '..', 'public')));
app.get('/vendor/ag-grid.js', (req, res) =>
  res.sendFile(path.join(here, '..', 'node_modules', 'ag-grid-community', 'dist', 'ag-grid-community.min.js')));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message });
});

// Owner actions need ADMIN_TOKEN when it is set (header x-admin-token or ?token=).
function admin(req, res, next) {
  const t = process.env.ADMIN_TOKEN;
  if (!t || req.get('x-admin-token') === t || req.query.token === t) return next();
  res.status(401).json({ error: 'owner token required' });
}

const runAgent = (orderId) => setImmediate(() => handlePaidOrder(db, orderId).catch((e) => console.error('agent', e)));

// ---------- store ----------
app.get('/api/config', (req, res) => res.json({ clientId: paypal.clientId(), mock: paypal.isMock(), ai: llmEnabled() }));
app.get('/api/products', (req, res) => res.json(PRODUCTS));

app.post('/api/orders', wrap(async (req, res) => {
  const p = PRODUCTS.find((x) => x.sku === req.body.sku);
  const qty = Math.max(1, Math.min(5, Number(req.body.qty) || 1));
  if (!p) return res.status(400).json({ error: 'unknown product' });
  const o = await paypal.createOrder({ sku: p.sku, name: p.name, qty, unitPrice: p.price });
  db.prepare('INSERT INTO orders(id,sku,qty,sale_total,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(o.id, p.sku, qty, p.price * qty, 'created', now(), now());
  res.json({ id: o.id });
}));

app.post('/api/orders/:id/capture', wrap(async (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'unknown order' });
  if (order.status !== 'created') return res.json({ status: order.status });
  const c = await paypal.captureOrder(order.id);
  if (c.status !== 'COMPLETED') return res.status(402).json({ error: `payment ${c.status}` });
  db.prepare("UPDATE orders SET status='paid', capture_id=?, customer=?, ship_to=?, sale_total=?, updated_at=? WHERE id=?")
    .run(c.captureId, c.payerEmail, c.shipTo, c.amount || order.sale_total, now(), order.id);
  runAgent(order.id);
  res.json({ status: 'paid', orderId: order.id });
}));

// PayPal webhook: PAYMENT.CAPTURE.COMPLETED also starts the agent (idempotent).
app.post('/webhooks/paypal', wrap(async (req, res) => {
  const ev = req.body;
  if (!(await paypal.verifyWebhook(req.headers, ev))) return res.status(400).json({ error: 'bad signature' });
  const seen = db.prepare('INSERT OR IGNORE INTO events(id,type,received_at) VALUES(?,?,?)').run(ev.id, ev.event_type, now());
  if (seen.changes && ev.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const orderId = ev.resource?.supplementary_data?.related_ids?.order_id;
    const o = orderId && db.prepare('SELECT status FROM orders WHERE id=?').get(orderId);
    if (o && o.status === 'paid') runAgent(orderId);
  }
  // Payout batch finished (or was denied): refresh the supplier payment status.
  if (seen.changes && ev.event_type?.startsWith('PAYMENT.PAYOUTSBATCH.')) {
    const batch = ev.resource?.batch_header;
    if (batch?.payout_batch_id) {
      db.prepare('UPDATE purchases SET payout_status=? WHERE payout_batch_id=?')
        .run(String(batch.batch_status || ev.event_type.split('.').pop()).toLowerCase(), batch.payout_batch_id);
    }
  }
  res.json({ ok: true });
}));

// Poll PayPal for supplier payouts still pending (also covers missed webhooks).
async function refreshPayouts() {
  const rows = db.prepare("SELECT order_id, payout_batch_id FROM purchases WHERE payout_status IN ('pending','processing','paying') AND payout_batch_id IS NOT NULL").all();
  for (const r of rows) {
    try {
      const p = await paypal.getPayout(r.payout_batch_id);
      const s = String(p.batch_header?.batch_status || '').toLowerCase();
      if (s) db.prepare('UPDATE purchases SET payout_status=? WHERE order_id=?').run(s, r.order_id);
    } catch (e) {
      console.error('payout refresh', r.payout_batch_id, e.message);
    }
  }
}
setInterval(() => refreshPayouts().catch(() => {}), 30_000).unref();

// ---------- supplier "APIs" (demo feeds) ----------
app.get('/suppliers/:id/feed', (req, res) => {
  const f = supplierFeed(req.params.id);
  return f ? res.json(f) : res.status(404).end();
});

// ---------- dashboard ----------
app.get('/api/dashboard', (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, p.supplier, p.amount AS cost, p.payout_batch_id, p.payout_status, p.tracking,
      (SELECT action FROM decisions d WHERE d.order_id=o.id ORDER BY at DESC LIMIT 1) AS last_action,
      (SELECT explanation FROM decisions d WHERE d.order_id=o.id AND explanation!='' ORDER BY at DESC LIMIT 1) AS explanation
    FROM orders o LEFT JOIN purchases p ON p.order_id=o.id
    WHERE o.status!='created' ORDER BY o.created_at DESC LIMIT 200`).all();
  const approvals = db.prepare("SELECT a.*, o.sku, o.sale_total FROM approvals a JOIN orders o ON o.id=a.order_id WHERE a.status='pending' ORDER BY a.created_at").all();
  const bought = orders.filter((o) => o.status === 'purchased');
  const sales = bought.reduce((s, o) => s + o.sale_total, 0);
  const cost = bought.reduce((s, o) => s + (o.cost || 0), 0);
  res.json({
    summary: {
      orders: orders.length, purchased: bought.length,
      held: orders.filter((o) => o.status === 'held').length,
      blocked: orders.filter((o) => o.status === 'blocked').length,
      sales, cost, profit: sales - cost, spent_today: spentToday(db),
    },
    orders, approvals, policy: getPolicy(db),
    products: PRODUCTS,
  });
});

app.get('/api/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).end();
  res.json({
    order,
    quotes: db.prepare('SELECT * FROM quotes WHERE order_id=? ORDER BY rank IS NULL, rank, landed').all(order.id),
    decisions: db.prepare('SELECT * FROM decisions WHERE order_id=? ORDER BY at').all(order.id)
      .map((d) => ({ ...d, checks: JSON.parse(d.checks || '[]') })),
    purchase: db.prepare('SELECT * FROM purchases WHERE order_id=?').get(order.id) || null,
  });
});

app.get('/api/suppliers', (req, res) => res.json(SUPPLIER_IDS.map(supplierFeed)));

app.post('/api/approvals/:id', admin, wrap(async (req, res) => {
  res.json(await decideApproval(db, req.params.id, Boolean(req.body.approve)));
}));

app.get('/api/policy', (req, res) => res.json(getPolicy(db)));
app.post('/api/policy', admin, (req, res) => res.json(savePolicy(db, req.body)));
app.post('/api/policy/text', admin, wrap(async (req, res) => {
  const proposed = await policyFromText(String(req.body.text || '').slice(0, 500), getPolicy(db));
  res.json({ proposed, saved: req.body.apply ? savePolicy(db, proposed) : null });
}));

// Demo knobs: move a supplier price, or reset.
app.post('/api/demo/price', admin, (req, res) => {
  setSupplierCost(req.body.supplier, req.body.item, Number(req.body.cost));
  res.json({ ok: true });
});
app.post('/api/demo/reset', admin, (req, res) => {
  resetSupplierCosts();
  res.json({ ok: true });
});

export { app, db };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`RestockGuard on :${port} (PayPal ${paypal.isMock() ? 'mock' : 'sandbox'}, AI ${llmEnabled() ? 'on' : 'off'})`));
}
