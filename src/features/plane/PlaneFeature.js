import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;
import { CADmaterials } from '../../UI/CADmaterials.js';

const inputParamsSchema = {
    id: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the plane feature",
    },
    datum: {
        type: "reference_selection",
        selectionFilter: ["datum"],
        multiple: false,
        default_value: null,
        hint: "Optional reference datum",

    },
    orientation: {
        type: "options",
        options: ["XY", "XZ", "YZ"],
        default_value: "XY",
        hint: "Plane orientation",
    },
    offset_distance: {
        type: "number",
        default_value: 0,
        hint: "Plane offset distance",
    },
};






export class PlaneFeature {
    static shortName = "P";
    static longName = "Plane";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        
        this.persistentData = {};
    }
    async run() {
        const planeMesh = await this.createPlaneMesh();
        const added = planeMesh ? [planeMesh] : [];
        return { added, removed: [] };
    }

    async createPlaneMesh() {
        // When sanitized, reference_selection becomes an array; treat empty as no datum
        const hasDatum = Array.isArray(this.inputParams.datum) ? this.inputParams.datum.length > 0 : !!this.inputParams.datum;
        if (hasDatum) {
            // Create the plane mesh with reference to the datum
            // Add your async logic here if needed
        } else {
            const planeMesh = await new THREE.Mesh(
                new THREE.PlaneGeometry(5, 5),
                (CADmaterials?.PLANE?.BASE ?? new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide, opacity: 0.1, transparent: true, depthWrite: false }))
            );
            planeMesh.rotation.x = this.inputParams.orientation === "XZ" ? Math.PI / 2 : 0;
            planeMesh.rotation.y = this.inputParams.orientation === "YZ" ? Math.PI / 2 : 0;
            //planeMesh.position.z = this.inputParams.orientation === "XY" ? Math.PI / 2 : 0;
            planeMesh.uuid = this.inputParams.featureID; // Assign the featureID to the mesh's uuid
            planeMesh.name = this.inputParams.featureID; // Ensure selectable by name
            planeMesh.type = 'PLANE';                    // Participate in PLANE selection
            return planeMesh;
        }
    }

}
