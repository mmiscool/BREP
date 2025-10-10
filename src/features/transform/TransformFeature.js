import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;

const inputParamsSchema = {
  solids: {
    type: "reference_selection",
    selectionFilter: ["SOLID"],
    multiple: true,
    default_value: [],
    hint: "Select solids to transform",
  },
  space: {
    type: "options",
    options: ["WORLD", "LOCAL"],
    default_value: "WORLD",
    hint: "Interpret translation/rotation in WORLD or LOCAL space",
  },
  pivot: {
    type: "options",
    options: ["ORIGIN", "BBOX_CENTER"],
    default_value: "ORIGIN",
    hint: "Pivot point for rotation/scale",
  },
  translate: {
    type: "vec3",
    default_value: [0, 0, 0],
    hint: "Translation [x,y,z]",
  },
  rotateEulerDeg: {
    type: "vec3",
    default_value: [0, 0, 0],
    hint: "Rotation in degrees [rx,ry,rz] about pivot (XYZ order)",
  },
  scale: {
    type: "vec3",
    default_value: [1, 1, 1],
    hint: "Non-uniform scale [sx,sy,sz] about pivot",
    step: 0.1,
    uniformToggle: true,
    uniformDefault: true,
    uniformLockLabel: 'Uniform scale',
  },
  copy: {
    type: "boolean",
    default_value: false,
    label: "Copy",
    hint: "Create a new transformed copy; keep the original",
  },
};

export class TransformFeature {
  static featureName = "Transform";
  static featureShortName = "XFORM";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const solids = Array.isArray(this.inputParams.solids) ? this.inputParams.solids.filter(s => s && s.type === 'SOLID') : [];
    if (!solids.length) return { added: [], removed: [] };

    const space = (this.inputParams.space || 'WORLD').toUpperCase();
    const pivot = (this.inputParams.pivot || 'ORIGIN').toUpperCase();
    const t = toVec3(this.inputParams.translate, 0, 0, 0);
    const rDeg = toVec3(this.inputParams.rotateEulerDeg, 0, 0, 0);
    const s = toVec3(this.inputParams.scale, 1, 1, 1);
    const copy = !!this.inputParams.copy;
    const replace = !copy;

    const out = [];
    const removed = [];
    for (const src of solids) {
      const dst = src.clone();

      // Compute pivot point in world
      const pivotPoint = (pivot === 'BBOX_CENTER') ? bboxCenterWorld(src) : new THREE.Vector3(0, 0, 0);

      // Build rotation and scale in requested space
      const eulerRad = new THREE.Euler(
        THREE.MathUtils.degToRad(rDeg.x),
        THREE.MathUtils.degToRad(rDeg.y),
        THREE.MathUtils.degToRad(rDeg.z),
        'XYZ'
      );
      const quat = new THREE.Quaternion().setFromEuler(eulerRad);
      const scl = new THREE.Vector3(s.x, s.y, s.z);

      // Construct matrix with pivot: T * Tr(pivot) * R * S * Tr(-pivot)
      const M = new THREE.Matrix4();
      const Tpivot = new THREE.Matrix4().makeTranslation(pivotPoint.x, pivotPoint.y, pivotPoint.z);
      const Tnp = new THREE.Matrix4().makeTranslation(-pivotPoint.x, -pivotPoint.y, -pivotPoint.z);
      const RS = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), quat, scl);
      const Tmove = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z);

      if (space === 'LOCAL') {
        // Translate in local space of src: convert local move to world by applying src's world matrix
        const localDir = new THREE.Vector3(t.x, t.y, t.z).applyMatrix3(new THREE.Matrix3().setFromMatrix4(src.matrixWorld));
        Tmove.setPosition(localDir);
      }

      M.multiply(Tmove).multiply(Tpivot).multiply(RS).multiply(Tnp);

      dst.bakeTransform(M); // bake into geometry arrays
      if (replace) {
        // Keep the original name when replacing
        dst.name = src.name || dst.name || 'Solid';
      } else {
        // Name copies with _COPY suffix
        const base = src.name || 'Solid';
        dst.name = base.endsWith('_COPY') ? base : `${base}_COPY`;
      }
      dst.visualize();

      if (replace) {
        try { src.__removeFlag = true; } catch {}
        removed.push(src);
      }
      out.push(dst);
    }
    return { added: out, removed };
  }
}

function toVec3(v, dx, dy, dz) {
  if (Array.isArray(v)) return new THREE.Vector3(v[0] ?? dx, v[1] ?? dy, v[2] ?? dz);
  if (v && typeof v === 'object') return new THREE.Vector3(v.x ?? dx, v.y ?? dy, v.z ?? dz);
  return new THREE.Vector3(dx, dy, dz);
}

function bboxCenterWorld(solid) {
  const mesh = solid.getMesh();
  try {
    const vp = mesh.vertProperties;
    if (!vp || vp.length < 3) return new THREE.Vector3(0, 0, 0);
    const bbMin = new THREE.Vector3(+Infinity, +Infinity, +Infinity);
    const bbMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < vp.length; i += 3) {
      const x = vp[i + 0], y = vp[i + 1], z = vp[i + 2];
      bbMin.x = Math.min(bbMin.x, x); bbMin.y = Math.min(bbMin.y, y); bbMin.z = Math.min(bbMin.z, z);
      bbMax.x = Math.max(bbMax.x, x); bbMax.y = Math.max(bbMax.y, y); bbMax.z = Math.max(bbMax.z, z);
    }
    return bbMin.add(bbMax).multiplyScalar(0.5);
  } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
}
