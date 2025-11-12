// primitiveCylinderFeature.js
// Creates a primitive cylinder as separate faces: lateral (side) and two caps.
// Aligned along the Y axis with base at y=0 and top at y=height (not centered).

import { BREP } from '../../BREP/BREP.js'
// no extra imports needed for centerline metadata

const inputParamsSchema = {
    featureID: {
        type: 'string',
        default_value: null,
        hint: 'Unique identifier for the feature'
    },
    radius: {
        type: 'number',
        default_value: 5,
        hint: 'Radius of the cylinder'
    },
    height: {
        type: 'number',
        default_value: 10,
        hint: 'Height of the cylinder along Y-axis'
    },
    resolution: {
        type: 'number',
        default_value: 64,
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

export class PrimitiveCylinderFeature {
    static featureShortName = "P.CY";
    static featureName = "Primitive Cylinder";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        this.persistentData = {};
    }

  async run(partHistory) {
        const { radius, height, resolution, featureID } = this.inputParams;

        const cyl = await new BREP.Cylinder({
            radius,
            height,
            resolution,
            name: featureID,
        });
        try {
            if (this.inputParams.transform) {
                cyl.bakeTRS(this.inputParams.transform);
            }
        } catch (_) { }
        // Build world-space centerline along cylinder axis and store on the solid.
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
                cyl.addCenterline([a0.x, a0.y, a0.z], [a1.x, a1.y, a1.z], (featureID ? `${featureID}_AXIS` : 'AXIS'), { materialKey: 'OVERLAY' });
            }
        } catch (_) { }

        cyl.visualize();
        return await BREP.applyBooleanOperation(partHistory || {}, cyl, this.inputParams.boolean, featureID);
  }
}
