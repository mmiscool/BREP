// primitivePyramidFeature.js
// Creates a primitive right pyramid as a Solid composed of Face objects:
// - One triangular Face per lateral side
// - One polygonal base Face (triangulated fan, combined into a single geometry)
// Aligned along the Y axis, centered at the origin,
// with the apex at +height/2 and the base plane at -height/2.

import { extractDefaultValues } from "../../PartHistory.js";
import { BREP } from '../../BREP/BREP.js'
import { applyBooleanOperation } from '../../BREP/applyBooleanOperation.js';

const inputParamsSchema = {
    featureID: {
        type: 'string',
        default_value: null,
        hint: 'Unique identifier for the feature'
    },
    baseSideLength: {
        type: 'number',
        default_value: 10,
        hint: 'Side length of the regular base polygon'
    },
    sides: {
        type: 'number',
        default_value: 4,
        hint: 'Number of sides for the base polygon (min 3)'
    },
    height: {
        type: 'number',
        default_value: 10,
        hint: 'Height of the pyramid along Y-axis'
    },
    boolean: {
        type: 'boolean_operation',
        default_value: { targets: [], opperation: 'NONE' },
        hint: 'Optional boolean operation with selected solids'
    }
};

export class PrimitivePyramidFeature {
    static featureShortName = "P.PY";
    static featureName = "Primitive Pyramid";
    static inputParamsSchema = inputParamsSchema;

    constructor(partHistory) {
        this.partHistory = partHistory;
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
        this.persistentData = {};
    }

    async run() {
        const { baseSideLength, sides, height, featureID } = this.inputParams;

        const pyramid = await new BREP.Pyramid({
            bL: baseSideLength,
            s: sides,
            h: height,
            name: featureID,
        });
        pyramid.visualize();

        return await applyBooleanOperation(this.partHistory || {}, pyramid, this.inputParams.boolean, featureID);
    }
}
