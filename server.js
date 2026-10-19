// ---------------------------------------------------------------------------
// LLM Agent Arena — server
//
// Serves the static UI and exposes:
//   GET  /api/config   -> default models, tasks, and which API keys are present
//   POST /api/run      -> streams NDJSON events while the agents run in parallel
//   POST /api/execute  -> runs LLM-generated code (python/js)
//   /api/auth/*        -> username/password auth (see src/auth.js)
//
// Authentication is mandatory: every page and API route except the public auth
// subset is gated behind a server-side session. Hardened for internet exposure
// (scrypt password hashing, opaque session cookies, brute-force lockout, CSP,
// first-run setup code). API keys live in .env and never leave the server.
// ---------------------------------------------------------------------------

require('dotenv').config();
// Structured JSON logs (Cloud Logging severity + secret redaction) on Cloud Run
// or with LOG_FORMAT=json; plain text locally. Must run before anything logs.
const log = require('./src/log');
log.install();
const path = require('path');
const os = require('os');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const express = require('express');
const pkg = require('./package.json');
const LAST_UPDATED_ISO = (() => {
  if (pkg.lastUpdated) return String(pkg.lastUpdated);
  try {
    return fs.statSync(path.join(__dirname, 'package.json')).mtime.toISOString();
  } catch (_) {
    return new Date().toISOString();
  }
})();
const BOOT_ID = crypto.randomBytes(4).toString('hex');

const { runComparison } = require('./src/orchestrator');
const { thinkingProfile, thinkingOptions } = require('./src/providers');
const { DEFAULT_MODELS, MODEL_CATALOG, RETIRED_REPLACEMENT, resolveModels } = require('./src/pricing');
const { TASKS } = require('./src/tasks');
const { autoMintEnabled } = require('./src/gcloudToken');
const { runCode, executionEnabled } = require('./src/codeRunner');
const { judgeOutputs } = require('./src/judge');
const { buildWebGame, gameDir, webGameEnabled } = require('./src/webGame');
const history = require('./src/history');
const auth = require('./src/auth');
const googleAuth = require('./src/googleAuth');
const globalKeys = require('./src/globalKeys');
// Strict BYOK: single source of truth for "does this model run on the user's own
// credential" - own-key models never touch shared keys and never count toward caps.
const { modelUsesOwnKey } = require('./src/byok');
// Admin Settings: per-provider daily run limits on the global keys + internal admins.
const appSettings = require('./src/appSettings');
// Image Arena per-run quota tickets (one charge per Run click, not per slot).
const runTickets = require('./src/runTickets');
// Month-to-date spend on the global keys: app-tracked ledger + provider-reported numbers.
const spendLedger = require('./src/spendLedger');
const providerBilling = require('./src/providerBilling');
const { callCostUsd } = require('./src/pricing');
const { normalizeAttachmentsAsync, inspectAttachmentsAsync, MAX_ATTACHMENTS } = require('./src/attachments');
const { isCadTask, wrapTaskForCadArena, transpileToFusion360Python, getCadMcpStatus } = require('./src/cadArena');
const { parseMultipart } = require('./src/multipart');
const { scrubError, maskKnown } = require('./src/secrets');
const { buildComparisonPdf, pdfFilename } = require('./src/pdfReport');
const { IMAGE_MODEL_CATALOG, DEFAULT_IMAGE_SLOTS, getImageArenaConfig, runImageArenaComparison } = require('./src/imageArena');
// Per-user / global in-flight caps (capacity protection on the single instance; admins included).
const inflight = require('./src/inflight');

// Express 4 does not catch a rejected promise from an async handler: the request
// would hang with no response. Every async route goes through wrap() so a throw
// reaches the JSON error middleware at the bottom of this file.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TOO_MANY_CONCURRENT = 'Too many concurrent requests, wait for the current one to finish.';
// auth.js throws a BUSY error when its scrypt semaphore is full: answered as 503, never
// as a wrong password / lockout strike (3.11).
const isAuthBusy = (e) => typeof auth.isBusyError === 'function' && auth.isBusyError(e);
const MAX_CONCURRENT_RUNS_PER_USER = 3;        // /api/run NDJSON streams
const MAX_CONCURRENT_IMAGE_PER_USER = 6;       // /api/image-arena/run requests (up to 6 parallel slots)
const MAX_CONCURRENT_IMAGE_GLOBAL = 18;
const MAX_CONCURRENT_WEB_GAME_PER_USER = 6;    // pygbag builds (up to 6 parallel slots)
const MAX_CONCURRENT_WEB_GAME_GLOBAL = 12;
const MAX_CONCURRENT_LARGE_UPLOADS_PER_USER = 2; // multipart bodies over 1 MB
const LARGE_UPLOAD_BYTES = 1024 * 1024;

// Resolve request attachments (PDF/ZIP parsing runs in worker threads). If the
// request references cached files that have expired, answer 409 with the list
// so the client can re-upload — never run with an empty file. Returns null when
// a response has already been sent.
async function attachmentsOr409(req, res, raw, errorShape) {
  try {
    return await normalizeAttachmentsAsync(raw, {
      username: req && req.user && req.user.username,
      isAdmin: Boolean(req && req.user && req.user.role === 'admin'),
    });
  } catch (e) {
    if (e && e.code === 'ATTACHMENT_EXPIRED') {
      res.status(409).json({ ...errorShape, code: 'ATTACHMENT_EXPIRED', error: scrubError(e.message), expired: e.expired });
      return null;
    }
    res.status(400).json({ ...errorShape, error: scrubError(String((e && e.message) || e)) });
    return null;
  }
}

const app = express();
app.disable('x-powered-by');
// Case-sensitive routing (3.8): without it `/API/run` matched the `/api/run` route
// while every `req.path.startsWith('/api/')` guard (force-password-change gate,
// access log, auth gate) missed it. Must be set before the first app.use().
app.set('case sensitive routing', true);
// Only trust X-Forwarded-* when explicitly behind a known reverse proxy. Trusting it
// by default would let a directly-exposed server be fed spoofed X-Forwarded-For headers,
// defeating per-IP brute-force lockout. Set TRUST_PROXY=1 (hop count) or =true behind
// nginx/Cloudflare/a tunnel so client IP + HTTPS detection work correctly.
const TP = process.env.TRUST_PROXY;
app.set('trust proxy', (TP == null || TP === '' || TP === '0' || TP.toLowerCase() === 'false')
  ? false
  : (/^\d+$/.test(TP) ? Number(TP) : true));

// Cached login page (inline CSS/JS, served with a per-request CSP nonce).
const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8');

// ---------- security headers (applied to every response) ----------
app.use((req, res, next) => {
  const peer = (req.socket && req.socket.remoteAddress) || '';
  const isLoopbackPeer = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1' || req.hostname === '::1'
    || (isLoopbackPeer && !!process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!isLocal) res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'self'",
    isLocal ? "frame-ancestors *" : "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '));
  next();
});

function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

// Defense in depth (R6): every /api/* response body — JSON, NDJSON stream,
// errors — has any configured secret value (server keys + this request's BYOK
// keys) masked before it leaves the process. Exact-value masking only, so
// normal model output is never rewritten. Matched on the lower-cased path (not an
// app.use('/api') mount) so a case-variant path can't dodge it.
app.use((req, res, next) => {
  if (!req.path.toLowerCase().startsWith('/api/')) return next();
  setNoCacheHeaders(res);
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  // Already-compressed bodies (gzipJson scrubs the JSON text BEFORE compressing)
  // are skipped: masking compressed bytes is meaningless.
  const textual = () => !res.getHeader('Content-Encoding') && /json|ndjson|text/i.test(String(res.getHeader('Content-Type') || 'application/json'));
  const scrub = (chunk, enc) => {
    if (chunk == null || !textual()) return chunk;
    const byok = (req.body && typeof req.body === 'object' && req.body.keys) || null;
    if (typeof chunk === 'string') return maskKnown(chunk, byok);
    if (Buffer.isBuffer(chunk)) {
      const str = chunk.toString('utf8');
      const masked = maskKnown(str, byok);
      return masked === str ? chunk : Buffer.from(masked, 'utf8');
    }
    return chunk;
  };
  res.write = (chunk, enc, cb) => origWrite(scrub(chunk, enc), enc, cb);
  res.end = (chunk, enc, cb) => {
    if (typeof chunk === 'function') return origEnd(chunk);
    const out = scrub(chunk, enc);
    // res.send() set Content-Length for the unmasked body; keep it consistent.
    if (out !== chunk && out != null && !res.headersSent) res.setHeader('Content-Length', Buffer.byteLength(out));
    return origEnd(out, enc, cb);
  };
  next();
});

// Operational observability: Structured HTTP access log for /api/* and error responses
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const lowerPath = req.path.toLowerCase();
    if (lowerPath.startsWith('/api/') || (res.statusCode >= 400 && lowerPath !== '/healthz')) {
      const dur = Date.now() - start;
      const user = (req.user && req.user.username) || 'anon';
      const sev = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARNING' : 'INFO';
      log.event(sev, `[http] ${req.method} ${req.path} ${res.statusCode} ${dur}ms - user:${user}`, {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durMs: dur,
        user,
      });
    }
  });
  next();
});

// Large enough for multiple base64 image/PDF/document attachments plus 1M-token judge runs.
// SECURITY: the 50 MB parser is mounted only AFTER the auth gate (see below), so an
// unauthenticated client can't make the server buffer + JSON.parse 50 MB bodies. The
// few public POST routes (login / first-run setup) get a small parser here instead.
const jsonBodyError = (err, _req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      type: 'error',
      error: 'Total attachment payload exceeds the 50 MB server request limit. Please remove one or more large files and try again.',
    });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ type: 'error', error: 'Invalid JSON request payload.' });
  }
  return next(err);
};
const PUBLIC_JSON_PATHS = new Set(['/api/auth/login', '/api/auth/setup']);
const publicJson = express.json({ limit: process.env.PUBLIC_JSON_LIMIT || '64kb' });
app.use((req, res, next) => (PUBLIC_JSON_PATHS.has(req.path.toLowerCase()) ? publicJson(req, res, next) : next()));
app.use(jsonBodyError);
app.use(auth.cookieParser);

// ===========================================================================
// PUBLIC routes (no authentication required)
// ===========================================================================

// Health check for the Cloud Run startup probe (and uptime checks). Returns 503
// while draining after SIGTERM so no new work is routed here. No auth, no
// secrets, no dependencies touched. /api/health is an alias that is also
// reachable through the Cloud Run frontend (paths ending in "z" are reserved
// there; container-level probes are unaffected).
let draining = false;
app.get(['/healthz', '/api/health'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (draining) return res.status(503).json({ ok: false, status: 'draining' });
  return res.json({ ok: true, status: 'ok' });
});

const FAVICON_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">' +
  '<defs>' +
  '<linearGradient id="bg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0d1324"/><stop offset="0.55" stop-color="#131b31"/><stop offset="1" stop-color="#090d18"/></linearGradient>' +
  '<linearGradient id="rim" x1="6" y1="6" x2="58" y2="58" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2fd9a6" stop-opacity="0.8"/><stop offset="0.5" stop-color="#5e8bff" stop-opacity="0.6"/><stop offset="1" stop-color="#ff8a65" stop-opacity="0.8"/></linearGradient>' +
  '<linearGradient id="lt" x1="12" y1="12" x2="30" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2fd9a6"/><stop offset="1" stop-color="#3b82f6"/></linearGradient>' +
  '<linearGradient id="lb" x1="12" y1="30" x2="30" y2="52" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient>' +
  '<linearGradient id="rt" x1="52" y1="12" x2="34" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff9e6d"/><stop offset="1" stop-color="#ec4899"/></linearGradient>' +
  '<linearGradient id="rb" x1="52" y1="30" x2="34" y2="52" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#a855f7"/><stop offset="1" stop-color="#6d5bd0"/></linearGradient>' +
  '<linearGradient id="core" x1="25" y1="24" x2="39" y2="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffffff"/><stop offset="0.45" stop-color="#b9f6ca"/><stop offset="1" stop-color="#5e8bff"/></linearGradient>' +
  '</defs>' +
  '<rect x="2" y="2" width="60" height="60" rx="14" fill="url(#bg)" stroke="url(#rim)" stroke-width="2"/>' +
  '<polygon points="32,7 53,19 53,45 32,57 11,45 11,19" fill="none" stroke="#5e8bff" stroke-opacity="0.24" stroke-width="1"/>' +
  '<polygon points="13,20 29,11 29,30 13,32" fill="url(#lt)"/>' +
  '<polygon points="13,32 29,30 29,53 13,44" fill="url(#lb)"/>' +
  '<polygon points="51,20 35,11 35,30 51,32" fill="url(#rt)"/>' +
  '<polygon points="51,32 35,30 35,53 51,44" fill="url(#rb)"/>' +
  '<line x1="32" y1="7" x2="32" y2="57" stroke="#cfe0ff" stroke-opacity="0.45" stroke-width="1.5" stroke-dasharray="2 2"/>' +
  '<polygon points="32,20 42,32 32,44 22,32" fill="#0b101d" stroke="#5e8bff" stroke-opacity="0.7" stroke-width="1.25"/>' +
  '<polygon points="32,24.5 38.2,32 32,39.5 25.8,32" fill="url(#core)"/>' +
  '</svg>',
  'utf8'
);
app.get('/favicon.ico', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  setNoCacheHeaders(res);
  res.setHeader('Content-Length', String(FAVICON_SVG.length));
  res.end(FAVICON_SVG);
});

// Login / first-run setup page. Strict per-response CSP with a fresh nonce so
// the inline <style>/<script> run but nothing else can.
app.get(['/login', '/login.html'], (req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  setNoCacheHeaders(res);
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.type('html').send(LOGIN_HTML.replace(/__NONCE__/g, nonce));
});

app.get('/api/auth/status', (req, res) => {
  const s = auth.getSession(req);
  const autoLocal = !s && !process.env.K_SERVICE && process.env.LOCAL_AUTO_AUTH !== '0' && isLocalAutoAuthRequest(req)
    ? { username: 'ubhi@google.com', role: 'admin', external: true, mustChangePassword: false }
    : null;
  const eff = s || autoLocal;
  res.json({
    setupRequired: autoLocal ? false : auth.setupRequired(),
    authenticated: !!eff,
    user: eff ? { username: eff.username, role: eff.role, external: !!eff.external, mustChangePassword: !!(eff && !eff.external && eff.mustChangePassword) } : null,
    googleAuth: googleAuth.googleAuthEnabled(),
    allowedDomains: googleAuth.allowedDomains(),
  });
});

// First-run only: create the admin account. Gated by the console setup code.
app.post('/api/auth/setup', wrap(async (req, res) => {
  const ip = req.ip;
  const key = 'setup|' + ip;
  const gkey = 'setup|global'; // also throttle globally so an IP-rotating attacker can't brute the code
  if (auth.isLocked(key) || auth.isLocked(gkey)) return res.status(429).json({ error: 'Too many attempts. Please wait and retry.' });
  if (!auth.setupRequired()) return res.status(409).json({ error: 'Setup already completed. Please sign in.' });
  if (!auth.verifySetupCode(req.body && req.body.code)) {
    auth.recordFailure(key);
    auth.recordFailure(gkey);
    return res.status(403).json({ error: 'Invalid setup code — check the server console.' });
  }
  try {
    const user = await auth.setupAdmin(String((req.body && req.body.password) || ''));
    auth.recordSuccess(key);
    auth.setSessionCookie(req, res, auth.createSession(user));
    res.json({ ok: true, user: { username: user.username, role: user.role } });
  } catch (e) {
    if (isAuthBusy(e)) return res.status(503).json({ error: e.message });
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const ip = req.ip;
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const ukey = 'login|' + ip + '|' + username;
  const ipkey = 'loginip|' + ip;
  if (auth.isLocked(ukey) || auth.isLocked(ipkey)) {
    const ms = Math.max(auth.lockRemainingMs(ukey), auth.lockRemainingMs(ipkey));
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(ms / 1000)}s.` });
  }
  // Per-username lockout (independent of IP, 3.11): answer up front, before scrypt runs.
  if (typeof auth.isUsernameLocked === 'function' && username && auth.isUsernameLocked(username)) {
    const ms = typeof auth.usernameLockRemainingMs === 'function' ? auth.usernameLockRemainingMs(username) : 0;
    return res.status(429).json({ error: `Too many attempts for this account. Try again in ${Math.max(1, Math.ceil(ms / 1000))}s.` });
  }
  let user;
  try {
    user = await auth.authenticate(username, password, { includeExpired: true });
  } catch (e) {
    // Overload (the scrypt semaphore is full) is not "wrong password": 503, no lockout counter.
    if (isAuthBusy(e)) return res.status(503).json({ error: e.message });
    throw e;
  }
  if (!user) {
    auth.recordFailure(ukey);
    auth.recordFailure(ipkey);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  if (user.expired) {
    auth.recordSuccess(ukey);
    auth.recordSuccess(ipkey);
    return res.status(403).json({
      code: 'ACCOUNT_EXPIRED',
      error: `This external account expired on ${user.expiresAt || 'its expiration date'}. Please contact the administrator.`,
    });
  }
  auth.recordSuccess(ukey);
  auth.recordSuccess(ipkey);
  auth.setSessionCookie(req, res, auth.createSession(user));
  res.json({
    ok: true,
    mustChangePassword: !!user.mustChangePassword,
    user: {
      username: user.username,
      role: user.role,
      mustChangePassword: !!user.mustChangePassword,
      expiresAt: user.expiresAt || null,
      dailyVertexLimit: user.dailyVertexLimit || null,
    },
  });
}));

// Sign in with Google (OIDC), restricted to the allowed Workspace domain(s). startLogin
// binds state + nonce to this browser with a one-shot cookie that the callback requires (3.4).
app.get('/auth/google/login', (req, res) => {
  if (!googleAuth.googleAuthEnabled()) return res.redirect('/login?error=' + encodeURIComponent('Google sign-in is not configured.'));
  const url = typeof googleAuth.startLogin === 'function' ? googleAuth.startLogin(req, res) : googleAuth.authUrl(req, res);
  res.redirect(url);
});
app.get('/auth/google/callback', wrap(async (req, res) => {
  if (!googleAuth.googleAuthEnabled()) return res.redirect('/login');
  try {
    const user = await googleAuth.handleCallback(req, req.query.code, req.query.state, res);
    auth.setSessionCookie(req, res, auth.createSession(user));
    res.redirect('/');
  } catch (e) {
    res.redirect('/login?error=' + encodeURIComponent(scrubError(String((e && e.message) || e))));
  }
}));

// Public OAuth Branding compliance pages (/privacy and /terms) so the OAuth consent
// screen can be published to "In production" without failing URL reachability checks.
app.get('/privacy', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Privacy Policy — LLM Compare</title>
  <style>body{font-family:system-ui,-apple-system,sans-serif;background:#0b0f17;color:#e6edf3;max-width:680px;margin:48px auto;padding:0 24px;line-height:1.6}h1{font-size:22px}a{color:#5e8bff}</style></head>
  <body><h1>Privacy Policy — LLM Compare</h1>
  <p><strong>LLM Compare</strong> is an internal Google Cloud evaluation &amp; benchmarking demonstration hosted on Google Cloud Run.</p>
  <ul>
    <li><strong>Data Collected:</strong> When you sign in with Google OIDC (<code>openid email profile</code>), only your verified Workspace email address and display name are read to verify organization membership (<code>google.com</code> / <code>ubhi.altostrat.com</code>) and enforce per-user daily benchmark run quotas.</li>
    <li><strong>Data Storage:</strong> Benchmark run histories and token metrics are stored in Google Cloud Storage within the demo project. Optional user-supplied API keys are used transiently in memory for that request only and are never persisted to disk.</li>
    <li><strong>Data Sharing:</strong> No user identity or prompt data is sold or shared with third parties outside the model APIs explicitly selected during a comparison run.</li>
    <li><strong>Contact:</strong> <a href="mailto:ubhi@google.com">ubhi@google.com</a></li>
  </ul>
  <p><a href="/login">← Back to Sign In</a></p></body></html>`);
});

app.get('/terms', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Terms of Service — LLM Compare</title>
  <style>body{font-family:system-ui,-apple-system,sans-serif;background:#0b0f17;color:#e6edf3;max-width:680px;margin:48px auto;padding:0 24px;line-height:1.6}h1{font-size:22px}a{color:#5e8bff}</style></head>
  <body><h1>Terms of Service — LLM Compare</h1>
  <p><strong>LLM Compare</strong> is provided strictly for internal evaluation, benchmarking, and demonstration purposes by authorized Google Workspace users.</p>
  <ul>
    <li><strong>Authorized Use:</strong> Access is restricted to authorized Workspace domains (<code>google.com</code> and <code>ubhi.altostrat.com</code>). Do not submit customer confidential or regulated PII data into benchmark prompts.</li>
    <li><strong>Usage Limits:</strong> Shared credentials are subject to per-user daily execution caps.</li>
    <li><strong>Disclaimer:</strong> Provided "as-is" without warranty for demonstration and model evaluation workflows.</li>
    <li><strong>Contact:</strong> <a href="mailto:ubhi@google.com">ubhi@google.com</a></li>
  </ul>
  <p><a href="/login">← Back to Sign In</a></p></body></html>`);
});

// ---------- sandbox documents + their module imports (served BEFORE the auth gate) ----------
// The CAD runner and the pygbag games are framed WITHOUT allow-same-origin, so they
// run from an opaque origin: their module imports (/vendor/three/*, /cad-kernel.js)
// and bundle fetches are cookie-less CORS requests that would otherwise 302 to
// /login. Nothing here is user data: Three.js, the CAD kernel, the runner page and
// generated game bundles (unguessable sha256-prefix ids). Every response carries
// Access-Control-Allow-Origin: * and Cross-Origin-Resource-Policy: cross-origin so
// the opaque-origin document may load it; the frame-ancestors / X-Frame-Options
// headers still limit framing to this origin.
const PUBLIC_DIR = path.join(__dirname, 'public');
function setSandboxAssetHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

// Serve Three.js locally from node_modules/three so the 3D & CAD Arena viewport
// has zero external CDN dependencies and works reliably behind strict CSPs.
const THREE_VENDOR_DIR = path.join(__dirname, 'node_modules', 'three');
const threeStaticOpts = {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    setSandboxAssetHeaders(res);
    setNoCacheHeaders(res);
  },
};
app.use('/vendor/three', express.static(THREE_VENDOR_DIR, threeStaticOpts));
app.use('/vendor/three', express.static(path.join(THREE_VENDOR_DIR, 'build'), threeStaticOpts));

// The CAD kernel is an ES module imported by the runner, and the STEP export worker is
// started with new Worker('/cad-step-worker.js') from the same opaque origin (no-cache
// like the other UI code).
app.get(['/cad-kernel.js', '/cad-step-worker.js'], (req, res) => {
  const file = req.path === '/cad-step-worker.js' ? 'cad-step-worker.js' : 'cad-kernel.js';
  setSandboxAssetHeaders(res);
  setNoCacheHeaders(res);
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, file));
});

// Serve the local macOS Fusion 360 MCP CORS proxy and installer script before the auth
// gate so `curl -fsSL <origin>/fusion-mcp-cors-proxy.py | python3 -` works in Mac Terminal
// without requiring browser session cookies.
app.get(['/fusion-mcp-cors-proxy.py', '/cad-mcp-mac-install.sh'], (req, res) => {
  const file = req.path === '/cad-mcp-mac-install.sh' ? 'cad-mcp-mac-install.sh' : 'fusion-mcp-cors-proxy.py';
  setSandboxAssetHeaders(res);
  setNoCacheHeaders(res);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, file));
});

// Serve the sandboxed 3D & CAD Studio iframe (/cad-runner.html) with SAMEORIGIN
// framing and a scoped CSP that permits Three.js ESM importmap + Function evaluation
// inside the isolated CAD sandbox (which shadows storage/cookies and blocks fetch).
app.get('/cad-runner.html', (_req, res) => {
  setSandboxAssetHeaders(res);
  setNoCacheHeaders(res);
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'none'",
    "worker-src 'self' blob:",
    "frame-ancestors 'self'",
    "form-action 'none'",
  ].join('; '));
  res.sendFile(path.join(PUBLIC_DIR, 'cad-runner.html'));
});

// Serve a built game bundle. The pygbag loader needs a permissive CSP (inline +
// eval + wasm + its CDN) and must be framable by our own origin — so we override
// the strict global CSP / X-Frame-Options for just this route. pygbag fetches the
// bundle assets (.tar.gz / .apk / preloader files) with credentials:'omit', so
// this route is unauthenticated by design (see the note above).
app.get('/games/:id/*', (req, res) => {
  const dir = gameDir(req.params.id);
  if (!dir) return res.status(404).send('Game not found — rebuild it from the app.');
  const rel = req.params[0] && req.params[0] !== '' ? req.params[0] : 'index.html';
  const fp = path.normalize(path.join(dir, rel));
  if (fp !== dir && !fp.startsWith(dir + path.sep)) return res.status(400).end(); // no path traversal
  setSandboxAssetHeaders(res);
  setNoCacheHeaders(res);
  // Cross-origin isolation for the game document itself. Verified: with these
  // headers the Tetris bundle runs and the page stays responsive; without them
  // the identical bundle hard-freezes the renderer.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self' https://pygame-web.github.io https://cdn.jsdelivr.net",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://pygame-web.github.io https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://pygame-web.github.io",
    "img-src 'self' data: blob: https://pygame-web.github.io",
    // pygame loads sound (e.g. beep.ogg) via blob:/data: URLs; without media-src it
    // falls back to default-src (no blob:/data:) and the game crashes on audio load.
    "media-src 'self' data: blob: https://pygame-web.github.io https://cdn.jsdelivr.net",
    "connect-src 'self' blob: data: https://pygame-web.github.io https://cdn.jsdelivr.net",
    "worker-src 'self' blob:",
    "child-src 'self' blob: https://pygame-web.github.io",
    // pygbag frames its own vt/console from the CDN; without frame-src this is blocked
    // (surfaces as the share-modal.js 'addEventListener of null' error).
    "frame-src 'self' blob: https://pygame-web.github.io",
    "frame-ancestors 'self'",
    "form-action 'none'",
  ].join('; '));
  res.sendFile(fp);
});
app.get('/games/:id', (req, res) => res.redirect(301, `/games/${req.params.id}/`)); // bare id -> trailing slash

// ===========================================================================
// AUTH GATE — everything below requires a valid session
// ===========================================================================
app.use((req, res, next) => {
  const s = auth.getSession(req);
  if (s) {
    req.user = {
      username: s.username,
      role: s.role,
      external: !!s.external,
      mustChangePassword: !s.external && !!s.mustChangePassword,
    };
    const lowerPath = req.path.toLowerCase();
    if (req.user.mustChangePassword && lowerPath.startsWith('/api/')) {
      const allowedDuringForceChange =
        lowerPath === '/api/auth/password' ||
        lowerPath === '/api/auth/logout' ||
        lowerPath === '/api/auth/status' ||
        lowerPath === '/api/config' ||
        lowerPath === '/api/health';
      if (!allowedDuringForceChange) {
        return res.status(403).json({
          ok: false,
          code: 'PASSWORD_CHANGE_REQUIRED',
          error: 'You must change your temporary password before continuing.',
        });
      }
    }
    return next();
  }
  // Local workstation / Antigravity Sidecar auto-auth for Tarun (never active on Cloud Run K_SERVICE)
  // SECURITY: the Host header and X-Forwarded-For are client-controlled, so neither
  // may grant access on its own. Auto-auth requires the TCP peer to really be
  // loopback AND (outside the Antigravity sidecar) a loopback Host header, or an
  // exact entry from LOCAL_AUTO_AUTH_HOSTS, with no proxy forwarding headers.
  // This blocks LAN clients spoofing `Host: localhost`, DNS-rebinding pages (Host =
  // attacker domain), local tunnels/reverse proxies (which connect from 127.0.0.1 on
  // behalf of remote users) and this server's own bridge calls (X-LLMC-Internal).
  // Remote browsers on a LAN-exposed dev server must sign in like everyone else.
  const isLoopback = !process.env.K_SERVICE && isLocalAutoAuthRequest(req);
  if (isLoopback && process.env.LOCAL_AUTO_AUTH !== '0') {
    req.user = { username: 'ubhi@google.com', role: 'admin', name: 'Tarun Ubhi' };
    return next();
  }
  // (/games/*, /cad-runner.html, /cad-kernel.js and /vendor/three/* are routed above
  // this gate: they are fetched cookie-less from the opaque-origin sandbox frames.)
  if (req.path.toLowerCase().startsWith('/api/')) return res.status(401).json({ error: 'Authentication required.' });
  return res.redirect('/login');
});

// Authenticated routes may carry large attachment payloads (see note above).
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '50mb' }));
app.use(jsonBodyError);

function isLoopbackAddr(a) {
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// True only for a request that genuinely originates on this machine (see auth gate).
// The TCP peer check comes first: no Host value, allow-listed or not, can grant
// access to a remote client (3.3). LOCAL_AUTO_AUTH_HOSTS entries are matched exactly.
function isLocalAutoAuthRequest(req) {
  const peer = req.socket && req.socket.remoteAddress;   // real TCP peer — never req.ip (XFF)
  if (!isLoopbackAddr(peer)) return false;
  if (req.headers['x-llmc-internal']) return false; // server-originated request (CAD MCP bridge push), never a user
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  const extra = String(process.env.LOCAL_AUTO_AUTH_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) return true; // sidecar proxy: keep prior behaviour
  if (req.headers['x-forwarded-for'] || req.headers.forwarded) return false; // proxied/tunnelled
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || extra.includes(host);
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

// ---------- session / account management (authenticated) ----------
app.post('/api/auth/logout', (req, res) => {
  auth.destroySession(req.cookies && req.cookies[auth.COOKIE_NAME]);
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.post('/api/auth/password', wrap(async (req, res) => {
  try {
    const updatedUser = await auth.changePassword(
      req.user.username,
      String((req.body && req.body.currentPassword) || ''),
      String((req.body && req.body.newPassword) || ''),
    );
    auth.setSessionCookie(req, res, auth.createSession(updatedUser));
    res.json({ ok: true, mustChangePassword: false, user: updatedUser });
  } catch (e) {
    if (isAuthBusy(e)) return res.status(503).json({ error: e.message });
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
}));

// ---------- user administration (admin only) ----------
function usersModalPayload(req) {
  const s = appSettings.get();
  return {
    ok: true,
    users: auth.listUsers(),
    me: req.user.username,
    bootstrapAdmins: appSettings.BOOTSTRAP_ADMIN_EMAILS,
    adminEmails: s.adminEmails || [],
    allowedDomains: googleAuth.allowedDomains(),
    knownInternalUsers: knownInternalUsers(),
  };
}

app.get('/api/auth/users', requireAdmin, (req, res) => {
  res.json(usersModalPayload(req));
});

app.post('/api/auth/google-admins', requireAdmin, (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ ok: false, error: 'Enter a Google sign-in email (e.g. name@google.com).' });
  try {
    const before = appSettings.get();
    const cur = Array.isArray(before.adminEmails) ? before.adminEmails : [];
    const nextList = cur.includes(email) ? cur : [...cur, email];
    const after = appSettings.update(
      { adminEmails: nextList },
      { actor: req.user.username, allowedDomains: googleAuth.allowedDomains() }
    );
    log.event('NOTICE', `[google-admins] promoted ${email} by ${req.user.username}`, {
      by: req.user.username, email, adminsBefore: before.adminEmails, adminsAfter: after.adminEmails,
    });
    res.json({ ...usersModalPayload(req), googleAdminAdded: email });
  } catch (e) {
    res.status(400).json({ ok: false, error: scrubError(String((e && e.message) || e)) });
  }
});

app.delete('/api/auth/google-admins/:email', requireAdmin, (req, res) => {
  const target = String(req.params.email || '').trim().toLowerCase();
  try {
    if (req.user.external && String(req.user.username || '').toLowerCase() === target && !appSettings.isBootstrapAdmin(target)) {
      return res.status(400).json({ ok: false, error: "You can't remove your own admin access. Ask another admin to do it." });
    }
    const before = appSettings.get();
    const cur = Array.isArray(before.adminEmails) ? before.adminEmails : [];
    const nextList = cur.filter((x) => x !== target);
    const after = appSettings.update(
      { adminEmails: nextList },
      { actor: req.user.username, allowedDomains: googleAuth.allowedDomains() }
    );
    log.event('NOTICE', `[google-admins] demoted ${target} by ${req.user.username}`, {
      by: req.user.username, email: target, adminsBefore: before.adminEmails, adminsAfter: after.adminEmails,
    });
    res.json({ ...usersModalPayload(req), googleAdminRemoved: target });
  } catch (e) {
    res.status(400).json({ ok: false, error: scrubError(String((e && e.message) || e)) });
  }
});

app.post('/api/auth/users', requireAdmin, wrap(async (req, res) => {
  const { username, password, role, mustChangePassword, expiresAt, dailyVertexLimit } = req.body || {};
  const cleanUser = String(username || '').trim().toLowerCase();
  const domain = cleanUser.includes('@') ? cleanUser.split('@')[1] : '';
  const allowedDomains = googleAuth.allowedDomains();
  // If an admin enters an @google.com (or allowed Workspace domain) email without a password
  // and checks "Make this user an admin", promote them as a Google OAuth admin directly.
  if (role === 'admin' && !String(password || '').trim() && domain && allowedDomains.includes(domain)) {
    try {
      const before = appSettings.get();
      const cur = Array.isArray(before.adminEmails) ? before.adminEmails : [];
      const nextList = cur.includes(cleanUser) ? cur : [...cur, cleanUser];
      appSettings.update({ adminEmails: nextList }, { actor: req.user.username, allowedDomains });
      return res.json({ ...usersModalPayload(req), googleAdminAdded: cleanUser });
    } catch (e) {
      return res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
    }
  }
  const wantForce = mustChangePassword !== undefined ? Boolean(mustChangePassword) : true;
  try {
    const user = await auth.createUser(username, String(password || ''), role === 'admin' ? 'admin' : 'user', {
      mustChangePassword: wantForce,
      expiresAt,
      dailyVertexLimit,
    });
    res.json({ ...usersModalPayload(req), user });
  } catch (e) {
    if (isAuthBusy(e)) return res.status(503).json({ error: e.message });
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
}));

app.post('/api/auth/users/:username/limits', requireAdmin, (req, res) => {
  try {
    const { expiresAt, dailyVertexLimit } = req.body || {};
    const user = auth.updateUserLimits(req.params.username, { expiresAt, dailyVertexLimit });
    res.json({ ok: true, user, users: auth.listUsers() });
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

// ---------- Settings (admin): daily run limits on the global keys + internal admins ----------
function globalKeyConfigured(provider) {
  if (provider === 'openai') return globalKeys.has('OPENAI_API_KEY');
  if (provider === 'moonshot') return globalKeys.has('MOONSHOT_API_KEY');
  if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
  return globalKeys.has('AGENT_PLATFORM_API_KEY') || globalKeys.has('GEMINI_API_KEY') || autoMintEnabled();
}
// Google sign-in users seen in history, to suggest when adding an internal admin.
function knownInternalUsers() {
  const domains = googleAuth.allowedDomains();
  const seen = new Set();
  try {
    for (const u of (history.usageSummary().users || [])) {
      const e = String((u && u.user) || '').toLowerCase();
      if (e.includes('@') && (!domains.length || domains.includes(e.split('@')[1]))) seen.add(e);
    }
  } catch (_) { /* suggestions are optional */ }
  return Array.from(seen).sort().slice(0, 300);
}
function settingsPayload() {
  return {
    ok: true,
    settings: appSettings.get(),
    defaults: appSettings.DEFAULT_LIMITS,
    maxLimit: appSettings.MAX_LIMIT,
    providers: appSettings.PROVIDERS.map((p) => ({ id: p, label: appSettings.PROVIDER_LABELS[p], globalKey: globalKeyConfigured(p) })),
    bootstrapAdmins: appSettings.BOOTSTRAP_ADMIN_EMAILS,
    allowedDomains: googleAuth.allowedDomains(),
    adminsExempt: process.env.RATE_LIMIT_EXEMPT_ADMINS !== '0',
    knownInternalUsers: knownInternalUsers(),
  };
}
app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(settingsPayload()));
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const body = req.body || {};
  try {
    // Lockout guard: a Google-signed-in admin can't remove their own internal-admin access here.
    if (Array.isArray(body.adminEmails) && req.user.external) {
      const me = String(req.user.username || '').toLowerCase();
      const keeps = appSettings.isBootstrapAdmin(me) || body.adminEmails.some((e) => String(e || '').trim().toLowerCase() === me);
      if (!keeps) return res.status(400).json({ ok: false, error: "You can't remove your own admin access. Ask another admin to do it." });
    }
    const before = appSettings.get();
    const after = appSettings.update(
      { limits: body.limits, budgets: body.budgets, adminEmails: body.adminEmails },
      { actor: req.user.username, allowedDomains: googleAuth.allowedDomains() }
    );
    // Paper trail for who changed limits / budgets / admins, and from what to what.
    log.event('NOTICE', `[settings] updated by ${req.user.username}`, {
      by: req.user.username, limitsBefore: before.limits, limitsAfter: after.limits,
      budgetsBefore: before.budgets, budgetsAfter: after.budgets,
      adminsBefore: before.adminEmails, adminsAfter: after.adminEmails,
    });
    res.json(settingsPayload());
  } catch (e) {
    res.status(400).json({ ok: false, error: scrubError(String((e && e.message) || e)) });
  }
});

// ---------- Settings (admin): this month's spend on the global keys vs monthly budgets ----------
// App-tracked spend (src/spendLedger.js) for every provider, plus provider-reported
// numbers where an API exists (src/providerBilling.js). "Remaining" uses the larger of the
// provider's own month-to-date spend (where it has one; it also counts other apps on the
// same org) and the app-tracked spend: the same number the monthly budget check enforces
// (see monthlyBudgetOver). ?refresh=1 re-queries the providers (max once a minute).
app.get('/api/admin/spend', requireAdmin, wrap(async (req, res) => {
  const force = req.query && (req.query.refresh === '1' || req.query.refresh === 'true');
  const tracked = spendLedger.monthToDate();
  const budgets = appSettings.get().budgets;
  const views = await Promise.all(appSettings.PROVIDERS.map((p) => providerBilling.providerView(p, { force })));
  const providers = appSettings.PROVIDERS.map((p, i) => providerBilling.summarize({
    id: p,
    label: appSettings.PROVIDER_LABELS[p],
    app: tracked.providers[p],
    view: views[i],
    budgetUsd: budgets[p],
    globalKey: globalKeyConfigured(p),
  }));
  res.json({ ok: true, month: tracked.month, trackingSince: tracked.since, generatedAt: new Date().toISOString(), providers });
}));

app.post('/api/auth/users/:username/force-password-change', requireAdmin, (req, res) => {
  try {
    const mustChange = req.body && req.body.mustChangePassword !== undefined ? Boolean(req.body.mustChangePassword) : true;
    const user = auth.setMustChangePassword(req.params.username, mustChange);
    res.json({ ok: true, user, users: auth.listUsers() });
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

app.post('/api/auth/users/:username/reset-password', requireAdmin, wrap(async (req, res) => {
  try {
    const { password, mustChangePassword } = req.body || {};
    const wantForce = mustChangePassword !== undefined ? Boolean(mustChangePassword) : true;
    const user = await auth.adminResetPassword(req.params.username, String(password || ''), wantForce);
    res.json({ ok: true, user, users: auth.listUsers() });
  } catch (e) {
    if (isAuthBusy(e)) return res.status(503).json({ error: e.message });
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
}));

app.delete('/api/auth/users/:username', requireAdmin, (req, res) => {
  try {
    auth.deleteUser(req.params.username, req.user.username);
    res.json({ ok: true, users: auth.listUsers() });
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

// ---------- fast in-memory static asset cache + gzip compression ----------
// (PUBLIC_DIR is defined with the pre-gate sandbox routes above.)
const STATIC_ASSET_MIMES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/theme-init.js': { file: 'theme-init.js', type: 'application/javascript; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};
const staticMemCache = new Map();

function getCachedStaticAsset(fileRel) {
  const fp = path.join(PUBLIC_DIR, fileRel);
  try {
    const prev = staticMemCache.get(fileRel);
    const st = fs.statSync(fp);
    if (fileRel === 'index.html') {
      const themeAsset = getCachedStaticAsset('theme-init.js');
      const cssAsset = getCachedStaticAsset('styles.css');
      const jsAsset = getCachedStaticAsset('app.js');
      const compositeKey = `${st.mtimeMs}|${pkg.version}|${BOOT_ID}|${themeAsset ? themeAsset.hash : ''}|${cssAsset ? cssAsset.hash : ''}|${jsAsset ? jsAsset.hash : ''}`;
      if (prev && prev.compositeKey === compositeKey) return prev;
      let htmlStr = fs.readFileSync(fp, 'utf8');
      if (themeAsset && themeAsset.hash) {
        htmlStr = htmlStr.replace(/theme-init\.js(\?v=[^"']*)?/g, `theme-init.js?v=${pkg.version}-${themeAsset.hash}-${BOOT_ID}`);
      }
      if (cssAsset && cssAsset.hash) {
        htmlStr = htmlStr.replace(/styles\.css(\?v=[^"']*)?/g, `styles.css?v=${pkg.version}-${cssAsset.hash}-${BOOT_ID}`);
      }
      if (jsAsset && jsAsset.hash) {
        htmlStr = htmlStr.replace(/app\.js(\?v=[^"']*)?/g, `app.js?v=${pkg.version}-${jsAsset.hash}-${BOOT_ID}`);
      }
      const raw = Buffer.from(htmlStr, 'utf8');
      const gz = zlib.gzipSync(raw, { level: 6 });
      const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10);
      const entry = { mtimeMs: st.mtimeMs, compositeKey, hash, raw, gz };
      staticMemCache.set(fileRel, entry);
      return entry;
    }
    if (prev && prev.mtimeMs === st.mtimeMs) return prev;
    const raw = fs.readFileSync(fp);
    const gz = zlib.gzipSync(raw, { level: 6 });
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10);
    const entry = { mtimeMs: st.mtimeMs, hash, raw, gz };
    staticMemCache.set(fileRel, entry);
    return entry;
  } catch (_) {
    return null;
  }
}
// Warm static asset cache on boot (sub-assets first so index.html injects their content hashes)
['theme-init.js', 'styles.css', 'app.js', 'index.html'].forEach((f) => getCachedStaticAsset(f));

// Automatically gzip JSON responses > 1 KB when the client accepts gzip. The JSON
// text is run through the secret scrubber BEFORE compression (3.8): the /api
// scrub middleware only sees compressed bytes afterwards and skips them.
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function gzipJson(body) {
    const ae = String(req.headers['accept-encoding'] || '');
    if (!/\bgzip\b/i.test(ae) || res.headersSent) return origJson(body);
    try {
      const raw = JSON.stringify(body);
      if (!raw || raw.length < 1024) return origJson(body);
      const byok = (req.body && typeof req.body === 'object' && req.body.keys) || null;
      const str = maskKnown(raw, byok);
      const gz = zlib.gzipSync(Buffer.from(str, 'utf8'), { level: 1 });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', String(gz.length));
      return res.end(gz);
    } catch (_) {
      return origJson(body);
    }
  };
  next();
});

// ---------- static UI (authenticated) ----------
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const hit = STATIC_ASSET_MIMES[req.path];
  if (!hit) return next();
  const entry = getCachedStaticAsset(hit.file);
  if (!entry) return next();
  res.setHeader('Content-Type', hit.type);
  setNoCacheHeaders(res);
  res.setHeader('Vary', 'Accept-Encoding');
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bgzip\b/i.test(ae)) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(entry.gz.length));
    return res.end(req.method === 'HEAD' ? undefined : entry.gz);
  }
  res.setHeader('Content-Length', String(entry.raw.length));
  return res.end(req.method === 'HEAD' ? undefined : entry.raw);
});

// (/vendor/three/*, /cad-kernel.js and /cad-runner.html are served before the auth gate, see above.)

app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    setNoCacheHeaders(res);
  },
}));

// Precompute static catalog metadata once at startup instead of on every /api/config request
const CATALOG_CONFIG = MODEL_CATALOG.map((m) => {
  const opts = thinkingOptions(m);
  return {
    ...m,
    thinking: thinkingProfile(m),
    thinkingOptions: {
      ...opts,
      options: opts.options.map((o) => {
        const prof = thinkingProfile({ ...m, effort: o.value });
        return { ...o, detail: prof.detail, profile: prof };
      }),
    },
  };
});

// ===========================================================================
// APPLICATION API (authenticated)
// ===========================================================================
app.get('/api/config', (req, res) => {
  const codeExecOn = executionEnabled();
  const webGameOn = webGameEnabled();
  const prefs = history.getUserPreferences(req.user.username);
  res.json({
    version: pkg.version,
    assetVersion: `${pkg.version}-${BOOT_ID}`,
    lastUpdated: LAST_UPDATED_ISO,
    models: DEFAULT_MODELS,
    catalog: CATALOG_CONFIG,
    tasks: TASKS.map((t) => ({
      id: t.id,
      title: t.title,
      prompt: t.prompt,
      functionName: t.functionName,
      testCount: t.testCases.length,
      category: t.category || (t.testCases.length ? 'coding' : 'general'),
      vertical: t.vertical || null,
      subcategory: t.subcategory || null,
      language: t.language || null,
      executable: Boolean(t.executable || t.visualizer) && (codeExecOn || (!!t.gui && webGameOn)),
      visualizer: t.visualizer || null,
      gui: !!t.gui,
    })),
    keysPresent: {
      agentplatform: globalKeys.has('AGENT_PLATFORM_API_KEY') || globalKeys.has('GEMINI_API_KEY'),
      claude: autoMintEnabled() || !!process.env.CLAUDE_BEARER_TOKEN,
      gemini: globalKeys.has('GEMINI_API_KEY'),
      openai: globalKeys.has('OPENAI_API_KEY'),
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      moonshot: globalKeys.has('MOONSHOT_API_KEY'),
    },
    codeExec: codeExecOn,
    webGame: webGameOn,
    // The hosting project id is only needed by the admin access-help text (3.19).
    gcpProject: req.user.role === 'admin' ? (process.env.GCP_PROJECT_ID || '') : '',
    allowedDomains: googleAuth.allowedDomains(),
    maxRunsPerDay: appSettings.limitFor('openai'),
    maxSingleRunsPerDay: appSettings.limitFor('openai'),
    maxExternalVertexRunsPerDay: appSettings.limitFor('vertex'),
    // Per-user daily run limits on the global keys (Settings), per provider.
    limits: appSettings.get().limits,
    auditRetentionDays: history.AUDIT_RETENTION_DAYS,
    runRetentionDays: history.RUN_RETENTION_DAYS,
    me: {
      username: req.user.username,
      role: req.user.role,
      external: !!req.user.external,
      mustChangePassword: !!req.user.mustChangePassword,
      quota: auth.runQuota(req.user, 'compare'),
      singleQuota: auth.runQuota(req.user, 'single'),
      vertexQuota: auth.vertexRunQuota(req.user),
      quotas: auth.quotaSnapshot(req.user),
      lastModels: history.lastModels(req.user.username),
      preferences: {
        taskId: prefs.taskId || 'custom',
        slots: prefs.slots || null,
        models: prefs.models || null,
        workspaceState: prefs.workspaceState || null,
      },
      savedPrompts: prefs.savedPrompts || [],
      savedPresets: prefs.savedPresets || [],
    },
  });
});

// ---------- user preferences, saved prompts & saved model presets (per user) ----------
app.get('/api/me/preferences', (req, res) => {
  res.json({ ok: true, preferences: history.getUserPreferences(req.user.username) });
});

app.post('/api/me/preferences', (req, res) => {
  const prefs = history.saveUserPreferences(req.user.username, req.body || {});
  res.json({ ok: true, preferences: prefs });
});

app.get('/api/me/prompts', (req, res) => {
  res.json({ ok: true, savedPrompts: history.listSavedPrompts(req.user.username) });
});

app.get('/api/me/prompts/:id', (req, res) => {
  const prompt = history.getSavedPrompt(req.user.username, req.params.id);
  if (!prompt) return res.status(404).json({ ok: false, error: 'Saved prompt not found.' });
  res.json({ ok: true, prompt });
});

app.post('/api/me/prompts', (req, res) => {
  try {
    const out = history.saveUserPrompt(req.user.username, req.body || {});
    res.json({ ok: true, saved: out.prompt, prompt: out.prompt, savedPrompts: out.savedPrompts });
  } catch (e) {
    res.status(400).json({ ok: false, error: scrubError(String((e && e.message) || e)) });
  }
});

app.delete('/api/me/prompts/:id', (req, res) => {
  const out = history.deleteUserPrompt(req.user.username, req.params.id, { isAdmin: req.user.role === 'admin' });
  if (!out.removed) return res.status(404).json({ ok: false, error: 'Saved prompt not found.' });
  res.json({ ok: true, removed: true, savedPrompts: out.savedPrompts });
});

// List the authenticated user's attachment records from the SQLite `user_vault_files` table.
app.get('/api/me/vault', (req, res) => {
  res.json({ ok: true, files: history.vault.listUserVaultFiles(req.user.username) });
});

// Serve a raw binary file directly from the authenticated user's personal vault
// (/data/vault/<userKey>/<sha256>.bin) for image previews and downloads.
// Strictly scoped to req.user.username for regular users; admins restoring cross-user
// runs can resolve the binary from the run owner's vault folder.
app.get('/api/me/vault/:sha256', (req, res) => {
  const entry = history.vault.getVaultRawBinarySync(req.user.username, req.params.sha256, {
    isAdmin: Boolean(req.user && req.user.role === 'admin'),
  });
  if (!entry || !entry.buffer) return res.status(404).json({ ok: false, error: 'Vault file not found.' });
  const safeMime = /^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/plain)$/i.test(entry.mimeType)
    ? entry.mimeType
    : 'application/octet-stream';
  res.setHeader('Content-Type', safeMime);
  res.setHeader('Content-Length', String(entry.buffer.length));
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(entry.buffer);
});

app.get('/api/me/presets', (req, res) => {
  res.json({ ok: true, savedPresets: history.listSavedPresets(req.user.username) });
});

app.post('/api/me/presets', (req, res) => {
  try {
    const out = history.saveUserPreset(req.user.username, req.body || {});
    res.json({ ok: true, saved: out.preset, preset: out.preset, savedPresets: out.savedPresets });
  } catch (e) {
    res.status(400).json({ ok: false, error: scrubError(String((e && e.message) || e)) });
  }
});

app.delete('/api/me/presets/:id', (req, res) => {
  const out = history.deleteUserPreset(req.user.username, req.params.id);
  if (!out.removed) return res.status(404).json({ ok: false, error: 'Saved model preset not found.' });
  res.json({ ok: true, removed: true, savedPresets: out.savedPresets });
});

// ---------- run history (per-user; admins can see everyone) ----------
// A user only ever sees their own runs. Admins can request scope=all and the
// usage summary. History is written server-side after each run (see /api/run),
// so the browser cannot forge or tamper with it.
app.get('/api/history', (req, res) => {
  const arena = req.query.arena ? String(req.query.arena).trim().toLowerCase() : null;
  if (req.query.scope === 'all') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    return res.json({ scope: 'all', retentionDays: history.RUN_RETENTION_DAYS, runs: history.listAllRuns({ arena }) });
  }
  res.json({ scope: 'me', retentionDays: history.RUN_RETENTION_DAYS, runs: history.listRuns(req.user.username, { arena }) });
});

app.get('/api/history/:id', (req, res) => {
  const rec = history.getRun(req.params.id, { username: req.user.username, isAdmin: req.user.role === 'admin' });
  if (!rec) return res.status(404).json({ error: 'Run not found.' });
  res.json({ run: rec });
});

app.get('/api/history/:id/pdf', (req, res) => {
  const rec = history.getRun(req.params.id, { username: req.user.username, isAdmin: req.user.role === 'admin' });
  if (!rec) return res.status(404).json({ error: 'Run not found.' });
  try {
    const foundTask = TASKS.find((t) => t.id === rec.taskId);
    const capped = capPdfExportBody(rec);
    const pdfBuf = buildComparisonPdf({
      ...capped,
      task: foundTask || null,
      taskTitle: String(rec.title || (foundTask && foundTask.title) || 'Comparison Report').slice(0, 200),
      prompt: String(rec.prompt || (foundTask && foundTask.prompt) || '').slice(0, 100000),
    });
    const filename = pdfFilename(rec.title || rec.taskId || 'comparison', rec.at);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(pdfBuf.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(pdfBuf);
  } catch (e) {
    res.status(500).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

// /api/export-pdf input caps (6.4): the PDF text wrapper re-measures per character,
// so every free-text field is bounded here before it reaches pdfReport.js.
const PDF_EXPORT_MAX_JSON = 2 * 1024 * 1024;
const PDF_EXPORT_MAX_SLOTS = 8;
const capStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v);
function capPdfSlotFields(x) {
  if (!x || typeof x !== 'object') return x;
  const out = { ...x };
  for (const k of ['label', 'provider', 'model']) if (typeof out[k] === 'string') out[k] = out[k].slice(0, 120);
  if (typeof out.note === 'string') out.note = out.note.slice(0, 4000);
  if (typeof out.contextWarning === 'string') out.contextWarning = out.contextWarning.slice(0, 500);
  if (Array.isArray(out.attachmentNotes)) out.attachmentNotes = out.attachmentNotes.slice(0, 10).map((n) => String(n == null ? '' : n).slice(0, 300));
  else if (out.attachmentNotes != null) out.attachmentNotes = [];
  return out;
}
function capPdfExportBody(body) {
  const out = { ...body };
  out.models = Array.isArray(body.models) ? body.models.slice(0, PDF_EXPORT_MAX_SLOTS).map(capPdfSlotFields) : [];
  if (Array.isArray(body.results)) {
    out.results = body.results.slice(0, PDF_EXPORT_MAX_SLOTS).map(capPdfSlotFields);
  } else if (body.results && typeof body.results === 'object') {
    out.results = {};
    for (const k of Object.keys(body.results).slice(0, PDF_EXPORT_MAX_SLOTS)) out.results[k] = capPdfSlotFields(body.results[k]);
  }
  if (Array.isArray(body.slots)) out.slots = body.slots.slice(0, PDF_EXPORT_MAX_SLOTS).map(capPdfSlotFields);
  if (body.judge && typeof body.judge === 'object') {
    out.judge = { ...body.judge, why: capStr(body.judge.why, 4000) };
    if (Array.isArray(body.judge.results)) out.judge.results = body.judge.results.slice(0, PDF_EXPORT_MAX_SLOTS).map(capPdfSlotFields);
    if (body.judge.judge && typeof body.judge.judge === 'object') out.judge.judge = capPdfSlotFields(body.judge.judge);
  }
  return out;
}

app.post('/api/export-pdf', (req, res) => {
  const declared = Number(req.headers['content-length']);
  if (declared > PDF_EXPORT_MAX_JSON) return res.status(413).json({ error: 'The report payload is too large to export (2 MB limit).' });
  const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    if (JSON.stringify(rawBody).length > PDF_EXPORT_MAX_JSON) return res.status(413).json({ error: 'The report payload is too large to export (2 MB limit).' });
  } catch (_) {
    return res.status(400).json({ error: 'Invalid report payload.' });
  }
  const body = capPdfExportBody(rawBody);
  const foundTask = TASKS.find((t) => t.id === body.taskId);
  const rawResults = body.results;
  const hasResults = Array.isArray(rawResults)
    ? rawResults.length > 0
    : (rawResults && typeof rawResults === 'object' && Object.keys(rawResults).length > 0)
      || (Array.isArray(body.slots) && body.slots.length > 0);
  if (!hasResults) {
    return res.status(400).json({ error: 'No comparison results available to export.' });
  }
  try {
    const title = String(body.taskTitle || body.title || (foundTask && foundTask.title) || 'Custom prompt').slice(0, 200);
    const prompt = String(
      (typeof body.prompt === 'string' && body.prompt.trim())
        ? body.prompt
        : ((foundTask && foundTask.prompt) || '')
    ).slice(0, 100000);
    const savedRec = (!body.judge && (body.runId || body.id))
      ? history.getRun(body.runId || body.id, { username: req.user.username, isAdmin: req.user.role === 'admin' })
      : null;
    const rawJudge = body.judge || (savedRec && savedRec.judge) || null;
    const cappedJudge = (rawJudge && typeof rawJudge === 'object')
      ? capPdfExportBody({ judge: rawJudge }).judge
      : null;
    const pdfBuf = buildComparisonPdf({
      taskId: body.taskId || (foundTask && foundTask.id) || 'custom',
      taskTitle: title,
      prompt,
      task: foundTask || null,
      models: Array.isArray(body.models) ? body.models : [],
      results: body.results,
      slots: body.slots,
      judge: cappedJudge,
      execOutputs: body.execOutputs && typeof body.execOutputs === 'object' ? body.execOutputs : null,
      at: Number(body.at) || Date.now(),
      user: req.user && req.user.username,
    });
    const filename = pdfFilename(title || body.taskId || 'comparison', body.at);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(pdfBuf.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(pdfBuf);
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

app.delete('/api/history/:id', (req, res) => {
  const ok = history.deleteRun(req.params.id, { username: req.user.username, isAdmin: req.user.role === 'admin' });
  if (!ok) return res.status(404).json({ error: 'Run not found or not yours to delete.' });
  res.json({ ok: true });
});

app.post('/api/history/:id/star', (req, res) => {
  const starred = Boolean(req.body && req.body.starred);
  const out = history.setRunStarred(req.params.id, starred, { username: req.user.username, isAdmin: req.user.role === 'admin' });
  if (!out) return res.status(404).json({ error: 'Run not found or not yours to star.' });
  res.json(out);
});

// Admin at-a-glance usage: who's active, runs today, totals.
app.get('/api/usage', requireAdmin, (req, res) => {
  const arena = req.query.arena ? String(req.query.arena).trim().toLowerCase() : null;
  res.json(history.usageSummary({ registeredUsers: auth.listUsers(), arena }));
});

// Admin 90-day security & compliance audit trail (input prompts + input attachments).
app.get('/api/admin/audit', requireAdmin, (req, res) => {
  const runs = history.listAuditRuns({
    user: req.query.user,
    arena: req.query.arena,
    includeHidden: req.query.includeHidden !== '0',
    limit: req.query.limit,
  });
  res.json({
    ok: true,
    auditRetentionDays: history.AUDIT_RETENTION_DAYS,
    runRetentionDays: history.RUN_RETENTION_DAYS,
    runs,
  });
});

app.get('/api/admin/audit/:id', requireAdmin, (req, res) => {
  const run = history.getAuditRun(req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: 'Audit record not found.' });
  res.json({ ok: true, run });
});

// ---------- global (shared) provider keys — admin only ----------
// These are the credentials every user runs on when they haven't brought their
// own. Stored as Secret Manager versions (see src/globalKeys.js); the VALUES are
// never returned here — only presence and a masked tail.
app.get('/api/global-keys', requireAdmin, (req, res) => {
  res.json({ keys: globalKeys.status(), enabled: globalKeys.enabled() });
});

app.put('/api/global-keys', requireAdmin, wrap(async (req, res) => {
  const { name, value } = req.body || {};
  try {
    const keys = await globalKeys.set(String(name || ''), String(value || ''));
    // Audit trail: a shared key change affects every user's runs and spend.
    console.log(`[globalKeys] ${req.user.username} updated ${name}`);
    providerBilling.invalidate(); // a new (admin) key should show up in Settings > spend right away
    res.json({ ok: true, keys });
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
}));

// ---------- Image & GenMedia Arena (Nano Banana 2 vs 2.1) ----------
app.get('/api/image-arena/config', (_req, res) => {
  res.json(getImageArenaConfig());
});

app.get('/api/image-arena/history', (req, res) => {
  if (req.query.scope === 'all') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    return res.json({ scope: 'all', retentionDays: history.RUN_RETENTION_DAYS, runs: history.listAllImageRuns() });
  }
  res.json({ scope: 'me', retentionDays: history.RUN_RETENTION_DAYS, runs: history.listImageRuns(req.user.username) });
});

app.get('/api/image-arena/usage', requireAdmin, (_req, res) => {
  res.json(history.imageUsageSummary({ registeredUsers: auth.listUsers() }));
});

// Client posts to /api/image-arena/history are bounded here (6.1 / 7.1 / 3.2): the
// server already vaulted every generated image during /api/image-arena/run, so a
// client may only send compact per-slot metadata plus a small data-URL thumbnail.
const IMAGE_HISTORY_MAX_BATCH = 20;
const IMAGE_HISTORY_MAX_RESULTS = 6;
const IMAGE_HISTORY_MAX_ATTACHMENTS = 13;
const IMAGE_HISTORY_MAX_TEXT = 20000;
const IMAGE_THUMB_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]{1,45000}$/;
const IMAGE_MIME_RE = /^image\/(png|jpeg|webp|gif)$/i;
function sanitizeClientImageResult(r) {
  if (!r || typeof r !== 'object') return null;
  const out = { ...r };
  delete out.imageDataUrl;
  delete out.thoughtDataUrl;
  delete out.thoughtImageDataUrl;
  // Only raster image types are ever stored / echoed for a slot (3.2); anything else
  // falls back to the server-recorded or default type.
  if (out.mimeType != null && !IMAGE_MIME_RE.test(String(out.mimeType))) delete out.mimeType;
  if (typeof out.text === 'string') out.text = out.text.slice(0, IMAGE_HISTORY_MAX_TEXT);
  else if (out.text != null) delete out.text;
  if (typeof out.reasoning === 'string') out.reasoning = out.reasoning.slice(0, IMAGE_HISTORY_MAX_TEXT);
  else if (out.reasoning != null) delete out.reasoning;
  if (out.thumbDataUrl != null && !(typeof out.thumbDataUrl === 'string' && IMAGE_THUMB_DATA_URL_RE.test(out.thumbDataUrl))) delete out.thumbDataUrl;
  for (const k of ['costUsd', 'standardPayGoCostUsd', 'offPeakPayGoCostUsd']) {
    if (out[k] == null) continue;
    const n = Number(out[k]);
    if (!Number.isFinite(n) || n < 0) delete out[k];
    else out[k] = n;
  }
  return out;
}
function sanitizeClientImageHistoryItem(item) {
  const rawResults = Array.isArray(item.results) ? item.results : (Array.isArray(item.summary) ? item.summary : null);
  const results = rawResults ? rawResults.slice(0, IMAGE_HISTORY_MAX_RESULTS).map(sanitizeClientImageResult).filter(Boolean) : undefined;
  const attachments = Array.isArray(item.attachments)
    ? item.attachments.slice(0, IMAGE_HISTORY_MAX_ATTACHMENTS).map((a) => {
      if (!a || typeof a !== 'object') return a;
      if (a.mimeType != null && !IMAGE_MIME_RE.test(String(a.mimeType))) { const { mimeType: _dropped, ...rest } = a; return rest; }
      return a;
    })
    : undefined;
  const atNum = Number(item.at);
  const at = Number.isFinite(atNum) && atNum > 0 ? Math.min(atNum, Date.now()) : undefined;
  return { results, attachments, at };
}

app.post('/api/image-arena/history', wrap(async (req, res) => {
  try {
    const body = req.body || {};
    const batch = Array.isArray(body.runs) ? body.runs : [body.run || body];
    const saved = [];
    for (const item of batch.slice(0, IMAGE_HISTORY_MAX_BATCH)) {
      if (!item || typeof item !== 'object') continue;
      // Preserve original run owner only if admin is syncing; otherwise bind to req.user
      const ownerUser = (req.user.role === 'admin' && item.user) ? item.user : req.user.username;
      const ownerName = (req.user.role === 'admin' && item.userName) ? item.userName : (req.user.name || req.user.username);
      const isExt = auth.isExternalAccount(req.user);
      const bounded = sanitizeClientImageHistoryItem(item);
      const out = await history.saveImageRun({
        id: item.id,
        at: bounded.at,
        user: ownerUser,
        userName: ownerName,
        packId: item.packId,
        scenarioId: item.scenarioId,
        title: item.title || item.scenarioTitle,
        prompt: item.prompt,
        imageSize: item.imageSize,
        aspectRatio: item.aspectRatio,
        slots: item.slots,
        results: bounded.results,
        attachments: bounded.attachments,
        starred: item.starred,
        ip: isExt ? req.ip : null,
        userAgent: isExt ? req.headers['user-agent'] : null,
        isExternal: isExt,
      });
      if (out) saved.push(out);
    }
    res.json({ ok: true, saved: saved[0] || null, savedCount: saved.length, runs: history.listImageRuns(req.user.username) });
  } catch (e) {
    res.status(400).json({ ok: false, error: scrubError(String((e && e.message) || e)) });
  }
}));

app.get('/api/image-arena/history/:id', (req, res) => {
  const rec = history.getImageRun(req.params.id, { username: req.user.username, isAdmin: req.user.role === 'admin' });
  if (!rec) return res.status(404).json({ error: 'Image Arena run not found.' });
  res.json({ run: rec });
});

app.delete('/api/image-arena/history/:id', (req, res) => {
  const ok = history.deleteImageRun(req.params.id, { username: req.user.username, isAdmin: req.user.role === 'admin' });
  if (!ok) return res.status(404).json({ error: 'Image Arena run not found or not yours to delete.' });
  res.json({ ok: true });
});

app.post('/api/image-arena/history/:id/star', (req, res) => {
  const starred = Boolean(req.body && req.body.starred);
  const out = history.setImageRunStarred(req.params.id, starred, { username: req.user.username, isAdmin: req.user.role === 'admin' });
  if (!out) return res.status(404).json({ error: 'Image Arena run not found or not yours to star.' });
  res.json(out);
});

// ---------- daily run budgets on the GLOBAL keys: one rule for the whole app ----------
// A run (one Run click in the text or image arena, a single-model re-run, a crash fix or a
// Blind Judge call) is charged ONCE per provider budget it touches, however many models or
// slots it has. Limits are per user per UTC day (Settings; defaults OpenAI 3, Anthropic 3,
// Moonshot 3, Vertex AI 10) for every user; admins are exempt. Models on the user's own key
// never count: strict BYOK means they never touch the global keys.
function budgetBucket(m) {
  return appSettings.budgetBucket(m); // agentplatform (Gemini, Claude, partner MaaS, Nano Banana) + gemini -> vertex
}
function budgetsNeeded(models, keys) {
  const need = new Set();
  for (const m of Array.isArray(models) ? models : []) if (!modelUsesOwnKey(m, keys)) need.add(budgetBucket(m));
  return appSettings.PROVIDERS.filter((p) => need.has(p)); // stable order
}
function quotaExhaustedBody(user, provider, q, arena) {
  const label = appSettings.PROVIDER_LABELS[provider] || provider;
  const external = provider !== 'vertex';
  const swapTo = arena === 'image' ? 'a Gemini (Nano Banana) model' : 'a Gemini or Claude model on Vertex AI';
  const fix = external
    ? `Swap the ${label} slot to ${swapTo}, or add your own ${label} key in Your API keys.`
    : 'Add your own Gemini / Vertex AI key in Your API keys, or ask an admin to raise the limit.';
  return {
    type: 'error',
    quotaExhausted: true,
    provider,
    openaiQuotaExhausted: provider === 'openai',
    externalQuotaExhausted: external,
    vertexQuotaExhausted: provider === 'vertex',
    error: q.limit === 0
      ? `${label} runs on the shared key are turned off. ${fix}`
      : `Daily ${label} limit reached: you've used all ${q.limit} ${label} runs for today on the shared key (text and image runs share this budget). ${fix}`,
    quota: q,
    vertexQuota: auth.providerQuota(user, 'vertex'),
    quotas: auth.quotaSnapshot(user),
  };
}
// ---------- monthly budgets on the GLOBAL keys (Settings > Spend), enforced ----------
// A provider's monthly budget (USD, calendar month UTC; null = no budget) caps spend on ITS
// global key: once this month's spend reaches the budget, every run that needs that global
// key is rejected up front (before any daily run is charged or any model is called) until
// next month or until an admin raises or clears the budget. A $0 budget blocks the key.
// Spend = the larger of the app-tracked ledger and the provider's own month-to-date number
// (providerBilling.spentFor, the same basis Settings shows as Remaining); the provider number
// only counts while its cached view is under an hour old (providerBilling.peek), so no
// provider API is ever called on the request path. Own-key models never count
// (budgetsNeeded); admins are exempt exactly like the daily limits.
function monthlyBudgetOver(user, models, keys, skipList) {
  if (!user || auth.exemptFromBudgets(user)) return null;
  const budgets = appSettings.get().budgets;
  let tracked = null;
  for (const p of budgetsNeeded(models, keys)) {
    if (skipList.includes(p) || budgets[p] == null) continue;
    if (!tracked) tracked = spendLedger.monthToDate();
    const app = tracked.providers[p];
    const spentUsd = providerBilling.spentFor(providerBilling.peek(p), app && app.usd);
    if (spentUsd >= budgets[p]) return { provider: p, budgetUsd: budgets[p], spentUsd };
  }
  return null;
}
const usd2 = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Same shape as a daily-limit rejection (provider + the *QuotaExhausted flags + quotas), so
// the UI reacts the same way (e.g. offers to swap external slots to Vertex AI), plus
// monthlyBudgetExhausted / budgetUsd / spentUsd.
function monthlyBudgetExhaustedBody(user, { provider, budgetUsd, spentUsd }) {
  const label = appSettings.PROVIDER_LABELS[provider] || provider;
  const ownKey = provider === 'vertex' ? 'your own Vertex AI key or token' : `your own ${label} key`;
  const what = budgetUsd > 0
    ? `The shared ${label} key has used this month's budget (${usd2(spentUsd)} of ${usd2(budgetUsd)}).`
    : `The shared ${label} key has a $0 monthly budget, so runs on it are turned off.`;
  return {
    type: 'error',
    quotaExhausted: true,
    monthlyBudgetExhausted: true,
    provider,
    openaiQuotaExhausted: provider === 'openai',
    externalQuotaExhausted: provider !== 'vertex',
    vertexQuotaExhausted: provider === 'vertex',
    budgetUsd,
    spentUsd: Math.round(spentUsd * 1e6) / 1e6,
    error: `${what} Add ${ownKey} under Your API keys to keep going, or ask an admin to raise the budget in Settings.`,
    quota: auth.providerQuota(user, provider),
    vertexQuota: auth.providerQuota(user, 'vertex'),
    quotas: auth.quotaSnapshot(user),
  };
}
// Charge every budget a run needs, all-or-nothing. `skip` = budgets this run was already
// charged for (Image Arena top-ups). -> { ok, charged:[...], quotas } | { ok:false, body }
// The monthly budgets are checked first, so a used-up one rejects the run before anything
// is charged; budgets in `skip` were approved at reserve and aren't re-checked (only a
// top-up budget is).
function chargeDailyBudgets(user, models, keys, { arena = 'text', skip = [] } = {}) {
  const skipList = Array.isArray(skip) ? skip : [];
  const over = monthlyBudgetOver(user, models, keys, skipList);
  if (over) {
    const label = appSettings.PROVIDER_LABELS[over.provider] || over.provider;
    log.event('NOTICE', `[budget] blocked a ${arena} run for ${user.username}: the ${label} monthly budget is used up (${usd2(over.spentUsd)} of ${usd2(over.budgetUsd)})`, {
      user: user.username, provider: over.provider, budgetUsd: over.budgetUsd, spentUsd: over.spentUsd, arena,
    });
    return { ok: false, body: monthlyBudgetExhaustedBody(user, over) };
  }
  const charged = [];
  for (const p of budgetsNeeded(models, keys)) {
    if (skipList.includes(p)) continue;
    const q = auth.consumeProviderRun(user, p);
    if (!q.ok) {
      for (const c of charged) auth.refundProviderRun(user, c);
      return { ok: false, body: quotaExhaustedBody(user, p, q, arena) };
    }
    charged.push(p);
  }
  return { ok: true, charged, quotas: auth.quotaSnapshot(user) };
}
function refundDailyBudgets(user, charged) {
  for (const p of charged || []) auth.refundProviderRun(user, p);
}

function sanitizeImageKeys(rawKeys) {
  const keys = {};
  if (rawKeys && typeof rawKeys === 'object') {
    for (const k of ['agentplatform', 'gemini', 'openai', 'gcpProject']) {
      if (typeof rawKeys[k] === 'string' && rawKeys[k].trim()) keys[k] = rawKeys[k].trim();
    }
  }
  return keys;
}
function resolveImageSlotEntries(slots) {
  const requestedSlots = Array.isArray(slots) && slots.length ? slots.slice(0, 4) : DEFAULT_IMAGE_SLOTS;
  return requestedSlots.map((s, idx) => {
    const slotId = String((s && s.slot) || String.fromCharCode(65 + idx)).slice(0, 4);
    const requested = s && s.catalogId ? String(s.catalogId).slice(0, 100) : '';
    const catId = requested || IMAGE_MODEL_CATALOG[idx % IMAGE_MODEL_CATALOG.length].id;
    const entry = IMAGE_MODEL_CATALOG.find((m) => m.id === catId || m.model === catId) || null;
    return { slot: slotId, id: catId, label: entry ? entry.label : catId, provider: entry ? entry.provider : 'agentplatform', publisher: entry ? entry.publisher : 'google' };
  });
}

// One Image Arena run = one Run click: charge it ONCE up front (same rule as a text run)
// and hand back a ticket. Its per-slot requests present the ticket and aren't charged again.
app.post('/api/image-arena/reserve', (req, res) => {
  const keys = sanitizeImageKeys(req.body && req.body.keys);
  const entries = resolveImageSlotEntries(req.body && req.body.slots);
  const charge = chargeDailyBudgets(req.user, entries, keys, { arena: 'image' });
  if (!charge.ok) return res.status(429).json({ ok: false, ...charge.body });
  const ticket = runTickets.create({ username: req.user.username, slots: entries, charged: charge.charged });
  res.json({ ok: true, ticket: ticket.id, charged: charge.charged, quotas: charge.quotas });
});

// Reference images for an image run: at most 13 (the smallest catalog cap), each an
// allow-listed raster type with at most 12 MB of base64 (6.1). Returns an error
// string or null; the data URL prefix the client may send is tolerated.
const IMAGE_RUN_MAX_ATTACHMENTS = 13;
const IMAGE_RUN_MAX_B64 = 12 * 1024 * 1024;
function validateImageRunAttachments(attachments) {
  if (attachments == null) return null;
  if (!Array.isArray(attachments)) return 'attachments must be a list of reference images.';
  if (attachments.length > IMAGE_RUN_MAX_ATTACHMENTS) return `At most ${IMAGE_RUN_MAX_ATTACHMENTS} reference images per run.`;
  for (const att of attachments) {
    if (!att || typeof att !== 'object') return 'Each reference image must be an object.';
    const mime = String(att.mimeType || 'image/png');
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(mime)) return `Unsupported reference image type "${mime.slice(0, 60)}" (PNG, JPEG, WebP or GIF).`;
    if (att.data != null) {
      if (typeof att.data !== 'string') return 'Reference image data must be a base64 string.';
      const b64 = att.data.replace(/^data:[^;]+;base64,/, '');
      if (b64.length > IMAGE_RUN_MAX_B64) return 'A reference image is too large (12 MB limit).';
    }
  }
  return null;
}

app.post('/api/image-arena/run', wrap(async (req, res) => {
  req.setTimeout(0); // long generation: no per-request socket timeout
  // Capacity, not quota: one image request per user and three in the whole process.
  const lease = inflight.acquireAll([
    [`image:${req.user.username}`, MAX_CONCURRENT_IMAGE_PER_USER],
    ['image:*', MAX_CONCURRENT_IMAGE_GLOBAL],
  ]);
  if (!lease.ok) return res.status(429).json({ ok: false, error: TOO_MANY_CONCURRENT });
  try {
    await handleImageArenaRun(req, res);
  } finally {
    lease.release();
  }
}));
async function handleImageArenaRun(req, res) {
  const {
    slots,
    allSlots,
    runId: clientRunId,
    packId,
    scenarioId,
    scenarioTitle,
    prompt,
    aspectRatio,
    imageSize,
    attachments,
    keys: rawKeys,
    ticket: ticketId,
  } = req.body || {};
  const attachmentError = validateImageRunAttachments(attachments);
  if (attachmentError) return res.status(400).json({ ok: false, error: attachmentError });
  const keys = sanitizeImageKeys(rawKeys);
  const resolvedSlotEntries = resolveImageSlotEntries(slots);
  // Per-run charging: a slot that presents its run's ticket was already paid for at reserve...
  const ticket = runTickets.get(ticketId, req.user.username);
  const slotId = resolvedSlotEntries[0] && resolvedSlotEntries[0].slot;
  const claimed = !!(ticket && resolvedSlotEntries.length === 1
    && runTickets.claimSlot(ticket, slotId, resolvedSlotEntries[0].id));
  // ...unless it needs a budget the reservation didn't cover (e.g. reserved with an own key,
  // sent without it): top up, once per run. No valid ticket (stale page) = its own run.
  const charge = chargeDailyBudgets(req.user, resolvedSlotEntries, keys, { arena: 'image', skip: claimed ? ticket.charged : [] });
  if (!charge.ok) {
    if (claimed && runTickets.settleSlot(ticket, slotId, { abandoned: true })) refundDailyBudgets(req.user, ticket.charged);
    return res.status(429).json({ ok: false, ...charge.body });
  }
  if (claimed) for (const p of charge.charged) if (!ticket.charged.includes(p)) ticket.charged.push(p);
  const isExt = auth.isExternalAccount(req.user);
  const auditUser = { username: req.user.username, isExternal: isExt };
  const runId = history.newId();
  const sharedRunId = history.safeId(clientRunId) || (ticket && ticket.id ? `img_tkt_${ticket.id}` : runId);
  await history.recordPreExecutionAudit({
    id: runId,
    user: req.user.username,
    userName: req.user.name || req.user.username,
    isExternal: isExt,
    ip: isExt ? req.ip : null,
    userAgent: isExt ? req.headers['user-agent'] : null,
    arena: 'image',
    taskId: scenarioId || packId || 'image-arena',
    title: scenarioTitle || 'Image Arena Run',
    prompt: String(prompt || ''),
    models: resolvedSlotEntries.map((s) => ({ slot: s.slot, id: s.id, label: s.label, provider: s.provider })),
    attachments: Array.isArray(attachments) ? attachments : [],
  });

  const ac = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished && !res.writableFinished) {
      // Client went away: cancel upstream. Settling the ticket slot / refunding waits for
      // the generation promise below (it resolves right after the abort), so a slot whose
      // image had already come back is still counted as completed (8.1 / 5.3) and the
      // slot is settled exactly once.
      ac.abort();
      history.finalizeAuditRun(runId, { status: 'aborted' }).catch(() => {});
    }
  });
  try {
    const out = await runImageArenaComparison({
      slots,
      prompt,
      aspectRatio,
      imageSize,
      attachments: Array.isArray(attachments) ? attachments : [],
      keys,
      signal: ac.signal,
      auditUser,
    });
    const producedOk = Boolean(out && Array.isArray(out.results) && out.results.some((r) => r && r.ok));
    // App-tracked spend: each image generated on a global key adds its PayGo cost to this month
    // (recorded whether or not the client is still connected: the provider billed it).
    for (const r of (out && out.results) || []) {
      if (r && r.ok) spendLedger.recordModelCost({ provider: r.provider, publisher: r.publisher }, keys, r.standardPayGoCostUsd);
    }
    if (ac.signal.aborted) {
      // Abandoned: a ticketed run is refunded only once EVERY slot of it was abandoned
      // (same as an abandoned text run); a stand-alone request refunds its own charge
      // only when it produced nothing. Results nobody will see are not persisted (5.3).
      finished = true;
      if (claimed) {
        if (runTickets.settleSlot(ticket, slotId, { abandoned: !producedOk })) refundDailyBudgets(req.user, ticket.charged);
      } else if (!producedOk) {
        refundDailyBudgets(req.user, charge.charged);
      }
      return;
    }
    finished = true;
    if (claimed) runTickets.settleSlot(ticket, slotId, { abandoned: false });
    out.runId = sharedRunId;
    out.vertexQuota = auth.vertexRunQuota(req.user);
    out.quotas = auth.quotaSnapshot(req.user);
    history.finalizeAuditRun(runId, { status: 'completed' }).catch(() => {});
    // Pre-store generated images in the user's server-side binary vault and attach compact
    // `imageVaultRef` / `thoughtVaultRef` pointers so subsequent `/api/image-arena/history`
    // saves only need to send the tiny 1.5KB thumbnail + vaultRef (never re-uploading 4K PNGs).
    try {
      const uName = req.user && req.user.username;
      if (uName && out && Array.isArray(out.results)) {
        out.results.forEach((r, idx) => {
          if (!r || typeof r !== 'object') return;
          const slotTag = r.slot || String.fromCharCode(65 + idx);
          if (typeof r.imageDataUrl === 'string' && r.imageDataUrl.startsWith('data:')) {
            const ptr = history.vault.storeAttachmentInVaultSync(uName, {
              name: `img-slot-${slotTag}.png`,
              mimeType: r.mimeType || 'image/png',
              kind: 'image',
              data: r.imageDataUrl,
            });
            if (ptr && (ptr.vaultRef || ptr.sha256)) r.imageVaultRef = ptr.vaultRef || ptr.sha256;
          }
          if (typeof r.thoughtImageDataUrl === 'string' && r.thoughtImageDataUrl.startsWith('data:')) {
            const tPtr = history.vault.storeAttachmentInVaultSync(uName, {
              name: `thought-slot-${slotTag}.png`,
              mimeType: 'image/png',
              kind: 'image',
              data: r.thoughtImageDataUrl,
            });
            if (tPtr && (tPtr.vaultRef || tPtr.sha256)) r.thoughtVaultRef = tPtr.vaultRef || tPtr.sha256;
          }
        });
      }
      // Server-authoritative history persistence: immediately record/merge every completed
      // Image Arena slot into SQLite + disk history under `sharedRunId` so runs from any user
      // (including external users or tabs closed before all slots finish) are immediately visible
      // in History and Admin Usage without depending solely on a follow-up client POST.
      if (uName && out && Array.isArray(out.results) && out.results.some((r) => r && r.ok)) {
        const allResolvedSlots = Array.isArray(allSlots) && allSlots.length
          ? resolveImageSlotEntries(allSlots)
          : resolvedSlotEntries;
        await history.saveImageRun({
          id: sharedRunId,
          mergeSlots: true,
          user: uName,
          userName: (req.user && req.user.name) || uName,
          packId: packId || 'custom',
          scenarioId: scenarioId || 'custom',
          title: scenarioTitle || String(prompt || '').slice(0, 72) || 'Image Arena Run',
          prompt: String(prompt || ''),
          imageSize: imageSize || '2K',
          aspectRatio: aspectRatio || '16:9',
          slots: allResolvedSlots.map((s) => ({
            slot: s.slot,
            catalogId: s.id || s.catalogId,
            label: s.label,
          })),
          results: out.results.map((r) => ({
            ...r,
            costUsd: r.costUsd != null ? r.costUsd : r.standardPayGoCostUsd,
            imageDataUrl: null, // already stored in vault via r.imageVaultRef above
            thoughtImageDataUrl: null,
          })),
          attachments: Array.isArray(attachments) ? attachments : [],
        });
      }
    } catch (_) {}
    // Stream as chunked Transfer-Encoding (application/x-image-arena-json) so:
    // 1) Cloud Run's Google Frontend (GFE) never truncates 4K image payloads at the 32 MiB
    //    non-streaming Content-Length cap, and
    // 2) The response-scrubbing middleware does not re-allocate 30-80 MB UTF-8 strings on
    //    base64 PNG image buffers (all error/text fields are already scrubbed via scrubError).
    const payloadBuf = Buffer.from(JSON.stringify(out), 'utf8');
    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    const CHUNK = 256 * 1024;
    for (let off = 0; off < payloadBuf.length; off += CHUNK) {
      res.write(payloadBuf.subarray(off, Math.min(off + CHUNK, payloadBuf.length)));
    }
    res.end();
  } catch (e) {
    finished = true;
    if (claimed) runTickets.settleSlot(ticket, slotId, { abandoned: false }); // failed, not abandoned: no refund (same as text)
    history.finalizeAuditRun(runId, { status: 'error' }).catch(() => {});
    res.status(400).json({ ok: false, error: scrubError(String((e && e.message) || e)) });
  }
}

// Execute an LLM-generated solution: python -> run the program; javascript ->
// run the function against the task's hidden tests. taskId supplies the tests.
app.post('/api/execute', wrap(async (req, res) => {
  const { language, code, taskId, title, posX, posY, index, count, gap } = req.body || {};
  const task = TASKS.find((t) => t.id === taskId);
  try {
    const result = await runCode(language, code, {
      functionName: task && task.functionName,
      testCases: task && task.testCases,
      gui: task && task.gui,
      title,
      posX: Number(posX),
      posY: Number(posY),
      index: Number.isInteger(index) ? index : undefined, // 0-based slot, for centering a row of windows
      count: Number(count) || undefined,
      gap: Number(gap),
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
}));

// Blind Judge entries may carry CAD telemetry (3.12): keep only finite numbers /
// a boolean / up to three finite bbox numbers so nothing free-form reaches the prompt.
function sanitizeCadTelemetry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of ['partCount', 'triangleCount', 'volumeCm3']) {
    if (raw[k] == null) continue;
    const n = Number(raw[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  if (typeof raw.watertight === 'boolean') out.watertight = raw.watertight;
  if (Array.isArray(raw.boundingBoxMm)) {
    const bb = raw.boundingBoxMm.slice(0, 3).map((v) => Number(v)).filter((v) => Number.isFinite(v));
    if (bb.length) out.boundingBoxMm = bb;
  }
  return Object.keys(out).length ? out : null;
}

// Score a finished run's outputs with an LLM judge. Only meaningful for the
// ungraded (business / general) tasks, which have no hidden tests and therefore
// no quality signal of their own. Blinding and shuffling happen in src/judge.js.
app.post('/api/judge', wrap(async (req, res) => {
  req.setTimeout(0); // a 1M-token judge prompt can take minutes: no per-request socket timeout
  const { taskId, judge: judgeId, entries, attachments: rawAttachments } = req.body || {};
  const attachments = await attachmentsOr409(req, res, rawAttachments, { ok: false });
  if (!attachments) return;
  const foundTask = TASKS.find((t) => t.id === taskId);
  const task = foundTask
    ? { ...foundTask, attachments }
    : {
        id: 'custom',
        title: 'Custom prompt',
        prompt: String((req.body && req.body.prompt) || '').trim() || (attachments.length ? 'Analyze the attached file(s) and provide a detailed response.' : ''),
        testCases: [],
        attachments,
      };

  const judge = resolveModels([{ catalogId: judgeId, slot: 'J' }])[0];
  if (!judge || judge.catalogId !== judgeId) return res.status(400).json({ error: 'Pick a judge model from the catalog.' });

  const clean = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
    .slice(0, 6)
    .map((e) => ({
      slot: String(e.slot || '').slice(0, 4),
      label: String(e.label || '').slice(0, 80),
      text: e.text.slice(0, 1000000),
      costUsd: e.costUsd != null && isFinite(Number(e.costUsd)) ? Math.max(0, Number(e.costUsd)) : null,
      wallMs: e.wallMs != null && isFinite(Number(e.wallMs)) ? Math.max(0, Number(e.wallMs)) : null,
      tokensPerSec: e.tokensPerSec != null && isFinite(Number(e.tokensPerSec)) ? Math.max(0, Number(e.tokensPerSec)) : null,
      completionTokens: e.completionTokens != null && isFinite(Number(e.completionTokens)) ? Math.max(0, Math.round(Number(e.completionTokens))) : null,
      cadTelemetry: sanitizeCadTelemetry(e.cadTelemetry),
      fourViewDataUrl: typeof e.fourViewDataUrl === 'string' && e.fourViewDataUrl.startsWith('data:image/')
        ? e.fourViewDataUrl.slice(0, 6000000)
        : null,
    }));
  if (clean.length < 2) return res.status(400).json({ error: 'Need at least two model outputs to compare.' });

  const rawKeys = (req.body && req.body.keys) || {};
  const keys = {};
  for (const k of ['agentplatform', 'gemini', 'openai', 'anthropic', 'claudeBearerToken', 'gcpProject', 'moonshot']) {
    if (typeof rawKeys[k] === 'string' && rawKeys[k].trim()) keys[k] = rawKeys[k].trim();
  }

  // A Blind Judge call is a run on the judge model's provider budget (same rule as any run);
  // a judge on the user's own key never counts.
  const judgeCharge = chargeDailyBudgets(req.user, [judge], keys, { arena: 'text' });
  if (!judgeCharge.ok) {
    const b = judgeCharge.body;
    return res.status(429).json({
      ...b,
      error: b.externalQuotaExhausted
        ? `${b.error} Or switch the Judge model to a Gemini or Claude model on Vertex AI.`
        : b.error,
    });
  }

  const isExt = auth.isExternalAccount(req.user);
  const auditUser = { username: req.user.username, isExternal: isExt };
  const judgeAuditId = history.newId();
  await history.recordPreExecutionAudit({
    id: judgeAuditId,
    user: req.user.username,
    userName: req.user.name || req.user.username,
    isExternal: isExt,
    ip: isExt ? req.ip : null,
    userAgent: isExt ? req.headers['user-agent'] : null,
    arena: 'judge',
    taskId: task.id,
    title: `Judge · ${task.title}`,
    prompt: task.prompt,
    models: [judge],
    attachments: task.attachments || [],
  });

  // Price the judge call(s) on a global key: tokens x catalog price, each provider call
  // priced for its own prompt size (callCostUsd, tiered models). Used for the verdict's
  // usage and, on failure, for the partial calls the provider still billed (5.7).
  const recordJudgeCalls = (calls) => {
    const list = Array.isArray(calls) ? calls.filter((c) => c && typeof c === 'object') : [];
    const judgeCost = list.reduce((sum, c) => sum + callCostUsd(judge, Number(c.promptTokens) || 0, Number(c.completionTokens) || 0), 0);
    spendLedger.recordModelCost(judge, keys, judgeCost);
  };

  // A closed tab must cancel the (non-streaming, possibly minutes-long) judge call
  // instead of letting it finish unseen (5.1).
  const ac = new AbortController();
  let judgeFinished = false;
  res.on('close', () => {
    if (judgeFinished || res.writableFinished) return;
    ac.abort();
    history.finalizeAuditRun(judgeAuditId, { status: 'aborted' }).catch(() => {});
  });

  try {
    const verdict = await judgeOutputs({ task, entries: clean, judge, keys, signal: ac.signal, auditUser });
    judgeFinished = true;
    {
      const ju = verdict.usage || {};
      recordJudgeCalls(Array.isArray(ju.calls) && ju.calls.length ? ju.calls : [ju]);
    }
    // The verdict came back (even if the client left meanwhile): it is paid for, so keep it.
    history.finalizeAuditRun(judgeAuditId, { status: 'completed' }).catch(() => {});
    await history.attachJudgeToLatestRun(req.user.username, task.id, verdict, req.body && req.body.runId);
    console.log(`[judge] ${req.user.username} scored ${clean.length} outputs on "${task.id}" with ${judge.model}`);
    if (ac.signal.aborted) return; // nobody left to send it to
    res.json({ ok: true, ...verdict });
  } catch (e) {
    judgeFinished = true;
    // CONTRACT (src/judge.js): a failed judge attaches e.calls = [{ promptTokens, completionTokens }]
    // for every provider call it made, so the spend is recorded even though no verdict came back.
    if (e && Array.isArray(e.calls)) recordJudgeCalls(e.calls);
    if (ac.signal.aborted) return;
    history.finalizeAuditRun(judgeAuditId, { status: 'error' }).catch(() => {});
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
}));

// Build an LLM-generated Pygame program into a browser-runnable WASM bundle so a
// GUI task renders in the user's browser (works for remote clients). Returns a URL
// under /games/<id>/ that the client embeds in an <iframe>.
app.post('/api/web-game', wrap(async (req, res) => {
  req.setTimeout(0); // a pygbag build can take a few minutes
  if (!webGameEnabled()) return res.status(400).json({ error: 'Web game building is disabled (ENABLE_WEB_GAME=0).' });
  const code = String((req.body && req.body.code) || '');
  if (!code.trim()) return res.status(400).json({ error: 'No code provided.' });
  // Capacity, not quota: one build per user and two in the whole process (6.1).
  const lease = inflight.acquireAll([
    [`webgame:${req.user.username}`, MAX_CONCURRENT_WEB_GAME_PER_USER],
    ['webgame:*', MAX_CONCURRENT_WEB_GAME_GLOBAL],
  ]);
  if (!lease.ok) return res.status(429).json({ error: TOO_MANY_CONCURRENT });
  try {
    const { id, cached } = await buildWebGame(code, { username: req.user.username });
    res.json({ ok: true, id, cached, url: `/games/${id}/` });
  } catch (e) {
    // webGame.js tags its own refusals (429 build in progress, 413 program too large).
    const status = e && (e.status === 429 || e.status === 413) ? e.status : 400;
    res.status(status).json({ error: scrubError(String((e && e.message) || e)) });
  } finally {
    lease.release();
  }
}));

// (/games/:id/* and /games/:id are served before the auth gate, see above.)

// Does this model run on a user-supplied credential (vs. the server's)? Used to
// decide whether a run counts against the per-user daily quota. Defined in
// src/byok.js (imported above) so the provider adapters, the image arena and the
// quota checks all agree: Claude AND partner MaaS models on Vertex need the
// user's OAuth token; a Gemini/Vertex API key does not cover them.

// Lightweight attachment inspection & server-side SHA-1 LRU + per-user binary vault caching endpoint.
// Called immediately when the user drops/picks files so the UI shows exact server-extracted
// token counts, PDF page/encryption metadata, and stores the raw file in the user's vault.
app.post('/api/attachments/inspect', wrap(async (req, res) => {
  try {
    const rawAttachments = (req.body && req.body.attachments) || [];
    const items = await inspectAttachmentsAsync(rawAttachments, {
      username: req.user && req.user.username,
      isAdmin: Boolean(req.user && req.user.role === 'admin'),
    });
    res.json({ ok: true, attachments: items });
  } catch (e) {
    const status = e && e.code === 'ATTACHMENT_EXPIRED' ? 409 : 400;
    res.status(status).json({ ok: false, error: scrubError(e.message || String(e)), code: e && e.code, expired: e && e.expired });
  }
}));

// Per-user cap on concurrent LARGE uploads (6.1), decided on Content-Length before
// express.raw buffers the body; the lease is released when the response closes.
function largeUploadGate(req, res, next) {
  const declared = Number(req.headers['content-length']);
  if (!(declared > LARGE_UPLOAD_BYTES)) return next();
  const lease = inflight.acquire(`upload:${req.user.username}`, MAX_CONCURRENT_LARGE_UPLOADS_PER_USER);
  if (!lease.ok) return res.status(429).json({ ok: false, error: TOO_MANY_CONCURRENT });
  res.once('close', lease.release);
  return next();
}

// Multipart alternative to the base64-JSON inspect endpoint (same response
// shape, same caching). Avoids the ~33% base64 overhead for large files:
//   curl -F files=@report.pdf -F files=@data.xlsx https://…/api/attachments/upload
// Optional Claude copy of an oversized image (same filename as the original):
//   curl -F files=@photo.png -F "claude_scaled=@small.webp;filename=photo.png;type=image/webp" …
// Authenticated (mounted after the auth gate); body capped by MULTIPART_LIMIT.
app.post('/api/attachments/upload',
  largeUploadGate,
  express.raw({ type: 'multipart/form-data', limit: process.env.MULTIPART_LIMIT || process.env.JSON_BODY_LIMIT || '50mb' }),
  wrap(async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, error: 'Expected a multipart/form-data body with one or more files.' });
      // Up to MAX_ATTACHMENTS originals, each optionally followed by a part named
      // "claude_scaled" with the SAME filename: a downscaled copy used only for
      // Claude when the original image exceeds Anthropic's 5 MB cap (validated in
      // attachments.js exactly like the JSON path's claudeDataBase64/claudeMimeType).
      // A part named "fit_scaled" (same filename) is the OpenAI patch-budget copy.
      const { files } = parseMultipart(req.body, req.headers['content-type'], { maxFiles: MAX_ATTACHMENTS * 3, maxFileBytes: 25 * 1024 * 1024 });
      const originals = files.filter((f) => f.field !== 'claude_scaled' && f.field !== 'fit_scaled');
      if (originals.length > MAX_ATTACHMENTS) return res.status(400).json({ ok: false, error: `Too many files (max ${MAX_ATTACHMENTS}).` });
      if (!originals.length) return res.status(400).json({ ok: false, error: 'No files in upload.' });
      const scaled = new Map();
      const fit = new Map();
      for (const f of files) if (f.field === 'claude_scaled' && !scaled.has(f.filename)) scaled.set(f.filename, f);
      for (const f of files) if (f.field === 'fit_scaled' && !fit.has(f.filename)) fit.set(f.filename, f);
      const raw = originals.map((f) => {
        const item = { name: f.filename, mimeType: f.contentType, size: f.data.length, data: f.data.toString('base64') };
        const s = scaled.get(f.filename);
        if (s) { item.claudeDataBase64 = s.data.toString('base64'); item.claudeMimeType = s.contentType; }
        const ft = fit.get(f.filename);
        if (ft) { item.fitDataBase64 = ft.data.toString('base64'); item.fitMimeType = ft.contentType; }
        return item;
      });
      const items = await inspectAttachmentsAsync(raw, { username: req.user && req.user.username });
      res.json({ ok: true, attachments: items });
    } catch (e) {
      res.status((e && e.status) || 400).json({ ok: false, error: scrubError((e && e.message) || String(e)) });
    }
  }),
  (err, _req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ ok: false, error: 'Upload exceeds the server request limit.' });
    return next(err);
  });

// ---------- 3D & CAD Arena: Autodesk Fusion 360 & Headless CAD MCP Bridge ----------
app.get('/api/cad-mcp/status', (_req, res) => {
  res.json(getCadMcpStatus());
});

// The transpiler interpolates these into Python comments / strings (3.9): one
// capital letter for the slot, no line breaks in the label.
const cadSlotParam = (v) => (/^[A-Z]$/.test(String(v || '')) ? String(v) : 'A');
const cadLabelParam = (v, n) => String(v || '').replace(/[\r\n]+/g, ' ').slice(0, n);

app.post(['/api/cad-mcp/transpile', '/api/cad-mcp/fusion360-script'], (req, res) => {
  try {
    const body = req.body || {};
    const fusionScript = transpileToFusion360Python({
      code: String(body.code || '').slice(0, 200000),
      params: body.params && typeof body.params === 'object' ? body.params : {},
      telemetry: body.telemetry && typeof body.telemetry === 'object' ? body.telemetry : null,
      stepText: typeof body.stepText === 'string' ? body.stepText.slice(0, 4000000) : '',
      title: cadLabelParam(body.title || body.taskTitle || 'LLM_Compare_3D_Model', 140),
      taskTitle: cadLabelParam(body.taskTitle || body.title || 'LLM_Compare_3D_Model', 140),
      slot: cadSlotParam(body.slot),
      modelLabel: cadLabelParam(body.modelLabel, 100),
    });
    res.json({
      ok: true,
      script: fusionScript,
      fusionScript,
      mcpStatus: getCadMcpStatus(),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: scrubError(String((e && e.message) || e)) });
  }
});

// Push the generated script to the CAD MCP bridge. SECURITY (3.7): the bridge URL comes
// ONLY from the server's own CAD_MCP_URL (getCadMcpStatus); a client-supplied
// endpointUrl is ignored, so this route can never be pointed at this server's
// loopback (auto-admin) or anything else. The bridge's response body is never
// echoed back; only ok + HTTP status are reported.
app.post('/api/cad-mcp/push', wrap(async (req, res) => {
  try {
    const body = req.body || {};
    const slot = cadSlotParam(body.slot);
    const modelLabel = cadLabelParam(body.modelLabel, 100);
    const fusionScript = transpileToFusion360Python({
      code: String(body.code || '').slice(0, 200000),
      params: body.params && typeof body.params === 'object' ? body.params : {},
      telemetry: body.telemetry && typeof body.telemetry === 'object' ? body.telemetry : null,
      stepText: typeof body.stepText === 'string' ? body.stepText.slice(0, 4000000) : '',
      taskTitle: cadLabelParam(body.taskTitle || body.title || 'LLM_Compare_3D_Model', 140),
      slot,
      modelLabel,
    });
    const status = getCadMcpStatus();
    const configuredUrl = String(process.env.CAD_MCP_URL || '').trim(); // raw (may carry bridge credentials)
    const displayUrl = status.fusionMcp.endpoint || status.blenderMcp.endpoint || null; // credential-masked
    let pushed = false;
    let upstreamStatus = null;
    let reason = null;

    if (!configuredUrl || !displayUrl || !/^https?:\/\//i.test(configuredUrl)) {
      reason = 'bridge_not_configured';
    } else {
      try {
        const r = await fetch(configuredUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-LLMC-Internal': '1' },
          body: JSON.stringify({
            tool: typeof body.tool === 'string' ? body.tool.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'fusion360_execute_script' : 'fusion360_execute_script',
            slot,
            modelLabel,
            fusionScript,
            stepText: typeof body.stepText === 'string' ? body.stepText.slice(0, 2000000) : undefined,
            telemetry: body.telemetry && typeof body.telemetry === 'object' ? body.telemetry : null,
          }),
          signal: AbortSignal.timeout(8000),
        });
        pushed = r.ok;
        upstreamStatus = r.status;
        if (!r.ok) reason = 'bridge_rejected';
        await r.arrayBuffer().catch(() => {}); // drain, never forwarded
      } catch (bridgeErr) {
        reason = 'bridge_unreachable';
        log.event('WARNING', '[cad-mcp] bridge push failed', { user: req.user.username, error: scrubError(String((bridgeErr && bridgeErr.message) || bridgeErr)) });
      }
    }

    res.json({
      ok: true,
      pushed,
      reason,
      // endpointUrl / upstreamStatus are what the UI prints ("Pushed to ... (HTTP ...)").
      endpointUrl: displayUrl,
      targetUrl: displayUrl,
      upstreamStatus,
      bridgeResponse: pushed
        ? `Pushed to the configured CAD MCP bridge (HTTP ${upstreamStatus}).`
        : (reason === 'bridge_not_configured'
          ? 'No CAD MCP bridge is configured on the server (CAD_MCP_URL). Copy or download the generated Fusion 360 Python API script below.'
          : `The configured CAD MCP bridge did not accept the script (${reason}${upstreamStatus ? ', HTTP ' + upstreamStatus : ''}). Copy or download the generated Fusion 360 Python API script below.`),
      fusionScript,
      mcpStatus: status,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: scrubError(String((e && e.message) || e)) });
  }
}));

function sanitizeCadModifyPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const modificationPrompt = typeof raw.modificationPrompt === 'string'
    ? raw.modificationPrompt.trim().slice(0, 8000)
    : '';
  const targetPart = typeof raw.targetPart === 'string' && raw.targetPart.trim()
    ? raw.targetPart.trim().slice(0, 120)
    : null;

  const sanitizeSlotEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const previousCode = typeof entry.previousCode === 'string' ? entry.previousCode.slice(0, 120000) : '';
    if (!previousCode.trim()) return null;
    return {
      previousCode,
      modificationPrompt: typeof entry.modificationPrompt === 'string' && entry.modificationPrompt.trim()
        ? entry.modificationPrompt.trim().slice(0, 8000)
        : modificationPrompt,
      targetPart: typeof entry.targetPart === 'string' && entry.targetPart.trim()
        ? entry.targetPart.trim().slice(0, 120)
        : targetPart,
      telemetry: entry.telemetry && typeof entry.telemetry === 'object' ? entry.telemetry : null,
      fourViewDataUrl: typeof entry.fourViewDataUrl === 'string' && entry.fourViewDataUrl.startsWith('data:image/')
        ? entry.fourViewDataUrl.slice(0, 6000000)
        : null,
    };
  };

  const bySlot = {};
  if (raw.bySlot && typeof raw.bySlot === 'object') {
    for (const [k, v] of Object.entries(raw.bySlot)) {
      const slotKey = String(k || '').slice(0, 4);
      const cleanSlot = sanitizeSlotEntry(v);
      if (slotKey && cleanSlot) bySlot[slotKey] = cleanSlot;
    }
  }
  const topSlot = sanitizeSlotEntry(raw);
  if (!modificationPrompt && !Object.keys(bySlot).length && !topSlot) return null;
  return {
    modificationPrompt,
    targetPart,
    ...(topSlot || {}),
    bySlot,
  };
}

app.post('/api/run', wrap(async (req, res) => {
  req.setTimeout(0); // NDJSON stream with its own heartbeat: no per-request socket timeout
  // Capacity, not quota (admins and BYOK included): at most 3 live streams per user (8.1 / 9.2).
  const lease = inflight.acquire(`run:${req.user.username}`, MAX_CONCURRENT_RUNS_PER_USER);
  if (!lease.ok) return res.status(429).json({ type: 'error', error: TOO_MANY_CONCURRENT });
  try {
    await handleRun(req, res);
  } finally {
    lease.release();
  }
}));
async function handleRun(req, res) {
  const { taskId, models, maxIterations, customPrompt, arenaMode, cadModify: rawCadModify, attachments: rawAttachments } = req.body || {};
  // Resolved BEFORE any quota is consumed, so a 409 (expired cache → client
  // re-uploads and retries) never costs the user a run.
  const attachments = await attachmentsOr409(req, res, rawAttachments, { type: 'error' });
  if (!attachments) return;
  // Sanitize any user-provided ("bring your own") API credentials (strings only).
  const rawKeys = (req.body && req.body.keys) || {};
  const keys = {};
  for (const k of ['agentplatform', 'gemini', 'openai', 'anthropic', 'claudeBearerToken', 'gcpProject', 'moonshot']) {
    if (typeof rawKeys[k] === 'string' && rawKeys[k].trim()) keys[k] = rawKeys[k].trim();
  }
  let task;
  const isCustomOrSaved = taskId === 'custom' || taskId === '__custom__' || String(taskId || '').startsWith('saved:');
  if (isCustomOrSaved) {
    const defaultCustomPrompt = attachments.length
      ? 'Analyze the attached file(s) and provide a detailed response.'
      : (arenaMode === '3d' ? 'Design a parametric 3D mechanical part in millimeters.' : 'Write a short response.');
    const explicitTitle = (req.body && typeof req.body.taskTitle === 'string' && req.body.taskTitle.trim())
      ? req.body.taskTitle.trim().slice(0, 120)
      : '';
    const defaultTitle = attachments.length
      ? `Custom prompt (${attachments.length} attachment${attachments.length > 1 ? 's' : ''})`
      : (arenaMode === '3d' ? 'Custom 3D & CAD prompt' : 'Custom prompt');
    task = {
      id: 'custom',
      title: explicitTitle || defaultTitle,
      prompt: (customPrompt || '').trim() || defaultCustomPrompt,
      functionName: arenaMode === '3d' ? 'buildModel' : 'solution',
      category: arenaMode === '3d' ? 'cad3d' : undefined,
      language: arenaMode === '3d' ? 'javascript' : null,
      visualizer: arenaMode === '3d' ? 'cad3d' : null,
      testCases: [], // no hidden tests -> single generation, no self-debug loop
      attachments,
    };
  } else {
    const baseTask = TASKS.find((t) => t.id === taskId) || TASKS[0];
    task = attachments.length ? { ...baseTask, attachments } : baseTask;
  }
  task = wrapTaskForCadArena(task, arenaMode);
  const cadModify = sanitizeCadModifyPayload(rawCadModify);
  // Server-authoritative: rebuild every slot from the fixed catalog. Any
  // client-supplied price / model id / provider is ignored — users can only
  // add/remove catalog models, never modify their settings.
  const chosenModels = resolveModels(models);
  // Nothing resolvable (stale page, retired ids): say so before anything is charged,
  // audited or written to history (4.14). resolveModels() falls back to the default
  // trio when nothing resolves, so that fallback is kept ONLY when `models` is absent
  // (or not a list): an explicit empty list, or a list naming models that are not in
  // the catalog, is a 400 instead of silently running three models the user never picked.
  const requestedModels = Array.isArray(models) ? models.filter((m) => m && typeof m === 'object') : [];
  const inCatalog = (m) => {
    const raw = m.catalogId || m.id || m.model;
    const id = RETIRED_REPLACEMENT[raw] || raw;
    return MODEL_CATALOG.some((c) => (c.id === id || c.model === id) && !c.blocked);
  };
  if (!chosenModels.length || (Array.isArray(models) && !requestedModels.some(inCatalog))) {
    return res.status(400).json({ type: 'error', error: 'Pick at least one catalog model.' });
  }

  // `kind` only labels the run in logs now: a single-model re-run is a run like any other
  // (one rule for the whole app, see chargeDailyBudgets).
  const kind = (req.body && req.body.mode === 'single' && chosenModels.length === 1) ? 'single' : 'compare';

  // Crash-repair round: the client hands back the code it actually ran and the
  // failure it produced, and the model gets one chance to fix it. Only ever for
  // a single model — repairing a whole comparison at once would silently give
  // every slot an extra attempt and make the correctness numbers meaningless.
  // Both fields are hard-capped here; the prompt builder truncates again.
  const rawRepair = (req.body && req.body.repair) || null;
  const repair = (rawRepair && chosenModels.length === 1
    && typeof rawRepair.code === 'string' && rawRepair.code.trim()
    && typeof rawRepair.error === 'string' && rawRepair.error.trim())
    ? { code: rawRepair.code.slice(0, 20000), error: rawRepair.error.slice(0, 4000) }
    : null;
  // Daily budgets on the global keys: this run is charged once per provider it touches
  // (OpenAI / Anthropic / Moonshot / Vertex AI), however many models it compares.
  const charge = chargeDailyBudgets(req.user, chosenModels, keys, { arena: 'text' });
  if (!charge.ok) return res.status(429).json(charge.body);
  const quotaInfo = auth.providerQuota(req.user, 'openai');
  const vertexQuotaInfo = auth.providerQuota(req.user, 'vertex');
  const iters = Math.max(1, Math.min(8, Number(maxIterations) || 1)); // single-shot by default (no self-debug retries)

  // NDJSON stream: one JSON object per line.
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (obj) => {
    try {
      res.write(JSON.stringify(obj) + '\n');
    } catch (_) {
      /* client likely disconnected */
    }
  };

  emit({ type: 'quota', quota: quotaInfo, vertexQuota: vertexQuotaInfo, quotas: charge.quotas }); // let the UI update the "runs left today" counters

  // If the client goes away (closes the tab, or hits "Run again" to restart a
  // slot) abort the upstream provider calls instead of letting them finish
  // unseen — an abandoned run would otherwise keep generating billable tokens.
  // The work is discarded, so the quota slot is handed back too.
  const ac = new AbortController();
  let finished = false;
  let aborted = false;
  // Periodic NDJSON heartbeat so Cloud Run / load balancers never idle-timeout
  // long-thinking model streams before the first token arrives.
  const heartbeatTimer = setInterval(() => {
    if (!finished && !aborted && !res.writableEnded) {
      emit({ type: 'ping', ts: Date.now() });
    }
  }, 15000);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  const runId = history.newId();
  const isExt = auth.isExternalAccount(req.user);
  const auditUser = { username: req.user.username, isExternal: isExt };
  const runArena = (arenaMode === '3d' || isCadTask(task)) ? '3d' : 'text';

  // Pre-execution 90-day security & compliance audit log: written BEFORE upstream
  // model APIs are called so aborted or safety-blocked prompts/attachments are still recorded.
  // @google.com users log without IP/User-Agent; external accounts log full IP + User-Agent.
  await history.recordPreExecutionAudit({
    id: runId,
    user: req.user.username,
    userName: req.user.name || req.user.username,
    isExternal: isExt,
    ip: isExt ? req.ip : null,
    userAgent: isExt ? req.headers['user-agent'] : null,
    arena: runArena,
    taskId: task.id,
    title: task.title,
    prompt: typeof customPrompt === 'string' && customPrompt.trim() ? customPrompt : task.prompt,
    models: chosenModels,
    attachments: task.attachments || [],
  });

  // App-tracked spend: every finished model call that ran on a global key adds its
  // cost to this month's ledger for that provider (own-key calls are skipped).
  // Partial spend (8.1): the orchestrator's delta / iteration / model_error / done
  // events carry a cumulative numeric costUsd per slot (CONTRACT with src/agent.js,
  // src/orchestrator.js; tolerated when absent). The latest estimate per slot is
  // kept so an aborted or failed slot still books what the provider already billed.
  const slotModels = new Map(chosenModels.map((m) => [m.slot, m]));
  const lastCostBySlot = new Map();   // slot -> latest cumulative cost estimate (USD)
  const doneSlots = new Set();        // slots whose final cost was already recorded
  let sawOutput = false;              // any model produced output: the daily charge stands
  const eventCost = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const r = obj.result && typeof obj.result === 'object' ? obj.result : null;
    // A done event's result.costUsd is the final figure; live events carry costUsd and an
    // abort / provider error may report partialCostUsd instead.
    for (const c of [r && r.costUsd, obj.costUsd, r && r.partialCostUsd, obj.partialCostUsd]) {
      const n = Number(c);
      if (c != null && Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  };
  const bookPendingSlotCosts = () => {
    for (const [slot, usd] of lastCostBySlot) {
      if (doneSlots.has(slot) || !(usd > 0)) continue;
      doneSlots.add(slot);
      spendLedger.recordModelCost(slotModels.get(slot), keys, usd);
    }
  };

  // NOTE: this must be res 'close', NOT req 'close'. The request stream closes as
  // soon as its body has been read, which is long before the run ends — listening
  // there aborts every run the instant it starts. res 'close' fires either when
  // the response completes (guarded by `finished`) or when the peer really goes away.
  res.on('close', () => {
    clearInterval(heartbeatTimer);
    if (finished || res.writableFinished) return;
    aborted = true;
    ac.abort();
    // Refund the daily charge ONLY when no model produced anything yet (8.1): once
    // output has streamed the run is real work (and real provider spend), exactly
    // like an abandoned image slot. Whatever each still-running slot had cost so far
    // goes to the monthly ledger now, since no `done` event will follow.
    const refunded = !sawOutput;
    if (refunded) refundDailyBudgets(req.user, charge.charged);
    bookPendingSlotCosts();
    history.finalizeAuditRun(runId, { status: 'aborted' }).catch(() => {});
    console.log(`[run] ${req.user.username} abandoned a ${kind} run - upstream aborted, ${refunded ? 'quota refunded (nothing had streamed)' : 'quota kept (output had streamed), partial spend recorded'}`);
  });

  let results = null;
  const meteredEmit = (obj) => {
    if (obj && typeof obj === 'object') {
      const t = obj.type;
      const slot = obj.slot;
      if (t === 'delta' || t === 'iteration' || t === 'done' || t === 'model_error') sawOutput = true;
      const usd = eventCost(obj);
      if (slot != null && usd != null) lastCostBySlot.set(slot, usd);
      if ((t === 'done' || t === 'model_error') && slot != null && !doneSlots.has(slot)) {
        // Final cost for this slot: the event's own figure, else the last live estimate.
        const finalUsd = usd != null ? usd : lastCostBySlot.get(slot);
        doneSlots.add(slot);
        if (finalUsd > 0) spendLedger.recordModelCost(slotModels.get(slot), keys, finalUsd);
      }
    }
    emit(obj);
  };
  try {
    results = await runComparison({ task, models: chosenModels, maxIterations: iters, emit: meteredEmit, keys, signal: ac.signal, repair, cadModify, runId, auditUser });
  } catch (e) {
    if (!aborted) emit({ type: 'error', message: scrubError(String((e && e.message) || e)) });
  } finally {
    clearInterval(heartbeatTimer);
    // A slot that ended without a done / model_error event (orchestrator threw) still
    // books its last live estimate.
    bookPendingSlotCosts();
  }
  finished = true;
  if (aborted) return res.end();   // client disconnected: pre-execution audit record already marked 'aborted'
  // Log this run to the durable per-user history. FIRE-AND-FORGET: saveRun is
  // async and never throws, so this never blocks res.end() or the event loop on
  // a slow gcsfuse write (which would otherwise stall other users on this single
  // instance). The server is the source of truth (the browser never writes
  // history), so a user cannot forge or tamper with the log.
  if (Array.isArray(results)) {
    history.saveRun({
      id: runId,
      user: req.user.username,
      userName: req.user.username,
      task,
      customPrompt: typeof customPrompt === 'string' ? customPrompt : undefined,
      models: chosenModels,
      results,
      kind,
      arena: runArena,
      ip: isExt ? req.ip : null,
      userAgent: isExt ? req.headers['user-agent'] : null,
      isExternal: isExt,
    }).catch(() => {});
  } else {
    history.finalizeAuditRun(runId, { status: 'error' }).catch(() => {});
  }
  res.end();
}

// Final JSON error handler (5.4): anything a wrap()ped async handler threw, or a
// body-parser error jsonBodyError did not recognise, ends here as a 500 with a
// fixed message (details only in the log) instead of a hung request.
app.use((err, req, res, next) => {
  log.event('ERROR', `[http] unhandled error on ${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    user: (req.user && req.user.username) || 'anon',
    error: scrubError(String((err && (err.stack || err.message)) || err)),
  });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal error' });
});

// ---------------------------------------------------------------------------
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || 8080);
// Bind to all interfaces so the app is reachable from other devices on the LAN
// (and the internet, if you forward the port). Set HOST=127.0.0.1 for localhost.
const HOST = process.env.HOST || '0.0.0.0';

function lanAddresses() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

globalKeys.start();   // warm the shared keys from Secret Manager + keep them fresh
{
  const { CONNECT_ATTEMPT_TIMEOUT_MS } = require('./src/providerFetch');
  log.event('INFO', `[providerFetch] connect attempt timeout ${CONNECT_ATTEMPT_TIMEOUT_MS == null ? 'n/a (no autoSelectFamily API)' : CONNECT_ATTEMPT_TIMEOUT_MS + 'ms'} (PROVIDER_CONNECT_ATTEMPT_TIMEOUT_MS)`, { connectAttemptTimeoutMs: CONNECT_ATTEMPT_TIMEOUT_MS });
}

const server = app.listen(PORT, HOST, () => {
  console.log(`\n  LLM Agent Arena`);
  console.log(`  primary URL     ->  http://localhost:${PORT}`);
  const setupCode = auth.ensureSetupCode();
  if (setupCode) {
    console.log(`  first-run code  ->  ${setupCode}`);
  }
  // Optional second listener, OFF by default (audit R10: an automatic :3000
  // listener doubled the local attack surface). Opt in with SECONDARY_PORT=<port>,
  // e.g. SECONDARY_PORT=3000. Unset, empty, 0 or anything that isn't a valid
  // port means off. Never started on Cloud Run or on the primary port itself.
  const secondaryPort = /^\d+$/.test(String(process.env.SECONDARY_PORT || '').trim())
    ? parseInt(process.env.SECONDARY_PORT, 10) : 0;
  if (!process.env.K_SERVICE && secondaryPort > 0 && secondaryPort <= 65535 && secondaryPort !== PORT) {
    extraServer = app.listen(secondaryPort, HOST, () => {
      console.log(`  secondary URL   ->  http://localhost:${secondaryPort}`);
    });
    extraServer.on('error', (e) => {
      console.warn(`  secondary listener on :${secondaryPort} not started (${(e && e.code) || 'error'})`);
    });
    tuneServerTimeouts(extraServer);
  }
  if (HOST === '0.0.0.0' || HOST === '::') {
    const ips = lanAddresses();
    if (ips.length) {
      ips.forEach((ip) => console.log(`  on your network ->  http://${ip}:${PORT}`));
      console.log('  (share a network URL with devices on the same Wi-Fi/LAN)');
    } else {
      console.log('  (listening on all interfaces, but no LAN IPv4 address was found)');
    }
  } else {
    console.log(`  (bound to ${HOST} — localhost only)`);
  }
});

// Socket timeouts (9.2): slow-header (slowloris-style) connections are cut after
// 30 s, idle keep-alive sockets after 65 s (above the usual 60 s load-balancer idle
// timeout so the proxy, not this server, closes first). requestTimeout stays at
// Node's default; the long-lived streaming routes (/api/run, /api/image-arena/run,
// /api/judge, /api/web-game) disable the per-request timeout themselves.
function tuneServerTimeouts(s) {
  if (!s) return;
  s.headersTimeout = 30000;
  s.keepAliveTimeout = 65000;
}
tuneServerTimeouts(server);

// ---------------------------------------------------------------------------
// Graceful shutdown. Cloud Run sends SIGTERM and allows ~10 s before SIGKILL.
// Stop accepting new connections, flip /healthz to 503, let in-flight requests
// (including streaming NDJSON runs) finish for up to SHUTDOWN_DRAIN_MS, then
// exit. A second signal exits immediately.
// ---------------------------------------------------------------------------
let extraServer = null;
const DRAIN_MS = Math.max(0, Number(process.env.SHUTDOWN_DRAIN_MS) || 9000);
// Debounced stores (daily budgets, spend ledger) land their last write synchronously
// before the process exits; never throws.
function flushStoresSync() {
  try { if (typeof auth.flushSync === 'function') auth.flushSync(); } catch (_) { /* best effort */ }
  try { if (typeof spendLedger.flushSync === 'function') spendLedger.flushSync(); } catch (_) { /* best effort */ }
}
function shutdown(signal) {
  if (draining) { process.exit(0); }
  draining = true;
  log.event('INFO', `[shutdown] ${signal} received — draining for up to ${DRAIN_MS}ms`, { signal, drainMs: DRAIN_MS });
  // Fire-and-forget history writes (saveRun / saveImageRun) are drained first so a
  // deploy never leaves ghost runs (5.6), then the SQLite snapshot is flushed.
  const drainPromise = (typeof history.drainPendingWrites === 'function')
    ? Promise.resolve().then(() => history.drainPendingWrites()).catch(() => {})
    : Promise.resolve();
  const flushPromise = drainPromise.then(() => ((typeof history.flushSnapshotAsync === 'function')
    ? history.flushSnapshotAsync().catch(() => {})
    : undefined)).then(flushStoresSync, flushStoresSync);
  const servers = [server, extraServer].filter(Boolean);
  let open = servers.length;
  const done = () => {
    if (--open <= 0) {
      flushPromise.finally(() => {
        log.event('INFO', '[shutdown] drained cleanly');
        process.exit(0);
      });
    }
  };
  for (const s of servers) {
    s.close(done);
    if (typeof s.closeIdleConnections === 'function') s.closeIdleConnections();
  }
  // Sockets that finish their in-flight request become idle keep-alives; close
  // them promptly instead of waiting out keepAliveTimeout.
  setInterval(() => {
    for (const s of servers) if (typeof s.closeIdleConnections === 'function') s.closeIdleConnections();
  }, 250).unref();
  setTimeout(() => {
    // Hard stop 2 s later even if a history drain is stuck on a slow gcsfuse write;
    // the synchronous stores are flushed on the way out either way.
    setTimeout(() => { flushStoresSync(); process.exit(0); }, 2000).unref();
    flushPromise.finally(() => {
      log.event('WARNING', '[shutdown] drain timeout — exiting with requests still open');
      process.exit(0);
    });
  }, DRAIN_MS).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.event('ERROR', '[process] unhandledRejection', {
    reason: reason && (reason.stack || reason.message || String(reason)),
  });
});

process.on('uncaughtException', (err) => {
  log.event('ERROR', '[process] uncaughtException', {
    error: err && (err.stack || err.message || String(err)),
  });
  // A process that just threw outside any handler is in an unknown state (5.4 / 9.2):
  // stop taking new work (/healthz -> 503), give in-flight responses 2 s, then exit so
  // the platform restarts a healthy instance instead of keeping a wedged one alive.
  draining = true;
  setTimeout(() => { flushStoresSync(); process.exit(1); }, 2000).unref();
});
