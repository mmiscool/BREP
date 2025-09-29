import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;

const inputParamsSchema = {
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
    for (const src of solids) {
      for (let i = 1; i <= count; i++) {
        const t = new THREE.Matrix4().makeTranslation(d.x * i, d.y * i, d.z * i);
        const c = src.clone();
        c.bakeTransform(t);
        try { retagSolidFaces(c, `PAT_LIN_${i}`); } catch (_) {}
        c.name = `${src.name || 'Solid'}::PAT_LIN_${i}`;
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
    const srcMap = solid._idToFaceName instanceof Map ? solid._idToFaceName : null;
    if (!srcMap) return;
    const newIdToFace = new Map();
    const newFaceToId = new Map();
    for (const [fid, fname] of srcMap.entries()) {
      const base = (fname != null) ? String(fname) : `FACE_${fid}`;
      const tagged = `${base}::${suffix}`;
      newIdToFace.set(fid, tagged);
      newFaceToId.set(tagged, fid);
    }
    solid._idToFaceName = newIdToFace;
    solid._faceNameToID = newFaceToId;
  } catch (_) { /* best-effort */ }
}

