// ---------------------------------------------------------------------------
// LLM Agent Arena — frontend
// ---------------------------------------------------------------------------

const PALETTE = ['#5e8bff', '#2fd9a6', '#ff9e6d', '#b388ff', '#ffcb5e', '#22e0ff']; // Aurora accents
const MIN_SLOTS = 1;
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
const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
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
  myQuota = CONFIG.me && CONFIG.me.quota; // seed the daily-runs counter
  initUserMenu(CONFIG.me);
  MODELS = CONFIG.models.map((m) => ({ ...m, price: { ...m.price } }));

  // key status pills
  const ks = $('#keyStatus');
  const pill = (label, ok) => ks.appendChild(el('span', 'key-pill' + (ok ? ' ok' : ''),
    `<span class="dot"></span>${label} ${ok ? 'ready' : 'missing'}`));
  pill('Agent Platform key', !!CONFIG.keysPresent.agentplatform);
  pill('Claude OAuth token', !!CONFIG.keysPresent.claude);

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

  $('#runBtn').addEventListener('click', run);
  { const ar = $('#autoRun'); if (ar) ar.addEventListener('click', () => {
    const on = !ar.classList.contains('is-on');
    ar.classList.toggle('is-on', on);
    ar.setAttribute('aria-pressed', String(on));
  }); }
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
  { const al = $('#accessDocLink'); if (al) al.hidden = ME.role !== 'admin'; }

  const chip = $('#userChip');
  const dd = $('#userDropdown');
  const toggle = (open) => { dd.hidden = open === undefined ? !dd.hidden : !open; chip.setAttribute('aria-expanded', String(!dd.hidden)); };
  chip.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) toggle(false); });

  $('#logoutBtn').addEventListener('click', logout);
  $('#changePwBtn').addEventListener('click', () => { toggle(false); openChangePwModal(); });
  $('#manageUsersBtn').addEventListener('click', () => { toggle(false); openUsersModal(); });
  $('#apiKeysBtn').addEventListener('click', () => { toggle(false); openKeysModal(); });
}

// ---------- bring-your-own API keys (stored only in this browser) ----------
function loadKeys() { try { return JSON.parse(localStorage.getItem('ullm.keys') || '{}') || {}; } catch (e) { return {}; } }
function saveKeys(k) { try { localStorage.setItem('ullm.keys', JSON.stringify(k)); } catch (e) { /* ignore */ } }
function hasOwnKeys() { const k = loadKeys(); return !!(k.agentplatform || k.gemini || k.openai || k.anthropic || k.claudeBearerToken); }

// Live "runs left today" state (authoritative value comes from the server on
// /api/config load and on each run's `quota` event).
let myQuota = null;

// Badge near Run: your-keys (unlimited), or a live shared-key counter.
function updateQuotaBadge() {
  const b = $('#quotaBadge'); if (!b) return;
  const limit = (CONFIG && CONFIG.maxRunsPerDay) || 0;
  const isAdmin = ME && ME.role === 'admin';
  if (hasOwnKeys()) { b.textContent = '🔑 Your keys · no daily limit'; b.className = 'quota-badge own'; b.title = ''; return; }
  if (isAdmin || !limit) { b.textContent = ''; b.className = 'quota-badge'; b.title = ''; return; }
  const remaining = (myQuota && typeof myQuota.remaining === 'number') ? myQuota.remaining : limit;
  b.textContent = `${remaining} of ${limit} free runs left today`;
  b.className = 'quota-badge ' + (remaining <= 0 ? 'out' : remaining <= 3 ? 'low' : 'shared');
  b.title = (myQuota && myQuota.resetAt) ? ('Resets at ' + new Date(myQuota.resetAt).toLocaleString() + '. Add your own API keys to remove the limit.')
    : 'Add your own API keys to remove the daily limit.';
}

function openKeysModal() {
  const body = openAuthModal('Your API keys');
  const k = loadKeys();
  const limit = (CONFIG && CONFIG.maxRunsPerDay) || 20;
  body.innerHTML =
    '<p class="keys-intro">Add your own API keys to run comparisons <b>without the daily limit</b>. Keys are stored only in <b>this browser</b> and sent to the server just for your runs — never persisted server-side. Leave blank to use the shared keys (capped at ' + limit + '/day).</p>' +
    '<form class="add-user-form" id="keysForm">' +
      '<div class="auth-field"><label>Gemini / Agent Platform API key</label><input id="k-gem" type="password" autocomplete="off" spellcheck="false" placeholder="used for the Gemini slots" value="' + esc(k.agentplatform || k.gemini || '') + '" /></div>' +
      '<div class="auth-field"><label>OpenAI API key</label><input id="k-openai" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" value="' + esc(k.openai || '') + '" /></div>' +
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
    set('#k-openai', 'openai'); set('#k-anthropic', 'anthropic'); set('#k-claude', 'claudeBearerToken'); set('#k-proj', 'gcpProject');
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
    '</form>';

  body.querySelectorAll('.u-del').forEach((b) => b.addEventListener('click', () => deleteUser(b.dataset.user, body)));
  body.querySelector('#addUserForm').addEventListener('submit', (e) => { e.preventDefault(); addUser(body); });
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

// Add a preconfigured catalog model (by its catalog id). Settings come straight
// from the catalog — the user can't modify price/provider/model.
function addModel(catalogId) {
  if (MODELS.length >= MAX_SLOTS) return;
  const c = catalog().find((x) => x.id === catalogId);
  if (!c) return;
  if (MODELS.some((m) => m.catalogId === c.id)) return; // each model at most once
  const slot = nextSlotId();
  MODELS.push({
    slot, catalogId: c.id, label: c.label,
    provider: c.provider, publisher: c.publisher, model: c.model,
    price: { input: c.price.input, output: c.price.output },
  });
  renderModelEditors();
  buildArena();
}
function removeModel(i) {
  if (MODELS.length <= MIN_SLOTS) return;
  MODELS.splice(i, 1);
  renderModelEditors();
  buildArena();
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

function renderModelEditors() {
  const wrap = $('#modelEditors');
  wrap.innerHTML = '';
  // Selected models — read-only cards (settings are preconfigured & locked).
  MODELS.forEach((m, i) => {
    const price = `$${(+m.price.input).toFixed(2)} in · $${(+m.price.output).toFixed(2)} out`;
    const card = el('div', 'model-card-locked');
    card.style.borderTop = `3px solid ${slotColor(m.slot)}`;
    card.innerHTML = `
      <div class="card-head">
        <h4><span class="mc-ic">${modelIconSvg(m)}</span>${esc(m.label)}</h4>
        <button class="remove-slot" data-rm="${i}" type="button" title="Remove this model"${MODELS.length <= MIN_SLOTS ? ' disabled' : ''}>&times;</button>
      </div>
      <div class="mc-row"><span class="mc-key">Model</span><span class="mc-val mono">${esc(m.provider)} · ${esc(m.model)}</span></div>
      <div class="mc-row"><span class="mc-key">Price</span><span class="mc-val">${price} <span class="mc-per">/ 1M tok</span></span></div>
      <div class="mc-locked" title="Model settings are preconfigured from public pricing and can’t be edited">🔒 Preconfigured</div>`;
    wrap.appendChild(card);
  });
  wrap.querySelectorAll('.remove-slot').forEach((b) =>
    b.addEventListener('click', (e) => removeModel(+e.currentTarget.dataset.rm)));

  // Add-picker: one chip per catalog model not already selected.
  const addWrap = $('#addModels');
  if (!addWrap) return;
  addWrap.innerHTML = '';
  if (MODELS.length >= MAX_SLOTS) {
    addWrap.appendChild(el('span', 'add-note', `Maximum ${MAX_SLOTS} models selected.`));
    return;
  }
  const present = new Set(MODELS.map((m) => m.catalogId));
  const avail = catalog().filter((c) => !present.has(c.id));
  if (!avail.length) {
    addWrap.appendChild(el('span', 'add-note', 'All available models are selected.'));
    return;
  }
  avail.forEach((c) => {
    const chip = el('button', 'add-model-chip',
      `<span class="am-plus">+</span><span class="am-ic">${modelIconSvg(c)}</span> ${esc(c.label)} <span class="am-price">$${(+c.price.input).toFixed(2)} / $${(+c.price.output).toFixed(2)}</span>`);
    chip.type = 'button';
    chip.title = `Add ${c.label} (${c.model})`;
    chip.addEventListener('click', () => addModel(c.id));
    addWrap.appendChild(chip);
  });
}

// ---------- arena scaffolding ----------
function buildArena(models) {
  const arena = $('#arena');
  arena.innerHTML = '';
  const task = currentTask();
  (models || MODELS).forEach((m) => {
    const col = el('div', 'col');
    col.dataset.slot = m.slot;
    col.id = `col-${m.slot}`;
    col.style.setProperty('--accent', slotColor(m.slot)); // CSS drives the identity strip, edge-light, glows
    col.innerHTML = `
      <div class="col-head">
        <span class="col-accent" style="background:${slotColor(m.slot)}"></span>
        <span class="col-ic">${modelIconSvg(m)}</span>
        <div>
          <div class="col-title">${esc(m.label)}</div>
          <div class="col-sub">${esc(m.provider)} · ${esc(m.model)}</div>
        </div>
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
  arena.querySelectorAll('.md-magnify').forEach((b) =>
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openMagnify(b.dataset.slot, b.dataset.kind); }));
}

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
async function run() {
  const btn = $('#runBtn');
  btn.disabled = true;
  btn.textContent = 'Running…';
  $('#scorecard').classList.add('hidden');

  buildArena();
  slotIds().forEach((s) => setStatus(s, 'Queued…', 'run'));
  $('#arena').scrollIntoView({ behavior: 'smooth', block: 'start' }); // bring the model cards to the top

  // Wall clock starts ticking immediately — keeps running while a model is only
  // thinking (no tokens yet). Each slot freezes to the server's measured wallMs on 'done'.
  wallFinished.clear();
  wallStartMs = performance.now();
  if (wallTimer) clearInterval(wallTimer);
  wallTimer = setInterval(() => {
    const secs = ((performance.now() - wallStartMs) / 1000).toFixed(1) + 's';
    slotIds().forEach((s) => { if (!wallFinished.has(s)) setTileVal(s, 'time', secs); });
  }, 100);

  const payload = {
    taskId: $('#taskSelect').value,
    maxIterations: 1, // single-shot: correctness = the model's first-attempt pass rate (no self-debug retries)
    models: MODELS,
    customPrompt: $('#customPrompt').value,
    keys: loadKeys(), // bring-your-own keys (empty {} ⇒ shared keys, subject to the daily limit)
  };

  const results = {};
  try {
    const resp = await fetch('/api/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (resp.status === 401) { window.location.replace('/login'); return; } // session expired mid-use
    if (resp.status === 429) { // daily per-user run limit reached
      const j = await resp.json().catch(() => ({}));
      if (j && j.quota) { myQuota = j.quota; updateQuotaBadge(); }
      const m = (j && j.error) || 'Daily comparison limit reached. Try again tomorrow.';
      slotIds().forEach((s) => setStatus(s, m, 'err'));
      window.alert(m);
      return;
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
        if (line) handleEvent(JSON.parse(line), results);
      }
    }
  } catch (e) {
    slotIds().forEach((s) => { if (!results[s]) setStatus(s, 'Error: ' + esc(e.message), 'err'); });
  } finally {
    if (wallTimer) { clearInterval(wallTimer); wallTimer = null; }
    btn.disabled = false;
    btn.textContent = 'Run comparison ▸';
  }
}

function handleEvent(ev, results) {
  switch (ev.type) {
    case 'start':
      break;
    case 'quota': // server's authoritative daily-runs count for this run
      if (ev.quota && ev.quota.limited) { myQuota = ev.quota; updateQuotaBadge(); }
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
        setStatus(ev.slot, msg, 'done');
      }
      break;
    case 'model_error':
      results[ev.slot] = { slot: ev.slot, label: ev.label, error: ev.message };
      wallFinished.add(ev.slot);
      setStatus(ev.slot, 'Error: ' + esc(ev.message), 'err');
      break;
    case 'all_done':
      finalize(results);
      // Durable, per-user run history is written SERVER-SIDE on run completion — nothing to POST here.
      // Bring the Model comparison scorecard to the top now that the run is done.
      setTimeout(() => {
        const sc = $('#scorecard');
        if (sc && !sc.classList.contains('hidden')) sc.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
      break;
    case 'error':
      slotIds().forEach((s) => { if (!results[s]) setStatus(s, 'Error: ' + esc(ev.message), 'err'); });
      break;
  }
}

// ---------- finalize: metrics + scorecard ----------
function finalize(resultsMap, slots) {
  const results = (slots || slotIds()).map((s) => resultsMap[s]).filter((r) => r && !r.error);
  if (!results.length) return;

  // Star the best live tile for each metric (lower cost/time/tokens = better,
  // higher tokens/sec = better).
  const answerOf = (r) => Math.max(0, r.completionTokens - (r.reasoningTokens || 0));
  const bestTps = Math.max(...results.map((r) => r.tokensPerSec));
  const bestCost = Math.min(...results.map((r) => r.costUsd));
  const bestTime = Math.min(...results.map((r) => r.wallMs));
  const bestTok = Math.min(...results.map(answerOf));        // fewest answer tokens = most concise
  results.forEach((r) => {
    markWin(r.slot, 'tok', answerOf(r) === bestTok);
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
  const track = m.dir === 'neutral'
    ? 'linear-gradient(90deg, var(--mp-neutral), var(--mp-neutral))'
    : 'linear-gradient(90deg, #0ca30c 0%, #fab219 52%, #d03b3b 100%)';
  const rows = vals.map(({ r, v }) => {
    let pct = ((v - min) / span) * 100;          // 0 = best end
    if (m.dir === 'higher') pct = 100 - pct;
    return `<div class="mp-row" title="${esc(r.label)}: ${esc(m.fmt(v))}">
      <span class="mp-rname">${modelIconSvg(r)}<span>${esc(shortLabel(r.label))}</span></span>
      <span class="mp-track" style="background-image:${track}"><span class="mp-mark" style="left:calc(${pct.toFixed(1)}% - 3px)"></span></span>
      <span class="mp-rval">${esc(m.fmt(v))}</span>
    </div>`;
  }).join('');
  const ends = m.dir === 'neutral' ? ['shortest', 'longest'] : ['best', 'worst'];
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
let historyScope = 'me';
let historyPage = 0;
const HIST_PAGE_SIZE = 6;           // rows rendered at once — keeps the DOM small however big history grows
let _histState = { body: null, runs: [], usage: null, isAdmin: false };
function fmtWhen(ms) { try { return new Date(ms).toLocaleString(); } catch (e) { return ''; } }

async function openHistoryModal() {
  const isAdmin = ME && ME.role === 'admin';
  if (!isAdmin) historyScope = 'me';
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
    historyPage = 0;                 // reset to first page on (re)open / scope change
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
  const scopeToggle = isAdmin
    ? `<div class="hist-scope">
         <button class="hs-btn ${historyScope === 'me' ? 'active' : ''}" data-scope="me" type="button">My runs</button>
         <button class="hs-btn ${historyScope === 'all' ? 'active' : ''}" data-scope="all" type="button">All users</button>
       </div>`
    : '';
  const total = runs.length;
  const pageCount = Math.max(1, Math.ceil(total / HIST_PAGE_SIZE));
  historyPage = Math.min(Math.max(0, historyPage), pageCount - 1);   // clamp (e.g. after deleting the last row on a page)
  const start = historyPage * HIST_PAGE_SIZE;
  const pageRuns = runs.slice(start, start + HIST_PAGE_SIZE);
  const rows = total
    ? pageRuns.map((h) => histRowHtml(h)).join('')
    : '<p class="auth-loading">No runs yet — run a comparison and it will appear here so you can revisit or re-showcase it.</p>';
  const pager = total > HIST_PAGE_SIZE ? histPagerHtml(historyPage, pageCount, total, start, pageRuns.length) : '';
  body.innerHTML = usagePanel + scopeToggle + `<div class="hist-list">${rows}</div>` + pager;
  body.querySelectorAll('.hs-btn').forEach((b) => b.addEventListener('click', () => { historyScope = b.dataset.scope; openHistoryModal(); }));
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
  const who = (historyScope === 'all' && h.userName) ? `<span class="hist-who">${esc(h.userName)}</span>` : '';
  return `<div class="hist-row">
    <div class="hist-main"><div class="hist-title">${esc(h.title)}${who}</div><div class="hist-when">${esc(fmtWhen(h.at))}</div><div class="hist-chips">${chips}</div></div>
    <div class="hist-act"><button class="submit-btn hist-restore" data-id="${esc(h.id)}">Restore ▸</button><button class="u-del hist-del" data-id="${esc(h.id)}">Delete</button></div>
  </div>`;
}

function renderUsagePanel(u) {
  const t = u.totals || {};
  const rows = (u.users || []).slice(0, 15).map((x) =>
    `<tr><td class="u-name">${esc(x.userName || x.user)}</td><td>${fmtInt(x.runs)}</td><td>${fmtInt(x.runsToday)}</td><td>${esc(fmtCost(x.costUsd))}</td><td class="hist-when">${esc(x.lastAt ? fmtWhen(x.lastAt) : '—')}</td></tr>`
  ).join('');
  return `<div class="usage-panel">
    <div class="usage-stats">
      <div class="ustat"><div class="uk">Active users</div><div class="uv">${fmtInt(t.users || 0)}</div></div>
      <div class="ustat"><div class="uk">Runs today</div><div class="uv">${fmtInt(t.runsToday || 0)}</div></div>
      <div class="ustat"><div class="uk">Runs total</div><div class="uv">${fmtInt(t.totalRuns || 0)}</div></div>
    </div>
    ${rows ? `<table class="usage-table"><thead><tr><th>User</th><th>Runs</th><th>Today</th><th>Cost</th><th>Last run</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    <p class="hint">Usage across all users (today = since 00:00 UTC).</p>
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
