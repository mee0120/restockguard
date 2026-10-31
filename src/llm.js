// AI helpers. Any OpenAI-compatible endpoint works (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL).
// Without a key the helpers fall back to simple heuristics, so the app and tests still run.
//
// The AI never decides on money by itself: it matches products, explains decisions
// and turns plain-language rules into a policy. Prices, margins and limits are
// computed and enforced in code (see agent.js / policy.js).

const BASE = process.env.LLM_BASE_URL || 'https://otari.ai/api/v1';
const KEY = () => process.env.LLM_API_KEY || '';
const MODEL = () => process.env.LLM_MODEL || 'deepinfra:Qwen/Qwen3-235B-A22B-Instruct-2507';
export const llmEnabled = () => Boolean(KEY());

async function chat(messages, { maxTokens = 800, json = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (BASE.includes('otari.ai')) headers['Otari-Key'] = KEY();
  else headers.Authorization = `Bearer ${KEY()}`;
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: MODEL(), messages, max_tokens: maxTokens, temperature: 0 }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content || '';
  return json ? extractJson(text) : text.trim();
}

export function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('no JSON in model answer');
  return JSON.parse(text.slice(s, e + 1));
}

// ---------- product matching ----------
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
const sizes = (t) => (norm(t).replace(/(\d+)\s+(kg|g|ml|l)\b/g, '$1$2').match(/\d+(kg|g|ml|l)\b/g) || []).sort().join(',');

function heuristicMatch(product, item) {
  const a = new Set(norm(product.name).split(/\s+/).filter((w) => w.length > 2));
  const b = new Set(norm(item.title).split(/\s+/).filter((w) => w.length > 2));
  const common = [...a].filter((w) => b.has(w)).length;
  const score = common / Math.max(1, Math.min(a.size, b.size));
  const sameSize = sizes(product.name) === sizes(item.title);
  const same = score >= 0.5 && sameSize;
  return { same, confidence: same ? Math.min(0.9, 0.5 + score / 2) : 0.2, why: sameSize ? `${common} words in common` : 'size differs' };
}

/**
 * Decide which supplier items are the same product as `product`.
 * GTIN decides when both sides have one; otherwise the model (or the heuristic) judges.
 * Returns Map(itemKey -> {same, confidence, why, by}).
 */
export async function matchItems(product, items) {
  const out = new Map();
  const unknown = [];
  for (const it of items) {
    const key = `${it.supplier}:${it.id}`;
    if (it.gtin && product.gtin) {
      const same = it.gtin === product.gtin;
      out.set(key, { same, confidence: 1, why: same ? 'GTIN matches' : 'different GTIN', by: 'gtin' });
    } else unknown.push(it);
  }
  if (!unknown.length) return out;
  if (!llmEnabled()) {
    for (const it of unknown) out.set(`${it.supplier}:${it.id}`, { ...heuristicMatch(product, it), by: 'heuristic' });
    return out;
  }
  const list = unknown.map((it, i) => `${i + 1}. [${it.supplier}:${it.id}] ${it.title}`).join('\n');
  try {
    const ans = await chat([
      { role: 'system', content: 'You match wholesale listings to a store product. Same product means same item, same size/variant and same quantity. Different size, pack count or model = not the same. Answer only JSON.' },
      { role: 'user', content: `Store product: ${product.name}\n\nSupplier listings:\n${list}\n\nReturn {"matches":[{"key":"<supplier:id>","same":true|false,"confidence":0..1,"why":"<max 12 words>"}]}` },
    ]);
    for (const m of ans.matches || []) out.set(m.key, { same: Boolean(m.same), confidence: Number(m.confidence) || 0, why: m.why || '', by: 'ai' });
  } catch (e) {
    for (const it of unknown) out.set(`${it.supplier}:${it.id}`, { ...heuristicMatch(product, it), by: 'heuristic', why: `AI unavailable (${e.message.slice(0, 40)})` });
  }
  for (const it of unknown) {
    const key = `${it.supplier}:${it.id}`;
    if (!out.has(key)) out.set(key, { same: false, confidence: 0, why: 'not judged', by: 'ai' });
  }
  return out;
}

// ---------- explanation ----------
export async function explain(ctx) {
  const fallback = ctx.summary;
  if (!llmEnabled()) return fallback;
  try {
    return await chat([
      { role: 'system', content: 'Explain a purchasing decision to a small shop owner in 1-2 short sentences. Use only the facts given. No markdown.' },
      { role: 'user', content: JSON.stringify(ctx) },
    ], { maxTokens: 200, json: false });
  } catch {
    return fallback;
  }
}

// ---------- plain-language rules -> policy ----------
export async function policyFromText(text, current) {
  if (!llmEnabled()) throw new Error('Set LLM_API_KEY to edit rules in plain language');
  const ans = await chat([
    { role: 'system', content: 'Convert the owner\'s instruction into an updated purchasing policy. Keep fields the owner did not mention. Answer only JSON with exactly these keys: min_margin_pct (number), max_order_usd (number), daily_budget_usd (number), max_price_jump_pct (number), new_supplier_days (number), max_eta_days (number), blocked_suppliers (array of supplier ids A/B/C).' },
    { role: 'user', content: `Current policy: ${JSON.stringify(current)}\nInstruction: ${text}` },
  ], { maxTokens: 300 });
  return ans;
}
