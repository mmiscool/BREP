import { clearFilletCaches } from "../../BREP/fillets/fillet.js";

const inputParamsSchema = {
    id: {
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
    resolution: {
        type: "number",
        step: 1,
        default_value: 32,
        hint: "Segments around the fillet tube circumference",
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
    combineEdges: {
        type: "boolean",
        default_value: false,
        hint: "Combine connected edges into a single fillet path when possible",
    },
    showTangentOverlays: {
        type: "boolean",
        default_value: false,
        hint: "Show pre-inflate tangent overlays on the fillet tube",
    },
    debug: {
        type: "boolean",
        default_value: false,
        hint: "Draw diagnostic vectors for section frames (u,v, bisector, tangency)",
    },
};

export class FilletFeature {
    static shortName = "F";
    static longName = "Fillet";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        this.persistentData = {};
    }

    uiFieldsTest() {
        const dir = String(this.inputParams?.direction || 'INSET').toUpperCase();
        if (dir === 'INSET') {
            return { exclude: ['combineEdges'] };
        }
        return { exclude: [] };
    }

    async run(partHistory) {
        console.log('[FilletFeature] Starting fillet run...', {
            featureID: this.inputParams?.featureID,
            direction: this.inputParams?.direction,
            combineEdges: this.inputParams?.combineEdges,
            radius: this.inputParams?.radius,
            resolution: this.inputParams?.resolution,
            inflate: this.inputParams?.inflate,
            showTangentOverlays: this.inputParams?.showTangentOverlays,
            debug: this.inputParams?.debug,
        });
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
        if (edgeObjs.length === 0) {
            console.warn('[FilletFeature] No edges resolved for fillet feature; aborting.');
            return { added: [], removed: [] };
        }

        const solids = new Set(edgeObjs.map(e => e.parentSolid || e.parent));
        if (solids.size !== 1) {
            console.warn('[FilletFeature] Edges reference multiple solids; aborting fillet.', { solids: Array.from(solids).map(s => s?.name) });
            return { added: [], removed: [] };
        }
        const targetSolid = solids.values().next().value;
        console.log('[FilletFeature] Target solid resolved', {
            name: targetSolid?.name,
            edgeCount: edgeObjs.length,
            edgeNames: edgeObjs.map(e => e?.name).filter(Boolean),
        });

        const dir = String(this.inputParams.direction || 'INSET').toUpperCase();
        const r = Number(this.inputParams.radius);
        if (!Number.isFinite(r) || !(r > 0)) {
            console.warn('[FilletFeature] Invalid radius supplied; aborting.', { radius: this.inputParams.radius });
            return { added: [], removed: [] };
        }

        const fid = this.inputParams.featureID;
        const combineEdges = dir === 'INSET' ? false : !!this.inputParams.combineEdges;
        let result = null;
        try {
            result = await targetSolid.fillet({
                radius: r,
                combineEdges,
                resolution: this.inputParams?.resolution,
                edges: edgeObjs,
                featureID: fid,
                direction: dir,
                inflate: Number(this.inputParams.inflate) || 0,
                debug: !!this.inputParams.debug,
                showTangentOverlays: !!this.inputParams.showTangentOverlays,
            });
        } catch (err) {
            console.error('[FilletFeature] Fillet threw an error; attempting to continue with debug solids.', {
                featureID: fid,
                error: err?.message || err,
            });
        }
        const collectDebugSolids = (res) => {
            const out = [];
            if (!this.inputParams.debug || !Array.isArray(res?.__debugAddedSolids)) return out;
            for (const dbg of res.__debugAddedSolids) {
                if (!dbg) continue;
                try { dbg.name = `${fid}_${dbg.name || 'DEBUG'}`; } catch { }
                console.log('[FilletFeature] Adding fillet debug solid', { featureID: fid, name: dbg.name });
                out.push(dbg);
            }
            return out;
        };
        const debugSolids = collectDebugSolids(result);
        const triCount = Array.isArray(result?._triVerts) ? (result._triVerts.length / 3) : 0;
        const vertCount = Array.isArray(result?._vertProperties) ? (result._vertProperties.length / 3) : 0;
        if (!result) {
            console.error('[FilletFeature] Fillet returned no result; skipping scene replacement.', { featureID: fid });
            if (debugSolids.length) {
                console.warn('[FilletFeature] Returning fillet debug solids despite failure.', {
                    featureID: fid,
                    debugSolidCount: debugSolids.length,
                });
                added.push(...debugSolids);
            }
            return { added, removed };
        }
        if (triCount === 0 || vertCount === 0) {
            console.error('[FilletFeature] Fillet produced an empty solid; skipping scene replacement.', {
                featureID: fid,
                triangleCount: triCount,
                vertexCount: vertCount,
                direction: dir,
                radius: r,
                inflate: this.inputParams.inflate,
            });
            if (debugSolids.length) {
                console.warn('[FilletFeature] Returning fillet debug solids despite empty result.', {
                    featureID: fid,
                    debugSolidCount: debugSolids.length,
                });
                added.push(...debugSolids);
            }
            return { added, removed };
        }
        console.log('[FilletFeature] Fillet succeeded; replacing target solid.', {
            featureID: fid,
            triangles: triCount,
            vertices: vertCount,
        });
        added.push(result);
        added.push(...debugSolids);
        // Replace the original geometry in the scene
        removed.push(targetSolid);
        return { added, removed };
    }
}
