// Purchasing policy: plain code, no AI. The agent may only spend money when every check passes.
import { getSetting, setSetting } from './db.js';

export const DEFAULT_POLICY = {
  min_margin_pct: 20,        // never buy if the sale would keep less than this margin
  max_order_usd: 60,         // larger purchases wait for the owner
  daily_budget_usd: 300,     // total supplier spend per UTC day before the owner must approve
  max_price_jump_pct: 15,    // supplier cost above its usual price by more than this -> owner
  new_supplier_days: 30,     // suppliers younger than this -> owner
  max_eta_days: 7,           // slower offers are not considered
  blocked_suppliers: [],
};

export function getPolicy(db) {
  return { ...DEFAULT_POLICY, ...(getSetting(db, 'policy') || {}) };
}

export function savePolicy(db, p) {
  const clean = { ...DEFAULT_POLICY };
  for (const k of Object.keys(DEFAULT_POLICY)) {
    if (k === 'blocked_suppliers') clean[k] = Array.isArray(p[k]) ? p[k].filter((s) => /^[A-Z]$/.test(s)) : [];
    else if (Number.isFinite(Number(p[k])) && Number(p[k]) >= 0) clean[k] = Number(p[k]);
  }
  setSetting(db, 'policy', clean);
  return clean;
}

export const marginPct = (sale, cost) => (sale > 0 ? ((sale - cost) / sale) * 100 : -Infinity);

/** Is this offer allowed at all? Returns null or the reason it is excluded. */
export function excludeReason(q, policy) {
  if (!q.same) return 'not the same product';
  if (!q.in_stock) return 'out of stock';
  if (policy.blocked_suppliers.includes(q.supplier)) return 'supplier blocked by owner';
  if (q.eta_days > policy.max_eta_days) return `arrives in ${q.eta_days} days (limit ${policy.max_eta_days})`;
  return null;
}

/**
 * Checks for the chosen offer. Returns {block: [...], hold: [...], checks: [...]}.
 * block -> never buy automatically or manually from this offer (loss/below margin).
 * hold  -> buy only after the owner approves.
 */
export function evaluate({ saleTotal, offer, spentToday, policy, today = new Date() }) {
  const checks = [];
  const block = [];
  const hold = [];
  const m = marginPct(saleTotal, offer.landed_total);
  const ok = (name, pass, detail) => checks.push({ name, pass, detail });

  ok('margin', m >= policy.min_margin_pct, `${m.toFixed(1)}% (min ${policy.min_margin_pct}%)`);
  if (m < policy.min_margin_pct) block.push(m < 0 ? `would lose $${(offer.landed_total - saleTotal).toFixed(2)}` : `margin ${m.toFixed(1)}% is below ${policy.min_margin_pct}%`);

  ok('order limit', offer.landed_total <= policy.max_order_usd, `$${offer.landed_total.toFixed(2)} (limit $${policy.max_order_usd})`);
  if (offer.landed_total > policy.max_order_usd) hold.push(`$${offer.landed_total.toFixed(2)} is above the $${policy.max_order_usd} per-order limit`);

  const after = spentToday + offer.landed_total;
  ok('daily budget', after <= policy.daily_budget_usd, `$${after.toFixed(2)} of $${policy.daily_budget_usd}`);
  if (after > policy.daily_budget_usd) hold.push(`today's supplier spend would reach $${after.toFixed(2)} (budget $${policy.daily_budget_usd})`);

  const jump = offer.base_cost > 0 ? ((offer.unit_cost - offer.base_cost) / offer.base_cost) * 100 : 0;
  ok('price jump', jump <= policy.max_price_jump_pct, `${jump.toFixed(0)}% vs usual (limit ${policy.max_price_jump_pct}%)`);
  if (jump > policy.max_price_jump_pct) hold.push(`${offer.supplier_name} raised the price ${jump.toFixed(0)}% above usual`);

  const ageDays = Math.floor((today - new Date(offer.supplier_since)) / 86_400_000);
  ok('supplier history', ageDays >= policy.new_supplier_days, `${ageDays} days (min ${policy.new_supplier_days})`);
  if (ageDays < policy.new_supplier_days) hold.push(`${offer.supplier_name} is new (${ageDays} days)`);

  return { block, hold, checks, margin: m };
}
