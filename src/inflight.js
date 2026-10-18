// ---------------------------------------------------------------------------
// inflight.js - tiny in-memory in-flight counters for per-user and global
// concurrency caps (streams, image generations, pygbag builds, large uploads).
//
// This is capacity protection for the single instance, not quota: admins are
// not exempt, nothing is persisted, and a process restart resets every counter.
//
//   const lease = inflight.acquire('run:' + username, 3);
//   if (!lease.ok) return res.status(429).json({ error: '...' });
//   try { ... } finally { lease.release(); }
//
// acquireAll([[key, limit], ...]) takes every lease or none (so a request that
// passes its per-user cap but not the global one leaves no counter behind).
// release() is idempotent: calling it twice never frees someone else's slot.
// ---------------------------------------------------------------------------
const counters = new Map(); // key -> number currently in flight

function count(key) {
  return counters.get(String(key)) || 0;
}

function acquire(key, limit) {
  const k = String(key);
  const max = Number(limit);
  const cur = counters.get(k) || 0;
  if (Number.isFinite(max) && cur >= max) return { ok: false, release: () => {} };
  counters.set(k, cur + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const n = (counters.get(k) || 1) - 1;
      if (n <= 0) counters.delete(k);
      else counters.set(k, n);
    },
  };
}

function acquireAll(pairs) {
  const taken = [];
  for (const [key, limit] of Array.isArray(pairs) ? pairs : []) {
    const lease = acquire(key, limit);
    if (!lease.ok) {
      for (const t of taken) t.release();
      return { ok: false, release: () => {} };
    }
    taken.push(lease);
  }
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      for (const t of taken) t.release();
    },
  };
}

module.exports = { acquire, acquireAll, count };
