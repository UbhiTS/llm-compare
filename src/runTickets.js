// ---------------------------------------------------------------------------
// runTickets.js - per-run quota tickets for the Image Arena.
//
// One rule for the whole app (text + image): a run, i.e. one Run click, is
// charged ONCE per daily budget it touches on the global keys (the OpenAI
// budget and, for external accounts, the Vertex budget), however many models
// it compares. A text run is one request, so /api/run charges it directly.
// The Image Arena sends each slot as its own parallel request (to stay under
// Cloud Run's 32 MiB response cap), so POST /api/image-arena/reserve charges
// the whole run up front and returns a ticket; every slot request of that run
// presents the ticket and is not charged again.
//
// Guards: a ticket belongs to one user, covers only the slots (slot letter +
// model) it was reserved for, each slot is usable once, and it expires. If
// every slot of a run is abandoned by the client before finishing, the run is
// refunded, the same as an abandoned text run.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const TICKET_TTL_MS = 30 * 60 * 1000;
const MAX_TICKETS_PER_USER = 50; // bounds memory; own-key reserves aren't charged, so cap them
const tickets = new Map(); // id -> ticket

function create({ username, slots, kind, charged }) {
  const user = String(username || '');
  // Evict this user's oldest tickets past the cap (Map iterates in insertion order).
  const mine = [];
  for (const [id, t] of tickets) if (t.username === user) mine.push(id);
  while (mine.length >= MAX_TICKETS_PER_USER) tickets.delete(mine.shift());

  const now = Date.now();
  const t = {
    id: crypto.randomBytes(16).toString('hex'),
    username: user,
    kind: kind === 'single' ? 'single' : 'compare',
    slots: new Map((Array.isArray(slots) ? slots : []).map((s) => [String(s.slot), String(s.id)])),
    used: new Set(),
    settled: new Set(),
    completedAny: false,
    refunded: false,
    // Budgets this run has been charged for (e.g. ['openai', 'vertex']); slot requests
    // top up anything missing at most once per run.
    charged: Array.isArray(charged) ? charged.filter((p) => typeof p === 'string') : [],
    createdAt: now,
    expiresAt: now + TICKET_TTL_MS,
  };
  tickets.set(t.id, t);
  return t;
}

// The caller's live ticket, or null (unknown, expired, malformed, or someone else's).
function get(id, username) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return null;
  const t = tickets.get(id);
  if (!t) return null;
  if (Date.now() > t.expiresAt) { tickets.delete(id); return null; }
  if (t.username !== String(username || '')) return null;
  return t;
}

// Claim one reserved slot: the slot letter AND model must match the reservation,
// and each slot can be claimed only once.
function claimSlot(t, slot, catalogId) {
  const key = String(slot);
  if (!t || !t.slots.has(key) || t.used.has(key)) return false;
  if (t.slots.get(key) !== String(catalogId)) return false;
  t.used.add(key);
  return true;
}

// Record how a claimed slot ended. Returns true exactly once: when every reserved
// slot has settled, none of them completed, so the caller should refund the run.
function settleSlot(t, slot, { abandoned } = {}) {
  if (!t) return false;
  t.settled.add(String(slot));
  if (!abandoned) t.completedAny = true;
  if (t.settled.size >= t.slots.size && !t.completedAny && !t.refunded) {
    t.refunded = true;
    return true;
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tickets) if (now > t.expiresAt) tickets.delete(id);
}, 5 * 60 * 1000).unref();

module.exports = { create, get, claimSlot, settleSlot, TICKET_TTL_MS, MAX_TICKETS_PER_USER, _tickets: tickets };
