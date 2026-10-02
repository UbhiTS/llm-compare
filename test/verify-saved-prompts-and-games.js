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

  // 5. Per-User Content-Addressable Binary File Vault + SQLite Records Verification
  const { normalizeAttachmentsAsync } = require('../src/attachments');
  const vault = require('../src/vault');
  const rawBinaryBuf = Buffer.alloc(64 * 1024, 0x42); // 64 KB binary file
  const samplePngBuf = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const vaultSaveRes = saveUserPrompt(testUser, {
    title: 'Large Binary Architecture Diagram',
    prompt: 'Review this architecture binary and diagram.',
    attachments: [
      {
        name: 'arch.bin',
        mimeType: 'application/octet-stream',
        size: rawBinaryBuf.length,
        data: rawBinaryBuf.toString('base64'),
        textContent: 'Extracted architecture specification text',
        estimatedTokens: 320,
      },
      {
        name: 'diagram.png',
        mimeType: 'image/png',
        size: samplePngBuf.length,
        data: samplePngBuf.toString('base64'),
        estimatedTokens: 258,
      },
    ],
  });
  assert.equal(vaultSaveRes.ok, true);
  const ptr = vaultSaveRes.saved.attachments[0];
  const imgPtr = vaultSaveRes.saved.attachments[1];
  assert.ok(ptr.vaultRef && ptr.sha256 === ptr.vaultRef, 'Saved prompt attachment returns SHA-256 vaultRef pointer');
  assert.equal(ptr.data, undefined, 'Saved prompt pointer never carries inline base64 data');
  assert.equal(ptr.hasBlob, true, 'Saved prompt pointer marks hasBlob: true');
  assert.equal(imgPtr.thumbnailUrl, `/api/me/vault/${imgPtr.sha256}`, 'Image attachment pointer carries thumbnailUrl from SQLite record');
  assert.ok(imgPtr.relPath && imgPtr.relPath.endsWith(`/${imgPtr.sha256}.bin`), 'Attachment pointer carries relative binary path');

  // Verify SQLite `user_vault_files` table records metadata, extractedText, thumbnailUrl, and relPath
  const userVaultFiles = vault.listUserVaultFiles(testUser);
  assert.ok(userVaultFiles.length >= 2, 'SQLite user_vault_files lists all stored files for testUser');
  const binRecord = userVaultFiles.find((f) => f.sha256 === ptr.sha256);
  const imgRecord = userVaultFiles.find((f) => f.sha256 === imgPtr.sha256);
  assert.ok(binRecord && binRecord.name === 'arch.bin', 'SQLite user_vault_files stores binary attachment metadata');
  assert.equal(binRecord.hasExtractedText, true, 'SQLite user_vault_files stores extractedText in DB');
  assert.ok(imgRecord && imgRecord.thumbnailUrl === `/api/me/vault/${imgPtr.sha256}`, 'SQLite user_vault_files stores image thumbnailUrl');
  assert.deepEqual(vault.listUserVaultFiles(otherUser), [], 'SQLite user_vault_files is strictly isolated per user');

  // Verify user's vault directory on disk contains ONLY raw .bin files and ZERO .meta.json or .txt sidecars
  const userVaultDir = vault.getUserVaultDir(testUser);
  const vaultDiskFiles = fs.readdirSync(userVaultDir);
  assert.ok(vaultDiskFiles.includes(`${ptr.sha256}.bin`), 'Vault directory stores raw <sha256>.bin file');
  assert.ok(
    !vaultDiskFiles.some((f) => f.endsWith('.meta.json') || f.endsWith('.txt')),
    'Vault directory contains zero .meta.json or .txt sidecar files (all metadata/text lives in SQLite)'
  );

  // Verify GET /api/config (getUserPreferences) payload remains tiny (< 2 KB) even with 64 KB binary attachment
  const slimPrefs = getUserPreferences(testUser);
  const slimJson = JSON.stringify(slimPrefs);
  assert.ok(
    slimJson.length < 2048,
    `getUserPreferences JSON stays ultra-compact (${slimJson.length} bytes < 2048 bytes) because binary lives in per-user vault`
  );

  // Verify raw binary file exists as-is on disk inside testUser's vault directory
  const rawFromVault = vault.getVaultRawBinarySync(testUser, ptr.vaultRef);
  assert.ok(rawFromVault && Buffer.isBuffer(rawFromVault.buffer), 'Raw binary buffer is stored as-is in user vault');
  assert.equal(rawFromVault.buffer.length, rawBinaryBuf.length, 'Raw binary file size matches original byte-for-byte');
  assert.equal(Buffer.compare(rawFromVault.buffer, rawBinaryBuf), 0, 'Raw binary content matches original byte-for-byte');

  // Verify normalizeAttachmentsAsync automatically hydrates from testUser's vault + SQLite record when given only the lightweight pointer
  const hydrated = await normalizeAttachmentsAsync([ptr], { username: testUser });
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].sha256, ptr.vaultRef);
  assert.equal(Buffer.from(hydrated[0].data, 'base64').length, rawBinaryBuf.length, 'Hydrated attachment from vault has full binary data');

  // Verify strict cross-user vault isolation: otherUser cannot read or hydrate testUser's vault file
  assert.equal(vault.getVaultRawBinarySync(otherUser, ptr.vaultRef), null, 'Other user cannot read testUser raw binary from vault');
  await assert.rejects(
    () => normalizeAttachmentsAsync([ptr], { username: otherUser }),
    (err) => err && err.code === 'ATTACHMENT_EXPIRED',
    'Other user referencing testUser vaultRef is rejected with ATTACHMENT_EXPIRED'
  );

  // Clean up testUser vault prompt
  deleteUserPrompt(testUser, vaultSaveRes.saved.id);

  // 6. Cloud Run Container Redeploy Persistence & Admin Saved Prompts/Presets Counts + Sorting
  const redeployUser = `redeploy_${Date.now()}@example.com`;
  const pSave1 = saveUserPrompt(redeployUser, {
    title: 'Redeploy Durable Prompt 1',
    prompt: 'Analyze system latency across regions.',
    attachments: [],
  });
  const pSave2 = saveUserPrompt(redeployUser, {
    title: 'Redeploy Durable Prompt 2',
    prompt: 'Generate zero-trust firewall rules.',
    attachments: [],
  });
  const mSave1 = saveUserPreset(redeployUser, {
    title: 'Redeploy Durable Preset',
    slots: [
      { slot: 'a', catalogId: 'gemini-3.8-flash', effort: 'medium' },
      { slot: 'b', catalogId: 'claude-opus-5-5', effort: 'high' },
    ],
  });
  assert.equal(pSave1.ok && pSave2.ok && mSave1.ok, true, 'Saved 2 prompts and 1 preset before simulated container redeploy');

  // Verify Admin usageSummary() includes per-user savedPrompts & savedPresets counts + global totals
  const historyMod = require('../src/history');
  const usageBefore = historyMod.usageSummary();
  assert.ok(usageBefore && usageBefore.totals, 'usageSummary returns totals');
  assert.ok(usageBefore.totals.totalSavedPrompts >= 2, 'usageSummary totals.totalSavedPrompts includes saved prompts');
  assert.ok(usageBefore.totals.totalSavedPresets >= 1, 'usageSummary totals.totalSavedPresets includes saved presets');
  const uRowBefore = (usageBefore.users || []).find((u) => u.user === redeployUser);
  assert.ok(uRowBefore, 'usageSummary includes user even when user has 0 comparison runs');
  assert.equal(uRowBefore.savedPrompts, 2, 'Admin usage row shows exact savedPrompts count for user');
  assert.equal(uRowBefore.savedPresets, 1, 'Admin usage row shows exact savedPresets count for user');
  assert.equal(uRowBefore.prompt, undefined, 'Admin usage row never leaks private prompt text');

  // Simulate a real Cloud Run container redeploy:
  // Wipe the ephemeral /tmp SQLite database (and -wal / -shm) WITHOUT waiting for any timers,
  // clear require.cache, and reload src/history from PERSIST_SQLITE_PATH (/data/history/history.sqlite).
  const localSqlitePath = historyMod.LOCAL_SQLITE_PATH;
  const persistSqlitePath = historyMod.PERSIST_SQLITE_PATH;
  assert.ok(fs.existsSync(persistSqlitePath), 'PERSIST_SQLITE_PATH (/data/history/history.sqlite) exists immediately after save (zero timer delay)');
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(localSqlitePath + suffix); } catch (_) {}
  }
  assert.equal(fs.existsSync(localSqlitePath), false, 'Ephemeral /tmp SQLite file wiped to simulate fresh Cloud Run container boot');

  delete require.cache[require.resolve('../src/history')];
  const reloadedHistory = require('../src/history');
  const promptsAfterRedeploy = reloadedHistory.listSavedPrompts(redeployUser);
  const presetsAfterRedeploy = reloadedHistory.listSavedPresets(redeployUser);
  assert.equal(promptsAfterRedeploy.length, 2, 'All saved prompts survive Cloud Run container redeploy (/tmp wipe)');
  assert.equal(promptsAfterRedeploy[0].title, 'Redeploy Durable Prompt 2');
  assert.equal(promptsAfterRedeploy[1].title, 'Redeploy Durable Prompt 1');
  assert.equal(presetsAfterRedeploy.length, 1, 'All saved presets survive Cloud Run container redeploy (/tmp wipe)');
  assert.equal(presetsAfterRedeploy[0].title, 'Redeploy Durable Preset');

  // Verify UI History view sorting & Admin Saved Prompts/Presets columns in public/app.js
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(
    appJs.includes('function sortUsageUsers(') &&
    appJs.includes('function sortHistoryRuns(') &&
    appJs.includes('totalSavedPrompts') &&
    appJs.includes('totalSavedPresets'),
    'public/app.js implements Admin Saved Prompts/Presets KPI cards, columns, and interactive sorting for both users and runs'
  );

  // Clean up redeploy test user
  reloadedHistory.deleteUserPrompt(redeployUser, pSave1.saved.id);
  reloadedHistory.deleteUserPrompt(redeployUser, pSave2.saved.id);
  reloadedHistory.deleteUserPreset(redeployUser, mSave1.saved.id);

  console.log('✓ All Saved Prompts, Saved Model Presets, Per-User Binary Vault + SQLite Records, Container Redeploy Persistence, Admin Usage Counts & Sorting, Multi-User Privacy, Gaming WASM, Dropdown Sizing & Versioning checks passed.');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});


