// ---------------------------------------------------------------------------
// vault.js — Per-User Content-Addressable Binary File Vault (/data/vault/<userKey>/)
//
// Why a Per-User Binary Vault instead of Base64-in-JSON:
// 1. Zero Base64 Bloat & Zero JSON Event-Loop Blocking:
//    Storing PDFs, images, ZIPs, and Office docs as base64 strings inside JSON
//    (`prefs.json`, SQLite `user_prefs`, `<runId>.json`) inflates file size by
//    +33% and forces `JSON.parse` / `JSON.stringify` to allocate and scan
//    multi-megabyte strings on the main Node.js thread.
// 2. Native Binary Storage ("As-Is"):
//    Each user gets an isolated vault directory: `/data/vault/<userKey>/`
//    (where `userKey = sha256(normalizedUsername).slice(0, 40)`).
//    Raw file bytes are stored AS-IS at `/data/vault/<userKey>/<sha256>.bin`,
//    extracted text (for PDFs/Office/ZIPs) is cached at `<sha256>.txt`,
//    optional provider-scaled image copies at `<sha256>.claude.bin` and
//    `<sha256>.fit.bin`, and compact metadata (~220 bytes) at `<sha256>.meta.json`.
// 3. Per-User Deduplication & Privacy Isolation:
//    If a user attaches the same 10 MB PDF across 4 Saved Prompts and 20 Runs,
//    the 10 MB binary is stored ONCE in `/data/vault/<userKey>/<sha256>.bin`.
//    `savedPrompts`, `prefs.json`, SQLite `user_prefs`, and `GET /api/config`
//    only carry a ~180-byte vault reference (`{ sha256, vaultRef, name, size, ... }`).
//    Strict per-user directory isolation ensures User B can never access or
//    enumerate User A's vault files.
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

// Per-user in-memory index: `${uKey}:${sha256}` -> meta object
const metaCache = new Map();
// Per-user legacy SHA-1 -> SHA-256 alias map: `${uKey}:${sha1}` -> sha256
const sha1ToSha256 = new Map();

function toVaultPointer(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const sha256 = safeHex64(meta.sha256 || meta.vaultRef);
  const sha1 = safeHex40(meta.sha1);
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
    estimatedTokens: Number(meta.estimatedTokens) || undefined,
    claudeMimeType: meta.claudeMimeType ? String(meta.claudeMimeType).slice(0, 60) : undefined,
    fitMimeType: meta.fitMimeType ? String(meta.fitMimeType).slice(0, 60) : undefined,
    hasBlob: Boolean(sha256 && !meta.isEmpty),
  };
}

function extractRawBufferAndMeta(att) {
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

  const textContent = typeof att.textContent === 'string' ? att.textContent : '';
  const claudeBuf = (typeof att.claudeDataBase64 === 'string' && att.claudeDataBase64.length > 0)
    ? Buffer.from(att.claudeDataBase64, 'base64')
    : null;
  const fitBuf = (typeof att.fitDataBase64 === 'string' && att.fitDataBase64.length > 0)
    ? Buffer.from(att.fitDataBase64, 'base64')
    : null;

  const size = (rawBuf && rawBuf.length) || Number(att.size) || 0;
  const meta = {
    sha256: sha256 || null,
    sha1: sha1 || null,
    name: String(att.name || 'file').slice(0, 200),
    mimeType: String(att.mimeType || 'application/octet-stream').slice(0, 100),
    kind: att.kind ? String(att.kind).slice(0, 40) : undefined,
    size,
    isEmpty: Boolean(att.isEmpty || (size === 0 && !rawBuf && !textContent && !sha256)),
    pageCount: Number(att.pageCount) || 0,
    isEncrypted: Boolean(att.isEncrypted),
    isScannedOrImageOnly: Boolean(att.isScannedOrImageOnly),
    warning: att.warning ? String(att.warning).slice(0, 200) : null,
    optBadge: att.optBadge ? String(att.optBadge).slice(0, 200) : null,
    estimatedTokens: Number(att.estimatedTokens) || undefined,
    claudeMimeType: (claudeBuf || att.claudeMimeType) ? String(att.claudeMimeType || 'image/webp').slice(0, 60) : undefined,
    fitMimeType: (fitBuf || att.fitMimeType) ? String(att.fitMimeType || 'image/jpeg').slice(0, 60) : undefined,
    hasTextSidecar: Boolean(textContent.length > 0),
    hasClaudeSidecar: Boolean(claudeBuf && claudeBuf.length > 0),
    hasFitSidecar: Boolean(fitBuf && fitBuf.length > 0),
    updatedAt: Date.now(),
  };

  return { rawBuf, textContent, claudeBuf, fitBuf, meta };
}

// Store an attachment in the user's vault synchronously and return its compact Vault Pointer.
function storeAttachmentInVaultSync(usernameOrKey, att) {
  const uKey = userKeyFromUsername(usernameOrKey);
  const extracted = extractRawBufferAndMeta(att);
  if (!extracted) return null;
  const { rawBuf, textContent, claudeBuf, fitBuf, meta } = extracted;

  if (!uKey || !meta.sha256) {
    return toVaultPointer(meta);
  }

  const cacheKey = `${uKey}:${meta.sha256}`;
  if (meta.sha1) sha1ToSha256.set(`${uKey}:${meta.sha1}`, meta.sha256);

  // Only hit disk if we actually have inline bytes to persist or metadata isn't written yet
  if (rawBuf && rawBuf.length > 0) {
    try {
      const dir = getUserVaultDir(uKey);
      fs.mkdirSync(dir, { recursive: true });
      const binPath = path.join(dir, `${meta.sha256}.bin`);
      if (!fs.existsSync(binPath)) {
        fs.writeFileSync(binPath, rawBuf);
      }
      if (textContent && textContent.length > 0) {
        const txtPath = path.join(dir, `${meta.sha256}.txt`);
        if (!fs.existsSync(txtPath)) {
          fs.writeFileSync(txtPath, textContent, 'utf8');
        }
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
      const metaPath = path.join(dir, `${meta.sha256}.meta.json`);
      const prevMeta = metaCache.get(cacheKey);
      const mergedMeta = prevMeta ? { ...prevMeta, ...meta, hasTextSidecar: prevMeta.hasTextSidecar || meta.hasTextSidecar, hasClaudeSidecar: prevMeta.hasClaudeSidecar || meta.hasClaudeSidecar, hasFitSidecar: prevMeta.hasFitSidecar || meta.hasFitSidecar } : meta;
      metaCache.set(cacheKey, mergedMeta);
      fs.writeFileSync(metaPath, JSON.stringify(mergedMeta));
    } catch (_) {}
  } else if (!metaCache.has(cacheKey)) {
    metaCache.set(cacheKey, meta);
  }

  return toVaultPointer(metaCache.get(cacheKey) || meta);
}

// Store an attachment in the user's vault asynchronously (non-blocking for inspect/upload).
async function storeAttachmentInVaultAsync(usernameOrKey, att) {
  const uKey = userKeyFromUsername(usernameOrKey);
  const extracted = extractRawBufferAndMeta(att);
  if (!extracted) return null;
  const { rawBuf, textContent, claudeBuf, fitBuf, meta } = extracted;

  if (!uKey || !meta.sha256) {
    return toVaultPointer(meta);
  }

  const cacheKey = `${uKey}:${meta.sha256}`;
  if (meta.sha1) sha1ToSha256.set(`${uKey}:${meta.sha1}`, meta.sha256);

  if (rawBuf && rawBuf.length > 0) {
    try {
      const dir = getUserVaultDir(uKey);
      await fsp.mkdir(dir, { recursive: true });
      const binPath = path.join(dir, `${meta.sha256}.bin`);
      const writes = [];
      if (!fs.existsSync(binPath)) {
        writes.push(fsp.writeFile(binPath, rawBuf));
      }
      if (textContent && textContent.length > 0) {
        const txtPath = path.join(dir, `${meta.sha256}.txt`);
        if (!fs.existsSync(txtPath)) {
          writes.push(fsp.writeFile(txtPath, textContent, 'utf8'));
        }
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
      const prevMeta = metaCache.get(cacheKey);
      const mergedMeta = prevMeta ? { ...prevMeta, ...meta, hasTextSidecar: prevMeta.hasTextSidecar || meta.hasTextSidecar, hasClaudeSidecar: prevMeta.hasClaudeSidecar || meta.hasClaudeSidecar, hasFitSidecar: prevMeta.hasFitSidecar || meta.hasFitSidecar } : meta;
      metaCache.set(cacheKey, mergedMeta);
      const metaPath = path.join(dir, `${meta.sha256}.meta.json`);
      writes.push(fsp.writeFile(metaPath, JSON.stringify(mergedMeta)));
      await Promise.all(writes);
    } catch (_) {}
  } else if (!metaCache.has(cacheKey)) {
    metaCache.set(cacheKey, meta);
  }

  return toVaultPointer(metaCache.get(cacheKey) || meta);
}

function resolveUserSha256Sync(uKey, refOrItem) {
  if (!uKey || !refOrItem) return null;
  if (typeof refOrItem === 'string') {
    const h64 = safeHex64(refOrItem);
    if (h64) return h64;
    const h40 = safeHex40(refOrItem);
    if (h40) return sha1ToSha256.get(`${uKey}:${h40}`) || findSha256BySha1OnDiskSync(uKey, h40);
    return null;
  }
  const h64 = safeHex64(refOrItem.sha256 || refOrItem.vaultRef);
  if (h64) return h64;
  const h40 = safeHex40(refOrItem.sha1);
  if (h40) return sha1ToSha256.get(`${uKey}:${h40}`) || findSha256BySha1OnDiskSync(uKey, h40);
  return null;
}

function findSha256BySha1OnDiskSync(uKey, sha1) {
  const dir = getUserVaultDir(uKey);
  if (!dir) return null;
  try {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
    for (const f of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (m && m.sha256) {
          metaCache.set(`${uKey}:${m.sha256}`, m);
          if (m.sha1) sha1ToSha256.set(`${uKey}:${m.sha1}`, m.sha256);
          if (m.sha1 === sha1) return m.sha256;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// Read a stored attachment from the user's binary vault (strictly isolated to `usernameOrKey`).
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
    const cacheKey = `${uKey}:${sha256}`;
    let meta = metaCache.get(cacheKey);
    const metaPath = path.join(dir, `${sha256}.meta.json`);
    if (!meta && fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta) {
          metaCache.set(cacheKey, meta);
          if (meta.sha1) sha1ToSha256.set(`${uKey}:${meta.sha1}`, sha256);
        }
      } catch (_) {}
    }
    if (!meta) {
      meta = {
        sha256,
        sha1: crypto.createHash('sha1').update(rawBuf).digest('hex'),
        name: (typeof refOrItem === 'object' && refOrItem && refOrItem.name) || 'file',
        mimeType: (typeof refOrItem === 'object' && refOrItem && refOrItem.mimeType) || 'application/octet-stream',
        size: rawBuf.length,
        isEmpty: rawBuf.length === 0,
      };
    }

    let textContent = '';
    const txtPath = path.join(dir, `${sha256}.txt`);
    if (fs.existsSync(txtPath)) {
      try { textContent = fs.readFileSync(txtPath, 'utf8'); } catch (_) {}
    }

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
      data: base64Data,
      textContent: textContent || '',
      extractedText: textContent || '',
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
    const cacheKey = `${uKey}:${sha256}`;
    let meta = metaCache.get(cacheKey);
    const metaPath = path.join(dir, `${sha256}.meta.json`);
    if (!meta && fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta) metaCache.set(cacheKey, meta);
      } catch (_) {}
    }
    return {
      sha256,
      buffer,
      mimeType: (meta && meta.mimeType) || 'application/octet-stream',
      name: (meta && meta.name) || `${sha256.slice(0, 12)}.bin`,
      size: buffer.length,
    };
  } catch (_) {
    return null;
  }
}

// Remove a vault entry's files from a user's vault directory.
function deleteVaultEntryAsync(usernameOrKey, sha256) {
  const uKey = userKeyFromUsername(usernameOrKey);
  const h64 = safeHex64(sha256);
  if (!uKey || !h64) return;
  const cacheKey = `${uKey}:${h64}`;
  const meta = metaCache.get(cacheKey);
  if (meta && meta.sha1) sha1ToSha256.delete(`${uKey}:${meta.sha1}`);
  metaCache.delete(cacheKey);
  const dir = getUserVaultDir(uKey);
  const suffixes = ['.bin', '.txt', '.claude.bin', '.fit.bin', '.meta.json'];
  for (const sfx of suffixes) {
    fsp.unlink(path.join(dir, `${h64}${sfx}`)).catch(() => {});
  }
}

module.exports = {
  normUser,
  userKeyFromUsername,
  getVaultBaseDir,
  getUserVaultDir,
  toVaultPointer,
  storeAttachmentInVaultSync,
  storeAttachmentInVaultAsync,
  readAttachmentFromVaultSync,
  getVaultRawBinarySync,
  deleteVaultEntryAsync,
};
