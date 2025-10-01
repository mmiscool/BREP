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
};

export class PatternLinearFeature {
  static featureName = "Pattern Linear";
  static featureShortName = "PATLIN";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const raw = Array.isArray(this.inputParams.solids) ? this.inputParams.solids.filter(Boolean) : [];
    const solids = [];
    for (const o of raw) {
      if (!o) continue;
      if (o.type === 'SOLID') solids.push(o);
      else if (o.parentSolid && o.parentSolid.type === 'SOLID') solids.push(o.parentSolid);
      else if (o.parent && o.parent.type === 'SOLID') solids.push(o.parent);
    }
    if (!solids.length) return [];

    const count = Math.max(1, (this.inputParams.count | 0));
    const d = toVec3(this.inputParams.offset?.position, 10, 0, 0);

    const instances = [];
    const featureID = this.inputParams.featureID || PatternLinearFeature.featureShortName || 'PatternLinear';
    for (const src of solids) {
      for (let i = 1; i <= count - 1; i++) {
        const t = new THREE.Matrix4().makeTranslation(d.x * i, d.y * i, d.z * i);
        const c = src.clone();
        c.bakeTransform(t);
        const idx = i + 1;
        try { retagSolidFaces(c, `${featureID}_${idx}`); } catch (_) {}
        c.name = `${featureID}_${idx}`;
        c.visualize();
        instances.push(c);
      }
    }
    return instances;
  }
}

function toVec3(v, dx, dy, dz) {
  if (Array.isArray(v)) return new THREE.Vector3(v[0] ?? dx, v[1] ?? dy, v[2] ?? dz);
  if (v && typeof v === 'object') return new THREE.Vector3(v.x ?? dx, v.y ?? dy, v.z ?? dz);
  return new THREE.Vector3(dx, dy, dz);
}

function retagSolidFaces(solid, suffix) {
  if (!solid || !suffix) return;
  try {
    const { Manifold } = manifold;
    const oldIdToFace = (solid._idToFaceName instanceof Map) ? solid._idToFaceName : new Map();
    const triIDs = Array.isArray(solid._triIDs) ? solid._triIDs : [];
    // Build set of IDs present (prefer map keys, fall back to triIDs)
    const presentIDs = new Set();
    for (const k of oldIdToFace.keys()) presentIDs.add(k);
    if (presentIDs.size === 0 && triIDs.length) { for (const id of triIDs) presentIDs.add(id >>> 0); }

    // Map oldID -> newID; and build new maps with tagged names
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

    // Remap per-triangle IDs
    if (triIDs.length && idRemap.size) {
      for (let i = 0; i < triIDs.length; i++) {
        const oldID = triIDs[i] >>> 0;
        const mapped = idRemap.get(oldID);
        if (mapped !== undefined) triIDs[i] = mapped;
      }
      solid._triIDs = triIDs;
      solid._dirty = true; // force rebuild so MeshGL.faceID updates
    }

    solid._idToFaceName = newIdToFace;
    solid._faceNameToID = newFaceToId;
  } catch (_) { /* best-effort */ }
}
