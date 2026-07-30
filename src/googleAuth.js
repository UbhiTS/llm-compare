// ---------------------------------------------------------------------------
// googleAuth.js — "Sign in with Google" (OAuth 2.0 / OIDC), restricted to your
// Google Workspace domain(s). Lets any user in your org log in with one click —
// no per-user passwords. Their verified email becomes their identity (used for
// the per-user daily run limit). Dependency-free (Node's global fetch + crypto).
//
// Config (all env, all optional — feature is OFF unless CLIENT_ID+SECRET are set):
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   OAuth 2.0 Web client credentials
//   ALLOWED_EMAIL_DOMAINS   comma list, e.g. "example.com" (only these can log in)
//   ADMIN_EMAILS            comma list of emails granted the admin role
//   OAUTH_REDIRECT_BASE     public base URL, e.g. https://your-app.example.com
//                           (else derived from the request; must match the URI
//                            registered on the OAuth client)
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

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

// CSRF state store (in-memory, short-lived).
const states = new Map(); // state -> createdAt
function newState() {
  const s = crypto.randomBytes(16).toString('hex');
  states.set(s, Date.now());
  if (states.size > 5000) { const cut = Date.now() - 10 * 60 * 1000; for (const [k, t] of states) if (t < cut) states.delete(k); }
  return s;
}
function consumeState(s) {
  const t = states.get(s);
  if (t === undefined) return false;
  states.delete(s);
  return Date.now() - t < 10 * 60 * 1000;
}

function authUrl(req) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state: newState(),
    access_type: 'online',
    prompt: 'select_account',
  });
  if (ALLOWED_DOMAINS.length === 1) params.set('hd', ALLOWED_DOMAINS[0]); // account-picker hint (NOT a security control)
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function decodeJwtPayload(jwt) {
  const part = String(jwt).split('.')[1] || '';
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

// Handle the OAuth callback. Returns a user object {username(email), role, external, name}
// or throws with a user-facing message. The id_token is trusted because it is received
// directly from Google's token endpoint over TLS in exchange for our client_secret
// (OIDC 3.1.3.7), so we validate its claims rather than re-verifying the signature.
async function handleCallback(req, code, state) {
  if (!code) throw new Error('Google sign-in was cancelled or failed.');
  if (!consumeState(state)) throw new Error('Your sign-in link expired. Please try again.');

  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code',
  });
  const r = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.id_token) throw new Error('Google token exchange failed.');

  let claims;
  try { claims = decodeJwtPayload(tok.id_token); } catch (e) { throw new Error('Could not read the Google identity token.'); }

  const iss = claims.iss;
  if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') throw new Error('Unexpected token issuer.');
  if (claims.aud !== CLIENT_ID) throw new Error('Token was not issued for this app.');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('The sign-in token has expired. Please try again.');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('Your Google email address is not verified.');

  const email = String(claims.email || '').trim().toLowerCase();
  const domain = email.split('@')[1] || '';
  const hd = String(claims.hd || '').trim().toLowerCase();
  const domainOk = ALLOWED_DOMAINS.includes(domain) || (hd && ALLOWED_DOMAINS.includes(hd));
  if (ALLOWED_DOMAINS.length && !domainOk) {
    throw new Error(`Access is restricted to ${ALLOWED_DOMAINS.join(', ')}. The account ${email} is not permitted.`);
  }

  return {
    username: email,
    role: ADMIN_EMAILS.has(email) ? 'admin' : 'user',
    external: true,
    name: claims.name || email,
  };
}

module.exports = { googleAuthEnabled, allowedDomains, authUrl, handleCallback };
