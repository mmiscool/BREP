// primitivePyramidFeature.js
// Creates a primitive right pyramid as a Solid composed of Face objects:
// - One triangular Face per lateral side
// - One polygonal base Face (triangulated fan, combined into a single geometry)
// Aligned along the Y axis, centered at the origin,
// with the apex at +height/2 and the base plane at -height/2.

import { BREP } from '../../BREP/BREP.js'

const inputParamsSchema = {
    id: {
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

export class PrimitivePyramidFeature {
    static shortName = "P.PY";
    static longName = "Primitive Pyramid";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        
        this.persistentData = {};
    }

    async run(partHistory) {
        const { baseSideLength, sides, height, featureID } = this.inputParams;

        const pyramid = await new BREP.Pyramid({
            bL: baseSideLength,
            s: sides,
            h: height,
            name: featureID,
        });
        try {
            if (this.inputParams.transform) {
                pyramid.bakeTRS(this.inputParams.transform);
            }
        } catch (_) { }
        pyramid.visualize();

        return await BREP.applyBooleanOperation(partHistory || {}, pyramid, this.inputParams.boolean, featureID);
    }
}
