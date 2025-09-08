import { extractDefaultValues } from "../../PartHistory.js";
import { applyBooleanOperation } from "../../BREP/applyBooleanOperation.js";

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
        hint: "Primary target solid",
    },
    boolean: {
        type: "boolean_operation",
        // For the Boolean feature, the widget's targets represent the OTHER solids to combine with the targetSolid
        default_value: { targets: [], opperation: 'UNION' },
        hint: "Operation + other solids (as tools)",
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
        const target = targetName ? await scene.getObjectByName(targetName) : null;
        if (!target) throw new Error(`Target solid not found: ${targetName}`);

        const bool = this.inputParams.boolean || { targets: [], opperation: 'NONE' };
        const op = String(bool.opperation || 'NONE').toUpperCase();
        const toolNames = Array.isArray(bool.targets) ? bool.targets.filter(Boolean) : [];
        if (op === 'NONE' || toolNames.length === 0) {
            // No-op: leave scene unchanged
            return [];
        }

        // Collect tool solids
        const seen = new Set();
        const tools = [];
        for (const name of toolNames) {
            const key = String(name);
            if (seen.has(key)) continue;
            seen.add(key);
            const obj = await scene.getObjectByName(key);
            if (obj) tools.push(obj);
        }
        if (tools.length === 0) return [];

        // Use the shared helper semantics:
        // - For UNION/INTERSECT: base = target, targets = tools → returns [result]; tools removed; we remove target.
        // - For SUBTRACT: invert per helper by passing base = union(tools), targets = [target] → returns [result];
        //   helper will remove target and the base union; also mark the original tool solids as removed here.
        let outputs = [];
        if (op === 'SUBTRACT') {
            let toolUnion = tools[0];
            for (let i = 1; i < tools.length; i++) toolUnion = toolUnion.union(tools[i]);
            // Remove the original tools (the helper removes only the baseUnion and target)
            for (const t of tools) t.remove = true;
            const param = { opperation: 'SUBTRACT', targets: [targetName] };
            outputs = await applyBooleanOperation(partHistory, toolUnion, param, this.inputParams.featureID);
        } else {
            const param = { opperation: op, targets: toolNames };
            outputs = await applyBooleanOperation(partHistory, target, param, this.inputParams.featureID);
            // Ensure original target is removed to avoid duplication
            try { target.remove = true; } catch (_) { }
        }

        return outputs;
    }
}
