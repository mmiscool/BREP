import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;
// no direct BREP usage here

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the mirror feature",
    },
    solids: {
        type: "reference_selection",
        selectionFilter: ["SOLID"],
        multiple: true,
        default_value: [],
        hint: "Select one or more solids to mirror",
    },
    mirrorPlane: {
        type: "reference_selection",
        // Allow mirroring about either a face or a datum plane
        selectionFilter: ["FACE", "PLANE"],
        multiple: false,
        default_value: null,
        hint: "Select the plane or face to mirror about",
    },
    offsetDistance: {
        type: "number",
        default_value: 0,
        hint: "Offset distance for the mirror",
    }
};

export class MirrorFeature {
    static featureName = "Mirror";
    static featureShortName = "M";

    static inputParamsSchema = inputParamsSchema;

    constructor() {
        this.inputParams = {};
        this.persistentData = {};
    }
    async run(partHistory) {
        const scene = partHistory.scene;
        const featureID = this.inputParams.featureID || 'MIRROR';

        // Resolve targets as objects
        const solidObjs = Array.isArray(this.inputParams.solids) ? this.inputParams.solids.filter(Boolean) : [];
        if (!solidObjs.length) return [];

        // Resolve mirror reference (face or plane mesh) as object
        const refObj = Array.isArray(this.inputParams.mirrorPlane)
            ? (this.inputParams.mirrorPlane[0] || null)
            : (this.inputParams.mirrorPlane || null);
        if (!refObj) return [];

        // Compute plane origin and normal
        const plane = this.#computeMirrorPlane(refObj, Number(this.inputParams.offsetDistance) || 0);
        if (!plane) return [];

        const added = [];
        for (const src of solidObjs) {
            if (!src || src.type !== 'SOLID') continue;
            const mirrored = src.mirrorAcrossPlane(plane.point, plane.normal);
            // mutate face names so they are distinct for this feature
            try {
                const idToFaceName = mirrored._idToFaceName instanceof Map ? mirrored._idToFaceName : new Map();
                const mutatedIdToFace = new Map();
                const mutatedFaceToId = new Map();
                for (const [fid, fname] of idToFaceName.entries()) {
                    const base = String(fname ?? 'Face');
                    const feat = String(featureID ?? 'MIRROR');
                    const newName = `${base}::${feat}`;
                    mutatedIdToFace.set(fid, newName);
                    mutatedFaceToId.set(newName, fid);
                }
                mirrored._idToFaceName = mutatedIdToFace;
                mirrored._faceNameToID = mutatedFaceToId;
            } catch (_) { }
            mirrored.name = `${featureID}:${src.name}:M`;
            // Build face/edge meshes for interaction/visibility
            mirrored.visualize();
            added.push(mirrored);
        }
        return added;
    }

    /**
     * Given a reference object (FACE or a plane Mesh), compute the mirror plane.
     * Returns { point: THREE.Vector3, normal: THREE.Vector3 }
     */
    #computeMirrorPlane(refObj, offset) {
        const n = new THREE.Vector3();
        const p = new THREE.Vector3();

        // If it's a FACE from our BREP visualization
        if (refObj.type === 'FACE' && refObj.geometry) {
            // Average normal (area-weighted) and centroid (area-weighted)
            const pos = refObj.geometry.getAttribute('position');
            if (!pos || pos.count < 3) return null;

            const a = new THREE.Vector3();
            const b = new THREE.Vector3();
            const c = new THREE.Vector3();
            const ab = new THREE.Vector3();
            const ac = new THREE.Vector3();
            const centroid = new THREE.Vector3();
            let areaSum = 0;
            const toWorld = (out, i) => out.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(refObj.matrixWorld);

            const triCount = (pos.count / 3) | 0;
            const nAccum = new THREE.Vector3();
            for (let t = 0; t < triCount; t++) {
                const i0 = 3 * t + 0;
                const i1 = 3 * t + 1;
                const i2 = 3 * t + 2;
                toWorld(a, i0); toWorld(b, i1); toWorld(c, i2);
                ab.subVectors(b, a);
                ac.subVectors(c, a);
                const cross = new THREE.Vector3().crossVectors(ac, ab); // area-weighted normal (2*area)
                const triArea = 0.5 * cross.length();
                if (triArea > 0) {
                    // centroid of triangle
                    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
                    p.addScaledVector(centroid, triArea);
                    nAccum.add(cross);
                    areaSum += triArea;
                }
            }
            if (areaSum <= 0 || nAccum.lengthSq() === 0) return null;
            p.multiplyScalar(1 / areaSum);
            n.copy(nAccum.normalize());
        } else {
            // Try to interpret as a plane-like Mesh: use its world position and local +Z as normal
            // This matches PlaneGeometry default (XY plane, +Z normal) with applied rotations.
            try {
                const worldQ = new THREE.Quaternion();
                refObj.getWorldQuaternion(worldQ);
                n.set(0, 0, 1).applyQuaternion(worldQ).normalize();
                refObj.getWorldPosition(p);
            } catch (_) {
                return null;
            }
        }

        if (offset) p.addScaledVector(n, offset);
        return { point: p, normal: n };
    }

    // mirror implementation lives in Solid.mirrorAcrossPlane()
}
