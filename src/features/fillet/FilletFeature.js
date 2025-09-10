import { extractDefaultValues } from "../../PartHistory.js";
import { FilletSolid } from '../../BREP/fillet.js';

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
        // check if all the edges belong to the same solid
        const inputObjects = partHistory.getObjectsByName(this.inputParams.edges);

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

        const targetSolid = edgeObjs[0].parent;

        // Create the fillet solid for each edge
        const objectsForBoolean = [];
        for (const edgeObj of edgeObjs) {
            const filletSolid = makeSingleFilletSolid(edgeObj,
                this.inputParams.radius,
                this.inputParams.inflate,
                this.inputParams.direction,
                this.inputParams.debug,
                this.inputParams.projectStripsOpenEdges,
                this.inputParams.forceSeamInset,
                this.inputParams.seamInsetScale);
            objectsForBoolean.push(filletSolid);
        }

        // based on if the fillet direction is inset or outset, we either subtract or union the fillet solids
        // we need to do each operation one by one to avoid issues with overlapping solids
        let finalSolid = targetSolid;
        for (const obj of objectsForBoolean) {
            if (this.inputParams.direction === "OUTSET") {
                finalSolid = finalSolid.union(obj);

            } else if (this.inputParams.direction === "INSET") {
                finalSolid = finalSolid.subtract(obj);

            } else { // AUTO
                // try subtract first, if it fails, do union
                try {
                    finalSolid = finalSolid.subtract(obj);
                } catch (e) {
                    try {
                        finalSolid = finalSolid.union(obj);
                    } catch (e) {
                        console.error("Failed to union object:", e);
                    }
                }
            }




        }

        finalSolid.name = `${targetSolid.name}`;
        finalSolid.visualize();




        if (this.inputParams.debug) {
            return [finalSolid, ...objectsForBoolean];
        } else {
            targetSolid.remove = true; // mark the original solid for removal
            return [finalSolid];
        }
    }
}



function makeSingleFilletSolid(edgeObj,
    radius = 1,
    inflate = 0,
    direction = 'INSET',
    debug = false,
    projectStripsOpenEdges = false,
    forceSeamInset = false,
    seamInsetScale = 1e-3) {
    const flipSide = false;
    const flipTangent = false;
    const swapFaces = false;


    //console.log("Creating fillet solid for edge:", edgeObj, radius, inflate, flipSide, direction, flipTangent, swapFaces, debug);

    const tool = new FilletSolid({ edgeToFillet: edgeObj, radius, inflate, invert2D: false, reverseTangent: !!flipTangent, swapFaces: !!swapFaces, sideMode: direction, debug, projectStripsOpenEdges, forceSeamInset, seamInsetScale });
    // tool.fixTriangleWindingsByAdjacency();
    // tool.invertNormals();
    tool.name = "FILLET_TOOL";
    tool.visualize();

    // if (direction === 'OUTSET') {

    //     tool.flip(); // flip the solid to make it suitable for union
    // }
    return tool;
}
