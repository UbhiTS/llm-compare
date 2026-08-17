// ---------------------------------------------------------------------------
// history.js — durable, per-user run history (server-authoritative).
//
// Every completed comparison is logged here by the server (the browser never
// writes history, so it can't be forged). One JSON file per run, grouped by a
// HASH of the owner's username, so:
//   • usernames (emails) never touch the filesystem path (no traversal / no
//     odd-character issues), and
//   • a non-admin lookup only ever reads inside the caller's own directory —
//     a user structurally cannot fetch another user's run, even by guessing an id.
//
// Storage is plain files under APP_DATA_DIR (a GCS bucket mounted as a Cloud Run
// volume in production, so it survives restarts; a local ./.data dir otherwise).
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const BASE_DIR = process.env.APP_DATA_DIR
  ? path.join(process.env.APP_DATA_DIR, 'history')
  : path.join(__dirname, '..', '.data', 'history');

const MAX_LIST_PER_USER = 200;   // most-recent N returned to a user
const MAX_LIST_ALL = 1000;       // most-recent N returned to an admin (all users)

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
// Path-safe, collision-resistant directory name for an owner (never the raw email).
function userKey(username) {
  return crypto.createHash('sha256').update(norm(username)).digest('hex').slice(0, 40);
}
// Run ids we generate are [a-z0-9-]; reject anything else before using in a path.
function safeId(id) { return /^[a-z0-9-]{1,80}$/.test(String(id || '')) ? String(id) : null; }
function newId() { return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`; }

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return null; } }

// Derive the compact per-slot summary shown in lists / usage (no code/reasoning).
function summarize(models, results) {
  const byslot = {};
  (results || []).forEach((r) => { if (r && r.slot != null) byslot[r.slot] = r; });
  return (models || []).map((m) => {
    const r = byslot[m.slot] || {};
    return {
      slot: m.slot, label: m.label, model: m.model,
      error: r.error || null,
      correctness: r.correctness, solved: r.solved, total: r.total,
      answerTokens: Math.max(0, (r.completionTokens || 0) - (r.reasoningTokens || 0)),
      costUsd: r.costUsd, wallMs: r.wallMs,
    };
  });
}

// Persist one completed run. ASYNC and meant to be called fire-and-forget from
// the request handler: on Cloud Run BASE_DIR is a gcsfuse mount where a write is
// a network round-trip, so doing it synchronously inline would block the single
// Node event loop and stall every other user's request. Returns a Promise of the
// stored record's light summary (or null on failure); never throws.
async function saveRun({ user, userName, task, models, results, kind }) {
  try {
    const id = newId();
    const at = Date.now();
    const record = {
      v: 1, id, at,
      user: norm(user), userName: userName || user,
      taskId: (task && task.id) || 'unknown',
      title: (task && task.title) || (task && task.id) || 'Run',
      kind: kind === 'single' ? 'single' : 'compare',   // a single re-run is not a model selection
      models: (models || []).map((m) => ({
        slot: m.slot, catalogId: m.catalogId, label: m.label,
        provider: m.provider, model: m.model, publisher: m.publisher, price: m.price,
        effort: m.effort || null,
      })),
      slots: (models || []).map((m) => ({ slot: m.slot, data: (results || []).find((r) => r && r.slot === m.slot) || null })),
      summary: summarize(models, results),
    };
    const dir = path.join(BASE_DIR, userKey(user));
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, id + '.json.tmp');
    await fsp.writeFile(tmp, JSON.stringify(record));
    await fsp.rename(tmp, path.join(dir, id + '.json'));
    return listItem(record);
  } catch (e) {
    console.warn('[history] saveRun failed:', (e && e.message) || e);
    return null;
  }
}

// Project a full record down to what a list needs (no heavy slots payload).
function listItem(rec) {
  return { id: rec.id, at: rec.at, user: rec.user, userName: rec.userName, taskId: rec.taskId, title: rec.title, summary: rec.summary };
}

function readDirSafe(dir) { try { return fs.readdirSync(dir); } catch (e) { return []; } }

// All run records under a single owner directory (newest first), full objects.
function recordsForKey(key, cap) {
  const dir = path.join(BASE_DIR, key);
  const files = readDirSafe(dir).filter((f) => f.endsWith('.json')).sort().reverse();
  const out = [];
  for (const f of files) {
    if (cap && out.length >= cap) break;
    const rec = readJson(path.join(dir, f));
    if (rec && rec.id) out.push(rec);
  }
  return out;
}

// The model line-up this user last ran, so the app opens on their selection
// instead of the shipped defaults. Read off run history rather than a separate
// preferences store: history is already keyed by username, which means it works
// for Google SSO users too — they get a synthetic session and are never written
// to the users file, so anything stored there would not survive for them.
//
// Single-model re-runs are skipped: re-running one column is not a statement
// about which three models you want next time.
function lastModels(username) {
  const recs = recordsForKey(userKey(username), 20);
  const pick = recs.find((r) => r.kind !== 'single' && Array.isArray(r.models) && r.models.length)
    || recs.find((r) => Array.isArray(r.models) && r.models.length);
  if (!pick) return null;
  const out = pick.models
    .filter((m) => m && m.catalogId)
    .map((m) => ({ catalogId: m.catalogId, effort: m.effort || null }));
  return out.length ? out : null;
}

// A user's own runs (light list, newest first).
function listRuns(username) {
  return recordsForKey(userKey(username), MAX_LIST_PER_USER).map(listItem).sort((a, b) => b.at - a.at);
}

// Every user's runs (admin only) — light list, newest first.
function listAllRuns() {
  const keys = readDirSafe(BASE_DIR).filter((d) => /^[0-9a-f]{40}$/.test(d));
  let all = [];
  for (const k of keys) all = all.concat(recordsForKey(k, MAX_LIST_ALL).map(listItem));
  all.sort((a, b) => b.at - a.at);
  return all.slice(0, MAX_LIST_ALL);
}

// Fetch one full record for restore. Non-admins are confined to their own dir;
// admins fall back to scanning all owners if it isn't theirs.
function getRun(id, { username, isAdmin }) {
  const sid = safeId(id);
  if (!sid) return null;
  const mine = path.join(BASE_DIR, userKey(username), sid + '.json');
  const own = readJson(mine);
  if (own) return own;
  if (!isAdmin) return null;
  for (const k of readDirSafe(BASE_DIR)) {
    if (!/^[0-9a-f]{40}$/.test(k)) continue;
    const rec = readJson(path.join(BASE_DIR, k, sid + '.json'));
    if (rec) return rec;
  }
  return null;
}

// Delete one run. Same confinement rules as getRun. Returns true if removed.
function deleteRun(id, { username, isAdmin }) {
  const sid = safeId(id);
  if (!sid) return false;
  const candidates = [path.join(BASE_DIR, userKey(username), sid + '.json')];
  if (isAdmin) {
    for (const k of readDirSafe(BASE_DIR)) {
      if (/^[0-9a-f]{40}$/.test(k)) candidates.push(path.join(BASE_DIR, k, sid + '.json'));
    }
  }
  for (const fp of candidates) {
    try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); return true; } } catch (e) { /* keep trying */ }
  }
  return false;
}

// Admin at-a-glance usage: per-user counts + today's activity + totals.
function usageSummary() {
  const startOfDay = (() => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); })();
  const byUser = new Map();
  let totalRuns = 0, runsToday = 0;
  for (const k of readDirSafe(BASE_DIR)) {
    if (!/^[0-9a-f]{40}$/.test(k)) continue;
    for (const rec of recordsForKey(k, MAX_LIST_ALL)) {
      totalRuns++;
      const today = rec.at >= startOfDay;
      if (today) runsToday++;
      const u = byUser.get(rec.user) || { user: rec.user, userName: rec.userName || rec.user, runs: 0, runsToday: 0, lastAt: 0, costUsd: 0 };
      u.runs++;
      if (today) u.runsToday++;
      if (rec.at > u.lastAt) { u.lastAt = rec.at; u.userName = rec.userName || rec.user; }
      (rec.summary || []).forEach((s) => { if (typeof s.costUsd === 'number') u.costUsd += s.costUsd; });
      byUser.set(rec.user, u);
    }
  }
  const users = Array.from(byUser.values()).sort((a, b) => b.lastAt - a.lastAt);
  return { generatedAt: Date.now(), dayStartUtc: startOfDay, totals: { users: users.length, totalRuns, runsToday }, users };
}

module.exports = { saveRun, listRuns, listAllRuns, getRun, deleteRun, usageSummary, lastModels, BASE_DIR };
