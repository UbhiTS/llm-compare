// ---------------------------------------------------------------------------
// spendLedger.js - month-to-date spend on the GLOBAL keys, as tracked by this app.
//
// Every model call that ran on a shared key adds its cost (the same per-call cost
// the UI shows: token usage x catalog price, or the per-image PayGo cost) to the
// current UTC month for that provider (openai / anthropic / moonshot / vertex).
// Calls on a user's own key are never recorded: they never touch the global keys.
//
// Persisted to spend-ledger.json next to settings.json when AUTH_DATA_DIR is set
// (Cloud Run: the GCS bucket, so it survives deploys); keeps the last 13 months.
// It only sees this app's traffic; provider-side numbers (other apps on the same
// key, discounts, taxes) come from src/providerBilling.js where an API exists.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const appSettings = require('./appSettings');
const { modelUsesOwnKey } = require('./byok');

const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(__dirname, '..', '.auth');
const LEDGER_FILE = path.join(DATA_DIR, 'spend-ledger.json');
const PERSIST = !!process.env.AUTH_DATA_DIR;
const KEEP_MONTHS = 13;

function monthKey(d = new Date()) { return d.toISOString().slice(0, 7); }
function emptyMonth() {
  const o = {};
  for (const p of appSettings.PROVIDERS) o[p] = { usd: 0, calls: 0 };
  return o;
}

function load() {
  if (!PERSIST) return { since: null, months: {} };
  try {
    const obj = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    const months = {};
    for (const [m, v] of Object.entries((obj && obj.months) || {})) {
      if (!/^\d{4}-\d{2}$/.test(m) || !v || typeof v !== 'object') continue;
      const row = emptyMonth();
      for (const p of appSettings.PROVIDERS) {
        const usd = Number(v[p] && v[p].usd);
        const calls = Number(v[p] && v[p].calls);
        row[p] = {
          usd: Number.isFinite(usd) && usd > 0 ? usd : 0,
          calls: Number.isFinite(calls) && calls > 0 ? Math.floor(calls) : 0,
        };
      }
      months[m] = row;
    }
    return { since: (obj && typeof obj.since === 'string') ? obj.since : null, months };
  } catch (_) {
    return { since: null, months: {} };
  }
}
let ledger = load();

function save() {
  if (!PERSIST) return;
  const keys = Object.keys(ledger.months).sort();
  while (keys.length > KEEP_MONTHS) delete ledger.months[keys.shift()];
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger));
  } catch (e) {
    console.warn('[spend] could not persist the spend ledger:', e && e.message);
  }
}

// Add one model call's cost to its provider's month, if it ran on a global key.
// `model` needs provider (+ publisher / endpointType for Vertex); `keys` are the
// caller's own keys for that request. Returns true when something was recorded.
function recordModelCost(model, keys, usd) {
  const n = Number(usd);
  if (!model || !Number.isFinite(n) || n <= 0) return false;
  if (modelUsesOwnKey(model, keys || {})) return false; // own key: never touches the global keys
  const p = appSettings.budgetBucket(model);
  const m = monthKey();
  if (!ledger.months[m]) ledger.months[m] = emptyMonth();
  ledger.months[m][p].usd += n;
  ledger.months[m][p].calls += 1;
  if (!ledger.since) ledger.since = new Date().toISOString();
  save();
  return true;
}

// App-tracked spend for one month (default: the current UTC month).
function monthToDate(month = monthKey()) {
  const row = ledger.months[month] || emptyMonth();
  const providers = {};
  for (const p of appSettings.PROVIDERS) providers[p] = { usd: Math.round(row[p].usd * 1e6) / 1e6, calls: row[p].calls };
  return { month, since: ledger.since, providers };
}

module.exports = { recordModelCost, monthToDate, monthKey, LEDGER_FILE };
