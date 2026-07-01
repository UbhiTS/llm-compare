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
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

const { runComparison } = require('./src/orchestrator');
const { DEFAULT_MODELS, MODEL_CATALOG, resolveModels } = require('./src/pricing');
const { TASKS } = require('./src/tasks');
const { autoMintEnabled } = require('./src/gcloudToken');
const { runCode, executionEnabled } = require('./src/codeRunner');
const { buildWebGame, gameDir, webGameEnabled } = require('./src/webGame');
const history = require('./src/history');
const auth = require('./src/auth');
const googleAuth = require('./src/googleAuth');

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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // HSTS only over HTTPS (harmless/ignored on plain HTTP; req.secure honors trust proxy).
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    // allow the CDN script origins so DevTools can fetch their source maps
    // (*.min.js.map) — without this, connect-src 'self' logs a blocked-request error.
    "connect-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '));
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(auth.cookieParser);

// ===========================================================================
// PUBLIC routes (no authentication required)
// ===========================================================================

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
    res.status(400).json({ error: String((e && e.message) || e) });
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
    res.redirect('/login?error=' + encodeURIComponent(String((e && e.message) || e)));
  }
});

// ===========================================================================
// AUTH GATE — everything below requires a valid session
// ===========================================================================
app.use((req, res, next) => {
  const s = auth.getSession(req);
  if (s) { req.user = { username: s.username, role: s.role }; return next(); }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required.' });
  return res.redirect('/login');
});

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
    res.status(400).json({ error: String((e && e.message) || e) });
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
    res.status(400).json({ error: String((e && e.message) || e) });
  }
});

app.delete('/api/auth/users/:username', requireAdmin, (req, res) => {
  try {
    auth.deleteUser(req.params.username, req.user.username);
    res.json({ ok: true, users: auth.listUsers() });
  } catch (e) {
    res.status(400).json({ error: String((e && e.message) || e) });
  }
});

// ---------- static UI (authenticated) ----------
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, fp) => { if (fp.endsWith('login.html')) res.setHeader('Cache-Control', 'no-store'); },
}));

// ===========================================================================
// APPLICATION API (authenticated)
// ===========================================================================
app.get('/api/config', (req, res) => {
  res.json({
    models: DEFAULT_MODELS,
    catalog: MODEL_CATALOG, // the fixed set of models a user may add/remove (settings locked)
    tasks: TASKS.map((t) => ({
      id: t.id,
      title: t.title,
      prompt: t.prompt,
      functionName: t.functionName,
      testCount: t.testCases.length,
      category: t.category || (t.testCases.length ? 'coding' : 'general'),
      language: t.language || null,
      executable: !!t.executable && executionEnabled(),
      visualizer: t.visualizer || null,
      gui: !!t.gui,
    })),
    keysPresent: {
      agentplatform: !!(process.env.AGENT_PLATFORM_API_KEY || process.env.GEMINI_API_KEY),
      claude: autoMintEnabled() || !!process.env.CLAUDE_BEARER_TOKEN,
      gemini: !!process.env.GEMINI_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
    },
    codeExec: executionEnabled(),
    webGame: webGameEnabled(),
    maxRunsPerDay: auth.MAX_RUNS_PER_DAY,
    me: { username: req.user.username, role: req.user.role, quota: auth.runQuota(req.user) },
  });
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

app.delete('/api/history/:id', (req, res) => {
  const ok = history.deleteRun(req.params.id, { username: req.user.username, isAdmin: req.user.role === 'admin' });
  if (!ok) return res.status(404).json({ error: 'Run not found or not yours to delete.' });
  res.json({ ok: true });
});

// Admin at-a-glance usage: who's active, runs today, totals.
app.get('/api/usage', requireAdmin, (req, res) => {
  res.json(history.usageSummary());
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
    res.status(400).json({ error: String((e && e.message) || e) });
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
    res.status(400).json({ error: String((e && e.message) || e) });
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
  return false;
}

app.post('/api/run', async (req, res) => {
  const { taskId, models, maxIterations, customPrompt } = req.body || {};
  // Sanitize any user-provided ("bring your own") API credentials (strings only).
  const rawKeys = (req.body && req.body.keys) || {};
  const keys = {};
  for (const k of ['agentplatform', 'gemini', 'openai', 'anthropic', 'claudeBearerToken', 'gcpProject']) {
    if (typeof rawKeys[k] === 'string' && rawKeys[k].trim()) keys[k] = rawKeys[k].trim();
  }
  let task;
  if (taskId === 'custom') {
    task = {
      id: 'custom',
      title: 'Custom prompt',
      prompt: (customPrompt || '').trim() || 'Write a short response.',
      functionName: 'solution',
      testCases: [], // no hidden tests -> single generation, no self-debug loop
    };
  } else {
    task = TASKS.find((t) => t.id === taskId) || TASKS[0];
  }
  // Server-authoritative: rebuild every slot from the fixed catalog. Any
  // client-supplied price / model id / provider is ignored — users can only
  // add/remove catalog models, never modify their settings.
  const chosenModels = resolveModels(models);

  // Per-user daily abuse guardrail — but ONLY when the run uses the SERVER's keys.
  // If the user brought their own credentials for every model, they're on their own
  // quota, so we don't throttle (configurable via MAX_RUNS_PER_DAY; admins exempt).
  const usingOwnKeys = chosenModels.length > 0 && chosenModels.every((m) => modelUsesOwnKey(m, keys));
  let quotaInfo = { limited: false }; // surfaced to the client so it can show the live counter
  if (!usingOwnKeys) {
    const quota = auth.consumeRun(req.user);
    if (!quota.ok) {
      return res.status(429).json({
        type: 'error',
        error: `Daily limit reached — you've used all ${quota.limit} comparison runs for today. Resets at ${quota.resetAt}. Add your own API keys to run without this limit.`,
        quota,
      });
    }
    quotaInfo = quota;
  }
  const iters = Math.max(1, Math.min(8, Number(maxIterations) || 4));

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

  let results = null;
  try {
    results = await runComparison({ task, models: chosenModels, maxIterations: iters, emit, keys });
  } catch (e) {
    emit({ type: 'error', message: String((e && e.message) || e) });
  }
  // Log this run to the durable per-user history. FIRE-AND-FORGET: saveRun is
  // async and never throws, so this never blocks res.end() or the event loop on
  // a slow gcsfuse write (which would otherwise stall other users on this single
  // instance). The server is the source of truth (the browser never writes
  // history), so a user cannot forge or tamper with the log.
  if (Array.isArray(results)) {
    history.saveRun({ user: req.user.username, userName: req.user.username, task, models: chosenModels, results }).catch(() => {});
  }
  res.end();
});

// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
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

app.listen(PORT, HOST, () => {
  console.log(`\n  LLM Agent Arena`);
  console.log(`  this computer   ->  http://localhost:${PORT}`);
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

  // Loud warning if reachable off-box without an explicit Secure-cookie/TLS posture.
  const nonLoopback = HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1';
  if (nonLoopback && process.env.COOKIE_SECURE !== '1') {
    console.log('\n  ⚠  SECURITY: reachable off this machine without COOKIE_SECURE=1.');
    console.log('     If you serve this over plain HTTP, login credentials and the session');
    console.log('     cookie travel UNENCRYPTED and can be sniffed. For internet exposure put');
    console.log('     it behind HTTPS (reverse proxy / tunnel) — the cookie auto-upgrades to');
    console.log('     Secure over HTTPS. Behind a TLS proxy also set TRUST_PROXY=1.');
  }

  // First-run: print the one-time setup code needed to create the admin account.
  const code = auth.ensureSetupCode();
  if (code) {
    const bar = '═'.repeat(46);
    console.log(`\n  ${bar}`);
    console.log('   FIRST-RUN SETUP — no account exists yet.');
    console.log(`   Open the site, then enter this setup code to`);
    console.log(`   create the "admin" password:`);
    console.log(`\n        SETUP CODE:   ${code}\n`);
    console.log('   (Keep this terminal private — anyone with this code');
    console.log('    can create the first admin.)');
    console.log(`  ${bar}`);
  }
  console.log('');
});
