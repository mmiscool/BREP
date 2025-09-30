// primitiveTorusFeature.js
// Creates a primitive torus as a Solid composed of Face objects.
// If arc < 360°, adds end-cap Faces to close the open torus, matching
// the original orientation (start cap built at θ=0 with normal (0,-1,0),
// end cap is a rotated clone about +Z by the sweep arc).

import { BREP } from '../../BREP/BREP.js'
// no extra imports needed for centerline metadata

const inputParamsSchema = {
    featureID: {
        type: 'string',
        default_value: null,
        hint: 'Unique identifier for the feature'
    },
    majorRadius: {
        type: 'number',
        default_value: 10,
        hint: 'Distance from center to the centerline of the tube (R)'
    },
    tubeRadius: {
        type: 'number',
        default_value: 2,
        hint: 'Radius of the tube (r)'
    },
    resolution: {
        type: 'number',
        default_value: 64,
        hint: 'Quality resolution (base setting for segments)'
    },
    arc: {
        type: 'number',
        default_value: 360,
        hint: 'Sweep angle of the torus in degrees (0, 360]'
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

export class PrimitiveTorusFeature {
    static featureShortName = "P.T";
    static featureName = "Primitive Torus";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        this.persistentData = {};
    }

    async run(partHistory) {
        let {
            majorRadius,
            tubeRadius,
            resolution,
            arc,
            featureID
        } = this.inputParams;

        const torus = await new BREP.Torus({
            mR: majorRadius,
            tR: tubeRadius,
            resolution,
            arcDegrees: arc,
            name: featureID,
        });
        try {
            if (this.inputParams.transform) {
                torus.bakeTRS(this.inputParams.transform);
            }
        } catch (_) { }

        // Add a world-space centerline edge along the torus revolve axis (Y).
        // Choose a length that spans the torus extents and store on the solid.
        const THREE = BREP.THREE;
        try {
            const p = Array.isArray(this.inputParams?.transform?.position) ? this.inputParams.transform.position : [0, 0, 0];
            const r = Array.isArray(this.inputParams?.transform?.rotationEuler) ? this.inputParams.transform.rotationEuler : [0, 0, 0];
            const s = Array.isArray(this.inputParams?.transform?.scale) ? this.inputParams.transform.scale : [1, 1, 1];
            const pos = new THREE.Vector3(p[0] || 0, p[1] || 0, p[2] || 0);
            const eul = new THREE.Euler(r[0] || 0, r[1] || 0, r[2] || 0, 'XYZ');
            const quat = new THREE.Quaternion().setFromEuler(eul);
            const scl = new THREE.Vector3(s[0] || 1, s[1] || 1, s[2] || 1);
            const M = new THREE.Matrix4().compose(pos, quat, scl);

            const L = 2 * (Math.abs(Number(majorRadius) || 0) + Math.abs(Number(tubeRadius) || 0));
            const a0 = new THREE.Vector3(0, -0.5 * L, 0).applyMatrix4(M);
            const a1 = new THREE.Vector3(0, +0.5 * L, 0).applyMatrix4(M);
            if (a0.distanceToSquared(a1) >= 1e-16) {
                torus.addCenterline([a0.x, a0.y, a0.z], [a1.x, a1.y, a1.z], (featureID ? `${featureID}_AXIS` : 'AXIS'), { materialKey: 'OVERLAY' });
            }
        } catch (_) { }

        torus.visualize();
        return await BREP.applyBooleanOperation(partHistory || {}, torus, this.inputParams.boolean, featureID);
    }
}
