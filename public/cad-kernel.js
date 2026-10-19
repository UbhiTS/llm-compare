/**
 * LLM Compare - 3D & CAD Arena Solid Modeling Kernel (public/cad-kernel.js)
 *
 * Provides high-precision parametric engineering primitives (CAD.*), boolean CSG
 * surface operations (CSG.*), a Replicad-compatible 2D profile sketcher (CAD.draw),
 * PBR studio materials (CAD.materials), geometry telemetry analyzer
 * (analyzeModelTelemetry, edge-manifold watertight check), and ISO-10303-21 STEP AP214
 * exporter (buildStepExport / exportModelToSTEP, honest CLOSED_SHELL vs OPEN_SHELL labelling).
 *
 * Units: 1 Three.js scene unit = 1.0 millimeter (mm).
 */

export function createCadKernel(THREE) {
  if (!THREE) {
    throw new Error('createCadKernel requires a THREE namespace object.');
  }

  // ---- Build Budget & Cooperative Deadline (watchdog for LLM-generated scripts) ----
  // The runner arms a build with `CAD.__deadline = performance.now() + 20000` and
  // `CAD.__triangleCount = 0` right before calling buildModel (and resets __deadline to
  // Infinity afterwards). While a deadline is armed, the heavy loops below poll it and every
  // geometry that passes through toHybridMesh is charged against a 2M-triangle budget, so a
  // runaway script fails with a clear error instead of freezing the viewport or exhausting
  // GPU memory. Resolution-style inputs (segments, teeth, bolt counts, ...) are additionally
  // clamped to sane upper bounds because Three.js geometry constructors cannot be interrupted.
  const TRIANGLE_BUDGET = 2000000;
  const MAX_PROFILE_POINTS = 4096;
  const nowMs = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  function checkDeadline() {
    if (nowMs() > baseCAD.__deadline) {
      throw new Error('Model build exceeded the 20 s budget');
    }
  }

  function chargeTriangles(geom) {
    const pos = geom && geom.attributes && geom.attributes.position;
    if (!pos) return;
    const tris = geom.index ? Math.floor(geom.index.count / 3) : Math.floor(pos.count / 3);
    baseCAD.__triangleCount = (Number(baseCAD.__triangleCount) || 0) + tris;
    if (Number.isFinite(baseCAD.__deadline) && baseCAD.__triangleCount > TRIANGLE_BUDGET) {
      throw new Error('Model exceeds the 2M triangle budget');
    }
  }

  // Integer clamp with the same NaN/0 fallback semantics as the original `Number(x) || d` code.
  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value) || fallback);
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
  }

  // Subsample an over-long polyline so earcut / LatheGeometry stay bounded.
  function limitPoints(list, maxPoints = MAX_PROFILE_POINTS) {
    if (!Array.isArray(list) || list.length <= maxPoints) return list;
    const stride = Math.ceil(list.length / maxPoints);
    const out = [];
    for (let i = 0; i < list.length; i += stride) out.push(list[i]);
    return out;
  }

  // ---- PBR Studio Materials Library (with Aliases & Proxy Fallback) ----
  function parseColorAndOpts(colorOrOpts, maybeOpts = {}, defaultColor = 0xb8c2cc) {
    if (
      typeof colorOrOpts === 'number' ||
      typeof colorOrOpts === 'string' ||
      (colorOrOpts && colorOrOpts.isColor)
    ) {
      return { ...(maybeOpts || {}), color: colorOrOpts };
    }
    if (colorOrOpts && typeof colorOrOpts === 'object') {
      return { color: colorOrOpts.color ?? defaultColor, ...colorOrOpts };
    }
    return { ...(maybeOpts || {}), color: defaultColor };
  }

  const baseMaterials = {
    brushedSteel(colorOrOpts = {}, maybeOpts = {}) {
      const o = parseColorAndOpts(colorOrOpts, maybeOpts, 0xb8c2cc);
      return new THREE.MeshPhysicalMaterial({
        color: o.color,
        metalness: o.metalness ?? 0.86,
        roughness: o.roughness ?? 0.28,
        clearcoat: o.clearcoat ?? 0.15,
        clearcoatRoughness: 0.25,
        ...o,
      });
    },
    anodizedAluminum(colorOrOpts = 0x3b82f6, maybeOpts = {}) {
      const o = parseColorAndOpts(colorOrOpts, maybeOpts, 0x3b82f6);
      return new THREE.MeshPhysicalMaterial({
        color: o.color,
        metalness: o.metalness ?? 0.72,
        roughness: o.roughness ?? 0.24,
        clearcoat: o.clearcoat ?? 0.35,
        clearcoatRoughness: 0.18,
        ...o,
      });
    },
    machinedBrass(colorOrOpts = {}, maybeOpts = {}) {
      const o = parseColorAndOpts(colorOrOpts, maybeOpts, 0xd4af37);
      return new THREE.MeshPhysicalMaterial({
        color: o.color,
        metalness: o.metalness ?? 0.88,
        roughness: o.roughness ?? 0.22,
        clearcoat: 0.12,
        ...o,
      });
    },
    titanium(colorOrOpts = {}, maybeOpts = {}) {
      const o = parseColorAndOpts(colorOrOpts, maybeOpts, 0x8e959e);
      return new THREE.MeshPhysicalMaterial({
        color: o.color,
        metalness: o.metalness ?? 0.82,
        roughness: o.roughness ?? 0.34,
        ...o,
      });
    },
    copper(colorOrOpts = {}, maybeOpts = {}) {
      const o = parseColorAndOpts(colorOrOpts, maybeOpts, 0xc87533);
      return new THREE.MeshPhysicalMaterial({
        color: o.color,
        metalness: o.metalness ?? 0.90,
        roughness: o.roughness ?? 0.20,
        ...o,
      });
    },
    mattePlastic(colorOrOpts = 0xf97316, maybeOpts = {}) {
      const o = parseColorAndOpts(colorOrOpts, maybeOpts, 0xf97316);
      return new THREE.MeshPhysicalMaterial({
        color: o.color,
        metalness: 0.04,
        roughness: o.roughness ?? 0.52,
        clearcoat: o.clearcoat ?? 0.08,
        ...o,
      });
    },
    glossCeramic(colorOrOpts = 0xf8fafc, maybeOpts = {}) {
      const o = parseColorAndOpts(colorOrOpts, maybeOpts, 0xf8fafc);
      return new THREE.MeshPhysicalMaterial({
        color: o.color,
        metalness: 0.02,
        roughness: o.roughness ?? 0.12,
        clearcoat: 0.85,
        clearcoatRoughness: 0.08,
        ...o,
      });
    },
    frostedGlass(color = 0xe0f2fe, opacity = 0.55, opts = {}) {
      if (color && typeof color === 'object' && !color.isColor) {
        opts = color;
        color = opts.color ?? 0xe0f2fe;
        opacity = opts.opacity ?? 0.55;
      }
      if (opacity && typeof opacity === 'object') {
        opts = opacity;
        opacity = opts.opacity ?? 0.55;
      }
      return new THREE.MeshPhysicalMaterial({
        color: color ?? 0xe0f2fe,
        metalness: 0.0,
        roughness: opts.roughness ?? 0.18,
        transmission: opts.transmission ?? 0.72,
        transparent: true,
        opacity: Number(opacity) || 0.55,
        ior: 1.48,
        thickness: 2.5,
        depthWrite: false,
        ...opts,
      });
    },
    carbonFiber(colorOrOpts = {}, maybeOpts = {}) {
      const o = parseColorAndOpts(colorOrOpts, maybeOpts, 0x1e293b);
      return new THREE.MeshPhysicalMaterial({
        color: o.color,
        metalness: 0.35,
        roughness: 0.32,
        clearcoat: 0.45,
        clearcoatRoughness: 0.2,
        ...o,
      });
    },
    rubberElastomer(colorOrOpts = 0x18181b, maybeOpts = {}) {
      const o = parseColorAndOpts(colorOrOpts, maybeOpts, 0x18181b);
      return new THREE.MeshStandardMaterial({
        color: o.color,
        metalness: 0.02,
        roughness: 0.88,
        ...o,
      });
    },
    oakTimber(colorOrOpts = {}, maybeOpts = {}) {
      const o = parseColorAndOpts(colorOrOpts, maybeOpts, 0xc2925a);
      return new THREE.MeshStandardMaterial({
        color: o.color,
        metalness: 0.04,
        roughness: 0.62,
        ...o,
      });
    },
  };

  // Common material name aliases used by flagship LLMs
  baseMaterials.steel = baseMaterials.brushedSteel;
  baseMaterials.stainlessSteel = baseMaterials.brushedSteel;
  baseMaterials.chrome = (c, o) => baseMaterials.brushedSteel(c, { metalness: 0.96, roughness: 0.1, ...o });
  baseMaterials.castIron = (c = 0x334155, o) => baseMaterials.brushedSteel(c, { metalness: 0.7, roughness: 0.55, ...o });
  baseMaterials.darkSteel = (c = 0x334155, o) => baseMaterials.brushedSteel(c, { metalness: 0.82, roughness: 0.35, ...o });
  baseMaterials.aluminum = baseMaterials.anodizedAluminum;
  baseMaterials.aluminium = baseMaterials.anodizedAluminum;
  baseMaterials.brass = baseMaterials.machinedBrass;
  baseMaterials.bronze = (c = 0xb45309, o) => baseMaterials.machinedBrass(c, o);
  baseMaterials.gold = (c = 0xfbbf24, o) => baseMaterials.machinedBrass(c, { metalness: 0.94, roughness: 0.16, ...o });
  baseMaterials.plastic = baseMaterials.mattePlastic;
  baseMaterials.abs = baseMaterials.mattePlastic;
  baseMaterials.nylon = (c = 0xf1f5f9, o) => baseMaterials.mattePlastic(c, o);
  baseMaterials.peek = (c = 0xd6c7b2, o) => baseMaterials.mattePlastic(c, o);
  baseMaterials.delrin = (c = 0xf8fafc, o) => baseMaterials.mattePlastic(c, { roughness: 0.32, ...o });
  baseMaterials.ptfe = baseMaterials.delrin;
  baseMaterials.ceramic = baseMaterials.glossCeramic;
  baseMaterials.porcelain = baseMaterials.glossCeramic;
  baseMaterials.glass = baseMaterials.frostedGlass;
  baseMaterials.clearGlass = (c = 0xe0f2fe, op = 0.38, o = {}) => baseMaterials.frostedGlass(c, op, { roughness: 0.05, ...o });
  baseMaterials.carbon = baseMaterials.carbonFiber;
  baseMaterials.rubber = baseMaterials.rubberElastomer;
  baseMaterials.elastomer = baseMaterials.rubberElastomer;
  baseMaterials.silicone = (c = 0x38bdf8, o) => baseMaterials.rubberElastomer(c, { roughness: 0.65, ...o });
  baseMaterials.wood = baseMaterials.oakTimber;
  baseMaterials.timber = baseMaterials.oakTimber;

  const materials = new Proxy(baseMaterials, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      // Never look like a thenable / custom-serializable object.
      if (prop === 'then' || prop === 'toJSON' || prop === 'inspect') return undefined;
      const lower = prop.toLowerCase();
      if (lower.includes('alum')) return target.anodizedAluminum;
      if (lower.includes('brass') || lower.includes('bronze') || lower.includes('gold')) return target.machinedBrass;
      if (lower.includes('copper')) return target.copper;
      if (lower.includes('titan')) return target.titanium;
      if (lower.includes('glass') || lower.includes('clear') || lower.includes('lens') || lower.includes('acrylic') || lower.includes('polycarbonate')) return target.frostedGlass;
      if (lower.includes('rubber') || lower.includes('seal') || lower.includes('gasket') || lower.includes('oring') || lower.includes('elastomer') || lower.includes('silicone')) return target.rubberElastomer;
      if (lower.includes('carbon') || lower.includes('graphite')) return target.carbonFiber;
      if (lower.includes('ceramic') || lower.includes('white') || lower.includes('zirconia')) return target.glossCeramic;
      if (lower.includes('wood') || lower.includes('oak') || lower.includes('walnut')) return target.oakTimber;
      if (lower.includes('plastic') || lower.includes('polymer') || lower.includes('nylon') || lower.includes('peek') || lower.includes('resin')) return target.mattePlastic;
      if (lower.includes('steel') || lower.includes('iron') || lower.includes('metal') || lower.includes('chrome')) return target.brushedSteel;
      // No silent brushedSteel default: an unknown material name is a script bug the model
      // (and the auto-fix loop) must see, not something to paper over.
      throw new Error(
        `CAD.materials.${prop} is not a kernel material; available: ${Object.keys(target).join(', ')}`
      );
    },
  });

  function resolveMaterial(mat, fallbackFn = baseMaterials.brushedSteel) {
    if (!mat) return fallbackFn();
    if (typeof mat === 'function') return mat();
    if (typeof mat === 'number' || typeof mat === 'string') return fallbackFn(mat);
    if (mat.isMaterial) return mat;
    if (typeof mat === 'object') return fallbackFn(mat);
    return fallbackFn();
  }

  /**
   * Wraps a BufferGeometry in a THREE.Mesh that ALSO exposes BufferGeometry helper methods
   * (`translate`, `center`, `computeVertexNormals`, `computeBoundingBox`, `attributes`, `index`)
   * AND rotates/scales/clones cleanly whether treated as a Mesh (`group.add(part)`) OR
   * passed as the geometry argument to `new THREE.Mesh(part, mat)`.
   */
  function toHybridMesh(geom, material = null, name = 'cad_part') {
    const safeGeom = geom && geom.isBufferGeometry ? geom : new THREE.BoxGeometry(1, 1, 1);
    checkDeadline();
    chargeTriangles(safeGeom);
    safeGeom.computeVertexNormals();
    safeGeom.computeBoundingBox();
    const mat = resolveMaterial(material);
    const mesh = new THREE.Mesh(safeGeom, mat);
    mesh.name = String(name || 'cad_part');
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // BufferGeometry compatibility methods on the Mesh instance
    mesh.translate = function (x = 0, y = 0, z = 0) {
      this.geometry.translate(Number(x) || 0, Number(y) || 0, Number(z) || 0);
      this.geometry.computeBoundingBox();
      return this;
    };
    mesh.center = function () {
      this.geometry.center();
      this.geometry.computeBoundingBox();
      return this;
    };
    mesh.computeVertexNormals = function () {
      this.geometry.computeVertexNormals();
      return this;
    };
    mesh.computeBoundingBox = function () {
      this.geometry.computeBoundingBox();
      this.boundingBox = this.geometry.boundingBox;
      return this;
    };
    mesh.toNonIndexed = function () {
      return this.geometry.toNonIndexed();
    };
    mesh.dispose = function () {
      if (this.geometry && typeof this.geometry.dispose === 'function') {
        this.geometry.dispose();
      }
    };
    if (!('attributes' in mesh)) {
      Object.defineProperty(mesh, 'attributes', {
        get() {
          return this.geometry ? this.geometry.attributes : {};
        },
        configurable: true,
      });
    }
    if (!('index' in mesh)) {
      Object.defineProperty(mesh, 'index', {
        get() {
          return this.geometry ? this.geometry.index : null;
        },
        configurable: true,
      });
    }
    if (!('morphAttributes' in mesh)) {
      Object.defineProperty(mesh, 'morphAttributes', {
        get() {
          return this.geometry ? this.geometry.morphAttributes : {};
        },
        configurable: true,
      });
    }
    return mesh;
  }

  // Patch THREE.Object3D.prototype.add once so adding a raw BufferGeometry auto-wraps in a Mesh,
  // and adding a Mesh whose `.geometry` is another Mesh/Group unwraps cleanly.
  if (THREE.Object3D && THREE.Object3D.prototype && !THREE.Object3D.prototype._cadPatchedAdd) {
    const origAdd = THREE.Object3D.prototype.add;
    THREE.Object3D.prototype.add = function (...objects) {
      const normalized = objects
        .filter((o) => o != null)
        .map((obj) => {
          if (obj && obj.isBufferGeometry && !obj.isObject3D) {
            const m = new THREE.Mesh(obj, baseMaterials.brushedSteel());
            m.name = obj.name || 'part';
            m.castShadow = true;
            m.receiveShadow = true;
            return m;
          }
          if (obj && obj.isMesh && obj.geometry && obj.geometry.isMesh) {
            const inner = obj.geometry;
            inner.updateMatrix();
            const g = inner.geometry.clone();
            g.applyMatrix4(inner.matrix);
            obj.geometry = g;
            if (!obj.material) obj.material = inner.material;
          } else if (obj && obj.isMesh && obj.geometry && (obj.geometry.isGroup || obj.geometry.isObject3D) && !obj.geometry.isBufferGeometry) {
            const g = extractGeometryAndMatrix(obj.geometry);
            if (g) obj.geometry = g;
          }
          if (obj && obj.isMesh && typeof obj.material === 'function') {
            obj.material = obj.material();
          }
          return obj;
        });
      if (normalized.length === 0) return this;
      return origAdd.apply(this, normalized);
    };
    THREE.Object3D.prototype._cadPatchedAdd = true;
  }

  // ---- Helper: Build Three.js Shape for an Involute / Trapezoidal Spur Gear ----
  function createSpurGearShape({
    teeth = 24,
    module: mod = 2.0,
    pressureAngleDeg = 20,
    boreDiameter = 8,
    dedendumFactor = 1.2,
    addendumFactor = 1.0,
  } = {}) {
    const N = clampInt(teeth, 5, 400, 24);
    const m = Math.max(0.25, Number(mod) || 2.0);
    const alpha = ((Number(pressureAngleDeg) || 20) * Math.PI) / 180;
    const pitchRadius = (N * m) / 2;
    const outerRadius = pitchRadius + addendumFactor * m;
    const rootRadius = Math.max(1.0, pitchRadius - dedendumFactor * m);
    const baseRadius = pitchRadius * Math.cos(alpha);

    const shape = new THREE.Shape();
    const stepAngle = (2 * Math.PI) / N;
    const halfToothPitchAngle = Math.PI / (2 * N);
    const tanAlpha = Math.tan(alpha);
    const invAlpha = tanAlpha - alpha;

    // Angular half-thickness at radius r using involute equation
    function halfAngleAtRadius(r) {
      if (r <= baseRadius) {
        return halfToothPitchAngle + invAlpha;
      }
      const phi = Math.acos(Math.min(1, baseRadius / r));
      const invPhi = Math.tan(phi) - phi;
      return Math.max(0.002, halfToothPitchAngle + invAlpha - invPhi);
    }

    const r1 = rootRadius;
    const r2 = rootRadius + (outerRadius - rootRadius) * 0.35;
    const r3 = rootRadius + (outerRadius - rootRadius) * 0.72;
    const r4 = outerRadius;

    const a1 = halfAngleAtRadius(r1) * 1.04;
    const a2 = halfAngleAtRadius(r2);
    const a3 = halfAngleAtRadius(r3);
    const a4 = halfAngleAtRadius(r4) * 0.85;

    const pts = [];
    for (let i = 0; i < N; i++) {
      const centerAngle = i * stepAngle;
      const rootStartAngle = centerAngle - stepAngle * 0.5;
      const flankLeftAngles = [
        [rootStartAngle, r1],
        [centerAngle - a1, r1],
        [centerAngle - a2, r2],
        [centerAngle - a3, r3],
        [centerAngle - a4, r4],
        [centerAngle + a4, r4],
        [centerAngle + a3, r3],
        [centerAngle + a2, r2],
        [centerAngle + a1, r1],
      ];
      for (const [ang, rad] of flankLeftAngles) {
        pts.push(new THREE.Vector2(Math.cos(ang) * rad, Math.sin(ang) * rad));
      }
    }

    if (pts.length > 0) {
      shape.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        shape.lineTo(pts[i].x, pts[i].y);
      }
      shape.closePath();
    }

    const boreR = Number(boreDiameter) > 0 ? Number(boreDiameter) / 2 : 0;
    if (boreR > 0.1 && boreR < rootRadius - 0.5) {
      const hole = new THREE.Path();
      hole.absarc(0, 0, boreR, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }

    return { shape, pitchRadius, outerRadius, rootRadius, boreRadius: boreR };
  }

  // ---- Orientation helper: ExtrudeGeometry extrudes along +Z [0..depth].
  // Standard CAD convention in LLM Compare: Y-up, with base sitting on Y=0 (or centered).
  function orientZExtrusionToYUp(geom, { centerY = false } = {}) {
    geom.rotateX(-Math.PI / 2);
    geom.computeBoundingBox();
    if (geom.boundingBox) {
      const minY = geom.boundingBox.min.y;
      const maxY = geom.boundingBox.max.y;
      if (centerY) {
        geom.translate(0, -0.5 * (minY + maxY), 0);
      } else if (Math.abs(minY) > 1e-5) {
        geom.translate(0, -minY, 0);
      }
    }
    geom.computeVertexNormals();
    return geom;
  }

  // ---- 1. CAD.spurGear ----
  function spurGear(optsOrTeeth = {}, maybeMod, maybeThick, maybeBore, maybeMat) {
    const opts =
      typeof optsOrTeeth === 'number'
        ? {
            teeth: optsOrTeeth,
            module: maybeMod,
            thickness: maybeThick,
            boreDiameter: maybeBore,
            material: maybeMat,
          }
        : optsOrTeeth || {};

    const teeth = opts.teeth ?? opts.numTeeth ?? opts.toothCount ?? opts.n ?? 24;
    const mod =
      opts.module ??
      opts.mod ??
      opts.m ??
      (opts.pitchDiameter && teeth
        ? Number(opts.pitchDiameter) / Number(teeth)
        : opts.outerDiameter && teeth
        ? Number(opts.outerDiameter) / (Number(teeth) + 2)
        : 2.0);
    const pressureAngleDeg = opts.pressureAngleDeg ?? opts.pressureAngle ?? 20;
    const thickness =
      opts.thickness ?? opts.height ?? opts.width ?? opts.depth ?? opts.faceWidth ?? 10;
    const boreDiameter =
      opts.boreDiameter ??
      opts.bore ??
      (opts.boreRadius != null
        ? Number(opts.boreRadius) * 2
        : opts.innerDiameter ?? (opts.innerRadius != null ? Number(opts.innerRadius) * 2 : 8));
    const hubDiameter =
      opts.hubDiameter ?? (opts.hubRadius != null ? Number(opts.hubRadius) * 2 : 0);
    const hubHeight = opts.hubHeight ?? opts.hubLength ?? opts.hubThickness ?? 0;
    const bevelEnabled = opts.bevelEnabled ?? true;
    const bevelSize = opts.bevelSize ?? 0.25;
    const centerY = Boolean(opts.centerY);
    const material = opts.material ?? null;
    const name = opts.name || 'spur_gear';

    const { shape, rootRadius } = createSpurGearShape({
      teeth,
      module: mod,
      pressureAngleDeg,
      boreDiameter,
    });

    const depth = Math.max(0.5, Number(thickness) || 10);
    const bSize = bevelEnabled ? Math.min(Number(bevelSize) || 0.2, Number(mod) * 0.12) : 0;

    let geom = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: Boolean(bevelEnabled && bSize > 0),
      bevelSegments: 2,
      steps: 1,
      bevelSize: bSize,
      bevelThickness: bSize,
      curveSegments: 16,
    });

    orientZExtrusionToYUp(geom, { centerY });

    if (Number(hubDiameter) > Number(boreDiameter) + 1 && Number(hubHeight) > 0.2) {
      const hubR = Math.min(rootRadius * 0.92, Number(hubDiameter) / 2);
      const hubMesh = pipe({
        outerRadius: hubR,
        innerRadius: Math.max(0, Number(boreDiameter) / 2),
        height: Number(hubHeight),
        radialSegments: 48,
      });
      const hubGeom = hubMesh.geometry.clone();
      hubGeom.translate(0, centerY ? depth / 2 : depth, 0);
      geom = mergeBufferGeometries([geom, hubGeom], THREE);
    }

    return toHybridMesh(geom, material, name);
  }

  // ---- 2. CAD.internalGear (Ring Gear with inward-facing teeth) ----
  function internalGear(optsOrTeeth = {}, maybeMod, maybeThick, maybeRim, maybeMat) {
    const opts =
      typeof optsOrTeeth === 'number'
        ? {
            teeth: optsOrTeeth,
            module: maybeMod,
            thickness: maybeThick,
            rimThickness: maybeRim,
            material: maybeMat,
          }
        : optsOrTeeth || {};

    const teeth = opts.teeth ?? opts.numTeeth ?? opts.toothCount ?? 48;
    const mod = opts.module ?? opts.mod ?? opts.m ?? 2.0;
    const pressureAngleDeg = opts.pressureAngleDeg ?? opts.pressureAngle ?? 20;
    const thickness =
      opts.thickness ?? opts.height ?? opts.width ?? opts.depth ?? opts.faceWidth ?? 12;
    const N = clampInt(teeth, 12, 400, 48);
    const m = Math.max(0.25, Number(mod) || 2.0);
    const pitchRadius = (N * m) / 2;
    const innerTipRadius = pitchRadius - 1.0 * m;
    const innerRootRadius = pitchRadius + 1.2 * m;

    const rimThickness =
      opts.rimThickness ??
      opts.wallThickness ??
      opts.wall ??
      (opts.outerRadius != null
        ? Math.max(3, Number(opts.outerRadius) - innerRootRadius)
        : opts.outerDiameter != null
        ? Math.max(3, Number(opts.outerDiameter) / 2 - innerRootRadius)
        : 8);
    const centerY = Boolean(opts.centerY);
    const material = opts.material ?? null;
    const name = opts.name || 'ring_gear';

    const outerRimRadius = innerRootRadius + Math.max(3, Number(rimThickness) || 8);

    // Outer circular ring contour
    const outerShape = new THREE.Shape();
    outerShape.absarc(0, 0, outerRimRadius, 0, Math.PI * 2, false);

    // Inner toothed hole path
    const { shape: innerToothShape } = createSpurGearShape({
      teeth: N,
      module: m,
      pressureAngleDeg,
      boreDiameter: 0,
      addendumFactor: 1.15,
      dedendumFactor: 1.0,
    });

    const holePts = innerToothShape.getPoints(4);
    const holePath = new THREE.Path();
    if (holePts.length > 0) {
      holePath.moveTo(holePts[0].x, holePts[0].y);
      for (let i = holePts.length - 1; i >= 0; i--) {
        holePath.lineTo(holePts[i].x, holePts[i].y);
      }
      holePath.closePath();
      outerShape.holes.push(holePath);
    } else {
      const fallback = new THREE.Path();
      fallback.absarc(0, 0, innerTipRadius, 0, Math.PI * 2, true);
      outerShape.holes.push(fallback);
    }

    const geom = new THREE.ExtrudeGeometry(outerShape, {
      depth: Math.max(0.5, Number(thickness) || 12),
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: Math.min(0.2, m * 0.1),
      bevelThickness: Math.min(0.2, m * 0.1),
      curveSegments: 64,
    });

    orientZExtrusionToYUp(geom, { centerY });
    return toHybridMesh(geom, material, name);
  }

  // ---- 3. CAD.rack (Linear Gear Rack) ----
  function rack(opts = {}) {
    const teeth = opts.teeth ?? opts.numTeeth ?? opts.toothCount ?? 12;
    const mod = opts.module ?? opts.mod ?? opts.m ?? 2.0;
    const pressureAngleDeg = opts.pressureAngleDeg ?? opts.pressureAngle ?? 20;
    const width = opts.width ?? opts.thickness ?? opts.depth ?? opts.faceWidth ?? 10;
    const baseHeight = opts.baseHeight ?? opts.height ?? opts.backingHeight ?? 8;
    const material = opts.material ?? null;
    const name = opts.name || 'gear_rack';

    const N = clampInt(teeth, 2, 400, 12);
    const m = Math.max(0.25, Number(mod) || 2.0);
    const pitch = Math.PI * m;
    const totalLength = N * pitch;
    const addendum = 1.0 * m;
    const dedendum = 1.2 * m;
    const toothHeight = addendum + dedendum;
    const alpha = ((Number(pressureAngleDeg) || 20) * Math.PI) / 180;
    const slopeX = toothHeight * Math.tan(alpha);
    const tipWidth = Math.max(0.2 * pitch, 0.5 * pitch - slopeX);

    const shape = new THREE.Shape();
    const startX = -totalLength / 2;
    shape.moveTo(startX, 0);
    shape.lineTo(startX, baseHeight);

    for (let i = 0; i < N; i++) {
      const x0 = startX + i * pitch;
      const x1 = x0 + slopeX * 0.5;
      const x2 = x1 + tipWidth;
      const x3 = x2 + slopeX;
      const x4 = x0 + pitch;
      shape.lineTo(x1, baseHeight);
      shape.lineTo(x1 + slopeX * 0.5, baseHeight + toothHeight);
      shape.lineTo(x2, baseHeight + toothHeight);
      shape.lineTo(x3, baseHeight);
      shape.lineTo(x4, baseHeight);
    }
    shape.lineTo(startX + totalLength, 0);
    shape.closePath();

    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(1, Number(width) || 10),
      bevelEnabled: false,
    });
    geom.translate(0, 0, -Number(width) / 2);
    geom.computeVertexNormals();

    return toHybridMesh(geom, material, name);
  }

  // ---- 4. CAD.helicalThread (ISO External or Internal Helical Thread + Core Cylinder/Collar) ----
  function helicalThread(opts = {}) {
    const radius =
      opts.radius ??
      (opts.diameter != null
        ? Number(opts.diameter) / 2
        : opts.majorDiameter != null
        ? Number(opts.majorDiameter) / 2
        : opts.outerDiameter != null
        ? Number(opts.outerDiameter) / 2
        : opts.outerRadius ?? 16);
    const pitch = opts.pitch ?? opts.lead ?? 3.0;
    const turns =
      opts.turns ??
      (opts.length != null && pitch
        ? Number(opts.length) / Number(pitch)
        : opts.height != null && pitch
        ? Number(opts.height) / Number(pitch)
        : 4.5);
    const threadDepth = opts.threadDepth ?? opts.depth ?? Number(pitch) * 0.5;
    const crestWidthFactor = opts.crestWidthFactor ?? 0.18;
    const rootWidthFactor = opts.rootWidthFactor ?? 0.68;
    const internal = Boolean(opts.internal);
    const includeCore = opts.includeCore !== undefined ? Boolean(opts.includeCore) : true;
    const boreRadius =
      opts.boreRadius ??
      (opts.boreDiameter != null
        ? Number(opts.boreDiameter) / 2
        : opts.innerRadius ?? (opts.innerDiameter != null ? Number(opts.innerDiameter) / 2 : 0));
    const segmentsPerTurn = opts.segmentsPerTurn ?? opts.radialSegments ?? 48;
    const material = opts.material ?? null;
    const name = opts.name || 'helical_thread';

    const R = Math.max(1.5, Number(radius) || 16);
    const P = Math.max(0.4, Number(pitch) || 3.0);
    const T = Math.min(256, Math.max(0.5, Number(turns) || 4.0));
    const D = Math.min(P * 0.65, Math.max(0.2, Number(threadDepth) || P * 0.5));
    const segs = clampInt(segmentsPerTurn, 16, 256, 48);
    // Cap the sweep resolution so a long fine-pitch thread stays well inside the triangle budget
    const totalSteps = Math.min(16384, Math.round(T * segs));
    const totalHeight = T * P;

    // Build closed manifold helical ridge mesh by sweeping a 4-vertex trapezoidal cross-section
    const positions = [];
    const indices = [];

    const halfRoot = 0.5 * P * rootWidthFactor;
    const halfCrest = 0.5 * P * crestWidthFactor;
    const dir = internal ? -1 : 1;

    for (let i = 0; i <= totalSteps; i++) {
      if ((i & 1023) === 0) checkDeadline();
      const u = i / totalSteps;
      // Taper entry/exit over first and last quarter turn so thread blends cleanly
      const leadFade = Math.min(1, u * T * 3.5, (1 - u) * T * 3.5);
      const dEff = D * Math.max(0.05, leadFade);
      const theta = u * T * Math.PI * 2;
      const yCenter = (u - 0.5) * totalHeight + totalHeight * 0.5;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      const rRoot = R;
      const rCrest = R + dir * dEff;

      const ring = [
        [rRoot * cosT, yCenter - halfRoot, rRoot * sinT],
        [rCrest * cosT, yCenter - halfCrest, rCrest * sinT],
        [rCrest * cosT, yCenter + halfCrest, rCrest * sinT],
        [rRoot * cosT, yCenter + halfRoot, rRoot * sinT],
      ];
      for (const p of ring) {
        positions.push(p[0], p[1], p[2]);
      }

      if (i < totalSteps) {
        const base = i * 4;
        const next = (i + 1) * 4;
        for (let k = 0; k < 4; k++) {
          const kNext = (k + 1) % 4;
          if (internal) {
            indices.push(base + k, base + kNext, next + kNext);
            indices.push(base + k, next + kNext, next + k);
          } else {
            indices.push(base + k, next + kNext, base + kNext);
            indices.push(base + k, next + k, next + kNext);
          }
        }
      }
    }

    // End caps for helical thread sweep
    indices.push(0, 1, 2, 0, 2, 3);
    const last = totalSteps * 4;
    indices.push(last, last + 2, last + 1, last, last + 3, last + 2);

    const threadGeom = new THREE.BufferGeometry();
    threadGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    threadGeom.setIndex(indices);

    let finalGeom = threadGeom;
    if (includeCore) {
      const coreOuter = internal ? R + Math.max(2.0, D * 1.6) : R;
      const coreInner = internal ? R : Math.max(0, Number(boreRadius) || 0);
      const coreMesh = pipe({
        outerRadius: coreOuter,
        innerRadius: coreInner,
        height: totalHeight + P,
        radialSegments: segs,
      });
      finalGeom = mergeBufferGeometries([coreMesh.geometry, threadGeom], THREE);
    }

    finalGeom.computeVertexNormals();
    return toHybridMesh(finalGeom, material, name);
  }

  // ---- 5. CAD.pipe (Hollow Cylinder / Sleeve / Bushing / Standoff sitting on Y=0) ----
  function pipe(optsOrOutR = {}, maybeInR, maybeH, maybeMat) {
    const opts =
      typeof optsOrOutR === 'number'
        ? {
            outerRadius: optsOrOutR,
            innerRadius: maybeInR ?? 0,
            height: maybeH ?? 20,
            material: maybeMat ?? null,
          }
        : optsOrOutR || {};

    const rawOutR =
      opts.outerDiameter != null
        ? Number(opts.outerDiameter) / 2
        : opts.od != null
        ? Number(opts.od) / 2
        : opts.outerRadius ??
          opts.rOut ??
          opts.radius ??
          (opts.diameter != null ? Number(opts.diameter) / 2 : 15);
    const rOut = Math.max(0.5, Number(rawOutR) || 15);

    const rawInR =
      opts.innerDiameter != null
        ? Number(opts.innerDiameter) / 2
        : opts.id != null
        ? Number(opts.id) / 2
        : opts.boreDiameter != null
        ? Number(opts.boreDiameter) / 2
        : opts.innerRadius ??
          opts.rIn ??
          opts.boreRadius ??
          opts.holeRadius ??
          (opts.wallThickness != null ? rOut - Number(opts.wallThickness) : 0);
    const rIn = Math.max(0, Math.min(rOut - 0.1, Number(rawInR) || 0));

    const H = Math.max(
      0.2,
      Number(opts.height ?? opts.length ?? opts.thickness ?? opts.depth ?? opts.h ?? 20) || 20
    );
    const segs = clampInt(opts.radialSegments ?? opts.segments, 12, 256, 64);
    const centerY = Boolean(opts.centerY ?? opts.centered);
    const material = opts.material ?? null;
    const name = opts.name || 'pipe';

    let geom;
    if (rIn <= 0.05) {
      geom = new THREE.CylinderGeometry(rOut, rOut, H, segs, 1, false);
      if (!centerY) {
        geom.translate(0, H / 2, 0);
      }
      geom.computeVertexNormals();
    } else {
      const shape = new THREE.Shape();
      shape.absarc(0, 0, rOut, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, rIn, 0, Math.PI * 2, true);
      shape.holes.push(hole);

      geom = new THREE.ExtrudeGeometry(shape, {
        depth: H,
        bevelEnabled: false,
        curveSegments: segs,
      });
      orientZExtrusionToYUp(geom, { centerY });
    }

    return toHybridMesh(geom, material, name);
  }

  // ---- 6. CAD.revolveProfile & CAD.revolveHollow (Closed Watertight Spline Lathe Vessel / Vase) ----
  function normalize2DPoints(points, steps = 64) {
    if (points && typeof points.points === 'function') {
      points = points.points();
    } else if (points && Array.isArray(points.points)) {
      points = points.points;
    }
    if (!Array.isArray(points) || points.length < 2) {
      return [
        new THREE.Vector2(15, 0),
        new THREE.Vector2(22, 40),
        new THREE.Vector2(14, 85),
        new THREE.Vector2(20, 120),
      ];
    }
    const curveSteps = clampInt(steps, 2, 256, 64);
    const vecs = limitPoints(points).map((p) => {
      if (p instanceof THREE.Vector2) return p.clone();
      if (Array.isArray(p)) return new THREE.Vector2(Math.abs(Number(p[0]) || 0), Number(p[1]) || 0);
      return new THREE.Vector2(Math.abs(Number(p.r ?? p.x ?? 10)), Number(p.y ?? p.z ?? 0));
    });
    if (vecs.length >= 3 && curveSteps > vecs.length) {
      const spline = new THREE.SplineCurve(vecs);
      return spline.getPoints(curveSteps).map((v) => new THREE.Vector2(Math.max(0, v.x), v.y));
    }
    return vecs;
  }

  // A revolve of a 2D cross-section is only a solid when the profile is a closed region.
  // Close the loop (unless both ends already sit on the axis, i.e. a vase/sphere-style
  // profile that LatheGeometry closes at the poles) and orient it counter-clockwise in the
  // (r, y) plane so LatheGeometry emits outward-facing triangles and an edge-manifold shell.
  function closeAndOrientRevolveProfile(pts) {
    if (!Array.isArray(pts) || pts.length < 3) return pts;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const onAxis = (p) => Math.abs(p.x) < 1e-6;
    if (!(onAxis(first) && onAxis(last)) && first.distanceTo(last) > 1e-6) {
      pts.push(first.clone());
    }
    let area2 = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      area2 += a.x * b.y - b.x * a.y;
    }
    if (area2 < 0) pts.reverse();
    return pts;
  }

  function revolveProfile(pointsOrOpts, segments = 64, opts = {}) {
    let points = pointsOrOpts;
    let resolvedOpts = opts || {};
    let resolvedSegs = segments;
    if (pointsOrOpts && !Array.isArray(pointsOrOpts) && typeof pointsOrOpts === 'object' && typeof pointsOrOpts.points !== 'function') {
      resolvedOpts = pointsOrOpts;
      points = pointsOrOpts.points ?? pointsOrOpts.profile ?? pointsOrOpts.contour;
      resolvedSegs = pointsOrOpts.segments ?? pointsOrOpts.radialSegments ?? 64;
    } else if (typeof segments === 'object' && segments !== null) {
      resolvedOpts = segments;
      resolvedSegs = resolvedOpts.segments ?? 64;
    }
    const pts = normalize2DPoints(points, resolvedOpts.curveSteps || 64);
    if (resolvedOpts.closed !== false) closeAndOrientRevolveProfile(pts);
    const geom = new THREE.LatheGeometry(pts, clampInt(resolvedSegs, 16, 256, 64));
    geom.computeVertexNormals();
    return toHybridMesh(geom, resolvedOpts.material ?? null, resolvedOpts.name || 'revolved_profile');
  }

  /**
   * Revolves an outer 2D profile [(r, y), ...] into a watertight hollow vessel with:
   *  - uniform wallThickness (mm)
   *  - solid closed floor of floorThickness (mm) at the base
   *  - rounded top rim connecting outer and inner walls so there are zero open boundaries!
   */
  function revolveHollow(pointsOrOpts, wallThickness = 3.0, opts = {}) {
    let points = pointsOrOpts;
    let resolvedWall = wallThickness;
    let resolvedOpts = opts || {};
    if (pointsOrOpts && !Array.isArray(pointsOrOpts) && typeof pointsOrOpts === 'object' && typeof pointsOrOpts.points !== 'function') {
      resolvedOpts = pointsOrOpts;
      points = pointsOrOpts.points ?? pointsOrOpts.profile ?? pointsOrOpts.contour;
      resolvedWall = pointsOrOpts.wallThickness ?? pointsOrOpts.wall ?? 3.0;
    } else if (typeof wallThickness === 'object' && wallThickness !== null) {
      resolvedOpts = wallThickness;
      resolvedWall = resolvedOpts.wallThickness ?? resolvedOpts.wall ?? 3.0;
    }
    const {
      floorThickness = null,
      segments = 72,
      curveSteps = 64,
      ribCount = 0,
      ribDepth = 0,
      ribTwistTurns = 0,
      material = null,
      name = 'hollow_vessel',
    } = resolvedOpts;

    const wall = Math.max(0.6, Number(resolvedWall) || 3.0);
    const floor = Math.max(wall, Number(floorThickness) || wall * 1.4);
    const outerPts = normalize2DPoints(points, curveSteps);

    // Ensure sorted bottom-to-top
    if (outerPts[0].y > outerPts[outerPts.length - 1].y) {
      outerPts.reverse();
    }

    const minY = outerPts[0].y;
    const baseR = Math.max(2, outerPts[0].x);

    const closedContour = [];
    closedContour.push(new THREE.Vector2(0, minY));
    closedContour.push(new THREE.Vector2(baseR * 0.5, minY));

    for (let i = 0; i < outerPts.length; i++) {
      closedContour.push(new THREE.Vector2(Math.max(wall + 0.5, outerPts[i].x), outerPts[i].y));
    }

    // Rounded top lip transition
    const topOuter = closedContour[closedContour.length - 1];
    const topInnerR = Math.max(1.0, topOuter.x - wall);
    const midLipR = 0.5 * (topOuter.x + topInnerR);
    closedContour.push(new THREE.Vector2(midLipR, topOuter.y + wall * 0.35));
    closedContour.push(new THREE.Vector2(topInnerR, topOuter.y));

    // Inner wall descending down to floor
    for (let i = outerPts.length - 2; i >= 0; i--) {
      const pt = outerPts[i];
      if (pt.y <= minY + floor) break;
      const rIn = Math.max(1.0, pt.x - wall);
      closedContour.push(new THREE.Vector2(rIn, pt.y));
    }

    // Inner floor corner back to axis r=0
    const floorInnerR = Math.max(1.0, baseR - wall);
    closedContour.push(new THREE.Vector2(floorInnerR, minY + floor));
    closedContour.push(new THREE.Vector2(0, minY + floor));

    const segs = clampInt(segments, 24, 256, 72);
    const geom = new THREE.LatheGeometry(closedContour, segs);

    // Optional sculptural ribs / twisted fluting on the outer wall
    if (Number(ribCount) > 0 && Number(ribDepth) > 0) {
      const pos = geom.attributes.position;
      const maxY = topOuter.y;
      const heightSpan = Math.max(1, maxY - minY);
      const ribs = clampInt(ribCount, 1, 512, 1);
      const depth = Number(ribDepth);
      const twist = Number(ribTwistTurns) || 0;

      for (let i = 0; i < pos.count; i++) {
        if ((i & 4095) === 0) checkDeadline();
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const r = Math.hypot(x, z);
        const u = (y - minY) / heightSpan;
        if (r > 2 && u > 0.06 && u < 0.96) {
          const approxIdx = Math.min(
            outerPts.length - 1,
            Math.max(0, Math.round(u * (outerPts.length - 1)))
          );
          const expectedOuterR = outerPts[approxIdx].x;
          if (r >= expectedOuterR - wall * 0.35) {
            const theta = Math.atan2(z, x) + u * twist * Math.PI * 2;
            const envelope = Math.sin(Math.PI * u);
            const deltaR = depth * envelope * Math.cos(ribs * theta);
            const scale = (r + deltaR) / r;
            pos.setX(i, x * scale);
            pos.setZ(i, z * scale);
          }
        }
      }
      pos.needsUpdate = true;
    }

    geom.computeVertexNormals();
    return toHybridMesh(geom, material, name);
  }

  // ---- 7. CAD.extrudeWithHoles (2D Polygon/Rounded-Rect Base Plate with Circular/Polygon Holes) ----
  function extrudeWithHoles(opts = {}) {
    const outerPoints =
      opts.outerPoints ?? opts.points ?? opts.polygon ?? opts.contour ?? opts.outline ?? null;
    const width = opts.width ?? opts.w ?? opts.sizeX ?? 80;
    const length =
      opts.length ??
      opts.l ??
      opts.sizeZ ??
      (opts.depth != null && (opts.thickness != null || opts.height != null)
        ? opts.depth
        : 60);
    const cornerRadius =
      opts.cornerRadius ?? opts.filletRadius ?? opts.radius ?? opts.r ?? 6;
    const holes = opts.holes ?? opts.cutouts ?? [];
    const depth =
      opts.thickness ?? opts.height ?? opts.extrudeDepth ?? opts.depth ?? 6;
    const bevelEnabled = opts.bevelEnabled ?? true;
    const bevelSize = opts.bevelSize ?? 0.4;
    const centerY = Boolean(opts.centerY ?? opts.centered);
    const material = opts.material ?? null;
    const name = opts.name || 'extruded_plate';

    const shape = new THREE.Shape();
    checkDeadline();
    if (Array.isArray(outerPoints) && outerPoints.length >= 3) {
      const pts = limitPoints(outerPoints).map((p) =>
        Array.isArray(p) ? new THREE.Vector2(Number(p[0]) || 0, Number(p[1]) || 0) : new THREE.Vector2(Number(p.x) || 0, Number(p.y ?? p.z) || 0)
      );
      shape.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        shape.lineTo(pts[i].x, pts[i].y);
      }
      shape.closePath();
    } else {
      const w = Math.max(2, Number(width) || 80);
      const l = Math.max(2, Number(length) || 60);
      const r = Math.min(w * 0.45, l * 0.45, Math.max(0, Number(cornerRadius) || 0));
      const x0 = -w / 2;
      const y0 = -l / 2;
      if (r <= 0.05) {
        shape.moveTo(x0, y0);
        shape.lineTo(x0 + w, y0);
        shape.lineTo(x0 + w, y0 + l);
        shape.lineTo(x0, y0 + l);
        shape.closePath();
      } else {
        shape.moveTo(x0 + r, y0);
        shape.lineTo(x0 + w - r, y0);
        shape.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
        shape.lineTo(x0 + w, y0 + l - r);
        shape.quadraticCurveTo(x0 + w, y0 + l, x0 + w - r, y0 + l);
        shape.lineTo(x0 + r, y0 + l);
        shape.quadraticCurveTo(x0, y0 + l, x0, y0 + l - r);
        shape.lineTo(x0, y0 + r);
        shape.quadraticCurveTo(x0, y0, x0 + r, y0);
      }
    }

    if (Array.isArray(holes)) {
      // Pattern cap: at most 512 cutouts per plate (earcut cost grows with every hole contour)
      for (const h of holes.slice(0, 512)) {
        if (!h) continue;
        if (Array.isArray(h) && h.length >= 3 && typeof h[0] === 'number') {
          const hx = Number(h[0]) || 0;
          const hy = Number(h[1]) || 0;
          const hr = Math.max(0.2, Number(h[2]) || 2);
          const hp = new THREE.Path();
          hp.absarc(hx, hy, hr, 0, Math.PI * 2, true);
          shape.holes.push(hp);
        } else if (Array.isArray(h.points) && h.points.length >= 3) {
          const hp = new THREE.Path();
          const hPts = limitPoints(h.points);
          const p0 = Array.isArray(hPts[0]) ? hPts[0] : [hPts[0].x, hPts[0].y];
          hp.moveTo(Number(p0[0]) || 0, Number(p0[1]) || 0);
          for (let i = hPts.length - 1; i >= 0; i--) {
            const pi = Array.isArray(hPts[i]) ? hPts[i] : [hPts[i].x, hPts[i].y];
            hp.lineTo(Number(pi[0]) || 0, Number(pi[1]) || 0);
          }
          hp.closePath();
          shape.holes.push(hp);
        } else {
          const hx = Number(h.x ?? 0);
          const hy = Number(h.y ?? h.z ?? 0);
          const hr = Math.max(
            0.2,
            Number(h.radius ?? h.r ?? (h.diameter ? h.diameter / 2 : h.d ? h.d / 2 : 2))
          );
          const hp = new THREE.Path();
          hp.absarc(hx, hy, hr, 0, Math.PI * 2, true);
          shape.holes.push(hp);
        }
      }
    }

    const d = Math.max(0.4, Number(depth) || 6);
    const bSize = bevelEnabled ? Math.min(Number(bevelSize) || 0.3, d * 0.15) : 0;
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: d,
      bevelEnabled: Boolean(bevelEnabled && bSize > 0),
      bevelSegments: 2,
      steps: 1,
      bevelSize: bSize,
      bevelThickness: bSize,
      curveSegments: 32,
    });

    orientZExtrusionToYUp(geom, { centerY });
    return toHybridMesh(geom, material, name);
  }

  // ---- 8. CAD.roundedBox (Solid Rounded Box Sitting on Y=0 or Centered) ----
  function roundedBox(optsOrW = {}, maybeH, maybeD, maybeR, maybeMat) {
    const opts =
      typeof optsOrW === 'number'
        ? {
            width: optsOrW,
            height: maybeH ?? 30,
            depth: maybeD ?? 40,
            radius: maybeR ?? 4,
            material: maybeMat ?? null,
          }
        : optsOrW || {};
    const width = opts.width ?? opts.w ?? opts.sizeX ?? opts.x ?? 60;
    const height = opts.height ?? opts.h ?? opts.sizeY ?? opts.y ?? opts.thickness ?? 30;
    const depth = opts.depth ?? opts.d ?? opts.length ?? opts.l ?? opts.sizeZ ?? opts.z ?? 40;
    const radius = opts.radius ?? opts.cornerRadius ?? opts.fillet ?? opts.filletRadius ?? opts.r ?? 4;
    const centerY = Boolean(opts.centerY ?? opts.centered);
    const material = opts.material ?? null;
    const name = opts.name || 'rounded_box';

    return extrudeWithHoles({
      width,
      length: depth,
      cornerRadius: radius,
      depth: height,
      bevelEnabled: Number(radius) > 0.05,
      bevelSize: Math.min(1.0, Math.max(0, Number(radius)) * 0.25),
      centerY,
      material,
      name,
    });
  }

  // ---- 9. CAD.shellBox (Open-Top Hollow Enclosure Tub with Rounded Corners, Floor & Lip) ----
  function shellBox(opts = {}) {
    const width = opts.width ?? opts.w ?? 110;
    const depth = opts.depth ?? opts.length ?? opts.l ?? opts.d ?? 75;
    const height = opts.height ?? opts.h ?? 32;
    const wallThickness = opts.wallThickness ?? opts.wall ?? opts.thickness ?? 2.5;
    const floorThickness = opts.floorThickness ?? opts.baseThickness ?? opts.bottomThickness ?? wallThickness;
    const cornerRadius = opts.cornerRadius ?? opts.radius ?? opts.r ?? 6;
    const material = opts.material ?? null;
    const name = opts.name || 'enclosure_shell';

    const W = Math.max(10, Number(width) || 110);
    const D = Math.max(10, Number(depth) || 75);
    const H = Math.max(4, Number(height) || 32);
    const wall = Math.max(0.8, Math.min(W * 0.2, D * 0.2, Number(wallThickness) || 2.5));
    const floor = Math.max(0.8, Math.min(H * 0.5, Number(floorThickness) || wall));
    const R = Math.max(0.5, Math.min(W * 0.4, D * 0.4, Number(cornerRadius) || 6));

    // Floor slab [0 .. floor]
    const floorMesh = extrudeWithHoles({
      width: W,
      length: D,
      cornerRadius: R,
      depth: floor,
      bevelEnabled: true,
      bevelSize: 0.35,
      centerY: false,
    });

    // Hollow perimeter walls [floor .. H]
    const innerW = W - 2 * wall;
    const innerD = D - 2 * wall;
    const innerR = Math.max(0.2, R - wall);

    const wallShape = new THREE.Shape();
    const x0 = -W / 2;
    const y0 = -D / 2;
    wallShape.moveTo(x0 + R, y0);
    wallShape.lineTo(x0 + W - R, y0);
    wallShape.quadraticCurveTo(x0 + W, y0, x0 + W, y0 + R);
    wallShape.lineTo(x0 + W, y0 + D - R);
    wallShape.quadraticCurveTo(x0 + W, y0 + D, x0 + W - R, y0 + D);
    wallShape.lineTo(x0 + R, y0 + D);
    wallShape.quadraticCurveTo(x0, y0 + D, x0, y0 + D - R);
    wallShape.lineTo(x0, y0 + R);
    wallShape.quadraticCurveTo(x0, y0, x0 + R, y0);

    // Inner rectangular cavity hole (clockwise)
    const ix0 = -innerW / 2;
    const iy0 = -innerD / 2;
    const hole = new THREE.Path();
    hole.moveTo(ix0 + innerR, iy0);
    hole.quadraticCurveTo(ix0, iy0, ix0, iy0 + innerR);
    hole.lineTo(ix0, iy0 + innerD - innerR);
    hole.quadraticCurveTo(ix0, iy0 + innerD, ix0 + innerR, iy0 + innerD);
    hole.lineTo(ix0 + innerW - innerR, iy0 + innerD);
    hole.quadraticCurveTo(ix0 + innerW, iy0 + innerD, ix0 + innerW, iy0 + innerD - innerR);
    hole.lineTo(ix0 + innerW, iy0 + innerR);
    hole.quadraticCurveTo(ix0 + innerW, iy0, ix0 + innerW - innerR, iy0);
    hole.closePath();
    wallShape.holes.push(hole);

    const wallGeom = new THREE.ExtrudeGeometry(wallShape, {
      depth: Math.max(1, H - floor),
      bevelEnabled: false,
      curveSegments: 24,
    });
    orientZExtrusionToYUp(wallGeom, { centerY: false });
    wallGeom.translate(0, floor, 0);

    const merged = mergeBufferGeometries([floorMesh.geometry, wallGeom], THREE);
    merged.computeVertexNormals();
    return toHybridMesh(merged, material, name);
  }

  // ---- 10. Replicad-Compatible Fluent 2D Sketcher (`CAD.draw([x, y])` or `CAD.draw(x, y)`) ----
  function parsePt2D(ptOrX, maybeY) {
    if (Array.isArray(ptOrX)) {
      return new THREE.Vector2(Number(ptOrX[0]) || 0, Number(ptOrX[1]) || 0);
    }
    if (ptOrX && typeof ptOrX === 'object') {
      return new THREE.Vector2(Number(ptOrX.x ?? ptOrX.r) || 0, Number(ptOrX.y ?? ptOrX.z) || 0);
    }
    return new THREE.Vector2(Number(ptOrX) || 0, Number(maybeY) || 0);
  }

  function draw(startPt = [0, 0], maybeStartY = 0) {
    const pts = [parsePt2D(startPt, maybeStartY)];
    const holes = [];

    const api = {
      moveTo(ptOrX, maybeY) {
        const v = parsePt2D(ptOrX, maybeY);
        if (pts.length <= 1) pts[0] = v;
        else pts.push(v);
        return api;
      },
      lineTo(ptOrX, maybeY) {
        pts.push(parsePt2D(ptOrX, maybeY));
        return api;
      },
      line(dx, dy) {
        const last = pts[pts.length - 1];
        pts.push(new THREE.Vector2(last.x + (Number(dx) || 0), last.y + (Number(dy) || 0)));
        return api;
      },
      hLine(dx) {
        return api.line(dx, 0);
      },
      vLine(dy) {
        return api.line(0, dy);
      },
      hLineTo(x) {
        const last = pts[pts.length - 1];
        pts.push(new THREE.Vector2(Number(x) || 0, last.y));
        return api;
      },
      vLineTo(y) {
        const last = pts[pts.length - 1];
        pts.push(new THREE.Vector2(last.x, Number(y) || 0));
        return api;
      },
      polarLine(distance, angleDeg) {
        const last = pts[pts.length - 1];
        const rad = ((Number(angleDeg) || 0) * Math.PI) / 180;
        const d = Number(distance) || 0;
        pts.push(new THREE.Vector2(last.x + d * Math.cos(rad), last.y + d * Math.sin(rad)));
        return api;
      },
      quadraticCurveTo(cpX, cpY, endX, endY) {
        const last = pts[pts.length - 1];
        const cp = Array.isArray(cpX) ? parsePt2D(cpX) : new THREE.Vector2(Number(cpX) || 0, Number(cpY) || 0);
        const end = Array.isArray(cpX) ? parsePt2D(cpY) : new THREE.Vector2(Number(endX) || 0, Number(endY) || 0);
        const curve = new THREE.QuadraticBezierCurve(last, cp, end);
        const sub = curve.getPoints(8);
        for (let i = 1; i < sub.length; i++) pts.push(sub[i]);
        return api;
      },
      bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY) {
        const last = pts[pts.length - 1];
        const c1 = new THREE.Vector2(Number(cp1X) || 0, Number(cp1Y) || 0);
        const c2 = new THREE.Vector2(Number(cp2X) || 0, Number(cp2Y) || 0);
        const end = new THREE.Vector2(Number(endX) || 0, Number(endY) || 0);
        const curve = new THREE.CubicBezierCurve(last, c1, c2, end);
        const sub = curve.getPoints(10);
        for (let i = 1; i < sub.length; i++) pts.push(sub[i]);
        return api;
      },
      tangentArcTo(ptOrX, maybeY) {
        pts.push(parsePt2D(ptOrX, maybeY));
        return api;
      },
      threePointsArcTo(endPt, midPt) {
        const last = pts[pts.length - 1];
        const mid = parsePt2D(midPt);
        const end = parsePt2D(endPt);
        const curve = new THREE.QuadraticBezierCurve(last, mid, end);
        const sub = curve.getPoints(8);
        for (let i = 1; i < sub.length; i++) pts.push(sub[i]);
        return api;
      },
      customCorner(radius) {
        api._cornerRadius = Number(radius) || 0;
        return api;
      },
      fillet(radius) {
        api._cornerRadius = Number(radius) || 0;
        return api;
      },
      chamfer(dist) {
        api._cornerRadius = Number(dist) || 0;
        return api;
      },
      circleHole(x, y, radius) {
        holes.push({ x: Number(x) || 0, y: Number(y) || 0, radius: Math.max(0.2, Number(radius) || 2) });
        return api;
      },
      hole(x, y, radius) {
        return api.circleHole(x, y, radius);
      },
      close() {
        return api;
      },
      done() {
        return api;
      },
      sketchOnPlane(plane = 'XZ') {
        api._plane = plane;
        return api;
      },
      extrude(depth = 10, opts = {}) {
        const dOpts = typeof depth === 'object' && depth !== null ? depth : { depth, ...(opts || {}) };
        return extrudeWithHoles({
          outerPoints: pts,
          holes,
          ...dOpts,
        });
      },
      revolve(segments = 64, opts = {}) {
        return revolveProfile(pts, segments, opts);
      },
      revolveHollow(wallThickness = 3.0, opts = {}) {
        return revolveHollow(pts, wallThickness, opts);
      },
      points() {
        return pts.slice();
      },
    };
    return api;
  }

  // ---- 10B. Additional Convenience Primitives (`cylinder`, `box`, `sphere`, `cone`, `torus`, `capsule`, `hexNut`, `hexBolt`) ----
  function cylinder(optsOrR = {}, maybeH, maybeMat) {
    const opts =
      typeof optsOrR === 'number'
        ? { radius: optsOrR, height: maybeH ?? 20, material: maybeMat ?? null }
        : optsOrR || {};
    if (opts.innerRadius || opts.innerDiameter || opts.boreRadius || opts.boreDiameter) {
      return pipe(opts);
    }
    const rBase =
      opts.diameter != null
        ? Number(opts.diameter) / 2
        : opts.outerDiameter != null
        ? Number(opts.outerDiameter) / 2
        : Number(opts.radius ?? opts.outerRadius ?? 12) || 12;
    const rTop =
      opts.diameterTop != null
        ? Number(opts.diameterTop) / 2
        : Number(opts.radiusTop ?? rBase);
    const rBot =
      opts.diameterBottom != null
        ? Number(opts.diameterBottom) / 2
        : Number(opts.radiusBottom ?? rBase);
    const H = Math.max(0.2, Number(opts.height ?? opts.length ?? opts.thickness ?? opts.depth ?? 20) || 20);
    const segs = clampInt(opts.radialSegments ?? opts.segments, 12, 256, 48);
    const centerY = Boolean(opts.centerY ?? opts.centered);
    const geom = new THREE.CylinderGeometry(Math.max(0.05, rTop), Math.max(0.05, rBot), H, segs);
    if (!centerY) geom.translate(0, H / 2, 0);
    return toHybridMesh(geom, opts.material ?? null, opts.name || 'cylinder');
  }

  function box(optsOrW = {}, maybeH, maybeD, maybeMat) {
    const opts =
      typeof optsOrW === 'number'
        ? { width: optsOrW, height: maybeH ?? 20, depth: maybeD ?? 20, material: maybeMat ?? null }
        : optsOrW || {};
    if (opts.radius || opts.cornerRadius || opts.filletRadius) {
      return roundedBox(opts);
    }
    const W = Math.max(0.2, Number(opts.width ?? opts.w ?? opts.sizeX ?? 30) || 30);
    const H = Math.max(0.2, Number(opts.height ?? opts.h ?? opts.sizeY ?? opts.thickness ?? 20) || 20);
    const D = Math.max(0.2, Number(opts.depth ?? opts.d ?? opts.length ?? opts.l ?? opts.sizeZ ?? 30) || 30);
    const centerY = Boolean(opts.centerY ?? opts.centered);
    const geom = new THREE.BoxGeometry(W, H, D);
    if (!centerY) geom.translate(0, H / 2, 0);
    return toHybridMesh(geom, opts.material ?? null, opts.name || 'box');
  }

  function sphere(optsOrR = {}, maybeMat) {
    const opts =
      typeof optsOrR === 'number' ? { radius: optsOrR, material: maybeMat ?? null } : optsOrR || {};
    const R = Math.max(
      0.5,
      opts.diameter != null ? Number(opts.diameter) / 2 : Number(opts.radius ?? 15) || 15
    );
    const segs = clampInt(opts.segments ?? opts.widthSegments, 16, 256, 48);
    const geom = new THREE.SphereGeometry(
      R,
      segs,
      Math.max(12, Math.round(segs * 0.75)),
      opts.phiStart ?? 0,
      opts.phiLength ?? Math.PI * 2,
      opts.thetaStart ?? 0,
      opts.thetaLength ?? Math.PI
    );
    return toHybridMesh(geom, opts.material ?? null, opts.name || 'sphere');
  }

  function cone(optsOrR = {}, maybeH, maybeMat) {
    const opts =
      typeof optsOrR === 'number'
        ? { radiusBottom: optsOrR, height: maybeH ?? 25, material: maybeMat ?? null }
        : optsOrR || {};
    const rBot = Math.max(
      0.2,
      opts.diameter != null ? Number(opts.diameter) / 2 : Number(opts.radiusBottom ?? opts.radius ?? 14) || 14
    );
    const rTop = Math.max(0, Number(opts.radiusTop ?? 0));
    const H = Math.max(0.5, Number(opts.height ?? opts.length ?? 25) || 25);
    const segs = clampInt(opts.radialSegments ?? opts.segments, 16, 256, 48);
    const centerY = Boolean(opts.centerY ?? opts.centered);
    const geom = new THREE.CylinderGeometry(rTop, rBot, H, segs);
    if (!centerY) geom.translate(0, H / 2, 0);
    return toHybridMesh(geom, opts.material ?? null, opts.name || 'cone');
  }

  function torus(optsOrR = {}, maybeTube, maybeMat) {
    const opts =
      typeof optsOrR === 'number'
        ? { radius: optsOrR, tube: maybeTube ?? 3, material: maybeMat ?? null }
        : optsOrR || {};
    const R = Math.max(
      1,
      opts.diameter != null
        ? Number(opts.diameter) / 2
        : Number(opts.radius ?? opts.majorRadius ?? 20) || 20
    );
    const tubeR = Math.max(
      0.2,
      opts.tubeDiameter != null
        ? Number(opts.tubeDiameter) / 2
        : Number(opts.tube ?? opts.tubeRadius ?? opts.minorRadius ?? 3) || 3
    );
    const geom = new THREE.TorusGeometry(
      R,
      tubeR,
      clampInt(opts.radialSegments, 12, 256, 24),
      clampInt(opts.tubularSegments, 24, 256, 64),
      opts.arc ?? Math.PI * 2
    );
    if (opts.horizontal !== false) {
      geom.rotateX(Math.PI / 2);
    }
    return toHybridMesh(geom, opts.material ?? null, opts.name || 'torus');
  }

  function capsule(opts = {}) {
    const R = Math.max(
      0.5,
      opts.diameter != null ? Number(opts.diameter) / 2 : Number(opts.radius ?? 8) || 8
    );
    const L = Math.max(0.5, Number(opts.length ?? opts.height ?? 20) || 20);
    const geom = new THREE.CapsuleGeometry(R, L, 16, 36);
    if (!opts.centerY) geom.translate(0, L / 2 + R, 0);
    return toHybridMesh(geom, opts.material ?? null, opts.name || 'capsule');
  }

  function hexNut(opts = {}) {
    const acrossFlats = Number(
      opts.acrossFlats ?? opts.widthAcrossFlats ?? opts.size ?? opts.flatToFlat ?? 16
    );
    const circumRadius =
      opts.outerRadius != null
        ? Number(opts.outerRadius)
        : Math.max(2, acrossFlats / Math.sqrt(3));
    const boreR = Math.max(
      0,
      opts.boreDiameter != null
        ? Number(opts.boreDiameter) / 2
        : Number(opts.boreRadius ?? opts.innerRadius ?? circumRadius * 0.45)
    );
    const H = Math.max(1, Number(opts.height ?? opts.thickness ?? 8) || 8);
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      pts.push([Math.cos(a) * circumRadius, Math.sin(a) * circumRadius]);
    }
    return extrudeWithHoles({
      outerPoints: pts,
      holes: boreR > 0.2 ? [{ x: 0, y: 0, radius: boreR }] : [],
      depth: H,
      bevelEnabled: true,
      bevelSize: Math.min(0.4, H * 0.08),
      centerY: Boolean(opts.centerY),
      material: opts.material ?? null,
      name: opts.name || 'hex_nut',
    });
  }

  function hexBolt(opts = {}) {
    const shankR = Math.max(
      1,
      opts.diameter != null ? Number(opts.diameter) / 2 : Number(opts.radius ?? opts.shankRadius ?? 4) || 4
    );
    const shankLen = Math.max(2, Number(opts.length ?? opts.shankLength ?? opts.height ?? 18) || 18);
    const headH = Math.max(1.5, Number(opts.headHeight ?? shankR * 1.3));
    const headFlats = Number(opts.acrossFlats ?? shankR * 3.2);
    const headMesh = hexNut({
      acrossFlats: headFlats,
      boreDiameter: 0,
      height: headH,
    });
    const headGeom = headMesh.geometry.clone();
    headGeom.translate(0, shankLen, 0);
    const shankGeom = new THREE.CylinderGeometry(shankR, shankR, shankLen, 32);
    shankGeom.translate(0, shankLen / 2, 0);
    const merged = mergeBufferGeometries([shankGeom, headGeom], THREE);
    return toHybridMesh(merged, opts.material ?? null, opts.name || 'hex_bolt');
  }

  function boltCircleFlange(opts = {}) {
    const rOut = Math.max(
      2,
      opts.outerDiameter != null
        ? Number(opts.outerDiameter) / 2
        : Number(opts.outerRadius ?? opts.radius ?? 45) || 45
    );
    const rIn = Math.max(
      0,
      Math.min(
        rOut - 1,
        opts.boreDiameter != null
          ? Number(opts.boreDiameter) / 2
          : opts.innerDiameter != null
          ? Number(opts.innerDiameter) / 2
          : Number(opts.boreRadius ?? opts.innerRadius ?? 0) || 0
      )
    );
    const H = Math.max(
      1,
      Number(opts.thickness ?? opts.height ?? opts.depth ?? 10) || 10
    );
    const bcdR =
      opts.boltCircleDiameter != null
        ? Number(opts.boltCircleDiameter) / 2
        : Number(opts.boltCircleRadius ?? (rOut + Math.max(rIn, rOut * 0.35)) * 0.5);
    const boltCount = clampInt(opts.boltCount ?? opts.holes, 0, 64, 0);
    const boltR = Math.max(
      0.5,
      opts.boltDiameter != null
        ? Number(opts.boltDiameter) / 2
        : Number(opts.boltRadius ?? opts.holeRadius ?? 3) || 3
    );

    const shape = new THREE.Shape();
    shape.absarc(0, 0, rOut, 0, Math.PI * 2, false);
    if (rIn > 0.2) {
      const centerHole = new THREE.Path();
      centerHole.absarc(0, 0, rIn, 0, Math.PI * 2, true);
      shape.holes.push(centerHole);
    }
    for (let i = 0; i < boltCount; i++) {
      const ang = (i / boltCount) * Math.PI * 2;
      const hx = Math.cos(ang) * bcdR;
      const hy = Math.sin(ang) * bcdR;
      if (Math.hypot(hx, hy) + boltR < rOut - 0.5 && Math.hypot(hx, hy) - boltR > rIn + 0.5) {
        const bh = new THREE.Path();
        bh.absarc(hx, hy, boltR, 0, Math.PI * 2, true);
        shape.holes.push(bh);
      }
    }

    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: H,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: Math.min(0.3, H * 0.08),
      bevelThickness: Math.min(0.3, H * 0.08),
      curveSegments: 64,
    });
    orientZExtrusionToYUp(geom, { centerY: Boolean(opts.centerY) });
    return toHybridMesh(geom, opts.material ?? null, opts.name || 'bolt_circle_flange');
  }

  // ---- 11. CSG Boolean Operations (BSP Triangle Clipping & Assembly Utilities) ----
  function extractGeometryAndMatrix(input) {
    if (!input) return null;
    if (input.isBufferGeometry && !input.isObject3D) {
      return input.clone();
    }
    if (input.isMesh && input.geometry) {
      input.updateMatrixWorld(true);
      const rawGeom = input.geometry.isMesh ? input.geometry.geometry : input.geometry;
      if (!rawGeom || !rawGeom.clone) return null;
      const g = rawGeom.clone();
      g.applyMatrix4(input.matrixWorld);
      return g;
    }
    if (input.isObject3D || input.isGroup) {
      input.updateMatrixWorld(true);
      const geoms = [];
      input.traverse((child) => {
        if (child.isMesh && child.geometry) {
          const rawGeom = child.geometry.isMesh ? child.geometry.geometry : child.geometry;
          if (rawGeom && rawGeom.clone) {
            const g = rawGeom.clone();
            g.applyMatrix4(child.matrixWorld);
            geoms.push(g);
          }
        }
      });
      return geoms.length ? mergeBufferGeometries(geoms, THREE) : null;
    }
    return null;
  }

  // Fast BSP / AABB triangle CSG subtraction & union so `CSG.subtract(meshA, meshB)` works cleanly.
  // NOTE: these are visual approximations (bounding-box / inscribed-cylinder culls plus merged
  // shells), not exact booleans, so results are tagged `csgApprox` for telemetry and STEP export.
  function markCsgApprox(mesh) {
    if (!mesh) return mesh;
    if (mesh.geometry) {
      mesh.geometry.userData = { ...(mesh.geometry.userData || {}), csgApprox: true };
    }
    mesh.userData = { ...(mesh.userData || {}), csgApprox: true };
    return mesh;
  }

  function booleanUnion(targetA, targetB, material = null) {
    const gA = extractGeometryAndMatrix(targetA);
    const gB = extractGeometryAndMatrix(targetB);
    const fallbackMat = material || (targetA && targetA.isMesh ? targetA.material : null);
    const name = (targetA && targetA.name) || 'csg_union';
    if (!gA && !gB) return markCsgApprox(toHybridMesh(new THREE.BoxGeometry(1, 1, 1), fallbackMat, name));
    if (!gA) return markCsgApprox(toHybridMesh(gB, fallbackMat, name));
    if (!gB) return markCsgApprox(toHybridMesh(gA, fallbackMat, name));
    const merged = mergeBufferGeometries([gA, gB], THREE);
    merged.computeVertexNormals();
    return markCsgApprox(toHybridMesh(merged, fallbackMat, name));
  }

  function booleanSubtract(targetA, cutterB, material = null) {
    const gA = extractGeometryAndMatrix(targetA);
    const gB = extractGeometryAndMatrix(cutterB);
    const fallbackMat = material || (targetA && targetA.isMesh ? targetA.material : null);
    const name = (targetA && targetA.name) || 'csg_subtract';
    if (!gA) return markCsgApprox(toHybridMesh(new THREE.BoxGeometry(1, 1, 1), fallbackMat, name));
    if (!gB) return markCsgApprox(toHybridMesh(gA, fallbackMat, name));

    gB.computeBoundingBox();
    const boxB = gB.boundingBox;
    if (!boxB) return markCsgApprox(toHybridMesh(gA, fallbackMat, name));

    // Expand slightly to avoid coplanar z-fighting
    const minX = boxB.min.x + 1e-4;
    const maxX = boxB.max.x - 1e-4;
    const minY = boxB.min.y + 1e-4;
    const maxY = boxB.max.y - 1e-4;
    const minZ = boxB.min.z + 1e-4;
    const maxZ = boxB.max.z - 1e-4;
    const centerX = 0.5 * (minX + maxX);
    const centerZ = 0.5 * (minZ + maxZ);
    const radiusXZ = 0.5 * Math.min(maxX - minX, maxZ - minZ);

    const nonIndexedA = gA.index ? gA.toNonIndexed() : gA.clone();
    const posA = nonIndexedA.attributes.position;
    const keptPositions = [];

    for (let i = 0; i < posA.count; i += 3) {
      if ((i & 4095) === 0) checkDeadline();
      const ax = posA.getX(i), ay = posA.getY(i), az = posA.getZ(i);
      const bx = posA.getX(i + 1), by = posA.getY(i + 1), bz = posA.getZ(i + 1);
      const cx = posA.getX(i + 2), cy = posA.getY(i + 2), cz = posA.getZ(i + 2);
      const mx = (ax + bx + cx) / 3;
      const my = (ay + by + cy) / 3;
      const mz = (az + bz + cz) / 3;

      const insideY = my >= minY && my <= maxY;
      const insideBox = mx >= minX && mx <= maxX && insideY && mz >= minZ && mz <= maxZ;
      const insideCyl = insideY && Math.hypot(mx - centerX, mz - centerZ) <= radiusXZ;

      if (!(insideBox && insideCyl)) {
        keptPositions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      }
    }

    // Invert cutterB side walls inside A's bounding box so the cavity wall is visible
    gA.computeBoundingBox();
    const boxA = gA.boundingBox;
    const nonIndexedB = gB.index ? gB.toNonIndexed() : gB.clone();
    const posB = nonIndexedB.attributes.position;
    for (let i = 0; i < posB.count; i += 3) {
      if ((i & 4095) === 0) checkDeadline();
      const ax = posB.getX(i), ay = posB.getY(i), az = posB.getZ(i);
      const bx = posB.getX(i + 1), by = posB.getY(i + 1), bz = posB.getZ(i + 1);
      const cx = posB.getX(i + 2), cy = posB.getY(i + 2), cz = posB.getZ(i + 2);
      const mx = (ax + bx + cx) / 3;
      const my = (ay + by + cy) / 3;
      const mz = (az + bz + cz) / 3;
      if (
        boxA &&
        mx >= boxA.min.x && mx <= boxA.max.x &&
        my >= boxA.min.y && my <= boxA.max.y &&
        mz >= boxA.min.z && mz <= boxA.max.z
      ) {
        // Flip winding order to face inward
        keptPositions.push(ax, ay, az, cx, cy, cz, bx, by, bz);
      }
    }

    if (keptPositions.length < 9) {
      return markCsgApprox(toHybridMesh(gA, fallbackMat, name));
    }

    const outGeom = new THREE.BufferGeometry();
    outGeom.setAttribute('position', new THREE.Float32BufferAttribute(keptPositions, 3));
    outGeom.computeVertexNormals();
    return markCsgApprox(toHybridMesh(outGeom, fallbackMat, name));
  }

  function booleanIntersect(targetA, targetB, material = null) {
    const gA = extractGeometryAndMatrix(targetA);
    const gB = extractGeometryAndMatrix(targetB);
    const fallbackMat = material || (targetA && targetA.isMesh ? targetA.material : null);
    const name = (targetA && targetA.name) || 'csg_intersect';
    if (!gA || !gB) return markCsgApprox(toHybridMesh(gA || gB || new THREE.BoxGeometry(1, 1, 1), fallbackMat, name));

    gB.computeBoundingBox();
    const boxB = gB.boundingBox;
    const nonIndexedA = gA.index ? gA.toNonIndexed() : gA.clone();
    const posA = nonIndexedA.attributes.position;
    const keptPositions = [];

    for (let i = 0; i < posA.count; i += 3) {
      if ((i & 4095) === 0) checkDeadline();
      const ax = posA.getX(i), ay = posA.getY(i), az = posA.getZ(i);
      const bx = posA.getX(i + 1), by = posA.getY(i + 1), bz = posA.getZ(i + 1);
      const cx = posA.getX(i + 2), cy = posA.getY(i + 2), cz = posA.getZ(i + 2);
      const mx = (ax + bx + cx) / 3;
      const my = (ay + by + cy) / 3;
      const mz = (az + bz + cz) / 3;
      if (
        boxB &&
        mx >= boxB.min.x && mx <= boxB.max.x &&
        my >= boxB.min.y && my <= boxB.max.y &&
        mz >= boxB.min.z && mz <= boxB.max.z
      ) {
        keptPositions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      }
    }

    if (keptPositions.length < 9) {
      return markCsgApprox(toHybridMesh(gA, fallbackMat, name));
    }

    const outGeom = new THREE.BufferGeometry();
    outGeom.setAttribute('position', new THREE.Float32BufferAttribute(keptPositions, 3));
    outGeom.computeVertexNormals();
    return markCsgApprox(toHybridMesh(outGeom, fallbackMat, name));
  }

  const CSG = {
    union: booleanUnion,
    subtract: booleanSubtract,
    intersect: booleanIntersect,
    difference: booleanSubtract,
  };

  const baseCAD = {
    spurGear,
    gear: spurGear,
    internalGear,
    ringGear: internalGear,
    rack,
    gearRack: rack,
    helicalThread,
    thread: helicalThread,
    screwThread: helicalThread,
    leadscrew: helicalThread,
    pipe,
    tube: pipe,
    hollowCylinder: pipe,
    bushing: pipe,
    sleeve: pipe,
    ring: pipe,
    washer: pipe,
    flange: pipe,
    revolveProfile,
    revolve: revolveProfile,
    lathe: revolveProfile,
    revolveHollow,
    hollowVessel: revolveHollow,
    vase: revolveHollow,
    extrudeWithHoles,
    plate: extrudeWithHoles,
    extrudePlate: extrudeWithHoles,
    flangePlate: extrudeWithHoles,
    roundedBox,
    box,
    cuboid: roundedBox,
    block: roundedBox,
    shellBox,
    enclosure: shellBox,
    hollowBox: shellBox,
    housingBox: shellBox,
    cylinder,
    sphere,
    cone,
    frustum: cone,
    torus,
    oRing: torus,
    capsule,
    hexNut,
    hexPrism: hexNut,
    nut: hexNut,
    hexBolt,
    bolt: hexBolt,
    socketCapScrew: hexBolt,
    boltCircleFlange,
    circularFlange: boltCircleFlange,
    draw,
    sketch: draw,
    booleanUnion,
    union: booleanUnion,
    booleanSubtract,
    subtract: booleanSubtract,
    difference: booleanSubtract,
    booleanIntersect,
    intersect: booleanIntersect,
    mergeGeometries: (geoms) => mergeBufferGeometries(geoms, THREE),
    materials,
    CSG,
    // Build watchdog state (see the budget helpers at the top of createCadKernel). The runner
    // arms these before each build; Infinity means "no deadline, budget not enforced".
    __deadline: Infinity,
    __triangleCount: 0,
    __triangleBudget: TRIANGLE_BUDGET,
  };

  const CAD_FUNCTION_NAMES = Object.keys(baseCAD).filter((k) => typeof baseCAD[k] === 'function');

  // Unknown members throw instead of being silently mapped onto a "close enough" primitive:
  // a typo like CAD.cubeWithHole(...) used to render a plain rounded box (and feed that into
  // telemetry and the Blind Judge). The explicit aliases in baseCAD are the supported names.
  const CAD = new Proxy(baseCAD, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      // Never behave like a thenable / custom-serializable object (await CAD, JSON.stringify).
      if (prop === 'then' || prop === 'toJSON' || prop === 'inspect') return undefined;
      throw new Error(
        `CAD.${prop} is not a kernel function; available: ${CAD_FUNCTION_NAMES.join(', ')}, materials.*, CSG.*`
      );
    },
  });

  return { CAD, CSG };
}

/**
 * Merges multiple BufferGeometries into a single non-indexed BufferGeometry.
 */
export function mergeBufferGeometries(geometries, THREE) {
  const valid = (geometries || [])
    .map((g) => (g && g.isMesh && g.geometry ? g.geometry : g))
    .filter((g) => g && g.attributes && g.attributes.position);
  if (valid.length === 0) return new THREE.BufferGeometry();
  if (valid.length === 1) return valid[0].clone();

  const positions = [];
  const normals = [];
  let hasNormals = true;

  for (const geom of valid) {
    const nonIdx = geom.index ? geom.toNonIndexed() : geom;
    const pos = nonIdx.attributes.position;
    const norm = nonIdx.attributes.normal;
    if (!norm) hasNormals = false;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (norm) {
        normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      }
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (hasNormals && normals.length === positions.length) {
    out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  } else {
    out.computeVertexNormals();
  }
  return out;
}

/**
 * Edge-manifold test for one mesh: every edge must be shared by exactly two triangles.
 * Vertices are merged by quantized world-space position (1e-4 mm) so the duplicated seam /
 * pole vertices that Three.js primitives emit do not count as open edges; zero-length
 * (degenerate) triangles are skipped the same way the STEP exporter skips them.
 * Returns { openEdges, degenerate } where openEdges is the number of edges whose face
 * count differs from 2 (0 means a closed, edge-manifold shell).
 */
const MANIFOLD_CHECK_MAX_TRIANGLES = 500000;
const EDGE_KEY_BASE = 16777216; // 2^24 vertex ids per edge key (safe up to 2^48)

export function countNonManifoldEdges(geometry, matrixWorld = null) {
  const pos = geometry && geometry.attributes && geometry.attributes.position;
  if (!pos || pos.count < 3) return { openEdges: 0, degenerate: 0 };
  const index = geometry.index;
  const triTotal = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
  const m = matrixWorld && matrixWorld.elements ? matrixWorld.elements : null;
  const vertexIds = new Map();
  const edgeCounts = new Map();
  let nextId = 0;
  let degenerate = 0;

  function vertexId(i) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    if (m) {
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      x = wx;
      y = wy;
      z = wz;
    }
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = nextId++;
      vertexIds.set(key, id);
    }
    return id;
  }

  function noteEdge(a, b) {
    const key = a < b ? a * EDGE_KEY_BASE + b : b * EDGE_KEY_BASE + a;
    edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
  }

  for (let t = 0; t < triTotal; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const a = vertexId(i0);
    const b = vertexId(i1);
    const c = vertexId(i2);
    if (a === b || b === c || c === a) {
      degenerate += 1;
      continue;
    }
    noteEdge(a, b);
    noteEdge(b, c);
    noteEdge(c, a);
  }

  let openEdges = 0;
  for (const n of edgeCounts.values()) {
    if (n !== 2) openEdges += 1;
  }
  return { openEdges, degenerate };
}

/**
 * Analyzes a Three.js Object3D / Group returned by buildModel(THREE, PARAMS, CAD)
 * and extracts engineering telemetry:
 *  - boundingBoxMm: [dx, dy, dz]
 *  - minMm / maxMm: [x, y, z]
 *  - partCount, partNames
 *  - triangleCount, vertexCount
 *  - volumeCm3, surfaceAreaCm2
 *  - watertight: true when every part is a closed edge-manifold shell (each edge shared by
 *    exactly two triangles), false when any part has open / non-manifold edges, and null
 *    when the model is too large (> 500k triangles) to verify within the build budget
 *  - nonManifoldEdges: total count of open / non-manifold edges across all parts
 *  - csgApprox: true when any part came out of the approximate CSG.* boolean helpers
 */
export function analyzeModelTelemetry(rootObject, THREE) {
  if (!rootObject || !THREE) {
    return {
      partCount: 0,
      partNames: [],
      triangleCount: 0,
      vertexCount: 0,
      boundingBoxMm: [0, 0, 0],
      volumeCm3: 0,
      surfaceAreaCm2: 0,
      watertight: false,
      nonManifoldEdges: 0,
      csgApprox: false,
    };
  }

  rootObject.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const partNames = [];
  const analyzedMeshes = [];
  let partCount = 0;
  let triangleCount = 0;
  let vertexCount = 0;
  let signedVolumeMm3 = 0;
  let surfaceAreaMm2 = 0;
  let degenerateTris = 0;
  let csgApprox = false;

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const cb = new THREE.Vector3();
  const ab = new THREE.Vector3();

  rootObject.traverse((child) => {
    if (!child || !child.isMesh || !child.geometry) return;
    if (child.userData && child.userData.isHelper) return;
    if (child.geometry.isMesh && child.geometry.geometry) {
      child.geometry = child.geometry.geometry;
    }

    const geom = child.geometry;
    const pos = geom.attributes && geom.attributes.position;
    if (!pos || pos.count < 3) return;

    partCount += 1;
    const rawName = (child.name || child.parent?.name || `part_${partCount}`).trim();
    const cleanName = rawName.replace(/\s+/g, '_');
    if (!partNames.includes(cleanName)) {
      partNames.push(cleanName);
    }

    box.expandByObject(child);
    vertexCount += pos.count;
    analyzedMeshes.push(child);
    if ((child.userData && child.userData.csgApprox) || (geom.userData && geom.userData.csgApprox)) {
      csgApprox = true;
    }

    const matWorld = child.matrixWorld;
    const index = geom.index;
    const triTotal = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    triangleCount += triTotal;

    for (let t = 0; t < triTotal; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;

      vA.fromBufferAttribute(pos, i0).applyMatrix4(matWorld);
      vB.fromBufferAttribute(pos, i1).applyMatrix4(matWorld);
      vC.fromBufferAttribute(pos, i2).applyMatrix4(matWorld);

      // Signed tetrahedron volume (1/6 * (vA . (vB x vC)))
      cb.crossVectors(vB, vC);
      signedVolumeMm3 += vA.dot(cb) / 6.0;

      // Triangle area (0.5 * |(vB - vA) x (vC - vA)|)
      ab.subVectors(vB, vA);
      cb.subVectors(vC, vA);
      cb.cross(ab);
      const area = 0.5 * cb.length();
      if (!Number.isFinite(area)) {
        degenerateTris += 1;
      } else if (area >= 1e-8) {
        surfaceAreaMm2 += area;
      }
    }
  });

  const size = new THREE.Vector3();
  if (!box.isEmpty()) {
    box.getSize(size);
  }

  const boundingBoxMm = [
    Number(size.x.toFixed(2)),
    Number(size.y.toFixed(2)),
    Number(size.z.toFixed(2)),
  ];
  const volumeCm3 = Number((Math.abs(signedVolumeMm3) / 1000.0).toFixed(2));
  const surfaceAreaCm2 = Number((surfaceAreaMm2 / 100.0).toFixed(2));

  // Edge-manifold pass (every edge shared by exactly 2 faces). Skipped above 500k triangles:
  // the hashed edge map would cost more than the build itself, so report "unverified" (null).
  let nonManifoldEdges = 0;
  let manifoldChecked = false;
  if (partCount > 0 && triangleCount <= MANIFOLD_CHECK_MAX_TRIANGLES) {
    manifoldChecked = true;
    for (const mesh of analyzedMeshes) {
      const res = countNonManifoldEdges(mesh.geometry, mesh.matrixWorld);
      nonManifoldEdges += res.openEdges;
    }
  }
  const hasSolidArea = volumeCm3 > 0.001 || surfaceAreaCm2 > 0.01;
  let watertight;
  if (partCount === 0 || triangleCount < 4) {
    watertight = false;
  } else if (!manifoldChecked) {
    watertight = null;
  } else {
    watertight = hasSolidArea && degenerateTris === 0 && nonManifoldEdges === 0;
  }

  return {
    partCount,
    partNames,
    triangleCount,
    vertexCount,
    boundingBoxMm,
    minMm: box.isEmpty()
      ? [0, 0, 0]
      : [Number(box.min.x.toFixed(2)), Number(box.min.y.toFixed(2)), Number(box.min.z.toFixed(2))],
    maxMm: box.isEmpty()
      ? [0, 0, 0]
      : [Number(box.max.x.toFixed(2)), Number(box.max.y.toFixed(2)), Number(box.max.z.toFixed(2))],
    volumeCm3,
    surfaceAreaCm2,
    watertight,
    nonManifoldEdges,
    csgApprox,
  };
}

/**
 * Flattens a live Three.js Object3D into worker-transferable triangle soups:
 *   [{ name, positions: Float32Array (9 floats per world-space triangle), csgApprox }]
 * Used by the runner to hand the model to cad-step-worker.js, and by buildStepExport itself.
 */
export function collectStepMeshes(rootObject, options = {}) {
  const meshes = [];
  if (!rootObject || typeof rootObject.traverse !== 'function') return meshes;
  // Convert Three.js Y-up (X right, Y top/up, Z front, X-Z origin grid at y=0) to
  // CAD / Fusion 360 Z-up (X right, Y = -Z_three, Z = +Y_three, X-Y origin plane at Z=0)
  // via a right-handed +90° X rotation (det = +1, preserving outward normals and CCW winding)
  // so the Top view of the Three.js render sits upright on Fusion 360's origin plane and
  // matches Fusion 360's Top ViewCube orientation.
  const zUp = options.zUp !== false;
  rootObject.updateMatrixWorld(true);
  let idx = 0;
  rootObject.traverse((child) => {
    if (!child || !child.isMesh || !child.geometry) return;
    if (child.userData && child.userData.isHelper) return;
    const geom = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry;
    const pos = geom.attributes && geom.attributes.position;
    if (!pos || pos.count < 3) return;
    idx += 1;
    const totalTris = Math.floor(pos.count / 3);
    const positions = new Float32Array(totalTris * 9);
    const m = child.matrixWorld.elements;
    for (let i = 0; i < totalTris * 3; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (zUp) {
        positions[i * 3] = wx;
        positions[i * 3 + 1] = -wz;
        positions[i * 3 + 2] = wy;
      } else {
        positions[i * 3] = wx;
        positions[i * 3 + 1] = wy;
        positions[i * 3 + 2] = wz;
      }
    }
    meshes.push({
      name: String(child.name || `Part_${idx}`),
      positions,
      csgApprox: Boolean(
        (child.userData && child.userData.csgApprox) ||
          (child.geometry.userData && child.geometry.userData.csgApprox)
      ),
    });
  });
  return meshes;
}

/**
 * Exports a Three.js Object3D / Group or triangle soup to ISO-10303-21 (STEP AP214)
 * faceted B-Rep exchange format so it opens natively in Autodesk Fusion 360,
 * SolidWorks, Onshape, and FreeCAD.
 *
 * Accepts either:
 *   - `meshesData`: Array<{ name: string, positions: Float32Array|number[] }> (worker-friendly)
 *   - or a live Three.js Object3D when `THREE` is available.
 *
 * Returns { stepText, warnings, parts }. Only parts that are exported at full resolution AND
 * pass the edge-manifold test are written as CLOSED_SHELL / MANIFOLD_SOLID_BREP solids;
 * decimated (stride > 1) or open meshes are written honestly as OPEN_SHELL /
 * SHELL_BASED_SURFACE_MODEL surface bodies and reported in `warnings`, so a CAD tool never
 * receives a "solid" whose faces do not close.
 */
export function buildStepExport(input, options = {}) {
  const productName = String(options.productName || 'LLM_Compare_CAD_Assembly').replace(
    /[^A-Za-z0-9_-]/g,
    '_'
  );
  const maxFacesPerPart = Math.max(100, Number(options.maxFacesPerPart) || 3500);
  const maxTotalFaces = Math.max(maxFacesPerPart, Number(options.maxTotalFaces) || 250000);
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, '');
  const warnings = [];

  // Normalize input into [{ name, triangles: [[x1,y1,z1, x2,y2,z2, x3,y3,z3], ...] }]
  const soups = Array.isArray(input) ? input : collectStepMeshes(input, options);
  const totalInputTris = soups.reduce(
    (sum, item) => sum + (item && item.positions ? Math.floor(item.positions.length / 9) : 0),
    0
  );
  const globalStride = Math.max(1, Math.ceil(totalInputTris / maxTotalFaces));
  const parts = [];
  for (let idx = 0; idx < soups.length; idx++) {
    const item = soups[idx];
    if (!item || !item.positions || item.positions.length < 9) continue;
    const pos = item.positions;
    const totalTris = Math.floor(pos.length / 9);
    const stride = Math.max(globalStride, Math.ceil(totalTris / maxFacesPerPart));
    const tris = [];
    for (let t = 0; t < totalTris; t += stride) {
      const base = t * 9;
      tris.push([
        pos[base], pos[base + 1], pos[base + 2],
        pos[base + 3], pos[base + 4], pos[base + 5],
        pos[base + 6], pos[base + 7], pos[base + 8],
      ]);
    }
    parts.push({
      name: String(item.name || `Part_${idx + 1}`).replace(/[^A-Za-z0-9_-]/g, '_'),
      triangles: tris,
      totalTriangles: totalTris,
      stride,
      decimated: stride > 1,
      csgApprox: Boolean(item.csgApprox),
    });
  }

  let eid = 1;
  const lines = [];
  function addEntity(expr) {
    const id = eid++;
    lines.push(`#${id} = ${expr};`);
    return id;
  }

  const appCtx = addEntity(
    "APPLICATION_CONTEXT('core data for automotive mechanical design processes')"
  );
  addEntity(
    `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`
  );
  const prodCtx = addEntity(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const prod = addEntity(`PRODUCT('${productName}','${productName}','',(#${prodCtx}))`);
  const pdf = addEntity(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${prod},.NOT_KNOWN.)`);
  const pdCtx = addEntity(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const pd = addEntity(`PRODUCT_DEFINITION('design','',#${pdf},#${pdCtx})`);
  const pds = addEntity(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);

  // Millimeter (mm) length unit, radian angle unit, steradian solid angle
  const lenUnit = addEntity(
    "( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )"
  );
  const angUnit = addEntity(
    "( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )"
  );
  const solidAngUnit = addEntity(
    "( NAMED_UNIT(*) SOLID_ANGLE_UNIT() SI_UNIT($,.STERADIAN.) )"
  );
  const unc = addEntity(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-04),#${lenUnit},'distance_accuracy_value','confusion accuracy')`
  );
  const geomCtx = addEntity(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnit},#${angUnit},#${solidAngUnit})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') )`
  );

  const originPt = addEntity("CARTESIAN_POINT('',(0.,0.,0.))");
  const dirZ = addEntity("DIRECTION('',(0.,0.,1.))");
  const dirX = addEntity("DIRECTION('',(1.,0.,0.))");
  const axisPlacement = addEntity(`AXIS2_PLACEMENT_3D('',#${originPt},#${dirZ},#${dirX})`);

  // Deduplicate vertices with 0.0001 mm spatial quantization
  const vertexMap = new Map();
  function getVertexEntry(x, y, z) {
    const qx = Number(x.toFixed(4));
    const qy = Number(y.toFixed(4));
    const qz = Number(z.toFixed(4));
    const key = `${qx},${qy},${qz}`;
    let entry = vertexMap.get(key);
    if (!entry) {
      const cpId = addEntity(`CARTESIAN_POINT('',(${qx},${qy},${qz}))`);
      const vId = addEntity(`VERTEX_POINT('',#${cpId})`);
      entry = { cpId, vId, x: qx, y: qy, z: qz };
      vertexMap.set(key, entry);
    }
    return entry;
  }

  const shellIds = [];
  let solidCount = 0;
  let surfaceCount = 0;
  for (const part of parts) {
    const faceIds = [];
    // Edge-manifold bookkeeping on the deduplicated STEP vertex ids: a shell may only be
    // declared CLOSED when every edge is shared by exactly two faces.
    const edgeCounts = new Map();
    const noteEdge = (a, b) => {
      const key = a < b ? a * EDGE_KEY_BASE + b : b * EDGE_KEY_BASE + a;
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    };
    for (const tri of part.triangles) {
      const [x0, y0, z0, x1, y1, z1, x2, y2, z2] = tri;
      // Compute face normal and in-plane orthogonal reference direction
      const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
      const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      const uLen = Math.hypot(ux, uy, uz);
      if (len < 1e-8 || uLen < 1e-8) continue;
      nx = Number((nx / len).toFixed(5));
      ny = Number((ny / len).toFixed(5));
      nz = Number((nz / len).toFixed(5));
      const tx = Number((ux / uLen).toFixed(5));
      const ty = Number((uy / uLen).toFixed(5));
      const tz = Number((uz / uLen).toFixed(5));

      const e0 = getVertexEntry(x0, y0, z0);
      const e1 = getVertexEntry(x1, y1, z1);
      const e2 = getVertexEntry(x2, y2, z2);
      const v0 = e0.vId, v1 = e1.vId, v2 = e2.vId;
      if (v0 === v1 || v1 === v2 || v2 === v0) continue;
      noteEdge(v0, v1);
      noteEdge(v1, v2);
      noteEdge(v2, v0);

      const loopId = addEntity(`POLY_LOOP('',(#${e0.cpId},#${e1.cpId},#${e2.cpId}))`);
      const boundId = addEntity(`FACE_OUTER_BOUND('',#${loopId},.T.)`);
      const nDir = addEntity(`DIRECTION('',(${nx},${ny},${nz}))`);
      const tDir = addEntity(`DIRECTION('',(${tx},${ty},${tz}))`);
      const planeAxis = addEntity(`AXIS2_PLACEMENT_3D('',#${e0.cpId},#${nDir},#${tDir})`);
      const planeId = addEntity(`PLANE('',#${planeAxis})`);
      const faceId = addEntity(`ADVANCED_FACE('',(#${boundId}),#${planeId},.T.)`);
      faceIds.push(`#${faceId}`);
    }

    if (faceIds.length === 0) continue;
    let openEdges = 0;
    for (const n of edgeCounts.values()) {
      if (n !== 2) openEdges += 1;
    }
    part.openEdges = openEdges;
    part.faces = faceIds.length;
    part.closed = !part.decimated && openEdges === 0;

    if (part.closed) {
      const closedShellId = addEntity(`CLOSED_SHELL('${part.name}',(${faceIds.join(',')}))`);
      const brepId = addEntity(`MANIFOLD_SOLID_BREP('${part.name}',#${closedShellId})`);
      shellIds.push(`#${brepId}`);
      solidCount += 1;
    } else {
      const openShellId = addEntity(`OPEN_SHELL('${part.name}',(${faceIds.join(',')}))`);
      const surfId = addEntity(`SHELL_BASED_SURFACE_MODEL('${part.name}',(#${openShellId}))`);
      shellIds.push(`#${surfId}`);
      surfaceCount += 1;
      if (part.decimated) {
        warnings.push(
          `${part.name}: decimated 1:${part.stride} (${faceIds.length} of ${part.totalTriangles} triangles kept), exported as an OPEN_SHELL surface body, not a solid`
        );
      } else {
        warnings.push(
          `${part.name}: mesh has ${openEdges} open or non-manifold edges, exported as an OPEN_SHELL surface body, not a solid`
        );
      }
    }
    if (part.csgApprox) {
      warnings.push(`${part.name}: boolean (CSG) result is an approximation, verify the cut geometry in your CAD tool`);
    }
  }
  if (surfaceCount > 0) {
    warnings.push(
      `${surfaceCount} of ${solidCount + surfaceCount} bodies are surface models: use Stitch / Convert to Solid in Fusion 360, SolidWorks or FreeCAD`
    );
  }

  // Pick the representation entity that matches the content so the file stays schema-valid:
  // ADVANCED_BREP_SHAPE_REPRESENTATION may only carry solids, MANIFOLD_SURFACE_SHAPE_REPRESENTATION
  // only surface models; mixed content falls back to the generic SHAPE_REPRESENTATION.
  const repItems = [`#${axisPlacement}`, ...shellIds];
  const repEntity =
    surfaceCount === 0
      ? 'ADVANCED_BREP_SHAPE_REPRESENTATION'
      : solidCount === 0
      ? 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION'
      : 'SHAPE_REPRESENTATION';
  const shapeRep = addEntity(
    `${repEntity}('${productName}',(${repItems.join(',')}),#${geomCtx})`
  );
  addEntity(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${shapeRep})`);

  const stepText = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('LLM Compare 3D & CAD Arena Export - ISO 10303-21 AP214'),'2;1');",
    `FILE_NAME('${productName}.step','${timestamp}',('LLM Compare 3D Arena'),('Google Cloud CE'),'cad-kernel.js v1.0.49','LLM Compare CAD Studio','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');

  return {
    stepText,
    warnings,
    parts: parts.map((p) => ({
      name: p.name,
      faces: p.faces || 0,
      totalTriangles: p.totalTriangles,
      stride: p.stride,
      decimated: p.decimated,
      closed: Boolean(p.closed),
      openEdges: p.openEdges || 0,
      csgApprox: p.csgApprox,
    })),
  };
}

/**
 * Backward-compatible string export (same inputs as buildStepExport). Prefer buildStepExport
 * when you need the `warnings` list to show the user before download.
 */
export function exportModelToSTEP(input, options = {}) {
  return buildStepExport(input, options).stepText;
}
