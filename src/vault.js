// ---------------------------------------------------------------------------
// vault.js — Per-User Binary File Storage (/data/vault/<userKey>/) + SQLite File Records
//
// Architecture:
// 1. Per-User Raw Binary Folder (`/data/vault/<userKey>/`):
//    Stores ONLY immutable, content-addressed raw binary files:
//      - `<sha256>.bin`        (raw uploaded file bytes, stored as-is)
//      - `<sha256>.claude.bin` (optional pre-scaled WebP/JPEG binary for Claude)
//      - `<sha256>.fit.bin`    (optional pre-scaled JPEG binary for OpenAI)
//    Because `<sha256>.bin` is content-addressed and written once (`!fs.existsSync`),
//    it is never overwritten — eliminating GCS FUSE object generation lock contention.
//    Zero `.meta.json` or `.txt` sidecar files are written to the folder.
//
// 2. SQLite Attachment Records (`user_vault_files` table in `history.sqlite`):
//    All file metadata, extracted text (PDF/Office/ZIP), thumbnail URLs, token
//    estimates, and relative binary paths (`<userKey>/<sha256>.bin`) live inside
//    the `user_vault_files` SQLite table in local `/tmp` (WAL mode) and are
//    atomically snapshotted to `/data/history/history.sqlite`.
//
// 3. Strict Per-User Privacy Isolation:
//    Every SQLite record is keyed by `(user_key, sha256)` and every binary file
//    lives under `/data/vault/<userKey>/<sha256>.bin`. User B can never read,
//    enumerate, or reference User A's files.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const HEX40 = /^[0-9a-f]{40}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;

function normUser(u) {
  return String(u == null ? '' : u).trim().toLowerCase();
}

function userKeyFromUsername(usernameOrKey) {
  const s = String(usernameOrKey || '').trim().toLowerCase();
  if (!s) return '';
  if (HEX40.test(s)) return s;
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 40);
}

function getVaultBaseDir() {
  return process.env.APP_DATA_DIR
    ? path.join(process.env.APP_DATA_DIR, 'vault')
    : path.join(__dirname, '..', '.data', 'vault');
}

function getUserVaultDir(usernameOrKey) {
  const uKey = userKeyFromUsername(usernameOrKey);
  if (!uKey) return null;
  return path.join(getVaultBaseDir(), uKey);
}

function safeHex64(ref) {
  const s = String(ref || '').trim().toLowerCase();
  return HEX64.test(s) ? s : null;
}

function safeHex40(ref) {
  const s = String(ref || '').trim().toLowerCase();
  return HEX40.test(s) ? s : null;
}

function isImageMimeOrName(mimeType, name, kind) {
  if (kind === 'image') return true;
  const m = String(mimeType || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (m === 'image/svg+xml' || n.endsWith('.svg')) return false;
  return /^image\/(png|jpeg|jpg|webp|gif)$/i.test(m) || /\.(png|jpe?g|webp|gif)$/i.test(n);
}

// Per-user in-memory index mirrored with SQLite `user_vault_files`: `${uKey}:${sha256}` -> record
const metaCache = new Map();
// Per-user SHA-1 -> SHA-256 alias map: `${uKey}:${sha1}` -> sha256
const sha1ToSha256 = new Map();

let sqliteDb = null;
let vaultStmts = null;
let onSqliteMutate = null;

function rowToRecord(r) {
  if (!r) return null;
  return {
    userKey: r.user_key,
    sha256: r.sha256,
    sha1: r.sha1 || null,
    name: r.name || 'file',
    mimeType: r.mime_type || 'application/octet-stream',
    kind: r.kind || undefined,
    size: Number(r.size) || 0,
    isEmpty: Boolean(r.is_empty),
    pageCount: Number(r.page_count) || 0,
    isEncrypted: Boolean(r.is_encrypted),
    isScannedOrImageOnly: Boolean(r.is_scanned),
    warning: r.warning || null,
    optBadge: r.opt_badge || null,
    estimatedTokens: Number(r.estimated_tokens) || undefined,
    extractedText: r.extracted_text || '',
    thumbnailUrl: r.thumbnail_url || null,
    relPath: r.rel_path || `${r.user_key}/${r.sha256}.bin`,
    claudeMimeType: r.claude_mime_type || undefined,
    hasClaudeSidecar: Boolean(r.has_claude_bin),
    fitMimeType: r.fit_mime_type || undefined,
    hasFitSidecar: Boolean(r.has_fit_bin),
    updatedAt: Number(r.updated_at) || 0,
  };
}

function upsertSqliteRecord(uKey, rec, triggerSnapshot = true) {
  if (!uKey || !rec || !rec.sha256) return;
  const cacheKey = `${uKey}:${rec.sha256}`;
  metaCache.set(cacheKey, rec);
  if (rec.sha1) sha1ToSha256.set(`${uKey}:${rec.sha1}`, rec.sha256);
  if (vaultStmts && vaultStmts.upsert) {
    try {
      vaultStmts.upsert.run(
        uKey,
        rec.sha256,
        rec.sha1 || null,
        String(rec.name || 'file').slice(0, 200),
        String(rec.mimeType || 'application/octet-stream').slice(0, 100),
        rec.kind ? String(rec.kind).slice(0, 40) : null,
        Number(rec.size) || 0,
        rec.isEmpty ? 1 : 0,
        Number(rec.pageCount) || 0,
        rec.isEncrypted ? 1 : 0,
        rec.isScannedOrImageOnly ? 1 : 0,
        rec.warning ? String(rec.warning).slice(0, 200) : null,
        rec.optBadge ? String(rec.optBadge).slice(0, 200) : null,
        Number(rec.estimatedTokens) || null,
        typeof rec.extractedText === 'string' ? rec.extractedText : '',
        rec.thumbnailUrl ? String(rec.thumbnailUrl).slice(0, 300) : null,
        rec.relPath || `${uKey}/${rec.sha256}.bin`,
        rec.claudeMimeType ? String(rec.claudeMimeType).slice(0, 60) : null,
        rec.hasClaudeSidecar ? 1 : 0,
        rec.fitMimeType ? String(rec.fitMimeType).slice(0, 60) : null,
        rec.hasFitSidecar ? 1 : 0,
        Number(rec.updatedAt) || Date.now()
      );
      if (triggerSnapshot && typeof onSqliteMutate === 'function') {
        onSqliteMutate();
      }
    } catch (_) {}
  }
}

// Bind SQLite database from src/history.js so all user attachment metadata,
// extracted text, thumbnail URLs, and file paths live in `user_vault_files`.
function bindSqlite(db, schedulePersistFn) {
  sqliteDb = db || null;
  onSqliteMutate = schedulePersistFn || null;
  vaultStmts = null;
  if (!sqliteDb) return;
  try {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS user_vault_files (
        user_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        sha1 TEXT,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        kind TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        is_empty INTEGER NOT NULL DEFAULT 0,
        page_count INTEGER NOT NULL DEFAULT 0,
        is_encrypted INTEGER NOT NULL DEFAULT 0,
        is_scanned INTEGER NOT NULL DEFAULT 0,
        warning TEXT,
        opt_badge TEXT,
        estimated_tokens INTEGER,
        extracted_text TEXT,
        thumbnail_url TEXT,
        rel_path TEXT NOT NULL,
        claude_mime_type TEXT,
        has_claude_bin INTEGER NOT NULL DEFAULT 0,
        fit_mime_type TEXT,
        has_fit_bin INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_key, sha256)
      );
      CREATE INDEX IF NOT EXISTS idx_vault_user_sha1 ON user_vault_files(user_key, sha1);
      CREATE INDEX IF NOT EXISTS idx_vault_user_updated ON user_vault_files(user_key, updated_at DESC);
    `);

    vaultStmts = {
      upsert: sqliteDb.prepare(`
        INSERT INTO user_vault_files (
          user_key, sha256, sha1, name, mime_type, kind, size, is_empty,
          page_count, is_encrypted, is_scanned, warning, opt_badge,
          estimated_tokens, extracted_text, thumbnail_url, rel_path,
          claude_mime_type, has_claude_bin, fit_mime_type, has_fit_bin, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_key, sha256) DO UPDATE SET
          sha1 = COALESCE(excluded.sha1, user_vault_files.sha1),
          name = excluded.name,
          mime_type = excluded.mime_type,
          kind = COALESCE(excluded.kind, user_vault_files.kind),
          size = CASE WHEN excluded.size > 0 THEN excluded.size ELSE user_vault_files.size END,
          is_empty = excluded.is_empty,
          page_count = CASE WHEN excluded.page_count > 0 THEN excluded.page_count ELSE user_vault_files.page_count END,
          is_encrypted = excluded.is_encrypted,
          is_scanned = excluded.is_scanned,
          warning = COALESCE(excluded.warning, user_vault_files.warning),
          opt_badge = COALESCE(excluded.opt_badge, user_vault_files.opt_badge),
          estimated_tokens = COALESCE(excluded.estimated_tokens, user_vault_files.estimated_tokens),
          extracted_text = CASE WHEN length(excluded.extracted_text) > 0 THEN excluded.extracted_text ELSE user_vault_files.extracted_text END,
          thumbnail_url = COALESCE(excluded.thumbnail_url, user_vault_files.thumbnail_url),
          rel_path = excluded.rel_path,
          claude_mime_type = COALESCE(excluded.claude_mime_type, user_vault_files.claude_mime_type),
          has_claude_bin = MAX(user_vault_files.has_claude_bin, excluded.has_claude_bin),
          fit_mime_type = COALESCE(excluded.fit_mime_type, user_vault_files.fit_mime_type),
          has_fit_bin = MAX(user_vault_files.has_fit_bin, excluded.has_fit_bin),
          updated_at = excluded.updated_at
      `),
      getOne: sqliteDb.prepare(`SELECT * FROM user_vault_files WHERE user_key = ? AND sha256 = ?`),
      getBySha1: sqliteDb.prepare(`SELECT * FROM user_vault_files WHERE user_key = ? AND sha1 = ? LIMIT 1`),
      listByUser: sqliteDb.prepare(`SELECT * FROM user_vault_files WHERE user_key = ? ORDER BY updated_at DESC`),
      allRows: sqliteDb.prepare(`SELECT * FROM user_vault_files`),
      delOne: sqliteDb.prepare(`DELETE FROM user_vault_files WHERE user_key = ? AND sha256 = ?`),
    };

    // Warm in-memory cache from SQLite `user_vault_files`
    const existingRows = vaultStmts.allRows.all();
    for (const r of existingRows) {
      const rec = rowToRecord(r);
      if (rec && rec.userKey && rec.sha256) {
        metaCache.set(`${rec.userKey}:${rec.sha256}`, rec);
        if (rec.sha1) sha1ToSha256.set(`${rec.userKey}:${rec.sha1}`, rec.sha256);
      }
    }

    // Flush any in-memory entries recorded before bindSqlite was called
    for (const [key, rec] of metaCache.entries()) {
      const uKey = key.slice(0, 40);
      if (!existingRows.some((r) => r.user_key === uKey && r.sha256 === rec.sha256)) {
        upsertSqliteRecord(uKey, rec, false);
      }
    }

    // Background migration of any legacy `.meta.json` / `.txt` sidecar files in `/data/vault/<userKey>/`
    migrateLegacyVaultSidecarsAsync();
  } catch (e) {
    console.warn('[vault] SQLite user_vault_files init warning:', (e && e.message) || e);
    vaultStmts = null;
  }
}

function migrateLegacyVaultSidecarsAsync() {
  const baseDir = getVaultBaseDir();
  const t = setTimeout(async () => {
    try {
      if (!fs.existsSync(baseDir)) return;
      const entries = await fsp.readdir(baseDir).catch(() => []);
      const userDirs = entries.filter((d) => HEX40.test(d));
      let migrated = 0;
      for (const uKey of userDirs) {
        const dir = path.join(baseDir, uKey);
        const files = await fsp.readdir(dir).catch(() => []);
        const metaFiles = files.filter((f) => f.endsWith('.meta.json'));
        for (const mf of metaFiles) {
          const sha256 = safeHex64(mf.slice(0, -'.meta.json'.length));
          if (!sha256) continue;
          try {
            const rawMeta = JSON.parse(await fsp.readFile(path.join(dir, mf), 'utf8'));
            let extractedText = '';
            const txtPath = path.join(dir, `${sha256}.txt`);
            if (fs.existsSync(txtPath)) {
              try { extractedText = await fsp.readFile(txtPath, 'utf8'); } catch (_) {}
            }
            const isImg = isImageMimeOrName(rawMeta.mimeType, rawMeta.name, rawMeta.kind);
            const rec = {
              userKey: uKey,
              sha256,
              sha1: safeHex40(rawMeta.sha1) || null,
              name: String(rawMeta.name || 'file').slice(0, 200),
              mimeType: String(rawMeta.mimeType || 'application/octet-stream').slice(0, 100),
              kind: rawMeta.kind || (isImg ? 'image' : 'text'),
              size: Number(rawMeta.size) || 0,
              isEmpty: Boolean(rawMeta.isEmpty),
              pageCount: Number(rawMeta.pageCount) || 0,
              isEncrypted: Boolean(rawMeta.isEncrypted),
              isScannedOrImageOnly: Boolean(rawMeta.isScannedOrImageOnly),
              warning: rawMeta.warning || null,
              optBadge: rawMeta.optBadge || null,
              estimatedTokens: Number(rawMeta.estimatedTokens) || undefined,
              extractedText,
              thumbnailUrl: isImg ? `/api/me/vault/${sha256}` : null,
              relPath: `${uKey}/${sha256}.bin`,
              claudeMimeType: rawMeta.claudeMimeType || undefined,
              hasClaudeSidecar: Boolean(rawMeta.hasClaudeSidecar || fs.existsSync(path.join(dir, `${sha256}.claude.bin`))),
              fitMimeType: rawMeta.fitMimeType || undefined,
              hasFitSidecar: Boolean(rawMeta.hasFitSidecar || fs.existsSync(path.join(dir, `${sha256}.fit.bin`))),
              updatedAt: Number(rawMeta.updatedAt) || Date.now(),
            };
            upsertSqliteRecord(uKey, rec, false);
            migrated++;
            await fsp.unlink(path.join(dir, mf)).catch(() => {});
            await fsp.unlink(txtPath).catch(() => {});
          } catch (_) {}
        }
      }
      if (migrated > 0 && typeof onSqliteMutate === 'function') {
        onSqliteMutate();
      }
    } catch (_) {}
  }, 50);
  if (t.unref) t.unref();
}

function toVaultPointer(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const sha256 = safeHex64(meta.sha256 || meta.vaultRef);
  const sha1 = safeHex40(meta.sha1);
  const isImg = isImageMimeOrName(meta.mimeType, meta.name, meta.kind);
  const thumbnailUrl = meta.thumbnailUrl || (isImg && sha256 ? `/api/me/vault/${sha256}` : null);
  return {
    name: String(meta.name || 'file').slice(0, 200),
    mimeType: String(meta.mimeType || 'application/octet-stream').slice(0, 100),
    kind: meta.kind ? String(meta.kind).slice(0, 40) : undefined,
    size: Number(meta.size) || 0,
    isEmpty: Boolean(meta.isEmpty),
    pageCount: Number(meta.pageCount) || 0,
    isEncrypted: Boolean(meta.isEncrypted),
    isScannedOrImageOnly: Boolean(meta.isScannedOrImageOnly),
    warning: meta.warning ? String(meta.warning).slice(0, 200) : null,
    optBadge: meta.optBadge ? String(meta.optBadge).slice(0, 200) : null,
    sha1: sha1 || null,
    sha256: sha256 || null,
    vaultRef: sha256 || null,
    thumbnailUrl,
    relPath: meta.relPath || undefined,
    estimatedTokens: Number(meta.estimatedTokens) || undefined,
    claudeMimeType: meta.claudeMimeType ? String(meta.claudeMimeType).slice(0, 60) : undefined,
    fitMimeType: meta.fitMimeType ? String(meta.fitMimeType).slice(0, 60) : undefined,
    hasBlob: Boolean(sha256 && !meta.isEmpty),
  };
}

function extractRawBufferAndMeta(uKey, att) {
  if (!att || typeof att !== 'object') return null;
  let rawBuf = null;
  if (Buffer.isBuffer(att.rawBuffer) && att.rawBuffer.length > 0) {
    rawBuf = att.rawBuffer;
  } else if (typeof att.data === 'string' && att.data.length > 0) {
    const cleanB64 = att.data.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
    if (cleanB64.length > 0) {
      rawBuf = Buffer.from(cleanB64, 'base64');
    }
  } else if (typeof att.textContent === 'string' && att.textContent.length > 0) {
    rawBuf = Buffer.from(att.textContent, 'utf8');
  }

  let sha256 = safeHex64(att.sha256 || att.vaultRef);
  let sha1 = safeHex40(att.sha1);
  if (rawBuf && rawBuf.length > 0) {
    if (!sha256) sha256 = crypto.createHash('sha256').update(rawBuf).digest('hex');
    if (!sha1) sha1 = crypto.createHash('sha1').update(rawBuf).digest('hex');
  }

  const textContent = typeof att.textContent === 'string'
    ? att.textContent
    : (typeof att.extractedText === 'string' ? att.extractedText : '');
  const claudeBuf = (typeof att.claudeDataBase64 === 'string' && att.claudeDataBase64.length > 0)
    ? Buffer.from(att.claudeDataBase64, 'base64')
    : null;
  const fitBuf = (typeof att.fitDataBase64 === 'string' && att.fitDataBase64.length > 0)
    ? Buffer.from(att.fitDataBase64, 'base64')
    : null;

  const size = (rawBuf && rawBuf.length) || Number(att.size) || 0;
  const name = String(att.name || 'file').slice(0, 200);
  const mimeType = String(att.mimeType || 'application/octet-stream').slice(0, 100);
  const isImg = isImageMimeOrName(mimeType, name, att.kind);
  const thumbnailUrl = att.thumbnailUrl || (isImg && sha256 ? `/api/me/vault/${sha256}` : null);
  const relPath = (uKey && sha256) ? `${uKey}/${sha256}.bin` : undefined;

  const meta = {
    userKey: uKey || undefined,
    sha256: sha256 || null,
    sha1: sha1 || null,
    name,
    mimeType,
    kind: att.kind ? String(att.kind).slice(0, 40) : (isImg ? 'image' : undefined),
    size,
    isEmpty: Boolean(att.isEmpty || (size === 0 && !rawBuf && !textContent && !sha256)),
    pageCount: Number(att.pageCount) || 0,
    isEncrypted: Boolean(att.isEncrypted),
    isScannedOrImageOnly: Boolean(att.isScannedOrImageOnly),
    warning: att.warning ? String(att.warning).slice(0, 200) : null,
    optBadge: att.optBadge ? String(att.optBadge).slice(0, 200) : null,
    estimatedTokens: Number(att.estimatedTokens) || undefined,
    extractedText: textContent,
    thumbnailUrl,
    relPath,
    claudeMimeType: (claudeBuf || att.claudeMimeType) ? String(att.claudeMimeType || 'image/webp').slice(0, 60) : undefined,
    fitMimeType: (fitBuf || att.fitMimeType) ? String(att.fitMimeType || 'image/jpeg').slice(0, 60) : undefined,
    hasClaudeSidecar: Boolean(claudeBuf && claudeBuf.length > 0),
    hasFitSidecar: Boolean(fitBuf && fitBuf.length > 0),
    updatedAt: Date.now(),
  };

  return { rawBuf, textContent, claudeBuf, fitBuf, meta };
}

function mergeVaultMeta(prev, next) {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    size: next.size || prev.size || 0,
    pageCount: next.pageCount || prev.pageCount || 0,
    estimatedTokens: next.estimatedTokens || prev.estimatedTokens,
    extractedText: (next.extractedText && next.extractedText.length > 0) ? next.extractedText : (prev.extractedText || ''),
    thumbnailUrl: next.thumbnailUrl || prev.thumbnailUrl || null,
    relPath: next.relPath || prev.relPath,
    claudeMimeType: next.claudeMimeType || prev.claudeMimeType,
    fitMimeType: next.fitMimeType || prev.fitMimeType,
    hasClaudeSidecar: Boolean(prev.hasClaudeSidecar || next.hasClaudeSidecar),
    hasFitSidecar: Boolean(prev.hasFitSidecar || next.hasFitSidecar),
    updatedAt: next.updatedAt || Date.now(),
  };
}

// Store an attachment in the user's binary folder (`/data/vault/<userKey>/<sha256>.bin`)
// and record its metadata, extracted text, and thumbnail URL in SQLite `user_vault_files`.
function storeAttachmentInVaultSync(usernameOrKey, att) {
  const uKey = userKeyFromUsername(usernameOrKey);
  const extracted = extractRawBufferAndMeta(uKey, att);
  if (!extracted) return null;
  const { rawBuf, claudeBuf, fitBuf, meta } = extracted;

  if (!uKey || !meta.sha256) {
    return toVaultPointer(meta);
  }

  const cacheKey = `${uKey}:${meta.sha256}`;

  // Write ONLY raw binary files (`<sha256>.bin`, `<sha256>.claude.bin`, `<sha256>.fit.bin`) to disk
  if (rawBuf && rawBuf.length > 0) {
    try {
      const dir = getUserVaultDir(uKey);
      fs.mkdirSync(dir, { recursive: true });
      const binPath = path.join(dir, `${meta.sha256}.bin`);
      if (!fs.existsSync(binPath)) {
        fs.writeFileSync(binPath, rawBuf);
      }
      if (claudeBuf && claudeBuf.length > 0) {
        const claudePath = path.join(dir, `${meta.sha256}.claude.bin`);
        if (!fs.existsSync(claudePath)) {
          fs.writeFileSync(claudePath, claudeBuf);
        }
      }
      if (fitBuf && fitBuf.length > 0) {
        const fitPath = path.join(dir, `${meta.sha256}.fit.bin`);
        if (!fs.existsSync(fitPath)) {
          fs.writeFileSync(fitPath, fitBuf);
        }
      }
    } catch (_) {}
  }

  const prevMeta = getVaultMetaRecordSync(uKey, meta.sha256);
  const merged = mergeVaultMeta(prevMeta, meta);
  // Only trigger a SQLite snapshot write if this is a new binary or metadata changed
  const shouldPersist = Boolean(rawBuf || claudeBuf || fitBuf || !prevMeta);
  upsertSqliteRecord(uKey, merged, shouldPersist);

  return toVaultPointer(merged);
}

// Store an attachment in the user's binary folder asynchronously + upsert SQLite record.
async function storeAttachmentInVaultAsync(usernameOrKey, att) {
  const uKey = userKeyFromUsername(usernameOrKey);
  const extracted = extractRawBufferAndMeta(uKey, att);
  if (!extracted) return null;
  const { rawBuf, claudeBuf, fitBuf, meta } = extracted;

  if (!uKey || !meta.sha256) {
    return toVaultPointer(meta);
  }

  if (rawBuf && rawBuf.length > 0) {
    try {
      const dir = getUserVaultDir(uKey);
      await fsp.mkdir(dir, { recursive: true });
      const binPath = path.join(dir, `${meta.sha256}.bin`);
      const writes = [];
      if (!fs.existsSync(binPath)) {
        writes.push(fsp.writeFile(binPath, rawBuf));
      }
      if (claudeBuf && claudeBuf.length > 0) {
        const claudePath = path.join(dir, `${meta.sha256}.claude.bin`);
        if (!fs.existsSync(claudePath)) {
          writes.push(fsp.writeFile(claudePath, claudeBuf));
        }
      }
      if (fitBuf && fitBuf.length > 0) {
        const fitPath = path.join(dir, `${meta.sha256}.fit.bin`);
        if (!fs.existsSync(fitPath)) {
          writes.push(fsp.writeFile(fitPath, fitBuf));
        }
      }
      if (writes.length > 0) await Promise.all(writes);
    } catch (_) {}
  } else if (claudeBuf || fitBuf) {
    try {
      const dir = getUserVaultDir(uKey);
      await fsp.mkdir(dir, { recursive: true });
      const writes = [];
      if (claudeBuf && claudeBuf.length > 0) {
        const claudePath = path.join(dir, `${meta.sha256}.claude.bin`);
        if (!fs.existsSync(claudePath)) writes.push(fsp.writeFile(claudePath, claudeBuf));
      }
      if (fitBuf && fitBuf.length > 0) {
        const fitPath = path.join(dir, `${meta.sha256}.fit.bin`);
        if (!fs.existsSync(fitPath)) writes.push(fsp.writeFile(fitPath, fitBuf));
      }
      if (writes.length > 0) await Promise.all(writes);
    } catch (_) {}
  }

  const prevMeta = getVaultMetaRecordSync(uKey, meta.sha256);
  const merged = mergeVaultMeta(prevMeta, meta);
  const shouldPersist = Boolean(rawBuf || claudeBuf || fitBuf || !prevMeta);
  upsertSqliteRecord(uKey, merged, shouldPersist);

  return toVaultPointer(merged);
}

function getVaultMetaRecordSync(uKey, sha256) {
  if (!uKey || !sha256) return null;
  const cacheKey = `${uKey}:${sha256}`;
  if (metaCache.has(cacheKey)) return metaCache.get(cacheKey);
  if (vaultStmts && vaultStmts.getOne) {
    try {
      const row = vaultStmts.getOne.get(uKey, sha256);
      if (row) {
        const rec = rowToRecord(row);
        metaCache.set(cacheKey, rec);
        if (rec.sha1) sha1ToSha256.set(`${uKey}:${rec.sha1}`, sha256);
        return rec;
      }
    } catch (_) {}
  }
  return null;
}

function resolveUserSha256Sync(uKey, refOrItem) {
  if (!uKey || !refOrItem) return null;
  if (typeof refOrItem === 'string') {
    const h64 = safeHex64(refOrItem);
    if (h64) return h64;
    const h40 = safeHex40(refOrItem);
    if (h40) return lookupSha256BySha1Sync(uKey, h40);
    return null;
  }
  const h64 = safeHex64(refOrItem.sha256 || refOrItem.vaultRef);
  if (h64) return h64;
  const h40 = safeHex40(refOrItem.sha1);
  if (h40) return lookupSha256BySha1Sync(uKey, h40);
  return null;
}

function lookupSha256BySha1Sync(uKey, sha1) {
  const cached = sha1ToSha256.get(`${uKey}:${sha1}`);
  if (cached) return cached;
  if (vaultStmts && vaultStmts.getBySha1) {
    try {
      const row = vaultStmts.getBySha1.get(uKey, sha1);
      if (row && row.sha256) {
        const rec = rowToRecord(row);
        metaCache.set(`${uKey}:${row.sha256}`, rec);
        sha1ToSha256.set(`${uKey}:${sha1}`, row.sha256);
        return row.sha256;
      }
    } catch (_) {}
  }
  return null;
}

// Read a stored attachment from the user's binary vault + SQLite `user_vault_files` record.
function readAttachmentFromVaultSync(usernameOrKey, refOrItem) {
  const uKey = userKeyFromUsername(usernameOrKey);
  if (!uKey) return null;
  const sha256 = resolveUserSha256Sync(uKey, refOrItem);
  if (!sha256) return null;

  const dir = getUserVaultDir(uKey);
  const binPath = path.join(dir, `${sha256}.bin`);
  try {
    if (!fs.existsSync(binPath)) return null;
    const rawBuf = fs.readFileSync(binPath);
    let meta = getVaultMetaRecordSync(uKey, sha256);
    if (!meta) {
      const name = (typeof refOrItem === 'object' && refOrItem && refOrItem.name) || 'file';
      const mimeType = (typeof refOrItem === 'object' && refOrItem && refOrItem.mimeType) || 'application/octet-stream';
      const isImg = isImageMimeOrName(mimeType, name, null);
      meta = {
        userKey: uKey,
        sha256,
        sha1: crypto.createHash('sha1').update(rawBuf).digest('hex'),
        name,
        mimeType,
        kind: isImg ? 'image' : 'text',
        size: rawBuf.length,
        isEmpty: rawBuf.length === 0,
        extractedText: '',
        thumbnailUrl: isImg ? `/api/me/vault/${sha256}` : null,
        relPath: `${uKey}/${sha256}.bin`,
        updatedAt: Date.now(),
      };
      upsertSqliteRecord(uKey, meta, false);
    }

    const textContent = meta.extractedText || '';

    let claudeDataBase64;
    const claudePath = path.join(dir, `${sha256}.claude.bin`);
    if (fs.existsSync(claudePath)) {
      try { claudeDataBase64 = fs.readFileSync(claudePath).toString('base64'); } catch (_) {}
    }

    let fitDataBase64;
    const fitPath = path.join(dir, `${sha256}.fit.bin`);
    if (fs.existsSync(fitPath)) {
      try { fitDataBase64 = fs.readFileSync(fitPath).toString('base64'); } catch (_) {}
    }

    const base64Data = rawBuf.toString('base64');
    return {
      sha1: meta.sha1 || crypto.createHash('sha1').update(rawBuf).digest('hex'),
      sha256,
      vaultRef: sha256,
      name: (typeof refOrItem === 'object' && refOrItem && refOrItem.name) ? refOrItem.name : (meta.name || 'file'),
      mimeType: (typeof refOrItem === 'object' && refOrItem && refOrItem.mimeType) ? refOrItem.mimeType : (meta.mimeType || 'application/octet-stream'),
      kind: meta.kind || 'text',
      size: rawBuf.length,
      isEmpty: rawBuf.length === 0,
      pageCount: Number(meta.pageCount) || 0,
      isEncrypted: Boolean(meta.isEncrypted),
      pdfEncrypted: Boolean(meta.isEncrypted),
      isScannedOrImageOnly: Boolean(meta.isScannedOrImageOnly),
      pdfMeta: meta.kind === 'pdf' ? {
        pageCount: Number(meta.pageCount) || 0,
        isEncrypted: Boolean(meta.isEncrypted),
        isScannedOrImageOnly: Boolean(meta.isScannedOrImageOnly),
      } : null,
      warning: meta.warning || null,
      optBadge: meta.optBadge || null,
      thumbnailUrl: meta.thumbnailUrl || null,
      relPath: meta.relPath || `${uKey}/${sha256}.bin`,
      data: base64Data,
      textContent,
      extractedText: textContent,
      estimatedTokens: Number(meta.estimatedTokens) || 0,
      ...(claudeDataBase64 ? { claudeDataBase64, claudeMimeType: meta.claudeMimeType || 'image/webp' } : {}),
      ...(fitDataBase64 ? { fitDataBase64, fitMimeType: meta.fitMimeType || 'image/jpeg' } : {}),
      fromVault: true,
    };
  } catch (_) {
    return null;
  }
}

// Direct raw binary lookup for `GET /api/me/vault/:sha256` (zero base64 overhead).
function getVaultRawBinarySync(usernameOrKey, ref) {
  const uKey = userKeyFromUsername(usernameOrKey);
  if (!uKey) return null;
  const sha256 = resolveUserSha256Sync(uKey, ref);
  if (!sha256) return null;
  const dir = getUserVaultDir(uKey);
  const binPath = path.join(dir, `${sha256}.bin`);
  try {
    if (!fs.existsSync(binPath)) return null;
    const buffer = fs.readFileSync(binPath);
    const meta = getVaultMetaRecordSync(uKey, sha256);
    return {
      sha256,
      buffer,
      mimeType: (meta && meta.mimeType) || 'application/octet-stream',
      name: (meta && meta.name) || `${sha256.slice(0, 12)}.bin`,
      size: buffer.length,
      thumbnailUrl: (meta && meta.thumbnailUrl) || null,
      relPath: (meta && meta.relPath) || `${uKey}/${sha256}.bin`,
    };
  } catch (_) {
    return null;
  }
}

// List all attachment records for a specific user from SQLite `user_vault_files`
function listUserVaultFiles(usernameOrKey) {
  const uKey = userKeyFromUsername(usernameOrKey);
  if (!uKey) return [];
  if (vaultStmts && vaultStmts.listByUser) {
    try {
      const rows = vaultStmts.listByUser.all(uKey);
      return rows.map((r) => {
        const rec = rowToRecord(r);
        return {
          ...toVaultPointer(rec),
          relPath: rec.relPath,
          thumbnailUrl: rec.thumbnailUrl,
          hasExtractedText: Boolean(rec.extractedText && rec.extractedText.length > 0),
          updatedAt: rec.updatedAt,
        };
      });
    } catch (_) {}
  }
  const out = [];
  for (const [k, rec] of metaCache.entries()) {
    if (k.startsWith(`${uKey}:`)) {
      out.push({
        ...toVaultPointer(rec),
        relPath: rec.relPath,
        thumbnailUrl: rec.thumbnailUrl,
        hasExtractedText: Boolean(rec.extractedText && rec.extractedText.length > 0),
        updatedAt: rec.updatedAt || 0,
      });
    }
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

// Remove a vault entry from SQLite `user_vault_files` and unlink its raw binary files.
function deleteVaultEntryAsync(usernameOrKey, sha256) {
  const uKey = userKeyFromUsername(usernameOrKey);
  const h64 = safeHex64(sha256);
  if (!uKey || !h64) return;
  const cacheKey = `${uKey}:${h64}`;
  const meta = metaCache.get(cacheKey);
  if (meta && meta.sha1) sha1ToSha256.delete(`${uKey}:${meta.sha1}`);
  metaCache.delete(cacheKey);
  if (vaultStmts && vaultStmts.delOne) {
    try {
      vaultStmts.delOne.run(uKey, h64);
      if (typeof onSqliteMutate === 'function') onSqliteMutate();
    } catch (_) {}
  }
  const dir = getUserVaultDir(uKey);
  const suffixes = ['.bin', '.claude.bin', '.fit.bin', '.txt', '.meta.json'];
  for (const sfx of suffixes) {
    fsp.unlink(path.join(dir, `${h64}${sfx}`)).catch(() => {});
  }
}

module.exports = {
  normUser,
  userKeyFromUsername,
  getVaultBaseDir,
  getUserVaultDir,
  bindSqlite,
  toVaultPointer,
  storeAttachmentInVaultSync,
  storeAttachmentInVaultAsync,
  readAttachmentFromVaultSync,
  getVaultRawBinarySync,
  getVaultMetaRecordSync,
  listUserVaultFiles,
  deleteVaultEntryAsync,
};
