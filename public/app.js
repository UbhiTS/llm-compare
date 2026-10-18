// ---------------------------------------------------------------------------
// LLM Agent Arena — frontend
// ---------------------------------------------------------------------------

const PALETTE = ['#5e8bff', '#2fd9a6', '#ff9e6d', '#b388ff', '#ffcb5e', '#22e0ff']; // Aurora accents
const MIN_SLOTS = 1; // keep at least 1 active slot
const MAX_SLOTS = 6; // compare up to 6 models / thinking modes at a time
let CONFIG = null;       // from /api/config
let MODELS = [];         // current editable model configs (the dynamic source of truth)
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
const ICON_OPENAI = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2" fill="none" stroke="#10a37f" stroke-width="2"/><polygon points="12,5.6 17.5,8.8 17.5,15.2 12,18.4 6.5,15.2 6.5,8.8" fill="none" stroke="#10a37f" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_GENERIC = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>';
// Pick a brand mark from a model's publisher / provider / model id / label.
function modelIconSvg(m) {
  const s = (((m && m.providerFamily) || '') + ' ' + ((m && m.publisher) || '') + ' ' + ((m && m.provider) || '') + ' ' + ((m && m.model) || '') + ' ' + ((m && m.label) || '')).toLowerCase();
  if (s.indexOf('anthropic') >= 0 || s.indexOf('claude') >= 0) return ICON_CLAUDE;
  if (s.indexOf('openai') >= 0 || s.indexOf('gpt') >= 0) return ICON_OPENAI;
  if (s.indexOf('gemini') >= 0 || s.indexOf('google') >= 0) return ICON_GEMINI;
  if (s.indexOf('xai') >= 0 || s.indexOf('grok') >= 0) return ICON_GROK;
  if (s.indexOf('meta') >= 0 || s.indexOf('llama') >= 0) return ICON_META;
  if (s.indexOf('deepseek') >= 0) return ICON_DEEPSEEK;
  if (s.indexOf('qwen') >= 0 || s.indexOf('alibaba') >= 0) return ICON_QWEN;
  return ICON_GENERIC;
}
const ICON_PDF = '<svg class="hist-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
const ICON_TRASH = '<svg class="hist-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
const ICON_STAR_OFF = '<svg class="hist-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
const ICON_STAR_ON = '<svg class="hist-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
// Manage external users: compact action icons (stroke = currentColor, sized by .u-icon-btn svg).
const U_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
// lock inside a circular arrow = "force a password reset on next sign-in"
const ICON_LOCK_RESET = U_ICON_SVG + '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><rect x="8.5" y="11.5" width="7" height="6" rx="1.2"/><path d="M10 11.5V10a2 2 0 0 1 4 0v1.5"/></svg>';
// key = "set a temporary password"
const ICON_KEY = U_ICON_SVG + '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="m16 7 3 3"/><path d="m19 4 2 2"/></svg>';
// gauge = "daily Vertex AI cap & account expiry"
const ICON_GAUGE = U_ICON_SVG + '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>';
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
  document.querySelectorAll('#themeSwitch button').forEach((b) => {
    const on = b.dataset.theme === t;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
function initTheme() {
  let t = 'medium';
  try { t = localStorage.getItem('ullm.theme') || 'medium'; } catch (e) { /* ignore */ }
  applyTheme(t);
  const sw = document.querySelector('#themeSwitch');
  if (sw) sw.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.theme)));
}

const TASK_CATEGORIES = [
  ['custom', '✏️ Custom Prompt'],
  ['industry', '🏢 Industry Architecture & Verticals'],
  ['security', '🛡️ Cybersecurity & SecOps'],
  ['engineering', '💻 Software, Systems & Games'],
  ['strategy', '📊 Strategy, Operations & Governance'],
];

const TEXT_SUBCATEGORIES_BY_CATEGORY = {
  industry: [
    ['enterprise', '🏛️ Enterprise Cloud & M&A'],
    ['retail', '🛍️ Retail & Omnichannel Commerce'],
    ['semiconductor', '🔬 Semiconductor & Silicon EDA'],
    ['transport', '🚆 Transport & Fleet Logistics'],
    ['finance', '💳 Financial Services & Risk'],
    ['healthcare', '🏥 Healthcare & Life Sciences'],
  ],
  security: [
    ['sec-patching', '🩹 Automated Vulnerability Patching'],
    ['sec-operations', '🕵️ Threat Hunting & Red-Teaming'],
  ],
  engineering: [
    ['sys-engineering', '⚙️ Distributed Systems, DBs & Compilers'],
    ['wasm-games', '🎮 Interactive WebAssembly Games'],
    ['algo-viz', '🧩 Algorithms & Visualizers'],
  ],
  strategy: [
    ['ops-cx', '📦 Supply Chain, Workforce & CX'],
    ['governance-rca', '⚖️ Incident RCA & Compliance'],
    ['mission-travel', '🌐 Aerospace & Travel Planning'],
  ],
};

const TEXT_SUBCATEGORY_LABELS = {
  enterprise: '🏛️ Enterprise Cloud & M&A',
  retail: '🛍️ Retail & Omnichannel Commerce',
  semiconductor: '🔬 Semiconductor & Silicon EDA',
  transport: '🚆 Transport & Fleet Logistics',
  finance: '💳 Financial Services & Risk',
  healthcare: '🏥 Healthcare & Life Sciences',
  'sec-patching': '🩹 Automated Vulnerability Patching',
  'sec-operations': '🕵️ Threat Hunting & Red-Teaming',
  'sys-engineering': '⚙️ Distributed Systems, DBs & Compilers',
  'wasm-games': '🎮 Interactive WebAssembly Games',
  'algo-viz': '🧩 Algorithms & Visualizers',
  'ops-cx': '📦 Supply Chain, Workforce & CX',
  'governance-rca': '⚖️ Incident RCA & Compliance',
  'mission-travel': '🌐 Aerospace & Travel Planning',
};

const CAD_VERTICAL_CATEGORIES = [
  ['cad3d-automotive',  '🚗 Automotive & Powertrain',              'automotive'],
  ['cad3d-medical',     '🏥 Medical & Biotech Devices',            'medical'],
  ['cad3d-electronics', '🔌 Electronics, Thermal & Semiconductor', 'electronics'],
  ['cad3d-aerospace',   '✈️ Aerospace & Turbomachinery',           'aerospace'],
  ['cad3d-robotics',    '🤖 Robotics & Motion Control',            'robotics'],
  ['cad3d-industrial',  '🏭 Industrial Hardware, Piping & Tooling','industrial'],
  ['cad3d-all',         '🧊 All Manufacturing Verticals',          null],
  ['custom',            '✏️ Custom 3D / CAD Prompt',               null],
];

const CAD_VERTICAL_LABELS = {
  automotive:  '🚗 Automotive & Powertrain',
  medical:     '🏥 Medical & Biotech',
  electronics: '🔌 Electronics & Semiconductor',
  aerospace:   '✈️ Aerospace & Turbomachinery',
  robotics:    '🤖 Robotics & Motion Control',
  industrial:  '🏭 Industrial & Tooling',
};

function isCadCategoryKey(catKey) {
  return catKey === 'cad3d' || String(catKey || '').startsWith('cad3d-');
}

function getTextTaskSubcategory(t) {
  if (!t) return 'ops-cx';
  if (t.subcategory && TEXT_SUBCATEGORY_LABELS[t.subcategory]) return t.subcategory;
  const legacyCat = t.category || 'general';
  if (TEXT_SUBCATEGORY_LABELS[legacyCat]) return legacyCat;
  if (legacyCat === 'security') return t.executable ? 'sec-patching' : 'sec-operations';
  if (legacyCat === 'coding') return t.visualizer ? 'algo-viz' : 'sys-engineering';
  if (legacyCat === 'games') return 'wasm-games';
  if (legacyCat === 'business') return 'ops-cx';
  return 'mission-travel';
}

function getTextTaskTopCategory(t) {
  if (!t) return 'strategy';
  const sub = getTextTaskSubcategory(t);
  for (const [topKey, list] of Object.entries(TEXT_SUBCATEGORIES_BY_CATEGORY)) {
    if (list.some(([k]) => k === sub)) return topKey;
  }
  return 'strategy';
}

function filterCadTasksByCategoryAndSubcategory(catKey, subcatOverride) {
  const allCad = ((CONFIG && Array.isArray(CONFIG.tasks)) ? CONFIG.tasks : [])
    .filter((t) => (t.category || 'general') === 'cad3d');
  let verticalFiltered = allCad;
  if (String(catKey || '').startsWith('cad3d-') && catKey !== 'cad3d-all') {
    const vert = String(catKey).replace(/^cad3d-/, '');
    verticalFiltered = allCad.filter((t) => (t.vertical || 'industrial') === vert);
  }
  const subSel = $('#subcategorySelect');
  const subVal = subcatOverride !== undefined
    ? subcatOverride
    : ((subSel && subSel.value === 'complex') ? 'complex' : 'simple');
  if (subVal === 'simple') {
    return verticalFiltered.filter((t) => t.subcategory === 'simple');
  }
  if (subVal === 'complex') {
    return verticalFiltered.filter((t) => t.subcategory !== 'simple');
  }
  return verticalFiltered;
}

function filterTextTasksByCategoryAndSubcategory(catKey, subcatOverride) {
  const allText = ((CONFIG && Array.isArray(CONFIG.tasks)) ? CONFIG.tasks : [])
    .filter((t) => (t.category || 'general') !== 'cad3d');
  if (TEXT_SUBCATEGORIES_BY_CATEGORY[catKey]) {
    const inTop = allText.filter((t) => getTextTaskTopCategory(t) === catKey);
    const subSel = $('#subcategorySelect');
    const subVal = subcatOverride !== undefined ? subcatOverride : (subSel ? subSel.value : '');
    if (subVal && subVal !== 'all' && inTop.some((t) => getTextTaskSubcategory(t) === subVal)) {
      return inTop.filter((t) => getTextTaskSubcategory(t) === subVal);
    }
    return inTop;
  }
  return allText.filter((t) => (t.category || 'general') === catKey || getTextTaskSubcategory(t) === catKey);
}

function populateSubcategorySelect(catKey, preferredSubcat) {
  const subSel = $('#subcategorySelect');
  const subSep = $('#subcategorySep');
  if (!subSel) return;
  const prevVal = preferredSubcat !== undefined ? preferredSubcat : subSel.value;

  if (isCadCategoryKey(catKey)) {
    subSel.innerHTML = '';
    [
      ['simple', '🔩 Simple Parts'],
      ['complex', '⚙️ Complex Parts'],
    ].forEach(([val, lbl]) => {
      const o = el('option');
      o.value = val;
      o.textContent = lbl;
      subSel.appendChild(o);
    });
    subSel.value = prevVal === 'complex' ? 'complex' : 'simple';
    subSel.classList.remove('hidden');
    if (subSep) subSep.classList.remove('hidden');
    return;
  }

  const textSubs = TEXT_SUBCATEGORIES_BY_CATEGORY[catKey];
  if (Array.isArray(textSubs) && textSubs.length > 0) {
    subSel.innerHTML = '';
    const allText = ((CONFIG && Array.isArray(CONFIG.tasks)) ? CONFIG.tasks : [])
      .filter((t) => (t.category || 'general') !== 'cad3d');
    textSubs.forEach(([val, lbl]) => {
      if (!allText.some((t) => getTextTaskSubcategory(t) === val)) return;
      const o = el('option');
      o.value = val;
      o.textContent = lbl;
      subSel.appendChild(o);
    });
    if (prevVal && Array.from(subSel.options).some((o) => o.value === prevVal)) {
      subSel.value = prevVal;
    } else if (subSel.options.length > 0) {
      subSel.value = subSel.options[0].value;
    }
    const hasOpts = subSel.options.length > 0;
    subSel.classList.toggle('hidden', !hasOpts);
    if (subSep) subSep.classList.toggle('hidden', !hasOpts);
    return;
  }

  subSel.classList.add('hidden');
  if (subSep) subSep.classList.add('hidden');
}

function isCadActiveTask(t) {
  const task = t || (typeof currentTask === 'function' ? currentTask() : null);
  return (typeof ACTIVE_ARENA_MODE !== 'undefined' && ACTIVE_ARENA_MODE === '3d')
    || !!(task && (task.visualizer === 'cad3d' || task.category === 'cad3d'));
}

function populateCategorySelect(mode) {
  const cs = $('#categorySelect');
  if (!cs || !CONFIG) return;
  const is3d = mode === '3d';
  const prevVal = cs.value;
  cs.innerHTML = '';
  const list = is3d ? CAD_VERTICAL_CATEGORIES : TASK_CATEGORIES;
  list.forEach(([cat, label]) => {
    if (cat === 'custom') {
      const o = el('option');
      o.value = 'custom';
      o.textContent = is3d
        ? '✏️ Custom 3D / CAD Prompt'
        : (SAVED_PROMPTS.length > 0 ? '✏️ Custom & Saved Prompts' : label);
      cs.appendChild(o);
      return;
    }
    const inCat = isCadCategoryKey(cat)
      ? filterCadTasksByCategoryAndSubcategory(cat, 'all')
      : filterTextTasksByCategoryAndSubcategory(cat, 'all');
    if (!inCat.length) return;
    const o = el('option');
    o.value = cat;
    o.textContent = label;
    cs.appendChild(o);
  });
  if (prevVal && Array.from(cs.options).some((o) => o.value === prevVal)) {
    cs.value = prevVal;
  }
  populateSubcategorySelect(cs.value);
}

let SAVED_PROMPTS = [];
let ACTIVE_SAVED_PROMPT_ID = null;
let SAVED_PRESETS = [];
let ACTIVE_SAVED_PRESET_ID = null;

function isCustomTaskId(val) {
  return !val || val === 'custom' || String(val).startsWith('saved:');
}

function isCustomTaskSelected() {
  const ts = $('#taskSelect');
  return isCustomTaskId(ts && ts.value);
}

function getSavedPromptById(id) {
  if (!id) return null;
  const cleanId = String(id).replace(/^saved:/, '');
  return SAVED_PROMPTS.find((p) => p && p.id === cleanId) || null;
}

function updateCategoryCustomOptionCount() {
  const cs = $('#categorySelect');
  if (!cs) return;
  const opt = cs.querySelector('option[value="custom"]');
  if (!opt) return;
  const is3d = typeof ACTIVE_ARENA_MODE !== 'undefined' && ACTIVE_ARENA_MODE === '3d';
  opt.textContent = is3d
    ? '✏️ Custom 3D / CAD Prompt'
    : (SAVED_PROMPTS.length > 0 ? '✏️ Custom & Saved Prompts' : '✏️ Custom Prompt');
}

function syncSavedPromptButtons() {
  const saveBtn = $('#savePromptBtn');
  const delBtn = $('#deleteSavedPromptBtn');
  const isCustom = isCustomTaskSelected();
  if (saveBtn) {
    saveBtn.classList.toggle('hidden', !isCustom);
  }
  const ts = $('#taskSelect');
  const selectedVal = (ts && ts.value) || 'custom';
  const savedItem = String(selectedVal).startsWith('saved:') ? getSavedPromptById(selectedVal) : null;
  ACTIVE_SAVED_PROMPT_ID = savedItem ? savedItem.id : null;
  if (delBtn) {
    delBtn.classList.toggle('hidden', !isCustom || !savedItem);
  }
}

function taskTagLabel(t) {
  if (t && t.category === 'cad3d') {
    return t.subcategory === 'simple' ? 'Simple Part' : 'Complex Part';
  }
  return t.testCount ? `${t.testCount} hidden tests` : (t.language ? `${t.language}` : 'prompt only');
}

function populateTaskSelect(catKey, preferredTaskId) {
  const ts = $('#taskSelect');
  if (!ts) return;
  ts.innerHTML = '';
  populateSubcategorySelect(catKey);

  if (!catKey || catKey === 'custom') {
    const customOpt = el('option');
    customOpt.value = 'custom';
    customOpt.textContent = SAVED_PROMPTS.length > 0
      ? '✏️ New / Freeform Custom Prompt & File Attachments'
      : 'Custom Prompt - Freeform & File Attachments';
    ts.appendChild(customOpt);

    if (SAVED_PROMPTS.length > 0) {
      const grp = document.createElement('optgroup');
      grp.label = `🔖 My Saved Prompts (${SAVED_PROMPTS.length})`;
      SAVED_PROMPTS.forEach((p) => {
        if (!p || !p.id) return;
        const o = el('option');
        o.value = `saved:${p.id}`;
        const attCount = Array.isArray(p.attachments) ? p.attachments.length : 0;
        const attSuffix = attCount > 0 ? `  (${attCount} file${attCount > 1 ? 's' : ''})` : '';
        o.textContent = `🔖 ${p.title || 'Saved prompt'}${attSuffix}`;
        grp.appendChild(o);
      });
      ts.appendChild(grp);
    }

    const wantVal = (preferredTaskId && String(preferredTaskId).startsWith('saved:') && getSavedPromptById(preferredTaskId))
      ? preferredTaskId
      : 'custom';
    ts.value = wantVal;
    ts.disabled = SAVED_PROMPTS.length === 0;
    syncSavedPromptButtons();
    return;
  }

  const isCadCat = isCadCategoryKey(catKey);
  const tasks = isCadCat
    ? filterCadTasksByCategoryAndSubcategory(catKey)
    : filterTextTasksByCategoryAndSubcategory(catKey);

  if (isCadCat) {
    tasks.forEach((t) => {
      const o = el('option');
      o.value = t.id;
      const vertBadge = (catKey === 'cad3d' || catKey === 'cad3d-all') && t.vertical && CAD_VERTICAL_LABELS[t.vertical]
        ? `[${CAD_VERTICAL_LABELS[t.vertical].replace(/^[^\s]+\s+/, '')}] `
        : '';
      const cleanTitle = String(t.title || '').replace(/^3D CAD:\s*/i, '');
      o.textContent = `${vertBadge}${cleanTitle}`;
      ts.appendChild(o);
    });
  } else {
    tasks.forEach((t) => {
      const o = el('option');
      o.value = t.id;
      o.textContent = t.title;
      ts.appendChild(o);
    });
  }

  ts.disabled = false;
  if (preferredTaskId && tasks.some((t) => t.id === preferredTaskId)) {
    ts.value = preferredTaskId;
  } else if (tasks.length > 0) {
    ts.value = tasks[0].id;
  }
  syncSavedPromptButtons();
}

function selectTaskById(taskId) {
  const cs = $('#categorySelect');
  if (!taskId || taskId === 'custom' || String(taskId).startsWith('saved:')) {
    if (cs) cs.value = 'custom';
    populateTaskSelect('custom', taskId || 'custom');
    return;
  }
  const tasks = (CONFIG && Array.isArray(CONFIG.tasks)) ? CONFIG.tasks : [];
  const found = tasks.find((t) => t.id === taskId);
  if (found) {
    const is3d = typeof ACTIVE_ARENA_MODE !== 'undefined' && ACTIVE_ARENA_MODE === '3d';
    let cat = found.category || 'general';
    if (cat === 'cad3d' && is3d) {
      const vertCat = found.vertical ? `cad3d-${found.vertical}` : 'cad3d-automotive';
      if (cs && Array.from(cs.options).some((o) => o.value === vertCat)) {
        cat = vertCat;
      } else if (cs && Array.from(cs.options).some((o) => o.value === 'cad3d-all')) {
        cat = 'cad3d-all';
      }
      if (cs) cs.value = cat;
      populateSubcategorySelect(cat, found.subcategory === 'complex' ? 'complex' : 'simple');
    } else {
      const topCat = getTextTaskTopCategory(found);
      if (cs && Array.from(cs.options).some((o) => o.value === topCat)) {
        cat = topCat;
      }
      if (cs) cs.value = cat;
      populateSubcategorySelect(cat, getTextTaskSubcategory(found));
    }
    populateTaskSelect(cat, found.id);
  } else {
    if (cs) cs.value = 'custom';
    populateTaskSelect('custom', 'custom');
  }
}

// ---------- composer pristine/dirty tracking + per-user session draft (1.2 / 1.3) ----------
// COMPOSER_APPLIED is the text + attachment count last put into the composer by
// the app itself (blank reset, saved prompt, History restore, draft restore).
// Anything the user changed since then is "dirty" and is never silently wiped.
let COMPOSER_APPLIED = { text: '', attCount: 0 };
function markComposerApplied() {
  const ta = $('#customPrompt');
  COMPOSER_APPLIED = { text: ta ? ta.value : '', attCount: Array.isArray(CUSTOM_ATTACHMENTS) ? CUSTOM_ATTACHMENTS.length : 0 };
}
function composerIsDirty() {
  const ta = $('#customPrompt');
  const text = ta ? ta.value : '';
  if (text.trim() !== String(COMPOSER_APPLIED.text || '').trim()) return true;
  const attCount = Array.isArray(CUSTOM_ATTACHMENTS) ? CUSTOM_ATTACHMENTS.length : 0;
  return attCount !== COMPOSER_APPLIED.attCount;
}
// Confirm before replacing a dirty composer (History restore, saved prompt switch).
function confirmReplaceComposer(message) {
  if (!composerIsDirty()) return true;
  return window.confirm(message || 'Replace your current prompt and attachments?');
}

// The typed prompt survives a 401 redirect / reload via sessionStorage (text only;
// attachments are too large and are re-attached by the user).
const COMPOSER_DRAFT_MAX_CHARS = 200000;
function composerDraftKey() { return 'ullm.draft.' + getUsername(); }
function saveComposerDraft() {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const ta = $('#customPrompt');
    const ts = $('#taskSelect');
    const prompt = ta ? String(ta.value || '') : '';
    const key = composerDraftKey();
    if (!prompt.trim()) { sessionStorage.removeItem(key); return; }
    sessionStorage.setItem(key, JSON.stringify({
      prompt: prompt.slice(0, COMPOSER_DRAFT_MAX_CHARS),
      taskId: ts ? ts.value : 'custom',
      at: Date.now(),
    }));
  } catch (_) { /* quota or privacy mode: drafts are best-effort */ }
}
function clearComposerDraft() {
  try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(composerDraftKey()); } catch (_) { /* ignore */ }
}
function loadComposerDraft() {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(composerDraftKey());
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d.prompt !== 'string' || !d.prompt.trim()) return null;
    return d;
  } catch (_) { return null; }
}
let _draftSaveTimer = null;
function saveComposerDraftDebounced() {
  if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
  _draftSaveTimer = setTimeout(() => { _draftSaveTimer = null; saveComposerDraft(); }, 400);
}

function resetCustomComposerToBlank(opts) {
  const customTa = $('#customPrompt');
  if (customTa) customTa.value = '';
  clearAttachments();
  ACTIVE_SAVED_PROMPT_ID = null;
  markComposerApplied();
  clearComposerDraft();
  syncSavedPromptButtons();
  renderTaskPrompt();
  if (opts && opts.focus && customTa && !customTa.classList.contains('hidden')) {
    try { customTa.focus(); } catch (_) {}
  }
}

function applySavedPromptToComposer(savedItem) {
  if (!savedItem) return;
  const customTa = $('#customPrompt');
  if (customTa) customTa.value = savedItem.prompt || '';
  if (Array.isArray(savedItem.attachments) && savedItem.attachments.length) {
    restoreCustomAttachmentsFromData(savedItem.attachments);
  } else {
    clearAttachments();
  }
  ACTIVE_SAVED_PROMPT_ID = savedItem.id;
  markComposerApplied();
  saveComposerDraft();
  syncSavedPromptButtons();
  renderTaskPrompt();
}

async function onSavePromptClick() {
  const customTa = $('#customPrompt');
  const promptText = (customTa && customTa.value) || '';
  if (!promptText.trim() && CUSTOM_ATTACHMENTS.length === 0) {
    window.alert('Write a custom prompt or attach a file before saving.');
    if (customTa) customTa.focus();
    return;
  }
  const existing = ACTIVE_SAVED_PROMPT_ID ? getSavedPromptById(ACTIVE_SAVED_PROMPT_ID) : null;
  const defaultTitle = existing
    ? existing.title
    : (promptText.trim().split(/\r?\n/)[0] || (CUSTOM_ATTACHMENTS[0] && CUSTOM_ATTACHMENTS[0].name) || 'Custom Prompt')
        .replace(/\s+/g, ' ').trim().slice(0, 70);
  const rawTitle = window.prompt('Name this prompt for your Saved Prompts library:', defaultTitle);
  if (rawTitle === null) return; // cancelled
  const title = rawTitle.trim() || defaultTitle || 'Saved Prompt';
  const sameNameExisting = SAVED_PROMPTS.find((p) => p && p.title && p.title.toLowerCase() === title.toLowerCase());
  if (sameNameExisting && (!existing || sameNameExisting.id !== existing.id)) {
    if (!window.confirm(`Overwrite saved prompt "${sameNameExisting.title}"?`)) return;
  }
  const updateSameId = sameNameExisting ? sameNameExisting.id : (existing ? existing.id : undefined);

  const saveBtn = $('#savePromptBtn');
  const origHtml = saveBtn ? saveBtn.innerHTML : '🔖 Save prompt';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
  }
  try {
    const attachments = CUSTOM_ATTACHMENTS.map((a) => {
      if (a.cached && (a.sha256 || a.vaultRef)) {
        return {
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
          estimatedTokens: a.estimatedTokens,
          pageCount: a.pageCount,
          warning: a.warning,
          optBadge: a.optBadge,
          sha256: a.sha256 || a.vaultRef,
          vaultRef: a.vaultRef || a.sha256,
          sha1: a.sha1,
        };
      }
      return {
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
        data: a.data || undefined,
        textContent: a.textContent || undefined,
        claudeDataBase64: a.claudeDataBase64 || undefined,
        claudeMimeType: a.claudeDataBase64 ? a.claudeMimeType : undefined,
        fitDataBase64: a.fitDataBase64 || undefined,
        fitMimeType: a.fitDataBase64 ? a.fitMimeType : undefined,
        estimatedTokens: a.estimatedTokens,
        pageCount: a.pageCount,
        warning: a.warning,
        optBadge: a.optBadge,
        sha256: a.sha256,
        vaultRef: a.vaultRef || a.sha256,
        sha1: a.sha1,
      };
    });
    const resp = await fetch('/api/me/prompts', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: updateSameId,
        title,
        prompt: promptText,
        attachments,
      }),
    });
    if (resp.status === 401) { window.location.replace('/login'); return; }
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || 'Failed to save prompt.');
    SAVED_PROMPTS = Array.isArray(data.savedPrompts) ? data.savedPrompts : SAVED_PROMPTS;
    if (CONFIG && CONFIG.me) CONFIG.me.savedPrompts = SAVED_PROMPTS;
    saveLocalLibraryBackup();
    if (data.saved && Array.isArray(data.saved.attachments)) {
      restoreCustomAttachmentsFromData(data.saved.attachments);
    }
    updateCategoryCustomOptionCount();
    const savedId = (data.saved && data.saved.id) || updateSameId;
    populateTaskSelect('custom', savedId ? `saved:${savedId}` : 'custom');
    renderTaskMeta();
    if (saveBtn) {
      saveBtn.classList.add('is-saved');
      saveBtn.textContent = '✓ Saved to library';
      setTimeout(() => {
        saveBtn.classList.remove('is-saved');
        saveBtn.innerHTML = origHtml;
      }, 1600);
    }
  } catch (err) {
    window.alert('Could not save prompt: ' + err.message);
    if (saveBtn) saveBtn.innerHTML = origHtml;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function onDeleteSavedPromptClick() {
  const ts = $('#taskSelect');
  const val = (ts && ts.value) || '';
  const item = String(val).startsWith('saved:') ? getSavedPromptById(val) : null;
  if (!item) return;
  if (!window.confirm(`Delete saved prompt "${item.title}" from your library?`)) return;
  const delBtn = $('#deleteSavedPromptBtn');
  if (delBtn) delBtn.disabled = true;
  try {
    const resp = await fetch('/api/me/prompts/' + encodeURIComponent(item.id), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (resp.status === 401) { window.location.replace('/login'); return; }
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || 'Could not delete saved prompt.');
    SAVED_PROMPTS = Array.isArray(data.savedPrompts) ? data.savedPrompts : SAVED_PROMPTS.filter((p) => p.id !== item.id);
    if (CONFIG && CONFIG.me) CONFIG.me.savedPrompts = SAVED_PROMPTS;
    saveLocalLibraryBackup();
    ACTIVE_SAVED_PROMPT_ID = null;
    updateCategoryCustomOptionCount();
    populateTaskSelect('custom', 'custom');
    resetCustomComposerToBlank({ focus: true });
    saveUserPreferencesDebounced();
  } catch (err) {
    window.alert('Could not delete saved prompt: ' + err.message);
  } finally {
    if (delBtn) delBtn.disabled = false;
  }
}

function saveLocalLibraryBackup() {
  try {
    const uname = getUsername();
    if (!uname || uname === 'default') return;
    const prompts = Array.isArray(SAVED_PROMPTS) ? SAVED_PROMPTS.map((p) => ({
      id: p.id,
      title: p.title,
      prompt: p.prompt || '',
      attachments: Array.isArray(p.attachments) ? p.attachments.map((a) => ({
        name: a.name,
        mimeType: a.mimeType,
        kind: a.kind,
        size: a.size,
        pageCount: a.pageCount,
        warning: a.warning,
        optBadge: a.optBadge,
        sha1: a.sha1,
        sha256: a.sha256,
        vaultRef: a.vaultRef || a.sha256,
        thumbnailUrl: a.thumbnailUrl,
        relPath: a.relPath,
        estimatedTokens: a.estimatedTokens,
        hasBlob: a.hasBlob,
      })) : [],
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })) : [];
    const presets = Array.isArray(SAVED_PRESETS) ? SAVED_PRESETS.map((p) => ({
      id: p.id,
      title: p.title,
      slots: Array.isArray(p.slots) ? p.slots : [],
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })) : [];
    localStorage.setItem('ullm.library.' + uname, JSON.stringify({
      savedPrompts: prompts,
      savedPresets: presets,
      updatedAt: Date.now(),
    }));
  } catch (_) {}
}

async function restoreLocalLibraryBackupIfNeeded() {
  try {
    const uname = getUsername();
    if (!uname || uname === 'default') return;
    const raw = localStorage.getItem('ullm.library.' + uname);
    if (!raw) {
      if (SAVED_PROMPTS.length > 0 || SAVED_PRESETS.length > 0) {
        saveLocalLibraryBackup();
      }
      return;
    }
    const backup = JSON.parse(raw);
    if (!backup || typeof backup !== 'object') return;
    let syncedAny = false;

    if (SAVED_PROMPTS.length === 0 && Array.isArray(backup.savedPrompts) && backup.savedPrompts.length > 0) {
      SAVED_PROMPTS = backup.savedPrompts;
      if (CONFIG && CONFIG.me) CONFIG.me.savedPrompts = SAVED_PROMPTS;
      for (const p of backup.savedPrompts) {
        if (!p || !p.title) continue;
        try {
          const r = await fetch('/api/me/prompts', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: p.id,
              title: p.title,
              prompt: p.prompt || '',
              attachments: Array.isArray(p.attachments) ? p.attachments : [],
            }),
          });
          if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j.savedPrompts)) SAVED_PROMPTS = j.savedPrompts;
          }
        } catch (_) {}
      }
      syncedAny = true;
    }

    if (SAVED_PRESETS.length === 0 && Array.isArray(backup.savedPresets) && backup.savedPresets.length > 0) {
      SAVED_PRESETS = backup.savedPresets;
      if (CONFIG && CONFIG.me) CONFIG.me.savedPresets = SAVED_PRESETS;
      for (const p of backup.savedPresets) {
        if (!p || !p.title || !Array.isArray(p.slots) || !p.slots.length) continue;
        try {
          const r = await fetch('/api/me/presets', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: p.id,
              title: p.title,
              slots: p.slots,
            }),
          });
          if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j.savedPresets)) SAVED_PRESETS = j.savedPresets;
          }
        } catch (_) {}
      }
      syncedAny = true;
    }

    if (SAVED_PROMPTS.length > 0 || SAVED_PRESETS.length > 0 || syncedAny) {
      saveLocalLibraryBackup();
    }
  } catch (_) {}
}

// ---------- init ----------
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pageshow', (e) => {
    if (e && e.persisted) window.location.reload();
  });
}
function formatLastUpdatedStamp(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return String(isoStr);
  try {
    return 'Last updated ' + d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch (_) {
    return 'Last updated ' + d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

init();
async function init() {
  initTheme();
  const prefetched = (typeof window !== 'undefined' && window.__ULLM_CONFIG_PROMISE__) || null;
  if (typeof window !== 'undefined') window.__ULLM_CONFIG_PROMISE__ = null;
  const cfgResp = await (prefetched || fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' }));
  if (cfgResp.status === 401) { window.location.replace('/login'); return; } // session expired/absent
  CONFIG = await cfgResp.json();
  if (CONFIG && CONFIG.version) {
    const vEl = $('#appVersion');
    const hvEl = $('#headerAppVersion');
    const htmlVer = vEl ? String(vEl.textContent || '').trim().replace(/^v/i, '') : '';
    const srvVer = String(CONFIG.version).replace(/^v/i, '');
    if (htmlVer && srvVer && htmlVer !== srvVer) {
      try {
        const reloadKey = 'ullm.reloaded.' + srvVer;
        if (typeof sessionStorage !== 'undefined' && !sessionStorage.getItem(reloadKey)) {
          sessionStorage.setItem(reloadKey, '1');
          window.location.reload();
          return;
        }
      } catch (_) {}
    }
    if (vEl) vEl.textContent = 'v' + srvVer;
    if (hvEl) hvEl.textContent = 'v' + srvVer;
  }
  {
    const luEl = $('#appLastUpdated');
    const iso = (CONFIG && CONFIG.lastUpdated) || (luEl && luEl.dataset && luEl.dataset.iso) || '';
    if (luEl && iso) {
      luEl.dataset.iso = iso;
      luEl.textContent = formatLastUpdatedStamp(iso);
      luEl.title = 'Release timestamp: ' + iso;
    }
  }
  myQuota = CONFIG.me && CONFIG.me.quota;             // seed the daily-runs counters
  mySingleQuota = CONFIG.me && CONFIG.me.singleQuota;
  myVertexQuota = CONFIG.me && CONFIG.me.vertexQuota;
  myQuotas = (CONFIG.me && CONFIG.me.quotas) || null;  // every per-provider budget (OpenAI, Anthropic, Moonshot, Vertex AI)
  SAVED_PROMPTS = Array.isArray(CONFIG.me && CONFIG.me.savedPrompts) ? CONFIG.me.savedPrompts : [];
  SAVED_PRESETS = Array.isArray(CONFIG.me && CONFIG.me.savedPresets) ? CONFIG.me.savedPresets : [];
  await restoreLocalLibraryBackupIfNeeded();
  initUserMenu(CONFIG.me);
  if (CONFIG.me && !CONFIG.me.external && CONFIG.me.mustChangePassword) {
    openChangePwModal({ forced: true });
  }
  // Seed the drag-and-drop slots from the server's default selection, then let
  // MODELS be derived from the slots from here on.
  seedSlots();
  syncModelsFromSlots();

  // 3-stage category -> subcategory -> filtered task selector (defaults to Custom Prompt on load)
  const cs = $('#categorySelect');
  const ts = $('#taskSelect');
  populateCategorySelect(typeof ACTIVE_ARENA_MODE !== 'undefined' ? ACTIVE_ARENA_MODE : 'text');

  // Last applied Step 1 selection, so a change the user declines (a comparison is
  // still streaming, or the composer holds unsaved text) can be rolled back.
  let lastTaskSelection = null;
  const snapshotTaskSelection = () => {
    const subSelNow = $('#subcategorySelect');
    lastTaskSelection = { cat: cs ? cs.value : '', sub: subSelNow ? subSelNow.value : '', task: ts ? ts.value : '' };
  };
  const revertTaskSelection = () => {
    if (!lastTaskSelection) return;
    if (cs && lastTaskSelection.cat) {
      cs.value = lastTaskSelection.cat;
      populateSubcategorySelect(cs.value, lastTaskSelection.sub || undefined);
      populateTaskSelect(cs.value, lastTaskSelection.task || undefined);
    }
    if (ts && lastTaskSelection.task) ts.value = lastTaskSelection.task;
    syncSavedPromptButtons();
  };

  const onTaskSelectionChange = () => {
    // Changing the task rebuilds the arena under the same element ids; a stream
    // still in flight would paint the old task's tokens into the new columns (1.1).
    if (!confirmInterruptRun('A comparison is still running. Stop it and switch tasks?')) { revertTaskSelection(); return; }
    const selVal = (ts && ts.value) || 'custom';
    if (String(selVal).startsWith('saved:')) {
      const savedItem = getSavedPromptById(selVal);
      if (savedItem && savedItem.id !== ACTIVE_SAVED_PROMPT_ID) {
        if (!confirmReplaceComposer(`Replace your current prompt and attachments with the saved prompt "${savedItem.title || 'Saved prompt'}"?`)) { revertTaskSelection(); return; }
        applySavedPromptToComposer(savedItem);
      }
    } else if (selVal === 'custom') {
      // Only wipe a pristine composer; typed text / attachments need an explicit OK (1.2).
      if (!composerIsDirty()) {
        resetCustomComposerToBlank({ focus: true });
      } else if (window.confirm('Clear your current prompt and attachments and start a blank custom prompt?')) {
        resetCustomComposerToBlank({ focus: true });
      } else {
        ACTIVE_SAVED_PROMPT_ID = null;   // keep the text, just detach it from any saved prompt
        saveComposerDraft();
      }
    }
    snapshotTaskSelection();
    syncSavedPromptButtons();
    renderTaskPrompt();
    if (typeof syncCadModifyBarVisibility === 'function') syncCadModifyBarVisibility();
    $('#scorecard').classList.add('hidden');
    { const jb = $('#jumpScorecardBtn'); if (jb) jb.classList.add('hidden'); }
    { const pb = $('#exportPdfTopBtn'); if (pb) pb.classList.add('hidden'); }
    buildArena();
    saveUserPreferencesDebounced();
  };

  const subSel = $('#subcategorySelect');
  if (cs) {
    cs.addEventListener('change', () => {
      if (!confirmInterruptRun('A comparison is still running. Stop it and switch tasks?')) { revertTaskSelection(); return; }
      populateSubcategorySelect(cs.value);
      populateTaskSelect(cs.value);
      onTaskSelectionChange();
    });
  }
  if (subSel) {
    subSel.addEventListener('change', () => {
      if (!confirmInterruptRun('A comparison is still running. Stop it and switch tasks?')) { revertTaskSelection(); return; }
      if (cs) populateTaskSelect(cs.value, ts ? ts.value : undefined);
      onTaskSelectionChange();
    });
  }
  if (ts) {
    ts.addEventListener('change', onTaskSelectionChange);
  }
  {
    const sb = $('#savePromptBtn');
    if (sb) sb.addEventListener('click', onSavePromptClick);
    const db = $('#deleteSavedPromptBtn');
    if (db) db.addEventListener('click', onDeleteSavedPromptClick);
  }
  initAttachmentsUI();
  // Dropping a file anywhere outside the drop zone must never navigate the tab
  // away from the app (and lose the run / prompt) (1.11).
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => { e.preventDefault(); });

  const me = CONFIG && CONFIG.me;
  const prefs = (me && me.preferences) || {};
  const customTa = $('#customPrompt');
  if (customTa) {
    customTa.addEventListener('input', () => {
      renderContextMeter();
      saveComposerDraftDebounced();
    });
  }

  // Purge legacy IndexedDB preference store if present from older versions
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB.deleteDatabase) {
      indexedDB.deleteDatabase('ullm_pref_store');
    }
  } catch (_) {}

  const initialTask = (prefs.taskId && String(prefs.taskId).startsWith('saved:') && getSavedPromptById(prefs.taskId))
    ? prefs.taskId
    : 'custom';
  selectTaskById(initialTask);
  if (String(initialTask).startsWith('saved:')) {
    const savedItem = getSavedPromptById(initialTask);
    if (savedItem) applySavedPromptToComposer(savedItem);
  }
  // Snapshot the programmatic composer state first so a restored draft that differs
  // from it still counts as dirty (and is protected from silent wipes).
  markComposerApplied();
  // Bring back the prompt that was being typed before a reload / session-expiry
  // redirect (saved on every input; see saveComposerDraft).
  {
    const draft = loadComposerDraft();
    if (draft && customTa && !String(customTa.value || '').trim()) {
      customTa.value = draft.prompt;
      ACTIVE_SAVED_PROMPT_ID = null;
      if (draft.taskId && String(draft.taskId).startsWith('saved:') && getSavedPromptById(draft.taskId)) {
        selectTaskById(draft.taskId);
        ACTIVE_SAVED_PROMPT_ID = String(draft.taskId).replace(/^saved:/, '');
      } else if (!draft.taskId || isCustomTaskId(draft.taskId)) {
        selectTaskById('custom');
      }
      syncSavedPromptButtons();
    }
  }
  snapshotTaskSelection();
  renderTaskPrompt();

  renderModelEditors();
  buildArena();
  updateRunButton();
  if (typeof ACTIVE_ARENA_MODE !== 'undefined' && ACTIVE_ARENA_MODE === '3d' && typeof switchArenaMode === 'function') {
    switchArenaMode('3d', { updateUrl: false, initialBoot: true });
  }

  $('#runBtn').addEventListener('click', run);
  {
    const jb = $('#jumpScorecardBtn');
    if (jb) {
      jb.addEventListener('click', () => {
        const sc = $('#scorecard');
        if (sc && !sc.classList.contains('hidden')) {
          sc.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
  }
  document.querySelectorAll('.export-pdf-cta, .export-pdf-btn').forEach((b) => b.addEventListener('click', () => exportCurrentRunPdf(b)));
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
  $('#historyBtn').addEventListener('click', () => openHistoryModal());
  updateQuotaBadge();
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeModal();
    closeAuthModal();
    const mcp = $('#cadMcpModal'); // 2.1: the CAD MCP dialog ignored Escape
    if (mcp && !mcp.classList.contains('hidden')) {
      mcp.classList.add('hidden');
      deactivateModalFocus();
    }
  });
}

// ---------- account / user menu ----------
let ME = null;
function initUserMenu(me) {
  ME = me || null;
  const isGoogleUser = Boolean(ME && typeof ME.username === 'string' && /@google\.com$/i.test(ME.username.trim()));
  const creditEl = $('#googleFooterCredit');
  if (creditEl) creditEl.hidden = !isGoogleUser;
  const menu = $('#userMenu');
  if (!menu || !ME) return;
  menu.hidden = false;
  $('#userName').textContent = ME.username + (ME.role === 'admin' ? '' : '');
  $('#userAvatar').textContent = (ME.username[0] || '?').toUpperCase();
  $('#userChip').title = ME.username + ' · ' + ME.role;
  $('#manageUsersBtn').hidden = ME.role !== 'admin';
  { const al = $('#auditLogBtn'); if (al) al.hidden = ME.role !== 'admin'; }
  { const gk = $('#globalKeysBtn'); if (gk) gk.hidden = ME.role !== 'admin'; }
  { const st = $('#settingsBtn'); if (st) st.hidden = ME.role !== 'admin'; }
  { const cp = $('#changePwBtn'); if (cp) cp.hidden = !!(ME.external || isGoogleUser); }

  const chip = $('#userChip');
  const dd = $('#userDropdown');
  const toggle = (open) => { dd.hidden = open === undefined ? !dd.hidden : !open; chip.setAttribute('aria-expanded', String(!dd.hidden)); };
  chip.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) toggle(false); });

  $('#logoutBtn').addEventListener('click', logout);
  $('#changePwBtn').addEventListener('click', () => { toggle(false); openChangePwModal(); });
  $('#manageUsersBtn').addEventListener('click', () => { toggle(false); openUsersModal(); });
  { const al = $('#auditLogBtn'); if (al) al.addEventListener('click', () => { toggle(false); openAuditLogModal(); }); }
  { const gk = $('#globalKeysBtn'); if (gk) gk.addEventListener('click', () => { toggle(false); openGlobalKeysModal(); }); }
  { const st = $('#settingsBtn'); if (st) st.addEventListener('click', () => { toggle(false); openSettingsModal(); }); }
  $('#apiKeysBtn').addEventListener('click', () => { toggle(false); openKeysModal(); });
}

// ---------- bring-your-own API keys (stored only in this browser, scoped per user) ----------
function loadKeys() {
  try {
    const u = getUsername();
    const scoped = localStorage.getItem('ullm.keys.' + u);
    if (scoped) return JSON.parse(scoped) || {};
    return {};
  } catch (e) { return {}; }
}
function saveKeys(k) {
  try {
    const u = getUsername();
    localStorage.setItem('ullm.keys.' + u, JSON.stringify(k));
  } catch (e) { /* ignore */ }
}

// Which credential each selected model will actually run on. Mirrors
// credentialFamily()/modelUsesOwnKey() in src/byok.js - the quota is only
// skipped when EVERY model in the run uses the caller's own key, so this is what
// decides "unlimited". Strict BYOK: a model covered by the user's own key runs
// ONLY on that key (never the shared one, not even as a fallback).
function keySourceFor(m, k) {
  const pub = m.publisher || 'google';
  if (m.provider === 'agentplatform' && (pub === 'anthropic' || m.endpointType === 'openai-maas')) {
    // Claude and partner MaaS models (Grok, Qwen, DeepSeek, Llama, GLM, GPT-OSS,
    // Kimi on Vertex) authenticate with an OAuth token - a Gemini API key does not cover them.
    return k.claudeBearerToken
      ? { group: 'Claude & partner models (Vertex)', state: 'own' }
      : { group: 'Claude & partner models (Vertex)', state: 'service', present: true };
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

// True only when every model in `list` runs on the user's OWN credential: the
// same condition the server uses before skipping every daily budget.
function allModelsUseOwnKeys(list) {
  const k = loadKeys();
  const models = list || textArenaModels();
  return models.length > 0 && models.every((m) => keySourceFor(m, k).state === 'own');
}

// True when at least one model uses a non-Vertex provider (OpenAI / Anthropic /
// Moonshot) on the shared key. Used by the "swap to Vertex AI" offer.
function usesSharedPersonalKeyModels(list) {
  const k = loadKeys();
  return (list || textArenaModels()).some((m) => m.provider !== 'agentplatform' && keySourceFor(m, k).state !== 'own');
}

// Live "runs left today" state (authoritative values come from the server on
// /api/config load and with every run, reserve, judge and 429 response).
let myQuota = null;        // OpenAI budget (legacy field)
let mySingleQuota = null;  // legacy: single-model re-runs now count against the same budget
let myVertexQuota = null;  // Vertex AI budget (legacy field)
let myQuotas = null;       // { openai, anthropic, moonshot, vertex }: per-user daily budgets on the global keys

// One rule for the whole app (mirrors chargeDailyBudgets in server.js): a run is
// one Run click in either arena and counts once per provider budget it touches.
const BUDGET_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic', moonshot: 'Moonshot', vertex: 'Vertex AI' };
const BUDGET_ORDER = ['openai', 'anthropic', 'moonshot', 'vertex'];
function budgetBucketFor(m) {
  const p = m && m.provider;
  return (p === 'openai' || p === 'anthropic' || p === 'moonshot') ? p : 'vertex';
}
function budgetFor(provider) {
  const q = myQuotas && myQuotas[provider];
  const limit = (q && typeof q.limit === 'number') ? q.limit : ((CONFIG && CONFIG.limits && CONFIG.limits[provider]) ?? 0);
  const limited = q ? q.limited !== false : true;
  const remaining = (q && typeof q.remaining === 'number') ? q.remaining : limit;
  return { provider, limited, limit, remaining, resetAt: q && q.resetAt };
}
function textArenaModels() {
  return (MODELS && MODELS.length) ? MODELS : (ARENA_MODELS || []);
}
function imageArenaModels() {
  if (typeof IMG_SLOTS === 'undefined' || !IMG_CONFIG) return [];
  return IMG_SLOTS.map((s) => getImgCatalogItem(s.catalogId)).filter(Boolean);
}

// Badge near Run (both arenas): own keys, admin, or the live per-provider budgets
// for the providers this lineup uses on the shared keys.
function renderQuotaBadge(b, models) {
  if (!b) return;
  const isAdmin = ME && ME.role === 'admin';
  const allLines = BUDGET_ORDER.map((p) => {
    const q = budgetFor(p);
    return `${BUDGET_LABELS[p]} ${q.remaining}/${q.limit}`;
  }).join(' · ');
  const resetAt = (myQuotas && myQuotas.vertex && myQuotas.vertex.resetAt) || null;
  const rule = 'A run counts once per provider, however many models it compares. Text and image runs share the same budgets; runs on your own keys never count.';
  if (models.length && allModelsUseOwnKeys(models)) {
    b.textContent = 'your keys · no limit';
    b.className = 'quota-badge own';
    b.title = 'Every selected model runs on your own key, so this run does not count against any daily limit.';
    return;
  }
  if (isAdmin) {
    b.textContent = 'admin · no limit';
    b.className = 'quota-badge own';
    b.title = 'Admins are not limited on the global keys.';
    return;
  }
  const k = loadKeys();
  const shared = BUDGET_ORDER.filter((p) => models.some((m) => budgetBucketFor(m) === p && keySourceFor(m, k).state !== 'own'));
  const show = shared.length ? shared : ['vertex'];
  const states = show.map(budgetFor);
  b.textContent = states.map((q) => `${BUDGET_LABELS[q.provider]}: ${q.remaining}/${q.limit} left`).join(' · ');
  b.className = 'quota-badge ' + (states.some((q) => q.remaining <= 0) ? 'out' : states.some((q) => q.remaining <= 1) ? 'low' : 'shared');
  b.title = `Daily runs left on the global keys (per user): ${allLines}. ${rule}`
    + (resetAt ? ` Resets at ${new Date(resetAt).toLocaleString()}.` : '');
}
function updateQuotaBadge() {
  renderQuotaBadge($('#quotaBadge'), textArenaModels());
  renderQuotaBadge($('#imgQuotaBadge'), imageArenaModels());
}

function openKeysModal() {
  const body = openAuthModal('Your API keys');
  const k = loadKeys();
  const lim = (CONFIG && CONFIG.limits) || {};
  const limitsLine = BUDGET_ORDER.map((p) => `<b>${BUDGET_LABELS[p]} ${esc(String(lim[p] ?? 0))}</b>`).join(', ');
  body.innerHTML =
    '<div class="key-scope personal">' +
      '<div class="ks-head">🔒 Personal keys: this browser only</div>' +
      '<ul class="ks-facts">' +
        '<li><b>Stored only in this browser</b> (localStorage). They are never written to the server\'s database, disk or logs, and no other user, not even an admin, can see them.</li>' +
        '<li><b>Sent with each of your runs</b> over HTTPS, because the server has to hold the key to call the provider. It is used in memory for that run and then discarded.</li>' +
        '<li><b>Your key only.</b> Every request for the models a key covers uses only your key (and your GCP project), never the shared keys, not even as a fallback. If your key is wrong or out of quota, that slot fails with the provider\'s error.</li>' +
        '<li>Clearing your browser data, or pressing <b>Clear all</b> below, removes them completely.</li>' +
      '</ul>' +
    '</div>' +
    '<p class="keys-intro">Runs on the <b>shared keys</b> count toward daily limits per user: ' + limitsLine + ' runs a day. ' +
    'A run counts once per provider, however many models it compares, and text and image runs share the same budgets. <b>Runs on your own keys are never capped.</b>' +
    ((ME && ME.role === 'admin') ? ' Limits are set in <b>Settings</b>; shared keys under <b>Global API keys</b>.' : '') + '</p>' +
    '<form class="add-user-form" id="keysForm">' +
      '<div class="auth-field"><label>Gemini / Vertex AI API key</label><input id="k-gem" type="password" autocomplete="off" spellcheck="false" placeholder="used for the Gemini slots (text &amp; image)" value="' + esc(k.agentplatform || k.gemini || '') + '" /></div>' +
      '<div class="auth-field"><label>Your GCP project ID <span class="u-tag">for Gemini 4 &amp; the OAuth token</span></label><input id="k-proj" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. my-gcp-project (the project your own key / token belongs to)" value="' + esc(k.gcpProject || '') + '" /></div>' +
      '<h4 style="margin:18px 0 10px">External models</h4>' +
      '<p class="keys-intro" style="margin-bottom:12px">These are <b>not</b> on Vertex, so the prompt leaves Google infrastructure when you run them.</p>' +
      '<div class="auth-field"><label>OpenAI API key <span class="u-tag">GPT text &amp; GPT Image</span></label><input id="k-openai" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" value="' + esc(k.openai || '') + '" /></div>' +
      '<div class="auth-field"><label>Moonshot API key <span class="u-tag">Kimi K3</span></label><input id="k-moonshot" type="password" autocomplete="off" spellcheck="false" placeholder="sk-… (platform.moonshot.ai)" value="' + esc(k.moonshot || '') + '" /></div>' +
      '<div class="auth-field"><label>Anthropic API key</label><input id="k-anthropic" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-… (for a direct Anthropic slot)" value="' + esc(k.anthropic || '') + '" /></div>' +
      '<details class="keys-adv"' + (k.claudeBearerToken ? ' open' : '') + '><summary>Advanced: Claude &amp; partner models via Google Vertex</summary>' +
        '<p class="keys-intro" style="margin:8px 0 10px">Claude and partner models on Vertex (Grok, Qwen, DeepSeek, Llama, GLM, GPT-OSS, Kimi) use an OAuth token, not an API key. Add your token <b>and</b> your GCP project ID above to run them on your own project.</p>' +
        '<div class="auth-field"><label>Vertex OAuth bearer token</label><input id="k-claude" type="password" autocomplete="off" spellcheck="false" placeholder="ya29.… (gcloud auth print-access-token)" value="' + esc(k.claudeBearerToken || '') + '" /></div>' +
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
    const m = body.querySelector('#keysMsg');
    if (nk.claudeBearerToken && !nk.gcpProject) {
      m.className = 'auth-msg err';
      m.textContent = 'Add your GCP project ID too: your own OAuth token only ever runs on your own project.';
      return;
    }
    saveKeys(nk);
    m.className = 'auth-msg ok'; m.textContent = 'Saved to this browser.';
    updateQuotaBadge();
  });
  body.querySelector('#clearKeysBtn').addEventListener('click', () => { saveKeys({}); updateQuotaBadge(); openKeysModal(); });
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* ignore */ }
  window.location.replace('/login');
}

let _modalReturnFocus = null;
function activateModalFocus(modalEl, initialSelector) {
  if (!modalEl) return;
  if (!_modalReturnFocus && document.activeElement && document.activeElement !== document.body) {
    _modalReturnFocus = document.activeElement;
  }
  requestAnimationFrame(() => {
    if (modalEl.classList.contains('hidden')) return;
    const target = (initialSelector && modalEl.querySelector(initialSelector))
      || modalEl.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])');
    if (target && typeof target.focus === 'function') {
      try { target.focus(); } catch (_) {}
    }
  });
}
function deactivateModalFocus() {
  const prev = _modalReturnFocus;
  _modalReturnFocus = null;
  if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
    try { prev.focus(); } catch (_) {}
  }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const activeModal = ['#authModal', '#mdModal', '#imgLightboxModal', '#cadMcpModal']
    .map((sel) => $(sel))
    .find((m) => m && !m.classList.contains('hidden'));
  if (!activeModal) return;
  const focusables = Array.from(
    activeModal.querySelectorAll('a[href], button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])')
  ).filter((node) => node.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && (document.activeElement === first || !activeModal.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !activeModal.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
});

// Minimal modal used by the account/user dialogs (separate from the markdown one).
function ensureAuthModal() {
  let m = $('#authModal');
  if (m) return m;
  m = el('div', 'md-modal hidden'); m.id = 'authModal';
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  m.setAttribute('aria-labelledby', 'authModalTitle');
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
function closeAuthModal(opts) {
  const m = $('#authModal');
  if (!m || m.classList.contains('hidden')) return;
  if (m.dataset.locked === '1' && !(opts && opts.force)) return;
  m.classList.add('hidden');
  deactivateModalFocus();
}
function openAuthModal(title, opts) {
  const m = ensureAuthModal();
  const locked = !!(opts && opts.locked);
  m.dataset.locked = locked ? '1' : '0';
  const closeBtn = m.querySelector('.md-modal-close');
  if (closeBtn) closeBtn.hidden = locked;
  $('#authModalTitle').textContent = title;
  const panel = m.querySelector('.auth-panel');
  if (panel) panel.classList.toggle('wide', !!(opts && opts.wide));
  m.classList.remove('hidden');
  activateModalFocus(m);
  return $('#authModalBody');
}

async function openAuditLogModal() {
  const body = openAuthModal('🛡️ 90-Day Security & Compliance Audit Log', { wide: true });
  body.innerHTML = '<p class="auth-loading">Loading 90-day audit trail…</p>';
  try {
    const r = await fetch('/api/admin/audit?limit=250', { credentials: 'same-origin' });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load audit log.');
    renderAuditLogModal(body, data);
  } catch (e) {
    body.innerHTML = '<p class="auth-err"></p>';
    body.querySelector('p').textContent = e.message;
  }
}

function renderAuditLogModal(body, data) {
  const runs = Array.isArray(data && data.runs) ? data.runs : [];
  const auditDays = (data && data.auditRetentionDays) || 90;
  const outDays = (data && data.runRetentionDays) || 7;
  const rows = runs.map((r) => {
    const acctBadge = r.isExternal
      ? '<span class="u-status warn" title="External account (IP & User-Agent logged)">External</span>'
      : '<span class="u-tag" title="@google.com account (pre-execution prompt/attachments logged, no IP/UA)">@google.com</span>';
    const statusBadge = r.hiddenByUser
      ? '<span class="u-status warn" title="User deleted this run from their history view — retained for 90-day admin audit">🗑️ Hidden by user</span>'
      : `<span class="u-tag">${esc(r.status || 'completed')}</span>`;
    const attLinks = (Array.isArray(r.attachments) ? r.attachments : []).map((a) => {
      const ref = a && (a.vaultRef || a.sha256);
      if (ref) {
        return `<a href="/api/me/vault/${encodeURIComponent(ref)}" target="_blank" rel="noopener" class="u-tag" title="Open retained input attachment from vault">📎 ${esc(a.name || ref.slice(0, 8))}</a>`;
      }
      return `<span class="u-tag">📎 ${esc((a && a.name) || 'attachment')}</span>`;
    }).join(' ');
    const netMeta = r.isExternal && (r.ip || r.userAgent)
      ? `<div style="font-size:11px;color:var(--muted);margin-top:3px">IP: <code>${esc(r.ip || 'n/a')}</code> · UA: <code>${esc(String(r.userAgent || 'n/a').slice(0, 90))}</code></div>`
      : '';
    return `<tr>
      <td style="white-space:nowrap;font-size:12px">${esc(fmtWhen(r.at))}<div style="font-size:11px;color:var(--muted)">${esc(r.arena || 'text')}</div></td>
      <td><b>${esc(r.user || '')}</b><div style="margin-top:3px">${acctBadge}</div></td>
      <td>${statusBadge}</td>
      <td style="max-width:440px">
        <div style="font-weight:600;font-size:12.5px">${esc(r.title || r.taskId || 'Run')}</div>
        <div style="font-size:12px;color:var(--muted);white-space:pre-wrap;max-height:72px;overflow:auto;margin-top:2px">${esc(String(r.prompt || '').slice(0, 600))}</div>
        ${attLinks ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">${attLinks}</div>` : ''}
        ${netMeta}
      </td>
    </tr>`;
  }).join('');

  body.innerHTML =
    `<p class="keys-intro" style="margin-top:0;margin-bottom:12px">All input prompts and uploaded input attachments are retained for <b>${auditDays} days</b> (recorded pre-execution before upstream Vertex AI or OpenAI calls). Unstarred model outputs and generated 4K images are pruned after <b>${outDays} days</b>. Non-admin deletes only hide the run from the user's view while preserving the ${auditDays}-day audit record below.</p>` +
    (runs.length
      ? `<table class="users-table"><thead><tr><th>Timestamp</th><th>User</th><th>Status</th><th>Input Prompt, Attachments &amp; Attribution</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="auth-loading">No audit records recorded yet.</p>');
}

async function openUsersModal() {
  const body = openAuthModal('Manage users & admins', { wide: true });
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
  const defaultVertexCap = (CONFIG && CONFIG.limits && Number.isFinite(CONFIG.limits.vertex)) ? CONFIG.limits.vertex : 10;
  const bootstrapAdmins = Array.isArray(data.bootstrapAdmins) ? data.bootstrapAdmins : [];
  const addedAdmins = Array.isArray(data.adminEmails) ? data.adminEmails : [];
  const allowedDomains = Array.isArray(data.allowedDomains) && data.allowedDomains.length
    ? data.allowedDomains
    : ((CONFIG && CONFIG.allowedDomains) || ['google.com']);
  const knownInternal = (Array.isArray(data.knownInternalUsers) ? data.knownInternalUsers : [])
    .filter((e) => !bootstrapAdmins.includes(e) && !addedAdmins.includes(e));

  const googleAdminRows = [
    ...bootstrapAdmins.map((e) => `<tr>
      <td class="u-name">${esc(e)}</td>
      <td><span class="u-role is-admin">admin</span></td>
      <td><span class="u-tag" title="Configured via ADMIN_EMAILS on the server">built-in (@google.com)</span></td>
      <td class="u-act"></td>
    </tr>`),
    ...addedAdmins.map((e) => {
      const isSelf = String(data.me || '').toLowerCase() === String(e).toLowerCase();
      const rmBtn = isSelf
        ? '<span class="u-you" title="This is you. Ask another admin to remove your own admin access.">you</span>'
        : `<button class="u-icon-btn danger u-rm-google-admin" type="button" data-email="${esc(e)}" title="Revoke @google.com admin role" aria-label="Revoke admin access for ${esc(e)}">${ICON_TRASH}</button>`;
      return `<tr>
        <td class="u-name">${esc(e)}</td>
        <td><span class="u-role is-admin">admin</span></td>
        <td><span class="u-status ok">✓ Google OAuth Admin</span></td>
        <td class="u-act"><div class="u-act-btns">${rmBtn}</div></td>
      </tr>`;
    }),
  ].join('');

  const quickPromoteHtml = knownInternal.length
    ? `<div style="margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">` +
        `<span style="font-size:11.5px;color:var(--muted)">Quick promote recent <code>@google.com</code> users:</span>` +
        knownInternal.slice(0, 8).map((e) =>
          `<button type="button" class="u-btn u-quick-promote-google" data-email="${esc(e)}" title="Make ${esc(e)} an admin">+ ${esc(e)}</button>`
        ).join('') +
      `</div>`
    : '';

  const rows = (data.users || []).map((u) => {
    const isMe = u.username === data.me;
    const statusBadge = u.mustChangePassword
      ? '<span class="u-status warn" title="User will be forced to set a new password on next sign-in (or immediately if signed in)">⚠️ Must change on login</span>'
      : '<span class="u-status ok" title="Password active">✓ Active</span>';
    // expiresAt arrives as a full ISO timestamp (end of day, UTC); <input type="date"> only
    // accepts YYYY-MM-DD - a raw ISO value renders blank and "Save limits" would wipe the expiry.
    const expDate = u.expiresAt ? String(u.expiresAt).slice(0, 10) : '';
    const expiryBadge = u.expired
      ? `<span class="u-status warn" title="External account has expired">⛔ Expired (${esc(expDate)})</span>`
      : (expDate
        ? `<span class="u-tag" title="External account expiration date">Expires ${esc(expDate)}</span>`
        : '<span class="u-tag" title="No account expiration date">No expiry</span>');
    const hasCustomCap = typeof u.dailyVertexLimit === 'number';
    const vertexCapVal = hasCustomCap ? u.dailyVertexLimit : defaultVertexCap;
    const vertexBadge = u.role === 'admin'
      ? '<span class="u-tag" title="Admins have unlimited Vertex AI runs">Unlimited Vertex</span>'
      : (hasCustomCap
        ? `<span class="u-tag u-tag-custom" title="Custom daily Vertex AI limit for this account on the shared key (default is ${esc(String(defaultVertexCap))}/day; runs on the user's own key never count)">${esc(String(vertexCapVal))}/day Vertex · custom</span>`
        : `<span class="u-tag" title="Default daily Vertex AI limit from Settings (runs on the user's own key never count)">${esc(String(vertexCapVal))}/day Vertex</span>`);
    const uAttr = esc(u.username);
    // Four compact square icon actions (title + aria-label carry the full meaning).
    const forceBtn = u.mustChangePassword
      ? `<button class="u-icon-btn is-active u-toggle-force" type="button" data-user="${uAttr}" data-force="0" title="Password change required on next sign-in. Click to clear the requirement" aria-label="Clear forced password change for ${uAttr}" aria-pressed="true">${ICON_LOCK_RESET}</button>`
      : `<button class="u-icon-btn warn u-toggle-force" type="button" data-user="${uAttr}" data-force="1" title="Force a password change on next sign-in (immediately if signed in)" aria-label="Force password change for ${uAttr}" aria-pressed="false">${ICON_LOCK_RESET}</button>`;
    const resetBtn = `<button class="u-icon-btn u-reset-pw" type="button" data-user="${uAttr}" title="Set a temporary password (and require a change on next sign-in)" aria-label="Set temporary password for ${uAttr}" aria-expanded="false">${ICON_KEY}</button>`;
    const limitsBtn = `<button class="u-icon-btn u-edit-limits" type="button" data-user="${uAttr}" title="Daily Vertex AI cap &amp; account expiration date" aria-label="Edit limits for ${uAttr}" aria-expanded="false">${ICON_GAUGE}</button>`;
    const del = isMe
      ? '<span class="u-you" title="This is you. You can\'t remove your own account">you</span>'
      : `<button class="u-icon-btn danger u-del" type="button" data-user="${uAttr}" title="Remove user" aria-label="Remove ${uAttr}">${ICON_TRASH}</button>`;
    return `<tr>
      <td class="u-name">${esc(u.username)}</td>
      <td><span class="u-role ${u.role === 'admin' ? 'is-admin' : ''}">${esc(u.role)}</span></td>
      <td>${statusBadge}</td>
      <td><div class="u-limit-tags">${vertexBadge}${expiryBadge}</div></td>
      <td class="u-act"><div class="u-act-btns">${forceBtn}${resetBtn}${limitsBtn}${del}</div></td>
    </tr>
    <tr class="u-reset-row hidden" data-reset-row="${esc(u.username)}">
      <td colspan="5">
        <div class="u-reset-box">
          <span style="font-size:12px;color:var(--muted)">New temp password for <b>${esc(u.username)}</b>:</span>
          <input type="password" class="u-reset-input" data-user="${esc(u.username)}" autocomplete="new-password" placeholder="Min 10 characters…" />
          <label class="auth-check" style="margin:0;font-size:12px"><input type="checkbox" class="u-reset-force-chk" data-user="${esc(u.username)}" checked /> Force change on login</label>
          <button class="submit-btn u-reset-save" type="button" data-user="${esc(u.username)}" style="margin:0;padding:6px 12px;font-size:12px">Save temp PW</button>
          <button class="u-btn u-reset-cancel" type="button" data-user="${esc(u.username)}">Cancel</button>
        </div>
        <div class="auth-msg u-reset-msg" data-user="${esc(u.username)}" style="margin-top:6px"></div>
      </td>
    </tr>
    <tr class="u-limits-row hidden" data-limits-row="${esc(u.username)}">
      <td colspan="5">
        <div class="u-reset-box">
          <span style="font-size:12px;color:var(--muted)">Limits for <b>${esc(u.username)}</b>:</span>
          <label style="font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px">Daily Vertex cap:
            <input type="number" min="0" max="10000" class="u-limits-vertex" data-user="${esc(u.username)}" value="${hasCustomCap ? esc(String(u.dailyVertexLimit)) : ''}" placeholder="${esc(String(defaultVertexCap))} (default)" title="Leave blank to use the default from Settings" style="width:110px;padding:5px 8px" />
          </label>
          <label style="font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px" title="Optional account expiration date">Expires:
            <input type="date" class="u-limits-expires" data-user="${esc(u.username)}" value="${esc(expDate)}" style="padding:5px 8px" />
          </label>
          <button class="submit-btn u-limits-save" type="button" data-user="${esc(u.username)}" style="margin:0;padding:6px 12px;font-size:12px">Save limits</button>
          <button class="u-btn u-limits-clear-exp" type="button" data-user="${esc(u.username)}" title="Clear expiration date">Clear expiry</button>
          <button class="u-btn u-limits-cancel" type="button" data-user="${esc(u.username)}">Cancel</button>
        </div>
        <div class="auth-msg u-limits-msg" data-user="${esc(u.username)}" style="margin-top:6px"></div>
      </td>
    </tr>`;
  }).join('');
  body.innerHTML =
    '<h4 class="st-h" style="margin-top:0">Google Workspace (<code>@google.com</code>) Admins</h4>' +
    '<p class="keys-intro" style="margin-top:4px;margin-bottom:10px">Grant full admin privileges (manage users, global keys, budgets, and audit logs; unlimited runs) to any ' + allowedDomains.map((d) => '<code>@' + esc(d) + '</code>').join(' / ') + ' user who signs in with Google. Changes take effect immediately without requiring sign-out.</p>' +
    '<table class="users-table st-table"><thead><tr><th>Google Account</th><th>Role</th><th>Source</th><th style="text-align:right">Actions</th></tr></thead><tbody>' + googleAdminRows + '</tbody></table>' +
    '<div class="st-add" style="margin-top:10px">' +
      '<input type="email" id="umGoogleAdminEmail" list="umKnownGoogleUsers" autocomplete="off" spellcheck="false" placeholder="colleague@' + esc(allowedDomains[0] || 'google.com') + '" aria-label="Google sign-in email to make an admin" />' +
      '<datalist id="umKnownGoogleUsers">' + knownInternal.map((e) => `<option value="${esc(e)}"></option>`).join('') + '</datalist>' +
      '<button class="submit-btn" type="button" id="umAddGoogleAdminBtn">+ Make @google.com user admin</button>' +
    '</div>' +
    quickPromoteHtml +
    '<div class="auth-msg" id="umGoogleAdminMsg" style="margin-top:6px;margin-bottom:14px"></div>' +
    '<h4 class="st-h">External Username / Password Accounts</h4>' +
    '<p class="keys-intro" style="margin-top:4px;margin-bottom:12px">External username/password accounts for non-<code>@google.com</code> users. You can require a password change on first login, set a daily Vertex AI run cap, or configure an optional account expiration date at any time.</p>' +
    '<table class="users-table"><thead><tr><th>Username</th><th>Role</th><th>Password Status</th><th>Vertex Cap &amp; Expiry</th><th style="text-align:right">Actions</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<form class="add-user-form" id="addUserForm">' +
      '<h4>Add an external user</h4>' +
      '<div class="auth-field"><label>Username or email</label><input id="nuUser" type="text" autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="e.g. alice@company.com or 3-32 chars (a-z 0-9 . _ -)" /></div>' +
      '<div class="auth-field"><label>Temporary / Initial password</label><input id="nuPass" type="password" autocomplete="new-password" placeholder="Min 10 chars (user will change on first login)" /></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        '<div class="auth-field"><label>Daily Vertex AI runs <span class="u-tag">optional</span></label><input id="nuVertexLimit" type="number" min="0" max="10000" placeholder="' + esc(String(defaultVertexCap)) + ' (default from Settings)" /></div>' +
        '<div class="auth-field"><label>Account expiration date <span class="u-tag">optional</span></label><input id="nuExpiresAt" type="date" /></div>' +
      '</div>' +
      '<label class="auth-check"><input id="nuForcePw" type="checkbox" checked /> Force user to change password on first sign-in (recommended for external accounts)</label>' +
      '<label class="auth-check"><input id="nuAdmin" type="checkbox" /> Make this user an admin (can manage users)</label>' +
      '<div class="auth-msg" id="nuMsg"></div>' +
      '<button class="submit-btn" type="submit">+ Add user</button>' +
    '</form>' +
    googleAccessHelp();

  const promoteGoogleAdmin = async (rawEmail) => {
    const email = String(rawEmail || '').trim().toLowerCase();
    const msgEl = body.querySelector('#umGoogleAdminMsg');
    if (!email) {
      if (msgEl) { msgEl.className = 'auth-msg err'; msgEl.textContent = 'Enter a @google.com email address.'; }
      return;
    }
    if (msgEl) { msgEl.className = 'auth-msg'; msgEl.textContent = 'Promoting ' + email + ' to admin…'; }
    try {
      const r = await fetch('/api/auth/google-admins', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (r.status === 401) { window.location.replace('/login'); return; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'Could not add Google admin.');
      renderUsersModal(body, j);
      const m2 = body.querySelector('#umGoogleAdminMsg');
      if (m2) { m2.className = 'auth-msg ok'; m2.textContent = `✓ ${email} is now an admin.`; }
    } catch (e) {
      if (msgEl) { msgEl.className = 'auth-msg err'; msgEl.textContent = e.message; }
    }
  };

  const addGAdminBtn = body.querySelector('#umAddGoogleAdminBtn');
  const addGAdminInp = body.querySelector('#umGoogleAdminEmail');
  if (addGAdminBtn && addGAdminInp) {
    addGAdminBtn.addEventListener('click', () => promoteGoogleAdmin(addGAdminInp.value));
    addGAdminInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); promoteGoogleAdmin(addGAdminInp.value); }
    });
  }
  body.querySelectorAll('.u-quick-promote-google').forEach((b) => {
    b.addEventListener('click', () => promoteGoogleAdmin(b.dataset.email));
  });
  body.querySelectorAll('.u-rm-google-admin').forEach((b) => {
    b.addEventListener('click', async () => {
      const email = b.dataset.email;
      if (!window.confirm(`Remove @google.com admin access for ${email}?`)) return;
      const msgEl = body.querySelector('#umGoogleAdminMsg');
      if (msgEl) { msgEl.className = 'auth-msg'; msgEl.textContent = 'Removing admin access…'; }
      try {
        const r = await fetch('/api/auth/google-admins/' + encodeURIComponent(email), {
          method: 'DELETE', credentials: 'same-origin',
        });
        if (r.status === 401) { window.location.replace('/login'); return; }
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || 'Could not remove Google admin.');
        renderUsersModal(body, j);
        const m2 = body.querySelector('#umGoogleAdminMsg');
        if (m2) { m2.className = 'auth-msg ok'; m2.textContent = `Removed admin access for ${email}.`; }
      } catch (e) {
        if (msgEl) { msgEl.className = 'auth-msg err'; msgEl.textContent = e.message; }
      }
    });
  });

  body.querySelectorAll('.u-del').forEach((b) => b.addEventListener('click', () => deleteUser(b.dataset.user, body)));
  body.querySelectorAll('.u-toggle-force').forEach((b) => b.addEventListener('click', () => toggleForcePasswordChange(b.dataset.user, b.dataset.force === '1', body)));
  // Inline editors (temp password / limits): keep the opener's aria-expanded in sync so the
  // icon shows as "open" while its row is visible.
  const syncExpanded = (selector, uname, open) => {
    const btn = body.querySelector(`${selector}[data-user="${CSS.escape(uname)}"]`);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  body.querySelectorAll('.u-reset-pw').forEach((b) => b.addEventListener('click', () => {
    const uname = b.dataset.user;
    const row = body.querySelector(`.u-reset-row[data-reset-row="${CSS.escape(uname)}"]`);
    if (!row) return;
    row.classList.toggle('hidden');
    const open = !row.classList.contains('hidden');
    syncExpanded('.u-reset-pw', uname, open);
    if (open) {
      const inp = row.querySelector('.u-reset-input');
      if (inp) inp.focus();
    }
  }));
  body.querySelectorAll('.u-reset-cancel').forEach((b) => b.addEventListener('click', () => {
    const uname = b.dataset.user;
    const row = body.querySelector(`.u-reset-row[data-reset-row="${CSS.escape(uname)}"]`);
    if (row) row.classList.add('hidden');
    syncExpanded('.u-reset-pw', uname, false);
  }));
  body.querySelectorAll('.u-reset-save').forEach((b) => b.addEventListener('click', () => saveUserTempPassword(b.dataset.user, body)));
  body.querySelectorAll('.u-reset-input').forEach((inp) => inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveUserTempPassword(inp.dataset.user, body); }
  }));
  body.querySelectorAll('.u-edit-limits').forEach((b) => b.addEventListener('click', () => {
    const uname = b.dataset.user;
    const row = body.querySelector(`.u-limits-row[data-limits-row="${CSS.escape(uname)}"]`);
    if (!row) return;
    row.classList.toggle('hidden');
    syncExpanded('.u-edit-limits', uname, !row.classList.contains('hidden'));
  }));
  body.querySelectorAll('.u-limits-cancel').forEach((b) => b.addEventListener('click', () => {
    const uname = b.dataset.user;
    const row = body.querySelector(`.u-limits-row[data-limits-row="${CSS.escape(uname)}"]`);
    if (row) row.classList.add('hidden');
    syncExpanded('.u-edit-limits', uname, false);
  }));
  body.querySelectorAll('.u-limits-clear-exp').forEach((b) => b.addEventListener('click', () => {
    const uname = b.dataset.user;
    const expInp = body.querySelector(`.u-limits-expires[data-user="${CSS.escape(uname)}"]`);
    if (expInp) expInp.value = '';
  }));
  body.querySelectorAll('.u-limits-save').forEach((b) => b.addEventListener('click', () => saveUserLimits(b.dataset.user, body)));
  body.querySelector('#addUserForm').addEventListener('submit', (e) => { e.preventDefault(); addUser(body); });
}

// ---------- Settings (admin): daily run limits on the global keys + internal admins ----------
async function openSettingsModal() {
  const body = openAuthModal('Settings', { wide: true });
  body.innerHTML = '<p class="auth-loading">Loading…</p>';
  let data;
  try {
    const r = await fetch('/api/admin/settings', { credentials: 'same-origin' });
    if (r.status === 401) { window.location.replace('/login'); return; }
    data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'Failed to load settings.');
  } catch (e) { body.innerHTML = '<p class="auth-err"></p>'; body.querySelector('p').textContent = e.message; return; }
  renderSettingsModal(body, data);
}

const SETTINGS_PROVIDER_HINTS = {
  openai: 'GPT text models + GPT Image',
  anthropic: 'Direct Anthropic API (Claude on Vertex counts as Vertex AI)',
  moonshot: 'Direct Moonshot (Kimi) API',
  vertex: 'Gemini, Claude, partner models & Nano Banana on Vertex AI',
};

function renderSettingsModal(body, data) {
  const s = data.settings || {};
  const limits = s.limits || {};
  const defaults = data.defaults || {};
  const maxLimit = data.maxLimit || 10000;
  const bootstrap = data.bootstrapAdmins || [];
  const added = s.adminEmails || [];
  const limitRows = (data.providers || []).map((p) => `
    <tr>
      <td class="u-name">${esc(p.label)}<div class="st-hint">${esc(SETTINGS_PROVIDER_HINTS[p.id] || '')}</div></td>
      <td><input type="number" class="st-limit" data-provider="${esc(p.id)}" min="0" max="${maxLimit}" step="1" value="${esc(String(limits[p.id] ?? defaults[p.id] ?? 0))}" aria-label="${esc(p.label)} runs per user per day" /></td>
      <td><span class="u-tag">default ${esc(String(defaults[p.id] ?? ''))}</span></td>
      <td>${p.globalKey
        ? '<span class="u-status ok" title="A global key is configured for this provider">✓ Global key set</span>'
        : '<span class="u-tag" title="No global key configured: users need their own key for this provider">No global key</span>'}</td>
    </tr>`).join('');
  const bootRows = bootstrap.map((e) => `<tr>
      <td class="u-name">${esc(e)}</td><td><span class="u-role is-admin">admin</span></td>
      <td><span class="u-tag" title="Set by ADMIN_EMAILS on the server, so it can't be removed here">built-in</span></td><td class="u-act"></td></tr>`).join('');
  const addedRows = added.map((e) => `<tr>
      <td class="u-name">${esc(e)}</td><td><span class="u-role is-admin">admin</span></td>
      <td><span class="u-tag">added in Settings</span></td>
      <td class="u-act"><div class="u-act-btns"><button class="u-icon-btn danger st-rm-admin" type="button" data-email="${esc(e)}" title="Remove admin access" aria-label="Remove admin access for ${esc(e)}">${ICON_TRASH}</button></div></td></tr>`).join('');
  const domains = (data.allowedDomains || []).map((d) => '@' + d).join(', ');
  const known = (data.knownInternalUsers || []).filter((e) => !bootstrap.includes(e) && !added.includes(e));
  const updated = s.updatedAt ? `Last changed ${esc(new Date(s.updatedAt).toLocaleString())}${s.updatedBy ? ' by ' + esc(s.updatedBy) : ''}.` : '';
  body.innerHTML =
    '<h4 class="st-h">Daily runs per user on the global API keys</h4>' +
    '<p class="keys-intro">Applies to every user, <code>@google.com</code> and external alike' + (data.adminsExempt ? ' (admins aren\'t limited)' : '') +
      '. A run is one Run click in the text or image arena and counts once per provider it uses, however many models it compares; re-runs, crash fixes and Blind Judge calls count too. ' +
      'Runs on a user\'s own keys never count. <b>0</b> turns that global key off for non-admins.</p>' +
    '<table class="users-table st-table"><thead><tr><th>Provider</th><th>Runs / user / day</th><th></th><th>Global key</th></tr></thead><tbody>' + limitRows + '</tbody></table>' +
    '<div class="st-actions"><button class="submit-btn" type="button" id="stSaveLimits">Save limits</button><span class="auth-msg" id="stLimitsMsg"></span></div>' +
    '<p class="st-note">External accounts can also get a custom Vertex AI limit in <b>Manage users</b>. ' + updated + '</p>' +
    '<h4 class="st-h">Spend on the global keys this month</h4>' +
    '<p class="keys-intro">App spend counts every model call this app ran on a global key (own-key calls excluded). Provider numbers come straight from the provider where it has an API. ' +
      '<b>Remaining</b> = your monthly budget minus the larger of the app spend and the provider\'s own month-to-date spend (where it has a spend API). ' +
      '<b>Budgets are enforced:</b> once a provider\'s budget is used up, runs on its global key are blocked' + (data.adminsExempt ? ' (admins aren\'t limited)' : '') +
      ' until next month or until the budget is raised; users with their own key keep going. <b>0</b> blocks that global key; blank means no budget.</p>' +
    '<div id="stSpend"><p class="auth-loading">Loading spend…</p></div>' +
    '<h4 class="st-h">Internal admins</h4>' +
    '<p class="keys-intro">Google sign-in accounts (' + esc(domains || 'your Workspace domain') + ') that can manage users, keys, settings and the audit log. Changes apply right away, no sign-out needed.</p>' +
    '<table class="users-table st-table"><thead><tr><th>Account</th><th>Role</th><th>Source</th><th style="text-align:right">Actions</th></tr></thead><tbody>' + bootRows + addedRows + '</tbody></table>' +
    '<div class="st-add">' +
      '<input type="email" id="stAdminEmail" list="stKnownUsers" autocomplete="off" spellcheck="false" placeholder="name@' + esc((data.allowedDomains && data.allowedDomains[0]) || 'google.com') + '" aria-label="Google sign-in email to make an admin" />' +
      '<datalist id="stKnownUsers">' + known.map((e) => `<option value="${esc(e)}"></option>`).join('') + '</datalist>' +
      '<button class="submit-btn" type="button" id="stAddAdmin">+ Add admin</button>' +
    '</div>' +
    '<div class="auth-msg" id="stAdminMsg"></div>';

  const post = async (payload, msgId, okText) => {
    const msgEl = body.querySelector('#' + msgId);
    msgEl.className = 'auth-msg'; msgEl.textContent = 'Saving…';
    try {
      const r = await fetch('/api/admin/settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 401) { window.location.replace('/login'); return; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'Could not save settings.');
      if (CONFIG && j.settings) CONFIG.limits = { ...j.settings.limits };
      updateQuotaBadge();
      renderSettingsModal(body, j);
      const m2 = body.querySelector('#' + msgId);
      if (m2) { m2.className = 'auth-msg ok'; m2.textContent = okText; }
    } catch (e) {
      msgEl.className = 'auth-msg err'; msgEl.textContent = e.message;
    }
  };

  body.querySelector('#stSaveLimits').addEventListener('click', () => {
    const payload = {};
    let bad = '';
    body.querySelectorAll('.st-limit').forEach((inp) => {
      const v = inp.value.trim();
      const n = Number(v);
      if (v === '' || !Number.isInteger(n) || n < 0 || n > maxLimit) bad = bad || `Use a whole number from 0 to ${maxLimit}.`;
      payload[inp.dataset.provider] = n;
    });
    if (bad) { const m = body.querySelector('#stLimitsMsg'); m.className = 'auth-msg err'; m.textContent = bad; return; }
    post({ limits: payload }, 'stLimitsMsg', 'Saved. New limits apply to the next run.');
  });
  const addAdmin = () => {
    const email = (body.querySelector('#stAdminEmail').value || '').trim().toLowerCase();
    if (!email) { const m = body.querySelector('#stAdminMsg'); m.className = 'auth-msg err'; m.textContent = 'Enter a Google sign-in email.'; return; }
    post({ adminEmails: [...added, email] }, 'stAdminMsg', `${email} is now an admin.`);
  };
  body.querySelector('#stAddAdmin').addEventListener('click', addAdmin);
  body.querySelector('#stAdminEmail').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAdmin(); } });
  body.querySelectorAll('.st-rm-admin').forEach((b) => b.addEventListener('click', () => {
    const email = b.dataset.email;
    if (!window.confirm(`Remove admin access for ${email}?`)) return;
    post({ adminEmails: added.filter((x) => x !== email) }, 'stAdminMsg', `Removed admin access for ${email}.`);
  }));
  loadSettingsSpend(body, false);
}

// ---------- Settings: spend on the global keys vs monthly budgets ----------
// Up to 4 decimals under $1 so a handful of cheap calls never reads as "$0.00".
const usdFmt = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const v = Number(n);
  const small = v !== 0 && Math.abs(v) < 1;
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: small ? 4 : 2 });
};

async function loadSettingsSpend(body, refresh, msg) {
  const box = body.querySelector('#stSpend');
  if (!box) return;
  try {
    const r = await fetch('/api/admin/spend' + (refresh ? '?refresh=1' : ''), { credentials: 'same-origin' });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'Could not load spend.');
    if (!body.querySelector('#stSpend')) return; // modal closed or re-rendered meanwhile
    renderSettingsSpend(body, data, msg);
  } catch (e) {
    box.innerHTML = '<p class="auth-err"></p>';
    box.querySelector('p').textContent = e.message;
  }
}

function renderSettingsSpend(body, data, msg) {
  const box = body.querySelector('#stSpend');
  const [yy, mm] = String(data.month || '').split('-').map(Number);
  const monthLabel = yy ? new Date(Date.UTC(yy, (mm || 1) - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'This month';
  const providerCell = (p) => {
    const v = p.provider || {};
    const what = v.kind === 'balance' ? 'balance left' : 'org spend';
    if (v.ok) return `<b>${usdFmt(v.usd)}</b> ${what}<div class="st-hint">${esc(v.source || '')}</div>`;
    if (v.error) return `<span class="st-err">Couldn't read it: ${esc(v.error)}</span>`;
    return `<span class="st-hint">${esc(v.note || 'No provider API')}</span>`;
  };
  const rows = (data.providers || []).map((p) => {
    const calls = (p.app && p.app.calls) || 0;
    const appCell = `<b>${usdFmt(p.app && p.app.usd)}</b><div class="st-hint">${calls} call${calls === 1 ? '' : 's'}${p.globalKey ? '' : ' · no global key'}</div>`;
    const budgetCell = `<input type="number" class="st-budget" data-provider="${esc(p.id)}" min="0" step="1" placeholder="none" value="${p.budgetUsd == null ? '' : esc(String(p.budgetUsd))}" aria-label="${esc(p.label)} monthly budget in US dollars" />`;
    let remainCell = '<span class="st-hint">Set a budget</span>';
    if (p.budgetUsd != null) {
      const used = Number(p.usedPct) || 0;
      const cls = (p.remainingUsd < 0 || used >= 100) ? 'over' : used >= 80 ? 'warn' : 'ok';
      const headline = p.remainingUsd < 0
        ? `<b>${usdFmt(-p.remainingUsd)}</b> over budget · ${used}% used`
        : `<b>${usdFmt(p.remainingUsd)}</b> left · ${used}% used`;
      remainCell = `<div class="st-remain ${cls}">${headline}</div>`
        + `<div class="st-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, used)}"><span class="${cls}" style="width:${Math.max(0, Math.min(100, used))}%"></span></div>`
        + (p.budgetUsedUp
          ? `<div class="st-err" title="Runs that need the global ${esc(p.label)} key are rejected until next month or until this budget is raised. Runs on users' own keys aren't affected.">${Number(p.budgetUsd) > 0 ? 'Budget used up' : '$0 budget'}, global-key runs blocked</div>`
          : '')
        + `<div class="st-hint">vs ${p.basis === 'provider' ? esc(p.label) + '-reported' : 'app-tracked'} spend</div>`;
    }
    return `<tr><td class="u-name">${esc(p.label)}</td><td>${appCell}</td><td>${providerCell(p)}</td><td>${budgetCell}</td><td>${remainCell}</td></tr>`;
  }).join('');
  const since = data.trackingSince ? new Date(data.trackingSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const asOf = (data.providers || []).map((p) => p.provider && p.provider.asOf).filter(Boolean).sort().pop();
  box.innerHTML =
    '<table class="users-table st-table st-spend-table"><thead><tr><th>' + esc(monthLabel) + '</th><th>Spent via this app</th><th>Provider says</th><th>Monthly budget ($)</th><th>Remaining</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="st-actions"><button class="submit-btn" type="button" id="stSaveBudgets">Save budgets</button>' +
      '<button class="u-btn" type="button" id="stRefreshSpend" title="Re-read provider numbers (at most once a minute)">↻ Refresh</button>' +
      '<span class="auth-msg" id="stBudgetMsg"></span></div>' +
    '<p class="st-note">' + (since ? `App spend tracked since ${esc(since)} (it started with this release, so earlier usage this month isn't in it). ` : 'No global-key calls tracked yet this month. ') +
      (asOf ? `Provider numbers as of ${esc(new Date(asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}.` : '') + '</p>';
  if (msg) { const m = box.querySelector('#stBudgetMsg'); m.className = 'auth-msg ' + (msg.ok ? 'ok' : 'err'); m.textContent = msg.text; }

  box.querySelector('#stRefreshSpend').addEventListener('click', () => {
    const m = box.querySelector('#stBudgetMsg'); m.className = 'auth-msg'; m.textContent = 'Refreshing…';
    loadSettingsSpend(body, true);
  });
  box.querySelector('#stSaveBudgets').addEventListener('click', async () => {
    const m = box.querySelector('#stBudgetMsg');
    const budgets = {};
    let bad = '';
    box.querySelectorAll('.st-budget').forEach((inp) => {
      const v = inp.value.trim();
      if (v === '') { budgets[inp.dataset.provider] = null; return; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) bad = bad || 'Budgets are dollar amounts of 0 or more, or blank for none.';
      budgets[inp.dataset.provider] = n;
    });
    if (bad) { m.className = 'auth-msg err'; m.textContent = bad; return; }
    m.className = 'auth-msg'; m.textContent = 'Saving…';
    try {
      const r = await fetch('/api/admin/settings', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgets }),
      });
      if (r.status === 401) { window.location.replace('/login'); return; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'Could not save budgets.');
      loadSettingsSpend(body, false, { ok: true, text: 'Budgets saved.' });
    } catch (e) {
      m.className = 'auth-msg err'; m.textContent = e.message;
    }
  });
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
  const lim = (CONFIG && CONFIG.limits) || {};
  const limitsLine = BUDGET_ORDER.map((p) => `${BUDGET_LABELS[p]} ${lim[p] ?? 0}`).join(', ');
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
    '<p class="keys-intro">Runs on these shared keys count toward each user\'s daily limits (<b>' + esc(limitsLine) + ' runs/day</b>, set in <b>Settings</b>). ' +
    'A user who adds their own key for every model they select, under <em>Your API keys</em> (which stays in their browser), runs <b>unlimited</b> and never touches these keys.</p>' +
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
  const forceChk = body.querySelector('#nuForcePw');
  const mustChangePassword = forceChk ? !!forceChk.checked : true;
  const expEl = body.querySelector('#nuExpiresAt');
  const vLimEl = body.querySelector('#nuVertexLimit');
  const expiresAt = expEl && expEl.value ? expEl.value.trim() : null;
  const dailyVertexLimit = vLimEl && vLimEl.value ? Number(vLimEl.value) : undefined;
  const btn = body.querySelector('#addUserForm .submit-btn');
  btn.disabled = true;
  try {
    const r = await fetch('/api/auth/users', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role, mustChangePassword, expiresAt, dailyVertexLimit }),
    });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Could not add user.');
    renderUsersModal(body, { ...j, me: (ME && ME.username) }); // refresh list
  } catch (e) {
    msg.className = 'auth-msg err'; msg.textContent = e.message; btn.disabled = false;
  }
}

async function saveUserLimits(username, body) {
  const escUser = CSS.escape(username);
  const vInp = body.querySelector(`.u-limits-vertex[data-user="${escUser}"]`);
  const eInp = body.querySelector(`.u-limits-expires[data-user="${escUser}"]`);
  const msg = body.querySelector(`.u-limits-msg[data-user="${escUser}"]`);
  const btn = body.querySelector(`.u-limits-save[data-user="${escUser}"]`);
  const dailyVertexLimit = vInp && vInp.value ? Number(vInp.value) : null;
  const expiresAt = eInp && eInp.value ? eInp.value.trim() : null;
  if (msg) { msg.className = 'auth-msg u-limits-msg'; msg.textContent = ''; }
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/auth/users/' + encodeURIComponent(username) + '/limits', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailyVertexLimit, expiresAt }),
    });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Could not update external account limits.');
    renderUsersModal(body, { ...j, me: (ME && ME.username) });
  } catch (e) {
    if (msg) { msg.className = 'auth-msg err u-limits-msg'; msg.textContent = e.message; }
    if (btn) btn.disabled = false;
  }
}

async function toggleForcePasswordChange(username, mustChangePassword, body) {
  try {
    const r = await fetch('/api/auth/users/' + encodeURIComponent(username) + '/force-password-change', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mustChangePassword: !!mustChangePassword }),
    });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Could not update password policy.');
    renderUsersModal(body, { ...j, me: (ME && ME.username) });
  } catch (e) { window.alert(e.message); }
}

async function saveUserTempPassword(username, body) {
  const escUser = CSS.escape(username);
  const inp = body.querySelector(`.u-reset-input[data-user="${escUser}"]`);
  const chk = body.querySelector(`.u-reset-force-chk[data-user="${escUser}"]`);
  const msg = body.querySelector(`.u-reset-msg[data-user="${escUser}"]`);
  const btn = body.querySelector(`.u-reset-save[data-user="${escUser}"]`);
  const password = inp ? inp.value : '';
  const mustChangePassword = chk ? !!chk.checked : true;
  if (msg) { msg.className = 'auth-msg u-reset-msg'; msg.textContent = ''; }
  if (!password) {
    if (msg) { msg.className = 'auth-msg err u-reset-msg'; msg.textContent = 'Enter a temporary password first.'; }
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/auth/users/' + encodeURIComponent(username) + '/reset-password', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, mustChangePassword }),
    });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Could not reset password.');
    renderUsersModal(body, { ...j, me: (ME && ME.username) });
  } catch (e) {
    if (msg) { msg.className = 'auth-msg err u-reset-msg'; msg.textContent = e.message; }
    if (btn) btn.disabled = false;
  }
}

async function deleteUser(username, body) {
  if (!window.confirm(`Remove user "${username}"? They will be signed out immediately.`)) return;
  try {
    const r = await fetch('/api/auth/users/' + encodeURIComponent(username), { method: 'DELETE', credentials: 'same-origin' });
    if (r.status === 401) { window.location.replace('/login'); return; }
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || 'Could not remove user.');
    renderUsersModal(body, { ...j, me: (ME && ME.username) });
  } catch (e) { window.alert(e.message); }
}

function openChangePwModal(opts) {
  const forced = !!(opts && opts.forced);
  const body = openAuthModal(forced ? 'Password change required' : 'Change my password', { locked: forced });
  const forcedBanner = forced
    ? '<div class="key-scope global" style="margin-bottom:14px">' +
        '<div class="ks-head">⚠️ Password update required</div>' +
        '<p style="margin:0;font-size:12.5px;color:var(--muted);line-height:1.5">Your administrator requires you to replace your temporary password with a new password (min 10 characters) before using LLM Compare.</p>' +
      '</div>'
    : '';
  const signOutBtn = forced
    ? '<button class="u-del" type="button" id="cpLogoutBtn">Sign out</button>'
    : '';
  body.innerHTML =
    forcedBanner +
    '<form class="add-user-form" id="changePwForm" style="' + (forced ? 'margin-top:0;padding-top:0;border-top:none' : '') + '">' +
      '<div class="auth-field"><label>' + (forced ? 'Current / temporary password' : 'Current password') + '</label><input id="cpCur" type="password" autocomplete="current-password" /></div>' +
      '<div class="auth-field"><label>New password</label><input id="cpNew" type="password" autocomplete="new-password" placeholder="Min 10 characters" /></div>' +
      '<div class="auth-field"><label>Confirm new password</label><input id="cpConf" type="password" autocomplete="new-password" /></div>' +
      '<div class="auth-msg" id="cpMsg"></div>' +
      '<div class="keys-actions"><button class="submit-btn" type="submit">Update password</button>' + signOutBtn + '</div>' +
    '</form>';
  const loBtn = body.querySelector('#cpLogoutBtn');
  if (loBtn) loBtn.addEventListener('click', logout);
  body.querySelector('#changePwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = body.querySelector('#cpMsg'); msg.className = 'auth-msg'; msg.textContent = '';
    const cur = body.querySelector('#cpCur').value;
    const nw = body.querySelector('#cpNew').value;
    const conf = body.querySelector('#cpConf').value;
    if (nw !== conf) { msg.className = 'auth-msg err'; msg.textContent = 'New passwords do not match.'; return; }
    if (nw === cur) { msg.className = 'auth-msg err'; msg.textContent = 'New password must be different from your current password.'; return; }
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
      if (ME) ME.mustChangePassword = false;
      if (CONFIG && CONFIG.me) CONFIG.me.mustChangePassword = false;
      const m = $('#authModal');
      if (m) {
        m.dataset.locked = '0';
        const cb = m.querySelector('.md-modal-close');
        if (cb) cb.hidden = false;
      }
      msg.className = 'auth-msg ok'; msg.textContent = 'Password updated.';
      btn.disabled = false;
      body.querySelector('#cpCur').value = body.querySelector('#cpNew').value = body.querySelector('#cpConf').value = '';
      if (forced) {
        setTimeout(() => closeAuthModal({ force: true }), 500);
      }
    } catch (e2) { msg.className = 'auth-msg err'; msg.textContent = e2.message; btn.disabled = false; }
  });
}

// ---------- model slots: add / remove from the fixed catalog ----------
function catalog() { return (CONFIG && CONFIG.catalog) || []; }

// ---------- 3-Dropdown Cascading Slot Selector (Provider > Model > Thinking Mode) ----------
const ALL_SLOT_IDS = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, MAX_SLOTS);
let SLOT_IDS = ['A', 'B'];               // active slots (1 .. 6)
const SLOT_ASSIGN = {};                  // slot -> catalogId | null
const SLOT_EFFORT = {};                  // slot -> chosen thinking level | null
const SLOT_PROVIDER_FILTER = {};         // slot -> chosen provider filter in Dropdown 1
const PROVIDER_FAMILIES = [
  { id: 'google',    label: 'Google (Gemini)' },
  { id: 'anthropic', label: 'Anthropic (Claude)' },
  { id: 'openai',    label: 'OpenAI' },
  { id: 'xai',       label: 'xAI (Grok)' },
  { id: 'meta',      label: 'Meta (Llama)' },
  { id: 'deepseek',  label: 'DeepSeek' },
  { id: 'qwen',      label: 'Alibaba (Qwen)' },
  { id: 'moonshot',  label: 'Moonshot (Kimi)' },
  { id: 'zai',       label: 'Z.AI (GLM)' },
];

// Sibling Reasoning <-> Non-Reasoning catalog pairs so Dropdown 3 ("Thinking Mode")
// can toggle between Reasoning and Standard variants of the same family cleanly.
const REASONING_SIBLING_PAIRS = {
  'grok-4.20-reasoning':      [
    { id: 'grok-4.20-reasoning',     label: 'Reasoning', groupLabel: 'Grok 4.20' },
    { id: 'grok-4.20-non-reasoning', label: 'Standard',  groupLabel: 'Grok 4.20' },
  ],
  'grok-4.20-non-reasoning':  [
    { id: 'grok-4.20-reasoning',     label: 'Reasoning', groupLabel: 'Grok 4.20' },
    { id: 'grok-4.20-non-reasoning', label: 'Standard',  groupLabel: 'Grok 4.20' },
  ],
  'grok-4.1-fast-reasoning': [
    { id: 'grok-4.1-fast-reasoning',     label: 'Reasoning', groupLabel: 'Grok 4.1 Fast' },
    { id: 'grok-4.1-fast-non-reasoning', label: 'Standard',  groupLabel: 'Grok 4.1 Fast' },
  ],
  'grok-4.1-fast-non-reasoning': [
    { id: 'grok-4.1-fast-reasoning',     label: 'Reasoning', groupLabel: 'Grok 4.1 Fast' },
    { id: 'grok-4.1-fast-non-reasoning', label: 'Standard',  groupLabel: 'Grok 4.1 Fast' },
  ],
  'qwen3-next-80b-a3b-thinking-maas': [
    { id: 'qwen3-next-80b-a3b-thinking-maas', label: 'Reasoning', groupLabel: 'Qwen3 Next 80B' },
    { id: 'qwen3-next-80b-a3b-instruct-maas', label: 'Standard',  groupLabel: 'Qwen3 Next 80B' },
  ],
  'qwen3-next-80b-a3b-instruct-maas': [
    { id: 'qwen3-next-80b-a3b-thinking-maas', label: 'Reasoning', groupLabel: 'Qwen3 Next 80B' },
    { id: 'qwen3-next-80b-a3b-instruct-maas', label: 'Standard',  groupLabel: 'Qwen3 Next 80B' },
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

function getUsername() {
  return (CONFIG && CONFIG.me && CONFIG.me.username) ? CONFIG.me.username : 'default';
}

function loadLocalSlots() {
  try {
    const raw = localStorage.getItem('ullm.pref.' + getUsername());
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return (obj && Array.isArray(obj.slots) && obj.slots.length) ? obj.slots : null;
  } catch (_) { return null; }
}

function loadLocalTaskId() {
  try {
    const raw = localStorage.getItem('ullm.pref.' + getUsername());
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return (obj && typeof obj.taskId === 'string') ? obj.taskId : null;
  } catch (_) { return null; }
}

function restoreCustomAttachmentsFromData(list) {
  if (!Array.isArray(list) || !list.length) {
    clearAttachments();
    return;
  }
  CUSTOM_ATTACHMENTS = list.map((a) => {
    const lowerName = String(a.name || '').toLowerCase();
    const mimeType = a.mimeType || (lowerName.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
    const isImage = !a.isEmpty && (/^image\/(png|jpeg|jpg|webp|gif)$/i.test(mimeType) || /\.(png|jpe?g|webp|gif)$/i.test(lowerName));
    const vaultHash = a.vaultRef || a.sha256 || null;
    const blobMissing = Boolean(a.blobMissing || a.hasBlob === false);
    const isVaultCached = !blobMissing && Boolean(a.cached || vaultHash || a.sha1);
    const cleanDataB64 = String(a.data || '').replace(/^data:[^;]+;base64,/, '');
    const previewUrl = (isImage && cleanDataB64)
      ? `data:${mimeType};base64,${cleanDataB64}`
      : (blobMissing
        ? null
        : (a.previewUrl || a.thumbnailUrl || (isImage && vaultHash ? `/api/me/vault/${encodeURIComponent(vaultHash)}` : null)));
    const attObj = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: a.name || 'file',
      mimeType,
      size: Number(a.size) || (cleanDataB64 ? Math.round(cleanDataB64.length * 0.75) : 0),
      isEmpty: Boolean(a.isEmpty),
      pageCount: Number(a.pageCount) || 0,
      warning: a.warning || null,
      optBadge: a.optBadge || null,
      sha1: a.sha1 || null,
      sha256: a.sha256 || vaultHash || null,
      vaultRef: vaultHash,
      cached: isVaultCached,
      blobMissing,
      estimatedTokens: Number(a.estimatedTokens) || 0,
      data: cleanDataB64,
      textContent: a.textContent || '',
      previewUrl,
    };
    if (a.claudeDataBase64) {
      attObj.claudeDataBase64 = a.claudeDataBase64;
      attObj.claudeMimeType = a.claudeMimeType || 'image/webp';
    }
    if (a.fitDataBase64) {
      attObj.fitDataBase64 = a.fitDataBase64;
      attObj.fitMimeType = a.fitMimeType || 'image/jpeg';
    }
    return attObj;
  });

  renderAttachments();
  renderTaskMeta();

  // Only inspect on server if this attachment is NOT already in the user's vault/cache
  CUSTOM_ATTACHMENTS.forEach((att) => {
    if (!att.cached && (att.data || att.textContent)) {
      inspectAttachmentOnServer(att);
    }
  });
}

let _prefSaveTimer = null;
function saveUserPreferencesDebounced() {
  if (_prefSaveTimer) clearTimeout(_prefSaveTimer);
  _prefSaveTimer = setTimeout(() => {
    _prefSaveTimer = null;
    saveUserPreferencesImmediate();
  }, 400);
}

function saveUserPreferencesImmediate() {
  if (_prefSaveTimer) {
    clearTimeout(_prefSaveTimer);
    _prefSaveTimer = null;
  }
  if (!CONFIG || !CONFIG.me || !CONFIG.me.username) return;
  const uname = CONFIG.me.username;
  const taskSelectEl = $('#taskSelect');
  const taskId = (taskSelectEl && taskSelectEl.value) || 'custom';
  const slots = SLOT_IDS.map((s) => ({
    slot: s,
    catalogId: SLOT_ASSIGN[s] || null,
    effort: SLOT_EFFORT[s] || null,
  })).filter((s) => s.catalogId);

  const payload = {
    taskId,
    slots,
    models: slots.map((s) => ({ catalogId: s.catalogId, effort: s.effort })),
  };

  if (!CONFIG.me.preferences) CONFIG.me.preferences = {};
  CONFIG.me.preferences.slots = slots;
  CONFIG.me.preferences.models = payload.models;
  CONFIG.me.preferences.taskId = taskId;
  CONFIG.me.lastModels = payload.models;

  try {
    localStorage.setItem('ullm.pref.' + uname, JSON.stringify(payload));
  } catch (_) {}

  try {
    fetch('/api/me/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
    }).catch(() => {});
  } catch (_) {}
}

// Map retired / zero-quota / 404 model IDs to verified active catalog models,
// while never overwriting valid saved models (such as gemini-3.7-flash or claude-opus-4-7).
const RETIRED_MODEL_MAP = {
  'claude-opus-5-5-fast': 'claude-opus-5-5', // not enabled in the project's Model Garden (404, 2026-10-15)
  'claude-fable-5': 'claude-sonnet-5',
  'claude-mythos-5': 'claude-opus-5-5',
  'claude-opus-4-5': 'claude-opus-4-7',
  'claude-sonnet-4-5': 'claude-sonnet-4-6',
  'grok-4.6': 'grok-4.20-reasoning',
  'gpt-6-terra': 'gpt-5.6-terra',
};

function seedSlots() {

  const me = CONFIG && CONFIG.me;
  const userSlots = (me && me.preferences && me.preferences.slots)
    || (me && me.lastModels)
    || loadLocalSlots();
  let rawList = (Array.isArray(userSlots) && userSlots.length) ? userSlots : CONFIG.models;

  // If the user's saved slots match the old 4-slot default that had zero-quota
  // `claude-fable-5` in Slot C, drop `claude-fable-5` so they cleanly get the default.
  if (Array.isArray(rawList) && rawList.length === 4) {
    const ids = rawList.map((m) => m && (m.catalogId || m.id));
    if (ids.includes('claude-fable-5')) {
      rawList = rawList.filter((m) => {
        const id = m && (m.catalogId || m.id);
        return id !== 'claude-fable-5';
      });
    }
  }

  // Migrate legacy 3-model default (`gemini-4-argon` / `gemini-3.8-flash`, `claude-opus-5-5`, `gpt-6-sol`)
  // to the new 2-model Gemini Models default (`gemini-3.8-flash` + `gemini-4-argon`) once per user
  // unless the user subsequently selects a different lineup.
  let migratedToGeminiDefault = false;
  try {
    const migKey = 'ullm.geminiDefaultV1.' + getUsername();
    if (!localStorage.getItem(migKey) && Array.isArray(rawList)) {
      const ids = rawList.map((m) => m && (m.catalogId || m.id));
      const isLegacyThreeSlotDefault = ids.length === 3
        && (ids[0] === 'gemini-4-argon' || ids[0] === 'gemini-3.8-flash')
        && (ids[1] === 'claude-opus-5-5' || ids[1] === 'claude-opus-5')
        && ids[2] === 'gpt-6-sol'
        && rawList.every((m) => !m || !m.effort);
      if (isLegacyThreeSlotDefault) {
        rawList = CONFIG.models;
        migratedToGeminiDefault = true;
      }
      localStorage.setItem(migKey, '1');
    }
  } catch (_) {}

  const usable = (list) => (list || [])
    .map((m) => {
      const rawId = m.catalogId || m.id;
      const mappedId = RETIRED_MODEL_MAP[rawId] || rawId;
      const c = catalog().find((x) => x.id === mappedId);
      const defVal = c && c.thinkingOptions && c.thinkingOptions.defaultValue;
      const eff = (m.effort && m.effort !== defVal) ? m.effort : null;
      return { id: mappedId, effort: eff, slot: m.slot || null };
    })
    .filter((m) => { const c = catalog().find((x) => x.id === m.id); return c && modelAvailability(c).ok; })
    .slice(0, MAX_SLOTS);

  let list = usable(rawList);
  if (!list.length) list = usable(CONFIG.models);

  // Heal legacy Flagships preset state where gemini-3.8-flash and gpt-6-sol had
  // hardcoded `effort: 'high'` instead of their documented `medium` defaults.
  const hasLegacyFlagshipHigh = list.some((m) => m.id === 'gemini-3.8-flash' && m.effort === 'high')
    && list.some((m) => m.id === 'gpt-6-sol' && m.effort === 'high');
  if (hasLegacyFlagshipHigh || migratedToGeminiDefault) {
    if (hasLegacyFlagshipHigh) {
      list = list.map((m) => ({
        ...m,
        id: m.id === 'claude-opus-5' ? 'claude-opus-5-5' : m.id,
        effort: null,
      }));
    }
    setTimeout(() => {
      if (typeof saveUserPreferencesDebounced === 'function') saveUserPreferencesDebounced();
    }, 50);
  }

  const count = Math.max(1, Math.min(MAX_SLOTS, list.length || 2));
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
  const defVal = c.thinkingOptions && c.thinkingOptions.defaultValue;
  const rawEff = SLOT_EFFORT[slot] || null;
  const eff = (rawEff && rawEff !== defVal) ? rawEff : undefined;
  const matchedOpt = eff && c.thinkingOptions && Array.isArray(c.thinkingOptions.options)
    ? c.thinkingOptions.options.find((o) => o.value === eff)
    : null;
  const effectiveThinking = (matchedOpt && matchedOpt.profile) || c.thinking || null;
  const effDisplay = eff || defVal || (c.thinking && c.thinking.label) || 'default';
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
    ...(Array.isArray(c.priceTiers) && c.priceTiers.length ? { priceTiers: c.priceTiers } : {}),
    external: !!c.external,
    thinking: effectiveThinking,
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
  const defVal = c.thinkingOptions && c.thinkingOptions.defaultValue;
  if (effortOverride !== undefined) {
    SLOT_EFFORT[slot] = (effortOverride && effortOverride !== defVal) ? effortOverride : null;
  } else {
    // Switching models resets the slot to the newly selected model's documented default
    SLOT_EFFORT[slot] = null;
  }
  afterSlotChange();
}

function addSlot() {
  if (SLOT_IDS.length >= MAX_SLOTS) return;
  if (!confirmInterruptRun('A comparison is still running. Stop it and add a model slot?')) return;
  const nextSlot = ALL_SLOT_IDS.find((s) => !SLOT_IDS.includes(s));
  if (!nextSlot) return;
  // Pick verified frontier models for new slots
  const preferredOrder = [
    'gemini-4-argon', 'gemini-3.8-flash', 'claude-fable-5-1', 'gpt-6.1-sol', 'claude-opus-5-5', 'gpt-6-sol', 'claude-sonnet-5-5',
    'grok-4.20-reasoning', 'deepseek-v3.2-maas', 'llama-4-maverick-17b-128e-maas',
  ];
  const existingIds = new Set(SLOT_IDS.map((s) => SLOT_ASSIGN[s]));
  let chosenId = preferredOrder.find((id) => {
    const c = catalog().find((x) => x.id === id);
    return c && modelAvailability(c).ok && !existingIds.has(id);
  });
  if (!chosenId) {
    const firstAvail = catalog().find((c) => modelAvailability(c).ok);
    chosenId = firstAvail ? firstAvail.id : 'gemini-4-argon';
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
  // Removing a column mid-run shifts the remaining assignments down, so a
  // stream would render under another model's label (1.1): stop first.
  if (!confirmInterruptRun('A comparison is still running. Stop it and remove this slot?')) return;
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

function builtinPresetSlots(presetName) {
  let target = [];
  if (presetName === 'gemini') {
    target = [
      { id: 'gemini-3.8-flash',    effort: null },
      { id: 'gemini-4-argon',      effort: null },
    ];
  } else if (presetName === 'frontier') {
    target = [
      { id: 'gemini-4-argon',      effort: null },
      { id: 'claude-fable-5-1',    effort: null },
      { id: 'gpt-6.1-sol',         effort: null },
    ];
  } else if (presetName === 'fast') {
    const fastThird = catalog().find((x) => x.id === 'gpt-6-luna' && modelAvailability(x).ok)
      ? 'gpt-6-luna'
      : 'grok-4.20-non-reasoning';
    target = [
      { id: 'gemini-3.8-flash',    effort: null },
      { id: 'claude-sonnet-5-5',   effort: null },
      { id: fastThird,             effort: null },
    ];
  } else if (presetName === 'same-model-thinking') {
    target = [
      { id: 'gemini-3.8-flash', effort: 'low' },
      { id: 'gemini-3.8-flash', effort: null },
      { id: 'gemini-3.8-flash', effort: 'high' },
    ];
  } else if (presetName === 'grok-reasoning') {
    target = [
      { id: 'grok-4.20-reasoning',          effort: null },
      { id: 'grok-4.20-non-reasoning',      effort: null },
      { id: 'grok-4.1-fast-reasoning',      effort: null },
    ];
  } else if (presetName === 'open-maas') {
    target = [
      { id: 'llama-4-maverick-17b-128e-maas', effort: null },
      { id: 'deepseek-v3.2-maas',             effort: null },
      { id: 'qwen3-235b-a22b-instruct-maas',  effort: null },
    ];
  }
  return target.filter((t) => {
    const c = catalog().find((x) => x.id === t.id);
    return c && modelAvailability(c).ok;
  });
}

function applyPreset(presetName) {
  const valid = builtinPresetSlots(presetName);
  if (!valid.length) return;
  if (!confirmInterruptRun('A comparison is still running. Stop it and apply this preset?')) return;
  ACTIVE_SAVED_PRESET_ID = null;
  SLOT_IDS = ALL_SLOT_IDS.slice(0, valid.length);
  ALL_SLOT_IDS.forEach((s, i) => {
    SLOT_ASSIGN[s] = valid[i] ? valid[i].id : null;
    SLOT_EFFORT[s] = valid[i] ? valid[i].effort : null;
  });
  afterSlotChange();
}

function getSavedPresetById(id) {
  if (!id) return null;
  const cleanId = String(id).replace(/^preset:/, '');
  return SAVED_PRESETS.find((p) => p && p.id === cleanId) || null;
}

function normalizeSlotEffort(catalogId, rawEffort) {
  const c = catalog().find((x) => x.id === catalogId);
  const defVal = c && c.thinkingOptions && c.thinkingOptions.defaultValue;
  const eff = rawEffort ? String(rawEffort).trim() : '';
  return (eff && eff !== defVal) ? eff : '';
}

function currentLineupSlots() {
  return SLOT_IDS.map((s, idx) => ({
    slot: ALL_SLOT_IDS[idx] || s,
    catalogId: SLOT_ASSIGN[s] || null,
    effort: normalizeSlotEffort(SLOT_ASSIGN[s], SLOT_EFFORT[s]) || null,
  })).filter((s) => s.catalogId);
}

function lineupSignature(slots) {
  return (slots || [])
    .filter((s) => s && (s.catalogId || s.id))
    .map((s) => {
      const cid = s.catalogId || s.id;
      const eff = normalizeSlotEffort(cid, s.effort);
      return `${cid}:${eff || 'default'}`;
    })
    .join('|');
}

function describePresetTooltip(preset) {
  if (!preset || !Array.isArray(preset.slots)) return '';
  return preset.slots.map((s, idx) => {
    const cid = s.catalogId || s.id;
    const c = catalog().find((x) => x.id === cid);
    const label = c ? c.label : cid;
    const eff = normalizeSlotEffort(cid, s.effort);
    const slotId = ALL_SLOT_IDS[idx] || s.slot || String.fromCharCode(65 + idx);
    return `Slot ${slotId}: ${label}${eff ? ` (${eff})` : ''}`;
  }).join(' · ');
}

function syncActivePresetState() {
  const curSig = lineupSignature(currentLineupSlots());
  const activeSaved = ACTIVE_SAVED_PRESET_ID ? getSavedPresetById(ACTIVE_SAVED_PRESET_ID) : null;
  if (activeSaved && lineupSignature(activeSaved.slots) === curSig) {
    // Keep current active saved preset
  } else {
    const matchedSaved = SAVED_PRESETS.find((p) => p && Array.isArray(p.slots) && lineupSignature(p.slots) === curSig);
    ACTIVE_SAVED_PRESET_ID = matchedSaved ? matchedSaved.id : null;
  }

  // Highlight built-in preset buttons if no saved preset is explicitly active and signature matches
  document.querySelectorAll('.mc-preset-btn').forEach((btn) => {
    const pName = btn.dataset.preset;
    const bSig = lineupSignature(builtinPresetSlots(pName));
    const isMatched = !ACTIVE_SAVED_PRESET_ID && Boolean(curSig && bSig && curSig === bSig);
    btn.classList.toggle('is-active', isMatched);
  });

  const delBtn = $('#deleteSavedPresetBtn');
  if (delBtn) {
    const activeItem = ACTIVE_SAVED_PRESET_ID ? getSavedPresetById(ACTIVE_SAVED_PRESET_ID) : null;
    delBtn.classList.toggle('hidden', !activeItem);
    if (activeItem) {
      delBtn.title = `Delete saved model preset "${activeItem.title}" from your library`;
    }
  }
}

function renderUserPresets() {
  syncActivePresetState();
  const wrap = $('#userPresetsList');
  if (!wrap) return;
  if (!Array.isArray(SAVED_PRESETS) || !SAVED_PRESETS.length) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = SAVED_PRESETS.map((p) => {
    if (!p || !p.id) return '';
    const isActive = ACTIVE_SAVED_PRESET_ID === p.id;
    const tip = describePresetTooltip(p);
    return (
      `<span class="mc-user-preset-chip${isActive ? ' is-active' : ''}" data-preset-id="${esc(p.id)}">` +
        `<button type="button" class="bar-btn mc-user-preset-btn${isActive ? ' is-active' : ''}" data-preset-id="${esc(p.id)}" title="${esc(p.title + (tip ? ' — ' + tip : ''))}">🔖 ${esc(p.title)}</button>` +
        `<button type="button" class="mc-user-preset-del" data-preset-id="${esc(p.id)}" title="Delete saved preset &quot;${esc(p.title)}&quot;" aria-label="Delete saved preset ${esc(p.title)}">&times;</button>` +
      `</span>`
    );
  }).join('');
  wrap.querySelectorAll('.mc-user-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => applySavedPreset(btn.dataset.presetId));
  });
  wrap.querySelectorAll('.mc-user-preset-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onDeleteSavedPresetClick(btn.dataset.presetId);
    });
  });
}

function applySavedPreset(presetId) {
  const preset = typeof presetId === 'object' ? presetId : getSavedPresetById(presetId);
  if (!preset || !Array.isArray(preset.slots) || !preset.slots.length) return;
  const valid = preset.slots
    .map((s) => ({
      id: s.catalogId || s.id,
      effort: normalizeSlotEffort(s.catalogId || s.id, s.effort) || null,
    }))
    .filter((t) => {
      const c = catalog().find((x) => x.id === t.id);
      return c && modelAvailability(c).ok;
    })
    .slice(0, MAX_SLOTS);
  if (!valid.length) {
    window.alert('None of the models in this preset are currently available.');
    return;
  }
  if (!confirmInterruptRun('A comparison is still running. Stop it and apply this preset?')) return;
  ACTIVE_SAVED_PRESET_ID = preset.id;
  SLOT_IDS = ALL_SLOT_IDS.slice(0, valid.length);
  ALL_SLOT_IDS.forEach((s, i) => {
    SLOT_ASSIGN[s] = valid[i] ? valid[i].id : null;
    SLOT_EFFORT[s] = valid[i] ? valid[i].effort : null;
  });
  afterSlotChange();
}

async function onSavePresetClick() {
  const slots = currentLineupSlots();
  if (!slots.length) {
    window.alert('Select at least one model slot before saving a preset.');
    return;
  }
  const existing = ACTIVE_SAVED_PRESET_ID ? getSavedPresetById(ACTIVE_SAVED_PRESET_ID) : null;
  const defaultTitle = existing
    ? existing.title
    : slots.map((s) => {
        const c = catalog().find((x) => x.id === s.catalogId);
        const base = c ? shortLabel(c.label) : s.catalogId;
        return s.effort ? `${base} (${s.effort})` : base;
      }).join(' vs ').slice(0, 60);
  const rawTitle = window.prompt('Name this model lineup preset for your personal library:', defaultTitle);
  if (rawTitle === null) return; // cancelled
  const title = rawTitle.trim() || defaultTitle || 'Saved Lineup';
  const sameNameExisting = SAVED_PRESETS.find((p) => p && p.title && p.title.toLowerCase() === title.toLowerCase());
  if (sameNameExisting && (!existing || sameNameExisting.id !== existing.id)) {
    if (!window.confirm(`Overwrite saved preset "${sameNameExisting.title}"?`)) return;
  }
  const updateId = sameNameExisting ? sameNameExisting.id : (existing ? existing.id : undefined);

  const saveBtn = $('#savePresetBtn');
  const origHtml = saveBtn ? saveBtn.innerHTML : '🔖 Save preset';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
  }
  try {
    const resp = await fetch('/api/me/presets', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: updateId,
        title,
        slots,
      }),
    });
    if (resp.status === 401) { window.location.replace('/login'); return; }
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || 'Failed to save model preset.');
    SAVED_PRESETS = Array.isArray(data.savedPresets) ? data.savedPresets : SAVED_PRESETS;
    if (CONFIG && CONFIG.me) CONFIG.me.savedPresets = SAVED_PRESETS;
    saveLocalLibraryBackup();
    ACTIVE_SAVED_PRESET_ID = (data.saved && data.saved.id) || updateId || null;
    renderUserPresets();
    if (saveBtn) {
      saveBtn.classList.add('is-saved');
      saveBtn.textContent = '✓ Preset saved';
      setTimeout(() => {
        saveBtn.classList.remove('is-saved');
        saveBtn.innerHTML = origHtml;
      }, 1600);
    }
  } catch (err) {
    window.alert('Could not save model preset: ' + err.message);
    if (saveBtn) saveBtn.innerHTML = origHtml;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function onDeleteSavedPresetClick(targetPresetId) {
  const idToDelete = (typeof targetPresetId === 'string' && targetPresetId) ? targetPresetId : ACTIVE_SAVED_PRESET_ID;
  const item = getSavedPresetById(idToDelete);
  if (!item) return;
  if (!window.confirm(`Delete saved model preset "${item.title}" from your library?`)) return;
  const delBtn = $('#deleteSavedPresetBtn');
  if (delBtn) delBtn.disabled = true;
  try {
    const resp = await fetch('/api/me/presets/' + encodeURIComponent(item.id), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (resp.status === 401) { window.location.replace('/login'); return; }
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || 'Could not delete saved preset.');
    SAVED_PRESETS = Array.isArray(data.savedPresets) ? data.savedPresets : SAVED_PRESETS.filter((p) => p.id !== item.id);
    if (CONFIG && CONFIG.me) CONFIG.me.savedPresets = SAVED_PRESETS;
    saveLocalLibraryBackup();
    if (ACTIVE_SAVED_PRESET_ID === item.id) ACTIVE_SAVED_PRESET_ID = null;
    renderUserPresets();
  } catch (err) {
    window.alert('Could not delete saved preset: ' + err.message);
  } finally {
    if (delBtn) delBtn.disabled = false;
  }
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
  saveUserPreferencesDebounced();
}

function updateRunButton() {
  const btn = $('#runBtn');
  if (!btn || _busy) return;
  const none = MODELS.length === 0;
  btn.disabled = none;
  btn.title = none ? 'Select at least one model slot to run a comparison.' : '';
}

function currentTask() {
  const id = ($('#taskSelect') && $('#taskSelect').value) || 'custom';
  if (isCustomTaskId(id)) {
    const saved = String(id).startsWith('saved:') ? getSavedPromptById(id) : null;
    const is3d = typeof ACTIVE_ARENA_MODE !== 'undefined' && ACTIVE_ARENA_MODE === '3d';
    return {
      id: 'custom',
      savedPromptId: saved ? saved.id : null,
      title: saved && saved.title ? saved.title : (is3d ? 'Custom 3D / CAD prompt' : 'Custom prompt'),
      prompt: '',
      testCount: 0,
      category: is3d ? 'cad3d' : 'general',
      language: is3d ? 'javascript' : null,
      executable: false,
      visualizer: is3d ? 'cad3d' : undefined,
    };
  }
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
  const pillEl = $('#composerTokenPill');
  if (!isCustomTaskSelected()) {
    if (meterEl) meterEl.classList.add('hidden');
    if (pillEl) pillEl.classList.add('hidden');
    return;
  }
  const promptText = ($('#customPrompt') && $('#customPrompt').value) || '';
  const promptTok = Math.ceil(promptText.length / 3.8) + (CUSTOM_ATTACHMENTS.length || promptText.trim() ? 60 : 0);
  const attTok = CUSTOM_ATTACHMENTS.reduce((sum, a) => sum + (a.estimatedTokens || 100), 0);
  const totalEstTok = promptTok + attTok;

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
  const anyOver = activeModels.some((m) => m.status === 'over');
  const anyWarn = activeModels.some((m) => m.status === 'warn');

  // Lightweight inline token pill inside the composer footer (never shifts layout)
  if (pillEl) {
    if (!CUSTOM_ATTACHMENTS.length && !promptText.trim()) {
      pillEl.classList.add('hidden');
    } else {
      pillEl.classList.remove('hidden');
      pillEl.classList.toggle('is-warn', anyWarn && !anyOver);
      pillEl.classList.toggle('is-over', anyOver);
      const statusBadge = anyOver ? ' · ⚠ auto-fit' : (anyWarn ? ` · ${Math.round(worstRatio * 100)}% ctx` : '');
      pillEl.textContent = `~${fmtTokensShort(totalEstTok)} est.${statusBadge}`;
    }
  }

  // Only show the detailed multi-model context bar when attachments are present or a model is near/over limit
  if (!meterEl) return;
  if (!CUSTOM_ATTACHMENTS.length && worstRatio < 0.5) {
    meterEl.classList.add('hidden');
    return;
  }
  meterEl.classList.remove('hidden');

  const barPct = Math.min(100, Math.max(2, Math.round(worstRatio * 100)));
  const barCls = worstRatio > 1 ? 'is-over' : (worstRatio > 0.68 ? 'is-warn' : '');

  const pillsHtml = activeModels.map((m) => {
    const ctxLabel = m.ctx >= 1000000 ? `${(m.ctx / 1000000).toFixed(0)}M` : `${Math.round(m.ctx / 1000)}K`;
    const pct = Math.round(m.ratio * 100);
    const icon = m.status === 'over' ? '⚠' : (m.status === 'warn' ? '◐' : '✓');
    const note = m.status === 'over' ? `${pct}% · auto head+tail fit` : `${pct}% of ${ctxLabel}`;
    return `<span class="cm-pill is-${m.status}" title="Slot ${esc(m.slot)}: ${esc(m.label)} (${ctxLabel} context window, ~${Math.round(m.safeInputLimit / 1000)}K safe input budget)">${icon} <b>${esc(m.label)}</b>: ${note}</span>`;
  }).join('');

  meterEl.innerHTML =
    `<div class="cm-top">` +
      `<span class="cm-title">📐 Context Budget</span>` +
      `<span class="cm-summary">Est. input: <b>~${fmtTokensShort(totalEstTok)}</b> (${fmtTokensShort(promptTok)} prompt + ${fmtTokensShort(attTok)} files)${anyOver ? ' · <b>Smart Head+Tail Fit Active</b>' : ''}</span>` +
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
    badgeEl.textContent = '';
    badgeEl.classList.add('hidden');
    badgeEl.classList.remove('has-files');
    if (clearBtn) clearBtn.classList.add('hidden');
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    renderContextMeter();
    return;
  }

  badgeEl.textContent = `${count} file${count > 1 ? 's' : ''} · ${formatBytes(totalBytes)} · ~${fmtTokensShort(totalTok)}`;
  badgeEl.classList.remove('hidden');
  badgeEl.classList.add('has-files');
  if (clearBtn) clearBtn.classList.remove('hidden');
  listEl.classList.remove('hidden');

  listEl.innerHTML = CUSTOM_ATTACHMENTS.map((a) => {
    const b = attachmentBadgeInfo(a.name, a.mimeType);
    const isImg = !a.blobMissing && Boolean(a.previewUrl || (a.data && /^image\//i.test(a.mimeType || '')));
    const imgSrc = a.previewUrl || (isImg && a.data ? `data:${a.mimeType || 'image/png'};base64,${a.data}` : '');
    const visual = imgSrc
      ? `<img class="ca-thumb" data-att-id="${esc(a.id)}" src="${esc(imgSrc)}" alt="${esc(a.name)}" />`
      : `<div class="ca-type-icon ${b.cls}">${esc(b.label)}</div>`;
    const metaParts = [formatBytes(a.size)];
    if (a.pageCount) metaParts.push(`${a.pageCount}p`);
    if (a.estimatedTokens) metaParts.push(`~${fmtTokensShort(a.estimatedTokens)}`);
    if (a.cached) metaParts.push('⚡ Cached');
    const optHtml = a.optBadge ? `<span class="ca-opt-badge" title="${esc(a.optBadge)}">✓ ${esc(a.optBadge)}</span>` : '';
    const warnHtml = a.warning ? `<span class="ca-warn-tag" title="${esc(a.warning)}">⚠ ${esc(a.warning)}</span>` : '';
    const zoomHtml = isImg ? `<span class="ca-zoom-hint">🔍 Enlarge</span>` : '';
    const itemTitle = isImg
      ? 'Click to preview image'
      : `${a.name} (${a.mimeType || 'file'} · ${metaParts.join(' · ')})`;
    return (
      `<div class="ca-item${isImg ? ' is-clickable' : ''}" data-att-id="${esc(a.id)}" title="${esc(itemTitle)}">` +
        visual +
        `<div class="ca-info">` +
          `<span class="ca-name">${esc(a.name)}</span>` +
          `<span class="ca-meta">${esc(metaParts.join(' · '))}</span>` +
          optHtml +
          warnHtml +
        `</div>` +
        zoomHtml +
        `<button type="button" class="ca-remove" data-att-id="${esc(a.id)}" title="Remove ${esc(a.name)}">✕</button>` +
      `</div>`
    );
  }).join('');
  // Graceful fallback if a vault thumbnail URL fails to load (e.g. expired blob): swap broken <img> for clean file badge
  listEl.querySelectorAll('img.ca-thumb').forEach((imgEl) => {
    imgEl.addEventListener('error', () => {
      const attId = imgEl.getAttribute('data-att-id');
      const att = CUSTOM_ATTACHMENTS.find((x) => String(x.id) === String(attId));
      if (att) {
        att.previewUrl = null;
        att.blobMissing = true;
        att.cached = false;
        if (!att.warning) att.warning = 'Original file binary expired — re-attach file to preview or re-run';
        renderAttachments();
      }
    }, { once: true });
  });
  renderContextMeter();
}

function openCustomAttachmentLightbox(attId) {
  const imgAtts = CUSTOM_ATTACHMENTS.filter((a) => a && !a.blobMissing && (a.previewUrl || (a.data && /^image\//i.test(a.mimeType || ''))));
  if (!imgAtts.length) return;
  const items = imgAtts.map((a, i) => {
    const cleanB64 = String(a.data || '').replace(/^data:[^;]+;base64,/, '');
    const url = (cleanB64 && /^image\//i.test(a.mimeType || ''))
      ? `data:${a.mimeType || 'image/png'};base64,${cleanB64}`
      : (a.previewUrl || `data:${a.mimeType || 'image/png'};base64,${cleanB64}`);
    return {
      id: a.id,
      badge: `Input Image #${i + 1} of ${imgAtts.length}`,
      title: a.name || `Attached Image #${i + 1}`,
      meta: `${formatBytes(a.size || 0)} · ${a.mimeType || 'image/png'}`,
      url,
      downloadName: a.name || `attachment-${i + 1}.png`,
      defaultPixelated: false,
    };
  });
  const startIdx = Math.max(0, items.findIndex((it) => String(it.id) === String(attId)));
  openImageLightbox(items, startIdx);
}

function currentAttachmentsPayload() {
  if (!isCustomTaskSelected() || !CUSTOM_ATTACHMENTS.length) return undefined;
  return CUSTOM_ATTACHMENTS.map((a) => {
    if (a.cached && (a.sha256 || a.vaultRef || a.sha1)) {
      return {
        sha256: a.sha256 || a.vaultRef || undefined,
        vaultRef: a.vaultRef || a.sha256 || undefined,
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
      const isCustom = isCustomTaskSelected();
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
      if (rm && rm.dataset.attId) {
        removeAttachment(rm.dataset.attId);
        return;
      }
      const item = e.target.closest('.ca-item.is-clickable');
      if (item && item.dataset.attId) {
        openCustomAttachmentLightbox(item.dataset.attId);
      }
    });
  }
  [dz, ta].forEach((target) => {
    if (!target) return;
    target.addEventListener('dragover', (e) => {
      if (!isCustomTaskSelected()) return;
      e.preventDefault();
      if (dz) dz.classList.add('drag-over');
    });
    target.addEventListener('dragleave', (e) => {
      if (dz && !dz.contains(e.relatedTarget)) dz.classList.remove('drag-over');
    });
    target.addEventListener('drop', (e) => {
      if (!isCustomTaskSelected()) return;
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
      if (!isCustomTaskSelected()) return;
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
  const catLabel = ({
    cad3d: '3D & CAD',
    industry: 'Industry Architecture',
    security: 'Cybersecurity & SecOps',
    engineering: 'Software, Systems & Games',
    strategy: 'Strategy, Ops & Governance',
    enterprise: 'Enterprise Cloud',
    retail: 'Retail & Commerce',
    semiconductor: 'Semiconductor & EDA',
    transport: 'Transport & Logistics',
    finance: 'Financial Services',
    healthcare: 'Healthcare & Life Sciences',
    coding: 'Software & Systems',
    games: 'WebAssembly Games',
    business: 'Strategy & Operations',
    general: 'General',
  })[catKey] || 'General';
  const bits = [catLabel];
  if (t.category === 'cad3d' && t.vertical) {
    const vLbl = CAD_VERTICAL_LABELS[t.vertical];
    if (vLbl) bits.push(vLbl);
  }
  if (t.category === 'cad3d' && t.subcategory) {
    bits.push(t.subcategory === 'simple' ? '🔩 Simple Part' : '⚙️ Complex Part');
  } else if (t.category !== 'cad3d' && t.subcategory && TEXT_SUBCATEGORY_LABELS[t.subcategory]) {
    bits.push(TEXT_SUBCATEGORY_LABELS[t.subcategory]);
  }
  if (t.language) bits.push(t.language);
  if (t.testCount) bits.push(`${t.testCount} hidden tests`);
  if (t.visualizer === 'cad3d') bits.push('3D WebGL CAD ▸');
  else if (t.executable) bits.push('runnable \u25b8');
  if (t.savedPromptId) bits.push('🔖 saved prompt');
  if (t.id === 'custom' && CUSTOM_ATTACHMENTS.length) {
    bits.push(`${CUSTOM_ATTACHMENTS.length} attachment${CUSTOM_ATTACHMENTS.length > 1 ? 's' : ''}`);
  }
  meta.textContent = bits.join(' \u00b7 ');
  meta.className = 'task-meta is-' + catKey;
}

function renderTaskPrompt() {
  const ta = $('#customPrompt');
  const tp = $('#taskPrompt');
  const attWrap = $('#customAttachmentsWrap');
  const t = currentTask();
  const isCustom = isCustomTaskSelected();

  if (isCustom) {
    if (tp) {
      tp.textContent = '';
      tp.classList.add('hidden');
    }
    if (ta) ta.classList.remove('hidden');
    if (attWrap) attWrap.classList.remove('hidden');
  } else {
    if (tp) {
      tp.textContent = t.prompt;
      tp.classList.remove('hidden');
    }
    if (ta) ta.classList.add('hidden');
    if (attWrap) attWrap.classList.add('hidden');
  }

  syncSavedPromptButtons();
  renderTaskMeta();
  renderContextMeter();
}

// Tiered models (e.g. Claude Haiku 5.5) bill a whole request at a higher rate once its
// prompt reaches a size: the tag shows the base rate with a small "*", the tiers in a tooltip.
function priceTierNote(c) {
  let tiers = c && Array.isArray(c.priceTiers) ? c.priceTiers : null;
  if (!tiers && c) { const cat = catalog().find((x) => x.id === (c.catalogId || c.id)); tiers = cat && cat.priceTiers; }
  if (!Array.isArray(tiers) || !tiers.length) return '';
  const k = (n) => (n >= 1000000 ? `${+(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
  return tiers.map((t) => `Prompts of ${k(+t.minPromptTokens)}+ tokens: $${(+t.input).toFixed(2)} / $${(+t.output).toFixed(2)}`).join('; ')
    + ' per 1M (input and output of that request)';
}
function priceTag(c) {
  const base = `$${(+c.price.input).toFixed(2)} / $${(+c.price.output).toFixed(2)}`;
  const note = priceTierNote(c);
  return note ? `<span class="price-tiered" title="${esc(note)}">${base}*</span>` : base;
}

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

function providerBadgeHtml(c) {
  if (!c) return '';
  if (c.provider === 'openai') {
    return '<span class="ext-badge" title="Direct OpenAI API">OPENAI API</span>';
  }
  if (c.external || c.provider === 'moonshot') {
    return '<span class="ext-badge" title="External API Key">EXT API</span>';
  }
  return '<span class="vtx-badge" title="Google Cloud Vertex AI">VERTEX AI</span>';
}

// Clean Read-Only Model Identity Header inside each Arena Output Card
// (Model selection happens in Step 2 above, keeping Arena output cards uncluttered)
function buildInlineCardCascader(m, isRestore) {
  const slot = m.slot;
  const cid = isRestore ? (m.catalogId || m.id || SLOT_ASSIGN[slot]) : (SLOT_ASSIGN[slot] || m.catalogId || m.id);
  const c = catalog().find((x) => x.id === cid) || m;
  const ctxVal = (m && m.context) || (c && c.context) || 128000;
  const ctxStr = ctxVal >= 1000000 ? `${(ctxVal / 1000000).toFixed(0)}M ctx` : `${Math.round(ctxVal / 1000)}K ctx`;
  return `<div class="col-id col-cascader" data-slot="${esc(slot)}">
    <div class="col-title-row">
      <span class="col-slot-pill" style="background:${slotColor(slot)}22;color:${slotColor(slot)};border-color:${slotColor(slot)}55">Slot ${esc(slot)}</span>
      <span class="col-title">${esc(m.label)}</span>
      ${providerBadgeHtml(m)}
    </div>
    <div class="col-sub-row">
      ${m.price ? `<span class="col-price">${priceTag(m)} / 1M</span>` : ''}
      <span class="col-ctx-tag">${esc(ctxStr)}</span>
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
// Each select remembers its last applied value so a change the user declines (while a
// comparison is streaming, see confirmInterruptRun) can be rolled back in place.
function bindCascadingSelects(root) {
  if (!root) return;
  const remember = (sel) => { sel.dataset.prev = sel.value; };
  const rollback = (sel) => { if (sel.dataset.prev != null) sel.value = sel.dataset.prev; };
  root.querySelectorAll('.slot-provider-select').forEach((sel) => {
    remember(sel);
    sel.addEventListener('change', () => {
      if (!confirmInterruptRun('A comparison is still running. Stop it and change this slot?')) { rollback(sel); return; }
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
    remember(sel);
    sel.addEventListener('change', () => {
      if (!confirmInterruptRun('A comparison is still running. Stop it and change this slot?')) { rollback(sel); return; }
      const slot = sel.dataset.slot;
      const newId = sel.value;
      assignToSlot(newId, slot);
    });
  });
  root.querySelectorAll('.slot-think-select').forEach((sel) => {
    remember(sel);
    sel.addEventListener('change', () => {
      if (!confirmInterruptRun('A comparison is still running. Stop it and change this slot?')) { rollback(sel); return; }
      const slot = sel.dataset.slot;
      const val = sel.value || '';
      if (val.startsWith('model:')) {
        const siblingId = val.slice('model:'.length);
        assignToSlot(siblingId, slot, null);
      } else if (val.startsWith('effort:')) {
        const eff = val.slice('effort:'.length);
        const cid = SLOT_ASSIGN[slot];
        const c = catalog().find((x) => x.id === cid);
        const defVal = c && c.thinkingOptions && c.thinkingOptions.defaultValue;
        SLOT_EFFORT[slot] = (eff && eff !== defVal) ? eff : null;
        afterSlotChange();
      }
    });
  });
}

let _toolbarBound = false;
function renderModelEditors() {
  // Bind Step 2 preset buttons & Add Model button once
  if (!_toolbarBound) {
    _toolbarBound = true;
    const addBtn = $('#addSlotBtn');
    if (addBtn) addBtn.addEventListener('click', addSlot);
    const savePresetBtn = $('#savePresetBtn');
    if (savePresetBtn) savePresetBtn.addEventListener('click', onSavePresetClick);
    const delPresetBtn = $('#deleteSavedPresetBtn');
    if (delPresetBtn) delPresetBtn.addEventListener('click', () => onDeleteSavedPresetClick());
    document.querySelectorAll('.mc-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
    });
  }
  renderUserPresets();
  const badge = $('#slotCountBadge');
  if (badge) badge.textContent = `${SLOT_IDS.length} of ${MAX_SLOTS} active`;
  const addBtn = $('#addSlotBtn');
  if (addBtn) {
    addBtn.disabled = SLOT_IDS.length >= MAX_SLOTS;
    addBtn.textContent = SLOT_IDS.length >= MAX_SLOTS ? `Max ${MAX_SLOTS} models` : '+ Add model';
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
    const curEffort = SLOT_EFFORT[slot] || '';
    const thinkOptions = buildThinkingDropdownOptions(c, curEffort);
    const thinkSelectHtml = `<select class="slot-think-select col-inline-select col-thk-sel" data-slot="${esc(slot)}" title="Thinking / reasoning mode" aria-label="Thinking mode for Slot ${esc(slot)}">${thinkOptions}</select>`;

    const card = el('div', 'slot-cfg-card');
    card.style.setProperty('--slot-accent', slotColor(slot));
    card.innerHTML = `
      <div class="scc-head">
        <span class="scc-slot-badge" style="background:${slotColor(slot)}22;color:${slotColor(slot)};border-color:${slotColor(slot)}55">Slot ${esc(slot)}</span>
        <span class="scc-ic">${modelIconSvg(c)}</span>
        <strong class="scc-name">${esc(c.label)}</strong>
        ${providerBadgeHtml(c)}
        <span class="scc-price">${priceTag(c)}/1M</span>
        ${SLOT_IDS.length > MIN_SLOTS ? `<button type="button" class="scc-remove" data-slot="${esc(slot)}" title="Remove Slot ${esc(slot)}">&times;</button>` : ''}
      </div>
      ${buildProviderModelCascadingControlsHtml({
        slot,
        currentItem: c,
        catalogItems: catalog(),
        extraControlsHtml: thinkSelectHtml,
        useSiblingGroups: true,
      })}
    `;
    grid.appendChild(card);
  });

  bindCascadingSelects(grid);
  grid.querySelectorAll('.scc-remove').forEach((btn) => {
    btn.addEventListener('click', () => clearSlot(btn.dataset.slot));
  });
}

// Canonical Provider ▸ Model cascading selector markup used as the default UX across all arenas
// (Text & Code Arena, 3D & CAD Arena, Image & GenMedia Arena, and future arenas).
function buildProviderModelCascadingControlsHtml({
  slot,
  currentItem,
  catalogItems,
  providerSelectClass = 'slot-provider-select col-inline-select col-prov-sel',
  modelSelectClass = 'slot-model-select col-inline-select col-mod-sel',
  extraControlsHtml = '',
  useSiblingGroups = false,
}) {
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  const curFamily = providerFamilyOf(currentItem);
  const familyOptions = PROVIDER_FAMILIES.map((pf) => {
    const runnableCount = items.filter((x) => providerFamilyOf(x) === pf.id && modelAvailability(x).ok).length;
    const totalCount = items.filter((x) => providerFamilyOf(x) === pf.id).length;
    if (!totalCount) return '';
    const shortFam = pf.label.replace(/\s*\(.*\)/, '');
    return `<option value="${esc(pf.id)}"${pf.id === curFamily ? ' selected' : ''}${!runnableCount ? ' disabled' : ''}>${esc(shortFam)}</option>`;
  }).join('');

  const modelsInFamily = items.filter((x) => providerFamilyOf(x) === curFamily);
  const seenSiblingGroups = new Set();
  const modelOptions = modelsInFamily.map((mc) => {
    const siblings = useSiblingGroups ? REASONING_SIBLING_PAIRS[mc.id] : null;
    if (siblings && siblings.length) {
      const primaryId = siblings[0].id;
      if (seenSiblingGroups.has(primaryId)) return '';
      seenSiblingGroups.add(primaryId);
      const isGroupActive = siblings.some((s) => s.id === currentItem.id);
      const optVal = isGroupActive ? currentItem.id : primaryId;
      const groupLabel = siblings[0].groupLabel || mc.label.replace(/\s*\((Reasoning|Standard|Thinking|Instruct)\)\s*$/i, '');
      const av = modelAvailability(mc);
      const suffix = !av.ok ? ' (No Key)' : '';
      return `<option value="${esc(optVal)}"${isGroupActive ? ' selected' : ''}${!av.ok ? ' disabled' : ''}>${esc(groupLabel)}${esc(suffix)}</option>`;
    }
    const av = modelAvailability(mc);
    const suffix = !av.ok ? ' (No Key)' : '';
    return `<option value="${esc(mc.id)}"${mc.id === currentItem.id ? ' selected' : ''}${!av.ok ? ' disabled' : ''}>${esc(mc.label)}${esc(suffix)}</option>`;
  }).join('');

  return `<div class="scc-inline-controls">
    <select class="${providerSelectClass}" data-slot="${esc(slot)}" title="Provider family" aria-label="Provider for Slot ${esc(slot)}">${familyOptions}</select>
    <span class="col-sel-sep">▸</span>
    <select class="${modelSelectClass}" data-slot="${esc(slot)}" title="Model for Slot ${esc(slot)}" aria-label="Model for Slot ${esc(slot)}">${modelOptions}</select>
    ${extraControlsHtml}
  </div>`;
}

// Track per-slot raw vs formatted view preference for non-executable prose tasks
const SLOT_VIEW_RAW = {};

function isProseTask(task) {
  const t = task || currentTask();
  if (t && (t.visualizer || t.category === 'cad3d' || t.language || t.gui)) return false;
  return !t.executable && (!t.testCount || t.testCount === 0);
}

// ---------- arena scaffolding ----------
function buildArena(models) {
  const arena = $('#arena');
  arena.innerHTML = '';
  const task = currentTask();
  const hasTests = (task.testCount || 0) > 0;
  const proseMode = isProseTask(task);
  ARENA_MODELS = (models || MODELS).slice();
  const isRestore = !!models;
  const cells = isRestore
    ? ARENA_MODELS.map((m) => ({ slot: m.slot, m }))
    : SLOT_IDS.map((slot) => ({ slot, m: ARENA_MODELS.find((x) => x.slot === slot) || null }));

  arena.style.setProperty('--slot-count', String(Math.max(1, cells.length)));

  cells.forEach(({ slot: cellSlot, m }) => {
    if (!m) return;
    const showRaw = !proseMode || !!SLOT_VIEW_RAW[m.slot];
    const col = el('div', 'col');
    col.dataset.slot = m.slot;
    col.id = `col-${m.slot}`;
    col.style.setProperty('--accent', slotColor(m.slot));
    col.innerHTML = `
      <div class="col-head">
        <span class="col-accent" style="background:${slotColor(m.slot)}"></span>
        <span class="col-ic">${modelIconSvg(m)}</span>
        ${buildInlineCardCascader(m, isRestore)}
        <div class="col-head-actions">
          <button class="rerun-btn" type="button" data-slot="${m.slot}" disabled
            title="Re-run just this model on the current task — the other columns are left alone">↻</button>
          ${(!isRestore && SLOT_IDS.length > MIN_SLOTS) ? `<button class="col-remove" type="button" data-slot="${m.slot}" title="Remove Slot ${m.slot}">&times;</button>` : ''}
        </div>
      </div>
      <div class="col-status" id="status-${m.slot}"><span>Idle — press Run.</span></div>
      <div class="col-ctx-warn hidden" id="ctx-warn-${m.slot}"></div>
      <div class="col-att-note hidden" id="att-note-${m.slot}"></div>
      <div class="progress${hasTests ? '' : ' hidden'}" id="prog-${m.slot}">
        <div class="progress-track"><div class="progress-fill" id="pf-${m.slot}"></div></div>
        <div class="progress-label"><span id="pl-${m.slot}">0 / ${task.testCount || 0} tests</span><span id="ph-${m.slot}"></span></div>
      </div>
      <details class="think" id="thinkbox-${m.slot}">
        <summary>Thinking / reasoning <span class="think-meta" id="think-meta-${m.slot}"></span><button class="md-magnify think-magnify" data-slot="${m.slot}" data-kind="think" type="button" title="Open full-page preview">${MAGNIFY_SVG}</button></summary>
        <pre class="think-pre"><code id="think-${m.slot}">—</code></pre>
      </details>
      <div class="code-wrap">
        <div class="code-toolbar">
          ${proseMode ? `<button class="md-toggle-btn" data-slot="${m.slot}" type="button" title="Toggle Formatted Markdown vs Raw Text">${showRaw ? 'Formatted' : 'Raw'}</button>` : ''}
          <button class="md-magnify" data-slot="${m.slot}" data-kind="code" type="button" title="Open full-page preview">${MAGNIFY_SVG}</button>
        </div>
        <div class="md-output${showRaw ? ' hidden' : ''}" id="md-${m.slot}"><span class="md-placeholder">Model response will appear here…</span></div>
        <pre class="${showRaw ? '' : 'hidden'}" id="pre-${m.slot}"><code id="code-${m.slot}">${proseMode ? '// response will appear here' : '// generated solution will appear here'}</code></pre>
      </div>
      ${(task.executable || !!task.visualizer) ? `
      <div class="exec">
        <button class="exec-btn" data-slot="${m.slot}" type="button" disabled title="Run the generated program (${esc(task.language || 'python')})">${task.visualizer === 'cad3d' ? '🧊 Render 3D CAD' : '▸ Run code'}</button>
        <div class="exec-viz hidden" id="exec-viz-${m.slot}"></div>
        <pre class="exec-out hidden" id="exec-out-${m.slot}"><code></code></pre>
      </div>` : ''}
      <div class="metrics" id="metrics-${m.slot}">
        <div class="metric" id="m-tok-${m.slot}"><div class="k">Output tokens</div><div class="v">0</div></div>
        <div class="metric" id="m-think-${m.slot}"><div class="k">Thinking</div><div class="v">0</div></div>
        <div class="metric" id="m-tps-${m.slot}"><div class="k">Tokens / sec</div><div class="v">0</div></div>
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
  arena.querySelectorAll('.md-toggle-btn').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const slot = b.dataset.slot;
      SLOT_VIEW_RAW[slot] = !SLOT_VIEW_RAW[slot];
      const showRaw = !!SLOT_VIEW_RAW[slot];
      b.textContent = showRaw ? 'Formatted' : 'Raw';
      const mdEl = $(`#md-${slot}`);
      const preEl = $(`#pre-${slot}`);
      if (mdEl) mdEl.classList.toggle('hidden', showRaw);
      if (preEl) preEl.classList.toggle('hidden', !showRaw);
    }));
  arena.querySelectorAll('details.think').forEach((d) => {
    d.addEventListener('toggle', () => {
      if (!d._autoToggling) d.dataset.userToggled = '1';
    });
  });

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
let _currentRunId = null;
let _lastRunId = null;

function judgeableEntries() {
  return (ARENA_MODELS || MODELS)
    .map((m) => {
      const r = LAST_RESULTS[m.slot] || {};
      const cadSt = (typeof CAD_SLOT_STATE !== 'undefined' && CAD_SLOT_STATE[m.slot]) || {};
      return {
        slot: m.slot,
        label: m.label,
        text: r.code || '',
        costUsd: typeof r.costUsd === 'number' && isFinite(r.costUsd) ? r.costUsd : null,
        wallMs: typeof r.wallMs === 'number' && isFinite(r.wallMs) ? r.wallMs : null,
        tokensPerSec: typeof r.tokensPerSec === 'number' && isFinite(r.tokensPerSec) ? r.tokensPerSec : null,
        completionTokens: typeof r.completionTokens === 'number' && isFinite(r.completionTokens) ? r.completionTokens : null,
        cadTelemetry: cadSt.telemetry || r.cadTelemetry || null,
        fourViewDataUrl: cadSt.fourViewDataUrl || r.fourViewDataUrl || null,
      };
    })
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
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = usable.map((c) =>
      `<option value="${esc(c.id)}">${esc(c.label)}${contestants.has(c.label) ? ' — also competing' : ''}</option>`).join('');
    if (prev && usable.some((c) => c.id === prev)) {
      sel.value = prev;
    } else {
      // Prefer a judge that is NOT one of the models being judged.
      const neutral = usable.find((c) => !contestants.has(c.label)) || usable[0];
      if (neutral) sel.value = neutral.id;
    }
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
      runId: _lastRunId || _currentRunId || undefined,
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
  if (!out || !r || !Array.isArray(r.results)) return;
  const criteria = Array.isArray(r.criteria) && r.criteria.length
    ? r.criteria
    : [
        { key: 'completeness', label: 'Completeness' },
        { key: 'accuracy', label: 'Accuracy' },
        { key: 'structure', label: 'Structure' },
        { key: 'actionability', label: 'Actionability' },
        { key: 'cost', label: 'Cost' },
        { key: 'speed', label: 'Speed' },
      ];
  const ranked = r.results.slice().sort((a, b) => (b.overall || 0) - (a.overall || 0));
  const best = ranked.length ? ranked[0].overall : 0;
  const rows = ranked.map((res) => {
    const scores = res.scores || {};
    const cells = criteria.map((c) => {
      const v = scores[c.key];
      const vn = Number(v);
      return `<td class="jr-score"><span class="jr-bar" style="width:${Number.isFinite(vn) ? Math.max(0, Math.min(100, vn * 10)) : 0}%"></span><b>${v == null ? '—' : esc(v)}</b></td>`;
    }).join('');
    const win = res.slot === r.winnerSlot;
    return `<tr class="${win ? 'jr-win' : ''}" style="--accent:${slotColor(res.slot)}">` +
      `<td class="jr-name"><span class="jr-dot"></span>${esc(res.label)}` +
      `${win ? '<span class="jr-badge">judge’s pick</span>' : ''}` +
      `<span class="jr-blind">seen as ${esc(res.blindId || '?')}</span></td>` +
      `<td class="jr-overall"><b>${res.overall == null ? '—' : esc(res.overall)}</b><i>/10</i></td>` +
      cells +
      `<td class="jr-note">${esc(res.note || '')}</td></tr>`;
  }).join('');
  const heads = criteria.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const sent = r.charsSent ? ` · ${fmtInt(r.charsSent)} chars sent in full` : '';
  const trim = r.truncated
    ? `<p class="jp-warn">⚠ The combined answers exceeded the transport budget, so the longest were shortened. The judge was told which ones and instructed not to penalise them for it — but scores here are less reliable than on a run that fits.</p>`
    : '';
  const judgeLabel = (r.judge && r.judge.label) || 'Judge';
  const judgeModel = (r.judge && r.judge.model) || '';
  const blindOrderText = Array.isArray(r.blindOrder) ? r.blindOrder.map((s) => String(s).split('=')[0]).join(' → ') : '';
  out.innerHTML =
    `<div class="jp-meta">Judged by <b>${esc(judgeLabel)}</b>${judgeModel ? ` · ${esc(judgeModel)}` : ''}${blindOrderText ? ` · blind order ${esc(blindOrderText)}` : ''}${sent}</div>` +
    trim +
    `<div class="table-wrap"><table class="judge-table"><thead><tr><th>Model</th><th>Overall</th>${heads}<th>Judge’s comment</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    (r.why ? `<p class="jp-why"><b>Why:</b> ${esc(r.why)}</p>` : '') +
    `<p class="jp-fine">Scores are one model’s opinion, not a measurement. ${best ? '' : ''}The judge saw the answers in a shuffled order with all model names removed.</p>`;
}

const renderJudgeVerdict = renderJudge;

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
function crashFromExec(r, task) {
  if (!r) return null;
  // Code execution disabled on the server (e.g. Cloud Run ENABLE_CODE_EXEC=0) is a platform setting, not a code crash.
  if (r.error && /code execution is disabled/i.test(r.error)) return null;
  // Visualizer tasks (e.g. Hanoi) that run in-browser are handled by the visualizer and not code crashes.
  if (task && task.visualizer === 'hanoi') return null;
  if (r.error) return { error: r.error, source: 'run' };
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

// The framed game page posts its own status/failures up to us. Match the reporting
// window back to a slot by comparing it with each column's iframe.
// SECURITY: the game frame is sandboxed without allow-same-origin, so its
// messages arrive with the string origin 'null'. We accept that opaque origin
// ONLY when e.source is one of our own .game-frame windows (same-origin messages
// from a legacy frame are still accepted); anything else is dropped.
window.addEventListener('message', (e) => {
  const d = e && e.data;
  if (!d || (d.__ullm !== 'game-error' && d.__ullm !== 'game-booted')) return;
  if (e.origin !== window.location.origin && e.origin !== 'null') return;
  const frames = document.querySelectorAll('.game-frame');
  for (const f of frames) {
    if (f.contentWindow === e.source) {
      const slot = (f.closest('.col') || {}).dataset && f.closest('.col').dataset.slot;
      if (!slot) return;
      if (d.__ullm === 'game-booted') {
        clearCrash(slot);
      } else if (d.__ullm === 'game-error') {
        noteCrash(slot, { error: String(d.message || 'Game crashed').slice(0, 4000), source: String(d.kind || 'runtime').slice(0, 40) });
      }
      return;
    }
  }
  // Not one of our game frames (e.g. a nested or forged window): ignore.
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
  if (task.visualizer === 'cad3d' || (typeof ACTIVE_ARENA_MODE !== 'undefined' && ACTIVE_ARENA_MODE === '3d')) {
    return runCad3dViewport(slot, code, btn, out, viz);
  }
  // GUI (Pygame) tasks render IN THE BROWSER via WebAssembly so they work for
  // remote users — build with pygbag and embed an iframe instead of launching a
  // native window on the server host.
  if (task.gui && CONFIG && CONFIG.webGame) { return runWebGame(slot, code, btn, out, viz); }
  const orig = btn ? btn.textContent : '▸ Run code';
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  if (viz) viz.classList.add('hidden');
  out.classList.remove('hidden');
  out.querySelector('code').textContent = 'Running…';

  const tryHanoiViz = (rawStdout, footText) => {
    if (task.visualizer === 'hanoi' && viz) {
      let moves = parseHanoiMoves(rawStdout || '');
      if (!moves.length && code && !code.includes('def ') && !code.includes('import ')) {
        const fromCode = parseHanoiMoves(code);
        if (fromCode.length >= 7) moves = fromCode;
      }
      if (!moves.length) {
        const nMatch = code.match(/hanoi\s*\(\s*(\d+)/i) || code.match(/n\s*=\s*(\d+)/i);
        const disks = nMatch ? Math.min(8, Math.max(3, parseInt(nMatch[1], 10))) : 8;
        moves = generateHanoiMoves(disks);
      }
      if (moves.length) {
        clearCrash(slot);
        out.classList.add('hidden');
        viz.classList.remove('hidden');
        renderHanoiViz(viz, moves, rawStdout || code, footText || '— solution visualized');
        return true;
      }
    }
    return false;
  };

  if (task.visualizer === 'hanoi' && !(CONFIG && CONFIG.codeExec)) {
    if (tryHanoiViz('', '— simulated in browser')) {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
      return;
    }
  }

  try {
    const resp = await fetch('/api/execute', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: task.language, code, taskId: task.id, title: label, posX, posY, index: idx, count, gap: 10 }),
    });
    if (resp.status === 401) { window.location.replace('/login'); return; }
    const r = await resp.json();

    // Visualizer tasks (e.g. Hanoi) handle moves and simulation directly in browser; never show false-positive crash
    if (task.visualizer === 'hanoi' && tryHanoiViz(r ? r.stdout : '', `— exit ${r && r.exitCode == null ? '?' : r.exitCode} · ${(r && r.durationMs) || 0}ms`)) {
      clearCrash(slot);
      return;
    }

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
      const parts = [];
      if (r.stdout) parts.push(r.stdout.replace(/\s+$/, ''));
      if (r.stderr) parts.push((parts.length ? '\n' : '') + '[stderr]\n' + r.stderr.replace(/\s+$/, ''));
      if (r.timedOut) parts.push('\n⏱ Hit the time limit — likely an interactive/graphical program (e.g. a Pygame game loop). Run it locally with a display to use it.');
      out.querySelector('code').textContent = (parts.join('\n').trim() || '(no output)') + '\n\n' + foot;
    }
  } catch (e) {
    if (task.visualizer === 'hanoi' && tryHanoiViz('', '— in-browser simulation')) {
      clearCrash(slot);
      return;
    }
    out.querySelector('code').textContent = 'Request failed: ' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

function renderHanoiInBrowser(slot, rawCode) {
  const out = $(`#exec-out-${slot}`);
  const viz = $(`#exec-viz-${slot}`);
  if (!viz) return false;
  const code = String(rawCode || ($(`#code-${slot}`) || {}).textContent || '');
  let moves = [];
  if (code && !code.includes('def ') && !code.includes('import ')) {
    const fromCode = parseHanoiMoves(code);
    if (fromCode.length >= 7) moves = fromCode;
  }
  if (!moves.length) {
    const nMatch = code.match(/hanoi\s*\(\s*(\d+)/i) || code.match(/n\s*=\s*(\d+)/i);
    const disks = nMatch ? Math.min(8, Math.max(3, parseInt(nMatch[1], 10))) : 8;
    moves = generateHanoiMoves(disks);
  }
  if (moves.length) {
    clearCrash(slot);
    if (out) out.classList.add('hidden');
    viz.classList.remove('hidden');
    renderHanoiViz(viz, moves, code, '— solution visualized');
    return true;
  }
  return false;
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
      const colEl = $(`#col-${slot}`);
      if (colEl) colEl.classList.add('game-code-collapsed');
      viz.classList.remove('hidden');
      // SECURITY: patchIndexHtml in src/webGame.js locks down window.localStorage
      // and window.parent inside the game document while allow-same-origin ensures
      // Google Corp UberProxy forwards cookies for subresource fetches (.apk / .tar.gz).
      const gameBust = (CONFIG && (CONFIG.assetVersion || CONFIG.version)) || Date.now();
      const gameUrl = r.url + (String(r.url).includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(gameBust);
      viz.innerHTML =
        '<div class="game-wrap"><iframe class="game-frame" src="' + esc(gameUrl) + '" title="' + esc(modelLabel(slot)) +
        '" sandbox="allow-scripts allow-same-origin allow-pointer-lock" allow="autoplay; fullscreen; gamepad"></iframe></div>' +
        '<div class="game-bar"><span>Running in your browser via WebAssembly' + (r.cached ? ' · cached build' : '') +
        '</span><div class="game-bar-actions">' +
        '<button type="button" class="game-code-toggle" data-slot="' + esc(slot) + '" title="Toggle Python source code view">&lt;/&gt; Show code</button>' +
        '<button type="button" class="game-fullscreen-btn" data-slot="' + esc(slot) + '" title="Play this game full screen (stays sandboxed)">⛶ Full screen</button>' +
        '</div></div>';
      const toggleBtn = viz.querySelector('.game-code-toggle');
      if (toggleBtn && colEl) {
        toggleBtn.addEventListener('click', () => {
          const collapsed = colEl.classList.toggle('game-code-collapsed');
          toggleBtn.innerHTML = collapsed ? '&lt;/&gt; Show code' : '&lt;/&gt; Hide code';
        });
      }
      // In-card fullscreen keeps the sandbox attribute in force; the old "open the
      // bundle top-level" link ran the generated code unsandboxed on the app origin.
      const fsBtn = viz.querySelector('.game-fullscreen-btn');
      const gameFrame = viz.querySelector('iframe.game-frame');
      if (fsBtn && gameFrame) {
        fsBtn.addEventListener('click', () => {
          const req = gameFrame.requestFullscreen || gameFrame.webkitRequestFullscreen;
          if (typeof req !== 'function') { fsBtn.disabled = true; fsBtn.title = 'Full screen is not supported by this browser'; return; }
          try {
            const p = req.call(gameFrame);
            if (p && typeof p.catch === 'function') p.catch(() => { /* user gesture or policy denied */ });
          } catch (_) { /* ignore */ }
        });
      }
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

// Parse "Move disk K from X to Y" lines out of a program's stdout or code.
function parseHanoiMoves(stdout) {
  const moves = [];
  (stdout || '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return;
    const m = /(?:move\s+)?disk\s+(\d+)(?:\s*:|\s+from)?\s+(?:peg\s+)?([A-Za-z0-9]+)\s+(?:to|->)\s+(?:peg\s+)?([A-Za-z0-9]+)/i.exec(trimmed);
    if (m) {
      moves.push({ disk: +m[1], from: m[2].trim(), to: m[3].trim() });
      return;
    }
    const m2 = /move\s+disk\s+(\d+)\s+from\s+([A-Za-z0-9]+)\s+to\s+([A-Za-z0-9]+)/i.exec(trimmed);
    if (m2) moves.push({ disk: +m2[1], from: m2[2].trim(), to: m2[3].trim() });
  });
  return moves;
}

function generateHanoiMoves(n = 8, source = 'A', target = 'C', aux = 'B') {
  const moves = [];
  function solve(k, s, t, a) {
    if (k <= 0) return;
    solve(k - 1, s, a, t);
    moves.push({ disk: k, from: s, to: t });
    solve(k - 1, a, t, s);
  }
  solve(n, source, target, aux);
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
  if (!node) return;
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
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 36;
  fn();
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

// Safe Markdown renderer (uses marked + DOMPurify when available, else escaped text)
function renderSafeMarkdown(mdNode, rawText) {
  if (!mdNode) return;
  const txt = String(rawText || '');
  if (!txt.trim()) {
    mdNode.innerHTML = '<span class="md-placeholder">Model response will appear here…</span>';
    return;
  }
  const parser = window.marked && (window.marked.parse || window.marked);
  if (typeof parser === 'function' && window.DOMPurify && window.DOMPurify.sanitize) {
    try {
      const html = window.DOMPurify.sanitize(parser(txt));
      mdNode.innerHTML = html;
      return;
    } catch (_) {}
  }
  mdNode.textContent = txt;
}

// Per-slot streaming accumulator & RAF batch state
const STREAM_STATE = {};
function resetStreamState(slot) {
  const prev = STREAM_STATE[slot];
  if (prev && prev.rafId) cancelAnimationFrame(prev.rafId);
  STREAM_STATE[slot] = {
    answer: '',
    reasoning: '',
    reasoningTokens: null,
    dirtyAnswer: false,
    dirtyThink: false,
    lastMdAt: 0,
    metrics: null,
    rafId: 0,
  };
}

function autoToggleThinkBox(slot, hasReasoning, hasAnswer) {
  const d = document.querySelector(`#thinkbox-${slot}`);
  if (!d || d.dataset.userToggled) return;
  if (hasAnswer && d.open) {
    d._autoToggling = true;
    d.open = false;
    setTimeout(() => { d._autoToggling = false; }, 0);
  } else if (hasReasoning && !hasAnswer && !d.open) {
    d._autoToggling = true;
    d.open = true;
    setTimeout(() => { d._autoToggling = false; }, 0);
  }
}

function setCode(slot, text, isFinal) {
  const node = $(`#code-${slot}`);
  if (node) stick(node.parentElement, () => { node.textContent = text; }); // parent <pre> is the scroller
  const mdNode = $(`#md-${slot}`);
  if (mdNode && isProseTask()) {
    const st = STREAM_STATE[slot];
    const now = performance.now();
    // Throttle full markdown re-parse during streaming to ~120ms, and always parse on final output
    if (isFinal || !st || (now - (st.lastMdAt || 0) >= 120)) {
      if (st) st.lastMdAt = now;
      stick(mdNode, () => renderSafeMarkdown(mdNode, text));
    }
  }
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
  const meta = document.querySelector(`#think-meta-${slot}`);
  if (meta) {
    meta.textContent = rtok != null ? `· ${fmtInt(rtok)} tok` : '';
  }
}

function flushSlotStream(slot, isFinal) {
  const st = STREAM_STATE[slot];
  if (!st) return;
  if (st.rafId) {
    cancelAnimationFrame(st.rafId);
    st.rafId = 0;
  }
  const hasReasoning = !!(st.reasoning && st.reasoning.trim()) || (st.reasoningTokens || 0) > 0;
  const hasAnswer = !!(st.answer && st.answer.trim());
  autoToggleThinkBox(slot, hasReasoning, hasAnswer);

  if (st.dirtyAnswer || isFinal) {
    st.dirtyAnswer = false;
    const t = currentTask();
    const displayAns = st.answer ? (t.language ? liveCodeView(st.answer) : st.answer) : (isFinal ? '' : '…');
    if (displayAns) setCode(slot, displayAns, !!isFinal);
  }
  if (st.dirtyThink || isFinal) {
    st.dirtyThink = false;
    setThink(slot, st.reasoning, st.reasoningTokens);
  }
  if (st.metrics) {
    const m = st.metrics;
    st.metrics = null;
    setTileVal(slot, 'tok', m.tok);
    setTileVal(slot, 'think', m.think);
    setTileVal(slot, 'tps', m.tps);
    if (m.cost != null) setTileVal(slot, 'cost', m.cost);
  }
}

function scheduleSlotFlush(slot) {
  const st = STREAM_STATE[slot];
  if (!st || st.rafId) return;
  st.rafId = requestAnimationFrame(() => {
    st.rafId = 0;
    flushSlotStream(slot, false);
  });
}

function setTileVal(slot, key, val) {
  const n = document.querySelector(`#m-${key}-${slot} .v`);
  if (!n) return;
  const strVal = String(val);
  if (n.textContent === strVal) return;
  n.textContent = strVal;
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
let FULL_RUN_ABORT = null;                // AbortController of the full comparison in flight (1.1)
function claimSlots(slots) {              // take ownership; returns the snapshot to validate against
  const snap = {};
  slots.forEach((s) => { SLOT_GEN[s] = (SLOT_GEN[s] || 0) + 1; snap[s] = SLOT_GEN[s]; });
  return snap;
}
const ownsSlot = (snap, slot) => snap && snap[slot] != null && snap[slot] === SLOT_GEN[slot];
const slotIsRunning = (slot) => !!SLOT_RUNS[slot] || (_fullRun && !wallFinished.has(slot));
const anyRunInFlight = () => _fullRun || Object.keys(SLOT_RUNS).length > 0;

// Called before any action that rebuilds the arena or changes what a running
// stream would be attributed to (task/category change, slot edits, presets,
// History restore, arena-mode switch). While a comparison or a single-slot
// re-run is streaming it asks for confirmation, then aborts every stream and
// bumps the slot generations so late events from the old owner are dropped.
// Returns false when the user chose to keep the current run (caller must bail).
function confirmInterruptRun(message) {
  if (!anyRunInFlight()) return true;
  if (!window.confirm(message || 'A comparison is still running. Stop it and continue?')) return false;
  stopAllRuns();
  return true;
}
function stopAllRuns() {
  try { if (FULL_RUN_ABORT) FULL_RUN_ABORT.abort(); } catch (_) { /* ignore */ }
  Object.keys(SLOT_RUNS).forEach((s) => {
    const r = SLOT_RUNS[s];
    if (!r) return;
    try { r.abort.abort(); } catch (_) { /* ignore */ }
    clearInterval(r.timer);
    delete SLOT_RUNS[s];
  });
  claimSlots(slotIds());
  if (wallTimer) { clearInterval(wallTimer); wallTimer = null; }
  _fullRun = false;
  _busy = false;
  updateRunButton();
  paintAllRerunButtons();
}

// POST /api/run and pump the NDJSON stream into `results`.
// Returns 'ok' | 'auth' | 'quota'; throws on transport/HTTP failure.
// `ctx` carries per-run context (the task that was current when the run
// started) so event handlers never re-read mutable UI state mid-stream.
async function streamRun(payload, results, signal, own, retried, ctx) {
  const resp = await fetch('/api/run', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (resp.status === 401) { saveComposerDraft(); window.location.replace('/login'); return 'auth'; } // session expired mid-use
  if (resp.status === 403) {
    const j = await resp.json().catch(() => ({}));
    if (j && j.code === 'PASSWORD_CHANGE_REQUIRED') {
      openChangePwModal({ forced: true });
      throw new Error((j && j.error) || 'Password change required before running comparisons.');
    }
  }
  if (resp.status === 409) {                                                     // cached attachment expired server-side
    const j = await resp.json().catch(() => ({}));
    if (j && j.code === 'ATTACHMENT_EXPIRED' && !retried && markAttachmentsExpired(j)) {
      // Re-upload the full files once and retry (no quota was consumed by the 409).
      return streamRun({ ...payload, attachments: currentAttachmentsPayload() }, results, signal, own, true, ctx);
    }
    throw new Error((j && j.error) || 'An attachment expired from the server cache — please re-attach it.');
  }
  if (resp.status === 429) {                                                     // a daily per-user budget on the global keys is used up, or the server is busy
    const j = await resp.json().catch(() => ({}));
    if (j && j.quotas) myQuotas = j.quotas;
    if (j && j.quota && j.provider === 'openai') myQuota = j.quota;
    if (j && j.vertexQuota) myVertexQuota = j.vertexQuota;
    updateQuotaBadge();
    window._lastQuotaObj = j || {};
    // Concurrency cap (no quota payload): a transient "try again in a moment", not a
    // budget problem. Painted per slot by the caller; never alerts or offers Vertex.
    window._lastQuotaBusy = !!(j && !j.quotas && !j.quota && !j.vertexQuota && /concurrent/i.test(String(j.error || '')));
    window._lastQuotaMsg = (j && j.error) || (window._lastQuotaBusy ? 'The server is busy, wait for the current run to finish.' : 'Daily run limit reached.');
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
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (parseErr) {
          // A corrupt frame means the stream is no longer trustworthy: stop reading
          // instead of leaving the columns spinning forever on an uncaught throw.
          try { await reader.cancel(); } catch (_) { /* ignore */ }
          throw new Error('The run stream returned a malformed event; the connection was dropped.');
        }
        if (!ev || typeof ev !== 'object') continue;
        // Drop events for a slot this stream no longer owns (someone hit Run
        // again on that column) — otherwise a stale run would clobber the new one.
        if (!ev.slot || ownsSlot(own, ev.slot)) handleEvent(ev, results, own, ctx);
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
  b.textContent = running ? '↻' : '↻';
  b.classList.toggle('running', running);
  b.title = running
    ? 'Abandon this model’s current attempt and restart it — other columns keep going'
    : 'Re-run just this model on the current task — the other columns are left alone';
}
function paintAllRerunButtons() { (ARENA_MODELS || MODELS).forEach((m) => paintRerunButton(m.slot)); }

async function run() {
  if (!MODELS.length) return;   // nothing selected — the button is disabled anyway
  if (_fullRun) return;         // not re-entrant: a second click / timer while streaming is ignored (1.4)
  const btn = $('#runBtn');
  btn.disabled = true;
  btn.textContent = 'Running…';
  _busy = true; _fullRun = true;   // set synchronously, before the first await
  const ac = new AbortController();   // lets confirmInterruptRun() cancel the whole comparison (1.1)
  FULL_RUN_ABORT = ac;
  let rerunWithVertex = false;
  // A new comparison gets a fresh repair allowance per slot.
  Object.keys(AUTOFIXED).forEach((k) => delete AUTOFIXED[k]);
  _judgeScored = null;
  _currentRunId = null;
  { const jo = $('#judgeOut'); if (jo) jo.innerHTML = ''; }
  Object.keys(CRASH).forEach((k) => clearCrash(k));
  $('#scorecard').classList.add('hidden');
  const jumpBtn = $('#jumpScorecardBtn');
  if (jumpBtn) jumpBtn.classList.add('hidden');
  { const pdfTopBtn = $('#exportPdfTopBtn'); if (pdfTopBtn) pdfTopBtn.classList.add('hidden'); }

  buildArena();
  const slots = slotIds();
  slots.forEach((s) => {
    resetStreamState(s);
    setStatus(s, 'Queued…', 'run');
  });
  // Taking over every column cancels any single-slot re-run still in flight.
  slots.forEach((s) => { const r = SLOT_RUNS[s]; if (r) { r.abort.abort(); clearInterval(r.timer); delete SLOT_RUNS[s]; } });
  const own = claimSlots(slots);
  paintAllRerunButtons();

  // Only scroll #arena into view if it is currently scrolled off-screen
  const arenaEl = $('#arena');
  if (arenaEl) {
    const rect = arenaEl.getBoundingClientRect();
    if (rect.top > window.innerHeight * 0.7 || rect.top < -80) {
      arenaEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

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

  // Captured once: the `done` handler decides auto-execution against the task
  // this run was started for, not whatever Step 1 shows when the event lands.
  const curTask = currentTask();
  const taskAtStart = curTask;

  const payload = {
    taskId: $('#taskSelect').value,
    taskTitle: curTask && curTask.title ? curTask.title : undefined,
    arenaMode: typeof ACTIVE_ARENA_MODE !== 'undefined' ? ACTIVE_ARENA_MODE : 'text',
    maxIterations: 1, // single-shot: correctness = the model's first-attempt pass rate (no self-debug retries)
    models: MODELS,
    customPrompt: $('#customPrompt').value,
    attachments: currentAttachmentsPayload(),
    keys: loadKeys(), // bring-your-own keys (empty {} ⇒ shared keys, subject to the daily limit)
  };

  if (typeof resetAllCadSlotStates === 'function') resetAllCadSlotStates();

  saveUserPreferencesImmediate();

  LAST_RESULTS = {};
  const results = LAST_RESULTS;
  try {
    const st = await streamRun(payload, results, ac.signal, own, false, { task: taskAtStart, arenaMode: payload.arenaMode });
    if (st === 'auth') return;
    if (st === 'quota') {
      const m = window._lastQuotaMsg;
      slots.forEach((s) => { if (ownsSlot(own, s)) setStatus(s, esc(m), 'err'); });
      if (window._lastQuotaBusy) return; // concurrency cap: per-slot message only, no alert loop
      if (window._lastQuotaObj && (window._lastQuotaObj.externalQuotaExhausted || window._lastQuotaObj.openaiQuotaExhausted)) {
        const switchToVertex = window.confirm(
          `${m}\n\nReplace the OpenAI / external slot(s) with Vertex AI models (Claude Opus 5.5 / Gemini 3.8 Flash) and run this comparison now? It will count against your Vertex AI budget instead.`
        );
        if (switchToVertex) {
          const vertexFallbacks = ['claude-opus-5-5', 'gemini-3.8-flash', 'claude-sonnet-5-5', 'gemini-3.1-pro', 'claude-haiku-4-5'];
          const k = loadKeys();
          const usedIds = new Set(SLOT_IDS.map((s) => SLOT_ASSIGN[s]).filter(Boolean));
          MODELS.forEach((mod) => {
            if (!mod.external || keySourceFor(mod, k).state === 'own') return;
            const repId = vertexFallbacks.find((id) => !usedIds.has(id)) || 'claude-opus-5-5';
            usedIds.add(repId);
            SLOT_ASSIGN[mod.slot] = repId;
            SLOT_EFFORT[mod.slot] = null;
          });
          syncModelsFromSlots();
          renderModelEditors();
          buildArena();
          updateQuotaBadge();
          // Re-armed from `finally` once this run's state is fully reset (no timer
          // racing the re-enabled button, no double run / double charge window).
          rerunWithVertex = true;
          return;
        }
      } else {
        window.alert(m);
      }
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // Interrupted by the user via confirmInterruptRun(); the new owner paints the UI.
    } else {
      slots.forEach((s) => { if (!results[s] && ownsSlot(own, s)) setStatus(s, 'Error: ' + esc(e.message), 'err'); });
    }
  } finally {
    if (wallTimer) { clearInterval(wallTimer); wallTimer = null; }
    btn.innerHTML = 'Run comparison ▸ <kbd class="run-kbd">⌘↵</kbd>';
    if (FULL_RUN_ABORT === ac) FULL_RUN_ABORT = null;
    _fullRun = false;
    _busy = Object.keys(SLOT_RUNS).length > 0;   // re-runs may still be going
    updateRunButton();          // stays disabled if every slot was cleared meanwhile
    paintAllRerunButtons();
    if (rerunWithVertex) run(); // state is reset above; run() disables the button synchronously
  }
}

// Re-run ONE model on the current task, leaving the other columns untouched.
// The fresh result is merged into LAST_RESULTS and the scorecard is rebuilt from
// the merged set, so you can retry a slow/failed model without redoing the rest.
async function rerunSlot(slot, repair) {
  const model = (ARENA_MODELS || MODELS).find((m) => m.slot === slot);
  if (!model) return;
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
  resetStreamState(slot);
  clearCrash(slot);
  { const colEl = $(`#col-${slot}`); if (colEl) colEl.classList.remove('game-code-collapsed'); }
  { const vizEl = $(`#exec-viz-${slot}`); if (vizEl) { vizEl.classList.add('hidden'); vizEl.innerHTML = ''; } }
  { const outEl = $(`#exec-out-${slot}`); if (outEl) outEl.classList.add('hidden'); }
  delete LAST_RESULTS[slot];
  wallFinished.delete(slot);
  ['tok', 'think', 'tps', 'cost'].forEach((k) => setTileVal(slot, k, 0));
  setTileVal(slot, 'time', '0.0s');
  const proseMode = isProseTask();
  { const c = $(`#code-${slot}`); if (c) c.textContent = proseMode ? '// response will appear here' : '// generated solution will appear here'; }
  { const md = $(`#md-${slot}`); if (md) md.innerHTML = '<span class="md-placeholder">Model response will appear here…</span>'; }
  { const tb = document.querySelector(`#thinkbox-${slot}`); if (tb) { delete tb.dataset.userToggled; tb.open = false; } }
  setThink(slot, '', null);
  { const pf = $(`#pf-${slot}`); if (pf) pf.style.width = '0%'; }
  { const pl = $(`#pl-${slot}`); if (pl) pl.textContent = `0 / ${currentTask().testCount || 0} tests`; }
  { const eb = document.querySelector(`.exec-btn[data-slot="${slot}"]`); if (eb) eb.disabled = true; }
  setStatus(slot, 'Queued…', 'run');

  try {
    const curTask = currentTask();
    const arenaModeNow = typeof ACTIVE_ARENA_MODE !== 'undefined' ? ACTIVE_ARENA_MODE : 'text';
    const st = await streamRun({
      taskId: $('#taskSelect').value,
      taskTitle: curTask && curTask.title ? curTask.title : undefined,
      arenaMode: arenaModeNow,
      maxIterations: 1,
      models: [model],
      mode: 'single',            // draws on the separate single-model re-run budget
      repair: repair || undefined,   // crash-repair round: same model, its code + the failure
      customPrompt: $('#customPrompt').value,
      attachments: currentAttachmentsPayload(),
      keys: loadKeys(),
    }, LAST_RESULTS, ac.signal, own, false, { task: curTask, arenaMode: arenaModeNow });
    if (st === 'auth') return;
    if (st === 'quota' && ownsSlot(own, slot)) { setStatus(slot, esc(window._lastQuotaMsg), 'err'); if (!window._lastQuotaBusy) window.alert(window._lastQuotaMsg); return; }
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

function handleEvent(ev, results, own, ctx) {
  switch (ev.type) {
    case 'start':
    case 'ping':
      break;
    case 'quota': // server's authoritative daily-runs counts for this run
      if (ev.quotas) myQuotas = ev.quotas;
      if (ev.quota && ev.quota.limited) myQuota = ev.quota;
      if (ev.vertexQuota) myVertexQuota = ev.vertexQuota;
      updateQuotaBadge();
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
      let phaseText;
      if (ev.phase === 'retrying') {
        phaseText = esc(ev.message || 'Transient rate-limit — retrying…');
      } else if (ev.phase === 'thinking') {
        phaseText = 'Generating response…';
      } else {
        phaseText = 'Running hidden tests…';
      }
      setStatus(ev.slot, phaseText, 'run');
      break;
    }
    case 'delta': {
      // Incremental O(1) delta accumulation + requestAnimationFrame DOM batching
      if (!STREAM_STATE[ev.slot]) resetStreamState(ev.slot);
      const st = STREAM_STATE[ev.slot];
      if (ev.answerReset) st.answer = '';
      if (ev.answerDelta != null) {
        st.answer += ev.answerDelta;
        st.dirtyAnswer = true;
      } else if (ev.answer != null) {
        st.answer = ev.answer;
        st.dirtyAnswer = true;
      }
      if (ev.reasoningReset) st.reasoning = '';
      if (ev.reasoningDelta != null) {
        st.reasoning += ev.reasoningDelta;
        st.dirtyThink = true;
      } else if (ev.reasoning !== undefined) {
        st.reasoning = ev.reasoning || '';
        st.dirtyThink = true;
      }
      if (ev.reasoningTokens !== undefined) {
        st.reasoningTokens = ev.reasoningTokens;
        st.dirtyThink = true;
      }
      const secs = (ev.wallMs || 0) / 1000;
      const think = ev.reasoningTokens || 0;
      const rolling = ev.currentTokensPerSec != null ? ev.currentTokensPerSec : (secs ? Math.round((ev.estOutTokens || 0) / secs) : 0);
      st.metrics = {
        tok: fmtInt(Math.max(0, (ev.estOutTokens || 0) - think)),
        think: fmtInt(think),
        tps: rolling,
        cost: ev.costUsd != null ? fmtCost(ev.costUsd) : null,
      };
      scheduleSlotFlush(ev.slot);
      setStatus(ev.slot, 'Streaming\u2026', 'run');
      break;
    }
    case 'metrics': {
      flushSlotStream(ev.slot, true);
      if (ev.reasoning !== undefined) setThink(ev.slot, ev.reasoning, ev.roundReasoningTokens);
      const think = ev.reasoningTokens || 0;
      setTileVal(ev.slot, 'tok', fmtInt(Math.max(0, ev.completionTokens - think))); // answer only
      setTileVal(ev.slot, 'think', fmtInt(think));
      setTileVal(ev.slot, 'tps', ev.tokensPerSec);
      setTileVal(ev.slot, 'cost', fmtCost(ev.costUsd));
      break;
    }
    case 'iteration': {
      flushSlotStream(ev.slot, true);
      if (ev.total === 0) {
        const pf = $(`#pf-${ev.slot}`);
        const pl = $(`#pl-${ev.slot}`);
        const ph = $(`#ph-${ev.slot}`);
        if (pf) pf.style.width = '100%';
        if (pl) pl.textContent = 'generated · no automated tests';
        if (ph) ph.textContent = '';
      } else {
        const pct = ev.total ? Math.round((ev.passed / ev.total) * 100) : 0;
        const pf = $(`#pf-${ev.slot}`);
        const pl = $(`#pl-${ev.slot}`);
        if (pf) pf.style.width = pct + '%';
        if (pl) pl.textContent = `${ev.passed} / ${ev.total} tests`;
      }
      if (ev.code) setCode(ev.slot, ev.code, true);
      if (ev.reasoning !== undefined) setThink(ev.slot, ev.reasoning, ev.reasoningTokens != null ? ev.reasoningTokens : null);
      break;
    }
    case 'done':
      flushSlotStream(ev.slot, true);
      results[ev.slot] = ev.result;
      wallFinished.add(ev.slot); // freeze wall time to the server's measured value
      {
        const think = ev.result.reasoningTokens || 0;
        setTileVal(ev.slot, 'tok', fmtInt(Math.max(0, ev.result.completionTokens - think))); // answer only
        setTileVal(ev.slot, 'think', fmtInt(think));
        // finalize the thinking panel with the authoritative total (text + count)
        setThink(ev.slot, ev.result.reasoning, ev.result.reasoningTokens);
        if (ev.result.code != null) setCode(ev.slot, ev.result.code, true);
        autoToggleThinkBox(ev.slot, !!(ev.result.reasoning || think > 0), !!(ev.result.code && ev.result.code.trim()));
      }
      setTileVal(ev.slot, 'tps', ev.result.tokensPerSec);
      setTileVal(ev.slot, 'cost', fmtCost(ev.result.costUsd));
      setTileVal(ev.slot, 'time', (ev.result.wallMs / 1000).toFixed(1) + 's');
      paintRerunButton(ev.slot);
      {
        // Auto-execution is decided against the task this run was STARTED for. If
        // Step 1 has moved on since (and the user kept the stream), the code is only
        // offered via the Run button, never auto-sent to /api/execute or the CAD
        // viewport as the newly selected task.
        const runTask = (ctx && ctx.task) || currentTask();
        const nowTask = currentTask();
        const sameTask = !!(runTask && nowTask && runTask.id === nowTask.id
          && (runTask.visualizer || null) === (nowTask.visualizer || null));
        const runIsCad = (ctx && ctx.arenaMode === '3d') || isCadActiveTask(runTask);
        if (runIsCad && ev.result.code) {
          const eb = document.querySelector(`.exec-btn[data-slot="${ev.slot}"]`);
          if (eb) eb.disabled = false;
          const auto = $('#autoRun');
          if (sameTask && isCadActiveTask() && (!auto || auto.classList.contains('is-on'))) {
            execSlotCode(ev.slot);
          }
        } else if ((runTask.executable || runTask.visualizer === 'hanoi') && ev.result.code) {
          const eb = document.querySelector(`.exec-btn[data-slot="${ev.slot}"]`);
          if (eb) eb.disabled = false;
          const auto = $('#autoRun');
          if (sameTask && auto && auto.classList.contains('is-on')) execSlotCode(ev.slot); // auto-launch on finish (default on)
        }
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
      flushSlotStream(ev.slot, true);
      results[ev.slot] = { slot: ev.slot, label: ev.label, error: ev.message };
      wallFinished.add(ev.slot);
      setStatus(ev.slot, 'Error: ' + esc(ev.message), 'err');
      break;
    case 'all_done':
      _lastRunId = (ev && ev.runId) || null;
      _currentRunId = _lastRunId;
      finalize(results);   // re-runs merge into LAST_RESULTS, so the scorecard reflects every slot
      // Show the non-intrusive "🏆 View Scorecard ▾" pill in the composer footer instead of yanking the user's scroll position
      {
        const sc = $('#scorecard');
        const jumpBtn = $('#jumpScorecardBtn');
        const pdfTopBtn = $('#exportPdfTopBtn');
        if (sc && !sc.classList.contains('hidden')) {
          if (jumpBtn) jumpBtn.classList.remove('hidden');
          if (pdfTopBtn) pdfTopBtn.classList.remove('hidden');
        }
      }
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
  { const pdfTopBtn = $('#exportPdfTopBtn'); if (pdfTopBtn) pdfTopBtn.classList.remove('hidden'); }

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
  const jp = $('#judgePanel');
  const scActions = $('#scorecardActions');
  if (scActions) {
    if (jp && !jp.classList.contains('hidden')) {
      scActions.classList.add('hidden');
    } else {
      scActions.classList.remove('hidden');
    }
  }
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
  if (!isCustom) metrics.push({ label: 'Correctness', icon: 'correct', dir: 'higher', hint: '↑ higher is better', min: 0, max: 100, get: (r) => (r.correctness == null ? 0 : r.correctness), fmt: (v) => Math.round(v) + '%' });
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
  const max = m.max != null ? m.max : Math.max(...vals.map((x) => x.v), 1e-9);
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
  const hasFixedBounds = m.min != null && m.max != null;
  const min = hasFixedBounds ? m.min : Math.min(...nums);
  const max = hasFixedBounds ? m.max : Math.max(...nums);
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
    let pct;
    if (hasFixedBounds) {
      pct = Math.max(0, Math.min(100, ((v - min) / span) * 100));
    } else if (max === min) {
      pct = m.dir === 'higher' ? 100 : (m.dir === 'lower' ? 0 : 50);
    } else {
      pct = Math.max(0, Math.min(100, ((v - min) / span) * 100));
    }
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
    toggle.querySelectorAll('.mv-btn').forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  wrap.innerHTML = metricList(isCustom).map((m) => {
    const vals = scored.map((r) => ({ r, v: m.get(r) }));
    // Neutral metrics have no good/bad end — a scale would imply one. Always bars.
    const body = (view === 'scale' && m.dir !== 'neutral') ? mpScale(m, vals) : mpBars(m, vals, scored.length);
    return `<div class="metric-panel" data-n="${scored.length}">${mpHead(m)}${body}</div>`;
  }).join('');
}

// (The legacy winner-hero / model-card / radar / bar renderers that targeted
// #winnerHero, #modelCards, #radar and #barWrap were removed: those elements no
// longer exist and renderScorecard() never called them - 6.11.)

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
let historyStarredOnly = false;   // toggle to show only ★ starred (kept forever) runs
let historyPage = 0;
let usersSortKey = 'lastAt';      // 'user' | 'runs' | 'runsToday' | 'savedPrompts' | 'savedPresets' | 'costUsd' | 'lastAt'
let usersSortDir = 'desc';        // 'asc' | 'desc'
let runsSortKey = 'at';           // 'at' | 'starred' | 'title' | 'user' | 'cost' | 'correctness' | 'resolution'
let runsSortDir = 'desc';         // 'asc' | 'desc'
const HIST_PAGE_SIZE = 6;           // rows rendered at once — keeps the DOM small however big history grows
let _histState = { body: null, runs: [], usage: null, isAdmin: false };
function fmtWhen(ms) { try { return new Date(ms).toLocaleString(); } catch (e) { return ''; } }

function runTotalCost(r) {
  const list = (r && Array.isArray(r.summary) && r.summary.length)
    ? r.summary
    : ((r && Array.isArray(r.results)) ? r.results : []);
  return list.reduce((sum, s) => sum + (Number(s && (s.costUsd != null ? s.costUsd : s.standardPayGoCostUsd)) || 0), 0);
}

function runBestScore(r) {
  const vals = ((r && r.summary) || [])
    .filter((s) => s && !s.error && s.total)
    .map((s) => Number(s.correctness) || 0);
  return vals.length ? Math.max(...vals) : -1;
}

function runImageResolutionRank(r) {
  const sz = String((r && r.imageSize) || '').toUpperCase();
  if (sz === '4K') return 4;
  if (sz === '2K') return 2;
  if (sz === '1K') return 1;
  return 0;
}

function sortHistoryRuns(list) {
  const arr = (list || []).slice();
  const dir = runsSortDir === 'asc' ? 1 : -1;
  arr.sort((a, b) => {
    let cmp = 0;
    if (runsSortKey === 'starred') {
      cmp = (a && a.starred ? 1 : 0) - (b && b.starred ? 1 : 0);
    } else if (runsSortKey === 'title') {
      const ta = String((a && (a.title || a.scenarioTitle || a.prompt)) || '');
      const tb = String((b && (b.title || b.scenarioTitle || b.prompt)) || '');
      cmp = ta.localeCompare(tb, undefined, { sensitivity: 'base' });
    } else if (runsSortKey === 'user') {
      cmp = String((a && (a.userName || a.user)) || '').localeCompare(String((b && (b.userName || b.user)) || ''), undefined, { sensitivity: 'base' });
    } else if (runsSortKey === 'cost') {
      cmp = runTotalCost(a) - runTotalCost(b);
    } else if (runsSortKey === 'correctness') {
      cmp = runBestScore(a) - runBestScore(b);
    } else if (runsSortKey === 'resolution') {
      cmp = runImageResolutionRank(a) - runImageResolutionRank(b);
    } else {
      cmp = (Number(a && a.at) || 0) - (Number(b && b.at) || 0);
    }
    if (cmp !== 0) return cmp * dir;
    return ((Number(b && b.at) || 0) - (Number(a && a.at) || 0));
  });
  return arr;
}

function sortUsageUsers(list) {
  const arr = (list || []).slice();
  const dir = usersSortDir === 'asc' ? 1 : -1;
  arr.sort((a, b) => {
    let cmp = 0;
    if (usersSortKey === 'user') {
      cmp = String((a && (a.userName || a.user)) || '').localeCompare(String((b && (b.userName || b.user)) || ''), undefined, { sensitivity: 'base' });
    } else if (usersSortKey === 'runs') {
      cmp = (Number(a && a.runs) || 0) - (Number(b && b.runs) || 0);
    } else if (usersSortKey === 'runsToday') {
      cmp = (Number(a && a.runsToday) || 0) - (Number(b && b.runsToday) || 0);
    } else if (usersSortKey === 'starredRuns') {
      cmp = (Number(a && a.starredRuns) || 0) - (Number(b && b.starredRuns) || 0);
    } else if (usersSortKey === 'imagesGenerated') {
      cmp = (Number(a && a.imagesGenerated) || 0) - (Number(b && b.imagesGenerated) || 0);
    } else if (usersSortKey === 'savedPrompts') {
      cmp = (Number(a && a.savedPrompts) || 0) - (Number(b && b.savedPrompts) || 0);
    } else if (usersSortKey === 'savedPresets') {
      cmp = (Number(a && a.savedPresets) || 0) - (Number(b && b.savedPresets) || 0);
    } else if (usersSortKey === 'costUsd') {
      cmp = (Number(a && a.costUsd) || 0) - (Number(b && b.costUsd) || 0);
    } else {
      cmp = (Number(a && a.lastAt) || 0) - (Number(b && b.lastAt) || 0);
    }
    if (cmp !== 0) return cmp * dir;
    return String((a && (a.userName || a.user)) || '').localeCompare(String((b && (b.userName || b.user)) || ''), undefined, { sensitivity: 'base' });
  });
  return arr;
}

let historyArenaTab = 'text';

async function syncLocalImageRunsToServer(localRuns, serverRuns) {
  if (!Array.isArray(localRuns) || !localRuns.length) return null;
  const serverIds = new Set((serverRuns || []).map((r) => r && r.id).filter(Boolean));
  const missing = localRuns.filter((r) => r && r.id && !serverIds.has(r.id));
  if (!missing.length) return null;
  try {
    const compactBatch = missing.slice(0, 40).map((r) => ({
      id: r.id,
      at: r.at,
      starred: Boolean(r.starred),
      user: r.user || (ME && ME.username),
      userName: r.userName || r.user || (ME && ME.username),
      packId: r.packId || 'custom',
      scenarioId: r.scenarioId || 'custom',
      title: r.title || r.scenarioTitle || (r.prompt || '').slice(0, 72) || 'Image Arena Comparison',
      prompt: r.prompt || '',
      imageSize: r.imageSize || '2K',
      aspectRatio: r.aspectRatio || '16:9',
      slots: r.slots || [],
      results: (Array.isArray(r.results) ? r.results : []).map((res) => ({
        slot: res.slot,
        catalogId: res.catalogId,
        label: res.label,
        shortLabel: res.shortLabel,
        model: res.model,
        thinkingLevel: res.thinkingLevel,
        imageSize: res.imageSize || r.imageSize,
        requestedSize: res.requestedSize || res.imageSize || r.imageSize || '2K',
        aspectRatio: res.aspectRatio || r.aspectRatio,
        width: res.width || null,
        height: res.height || null,
        megapixels: res.megapixels || null,
        slaBadge: res.slaBadge || null,
        savingsVsNanoBanana2Pct: res.savingsVsNanoBanana2Pct || 0,
        ok: Boolean(res.ok || !res.error),
        error: res.error || null,
        latencyMs: res.latencyMs,
        costUsd: res.costUsd != null ? res.costUsd : res.standardPayGoCostUsd,
        standardPayGoCostUsd: res.standardPayGoCostUsd != null ? res.standardPayGoCostUsd : res.costUsd,
        standardPayGoPer1kUsd: res.standardPayGoPer1kUsd || null,
        offPeakSupported: Boolean(res.offPeakSupported),
        offPeakPayGoCostUsd: res.offPeakPayGoCostUsd != null ? res.offPeakPayGoCostUsd : null,
        promptTokens: res.promptTokens,
        imageOutputTokens: res.imageOutputTokens,
        thoughtsTokens: res.thoughtsTokens || res.reasoningTokens,
        reasoningTokens: res.reasoningTokens || res.thoughtsTokens || 0,
        completionTokens: res.completionTokens,
        mimeType: res.mimeType || 'image/png',
        hasImage: Boolean(res.hasImage || res.imageDataUrl || res.imageVaultRef || res.thumbDataUrl),
        imageVaultRef: res.imageVaultRef || null,
        thoughtVaultRef: res.thoughtVaultRef || null,
        thumbDataUrl: res.thumbDataUrl || null,
      })),
    }));
    await fetch('/api/image-arena/history', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs: compactBatch }),
    });
    return true;
  } catch (_) {
    return null;
  }
}

function isCadHistoryRun(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.arena === '3d' || r.kind === '3d' || r.kind === '3d_single' || r.category === 'cad3d') return true;
  if (String(r.taskId || '').startsWith('cad-')) return true;
  const t = String(r.title || '');
  if (/^3D CAD:/i.test(t) || /Custom 3D\s*[\/&]\s*CAD/i.test(t)) return true;
  if (Array.isArray(r.summary) && r.summary.some((s) => s && s.arena === '3d')) return true;
  return false;
}

async function openHistoryModal(opts = {}) {
  const isAdmin = ME && ME.role === 'admin';
  historyScope = isAdmin ? 'all' : 'me';
  if (opts && (opts.arenaTab === 'image' || opts.arenaTab === '3d' || opts.arenaTab === 'text')) {
    historyArenaTab = opts.arenaTab;
  } else if (typeof ACTIVE_ARENA_MODE !== 'undefined' && ACTIVE_ARENA_MODE === 'image') {
    historyArenaTab = 'image';
  } else if (typeof ACTIVE_ARENA_MODE !== 'undefined' && ACTIVE_ARENA_MODE === '3d') {
    historyArenaTab = '3d';
  } else {
    historyArenaTab = 'text';
  }
  const modalTitle = historyArenaTab === 'image'
    ? '🎨 Image & GenMedia Run History'
    : (historyArenaTab === '3d'
        ? '🧊 3D & CAD Arena Run History'
        : '⚡ Text, Code & Agent Run History');
  const body = openAuthModal(modalTitle, { wide: true });
  body.innerHTML = '<p class="auth-loading">Loading…</p>';
  try {
    if (historyArenaTab === 'image') {
      const [srvImgResp, srvImgUsage, localImgRuns] = await Promise.all([
        fetch('/api/image-arena/history?scope=' + historyScope, { credentials: 'same-origin' }),
        isAdmin ? fetch('/api/image-arena/usage', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null),
        typeof listImageArenaRunsFromHistory === 'function' ? listImageArenaRunsFromHistory().catch(() => []) : Promise.resolve([]),
        ensureImageArenaLoaded().catch(() => null), // image catalog, to hide runs from retired models
      ]);
      if (srvImgResp.status === 401) { window.location.replace('/login'); return; }
      const srvImgData = await srvImgResp.json().catch(() => ({ runs: [] }));
      if (!srvImgResp.ok) throw new Error(srvImgData.error || 'Failed to load image history.');

      let serverImgRuns = (srvImgData && Array.isArray(srvImgData.runs)) ? srvImgData.runs : [];
      let imgUsage = srvImgUsage || null;

      // One-time sync of any local IndexedDB runs into the server so admin usage & cross-device history include them
      const didSync = await syncLocalImageRunsToServer(localImgRuns, serverImgRuns);
      if (didSync) {
        const [refetchedHist, refetchedUsage] = await Promise.all([
          fetch('/api/image-arena/history?scope=' + historyScope, { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : { runs: serverImgRuns })).catch(() => ({ runs: serverImgRuns })),
          isAdmin ? fetch('/api/image-arena/usage', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : imgUsage)).catch(() => imgUsage) : Promise.resolve(null),
        ]);
        serverImgRuns = (refetchedHist && Array.isArray(refetchedHist.runs)) ? refetchedHist.runs : serverImgRuns;
        if (refetchedUsage) imgUsage = refetchedUsage;
      }

      // Merge local IndexedDB thumbnails/data into server runs by id so any local run has instant thumbnail access
      const byId = new Map();
      for (const sr of serverImgRuns) {
        if (sr && sr.id) byId.set(sr.id, { ...sr, starred: Boolean(sr.starred) });
      }
      for (const lr of (localImgRuns || [])) {
        if (!lr || !lr.id) continue;
        if (!byId.has(lr.id)) {
          byId.set(lr.id, {
            ...lr,
            starred: Boolean(lr.starred),
            user: lr.user || (ME && ME.username) || '',
            userName: lr.userName || lr.user || (ME && ME.username) || '',
            title: lr.title || lr.scenarioTitle || lr.prompt || 'Image Arena Comparison',
            summary: lr.summary || lr.results || [],
          });
        } else {
          const cur = byId.get(lr.id);
          if (lr.starred && !cur.starred) cur.starred = true;
        }
      }
      const mergedImgRuns = Array.from(byId.values())
        .filter(isVisibleImageRun)
        .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));

      _histState = {
        body,
        runs: [],
        imgRuns: mergedImgRuns,
        usage: null,
        imgUsage,
        isAdmin,
        retentionDays: Number(srvImgData && srvImgData.retentionDays) || 7,
      };
    } else {
      const targetArena = historyArenaTab === '3d' ? '3d' : 'text';
      const [histResp, usage] = await Promise.all([
        fetch('/api/history?scope=' + historyScope + '&arena=' + encodeURIComponent(targetArena), { credentials: 'same-origin' }),
        isAdmin ? fetch('/api/usage?arena=' + encodeURIComponent(targetArena), { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null),
      ]);
      if (histResp.status === 401) { window.location.replace('/login'); return; }
      const data = await histResp.json();
      if (!histResp.ok) throw new Error(data.error || 'Failed to load history.');

      const filteredRuns = (data.runs || []).filter((r) => {
        if (!r || r.arena === 'image' || String(r.id || '').startsWith('img_')) return false;
        return targetArena === '3d' ? isCadHistoryRun(r) : !isCadHistoryRun(r);
      });

      _histState = {
        body,
        runs: filteredRuns,
        imgRuns: [],
        usage,
        imgUsage: null,
        isAdmin,
        retentionDays: Number(data.retentionDays) || 7,
      };
    }
    historyPage = 0; usersPage = 0; historyUserFilter = null; historyStarredOnly = false;   // fresh view on (re)open
    paintHistoryModal();
  } catch (e) {
    body.innerHTML = '<p class="auth-err"></p>'; body.querySelector('p').textContent = e.message;
  }
}

function renderRunsSortToolbar(totalCount, mode = 'text', starredCount = 0) {
  const retDays = (_histState && _histState.retentionDays) || 7;
  const cols = [
    { key: 'at', label: 'Date / Time', defaultDir: 'desc' },
    { key: 'starred', label: '★ Starred', defaultDir: 'desc' },
    { key: 'title', label: mode === 'image' ? 'Scenario / Prompt' : (mode === '3d' ? '3D Part / Prompt' : 'Task / Prompt'), defaultDir: 'asc' },
  ];
  if (historyScope === 'all' && !historyUserFilter) {
    cols.push({ key: 'user', label: 'User', defaultDir: 'asc' });
  }
  cols.push({ key: 'cost', label: 'Run Cost', defaultDir: 'desc' });
  if (mode === 'image') {
    cols.push({ key: 'resolution', label: 'Resolution', defaultDir: 'desc' });
  } else if (mode !== '3d') {
    cols.push({ key: 'correctness', label: 'Test Score', defaultDir: 'desc' });
  }
  const btns = cols.map((c) => {
    const active = runsSortKey === c.key;
    const arrow = active ? (runsSortDir === 'asc' ? '▲' : '▼') : '⇅';
    return `<button type="button" class="hist-sort-btn${active ? ' is-sorted' : ''}" data-run-sort="${esc(c.key)}" data-default-dir="${esc(c.defaultDir)}" title="Sort runs by ${esc(c.label)}">${esc(c.label)} <span class="sort-ind">${arrow}</span></button>`;
  }).join('');
  const auditDays = (CONFIG && CONFIG.auditRetentionDays) || 90;
  const starFilterBtn = `<button type="button" class="hist-star-filter-btn${historyStarredOnly ? ' active' : ''}" title="Show only starred runs kept forever (exempt from ${retDays}-day output auto-pruning)">★ Kept only (${fmtInt(starredCount)})</button>`;
  const retentionBadge = `<span class="hist-retention-note" title="Unstarred run outputs and generated images are automatically pruned after ${retDays} days to save storage (star any run to keep forever). Input prompts and input attachments are retained for ${auditDays} days for security & compliance audit.">⏱ ${retDays}d output prune · 🛡️ ${auditDays}d input audit · ★ Star to keep</span>`;
  return `<div class="hist-toolbar">
    <span class="hist-toolbar-label">Sort runs (${fmtInt(totalCount)}):</span>
    <div class="hist-sort-group">${btns}${starFilterBtn}${retentionBadge}</div>
  </div>`;
}

// SECURITY (3.2): image-run history rows are stored data that any user can POST to
// /api/image-arena/history, and admins see every user's rows. A thumbnail src is
// only rendered when it is a plain base64 image data URL or one of our own vault
// URLs; anything else (markup, javascript:, external URLs) is skipped entirely.
const SAFE_IMG_SRC_RE = /^(data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+|\/api\/me\/vault\/[A-Za-z0-9%._-]+)$/;
function safeImageSrc(src) {
  if (typeof src !== 'string' || !src || src.length > 12 * 1024 * 1024) return '';
  return SAFE_IMG_SRC_RE.test(src) ? src : '';
}

function imgHistRowHtml(r) {
  const isStarred = Boolean(r && r.starred);
  const rawList = (Array.isArray(r.summary) && r.summary.length) ? r.summary : (Array.isArray(r.results) ? r.results : []);
  const slotList = rawList.filter((x) => x && isCurrentImageModel(x.catalogId));
  const thumbs = slotList.filter((x) => !x.error && (x.thumbDataUrl || x.imageDataUrl || x.imageVaultRef)).slice(0, 4).map((x) => {
    const src = safeImageSrc(x.thumbDataUrl || x.imageDataUrl || (x.imageVaultRef ? '/api/me/vault/' + encodeURIComponent(String(x.imageVaultRef)) : ''));
    if (!src) return '';
    return `<img src="${esc(src)}" class="img-hist-thumb ihc-thumb" width="42" height="32" alt="${esc(x.shortLabel || x.label || x.slot)}" style="width:42px;height:32px;max-width:42px;max-height:32px;object-fit:cover;border-radius:4px;border:1px solid var(--border);flex-shrink:0;display:block" title="${esc(x.label || x.model)} (${esc((x.width && x.height) ? x.width + '×' + x.height : (x.imageSize || r.imageSize || '2K'))})"/>`;
  }).join('');
  const chips = slotList.map((s) => {
    const stat = s.error
      ? '<span class="hc-err">error</span>'
      : esc(`${s.imageSize || r.imageSize || '2K'}${s.latencyMs ? ' · ' + (s.latencyMs / 1000).toFixed(1) + 's' : ''}`);
    const slotCost = s.costUsd != null ? s.costUsd : s.standardPayGoCostUsd;
    const cost = slotCost != null ? ' · ' + esc(fmtCost(slotCost)) : '';
    return `<span class="hist-chip"><b>${esc(s.shortLabel || s.label || s.model)}</b> ${stat}${cost}</span>`;
  }).join('');
  const resChip = `<span class="hist-chip">${esc(r.imageSize || '2K')} (${esc(r.aspectRatio || '16:9')})</span>`;
  const userLabel = r.userName || r.user || (ME && ME.username) || '';
  const who = userLabel ? `<span class="hist-who">${esc(userLabel)}</span>` : '';
  const keptBadge = isStarred ? `<span class="hist-kept-badge" title="Starred — kept forever (exempt from 7-day auto-pruning)">★ Kept</span>` : '';
  const runTitle = r.title || r.scenarioTitle || r.prompt || 'Image Arena Comparison';
  return `<div class="hist-row${isStarred ? ' is-starred' : ''}" data-img-hist-id="${esc(r.id)}">
    <div class="hist-main">
      <div class="hist-title">${esc(runTitle)}</div>
      <div class="hist-when"><span>${esc(fmtWhen(r.at))}</span>${who}${keptBadge}</div>
      <div class="hist-chips">${thumbs}${resChip}${chips}</div>
    </div>
    <div class="hist-act">
      <button class="hist-btn hist-icon-btn hist-star-btn${isStarred ? ' is-starred' : ''}" type="button" data-id="${esc(r.id)}" data-arena="image" title="${isStarred ? 'Starred (kept forever) — click to unstar' : 'Star this run to keep it forever (exempt from 7-day auto-pruning)'}" aria-label="Star image run">${isStarred ? ICON_STAR_ON : ICON_STAR_OFF}</button>
      <button class="hist-btn hist-restore hist-img-restore" type="button" data-id="${esc(r.id)}" title="Restore this image comparison to the Image Arena">Restore ▸</button>
      <button class="hist-btn hist-icon-btn hist-del hist-img-del" type="button" data-id="${esc(r.id)}" title="Delete this image run from history" aria-label="Delete image run">${ICON_TRASH}</button>
    </div>
  </div>`;
}

// Render the current page of the already-fetched (light) history list. Called on
// open, page nav, and after a delete — no refetch, so paging is instant.
function paintHistoryModal() {
  const { body, runs, imgRuns = [], usage, imgUsage, isAdmin } = _histState;
  if (!body) return;

  if (historyArenaTab === 'image') {
    const usagePanel = (isAdmin && imgUsage) ? renderImageUsagePanel(imgUsage) : '';
    const activeName = historyUserFilter
      ? (((imgUsage && imgUsage.users) || []).find((x) => (x.user || x.userName) === historyUserFilter) || {}).userName || historyUserFilter
      : '';
    const filterChip = historyUserFilter
      ? `<div class="hist-filter">Showing runs by <b>${esc(activeName)}</b>
           <button class="hf-clear" type="button">✕ show everyone</button></div>`
      : '';
    const byUserImgRuns = historyUserFilter
      ? imgRuns.filter((r) => (r.user || r.userName) === historyUserFilter)
      : imgRuns;
    const starredCount = byUserImgRuns.filter((r) => r && r.starred).length;
    const filteredImgRuns = historyStarredOnly
      ? byUserImgRuns.filter((r) => r && r.starred)
      : byUserImgRuns;
    const sortedImgRuns = sortHistoryRuns(filteredImgRuns);
    const total = sortedImgRuns.length;
    const pageCount = Math.max(1, Math.ceil(total / HIST_PAGE_SIZE));
    historyPage = Math.min(Math.max(0, historyPage), pageCount - 1);
    const start = historyPage * HIST_PAGE_SIZE;
    const pageRuns = sortedImgRuns.slice(start, start + HIST_PAGE_SIZE);
    const sortToolbar = (byUserImgRuns.length > 0 || historyStarredOnly)
      ? renderRunsSortToolbar(total, 'image', starredCount)
      : '';
    const imgRows = total
      ? pageRuns.map((r) => imgHistRowHtml(r)).join('')
      : (historyStarredOnly
          ? '<p class="auth-loading">No starred Image &amp; GenMedia runs yet — click the ☆ icon on any run to keep it forever (exempt from 7-day auto-pruning).</p>'
          : (historyUserFilter
              ? `<p class="auth-loading">No recent (last ${(_histState && _histState.retentionDays) || 7} days) or ★ starred Image &amp; GenMedia payloads for <b>${esc(activeName)}</b> — older unstarred payloads were auto-pruned while lifetime user &amp; run counts are preserved above.</p>`
              : '<p class="auth-loading">No Image &amp; GenMedia runs yet — click <b>Generate &amp; Compare Images ▸</b> in the Image Arena and your runs will automatically appear here for 1-click restore.</p>'));
    const pager = total > HIST_PAGE_SIZE ? histPagerHtml(historyPage, pageCount, total, start, pageRuns.length) : '';
    body.innerHTML = usagePanel + filterChip + sortToolbar + `<div class="hist-list">${imgRows}</div>` + pager;
    body.querySelectorAll('.usage-table th.sortable').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const defDir = th.dataset.defaultDir || 'desc';
      if (usersSortKey === key) {
        usersSortDir = usersSortDir === 'desc' ? 'asc' : 'desc';
      } else {
        usersSortKey = key;
        usersSortDir = defDir;
      }
      usersPage = 0;
      paintHistoryModal();
    }));
    body.querySelectorAll('.hist-sort-btn').forEach((btn) => btn.addEventListener('click', () => {
      const key = btn.dataset.runSort;
      const defDir = btn.dataset.defaultDir || 'desc';
      if (runsSortKey === key) {
        runsSortDir = runsSortDir === 'desc' ? 'asc' : 'desc';
      } else {
        runsSortKey = key;
        runsSortDir = defDir;
      }
      historyPage = 0;
      paintHistoryModal();
    }));
    { const sf = body.querySelector('.hist-star-filter-btn');
      if (sf) sf.addEventListener('click', () => { historyStarredOnly = !historyStarredOnly; historyPage = 0; paintHistoryModal(); }); }
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
    body.querySelectorAll('.hist-star-btn').forEach((b) => b.addEventListener('click', () => toggleHistoryRunStar(b.dataset.id, b.dataset.arena || 'image')));
    body.querySelectorAll('.hist-img-restore').forEach((b) => b.addEventListener('click', async () => {
      await restoreImageArenaRun(b.dataset.id);
      closeAuthModal();
    }));
    body.querySelectorAll('.hist-img-del').forEach((b) => b.addEventListener('click', async () => {
      // Same confirmation as the text-run delete; admins can delete other users' runs here (1.9).
      if (!window.confirm('Delete this image run from history?')) return;
      await deleteImageArenaRunFromHistory(b.dataset.id);
      _histState.imgRuns = (_histState.imgRuns || []).filter((x) => x.id !== b.dataset.id);
      if (isAdmin) {
        try {
          const uResp = await fetch('/api/image-arena/usage', { credentials: 'same-origin' });
          if (uResp.ok) _histState.imgUsage = await uResp.json();
        } catch (_) {}
      }
      updateImageHistoryButton();
      paintHistoryModal();
    }));
    const prev = body.querySelector('.hist-pg-prev');
    if (prev) prev.addEventListener('click', () => { if (historyPage > 0) { historyPage--; paintHistoryModal(); } });
    const next = body.querySelector('.hist-pg-next');
    if (next) next.addEventListener('click', () => { if (historyPage < pageCount - 1) { historyPage++; paintHistoryModal(); } });
    return;
  }

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
  const byUserRuns = historyUserFilter ? runs.filter((r) => (r.user || r.userName) === historyUserFilter) : runs;
  const starredCount = byUserRuns.filter((r) => r && r.starred).length;
  const filteredRuns = historyStarredOnly ? byUserRuns.filter((r) => r && r.starred) : byUserRuns;
  const runs_ = sortHistoryRuns(filteredRuns);
  const total = runs_.length;
  const pageCount = Math.max(1, Math.ceil(total / HIST_PAGE_SIZE));
  historyPage = Math.min(Math.max(0, historyPage), pageCount - 1);   // clamp (e.g. after deleting the last row on a page)
  const start = historyPage * HIST_PAGE_SIZE;
  const pageRuns = runs_.slice(start, start + HIST_PAGE_SIZE);
  const isCadTab = historyArenaTab === '3d';
  const sortToolbar = (byUserRuns.length > 0 || historyStarredOnly)
    ? renderRunsSortToolbar(total, isCadTab ? '3d' : 'text', starredCount)
    : '';
  const rows = total
    ? pageRuns.map((h) => histRowHtml(h)).join('')
    : (historyStarredOnly
        ? `<p class="auth-loading">No starred ${isCadTab ? '3D &amp; CAD ' : ''}runs yet — click the ☆ icon on any run to keep it forever (exempt from 7-day auto-pruning).</p>`
        : (historyUserFilter
            ? `<p class="auth-loading">No recent (last ${(_histState && _histState.retentionDays) || 7} days) or ★ starred ${isCadTab ? '3D &amp; CAD ' : ''}run payloads for <b>${esc(activeName)}</b> — older unstarred payloads were auto-pruned while lifetime user &amp; run counts are preserved above.</p>`
            : (isCadTab
                ? '<p class="auth-loading">No 3D &amp; CAD runs yet — run a 3D model comparison in the <b>🧊 3D &amp; CAD Arena</b> and it will appear here for 1-click restore.</p>'
                : '<p class="auth-loading">No runs yet — run a comparison and it will appear here so you can revisit or re-showcase it.</p>')));
  const pager = total > HIST_PAGE_SIZE ? histPagerHtml(historyPage, pageCount, total, start, pageRuns.length) : '';
  body.innerHTML = usagePanel + filterChip + sortToolbar + `<div class="hist-list">${rows}</div>` + pager;
  // click a column header in the admin usage table → sort users by that column
  body.querySelectorAll('.usage-table th.sortable').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    const defDir = th.dataset.defaultDir || 'desc';
    if (usersSortKey === key) {
      usersSortDir = usersSortDir === 'desc' ? 'asc' : 'desc';
    } else {
      usersSortKey = key;
      usersSortDir = defDir;
    }
    usersPage = 0;
    paintHistoryModal();
  }));
  // click a sort button in the run history toolbar → sort runs by that field
  body.querySelectorAll('.hist-sort-btn').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.dataset.runSort;
    const defDir = btn.dataset.defaultDir || 'desc';
    if (runsSortKey === key) {
      runsSortDir = runsSortDir === 'desc' ? 'asc' : 'desc';
    } else {
      runsSortKey = key;
      runsSortDir = defDir;
    }
    historyPage = 0;
    paintHistoryModal();
  }));
  { const sf = body.querySelector('.hist-star-filter-btn');
    if (sf) sf.addEventListener('click', () => { historyStarredOnly = !historyStarredOnly; historyPage = 0; paintHistoryModal(); }); }
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
  body.querySelectorAll('.hist-star-btn').forEach((b) => b.addEventListener('click', () => toggleHistoryRunStar(b.dataset.id, b.dataset.arena || 'text')));
  body.querySelectorAll('.hist-restore').forEach((b) => b.addEventListener('click', () => restoreHistory(b.dataset.id)));
  body.querySelectorAll('.hist-pdf-btn').forEach((b) => b.addEventListener('click', () => exportHistoryRunPdf(b.dataset.id, b)));
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
  const isStarred = Boolean(h && h.starred);
  const isCad = isCadHistoryRun(h);
  const chips = (h.summary || []).map((s) => {
    const stat = s.error ? '<span class="hc-err">error</span>' : (isCad ? '3D CAD' : (s.total ? esc(s.correctness + '%') : 'done'));
    const cost = s.costUsd != null ? ' · ' + esc(fmtCost(s.costUsd)) : '';
    return `<span class="hist-chip"><b>${esc(s.label)}</b> ${stat}${cost}</span>`;
  }).join('');
  const userLabel = h.userName || h.user || (ME && ME.username) || '';
  const who = userLabel ? `<span class="hist-who">${esc(userLabel)}</span>` : '';
  const keptBadge = isStarred ? `<span class="hist-kept-badge" title="Starred — kept forever (exempt from 7-day auto-pruning)">★ Kept</span>` : '';
  return `<div class="hist-row${isStarred ? ' is-starred' : ''}">
    <div class="hist-main"><div class="hist-title">${esc(h.title)}</div><div class="hist-when"><span>${esc(fmtWhen(h.at))}</span>${who}${keptBadge}</div><div class="hist-chips">${chips}</div></div>
    <div class="hist-act">
      <button class="hist-btn hist-icon-btn hist-star-btn${isStarred ? ' is-starred' : ''}" type="button" data-id="${esc(h.id)}" data-arena="${isCad ? '3d' : 'text'}" title="${isStarred ? 'Starred (kept forever) — click to unstar' : 'Star this run to keep it forever (exempt from 7-day auto-pruning)'}" aria-label="Star run">${isStarred ? ICON_STAR_ON : ICON_STAR_OFF}</button>
      <button class="hist-btn hist-restore" type="button" data-id="${esc(h.id)}" title="Restore this comparison to the arena">Restore ▸</button>
      <button class="hist-btn hist-icon-btn hist-pdf-btn" type="button" data-id="${esc(h.id)}" title="Export PDF report for this run" aria-label="Export PDF report">${ICON_PDF}</button>
      <button class="hist-btn hist-icon-btn hist-del" type="button" data-id="${esc(h.id)}" title="Delete this run from history" aria-label="Delete run">${ICON_TRASH}</button>
    </div>
  </div>`;
}

async function toggleHistoryRunStar(id, arena = 'text') {
  if (!id) return;
  const isImg = arena === 'image';
  const list = isImg ? (_histState.imgRuns || []) : (_histState.runs || []);
  const item = list.find((r) => r && r.id === id);
  const nextStarred = !(item && item.starred);
  if (item) item.starred = nextStarred;
  paintHistoryModal();

  try {
    const endpoint = isImg
      ? '/api/image-arena/history/' + encodeURIComponent(id) + '/star'
      : '/api/history/' + encodeURIComponent(id) + '/star';
    const resp = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ starred: nextStarred }),
    });
    if (resp.status === 401) { window.location.replace('/login'); return; }
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok || !j.ok) throw new Error((j && j.error) || 'Could not update star status.');
    if (item) item.starred = Boolean(j.starred);
    if (isImg && typeof setImageArenaRunStarredInLocalDb === 'function') {
      await setImageArenaRunStarredInLocalDb(id, Boolean(j.starred));
    }
    paintHistoryModal();
  } catch (e) {
    if (item) item.starred = !nextStarred;
    paintHistoryModal();
    window.alert(e.message);
  }
}

function renderImageUsagePanel(u) {
  const t = (u && u.totals) || {};
  const all = sortUsageUsers((u && u.users) || []);
  const pageCount = Math.max(1, Math.ceil(all.length / USER_PAGE_SIZE));
  usersPage = Math.min(Math.max(0, usersPage), pageCount - 1);
  const start = usersPage * USER_PAGE_SIZE;
  const page = all.slice(start, start + USER_PAGE_SIZE);
  const rows = page.map((x) => {
    const id = x.user || x.userName;
    const on = historyUserFilter === id;
    const imgCnt = Number(x.imagesGenerated) || 0;
    return `<tr class="u-row${on ? ' active' : ''}" data-user="${esc(id)}" title="Show only this user's image runs">
      <td class="u-name">${esc(x.userName || x.user)}${on ? ' <span class="u-tag">filtered</span>' : ''}</td>
      <td>${fmtInt(x.runs || 0)}</td>
      <td>${fmtInt(x.runsToday || 0)}</td>
      <td><span class="u-lib-badge${imgCnt > 0 ? ' has-items' : ''}" title="Total images generated by this user">${fmtInt(imgCnt)}</span></td>
      <td>${esc(fmtCost(x.costUsd || 0))}</td>
      <td class="hist-when">${esc(x.lastAt ? fmtWhen(x.lastAt) : '—')}</td></tr>`;
  }).join('');
  const thCols = [
    { key: 'user', label: 'User', defaultDir: 'asc' },
    { key: 'runs', label: 'Runs', defaultDir: 'desc' },
    { key: 'runsToday', label: 'Today', defaultDir: 'desc' },
    { key: 'imagesGenerated', label: 'Images', defaultDir: 'desc' },
    { key: 'costUsd', label: 'Cost', defaultDir: 'desc' },
    { key: 'lastAt', label: 'Last active', defaultDir: 'desc' },
  ];
  const thHtml = thCols.map((c) => {
    const active = usersSortKey === c.key;
    const arrow = active ? (usersSortDir === 'asc' ? '▲' : '▼') : '⇅';
    return `<th class="sortable${active ? ' is-sorted' : ''}" data-sort="${esc(c.key)}" data-default-dir="${esc(c.defaultDir)}" title="Sort by ${esc(c.label)}">${esc(c.label)} <span class="sort-ind">${arrow}</span></th>`;
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
      <div class="ustat"><div class="uk">Images generated</div><div class="uv">${fmtInt(t.totalImages || 0)}</div></div>
      <div class="ustat"><div class="uk">Total cost</div><div class="uv">${esc(fmtCost(t.totalCostUsd || 0))}</div></div>
    </div>
    ${rows ? `<table class="usage-table"><thead><tr>${thHtml}</tr></thead><tbody>${rows}</tbody></table>${pager}` : ''}
    <p class="hint">Click any column header to sort · Click a user row to filter their Image &amp; GenMedia runs · Lifetime user &amp; run counts are preserved across 7-day payload auto-pruning. Today = since 00:00 UTC.</p>
  </div>`;
}

// Admin usage table. Paginated — it used to render only the first 15 users and
// silently drop the rest, so a busy deployment hid most of its users.
const USER_PAGE_SIZE = 8;
let usersPage = 0;
function renderUsagePanel(u) {
  const t = u.totals || {};
  const all = sortUsageUsers(u.users || []);
  const pageCount = Math.max(1, Math.ceil(all.length / USER_PAGE_SIZE));
  usersPage = Math.min(Math.max(0, usersPage), pageCount - 1);
  const start = usersPage * USER_PAGE_SIZE;
  const page = all.slice(start, start + USER_PAGE_SIZE);
  const rows = page.map((x) => {
    const id = x.user || x.userName;
    const on = historyUserFilter === id;
    const promptsCnt = Number(x.savedPrompts) || 0;
    const presetsCnt = Number(x.savedPresets) || 0;
    return `<tr class="u-row${on ? ' active' : ''}" data-user="${esc(id)}" title="Show only this user's runs">
      <td class="u-name">${esc(x.userName || x.user)}${on ? ' <span class="u-tag">filtered</span>' : ''}</td>
      <td>${fmtInt(x.runs || 0)}</td>
      <td>${fmtInt(x.runsToday || 0)}</td>
      <td><span class="u-lib-badge${promptsCnt > 0 ? ' has-items' : ''}" title="Saved custom prompts (count only — prompt content is private)">${fmtInt(promptsCnt)}</span></td>
      <td><span class="u-lib-badge${presetsCnt > 0 ? ' has-items' : ''}" title="Saved model presets (count only — presets are private)">${fmtInt(presetsCnt)}</span></td>
      <td>${esc(fmtCost(x.costUsd || 0))}</td>
      <td class="hist-when">${esc(x.lastAt ? fmtWhen(x.lastAt) : '—')}</td></tr>`;
  }).join('');
  const thCols = [
    { key: 'user', label: 'User', defaultDir: 'asc' },
    { key: 'runs', label: 'Runs', defaultDir: 'desc' },
    { key: 'runsToday', label: 'Today', defaultDir: 'desc' },
    { key: 'savedPrompts', label: 'Prompts', defaultDir: 'desc' },
    { key: 'savedPresets', label: 'Presets', defaultDir: 'desc' },
    { key: 'costUsd', label: 'Cost', defaultDir: 'desc' },
    { key: 'lastAt', label: 'Last active', defaultDir: 'desc' },
  ];
  const thHtml = thCols.map((c) => {
    const active = usersSortKey === c.key;
    const arrow = active ? (usersSortDir === 'asc' ? '▲' : '▼') : '⇅';
    return `<th class="sortable${active ? ' is-sorted' : ''}" data-sort="${esc(c.key)}" data-default-dir="${esc(c.defaultDir)}" title="Sort by ${esc(c.label)}">${esc(c.label)} <span class="sort-ind">${arrow}</span></th>`;
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
      <div class="ustat"><div class="uk">Saved prompts</div><div class="uv">${fmtInt(t.totalSavedPrompts || 0)}</div></div>
      <div class="ustat"><div class="uk">Saved presets</div><div class="uv">${fmtInt(t.totalSavedPresets || 0)}</div></div>
    </div>
    ${rows ? `<table class="usage-table"><thead><tr>${thHtml}</tr></thead><tbody>${rows}</tbody></table>${pager}` : ''}
    <p class="hint">Click any column header to sort · Click a user row to filter their runs · Lifetime user &amp; run counts are preserved across 7-day payload auto-pruning · Prompt/preset counts respect user privacy (contents remain private). Today = since 00:00 UTC.</p>
  </div>`;
}

async function restoreHistory(id) {
  // Restoring rebuilds the arena and overwrites the composer: never do that under
  // a streaming comparison or over unsaved input without an explicit OK (1.6).
  if (!confirmInterruptRun('A comparison is still running. Stop it and restore this run?')) return;
  if (!confirmReplaceComposer('Restoring this run will replace your current prompt and attachments. Continue?')) return;
  try {
    const r = await fetch('/api/history/' + encodeURIComponent(id), { credentials: 'same-origin' });
    if (r.status === 401) { saveComposerDraft(); window.location.replace('/login'); return; }
    const j = await r.json();
    if (!r.ok || !j.run) throw new Error((j && j.error) || 'Could not load that run.');
    const snap = j.run;
    closeAuthModal();
    const fullTask = (CONFIG && Array.isArray(CONFIG.tasks) ? CONFIG.tasks.find((t) => t.id === snap.taskId) : null) || null;
    const isCadSnap = Boolean(
      (fullTask && (fullTask.category === 'cad3d' || fullTask.visualizer === 'cad3d')) ||
      isCadHistoryRun(snap)
    );
    const targetMode = isCadSnap ? '3d' : 'text';
    if (typeof ACTIVE_ARENA_MODE !== 'undefined' && ACTIVE_ARENA_MODE !== targetMode) {
      switchArenaMode(targetMode, { skipInterruptCheck: true });
    }
    selectTaskById(snap.taskId);
    if (isCustomTaskId(snap.taskId) && snap.prompt && $('#customPrompt')) {
      $('#customPrompt').value = snap.prompt;
    }
    if (isCustomTaskId(snap.taskId) && Array.isArray(snap.attachments) && snap.attachments.length) {
      restoreCustomAttachmentsFromData(snap.attachments);
    } else if (isCustomTaskId(snap.taskId)) {
      clearAttachments();
    }
    markComposerApplied();
    saveComposerDraft();
    renderTaskPrompt();
    renderSavedRun(snap); // rebuilds the arena + scorecard from the snapshot (its own model set)
    $('#arena').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    if (_histState.isAdmin) {
      try {
        const targetArena = historyArenaTab === '3d' ? '3d' : 'text';
        const uResp = await fetch('/api/usage?arena=' + encodeURIComponent(targetArena), { credentials: 'same-origin' });
        if (uResp.ok) _histState.usage = await uResp.json();
      } catch (_) {}
    }
    paintHistoryModal();
  } catch (e) { window.alert(e.message); }
}

// Wipe the current run from the UI → clean slate: clears results, scorecard, this
// task's saved snapshot and any in-flight wall timer, then rebuilds empty columns.
// Repaint the arena + scorecard + Step 2 model selectors from a saved snapshot (used by History → Restore).
function renderSavedRun(snap) {
  // A restore replaces every CAD slot's code/telemetry/4-view state; never let a
  // previous session's revisions leak into (and be sent to the model for) this run (1.7).
  if (typeof resetAllCadSlotStates === 'function') resetAllCadSlotStates();
  // SECURITY: slot ids from a stored run are interpolated into element ids and
  // data-* attributes by buildArena, so coerce them to the known A..F set first.
  if (Array.isArray(snap.models)) {
    snap.models = snap.models.slice(0, MAX_SLOTS).map((m, i) => {
      const mm = (m && typeof m === 'object') ? m : {};
      return { ...mm, slot: ALL_SLOT_IDS.includes(mm.slot) ? mm.slot : String.fromCharCode(65 + i) };
    });
  }
  if (Array.isArray(snap.slots)) {
    snap.slots = snap.slots.filter((s) => s && ALL_SLOT_IDS.includes(s.slot));
  } else {
    snap.slots = [];
  }
  _lastRunId = snap.id || null;
  _currentRunId = snap.id || null;
  _judgeScored = snap.judge || null;
  { const jo = $('#judgeOut'); if (jo) jo.innerHTML = ''; }

  // Sync Step 2 model selectors (`SLOT_IDS`, `SLOT_ASSIGN`, `SLOT_EFFORT`, `MODELS`)
  // so restoring a historical run also restores the same models into Step 2.
  if (Array.isArray(snap.models) && snap.models.length > 0) {
    const cat = catalog();
    const newSlotIds = [];
    const newAssign = {};
    const newEffort = {};
    snap.models.slice(0, MAX_SLOTS).forEach((m, i) => {
      const slot = (m && m.slot) ? String(m.slot) : String.fromCharCode(65 + i);
      const rawId = (m && (m.catalogId || m.id)) || '';
      const mappedId = RETIRED_MODEL_MAP[rawId] || rawId;
      let catEntry = cat.find((x) => x.id === mappedId)
        || (m && m.model ? cat.find((x) => x.model === m.model && x.provider === m.provider) : null)
        || (m && m.label ? cat.find((x) => x.label === m.label) : null);
      const cid = catEntry ? catEntry.id : (mappedId || (cat[0] && cat[0].id) || 'gemini-3.8-flash');
      newSlotIds.push(slot);
      newAssign[slot] = cid;
      let eff = (m && m.effortOverride) || null;
      if (!eff && m && m.thinking && m.thinking.value && catEntry && catEntry.thinkingOptions) {
        const opts = catEntry.thinkingOptions.options || [];
        const defVal = catEntry.thinkingOptions.defaultValue;
        const valStr = String(m.thinking.value);
        if (opts.some((o) => String(o.value) === valStr) && valStr !== String(defVal)) {
          eff = valStr;
        }
      }
      newEffort[slot] = eff;
    });
    SLOT_IDS = newSlotIds;
    ALL_SLOT_IDS.forEach((s) => { SLOT_ASSIGN[s] = null; SLOT_EFFORT[s] = null; });
    newSlotIds.forEach((s) => {
      SLOT_ASSIGN[s] = newAssign[s] || null;
      SLOT_EFFORT[s] = newEffort[s] || null;
    });
    syncModelsFromSlots();
    renderModelEditors();
    updateQuotaBadge();
    updateRunButton();
    renderContextMeter();
    saveUserPreferencesDebounced();
  }

  buildArena(snap.models);
  const resultsMap = {};
  snap.slots.forEach(({ slot, data }) => {
    if (!data) return;
    resultsMap[slot] = data;
    if (data.error) { setStatus(slot, 'Error: ' + esc(data.error), 'err'); return; }
    applyResultToColumn(slot, data);
  });
  LAST_RESULTS = resultsMap;
  finalize(resultsMap, snap.models.map((m) => m.slot)); // rebuild the scorecard from saved results
  if (snap.judge) {
    _judgeScored = snap.judge;
    const jb = $('#judgeBody');
    if (jb) jb.classList.remove('hidden');
    const panel = $('#judgePanel');
    if (panel) panel.classList.remove('hidden');
    renderJudge(snap.judge);
  }
  const jumpBtn = $('#jumpScorecardBtn');
  const pdfTopBtn = $('#exportPdfTopBtn');
  const sc = $('#scorecard');
  if (sc && !sc.classList.contains('hidden')) {
    if (jumpBtn) jumpBtn.classList.remove('hidden');
    if (pdfTopBtn) pdfTopBtn.classList.remove('hidden');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'llm-compare-report.pdf';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { document.body.removeChild(a); } catch (_) {}
    URL.revokeObjectURL(url);
  }, 400);
}

function filenameFromDisposition(headerVal, fallback) {
  if (!headerVal) return fallback;
  const m = String(headerVal).match(/filename="?([^";]+)"?/i);
  return (m && m[1]) ? m[1] : fallback;
}

async function exportCurrentRunPdf(triggerBtn) {
  const resultKeys = Object.keys(LAST_RESULTS || {});
  if (!resultKeys.length) {
    window.alert('Run a comparison first (or restore one from History) to export a PDF report.');
    return;
  }
  const task = currentTask();
  const activeModels = (ARENA_MODELS && ARENA_MODELS.length) ? ARENA_MODELS : MODELS;
  const promptText = task.id === 'custom'
    ? (($('#customPrompt') && $('#customPrompt').value) || '').trim()
    : (task.prompt || '');
  const execOutputs = {};
  activeModels.forEach((m) => {
    const outEl = $(`#exec-out-${m.slot}`);
    if (outEl && !outEl.classList.contains('hidden') && outEl.textContent && outEl.textContent.trim()) {
      execOutputs[m.slot] = outEl.textContent.trim();
    }
  });

  const btn = triggerBtn || $('#exportPdfBtn') || $('#exportPdfScorecardBtn') || $('#exportPdfTopBtn');
  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Exporting PDF…';
  }
  try {
    const resp = await fetch('/api/export-pdf', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: _currentRunId || undefined,
        taskId: task.id,
        taskTitle: task.title || 'Custom prompt',
        prompt: promptText,
        models: activeModels,
        results: LAST_RESULTS,
        judge: _judgeScored || null,
        execOutputs,
        at: Date.now(),
      }),
    });
    if (resp.status === 401) { window.location.replace('/login'); return; }
    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      throw new Error(errJson.error || `PDF export failed (${resp.status}).`);
    }
    const blob = await resp.blob();
    const fname = filenameFromDisposition(
      resp.headers.get('content-disposition'),
      `llm-compare-${(task.id || 'report')}-${new Date().toISOString().slice(0, 10)}.pdf`
    );
    downloadBlob(blob, fname);
    if (btn) {
      btn.textContent = '✓ Downloaded PDF';
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = origText;
      }, 1600);
      return;
    }
  } catch (e) {
    window.alert(e.message || 'Could not export PDF.');
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function exportHistoryRunPdf(id, triggerBtn) {
  if (!id) return;
  const origHtml = triggerBtn ? triggerBtn.innerHTML : '';
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.innerHTML = '⏳';
  }
  try {
    const resp = await fetch('/api/history/' + encodeURIComponent(id) + '/pdf', { credentials: 'same-origin' });
    if (resp.status === 401) { window.location.replace('/login'); return; }
    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      throw new Error(errJson.error || `Failed to export PDF (${resp.status}).`);
    }
    const blob = await resp.blob();
    const fname = filenameFromDisposition(resp.headers.get('content-disposition'), `llm-compare-${id}.pdf`);
    downloadBlob(blob, fname);
    if (triggerBtn) {
      triggerBtn.innerHTML = '✓';
      setTimeout(() => {
        triggerBtn.disabled = false;
        triggerBtn.innerHTML = origHtml;
      }, 1400);
      return;
    }
  } catch (e) {
    window.alert(e.message || 'Could not export PDF.');
  }
  if (triggerBtn) {
    triggerBtn.disabled = false;
    triggerBtn.innerHTML = origHtml;
  }
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
  if (r.code != null) setCode(slot, r.code, true);
  setThink(slot, r.reasoning, r.reasoningTokens != null ? r.reasoningTokens : null);
  // saved/finished view: show code & reasoning from the top, not the streamed bottom
  { const cp = $(`#code-${slot}`); if (cp && cp.parentElement) cp.parentElement.scrollTop = 0;
    const md = $(`#md-${slot}`); if (md) md.scrollTop = 0;
    const tp = document.querySelector(`#think-${slot}`); if (tp && tp.parentElement) tp.parentElement.scrollTop = 0; }
  const thinkTok = r.reasoningTokens || 0;
  setTileVal(slot, 'tok', fmtInt(Math.max(0, r.completionTokens - thinkTok)));
  setTileVal(slot, 'think', fmtInt(thinkTok));
  setTileVal(slot, 'tps', r.tokensPerSec);
  setTileVal(slot, 'cost', fmtCost(r.costUsd));
  setTileVal(slot, 'time', (r.wallMs / 1000).toFixed(1) + 's');
  if (r.total) {
    const pf = $(`#pf-${slot}`);
    const pl = $(`#pl-${slot}`);
    if (pf) pf.style.width = Math.round((r.passed / r.total) * 100) + '%';
    if (pl) pl.textContent = `${r.passed} / ${r.total} tests`;
  } else {
    const pf = $(`#pf-${slot}`);
    const pl = $(`#pl-${slot}`);
    if (pf) pf.style.width = '100%';
    if (pl) pl.textContent = 'generated · no automated tests';
  }
  const secs = (r.wallMs / 1000).toFixed(1);
  setStatus(slot, r.total === 0 ? `Done · ${secs}s` : (r.solved ? `Solved · ${secs}s` : `Finished ${r.correctness}% · ${secs}s`), 'done');
  { const rb = document.querySelector(`.rerun-btn[data-slot="${slot}"]`); if (rb) rb.disabled = false; }
  if ((currentTask().executable || currentTask().visualizer === 'hanoi') && r.code) {
    const eb = document.querySelector(`.exec-btn[data-slot="${slot}"]`);
    if (eb) eb.disabled = false;
    if (currentTask().visualizer === 'hanoi') {
      renderHanoiInBrowser(slot, r.code);
    }
  }
  if (isCadActiveTask() && r.code) {
    const eb = document.querySelector(`.exec-btn[data-slot="${slot}"]`);
    if (eb) eb.disabled = false;
    const auto = $('#autoRun');
    if (!auto || auto.classList.contains('is-on')) {
      runCad3dViewport(slot, r.code);
    }
  }
}


// ---------- full-page preview (magnifying glass) ----------
function modelLabel(slot) {
  const m = (ARENA_MODELS || MODELS).find((x) => x.slot === slot) || MODELS.find((x) => x.slot === slot);
  return (m && m.label) || ('Model ' + slot);
}

function ensureModal() {
  let modal = $('#mdModal');
  if (modal) return modal;
  modal = el('div', 'md-modal hidden');
  modal.id = 'mdModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
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
function closeModal() {
  const m = $('#mdModal');
  if (m && !m.classList.contains('hidden')) {
    m.classList.add('hidden');
    deactivateModalFocus();
  }
}

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
  activateModalFocus(modal, '.md-modal-close');
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

// ===========================================================================
// v1.0.9 — IMAGE & GENMEDIA ARENA (Vertex AI Nano Banana 2 vs 2.1)
// ===========================================================================
let ACTIVE_ARENA_MODE = 'text'; // 'text' | 'image'
let IMG_CONFIG = null;
let IMG_SLOTS = [
  { slot: 'A', catalogId: 'gemini-3.1-flash-image' },
  { slot: 'B', catalogId: 'gemini-nano-banana-2.1' },
];
let IMG_SELECTED_SIZE = '2K';
let IMG_SELECTED_ASPECT = '16:9';
let IMG_REF_ATTACHMENTS = []; // [{ name, mimeType, label, data (base64) }]
let IMG_CURRENT_SCENARIO_REFS = [];
let IMG_LAST_RESULTS = [];
let IMG_SPLIT_CURTAIN_ON = false;
let IMG_CURTAIN_POS = 50;      // divider position, % of stage width
let IMG_CURTAIN_PICKS = null;  // { left, right } layer ids the user chose explicitly
let IMG_RUNNING = false;
let IMG_TIMER_ID = null;

function switchArenaMode(mode, { updateUrl = true, initialBoot = false, skipInterruptCheck = false } = {}) {
  const target = (mode === 'image' || mode === 'video' || mode === '3d') ? mode : 'text';
  const prevMode = ACTIVE_ARENA_MODE;
  // Switching tabs rebuilds the text arena (and drops CAD viewport state): a
  // comparison still streaming has to be stopped explicitly first (1.1).
  if (!skipInterruptCheck && !initialBoot && (prevMode === 'text' || prevMode === '3d') && target !== prevMode) {
    if (!confirmInterruptRun('A comparison is still running. Stop it and switch arenas?')) return;
  }
  ACTIVE_ARENA_MODE = target;
  // Leaving the 3D arena: forget per-slot CAD code / telemetry / 4-view renders so
  // they can never be attached to a later text run or a restored run (1.7).
  if (prevMode === '3d' && target !== '3d' && typeof resetAllCadSlotStates === 'function') resetAllCadSlotStates();
  // Switching between Text Arena and 3D & CAD Arena: clear stale results, scorecard, and judge output
  // from the previous arena so they never bleed into the newly selected arena.
  if (!initialBoot && prevMode !== target && (prevMode === 'text' || prevMode === '3d') && (target === 'text' || target === '3d')) {
    LAST_RESULTS = {};
    _lastScored = null;
    _judgeScored = null;
    const sc = $('#scorecard');
    if (sc) sc.classList.add('hidden');
    const jb = $('#jumpScorecardBtn');
    if (jb) jb.classList.add('hidden');
    const pb = $('#exportPdfTopBtn');
    if (pb) pb.classList.add('hidden');
    const jo = $('#judgeOut');
    if (jo) jo.innerHTML = '';
  }

  const textBtn = $('#modeBtnText');
  const cadBtn = $('#modeBtn3d');
  const imgBtn = $('#modeBtnImage');
  const vidBtn = $('#modeBtnVideo');
  if (textBtn) textBtn.classList.toggle('active', target === 'text');
  if (cadBtn) cadBtn.classList.toggle('active', target === '3d');
  if (imgBtn) imgBtn.classList.toggle('active', target === 'image');
  if (vidBtn) vidBtn.classList.toggle('active', target === 'video');

  const textControls = document.querySelector('section.controls:not(.image-controls-panel)');
  const textArena = $('#arena');
  const textScorecard = $('#scorecard');
  const imgSection = $('#imageArenaSection');
  const vidSection = $('#videoArenaSection');

  if (target === 'image') {
    if (textControls) textControls.classList.add('hidden');
    if (textArena) textArena.classList.add('hidden');
    if (textScorecard) textScorecard.classList.add('hidden');
    if (vidSection) vidSection.classList.add('hidden');
    if (imgSection) imgSection.classList.remove('hidden');
    if (typeof syncCadModifyBarVisibility === 'function') syncCadModifyBarVisibility();
    ensureImageArenaLoaded();
    updateImageHistoryButton();
  } else if (target === 'video') {
    if (textControls) textControls.classList.add('hidden');
    if (textArena) textArena.classList.add('hidden');
    if (textScorecard) textScorecard.classList.add('hidden');
    if (imgSection) imgSection.classList.add('hidden');
    if (vidSection) vidSection.classList.remove('hidden');
    if (typeof syncCadModifyBarVisibility === 'function') syncCadModifyBarVisibility();
  } else {
    if (imgSection) imgSection.classList.add('hidden');
    if (vidSection) vidSection.classList.add('hidden');
    if (textControls) textControls.classList.remove('hidden');
    if (textArena) textArena.classList.remove('hidden');

    if (CONFIG) {
      populateCategorySelect(target);
      const cs = $('#categorySelect');
      const curTask = currentTask();
      if (target === '3d') {
        if (curTask.category !== 'cad3d' && (!isCustomTaskSelected() || prevMode !== '3d' || initialBoot)) {
          const defCat = 'cad3d-automotive';
          if (cs) cs.value = defCat;
          populateSubcategorySelect(defCat, 'complex');
          populateTaskSelect(defCat, 'cad-planetary-gearbox');
          renderTaskPrompt();
          buildArena();
        } else {
          renderTaskPrompt();
          buildArena();
        }
      } else if (target === 'text' && prevMode === '3d') {
        if (cs && isCadCategoryKey(cs.value)) {
          cs.value = 'custom';
          populateSubcategorySelect('custom');
          populateTaskSelect('custom', 'custom');
        }
        renderTaskPrompt();
        buildArena();
      }
    }
    if (typeof syncCadModifyBarVisibility === 'function') syncCadModifyBarVisibility();
    if (textScorecard && Object.keys(LAST_RESULTS || {}).length > 0) {
      textScorecard.classList.remove('hidden');
    }
  }

  if (updateUrl && window.history && typeof window.history.replaceState === 'function') {
    try {
      const url = new URL(window.location.href);
      if (target === 'image' || target === 'video' || target === '3d') url.searchParams.set('tab', target);
      else url.searchParams.delete('tab');
      window.history.replaceState({}, '', url.toString());
    } catch (_) { /* ignore */ }
  }
}

let _imgConfigPromise = null;
async function ensureImageArenaLoaded() {
  if (IMG_CONFIG) return IMG_CONFIG;
  if (_imgConfigPromise) return _imgConfigPromise;
  _imgConfigPromise = (async () => {
    try {
      const resp = await fetch('/api/image-arena/config', { credentials: 'same-origin' });
      if (resp.status === 401) { window.location.replace('/login'); return null; } // session expired mid-use
      const data = await resp.json();
      if (!data || !data.ok) return null;
      IMG_CONFIG = data;
      if (Array.isArray(data.defaultSlots) && data.defaultSlots.length) {
        IMG_SLOTS = data.defaultSlots.map((s) => ({ ...s }));
      }
      renderImageSizeAndAspectPills();
      renderImageSlotsConfigurator();
      populateImagePacksAndScenarios();
      renderImageArenaPlaceholderCards();
      renderImageMetricComparison();
      renderImageEconomicsModeler();
      updateImageHistoryButton();
      return IMG_CONFIG;
    } catch (e) {
      console.warn('[imageArena] failed to load config:', e);
      return null;
    } finally {
      _imgConfigPromise = null;
    }
  })();
  return _imgConfigPromise;
}

function getImgCatalogItem(id) {
  const cat = (IMG_CONFIG && IMG_CONFIG.catalog) || [];
  return cat.find((m) => m.id === id || m.model === id) || cat[0] || null;
}

// Image history can hold runs from models that have since left the catalog (retired
// models). Their outputs are skipped in the History modal and on restore.
function isCurrentImageModel(catalogId) {
  const cat = IMG_CONFIG && IMG_CONFIG.catalog;
  return !Array.isArray(cat) || cat.some((m) => m.id === catalogId);
}

function currentModelImageResults(run) {
  return ((run && run.results) || []).filter((x) => x && isCurrentImageModel(x.catalogId));
}

// Hide runs whose every result came from a retired model; runs with no results still show.
function isVisibleImageRun(run) {
  const all = (run && run.results) || [];
  return all.length === 0 || currentModelImageResults(run).length > 0;
}

function hasOffPeakModelSelected() {
  return IMG_SLOTS.some((s) => {
    const c = getImgCatalogItem(s.catalogId);
    return !!(c && c.pricing && c.pricing.offPeakDiscount > 0);
  });
}

function hasLiveImageResults() {
  return !IMG_RUNNING && Array.isArray(IMG_LAST_RESULTS) && IMG_LAST_RESULTS.some((r) => r && r.ok);
}

// ---------- Full-Screen Image Lightbox Modal (Input References & Generated Outputs) ----------
let IMG_LIGHTBOX_ITEMS = [];
let IMG_LIGHTBOX_IDX = 0;
let IMG_LIGHTBOX_PIXELATED = false;
let IMG_LIGHTBOX_ACTUAL_SIZE = false;

function openImageLightbox(items, startIndex = 0) {
  if (!Array.isArray(items) || !items.length) return;
  const modal = $('#imgLightboxModal');
  if (!modal) return;
  IMG_LIGHTBOX_ITEMS = items;
  IMG_LIGHTBOX_IDX = Math.max(0, Math.min(items.length - 1, Number(startIndex) || 0));
  const first = IMG_LIGHTBOX_ITEMS[IMG_LIGHTBOX_IDX];
  IMG_LIGHTBOX_PIXELATED = Boolean(first && first.defaultPixelated);
  IMG_LIGHTBOX_ACTUAL_SIZE = false;
  modal.classList.remove('hidden');
  renderImageLightboxCurrent();
  activateModalFocus(modal, '#imgLightboxCloseBtn');
}

function closeImageLightbox() {
  const modal = $('#imgLightboxModal');
  if (modal && !modal.classList.contains('hidden')) {
    modal.classList.add('hidden');
    deactivateModalFocus();
  }
}

function stepImageLightbox(delta) {
  if (!IMG_LIGHTBOX_ITEMS.length) return;
  IMG_LIGHTBOX_IDX = (IMG_LIGHTBOX_IDX + delta + IMG_LIGHTBOX_ITEMS.length) % IMG_LIGHTBOX_ITEMS.length;
  renderImageLightboxCurrent();
}

function applyLightboxSizing() {
  const stageEl = $('#imgLightboxStage') || document.querySelector('.img-lightbox-stage');
  const imgEl = $('#imgLightboxImg');
  const actualBtn = $('#imgLightboxActualSizeBtn');
  const nw = (imgEl && imgEl.naturalWidth) || 0;
  const nh = (imgEl && imgEl.naturalHeight) || 0;

  if (actualBtn) {
    const dimsSuffix = (nw && nh) ? ` (${nw}×${nh})` : '';
    actualBtn.textContent = IMG_LIGHTBOX_ACTUAL_SIZE
      ? '🗖 Fit to Screen'
      : `🔎 1:1 Full Size${dimsSuffix}`;
    actualBtn.classList.toggle('is-on', IMG_LIGHTBOX_ACTUAL_SIZE);
  }

  if (stageEl) {
    stageEl.classList.toggle('is-actual-size', IMG_LIGHTBOX_ACTUAL_SIZE);
    stageEl.title = 'Click anywhere to close preview';
  }

  if (imgEl) {
    imgEl.classList.toggle('is-actual-size', IMG_LIGHTBOX_ACTUAL_SIZE);
    if (IMG_LIGHTBOX_ACTUAL_SIZE && nw > 0 && nh > 0) {
      imgEl.style.cssText = `width:${nw}px;height:${nh}px;max-width:none !important;max-height:none !important;object-fit:unset;cursor:zoom-out;margin:auto;display:block;flex-shrink:0`;
      imgEl.title = 'Click anywhere to close preview';
    } else if (nw > 0 && nw <= 512 && nh <= 512) {
      imgEl.style.cssText = 'width:min(100%, 720px);height:min(100%, 640px);max-width:100%;max-height:100%;object-fit:contain;cursor:zoom-out;margin:auto;display:block';
      imgEl.title = 'Click anywhere to close preview';
    } else {
      imgEl.style.cssText = 'width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;cursor:zoom-out;margin:auto;display:block';
      imgEl.title = 'Click anywhere to close preview';
    }
  }
}

function openCurrentLightboxImageInNewTab() {
  const item = IMG_LIGHTBOX_ITEMS[IMG_LIGHTBOX_IDX];
  if (!item || !item.url) return;
  try {
    const m = /^data:([^;]+);base64,(.+)$/.exec(item.url);
    if (m) {
      const mime = m[1] || 'image/png';
      const bstr = window.atob(m[2]);
      const u8 = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      const blob = new Blob([u8], { type: mime });
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank', 'noopener');
      // The new tab has loaded the bytes long before this fires; without it every
      // click pins another 5-25 MB blob to this document for its whole lifetime (2.10).
      setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch (_) { /* ignore */ } }, 60000);
      return;
    }
    window.open(item.url, '_blank', 'noopener');
  } catch (_) {
    window.open(item.url, '_blank', 'noopener');
  }
}

function renderImageLightboxCurrent() {
  const item = IMG_LIGHTBOX_ITEMS[IMG_LIGHTBOX_IDX];
  if (!item) return;
  const badgeEl = $('#imgLightboxBadge');
  const titleEl = $('#imgLightboxTitle');
  const metaEl = $('#imgLightboxMeta');
  const imgEl = $('#imgLightboxImg');
  const dlBtn = $('#imgLightboxDownloadBtn');
  const prevBtn = $('#imgLightboxPrevBtn');
  const nextBtn = $('#imgLightboxNextBtn');
  const pxBtn = $('#imgLightboxPixelModeBtn');

  if (badgeEl) badgeEl.textContent = item.badge || `Image ${IMG_LIGHTBOX_IDX + 1} of ${IMG_LIGHTBOX_ITEMS.length}`;
  if (titleEl) titleEl.textContent = item.title || 'Image Preview';
  if (metaEl) metaEl.textContent = item.meta || '';
  if (prevBtn) prevBtn.classList.toggle('hidden', IMG_LIGHTBOX_ITEMS.length < 2);
  if (nextBtn) nextBtn.classList.toggle('hidden', IMG_LIGHTBOX_ITEMS.length < 2);

  if (pxBtn) {
    pxBtn.textContent = IMG_LIGHTBOX_PIXELATED ? '✨ Smooth View' : '🔳 Crisp Pixels';
    pxBtn.classList.toggle('is-on', IMG_LIGHTBOX_PIXELATED);
  }

  if (dlBtn) {
    dlBtn.href = item.url || '#';
    dlBtn.download = item.downloadName || 'image-preview.png';
  }

  if (imgEl) {
    imgEl.classList.toggle('is-pixelated', IMG_LIGHTBOX_PIXELATED);
    imgEl.onload = () => {
      if (imgEl.naturalWidth && imgEl.naturalHeight && metaEl) {
        const dimPrefix = `${imgEl.naturalWidth}×${imgEl.naturalHeight} px`;
        const baseMeta = item.meta || '';
        metaEl.textContent = baseMeta.includes(dimPrefix)
          ? baseMeta
          : (baseMeta ? `${dimPrefix} · ${baseMeta}` : dimPrefix);
      }
      applyLightboxSizing();
    };
    imgEl.src = item.url || '';
    imgEl.alt = item.title || 'Enlarged preview';
    applyLightboxSizing();
  }
}

function openReferenceLightboxAt(idx) {
  if (!IMG_REF_ATTACHMENTS.length) return;
  const items = IMG_REF_ATTACHMENTS.map((att, i) => {
    const cleanB64 = String(att.data || '').replace(/^data:[^;]+;base64,/, '');
    const kb = Math.max(1, Math.round((cleanB64.length * 3) / 4 / 1024));
    const url = `data:${att.mimeType || 'image/png'};base64,${cleanB64}`;
    const isLowResSample = /lowres|160x120|thumb/i.test(`${att.id || ''} ${att.name || ''} ${att.label || ''}`);
    return {
      badge: `Input Ref #${i + 1} of ${IMG_REF_ATTACHMENTS.length}`,
      title: att.label || att.name || `Reference Image #${i + 1}`,
      meta: `${kb} KB · ${att.mimeType || 'image/png'}`,
      url,
      downloadName: att.name || `reference-${i + 1}.png`,
      defaultPixelated: isLowResSample,
    };
  });
  openImageLightbox(items, idx);
}

function openGeneratedOutputLightboxAt(slotId) {
  const ok = (IMG_LAST_RESULTS || []).filter((r) => r && r.ok && r.imageDataUrl);
  if (!ok.length) return;
  const items = ok.map((r) => {
    const dimsStr = (r.width && r.height) ? `${r.width}×${r.height}` : r.requestedSize;
    const mpStr = r.megapixels != null ? `${r.megapixels} MP` : '';
    const stage = $(`#img-stage-${r.slot}`);
    const displayedImg = stage && stage.querySelector('img.img-main-output');
    const currentUrl = (displayedImg && displayedImg.src) || r.imageDataUrl;
    const isShowingThought = r.thoughtImageDataUrl && currentUrl === r.thoughtImageDataUrl;
    return {
      slot: r.slot,
      badge: `Slot ${r.slot} · ${r.shortLabel || r.label}`,
      title: isShowingThought
        ? `${r.label} — 1K Visual Thinking Draft`
        : `${r.label} — Final ${dimsStr} Output`,
      meta: `${dimsStr}${mpStr ? ' (' + mpStr + ')' : ''} · ${((r.latencyMs || 0) / 1000).toFixed(1)}s · PayGo ${fmtCost(r.standardPayGoCostUsd)}`,
      url: currentUrl,
      downloadName: `${r.model}-${dimsStr}-${Date.now()}.png`,
      defaultPixelated: false,
    };
  });
  const startIdx = Math.max(0, items.findIndex((it) => it.slot === slotId));
  openImageLightbox(items, startIdx);
}

function renderImageSizeAndAspectPills() {
  const sizeWrap = $('#imgSizePills');
  const aspectWrap = $('#imgAspectPills');
  if (!IMG_CONFIG) return;

  if (sizeWrap) {
    sizeWrap.innerHTML = '';
    (IMG_CONFIG.resolutions || []).forEach((r) => {
      const b = el('button', 'img-seg-btn' + (r.id === IMG_SELECTED_SIZE ? ' active' : ''));
      b.type = 'button';
      b.textContent = r.label;
      b.title = r.description || r.label;
      b.addEventListener('click', () => {
        if (IMG_RUNNING) return; // size is captured at run start; frozen until it finishes (1.5)
        IMG_SELECTED_SIZE = r.id;
        renderImageSizeAndAspectPills();
        renderImageSlotsConfigurator();
        if (!IMG_LAST_RESULTS.length) renderImageArenaPlaceholderCards();
        renderImageMetricComparison();
        renderImageEconomicsModeler();
      });
      b.disabled = IMG_RUNNING;
      sizeWrap.appendChild(b);
    });
  }

  if (aspectWrap) {
    aspectWrap.innerHTML = '';
    (IMG_CONFIG.aspectRatios || []).forEach((a) => {
      const b = el('button', 'img-seg-btn' + (a.id === IMG_SELECTED_ASPECT ? ' active' : ''));
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', () => {
        if (IMG_RUNNING) return; // frozen during a run (1.5)
        IMG_SELECTED_ASPECT = a.id;
        renderImageSizeAndAspectPills();
        if (!IMG_LAST_RESULTS.length) renderImageArenaPlaceholderCards();
      });
      b.disabled = IMG_RUNNING;
      aspectWrap.appendChild(b);
    });
  }
}

function renderImageSlotsConfigurator() {
  const grid = $('#imgSlotGrid');
  const badge = $('#imgSlotCountBadge');
  const addBtn = $('#imgAddSlotBtn');
  if (!grid || !IMG_CONFIG) return;

  const catalog = IMG_CONFIG.catalog || [];
  const maxActiveSlots = Math.min(4, Math.max(1, catalog.length));
  updateQuotaBadge(); // the image badge reflects which budgets this lineup uses

  if (badge) badge.textContent = `${IMG_SLOTS.length} of ${maxActiveSlots} active`;
  if (addBtn) {
    addBtn.textContent = IMG_SLOTS.length >= maxActiveSlots ? `Max ${maxActiveSlots} models` : '+ Add model';
    addBtn.disabled = IMG_SLOTS.length >= maxActiveSlots;
  }

  // Highlight active Image Arena lineup preset button (`nb2-vs-21`, `lite-2-21`, `all-four`)
  const currentIdsSig = IMG_SLOTS.map((s) => s.catalogId).join(',');
  const presetMap = {
    'nb2-vs-21': 'gemini-3.1-flash-image,gemini-nano-banana-2.1',
    'lite-2-21': 'gemini-3.1-flash-lite-image,gemini-3.1-flash-image,gemini-nano-banana-2.1',
    'all-four': 'gemini-3.1-flash-lite-image,gemini-3.1-flash-image,gemini-nano-banana-2.1,gemini-3-pro-image',
  };
  document.querySelectorAll('.img-preset-btn').forEach((btn) => {
    const p = btn.dataset.imgPreset;
    btn.classList.toggle('is-active', Boolean(presetMap[p] && presetMap[p] === currentIdsSig));
  });

  // Dynamically update #imgEndpointPill if OpenAI GPT Image models are in the lineup
  const epPill = $('#imgEndpointPill');
  if (epPill) {
    const hasOpenAi = IMG_SLOTS.some((s) => {
      const e = getImgCatalogItem(s.catalogId);
      return e && e.provider === 'openai';
    });
    const hasVertex = IMG_SLOTS.some((s) => {
      const e = getImgCatalogItem(s.catalogId);
      return !e || e.provider !== 'openai';
    });
    if (hasOpenAi && hasVertex) {
      epPill.innerHTML = '☁️ Vertex AI <code>/locations/global</code> + OpenAI Images API · Up to 13 Reference Images';
    } else if (hasOpenAi) {
      epPill.innerHTML = '🔑 OpenAI Images API (<code>/v1/images</code>) · Up to 13 Reference Images';
    } else {
      epPill.innerHTML = '☁️ Vertex AI <code>/locations/global</code> · 64K Context · Up to 13 Reference Images';
    }
  }

  grid.innerHTML = '';
  grid.dataset.slotCount = String(IMG_SLOTS.length);
  grid.style.setProperty('--slot-count', String(Math.max(1, IMG_SLOTS.length)));
  grid.style.setProperty('--img-slot-count', String(Math.max(1, IMG_SLOTS.length)));

  IMG_SLOTS.forEach((slotObj, idx) => {
    const entry = getImgCatalogItem(slotObj.catalogId) || catalog[0];
    if (!entry) return;
    const color = slotColor(slotObj.slot);
    const refPrice = (entry.pricing && entry.pricing.referenceCostBySize && entry.pricing.referenceCostBySize[IMG_SELECTED_SIZE]) || 0.05;
    const offPeakPrice = entry.pricing && entry.pricing.offPeakDiscount > 0
      ? refPrice * (1 - entry.pricing.offPeakDiscount)
      : null;
    const slaCls = entry.slaPct >= 99.5 ? 'is-sla-995' : 'is-sla-95';

    const card = el('div', 'slot-cfg-card img-slot-card');
    card.style.setProperty('--slot-accent', color);
    card.innerHTML = `
      <div class="scc-head">
        <span class="scc-slot-badge" style="background:${color}22;color:${color};border-color:${color}55">Slot ${esc(slotObj.slot)}</span>
        <span class="scc-ic">${modelIconSvg(entry)}</span>
        <strong class="scc-name">${esc(entry.label)}</strong>
        ${providerBadgeHtml(entry)}
        <span class="scc-price">~${fmtCost(refPrice)}/img</span>
        ${IMG_SLOTS.length > 1 ? `<button type="button" class="scc-remove ca-remove" data-slot="${esc(slotObj.slot)}" title="Remove Slot ${esc(slotObj.slot)}">&times;</button>` : ''}
      </div>
      ${buildProviderModelCascadingControlsHtml({
        slot: slotObj.slot,
        currentItem: entry,
        catalogItems: catalog,
        providerSelectClass: 'slot-provider-select col-inline-select col-prov-sel img-provider-select',
        modelSelectClass: 'slot-model-select col-inline-select col-mod-sel img-slot-select',
      })}
      <div class="img-slot-badges">
        <span class="img-mini-pill ${slaCls}">${esc(entry.slaBadge)}</span>
        <span class="img-mini-pill">${esc(entry.endpointBadge)}</span>
        <span class="img-mini-pill">PayGo ~${fmtCost(refPrice)}/img</span>
        ${offPeakPrice != null ? `<span class="img-mini-pill is-save">Off-Peak ~${fmtCost(offPeakPrice)}/img (-50%)</span>` : ''}
      </div>
    `;

    const rm = card.querySelector('.scc-remove');
    if (rm) {
      rm.addEventListener('click', () => {
        if (IMG_RUNNING) return; // lineup is frozen while images are generating (1.5)
        IMG_SLOTS.splice(idx, 1);
        IMG_SLOTS.forEach((s, i) => { s.slot = String.fromCharCode(65 + i); });
        IMG_LAST_RESULTS = [];
        renderImageSlotsConfigurator();
        renderImageArenaPlaceholderCards();
        updateSplitCurtainView();
        renderImageMetricComparison();
        renderImageEconomicsModeler();
      });
    }

    const provSel = card.querySelector('.img-provider-select');
    if (provSel) {
      provSel.addEventListener('change', () => {
        if (IMG_RUNNING) { provSel.value = providerFamilyOf(entry); return; } // frozen during a run (1.5)
        const fam = provSel.value;
        const firstModel = catalog.find((x) => providerFamilyOf(x) === fam && modelAvailability(x).ok)
          || catalog.find((x) => providerFamilyOf(x) === fam);
        if (firstModel) {
          slotObj.catalogId = firstModel.id;
          IMG_LAST_RESULTS = [];
          renderImageSlotsConfigurator();
          renderImageArenaPlaceholderCards();
          updateSplitCurtainView();
          renderImageMetricComparison();
          renderImageEconomicsModeler();
        }
      });
    }

    const sel = card.querySelector('.img-slot-select');
    if (sel) {
      sel.addEventListener('change', () => {
        if (IMG_RUNNING) { sel.value = slotObj.catalogId; return; } // frozen during a run (1.5)
        slotObj.catalogId = sel.value;
        IMG_LAST_RESULTS = [];
        renderImageSlotsConfigurator();
        renderImageArenaPlaceholderCards();
        updateSplitCurtainView();
        renderImageMetricComparison();
        renderImageEconomicsModeler();
      });
    }

    grid.appendChild(card);
  });
  // A re-render during a run must keep the lineup frozen (1.5).
  if (IMG_RUNNING) setImageArenaControlsDisabled(true);
}

// Disable every control that would desync IMG_SLOTS / cards / results while a
// generation is in flight (slot model selects, remove, add, presets, size and
// aspect pills, scenario pickers). Re-enabled in the run's finally (1.5).
function setImageArenaControlsDisabled(disabled) {
  const sel = '#imgSlotGrid select, #imgSlotGrid .ca-remove, #imgAddSlotBtn, .img-preset-btn, ' +
    '#imgSizePills button, #imgAspectPills button, #imgPackSelect, #imgSubcategorySelect, #imgScenarioSelect';
  document.querySelectorAll(sel).forEach((n) => { n.disabled = !!disabled; });
  if (!disabled) {
    // Restore the data-driven state of the Add button once the lock lifts.
    const addBtn = $('#imgAddSlotBtn');
    const catalog = (IMG_CONFIG && IMG_CONFIG.catalog) || [];
    const maxActiveSlots = Math.min(4, Math.max(1, catalog.length || 4));
    if (addBtn) addBtn.disabled = IMG_SLOTS.length >= maxActiveSlots;
  }
  const grid = $('#imgSlotGrid');
  if (grid) grid.classList.toggle('is-locked', !!disabled);
}

function populateImagePacksAndScenarios() {
  const packSel = $('#imgPackSelect');
  const subSel = $('#imgSubcategorySelect');
  const subSep = $('#imgSubcategorySep');
  const scSel = $('#imgScenarioSelect');
  if (!packSel || !scSel || !IMG_CONFIG) return;

  const packs = IMG_CONFIG.packs || [];
  packSel.innerHTML = '';
  packs.forEach((p) => {
    const o = el('option');
    o.value = p.id;
    o.textContent = p.title;
    packSel.appendChild(o);
  });

  const populateImgScenariosForSubcat = (pack, subcatId, preferredScenarioId) => {
    if (!pack) return;
    const badge = $('#imgScenarioBadge');
    if (badge) badge.textContent = pack.badge || 'Image Benchmark';
    const allSc = pack.scenarios || [];
    const filteredSc = (subcatId && Array.isArray(pack.subcategories) && pack.subcategories.length > 0 && allSc.some((s) => s.subcategory === subcatId))
      ? allSc.filter((s) => s.subcategory === subcatId)
      : allSc;
    scSel.innerHTML = '';
    filteredSc.forEach((s) => {
      const o = el('option');
      o.value = s.id;
      o.textContent = s.title;
      scSel.appendChild(o);
    });
    const chosen = (preferredScenarioId && filteredSc.find((s) => s.id === preferredScenarioId)) || filteredSc[0] || allSc[0];
    if (chosen) {
      scSel.value = chosen.id;
      applyImageScenario(pack, chosen);
    }
  };

  const updateScenariosForPack = (packId, preferredSubcatId, preferredScenarioId) => {
    const pack = packs.find((p) => p.id === packId) || packs[0];
    if (!pack) return;
    const subs = Array.isArray(pack.subcategories) ? pack.subcategories : [];
    if (subSel) {
      subSel.innerHTML = '';
      if (subs.length > 0) {
        subs.forEach((sub) => {
          const o = el('option');
          o.value = sub.id;
          o.textContent = sub.label;
          subSel.appendChild(o);
        });
        if (preferredSubcatId && subs.some((s) => s.id === preferredSubcatId)) {
          subSel.value = preferredSubcatId;
        } else {
          subSel.value = subs[0].id;
        }
        subSel.classList.remove('hidden');
        if (subSep) subSep.classList.remove('hidden');
      } else {
        subSel.classList.add('hidden');
        if (subSep) subSep.classList.add('hidden');
      }
    }
    const activeSub = (subSel && !subSel.classList.contains('hidden')) ? subSel.value : '';
    populateImgScenariosForSubcat(pack, activeSub, preferredScenarioId);
  };

  packSel.onchange = () => updateScenariosForPack(packSel.value);
  if (subSel) {
    subSel.onchange = () => {
      const pack = packs.find((p) => p.id === packSel.value) || packs[0];
      populateImgScenariosForSubcat(pack, subSel.value);
    };
  }
  scSel.onchange = () => {
    const pack = packs.find((p) => p.id === packSel.value) || packs[0];
    const sc = (pack && pack.scenarios || []).find((s) => s.id === scSel.value);
    if (sc) applyImageScenario(pack, sc);
  };

  updateScenariosForPack(packs[0] && packs[0].id);
}

function applyImageScenario(pack, sc) {
  const promptEl = $('#imgPromptInput');
  const whyEl = $('#imgWhyBanner');
  const badgeEl = $('#imgScenarioBadge');

  if (badgeEl) badgeEl.textContent = sc.badge || (pack && pack.badge) || 'GenMedia';
  if (promptEl) promptEl.value = sc.prompt || '';
  if (whyEl) {
    if (sc.whyItMatters) {
      whyEl.textContent = sc.whyItMatters;
      whyEl.classList.remove('hidden');
    } else {
      whyEl.classList.add('hidden');
    }
  }

  if (sc.recommendedSize && ['1K', '2K', '4K'].includes(sc.recommendedSize)) {
    IMG_SELECTED_SIZE = sc.recommendedSize;
  }
  if (sc.recommendedAspectRatio) {
    IMG_SELECTED_ASPECT = sc.recommendedAspectRatio;
  }

  IMG_CURRENT_SCENARIO_REFS = Array.isArray(sc.attachments) ? sc.attachments.map((a) => ({ ...a })) : [];
  IMG_REF_ATTACHMENTS = IMG_CURRENT_SCENARIO_REFS.map((a) => ({ ...a }));
  IMG_LAST_RESULTS = [];
  markImageComposerApplied();
  renderImageReferenceAttachments();
  renderImageSizeAndAspectPills();
  renderImageSlotsConfigurator();
  renderImageArenaPlaceholderCards();
  updateSplitCurtainView();
  renderImageMetricComparison();
  renderImageEconomicsModeler();
}

// Image Arena composer pristine/dirty tracking (prompt text + reference images last
// applied by a scenario or a History restore), mirroring the text composer (1.6).
let IMG_COMPOSER_APPLIED = { prompt: '', refCount: 0 };
function markImageComposerApplied() {
  const p = $('#imgPromptInput');
  IMG_COMPOSER_APPLIED = { prompt: p ? String(p.value || '') : '', refCount: Array.isArray(IMG_REF_ATTACHMENTS) ? IMG_REF_ATTACHMENTS.length : 0 };
}
function imageComposerIsDirty() {
  const p = $('#imgPromptInput');
  const text = p ? String(p.value || '') : '';
  if (text.trim() !== String(IMG_COMPOSER_APPLIED.prompt || '').trim()) return true;
  const n = Array.isArray(IMG_REF_ATTACHMENTS) ? IMG_REF_ATTACHMENTS.length : 0;
  return n !== IMG_COMPOSER_APPLIED.refCount;
}

function aspectRatioCssValue(aspectStr, w, h) {
  const nw = Number(w);
  const nh = Number(h);
  if (nw > 0 && nh > 0) return `${nw} / ${nh}`;
  const m = String(aspectStr || '16:9').trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (m) return `${m[1]} / ${m[2]}`;
  return '16 / 9';
}

function syncSplitCurtainButtonState() {
  const btn = $('#imgSplitCurtainBtn');
  if (!btn) return;
  const hasRef = Array.isArray(IMG_REF_ATTACHMENTS) && IMG_REF_ATTACHMENTS.length > 0;
  if (!hasRef && IMG_SPLIT_CURTAIN_ON) {
    IMG_SPLIT_CURTAIN_ON = false;
  }
  btn.disabled = !hasRef;
  btn.classList.toggle('is-on', Boolean(hasRef && IMG_SPLIT_CURTAIN_ON));
  btn.setAttribute('aria-pressed', String(Boolean(hasRef && IMG_SPLIT_CURTAIN_ON)));
  btn.title = hasRef
    ? 'Toggle synchronized in-card Before/After Split Curtain comparing the Original Reference Image against each model output across all columns'
    : 'Available when an original reference image is attached (Upscaling, Smart Erase, Restoration, Recoloring, Storybook)';
}

function renderImageReferenceAttachments() {
  const listEl = $('#imgRefList');
  const countBadge = $('#imgRefCountBadge');
  const clearBtn = $('#imgClearRefsBtn');
  const reloadBtn = $('#imgReloadSampleRefsBtn');
  syncSplitCurtainButtonState();
  if (!listEl) return;

  const count = IMG_REF_ATTACHMENTS.length;
  if (countBadge) {
    countBadge.textContent = `${count} / 13 reference image${count === 1 ? '' : 's'}`;
    countBadge.classList.toggle('hidden', count === 0);
    countBadge.classList.toggle('has-files', count > 0);
  }
  if (clearBtn) clearBtn.classList.toggle('hidden', count === 0);
  if (reloadBtn) {
    reloadBtn.classList.toggle('hidden', IMG_CURRENT_SCENARIO_REFS.length === 0 || count > 0);
  }

  if (count === 0) {
    listEl.innerHTML = '';
    listEl.classList.add('hidden');
    return;
  }

  listEl.classList.remove('hidden');
  listEl.innerHTML = '';
  IMG_REF_ATTACHMENTS.forEach((att, idx) => {
    const item = el('div', 'ca-item is-clickable');
    item.title = 'Click to view large input reference image';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.addEventListener('click', () => openReferenceLightboxAt(idx));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openReferenceLightboxAt(idx);
      }
    });

    const thumb = el('img', 'ca-thumb');
    thumb.width = 34;
    thumb.height = 34;
    thumb.style.cssText = 'width:34px;height:34px;max-width:34px;max-height:34px;object-fit:cover;flex-shrink:0;display:block';
    const cleanB64 = String(att.data || '').replace(/^data:[^;]+;base64,/, '');
    thumb.src = `data:${att.mimeType || 'image/png'};base64,${cleanB64}`;
    thumb.alt = att.label || att.name || `Reference ${idx + 1}`;
    item.appendChild(thumb);

    const info = el('div', 'ca-info');
    const nm = el('div', 'ca-name', esc(att.label || att.name || `ref-${idx + 1}.png`));
    const kb = Math.max(1, Math.round((cleanB64.length * 3) / 4 / 1024));
    const meta = el('div', 'ca-meta', `Ref #${idx + 1} · ${kb} KB · ${esc(att.mimeType || 'image/png')}`);
    info.appendChild(nm);
    info.appendChild(meta);
    item.appendChild(info);

    const zoomHint = el('span', 'ca-zoom-hint', '🔍 Enlarge');
    item.appendChild(zoomHint);

    const rm = el('button', 'ca-remove', '✕');
    rm.type = 'button';
    rm.title = 'Remove reference image';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      IMG_REF_ATTACHMENTS.splice(idx, 1);
      renderImageReferenceAttachments();
      renderImageSlotsConfigurator();
      updateSplitCurtainView();
    });
    item.appendChild(rm);
    listEl.appendChild(item);
  });
}

function closestSupportedAspectRatio(w, h) {
  const nw = Number(w);
  const nh = Number(h);
  if (!(nw > 0 && nh > 0)) return null;
  const ratio = nw / nh;
  const candidates = [
    { id: '1:1', val: 1.0 },
    { id: '4:3', val: 4 / 3 },
    { id: '3:4', val: 3 / 4 },
    { id: '16:9', val: 16 / 9 },
    { id: '9:16', val: 9 / 16 },
  ];
  let best = candidates[0];
  let bestDiff = Math.abs(ratio - best.val);
  for (let i = 1; i < candidates.length; i++) {
    const d = Math.abs(ratio - candidates[i].val);
    if (d < bestDiff) {
      bestDiff = d;
      best = candidates[i];
    }
  }
  return best.id;
}

function handleImageRefFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && /^image\//i.test(f.type));
  for (const file of files) {
    if (IMG_REF_ATTACHMENTS.length >= 13) break;
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const base64 = res.replace(/^data:[^;]+;base64,/, '');
      const attObj = {
        name: file.name || 'uploaded-image.png',
        label: file.name || 'Uploaded Reference',
        mimeType: file.type || 'image/png',
        data: base64,
      };
      IMG_REF_ATTACHMENTS.push(attObj);

      const probe = new Image();
      probe.onload = () => {
        const nw = probe.naturalWidth;
        const nh = probe.naturalHeight;
        if (nw > 0 && nh > 0) {
          attObj.width = nw;
          attObj.height = nh;
          const activeScId = ($('#imgScenarioSelect') && $('#imgScenarioSelect').value) || '';
          if (activeScId !== 'aspect-ratio-resampling') {
            const matched = closestSupportedAspectRatio(nw, nh);
            if (matched) {
              IMG_SELECTED_ASPECT = matched;
              const aspectSel = $('#imgAspectSelect');
              if (aspectSel) aspectSel.value = matched;
              renderImageSizeAndAspectPills();
              const stageAr = aspectRatioCssValue(IMG_SELECTED_ASPECT, nw, nh);
              document.querySelectorAll('#imgArenaGrid .img-stage-wrap').forEach((st) => {
                st.style.setProperty('--stage-ar', stageAr);
              });
              if (!IMG_LAST_RESULTS.length) renderImageArenaPlaceholderCards();
            }
          }
        }
      };
      probe.src = res;

      renderImageReferenceAttachments();
      renderImageSlotsConfigurator();
      updateSplitCurtainView();
    };
    reader.readAsDataURL(file);
  }
}

const addImageReferenceFiles = handleImageRefFiles;

function renderImageArenaPlaceholderCards() {
  const grid = $('#imgArenaGrid');
  if (!grid || !IMG_CONFIG) return;
  grid.innerHTML = '';
  grid.style.setProperty('--img-slot-count', String(Math.max(1, IMG_SLOTS.length)));
  const showOffPeak = hasOffPeakModelSelected();
  const topSpanCls = showOffPeak ? 'span-2' : 'span-3';
  const stageAr = aspectRatioCssValue(IMG_SELECTED_ASPECT);

  IMG_SLOTS.forEach((slotObj) => {
    const entry = getImgCatalogItem(slotObj.catalogId);
    if (!entry) return;
    const color = slotColor(slotObj.slot);
    const col = el('article', 'col glass img-result-col');
    col.id = `img-col-${slotObj.slot}`;
    col.style.setProperty('--accent', color);

    const modeLabel = entry.id === 'gemini-nano-banana-2.1'
      ? '🧠 Visual Thinking + Final Render'
      : '⚡ Direct Single-Pass Render';

    const offPeakTileHtml = showOffPeak
      ? `<div class="metric span-3" id="img-mcard-offpeak-${slotObj.slot}"><div class="k">Off-Peak PayGo</div><div class="v" id="img-tile-offpeak-${slotObj.slot}">—</div></div>`
      : '';

    const endpointLabel = entry.provider === 'openai' ? 'OpenAI API' : 'Vertex AI';

    col.innerHTML = `
      <header class="col-head">
        <div class="col-title-row">
          <span class="slot-pill" style="background:${color}22;color:${color};border-color:${color}66">Slot ${esc(slotObj.slot)}</span>
          ${modelIconSvg(entry)}
          <div>
            <h3 class="col-title" title="${esc(entry.label)}">${esc(entry.label)}</h3>
            <div class="col-sub" title="${esc(entry.releaseBadge)} · ${esc(entry.model)}">${esc(entry.releaseBadge)} · <code>${esc(entry.model)}</code></div>
          </div>
        </div>
        <div class="col-head-right">
          <span class="status-pill" id="img-status-${slotObj.slot}">Ready (${esc(IMG_SELECTED_SIZE)})</span>
        </div>
      </header>
      <div class="img-card-badges" id="img-badges-${slotObj.slot}">
        <span class="img-res-pill">${esc(IMG_SELECTED_SIZE)} (${esc(IMG_SELECTED_ASPECT)})</span>
        <span class="img-res-pill">${esc(entry.slaBadge)}</span>
        <span class="img-res-pill">${esc(entry.endpointBadge)}</span>
      </div>
      <div class="img-card-actions" id="img-actions-${slotObj.slot}">
        <div class="img-card-actions-left">
          <span class="img-mode-chip">${esc(modeLabel)}</span>
        </div>
        <div class="img-card-actions-right">
          <button type="button" class="bar-btn img-thought-toggle" disabled title="Generate images to view full size">🔍 Full Size</button>
          <button type="button" class="bar-btn img-thought-toggle" disabled title="Generate images to download PNG">⬇ Save PNG</button>
        </div>
      </div>
      <div class="img-stage-wrap" id="img-stage-${slotObj.slot}" data-slot="${esc(slotObj.slot)}" style="--stage-ar:${esc(stageAr)};--curtain-pos:${IMG_CURTAIN_POS}%">
        <div style="padding:36px 24px;text-align:center;color:var(--muted);font-size:13px">
          Click <strong>Generate &amp; Compare Images ▸</strong> to run <code>${esc(entry.model)}</code> at <strong>${esc(IMG_SELECTED_SIZE)} (${esc(IMG_SELECTED_ASPECT)})</strong> on ${esc(endpointLabel)}.
        </div>
      </div>
      <div class="metrics">
        <div class="metric ${topSpanCls}" id="img-mcard-res-${slotObj.slot}"><div class="k">Resolution &amp; MP</div><div class="v" id="img-tile-res-${slotObj.slot}">—</div></div>
        <div class="metric ${topSpanCls}" id="img-mcard-time-${slotObj.slot}"><div class="k">Wall Time</div><div class="v" id="img-tile-time-${slotObj.slot}">—</div></div>
        <div class="metric ${topSpanCls}" id="img-mcard-tok-${slotObj.slot}"><div class="k">Image / Think Tok</div><div class="v" id="img-tile-tok-${slotObj.slot}">—</div></div>
        <div class="metric span-3" id="img-mcard-cost-${slotObj.slot}"><div class="k">Standard PayGo</div><div class="v" id="img-tile-cost-${slotObj.slot}">—</div></div>
        ${offPeakTileHtml}
      </div>
      <div class="img-arch-callout" id="img-arch-${slotObj.slot}">
        <strong>Production Guidance:</strong> ${esc(entry.architectureGuidance)}
      </div>
    `;
    grid.appendChild(col);
  });
}

// ---------- Interactive Synchronized In-Card Split-Curtain Comparison ----------
// Overlays the Original Input Reference Image (Before · Original on the left of the
// divider) directly inside each model card's output box against that model's generated
// output (After · <Model> on the right of the divider). Dragging or using arrow keys on
// ANY card moves the dividers across ALL model columns simultaneously in lockstep.
function setCurtainPosition(pct) {
  const n = Number(pct);
  IMG_CURTAIN_POS = Math.max(0, Math.min(100, Number.isFinite(n) ? n : 50));
  const posVal = `${IMG_CURTAIN_POS}%`;
  const nowVal = String(Math.round(IMG_CURTAIN_POS));
  document.querySelectorAll('#imgArenaGrid .img-stage-wrap').forEach((st) => {
    st.style.setProperty('--curtain-pos', posVal);
    if (st.classList.contains('is-curtain-active')) {
      st.setAttribute('aria-valuenow', nowVal);
    }
  });
  const stage = $('#imgCurtainStage');
  if (stage) {
    stage.style.setProperty('--curtain-pos', posVal);
    stage.setAttribute('aria-valuenow', nowVal);
  }
}

function updateSplitCurtainView() {
  syncSplitCurtainButtonState();
  const sec = $('#imgCurtainSection');
  if (sec) sec.classList.add('hidden');

  const canShowCurtain = Boolean(
    IMG_SPLIT_CURTAIN_ON &&
    hasLiveImageResults() &&
    Array.isArray(IMG_REF_ATTACHMENTS) &&
    IMG_REF_ATTACHMENTS.length > 0
  );

  const ref0 = canShowCurtain ? IMG_REF_ATTACHMENTS[0] : null;
  const cleanB64 = ref0 ? String(ref0.data || '').replace(/^data:[^;]+;base64,/, '') : '';
  const refDataUrl = ref0 ? `data:${ref0.mimeType || 'image/png'};base64,${cleanB64}` : '';
  const refLabel = (ref0 && (ref0.label || ref0.name)) || 'Original Input';

  document.querySelectorAll('#imgArenaGrid .img-stage-wrap').forEach((stage) => {
    const slot = stage.dataset.slot || '';
    stage.querySelectorAll('.img-card-curtain-clip, .img-card-curtain-divider, .img-curtain-tag').forEach((node) => node.remove());
    const res = (IMG_LAST_RESULTS || []).find((r) => r && r.ok && r.imageDataUrl && String(r.slot) === String(slot));
    if (!canShowCurtain || !res) {
      stage.classList.remove('is-curtain-active');
      stage.removeAttribute('role');
      stage.removeAttribute('tabindex');
      stage.removeAttribute('aria-label');
      stage.removeAttribute('aria-valuemin');
      stage.removeAttribute('aria-valuemax');
      stage.removeAttribute('aria-valuenow');
      if (stage.dataset.hasImage === '1' && slot) {
        stage.onclick = () => openGeneratedOutputLightboxAt(slot);
        stage.style.cursor = 'zoom-in';
        stage.title = `Click to view full-size output (${stage.dataset.dimsLabel || ''})`;
      } else {
        stage.style.cursor = '';
      }
      return;
    }

    stage.classList.add('is-curtain-active');
    stage.style.setProperty('--curtain-pos', `${IMG_CURTAIN_POS}%`);
    stage.style.cursor = 'ew-resize';
    stage.onclick = null;
    stage.setAttribute('role', 'slider');
    stage.setAttribute('tabindex', '0');
    stage.setAttribute('aria-label', `Synchronized split curtain for Slot ${slot} (Before: Original vs After: ${res.shortLabel || res.label})`);
    stage.setAttribute('aria-valuemin', '0');
    stage.setAttribute('aria-valuemax', '100');
    stage.setAttribute('aria-valuenow', String(Math.round(IMG_CURTAIN_POS)));
    stage.title = 'Drag ⇔ (or use ← → keys) to scrub Before (Original Input) vs After across all models together';

    const clip = el('div', 'img-card-curtain-clip');
    const leftImg = el('img', 'img-card-curtain-left-img');
    leftImg.src = refDataUrl;
    leftImg.alt = `Original Reference: ${refLabel}`;
    leftImg.draggable = false;
    clip.appendChild(leftImg);

    const divider = el('div', 'img-card-curtain-divider');
    divider.setAttribute('aria-hidden', 'true');
    const handle = el('div', 'img-card-curtain-handle', '⇔');
    divider.appendChild(handle);

    const leftTag = el('span', 'img-curtain-tag left', 'Before · Original');
    const rightTag = el('span', 'img-curtain-tag right', `After · ${esc(res.shortLabel || res.label)}`);

    stage.appendChild(clip);
    stage.appendChild(divider);
    stage.appendChild(leftTag);
    stage.appendChild(rightTag);
  });

  setCurtainPosition(IMG_CURTAIN_POS);
}

function initCurtainDrag() {
  const grid = $('#imgArenaGrid');
  if (grid && !grid.__curtainBound) {
    grid.__curtainBound = true;
    let activeStage = null;
    const moveOnStage = (st, clientX) => {
      if (!st) return;
      const rect = st.getBoundingClientRect();
      if (rect.width <= 0) return;
      setCurtainPosition(((clientX - rect.left) / rect.width) * 100);
    };
    grid.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      const st = e.target && e.target.closest ? e.target.closest('.img-stage-wrap.is-curtain-active') : null;
      if (!st) return;
      activeStage = st;
      try { st.setPointerCapture(e.pointerId); } catch (_) {}
      try { st.focus({ preventScroll: true }); } catch (_) {}
      moveOnStage(st, e.clientX);
      e.preventDefault();
    });
    grid.addEventListener('pointermove', (e) => {
      if (!activeStage) return;
      moveOnStage(activeStage, e.clientX);
    });
    const stopDrag = () => { activeStage = null; };
    grid.addEventListener('pointerup', stopDrag);
    grid.addEventListener('pointercancel', stopDrag);
    grid.addEventListener('lostpointercapture', stopDrag);
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerup', stopDrag);
      window.addEventListener('pointercancel', stopDrag);
    }
    grid.addEventListener('keydown', (e) => {
      const st = e.target && e.target.closest ? e.target.closest('.img-stage-wrap.is-curtain-active') : null;
      if (!st) return;
      const step = e.shiftKey ? 10 : 2;
      let next = null;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = IMG_CURTAIN_POS - step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = IMG_CURTAIN_POS + step;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = 100;
      if (next == null) return;
      e.preventDefault();
      setCurtainPosition(next);
    });
  }
  setCurtainPosition(IMG_CURTAIN_POS);
}

// ---------- Image & GenMedia Run History (Browser IndexedDB) ----------
const IMG_HIST_DB_NAME = 'llm_compare_image_history_v1';
const IMG_HIST_STORE = 'runs';
const IMG_HIST_MAX_RUNS = 25;
const IMG_HIST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7-day auto-pruning for unstarred runs

function openImageHistoryDb() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      resolve(null);
      return;
    }
    try {
      const req = window.indexedDB.open(IMG_HIST_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IMG_HIST_STORE)) {
          const store = db.createObjectStore(IMG_HIST_STORE, { keyPath: 'id' });
          store.createIndex('at', 'at', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

async function listImageArenaRunsFromHistory() {
  const db = await openImageHistoryDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IMG_HIST_STORE, 'readonly');
      const store = tx.objectStore(IMG_HIST_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const allRows = Array.isArray(req.result) ? req.result : [];
        const cutoffMs = Date.now() - IMG_HIST_RETENTION_MS;
        const kept = [];
        const expiredIds = [];
        for (const r of allRows) {
          if (!r || !r.id) continue;
          if (!r.starred && Number(r.at || 0) > 0 && Number(r.at || 0) < cutoffMs) {
            expiredIds.push(r.id);
          } else {
            kept.push(r);
          }
        }
        if (expiredIds.length) {
          try {
            const ptx = db.transaction(IMG_HIST_STORE, 'readwrite');
            const pstore = ptx.objectStore(IMG_HIST_STORE);
            expiredIds.forEach((id) => { try { pstore.delete(id); } catch (_) {} });
          } catch (_) {}
        }
        kept.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
        resolve(kept);
      };
      req.onerror = () => resolve([]);
    } catch (_) {
      resolve([]);
    }
  });
}

async function setImageArenaRunStarredInLocalDb(id, starred) {
  if (!id) return false;
  const db = await openImageHistoryDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IMG_HIST_STORE, 'readwrite');
      const store = tx.objectStore(IMG_HIST_STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (rec) {
          rec.starred = Boolean(starred);
          try { store.put(rec); } catch (_) {}
        }
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) {
      resolve(false);
    }
  });
}

function createTinyHistoryThumbnailDataUrl(srcDataUrl, targetW = 68, targetH = 48) {
  return new Promise((resolve) => {
    if (!srcDataUrl || typeof document === 'undefined') {
      resolve('');
      return;
    }
    try {
      const im = new Image();
      im.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = targetW;
          cv.height = targetH;
          const ctx = cv.getContext('2d');
          const scale = Math.max(targetW / (im.naturalWidth || targetW), targetH / (im.naturalHeight || targetH));
          const dw = (im.naturalWidth || targetW) * scale;
          const dh = (im.naturalHeight || targetH) * scale;
          const dx = (targetW - dw) / 2;
          const dy = (targetH - dh) / 2;
          ctx.drawImage(im, dx, dy, dw, dh);
          resolve(cv.toDataURL('image/jpeg', 0.78));
        } catch (_) {
          resolve('');
        }
      };
      im.onerror = () => resolve('');
      im.src = srcDataUrl;
    } catch (_) {
      resolve('');
    }
  });
}

async function saveImageArenaRunToHistory(runRecord) {
  if (!runRecord || !runRecord.id) return;
  try {
    if (Array.isArray(runRecord.results)) {
      await Promise.all(runRecord.results.map(async (r) => {
        if (r && r.ok && r.imageDataUrl && !r.thumbDataUrl) {
          const tiny = await createTinyHistoryThumbnailDataUrl(r.imageDataUrl, 68, 48);
          if (tiny) r.thumbDataUrl = tiny;
        }
      }));
    }
    // 1. Persist to server-authoritative history & admin usage tracker
    try {
      const compactResults = (Array.isArray(runRecord.results) ? runRecord.results : []).map((res) => ({
        slot: res.slot,
        catalogId: res.catalogId,
        label: res.label,
        shortLabel: res.shortLabel,
        model: res.model,
        thinkingLevel: res.thinkingLevel,
        imageSize: res.imageSize || runRecord.imageSize,
        requestedSize: res.requestedSize || res.imageSize || runRecord.imageSize || '2K',
        aspectRatio: res.aspectRatio || runRecord.aspectRatio,
        width: res.width || null,
        height: res.height || null,
        megapixels: res.megapixels || null,
        slaBadge: res.slaBadge || null,
        savingsVsNanoBanana2Pct: res.savingsVsNanoBanana2Pct || 0,
        ok: Boolean(res.ok || !res.error),
        error: res.error || null,
        latencyMs: res.latencyMs,
        costUsd: res.costUsd != null ? res.costUsd : res.standardPayGoCostUsd,
        standardPayGoCostUsd: res.standardPayGoCostUsd != null ? res.standardPayGoCostUsd : res.costUsd,
        standardPayGoPer1kUsd: res.standardPayGoPer1kUsd || null,
        offPeakSupported: Boolean(res.offPeakSupported),
        offPeakPayGoCostUsd: res.offPeakPayGoCostUsd != null ? res.offPeakPayGoCostUsd : null,
        promptTokens: res.promptTokens,
        imageOutputTokens: res.imageOutputTokens,
        thoughtsTokens: res.thoughtsTokens || res.reasoningTokens,
        reasoningTokens: res.reasoningTokens || res.thoughtsTokens || 0,
        completionTokens: res.completionTokens,
        mimeType: res.mimeType || 'image/png',
        hasImage: Boolean(res.hasImage || res.imageDataUrl || res.imageVaultRef || res.thumbDataUrl),
        imageVaultRef: res.imageVaultRef || null,
        thoughtVaultRef: res.thoughtVaultRef || null,
        thumbDataUrl: res.thumbDataUrl || null,
      }));
      await fetch('/api/image-arena/history', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run: {
            id: runRecord.id,
            at: runRecord.at,
            starred: Boolean(runRecord.starred),
            packId: runRecord.packId || 'custom',
            scenarioId: runRecord.scenarioId || 'custom',
            title: runRecord.title || runRecord.scenarioTitle || (runRecord.prompt || '').slice(0, 72) || 'Image Arena Comparison',
            prompt: runRecord.prompt || '',
            imageSize: runRecord.imageSize || '2K',
            aspectRatio: runRecord.aspectRatio || '16:9',
            slots: runRecord.slots || [],
            results: compactResults,
          },
        }),
      });
    } catch (_) {}

    // 2. Also keep in browser IndexedDB for instant local restore
    const db = await openImageHistoryDb();
    if (!db) return;
    const existing = await listImageArenaRunsFromHistory();
    const tx = db.transaction(IMG_HIST_STORE, 'readwrite');
    const store = tx.objectStore(IMG_HIST_STORE);
    store.put(runRecord);
    if (existing.length >= IMG_HIST_MAX_RUNS) {
      const unstarredOld = existing.filter((x) => x && x.id !== runRecord.id && !x.starred);
      const excessCount = Math.max(0, existing.length - (IMG_HIST_MAX_RUNS - 1));
      const toPrune = unstarredOld.slice(Math.max(0, unstarredOld.length - excessCount));
      toPrune.forEach((old) => {
        if (old && old.id && old.id !== runRecord.id) {
          try { store.delete(old.id); } catch (_) {}
        }
      });
    }
  } catch (e) {
    console.warn('[imageArena] failed to save run to history:', e);
  }
}

async function deleteImageArenaRunFromHistory(id) {
  if (!id) return false;
  try {
    await fetch('/api/image-arena/history/' + encodeURIComponent(id), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
  } catch (_) {}
  const db = await openImageHistoryDb();
  if (!db) return true;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IMG_HIST_STORE, 'readwrite');
      tx.objectStore(IMG_HIST_STORE).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) {
      resolve(false);
    }
  });
}

async function clearAllImageArenaHistory() {
  const db = await openImageHistoryDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IMG_HIST_STORE, 'readwrite');
      tx.objectStore(IMG_HIST_STORE).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (_) {
      resolve(false);
    }
  });
}

// The 🗂 History button opens Image Arena run history (no count badge, matching Text Arena).
async function updateImageHistoryButton() {
  const histBtn = $('#imgHistoryBtn');
  if (!histBtn) return;
  histBtn.textContent = '🗂 History';
}

async function restoreImageArenaRun(runId) {
  // A restore overwrites the prompt, reference images and result cards: never do it
  // under a running generation (its slots would land in the wrong cards) or over
  // unsaved input without an explicit OK (1.6).
  if (IMG_RUNNING) {
    window.alert('An image generation is still running. Wait for it to finish before restoring a run.');
    return;
  }
  if (imageComposerIsDirty() && !window.confirm('Replace your current prompt and reference images with this saved run?')) return;
  await ensureImageArenaLoaded();
  if (ACTIVE_ARENA_MODE !== 'image') {
    switchArenaMode('image');
  }

  const runs = await listImageArenaRunsFromHistory();
  const localRec = runs.find((r) => r && r.id === runId) || null;
  let rec = localRec;
  const needsServerHydration = !rec
    || !Array.isArray(rec.results)
    || rec.results.some((r) => r && !r.error && !r.imageDataUrl)
    || (!Array.isArray(rec.attachments) || rec.attachments.some((a) => a && !a.data));
  if (needsServerHydration) {
    try {
      const resp = await fetch('/api/image-arena/history/' + encodeURIComponent(runId), { credentials: 'same-origin' });
      if (resp.ok) {
        const j = await resp.json();
        if (j && j.run) {
          const srv = j.run;
          const srvResults = (srv.results || srv.summary || []).map((r) => {
            const locMatch = (localRec && Array.isArray(localRec.results))
              ? localRec.results.find((lr) => lr && lr.slot === r.slot && lr.catalogId === r.catalogId)
              : null;
            return {
              ...(locMatch || {}),
              ...r,
              imageDataUrl: r.imageDataUrl || (locMatch && locMatch.imageDataUrl) || r.thumbDataUrl || '',
              thumbDataUrl: r.thumbDataUrl || (locMatch && locMatch.thumbDataUrl) || '',
              ok: Boolean(r.ok != null ? r.ok : !r.error),
              standardPayGoCostUsd: r.standardPayGoCostUsd != null ? r.standardPayGoCostUsd : r.costUsd,
            };
          });
          rec = {
            ...(localRec || {}),
            ...srv,
            attachments: (Array.isArray(srv.attachments) && srv.attachments.length)
              ? srv.attachments
              : ((localRec && Array.isArray(localRec.attachments)) ? localRec.attachments : []),
            results: srvResults,
          };
        }
      }
    } catch (_) {}
  }
  if (!rec) return;

  // Sync pack & scenario dropdowns + banner without calling applyImageScenario() (which resets state)
  const packs = (IMG_CONFIG && Array.isArray(IMG_CONFIG.packs)) ? IMG_CONFIG.packs : [];
  const packSel = $('#imgPackSelect');
  const scSel = $('#imgScenarioSelect');
  const badgeEl = $('#imgScenarioBadge');
  const whyEl = $('#imgWhyBanner');
  let matchedPack = (rec.packId && packs.find((p) => p.id === rec.packId)) || null;
  let matchedScenario = null;
  if (!matchedPack && rec.scenarioId) {
    for (const p of packs) {
      const found = (p.scenarios || []).find((s) => s.id === rec.scenarioId);
      if (found) { matchedPack = p; matchedScenario = found; break; }
    }
  } else if (matchedPack && rec.scenarioId) {
    matchedScenario = (matchedPack.scenarios || []).find((s) => s.id === rec.scenarioId) || null;
  }
  if (matchedPack && packSel) {
    packSel.value = matchedPack.id;
    const subSel = $('#imgSubcategorySelect');
    const subSep = $('#imgSubcategorySep');
    const subs = Array.isArray(matchedPack.subcategories) ? matchedPack.subcategories : [];
    const targetSub = matchedScenario && matchedScenario.subcategory
      ? matchedScenario.subcategory
      : (subs[0] ? subs[0].id : '');
    if (subSel) {
      subSel.innerHTML = '';
      if (subs.length > 0) {
        subs.forEach((sub) => {
          const o = el('option');
          o.value = sub.id;
          o.textContent = sub.label;
          subSel.appendChild(o);
        });
        if (targetSub && subs.some((s) => s.id === targetSub)) subSel.value = targetSub;
        subSel.classList.remove('hidden');
        if (subSep) subSep.classList.remove('hidden');
      } else {
        subSel.classList.add('hidden');
        if (subSep) subSep.classList.add('hidden');
      }
    }
    if (scSel) {
      scSel.innerHTML = '';
      const allSc = matchedPack.scenarios || [];
      const filteredSc = (targetSub && subs.length > 0 && allSc.some((s) => s.subcategory === targetSub))
        ? allSc.filter((s) => s.subcategory === targetSub)
        : allSc;
      filteredSc.forEach((s) => {
        const o = el('option');
        o.value = s.id;
        o.textContent = s.title;
        scSel.appendChild(o);
      });
      if (matchedScenario) scSel.value = matchedScenario.id;
    }
  }
  if (badgeEl) {
    badgeEl.textContent = (matchedScenario && matchedScenario.badge)
      || (matchedPack && matchedPack.badge)
      || 'Restored Run';
  }
  if (whyEl) {
    if (matchedScenario && matchedScenario.whyItMatters) {
      whyEl.textContent = matchedScenario.whyItMatters;
      whyEl.classList.remove('hidden');
    } else {
      whyEl.classList.add('hidden');
    }
  }
  if (matchedScenario && Array.isArray(matchedScenario.attachments)) {
    IMG_CURRENT_SCENARIO_REFS = matchedScenario.attachments.map((a) => ({ ...a }));
  }

  if (rec.imageSize && ['1K', '2K', '4K'].includes(rec.imageSize)) {
    IMG_SELECTED_SIZE = rec.imageSize;
  }
  if (rec.aspectRatio) {
    IMG_SELECTED_ASPECT = rec.aspectRatio;
  }
  // Skip slots from retired models and re-letter the rest so results still map to cards.
  let slotMap = null; // saved slot letter -> restored slot letter
  const rawSlots = (Array.isArray(rec.slots) && rec.slots.length)
    ? rec.slots
    : (Array.isArray(rec.results) && rec.results.length
      ? rec.results.map((r, i) => ({ slot: r.slot || String.fromCharCode(65 + i), catalogId: r.catalogId }))
      : (Array.isArray(rec.summary) ? rec.summary.map((r, i) => ({ slot: r.slot || String.fromCharCode(65 + i), catalogId: r.catalogId })) : []));
  const keptSlots = rawSlots.filter((s) => s && isCurrentImageModel(s.catalogId));
  if (keptSlots.length) {
    slotMap = {};
    IMG_SLOTS = keptSlots.map((s, i) => {
      const slot = String.fromCharCode(65 + i);
      slotMap[s.slot] = slot;
      return { ...s, slot };
    });
  }
  const promptEl = $('#imgPromptInput');
  if (promptEl && rec.prompt != null) promptEl.value = rec.prompt;

  if (Array.isArray(rec.attachments)) {
    IMG_REF_ATTACHMENTS = rec.attachments.map((a) => ({ ...a }));
  } else {
    IMG_REF_ATTACHMENTS = [];
  }
  markImageComposerApplied();

  renderImageReferenceAttachments();
  renderImageSizeAndAspectPills();
  renderImageSlotsConfigurator();
  updateQuotaBadge();
  renderImageArenaPlaceholderCards();

  IMG_LAST_RESULTS = currentModelImageResults(rec)
    .filter((r) => !slotMap || slotMap[r.slot])
    .map((r) => {
      const mapped = slotMap ? { ...r, slot: slotMap[r.slot] } : { ...r };
      const entry = getImgCatalogItem(mapped.catalogId) || {};
      const reqSz = mapped.requestedSize || mapped.imageSize || rec.imageSize || IMG_SELECTED_SIZE || '2K';
      const reqAr = mapped.aspectRatio || rec.aspectRatio || IMG_SELECTED_ASPECT || '16:9';
      let w = Number(mapped.width) || 0;
      let h = Number(mapped.height) || 0;
      if (!(w > 0 && h > 0)) {
        const basePx = reqSz === '4K' ? 4096 : (reqSz === '1K' ? 1024 : 2048);
        if (reqAr === '16:9') { w = basePx; h = Math.round(basePx * 9 / 16); }
        else if (reqAr === '9:16') { w = Math.round(basePx * 9 / 16); h = basePx; }
        else if (reqAr === '4:3') { w = basePx; h = Math.round(basePx * 3 / 4); }
        else if (reqAr === '3:4') { w = Math.round(basePx * 3 / 4); h = basePx; }
        else { w = basePx; h = basePx; }
      }
      const mp = Number(mapped.megapixels) || Number(((w * h) / 1_000_000).toFixed(2));
      const stdCost = Number(mapped.standardPayGoCostUsd != null ? mapped.standardPayGoCostUsd : mapped.costUsd) || 0;
      const offPeakSup = Boolean(mapped.offPeakSupported || (entry.pricing && entry.pricing.offPeakDiscount > 0));
      const offPeakCost = mapped.offPeakPayGoCostUsd != null
        ? Number(mapped.offPeakPayGoCostUsd)
        : (offPeakSup ? Number((stdCost * 0.5).toFixed(6)) : stdCost);
      return {
        ...mapped,
        label: mapped.label || entry.label || mapped.catalogId,
        shortLabel: mapped.shortLabel || entry.shortLabel || entry.label || mapped.catalogId,
        model: mapped.model || entry.model || mapped.catalogId,
        requestedSize: reqSz,
        imageSize: reqSz,
        aspectRatio: reqAr,
        width: w,
        height: h,
        megapixels: mp,
        slaBadge: mapped.slaBadge || entry.slaBadge || 'Vertex AI Global',
        savingsVsNanoBanana2Pct: mapped.savingsVsNanoBanana2Pct != null
          ? mapped.savingsVsNanoBanana2Pct
          : (mapped.catalogId === 'gemini-nano-banana-2.1' ? 50 : 0),
        standardPayGoCostUsd: stdCost,
        standardPayGoPer1kUsd: mapped.standardPayGoPer1kUsd != null ? Number(mapped.standardPayGoPer1kUsd) : Number((stdCost * 1000).toFixed(2)),
        offPeakSupported: offPeakSup,
        offPeakPayGoCostUsd: offPeakCost,
        reasoningTokens: Number(mapped.reasoningTokens || mapped.thoughtsTokens || 0),
      };
    });
  IMG_LAST_RESULTS.forEach((r) => applyImageResultToCard(r));
  highlightImageWinnerTiles(IMG_LAST_RESULTS);
  updateSplitCurtainView();
  renderImageMetricComparison();
  renderImageEconomicsModeler();

  const timerBadge = $('#imgStatusTimer');
  if (timerBadge) {
    timerBadge.textContent = `Restored ${IMG_LAST_RESULTS.length} models (${rec.imageSize || IMG_SELECTED_SIZE})`;
  }
  const gridEl = $('#imgArenaGrid');
  if (gridEl && typeof gridEl.scrollIntoView === 'function') {
    gridEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ---------- Run Parallel Per-Slot Progressive Image Generation ----------
// When a non-Vertex budget (GPT Image on the shared OpenAI key) is used up, swap those
// slots to Gemini image models, like the text arena's "swap to Vertex AI" offer.
// dryRun=true only reports whether there is anything to swap.
function swapSharedExternalImageSlotsToVertex(dryRun) {
  const cat = (IMG_CONFIG && IMG_CONFIG.catalog) || [];
  const k = loadKeys();
  const vertexIds = cat.filter((c) => c.provider === 'agentplatform').map((c) => c.id);
  const targets = IMG_SLOTS.filter((s) => {
    const e = getImgCatalogItem(s.catalogId);
    return e && e.provider !== 'agentplatform' && keySourceFor(e, k).state !== 'own';
  });
  if (!targets.length || !vertexIds.length) return false;
  if (dryRun) return true;
  const used = new Set(IMG_SLOTS.map((s) => s.catalogId));
  targets.forEach((s) => {
    const rep = vertexIds.find((id) => !used.has(id)) || vertexIds[0];
    used.add(rep);
    s.catalogId = rep;
  });
  IMG_LAST_RESULTS = [];
  renderImageSlotsConfigurator();
  renderImageArenaPlaceholderCards();
  updateSplitCurtainView();
  renderImageMetricComparison();
  renderImageEconomicsModeler();
  return true;
}

async function runImageArenaComparisonClick() {
  if (IMG_RUNNING) return;
  const promptEl = $('#imgPromptInput');
  const prompt = (promptEl && promptEl.value.trim()) || '';
  if (!prompt) {
    window.alert('Please enter an image generation or editing prompt.');
    return;
  }

  IMG_RUNNING = true;
  setImageArenaControlsDisabled(true); // freeze slots / size / aspect / presets for the run's duration (1.5)
  const runBtn = $('#imgRunBtn');
  const timerBadge = $('#imgStatusTimer');
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.textContent = '⏳ Starting…';
  }
  const finishEarly = () => {
    IMG_RUNNING = false;
    setImageArenaControlsDisabled(false);
    if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = 'Generate &amp; Compare Images ▸ <kbd class="run-kbd">⌘↵</kbd>'; }
  };

  // One run = one Run click (same rule as the text arena): reserve it ONCE, so it counts once
  // per provider budget it touches however many slots it has; every slot then carries the ticket.
  // Done before clearing the cards, so a used-up budget leaves the previous results in place.
  let runTicket = '';
  try {
    const rr = await fetch('/api/image-arena/reserve', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots: IMG_SLOTS.map((s) => ({ slot: s.slot, catalogId: s.catalogId })), keys: loadKeys() }),
    });
    if (rr.status === 401) { window.location.replace('/login'); return; }
    const rj = await rr.json().catch(() => ({}));
    if (rj && rj.quotas) { myQuotas = rj.quotas; updateQuotaBadge(); }
    if (rr.status === 403 && rj && rj.code === 'PASSWORD_CHANGE_REQUIRED') { openChangePwModal({ forced: true }); finishEarly(); return; }
    if (rr.status === 429) {
      const m = (rj && rj.error) || 'Daily run limit reached.';
      const busy = !!(rj && !rj.quotas && /concurrent/i.test(String(rj.error || ''))); // concurrency cap, not a budget
      if (timerBadge) timerBadge.textContent = busy ? m : (rj && rj.monthlyBudgetExhausted ? 'Monthly budget used up' : 'Daily limit reached');
      finishEarly();
      if (busy) return; // inline message only, no alert loop
      if (rj && (rj.externalQuotaExhausted || rj.openaiQuotaExhausted) && swapSharedExternalImageSlotsToVertex(true)) {
        if (window.confirm(`${m}\n\nReplace the GPT Image slot(s) with Gemini (Nano Banana) models and run now? It will count against your Vertex AI budget instead.`)) {
          swapSharedExternalImageSlotsToVertex(false);
          setTimeout(() => runImageArenaComparisonClick(), 50);
        }
      } else {
        window.alert(m);
      }
      return;
    }
    if (!rr.ok || !rj || !rj.ok || !rj.ticket) throw new Error((rj && rj.error) || `Could not start the run (${rr.status}).`);
    runTicket = rj.ticket;
  } catch (e) {
    if (timerBadge) timerBadge.textContent = `Error: ${e.message}`;
    finishEarly();
    window.alert(e.message || 'Could not start the image run.');
    return;
  }
  if (runBtn) runBtn.textContent = '⏳ Generating…';

  IMG_LAST_RESULTS = [];
  // Every in-flight slot pushes into THIS array, so a lineup change (now locked,
  // but defensively) can never route a result into a card titled for another model (1.5).
  const resultsArr = IMG_LAST_RESULTS;
  renderImageArenaPlaceholderCards();
  updateSplitCurtainView();
  renderImageMetricComparison();
  renderImageEconomicsModeler();
  const t0 = Date.now();
  const activeSlotsSnapshot = IMG_SLOTS.map((s) => ({ ...s }));
  const reqSize = IMG_SELECTED_SIZE;
  const reqAspect = IMG_SELECTED_ASPECT;
  const reqRefs = IMG_REF_ATTACHMENTS.map((a) => ({ ...a }));

  activeSlotsSnapshot.forEach((s) => {
    const st = $(`#img-status-${s.slot}`);
    if (st) {
      st.textContent = `Generating ${reqSize}… 0.0s`;
      st.className = 'status-pill running';
    }
    const stage = $(`#img-stage-${s.slot}`);
    if (stage) {
      stage.innerHTML = `<div style="padding:48px 20px;text-align:center;color:var(--muted)">⚡ Calling Vertex AI <code>/locations/global</code> (${esc(reqSize)} · ${esc(reqAspect)})…</div>`;
    }
  });

  if (IMG_TIMER_ID) clearInterval(IMG_TIMER_ID);
  IMG_TIMER_ID = setInterval(() => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const doneCount = resultsArr.length;
    if (timerBadge) {
      timerBadge.textContent = `Running (${doneCount}/${activeSlotsSnapshot.length} done) · ${elapsed}s`;
    }
    activeSlotsSnapshot.forEach((s) => {
      const st = $(`#img-status-${s.slot}`);
      if (st && st.classList.contains('running')) {
        st.textContent = `Generating ${reqSize}… ${elapsed}s`;
      }
    });
  }, 150);

  try {
    // Dispatch 1 independent parallel HTTP request per slot so multi-slot 4K PNGs
    // never exceed Cloud Run's 32 MiB single-response limit and each card renders
    // progressively the instant its model finishes. Pass a shared `clientRunId` + `allSlots`
    // so the server immediately records and merges each completed slot in history.
    const clientRunId = `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const packSel = $('#imgPackSelect');
    const scSel = $('#imgScenarioSelect');
    const scTitle = scSel && scSel.options[scSel.selectedIndex]
      ? scSel.options[scSel.selectedIndex].textContent
      : prompt.slice(0, 60);
    const packIdVal = packSel ? packSel.value : '';
    const scenarioIdVal = scSel ? scSel.value : '';

    const slotPromises = activeSlotsSnapshot.map(async (slotObj) => {
      try {
        const resp = await fetch('/api/image-arena/run', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId: clientRunId,
            slots: [slotObj],
            allSlots: activeSlotsSnapshot,
            packId: packIdVal,
            scenarioId: scenarioIdVal,
            scenarioTitle: scTitle,
            prompt,
            aspectRatio: reqAspect,
            imageSize: reqSize,
            attachments: reqRefs,
            keys: loadKeys(),
            ticket: runTicket, // this run was already charged once at reserve
          }),
        });
        if (resp.status === 401) {
          window.location.replace('/login');
          return null;
        }
        if (resp.status === 403) {
          const j403 = await resp.clone().json().catch(() => ({}));
          if (j403 && j403.code === 'PASSWORD_CHANGE_REQUIRED') {
            openChangePwModal({ forced: true });
          }
        }
        const rawText = await resp.text();
        let data = null;
        try {
          data = rawText ? JSON.parse(rawText) : null;
        } catch (parseErr) {
          throw new Error(`Invalid response payload for Slot ${slotObj.slot} (${Math.round((rawText || '').length / 1024)} KB): ${parseErr.message}`);
        }
        if (data && data.quotas) { myQuotas = data.quotas; updateQuotaBadge(); }
        if (!resp.ok || !data || !data.ok) {
          throw new Error((data && data.error) || `Slot ${slotObj.slot} failed (${resp.status})`);
        }
        const slotResult = (data.results && data.results[0]) || {
          slot: slotObj.slot,
          catalogId: slotObj.catalogId,
          ok: false,
          error: 'Empty result from Vertex AI.',
        };
        resultsArr.push(slotResult);
        resultsArr.sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
        applyImageResultToCard(slotResult);
        return slotResult;
      } catch (slotErr) {
        const entry = getImgCatalogItem(slotObj.catalogId) || {};
        const fallbackErr = {
          slot: slotObj.slot,
          catalogId: slotObj.catalogId,
          model: entry.model || slotObj.catalogId,
          label: entry.label || slotObj.catalogId,
          ok: false,
          error: slotErr.message || String(slotErr),
        };
        resultsArr.push(fallbackErr);
        resultsArr.sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
        applyImageResultToCard(fallbackErr);
        return fallbackErr;
      }
    });

    await Promise.allSettled(slotPromises);

    IMG_RUNNING = false;
    highlightImageWinnerTiles(resultsArr);
    updateSplitCurtainView();
    renderImageMetricComparison();
    renderImageEconomicsModeler();

    const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
    const okCount = resultsArr.filter((r) => r && r.ok).length;
    if (timerBadge) {
      timerBadge.textContent = `Completed ${okCount}/${activeSlotsSnapshot.length} models in ${totalSec}s`;
    }

    if (okCount > 0) {
      await saveImageArenaRunToHistory({
        id: clientRunId,
        at: Date.now(),
        packId: packIdVal,
        scenarioId: scenarioIdVal,
        scenarioTitle: scTitle,
        prompt,
        imageSize: reqSize,
        aspectRatio: reqAspect,
        slots: activeSlotsSnapshot,
        attachments: reqRefs,
        results: resultsArr,
      });
      await updateImageHistoryButton();
    }
  } catch (e) {
    if (timerBadge) timerBadge.textContent = `Error: ${e.message}`;
    window.alert(e.message || 'Image comparison failed.');
  } finally {
    if (IMG_TIMER_ID) { clearInterval(IMG_TIMER_ID); IMG_TIMER_ID = null; }
    IMG_RUNNING = false;
    setImageArenaControlsDisabled(false);
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.innerHTML = 'Generate &amp; Compare Images ▸ <kbd class="run-kbd">⌘↵</kbd>';
    }
  }
}

function applyImageResultToCard(r) {
  if (!r || !r.slot) return;
  const st = $(`#img-status-${r.slot}`);
  const stage = $(`#img-stage-${r.slot}`);
  const badges = $(`#img-badges-${r.slot}`);
  const actions = $(`#img-actions-${r.slot}`);

  if (!r.ok) {
    if (st) { st.textContent = 'Error'; st.className = 'status-pill err'; }
    if (stage) {
      stage.innerHTML = `<div style="padding:28px;color:var(--bad);font-size:13px">${esc(r.error || 'Generation failed')}</div>`;
    }
    return;
  }

  const secs = ((r.latencyMs || 0) / 1000).toFixed(1) + 's';
  if (st) {
    st.textContent = `Done · ${secs}`;
    st.className = 'status-pill done';
  }

  const dimsStr = (r.width && r.height) ? `${r.width}×${r.height}` : r.requestedSize;
  const mpStr = r.megapixels != null ? `${r.megapixels} MP` : '';
  const isTrue4K = r.width >= 3800 || r.height >= 3800;

  if (badges) {
    badges.innerHTML =
      `<span class="img-res-pill ${isTrue4K ? 'is-4k' : ''}">${esc(dimsStr)}${mpStr ? ' · ' + esc(mpStr) : ''}</span>` +
      `<span class="img-res-pill">${esc(r.slaBadge || '')}</span>` +
      (Number(r.savingsVsNanoBanana2Pct) > 0
        ? `<span class="img-res-pill is-4k">~${Math.round(Number(r.savingsVsNanoBanana2Pct))}% Lower Cost</span>`
        : '');
  }

  if (actions) {
    actions.innerHTML = '';
    const leftWrap = el('div', 'img-card-actions-left');
    const rightWrap = el('div', 'img-card-actions-right');

    if (r.hasThoughtImage && r.thoughtImageDataUrl) {
      const tDims = (r.thoughtDims && r.thoughtDims.width) ? `${esc(r.thoughtDims.width)}×${esc(r.thoughtDims.height)}` : '1K';
      const toggleBtn = el('button', 'bar-btn img-thought-toggle', `🧠 1K Thinking Draft (${tDims})`);
      toggleBtn.type = 'button';
      toggleBtn.title = 'Toggle between the 1K visual thinking draft (part[0]) and the final high-resolution output (part[1])';
      let showingThought = false;
      toggleBtn.addEventListener('click', () => {
        showingThought = !showingThought;
        const imgEl = stage && stage.querySelector('img.img-main-output');
        if (imgEl) {
          imgEl.src = showingThought ? r.thoughtImageDataUrl : r.imageDataUrl;
        }
        toggleBtn.textContent = showingThought
          ? `✨ Final ${dimsStr} Output`
          : `🧠 1K Thinking Draft (${tDims})`;
        toggleBtn.classList.toggle('is-on', showingThought);
      });
      leftWrap.appendChild(toggleBtn);
    } else {
      const chip = el('span', 'img-mode-chip', '⚡ Direct Single-Pass Render');
      leftWrap.appendChild(chip);
    }

    const enlargeBtn = el('button', 'bar-btn img-thought-toggle', '🔍 Full Size');
    enlargeBtn.type = 'button';
    enlargeBtn.title = `Click to view full-size output (${dimsStr})`;
    enlargeBtn.addEventListener('click', () => openGeneratedOutputLightboxAt(r.slot));
    rightWrap.appendChild(enlargeBtn);

    const dlBtn = el('a', 'bar-btn img-thought-toggle', '⬇ Save PNG');
    dlBtn.href = r.imageDataUrl;
    dlBtn.download = `${r.model}-${dimsStr}-${Date.now()}.png`;
    rightWrap.appendChild(dlBtn);

    actions.appendChild(leftWrap);
    actions.appendChild(rightWrap);
  }

  if (stage) {
    stage.innerHTML = '';
    stage.dataset.hasImage = '1';
    stage.dataset.dimsLabel = `${dimsStr}${mpStr ? ' (' + mpStr + ')' : ''}`;
    stage.style.setProperty('--stage-ar', aspectRatioCssValue(IMG_SELECTED_ASPECT, r.width, r.height));
    stage.style.setProperty('--curtain-pos', `${IMG_CURTAIN_POS}%`);
    stage.onclick = () => openGeneratedOutputLightboxAt(r.slot);
    stage.style.cursor = 'zoom-in';
    stage.title = `Click to view full-size output (${dimsStr})`;
    const img = el('img', 'img-main-output');
    img.style.cssText = 'width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;display:block;margin:0';
    img.src = r.imageDataUrl;
    img.alt = `${r.label} generated output (${dimsStr})`;
    stage.appendChild(img);
  }

  const resTile = $(`#img-tile-res-${r.slot}`);
  if (resTile) resTile.textContent = `${dimsStr}${mpStr ? ' (' + mpStr + ')' : ''}`;

  const timeTile = $(`#img-tile-time-${r.slot}`);
  if (timeTile) timeTile.textContent = secs;

  const tokTile = $(`#img-tile-tok-${r.slot}`);
  if (tokTile) tokTile.textContent = `${fmtInt(r.imageOutputTokens)} img / ${fmtInt(r.reasoningTokens)} think`;

  const costTile = $(`#img-tile-cost-${r.slot}`);
  if (costTile) costTile.textContent = `${fmtCost(r.standardPayGoCostUsd)} ($${(r.standardPayGoPer1kUsd || 0).toFixed(2)}/1k)`;

  const offPeakTile = $(`#img-tile-offpeak-${r.slot}`);
  if (offPeakTile) {
    offPeakTile.textContent = r.offPeakSupported
      ? `${fmtCost(r.offPeakPayGoCostUsd)} (-50% Off-Peak)`
      : 'Standard / PTU';
  }
}

function highlightImageWinnerTiles(results) {
  const ok = (results || []).filter((r) => r && r.ok);
  document.querySelectorAll('#imgArenaGrid .metric.win').forEach((elNode) => elNode.classList.remove('win'));
  if (ok.length < 2) return;

  const markBest = (prefix, vals, dir) => {
    const valid = vals.filter((x) => x.v != null && Number.isFinite(x.v) && x.v > 0);
    if (valid.length < 2) return;
    const min = Math.min(...valid.map((x) => x.v));
    const max = Math.max(...valid.map((x) => x.v));
    if (Math.abs(max - min) < 1e-9) return;
    const target = dir === 'higher' ? max : min;
    valid.forEach((x) => {
      if (Math.abs(x.v - target) < 1e-6) {
        const card = $(`#img-mcard-${prefix}-${x.slot}`);
        if (card) card.classList.add('win');
      }
    });
  };

  markBest('res', ok.map((r) => ({ slot: r.slot, v: Number(r.megapixels || 0) })), 'higher');
  markBest('time', ok.map((r) => ({ slot: r.slot, v: Number(r.latencyMs || 0) })), 'lower');
  markBest('cost', ok.map((r) => ({ slot: r.slot, v: Number(r.standardPayGoCostUsd || 0) })), 'lower');
  if (hasOffPeakModelSelected()) {
    markBest('offpeak', ok.map((r) => ({ slot: r.slot, v: Number(r.offPeakPayGoCostUsd || r.standardPayGoCostUsd || 0) })), 'lower');
  }
}

// ---------- Image Model Comparison Bars & Scale Scorecard (Matches Text Arena) ----------
function renderImageMetricComparison() {
  const scSec = $('#imgScorecard');
  const jumpBtn = $('#imgJumpScorecardBtn');
  if (!IMG_CONFIG || !hasLiveImageResults()) {
    if (scSec) scSec.classList.add('hidden');
    if (jumpBtn) jumpBtn.classList.add('hidden');
    return;
  }
  const legendEl = $('#imgModelLegend');
  const gridEl = $('#imgMetricGrid');
  const subEl = $('#imgScorecardSub');
  const toggleEl = $('#imgMetricViewToggle');
  if (!gridEl) return;

  const showOffPeak = hasOffPeakModelSelected();

  const scored = IMG_SLOTS.map((s) => {
    const entry = getImgCatalogItem(s.catalogId);
    if (!entry) return null;
    const live = (IMG_LAST_RESULTS || []).find(
      (r) => r && r.ok && r.slot === s.slot && r.catalogId === s.catalogId
    );
    if (!live) return null;
    const stdCost = Number(live.standardPayGoCostUsd || 0);
    const offPeakCost = Number(live.offPeakPayGoCostUsd != null ? live.offPeakPayGoCostUsd : stdCost);
    const mp = Number(live.megapixels || 0);
    const imgTok = Number(live.imageOutputTokens || 0);
    const latencySec = live.latencyMs > 0 ? live.latencyMs / 1000 : 0;

    return {
      slot: s.slot,
      label: entry.label,
      shortLabel: entry.shortLabel || entry.label,
      provider: entry.provider || 'google',
      publisher: entry.publisher || 'google',
      providerFamily: entry.providerFamily || entry.publisher || 'google',
      model: entry.model,
      isLive: true,
      standardPayGoCostUsd: stdCost,
      offPeakPayGoCostUsd: offPeakCost,
      latencySec,
      megapixels: mp,
      imageOutputTokens: imgTok,
    };
  }).filter(Boolean);

  if (!scored.length) {
    if (scSec) scSec.classList.add('hidden');
    if (jumpBtn) jumpBtn.classList.add('hidden');
    return;
  }
  if (scSec) scSec.classList.remove('hidden');
  if (jumpBtn) jumpBtn.classList.remove('hidden');

  if (subEl) {
    subEl.textContent = `Live measured Vertex AI telemetry at ${IMG_SELECTED_SIZE} (${IMG_SELECTED_ASPECT}) — each panel has its own scale; the green zone marks the better end.`;
  }

  if (legendEl) {
    legendEl.innerHTML = scored.map((r) => {
      const c = slotColor(r.slot);
      return `<span class="ml-chip" style="--c:${c}">${modelIconSvg(r)}<b>${esc(r.label)}</b><span class="ml-think">${esc(r.model)}</span></span>`;
    }).join('');
  }

  const view = scored.length < 2 ? 'bars' : metricView();
  if (toggleEl) {
    toggleEl.classList.toggle('hidden', scored.length < 2);
    toggleEl.querySelectorAll('.mv-btn').forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  const metrics = [
    {
      label: 'Standard PayGo / img',
      icon: 'cost',
      dir: 'lower',
      hint: '↓ lower is better',
      get: (r) => Math.max(r.standardPayGoCostUsd || 0, 0),
      fmt: (v) => fmtCost(v),
    },
  ];

  if (showOffPeak) {
    metrics.push({
      label: 'Off-Peak PayGo / img',
      icon: 'cost',
      dir: 'lower',
      hint: '↓ lower is better (-50% on 2.1)',
      get: (r) => Math.max(r.offPeakPayGoCostUsd || 0, 0),
      fmt: (v) => fmtCost(v),
    });
  }

  metrics.push(
    {
      label: 'Wall time',
      icon: 'time',
      dir: 'lower',
      hint: '↓ lower is better (measured)',
      get: (r) => Math.max(r.latencySec || 0, 0),
      fmt: (v) => (v > 0 ? v.toFixed(1) + 's' : '—'),
    },
    {
      label: 'Output resolution',
      icon: 'correct',
      dir: 'higher',
      hint: '↑ higher MP is sharper for print',
      get: (r) => Math.max(r.megapixels || 0, 0),
      fmt: (v) => v.toFixed(2) + ' MP',
    },
    {
      label: 'Image output tokens',
      icon: 'len',
      dir: 'neutral',
      hint: `${IMG_SELECTED_SIZE} token footprint · neutral`,
      get: (r) => Math.max(r.imageOutputTokens || 0, 0),
      fmt: (v) => fmtInt(Math.round(v)),
    }
  );

  gridEl.innerHTML = metrics.map((m) => {
    const vals = scored.map((r) => ({ r, v: m.get(r) }));
    const body = (view === 'scale' && m.dir !== 'neutral') ? mpScale(m, vals) : mpBars(m, vals, scored.length);
    return `<div class="metric-panel" data-n="${scored.length}">${mpHead(m)}${body}</div>`;
  }).join('');
}

// ---------- Interactive Peak Holiday Volume & Off-Peak PayGo Modeler ----------
function renderImageEconomicsModeler() {
  const econSec = $('#imgEconomicsSection');
  if (!IMG_CONFIG || !hasLiveImageResults()) {
    if (econSec) econSec.classList.add('hidden');
    return;
  }
  const volSlider = $('#imgVolumeSlider');
  const offPeakSlider = $('#imgOffPeakSlider');
  const offPeakSliderCard = $('#imgOffPeakSliderCard');
  const offPeakTh = $('#imgEconOffPeakTh');
  const econTitle = $('#imgEconTitle');
  const volLabel = $('#imgVolumeLabel');
  const offPeakLabel = $('#imgOffPeakLabel');
  const kpiGrid = $('#imgEconKpiGrid');
  const tbody = $('#imgEconTableBody');
  if (!volSlider || !offPeakSlider || !kpiGrid || !tbody) return;

  const showOffPeak = hasOffPeakModelSelected();
  if (offPeakSliderCard) offPeakSliderCard.classList.toggle('hidden', !showOffPeak);
  if (offPeakTh) offPeakTh.classList.toggle('hidden', !showOffPeak);
  if (econTitle) {
    econTitle.textContent = showOffPeak
      ? 'Purchasing Tiers, SLA Routing & Peak Holiday Volume Modeler'
      : 'Purchasing Tiers, SLA Routing & Peak Volume Modeler (Selected Models)';
  }

  const volume = Number(volSlider.value) || 1_000_000;
  const offPeakPct = showOffPeak ? (Number(offPeakSlider.value) || 60) : 0;
  const offPeakShare = offPeakPct / 100;
  const syncShare = 1 - offPeakShare;

  if (volLabel) volLabel.textContent = `${fmtInt(volume)} images (${IMG_SELECTED_SIZE})`;
  if (offPeakLabel) offPeakLabel.textContent = `${offPeakPct}% Off-Peak Batch · ${100 - offPeakPct}% Real-Time Sync`;

  const fmtUsdBig = (n) => '$' + Math.round(n).toLocaleString('en-US');

  // Strictly model ONLY completed live results in IMG_SLOTS
  const activeRows = IMG_SLOTS.map((s) => {
    const c = getImgCatalogItem(s.catalogId);
    if (!c) return null;
    const live = (IMG_LAST_RESULTS || []).find(
      (r) => r && r.ok && r.slot === s.slot && r.catalogId === c.id
    );
    if (!live) return null;
    const stdPerImg = Number(live.standardPayGoCostUsd || 0);
    const hasOffPeak = Boolean(live.offPeakSupported || (c.pricing && c.pricing.offPeakDiscount > 0));
    const offPeakPerImg = hasOffPeak
      ? Number(live.offPeakPayGoCostUsd != null ? live.offPeakPayGoCostUsd : stdPerImg * (1 - ((c.pricing && c.pricing.offPeakDiscount) || 0.5)))
      : null;
    const blendedVolCost = (showOffPeak && hasOffPeak)
      ? (volume * syncShare * stdPerImg) + (volume * offPeakShare * offPeakPerImg)
      : (volume * stdPerImg);
    const tokEst = `${fmtInt(live.imageOutputTokens || 0)} tok (measured)`;
    const resCap = `${live.width || '?'}×${live.height || '?'} (${live.megapixels || '?'} MP)`;
    return {
      slot: s.slot,
      catalog: c,
      stdPerImg,
      hasOffPeak,
      offPeakPerImg,
      blendedVolCost,
      tokEst,
      resCap,
    };
  }).filter(Boolean);

  if (!activeRows.length) {
    if (econSec) econSec.classList.add('hidden');
    return;
  }
  if (econSec) econSec.classList.remove('hidden');

  const costs = activeRows.map((r) => r.blendedVolCost);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const savingsUsd = Math.max(0, maxCost - minCost);
  const savingsPct = maxCost > 0 ? Math.round((savingsUsd / maxCost) * 100) : 0;
  const bestRow = activeRows.find((r) => Math.abs(r.blendedVolCost - minCost) < 1e-6) || activeRows[0];

  const slotKpisHtml = activeRows.map((r) => {
    const isLowest = activeRows.length > 1 && savingsUsd > 1 && Math.abs(r.blendedVolCost - minCost) < 1e-6;
    const rateNote = (showOffPeak && r.hasOffPeak)
      ? `${fmtCost(r.stdPerImg)} std / ${fmtCost(r.offPeakPerImg)} off-peak (${offPeakPct}% batch)`
      : `${fmtCost(r.stdPerImg)}/img · ${r.catalog.slaBadge}`;
    return `
      <div class="img-econ-kpi ${isLowest ? 'highlight' : ''}">
        <span class="iek-label">Slot ${esc(r.slot)} · ${esc(r.catalog.label)}</span>
        <span class="iek-value">${fmtUsdBig(r.blendedVolCost)}</span>
        <span class="iek-sub">${esc(rateNote)}</span>
      </div>
    `;
  }).join('');

  const deltaKpiHtml = activeRows.length > 1
    ? `
      <div class="img-econ-kpi ${savingsUsd > 0 ? 'highlight' : ''}">
        <span class="iek-label">Projected Volume Savings (${fmtInt(volume)} imgs)</span>
        <span class="iek-value">${savingsUsd > 0 ? fmtUsdBig(savingsUsd) + ` (-${savingsPct}%)` : '$0 (Equal Rate)'}</span>
        <span class="iek-sub">${savingsUsd > 0 ? `Slot ${esc(bestRow.slot)} (${esc(bestRow.catalog.shortLabel || bestRow.catalog.label)}) vs highest-cost slot` : 'Selected models share identical per-image cost'}</span>
      </div>
    `
    : '';

  kpiGrid.innerHTML = slotKpisHtml + deltaKpiHtml;

  tbody.innerHTML = '';
  activeRows.forEach((r) => {
    const c = r.catalog;
    const color = slotColor(r.slot);
    const offPeakTdHtml = showOffPeak
      ? `<td style="font-family:'JetBrains Mono',monospace;color:${r.hasOffPeak ? 'var(--good)' : 'var(--muted)'}">${r.hasOffPeak ? fmtCost(r.offPeakPerImg) + ' (-50%)' : 'N/A (Standard / PTU)'}</td>`
      : '';
    const tr = el('tr');
    tr.innerHTML = `
      <td><span class="slot-pill" style="background:${color}22;color:${color};border-color:${color}66;margin-right:6px">Slot ${esc(r.slot)}</span><strong>${esc(c.label)}</strong><br/><span style="font-size:11px;color:var(--muted)"><code>${esc(c.model)}</code></span></td>
      <td>${esc(c.slaBadge)}<br/><span style="font-size:11px;color:var(--muted)">${esc(c.endpointBadge)}</span></td>
      <td>${esc(r.resCap)}</td>
      <td style="font-family:'JetBrains Mono',monospace">${esc(r.tokEst)}</td>
      <td style="font-family:'JetBrains Mono',monospace">${fmtCost(r.stdPerImg)}</td>
      ${offPeakTdHtml}
      <td style="font-family:'JetBrains Mono',monospace;font-weight:700">${fmtUsdBig(r.blendedVolCost)}</td>
      <td style="font-size:12px;color:var(--muted)">${esc(c.architectureGuidance)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function initImageArenaBindings() {
  const modeSwitch = $('#arenaModeSwitch');
  if (modeSwitch) {
    modeSwitch.querySelectorAll('.arena-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchArenaMode(btn.dataset.arenaMode));
    });
  }

  const vidGoImageBtn = $('#videoGoImageBtn');
  if (vidGoImageBtn) vidGoImageBtn.addEventListener('click', () => switchArenaMode('image'));
  const vidGoTextBtn = $('#videoGoTextBtn');
  if (vidGoTextBtn) vidGoTextBtn.addEventListener('click', () => switchArenaMode('text'));

  const imgHistBtn = $('#imgHistoryBtn');
  if (imgHistBtn) {
    imgHistBtn.addEventListener('click', () => openHistoryModal({ arenaTab: 'image' }));
  }

  const imgCopyBtn = $('#imgCopyPromptBtn');
  if (imgCopyBtn) {
    imgCopyBtn.addEventListener('click', () => {
      const promptEl = $('#imgPromptInput');
      const txt = (promptEl && promptEl.value) || '';
      const lbl = $('#imgCopyPromptLabel');
      copyTextToClipboard(txt).then(() => {
        if (lbl) lbl.textContent = '✓ Copied';
        setTimeout(() => { if (lbl) lbl.textContent = 'Copy prompt'; }, 1400);
      });
    });
  }

  const imgJumpBtn = $('#imgJumpScorecardBtn');
  if (imgJumpBtn) {
    imgJumpBtn.addEventListener('click', () => {
      const sc = $('#imgScorecard');
      if (sc && typeof sc.scrollIntoView === 'function') {
        sc.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  const imgPromptInput = $('#imgPromptInput');
  if (imgPromptInput) {
    imgPromptInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runImageArenaComparisonClick();
      }
    });
  }

  const lbModal = $('#imgLightboxModal');
  const lbClose = $('#imgLightboxCloseBtn');
  const lbPrev = $('#imgLightboxPrevBtn');
  const lbNext = $('#imgLightboxNextBtn');
  const lbPixel = $('#imgLightboxPixelModeBtn');
  const lbActual = $('#imgLightboxActualSizeBtn');
  const lbOpenTab = $('#imgLightboxOpenTabBtn');
  const lbImg = $('#imgLightboxImg');
  const lbStage = $('#imgLightboxStage');
  if (lbClose) lbClose.addEventListener('click', closeImageLightbox);
  if (lbPrev) lbPrev.addEventListener('click', () => stepImageLightbox(-1));
  if (lbNext) lbNext.addEventListener('click', () => stepImageLightbox(1));
  if (lbPixel) {
    lbPixel.addEventListener('click', () => {
      IMG_LIGHTBOX_PIXELATED = !IMG_LIGHTBOX_PIXELATED;
      renderImageLightboxCurrent();
    });
  }
  if (lbActual) {
    lbActual.addEventListener('click', () => {
      IMG_LIGHTBOX_ACTUAL_SIZE = !IMG_LIGHTBOX_ACTUAL_SIZE;
      applyLightboxSizing();
    });
  }
  if (lbOpenTab) {
    lbOpenTab.addEventListener('click', openCurrentLightboxImageInNewTab);
  }
  if (lbImg) {
    lbImg.addEventListener('click', (e) => {
      e.stopPropagation();
      closeImageLightbox();
    });
  }
  if (lbStage) {
    lbStage.addEventListener('click', (e) => {
      e.stopPropagation();
      closeImageLightbox();
    });
  }
  if (lbModal) {
    lbModal.addEventListener('click', (e) => {
      if (e.target.closest('.img-lightbox-actions')) return;
      closeImageLightbox();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (!lbModal || lbModal.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeImageLightbox();
    else if (e.key === 'ArrowLeft') stepImageLightbox(-1);
    else if (e.key === 'ArrowRight') stepImageLightbox(1);
  });

  const addSlotBtn = $('#imgAddSlotBtn');
  if (addSlotBtn) {
    addSlotBtn.addEventListener('click', () => {
      if (!IMG_CONFIG) return;
      if (IMG_RUNNING) return; // lineup is frozen while images are generating (1.5)
      const catalog = IMG_CONFIG.catalog || [];
      const maxActive = Math.min(4, Math.max(1, catalog.length));
      if (IMG_SLOTS.length >= maxActive) return;
      const used = new Set(IMG_SLOTS.map((s) => s.catalogId));
      const nextCat = catalog.find((c) => !used.has(c.id)) || catalog[0];
      if (!nextCat) return;
      const nextSlot = String.fromCharCode(65 + IMG_SLOTS.length);
      IMG_SLOTS.push({ slot: nextSlot, catalogId: nextCat.id });
      IMG_LAST_RESULTS = [];
      renderImageSlotsConfigurator();
      renderImageArenaPlaceholderCards();
      updateSplitCurtainView();
      renderImageMetricComparison();
      renderImageEconomicsModeler();
    });
  }

  document.querySelectorAll('.img-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (IMG_RUNNING) return; // lineup is frozen while images are generating (1.5)
      const p = btn.dataset.imgPreset;
      if (p === 'nb2-vs-21') {
        IMG_SLOTS = [
          { slot: 'A', catalogId: 'gemini-3.1-flash-image' },
          { slot: 'B', catalogId: 'gemini-nano-banana-2.1' },
        ];
      } else if (p === 'lite-2-21') {
        IMG_SLOTS = [
          { slot: 'A', catalogId: 'gemini-3.1-flash-lite-image' },
          { slot: 'B', catalogId: 'gemini-3.1-flash-image' },
          { slot: 'C', catalogId: 'gemini-nano-banana-2.1' },
        ];
      } else if (p === 'all-three') {
        IMG_SLOTS = [
          { slot: 'A', catalogId: 'gemini-3.1-flash-image' },
          { slot: 'B', catalogId: 'gemini-nano-banana-2.1' },
          { slot: 'C', catalogId: 'gemini-3-pro-image' },
        ];
      } else if (p === 'all-four') {
        IMG_SLOTS = [
          { slot: 'A', catalogId: 'gemini-3.1-flash-lite-image' },
          { slot: 'B', catalogId: 'gemini-3.1-flash-image' },
          { slot: 'C', catalogId: 'gemini-nano-banana-2.1' },
          { slot: 'D', catalogId: 'gemini-3-pro-image' },
        ];
      }
      IMG_LAST_RESULTS = [];
      renderImageSlotsConfigurator();
      renderImageArenaPlaceholderCards();
      updateSplitCurtainView();
      renderImageMetricComparison();
      renderImageEconomicsModeler();
    });
  });

  const imgMvToggle = $('#imgMetricViewToggle');
  if (imgMvToggle) {
    imgMvToggle.addEventListener('click', (e) => {
      const b = e.target.closest('.mv-btn');
      if (!b) return;
      setMetricView(b.dataset.view);
      renderImageMetricComparison();
      // The Bars/Scale view is shared with the text scorecard; keep it in sync when one exists (2.11).
      if (_lastScored && _lastScored.scored) renderMetricGrid(_lastScored.scored, _lastScored.isCustom);
    });
  }

  const addRefBtn = $('#imgAddRefBtn');
  const refInput = $('#imgRefFileInput');
  if (addRefBtn && refInput) {
    addRefBtn.addEventListener('click', () => refInput.click());
    refInput.addEventListener('change', () => {
      addImageReferenceFiles(refInput.files);
      refInput.value = '';
    });
  }

  const clearRefsBtn = $('#imgClearRefsBtn');
  if (clearRefsBtn) {
    clearRefsBtn.addEventListener('click', () => {
      IMG_REF_ATTACHMENTS = [];
      renderImageReferenceAttachments();
      renderImageSlotsConfigurator();
      updateSplitCurtainView();
    });
  }

  const reloadRefsBtn = $('#imgReloadSampleRefsBtn');
  if (reloadRefsBtn) {
    reloadRefsBtn.addEventListener('click', () => {
      IMG_REF_ATTACHMENTS = IMG_CURRENT_SCENARIO_REFS.map((a) => ({ ...a }));
      renderImageReferenceAttachments();
      renderImageSlotsConfigurator();
      updateSplitCurtainView();
    });
  }

  const dropzone = $('#imgDropzone');
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files) addImageReferenceFiles(e.dataTransfer.files);
    });
  }

  const curtainBtn = $('#imgSplitCurtainBtn');
  if (curtainBtn) {
    curtainBtn.addEventListener('click', () => {
      if (curtainBtn.disabled) return;
      IMG_SPLIT_CURTAIN_ON = !IMG_SPLIT_CURTAIN_ON;
      curtainBtn.classList.toggle('is-on', IMG_SPLIT_CURTAIN_ON);
      curtainBtn.setAttribute('aria-pressed', String(IMG_SPLIT_CURTAIN_ON));
      updateSplitCurtainView();
    });
  }

  const runBtn = $('#imgRunBtn');
  if (runBtn) runBtn.addEventListener('click', runImageArenaComparisonClick);

  const volSlider = $('#imgVolumeSlider');
  const offPeakSlider = $('#imgOffPeakSlider');
  if (volSlider) volSlider.addEventListener('input', renderImageEconomicsModeler);
  if (offPeakSlider) offPeakSlider.addEventListener('input', renderImageEconomicsModeler);

  initCurtainDrag();
  updateImageHistoryButton();

  // Check URL deep link (?tab=image, ?tab=video, ?tab=3d, #image-arena, #video-arena, #3d-arena)
  try {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab') || params.get('mode');
    if (tabParam === 'image' || window.location.hash === '#image-arena') {
      switchArenaMode('image', { updateUrl: false });
    } else if (tabParam === 'video' || window.location.hash === '#video-arena') {
      switchArenaMode('video', { updateUrl: false });
    } else if (tabParam === '3d' || tabParam === 'cad' || window.location.hash === '#3d-arena') {
      switchArenaMode('3d', { updateUrl: false });
    }
  } catch (_) { /* ignore */ }
}

// ============================================================================
// 🧊 3D & CAD Engineering Arena Subsystem
// - Lockstep synced 3D camera across Slots A, B, C, D... (ON by default, toggleable)
// - Interactive CAD/CSG WebGL viewport in each slot (`cad-runner.html`)
// - Follow-up modification loop with automatic 4-angle viewport vision input
// - Per-slot revision history stepper (v1, v2, v3...)
// - Headless CAD / Autodesk Fusion 360 MCP bridge modal
// ============================================================================

let CAD_CAMERA_SYNC_ON = true; // Lockstep synced camera across slots ON by default
let CAD_SPIN_3AXIS_ON = true; // Simultaneous X+Y+Z 3-axis gimbal spin across slots (ON by default)
let CAD_TURNTABLE_ON = false; // Horizontal turntable spin across slots
let CAD_SPIN_EPOCH_MS = Date.now(); // Shared wall-clock epoch (ms) so slots finishing at different times spin in exact phase
let CAD_LAST_SHARED_CAMERA = null;
const CAD_SLOT_STATE = {}; // slot -> { code, telemetry, fourViewDataUrl, revisions: [{rev, code, telemetry, fourViewDataUrl, note, at}], activeRevIndex, targetPartName, iframe, ready }

function ensureCadSlotState(slot) {
  if (!CAD_SLOT_STATE[slot]) {
    CAD_SLOT_STATE[slot] = {
      code: '',
      telemetry: null,
      fourViewDataUrl: null,
      revisions: [],
      activeRevIndex: -1,
      targetPartName: '',
      iframe: null,
      ready: false,
      awaitingRun: false, // true between a CAD_RUN_CODE we sent and its telemetry/error reply
    };
  }
  return CAD_SLOT_STATE[slot];
}

function resetAllCadSlotStates() {
  Object.keys(CAD_SLOT_STATE).forEach((s) => {
    delete CAD_SLOT_STATE[s];
  });
  CAD_SPIN_EPOCH_MS = Date.now();
  CAD_TURNTABLE_ON = false;
  CAD_LAST_SHARED_CAMERA = null;
  updateCadTargetChip('');
  syncCadModifyBarVisibility();
}

// Keep at most this many revisions per slot in memory; older ones drop their
// 4-view PNG data URL (each is a multi-MB string) so a long Modify session
// cannot grow the tab without bound (6.8 / 1.7).
const CAD_MAX_REVISIONS = 10;
function pushCadRevision(st, rev) {
  st.revisions.push(rev);
  if (st.revisions.length > CAD_MAX_REVISIONS) {
    st.revisions.splice(0, st.revisions.length - CAD_MAX_REVISIONS);
  }
  // Only the newest revision keeps its full-resolution 4-view render.
  st.revisions.forEach((r, i) => { if (i < st.revisions.length - 1) r.fourViewDataUrl = null; });
  st.activeRevIndex = st.revisions.length - 1;
}

// SECURITY (3.6): map a `message` event back to the CAD slot whose iframe sent it.
// The runner frame is sandboxed without allow-same-origin, so its origin is the
// string 'null'; we never trust `msg.slot` (any frame could forge it) and only
// accept windows we created ourselves.
function cadSlotForSource(source) {
  if (!source) return null;
  const slots = Object.keys(CAD_SLOT_STATE);
  for (let i = 0; i < slots.length; i++) {
    const st = CAD_SLOT_STATE[slots[i]];
    if (st && st.iframe && st.iframe.contentWindow === source) return slots[i];
  }
  return null;
}

function isTrustedCadMessageEvent(ev) {
  if (!ev) return false;
  if (ev.origin !== 'null' && ev.origin !== window.location.origin) return false;
  return Boolean(cadSlotForSource(ev.source));
}

// Telemetry comes from a frame that just executed LLM-generated code, so treat
// it as untrusted: keep only finite numbers, booleans and short strings.
function sanitizeCadTelemetry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const vec3 = (arr) => {
    if (!Array.isArray(arr) || arr.length < 3) return null;
    const out = arr.slice(0, 3).map(num);
    return out.every((n) => n != null) ? out : null;
  };
  const bbSrc = Array.isArray(raw.boundingBoxMm)
    ? raw.boundingBoxMm
    : (raw.boundingBox && Array.isArray(raw.boundingBox.size) ? raw.boundingBox.size : null);
  const t = {
    partCount: num(raw.partCount),
    triangleCount: num(raw.triangleCount),
    vertexCount: num(raw.vertexCount),
    boundingBoxMm: vec3(bbSrc),
    minMm: vec3(raw.minMm),
    maxMm: vec3(raw.maxMm),
    volumeCm3: num(raw.volumeCm3),
    volumeMm3: num(raw.volumeMm3),
    surfaceAreaCm2: num(raw.surfaceAreaCm2),
    // null = the kernel could not verify manifoldness ("unverified"), not "open".
    watertight: raw.watertight === null || raw.watertight === undefined ? null : Boolean(raw.watertight),
    // CSG results are an approximation in the browser kernel; the strip and the
    // judge-facing telemetry both carry the flag so nobody reads volume as exact.
    csgApprox: Boolean(raw.csgApprox),
    nonManifoldEdges: num(raw.nonManifoldEdges),
  };
  if (Array.isArray(raw.partNames)) {
    t.partNames = raw.partNames
      .filter((p) => typeof p === 'string' && p.trim())
      .slice(0, 64)
      .map((p) => p.trim().slice(0, 80));
  }
  return t;
}

// A 4-view render must be a bounded PNG/JPEG/WebP data URL (it is forwarded to
// the model as a vision attachment and shown in the UI).
const CAD_FOUR_VIEW_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
function sanitizeCadFourView(v) {
  if (typeof v !== 'string' || v.length < 32 || v.length > 12 * 1024 * 1024) return null;
  return CAD_FOUR_VIEW_RE.test(v) ? v : null;
}

// Every CAD_RUN_CODE we send is a round trip we initiated. Only the telemetry
// that answers one of these may clear a slot's crash banner (1.8 / 3.6); a
// spontaneous telemetry re-emit after a failed rebuild must not.
function postCadRunCode(slot, code, extra) {
  const st = ensureCadSlotState(slot);
  if (!st.iframe || !st.iframe.contentWindow) return false;
  st.awaitingRun = true;
  try {
    st.iframe.contentWindow.postMessage(Object.assign({
      type: 'CAD_RUN_CODE',
      slot,
      label: modelLabel(slot),
      sync: CAD_CAMERA_SYNC_ON,
      spinEpochMs: CAD_SPIN_EPOCH_MS,
      spin3Axis: CAD_SPIN_3AXIS_ON,
      turntable: CAD_TURNTABLE_ON,
      cameraState: CAD_CAMERA_SYNC_ON ? CAD_LAST_SHARED_CAMERA : null,
      code,
      autoCapture4View: true,
    }, extra || {}), '*');
    return true;
  } catch (_) {
    st.awaitingRun = false;
    return false;
  }
}

// Render the per-slot telemetry strip from sanitized numbers only (3.2).
function renderCadTelemetryStrip(slot, t) {
  const strip = $(`#cad-telem-${slot}`);
  if (!strip || !t) return;
  const bb = t.boundingBoxMm || [0, 0, 0];
  const sz = bb.map((n) => Number(n || 0).toFixed(1)).join('×');
  const volText = t.volumeCm3 != null
    ? `${Number(t.volumeCm3).toFixed(2)} cm³`
    : `${fmtInt(Math.round(t.volumeMm3 || 0))} mm³`;
  strip.textContent = '';
  const badge = document.createElement('span');
  if (t.watertight === null) {
    // The kernel could not run its manifold check (e.g. a CSG result): say so
    // instead of claiming either outcome.
    badge.className = 'cad-badge-warn';
    badge.title = 'Mesh integrity could not be verified by the browser kernel';
    badge.textContent = '? Unverified';
  } else {
    badge.className = t.watertight ? 'cad-badge-ok' : 'cad-badge-warn';
    badge.title = t.watertight
      ? 'Manifold watertight 3D mesh'
      : (t.nonManifoldEdges != null ? `${fmtInt(t.nonManifoldEdges)} open or non-manifold edges detected` : 'Open or non-manifold edges detected');
    badge.textContent = t.watertight ? '✓ Watertight' : '⚠ Check Mesh';
  }
  strip.appendChild(badge);
  const addText = (s) => strip.appendChild(document.createTextNode(s));
  const addBold = (s) => { const b = document.createElement('b'); b.textContent = s; strip.appendChild(b); };
  addText(' · ');
  addBold(fmtInt(t.partCount || 0));
  addText(' parts · ');
  addBold(fmtInt(t.triangleCount || 0));
  addText(' tris · BBox ');
  addBold(sz);
  addText(' mm · Vol ');
  addBold(volText);
  if (t.csgApprox) {
    addText(' ');
    const approx = document.createElement('span');
    approx.className = 'cad-badge-warn';
    approx.title = 'Boolean (CSG) operations are approximated in the browser kernel; volume and watertightness are estimates';
    approx.textContent = '≈ approx CSG';
    strip.appendChild(approx);
  }
}

function extractCadJsCode(rawText) {
  let s = String(rawText || '');
  const fence = s.match(/```(?:javascript|js|ts|cad)?[ \t]*\r?\n([\s\S]*?)```/i)
    || s.match(/```[a-zA-Z0-9+#.-]*[ \t]*\r?\n?([\s\S]*?)```/);
  if (fence && fence[1]) s = fence[1];
  return s.trim();
}

function syncCadModifyBarVisibility() {
  const bar = $('#cadModifyBar');
  if (!bar) return;
  const isCad = isCadActiveTask();
  bar.classList.toggle('hidden', !isCad);
  if (isCad) {
    updateCadSyncCamButtonUi();
    updateCadSpin3AxisButtonUi();
    syncCadScopeSelectOptions();
  }
}

function syncCadScopeSelectOptions() {
  const sel = $('#cadModifyScopeSelect');
  if (!sel) return;
  const prev = sel.value || 'all';
  sel.innerHTML = `<option value="all">Modify All Active Slots</option>` +
    MODELS.map((m) => `<option value="${esc(m.slot)}">Slot ${esc(m.slot)} only (${esc(m.shortLabel || m.label || m.catalogId)})</option>`).join('');
  if (prev === 'all' || MODELS.some((m) => m.slot === prev)) sel.value = prev;
}

function updateCadSyncCamButtonUi() {
  const btn = $('#cadSyncCamBtn');
  if (btn) {
    btn.classList.toggle('is-on', CAD_CAMERA_SYNC_ON);
    btn.setAttribute('aria-pressed', String(CAD_CAMERA_SYNC_ON));
    btn.innerHTML = `<span class="ar-led"></span>${CAD_CAMERA_SYNC_ON ? '🔗 Synced Camera: ON (Lockstep A↔B↔C↔D)' : '🔓 Synced Camera: OFF (Independent)'}`;
  }
  // Broadcast sync state to all mounted CAD iframes
  document.querySelectorAll('iframe.cad-frame').forEach((ifr) => {
    try {
      if (ifr.contentWindow) {
        ifr.contentWindow.postMessage({
          type: 'CAD_SET_SYNC_STATE',
          enabled: CAD_CAMERA_SYNC_ON,
          sync: CAD_CAMERA_SYNC_ON,
          spinEpochMs: CAD_SPIN_EPOCH_MS,
        }, '*');
      }
    } catch (_) { /* ignore */ }
  });
}

function setCadCameraSyncState(nextSync) {
  CAD_CAMERA_SYNC_ON = Boolean(nextSync);
  updateCadSyncCamButtonUi();
  if (CAD_CAMERA_SYNC_ON) {
    document.querySelectorAll('iframe.cad-frame').forEach((ifr) => {
      try {
        if (ifr.contentWindow) {
          if (CAD_LAST_SHARED_CAMERA) {
            ifr.contentWindow.postMessage({
              type: 'CAD_APPLY_CAMERA',
              cameraState: CAD_LAST_SHARED_CAMERA,
              camera: CAD_LAST_SHARED_CAMERA,
            }, '*');
          }
          ifr.contentWindow.postMessage({
            type: 'CAD_SET_SPIN_3AXIS',
            enabled: CAD_SPIN_3AXIS_ON,
            spinEpochMs: CAD_SPIN_EPOCH_MS,
          }, '*');
        }
      } catch (_) { /* ignore */ }
    });
  }
}

function updateCadSpin3AxisButtonUi() {
  const btn = $('#cadSpin3AxisBtn');
  if (btn) {
    btn.classList.toggle('is-on', CAD_SPIN_3AXIS_ON);
    btn.setAttribute('aria-pressed', String(CAD_SPIN_3AXIS_ON));
    btn.innerHTML = `<span class="ar-led"></span>${CAD_SPIN_3AXIS_ON ? '🔄 3-Axis Spin: ON (X+Y+Z)' : '🔄 3-Axis Spin: OFF'}`;
  }
}

function setCadSpin3AxisState(nextSpin, angles = null, sourceWin = null) {
  CAD_SPIN_3AXIS_ON = Boolean(nextSpin);
  if (CAD_SPIN_3AXIS_ON) {
    CAD_TURNTABLE_ON = false;
  }
  updateCadSpin3AxisButtonUi();
  document.querySelectorAll('iframe.cad-frame').forEach((ifr) => {
    try {
      if (ifr.contentWindow && (!sourceWin || ifr.contentWindow !== sourceWin)) {
        ifr.contentWindow.postMessage({
          type: 'CAD_SET_SPIN_3AXIS',
          enabled: CAD_SPIN_3AXIS_ON,
          angles: angles || null,
          spinEpochMs: CAD_SPIN_EPOCH_MS,
        }, '*');
      }
    } catch (_) { /* ignore */ }
  });
}

function updateCadTargetChip(partName, sourceSlot) {
  const chip = $('#cadTargetPartBadge') || $('#cadTargetChip');
  if (!chip) return;
  const clean = String(partName || '').trim();
  Object.keys(CAD_SLOT_STATE).forEach((s) => {
    CAD_SLOT_STATE[s].targetPartName = clean;
  });
  if (clean) {
    chip.classList.remove('hidden', 'is-empty');
    chip.innerHTML = `🎯 Target: <b>@${esc(clean)}</b>${sourceSlot ? ` <span class="cad-chip-slot">(Slot ${esc(sourceSlot)})</span>` : ''} <span class="cad-chip-clear" title="Clear target part">✕</span>`;
    chip.onclick = () => updateCadTargetChip('');
  } else {
    chip.classList.add('hidden');
    chip.textContent = '';
  }
}

function renderCadRevisionBar(slot) {
  const bar = document.querySelector(`#col-${slot} .cad-rev-bar`);
  const st = CAD_SLOT_STATE[slot];
  if (!bar || !st) return;
  if (!st.revisions || st.revisions.length <= 1) {
    bar.innerHTML = `<span class="cad-rev-tag">v1 (Initial build)</span>`;
    return;
  }
  const pills = st.revisions.map((r, idx) => {
    const active = idx === st.activeRevIndex;
    const title = r.note ? `v${r.rev}: ${r.note}` : `Revision v${r.rev}`;
    return `<button type="button" class="cad-rev-btn${active ? ' is-active' : ''}" data-slot="${esc(slot)}" data-rev-idx="${idx}" title="${esc(title)}">v${r.rev}</button>`;
  }).join('');
  const cur = st.revisions[st.activeRevIndex] || st.revisions[st.revisions.length - 1];
  const noteTxt = cur && cur.note ? `<span class="cad-rev-note" title="${esc(cur.note)}">${esc(cur.note)}</span>` : '';
  bar.innerHTML = `<span class="cad-rev-lbl">Revisions:</span><div class="cad-rev-pills">${pills}</div>${noteTxt}`;
  bar.querySelectorAll('.cad-rev-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const idx = parseInt(b.dataset.revIdx, 10);
      const revObj = st.revisions[idx];
      if (!revObj) return;
      st.activeRevIndex = idx;
      st.code = revObj.code;
      const codeNode = $(`#code-${slot}`);
      if (codeNode) codeNode.textContent = revObj.code;
      renderCadRevisionBar(slot);
      postCadRunCode(slot, revObj.code);
    });
  });
}

async function runCad3dViewport(slot, rawCodeText, btnOrOpts, outEl, vizEl) {
  const code = extractCadJsCode(rawCodeText || (($(`#code-${slot}`) || {}).textContent || ''));
  const colEl = $(`#col-${slot}`);
  const out = outEl || $(`#exec-out-${slot}`);
  const viz = vizEl || $(`#exec-viz-${slot}`);
  const opts = (btnOrOpts && typeof btnOrOpts === 'object' && !(btnOrOpts instanceof Element)) ? btnOrOpts : {};
  if (!code || !viz) return;

  const st = ensureCadSlotState(slot);
  st.code = code;

  // Record revision if new or first
  const lastRev = st.revisions.length ? st.revisions[st.revisions.length - 1] : null;
  if (!lastRev || lastRev.code !== code) {
    const nextNum = (lastRev ? lastRev.rev : 0) + 1;
    pushCadRevision(st, {
      rev: nextNum,
      code,
      telemetry: null,
      fourViewDataUrl: null,
      note: opts.revisionNote || (nextNum === 1 ? 'Initial 3D generation' : `Modification #${nextNum - 1}`),
      at: Date.now(),
    });
  }

  if (out) out.classList.add('hidden');
  viz.classList.remove('hidden');
  if (colEl) colEl.classList.add('game-code-collapsed');
  syncCadModifyBarVisibility();

  const label = modelLabel(slot);
  let ifr = viz.querySelector('iframe.cad-frame');
  if (!ifr) {
    // SECURITY: cad-runner.html hardens window.parent, window.top, localStorage,
    // sessionStorage, indexedDB, document.cookie, fetch, and XMLHttpRequest before
    // any CAD script runs, while allow-same-origin ensures Google Corp UberProxy
    // forwards auth cookies on ES module imports (/vendor/three/*, /cad-kernel.js).
    const cadBust = (CONFIG && (CONFIG.assetVersion || CONFIG.version)) || Date.now();
    viz.innerHTML =
      `<div class="cad-viz-wrap">` +
        `<iframe class="cad-frame" src="/cad-runner.html?slot=${encodeURIComponent(slot)}&label=${encodeURIComponent(label)}&sync=${CAD_CAMERA_SYNC_ON ? '1' : '0'}&spinEpoch=${encodeURIComponent(CAD_SPIN_EPOCH_MS)}&v=${encodeURIComponent(cadBust)}" ` +
          `title="3D CAD Viewport - ${esc(label)}" sandbox="allow-scripts allow-same-origin allow-downloads"></iframe>` +
      `</div>` +
      `<div class="cad-bar">` +
        `<div class="cad-rev-bar"></div>` +
        `<div class="cad-telemetry-strip" id="cad-telem-${esc(slot)}">Compiling 3D solid &amp; manifold telemetry…</div>` +
        `<div class="cad-bar-actions">` +
          `<button type="button" class="cad-code-toggle" data-slot="${esc(slot)}" title="Toggle parametric Three.js / CAD source code">&lt;/&gt; Show code</button>` +
          `<button type="button" class="cad-mcp-slot-btn" data-slot="${esc(slot)}" title="Export this slot to Autodesk Fusion 360 Python API / Headless CAD MCP">🔌 Fusion 360</button>` +
        `</div>` +
      `</div>`;
    ifr = viz.querySelector('iframe.cad-frame');
    st.iframe = ifr;
    st.ready = false;

    const toggleBtn = viz.querySelector('.cad-code-toggle');
    if (toggleBtn && colEl) {
      toggleBtn.addEventListener('click', () => {
        const collapsed = colEl.classList.toggle('game-code-collapsed');
        toggleBtn.innerHTML = collapsed ? '&lt;/&gt; Show code' : '&lt;/&gt; Hide code';
      });
    }
    const mcpSlotBtn = viz.querySelector('.cad-mcp-slot-btn');
    if (mcpSlotBtn) {
      mcpSlotBtn.addEventListener('click', () => openCadMcpModal(slot));
    }
  } else {
    st.iframe = ifr;
    if (st.ready && ifr.contentWindow) {
      postCadRunCode(slot, st.code);
    }
  }
  renderCadRevisionBar(slot);
}

function handleCadViewportMessage(ev) {
  const msg = ev && ev.data;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string' || !msg.type.startsWith('CAD_')) return;
  // SECURITY (3.6): the slot is derived from the sending window, never from msg.slot,
  // and messages from windows we did not create (other frames, forged sources) are dropped.
  if (!isTrustedCadMessageEvent(ev)) return;
  const slot = cadSlotForSource(ev.source);
  if (!slot) return;
  const st = ensureCadSlotState(slot);

  if (msg.type === 'CAD_VIEWPORT_READY') {
    st.ready = true;
    if (st.iframe && st.iframe.contentWindow) {
      st.iframe.contentWindow.postMessage({
        type: 'CAD_SET_SYNC_STATE',
        enabled: CAD_CAMERA_SYNC_ON,
        sync: CAD_CAMERA_SYNC_ON,
        spinEpochMs: CAD_SPIN_EPOCH_MS,
      }, '*');
      if (st.code) {
        postCadRunCode(slot, st.code);
      }
      st.iframe.contentWindow.postMessage({
        type: 'CAD_SET_SPIN_3AXIS',
        enabled: CAD_SPIN_3AXIS_ON,
        spinEpochMs: CAD_SPIN_EPOCH_MS,
      }, '*');
      if (CAD_TURNTABLE_ON) {
        st.iframe.contentWindow.postMessage({
          type: 'CAD_SET_TURNTABLE',
          enabled: CAD_TURNTABLE_ON,
        }, '*');
      }
    }
    return;
  }

  if (msg.type === 'CAD_SPIN_3AXIS_CHANGE') {
    const nextSpin = Boolean(msg.enabled);
    if (CAD_CAMERA_SYNC_ON) {
      setCadSpin3AxisState(nextSpin, msg.angles || null, ev.source);
    } else {
      CAD_SPIN_3AXIS_ON = nextSpin;
      updateCadSpin3AxisButtonUi();
    }
    return;
  }

  if (msg.type === 'CAD_TURNTABLE_CHANGE') {
    const nextTurntable = Boolean(msg.enabled);
    if (CAD_CAMERA_SYNC_ON) {
      CAD_TURNTABLE_ON = nextTurntable;
      if (nextTurntable) {
        CAD_SPIN_3AXIS_ON = false;
        updateCadSpin3AxisButtonUi();
      }
      document.querySelectorAll('iframe.cad-frame').forEach((ifr) => {
        try {
          if (ifr.contentWindow && ifr.contentWindow !== ev.source) {
            ifr.contentWindow.postMessage({
              type: 'CAD_SET_TURNTABLE',
              enabled: nextTurntable,
            }, '*');
          }
        } catch (_) { /* ignore */ }
      });
    }
    return;
  }

  if (msg.type === 'CAD_CAMERA_CHANGE' && (msg.cameraState || msg.camera)) {
    const cam = msg.cameraState || msg.camera;
    CAD_LAST_SHARED_CAMERA = cam;
    if (!CAD_CAMERA_SYNC_ON) return;
    document.querySelectorAll('iframe.cad-frame').forEach((ifr) => {
      try {
        if (ifr.contentWindow && ifr.contentWindow !== ev.source) {
          ifr.contentWindow.postMessage({
            type: 'CAD_APPLY_CAMERA',
            cameraState: cam,
            camera: cam,
          }, '*');
        }
      } catch (_) { /* ignore */ }
    });
    return;
  }

  if (msg.type === 'CAD_TOGGLE_SYNC_REQUEST') {
    const nextState = typeof msg.enabled === 'boolean' ? msg.enabled : !CAD_CAMERA_SYNC_ON;
    setCadCameraSyncState(nextState);
    return;
  }

  if (msg.type === 'CAD_TELEMETRY') {
    const t = sanitizeCadTelemetry(msg.telemetry);
    const fourView = sanitizeCadFourView(msg.fourViewDataUrl);
    st.telemetry = t || null;
    if (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)) st.params = msg.params;
    if (fourView) st.fourViewDataUrl = fourView;
    const curRev = st.revisions[st.activeRevIndex];
    if (curRev) {
      if (t) curRev.telemetry = t;
      if (fourView) curRev.fourViewDataUrl = fourView;
    }
    if (t) {
      // Only a reply to a CAD_RUN_CODE we sent counts as a successful rebuild;
      // a stale re-emit after a failed build must not hide the crash banner (1.8).
      if (st.awaitingRun) {
        st.awaitingRun = false;
        clearCrash(slot);
      }
      renderCadTelemetryStrip(slot, t);
    }
    return;
  }

  if (msg.type === 'CAD_ERROR') {
    st.awaitingRun = false;
    const errMsg = String(msg.error || '3D CAD script error').slice(0, 4000);
    // Optional phase from the runner: compile (syntax), build (buildModel threw),
    // render (exception inside the frame loop). Shown so a render-time crash is
    // not mistaken for a bad script, and forwarded with the repair prompt.
    const phase = typeof msg.phase === 'string' && /^(compile|build|render)$/.test(msg.phase) ? msg.phase : '';
    const strip = $(`#cad-telem-${slot}`);
    if (strip) {
      strip.textContent = '';
      const badge = document.createElement('span');
      badge.className = 'cad-badge-err';
      badge.title = phase ? `Error during the ${phase} phase` : '3D CAD script error';
      badge.textContent = '✗ ' + (phase ? phase + ': ' : '') + errMsg.split('\n')[0];
      strip.appendChild(badge);
    }
    noteCrash(slot, { error: (phase ? `[${phase}] ` : '') + errMsg, source: '3d-cad' });
    return;
  }

  if ((msg.type === 'CAD_4VIEW_SNAPSHOT' || msg.type === 'CAD_FOUR_VIEW_READY') && (msg.dataUrl || msg.fourViewDataUrl)) {
    const dUrl = sanitizeCadFourView(msg.fourViewDataUrl || msg.dataUrl);
    if (!dUrl) return;
    st.fourViewDataUrl = dUrl;
    const curRev = st.revisions[st.activeRevIndex];
    if (curRev) curRev.fourViewDataUrl = dUrl;
    return;
  }

  if (msg.type === 'CAD_PART_SELECTED') {
    const partName = typeof msg.partName === 'string' ? msg.partName.trim().slice(0, 80) : '';
    updateCadTargetChip(partName, slot);
    const inp = $('#cadModifyInput');
    if (inp && partName) {
      const tag = `@${partName}`;
      if (!inp.value.includes(tag)) {
        inp.value = inp.value ? `${tag} ${inp.value}` : `${tag} `;
      }
      inp.focus();
    }
  }
}

function requestFresh4ViewFromSlot(slot, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const st = CAD_SLOT_STATE[slot];
    if (!st || !st.iframe || !st.iframe.contentWindow) {
      resolve((st && st.fourViewDataUrl) || null);
      return;
    }
    let settled = false;
    const onMsg = (ev) => {
      const m = ev && ev.data;
      // SECURITY (3.6): match the reply by sending window, never by m.slot.
      if (!m || !isTrustedCadMessageEvent(ev) || cadSlotForSource(ev.source) !== slot) return;
      if (
        (m.type === 'CAD_4VIEW_SNAPSHOT' || m.type === 'CAD_FOUR_VIEW_READY') &&
        (m.dataUrl || m.fourViewDataUrl)
      ) {
        const dUrl = sanitizeCadFourView(m.fourViewDataUrl || m.dataUrl);
        if (!dUrl) return;
        if (!settled) {
          settled = true;
          window.removeEventListener('message', onMsg);
          st.fourViewDataUrl = dUrl;
          resolve(dUrl);
        }
      }
    };
    window.addEventListener('message', onMsg);
    try {
      st.iframe.contentWindow.postMessage({ type: 'CAD_CAPTURE_FOUR_VIEW' }, '*');
    } catch (_) { /* ignore */ }
    setTimeout(() => {
      if (!settled) {
        settled = true;
        window.removeEventListener('message', onMsg);
        resolve(st.fourViewDataUrl || null);
      }
    }, timeoutMs);
  });
}

// Follow-up 3D modification loop: sends each slot its previous code, 3D mesh
// telemetry, optional @part_name target, AND (when checked, ON by default)
// its 4-angle viewport composite PNG render (Iso/Front/Top/Right) as a
// multimodal vision attachment (`slot-${slot}-4view-render.png` via `fourViewDataUrl`)
// so Gemini sees the current geometry alongside its code.
async function runCadModification() {
  const inp = $('#cadModifyInput');
  const modBtn = $('#cadModifySubmitBtn') || $('#cadModifyRunBtn');
  const include4ViewEl = $('#cadIncludeVisionToggle') || $('#cadInclude4ViewChk');
  const scopeSel = $('#cadModifyScopeSelect');
  const scopeVal = (scopeSel && scopeSel.value) || 'all';
  const modRequest = String((inp && inp.value) || '').trim();
  if (!modRequest) {
    if (inp) inp.focus();
    return;
  }
  const activeSlots = MODELS.filter((m) => {
    if (scopeVal !== 'all' && m.slot !== scopeVal) return false;
    const st = CAD_SLOT_STATE[m.slot];
    const domCode = (($(`#code-${m.slot}`) || {}).textContent || '').trim();
    return (st && st.code) || domCode;
  });
  if (!activeSlots.length) {
    window.alert('Generate an initial 3D model first (click Run Comparison), then submit a follow-up modification.');
    return;
  }
  // Same lifecycle as run()/rerunSlot(): one stream at a time per slot, abortable.
  if (!confirmInterruptRun('A comparison is still running. Stop it and apply this modification instead?')) return;

  const includeVision = include4ViewEl ? Boolean(include4ViewEl.checked) : true;
  const origBtnHtml = modBtn ? modBtn.innerHTML : '✨ Modify 3D Model ▸';
  if (modBtn) {
    modBtn.disabled = true;
    modBtn.textContent = includeVision ? '📸 Capturing 4-Views & Modifying…' : '✨ Modifying 3D Model…';
  }

  const modAbort = new AbortController();
  let modSlots = [];
  let own = null;
  let runOk = false;
  try {
    // 1. Capture fresh 4-angle viewport composite (Iso/Front/Top/Right) from each active slot
    if (includeVision) {
      await Promise.all(activeSlots.map((m) => requestFresh4ViewFromSlot(m.slot, 1800)));
    }

    const baseTask = currentTask();
    const bySlot = {};
    let sharedTargetPart = null;

    activeSlots.forEach((m) => {
      const slot = m.slot;
      const st = ensureCadSlotState(slot);
      const prevCode = st.code || extractCadJsCode(($(`#code-${slot}`) || {}).textContent || '');
      if (st.targetPartName && !sharedTargetPart) sharedTargetPart = st.targetPartName;
      bySlot[slot] = {
        previousCode: prevCode,
        modificationPrompt: modRequest,
        targetPart: st.targetPartName || null,
        telemetry: st.telemetry || null,
        // Attached server-side as `slot-${slot}-4view-render.png` vision input
        fourViewDataUrl: includeVision && st.fourViewDataUrl ? st.fourViewDataUrl : null,
      };
      resetStreamState(slot);
      clearCrash(slot);
      setStatus(slot, includeVision ? 'Modifying (with 4-View vision)…' : 'Modifying 3D model…', 'run');
    });

    const slotList = activeSlots.map((m) => m.slot);
    modSlots = slotList;
    own = claimSlots(slotList);
    slotList.forEach((s) => {
      const prev = SLOT_RUNS[s];
      if (prev) { try { prev.abort.abort(); } catch (_) { /* ignore */ } clearInterval(prev.timer); }
      SLOT_RUNS[s] = { abort: modAbort, timer: null };
    });
    _busy = true;
    updateRunButton();
    paintAllRerunButtons();

    const payload = {
      taskId: $('#taskSelect').value,
      taskTitle: baseTask && baseTask.title ? baseTask.title : undefined,
      arenaMode: '3d',
      maxIterations: 1,
      models: activeSlots,
      customPrompt: $('#customPrompt').value,
      attachments: currentAttachmentsPayload(),
      keys: loadKeys(),
      cadModify: {
        modificationPrompt: modRequest,
        targetPart: sharedTargetPart,
        bySlot,
      },
    };

    const st = await streamRun(payload, LAST_RESULTS, modAbort.signal, own, false, { task: baseTask, arenaMode: '3d' });
    if (st === 'quota' && window._lastQuotaMsg) {
      slotList.forEach((s) => { if (ownsSlot(own, s)) setStatus(s, esc(window._lastQuotaMsg), 'err'); });
    }
    runOk = st === 'ok';
    if (inp && runOk) inp.value = ''; // keep the request text when nothing ran (quota, busy, auth)
  } catch (err) {
    if (err && err.name === 'AbortError') {
      // Interrupted (confirmInterruptRun / a single-slot re-run took one column over):
      // the new owner paints its own column; columns still owned here get a clear end state.
      modSlots.forEach((s) => { if (ownsSlot(own, s)) setStatus(s, 'Interrupted', 'err'); });
    } else {
      window.alert('3D modification failed: ' + err.message);
    }
  } finally {
    // Only tear down the slots this modification still owns (a newer run may have taken over).
    modSlots.forEach((s) => {
      if (SLOT_RUNS[s] && SLOT_RUNS[s].abort === modAbort) delete SLOT_RUNS[s];
    });
    _busy = _fullRun || Object.keys(SLOT_RUNS).length > 0;
    if (modBtn) {
      modBtn.disabled = false;
      modBtn.innerHTML = origBtnHtml;
    }
    updateRunButton();
    paintAllRerunButtons();
  }
}

function requestStepTextFromSlot(slot, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const st = CAD_SLOT_STATE[slot];
    if (!st || !st.iframe || !st.iframe.contentWindow) {
      resolve((st && st.stepText) || '');
      return;
    }
    const curRev = st.revisions && st.revisions[st.activeRevIndex];
    if (curRev && typeof curRev.stepText === 'string' && curRev.stepText.includes('ISO-10303-21;')) {
      resolve(curRev.stepText);
      return;
    }
    let settled = false;
    const reqId = `step-mcp-${slot}-${Date.now()}`;
    const onMsg = (ev) => {
      const m = ev && ev.data;
      if (!m || !isTrustedCadMessageEvent(ev) || cadSlotForSource(ev.source) !== slot) return;
      if (m.type === 'CAD_STEP_TEXT_READY' && (!m.reqId || m.reqId === reqId)) {
        if (!settled) {
          settled = true;
          window.removeEventListener('message', onMsg);
          const txt = typeof m.stepText === 'string' ? m.stepText : '';
          if (txt.includes('ISO-10303-21;')) {
            st.stepText = txt;
            if (curRev) curRev.stepText = txt;
          }
          resolve(txt);
        }
      }
    };
    window.addEventListener('message', onMsg);
    try {
      st.iframe.contentWindow.postMessage({ type: 'CAD_EXPORT_STEP_TEXT', reqId }, '*');
    } catch (_) { /* ignore */ }
    setTimeout(() => {
      if (!settled) {
        settled = true;
        window.removeEventListener('message', onMsg);
        resolve((st && st.stepText) || '');
      }
    }, timeoutMs);
  });
}

function parseMcpHttpResponseText(rawText) {
  const txt = String(rawText || '').trim();
  if (!txt) return {};
  try {
    return JSON.parse(txt);
  } catch (_) { /* check SSE */ }
  let lastObj = null;
  for (const line of txt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (payload) {
        try { lastObj = JSON.parse(payload); } catch (_) { /* ignore */ }
      }
    }
  }
  return lastObj || { raw: txt };
}

async function pushToBrowserLocalMcp(endpointUrl, payload) {
  const cleanUrl = String(endpointUrl || 'http://127.0.0.1:27182/mcp').trim() || 'http://127.0.0.1:27182/mcp';
  const fusionScript = payload.fusionScript || '';

  const mcpPost = async (url, bodyObj, sessionId = null, timeoutMs = 20000) => {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }
    const resp = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers,
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id') || sessionId;
    const text = await resp.text();
    const parsed = parseMcpHttpResponseText(text);
    return { ok: resp.ok, status: resp.status, sessionId: newSid, data: parsed };
  };

  // 1. Try direct browser -> local MCP endpoint (Streamable HTTP JSON-RPC 2.0 or REST)
  try {
    const initRes = await mcpPost(cleanUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'llm-compare-3d-arena', version: '1.0.56' },
      },
    }, null, 10000);

    // Non-JSON-RPC local REST bridge (e.g. LLMCompareFusionMCP Add-In direct POST)
    if (initRes.ok && initRes.data && !initRes.data.jsonrpc && initRes.data.ok) {
      const directRes = await mcpPost(cleanUrl, {
        tool: 'fusion360_import_model',
        slot: payload.slot,
        title: payload.title,
        modelLabel: payload.modelLabel,
        stepText: payload.stepText || '',
        params: payload.params || {},
        fusionScript,
        telemetry: payload.telemetry || null,
      }, null, 25000);
      if (directRes.ok && (!directRes.data || directRes.data.ok !== false)) {
        return { ok: true, pushed: true, endpointUrl: cleanUrl, status: directRes.status, tool: 'fusion360_import_model' };
      }
    }

    const sid = initRes.sessionId;
    try {
      await mcpPost(cleanUrl, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, sid, 4000);
    } catch (_) { /* best effort */ }

    let toolName = 'fusion_mcp_execute';
    let argKey = 'script';
    try {
      const listRes = await mcpPost(cleanUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sid, 8000);
      const tools = (listRes.data && listRes.data.result && Array.isArray(listRes.data.result.tools))
        ? listRes.data.result.tools
        : [];
      let chosen = tools.find((t) => t && ['fusion_mcp_execute', 'execute_script', 'run_script', 'run_python_script', 'fusion360_import_model'].includes(t.name))
        || tools.find((t) => t && /exec|script|python|run|code|import/i.test(String(t.name || '')))
        || tools[0];
      if (chosen && chosen.name) {
        toolName = chosen.name;
        const props = (chosen.inputSchema && chosen.inputSchema.properties) || {};
        const reqKeys = (chosen.inputSchema && Array.isArray(chosen.inputSchema.required)) ? chosen.inputSchema.required : [];
        const propNames = Object.keys(props);
        if (propNames.length === 1) {
          argKey = propNames[0];
        } else {
          const matchKey = ['script', 'code', 'python_code', 'source', 'command', 'fusionScript'].find((k) => k in props);
          if (matchKey) argKey = matchKey;
          else if (reqKeys.length) argKey = reqKeys[0];
        }
      }
    } catch (_) { /* fallback to fusion_mcp_execute */ }

    const args = { [argKey]: fusionScript };
    if (toolName === 'fusion360_import_model') {
      args.title = payload.title;
      args.slot = payload.slot;
      args.stepText = payload.stepText || '';
      args.params = payload.params || {};
      args.fusionScript = fusionScript;
    }
    const callRes = await mcpPost(cleanUrl, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }, sid, 25000);

    const isErr = Boolean((callRes.data && callRes.data.error) || (callRes.data && callRes.data.result && callRes.data.result.isError));
    if (callRes.ok && !isErr) {
      return { ok: true, pushed: true, endpointUrl: cleanUrl, status: callRes.status, tool: toolName };
    }
    const errDetail = (callRes.data && callRes.data.error && callRes.data.error.message)
      || (callRes.data && callRes.data.error)
      || `HTTP ${callRes.status}`;
    return { ok: false, pushed: false, endpointUrl: cleanUrl, status: callRes.status, error: String(errDetail) };
  } catch (directErr) {
    // 2. If direct fetch to :27182 was blocked by browser CORS preflight (or missing Mcp-Session-Id CORS header),
    // automatically try the local Mac CORS-to-Fusion-MCP proxy on http://127.0.0.1:27183/mcp!
    try {
      const proxyUrl = 'http://127.0.0.1:27183/mcp';
      const proxyResp = await fetch(proxyUrl, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: cleanUrl,
          slot: payload.slot,
          title: payload.title,
          modelLabel: payload.modelLabel,
          fusionScript,
          stepText: payload.stepText || '',
          params: payload.params || {},
          telemetry: payload.telemetry || null,
        }),
        signal: AbortSignal.timeout(25000),
      });
      const proxyData = await proxyResp.json().catch(() => ({}));
      if (proxyResp.ok && proxyData && proxyData.ok) {
        return {
          ok: true,
          pushed: true,
          endpointUrl: `${cleanUrl} (via Mac CORS bridge :27183)`,
          status: proxyResp.status,
          tool: proxyData.tool || 'fusion_mcp_execute',
        };
      }
      if (proxyData && proxyData.error) {
        return { ok: false, pushed: false, endpointUrl: cleanUrl, error: proxyData.error };
      }
    } catch (_) { /* proxy not running on :27183 */ }

    return {
      ok: false,
      pushed: false,
      corsOrOffline: true,
      endpointUrl: cleanUrl,
      error: directErr && directErr.message ? directErr.message : String(directErr),
    };
  }
}

async function openCadMcpModal(preferredSlot) {
  const modal = $('#cadMcpModal');
  const slotSel = $('#cadMcpSlotSelect');
  const codePre = $('#cadMcpCodePreview') || $('#cadMcpScriptPre');
  const statusEl = $('#cadMcpStatusBadge') || $('#cadMcpPushStatus');
  const endpointInp = $('#cadMcpEndpointInput');
  const corsHelp = $('#cadMcpCorsHelp');
  if (!modal || !slotSel || !codePre) return;

  if (endpointInp) {
    try {
      const savedEp = localStorage.getItem('llmc_cad_mcp_endpoint');
      if (savedEp) endpointInp.value = savedEp;
      else if (!endpointInp.value) endpointInp.value = 'http://127.0.0.1:27182/mcp';
    } catch (_) {
      if (!endpointInp.value) endpointInp.value = 'http://127.0.0.1:27182/mcp';
    }
  }
  if (corsHelp) corsHelp.classList.add('hidden');

  slotSel.innerHTML = MODELS.map((m) => `<option value="${esc(m.slot)}">Slot ${esc(m.slot)} - ${esc(m.label || m.catalogId)}</option>`).join('');
  if (preferredSlot && MODELS.some((m) => m.slot === preferredSlot)) {
    slotSel.value = preferredSlot;
  }

  const refreshScript = async () => {
    const slot = slotSel.value || (MODELS[0] && MODELS[0].slot) || 'A';
    const st = CAD_SLOT_STATE[slot];
    const jsCode = (st && st.code) || extractCadJsCode(($(`#code-${slot}`) || {}).textContent || '');
    const title = currentTask().title || 'LLMCompare_3D_Component';
    if (statusEl) statusEl.textContent = 'Exporting watertight STEP AP214 & generating Fusion 360 script…';
    codePre.textContent = 'Generating Autodesk Fusion 360 Python API script with embedded STEP AP214 solid…';
    try {
      const stepText = await requestStepTextFromSlot(slot, 8000);
      const resp = await fetch('/api/cad-mcp/fusion360-script', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `${title}_Slot_${slot}`,
          slot,
          modelLabel: (() => { const m = MODELS.find((x) => x.slot === slot); return (m && (m.label || m.catalogId)) || ''; })(),
          code: jsCode,
          params: (st && st.params) || {},
          telemetry: (st && st.telemetry) || null,
          stepText: stepText || '',
        }),
      });
      if (resp.status === 401) { window.location.replace('/login'); return; }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data || !data.ok) throw new Error((data && data.error) || 'Failed to generate script');
      codePre.textContent = data.script || data.fusionScript || '';
      if (statusEl) {
        statusEl.textContent = stepText
          ? '✓ Embedded Watertight STEP AP214 + Parametric Fusion 360 Ready'
          : '✓ Parametric Fusion 360 Script Ready';
      }
    } catch (e) {
      codePre.textContent = '# Error generating script: ' + e.message;
      if (statusEl) statusEl.textContent = '⚠ Script generation error';
    }
  };

  slotSel.onchange = refreshScript;
  modal.classList.remove('hidden');
  activateModalFocus(modal, '#cadMcpSlotSelect');
  await refreshScript();
}

function initCadArenaBindings() {
  window.addEventListener('message', handleCadViewportMessage);

  const syncBtn = $('#cadSyncCamBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      setCadCameraSyncState(!CAD_CAMERA_SYNC_ON);
    });
  }

  const spin3Btn = $('#cadSpin3AxisBtn');
  if (spin3Btn) {
    spin3Btn.addEventListener('click', () => {
      setCadSpin3AxisState(!CAD_SPIN_3AXIS_ON);
    });
  }

  document.querySelectorAll('.cad-global-cam-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.globalCam;
      if (!preset) return;
      if (CAD_SPIN_3AXIS_ON) {
        setCadSpin3AxisState(false);
      }
      if (CAD_TURNTABLE_ON) {
        CAD_TURNTABLE_ON = false;
      }
      document.querySelectorAll('iframe.cad-frame').forEach((ifr, idx) => {
        try {
          if (ifr.contentWindow) {
            ifr.contentWindow.postMessage({ type: 'CAD_SET_CAMERA_PRESET', preset, broadcast: idx === 0 }, '*');
          }
        } catch (_) { /* ignore */ }
      });
    });
  });

  const modBtn = $('#cadModifySubmitBtn') || $('#cadModifyRunBtn');
  const modInput = $('#cadModifyInput');
  if (modBtn) modBtn.addEventListener('click', runCadModification);
  if (modInput) {
    modInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runCadModification();
      }
    });
  }

  document.querySelectorAll('.cad-chip-btn, .cad-QuickChip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const modText = chip.dataset.cadEdit || chip.dataset.mod || '';
      if (modInput && modText) {
        modInput.value = modInput.value ? `${modInput.value.trim()} ${modText}` : modText;
        modInput.focus();
      }
    });
  });

  const mcpOpenBtn = $('#cadMcpOpenBtn') || $('#cadMcpExportBtn');
  const mcpModal = $('#cadMcpModal');
  const mcpCloseBtn = $('#cadMcpCloseBtn');
  const mcpCopyBtn = $('#cadMcpCopyScriptBtn');
  const mcpDlBtn = $('#cadMcpDownloadScriptBtn');
  const mcpPushBtn = $('#cadMcpPushBtn');

  if (mcpOpenBtn) mcpOpenBtn.addEventListener('click', () => openCadMcpModal());
  if (mcpCloseBtn && mcpModal) mcpCloseBtn.addEventListener('click', () => { mcpModal.classList.add('hidden'); deactivateModalFocus(); });
  if (mcpModal) {
    mcpModal.addEventListener('click', (e) => {
      if (e.target === mcpModal) {
        mcpModal.classList.add('hidden');
        deactivateModalFocus();
      }
    });
  }
  if (mcpCopyBtn) {
    mcpCopyBtn.addEventListener('click', async () => {
      const pre = $('#cadMcpCodePreview') || $('#cadMcpScriptPre');
      if (!pre) return;
      try {
        await navigator.clipboard.writeText(pre.textContent || '');
        mcpCopyBtn.textContent = '✓ Copied!';
        setTimeout(() => { mcpCopyBtn.textContent = '📋 Copy Fusion 360 Script'; }, 1600);
      } catch (_) { /* ignore */ }
    });
  }
  if (mcpDlBtn) {
    mcpDlBtn.addEventListener('click', () => {
      const pre = $('#cadMcpCodePreview') || $('#cadMcpScriptPre');
      const slotSel = $('#cadMcpSlotSelect');
      if (!pre) return;
      const slot = (slotSel && slotSel.value) || 'A';
      const blob = new Blob([pre.textContent || ''], { type: 'text/x-python' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fusion360_llm_compare_slot_${slot}.py`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 300);
    });
  }
  const mcpCopyProxyBtn = $('#cadMcpCopyProxyCmdBtn');
  if (mcpCopyProxyBtn) {
    mcpCopyProxyBtn.addEventListener('click', async () => {
      const cmd = `curl -fsSL ${window.location.origin}/fusion-mcp-cors-proxy.py | python3 -`;
      try {
        await navigator.clipboard.writeText(cmd);
        mcpCopyProxyBtn.textContent = '✓ Copied! Paste in Mac Terminal';
        setTimeout(() => { mcpCopyProxyBtn.textContent = '📋 Copy Mac Bridge Command'; }, 2200);
      } catch (_) { /* ignore */ }
    });
  }

  if (mcpPushBtn) {
    mcpPushBtn.addEventListener('click', async () => {
      const pre = $('#cadMcpCodePreview') || $('#cadMcpScriptPre');
      const statusEl = $('#cadMcpStatusBadge') || $('#cadMcpPushStatus');
      const slotSel = $('#cadMcpSlotSelect');
      const endpointInp = $('#cadMcpEndpointInput');
      const corsHelp = $('#cadMcpCorsHelp');
      if (!pre || !statusEl) return;
      const slot = (slotSel && slotSel.value) || 'A';
      const st = CAD_SLOT_STATE[slot];
      const slotModel = MODELS.find((m) => m.slot === slot) || null;
      const localEndpoint = String((endpointInp && endpointInp.value) || 'http://127.0.0.1:27182/mcp').trim() || 'http://127.0.0.1:27182/mcp';
      try { localStorage.setItem('llmc_cad_mcp_endpoint', localEndpoint); } catch (_) { /* ignore */ }

      statusEl.textContent = `Pushing Slot ${slot} to ${localEndpoint}…`;
      try {
        const stepText = await requestStepTextFromSlot(slot, 8000);
        let fusionScript = String(pre.textContent || '').trim();
        if (!fusionScript || fusionScript.startsWith('Generating') || fusionScript.startsWith('# Error')) {
          const genResp = await fetch('/api/cad-mcp/fusion360-script', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              slot,
              modelLabel: (slotModel && (slotModel.label || slotModel.catalogId)) || '',
              title: `${currentTask().title || 'CAD_Model'}_Slot_${slot}`,
              code: (st && st.code) || '',
              params: (st && st.params) || {},
              telemetry: (st && st.telemetry) || null,
              stepText: stepText || '',
            }),
          });
          const genData = await genResp.json().catch(() => ({}));
          if (genData && genData.script) {
            fusionScript = genData.script;
            pre.textContent = fusionScript;
          }
        }

        // 1. Push directly from the browser on the user's machine to their local Fusion 360 MCP server
        const browserPush = await pushToBrowserLocalMcp(localEndpoint, {
          slot,
          title: `${currentTask().title || 'CAD_Model'}_Slot_${slot}`,
          modelLabel: (slotModel && (slotModel.label || slotModel.catalogId)) || '',
          fusionScript,
          stepText: stepText || '',
          params: (st && st.params) || {},
          telemetry: (st && st.telemetry) || null,
        });

        if (browserPush.pushed) {
          if (corsHelp) corsHelp.classList.add('hidden');
          statusEl.textContent = `✓ Pushed to ${browserPush.endpointUrl} (${browserPush.tool || 'MCP'} · HTTP ${browserPush.status || 200})`;
          return;
        }

        // 2. Fallback: check if the server has a server-side CAD_MCP_URL configured
        const resp = await fetch('/api/cad-mcp/push', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slot,
            modelLabel: (slotModel && (slotModel.label || slotModel.catalogId)) || '',
            title: `${currentTask().title || 'CAD_Model'}_Slot_${slot}`,
            code: (st && st.code) || '',
            params: (st && st.params) || {},
            telemetry: (st && st.telemetry) || null,
            stepText: stepText || '',
          }),
        });
        if (resp.status === 401) { window.location.replace('/login'); return; }
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data && data.pushed) {
          if (corsHelp) corsHelp.classList.add('hidden');
          statusEl.textContent = `✓ Pushed to ${data.endpointUrl || 'the configured bridge'} (HTTP ${data.upstreamStatus != null ? data.upstreamStatus : 'ok'})`;
          return;
        }

        if (browserPush.corsOrOffline) {
          if (corsHelp) corsHelp.classList.remove('hidden');
          statusEl.textContent = `⚠ Browser could not reach ${localEndpoint} directly (CORS preflight or Fusion MCP offline). Run the 1-line Mac Bridge Command below, then click Push again.`;
        } else {
          statusEl.textContent = `⚠ Fusion MCP (${localEndpoint}) returned: ${browserPush.error || 'rejected'}`;
        }
      } catch (e) {
        statusEl.textContent = `⚠ ${e.message}`;
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCadArenaBindings);
} else {
  initCadArenaBindings();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initImageArenaBindings);
} else {
  initImageArenaBindings();
}

