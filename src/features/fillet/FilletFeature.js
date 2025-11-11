import { clearFilletCaches } from "../../BREP/fillets/fillet.js";

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the fillet feature",
    },
    edges: {
        type: "reference_selection",
        selectionFilter: ["FACE", "EDGE"],
        multiple: true,
        default_value: null,
        hint: "Select faces (or an edge) to fillet along shared edges",
    },
    radius: {
        type: "number",
        step: 0.1,
        default_value: 1,
        hint: "Fillet radius",
    },
    inflate: {
        type: "number",
        step: 0.1,
        default_value: 0.1,
        hint: "Grow the cutting solid by this amount (units). Keep tiny (e.g. 0.0005). Closed loops ignore inflation to avoid self‑intersection.",
    },
    direction: {
        type: "options",
        options: ["INSET", "OUTSET"],
        default_value: "INSET",
        hint: "Prefer fillet inside (INSET) or outside (OUTSET)",
    },
    snapSeam: {
        type: "boolean",
        default_value: true,
        hint: "Experimental: snap boolean seam to computed tangents (INSET only)",
    },
    debug: {
        type: "boolean",
        default_value: false,
        hint: "Draw diagnostic vectors for section frames (u,v, bisector, tangency)",
    },
};

export class FilletFeature {
    static featureShortName = "F";
    static featureName = "Fillet";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        this.persistentData = {};
    }

    async run(partHistory) {
        try { clearFilletCaches(); } catch { }
        const added = [];
        const removed = [];

        // Resolve inputs from sanitizeInputParams()
        const inputObjects = Array.isArray(this.inputParams.edges) ? this.inputParams.edges.filter(Boolean) : [];
        let edgeObjs = [];
        for (const obj of inputObjects) {
            if (!obj) continue;
            if (obj.type === 'EDGE') {
                if (!edgeObjs.includes(obj)) edgeObjs.push(obj);
            } else if (obj.type === 'FACE' && Array.isArray(obj.edges)) {
                for (const e of obj.edges) { if (e) edgeObjs.push(e); }
            }
        }
        edgeObjs = Array.from(new Set(edgeObjs)).filter(e => (e && (e.parentSolid || e.parent)));
        if (edgeObjs.length === 0) return { added: [], removed: [] };

        const solids = new Set(edgeObjs.map(e => e.parentSolid || e.parent));
        if (solids.size !== 1) return { added: [], removed: [] };
        const targetSolid = solids.values().next().value;

        const dir = String(this.inputParams.direction || 'INSET').toUpperCase();
        const r = Number(this.inputParams.radius);
        if (!Number.isFinite(r) || !(r > 0)) return { added: [], removed: [] };

        const fid = this.inputParams?.featureID || 'FILLET';
        const result = await targetSolid.fillet({
            radius: r,
            edges: edgeObjs,
            featureID: fid,
            direction: dir,
            inflate: Number(this.inputParams.inflate) || 0,
            debug: !!this.inputParams.debug,
            snapSeam: !!this.inputParams.snapSeam,
        });
        added.push(result);
        // In debug mode, include wedge/tube debug solids produced during fillet construction
        if (this.inputParams.debug && Array.isArray(result?.__debugAddedSolids)) {
            // prepend the feature ID to the debug solids
            for (const dbg of result.__debugAddedSolids) {
                if (dbg) {
                    console.log(this.inputParams?.featureID)
                    console.log(fid, dbg);
                    dbg.name = `${fid}_${dbg.name || 'DEBUG'}`;
                    console.log("Fillet debug solid:", dbg);
                    added.push(dbg);
                }
            }
        }
        // Replace the original geometry in the scene
        removed.push(targetSolid);
        return { added, removed };
    }
}
