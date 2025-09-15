import { extractDefaultValues } from "../../PartHistory.js";
import { FilletSolid } from '../../BREP/fillet.js';
import { applyBooleanOperation } from "../../BREP/applyBooleanOperation.js";

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the fillet feature",
    },
    edges: {
        type: "reference_selection",
        selectionFilter: ["EDGE", "FACE"],
        multiple: true,
        default_value: null,
        hint: "Select a single edge to preview its fillet solid",
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
        hint: "Grow the cutting solid by this amount (units). Use small values like 0.0005 to avoid thin leftovers after subtraction.",
    },
    projectStripsOpenEdges: {
        type: "boolean",
        default_value: false,
        hint: "Use face‑projected side strips even for open edges (safer but can affect INSET cases)",
    },
    projectStripsClosedEdges: {
        type: "boolean",
        default_value: true,
        hint: "Use face‑projected side strips for closed loops (disable to force analytic side strips)",
    },
    forceSeamInset: {
        type: "boolean",
        default_value: false,
        hint: "Inset seam into faces for open edges (reduces coplanar overlaps; disable if INSET fillets misbehave)",
    },
    seamInsetScale: {
        type: "number",
        step: 1e-4,
        default_value: 1e-3,
        hint: "Scale factor for seam inset distance relative to radius",
    },

    direction: {
        type: "options",
        options: ["INSET", "OUTSET", "AUTO"],
        default_value: "INSET",
        hint: "Prefer fillet inside (INSET), outside (OUTSET), or auto-pick (AUTO)",
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

        const edgeObjs = [];

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

        // Create the fillet solid for each edge
        fjson('FeatureStart', {
            featureID: this.inputParams.featureID || null,
            edgesSelected: edgeObjs.length,
            radius: this.inputParams.radius,
            inflate: this.inputParams.inflate,
            direction: this.inputParams.direction,
            projectStripsOpenEdges: this.inputParams.projectStripsOpenEdges,
            forceSeamInset: this.inputParams.forceSeamInset,
            seamInsetScale: this.inputParams.seamInsetScale
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
                this.inputParams.debug,
                this.inputParams.projectStripsOpenEdges,
                this.inputParams.projectStripsClosedEdges,
                this.inputParams.forceSeamInset,
                this.inputParams.seamInsetScale);
            objectsForBoolean.push(filletSolid);
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
        for (let idx = 0; idx < objectsForBoolean.length; idx++) {
            const tool = objectsForBoolean[idx];
            const dir = String(this.inputParams.direction || 'INSET').toUpperCase();
            const op = (dir === 'AUTO') ? ((tool && tool.filletType) || 'SUBTRACT') : (dir === 'OUTSET' ? 'UNION' : 'SUBTRACT');
            const beforeVol = safeVolume(finalSolid);
            const params = { operation: op, opperation: op, targets: [] };
            let outputs = [];

            if (op === 'SUBTRACT') {
                // base = tool, targets = [finalSolid]
                params.targets = [finalSolid];
                fjson('BooleanTry', { idx, op, before: beforeVol, toolVol: safeVolume(tool) });
                outputs = await applyBooleanOperation(partHistory, tool, params, this.inputParams.featureID);
                finalSolid = outputs[0] || finalSolid;
            } else {
                // UNION/INTERSECT: base = finalSolid, targets = [tool]
                params.targets = [tool];
                fjson('BooleanTry', { idx, op, before: beforeVol, toolVol: safeVolume(tool) });
                outputs = await applyBooleanOperation(partHistory, finalSolid, params, this.inputParams.featureID);
                finalSolid = outputs[0] || finalSolid;
            }

            fjson('BooleanDone', { idx, op, after: safeVolume(finalSolid) });
        }

        finalSolid.name = `${targetSolid.name}`;
        finalSolid.removeSmallInternalIslands(100);
        finalSolid.simplify(.01);
        finalSolid.visualize();


        targetSolid.remove = true;

        if (this.inputParams.debug) return [finalSolid, ...objectsForBoolean];
        return [finalSolid];
    }
}



function makeSingleFilletSolid(edgeObj,
    radius = 1,
    inflate = 0,
    direction = 'INSET',
    debug = false,
    projectStripsOpenEdges = false,
    projectStripsClosedEdges = true,
    forceSeamInset = false,
    seamInsetScale = 1e-3) {
    const flipSide = false;
    const flipTangent = false;
    const swapFaces = false;


    //console.log("Creating fillet solid for edge:", edgeObj, radius, inflate, flipSide, direction, flipTangent, swapFaces, debug);

    // Robust defaults: do NOT force face‑projected side strips on open edges.
    // Leave projection opt‑in via projectStripsOpenEdges; still prefer seam inset for INSET.
    const robustProjectOpen = projectStripsOpenEdges;
    const robustProjectClosed = projectStripsClosedEdges;
    const robustInset = forceSeamInset || (direction === 'INSET');

    const tool = new FilletSolid({
        edgeToFillet: edgeObj,
        radius,
        inflate,
        invert2D: false,
        reverseTangent: !!flipTangent,
        swapFaces: !!swapFaces,
        sideMode: direction,
        debug,
        projectStripsOpenEdges: robustProjectOpen,
        projectStripsClosedEdges: robustProjectClosed,
        forceSeamInset: robustInset,
        seamInsetScale
    });
    // tool.fixTriangleWindingsByAdjacency();
    // tool.invertNormals();
    tool.name = "FILLET_TOOL";
    tool.visualize();

    // if (direction === 'OUTSET') {

    //     tool.flip(); // flip the solid to make it suitable for union
    // }
    return tool;
}

function safeVolume(s) {
    try { return s.volume(); } catch { return 0; }
}
