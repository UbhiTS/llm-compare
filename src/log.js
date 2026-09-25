// ---------------------------------------------------------------------------
// log.js — structured logging for Cloud Run / Cloud Logging.
//
// When LOG_FORMAT=json, or when running on Cloud Run (K_SERVICE set) and
// LOG_FORMAT isn't "text", every console.log/info/warn/error line is written as
// one JSON object per line with a Cloud Logging `severity`, so logs are
// filterable by level instead of arriving as unstructured text. Locally the
// output is unchanged plain text.
//
// Safety: messages pass through redact() which masks API keys / bearer tokens /
// `key=` query params / passwords. Callers must never log prompts, model
// outputs or attachment contents — only ids, counts and statuses.
// ---------------------------------------------------------------------------
const util = require('util');

const REDACTIONS = [
  [/([?&](?:key|api_key|access_token|token)=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED_KEY]'],
  [/\b(AIza[0-9A-Za-z_-]{20,})/g, '[REDACTED_KEY]'],
  [/\b(ya29\.[0-9A-Za-z._-]{10,})/g, '[REDACTED_TOKEN]'],
  [/("?(?:password|secret|client_secret|apiKey|api_key)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"'],
];

function redact(s) {
  let out = String(s);
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

function jsonMode() {
  const f = String(process.env.LOG_FORMAT || '').toLowerCase();
  if (f === 'json') return true;
  if (f === 'text') return false;
  return !!process.env.K_SERVICE;
}

const orig = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function write(severity, fields, args) {
  const message = redact(util.format(...args)).trim();
  if (!message && !fields) return;
  const entry = { severity, message, ...(fields || {}) };
  const line = JSON.stringify(entry);
  if (severity === 'ERROR' || severity === 'WARNING') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

let installed = false;
function install() {
  if (installed || !jsonMode()) return;
  installed = true;
  console.log = (...a) => write('INFO', null, a);
  console.info = (...a) => write('INFO', null, a);
  console.warn = (...a) => write('WARNING', null, a);
  console.error = (...a) => write('ERROR', null, a);
}

// Structured event with extra (non-sensitive) fields, e.g. log.event('INFO', 'run finished', { slots: 3 }).
function event(severity, message, fields) {
  if (jsonMode()) return write(severity, fields || null, [message]);
  const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
  const fn = severity === 'ERROR' ? orig.error : severity === 'WARNING' ? orig.warn : orig.log;
  fn(redact(message + extra));
}

module.exports = { install, event, redact, jsonMode };
