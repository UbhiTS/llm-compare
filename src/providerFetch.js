// ---------------------------------------------------------------------------
// providerFetch — fetch() for upstream LLM provider calls with a per-provider
// response-header timeout and bounded retries (exponential backoff + full
// jitter). Built-ins only (global fetch / AbortController), no new deps.
//
// Semantics
//   * Timeout covers connect → response HEADERS only. Once headers arrive the
//     timer is cleared, so a long streamed body (SSE reasoning) is never cut off
//     — streaming behaviour is unchanged. Non-streamed calls only return headers
//     when the model is done, so the defaults are deliberately generous.
//   * Retries ONLY on HTTP 429, HTTP 5xx, network errors and our own header
//     timeout. Other 4xx are returned immediately (callers keep their existing
//     same-model 400/403/404 handling). A client abort (the caller's `signal`)
//     is never retried.
//   * Honors a numeric `Retry-After` header (seconds), capped at the max delay.
//   * Always calls `globalThis.fetch` at call time so test fetch-mocks still work.
//
// Env (all optional; <P> = GEMINI | OPENAI | ANTHROPIC | MOONSHOT | OTHER):
//   PROVIDER_TIMEOUT_MS[_<P>]      default 900000 (15 min to first byte)
//   PROVIDER_MAX_RETRIES[_<P>]     default 2 (i.e. up to 3 attempts)
//   PROVIDER_RETRY_BASE_MS[_<P>]   default 1000
//   PROVIDER_RETRY_MAX_MS[_<P>]    default 20000
// ---------------------------------------------------------------------------

const DEFAULTS = { TIMEOUT_MS: 900000, MAX_RETRIES: 2, RETRY_BASE_MS: 1000, RETRY_MAX_MS: 20000 };

function providerOf(url) {
  const u = String(url);
  if (u.includes('/publishers/anthropic/') || u.includes('api.anthropic.com')) return 'ANTHROPIC';
  if (u.includes('api.openai.com')) return 'OPENAI';
  if (u.includes('moonshot')) return 'MOONSHOT';
  if (u.includes('generativelanguage.googleapis.com') || u.includes('aiplatform.googleapis.com')) return 'GEMINI';
  return 'OTHER';
}

function knob(name, provider) {
  const raw = process.env[`PROVIDER_${name}_${provider}`] ?? process.env[`PROVIDER_${name}`];
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULTS[name];
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function backoffMs(attempt, base, max, retryAfterHeader) {
  const ra = Number(retryAfterHeader);
  if (retryAfterHeader != null && Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, max);
  const ceiling = Math.min(max, base * 2 ** attempt);
  return Math.floor(Math.random() * ceiling); // full jitter
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error('aborted'));
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason || new Error('aborted')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

class ProviderTimeoutError extends Error {
  constructor(provider, ms) {
    super(`${provider.toLowerCase()} provider did not respond within ${ms >= 1000 ? Math.round(ms / 1000) + 's' : ms + 'ms'} (PROVIDER_TIMEOUT_MS)`);
    this.name = 'ProviderTimeoutError';
  }
}

async function attempt(url, opts, timeoutMs, provider) {
  const clientSignal = opts && opts.signal;
  const ctrl = new AbortController();
  let timedOut = false;
  const onClientAbort = () => ctrl.abort(clientSignal.reason);
  if (clientSignal) {
    if (clientSignal.aborted) ctrl.abort(clientSignal.reason);
    else clientSignal.addEventListener('abort', onClientAbort, { once: true });
  }
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : null;
  try {
    return await globalThis.fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (timedOut) throw new ProviderTimeoutError(provider, timeoutMs);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    // Keep forwarding client aborts for the body stream; the listener is
    // `once` and tied to this request's lifetime.
  }
}

// undici network errors carry a `cause` (and sometimes the request URL). Re-throw
// a plain error with only a stable code so nothing request-specific can leak.
function sanitizedNetworkError(e, provider) {
  if (e instanceof ProviderTimeoutError) return e;
  const code = (e && e.cause && (e.cause.code || e.cause.name)) || (e && e.code) || (e && e.name) || 'ERROR';
  const err = new Error(`${provider.toLowerCase()} provider network error (${String(code).replace(/[^A-Za-z0-9_]/g, '')})`);
  err.name = 'ProviderNetworkError';
  return err;
}

async function providerFetch(url, opts = {}) {
  const provider = providerOf(url);
  const timeoutMs = knob('TIMEOUT_MS', provider);
  const maxRetries = Math.floor(knob('MAX_RETRIES', provider));
  const base = knob('RETRY_BASE_MS', provider);
  const max = knob('RETRY_MAX_MS', provider);
  const clientSignal = opts.signal;

  for (let i = 0; ; i++) {
    let res;
    try {
      res = await attempt(url, opts, timeoutMs, provider);
    } catch (e) {
      // Caller cancelled → propagate immediately, never retry.
      if (clientSignal && clientSignal.aborted) throw e;
      if (i >= maxRetries) throw sanitizedNetworkError(e, provider);
      await sleep(backoffMs(i, base, max), clientSignal);
      continue;
    }
    if (!isRetryableStatus(res.status) || i >= maxRetries) return res;
    const retryAfter = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
    try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (_) { /* ignore */ }
    await sleep(backoffMs(i, base, max, retryAfter), clientSignal);
  }
}

module.exports = { providerFetch, providerOf, isRetryableStatus, backoffMs, ProviderTimeoutError };
