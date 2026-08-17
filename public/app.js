// ---------------------------------------------------------------------------
// LLM Agent Arena — frontend
// ---------------------------------------------------------------------------

const PALETTE = ['#5e8bff', '#2fd9a6', '#ff9e6d', '#b388ff', '#ffcb5e', '#22e0ff']; // Aurora accents
const MIN_SLOTS = 0; // every slot can be cleared; Run is disabled while none are filled
const MAX_SLOTS = 3; // compare at most 3 models at a time
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
// Every call site interpolates into innerHTML, including attribute values, so
// the double quote must be escaped too — without it a quote in a model label or
// a tooltip closes the attribute early and the rest leaks into the markup.
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
const ICON_GENERIC = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>';
// Pick a brand mark from a model's publisher / provider / model id / label.
function modelIconSvg(m) {
  const s = (((m && m.publisher) || '') + ' ' + ((m && m.provider) || '') + ' ' + ((m && m.model) || '') + ' ' + ((m && m.label) || '')).toLowerCase();
  if (s.indexOf('anthropic') >= 0 || s.indexOf('claude') >= 0) return ICON_CLAUDE;
  if (s.indexOf('gemini') >= 0 || s.indexOf('google') >= 0) return ICON_GEMINI;
  return ICON_GENERIC;
}
// A compact, distinct name for tight spaces — drops the family prefix so the two
// Geminis read as "3.5 Flash" / "3.1 Pro" instead of both truncating to "Ge…".
function shortLabel(label) {
  const s = String(label || '');
  return s.replace(/^(Gemini|Claude|GPT|Llama|Mistral|OpenAI|Anthropic|Google|DeepSeek|Qwen)\s+/i, '').trim() || s;
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
  CONFIG.models.forEach((m, i) => { const s = SLOT_IDS[i]; if (s) SLOT_ASSIGN[s] = m.catalogId || m.id; });
  syncModelsFromSlots();


  // task select \u2014 grouped by category (Coding / General)
  const ts = $('#taskSelect');
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
  const og = el('optgroup'); og.label = 'Other';
  const customOpt = el('option');
  customOpt.value = 'custom';
  customOpt.textContent = 'Custom prompt\u2026';
  og.appendChild(customOpt);
  ts.appendChild(og);
  ts.addEventListener('change', () => { renderTaskPrompt(); $('#scorecard').classList.add('hidden'); buildArena(); });
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


// Live "runs left today" state (authoritative value comes from the server on
// /api/config load and on each run's `quota` event).
let myQuota = null;        // daily budget for full comparison runs
let mySingleQuota = null;  // separate daily budget for single-model re-runs

// Badge near Run: your-keys (unlimited), or a live shared-key counter.
function updateQuotaBadge() {
  const b = $('#quotaBadge'); if (!b) return;
  const limit = (CONFIG && CONFIG.maxRunsPerDay) || 0;
  const isAdmin = ME && ME.role === 'admin';
  // "Unlimited" only when EVERY selected model runs on the user's own key —
  // matching the server. One own key alongside a shared slot is still capped.
  if (allModelsUseOwnKeys()) { b.textContent = 'no daily limit'; b.className = 'quota-badge own';
    b.title = 'Every selected model runs on your own key, so this run is not counted against the daily limit.'; return; }
  if (isAdmin) { b.textContent = 'admin · no limit'; b.className = 'quota-badge own'; b.title = 'Admins are exempt from the daily run limit.'; return; }
  if (!limit) { b.textContent = ''; b.className = 'quota-badge'; b.title = ''; return; }
  const remaining = (myQuota && typeof myQuota.remaining === 'number') ? myQuota.remaining : limit;
  const sLimit = (CONFIG && CONFIG.maxSingleRunsPerDay) || 0;
  const sRemaining = (mySingleQuota && typeof mySingleQuota.remaining === 'number') ? mySingleQuota.remaining : sLimit;
  b.textContent = `${remaining} of ${limit} runs left today`
    + (sLimit ? ` · ${sRemaining} re-runs` : '');
  b.className = 'quota-badge ' + (remaining <= 0 ? 'out' : remaining <= 2 ? 'low' : 'shared');
  b.title = `Comparison runs: ${remaining}/${limit} left`
    + (sLimit ? `. Single-model re-runs: ${sRemaining}/${sLimit} left (separate budget)` : '')
    + ((myQuota && myQuota.resetAt) ? `. Resets at ${new Date(myQuota.resetAt).toLocaleString()}` : '')
    + '. Add your own key for EVERY provider above to run without a limit.';
}

function openKeysModal() {
  const body = openAuthModal('Your API keys');
  const k = loadKeys();
  const limit = (CONFIG && CONFIG.maxRunsPerDay) || 20;
  body.innerHTML =
    '<div class="key-scope personal">' +
      '<div class="ks-head">🔒 Personal keys — this browser only</div>' +
      '<ul class="ks-facts">' +
        '<li><b>Stored only in this browser</b> (localStorage). They are never written to the server\'s database, disk or logs, and no other user — not even an admin — can see them.</li>' +
        '<li><b>Sent with each of your runs</b> over HTTPS, because the server has to hold the key to call the provider. It is used in memory for that run and then discarded.</li>' +
        '<li>Clearing your browser data — or pressing <b>Clear all</b> below — removes them completely.</li>' +
      '</ul>' +
    '</div>' +
    '<p class="keys-intro">A run where <b>every</b> selected model uses your own key is <b>not counted</b> against the daily limit. ' +
    'Leave a field blank to fall back to the shared key for that provider (capped at ' + limit + '/day)' +
    ((ME && ME.role === 'admin') ? ' — shared keys are managed under <b>Global API keys</b>.' : '.') + '</p>' +
    '<form class="add-user-form" id="keysForm">' +
      '<div class="auth-field"><label>Gemini / Agent Platform API key</label><input id="k-gem" type="password" autocomplete="off" spellcheck="false" placeholder="used for the Gemini slots" value="' + esc(k.agentplatform || k.gemini || '') + '" /></div>' +
      '<h4 style="margin:18px 0 10px">External models</h4>' +
      '<p class="keys-intro" style="margin-bottom:12px">These are <b>not</b> on Vertex, so they need their own key and the prompt leaves Google infrastructure when you run them.</p>' +
      '<div class="auth-field"><label>OpenAI API key <span class="u-tag">GPT-5.6 Luna</span></label><input id="k-openai" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" value="' + esc(k.openai || '') + '" /></div>' +
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

// ---------- slot assignment (drag & drop picker) ----------
// Three fixed slots, each holding at most one catalog model. A model can only
// occupy ONE slot, so dropping a model that is already placed MOVES it (and
// swaps with whatever was in the destination) rather than duplicating it.
const SLOT_IDS = ['A', 'B', 'C'].slice(0, MAX_SLOTS);
const SLOT_ASSIGN = {};                  // slot -> catalogId | null
const SLOT_EFFORT = {};                  // slot -> chosen thinking level | null
SLOT_IDS.forEach((s) => { SLOT_ASSIGN[s] = null; SLOT_EFFORT[s] = null; });

function modelFromCatalogId(slot, id) {
  const c = catalog().find((x) => x.id === id);
  if (!c) return null;
  return {
    slot, catalogId: c.id, label: c.label,
    provider: c.provider, publisher: c.publisher, model: c.model,
    price: { input: c.price.input, output: c.price.output },
    external: !!c.external,
    thinking: c.thinking || null,          // reasoning level this model gets sent
    thinkingOptions: c.thinkingOptions || null,
    effort: SLOT_EFFORT[slot] || undefined, // per-card override, validated again server-side
  };
}
// MODELS (what the rest of the app runs on) is derived from the slots.
function syncModelsFromSlots() {
  MODELS = SLOT_IDS.filter((s) => SLOT_ASSIGN[s]).map((s) => modelFromCatalogId(s, SLOT_ASSIGN[s])).filter(Boolean);
}
function slotOf(catalogId) { return SLOT_IDS.find((s) => SLOT_ASSIGN[s] === catalogId) || null; }

// Place `catalogId` into `slot`. Moving between slots swaps; coming from the
// palette displaces the current occupant back to the palette.
function assignToSlot(catalogId, slot) {
  if (!SLOT_IDS.includes(slot)) return;
  const c = catalog().find((x) => x.id === catalogId);
  if (!c) return;
  // A model with no usable key can never occupy a slot, whatever route got us
  // here (drag, click, or a hand-crafted drop event).
  if (!modelAvailability(c).ok) return;
  const from = slotOf(catalogId);
  if (from === slot) return;                       // dropped where it already is
  const displaced = SLOT_ASSIGN[slot] || null;
  const movedEffort = from ? SLOT_EFFORT[from] : null;
  SLOT_ASSIGN[slot] = catalogId;
  // The level belongs to the model, not the card — carry it when a model moves,
  // and drop any level the displaced model had chosen.
  SLOT_EFFORT[slot] = from ? movedEffort : null;
  if (from) { SLOT_ASSIGN[from] = displaced; SLOT_EFFORT[from] = null; }
  afterSlotChange();
}
function clearSlot(slot) {
  if (!SLOT_ASSIGN[slot]) return;
  const filled = SLOT_IDS.filter((s) => SLOT_ASSIGN[s]).length;
  if (filled <= MIN_SLOTS) return;
  SLOT_ASSIGN[slot] = null;
  SLOT_EFFORT[slot] = null;
  afterSlotChange();
}
// Click fallback (and touch, where HTML5 drag&drop doesn't fire): fill the first
// empty slot, else replace the last one.
function placeInFirstFreeSlot(catalogId) {
  if (slotOf(catalogId)) return;
  { const c = catalog().find((x) => x.id === catalogId); if (!c || !modelAvailability(c).ok) return; }
  const free = SLOT_IDS.find((s) => !SLOT_ASSIGN[s]);
  assignToSlot(catalogId, free || SLOT_IDS[SLOT_IDS.length - 1]);
}
function afterSlotChange() {
  syncModelsFromSlots();
  renderModelEditors();
  buildArena();
  updateQuotaBadge();   // the key pills depend on which providers are selected
  updateRunButton();
}

// Running with zero models would post an empty list, and the server falls back
// to DEFAULT_MODELS for that — i.e. it would quietly run models the user just
// removed. So the button is disabled until at least one slot is filled.
function updateRunButton() {
  const btn = $('#runBtn');
  if (!btn || _busy) return;
  const none = MODELS.length === 0;
  btn.disabled = none;
  btn.title = none ? 'Drag at least one model into a slot to run a comparison.' : '';
}

function currentTask() {
  const id = $('#taskSelect').value;
  if (id === 'custom') return { id: 'custom', title: 'Custom prompt', prompt: '', testCount: 0, category: 'general', language: null, executable: false };
  return CONFIG.tasks.find((t) => t.id === id) || CONFIG.tasks[0];
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
  meta.textContent = bits.join(' \u00b7 ');
  meta.className = 'task-meta is-' + catKey;
}
function renderTaskPrompt() {
  const ta = $('#customPrompt');
  if ($('#taskSelect').value === 'custom') {
    $('#taskPrompt').textContent = 'Your prompt is sent verbatim to every model slot. No automated tests run \u2014 you get live output, tokens, cost, speed and thinking.';
    ta.classList.remove('hidden');
  } else {
    $('#taskPrompt').textContent = currentTask().prompt;
    ta.classList.add('hidden');
  }
  renderTaskMeta();
}

function priceTag(c) { return `$${(+c.price.input).toFixed(2)} / $${(+c.price.output).toFixed(2)}`; }

// The reasoning level this model is actually sent. Computed on the server from
// the same code that builds the request, so it can't drift from the wire.
// `mode` drives the colour: an explicit effort/budget reads stronger than a
// model-chosen "auto", which in turn reads stronger than nothing being sent.
function thinkTag(t) {
  if (!t || !t.label) return '';
  return `<div class="col-think think-${esc(t.mode || 'unknown')}" title="${esc(t.detail || '')}">`
       + `<span class="ti">◈</span>${esc(t.label)}</div>`;
}

// On a live card the badge becomes a picker: the levels come from the server's
// per-model list, and each option carries the exact request it produces, so the
// tooltip always matches what will be sent. Restored history runs stay read-only.
function thinkControl(m, isRestore) {
  const o = m.thinkingOptions;
  if (isRestore || !o || !o.configurable || !o.options.length) return thinkTag(m.thinking);
  const cur = m.effort || '';
  const sel = o.options.find((x) => x.value === cur) || o.options[0];
  const opts = o.options.map((x) =>
    `<option value="${esc(x.value)}"${x.value === cur ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
  return `<div class="col-think think-ctl${cur ? ' is-set' : ''}" title="${esc((sel && sel.detail) || o.note || '')}">`
       + `<span class="ti">◈</span>`
       + `<select class="think-select" draggable="false" data-slot="${esc(m.slot)}" `
       + `aria-label="Thinking level for ${esc(m.label)}">${opts}</select></div>`;
}

// Vendor heading for the palette — a flat list of ~18 chips is hard to scan.
function paletteGroup(c) {
  const pub = c.publisher || 'google';
  if (c.provider === 'agentplatform') return pub === 'anthropic' ? 'Claude · Vertex' : 'Gemini · Vertex';
  if (c.provider === 'gemini') return 'Gemini · direct';
  if (c.provider === 'openai') return 'OpenAI · external';
  if (c.provider === 'moonshot') return 'Moonshot · external';
  if (c.provider === 'anthropic') return 'Anthropic · direct';
  return c.provider;
}

// Can this catalog model actually be run right now? True when either the user
// has a personal key for its provider or the server has a shared one. Models
// that fail this are shown greyed out and cannot be dragged into a slot —
// better than letting someone build a comparison that errors on Run.
function modelAvailability(c) {
  const k = loadKeys();
  const present = (CONFIG && CONFIG.keysPresent) || {};
  const pub = c.publisher || 'google';
  // Known-unrunnable on this project (e.g. no Vertex serving quota). Listed so
  // it's visibly accounted for, but never selectable.
  if (c.blocked) return { ok: false, blocked: true, need: c.blocked, how: c.blockedHow || 'Google Cloud console' };
  if (c.provider === 'agentplatform' && pub === 'anthropic') {
    return { ok: present.claude || !!k.claudeBearerToken, need: 'Claude on Vertex', how: 'the server’s service account' };
  }
  if (c.provider === 'agentplatform' || c.provider === 'gemini') {
    return { ok: !!(k.agentplatform || k.gemini) || !!present.agentplatform, need: 'a Gemini / Agent Platform key', how: 'Your API keys' };
  }
  if (c.provider === 'openai') return { ok: !!k.openai || !!present.openai, need: 'an OpenAI key', how: 'Your API keys' };
  if (c.provider === 'moonshot') return { ok: !!k.moonshot || !!present.moonshot, need: 'a Moonshot key', how: 'Your API keys' };
  if (c.provider === 'anthropic') return { ok: !!k.anthropic || !!present.anthropic, need: 'an Anthropic key', how: 'Your API keys' };
  return { ok: true };
}
function extBadge(c) { return c.external ? '<span class="ext-badge" title="Not on Vertex — needs its own API key; the prompt leaves Google infrastructure">EXT</span>' : ''; }

function renderModelEditors() {
  // ---- palette: every catalog model not currently in a slot ----
  const pal = $('#modelPalette');
  if (pal) {
    pal.innerHTML = '';
    const avail = catalog().filter((c) => !slotOf(c.id));
    if (!avail.length) {
      pal.appendChild(el('span', 'add-note', 'Every model is in a slot — drag one out or swap.'));
    } else {
      // Group by vendor — with 18 models a flat list is hard to scan.
      const groups = new Map();
      avail.forEach((c) => {
        const g = paletteGroup(c);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(c);
      });
      let host = pal;
      const addTo = (c) => {
        const av = modelAvailability(c);
        const chip = el('div', 'model-chip' + (av.ok ? '' : ' unavailable'));
        chip.draggable = av.ok;                       // no key ⇒ not draggable at all
        chip.dataset.id = c.id;
        if (!av.ok) chip.dataset.locked = '1';
        chip.title = av.ok
          ? `${c.label} (${c.model}) — drag into a slot, or click`
          : av.blocked
            ? `${c.label} can't run on this project: needs ${av.need}. Fix it in ${av.how}.`
            : `${c.label} needs ${av.need}. Add one under “${av.how}” to enable it.`;
        chip.innerHTML = `<span class="am-ic">${modelIconSvg(c)}</span><b>${esc(c.label)}</b>${extBadge(c)}`
          + (av.ok ? `<span class="am-price">${priceTag(c)}</span>`
                   : `<span class="am-nokey">${av.blocked ? '🚫 no quota' : '🔒 no key'}</span>`);
        if (av.ok) {
          chip.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', c.id);
            e.dataTransfer.effectAllowed = 'move';
            chip.classList.add('dragging');
          });
          chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
          chip.addEventListener('click', () => placeInFirstFreeSlot(c.id));
        } else {
          // belt and braces: even a synthesised dragstart carries nothing
          chip.addEventListener('dragstart', (e) => e.preventDefault());
          chip.addEventListener('click', () => {
            // no key for this provider — point the user at where to add one
            const m = $('#apiKeysBtn');
            if (m) { m.classList.remove('nudge'); void m.offsetWidth; m.classList.add('nudge'); }
          });
        }
        host.appendChild(chip);
      };
      groups.forEach((models, name) => {
        const grp = el('div', 'palette-group');
        // Groups share the row proportionally to how many models they hold, so a
        // 10-model vendor gets the width it needs while a 2-model one doesn't
        // reserve a whole line. They re-flow as the window resizes.
        grp.style.flex = `${models.length} 1 ${Math.min(240 + models.length * 40, 560)}px`;
        grp.innerHTML = `<div class="pg-label">${esc(name)} <span class="pg-count">${models.length}</span></div>`;
        const row = el('div', 'pg-chips');
        grp.appendChild(row);
        host = row;
        models.forEach(addTo);
        pal.appendChild(grp);
      });
      host = pal;
    }
  }

  // The comparison cards in the arena ARE the drop targets — there is no separate
  // slot row (it just duplicated what the arena already shows). See buildArena().

  // dropping back onto the palette clears the model from its card
  if (pal) {
    pal.addEventListener('dragover', (e) => { e.preventDefault(); pal.classList.add('drag-over'); });
    pal.addEventListener('dragleave', () => pal.classList.remove('drag-over'));
    pal.addEventListener('drop', (e) => {
      e.preventDefault();
      pal.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      const s = id && slotOf(id);
      if (s) clearSlot(s);
    });
  }
}

// ---------- arena scaffolding ----------
function buildArena(models) {
  const arena = $('#arena');
  arena.innerHTML = '';
  const task = currentTask();
  // What is actually on screen right now. A restored history run can render a
  // different model set than the current selection, and "Run again" must re-run
  // the model in THAT column, not whatever is selected in the editor.
  ARENA_MODELS = (models || MODELS).slice();
  // A restored history run renders exactly its own models; otherwise every slot
  // gets a column, empty ones included, so they can be dropped onto directly.
  const isRestore = !!models;
  // Cells in slot order, so empty drop targets sit in their proper position.
  const cells = isRestore
    ? ARENA_MODELS.map((m) => ({ slot: m.slot, m }))
    : SLOT_IDS.map((slot) => ({ slot, m: ARENA_MODELS.find((x) => x.slot === slot) || null }));
  cells.forEach(({ slot: cellSlot, m }) => {
    if (!m) {
      const drop = el('div', 'col is-empty');
      drop.dataset.slot = cellSlot;
      drop.style.setProperty('--accent', slotColor(cellSlot));
      drop.innerHTML = '<div class="col-drop"><span>＋</span>Drop a model here</div>';
      arena.appendChild(drop);
      return;
    }
    const col = el('div', 'col');
    col.dataset.slot = m.slot;
    col.id = `col-${m.slot}`;
    col.style.setProperty('--accent', slotColor(m.slot)); // CSS drives the identity strip, edge-light, glows
    col.innerHTML = `
      <div class="col-head"${isRestore ? '' : ` draggable="true" data-id="${esc(m.catalogId || '')}"`}>
        <span class="col-accent" style="background:${slotColor(m.slot)}"></span>
        <span class="col-ic">${modelIconSvg(m)}</span>
        <div class="col-id">
          <div class="col-title">${esc(m.label)}${m.external ? '<span class="ext-badge">EXT</span>' : ''}</div>
          <div class="col-sub">${esc(m.provider)} · ${esc(m.model)}${m.price ? ` <span class="col-price">${priceTag(m)} / 1M</span>` : ''}</div>
          ${thinkControl(m, isRestore)}
        </div>
        <button class="rerun-btn" type="button" data-slot="${m.slot}" disabled
          title="Re-run just this model on the current task — the other columns are left alone">↻ Run again</button>
        ${isRestore ? '' : `<button class="col-remove" type="button" data-slot="${m.slot}" title="Remove this model">&times;</button>`}
      </div>
      <div class="col-status" id="status-${m.slot}"><span>Idle — press Run.</span></div>
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

  // Per-card thinking level. The header is draggable, and a <select> inside a
  // draggable element starts a drag instead of opening — so the parent's
  // draggable is switched off while the picker is in use.
  arena.querySelectorAll('.think-select').forEach((sel) => {
    const head = sel.closest('.col-head');
    const wrap = sel.closest('.col-think');
    const undrag = () => { if (head) head.setAttribute('draggable', 'false'); };
    const redrag = () => { if (head && head.dataset.id) head.setAttribute('draggable', 'true'); };
    sel.addEventListener('mousedown', undrag);
    sel.addEventListener('focus', undrag);
    sel.addEventListener('blur', redrag);
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => {
      const slot = sel.dataset.slot;
      SLOT_EFFORT[slot] = sel.value || null;
      syncModelsFromSlots();                       // MODELS is what gets POSTed
      const m = MODELS.find((x) => x.slot === slot);
      const opt = m && m.thinkingOptions && m.thinkingOptions.options.find((x) => x.value === (sel.value || ''));
      if (wrap) {
        wrap.title = (opt && opt.detail) || '';
        wrap.classList.toggle('is-set', !!sel.value);
      }
      redrag();
    });
  });

  if (isRestore) return;   // a restored run is a snapshot, not the live selection

  // The comparison cards are the drop targets: drop a palette model onto one to
  // load it there, or drag a card's header onto another card to move/swap.
  arena.querySelectorAll('.col-remove').forEach((b) =>
    b.addEventListener('click', (e) => { e.stopPropagation(); clearSlot(e.currentTarget.dataset.slot); }));
  arena.querySelectorAll('.col-head[draggable="true"]').forEach((head) => {
    head.addEventListener('dragstart', (e) => {
      if (!head.dataset.id) return;
      e.dataTransfer.setData('text/plain', head.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      head.closest('.col').classList.add('dragging');
    });
    head.addEventListener('dragend', () => {
      const c = head.closest('.col'); if (c) c.classList.remove('dragging');
    });
  });
  arena.querySelectorAll('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('drag-over'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (id) assignToSlot(id, col.dataset.slot);
    });
  });
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
    const resp = await fetch('/api/judge', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: currentTask().id, prompt: $('#customPrompt').value, judge: judgeId, entries, keys: loadKeys() }),
    });
    if (resp.status === 401) { window.location.replace('/login'); return; }
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
      // No readable thinking text came back. Distinguish "thought, but the text is
      // withheld" from "didn't think at all" — they look identical without the count.
      const tok = rtok != null ? rtok : Number(node.dataset.rtok || 0);
      val = tok > 0
        ? `This model used ${fmtInt(tok)} thinking tokens, but returned no readable reasoning text. Claude Opus 4.8 streams its chain-of-thought as an encrypted, signed trace — the API exposes the thinking-token count but not the words, so there is nothing to display here even though the model genuinely did reason. (Gemini streams its actual thoughts, which is why you can read those.)`
        : 'No measurable thinking on this task — the model answered directly (0 thinking tokens reported).';
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
async function streamRun(payload, results, signal, own) {
  const resp = await fetch('/api/run', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (resp.status === 401) { window.location.replace('/login'); return 'auth'; } // session expired mid-use
  if (resp.status === 429) {                                                     // daily per-user run limit
    const j = await resp.json().catch(() => ({}));
    if (j && j.quota) {
      if (payload.mode === 'single') mySingleQuota = j.quota; else myQuota = j.quota;
      updateQuotaBadge();
    }
    window._lastQuotaMsg = (j && j.error) || 'Daily limit reached. Try again tomorrow.';
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
    keys: loadKeys(), // bring-your-own keys (empty {} ⇒ shared keys, subject to the daily limit)
  };

  LAST_RESULTS = {};
  const results = LAST_RESULTS;
  try {
    const st = await streamRun(payload, results, undefined, own);
    if (st === 'auth') return;
    if (st === 'quota') {
      const m = window._lastQuotaMsg;
      slots.forEach((s) => { if (ownsSlot(own, s)) setStatus(s, m, 'err'); });
      window.alert(m);
      return;
    }
  } catch (e) {
    slots.forEach((s) => { if (!results[s] && ownsSlot(own, s)) setStatus(s, 'Error: ' + esc(e.message), 'err'); });
  } finally {
    if (wallTimer) { clearInterval(wallTimer); wallTimer = null; }
    btn.textContent = 'Run comparison ▸';
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
      keys: loadKeys(),
    }, LAST_RESULTS, ac.signal, own);
    if (st === 'auth') return;
    if (st === 'quota' && ownsSlot(own, slot)) { setStatus(slot, window._lastQuotaMsg, 'err'); window.alert(window._lastQuotaMsg); return; }
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
      if (ev.reasoning !== undefined) setThink(ev.slot, ev.reasoning, null);
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
      if (ev.reasoning !== undefined) setThink(ev.slot, ev.reasoning, null);
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

// Repaint one column from a saved/finished result (mirrors the live 'done' handler; never auto-runs).
function applyResultToColumn(slot, r) {
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
  const canMd = mdState.markdown && typeof parser === 'function';
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
