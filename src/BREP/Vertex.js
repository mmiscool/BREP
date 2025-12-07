import * as THREE from "three";
import { CADmaterials } from "../UI/CADmaterials.js";

// Vertex: container at a specific position with a point marker.
// When selected, swaps to the selected PointsMaterial; no extra sphere.
export class Vertex extends THREE.Object3D {
    /**
     * @param {[number,number,number]} [position=[0,0,0]] Initial position
     * @param {object} [opts]
     * @param {string} [opts.name] Optional display name for the vertex
     */
    constructor(position = [0, 0, 0], opts = {}) {
        super();
        this.type = 'VERTEX';
        this.name = opts.name || `VERTEX(${position[0]},${position[1]},${position[2]})`;
        this.position.set(position[0] || 0, position[1] || 0, position[2] || 0);

        // Base point visual (screen-space sized)
        const ptGeom = new THREE.BufferGeometry();
        ptGeom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
        const ptMat = (CADmaterials?.VERTEX?.BASE) || new THREE.PointsMaterial({ color: '#ffb703', size: 6, sizeAttenuation: false });
        this._point = new THREE.Points(ptGeom, ptMat);
        this.add(this._point);

        // Selection flag accessor toggles point material
        this._selected = false;
        Object.defineProperty(this, 'selected', {
            get: () => this._selected,
            set: (v) => {
                const nv = !!v;
                this._selected = nv;
                try {
                    if (this._point && this._point.material && CADmaterials?.VERTEX) {
                        this._point.material = nv ? (CADmaterials.VERTEX.SELECTED || this._point.material)
                            : (CADmaterials.VERTEX.BASE || this._point.material);
                    }
                } catch { }
            },
            configurable: true,
            enumerable: true,
        });
    }
}
