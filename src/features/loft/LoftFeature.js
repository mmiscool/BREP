import { extractDefaultValues } from "../../PartHistory.js";

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the loft feature",
    },
    profiles: {
        type: "reference_selection",
        selectionFilter: ["sketch", "face"],
        multiple: true,
        default_value: [],
        hint: "Select profiles to create the loft",
    },
    guideCurves: {
        type: "reference_selection",
        selectionFilter: ["curve", "edge"],
        multiple: true,
        default_value: [],
        hint: "Select guide curves for the loft",
    },
    loftType: {
        type: "options",
        options: ["normal", "lofted", "cross_section"],
        default_value: "normal",
        hint: "Type of loft to create",
    },
    boolean: {
        type: "boolean_operation",
        default_value: { targets: [], operation: 'NONE', opperation: 'NONE' },
        hint: "Optional boolean operation with selected solids"
    }
};

export class LoftFeature {
    static featureShortName = "LOFT";
    static inputParamsSchema = inputParamsSchema;

    constructor(partHistory) {
        this.partHistory = partHistory;
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
    }
    async run() {
        // actual code to create the loft feature.
        return []
    }
}
