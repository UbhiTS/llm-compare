// ---------------------------------------------------------------------------
// LLM Agent Arena — frontend
// ---------------------------------------------------------------------------

const PALETTE = ['#5e8bff', '#2fd9a6', '#ff9e6d', '#b388ff', '#ffcb5e', '#22e0ff']; // Aurora accents
const MIN_SLOTS = 1; // keep at least 1 active slot
const MAX_SLOTS = 6; // compare up to 6 models / thinking modes at a time
let CONFIG = null;       // from /api/config
let MODELS = [];         // current editable model configs (the dynamic source of truth)
let radarChart = null;
let wallStartMs = 0;     // client-side wall clock (ticks even while a model is only thinking)
let wallTimer = null;
const wallFinished = new Set();

// Slots are dynamic: derive ids/colors from MODELS rather than a fixed list.
function slotIds() { return MODELS.map((m) => m.slot); }
function nextSlotId() {
  const used = new Set(slotIds());
  for (let i = 0; i < 26; i++) { const c = String.fromCharCode(65 + i); if (!used.has(c)) return c; }
  return 'Z' + MODELS.length;
}
function slotColor(slot) {
  const idx = String(slot).charCodeAt(0) - 65;
  return PALETTE[((idx % PALETTE.length) + PALETTE.length) % PALETTE.length] || '#6ea8fe';
}

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MAGNIFY_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="6.8" cy="6.8" r="4.4"/><line x1="10.1" y1="10.1" x2="14" y2="14"/></svg>';

// ---------- model icons (brand marks used across arena, editor, scorecard) ----------
const ICON_GEMINI = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5c.45 5.4 3.6 8.55 9 9-5.4.45-8.55 3.6-9 9-.45-5.4-3.6-8.55-9-9 5.4-.45 8.55-3.6 9-9Z" fill="url(#ic-gemini)"/></svg>';
const ICON_CLAUDE = (() => {
  let rays = '';
  for (let i = 0; i < 12; i++) rays += `<rect x="11.05" y="2.1" width="1.9" height="6.4" rx=".95" transform="rotate(${i * 30} 12 12)"/>`;
  return `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><g fill="#d97757">${rays}</g></svg>`;
})();
const ICON_GROK = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19L19 4M5.5 5.5h13v13" fill="none" stroke="#f5f5f7" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_META = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 14.5c0-4 2.5-7 5-7 2 0 3.5 2 5.5 5.2 2-3.2 3.5-5.2 5.5-5.2 2.5 0 5 3 5 7 0 2.5-1.5 4-3.3 4-1.6 0-2.9-1.2-4.7-4.2-1.8 3-3.1 4.2-4.7 4.2-1.8 0-3.3-1.5-3.3-4Z" fill="none" stroke="#3b82f6" stroke-width="2.1"/></svg>';
const ICON_DEEPSEEK = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="#38bdf8" stroke-width="2"/><path d="M8 12.5c1.5-2.5 4.5-2.5 6 0s4.5 2.5 6 0" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_QWEN = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><polygon points="12,2.5 20.5,7.5 20.5,16.5 12,21.5 3.5,16.5 3.5,7.5" fill="none" stroke="#a855f7" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="#a855f7"/></svg>';
const ICON_GENERIC = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>';
// Pick a brand mark from a model's publisher / provider / model id / label.
function modelIconSvg(m) {
  const s = (((m && m.providerFamily) || '') + ' ' + ((m && m.publisher) || '') + ' ' + ((m && m.provider) || '') + ' ' + ((m && m.model) || '') + ' ' + ((m && m.label) || '')).toLowerCase();
  if (s.indexOf('anthropic') >= 0 || s.indexOf('claude') >= 0) return ICON_CLAUDE;
  if (s.indexOf('gemini') >= 0 || s.indexOf('google') >= 0) return ICON_GEMINI;
  if (s.indexOf('xai') >= 0 || s.indexOf('grok') >= 0) return ICON_GROK;
  if (s.indexOf('meta') >= 0 || s.indexOf('llama') >= 0) return ICON_META;
  if (s.indexOf('deepseek') >= 0) return ICON_DEEPSEEK;
  if (s.indexOf('qwen') >= 0 || s.indexOf('alibaba') >= 0) return ICON_QWEN;
  return ICON_GENERIC;
}
// A compact, distinct name for tight spaces — drops the family prefix so the two
// Geminis read as "3.5 Flash" / "3.1 Pro" instead of both truncating to "Ge…".
function shortLabel(label) {
  const s = String(label || '');
  return s.replace(/^(Gemini|Claude|Grok|GPT-OSS|GPT|Llama|Mistral|OpenAI|Anthropic|Google|DeepSeek|Qwen3|Qwen|Kimi|GLM)\s+/i, '').trim() || s;
}

// ---------- theme (light / medium / dark) ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('ullm.theme', t); } catch (e) { /* ignore */ }
  document.querySelectorAll('#themeSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.theme === t));
}
function initTheme() {
  let t = 'medium';
  try { t = localStorage.getItem('ullm.theme') || 'medium'; } catch (e) { /* ignore */ }
  applyTheme(t);
  const sw = document.querySelector('#themeSwitch');
  if (sw) sw.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.theme)));
}

// ---------- init ----------
init();
async function init() {
  initTheme();
  const cfgResp = await fetch('/api/config', { credentials: 'same-origin' });
  if (cfgResp.status === 401) { window.location.replace('/login'); return; } // session expired/absent
  CONFIG = await cfgResp.json();
  myQuota = CONFIG.me && CONFIG.me.quota;             // seed the daily-runs counters
  mySingleQuota = CONFIG.me && CONFIG.me.singleQuota;
  initUserMenu(CONFIG.me);
  // Seed the drag-and-drop slots from the server's default selection, then let
  // MODELS be derived from the slots from here on.
  seedSlots();
  syncModelsFromSlots();


  // task select — always default to Custom Prompt at the very top on every load
  const ts = $('#taskSelect');
  const customOg = el('optgroup');
  customOg.label = 'Custom';
  const customOpt = el('option');
  customOpt.value = 'custom';
  customOpt.textContent = 'Custom Prompt';
  customOpt.selected = true;
  customOg.appendChild(customOpt);
  ts.appendChild(customOg);

  const tag = (t) => t.testCount ? `${t.testCount} hidden tests` : (t.language ? `${t.language}` : 'prompt only');
  [['business', 'Business'], ['coding', 'Coding'], ['games', 'Games'], ['general', 'General']].forEach(([cat, label]) => {
    const inCat = CONFIG.tasks.filter((t) => (t.category || 'general') === cat);
    if (!inCat.length) return;
    const og = el('optgroup'); og.label = label;
    inCat.forEach((t) => {
      const o = el('option');
      o.value = t.id;
      o.textContent = `${t.title}  (${tag(t)})`;
      og.appendChild(o);
    });
    ts.appendChild(og);
  });
  ts.value = 'custom';
  ts.addEventListener('change', () => { renderTaskPrompt(); $('#scorecard').classList.add('hidden'); buildArena(); });
  initAttachmentsUI();
  renderTaskPrompt();

  renderModelEditors();
  buildArena();
  updateRunButton();

  $('#runBtn').addEventListener('click', run);
  ['#autoRun', '#autoFix'].forEach((sel) => {
    const b = $(sel);
    if (!b) return;
    b.addEventListener('click', () => {
      const on = !b.classList.contains('is-on');
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  });
  { const mv = $('#metricViewToggle'); if (mv) mv.addEventListener('click', (e) => {
    const b = e.target.closest('.mv-btn');
    if (!b || !_lastScored) return;
    setMetricView(b.dataset.view);
    renderMetricGrid(_lastScored.scored, _lastScored.isCustom);
  }); }
  $('#historyBtn').addEventListener('click', openHistoryModal);
  updateQuotaBadge();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeAuthModal(); } });
}

// ---------- account / user menu ----------
let ME = null;
function initUserMenu(me) {
  ME = me || null;
  const menu = $('#userMenu');
  if (!menu || !ME) return;
  menu.hidden = false;
  $('#userName').textContent = ME.username + (ME.role === 'admin' ? '' : '');
  $('#userAvatar').textContent = (ME.username[0] || '?').toUpperCase();
  $('#userChip').title = ME.username + ' · ' + ME.role;
  $('#manageUsersBtn').hidden = ME.role !== 'admin';
  { const gk = $('#globalKeysBtn'); if (gk) gk.hidden = ME.role !== 'admin'; }

  const chip = $('#userChip');
  const dd = $('#userDropdown');
  const toggle = (open) => { dd.hidden = open === undefined ? !dd.hidden : !open; chip.setAttribute('aria-expanded', String(!dd.hidden)); };
  chip.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) toggle(false); });

  $('#logoutBtn').addEventListener('click', logout);
  $('#changePwBtn').addEventListener('click', () => { toggle(false); openChangePwModal(); });
  $('#manageUsersBtn').addEventListener('click', () => { toggle(false); openUsersModal(); });
  { const gk = $('#globalKeysBtn'); if (gk) gk.addEventListener('click', () => { toggle(false); openGlobalKeysModal(); }); }
  $('#apiKeysBtn').addEventListener('click', () => { toggle(false); openKeysModal(); });
}

// ---------- bring-your-own API keys (stored only in this browser) ----------
function loadKeys() { try { return JSON.parse(localStorage.getItem('ullm.keys') || '{}') || {}; } catch (e) { return {}; } }
function saveKeys(k) { try { localStorage.setItem('ullm.keys', JSON.stringify(k)); } catch (e) { /* ignore */ } }
function hasOwnKeys() { const k = loadKeys(); return !!(k.agentplatform || k.gemini || k.openai || k.anthropic || k.claudeBearerToken || k.moonshot); }

// Which credential each selected model will actually run on. Mirrors
// modelUsesOwnKey() in server.js — the quota is only skipped when EVERY model in
// the run uses the caller's own key, so this is what decides "unlimited".
function keySourceFor(m, k) {
  const pub = m.publisher || 'google';
  if (m.provider === 'agentplatform' && pub === 'anthropic') {
    // Vertex Claude authenticates with the server's service account — no key to bring.
    return k.claudeBearerToken
      ? { group: 'Claude (Vertex)', state: 'own' }
      : { group: 'Claude (Vertex)', state: 'service', present: true };
  }
  if (m.provider === 'agentplatform' || m.provider === 'gemini') {
    const own = !!(k.agentplatform || k.gemini);
    return { group: 'Gemini', state: own ? 'own' : 'shared', present: own || !!(CONFIG.keysPresent || {}).agentplatform };
  }
  if (m.provider === 'openai') {
    const own = !!k.openai;
    return { group: 'OpenAI', state: own ? 'own' : 'shared', present: own || !!(CONFIG.keysPresent || {}).openai };
  }
  if (m.provider === 'moonshot') {
    const own = !!k.moonshot;
    return { group: 'Moonshot', state: own ? 'own' : 'shared', present: own || !!(CONFIG.keysPresent || {}).moonshot };
  }
  if (m.provider === 'anthropic') {
    const own = !!k.anthropic;
    return { group: 'Anthropic', state: own ? 'own' : 'shared', present: own || !!(CONFIG.keysPresent || {}).anthropic };
  }
  return { group: m.provider, state: 'shared', present: true };
}

// True only when every selected model runs on the user's OWN credential — the
// same condition the server uses before skipping the quota.
function allModelsUseOwnKeys() {
  const k = loadKeys();
  const list = (ARENA_MODELS && ARENA_MODELS.length) ? ARENA_MODELS : MODELS;
  return list.length > 0 && list.every((m) => keySourceFor(m, k).state === 'own');
}

// True when at least one selected model uses a non-Vertex external provider
// (e.g. OpenAI / Moonshot / direct Anthropic) on the server's shared personal key.
// Models on Google Vertex AI (Agent Platform: Gemini & Claude) are sponsored by
// the GCP org and do NOT consume or get blocked by the 3/day OpenAI limit.
function usesSharedPersonalKeyModels() {
  const k = loadKeys();
  const list = (MODELS && MODELS.length) ? MODELS : (ARENA_MODELS || []);
  return list.some((m) => m.provider !== 'agentplatform' && keySourceFor(m, k).state !== 'own');
}


// Live "runs left today" state (authoritative value comes from the server on
// /api/config load and on each run's `quota` event).
let myQuota = null;        // daily budget for full comparison runs
let mySingleQuota = null;  // separate daily budget for single-model re-runs

// Badge near Run: your-keys (unlimited), Vertex AI (unlimited), or live 3/day OpenAI counter.
function updateQuotaBadge() {
  const b = $('#quotaBadge'); if (!b) return;
  const limit = (CONFIG && (CONFIG.maxOpenAiRunsPerDay || CONFIG.maxRunsPerDay)) || 3;
  const isAdmin = ME && ME.role === 'admin';
  if (allModelsUseOwnKeys()) {
    b.textContent = 'your keys · no limit';
    b.className = 'quota-badge own';
    b.title = 'Every selected model runs on your own personal key, so this run is not counted against any daily limit.';
    return;
  }
  if (isAdmin) {
    b.textContent = 'admin · no limit';
    b.className = 'quota-badge own';
    b.title = 'Admins are exempt from the daily OpenAI run limit.';
    return;
  }
  const remaining = (myQuota && typeof myQuota.remaining === 'number') ? myQuota.remaining : limit;
  const sLimit = (CONFIG && CONFIG.maxSingleRunsPerDay) || limit;
  const sRemaining = (mySingleQuota && typeof mySingleQuota.remaining === 'number') ? mySingleQuota.remaining : sLimit;
  if (!usesSharedPersonalKeyModels()) {
    b.textContent = `Vertex AI · Unlimited (OpenAI: ${remaining}/${limit} left)`;
    b.className = 'quota-badge own';
    b.title = `Gemini & Claude run on org-sponsored Google Vertex AI (Agent Platform) with UNLIMITED daily runs! Shared OpenAI budget remaining today: ${remaining}/${limit} runs.`;
    return;
  }
  b.textContent = `OpenAI: ${remaining} of ${limit} left today · Vertex: Unlimited`;
  b.className = 'quota-badge ' + (remaining <= 0 ? 'out' : remaining <= 1 ? 'low' : 'shared');
  b.title = `Shared OpenAI runs: ${remaining}/${limit} left today`
    + (sLimit ? ` (${sRemaining}/${sLimit} single-model re-runs left)` : '')
    + ((myQuota && myQuota.resetAt) ? `. Resets at ${new Date(myQuota.resetAt).toLocaleString()}` : '')
    + '. Gemini & Claude on Vertex AI are ALWAYS unlimited — deselect OpenAI or add your own OpenAI API key to run without limits.';
}

function openKeysModal() {
  const body = openAuthModal('Your API keys');
  const k = loadKeys();
  const limit = (CONFIG && (CONFIG.maxOpenAiRunsPerDay || CONFIG.maxRunsPerDay)) || 3;
  body.innerHTML =
    '<div class="key-scope personal">' +
      '<div class="ks-head">🔒 Personal keys — this browser only</div>' +
      '<ul class="ks-facts">' +
        '<li><b>Stored only in this browser</b> (localStorage). They are never written to the server\'s database, disk or logs, and no other user — not even an admin — can see them.</li>' +
        '<li><b>Sent with each of your runs</b> over HTTPS, because the server has to hold the key to call the provider. It is used in memory for that run and then discarded.</li>' +
        '<li>Clearing your browser data — or pressing <b>Clear all</b> below — removes them completely.</li>' +
      '</ul>' +
    '</div>' +
    '<p class="keys-intro"><b>Gemini &amp; Claude (Google Vertex AI) are UNLIMITED</b> for all users (sponsored by the GCP org). ' +
    'Shared <b>OpenAI</b> models are capped at <b>' + limit + ' runs/day</b> to protect personal API key billing — add your own OpenAI key below for unlimited OpenAI runs' +
    ((ME && ME.role === 'admin') ? ' (shared keys are managed under <b>Global API keys</b>).' : '.') + '</p>' +
    '<form class="add-user-form" id="keysForm">' +
      '<div class="auth-field"><label>Gemini / Agent Platform API key</label><input id="k-gem" type="password" autocomplete="off" spellcheck="false" placeholder="used for the Gemini slots" value="' + esc(k.agentplatform || k.gemini || '') + '" /></div>' +
      '<h4 style="margin:18px 0 10px">External models</h4>' +
      '<p class="keys-intro" style="margin-bottom:12px">These are <b>not</b> on Vertex, so they need their own key and the prompt leaves Google infrastructure when you run them.</p>' +
      '<div class="auth-field"><label>OpenAI API key <span class="u-tag">GPT-5.4 / GPT-5.6 Luna</span></label><input id="k-openai" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" value="' + esc(k.openai || '') + '" /></div>' +
      '<div class="auth-field"><label>Moonshot API key <span class="u-tag">Kimi K3</span></label><input id="k-moonshot" type="password" autocomplete="off" spellcheck="false" placeholder="sk-… (platform.moonshot.ai)" value="' + esc(k.moonshot || '') + '" /></div>' +
      '<div class="auth-field"><label>Anthropic API key</label><input id="k-anthropic" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-… (for a direct Anthropic slot)" value="' + esc(k.anthropic || '') + '" /></div>' +
      '<details class="keys-adv"><summary>Advanced — Claude via Google Vertex</summary>' +
        '<div class="auth-field"><label>Claude Vertex bearer token</label><input id="k-claude" type="password" autocomplete="off" spellcheck="false" value="' + esc(k.claudeBearerToken || '') + '" /></div>' +
        '<div class="auth-field"><label>GCP project ID</label><input id="k-proj" type="text" autocomplete="off" spellcheck="false" value="' + esc(k.gcpProject || '') + '" /></div>' +
      '</details>' +
      '<div class="auth-msg" id="keysMsg"></div>' +
      '<div class="keys-actions"><button class="submit-btn" type="submit">Save keys</button><button class="u-del" type="button" id="clearKeysBtn">Clear all</button></div>' +
    '</form>';
  body.querySelector('#keysForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const gem = body.querySelector('#k-gem').value.trim();
    const nk = {};
    if (gem) { nk.agentplatform = gem; nk.gemini = gem; } // covers agentplatform + direct gemini slots
    const set = (id, key) => { const v = body.querySelector(id).value.trim(); if (v) nk[key] = v; };
    set('#k-openai', 'openai'); set('#k-moonshot', 'moonshot'); set('#k-anthropic', 'anthropic');
    set('#k-claude', 'claudeBearerToken'); set('#k-proj', 'gcpProject');
    saveKeys(nk);
    const m = body.querySelector('#keysMsg'); m.className = 'auth-msg ok'; m.textContent = 'Saved to this browser.';
    updateQuotaBadge();
  });
  body.querySelector('#clearKeysBtn').addEventListener('click', () => { saveKeys({}); updateQuotaBadge(); openKeysModal(); });
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* ignore */ }
  window.location.replace('/login');
}

// Minimal modal used by the account/user dialogs (separate from the markdown one).
function ensureAuthModal() {
  let m = $('#authModal');
  if (m) return m;
  m = el('div', 'md-modal hidden'); m.id = 'authModal';
  m.innerHTML =
    '<div class="md-modal-panel auth-panel">' +
      '<div class="md-modal-head"><span class="md-modal-title" id="authModalTitle"></span>' +
        '<button class="md-modal-close" type="button" title="Close (Esc)">✕</button></div>' +
      '<div class="md-modal-body" id="authModalBody"></div>' +
    '</div>';
  document.body.appendChild(m);
  m.addEventListener('click', (e) => { if (e.target === m) closeAuthModal(); });
  m.querySelector('.md-modal-close').addEventListener('click', closeAuthModal);
  return m;
}
function closeAuthModal() { const m = $('#authModal'); if (m) m.classList.add('hidden'); }
function openAuthModal(title, opts) {
  const m = ensureAuthModal();
  $('#authModalTitle').textContent = title;
  const panel = m.querySelector('.auth-panel');
  if (panel) panel.classList.toggle('wide', !!(opts && opts.wide));
  m.classList.remove('hidden');
  return $('#authModalBody');
}

async function openUsersModal() {
  const body = openAuthModal('Manage users');
  body.innerHTML = '<p class="auth-loading">Loading…</p>';
  let data;
  try {
    const r = await fetch('/api/auth/users', { credentials: 'same-origin' });
    if (r.status === 401) { window.location.replace('/login'); return; }
    data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load users.');
  } catch (e) { body.innerHTML = '<p class="auth-err"></p>'; body.querySelector('p').textContent = e.message; return; }
  renderUsersModal(body, data);
}

function renderUsersModal(body, data) {
  const rows = (data.users || []).map((u) => {
    const isMe = u.username === data.me;
    const del = (u.username === data.me)
      ? '<span class="u-tag">you</span>'
      : `<button class="u-del" type="button" data-user="${esc(u.username)}" title="Delete user">Remove</button>`;
    return `<tr><td class="u-name">${esc(u.username)}</td><td><span class="u-role ${u.role === 'admin' ? 'is-admin' : ''}">${esc(u.role)}</span></td><td class="u-act">${del}</td></tr>`;
  }).join('');
  body.innerHTML =
    '<table class="users-table"><thead><tr><th>Username</th><th>Role</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<form class="add-user-form" id="addUserForm">' +
      '<h4>Add a user</h4>' +
      '<div class="auth-field"><label>Username</label><input id="nuUser" type="text" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="3–32 chars: a–z 0–9 . _ -" /></div>' +
      '<div class="auth-field"><label>Password</label><input id="nuPass" type="password" autocomplete="new-password" placeholder="min length enforced server-side" /></div>' +
      '<label class="auth-check"><input id="nuAdmin" type="checkbox" /> Make this user an admin (can manage users)</label>' +
      '<div class="auth-msg" id="nuMsg"></div>' +
      '<button class="submit-btn" type="submit">+ Add user</button>' +
    '</form>' +
    googleAccessHelp();

  body.querySelectorAll('.u-del').forEach((b) => b.addEventListener('click', () => deleteUser(b.dataset.user, body)));
  body.querySelector('#addUserForm').addEventListener('submit', (e) => { e.preventDefault(); addUser(body); });
}

// ---------- global (shared) API keys — admin only ----------
// The credentials everyone runs on when they haven't brought their own. Stored
// as Secret Manager versions server-side; this UI only ever sees presence + a
// masked tail, never the value.
async function openGlobalKeysModal() {
  const body = openAuthModal('Global API keys');
  body.innerHTML = '<p class="auth-loading">Loading…</p>';
  let data;
  try {
    const r = await fetch('/api/global-keys', { credentials: 'same-origin' });
    if (r.status === 401) { window.location.replace('/login'); return; }
    data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load keys.');
  } catch (e) { body.innerHTML = '<p class="auth-err"></p>'; body.querySelector('p').textContent = e.message; return; }
  renderGlobalKeysModal(body, data);
}

function renderGlobalKeysModal(body, data) {
  const limit = (CONFIG && CONFIG.maxRunsPerDay) || 5;
  const rows = (data.keys || []).map((k) => {
    const state = k.present
      ? `<span class="gk-set">${esc(k.masked)}</span><span class="u-tag">${esc(k.source)}</span>`
      : '<span class="gk-unset">not set</span>';
    return `<div class="gk-row">
      <div class="gk-meta"><b>${esc(k.label)}</b><span class="gk-hint">${esc(k.hint)}</span>
        <code>${esc(k.name)}</code></div>
      <div class="gk-state">${state}</div>
      <div class="gk-edit">
        <input type="password" autocomplete="off" spellcheck="false" data-key="${esc(k.name)}" placeholder="${k.present ? 'replace…' : 'paste key…'}" />
        <button class="submit-btn gk-save" type="button" data-key="${esc(k.name)}">Save</button>
      </div>
    </div>`;
  }).join('');
  body.innerHTML =
    '<div class="key-scope global">' +
      '<div class="ks-head">🌐 Global keys — shared by EVERY user</div>' +
      '<ul class="ks-facts">' +
        '<li>Anyone who hasn\'t added a personal key runs on these, so usage and spend land on <b>your</b> account.</li>' +
        '<li>Stored as versions in <b>Google Secret Manager</b> — server-side, versioned and audited. Saving takes effect within a minute, <b>no redeploy</b>.</li>' +
        '<li>Values are <b>never sent back to this page</b> (you only ever see a masked tail), and every change is logged with the admin who made it.</li>' +
      '</ul>' +
    '</div>' +
    '<p class="keys-intro">Runs on these shared keys are capped at <b>' + limit + '/day per user</b>. ' +
    'A user who adds their own key for every model they select — under <em>Your API keys</em>, which stays in their browser — runs <b>unlimited</b>.</p>' +
    (data.enabled ? '' : '<div class="auth-msg err">Secret Manager isn\'t configured on the server (GCP_PROJECT_ID unset), so keys can only be read from the deploy environment.</div>') +
    '<div class="gk-list">' + rows + '</div>' +
    '<div class="auth-msg" id="gkMsg"></div>';

  body.querySelectorAll('.gk-save').forEach((b) => b.addEventListener('click', () => saveGlobalKey(body, b.dataset.key)));
  body.querySelectorAll('.gk-edit input').forEach((i) => i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveGlobalKey(body, i.dataset.key); }
  }));
}

async function saveGlobalKey(body, name) {
  const input = body.querySelector(`.gk-edit input[data-key="${name}"]`);
  const msg = body.querySelector('#gkMsg');
  const value = input ? input.value.trim() : '';
  if (!value) { msg.className = 'auth-msg err'; msg.textContent = 'Paste a key first.'; return; }
  msg.className = 'auth-msg'; msg.textContent = 'Saving to Secret Manager…';
  try {
    const r = await fetch('/api/global-keys', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Could not save.');
    renderGlobalKeysModal(body, { keys: j.keys, enabled: true });
    const m2 = body.querySelector('#gkMsg'); m2.className = 'auth-msg ok'; m2.textContent = name + ' updated for all users.';
  } catch (e) { msg.className = 'auth-msg err'; msg.textContent = e.message; }
}

// Instructions for granting access to Google sign-in users. The accounts table
// above only covers username/password logins, which do NOT survive a redeploy
// in the cloud — everyone real signs in with Google, and that list lives on the
// OAuth consent screen in the Cloud Console. There is no API to add test users
// (console-only), which is why this is written guidance rather than a form.
function googleAccessHelp() {
  const proj = (CONFIG && CONFIG.gcpProject) || 'your project';
  const domains = (CONFIG && CONFIG.allowedDomains && CONFIG.allowedDomains.length)
    ? CONFIG.allowedDomains.join(', ') : 'your allowed domain';
  return '<div class="access-help">' +
    '<h4>Giving someone Google sign-in access</h4>' +
    '<p>The table above is for username/password accounts, which persist across restarts and deploys. ' +
    'For anyone in your organisation, Google sign-in is easier — no password to manage — and is set up in the Cloud Console:</p>' +
    '<ol>' +
      '<li>Open <b>APIs &amp; Services ▸ OAuth consent screen</b> for <code>' + esc(proj) + '</code>.</li>' +
      '<li>Under <b>Audience ▸ Test users</b>, click <b>+ Add users</b>, enter their address and Save.</li>' +
      '<li>Send them the app link. They click <b>Sign in with Google</b> — no password needed.</li>' +
    '</ol>' +
    '<p class="hint" style="margin-top:10px"><b>Tired of adding people one at a time?</b> Click <b>Publish app</b> on that same screen. ' +
    'After that anyone on <b>' + esc(domains) + '</b> can sign in without being listed, and you never touch this again.</p>' +
    '<p class="hint">Note: Google provides no API for the test-user list, so this step cannot be automated from inside the app.</p>' +
  '</div>';
}

async function addUser(body) {
  const msg = body.querySelector('#nuMsg');
  msg.className = 'auth-msg'; msg.textContent = '';
  const username = body.querySelector('#nuUser').value.trim();
  const password = body.querySelector('#nuPass').value;
  const role = body.querySelector('#nuAdmin').checked ? 'admin' : 'user';
  const btn = body.querySelector('#addUserForm .submit-btn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/auth/users', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Could not add user.');
    renderUsersModal(body, { users: j.users, me: (ME && ME.username) }); // refresh list
  } catch (e) {
    msg.className = 'auth-msg err'; msg.textContent = e.message; btn.disabled = false;
  }
}

async function deleteUser(username, body) {
  if (!window.confirm(`Remove user "${username}"? They will be signed out immediately.`)) return;
  try {
    const r = await fetch('/api/auth/users/' + encodeURIComponent(username), { method: 'DELETE', credentials: 'same-origin' });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Could not remove user.');
    renderUsersModal(body, { users: j.users, me: (ME && ME.username) });
  } catch (e) { window.alert(e.message); }
}

function openChangePwModal() {
  const body = openAuthModal('Change my password');
  body.innerHTML =
    '<form class="add-user-form" id="changePwForm">' +
      '<div class="auth-field"><label>Current password</label><input id="cpCur" type="password" autocomplete="current-password" /></div>' +
      '<div class="auth-field"><label>New password</label><input id="cpNew" type="password" autocomplete="new-password" /></div>' +
      '<div class="auth-field"><label>Confirm new password</label><input id="cpConf" type="password" autocomplete="new-password" /></div>' +
      '<div class="auth-msg" id="cpMsg"></div>' +
      '<button class="submit-btn" type="submit">Update password</button>' +
    '</form>';
  body.querySelector('#changePwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = body.querySelector('#cpMsg'); msg.className = 'auth-msg'; msg.textContent = '';
    const cur = body.querySelector('#cpCur').value;
    const nw = body.querySelector('#cpNew').value;
    const conf = body.querySelector('#cpConf').value;
    if (nw !== conf) { msg.className = 'auth-msg err'; msg.textContent = 'New passwords do not match.'; return; }
    const btn = body.querySelector('.submit-btn'); btn.disabled = true;
    try {
      const r = await fetch('/api/auth/password', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
      });
      if (r.status === 401) { window.location.replace('/login'); return; }
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'Could not update password.');
      msg.className = 'auth-msg ok'; msg.textContent = 'Password updated.';
      btn.disabled = false;
      body.querySelector('#cpCur').value = body.querySelector('#cpNew').value = body.querySelector('#cpConf').value = '';
    } catch (e2) { msg.className = 'auth-msg err'; msg.textContent = e2.message; btn.disabled = false; }
  });
}

// ---------- model slots: add / remove from the fixed catalog ----------
function catalog() { return (CONFIG && CONFIG.catalog) || []; }

// ---------- 3-Dropdown Cascading Slot Selector (Provider > Model > Thinking Mode) ----------
const ALL_SLOT_IDS = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, MAX_SLOTS);
let SLOT_IDS = ['A', 'B', 'C'];          // active slots (1 .. 6)
const SLOT_ASSIGN = {};                  // slot -> catalogId | null
const SLOT_EFFORT = {};                  // slot -> chosen thinking level | null
ALL_SLOT_IDS.forEach((s) => { SLOT_ASSIGN[s] = null; SLOT_EFFORT[s] = null; });

const PROVIDER_FAMILIES = [
  { id: 'google',    label: 'Google (Gemini — Vertex AI)' },
  { id: 'anthropic', label: 'Anthropic (Claude — Vertex AI)' },
  { id: 'xai',       label: 'xAI (Grok — Vertex AI MaaS)' },
  { id: 'meta',      label: 'Meta (Llama — Vertex AI MaaS)' },
  { id: 'deepseek',  label: 'DeepSeek (Vertex AI MaaS)' },
  { id: 'qwen',      label: 'Alibaba / Qwen (Vertex AI MaaS)' },
  { id: 'openai',    label: 'OpenAI (GPT-OSS Vertex & Direct)' },
  { id: 'moonshot',  label: 'Moonshot AI (Kimi — Vertex & Direct)' },
  { id: 'zai',       label: 'Z.AI (GLM — Vertex AI MaaS)' },
];

// Sibling Reasoning <-> Non-Reasoning catalog pairs so Dropdown 3 ("Thinking Mode")
// can also toggle between Reasoning and Non-Reasoning variants of the same family!
const REASONING_SIBLING_PAIRS = {
  'grok-4.20-reasoning':      [
    { id: 'grok-4.20-reasoning',     label: 'Reasoning (Chain-of-Thought) — grok-4.20-reasoning' },
    { id: 'grok-4.20-non-reasoning', label: 'Non-Reasoning (Fast Direct) — grok-4.20-non-reasoning' },
  ],
  'grok-4.20-non-reasoning':  [
    { id: 'grok-4.20-reasoning',     label: 'Reasoning (Chain-of-Thought) — grok-4.20-reasoning' },
    { id: 'grok-4.20-non-reasoning', label: 'Non-Reasoning (Fast Direct) — grok-4.20-non-reasoning' },
  ],
  'grok-4.1-fast-reasoning': [
    { id: 'grok-4.1-fast-reasoning',     label: 'Reasoning (Fast CoT) — grok-4.1-fast-reasoning' },
    { id: 'grok-4.1-fast-non-reasoning', label: 'Non-Reasoning (Ultra-Fast) — grok-4.1-fast-non-reasoning' },
  ],
  'grok-4.1-fast-non-reasoning': [
    { id: 'grok-4.1-fast-reasoning',     label: 'Reasoning (Fast CoT) — grok-4.1-fast-reasoning' },
    { id: 'grok-4.1-fast-non-reasoning', label: 'Non-Reasoning (Ultra-Fast) — grok-4.1-fast-non-reasoning' },
  ],
  'qwen3-next-80b-a3b-thinking-maas': [
    { id: 'qwen3-next-80b-a3b-thinking-maas', label: 'Thinking (Chain-of-Thought) — qwen3-next-80b-thinking' },
    { id: 'qwen3-next-80b-a3b-instruct-maas', label: 'Instruct (Non-Reasoning) — qwen3-next-80b-instruct' },
  ],
  'qwen3-next-80b-a3b-instruct-maas': [
    { id: 'qwen3-next-80b-a3b-thinking-maas', label: 'Thinking (Chain-of-Thought) — qwen3-next-80b-thinking' },
    { id: 'qwen3-next-80b-a3b-instruct-maas', label: 'Instruct (Non-Reasoning) — qwen3-next-80b-instruct' },
  ],
  'deepseek-r1-0528-maas': [
    { id: 'deepseek-r1-0528-maas', label: 'Reasoning (DeepSeek R1 CoT) — deepseek-r1-0528-maas' },
    { id: 'deepseek-v3.2-maas',    label: 'Non-Reasoning (DeepSeek V3.2 Fast) — deepseek-v3.2-maas' },
  ],
  'deepseek-v3.2-maas': [
    { id: 'deepseek-r1-0528-maas', label: 'Reasoning (DeepSeek R1 CoT) — deepseek-r1-0528-maas' },
    { id: 'deepseek-v3.2-maas',    label: 'Non-Reasoning (DeepSeek V3.2 Fast) — deepseek-v3.2-maas' },
  ],
};

function providerFamilyOf(c) {
  if (!c) return 'google';
  if (c.providerFamily) return c.providerFamily;
  const pub = (c.publisher || '').toLowerCase();
  if (pub === 'anthropic' || c.provider === 'anthropic') return 'anthropic';
  if (pub === 'xai') return 'xai';
  if (pub === 'meta') return 'meta';
  if (pub.startsWith('deepseek')) return 'deepseek';
  if (pub === 'qwen') return 'qwen';
  if (pub === 'moonshotai' || c.provider === 'moonshot') return 'moonshot';
  if (pub === 'zai-org') return 'zai';
  if (pub === 'openai' || c.provider === 'openai') return 'openai';
  return 'google';
}

function providerLabelOf(familyId) {
  const f = PROVIDER_FAMILIES.find((x) => x.id === familyId);
  return f ? f.label : familyId;
}

function seedSlots() {
  const UPGRADE_MAP = {
    'gemini-3.7-flash': 'gemini-3.8-flash',
    'gemini-3.6-flash': 'gemini-3.8-flash',
    'claude-opus-4-7': 'claude-opus-5-5',
    'claude-opus-4-8': 'claude-opus-5-5',
    'claude-opus-5': 'claude-opus-5-5',
    'claude-fable-5': 'claude-fable-5-1',
    'gpt-5.6-sol': 'gpt-6-sol',
  };
  const usable = (list) => (list || [])
    .map((m) => {
      const rawId = m.catalogId || m.id;
      return { id: UPGRADE_MAP[rawId] || rawId, effort: m.effort || null };
    })
    .filter((m) => { const c = catalog().find((x) => x.id === m.id); return c && modelAvailability(c).ok; })
    .slice(0, MAX_SLOTS);

  const list = usable(CONFIG.models);
  const count = Math.max(1, Math.min(MAX_SLOTS, list.length || 4));
  SLOT_IDS = ALL_SLOT_IDS.slice(0, count);
  ALL_SLOT_IDS.forEach((s) => { SLOT_ASSIGN[s] = null; SLOT_EFFORT[s] = null; });
  list.forEach((m, i) => {
    const s = SLOT_IDS[i];
    if (!s) return;
    SLOT_ASSIGN[s] = m.id;
    SLOT_EFFORT[s] = m.effort;
  });
}

function modelFromCatalogId(slot, id, duplicateCatalogIds) {
  const c = catalog().find((x) => x.id === id);
  if (!c) return null;
  const eff = SLOT_EFFORT[slot] || undefined;
  const effDisplay = eff || (c.thinking && c.thinking.label) || 'default';
  const label = (duplicateCatalogIds && duplicateCatalogIds.has(c.id))
    ? `${c.label} (${effDisplay})`
    : c.label;
  return {
    slot, catalogId: c.id, label, baseLabel: c.label,
    provider: c.provider, publisher: c.publisher,
    providerFamily: providerFamilyOf(c),
    providerLabel: c.providerLabel || providerLabelOf(providerFamilyOf(c)),
    endpointType: c.endpointType || null,
    region: c.region || null,
    model: c.model,
    price: { input: c.price.input, output: c.price.output },
    external: !!c.external,
    thinking: c.thinking || null,
    thinkingOptions: c.thinkingOptions || null,
    effort: eff,
  };
}

// MODELS (what the rest of the app runs on) is derived from the active slots.
// Automatically disambiguates labels when two or more slots compare the same model!
function syncModelsFromSlots() {
  const counts = {};
  SLOT_IDS.forEach((s) => {
    const cid = SLOT_ASSIGN[s];
    if (cid) counts[cid] = (counts[cid] || 0) + 1;
  });
  const duplicateCatalogIds = new Set(Object.keys(counts).filter((k) => counts[k] > 1));
  MODELS = SLOT_IDS
    .filter((s) => SLOT_ASSIGN[s])
    .map((s) => modelFromCatalogId(s, SLOT_ASSIGN[s], duplicateCatalogIds))
    .filter(Boolean);
}

function slotOf(catalogId) { return SLOT_IDS.find((s) => SLOT_ASSIGN[s] === catalogId) || null; }

// Place `catalogId` into `slot` WITHOUT removing it from other slots (so the same
// model can be compared side-by-side with different Thinking Modes).
function assignToSlot(catalogId, slot, effortOverride) {
  if (!ALL_SLOT_IDS.includes(slot)) return;
  if (!SLOT_IDS.includes(slot)) SLOT_IDS.push(slot);
  const c = catalog().find((x) => x.id === catalogId);
  if (!c || !modelAvailability(c).ok) return;
  SLOT_ASSIGN[slot] = catalogId;
  if (effortOverride !== undefined) {
    SLOT_EFFORT[slot] = effortOverride || null;
  } else if (c.thinkingOptions && c.thinkingOptions.configurable) {
    const valid = c.thinkingOptions.options.some((o) => o.value === (SLOT_EFFORT[slot] || ''));
    if (!valid) SLOT_EFFORT[slot] = null;
  } else {
    SLOT_EFFORT[slot] = null;
  }
  afterSlotChange();
}

function addSlot() {
  if (SLOT_IDS.length >= MAX_SLOTS) return;
  const nextSlot = ALL_SLOT_IDS.find((s) => !SLOT_IDS.includes(s));
  if (!nextSlot) return;
  // Pick the latest frontier models for new slots
  const preferredOrder = [
    'gemini-3.8-flash', 'claude-opus-5-5', 'claude-fable-5-1', 'gpt-6-sol',
    'grok-4.20-reasoning', 'deepseek-r1-0528-maas', 'llama-4-maverick-17b-128e-maas',
  ];
  const existingIds = new Set(SLOT_IDS.map((s) => SLOT_ASSIGN[s]));
  let chosenId = preferredOrder.find((id) => {
    const c = catalog().find((x) => x.id === id);
    return c && modelAvailability(c).ok && !existingIds.has(id);
  });
  if (!chosenId) {
    const firstAvail = catalog().find((c) => modelAvailability(c).ok);
    chosenId = firstAvail ? firstAvail.id : 'gemini-3.8-flash';
  }
  SLOT_IDS.push(nextSlot);
  SLOT_ASSIGN[nextSlot] = chosenId;
  SLOT_EFFORT[nextSlot] = null;
  afterSlotChange();
}

function clearSlot(slot) {
  if (SLOT_IDS.length <= MIN_SLOTS) return;
  const idx = SLOT_IDS.indexOf(slot);
  if (idx < 0) return;
  // Shift remaining slot assignments down so slots stay contiguous A, B, C...
  const remaining = SLOT_IDS.filter((s) => s !== slot).map((s) => ({
    id: SLOT_ASSIGN[s],
    effort: SLOT_EFFORT[s],
  }));
  SLOT_IDS = ALL_SLOT_IDS.slice(0, remaining.length);
  ALL_SLOT_IDS.forEach((s, i) => {
    SLOT_ASSIGN[s] = remaining[i] ? remaining[i].id : null;
    SLOT_EFFORT[s] = remaining[i] ? remaining[i].effort : null;
  });
  afterSlotChange();
}

function applyPreset(presetName) {
  let target = [];
  if (presetName === 'frontier') {
    target = [
      { id: 'gemini-3.8-flash',    effort: 'high' },
      { id: 'claude-opus-5-5',     effort: 'high' },
      { id: 'claude-fable-5-1',    effort: 'high' },
      { id: 'gpt-6-sol',           effort: 'high' },
      { id: 'grok-4.20-reasoning', effort: null },
    ];
  } else if (presetName === 'same-model-thinking') {
    target = [
      { id: 'gemini-3.8-flash', effort: 'minimal' },
      { id: 'gemini-3.8-flash', effort: 'medium' },
      { id: 'gemini-3.8-flash', effort: 'high' },
    ];
  } else if (presetName === 'grok-reasoning') {
    target = [
      { id: 'grok-4.20-reasoning',          effort: null },
      { id: 'grok-4.20-non-reasoning',      effort: null },
      { id: 'grok-4.1-fast-reasoning',      effort: null },
      { id: 'grok-4.1-fast-non-reasoning',  effort: null },
    ];
  } else if (presetName === 'open-maas') {
    target = [
      { id: 'llama-4-maverick-17b-128e-maas',   effort: null },
      { id: 'qwen3-next-80b-a3b-thinking-maas', effort: null },
      { id: 'kimi-k2-thinking-maas',            effort: null },
      { id: 'glm-5.2-maas',                     effort: null },
    ];
  }
  const valid = target.filter((t) => {
    const c = catalog().find((x) => x.id === t.id);
    return c && modelAvailability(c).ok;
  });
  if (!valid.length) return;
  SLOT_IDS = ALL_SLOT_IDS.slice(0, valid.length);
  ALL_SLOT_IDS.forEach((s, i) => {
    SLOT_ASSIGN[s] = valid[i] ? valid[i].id : null;
    SLOT_EFFORT[s] = valid[i] ? valid[i].effort : null;
  });
  afterSlotChange();
}

function placeInFirstFreeSlot(catalogId) {
  const c = catalog().find((x) => x.id === catalogId);
  if (!c || !modelAvailability(c).ok) return;
  if (SLOT_IDS.length < MAX_SLOTS) {
    const nextSlot = ALL_SLOT_IDS[SLOT_IDS.length];
    SLOT_IDS.push(nextSlot);
    assignToSlot(catalogId, nextSlot);
  } else {
    assignToSlot(catalogId, SLOT_IDS[SLOT_IDS.length - 1]);
  }
}

function afterSlotChange() {
  syncModelsFromSlots();
  renderModelEditors();
  buildArena();
  updateQuotaBadge();
  updateRunButton();
  if (typeof renderContextMeter === 'function') renderContextMeter();
}

function updateRunButton() {
  const btn = $('#runBtn');
  if (!btn || _busy) return;
  const none = MODELS.length === 0;
  btn.disabled = none;
  btn.title = none ? 'Select at least one model slot to run a comparison.' : '';
}

function currentTask() {
  const id = $('#taskSelect').value;
  if (id === 'custom') return { id: 'custom', title: 'Custom prompt', prompt: '', testCount: 0, category: 'general', language: null, executable: false };
  return CONFIG.tasks.find((t) => t.id === id) || CONFIG.tasks[0];
}
let CUSTOM_ATTACHMENTS = []; // [{ id, name, mimeType, size, data, textContent, previewUrl, estimatedTokens, pageCount, warning }]
const MAX_CUSTOM_ATTACHMENTS = 10;
const MAX_CUSTOM_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTokensShort(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return `${v} tok`;
  if (v < 1000000) return `${(v / 1000).toFixed(1)}K tok`;
  return `${(v / 1000000).toFixed(2)}M tok`;
}

function isTextLikeAttachment(name, mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml' || m === 'application/javascript' || m === 'image/svg+xml') return true;
  return /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|html|htm|css|js|mjs|cjs|jsx|ts|tsx|py|sql|sh|bash|zsh|log|ini|conf|env|toml|c|cpp|h|go|rs|java|rb|php|swift|kt|svg)$/i.test(String(name || ''));
}

function attachmentBadgeInfo(name, mime) {
  const m = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (m === 'application/pdf' || n.endsWith('.pdf')) return { label: 'PDF', cls: 'is-pdf' };
  if (/\.(docx|xlsx|pptx|zip)$/i.test(n)) return { label: 'DOC/ZIP', cls: 'is-data' };
  if (m.includes('csv') || n.endsWith('.csv') || n.endsWith('.tsv')) return { label: 'CSV', cls: 'is-data' };
  if (m.includes('json') || n.endsWith('.json') || n.endsWith('.jsonl')) return { label: 'JSON', cls: 'is-data' };
  if (n.endsWith('.svg') || m === 'image/svg+xml') return { label: 'SVG', cls: '' };
  if (n.endsWith('.md') || n.endsWith('.markdown')) return { label: 'MD', cls: '' };
  if (/\.(py|js|ts|jsx|tsx|sql|sh|go|rs|java|c|cpp|rb|php|html|css)$/i.test(n)) return { label: 'CODE', cls: '' };
  return { label: 'FILE', cls: '' };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('Failed to read file'));
    fr.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => resolve('');
    fr.readAsText(file);
  });
}

function readFileAsLatin1(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => resolve('');
    fr.readAsBinaryString(file);
  });
}

function estimateClientAttachmentTokens({ isEmpty, isImage, isPdf, pageCount, size, textContent }) {
  if (isEmpty) return 15;
  if (isImage) return Math.min(1150, Math.max(258, Math.ceil((size || 0) / 1400)));
  if (isPdf) {
    const pTok = Math.max(1, pageCount || 1) * 258;
    const tTok = Math.ceil((textContent || '').length / 3.8);
    return Math.max(pTok, tTok) + 40;
  }
  if (textContent && textContent.length) return Math.ceil(textContent.length / 3.8) + 25;
  return Math.max(60, Math.ceil((size || 0) / 20));
}

// Anthropic caps each image at 5 MB of base64. For a larger image we keep the
// ORIGINAL for every provider and make a downscaled copy in the browser that is
// sent alongside it (claudeDataBase64 / claudeMimeType) and used only for Claude.
const CLAUDE_MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024;
const CLAUDE_SCALED_TARGET_CHARS = Math.floor(CLAUDE_MAX_IMAGE_BASE64_CHARS * 0.97); // headroom under the cap
// Claude's maximum native image resolution (high-resolution tier, Claude 4.7 and
// later: 2576 px long edge AND 4784 visual tokens, one token per 28×28 patch).
// Anything larger is downscaled by the API anyway, so the copy starts at this size;
// older (standard-tier, 1568 px) Claude models downscale it further server-side.
// https://docs.anthropic.com/en/docs/build-with-claude/vision (checked 2026-09-25)
const CLAUDE_IMAGE_MAX_LONG_EDGE = 2576;
const CLAUDE_IMAGE_MAX_VISUAL_TOKENS = 4784;
const CLAUDE_IMAGE_PATCH_PX = 28;
// If the copy is still over 5 MB at the native size: shrink by these factors.
const CLAUDE_SCALE_STEPS = [1, 0.8, 0.65, 0.5, 0.4, 0.3];
const CLAUDE_SCALE_QUALITIES = [0.9, 0.82, 0.72, 0.6];

// Largest scale (≤ 1) whose result fits Claude's long-edge and visual-token limits.
function claudeNativeScale(width, height) {
  const long = Math.max(width, height);
  let s = Math.min(1, CLAUDE_IMAGE_MAX_LONG_EDGE / long);
  const px = (n, k) => Math.max(1, Math.round(n * k));
  const tokens = (k) => Math.ceil(px(width, k) / CLAUDE_IMAGE_PATCH_PX) * Math.ceil(px(height, k) / CLAUDE_IMAGE_PATCH_PX);
  if (tokens(s) > CLAUDE_IMAGE_MAX_VISUAL_TOKENS) {
    s = Math.min(s, Math.sqrt((CLAUDE_IMAGE_MAX_VISUAL_TOKENS * CLAUDE_IMAGE_PATCH_PX * CLAUDE_IMAGE_PATCH_PX) / (width * height)));
    while (s > 0.01 && tokens(s) > CLAUDE_IMAGE_MAX_VISUAL_TOKENS) s *= 0.99; // ceil() rounding
  }
  return s;
}

const base64LengthForBytes = (n) => 4 * Math.ceil((Number(n) || 0) / 3);

// OpenAI: images over 30,000 patches of 32×32 px are REJECTED, not resized
// (https://platform.openai.com/docs/guides/images-vision, checked 2026-09-25).
// For such images the browser also makes a "fit copy" shrunk to that budget with
// OpenAI's official shrink formula, so OpenAI keeps as much detail as it accepts.
// Claude's hard limit is 8000 px, so that also triggers the Claude copy.
const OPENAI_PATCH_PX = 32;
const OPENAI_MAX_PATCHES = 30000;
const CLAUDE_HARD_MAX_DIM = 8000;
const FIT_COPY_QUALITIES = [0.9, 0.85, 0.8, 0.72, 0.6];
const openaiPatchCount = (w, h) => Math.ceil(w / OPENAI_PATCH_PX) * Math.ceil(h / OPENAI_PATCH_PX);

// Official formula: shrink = sqrt(32² × budget / (w×h)), then snap so whole
// patches fit, then floor. Returns null when the image already fits.
function openaiFitSize(width, height, budget = OPENAI_MAX_PATCHES) {
  if (!width || !height || openaiPatchCount(width, height) <= budget) return null;
  const p = OPENAI_PATCH_PX;
  const shrink = Math.sqrt((p * p * budget) / (width * height));
  const wp = (width * shrink) / p;
  const hp = (height * shrink) / p;
  const adjusted = shrink * Math.min(Math.floor(wp) / wp, Math.floor(hp) / hp);
  return { width: Math.max(1, Math.floor(width * adjusted)), height: Math.max(1, Math.floor(height * adjusted)) };
}

// Pixel size from the file header (PNG/GIF/WebP/JPEG) without decoding; falls
// back to a full decode if the header can't be read. Returns null on failure.
function dimsFromHeader(b) {
  const u16be = (o) => (b[o] << 8) | b[o + 1];
  const u16le = (o) => b[o] | (b[o + 1] << 8);
  const u24le = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  const u32be = (o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length < 30) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return str(12, 4) === 'IHDR' ? { width: u32be(16), height: u32be(20) } : null;
  if (str(0, 6) === 'GIF87a' || str(0, 6) === 'GIF89a') return { width: u16le(6), height: u16le(8) };
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') {
    const cc = str(12, 4);
    if (cc === 'VP8X') return { width: 1 + u24le(24), height: 1 + u24le(27) };
    if (cc === 'VP8L') return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (cc === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    const SOF = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) { off++; continue; }
      const m = b[off + 1];
      if (m === 0xff) { off++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { off += 2; continue; }
      if (m === 0xd9 || m === 0xda) return null;
      if (SOF.includes(m)) return { width: u16be(off + 7), height: u16be(off + 5) };
      off += 2 + u16be(off + 2);
    }
  }
  return null;
}

async function readImageDims(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
    const d = dimsFromHeader(head);
    if (d && d.width && d.height) return d;
  } catch (_) { /* fall back to decoding */ }
  try {
    const decoded = await decodeImageSource(file);
    try { return { width: decoded.width, height: decoded.height }; } finally { decoded.close(); }
  } catch (_) {
    return null;
  }
}

// OpenAI fit copy at exactly `target` size, JPEG, smaller than the original.
// Returns { base64, mimeType, width, height, bytes } or { error } (never throws).
async function makeFitCopy(file, target) {
  let decoded;
  try {
    decoded = await decodeImageSource(file);
  } catch (_) {
    return { error: 'the browser could not decode this image' };
  }
  try {
    const { width: w, height: h } = target;
    const canvas = makeScaleCanvas(w, h);
    if (!canvas.ctx) return { error: 'canvas is unavailable in this browser' };
    const maxBytes = Math.min((file.size || 0) * 0.98, MAX_CUSTOM_FILE_BYTES);
    for (const q of FIT_COPY_QUALITIES) {
      const blob = await canvasEncode(canvas, decoded, w, h, 'image/jpeg', q);
      if (blob && blob.type === 'image/jpeg' && blob.size < maxBytes) {
        return { base64: await blobToBase64(blob), mimeType: 'image/jpeg', width: w, height: h, bytes: blob.size };
      }
    }
    return { error: 'it could not be made smaller than the original' };
  } catch (_) {
    return { error: 'the browser failed while re-encoding the image' };
  } finally {
    decoded.close();
  }
}

function blobToBase64(blob) {
  return readFileAsDataUrl(blob).then((u) => {
    const i = u.indexOf(',');
    return i >= 0 ? u.slice(i + 1) : u;
  });
}

// Decode the file into something drawable. createImageBitmap is preferred (off the
// main thread, honours EXIF orientation); an <img> element is the fallback.
async function decodeImageSource(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch (_) { /* fall back to <img> below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeScaleCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') {
    const c = new OffscreenCanvas(w, h);
    return { ctx: c.getContext('2d'), encode: (type, quality) => c.convertToBlob({ type, quality }) };
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { ctx: c.getContext('2d'), encode: (type, quality) => new Promise((resolve) => c.toBlob(resolve, type, quality)) };
}

// Returns { base64, mimeType, width, height, bytes } or { error } (never throws).
async function makeClaudeScaledCopy(file) {
  if (/gif$/i.test(file.type || '') || /\.gif$/i.test(file.name || '')) {
    return { error: 'animated GIFs are not re-encoded' };
  }
  let decoded;
  try {
    decoded = await decodeImageSource(file);
  } catch (_) {
    return { error: 'the browser could not decode this image' };
  }
  try {
    const longSide = Math.max(decoded.width, decoded.height);
    if (!longSide) return { error: 'the image has no dimensions' };
    let outMime = null; // decided on the first encode: WebP if the browser can encode it, else JPEG
    const native = claudeNativeScale(decoded.width, decoded.height);
    for (const step of CLAUDE_SCALE_STEPS) {
      const scale = native * step;
      const w = Math.max(1, Math.round(decoded.width * scale));
      const h = Math.max(1, Math.round(decoded.height * scale));
      const canvas = makeScaleCanvas(w, h);
      if (!canvas.ctx) return { error: 'canvas is unavailable in this browser' };
      for (const q of CLAUDE_SCALE_QUALITIES) {
        if (!outMime) {
          const probe = await canvasEncode(canvas, decoded, w, h, 'image/webp', q);
          outMime = probe && probe.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
          if (outMime === 'image/webp' && base64LengthForBytes(probe.size) <= CLAUDE_SCALED_TARGET_CHARS) {
            return { base64: await blobToBase64(probe), mimeType: outMime, width: w, height: h, bytes: probe.size };
          }
          if (outMime === 'image/webp') continue;
        }
        const blob = await canvasEncode(canvas, decoded, w, h, outMime, q);
        if (blob && blob.type === outMime && base64LengthForBytes(blob.size) <= CLAUDE_SCALED_TARGET_CHARS) {
          return { base64: await blobToBase64(blob), mimeType: outMime, width: w, height: h, bytes: blob.size };
        }
      }
    }
    return { error: 'it could not be compressed under 5 MB' };
  } catch (_) {
    return { error: 'the browser failed while re-encoding the image' };
  } finally {
    decoded.close();
  }
}

async function canvasEncode(canvas, decoded, w, h, type, quality) {
  // JPEG has no alpha channel: paint white first so transparent areas don't turn black.
  canvas.ctx.clearRect(0, 0, w, h);
  if (type === 'image/jpeg') {
    canvas.ctx.fillStyle = '#ffffff';
    canvas.ctx.fillRect(0, 0, w, h);
  }
  canvas.ctx.drawImage(decoded.source, 0, 0, w, h);
  return canvas.encode(type, quality);
}

// #attachmentSizeWarning: one dismissible row per oversized image, built with
// createElement/textContent only (file names are untrusted).
const SIZE_WARNINGS = new Map(); // attachment id -> { text, isError }

function setSizeWarning(id, text, isError) {
  if (text) SIZE_WARNINGS.set(id, { text, isError: Boolean(isError) });
  else SIZE_WARNINGS.delete(id);
  renderSizeWarnings();
}

function renderSizeWarnings() {
  const box = $('#attachmentSizeWarning');
  if (!box) return;
  for (const id of [...SIZE_WARNINGS.keys()]) {
    if (!CUSTOM_ATTACHMENTS.some((a) => a.id === id)) SIZE_WARNINGS.delete(id);
  }
  const rows = [];
  for (const [id, w] of SIZE_WARNINGS) {
    const row = document.createElement('div');
    row.className = w.isError ? 'csw-row is-error' : 'csw-row';
    const msg = document.createElement('span');
    msg.textContent = (w.isError ? '⚠ ' : 'ℹ ') + w.text;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'csw-dismiss';
    btn.setAttribute('aria-label', 'Dismiss');
    btn.textContent = '✕';
    btn.addEventListener('click', () => setSizeWarning(id, null));
    row.append(msg, btn);
    rows.push(row);
  }
  box.replaceChildren(...rows);
  box.classList.toggle('hidden', rows.length === 0);
}

// Cloud Run caps an HTTP/1 request at 32 MiB, so an original plus its scaled
// copies may not fit in one inspect call: the original goes first, and each copy
// that doesn't fit follows as a by-hash reference (the server attaches it to the
// cached entry after validating it).
const INSPECT_BUDGET_CHARS = 28 * 1024 * 1024;

async function postInspect(item) {
  const r = await fetch('/api/attachments/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attachments: [item] }),
  });
  if (!r.ok) return null;
  const body = await r.json();
  return (body && Array.isArray(body.attachments) && body.attachments[0]) || null;
}

async function inspectAttachmentOnServer(attObj) {
  if (!attObj || attObj.isEmpty) return;
  try {
    const base = {
      name: attObj.name,
      mimeType: attObj.mimeType,
      size: attObj.size,
      data: attObj.data,
      textContent: attObj.textContent || undefined,
    };
    const copies = [];
    if (attObj.claudeDataBase64) copies.push({ claudeDataBase64: attObj.claudeDataBase64, claudeMimeType: attObj.claudeMimeType });
    if (attObj.fitDataBase64) copies.push({ fitDataBase64: attObj.fitDataBase64, fitMimeType: attObj.fitMimeType });
    const copyChars = (c) => (c.claudeDataBase64 || c.fitDataBase64 || '').length;
    const first = { ...base };
    const later = [];
    let used = (attObj.data || '').length + (attObj.textContent || '').length;
    for (const c of copies) {
      if (used + copyChars(c) <= INSPECT_BUDGET_CHARS) { Object.assign(first, c); used += copyChars(c); } else later.push(c);
    }
    const srv = await postInspect(first);
    if (!srv) return;
    for (const c of later) {
      if (!srv.sha256) break;
      const extra = await postInspect({ sha256: srv.sha256, name: attObj.name, mimeType: attObj.mimeType, size: attObj.size, ...c });
      if (extra && extra.claudeScaled !== undefined) srv.claudeScaled = extra.claudeScaled;
      if (extra && extra.fitScaled !== undefined) srv.fitScaled = extra.fitScaled;
    }
    if (srv.sha1) attObj.sha1 = srv.sha1;
    if (srv.sha256) attObj.sha256 = srv.sha256;
    if (srv.cached) attObj.cached = true;
    if (typeof srv.estimatedTokens === 'number' && srv.estimatedTokens > 0) {
      attObj.estimatedTokens = srv.estimatedTokens;
    }
    if (typeof srv.pageCount === 'number' && srv.pageCount > 0) {
      attObj.pageCount = srv.pageCount;
    }
    if (srv.warning && !attObj.warning) {
      attObj.warning = srv.warning;
    }
    if (srv.claudeScaled === false && attObj.claudeDataBase64) {
      // Server refused the copy (bad type/size): Claude falls back to a text note.
      attObj.claudeDataBase64 = null;
      attObj.claudeMimeType = null;
      attObj.optBadge = null;
      setSizeWarning(attObj.id, `"${attObj.name}": the scaled copy for Claude was rejected by the server, so Claude will receive a text note instead of the image. Other models get the original.`, true);
    }
    if (srv.fitScaled === false && attObj.fitDataBase64) {
      attObj.fitDataBase64 = null;
      attObj.fitMimeType = null;
      setSizeWarning(attObj.id, `"${attObj.name}": the scaled copy for OpenAI was rejected by the server, so OpenAI models will show an "image couldn't be sent" error instead of answering without it. Other models are unaffected.`, true);
    }
    renderAttachments();
    renderTaskMeta();
  } catch (_) {
    // Non-fatal: client-side estimation remains active
  }
}

async function addAttachmentFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const files = Array.from(fileList);
  for (const file of files) {
    if (CUSTOM_ATTACHMENTS.length >= MAX_CUSTOM_ATTACHMENTS) {
      window.alert(`Maximum of ${MAX_CUSTOM_ATTACHMENTS} attachments reached.`);
      break;
    }
    if (file.size > MAX_CUSTOM_FILE_BYTES) {
      window.alert(`"${file.name}" is ${formatBytes(file.size)} (max ${formatBytes(MAX_CUSTOM_FILE_BYTES)} per file).`);
      continue;
    }
    // Deduplicate exact same filename + size
    if (CUSTOM_ATTACHMENTS.some((x) => x.name === file.name && x.size === file.size)) {
      continue;
    }
    try {
      const isEmpty = file.size === 0;
      let dataUrl = isEmpty ? '' : await readFileAsDataUrl(file);
      let commaIdx = dataUrl.indexOf(',');
      let base64Data = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      const lowerName = String(file.name || '').toLowerCase();
      let mimeType = file.type || (lowerName.endsWith('.pdf') ? 'application/pdf' : (lowerName.endsWith('.svg') ? 'image/svg+xml' : ''));
      const isSvg = lowerName.endsWith('.svg') || mimeType === 'image/svg+xml';
      const isPdf = !isEmpty && (mimeType === 'application/pdf' || lowerName.endsWith('.pdf'));
      const isImage = !isEmpty && !isSvg && (/^image\/(png|jpeg|jpg|webp|gif)$/i.test(mimeType) || /\.(png|jpe?g|webp|gif)$/i.test(lowerName));
      const textContent = (!isEmpty && isTextLikeAttachment(file.name, mimeType)) ? await readFileAsText(file) : '';

      const effectiveSize = file.size || 0;
      let optBadge = null;
      // Every provider gets the original image when it accepts it. Scaled copies
      // are made only when a provider's documented limit would reject it:
      //  - Claude copy (max native size): over 5 MB base64 or 8000 px — used by
      //    Claude, and as the last fallback for any provider that rejects the original;
      //  - OpenAI fit copy: over OpenAI's 30,000-patch limit.
      let claudeCopy = null;
      let fitCopy = null;
      let sizeNote = null;
      const isGif = /gif$/i.test(mimeType) || /\.gif$/i.test(lowerName);
      const dims = isImage && !isGif ? await readImageDims(file) : null;
      const overClaudeBytes = isImage && base64Data.length > CLAUDE_MAX_IMAGE_BASE64_CHARS;
      const overClaudeDim = Boolean(dims) && Math.max(dims.width, dims.height) > CLAUDE_HARD_MAX_DIM;
      const fitTarget = dims ? openaiFitSize(dims.width, dims.height) : null;
      const label = `"${file.name || 'image'}" (${formatBytes(effectiveSize)}${dims ? `, ${dims.width}×${dims.height}` : ''})`;
      const notes = [];
      let noteIsError = false;
      if (isImage && (overClaudeBytes || overClaudeDim || fitTarget)) {
        const scaled = await makeClaudeScaledCopy(file);
        const claudeWhy = overClaudeBytes ? "over Claude's 5 MB image limit" : (overClaudeDim ? `over Claude's ${CLAUDE_HARD_MAX_DIM} px limit` : '');
        if (scaled && scaled.base64) {
          claudeCopy = scaled;
          const fmt = scaled.mimeType === 'image/webp' ? 'WebP' : 'JPEG';
          optBadge = `Claude copy ${scaled.width}×${scaled.height} ${fmt} (${formatBytes(scaled.bytes)})`;
          if (claudeWhy) {
            notes.push(`${label} is ${claudeWhy}, so Claude gets a copy auto-scaled to ${scaled.width}×${scaled.height} ${fmt} (${formatBytes(scaled.bytes)}), within Claude's max native resolution (${CLAUDE_IMAGE_MAX_LONG_EDGE} px / ${CLAUDE_IMAGE_MAX_VISUAL_TOKENS} visual tokens).`);
          } else {
            notes.push(`${label}: a ${scaled.width}×${scaled.height} ${fmt} copy is kept as a fallback, used (and labelled) only if a provider rejects the original.`);
          }
        } else {
          const why = (scaled && scaled.error) || 'unknown error';
          noteIsError = noteIsError || Boolean(claudeWhy);
          notes.push(claudeWhy
            ? `${label} is ${claudeWhy} and couldn't be auto-scaled (${why}). Claude will receive a text note instead of the image.`
            : `${label}: couldn't make a fallback copy (${why}).`);
        }
      }
      if (isImage && fitTarget) {
        const patches = openaiPatchCount(dims.width, dims.height);
        const fc = await makeFitCopy(file, fitTarget);
        if (fc && fc.base64) {
          fitCopy = fc;
          optBadge = [optBadge, `OpenAI copy ${fc.width}×${fc.height} JPEG (${formatBytes(fc.bytes)})`].filter(Boolean).join(' · ');
          notes.push(`OpenAI models get a copy auto-scaled to ${fc.width}×${fc.height} JPEG (${formatBytes(fc.bytes)}): OpenAI rejects images over ${OPENAI_MAX_PATCHES.toLocaleString()} patches and this one needs ${patches.toLocaleString()}.`);
        } else {
          noteIsError = true;
          notes.push(`OpenAI rejects images over ${OPENAI_MAX_PATCHES.toLocaleString()} patches (this one needs ${patches.toLocaleString()}) and a copy couldn't be made (${(fc && fc.error) || 'unknown error'}); OpenAI models will use the smaller fallback copy if there is one, or show an "image couldn't be sent" error.`);
        }
      }
      if (notes.length) {
        // Keep the Round 6 sentence verbatim for the plain ">5 MB" case.
        sizeNote = { text: `${notes.join(' ')} Other models get the original.`.replace(`${label} is over`, `"${file.name || 'image'}" (${formatBytes(effectiveSize)}) is over`), isError: noteIsError };
      }

      let pageCount = 0;
      let warning = null;
      if (isEmpty) {
        warning = 'Empty file (0 bytes)';
      } else if (isPdf) {
        const rawBin = await readFileAsLatin1(file);
        const pageMatches = rawBin.match(/\/Type\s*\/Page\b/g);
        pageCount = Math.max(1, pageMatches ? pageMatches.length : 1);
        if (/\/Encrypt\b/.test(rawBin)) {
          warning = `Encrypted PDF (${pageCount}p)`;
        } else if (pageCount > 100) {
          warning = `${pageCount} pages (Claude >100p uses extracted text)`;
        }
      } else if (isImage && (overClaudeBytes || overClaudeDim) && !claudeCopy) {
        warning = 'Large image (over Claude limits: others get original, Claude text note)';
      }

      const estimatedTokens = estimateClientAttachmentTokens({
        isEmpty,
        isImage,
        isPdf,
        pageCount,
        size: effectiveSize,
        textContent,
      });

      const attObj = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || 'attachment',
        mimeType: mimeType || 'application/octet-stream',
        size: effectiveSize,
        isEmpty,
        pageCount,
        warning,
        optBadge,
        sha1: null,
        cached: false,
        estimatedTokens,
        data: base64Data,
        textContent: textContent || '',
        previewUrl: isImage ? dataUrl : null,
      };
      if (claudeCopy) {
        attObj.claudeDataBase64 = claudeCopy.base64;
        attObj.claudeMimeType = claudeCopy.mimeType;
      }
      if (fitCopy) {
        attObj.fitDataBase64 = fitCopy.base64;
        attObj.fitMimeType = fitCopy.mimeType;
      }
      CUSTOM_ATTACHMENTS.push(attObj);
      if (sizeNote) setSizeWarning(attObj.id, sizeNote.text, sizeNote.isError);
      // Immediately inspect & cache on server so exact extracted tokens and SHA-1 are ready before Run
      inspectAttachmentOnServer(attObj);
    } catch (e) {
      console.error('Failed reading attachment:', e);
    }
  }
  renderAttachments();
  renderTaskMeta();
}

function removeAttachment(id) {
  CUSTOM_ATTACHMENTS = CUSTOM_ATTACHMENTS.filter((a) => a.id !== id);
  SIZE_WARNINGS.delete(id);
  renderSizeWarnings();
  renderAttachments();
  renderTaskMeta();
}

function clearAttachments() {
  CUSTOM_ATTACHMENTS = [];
  SIZE_WARNINGS.clear();
  renderSizeWarnings();
  const inp = $('#customFileInput');
  if (inp) inp.value = '';
  renderAttachments();
  renderTaskMeta();
}

function renderContextMeter() {
  const meterEl = $('#contextMeterBar');
  const sel = $('#taskSelect');
  if (!meterEl || !sel || sel.value !== 'custom') {
    if (meterEl) meterEl.classList.add('hidden');
    return;
  }
  const promptText = ($('#customPrompt') && $('#customPrompt').value) || '';
  const promptTok = Math.ceil(promptText.length / 3.8) + (CUSTOM_ATTACHMENTS.length || promptText.trim() ? 60 : 0);
  const attTok = CUSTOM_ATTACHMENTS.reduce((sum, a) => sum + (a.estimatedTokens || 100), 0);
  const totalEstTok = promptTok + attTok;

  if (!CUSTOM_ATTACHMENTS.length && promptText.length < 200) {
    meterEl.classList.add('hidden');
    return;
  }
  meterEl.classList.remove('hidden');

  const activeModels = (MODELS && MODELS.length ? MODELS : []).map((m) => {
    const cat = catalog().find((x) => x.id === (m.catalogId || m.id || m.model));
    const ctx = (m && m.context) || (cat && cat.context) || 128000;
    const reservedOut = Math.min(32000, Math.max(8192, Math.floor(ctx * 0.20)));
    const safeInputLimit = Math.max(4000, ctx - reservedOut);
    const ratio = totalEstTok / safeInputLimit;
    return {
      slot: m.slot,
      label: m.label,
      ctx,
      safeInputLimit,
      ratio,
      status: ratio > 1 ? 'over' : (ratio > 0.68 ? 'warn' : 'ok'),
    };
  });

  const worstRatio = activeModels.reduce((mx, m) => Math.max(mx, m.ratio || 0), 0);
  const barPct = Math.min(100, Math.max(2, Math.round(worstRatio * 100)));
  const barCls = worstRatio > 1 ? 'is-over' : (worstRatio > 0.68 ? 'is-warn' : '');
  const anyOver = activeModels.some((m) => m.status === 'over');

  const pillsHtml = activeModels.map((m) => {
    const ctxLabel = m.ctx >= 1000000 ? `${(m.ctx / 1000000).toFixed(0)}M` : `${Math.round(m.ctx / 1000)}K`;
    const pct = Math.round(m.ratio * 100);
    const icon = m.status === 'over' ? '⚠' : (m.status === 'warn' ? '◐' : '✓');
    const note = m.status === 'over' ? `${pct}% · auto head+tail fit` : `${pct}% of ${ctxLabel}`;
    return `<span class="cm-pill is-${m.status}" title="Slot ${esc(m.slot)}: ${esc(m.label)} (${ctxLabel} context window, ~${Math.round(m.safeInputLimit / 1000)}K safe input budget)">${icon} <b>${esc(m.label)}</b>: ${note}</span>`;
  }).join('');

  meterEl.innerHTML =
    `<div class="cm-top">` +
      `<span class="cm-title">📐 Context Window &amp; Token Budget Check</span>` +
      `<span class="cm-summary">Est. input: <b>~${fmtTokensShort(totalEstTok)}</b> (${fmtTokensShort(promptTok)} prompt + ${fmtTokensShort(attTok)} attachments)${anyOver ? ' · <b>Smart Head+Tail Guardrail Active</b>' : ''}</span>` +
    `</div>` +
    `<div class="cm-bar-track"><div class="cm-bar-fill ${barCls}" style="width:${barPct}%"></div></div>` +
    `<div class="cm-models">${pillsHtml}</div>`;
}

function renderAttachments() {
  const listEl = $('#attachmentList');
  const badgeEl = $('#attachCountBadge');
  const clearBtn = $('#clearAttachmentsBtn');
  if (!listEl || !badgeEl) return;

  const count = CUSTOM_ATTACHMENTS.length;
  const totalBytes = CUSTOM_ATTACHMENTS.reduce((acc, a) => acc + (a.size || 0), 0);
  const totalTok = CUSTOM_ATTACHMENTS.reduce((acc, a) => acc + (a.estimatedTokens || 0), 0);
  if (count === 0) {
    badgeEl.textContent = 'No files attached';
    badgeEl.classList.remove('has-files');
    if (clearBtn) clearBtn.classList.add('hidden');
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    renderContextMeter();
    return;
  }

  badgeEl.textContent = `${count} file${count > 1 ? 's' : ''} · ${formatBytes(totalBytes)} · ~${fmtTokensShort(totalTok)}`;
  badgeEl.classList.add('has-files');
  if (clearBtn) clearBtn.classList.remove('hidden');
  listEl.classList.remove('hidden');

  listEl.innerHTML = CUSTOM_ATTACHMENTS.map((a) => {
    const b = attachmentBadgeInfo(a.name, a.mimeType);
    const visual = a.previewUrl
      ? `<img class="ca-thumb" src="${esc(a.previewUrl)}" alt="${esc(a.name)}" />`
      : `<div class="ca-type-icon ${b.cls}">${esc(b.label)}</div>`;
    const metaParts = [formatBytes(a.size)];
    if (a.pageCount) metaParts.push(`${a.pageCount}p`);
    if (a.estimatedTokens) metaParts.push(`~${fmtTokensShort(a.estimatedTokens)}`);
    if (a.cached) metaParts.push('⚡ Cached');
    const optHtml = a.optBadge ? `<span class="ca-opt-badge" title="${esc(a.optBadge)}">✓ ${esc(a.optBadge)}</span>` : '';
    const warnHtml = a.warning ? `<span class="ca-warn-tag" title="${esc(a.warning)}">⚠ ${esc(a.warning)}</span>` : '';
    return (
      `<div class="ca-item" title="${esc(a.name)} (${esc(a.mimeType || 'file')} · ${metaParts.join(' · ')})">` +
        visual +
        `<div class="ca-info">` +
          `<span class="ca-name">${esc(a.name)}</span>` +
          `<span class="ca-meta">${esc(metaParts.join(' · '))}</span>` +
          optHtml +
          warnHtml +
        `</div>` +
        `<button type="button" class="ca-remove" data-att-id="${esc(a.id)}" title="Remove ${esc(a.name)}">✕</button>` +
      `</div>`
    );
  }).join('');
  renderContextMeter();
}

function currentAttachmentsPayload() {
  const sel = $('#taskSelect');
  if (!sel || sel.value !== 'custom' || !CUSTOM_ATTACHMENTS.length) return undefined;
  return CUSTOM_ATTACHMENTS.map((a) => {
    if (a.cached && (a.sha256 || a.sha1)) {
      return {
        sha256: a.sha256 || undefined,
        sha1: a.sha1,
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
      };
    }
    return {
      name: a.name,
      mimeType: a.mimeType,
      size: a.size,
      data: a.data,
      textContent: a.textContent || undefined,
      // Full (non-cached / 409 re-upload) payloads carry the Claude copy too, so it
      // survives cache eviction. Cached refs don't: the server cache already has it.
      claudeDataBase64: a.claudeDataBase64 || undefined,
      claudeMimeType: a.claudeDataBase64 ? a.claudeMimeType : undefined,
      // The OpenAI fit copy too, when it still fits under the request cap.
      ...(a.fitDataBase64 && ((a.data || '').length + (a.claudeDataBase64 || '').length + a.fitDataBase64.length) <= INSPECT_BUDGET_CHARS
        ? { fitDataBase64: a.fitDataBase64, fitMimeType: a.fitMimeType } : {}),
    };
  });
}

// The server answers 409 ATTACHMENT_EXPIRED when a cached-by-hash attachment has
// been evicted (or the instance restarted). Drop the "cached" flag on those files
// so the next payload carries the full bytes again. Returns false (and the caller
// shows the server's "please re-attach" message) if a file's bytes aren't held
// locally any more — we never send an empty file in its place.
function markAttachmentsExpired(info) {
  const expired = (info && Array.isArray(info.expired)) ? info.expired : [];
  const hit = (a) => !expired.length || expired.some((e) =>
    (e.sha256 && e.sha256 === a.sha256) || (e.sha1 && e.sha1 === a.sha1) || e.name === a.name);
  let reuploadable = true;
  CUSTOM_ATTACHMENTS.forEach((a) => {
    if (!a.cached || !hit(a)) return;
    a.cached = false;
    if (!a.data && !a.textContent) reuploadable = false;
  });
  renderAttachments();
  return reuploadable;
}

function initAttachmentsUI() {
  const btn = $('#attachFilesBtn');
  const inp = $('#customFileInput');
  const clearBtn = $('#clearAttachmentsBtn');
  const dz = $('#customDropzone');
  const listEl = $('#attachmentList');
  const ta = $('#customPrompt');
  const copyBtn = $('#copyPromptBtn');

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const isCustom = $('#taskSelect') && $('#taskSelect').value === 'custom';
      const rawText = isCustom
        ? (($('#customPrompt') && $('#customPrompt').value) || '')
        : (($('#taskPrompt') && $('#taskPrompt').textContent) || '');
      const textToCopy = String(rawText || '').trim();
      if (!textToCopy) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(textToCopy);
        } else {
          const tmp = document.createElement('textarea');
          tmp.value = textToCopy;
          tmp.style.position = 'fixed';
          tmp.style.opacity = '0';
          document.body.appendChild(tmp);
          tmp.select();
          document.execCommand('copy');
          document.body.removeChild(tmp);
        }
        const lbl = copyBtn.querySelector('.copy-lbl');
        copyBtn.classList.add('is-copied');
        if (lbl) lbl.textContent = '✓ Copied';
        clearTimeout(copyBtn._copyTimer);
        copyBtn._copyTimer = setTimeout(() => {
          copyBtn.classList.remove('is-copied');
          if (lbl) lbl.textContent = 'Copy prompt';
        }, 1500);
      } catch (err) {
        console.error('Copy prompt failed:', err);
      }
    });
  }

  if (btn && inp) {
    btn.addEventListener('click', () => inp.click());
    inp.addEventListener('change', () => {
      if (inp.files && inp.files.length) addAttachmentFiles(inp.files);
      inp.value = '';
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', clearAttachments);
  }
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const rm = e.target.closest('.ca-remove');
      if (rm && rm.dataset.attId) removeAttachment(rm.dataset.attId);
    });
  }
  [dz, ta].forEach((target) => {
    if (!target) return;
    target.addEventListener('dragover', (e) => {
      if ($('#taskSelect').value !== 'custom') return;
      e.preventDefault();
      if (dz) dz.classList.add('drag-over');
    });
    target.addEventListener('dragleave', (e) => {
      if (dz && !dz.contains(e.relatedTarget)) dz.classList.remove('drag-over');
    });
    target.addEventListener('drop', (e) => {
      if ($('#taskSelect').value !== 'custom') return;
      if (dz) dz.classList.remove('drag-over');
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        e.preventDefault();
        addAttachmentFiles(dt.files);
      }
    });
  });
  if (ta) {
    ta.addEventListener('input', () => renderContextMeter());
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        const runBtn = $('#runBtn');
        if (runBtn && !runBtn.disabled) {
          e.preventDefault();
          run();
        }
      }
    });
    ta.addEventListener('paste', (e) => {
      if ($('#taskSelect').value !== 'custom') return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const pastedFiles = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) pastedFiles.push(f);
        }
      }
      if (pastedFiles.length) {
        addAttachmentFiles(pastedFiles);
      }
    });
  }
  renderAttachments();
}

function renderTaskMeta() {
  const t = currentTask();
  const meta = $('#taskMeta');
  if (!meta) return;
  const catKey = t.category || 'general';
  const catLabel = ({ coding: 'Coding', games: 'Games', business: 'Business', general: 'General' })[catKey] || 'General';
  const bits = [catLabel];
  if (t.language) bits.push(t.language);
  if (t.testCount) bits.push(`${t.testCount} hidden tests`);
  if (t.executable) bits.push('runnable \u25b8');
  if (t.id === 'custom' && CUSTOM_ATTACHMENTS.length) {
    bits.push(`${CUSTOM_ATTACHMENTS.length} attachment${CUSTOM_ATTACHMENTS.length > 1 ? 's' : ''}`);
  }
  meta.textContent = bits.join(' \u00b7 ');
  meta.className = 'task-meta is-' + catKey;
}
function renderTaskPrompt() {
  const ta = $('#customPrompt');
  const attWrap = $('#customAttachmentsWrap');
  if ($('#taskSelect').value === 'custom') {
    $('#taskPrompt').textContent = 'Your prompt and any uploaded attachments (images, PDFs, CSV, code, docs) are sent to every model slot in parallel. No automated tests run \u2014 you get live output, tokens, cost, speed and thinking.';
    ta.classList.remove('hidden');
    if (attWrap) attWrap.classList.remove('hidden');
  } else {
    $('#taskPrompt').textContent = currentTask().prompt;
    ta.classList.add('hidden');
    if (attWrap) attWrap.classList.add('hidden');
  }
  renderTaskMeta();
}

function priceTag(c) { return `$${(+c.price.input).toFixed(2)} / $${(+c.price.output).toFixed(2)}`; }

function thinkTag(t) {
  if (!t || !t.label) return '';
  return `<div class="col-think think-${esc(t.mode || 'unknown')}" title="${esc(t.detail || '')}">`
       + `<span class="ti">◈</span>${esc(t.label)}</div>`;
}

// Build the HTML for the 3rd dropdown ("Thinking Mode") for a given catalog model & slot
function buildThinkingDropdownOptions(c, currentEffort) {
  if (!c) return '<option value="">high (default)</option>';
  const o = c.thinkingOptions;
  if (o && o.configurable && Array.isArray(o.options) && o.options.length) {
    const cur = currentEffort || o.defaultValue || '';
    return o.options.map((x) => {
      const isSelected = cur ? x.value === cur : !!x.isDefault;
      return `<option value="effort:${esc(x.value)}"${isSelected ? ' selected' : ''}>${esc(x.label)}</option>`;
    }).join('');
  }
  // Check if this model belongs to a Reasoning <-> Non-Reasoning sibling pair
  const siblings = REASONING_SIBLING_PAIRS[c.id];
  if (siblings && siblings.length) {
    return siblings.map((s, idx) => {
      const lbl = idx === 0 && !/\(default\)/i.test(s.label) ? `${s.label} (default)` : s.label;
      return `<option value="model:${esc(s.id)}"${s.id === c.id ? ' selected' : ''}>${esc(lbl)}</option>`;
    }).join('');
  }
  const fixedLabel = (c.thinking && c.thinking.label)
    ? `${c.thinking.label} (default)`
    : (c.thinkingMode === 'reasoning' ? 'Reasoning (default)' : 'Standard (default)');
  return `<option value="fixed" selected>${esc(fixedLabel)}</option>`;
}

function thinkControl(m, isRestore) {
  if (isRestore) return thinkTag(m.thinking);
  const c = catalog().find((x) => x.id === m.catalogId) || m;
  const opts = buildThinkingDropdownOptions(c, m.effort);
  const cur = m.effort || '';
  const o = m.thinkingOptions;
  const sel = (o && o.options && o.options.find((x) => x.value === cur)) || (o && o.options && o.options[0]);
  return `<div class="col-think think-ctl${cur ? ' is-set' : ''}" title="${esc((sel && sel.detail) || (m.thinking && m.thinking.detail) || '')}">`
       + `<span class="ti">◈</span>`
       + `<select class="think-select" draggable="false" data-slot="${esc(m.slot)}" `
       + `aria-label="Thinking mode for ${esc(m.label)}">${opts}</select></div>`;
}

// Clean Read-Only Model Identity Header inside each Arena Executor Card
// (The 3-dropdown selector lives exclusively in the top Model Selector strip)
function buildInlineCardCascader(m, isRestore) {
  if (isRestore) {
    return `<div class="col-id">
      <div class="col-title">${esc(m.label)}${m.external ? '<span class="ext-badge">EXT</span>' : ''}</div>
      <div class="col-sub">${esc(m.provider)} · ${esc(m.model)}${m.price ? ` <span class="col-price">${priceTag(m)} / 1M</span>` : ''}</div>
      ${thinkTag(m.thinking)}
    </div>`;
  }
  return `<div class="col-id col-cascader" data-slot="${esc(m.slot)}">
    <div class="col-title-row">
      <span class="col-slot-pill" style="background:${slotColor(m.slot)}22;color:${slotColor(m.slot)};border-color:${slotColor(m.slot)}55">Slot ${esc(m.slot)}</span>
      <span class="col-title">${esc(m.label)}</span>
      ${m.external ? '<span class="ext-badge" title="External API Key">EXT</span>' : '<span class="vtx-badge" title="Google Cloud Vertex AI / Agent Platform">VERTEX AI</span>'}
    </div>
    <div class="col-sub-row">
      ${m.price ? `<span class="col-price">${priceTag(m)} / 1M</span>` : ''}
      ${thinkTag(m.thinking)}
    </div>
  </div>`;
}

function modelAvailability(c) {
  if (c.blocked) return { ok: false, blocked: true, need: c.blocked, how: c.blockedHow || 'Google Cloud console' };
  return { ok: true };
}
function extBadge(c) { return c.external ? '<span class="ext-badge" title="Not on Vertex — needs its own API key; the prompt leaves Google infrastructure">EXT</span>' : ''; }

// Wire up cascading events on any container holding .slot-provider-select / .slot-model-select / .slot-think-select
function bindCascadingSelects(root) {
  if (!root) return;
  root.querySelectorAll('.slot-provider-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const slot = sel.dataset.slot;
      const fam = sel.value;
      const firstModel = catalog().find((x) => providerFamilyOf(x) === fam && modelAvailability(x).ok);
      if (firstModel) {
        SLOT_ASSIGN[slot] = firstModel.id;
        SLOT_EFFORT[slot] = null;
        afterSlotChange();
      }
    });
  });
  root.querySelectorAll('.slot-model-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const slot = sel.dataset.slot;
      const newId = sel.value;
      assignToSlot(newId, slot);
    });
  });
  root.querySelectorAll('.slot-think-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const slot = sel.dataset.slot;
      const val = sel.value || '';
      if (val.startsWith('model:')) {
        const siblingId = val.slice('model:'.length);
        assignToSlot(siblingId, slot, null);
      } else if (val.startsWith('effort:')) {
        const eff = val.slice('effort:'.length);
        SLOT_EFFORT[slot] = eff || null;
        afterSlotChange();
      }
    });
  });
}

let _toolbarBound = false;
function renderModelEditors() {
  // Bind toolbar buttons once
  if (!_toolbarBound) {
    _toolbarBound = true;
    const addBtn = $('#addSlotBtn');
    if (addBtn) addBtn.addEventListener('click', addSlot);
    document.querySelectorAll('.mc-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
    });
  }
  const badge = $('#slotCountBadge');
  if (badge) badge.textContent = `${SLOT_IDS.length} of ${MAX_SLOTS} slots active`;
  const addBtn = $('#addSlotBtn');
  if (addBtn) {
    addBtn.disabled = SLOT_IDS.length >= MAX_SLOTS;
    addBtn.textContent = SLOT_IDS.length >= MAX_SLOTS ? 'Max 6 Slots Active' : `+ Add Model Slot (${SLOT_IDS.length}/${MAX_SLOTS})`;
  }

  const grid = $('#slotConfiguratorGrid');
  if (!grid) return;
  grid.innerHTML = '';
  grid.dataset.slotCount = String(SLOT_IDS.length);
  grid.style.setProperty('--slot-count', String(Math.max(1, SLOT_IDS.length)));

  SLOT_IDS.forEach((slot) => {
    const cid = SLOT_ASSIGN[slot];
    const c = catalog().find((x) => x.id === cid) || catalog()[0];
    if (!c) return;
    const curFamily = providerFamilyOf(c);
    const curEffort = SLOT_EFFORT[slot] || '';

    const familyOptions = PROVIDER_FAMILIES.map((pf) => {
      const runnableCount = catalog().filter((x) => providerFamilyOf(x) === pf.id && modelAvailability(x).ok).length;
      const totalCount = catalog().filter((x) => providerFamilyOf(x) === pf.id).length;
      if (!totalCount) return '';
      return `<option value="${esc(pf.id)}"${pf.id === curFamily ? ' selected' : ''}${!runnableCount ? ' disabled' : ''}>${esc(pf.label)} (${runnableCount} active)</option>`;
    }).join('');

    const modelsInFamily = catalog().filter((x) => providerFamilyOf(x) === curFamily);
    const modelOptions = modelsInFamily.map((mc) => {
      const av = modelAvailability(mc);
      const tag = !av.ok ? (av.blocked ? ' — 🚫 Quota Required' : ' — 🔒 API Key Needed') : ` — ${priceTag(mc)}/1M`;
      return `<option value="${esc(mc.id)}"${mc.id === c.id ? ' selected' : ''}${!av.ok ? ' disabled' : ''}>${esc(mc.label)}${esc(tag)}</option>`;
    }).join('');

    const thinkOptions = buildThinkingDropdownOptions(c, curEffort);

    const card = el('div', 'slot-cfg-card');
    card.style.setProperty('--slot-accent', slotColor(slot));
    card.innerHTML = `
      <div class="scc-head">
        <span class="scc-slot-badge" style="background:${slotColor(slot)}">Slot ${esc(slot)}</span>
        <span class="scc-ic">${modelIconSvg(c)}</span>
        <strong class="scc-name">${esc(c.label)}</strong>
        ${c.external ? '<span class="ext-badge">EXT</span>' : '<span class="vtx-badge">VERTEX AI</span>'}
        <span class="scc-price">${priceTag(c)} / 1M</span>
        ${SLOT_IDS.length > MIN_SLOTS ? `<button type="button" class="scc-remove" data-slot="${esc(slot)}" title="Remove Slot ${esc(slot)}">&times;</button>` : ''}
      </div>
      <div class="scc-dropdowns">
        <div class="scc-field">
          <label>1. Provider</label>
          <select class="slot-provider-select" data-slot="${esc(slot)}">${familyOptions}</select>
        </div>
        <div class="scc-field">
          <label>2. Model</label>
          <select class="slot-model-select" data-slot="${esc(slot)}">${modelOptions}</select>
        </div>
        <div class="scc-field">
          <label>3. Thinking Mode</label>
          <select class="slot-think-select" data-slot="${esc(slot)}">${thinkOptions}</select>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });

  bindCascadingSelects(grid);
  grid.querySelectorAll('.scc-remove').forEach((btn) => {
    btn.addEventListener('click', () => clearSlot(btn.dataset.slot));
  });
}

// ---------- arena scaffolding ----------
function buildArena(models) {
  const arena = $('#arena');
  arena.innerHTML = '';
  const task = currentTask();
  ARENA_MODELS = (models || MODELS).slice();
  const isRestore = !!models;
  const cells = isRestore
    ? ARENA_MODELS.map((m) => ({ slot: m.slot, m }))
    : SLOT_IDS.map((slot) => ({ slot, m: ARENA_MODELS.find((x) => x.slot === slot) || null }));

  arena.style.setProperty('--slot-count', String(Math.max(1, cells.length)));

  cells.forEach(({ slot: cellSlot, m }) => {
    if (!m) return;
    const col = el('div', 'col');
    col.dataset.slot = m.slot;
    col.id = `col-${m.slot}`;
    col.style.setProperty('--accent', slotColor(m.slot));
    col.innerHTML = `
      <div class="col-head">
        <span class="col-accent" style="background:${slotColor(m.slot)}"></span>
        <span class="col-ic">${modelIconSvg(m)}</span>
        ${buildInlineCardCascader(m, isRestore)}
        <button class="rerun-btn" type="button" data-slot="${m.slot}" disabled
          title="Re-run just this model on the current task — the other columns are left alone">↻ Run again</button>
        ${(!isRestore && SLOT_IDS.length > MIN_SLOTS) ? `<button class="col-remove" type="button" data-slot="${m.slot}" title="Remove Slot ${m.slot}">&times;</button>` : ''}
      </div>
      <div class="col-status" id="status-${m.slot}"><span>Idle — press Run.</span></div>
      <div class="col-ctx-warn hidden" id="ctx-warn-${m.slot}"></div>
      <div class="col-att-note hidden" id="att-note-${m.slot}"></div>
      <div class="progress">
        <div class="progress-track"><div class="progress-fill" id="pf-${m.slot}"></div></div>
        <div class="progress-label"><span id="pl-${m.slot}">0 / ${currentTask().testCount} tests</span><span id="ph-${m.slot}"></span></div>
      </div>
      <details class="think" id="thinkbox-${m.slot}" open>
        <summary>Thinking / reasoning <span class="think-meta" id="think-meta-${m.slot}"></span><button class="md-magnify think-magnify" data-slot="${m.slot}" data-kind="think" type="button" title="Open full-page preview">${MAGNIFY_SVG}</button></summary>
        <pre class="think-pre"><code id="think-${m.slot}">—</code></pre>
      </details>
      <div class="code-wrap"><button class="md-magnify" data-slot="${m.slot}" data-kind="code" type="button" title="Open full-page preview">${MAGNIFY_SVG}</button><pre><code id="code-${m.slot}">// generated solution will appear here</code></pre></div>
      ${task.executable ? `
      <div class="exec">
        <button class="exec-btn" data-slot="${m.slot}" type="button" disabled title="Run the generated program (${esc(task.language)})">▸ Run code</button>
        <div class="exec-viz hidden" id="exec-viz-${m.slot}"></div>
        <pre class="exec-out hidden" id="exec-out-${m.slot}"><code></code></pre>
      </div>` : ''}
      <div class="metrics" id="metrics-${m.slot}">
        <div class="metric" id="m-tok-${m.slot}"><div class="k">Output tokens (answer)</div><div class="v">0</div></div>
        <div class="metric" id="m-think-${m.slot}"><div class="k">Thinking tokens</div><div class="v">0</div></div>
        <div class="metric" id="m-tps-${m.slot}"><div class="k">Tokens / sec (live)</div><div class="v">0</div></div>
        <div class="metric" id="m-cost-${m.slot}"><div class="k">Cost</div><div class="v">$0</div></div>
        <div class="metric metric-wide" id="m-time-${m.slot}"><div class="k">Wall time</div><div class="v">0.0s</div></div>
      </div>`;
    arena.appendChild(col);
  });

  arena.querySelectorAll('.exec-btn').forEach((b) =>
    b.addEventListener('click', () => execSlotCode(b.dataset.slot)));
  arena.querySelectorAll('.rerun-btn').forEach((b) =>
    b.addEventListener('click', () => rerunSlot(b.dataset.slot)));
  arena.querySelectorAll('.md-magnify').forEach((b) =>
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openMagnify(b.dataset.slot, b.dataset.kind); }));

  if (isRestore) return;

  bindCascadingSelects(arena);
  arena.querySelectorAll('.col-remove').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); clearSlot(e.currentTarget.dataset.slot); }));
}

// ---------- LLM-as-judge (ungraded tasks) -----------------------------------
// Business and general tasks ship no hidden tests, so a run gives no quality
// signal at all. This scores the answers themselves. Blinding and shuffling
// happen on the server (src/judge.js); the UI's job is to make the setup
// legible — who is judging, and that they judged blind.
let _judgeScored = null;

function judgeableEntries() {
  return (ARENA_MODELS || MODELS)
    .map((m) => ({ slot: m.slot, label: m.label, text: (LAST_RESULTS[m.slot] || {}).code || '' }))
    .filter((e) => e.text.trim());
}

function setupJudgePanel(scored, isCustom) {
  const panel = $('#judgePanel');
  if (!panel) return;
  // Only worth offering where there is no correctness number already.
  const entries = judgeableEntries();
  if (!isCustom || entries.length < 2) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const sel = $('#judgeModel');
  const contestants = new Set(entries.map((e) => e.label));
  const usable = catalog().filter((c) => modelAvailability(c).ok);
  if (sel && !sel.options.length) {
    sel.innerHTML = usable.map((c) =>
      `<option value="${esc(c.id)}">${esc(c.label)}${contestants.has(c.label) ? ' — also competing' : ''}</option>`).join('');
    // Prefer a judge that is NOT one of the models being judged.
    const neutral = usable.find((c) => !contestants.has(c.label));
    if (neutral) sel.value = neutral.id;
  }
  paintJudgeWarning(contestants);
  if (sel && !sel._wired) {
    sel._wired = true;
    sel.addEventListener('change', () => paintJudgeWarning(new Set(judgeableEntries().map((e) => e.label))));
  }
  const btn = $('#judgeBtn');
  if (btn && !btn._wired) { btn._wired = true; btn.addEventListener('click', runJudge); }
}

function paintJudgeWarning(contestants) {
  const warn = $('#judgeWarn');
  const sel = $('#judgeModel');
  if (!warn || !sel) return;
  const c = catalog().find((x) => x.id === sel.value);
  const selfJudging = c && contestants.has(c.label);
  warn.classList.toggle('hidden', !selfJudging);
  if (selfJudging) {
    warn.textContent = `⚠ ${c.label} is scoring a set of answers that includes its own. Models tend to favour their own output, so pick a judge that is not competing if you want this to hold up.`;
  }
}

async function runJudge() {
  const btn = $('#judgeBtn');
  const out = $('#judgeOut');
  const entries = judgeableEntries();
  if (entries.length < 2 || !out) return;
  const judgeId = $('#judgeModel').value;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Scoring…';
  out.innerHTML = '<p class="jp-status">The judge is reading all answers…</p>';
  try {
    const judgeBody = () => JSON.stringify({
      taskId: currentTask().id,
      prompt: $('#customPrompt').value,
      attachments: currentAttachmentsPayload(),
      judge: judgeId,
      entries,
      keys: loadKeys(),
    });
    const postJudge = () => fetch('/api/judge', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: judgeBody(),
    });
    let resp = await postJudge();
    if (resp.status === 401) { window.location.replace('/login'); return; }
    if (resp.status === 409) {
      // Cached attachment expired server-side: re-upload the full files once.
      const j = await resp.clone().json().catch(() => ({}));
      if (j && j.code === 'ATTACHMENT_EXPIRED' && markAttachmentsExpired(j)) resp = await postJudge();
    }
    const r = await resp.json();
    if (!resp.ok || !r.ok) throw new Error(r.error || 'Judging failed.');
    _judgeScored = r;
    renderJudge(r);
  } catch (e) {
    out.innerHTML = `<p class="jp-status jp-err">⚠ ${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

function renderJudge(r) {
  const out = $('#judgeOut');
  if (!out) return;
  const ranked = r.results.slice().sort((a, b) => (b.overall || 0) - (a.overall || 0));
  const best = ranked.length ? ranked[0].overall : 0;
  const rows = ranked.map((res) => {
    const cells = r.criteria.map((c) => {
      const v = res.scores[c.key];
      return `<td class="jr-score"><span class="jr-bar" style="width:${v ? v * 10 : 0}%"></span><b>${v == null ? '—' : v}</b></td>`;
    }).join('');
    const win = res.slot === r.winnerSlot;
    return `<tr class="${win ? 'jr-win' : ''}" style="--accent:${slotColor(res.slot)}">` +
      `<td class="jr-name"><span class="jr-dot"></span>${esc(res.label)}` +
      `${win ? '<span class="jr-badge">judge’s pick</span>' : ''}` +
      `<span class="jr-blind">seen as ${esc(res.blindId)}</span></td>` +
      `<td class="jr-overall"><b>${res.overall == null ? '—' : res.overall}</b><i>/10</i></td>` +
      cells +
      `<td class="jr-note">${esc(res.note)}</td></tr>`;
  }).join('');
  const heads = r.criteria.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const sent = r.charsSent ? ` · ${fmtInt(r.charsSent)} chars sent in full` : '';
  const trim = r.truncated
    ? `<p class="jp-warn">⚠ The combined answers exceeded the transport budget, so the longest were shortened. The judge was told which ones and instructed not to penalise them for it — but scores here are less reliable than on a run that fits.</p>`
    : '';
  out.innerHTML =
    `<div class="jp-meta">Judged by <b>${esc(r.judge.label)}</b> · ${esc(r.judge.model)} · blind order ${esc(r.blindOrder.map((s) => s.split('=')[0]).join(' → '))}${sent}</div>` +
    trim +
    `<div class="table-wrap"><table class="judge-table"><thead><tr><th>Model</th><th>Overall</th>${heads}<th>Judge’s comment</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    (r.why ? `<p class="jp-why"><b>Why:</b> ${esc(r.why)}</p>` : '') +
    `<p class="jp-fine">Scores are one model’s opinion, not a measurement. ${best ? '' : ''}The judge saw the answers in a shuffled order with all model names removed.</p>`;
}

// ---------- crash detection & repair ----------------------------------------
// A slot's code can fail in four ways we can actually observe: the WASM build
// rejects it, the program exits non-zero / times out, the game page reports a
// traceback or JS error, or the game never initialises its canvas. Any of those
// parks a record here; the card then offers a repair round, which auto-fires
// once per slot per run when the toggle is on.
const CRASH = {};          // slot -> { error, code, source }
const AUTOFIXED = {};      // slot -> true once a repair has been spent

function autoFixOn() { const b = $('#autoFix'); return !!(b && b.classList.contains('is-on')); }

function slotCode(slot) {
  let code = (($(`#code-${slot}`) || {}).textContent) || '';
  const fence = code.match(/```[a-zA-Z0-9+#.-]*[ \t]*\r?\n?([\s\S]*?)```/);
  return (fence ? fence[1] : code).trim();
}

// Decide whether an /api/execute result represents a real failure. A GUI task
// hitting the time limit is NOT a crash — that's just a game loop running.
function crashFromExec(r, task) {
  if (!r || r.error) return r && r.error ? { error: r.error, source: 'run' } : null;
  if (r.kind === 'tests') {
    return r.passed === r.total ? null
      : { error: formatTestResult(r), source: 'tests' };
  }
  if (r.kind === 'launched') return r.launched ? null : { error: r.message || 'The program exited immediately.', source: 'launch' };
  if (r.kind === 'program') {
    const trace = /Traceback \(most recent call last\)|SyntaxError|IndentationError/.test(r.stderr || '');
    if (trace || (r.exitCode != null && r.exitCode !== 0)) {
      return { error: (r.stderr || '').trim() || `The program exited with code ${r.exitCode}.`, source: 'run' };
    }
    if (r.timedOut && !(task && task.gui)) {
      return { error: 'The program hit the time limit without finishing. It may be stuck in an infinite loop.', source: 'timeout' };
    }
  }
  return null;
}

// Record a crash for a slot and surface the offer. Auto-repair fires at most
// once per slot per run so a model that keeps crashing can't loop or run up cost.
function noteCrash(slot, crash) {
  if (!crash || !crash.error) return;
  const code = slotCode(slot);
  if (!code) return;                       // nothing to repair
  CRASH[slot] = { error: crash.error, code, source: crash.source || 'run' };
  renderCrashBar(slot);
  if (autoFixOn() && !AUTOFIXED[slot] && !slotIsRunning(slot)) {
    AUTOFIXED[slot] = true;
    repairSlot(slot, true);
  }
}
function clearCrash(slot) {
  delete CRASH[slot];
  const bar = $(`#crash-${slot}`);
  if (bar) bar.remove();
}

function renderCrashBar(slot) {
  const c = CRASH[slot];
  const host = $(`#exec-out-${slot}`);
  if (!c || !host || !host.parentNode) return;
  let bar = $(`#crash-${slot}`);
  if (!bar) {
    bar = el('div');
    bar.className = 'crash-bar';
    bar.id = `crash-${slot}`;
    host.parentNode.insertBefore(bar, host);
  }
  const what = { tests: 'failed its hidden tests', nostart: 'never started',
                 timeout: 'never finished', python: 'crashed', js: 'crashed',
                 build: 'failed to build', launch: 'exited immediately' }[c.source] || 'crashed';
  bar.innerHTML =
    `<span class="cb-ic">⚠</span><span class="cb-txt">This code ${esc(what)}.</span>` +
    `<button type="button" class="cb-fix" data-slot="${esc(slot)}">🔧 Fix it</button>` +
    `<button type="button" class="cb-dismiss" data-slot="${esc(slot)}" title="Dismiss">&times;</button>`;
  bar.querySelector('.cb-fix').addEventListener('click', () => repairSlot(slot, false));
  bar.querySelector('.cb-dismiss').addEventListener('click', () => clearCrash(slot));
}

// One repair round: hand the model back its own code plus the real failure and
// re-render the column from its corrected answer. Reuses the single-slot re-run
// path, so streaming, quota, abort and history all behave identically.
async function repairSlot(slot, automatic) {
  const c = CRASH[slot];
  if (!c) return;
  const bar = $(`#crash-${slot}`);
  if (bar) {
    bar.classList.add('is-fixing');
    bar.innerHTML = `<span class="cb-ic">🔧</span><span class="cb-txt">${automatic ? 'Auto-fixing' : 'Fixing'} — sending the failure back to this model…</span>`;
  }
  clearCrash(slot);
  await rerunSlot(slot, { code: c.code, error: c.error });
}

// The framed game page posts its own failures up to us. Match the reporting
// window back to a slot by comparing it with each column's iframe.
window.addEventListener('message', (e) => {
  const d = e && e.data;
  if (!d || d.__ullm !== 'game-error' || e.origin !== window.location.origin) return;
  const frames = document.querySelectorAll('.game-frame');
  for (const f of frames) {
    if (f.contentWindow === e.source) {
      const slot = (f.closest('.col') || {}).dataset && f.closest('.col').dataset.slot;
      if (slot) noteCrash(slot, { error: d.message, source: d.kind });
      return;
    }
  }
});

// ---------- execute generated code (Python) from the UI ----------
async function execSlotCode(slot) {
  const task = currentTask();
  let code = ($(`#code-${slot}`) || {}).textContent || '';
  // Defensive: strip a stray markdown code fence if one slipped through.
  const fence = code.match(/```[a-zA-Z0-9+#.-]*[ \t]*\r?\n?([\s\S]*?)```/);
  if (fence) code = fence[1].trim();
  // GUI launch: window title = model name; position = same side of the screen as the model's column.
  const idx = Math.max(MODELS.findIndex((m) => m.slot === slot), 0);
  const count = MODELS.length || 1;
  const label = (MODELS[idx] || {}).label || ('Model ' + slot);
  const aw = (window.screen && window.screen.availWidth) || 1280;
  const posX = Math.round((idx / count) * aw);
  const posY = 60;
  const btn = document.querySelector(`.exec-btn[data-slot="${slot}"]`);
  const out = $(`#exec-out-${slot}`);
  const viz = $(`#exec-viz-${slot}`);
  if (!code.trim() || !out) return;
  // GUI (Pygame) tasks render IN THE BROWSER via WebAssembly so they work for
  // remote users — build with pygbag and embed an iframe instead of launching a
  // native window on the server host.
  if (task.gui && CONFIG && CONFIG.webGame) { return runWebGame(slot, code, btn, out, viz); }
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Running…';
  if (viz) viz.classList.add('hidden');
  out.classList.remove('hidden');
  out.querySelector('code').textContent = 'Running…';
  try {
    const resp = await fetch('/api/execute', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: task.language, code, taskId: task.id, title: label, posX, posY, index: idx, count, gap: 10 }),
    });
    if (resp.status === 401) { window.location.replace('/login'); return; }
    const r = await resp.json();
    const crash = crashFromExec(r, task);
    if (crash) noteCrash(slot, crash); else clearCrash(slot);
    if (r.error) {
      out.querySelector('code').textContent = '⚠ ' + r.error;
    } else if (r.kind === 'tests') {
      out.querySelector('code').textContent = formatTestResult(r);
    } else if (r.kind === 'launched') {
      out.querySelector('code').textContent = (r.launched ? '' : '⚠ ') + r.message;
    } else {
      const foot = `— exit ${r.exitCode == null ? '?' : r.exitCode} · ${r.durationMs}ms${r.truncated ? ' · output truncated' : ''}`;
      const moves = parseHanoiMoves(r.stdout);
      if (task.visualizer === 'hanoi' && viz && moves.length) {
        out.classList.add('hidden');
        viz.classList.remove('hidden');
        renderHanoiViz(viz, moves, r.stdout, foot);
      } else {
        const parts = [];
        if (r.stdout) parts.push(r.stdout.replace(/\s+$/, ''));
        if (r.stderr) parts.push((parts.length ? '\n' : '') + '[stderr]\n' + r.stderr.replace(/\s+$/, ''));
        if (r.timedOut) parts.push('\n⏱ Hit the time limit — likely an interactive/graphical program (e.g. a Pygame game loop). Run it locally with a display to use it.');
        out.querySelector('code').textContent = (parts.join('\n').trim() || '(no output)') + '\n\n' + foot;
      }
    }
  } catch (e) {
    out.querySelector('code').textContent = 'Request failed: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

// Build a GUI (Pygame) task into a WASM bundle and embed it so it runs in THIS
// browser — works for remote users (no native window on the server host).
async function runWebGame(slot, code, btn, out, viz) {
  const orig = btn ? btn.textContent : '▸ Run code';
  if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
  if (viz) viz.classList.add('hidden');
  out.classList.remove('hidden');
  out.querySelector('code').textContent =
    'Building a WebAssembly bundle… the first build downloads the runtime (~30–90s). The game then loads in the browser below and plays itself in demo mode.';
  try {
    const resp = await fetch('/api/web-game', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: currentTask().id, code }),
    });
    if (resp.status === 401) { window.location.replace('/login'); return; }
    const r = await resp.json();
    if (!resp.ok || !r.ok) throw new Error(r.error || 'Build failed.');
    clearCrash(slot);      // a clean build supersedes any earlier failure
    out.classList.add('hidden');
    if (viz) {
      viz.classList.remove('hidden');
      viz.innerHTML =
        '<div class="game-wrap"><iframe class="game-frame" src="' + r.url + '" title="' + esc(modelLabel(slot)) +
        '" allow="autoplay; fullscreen; gamepad"></iframe></div>' +
        '<div class="game-bar"><span>Running in your browser via WebAssembly' + (r.cached ? ' · cached build' : '') +
        '</span><a href="' + r.url + '" target="_blank" rel="noopener">↗ Full screen</a></div>';
    }
  } catch (e) {
    out.classList.remove('hidden');
    out.querySelector('code').textContent = '⚠ ' + e.message;
    noteCrash(slot, { error: e.message, source: 'build' });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// Render a JavaScript task's hidden-test result (from runTests).
function formatTestResult(r) {
  const head = r.passed === r.total
    ? `✓ Passed all ${r.total} hidden tests · ${r.durationMs}ms`
    : `✗ Passed ${r.passed} / ${r.total} hidden tests · ${r.durationMs}ms`;
  if (!r.failing || !r.failing.length) return head;
  const lines = r.failing.slice(0, 8).map((f) => `  (${f.inputStr})  ->  got ${f.gotStr}, expected ${f.expectedStr}`);
  const more = r.failing.length > 8 ? `\n  …and ${r.failing.length - 8} more` : '';
  return `${head}\n\nFailing cases:\n${lines.join('\n')}${more}`;
}

// Parse "Move disk K from X to Y" lines out of a program's stdout.
function parseHanoiMoves(stdout) {
  const moves = [];
  (stdout || '').split(/\r?\n/).forEach((line) => {
    const m = /move\s+disk\s+(\d+)\s+from\s+([A-Za-z0-9]+)\s+to\s+([A-Za-z0-9]+)/i.exec(line);
    if (m) moves.push({ disk: +m[1], from: m[2], to: m[3] });
  });
  return moves;
}

// Animate the parsed moves on 3 pegs; validate each move and the final state.
function renderHanoiViz(host, moves, rawStdout, foot) {
  const gen = (host._gen || 0) + 1; host._gen = gen;
  const alive = () => host._gen === gen && document.body.contains(host);

  const pegs = [...new Set(moves.flatMap((m) => [m.from, m.to]))].sort();
  const pegIndex = {}; pegs.forEach((p, i) => { pegIndex[p] = i; });
  const N = Math.max(...moves.map((m) => m.disk));
  const source = moves[0].from;
  const target = moves[moves.length - 1].to;

  const H = 150, diskH = 15, gap = 2, baseY = 20;
  const liftedY = H - diskH - 4;
  const cx = (i) => ((i + 0.5) / pegs.length) * 100;
  const wpct = (d) => 7 + (d / N) * 19;
  const leftPct = (i, d) => cx(i) - wpct(d) / 2;
  const stackY = (idx) => baseY + idx * (diskH + gap);
  const palette = ['#5b9bff', '#10a37f', '#d97757', '#c084fc', '#fbbf24', '#22d3ee', '#f472b6', '#a3e635'];
  const diskColor = (d) => palette[(d - 1) % palette.length];

  host.innerHTML =
    `<div class="hanoi-board" style="height:${H}px">` +
      pegs.map((p, i) =>
        `<div class="hanoi-rod" style="left:${cx(i)}%"></div>` +
        `<div class="hanoi-peglabel" style="left:${cx(i)}%">${esc(p)}</div>`).join('') +
      `<div class="hanoi-base"></div>` +
      Array.from({ length: N }, (_, k) => {
        const d = k + 1;
        return `<div class="hanoi-disk" data-disk="${d}" style="width:${wpct(d)}%;height:${diskH}px;background:${diskColor(d)}">${d}</div>`;
      }).join('') +
    `</div>` +
    `<div class="hanoi-caption">Ready — ${moves.length} moves, ${N} disks (start on ${esc(source)}, finish on ${esc(target)}).</div>` +
    `<div class="hanoi-controls"><button type="button" class="hanoi-replay">↻ Replay</button>` +
      `<details class="hanoi-raw"><summary>raw output</summary><pre><code>${esc(rawStdout.replace(/\s+$/, ''))}\n\n${esc(foot)}</code></pre></details></div>`;

  const diskEls = {};
  host.querySelectorAll('.hanoi-disk').forEach((el) => { diskEls[+el.dataset.disk] = el; });
  const cap = host.querySelector('.hanoi-caption');
  const state = {};

  const placeInitial = () => {
    pegs.forEach((p) => { state[p] = []; });
    for (let d = N; d >= 1; d--) state[source].push(d);
    pegs.forEach((p) => state[p].forEach((d, idx) => {
      const el = diskEls[d];
      el.style.transition = 'none';
      el.style.left = leftPct(pegIndex[p], d) + '%';
      el.style.bottom = stackY(idx) + 'px';
      el.classList.remove('bad');
    }));
    void host.offsetWidth; // reflow so the snap isn't animated
    host.querySelectorAll('.hanoi-disk').forEach((el) => { el.style.transition = ''; });
  };

  let i = 0, invalid = 0;
  // Adaptive pace: leisurely for a few moves, brisk for many (8 disks = 255 moves).
  const STEP = Math.max(60, Math.min(650, Math.round(9000 / moves.length)));
  const slideAt = Math.round(STEP * 0.30);
  const dropAt = Math.round(STEP * 0.60);
  host.style.setProperty('--disk-trans', Math.max(40, Math.min(180, Math.round(STEP * 0.5))) + 'ms');

  const play = () => {
    if (!alive()) return;
    if (i >= moves.length) {
      const ok = invalid === 0 && state[target].length === N;
      cap.textContent = ok
        ? `✓ Solved — ${moves.length} moves, every move valid, all ${N} disks on ${target}.`
        : `✗ ${invalid ? invalid + ' invalid move(s)' : 'finished but not all disks on ' + target}.`;
      cap.className = 'hanoi-caption ' + (ok ? 'good' : 'bad');
      return;
    }
    const mv = moves[i];
    const fromStack = state[mv.from] || [], toStack = state[mv.to] || [];
    const valid = fromStack[fromStack.length - 1] === mv.disk && (!toStack.length || toStack[toStack.length - 1] > mv.disk);
    if (!valid) invalid++;
    if (fromStack.length) fromStack.pop();
    const toIndex = toStack.length;
    toStack.push(mv.disk);
    const el = diskEls[mv.disk];
    if (!valid && el) el.classList.add('bad');
    if (el) {
      el.style.bottom = liftedY + 'px';                                              // lift
      setTimeout(() => { if (alive()) el.style.left = leftPct(pegIndex[mv.to], mv.disk) + '%'; }, slideAt); // slide
      setTimeout(() => { if (alive()) el.style.bottom = stackY(toIndex) + 'px'; }, dropAt);                 // drop
    }
    cap.textContent = `Move ${i + 1}/${moves.length}: disk ${mv.disk}  ${mv.from} → ${mv.to}` + (valid ? '' : '  ✗ INVALID');
    cap.className = 'hanoi-caption' + (valid ? '' : ' bad');
    i++;
    setTimeout(() => { if (alive()) play(); }, STEP);
  };

  host.querySelector('.hanoi-replay').addEventListener('click', () => renderHanoiViz(host, moves, rawStdout, foot));
  placeInitial();
  setTimeout(() => { if (alive()) play(); }, 450);
}

function setStatus(slot, html, kind) {
  const node = $(`#status-${slot}`);
  const spin = kind === 'run' ? '<span class="spinner"></span>' : '';
  node.className = 'col-status' + (kind === 'done' ? ' status-done' : kind === 'err' ? ' status-err' : '');
  node.innerHTML = `${spin}<span>${html}</span>`;
  const col = document.querySelector(`#col-${slot}`); // live (breathing/barber-pole) only while running
  if (col) col.classList.toggle('is-live', kind === 'run');
}

// Update content inside a scroll container; if the user was already near the
// bottom, keep them pinned there so streaming output follows the latest tokens
// (but don't yank them down if they scrolled up to read).
function stick(scroller, fn) {
  if (!scroller) return fn();
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
  fn();
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}
function setCode(slot, text) {
  const node = $(`#code-${slot}`);
  if (node) stick(node.parentElement, () => { node.textContent = text; }); // parent <pre> is the scroller
}

function setThink(slot, text, rtok) {
  const node = document.querySelector(`#think-${slot}`);
  if (node) {
    if (rtok != null) node.dataset.rtok = rtok; // remember the latest known reasoning-token count
    let val = text && text.length ? text : '';
    if (!val) {
      // No readable thinking text came back yet. Distinguish active thinking vs
      // encrypted/withheld reasoning trace vs 0 thinking tokens.
      const tok = rtok != null ? rtok : Number(node.dataset.rtok || 0);
      const m = (ARENA_MODELS || MODELS || []).find((x) => x.slot === slot);
      const label = (m && m.label) ? m.label : 'This model';
      const isRunning = typeof slotIsRunning === 'function' && slotIsRunning(slot);
      if (tok > 0) {
        val = isRunning
          ? `⏳ ${label} is actively reasoning… (${fmtInt(tok)} thinking tokens generated so far)`
          : `${label} used ${fmtInt(tok)} thinking tokens during hidden chain-of-thought reasoning. The provider API metered ${fmtInt(tok)} internal reasoning tokens for this task without emitting an unencrypted text summary.`;
      } else {
        val = isRunning
          ? `⏳ Waiting for ${label} reasoning stream…`
          : 'No measurable thinking on this task — the model answered directly (0 thinking tokens reported).';
      }
    }
    stick(node.parentElement, () => { node.textContent = val; }); // parent .think-pre is the scroller
  }
  if (rtok != null) {
    const meta = document.querySelector(`#think-meta-${slot}`);
    if (meta) meta.textContent = `· ${fmtInt(rtok)} reasoning tokens`;
  }
}
function setTileVal(slot, key, val) {
  const n = document.querySelector(`#m-${key}-${slot} .v`);
  if (!n) return;
  const changed = n.textContent !== String(val);
  n.textContent = val;
  if (changed && key !== 'time') { // flash on change (not the continuously-ticking wall clock)
    const tile = n.parentElement;
    if (tile) { tile.classList.remove('flash'); void tile.offsetWidth; tile.classList.add('flash'); }
  }
}
function markWin(slot, key, win) {
  const n = document.querySelector(`#m-${key}-${slot}`);
  if (n) n.classList.toggle('win', !!win);
}

// ---------- run ----------
// Results of the most recent comparison, kept so a single slot can be re-run
// and merged back in without disturbing the others (see rerunSlot).
let LAST_RESULTS = {};
let ARENA_MODELS = null;  // the model set currently rendered (may differ from MODELS after a history restore)
// ---- per-slot ownership -----------------------------------------------------
// Each column is independently owned. A "generation" is bumped whenever someone
// takes over a slot, and a stream's events are applied only while it still owns
// that slot — so hitting Run again on one column mid-comparison takes that
// column over cleanly while the others keep streaming, and late events from the
// abandoned owner are ignored instead of overwriting the new run.
const SLOT_GEN = {};                      // slot -> generation counter
const SLOT_RUNS = {};                     // slot -> { abort, timer } for a single-slot re-run
let _fullRun = false;                     // a full comparison is streaming
let _busy = false;                        // kept for updateRunButton(): any run in flight
function claimSlots(slots) {              // take ownership; returns the snapshot to validate against
  const snap = {};
  slots.forEach((s) => { SLOT_GEN[s] = (SLOT_GEN[s] || 0) + 1; snap[s] = SLOT_GEN[s]; });
  return snap;
}
const ownsSlot = (snap, slot) => snap && snap[slot] != null && snap[slot] === SLOT_GEN[slot];
const slotIsRunning = (slot) => !!SLOT_RUNS[slot] || (_fullRun && !wallFinished.has(slot));

// POST /api/run and pump the NDJSON stream into `results`.
// Returns 'ok' | 'auth' | 'quota'; throws on transport/HTTP failure.
async function streamRun(payload, results, signal, own, retried) {
  const resp = await fetch('/api/run', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (resp.status === 401) { window.location.replace('/login'); return 'auth'; } // session expired mid-use
  if (resp.status === 409) {                                                     // cached attachment expired server-side
    const j = await resp.json().catch(() => ({}));
    if (j && j.code === 'ATTACHMENT_EXPIRED' && !retried && markAttachmentsExpired(j)) {
      // Re-upload the full files once and retry (no quota was consumed by the 409).
      return streamRun({ ...payload, attachments: currentAttachmentsPayload() }, results, signal, own, true);
    }
    throw new Error((j && j.error) || 'An attachment expired from the server cache — please re-attach it.');
  }
  if (resp.status === 429) {                                                     // daily per-user OpenAI run limit
    const j = await resp.json().catch(() => ({}));
    if (j && j.quota) {
      if (payload.mode === 'single') mySingleQuota = j.quota; else myQuota = j.quota;
      updateQuotaBadge();
    }
    window._lastQuotaObj = j || {};
    window._lastQuotaMsg = (j && j.error) || 'Daily OpenAI limit reached. Switch to Gemini & Claude (Vertex AI) for unlimited runs!';
    return 'quota';
  }
  if (!resp.ok || !resp.body) throw new Error('Request failed: ' + resp.status);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const ev = JSON.parse(line);
        // Drop events for a slot this stream no longer owns (someone hit Run
        // again on that column) — otherwise a stale run would clobber the new one.
        if (!ev.slot || ownsSlot(own, ev.slot)) handleEvent(ev, results, own);
      }
    }
  }
  return 'ok';
}

// Reflect a slot's run state on its own button. Buttons are NEVER disabled —
// a re-run can be started (or restarted) on any column at any time.
function paintRerunButton(slot) {
  const b = document.querySelector(`.rerun-btn[data-slot="${slot}"]`);
  if (!b) return;
  const running = slotIsRunning(slot);
  b.disabled = false;
  b.textContent = running ? '↻ Restart' : '↻ Run again';
  b.classList.toggle('running', running);
  b.title = running
    ? 'Abandon this model’s current attempt and start it again — other columns keep going'
    : 'Re-run just this model on the current task — the other columns are left alone';
}
function paintAllRerunButtons() { (ARENA_MODELS || MODELS).forEach((m) => paintRerunButton(m.slot)); }

async function run() {
  if (!MODELS.length) return;   // nothing selected — the button is disabled anyway
  const btn = $('#runBtn');
  btn.disabled = true;
  btn.textContent = 'Running…';
  _busy = true; _fullRun = true;
  // A new comparison gets a fresh repair allowance per slot.
  Object.keys(AUTOFIXED).forEach((k) => delete AUTOFIXED[k]);
  _judgeScored = null;
  { const jo = $('#judgeOut'); if (jo) jo.innerHTML = ''; }
  Object.keys(CRASH).forEach((k) => clearCrash(k));
  $('#scorecard').classList.add('hidden');

  buildArena();
  const slots = slotIds();
  slots.forEach((s) => setStatus(s, 'Queued…', 'run'));
  // Taking over every column cancels any single-slot re-run still in flight.
  slots.forEach((s) => { const r = SLOT_RUNS[s]; if (r) { r.abort.abort(); clearInterval(r.timer); delete SLOT_RUNS[s]; } });
  const own = claimSlots(slots);
  paintAllRerunButtons();
  $('#arena').scrollIntoView({ behavior: 'smooth', block: 'start' }); // bring the model cards to the top

  // Wall clock starts ticking immediately — keeps running while a model is only
  // thinking (no tokens yet). Each slot freezes to the server's measured wallMs on 'done'.
  wallFinished.clear();
  wallStartMs = performance.now();
  if (wallTimer) clearInterval(wallTimer);
  wallTimer = setInterval(() => {
    const secs = ((performance.now() - wallStartMs) / 1000).toFixed(1) + 's';
    // skip any column a re-run has taken over — it runs its own clock
    slots.forEach((s) => { if (!wallFinished.has(s) && ownsSlot(own, s)) setTileVal(s, 'time', secs); });
  }, 100);

  const payload = {
    taskId: $('#taskSelect').value,
    maxIterations: 1, // single-shot: correctness = the model's first-attempt pass rate (no self-debug retries)
    models: MODELS,
    customPrompt: $('#customPrompt').value,
    attachments: currentAttachmentsPayload(),
    keys: loadKeys(), // bring-your-own keys (empty {} ⇒ shared keys, subject to the daily limit)
  };

  LAST_RESULTS = {};
  const results = LAST_RESULTS;
  try {
    const st = await streamRun(payload, results, undefined, own);
    if (st === 'auth') return;
    if (st === 'quota') {
      const m = window._lastQuotaMsg;
      slots.forEach((s) => { if (ownsSlot(own, s)) setStatus(s, esc(m), 'err'); });
      if (window._lastQuotaObj && window._lastQuotaObj.openaiQuotaExhausted) {
        const switchToVertex = window.confirm(
          `${m}\n\nWould you like to automatically replace the OpenAI slot(s) with Vertex AI models (Claude Sonnet 5.0 / Gemini 3.8 Flash) and run this comparison right now with UNLIMITED Vertex AI runs?`
        );
        if (switchToVertex) {
          const vertexFallbacks = ['claude-sonnet-5', 'gemini-3.8-flash', 'claude-opus-4-8', 'gemini-3.8-pro', 'claude-haiku-4-5'];
          const k = loadKeys();
          MODELS = MODELS.map((mod) => {
            if (mod.provider === 'agentplatform' || keySourceFor(mod, k).state === 'own') return mod;
            const usedIds = new Set(MODELS.map((x) => x.id));
            const repId = vertexFallbacks.find((id) => !usedIds.has(id)) || 'claude-sonnet-5';
            const preset = (CONFIG.modelPresets || []).find((p) => p.id === repId);
            if (preset) return Object.assign({}, preset, { slot: mod.slot });
            return mod;
          });
          renderModelPicker();
          updateQuotaBadge();
          setTimeout(() => run(), 50);
          return;
        }
      } else {
        window.alert(m);
      }
      return;
    }
  } catch (e) {
    slots.forEach((s) => { if (!results[s] && ownsSlot(own, s)) setStatus(s, 'Error: ' + esc(e.message), 'err'); });
  } finally {
    if (wallTimer) { clearInterval(wallTimer); wallTimer = null; }
    btn.innerHTML = 'Run comparison ▸ <kbd class="run-kbd">⌘↵</kbd>';
    _fullRun = false;
    _busy = Object.keys(SLOT_RUNS).length > 0;   // re-runs may still be going
    updateRunButton();          // stays disabled if every slot was cleared meanwhile
    paintAllRerunButtons();
  }
}

// Re-run ONE model on the current task, leaving the other columns untouched.
// The fresh result is merged into LAST_RESULTS and the scorecard is rebuilt from
// the merged set, so you can retry a slow/failed model without redoing the rest.
async function rerunSlot(slot, repair) {
  const model = (ARENA_MODELS || MODELS).find((m) => m.slot === slot);
  if (!model) return;
  // Clickable at ANY time. Whatever currently owns this column — an in-flight
  // re-run of it, or a full comparison still streaming — is taken over: bumping
  // the generation makes the old owner's events for this slot get dropped, and
  // its own re-run request (if any) is aborted so the server stops billing it.
  { const prev = SLOT_RUNS[slot]; if (prev) { prev.abort.abort(); clearInterval(prev.timer); } }
  const own = claimSlots([slot]);
  const ac = new AbortController();
  const t0 = performance.now();
  const timer = setInterval(() => {
    if (!wallFinished.has(slot) && ownsSlot(own, slot)) {
      setTileVal(slot, 'time', ((performance.now() - t0) / 1000).toFixed(1) + 's');
    }
  }, 100);
  SLOT_RUNS[slot] = { abort: ac, timer };
  _busy = true;
  paintRerunButton(slot);

  // Reset just this column.
  clearCrash(slot);
  delete LAST_RESULTS[slot];
  wallFinished.delete(slot);
  ['tok', 'think', 'tps', 'cost'].forEach((k) => setTileVal(slot, k, 0));
  setTileVal(slot, 'time', '0.0s');
  { const c = $(`#code-${slot}`); if (c) c.textContent = '// generated solution will appear here'; }
  setThink(slot, '', null);
  { const pf = $(`#pf-${slot}`); if (pf) pf.style.width = '0%'; }
  { const pl = $(`#pl-${slot}`); if (pl) pl.textContent = `0 / ${currentTask().testCount} tests`; }
  { const eb = document.querySelector(`.exec-btn[data-slot="${slot}"]`); if (eb) eb.disabled = true; }
  setStatus(slot, 'Queued…', 'run');

  try {
    const st = await streamRun({
      taskId: $('#taskSelect').value,
      maxIterations: 1,
      models: [model],
      mode: 'single',            // draws on the separate single-model re-run budget
      repair: repair || undefined,   // crash-repair round: same model, its code + the failure
      customPrompt: $('#customPrompt').value,
      attachments: currentAttachmentsPayload(),
      keys: loadKeys(),
    }, LAST_RESULTS, ac.signal, own);
    if (st === 'auth') return;
    if (st === 'quota' && ownsSlot(own, slot)) { setStatus(slot, esc(window._lastQuotaMsg), 'err'); window.alert(window._lastQuotaMsg); return; }
  } catch (e) {
    // AbortError just means this column was taken over — the new owner has the UI.
    if (e && e.name === 'AbortError') return;
    if (!LAST_RESULTS[slot] && ownsSlot(own, slot)) setStatus(slot, 'Error: ' + esc(e.message), 'err');
  } finally {
    clearInterval(timer);
    // Only tear down if a newer owner hasn't already replaced us.
    if (SLOT_RUNS[slot] && SLOT_RUNS[slot].abort === ac) {
      delete SLOT_RUNS[slot];
      _busy = _fullRun || Object.keys(SLOT_RUNS).length > 0;
      paintRerunButton(slot);
      updateRunButton();
    }
  }
}

function handleEvent(ev, results, own) {
  switch (ev.type) {
    case 'start':
      break;
    case 'quota': // server's authoritative daily-runs count for this run
      if (ev.quota && ev.quota.limited) {
        // a stream that owns exactly one slot is a single-model re-run
        if (own && Object.keys(own).length === 1) mySingleQuota = ev.quota; else myQuota = ev.quota;
        updateQuotaBadge();
      }
      break;
    case 'context_warning': {
      const cw = $(`#ctx-warn-${ev.slot}`);
      if (cw && ev.message) {
        cw.textContent = `⚠ ${ev.message}`;
        cw.classList.remove('hidden');
      }
      break;
    }
    case 'attachment_note':
      showAttachmentNotes(ev.slot, ev.notes);
      break;
    case 'status': {
      const phase = ev.phase === 'thinking'
        ? `Round ${ev.iteration}: generating solution…`
        : `Round ${ev.iteration}: running hidden tests…`;
      setStatus(ev.slot, phase, 'run');
      break;
    }
    case 'delta': {
      // token-by-token streaming: code, reasoning and counters update live
      if (ev.answer != null) {
        const t = currentTask();
        setCode(ev.slot, t.language ? liveCodeView(ev.answer) : (ev.answer || '…'));
      }
      if (ev.reasoning !== undefined || ev.reasoningTokens !== undefined) {
        setThink(ev.slot, ev.reasoning, ev.reasoningTokens);
      }
      const secs = (ev.wallMs || 0) / 1000;
      const think = ev.reasoningTokens || 0;
      setTileVal(ev.slot, 'tok', fmtInt(Math.max(0, (ev.estOutTokens || 0) - think))); // answer only
      setTileVal(ev.slot, 'think', fmtInt(think));
      // rolling 1s rate for "real-time" tok/s; falls back to cumulative if rolling is 0
      const rolling = ev.currentTokensPerSec != null ? ev.currentTokensPerSec : (secs ? Math.round(ev.estOutTokens / secs) : 0);
      setTileVal(ev.slot, 'tps', rolling);
      if (ev.costUsd != null) setTileVal(ev.slot, 'cost', fmtCost(ev.costUsd)); // live cost as tokens stream
      // (wall time is driven by the client ticker so it never sits at 0 during thinking)
      setStatus(ev.slot, `Round ${ev.iteration}: streaming\u2026`, 'run');
      break;
    }
    case 'metrics': {
      // live cumulative counters tick up as each round's generation lands
      if (ev.reasoning !== undefined) setThink(ev.slot, ev.reasoning, ev.roundReasoningTokens);
      const think = ev.reasoningTokens || 0;
      setTileVal(ev.slot, 'tok', fmtInt(Math.max(0, ev.completionTokens - think))); // answer only
      setTileVal(ev.slot, 'think', fmtInt(think));
      setTileVal(ev.slot, 'tps', ev.tokensPerSec);
      setTileVal(ev.slot, 'cost', fmtCost(ev.costUsd));
      // (wall time is driven by the client ticker)
      break;
    }
    case 'iteration': {
      if (ev.total === 0) {
        $(`#pf-${ev.slot}`).style.width = '100%';
        $(`#pl-${ev.slot}`).textContent = 'generated · no automated tests';
        $(`#ph-${ev.slot}`).textContent = '';
      } else {
        const pct = ev.total ? Math.round((ev.passed / ev.total) * 100) : 0;
        $(`#pf-${ev.slot}`).style.width = pct + '%';
        $(`#pl-${ev.slot}`).textContent = `${ev.passed} / ${ev.total} tests`;
      }
      if (ev.code) setCode(ev.slot, ev.code);
      if (ev.reasoning !== undefined) setThink(ev.slot, ev.reasoning, ev.reasoningTokens != null ? ev.reasoningTokens : null);
      break;
    }
    case 'done':
      results[ev.slot] = ev.result;
      wallFinished.add(ev.slot); // freeze wall time to the server's measured value
      {
        const think = ev.result.reasoningTokens || 0;
        setTileVal(ev.slot, 'tok', fmtInt(Math.max(0, ev.result.completionTokens - think))); // answer only
        setTileVal(ev.slot, 'think', fmtInt(think));
        // finalize the thinking panel with the authoritative total (text + count)
        setThink(ev.slot, ev.result.reasoning, ev.result.reasoningTokens);
      }
      setTileVal(ev.slot, 'tps', ev.result.tokensPerSec);
      setTileVal(ev.slot, 'cost', fmtCost(ev.result.costUsd));
      setTileVal(ev.slot, 'time', (ev.result.wallMs / 1000).toFixed(1) + 's');
      paintRerunButton(ev.slot);
      if (currentTask().executable && ev.result.code) {
        const eb = document.querySelector(`.exec-btn[data-slot="${ev.slot}"]`);
        if (eb) eb.disabled = false;
        const auto = $('#autoRun');
        if (auto && auto.classList.contains('is-on')) execSlotCode(ev.slot); // auto-launch on finish (default on)
      }
      {
        const rr = ev.result;
        const secs = (rr.wallMs / 1000).toFixed(1);
        const msg = rr.total === 0
          ? `Done · ${secs}s`
          : (rr.solved ? `Solved · ${secs}s` : `Finished ${rr.correctness}% · ${secs}s`);
        // Never let a repair pass as a clean first attempt.
        setStatus(ev.slot, msg + (rr.repaired ? ' · after 1 fix round' : ''), 'done');
      }
      break;
    case 'model_error':
      results[ev.slot] = { slot: ev.slot, label: ev.label, error: ev.message };
      wallFinished.add(ev.slot);
      setStatus(ev.slot, 'Error: ' + esc(ev.message), 'err');
      break;
    case 'all_done':
      finalize(results);   // re-runs merge into LAST_RESULTS, so the scorecard reflects every slot
      // Durable, per-user run history is written SERVER-SIDE on run completion — nothing to POST here.
      // Bring the scorecard to the top after a FULL run; a single-slot re-run keeps
      // you where you are (you were looking at that column).
      if (own && Object.keys(own).length > 1) setTimeout(() => {
        const sc = $('#scorecard');
        if (sc && !sc.classList.contains('hidden')) sc.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
      break;
    case 'error':
      slotIds().forEach((s) => { if (!results[s] && ownsSlot(own, s)) setStatus(s, 'Error: ' + esc(ev.message), 'err'); });
      break;
  }
}

// ---------- finalize: metrics + scorecard ----------
function finalize(resultsMap, slots) {
  const results = (slots || slotIds()).map((s) => resultsMap[s]).filter((r) => r && !r.error);
  if (!results.length) return;

  // Star the best live tile for each metric that HAS a better direction: cheapest,
  // fastest, highest throughput. Output tokens is deliberately excluded — a shorter
  // answer is not automatically a better one, so crowning a "winner" there would
  // assert a judgement the data doesn't support (it's neutral in the scorecard too).
  const bestTps = Math.max(...results.map((r) => r.tokensPerSec));
  const bestCost = Math.min(...results.map((r) => r.costUsd));
  const bestTime = Math.min(...results.map((r) => r.wallMs));
  results.forEach((r) => {
    markWin(r.slot, 'tok', false);          // neutral: never highlighted
    markWin(r.slot, 'think', false);        // ditto — thinking length isn't good or bad
    markWin(r.slot, 'tps', r.tokensPerSec === bestTps);
    markWin(r.slot, 'cost', r.costUsd === bestCost);
    markWin(r.slot, 'time', r.wallMs === bestTime);
  });

  buildScorecard(results);
}

function buildScorecard(results) {
  $('#scorecard').classList.remove('hidden');

  const minCost = Math.min(...results.map((r) => Math.max(r.costUsd, 1e-9)));
  const minWall = Math.min(...results.map((r) => r.wallMs));
  const minTok = Math.min(...results.map((r) => r.totalTokens));

  const isCustom = results.every((r) => !r.total);
  const scored = results.map((r) => {
    const axes = {
      Speed: Math.round((minWall / r.wallMs) * 100),
      'Cost efficiency': Math.round((minCost / Math.max(r.costUsd, 1e-9)) * 100),
      'Token efficiency': Math.round((minTok / r.totalTokens) * 100),
    };
    if (!isCustom) {
      axes.Correctness = r.correctness;
    }
    const vals = Object.values(axes);
    const overall = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    return { ...r, axes, overall };
  });

  _lastScored = { scored, isCustom };   // so the Bars/Scale toggle can repaint without recomputing
  renderModelLegend(scored);
  renderMetricGrid(scored, isCustom);
  setupJudgePanel(scored, isCustom);
  renderTable(scored, isCustom);
}
let _lastScored = null;

// Neutral legend: one chip per model (icon + name + provider·model), equal weight.
function renderModelLegend(scored) {
  const wrap = $('#modelLegend');
  if (!wrap) return;
  wrap.innerHTML = scored.map((r) =>
    `<span class="ml-chip"><span class="ml-dot" style="background:${slotColor(r.slot)}"></span>${modelIconSvg(r)}<b>${esc(r.label)}</b><span class="ml-sub">${esc(r.provider)} · ${esc(r.model)}</span></span>`
  ).join('');
}

// ---------- per-metric comparison ----------
// Two interchangeable views of the same numbers, switchable at runtime:
//   'bars'  — vertical bars; HEIGHT is the value, and the fill climbs a
//             green→red ramp so a bar deep in the red is visibly bad.
//   'scale' — every model as a marker on one shared best→worst track. More
//             compact and instantly rankable, but min/max-normalised, so it
//             shows the ORDER, not the size of the gap.
// The ramp is flipped per metric so green always sits at the good end. A metric
// with no good/bad direction (output tokens) is neutral grey and ALWAYS renders
// as a bar — a best→worst track would imply a judgement the data can't support.
const MP_H = 150;                       // px; must match .mp-chart height in styles.css
const METRIC_VIEW_KEY = 'ullm.metricView';
function metricView() {
  try { const v = localStorage.getItem(METRIC_VIEW_KEY); if (v === 'bars' || v === 'scale') return v; } catch (e) { /* ignore */ }
  return 'bars';
}
function setMetricView(v) { try { localStorage.setItem(METRIC_VIEW_KEY, v); } catch (e) { /* ignore */ } }

const MP_ICONS = {
  correct: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/></svg>',
  cost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.8 9.2a3 3 0 0 0-2.8-1.7c-1.6 0-2.6.9-2.6 2 0 3 5.6 1.6 5.6 4.6 0 1.2-1.1 2.2-2.9 2.2a3.2 3.2 0 0 1-3-1.8"/><path d="M12 6v12"/></svg>',
  time: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M9 2h6"/></svg>',
  speed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
  len: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>',
};

// Vertical ramp for a bar/backdrop: green always at the metric's GOOD end.
function mpGradient(dir, alpha) {
  const g = `rgba(12,163,12,${alpha})`, w = `rgba(250,178,25,${alpha})`, b = `rgba(208,59,59,${alpha})`;
  if (dir === 'neutral') return `linear-gradient(0deg, rgba(123,132,148,${alpha * 0.6}) 0%, rgba(123,132,148,${alpha * 0.6}) 100%)`;
  return dir === 'lower'
    ? `linear-gradient(0deg, ${g} 0%, ${w} 52%, ${b} 100%)`   // tall bar = red = bad
    : `linear-gradient(0deg, ${b} 0%, ${w} 52%, ${g} 100%)`;  // tall bar = green = good
}

function metricList(isCustom) {
  const metrics = [];
  if (!isCustom) metrics.push({ label: 'Correctness', icon: 'correct', dir: 'higher', hint: '↑ higher is better', get: (r) => (r.correctness == null ? 0 : r.correctness), fmt: (v) => Math.round(v) + '%' });
  metrics.push({ label: 'Cost / task', icon: 'cost', dir: 'lower', hint: '↓ lower is better', get: (r) => Math.max(r.costUsd || 0, 0), fmt: (v) => fmtCost(v) });
  metrics.push({ label: 'Wall time', icon: 'time', dir: 'lower', hint: '↓ lower is better', get: (r) => (r.wallMs || 0) / 1000, fmt: (v) => v.toFixed(1) + 's' });
  metrics.push({ label: 'Tokens / sec', icon: 'speed', dir: 'higher', hint: '↑ higher is better', get: (r) => r.tokensPerSec || 0, fmt: (v) => fmtInt(Math.round(v)) });
  metrics.push({ label: 'Output tokens', icon: 'len', dir: 'neutral', hint: 'answer length · neutral', get: (r) => Math.max(0, (r.completionTokens || 0) - (r.reasoningTokens || 0)), fmt: (v) => fmtInt(v) });
  return metrics;
}

function mpHead(m) {
  return `<div class="mp-head"><span class="mp-ic">${MP_ICONS[m.icon] || ''}</span>
    <span class="mp-h-txt"><span class="mp-title">${esc(m.label)}</span><span class="mp-hint">${esc(m.hint)}</span></span></div>`;
}

function mpBars(m, vals, n) {
  const max = Math.max(...vals.map((x) => x.v), 1e-9);
  const fill = m.dir === 'neutral'
    ? 'background:var(--mp-neutral)'
    : `background-image:${mpGradient(m.dir, 1)};background-size:100% ${MP_H}px;background-position:left bottom;background-repeat:no-repeat`;
  const cols = vals.map(({ r, v }) => {
    const h = Math.max(5, Math.round((v / max) * 100));
    return `<div class="mp-col" title="${esc(r.label)}: ${esc(m.fmt(v))}">
      <div class="mp-val">${esc(m.fmt(v))}</div>
      <div class="mp-bar" style="height:${h}%;${fill}"></div>
    </div>`;
  }).join('');
  const names = vals.map(({ r }) => `<span class="mp-name">${modelIconSvg(r)}<span>${esc(shortLabel(r.label))}</span></span>`).join('');
  return `<div class="mp-chart" style="background-image:${mpGradient(m.dir, 0.10)}">${cols}</div>
    <div class="mp-names">${names}</div>`;
}

function mpScale(m, vals) {
  const nums = vals.map((x) => x.v);
  const max = Math.max(...nums), min = Math.min(...nums);
  const span = (max - min) || 1;
  // Position ALWAYS follows the value — low left, high right — exactly like the
  // bars view, where height is the value. It's the GRADIENT that flips so green
  // sits at the good end. (Ranking by position instead would put the biggest
  // number on the left for higher-is-better metrics, contradicting the bars.)
  const track = m.dir === 'neutral'
    ? 'linear-gradient(90deg, var(--mp-neutral), var(--mp-neutral))'
    : m.dir === 'higher'
      ? 'linear-gradient(90deg, #d03b3b 0%, #fab219 52%, #0ca30c 100%)'  // high = good = green on the right
      : 'linear-gradient(90deg, #0ca30c 0%, #fab219 52%, #d03b3b 100%)'; // low = good = green on the left
  const rows = vals.map(({ r, v }) => {
    const pct = ((v - min) / span) * 100;        // 0% = lowest value, 100% = highest
    return `<div class="mp-row" title="${esc(r.label)}: ${esc(m.fmt(v))}">
      <span class="mp-rname">${modelIconSvg(r)}<span>${esc(shortLabel(r.label))}</span></span>
      <span class="mp-track" style="background-image:${track}"><span class="mp-mark" style="left:calc(${pct.toFixed(1)}% - 3px)"></span></span>
      <span class="mp-rval">${esc(m.fmt(v))}</span>
    </div>`;
  }).join('');
  const ends = m.dir === 'neutral' ? ['shortest', 'longest']
    : m.dir === 'higher' ? ['worst', 'best'] : ['best', 'worst'];
  return `<div class="mp-scale">${rows}<div class="mp-ends"><span>${ends[0]}</span><span>${ends[1]}</span></div></div>`;
}

function renderMetricGrid(scored, isCustom) {
  const wrap = $('#metricGrid');
  if (!wrap) return;
  // A best→worst track needs something to compare against; with one model, bars only.
  const view = scored.length < 2 ? 'bars' : metricView();
  const toggle = $('#metricViewToggle');
  if (toggle) {
    toggle.classList.toggle('hidden', scored.length < 2);
    toggle.querySelectorAll('.mv-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  }
  wrap.innerHTML = metricList(isCustom).map((m) => {
    const vals = scored.map((r) => ({ r, v: m.get(r) }));
    // Neutral metrics have no good/bad end — a scale would imply one. Always bars.
    const body = (view === 'scale' && m.dir !== 'neutral') ? mpScale(m, vals) : mpBars(m, vals, scored.length);
    return `<div class="metric-panel" data-n="${scored.length}">${mpHead(m)}${body}</div>`;
  }).join('');
}

// Headline: the balanced winner + the single most striking comparative fact.
function renderWinnerHero(scored, isCustom) {
  const host = $('#winnerHero');
  if (!host) return;
  const ranked = [...scored].sort((a, b) => b.overall - a.overall);
  const winner = ranked[0];
  const cheapest = [...scored].sort((a, b) => a.costUsd - b.costUsd)[0];
  const fastest = [...scored].sort((a, b) => a.wallMs - b.wallMs)[0];
  const priciest = [...scored].sort((a, b) => b.costUsd - a.costUsd)[0];
  const slowest = [...scored].sort((a, b) => b.wallMs - a.wallMs)[0];
  const bits = [];
  if (!isCustom) {
    const allSolved = scored.every((r) => r.solved);
    bits.push(allSolved ? 'all models reached 100% correct' : `${esc(winner.label)} led on correctness`);
  }
  const costMult = priciest.costUsd / Math.max(cheapest.costUsd, 1e-9);
  if (scored.length > 1 && costMult >= 1.15) bits.push(`<b>${esc(cheapest.label)}</b> ${costMult.toFixed(1)}× cheaper`);
  const timeMult = slowest.wallMs / Math.max(fastest.wallMs, 1);
  if (scored.length > 1 && timeMult >= 1.15) bits.push(`<b>${esc(fastest.label)}</b> ${timeMult.toFixed(1)}× faster`);
  const why = bits.length ? bits.join(' · ') : 'closely matched across speed, tokens and cost';
  host.style.setProperty('--accent', slotColor(winner.slot));
  host.innerHTML = `
    <div class="wh-icon">${modelIconSvg(winner)}</div>
    <div class="wh-main">
      <div class="wh-badge">▲ Best balanced</div>
      <div class="wh-name">${esc(winner.label)}</div>
      <div class="wh-why">${why}</div>
    </div>
    <div class="wh-score"><div class="whs-num">${winner.overall}</div><div class="whs-lbl">overall / 100</div></div>`;
}

// One scannable card per model, ranked, with icon + big score + key stats.
function renderModelCards(scored, isCustom) {
  const wrap = $('#modelCards');
  if (!wrap) return;
  const ranked = [...scored].sort((a, b) => b.overall - a.overall);
  wrap.innerHTML = ranked.map((r, i) => {
    const stats = isCustom
      ? [['Cost / task', fmtCost(r.costUsd)], ['Speed', (r.wallMs / 1000).toFixed(1) + 's'], ['Out tokens', fmtInt(Math.max(0, r.completionTokens - (r.reasoningTokens || 0)))]]
      : [['Correctness', (r.correctness == null ? '—' : r.correctness + '%')], ['Cost / task', fmtCost(r.costUsd)], ['Speed', (r.wallMs / 1000).toFixed(1) + 's']];
    const statHtml = stats.map(([k, v]) => `<div class="mcc-stat"><span class="mcs-k">${k}</span><span class="mcs-v">${esc(v)}</span></div>`).join('');
    return `<div class="mc-card${i === 0 ? ' is-win' : ''}" style="--accent:${slotColor(r.slot)}">
      <div class="mcc-top">
        <span class="mcc-rank">P${i + 1}</span>
        <span class="mcc-ic">${modelIconSvg(r)}</span>
        <span class="mcc-name">${esc(r.label)}</span>
      </div>
      <div class="mcc-overall"><b>${r.overall}</b><span>/ 100</span><i>balanced score</i></div>
      <div class="mcc-stats">${statHtml}</div>
      ${thinkTag(r.thinking)}
    </div>`;
  }).join('');
}

function renderRadar(scored) {
  const labels = Object.keys(scored[0].axes);
  const datasets = scored.map((r) => {
    const c = slotColor(r.slot);
    return {
      label: r.label,
      data: labels.map((l) => r.axes[l]),
      borderColor: c,
      backgroundColor: c + '33',
      pointBackgroundColor: c,
      borderWidth: 2,
    };
  });
  if (radarChart) radarChart.destroy();
  radarChart = new Chart($('#radar'), {
    type: 'radar',
    data: { labels, datasets },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#98a6c0', font: { family: 'Inter' } } } },
      scales: {
        r: {
          min: 0, max: 100,
          angleLines: { color: 'rgba(150,170,210,.14)' },
          grid: { color: 'rgba(150,170,210,.12)' },
          pointLabels: { color: '#98a6c0', font: { size: 11, family: 'Inter' } },
          ticks: { color: '#5f6e8a', backdropColor: 'transparent', stepSize: 25 },
        },
      },
    },
  });
}

function renderBars(scored) {
  const wrap = $('#barWrap');
  wrap.innerHTML = '';
  const metrics = [
    ['Overall (balanced)', (r) => r.overall, (r) => r.overall + '/100'],
    ['Cost efficiency', (r) => r.axes['Cost efficiency'], (r) => fmtCost(r.costUsd) + '/task'],
    ['Speed', (r) => r.axes.Speed, (r) => (r.wallMs / 1000).toFixed(1) + 's'],
  ];
  const champSlot = [...scored].sort((a, b) => b.overall - a.overall)[0].slot;
  metrics.forEach(([title, scoreFn, labelFn]) => {
    const block = el('div', 'bar-metric');
    block.appendChild(el('div', 'bar-title', `<span>${title}</span>`));
    const rows = el('div', 'bar-rows');
    const maxScore = Math.max(...scored.map((r) => scoreFn(r) || 0), 1);
    scored.forEach((r) => {
      const w = Math.max(4, Math.round(((scoreFn(r) || 0) / maxScore) * 100));
      const row = el('div', 'bar-row' + (title.indexOf('Overall') === 0 && r.slot === champSlot ? ' champ' : ''));
      row.innerHTML =
        `<span class="name">${modelIconSvg(r)}${esc(r.label)}</span>` +
        `<span class="bar-track"><span class="bar-fill" style="width:${w}%;background:${slotColor(r.slot)}"></span></span>` +
        `<span class="val">${labelFn(r)}</span>`;
      rows.appendChild(row);
    });
    block.appendChild(rows);
    wrap.appendChild(block);
  });
}

function renderTable(scored, isCustom) {
  const tbody = $('#resultsTable tbody');
  tbody.innerHTML = '';
  const bestCost = Math.min(...scored.map((r) => r.costUsd));
  const bestWall = Math.min(...scored.map((r) => r.wallMs));
  const bestCorr = Math.max(...scored.map((r) => r.correctness));
  scored.forEach((r) => {
    const tr = el('tr');
    tr.innerHTML =
      `<td><span class="row-ic">${modelIconSvg(r)}</span>${esc(r.label)}</td>` +
      `<td class="td-think" title="${esc((r.thinking && r.thinking.detail) || '')}">${esc((r.thinking && r.thinking.label) || '\u2014')}</td>` +
      `<td class="${!isCustom && r.correctness === bestCorr ? 'best' : ''}">${isCustom || r.correctness == null ? '\u2014' : r.correctness + '%'}</td>` +
      `<td class="${r.wallMs === bestWall ? 'best' : ''}">${(r.wallMs / 1000).toFixed(1)}s</td>` +
      `<td>${fmtInt(r.promptTokens)} / ${fmtInt(Math.max(0, r.completionTokens - (r.reasoningTokens || 0)))} / ${fmtInt(r.reasoningTokens || 0)}</td>` +
      `<td>${r.tokensPerSec}</td>` +
      `<td class="${r.costUsd === bestCost ? 'best' : ''}">${fmtCost(r.costUsd)}</td>` +
      `<td class="${r.costUsd === bestCost ? 'best' : ''}">${fmtCost(r.costUsd * 1000)}</td>`;
    tbody.appendChild(tr);
  });
}

function renderTakeaway(scored, isCustom) {
  const byOverall = [...scored].sort((a, b) => b.overall - a.overall);
  const winner = byOverall[0];
  const cheapest = [...scored].sort((a, b) => a.costUsd - b.costUsd)[0];
  const fastest = [...scored].sort((a, b) => a.wallMs - b.wallMs)[0];
  const priciest = [...scored].sort((a, b) => b.costUsd - a.costUsd)[0];
  const slowest = [...scored].sort((a, b) => b.wallMs - a.wallMs)[0];

  const parts = [];
  if (isCustom) {
    parts.push(`Custom prompt across ${scored.length} models — comparing speed, tokens and cost (no correctness grading).`);
  } else {
    const allSolved = scored.every((r) => r.solved);
    parts.push(allSolved
      ? `All ${scored.length} models reached <b>100% correctness</b> on the hidden edge-case tests.`
      : `Final correctness: ${scored.map((r) => `${esc(r.label)} ${r.correctness}%`).join(', ')}.`);
  }

  const costMult = (priciest.costUsd / Math.max(cheapest.costUsd, 1e-9));
  if (costMult >= 1.15) {
    parts.push(`<b>${esc(cheapest.label)}</b> was the cheapest at <b>${fmtCost(cheapest.costUsd)}</b>/task ` +
      `(${fmtCost(cheapest.costUsd * 1000)} per 1,000 tasks) — about <b>${costMult.toFixed(1)}×</b> cheaper than ${esc(priciest.label)} (${fmtCost(priciest.costUsd)}).`);
  } else {
    parts.push(`Costs were close: cheapest was ${esc(cheapest.label)} at ${fmtCost(cheapest.costUsd)}/task.`);
  }

  const timeMult = (slowest.wallMs / Math.max(fastest.wallMs, 1));
  if (timeMult >= 1.15) {
    parts.push(`<b>${esc(fastest.label)}</b> finished fastest in <b>${(fastest.wallMs / 1000).toFixed(1)}s</b> — ` +
      `about <b>${timeMult.toFixed(1)}×</b> faster than ${esc(slowest.label)} (${(slowest.wallMs / 1000).toFixed(1)}s).`);
  } else {
    parts.push(`Latency was comparable; fastest was ${esc(fastest.label)} at ${(fastest.wallMs / 1000).toFixed(1)}s.`);
  }

  parts.push(`Best balanced score: <b>${esc(winner.label)}</b> (${winner.overall}/100).`);

  $('#takeaway').innerHTML = parts.join(' ');
}

// While a coding task streams, show only the code inside the first fenced block
// (drop leading prose and the ``` markers) so the code window stays clean live.
function liveCodeView(text) {
  if (!text) return '…';
  const open = text.match(/```[a-zA-Z0-9+#.-]*[ \t]*\r?\n?/);
  if (!open) return text;                       // no fence opened yet
  let s = text.slice(open.index + open[0].length);
  const close = s.lastIndexOf('```');
  if (close >= 0) s = s.slice(0, close);
  return s.trim() || '…';
}

// ---------- run history / log (SERVER-backed; per-user, admins see everyone) ----------
// The server logs every run (see /api/run) — the browser never writes history,
// so it's durable, per-user and tamper-proof. A user sees only their own runs;
// admins can toggle to all users and get an at-a-glance usage summary.
let historyScope = 'me';          // 'all' for admins — they always see everyone
let historyUserFilter = null;     // set by clicking a user in the usage table
let historyPage = 0;
const HIST_PAGE_SIZE = 6;           // rows rendered at once — keeps the DOM small however big history grows
let _histState = { body: null, runs: [], usage: null, isAdmin: false };
function fmtWhen(ms) { try { return new Date(ms).toLocaleString(); } catch (e) { return ''; } }

async function openHistoryModal() {
  const isAdmin = ME && ME.role === 'admin';
  historyScope = isAdmin ? 'all' : 'me';
  const body = openAuthModal('Run history', { wide: true });
  body.innerHTML = '<p class="auth-loading">Loading…</p>';
  try {
    const [histResp, usage] = await Promise.all([
      fetch('/api/history?scope=' + historyScope, { credentials: 'same-origin' }),
      isAdmin ? fetch('/api/usage', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null),
    ]);
    if (histResp.status === 401) { window.location.replace('/login'); return; }
    const data = await histResp.json();
    if (!histResp.ok) throw new Error(data.error || 'Failed to load history.');
    _histState = { body, runs: data.runs || [], usage, isAdmin };
    historyPage = 0; usersPage = 0; historyUserFilter = null;   // fresh view on (re)open
    paintHistoryModal();
  } catch (e) {
    body.innerHTML = '<p class="auth-err"></p>'; body.querySelector('p').textContent = e.message;
  }
}

// Render the current page of the already-fetched (light) history list. Called on
// open, page nav, and after a delete — no refetch, so paging is instant.
function paintHistoryModal() {
  const { body, runs, usage, isAdmin } = _histState;
  if (!body) return;
  const usagePanel = (isAdmin && usage) ? renderUsagePanel(usage) : '';
  // Filtering is driven by clicking a user in the usage table above, so there's
  // no My-runs/All-users toggle any more — admins see everyone by default.
  const activeName = historyUserFilter
    ? (((usage && usage.users) || []).find((x) => (x.user || x.userName) === historyUserFilter) || {}).userName || historyUserFilter
    : '';
  const filterChip = historyUserFilter
    ? `<div class="hist-filter">Showing runs by <b>${esc(activeName)}</b>
         <button class="hf-clear" type="button">✕ show everyone</button></div>`
    : '';
  const runs_ = historyUserFilter ? runs.filter((r) => (r.user || r.userName) === historyUserFilter) : runs;
  const total = runs_.length;
  const pageCount = Math.max(1, Math.ceil(total / HIST_PAGE_SIZE));
  historyPage = Math.min(Math.max(0, historyPage), pageCount - 1);   // clamp (e.g. after deleting the last row on a page)
  const start = historyPage * HIST_PAGE_SIZE;
  const pageRuns = runs_.slice(start, start + HIST_PAGE_SIZE);
  const rows = total
    ? pageRuns.map((h) => histRowHtml(h)).join('')
    : '<p class="auth-loading">No runs yet — run a comparison and it will appear here so you can revisit or re-showcase it.</p>';
  const pager = total > HIST_PAGE_SIZE ? histPagerHtml(historyPage, pageCount, total, start, pageRuns.length) : '';
  body.innerHTML = usagePanel + filterChip + `<div class="hist-list">${rows}</div>` + pager;
  // click a user row → show only their runs; click again (or the chip) → everyone
  body.querySelectorAll('.u-row').forEach((r) => r.addEventListener('click', () => {
    historyUserFilter = (historyUserFilter === r.dataset.user) ? null : r.dataset.user;
    historyPage = 0;
    paintHistoryModal();
  }));
  { const c = body.querySelector('.hf-clear');
    if (c) c.addEventListener('click', () => { historyUserFilter = null; historyPage = 0; paintHistoryModal(); }); }
  { const p = body.querySelector('.u-pg-prev');
    if (p) p.addEventListener('click', () => { if (usersPage > 0) { usersPage--; paintHistoryModal(); } }); }
  { const nx = body.querySelector('.u-pg-next');
    if (nx) nx.addEventListener('click', () => { usersPage++; paintHistoryModal(); }); }
  body.querySelectorAll('.hist-restore').forEach((b) => b.addEventListener('click', () => restoreHistory(b.dataset.id)));
  body.querySelectorAll('.hist-del').forEach((b) => b.addEventListener('click', () => deleteHistoryRun(b.dataset.id)));
  const prev = body.querySelector('.hist-pg-prev');
  if (prev) prev.addEventListener('click', () => { if (historyPage > 0) { historyPage--; paintHistoryModal(); } });
  const next = body.querySelector('.hist-pg-next');
  if (next) next.addEventListener('click', () => { if (historyPage < pageCount - 1) { historyPage++; paintHistoryModal(); } });
}

function histPagerHtml(page, pageCount, total, start, shown) {
  const from = total ? start + 1 : 0;
  const to = start + shown;
  return `<div class="hist-pager">
    <button class="hist-pg-btn hist-pg-prev" type="button" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
    <span class="hist-pg-info">${from}–${to} of ${fmtInt(total)} · page ${page + 1} of ${pageCount}</span>
    <button class="hist-pg-btn hist-pg-next" type="button" ${page >= pageCount - 1 ? 'disabled' : ''}>Next ›</button>
  </div>`;
}

function histRowHtml(h) {
  const chips = (h.summary || []).map((s) => {
    const stat = s.error ? '<span class="hc-err">error</span>' : (s.total ? esc(s.correctness + '%') : 'done');
    const cost = s.costUsd != null ? ' · ' + esc(fmtCost(s.costUsd)) : '';
    return `<span class="hist-chip"><b>${esc(s.label)}</b> ${stat}${cost}</span>`;
  }).join('');
  const who = (historyScope === 'all' && !historyUserFilter && h.userName) ? `<span class="hist-who">${esc(h.userName)}</span>` : '';
  return `<div class="hist-row">
    <div class="hist-main"><div class="hist-title">${esc(h.title)}${who}</div><div class="hist-when">${esc(fmtWhen(h.at))}</div><div class="hist-chips">${chips}</div></div>
    <div class="hist-act"><button class="submit-btn hist-restore" data-id="${esc(h.id)}">Restore ▸</button><button class="u-del hist-del" data-id="${esc(h.id)}">Delete</button></div>
  </div>`;
}

// Admin usage table. Paginated — it used to render only the first 15 users and
// silently drop the rest, so a busy deployment hid most of its users.
const USER_PAGE_SIZE = 8;
let usersPage = 0;
function renderUsagePanel(u) {
  const t = u.totals || {};
  const all = u.users || [];
  const pageCount = Math.max(1, Math.ceil(all.length / USER_PAGE_SIZE));
  usersPage = Math.min(Math.max(0, usersPage), pageCount - 1);
  const start = usersPage * USER_PAGE_SIZE;
  const page = all.slice(start, start + USER_PAGE_SIZE);
  const rows = page.map((x) => {
    const id = x.user || x.userName;
    const on = historyUserFilter === id;
    return `<tr class="u-row${on ? ' active' : ''}" data-user="${esc(id)}" title="Show only this user's runs">
      <td class="u-name">${esc(x.userName || x.user)}${on ? ' <span class="u-tag">filtered</span>' : ''}</td>
      <td>${fmtInt(x.runs)}</td><td>${fmtInt(x.runsToday)}</td><td>${esc(fmtCost(x.costUsd))}</td>
      <td class="hist-when">${esc(x.lastAt ? fmtWhen(x.lastAt) : '—')}</td></tr>`;
  }).join('');
  const pager = all.length > USER_PAGE_SIZE
    ? `<div class="hist-pager users-pager">
         <button class="hist-pg-btn u-pg-prev" type="button" ${usersPage === 0 ? 'disabled' : ''}>‹ Prev</button>
         <span class="hist-pg-info">${start + 1}–${start + page.length} of ${fmtInt(all.length)} users · page ${usersPage + 1} of ${pageCount}</span>
         <button class="hist-pg-btn u-pg-next" type="button" ${usersPage >= pageCount - 1 ? 'disabled' : ''}>Next ›</button>
       </div>` : '';
  return `<div class="usage-panel">
    <div class="usage-stats">
      <div class="ustat"><div class="uk">Active users</div><div class="uv">${fmtInt(t.users || 0)}</div></div>
      <div class="ustat"><div class="uk">Runs today</div><div class="uv">${fmtInt(t.runsToday || 0)}</div></div>
      <div class="ustat"><div class="uk">Runs total</div><div class="uv">${fmtInt(t.totalRuns || 0)}</div></div>
    </div>
    ${rows ? `<table class="usage-table"><thead><tr><th>User</th><th>Runs</th><th>Today</th><th>Cost</th><th>Last run</th></tr></thead><tbody>${rows}</tbody></table>${pager}` : ''}
    <p class="hint">Click a user to see only their runs. Today = since 00:00 UTC.</p>
  </div>`;
}

async function restoreHistory(id) {
  try {
    const r = await fetch('/api/history/' + encodeURIComponent(id), { credentials: 'same-origin' });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const j = await r.json();
    if (!r.ok || !j.run) throw new Error((j && j.error) || 'Could not load that run.');
    const snap = j.run;
    closeAuthModal();
    const sel = $('#taskSelect');
    if ([].slice.call(sel.options).some((o) => o.value === snap.taskId)) { sel.value = snap.taskId; renderTaskPrompt(); }
    renderSavedRun(snap); // rebuilds the arena + scorecard from the snapshot (its own model set)
    $('#arena').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { window.alert(e.message); }
}

async function deleteHistoryRun(id) {
  if (!window.confirm('Delete this run from history?')) return;
  try {
    const r = await fetch('/api/history/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error((j && j.error) || 'Could not delete.');
    _histState.runs = _histState.runs.filter((h) => h.id !== id);   // drop locally + repaint (keeps the current page)
    paintHistoryModal();
  } catch (e) { window.alert(e.message); }
}

// Wipe the current run from the UI → clean slate: clears results, scorecard, this
// task's saved snapshot and any in-flight wall timer, then rebuilds empty columns.
// Repaint the arena + scorecard from a saved snapshot (used by History → Restore).
function renderSavedRun(snap) {
  buildArena(snap.models);
  const resultsMap = {};
  snap.slots.forEach(({ slot, data }) => {
    if (!data) return;
    resultsMap[slot] = data;
    if (data.error) { setStatus(slot, 'Error: ' + esc(data.error), 'err'); return; }
    applyResultToColumn(slot, data);
  });
  finalize(resultsMap, snap.models.map((m) => m.slot)); // rebuild the scorecard from saved results
}

// Visible record of provider-specific attachment handling for this slot (e.g.
// "image auto-scaled to 6764×4512 for gpt-6-sol (…)"). textContent only.
function showAttachmentNotes(slot, notes) {
  const el = $(`#att-note-${slot}`);
  if (!el || !Array.isArray(notes) || !notes.length) return;
  el.textContent = notes.map((n) => `ℹ ${n}`).join('\n');
  el.classList.remove('hidden');
}

// Repaint one column from a saved/finished result (mirrors the live 'done' handler; never auto-runs).
function applyResultToColumn(slot, r) {
  if (Array.isArray(r.attachmentNotes)) showAttachmentNotes(slot, r.attachmentNotes);
  if (r.code != null) $(`#code-${slot}`).textContent = r.code;
  setThink(slot, r.reasoning, r.reasoningTokens != null ? r.reasoningTokens : null);
  // saved/finished view: show code & reasoning from the top, not the streamed bottom
  { const cp = $(`#code-${slot}`); if (cp && cp.parentElement) cp.parentElement.scrollTop = 0;
    const tp = document.querySelector(`#think-${slot}`); if (tp && tp.parentElement) tp.parentElement.scrollTop = 0; }
  const thinkTok = r.reasoningTokens || 0;
  setTileVal(slot, 'tok', fmtInt(Math.max(0, r.completionTokens - thinkTok)));
  setTileVal(slot, 'think', fmtInt(thinkTok));
  setTileVal(slot, 'tps', r.tokensPerSec);
  setTileVal(slot, 'cost', fmtCost(r.costUsd));
  setTileVal(slot, 'time', (r.wallMs / 1000).toFixed(1) + 's');
  if (r.total) {
    $(`#pf-${slot}`).style.width = Math.round((r.passed / r.total) * 100) + '%';
    $(`#pl-${slot}`).textContent = `${r.passed} / ${r.total} tests`;
  } else {
    $(`#pf-${slot}`).style.width = '100%';
    $(`#pl-${slot}`).textContent = 'generated · no automated tests';
  }
  const secs = (r.wallMs / 1000).toFixed(1);
  setStatus(slot, r.total === 0 ? `Done · ${secs}s` : (r.solved ? `Solved · ${secs}s` : `Finished ${r.correctness}% · ${secs}s`), 'done');
  { const rb = document.querySelector(`.rerun-btn[data-slot="${slot}"]`); if (rb) rb.disabled = false; }
  if (currentTask().executable && r.code) {
    const eb = document.querySelector(`.exec-btn[data-slot="${slot}"]`);
    if (eb) eb.disabled = false;
  }
}


// ---------- full-page preview (magnifying glass) ----------
function modelLabel(slot) { const m = MODELS.find((x) => x.slot === slot); return (m && m.label) || ('Model ' + slot); }

function ensureModal() {
  let modal = $('#mdModal');
  if (modal) return modal;
  modal = el('div', 'md-modal hidden');
  modal.id = 'mdModal';
  modal.innerHTML =
    '<div class="md-modal-panel">' +
      '<div class="md-modal-head"><span class="md-modal-title"></span>' +
        '<div class="md-modal-actions"><button class="md-toggle" type="button" title="Toggle raw / rendered"></button>' +
        '<button class="md-modal-close" type="button" title="Close (Esc)">✕</button></div></div>' +
      '<div class="md-modal-body"></div>' +
    '</div>';
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  modal.querySelector('.md-modal-close').addEventListener('click', closeModal);
  return modal;
}
function closeModal() { const m = $('#mdModal'); if (m) m.classList.add('hidden'); }

let mdState = { text: '', markdown: false, rendered: true };
function renderModalBody() {
  const modal = $('#mdModal'); if (!modal) return;
  const body = modal.querySelector('.md-modal-body');
  const toggle = modal.querySelector('.md-toggle');
  const parser = window.marked && (window.marked.parse || window.marked);
  // SECURITY: rendered markdown is LLM output → only insert it as HTML when DOMPurify
  // loaded; if the sanitizer CDN failed, fall back to the raw (textContent) view.
  const canMd = mdState.markdown && typeof parser === 'function' && !!(window.DOMPurify && window.DOMPurify.sanitize);
  toggle.style.display = canMd ? '' : 'none';
  toggle.textContent = mdState.rendered ? 'View raw' : 'View rendered';
  if (canMd && mdState.rendered) {
    let html = parser(mdState.text || '');
    if (window.DOMPurify) html = window.DOMPurify.sanitize(html); // LLM output → sanitize before inserting
    body.innerHTML = '<div class="md-body">' + html + '</div>';
  } else {
    body.innerHTML = '';
    const pre = el('pre', 'md-code'); pre.textContent = mdState.text || '(empty)';
    body.appendChild(pre);
  }
  body.scrollTop = 0;
}
function openContentModal(title, text, asMarkdown) {
  const modal = ensureModal();
  modal.querySelector('.md-modal-title').textContent = title;
  mdState = { text: text || '', markdown: !!asMarkdown, rendered: true };
  modal.querySelector('.md-toggle').onclick = () => { mdState.rendered = !mdState.rendered; renderModalBody(); };
  renderModalBody();
  modal.classList.remove('hidden');
}
function openMagnify(slot, kind) {
  if (kind === 'think') openContentModal('Thinking — ' + modelLabel(slot), ($(`#think-${slot}`) || {}).textContent || '', true);
  else openContentModal('Output — ' + modelLabel(slot), ($(`#code-${slot}`) || {}).textContent || '', !currentTask().language);
}

// ---------- formatting ----------
function fmtInt(n) { return (n || 0).toLocaleString('en-US'); }
function fmtCost(n) {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return '$' + n.toFixed(5);
  if (n < 1) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}
