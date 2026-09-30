// Pre-paint theme application (kept external so the page's CSP can forbid inline
// scripts). Runs synchronously in <head> before first paint to avoid a flash.
try { document.documentElement.dataset.theme = localStorage.getItem('ullm.theme') || 'medium'; }
catch (e) { document.documentElement.dataset.theme = 'medium'; }
