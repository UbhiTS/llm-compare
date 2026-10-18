// ---------------------------------------------------------------------------
// attachments.js — Production-grade multi-attachment normalization, edge-case
// validation, PDF/DOCX/XLSX/ZIP text extraction, per-model context-window
// budgeting, and multimodal payload formatting across Gemini (Vertex AI / GenAI),
// Claude (Vertex AI / Anthropic), and OpenAI / Vertex AI MaaS endpoints.
// ---------------------------------------------------------------------------

const zlib = require('zlib');
const path = require('path');
const crypto = require('crypto');
const { imageDimensionsFromBase64 } = require('./imageInfo');
const vault = require('./vault');

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_SINGLE_TEXT_CHARS = 2500000;         // Up to ~650k tokens for 1M-context models (per-model budget trims further)
const CLAUDE_MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024; // Anthropic 5 MB base64 cap per image
const CLAUDE_MAX_IMAGES = 20;
const CLAUDE_MAX_PDF_BYTES = 24 * 1024 * 1024; // Safe binary ceiling below Anthropic 32 MB request limit
const CLAUDE_MAX_PDF_PAGES = 100;              // Anthropic native PDF document limit
// Pixel limits that make the browser build scaled copies (see imagePolicy.js):
// OpenAI rejects images over 30,000 patches of 32x32 px
// (platform.openai.com/docs/guides/images-vision); Claude's hard cap is 8000 px.
const OPENAI_PATCH_PX = 32;
const OPENAI_MAX_PATCHES = 30000;
const CLAUDE_MAX_IMAGE_DIM = 8000;
const openaiPatches = (d) => Math.ceil(d.width / OPENAI_PATCH_PX) * Math.ceil(d.height / OPENAI_PATCH_PX);
const overOpenAIPatches = (d) => Boolean(d) && openaiPatches(d) > OPENAI_MAX_PATCHES;
const overClaudeDim = (d) => Boolean(d) && Math.max(d.width, d.height) > CLAUDE_MAX_IMAGE_DIM;
// SECURITY (decompression bombs): a 200 KB deflate stream can expand to gigabytes.
// Every inflate is capped; oversized streams keep only their leading content, which
// is all the extractor ever uses (output is sliced to MAX_SINGLE_TEXT_CHARS anyway).
const MAX_INFLATE_BYTES = Math.max(1, Number(process.env.ATTACHMENT_MAX_INFLATE_MB) || 32) * 1024 * 1024;
// Total inflate work allowed per file across ALL of its entries / streams (a 25 MB ZIP of 2000
// whitespace entries, or a PDF with 5000 FlateDecode streams, otherwise costs gigabytes of CPU).
const MAX_TOTAL_INFLATE_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
const MAX_PDF_STREAMS = 5000;
// Last-resort "readable strings" scan only looks at the leading bytes of a binary.
const MAX_BINARY_STRING_SCAN_BYTES = 2 * 1024 * 1024;
// Bound the SHA-1 attachment cache by bytes too (50 × 25 MB base64 could exceed a 1 GiB instance).
const MAX_CACHE_BYTES = Math.max(16, Number(process.env.ATTACHMENT_CACHE_MAX_MB) || 512) * 1024 * 1024;
// Warning shown when a PDF / ZIP / Office file could not be parsed off the main thread
// (worker timeout, heap cap, crash or full queue). The file is never re-parsed inline.
const WORKER_FAIL_WARNING = 'Could not parse (timed out or too large)';
const WORKER_BUSY_WARNING = 'Could not parse (server busy, please retry)';

function isTooLarge(e) {
  return !!e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError);
}

// inflateFn is zlib.inflateRawSync (ZIP) or zlib.inflateSync (PDF FlateDecode).
// `budget` ({ used, limit }) tracks the total inflate work spent on one file: every over-cap
// attempt is charged the full cap (that much output was produced before the throw) and once
// the budget is exhausted nothing more is inflated for that file.
function boundedInflate(inflateFn, input, cap = MAX_INFLATE_BYTES, budget = null) {
  const charge = (n) => { if (budget) budget.used += n; };
  const exhausted = () => Boolean(budget) && budget.used >= budget.limit;
  if (exhausted()) return Buffer.alloc(0);
  try {
    const out = inflateFn(input, { maxOutputLength: cap });
    charge(out.length);
    return out;
  } catch (e) {
    if (!isTooLarge(e)) throw e;
    charge(cap);
  }
  // Too big: inflate progressively shorter prefixes of the compressed data with a
  // sync flush (no "unexpected end" error) until the output fits under the cap.
  for (let len = input.length >> 1; len > 0; len >>= 1) {
    if (exhausted()) return Buffer.alloc(0);
    try {
      const out = inflateFn(input.subarray(0, len), { maxOutputLength: cap, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      charge(out.length);
      return out;
    } catch (e) {
      if (!isTooLarge(e)) throw e;
      charge(cap);
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

// Extract readable ASCII/UTF-8 strings from an arbitrary binary buffer as a last-resort fallback.
// Scans only the first 2 MB, incrementally, and stops as soon as `maxChars` are collected
// (a global `.match()` over 25 MB built every run before slicing to 8-20 KB).
function extractReadableStringsFromBinary(buf, maxChars = 20000) {
  if (!Buffer.isBuffer(buf) || !buf.length) return '';
  const raw = buf.subarray(0, Math.min(buf.length, MAX_BINARY_STRING_SCAN_BYTES)).toString('latin1');
  const re = /[A-Za-z0-9_.,:;!?@#$%^&*()[\]{}<>+\-=/\\'"`~\t ]{6,}/g;
  const parts = [];
  let total = 0;
  let m;
  while (total < maxChars && (m = re.exec(raw)) !== null) {
    parts.push(m[0]);
    total += m[0].length + 1;
  }
  return parts.join('\n').slice(0, maxChars).trim();
}

// Pure-Node PKZIP / Office OpenXML (.docx, .xlsx, .pptx, .zip) text extractor
function extractZipOrOfficeText(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 30) return '';
  // Check PK\x03\x04 magic signature
  if (buf.readUInt32LE(0) !== 0x04034b50) return '';
  const extractedFiles = [];
  let joinedLen = 0; // length of extractedFiles.join('\n\n') so far
  const pushText = (s) => { joinedLen += (extractedFiles.length ? 2 : 0) + s.length; extractedFiles.push(s); };
  const budget = { used: 0, limit: MAX_TOTAL_INFLATE_BYTES };
  let entries = 0;
  let offset = 0;
  try {
    while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
      // Output is sliced to MAX_SINGLE_TEXT_CHARS below, so once that much text is
      // collected further entries can't change the result — stop (bounds CPU/memory
      // for archives with thousands of entries).
      if (joinedLen >= MAX_SINGLE_TEXT_CHARS) break;
      // Hard caps on entries walked and total bytes inflated for this one archive.
      if (++entries > MAX_ZIP_ENTRIES || budget.used >= budget.limit) break;
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
          budget.used += rawSlice.length;
        } else if (compression === 8) {
          try {
            rawXml = boundedInflate(zlib.inflateRawSync, rawSlice, MAX_INFLATE_BYTES, budget).toString('utf8');
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
      const budget = { used: 0, limit: MAX_TOTAL_INFLATE_BYTES };
      let streams = 0;
      let pos = 0;
      while (pos < raw.length) {
        // Hard caps on streams walked and total bytes inflated for this one PDF.
        if (++streams > MAX_PDF_STREAMS || budget.used >= budget.limit) break;
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
            const inflated = boundedInflate(zlib.inflateSync, slice, MAX_INFLATE_BYTES, budget).toString('latin1');
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

// Identify a raster image by its magic bytes (only the formats Claude accepts).
function sniffClaudeImageMime(head) {
  if (!head || head.length < 12) return null;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  const sig6 = head.toString('latin1', 0, 6);
  if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return 'image/gif';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Optional browser-made downscaled copy of an oversized image ("compact copy",
// Claude's max native size). Claude uses it when the original is over 5 MB base64
// or 8000 px; for every other provider it is only the last rung of imagePolicy's
// ladder (original -> fit copy -> compact copy). The copy is untrusted client
// input, so it is accepted only if:
//   - the attachment itself is an image whose original base64 exceeds the cap,
//     or whose pixels exceed Claude's 8000 px / OpenAI's 30,000-patch limit
//     (otherwise every model takes the original and the copy would waste cache);
//   - claudeMimeType is in CLAUDE_SUPPORTED_IMAGE_MIMES and matches the copy's
//     magic bytes;
//   - it is strict standard base64 no longer than CLAUDE_MAX_IMAGE_BASE64_CHARS.
// Anything else is ignored (status 'rejected') and Claude falls back to the
// existing "exceeds the 5 MB limit" text note — never an error.
// Note: the server can't prove the copy shows the same picture as the original
// (no image decoder without a new dependency); it is the user's own upload.
function validateClaudeScaledCopy(item, kind, originalData) {
  const supplied = Boolean(item) && item.claudeDataBase64 != null && item.claudeDataBase64 !== '';
  if (!supplied) return { status: 'none' };
  if (kind !== 'image') return { status: 'rejected' };
  const originalB64Length = (originalData || '').length;
  if (!(originalB64Length > CLAUDE_MAX_IMAGE_BASE64_CHARS)) {
    const d = imageDimensionsFromBase64(originalData);
    if (!overOpenAIPatches(d) && !overClaudeDim(d)) return { status: 'unneeded' };
  }
  const reject = { status: 'rejected' };
  if (typeof item.claudeDataBase64 !== 'string' || typeof item.claudeMimeType !== 'string') return reject;
  // Cheap bound before any regex/decoding (small slack for a data: URL prefix).
  if (item.claudeDataBase64.length > CLAUDE_MAX_IMAGE_BASE64_CHARS + 256) return reject;
  const s = item.claudeDataBase64.trim();
  const comma = s.indexOf(',');
  const b64 = ((s.startsWith('data:') && comma >= 0) ? s.slice(comma + 1) : s).replace(/\s+/g, '');
  if (!b64 || b64.length > CLAUDE_MAX_IMAGE_BASE64_CHARS || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return reject;
  let mime = item.claudeMimeType.trim().toLowerCase().split(';')[0];
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (!CLAUDE_SUPPORTED_IMAGE_MIMES.has(mime)) return reject;
  if (sniffClaudeImageMime(Buffer.from(b64.slice(0, 64), 'base64')) !== mime) return reject;
  return { status: 'ok', claudeDataBase64: b64, claudeMimeType: mime };
}

// Optional browser-made "fit copy": the original shrunk to OpenAI's 30,000-patch
// budget (official shrink formula), so OpenAI keeps as much detail as it accepts.
// Untrusted client input; accepted only if the original really is over the patch
// budget, the copy is a supported raster whose magic bytes match its MIME, it is
// smaller than the original, and its own dimensions fit the budget.
function validateFitCopy(item, kind, originalData) {
  const supplied = Boolean(item) && item.fitDataBase64 != null && item.fitDataBase64 !== '';
  if (!supplied) return { status: 'none' };
  if (kind !== 'image') return { status: 'rejected' };
  const od = imageDimensionsFromBase64(originalData);
  if (!overOpenAIPatches(od)) return { status: 'unneeded' };
  const reject = { status: 'rejected' };
  if (typeof item.fitDataBase64 !== 'string' || typeof item.fitMimeType !== 'string') return reject;
  const maxChars = Math.min((originalData || '').length, Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4);
  if (item.fitDataBase64.length > maxChars + 256) return reject;
  const s = item.fitDataBase64.trim();
  const comma = s.indexOf(',');
  const b64 = ((s.startsWith('data:') && comma >= 0) ? s.slice(comma + 1) : s).replace(/\s+/g, '');
  if (!b64 || b64.length > maxChars || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return reject;
  let mime = item.fitMimeType.trim().toLowerCase().split(';')[0];
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (!CLAUDE_SUPPORTED_IMAGE_MIMES.has(mime)) return reject;
  if (sniffClaudeImageMime(Buffer.from(b64.slice(0, 64), 'base64')) !== mime) return reject;
  const cd = imageDimensionsFromBase64(b64);
  if (!cd || overOpenAIPatches(cd) || cd.width > od.width || cd.height > od.height) return reject;
  return { status: 'ok', fitDataBase64: b64, fitMimeType: mime };
}

function applyFitCopy(attObj, copy) {
  if (copy.status === 'ok') {
    attObj.fitDataBase64 = copy.fitDataBase64;
    attObj.fitMimeType = copy.fitMimeType;
    delete attObj.fitScaledRejected;
  } else if (copy.status === 'rejected') {
    attObj.fitScaledRejected = true;
  }
  return attObj;
}

function applyClaudeScaledCopy(attObj, copy) {
  if (copy.status === 'ok') {
    attObj.claudeDataBase64 = copy.claudeDataBase64;
    attObj.claudeMimeType = copy.claudeMimeType;
    delete attObj.claudeScaledRejected;
  } else if (copy.status === 'rejected') {
    attObj.claudeScaledRejected = true;
  }
  return attObj;
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
//
// Ownership: the shared `<sha256>` entry belongs to the users in its `_owners` set. When a
// different user resolves the same hash from THEIR vault, their copy is stored under the
// composite key `<sha256>|<username>` and the shared entry's bytes are never overwritten, so one
// user can never substitute the content another user's run will read (review finding 3.5(d)).
const ATTACHMENT_CACHE = new Map();     // sha256 | `${sha256}|${username}` -> normalized attachment
const SHA1_INDEX = new Map();           // legacy sha1 -> sha256
const HEX40 = /^[0-9a-f]{40}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const MAX_CACHE_ENTRIES = 50;
let cacheBytes = 0;
// Approximate retained size: base64 payload + optional Claude scaled copy + extracted
// text (JS strings ~2 bytes/char worst case; textContent and extractedText share one string).
const approxBytes = (a) => ((a && a.data) ? a.data.length : 0) +
  ((a && a.claudeDataBase64) ? a.claudeDataBase64.length : 0) +
  ((a && a.fitDataBase64) ? a.fitDataBase64.length : 0) +
  ((a && a.textContent) ? a.textContent.length * 2 : 0);
const normUserKey = (username) => (username ? String(username).trim().toLowerCase() : null);
const perUserCacheKey = (sha256, user) => `${sha256}|${user}`;

function cacheTouch(key, hit) {
  // Refresh LRU order
  ATTACHMENT_CACHE.delete(key);
  ATTACHMENT_CACHE.set(key, hit);
  return { ...hit };
}

// Accepts a SHA-256 (preferred) or a legacy SHA-1 hex digest. With a `username`, that user's own
// composite copy wins; the shared entry is returned only when the user is one of its owners
// (or the caller is an admin). Without a username (no auth context) the shared entry is returned.
function cacheGetAttachment(ref, username = null, isAdmin = false) {
  if (!ref || typeof ref !== 'string') return null;
  const key = ref.trim().toLowerCase();
  const sha256 = HEX64.test(key) ? key : (HEX40.test(key) ? SHA1_INDEX.get(key) : null);
  if (!sha256) return null;
  const user = normUserKey(username);
  if (user) {
    const ownKey = perUserCacheKey(sha256, user);
    const own = ATTACHMENT_CACHE.get(ownKey);
    if (own) return cacheTouch(ownKey, own);
  }
  const hit = ATTACHMENT_CACHE.get(sha256);
  if (!hit) return null;
  if (user && !isAdmin && hit._owners instanceof Set && hit._owners.size > 0 && !hit._owners.has(user)) return null;
  return cacheTouch(sha256, hit);
}

function cacheEvict(key) {
  const old = ATTACHMENT_CACHE.get(key);
  if (!old) return;
  cacheBytes -= approxBytes(old);
  ATTACHMENT_CACHE.delete(key);
  if (old.sha1 && SHA1_INDEX.get(old.sha1) === key) SHA1_INDEX.delete(old.sha1);
}

function cacheEvictOverBudget() {
  // Evict least-recently-used entries beyond the count OR byte budget (always keep the newest).
  while (ATTACHMENT_CACHE.size > MAX_CACHE_ENTRIES || (cacheBytes > MAX_CACHE_BYTES && ATTACHMENT_CACHE.size > 1)) {
    const oldestKey = ATTACHMENT_CACHE.keys().next().value;
    if (oldestKey === undefined) break;
    cacheEvict(oldestKey);
  }
}

function cacheSetAttachment(sha256, attObj, username = null) {
  if (!sha256 || !attObj) return;
  const user = normUserKey(username);
  const prev = ATTACHMENT_CACHE.get(sha256);
  const prevOwners = (prev && prev._owners instanceof Set) ? prev._owners : null;
  if (prev && user && prevOwners && prevOwners.size > 0 && !prevOwners.has(user)) {
    const sameBytes = (prev.data || '') === (attObj.data || '') && (prev.textContent || '') === (attObj.textContent || '');
    if (!sameBytes) {
      // Another user owns the shared entry and this copy differs: keep it strictly per-user.
      const ownKey = perUserCacheKey(sha256, user);
      if (ATTACHMENT_CACHE.has(ownKey)) cacheEvict(ownKey);
      ATTACHMENT_CACHE.set(ownKey, { ...attObj, _owners: new Set([user]) });
      cacheBytes += approxBytes(attObj);
      cacheEvictOverBudget();
      return;
    }
    // Byte-identical content: safe to add this user as an owner of the shared entry (falls through).
  }
  const owners = prevOwners ? new Set(prevOwners) : (attObj._owners instanceof Set ? new Set(attObj._owners) : null);
  if (ATTACHMENT_CACHE.has(sha256)) cacheEvict(sha256);
  const nextObj = { ...attObj };
  if (user) {
    const uSet = owners || new Set();
    uSet.add(user);
    nextObj._owners = uSet;
  } else if (owners) {
    nextObj._owners = owners;
  }
  ATTACHMENT_CACHE.set(sha256, nextObj);
  if (attObj.sha1) SHA1_INDEX.set(attObj.sha1, sha256);
  cacheBytes += approxBytes(attObj);
  cacheEvictOverBudget();
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
function normalizeAttachments(rawList, pre = null, opts = null) {
  if (!Array.isArray(rawList) || !rawList.length) return [];
  const out = [];
  const seenHashes = new Set();
  const expired = [];
  const username = opts && opts.username ? String(opts.username).trim().toLowerCase() : null;
  const isAdmin = Boolean(opts && opts.isAdmin);

  for (let i = 0; i < Math.min(rawList.length, MAX_ATTACHMENTS); i++) {
    const item = rawList[i];
    if (!item || typeof item !== 'object') continue;
    const name = sanitizeFilename(item.name, i + 1);
    const data = sanitizeBase64(item.data || item.dataBase64);
    const providedText = typeof item.textContent === 'string' ? item.textContent.slice(0, MAX_SINGLE_TEXT_CHARS) : '';

    // Fast-path: resolve from the server-side LRU cache or the user's persistent
    // binary vault (/data/vault/<userKey>/) when the client passes
    // `{ sha256, name }` (current), `{ vaultRef, name }`, or `{ sha1, name }`.
    const refSha256 = item.sha256 || item.vaultRef;
    if ((refSha256 || item.sha1) && !data && !providedText) {
      let cached = (refSha256 && cacheGetAttachment(String(refSha256), username, isAdmin)) || (item.sha1 && cacheGetAttachment(String(item.sha1), username, isAdmin));
      if (cached && username && !isAdmin && cached._owners instanceof Set && !cached._owners.has(username)) {
        cached = null;
      }
      if (!cached && username) {
        // normalizeAttachmentsAsync may already have read the vault blob and parsed it in a worker (`pre`)
        const p = pre && pre.get(i);
        const fromVault = (p && p.vault) || vault.readAttachmentFromVaultSync(username, item, { isAdmin });
        if (fromVault) {
          // Ensure kind/textContent/estimatedTokens are fully populated if the vault entry came from a raw binary migration
          const vMime = inferMimeType(fromVault.name || name, fromVault.mimeType);
          const vKind = classifyAttachment(vMime, fromVault.name || name, fromVault.isEmpty);
          fromVault.mimeType = vMime;
          fromVault.kind = vKind;
          if (!fromVault.textContent && fromVault.data) {
            if (p && p.failed && (vKind === 'pdf' || vKind === 'archive_doc')) {
              // Worker could not parse it (timeout / heap cap / full queue): never re-parse on the main thread.
              fromVault.kind = 'unsupported_binary';
              fromVault.warning = p.reason === 'busy' ? WORKER_BUSY_WARNING : WORKER_FAIL_WARNING;
              fromVault.textContent = '';
              fromVault.extractedText = '';
            } else if (vKind === 'pdf') {
              const pdfInfo = (p && p.pdf) || inspectPdfBuffer(Buffer.from(fromVault.data, 'base64'));
              fromVault.pageCount = fromVault.pageCount || pdfInfo.pageCount;
              fromVault.isEncrypted = pdfInfo.isEncrypted;
              fromVault.pdfEncrypted = pdfInfo.isEncrypted;
              fromVault.isScannedOrImageOnly = pdfInfo.isScannedOrImageOnly;
              fromVault.pdfMeta = { pageCount: fromVault.pageCount, isEncrypted: pdfInfo.isEncrypted, isScannedOrImageOnly: pdfInfo.isScannedOrImageOnly };
              fromVault.textContent = pdfInfo.textContent || '';
              fromVault.extractedText = fromVault.textContent;
            } else if (vKind === 'archive_doc') {
              const z = p && p.zip;
              const extracted = z ? z.extracted : extractZipOrOfficeText(Buffer.from(fromVault.data, 'base64'));
              if (extracted) {
                fromVault.textContent = extracted;
                fromVault.extractedText = extracted;
                fromVault.kind = 'text';
              }
            } else if (vKind === 'text') {
              const vBuf = Buffer.from(fromVault.data, 'base64');
              if (!isLikelyBinaryBuffer(vBuf)) {
                fromVault.textContent = vBuf.toString('utf8').replace(/\0/g, '').slice(0, MAX_SINGLE_TEXT_CHARS);
                fromVault.extractedText = fromVault.textContent;
              }
            }
          }
          if (!fromVault.estimatedTokens) {
            fromVault.estimatedTokens = estimateAttachmentTokens(fromVault);
          }
          cacheSetAttachment(fromVault.sha256, fromVault, username);
          cached = fromVault;
        }
      }
      if (!cached) {
        // Reference-only item whose bytes are gone: flag it, never fall through
        // to an empty buffer.
        expired.push({ name, sha1: item.sha1 ? String(item.sha1).slice(0, 64) : null, sha256: refSha256 ? String(refSha256).slice(0, 64) : null });
        continue;
      }
      if (cached) {
        const dedupKey = `${name}:${cached.sha1}`;
        if (seenHashes.has(dedupKey)) continue;
        seenHashes.add(dedupKey);
        // A reference may carry a Claude scaled copy the cached entry lacks
        // (e.g. uploaded before the copy existed): validate and remember it.
        let refreshed = false;
        if (!cached.claudeDataBase64 && item.claudeDataBase64) {
          const copy = validateClaudeScaledCopy(item, cached.kind, cached.data || '');
          applyClaudeScaledCopy(cached, copy);
          if (copy.status === 'ok') refreshed = true;
        }
        if (!cached.fitDataBase64 && item.fitDataBase64) {
          const copy = validateFitCopy(item, cached.kind, cached.data || '');
          applyFitCopy(cached, copy);
          if (copy.status === 'ok') refreshed = true;
        }
        if (refreshed) {
          cacheSetAttachment(cached.sha256, cached, username);
          if (username) vault.storeAttachmentInVaultAsync(username, cached).catch(() => {});
        }
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
    } else if ((kind === 'pdf' || kind === 'archive_doc') && pre && pre.get(i) && pre.get(i).failed) {
      // The worker timed out / hit its heap cap / crashed / was full: a hostile document must never
      // be re-parsed inline on the event loop. Keep the bytes, drop the text, surface a warning.
      kind = 'unsupported_binary';
      textContent = '';
      warning = pre.get(i).reason === 'busy' ? WORKER_BUSY_WARNING : WORKER_FAIL_WARNING;
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
      vaultRef: contentSha256,
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
    // Fields are only added when a copy was supplied, so objects for every
    // other upload are exactly what they were before this feature.
    applyClaudeScaledCopy(attObj, validateClaudeScaledCopy(item, kind, attObj.data));
    applyFitCopy(attObj, validateFitCopy(item, kind, attObj.data));
    attObj.estimatedTokens = estimateAttachmentTokens(attObj);
    // One entry per file, keyed by SHA-256; SHA1_INDEX resolves legacy sha1 refs.
    if (!isEmpty) {
      cacheSetAttachment(contentSha256, attObj, username);
      if (username) {
        vault.storeAttachmentInVaultAsync(username, { ...attObj, rawBuffer: buf }).catch(() => {});
      }
    }
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
// caps (boundedInflate) apply inside the worker exactly as inline. Parsing runs
// inline only when workers are disabled (ATTACHMENT_WORKERS=0) or a file is below
// ATTACHMENT_WORKER_MIN_BYTES; when a worker FAILS (timeout, heap cap, crash, full
// queue) the file is marked `unsupported_binary` with a warning and is NEVER
// re-parsed on the main thread (review finding 6.1).
// Reference-only items (`{ sha256 }` / `{ vaultRef }` / `{ sha1 }`) that miss the cache are
// resolved from the user's vault here too, so their PDF/ZIP extraction also runs in a worker.
async function normalizeAttachmentsAsync(rawList, opts = null) {
  if (!Array.isArray(rawList) || !rawList.length) return [];
  const worker = require('./attachmentWorker');
  if (!worker.enabled()) return normalizeAttachments(rawList, null, opts);
  const username = opts && opts.username ? String(opts.username).trim().toLowerCase() : null;
  const isAdmin = Boolean(opts && opts.isAdmin);
  const jobs = [];
  const pre = new Map();
  const offload = (i, op, buf, extra) => {
    jobs.push(worker.extractInWorker(op, buf)
      .then((res) => { pre.set(i, { ...extra, [op]: res }); })
      .catch((e) => { pre.set(i, { ...extra, failed: true, reason: (e && e.code === 'ATTACHMENT_QUEUE_FULL') ? 'busy' : 'limit' }); }));
  };
  for (let i = 0; i < Math.min(rawList.length, MAX_ATTACHMENTS); i++) {
    const item = rawList[i];
    if (!item || typeof item !== 'object') continue;
    const data = sanitizeBase64(item.data || item.dataBase64);
    const providedText = typeof item.textContent === 'string' && item.textContent;
    const name = sanitizeFilename(item.name, i + 1);
    if (!data && !providedText) {
      // Reference-only item: on a cache miss, read the bytes from the user's own vault and parse off-thread.
      const refSha256 = item.sha256 || item.vaultRef;
      if (!(refSha256 || item.sha1) || !username) continue;
      const cachedHit = (refSha256 && cacheGetAttachment(String(refSha256), username, isAdmin)) || (item.sha1 && cacheGetAttachment(String(item.sha1), username, isAdmin));
      if (cachedHit) continue;
      const fromVault = vault.readAttachmentFromVaultSync(username, item, { isAdmin });
      if (!fromVault) continue;
      const vKind = classifyAttachment(inferMimeType(fromVault.name || name, fromVault.mimeType), fromVault.name || name, fromVault.isEmpty);
      if (fromVault.textContent || !fromVault.data || (vKind !== 'pdf' && vKind !== 'archive_doc')) {
        pre.set(i, { vault: fromVault });
        continue;
      }
      const vBuf = Buffer.from(fromVault.data, 'base64');
      if (!vBuf.length || vBuf.length > MAX_ATTACHMENT_BYTES || vBuf.length < worker.minBytes()) {
        pre.set(i, { vault: fromVault });
        continue;
      }
      offload(i, vKind === 'pdf' ? 'pdf' : 'zip', vBuf, { vault: fromVault });
      continue;
    }
    if (!data) continue;
    const kind = classifyAttachment(inferMimeType(name, item.mimeType), name, false);
    if (kind !== 'pdf' && kind !== 'archive_doc') continue;
    const buf = Buffer.from(data, 'base64');
    if (!buf.length || buf.length > MAX_ATTACHMENT_BYTES || buf.length < worker.minBytes()) continue;
    offload(i, kind === 'pdf' ? 'pdf' : 'zip', buf, {});
  }
  await Promise.all(jobs);
  return normalizeAttachments(rawList, pre, opts);
}

async function inspectAttachmentsAsync(rawList, opts = null) {
  return toInspection(await normalizeAttachmentsAsync(rawList, opts));
}

// Lightweight inspection + server-side caching endpoint helper:
// Normalizes and caches the uploaded attachment(s) by SHA-1 and returns exact token
// counts, PDF page/encryption metadata, and Office/ZIP extracted text metrics.
function inspectAttachments(rawList, opts = null) {
  return toInspection(normalizeAttachments(rawList, null, opts));
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
    // Only present when the client sent a Claude scaled copy: true = accepted,
    // false = ignored (Claude gets the "too large" note instead).
    ...(a.claudeDataBase64 ? { claudeScaled: true } : (a.claudeScaledRejected ? { claudeScaled: false } : {})),
    // Same for the OpenAI patch-budget fit copy.
    ...(a.fitDataBase64 ? { fitScaled: true } : (a.fitScaledRejected ? { fitScaled: false } : {})),
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
function toGeminiParts(text, attachments, { inlineBinary = true, inlineDocs = true } = {}) {
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
         (inlineDocs && att.kind === 'pdf' && !att.isEncrypted) ||
         (inlineDocs && att.kind === 'audio') ||
         (inlineDocs && att.kind === 'video'));

      if (canInline) {
        parts.push({
          inlineData: {
            mimeType: att.mimeType,
            data: att.data,
          },
        });
        parts.push({ text: att.scaledNote
          ? `[Attached IMAGE: ${att.name} (${att.scaledNote})]`
          : `[Attached ${att.kind.toUpperCase()}: ${att.name} (${((att.size || 0) / 1024).toFixed(1)} KB)]` });
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
    // Validated browser-made copy (see validateClaudeScaledCopy); only used when
    // the original is over Anthropic's cap. Other providers always get att.data.
    const useClaudeScaled = Boolean(
      att.kind === 'image' &&
      att.data &&
      att.data.length > CLAUDE_MAX_IMAGE_BASE64_CHARS &&
      att.claudeDataBase64 &&
      att.claudeDataBase64.length <= CLAUDE_MAX_IMAGE_BASE64_CHARS &&
      CLAUDE_SUPPORTED_IMAGE_MIMES.has(att.claudeMimeType)
    );
    const claudeImgData = useClaudeScaled ? att.claudeDataBase64 : att.data;
    const claudeImgMime = useClaudeScaled ? att.claudeMimeType : att.mimeType;

    const canSendImage =
      allowImages &&
      att.kind === 'image' &&
      CLAUDE_SUPPORTED_IMAGE_MIMES.has(claudeImgMime) &&
      claudeImgData &&
      claudeImgData.length <= CLAUDE_MAX_IMAGE_BASE64_CHARS &&
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
          media_type: claudeImgMime,
          data: claudeImgData,
        },
      });
      blocks.push({
        type: 'text',
        text: att.scaledNote
          ? `[Attached Image: ${att.name} (${att.scaledNote})]`
          : (useClaudeScaled
            ? `[Attached Image: ${att.name} (auto-scaled to <5 MB for Claude's vision API cap)]`
            : `[Attached Image: ${att.name}]`),
      });
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
      if (att.scaledNote) content.push({ type: 'input_text', text: `[Attached Image: ${att.name} (${att.scaledNote})]` });
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
      content.push({ type: 'text', text: att.scaledNote ? `[Attached Image: ${att.name} (${att.scaledNote})]` : `[Attached Image: ${att.name}]` });
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
  CLAUDE_MAX_IMAGE_BASE64_CHARS,
  // Read-only view of the attachment cache for tests / diagnostics.
  _cacheStats: () => ({ entries: ATTACHMENT_CACHE.size, bytes: cacheBytes, sha1Aliases: SHA1_INDEX.size, keys: [...ATTACHMENT_CACHE.keys()] }),
};
