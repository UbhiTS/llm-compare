/**
 * LLM Compare - 3D & CAD Arena Web Worker for ISO-10303-21 STEP AP214 Export
 * (public/cad-step-worker.js)
 *
 * Offloads ISO-10303-21; STEP AP214 B-Rep entity serialization from the main WebGL thread
 * so 60 FPS orbit controls remain responsive during export.
 *
 * Protocol (module worker, `new Worker('/cad-step-worker.js', { type: 'module' })`):
 *   in : { type: 'STEP_EXPORT' | 'EXPORT_STEP', reqId, productName, maxFacesPerPart,
 *          meshes: [{ name, positions: Float32Array (9 floats / triangle), csgApprox }] }
 *   out: { type: 'STEP_EXPORT_DONE' | 'EXPORT_STEP_DONE', reqId, ok: true, stepText,
 *          warnings: string[], parts: [{ name, faces, closed, decimated, ... }] }
 *        or { ..., ok: false, error }
 */

import { buildStepExport } from './cad-kernel.js';

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'EXPORT_STEP' && data.type !== 'STEP_EXPORT') return;
  const reqId = data.reqId || 'step-1';
  const replyType = data.type === 'STEP_EXPORT' ? 'STEP_EXPORT_DONE' : 'EXPORT_STEP_DONE';
  try {
    const { stepText, warnings, parts } = buildStepExport(data.meshes || [], {
      productName: data.productName || 'LLM_Compare_CAD_Part',
      maxFacesPerPart: data.maxFacesPerPart || 3500,
      maxTotalFaces: data.maxTotalFaces || undefined,
    });
    self.postMessage({
      type: replyType,
      reqId,
      ok: true,
      stepText,
      warnings,
      parts,
    });
  } catch (err) {
    self.postMessage({
      type: replyType,
      reqId,
      ok: false,
      error: String(err && err.message ? err.message : err),
    });
  }
});
