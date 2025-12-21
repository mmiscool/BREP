import * as THREE from "three";
import { CADmaterials } from "../UI/CADmaterials.js";

export class Face extends THREE.Mesh {
    constructor(geometry) {
        super(geometry, CADmaterials.FACE.BASE);
        this.edges = [];
        this.name = null;
        this.type = 'FACE';
        this.parentSolid = null;
    }

    // Compute the average geometric normal of this face's triangles in world space.
    // Weighted by triangle area via cross product magnitude.
    getAverageNormal() {
        const geom = this.geometry;
        if (!geom) return new THREE.Vector3(0, 1, 0);
        const pos = geom.getAttribute('position');
        if (!pos || pos.itemSize !== 3 || pos.count < 3) return new THREE.Vector3(0, 1, 0);

        const idx = geom.getIndex();
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const c = new THREE.Vector3();
        const ab = new THREE.Vector3();
        const ac = new THREE.Vector3();
        const accum = new THREE.Vector3();

        const toWorld = (out, i) => {
            out.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(this.matrixWorld);
            return out;
        };

        if (idx) {
            const triCount = (idx.count / 3) | 0;
            for (let t = 0; t < triCount; t++) {
                const i0 = idx.getX(3 * t + 0) >>> 0;
                const i1 = idx.getX(3 * t + 1) >>> 0;
                const i2 = idx.getX(3 * t + 2) >>> 0;
                toWorld(a, i0); toWorld(b, i1); toWorld(c, i2);
                ab.subVectors(b, a);
                ac.subVectors(c, a);
                accum.add(ac.cross(ab));
            }
        } else {
            const triCount = (pos.count / 3) | 0;
            for (let t = 0; t < triCount; t++) {
                const i0 = 3 * t + 0;
                const i1 = 3 * t + 1;
                const i2 = 3 * t + 2;
                toWorld(a, i0); toWorld(b, i1); toWorld(c, i2);
                ab.subVectors(b, a);
                ac.subVectors(c, a);
                accum.add(ac.cross(ab));
            }
        }

        if (accum.lengthSq() === 0) return new THREE.Vector3(0, 1, 0);
        return accum.normalize();
    }

    // Sum triangle areas in world space
    surfaceArea() {
        const geom = this.geometry;
        if (!geom) return 0;
        const pos = geom.getAttribute && geom.getAttribute('position');
        if (!pos || pos.itemSize !== 3) return 0;

        const idx = geom.getIndex && geom.getIndex();
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const c = new THREE.Vector3();
        const ab = new THREE.Vector3();
        const ac = new THREE.Vector3();
        let area = 0;

        const toWorld = (out, i) => out.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(this.matrixWorld);

        if (idx) {
            const triCount = (idx.count / 3) | 0;
            for (let t = 0; t < triCount; t++) {
                const i0 = idx.getX(3 * t + 0) >>> 0;
                const i1 = idx.getX(3 * t + 1) >>> 0;
                const i2 = idx.getX(3 * t + 2) >>> 0;
                toWorld(a, i0); toWorld(b, i1); toWorld(c, i2);
                ab.subVectors(b, a);
                ac.subVectors(c, a);
                area += 0.5 * ab.cross(ac).length();
            }
        } else {
            const triCount = (pos.count / 3) | 0;
            for (let t = 0; t < triCount; t++) {
                const i0 = 3 * t + 0;
                const i1 = 3 * t + 1;
                const i2 = 3 * t + 2;
                toWorld(a, i0); toWorld(b, i1); toWorld(c, i2);
                ab.subVectors(b, a);
                ac.subVectors(c, a);
                area += 0.5 * ab.cross(ac).length();
            }
        }
        return area;
    }

    async points() {
        // return an array of point objects {x,y,z} in world space
        const tmp = new THREE.Vector3();
        const arr = [];
        const pos = this.geometry && this.geometry.getAttribute && this.geometry.getAttribute('position');
        if (pos && pos.itemSize === 3 && pos.count >= 2) {
            for (let i = 0; i < pos.count; i++) {
                tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i));
                if (applyWorld) tmp.applyMatrix4(this.matrixWorld);
                arr.push({ x: tmp.x, y: tmp.y, z: tmp.z });
            }
        }
        return arr;
    }

    setMetadata(metadata) {
        // call the approriate method in the parent solid
        if (this.parentSolid && typeof this.parentSolid.setFaceMetadata === 'function') {
            this.parentSolid.setFaceMetadata(this.name, metadata);
        }
        return this;
    }

    getMetadata() {
        // call the approriate method in the parent solid
        if (this.parentSolid && typeof this.parentSolid.getFaceMetadata === 'function') {
            return this.parentSolid.getFaceMetadata(this.name);
        }
        return null;
    }

    renameFace(newName) {
        this.parentSolid.renameFace(this.name, newName);
    }

    /**
     * Return neighboring face objects that share an edge with this face.
     * Prefers the face's edges (populated after visualize); if unavailable, falls back to
     * boundary polylines on the parent solid and resolves to face objects.
     * @returns {Face[]} array of neighbor face objects (deduped, excluding this face)
     */
    getNeighbors() {
        const self = this;
        const name = self?.name || self?.userData?.faceName || null;
        if (!name) return [];
        const solid = self.parentSolid || self.userData?.parentSolid || null;
        const neighbors = new Set();

        const addFace = (f) => {
            if (!f) return;
            if (f === self) return;
            neighbors.add(f);
        };

        // Primary: use edges already attached to this face
        if (Array.isArray(self.edges)) {
            for (const e of self.edges) {
                if (!e || !Array.isArray(e.faces)) continue;
                for (const f of e.faces) addFace(f);
            }
        }

        // Fallback: use boundary polylines from the parent solid to resolve neighbor faces
        if (neighbors.size === 0 && solid && typeof solid.getBoundaryEdgePolylines === 'function') {
            const faceMap = new Map();
            if (Array.isArray(solid.children)) {
                for (const ch of solid.children) {
                    if (ch && ch.type === 'FACE') {
                        const n = ch.name || ch.userData?.faceName || null;
                        if (n) faceMap.set(n, ch);
                    }
                }
            }
            try {
                const boundaries = solid.getBoundaryEdgePolylines() || [];
                for (const poly of boundaries) {
                    const a = poly?.faceA;
                    const b = poly?.faceB;
                    if (a === name && b) addFace(faceMap.get(b));
                    else if (b === name && a) addFace(faceMap.get(a));
                }
            } catch { /* ignore */ }
        }

        return Array.from(neighbors);
    }
}
