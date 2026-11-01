// The restock agent: runs when a customer's payment is captured.
//
//   paid order -> supplier feeds -> AI product matching -> landed cost per offer
//   -> cheapest offer that keeps the margin -> policy checks
//   -> pay the supplier (PayPal Payouts) or wait for the owner
//   -> tracking number back on the customer's PayPal order
import crypto from 'node:crypto';
import { now } from './db.js';
import { PRODUCTS, SUPPLIER_IDS, supplierFeed, supplierPayee } from './catalog.js';
import { matchItems } from './llm.js';
import { getPolicy, excludeReason, evaluate, marginPct } from './policy.js';
import { paySupplier, addTracking } from './paypal.js';
import { notifyOwner } from './notify.js';

const appUrl = () => process.env.APP_URL || 'http://localhost:3000';

function logDecision(db, orderId, action, reason, explanation = '', checks = []) {
  db.prepare('INSERT INTO decisions(order_id,at,action,reason,explanation,checks) VALUES(?,?,?,?,?,?)')
    .run(orderId, now(), action, reason, explanation, JSON.stringify(checks));
}

function setStatus(db, orderId, status) {
  db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run(status, now(), orderId);
}

export function spentToday(db) {
  const day = new Date().toISOString().slice(0, 10);
  const r = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM purchases WHERE substr(created_at,1,10)=? AND payout_status!='failed'").get(day);
  return Number(r.s);
}

/** Collect, match and rank supplier offers for one order. */
export async function quote(db, order) {
  const product = PRODUCTS.find((p) => p.sku === order.sku);
  if (!product) throw new Error(`unknown sku ${order.sku}`);
  const feeds = SUPPLIER_IDS.map(supplierFeed);
  const items = feeds.flatMap((f) => f.items.map((it) => ({ ...it, supplier: f.id, feed: f })));
  const matches = await matchItems(product, items);
  const policy = getPolicy(db);

  const offers = items.map((it) => {
    const m = matches.get(`${it.supplier}:${it.id}`) || { same: false, confidence: 0, why: '' };
    const same = m.same && m.confidence >= 0.6;
    const landed = it.cost * order.qty + it.shipping;
    const o = {
      supplier: it.supplier, supplier_name: it.feed.name, supplier_since: it.feed.since,
      item_id: it.id, item_name: it.title, same, match: `${m.by}: ${m.why}${m.same && !same ? ' (low confidence)' : ''}`,
      unit_cost: it.cost, base_cost: it.base_cost, shipping: it.shipping, landed_total: Math.round(landed * 100) / 100,
      eta_days: it.eta, in_stock: it.stock >= order.qty,
    };
    o.excluded = excludeReason(o, policy);
    o.margin = marginPct(order.sale_total, o.landed_total);
    return o;
  });
  const usable = offers.filter((o) => !o.excluded).sort((a, b) => a.landed_total - b.landed_total || a.eta_days - b.eta_days);
  usable.forEach((o, i) => { o.rank = i + 1; });

  db.prepare('DELETE FROM quotes WHERE order_id=?').run(order.id);
  const ins = db.prepare('INSERT INTO quotes(order_id,supplier,item_name,match,unit_cost,shipping,landed,eta_days,in_stock,rank,rejected_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  for (const o of offers) {
    if (!o.same && o.excluded === 'not the same product' && !o.match.startsWith('ai') && !o.match.startsWith('heuristic')) continue; // GTIN mismatch: not worth showing
    ins.run(order.id, o.supplier, o.item_name, o.match, o.unit_cost, o.shipping, o.landed_total, o.eta_days, o.in_stock ? 1 : 0, o.rank ?? null, o.excluded);
  }
  return { product, offers, usable, policy };
}

/** Entry point after a capture. Safe to call more than once for the same order. */
export async function handlePaidOrder(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) return { action: 'skip', reason: 'unknown order' };
  if (db.prepare('SELECT 1 FROM purchases WHERE order_id=?').get(orderId)) {
    logDecision(db, orderId, 'skip', 'already purchased for this order (duplicate event)');
    return { action: 'skip', reason: 'already purchased' };
  }
  if (['held', 'blocked', 'purchased', 'rejected'].includes(order.status)) return { action: 'skip', reason: `order is ${order.status}` };

  setStatus(db, orderId, 'sourcing');
  const { product, usable, policy } = await quote(db, order);
  const keeping = usable.filter((o) => o.margin >= policy.min_margin_pct);

  if (!keeping.length) {
    const best = usable[0];
    const reason = best
      ? `no offer keeps the ${policy.min_margin_pct}% margin (best: ${best.supplier_name} $${best.landed_total.toFixed(2)} vs sale $${order.sale_total.toFixed(2)}, margin ${best.margin.toFixed(1)}%)`
      : 'no supplier has this product in stock';
    const text = `Not bought: ${reason}.`;
    logDecision(db, orderId, 'block', reason, text);
    setStatus(db, orderId, 'blocked');
    await notifyOwner(`⛔ RestockGuard blocked a purchase\n${product.name} (order ${orderId})\n${reason}\n${appUrl()}/dashboard.html`);
    return { action: 'block', reason };
  }

  // Cheapest offer that passes every check; if none passes, hold the cheapest one for the owner.
  const spent = spentToday(db);
  const evals = keeping.map((o) => ({ o, r: evaluate({ saleTotal: order.sale_total, offer: o, spentToday: spent, policy }) }));
  const clean = evals.find((e) => !e.r.hold.length);
  const { o: pick, r: res } = clean || evals[0];
  const skipped = [
    ...usable.filter((o) => o.margin < policy.min_margin_pct && o.landed_total < pick.landed_total)
      .map((o) => `${o.supplier_name} (margin ${o.margin.toFixed(1)}%)`),
    ...evals.filter((e) => e.o !== pick && e.o.landed_total < pick.landed_total && e.r.hold.length)
      .map((e) => e.r.hold.join('; ')),
  ];
  const summary = `Chose ${pick.supplier_name}: $${pick.landed_total.toFixed(2)} landed, arrives in ${pick.eta_days} days, margin ${res.margin.toFixed(1)}%.`
    + (skipped.length ? ` Skipped cheaper: ${skipped.join(', ')}.` : '');
  // The decision text is built in code from the checks, not written by the model:
  // a reworded reason can be wrong even when every number in it is right.
  const explanation = summary;

  if (res.hold.length) {
    db.prepare('INSERT OR REPLACE INTO approvals(order_id,supplier,amount,reasons,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(orderId, pick.supplier, pick.landed_total, JSON.stringify(res.hold), 'pending', now());
    logDecision(db, orderId, 'hold', res.hold.join('; '), explanation, res.checks);
    setStatus(db, orderId, 'held');
    await notifyOwner(`✋ Approval needed\n${product.name} from ${pick.supplier_name}: $${pick.landed_total.toFixed(2)}\nWhy: ${res.hold.join('; ')}\nApprove or reject: ${appUrl()}/dashboard.html#approvals`);
    return { action: 'hold', reasons: res.hold, offer: pick };
  }

  logDecision(db, orderId, 'buy', summary, explanation, res.checks);
  return purchase(db, order, pick);
}

/** Pay the supplier once per order, then put the tracking number on the customer's order. */
export async function purchase(db, order, offer) {
  // Our own idempotency lock: the row exists before money moves.
  const lock = db.prepare("INSERT OR IGNORE INTO purchases(order_id,supplier,amount,payout_status,created_at) VALUES(?,?,?,'paying',?)")
    .run(order.id, offer.supplier, offer.landed_total, now());
  if (lock.changes === 0) return { action: 'skip', reason: 'already purchased' };

  try {
    const res = await paySupplier({
      orderId: order.id, receiver: supplierPayee(offer.supplier), amount: offer.landed_total,
      note: `PO for order ${order.id}: ${order.qty} x ${offer.item_name} (${offer.item_id}). Ship to: ${order.ship_to}`,
    });
    const batch = res.batch_header;
    db.prepare('UPDATE purchases SET payout_batch_id=?, payout_status=? WHERE order_id=?')
      .run(batch.payout_batch_id, (batch.batch_status || 'PENDING').toLowerCase(), order.id);
  } catch (e) {
    db.prepare("UPDATE purchases SET payout_status='failed' WHERE order_id=?").run(order.id);
    logDecision(db, order.id, 'error', `supplier payment failed: ${e.message}`);
    setStatus(db, order.id, 'failed');
    await notifyOwner(`⚠️ Supplier payment failed for order ${order.id}: ${e.message}`);
    return { action: 'error', reason: e.message };
  }

  // Demo: the supplier answers with a tracking number right away.
  const tracking = `${offer.supplier}${crypto.randomInt(10_000_000, 99_999_999)}`;
  try {
    await addTracking({ orderId: order.id, captureId: order.capture_id, trackingNumber: tracking, carrier: offer.supplier_name });
    db.prepare('UPDATE purchases SET tracking=? WHERE order_id=?').run(tracking, order.id);
  } catch (e) {
    logDecision(db, order.id, 'warn', `tracking not added: ${e.message}`);
  }
  setStatus(db, order.id, 'purchased');
  await notifyOwner(`✅ Bought for order ${order.id}: ${offer.item_name} from ${offer.supplier_name}, $${offer.landed_total.toFixed(2)} (tracking ${tracking})`);
  return { action: 'buy', offer, tracking };
}

export async function decideApproval(db, orderId, approve) {
  const ap = db.prepare("SELECT * FROM approvals WHERE order_id=? AND status='pending'").get(orderId);
  if (!ap) return { action: 'skip', reason: 'nothing pending' };
  db.prepare('UPDATE approvals SET status=?, decided_at=? WHERE order_id=?').run(approve ? 'approved' : 'rejected', now(), orderId);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!approve) {
    logDecision(db, orderId, 'rejected', 'owner rejected the purchase');
    setStatus(db, orderId, 'rejected');
    return { action: 'rejected' };
  }
  // Re-quote: prices may have moved while waiting. The margin rule still applies.
  const { usable, policy } = await quote(db, order);
  const offer = usable.find((o) => o.supplier === ap.supplier && o.margin >= policy.min_margin_pct);
  if (!offer) {
    logDecision(db, orderId, 'block', 'approved, but the offer no longer keeps the margin');
    setStatus(db, orderId, 'blocked');
    return { action: 'block', reason: 'offer changed' };
  }
  logDecision(db, orderId, 'buy', `owner approved ${offer.supplier_name} $${offer.landed_total.toFixed(2)}`);
  return purchase(db, order, offer);
}
