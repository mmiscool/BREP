import { extractDefaultValues } from "../../PartHistory.js";
import { BREP } from '../../BREP/BREP.js'

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the boolean feature",
    },
    targetSolid: {
        type: "reference_selection",
        selectionFilter: ["SOLID"],
        multiple: false,
        default_value: null,
        hint: "Solid to operate on",
    },
    toolSolid: {
        type: "reference_selection",
        selectionFilter: ["SOLID"],
        multiple: true,
        default_value: [],
        hint: "One or more solids to use as tools",
    },

    operation: {
        type: "options",
        options: ["UNION", "SUBTRACT", "INTERSECT", ],
        default_value: "UNION",
        hint: "Boolean operation type (union, subtract or intersection)",
    }
};

export class BooleanFeature {
    static featureShortName = "B";
    static featureName = "Boolean";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = extractDefaultValues(inputParamsSchema);
        this.persistentData = {};
      
    }

    async run(partHistory) {
        const scene = partHistory.scene;
        const targetName = this.inputParams.targetSolid;
        const toolParam = this.inputParams.toolSolid;

        const target = await scene.getObjectByName(targetName);
        if (!target) throw new Error(`Target solid not found: ${targetName}`);

        // Normalize tools to an array of names
        let toolNames = [];
        if (Array.isArray(toolParam)) toolNames = toolParam.filter(Boolean);
        else if (toolParam != null) toolNames = [toolParam];

        if (toolNames.length === 0) throw new Error(`No tool solids selected`);

        // Get tool objects, dedupe by name, and filter missing
        const seen = new Set();
        const tools = [];
        for (const name of toolNames) {
            if (!name || seen.has(name)) continue;
            seen.add(name);
            const obj = await scene.getObjectByName(name);
            if (obj) tools.push(obj);
        }
        if (tools.length === 0) throw new Error(`Tool solids not found: ${toolNames.join(', ')}`);

        // Apply boolean operation across tools
        let result = target;
        const op = this.inputParams.operation;
        for (const tool of tools) {
            if (op === "SUBTRACT") result = result.subtract(tool);
            else if (op === "UNION") result = result.union(tool);
            else if (op === "INTERSECT") result = result.intersect(tool);
        }

        result.visualize();

        // Remove original bodies
        target.remove =true;
        for (const tool of tools) tool.remove =true;

        // Ensure result is identifiable for downstream references
        result.name = this.inputParams.featureID;


        return [result];
    }
}

