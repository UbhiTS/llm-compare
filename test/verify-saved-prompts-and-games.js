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

const {
  listSavedPrompts,
  saveUserPrompt,
  deleteUserPrompt,
  listSavedPresets,
  saveUserPreset,
  deleteUserPreset,
  getUserPreferences,
  saveRun,
  listRuns,
  getRun,
  deleteRun,
  attachJudgeToLatestRun,
} = require('../src/history');
const { sanitizeForPygbag, patchIndexHtml } = require('../src/webGame');

async function runTests() {
  const testUser = `adv_test_user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const otherUser = `adv_other_user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

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

  // 1b. Saved Model Presets CRUD & Persistence
  assert.deepEqual(listSavedPresets(testUser), [], 'New user starts with empty saved presets');
  const preset1 = saveUserPreset(testUser, {
    title: 'My Vertex Reasoning Trio',
    slots: [
      { slot: 'A', catalogId: 'gemini-3.8-flash', effort: 'high' },
      { slot: 'B', catalogId: 'claude-opus-5-5', effort: null },
      { slot: 'C', catalogId: 'deepseek-v3.2-maas', effort: null },
    ],
  });
  assert.equal(preset1.ok, true, 'Saving valid model preset succeeds');
  assert.ok(preset1.saved && preset1.saved.id.startsWith('mp_'), 'Saved preset receives mp_ ID');
  assert.equal(preset1.savedPresets.length, 1);
  assert.equal(preset1.savedPresets[0].title, 'My Vertex Reasoning Trio');
  assert.equal(preset1.savedPresets[0].slots.length, 3);
  assert.equal(preset1.savedPresets[0].slots[0].catalogId, 'gemini-3.8-flash');
  assert.equal(preset1.savedPresets[0].slots[0].effort, 'high');

  // Upsert preset by same title updates existing preset
  const presetUpdate = saveUserPreset(testUser, {
    title: 'My Vertex Reasoning Trio',
    slots: [
      { slot: 'A', catalogId: 'gemini-3.8-flash', effort: 'low' },
      { slot: 'B', catalogId: 'claude-sonnet-5', effort: null },
    ],
  });
  assert.equal(presetUpdate.ok, true);
  assert.equal(presetUpdate.savedPresets.length, 1, 'Updating preset by same title does not duplicate');
  assert.equal(presetUpdate.savedPresets[0].id, preset1.saved.id, 'Preserves original preset ID on update');
  assert.equal(presetUpdate.savedPresets[0].slots.length, 2);

  // 1c. Strict Multi-User Privacy Isolation (User B vs User A)
  assert.deepEqual(listSavedPrompts(otherUser), [], 'Other user cannot see testUser saved prompts');
  assert.deepEqual(listSavedPresets(otherUser), [], 'Other user cannot see testUser saved presets');

  // Other user attempting to delete testUser's prompt or preset fails with removed: false
  const crossDelPrompt = deleteUserPrompt(otherUser, res1.saved.id);
  assert.equal(crossDelPrompt.removed, false, 'Other user cannot delete testUser saved prompt');
  assert.equal(listSavedPrompts(testUser).length, 2, 'testUser prompts remain untouched');

  const crossDelPreset = deleteUserPreset(otherUser, preset1.saved.id);
  assert.equal(crossDelPreset.removed, false, 'Other user cannot delete testUser saved preset');
  assert.equal(listSavedPresets(testUser).length, 1, 'testUser presets remain untouched');

  // Other user attempting to spoof testUser's ID on save gets a fresh ID in their own isolated store
  const spoofPrompt = saveUserPrompt(otherUser, {
    id: res1.saved.id,
    title: 'Spoofed Prompt',
    prompt: 'Trying to overwrite testUser prompt',
  });
  assert.notEqual(spoofPrompt.saved.id, res1.saved.id, 'Cross-user ID spoofing on prompt save mints a fresh ID');
  assert.equal(
    listSavedPrompts(testUser).find((p) => p.id === res1.saved.id).prompt,
    'Updated prompt instructions for FinOps BigQuery Cost Audit.',
    'testUser prompt content was not overwritten by otherUser'
  );

  const spoofPreset = saveUserPreset(otherUser, {
    id: preset1.saved.id,
    title: 'Spoofed Preset',
    slots: [{ slot: 'A', catalogId: 'gpt-6-sol', effort: null }],
  });
  assert.notEqual(spoofPreset.saved.id, preset1.saved.id, 'Cross-user ID spoofing on preset save mints a fresh ID');
  assert.equal(
    listSavedPresets(testUser)[0].slots.length,
    2,
    'testUser preset was not overwritten by otherUser'
  );

  // Clean up otherUser's prompt and preset
  deleteUserPrompt(otherUser, spoofPrompt.saved.id);
  deleteUserPreset(otherUser, spoofPreset.saved.id);

  // Run & Judge cross-user isolation
  const userARun = await saveRun({
    user: testUser,
    task: { id: 'custom', title: 'Private Architecture Review', category: 'general', prompt: 'Secret prompt' },
    models: [{ slot: 'A', label: 'Gemini 3.8 Flash', model: 'gemini-3.8-flash' }],
    results: [{ slot: 'A', code: 'Confidential output', costUsd: 0.001, wallMs: 500 }],
  });
  assert.ok(userARun && userARun.id, 'Recorded private run for testUser');
  assert.equal(listRuns(otherUser).length, 0, 'Other user cannot list testUser runs');
  assert.equal(getRun(userARun.id, { username: otherUser, isAdmin: false }), null, 'Other user cannot fetch testUser run by ID');
  assert.equal(
    await attachJudgeToLatestRun(otherUser, 'custom', { winner: 'A', summary: 'Tampered' }, userARun.id),
    false,
    'Other user cannot attach or overwrite judge verdict on testUser runId'
  );
  assert.equal(await deleteRun(userARun.id, { username: otherUser, isAdmin: false }), false, 'Other user cannot delete testUser run');
  assert.equal(await deleteRun(userARun.id, { username: testUser, isAdmin: false }), true, 'Owner can delete their own run');

  // Delete testUser prompts & presets
  const delRes = deleteUserPrompt(testUser, res1.saved.id);
  assert.equal(delRes.ok, true);
  assert.equal(delRes.removed, true);
  assert.equal(delRes.savedPrompts.length, 1);
  assert.equal(delRes.savedPrompts[0].id, res2.saved.id);
  deleteUserPrompt(testUser, res2.saved.id);
  assert.equal(listSavedPrompts(testUser).length, 0);

  const delPresetRes = deleteUserPreset(testUser, preset1.saved.id);
  assert.equal(delPresetRes.ok, true);
  assert.equal(delPresetRes.removed, true);
  assert.equal(delPresetRes.savedPresets.length, 0);
  assert.equal(listSavedPresets(testUser).length, 0);

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

  // 4. Dropdown Non-Truncation & App Versioning Verification
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(pkg.version, /^1\.0\.\d+$/, 'package.json version follows 1.0.x scheme');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(
    indexHtml.includes(`<span id="appVersion" class="foot-version">v${pkg.version}</span>`),
    'Footer displays matching version number next to LLM Compare'
  );
  assert.ok(
    indexHtml.includes('id="savePresetBtn"') && indexHtml.includes('id="userPresetsList"'),
    'Step 2 includes Save preset button and user presets container'
  );
  const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.ok(
    !stylesCss.includes('flex: 0 0 240px'),
    '#categorySelect no longer uses fixed 240px width that truncated text'
  );
  assert.ok(
    !stylesCss.includes('flex: 0 0 92px') && !stylesCss.includes('flex: 0 0 138px'),
    'Step 2 model slot dropdowns no longer use fixed 92px/138px widths'
  );

  console.log('✓ All Saved Prompts, Saved Model Presets, Multi-User Privacy, Gaming WASM, Dropdown Sizing & Versioning checks passed.');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

