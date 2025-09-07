
import { ConstraintEngine } from './sketchSolver2D/ConstraintEngine.js';
import { extractDefaultValues } from "../../PartHistory.js";

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the sketch feature",
    },
    sketchPlane: {
        type: "reference_selection",
        selectionFilter: ["plane", "face"],
        multiple: false,
        default_value: null,
        hint: "Select the plane or face for the sketch",
    },
    editSketch: {
        type: "button",
        label: "Edit Sketch",
        default_value: null,
        hint: "Launch the 2D sketch editor",
    },
};

export class SketchFeature {
    static featureShortName = "S";
    static featureName = "Sketch";
    static inputParamsSchema = inputParamsSchema;

    constructor(partHistory) {
        this.partHistory = partHistory;
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
        this.persistentData = this.persistentData || {};
    }

    async run() {
        // actual code to create the sketch feature.
        return [];
    }
}
