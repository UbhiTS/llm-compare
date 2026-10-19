// ---------------------------------------------------------------------------
// src/cadArena.js - 3D & CAD Arena prompt contract, multi-turn vision-guided
// modification builder, Fusion 360 Python transpiler, and headless CAD MCP bridge.
// ---------------------------------------------------------------------------

const CAD_SYSTEM_PROMPT =
  'You are an expert 3D CAD, Parametric Mechanical Engineering, and Three.js Solid Modeling engineer. ' +
  'You write clean, self-contained, parametric JavaScript 3D CAD modules that build watertight, ' +
  'dimensionally accurate 3D assemblies in millimeters (Y-up coordinate system, Y=0 ground plane). ' +
  'Output ONLY a single fenced ```javascript code block with NO prose, explanation, or markdown ' +
  'outside the code block. When modifying an existing 3D model, carefully inspect both the attached ' +
  '4-angle viewport render (ISOMETRIC, FRONT, TOP, RIGHT) and the previous code/telemetry to fix ' +
  'any orientation, alignment, or floating-part issues while applying the requested changes.';

const CAD_CONTRACT_INSTRUCTIONS = `

=== 3D & CAD ARENA RUNTIME CONTRACT (MANDATORY) ===
Return ONLY a single fenced \`\`\`javascript code block defining:
1. \`const PARAMS = { ... }\` - flat numeric, boolean, or hex-color parameters (in millimeters / degrees / counts) so the viewport auto-generates live interactive CAD sliders.
2. \`function buildModel(THREE, params, CAD)\` - returns a \`THREE.Group\` (or \`THREE.Object3D\`) in **millimeters** with **Y-up** (\`Y = 0\` is the horizontal XZ ground plane; \`+Y\` points up, \`+X\` right, \`+Z\` front). The argument order is exactly \`(THREE, params, CAD)\`: \`params\` is the live \`PARAMS\` object (slider values), \`CAD\` is the solid-modeling kernel described below.
   - Assign a descriptive \`.name\` to every logical sub-part (\`mesh.name = 'spur_gear_base'\`, \`hub.name = 'central_drive_hub'\`, etc.) so users can click-to-inspect and target individual parts for modification.
   - Ensure all connected parts physically touch or mating-fit with zero unintended floating gaps.
   - IMPORTANT: Every \`CAD.*\` builder below returns a ready-to-add \`THREE.Mesh\` (or \`THREE.Group\`), NOT a raw \`BufferGeometry\`. Add returned \`CAD.*\` parts directly via \`group.add(part)\` (and always pass \`material: CAD.materials.*()\` inside the options object).

Built-in \`CAD\` & \`CSG\` Solid Modeling Helpers available on \`CAD\` (in addition to full \`THREE.*\` r186):
- \`CAD.spurGear({ teeth = 36, module = 2.5, thickness = 12, pressureAngle = 20, boreDiameter = 16, hubDiameter = 0, hubHeight = 0, lighteningHoles = 0, material, name })\`
  -> Watertight involute spur gear \`THREE.Mesh\` lying flat on XZ (\`Y = 0 .. thickness\`). Pitch diameter = \`teeth * module\`.
- \`CAD.internalGear({ teeth = 48, module = 2.5, thickness = 16, rimThickness = 8, material, name })\`
  -> Watertight internal-tooth ring gear \`THREE.Mesh\` (\`Y = 0 .. thickness\`).
- \`CAD.helicalThread({ diameter = 20, pitch = 2.0, length = 14, internal = false, includeCore = true, material, name })\`
  -> Metric ISO V-thread \`THREE.Group\` along Y (\`Y = 0 .. length\`). Use \`internal: true\` for threaded bores or \`internal: false\` for external threaded bosses/bolts.
- \`CAD.revolveHollow({ points, wallThickness = 3.0, segments = 64, spline = true, openTop = true, material, name })\`
  -> Takes 2D profile points \`[[radiusMm, yMm], ...]\` from bottom to top, offsets an inner shell wall by \`wallThickness\`, closes the bottom floor and rounded top lip, and revolves a **watertight hollow 3D solid** (ideal for vessels, housings, nozzles, impellers).
- \`CAD.revolveProfile({ points, segments = 64, spline = false, phiLength = Math.PI * 2, material, name })\`
  -> Revolves a closed 2D \`[[r, y], ...]\` profile around the Y axis.
- \`CAD.extrudeWithHoles({ outerPoints, holes = [], depth = 10, bevelRadius = 0.4, material, name })\`
  -> Extrudes a 2D outer polygon \`[[x, z], ...]\` with circular holes \`[{ x, y, radius }]\` or polygon holes along \`+Y\` (\`Y = 0 .. depth\`).
- \`CAD.shellBox({ width = 100, height = 35, depth = 70, wallThickness = 2.5, radius = 5, openTop = true, material, name })\`
  -> Watertight hollowed rectangular enclosure with filleted vertical corners (\`Y = 0 .. height\`).
- \`CAD.roundedBox({ width = 40, height = 20, depth = 40, radius = 3, segments = 4, material, name })\`
  -> Filleted solid box resting on \`Y = 0 .. height\`.
- \`CAD.pipe({ outerDiameter = 30, innerDiameter = 20, height = 40, segments = 48, material, name })\`
  -> Watertight hollow cylinder/bushing along \`+Y\` (\`Y = 0 .. height\`). Set \`innerDiameter: 0\` for a solid cylinder/shaft.
- \`CAD.rack({ teeth = 16, module = 2.0, width = 12, height = 10, material, name })\`
  -> Linear meshing gear rack along X.
- \`CAD.booleanUnion(meshA, meshB)\`, \`CAD.booleanSubtract(meshA, meshB)\`, \`CAD.booleanIntersect(meshA, meshB)\`
  -> CSG boolean operations returning a new \`THREE.Mesh\`.
- \`CAD.draw()\` -> Fluent 2D sketcher (\`.movePointerTo([x,y]).lineTo([x,y]).smoothSplineTo([x,y]).close().extrude(depth)\` or \`.revolve()\` / \`.shell(w)\`).
- \`CAD.materials\`:
  - \`CAD.materials.anodizedAluminum(0x3b82f6)\`
  - \`CAD.materials.brushedSteel(0xcbd5e1)\`, \`CAD.materials.darkSteel()\`
  - \`CAD.materials.machinedBrass()\`, \`CAD.materials.brass()\`
  - \`CAD.materials.copper()\`
  - \`CAD.materials.titanium()\`
  - \`CAD.materials.glossCeramic(0xf8fafc)\`, \`CAD.materials.ceramic(0xf8fafc)\`
  - \`CAD.materials.mattePlastic(0x1e293b)\`, \`CAD.materials.rubberElastomer(0x111827)\`
  - \`CAD.materials.acrylicGlass(0x38bdf8, 0.38)\`, \`CAD.materials.frostedGlass(0x38bdf8, 0.38)\`
  - \`CAD.materials.carbonFiber()\`
`;

function isCadCategory(cat) {
  return cat === 'cad3d' || cat === 'cad3d-simple' || cat === 'cad3d-complex';
}

function isCadTask(task, arenaMode) {
  if (arenaMode === '3d') return true;
  if (!task || typeof task !== 'object') return false;
  return task.visualizer === 'cad3d' || isCadCategory(task.category);
}

// The exact header the contract block starts with. Only its literal presence means
// the prompt already carries the contract; a prompt that merely mentions
// `buildModel(THREE` (a user describing their own code) still gets the full contract.
const CAD_CONTRACT_HEADER = '3D & CAD ARENA RUNTIME CONTRACT';

function wrapTaskForCadArena(task, arenaMode) {
  if (!isCadTask(task, arenaMode)) return task;
  const basePrompt = String((task && task.prompt) || '').trim()
    || 'Design a detailed parametric 3D mechanical assembly in millimeters.';
  const alreadyHasContract = basePrompt.includes(CAD_CONTRACT_HEADER);
  const fullPrompt = alreadyHasContract ? basePrompt : `${basePrompt}\n${CAD_CONTRACT_INSTRUCTIONS}`;
  return {
    ...task,
    category: (task && isCadCategory(task.category)) ? task.category : 'cad3d',
    subcategory: (task && task.subcategory) || null,
    language: 'javascript',
    visualizer: 'cad3d',
    executable: true,
    cad3d: true,
    prompt: fullPrompt,
    // A CAD run is never unit-tested: `arenaMode: '3d'` on a graded catalog task must
    // not carry that task's JS test cases into the loop (CAD code would fail every
    // one of them for up to 8 billed rounds). The kernel is the only grader here.
    testCases: [],
    functionName: 'buildModel',
  };
}

// Telemetry comes from the browser (postMessage from the CAD iframe, i.e. from the
// model's own code) and is interpolated into the next prompt: only finite numbers,
// booleans and short identifier-like part names ever make it through.
const finiteNum = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const MAX_TELEMETRY_PART_NAMES = 12;
const MAX_TELEMETRY_PART_NAME_CHARS = 40;
const MAX_TELEMETRY_PARAMS = 40;

function sanitizeTelemetry(telemetry) {
  if (!telemetry || typeof telemetry !== 'object') return null;
  const out = {};
  const bbRaw = Array.isArray(telemetry.boundingBoxMm)
    ? telemetry.boundingBoxMm
    : (typeof telemetry.boundingBoxMm === 'string' ? telemetry.boundingBoxMm.split(/\s*[x×,]\s*/) : []);
  const bb = bbRaw.slice(0, 3).map(finiteNum);
  if (bb.length === 3 && bb.every((n) => n != null)) out.boundingBoxMm = bb.map((n) => +n.toFixed(2));
  for (const k of ['partCount', 'triangleCount', 'vertexCount', 'volumeCm3']) {
    const n = finiteNum(telemetry[k]);
    if (n != null) out[k] = n;
  }
  if (typeof telemetry.watertight === 'boolean') out.watertight = telemetry.watertight;
  if (Array.isArray(telemetry.partNames)) {
    out.partNames = telemetry.partNames
      .filter((n) => typeof n === 'string' || typeof n === 'number')
      .map((n) => String(n).replace(/[^\w .:/+-]/g, '').trim().slice(0, MAX_TELEMETRY_PART_NAME_CHARS))
      .filter(Boolean)
      .slice(0, MAX_TELEMETRY_PART_NAMES);
  }
  if (telemetry.params && typeof telemetry.params === 'object' && !Array.isArray(telemetry.params)) {
    const params = {};
    let count = 0;
    for (const [k, v] of Object.entries(telemetry.params)) {
      if (count >= MAX_TELEMETRY_PARAMS) break;
      if (!/^[A-Za-z_$][\w$]{0,63}$/.test(k)) continue;
      if (typeof v === 'boolean') params[k] = v;
      else if (finiteNum(v) != null) params[k] = finiteNum(v);
      else continue;
      count += 1;
    }
    if (count) out.params = params;
  }
  return out;
}

function formatCadTelemetrySummary(telemetry) {
  const t = sanitizeTelemetry(telemetry);
  if (!t) return '';
  const bits = [];
  if (t.boundingBoxMm) bits.push(`Bounding Box: ${t.boundingBoxMm.join(' x ')} mm`);
  if (t.partCount != null) {
    const names = Array.isArray(t.partNames) && t.partNames.length
      ? ` (${t.partNames.join(', ')})`
      : '';
    bits.push(`Parts: ${t.partCount}${names}`);
  }
  if (t.triangleCount != null) bits.push(`Triangles: ${t.triangleCount.toLocaleString('en-US')}`);
  if (t.vertexCount != null) bits.push(`Vertices: ${t.vertexCount.toLocaleString('en-US')}`);
  if (t.watertight != null) bits.push(`Topology: ${t.watertight ? 'Watertight / Manifold' : 'Open / Non-manifold edges detected'}`);
  if (t.params && Object.keys(t.params).length) {
    bits.push(`Active PARAMS: ${JSON.stringify(t.params)}`);
  }
  return bits.join(' · ');
}

// The 4-view render / reference image sent back to the model. Only raster types
// the vision endpoints accept, and an oversize payload is REJECTED (returned as
// null, so the prompt simply goes without the picture) rather than sliced mid-base64
// into a corrupt image.
const CAD_IMAGE_MIME_RE = /^image\/(png|jpeg|webp)$/;
const MAX_CAD_IMAGE_B64_CHARS = 6 * 1024 * 1024;

function estimateImageTokens(base64) {
  // Gemini-style tiling: 258 tokens per 768x768 tile, falling back to the old
  // flat estimate when the dimensions cannot be read from the header.
  try {
    const { imageDimensionsFromBase64 } = require('./imageInfo');
    const dims = imageDimensionsFromBase64(base64);
    if (dims && dims.width > 0 && dims.height > 0) {
      return Math.ceil(dims.width / 768) * Math.ceil(dims.height / 768) * 258;
    }
  } catch (_) { /* fall through */ }
  return 516;
}

function parseDataUrlToAttachment(dataUrl, name = 'current-4view-viewport-render.png') {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!m) return null;
  const mimeType = m[1].toLowerCase();
  if (!CAD_IMAGE_MIME_RE.test(mimeType)) return null;
  const base64 = m[2].replace(/\s+/g, '');
  if (!base64 || base64.length < 32) return null;
  if (base64.length > MAX_CAD_IMAGE_B64_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64)) return null;
  const byteSize = Math.floor((base64.length * 3) / 4);
  return {
    name,
    mimeType,
    kind: 'image',
    size: byteSize,
    data: base64,
    estimatedTokens: estimateImageTokens(base64),
  };
}

// Same ceiling as the server applies to `previousCode` (server.js), so the prompt
// never silently drops the second half of a long model; when the cap does bite,
// the model is told so instead of being handed a file that ends mid-function.
const MAX_PREVIOUS_CODE_CHARS = 120000;

function buildCadModifyMessages(taskOrOpts, slotModifyArg) {
  // Support both buildCadModifyMessages(task, slotModify) and buildCadModifyMessages({ originalPrompt, previousCode, modificationPrompt, targetPart, telemetry, fourViewDataUrl, slot, extraAttachments })
  const isSingleObj = taskOrOpts && typeof taskOrOpts === 'object' && !slotModifyArg && (
    'originalPrompt' in taskOrOpts || 'previousCode' in taskOrOpts || 'modificationPrompt' in taskOrOpts
  );
  const taskPrompt = isSingleObj
    ? String(taskOrOpts.originalPrompt || taskOrOpts.prompt || '')
    : String((taskOrOpts && taskOrOpts.prompt) || '');
  const baseAttList = isSingleObj
    ? (Array.isArray(taskOrOpts.extraAttachments) ? taskOrOpts.extraAttachments.slice() : [])
    : (taskOrOpts && Array.isArray(taskOrOpts.attachments) ? taskOrOpts.attachments.slice() : []);
  const slotModify = isSingleObj ? taskOrOpts : (slotModifyArg || {});

  const rawDataUrl = slotModify.fourViewDataUrl || slotModify.snapshotDataUrl || '';
  const slotId = slotModify.slot || 'A';
  const snapshotAtt = rawDataUrl
    ? parseDataUrlToAttachment(rawDataUrl, `slot-${slotId}-4view-render.png`)
    : null;
  if (snapshotAtt) baseAttList.push(snapshotAtt);

  const prevCodeFull = String(slotModify.previousCode || slotModify.code || '');
  const prevCodeCut = prevCodeFull.length > MAX_PREVIOUS_CODE_CHARS;
  const prevCode = prevCodeCut ? prevCodeFull.slice(0, MAX_PREVIOUS_CODE_CHARS) : prevCodeFull;
  const prevCodeNote = prevCodeCut
    ? `\n// [NOTE: the previous revision was ${prevCodeFull.length.toLocaleString('en-US')} characters; only the first ${MAX_PREVIOUS_CODE_CHARS.toLocaleString('en-US')} are shown above. Rewrite the complete file.]`
    : '';
  const instruction = String(slotModify.modificationPrompt || slotModify.instruction || '').trim()
    || 'Refine and improve the 3D geometry, ensuring all parts are properly aligned and watertight.';
  const targetPart = slotModify.targetPart ? String(slotModify.targetPart).replace(/[^\w .:/+-]/g, '').trim().slice(0, 80) : '';
  const telemetryLine = formatCadTelemetrySummary(slotModify.telemetry);
  const runtimeError = slotModify.error ? String(slotModify.error).slice(0, 2000) : '';

  const visionNote = snapshotAtt
    ? `An image attachment (\`${snapshotAtt.name}\`) is attached showing the live **4-Angle Viewport Render (ISOMETRIC, FRONT +Z, TOP +Y, RIGHT +X)** of your current 3D model. Inspect all 4 quadrants visually to verify part proportions, orientation (Y-up), mating contact, and check for any unintended floating or clipped geometry.\n\n`
    : '';

  const targetNote = targetPart
    ? `TARGET SUB-PART SELECTED IN VIEWPORT: \`@${targetPart}\` (focus the modification on this sub-part while keeping mating components aligned).\n\n`
    : '';

  const errorNote = runtimeError
    ? `RUNTIME / GEOMETRY ERROR TO FIX:\n\`\`\`\n${runtimeError}\n\`\`\`\n\n`
    : '';

  const content =
    `=== ORIGINAL 3D & CAD BENCHMARK SPECIFICATION ===\n` +
    `${taskPrompt}\n\n` +
    `=== YOUR CURRENT 3D MODEL CODE (CURRENT REVISION) ===\n` +
    (telemetryLine ? `[Measured 3D Viewport Telemetry: ${telemetryLine}]\n` : '') +
    `\`\`\`javascript\n${prevCode}${prevCodeNote}\n\`\`\`\n\n` +
    `=== FOLLOW-UP 3D MODIFICATION REQUEST ===\n` +
    visionNote +
    targetNote +
    errorNote +
    `USER MODIFICATION INSTRUCTION:\n${instruction}\n\n` +
    `Update \`PARAMS\` and \`buildModel(THREE, params, CAD)\` to fulfill the modification request above. ` +
    `Preserve all working sub-parts and materials that were not asked to change, fix any visual orientation or floating-part bugs visible in the 4-angle render, ` +
    `and return ONLY the complete updated \`\`\`javascript code block with no prose outside the fence.`;

  return [{
    role: 'user',
    content,
    attachments: baseAttList.length ? baseAttList : undefined,
  }];
}

// Generate a ready-to-run Autodesk Fusion 360 Python API script (adsk.core / adsk.fusion)
// from a slot's parametric 3D model so engineers using Fusion 360 or Shreyas's headless
// Fusion MCP can execute or import the parametric parameters directly.
//
// SECURITY: this script is pushed to a bridge that EXECUTES it, and every input here
// (title, label, slot, telemetry, params, code) is user / model controlled. Nothing is
// interpolated raw: comments are stripped of line breaks and quotes, strings are
// emitted as JSON literals (valid Python string literals), numbers are coerced, and the
// slot is validated. The geometry itself is a labelled placeholder (a cylinder) - the
// real value is the PARAMS block, parsed from the model's own code.

// A single Python comment line: no line breaks (which would start a new statement),
// no quotes / backslashes, bounded length.
const pyComment = (v, max = 120) => String(v == null ? '' : v).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/["'`\\]/g, '').slice(0, max);
// A Python string literal via JSON (JSON escapes are a subset of Python's).
const pyStr = (v, max = 200) => JSON.stringify(String(v == null ? '' : v).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, max));
const PY_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Pull simple `key: number` (and boolean) pairs out of the model's `const PARAMS = {...}`
// block so the script carries the model's real parameters, not a hard-coded stub.
function parseParamsFromCode(code) {
  const src = String(code || '');
  const start = src.search(/(?:const|let|var)\s+PARAMS\s*=\s*\{/);
  if (start < 0) return {};
  const open = src.indexOf('{', start);
  // Walk to the matching brace, keeping only the TOP-LEVEL text of the literal
  // (nested objects / arrays are dropped) so `nested: { a: 1 }` cannot leak `a`.
  let depth = 0;
  let flat = '';
  let quote = null;
  for (let i = open; i < src.length && i < open + 20000; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { if (depth === 1) flat += ch + (src[i + 1] || ''); i += 1; continue; }
      if (ch === quote) quote = null;
      if (depth === 1) flat += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; if (depth === 1) flat += ch; continue; }
    if (ch === '{' || ch === '[') { depth += 1; if (depth === 2) flat += ' '; continue; }
    if (ch === '}' || ch === ']') { depth -= 1; if (depth === 0) break; continue; }
    if (depth === 1) flat += ch;
  }
  const out = {};
  const pairRe = /(?:^|[,\s])(?:["']?)([A-Za-z_$][\w$]*)(?:["']?)\s*:\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|true|false)(?=\s*(?:,|$|\/\/|\/\*))/gim;
  let p;
  let count = 0;
  while ((p = pairRe.exec(flat)) && count < 64) {
    const key = p[1];
    if (!PY_IDENT_RE.test(key)) continue;
    const raw = p[2].toLowerCase();
    out[key] = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    count += 1;
  }
  return out;
}

const zlib = require('zlib');

function transpileToFusion360Python({ title, taskTitle, slot = 'A', label, modelLabel, params = {}, telemetry = {}, code = '', stepText = '' } = {}) {
  const effectiveTitle = title || taskTitle || 'LLM_Compare_3D_Model';
  const effectiveLabel = pyComment(label || modelLabel || 'Model', 80);
  const safeSlot = /^[A-Z]$/.test(String(slot || '')) ? String(slot) : 'A';
  const safeName = String(effectiveTitle || 'CAD_Model').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'CAD_Model';

  // The model's PARAMS block first, then whatever the live sliders currently hold
  // (explicit `params` win), both restricted to Python-identifier keys and scalars.
  const merged = { ...parseParamsFromCode(code) };
  for (const [k, v] of Object.entries(params && typeof params === 'object' ? params : {})) {
    if (!PY_IDENT_RE.test(k)) continue;
    merged[k] = v;
  }
  const paramLines = [];
  let numericCount = 0;
  for (const [k, v] of Object.entries(merged)) {
    if (paramLines.length >= 128) break;
    if (typeof v === 'boolean') {
      paramLines.push(`    ${pyStr(k, 64)}: ${v ? 'True' : 'False'},`);
    } else if (v != null && v !== '' && Number.isFinite(Number(v))) {
      paramLines.push(`    ${pyStr(k, 64)}: ${Number(v)},  # mm / count`);
      numericCount += 1;
    } else if (typeof v === 'string') {
      paramLines.push(`    ${pyStr(k, 64)}: ${pyStr(v, 120)},`);
    }
    // nested objects / arrays / functions are not Fusion user parameters: skipped
  }
  const fromCode = Object.keys(parseParamsFromCode(code)).length > 0;
  const paramSource = paramLines.length
    ? (fromCode ? "parameters parsed from the slot's PARAMS block" : 'parameters from the live viewport sliders')
    : 'parameter stub (no PARAMS block could be read from the slot code)';

  const bbRaw = (telemetry && (telemetry.boundingBoxMm || (telemetry.boundingBox && telemetry.boundingBox.size))) || null;
  const bbList = Array.isArray(bbRaw) ? bbRaw : (typeof bbRaw === 'string' ? bbRaw.split(/\s*[x×,]\s*/) : []);
  const bbNums = bbList.slice(0, 3).map((n) => Number(n)).filter((n) => Number.isFinite(n));
  const bbStr = bbNums.length === 3 ? bbNums.map((n) => +n.toFixed(2)).join(' x ') : 'N/A';

  let stepZlibB64 = '';
  if (typeof stepText === 'string' && stepText.includes('ISO-10303-21;') && stepText.length <= 4 * 1024 * 1024) {
    try {
      stepZlibB64 = zlib.deflateSync(Buffer.from(stepText, 'utf8')).toString('base64');
    } catch (_) {
      stepZlibB64 = '';
    }
  }
  const geometryHeaderNote = stepZlibB64
    ? 'Embedded watertight ISO-10303-21 STEP AP214 solid (imported directly into Fusion 360 via app.importManager)'
    : 'Parametric base feature (pass stepText from the live 3D viewport to embed the full watertight STEP AP214 solid)';

  return `# ---------------------------------------------------------------------------
# Autodesk Fusion 360 Parametric Python Script (adsk.core / adsk.fusion)
# Generated by LLM Compare 3D & CAD Arena · Slot ${safeSlot} (${effectiveLabel})
# Component: ${safeName}
# Measured WebGL BBox: ${bbStr} mm
# Parameters: ${paramSource}
# Geometry: ${geometryHeaderNote}
# ---------------------------------------------------------------------------
import adsk.core, adsk.fusion, adsk.cam, traceback, math, os, tempfile, zlib, base64

PARAMS = {
${paramLines.join('\n') || '    "scale": 1.0,'}
}
${numericCount ? '' : '# (no numeric parameters were available; the stub value above keeps the script runnable)\n'}
STEP_FILE_PATH = ""
STEP_ZLIB_B64 = ${pyStr(stepZlibB64, 6000000)}
_LLMC_RAN = False

def run(_context=None):
    global _LLMC_RAN
    if _LLMC_RAN:
        return
    _LLMC_RAN = True
    ui = None
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface
        design = adsk.fusion.Design.cast(app.activeProduct)
        if not design:
            doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
            design = adsk.fusion.Design.cast(app.activeProduct)

        root = design.rootComponent

        # Register user parameters in Fusion 360 (Modify -> Change Parameters)
        user_params = design.userParameters
        for k, v in PARAMS.items():
            if isinstance(v, bool):
                continue
            if isinstance(v, (int, float)):
                existing = user_params.itemByName(k)
                is_count = any(tok in k.lower() for tok in ("teeth", "count", "num", "bolts", "holes", "blades", "vanes", "stages", "fins", "pins"))
                expr = f"{int(round(v))}" if is_count else f"{v} mm"
                unit = "" if is_count else "mm"
                if existing:
                    try:
                        existing.expression = expr
                    except:
                        pass
                else:
                    try:
                        user_params.add(k, adsk.core.ValueInput.createByString(expr), unit, "LLM Compare 3D Arena Parameter")
                    except:
                        pass

        if STEP_FILE_PATH and os.path.exists(STEP_FILE_PATH):
            import_mgr = app.importManager
            step_opts = import_mgr.createSTEPImportOptions(STEP_FILE_PATH)
            import_mgr.importToTarget(step_opts, root)
        elif STEP_ZLIB_B64:
            # Import the exact watertight ISO-10303-21 STEP AP214 solid generated by the slot
            tmp_step = None
            try:
                step_bytes = zlib.decompress(base64.b64decode(STEP_ZLIB_B64))
                fd, tmp_step = tempfile.mkstemp(prefix=${pyStr(safeName + '_Slot_' + safeSlot + '_', 48)}, suffix=".step")
                with os.fdopen(fd, "wb") as f:
                    f.write(step_bytes)
                import_mgr = app.importManager
                step_opts = import_mgr.createSTEPImportOptions(tmp_step)
                import_mgr.importToTarget(step_opts, root)
            finally:
                if tmp_step and os.path.exists(tmp_step):
                    try:
                        os.remove(tmp_step)
                    except:
                        pass
        else:
            occ = root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
            comp = occ.component
            comp.name = ${pyStr(safeName + '_Slot_' + safeSlot, 80)}
            sketches = comp.sketches
            xyPlane = comp.xZConstructionPlane
            sketch = sketches.add(xyPlane)
            circles = sketch.sketchCurves.sketchCircles
            baseRadiusCm = float(PARAMS.get("outerRadius", 30.0)) * 0.1
            circles.addByCenterRadius(adsk.core.Point3D.create(0, 0, 0), baseRadiusCm)
            prof = sketch.profiles.item(0)
            extrudes = comp.features.extrudeFeatures
            extDist = adsk.core.ValueInput.createByReal(float(PARAMS.get("gearThickness", 12.0)) * 0.1)
            extrudes.addSimple(prof, extDist, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)

        try:
            if app.activeViewport:
                app.activeViewport.fit()
                app.activeViewport.refresh()
        except:
            pass
        msg = "Imported LLM Compare Slot ${safeSlot} (${safeName}) with {} parameters into Fusion 360.".format(len(PARAMS))
        app.log(msg)
        print(msg)
    except:
        err_msg = traceback.format_exc()
        print("LLM Compare Fusion script failed:\\n" + err_msg)
        try:
            adsk.core.Application.get().log("LLM Compare Fusion script failed:\\n" + err_msg)
        except:
            pass
        if ui and _context is not None:
            ui.messageBox("Failed:\\n{}".format(err_msg))

# Auto-invoke when executed via Fusion 360 MCP (fusion_mcp_execute exec() runner);
# _LLMC_RAN ensures run(context) is not executed twice if the host also calls run().
run(None)
`;
}

function getCadMcpStatus() {
  const endpoint = process.env.CAD_MCP_URL || '';
  const sanitized = endpoint ? endpoint.replace(/\/\/[^@]+@/, '//***@') : null;
  return {
    ok: true,
    configured: Boolean(endpoint),
    endpoint: sanitized,
    fusionMcp: { endpoint: sanitized },
    blenderMcp: { endpoint: sanitized },
    capabilities: [
      'step-ap214-export',
      'stl-binary-export',
      'glb-pbr-export',
      'obj-wavefront-export',
      'fusion360-python-script',
      'four-view-orthographic-sheet',
    ],
  };
}

// Reference parametric solutions for the 21 curated 3D & CAD Manufacturing Engineering tasks
// (8 Simple Parts + 13 Complex Parts).
// NOTE (review 10.2): UNUSED REFERENCE MATERIAL at runtime - nothing in src/ or server.js
// reads these beyond the export; they are kept as kernel regression inputs / examples of
// the `buildModel(THREE, params, CAD)` contract and are exercised only by test/verify-3d-arena.js.
const CAD_REFERENCE_SOLUTIONS = {
  'cad-simple-hex-bolt-nut': `
const PARAMS = {
  boltDiameter: 20,
  threadPitch: 2.5,
  shankLength: 22,
  threadLength: 45,
  nutPositionY: 44
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const rCorner = (p.boltDiameter * 1.5) / Math.sqrt(3);
  const headPts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    headPts.push([Math.cos(a) * rCorner, Math.sin(a) * rCorner]);
  }
  const head = CAD.extrudeWithHoles({
    outerPoints: headPts,
    holes: [],
    depth: 13,
    bevelRadius: 0.8,
    material: CAD.materials.darkSteel(),
    name: 'hex_bolt_head'
  });
  group.add(head);

  const shank = CAD.pipe({
    outerDiameter: p.boltDiameter,
    innerDiameter: 0,
    height: p.shankLength,
    segments: 48,
    material: CAD.materials.brushedSteel(),
    name: 'bolt_grip_shank'
  });
  shank.position.y = 13;
  group.add(shank);

  const thread = CAD.helicalThread({
    diameter: p.boltDiameter,
    pitch: p.threadPitch,
    length: p.threadLength,
    material: CAD.materials.brushedSteel(),
    name: 'bolt_helical_thread'
  });
  thread.position.y = 13 + p.shankLength;
  group.add(thread);

  const washer = CAD.pipe({
    outerDiameter: p.boltDiameter * 1.85,
    innerDiameter: p.boltDiameter + 1,
    height: 3.5,
    segments: 48,
    material: CAD.materials.titanium(),
    name: 'flat_washer'
  });
  washer.position.y = p.nutPositionY - 3.5;
  group.add(washer);

  const nut = CAD.extrudeWithHoles({
    outerPoints: headPts,
    holes: [{ x: 0, y: 0, radius: p.boltDiameter / 2 }],
    depth: 16,
    bevelRadius: 0.8,
    material: CAD.materials.machinedBrass(),
    name: 'hex_nut'
  });
  nut.position.y = p.nutPositionY;
  group.add(nut);
  return group;
}`,
  'cad-simple-flanged-bushing': `
const PARAMS = {
  boreDiameter: 32,
  barrelOuterDiameter: 46,
  flangeDiameter: 68,
  flangeThickness: 8,
  totalHeight: 58
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const flange = CAD.pipe({
    outerDiameter: p.flangeDiameter,
    innerDiameter: p.boreDiameter,
    height: p.flangeThickness,
    segments: 64,
    material: CAD.materials.machinedBrass(),
    name: 'thrust_flange_collar'
  });
  group.add(flange);

  const barrelH = Math.max(16, p.totalHeight - p.flangeThickness);
  const barrel = CAD.pipe({
    outerDiameter: p.barrelOuterDiameter,
    innerDiameter: p.boreDiameter,
    height: barrelH,
    segments: 64,
    material: CAD.materials.machinedBrass(),
    name: 'bushing_sleeve_barrel'
  });
  barrel.position.y = p.flangeThickness;
  group.add(barrel);

  const oilCollar = CAD.pipe({
    outerDiameter: p.barrelOuterDiameter + 2,
    innerDiameter: p.barrelOuterDiameter - 2,
    height: 6,
    segments: 64,
    material: CAD.materials.copper(),
    name: 'annular_oil_collar'
  });
  oilCollar.position.y = p.flangeThickness + barrelH * 0.45;
  group.add(oilCollar);
  return group;
}`,
  'cad-simple-l-bracket': `
const PARAMS = {
  bracketWidth: 90,
  baseDepth: 80,
  uprightHeight: 75,
  plateThickness: 10,
  pilotBoreDiameter: 34
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const hw = p.bracketWidth / 2;
  const hd = p.baseDepth / 2;
  const basePlate = CAD.extrudeWithHoles({
    outerPoints: [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]],
    holes: [
      { x: -hw + 16, y: -hd + 16, radius: 4.25 },
      { x: hw - 16, y: -hd + 16, radius: 4.25 },
      { x: -hw + 16, y: hd - 20, radius: 4.25 },
      { x: hw - 16, y: hd - 20, radius: 4.25 }
    ],
    depth: p.plateThickness,
    bevelRadius: 0.8,
    material: CAD.materials.anodizedAluminum(0x2563eb),
    name: 'horizontal_base_plate'
  });
  group.add(basePlate);

  const upright = CAD.roundedBox({
    width: p.bracketWidth,
    height: p.uprightHeight,
    depth: p.plateThickness,
    radius: 2,
    material: CAD.materials.anodizedAluminum(0x2563eb),
    name: 'vertical_upright_plate'
  });
  upright.position.set(0, p.plateThickness, -hd + p.plateThickness / 2);
  group.add(upright);

  const pilotBoss = CAD.pipe({
    outerDiameter: p.pilotBoreDiameter + 12,
    innerDiameter: p.pilotBoreDiameter,
    height: p.plateThickness + 6,
    segments: 48,
    material: CAD.materials.brushedSteel(),
    name: 'spindle_pilot_boss'
  });
  pilotBoss.rotation.x = Math.PI / 2;
  pilotBoss.position.set(0, p.plateThickness + p.uprightHeight * 0.55, -hd + p.plateThickness + 3);
  group.add(pilotBoss);

  [-1, 1].forEach((side, idx) => {
    const gusset = CAD.roundedBox({
      width: 8,
      height: p.uprightHeight * 0.65,
      depth: p.baseDepth * 0.55,
      radius: 1.5,
      material: CAD.materials.anodizedAluminum(0x1e40af),
      name: idx === 0 ? 'left_rib_gusset' : 'right_rib_gusset'
    });
    gusset.position.set(side * (hw - 4), p.plateThickness, -hd * 0.35);
    group.add(gusset);
  });
  return group;
}`,
  'cad-simple-pulley-sheave': `
const PARAMS = {
  outerDiameter: 120,
  rimThickness: 28,
  boreDiameter: 20,
  hubDiameter: 44,
  lighteningHoles: 6
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const rOut = p.outerDiameter / 2;
  const rRoot = rOut - 12;
  const rWeb = rRoot - 6;
  const h = p.rimThickness;

  const rim = CAD.revolveProfile({
    points: [
      [rWeb, 0],
      [rOut, 0],
      [rOut, h * 0.22],
      [rRoot, h * 0.5],
      [rOut, h * 0.78],
      [rOut, h],
      [rWeb, h]
    ],
    segments: 64,
    material: CAD.materials.darkSteel(),
    name: 'vbelt_pulley_rim'
  });
  group.add(rim);

  const web = CAD.pipe({
    outerDiameter: rWeb * 2 + 2,
    innerDiameter: p.hubDiameter - 2,
    height: 10,
    segments: 64,
    material: CAD.materials.anodizedAluminum(0x475569),
    name: 'recessed_pulley_web'
  });
  web.position.y = (h - 10) / 2;
  group.add(web);

  const hub = CAD.pipe({
    outerDiameter: p.hubDiameter,
    innerDiameter: p.boreDiameter,
    height: h + 4,
    segments: 48,
    material: CAD.materials.brushedSteel(),
    name: 'central_drive_hub'
  });
  group.add(hub);

  const collar = CAD.pipe({
    outerDiameter: p.hubDiameter + 4,
    innerDiameter: p.boreDiameter,
    height: 4,
    segments: 48,
    material: CAD.materials.machinedBrass(),
    name: 'set_screw_boss'
  });
  collar.position.y = h + 4;
  group.add(collar);
  return group;
}`,
  'cad-simple-pipe-flange': `
const PARAMS = {
  flangeOuterDia: 150,
  boreDiameter: 52,
  boltCircleDia: 120,
  boltHoleCount: 8,
  neckHeight: 36
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const raisedFace = CAD.pipe({
    outerDiameter: p.boreDiameter + 40,
    innerDiameter: p.boreDiameter,
    height: 3,
    segments: 64,
    material: CAD.materials.brushedSteel(),
    name: 'raised_sealing_face'
  });
  group.add(raisedFace);

  const outerPts = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    outerPts.push([Math.cos(a) * (p.flangeOuterDia / 2), Math.sin(a) * (p.flangeOuterDia / 2)]);
  }
  const holes = [{ x: 0, y: 0, radius: p.boreDiameter / 2 }];
  for (let i = 0; i < p.boltHoleCount; i++) {
    const a = (i / p.boltHoleCount) * Math.PI * 2;
    holes.push({
      x: Math.cos(a) * (p.boltCircleDia / 2),
      y: Math.sin(a) * (p.boltCircleDia / 2),
      radius: 8
    });
  }
  const disc = CAD.extrudeWithHoles({
    outerPoints: outerPts,
    holes,
    depth: 16,
    bevelRadius: 0.8,
    material: CAD.materials.brushedSteel(),
    name: 'bolted_flange_disc'
  });
  disc.position.y = 3;
  group.add(disc);

  const rIn = p.boreDiameter / 2;
  const neck = CAD.revolveProfile({
    points: [
      [rIn, 19],
      [rIn + 13, 19],
      [rIn + 4, 19 + p.neckHeight],
      [rIn, 19 + p.neckHeight]
    ],
    segments: 64,
    material: CAD.materials.titanium(),
    name: 'tapered_weld_neck_hub'
  });
  group.add(neck);
  return group;
}`,
  'cad-simple-stepped-shaft': `
const PARAMS = {
  collarDiameter: 54,
  gearSeatDiameter: 38,
  upperJournalDiameter: 28,
  keyLength: 32,
  totalShaftLength: 124
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const lowerJournal = CAD.pipe({
    outerDiameter: 32,
    innerDiameter: 0,
    height: 26,
    segments: 48,
    material: CAD.materials.brushedSteel(),
    name: 'lower_bearing_journal'
  });
  group.add(lowerJournal);

  const collar = CAD.pipe({
    outerDiameter: p.collarDiameter,
    innerDiameter: 0,
    height: 14,
    segments: 64,
    material: CAD.materials.titanium(),
    name: 'center_thrust_collar'
  });
  collar.position.y = 26;
  group.add(collar);

  const gearSeat = CAD.pipe({
    outerDiameter: p.gearSeatDiameter,
    innerDiameter: 0,
    height: 42,
    segments: 48,
    material: CAD.materials.brushedSteel(),
    name: 'gear_seat_step'
  });
  gearSeat.position.y = 40;
  group.add(gearSeat);

  const key = CAD.roundedBox({
    width: 7,
    height: p.keyLength,
    depth: 8,
    radius: 1,
    material: CAD.materials.machinedBrass(),
    name: 'parallel_feather_key'
  });
  key.position.set(p.gearSeatDiameter / 2, 45, 0);
  group.add(key);

  const upperJournal = CAD.pipe({
    outerDiameter: p.upperJournalDiameter,
    innerDiameter: 0,
    height: 22,
    segments: 48,
    material: CAD.materials.brushedSteel(),
    name: 'upper_bearing_journal'
  });
  upperJournal.position.y = 82;
  group.add(upperJournal);

  const threadStub = CAD.helicalThread({
    diameter: 20,
    pitch: 1.5,
    length: Math.max(14, p.totalShaftLength - 104),
    material: CAD.materials.darkSteel(),
    name: 'threaded_locknut_stub'
  });
  threadStub.position.y = 104;
  group.add(threadStub);
  return group;
}`,
  'cad-simple-spur-gear': `
const PARAMS = {
  teeth: 28,
  module: 2.5,
  faceWidth: 18,
  boreDiameter: 18,
  hubDiameter: 34,
  lighteningHoles: 6
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const gear = CAD.spurGear({
    teeth: p.teeth,
    module: p.module,
    thickness: p.faceWidth,
    boreDiameter: p.boreDiameter,
    lighteningHoles: p.lighteningHoles,
    material: CAD.materials.brushedSteel(),
    name: 'involute_gear_rim'
  });
  group.add(gear);

  const hub = CAD.pipe({
    outerDiameter: p.hubDiameter,
    innerDiameter: p.boreDiameter,
    height: 10,
    segments: 48,
    material: CAD.materials.machinedBrass(),
    name: 'central_gear_hub'
  });
  hub.position.y = p.faceWidth;
  group.add(hub);

  const collar = CAD.pipe({
    outerDiameter: p.hubDiameter + 6,
    innerDiameter: p.boreDiameter,
    height: 4,
    segments: 48,
    material: CAD.materials.titanium(),
    name: 'hub_clamp_collar'
  });
  collar.position.y = p.faceWidth;
  group.add(collar);
  return group;
}`,
  'cad-simple-pillow-block': `
const PARAMS = {
  baseWidth: 140,
  baseThickness: 14,
  shaftCenterHeight: 46,
  housingOuterDia: 68,
  shaftBoreDia: 28
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const hw = p.baseWidth / 2;
  const hd = 22;
  const baseFoot = CAD.extrudeWithHoles({
    outerPoints: [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]],
    holes: [
      { x: -hw + 18, y: 0, radius: 6 },
      { x: hw - 18, y: 0, radius: 6 }
    ],
    depth: p.baseThickness,
    bevelRadius: 1.5,
    material: CAD.materials.anodizedAluminum(0x1e3a8a),
    name: 'pillow_base_foot'
  });
  group.add(baseFoot);

  const pedestal = CAD.roundedBox({
    width: p.housingOuterDia * 0.9,
    height: p.shaftCenterHeight - p.baseThickness,
    depth: 36,
    radius: 3,
    material: CAD.materials.anodizedAluminum(0x1e3a8a),
    name: 'pedestal_support_web'
  });
  pedestal.position.set(0, p.baseThickness, 0);
  group.add(pedestal);

  const housingRing = CAD.pipe({
    outerDiameter: p.housingOuterDia,
    innerDiameter: p.shaftBoreDia + 16,
    height: 42,
    segments: 64,
    material: CAD.materials.anodizedAluminum(0x1e3a8a),
    name: 'pedestal_housing_ring'
  });
  housingRing.rotation.x = Math.PI / 2;
  housingRing.position.set(0, p.shaftCenterHeight, -21);
  group.add(housingRing);

  const bronzeInsert = CAD.pipe({
    outerDiameter: p.shaftBoreDia + 16,
    innerDiameter: p.shaftBoreDia,
    height: 48,
    segments: 64,
    material: CAD.materials.machinedBrass(),
    name: 'bronze_bearing_insert'
  });
  bronzeInsert.rotation.x = Math.PI / 2;
  bronzeInsert.position.set(0, p.shaftCenterHeight, -24);
  group.add(bronzeInsert);

  const zerk = CAD.pipe({
    outerDiameter: 10,
    innerDiameter: 3,
    height: 10,
    segments: 6,
    material: CAD.materials.machinedBrass(),
    name: 'grease_zerk_fitting'
  });
  zerk.position.set(0, p.shaftCenterHeight + p.housingOuterDia / 2 - 2, 0);
  group.add(zerk);
  return group;
}`,
  'cad-planetary-gearbox': `
const PARAMS = {
  module: 2.5,
  sunTeeth: 16,
  planetTeeth: 16,
  ringTeeth: 48,
  planetCount: 3,
  gearFaceWidth: 16
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const ring = CAD.internalGear({
    teeth: p.ringTeeth,
    module: p.module,
    thickness: p.gearFaceWidth,
    rimThickness: 10,
    material: CAD.materials.anodizedAluminum(0x1e293b),
    name: 'ring_gear_housing'
  });
  group.add(ring);

  const sun = CAD.spurGear({
    teeth: p.sunTeeth,
    module: p.module,
    thickness: p.gearFaceWidth,
    boreDiameter: 10,
    material: CAD.materials.machinedBrass(),
    name: 'sun_gear'
  });
  group.add(sun);

  const orbitR = ((p.sunTeeth + p.planetTeeth) * p.module) / 2;
  for (let i = 0; i < p.planetCount; i++) {
    const ang = (i / p.planetCount) * Math.PI * 2;
    const planet = CAD.spurGear({
      teeth: p.planetTeeth,
      module: p.module,
      thickness: p.gearFaceWidth,
      boreDiameter: 8,
      material: CAD.materials.brushedSteel(),
      name: 'planet_gear_' + (i + 1)
    });
    planet.position.set(Math.cos(ang) * orbitR, 0, Math.sin(ang) * orbitR);
    group.add(planet);
  }
  return group;
}`,
  'cad-enclosure-snapfit': `
const PARAMS = {
  boxLength: 120,
  boxWidth: 80,
  baseHeight: 34,
  wallThickness: 2.8,
  cornerRadius: 6
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const base = CAD.shellBox({
    width: p.boxLength,
    height: p.baseHeight,
    depth: p.boxWidth,
    wallThickness: p.wallThickness,
    radius: p.cornerRadius,
    openTop: true,
    material: CAD.materials.anodizedAluminum(0x334155),
    name: 'enclosure_base_tub'
  });
  group.add(base);

  const lid = CAD.roundedBox({
    width: p.boxLength,
    height: 6,
    depth: p.boxWidth,
    radius: p.cornerRadius,
    material: CAD.materials.frostedGlass(0x38bdf8, 0.52),
    name: 'snapfit_top_lid'
  });
  lid.position.y = p.baseHeight + 16;
  group.add(lid);

  const pcb = CAD.roundedBox({
    width: p.boxLength - 14,
    height: 2,
    depth: p.boxWidth - 14,
    radius: 3,
    material: CAD.materials.mattePlastic(0x10b981),
    name: 'pcb_board'
  });
  pcb.position.y = 10;
  group.add(pcb);
  return group;
}`,
  'cad-robotic-gripper': `
const PARAMS = {
  jawStrokeMm: 22,
  fingerLength: 62,
  palmWidth: 84,
  palmHeight: 28
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const flange = CAD.pipe({
    outerDiameter: 56,
    innerDiameter: 18,
    height: 12,
    material: CAD.materials.anodizedAluminum(0x475569),
    name: 'iso_wrist_flange'
  });
  group.add(flange);

  const palm = CAD.roundedBox({
    width: p.palmWidth,
    height: p.palmHeight,
    depth: 36,
    radius: 4,
    material: CAD.materials.brushedSteel(),
    name: 'palm_chassis'
  });
  palm.position.y = 12;
  group.add(palm);

  [-1, 1].forEach((side, idx) => {
    const finger = CAD.roundedBox({
      width: 12,
      height: p.fingerLength,
      depth: 22,
      radius: 2,
      material: CAD.materials.anodizedAluminum(0x0ea5e9),
      name: idx === 0 ? 'left_gripper_finger' : 'right_gripper_finger'
    });
    finger.position.set(side * (p.jawStrokeMm + 8), 12 + p.palmHeight, 0);
    group.add(finger);
  });
  return group;
}`,
  'cad-turbo-impeller': `
const PARAMS = {
  inducerRadius: 24,
  exducerRadius: 56,
  hubHeight: 54,
  mainBladeCount: 7,
  boreRadius: 8
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const hub = CAD.revolveProfile({
    points: [
      [p.boreRadius, 0],
      [p.exducerRadius, 0],
      [p.exducerRadius, 8],
      [p.inducerRadius * 0.85, p.hubHeight * 0.55],
      [p.boreRadius + 6, p.hubHeight],
      [p.boreRadius, p.hubHeight]
    ],
    segments: 64,
    spline: true,
    material: CAD.materials.titanium(),
    name: 'impeller_conical_hub'
  });
  group.add(hub);

  const nose = CAD.helicalThread({
    diameter: p.boreRadius * 2 + 6,
    pitch: 2.0,
    length: 14,
    material: CAD.materials.machinedBrass(),
    name: 'hex_spindle_nose_nut'
  });
  nose.position.y = p.hubHeight;
  group.add(nose);

  for (let i = 0; i < p.mainBladeCount; i++) {
    const blade = CAD.roundedBox({
      width: p.exducerRadius - p.boreRadius - 4,
      height: p.hubHeight * 0.78,
      depth: 2.2,
      radius: 0.6,
      material: CAD.materials.brushedSteel(),
      name: 'main_impeller_blade_' + (i + 1)
    });
    const ang = (i / p.mainBladeCount) * Math.PI * 2;
    const rMid = (p.exducerRadius + p.boreRadius) * 0.45;
    blade.position.set(Math.cos(ang) * rMid, 6, Math.sin(ang) * rMid);
    blade.rotation.y = -ang + 0.35;
    group.add(blade);
  }
  return group;
}`,
  'cad-architectural-pavilion': `
const PARAMS = {
  spanRadius: 95,
  apexHeight: 74,
  diagridRibs: 12,
  ringTiers: 4,
  oculusRadius: 22
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const plinth = CAD.pipe({
    outerDiameter: p.spanRadius * 2 + 16,
    innerDiameter: p.oculusRadius * 1.4,
    height: 8,
    segments: 64,
    material: CAD.materials.glossCeramic(0xe2e8f0),
    name: 'stepped_plinth_base'
  });
  group.add(plinth);

  const canopy = CAD.revolveHollow({
    points: [
      [p.spanRadius, 8],
      [p.spanRadius * 0.78, 8 + p.apexHeight * 0.55],
      [p.oculusRadius, 8 + p.apexHeight]
    ],
    wallThickness: 2.6,
    openTop: true,
    ribCount: p.diagridRibs,
    ribDepth: 2.2,
    ribTwistTurns: 0.25,
    material: CAD.materials.frostedGlass(0x7dd3fc, 0.48),
    name: 'diagrid_glass_canopy'
  });
  group.add(canopy);

  const core = CAD.helicalThread({
    diameter: p.oculusRadius * 1.1,
    pitch: 12,
    length: p.apexHeight,
    material: CAD.materials.oakTimber(),
    name: 'helical_observation_stair'
  });
  core.position.y = 8;
  group.add(core);
  return group;
}`,
  'cad-cnc-manifold-block': `
const PARAMS = {
  blockLength: 130,
  blockWidth: 86,
  blockHeight: 64,
  portBoreDia: 16,
  bossHeight: 16
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const block = CAD.roundedBox({
    width: p.blockLength,
    height: p.blockHeight,
    depth: p.blockWidth,
    radius: 3.5,
    material: CAD.materials.anodizedAluminum(0x0284c7),
    name: 'cnc_manifold_billet_block'
  });
  group.add(block);

  [-32, 32].forEach((xOff, idx) => {
    const cartridge = CAD.helicalThread({
      diameter: 24,
      pitch: 2.5,
      length: p.bossHeight,
      material: CAD.materials.machinedBrass(),
      name: 'relief_valve_cartridge_' + (idx + 1)
    });
    cartridge.position.set(xOff, p.blockHeight, 0);
    group.add(cartridge);

    const portFlange = CAD.pipe({
      outerDiameter: p.portBoreDia + 14,
      innerDiameter: p.portBoreDia,
      height: 14,
      material: CAD.materials.brushedSteel(),
      name: 'sae_pressure_port_' + (idx + 1)
    });
    portFlange.rotation.x = Math.PI / 2;
    portFlange.position.set(xOff, p.blockHeight * 0.5, p.blockWidth / 2);
    group.add(portFlange);
  });
  return group;
}`,
  'cad-sheetmetal-server-chassis': `
const PARAMS = {
  trayWidth: 160,
  trayDepth: 120,
  wallHeight: 42,
  sheetThickness: 2.5,
  standoffHeight: 8
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const tray = CAD.shellBox({
    width: p.trayWidth,
    height: p.wallHeight,
    depth: p.trayDepth,
    wallThickness: p.sheetThickness,
    radius: 3,
    openTop: true,
    material: CAD.materials.brushedSteel(),
    name: 'sheetmetal_1u_carrier_pan'
  });
  group.add(tray);

  [-1, 1].forEach((side, idx) => {
    const ear = CAD.roundedBox({
      width: 18,
      height: p.wallHeight - 2,
      depth: 4,
      radius: 1.2,
      material: CAD.materials.anodizedAluminum(0x1e293b),
      name: idx === 0 ? 'left_eia_rack_ear' : 'right_eia_rack_ear'
    });
    ear.position.set(side * (p.trayWidth / 2 + 9), 1, p.trayDepth / 2 - 2);
    group.add(ear);
  });

  const divider = CAD.roundedBox({
    width: p.sheetThickness,
    height: p.wallHeight - 8,
    depth: p.trayDepth - 16,
    radius: 0.8,
    material: CAD.materials.anodizedAluminum(0x38bdf8),
    name: 'nvme_bay_partition_wall'
  });
  divider.position.y = p.sheetThickness;
  group.add(divider);

  [[-48, -32], [48, -32], [-48, 32], [48, 32]].forEach(([x, z], i) => {
    const pem = CAD.pipe({
      outerDiameter: 7,
      innerDiameter: 3,
      height: p.standoffHeight,
      material: CAD.materials.machinedBrass(),
      name: 'pem_standoff_' + (i + 1)
    });
    pem.position.set(x, p.sheetThickness, z);
    group.add(pem);
  });
  return group;
}`,
  'cad-injection-mold-fan-shroud': `
const PARAMS = {
  plenumSize: 150,
  throatDiameter: 112,
  shroudHeight: 28,
  vaneCount: 6,
  wallThickness: 3.0
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const deck = CAD.shellBox({
    width: p.plenumSize,
    height: 12,
    depth: p.plenumSize,
    wallThickness: p.wallThickness,
    radius: 6,
    openTop: true,
    material: CAD.materials.mattePlastic(0x1e293b),
    name: 'radiator_plenum_skirt'
  });
  group.add(deck);

  const ring = CAD.pipe({
    outerDiameter: p.throatDiameter + p.wallThickness * 2,
    innerDiameter: p.throatDiameter,
    height: p.shroudHeight,
    segments: 64,
    material: CAD.materials.mattePlastic(0x334155),
    name: 'venturi_fan_shroud_ring'
  });
  ring.position.y = 8;
  group.add(ring);

  const hub = CAD.pipe({
    outerDiameter: 54,
    innerDiameter: 14,
    height: 22,
    material: CAD.materials.brushedSteel(),
    name: 'bldc_motor_stator_hub'
  });
  hub.position.y = 12;
  group.add(hub);

  const span = (p.throatDiameter - 50) / 2;
  for (let i = 0; i < p.vaneCount; i++) {
    const ang = (i / p.vaneCount) * Math.PI * 2;
    const rMid = 26 + span * 0.5;
    const vane = CAD.roundedBox({
      width: span,
      height: 16,
      depth: 2.6,
      radius: 0.6,
      material: CAD.materials.anodizedAluminum(0x38bdf8),
      name: 'stator_guide_vane_' + (i + 1)
    });
    vane.position.set(Math.cos(ang) * rMid, 14, Math.sin(ang) * rMid);
    vane.rotation.y = -ang + 0.22;
    group.add(vane);
  }
  return group;
}`,
  'cad-diecast-ev-inverter-housing': `
const PARAMS = {
  housingLength: 160,
  housingWidth: 116,
  housingHeight: 46,
  pinRows: 3,
  nozzleLength: 18
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const housing = CAD.shellBox({
    width: p.housingLength,
    height: p.housingHeight,
    depth: p.housingWidth,
    wallThickness: 3.5,
    radius: 8,
    openTop: true,
    material: CAD.materials.titanium(),
    name: 'hpdc_inverter_cast_housing'
  });
  group.add(housing);

  const coldPlate = CAD.roundedBox({
    width: p.housingLength - 28,
    height: 6,
    depth: p.housingWidth - 28,
    radius: 3,
    material: CAD.materials.copper(),
    name: 'sic_mosfet_copper_cold_plate'
  });
  coldPlate.position.y = 3.5;
  group.add(coldPlate);

  for (let r = 0; r < p.pinRows; r++) {
    for (let c = 0; c < 4; c++) {
      const pin = CAD.pipe({
        outerDiameter: 8,
        innerDiameter: 0,
        height: 16,
        material: CAD.materials.copper(),
        name: 'thermal_pin_fin_' + (r * 4 + c + 1)
      });
      pin.position.set(-36 + c * 24, 9.5, -20 + r * 20);
      group.add(pin);
    }
  }

  [-1, 0, 1].forEach((phaseIdx, i) => {
    const gland = CAD.roundedBox({
      width: 16,
      height: 14,
      depth: 18,
      radius: 2,
      material: CAD.materials.mattePlastic(0xf97316),
      name: 'hv_phase_busbar_gland_' + (i + 1)
    });
    gland.position.set(phaseIdx * 36, p.housingHeight * 0.45, p.housingWidth / 2 + 7);
    group.add(gland);
  });
  return group;
}`,
  'cad-additive-lattice-heatsink': `
const PARAMS = {
  baseLength: 120,
  baseWidth: 90,
  coreHeight: 44,
  gridCols: 4,
  gridRows: 3,
  nozzleDia: 26
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const basePlate = CAD.roundedBox({
    width: p.baseLength,
    height: 8,
    depth: p.baseWidth,
    radius: 4,
    material: CAD.materials.copper(),
    name: 'copper_thermal_spreader_base'
  });
  group.add(basePlate);

  for (let r = 0; r < p.gridRows; r++) {
    for (let c = 0; c < p.gridCols; c++) {
      const x = ((c / Math.max(1, p.gridCols - 1)) - 0.5) * (p.baseLength - 34);
      const z = ((r / Math.max(1, p.gridRows - 1)) - 0.5) * (p.baseWidth - 30);
      const strut = CAD.helicalThread({
        diameter: 12,
        pitch: 6,
        length: p.coreHeight,
        material: CAD.materials.titanium(),
        name: 'dmls_gyroid_lattice_cell_' + (r * p.gridCols + c + 1)
      });
      strut.position.set(x, 8, z);
      group.add(strut);
    }
  }

  const manifoldCap = CAD.roundedBox({
    width: p.baseLength - 12,
    height: 10,
    depth: p.baseWidth - 12,
    radius: 4,
    material: CAD.materials.anodizedAluminum(0x38bdf8),
    name: 'upper_conformal_collector_plenum'
  });
  manifoldCap.position.y = 8 + p.coreHeight;
  group.add(manifoldCap);

  [-32, 32].forEach((xOff, idx) => {
    const nozzle = CAD.pipe({
      outerDiameter: p.nozzleDia,
      innerDiameter: p.nozzleDia - 10,
      height: 18,
      material: CAD.materials.machinedBrass(),
      name: idx === 0 ? 'coolant_inlet_nozzle' : 'coolant_outlet_nozzle'
    });
    nozzle.position.set(xOff, 18 + p.coreHeight, 0);
    group.add(nozzle);
  });
  return group;
}`,
  'cad-forged-connecting-rod': `
const PARAMS = {
  centerLength: 135,
  crankBoreDia: 58,
  wristPinDia: 24,
  rodThickness: 24,
  beamWidth: 26
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const halfLen = p.centerLength / 2;

  const bigEnd = CAD.pipe({
    outerDiameter: p.crankBoreDia + 22,
    innerDiameter: p.crankBoreDia,
    height: p.rodThickness,
    segments: 64,
    material: CAD.materials.titanium(),
    name: 'forged_crank_big_end_journal'
  });
  bigEnd.position.set(-halfLen, 0, 0);
  group.add(bigEnd);

  const bearingShell = CAD.pipe({
    outerDiameter: p.crankBoreDia,
    innerDiameter: p.crankBoreDia - 4,
    height: p.rodThickness,
    segments: 64,
    material: CAD.materials.machinedBrass(),
    name: 'tri_metal_crank_bearing_shell'
  });
  bearingShell.position.set(-halfLen, 0, 0);
  group.add(bearingShell);

  const smallEnd = CAD.pipe({
    outerDiameter: p.wristPinDia + 16,
    innerDiameter: p.wristPinDia,
    height: p.rodThickness,
    segments: 48,
    material: CAD.materials.titanium(),
    name: 'wrist_pin_small_end_eye'
  });
  smallEnd.position.set(halfLen, 0, 0);
  group.add(smallEnd);

  const shankLen = p.centerLength - (p.crankBoreDia / 2 + p.wristPinDia / 2 + 12);
  const web = CAD.roundedBox({
    width: Math.max(30, shankLen),
    height: p.rodThickness * 0.45,
    depth: p.beamWidth - 6,
    radius: 2,
    material: CAD.materials.titanium(),
    name: 'ibeam_recessed_web'
  });
  web.position.set(10, p.rodThickness * 0.27, 0);
  group.add(web);

  [-1, 1].forEach((side, idx) => {
    const flange = CAD.roundedBox({
      width: Math.max(30, shankLen + 8),
      height: p.rodThickness,
      depth: 5,
      radius: 1.5,
      material: CAD.materials.brushedSteel(),
      name: idx === 0 ? 'ibeam_front_flange_rail' : 'ibeam_rear_flange_rail'
    });
    flange.position.set(10, 0, side * (p.beamWidth / 2 - 2.5));
    group.add(flange);
  });
  return group;
}`,
  'cad-medical-titanium-bone-plate': `
const PARAMS = {
  plateLength: 110,
  shaftWidth: 16,
  distalHeadWidth: 44,
  plateThickness: 4.5,
  shaftHoles: 4
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();

  const shaftHolesArr = [];
  for (let i = 0; i < p.shaftHoles; i++) {
    shaftHolesArr.push({ x: -34 + i * 18, y: 0, radius: 2.2 });
  }
  const hw = p.shaftWidth / 2;
  const hl = p.plateLength / 2;
  const shaft = CAD.extrudeWithHoles({
    outerPoints: [[-hl, -hw], [hl - 22, -hw], [hl - 22, hw], [-hl, hw]],
    holes: shaftHolesArr,
    depth: p.plateThickness,
    bevelRadius: 0.8,
    material: CAD.materials.anodizedAluminum(0x0ea5e9),
    name: 'ti6al4v_diaphyseal_plate_shaft'
  });
  group.add(shaft);

  const dhw = p.distalHeadWidth / 2;
  const distalHead = CAD.extrudeWithHoles({
    outerPoints: [
      [hl - 24, -hw],
      [hl, -dhw],
      [hl + 12, -dhw * 0.75],
      [hl + 12, dhw * 0.75],
      [hl, dhw],
      [hl - 24, hw]
    ],
    holes: [
      { x: hl - 6, y: -dhw * 0.55, radius: 1.8 },
      { x: hl - 2, y: 0, radius: 1.8 },
      { x: hl - 6, y: dhw * 0.55, radius: 1.8 }
    ],
    depth: p.plateThickness,
    bevelRadius: 0.8,
    material: CAD.materials.anodizedAluminum(0x0ea5e9),
    name: 'anatomical_distal_radius_t_head'
  });
  group.add(distalHead);

  [-16, 2, 20].forEach((xPos, idx) => {
    const screw = CAD.helicalThread({
      diameter: 4.0,
      pitch: 1.25,
      length: 22,
      material: CAD.materials.machinedBrass(),
      name: 'cortical_locking_bone_screw_' + (idx + 1)
    });
    screw.position.set(xPos, p.plateThickness, 0);
    group.add(screw);
  });
  return group;
}`,
  'cad-semiconductor-wafer-chuck': `
const PARAMS = {
  chuckDiameter: 150,
  baseThickness: 14,
  platenHeight: 16,
  vacuumRings: 3,
  liftPinExtension: 14
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();

  const pedestal = CAD.pipe({
    outerDiameter: p.chuckDiameter + 16,
    innerDiameter: 36,
    height: p.baseThickness,
    segments: 64,
    material: CAD.materials.anodizedAluminum(0x1e293b),
    name: 'hard_anodized_kinematic_pedestal'
  });
  group.add(pedestal);

  const platen = CAD.pipe({
    outerDiameter: p.chuckDiameter,
    innerDiameter: 18,
    height: p.platenHeight,
    segments: 64,
    material: CAD.materials.glossCeramic(0xf8fafc),
    name: 'sic_ceramic_vacuum_platen'
  });
  platen.position.y = p.baseThickness;
  group.add(platen);

  for (let i = 1; i <= p.vacuumRings; i++) {
    const rRing = (p.chuckDiameter * 0.42) * (i / p.vacuumRings);
    const land = CAD.pipe({
      outerDiameter: rRing * 2 + 4,
      innerDiameter: rRing * 2,
      height: 2.2,
      segments: 64,
      material: CAD.materials.titanium(),
      name: 'concentric_vacuum_seal_ring_' + i
    });
    land.position.y = p.baseThickness + p.platenHeight;
    group.add(land);
  }

  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2;
    const rPin = p.chuckDiameter * 0.27;
    const pin = CAD.pipe({
      outerDiameter: 5,
      innerDiameter: 0,
      height: p.platenHeight + p.liftPinExtension,
      material: CAD.materials.machinedBrass(),
      name: 'sapphire_wafer_lift_pin_' + (i + 1)
    });
    pin.position.set(Math.cos(ang) * rPin, p.baseThickness, Math.sin(ang) * rPin);
    group.add(pin);
  }
  return group;
}`,
  'cad-simple-cortical-bone-screw': `
const PARAMS = {
  majorDiameter: 6.5,
  screwLength: 30,
  threadPitch: 2.2,
  cannulatedBore: 1.6
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const shank = CAD.helicalThread({
    diameter: p.majorDiameter,
    pitch: p.threadPitch,
    length: p.screwLength - 3.5,
    material: CAD.materials.titanium(),
    name: 'threaded_shank'
  });
  group.add(shank);

  const head = CAD.pipe({
    outerDiameter: 8.0,
    innerDiameter: p.cannulatedBore + 1.4,
    height: 3.5,
    segments: 6,
    material: CAD.materials.anodizedAluminum(0x0ea5e9),
    name: 'screw_head'
  });
  head.position.y = p.screwLength - 3.5;
  group.add(head);

  const tip = CAD.revolveProfile({
    points: [[p.cannulatedBore / 2, 0], [p.majorDiameter / 2, 5], [p.cannulatedBore / 2, 5]],
    segments: 36,
    material: CAD.materials.titanium(),
    name: 'cutting_tip'
  });
  group.add(tip);
  return group;
}`,
  'cad-simple-luer-lock-adapter': `
const PARAMS = {
  barbOuterDia: 6.2,
  lumenDia: 2.8,
  barbRidges: 3,
  hexWidth: 12
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const luerHub = CAD.pipe({
    outerDiameter: 7.8,
    innerDiameter: 4.3,
    height: 10,
    segments: 48,
    material: CAD.materials.frostedGlass(0x7dd3fc, 0.72),
    name: 'luer_hub'
  });
  group.add(luerHub);

  const hexCollar = CAD.pipe({
    outerDiameter: p.hexWidth,
    innerDiameter: p.lumenDia,
    height: 4,
    segments: 6,
    material: CAD.materials.machinedBrass(),
    name: 'hex_grip_flange'
  });
  hexCollar.position.y = 10;
  group.add(hexCollar);

  const stem = CAD.pipe({
    outerDiameter: 4.8,
    innerDiameter: p.lumenDia,
    height: 16,
    segments: 48,
    material: CAD.materials.brushedSteel(),
    name: 'tubing_barb'
  });
  stem.position.y = 14;
  group.add(stem);

  for (let i = 0; i < p.barbRidges; i++) {
    const ridge = CAD.pipe({
      outerDiameter: p.barbOuterDia,
      innerDiameter: p.lumenDia,
      height: 2.4,
      segments: 48,
      material: CAD.materials.brushedSteel(),
      name: 'barb_ridge_' + (i + 1)
    });
    ridge.position.y = 16 + i * 4.2;
    group.add(ridge);
  }
  return group;
}`,
  'cad-surgical-endoscopic-trocar': `
const PARAMS = {
  instrumentBore: 12.5,
  cannulaLength: 95,
  sealHousingDia: 44,
  obturatorOffset: 0
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const cannula = CAD.pipe({
    outerDiameter: 15.0,
    innerDiameter: p.instrumentBore,
    height: p.cannulaLength,
    segments: 48,
    material: CAD.materials.frostedGlass(0x94a3b8, 0.65),
    name: 'cannula_tube'
  });
  group.add(cannula);

  const sealHousing = CAD.pipe({
    outerDiameter: p.sealHousingDia,
    innerDiameter: p.instrumentBore,
    height: 32,
    segments: 64,
    material: CAD.materials.mattePlastic(0x1e293b),
    name: 'seal_housing'
  });
  sealHousing.position.y = p.cannulaLength;
  group.add(sealHousing);

  const sidePort = CAD.pipe({
    outerDiameter: 8,
    innerDiameter: 4,
    height: 24,
    segments: 32,
    material: CAD.materials.machinedBrass(),
    name: 'insufflation_valve'
  });
  sidePort.rotation.z = -Math.PI / 2;
  sidePort.position.set(p.sealHousingDia / 2, p.cannulaLength + 14, 0);
  group.add(sidePort);

  const lever = CAD.roundedBox({
    width: 18,
    height: 4,
    depth: 6,
    radius: 1,
    material: CAD.materials.anodizedAluminum(0x0ea5e9),
    name: 'stopcock_lever'
  });
  lever.position.set(p.sealHousingDia / 2 + 14, p.cannulaLength + 18, 0);
  group.add(lever);

  const obturator = CAD.pipe({
    outerDiameter: 12.0,
    innerDiameter: 0,
    height: p.cannulaLength + 46,
    segments: 36,
    material: CAD.materials.titanium(),
    name: 'obturator_rod'
  });
  obturator.position.y = p.obturatorOffset;
  group.add(obturator);
  return group;
}`,
  'cad-simple-to220-heatsink': `
const PARAMS = {
  heatsinkWidth: 38,
  heatsinkHeight: 42,
  finDepth: 22,
  finCount: 9
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const hw = p.heatsinkWidth / 2;
  const hh = p.heatsinkHeight / 2;
  const base = CAD.extrudeWithHoles({
    outerPoints: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]],
    holes: [{ x: 0, y: 7, radius: 1.6 }],
    depth: 5,
    bevelRadius: 0.6,
    material: CAD.materials.anodizedAluminum(0x1e293b),
    name: 'heatsink_base'
  });
  base.rotation.x = -Math.PI / 2;
  base.position.set(0, hh, 0);
  group.add(base);

  const count = Math.max(3, Math.round(p.finCount));
  for (let i = 0; i < count; i++) {
    const x = -hw + 1 + (i / (count - 1)) * (p.heatsinkWidth - 2);
    const fin = CAD.roundedBox({
      width: 2.0,
      height: p.heatsinkHeight,
      depth: p.finDepth,
      radius: 0.4,
      material: CAD.materials.anodizedAluminum(0x334155),
      name: 'cooling_fin_' + (i + 1)
    });
    fin.position.set(x, 0, p.finDepth / 2 + 2.5);
    group.add(fin);
  }
  return group;
}`,
  'cad-simple-sma-rf-bulkhead': `
const PARAMS = {
  flangeWidth: 12.7,
  barrelHeight: 9.5,
  barrelOuterDia: 6.35,
  holeDia: 2.6
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const hw = p.flangeWidth / 2;
  const hp = 4.3;
  const flange = CAD.extrudeWithHoles({
    outerPoints: [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]],
    holes: [
      { x: -hp, y: -hp, radius: p.holeDia / 2 },
      { x: hp, y: -hp, radius: p.holeDia / 2 },
      { x: hp, y: hp, radius: p.holeDia / 2 },
      { x: -hp, y: hp, radius: p.holeDia / 2 }
    ],
    depth: 2.0,
    bevelRadius: 0.5,
    material: CAD.materials.machinedBrass(),
    name: 'mounting_flange'
  });
  group.add(flange);

  const barrel = CAD.helicalThread({
    diameter: p.barrelOuterDia,
    pitch: 0.7,
    length: p.barrelHeight,
    material: CAD.materials.machinedBrass(),
    name: 'sma_threaded_barrel'
  });
  barrel.position.y = 2.0;
  group.add(barrel);

  const dielectric = CAD.pipe({
    outerDiameter: 4.1,
    innerDiameter: 1.3,
    height: p.barrelHeight,
    segments: 36,
    material: CAD.materials.glossCeramic(0xf8fafc),
    name: 'ptfe_dielectric'
  });
  dielectric.position.y = 2.0;
  group.add(dielectric);

  const pin = CAD.pipe({
    outerDiameter: 1.27,
    innerDiameter: 0,
    height: p.barrelHeight + 4,
    segments: 24,
    material: CAD.materials.copper(),
    name: 'center_conductor'
  });
  pin.position.y = 0;
  group.add(pin);
  return group;
}`,
  'cad-simple-pitot-static-probe': `
const PARAMS = {
  probeLength: 110,
  strutHeight: 60,
  probeOuterDia: 14,
  intakeBore: 4
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const flange = CAD.extrudeWithHoles({
    outerPoints: [[-37, -21], [37, -21], [37, 21], [-37, 21]],
    holes: [
      { x: -26, y: -13, radius: 2.5 },
      { x: 26, y: -13, radius: 2.5 },
      { x: 26, y: 13, radius: 2.5 },
      { x: -26, y: 13, radius: 2.5 }
    ],
    depth: 6,
    bevelRadius: 1.2,
    material: CAD.materials.titanium(),
    name: 'fuselage_flange'
  });
  group.add(flange);

  const mast = CAD.roundedBox({
    width: 32,
    height: p.strutHeight,
    depth: 10,
    radius: 3,
    material: CAD.materials.titanium(),
    name: 'airfoil_mast'
  });
  mast.position.set(0, 6, 0);
  group.add(mast);

  const tube = CAD.pipe({
    outerDiameter: p.probeOuterDia,
    innerDiameter: p.intakeBore,
    height: p.probeLength,
    segments: 48,
    material: CAD.materials.brushedSteel(),
    name: 'pitot_tube'
  });
  tube.rotation.z = -Math.PI / 2;
  tube.position.set(-p.probeLength * 0.35, 6 + p.strutHeight, 0);
  group.add(tube);
  return group;
}`,
  'cad-simple-clevis-rod-end': `
const PARAMS = {
  forkGap: 12,
  pinDia: 10,
  earThickness: 10,
  shankLength: 28
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const shank = CAD.helicalThread({
    diameter: 12,
    pitch: 1.75,
    length: p.shankLength,
    material: CAD.materials.brushedSteel(),
    name: 'threaded_shank'
  });
  group.add(shank);

  const hexCollar = CAD.pipe({
    outerDiameter: 19,
    innerDiameter: 0,
    height: 8,
    segments: 6,
    material: CAD.materials.titanium(),
    name: 'wrench_hex'
  });
  hexCollar.position.y = p.shankLength;
  group.add(hexCollar);

  const yokeBase = CAD.roundedBox({
    width: p.forkGap + p.earThickness * 2,
    height: 10,
    depth: 22,
    radius: 2,
    material: CAD.materials.brushedSteel(),
    name: 'clevis_yoke_base'
  });
  yokeBase.position.y = p.shankLength + 8;
  group.add(yokeBase);

  [-1, 1].forEach((side, idx) => {
    const ear = CAD.roundedBox({
      width: p.earThickness,
      height: 36,
      depth: 22,
      radius: 3,
      material: CAD.materials.brushedSteel(),
      name: idx === 0 ? 'clevis_fork_left' : 'clevis_fork_right'
    });
    ear.position.set(side * (p.forkGap / 2 + p.earThickness / 2), p.shankLength + 16, 0);
    group.add(ear);
  });

  const pin = CAD.pipe({
    outerDiameter: p.pinDia,
    innerDiameter: 0,
    height: p.forkGap + p.earThickness * 2 + 12,
    segments: 36,
    material: CAD.materials.machinedBrass(),
    name: 'clevis_pin'
  });
  pin.rotation.z = -Math.PI / 2;
  pin.position.set(-(p.forkGap / 2 + p.earThickness + 6), p.shankLength + 36, 0);
  group.add(pin);
  return group;
}`,
  'cad-high-pressure-ball-valve': `
const PARAMS = {
  flowBore: 50,
  flangeOuterDia: 110,
  handleAngle: 0,
  handleLength: 135
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const body = CAD.pipe({
    outerDiameter: 86,
    innerDiameter: p.flowBore,
    height: 56,
    segments: 8,
    material: CAD.materials.brushedSteel(),
    name: 'valve_body'
  });
  body.rotation.z = -Math.PI / 2;
  body.position.set(-28, 55, 0);
  group.add(body);

  [-40, 28].forEach((xPos, idx) => {
    const endFlange = CAD.boltCircleFlange({
      outerDiameter: p.flangeOuterDia,
      boreDiameter: p.flowBore,
      thickness: 14,
      boltCircleDiameter: 85,
      boltCount: 4,
      boltDiameter: 12,
      material: CAD.materials.titanium(),
      name: idx === 0 ? 'inlet_end_flange' : 'outlet_end_flange'
    });
    endFlange.rotation.z = -Math.PI / 2;
    endFlange.position.set(xPos, 55, 0);
    group.add(endFlange);
  });

  const ball = CAD.pipe({
    outerDiameter: 68,
    innerDiameter: p.flowBore,
    height: 44,
    segments: 48,
    material: CAD.materials.machinedBrass(),
    name: 'floating_ball'
  });
  ball.rotation.z = -Math.PI / 2;
  ball.position.set(-22, 55, 0);
  group.add(ball);

  const stem = CAD.pipe({
    outerDiameter: 16,
    innerDiameter: 0,
    height: 36,
    segments: 32,
    material: CAD.materials.brushedSteel(),
    name: 'valve_stem'
  });
  stem.position.set(0, 90, 0);
  group.add(stem);

  const lever = CAD.roundedBox({
    width: p.handleLength,
    height: 8,
    depth: 18,
    radius: 3,
    material: CAD.materials.anodizedAluminum(0xef4444),
    name: 'lever_handle'
  });
  lever.position.set(p.handleLength * 0.38, 124, 0);
  lever.rotation.y = (p.handleAngle * Math.PI) / 180;
  group.add(lever);
  return group;
}`,
  'cad-cycloidal-speed-reducer': `
const PARAMS = {
  housingOuterDia: 128,
  ringPinCount: 12,
  eccentricity: 3.0,
  outputPinCount: 6
};
function buildModel(THREE, params, CAD) {
  const p = Object.assign({}, PARAMS, params || {});
  const group = new THREE.Group();
  const housing = CAD.boltCircleFlange({
    outerDiameter: p.housingOuterDia,
    boreDiameter: 100,
    thickness: 28,
    boltCircleDiameter: 114,
    boltCount: 8,
    boltDiameter: 6.5,
    material: CAD.materials.anodizedAluminum(0x1e293b),
    name: 'ring_pin_housing'
  });
  group.add(housing);

  for (let i = 0; i < p.ringPinCount; i++) {
    const ang = (i / p.ringPinCount) * Math.PI * 2;
    const pin = CAD.pipe({
      outerDiameter: 8,
      innerDiameter: 0,
      height: 26,
      segments: 24,
      material: CAD.materials.brushedSteel(),
      name: 'ring_roller_pin_' + (i + 1)
    });
    pin.position.set(Math.cos(ang) * 48, 2, Math.sin(ang) * 48);
    group.add(pin);
  }

  const disc = CAD.spurGear({
    teeth: Math.max(8, p.ringPinCount - 1),
    module: 6.8,
    thickness: 12,
    boreDiameter: 28,
    lighteningHoles: p.outputPinCount,
    material: CAD.materials.machinedBrass(),
    name: 'cycloidal_disc'
  });
  disc.position.set(p.eccentricity, 8, 0);
  group.add(disc);

  const shaft = CAD.pipe({
    outerDiameter: 20,
    innerDiameter: 0,
    height: 44,
    segments: 36,
    material: CAD.materials.titanium(),
    name: 'eccentric_input_shaft'
  });
  group.add(shaft);
  return group;
}`,
};

module.exports = {
  CAD_SYSTEM_PROMPT,
  CAD_SYSTEM_PRIMER: CAD_CONTRACT_INSTRUCTIONS,
  CAD_CONTRACT_INSTRUCTIONS,
  CAD_CONTRACT_HEADER,
  CAD_REFERENCE_SOLUTIONS,
  isCadTask,
  wrapTaskForCadArena,
  sanitizeTelemetry,
  formatCadTelemetrySummary,
  parseDataUrlToAttachment,
  parseParamsFromCode,
  buildCadModifyMessages,
  buildCadPromptAugmentation: buildCadModifyMessages,
  transpileToFusion360Python,
  generateFusion360PythonScript: transpileToFusion360Python,
  getCadMcpStatus,
};
