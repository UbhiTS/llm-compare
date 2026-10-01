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
// Per-user preferences in-memory map: userKey -> { user, prompt, taskId, slots, models, updatedAt }
const prefsByUserKey = new Map();
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
        CREATE TABLE IF NOT EXISTS user_prefs (
          user_key TEXT PRIMARY KEY,
          user TEXT NOT NULL,
          prompt TEXT,
          task_id TEXT,
          slots_json TEXT,
          attachments_json TEXT,
          saved_prompts_json TEXT,
          saved_presets_json TEXT,
          remembered INTEGER,
          updated_at INTEGER
        );
      `);
      try { sqliteDb.exec(`ALTER TABLE user_prefs ADD COLUMN attachments_json TEXT;`); } catch (_) {}
      try { sqliteDb.exec(`ALTER TABLE user_prefs ADD COLUMN saved_prompts_json TEXT;`); } catch (_) {}
      try { sqliteDb.exec(`ALTER TABLE user_prefs ADD COLUMN saved_presets_json TEXT;`); } catch (_) {}
      try { sqliteDb.exec(`ALTER TABLE user_prefs ADD COLUMN remembered INTEGER;`); } catch (_) {}
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
        upsertPref: sqliteDb.prepare(`
          INSERT INTO user_prefs (user_key, user, prompt, task_id, slots_json, attachments_json, saved_prompts_json, saved_presets_json, remembered, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_key) DO UPDATE SET
            user = excluded.user,
            prompt = excluded.prompt,
            task_id = excluded.task_id,
            slots_json = excluded.slots_json,
            attachments_json = excluded.attachments_json,
            saved_prompts_json = excluded.saved_prompts_json,
            saved_presets_json = excluded.saved_presets_json,
            remembered = excluded.remembered,
            updated_at = excluded.updated_at
        `),
        allPrefs: sqliteDb.prepare(`SELECT * FROM user_prefs`),
      };
      const rows = stmts.all.all();
      for (const r of rows) {
        metaById.set(r.id, rowToMeta(r));
      }
      try {
        const prefRows = stmts.allPrefs.all();
        for (const pr of prefRows) {
          const rowUser = norm(pr.user);
          if (!rowUser || userKey(rowUser) !== pr.user_key) continue;
          let slots = null;
          let attachments = [];
          let savedPrompts = [];
          let savedPresets = [];
          try { slots = JSON.parse(pr.slots_json || 'null'); } catch (_) {}
          try { attachments = JSON.parse(pr.attachments_json || '[]'); } catch (_) {}
          try { savedPrompts = JSON.parse(pr.saved_prompts_json || '[]'); } catch (_) {}
          try { savedPresets = JSON.parse(pr.saved_presets_json || '[]'); } catch (_) {}
          const models = Array.isArray(slots) ? slots.map((s) => ({ catalogId: s.catalogId, effort: s.effort })) : null;
          prefsByUserKey.set(pr.user_key, {
            user: rowUser,
            prompt: pr.prompt || '',
            taskId: pr.task_id || 'custom',
            slots,
            models,
            attachments: Array.isArray(attachments) ? attachments : [],
            savedPrompts: Array.isArray(savedPrompts) ? savedPrompts : [],
            savedPresets: Array.isArray(savedPresets) ? savedPresets : [],
            remembered: Boolean(pr.remembered),
            updatedAt: Number(pr.updated_at) || 0,
          });
        }
      } catch (_) {}
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
    prompt: typeof rec.prompt === 'string' ? rec.prompt : '',
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
let snapshotChain = Promise.resolve();
function schedulePersistSnapshot() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await flushSnapshotAsync();
  }, 250);
  if (persistTimer.unref) persistTimer.unref();
}

function flushSnapshotAsync() {
  snapshotChain = snapshotChain.then(async () => {
    try {
      await fsp.mkdir(BASE_DIR, { recursive: true });
      const suffix = `.tmp.${process.pid}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      // 1. Write compact index.json (single sequential file read/write on GCS FUSE)
      const allMeta = Array.from(metaById.values()).sort((a, b) => b.at - a.at);
      const tmpIdx = PERSIST_INDEX_JSON + suffix;
      await fsp.writeFile(tmpIdx, JSON.stringify(allMeta));
      await fsp.rename(tmpIdx, PERSIST_INDEX_JSON);

      // 2. If SQLite is active in /tmp, checkpoint WAL and copy SQLite snapshot to /data
      if (sqliteDb && fs.existsSync(LOCAL_SQLITE_PATH)) {
        try { sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) {}
        const tmpSqlite = PERSIST_SQLITE_PATH + suffix;
        await fsp.copyFile(LOCAL_SQLITE_PATH, tmpSqlite);
        await fsp.rename(tmpSqlite, PERSIST_SQLITE_PATH);
      }
    } catch (e) {
      // Non-fatal background snapshot
    }
  });
  return snapshotChain;
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
        const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json') && f !== 'prefs.json');
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
  if (!prefsByUserKey.has(key)) {
    const pfile = path.join(BASE_DIR, key, 'prefs.json');
    try {
      if (fs.existsSync(pfile)) {
        const raw = fs.readFileSync(pfile, 'utf8');
        const p = JSON.parse(raw);
        if (p) prefsByUserKey.set(key, p);
      }
    } catch (_) {}
  }
  for (const m of metaById.values()) {
    if (m.userKey === key) return;
  }
  const dir = path.join(BASE_DIR, key);
  try {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'prefs.json');
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
  if (!rec._cachedMtime) rec._cachedMtime = Date.now();
  if (fullPayloadCache.size >= MAX_PAYLOAD_CACHE) {
    const oldest = fullPayloadCache.keys().next().value;
    fullPayloadCache.delete(oldest);
  }
  fullPayloadCache.set(id, rec);
}

// Persist one completed run: updates SQLite + in-memory index immediately (<0.2ms)
// and writes the full payload JSON + index snapshot asynchronously.
async function saveRun({ id: passedId, user, userName, task, customPrompt, models, results, kind, judge, rememberPrompt }) {
  try {
    const id = safeId(passedId) || newId();
    const at = Date.now();
    const u = norm(user);
    const uKey = userKey(u);
    const promptText = (typeof customPrompt === 'string' && customPrompt.trim())
      ? customPrompt
      : ((task && typeof task.prompt === 'string') ? task.prompt : '');

    const rawAttachments = (task && Array.isArray(task.attachments)) ? task.attachments : [];
    const attachments = rawAttachments.map((a) => ({
      name: a.name,
      mimeType: a.mimeType,
      kind: a.kind,
      size: Number(a.size) || 0,
      isEmpty: Boolean(a.isEmpty),
      pageCount: Number(a.pageCount) || 0,
      warning: a.warning || null,
      optBadge: a.optBadge || null,
      sha1: a.sha1 || null,
      sha256: a.sha256 || null,
      data: a.data || '',
      textContent: a.textContent || '',
      claudeDataBase64: a.claudeDataBase64 || undefined,
      claudeMimeType: a.claudeMimeType || undefined,
      fitDataBase64: a.fitDataBase64 || undefined,
      fitMimeType: a.fitMimeType || undefined,
      estimatedTokens: a.estimatedTokens || undefined,
    }));

    const record = {
      v: 1, id, at,
      user: u, userKey: uKey, userName: userName || user,
      taskId: (task && task.id) || 'unknown',
      title: (task && task.title) || (task && task.id) || 'Run',
      prompt: promptText,
      kind: kind === 'single' ? 'single' : 'compare',
      attachments,
      models: (models || []).map((m) => ({
        slot: m.slot, catalogId: m.catalogId, label: m.label,
        provider: m.provider, model: m.model, publisher: m.publisher, price: m.price,
        effort: m.effort || null,
      })),
      slots: (models || []).map((m) => ({ slot: m.slot, data: (results || []).find((r) => r && r.slot === m.slot) || null })),
      summary: summarize(models, results),
      judge: judge || null,
    };

    // 1. Update SQLite & in-memory metadata index immediately
    const meta = recordToMeta(record);
    upsertMetaInternal(meta, true);
    cachePayload(id, record);

    // Update user preferences for remembered prompt and models selection on the slots
    const cur = getUserPreferences(u);
    const shouldRemember = (rememberPrompt !== undefined) ? Boolean(rememberPrompt) : true;
    const runSlots = (kind !== 'single' && Array.isArray(models) && models.length)
      ? models
          .filter((m) => m && m.catalogId)
          .map((m) => ({
            slot: m.slot || null,
            catalogId: m.catalogId,
            effort: m.effort || null,
          }))
      : ((cur && cur.slots) || null);

    if (shouldRemember) {
      saveUserPreferences(u, {
        prompt: promptText,
        attachments,
        remembered: true,
        taskId: (task && task.id) || (cur && cur.taskId) || 'custom',
        slots: runSlots,
      });
    } else {
      saveUserPreferences(u, {
        prompt: (cur && cur.prompt) || '',
        attachments: (cur && cur.attachments) || [],
        remembered: (cur && cur.remembered) !== undefined ? cur.remembered : false,
        taskId: (task && task.id) || (cur && cur.taskId) || 'custom',
        slots: runSlots,
      });
    }

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

// Derive remembered preferences from historical runs if no explicit preferences exist
function derivePrefsFromHistory(u, key) {
  const userRuns = [];
  for (const m of metaById.values()) {
    if (m.userKey === key) userRuns.push(m);
  }
  if (!userRuns.length) return null;
  userRuns.sort((a, b) => b.at - a.at);
  const pick = userRuns.find((r) => r.kind !== 'single' && Array.isArray(r.models) && r.models.length)
    || userRuns.find((r) => Array.isArray(r.models) && r.models.length);
  if (!pick) return null;

  let prompt = '';
  if (pick.prompt) {
    prompt = pick.prompt;
  } else {
    try {
      const full = getRun(pick.id, { username: u, isAdmin: true });
      if (full && typeof full.prompt === 'string') prompt = full.prompt;
    } catch (_) {}
  }

  const slots = (pick.models || [])
    .filter((m) => m && m.catalogId)
    .map((m) => ({ slot: m.slot || null, catalogId: m.catalogId, effort: m.effort || null }));

  return {
    user: u,
    prompt: prompt || '',
    taskId: pick.taskId || 'custom',
    slots: slots.length ? slots : null,
    models: slots.map((s) => ({ catalogId: s.catalogId, effort: s.effort })),
    updatedAt: pick.at,
  };
}

const MAX_SAVED_PROMPTS = 50;
const MAX_SAVED_PRESETS = 30;

function sanitizeAttachmentsArray(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).map((a) => ({
    name: String((a && a.name) || 'file').slice(0, 200),
    mimeType: String((a && a.mimeType) || 'application/octet-stream').slice(0, 100),
    size: Number(a && a.size) || 0,
    isEmpty: Boolean(a && a.isEmpty),
    pageCount: Number(a && a.pageCount) || 0,
    warning: (a && a.warning) ? String(a.warning).slice(0, 200) : null,
    optBadge: (a && a.optBadge) ? String(a.optBadge).slice(0, 200) : null,
    sha1: (a && a.sha1) ? String(a.sha1).slice(0, 64) : null,
    sha256: (a && a.sha256) ? String(a.sha256).slice(0, 64) : null,
    data: (a && typeof a.data === 'string') ? a.data : '',
    textContent: (a && typeof a.textContent === 'string') ? a.textContent.slice(0, 2500000) : '',
    claudeDataBase64: (a && typeof a.claudeDataBase64 === 'string') ? a.claudeDataBase64 : undefined,
    claudeMimeType: (a && a.claudeMimeType) ? String(a.claudeMimeType) : undefined,
    fitDataBase64: (a && typeof a.fitDataBase64 === 'string') ? a.fitDataBase64 : undefined,
    fitMimeType: (a && a.fitMimeType) ? String(a.fitMimeType) : undefined,
    estimatedTokens: Number(a && a.estimatedTokens) || undefined,
  }));
}

function sanitizeSavedPromptItem(item) {
  if (!item || typeof item !== 'object') return null;
  const prompt = typeof item.prompt === 'string' ? item.prompt.slice(0, 500000) : '';
  const attachments = sanitizeAttachmentsArray(item.attachments);
  if (!prompt.trim() && !attachments.length) return null;
  const rawId = typeof item.id === 'string' ? item.id.trim() : '';
  const id = /^[a-zA-Z0-9_-]{4,64}$/.test(rawId)
    ? rawId
    : `sp_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
  const fallbackTitle = prompt.trim()
    ? prompt.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').slice(0, 64)
    : (attachments.length ? `Saved Files (${attachments.map((a) => a.name).join(', ').slice(0, 48)})` : 'Saved Prompt');
  const title = (rawTitle || fallbackTitle || 'Saved Prompt').slice(0, 120);
  const now = Date.now();
  return {
    id,
    title,
    prompt,
    attachments,
    createdAt: Number(item.createdAt) || now,
    updatedAt: Number(item.updatedAt) || now,
  };
}

function sanitizeSavedPromptsList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seenIds = new Set();
  for (const raw of list) {
    const clean = sanitizeSavedPromptItem(raw);
    if (!clean || seenIds.has(clean.id)) continue;
    seenIds.add(clean.id);
    out.push(clean);
    if (out.length >= MAX_SAVED_PROMPTS) break;
  }
  return out;
}

function sanitizeSavedPresetItem(item) {
  if (!item || typeof item !== 'object') return null;
  const rawSlots = Array.isArray(item.slots) ? item.slots : (Array.isArray(item.models) ? item.models : []);
  const slots = rawSlots
    .slice(0, 6)
    .filter((s) => s && typeof (s.catalogId || s.id) === 'string' && String(s.catalogId || s.id).trim())
    .map((s, idx) => ({
      slot: (typeof s.slot === 'string' && /^[A-F]$/.test(s.slot)) ? s.slot : String.fromCharCode(65 + idx),
      catalogId: String(s.catalogId || s.id).trim().slice(0, 80),
      effort: (typeof s.effort === 'string' && s.effort.trim()) ? s.effort.trim().slice(0, 40) : null,
    }));
  if (!slots.length) return null;
  const rawId = typeof item.id === 'string' ? item.id.trim() : '';
  const id = /^[a-zA-Z0-9_-]{4,64}$/.test(rawId)
    ? rawId
    : `mp_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
  const fallbackTitle = slots.map((s) => s.catalogId).join(' vs ').slice(0, 64) || 'Saved Model Preset';
  const title = (rawTitle || fallbackTitle).slice(0, 100);
  const now = Date.now();
  return {
    id,
    title,
    slots,
    createdAt: Number(item.createdAt) || now,
    updatedAt: Number(item.updatedAt) || now,
  };
}

function sanitizeSavedPresetsList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seenIds = new Set();
  for (const raw of list) {
    const clean = sanitizeSavedPresetItem(raw);
    if (!clean || seenIds.has(clean.id)) continue;
    seenIds.add(clean.id);
    out.push(clean);
    if (out.length >= MAX_SAVED_PRESETS) break;
  }
  return out;
}

// Get remembered preferences for a specific user (prompt, taskId, slots, savedPrompts, savedPresets)
// Strictly isolated by normalized username + SHA-256 userKey; returns a defensive copy.
function getUserPreferences(username) {
  const u = norm(username);
  if (!u) return { prompt: '', taskId: 'custom', slots: null, models: null, attachments: [], savedPrompts: [], savedPresets: [], remembered: false };
  const key = userKey(u);
  ensureOwnerLoadedSync(key);
  let p = prefsByUserKey.get(key);
  // Privacy guard: verify cached entry belongs to this exact normalized user
  if (p && p.user && norm(p.user) !== u) {
    prefsByUserKey.delete(key);
    p = null;
  }
  if (!p) {
    const fp = path.join(BASE_DIR, key, 'prefs.json');
    try {
      if (fs.existsSync(fp)) {
        const raw = fs.readFileSync(fp, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && (!parsed.user || norm(parsed.user) === u)) {
          parsed.user = u;
          p = parsed;
          prefsByUserKey.set(key, p);
        }
      }
    } catch (_) {}
  }
  if (!p) {
    p = derivePrefsFromHistory(u, key);
    if (p) {
      prefsByUserKey.set(key, p);
    }
  }
  if (p) {
    if (!Array.isArray(p.attachments)) p.attachments = [];
    if (!Array.isArray(p.savedPrompts)) p.savedPrompts = [];
    if (!Array.isArray(p.savedPresets)) p.savedPresets = [];
    if (p.remembered === undefined) p.remembered = false;
    return {
      user: u,
      prompt: p.prompt || '',
      taskId: p.taskId || 'custom',
      slots: Array.isArray(p.slots) ? p.slots.map((s) => ({ ...s })) : null,
      models: Array.isArray(p.models) ? p.models.map((m) => ({ ...m })) : null,
      attachments: p.attachments.slice(),
      savedPrompts: p.savedPrompts.slice(),
      savedPresets: p.savedPresets.slice(),
      remembered: Boolean(p.remembered),
      updatedAt: p.updatedAt || 0,
    };
  }
  return { user: u, prompt: '', taskId: 'custom', slots: null, models: null, attachments: [], savedPrompts: [], savedPresets: [], remembered: false };
}

// Per-user promise chain so rapid concurrent saveUserPreferences calls
// always serialize cleanly and write the latest prefsByUserKey snapshot.
const prefWriteChains = new Map();

// Save remembered preferences for a specific user
function saveUserPreferences(username, newPrefs) {
  const u = norm(username);
  if (!u) return null;
  const key = userKey(u);
  const current = getUserPreferences(u) || {};

  let remembered = (current && current.remembered) !== undefined ? current.remembered : false;
  if (newPrefs.remembered !== undefined) {
    remembered = Boolean(newPrefs.remembered);
  }

  let prompt = current.prompt || '';
  let attachments = Array.isArray(current.attachments) ? current.attachments : [];

  if (newPrefs.remembered === false) {
    prompt = '';
    attachments = [];
  } else {
    if (typeof newPrefs.prompt === 'string') {
      prompt = newPrefs.prompt.slice(0, 500000);
    }
    if (Array.isArray(newPrefs.attachments)) {
      attachments = sanitizeAttachmentsArray(newPrefs.attachments);
    }
  }

  const savedPrompts = Array.isArray(newPrefs.savedPrompts)
    ? sanitizeSavedPromptsList(newPrefs.savedPrompts)
    : (Array.isArray(current.savedPrompts) ? current.savedPrompts : []);

  const savedPresets = Array.isArray(newPrefs.savedPresets)
    ? sanitizeSavedPresetsList(newPrefs.savedPresets)
    : (Array.isArray(current.savedPresets) ? current.savedPresets : []);

  const taskId = typeof newPrefs.taskId === 'string'
    ? newPrefs.taskId.slice(0, 100)
    : (current.taskId || 'custom');

  let slots = null;
  if (Array.isArray(newPrefs.slots)) {
    slots = newPrefs.slots
      .slice(0, 6)
      .filter((s) => s && (s.catalogId || s.id))
      .map((s) => ({
        slot: s.slot || null,
        catalogId: s.catalogId || s.id,
        effort: s.effort || null,
      }));
  } else if (Array.isArray(newPrefs.models)) {
    slots = newPrefs.models
      .slice(0, 6)
      .filter((m) => m && (m.catalogId || m.id))
      .map((m) => ({
        slot: m.slot || null,
        catalogId: m.catalogId || m.id,
        effort: m.effort || null,
      }));
  } else if (current.slots) {
    slots = current.slots;
  }

  const models = slots ? slots.map((s) => ({ catalogId: s.catalogId, effort: s.effort })) : (current.models || null);
  const updatedAt = Date.now();

  const prefObj = {
    user: u,
    prompt,
    taskId,
    slots,
    models,
    attachments,
    savedPrompts,
    savedPresets,
    remembered: Boolean(remembered),
    updatedAt,
  };

  prefsByUserKey.set(key, prefObj);

  if (stmts && stmts.upsertPref) {
    try {
      stmts.upsertPref.run(
        key,
        u,
        prompt,
        taskId,
        JSON.stringify(slots || []),
        JSON.stringify(attachments || []),
        JSON.stringify(savedPrompts || []),
        JSON.stringify(savedPresets || []),
        remembered ? 1 : 0,
        updatedAt
      );
      schedulePersistSnapshot();
    } catch (_) {}
  }

  // Persist to disk asynchronously in serialized order per user
  const prevChain = prefWriteChains.get(key) || Promise.resolve();
  const nextChain = prevChain.then(async () => {
    const latest = prefsByUserKey.get(key) || prefObj;
    const dir = path.join(BASE_DIR, key);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `prefs.json.tmp.${process.pid}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    const finalPath = path.join(dir, 'prefs.json');
    const payload = JSON.stringify(latest, null, 2);
    try {
      await fsp.writeFile(tmp, payload);
      await fsp.rename(tmp, finalPath);
    } catch (_) {
      await fsp.writeFile(finalPath, payload).catch(() => {});
      try { await fsp.unlink(tmp); } catch (_) {}
    }
  }).catch((e) => {
    console.warn('[history] saveUserPreferences write failed:', (e && e.message) || e);
  });
  prefWriteChains.set(key, nextChain);

  return prefObj;
}

// List a user's saved prompts library (newest / most recently updated first).
function listSavedPrompts(username) {
  const p = getUserPreferences(username);
  return Array.isArray(p && p.savedPrompts) ? p.savedPrompts.slice() : [];
}

// Save or update a named prompt in the user's saved prompts library.
function saveUserPrompt(username, item) {
  const u = norm(username);
  if (!u) throw new Error('User is required.');
  const clean = sanitizeSavedPromptItem(item);
  if (!clean) throw new Error('Please enter a prompt or attach a file before saving.');
  const existing = listSavedPrompts(u).slice();
  const now = Date.now();
  const matchIdx = existing.findIndex((x) =>
    (item && item.id && x.id === clean.id) || (item && !item.id && x.title.toLowerCase() === clean.title.toLowerCase())
  );
  let savedEntry;
  if (matchIdx >= 0) {
    const prev = existing[matchIdx];
    savedEntry = {
      ...clean,
      id: prev.id,
      createdAt: prev.createdAt || now,
      updatedAt: now,
    };
    existing.splice(matchIdx, 1);
  } else {
    // Always mint a fresh server-side ID when creating a new entry so users can never collide or spoof IDs
    const freshId = `sp_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    savedEntry = {
      ...clean,
      id: freshId,
      createdAt: now,
      updatedAt: now,
    };
  }
  const updatedList = [savedEntry, ...existing].slice(0, MAX_SAVED_PROMPTS);
  saveUserPreferences(u, { savedPrompts: updatedList });
  return { ok: true, saved: savedEntry, prompt: savedEntry, savedPrompts: updatedList };
}

// Delete a saved prompt by ID from the user's library.
function deleteUserPrompt(username, promptId) {
  const u = norm(username);
  if (!u) return { ok: false, removed: false, savedPrompts: [] };
  const sid = String(promptId || '').trim();
  const existing = listSavedPrompts(u);
  const filtered = existing.filter((x) => x && x.id !== sid);
  const removed = filtered.length !== existing.length;
  if (removed) {
    saveUserPreferences(u, { savedPrompts: filtered });
  }
  return { ok: true, removed, savedPrompts: filtered };
}

// List a user's saved model presets library (newest / most recently updated first).
function listSavedPresets(username) {
  const p = getUserPreferences(username);
  return Array.isArray(p && p.savedPresets) ? p.savedPresets.slice() : [];
}

// Save or update a named model preset in the user's saved presets library.
function saveUserPreset(username, item) {
  const u = norm(username);
  if (!u) throw new Error('User is required.');
  const clean = sanitizeSavedPresetItem(item);
  if (!clean) throw new Error('Select at least one model before saving a preset.');
  const existing = listSavedPresets(u).slice();
  const now = Date.now();
  const matchIdx = existing.findIndex((x) =>
    (item && item.id && x.id === clean.id) || (item && !item.id && x.title.toLowerCase() === clean.title.toLowerCase())
  );
  let savedEntry;
  if (matchIdx >= 0) {
    const prev = existing[matchIdx];
    savedEntry = {
      ...clean,
      id: prev.id,
      createdAt: prev.createdAt || now,
      updatedAt: now,
    };
    existing.splice(matchIdx, 1);
  } else {
    const freshId = `mp_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    savedEntry = {
      ...clean,
      id: freshId,
      createdAt: now,
      updatedAt: now,
    };
  }
  const updatedList = [savedEntry, ...existing].slice(0, MAX_SAVED_PRESETS);
  saveUserPreferences(u, { savedPresets: updatedList });
  return { ok: true, saved: savedEntry, preset: savedEntry, savedPresets: updatedList };
}

// Delete a saved model preset by ID from the user's library.
function deleteUserPreset(username, presetId) {
  const u = norm(username);
  if (!u) return { ok: false, removed: false, savedPresets: [] };
  const sid = String(presetId || '').trim();
  const existing = listSavedPresets(u);
  const filtered = existing.filter((x) => x && x.id !== sid);
  const removed = filtered.length !== existing.length;
  if (removed) {
    saveUserPreferences(u, { savedPresets: filtered });
  }
  return { ok: true, removed, savedPresets: filtered };
}

// Instant (<0.1ms) lookup of the user's last used prompt
function lastPrompt(username) {
  const p = getUserPreferences(username);
  if (p && typeof p.prompt === 'string' && p.prompt.trim()) {
    return p.prompt;
  }
  return null;
}

// Instant (<0.1ms) lookup of the user's most recent model line-up from the SQLite/memory index.
function lastModels(username) {
  const p = getUserPreferences(username);
  if (p && Array.isArray(p.models) && p.models.length) {
    const out = p.models
      .filter((m) => m && m.catalogId)
      .map((m) => ({ catalogId: m.catalogId, effort: m.effort || null }));
    if (out.length) return out;
  }
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
  const u = norm(username);
  const key = userKey(u);
  ensureOwnerLoadedSync(key);
  const out = [];
  for (const m of metaById.values()) {
    if (m.userKey === key && (!m.user || norm(m.user) === u)) out.push(listItem(m));
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
    const meta = metaById.get(sid);
    const ownerKey = (meta && meta.userKey) || myKey;
    const fp = path.join(BASE_DIR, ownerKey, sid + '.json');
    try {
      if (fs.existsSync(fp)) {
        const st = fs.statSync(fp);
        if (st.mtimeMs > (cached._cachedMtime || 0)) {
          const fresh = JSON.parse(fs.readFileSync(fp, 'utf8'));
          if (fresh) {
            fresh._cachedMtime = st.mtimeMs;
            cachePayload(sid, fresh);
            if (isAdmin || userKey(fresh.user) === myKey) return fresh;
          }
        }
      }
    } catch (_) {}
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

// Attach a completed Blind LLM-as-Judge evaluation to a saved history run so
// History -> Restore and GET /api/history/:id/pdf include the Judge verdict.
async function attachJudgeToLatestRun(username, taskId, judgeVerdict, runId) {
  try {
    if (!judgeVerdict || typeof judgeVerdict !== 'object') return false;
    const u = norm(username);
    if (!u) return false;
    const uKey = userKey(u);
    ensureOwnerLoadedSync(uKey);

    let targetId = safeId(runId);
    if (targetId) {
      const existingMeta = metaById.get(targetId);
      if (existingMeta) {
        // Privacy guard: a user may only attach a judge verdict to their OWN run
        if (existingMeta.userKey !== uKey) return false;
      } else {
        const candidateFp = path.join(BASE_DIR, uKey, targetId + '.json');
        if (!fs.existsSync(candidateFp)) {
          targetId = null;
        }
      }
    }
    if (!targetId) {
      const userRuns = [];
      for (const m of metaById.values()) {
        if (m.userKey === uKey) userRuns.push(m);
      }
      userRuns.sort((a, b) => b.at - a.at);
      const match = (taskId && userRuns.find((m) => m.taskId === taskId)) || userRuns[0];
      targetId = match ? match.id : null;
    }
    if (!targetId) return false;

    const meta = metaById.get(targetId);
    if (meta && meta.userKey !== uKey) return false;
    const ownerKey = uKey;
    const fp = path.join(BASE_DIR, ownerKey, targetId + '.json');
    let rec = fullPayloadCache.get(targetId);
    if (!rec && fs.existsSync(fp)) {
      try { rec = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) {}
    }
    if (!rec || userKey(rec.user) !== uKey) return false;

    rec.judge = judgeVerdict;
    cachePayload(targetId, rec);

    const dir = path.join(BASE_DIR, ownerKey);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${targetId}.json.tmp.${process.pid}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(tmp, JSON.stringify(rec));
    await fsp.rename(tmp, fp);
    return true;
  } catch (e) {
    console.warn('[history] attachJudgeToLatestRun failed:', (e && e.message) || e);
    return false;
  }
}

initSqlite();

module.exports = {
  saveRun,
  attachJudgeToLatestRun,
  newId,
  listRuns,
  listAllRuns,
  getRun,
  deleteRun,
  usageSummary,
  lastModels,
  lastPrompt,
  getUserPreferences,
  saveUserPreferences,
  listSavedPrompts,
  saveUserPrompt,
  deleteUserPrompt,
  listSavedPresets,
  saveUserPreset,
  deleteUserPreset,
  BASE_DIR,
};

