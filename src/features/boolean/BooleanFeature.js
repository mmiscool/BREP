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
        hint: "Primary target solid",
    },
    boolean: {
        type: "boolean_operation",
        // For the Boolean feature, the widget's targets represent the OTHER solids to combine with the targetSolid
        default_value: { targets: [], operation: 'UNION' },
        hint: "Operation + other solids (as tools)",
    }
};

export class BooleanFeature {
    static featureShortName = "B";
    static featureName = "Boolean";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        this.persistentData = {};
    }

    async run(partHistory) {
        const scene = partHistory.scene;
        const targetObj = Array.isArray(this.inputParams.targetSolid) ? (this.inputParams.targetSolid[0] || null) : (this.inputParams.targetSolid || null);
        const target = (targetObj && typeof targetObj === 'object') ? targetObj : (targetObj ? await scene.getObjectByName(String(targetObj)) : null);
        if (!target) throw new Error(`Target solid not found`);

        const bool = this.inputParams.boolean || { targets: [], operation: 'NONE' };
        const op = String((bool.operation ?? 'NONE')).toUpperCase();
        const toolEntries = Array.isArray(bool.targets) ? bool.targets.filter(Boolean) : [];
        if (op === 'NONE' || toolEntries.length === 0) {
            // No-op: leave scene unchanged
            return { added: [], removed: [] };
        }

        // Collect tool solids (objects preferred, fallback to names)
        const seen = new Set();
        const tools = [];
        for (const entry of toolEntries) {
            if (!entry) continue;
            if (typeof entry === 'object') {
                const key = entry.uuid || entry.id || entry.name || `${tools.length}`;
                if (seen.has(key)) continue;
                seen.add(key);
                tools.push(entry);
            } else {
                const key = String(entry);
                if (seen.has(key)) continue;
                seen.add(key);
                const obj = await scene.getObjectByName(key);
                if (obj) tools.push(obj);
            }
        }
        if (tools.length === 0) return { added: [], removed: [] };

        // Use the shared helper semantics:
        // - For UNION/INTERSECT: base = target, targets = tools → returns [result]; tools removed; we remove target.
        // - For SUBTRACT: invert per helper by passing base = union(tools), targets = [target] → returns [result];
        //   helper will remove target and the base union; also mark the original tool solids as removed here.
        let effects = { added: [], removed: [] };
        if (op === 'SUBTRACT') {
            let toolUnion = tools[0];
            for (let i = 1; i < tools.length; i++) toolUnion = toolUnion.union(tools[i]);
            const param = { operation: 'SUBTRACT', targets: [target] };
            effects = await BREP.applyBooleanOperation(partHistory, toolUnion, param, this.inputParams.featureID);
            // Also consider original tools as removed
            effects.removed = [...tools, ...effects.removed];
        } else {
            const param = { operation: op, targets: tools };
            effects = await BREP.applyBooleanOperation(partHistory, target, param, this.inputParams.featureID);
            // Ensure original target is removed to avoid duplication
            effects.removed = [target, ...effects.removed];
        }

        // Mark removals and return only additions
        try { for (const obj of effects.removed || []) { if (obj) obj.__removeFlag = true; } } catch { }
        return {
            added: Array.isArray(effects.added) ? effects.added : [],
            removed: Array.isArray(effects.removed) ? effects.removed : [],
        };
    }
}
