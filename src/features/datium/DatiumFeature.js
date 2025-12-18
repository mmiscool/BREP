
import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;
import { CADmaterials } from '../../UI/CADmaterials.js';

const inputParamsSchema = {
    id: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the datium feature",
    },
    // Optional placement/orientation via TRS
    transform: {
        type: 'transform',
        default_value: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        hint: 'Position, rotation, and scale'
    },
};

export class DatiumFeature {
    static shortName = "D";
    static longName = "Datium";
    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        this.persistentData = {};
    }

    async run(/* partHistory */) {
        // Build a group with 3 orthogonal plane meshes (XY, XZ, YZ)
        const group = new THREE.Group();
        const baseName = this.inputParams.featureID || 'Datium';
        group.name = baseName;
        group.type = 'DATUM';
        // Provide a no-op click handler for UI safety
        group.onClick = () => {};

        const mkPlane = (orientation, suffix) => {
            const mat = (CADmaterials?.PLANE?.BASE) || new THREE.MeshBasicMaterial({ color: 0x2eff2e, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false });
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), mat);
            mesh.name = `${baseName}:${suffix}`;
            mesh.type = 'PLANE';
            mesh.userData = mesh.userData || {};
            mesh.userData.orientation = orientation;
            // Orient like PlaneFeature for consistency
            if (orientation === 'XZ') mesh.rotation.x = Math.PI / 2; // normal ±Y
            if (orientation === 'YZ') mesh.rotation.y = Math.PI / 2; // normal ±X
            return mesh;
        };

        const pXY = mkPlane('XY', 'XY');
        const pXZ = mkPlane('XZ', 'XZ');
        const pYZ = mkPlane('YZ', 'YZ');
        group.add(pXY, pXZ, pYZ);
        group.renderOrder = 1; // Render on top of most things

        // Apply TRS to the whole datum group (position/orient in 3D space)
        try {
            const trs = this.inputParams?.transform || {};
            const p = Array.isArray(trs.position) ? trs.position : [0, 0, 0];
            const r = Array.isArray(trs.rotationEuler) ? trs.rotationEuler : [0, 0, 0];
            const s = Array.isArray(trs.scale) ? trs.scale : [1, 1, 1];
            group.position.set(Number(p[0] || 0), Number(p[1] || 0), Number(p[2] || 0));
            group.rotation.set(
                THREE.MathUtils.degToRad(Number(r[0] || 0)),
                THREE.MathUtils.degToRad(Number(r[1] || 0)),
                THREE.MathUtils.degToRad(Number(r[2] || 0))
            );
            group.scale.set(Number(s[0] || 1), Number(s[1] || 1), Number(s[2] || 1));
        } catch (_) { /* ignore */ }

        return { added: [group], removed: [] };
    }
}
