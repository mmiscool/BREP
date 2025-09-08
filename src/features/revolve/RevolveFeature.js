import { extractDefaultValues } from "../../PartHistory.js";

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the revolve feature",
    },
    axis: {
        type: "reference_selection",
        selectionFilter: ["edge"],
        multiple: false,
        default_value: null,
        hint: "Select the axis to revolve about",
    },
    angle: {
        type: "number",
        default_value: 360,
        hint: "Revolve angle",
    },
    boolean: {
        type: "boolean_operation",
        default_value: { targets: [], opperation: 'NONE' },
        hint: "Optional boolean operation with selected solids"
    }
};

export class RevolveFeature {
    static featureShortName = "REVOLVE";
    static featureName = "Revolve";
    static inputParamsSchema = inputParamsSchema;

    constructor(partHistory) {
        this.partHistory = partHistory;
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
    }

    async run() {
        // actual code to create the revolve feature.
        return [];
    }
}
