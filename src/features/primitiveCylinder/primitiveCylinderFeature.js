// primitiveCylinderFeature.js
// Creates a primitive cylinder as separate faces: lateral (side) and two caps.
// Aligned along the Y axis with base at y=0 and top at y=height (not centered).

import { extractDefaultValues } from "../../PartHistory.js";
import { BREP } from '../../BREP/BREP.js'
import { applyBooleanOperation } from '../../BREP/applyBooleanOperation.js';

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
    boolean: {
        type: 'boolean_operation',
        default_value: { targets: [], opperation: 'NONE' },
        hint: 'Optional boolean operation with selected solids'
    }
};

export class PrimitiveCylinderFeature {
    static featureShortName = "P.CY";
    static featureName = "Primitive Cylinder";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
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
        cyl.visualize();

        return await applyBooleanOperation(partHistory || {}, cyl, this.inputParams.boolean, featureID);
    }
}
