'use strict';

/**
 * 3D & CAD Engineering Arena Verification Suite (v1.0.49)
 * Verifies Phase 1, Phase 2, and Phase 3 of the 3D & CAD Arena:
 *   1. Top-level 🧊 3D & CAD Arena tab (#modeBtn3d), ?tab=3d URL routing, and #cadModifyBar UI
 *   2. 6 curated 3D & CAD benchmark tasks (prompts/80..85) and reference solution execution
 *   3. Parametric CAD/CSG solid kernel (public/cad-kernel.js) + manifold telemetry + STEP AP214 export
 *   4. Lockstep synced 3D camera across Slots A, B, C, D ON by default with unlink toggle
 *   5. Follow-up modification loop with automatic 4-angle viewport vision input (Iso/Front/Top/Right)
 *   6. Multimodal 3D blind judge telemetry + 4-view vision & Autodesk Fusion 360 MCP bridge
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-compare-3d-test-'));
process.env.AUTH_DATA_DIR = tmpDir;
process.env.APP_DATA_DIR = tmpDir;

const { TASKS } = require('../src/tasks');
const {
  isCadTask,
  CAD_SYSTEM_PRIMER,
  CAD_REFERENCE_SOLUTIONS,
  buildCadModifyMessages,
  transpileToFusion360Python,
  getCadMcpStatus,
} = require('../src/cadArena');
const { buildPrompt } = require('../src/judge');

function httpRequest(port, method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('=== Running 3D & CAD Engineering Arena Verification Suite (v1.0.49) ===');

  const rootDir = path.join(__dirname, '..');
  const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'public', 'app.js'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(rootDir, 'public', 'styles.css'), 'utf8');
  const cadRunnerHtml = fs.readFileSync(path.join(rootDir, 'public', 'cad-runner.html'), 'utf8');
  const cadStepWorkerJs = fs.readFileSync(path.join(rootDir, 'public', 'cad-step-worker.js'), 'utf8');

  // ---------------------------------------------------------------------------
  // 1. Top-level 3D & CAD Arena Tab, Modification Studio & Fusion 360 MCP Modal
  // ---------------------------------------------------------------------------
  assert(
    indexHtml.includes('id="modeBtn3d"') && indexHtml.includes('data-arena-mode="3d"') && indexHtml.includes('3D &amp; CAD Arena'),
    'index.html must include #modeBtn3d top-level 3D & CAD Arena tab button'
  );
  assert(indexHtml.includes('id="cadModifyBar"'), 'index.html must include #cadModifyBar follow-up modification studio');
  assert(
    indexHtml.includes('id="cadSyncCamBtn"') && indexHtml.includes('aria-pressed="true"') && indexHtml.includes('Synced Camera: ON'),
    'index.html must include #cadSyncCamBtn defaulted to ON (aria-pressed="true")'
  );
  assert(
    indexHtml.includes('id="cadSpinBtn"') &&
      indexHtml.includes('Iso + Spin: ON') &&
      indexHtml.includes('id="cadSpin3AxisBtn"') &&
      indexHtml.includes('3-Axis Spin: OFF') &&
      !indexHtml.includes('<option value="all">📦 All Parts'),
    'index.html must include #cadSpinBtn defaulted to ON (Iso + Spin), #cadSpin3AxisBtn defaulted to OFF, and #subcategorySelect with only Simple and Complex options (no All Parts)'
  );
  assert(
    cadRunnerHtml.includes('id="hudSpinBtn"') &&
      cadRunnerHtml.includes('id="hudSpin3AxisBtn"') &&
      cadRunnerHtml.includes('let turntableEnabled = true;') &&
      cadRunnerHtml.includes('let spin3AxisEnabled = false;') &&
      cadRunnerHtml.includes('class="hud-top-stack"'),
    'cad-runner.html must default to Iso + Spin (turntableEnabled = true, spin3AxisEnabled = false) and non-overlapping .hud-top-stack layout'
  );
  assert(
    appJs.includes('let CAD_TURNTABLE_ON = true;') &&
      appJs.includes('let CAD_SPIN_3AXIS_ON = false;') &&
      !appJs.includes('Simple · ${complexCount} Complex'),
    'public/app.js must default CAD_TURNTABLE_ON = true and CAD_SPIN_3AXIS_ON = false and omit (x Simple - y Complex) counts from category labels'
  );
  assert(
    indexHtml.includes('id="cadIncludeVisionToggle" checked') && indexHtml.includes('Auto-Attach 4-View Render'),
    'index.html must include #cadIncludeVisionToggle checked by default for automatic 4-angle vision input'
  );
  assert(indexHtml.includes('id="cadMcpModal"'), 'index.html must include #cadMcpModal for Autodesk Fusion 360 / Headless CAD MCP bridge');
  assert(stylesCss.includes('.cad-modify-bar') && stylesCss.includes('.cad-viz-wrap'), 'styles.css must define 3D & CAD Arena styles');
  console.log('✓ 1. Top-level 3D & CAD Arena tab, #cadModifyBar, #cadSyncCamBtn, #cadSpin3AxisBtn, and .hud-top-stack verified');

  // ---------------------------------------------------------------------------
  // 2. 30 Curated Manufacturing & CAD Engineering Tasks Across 6 Industry Verticals
  //    (14 Simple Parts + 16 Complex Parts, Natural Text Prompts, Zero JS)
  // ---------------------------------------------------------------------------
  const expectedCadTaskIds = [
    // Automotive & Powertrain (3 simple + 4 complex = 7)
    'cad-simple-pulley-sheave',
    'cad-simple-stepped-shaft',
    'cad-simple-spur-gear',
    'cad-planetary-gearbox',
    'cad-injection-mold-fan-shroud',
    'cad-diecast-ev-inverter-housing',
    'cad-forged-connecting-rod',
    // Medical & Biotech (2 simple + 2 complex = 4)
    'cad-simple-cortical-bone-screw',
    'cad-simple-luer-lock-adapter',
    'cad-medical-titanium-bone-plate',
    'cad-surgical-endoscopic-trocar',
    // Electronics, Thermal & Semiconductor (2 simple + 3 complex = 5)
    'cad-simple-to220-heatsink',
    'cad-simple-sma-rf-bulkhead',
    'cad-enclosure-snapfit',
    'cad-sheetmetal-server-chassis',
    'cad-semiconductor-wafer-chuck',
    // Aerospace & Turbomachinery (2 simple + 2 complex = 4)
    'cad-simple-pitot-static-probe',
    'cad-simple-clevis-rod-end',
    'cad-turbo-impeller',
    'cad-additive-lattice-heatsink',
    // Robotics & Motion Control (2 simple + 2 complex = 4)
    'cad-simple-flanged-bushing',
    'cad-simple-pillow-block',
    'cad-robotic-gripper',
    'cad-cycloidal-speed-reducer',
    // Industrial Hardware, Piping & Tooling (3 simple + 3 complex = 6)
    'cad-simple-hex-bolt-nut',
    'cad-simple-l-bracket',
    'cad-simple-pipe-flange',
    'cad-architectural-pavilion',
    'cad-cnc-manifold-block',
    'cad-high-pressure-ball-valve',
  ];
  const cadTasks = TASKS.filter((t) => t.category === 'cad3d');
  assert(!cadTasks.some((t) => t.id === 'cad-spur-gear-vase'), 'Fusion 360 spur-gear-vase test benchmark must be removed');
  assert.strictEqual(cadTasks.length, 30, `TASKS must include all 30 curated cad3d manufacturing tasks across 6 verticals (got ${cadTasks.length})`);

  const simpleTasks = cadTasks.filter((t) => t.subcategory === 'simple');
  const complexTasks = cadTasks.filter((t) => t.subcategory === 'complex');
  assert.strictEqual(simpleTasks.length, 14, `Expected 14 simple parts (1. Simple Parts), got ${simpleTasks.length}`);
  assert.strictEqual(complexTasks.length, 16, `Expected 16 complex parts (2. Complex Parts), got ${complexTasks.length}`);

  const expectedVerticalCounts = {
    automotive: 7,
    medical: 4,
    electronics: 5,
    aerospace: 4,
    robotics: 4,
    industrial: 6,
  };
  for (const [vert, expectedCount] of Object.entries(expectedVerticalCounts)) {
    const vertTasks = cadTasks.filter((t) => t.vertical === vert);
    assert.strictEqual(vertTasks.length, expectedCount, `Vertical "${vert}" must have ${expectedCount} tasks (got ${vertTasks.length})`);
    assert(vertTasks.some((t) => t.subcategory === 'simple'), `Vertical "${vert}" must include simple parts`);
    assert(vertTasks.some((t) => t.subcategory === 'complex'), `Vertical "${vert}" must include complex parts`);
  }

  for (const id of expectedCadTaskIds) {
    const t = cadTasks.find((x) => x.id === id);
    assert(t, `Missing cad3d task: ${id}`);
    assert.strictEqual(t.visualizer, 'cad3d', `Task ${id} must have visualizer: "cad3d"`);
    assert.strictEqual(t.language, 'javascript', `Task ${id} must have language: "javascript"`);
    assert(isCadTask(t), `isCadTask() must return true for ${id}`);
    assert(
      !/\bCAD\.|\bTHREE\.|\bbuildModel\s*\(|\bPARAMS\b|\bPARAM_SCHEMA\b/.test(t.prompt),
      `Task ${id} user-facing prompt must be pure mechanical/manufacturing English with zero JavaScript code`
    );
    assert(CAD_REFERENCE_SOLUTIONS[id] && CAD_REFERENCE_SOLUTIONS[id].includes('function buildModel'), `CAD_REFERENCE_SOLUTIONS[${id}] must include buildModel`);
  }

  // Verify 3-Axis Spin rotates gridGroup (origin build surface) alongside modelRoot
  assert(
    cadRunnerHtml.includes('gridGroup.rotation.copy(modelRoot.rotation)') &&
      cadRunnerHtml.includes('gridGroup.position.copy(modelRoot.position)'),
    'cad-runner.html must rotate gridGroup (origin build surface) in lockstep with modelRoot during 3-Axis Spin'
  );

  // Dynamically load Three.js + public/cad-kernel.js in Node and execute all 30 reference solutions!
  const THREE = await import('three');
  const cadKernelPath = path.join(rootDir, 'public', 'cad-kernel.js');
  const cadKernelMod = await import('file://' + cadKernelPath);
  const { createCadKernel, analyzeModelTelemetry, collectStepMeshes, exportModelToSTEP } = cadKernelMod;
  const { CAD, CSG } = createCadKernel(THREE);

  for (const t of cadTasks) {
    const refCode = CAD_REFERENCE_SOLUTIONS[t.id];
    const fn = new Function('THREE', 'CAD', 'CSG', `${refCode}\nreturn buildModel;`)(THREE, CAD, CSG);
    assert.strictEqual(typeof fn, 'function', `Reference solution for ${t.id} must compile to a buildModel function`);
    const root = fn(THREE, {}, CAD);
    assert(root && root.isObject3D, `buildModel for ${t.id} must return a THREE.Object3D / THREE.Group`);
    const telem = analyzeModelTelemetry(root, THREE);
    assert(telem.partCount >= 1, `Task ${t.id} reference model must have >= 1 named part (got ${telem.partCount})`);
    assert(telem.triangleCount >= 50, `Task ${t.id} reference model must have >= 50 triangles (got ${telem.triangleCount})`);
    assert.strictEqual(telem.watertight, true, `Task ${t.id} reference model must be watertight`);
    assert(telem.volumeCm3 > 0.05, `Task ${t.id} reference model must have positive solid volume in cm^3 (got ${telem.volumeCm3})`);
  }

  // Verify hybrid Mesh/BufferGeometry duality (passing CAD.* result to group.add OR new THREE.Mesh)
  const testGroup = new THREE.Group();
  const directPart = CAD.spurGear({ teeth: 18, module: 2, thickness: 8 }); // no material arg passed!
  directPart.position.set(10, 0, 0);
  testGroup.add(directPart);
  const wrappedPart = new THREE.Mesh(CAD.pipe({ outerDiameter: 20, innerDiameter: 10, height: 15, material: CAD.materials.brass() }), CAD.materials.copper());
  testGroup.add(wrappedPart);
  const hybridTelem = analyzeModelTelemetry(testGroup, THREE);
  assert.strictEqual(hybridTelem.partCount, 2, 'Hybrid Mesh/BufferGeometry duality must support both direct group.add(CAD.*) and new THREE.Mesh(CAD.*, mat)');
  assert.strictEqual(hybridTelem.watertight, true, 'Hybrid Mesh/BufferGeometry parts must be watertight');

  // Test CSG Boolean subtract + STEP AP214 export
  const outerBox = CAD.roundedBox({ width: 40, height: 20, depth: 30, radius: 3, name: 'outer_box' });
  const centerBore = CAD.pipe({ outerDiameter: 12, innerDiameter: 0, height: 24, name: 'bore_cut' });
  const csgMesh = CSG.subtract(outerBox, centerBore, CAD.materials.brushedSteel());
  const csgTelem = analyzeModelTelemetry(csgMesh, THREE);
  // Review 4.8: CSG.* booleans are approximate (AABB / inscribed-cylinder culls), so the
  // kernel now labels their output instead of reporting it as a verified closed shell.
  assert.strictEqual(csgTelem.csgApprox, true, 'CSG.subtract result must be flagged csgApprox (approximate boolean)');
  assert(typeof csgTelem.watertight === 'boolean' || csgTelem.watertight === null, 'watertight is a real edge-manifold verdict (boolean) or null when skipped');
  assert.strictEqual(typeof csgTelem.nonManifoldEdges, 'number', 'telemetry reports the non-manifold edge count');
  assert(csgTelem.volumeCm3 > 1, 'CSG.subtract volume must be positive');

  const stepText = exportModelToSTEP(csgMesh, { productName: 'CSG_Test_Block' });
  assert(stepText.startsWith('ISO-10303-21;') && stepText.includes('AUTOMOTIVE_DESIGN') && stepText.trim().endsWith('END-ISO-10303-21;'), 'exportModelToSTEP must output valid ISO-10303-21 STEP AP214 structure');
  const polyLoopMatch = stepText.match(/POLY_LOOP\('',\(#(\d+),#(\d+),#(\d+)\)\)/);
  assert(polyLoopMatch, 'STEP output must include POLY_LOOP entities');
  assert(stepText.includes(`#${polyLoopMatch[1]} = CARTESIAN_POINT(`), 'POLY_LOOP must reference CARTESIAN_POINT IDs (not VERTEX_POINT IDs)');
  assert(cadStepWorkerJs.includes('ISO-10303-21;') && cadStepWorkerJs.includes('STEP_EXPORT_DONE'), 'public/cad-step-worker.js must handle Web Worker STEP generation');

  // Verify Three.js Y-up (X right, Y top, Z front) -> Fusion 360 Z-up (X right, Y = -Z_three, Z = +Y_three)
  // so the Top view of the Three.js render maps to the Top view of Fusion 360 on the X-Y origin plane.
  const zUpProbeGroup = new THREE.Group();
  const zUpProbeGeom = new THREE.BufferGeometry();
  zUpProbeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    10, 50, 20,
    15, 50, 20,
    10, 50, 25,
  ]), 3));
  const zUpProbeMesh = new THREE.Mesh(zUpProbeGeom, CAD.materials.aluminum());
  zUpProbeMesh.name = 'top_probe_surface';
  zUpProbeGroup.add(zUpProbeMesh);
  const zUpMeshes = collectStepMeshes(zUpProbeGroup);
  assert.strictEqual(zUpMeshes.length, 1, 'collectStepMeshes must extract the probe mesh');
  assert.deepStrictEqual(
    Array.from(zUpMeshes[0].positions),
    [10, -20, 50, 15, -20, 50, 10, -25, 50],
    'collectStepMeshes must rotate Three.js Y-up (x, y, z) to Fusion 360 Z-up (x, -z, y) by default so Three.js Top (+Y) becomes Fusion 360 Top (+Z)'
  );
  const zUpStep = exportModelToSTEP(zUpProbeGroup, { productName: 'ZUp_Probe' });
  assert(
    zUpStep.includes("CARTESIAN_POINT('',(10,-20,50))") &&
    zUpStep.includes("CARTESIAN_POINT('',(15,-20,50))") &&
    zUpStep.includes("CARTESIAN_POINT('',(10,-25,50))"),
    'exportModelToSTEP must write Fusion 360 Z-up coordinates (X=x, Y=-z, Z=y) into STEP CARTESIAN_POINT entities'
  );
  assert(
    cadRunnerHtml.includes('function withZUpCadPose(') &&
    cadRunnerHtml.includes('modelRoot.rotation.set(Math.PI / 2, 0, 0)'),
    'public/cad-runner.html must rotate STL exports by +90° around X (withZUpCadPose) so STL downloads also match Fusion 360 Z-up Top orientation'
  );
  console.log('✓ 2. All 30 3D & CAD benchmark reference models across 6 industry verticals (14 Simple + 16 Complex), hybrid Mesh/BufferGeometry duality, CSG Boolean operations, and ISO-10303-21 STEP Z-up Fusion 360 orientation verified');

  // ---------------------------------------------------------------------------
  // 3. Lockstep Camera Sync (ON by default) & Automatic 4-Angle Vision Loop
  // ---------------------------------------------------------------------------
  assert(appJs.includes('let CAD_CAMERA_SYNC_ON = true;'), 'public/app.js must initialize CAD_CAMERA_SYNC_ON = true by default');
  assert(
    appJs.includes("msg.type === 'CAD_CAMERA_CHANGE'") &&
    appJs.includes("type: 'CAD_APPLY_CAMERA'"),
    'public/app.js must relay CAD_CAMERA_CHANGE from any slot to all sibling slots via CAD_APPLY_CAMERA when synced'
  );
  assert(
    cadRunnerHtml.includes("type: 'CAD_CAMERA_CHANGE'") &&
    cadRunnerHtml.includes("msg.type === 'CAD_APPLY_CAMERA'") &&
    cadRunnerHtml.includes('captureFourAngleCompositeDataUrl'),
    'public/cad-runner.html must emit CAD_CAMERA_CHANGE on OrbitControls change, apply CAD_APPLY_CAMERA, and render 4-angle (Iso/Front/Top/Right) composite snapshots'
  );
  assert(
    appJs.includes('await Promise.all(activeSlots.map((m) => requestFresh4ViewFromSlot(m.slot, 1800)));') &&
    appJs.includes('fourViewDataUrl: includeVision && st.fourViewDataUrl ? st.fourViewDataUrl : null'),
    'runCadModification() must automatically capture and attach each slot\'s 4-angle viewport composite PNG (fourViewDataUrl) as a vision input'
  );
  console.log('✓ 3. Lockstep 3D camera sync across Slots A, B, C, D (ON by default + unlink toggle) and automatic 4-View vision attachment verified');

  // ---------------------------------------------------------------------------
  // 4. CAD Follow-up Prompt Augmentation, Blind Judge & Fusion 360 MCP Script
  // ---------------------------------------------------------------------------
  assert(CAD_SYSTEM_PRIMER.includes('buildModel(THREE, params, CAD)') && !CAD_SYSTEM_PRIMER.includes('buildModel(THREE, CAD, params)'), 'CAD_SYSTEM_PRIMER must specify the buildModel(THREE, params, CAD) contract (the order the runtime and reference solutions use)');
  const samplePngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const modMessages = buildCadModifyMessages({
    originalPrompt: cadTasks[0].prompt,
    previousCode: 'function buildModel(THREE, CAD, params) { return new THREE.Group(); }',
    modificationPrompt: 'Make the vase body watertight and widen the top rim to 68 mm',
    targetPart: 'spline_vase_body',
    telemetry: {
      watertight: true,
      partCount: 3,
      partNames: ['spur_gear_base', 'threaded_boss', 'spline_vase_body'],
      vertexCount: 400,
      triangleCount: 200,
      boundingBoxMm: [78, 154, 78],
      volumeCm3: 45.2,
    },
    fourViewDataUrl: samplePngDataUrl,
    slot: 'A',
  });
  assert(Array.isArray(modMessages) && modMessages.length === 1, 'buildCadModifyMessages must return 1 user message');
  const modMsg = modMessages[0];
  assert(modMsg.content.includes('FOLLOW-UP 3D MODIFICATION REQUEST'), 'buildCadModifyMessages must include follow-up modification section');
  assert(modMsg.content.includes('@spline_vase_body'), 'buildCadModifyMessages must highlight targeted @part_name');
  assert(modMsg.content.includes('4-Angle Viewport Render (ISOMETRIC, FRONT +Z, TOP +Y, RIGHT +X)'), 'buildCadModifyMessages must instruct the model to inspect the attached 4-view render');
  assert(Array.isArray(modMsg.attachments) && modMsg.attachments.some((a) => a.name === 'slot-A-4view-render.png' && a.kind === 'image'), 'buildCadModifyMessages must attach slot-A-4view-render.png image');

  // Verify Blind Judge prompt includes 3D CAD evaluation rubric when cadTelemetry is present
  const judgePrompt = buildPrompt(
    { title: 'Spur Gear Vase', category: 'cad3d', prompt: 'Build a gear vase' },
    [
      {
        id: 'A',
        text: 'function buildModel(THREE) {}',
        cadTelemetry: {
          watertight: true,
          partCount: 3,
          partNames: ['spur_gear_base', 'threaded_boss', 'spline_vase_body'],
          triangleCount: 4200,
          vertexCount: 2100,
          boundingBoxMm: [78, 154, 78],
          volumeCm3: 84.0,
        },
        hasFourViewRender: true,
      },
      {
        id: 'B',
        text: 'function buildModel(THREE) {}',
        cadTelemetry: {
          watertight: false,
          partCount: 1,
          partNames: ['mesh_1'],
          triangleCount: 600,
          vertexCount: 300,
          boundingBoxMm: [50, 50, 50],
          volumeCm3: 12.0,
        },
        hasFourViewRender: true,
      },
    ]
  );
  assert(judgePrompt.includes('3D & CAD ENGINEERING EVALUATION RUBRIC'), 'buildPrompt() must include the 3D & CAD Engineering Evaluation Rubric for cad3d runs');
  assert(judgePrompt.includes('Watertight=YES'), 'buildPrompt() must include each slot\'s watertight manifold telemetry');

  // Verify Fusion 360 Python script generator
  const f360Py = transpileToFusion360Python({
    title: 'PlanetaryGearbox_Slot_A',
    slot: 'A',
    params: { module: 2.5, sunTeeth: 16, gearFaceWidth: 16 },
    code: CAD_REFERENCE_SOLUTIONS['cad-planetary-gearbox'],
    telemetry: { partCount: 5, watertight: true, boundingBoxMm: [140, 16, 140] },
  });
  assert(f360Py.includes('import adsk.core, adsk.fusion, adsk.cam, traceback, math'), 'Fusion 360 script must import adsk.core and adsk.fusion');
  assert(f360Py.includes('comp.meshBodies.add') && f360Py.includes('MillimeterMeshUnit'), 'Fusion 360 script must import per-part STL meshes via comp.meshBodies.add with MillimeterMeshUnit');
  assert(f360Py.includes('comp.xYConstructionPlane'), 'Fusion 360 script fallback sketch must use comp.xYConstructionPlane (Z-up Top origin plane)');
  assert(f360Py.includes('extrudes.addSimple'), 'Fusion 360 script must generate native Fusion 360 solid extrusions');
  const mcpStatus = getCadMcpStatus();
  assert(mcpStatus.ok && Array.isArray(mcpStatus.capabilities) && mcpStatus.capabilities.includes('step-ap214-export'), 'getCadMcpStatus() must report capabilities');
  console.log('✓ 4. CAD follow-up prompt augmentation, blind 3D judge telemetry rubric, and Fusion 360 Python API generator verified');

  // ---------------------------------------------------------------------------
  // 5. Spawned HTTP Server Smoke Checks (/vendor/three/*, /cad-runner.html, /api/cad-mcp/*)
  // ---------------------------------------------------------------------------
  const port = 18909;
  const cadEnv = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    AUTH_DATA_DIR: tmpDir,
    APP_DATA_DIR: tmpDir,
    GLOBAL_KEYS_ENABLED: '0',
  };
  // Never inherit the Cloud Run / sidecar markers: K_SERVICE disables the loopback
  // auto-admin these checks rely on and ANTIGRAVITY_SIDECAR_WEB_PORT overrides PORT,
  // so the suite would bind the wrong port in the sidecar environment (review 12.4).
  delete cadEnv.K_SERVICE; delete cadEnv.ANTIGRAVITY_SIDECAR_WEB_PORT; delete cadEnv.LOCAL_AUTO_AUTH;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: rootDir,
    env: cadEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 8000);
      child.stdout.on('data', (d) => {
        if (String(d).includes('primary URL')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('Server exited early with code ' + code));
      });
    });

    const rThree = await httpRequest(port, 'GET', '/vendor/three/three.module.js');
    assert.strictEqual(rThree.status, 200, 'GET /vendor/three/three.module.js must return 200');
    assert(rThree.text.includes('WebGLRenderer') || rThree.text.includes('PerspectiveCamera'), 'three.module.js must contain Three.js exports');

    const rRunner = await httpRequest(port, 'GET', '/cad-runner.html?slot=A');
    assert.strictEqual(rRunner.status, 200, 'GET /cad-runner.html must return 200');
    assert(rRunner.text.includes('/vendor/three/build/three.module.js') || rRunner.text.includes('/vendor/three/three.module.js'), 'cad-runner.html must import Three.js from /vendor/three/');

    const rKernel = await httpRequest(port, 'GET', '/cad-kernel.js');
    assert.strictEqual(rKernel.status, 200, 'GET /cad-kernel.js must return 200');

    const rProxy = await httpRequest(port, 'GET', '/fusion-mcp-cors-proxy.py');
    assert.strictEqual(rProxy.status, 200, 'GET /fusion-mcp-cors-proxy.py must return 200 before auth gate');
    assert(rProxy.text.includes('#!/usr/bin/env python3') && !rProxy.text.includes('<title>Sign in'), '/fusion-mcp-cors-proxy.py must return valid Python script, never login HTML');

    const rMacSh = await httpRequest(port, 'GET', '/cad-mcp-mac-install.sh');
    assert.strictEqual(rMacSh.status, 200, 'GET /cad-mcp-mac-install.sh must return 200 before auth gate');

    const rMcp = await httpRequest(port, 'POST', '/api/cad-mcp/fusion360-script', {
      title: 'TestGear_Slot_A',
      code: CAD_REFERENCE_SOLUTIONS['cad-planetary-gearbox'],
      telemetry: { partCount: 5, watertight: true, boundingBoxMm: [140, 16, 140] },
    });
    assert.strictEqual(rMcp.status, 200, 'POST /api/cad-mcp/fusion360-script must return 200');
    const mcpJson = JSON.parse(rMcp.text);
    assert(mcpJson.ok && mcpJson.script.includes('adsk.fusion'), '/api/cad-mcp/fusion360-script must return Fusion 360 script');

    // Verify @google.com admin promotion & revocation via /api/auth/google-admins
    const rPromote = await httpRequest(port, 'POST', '/api/auth/google-admins', {
      email: 'colleague.test@google.com',
    });
    assert.strictEqual(rPromote.status, 200, 'POST /api/auth/google-admins must return 200 for @google.com email');
    const promoteJson = JSON.parse(rPromote.text);
    assert(
      promoteJson.ok && Array.isArray(promoteJson.adminEmails) && promoteJson.adminEmails.includes('colleague.test@google.com'),
      'POST /api/auth/google-admins must add colleague.test@google.com to adminEmails'
    );
    const rRevoke = await httpRequest(port, 'DELETE', '/api/auth/google-admins/colleague.test%40google.com');
    assert.strictEqual(rRevoke.status, 200, 'DELETE /api/auth/google-admins/:email must return 200');
    const revokeJson = JSON.parse(rRevoke.text);
    assert(
      revokeJson.ok && !revokeJson.adminEmails.includes('colleague.test@google.com'),
      'DELETE /api/auth/google-admins/:email must remove colleague.test@google.com from adminEmails'
    );
    console.log('✓ 5. HTTP endpoints (/vendor/three/three.module.js, /cad-runner.html, /cad-kernel.js, /api/cad-mcp/fusion360-script, /api/auth/google-admins) verified');
  } finally {
    child.kill('SIGTERM');
  }

  console.log('\nALL v1.0.49 3D & CAD ARENA CHECKS PASSED!');
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
