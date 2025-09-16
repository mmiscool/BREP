// primitiveTorusFeature.js
// Creates a primitive torus as a Solid composed of Face objects.
// If arc < 360°, adds end-cap Faces to close the open torus, matching
// the original orientation (start cap built at θ=0 with normal (0,-1,0),
// end cap is a rotated clone about +Z by the sweep arc).

import { extractDefaultValues } from "../../PartHistory.js";
import { BREP } from '../../BREP/BREP.js'
import { applyBooleanOperation } from '../../BREP/applyBooleanOperation.js';

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
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
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
        torus.visualize();

        return await applyBooleanOperation(partHistory || {}, torus, this.inputParams.boolean, featureID);
    }
}
