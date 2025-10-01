import { BREP } from "../../BREP/BREP.js";
import manifold from "../../BREP/setupManifold.js";
const THREE = BREP.THREE;

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the pattern feature",
  },
  solids: {
    type: "reference_selection",
    selectionFilter: ["SOLID"],
    multiple: true,
    default_value: [],
    hint: "Select solids to pattern",
  },
  mode: {
    type: "options",
    options: ["LINEAR", "CIRCULAR"],
    default_value: "LINEAR",
    hint: "Pattern type",
  },
  // Linear params
  count: {
    type: "number",
    default_value: 3,
    step: 1,
    hint: "Instance count (>= 1)",
  },
  offset: {
    type: "transform",
    default_value: { position: [10, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    label: "Offset (use gizmo)",
    hint: "Use Move gizmo to set direction and distance (position only)",
  },
  // Circular params
  axisRef: {
    type: "reference_selection",
    selectionFilter: ["FACE", "PLANE"],
    multiple: false,
    default_value: null,
    hint: "Axis reference (FACE normal or plane normal through its centroid)",
  },
  centerOffset: {
    type: "number",
    default_value: 0,
    hint: "Offset along axis from reference origin to pattern center",
  },
  totalAngleDeg: {
    type: "number",
    default_value: 360,
    hint: "Total sweep angle for CIRCULAR",
  },
  booleanMode: {
    type: "options",
    options: ["NONE", "UNION"],
    default_value: "NONE",
    hint: "Optionally union instances together",
  },
};

export class PatternFeature {
  static featureName = "Pattern";
  static featureShortName = "PATTERN";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    // Tolerant: accept SOLID directly, or objects with parentSolid
    const raw = Array.isArray(this.inputParams.solids) ? this.inputParams.solids.filter(Boolean) : [];
    const solids = [];
    for (const o of raw) {
      if (!o) continue;
      if (o.type === 'SOLID') solids.push(o);
      else if (o.parentSolid && o.parentSolid.type === 'SOLID') solids.push(o.parentSolid);
      else if (o.parent && o.parent.type === 'SOLID') solids.push(o.parent);
    }
    if (solids.length === 0) {
      console.warn('[PatternFeature] No solids resolved from selection.');
    }
    if (!solids.length) return [];

    const mode = (this.inputParams.mode || 'LINEAR').toUpperCase();
    const count = Math.max(1, (this.inputParams.count | 0));
    const booleanMode = (this.inputParams.booleanMode || 'NONE').toUpperCase();

    // Fallbacks: if no solids resolved, try currently selected solids; else last SOLID in scene
    let sources = solids;
    if (!sources.length && partHistory && partHistory.scene) {
      try {
        const selected = [];
        partHistory.scene.traverse((o) => { if (o && o.type === 'SOLID' && o.selected) selected.push(o); });
        if (selected.length) sources = selected;
      } catch (_) { /* ignore */ }
      if (!sources.length) {
        try {
          const solidsInScene = partHistory.scene.children.filter(ch => ch && ch.type === 'SOLID');
          if (solidsInScene.length) sources = [solidsInScene[solidsInScene.length - 1]]; // most recent
        } catch (_) { /* ignore */ }
      }
      if (!sources.length) console.warn('[PatternFeature] No sources available (selection and scene empty).');
    }

    // BOOLEAN UNION: fuse each source with its generated clones and replace original
    if (booleanMode === 'UNION') {
      const out = [];
      for (const src of sources) {
        const clones = (mode === 'LINEAR')
          ? this.#linearPattern(src, count, (this.inputParams.offset && this.inputParams.offset.position) || [10, 0, 0], /*doVisualize*/ false)
          : this.#circularPattern(src, count, this.inputParams.axisRef, Number(this.inputParams.totalAngleDeg) || 360, Number(this.inputParams.centerOffset) || 0, /*doVisualize*/ false);

        let acc = src;
        for (const c of clones) acc = acc.union(c);
        acc.name = `${src.name || 'Pattern'}::UNION`;
        acc.visualize();
        try { src.__removeFlag = true; } catch {}
        out.push(acc);
      }
      try { console.log('[PatternFeature] Union complete for', sources.length, 'source(s).'); } catch {}
      return out;
    }

    // NON-BOOLEAN: return clones as separate bodies
    const instances = [];
    for (const src of sources) {
      const clones = (mode === 'LINEAR')
        ? this.#linearPattern(src, count, (this.inputParams.offset && this.inputParams.offset.position) || [10, 0, 0])
        : this.#circularPattern(src, count, this.inputParams.axisRef, Number(this.inputParams.totalAngleDeg) || 360, Number(this.inputParams.centerOffset) || 0);
      for (const c of clones) instances.push(c);
    }
    try { console.log(`[PatternFeature] Created ${instances.length} instances (no union).`); } catch {}
    return instances;
  }

  #linearPattern(src, count, deltaPos, doVisualize = true) {
    const d = toVec3(deltaPos, 10, 0, 0);
    const out = [];
    for (let i = 1; i <= count - 1; i++) {
      const t = new THREE.Matrix4().makeTranslation(d.x * i, d.y * i, d.z * i);
      const c = src.clone();
      c.bakeTransform(t);
      const featureID = this.inputParams.featureID || PatternFeature.featureShortName || 'Pattern';
      const idx = i + 1;
      try { retagSolidFaces(c, `${featureID}_${idx}`); } catch (_) {}
      c.name = `${featureID}_${idx}`;
      if (doVisualize) c.visualize();
      out.push(c);
    }
    return out;
  }

  #circularPattern(src, count, axisRef, totalAngleDeg, centerOffset, doVisualize = true) {
    // Determine axis and center from reference
    const ref = Array.isArray(axisRef) ? axisRef[0] : axisRef;
    const plane = computeRefPlane(ref);
    const axis = plane?.normal || new THREE.Vector3(0, 1, 0);
    const center = (plane?.point || new THREE.Vector3()).clone().addScaledVector(axis, centerOffset || 0);

    const out = [];
    const step = (count <= 1) ? 0 : THREE.MathUtils.degToRad(totalAngleDeg) / count;
    for (let i = 1; i <= count - 1; i++) {
      const theta = step * i;
      const q = new THREE.Quaternion().setFromAxisAngle(axis, theta);
      const RS = new THREE.Matrix4().makeRotationFromQuaternion(q);
      const T1 = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
      const T0 = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
      const M = new THREE.Matrix4().multiply(T1).multiply(RS).multiply(T0);

      const c = src.clone();
      c.bakeTransform(M);
      const featureID = this.inputParams.featureID || PatternFeature.featureShortName || 'Pattern';
      const idx = i + 1;
      try { retagSolidFaces(c, `${featureID}_${idx}`); } catch (_) {}
      c.name = `${featureID}_${idx}`;
      if (doVisualize) c.visualize();
      out.push(c);
    }
    return out;
  }
}

function toVec3(v, dx, dy, dz) {
  if (Array.isArray(v)) return new THREE.Vector3(v[0] ?? dx, v[1] ?? dy, v[2] ?? dz);
  if (v && typeof v === 'object') return new THREE.Vector3(v.x ?? dx, v.y ?? dy, v.z ?? dz);
  return new THREE.Vector3(dx, dy, dz);
}

function computeRefPlane(refObj) {
  if (!refObj) return null;
  // FACE: use area-weighted centroid and average normal
  if (refObj.type === 'FACE' && refObj.geometry) {
    const pos = refObj.geometry.getAttribute('position');
    if (!pos || pos.count < 3) return null;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    const nAccum = new THREE.Vector3();
    let areaSum = 0;
    const toWorld = (out, i) => out.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(refObj.matrixWorld);
    const triCount = (pos.count / 3) | 0;
    for (let t = 0; t < triCount; t++) {
      const i0 = 3 * t + 0, i1 = 3 * t + 1, i2 = 3 * t + 2;
      toWorld(a, i0); toWorld(b, i1); toWorld(c, i2);
      const ab = new THREE.Vector3().subVectors(b, a);
      const ac = new THREE.Vector3().subVectors(c, a);
      const cross = new THREE.Vector3().crossVectors(ac, ab);
      const triArea = 0.5 * cross.length();
      if (triArea > 0) {
        centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        nAccum.add(cross);
        areaSum += triArea;
      }
    }
    if (areaSum <= 0 || nAccum.lengthSq() === 0) return null;
    const point = centroid.multiplyScalar(1); // centroid from last tri (good enough for axis ref)
    const normal = nAccum.normalize();
    return { point, normal };
  }

  // PLANE: use world position and +Z direction transformed by world quaternion
  try {
    const point = new THREE.Vector3();
    refObj.getWorldPosition(point);
    const q = new THREE.Quaternion();
    refObj.getWorldQuaternion(q);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    return { point, normal };
  } catch (_) { return null; }
}

// Retag all face labels in a Solid with a unique suffix so IDs remain distinct
// across patterned instances when booleaned together.
function retagSolidFaces(solid, suffix) {
  if (!solid || !suffix) return;
  try {
    const { Manifold } = manifold;
    const oldIdToFace = (solid._idToFaceName instanceof Map) ? solid._idToFaceName : new Map();
    const triIDs = Array.isArray(solid._triIDs) ? solid._triIDs : [];
    const presentIDs = new Set();
    for (const k of oldIdToFace.keys()) presentIDs.add(k);
    if (presentIDs.size === 0 && triIDs.length) { for (const id of triIDs) presentIDs.add(id >>> 0); }

    const idRemap = new Map();
    const newIdToFace = new Map();
    const newFaceToId = new Map();
    for (const oldID of presentIDs) {
      const fname = oldIdToFace.get(oldID);
      const base = (fname != null) ? String(fname) : `FACE_${oldID}`;
      const tagged = `${base}::${suffix}`;
      const newID = Manifold.reserveIDs(1);
      idRemap.set(oldID, newID);
      newIdToFace.set(newID, tagged);
      newFaceToId.set(tagged, newID);
    }

    if (triIDs.length && idRemap.size) {
      for (let i = 0; i < triIDs.length; i++) {
        const oldID = triIDs[i] >>> 0;
        const mapped = idRemap.get(oldID);
        if (mapped !== undefined) triIDs[i] = mapped;
      }
      solid._triIDs = triIDs;
      solid._dirty = true;
    }

    solid._idToFaceName = newIdToFace;
    solid._faceNameToID = newFaceToId;
  } catch (_) { /* best-effort */ }
}
