const inputParamsSchema = {
    id: {
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
    static shortName = "CH";
    static longName = "Chamfer";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
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
            return { added: [], removed: [] };
        }
        const solids = new Set(edgeObjs.map(e => e.parentSolid || e.parent));
        if (solids.size === 0) {
            console.warn("Selected edges do not belong to any solid");
            return { added: [], removed: [] };
        }
        if (solids.size > 1) {
            console.warn("Selected edges belong to multiple solids");
            return { added: [], removed: [] };
        }

        const targetSolid = solids.values().next().value;
        const direction = String(this.inputParams.direction || "INSET").toUpperCase();
        const distance = Number(this.inputParams.distance);
        if (!Number.isFinite(distance) || !(distance > 0)) {
            console.warn("Invalid chamfer distance supplied; aborting.", { distance: this.inputParams.distance });
            return { added: [], removed: [] };
        }

        const fid = this.inputParams.featureID;
        const result = await targetSolid.chamfer({
            distance,
            edges: edgeObjs,
            direction,
            inflate: Number(this.inputParams.inflate),
            debug: !!this.inputParams.debug,
            featureID: fid,
        });

        const triCount = Array.isArray(result?._triVerts) ? (result._triVerts.length / 3) : 0;
        const vertCount = Array.isArray(result?._vertProperties) ? (result._vertProperties.length / 3) : 0;
        if (!result || triCount === 0 || vertCount === 0) {
            console.error("[ChamferFeature] Chamfer produced an empty result; skipping scene replacement.", {
                featureID: fid,
                triangleCount: triCount,
                vertexCount: vertCount,
                direction,
                distance,
                inflate: this.inputParams.inflate,
            });
            return { added: [], removed: [] };
        }

        try { result.name = targetSolid.name; } catch {}
        try { targetSolid.__removeFlag = true; } catch {}
        result.visualize();

        const added = [result];
        if (this.inputParams.debug && Array.isArray(result.__debugChamferSolids)) {
            for (const dbg of result.__debugChamferSolids) {
                if (!dbg) continue;
                try { dbg.name = `${fid || "CHAMFER"}_${dbg.name || "DEBUG"}`; } catch {}
                added.push(dbg);
            }
        }
        return { added, removed: [targetSolid] };
    }
}
