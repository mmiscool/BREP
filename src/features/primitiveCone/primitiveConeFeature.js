// primitiveConeFeature.js
// Creates a primitive cone/frustum as separate meshes per surface: lateral (side) and caps.
// Aligned along the Y axis with base at y=0 and top at y=height (not centered).

import { BREP } from '../../BREP/BREP.js'
// no extra imports needed for centerline metadata

const inputParamsSchema = {
  featureID: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the feature'
  },
  radiusTop: {
    type: 'number',
    default_value: 5,
    hint: 'Top radius of the cone (tip if 0)'
  },
  radiusBottom: {
    type: 'number',
    default_value: 10,
    hint: 'Base radius of the cone'
  },
  height: {
    type: 'number',
    default_value: 10,
    hint: 'Height of the cone along Y-axis'
  },
  resolution: {
    type: 'number',
    default_value: 32,
    hint: 'Number of segments around the circumference'
  },
  transform: {
    type: 'transform',
    default_value: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    hint: 'Position, rotation, and scale'
  },
  boolean: {
    type: 'boolean_operation',
    default_value: { targets: [], operation: 'NONE' },
    hint: 'Optional boolean operation with selected solids'
  }
};

export class PrimitiveConeFeature {
  static featureShortName = "P.CO";
  static featureName = "Primitive Cone";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const { radiusTop, radiusBottom, height, resolution } = this.inputParams;

    const cone = await new BREP.Cone({
      r1: radiusTop,
      r2: radiusBottom,
      h: height,
      resolution,
      name: this.inputParams.featureID
    });
    try {
      if (this.inputParams.transform) {
        cone.bakeTRS(this.inputParams.transform);
      }
    } catch (_) { }

    // Add a world-space centerline along Y from base to top and store on the solid
    const THREE = BREP.THREE;
    try {
      const p = Array.isArray(this.inputParams?.transform?.position) ? this.inputParams.transform.position : [0, 0, 0];
      const r = Array.isArray(this.inputParams?.transform?.rotationEuler) ? this.inputParams.transform.rotationEuler : [0, 0, 0];
      const s = Array.isArray(this.inputParams?.transform?.scale) ? this.inputParams.transform.scale : [1, 1, 1];
      const pos = new THREE.Vector3(p[0] || 0, p[1] || 0, p[2] || 0);
      const eul = new THREE.Euler(
        THREE.MathUtils.degToRad(r[0] || 0),
        THREE.MathUtils.degToRad(r[1] || 0),
        THREE.MathUtils.degToRad(r[2] || 0),
        'XYZ'
      );
      const quat = new THREE.Quaternion().setFromEuler(eul);
      const scl = new THREE.Vector3(s[0] || 1, s[1] || 1, s[2] || 1);
      const M = new THREE.Matrix4().compose(pos, quat, scl);
      const a0 = new THREE.Vector3(0, 0, 0).applyMatrix4(M);
      const a1 = new THREE.Vector3(0, Number(height) || 0, 0).applyMatrix4(M);
      if (a0.distanceToSquared(a1) >= 1e-16) {
        const featureID = this.inputParams.featureID;
        cone.addCenterline([a0.x, a0.y, a0.z], [a1.x, a1.y, a1.z], (featureID ? `${featureID}_AXIS` : 'AXIS'), { materialKey: 'OVERLAY' });
      }
    } catch (_) { }

    cone.visualize();
    return await BREP.applyBooleanOperation(partHistory || {}, cone, this.inputParams.boolean, this.inputParams.featureID);
  }
}
