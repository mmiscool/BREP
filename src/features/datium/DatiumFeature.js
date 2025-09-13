import { extractDefaultValues } from "../../PartHistory.js";

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the datium feature",
    },
    datum: {
        type: "reference_selection",
        selectionFilter: ["datum", "plane", "face", "edge"],
        multiple: false,
        default_value: null,
        hint: "Optional reference datum",
    },
    orientation: {
        type: "options",
        options: ["XY", "XZ", "YZ"],
        default_value: "XY",
        hint: "Plane orientation",
    },
    offset_distance: {
        type: "number",
        default_value: 0,
        hint: "Plane offset distance",
    }
};

export class DatiumFeature {
    static featureShortName = "D";
    static featureName = "Datium";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
    }
    async run() {
        // actual code to create the datium feature.
        return []
    }
}
