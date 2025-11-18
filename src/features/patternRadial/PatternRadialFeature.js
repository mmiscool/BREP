import { BREP } from "../../BREP/BREP.js";
import { Manifold } from "../../BREP/SolidShared.js";
const THREE = BREP.THREE;

const inputParamsSchema = {
  id: {
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
  // Radial params (similar to Revolve)
  axisRef: {
    type: "reference_selection",
    selectionFilter: ["EDGE"],
    multiple: false,
    default_value: null,
    label: 'Axis',
    hint: "Select an EDGE to define the radial axis",
  },
  centerOffset: {
    type: "number",
    default_value: 0,
    label: 'Axis Offset',
    hint: "Offset along axis from reference origin to pattern center",
  },
  count: {
    type: "number",
    default_value: 3,
    step: 1,
    label: 'Instances',
    hint: "Instance count (>= 1)",
  },
  totalAngleDeg: {
    type: "number",
    default_value: 360,
    label: 'Angle (deg)',
    hint: "Total sweep angle",
  },
};

export class PatternRadialFeature {
  static shortName = "PATRAD";
  static longName = "Pattern Radial";
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
    if (!solids.length) return { added: [], removed: [] };

    const count = Math.max(1, (this.inputParams.count | 0));
    const totalAngleDeg = Number(this.inputParams.totalAngleDeg) || 360;
    const centerOffset = Number(this.inputParams.centerOffset) || 0;
    const ref = Array.isArray(this.inputParams.axisRef) ? this.inputParams.axisRef[0] : this.inputParams.axisRef;
    const axisInfo = computeAxisFromEdge(ref);
    const axis = axisInfo?.dir || new THREE.Vector3(0, 1, 0);
    const center = (axisInfo?.point || new THREE.Vector3()).clone().addScaledVector(axis, centerOffset || 0);

    const instances = [];
    const fallbackId = PatternRadialFeature.shortName || PatternRadialFeature.longName || 'PatternRadial';
    const featureID = this.inputParams.featureID || fallbackId;
    const step = (count <= 1) ? 0 : THREE.MathUtils.degToRad(totalAngleDeg) / count;
    for (const src of solids) {
      for (let i = 1; i <= count - 1; i++) {
        const theta = step * i;
        const q = new THREE.Quaternion().setFromAxisAngle(axis, theta);
        const RS = new THREE.Matrix4().makeRotationFromQuaternion(q);
        const T1 = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
        const T0 = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
        const M = new THREE.Matrix4().multiply(T1).multiply(RS).multiply(T0);

        const c = src.clone();
        c.bakeTransform(M);
        const idx = i + 1;
        try { retagSolidFaces(c, `${featureID}_${idx}`); } catch (_) {}
        c.name = `${featureID}_${idx}`;
        c.visualize();
        instances.push(c);
      }
    }
    return { added: instances, removed: [] };
  }
}

function computeAxisFromEdge(edgeObj) {
  if (!edgeObj) return null;
  const THREE = BREP.THREE;
  const mat = edgeObj.matrixWorld;
  let A = new THREE.Vector3(0, 0, 0), B = new THREE.Vector3(0, 1, 0);
  // 1) Prefer cached polyline from visualize()
  const cached = edgeObj?.userData?.polylineLocal;
  const isWorld = !!(edgeObj?.userData?.polylineWorld);
  if (Array.isArray(cached) && cached.length >= 2) {
    const pick = [];
    for (let i = 0; i < cached.length && pick.length < 2; i++) {
      const p = cached[i];
      if (!pick.length) { pick.push(p); continue; }
      const q = pick[0];
      if (Math.abs(p[0] - q[0]) > 1e-12 || Math.abs(p[1] - q[1]) > 1e-12 || Math.abs(p[2] - q[2]) > 1e-12) pick.push(p);
    }
    if (pick.length >= 2) {
      if (isWorld) {
        A.set(pick[0][0], pick[0][1], pick[0][2]);
        B.set(pick[1][0], pick[1][1], pick[1][2]);
      } else {
        A.set(pick[0][0], pick[0][1], pick[0][2]).applyMatrix4(mat);
        B.set(pick[1][0], pick[1][1], pick[1][2]).applyMatrix4(mat);
      }
    }
  } else {
    // 2) Fat-line instanceStart/instanceEnd
    const aStart = edgeObj?.geometry?.attributes?.instanceStart;
    const aEnd = edgeObj?.geometry?.attributes?.instanceEnd;
    if (aStart && aEnd && aStart.count >= 1) {
      const s = new THREE.Vector3(aStart.getX(0), aStart.getY(0), aStart.getZ(0)).applyMatrix4(mat);
      const e = new THREE.Vector3(aEnd.getX(0), aEnd.getY(0), aEnd.getZ(0)).applyMatrix4(mat);
      A.copy(s); B.copy(e);
    } else {
      // 3) Positions
      const pos = edgeObj?.geometry?.getAttribute?.('position');
      if (pos && pos.count >= 2) {
        const s = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0)).applyMatrix4(mat);
        const e = new THREE.Vector3(pos.getX(pos.count - 1), pos.getY(pos.count - 1), pos.getZ(pos.count - 1)).applyMatrix4(mat);
        A.copy(s); B.copy(e);
      }
    }
  }
  const dir = B.clone().sub(A);
  if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0); else dir.normalize();
  return { point: A, dir };
}

function retagSolidFaces(solid, suffix) {
  if (!solid || !suffix) return;
  try {
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
