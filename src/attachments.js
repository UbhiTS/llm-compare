// ---------------------------------------------------------------------------
// attachments.js — Production-grade multi-attachment normalization, edge-case
// validation, PDF/DOCX/XLSX/ZIP text extraction, per-model context-window
// budgeting, and multimodal payload formatting across Gemini (Vertex AI / GenAI),
// Claude (Vertex AI / Anthropic), and OpenAI / Vertex AI MaaS endpoints.
// ---------------------------------------------------------------------------

const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_SINGLE_TEXT_CHARS = 2500000;         // Up to ~650k tokens for 1M-context models (per-model budget trims further)
const CLAUDE_MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024; // Anthropic 5 MB base64 cap per image
const CLAUDE_MAX_IMAGES = 20;
const CLAUDE_MAX_PDF_BYTES = 24 * 1024 * 1024; // Safe binary ceiling below Anthropic 32 MB request limit
const CLAUDE_MAX_PDF_PAGES = 100;              // Anthropic native PDF document limit
// SECURITY (decompression bombs): a 200 KB deflate stream can expand to gigabytes.
// Every inflate is capped; oversized streams keep only their leading content, which
// is all the extractor ever uses (output is sliced to MAX_SINGLE_TEXT_CHARS anyway).
const MAX_INFLATE_BYTES = Math.max(1, Number(process.env.ATTACHMENT_MAX_INFLATE_MB) || 32) * 1024 * 1024;
// Bound the SHA-1 attachment cache by bytes too (50 × 25 MB base64 could exceed a 1 GiB instance).
const MAX_CACHE_BYTES = Math.max(16, Number(process.env.ATTACHMENT_CACHE_MAX_MB) || 512) * 1024 * 1024;

function isTooLarge(e) {
  return !!e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError);
}

// inflateFn is zlib.inflateRawSync (ZIP) or zlib.inflateSync (PDF FlateDecode).
function boundedInflate(inflateFn, input, cap = MAX_INFLATE_BYTES) {
  try {
    return inflateFn(input, { maxOutputLength: cap });
  } catch (e) {
    if (!isTooLarge(e)) throw e;
  }
  // Too big: inflate progressively shorter prefixes of the compressed data with a
  // sync flush (no "unexpected end" error) until the output fits under the cap.
  for (let len = input.length >> 1; len > 0; len >>= 1) {
    try {
      return inflateFn(input.subarray(0, len), { maxOutputLength: cap, finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch (e) {
      if (!isTooLarge(e)) throw e;
    }
  }
  return Buffer.alloc(0);
}

const EXT_MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonl': 'application/json',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.ini': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.sql': 'text/x-sql',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.cpp': 'text/plain',
  '.h': 'text/plain',
  '.cs': 'text/plain',
  '.rb': 'text/plain',
  '.php': 'text/plain',
  '.swift': 'text/plain',
  '.kt': 'text/plain',
};

const CLAUDE_SUPPORTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const GEMINI_SUPPORTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
]);

function sanitizeFilename(rawName, fallbackIdx = 1) {
  const base = path.basename(String(rawName || `attachment-${fallbackIdx}`))
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_')
    .trim();
  if (!base || base === '.' || base === '..') return `attachment-${fallbackIdx}`;
  if (base.length <= 120) return base;
  const ext = path.extname(base).slice(0, 15);
  const stem = base.slice(0, 120 - ext.length);
  return `${stem}${ext}`;
}

function inferMimeType(filename, rawMime) {
  const cleanMime = String(rawMime || '').trim().toLowerCase().split(';')[0];
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (EXT_MIME_MAP[ext]) {
    // Prefer deterministic extension mapping for SVG, Office XML, CSV, code, etc.
    if (ext === '.svg' || ext === '.docx' || ext === '.xlsx' || ext === '.pptx' || !cleanMime || cleanMime === 'application/octet-stream') {
      return EXT_MIME_MAP[ext];
    }
  }
  if (cleanMime && cleanMime !== 'application/octet-stream') {
    if (cleanMime === 'image/jpg') return 'image/jpeg';
    return cleanMime;
  }
  return EXT_MIME_MAP[ext] || cleanMime || 'application/octet-stream';
}

function classifyAttachment(mimeType, filename, isEmpty = false) {
  if (isEmpty) return 'empty';
  const m = String(mimeType || '').toLowerCase();
  const ext = path.extname(String(filename || '')).toLowerCase();
  // SVG is XML text — treat as text so Claude/OpenAI don't reject it as a raster image
  if (m === 'image/svg+xml' || ext === '.svg') return 'text';
  if (GEMINI_SUPPORTED_IMAGE_MIMES.has(m) || m === 'image/bmp') return 'image';
  if (m === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx' || ext === '.zip' || m.includes('officedocument') || m === 'application/zip') {
    return 'archive_doc';
  }
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'text';
}

function isLikelyBinaryBuffer(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return false;
  const sampleLen = Math.min(buf.length, 4096);
  let nullCount = 0;
  let nonPrintable = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = buf[i];
    if (b === 0) nullCount++;
    else if (b < 7 || (b > 14 && b < 32 && b !== 27)) nonPrintable++;
  }
  return nullCount > 2 || (nonPrintable / sampleLen) > 0.25;
}

// Extract readable ASCII/UTF-8 strings from an arbitrary binary buffer as a last-resort fallback
function extractReadableStringsFromBinary(buf, maxChars = 20000) {
  if (!Buffer.isBuffer(buf) || !buf.length) return '';
  const raw = buf.toString('latin1');
  const matches = raw.match(/[A-Za-z0-9_.,:;!?@#$%^&*()[\]{}<>+\-=/\\'"`~\t ]{6,}/g) || [];
  return matches.join('\n').slice(0, maxChars).trim();
}

// Pure-Node PKZIP / Office OpenXML (.docx, .xlsx, .pptx, .zip) text extractor
function extractZipOrOfficeText(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 30) return '';
  // Check PK\x03\x04 magic signature
  if (buf.readUInt32LE(0) !== 0x04034b50) return '';
  const extractedFiles = [];
  let joinedLen = 0; // length of extractedFiles.join('\n\n') so far
  const pushText = (s) => { joinedLen += (extractedFiles.length ? 2 : 0) + s.length; extractedFiles.push(s); };
  let offset = 0;
  try {
    while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
      // Output is sliced to MAX_SINGLE_TEXT_CHARS below, so once that much text is
      // collected further entries can't change the result — stop (bounds CPU/memory
      // for archives with thousands of entries).
      if (joinedLen >= MAX_SINGLE_TEXT_CHARS) break;
      const compression = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const nameLen = buf.readUInt16LE(offset + 26);
      const extraLen = buf.readUInt16LE(offset + 28);
      const nameStart = offset + 30;
      const dataStart = nameStart + nameLen + extraLen;
      if (dataStart > buf.length) break;
      const entryName = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > buf.length || compressedSize === 0 || compressedSize > 15 * 1024 * 1024) {
        offset = dataEnd > offset ? dataEnd : offset + 30;
        continue;
      }

      const isOfficeContentXml = /^(word\/document\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|ppt\/slides\/slide\d+\.xml)$/i.test(entryName);
      const isReadableTextEntry = /\.(txt|md|csv|tsv|json|xml|yaml|yml|html|js|ts|py|sql|sh|c|cpp|go|rs|java)$/i.test(entryName) && !entryName.startsWith('__MACOSX/');

      if (isOfficeContentXml || isReadableTextEntry) {
        const rawSlice = buf.subarray(dataStart, dataEnd);
        let rawXml = '';
        if (compression === 0) {
          rawXml = rawSlice.toString('utf8');
        } else if (compression === 8) {
          try {
            rawXml = boundedInflate(zlib.inflateRawSync, rawSlice).toString('utf8');
          } catch (_) {
            rawXml = '';
          }
        }
        if (rawXml) {
          if (isOfficeContentXml || entryName.endsWith('.xml')) {
            const plain = rawXml
              .replace(/<\/(w:p|p|row|si|a:p)>/gi, '\n')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/[ \t]{2,}/g, ' ')
              .trim();
            if (plain) pushText(`[${entryName}]\n${plain}`);
          } else {
            pushText(`[${entryName}]\n${rawXml.trim()}`);
          }
        }
      }
      offset = dataEnd;
    }
  } catch (_) {
    // Partial extraction is fine
  }
  return extractedFiles.join('\n\n').slice(0, MAX_SINGLE_TEXT_CHARS).trim();
}

function decodePdfLiteralString(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\' && i + 1 < str.length) {
      const next = str[++i];
      if (next === 'n') out += '\n';
      else if (next === 'r') out += '\r';
      else if (next === 't') out += '\t';
      else if (next === 'b') out += '\b';
      else if (next === 'f') out += '\f';
      else if (next >= '0' && next <= '7') {
        let oct = next;
        if (i + 1 < str.length && str[i + 1] >= '0' && str[i + 1] <= '7') oct += str[++i];
        if (i + 1 < str.length && str[i + 1] >= '0' && str[i + 1] <= '7') oct += str[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else {
        out += next;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function extractTextFromPdfStreamContent(content) {
  const chunks = [];
  const tjRegex = /\((?:\\.|[^\\()])*\)\s*Tj|\[((?:\\.|[^\[\]])*)\]\s*TJ/g;
  let match;
  while ((match = tjRegex.exec(content)) !== null) {
    const full = match[0];
    if (match[1] != null) {
      const inner = match[1];
      const litRegex = /\((?:\\.|[^\\()])*\)/g;
      let litMatch;
      let line = '';
      while ((litMatch = litRegex.exec(inner)) !== null) {
        line += decodePdfLiteralString(litMatch[0].slice(1, -1));
      }
      if (line.trim()) chunks.push(line);
    } else {
      const openIdx = full.indexOf('(');
      const closeIdx = full.lastIndexOf(')');
      if (openIdx >= 0 && closeIdx > openIdx) {
        const s = decodePdfLiteralString(full.slice(openIdx + 1, closeIdx));
        if (s.trim()) chunks.push(s);
      }
    }
  }
  return chunks.join(' ');
}

function inspectPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { pageCount: 0, isEncrypted: false, isScannedOrImageOnly: true, textContent: '' };
  }
  try {
    const raw = buffer.toString('latin1');
    const pageMatches = raw.match(/\/Type\s*\/Page\b/g);
    const pageCount = Math.max(1, pageMatches ? pageMatches.length : 1);
    const isEncrypted = /\/Encrypt\b/.test(raw);
    const extractedParts = [];

    if (!isEncrypted) {
      let pos = 0;
      while (pos < raw.length) {
        const streamIdx = raw.indexOf('stream', pos);
        if (streamIdx < 0) break;
        const endIdx = raw.indexOf('endstream', streamIdx + 6);
        if (endIdx < 0) break;

        let startData = streamIdx + 6;
        if (raw[startData] === '\r' && raw[startData + 1] === '\n') startData += 2;
        else if (raw[startData] === '\n' || raw[startData] === '\r') startData += 1;

        let endData = endIdx;
        if (raw[endData - 1] === '\n') endData--;
        if (raw[endData - 1] === '\r') endData--;

        if (endData > startData && endData - startData < 8 * 1024 * 1024) {
          const slice = buffer.subarray(startData, endData);
          try {
            const inflated = boundedInflate(zlib.inflateSync, slice).toString('latin1');
            const txt = extractTextFromPdfStreamContent(inflated);
            if (txt.trim()) extractedParts.push(txt.trim());
          } catch (_) {
            const txt = extractTextFromPdfStreamContent(slice.toString('latin1'));
            if (txt.trim()) extractedParts.push(txt.trim());
          }
        }
        pos = endIdx + 9;
      }
      if (!extractedParts.length) {
        const topTxt = extractTextFromPdfStreamContent(raw);
        if (topTxt.trim()) extractedParts.push(topTxt.trim());
      }
    }

    const textContent = extractedParts.join('\n').replace(/[ \t]{2,}/g, ' ').trim().slice(0, MAX_SINGLE_TEXT_CHARS);
    const isScannedOrImageOnly = !isEncrypted && textContent.length < 20;
    return { pageCount, isEncrypted, isScannedOrImageOnly, textContent };
  } catch (_) {
    return { pageCount: 1, isEncrypted: false, isScannedOrImageOnly: true, textContent: '' };
  }
}

function sanitizeBase64(data) {
  const s = String(data || '').trim();
  if (!s) return '';
  const comma = s.indexOf(',');
  const raw = (s.startsWith('data:') && comma >= 0) ? s.slice(comma + 1) : s;
  const cleaned = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=_-]*$/.test(cleaned)) return '';
  return cleaned;
}

function estimateAttachmentTokens(att) {
  if (!att || att.isEmpty) return 15;
  if (att.kind === 'image') {
    // Vision models use ~258 to 1,100 tokens per image depending on resolution
    return Math.min(1150, Math.max(258, Math.ceil((att.size || 0) / 1400)));
  }
  if (att.kind === 'pdf') {
    const pageTokens = Math.max(1, att.pageCount || 1) * 258;
    const textTokens = Math.ceil((att.textContent || '').length / 3.8);
    return Math.max(pageTokens, textTokens) + 40;
  }
  const textLen = (att.textContent || '').length;
  if (textLen > 0) return Math.ceil(textLen / 3.8) + 25;
  return 60;
}

// In-memory LRU cache of normalized attachments keyed by content SHA-256
// (with a SHA-1 alias index so existing clients that reference `{ sha1, name }`
// keep working) so subsequent runs / re-runs / blind judge evaluations can
// reference a file without re-uploading multi-megabyte base64 payloads.
const ATTACHMENT_CACHE = new Map();     // sha256 -> normalized attachment
const SHA1_INDEX = new Map();           // legacy sha1 -> sha256
const HEX40 = /^[0-9a-f]{40}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const MAX_CACHE_ENTRIES = 50;
let cacheBytes = 0;
// Approximate retained size: base64 payload + extracted text (JS strings ~2 bytes/char
// worst case; textContent and extractedText share one string).
const approxBytes = (a) => ((a && a.data) ? a.data.length : 0) + ((a && a.textContent) ? a.textContent.length * 2 : 0);

// Accepts a SHA-256 (preferred) or a legacy SHA-1 hex digest.
function cacheGetAttachment(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const key = ref.trim().toLowerCase();
  const sha256 = HEX64.test(key) ? key : (HEX40.test(key) ? SHA1_INDEX.get(key) : null);
  if (!sha256) return null;
  const hit = ATTACHMENT_CACHE.get(sha256);
  if (!hit) return null;
  // Refresh LRU order
  ATTACHMENT_CACHE.delete(sha256);
  ATTACHMENT_CACHE.set(sha256, hit);
  return { ...hit };
}

function cacheEvict(sha256) {
  const old = ATTACHMENT_CACHE.get(sha256);
  if (!old) return;
  cacheBytes -= approxBytes(old);
  ATTACHMENT_CACHE.delete(sha256);
  if (old.sha1 && SHA1_INDEX.get(old.sha1) === sha256) SHA1_INDEX.delete(old.sha1);
}

function cacheSetAttachment(sha256, attObj) {
  if (!sha256 || !attObj) return;
  if (ATTACHMENT_CACHE.has(sha256)) cacheEvict(sha256);
  ATTACHMENT_CACHE.set(sha256, { ...attObj });
  if (attObj.sha1) SHA1_INDEX.set(attObj.sha1, sha256);
  cacheBytes += approxBytes(attObj);
  // Evict least-recently-used entries beyond the count OR byte budget (always keep the newest).
  while (ATTACHMENT_CACHE.size > MAX_CACHE_ENTRIES || (cacheBytes > MAX_CACHE_BYTES && ATTACHMENT_CACHE.size > 1)) {
    const oldestKey = ATTACHMENT_CACHE.keys().next().value;
    if (oldestKey === undefined) break;
    cacheEvict(oldestKey);
  }
}

// Thrown when a request references a cached attachment (by sha256/sha1 only, no
// bytes) that is no longer in the server cache (evicted, or the instance
// restarted). The server maps this to HTTP 409 so the client can re-upload —
// the request is NEVER silently run with an empty file.
class AttachmentExpiredError extends Error {
  constructor(expired) {
    const names = expired.map((e) => `"${e.name}"`).join(', ');
    super(`Attachment${expired.length > 1 ? 's' : ''} ${names} expired from the server cache — please re-attach (re-upload) and run again.`);
    this.name = 'AttachmentExpiredError';
    this.code = 'ATTACHMENT_EXPIRED';
    this.expired = expired;
  }
}

// `pre` (optional): Map(index -> { pdf, zip }) of extraction results computed
// off the main thread by normalizeAttachmentsAsync. Extraction is a pure
// function of the file bytes, so the output is identical either way.
function normalizeAttachments(rawList, pre = null) {
  if (!Array.isArray(rawList) || !rawList.length) return [];
  const out = [];
  const seenHashes = new Set();
  const expired = [];

  for (let i = 0; i < Math.min(rawList.length, MAX_ATTACHMENTS); i++) {
    const item = rawList[i];
    if (!item || typeof item !== 'object') continue;
    const name = sanitizeFilename(item.name, i + 1);
    const data = sanitizeBase64(item.data || item.dataBase64);
    const providedText = typeof item.textContent === 'string' ? item.textContent.slice(0, MAX_SINGLE_TEXT_CHARS) : '';

    // Fast-path: resolve from the server-side LRU cache when the client passes
    // `{ sha256, name }` (current) or `{ sha1, name }` (older clients).
    if ((item.sha256 || item.sha1) && !data && !providedText) {
      const cached = (item.sha256 && cacheGetAttachment(String(item.sha256))) || (item.sha1 && cacheGetAttachment(String(item.sha1)));
      if (!cached) {
        // Reference-only item whose bytes are gone: flag it, never fall through
        // to an empty buffer.
        expired.push({ name, sha1: item.sha1 ? String(item.sha1).slice(0, 64) : null, sha256: item.sha256 ? String(item.sha256).slice(0, 64) : null });
        continue;
      }
      if (cached) {
        const dedupKey = `${name}:${cached.sha1}`;
        if (seenHashes.has(dedupKey)) continue;
        seenHashes.add(dedupKey);
        out.push({
          ...cached,
          name: item.name ? name : cached.name,
          fromCache: true,
        });
        continue;
      }
    }

    const buf = data ? Buffer.from(data, 'base64') : (providedText ? Buffer.from(providedText, 'utf8') : Buffer.alloc(0));
    const size = buf.length || Number(item.size) || 0;
    const contentSha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const contentSha256 = crypto.createHash('sha256').update(buf).digest('hex');

    // Deduplicate identical file uploads in the same batch
    const hash = `${name}:${contentSha1}`;
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);

    if (buf.length > MAX_ATTACHMENT_BYTES) {
      out.push({
        sha1: contentSha1,
        sha256: contentSha256,
        name,
        mimeType: inferMimeType(name, item.mimeType),
        kind: 'oversized',
        size: buf.length,
        isEmpty: false,
        data: '',
        textContent: `[Attachment "${name}" (${(buf.length / (1024 * 1024)).toFixed(2)} MB) exceeded the 25 MB per-file upload limit and was skipped.]`,
        estimatedTokens: 40,
      });
      continue;
    }

    const isEmpty = buf.length === 0 && !providedText.trim();
    const mimeType = inferMimeType(name, item.mimeType);
    let kind = classifyAttachment(mimeType, name, isEmpty);
    let textContent = providedText;
    let pageCount = 0;
    let isEncrypted = false;
    let isScannedOrImageOnly = false;
    let warning = null;

    if (isEmpty) {
      textContent = `[Attached File "${name}" is empty (0 bytes).]`;
      warning = 'Empty file (0 bytes)';
    } else if (kind === 'pdf') {
      const pdfInfo = (pre && pre.get(i) && pre.get(i).pdf) || inspectPdfBuffer(buf);
      pageCount = pdfInfo.pageCount;
      isEncrypted = pdfInfo.isEncrypted;
      isScannedOrImageOnly = pdfInfo.isScannedOrImageOnly;
      if (!textContent) textContent = pdfInfo.textContent;
      if (isEncrypted) {
        warning = 'Password-protected / encrypted PDF';
      } else if (isScannedOrImageOnly) {
        warning = `Scanned / image-only PDF (${pageCount} page${pageCount > 1 ? 's' : ''} — uses native multimodal vision)`;
      }
    } else if (kind === 'archive_doc') {
      const z = pre && pre.get(i) && pre.get(i).zip;
      const extracted = z ? z.extracted : extractZipOrOfficeText(buf);
      if (extracted) {
        textContent = extracted;
        kind = 'text';
      } else {
        kind = 'unsupported_binary';
        const fallbackStrings = z ? z.fallbackStrings : extractReadableStringsFromBinary(buf, 8000);
        textContent = fallbackStrings
          ? `[Binary Archive/Document "${name}" (${mimeType}) — extracted strings:]\n${fallbackStrings}`
          : `[Binary Archive/Document "${name}" (${mimeType}, ${(size / 1024).toFixed(1)} KB) contains no readable text streams.]`;
        warning = 'Binary archive with limited readable text';
      }
    } else if (kind === 'text') {
      if (!textContent) {
        if (isLikelyBinaryBuffer(buf)) {
          kind = 'unsupported_binary';
          const fallbackStrings = extractReadableStringsFromBinary(buf, 8000);
          textContent = fallbackStrings
            ? `[Binary File "${name}" (${mimeType}) — extracted readable strings:]\n${fallbackStrings}`
            : `[Unsupported Binary File "${name}" (${mimeType}, ${(size / 1024).toFixed(1)} KB) — cannot be decoded as UTF-8 text.]`;
          warning = 'Binary file (extracted readable strings only)';
        } else {
          textContent = buf.toString('utf8').replace(/\0/g, '').slice(0, MAX_SINGLE_TEXT_CHARS);
        }
      }
    }

    const attObj = {
      sha1: contentSha1,
      sha256: contentSha256,
      name,
      mimeType,
      kind,
      size,
      isEmpty,
      pageCount,
      isEncrypted,
      pdfEncrypted: isEncrypted,
      isScannedOrImageOnly,
      pdfMeta: kind === 'pdf' ? { pageCount, isEncrypted, isScannedOrImageOnly } : null,
      warning,
      data: isEmpty ? '' : (data || buf.toString('base64')),
      textContent: textContent || '',
      extractedText: textContent || '',
      estimatedTokens: 0,
    };
    attObj.estimatedTokens = estimateAttachmentTokens(attObj);
    if (!isEmpty) cacheSetAttachment(contentSha256, attObj);
    out.push(attObj);
  }
  if (expired.length) throw new AttachmentExpiredError(expired);
  return out;
}

// Pure extraction for one file (runs inside the worker thread, or inline).
function extractForWorker(op, buf) {
  if (op === 'pdf') return inspectPdfBuffer(buf);
  const extracted = extractZipOrOfficeText(buf);
  return { extracted, fallbackStrings: extracted ? null : extractReadableStringsFromBinary(buf, 8000) };
}

// Same contract as normalizeAttachments, but PDF/ZIP/Office parsing runs in a
// worker_threads pool so large documents don't block the event loop. Inflate
// caps (boundedInflate) apply inside the worker exactly as inline. Falls back
// to inline parsing if workers are disabled (ATTACHMENT_WORKERS=0) or a worker
// fails, so behaviour never regresses.
async function normalizeAttachmentsAsync(rawList) {
  if (!Array.isArray(rawList) || !rawList.length) return [];
  const worker = require('./attachmentWorker');
  if (!worker.enabled()) return normalizeAttachments(rawList);
  const jobs = [];
  for (let i = 0; i < Math.min(rawList.length, MAX_ATTACHMENTS); i++) {
    const item = rawList[i];
    if (!item || typeof item !== 'object') continue;
    const data = sanitizeBase64(item.data || item.dataBase64);
    if (!data || (typeof item.textContent === 'string' && item.textContent)) continue;
    const name = sanitizeFilename(item.name, i + 1);
    const kind = classifyAttachment(inferMimeType(name, item.mimeType), name, false);
    if (kind !== 'pdf' && kind !== 'archive_doc') continue;
    const buf = Buffer.from(data, 'base64');
    if (!buf.length || buf.length > MAX_ATTACHMENT_BYTES || buf.length < worker.minBytes()) continue;
    const op = kind === 'pdf' ? 'pdf' : 'zip';
    jobs.push(worker.extractInWorker(op, buf).then((res) => [i, op, res]).catch(() => null));
  }
  const pre = new Map();
  for (const r of await Promise.all(jobs)) {
    if (r) pre.set(r[0], { [r[1]]: r[2] });
  }
  return normalizeAttachments(rawList, pre);
}

async function inspectAttachmentsAsync(rawList) {
  return toInspection(await normalizeAttachmentsAsync(rawList));
}

// Lightweight inspection + server-side caching endpoint helper:
// Normalizes and caches the uploaded attachment(s) by SHA-1 and returns exact token
// counts, PDF page/encryption metadata, and Office/ZIP extracted text metrics.
function inspectAttachments(rawList) {
  return toInspection(normalizeAttachments(rawList));
}

function toInspection(normalized) {
  return normalized.map((a) => ({
    sha1: a.sha1,
    sha256: a.sha256,
    name: a.name,
    mimeType: a.mimeType,
    kind: a.kind,
    size: a.size,
    isEmpty: a.isEmpty,
    estimatedTokens: a.estimatedTokens,
    pageCount: a.pageCount || 0,
    isEncrypted: Boolean(a.isEncrypted),
    isScannedOrImageOnly: Boolean(a.isScannedOrImageOnly),
    pdfMeta: a.pdfMeta || null,
    extractedChars: (a.textContent || '').length,
    warning: a.warning || null,
    cached: !a.isEmpty && Boolean(a.sha1),
  }));
}

// Truncate long text using 70% head + 30% tail preservation so schemas/headers
// at the top and conclusions/summaries at the bottom are both preserved.
function headTailTruncate(text, maxChars, modelLabel, contextWindow) {
  const str = String(text || '');
  if (str.length <= maxChars) return { text: str, truncated: false, omittedChars: 0 };
  const safeBudget = Math.max(800, maxChars - 320);
  const headChars = Math.floor(safeBudget * 0.70);
  const tailChars = Math.max(200, safeBudget - headChars);
  const omitted = str.length - (headChars + tailChars);
  const omittedTok = Math.ceil(omitted / 3.8);
  const ctxTag = contextWindow ? `${Math.round(contextWindow / 1000)}K` : 'model';
  const marker =
    `\n\n/* ... [CONTEXT WINDOW GUARDRAIL: ${omitted.toLocaleString('en-US')} chars (~${omittedTok.toLocaleString('en-US')} tokens) ` +
    `omitted from middle to fit ${modelLabel || 'model'}'s ${ctxTag} token context window. Head (70%) and Tail (30%) preserved.] ... */\n\n`;
  return {
    text: str.slice(0, headChars) + marker + str.slice(str.length - tailChars),
    truncated: true,
    omittedChars: omitted,
  };
}

// Per-Model Context Window Budgeting:
// Computes how much context budget a specific model slot has after reserving output
// headroom and the prompt, and proportionally trims oversized attachments if needed
// so a 128K model never crashes when racing alongside a 1M-token Gemini/Claude model.
function budgetAttachmentsForModel(attachments, { prompt = '', modelConfig = {} } = {}) {
  if (!Array.isArray(attachments) || !attachments.length) {
    return { attachments: [], contextWarning: null, estimatedInputTokens: Math.ceil(String(prompt || '').length / 3.8) };
  }
  const contextLimit = Number(modelConfig.context) || 128000;
  // Reserve 20% of context window (clamped between 8k and 32k) for model output + reasoning tokens
  const reservedOutputTokens = Math.min(32000, Math.max(8192, Math.floor(contextLimit * 0.20)));
  const promptTokens = Math.ceil(String(prompt || '').length / 3.8) + 250;
  const maxAttachmentTokens = Math.max(4000, contextLimit - reservedOutputTokens - promptTokens);

  const rawAttachmentTokens = attachments.reduce((sum, a) => sum + (a.estimatedTokens || estimateAttachmentTokens(a)), 0);
  const totalRawInputTokens = promptTokens + rawAttachmentTokens;

  if (rawAttachmentTokens <= maxAttachmentTokens) {
    return {
      attachments,
      wasTruncated: false,
      contextWarning: null,
      estimatedInputTokens: totalRawInputTokens,
      contextLimit,
    };
  }

  // Attachments exceed this specific model's context budget -> apply proportional head+tail fitting
  const fixedTokens = attachments
    .filter((a) => a.kind === 'image' || a.isEmpty)
    .reduce((s, a) => s + (a.estimatedTokens || 300), 0);
  const remainingForText = Math.max(2000, maxAttachmentTokens - fixedTokens);
  const totalTextTokens = Math.max(
    1,
    attachments
      .filter((a) => a.kind !== 'image' && !a.isEmpty)
      .reduce((s, a) => s + Math.max(100, Math.ceil((a.textContent || '').length / 3.8)), 0)
  );

  let truncatedCount = 0;
  const budgeted = attachments.map((att) => {
    if (att.isEmpty || att.kind === 'image') return att;
    const attTextTokens = Math.max(100, Math.ceil((att.textContent || '').length / 3.8));
    const shareRatio = attTextTokens / totalTextTokens;
    const allowedTokens = Math.max(500, Math.floor(remainingForText * shareRatio));
    const allowedChars = Math.floor(allowedTokens * 3.8);

    // If a PDF is too huge for this model's context window, convert its inline binary
    // to the truncated extracted text so the upstream API doesn't reject the binary PDF with 400
    const dropPdfBinary = att.kind === 'pdf' && (att.estimatedTokens > allowedTokens * 1.25);

    if ((att.textContent || '').length > allowedChars || dropPdfBinary) {
      const tr = headTailTruncate(
        att.textContent || `[PDF "${att.name}" (${att.pageCount || 1} pages) exceeded ${modelConfig.label}'s context window.]`,
        allowedChars,
        modelConfig.label,
        contextLimit
      );
      truncatedCount++;
      return {
        ...att,
        kind: dropPdfBinary ? 'text' : att.kind,
        data: dropPdfBinary ? '' : att.data,
        textContent: tr.text,
        extractedText: tr.text,
        truncatedForContext: true,
        estimatedTokens: allowedTokens,
      };
    }
    return att;
  });

  const fittedInputTokens = promptTokens + budgeted.reduce((s, a) => s + (a.estimatedTokens || 100), 0);
  const ctxK = Math.round(contextLimit / 1000);
  const rawK = (totalRawInputTokens / 1000).toFixed(1);
  const fitK = (fittedInputTokens / 1000).toFixed(1);
  const contextWarning =
    `Context Guardrail: Input (~${rawK}K tok) exceeded ${modelConfig.label || 'model'}'s safe ${ctxK}K window (${ctxK}K minus output headroom). ` +
    `Smart-fitted ${truncatedCount} attachment${truncatedCount > 1 ? 's' : ''} (70% head + 30% tail) to ~${fitK}K tok.`;

  return {
    attachments: budgeted,
    wasTruncated: truncatedCount > 0,
    contextWarning,
    estimatedInputTokens: fittedInputTokens,
    contextLimit,
  };
}

function formatAttachmentTextBlock(att) {
  const sizeKb = ((att.size || 0) / 1024).toFixed(1);
  if (att.isEmpty) {
    return `=== Attached File: ${att.name} (Empty File — 0 bytes) ===`;
  }
  if (att.kind === 'pdf' && (!att.textContent || !att.textContent.trim())) {
    if (att.isEncrypted) {
      return `=== Attached PDF: ${att.name} (${sizeKb} KB, ${att.pageCount || 1} pages) ===\n[Notice: This PDF is encrypted/password-protected (/Encrypt). No unencrypted text stream could be extracted.]`;
    }
    return `=== Attached PDF: ${att.name} (${sizeKb} KB, ${att.pageCount || 1} pages) ===\n[Notice: This PDF appears to be a scanned or image-only document with no embedded text layer. Models with native PDF vision (Gemini 3.x / Claude) inspect the rendered pages directly.]`;
  }
  if (att.textContent && att.textContent.trim()) {
    const metaBits = [att.mimeType, `${sizeKb} KB`];
    if (att.pageCount) metaBits.push(`${att.pageCount} page${att.pageCount > 1 ? 's' : ''}`);
    if (att.truncatedForContext) metaBits.push('head+tail fitted to context window');
    return (
      `=== Attached File: ${att.name} (${metaBits.join(' · ')}) ===\n` +
      `\`\`\`\n${att.textContent.trim()}\n\`\`\``
    );
  }
  return `[Attached Binary File: ${att.name} (${att.mimeType}, ${sizeKb} KB)]`;
}

function flattenPromptWithAttachments(text, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return String(text || '');
  const blocks = attachments.map((att) => formatAttachmentTextBlock(att));
  return `${blocks.join('\n\n')}\n\n${String(text || '')}`.trim();
}

// 1. Google Gemini (Vertex AI & Google GenAI) — supports native inlineData for
//    images, PDFs, audio, and video, plus structured text parts for code/CSV/text.
function toGeminiParts(text, attachments, { inlineBinary = true } = {}) {
  const parts = [];
  if (Array.isArray(attachments) && attachments.length) {
    for (const att of attachments) {
      if (att.isEmpty) {
        parts.push({ text: formatAttachmentTextBlock(att) });
        continue;
      }
      const canInline =
        inlineBinary &&
        att.data &&
        !att.truncatedForContext &&
        ((att.kind === 'image' && GEMINI_SUPPORTED_IMAGE_MIMES.has(att.mimeType)) ||
         (att.kind === 'pdf' && !att.isEncrypted) ||
         att.kind === 'audio' ||
         att.kind === 'video');

      if (canInline) {
        parts.push({
          inlineData: {
            mimeType: att.mimeType,
            data: att.data,
          },
        });
        parts.push({ text: `[Attached ${att.kind.toUpperCase()}: ${att.name} (${((att.size || 0) / 1024).toFixed(1)} KB)]` });
      } else {
        parts.push({ text: formatAttachmentTextBlock(att) });
      }
    }
  }
  parts.push({ text: String(text || '') });
  return parts;
}

// 2. Anthropic Claude (Vertex AI & Direct API) — supports native `image` blocks
//    (JPEG/PNG/GIF/WEBP <= 5MB base64, max 20 images) and native `document`
//    (application/pdf <= 24MB / 100 pages), with automatic fallback to extracted text.
function toClaudeContent(text, attachments, { allowPdfDocument = true, allowImages = true } = {}) {
  if (!Array.isArray(attachments) || !attachments.length) return String(text || '');
  const blocks = [];
  let imageCount = 0;

  for (const att of attachments) {
    if (att.isEmpty) {
      blocks.push({ type: 'text', text: formatAttachmentTextBlock(att) });
      continue;
    }
    const canSendImage =
      allowImages &&
      att.kind === 'image' &&
      CLAUDE_SUPPORTED_IMAGE_MIMES.has(att.mimeType) &&
      att.data &&
      att.data.length <= CLAUDE_MAX_IMAGE_BASE64_CHARS &&
      imageCount < CLAUDE_MAX_IMAGES;

    const canSendPdf =
      allowPdfDocument &&
      att.kind === 'pdf' &&
      !att.isEncrypted &&
      !att.truncatedForContext &&
      att.data &&
      (att.size || 0) <= CLAUDE_MAX_PDF_BYTES &&
      (att.pageCount || 1) <= CLAUDE_MAX_PDF_PAGES;

    if (canSendImage) {
      imageCount++;
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: att.mimeType,
          data: att.data,
        },
      });
      blocks.push({ type: 'text', text: `[Attached Image: ${att.name}]` });
    } else if (att.kind === 'image') {
      const reason = att.data && att.data.length > CLAUDE_MAX_IMAGE_BASE64_CHARS
        ? `exceeds Anthropic's 5 MB base64 per-image limit (${((att.size || 0) / (1024 * 1024)).toFixed(2)} MB)`
        : `unsupported raster format (${att.mimeType}) or image count limit`;
      blocks.push({
        type: 'text',
        text: `[Attached Image "${att.name}" (${att.mimeType}): ${reason} — skipped binary image block for Claude to prevent HTTP 400 error.]`,
      });
    } else if (canSendPdf) {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: att.data,
        },
      });
      blocks.push({ type: 'text', text: `[Attached PDF Document: ${att.name} (${att.pageCount || 1} pages)]` });
    } else {
      blocks.push({ type: 'text', text: formatAttachmentTextBlock(att) });
    }
  }
  blocks.push({ type: 'text', text: String(text || '') });
  return blocks;
}

// 3. OpenAI /v1/responses API content array
function toOpenAIResponsesContent(text, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return String(text || '');
  const content = [];
  for (const att of attachments) {
    if (att.isEmpty) {
      content.push({ type: 'input_text', text: formatAttachmentTextBlock(att) });
      continue;
    }
    if (att.kind === 'image' && CLAUDE_SUPPORTED_IMAGE_MIMES.has(att.mimeType) && att.data) {
      content.push({
        type: 'input_image',
        image_url: `data:${att.mimeType};base64,${att.data}`,
      });
    } else if (att.kind === 'pdf' && !att.isEncrypted && !att.truncatedForContext && att.data && (att.size || 0) <= 20 * 1024 * 1024) {
      content.push({
        type: 'input_file',
        filename: att.name,
        file_data: `data:application/pdf;base64,${att.data}`,
      });
      if (att.textContent) {
        content.push({ type: 'input_text', text: formatAttachmentTextBlock(att) });
      }
    } else {
      content.push({ type: 'input_text', text: formatAttachmentTextBlock(att) });
    }
  }
  content.push({ type: 'input_text', text: String(text || '') });
  return content;
}

// 4. OpenAI /v1/chat/completions & Vertex AI OpenAI-compatible MaaS
function toOpenAIChatContent(text, attachments, { allowImages = true, allowFiles = false } = {}) {
  if (!Array.isArray(attachments) || !attachments.length) return String(text || '');
  if (!allowImages && !allowFiles) {
    return flattenPromptWithAttachments(text, attachments);
  }
  const content = [];
  for (const att of attachments) {
    if (att.isEmpty) {
      content.push({ type: 'text', text: formatAttachmentTextBlock(att) });
      continue;
    }
    if (allowImages && att.kind === 'image' && CLAUDE_SUPPORTED_IMAGE_MIMES.has(att.mimeType) && att.data) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${att.mimeType};base64,${att.data}` },
      });
      content.push({ type: 'text', text: `[Attached Image: ${att.name}]` });
    } else if (allowFiles && att.kind === 'pdf' && !att.isEncrypted && !att.truncatedForContext && att.data && (att.size || 0) <= 20 * 1024 * 1024) {
      content.push({
        type: 'file',
        file: {
          filename: att.name,
          file_data: `data:application/pdf;base64,${att.data}`,
        },
      });
      if (att.textContent) {
        content.push({ type: 'text', text: formatAttachmentTextBlock(att) });
      }
    } else {
      content.push({ type: 'text', text: formatAttachmentTextBlock(att) });
    }
  }
  content.push({ type: 'text', text: String(text || '') });
  return content;
}

module.exports = {
  normalizeAttachments,
  normalizeAttachmentsAsync,
  inspectAttachments,
  inspectAttachmentsAsync,
  extractForWorker,
  AttachmentExpiredError,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  budgetAttachmentsForModel,
  estimateAttachmentTokens,
  formatAttachmentTextBlock,
  flattenPromptWithAttachments,
  toGeminiParts,
  toClaudeContent,
  toOpenAIResponsesContent,
  toOpenAIChatContent,
};
