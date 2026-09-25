// ---------------------------------------------------------------------------
// attachmentWorker.js — worker_threads pool for PDF / ZIP / Office text
// extraction so a large document never blocks the Express event loop.
//
// The same file is both the pool (main thread) and the worker entry (when
// loaded with workerData.llmcAttachmentWorker). Workers run the exact same
// extractor code as the inline path (attachments.extractForWorker), so the
// inflate caps (ATTACHMENT_MAX_INFLATE_MB) apply unchanged, and each worker
// additionally has a V8 heap ceiling (resourceLimits) so a hostile file can't
// take the whole instance down.
//
// Env:
//   ATTACHMENT_WORKERS            pool size (default 2; 0 = parse inline)
//   ATTACHMENT_WORKER_HEAP_MB     per-worker old-generation heap cap (default 256)
//   ATTACHMENT_WORKER_TIMEOUT_MS  per-file timeout; worker is recycled (default 30000)
//   ATTACHMENT_WORKER_MIN_BYTES   only offload files at least this big (default 0)
// Built-ins only — no new dependencies.
// ---------------------------------------------------------------------------
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread && workerData && workerData.llmcAttachmentWorker) {
  const { extractForWorker } = require('./attachments');
  parentPort.on('message', ({ id, op, bytes }) => {
    try {
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      parentPort.postMessage({ id, ok: true, result: extractForWorker(op, buf) });
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: String((e && e.message) || e) });
    }
  });
} else {
  const num = (v, d) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? n : d; };
  const size = () => Math.floor(num(process.env.ATTACHMENT_WORKERS, 2));
  const heapMb = () => Math.max(32, num(process.env.ATTACHMENT_WORKER_HEAP_MB, 256));
  const timeoutMs = () => Math.max(1000, num(process.env.ATTACHMENT_WORKER_TIMEOUT_MS, 30000));

  const pool = [];     // { w, busy, pending: Map }
  let seq = 0;
  const queue = [];

  function spawn() {
    const w = new Worker(__filename, {
      workerData: { llmcAttachmentWorker: true },
      resourceLimits: { maxOldGenerationSizeMb: heapMb() },
    });
    const slot = { w, busy: null };
    w.unref();
    w.on('message', (msg) => {
      const job = slot.busy;
      if (!job || job.id !== msg.id) return;
      clearTimeout(job.timer);
      slot.busy = null;
      if (msg.ok) job.resolve(msg.result); else job.reject(new Error(msg.error));
      pump();
    });
    const die = (err) => {
      const job = slot.busy;
      slot.busy = null;
      const i = pool.indexOf(slot);
      if (i >= 0) pool.splice(i, 1);
      if (job) { clearTimeout(job.timer); job.reject(err || new Error('attachment worker exited')); }
      pump();
    };
    w.on('error', die);
    w.on('exit', (code) => die(new Error(`attachment worker exited (${code})`)));
    pool.push(slot);
    return slot;
  }

  function pump() {
    while (queue.length) {
      let slot = pool.find((s) => !s.busy);
      if (!slot && pool.length < size()) slot = spawn();
      if (!slot) return;
      const job = queue.shift();
      slot.busy = job;
      job.timer = setTimeout(() => {
        // Recycle a stuck worker; the caller falls back to inline parsing.
        slot.w.terminate().catch(() => {});
      }, timeoutMs());
      slot.w.postMessage({ id: job.id, op: job.op, bytes: job.bytes });
    }
  }

  function extractInWorker(op, buf) {
    return new Promise((resolve, reject) => {
      // Copy into a standalone ArrayBuffer (Buffers are often pool slices).
      const bytes = new Uint8Array(buf.byteLength);
      bytes.set(buf);
      queue.push({ id: ++seq, op, bytes, resolve, reject });
      pump();
    });
  }

  module.exports = {
    extractInWorker,
    enabled: () => size() > 0,
    minBytes: () => num(process.env.ATTACHMENT_WORKER_MIN_BYTES, 0),
    _poolSize: () => pool.length,
  };
}
