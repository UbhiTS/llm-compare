// Pre-paint theme application (kept external so the page's CSP can forbid inline
// scripts). Runs synchronously in <head> before first paint to avoid a flash.
try { document.documentElement.dataset.theme = localStorage.getItem('ullm.theme') || 'medium'; }
catch (e) { document.documentElement.dataset.theme = 'medium'; }
// Start /api/config immediately in <head> in parallel with styles.css and app.js
try {
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    window.__ULLM_CONFIG_PROMISE__ = window.fetch('/api/config', { credentials: 'same-origin' });
  }
} catch (_) {}

