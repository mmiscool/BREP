// primitiveSphereFeature.js
// Creates a primitive sphere as a Solid containing a single Face (one analytic surface).
// Centered at the origin, aligned with the Y axis (poles at ±radius along Y).

import { extractDefaultValues } from "../../PartHistory.js";
import { BREP } from '../../BREP/BREP.js'

const inputParamsSchema = {
    featureID: {
        type: 'string',
        default_value: null,
        hint: 'Unique identifier for the feature'
    },
    radius: {
        type: 'number',
        default_value: 5,
        hint: 'Radius of the sphere'
    },
    resolution: {
        type: 'number',
        default_value: 32,
        hint: 'Base segment count (longitude). Latitude segments are derived from this.'
    }
};

export class PrimitiveSphereFeature {
    static featureShortName = "P.S";
    static featureName = "Primitive Sphere";
    static inputParamsSchema = inputParamsSchema;

    constructor(partHistory) {
        this.partHistory = partHistory;
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
        this.persistentData = {};
    }

    async run() {
        const { radius, resolution, featureID } = this.inputParams;

        const sphere = await new BREP.Sphere({
            r: radius,
            resolution,
            name: featureID,
        });
        sphere.visualize();

        return [sphere];
    }
}
