// ---------------------------------------------------------------------------
// Preload for smoke-secrets.js:  node -r ./test/fixtures/mock-upstream.js server.js
// Replaces upstream provider calls with HOSTILE failure modes that try to leak
// credentials back through error paths:
//   * echoes the received API key / bearer token / full URL in error bodies
//   * throws undici-style network errors whose message AND cause contain the
//     URL and request headers
//   * hangs until aborted (header timeout)
// Also flags any upstream URL that still carries a key query parameter.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const UPSTREAM = /googleapis\.com|openai\.com|anthropic\.com|moonshot\.ai/;

function hdrs(h) {
  if (!h) return {};
  if (typeof h.entries === 'function') return Object.fromEntries(h.entries());
  return { ...h };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!UPSTREAM.test(u)) return realFetch(url, opts);
  if (/[?&](key|api_key)=/i.test(u)) process.stderr.write('MOCK_VIOLATION upstream URL carries a key query parameter\n');
  if (u.includes('secretmanager.googleapis.com')) return new Response('{"error":{"code":404}}', { status: 404 });
  const h = hdrs(opts.headers);
  const secret = h['x-goog-api-key'] || h.Authorization || h.authorization || h['x-api-key'] || '';
  const echo = `received credential=${secret} url=${u}${u.includes('?') ? '&' : '?'}key=${secret} headers=${JSON.stringify(h)}`;

  // Gemini 3.5 Flash-Lite → network failure with URL + headers in message and cause
  if (u.includes('gemini-3.5-flash-lite')) {
    const cause = new Error(`connect ECONNREFUSED ${u} ${echo}`);
    cause.code = 'ECONNREFUSED';
    throw new TypeError(`fetch failed ${echo}`, { cause });
  }
  // Gemini 3.7 Flash → hang until aborted (header timeout path)
  if (u.includes('gemini-3.7-flash')) {
    return new Promise((_, reject) => {
      if (opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error(`aborted ${echo}`), { name: 'AbortError' })));
    });
  }
  // Any other Gemini → 400 "bad key" that echoes the key and URL
  if (u.includes('publishers/google') || u.includes('generativelanguage')) {
    return new Response(JSON.stringify({ error: { code: 400, message: `API key not valid. ${echo}`, status: 'INVALID_ARGUMENT' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  // Claude on Vertex → 429 echoing the bearer token
  if (u.includes('publishers/anthropic')) {
    return new Response(JSON.stringify({ error: { code: 429, message: `Quota exceeded. ${echo}` } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '0' } });
  }
  // OpenAI / MaaS / others → 401 echoing Authorization
  return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${echo}` } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
};
