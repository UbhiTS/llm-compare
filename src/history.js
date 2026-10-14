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
const vault = require('./vault');

const BASE_DIR = process.env.APP_DATA_DIR
  ? path.join(process.env.APP_DATA_DIR, 'history')
  : path.join(__dirname, '..', '.data', 'history');

const MAX_LIST_PER_USER = 200;   // most-recent N returned to a user
const MAX_LIST_ALL = 1000;       // most-recent N returned to an admin (all users)
const RUN_RETENTION_DAYS = Math.max(1, Number(process.env.HISTORY_RETENTION_DAYS) || 7);
const RUN_RETENTION_MS = RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000; // 7 days default TTL for unstarred runs

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
// Authoritative in-memory index map for Image & GenMedia Arena runs: id -> metadata object
const imageMetaById = new Map();
// Permanent lightweight ledger of all runs ever executed (survives 7-day payload auto-pruning):
// id -> { id, at, user, userKey, userName, kind, callsCount, costUsd }
const archivedMetaById = new Map();
// Permanent lightweight ledger of all Image & GenMedia Arena runs ever executed:
// id -> { id, at, user, userKey, userName, imagesCount, costUsd }
const archivedImageMetaById = new Map();
// Per-user preferences in-memory map: userKey -> { user, taskId, slots, models, savedPrompts, savedPresets, updatedAt }
const prefsByUserKey = new Map();
// Tracks which user keys have already been checked on disk so ensureOwnerLoadedSync is O(1) and never repeats GCS FUSE syscalls
const loadedOwnerKeys = new Set();
// Full payload LRU cache for getRun(id): id -> full record
const fullPayloadCache = new Map();
const MAX_PAYLOAD_CACHE = 300;
let hadPersistedIndexOnBoot = false;
let lastPersistMtimeMs = 0;
let lastPersistSize = 0;
let lastPersistCheckAt = 0;

const SYNTHETIC_TEST_USER_RE = /^(adv_test_user_|adv_other_user_|redeploy_|prune-test-user)/i;

function extractBalancedJsonArray(str, startIdx) {
  if (!str || str[startIdx] !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  const maxEnd = Math.min(str.length, startIdx + 20000);
  for (let i = startIdx; i < maxEnd; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return str.slice(startIdx, i + 1);
      }
    }
  }
  return null;
}

// Recover historical runs that were deleted from `runs` or `image_runs` before `VACUUM`
// by scanning the raw SQLite binary pages and cryptographically verifying `userKey(user) === uKey`.
function recoverDeletedRunsFromSqliteBinary(rawBuf) {
  const textById = new Map();
  const imageById = new Map();
  if (!Buffer.isBuffer(rawBuf) || rawBuf.length < 100) {
    return { textRuns: [], imageRuns: [] };
  }
  const len = rawBuf.length;
  for (let i = 0; i < len - 60; i++) {
    // 6-byte big-endian millisecond timestamp for years 2024..2035 starts with 0x01 (0x018c.. to 0x01ef..)
    if (rawBuf[i] !== 0x01) continue;
    const b1 = rawBuf[i + 1];
    if (b1 < 0x8c || b1 > 0xef) continue;
    if (i < 15) continue;

    // Preceding bytes must be an ASCII run ID (e.g. `mn...-...` or custom ID)
    let idEnd = i;
    let idStart = i - 1;
    while (
      idStart >= 0 &&
      idEnd - idStart <= 64 &&
      ((rawBuf[idStart] >= 0x30 && rawBuf[idStart] <= 0x39) ||
        (rawBuf[idStart] >= 0x61 && rawBuf[idStart] <= 0x7a) ||
        (rawBuf[idStart] >= 0x41 && rawBuf[idStart] <= 0x5a) ||
        rawBuf[idStart] === 0x2d ||
        rawBuf[idStart] === 0x5f)
    ) {
      idStart--;
    }
    idStart++;
    const idLen = idEnd - idStart;
    if (idLen < 8 || idLen > 64) continue;
    const id = rawBuf.toString('latin1', idStart, idEnd);
    if (!safeId(id)) continue;

    const at = rawBuf.readUIntBE(i, 6);
    if (at < 1700000000000 || at > 2100000000000) continue;

    // Immediately after the 6-byte timestamp is `user` followed by 40-char hex `user_key`
    const afterAt = rawBuf.toString('utf8', i + 6, Math.min(len, i + 16000));
    const keyMatch = /^([a-z0-9._+-]+(?:@[a-z0-9.-]+)?)([0-9a-f]{40})/i.exec(afterAt);
    if (!keyMatch) continue;

    let matchedUser = null;
    let matchedKey = null;
    const fullStr = keyMatch[1] + keyMatch[2];
    for (let uLen = 1; uLen <= fullStr.length - 40; uLen++) {
      const candUser = norm(fullStr.slice(0, uLen));
      const candKey = fullStr.slice(uLen, uLen + 40).toLowerCase();
      if (/^[0-9a-f]{40}$/.test(candKey) && userKey(candUser) === candKey) {
        matchedUser = candUser;
        matchedKey = candKey;
        break;
      }
    }
    if (!matchedUser || !matchedKey) continue;
    if (SYNTHETIC_TEST_USER_RE.test(matchedUser)) continue;

    const rest = afterAt.slice(matchedUser.length + 40);
    let userName = matchedUser;
    if (rest.startsWith(matchedUser)) {
      userName = matchedUser;
    }

    const firstBracket = rest.indexOf('[{');
    const arr1Str = firstBracket >= 0 ? extractBalancedJsonArray(rest, firstBracket) : null;
    let arr1 = [];
    let arr2 = [];
    if (arr1Str) {
      try { arr1 = JSON.parse(arr1Str); } catch (_) {}
      const afterArr1 = rest.slice(firstBracket + arr1Str.length);
      const secondBracket = afterArr1.indexOf('[');
      const arr2Str = secondBracket >= 0 && secondBracket <= 8 ? extractBalancedJsonArray(afterArr1, secondBracket) : null;
      if (arr2Str) {
        try { arr2 = JSON.parse(arr2Str); } catch (_) {}
      }
    }

    const summaryArr = (Array.isArray(arr2) && arr2.length > 0) ? arr2 : (Array.isArray(arr1) ? arr1 : []);
    const isImageRun = summaryArr.some((s) => s && (s.hasImage !== undefined || s.imageOutputTokens !== undefined || s.imageVaultRef !== undefined));

    if (isImageRun) {
      let costUsd = 0;
      let imagesCount = 0;
      for (const s of summaryArr) {
        if (s && typeof s.costUsd === 'number' && Number.isFinite(s.costUsd)) costUsd += s.costUsd;
        if (s && !s.error && (s.hasImage || s.imageVaultRef || s.thumbDataUrl)) imagesCount++;
      }
      const prev = imageById.get(id);
      if (!prev || costUsd > prev.costUsd) {
        imageById.set(id, {
          id,
          at,
          user: matchedUser,
          userKey: matchedKey,
          userName,
          imagesCount: imagesCount || summaryArr.length || 1,
          costUsd,
        });
      }
    } else {
      let costUsd = 0;
      for (const s of summaryArr) {
        if (s && typeof s.costUsd === 'number' && Number.isFinite(s.costUsd)) costUsd += s.costUsd;
      }
      const callsCount = Math.max(
        Array.isArray(arr1) ? arr1.length : 0,
        Array.isArray(arr2) ? arr2.length : 0,
        1
      );
      const prefixBeforeJson = firstBracket >= 0 ? rest.slice(0, firstBracket) : rest.slice(0, 200);
      const kind = prefixBeforeJson.includes('single') && !prefixBeforeJson.includes('compare') ? 'single' : 'compare';
      const prev = textById.get(id);
      if (!prev || costUsd > prev.costUsd) {
        textById.set(id, {
          id,
          at,
          user: matchedUser,
          userKey: matchedKey,
          userName,
          kind,
          callsCount,
          costUsd,
        });
      }
    }
  }
  return {
    textRuns: Array.from(textById.values()),
    imageRuns: Array.from(imageById.values()),
  };
}

function metaToArchivedEntry(meta) {
  if (!meta || !meta.id) return null;
  const u = norm(meta.user);
  if (!u) return null;
  let costUsd = 0;
  if (typeof meta.costUsd === 'number' && Number.isFinite(meta.costUsd)) {
    costUsd = meta.costUsd;
  } else if (Array.isArray(meta.summary)) {
    for (const s of meta.summary) {
      if (s && typeof s.costUsd === 'number' && Number.isFinite(s.costUsd)) costUsd += s.costUsd;
    }
  }
  const callsCount = Math.max(
    Number(meta.callsCount) || 0,
    Array.isArray(meta.summary) ? meta.summary.length : 0,
    Array.isArray(meta.models) ? meta.models.length : 0,
    1
  );
  return {
    id: meta.id,
    at: Number(meta.at) || Date.now(),
    user: u,
    userKey: meta.userKey || userKey(u),
    userName: meta.userName || meta.user || u,
    kind: meta.kind === 'single' ? 'single' : 'compare',
    callsCount,
    costUsd,
  };
}

function archivedRowToEntry(r) {
  if (!r || !r.id) return null;
  const u = norm(r.user);
  return {
    id: r.id,
    at: Number(r.at) || 0,
    user: u,
    userKey: r.user_key || userKey(u),
    userName: r.user_name || r.user || u,
    kind: r.kind === 'single' ? 'single' : 'compare',
    callsCount: Math.max(1, Number(r.calls_count) || 1),
    costUsd: Number(r.cost_usd) || 0,
  };
}

function upsertArchivedRunInternal(entry) {
  const clean = metaToArchivedEntry(entry);
  if (!clean || !clean.id) return;
  const existing = archivedMetaById.get(clean.id);
  if (existing && existing.costUsd > clean.costUsd) {
    clean.costUsd = existing.costUsd;
  }
  archivedMetaById.set(clean.id, clean);
  if (stmts && stmts.upsertArchivedRun) {
    try {
      stmts.upsertArchivedRun.run(
        clean.id,
        clean.at,
        clean.user,
        clean.userKey,
        clean.userName,
        clean.kind,
        clean.callsCount,
        clean.costUsd
      );
    } catch (_) {}
  }
}

function imageMetaToArchivedEntry(meta) {
  if (!meta || !meta.id) return null;
  const u = norm(meta.user);
  if (!u) return null;
  let costUsd = 0;
  let imagesCount = 0;
  if (typeof meta.costUsd === 'number' && Number.isFinite(meta.costUsd)) {
    costUsd = meta.costUsd;
  }
  if (typeof meta.imagesCount === 'number' && Number.isFinite(meta.imagesCount)) {
    imagesCount = meta.imagesCount;
  }
  if (Array.isArray(meta.summary)) {
    let sumCost = 0;
    let sumImgs = 0;
    for (const s of meta.summary) {
      if (s && typeof s.costUsd === 'number' && Number.isFinite(s.costUsd)) sumCost += s.costUsd;
      if (s && !s.error && (s.hasImage || s.imageVaultRef || s.thumbDataUrl)) sumImgs++;
    }
    if (costUsd === 0 && sumCost > 0) costUsd = sumCost;
    if (imagesCount === 0 && sumImgs > 0) imagesCount = sumImgs;
  }
  return {
    id: meta.id,
    at: Number(meta.at) || Date.now(),
    user: u,
    userKey: meta.userKey || userKey(u),
    userName: meta.userName || meta.user || u,
    imagesCount: Math.max(0, imagesCount),
    costUsd,
  };
}

function archivedImageRowToEntry(r) {
  if (!r || !r.id) return null;
  const u = norm(r.user);
  return {
    id: r.id,
    at: Number(r.at) || 0,
    user: u,
    userKey: r.user_key || userKey(u),
    userName: r.user_name || r.user || u,
    imagesCount: Math.max(0, Number(r.images_count) || 0),
    costUsd: Number(r.cost_usd) || 0,
  };
}

function upsertArchivedImageRunInternal(entry) {
  const clean = imageMetaToArchivedEntry(entry);
  if (!clean || !clean.id) return;
  const existing = archivedImageMetaById.get(clean.id);
  if (existing && existing.costUsd > clean.costUsd) {
    clean.costUsd = existing.costUsd;
  }
  if (existing && existing.imagesCount > clean.imagesCount) {
    clean.imagesCount = existing.imagesCount;
  }
  archivedImageMetaById.set(clean.id, clean);
  if (stmts && stmts.upsertArchivedImageRun) {
    try {
      stmts.upsertArchivedImageRun.run(
        clean.id,
        clean.at,
        clean.user,
        clean.userKey,
        clean.userName,
        clean.imagesCount,
        clean.costUsd
      );
    } catch (_) {}
  }
}

function promptRowToItem(r) {
  if (!r) return null;
  let attachments = [];
  try { attachments = JSON.parse(r.attachments_json || '[]'); } catch (_) {}
  return {
    id: r.id,
    title: r.title || 'Saved Prompt',
    prompt: typeof r.prompt === 'string' ? r.prompt : '',
    attachments: Array.isArray(attachments) ? attachments : [],
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
  };
}

function presetRowToItem(r) {
  if (!r) return null;
  let slots = [];
  try { slots = JSON.parse(r.slots_json || '[]'); } catch (_) {}
  return {
    id: r.id,
    title: r.title || 'Saved Model Preset',
    slots: Array.isArray(slots) ? slots : [],
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0,
  };
}

function loadUserSavedPromptsFromDb(uKey) {
  if (!stmts || !stmts.listPromptsByUser || !uKey) return [];
  try {
    return stmts.listPromptsByUser.all(uKey).map(promptRowToItem).filter(Boolean).slice(0, MAX_SAVED_PROMPTS);
  } catch (_) {
    return [];
  }
}

function loadUserSavedPresetsFromDb(uKey) {
  if (!stmts || !stmts.listPresetsByUser || !uKey) return [];
  try {
    return stmts.listPresetsByUser.all(uKey).map(presetRowToItem).filter(Boolean).slice(0, MAX_SAVED_PRESETS);
  } catch (_) {
    return [];
  }
}

function syncSavedPromptsTableForUser(uKey, uName, promptsList) {
  if (!stmts || !stmts.upsertPrompt || !uKey) return;
  try {
    const cleanList = Array.isArray(promptsList) ? promptsList.slice(0, MAX_SAVED_PROMPTS) : [];
    const existingRows = stmts.listPromptsByUser.all(uKey);
    const keepIds = new Set(cleanList.map((p) => p && p.id).filter(Boolean));
    for (const r of existingRows) {
      if (r && r.id && !keepIds.has(r.id)) {
        stmts.delPrompt.run(uKey, r.id);
      }
    }
    for (const p of cleanList) {
      if (!p || !p.id) continue;
      stmts.upsertPrompt.run(
        uKey,
        p.id,
        uName || '',
        String(p.title || 'Saved Prompt').slice(0, 120),
        typeof p.prompt === 'string' ? p.prompt : '',
        JSON.stringify(Array.isArray(p.attachments) ? p.attachments : []),
        Number(p.createdAt) || Date.now(),
        Number(p.updatedAt) || Date.now()
      );
    }
  } catch (_) {}
}

function syncSavedPresetsTableForUser(uKey, uName, presetsList) {
  if (!stmts || !stmts.upsertPreset || !uKey) return;
  try {
    const cleanList = Array.isArray(presetsList) ? presetsList.slice(0, MAX_SAVED_PRESETS) : [];
    const existingRows = stmts.listPresetsByUser.all(uKey);
    const keepIds = new Set(cleanList.map((p) => p && p.id).filter(Boolean));
    for (const r of existingRows) {
      if (r && r.id && !keepIds.has(r.id)) {
        stmts.delPreset.run(uKey, r.id);
      }
    }
    for (const p of cleanList) {
      if (!p || !p.id) continue;
      stmts.upsertPreset.run(
        uKey,
        p.id,
        uName || '',
        String(p.title || 'Saved Model Preset').slice(0, 100),
        JSON.stringify(Array.isArray(p.slots) ? p.slots : []),
        Number(p.createdAt) || Date.now(),
        Number(p.updatedAt) || Date.now()
      );
    }
  } catch (_) {}
}

function initSqlite() {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    // Always seed local /tmp SQLite from the persistent `/data/history/history.sqlite` volume
    // on startup using readFileSync + writeFileSync (avoids copy_file_range FUSE issues and
    // ensures stale /tmp WAL files can never shadow the persistent DB).
    if (DatabaseSync) {
      let bootRawSqliteBuf = null;
      if (fs.existsSync(PERSIST_SQLITE_PATH)) {
        try {
          const st = fs.statSync(PERSIST_SQLITE_PATH);
          if (st.size >= 100) {
            try { fs.unlinkSync(LOCAL_SQLITE_PATH + '-wal'); } catch (_) {}
            try { fs.unlinkSync(LOCAL_SQLITE_PATH + '-shm'); } catch (_) {}
            const buf = fs.readFileSync(PERSIST_SQLITE_PATH);
            bootRawSqliteBuf = buf;
            fs.writeFileSync(LOCAL_SQLITE_PATH, buf);
            lastPersistMtimeMs = st.mtimeMs;
            lastPersistSize = st.size;
            hadPersistedIndexOnBoot = true;
          }
        } catch (copyErr) {
          console.warn('[history] Warning copying persisted SQLite to /tmp:', (copyErr && copyErr.message) || copyErr);
        }
      }
      // Recover any runs previously deleted by 7-day auto-pruning from unvacuumed B-tree pages
      // BEFORE executing CREATE TABLE (which could allocate from the B-tree freelist).
      const recoveredFromBinary = bootRawSqliteBuf
        ? recoverDeletedRunsFromSqliteBinary(bootRawSqliteBuf)
        : { textRuns: [], imageRuns: [] };

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
          summary_json TEXT NOT NULL,
          starred INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_runs_at ON runs(at DESC);
        CREATE INDEX IF NOT EXISTS idx_runs_user_at ON runs(user_key, at DESC);
        CREATE TABLE IF NOT EXISTS archived_runs (
          id TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          user TEXT NOT NULL,
          user_key TEXT NOT NULL,
          user_name TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'compare',
          calls_count INTEGER NOT NULL DEFAULT 1,
          cost_usd REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_archived_runs_user_at ON archived_runs(user_key, at DESC);
        CREATE TABLE IF NOT EXISTS archived_image_runs (
          id TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          user TEXT NOT NULL,
          user_key TEXT NOT NULL,
          user_name TEXT NOT NULL,
          images_count INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_archived_image_runs_user_at ON archived_image_runs(user_key, at DESC);
        CREATE TABLE IF NOT EXISTS user_prefs (
          user_key TEXT PRIMARY KEY,
          user TEXT NOT NULL,
          task_id TEXT,
          slots_json TEXT,
          saved_prompts_json TEXT,
          saved_presets_json TEXT,
          updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS user_saved_prompts (
          user_key TEXT NOT NULL,
          id TEXT NOT NULL,
          user TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          attachments_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_key, id)
        );
        CREATE INDEX IF NOT EXISTS idx_saved_prompts_user_updated
          ON user_saved_prompts(user_key, updated_at DESC);
        CREATE TABLE IF NOT EXISTS user_saved_presets (
          user_key TEXT NOT NULL,
          id TEXT NOT NULL,
          user TEXT NOT NULL,
          title TEXT NOT NULL,
          slots_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_key, id)
        );
        CREATE INDEX IF NOT EXISTS idx_saved_presets_user_updated
          ON user_saved_presets(user_key, updated_at DESC);
        CREATE TABLE IF NOT EXISTS image_runs (
          id TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          user TEXT NOT NULL,
          user_key TEXT NOT NULL,
          user_name TEXT NOT NULL,
          pack_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          image_size TEXT NOT NULL,
          aspect_ratio TEXT NOT NULL,
          slots_json TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          starred INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_image_runs_at ON image_runs(at DESC);
        CREATE INDEX IF NOT EXISTS idx_image_runs_user_at ON image_runs(user_key, at DESC);
      `);
      try { sqliteDb.exec(`ALTER TABLE user_prefs ADD COLUMN saved_prompts_json TEXT;`); } catch (_) {}
      try { sqliteDb.exec(`ALTER TABLE user_prefs ADD COLUMN saved_presets_json TEXT;`); } catch (_) {}
      try { sqliteDb.exec(`ALTER TABLE runs ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`); } catch (_) {}
      try { sqliteDb.exec(`ALTER TABLE image_runs ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`); } catch (_) {}

      // Bind per-user vault attachment metadata table (`user_vault_files`) to this SQLite DB
      // using synchronous snapshot flush so new attachment records immediately persist to /data.
      vault.bindSqlite(sqliteDb, flushSnapshotSync);

      let needsPersistFlush = false;
      // Purge any legacy multi-MB remembered prompt/attachments columns in existing SQLite DBs
      try {
        const res = sqliteDb.prepare(`UPDATE user_prefs SET prompt = '', attachments_json = '[]', remembered = 0 WHERE prompt != '' OR (attachments_json IS NOT NULL AND attachments_json != '[]')`).run();
        if (res && res.changes > 0) {
          try { sqliteDb.exec('VACUUM;'); } catch (_) {}
          needsPersistFlush = true;
        }
      } catch (_) {}

      stmts = {
        upsert: sqliteDb.prepare(`
          INSERT INTO runs (id, at, user, user_key, user_name, task_id, title, kind, models_json, summary_json, starred)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            at = excluded.at,
            user_name = excluded.user_name,
            title = excluded.title,
            models_json = excluded.models_json,
            summary_json = excluded.summary_json,
            starred = excluded.starred
        `),
        setStarred: sqliteDb.prepare(`UPDATE runs SET starred = ? WHERE id = ?`),
        del: sqliteDb.prepare(`DELETE FROM runs WHERE id = ?`),
        all: sqliteDb.prepare(`SELECT * FROM runs ORDER BY at DESC`),
        upsertArchivedRun: sqliteDb.prepare(`
          INSERT INTO archived_runs (id, at, user, user_key, user_name, kind, calls_count, cost_usd)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            at = excluded.at,
            user_name = excluded.user_name,
            kind = excluded.kind,
            calls_count = MAX(archived_runs.calls_count, excluded.calls_count),
            cost_usd = MAX(archived_runs.cost_usd, excluded.cost_usd)
        `),
        delArchivedRun: sqliteDb.prepare(`DELETE FROM archived_runs WHERE id = ?`),
        allArchivedRuns: sqliteDb.prepare(`SELECT * FROM archived_runs ORDER BY at DESC`),
        upsertArchivedImageRun: sqliteDb.prepare(`
          INSERT INTO archived_image_runs (id, at, user, user_key, user_name, images_count, cost_usd)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            at = excluded.at,
            user_name = excluded.user_name,
            images_count = MAX(archived_image_runs.images_count, excluded.images_count),
            cost_usd = MAX(archived_image_runs.cost_usd, excluded.cost_usd)
        `),
        delArchivedImageRun: sqliteDb.prepare(`DELETE FROM archived_image_runs WHERE id = ?`),
        allArchivedImageRuns: sqliteDb.prepare(`SELECT * FROM archived_image_runs ORDER BY at DESC`),
        upsertPref: sqliteDb.prepare(`
          INSERT INTO user_prefs (user_key, user, task_id, slots_json, saved_prompts_json, saved_presets_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_key) DO UPDATE SET
            user = excluded.user,
            task_id = excluded.task_id,
            slots_json = excluded.slots_json,
            saved_prompts_json = excluded.saved_prompts_json,
            saved_presets_json = excluded.saved_presets_json,
            updated_at = excluded.updated_at
        `),
        allPrefs: sqliteDb.prepare(`SELECT user_key, user, task_id, slots_json, saved_prompts_json, saved_presets_json, updated_at FROM user_prefs`),
        upsertPrompt: sqliteDb.prepare(`
          INSERT INTO user_saved_prompts (user_key, id, user, title, prompt, attachments_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_key, id) DO UPDATE SET
            user = excluded.user,
            title = excluded.title,
            prompt = excluded.prompt,
            attachments_json = excluded.attachments_json,
            updated_at = excluded.updated_at
        `),
        delPrompt: sqliteDb.prepare(`DELETE FROM user_saved_prompts WHERE user_key = ? AND id = ?`),
        listPromptsByUser: sqliteDb.prepare(`SELECT * FROM user_saved_prompts WHERE user_key = ? ORDER BY updated_at DESC`),
        allPrompts: sqliteDb.prepare(`SELECT * FROM user_saved_prompts ORDER BY updated_at DESC`),
        upsertPreset: sqliteDb.prepare(`
          INSERT INTO user_saved_presets (user_key, id, user, title, slots_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_key, id) DO UPDATE SET
            user = excluded.user,
            title = excluded.title,
            slots_json = excluded.slots_json,
            updated_at = excluded.updated_at
        `),
        delPreset: sqliteDb.prepare(`DELETE FROM user_saved_presets WHERE user_key = ? AND id = ?`),
        listPresetsByUser: sqliteDb.prepare(`SELECT * FROM user_saved_presets WHERE user_key = ? ORDER BY updated_at DESC`),
        allPresets: sqliteDb.prepare(`SELECT * FROM user_saved_presets ORDER BY updated_at DESC`),
        upsertImage: sqliteDb.prepare(`
          INSERT INTO image_runs (id, at, user, user_key, user_name, pack_id, scenario_id, title, prompt, image_size, aspect_ratio, slots_json, summary_json, starred)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            at = excluded.at,
            user_name = excluded.user_name,
            title = excluded.title,
            prompt = excluded.prompt,
            image_size = excluded.image_size,
            aspect_ratio = excluded.aspect_ratio,
            slots_json = excluded.slots_json,
            summary_json = excluded.summary_json,
            starred = excluded.starred
        `),
        setImageStarred: sqliteDb.prepare(`UPDATE image_runs SET starred = ? WHERE id = ?`),
        delImage: sqliteDb.prepare(`DELETE FROM image_runs WHERE id = ?`),
        allImage: sqliteDb.prepare(`SELECT * FROM image_runs ORDER BY at DESC`),
      };

      // Load existing archived_runs and archived_image_runs ledger rows
      try {
        const archRows = stmts.allArchivedRuns.all();
        for (const r of archRows) {
          const entry = archivedRowToEntry(r);
          if (entry && entry.id) archivedMetaById.set(entry.id, entry);
        }
      } catch (_) {}

      try {
        const archImgRows = stmts.allArchivedImageRuns.all();
        for (const r of archImgRows) {
          const entry = archivedImageRowToEntry(r);
          if (entry && entry.id) archivedImageMetaById.set(entry.id, entry);
        }
      } catch (_) {}

      const rows = stmts.all.all();
      for (const r of rows) {
        const m = rowToMeta(r);
        metaById.set(r.id, m);
        if (!archivedMetaById.has(r.id)) {
          upsertArchivedRunInternal(m);
          needsPersistFlush = true;
        }
      }
      if (rows.length > 0) hadPersistedIndexOnBoot = true;

      try {
        const imgRows = stmts.allImage.all();
        for (const r of imgRows) {
          const m = imageRowToMeta(r);
          imageMetaById.set(r.id, m);
          if (!archivedImageMetaById.has(r.id)) {
            upsertArchivedImageRunInternal(m);
            needsPersistFlush = true;
          }
        }
        if (imgRows.length > 0) hadPersistedIndexOnBoot = true;
      } catch (_) {}

      // Insert any pruned runs recovered from unvacuumed SQLite B-tree pages
      let recoveredTextCount = 0;
      for (const recRun of recoveredFromBinary.textRuns || []) {
        if (recRun && recRun.id && !archivedMetaById.has(recRun.id)) {
          upsertArchivedRunInternal(recRun);
          recoveredTextCount++;
          needsPersistFlush = true;
        }
      }
      let recoveredImageCount = 0;
      for (const recImg of recoveredFromBinary.imageRuns || []) {
        if (recImg && recImg.id && !archivedImageMetaById.has(recImg.id)) {
          upsertArchivedImageRunInternal(recImg);
          recoveredImageCount++;
          needsPersistFlush = true;
        }
      }
      if (recoveredTextCount > 0 || recoveredImageCount > 0) {
        console.log(`[history] Recovered ${recoveredTextCount} pruned text runs and ${recoveredImageCount} pruned image runs from SQLite binary pages into lifetime usage ledger.`);
      }

      try {
        const prefRows = stmts.allPrefs.all();
        const allPromptRows = stmts.allPrompts.all();
        const allPresetRows = stmts.allPresets.all();

        const promptsByUserKey = new Map();
        const userByKey = new Map();
        for (const r of allPromptRows) {
          if (!r || !r.user_key) continue;
          if (r.user) userByKey.set(r.user_key, norm(r.user));
          const list = promptsByUserKey.get(r.user_key) || [];
          const item = promptRowToItem(r);
          if (item) list.push(item);
          promptsByUserKey.set(r.user_key, list);
        }

        const presetsByUserKey = new Map();
        for (const r of allPresetRows) {
          if (!r || !r.user_key) continue;
          if (r.user) userByKey.set(r.user_key, norm(r.user));
          const list = presetsByUserKey.get(r.user_key) || [];
          const item = presetRowToItem(r);
          if (item) list.push(item);
          presetsByUserKey.set(r.user_key, list);
        }

        const handledKeys = new Set();
        for (const pr of prefRows) {
          const rowUser = norm(pr.user);
          if (!rowUser || userKey(rowUser) !== pr.user_key) continue;
          handledKeys.add(pr.user_key);
          let slots = null;
          let rawSavedPrompts = [];
          let rawSavedPresets = [];
          try { slots = JSON.parse(pr.slots_json || 'null'); } catch (_) {}
          try { rawSavedPrompts = JSON.parse(pr.saved_prompts_json || '[]'); } catch (_) {}
          try { rawSavedPresets = JSON.parse(pr.saved_presets_json || '[]'); } catch (_) {}

          // Merge dedicated table rows (`user_saved_prompts`) with any legacy `user_prefs.saved_prompts_json` rows
          const tablePrompts = promptsByUserKey.get(pr.user_key) || [];
          const mergedRawPrompts = [...tablePrompts, ...(Array.isArray(rawSavedPrompts) ? rawSavedPrompts : [])];
          const { list: savedPrompts, hadBlobs } = extractAndStripSavedPrompts(pr.user_key, mergedRawPrompts);

          const tablePresets = presetsByUserKey.get(pr.user_key) || [];
          const mergedRawPresets = [...tablePresets, ...(Array.isArray(rawSavedPresets) ? rawSavedPresets : [])];
          const savedPresets = sanitizeSavedPresetsList(mergedRawPresets);

          const models = Array.isArray(slots) ? slots.map((s) => ({ catalogId: s.catalogId, effort: s.effort })) : null;
          const prefEntry = {
            user: rowUser,
            taskId: pr.task_id || 'custom',
            slots,
            models,
            savedPrompts,
            savedPresets,
            updatedAt: Number(pr.updated_at) || 0,
          };
          prefsByUserKey.set(pr.user_key, prefEntry);

          if (tablePrompts.length !== savedPrompts.length || hadBlobs) {
            syncSavedPromptsTableForUser(pr.user_key, rowUser, savedPrompts);
            needsPersistFlush = true;
          }
          if (tablePresets.length !== savedPresets.length) {
            syncSavedPresetsTableForUser(pr.user_key, rowUser, savedPresets);
            needsPersistFlush = true;
          }
          if (hadBlobs) {
            try {
              stmts.upsertPref.run(
                pr.user_key,
                rowUser,
                prefEntry.taskId,
                JSON.stringify(slots || []),
                JSON.stringify(savedPrompts),
                JSON.stringify(savedPresets),
                prefEntry.updatedAt || Date.now()
              );
            } catch (_) {}
          }
        }

        // Also hydrate any user keys present in `user_saved_prompts` / `user_saved_presets` even if missing in `user_prefs`
        for (const [uKey, uName] of userByKey.entries()) {
          if (handledKeys.has(uKey) || !uName || userKey(uName) !== uKey) continue;
          const savedPrompts = extractAndStripSavedPrompts(uKey, promptsByUserKey.get(uKey) || []).list;
          const savedPresets = sanitizeSavedPresetsList(presetsByUserKey.get(uKey) || []);
          const prefEntry = {
            user: uName,
            taskId: 'custom',
            slots: null,
            models: null,
            savedPrompts,
            savedPresets,
            updatedAt: Date.now(),
          };
          prefsByUserKey.set(uKey, prefEntry);
          needsPersistFlush = true;
        }

        // If any real user in `user_prefs` has saved `slots` from a past run (`saveRun()` writes `slots` + `updatedAt`)
        // whose run row was pruned and overwritten before `archived_runs` existed, seed a baseline archived run
        // so their historical user and run participation is preserved.
        const usersWithArchivedRuns = new Set();
        for (const ar of archivedMetaById.values()) {
          if (ar && ar.userKey) usersWithArchivedRuns.add(ar.userKey);
        }
        for (const [uKey, pref] of prefsByUserKey.entries()) {
          if (!pref || !pref.user || SYNTHETIC_TEST_USER_RE.test(pref.user)) continue;
          if (usersWithArchivedRuns.has(uKey)) continue;
          const hasRunSlots = Array.isArray(pref.slots) && pref.slots.length > 0 && Number(pref.updatedAt) > 0;
          if (hasRunSlots) {
            upsertArchivedRunInternal({
              id: `hist-seed-${uKey.slice(0, 16)}`,
              at: Number(pref.updatedAt) || Date.now(),
              user: pref.user,
              userKey: uKey,
              userName: pref.user,
              kind: 'compare',
              callsCount: pref.slots.length,
              costUsd: 0,
            });
            needsPersistFlush = true;
          }
        }

        if (needsPersistFlush) {
          flushSnapshotSync();
        }
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[history] SQLite init fallback to JSON index:', (e && e.message) || e);
    sqliteDb = null;
    stmts = null;
  }

  // Migrate any legacy PERSIST_INDEX_JSON rows into SQLite once and remove the redundant index.json
  try {
    if (fs.existsSync(PERSIST_INDEX_JSON)) {
      const arr = JSON.parse(fs.readFileSync(PERSIST_INDEX_JSON, 'utf8'));
      if (Array.isArray(arr)) {
        if (arr.length > 0) hadPersistedIndexOnBoot = true;
        let importedLegacyIdx = 0;
        for (const m of arr) {
          if (m && m.id && !metaById.has(m.id)) {
            upsertMetaInternal(m, false);
            importedLegacyIdx++;
          }
        }
        if (importedLegacyIdx > 0) flushSnapshotSync();
      }
      if (sqliteDb && fs.existsSync(PERSIST_SQLITE_PATH)) {
        fsp.unlink(PERSIST_INDEX_JSON).catch(() => {});
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
    starred: Boolean(r.starred),
  };
}

function recordToMeta(rec) {
  const u = norm(rec.user);
  const rawSummary = Array.isArray(rec.summary) ? rec.summary.slice() : [];
  if (rawSummary.length > 0 && Array.isArray(rec.attachments) && rec.attachments.length > 0) {
    const first = rawSummary[0];
    if (first && typeof first === 'object' && !Array.isArray(first.inputVaultRefs)) {
      const inputVaultRefs = rec.attachments
        .map((a) => a && (a.vaultRef || a.sha256))
        .filter((v) => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v));
      if (inputVaultRefs.length > 0) {
        rawSummary[0] = { ...first, inputVaultRefs };
      }
    }
  }
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
    summary: rawSummary,
    starred: Boolean(rec.starred),
  };
}

function upsertMetaInternal(meta, persistDisk = true) {
  if (!meta || !meta.id) return;
  meta.starred = Boolean(meta.starred);
  metaById.set(meta.id, meta);
  upsertArchivedRunInternal(meta);
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
        JSON.stringify(meta.summary || []),
        meta.starred ? 1 : 0
      );
    } catch (_) {}
  }
  if (persistDisk) flushSnapshotSync();
}

function imageRowToMeta(r) {
  let slots = [], summary = [];
  try { slots = JSON.parse(r.slots_json || '[]'); } catch (_) {}
  try { summary = JSON.parse(r.summary_json || '[]'); } catch (_) {}
  return {
    id: r.id,
    arena: 'image',
    at: Number(r.at) || 0,
    user: r.user,
    userKey: r.user_key,
    userName: r.user_name || r.user,
    packId: r.pack_id || 'custom',
    scenarioId: r.scenario_id || 'custom',
    title: r.title || 'Image Arena Run',
    prompt: r.prompt || '',
    imageSize: r.image_size || '1K',
    aspectRatio: r.aspect_ratio || '16:9',
    slots,
    summary,
    starred: Boolean(r.starred),
  };
}

function imageRecordToMeta(rec) {
  const u = norm(rec.user);
  return {
    id: rec.id,
    arena: 'image',
    at: Number(rec.at) || Date.now(),
    user: u,
    userKey: rec.userKey || userKey(u),
    userName: rec.userName || rec.user || u,
    packId: rec.packId || 'custom',
    scenarioId: rec.scenarioId || 'custom',
    title: rec.title || rec.scenarioTitle || 'Image Arena Run',
    prompt: typeof rec.prompt === 'string' ? rec.prompt : '',
    imageSize: rec.imageSize || '1K',
    aspectRatio: rec.aspectRatio || '16:9',
    slots: Array.isArray(rec.slots) ? rec.slots : [],
    summary: Array.isArray(rec.summary) ? rec.summary : [],
    starred: Boolean(rec.starred),
  };
}

function upsertImageMetaInternal(meta, persistDisk = true) {
  if (!meta || !meta.id) return;
  meta.starred = Boolean(meta.starred);
  imageMetaById.set(meta.id, meta);
  upsertArchivedImageRunInternal(meta);
  if (stmts && stmts.upsertImage) {
    try {
      stmts.upsertImage.run(
        meta.id,
        meta.at,
        meta.user,
        meta.userKey || userKey(meta.user),
        meta.userName || meta.user,
        meta.packId || 'custom',
        meta.scenarioId || 'custom',
        meta.title || 'Image Arena Run',
        meta.prompt || '',
        meta.imageSize || '1K',
        meta.aspectRatio || '16:9',
        JSON.stringify(meta.slots || []),
        JSON.stringify(meta.summary || []),
        meta.starred ? 1 : 0
      );
    } catch (_) {}
  }
  if (persistDisk) flushSnapshotSync();
}

// Synchronously checkpoint WAL and flush `/tmp` SQLite DB to `/data/history/history.sqlite`.
// Uses Buffer write + atomic rename with direct writeFileSync fallback (GCS FUSE safe).
// Executed BEFORE HTTP responses return on every mutation so Cloud Run CPU throttling or
// rolling container redeployments can never lose a single saved prompt, preset, or preference.
function flushSnapshotSync() {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    const suffix = `.tmp.${process.pid}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    if (sqliteDb && fs.existsSync(LOCAL_SQLITE_PATH)) {
      try { sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) {}
      const buf = fs.readFileSync(LOCAL_SQLITE_PATH);
      if (!buf || buf.length < 100) return false;
      const tmpSqlite = PERSIST_SQLITE_PATH + suffix;
      try {
        fs.writeFileSync(tmpSqlite, buf);
        fs.renameSync(tmpSqlite, PERSIST_SQLITE_PATH);
      } catch (_) {
        // GCS FUSE fallback when atomic rename over an existing object is rejected
        fs.writeFileSync(PERSIST_SQLITE_PATH, buf);
        try { fs.unlinkSync(tmpSqlite); } catch (_) {}
      }
      try {
        const st = fs.statSync(PERSIST_SQLITE_PATH);
        lastPersistMtimeMs = st.mtimeMs;
        lastPersistSize = st.size;
      } catch (_) {}
      return true;
    } else {
      const allMeta = Array.from(metaById.values()).sort((a, b) => b.at - a.at);
      const payload = JSON.stringify(allMeta);
      const tmpIdx = PERSIST_INDEX_JSON + suffix;
      try {
        fs.writeFileSync(tmpIdx, payload);
        fs.renameSync(tmpIdx, PERSIST_INDEX_JSON);
      } catch (_) {
        fs.writeFileSync(PERSIST_INDEX_JSON, payload);
        try { fs.unlinkSync(tmpIdx); } catch (_) {}
      }
      return true;
    }
  } catch (e) {
    console.warn('[history] flushSnapshotSync error:', (e && e.message) || e);
    return false;
  }
}

// If another container instance (e.g. during a Cloud Run rolling deployment overlap)
// wrote a newer `/data/history/history.sqlite` to the shared `/data` volume after our
// container booted, merge its rows into our local SQLite DB before reading/writing.
function syncFromPersistSqliteIfNewer(force = false) {
  if (!DatabaseSync || !sqliteDb || !stmts) return;
  const now = Date.now();
  if (!force && now - lastPersistCheckAt < 500) return;
  lastPersistCheckAt = now;
  try {
    if (!fs.existsSync(PERSIST_SQLITE_PATH)) return;
    const st = fs.statSync(PERSIST_SQLITE_PATH);
    if (st.size < 100) return;
    if (lastPersistMtimeMs > 0 && st.mtimeMs <= lastPersistMtimeMs + 5 && st.size === lastPersistSize) {
      return;
    }
    const tmpMerge = path.join(os.tmpdir(), `llm-compare-merge-${process.pid}-${now}-${crypto.randomBytes(3).toString('hex')}.sqlite`);
    try {
      const buf = fs.readFileSync(PERSIST_SQLITE_PATH);
      fs.writeFileSync(tmpMerge, buf);
      const extDb = new DatabaseSync(tmpMerge);
      try {
        // 1. Merge runs, image_runs, archived_runs & archived_image_runs
        try {
          const extArchRuns = extDb.prepare(`SELECT * FROM archived_runs`).all();
          for (const r of extArchRuns) {
            if (r && r.id && !archivedMetaById.has(r.id)) {
              upsertArchivedRunInternal(archivedRowToEntry(r));
            }
          }
        } catch (_) {}
        try {
          const extArchImgRuns = extDb.prepare(`SELECT * FROM archived_image_runs`).all();
          for (const r of extArchImgRuns) {
            if (r && r.id && !archivedImageMetaById.has(r.id)) {
              upsertArchivedImageRunInternal(archivedImageRowToEntry(r));
            }
          }
        } catch (_) {}
        try {
          const extRuns = extDb.prepare(`SELECT * FROM runs`).all();
          for (const r of extRuns) {
            if (r && r.id && !metaById.has(r.id)) {
              upsertMetaInternal(rowToMeta(r), false);
            }
          }
        } catch (_) {}
        try {
          const extImgRuns = extDb.prepare(`SELECT * FROM image_runs`).all();
          for (const r of extImgRuns) {
            if (r && r.id && !imageMetaById.has(r.id)) {
              upsertImageMetaInternal(imageRowToMeta(r), false);
            }
          }
        } catch (_) {}

        // 2. Merge user_saved_prompts & user_saved_presets
        const extPromptsByUser = new Map();
        const extPresetsByUser = new Map();
        const extUserByKey = new Map();
        try {
          const pRows = extDb.prepare(`SELECT * FROM user_saved_prompts ORDER BY updated_at DESC`).all();
          for (const r of pRows) {
            if (!r || !r.user_key || !r.id) continue;
            if (r.user) extUserByKey.set(r.user_key, norm(r.user));
            const list = extPromptsByUser.get(r.user_key) || [];
            const item = promptRowToItem(r);
            if (item) list.push(item);
            extPromptsByUser.set(r.user_key, list);
          }
        } catch (_) {}

        try {
          const mpRows = extDb.prepare(`SELECT * FROM user_saved_presets ORDER BY updated_at DESC`).all();
          for (const r of mpRows) {
            if (!r || !r.user_key || !r.id) continue;
            if (r.user) extUserByKey.set(r.user_key, norm(r.user));
            const list = extPresetsByUser.get(r.user_key) || [];
            const item = presetRowToItem(r);
            if (item) list.push(item);
            extPresetsByUser.set(r.user_key, list);
          }
        } catch (_) {}

        // 3. Merge user_prefs
        try {
          const prefRows = extDb.prepare(`SELECT * FROM user_prefs`).all();
          for (const pr of prefRows) {
            const rowUser = norm(pr.user);
            if (!rowUser || userKey(rowUser) !== pr.user_key) continue;
            extUserByKey.set(pr.user_key, rowUser);
            const cur = prefsByUserKey.get(pr.user_key);
            const prUpdated = Number(pr.updated_at) || 0;
            if (!cur || prUpdated >= (cur.updatedAt || 0)) {
              let slots = null;
              let rawSavedPrompts = [];
              let rawSavedPresets = [];
              try { slots = JSON.parse(pr.slots_json || 'null'); } catch (_) {}
              try { rawSavedPrompts = JSON.parse(pr.saved_prompts_json || '[]'); } catch (_) {}
              try { rawSavedPresets = JSON.parse(pr.saved_presets_json || '[]'); } catch (_) {}
              const mergedPrompts = extractAndStripSavedPrompts(pr.user_key, [
                ...(extPromptsByUser.get(pr.user_key) || []),
                ...(Array.isArray(rawSavedPrompts) ? rawSavedPrompts : []),
                ...((cur && cur.savedPrompts) || []),
              ]).list;
              const mergedPresets = sanitizeSavedPresetsList([
                ...(extPresetsByUser.get(pr.user_key) || []),
                ...(Array.isArray(rawSavedPresets) ? rawSavedPresets : []),
                ...((cur && cur.savedPresets) || []),
              ]);
              const models = Array.isArray(slots) ? slots.map((s) => ({ catalogId: s.catalogId, effort: s.effort })) : null;
              const nextEntry = {
                user: rowUser,
                taskId: pr.task_id || (cur && cur.taskId) || 'custom',
                slots: slots || (cur && cur.slots) || null,
                models: models || (cur && cur.models) || null,
                savedPrompts: mergedPrompts,
                savedPresets: mergedPresets,
                updatedAt: Math.max(prUpdated, (cur && cur.updatedAt) || 0),
              };
              prefsByUserKey.set(pr.user_key, nextEntry);
              syncSavedPromptsTableForUser(pr.user_key, rowUser, mergedPrompts);
              syncSavedPresetsTableForUser(pr.user_key, rowUser, mergedPresets);
              stmts.upsertPref.run(
                pr.user_key,
                rowUser,
                nextEntry.taskId,
                JSON.stringify(nextEntry.slots || []),
                JSON.stringify(mergedPrompts),
                JSON.stringify(mergedPresets),
                nextEntry.updatedAt
              );
            }
          }
        } catch (_) {}

        // 4. Merge user_vault_files
        if (typeof vault.mergeFromExternalDb === 'function') {
          vault.mergeFromExternalDb(extDb);
        }
      } finally {
        try { extDb.close(); } catch (_) {}
      }
    } finally {
      try { fs.unlinkSync(tmpMerge); } catch (_) {}
      try { fs.unlinkSync(tmpMerge + '-wal'); } catch (_) {}
      try { fs.unlinkSync(tmpMerge + '-shm'); } catch (_) {}
    }
    lastPersistMtimeMs = st.mtimeMs;
    lastPersistSize = st.size;
  } catch (_) {}
}

let persistTimer = null;
let snapshotChain = Promise.resolve();
function schedulePersistSnapshot() {
  flushSnapshotSync();
}

function flushSnapshotAsync() {
  snapshotChain = snapshotChain.then(async () => {
    flushSnapshotSync();
  });
  return snapshotChain;
}

let backfillStarted = false;
function scheduleBackgroundBackfill() {
  if (backfillStarted) return;
  backfillStarted = true;
  const delayMs = (hadPersistedIndexOnBoot || metaById.size > 0) ? 15000 : 250;
  const t = setTimeout(async () => {
    try {
      const entries = await fsp.readdir(BASE_DIR).catch(() => []);
      const ownerDirs = entries.filter((d) => /^[0-9a-f]{40}$/.test(d));
      let imported = 0;
      for (const k of ownerDirs) {
        const dir = path.join(BASE_DIR, k);
        const dirEntries = await fsp.readdir(dir).catch(() => []);
        if (dirEntries.includes('prefs.json') && !prefsByUserKey.has(k)) {
          try { ensureOwnerLoadedSync(k); } catch (_) {}
        }
        const files = dirEntries.filter((f) => f.endsWith('.json') && f !== 'prefs.json');
        // Process in batches of 8 concurrent async reads so we never block the event loop
        for (let i = 0; i < files.length; i += 8) {
          const batch = files.slice(i, i + 8);
          await Promise.all(batch.map(async (f) => {
            const id = f.slice(0, -5);
            if (metaById.has(id) || imageMetaById.has(id)) return;
            try {
              const raw = await fsp.readFile(path.join(dir, f), 'utf8');
              const rec = JSON.parse(raw);
              if (rec && rec.id) {
                rec.userKey = k;
                if (rec.arena === 'image') {
                  upsertImageMetaInternal(imageRecordToMeta(rec), false);
                } else {
                  upsertMetaInternal(recordToMeta(rec), false);
                }
                imported++;
              }
            } catch (_) {}
          }));
        }
      }
      if (imported > 0) {
        console.log(`[history] Backfilled ${imported} existing runs into SQLite index.`);
        flushSnapshotSync();
      }
    } catch (_) {}
  }, delayMs);
  if (t.unref) t.unref();
}

// Synchronous one-time migration check for a specific owner key ONLY on first access per key.
function ensureOwnerLoadedSync(key) {
  if (!key || loadedOwnerKeys.has(key)) return;
  loadedOwnerKeys.add(key);

  if (!prefsByUserKey.has(key)) {
    const pfile = path.join(BASE_DIR, key, 'prefs.json');
    try {
      if (fs.existsSync(pfile)) {
        const raw = fs.readFileSync(pfile, 'utf8');
        const p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          const uName = norm(p.user || '');
          const { list: strippedPrompts } = extractAndStripSavedPrompts(key, p.savedPrompts);
          const cleanPresets = sanitizeSavedPresetsList(p.savedPresets);
          const cleanPref = {
            user: uName,
            taskId: p.taskId || 'custom',
            slots: Array.isArray(p.slots) ? p.slots : null,
            models: Array.isArray(p.models) ? p.models : null,
            savedPrompts: strippedPrompts,
            savedPresets: cleanPresets,
            updatedAt: Number(p.updatedAt) || Date.now(),
          };
          prefsByUserKey.set(key, cleanPref);
          if (stmts && stmts.upsertPref) {
            try {
              syncSavedPromptsTableForUser(key, uName, strippedPrompts);
              syncSavedPresetsTableForUser(key, uName, cleanPresets);
              stmts.upsertPref.run(
                key,
                cleanPref.user,
                cleanPref.taskId,
                JSON.stringify(cleanPref.slots || []),
                JSON.stringify(cleanPref.savedPrompts || []),
                JSON.stringify(cleanPref.savedPresets || []),
                cleanPref.updatedAt
              );
              const flushed = flushSnapshotSync();
              if (flushed && fs.existsSync(PERSIST_SQLITE_PATH)) {
                fsp.unlink(pfile).catch(() => {});
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  // If the SQLite index snapshot already loaded on boot or this user already has entries, skip synchronous disk scan
  if (hadPersistedIndexOnBoot) return;
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
      if (metaById.has(id) || imageMetaById.has(id)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (rec && rec.id) {
          rec.userKey = key;
          if (rec.arena === 'image') {
            upsertImageMetaInternal(imageRecordToMeta(rec), false);
          } else {
            upsertMetaInternal(recordToMeta(rec), false);
          }
          fullPayloadCache.set(rec.id, rec);
          added++;
        }
      } catch (_) {}
    }
    if (added > 0) flushSnapshotSync();
  } catch (_) {}
}

// Derive the compact per-slot summary shown in lists / usage (no code/reasoning).
function summarize(models, results, attachments) {
  const byslot = {};
  (results || []).forEach((r) => { if (r && r.slot != null) byslot[r.slot] = r; });
  const inputVaultRefs = (Array.isArray(attachments) ? attachments : [])
    .map((a) => a && (a.vaultRef || a.sha256))
    .filter((v) => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v));
  return (models || []).map((m, idx) => {
    const r = byslot[m.slot] || {};
    const out = {
      slot: m.slot, label: m.label, model: m.model,
      error: r.error || null,
      correctness: r.correctness, solved: r.solved, total: r.total,
      answerTokens: Math.max(0, (r.completionTokens || 0) - (r.reasoningTokens || 0)),
      costUsd: r.costUsd, wallMs: r.wallMs,
    };
    if (idx === 0 && inputVaultRefs.length > 0) {
      out.inputVaultRefs = inputVaultRefs;
    }
    return out;
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
    starred: Boolean(meta.starred),
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
async function saveRun({ id: passedId, user, userName, task, customPrompt, models, results, kind, judge, starred }) {
  try {
    maybePruneExpiredRuns();
    const id = safeId(passedId) || newId();
    const at = Date.now();
    const u = norm(user);
    const uKey = userKey(u);
    const existingMeta = metaById.get(id);
    const isStarred = starred != null ? Boolean(starred) : Boolean(existingMeta && existingMeta.starred);
    const promptText = (typeof customPrompt === 'string' && customPrompt.trim())
      ? customPrompt
      : ((task && typeof task.prompt === 'string') ? task.prompt : '');

    const rawAttachments = (task && Array.isArray(task.attachments)) ? task.attachments : [];
    // Store raw binary attachments in the user's vault (/data/vault/<userKey>/<sha256>.bin)
    // and store only compact ~180-byte vault pointers inside <runId>.json on disk!
    const attachments = rawAttachments.map((a) => {
      const ptr = vault.storeAttachmentInVaultSync(uKey, a);
      return ptr || {
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
        vaultRef: a.sha256 || a.vaultRef || null,
        estimatedTokens: a.estimatedTokens || undefined,
      };
    });

    const record = {
      v: 1, id, at,
      user: u, userKey: uKey, userName: userName || user,
      taskId: (task && task.id) || 'unknown',
      title: (task && task.title) || (task && task.id) || 'Run',
      prompt: promptText,
      kind: kind === 'single' ? 'single' : 'compare',
      starred: isStarred,
      attachments,
      models: (models || []).map((m) => ({
        slot: m.slot, catalogId: m.catalogId, label: m.label,
        provider: m.provider, model: m.model, publisher: m.publisher, price: m.price,
        effort: m.effort || null,
      })),
      slots: (models || []).map((m) => ({ slot: m.slot, data: (results || []).find((r) => r && r.slot === m.slot) || null })),
      summary: summarize(models, results, attachments),
      judge: judge || null,
    };

    // 1. Update SQLite & in-memory metadata index immediately
    const meta = recordToMeta(record);
    upsertMetaInternal(meta, true);
    cachePayload(id, record);

    // Update user preferences for active task and models selection on the slots
    const cur = getUserPreferences(u);
    const runSlots = (kind !== 'single' && Array.isArray(models) && models.length)
      ? models
          .filter((m) => m && m.catalogId)
          .map((m) => ({
            slot: m.slot || null,
            catalogId: m.catalogId,
            effort: m.effort || null,
          }))
      : ((cur && cur.slots) || null);

    saveUserPreferences(u, {
      taskId: (task && task.id) || (cur && cur.taskId) || 'custom',
      slots: runSlots,
    });

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

// Derive remembered model/task preferences from historical runs if no explicit preferences exist
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

  const slots = (pick.models || [])
    .filter((m) => m && m.catalogId)
    .map((m) => ({ slot: m.slot || null, catalogId: m.catalogId, effort: m.effort || null }));

  return {
    user: u,
    taskId: pick.taskId || 'custom',
    slots: slots.length ? slots : null,
    models: slots.map((s) => ({ catalogId: s.catalogId, effort: s.effort })),
    savedPrompts: [],
    savedPresets: [],
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
    kind: (a && a.kind) ? String(a.kind).slice(0, 40) : undefined,
    size: Number(a && a.size) || 0,
    isEmpty: Boolean(a && a.isEmpty),
    pageCount: Number(a && a.pageCount) || 0,
    warning: (a && a.warning) ? String(a.warning).slice(0, 200) : null,
    optBadge: (a && a.optBadge) ? String(a.optBadge).slice(0, 200) : null,
    sha1: (a && a.sha1) ? String(a.sha1).slice(0, 64) : null,
    sha256: (a && (a.sha256 || a.vaultRef)) ? String(a.sha256 || a.vaultRef).slice(0, 64) : null,
    vaultRef: (a && (a.vaultRef || a.sha256)) ? String(a.vaultRef || a.sha256).slice(0, 64) : null,
    data: (a && typeof a.data === 'string') ? a.data : '',
    textContent: (a && typeof a.textContent === 'string') ? a.textContent.slice(0, 2500000) : '',
    claudeDataBase64: (a && typeof a.claudeDataBase64 === 'string') ? a.claudeDataBase64 : undefined,
    claudeMimeType: (a && a.claudeMimeType) ? String(a.claudeMimeType) : undefined,
    fitDataBase64: (a && typeof a.fitDataBase64 === 'string') ? a.fitDataBase64 : undefined,
    fitMimeType: (a && a.fitMimeType) ? String(a.fitMimeType) : undefined,
    estimatedTokens: Number(a && a.estimatedTokens) || undefined,
    hasBlob: Boolean(a && (a.hasBlob || a.vaultRef || a.sha256 || a.data || a.textContent)),
  }));
}

// Convert attachments into compact ~180-byte Per-User Vault pointers (storing any
// raw binary bytes into `/data/vault/<userKey>/<sha256>.bin`) so `GET /api/config`,
// SQLite `user_prefs`, and `prefs.json` never contain base64 strings!
function persistAttachmentsToUserVaultSync(uKey, list) {
  if (!Array.isArray(list)) return { pointers: [], hadInlineBlobs: false };
  const pointers = [];
  let hadInlineBlobs = false;
  for (const a of list.slice(0, 10)) {
    if (!a || typeof a !== 'object') continue;
    if ((a.data && a.data.length > 0) || (a.textContent && a.textContent.length > 0) || a.claudeDataBase64 || a.fitDataBase64) {
      hadInlineBlobs = true;
    }
    if (uKey) {
      const ptr = vault.storeAttachmentInVaultSync(uKey, a);
      if (ptr) {
        pointers.push(ptr);
        continue;
      }
    }
    pointers.push({
      name: String(a.name || 'file').slice(0, 200),
      mimeType: String(a.mimeType || 'application/octet-stream').slice(0, 100),
      kind: a.kind ? String(a.kind).slice(0, 40) : undefined,
      size: Number(a.size) || 0,
      isEmpty: Boolean(a.isEmpty),
      pageCount: Number(a.pageCount) || 0,
      warning: a.warning ? String(a.warning).slice(0, 200) : null,
      optBadge: a.optBadge ? String(a.optBadge).slice(0, 200) : null,
      sha1: a.sha1 ? String(a.sha1).slice(0, 64) : null,
      sha256: (a.sha256 || a.vaultRef) ? String(a.sha256 || a.vaultRef).slice(0, 64) : null,
      vaultRef: (a.vaultRef || a.sha256) ? String(a.vaultRef || a.sha256).slice(0, 64) : null,
      estimatedTokens: Number(a.estimatedTokens) || undefined,
      hasBlob: Boolean(a.hasBlob || a.vaultRef || a.sha256 || a.data || a.textContent),
    });
  }
  return { pointers, hadInlineBlobs };
}

function extractAndStripSavedPrompts(uKey, rawList) {
  if (!Array.isArray(rawList)) return { list: [], hadBlobs: false };
  const out = [];
  const seenIds = new Set();
  let hadBlobs = false;
  for (const raw of rawList) {
    const clean = sanitizeSavedPromptItem(raw, true);
    if (!clean || seenIds.has(clean.id)) continue;
    seenIds.add(clean.id);

    // If a legacy `sp_<id>.json` file exists in `/data/history/<uKey>/`, migrate its blobs into the binary vault too
    let rawAtts = clean.attachments;
    if (uKey) {
      const legacySpPath = path.join(BASE_DIR, uKey, `sp_${clean.id}.json`);
      try {
        if (fs.existsSync(legacySpPath)) {
          const parsed = JSON.parse(fs.readFileSync(legacySpPath, 'utf8'));
          if (parsed && Array.isArray(parsed.attachments) && parsed.attachments.length) {
            rawAtts = sanitizeAttachmentsArray(parsed.attachments);
          }
          fs.unlinkSync(legacySpPath);
          hadBlobs = true;
        }
      } catch (_) {}
    }

    const { pointers, hadInlineBlobs } = persistAttachmentsToUserVaultSync(uKey, rawAtts);
    if (hadInlineBlobs) hadBlobs = true;

    out.push({
      ...clean,
      attachments: pointers,
    });
    if (out.length >= MAX_SAVED_PROMPTS) break;
  }
  return { list: out, hadBlobs };
}

function sanitizeSavedPromptItem(item, keepBlobs = false, uKey = '') {
  if (!item || typeof item !== 'object') return null;
  const prompt = typeof item.prompt === 'string' ? item.prompt.slice(0, 500000) : '';
  const fullAttachments = sanitizeAttachmentsArray(item.attachments);
  if (!prompt.trim() && !fullAttachments.length) return null;
  const rawId = typeof item.id === 'string' ? item.id.trim() : '';
  const id = /^[a-zA-Z0-9_-]{4,64}$/.test(rawId)
    ? rawId
    : `sp_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const rawTitle = typeof item.title === 'string' ? item.title.trim() : '';
  const fallbackTitle = prompt.trim()
    ? prompt.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ').slice(0, 64)
    : (fullAttachments.length ? `Saved Files (${fullAttachments.map((a) => a.name).join(', ').slice(0, 48)})` : 'Saved Prompt');
  const title = (rawTitle || fallbackTitle || 'Saved Prompt').slice(0, 120);
  const now = Date.now();
  return {
    id,
    title,
    prompt,
    attachments: keepBlobs ? fullAttachments : persistAttachmentsToUserVaultSync(uKey, fullAttachments).pointers,
    createdAt: Number(item.createdAt) || now,
    updatedAt: Number(item.updatedAt) || now,
  };
}

function sanitizeSavedPromptsList(list, uKey) {
  return extractAndStripSavedPrompts(uKey || '', list).list;
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

// Get preferences for a specific user (taskId, slots, models, savedPrompts, savedPresets)
// Strictly isolated by normalized username + SHA-256 userKey; returns a defensive copy.
function getUserPreferences(username) {
  const u = norm(username);
  if (!u) return { taskId: 'custom', slots: null, models: null, savedPrompts: [], savedPresets: [] };
  syncFromPersistSqliteIfNewer(false);
  const key = userKey(u);
  ensureOwnerLoadedSync(key);
  let p = prefsByUserKey.get(key);
  // Privacy guard: verify cached entry belongs to this exact normalized user
  if (p && p.user && norm(p.user) !== u) {
    prefsByUserKey.delete(key);
    p = null;
  }
  if (!p) {
    const dbPrompts = loadUserSavedPromptsFromDb(key);
    const dbPresets = loadUserSavedPresetsFromDb(key);
    p = derivePrefsFromHistory(u, key);
    if (p) {
      p.savedPrompts = dbPrompts;
      p.savedPresets = dbPresets;
      prefsByUserKey.set(key, p);
    } else {
      // Memoize default empty prefs in memory so repeat calls in the same request / session never hit disk
      p = { user: u, taskId: 'custom', slots: null, models: null, savedPrompts: dbPrompts, savedPresets: dbPresets, updatedAt: 0 };
      prefsByUserKey.set(key, p);
    }
  }
  if (!Array.isArray(p.savedPrompts)) p.savedPrompts = [];
  if (!Array.isArray(p.savedPresets)) p.savedPresets = [];
  return {
    user: u,
    taskId: p.taskId || 'custom',
    slots: Array.isArray(p.slots) ? p.slots.map((s) => ({ ...s })) : null,
    models: Array.isArray(p.models) ? p.models.map((m) => ({ ...m })) : null,
    savedPrompts: p.savedPrompts.slice(),
    savedPresets: p.savedPresets.slice(),
    updatedAt: p.updatedAt || 0,
  };
}

// Per-user promise chain so rapid concurrent saveUserPreferences calls
// always serialize cleanly and write the latest prefsByUserKey snapshot.
const prefWriteChains = new Map();

// Save preferences for a specific user
function saveUserPreferences(username, newPrefs) {
  const u = norm(username);
  if (!u) return null;
  syncFromPersistSqliteIfNewer(true);
  const key = userKey(u);
  const current = getUserPreferences(u) || {};
  const hasExplicitPrompts = Boolean(newPrefs && Array.isArray(newPrefs.savedPrompts));
  const hasExplicitPresets = Boolean(newPrefs && Array.isArray(newPrefs.savedPresets));

  const savedPrompts = hasExplicitPrompts
    ? sanitizeSavedPromptsList(newPrefs.savedPrompts, key)
    : (Array.isArray(current.savedPrompts) && current.savedPrompts.length
        ? current.savedPrompts
        : loadUserSavedPromptsFromDb(key));

  const savedPresets = hasExplicitPresets
    ? sanitizeSavedPresetsList(newPrefs.savedPresets)
    : (Array.isArray(current.savedPresets) && current.savedPresets.length
        ? current.savedPresets
        : loadUserSavedPresetsFromDb(key));

  const taskId = (newPrefs && typeof newPrefs.taskId === 'string')
    ? newPrefs.taskId.slice(0, 100)
    : (current.taskId || 'custom');

  let slots = null;
  if (newPrefs && Array.isArray(newPrefs.slots)) {
    slots = newPrefs.slots
      .slice(0, 6)
      .filter((s) => s && (s.catalogId || s.id))
      .map((s) => ({
        slot: s.slot || null,
        catalogId: s.catalogId || s.id,
        effort: s.effort || null,
      }));
  } else if (newPrefs && Array.isArray(newPrefs.models)) {
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
    taskId,
    slots,
    models,
    savedPrompts,
    savedPresets,
    updatedAt,
  };

  prefsByUserKey.set(key, prefObj);

  if (stmts && stmts.upsertPref) {
    try {
      if (hasExplicitPrompts) {
        syncSavedPromptsTableForUser(key, u, savedPrompts);
      }
      if (hasExplicitPresets) {
        syncSavedPresetsTableForUser(key, u, savedPresets);
      }
      stmts.upsertPref.run(
        key,
        u,
        taskId,
        JSON.stringify(slots || []),
        JSON.stringify(savedPrompts || []),
        JSON.stringify(savedPresets || []),
        updatedAt
      );
      flushSnapshotSync();
    } catch (_) {}
    return prefObj;
  }

  // Fallback JSON persistence only when built-in node:sqlite is unavailable
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
// Returns lightweight metadata + prompt text + ~180-byte Per-User Vault pointers.
function listSavedPrompts(username) {
  const p = getUserPreferences(username);
  return Array.isArray(p && p.savedPrompts) ? p.savedPrompts.slice() : [];
}

// Fetch a single saved prompt with its attachment blobs hydrated from the user's binary vault.
function getSavedPrompt(username, promptId) {
  const u = norm(username);
  if (!u) return null;
  const uKey = userKey(u);
  const sid = String(promptId || '').trim().replace(/^saved:/, '');
  if (!sid) return null;
  const list = listSavedPrompts(u);
  const item = list.find((x) => x && x.id === sid);
  if (!item) return null;
  if (!Array.isArray(item.attachments) || !item.attachments.length) {
    return { ...item, attachments: [] };
  }
  const hydratedAtts = item.attachments.map((a) => {
    const v = vault.readAttachmentFromVaultSync(uKey, a);
    return v ? { ...a, ...v } : a;
  });
  return {
    ...item,
    attachments: hydratedAtts,
  };
}

// Save or update a named prompt in the user's saved prompts library.
// Raw attachment binaries are stored AS-IS in `/data/vault/<userKey>/<sha256>.bin`,
// while `user_saved_prompts` in SQLite stores the prompt text and compact ~180-byte vault pointers.
function saveUserPrompt(username, item) {
  const u = norm(username);
  if (!u) throw new Error('User is required.');
  syncFromPersistSqliteIfNewer(true);
  const uKey = userKey(u);
  const cleanFull = sanitizeSavedPromptItem(item, true, uKey);
  if (!cleanFull) throw new Error('Please enter a prompt or attach a file before saving.');
  const existing = listSavedPrompts(u).slice();
  const now = Date.now();
  const matchIdx = existing.findIndex((x) =>
    (item && item.id && x.id === cleanFull.id) || (item && !item.id && x.title.toLowerCase() === cleanFull.title.toLowerCase())
  );
  let targetId;
  let createdAt = now;
  if (matchIdx >= 0) {
    const prev = existing[matchIdx];
    targetId = prev.id;
    createdAt = prev.createdAt || now;
    existing.splice(matchIdx, 1);
  } else {
    // Always mint a fresh server-side ID when creating a new entry so users can never collide or spoof IDs
    targetId = `sp_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  }
  const { pointers } = persistAttachmentsToUserVaultSync(uKey, cleanFull.attachments || []);

  const metaEntry = {
    ...cleanFull,
    id: targetId,
    attachments: pointers,
    createdAt,
    updatedAt: now,
  };
  const updatedList = [metaEntry, ...existing].slice(0, MAX_SAVED_PROMPTS);
  if (stmts && stmts.upsertPrompt) {
    try {
      stmts.upsertPrompt.run(
        uKey,
        metaEntry.id,
        u,
        metaEntry.title,
        metaEntry.prompt,
        JSON.stringify(metaEntry.attachments || []),
        metaEntry.createdAt,
        metaEntry.updatedAt
      );
    } catch (_) {}
  }
  saveUserPreferences(u, { savedPrompts: updatedList });
  return { ok: true, saved: metaEntry, prompt: metaEntry, savedPrompts: updatedList };
}

// Delete a saved prompt by ID from the user's library.
function deleteUserPrompt(username, promptId) {
  const u = norm(username);
  if (!u) return { ok: false, removed: false, savedPrompts: [] };
  syncFromPersistSqliteIfNewer(true);
  const uKey = userKey(u);
  const sid = String(promptId || '').trim();
  const existing = listSavedPrompts(u);
  const targetPrompt = existing.find((x) => x && x.id === sid);
  const candidateHashes = extractRunVaultHashes(targetPrompt);
  const filtered = existing.filter((x) => x && x.id !== sid);
  const removed = filtered.length !== existing.length;
  if (removed) {
    if (stmts && stmts.delPrompt) {
      try { stmts.delPrompt.run(uKey, sid); } catch (_) {}
    }
    saveUserPreferences(u, { savedPrompts: filtered });
    gcOrphanedVaultRefsForUser(uKey, candidateHashes, true);
  }
  return { ok: true, removed, savedPrompts: filtered };
}

// List a user's saved model presets library (newest / most recently updated first).
function listSavedPresets(username) {
  const p = getUserPreferences(username);
  return Array.isArray(p && p.savedPresets) ? p.savedPresets.slice() : [];
}

// Save or update a named model preset in the user's saved presets library (`user_saved_presets` SQLite table).
function saveUserPreset(username, item) {
  const u = norm(username);
  if (!u) throw new Error('User is required.');
  syncFromPersistSqliteIfNewer(true);
  const uKey = userKey(u);
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
  if (stmts && stmts.upsertPreset) {
    try {
      stmts.upsertPreset.run(
        uKey,
        savedEntry.id,
        u,
        savedEntry.title,
        JSON.stringify(savedEntry.slots || []),
        savedEntry.createdAt,
        savedEntry.updatedAt
      );
    } catch (_) {}
  }
  saveUserPreferences(u, { savedPresets: updatedList });
  return { ok: true, saved: savedEntry, preset: savedEntry, savedPresets: updatedList };
}

// Delete a saved model preset by ID from the user's library.
function deleteUserPreset(username, presetId) {
  const u = norm(username);
  if (!u) return { ok: false, removed: false, savedPresets: [] };
  syncFromPersistSqliteIfNewer(true);
  const uKey = userKey(u);
  const sid = String(presetId || '').trim();
  const existing = listSavedPresets(u);
  const filtered = existing.filter((x) => x && x.id !== sid);
  const removed = filtered.length !== existing.length;
  if (removed) {
    if (stmts && stmts.delPreset) {
      try { stmts.delPreset.run(uKey, sid); } catch (_) {}
    }
    saveUserPreferences(u, { savedPresets: filtered });
  }
  return { ok: true, removed, savedPresets: filtered };
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
  maybePruneExpiredRuns();
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
  maybePruneExpiredRuns();
  const all = [];
  for (const m of metaById.values()) {
    all.push(listItem(m));
  }
  all.sort((a, b) => b.at - a.at);
  return all.slice(0, MAX_LIST_ALL);
}

const MAX_INLINE_RESTORE_BYTES = 10 * 1024 * 1024; // Hydrate attachments up to 10 MB inline on single-run Restore

function hydrateRunAttachmentsForReturn(rec, fp) {
  if (!rec || !Array.isArray(rec.attachments) || !rec.attachments.length) return rec;
  const ownerKey = rec.userKey || userKey(rec.user);
  let migratedLegacyInline = false;
  const hydrated = rec.attachments.map((a) => {
    if (!a || typeof a !== 'object') return a;
    // If an older <runId>.json on disk still had inline base64 data, migrate it to the user's binary vault
    if (ownerKey && ((a.data && a.data.length > 0) || (a.textContent && a.textContent.length > 0))) {
      const ptr = vault.storeAttachmentInVaultSync(ownerKey, a);
      if (ptr) {
        migratedLegacyInline = true;
        if ((Number(ptr.size) || 0) <= MAX_INLINE_RESTORE_BYTES) {
          return { ...ptr, data: a.data || '', textContent: a.textContent || '' };
        }
        return ptr;
      }
    }
    // If stored as a vault pointer, hydrate data/textContent from the binary vault (including cross-user admin restores)
    if ((a.vaultRef || a.sha256 || a.sha1) && !a.data) {
      const fromVault = vault.readAttachmentFromVaultSync(ownerKey, a, { fallbackAnyOwner: true });
      if (fromVault) {
        if ((Number(fromVault.size || a.size) || 0) <= MAX_INLINE_RESTORE_BYTES) {
          return {
            ...a,
            sha1: a.sha1 || fromVault.sha1 || null,
            sha256: a.sha256 || fromVault.sha256 || null,
            vaultRef: a.vaultRef || fromVault.vaultRef || fromVault.sha256 || null,
            data: fromVault.data || '',
            textContent: fromVault.textContent || a.textContent || '',
            hasBlob: true,
            ...(fromVault.claudeDataBase64 ? { claudeDataBase64: fromVault.claudeDataBase64, claudeMimeType: fromVault.claudeMimeType || 'image/webp' } : {}),
            ...(fromVault.fitDataBase64 ? { fitDataBase64: fromVault.fitDataBase64, fitMimeType: fromVault.fitMimeType || 'image/jpeg' } : {}),
          };
        }
        return {
          ...a,
          sha1: a.sha1 || fromVault.sha1 || null,
          sha256: a.sha256 || fromVault.sha256 || null,
          vaultRef: a.vaultRef || fromVault.vaultRef || fromVault.sha256 || null,
          hasBlob: true,
        };
      }
      // Binary file is missing on disk (e.g. legacy run created before binary vault or pruned blob):
      // clear dead thumbnailUrl so the browser renders a clean file badge instead of a broken <img> icon.
      return {
        ...a,
        thumbnailUrl: null,
        previewUrl: null,
        hasBlob: false,
        blobMissing: true,
        warning: a.warning || 'Original file binary expired — re-attach file to preview or re-run',
      };
    }
    return a;
  });

  if (migratedLegacyInline && fp) {
    const diskRec = {
      ...rec,
      attachments: rec.attachments.map((a) => vault.storeAttachmentInVaultSync(ownerKey, a) || a),
    };
    fsp.writeFile(fp, JSON.stringify(diskRec)).catch(() => {});
  }
  return { ...rec, attachments: hydrated };
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
            if (isAdmin || userKey(fresh.user) === myKey) return hydrateRunAttachmentsForReturn(fresh, fp);
          }
        }
      }
    } catch (_) {}
    if (isAdmin || userKey(cached.user) === myKey) return hydrateRunAttachmentsForReturn(cached, fp);
    return null;
  }

  // Check SQLite/memory index for exact owner directory so we never scan all directories!
  const meta = metaById.get(sid);
  if (meta) {
    if (!isAdmin && meta.userKey !== myKey) return null;
    const fp = path.join(BASE_DIR, meta.userKey, sid + '.json');
    try {
      const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (rec) { cachePayload(sid, rec); return hydrateRunAttachmentsForReturn(rec, fp); }
    } catch (_) {}
  }

  // Fallback direct file lookup
  const mine = path.join(BASE_DIR, myKey, sid + '.json');
  try {
    if (fs.existsSync(mine)) {
      const own = JSON.parse(fs.readFileSync(mine, 'utf8'));
      if (own) { cachePayload(sid, own); return hydrateRunAttachmentsForReturn(own, mine); }
    }
  } catch (_) {}

  if (!isAdmin) return null;
  try {
    for (const k of fs.readdirSync(BASE_DIR)) {
      if (!/^[0-9a-f]{40}$/.test(k)) continue;
      const fp = path.join(BASE_DIR, k, sid + '.json');
      if (fs.existsSync(fp)) {
        const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (rec) { cachePayload(sid, rec); return hydrateRunAttachmentsForReturn(rec, fp); }
      }
    }
  } catch (_) {}
  return null;
}

// Extract all 64-char sha256 vault references from a run record or metadata object.
function extractRunVaultHashes(recOrMeta) {
  const hashes = new Set();
  if (!recOrMeta || typeof recOrMeta !== 'object') return hashes;
  const addRef = (val) => {
    if (typeof val === 'string' && /^[0-9a-f]{64}$/i.test(val.trim())) {
      hashes.add(val.trim().toLowerCase());
    }
  };
  if (Array.isArray(recOrMeta.vaultRefs)) {
    for (const v of recOrMeta.vaultRefs) addRef(v);
  }
  if (Array.isArray(recOrMeta.attachments)) {
    for (const a of recOrMeta.attachments) {
      if (a && typeof a === 'object') {
        addRef(a.sha256);
        addRef(a.vaultRef);
      }
    }
  }
  for (const arr of [recOrMeta.results, recOrMeta.summary]) {
    if (Array.isArray(arr)) {
      for (const r of arr) {
        if (r && typeof r === 'object') {
          addRef(r.imageVaultRef);
          addRef(r.thoughtVaultRef);
          addRef(r.sha256);
          addRef(r.vaultRef);
          if (Array.isArray(r.inputVaultRefs)) {
            for (const v of r.inputVaultRefs) addRef(v);
          }
        }
      }
    }
  }
  return hashes;
}

// Collect all vault sha256 hashes still referenced by ANY surviving saved prompt, text run,
// or image run belonging to `uKey`. Used for reference-counted binary vault garbage collection.
// Strictly uses in-memory / local SQLite metadata (`metaById`, `imageMetaById`, `fullPayloadCache`,
// `prefsByUserKey`) so it never performs O(N) synchronous file reads across GCS FUSE.
function collectReferencedVaultHashesForUser(uKey) {
  const referenced = new Set();
  if (!uKey || !/^[0-9a-f]{40}$/i.test(uKey)) return referenced;
  const addRef = (val) => {
    if (typeof val === 'string' && /^[0-9a-f]{64}$/i.test(val.trim())) {
      referenced.add(val.trim().toLowerCase());
    }
  };

  // 1. Saved Prompts in memory & SQLite
  const pref = prefsByUserKey.get(uKey);
  const promptLists = [];
  if (pref && Array.isArray(pref.savedPrompts)) promptLists.push(pref.savedPrompts);
  if (stmts && stmts.listPromptsByUser) {
    try {
      promptLists.push(stmts.listPromptsByUser.all(uKey).map(promptRowToItem).filter(Boolean));
    } catch (_) {}
  }
  for (const list of promptLists) {
    for (const p of list) {
      if (p && Array.isArray(p.attachments)) {
        for (const a of p.attachments) {
          if (a && typeof a === 'object') {
            addRef(a.sha256);
            addRef(a.vaultRef);
          }
        }
      }
    }
  }

  // 2. Surviving Image Arena runs for `uKey`
  for (const m of imageMetaById.values()) {
    if (m.userKey !== uKey) continue;
    for (const h of extractRunVaultHashes(m)) referenced.add(h);
    const cached = fullPayloadCache.get(m.id);
    if (cached) {
      for (const h of extractRunVaultHashes(cached)) referenced.add(h);
    }
  }

  // 3. Surviving Text/Code/Agent runs for `uKey`
  for (const m of metaById.values()) {
    if (m.userKey !== uKey) continue;
    for (const h of extractRunVaultHashes(m)) referenced.add(h);
    const cached = fullPayloadCache.get(m.id);
    if (cached) {
      for (const h of extractRunVaultHashes(cached)) referenced.add(h);
    }
  }

  return referenced;
}

// Garbage-collect any vault binaries in `candidateHashes` that are no longer referenced by `uKey`.
function gcOrphanedVaultRefsForUser(uKey, candidateHashes, triggerSnapshot = false) {
  if (!uKey || !candidateHashes || candidateHashes.size === 0) {
    return { freedFiles: 0, freedBytes: 0 };
  }
  const stillReferenced = collectReferencedVaultHashesForUser(uKey);
  let freedFiles = 0;
  let freedBytes = 0;
  for (const sha256 of candidateHashes) {
    if (!stillReferenced.has(sha256)) {
      const res = vault.deleteVaultEntrySync(uKey, sha256, false);
      if (res && res.removed) {
        freedFiles++;
        freedBytes += Number(res.bytesFreed) || 0;
      }
    }
  }
  if (freedFiles > 0 && triggerSnapshot) {
    flushSnapshotSync();
  }
  return { freedFiles, freedBytes };
}

// Delete one run from SQLite index, memory, disk, and garbage-collect unreferenced vault files.
// When `preserveLifetimeStats === true` (used by 7-day auto-pruning), the heavy `.json` payload,
// binary vault blobs, and active 7-day `runs` row are removed while the lightweight `archived_runs`
// ledger row is kept so cumulative user and run counts are never lost.
function deleteRun(id, { username, isAdmin, stats, deferFlush = false, deferGc = false, asyncUnlink = false, preserveLifetimeStats = false } = {}) {
  const sid = safeId(id);
  if (!sid) return false;
  const myKey = userKey(username);
  const meta = metaById.get(sid);
  const arch = archivedMetaById.get(sid);
  if (meta && !isAdmin && meta.userKey !== myKey) return false;
  if (!meta && arch && !isAdmin && arch.userKey !== myKey) return false;

  if (preserveLifetimeStats && meta) {
    upsertArchivedRunInternal(meta);
  }

  const ownerKey = (meta && meta.userKey) || (arch && arch.userKey) || myKey;
  const candidateHashes = extractRunVaultHashes(meta);
  const cached = fullPayloadCache.get(sid);
  if (cached) {
    for (const h of extractRunVaultHashes(cached)) candidateHashes.add(h);
  }

  const candidates = [];
  if (meta && meta.userKey) {
    candidates.push(path.join(BASE_DIR, meta.userKey, sid + '.json'));
  } else {
    candidates.push(path.join(BASE_DIR, myKey, sid + '.json'));
    if (isAdmin) {
      try {
        for (const k of fs.readdirSync(BASE_DIR)) {
          if (/^[0-9a-f]{40}$/.test(k)) candidates.push(path.join(BASE_DIR, k, sid + '.json'));
        }
      } catch (_) {}
    }
  }

  let removed = false;
  for (const fp of new Set(candidates)) {
    if (asyncUnlink) {
      fsp.unlink(fp).catch(() => {});
      removed = true;
    } else {
      try {
        if (fs.existsSync(fp)) {
          try {
            const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
            for (const h of extractRunVaultHashes(rec)) candidateHashes.add(h);
          } catch (_) {}
          fs.unlinkSync(fp);
          removed = true;
        }
      } catch (_) {}
    }
  }

  if (metaById.has(sid)) {
    metaById.delete(sid);
    removed = true;
  }
  fullPayloadCache.delete(sid);
  if (stmts) {
    try { stmts.del.run(sid); } catch (_) {}
  }
  if (!preserveLifetimeStats) {
    if (archivedMetaById.has(sid)) {
      archivedMetaById.delete(sid);
      removed = true;
    }
    if (stmts && stmts.delArchivedRun) {
      try { stmts.delArchivedRun.run(sid); } catch (_) {}
    }
  }
  if (removed) {
    if (deferGc && stats && stats.byUserHashes instanceof Map) {
      if (ownerKey && candidateHashes.size > 0) {
        const set = stats.byUserHashes.get(ownerKey) || new Set();
        for (const h of candidateHashes) set.add(h);
        stats.byUserHashes.set(ownerKey, set);
      }
    } else {
      const gc = gcOrphanedVaultRefsForUser(ownerKey, candidateHashes, false);
      if (stats && gc) {
        stats.vaultFilesRemoved = (stats.vaultFilesRemoved || 0) + (gc.freedFiles || 0);
        stats.vaultBytesFreed = (stats.vaultBytesFreed || 0) + (gc.freedBytes || 0);
      }
    }
    if (!deferFlush) {
      schedulePersistSnapshot();
    }
  }
  return removed;
}

// Star or unstar a Text/Code/Agent run so it is exempt from the 7-day auto-prune.
function setRunStarred(id, starred, { username, isAdmin }) {
  syncFromPersistSqliteIfNewer(false);
  const sid = safeId(id);
  if (!sid) return null;
  const myKey = userKey(username);
  const meta = metaById.get(sid);
  if (!meta) return null;
  if (!isAdmin && meta.userKey !== myKey) return null;

  const nextStarred = Boolean(starred);
  meta.starred = nextStarred;
  if (stmts && stmts.setStarred) {
    try { stmts.setStarred.run(nextStarred ? 1 : 0, sid); } catch (_) {}
  }

  const fp = path.join(BASE_DIR, meta.userKey, `${sid}.json`);
  try {
    let rec = fullPayloadCache.get(sid);
    if (!rec && fs.existsSync(fp)) {
      rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
    if (rec && typeof rec === 'object') {
      rec.starred = nextStarred;
      cachePayload(sid, rec);
      if (fs.existsSync(fp)) {
        fs.writeFileSync(fp, JSON.stringify(rec));
      }
    }
  } catch (_) {}

  flushSnapshotSync();
  return { ok: true, id: sid, starred: nextStarred };
}

// Instant (<0.2ms) Admin at-a-glance usage summary computed directly from the SQLite/memory index.
// Combines active 7-day runs (`metaById`) with the permanent lifetime ledger (`archivedMetaById`,
// deduplicated by run `id`) so 7-day payload auto-pruning never resets cumulative user counts,
// `runsToday`, `totalRuns`, or `costUsd`.
// Includes per-user and global counts of saved custom prompts (`savedPrompts`) and saved model presets (`savedPresets`)
// while keeping the actual prompt text and file contents strictly private to each user.
function usageSummary() {
  syncFromPersistSqliteIfNewer(false);
  maybePruneExpiredRuns();
  const startOfDay = (() => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); })();
  const byUser = new Map();
  const countedRunIds = new Set();
  let totalRuns = 0;
  let activeRuns = 0;
  let runsToday = 0;
  let totalStarredRuns = 0;
  let totalCostUsd = 0;

  // 1. Count all active (unpruned 7-day + starred) runs first
  for (const rec of metaById.values()) {
    if (!rec || !rec.id) continue;
    countedRunIds.add(rec.id);
    totalRuns++;
    activeRuns++;
    const today = rec.at >= startOfDay;
    if (today) runsToday++;
    if (rec.starred) totalStarredRuns++;
    const uKeyName = norm(rec.user);
    const u = byUser.get(uKeyName) || {
      user: uKeyName,
      userName: rec.userName || rec.user || uKeyName,
      runs: 0,
      activeRuns: 0,
      runsToday: 0,
      starredRuns: 0,
      lastAt: 0,
      costUsd: 0,
      savedPrompts: 0,
      savedPresets: 0,
    };
    u.runs++;
    u.activeRuns++;
    if (today) u.runsToday++;
    if (rec.starred) u.starredRuns++;
    if (rec.at > u.lastAt) {
      u.lastAt = rec.at;
      u.userName = rec.userName || rec.user || uKeyName;
    }
    (rec.summary || []).forEach((s) => {
      if (typeof s.costUsd === 'number' && Number.isFinite(s.costUsd)) {
        u.costUsd += s.costUsd;
        totalCostUsd += s.costUsd;
      }
    });
    byUser.set(uKeyName, u);
  }

  // 2. Include all pruned historical runs from `archivedMetaById` (skipping any ID already counted above)
  for (const arch of archivedMetaById.values()) {
    if (!arch || !arch.id || countedRunIds.has(arch.id)) continue;
    countedRunIds.add(arch.id);
    totalRuns++;
    const today = arch.at >= startOfDay;
    if (today) runsToday++;
    const uKeyName = norm(arch.user);
    const u = byUser.get(uKeyName) || {
      user: uKeyName,
      userName: arch.userName || arch.user || uKeyName,
      runs: 0,
      activeRuns: 0,
      runsToday: 0,
      starredRuns: 0,
      lastAt: 0,
      costUsd: 0,
      savedPrompts: 0,
      savedPresets: 0,
    };
    u.runs++;
    if (today) u.runsToday++;
    if (arch.at > u.lastAt) {
      u.lastAt = arch.at;
      u.userName = arch.userName || arch.user || uKeyName;
    }
    if (typeof arch.costUsd === 'number' && Number.isFinite(arch.costUsd)) {
      u.costUsd += arch.costUsd;
      totalCostUsd += arch.costUsd;
    }
    byUser.set(uKeyName, u);
  }

  // 3. Merge saved prompts, saved presets, and any real user with recorded workspace activity in `user_prefs`
  let totalSavedPrompts = 0;
  let totalSavedPresets = 0;
  for (const p of prefsByUserKey.values()) {
    const uKeyName = norm(p && p.user);
    if (!uKeyName) continue;
    const spCount = Array.isArray(p.savedPrompts) ? p.savedPrompts.length : 0;
    const mpCount = Array.isArray(p.savedPresets) ? p.savedPresets.length : 0;
    const existing = byUser.get(uKeyName);
    const hasWorkspaceActivity = Boolean(
      !SYNTHETIC_TEST_USER_RE.test(uKeyName) &&
      (Number(p.updatedAt) > 0 || (Array.isArray(p.slots) && p.slots.length > 0))
    );
    if (!existing && spCount === 0 && mpCount === 0 && !hasWorkspaceActivity) continue;
    const u = existing || {
      user: uKeyName,
      userName: uKeyName,
      runs: 0,
      activeRuns: 0,
      runsToday: 0,
      starredRuns: 0,
      lastAt: 0,
      costUsd: 0,
      savedPrompts: 0,
      savedPresets: 0,
    };
    u.savedPrompts = spCount;
    u.savedPresets = mpCount;
    if ((p.updatedAt || 0) > u.lastAt) {
      u.lastAt = Number(p.updatedAt) || u.lastAt;
    }
    totalSavedPrompts += spCount;
    totalSavedPresets += mpCount;
    byUser.set(uKeyName, u);
  }

  const users = Array.from(byUser.values()).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return {
    generatedAt: Date.now(),
    dayStartUtc: startOfDay,
    retentionDays: RUN_RETENTION_DAYS,
    totals: {
      users: users.length,
      totalRuns,
      activeRuns,
      runsToday,
      totalStarredRuns,
      totalCostUsd,
      totalSavedPrompts,
      totalSavedPresets,
    },
    users,
  };
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

function summarizeImageResults(slots, results, imageSize, aspectRatio, attachments) {
  const resList = Array.isArray(results) ? results : [];
  const inputVaultRefs = (Array.isArray(attachments) ? attachments : [])
    .map((a) => a && (a.vaultRef || a.sha256))
    .filter((v) => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v));
  return resList.map((r, idx) => {
    const slotCfg = (Array.isArray(slots) && slots[idx]) || {};
    const out = {
      slot: r.slot || slotCfg.slot || String.fromCharCode(65 + idx),
      catalogId: r.catalogId || slotCfg.catalogId || 'nano-banana-2.1',
      label: r.label || slotCfg.label || 'Nano Banana',
      model: r.model || slotCfg.model || '',
      thinkingLevel: r.thinkingLevel || slotCfg.thinkingLevel || 'minimal',
      imageSize: r.imageSize || slotCfg.imageSize || imageSize || '1K',
      aspectRatio: r.aspectRatio || slotCfg.aspectRatio || aspectRatio || '16:9',
      error: r.error || null,
      latencyMs: Number(r.latencyMs) || 0,
      costUsd: typeof r.costUsd === 'number' ? r.costUsd : 0,
      promptTokens: Number(r.promptTokens) || 0,
      imageOutputTokens: Number(r.imageOutputTokens) || 0,
      thoughtsTokens: Number(r.thoughtsTokens) || 0,
      completionTokens: Number(r.completionTokens) || 0,
      mimeType: r.mimeType || 'image/png',
      hasImage: Boolean(r.hasImage || r.imageDataUrl || r.imageVaultRef || r.thumbDataUrl),
      thumbDataUrl: (typeof r.thumbDataUrl === 'string' && r.thumbDataUrl.length <= 45000) ? r.thumbDataUrl : null,
      imageVaultRef: r.imageVaultRef || null,
      thoughtVaultRef: r.thoughtVaultRef || null,
    };
    if (idx === 0 && inputVaultRefs.length > 0) {
      out.inputVaultRefs = inputVaultRefs;
    }
    return out;
  });
}

function imageListItem(meta) {
  return {
    id: meta.id,
    arena: 'image',
    at: meta.at,
    user: meta.user,
    userName: meta.userName || meta.user,
    packId: meta.packId || 'custom',
    scenarioId: meta.scenarioId || 'custom',
    title: meta.title || 'Image Arena Run',
    prompt: meta.prompt || '',
    imageSize: meta.imageSize || '1K',
    aspectRatio: meta.aspectRatio || '16:9',
    slots: meta.slots || [],
    summary: meta.summary || [],
    results: meta.summary || [],
    starred: Boolean(meta.starred),
  };
}

// Persist one completed Image & GenMedia Arena run (server-authoritative, SQLite + binary vault).
async function saveImageRun({
  id: passedId,
  at: passedAt,
  user,
  userName,
  packId,
  scenarioId,
  title,
  prompt,
  imageSize,
  aspectRatio,
  slots,
  results,
  attachments: rawAttachments,
  starred,
}) {
  try {
    maybePruneExpiredRuns();
    const id = safeId(passedId) || newId();
    const at = Number(passedAt) > 0 ? Number(passedAt) : Date.now();
    const u = norm(user);
    if (!u) return null;
    const uKey = userKey(u);
    const existingMeta = imageMetaById.get(id);
    const isStarred = starred != null ? Boolean(starred) : Boolean(existingMeta && existingMeta.starred);
    const promptText = String(prompt || '').trim();
    const runTitle = String(title || promptText.slice(0, 72) || 'Image Arena Run').trim().slice(0, 160);

    // Store reference input attachments in the user's binary vault
    const attachments = (Array.isArray(rawAttachments) ? rawAttachments : []).map((a) => {
      if (!a || typeof a !== 'object') return null;
      const ptr = vault.storeAttachmentInVaultSync(uKey, a);
      return ptr || {
        name: a.name || 'reference.png',
        mimeType: a.mimeType || 'image/png',
        kind: a.kind || 'image',
        size: Number(a.size) || 0,
        sha256: a.sha256 || a.vaultRef || null,
        vaultRef: a.vaultRef || a.sha256 || null,
      };
    }).filter(Boolean);

    // Offload generated full-resolution images & thought images to the user's binary vault
    // so `/data/history/<uKey>/<id>.json` stays compact and fast while full images restore on click!
    const storedResults = (Array.isArray(results) ? results : []).map((r, idx) => {
      if (!r || typeof r !== 'object') return null;
      const slotName = r.slot || String.fromCharCode(65 + idx);
      let imageVaultRef = r.imageVaultRef || null;
      let mimeType = r.mimeType || 'image/png';
      if (!imageVaultRef && typeof r.imageDataUrl === 'string' && r.imageDataUrl.startsWith('data:')) {
        const m = r.imageDataUrl.match(/^data:([^;]+);base64,/i);
        if (m) mimeType = m[1];
        const ptr = vault.storeAttachmentInVaultSync(uKey, {
          name: `img-${id}-slot-${slotName}.png`,
          mimeType,
          kind: 'image',
          data: r.imageDataUrl,
        });
        if (ptr && (ptr.vaultRef || ptr.sha256)) imageVaultRef = ptr.vaultRef || ptr.sha256;
      }

      let thoughtVaultRef = r.thoughtVaultRef || null;
      if (!thoughtVaultRef && typeof r.thoughtImageDataUrl === 'string' && r.thoughtImageDataUrl.startsWith('data:')) {
        const tm = r.thoughtImageDataUrl.match(/^data:([^;]+);base64,/i);
        const tMime = tm ? tm[1] : 'image/png';
        const tPtr = vault.storeAttachmentInVaultSync(uKey, {
          name: `thought-${id}-slot-${slotName}.png`,
          mimeType: tMime,
          kind: 'image',
          data: r.thoughtImageDataUrl,
        });
        if (tPtr && (tPtr.vaultRef || tPtr.sha256)) thoughtVaultRef = tPtr.vaultRef || tPtr.sha256;
      }

      return {
        slot: slotName,
        catalogId: r.catalogId || 'nano-banana-2.1',
        label: r.label || 'Nano Banana',
        model: r.model || '',
        thinkingLevel: r.thinkingLevel || 'minimal',
        imageSize: r.imageSize || imageSize || '1K',
        aspectRatio: r.aspectRatio || aspectRatio || '16:9',
        error: r.error || null,
        latencyMs: Number(r.latencyMs) || 0,
        costUsd: typeof r.costUsd === 'number' ? r.costUsd : 0,
        promptTokens: Number(r.promptTokens) || 0,
        imageOutputTokens: Number(r.imageOutputTokens) || 0,
        thoughtsTokens: Number(r.thoughtsTokens) || 0,
        completionTokens: Number(r.completionTokens) || 0,
        text: typeof r.text === 'string' ? r.text : '',
        reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
        mimeType,
        hasImage: Boolean(r.hasImage || imageVaultRef || r.imageDataUrl || r.thumbDataUrl),
        imageVaultRef,
        thoughtVaultRef,
        thumbDataUrl: (typeof r.thumbDataUrl === 'string' && r.thumbDataUrl.length <= 45000) ? r.thumbDataUrl : null,
      };
    }).filter(Boolean);

    const cleanSlots = (Array.isArray(slots) && slots.length ? slots : storedResults).map((s, idx) => ({
      slot: s.slot || String.fromCharCode(65 + idx),
      catalogId: s.catalogId || 'nano-banana-2.1',
      label: s.label || s.catalogId || 'Nano Banana',
      thinkingLevel: s.thinkingLevel || 'minimal',
      imageSize: s.imageSize || imageSize || '1K',
      aspectRatio: s.aspectRatio || aspectRatio || '16:9',
    }));

    const summary = summarizeImageResults(cleanSlots, storedResults, imageSize, aspectRatio, attachments);
    const record = {
      v: 1,
      arena: 'image',
      id,
      at,
      user: u,
      userKey: uKey,
      userName: userName || user || u,
      packId: String(packId || 'custom'),
      scenarioId: String(scenarioId || 'custom'),
      title: runTitle,
      prompt: promptText,
      imageSize: String(imageSize || '1K'),
      aspectRatio: String(aspectRatio || '16:9'),
      starred: isStarred,
      attachments,
      slots: cleanSlots,
      results: storedResults,
      summary,
    };

    const meta = imageRecordToMeta(record);
    upsertImageMetaInternal(meta, true);
    cachePayload(id, record);

    const dir = path.join(BASE_DIR, uKey);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${id}.json.tmp.${process.pid}.${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    const finalPath = path.join(dir, `${id}.json`);
    await fsp.writeFile(tmp, JSON.stringify(record));
    await fsp.rename(tmp, finalPath);

    return imageListItem(meta);
  } catch (e) {
    console.warn('[history] saveImageRun failed:', (e && e.message) || e);
    return null;
  }
}

function listImageRuns(username) {
  syncFromPersistSqliteIfNewer(false);
  maybePruneExpiredRuns();
  const key = userKey(username);
  ensureOwnerLoadedSync(key);
  const items = [];
  for (const m of imageMetaById.values()) {
    if (m.userKey === key) items.push(imageListItem(m));
  }
  items.sort((a, b) => b.at - a.at);
  return items.slice(0, MAX_LIST_PER_USER);
}

function listAllImageRuns() {
  syncFromPersistSqliteIfNewer(false);
  maybePruneExpiredRuns();
  const all = [];
  for (const m of imageMetaById.values()) {
    all.push(imageListItem(m));
  }
  all.sort((a, b) => b.at - a.at);
  return all.slice(0, MAX_LIST_ALL);
}

function hydrateImageRunForReturn(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const ownerKey = rec.userKey || userKey(rec.user);
  const hydratedResults = (Array.isArray(rec.results) ? rec.results : (Array.isArray(rec.summary) ? rec.summary : [])).map((r) => {
    if (!r || typeof r !== 'object') return r;
    const out = { ...r };
    if (!out.imageDataUrl && out.imageVaultRef) {
      const fromVault = vault.readAttachmentFromVaultSync(ownerKey, out.imageVaultRef, { fallbackAnyOwner: true });
      if (fromVault && fromVault.data) {
        out.imageDataUrl = `data:${fromVault.mimeType || out.mimeType || 'image/png'};base64,${fromVault.data}`;
      }
    }
    if (!out.imageDataUrl && out.thumbDataUrl) {
      out.imageDataUrl = out.thumbDataUrl;
    }
    if (!out.thoughtImageDataUrl && out.thoughtVaultRef) {
      const tVault = vault.readAttachmentFromVaultSync(ownerKey, out.thoughtVaultRef, { fallbackAnyOwner: true });
      if (tVault && tVault.data) {
        out.thoughtImageDataUrl = `data:${tVault.mimeType || 'image/png'};base64,${tVault.data}`;
      }
    }
    return out;
  });
  const hydratedAttachments = (Array.isArray(rec.attachments) ? rec.attachments : []).map((a) => {
    if (!a || typeof a !== 'object') return a;
    if (!a.data && (a.vaultRef || a.sha256 || a.sha1)) {
      const fromVault = vault.readAttachmentFromVaultSync(ownerKey, a, { fallbackAnyOwner: true });
      if (fromVault && fromVault.data) {
        return { ...a, data: fromVault.data, mimeType: fromVault.mimeType || a.mimeType || 'image/png', hasBlob: true };
      }
      return { ...a, thumbnailUrl: null, previewUrl: null, hasBlob: false, blobMissing: true };
    }
    return a;
  });
  return { ...rec, results: hydratedResults, attachments: hydratedAttachments };
}

function getImageRun(id, { username, isAdmin }) {
  syncFromPersistSqliteIfNewer(false);
  const sid = safeId(id);
  if (!sid) return null;
  const myKey = userKey(username);

  if (fullPayloadCache.has(sid)) {
    const cached = fullPayloadCache.get(sid);
    if (cached && cached.arena === 'image') {
      if (isAdmin || userKey(cached.user) === myKey) return hydrateImageRunForReturn(cached);
      return null;
    }
  }

  const meta = imageMetaById.get(sid);
  if (meta) {
    if (!isAdmin && meta.userKey !== myKey) return null;
    const fp = path.join(BASE_DIR, meta.userKey, `${sid}.json`);
    try {
      if (fs.existsSync(fp)) {
        const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (rec) {
          cachePayload(sid, rec);
          return hydrateImageRunForReturn(rec);
        }
      }
    } catch (_) {}
    return hydrateImageRunForReturn(meta);
  }

  const mine = path.join(BASE_DIR, myKey, `${sid}.json`);
  try {
    if (fs.existsSync(mine)) {
      const own = JSON.parse(fs.readFileSync(mine, 'utf8'));
      if (own && own.arena === 'image') {
        cachePayload(sid, own);
        return hydrateImageRunForReturn(own);
      }
    }
  } catch (_) {}

  if (!isAdmin) return null;
  try {
    for (const k of fs.readdirSync(BASE_DIR)) {
      if (!/^[0-9a-f]{40}$/.test(k)) continue;
      const fp = path.join(BASE_DIR, k, `${sid}.json`);
      if (fs.existsSync(fp)) {
        const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (rec && rec.arena === 'image') {
          cachePayload(sid, rec);
          return hydrateImageRunForReturn(rec);
        }
      }
    }
  } catch (_) {}
  return null;
}

function deleteImageRun(id, { username, isAdmin, stats, deferFlush = false, deferGc = false, asyncUnlink = false, preserveLifetimeStats = false } = {}) {
  const sid = safeId(id);
  if (!sid) return false;
  const myKey = userKey(username);
  const meta = imageMetaById.get(sid);
  const arch = archivedImageMetaById.get(sid);
  if (meta && !isAdmin && meta.userKey !== myKey) return false;
  if (!meta && arch && !isAdmin && arch.userKey !== myKey) return false;

  if (preserveLifetimeStats && meta) {
    upsertArchivedImageRunInternal(meta);
  }

  const ownerKey = (meta && meta.userKey) || (arch && arch.userKey) || myKey;
  const candidateHashes = extractRunVaultHashes(meta);
  const cached = fullPayloadCache.get(sid);
  if (cached) {
    for (const h of extractRunVaultHashes(cached)) candidateHashes.add(h);
  }

  const candidates = [];
  if (meta && meta.userKey) {
    candidates.push(path.join(BASE_DIR, meta.userKey, `${sid}.json`));
  } else {
    candidates.push(path.join(BASE_DIR, myKey, `${sid}.json`));
    if (isAdmin) {
      try {
        for (const k of fs.readdirSync(BASE_DIR)) {
          if (/^[0-9a-f]{40}$/.test(k)) candidates.push(path.join(BASE_DIR, k, `${sid}.json`));
        }
      } catch (_) {}
    }
  }

  let removed = false;
  for (const fp of new Set(candidates)) {
    if (asyncUnlink) {
      fsp.unlink(fp).catch(() => {});
      removed = true;
    } else {
      try {
        if (fs.existsSync(fp)) {
          try {
            const rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
            for (const h of extractRunVaultHashes(rec)) candidateHashes.add(h);
          } catch (_) {}
          fs.unlinkSync(fp);
          removed = true;
        }
      } catch (_) {}
    }
  }

  if (imageMetaById.has(sid)) {
    imageMetaById.delete(sid);
    removed = true;
  }
  fullPayloadCache.delete(sid);
  if (stmts && stmts.delImage) {
    try { stmts.delImage.run(sid); } catch (_) {}
  }
  if (!preserveLifetimeStats) {
    if (archivedImageMetaById.has(sid)) {
      archivedImageMetaById.delete(sid);
      removed = true;
    }
    if (stmts && stmts.delArchivedImageRun) {
      try { stmts.delArchivedImageRun.run(sid); } catch (_) {}
    }
  }
  if (removed) {
    if (deferGc && stats && stats.byUserHashes instanceof Map) {
      if (ownerKey && candidateHashes.size > 0) {
        const set = stats.byUserHashes.get(ownerKey) || new Set();
        for (const h of candidateHashes) set.add(h);
        stats.byUserHashes.set(ownerKey, set);
      }
    } else {
      const gc = gcOrphanedVaultRefsForUser(ownerKey, candidateHashes, false);
      if (stats && gc) {
        stats.vaultFilesRemoved = (stats.vaultFilesRemoved || 0) + (gc.freedFiles || 0);
        stats.vaultBytesFreed = (stats.vaultBytesFreed || 0) + (gc.freedBytes || 0);
      }
    }
    if (!deferFlush) {
      schedulePersistSnapshot();
    }
  }
  return removed;
}

// Star or unstar an Image Arena run so it is exempt from the 7-day auto-prune.
function setImageRunStarred(id, starred, { username, isAdmin }) {
  syncFromPersistSqliteIfNewer(false);
  const sid = safeId(id);
  if (!sid) return null;
  const myKey = userKey(username);
  const meta = imageMetaById.get(sid);
  if (!meta) return null;
  if (!isAdmin && meta.userKey !== myKey) return null;

  const nextStarred = Boolean(starred);
  meta.starred = nextStarred;
  if (stmts && stmts.setImageStarred) {
    try { stmts.setImageStarred.run(nextStarred ? 1 : 0, sid); } catch (_) {}
  }

  const fp = path.join(BASE_DIR, meta.userKey, `${sid}.json`);
  try {
    let rec = fullPayloadCache.get(sid);
    if (!rec && fs.existsSync(fp)) {
      rec = JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
    if (rec && typeof rec === 'object') {
      rec.starred = nextStarred;
      cachePayload(sid, rec);
      if (fs.existsSync(fp)) {
        fs.writeFileSync(fp, JSON.stringify(rec));
      }
    }
  } catch (_) {}

  flushSnapshotSync();
  return { ok: true, id: sid, starred: nextStarred };
}

function imageUsageSummary() {
  syncFromPersistSqliteIfNewer(false);
  maybePruneExpiredRuns();
  const startOfDay = (() => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); })();
  const byUser = new Map();
  const countedRunIds = new Set();
  let totalRuns = 0;
  let activeRuns = 0;
  let runsToday = 0;
  let totalStarredRuns = 0;
  let totalImages = 0;
  let totalCostUsd = 0;

  // 1. Active (7-day window + starred) Image Arena runs
  for (const rec of imageMetaById.values()) {
    if (!rec || !rec.id) continue;
    countedRunIds.add(rec.id);
    totalRuns++;
    activeRuns++;
    const today = rec.at >= startOfDay;
    if (today) runsToday++;
    if (rec.starred) totalStarredRuns++;
    const uKeyName = norm(rec.user);
    const u = byUser.get(uKeyName) || {
      user: uKeyName,
      userName: rec.userName || rec.user || uKeyName,
      runs: 0,
      activeRuns: 0,
      runsToday: 0,
      starredRuns: 0,
      imagesGenerated: 0,
      lastAt: 0,
      costUsd: 0,
    };
    u.runs++;
    u.activeRuns++;
    if (today) u.runsToday++;
    if (rec.starred) u.starredRuns++;
    if (rec.at > u.lastAt) {
      u.lastAt = rec.at;
      u.userName = rec.userName || rec.user || uKeyName;
    }
    (rec.summary || []).forEach((s) => {
      if (typeof s.costUsd === 'number' && Number.isFinite(s.costUsd)) {
        u.costUsd += s.costUsd;
        totalCostUsd += s.costUsd;
      }
      if (!s.error && (s.hasImage || s.imageVaultRef || s.thumbDataUrl)) {
        u.imagesGenerated++;
        totalImages++;
      }
    });
    byUser.set(uKeyName, u);
  }

  // 2. Pruned historical Image Arena runs from `archivedImageMetaById` (deduplicated by run `id`)
  for (const arch of archivedImageMetaById.values()) {
    if (!arch || !arch.id || countedRunIds.has(arch.id)) continue;
    countedRunIds.add(arch.id);
    totalRuns++;
    const today = arch.at >= startOfDay;
    if (today) runsToday++;
    const uKeyName = norm(arch.user);
    const u = byUser.get(uKeyName) || {
      user: uKeyName,
      userName: arch.userName || arch.user || uKeyName,
      runs: 0,
      activeRuns: 0,
      runsToday: 0,
      starredRuns: 0,
      imagesGenerated: 0,
      lastAt: 0,
      costUsd: 0,
    };
    u.runs++;
    if (today) u.runsToday++;
    if (arch.at > u.lastAt) {
      u.lastAt = arch.at;
      u.userName = arch.userName || arch.user || uKeyName;
    }
    const imgCnt = Math.max(0, Number(arch.imagesCount) || 0);
    u.imagesGenerated += imgCnt;
    totalImages += imgCnt;
    if (typeof arch.costUsd === 'number' && Number.isFinite(arch.costUsd)) {
      u.costUsd += arch.costUsd;
      totalCostUsd += arch.costUsd;
    }
    byUser.set(uKeyName, u);
  }

  const users = Array.from(byUser.values()).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return {
    generatedAt: Date.now(),
    dayStartUtc: startOfDay,
    retentionDays: RUN_RETENTION_DAYS,
    totals: {
      users: users.length,
      totalRuns,
      activeRuns,
      runsToday,
      totalStarredRuns,
      totalImages,
      totalCostUsd,
    },
    users,
  };
}

// Automatically prune unstarred runs older than `retentionMs` (default 7 days)
// and garbage-collect any orphaned binary vault files they referenced, while preserving
// lightweight lifetime usage counters in `archived_runs` and `archived_image_runs`.
// Starred runs (`m.starred === true`) are kept permanently.
// Batches SQLite deletion + per-user vault GC + a single snapshot flush at the end so pruning
// hundreds of runs is fast even on GCS FUSE.
let lastPruneCheckAt = 0;
function pruneExpiredRuns({ now = Date.now(), retentionMs = RUN_RETENTION_MS, asyncUnlink = false } = {}) {
  const cutoff = now - Math.max(60000, Number(retentionMs) || RUN_RETENTION_MS);
  const expiredText = [];
  const expiredImage = [];

  for (const m of metaById.values()) {
    if (!m.starred && Number(m.at || 0) > 0 && Number(m.at) < cutoff) {
      expiredText.push(m);
    }
  }
  for (const m of imageMetaById.values()) {
    if (!m.starred && Number(m.at || 0) > 0 && Number(m.at) < cutoff) {
      expiredImage.push(m);
    }
  }

  const stats = { vaultFilesRemoved: 0, vaultBytesFreed: 0, byUserHashes: new Map() };
  let prunedTextRuns = 0;
  let prunedImageRuns = 0;
  for (const m of expiredText) {
    if (deleteRun(m.id, { username: m.user, isAdmin: true, stats, deferFlush: true, deferGc: true, asyncUnlink, preserveLifetimeStats: true })) {
      prunedTextRuns++;
    }
  }
  for (const m of expiredImage) {
    if (deleteImageRun(m.id, { username: m.user, isAdmin: true, stats, deferFlush: true, deferGc: true, asyncUnlink, preserveLifetimeStats: true })) {
      prunedImageRuns++;
    }
  }

  for (const [ownerKey, hashes] of stats.byUserHashes.entries()) {
    const gc = gcOrphanedVaultRefsForUser(ownerKey, hashes, false);
    if (gc) {
      stats.vaultFilesRemoved += gc.freedFiles || 0;
      stats.vaultBytesFreed += gc.freedBytes || 0;
    }
  }

  if (prunedTextRuns + prunedImageRuns > 0) {
    schedulePersistSnapshot();
  }

  return {
    prunedTextRuns,
    prunedImageRuns,
    totalPruned: prunedTextRuns + prunedImageRuns,
    vaultFilesRemoved: stats.vaultFilesRemoved,
    vaultBytesFreed: stats.vaultBytesFreed,
    cutoff,
    retentionDays: RUN_RETENTION_DAYS,
  };
}

function maybePruneExpiredRuns() {
  const now = Date.now();
  if (now - lastPruneCheckAt < 5 * 60 * 1000) return null;
  lastPruneCheckAt = now;
  try {
    return pruneExpiredRuns({ now, retentionMs: RUN_RETENTION_MS, asyncUnlink: true });
  } catch (_) {
    return null;
  }
}

initSqlite();
// Never block synchronous module load (`require('./src/history')`) on GCS FUSE pruning at boot!
// Defer initial prune until 15s after server startup so `/api/health` responds in <1s.
{
  const bootPruneTimer = setTimeout(() => {
    try { maybePruneExpiredRuns(); } catch (_) {}
  }, 15 * 1000);
  if (bootPruneTimer.unref) bootPruneTimer.unref();

  const pruneTimer = setInterval(() => {
    try { pruneExpiredRuns({ asyncUnlink: true }); } catch (_) {}
  }, 6 * 60 * 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();
}

module.exports = {
  saveRun,
  saveImageRun,
  attachJudgeToLatestRun,
  newId,
  listRuns,
  listAllRuns,
  getRun,
  deleteRun,
  setRunStarred,
  usageSummary,
  listImageRuns,
  listAllImageRuns,
  getImageRun,
  deleteImageRun,
  setImageRunStarred,
  imageUsageSummary,
  pruneExpiredRuns,
  recoverDeletedRunsFromSqliteBinary,
  RUN_RETENTION_DAYS,
  RUN_RETENTION_MS,
  lastModels,
  getUserPreferences,
  saveUserPreferences,
  listSavedPrompts,
  getSavedPrompt,
  saveUserPrompt,
  deleteUserPrompt,
  listSavedPresets,
  saveUserPreset,
  deleteUserPreset,
  flushSnapshotSync,
  flushSnapshotAsync,
  syncFromPersistSqliteIfNewer,
  PERSIST_SQLITE_PATH,
  LOCAL_SQLITE_PATH,
  vault,
  BASE_DIR,
};

