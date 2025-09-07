// primitiveCubeFeature.js
// Creates a primitive axis-aligned rectangular prism (cube) composed of six Face objects.
// Positioned with its minimum corner at the origin (0,0,0). Dimensions extend +sizeX, +sizeY, +sizeZ along X/Y/Z.

import { extractDefaultValues } from "../../PartHistory.js";
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
    }
};

export class PrimitiveCubeFeature {
    static featureShortName = "P.CU";
    static featureName = "Primitive Cube";
    static inputParamsSchema = inputParamsSchema;

    constructor(partHistory) {
        this.partHistory = partHistory;
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
        this.persistentData = {};
    }

    async run() {
        const { sizeX, sizeY, sizeZ, featureID } = this.inputParams;

        const cube = await new BREP.Cube({
            x: sizeX,
            y: sizeY,
            z: sizeZ,
            name: featureID,
        });
        cube.visualize();

        return [cube];
    }
}
