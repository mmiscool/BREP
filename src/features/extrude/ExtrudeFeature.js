import { BREP } from "../../BREP/BREP.js";

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the extrude feature",
  },
  profile: {
    type: "reference_selection",
    selectionFilter: ["FACE", "SKETCH"],
    multiple: false,
    default_value: null,
    hint: "Select the profile to extrude",
  },
  distance: {
    type: "number",
    default_value: 1,
    hint: "Extrude distance when no path is provided",
  },
  distanceBack: {
    type: "number",
    default_value: 0,
    hint: "Optional backward extrude distance (two-sided extrude)",
  },
  boolean: {
    type: "boolean_operation",
    default_value: { targets: [], operation: 'NONE' },
    hint: "Optional boolean operation with selected solids"
  }
};

export class ExtrudeFeature {
  static featureShortName = "E";
  static featureName = "Extrude";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    // actual code to create the extrude feature.
    const { profile, distance, distanceBack } = this.inputParams;

    // Resolve profile object: accept FACE object or a SKETCH group object
    const obj = Array.isArray(profile) ? (profile[0] || null) : (profile || null);
    let faceObj = obj;
    if (obj && obj.type === 'SKETCH') {
      // Find child FACE named PROFILE (or any FACE child)
      faceObj = obj.children.find(ch => ch.type === 'FACE') || obj.children.find(ch => ch.userData?.faceName);
    }

    const removed = [];
    // if the face is a child of a sketch we need to remove the sketch from the scene
    if (faceObj && faceObj.type === 'FACE' && faceObj.parent && faceObj.parent.type === 'SKETCH') removed.push(faceObj.parent);



    // Create the extrude using the robust Sweep implementation (handles holes and per-edge side faces)
    // If user requests a UNION with the same solid the profile came from,
    // skip the cap that lies on the original face plane to avoid coplanar
    // overlaps (which can leave an internal seam after CSG).
    const op = String(this.inputParams?.boolean?.operation || 'NONE').toUpperCase();
    const targets = Array.isArray(this.inputParams?.boolean?.targets) ? this.inputParams.boolean.targets : [];
    const parentSolid = faceObj && faceObj.parent && typeof faceObj.parent.getFaceNames === 'function' ? faceObj.parent : null;
    const unionTargetsIncludeParent = op === 'UNION' && parentSolid && targets && targets.some(t => t === parentSolid || (typeof t === 'string' && t === parentSolid.name));
    const omitBaseCap = !!unionTargetsIncludeParent;

    const extrude = new BREP.Sweep({
      face: faceObj,
      distance: distance + (op === 'SUBTRACT' ? 0.00001 : 0) + (op === 'UNION' ? 0.00001 : 0), // small nudge to avoid z-fighting with original face when subtracting
      distanceBack: distanceBack,
      mode: 'translate',
      name: this.inputParams.featureID,
      omitBaseCap,
    });
    // Attach centerlines for any circular/arc sketch edges in the profile
    try {
      const THREE = BREP.THREE;
      const edges = Array.isArray(faceObj?.edges) ? faceObj.edges : (faceObj?.edges ? Array.from(faceObj.edges) : []);
      const centers = [];
      const addCenter = (arr) => {
        if (!Array.isArray(arr) || arr.length !== 3) return;
        centers.push(new THREE.Vector3(arr[0], arr[1], arr[2]));
      };
      for (const e of edges) {
        const kind = e?.userData?.sketchGeomType;
        if (kind === 'arc' && Array.isArray(e?.userData?.arcCenter)) addCenter(e.userData.arcCenter);
        else if (kind === 'circle' && Array.isArray(e?.userData?.circleCenter)) addCenter(e.userData.circleCenter);
      }
      // Deduplicate centers by hashing rounded coords
      const uniq = new Map();
      const round = (v)=> Math.round(v*1e6)/1e6;
      const uniqueCenters = [];
      for (const c of centers) { const k = `${round(c.x)},${round(c.y)},${round(c.z)}`; if (!uniq.has(k)) { uniq.set(k, true); uniqueCenters.push(c); } }

      if (uniqueCenters.length) {
        // Compute face normal for direction
        const n = (typeof faceObj.getAverageNormal === 'function') ? faceObj.getAverageNormal().clone() : new THREE.Vector3(0,1,0);
        if (n.lengthSq() < 1e-20) n.set(0,1,0); n.normalize();
        const fwd = n.clone().multiplyScalar(Number(distance) || 0);
        const back = n.clone().multiplyScalar(-(Number(distanceBack) || 0));
        let idx = 0;
        for (const c of uniqueCenters) {
          const a = new THREE.Vector3(c.x, c.y, c.z).add(back);
          const b = new THREE.Vector3(c.x, c.y, c.z).add(fwd);
          if (a.distanceToSquared(b) < 1e-16) continue;
          const name = (this.inputParams.featureID ? `${this.inputParams.featureID}_AXIS_${idx++}` : 'AXIS');
          extrude.addCenterline([a.x, a.y, a.z], [b.x, b.y, b.z], name, { materialKey: 'OVERLAY' });
        }
      }
    } catch (_) { /* best-effort centerlines */ }
    extrude.visualize();

    // Apply optional boolean operation via shared helper
    const effects = await BREP.applyBooleanOperation(partHistory || {}, extrude, this.inputParams.boolean, this.inputParams.featureID);
    // Flag removals (sketch parent + boolean effects) for PartHistory to collect
    try { for (const obj of [...removed, ...effects.removed]) { if (obj) obj.__removeFlag = true; } } catch {}
    // Return only artifacts to add
    return effects.added || [];
  }
}
