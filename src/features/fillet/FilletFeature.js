import { add } from "three/tsl";
import { clearFilletCaches, computeFilletCenterline, filletSolid } from "../../BREP/fillets/fillet.js";
import { applyBooleanOperation } from "../../BREP/applyBooleanOperation.js";


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
        this.inputParams = {};
        this.persistentData = {};
    }
    async run(partHistory) {
        // Clear caches between runs
        try { clearFilletCaches(); } catch { }
        const added = [];
        const removed = [];

        // Accept resolved objects from sanitizeInputParams
        const inputObjects = Array.isArray(this.inputParams.edges) ? this.inputParams.edges.filter(Boolean) : [];

        let edgeObjs = [];
        inputObjects.forEach(obj => {
            if (obj.type === "EDGE") {
                if (!edgeObjs.includes(obj)) edgeObjs.push(obj);
            }
            if (obj.type === "FACE") {
                for (const edge of obj.edges) {
                    edgeObjs.push(edge);
                }
            }
        });

        // Deduplicate and ensure edges belong to a solid
        edgeObjs = Array.from(new Set(edgeObjs));
        edgeObjs = edgeObjs.filter(e => (e && (e.parentSolid || e.parent)));

        if (edgeObjs.length === 0) {
            console.warn("No edges selected for fillet");
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

        // Centerline-only mode: compute overlays and exit. No geometry changes.

        const dir = String(this.inputParams.direction || 'INSET').toUpperCase();
        const r = Number(this.inputParams.radius);



        const filletSolids = [];
        const debugSolids = []; // Store tube and wedge solids for debug mode

        if (Number.isFinite(r) && r > 0) {
            const fid = this.inputParams?.featureID || 'FILLET';
            let ci = 0;
            // Collect individual fillet solids per edge to combine later

            for (const e of edgeObjs) {
                try {
                    console.log(e);
                    try {
                        const res = filletSolid({
                            edgeToFillet: e,
                            radius: r,
                            sideMode: dir,
                            inflate: Number(this.inputParams.inflate) || 0,
                            debug: !!this.inputParams.debug,
                            name: `${fid}_FILLET_${ci++}`
                        });

                        const { finalSolid, tube, wedge } = res || {};
                        if (finalSolid) {
                            filletSolids.push({ finalSolid, target: e.parentSolid });
                            
                            // Store debug solids for debug mode
                            if (tube) debugSolids.push(tube);
                            if (wedge) debugSolids.push(wedge);
                        }

                        console.log("Fillet solid created for edge:", e);



                    } catch (filletError) {
                        console.error("Failed to create FilletSolid:", filletError?.message || filletError);
                        // Continue with next edge instead of stopping entirely
                    }

                } catch (error) {
                    console.warn("Fillet generation failed for edge:", e, error);
                }
            }
        }


        //console.log("Fillet solids created:", filletSolids);
        // group fillet solids by their target solids
        const filletsByTarget = new Map();
        for (const { finalSolid, target } of filletSolids) {
            if (!filletsByTarget.has(target)) filletsByTarget.set(target, []);
            filletsByTarget.get(target).push(finalSolid);
        }


        // Apply fillet solids to their target solids using the boolean union for outset and boolean subtract for inset
        for (const [targetSolid, filletSolids] of filletsByTarget.entries()) {
            console.log("Applying fillets to target solid:", targetSolid, filletSolids);
            let solidResult = targetSolid;


            //loop over each fillet solid and apply boolean operation
            for (const filletSolid of filletSolids) {
                // check if we are doing INSET or OUTSET
                if (dir === "OUTSET") {
                    solidResult = solidResult.union(filletSolid);
                } else if (dir === "INSET") {
                    solidResult = solidResult.subtract(filletSolid);
                }
            }

            removed.push(targetSolid);
            added.push(solidResult);

        }


        // if debug is enabled, add all debug solids (tube and wedge solids)
        if (this.inputParams.debug) {
            debugSolids.forEach(debugSolid => {
                added.push(debugSolid);
            });
        }


        return { added, removed };
    }
}
