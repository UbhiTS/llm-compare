// ---------------------------------------------------------------------------
// multipart.js — minimal, bounded multipart/form-data parser (RFC 7578) for the
// attachment upload path. Built-ins only (no busboy/multer), operates on a
// Buffer that express.raw() has already size-limited.
//
// Limits: maxParts (all parts), maxFiles (file parts), maxFileBytes (per file),
// maxFieldBytes (per text field). Header block per part capped at 8 KB.
// Filenames are returned raw — callers MUST sanitize (attachments.js does).
// ---------------------------------------------------------------------------

class MultipartError extends Error {
  constructor(msg) { super(msg); this.name = 'MultipartError'; this.status = 400; }
}

function getBoundary(contentType) {
  const m = /^\s*multipart\/form-data\s*;(.*)$/i.exec(String(contentType || ''));
  if (!m) return null;
  const b = /(?:^|;)\s*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(m[1]);
  return b ? (b[1] || b[2]) : null;
}

function parseDisposition(value) {
  const out = {};
  // name="x"; filename="y"  (quoted-string values; backslash-escaped quotes)
  const re = /;\s*([a-zA-Z*]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g;
  let m;
  const params = value.replace(/^[^;]*/, '');
  while ((m = re.exec(params)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2] != null ? m[2].replace(/\\(.)/g, '$1') : m[3];
    if (key === 'filename*') {
      const ext = /^[^']*'[^']*'(.*)$/.exec(val);
      try { out.filename = decodeURIComponent(ext ? ext[1] : val); } catch (_) { /* keep plain filename */ }
    } else if (!(key === 'filename' && out.filename)) {
      out[key] = val;
    }
  }
  return out;
}

function parseMultipart(body, contentType, { maxParts = 64, maxFiles = 10, maxFileBytes = Infinity, maxFieldBytes = 64 * 1024 } = {}) {
  if (!Buffer.isBuffer(body)) throw new MultipartError('Expected a multipart/form-data body.');
  const boundary = getBoundary(contentType);
  if (!boundary) throw new MultipartError('Missing multipart boundary.');
  const delim = Buffer.from('--' + boundary);
  const files = [];
  const fields = Object.create(null);

  let pos = body.indexOf(delim);
  if (pos < 0) throw new MultipartError('Malformed multipart body.');
  let parts = 0;
  for (;;) {
    pos += delim.length;
    // Closing delimiter "--"
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    // Expect CRLF after the delimiter
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else throw new MultipartError('Malformed multipart delimiter.');

    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0 || headerEnd - pos > 8192) throw new MultipartError('Malformed or oversized part headers.');
    const headers = Object.create(null);
    for (const line of body.subarray(pos, headerEnd).toString('utf8').split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const dataStart = headerEnd + 4;
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), dataStart);
    if (next < 0) throw new MultipartError('Unterminated multipart part.');
    const data = body.subarray(dataStart, next);

    if (++parts > maxParts) throw new MultipartError(`Too many parts (max ${maxParts}).`);
    const disp = parseDisposition(headers['content-disposition'] || '');
    if (!disp.name && disp.filename == null) throw new MultipartError('Part without Content-Disposition name.');
    if (disp.filename != null) {
      if (files.length >= maxFiles) throw new MultipartError(`Too many files (max ${maxFiles}).`);
      if (data.length > maxFileBytes) throw new MultipartError(`File "${String(disp.filename).slice(0, 80)}" is too large.`);
      files.push({ field: disp.name || '', filename: String(disp.filename), contentType: headers['content-type'] || '', data: Buffer.from(data) });
    } else {
      if (data.length > maxFieldBytes) throw new MultipartError(`Field "${String(disp.name).slice(0, 40)}" is too large.`);
      if (disp.name !== '__proto__') fields[disp.name] = data.toString('utf8');
    }
    pos = next + 2; // skip CRLF, land on the next delimiter
  }
  return { files, fields };
}

module.exports = { parseMultipart, getBoundary, MultipartError };
