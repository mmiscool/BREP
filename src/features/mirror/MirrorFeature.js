import { extractDefaultValues } from "../../PartHistory.js";

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the mirror feature",
    },
    mirrorPlane: {
        type: "reference_selection",
        selectionFilter: ["plane", "face"],
        multiple: false,
        default_value: null,
        hint: "Select the plane or face to mirror about",
    },
    offsetDistance: {
        type: "number",
        default_value: 0,
        hint: "Offset distance for the mirror",
    }
};

export class MirrorFeature {
    static featureShortName = "MIRROR";
    static inputParamsSchema = inputParamsSchema;

    constructor(partHistory) {
        this.partHistory = partHistory;
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
    }
    async run() {
        // actual code to create the mirror feature.
        return []
    }
}