
import { extractDefaultValues } from "../../PartHistory.js";
import * as THREE from 'three';
import { CADmaterials } from '../../UI/CADmaterials.js';

const inputParamsSchema = {
    featureID: {
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
    static featureShortName = "P";
    static featureName = "Plane";
    static inputParamsSchema = inputParamsSchema;

    constructor(partHistory) {
        this.partHistory = partHistory;
        this.inputParams = extractDefaultValues(inputParamsSchema);
        
        this.persistentData = {};
    }
    async run() {
        console.log(this.inputParams.featureID, "is the featureID");

        const planeMesh = await this.createPlaneMesh();

        return [planeMesh];
    }

    async createPlaneMesh() {
        if (this.inputParams.datum) {
            // Create the plane mesh with reference to the datum
            // Add your async logic here if needed
        } else {
            const planeMesh = await new THREE.Mesh(
                new THREE.PlaneGeometry(5, 5),
                (CADmaterials?.PLANE?.BASE ?? new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide, opacity: 0.1, transparent: true }))
            );
            planeMesh.rotation.x = this.inputParams.orientation === "XZ" ? Math.PI / 2 : 0;
            planeMesh.rotation.y = this.inputParams.orientation === "YZ" ? Math.PI / 2 : 0;
            //planeMesh.position.z = this.inputParams.orientation === "XY" ? Math.PI / 2 : 0;
            planeMesh.uuid = this.inputParams.featureID; // Assign the featureID to the mesh's uuid
            planeMesh.name = this.inputParams.featureID; // Ensure selectable by name
            planeMesh.type = 'PLANE';                    // Participate in PLANE selection
            //console.log("this is the uuid", planeMesh.uuid, "and the featureID", this.inputParams.featureID);
            return planeMesh;
        }
    }

}
