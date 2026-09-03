// ---------------------------------------------------------------------------
// public/modules/icons.js — Model brand marks & SVG helpers
// ---------------------------------------------------------------------------

const ICON_GEMINI = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5c.45 5.4 3.6 8.55 9 9-5.4.45-8.55 3.6-9 9-.45-5.4-3.6-8.55-9-9 5.4-.45 8.55-3.6 9-9Z" fill="url(#ic-gemini)"/></svg>';
const ICON_CLAUDE = (() => {
  let rays = '';
  for (let i = 0; i < 12; i++) rays += `<rect x="11.05" y="2.1" width="1.9" height="6.4" rx=".95" transform="rotate(${i * 30} 12 12)"/>`;
  return `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><g fill="#d97757">${rays}</g></svg>`;
})();
const ICON_GENERIC = '<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>';
const MAGNIFY_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="6.8" cy="6.8" r="4.4"/><line x1="10.1" y1="10.1" x2="14" y2="14"/></svg>';

function modelIconSvg(m) {
  const s = (((m && m.publisher) || '') + ' ' + ((m && m.provider) || '') + ' ' + ((m && m.model) || '') + ' ' + ((m && m.label) || '')).toLowerCase();
  if (s.indexOf('anthropic') >= 0 || s.indexOf('claude') >= 0) return ICON_CLAUDE;
  if (s.indexOf('gemini') >= 0 || s.indexOf('google') >= 0) return ICON_GEMINI;
  return ICON_GENERIC;
}

function shortLabel(label) {
  const s = String(label || '');
  return s.replace(/^(Gemini|Claude|GPT|Llama|Mistral|OpenAI|Anthropic|Google|DeepSeek|Qwen)\s+/i, '').trim() || s;
}

if (typeof window !== 'undefined') {
  window.ICON_GEMINI = ICON_GEMINI;
  window.ICON_CLAUDE = ICON_CLAUDE;
  window.ICON_GENERIC = ICON_GENERIC;
  window.MAGNIFY_SVG = MAGNIFY_SVG;
  window.modelIconSvg = modelIconSvg;
  window.shortLabel = shortLabel;
}
