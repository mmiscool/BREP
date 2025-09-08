
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

        this.type = 'SOLID';
        this.renderOrder = 1;
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
        if (!this._dirty && this._manifold) return this._manifold;
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

        this._manifold = new Manifold(mesh);
        this._dirty = false;
        this._faceIndex = null; // will rebuild on demand
        return this._manifold;
    }

    /**
     * Return the underlying MeshGL (fresh from Manifold so it reflects any CSG).
     * Useful if you want to pass this to other systems (e.g., Three.js).
     */
    getMesh() {
        return this._manifoldize().getMesh();
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
        return out;
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
        return parts.join("\n");
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
            const name = this._idToFaceName.get(id);
            if (!name) continue;
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

        const { showEdges = true } = options;
        const faces = this.getFaces(false);

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
            const polylines = this.getBoundaryEdgePolylines();
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
                const fa = faceMap.get(e.faceA);
                const fb = faceMap.get(e.faceB);
                if (fa) fa.edges.push(edgeObj);
                if (fb) fb.edges.push(edgeObj);
                if (fa) edgeObj.faces.push(fa);
                if (fb) edgeObj.faces.push(fb);
                this.add(edgeObj);
            }
        }

        return this;
    }

    /**
     * Compute connected polylines for boundary edges between pairs of face labels.
     * Returns: [{ name, faceA, faceB, indices: number[], positions: [Vec3,...] }]
     */
    getBoundaryEdgePolylines() {
        const mesh = this.getMesh();
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
            const nameA = this._idToFaceName.get(a.id);
            const nameB = this._idToFaceName.get(b.id);
            if (!nameA || !nameB) continue;
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

        // Restore face name maps
        solid._idToFaceName = new Map(idToFaceName);
        solid._faceNameToID = new Map(
            [...solid._idToFaceName.entries()].map(([id, name]) => [name, id])
        );

        solid._manifold = manifoldObj;
        solid._dirty = false;
        return solid;
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
    }

    // Sum of triangle areas on the surface
    surfaceArea() {
        const mesh = this.getMesh();
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
    }
}

// --- Example usage -----------------------------------------------------------
// Build a 10 x 10 x w box by triangles, naming each face.
// Then query triangles for a face and perform a boolean op.

if (import.meta && import.meta.url && typeof window === "undefined") {
    // If running under Node for a quick test, you can comment this guard and log outputs.
}
