import { extractDefaultValues } from "../../PartHistory.js";
import { BREP } from "../../BREP/BREP.js";


const inputParamsSchema = {
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
    debug: {
        type: "boolean",
        default_value: false,
        hint: "Draw diagnostic vectors for section frames (u,v, bisector, tangency)",
    }
}
    ;

export class FilletFeature {
    static featureShortName = "F";
    static featureName = "Fillet";
    static inputParamsSchema = inputParamsSchema;


    constructor() {
        this.inputParams = extractDefaultValues(inputParamsSchema);

        this.persistentData = {};
    }
    async run(partHistory) {
        const dbg = !!this.inputParams.debug;
        const fjson = (tag, obj) => { if (!dbg) return; try { console.log(`[FilletDBG-JSON] ${tag} ` + JSON.stringify(obj)); } catch { console.log(`[FilletDBG-JSON] ${tag}`, obj); } };
        const safeVolume = (s) => { try { return s.volume(); } catch { return 0; } };
        // Accept resolved objects from sanitizeInputParams
        const inputObjects = Array.isArray(this.inputParams.edges) ? this.inputParams.edges.filter(Boolean) : [];

        //console.log("FilletFeature input objects:", inputObjects);

        let edgeObjs = [];

        inputObjects.forEach(obj => {
            //console.log("Processing input object:", obj);
            if (obj.type === "EDGE") {

                // check if edge already in array
                if (edgeObjs.includes(obj)) return;
                edgeObjs.push(obj);
            }
            if (obj.type === "FACE") {
                // if the object is a face, it might have multiple edges selected
                for (const edge of obj.edges) {
                    if (edgeObjs.includes(edge)) return;
                    edgeObjs.push(edge);

                }
            }

        });





        if (edgeObjs.length === 0) {
            console.warn("No edges selected for fillet");
            return [];
        }
        const solids = new Set(edgeObjs.map(e => e.parentSolid || e.parent));

        if (solids.size === 0) {
            console.warn("Selected edges do not belong to any solid");
            return [];
        }
        if (solids.size > 1) {
            console.warn("Selected edges belong to multiple solids");
            return [];
        }

        const targetSolid = edgeObjs[0].parentSolid || edgeObjs[0].parent;

        // Pre-remesh the target solid for more regular triangles before
        // constructing fillet tools. Use max edge length = radius / 2.
        // Important: remeshing + visualize() rebuilds child Edge objects,
        // so we must remap the selected edges to their new counterparts.
        try {
            const r = Number(this.inputParams.radius);
            if (Number.isFinite(r) && r > 0) {
                // Capture descriptors for currently selected edges
                const toDesc = (edge) => {
                    const ua = edge?.userData || {};
                    const faceA = ua.faceA || (edge?.faces?.[0]?.name) || null;
                    const faceB = ua.faceB || (edge?.faces?.[1]?.name) || null;
                    const pair = (faceA && faceB) ? (faceA < faceB ? [faceA, faceB] : [faceB, faceA]) : null;
                    const pts = Array.isArray(ua.polylineLocal) ? ua.polylineLocal : null;
                    const center = (() => {
                        if (!pts || pts.length === 0) return [0, 0, 0];
                        let sx = 0, sy = 0, sz = 0;
                        for (const p of pts) { sx += p[0]; sy += p[1]; sz += p[2]; }
                        const inv = 1 / pts.length; return [sx * inv, sy * inv, sz * inv];
                    })();
                    const length = (() => {
                        if (!pts || pts.length < 2) return 0;
                        let L = 0;
                        for (let i = 0; i < pts.length - 1; i++) {
                            const a = pts[i], b = pts[i + 1];
                            const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
                            L += Math.hypot(dx, dy, dz);
                        }
                        return L;
                    })();
                    return { pair, center, length, closed: !!edge?.closedLoop };
                };
                const oldDescs = edgeObjs.map(toDesc);

                const maxEdge = Math.max(1e-6, r / 2);
                targetSolid.remesh({ maxEdgeLength: maxEdge });
                // Refresh edge polylines for visualization
                try { targetSolid.visualize(); } catch (_) { }

                // Remap to new Edge objects by matching face-pair and closest center
                const allEdges = targetSolid.children.filter(o => o && o.type === 'EDGE');
                const dist2 = (a, b) => {
                    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
                    return dx * dx + dy * dy + dz * dz;
                };
                const centerOf = (edge) => {
                    const pts = edge?.userData?.polylineLocal;
                    if (!Array.isArray(pts) || pts.length === 0) return [0, 0, 0];
                    let sx = 0, sy = 0, sz = 0;
                    for (const p of pts) { sx += p[0]; sy += p[1]; sz += p[2]; }
                    const inv = 1 / pts.length; return [sx * inv, sy * inv, sz * inv];
                };
                const lengthOf = (edge) => {
                    const pts = edge?.userData?.polylineLocal;
                    if (!Array.isArray(pts) || pts.length < 2) return 0;
                    let L = 0; for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1]; L += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
                    return L;
                };
                const pairOf = (edge) => {
                    const ua = edge?.userData || {};
                    const faceA = ua.faceA || (edge?.faces?.[0]?.name) || null;
                    const faceB = ua.faceB || (edge?.faces?.[1]?.name) || null;
                    return (faceA && faceB) ? (faceA < faceB ? [faceA, faceB] : [faceB, faceA]) : null;
                };

                const remapped = [];
                for (const desc of oldDescs) {
                    if (!desc.pair) continue;
                    let best = null; let bestCost = Infinity;
                    for (const e of allEdges) {
                        const pair = pairOf(e);
                        if (!pair || pair[0] !== desc.pair[0] || pair[1] !== desc.pair[1]) continue;
                        if (e.closedLoop !== desc.closed) continue;
                        const c = centerOf(e);
                        const L = lengthOf(e);
                        const d2 = dist2(c, desc.center);
                        const dL = Math.abs(L - desc.length);
                        const cost = d2 + 0.01 * dL;
                        if (cost < bestCost) { bestCost = cost; best = e; }
                    }
                    if (best) remapped.push(best);
                }

                if (remapped.length) {
                    edgeObjs = remapped;
                } else {
                    console.warn('[FilletFeature] remesh edge remap failed; no matching edges found.');
                    // If we continue, selected Edge parents are likely null; abort gracefully
                    return [];
                }
            }
        } catch (e) {
            console.warn('[FilletFeature] remesh skipped:', e?.message || e);
        }

        // Create the fillet solid for each edge
        fjson('FeatureStart', {
            edgesSelected: edgeObjs.length,
            radius: this.inputParams.radius,
            inflate: this.inputParams.inflate,
            direction: this.inputParams.direction,
            debug: !!this.inputParams.debug
        });
        const objectsForBoolean = [];
        for (let idx = 0; idx < edgeObjs.length; idx++) {
            const edgeObj = edgeObjs[idx];
            const edgeName = (edgeObj && edgeObj.name) || null;
            fjson('BuildToolStart', { idx, edge: edgeName });
            const filletSolid = makeSingleFilletSolid(edgeObj,
                this.inputParams.radius,
                this.inputParams.inflate,
                this.inputParams.direction,
                this.inputParams.debug);
            if (dbg) { try { filletSolid.visualize(); } catch {} }
            objectsForBoolean.push(filletSolid);
            if (dbg) {
                try { console.log(`[FilletFeature] Created fillet tool for edge ${edgeName || '(unnamed)'}: volume=${safeVolume(filletSolid)}`); } catch {}
                try { console.log(filletSolid); } catch {}
            }
            // Summarize tool mesh if available
            try {
                const mesh = filletSolid.getMesh();
                const counts = {
                    vertices: (mesh.vertProperties?.length || 0) / 3 | 0,
                    triangles: (mesh.triVerts?.length || 0) / 3 | 0,
                    faceLabels: (mesh.faceID?.length || 0) / 1 | 0
                };
                fjson('BuildToolDone', { idx, edge: edgeName, filletType: filletSolid.filletType || null, counts });
            } catch (e) {
                fjson('BuildToolError', { idx, edge: edgeName, message: e?.message || String(e) });
            }
        }

        // Apply booleans sequentially using shared helper; supports robust nudge behavior
        let finalSolid = targetSolid;
        const toRemove = new Set();
        for (let idx = 0; idx < objectsForBoolean.length; idx++) {
            const tool = objectsForBoolean[idx];
            const dir = String(this.inputParams.direction || 'INSET').toUpperCase();
            const op = (dir === 'OUTSET' ? 'UNION' : 'SUBTRACT');
            const beforeVol = safeVolume(finalSolid);
                const params = { operation: op, targets: [] };
            // Encourage distinct end-cap faces after subtraction by slightly
            // nudging coplanar caps off target faces when needed. Use the user's
            // inflate if provided, else a small fraction of the radius.
            if (op === 'SUBTRACT') {
                const mag = Math.max(0, Number(this.inputParams.inflate) || 0);
                const dist = (mag > 0) ? mag : Math.max(1e-4, 0.02 * Math.abs(Number(this.inputParams.radius) || 1));
                params.offsetCoplanarCap = 'START+;END+'; // both caps outward
                params.offsetDistance = dist;
            }
            let effects = { added: [], removed: [] };

            if (op === 'SUBTRACT') {
                // base = tool, targets = [finalSolid]
                params.targets = [finalSolid];
                fjson('BooleanTry', { idx, op, before: beforeVol, toolVol: safeVolume(tool) });
                effects = await BREP.applyBooleanOperation(partHistory, tool, params, null);
                finalSolid = effects.added[0] || finalSolid;
            } else {
                // UNION/INTERSECT: base = finalSolid, targets = [tool]
                params.targets = [tool];
                fjson('BooleanTry', { idx, op, before: beforeVol, toolVol: safeVolume(tool) });
                effects = await BREP.applyBooleanOperation(partHistory, finalSolid, params, null);
                finalSolid = effects.added[0] || finalSolid;
            }

            fjson('BooleanDone', { idx, op, after: safeVolume(finalSolid) });
            // Flag removed artifacts for scene cleanup
            // In debug mode, keep fillet tools visible: don't mark them for removal.
            for (const r of effects.removed) {
                if (!r) continue;
                if (this.inputParams.debug && objectsForBoolean.includes(r)) continue;
                toRemove.add(r);
            }
        }

        finalSolid.name = `${targetSolid.name}`;
        //finalSolid.removeSmallInternalIslands(100);

        //const actualFinalSolid = await finalSolid.simplify(0.00001);
        const actualFinalSolid = await finalSolid.simplify(0.0001);
        actualFinalSolid.name = `${targetSolid.name}`;
        actualFinalSolid.visualize();

        // Alert if any triangles in the final solid are missing a face name
        try {
            const mesh = actualFinalSolid.getMesh && actualFinalSolid.getMesh();
            const faceIDs = mesh && mesh.faceID ? Array.from(mesh.faceID) : [];
            const idToName = actualFinalSolid && actualFinalSolid._idToFaceName ? actualFinalSolid._idToFaceName : new Map();
            if (faceIDs.length) {
                let missing = 0;
                for (let i = 0; i < faceIDs.length; i++) {
                    const id = faceIDs[i];
                    if (!idToName.has(id)) missing++;
                }
                if (missing > 0) {
                    const msg = `Fillet result warning: ${missing} triangle(s) in the final solid are missing a face name.`;
                    if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(msg);
                    else if (typeof alert === 'function') alert(msg);
                    else console.warn(msg);
                }
            }
        } catch (e) {
            // Non-fatal; continue pipeline
            console.warn('[FilletFeature] Face-name check failed:', e?.message || e);
        }
        // Replace original target solid
        toRemove.add(targetSolid);

        // Mark removals via flag for PartHistory to collect
        try { for (const r of toRemove) { if (r) r.remove = true; } } catch { }

        // Return only the resulting artifacts to add
        const out = [];
        if (this.inputParams.debug) {
            for (const tool of objectsForBoolean) { try { tool.visualize(); } catch {} }
            out.push(...objectsForBoolean, targetSolid);
        }
        out.push(actualFinalSolid);
        return out;
    }
}



function makeSingleFilletSolid(edgeObj,
    radius = 1,
    inflate = 0,
    direction = 'INSET',
    debug = false) {
    // Only UI params are accepted; all robustness knobs are internal.
    const tool = new BREP.FilletSolid({
        edgeToFillet: edgeObj,
        radius,
        inflate,
        sideMode: direction,
        debug,
    });
    // tool.fixTriangleWindingsByAdjacency();
    // tool.invertNormals();
    tool.name = "FILLET_TOOL";
    try { tool.visualize(); } catch {}

    // No extra flips or authoring tweaks here; FilletSolid handles robustness internally.
    return tool;
}

// (removed unused duplicate safeVolume; run() defines its own helper)
