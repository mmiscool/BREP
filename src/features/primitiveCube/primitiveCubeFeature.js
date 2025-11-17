// primitiveCubeFeature.js
// Creates a primitive axis-aligned rectangular prism (cube) composed of six Face objects.
// Positioned with its minimum corner at the origin (0,0,0). Dimensions extend +sizeX, +sizeY, +sizeZ along X/Y/Z.

import { BREP } from '../../BREP/BREP.js'

const inputParamsSchema = {
    featureID: {
        type: 'string',
        default_value: null,
        hint: 'Unique identifier for the feature'
    },
    sizeX: {
        type: 'number',
        default_value: 10,
        hint: 'Width along X'
    },
    sizeY: {
        type: 'number',
        default_value: 10,
        hint: 'Height along Y'
    },
    sizeZ: {
        type: 'number',
        default_value: 10,
        hint: 'Depth along Z'
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

export class PrimitiveCubeFeature {
    static shortName = "P.CU";
    static longName = "Primitive Cube";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        this.persistentData = {};
    }

    async run(partHistory) {
        const { sizeX, sizeY, sizeZ, featureID } = this.inputParams;

        const cube = await new BREP.Cube({
            x: sizeX,
            y: sizeY,
            z: sizeZ,
            name: featureID,
        });
        // Apply transform before visualization so it bakes into geometry arrays
        try {
            if (this.inputParams.transform) {
                cube.bakeTRS(this.inputParams.transform);
            }
        } catch (_) { alert("Error applying transform"); }
        cube.visualize();

        // Apply optional boolean operation
        return await BREP.applyBooleanOperation(partHistory || {}, cube, this.inputParams.boolean, featureID);
    }
}
