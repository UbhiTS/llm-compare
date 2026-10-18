// ---------------------------------------------------------------------------
// googleAuth.js — "Sign in with Google" (OAuth 2.0 / OIDC), restricted to your
// Google Workspace domain(s). Lets any user in your org log in with one click —
// no per-user passwords. Their verified email becomes their identity (used for
// the per-user daily run limit). Dependency-free (Node's global fetch + crypto).
//
// Config (all env, all optional — feature is OFF unless CLIENT_ID+SECRET are set):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   OAuth 2.0 Web client credentials
//   ALLOWED_EMAIL_DOMAINS   comma list, e.g. "example.com" (only these can log in)
//   ALLOWED_EMAIL_DOMAINS_STRICT=1  never auto-append ubhi.altostrat.com to that list
//   ADMIN_EMAILS            comma list of emails granted the admin role
//   OAUTH_REDIRECT_BASE     public base URL, e.g. https://your-app.example.com
//                           (else derived from the request; must match the URI
//                            registered on the OAuth client)
// ---------------------------------------------------------------------------

const crypto = require('crypto');
// Internal admins: ADMIN_EMAILS (env, bootstrap, can't be removed in the UI) plus
// the admins added in Settings. Shared with auth.js, which re-checks it per request.
const appSettings = require('./appSettings');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const RAW_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'google.com,ubhi.altostrat.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// If google.com is configured, also permit ubhi.altostrat.com so Argolis admins can sign in.
// That implicit extra domain is a hidden trust on a third-party install (3.10): set
// ALLOWED_EMAIL_DOMAINS_STRICT=1 to make ALLOWED_EMAIL_DOMAINS authoritative (no auto-append).
const STRICT_DOMAINS = process.env.ALLOWED_EMAIL_DOMAINS_STRICT === '1';
const ALLOWED_DOMAINS = !STRICT_DOMAINS && RAW_DOMAINS.includes('google.com') && !RAW_DOMAINS.includes('ubhi.altostrat.com')
  ? [...RAW_DOMAINS, 'ubhi.altostrat.com']
  : RAW_DOMAINS;
if (ALLOWED_DOMAINS.length !== RAW_DOMAINS.length) {
  console.warn('[googleAuth] ubhi.altostrat.com was auto-added to the Google sign-in domains (ALLOWED_EMAIL_DOMAINS_STRICT=1 disables this).');
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

function googleAuthEnabled() { return !!(CLIENT_ID && CLIENT_SECRET); }
function allowedDomains() { return ALLOWED_DOMAINS.slice(); }

// The redirect URI must EXACTLY match one registered on the OAuth client.
function redirectUri(req) {
  const base = process.env.OAUTH_REDIRECT_BASE || process.env.PUBLIC_URL;
  if (base) return base.replace(/\/+$/, '') + '/auth/google/callback';
  const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/auth/google/callback`;
}

// CSRF state store (in-memory, short-lived). Each entry also carries the OIDC nonce that
// must come back inside the ID token. The state is additionally bound to the browser via
// the oauth_state cookie (3.4): a state that merely exists is not enough, it has to be the
// one THIS browser started with, so an attacker can't hand their own callback URL to a
// victim and log the victim into the attacker's account (login CSRF).
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_STATES = 10000;
const STATE_COOKIE = 'oauth_state';
const STATE_COOKIE_PATH = '/auth/google';
const states = new Map(); // state -> { createdAt, nonce }
function newState() {
  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  states.set(state, { createdAt: Date.now(), nonce });
  if (states.size > MAX_STATES) {
    // Unauthenticated hits add entries, so bound the Map: drop expired ones first, then the
    // oldest (Map iterates in insertion order) until we're back under the cap.
    const cut = Date.now() - STATE_TTL_MS;
    for (const [k, v] of states) if (v.createdAt < cut) states.delete(k);
    for (const k of states.keys()) { if (states.size <= MAX_STATES) break; states.delete(k); }
  }
  return { state, nonce };
}
// One-shot: returns the stored { createdAt, nonce } for a live state, else null.
function consumeState(s) {
  if (typeof s !== 'string' || !s) return null;
  const entry = states.get(s);
  if (entry === undefined) return null;
  states.delete(s);
  return Date.now() - entry.createdAt < STATE_TTL_MS ? entry : null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Minimal cookie-header parser (first occurrence wins), so this module never depends on
// auth.js's middleware having run (and never imports auth.js, which imports us).
function parseCookieHeader(req) {
  const out = {};
  const header = req && req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) { try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; } }
  }
  return out;
}

function secureCookie(req) {
  return !!((req && req.secure) || process.env.COOKIE_SECURE === '1');
}
// Append one Set-Cookie value without clobbering others already on the response (and
// without duplicating an earlier value for the same cookie name).
function appendSetCookie(res, cookie) {
  if (!res || typeof res.setHeader !== 'function') return;
  const name = cookie.split('=')[0];
  const prev = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
  const list = (prev == null ? [] : (Array.isArray(prev) ? prev : [prev]))
    .map(String).filter((c) => c.split('=')[0] !== name);
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}
function setStateCookie(req, res, state, nonce) {
  const attrs = [`${STATE_COOKIE}=${state}.${nonce}`, 'HttpOnly', `Path=${STATE_COOKIE_PATH}`, 'SameSite=Lax', `Max-Age=${Math.floor(STATE_TTL_MS / 1000)}`];
  if (secureCookie(req)) attrs.push('Secure');
  appendSetCookie(res, attrs.join('; '));
}
function clearStateCookie(req, res) {
  const attrs = [`${STATE_COOKIE}=`, 'HttpOnly', `Path=${STATE_COOKIE_PATH}`, 'SameSite=Lax', 'Max-Age=0'];
  if (secureCookie(req)) attrs.push('Secure');
  appendSetCookie(res, attrs.join('; '));
}

function buildAuthUrl(req, state, nonce) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    access_type: 'online',
    prompt: 'select_account',
  });
  // Default account-picker hint to the primary domain (e.g. google.com) unless overridden
  const hdHint = process.env.OAUTH_HD_HINT || (ALLOWED_DOMAINS.includes('google.com') ? 'google.com' : ALLOWED_DOMAINS[0] || '');
  if (hdHint) params.set('hd', hdHint); // account-picker hint (enforced cryptographically in handleCallback)
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// Start a sign-in: mints state + nonce, binds them to this browser with the oauth_state
// cookie and returns the Google authorization URL to redirect to.
function startLogin(req, res) {
  const { state, nonce } = newState();
  setStateCookie(req, res, state, nonce);
  return buildAuthUrl(req, state, nonce);
}

// Back-compat: older call sites pass only `req`. Without a response object no cookie can be
// set, and the callback then rejects (the state cookie is required), so pass `res` or use
// startLogin(req, res).
function authUrl(req, res) {
  if (res && typeof res.setHeader === 'function') return startLogin(req, res);
  const { state, nonce } = newState();
  return buildAuthUrl(req, state, nonce);
}

function decodeJwtPayload(jwt) {
  const part = String(jwt).split('.')[1] || '';
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

const RETRY_MSG = 'Your sign-in link expired or was not started from this browser. Please try again.';

// Handle the OAuth callback. Returns a user object {username(email), role, external, name}
// or throws with a user-facing message. The id_token is trusted because it is received
// directly from Google's token endpoint over TLS in exchange for our client_secret
// (OIDC 3.1.3.7), so we validate its claims rather than re-verifying the signature.
// `res` (optional) lets us clear the one-shot state cookie; when it is omitted the old
// 3-argument signature still works, but the cookie is still REQUIRED to be present.
async function handleCallback(req, code, state, res) {
  const cookieVal = parseCookieHeader(req)[STATE_COOKIE];
  if (res) clearStateCookie(req, res); // one-shot either way: a retry starts a fresh login
  if (!code) throw new Error('Google sign-in was cancelled or failed.');

  // 1. The state in the query must be the one this browser's cookie was issued for.
  if (typeof cookieVal !== 'string' || !cookieVal) throw new Error(RETRY_MSG);
  const dot = cookieVal.indexOf('.');
  const cookieState = dot > 0 ? cookieVal.slice(0, dot) : '';
  const cookieNonce = dot > 0 ? cookieVal.slice(dot + 1) : '';
  if (!cookieState || !cookieNonce || !safeEqual(cookieState, state)) throw new Error(RETRY_MSG);
  // 2. ...and still be live server-side, with the nonce we minted for it.
  const entry = consumeState(state);
  if (!entry || !safeEqual(entry.nonce, cookieNonce)) throw new Error(RETRY_MSG);

  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code',
  });
  let r;
  try {
    r = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new Error('Google token exchange failed.');
  }
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.id_token) throw new Error('Google token exchange failed.');

  let claims;
  try { claims = decodeJwtPayload(tok.id_token); } catch (e) { throw new Error('Could not read the Google identity token.'); }

  const iss = claims.iss;
  if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') throw new Error('Unexpected token issuer.');
  if (claims.aud !== CLIENT_ID) throw new Error('Token was not issued for this app.');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('The sign-in token has expired. Please try again.');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('Your Google email address is not verified.');
  // 3. The ID token must carry the nonce of this very login (replay / token-substitution guard).
  if (!safeEqual(claims.nonce, entry.nonce)) throw new Error('Sign-in could not be verified (nonce mismatch). Please try again.');

  const email = String(claims.email || '').trim().toLowerCase();
  const domain = email.split('@')[1] || '';
  const hd = String(claims.hd || '').trim().toLowerCase();
  // Require both Workspace hosted-domain claim (claims.hd) and email domain to match ALLOWED_DOMAINS
  const domainOk = Boolean(hd && domain === hd && ALLOWED_DOMAINS.includes(hd));
  if (ALLOWED_DOMAINS.length && !domainOk) {
    throw new Error(`Access is restricted to ${ALLOWED_DOMAINS.join(', ')}. The account ${email} is not permitted.`);
  }

  return {
    username: email,
    role: appSettings.isAdminEmail(email) ? 'admin' : 'user',
    external: true,
    name: claims.name || email,
  };
}

module.exports = { googleAuthEnabled, allowedDomains, authUrl, startLogin, handleCallback, STATE_COOKIE };
