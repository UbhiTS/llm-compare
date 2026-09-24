// ---------------------------------------------------------------------------
// history.js — SQLite-backed + in-memory indexed run history (server-authoritative).
//
// Why this architecture is <1ms on Cloud Run (GCS FUSE):
// 1. Previously, listAllRuns() and usageSummary() did O(U) synchronous
//    fs.readdirSync() + O(R) synchronous fs.readFileSync() across every user's
//    100KB–400KB .json files on the /data GCS FUSE volume (~50ms network RTT
//    per file = 8–20+ seconds for 150+ runs!).
// 2. Now we use a local SQLite database (/tmp/llm-compare-history.sqlite via
//    Node's built-in `node:sqlite` DatabaseSync, with an automatic in-memory
//    indexed mirror on Node 20) that stores ONLY the compact run metadata
//    (id, at, user, userKey, userName, taskId, title, kind, models, summary)
//    indexed by `at DESC` and `(user_key, at DESC)`.
// 3. The SQLite database is atomically snapshotted to `/data/history/history.sqlite`
//    (and `/data/history/index.json`) on the persistent GCS volume so the entire
//    index loads in a SINGLE sequential read (~20ms) on container startup, and
//    any legacy per-run `.json` files in `/data/history/<userKey>/*.json` are
//    backfilled asynchronously in the background without blocking requests.
// 4. Full heavy run payloads (generated code + thinking traces in `slots`) are
//    stored in `/data/history/<userKey>/<id>.json` and ONLY read when a user
//    clicks a specific run to restore (`getRun(id)`).
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const BASE_DIR = process.env.APP_DATA_DIR
  ? path.join(process.env.APP_DATA_DIR, 'history')
  : path.join(__dirname, '..', '.data', 'history');

const MAX_LIST_PER_USER = 200;   // most-recent N returned to a user
const MAX_LIST_ALL = 1000;       // most-recent N returned to an admin (all users)

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
function userKey(username) {
  return crypto.createHash('sha256').update(norm(username)).digest('hex').slice(0, 40);
}
function safeId(id) { return /^[a-z0-9-]{1,80}$/.test(String(id || '')) ? String(id) : null; }
function newId() { return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`; }

// Paths for persistent snapshot on /data (GCS FUSE) and fast local SQLite in /tmp
const PERSIST_SQLITE_PATH = path.join(BASE_DIR, 'history.sqlite');
const PERSIST_INDEX_JSON = path.join(BASE_DIR, 'index.json');
const LOCAL_SQLITE_PATH = path.join(
  os.tmpdir(),
  `llm-compare-history-${crypto.createHash('md5').update(BASE_DIR).digest('hex').slice(0, 10)}.sqlite`
);

// Optional native SQLite (`node:sqlite` in Node 22+)
let DatabaseSync = null;
try {
  // Suppress experimental warning noise while using built-in SQLite
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  DatabaseSync = null;
}

let sqliteDb = null;
let stmts = null;

// Authoritative in-memory index map: id -> metadata object
// Kept 100% in sync with SQLite so both Node 20 and Node 22 answer listRuns /
// listAllRuns / usageSummary / lastModels in <0.2ms with zero disk I/O!
const metaById = new Map();
// Full payload LRU cache for getRun(id): id -> full record
const fullPayloadCache = new Map();
const MAX_PAYLOAD_CACHE = 300;

function initSqlite() {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    // If a persisted SQLite DB exists on /data, copy it once to local /tmp
    // (never open SQLite directly on a GCS FUSE mount to avoid POSIX lock issues).
    if (DatabaseSync) {
      if (fs.existsSync(PERSIST_SQLITE_PATH) && !fs.existsSync(LOCAL_SQLITE_PATH)) {
        try { fs.copyFileSync(PERSIST_SQLITE_PATH, LOCAL_SQLITE_PATH); } catch (_) {}
      }
      sqliteDb = new DatabaseSync(LOCAL_SQLITE_PATH);
      sqliteDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          user TEXT NOT NULL,
          user_key TEXT NOT NULL,
          user_name TEXT NOT NULL,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          kind TEXT NOT NULL,
          models_json TEXT NOT NULL,
          summary_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_runs_at ON runs(at DESC);
        CREATE INDEX IF NOT EXISTS idx_runs_user_at ON runs(user_key, at DESC);
      `);
      stmts = {
        upsert: sqliteDb.prepare(`
          INSERT INTO runs (id, at, user, user_key, user_name, task_id, title, kind, models_json, summary_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            at = excluded.at,
            user_name = excluded.user_name,
            title = excluded.title,
            models_json = excluded.models_json,
            summary_json = excluded.summary_json
        `),
        del: sqliteDb.prepare(`DELETE FROM runs WHERE id = ?`),
        all: sqliteDb.prepare(`SELECT * FROM runs ORDER BY at DESC`),
      };
      const rows = stmts.all.all();
      for (const r of rows) {
        metaById.set(r.id, rowToMeta(r));
      }
    }
  } catch (e) {
    console.warn('[history] SQLite init fallback to JSON index:', (e && e.message) || e);
    sqliteDb = null;
    stmts = null;
  }

  // Also load PERSIST_INDEX_JSON if present (single-file fast index for any rows not yet in SQLite)
  try {
    if (fs.existsSync(PERSIST_INDEX_JSON)) {
      const arr = JSON.parse(fs.readFileSync(PERSIST_INDEX_JSON, 'utf8'));
      if (Array.isArray(arr)) {
        for (const m of arr) {
          if (m && m.id && !metaById.has(m.id)) {
            upsertMetaInternal(m, false);
          }
        }
      }
    }
  } catch (_) {}

  // Kick off non-blocking background backfill of any legacy per-run .json files
  // so existing Cloud Run history on GCS FUSE is imported into SQLite without stalling requests.
  scheduleBackgroundBackfill();
}

function rowToMeta(r) {
  let models = [], summary = [];
  try { models = JSON.parse(r.models_json || '[]'); } catch (_) {}
  try { summary = JSON.parse(r.summary_json || '[]'); } catch (_) {}
  return {
    id: r.id,
    at: Number(r.at) || 0,
    user: r.user,
    userKey: r.user_key,
    userName: r.user_name || r.user,
    taskId: r.task_id || 'unknown',
    title: r.title || 'Run',
    kind: r.kind || 'compare',
    models,
    summary,
  };
}

function recordToMeta(rec) {
  const u = norm(rec.user);
  return {
    id: rec.id,
    at: Number(rec.at) || Date.now(),
    user: u,
    userKey: rec.userKey || userKey(u),
    userName: rec.userName || rec.user || u,
    taskId: rec.taskId || 'unknown',
    title: rec.title || rec.taskId || 'Run',
    kind: rec.kind === 'single' ? 'single' : 'compare',
    models: Array.isArray(rec.models) ? rec.models : [],
    summary: Array.isArray(rec.summary) ? rec.summary : [],
  };
}

function upsertMetaInternal(meta, persistDisk = true) {
  if (!meta || !meta.id) return;
  metaById.set(meta.id, meta);
  if (stmts) {
    try {
      stmts.upsert.run(
        meta.id,
        meta.at,
        meta.user,
        meta.userKey || userKey(meta.user),
        meta.userName || meta.user,
        meta.taskId || 'unknown',
        meta.title || 'Run',
        meta.kind || 'compare',
        JSON.stringify(meta.models || []),
        JSON.stringify(meta.summary || [])
      );
    } catch (_) {}
  }
  if (persistDisk) schedulePersistSnapshot();
}

let persistTimer = null;
function schedulePersistSnapshot() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await flushSnapshotAsync();
  }, 250);
  if (persistTimer.unref) persistTimer.unref();
}

async function flushSnapshotAsync() {
  try {
    await fsp.mkdir(BASE_DIR, { recursive: true });
    // 1. Write compact index.json (single sequential file read/write on GCS FUSE)
    const allMeta = Array.from(metaById.values()).sort((a, b) => b.at - a.at);
    const tmpIdx = PERSIST_INDEX_JSON + '.tmp';
    await fsp.writeFile(tmpIdx, JSON.stringify(allMeta));
    await fsp.rename(tmpIdx, PERSIST_INDEX_JSON);

    // 2. If SQLite is active in /tmp, checkpoint WAL and copy SQLite snapshot to /data
    if (sqliteDb && fs.existsSync(LOCAL_SQLITE_PATH)) {
      try { sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) {}
      const tmpSqlite = PERSIST_SQLITE_PATH + '.tmp';
      await fsp.copyFile(LOCAL_SQLITE_PATH, tmpSqlite);
      await fsp.rename(tmpSqlite, PERSIST_SQLITE_PATH);
    }
  } catch (e) {
    // Non-fatal background snapshot
  }
}

let backfillStarted = false;
function scheduleBackgroundBackfill() {
  if (backfillStarted) return;
  backfillStarted = true;
  const t = setTimeout(async () => {
    try {
      const entries = await fsp.readdir(BASE_DIR).catch(() => []);
      const ownerDirs = entries.filter((d) => /^[0-9a-f]{40}$/.test(d));
      let imported = 0;
      for (const k of ownerDirs) {
        const dir = path.join(BASE_DIR, k);
        const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
        // Process in batches of 8 concurrent async reads so we never block the event loop
        for (let i = 0; i < files.length; i += 8) {
          const batch = files.slice(i, i + 8);
          await Promise.all(batch.map(async (f) => {
            const id = f.slice(0, -5);
            if (metaById.has(id)) return;
            try {
              const raw = await fsp.readFile(path.join(dir, f), 'utf8');
              const rec = JSON.parse(raw);
              if (rec && rec.id) {
                rec.userKey = k;
                upsertMetaInternal(recordToMeta(rec), false);
                imported++;
              }
            } catch (_) {}
          }));
        }
      }
      if (imported > 0) {
        console.log(`[history] Backfilled ${imported} existing runs into SQLite index.`);
        await flushSnapshotAsync();
      }
    } catch (_) {}
  }, 50);
  if (t.unref) t.unref();
}

// Synchronous one-time scan for a specific owner key ONLY if that owner has 0
// entries in metaById (e.g., unit test that writes files or fresh local dir).
function ensureOwnerLoadedSync(key) {
  for (const m of metaById.values()) {
    if (m.userKey === key) return;
  }
  const dir = path.join(BASE_DIR, key);
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    let added = 0;
    for (const f of files) {
      const id = f.slice(0, -5);
      if (metaById.has(id)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (rec && rec.id) {
          rec.userKey = key;
          upsertMetaInternal(recordToMeta(rec), false);
          fullPayloadCache.set(rec.id, rec);
          added++;
        }
      } catch (_) {}
    }
    if (added > 0) schedulePersistSnapshot();
  } catch (_) {}
}

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

function listItem(meta) {
  return {
    id: meta.id,
    at: meta.at,
    user: meta.user,
    userName: meta.userName,
    taskId: meta.taskId,
    title: meta.title,
    summary: meta.summary,
  };
}

function cachePayload(id, rec) {
  if (!id || !rec) return;
  if (fullPayloadCache.size >= MAX_PAYLOAD_CACHE) {
    const oldest = fullPayloadCache.keys().next().value;
    fullPayloadCache.delete(oldest);
  }
  fullPayloadCache.set(id, rec);
}

// Persist one completed run: updates SQLite + in-memory index immediately (<0.2ms)
// and writes the full payload JSON + index snapshot asynchronously.
async function saveRun({ user, userName, task, models, results, kind }) {
  try {
    const id = newId();
    const at = Date.now();
    const u = norm(user);
    const uKey = userKey(u);
    const record = {
      v: 1, id, at,
      user: u, userKey: uKey, userName: userName || user,
      taskId: (task && task.id) || 'unknown',
      title: (task && task.title) || (task && task.id) || 'Run',
      kind: kind === 'single' ? 'single' : 'compare',
      models: (models || []).map((m) => ({
        slot: m.slot, catalogId: m.catalogId, label: m.label,
        provider: m.provider, model: m.model, publisher: m.publisher, price: m.price,
        effort: m.effort || null,
      })),
      slots: (models || []).map((m) => ({ slot: m.slot, data: (results || []).find((r) => r && r.slot === m.slot) || null })),
      summary: summarize(models, results),
    };

    // 1. Update SQLite & in-memory metadata index immediately
    const meta = recordToMeta(record);
    upsertMetaInternal(meta, true);
    cachePayload(id, record);

    // 2. Write full record JSON to owner directory for getRun(id) restore
    const dir = path.join(BASE_DIR, uKey);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, id + '.json.tmp');
    const finalPath = path.join(dir, id + '.json');
    await fsp.writeFile(tmp, JSON.stringify(record));
    await fsp.rename(tmp, finalPath);

    return listItem(meta);
  } catch (e) {
    console.warn('[history] saveRun failed:', (e && e.message) || e);
    return null;
  }
}

// Instant (<0.1ms) lookup of the user's most recent model line-up from the SQLite/memory index.
function lastModels(username) {
  const key = userKey(username);
  ensureOwnerLoadedSync(key);
  const userRuns = [];
  for (const m of metaById.values()) {
    if (m.userKey === key) userRuns.push(m);
  }
  userRuns.sort((a, b) => b.at - a.at);
  const recs = userRuns.slice(0, 20);
  const pick = recs.find((r) => r.kind !== 'single' && Array.isArray(r.models) && r.models.length)
    || recs.find((r) => Array.isArray(r.models) && r.models.length);
  if (!pick) return null;
  const out = pick.models
    .filter((m) => m && m.catalogId)
    .map((m) => ({ catalogId: m.catalogId, effort: m.effort || null }));
  return out.length ? out : null;
}

// Instant (<0.1ms) list of a single user's runs (newest first).
function listRuns(username) {
  const key = userKey(username);
  ensureOwnerLoadedSync(key);
  const out = [];
  for (const m of metaById.values()) {
    if (m.userKey === key) out.push(listItem(m));
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, MAX_LIST_PER_USER);
}

// Instant (<0.2ms) list of ALL users' runs for Admins (zero GCS FUSE file reads!).
function listAllRuns() {
  const all = [];
  for (const m of metaById.values()) {
    all.push(listItem(m));
  }
  all.sort((a, b) => b.at - a.at);
  return all.slice(0, MAX_LIST_ALL);
}

// Fetch one full record (with code & thinking traces) when a user clicks Restore.
function getRun(id, { username, isAdmin }) {
  const sid = safeId(id);
  if (!sid) return null;
  const myKey = userKey(username);

  if (fullPayloadCache.has(sid)) {
    const cached = fullPayloadCache.get(sid);
    if (isAdmin || userKey(cached.user) === myKey) return cached;
    return null;
  }

  // Check SQLite/memory index for exact owner directory so we never scan all directories!
  const meta = metaById.get(sid);
  if (meta) {
    if (!isAdmin && meta.userKey !== myKey) return null;
    const fp = path.join(BASE_DIR, meta.userKey, sid + '.json');
    try {
      const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (rec) { cachePayload(sid, rec); return rec; }
    } catch (_) {}
  }

  // Fallback direct file lookup
  const mine = path.join(BASE_DIR, myKey, sid + '.json');
  try {
    if (fs.existsSync(mine)) {
      const own = JSON.parse(fs.readFileSync(mine, 'utf8'));
      if (own) { cachePayload(sid, own); return own; }
    }
  } catch (_) {}

  if (!isAdmin) return null;
  try {
    for (const k of fs.readdirSync(BASE_DIR)) {
      if (!/^[0-9a-f]{40}$/.test(k)) continue;
      const fp = path.join(BASE_DIR, k, sid + '.json');
      if (fs.existsSync(fp)) {
        const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (rec) { cachePayload(sid, rec); return rec; }
      }
    }
  } catch (_) {}
  return null;
}

// Delete one run from SQLite index, memory, and disk.
function deleteRun(id, { username, isAdmin }) {
  const sid = safeId(id);
  if (!sid) return false;
  const myKey = userKey(username);
  const meta = metaById.get(sid);
  if (meta && !isAdmin && meta.userKey !== myKey) return false;

  const candidates = [path.join(BASE_DIR, myKey, sid + '.json')];
  if (meta && meta.userKey) candidates.unshift(path.join(BASE_DIR, meta.userKey, sid + '.json'));
  if (isAdmin) {
    try {
      for (const k of fs.readdirSync(BASE_DIR)) {
        if (/^[0-9a-f]{40}$/.test(k)) candidates.push(path.join(BASE_DIR, k, sid + '.json'));
      }
    } catch (_) {}
  }

  let removed = false;
  for (const fp of new Set(candidates)) {
    try {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        removed = true;
      }
    } catch (_) {}
  }

  if (metaById.has(sid)) {
    metaById.delete(sid);
    removed = true;
  }
  fullPayloadCache.delete(sid);
  if (stmts) {
    try { stmts.del.run(sid); } catch (_) {}
  }
  if (removed) schedulePersistSnapshot();
  return removed;
}

// Instant (<0.2ms) Admin at-a-glance usage summary computed directly from the SQLite/memory index.
function usageSummary() {
  const startOfDay = (() => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); })();
  const byUser = new Map();
  let totalRuns = 0, runsToday = 0;
  for (const rec of metaById.values()) {
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
  const users = Array.from(byUser.values()).sort((a, b) => b.lastAt - a.lastAt);
  return { generatedAt: Date.now(), dayStartUtc: startOfDay, totals: { users: users.length, totalRuns, runsToday }, users };
}

initSqlite();

module.exports = { saveRun, listRuns, listAllRuns, getRun, deleteRun, usageSummary, lastModels, BASE_DIR };
