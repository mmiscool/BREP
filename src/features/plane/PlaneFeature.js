import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;
import { CADmaterials } from '../../UI/CADmaterials.js';

export function createPlaneBaseMesh() {
    const material = CADmaterials.PLANE.BASE;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), material);
    mesh.type = 'PLANE';
    mesh.renderOrder = 1;
    return mesh;
}

const inputParamsSchema = {
    id: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the plane feature",
    },
    datum: {
        type: "reference_selection",
        selectionFilter: ["PLANE", "FACE"],
        multiple: false,
        default_value: null,
        hint: "Optional reference plane or face",

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
        if (!planeMesh) return { added: [], removed: [] };

        const group = new THREE.Group();
        group.renderOrder = 1;
        const featureID = this.inputParams.featureID || null;
        const label = planeMesh.name || featureID || 'Plane';
        group.name = `D:${label}`;
        group.type = 'DATUM';
        group.add(planeMesh);

        if (featureID != null) {
            planeMesh.owningFeatureID = String(featureID);
        }

        return { added: [group], removed: [] };
    }

    async createPlaneMesh() {
        // When sanitized, reference_selection becomes an array; treat empty as no datum
        const datum = Array.isArray(this.inputParams.datum) ? this.inputParams.datum[0] : this.inputParams.datum;
        const basis = datum ? this.#basisFromReference(datum) : this.#basisFromOrientation(this.inputParams.orientation);
        if (!basis) return null;

        const planeMesh = createPlaneBaseMesh();

        const basisMatrix = new THREE.Matrix4().makeBasis(basis.x, basis.y, basis.z);
        planeMesh.setRotationFromMatrix(basisMatrix);
        planeMesh.position.copy(basis.origin);

        const offset = Number(this.inputParams.offset_distance) || 0;
        if (offset) planeMesh.position.addScaledVector(basis.z, offset);

        //planeMesh.uuid = this.inputParams.featureID; // Assign the featureID to the mesh's uuid
        planeMesh.name = this.inputParams.featureID; // Ensure selectable by name
        return planeMesh;
    }

    #basisFromOrientation(orientation) {
        const rotX = orientation === "XZ" ? Math.PI / 2 : 0;
        const rotY = orientation === "YZ" ? Math.PI / 2 : 0;
        const rot = new THREE.Euler(rotX, rotY, 0);
        const origin = new THREE.Vector3(0, 0, 0);
        const x = new THREE.Vector3(1, 0, 0).applyEuler(rot).normalize();
        const y = new THREE.Vector3(0, 1, 0).applyEuler(rot).normalize();
        const z = new THREE.Vector3(0, 0, 1).applyEuler(rot).normalize();
        return { origin, x, y, z };
    }

    #basisFromReference(refObj) {
        if (!refObj) return null;
        const origin = new THREE.Vector3();
        try { refObj.updateWorldMatrix(true, true); } catch { }

        try {
            const g = refObj.geometry;
            if (g) {
                const bs = g.boundingSphere || (g.computeBoundingSphere(), g.boundingSphere);
                if (bs) origin.copy(refObj.localToWorld(bs.center.clone()));
                else origin.copy(refObj.getWorldPosition(new THREE.Vector3()));
            } else {
                origin.copy(refObj.getWorldPosition(new THREE.Vector3()));
            }
        } catch {
            origin.copy(refObj.getWorldPosition(new THREE.Vector3()));
        }

        if (refObj.type === 'FACE') {
            let n = null;
            try {
                if (typeof refObj.getAverageNormal === 'function') n = refObj.getAverageNormal().clone();
            } catch { n = null; }
            if (!n || n.lengthSq() < 1e-12) {
                const q = new THREE.Quaternion();
                try { refObj.getWorldQuaternion(q); } catch { }
                n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
            }
            n.normalize();

            const worldUp = new THREE.Vector3(0, 1, 0);
            const refUp = Math.abs(n.dot(worldUp)) > 0.9 ? new THREE.Vector3(1, 0, 0) : worldUp;
            const x = new THREE.Vector3().crossVectors(refUp, n).normalize();
            const y = new THREE.Vector3().crossVectors(n, x).normalize();
            return { origin, x, y, z: n };
        }

        try {
            const q = new THREE.Quaternion();
            refObj.getWorldQuaternion(q);
            const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
            const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize();
            const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
            return { origin, x, y, z };
        } catch {
            return this.#basisFromOrientation(this.inputParams.orientation);
        }
    }

}
