
/**
 * Solid: Authoring wrapper around manifold-3d Mesh/Manifold
 *
 * Requirements
 * - Environment: ES modules. For disk export (`writeSTL`) a Node.js runtime is required.
 * - Dependency: `setupManifold.js` must provide a ready-to-use `manifold` module
 *   exposing `{ Manifold, Mesh }` from `manifold-3d`.
 * - Geometry: Input triangles must describe a closed, watertight, 2‑manifold.
 *   The class includes helpers to fix triangle adjacency winding and will flip
 *   the entire mesh if overall orientation is inward, but it cannot repair
 *   topological holes or self-intersections.
 * - Vertex uniqueness: Vertices are uniqued by exact coordinate match
 *   (string key of `x,y,z`). If you author with floating tolerances, you must
 *   supply identical numeric values for shared vertices or change `_key()` to
 *   implement a tolerance strategy.
 *
 * Theory of Operation
 * - Authoring model:
 *   - Add triangles via `addTriangle(faceName, v1, v2, v3)`.
 *   - Each triangle stores three vertex indices in `_triVerts` and a per‑triangle
 *     face label ID in `_triIDs`. Face labels are mapped to globally unique
 *     IDs from `Manifold.reserveIDs()` so provenance persists through CSG.
 *   - Vertices are stored in `_vertProperties` in MeshGL layout `[x,y,z,...]`.
 *
 * - Manifold build (`_manifoldize`):
 *   - Before building, `fixTriangleWindingsByAdjacency()` enforces opposite
 *     orientation across shared edges; then a signed‑volume check flips all
 *     triangles if the mesh is inward‑facing.
 *   - A `Mesh` is constructed with `{ numProp, vertProperties, triVerts, faceID }`,
 *     where `faceID` is the per‑triangle label array. `mesh.merge()` is called
 *     to fill merge vectors when needed, then `new Manifold(mesh)` is created
 *     and cached until the authoring arrays change.
 *
 * - Provenance & queries:
 *   - After any boolean operation, Manifold propagates `faceID` so each output
 *     triangle keeps the original face label. `getFace(name)` and `getFaces()`
 *     read `mesh.faceID` to enumerate triangles by label (no planar grouping or
 *     merging), which supports faces comprised of many non‑coplanar triangles
 *     (e.g., cylinder side walls).
 *
 * - Boolean CSG:
 *   - `union`, `subtract`, `intersect` call Manifold’s CSG APIs on the cached
 *     Manifold objects and then rebuild a new Solid from the result. Face ID →
 *     name maps from both inputs are merged so all original labels remain
 *     available in the output.
 *
 * - Export:
 *   - `toSTL()` returns an ASCII STL string from the current Manifold mesh.
 *   - `writeSTL(path)` writes the STL to disk using a dynamic `fs` import so
 *     the module stays browser‑safe.
 *
 * Performance Notes
 * - Manifoldization is cached and only recomputed when authoring arrays change
 *   (`_dirty`). Face queries iterate triangles and filter by `faceID`, which is
 *   linear in triangle count.
 */
import manifold from "./setupManifold.js";

import * as THREE from "three";
import { CADmaterials } from '../UI/CADmaterials.js';
import { Line2, LineGeometry } from "three/examples/jsm/Addons.js";
const { Manifold, Mesh: ManifoldMesh } = manifold;

const debugMode = false;

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
}

// Vertex: container at a specific position with a point marker.
// When selected, swaps to the selected PointsMaterial; no extra sphere.
export class Vertex extends THREE.Object3D {
    constructor(position = [0, 0, 0], opts = {}) {
        super();
        this.type = 'VERTEX';
        this.name = `VERTEX(${position[0]},${position[1]},${position[2]})`;
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
                } catch {}
            },
            configurable: true,
            enumerable: true,
        });
    }
}

export class Face extends THREE.Mesh {
    constructor(geometry) {
        super(geometry, CADmaterials.FACE.BASE);
        this.edges = [];
        this.name = null;
        this.type = 'FACE';
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

}

/**
 * Solid
 * - Add triangles with a face name.
 * - Data is stored in Manifold's MeshGL layout (vertProperties, triVerts, faceID).
 * - Face names are mapped to globally-unique Manifold IDs so they propagate through boolean ops.
 * - Query triangles for a given face name after any CSG by reading runs back from MeshGL.
 */
export class Solid extends THREE.Group {
    constructor() {
        super();
        // Geometry data (MeshGL layout, but we build incrementally in JS arrays)
        this._numProp = 3;                // x,y,z
        this._vertProperties = [];        // flat [x0,y0,z0, x1,y1,z1, ...]
        this._triVerts = [];              // flat [i0,i1,i2, i3,i4,i5, ...]
        this._triIDs = [];                // per-triangle Manifold ID (mapped from faceName)

        // Vertex uniquing
        this._vertKeyToIndex = new Map(); // "x,y,z" -> index

        // Face name <-> Manifold ID
        this._faceNameToID = new Map();
        this._idToFaceName = new Map();

        // Laziness & caching
        this._dirty = true;               // arrays changed and manifold needs rebuild
        this._manifold = null;            // cached Manifold object built from arrays
        this._faceIndex = null;           // lazy cache: id -> [triIndices]
        this._epsilon = 0;                // optional vertex weld tolerance (off by default)
        this._freeTimer = null;           // handle for scheduled wasm cleanup

        this.type = 'SOLID';
        this.renderOrder = 1;
    }

    /**
     * Apply a Matrix4 to all authored vertices (bake transform into geometry arrays).
     * Does not modify the Object3D transform; marks manifold dirty for rebuild.
     * @param {THREE.Matrix4} matrix
     * @returns {Solid} this
     */
    bakeTransform(matrix) {
        try {
            if (!matrix || typeof matrix.elements === 'undefined') return this;
            if (!Array.isArray(this._vertProperties) || this._vertProperties.length === 0) return this;
            const m = (matrix && matrix.isMatrix4) ? matrix : new THREE.Matrix4().fromArray(matrix.elements || matrix);
            const e = m.elements;
            const vp = this._vertProperties;
            // Inline mat4 multiply for speed
            for (let i = 0; i < vp.length; i += 3) {
                const x = vp[i + 0], y = vp[i + 1], z = vp[i + 2];
                const nx = e[0] * x + e[4] * y + e[8]  * z + e[12];
                const ny = e[1] * x + e[5] * y + e[9]  * z + e[13];
                const nz = e[2] * x + e[6] * y + e[10] * z + e[14];
                vp[i + 0] = nx; vp[i + 1] = ny; vp[i + 2] = nz;
            }
            // Rebuild exact-key map and mark dirty
            this._vertKeyToIndex = new Map();
            for (let i = 0; i < vp.length; i += 3) {
                const X = vp[i], Y = vp[i + 1], Z = vp[i + 2];
                this._vertKeyToIndex.set(`${X},${Y},${Z}`, (i / 3) | 0);
            }
            this._dirty = true;
            this._faceIndex = null;
        } catch (_) { /* ignore */ }
        return this;
    }

    /**
     * Convenience: compose TRS and bake transform.
     * @param {{ position?:number[], rotationEuler?:number[], scale?:number[] }} trs
     * @returns {Solid} this
     */
    bakeTRS(trs) {
        try {
            const p = Array.isArray(trs?.position) ? trs.position : [0, 0, 0];
            const r = Array.isArray(trs?.rotationEuler) ? trs.rotationEuler : [0, 0, 0];
            const s = Array.isArray(trs?.scale) ? trs.scale : [1, 1, 1];
            const pos = new THREE.Vector3(p[0] || 0, p[1] || 0, p[2] || 0);
            const eul = new THREE.Euler(r[0] || 0, r[1] || 0, r[2] || 0, 'XYZ');
            const quat = new THREE.Quaternion().setFromEuler(eul);
            const scl = new THREE.Vector3(s[0] || 1, s[1] || 1, s[2] || 1);
            const m = new THREE.Matrix4().compose(pos, quat, scl);
            return this.bakeTransform(m);
        } catch (_) { return this; }
    }

    // --- Basic building blocks -------------------------------------------------

    _key([x, y, z]) {
        // Exact match; change to tolerance if you need fuzzy merging
        return `${x},${y},${z}`;
    }

    _getPointIndex(p) {
        const k = this._key(p);
        const found = this._vertKeyToIndex.get(k);
        if (found !== undefined) return found;
        const idx = this._vertProperties.length / 3;
        this._vertProperties.push(p[0], p[1], p[2]);
        this._vertKeyToIndex.set(k, idx);
        return idx;
    }

    _getOrCreateID(faceName) {
        if (!this._faceNameToID.has(faceName)) {
            const id = Manifold.reserveIDs(1); // globally unique, propagates through CSG
            this._faceNameToID.set(faceName, id);
            this._idToFaceName.set(id, faceName);
        }
        return this._faceNameToID.get(faceName);
    }

    // --- Authoring API ---------------------------------------------------------

    /**
     * Add a single triangle (CCW winding recommended).
     * @param {string} faceName
     * @param {[number,number,number]} v1
     * @param {[number,number,number]} v2
     * @param {[number,number,number]} v3
     */
    addTriangle(faceName, v1, v2, v3) {
        const id = this._getOrCreateID(faceName);
        const i1 = this._getPointIndex(v1);
        const i2 = this._getPointIndex(v2);
        const i3 = this._getPointIndex(v3);
        this._triVerts.push(i1, i2, i3);
        this._triIDs.push(id);
        this._dirty = true;
        this._faceIndex = null;
        return this;
    }

    /**
     * Remesh by splitting long edges to improve triangle regularity while
     * preserving face labels. Performs global edge splits per pass so shared
     * edges are split consistently on both sides, maintaining a watertight
     * 2‑manifold.
     *
     * Strategy
     * - Identify all undirected edges with length > maxEdgeLength.
     * - Create a single midpoint vertex for each such edge.
     * - For each triangle, re-triangulate using the available midpoints:
     *   - 0 long edges: keep as-is.
     *   - 1 long edge: split into 2 triangles.
     *   - 2 long edges (adjacent): split into 3 triangles.
     *   - 3 long edges: split into 4 triangles.
     * - Repeat until no long edges remain or until maxIterations is reached.
     *
     * Notes
     * - Face IDs are copied to the new triangles from their source triangle.
     * - Orientation is preserved relative to the original triangle ordering.
     * - After completion, arrays are marked dirty and triangle windings are
     *   verified by fixTriangleWindingsByAdjacency().
     *
     * @param {object} options
     * @param {number} options.maxEdgeLength Maximum allowed edge length.
     * @param {number} [options.maxIterations=10] Safety cap on refinement passes.
     * @returns {Solid} this
     */
    remesh({ maxEdgeLength, maxIterations = 10 } = {}) {
        const Lmax = Number(maxEdgeLength);
        if (!Number.isFinite(Lmax) || Lmax <= 0) return this;
        const L2 = Lmax * Lmax;

        // Local helpers on each pass
        const pass = () => {
            const vp = this._vertProperties;
            const tv = this._triVerts;
            const ids = this._triIDs;
            const triCount = (tv.length / 3) | 0;
            const nv = (vp.length / 3) | 0;
            const NV = BigInt(Math.max(1, nv));
            const ukey = (a, b) => {
                const A = BigInt(a); const B = BigInt(b); return A < B ? A * NV + B : B * NV + A;
            };
            const len2 = (i, j) => {
                const ax = vp[i * 3 + 0], ay = vp[i * 3 + 1], az = vp[i * 3 + 2];
                const bx = vp[j * 3 + 0], by = vp[j * 3 + 1], bz = vp[j * 3 + 2];
                const dx = ax - bx, dy = ay - by, dz = az - bz; return dx * dx + dy * dy + dz * dz;
            };

            // 1) Identify long edges globally
            const longEdge = new Set(); // key -> true
            for (let t = 0; t < triCount; t++) {
                const b = t * 3;
                const i0 = tv[b + 0] >>> 0;
                const i1 = tv[b + 1] >>> 0;
                const i2 = tv[b + 2] >>> 0;
                if (len2(i0, i1) > L2) longEdge.add(ukey(i0, i1));
                if (len2(i1, i2) > L2) longEdge.add(ukey(i1, i2));
                if (len2(i2, i0) > L2) longEdge.add(ukey(i2, i0));
            }

            if (longEdge.size === 0) return false; // nothing to do

            // 2) Build new vertex array and midpoint lookup for long edges
            const newVP = vp.slice();
            const edgeMid = new Map(); // key -> new vert index
            const midpointIndex = (a, b) => {
                const key = ukey(a, b);
                let idx = edgeMid.get(key);
                if (idx !== undefined) return idx;
                const ax = vp[a * 3 + 0], ay = vp[a * 3 + 1], az = vp[a * 3 + 2];
                const bx = vp[b * 3 + 0], by = vp[b * 3 + 1], bz = vp[b * 3 + 2];
                const mx = 0.5 * (ax + bx), my = 0.5 * (ay + by), mz = 0.5 * (az + bz);
                idx = (newVP.length / 3) | 0;
                newVP.push(mx, my, mz);
                edgeMid.set(key, idx);
                return idx;
            };

            // 3) Re-triangulate with consistent splits
            const newTV = [];
            const newIDs = [];
            const emit = (i, j, k, faceId) => { newTV.push(i, j, k); newIDs.push(faceId); };

            for (let t = 0; t < triCount; t++) {
                const base = t * 3;
                const i0 = tv[base + 0] >>> 0;
                const i1 = tv[base + 1] >>> 0;
                const i2 = tv[base + 2] >>> 0;
                const fid = ids[t];

                const k01 = ukey(i0, i1), k12 = ukey(i1, i2), k20 = ukey(i2, i0);
                const s01 = longEdge.has(k01);
                const s12 = longEdge.has(k12);
                const s20 = longEdge.has(k20);

                const c = (cond) => cond ? 1 : 0;
                const count = c(s01) + c(s12) + c(s20);

                if (count === 0) {
                    emit(i0, i1, i2, fid);
                    continue;
                }

                if (count === 1) {
                    if (s01) {
                        const m01 = midpointIndex(i0, i1);
                        emit(i0, m01, i2, fid);
                        emit(m01, i1, i2, fid);
                    } else if (s12) {
                        const m12 = midpointIndex(i1, i2);
                        emit(i1, m12, i0, fid);
                        emit(m12, i2, i0, fid);
                    } else /* s20 */ {
                        const m20 = midpointIndex(i2, i0);
                        emit(i2, m20, i1, fid);
                        emit(m20, i0, i1, fid);
                    }
                    continue;
                }

                if (count === 2) {
                    // Two adjacent splits; create 3 triangles.
                    if (s01 && s12) {
                        const m01 = midpointIndex(i0, i1);
                        const m12 = midpointIndex(i1, i2);
                        emit(i0, m01, i2, fid);
                        emit(i1, m12, m01, fid);
                        emit(m01, m12, i2, fid);
                    } else if (s12 && s20) {
                        const m12 = midpointIndex(i1, i2);
                        const m20 = midpointIndex(i2, i0);
                        emit(i1, m12, i0, fid);
                        emit(i2, m20, m12, fid);
                        emit(m12, m20, i0, fid);
                    } else /* s20 && s01 */ {
                        const m20 = midpointIndex(i2, i0);
                        const m01 = midpointIndex(i0, i1);
                        emit(i2, m20, i1, fid);
                        emit(i0, m01, m20, fid);
                        emit(m20, m01, i1, fid);
                    }
                    continue;
                }

                // count === 3: split all edges; 4 triangles
                const m01 = midpointIndex(i0, i1);
                const m12 = midpointIndex(i1, i2);
                const m20 = midpointIndex(i2, i0);
                emit(i0, m01, m20, fid);
                emit(i1, m12, m01, fid);
                emit(i2, m20, m12, fid);
                emit(m01, m12, m20, fid);
            }

            // 4) Commit new arrays
            this._vertProperties = newVP;
            this._triVerts = newTV;
            this._triIDs = newIDs;
            // Rebuild vertex key map for exact-key lookups
            this._vertKeyToIndex = new Map();
            for (let i = 0; i < this._vertProperties.length; i += 3) {
                const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
                this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
            }
            this._dirty = true;
            this._faceIndex = null;
            return true;
        };

        let changed = false;
        for (let it = 0; it < maxIterations; it++) {
            const did = pass();
            if (!did) break;
            changed = true;
        }

        if (changed) {
            // Ensure triangles are coherently oriented after edits
            this.fixTriangleWindingsByAdjacency();
        }
        return this;
    }

    /**
     * Remove small disconnected triangle islands relative to the largest shell.
     *
     * - Components are connected by shared edges (undirected) in triangle graph.
     * - The largest component is considered the main shell.
     * - Internal: components whose representative point is inside the main shell.
     * - External: components whose representative point is outside the main shell.
     * - Components with triangle count <= maxTriangles can be removed according to flags.
     *
     * @param {{maxTriangles?:number, removeInternal?:boolean, removeExternal?:boolean}} options
     * @returns {number} Number of triangles removed.
     */
    removeSmallIslands({ maxTriangles = 30, removeInternal = true, removeExternal = true } = {}) {
        const tv = this._triVerts;
        const vp = this._vertProperties;
        const triCount = (tv.length / 3) | 0;
        if (triCount === 0) return 0;

        // Build undirected edge -> triangle uses to define adjacency
        const nv = (vp.length / 3) | 0;
        const NV = BigInt(Math.max(1, nv));
        const eKey = (a, b) => {
            const A = BigInt(a), B = BigInt(b);
            return (A < B) ? (A * NV + B) : (B * NV + A);
        };

        const edgeToTris = new Map(); // key -> [tri indices]
        for (let t = 0; t < triCount; t++) {
            const b = t * 3;
            const i0 = tv[b + 0] >>> 0;
            const i1 = tv[b + 1] >>> 0;
            const i2 = tv[b + 2] >>> 0;
            const edges = [ [i0, i1], [i1, i2], [i2, i0] ];
            for (let k = 0; k < 3; k++) {
                const a = edges[k][0], c = edges[k][1];
                const key = eKey(a, c);
                let arr = edgeToTris.get(key);
                if (!arr) { arr = []; edgeToTris.set(key, arr); }
                arr.push(t);
            }
        }

        // Build triangle adjacency via shared edges used by exactly two triangles
        const adj = new Array(triCount);
        for (let t = 0; t < triCount; t++) adj[t] = [];
        for (const [, arr] of edgeToTris.entries()) {
            if (arr.length === 2) {
                const a = arr[0], b = arr[1];
                adj[a].push(b);
                adj[b].push(a);
            }
        }

        // Connected components over triangle graph (edge-adjacent)
        const compId = new Int32Array(triCount);
        for (let i = 0; i < triCount; i++) compId[i] = -1;
        const comps = [];
        let compIdx = 0;
        const stack = [];
        for (let seed = 0; seed < triCount; seed++) {
            if (compId[seed] !== -1) continue;
            compId[seed] = compIdx;
            stack.length = 0;
            stack.push(seed);
            const tris = [];
            while (stack.length) {
                const t = stack.pop();
                tris.push(t);
                const nbrs = adj[t];
                for (let j = 0; j < nbrs.length; j++) {
                    const u = nbrs[j];
                    if (compId[u] !== -1) continue;
                    compId[u] = compIdx;
                    stack.push(u);
                }
            }
            comps.push(tris);
            compIdx++;
        }

        if (comps.length <= 1) return 0; // single shell, nothing to remove

        // Find the largest component (by triangle count) as main
        let mainIdx = 0;
        for (let i = 1; i < comps.length; i++) {
            if (comps[i].length > comps[mainIdx].length) mainIdx = i;
        }
        const mainTris = comps[mainIdx];

        // Pre-extract main triangles as points for ray casting
        const mainFaces = new Array(mainTris.length);
        for (let k = 0; k < mainTris.length; k++) {
            const t = mainTris[k];
            const b = t * 3;
            const i0 = tv[b + 0] * 3, i1 = tv[b + 1] * 3, i2 = tv[b + 2] * 3;
            mainFaces[k] = [
                [vp[i0 + 0], vp[i0 + 1], vp[i0 + 2]],
                [vp[i1 + 0], vp[i1 + 1], vp[i1 + 2]],
                [vp[i2 + 0], vp[i2 + 1], vp[i2 + 2]],
            ];
        }

        // Simple Moller–Trumbore ray/triangle intersection. Returns t or null.
        const rayTri = (orig, dir, tri) => {
            const EPS = 1e-12;
            const ax = tri[0][0], ay = tri[0][1], az = tri[0][2];
            const bx = tri[1][0], by = tri[1][1], bz = tri[1][2];
            const cx = tri[2][0], cy = tri[2][1], cz = tri[2][2];
            const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
            const px = dir[1] * e2z - dir[2] * e2y;
            const py = dir[2] * e2x - dir[0] * e2z;
            const pz = dir[0] * e2y - dir[1] * e2x;
            const det = e1x * px + e1y * py + e1z * pz;
            if (Math.abs(det) < EPS) return null; // parallel or nearly so
            const invDet = 1.0 / det;
            const tvecx = orig[0] - ax, tvecy = orig[1] - ay, tvecz = orig[2] - az;
            const u = (tvecx * px + tvecy * py + tvecz * pz) * invDet;
            if (u < 0 || u > 1) return null;
            const qx = tvecy * e1z - tvecz * e1y;
            const qy = tvecz * e1x - tvecx * e1z;
            const qz = tvecx * e1y - tvecy * e1x;
            const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invDet;
            if (v < 0 || u + v > 1) return null;
            const tHit = (e2x * qx + e2y * qy + e2z * qz) * invDet;
            return tHit > EPS ? tHit : null;
        };

        // Compute a simple point-in-main test by ray parity (cast +X)
        const pointInsideMain = (p) => {
            const dir = [1, 0, 0];
            let hits = 0;
            for (let i = 0; i < mainFaces.length; i++) {
                const th = rayTri(p, dir, mainFaces[i]);
                if (th !== null) hits++;
            }
            return (hits % 2) === 1;
        };

        // Helper to compute centroid of a triangle
        const triCentroid = (t) => {
            const b = t * 3;
            const i0 = tv[b + 0] * 3, i1 = tv[b + 1] * 3, i2 = tv[b + 2] * 3;
            const x = (vp[i0 + 0] + vp[i1 + 0] + vp[i2 + 0]) / 3;
            const y = (vp[i0 + 1] + vp[i1 + 1] + vp[i2 + 1]) / 3;
            const z = (vp[i0 + 2] + vp[i1 + 2] + vp[i2 + 2]) / 3;
            return [x + 1e-8, y + 1e-8, z + 1e-8]; // small bias to avoid exact coplanarity
        };

        // Mark components to remove based on inside/outside and size threshold
        const removeComp = new Array(comps.length).fill(false);
        for (let i = 0; i < comps.length; i++) {
            if (i === mainIdx) continue;
            const tris = comps[i];
            if (tris.length === 0 || tris.length > maxTriangles) continue;
            const probe = triCentroid(tris[0]);
            const inside = pointInsideMain(probe);
            if ((inside && removeInternal) || (!inside && removeExternal)) {
                removeComp[i] = true;
            }
        }

        // Build keep mask for triangles
        const keepTri = new Uint8Array(triCount);
        for (let t = 0; t < triCount; t++) keepTri[t] = 1;
        let removed = 0;
        for (let i = 0; i < comps.length; i++) {
            if (!removeComp[i]) continue;
            const tris = comps[i];
            for (let k = 0; k < tris.length; k++) {
                const t = tris[k];
                if (keepTri[t]) { keepTri[t] = 0; removed++; }
            }
        }
        if (removed === 0) return 0;

        // Compact triangles and vertices, remapping indices
        const usedVert = new Uint8Array(nv);
        const newTriVerts = [];
        const newTriIDs = [];
        for (let t = 0; t < triCount; t++) {
            if (!keepTri[t]) continue;
            const b = t * 3;
            const a = tv[b + 0] >>> 0;
            const b1 = tv[b + 1] >>> 0;
            const c = tv[b + 2] >>> 0;
            newTriVerts.push(a, b1, c);
            newTriIDs.push(this._triIDs[t]);
            usedVert[a] = 1; usedVert[b1] = 1; usedVert[c] = 1;
        }

        const oldToNew = new Int32Array(nv);
        for (let i = 0; i < nv; i++) oldToNew[i] = -1;
        const newVerts = [];
        let write = 0;
        for (let i = 0; i < nv; i++) {
            if (!usedVert[i]) continue;
            oldToNew[i] = write++;
            newVerts.push(vp[i * 3 + 0], vp[i * 3 + 1], vp[i * 3 + 2]);
        }
        for (let k = 0; k < newTriVerts.length; k++) newTriVerts[k] = oldToNew[newTriVerts[k]];

        // Commit
        this._vertProperties = newVerts;
        this._triVerts = newTriVerts;
        this._triIDs = newTriIDs;
        // Rebuild vertex key map for exact-key lookups
        this._vertKeyToIndex = new Map();
        for (let i = 0; i < this._vertProperties.length; i += 3) {
            const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
            this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }
        this._dirty = true;
        this._faceIndex = null;

        // Ensure triangle windings are still coherent after edits
        this.fixTriangleWindingsByAdjacency();
        return removed;
    }

    /**
     * Backwards-compatible wrapper that removes only internal small islands.
     * @param {number} maxTriangles
     * @returns {number}
     */
    removeSmallInternalIslands(maxTriangles = 30) {
        return this.removeSmallIslands({ maxTriangles, removeInternal: true, removeExternal: false });
    }

    /**
     * Return a mirrored copy of this solid across a plane defined by a point and a normal.
     * The copy preserves face IDs and name maps. Visualization can be rebuilt via visualize().
     * @param {THREE.Vector3|[number,number,number]} point World-space point on the mirror plane.
     * @param {THREE.Vector3|[number,number,number]} normal World-space plane normal (need not be normalized).
     * @returns {Solid}
     */
    mirrorAcrossPlane(point, normal) {
        const P0 = (point instanceof THREE.Vector3)
            ? point.clone()
            : new THREE.Vector3(point[0], point[1], point[2]);
        const n = (normal instanceof THREE.Vector3)
            ? normal.clone().normalize()
            : new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();

        const mesh = this.getMesh();
        try {
            const vp = mesh.vertProperties; // Float32Array
            const tv = mesh.triVerts;       // Uint32Array
            const faceIDs = mesh.faceID && mesh.faceID.length ? Array.from(mesh.faceID) : [];

        const mirrored = new Solid();
        mirrored._numProp = mesh.numProp || 3;

        // Reflect vertices across plane
        const outVP = new Array(vp.length);
        const X = new THREE.Vector3();
        for (let i = 0; i < vp.length; i += 3) {
            X.set(vp[i + 0], vp[i + 1], vp[i + 2]);
            const d = X.clone().sub(P0);
            const t = 2 * d.dot(n);
            const Xp = X.sub(n.clone().multiplyScalar(t));
            outVP[i + 0] = Xp.x;
            outVP[i + 1] = Xp.y;
            outVP[i + 2] = Xp.z;
        }
        mirrored._vertProperties = outVP;

        // Copy triangles and face IDs
        mirrored._triVerts = Array.from(tv);
        mirrored._triIDs = faceIDs.length ? faceIDs : new Array((tv.length / 3) | 0).fill(0);

        // Restore face name maps
        try {
            mirrored._idToFaceName = new Map(this._idToFaceName);
            mirrored._faceNameToID = new Map(this._faceNameToID);
        } catch (_) {}

        // Rebuild vertex key map for exact-key lookup consistency
        mirrored._vertKeyToIndex = new Map();
        for (let i = 0; i < mirrored._vertProperties.length; i += 3) {
            const x = mirrored._vertProperties[i], y = mirrored._vertProperties[i + 1], z = mirrored._vertProperties[i + 2];
            mirrored._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }

        mirrored._dirty = true;  // manifold must rebuild on demand
        mirrored._faceIndex = null;
        mirrored._manifold = null;
        return mirrored;
        } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
    }


    /**
     * Remove tiny triangles that lie along boundaries between faces by performing
     * local 2–2 edge flips across inter-face edges. This keeps the mesh watertight
     * and 2‑manifold while eliminating slivers along face seams.
     *
     * How it works
     * - For each undirected edge shared by exactly two triangles with different faceIDs
     *   (i.e. a boundary between labeled faces), if at least one of the two triangles
     *   has area below `areaThreshold`, attempt an edge flip that replaces the pair
     *   (u,v,wA) and (v,u,wB) with (wA,wB,u) and (wB,wA,v).
     * - The flip is accepted only if it preserves manifoldness (the diagonal wA–wB is not
     *   already used elsewhere) and both new triangles are non-degenerate and not smaller
     *   than the current min area of the pair. Face IDs are preserved by assigning one
     *   new triangle to each original faceID.
     *
     * Note: This operation may move the face-label boundary locally from edge (u,v) to
     * the diagonal (wA,wB). Face labels remain consistent, but the precise boundary path
     * can change in order to remove the sliver while keeping the mesh manifold.
     *
     * @param {number} areaThreshold - Minimum triangle area to consider a triangle tiny.
     * @param {number} [maxIterations=1] - How many passes to perform; multiple passes can
     *   progressively clean up chains of slivers.
     * @returns {number} The number of successful flips performed.
     */
    removeTinyBoundaryTriangles(areaThreshold, maxIterations = 1) {
        const thr = Number(areaThreshold);
        if (!Number.isFinite(thr) || thr <= 0) return 0;
        const vp = this._vertProperties;
        if (!vp || vp.length < 9 || this._triVerts.length < 3) return 0;

        // Helper: area of triangle given indices
        const triArea = (i0, i1, i2) => {
            const x0 = vp[i0 * 3 + 0], y0 = vp[i0 * 3 + 1], z0 = vp[i0 * 3 + 2];
            const x1 = vp[i1 * 3 + 0], y1 = vp[i1 * 3 + 1], z1 = vp[i1 * 3 + 2];
            const x2 = vp[i2 * 3 + 0], y2 = vp[i2 * 3 + 1], z2 = vp[i2 * 3 + 2];
            const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
            const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
            const cx = uy * vz - uz * vy;
            const cy = uz * vx - ux * vz;
            const cz = ux * vy - uy * vx;
            return 0.5 * Math.hypot(cx, cy, cz);
        };

        let totalFlips = 0;
        const iterMax = Math.max(1, (maxIterations | 0));

        for (let iter = 0; iter < iterMax; iter++) {
            const tv = this._triVerts;
            const ids = this._triIDs;
            const triCount = (tv.length / 3) | 0;
            if (triCount < 2) break;

            // Precompute triangles and areas
            const tris = new Array(triCount);
            const areas = new Float64Array(triCount);
            for (let t = 0; t < triCount; t++) {
                const b = t * 3;
                const i0 = tv[b + 0] >>> 0;
                const i1 = tv[b + 1] >>> 0;
                const i2 = tv[b + 2] >>> 0;
                tris[t] = [i0, i1, i2];
                areas[t] = triArea(i0, i1, i2);
            }

            // Build undirected edge -> [uses] map, each use with tri index and face id and oriented endpoints
            const nv = (vp.length / 3) | 0;
            const NV = BigInt(nv);
            const eKey = (a, b) => {
                const A = BigInt(a), B = BigInt(b);
                return A < B ? A * NV + B : B * NV + A;
            };
            const e2t = new Map(); // key -> [{tri, id, a, b}]
            for (let t = 0; t < triCount; t++) {
                const [i0, i1, i2] = tris[t];
                const face = ids[t];
                const edges = [ [i0, i1], [i1, i2], [i2, i0] ];
                for (let k = 0; k < 3; k++) {
                    const a = edges[k][0], b = edges[k][1];
                    const key = eKey(a, b);
                    let arr = e2t.get(key);
                    if (!arr) { arr = []; e2t.set(key, arr); }
                    arr.push({ tri: t, id: face, a, b });
                }
            }

            // Collect boundary edges between different faceIDs and rank by min-area
            const candidates = [];
            for (const [key, arr] of e2t.entries()) {
                if (arr.length !== 2) continue; // non-manifold or open boundary; skip
                const a = arr[0], b = arr[1];
                if (a.id === b.id) continue; // not between distinct face labels
                const areaA = areas[a.tri];
                const areaB = areas[b.tri];
                const minAB = Math.min(areaA, areaB);
                if (!(minAB < thr)) continue; // only care if at least one is tiny
                candidates.push({ key, a, b, minAB });
            }

            // Sort so we flip the worst slivers first
            candidates.sort((p, q) => p.minAB - q.minAB);

            const triLocked = new Uint8Array(triCount); // mark tris that are being modified
            let flipsThisIter = 0;

            // Helper to remove a specific oriented use from e2t (if present)
            const removeUse = (aa, bb, triIdx) => {
                const k = eKey(aa, bb);
                const arr = e2t.get(k);
                if (!arr) return;
                for (let i = 0; i < arr.length; i++) {
                    const u = arr[i];
                    if (u.tri === triIdx && u.a === aa && u.b === bb) { arr.splice(i, 1); break; }
                }
                if (arr.length === 0) e2t.delete(k);
            };

            // Helper to add an oriented use to e2t
            const addUse = (aa, bb, triIdx, id) => {
                const k = eKey(aa, bb);
                let arr = e2t.get(k);
                if (!arr) { arr = []; e2t.set(k, arr); }
                arr.push({ tri: triIdx, id, a: aa, b: bb });
            };

            for (const { a, b } of candidates) {
                const t0 = a.tri, t1 = b.tri;
                if (triLocked[t0] || triLocked[t1]) continue;

                // triangles share edge (u,v) but opposite orientation
                const u = a.a, v = a.b;
                if (!(b.a === v && b.b === u)) {
                    // Orientation not opposite (unexpected if mesh is coherently oriented); skip
                    continue;
                }

                const tri0 = tris[t0];
                const tri1 = tris[t1];
                // Find apex vertices c0, c1 (the vertices not on the shared edge)
                let c0 = -1, c1 = -1;
                for (let k = 0; k < 3; k++) { const idx = tri0[k]; if (idx !== u && idx !== v) { c0 = idx; break; } }
                for (let k = 0; k < 3; k++) { const idx = tri1[k]; if (idx !== u && idx !== v) { c1 = idx; break; } }
                if (c0 < 0 || c1 < 0 || c0 === c1) continue;

                // Manifold safety: the diagonal (c0,c1) must not already exist in the mesh
                const diagKey = eKey(c0, c1);
                const diagUses = e2t.get(diagKey);
                if (diagUses && diagUses.length > 0) continue; // would create >2 uses of diagonal

                // Compute new triangle areas for the flip (wA,wB,u) and (wB,wA,v)
                const newArea0 = triArea(c0, c1, u);
                const newArea1 = triArea(c1, c0, v);
                if (!Number.isFinite(newArea0) || !Number.isFinite(newArea1)) continue;
                const oldMin = Math.min(areas[t0], areas[t1]);
                const newMin = Math.min(newArea0, newArea1);
                // Accept only if new configuration improves worst area and doesn't introduce new tiny slivers
                if (!(newMin > oldMin && newMin >= thr)) continue;

                // Perform in-place replacement: t0 -> (c0,c1,u) with id of a, t1 -> (c1,c0,v) with id of b
                let b0 = t0 * 3;
                tv[b0 + 0] = c0; tv[b0 + 1] = c1; tv[b0 + 2] = u;
                ids[t0] = a.id;
                let b1 = t1 * 3;
                tv[b1 + 0] = c1; tv[b1 + 1] = c0; tv[b1 + 2] = v;
                ids[t1] = b.id;

                // Update cached arrays for subsequent checks within this iteration
                tris[t0] = [c0, c1, u];
                tris[t1] = [c1, c0, v];
                areas[t0] = newArea0;
                areas[t1] = newArea1;

                // Update e2t live so following flips see current mesh
                // Remove old oriented edges from t0 and t1
                removeUse(u, v, t0); removeUse(v, c0, t0); removeUse(c0, u, t0);
                removeUse(v, u, t1); removeUse(u, c1, t1); removeUse(c1, v, t1);
                // Add new oriented edges for t0' and t1'
                addUse(c0, c1, t0, a.id); addUse(c1, u, t0, a.id); addUse(u, c0, t0, a.id);
                addUse(c1, c0, t1, b.id); addUse(c0, v, t1, b.id); addUse(v, c1, t1, b.id);

                // Lock the two triangles so they won't be re-used in the same iteration
                triLocked[t0] = 1;
                triLocked[t1] = 1;
                flipsThisIter++;
            }

            if (flipsThisIter === 0) break;
            totalFlips += flipsThisIter;

            // Mark dirty so subsequent passes rebuild cache consistently
            this._dirty = true;
            this._faceIndex = null;
        }

        // Ensure coherent windings after topology edits
        this.fixTriangleWindingsByAdjacency();
        this._dirty = true;
        this._faceIndex = null;
        this.fixTriangleWindingsByAdjacency();
        //this._manifoldize();
        return totalFlips;
    }


    invertNormals() {
        for (let t = 0; t < this._triVerts.length; t += 3) {
            // swap indices 1 and 2 to flip triangle
            const tmp = this._triVerts[t + 1];
            this._triVerts[t + 1] = this._triVerts[t + 2];
            this._triVerts[t + 2] = tmp;
        }

        this._dirty = true;
        this._faceIndex = null;


        // do the manifoldize to make sure the normals are flipped
        this._manifoldize();

        return this;
    }



    /**
     * Ensures all triangles have consistent winding by making sure
     * shared edges are oriented oppositely between adjacent triangles.
     */
    fixTriangleWindingsByAdjacency() {
        // Fast-path: if already a coherently oriented manifold, skip work
        if (this._isCoherentlyOrientedManifold()) return;
        const triCount = (this._triVerts.length / 3) | 0;
        if (triCount === 0) return;

        // Copy triangles into a mutable structure
        const tris = new Array(triCount);
        for (let t = 0; t < triCount; t++) {
            const base = t * 3;
            tris[t] = [
                this._triVerts[base + 0],
                this._triVerts[base + 1],
                this._triVerts[base + 2],
            ];
        }

        // Build undirected edge map: key = min*NV + max (BigInt) -> [{tri, a, b}...]
        const undirected = new Map();
        const numVerts = (this._vertProperties.length / 3) | 0;
        const NV = BigInt(numVerts);
        const ukey = (a, b) => {
            const A = BigInt(a);
            const B = BigInt(b);
            return A < B ? A * NV + B : B * NV + A;
        };
        for (let ti = 0; ti < tris.length; ti++) {
            const tri = tris[ti];
            for (let e = 0; e < 3; e++) {
                const a = tri[e];
                const b = tri[(e + 1) % 3];
                const k = ukey(a, b);
                let arr = undirected.get(k);
                if (!arr) {
                    arr = [];
                    undirected.set(k, arr);
                }
                arr.push({ tri: ti, a, b }); // oriented edge as appears in the triangle
            }
        }

        // BFS over triangle graph, enforcing opposite orientation across shared edges
        const visited = new Array(triCount).fill(false);
        const stack = [];

        for (let seed = 0; seed < triCount; seed++) {
            if (visited[seed]) continue;
            visited[seed] = true;
            stack.push(seed);

            while (stack.length) {
                const t = stack.pop();
                const tri = tris[t];
                for (let e = 0; e < 3; e++) {
                    const a = tri[e];
                    const b = tri[(e + 1) % 3];
                    const k = ukey(a, b);
                    const adj = undirected.get(k);
                    if (!adj || adj.length < 2) continue; // boundary or non-manifold; skip

                    for (const entry of adj) {
                        const n = entry.tri;
                        if (n === t || visited[n]) continue;

                        // If neighbor uses the same directed edge (a->b), flip it
                        const nTri = tris[n];
                        if (entry.a === a && entry.b === b) {
                            [nTri[1], nTri[2]] = [nTri[2], nTri[1]];
                        }

                        visited[n] = true;
                        stack.push(n);
                    }
                }
            }
        }

        // Write back corrected triangles
        this._triVerts.length = 0;
        for (const tri of tris) {
            this._triVerts.push(tri[0], tri[1], tri[2]);
        }

        this._dirty = true;
        this._faceIndex = null;
        return this;
    }

    // Return true if every undirected edge is shared by exactly 2 triangles
    // and their directed usages are opposite.
    _isCoherentlyOrientedManifold() {
        const triCount = (this._triVerts.length / 3) | 0;
        if (triCount === 0) return false;
        const numVerts = (this._vertProperties.length / 3) | 0;
        const NV = BigInt(numVerts);
        const ukey = (a, b) => {
            const A = BigInt(a);
            const B = BigInt(b);
            return A < B ? A * NV + B : B * NV + A;
        };
        const edgeMap = new Map();
        for (let t = 0; t < triCount; t++) {
            const b = t * 3;
            const i0 = this._triVerts[b + 0];
            const i1 = this._triVerts[b + 1];
            const i2 = this._triVerts[b + 2];
            const e = [
                [i0, i1],
                [i1, i2],
                [i2, i0],
            ];
            for (let k = 0; k < 3; k++) {
                const a = e[k][0];
                const b2 = e[k][1];
                const key = ukey(a, b2);
                let arr = edgeMap.get(key);
                if (!arr) { arr = []; edgeMap.set(key, arr); }
                arr.push({ a, b: b2 });
            }
        }
        for (const arr of edgeMap.values()) {
            if (arr.length !== 2) return false; // boundary or non-manifold
            const e0 = arr[0], e1 = arr[1];
            if (!(e0.a === e1.b && e0.b === e1.a)) return false; // not opposite orientation
        }
        return true;
    }

    /**
     * Set vertex weld epsilon and optionally weld existing vertices and
     * remove degenerate triangles. Epsilon <= 0 disables welding.
     */
    setEpsilon(epsilon = 0) {
        this._epsilon = Number(epsilon) || 0;
        if (this._epsilon > 0) {
            this._weldVerticesByEpsilon(this._epsilon);
        }
        // After adjusting vertices, attempt to correct triangle winding.
        // fixTriangleWindingsByAdjacency() is a no-op if already coherently manifold.
        this.fixTriangleWindingsByAdjacency();
        return this;
    }

    /**
     * Create a lightweight clone of this Solid that copies geometry arrays and
     * face maps, but not children or any THREE resources. The clone is marked
     * dirty so its Manifold is rebuilt lazily on first use.
     * @returns {Solid}
     */
    clone() {
        const s = new Solid();
        s._numProp = this._numProp;
        s._vertProperties = this._vertProperties.slice();
        s._triVerts = this._triVerts.slice();
        s._triIDs = this._triIDs.slice();
        s._vertKeyToIndex = new Map();
        for (let i = 0; i < s._vertProperties.length; i += 3) {
            const x = s._vertProperties[i], y = s._vertProperties[i + 1], z = s._vertProperties[i + 2];
            s._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }
        // Copy face name maps
        try {
            s._idToFaceName = new Map(this._idToFaceName);
            s._faceNameToID = new Map(this._faceNameToID);
        } catch (_) {}
        s._dirty = true;
        s._manifold = null;
        s._faceIndex = null;
        s.type = 'SOLID';
        s.renderOrder = this.renderOrder;
        return s;
    }

    _weldVerticesByEpsilon(eps) {
        const vp = this._vertProperties;
        const nv = (vp.length / 3) | 0;
        if (nv === 0) return;

        const toCell = (x) => Math.round(x / eps);
        const cellMap = new Map(); // cellKey -> representative vert index
        const repOf = new Uint32Array(nv);
        for (let i = 0; i < nv; i++) repOf[i] = i;

        // Find representative for each vertex by grid hashing
        for (let i = 0; i < nv; i++) {
            const x = vp[i * 3 + 0];
            const y = vp[i * 3 + 1];
            const z = vp[i * 3 + 2];
            const cx = toCell(x), cy = toCell(y), cz = toCell(z);
            const key = `${cx},${cy},${cz}`;
            const rep = cellMap.get(key);
            if (rep === undefined) {
                cellMap.set(key, i);
                repOf[i] = i;
            } else {
                repOf[i] = rep;
            }
        }

        // Remap triangles to representative indices and drop degenerate/zero-area
        const newTriVerts = [];
        const newTriIDs = [];
        const used = new Uint8Array(nv); // mark used reps
        const area2Thresh = 0; // strict degenerate check; could set ~ (eps^2)
        for (let t = 0; t < this._triVerts.length; t += 3) {
            const a = repOf[this._triVerts[t + 0]];
            const b = repOf[this._triVerts[t + 1]];
            const c = repOf[this._triVerts[t + 2]];
            if (a === b || b === c || c === a) continue; // collapsed
            // Compute area^2 to filter near-degenerates
            const ax = vp[a * 3], ay = vp[a * 3 + 1], az = vp[a * 3 + 2];
            const bx = vp[b * 3], by = vp[b * 3 + 1], bz = vp[b * 3 + 2];
            const cx = vp[c * 3], cy = vp[c * 3 + 1], cz = vp[c * 3 + 2];
            const ux = bx - ax, uy = by - ay, uz = bz - az;
            const vx = cx - ax, vy = cy - ay, vz = cz - az;
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            const area2 = nx * nx + ny * ny + nz * nz;
            if (area2 <= area2Thresh) continue;
            const triIdx = (t / 3) | 0;
            newTriVerts.push(a, b, c);
            newTriIDs.push(this._triIDs[triIdx]);
            used[a] = 1; used[b] = 1; used[c] = 1;
        }

        // If nothing changed, bail
        if (newTriVerts.length === this._triVerts.length && newTriIDs.length === this._triIDs.length) return;

        // Build compacted vertex buffer and remap indices
        const oldToNew = new Int32Array(nv);
        for (let i = 0; i < nv; i++) oldToNew[i] = -1;
        const newVerts = [];
        let write = 0;
        for (let i = 0; i < nv; i++) {
            if (!used[i]) continue;
            oldToNew[i] = write++;
            newVerts.push(vp[i * 3 + 0], vp[i * 3 + 1], vp[i * 3 + 2]);
        }
        for (let k = 0; k < newTriVerts.length; k++) {
            newTriVerts[k] = oldToNew[newTriVerts[k]];
        }

        // Commit
        this._vertProperties = newVerts;
        this._triVerts = newTriVerts;
        this._triIDs = newTriIDs;
        // Rebuild vertex key map
        this._vertKeyToIndex = new Map();
        for (let i = 0; i < this._vertProperties.length; i += 3) {
            const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
            this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }
        this._dirty = true;
        this._faceIndex = null;
    }









    /**
     * Build (or rebuild) the Manifold from our MeshGL arrays.
     * Uses faceID per triangle so face names survive CSG operations.
     */
    _manifoldize() {
        // Measure timing for manifoldization (cache hits vs rebuilds)
        const nowMs = () => (typeof performance !== 'undefined' && performance?.now ? performance.now() : Date.now());
        const __t0 = nowMs();
        // Reset the auto-free timer: always schedule cleanup 60s after last use
        try { if (this._freeTimer) { clearTimeout(this._freeTimer); } } catch { }
        try {
            this._freeTimer = setTimeout(() => {
                try { this.free(); } catch { }
            }, 60 * 1000);
        } catch { }
        if (!this._dirty && this._manifold) {
            const __t1 = nowMs();
            try { if (debugMode) console.log(`[Solid] _manifoldize cache-hit in ${Math.round(__t1 - __t0)} ms`); } catch { }
            return this._manifold;
        }
        let __logged = false;
        const __logDone = (ok = true) => {
            if (__logged) return; __logged = true;
            const __t1 = nowMs();
            const triCountDbg = (this?._triVerts?.length || 0) / 3 | 0;
            const vertCountDbg = (this?._vertProperties?.length || 0) / 3 | 0;
            try {
                if (debugMode) console.log(`[Solid] _manifoldize ${ok ? 'built' : 'failed'} in ${Math.round(__t1 - __t0)} ms (tris=${triCountDbg}, verts=${vertCountDbg})`);
            } catch { }
        };
        try {
        // Ensure consistent orientation before building a Manifold
        this.fixTriangleWindingsByAdjacency();
        // Ensure outward orientation (positive signed volume). If negative, flip all tris.
        const signedVolume = (() => {
            const vp = this._vertProperties;
            let vol6 = 0; // 6 * volume
            for (let t = 0; t < this._triVerts.length; t += 3) {
                const i0 = this._triVerts[t], i1 = this._triVerts[t + 1], i2 = this._triVerts[t + 2];
                const x0 = vp[i0 * 3], y0 = vp[i0 * 3 + 1], z0 = vp[i0 * 3 + 2];
                const x1 = vp[i1 * 3], y1 = vp[i1 * 3 + 1], z1 = vp[i1 * 3 + 2];
                const x2 = vp[i2 * 3], y2 = vp[i2 * 3 + 1], z2 = vp[i2 * 3 + 2];
                // triple product p0 · (p1 × p2)
                vol6 += x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2);
            }
            return vol6 / 6.0;
        })();
        if (signedVolume < 0) {
            for (let t = 0; t < this._triVerts.length; t += 3) {
                // swap indices 1 and 2 to flip triangle
                const tmp = this._triVerts[t + 1];
                this._triVerts[t + 1] = this._triVerts[t + 2];
                this._triVerts[t + 2] = tmp;
            }
        }

        const triCount = (this._triVerts.length / 3) | 0;
        const triVerts = new Uint32Array(this._triVerts);
        const faceID = new Uint32Array(triCount);
        for (let t = 0; t < triCount; t++) faceID[t] = this._triIDs[t];

        const mesh = new ManifoldMesh({
            numProp: this._numProp,
            vertProperties: new Float32Array(this._vertProperties),
            triVerts,
            faceID,
        });

        // Fill mergeFromVert/mergeToVert; positions and indices stay intact.
        mesh.merge();

        try {
            this._manifold = new Manifold(mesh);
        } catch (err) {
            // If this Solid is a FilletSolid (identified by presence of edgeToFillet),
            // emit a structured JSON log with diagnostic context for debugging.
            try {
                if (this && Object.prototype.hasOwnProperty.call(this, 'edgeToFillet')) {
                    const triCount = (this._triVerts?.length || 0) / 3 | 0;
                    const vertCount = (this._vertProperties?.length || 0) / 3 | 0;
                    const faces = [];
                    try {
                        if (this.edgeToFillet && Array.isArray(this.edgeToFillet.faces)) {
                            for (const f of this.edgeToFillet.faces) if (f && f.name) faces.push(f.name);
                        }
                    } catch {}
                    const failure = {
                        type: 'FilletSolidManifoldFailure',
                        message: (err && (err.message || String(err))) || 'unknown',
                        params: {
                            radius: this.radius,
                            arcSegments: this.arcSegments,
                            sampleCount: this.sampleCount,
                            sideMode: this.sideMode,
                            inflate: this.inflate,
                            sideStripSubdiv: this.sideStripSubdiv,
                            seamInsetScale: this.seamInsetScale,
                            projectStripsOpenEdges: this.projectStripsOpenEdges,
                            forceSeamInset: this.forceSeamInset,
                        },
                        edge: {
                            name: this.edgeToFillet?.name || null,
                            closedLoop: !!(this.edgeToFillet?.closedLoop || this.edgeToFillet?.userData?.closedLoop),
                            faces,
                        },
                        counts: {
                            vertices: vertCount,
                            triangles: triCount,
                            faceLabels: (this._faceNameToID && typeof this._faceNameToID.size === 'number') ? this._faceNameToID.size : undefined,
                        },
                    };
                    // Use console.error to surface in dev tools; JSON.stringify ensures strict JSON format
                    try { console.error(JSON.stringify(failure)); } catch { console.error('[FilletSolidManifoldFailure]', failure.message); }
                }
            } catch {}
            __logDone(false);
            throw err;
        }
        finally {
            try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { }
        }
        this._dirty = false;
        this._faceIndex = null; // will rebuild on demand
        __logDone(true);
        return this._manifold;
        } finally {
            // In case of unexpected control flow, ensure we log once with best-effort status.
            const ok = !!(this && this._manifold) && this._dirty === false;
            __logDone(ok);
        }
    }

    /**
     * Return the underlying MeshGL (fresh from Manifold so it reflects any CSG).
     * Useful if you want to pass this to other systems (e.g., Three.js).
     */
    getMesh() {
        return this._manifoldize().getMesh();
    }

    /**
     * Free wasm resources associated with this Solid.
     *
     * Disposes the underlying Manifold instance (if any) to prevent
     * accumulating wasm memory across rebuilds. After calling free(),
     * the Solid remains usable — any subsequent call that needs the
     * manifold will trigger a fresh _manifoldize().
     *
     * Note: Callers who obtain Mesh objects directly via getMesh()
     * are responsible for deleting those Mesh objects themselves.
     *
     * @returns {Solid} this
     */
    free() {
        try {
            // Clear any pending auto-free timer first
            try { if (this._freeTimer) { clearTimeout(this._freeTimer); } } catch (_) {}
            this._freeTimer = null;
            if (this._manifold) {
                try { if (typeof this._manifold.delete === 'function') this._manifold.delete(); } catch (_) {}
                this._manifold = null;
            }
            this._dirty = true;
            this._faceIndex = null;
        } catch (_) { /* noop */ }
        return this;
    }

    /**
     * Offset all vertices belonging to the given face along the face's
     * area-weighted average normal by the specified distance.
     *
     * Notes
     * - Vertices are selected by membership in triangles whose faceID maps to `faceName`.
     * - Shared vertices (on boundaries) will also move, which moves adjacent faces too.
     * - Edits are applied to authoring arrays; the manifold is marked dirty and rebuilt lazily.
     *
     * @param {string} faceName Name of the face to move (as given to addTriangle or propagated via CSG).
     * @param {number} distance Signed distance to translate along the average normal.
     * @returns {Solid} this
     */
    offsetFace(faceName, distance) {
        const dist = Number(distance);
        if (!Number.isFinite(dist) || dist === 0) return this;
        const id = this._faceNameToID.get(faceName);
        if (id === undefined) return this; // unknown face name → no-op

        // Work from current manifold mesh so labels reflect any CSG changes.
        const mesh = this.getMesh();
        const vp = mesh.vertProperties; // Float32Array
        const tv = mesh.triVerts;       // Uint32Array
        const faceIDs = mesh.faceID;    // Uint32Array
        const triCount = (tv.length / 3) | 0;
        if (!faceIDs || faceIDs.length !== triCount) return this;

        // 1) Gather triangles and accumulate area-weighted normal.
        let nx = 0, ny = 0, nz = 0;
        const affectedVerts = new Set();
        for (let t = 0; t < triCount; t++) {
            if (faceIDs[t] !== id) continue;
            const b = t * 3;
            const i0 = tv[b + 0] >>> 0;
            const i1 = tv[b + 1] >>> 0;
            const i2 = tv[b + 2] >>> 0;
            affectedVerts.add(i0); affectedVerts.add(i1); affectedVerts.add(i2);

            const ax = vp[i0 * 3 + 0], ay = vp[i0 * 3 + 1], az = vp[i0 * 3 + 2];
            const bx = vp[i1 * 3 + 0], by = vp[i1 * 3 + 1], bz = vp[i1 * 3 + 2];
            const cx = vp[i2 * 3 + 0], cy = vp[i2 * 3 + 1], cz = vp[i2 * 3 + 2];
            const ux = bx - ax, uy = by - ay, uz = bz - az;
            const vx = cx - ax, vy = cy - ay, vz = cz - az;
            // Oriented area vector (u x v) — sums to area-weighted average normal direction
            nx += uy * vz - uz * vy;
            ny += uz * vx - ux * vz;
            nz += ux * vy - uy * vx;
        }

        // 2) Normalize to get unit average normal.
        const len = Math.hypot(nx, ny, nz);
        if (!(len > 0)) return this; // degenerate face → no-op
        const sx = (nx / len) * dist;
        const sy = (ny / len) * dist;
        const sz = (nz / len) * dist;

        // 3) Apply translation to authoring vertex buffer.
        if (!this._vertProperties || this._vertProperties.length === 0) return this;
        for (const vi of affectedVerts) {
            const base = (vi * 3) | 0;
            this._vertProperties[base + 0] += sx;
            this._vertProperties[base + 1] += sy;
            this._vertProperties[base + 2] += sz;
        }

        // 4) Rebuild exact-key map and mark dirty so manifold rebuilds on demand.
        this._vertKeyToIndex = new Map();
        for (let i = 0; i < this._vertProperties.length; i += 3) {
            const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
            this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }
        this._dirty = true;
        this._faceIndex = null;
        try { return this; } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
    }

    // Build a cache: faceID -> array of triangle indices
    _ensureFaceIndex() {
        if (this._faceIndex) return;
        const mesh = this.getMesh();
        const { triVerts, faceID } = mesh;
        const triCount = (triVerts.length / 3) | 0;
        const map = new Map();
        if (faceID && faceID.length === triCount) {
            for (let t = 0; t < triCount; t++) {
                const id = faceID[t];
                let arr = map.get(id);
                if (!arr) { arr = []; map.set(id, arr); }
                arr.push(t);
            }
        }
        this._faceIndex = map;
        try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {}
    }

    /**
     * Get all triangles belonging to a face by name.
     * Returns objects with positions; also includes vertex indices.
     * If the face was completely removed by CSG, returns [].
     */
    getFace(name) {
        const id = this._faceNameToID.get(name);
        if (id === undefined) return [];

        this._ensureFaceIndex();
        const mesh = this.getMesh();
        const { vertProperties, triVerts } = mesh;
        const tris = this._faceIndex.get(id) || [];

        const out = [];
        for (let idx = 0; idx < tris.length; idx++) {
            const t = tris[idx];
            const base = t * 3;
            const i0 = triVerts[base + 0];
            const i1 = triVerts[base + 1];
            const i2 = triVerts[base + 2];

            const p0 = [
                vertProperties[i0 * 3 + 0],
                vertProperties[i0 * 3 + 1],
                vertProperties[i0 * 3 + 2],
            ];
            const p1 = [
                vertProperties[i1 * 3 + 0],
                vertProperties[i1 * 3 + 1],
                vertProperties[i1 * 3 + 2],
            ];
            const p2 = [
                vertProperties[i2 * 3 + 0],
                vertProperties[i2 * 3 + 1],
                vertProperties[i2 * 3 + 2],
            ];

            out.push({ faceName: name, indices: [i0, i1, i2], p1: p0, p2: p1, p3: p2 });
        }
        try { return out; } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
    }

    /** Convenience: list all face names present in this solid (known to the wrapper). */
    getFaceNames() {
        return [...this._faceNameToID.keys()];
    }

    /**
     * Export the current solid as an ASCII STL string.
     * @param {string} name Optional solid name in the STL header.
     * @param {number} precision Number of decimal places to write.
     * @returns {string} ASCII STL contents.
     */
    toSTL(name = "solid", precision = 6) {
        const mesh = this.getMesh();
        const { vertProperties, triVerts } = mesh;

        const fmt = (n) => Number.isFinite(n) ? n.toFixed(precision) : "0";
        const parts = [];
        parts.push(`solid ${name}`);

        const triCount = (triVerts.length / 3) | 0;
        for (let t = 0; t < triCount; t++) {
            const i0 = triVerts[t * 3 + 0];
            const i1 = triVerts[t * 3 + 1];
            const i2 = triVerts[t * 3 + 2];

            const p0 = [
                vertProperties[i0 * 3 + 0],
                vertProperties[i0 * 3 + 1],
                vertProperties[i0 * 3 + 2],
            ];
            const p1 = [
                vertProperties[i1 * 3 + 0],
                vertProperties[i1 * 3 + 1],
                vertProperties[i1 * 3 + 2],
            ];
            const p2 = [
                vertProperties[i2 * 3 + 0],
                vertProperties[i2 * 3 + 1],
                vertProperties[i2 * 3 + 2],
            ];

            const ux = p1[0] - p0[0];
            const uy = p1[1] - p0[1];
            const uz = p1[2] - p0[2];
            const vx = p2[0] - p0[0];
            const vy = p2[1] - p0[1];
            const vz = p2[2] - p0[2];
            let nx = uy * vz - uz * vy;
            let ny = uz * vx - ux * vz;
            let nz = ux * vy - uy * vx;
            const nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;

            parts.push(`  facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`);
            parts.push(`    outer loop`);
            parts.push(`      vertex ${fmt(p0[0])} ${fmt(p0[1])} ${fmt(p0[2])}`);
            parts.push(`      vertex ${fmt(p1[0])} ${fmt(p1[1])} ${fmt(p1[2])}`);
            parts.push(`      vertex ${fmt(p2[0])} ${fmt(p2[1])} ${fmt(p2[2])}`);
            parts.push(`    endloop`);
            parts.push(`  endfacet`);
        }

        parts.push(`endsolid ${name}`);
        try { return parts.join("\n"); } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
    }

    /**
     * Write an ASCII STL file to disk (Node.js only).
     * Uses a dynamic import for fs so this module remains browser-safe.
     * @param {string} filePath Destination path for the STL file.
     * @param {string} name Optional solid name in the STL header.
     * @param {number} precision Decimal places to write.
     */
    async writeSTL(filePath, name = "solid", precision = 6) {
        if (typeof window !== "undefined") {
            throw new Error("writeSTL is only available in Node.js environments");
        }
        const { writeFile } = await import('node:fs/promises');
        const stl = this.toSTL(name, precision);
        await writeFile(filePath, stl, 'utf8');
        return filePath;
    }

    /**
     * Enumerate faces with their triangles in one pass.
     * @param {boolean} includeEmpty When true, include names that currently have no triangles.
     * @returns {{faceName: string, triangles: {faceName:string, indices:number[], p1:number[], p2:number[], p3:number[]}[]}[]}
     */
    getFaces(includeEmpty = false) {
        this._ensureFaceIndex();
        const mesh = this.getMesh();
        const { vertProperties, triVerts } = mesh;

        const out = [];
        const nameToTris = new Map();
        if (includeEmpty) {
            for (const fname of this.getFaceNames()) nameToTris.set(fname, []);
        }

        for (const [id, triList] of this._faceIndex.entries()) {
            // Fallback name for IDs Manifold produced that our map doesn't know yet
            const name = this._idToFaceName.get(id) || `FACE_${id}`;
            let arr = nameToTris.get(name);
            if (!arr) { arr = []; nameToTris.set(name, arr); }
            for (let idx = 0; idx < triList.length; idx++) {
                const t = triList[idx];
                const base = t * 3;
                const i0 = triVerts[base + 0];
                const i1 = triVerts[base + 1];
                const i2 = triVerts[base + 2];
                const p0 = [
                    vertProperties[i0 * 3 + 0],
                    vertProperties[i0 * 3 + 1],
                    vertProperties[i0 * 3 + 2],
                ];
                const p1 = [
                    vertProperties[i1 * 3 + 0],
                    vertProperties[i1 * 3 + 1],
                    vertProperties[i1 * 3 + 2],
                ];
                const p2 = [
                    vertProperties[i2 * 3 + 0],
                    vertProperties[i2 * 3 + 1],
                    vertProperties[i2 * 3 + 2],
                ];
                arr.push({ faceName: name, indices: [i0, i1, i2], p1: p0, p2: p1, p3: p2 });
            }
        }

        for (const [faceName, triangles] of nameToTris.entries()) {
            out.push({ faceName, triangles });
        }
        return out;
    }

    /**
     * Build a Three.js Group of per-face meshes for visualization.
     * - Each face label becomes its own Mesh with a single material.
     * - By default, generates a deterministic color per face name.
     * - Accepts a THREE reference or uses global window.THREE if available.
     *
     * @param {any} THREERef Optional reference to the three.js module/object.
     * @param {object} options Optional settings
     * @param {(name:string)=>any} options.materialForFace Optional factory returning a THREE.Material for a face
     * @param {boolean} options.wireframe Render materials as wireframe (default false)
     * @param {string} options.name Name for the group (default 'Solid')
     * @returns {any} THREE.Group containing one child Mesh per face
     */
    visualize(options = {}) {
        // Clear existing children and dispose resources
        for (let i = this.children.length - 1; i >= 0; i--) {
            const child = this.children[i];
            this.remove(child);
            if (child.geometry && typeof child.geometry.dispose === 'function') child.geometry.dispose();
            const mat = child.material;
            if (mat) {
                if (Array.isArray(mat)) mat.forEach(m => m && m.dispose && m.dispose());
                else if (typeof mat.dispose === 'function') mat.dispose();
            }
        }

        const { showEdges = true, forceAuthoring = false, authoringOnly = false } = options;
        let faces; let usedFallback = false;
        if (!forceAuthoring && !authoringOnly) {
            try {
                faces = this.getFaces(false);
            } catch (err) {
                console.warn('[Solid.visualize] getFaces failed, falling back to raw arrays:', err?.message || err);
                usedFallback = true;
            }
        } else {
            usedFallback = true;
        }
        if (usedFallback || !faces) {
            // Fallback: group authored triangles by face name directly from arrays.
            // This enables visualization even if manifoldization failed, which helps debugging.
            const vp = this._vertProperties || [];
            const tv = this._triVerts || [];
            const ids = this._triIDs || [];
            const nameOf = (id) => this._idToFaceName && this._idToFaceName.get ? this._idToFaceName.get(id) : String(id);
            const nameToTris = new Map();
            const triCount = (tv.length / 3) | 0;
            for (let t = 0; t < triCount; t++) {
                const id = ids[t];
                const name = nameOf(id);
                if (!name) continue;
                let arr = nameToTris.get(name);
                if (!arr) { arr = []; nameToTris.set(name, arr); }
                const i0 = tv[t * 3 + 0], i1 = tv[t * 3 + 1], i2 = tv[t * 3 + 2];
                const p0 = [vp[i0 * 3 + 0], vp[i0 * 3 + 1], vp[i0 * 3 + 2]];
                const p1 = [vp[i1 * 3 + 0], vp[i1 * 3 + 1], vp[i1 * 3 + 2]];
                const p2 = [vp[i2 * 3 + 0], vp[i2 * 3 + 1], vp[i2 * 3 + 2]];
                arr.push({ faceName: name, indices: [i0, i1, i2], p1: p0, p2: p1, p3: p2 });
            }
            faces = [];
            for (const [faceName, triangles] of nameToTris.entries()) faces.push({ faceName, triangles });
        }

        // Build Face meshes and index by name
        const faceMap = new Map();
        for (const { faceName, triangles } of faces) {
            if (!triangles.length) continue;
            const positions = new Float32Array(triangles.length * 9);
            let w = 0;
            for (let t = 0; t < triangles.length; t++) {
                const tri = triangles[t];
                const p0 = tri.p1, p1 = tri.p2, p2 = tri.p3;
                positions[w++] = p0[0]; positions[w++] = p0[1]; positions[w++] = p0[2];
                positions[w++] = p1[0]; positions[w++] = p1[1]; positions[w++] = p1[2];
                positions[w++] = p2[0]; positions[w++] = p2[1]; positions[w++] = p2[2];
            }

            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geom.computeVertexNormals();
            geom.computeBoundingBox();
            geom.computeBoundingSphere();

            const faceObj = new Face(geom);
            faceObj.name = faceName;
            faceObj.userData.faceName = faceName;
            faceMap.set(faceName, faceObj);
            this.add(faceObj);
        }

        if (showEdges) {
            if (!usedFallback) {
                let polylines = [];
                try { polylines = this.getBoundaryEdgePolylines() || []; } catch { polylines = []; }
                // Safety net: if manifold-based extraction yielded no edges (e.g., faceID missing),
                // fall back to authoring-based boundary extraction so we still visualize edges.
                if (!Array.isArray(polylines) || polylines.length === 0) {
                    try { usedFallback = true; } catch {}
                }
                for (const e of polylines) {
                    const positions = new Float32Array(e.positions.length * 3);
                    let w = 0;
                    for (let i = 0; i < e.positions.length; i++) {
                        const p = e.positions[i];
                        positions[w++] = p[0]; positions[w++] = p[1]; positions[w++] = p[2];
                    }
                    const g = new LineGeometry();
                    g.setPositions(Array.from(positions));
                    try { g.computeBoundingSphere(); } catch {}

                    const edgeObj = new Edge(g);
                    edgeObj.name = e.name;
                    edgeObj.closedLoop = !!e.closedLoop;
                    edgeObj.userData = { faceA: e.faceA, faceB: e.faceB, polylineLocal: e.positions, closedLoop: !!e.closedLoop };
                    // For convenience in feature code, mirror THREE's parent with an explicit handle
                    edgeObj.parentSolid = this;
                    const fa = faceMap.get(e.faceA);
                    const fb = faceMap.get(e.faceB);
                    if (fa) fa.edges.push(edgeObj);
                    if (fb) fb.edges.push(edgeObj);
                    if (fa) edgeObj.faces.push(fa);
                    if (fb) edgeObj.faces.push(fb);
                    this.add(edgeObj);
                }
            }
            if (usedFallback) {
                // Fallback boundary extraction from raw authoring arrays.
                try {
                    const vp = this._vertProperties || [];
                    const tv = this._triVerts || [];
                    const ids = this._triIDs || [];
                    const nv = (vp.length / 3) | 0;
                    const triCount = (tv.length / 3) | 0;
                    const NV = BigInt(Math.max(1, nv));
                    const ukey = (a,b) => { const A=BigInt(a), B=BigInt(b); return A<B ? A*NV+B : B*NV+A; };
                    const e2t = new Map(); // key -> [{id,a,b,tri}...]
                    for (let t = 0; t < triCount; t++) {
                        const id = ids[t];
                        const base = t * 3;
                        const i0 = tv[base + 0]>>>0, i1 = tv[base + 1]>>>0, i2 = tv[base + 2]>>>0;
                        const edges = [ [i0,i1], [i1,i2], [i2,i0] ];
                        for (let k = 0; k < 3; k++) {
                            const a = edges[k][0], b = edges[k][1];
                            const key = ukey(a,b);
                            let arr = e2t.get(key);
                            if (!arr) { arr = []; e2t.set(key, arr); }
                            arr.push({ id, a, b, tri: t });
                        }
                    }
                    // Create polyline objects between differing face IDs (authoring labels)
                    const nameOf = (id) => this._idToFaceName && this._idToFaceName.get ? this._idToFaceName.get(id) : String(id);
                    const pairToEdges = new Map(); // pairKey -> array of [u,v]
                    for (const [key, arr] of e2t.entries()) {
                        if (arr.length !== 2) continue;
                        const a = arr[0], b = arr[1];
                        if (a.id === b.id) continue;
                        const nameA = nameOf(a.id), nameB = nameOf(b.id);
                        const pair = nameA < nameB ? [nameA, nameB] : [nameB, nameA];
                        const pairKey = JSON.stringify(pair);
                        let list = pairToEdges.get(pairKey);
                        if (!list) { list = []; pairToEdges.set(pairKey, list); }
                        const u = Math.min(a.a, a.b), v = Math.max(a.a, a.b);
                        list.push([u,v]);
                    }

                    const addPolyline = (nameA, nameB, indices) => {
                        const visited = new Set();
                        const adj = new Map();
                        const ek = (u,v)=> (u<v?`${u},${v}`:`${v},${u}`);
                        for (const [u,v] of indices) {
                            if (!adj.has(u)) adj.set(u,new Set());
                            if (!adj.has(v)) adj.set(v,new Set());
                            adj.get(u).add(v); adj.get(v).add(u);
                        }
                        const verts = (idx)=> [vp[idx*3+0], vp[idx*3+1], vp[idx*3+2]];
                        for (const [u0] of adj.entries()) {
                            // find start (degree 1) or any if loop
                            if ([...adj.get(u0)].length !== 1) continue;
                            const poly = [];
                            let u = u0, prev = -1;
                            while (true) {
                                const nbrs = [...adj.get(u)];
                                let v = nbrs[0];
                                if (v === prev && nbrs.length>1) v = nbrs[1];
                                if (v === undefined) break;
                                const key = ek(u,v);
                                if (visited.has(key)) break;
                                visited.add(key);
                                poly.push(verts(u));
                                prev = u; u = v;
                                if (!adj.has(u)) break;
                            }
                            poly.push(verts(u));
                            if (poly.length >= 2) {
                                const g = new LineGeometry();
                                g.setPositions(poly.flat());
                                try { g.computeBoundingSphere(); } catch {}
                                const edgeObj = new Edge(g);
                                edgeObj.name = `${nameA}|${nameB}`;
                                edgeObj.closedLoop = false;
                                edgeObj.userData = { faceA: nameA, faceB: nameB, polylineLocal: poly, closedLoop: false };
                                edgeObj.parentSolid = this;
                                const fa = faceMap.get(nameA); const fb = faceMap.get(nameB);
                                if (fa) fa.edges.push(edgeObj); if (fb) fb.edges.push(edgeObj);
                                if (fa) edgeObj.faces.push(fa); if (fb) edgeObj.faces.push(fb);
                                this.add(edgeObj);
                            }
                        }
                    };
                    for (const [pairKey, edgeList] of pairToEdges.entries()) {
                        const [a,b] = JSON.parse(pairKey);
                        addPolyline(a,b, edgeList);
                    }
                } catch (_) { /* ignore fallback edge errors */ }
            }
        }

        // Generate unique vertex objects at the start and end points of all edges
        try {
            const endpoints = new Map();
            for (const ch of this.children) {
                if (!ch || ch.type !== 'EDGE') continue;
                const poly = ch.userData && Array.isArray(ch.userData.polylineLocal) ? ch.userData.polylineLocal : null;
                if (!poly || poly.length === 0) continue;
                const first = poly[0];
                const last = poly[poly.length - 1];
                const addEP = (p) => {
                    if (!p || p.length !== 3) return;
                    const k = `${p[0]},${p[1]},${p[2]}`;
                    if (!endpoints.has(k)) endpoints.set(k, p);
                };
                addEP(first);
                addEP(last);
            }
            if (endpoints.size) {
                for (const p of endpoints.values()) {
                    try { this.add(new Vertex(p)); } catch {}
                }
            }
        } catch { /* best-effort vertices */ }

        return this;
    }

    /**
     * Compute connected polylines for boundary edges between pairs of face labels.
     * Returns: [{ name, faceA, faceB, indices: number[], positions: [Vec3,...] }]
     */
    getBoundaryEdgePolylines() {
        const mesh = this.getMesh();
        try {
        const { vertProperties, triVerts, faceID } = mesh;
        const triCount = (triVerts.length / 3) | 0;
        const nv = (vertProperties.length / 3) | 0;
        const NV = BigInt(nv);
        const ukey = (a, b) => {
            const A = BigInt(a); const B = BigInt(b);
            return A < B ? A * NV + B : B * NV + A;
        };

        // Build undirected edge map -> triangles using it with their faceIDs
        const e2t = new Map(); // key -> [{id, a, b, tri}...]
        for (let t = 0; t < triCount; t++) {
            const id = faceID ? faceID[t] : undefined;
            const base = t * 3;
            const i0 = triVerts[base + 0], i1 = triVerts[base + 1], i2 = triVerts[base + 2];
            const edges = [ [i0, i1], [i1, i2], [i2, i0] ];
            for (let k = 0; k < 3; k++) {
                const a = edges[k][0], b = edges[k][1];
                const key = ukey(a, b);
                let arr = e2t.get(key);
                if (!arr) { arr = []; e2t.set(key, arr); }
                arr.push({ id, a, b, tri: t });
            }
        }

        // Collect boundary edges between distinct face IDs, grouped by face-name pairs.
        // IMPORTANT: Face names may themselves contain the character '|'
        // (e.g. sweep side faces based on original edge names). Using a raw
        // string with '|' as a delimiter would break when we later split it.
        // To avoid ambiguity, we serialize the pair as JSON.
        const pairToEdges = new Map(); // pairKey(JSON '[nameA,nameB]') -> array of [u,v]
        for (const [key, arr] of e2t.entries()) {
            if (arr.length !== 2) continue; // boundary or non-manifold; skip
            const a = arr[0], b = arr[1];
            if (a.id === b.id) continue; // same face label; not a boundary between labels
            const nameA = this._idToFaceName.get(a.id) || `FACE_${a.id}`;
            const nameB = this._idToFaceName.get(b.id) || `FACE_${b.id}`;
            const pair = nameA < nameB ? [nameA, nameB] : [nameB, nameA];
            const pairKey = JSON.stringify(pair);
            let list = pairToEdges.get(pairKey);
            if (!list) { list = []; pairToEdges.set(pairKey, list); }
            // Store undirected as canonical [min,max]
            // recompute min/max from endpoints (avoid BigInt to number pitfalls)
            const v0 = Math.min(a.a, a.b);
            const v1 = Math.max(a.a, a.b);
            list.push([v0, v1]);
        }

        // Turn disjoint edges into connected polylines per pair
        const polylines = [];
        for (const [pairKey, edges] of pairToEdges.entries()) {
            // Build adjacency map
            const adj = new Map(); // v -> Set(neighbors)
            const edgeVisited = new Set(); // canonical key `${min},${max}`
            const ek = (u, v) => (u < v ? `${u},${v}` : `${v},${u}`);
            for (const [u, v] of edges) {
                if (!adj.has(u)) adj.set(u, new Set());
                if (!adj.has(v)) adj.set(v, new Set());
                adj.get(u).add(v);
                adj.get(v).add(u);
            }

            const [faceA, faceB] = JSON.parse(pairKey);
            let idx = 0;

            const visitChainFrom = (start) => {
                const chain = [];
                let prev = -1;
                let curr = start;
                chain.push(curr);
                while (true) {
                    const nbrs = adj.get(curr) || new Set();
                    let next = undefined;
                    for (const n of nbrs) {
                        const key = ek(curr, n);
                        if (edgeVisited.has(key)) continue;
                        if (n === prev) continue;
                        next = n; edgeVisited.add(key); break;
                    }
                    if (next === undefined) break;
                    prev = curr; curr = next; chain.push(curr);
                }
                return chain;
            };

            // Find open chains (degree 1 endpoints) first
            for (const [v, nbrs] of adj.entries()) {
                if ((nbrs.size | 0) === 1) {
                    // ensure its sole edge not yet visited
                    const n = [...nbrs][0];
                    const key = ek(v, n);
                    if (edgeVisited.has(key)) continue;
                    const chain = visitChainFrom(v);
                    const positions = chain.map(vi => [
                        vertProperties[vi * 3 + 0],
                        vertProperties[vi * 3 + 1],
                        vertProperties[vi * 3 + 2],
                    ]);
                    polylines.push({ name: `${faceA}|${faceB}[${idx++}]`, faceA, faceB, indices: chain, positions, closedLoop: false });
                }
            }

            // Remaining are loops; walk an unvisited edge and close back to start
            const buildLoopFromEdge = (startU, startV) => {
                const chain = [startU, startV];
                let prev = startU;
                let curr = startV;
                edgeVisited.add(ek(startU, startV));
                while (true) {
                    const nbrs = adj.get(curr) || new Set();
                    let next = undefined;
                    for (const n of nbrs) {
                        if (n === prev) continue;
                        const key = ek(curr, n);
                        if (edgeVisited.has(key)) continue;
                        next = n; break;
                    }
                    if (next === undefined) break;
                    edgeVisited.add(ek(curr, next));
                    chain.push(next);
                    prev = curr; curr = next;
                }
                // Close the loop geometrically if possible
                const start = chain[0];
                const last = chain[chain.length - 1];
                const nbrsLast = adj.get(last) || new Set();
                if (nbrsLast.has(start)) {
                    // Mark the closing edge visited (ok if already visited)
                    edgeVisited.add(ek(last, start));
                    chain.push(start);
                }
                return chain;
            };

            for (const [u, nbrs] of adj.entries()) {
                for (const v of nbrs) {
                    const key = ek(u, v);
                    if (edgeVisited.has(key)) continue;
                    const chain = buildLoopFromEdge(u, v);
                    const positions = chain.map(vi => [
                        vertProperties[vi * 3 + 0],
                        vertProperties[vi * 3 + 1],
                        vertProperties[vi * 3 + 2],
                    ]);
                    const closed = chain.length >= 3 && chain[0] === chain[chain.length - 1];
                    polylines.push({ name: `${faceA}|${faceB}[${idx++}]`, faceA, faceB, indices: chain, positions, closedLoop: closed });
                    }
            }
        }

        return polylines;
        } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
    }


    // --- Boolean ops (face names/IDs propagate automatically) ------------------

    _combineIdMaps(other) {
        // Because Manifold.reserveIDs() returns globally-unique IDs, simply union maps.
        const merged = new Map(this._idToFaceName);
        for (const [id, name] of other._idToFaceName.entries()) {
            merged.set(id, name);
        }
        return merged;
    }

    static _expandTriIDsFromMesh(mesh) {
        // Pull per-triangle IDs directly from faceID, which manifold propagates.
        if (mesh.faceID && mesh.faceID.length) {
            return Array.from(mesh.faceID);
        }
        return new Array((mesh.triVerts.length / 3) | 0).fill(0);
    }

    static _fromManifold(manifoldObj, idToFaceName) {
        const mesh = manifoldObj.getMesh();
        const solid = new Solid();

        // Copy raw arrays back into authoring format
        solid._numProp = mesh.numProp;
        solid._vertProperties = Array.from(mesh.vertProperties);
        solid._triVerts = Array.from(mesh.triVerts);
        solid._triIDs = Solid._expandTriIDsFromMesh(mesh);

        // Recreate vertex map for future edits
        for (let i = 0; i < mesh.vertProperties.length; i += 3) {
            const x = mesh.vertProperties[i + 0];
            const y = mesh.vertProperties[i + 1];
            const z = mesh.vertProperties[i + 2];
            solid._vertKeyToIndex.set(`${x},${y},${z}`, i / 3);
        }

        // Restore face name maps, but ensure every faceID present in the mesh has a name.
        const completeMap = new Map(idToFaceName);
        try {
            const ids = mesh.faceID && mesh.faceID.length ? mesh.faceID : null;
            const triCount = (mesh.triVerts?.length || 0) / 3 | 0;
            if (ids && ids.length === triCount) {
                // Add fallback names for any unknown IDs to guarantee coverage
                const seen = new Set();
                for (let t = 0; t < triCount; t++) {
                    const id = ids[t] >>> 0;
                    if (seen.has(id)) continue;
                    seen.add(id);
                    if (!completeMap.has(id)) completeMap.set(id, `FACE_${id}`);
                }
            } else if (!ids) {
                // No faceID provided by mesh: authoring triIDs were expanded as zeros.
                if (!completeMap.has(0)) completeMap.set(0, 'FACE_0');
            }
        } catch (_) { /* best-effort completion */ }

        solid._idToFaceName = new Map(completeMap);
        solid._faceNameToID = new Map(
            [...solid._idToFaceName.entries()].map(([id, name]) => [name, id])
        );

        solid._manifold = manifoldObj;
        solid._dirty = false;
        try { return solid; } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
    }

    union(other) {
        // Use Manifold.union per API
        const outManifold = Manifold.union(this._manifoldize(), other._manifoldize());
        const mergedMap = this._combineIdMaps(other);
        return Solid._fromManifold(outManifold, mergedMap);
    }

    subtract(other) {
        // Use Manifold.subtract() per API
        const outManifold = this._manifoldize().subtract(other._manifoldize());
        const mergedMap = this._combineIdMaps(other);
        return Solid._fromManifold(outManifold, mergedMap);
    }

    intersect(other) {
        // Use instance method for parity with subtract; intersection() is static-only in API,
        // so fall back to static here.
        const outManifold = Manifold.intersection(this._manifoldize(), other._manifoldize());
        const mergedMap = this._combineIdMaps(other);
        return Solid._fromManifold(outManifold, mergedMap);
    }

    /**
     * Boolean difference A − B using Manifold's built-in API.
     * Equivalent to `subtract`, provided for semantic clarity.
     * @param {Solid} other
     * @returns {Solid}
     */
    difference(other) {
        const outManifold = Manifold.difference(this._manifoldize(), other._manifoldize());
        const mergedMap = this._combineIdMaps(other);
        return Solid._fromManifold(outManifold, mergedMap);
    }

    /**
     * Return a simplified copy of this solid using Manifold's mesh simplification.
     * The simplification maintains edges between triangles with different faceIDs
     * so face labels are preserved in the result.
     *
     * @param {number} [tolerance] Maximum allowed distance between the original
     * and simplified surfaces. If omitted or smaller than the current
     * Manifold tolerance, the current tolerance is used.
     * @returns {Solid} New simplified Solid.
     */
    simplify(tolerance = undefined) {
        const m = this._manifoldize();
        const outM = (tolerance === undefined) ? m.simplify() : m.simplify(tolerance);
        // Face IDs are preserved by Manifold, so we can reuse the existing id->name map
        const mapCopy = new Map(this._idToFaceName);
        return Solid._fromManifold(outM, mapCopy);
    }

    /**
     * Return a copy of this solid with its manifold tolerance set to the given
     * value. Increasing tolerance may simplify the mesh.
     *
     * @param {number} tolerance New tolerance value to set on the manifold.
     * @returns {Solid} New Solid with updated tolerance.
     */
    setTolerance(tolerance) {
        const m = this._manifoldize();
        const outM = m.setTolerance(tolerance);
        const mapCopy = new Map(this._idToFaceName);
        return Solid._fromManifold(outM, mapCopy);
    }

    // Compute closed volume from oriented triangles (MeshGL from manifold)
    volume() {
        const mesh = this.getMesh();
        try {
        const vp = mesh.vertProperties;
        const tv = mesh.triVerts;
        let vol6 = 0;
        for (let t = 0; t < tv.length; t += 3) {
            const i0 = tv[t] * 3, i1 = tv[t + 1] * 3, i2 = tv[t + 2] * 3;
            const x0 = vp[i0], y0 = vp[i0 + 1], z0 = vp[i0 + 2];
            const x1 = vp[i1], y1 = vp[i1 + 1], z1 = vp[i1 + 2];
            const x2 = vp[i2], y2 = vp[i2 + 1], z2 = vp[i2 + 2];
            vol6 += x0 * (y1 * z2 - z1 * y2)
                  - y0 * (x1 * z2 - z1 * x2)
                  + z0 * (x1 * y2 - y1 * x2);
        }
        return Math.abs(vol6) / 6.0;
        } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
    }

    // Sum of triangle areas on the surface
    surfaceArea() {
        const mesh = this.getMesh();
        try {
        const vp = mesh.vertProperties;
        const tv = mesh.triVerts;
        let area = 0;
        for (let t = 0; t < tv.length; t += 3) {
            const i0 = tv[t] * 3, i1 = tv[t + 1] * 3, i2 = tv[t + 2] * 3;
            const ax = vp[i0], ay = vp[i0 + 1], az = vp[i0 + 2];
            const bx = vp[i1], by = vp[i1 + 1], bz = vp[i1 + 2];
            const cx = vp[i2], cy = vp[i2 + 1], cz = vp[i2 + 2];
            const ux = bx - ax, uy = by - ay, uz = bz - az;
            const vx = cx - ax, vy = cy - ay, vz = cz - az;
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            area += 0.5 * Math.hypot(nx, ny, nz);
        }
        return area;
        } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
    }
}

// --- Method-level time profiling for Solid -----------------------------------
// Wrap all prototype methods (except constructor and _manifoldize, which is
// already instrumented) to log execution time when debugMode is true.
(() => {
    try {
        if (Solid.__profiled) return;
        Solid.__profiled = true;
        const nowMs = () => (typeof performance !== 'undefined' && performance?.now ? performance.now() : Date.now());
        const skip = new Set(['constructor', '_manifoldize']);
        const proto = Solid.prototype;
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (skip.has(name)) continue;
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            if (!desc || typeof desc.value !== 'function') continue;
            const fn = desc.value;
            const wrapped = function (...args) {
                if (!debugMode) return fn.apply(this, args);
                const t0 = nowMs();
                try {
                    const ret = fn.apply(this, args);
                    if (ret && typeof ret.then === 'function') {
                        return ret.then(
                            (val) => { try { if (debugMode) console.log(`[Solid] ${name} resolved in ${Math.round(nowMs() - t0)} ms`); } catch {} return val; },
                            (err) => { try { if (debugMode) console.log(`[Solid] ${name} rejected in ${Math.round(nowMs() - t0)} ms`); } catch {} throw err; }
                        );
                    }
                    try { if (debugMode) console.log(`[Solid] ${name} in ${Math.round(nowMs() - t0)} ms`); } catch {}
                    return ret;
                } catch (e) {
                    try { if (debugMode) console.log(`[Solid] ${name} threw in ${Math.round(nowMs() - t0)} ms`); } catch {}
                    throw e;
                }
            };
            try { Object.defineProperty(wrapped, 'name', { value: name, configurable: true }); } catch {}
            Object.defineProperty(proto, name, { ...desc, value: wrapped });
        }
    } catch { }
})();

// --- Example usage -----------------------------------------------------------
// Build a 10 x 10 x w box by triangles, naming each face.
// Then query triangles for a face and perform a boolean op.

if (import.meta && import.meta.url && typeof window === "undefined") {
    // If running under Node for a quick test, you can comment this guard and log outputs.
}
