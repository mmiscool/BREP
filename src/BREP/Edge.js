import * as THREE from "three";
import { CADmaterials } from "../UI/CADmaterials.js";
import { Line2 } from "three/examples/jsm/Addons.js";

export class Edge extends Line2 {
    constructor(geometry) {
        super(geometry, CADmaterials.EDGE.BASE);
        this.faces = [];
        this.name = null;
        this.type = 'EDGE';
        this.closedLoop = false;
    }

    // Total polyline length in world space
    length() {
        const tmpA = new THREE.Vector3();
        const tmpB = new THREE.Vector3();
        let total = 0;

        // Prefer positions from visualize() payload
        const pts = this.userData && Array.isArray(this.userData.polylineLocal)
            ? this.userData.polylineLocal
            : null;

        const addSeg = (ax, ay, az, bx, by, bz) => {
            tmpA.set(ax, ay, az).applyMatrix4(this.matrixWorld);
            tmpB.set(bx, by, bz).applyMatrix4(this.matrixWorld);
            total += tmpA.distanceTo(tmpB);
        };

        if (pts && pts.length >= 2) {
            for (let i = 0; i < pts.length - 1; i++) {
                const p = pts[i];
                const q = pts[i + 1];
                addSeg(p[0], p[1], p[2], q[0], q[1], q[2]);
            }
            return total;
        }

        // Fallback: read from geometry positions if available
        const pos = this.geometry && this.geometry.getAttribute && this.geometry.getAttribute('position');
        if (pos && pos.itemSize === 3 && pos.count >= 2) {
            for (let i = 0; i < pos.count - 1; i++) {
                addSeg(
                    pos.getX(i), pos.getY(i), pos.getZ(i),
                    pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)
                );
            }
            return total;
        }

        return 0;
    }

    points(applyWorld = true) {
        // Return an array of {x,y,z} points along the polyline.
        // Prefer polylineLocal from userData (installed by visualize), else fallback to geometry positions.
        const tmp = new THREE.Vector3();
        const out = [];

        const pts = this.userData && Array.isArray(this.userData.polylineLocal)
            ? this.userData.polylineLocal
            : null;

        if (pts && pts.length) {
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i];
                tmp.set(p[0], p[1], p[2]);
                if (applyWorld) tmp.applyMatrix4(this.matrixWorld);
                out.push({ x: tmp.x, y: tmp.y, z: tmp.z });
            }
            return out;
        }

        const pos = this.geometry && this.geometry.getAttribute && this.geometry.getAttribute('position');
        if (pos && pos.itemSize === 3 && pos.count >= 1) {
            for (let i = 0; i < pos.count; i++) {
                tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i));
                if (applyWorld) tmp.applyMatrix4(this.matrixWorld);
                out.push({ x: tmp.x, y: tmp.y, z: tmp.z });
            }
        }
        return out;
    }


    setMetadata(metadata) {
        // call the approriate method in the parent solid
        if (this.parentSolid && typeof this.parentSolid.setEdgeMetadata === 'function') {
            this.parentSolid.setEdgeMetadata(this.name, metadata);
        }
        return this;
    }

    getMetadata() {
        // call the approriate method in the parent solid
        if (this.parentSolid && typeof this.parentSolid.getEdgeMetadata === 'function') {
            return this.parentSolid.getEdgeMetadata(this.name);
        }
        return null;
    }
}
