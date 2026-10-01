'use strict';

/**
 * Adversarial & Functional Verification Suite for:
 *   1. Saved Prompts Library (CRUD persistence across sessions, attachments, caps)
 *   2. Pygame WASM Sanitizer & Iframe Hardening (no half-code/half-screen, no false-positive Fix-it,
 *      same-origin privilege isolation, sys.exit neutralization, gfxdraw shim)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listSavedPrompts, saveUserPrompt, deleteUserPrompt, getUserPreferences } = require('../src/history');
const { sanitizeForPygbag, patchIndexHtml } = require('../src/webGame');

function runTests() {
  const testUser = `adv_test_user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 1. Saved Prompts Library CRUD & Persistence
  assert.deepEqual(listSavedPrompts(testUser), [], 'New user starts with empty saved prompts');

  const res1 = saveUserPrompt(testUser, {
    title: 'FinOps BigQuery Cost Audit',
    prompt: 'Analyze the attached BigQuery slot utilization CSV and recommend reservations.',
    attachments: [
      {
        name: 'slots.csv',
        mimeType: 'text/csv',
        size: 128,
        textContent: 'hour,slots\n01,450\n02,600',
        estimatedTokens: 25,
      },
    ],
  });
  assert.equal(res1.ok, true, 'Saving valid prompt succeeds');
  assert.ok(res1.saved && res1.saved.id.startsWith('sp_'), 'Saved prompt receives sp_ ID');
  assert.equal(res1.savedPrompts.length, 1);
  assert.equal(res1.savedPrompts[0].title, 'FinOps BigQuery Cost Audit');
  assert.equal(res1.savedPrompts[0].attachments.length, 1);
  assert.equal(res1.savedPrompts[0].attachments[0].name, 'slots.csv');

  // Verify getUserPreferences returns savedPrompts for GET /api/config restoration on re-login
  const prefsAfterSave = getUserPreferences(testUser);
  assert.ok(Array.isArray(prefsAfterSave.savedPrompts), 'getUserPrefs exposes savedPrompts');
  assert.equal(prefsAfterSave.savedPrompts.length, 1);
  assert.equal(prefsAfterSave.savedPrompts[0].id, res1.saved.id);

  // Upsert by same title updates existing item rather than duplicating
  const resUpdate = saveUserPrompt(testUser, {
    title: 'FinOps BigQuery Cost Audit',
    prompt: 'Updated prompt instructions for FinOps BigQuery Cost Audit.',
    attachments: [],
  });
  assert.equal(resUpdate.ok, true);
  assert.equal(resUpdate.savedPrompts.length, 1, 'Updating by same title does not duplicate');
  assert.equal(resUpdate.savedPrompts[0].id, res1.saved.id, 'Preserves original prompt ID on update');
  assert.equal(resUpdate.savedPrompts[0].prompt, 'Updated prompt instructions for FinOps BigQuery Cost Audit.');

  // Add second prompt
  const res2 = saveUserPrompt(testUser, {
    title: 'GKE Autopilot Security Review',
    prompt: 'Audit this GKE cluster manifest for pod security standards.',
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.savedPrompts.length, 2);

  // Delete first prompt
  const delRes = deleteUserPrompt(testUser, res1.saved.id);
  assert.equal(delRes.ok, true);
  assert.equal(delRes.removed, true);
  assert.equal(delRes.savedPrompts.length, 1);
  assert.equal(delRes.savedPrompts[0].id, res2.saved.id);

  // Clean up second prompt
  deleteUserPrompt(testUser, res2.saved.id);
  assert.equal(listSavedPrompts(testUser).length, 0);

  // 2. Pygame WASM Sanitizer Verification
  const rawGameCode = [
    'import pygame, sys, asyncio',
    'import pygame.gfxdraw',
    'async def main():',
    '    pygame.init()',
    '    screen = pygame.display.set_mode((800, 600))',
    '    clock = pygame.time.Clock()',
    '    running = True',
    '    while running:',
    '        for ev in pygame.event.get():',
    '            if ev.type == pygame.QUIT:',
    '                running = False',
    '        try:',
    '            screen.fill((0, 0, 0))',
    '        except Exception:',
    '            pass',
    '        pygame.display.flip()',
    '        clock.tick(60)',
    '        await asyncio.sleep(0)',
    '    pygame.quit()',
    '    sys.exit()',
    'asyncio.run(main())',
  ].join('\n');

  const sanitized = sanitizeForPygbag(rawGameCode);
  assert.ok(
    sanitized.includes('# --- ullm pygbag WASM compatibility & crash-detection preamble ---'),
    'Injects WASM compatibility preamble'
  );
  assert.ok(sanitized.includes('___ULLM_GAME_BOOTED___'), 'Emits boot sentinel on set_mode');
  assert.ok(sanitized.includes('___ULLM_FATAL_PYTHON_CRASH___'), 'Emits fatal crash sentinel only on unhandled crash');
  assert.ok(sanitized.includes('_pgb_safe_mixer_init'), 'Shims pygame.mixer.init against browser audio errors');
  assert.ok(!/^import\s+pygame\.gfxdraw/m.test(sanitized), 'Strips top-level import pygame.gfxdraw');

  // Idempotency check
  const sanitizedTwice = sanitizeForPygbag(sanitized);
  assert.equal(
    (sanitizedTwice.match(/# --- ullm pygbag WASM compatibility & crash-detection preamble ---/g) || []).length,
    1,
    'sanitizeForPygbag is idempotent regarding the preamble'
  );

  // 3. Pygbag index.html Patching Verification (Full-Viewport + Same-Origin Isolation + No False Fix-It)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ullm-patch-test-'));
  const idxPath = path.join(tmpDir, 'index.html');
  fs.writeFileSync(
    idxPath,
    '<!doctype html><html><head><title>pygbag</title></head><body><canvas id="canvas"></canvas><div id="pyconsole"><div id="terminal"></div></div></body></html>',
    'utf8'
  );
  patchIndexHtml(idxPath);
  const patchedHtml = fs.readFileSync(idxPath, 'utf8');

  assert.ok(patchedHtml.includes('id="ullm-game-css"'), 'Injects full-viewport canvas CSS');
  assert.ok(
    patchedHtml.includes('#pyconsole,#dlg,#box,#terminal,#system,#transfer,#status,#infobox{display:none!important;'),
    'Permanently hides pygbag code/terminal overlays so screen never splits half-code/half-game'
  );
  assert.ok(
    patchedHtml.includes('Object.defineProperty(window,"localStorage"'),
    'Isolates window.localStorage inside same-origin game iframe'
  );
  assert.ok(
    patchedHtml.includes('Object.defineProperty(window,"parent"'),
    'Isolates window.parent inside same-origin game iframe'
  );
  assert.ok(
    patchedHtml.includes('___ULLM_FATAL_PYTHON_CRASH___'),
    'Only triggers game-error on ___ULLM_FATAL_PYTHON_CRASH___ sentinel'
  );
  assert.ok(
    patchedHtml.includes('__ullm:"game-booted"'),
    'Posts game-booted to parent when canvas initializes'
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('✓ All Saved Prompts & Gaming WASM adversarial checks passed.');
}

runTests();
