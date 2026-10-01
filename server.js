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

const { runComparison } = require('./src/orchestrator');
const { thinkingProfile, thinkingOptions } = require('./src/providers');
const { DEFAULT_MODELS, MODEL_CATALOG, resolveModels } = require('./src/pricing');
const { TASKS } = require('./src/tasks');
const { autoMintEnabled } = require('./src/gcloudToken');
const { runCode, executionEnabled } = require('./src/codeRunner');
const { judgeOutputs } = require('./src/judge');
const { buildWebGame, gameDir, webGameEnabled } = require('./src/webGame');
const history = require('./src/history');
const auth = require('./src/auth');
const googleAuth = require('./src/googleAuth');
const globalKeys = require('./src/globalKeys');
const { normalizeAttachmentsAsync, inspectAttachmentsAsync, MAX_ATTACHMENTS } = require('./src/attachments');
const { parseMultipart } = require('./src/multipart');
const { scrubError, maskKnown } = require('./src/secrets');
const { buildComparisonPdf, pdfFilename } = require('./src/pdfReport');

// Resolve request attachments (PDF/ZIP parsing runs in worker threads). If the
// request references cached files that have expired, answer 409 with the list
// so the client can re-upload — never run with an empty file. Returns null when
// a response has already been sent.
async function attachmentsOr409(req, res, raw, errorShape) {
  try {
    return await normalizeAttachmentsAsync(raw, { username: req && req.user && req.user.username });
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
  const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1' || req.hostname === '::1' || !!process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
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
    "connect-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "base-uri 'self'",
    "form-action 'self'",
    isLocal ? "frame-ancestors *" : "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '));
  next();
});

// Defense in depth (R6): every /api/* response body — JSON, NDJSON stream,
// errors — has any configured secret value (server keys + this request's BYOK
// keys) masked before it leaves the process. Exact-value masking only, so
// normal model output is never rewritten.
app.use('/api', (req, res, next) => {
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const textual = () => /json|ndjson|text/i.test(String(res.getHeader('Content-Type') || 'application/json'));
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
app.use((req, res, next) => (PUBLIC_JSON_PATHS.has(req.path) ? publicJson(req, res, next) : next()));
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
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f1523"/><path d="M32 10 L50 32 L32 54 L14 32 Z" fill="#5e8bff"/></svg>',
  'utf8'
);
app.get('/favicon.ico', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Length', String(FAVICON_SVG.length));
  res.end(FAVICON_SVG);
});

// Login / first-run setup page. Strict per-response CSP with a fresh nonce so
// the inline <style>/<script> run but nothing else can.
app.get(['/login', '/login.html'], (req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
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
  res.json({
    setupRequired: auth.setupRequired(),
    authenticated: !!s,
    user: s ? { username: s.username, role: s.role } : null,
    googleAuth: googleAuth.googleAuthEnabled(),
    allowedDomains: googleAuth.allowedDomains(),
  });
});

// First-run only: create the admin account. Gated by the console setup code.
app.post('/api/auth/setup', async (req, res) => {
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
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const ip = req.ip;
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const ukey = 'login|' + ip + '|' + username;
  const ipkey = 'loginip|' + ip;
  if (auth.isLocked(ukey) || auth.isLocked(ipkey)) {
    const ms = Math.max(auth.lockRemainingMs(ukey), auth.lockRemainingMs(ipkey));
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(ms / 1000)}s.` });
  }
  const user = await auth.authenticate(username, password);
  if (!user) {
    auth.recordFailure(ukey);
    auth.recordFailure(ipkey);
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  auth.recordSuccess(ukey);
  auth.recordSuccess(ipkey);
  auth.setSessionCookie(req, res, auth.createSession(user));
  res.json({ ok: true, user: { username: user.username, role: user.role } });
});

// Sign in with Google (OIDC), restricted to the allowed Workspace domain(s).
app.get('/auth/google/login', (req, res) => {
  if (!googleAuth.googleAuthEnabled()) return res.redirect('/login?error=' + encodeURIComponent('Google sign-in is not configured.'));
  res.redirect(googleAuth.authUrl(req));
});
app.get('/auth/google/callback', async (req, res) => {
  if (!googleAuth.googleAuthEnabled()) return res.redirect('/login');
  try {
    const user = await googleAuth.handleCallback(req, req.query.code, req.query.state);
    auth.setSessionCookie(req, res, auth.createSession(user));
    res.redirect('/');
  } catch (e) {
    res.redirect('/login?error=' + encodeURIComponent(scrubError(String((e && e.message) || e))));
  }
});

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

// ===========================================================================
// AUTH GATE — everything below requires a valid session
// ===========================================================================
app.use((req, res, next) => {
  const s = auth.getSession(req);
  if (s) { req.user = { username: s.username, role: s.role }; return next(); }
  // Local workstation / Antigravity Sidecar auto-auth for Tarun (never active on Cloud Run K_SERVICE)
  // SECURITY: the Host header and X-Forwarded-For are client-controlled, so neither
  // may grant access on its own. Auto-auth now requires the TCP peer to really be
  // loopback AND (outside the Antigravity sidecar) a loopback Host header with no
  // proxy forwarding headers. This blocks LAN clients spoofing `Host: localhost`,
  // DNS-rebinding pages (Host = attacker domain) and local tunnels/reverse proxies
  // (which connect from 127.0.0.1 on behalf of remote users).
  const isLoopback = !process.env.K_SERVICE && isLocalAutoAuthRequest(req);
  if (isLoopback && process.env.LOCAL_AUTO_AUTH !== '0') {
    req.user = { username: 'ubhi@google.com', role: 'admin', name: 'Tarun Ubhi' };
    return next();
  }
  // pygbag fetches a game's bundle assets (.tar.gz / .apk / preloader files) with
  // credentials:'omit' — no session cookie — so a gated /games/* would redirect
  // them to /login and the game receives the login HTML instead of the archive
  // ("BadGzipFile: not a gzip file (b'<!')"). Serve game assets unauthenticated:
  // ids are unguessable sha256 prefixes and the content is generated game code.
  if (req.path.startsWith('/games/')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required.' });
  return res.redirect('/login');
});

// Authenticated routes may carry large attachment payloads (see note above).
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '50mb' }));
app.use(jsonBodyError);

function isLoopbackAddr(a) {
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// True only for a request that genuinely originates on this machine (see auth gate).
function isLocalAutoAuthRequest(req) {
  const peer = req.socket && req.socket.remoteAddress;   // real TCP peer — never req.ip (XFF)
  if (!isLoopbackAddr(peer)) return false;
  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) return true; // sidecar proxy: keep prior behaviour
  if (req.headers['x-forwarded-for'] || req.headers.forwarded) return false; // proxied/tunnelled
  const extra = String(process.env.LOCAL_AUTO_AUTH_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
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

app.post('/api/auth/password', async (req, res) => {
  try {
    await auth.changePassword(
      req.user.username,
      String((req.body && req.body.currentPassword) || ''),
      String((req.body && req.body.newPassword) || ''),
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

// ---------- user administration (admin only) ----------
app.get('/api/auth/users', requireAdmin, (req, res) => {
  res.json({ users: auth.listUsers(), me: req.user.username });
});

app.post('/api/auth/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  try {
    await auth.createUser(username, String(password || ''), role === 'admin' ? 'admin' : 'user');
    res.json({ ok: true, users: auth.listUsers() });
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

app.delete('/api/auth/users/:username', requireAdmin, (req, res) => {
  try {
    auth.deleteUser(req.params.username, req.user.username);
    res.json({ ok: true, users: auth.listUsers() });
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

// ---------- fast in-memory static asset cache + gzip compression ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
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
    const st = fs.statSync(fp);
    const prev = staticMemCache.get(fileRel);
    if (prev && prev.mtimeMs === st.mtimeMs) return prev;
    const raw = fs.readFileSync(fp);
    const gz = zlib.gzipSync(raw, { level: 6 });
    const entry = { mtimeMs: st.mtimeMs, raw, gz };
    staticMemCache.set(fileRel, entry);
    return entry;
  } catch (_) {
    return null;
  }
}
// Warm static asset cache on boot
Object.values(STATIC_ASSET_MIMES).forEach((m) => getCachedStaticAsset(m.file));

// Automatically gzip JSON responses > 1 KB when the client accepts gzip
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function gzipJson(body) {
    const ae = String(req.headers['accept-encoding'] || '');
    if (!/\bgzip\b/i.test(ae) || res.headersSent) return origJson(body);
    try {
      const str = JSON.stringify(body);
      if (!str || str.length < 1024) return origJson(body);
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
  const hasVersionQuery = Boolean(req.query && req.query.v && (req.path === '/app.js' || req.path === '/styles.css' || req.path === '/theme-init.js'));
  res.setHeader('Content-Type', hit.type);
  res.setHeader('Cache-Control', hasVersionQuery
    ? 'private, max-age=3600'
    : 'no-store, no-cache, must-revalidate');
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

app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); },
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
    models: DEFAULT_MODELS,
    catalog: CATALOG_CONFIG,
    tasks: TASKS.map((t) => ({
      id: t.id,
      title: t.title,
      prompt: t.prompt,
      functionName: t.functionName,
      testCount: t.testCases.length,
      category: t.category || (t.testCases.length ? 'coding' : 'general'),
      language: t.language || null,
      executable: !!t.executable && (codeExecOn || (!!t.gui && webGameOn)),
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
    gcpProject: process.env.GCP_PROJECT_ID || '',
    allowedDomains: googleAuth.allowedDomains(),
    maxRunsPerDay: auth.MAX_RUNS_PER_DAY,
    maxSingleRunsPerDay: auth.MAX_SINGLE_RUNS_PER_DAY,
    me: {
      username: req.user.username,
      role: req.user.role,
      quota: auth.runQuota(req.user, 'compare'),
      singleQuota: auth.runQuota(req.user, 'single'),
      lastModels: history.lastModels(req.user.username),
      preferences: {
        taskId: prefs.taskId || 'custom',
        slots: prefs.slots || null,
        models: prefs.models || null,
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
  const out = history.deleteUserPrompt(req.user.username, req.params.id);
  if (!out.removed) return res.status(404).json({ ok: false, error: 'Saved prompt not found.' });
  res.json({ ok: true, removed: true, savedPrompts: out.savedPrompts });
});

// List the authenticated user's attachment records from the SQLite `user_vault_files` table.
app.get('/api/me/vault', (req, res) => {
  res.json({ ok: true, files: history.vault.listUserVaultFiles(req.user.username) });
});

// Serve a raw binary file directly from the authenticated user's personal vault
// (/data/vault/<userKey>/<sha256>.bin) for image previews and downloads.
// Strictly scoped to req.user.username so users can never access another user's vault.
app.get('/api/me/vault/:sha256', (req, res) => {
  const entry = history.vault.getVaultRawBinarySync(req.user.username, req.params.sha256);
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
  if (req.query.scope === 'all') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    return res.json({ scope: 'all', runs: history.listAllRuns() });
  }
  res.json({ scope: 'me', runs: history.listRuns(req.user.username) });
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
    const pdfBuf = buildComparisonPdf({
      ...rec,
      task: foundTask || null,
      taskTitle: rec.title || (foundTask && foundTask.title) || 'Comparison Report',
      prompt: rec.prompt || (foundTask && foundTask.prompt) || '',
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

app.post('/api/export-pdf', (req, res) => {
  const body = req.body || {};
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
    const pdfBuf = buildComparisonPdf({
      taskId: body.taskId || (foundTask && foundTask.id) || 'custom',
      taskTitle: title,
      prompt,
      task: foundTask || null,
      models: Array.isArray(body.models) ? body.models : [],
      results: body.results,
      slots: body.slots,
      judge: body.judge || (savedRec && savedRec.judge) || null,
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

// Admin at-a-glance usage: who's active, runs today, totals.
app.get('/api/usage', requireAdmin, (req, res) => {
  res.json(history.usageSummary());
});

// ---------- global (shared) provider keys — admin only ----------
// These are the credentials every user runs on when they haven't brought their
// own. Stored as Secret Manager versions (see src/globalKeys.js); the VALUES are
// never returned here — only presence and a masked tail.
app.get('/api/global-keys', requireAdmin, (req, res) => {
  res.json({ keys: globalKeys.status(), enabled: globalKeys.enabled() });
});

app.put('/api/global-keys', requireAdmin, async (req, res) => {
  const { name, value } = req.body || {};
  try {
    const keys = await globalKeys.set(String(name || ''), String(value || ''));
    // Audit trail: a shared key change affects every user's runs and spend.
    console.log(`[globalKeys] ${req.user.username} updated ${name}`);
    res.json({ ok: true, keys });
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

// Execute an LLM-generated solution: python -> run the program; javascript ->
// run the function against the task's hidden tests. taskId supplies the tests.
app.post('/api/execute', async (req, res) => {
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
});

// Score a finished run's outputs with an LLM judge. Only meaningful for the
// ungraded (business / general) tasks, which have no hidden tests and therefore
// no quality signal of their own. Blinding and shuffling happen in src/judge.js.
app.post('/api/judge', async (req, res) => {
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
    .map((e) => ({ slot: String(e.slot || '').slice(0, 4), label: String(e.label || '').slice(0, 80), text: e.text.slice(0, 1000000) }));
  if (clean.length < 2) return res.status(400).json({ error: 'Need at least two model outputs to compare.' });

  const rawKeys = (req.body && req.body.keys) || {};
  const keys = {};
  for (const k of ['agentplatform', 'gemini', 'openai', 'anthropic', 'claudeBearerToken', 'gcpProject']) {
    if (typeof rawKeys[k] === 'string' && rawKeys[k].trim()) keys[k] = rawKeys[k].trim();
  }

  // Only external/OpenAI judge models on the shared personal key consume the 3/day OpenAI quota.
  // Gemini and Claude on Vertex AI (agentplatform) are org-sponsored and run without this cap.
  if (judge.provider !== 'agentplatform' && !modelUsesOwnKey(judge, keys)) {
    const quota = auth.consumeRun(req.user, 'single');
    if (!quota.ok) return res.status(429).json({ error: `Daily OpenAI limit reached (${quota.limit}/day). Switch the Judge model to Gemini or Claude (Vertex AI) to score without a limit.` });
  }

  try {
    const verdict = await judgeOutputs({ task, entries: clean, judge, keys });
    await history.attachJudgeToLatestRun(req.user.username, task.id, verdict, req.body && req.body.runId);
    console.log(`[judge] ${req.user.username} scored ${clean.length} outputs on "${task.id}" with ${judge.model}`);
    res.json({ ok: true, ...verdict });
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

// Build an LLM-generated Pygame program into a browser-runnable WASM bundle so a
// GUI task renders in the user's browser (works for remote clients). Returns a URL
// under /games/<id>/ that the client embeds in an <iframe>.
app.post('/api/web-game', async (req, res) => {
  if (!webGameEnabled()) return res.status(400).json({ error: 'Web game building is disabled (ENABLE_WEB_GAME=0).' });
  const code = String((req.body && req.body.code) || '');
  if (!code.trim()) return res.status(400).json({ error: 'No code provided.' });
  try {
    const { id, cached } = await buildWebGame(code);
    res.json({ ok: true, id, cached, url: `/games/${id}/` });
  } catch (e) {
    res.status(400).json({ error: scrubError(String((e && e.message) || e)) });
  }
});

// Serve a built game bundle. The pygbag loader needs a permissive CSP (inline +
// eval + wasm + its CDN) and must be framable by our own origin — so we override
// the strict global CSP / X-Frame-Options for just this route.
app.get('/games/:id/*', (req, res) => {
  const dir = gameDir(req.params.id);
  if (!dir) return res.status(404).send('Game not found — rebuild it from the app.');
  const rel = req.params[0] && req.params[0] !== '' ? req.params[0] : 'index.html';
  const fp = path.normalize(path.join(dir, rel));
  if (fp !== dir && !fp.startsWith(dir + path.sep)) return res.status(400).end(); // no path traversal
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Cross-origin isolation for the game document itself. Verified: with these
  // headers the Tetris bundle runs and the page stays responsive; without them
  // the identical bundle hard-freezes the renderer.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
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
  ].join('; '));
  res.sendFile(fp);
});
app.get('/games/:id', (req, res) => res.redirect(301, `/games/${req.params.id}/`)); // bare id -> trailing slash

// Does this model run on a user-supplied credential (vs. the server's)? Used to
// decide whether a run counts against the per-user daily quota.
function modelUsesOwnKey(m, keys) {
  const prov = m && m.provider;
  if (prov === 'agentplatform') {
    return (m.publisher || 'google') === 'anthropic' ? !!keys.claudeBearerToken : !!(keys.agentplatform || keys.gemini);
  }
  if (prov === 'gemini') return !!keys.gemini;
  if (prov === 'openai') return !!keys.openai;
  if (prov === 'anthropic') return !!keys.anthropic;
  if (prov === 'moonshot') return !!keys.moonshot;
  return false;
}

// Lightweight attachment inspection & server-side SHA-1 LRU + per-user binary vault caching endpoint.
// Called immediately when the user drops/picks files so the UI shows exact server-extracted
// token counts, PDF page/encryption metadata, and stores the raw file in the user's vault.
app.post('/api/attachments/inspect', async (req, res) => {
  try {
    const rawAttachments = (req.body && req.body.attachments) || [];
    const items = await inspectAttachmentsAsync(rawAttachments, { username: req.user && req.user.username });
    res.json({ ok: true, attachments: items });
  } catch (e) {
    const status = e && e.code === 'ATTACHMENT_EXPIRED' ? 409 : 400;
    res.status(status).json({ ok: false, error: scrubError(e.message || String(e)), code: e && e.code, expired: e && e.expired });
  }
});

// Multipart alternative to the base64-JSON inspect endpoint (same response
// shape, same caching). Avoids the ~33% base64 overhead for large files:
//   curl -F files=@report.pdf -F files=@data.xlsx https://…/api/attachments/upload
// Optional Claude copy of an oversized image (same filename as the original):
//   curl -F files=@photo.png -F "claude_scaled=@small.webp;filename=photo.png;type=image/webp" …
// Authenticated (mounted after the auth gate); body capped by MULTIPART_LIMIT.
app.post('/api/attachments/upload',
  express.raw({ type: 'multipart/form-data', limit: process.env.MULTIPART_LIMIT || process.env.JSON_BODY_LIMIT || '50mb' }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, error: 'Expected a multipart/form-data body with one or more files.' });
      // Up to MAX_ATTACHMENTS originals, each optionally followed by a part named
      // "claude_scaled" with the SAME filename: a downscaled copy used only for
      // Claude when the original image exceeds Anthropic's 5 MB cap (validated in
      // attachments.js exactly like the JSON path's claudeDataBase64/claudeMimeType).
      // A part named "fit_scaled" (same filename) is the OpenAI patch-budget copy.
      const { files } = parseMultipart(req.body, req.headers['content-type'], { maxFiles: MAX_ATTACHMENTS * 3 });
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
  },
  (err, _req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ ok: false, error: 'Upload exceeds the server request limit.' });
    return next(err);
  });

app.post('/api/run', async (req, res) => {
  const { taskId, models, maxIterations, customPrompt, attachments: rawAttachments } = req.body || {};
  // Resolved BEFORE any quota is consumed, so a 409 (expired cache → client
  // re-uploads and retries) never costs the user a run.
  const attachments = await attachmentsOr409(req, res, rawAttachments, { type: 'error' });
  if (!attachments) return;
  // Sanitize any user-provided ("bring your own") API credentials (strings only).
  const rawKeys = (req.body && req.body.keys) || {};
  const keys = {};
  for (const k of ['agentplatform', 'gemini', 'openai', 'anthropic', 'claudeBearerToken', 'gcpProject']) {
    if (typeof rawKeys[k] === 'string' && rawKeys[k].trim()) keys[k] = rawKeys[k].trim();
  }
  let task;
  const isCustomOrSaved = taskId === 'custom' || taskId === '__custom__' || String(taskId || '').startsWith('saved:');
  if (isCustomOrSaved) {
    const defaultCustomPrompt = attachments.length
      ? 'Analyze the attached file(s) and provide a detailed response.'
      : 'Write a short response.';
    const explicitTitle = (req.body && typeof req.body.taskTitle === 'string' && req.body.taskTitle.trim())
      ? req.body.taskTitle.trim().slice(0, 120)
      : '';
    const defaultTitle = attachments.length
      ? `Custom prompt (${attachments.length} attachment${attachments.length > 1 ? 's' : ''})`
      : 'Custom prompt';
    task = {
      id: 'custom',
      title: explicitTitle || defaultTitle,
      prompt: (customPrompt || '').trim() || defaultCustomPrompt,
      functionName: 'solution',
      testCases: [], // no hidden tests -> single generation, no self-debug loop
      attachments,
    };
  } else {
    const baseTask = TASKS.find((t) => t.id === taskId) || TASKS[0];
    task = attachments.length ? { ...baseTask, attachments } : baseTask;
  }
  // Server-authoritative: rebuild every slot from the fixed catalog. Any
  // client-supplied price / model id / provider is ignored — users can only
  // add/remove catalog models, never modify their settings.
  const chosenModels = resolveModels(models);

  // Per-user daily OpenAI guardrail: ONLY runs that include an OpenAI (or external non-Vertex)
  // model on the server's shared personal key consume the 3/day allowance.
  // Gemini & Claude run on org-sponsored Vertex AI (agentplatform) and remain available all day.
  const usesSharedExternalKey = chosenModels.some((m) => m.provider !== 'agentplatform' && !modelUsesOwnKey(m, keys));
  // Two daily budgets. A re-run of ONE model draws on the smaller 'single' bucket
  // so retrying a slot can't burn the full-comparison allowance. The client asks
  // for 'single', but we only honour it when exactly one model is actually being
  // run — otherwise a crafted request could get a full comparison out of the
  // cheaper bucket.
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
  let quotaInfo = auth.runQuota(req.user, kind); // surfaced to the client so it can show the live OpenAI counter
  if (usesSharedExternalKey) {
    const quota = auth.consumeRun(req.user, kind);
    if (!quota.ok) {
      const what = kind === 'single' ? 'single-model OpenAI re-runs' : 'OpenAI comparison runs';
      return res.status(429).json({
        type: 'error',
        openaiQuotaExhausted: true,
        error: `Daily OpenAI limit reached — you've used all ${quota.limit} ${what} for today (shared OpenAI key). Gemini & Claude run on org-sponsored Vertex AI with no 3-run limit! Swap the OpenAI slot to a Gemini or Claude model (or add your own OpenAI key in Settings) to keep running.`,
        quota,
      });
    }
    quotaInfo = quota;
  }
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

  emit({ type: 'quota', quota: quotaInfo }); // let the UI update the "runs left today" counter

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

  // NOTE: this must be res 'close', NOT req 'close'. The request stream closes as
  // soon as its body has been read, which is long before the run ends — listening
  // there aborts every run the instant it starts. res 'close' fires either when
  // the response completes (guarded by `finished`) or when the peer really goes away.
  res.on('close', () => {
    clearInterval(heartbeatTimer);
    if (finished || res.writableFinished) return;
    aborted = true;
    ac.abort();
    if (usesSharedExternalKey) auth.refundRun(req.user, kind);
    console.log(`[run] ${req.user.username} abandoned a ${kind} run — upstream aborted, quota refunded`);
  });

  const runId = history.newId();
  let results = null;
  try {
    results = await runComparison({ task, models: chosenModels, maxIterations: iters, emit, keys, signal: ac.signal, repair, runId });
  } catch (e) {
    if (!aborted) emit({ type: 'error', message: scrubError(String((e && e.message) || e)) });
  } finally {
    clearInterval(heartbeatTimer);
  }
  finished = true;
  if (aborted) return res.end();   // nothing to log: the client threw this run away
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
    }).catch(() => {});
  }
  res.end();
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

// ---------------------------------------------------------------------------
// Graceful shutdown. Cloud Run sends SIGTERM and allows ~10 s before SIGKILL.
// Stop accepting new connections, flip /healthz to 503, let in-flight requests
// (including streaming NDJSON runs) finish for up to SHUTDOWN_DRAIN_MS, then
// exit. A second signal exits immediately.
// ---------------------------------------------------------------------------
let extraServer = null;
const DRAIN_MS = Math.max(0, Number(process.env.SHUTDOWN_DRAIN_MS) || 9000);
function shutdown(signal) {
  if (draining) { process.exit(0); }
  draining = true;
  log.event('INFO', `[shutdown] ${signal} received — draining for up to ${DRAIN_MS}ms`, { signal, drainMs: DRAIN_MS });
  const flushPromise = (typeof history.flushSnapshotAsync === 'function')
    ? history.flushSnapshotAsync().catch(() => {})
    : Promise.resolve();
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
    flushPromise.finally(() => {
      log.event('WARNING', '[shutdown] drain timeout — exiting with requests still open');
      process.exit(0);
    });
  }, DRAIN_MS).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
