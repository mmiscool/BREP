import { extractDefaultValues } from "../../PartHistory.js";
import { ChamferSolid } from '../../BREP/chamfer.js';

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the chamfer feature",
    },
    edges: {
        type: "reference_selection",
        selectionFilter: ["EDGE", "FACE"],
        multiple: true,
        default_value: null,
        hint: "Select edges or faces to apply the chamfer",
    },
    distance: {
        type: "number",
        step: 0.1,
        default_value: 1,
        hint: "Chamfer distance (equal offset along both faces)",
    },
    inflate: {
        type: "number",
        default_value: 0.1,
        step: 0.1,
        hint: "Grow the cutting solid by this amount (units). Very small values (e.g., 0.0005) help avoid residual slivers after CSG.",
    },
    direction: {
        type: "options",
        options: ["INSET", "OUTSET"],
        default_value: "INSET",
        hint: "Prefer chamfer inside (INSET) or outside (OUTSET)",
    },
    debug: {
        type: "boolean",
        default_value: false,
        hint: "Draw diagnostic helpers for section frames",
    }
};

export class ChamferFeature {
    static featureShortName = "CHAMFER";
    static featureName = "Chamfer";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = extractDefaultValues(inputParamsSchema);
        this.persistentData = {};
    }
    async run(partHistory) {
        const inputObjects = Array.isArray(this.inputParams.edges) ? this.inputParams.edges.filter(Boolean) : [];

        const edgeObjs = [];
        inputObjects.forEach(obj => {
            if (obj.type === "EDGE") {
                if (!edgeObjs.includes(obj)) edgeObjs.push(obj);
            }
            if (obj.type === "FACE") {
                for (const edge of obj.edges) {
                    if (!edgeObjs.includes(edge)) edgeObjs.push(edge);
                }
            }
        });

        if (edgeObjs.length === 0) {
            console.warn("No edges selected for chamfer");
            return [];
        }
        const solids = new Set(edgeObjs.map(e => e.parentSolid));
        if (solids.size === 0) {
            console.warn("Selected edges do not belong to any solid");
            return [];
        }
        if (solids.size > 1) {
            console.warn("Selected edges belong to multiple solids");
            return [];
        }

        const targetSolid = edgeObjs[0].parentSolid || edgeObjs[0].parent;

        const objectsForBoolean = [];
        for (const edgeObj of edgeObjs) {
            const chamferSolid = makeSingleChamferSolid(edgeObj,
                this.inputParams.distance,
                this.inputParams.inflate,
                this.inputParams.direction,
                this.inputParams.debug);
            objectsForBoolean.push(chamferSolid);
        }

        let finalSolid = targetSolid;
        for (const obj of objectsForBoolean) {
            if (this.inputParams.direction === "OUTSET") {
                finalSolid = finalSolid.union(obj);
            } else if (this.inputParams.direction === "INSET") {
                finalSolid = finalSolid.subtract(obj);
            } else { // AUTO (not exposed currently)
                try {
                    finalSolid = finalSolid.subtract(obj);
                } catch (e) {
                    try { finalSolid = finalSolid.union(obj); } catch (e2) { console.error("Chamfer union failed:", e2); }
                }
            }
        }

        finalSolid.name = `${targetSolid.name}`;
        finalSolid.visualize();
        // Flag the original solid for removal; PartHistory will handle it
        try { targetSolid.remove = true; } catch {}
        const out = [];
        if (this.inputParams.debug) out.push(...objectsForBoolean);
        out.push(finalSolid);
        return out;
    }
}

function makeSingleChamferSolid(edgeObj, distance = 1, inflate = 0, direction = 'INSET', debug = false) {
    const tool = new ChamferSolid({ edgeToChamfer: edgeObj, distance, inflate, direction, debug });
    tool.name = "CHAMFER_TOOL";
    tool.visualize();
    return tool;
}
