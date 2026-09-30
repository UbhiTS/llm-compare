// ---------------------------------------------------------------------------
// pdfReport.js — Pure Node.js PDF 1.4 report generator (zero external deps).
//
// Generates a multi-page, vector-graphics PDF report for an LLM Compare run:
//   1. Executive Summary (task metadata, prompt, executive takeaway callout,
//      and ranked model summary cards)
//   2. Visual Comparison Graphs (native PDF vector bar/stacked/grouped charts
//      for Overall Balanced Score, Cost per Task, Wall Time, Throughput Tok/s,
//      Correctness %, Token Usage Breakdown, and Multi-Axis Efficiency Profile)
//   3. Full Metrics Comparison Table & Blind LLM-as-Judge Evaluation
//   4. Detailed Per-Model Results (full metadata header, execution/test status,
//      reasoning/thinking trace, and formatted response/code with multi-page
//      automatic pagination)
// ---------------------------------------------------------------------------

const zlib = require('zlib');
const { thinkingProfile } = require('./providers');
const { scrubError, maskKnown } = require('./secrets');

const PAGE_W = 612; // US Letter width in pt (8.5 in * 72)
const PAGE_H = 792; // US Letter height in pt (11 in * 72)
const M_LEFT = 36;
const M_RIGHT = 36;
const M_TOP = 48;
const M_BOTTOM = 42;
const CONTENT_W = PAGE_W - M_LEFT - M_RIGHT; // 540 pt

// Slot accent palette matching public/app.js
const PALETTE_HEX = [
  '#4f7cff', // Slot A — Indigo Blue
  '#10b981', // Slot B — Emerald
  '#f97316', // Slot C — Orange
  '#8b5cf6', // Slot D — Violet
  '#eab308', // Slot E — Amber
  '#06b6d4', // Slot F — Cyan
];

// Theme colors (RGB 0..1)
const COLORS = {
  bannerBg: hexToRgb('#0f172a'),
  bannerSubBg: hexToRgb('#1e293b'),
  bannerAccent: hexToRgb('#5e8bff'),
  bannerMint: hexToRgb('#2fd9a6'),
  textDark: hexToRgb('#0f172a'),
  textBody: hexToRgb('#1e293b'),
  textMuted: hexToRgb('#475569'),
  textFaint: hexToRgb('#64748b'),
  textWhite: [1, 1, 1],
  textBannerSub: hexToRgb('#cbd5e1'),
  cardBg: hexToRgb('#f8fafc'),
  cardAltBg: hexToRgb('#f1f5f9'),
  cardBorder: hexToRgb('#cbd5e1'),
  divider: hexToRgb('#e2e8f0'),
  gridLine: hexToRgb('#e2e8f0'),
  goodText: hexToRgb('#059669'),
  goodBg: hexToRgb('#ecfdf5'),
  goodBorder: hexToRgb('#6ee7b7'),
  warnText: hexToRgb('#b45309'),
  warnBg: hexToRgb('#fffbeb'),
  warnBorder: hexToRgb('#fcd34d'),
  errText: hexToRgb('#dc2626'),
  errBg: hexToRgb('#fef2f2'),
  errBorder: hexToRgb('#fca5a5'),
  thinkBg: hexToRgb('#f5f3ff'),
  thinkBorder: hexToRgb('#ddd6fe'),
  thinkTitle: hexToRgb('#5b21b6'),
  codeBg: hexToRgb('#f8fafc'),
  codeBorder: hexToRgb('#cbd5e1'),
  codeHeaderBg: hexToRgb('#e2e8f0'),
  takeawayBg: hexToRgb('#eff6ff'),
  takeawayBorder: hexToRgb('#93c5fd'),
  tokInput: hexToRgb('#64748b'),
  tokOutput: hexToRgb('#3b82f6'),
  tokThink: hexToRgb('#a855f7'),
};

function hexToRgb(hex) {
  const clean = String(hex || '#4f7cff').replace(/^#/, '').trim();
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean.padEnd(6, '0').slice(0, 6);
  const num = parseInt(full, 16) || 0;
  return [
    +(((num >> 16) & 255) / 255).toFixed(4),
    +(((num >> 8) & 255) / 255).toFixed(4),
    +((num & 255) / 255).toFixed(4),
  ];
}

function tintRgb(rgb, bg = [1, 1, 1], alpha = 0.12) {
  return [
    +(bg[0] * (1 - alpha) + rgb[0] * alpha).toFixed(4),
    +(bg[1] * (1 - alpha) + rgb[1] * alpha).toFixed(4),
    +(bg[2] * (1 - alpha) + rgb[2] * alpha).toFixed(4),
  ];
}

function slotColorRgb(slot, idxFallback = 0) {
  const code = String(slot || '').trim().toUpperCase().charCodeAt(0);
  const idx = (code >= 65 && code <= 90) ? (code - 65) : idxFallback;
  const hex = PALETTE_HEX[((idx % PALETTE_HEX.length) + PALETTE_HEX.length) % PALETTE_HEX.length];
  return hexToRgb(hex);
}

// Unicode -> WinAnsi (Windows-1252) + clean ASCII symbol fallbacks
const WIN_ANSI_MAP = {
  '\u20AC': '\x80', // €
  '\u201A': '\x82', // ‚
  '\u0192': '\x83', // ƒ
  '\u201E': '\x84', // „
  '\u2026': '\x85', // …
  '\u2020': '\x86', // †
  '\u2021': '\x87', // ‡
  '\u02C6': '\x88', // ˆ
  '\u2030': '\x89', // ‰
  '\u0160': '\x8A', // Š
  '\u2039': '\x8B', // ‹
  '\u0152': '\x8C', // Œ
  '\u017D': '\x8E', // Ž
  '\u2018': '\x91', // ‘
  '\u2019': '\x92', // ’
  '\u201C': '\x93', // “
  '\u201D': '\x94', // ”
  '\u2022': '\x95', // •
  '\u2013': '\x96', // –
  '\u2014': '\x97', // —
  '\u02DC': '\x98', // ˜
  '\u2122': '\x99', // ™
  '\u0161': '\x9A', // š
  '\u203A': '\x9B', // ›
  '\u0153': '\x9C', // œ
  '\u017E': '\x9E', // ž
  '\u0178': '\x9F', // Ÿ
  // Multi-char / symbol fallbacks outside WinAnsi:
  '\u2713': '[PASS]',
  '\u2714': '[PASS]',
  '\u2705': '[PASS]',
  '\u2717': '[FAIL]',
  '\u2718': '[FAIL]',
  '\u2715': 'x',
  '\u274C': '[FAIL]',
  '\u2192': '->',
  '\u27F6': '->',
  '\u2794': '->',
  '\u21D2': '=>',
  '\u2190': '<-',
  '\u2194': '<->',
  '\u2191': '^',
  '\u2193': 'v',
  '\u25B8': '>',
  '\u25B6': '>',
  '\u25BA': '>',
  '\u25B4': '^',
  '\u25B2': '^',
  '\u25BE': 'v',
  '\u25BC': 'v',
  '\u25C6': '*',
  '\u25C7': '*',
  '\u2605': '*',
  '\u2606': '*',
  '\u26A0': '[!]',
  '\u2139': '[i]',
  '\u2265': '>=',
  '\u2264': '<=',
  '\u2260': '!=',
  '\u2248': '~=',
  '\u221E': 'inf',
  '\u2212': '-',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2015': '\x97',
  '\u2318': 'Cmd+',
  '\u21B5': 'Enter',
  '\u00A0': ' ',
  '\t': '  ',
};

function toWinAnsi(input) {
  if (input == null) return '';
  const raw = maskKnown(String(input));
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const code = raw.charCodeAt(i);
    // Handle surrogate pairs (emojis / astral symbols)
    if (code >= 0xD800 && code <= 0xDBFF) {
      i++; // skip low surrogate
      continue;
    }
    if (code >= 0xDC00 && code <= 0xDFFF) continue;
    if (WIN_ANSI_MAP[ch] !== undefined) {
      out += WIN_ANSI_MAP[ch];
      continue;
    }
    if (code === 0x0A || code === 0x0D) {
      out += ch;
      continue;
    }
    if (code < 0x20 || (code >= 0x7F && code <= 0x9F)) {
      continue;
    }
    if (code <= 0xFF) {
      out += ch;
      continue;
    }
    // Attempt NFKD decomposition for extended Latin characters
    const norm = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    let mapped = '';
    for (let j = 0; j < norm.length; j++) {
      const c2 = norm.charCodeAt(j);
      if (WIN_ANSI_MAP[norm[j]] !== undefined) mapped += WIN_ANSI_MAP[norm[j]];
      else if (c2 >= 0x20 && c2 <= 0x7E) mapped += norm[j];
      else if (c2 >= 0xA0 && c2 <= 0xFF) mapped += norm[j];
    }
    out += mapped;
  }
  return out;
}

function pdfEscape(str) {
  const s = toWinAnsi(str);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (c === '\\') out += '\\\\';
    else if (c === '(') out += '\\(';
    else if (c === ')') out += '\\)';
    else if (c === '\r') out += '\\r';
    else if (c === '\n') out += '\\n';
    else if (code >= 0x20 && code <= 0x7E) out += c;
    else if (code >= 0x80 && code <= 0xFF) {
      out += '\\' + code.toString(8).padStart(3, '0');
    }
  }
  return out;
}

// Approximate character width in points for Standard 14 fonts
const NARROW_CHARS = new Set(['i', 'l', 'I', 'j', 't', 'f', 'r', '.', ',', ':', ';', '!', '|', "'", '`', '(', ')', '[', ']', ' ']);
const WIDE_CHARS = new Set(['W', 'M', 'm', 'w', '%', '@', 'O', 'G', 'Q', 'D', 'H', 'N', 'U', 'A', 'V', 'X', 'Y']);

function measureTextWidth(text, fontSize, { isMono = false, isBold = false } = {}) {
  const s = toWinAnsi(text);
  if (!s) return 0;
  if (isMono) return s.length * fontSize * 0.6;
  let units = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (NARROW_CHARS.has(ch)) units += 0.31;
    else if (WIDE_CHARS.has(ch)) units += 0.72;
    else if (ch >= 'A' && ch <= 'Z') units += 0.64;
    else if (ch >= '0' && ch <= '9') units += 0.56;
    else units += 0.53;
  }
  return units * fontSize * (isBold ? 1.06 : 1.0);
}

function truncateTextToWidth(text, maxWidth, fontSize, opts = {}) {
  const s = toWinAnsi(text).replace(/\r?\n/g, ' ').trim();
  if (measureTextWidth(s, fontSize, opts) <= maxWidth) return s;
  const ellipsis = '...';
  const ellW = measureTextWidth(ellipsis, fontSize, opts);
  const budget = Math.max(0, maxWidth - ellW);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const next = out + s[i];
    if (measureTextWidth(next, fontSize, opts) > budget) break;
    out = next;
  }
  return out.trimEnd() + ellipsis;
}

function wrapText(text, maxWidth, fontSize, opts = {}) {
  const clean = toWinAnsi(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = clean.split('\n');
  const result = [];

  for (const rawLine of rawLines) {
    if (!rawLine) {
      result.push('');
      continue;
    }
    // Preserve leading indentation
    const indentMatch = rawLine.match(/^(\s+)/);
    const indent = indentMatch ? indentMatch[1].slice(0, 16) : '';
    const body = rawLine.slice(indentMatch ? indentMatch[1].length : 0);
    if (!body) {
      result.push('');
      continue;
    }

    const words = body.split(/(\s+)/);
    let current = indent;

    for (const token of words) {
      if (!token) continue;
      const candidate = current === indent && /^\s+$/.test(token) ? current : current + token;
      if (measureTextWidth(candidate, fontSize, opts) <= maxWidth) {
        current = candidate;
        continue;
      }

      // If current already has content beyond indent, flush it first
      if (current.trim().length > 0) {
        result.push(current.replace(/\s+$/, ''));
        current = indent;
        if (/^\s+$/.test(token)) continue;
      }

      // If the single word itself exceeds maxWidth, hard-break it by character
      if (measureTextWidth(indent + token, fontSize, opts) > maxWidth) {
        let chunk = indent;
        for (let i = 0; i < token.length; i++) {
          const nextChunk = chunk + token[i];
          if (measureTextWidth(nextChunk, fontSize, opts) > maxWidth && chunk.length > indent.length) {
            result.push(chunk);
            chunk = indent + token[i];
          } else {
            chunk = nextChunk;
          }
        }
        current = chunk;
      } else {
        current = indent + token;
      }
    }

    if (current.length > 0) {
      result.push(current.replace(/\s+$/, ''));
    }
  }

  return result.length ? result : [''];
}

// Formatting helpers matching public/app.js
function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

function fmtCost(c) {
  const n = Number(c) || 0;
  if (n === 0) return '$0.00';
  if (n < 0.0001) return '$' + n.toFixed(6);
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}

function fmtSec(ms) {
  return ((Number(ms) || 0) / 1000).toFixed(1) + 's';
}

function fmtUtcDate(ms) {
  try {
    const d = new Date(Number(ms) || Date.now());
    if (isNaN(d.getTime())) return new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch (_) {
    return '';
  }
}

function pdfDateString(ms) {
  try {
    const d = new Date(Number(ms) || Date.now());
    const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return `D:${iso}Z`;
  } catch (_) {
    return 'D:20260101000000Z';
  }
}

function shortModelLabel(label) {
  const s = String(label || '');
  return s.replace(/^(Gemini|Claude|Grok|GPT-OSS|GPT|Llama|Mistral|OpenAI|Anthropic|Google|DeepSeek|Qwen3|Qwen|Kimi|GLM)\s+/i, '').trim() || s;
}

function pdfFilename(title, atMs) {
  const slug = String(title || 'comparison')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'comparison';
  let dateStr = '';
  try {
    const d = new Date(Number(atMs) || Date.now());
    dateStr = d.toISOString().slice(0, 10);
  } catch (_) {
    dateStr = 'report';
  }
  return `llm-compare-${slug}-${dateStr}.pdf`;
}

// ---------------------------------------------------------------------------
// Data Normalization & Scoring (mirrors buildScorecard in public/app.js)
// ---------------------------------------------------------------------------
function computeReportData(payload = {}) {
  const taskObj = payload.task || null;
  const taskId = String(payload.taskId || (taskObj && taskObj.id) || 'custom');
  const taskTitle = String(
    payload.taskTitle || payload.title || (taskObj && taskObj.title) || (taskId === 'custom' ? 'Custom Prompt' : taskId)
  ).trim();
  const prompt = String(
    (typeof payload.prompt === 'string' && payload.prompt.trim())
      ? payload.prompt
      : ((taskObj && typeof taskObj.prompt === 'string') ? taskObj.prompt : '')
  ).trim();
  const language = payload.language || (taskObj && taskObj.language) || null;
  const category = payload.category || (taskObj && taskObj.category) || (language ? 'coding' : 'general');
  const at = Number(payload.at) || Date.now();
  const execOutputs = (payload.execOutputs && typeof payload.execOutputs === 'object') ? payload.execOutputs : {};

  // Normalize results from any supported shape:
  //   1. payload.results as Map/Object { A: {...}, B: {...} }
  //   2. payload.results as Array [{ slot: 'A', ... }]
  //   3. payload.slots as Array [{ slot: 'A', data: {...} }]
  const bySlot = new Map();
  if (Array.isArray(payload.slots)) {
    for (const s of payload.slots) {
      if (s && s.slot && s.data) bySlot.set(String(s.slot), s.data);
    }
  }
  if (Array.isArray(payload.results)) {
    for (const r of payload.results) {
      if (r && r.slot) bySlot.set(String(r.slot), r);
    }
  } else if (payload.results && typeof payload.results === 'object') {
    for (const [k, v] of Object.entries(payload.results)) {
      if (v && typeof v === 'object') bySlot.set(String(v.slot || k), { slot: v.slot || k, ...v });
    }
  }

  // Merge model metadata with results in slot order
  const modelsInput = Array.isArray(payload.models) ? payload.models : [];
  const slotOrder = [];
  const modelMetaBySlot = new Map();
  for (const m of modelsInput) {
    if (!m || !m.slot) continue;
    const s = String(m.slot);
    if (!modelMetaBySlot.has(s)) {
      slotOrder.push(s);
      modelMetaBySlot.set(s, m);
    }
  }
  for (const s of bySlot.keys()) {
    if (!modelMetaBySlot.has(s)) {
      slotOrder.push(s);
      modelMetaBySlot.set(s, bySlot.get(s));
    }
  }

  const allSlots = slotOrder.map((slot, idx) => {
    const m = modelMetaBySlot.get(slot) || {};
    const r = bySlot.get(slot) || {};
    const merged = { ...m, ...r, slot };
    const promptTokens = Math.max(0, Number(merged.promptTokens) || 0);
    const completionTokens = Math.max(0, Number(merged.completionTokens) || 0);
    const reasoningTokens = Math.max(0, Number(merged.reasoningTokens) || 0);
    const answerTokens = Math.max(0, completionTokens - reasoningTokens);
    const totalTokens = Math.max(promptTokens + completionTokens, Number(merged.totalTokens) || 0);
    const wallMs = Math.max(0, Number(merged.wallMs) || Number(merged.apiLatencyMs) || 0);
    const tokensPerSec = Number(merged.tokensPerSec) || (wallMs > 0 ? +(completionTokens / (wallMs / 1000)).toFixed(1) : 0);
    const costUsd = Math.max(0, Number(merged.costUsd) || 0);
    const total = Math.max(0, Number(merged.total) || 0);
    const passed = Math.max(0, Number(merged.passed) || 0);
    const correctness = total > 0
      ? (merged.correctness != null ? Number(merged.correctness) : Math.round((passed / total) * 100))
      : null;
    const solved = total > 0 ? (merged.solved != null ? !!merged.solved : passed === total) : null;
    const thinking = merged.thinking || (merged.model ? thinkingProfile(merged) : { label: merged.effort || 'Default', detail: '' });
    const code = typeof merged.code === 'string' ? merged.code : (typeof merged.text === 'string' ? merged.text : '');
    const reasoning = typeof merged.reasoning === 'string' ? merged.reasoning : '';
    const execOut = typeof execOutputs[slot] === 'string' ? execOutputs[slot].trim() : '';

    return {
      slot,
      index: idx,
      colorRgb: slotColorRgb(slot, idx),
      label: String(merged.label || merged.model || `Slot ${slot}`),
      provider: String(merged.provider || 'provider'),
      model: String(merged.model || merged.catalogId || 'model'),
      thinking,
      error: merged.error ? scrubError(String(merged.error)) : null,
      repaired: !!merged.repaired,
      contextWarning: merged.contextWarning || null,
      attachmentNotes: Array.isArray(merged.attachmentNotes) ? merged.attachmentNotes : [],
      promptTokens,
      completionTokens,
      reasoningTokens,
      answerTokens,
      totalTokens,
      wallMs,
      tokensPerSec,
      costUsd,
      passed,
      total,
      correctness,
      solved,
      history: Array.isArray(merged.history) ? merged.history : [],
      code,
      reasoning,
      execOut,
    };
  });

  const validResults = allSlots.filter((r) => !r.error);
  const isCustom = validResults.length === 0 || validResults.every((r) => !r.total);

  const minCost = validResults.length ? Math.min(...validResults.map((r) => Math.max(r.costUsd, 1e-9))) : 1e-9;
  const minWall = validResults.length ? Math.min(...validResults.map((r) => Math.max(r.wallMs, 1))) : 1;
  const minTok = validResults.length ? Math.min(...validResults.map((r) => Math.max(r.totalTokens, 1))) : 1;

  const scoredSlots = allSlots.map((r) => {
    if (r.error) {
      return {
        ...r,
        axes: { Speed: 0, 'Cost efficiency': 0, 'Token efficiency': 0, ...(isCustom ? {} : { Correctness: 0 }) },
        overall: 0,
      };
    }
    const axes = {
      Speed: Math.round((minWall / Math.max(r.wallMs, 1)) * 100),
      'Cost efficiency': Math.round((minCost / Math.max(r.costUsd, 1e-9)) * 100),
      'Token efficiency': Math.round((minTok / Math.max(r.totalTokens, 1)) * 100),
    };
    if (!isCustom) {
      axes.Correctness = r.correctness == null ? 0 : Math.round(r.correctness);
    }
    const vals = Object.values(axes);
    const overall = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    return { ...r, axes, overall };
  });

  const validScored = scoredSlots.filter((r) => !r.error);
  const ranked = [...validScored].sort((a, b) => b.overall - a.overall);
  const winner = ranked[0] || scoredSlots[0] || null;
  const cheapest = [...validScored].sort((a, b) => a.costUsd - b.costUsd)[0] || null;
  const priciest = [...validScored].sort((a, b) => b.costUsd - a.costUsd)[0] || null;
  const fastest = [...validScored].sort((a, b) => a.wallMs - b.wallMs)[0] || null;
  const slowest = [...validScored].sort((a, b) => b.wallMs - a.wallMs)[0] || null;
  const highestTps = [...validScored].sort((a, b) => b.tokensPerSec - a.tokensPerSec)[0] || null;

  const costMult = (cheapest && priciest) ? (priciest.costUsd / Math.max(cheapest.costUsd, 1e-9)) : 1;
  const timeMult = (fastest && slowest) ? (slowest.wallMs / Math.max(fastest.wallMs, 1)) : 1;

  // Build executive takeaway sentences
  const takeawayBullets = [];
  if (validScored.length > 0) {
    if (isCustom) {
      takeawayBullets.push(
        `Ungraded / custom evaluation across ${validScored.length} model${validScored.length > 1 ? 's' : ''} — comparing latency, throughput, token economics, and full output quality.`
      );
    } else {
      const allSolved = validScored.every((r) => r.solved);
      if (allSolved) {
        takeawayBullets.push(`All ${validScored.length} models achieved 100% correctness on the hidden verification test suite.`);
      } else {
        const corrSummary = validScored.map((r) => `${r.label}: ${r.correctness ?? 0}% (${r.passed}/${r.total})`).join(' · ');
        takeawayBullets.push(`Hidden test correctness: ${corrSummary}.`);
      }
    }
    if (cheapest && priciest && validScored.length > 1 && costMult >= 1.15) {
      takeawayBullets.push(
        `Cost leader: ${cheapest.label} at ${fmtCost(cheapest.costUsd)}/task (${fmtCost(cheapest.costUsd * 1000)} per 1,000 tasks) — ${costMult.toFixed(1)}x cheaper than ${priciest.label} (${fmtCost(priciest.costUsd)}).`
      );
    } else if (cheapest) {
      takeawayBullets.push(`Cost per task: ${cheapest.label} at ${fmtCost(cheapest.costUsd)}/task (${fmtCost(cheapest.costUsd * 1000)} per 1,000 tasks).`);
    }
    if (fastest && slowest && validScored.length > 1 && timeMult >= 1.15) {
      takeawayBullets.push(
        `Speed leader: ${fastest.label} finished in ${fmtSec(fastest.wallMs)} (${fastest.tokensPerSec} tok/s) — ${timeMult.toFixed(1)}x faster than ${slowest.label} (${fmtSec(slowest.wallMs)}).`
      );
    } else if (fastest) {
      takeawayBullets.push(`Fastest wall time: ${fastest.label} in ${fmtSec(fastest.wallMs)} (${fastest.tokensPerSec} tok/s).`);
    }
  }

  const judge = (payload.judge && Array.isArray(payload.judge.results) && payload.judge.results.length)
    ? payload.judge
    : null;
  if (judge && judge.winnerSlot) {
    const jWin = judge.results.find((r) => r.slot === judge.winnerSlot);
    if (jWin) {
      takeawayBullets.push(
        `Blind LLM-as-Judge (${(judge.judge && judge.judge.label) || 'Judge'}) selected ${jWin.label} (seen as Response ${jWin.blindId}) with ${jWin.overall ?? '—'}/10 overall.`
      );
    }
  }

  return {
    taskId,
    taskTitle,
    prompt,
    language,
    category,
    isCustom,
    at,
    user: payload.user || payload.userName || null,
    slots: scoredSlots,
    validScored,
    ranked,
    winner,
    cheapest,
    priciest,
    fastest,
    slowest,
    highestTps,
    costMult,
    timeMult,
    takeawayBullets,
    judge,
  };
}

// ---------------------------------------------------------------------------
// Low-level PDF Page Canvas Builder (Top-down Y coordinate system)
// ---------------------------------------------------------------------------
class PdfDocumentBuilder {
  constructor(report) {
    this.report = report;
    this.pages = [];
    this.currentPage = null;
    this.cursorY = M_TOP;
  }

  addPage({ isFirstPage = false } = {}) {
    const ops = [];
    this.pages.push({ ops, isFirstPage });
    this.currentPage = ops;
    if (isFirstPage) {
      this.drawFirstPageBanner();
    } else {
      this.drawRunningHeader();
    }
    return ops;
  }

  ensureSpace(heightNeeded) {
    if (!this.currentPage) {
      this.addPage({ isFirstPage: true });
    }
    if (this.cursorY + heightNeeded > PAGE_H - M_BOTTOM) {
      this.addPage({ isFirstPage: false });
      return true; // page break occurred
    }
    return false;
  }

  // Convert top-down Y to PDF bottom-up Y
  yPdf(topY) {
    return +(PAGE_H - topY).toFixed(2);
  }

  rect(x, topY, w, h, { fill = null, stroke = null, lineWidth = 0.75 } = {}) {
    if (!fill && !stroke) return;
    const py = +(PAGE_H - topY - h).toFixed(2);
    const cmds = ['q'];
    if (lineWidth) cmds.push(`${lineWidth.toFixed(2)} w`);
    if (fill) cmds.push(`${fill[0]} ${fill[1]} ${fill[2]} rg`);
    if (stroke) cmds.push(`${stroke[0]} ${stroke[1]} ${stroke[2]} RG`);
    const op = fill && stroke ? 'B' : (fill ? 'f' : 'S');
    cmds.push(`${x.toFixed(2)} ${py} ${w.toFixed(2)} ${h.toFixed(2)} re ${op}`);
    cmds.push('Q');
    this.currentPage.push(cmds.join(' '));
  }

  line(x1, topY1, x2, topY2, { stroke = COLORS.divider, lineWidth = 0.6, dash = null } = {}) {
    const py1 = this.yPdf(topY1);
    const py2 = this.yPdf(topY2);
    const cmds = ['q', `${lineWidth.toFixed(2)} w`, `${stroke[0]} ${stroke[1]} ${stroke[2]} RG`];
    if (Array.isArray(dash) && dash.length) {
      cmds.push(`[${dash.join(' ')}] 0 d`);
    }
    cmds.push(`${x1.toFixed(2)} ${py1} m ${x2.toFixed(2)} ${py2} l S`, 'Q');
    this.currentPage.push(cmds.join(' '));
  }

  // Font codes:
  //   F1 = Helvetica, F2 = Helvetica-Bold, F3 = Helvetica-Oblique,
  //   F4 = Courier,   F5 = Courier-Bold
  text(str, x, topY, {
    font = 'F1',
    size = 9.5,
    color = COLORS.textBody,
    align = 'left',
    maxWidth = null,
  } = {}) {
    const isMono = font === 'F4' || font === 'F5';
    const isBold = font === 'F2' || font === 'F5';
    let clean = toWinAnsi(str).replace(/\r?\n/g, ' ');
    if (maxWidth != null && maxWidth > 0) {
      clean = truncateTextToWidth(clean, maxWidth, size, { isMono, isBold });
    }
    if (!clean) return;
    let drawX = x;
    if (align === 'right' || align === 'center') {
      const w = measureTextWidth(clean, size, { isMono, isBold });
      if (align === 'right') drawX = x - w;
      else if (align === 'center') drawX = x - w / 2;
    }
    const baselineY = this.yPdf(topY + size * 0.82);
    this.currentPage.push(
      `BT /${font} ${size.toFixed(2)} Tf ${color[0]} ${color[1]} ${color[2]} rg 1 0 0 1 ${drawX.toFixed(2)} ${baselineY} Tm (${pdfEscape(clean)}) Tj ET`
    );
  }

  drawFirstPageBanner() {
    const r = this.report;
    // Top dark banner across full page width
    this.rect(0, 0, PAGE_W, 74, { fill: COLORS.bannerBg });
    // Top accent stripe (indigo + mint split)
    this.rect(0, 0, PAGE_W * 0.62, 3.5, { fill: COLORS.bannerAccent });
    this.rect(PAGE_W * 0.62, 0, PAGE_W * 0.38, 3.5, { fill: COLORS.bannerMint });

    // Diamond logo badge
    this.rect(M_LEFT, 16, 24, 24, { fill: COLORS.bannerAccent });
    this.text('*', M_LEFT + 12, 21, { font: 'F2', size: 14, color: COLORS.textWhite, align: 'center' });

    this.text('LLM Compare — Benchmark & Evaluation Report', M_LEFT + 32, 16, {
      font: 'F2',
      size: 15,
      color: COLORS.textWhite,
    });
    this.text('Live side-by-side multi-model comparison · speed, token economics, correctness & full outputs', M_LEFT + 32, 35, {
      font: 'F1',
      size: 8.5,
      color: COLORS.textBannerSub,
    });

    // Bottom strip inside banner with task & timestamp metadata
    const metaLeft = `Task: ${r.taskTitle} (${r.isCustom ? 'Ungraded / Custom Prompt' : 'Graded Coding Task'})`;
    const metaRight = `Generated: ${fmtUtcDate(r.at)} · ${r.slots.length} Model${r.slots.length === 1 ? '' : 's'}`;
    this.text(metaLeft, M_LEFT, 54, {
      font: 'F2',
      size: 8.5,
      color: COLORS.bannerMint,
      maxWidth: CONTENT_W * 0.6,
    });
    this.text(metaRight, PAGE_W - M_RIGHT, 54, {
      font: 'F1',
      size: 8,
      color: COLORS.textBannerSub,
      align: 'right',
    });

    this.cursorY = 88;
  }

  drawRunningHeader() {
    const r = this.report;
    this.rect(0, 0, PAGE_W, 30, { fill: COLORS.bannerBg });
    this.rect(0, 0, PAGE_W, 2.2, { fill: COLORS.bannerAccent });
    this.text('LLM Compare — Evaluation Report', M_LEFT, 10, {
      font: 'F2',
      size: 8.5,
      color: COLORS.textWhite,
    });
    this.text(r.taskTitle, PAGE_W - M_RIGHT, 10, {
      font: 'F1',
      size: 8.5,
      color: COLORS.textBannerSub,
      align: 'right',
      maxWidth: 300,
    });
    this.cursorY = 44;
  }

  drawSectionHeader(stepNum, title, subtitle = '') {
    this.ensureSpace(34);
    const y = this.cursorY;
    this.rect(M_LEFT, y, 20, 18, { fill: COLORS.bannerAccent });
    this.text(String(stepNum), M_LEFT + 10, y + 4, {
      font: 'F2',
      size: 9.5,
      color: COLORS.textWhite,
      align: 'center',
    });
    this.text(title, M_LEFT + 27, y + 3, {
      font: 'F2',
      size: 12,
      color: COLORS.textDark,
    });
    if (subtitle) {
      const titleW = measureTextWidth(title, 12, { isBold: true });
      this.text(subtitle, M_LEFT + 35 + titleW, y + 5, {
        font: 'F1',
        size: 8.5,
        color: COLORS.textMuted,
        maxWidth: CONTENT_W - (40 + titleW),
      });
    }
    this.line(M_LEFT, y + 22, PAGE_W - M_RIGHT, y + 22, { stroke: COLORS.cardBorder, lineWidth: 0.8 });
    this.cursorY = y + 29;
  }

  finalizeFooters() {
    const total = this.pages.length;
    const r = this.report;
    for (let i = 0; i < total; i++) {
      this.currentPage = this.pages[i].ops;
      const footY = PAGE_H - 28;
      this.line(M_LEFT, footY - 4, PAGE_W - M_RIGHT, footY - 4, { stroke: COLORS.divider, lineWidth: 0.6 });
      this.text('LLM Compare · Live Side-by-Side Model Arena', M_LEFT, footY + 2, {
        font: 'F1',
        size: 7.5,
        color: COLORS.textFaint,
      });
      this.text(r.taskTitle, PAGE_W / 2, footY + 2, {
        font: 'F1',
        size: 7.5,
        color: COLORS.textFaint,
        align: 'center',
        maxWidth: 200,
      });
      this.text(`Page ${i + 1} of ${total}`, PAGE_W - M_RIGHT, footY + 2, {
        font: 'F2',
        size: 7.5,
        color: COLORS.textMuted,
        align: 'right',
      });
    }
  }

  toBuffer() {
    this.finalizeFooters();

    // Object ID allocation:
    // 1 = Catalog
    // 2 = Pages
    // 3..7 = Fonts F1..F5
    // 8 = Info
    // 9.. = Page content stream + Page dict pairs
    const objects = new Map();
    objects.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'));
    objects.set(3, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'));
    objects.set(4, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'latin1'));
    objects.set(5, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>', 'latin1'));
    objects.set(6, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>', 'latin1'));
    objects.set(7, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>', 'latin1'));

    const infoTitle = pdfEscape(`LLM Compare Report - ${this.report.taskTitle}`);
    const created = pdfDateString(this.report.at);
    objects.set(
      8,
      Buffer.from(
        `<< /Title (${infoTitle}) /Creator (LLM Compare) /Producer (LLM Compare PDF 1.4 Generator) /CreationDate (${created}) >>`,
        'latin1'
      )
    );

    let nextId = 9;
    const pageObjectIds = [];

    for (const p of this.pages) {
      const contentId = nextId++;
      const pageId = nextId++;
      pageObjectIds.push(pageId);

      const streamText = p.ops.join('\n');
      const compressed = zlib.deflateSync(Buffer.from(streamText, 'latin1'));
      const contentObj = Buffer.concat([
        Buffer.from(`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
        compressed,
        Buffer.from('\nendstream', 'latin1'),
      ]);
      objects.set(contentId, contentObj);

      const pageDict =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R /F5 7 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>`;
      objects.set(pageId, Buffer.from(pageDict, 'latin1'));
    }

    const kids = pageObjectIds.map((id) => `${id} 0 R`).join(' ');
    objects.set(2, Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pageObjectIds.length} >>`, 'latin1'));

    const totalObjects = nextId - 1;
    const chunks = [];
    const offsets = new Array(totalObjects + 1).fill(0);
    let byteOffset = 0;

    const pushBuf = (buf) => {
      chunks.push(buf);
      byteOffset += buf.length;
    };

    pushBuf(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1'));

    for (let id = 1; id <= totalObjects; id++) {
      offsets[id] = byteOffset;
      pushBuf(Buffer.from(`${id} 0 obj\n`, 'latin1'));
      pushBuf(objects.get(id));
      pushBuf(Buffer.from('\nendobj\n', 'latin1'));
    }

    const xrefOffset = byteOffset;
    const xrefLines = [`xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`];
    for (let id = 1; id <= totalObjects; id++) {
      xrefLines.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    }
    pushBuf(Buffer.from(xrefLines.join(''), 'latin1'));

    const trailer =
      `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R /Info 8 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`;
    pushBuf(Buffer.from(trailer, 'latin1'));

    return Buffer.concat(chunks);
  }
}

// ---------------------------------------------------------------------------
// Section 1: Executive Summary (Prompt, Takeaway Callout, Ranked Model Cards)
// ---------------------------------------------------------------------------
function renderExecutiveSummary(doc, r) {
  doc.drawSectionHeader(1, 'Executive Summary', 'Task prompt, key comparative takeaways & ranked model scorecard');

  // 1A. Task & Prompt Box
  const promptText = r.prompt || '(No prompt text recorded)';
  const maxPromptLines = 10;
  const wrappedPrompt = wrapText(promptText, CONTENT_W - 24, 8.5, { isMono: false });
  const shownPromptLines = wrappedPrompt.slice(0, maxPromptLines);
  if (wrappedPrompt.length > maxPromptLines) {
    shownPromptLines[maxPromptLines - 1] = truncateTextToWidth(
      shownPromptLines[maxPromptLines - 1] + ` ... (+${wrappedPrompt.length - maxPromptLines} more lines)`,
      CONTENT_W - 24,
      8.5
    );
  }
  const promptBoxH = 24 + shownPromptLines.length * 11.5 + 8;
  doc.ensureSpace(promptBoxH + 10);
  const py = doc.cursorY;
  doc.rect(M_LEFT, py, CONTENT_W, promptBoxH, { fill: COLORS.cardBg, stroke: COLORS.cardBorder, lineWidth: 0.7 });
  doc.rect(M_LEFT, py, CONTENT_W, 18, { fill: COLORS.cardAltBg });
  doc.text(`TASK PROMPT · ${r.taskTitle}`, M_LEFT + 10, py + 4.5, {
    font: 'F2',
    size: 8,
    color: COLORS.textMuted,
    maxWidth: CONTENT_W - 140,
  });
  doc.text(
    r.isCustom ? 'Ungraded / Custom Evaluation' : `Graded Coding Benchmark (${(r.validScored[0] && r.validScored[0].total) || 0} hidden tests)`,
    PAGE_W - M_RIGHT - 10,
    py + 4.5,
    { font: 'F2', size: 7.5, color: COLORS.bannerAccent, align: 'right' }
  );

  shownPromptLines.forEach((line, idx) => {
    doc.text(line, M_LEFT + 10, py + 23 + idx * 11.5, {
      font: 'F1',
      size: 8.5,
      color: COLORS.textBody,
    });
  });
  doc.cursorY = py + promptBoxH + 10;

  // 1B. Executive Takeaway Callout Box
  if (r.winner) {
    const bulletLines = [];
    for (const b of r.takeawayBullets) {
      const lines = wrapText(`• ${b}`, CONTENT_W - 135, 8.5);
      bulletLines.push(...lines);
    }
    const calloutH = Math.max(54, 24 + bulletLines.length * 11.5 + 8);
    doc.ensureSpace(calloutH + 12);
    const cy = doc.cursorY;
    const winRgb = r.winner.colorRgb || COLORS.bannerAccent;

    doc.rect(M_LEFT, cy, CONTENT_W, calloutH, {
      fill: COLORS.takeawayBg,
      stroke: COLORS.takeawayBorder,
      lineWidth: 0.8,
    });
    doc.rect(M_LEFT, cy, 4.5, calloutH, { fill: winRgb });

    doc.text(
      `BEST BALANCED MODEL: ${r.winner.label.toUpperCase()} (Slot ${r.winner.slot})`,
      M_LEFT + 14,
      cy + 7,
      { font: 'F2', size: 9.5, color: COLORS.textDark, maxWidth: CONTENT_W - 140 }
    );

    bulletLines.forEach((line, idx) => {
      doc.text(line, M_LEFT + 14, cy + 21 + idx * 11.5, {
        font: 'F1',
        size: 8.3,
        color: COLORS.textBody,
      });
    });

    // Right-side overall score badge inside callout
    const badgeW = 96;
    const badgeH = calloutH - 16;
    const badgeX = PAGE_W - M_RIGHT - badgeW - 8;
    const badgeY = cy + 8;
    doc.rect(badgeX, badgeY, badgeW, badgeH, { fill: [1, 1, 1], stroke: winRgb, lineWidth: 1.1 });
    doc.text(`${r.winner.overall}`, badgeX + badgeW / 2, badgeY + Math.max(6, (badgeH - 28) / 2), {
      font: 'F2',
      size: 18,
      color: winRgb,
      align: 'center',
    });
    doc.text('OVERALL / 100', badgeX + badgeW / 2, badgeY + Math.max(6, (badgeH - 28) / 2) + 20, {
      font: 'F2',
      size: 7,
      color: COLORS.textMuted,
      align: 'center',
    });

    doc.cursorY = cy + calloutH + 10;
  }

  // 1C. Ranked Model Summary Cards (up to 3 per row)
  const cardsList = r.ranked.length ? r.ranked : r.slots;
  const perRow = Math.min(3, Math.max(1, cardsList.length));
  const gap = 10;
  const cardW = (CONTENT_W - gap * (perRow - 1)) / perRow;
  const cardH = 74;

  for (let i = 0; i < cardsList.length; i += perRow) {
    const rowItems = cardsList.slice(i, i + perRow);
    doc.ensureSpace(cardH + 10);
    const ry = doc.cursorY;

    rowItems.forEach((m, colIdx) => {
      const rankNum = i + colIdx + 1;
      const cx = M_LEFT + colIdx * (cardW + gap);
      const rgb = m.colorRgb || COLORS.bannerAccent;

      doc.rect(cx, ry, cardW, cardH, {
        fill: rankNum === 1 ? tintRgb(rgb, [1, 1, 1], 0.07) : COLORS.cardBg,
        stroke: rankNum === 1 ? rgb : COLORS.cardBorder,
        lineWidth: rankNum === 1 ? 1.1 : 0.7,
      });
      doc.rect(cx, ry, cardW, 3, { fill: rgb });

      // Rank + Slot badge
      doc.rect(cx + 8, ry + 8, 22, 13, { fill: rgb });
      doc.text(`#${rankNum}`, cx + 19, ry + 10.5, {
        font: 'F2',
        size: 7.5,
        color: COLORS.textWhite,
        align: 'center',
      });

      doc.text(m.label, cx + 35, ry + 8.5, {
        font: 'F2',
        size: 9.2,
        color: COLORS.textDark,
        maxWidth: cardW - 78,
      });
      doc.text(`${m.overall}/100`, cx + cardW - 8, ry + 8.5, {
        font: 'F2',
        size: 9.5,
        color: rgb,
        align: 'right',
      });

      const subLine = `Slot ${m.slot} · ${m.provider} · ${(m.thinking && m.thinking.label) || 'Default'}`;
      doc.text(subLine, cx + 8, ry + 24.5, {
        font: 'F1',
        size: 7.2,
        color: COLORS.textMuted,
        maxWidth: cardW - 16,
      });

      doc.line(cx + 8, ry + 36, cx + cardW - 8, ry + 36, { stroke: COLORS.divider, lineWidth: 0.5 });

      // 3 mini metrics across bottom of card
      const stat1Label = r.isCustom ? 'OUT TOKENS' : 'CORRECTNESS';
      const stat1Val = r.isCustom
        ? fmtInt(m.answerTokens)
        : (m.correctness == null ? '—' : `${m.correctness}% (${m.passed}/${m.total})`);
      const stat2Label = 'COST / TASK';
      const stat2Val = fmtCost(m.costUsd);
      const stat3Label = 'SPEED';
      const stat3Val = `${fmtSec(m.wallMs)} (${Math.round(m.tokensPerSec)}/s)`;

      const colW = (cardW - 16) / 3;
      [
        [stat1Label, stat1Val],
        [stat2Label, stat2Val],
        [stat3Label, stat3Val],
      ].forEach(([k, v], sIdx) => {
        const sx = cx + 8 + sIdx * colW;
        doc.text(k, sx, ry + 41, { font: 'F2', size: 6.3, color: COLORS.textFaint, maxWidth: colW - 2 });
        doc.text(v, sx, ry + 51, { font: 'F2', size: 8, color: COLORS.textDark, maxWidth: colW - 2 });
      });
    });

    doc.cursorY = ry + cardH + 8;
  }
}

// ---------------------------------------------------------------------------
// Section 2: Visual Comparison Graphs (Native PDF Vector Charts)
// ---------------------------------------------------------------------------
function drawHorizontalBarChartPanel(doc, x, y, w, h, {
  title,
  subtitle,
  items, // [{ slot, label, colorRgb, value, valueLabel, isBest }]
  maxValue,
}) {
  doc.rect(x, y, w, h, { fill: COLORS.cardBg, stroke: COLORS.cardBorder, lineWidth: 0.7 });
  doc.rect(x, y, w, 20, { fill: COLORS.cardAltBg });
  doc.text(title, x + 9, y + 5.5, { font: 'F2', size: 8.8, color: COLORS.textDark });
  if (subtitle) {
    doc.text(subtitle, x + w - 9, y + 6, { font: 'F1', size: 7.2, color: COLORS.textMuted, align: 'right' });
  }

  const n = Math.max(1, items.length);
  const plotTop = y + 27;
  const plotBottom = y + h - 14;
  const plotH = Math.max(24, plotBottom - plotTop);
  const labelColW = 78;
  const valColW = 64;
  const trackX = x + labelColW;
  const trackW = Math.max(40, w - labelColW - valColW - 8);

  // Subtle vertical gridlines (0%, 25%, 50%, 75%, 100%)
  for (let g = 0; g <= 4; g++) {
    const gx = trackX + (trackW * g) / 4;
    doc.line(gx, plotTop - 2, gx, plotBottom + 2, {
      stroke: g === 0 ? COLORS.cardBorder : COLORS.gridLine,
      lineWidth: g === 0 ? 0.7 : 0.4,
    });
  }

  const rowH = plotH / n;
  const barH = Math.min(13, Math.max(6, rowH * 0.56));
  const safeMax = Math.max(maxValue || 0, ...items.map((it) => it.value || 0), 1e-9);

  items.forEach((it, idx) => {
    const rowCenterY = plotTop + idx * rowH + rowH / 2;
    const barY = rowCenterY - barH / 2;

    // Slot dot + short model name
    doc.rect(x + 7, rowCenterY - 3.5, 7, 7, { fill: it.colorRgb });
    doc.text(shortModelLabel(it.label), x + 17, rowCenterY - 4, {
      font: it.isBest ? 'F2' : 'F1',
      size: 7.6,
      color: it.isBest ? COLORS.textDark : COLORS.textBody,
      maxWidth: labelColW - 20,
    });

    // Background bar track
    doc.rect(trackX, barY, trackW, barH, { fill: COLORS.cardAltBg, stroke: COLORS.divider, lineWidth: 0.4 });

    // Value bar fill
    const ratio = Math.max(0, Math.min(1, (it.value || 0) / safeMax));
    const fillW = it.value > 0 ? Math.max(3, trackW * ratio) : 1.5;
    doc.rect(trackX, barY, fillW, barH, { fill: it.colorRgb });

    // Value label on right
    doc.text(it.valueLabel, trackX + trackW + 5, rowCenterY - 4, {
      font: it.isBest ? 'F2' : 'F1',
      size: 7.5,
      color: it.isBest ? COLORS.goodText : COLORS.textBody,
      maxWidth: valColW - 4,
    });
  });
}

function drawTokenBreakdownChart(doc, x, y, w, h, slots) {
  doc.rect(x, y, w, h, { fill: COLORS.cardBg, stroke: COLORS.cardBorder, lineWidth: 0.7 });
  doc.rect(x, y, w, 20, { fill: COLORS.cardAltBg });
  doc.text('Token Usage Breakdown (Input vs. Answer Output vs. Thinking)', x + 9, y + 5.5, {
    font: 'F2',
    size: 8.8,
    color: COLORS.textDark,
  });

  // Legend in header right
  const legItems = [
    ['Input (Prompt)', COLORS.tokInput],
    ['Answer Output', COLORS.tokOutput],
    ['Thinking / Reasoning', COLORS.tokThink],
  ];
  let lx = x + w - 235;
  legItems.forEach(([lbl, col]) => {
    doc.rect(lx, y + 6.5, 7, 7, { fill: col });
    doc.text(lbl, lx + 10, y + 6, { font: 'F1', size: 7, color: COLORS.textMuted });
    lx += measureTextWidth(lbl, 7) + 18;
  });

  const n = Math.max(1, slots.length);
  const plotTop = y + 26;
  const plotBottom = y + h - 8;
  const plotH = Math.max(24, plotBottom - plotTop);
  const labelColW = 100;
  const valColW = 155;
  const trackX = x + labelColW;
  const trackW = Math.max(60, w - labelColW - valColW - 10);
  const maxTotal = Math.max(...slots.map((s) => s.totalTokens || 1), 1);

  for (let g = 0; g <= 4; g++) {
    const gx = trackX + (trackW * g) / 4;
    doc.line(gx, plotTop - 2, gx, plotBottom + 2, {
      stroke: g === 0 ? COLORS.cardBorder : COLORS.gridLine,
      lineWidth: g === 0 ? 0.7 : 0.4,
    });
  }

  const rowH = plotH / n;
  const barH = Math.min(12, Math.max(6, rowH * 0.56));

  slots.forEach((s, idx) => {
    const rowCenterY = plotTop + idx * rowH + rowH / 2;
    const barY = rowCenterY - barH / 2;

    doc.rect(x + 8, rowCenterY - 3.5, 7, 7, { fill: s.colorRgb });
    doc.text(s.label, x + 18, rowCenterY - 4, {
      font: 'F1',
      size: 7.6,
      color: COLORS.textBody,
      maxWidth: labelColW - 22,
    });

    doc.rect(trackX, barY, trackW, barH, { fill: COLORS.cardAltBg, stroke: COLORS.divider, lineWidth: 0.4 });

    const inW = (s.promptTokens / maxTotal) * trackW;
    const outW = (s.answerTokens / maxTotal) * trackW;
    const thkW = (s.reasoningTokens / maxTotal) * trackW;

    let curX = trackX;
    if (inW > 0.5) {
      doc.rect(curX, barY, inW, barH, { fill: COLORS.tokInput });
      curX += inW;
    }
    if (outW > 0.5) {
      doc.rect(curX, barY, outW, barH, { fill: COLORS.tokOutput });
      curX += outW;
    }
    if (thkW > 0.5) {
      doc.rect(curX, barY, thkW, barH, { fill: COLORS.tokThink });
    }

    const breakdownLabel = `${fmtInt(s.totalTokens)} tok (In ${fmtInt(s.promptTokens)} / Out ${fmtInt(s.answerTokens)} / Thk ${fmtInt(s.reasoningTokens)})`;
    doc.text(breakdownLabel, trackX + trackW + 6, rowCenterY - 4, {
      font: 'F1',
      size: 7.1,
      color: COLORS.textBody,
      maxWidth: valColW - 8,
    });
  });
}

function drawMultiAxisEfficiencyChart(doc, x, y, w, h, slots, isCustom) {
  doc.rect(x, y, w, h, { fill: COLORS.cardBg, stroke: COLORS.cardBorder, lineWidth: 0.7 });
  doc.rect(x, y, w, 20, { fill: COLORS.cardAltBg });
  doc.text('Multi-Axis Efficiency Profile (0-100 Normalized Score)', x + 9, y + 5.5, {
    font: 'F2',
    size: 8.8,
    color: COLORS.textDark,
  });
  doc.text('100 = best in comparison run across each axis', x + w - 9, y + 6, {
    font: 'F1',
    size: 7.2,
    color: COLORS.textMuted,
    align: 'right',
  });

  const axes = isCustom
    ? ['Speed', 'Cost efficiency', 'Token efficiency']
    : ['Correctness', 'Speed', 'Cost efficiency', 'Token efficiency'];

  const colW = (w - 16) / axes.length;
  const topY = y + 26;
  const subH = h - 32;

  axes.forEach((axisName, aIdx) => {
    const ax = x + 8 + aIdx * colW;
    const innerW = colW - 8;
    doc.text(axisName.toUpperCase(), ax + 4, topY, {
      font: 'F2',
      size: 7.3,
      color: COLORS.textMuted,
    });

    const listTop = topY + 12;
    const rowH = Math.min(14, (subH - 14) / Math.max(1, slots.length));
    const barMaxW = Math.max(24, innerW - 68);

    slots.forEach((s, sIdx) => {
      const val = Math.max(0, Math.min(100, Number(s.axes && s.axes[axisName]) || 0));
      const ry = listTop + sIdx * rowH;
      doc.text(shortModelLabel(s.label), ax + 4, ry + 1, {
        font: 'F1',
        size: 6.8,
        color: COLORS.textBody,
        maxWidth: 38,
      });
      doc.rect(ax + 44, ry + 1.5, barMaxW, rowH * 0.58, {
        fill: COLORS.cardAltBg,
        stroke: COLORS.divider,
        lineWidth: 0.3,
      });
      const bw = Math.max(1.5, (val / 100) * barMaxW);
      doc.rect(ax + 44, ry + 1.5, bw, rowH * 0.58, { fill: s.colorRgb });
      doc.text(`${val}`, ax + 44 + barMaxW + 3, ry + 1, {
        font: val === 100 ? 'F2' : 'F1',
        size: 6.8,
        color: val === 100 ? COLORS.goodText : COLORS.textMuted,
      });
    });

    if (aIdx < axes.length - 1) {
      doc.line(ax + colW - 3, topY, ax + colW - 3, y + h - 6, { stroke: COLORS.divider, lineWidth: 0.5 });
    }
  });
}

function renderComparisonCharts(doc, r) {
  const slots = r.validScored.length ? r.validScored : r.slots;
  if (!slots.length) return;

  const n = slots.length;
  const chartPanelH = Math.max(74, 34 + n * 16);
  const tokenPanelH = Math.max(68, 30 + n * 15);
  const axisPanelH = Math.max(66, 36 + n * 13);

  doc.ensureSpace(34 + chartPanelH * 2 + 16);
  doc.drawSectionHeader(
    2,
    'Visual Comparison Graphs',
    'Normalized balanced score, cost per task, wall-clock latency, throughput & token distribution'
  );

  const gap = 10;
  const halfW = (CONTENT_W - gap) / 2;

  const bestOverall = Math.max(...slots.map((s) => s.overall || 0));
  const bestCost = Math.min(...slots.map((s) => s.costUsd));
  const bestWall = Math.min(...slots.map((s) => s.wallMs));
  const bestTps = Math.max(...slots.map((s) => s.tokensPerSec || 0));

  // Row 1: Overall Balanced Score + Cost per Task
  doc.ensureSpace(chartPanelH + 8);
  const row1Y = doc.cursorY;
  drawHorizontalBarChartPanel(doc, M_LEFT, row1Y, halfW, chartPanelH, {
    title: 'Overall Balanced Score',
    subtitle: '0-100 scale · higher is better',
    maxValue: 100,
    items: slots.map((s) => ({
      slot: s.slot,
      label: s.label,
      colorRgb: s.colorRgb,
      value: s.overall,
      valueLabel: `${s.overall}/100`,
      isBest: s.overall === bestOverall && bestOverall > 0,
    })),
  });

  drawHorizontalBarChartPanel(doc, M_LEFT + halfW + gap, row1Y, halfW, chartPanelH, {
    title: 'Cost per Task (USD)',
    subtitle: 'lower is better',
    maxValue: Math.max(...slots.map((s) => s.costUsd), 1e-6),
    items: slots.map((s) => ({
      slot: s.slot,
      label: s.label,
      colorRgb: s.colorRgb,
      value: s.costUsd,
      valueLabel: `${fmtCost(s.costUsd)}`,
      isBest: s.costUsd === bestCost,
    })),
  });
  doc.cursorY = row1Y + chartPanelH + 8;

  // Row 2: Wall Time / Latency + Throughput (Tokens / sec)
  doc.ensureSpace(chartPanelH + 8);
  const row2Y = doc.cursorY;
  drawHorizontalBarChartPanel(doc, M_LEFT, row2Y, halfW, chartPanelH, {
    title: 'Wall Time / Latency',
    subtitle: 'seconds · lower is better',
    maxValue: Math.max(...slots.map((s) => s.wallMs / 1000), 0.1),
    items: slots.map((s) => ({
      slot: s.slot,
      label: s.label,
      colorRgb: s.colorRgb,
      value: s.wallMs / 1000,
      valueLabel: fmtSec(s.wallMs),
      isBest: s.wallMs === bestWall,
    })),
  });

  drawHorizontalBarChartPanel(doc, M_LEFT + halfW + gap, row2Y, halfW, chartPanelH, {
    title: 'Throughput (Tokens / sec)',
    subtitle: 'tok/s · higher is better',
    maxValue: Math.max(...slots.map((s) => s.tokensPerSec || 0), 1),
    items: slots.map((s) => ({
      slot: s.slot,
      label: s.label,
      colorRgb: s.colorRgb,
      value: s.tokensPerSec || 0,
      valueLabel: `${fmtInt(Math.round(s.tokensPerSec || 0))} tok/s`,
      isBest: s.tokensPerSec === bestTps && bestTps > 0,
    })),
  });
  doc.cursorY = row2Y + chartPanelH + 8;

  // Optional Row 2B (for graded tasks): Correctness (%) chart + Cost per 1,000 tasks chart
  if (!r.isCustom) {
    const bestCorr = Math.max(...slots.map((s) => s.correctness ?? 0));
    doc.ensureSpace(chartPanelH + 8);
    const rowCorrY = doc.cursorY;
    drawHorizontalBarChartPanel(doc, M_LEFT, rowCorrY, halfW, chartPanelH, {
      title: 'Correctness (Hidden Tests Passed)',
      subtitle: '% passed · higher is better',
      maxValue: 100,
      items: slots.map((s) => ({
        slot: s.slot,
        label: s.label,
        colorRgb: s.colorRgb,
        value: s.correctness ?? 0,
        valueLabel: `${s.correctness ?? 0}% (${s.passed}/${s.total})`,
        isBest: (s.correctness ?? 0) === bestCorr && bestCorr > 0,
      })),
    });
    drawHorizontalBarChartPanel(doc, M_LEFT + halfW + gap, rowCorrY, halfW, chartPanelH, {
      title: 'Projected Cost per 1,000 Tasks',
      subtitle: 'USD / 1k runs · lower is better',
      maxValue: Math.max(...slots.map((s) => s.costUsd * 1000), 1e-3),
      items: slots.map((s) => ({
        slot: s.slot,
        label: s.label,
        colorRgb: s.colorRgb,
        value: s.costUsd * 1000,
        valueLabel: fmtCost(s.costUsd * 1000),
        isBest: s.costUsd === bestCost,
      })),
    });
    doc.cursorY = rowCorrY + chartPanelH + 8;
  }

  // Row 3: Stacked Token Usage Breakdown
  doc.ensureSpace(tokenPanelH + 8);
  const row3Y = doc.cursorY;
  drawTokenBreakdownChart(doc, M_LEFT, row3Y, CONTENT_W, tokenPanelH, slots);
  doc.cursorY = row3Y + tokenPanelH + 8;

  // Row 4: Multi-Axis Efficiency Profile
  doc.ensureSpace(axisPanelH + 10);
  const row4Y = doc.cursorY;
  drawMultiAxisEfficiencyChart(doc, M_LEFT, row4Y, CONTENT_W, axisPanelH, slots, r.isCustom);
  doc.cursorY = row4Y + axisPanelH + 12;
}

// ---------------------------------------------------------------------------
// Section 3: Full Metrics Comparison Table & Blind LLM-as-Judge Evaluation
// ---------------------------------------------------------------------------
function renderMetricsTableAndJudge(doc, r) {
  const slots = r.slots;
  const tableH = 24 + slots.length * 20 + 18;
  doc.ensureSpace(34 + tableH);
  doc.drawSectionHeader(
    3,
    'Full Metrics Table & Evaluation',
    'Complete side-by-side telemetry measured live from provider APIs'
  );

  const valid = r.validScored;
  const bestCost = valid.length ? Math.min(...valid.map((s) => s.costUsd)) : null;
  const bestWall = valid.length ? Math.min(...valid.map((s) => s.wallMs)) : null;
  const bestTps = valid.length ? Math.max(...valid.map((s) => s.tokensPerSec)) : null;
  const bestCorr = (!r.isCustom && valid.length) ? Math.max(...valid.map((s) => s.correctness ?? -1)) : null;
  const bestOverall = valid.length ? Math.max(...valid.map((s) => s.overall)) : null;

  // Column widths (total = 540pt)
  const cols = [
    { label: 'Model', w: 128, align: 'left' },
    { label: 'Thinking', w: 58, align: 'left' },
    { label: 'Correctness', w: 56, align: 'right' },
    { label: 'Wall Time', w: 48, align: 'right' },
    { label: 'Tokens (In / Out / Thk)', w: 102, align: 'right' },
    { label: 'Tok/s', w: 40, align: 'right' },
    { label: 'Cost / Task', w: 54, align: 'right' },
    { label: 'Cost / 1k', w: 54, align: 'right' },
  ];

  const ty = doc.cursorY;
  const headH = 19;
  doc.rect(M_LEFT, ty, CONTENT_W, headH, { fill: COLORS.bannerSubBg });

  let cx = M_LEFT;
  cols.forEach((c) => {
    const tx = c.align === 'right' ? cx + c.w - 6 : cx + 6;
    doc.text(c.label, tx, ty + 5.5, {
      font: 'F2',
      size: 7.4,
      color: COLORS.textWhite,
      align: c.align,
      maxWidth: c.w - 10,
    });
    cx += c.w;
  });

  let rowY = ty + headH;
  const rowH = 20;

  slots.forEach((s, idx) => {
    const bg = idx % 2 === 0 ? [1, 1, 1] : COLORS.cardBg;
    doc.rect(M_LEFT, rowY, CONTENT_W, rowH, { fill: bg, stroke: COLORS.divider, lineWidth: 0.4 });
    doc.rect(M_LEFT, rowY, 3.5, rowH, { fill: s.colorRgb });

    let rx = M_LEFT;
    // Col 0: Model + provider
    doc.text(`[${s.slot}] ${s.label}`, rx + 7, rowY + 3.5, {
      font: 'F2',
      size: 7.8,
      color: COLORS.textDark,
      maxWidth: cols[0].w - 12,
    });
    doc.text(`${s.provider} · ${s.model}`, rx + 7, rowY + 12, {
      font: 'F1',
      size: 6.3,
      color: COLORS.textFaint,
      maxWidth: cols[0].w - 12,
    });
    rx += cols[0].w;

    // Col 1: Thinking
    doc.text((s.thinking && s.thinking.label) || 'Default', rx + 6, rowY + 6.5, {
      font: 'F1',
      size: 7.4,
      color: COLORS.textMuted,
      maxWidth: cols[1].w - 10,
    });
    rx += cols[1].w;

    if (s.error) {
      doc.text(`ERROR: ${s.error}`, rx + 6, rowY + 6.5, {
        font: 'F2',
        size: 7.4,
        color: COLORS.errText,
        maxWidth: CONTENT_W - cols[0].w - cols[1].w - 12,
      });
      rowY += rowH;
      return;
    }

    // Col 2: Correctness
    const isBestCorr = !r.isCustom && bestCorr != null && s.correctness === bestCorr && bestCorr > 0;
    const corrStr = r.isCustom || s.correctness == null ? '—' : `${s.correctness}% (${s.passed}/${s.total})`;
    doc.text(corrStr, rx + cols[2].w - 6, rowY + 6.5, {
      font: isBestCorr ? 'F2' : 'F1',
      size: 7.4,
      color: isBestCorr ? COLORS.goodText : COLORS.textBody,
      align: 'right',
    });
    rx += cols[2].w;

    // Col 3: Wall Time
    const isBestWall = bestWall != null && s.wallMs === bestWall;
    doc.text(fmtSec(s.wallMs), rx + cols[3].w - 6, rowY + 6.5, {
      font: isBestWall ? 'F2' : 'F1',
      size: 7.4,
      color: isBestWall ? COLORS.goodText : COLORS.textBody,
      align: 'right',
    });
    rx += cols[3].w;

    // Col 4: Tokens (In / Out / Think)
    const tokStr = `${fmtInt(s.promptTokens)} / ${fmtInt(s.answerTokens)} / ${fmtInt(s.reasoningTokens)}`;
    doc.text(tokStr, rx + cols[4].w - 6, rowY + 6.5, {
      font: 'F1',
      size: 7.2,
      color: COLORS.textBody,
      align: 'right',
    });
    rx += cols[4].w;

    // Col 5: Tok/s
    const isBestTps = bestTps != null && s.tokensPerSec === bestTps && bestTps > 0;
    doc.text(String(s.tokensPerSec), rx + cols[5].w - 6, rowY + 6.5, {
      font: isBestTps ? 'F2' : 'F1',
      size: 7.4,
      color: isBestTps ? COLORS.goodText : COLORS.textBody,
      align: 'right',
    });
    rx += cols[5].w;

    // Col 6: Cost / Task
    const isBestCost = bestCost != null && s.costUsd === bestCost;
    doc.text(fmtCost(s.costUsd), rx + cols[6].w - 6, rowY + 6.5, {
      font: isBestCost ? 'F2' : 'F1',
      size: 7.4,
      color: isBestCost ? COLORS.goodText : COLORS.textBody,
      align: 'right',
    });
    rx += cols[6].w;

    // Col 7: Cost / 1k
    doc.text(fmtCost(s.costUsd * 1000), rx + cols[7].w - 6, rowY + 6.5, {
      font: isBestCost ? 'F2' : 'F1',
      size: 7.4,
      color: isBestCost ? COLORS.goodText : COLORS.textBody,
      align: 'right',
    });

    rowY += rowH;
  });

  doc.text(
    'Note: Best values in each metric column are highlighted in bold green. Token counts show Input / Answer Output / Thinking tokens.',
    M_LEFT,
    rowY + 5,
    { font: 'F3', size: 7.2, color: COLORS.textFaint }
  );
  doc.cursorY = rowY + 18;

  // Optional Blind LLM-as-Judge Evaluation Table
  if (r.judge && Array.isArray(r.judge.results) && r.judge.results.length) {
    const j = r.judge;
    const jRanked = j.results.slice().sort((a, b) => (b.overall || 0) - (a.overall || 0));
    const criteria = Array.isArray(j.criteria) && j.criteria.length
      ? j.criteria
      : [
          { key: 'completeness', label: 'Completeness' },
          { key: 'accuracy', label: 'Accuracy' },
          { key: 'structure', label: 'Structure' },
          { key: 'actionability', label: 'Actionability' },
        ];

    const estJudgeH = 44 + jRanked.length * 22 + (j.why ? 32 : 10);
    doc.ensureSpace(estJudgeH);

    const jy = doc.cursorY;
    doc.rect(M_LEFT, jy, CONTENT_W, 20, { fill: COLORS.bannerSubBg });
    const judgeModelStr = j.judge ? `${j.judge.label} (${j.judge.model})` : 'Judge Model';
    const blindOrderStr = Array.isArray(j.blindOrder) ? j.blindOrder.join(' · ') : '';
    doc.text(`BLIND LLM-AS-JUDGE EVALUATION · Judged by ${judgeModelStr}`, M_LEFT + 8, jy + 6, {
      font: 'F2',
      size: 8,
      color: COLORS.textWhite,
      maxWidth: CONTENT_W * 0.65,
    });
    if (blindOrderStr) {
      doc.text(`Shuffled blind order: ${blindOrderStr}`, PAGE_W - M_RIGHT - 8, jy + 6, {
        font: 'F1',
        size: 7,
        color: COLORS.textBannerSub,
        align: 'right',
        maxWidth: CONTENT_W * 0.33,
      });
    }

    let jCurY = jy + 20;
    const critW = 46;
    const modelW = 118;
    const overallW = 48;
    const noteW = CONTENT_W - modelW - overallW - criteria.length * critW;

    // Subheader row
    doc.rect(M_LEFT, jCurY, CONTENT_W, 16, { fill: COLORS.cardAltBg, stroke: COLORS.cardBorder, lineWidth: 0.5 });
    let jx = M_LEFT;
    doc.text('Model (Blind ID)', jx + 6, jCurY + 4, { font: 'F2', size: 7.2, color: COLORS.textDark });
    jx += modelW;
    doc.text('Overall', jx + overallW / 2, jCurY + 4, { font: 'F2', size: 7.2, color: COLORS.textDark, align: 'center' });
    jx += overallW;
    criteria.forEach((c) => {
      doc.text(c.label, jx + critW / 2, jCurY + 4, { font: 'F2', size: 7, color: COLORS.textDark, align: 'center', maxWidth: critW - 4 });
      jx += critW;
    });
    doc.text("Judge's Note", jx + 6, jCurY + 4, { font: 'F2', size: 7.2, color: COLORS.textDark });
    jCurY += 16;

    jRanked.forEach((res, idx) => {
      const isWin = res.slot === j.winnerSlot;
      const noteLines = wrapText(res.note || '—', noteW - 12, 7.2).slice(0, 2);
      const rH = Math.max(20, 8 + noteLines.length * 9.5);
      doc.rect(M_LEFT, jCurY, CONTENT_W, rH, {
        fill: isWin ? COLORS.goodBg : (idx % 2 === 0 ? [1, 1, 1] : COLORS.cardBg),
        stroke: isWin ? COLORS.goodBorder : COLORS.divider,
        lineWidth: 0.5,
      });

      let rx = M_LEFT;
      const winTag = isWin ? ' [PICK]' : '';
      doc.text(`${res.label}${winTag}`, rx + 6, jCurY + 4, {
        font: 'F2',
        size: 7.5,
        color: isWin ? COLORS.goodText : COLORS.textDark,
        maxWidth: modelW - 10,
      });
      doc.text(`Seen as Response ${res.blindId || '?'}`, rx + 6, jCurY + 12.5, {
        font: 'F1',
        size: 6.4,
        color: COLORS.textFaint,
      });
      rx += modelW;

      doc.text(`${res.overall ?? '—'}/10`, rx + overallW / 2, jCurY + 6, {
        font: 'F2',
        size: 8.2,
        color: isWin ? COLORS.goodText : COLORS.textDark,
        align: 'center',
      });
      rx += overallW;

      criteria.forEach((c) => {
        const v = res.scores && res.scores[c.key];
        doc.text(v == null ? '—' : `${v}/10`, rx + critW / 2, jCurY + 6, {
          font: 'F1',
          size: 7.5,
          color: COLORS.textBody,
          align: 'center',
        });
        rx += critW;
      });

      noteLines.forEach((nl, nIdx) => {
        doc.text(nl, rx + 6, jCurY + 4.5 + nIdx * 9.5, {
          font: 'F1',
          size: 7.2,
          color: COLORS.textBody,
        });
      });

      jCurY += rH;
    });

    if (j.why) {
      const whyLines = wrapText(`Judge Rationale: ${j.why}`, CONTENT_W - 16, 7.6).slice(0, 3);
      const whyH = 8 + whyLines.length * 10;
      doc.rect(M_LEFT, jCurY, CONTENT_W, whyH, { fill: COLORS.cardBg, stroke: COLORS.cardBorder, lineWidth: 0.5 });
      whyLines.forEach((wl, wIdx) => {
        doc.text(wl, M_LEFT + 8, jCurY + 4 + wIdx * 10, {
          font: wIdx === 0 ? 'F2' : 'F1',
          size: 7.5,
          color: COLORS.textBody,
        });
      });
      jCurY += whyH;
    }

    doc.cursorY = jCurY + 12;
  }
}

// ---------------------------------------------------------------------------
// Section 4: Detailed Per-Model Results (Metadata, Reasoning, Full Output)
// ---------------------------------------------------------------------------
const MAX_OUTPUT_CHARS = 120000;
const MAX_REASONING_CHARS = 40000;

function parseResponseLinesForPdf(text, isCoding) {
  const safeText = String(text || '').slice(0, MAX_OUTPUT_CHARS);
  const truncated = String(text || '').length > MAX_OUTPUT_CHARS;

  if (isCoding) {
    const codeLines = safeText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const items = [];
    codeLines.forEach((rawLine, idx) => {
      const lineNum = String(idx + 1).padStart(3, ' ') + ' | ';
      const wrapped = wrapText(rawLine, CONTENT_W - 56, 7.8, { isMono: true });
      wrapped.forEach((wl, wIdx) => {
        items.push({
          kind: 'code',
          text: (wIdx === 0 ? lineNum : '    | ') + wl,
          font: 'F4',
          size: 7.8,
          lineH: 10.2,
          color: COLORS.textDark,
        });
      });
    });
    if (truncated) {
      items.push({
        kind: 'note',
        text: `... [Output truncated at ${fmtInt(MAX_OUTPUT_CHARS)} characters in PDF export] ...`,
        font: 'F3',
        size: 8,
        lineH: 12,
        color: COLORS.textMuted,
      });
    }
    return items;
  }

  // Prose / Markdown-aware formatting for general & custom tasks
  const rawLines = safeText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const items = [];
  let inCodeFence = false;

  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) {
      const wrapped = wrapText(rawLine, CONTENT_W - 28, 7.8, { isMono: true });
      for (const wl of wrapped) {
        items.push({
          kind: 'code_block',
          text: '  ' + wl,
          font: 'F4',
          size: 7.8,
          lineH: 10.2,
          color: COLORS.textDark,
        });
      }
      continue;
    }

    if (!trimmed) {
      items.push({ kind: 'blank', text: '', font: 'F1', size: 8.5, lineH: 6, color: COLORS.textBody });
      continue;
    }

    // Markdown headings
    const hMatch = rawLine.match(/^\s*(#{1,4})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      const cleanHeading = hMatch[2].replace(/\*\*(.*?)\*\*/g, '$1').trim();
      const hSize = level === 1 ? 10.8 : (level === 2 ? 9.8 : 9.0);
      const wrapped = wrapText(cleanHeading, CONTENT_W - 24, hSize, { isBold: true });
      items.push({ kind: 'spacer', text: '', font: 'F2', size: 4, lineH: 4, color: COLORS.textDark });
      for (const wl of wrapped) {
        items.push({
          kind: 'heading',
          text: wl,
          font: 'F2',
          size: hSize,
          lineH: hSize + 3.5,
          color: COLORS.textDark,
        });
      }
      continue;
    }

    // Markdown table rows
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const wrapped = wrapText(trimmed, CONTENT_W - 24, 7.4, { isMono: true });
      for (const wl of wrapped) {
        items.push({
          kind: 'table',
          text: wl,
          font: 'F4',
          size: 7.4,
          lineH: 9.8,
          color: COLORS.textBody,
        });
      }
      continue;
    }

    // Bullet / numbered lists
    const listMatch = rawLine.match(/^(\s*)([-*•]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const depth = Math.min(3, Math.floor((listMatch[1] || '').length / 2));
      const prefix = '  '.repeat(depth) + (/\d+\./.test(listMatch[2]) ? `${listMatch[2]} ` : '• ');
      const cleanItem = listMatch[3].replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
      const wrapped = wrapText(prefix + cleanItem, CONTENT_W - 24, 8.6);
      wrapped.forEach((wl, idx) => {
        items.push({
          kind: 'list',
          text: idx === 0 ? wl : '  '.repeat(depth + 1) + wl,
          font: 'F1',
          size: 8.6,
          lineH: 11.4,
          color: COLORS.textBody,
        });
      });
      continue;
    }

    // Regular paragraph line (strip inline markdown bold/code markers for clean reading)
    const cleanPara = rawLine.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    const wrapped = wrapText(cleanPara, CONTENT_W - 24, 8.6);
    for (const wl of wrapped) {
      items.push({
        kind: 'para',
        text: wl,
        font: 'F1',
        size: 8.6,
        lineH: 11.4,
        color: COLORS.textBody,
      });
    }
  }

  if (truncated) {
    items.push({
      kind: 'note',
      text: `... [Output truncated at ${fmtInt(MAX_OUTPUT_CHARS)} characters in PDF export] ...`,
      font: 'F3',
      size: 8,
      lineH: 12,
      color: COLORS.textMuted,
    });
  }

  return items.length ? items : [{ kind: 'note', text: '(No response text returned)', font: 'F3', size: 8.5, lineH: 12, color: COLORS.textFaint }];
}

function renderPaginatedBoxBlock(doc, {
  title,
  contTitle,
  headerBg,
  headerTextColor,
  boxBg,
  boxBorder,
  accentRgb,
  lines, // [{ text, font, size, lineH, color, kind }]
}) {
  const padTop = 6;
  const padBottom = 6;
  const headerH = 17;
  let idx = 0;
  let isFirstChunk = true;

  while (idx < lines.length) {
    const minNeeded = headerH + padTop + (lines[idx].lineH || 11) + padBottom + 4;
    doc.ensureSpace(minNeeded);

    const startY = doc.cursorY;
    const availH = (PAGE_H - M_BOTTOM) - startY - headerH - padTop - padBottom;

    // Collect as many lines as fit on the current page
    const chunk = [];
    let usedH = 0;
    while (idx < lines.length) {
      const lh = lines[idx].lineH || 11;
      if (chunk.length > 0 && usedH + lh > availH) break;
      chunk.push(lines[idx]);
      usedH += lh;
      idx++;
    }

    const totalBoxH = headerH + padTop + usedH + padBottom;
    doc.rect(M_LEFT, startY, CONTENT_W, totalBoxH, { fill: boxBg, stroke: boxBorder, lineWidth: 0.65 });
    doc.rect(M_LEFT, startY, CONTENT_W, headerH, { fill: headerBg });
    if (accentRgb) {
      doc.rect(M_LEFT, startY, 3.5, totalBoxH, { fill: accentRgb });
    }
    doc.text(isFirstChunk ? title : contTitle, M_LEFT + 9, startY + 4.5, {
      font: 'F2',
      size: 7.8,
      color: headerTextColor,
      maxWidth: CONTENT_W - 18,
    });

    let lineY = startY + headerH + padTop;
    for (const ln of chunk) {
      if (ln.kind === 'code_block') {
        doc.rect(M_LEFT + 6, lineY - 1, CONTENT_W - 12, ln.lineH, { fill: COLORS.cardAltBg });
      }
      if (ln.text) {
        doc.text(ln.text, M_LEFT + 10, lineY, {
          font: ln.font || 'F1',
          size: ln.size || 8.5,
          color: ln.color || COLORS.textBody,
        });
      }
      lineY += ln.lineH || 11;
    }

    doc.cursorY = startY + totalBoxH + 8;
    isFirstChunk = false;
  }
}

function renderDetailedModelResults(doc, r) {
  doc.ensureSpace(110);
  doc.drawSectionHeader(
    4,
    'Detailed Per-Model Results',
    'Individual model telemetry, reasoning traces & complete generated outputs'
  );

  const isCoding = !!r.language;

  r.slots.forEach((s, idx) => {
    // Keep model header + first part of body together
    doc.ensureSpace(115);
    const hy = doc.cursorY;
    const headH = 44;

    doc.rect(M_LEFT, hy, CONTENT_W, headH, {
      fill: COLORS.cardBg,
      stroke: s.colorRgb,
      lineWidth: 0.9,
    });
    doc.rect(M_LEFT, hy, 5, headH, { fill: s.colorRgb });

    // Slot badge
    doc.rect(M_LEFT + 11, hy + 7, 42, 14, { fill: s.colorRgb });
    doc.text(`SLOT ${s.slot}`, M_LEFT + 32, hy + 10, {
      font: 'F2',
      size: 7.5,
      color: COLORS.textWhite,
      align: 'center',
    });

    // Model Label + Provider/ID
    doc.text(s.label, M_LEFT + 59, hy + 7.5, {
      font: 'F2',
      size: 10.5,
      color: COLORS.textDark,
      maxWidth: 240,
    });

    const statusText = s.error
      ? 'ERROR'
      : (s.total > 0
          ? (s.solved ? `SOLVED 100% (${s.passed}/${s.total})` : `FINISHED ${s.correctness}% (${s.passed}/${s.total})`)
          : `COMPLETED · ${fmtSec(s.wallMs)} · Balanced ${s.overall}/100`);
    const statusColor = s.error
      ? COLORS.errText
      : (s.total > 0 && !s.solved ? COLORS.warnText : COLORS.goodText);

    doc.text(statusText, PAGE_W - M_RIGHT - 10, hy + 8.5, {
      font: 'F2',
      size: 8.2,
      color: statusColor,
      align: 'right',
    });

    const metaLine1 = `Provider: ${s.provider} · Model ID: ${s.model} · Thinking Mode: ${(s.thinking && s.thinking.label) || 'Default'}${s.thinking && s.thinking.detail ? ' (' + s.thinking.detail + ')' : ''}`;
    doc.text(metaLine1, M_LEFT + 11, hy + 24, {
      font: 'F1',
      size: 7.4,
      color: COLORS.textMuted,
      maxWidth: CONTENT_W - 22,
    });

    const metaLine2 = s.error
      ? `Error: ${s.error}`
      : `Wall Time: ${fmtSec(s.wallMs)} · Speed: ${s.tokensPerSec} tok/s · Tokens: In ${fmtInt(s.promptTokens)} / Out ${fmtInt(s.answerTokens)} / Think ${fmtInt(s.reasoningTokens)} (Total ${fmtInt(s.totalTokens)}) · Cost: ${fmtCost(s.costUsd)} (${fmtCost(s.costUsd * 1000)}/1k)`;
    doc.text(metaLine2, M_LEFT + 11, hy + 34, {
      font: 'F2',
      size: 7.3,
      color: s.error ? COLORS.errText : COLORS.textBody,
      maxWidth: CONTENT_W - 22,
    });

    doc.cursorY = hy + headH + 6;

    // Context Warning or Attachment Notes if present
    const notes = [];
    if (s.contextWarning) notes.push(`[!] Context Warning: ${s.contextWarning}`);
    if (Array.isArray(s.attachmentNotes) && s.attachmentNotes.length) {
      s.attachmentNotes.forEach((n) => notes.push(`[i] Attachment Note: ${n}`));
    }
    if (notes.length) {
      const noteLines = [];
      notes.forEach((n) => noteLines.push(...wrapText(n, CONTENT_W - 20, 7.5)));
      const nh = 8 + noteLines.length * 10;
      doc.ensureSpace(nh + 6);
      const ny = doc.cursorY;
      doc.rect(M_LEFT, ny, CONTENT_W, nh, { fill: COLORS.warnBg, stroke: COLORS.warnBorder, lineWidth: 0.6 });
      noteLines.forEach((nl, nIdx) => {
        doc.text(nl, M_LEFT + 8, ny + 4 + nIdx * 10, { font: 'F1', size: 7.5, color: COLORS.warnText });
      });
      doc.cursorY = ny + nh + 6;
    }

    // Execution / Test Output if present
    if (s.execOut) {
      const execLinesRaw = wrapText(s.execOut.slice(0, 6000), CONTENT_W - 24, 7.6, { isMono: true });
      const execItems = execLinesRaw.map((l) => ({
        kind: 'code',
        text: l,
        font: 'F4',
        size: 7.6,
        lineH: 9.8,
        color: COLORS.textDark,
      }));
      renderPaginatedBoxBlock(doc, {
        title: `Execution / Verification Output — ${s.label} (Slot ${s.slot})`,
        contTitle: `Execution Output — ${s.label} (continued)`,
        headerBg: COLORS.goodBg,
        headerTextColor: COLORS.goodText,
        boxBg: COLORS.cardBg,
        boxBorder: COLORS.goodBorder,
        accentRgb: COLORS.goodText,
        lines: execItems,
      });
    }

    // Reasoning / Thinking Trace
    if (s.reasoning && s.reasoning.trim()) {
      const rText = s.reasoning.trim().slice(0, MAX_REASONING_CHARS);
      const rTrunc = s.reasoning.trim().length > MAX_REASONING_CHARS;
      const rWrapped = wrapText(rText, CONTENT_W - 24, 7.8);
      const rItems = rWrapped.map((l) => ({
        kind: 'think',
        text: l,
        font: 'F3',
        size: 7.8,
        lineH: 10.2,
        color: COLORS.textBody,
      }));
      if (rTrunc) {
        rItems.push({
          kind: 'note',
          text: `... [Reasoning trace truncated at ${fmtInt(MAX_REASONING_CHARS)} chars] ...`,
          font: 'F3',
          size: 7.5,
          lineH: 10,
          color: COLORS.textMuted,
        });
      }
      renderPaginatedBoxBlock(doc, {
        title: `Thinking / Reasoning Trace — ${s.label} (${fmtInt(s.reasoningTokens)} thinking tokens)`,
        contTitle: `Thinking / Reasoning Trace — ${s.label} (continued)`,
        headerBg: COLORS.thinkBorder,
        headerTextColor: COLORS.thinkTitle,
        boxBg: COLORS.thinkBg,
        boxBorder: COLORS.thinkBorder,
        accentRgb: COLORS.tokThink,
        lines: rItems,
      });
    } else if (s.reasoningTokens > 0) {
      doc.ensureSpace(24);
      const ty = doc.cursorY;
      doc.rect(M_LEFT, ty, CONTENT_W, 18, { fill: COLORS.thinkBg, stroke: COLORS.thinkBorder, lineWidth: 0.5 });
      doc.text(
        `Thinking / Reasoning: ${fmtInt(s.reasoningTokens)} reasoning tokens billed (provider did not stream raw thought text).`,
        M_LEFT + 8,
        ty + 5,
        { font: 'F3', size: 7.6, color: COLORS.thinkTitle }
      );
      doc.cursorY = ty + 24;
    }

    // Full Model Response / Generated Code
    if (s.error) {
      const errLines = wrapText(`Model Error: ${s.error}`, CONTENT_W - 24, 8.5).map((l) => ({
        kind: 'err',
        text: l,
        font: 'F2',
        size: 8.5,
        lineH: 11.5,
        color: COLORS.errText,
      }));
      renderPaginatedBoxBlock(doc, {
        title: `Model Output — ${s.label} (Slot ${s.slot}) — FAILED`,
        contTitle: `Model Output — ${s.label} (continued)`,
        headerBg: COLORS.errBg,
        headerTextColor: COLORS.errText,
        boxBg: COLORS.errBg,
        boxBorder: COLORS.errBorder,
        accentRgb: COLORS.errText,
        lines: errLines,
      });
    } else {
      const outItems = parseResponseLinesForPdf(s.code, isCoding);
      const outKindLabel = isCoding ? `Generated Code (${r.language})` : 'Model Response';
      renderPaginatedBoxBlock(doc, {
        title: `${outKindLabel} — ${s.label} (Slot ${s.slot}) · ${fmtInt(s.answerTokens)} answer tokens · ${fmtInt((s.code || '').length)} chars`,
        contTitle: `${outKindLabel} — ${s.label} (Slot ${s.slot}) — continued`,
        headerBg: COLORS.codeHeaderBg,
        headerTextColor: COLORS.textDark,
        boxBg: isCoding ? COLORS.codeBg : [1, 1, 1],
        boxBorder: COLORS.codeBorder,
        accentRgb: s.colorRgb,
        lines: outItems,
      });
    }

    if (idx < r.slots.length - 1) {
      doc.cursorY += 6;
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function buildComparisonPdf(payload = {}) {
  const report = computeReportData(payload);
  const doc = new PdfDocumentBuilder(report);

  doc.addPage({ isFirstPage: true });
  renderExecutiveSummary(doc, report);
  renderComparisonCharts(doc, report);
  renderMetricsTableAndJudge(doc, report);
  renderDetailedModelResults(doc, report);

  return doc.toBuffer();
}

module.exports = {
  buildComparisonPdf,
  computeReportData,
  pdfFilename,
  toWinAnsi,
};
