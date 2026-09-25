// ---------------------------------------------------------------------------
// imageInfo.js — read an image's pixel dimensions from its header bytes.
//
// Built-ins only (no image codec, no new dependency): PNG IHDR, GIF logical
// screen, WebP VP8/VP8L/VP8X and JPEG SOFn markers. Used to apply providers'
// documented pixel limits up front (e.g. OpenAI's 30,000-patch cap) and to
// validate browser-made scaled copies. Never throws; returns null if unknown.
// ---------------------------------------------------------------------------

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDims(buf) {
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    let marker = buf[off + 1];
    while (marker === 0xff && off + 2 < buf.length) { off++; marker = buf[off + 1]; } // fill bytes
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan before any SOF
    const len = buf.readUInt16BE(off + 2);
    if (JPEG_SOF.has(marker)) {
      const height = buf.readUInt16BE(off + 5);
      const width = buf.readUInt16BE(off + 7);
      return width && height ? { width, height } : null;
    }
    if (len < 2) return null;
    off += 2 + len;
  }
  return null;
}

function imageDimensionsFromBuffer(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
    // PNG: signature + IHDR chunk (width/height big-endian at 16/20).
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF: logical screen width/height, little-endian at 6/8.
    const sig6 = buf.toString('latin1', 0, 6);
    if (sig6 === 'GIF87a' || sig6 === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // WebP (RIFF container).
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' && buf.length >= 30) {
      const fourcc = buf.toString('latin1', 12, 16);
      if (fourcc === 'VP8X') {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
      if (fourcc === 'VP8L') {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        return {
          width: 1 + (((b1 & 0x3f) << 8) | b0),
          height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        };
      }
      if (fourcc === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      return null;
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpegDims(buf);
  } catch (_) { /* malformed header */ }
  return null;
}

// Decode only a prefix first (headers are near the start); a JPEG whose SOF sits
// behind a large EXIF/ICC block falls back to decoding the whole payload.
const PREFIX_B64_CHARS = 256 * 1024;
function imageDimensionsFromBase64(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  const head = b64.length > PREFIX_B64_CHARS ? b64.slice(0, PREFIX_B64_CHARS) : b64;
  const dims = imageDimensionsFromBuffer(Buffer.from(head, 'base64'));
  if (dims || head.length === b64.length) return dims;
  return imageDimensionsFromBuffer(Buffer.from(b64, 'base64'));
}

module.exports = { imageDimensionsFromBuffer, imageDimensionsFromBase64 };
