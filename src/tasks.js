// ---------------------------------------------------------------------------
// Tasks are loaded from editable text files in the prompts/ folder at startup.
//
// Each file is one task: a "frontmatter" block (--- ... ---) of key: value
// metadata, followed by the prompt body. To ADD A TASK, just drop a new
// `.md` file in prompts/ — no code change needed. To change a prompt, edit
// its file's body. See prompts/README.md for the format.
//
//   Frontmatter keys: id, title, category (coding|general), language
//   (javascript|python|null), functionName, executable (true|false),
//   gui (true), visualizer (e.g. hanoi), testCases (a JSON array, for graded
//   JS tasks). Values that look like JSON (arrays/objects/numbers/booleans/null)
//   are parsed as JSON; everything else stays a string.
//
// Files load in filename order, so a numeric prefix (10-, 20-, …) controls the
// order they appear in the UI. README.md and files starting with "_" are ignored.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

function parseValue(raw) {
  const v = raw.trim();
  if (v === '') return '';
  // JSON-parse arrays / objects / numbers / booleans / null; otherwise keep a string.
  if (/^[[{]/.test(v) || /^-?\d/.test(v) || v === 'true' || v === 'false' || v === 'null') {
    try { return JSON.parse(v); } catch (_) { /* fall through to string */ }
  }
  return v;
}

function parseTaskFile(raw) {
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const metaBlock = m ? m[1] : '';
  const body = m ? m[2] : raw;

  const task = {};
  const lines = metaBlock.split(/\r?\n/);
  let currentKey = null;
  let currentRaw = '';

  const flush = () => {
    if (currentKey) {
      task[currentKey] = parseValue(currentRaw);
      currentKey = null;
      currentRaw = '';
    }
  };

  lines.forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const topKeyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (topKeyMatch) {
      flush();
      currentKey = topKeyMatch[1].trim();
      currentRaw = topKeyMatch[2] || '';
    } else if (currentKey) {
      currentRaw += '\n' + line;
    }
  });
  flush();

  task.prompt = body.trim();
  if (task.language === undefined) task.language = null;
  if (!Array.isArray(task.testCases)) task.testCases = [];
  return task;
}

function loadTasks() {
  let files;
  try {
    files = fs.readdirSync(PROMPTS_DIR)
      .filter((f) => /\.md$/i.test(f) && !f.startsWith('_') && f.toLowerCase() !== 'readme.md')
      .sort();
  } catch (e) {
    console.error('[tasks] could not read prompts dir (' + PROMPTS_DIR + '): ' + e.message);
    return [];
  }

  const tasks = [];
  for (const f of files) {
    try {
      const task = parseTaskFile(fs.readFileSync(path.join(PROMPTS_DIR, f), 'utf8'));
      if (!task.id || !task.title) { console.error('[tasks] ' + f + ': missing id/title — skipped'); continue; }
      if (!task.functionName) task.functionName = 'solution';
      if (!task.category) task.category = task.testCases.length ? 'coding' : 'general';
      tasks.push(task);
    } catch (e) {
      console.error('[tasks] ' + f + ': ' + e.message + ' — skipped');
    }
  }
  if (!tasks.length) console.error('[tasks] WARNING: no tasks loaded from ' + PROMPTS_DIR);
  return tasks;
}

const TASKS = loadTasks();

module.exports = { TASKS, loadTasks, PROMPTS_DIR };
