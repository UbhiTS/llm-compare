// ---------------------------------------------------------------------------
// providerBilling.js - provider-reported spend / balance for the global keys,
// where the provider has an API for it (checked 2026-10-15):
//   OpenAI    - no balance API. Month-to-date ORG spend via the Costs API
//               (GET /v1/organization/costs), which needs an Admin key
//               (sk-admin-..., stored as OPENAI_ADMIN_KEY; create it Read-only).
//   Anthropic - no balance API. Month-to-date ORG spend via the Admin API cost
//               report (GET /v1/organizations/cost_report, sk-ant-admin..., stored
//               as ANTHROPIC_ADMIN_KEY). Amounts are decimal strings in CENTS.
//   Moonshot  - real remaining balance on the normal key (GET /v1/users/me/balance).
//   Vertex AI - nothing: Google Cloud has no remaining-credit API (exact spend only
//               via the Billing export to BigQuery or budget Pub/Sub alerts).
// Results are cached for 10 minutes; a forced refresh is honoured at most once a
// minute per provider (Anthropic asks for <= 1 poll/minute). Never throws.
// ---------------------------------------------------------------------------
const globalKeys = require('./globalKeys');
const { scrubError } = require('./secrets');

const CACHE_MS = 10 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;
const PEEK_MAX_AGE_MS = 60 * 60 * 1000; // peek(): cached views the budget check may still use
const TIMEOUT_MS = 15000;
const MAX_PAGES = 6;
const KIND = Object.freeze({ openai: 'spend', anthropic: 'spend', moonshot: 'balance', vertex: 'none' });
const cache = new Map(); // provider -> { at, value }

function monthStartUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (_) { /* not JSON */ }
  if (!r.ok) {
    const msg = (j && j.error && (j.error.message || j.error.type)) || (j && j.message) || `HTTP ${r.status}`;
    const err = new Error(`${r.status}: ${String(msg).slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return j || {};
}

// OpenAI org spend since the 1st of this month (USD), summed over daily buckets.
async function openaiMonthToDate(adminKey, now = new Date()) {
  const start = Math.floor(monthStartUtc(now).getTime() / 1000);
  let total = 0;
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = new URLSearchParams({ start_time: String(start), bucket_width: '1d', limit: '31' });
    if (page) qs.set('page', page);
    const j = await getJson(`https://api.openai.com/v1/organization/costs?${qs}`, { Authorization: `Bearer ${adminKey}` });
    for (const b of j.data || []) {
      for (const res of b.results || []) {
        const v = Number(res && res.amount && res.amount.value);
        if (Number.isFinite(v)) total += v;
      }
    }
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  return total;
}

// Anthropic org spend since the 1st of this month (USD). The API reports cents
// as decimal strings ("123.45" = $1.2345).
async function anthropicMonthToDate(adminKey, now = new Date()) {
  let cents = 0;
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = new URLSearchParams({ starting_at: monthStartUtc(now).toISOString(), limit: '31' });
    if (page) qs.set('page', page);
    const j = await getJson(`https://api.anthropic.com/v1/organizations/cost_report?${qs}`, {
      'x-api-key': adminKey,
      'anthropic-version': '2023-06-01',
    });
    for (const b of j.data || []) {
      for (const res of b.results || []) {
        const v = Number(res && res.amount);
        if (Number.isFinite(v)) cents += v;
      }
    }
    if (!j.has_more || !j.next_page) break;
    page = j.next_page;
  }
  return cents / 100;
}

// Moonshot remaining balance (USD on api.moonshot.ai): available = cash + voucher.
async function moonshotBalance(key) {
  const j = await getJson('https://api.moonshot.ai/v1/users/me/balance', { Authorization: `Bearer ${key}` });
  const d = (j && j.data) || {};
  const available = Number(d.available_balance);
  if (!Number.isFinite(available)) throw new Error('Moonshot returned no balance.');
  return { available, voucher: Number(d.voucher_balance) || 0, cash: Number(d.cash_balance) || 0 };
}

async function fetchProvider(provider, now) {
  if (provider === 'openai') {
    const key = globalKeys.get('OPENAI_ADMIN_KEY');
    if (!key) return { ok: false, needsKey: 'OPENAI_ADMIN_KEY', note: 'Add a read-only OpenAI admin key in Global API keys to see org spend.' };
    return { ok: true, usd: await openaiMonthToDate(key, now), source: 'OpenAI Costs API (whole org, month to date)' };
  }
  if (provider === 'anthropic') {
    const key = globalKeys.get('ANTHROPIC_ADMIN_KEY');
    if (!key) return { ok: false, needsKey: 'ANTHROPIC_ADMIN_KEY', note: 'Add an Anthropic admin key in Global API keys to see org spend.' };
    return { ok: true, usd: await anthropicMonthToDate(key, now), source: 'Anthropic cost report (whole org, month to date)' };
  }
  if (provider === 'moonshot') {
    const key = globalKeys.get('MOONSHOT_API_KEY');
    if (!key) return { ok: false, note: 'No global Moonshot key is set.' };
    const b = await moonshotBalance(key);
    return { ok: true, usd: b.available, voucherUsd: b.voucher, cashUsd: b.cash, source: 'Moonshot balance API (live)' };
  }
  return { ok: false, note: 'No Google Cloud API for remaining credit, so Remaining uses app spend. For exact spend, use the Cloud Billing export to BigQuery.' };
}

// The provider-side view for one provider: { kind, ok, usd?, source?, note?, error?, asOf, cached }.
async function providerView(provider, { force = false, now = new Date() } = {}) {
  const kind = KIND[provider] || 'none';
  const c = cache.get(provider);
  const age = c ? Date.now() - c.at : Infinity;
  if (c && age < CACHE_MS && !(force && age >= MIN_REFRESH_MS)) {
    return { kind, ...c.value, asOf: new Date(c.at).toISOString(), cached: true };
  }
  let value;
  try {
    value = await fetchProvider(provider, now);
  } catch (e) {
    value = { ok: false, error: scrubError(String((e && e.message) || e)) };
  }
  cache.set(provider, { at: Date.now(), value });
  return { kind, ...value, asOf: new Date().toISOString(), cached: false };
}

// Drop cached views (e.g. right after an admin key is saved in Global API keys).
function invalidate(provider) {
  if (provider) cache.delete(provider); else cache.clear();
}

// Sync, no network: the cached provider view while it is under an hour old, else null.
// The monthly budget check (server.js) runs on the request path, so it never waits on a
// provider API; the cache is filled whenever an admin opens Settings > Spend.
function peek(provider) {
  const c = cache.get(provider);
  if (!c || Date.now() - c.at >= PEEK_MAX_AGE_MS) return null;
  return { kind: KIND[provider] || 'none', ...c.value, asOf: new Date(c.at).toISOString(), cached: true };
}

// The provider's own month-to-date spend from a view, or null (no spend API, no admin
// key, an error, or a Moonshot balance, which is never treated as spend).
function providerSpendUsd(view) {
  return view && view.kind === 'spend' && view.ok ? (Number(view.usd) || 0) : null;
}

// Month-to-date spend counted against a monthly budget: the larger of the app-tracked
// spend and the provider-reported month-to-date spend (when its spend API answered).
// Shared by Settings (summarize) and the budget check, so the two always agree.
function spentFor(view, appUsd) {
  const app = Number(appUsd) || 0;
  const prov = providerSpendUsd(view);
  return prov != null && prov > app ? prov : app;
}

// One Settings row: app-tracked spend + provider view + budget -> remaining.
// "Remaining" uses spentFor(): the larger of the provider's own month-to-date spend (where
// it has a spend API; it also counts other apps on the same org) and the app-tracked spend.
// basis = 'provider' when the provider number is the larger one, else 'app'.
function summarize({ id, label, app, view, budgetUsd, globalKey }) {
  const appSpend = app || { usd: 0, calls: 0 };
  const spentUsd = spentFor(view, appSpend.usd);
  const prov = providerSpendUsd(view);
  const basis = prov != null && prov > (Number(appSpend.usd) || 0) ? 'provider' : 'app';
  const budget = (budgetUsd == null || budgetUsd === '') ? null : Number(budgetUsd);
  // A $0 budget is used up by any spend at all (no divide by zero).
  let usedPct = null;
  if (budget != null) usedPct = budget > 0 ? Math.round((spentUsd / budget) * 1000) / 10 : (spentUsd > 0 ? 100 : 0);
  return {
    id,
    label,
    globalKey: !!globalKey,
    app: appSpend,
    provider: view || null,
    budgetUsd: budget,
    spentUsd,
    basis,
    remainingUsd: budget == null ? null : Math.round((budget - spentUsd) * 100) / 100,
    usedPct,
    // Enforced: runs on this provider's global key are blocked (admins exempt) once spend
    // reaches the budget; a $0 budget blocks the key outright. Same test as server.js.
    budgetUsedUp: budget != null && spentUsd >= budget,
  };
}

module.exports = { providerView, invalidate, peek, spentFor, summarize, openaiMonthToDate, anthropicMonthToDate, moonshotBalance, KIND };
