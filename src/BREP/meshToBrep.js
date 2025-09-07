import * as THREE from "three";
import { Solid } from "./BetterSolid.js";

/**
 * MeshToBrep: Builds a Solid from a triangle mesh by grouping triangles
 * into face labels based on the deflection angle between neighboring
 * triangle normals.
 *
 * Usage
 *   const solid = new MeshToBrep(geometryOrMesh, 15  deg );
 *   solid.name = "ImportedSTL";
 *   solid.visualize();
 *
 * Notes
 * - Accepts a THREE.BufferGeometry or a THREE.Mesh (uses its geometry).
 * - Triangles are welded to a grid (weldTolerance) so shared edges use
 *   identical vertex positions for manifoldization.
 * - If the input geometry has a `normal` attribute (STLLoader does),
 *   those normals are used for deflection. Otherwise, per-triangle
 *   normals are computed from positions.
 */
export class MeshToBrep extends Solid {
    /**
     * @param {THREE.BufferGeometry|THREE.Mesh} geometryOrMesh
     * @param {number} faceDeflectionAngle Degrees; neighbors within this angle join a face
     * @param {number} weldTolerance Vertex welding tolerance (units). Default 1e-5.
     */
    constructor(geometryOrMesh, faceDeflectionAngle = 30, weldTolerance = 1e-5) {
        super();
        const geom = (geometryOrMesh && geometryOrMesh.isMesh)
            ? geometryOrMesh.geometry
            : geometryOrMesh;
        if (!geom || !geom.isBufferGeometry) {
            throw new Error("MeshToBrep requires a THREE.BufferGeometry or THREE.Mesh");
        }

        this.faceDeflectionAngle = Number(faceDeflectionAngle) || 0;
        this.weldTolerance = Number(weldTolerance) || 0;

        // Build internal mesh arrays and face labels
        this._buildFromGeometry(geom);
    }

    toBrep() { return this; }

    _buildFromGeometry(geometry) {
        // Ensure we have positions
        const posAttr = geometry.getAttribute('position');
        if (!posAttr) throw new Error("Geometry has no 'position' attribute");

        const idxAttr = geometry.getIndex();
        const norAttr = geometry.getAttribute('normal');

        // Accessor helpers
        const getPos = (i, out) => {
            out.x = posAttr.getX(i);
            out.y = posAttr.getY(i);
            out.z = posAttr.getZ(i);
            return out;
        };
        const getTri = (t) => {
            if (idxAttr) {
                const i0 = idxAttr.getX(3 * t + 0) >>> 0;
                const i1 = idxAttr.getX(3 * t + 1) >>> 0;
                const i2 = idxAttr.getX(3 * t + 2) >>> 0;
                return [i0, i1, i2];
            } else {
                const base = 3 * t;
                return [base + 0, base + 1, base + 2];
            }
        };

        const triCount = idxAttr ? ((idxAttr.count / 3) | 0) : ((posAttr.count / 3) | 0);
        if (triCount <= 0) return;

        // Build canonical vertices using a weld grid so that shared edges truly share indices
        const q = Math.max(0, this.weldTolerance) || 0;
        const gridKey = (x, y, z) => {
            if (q <= 0) return `${x},${y},${z}`; // exact
            const rx = Math.round(x / q);
            const ry = Math.round(y / q);
            const rz = Math.round(z / q);
            return `${rx},${ry},${rz}`;
        };
        const gridToPos = (x, y, z) => {
            if (q <= 0) return [x, y, z];
            // Snap back to grid center
            return [Math.round(x / q) * q, Math.round(y / q) * q, Math.round(z / q) * q];
        };

        const tmpV = new THREE.Vector3();
        const tmpA = new THREE.Vector3();
        const tmpB = new THREE.Vector3();
        const tmpC = new THREE.Vector3();

        // Vertex dictionary and arrays
        const keyToIndex = new Map();
        const indexToPos = []; // [ [x,y,z], ... ] matching canonical vertices

        // Triangle data arrays
        const triVerts = new Array(triCount);
        const triNormals = new Array(triCount);

        // Grab per-vertex normals if available (STL facet normals replicated per-vertex)
        const getTriNormal = (t) => {
            if (norAttr && norAttr.count === posAttr.count) {
                const [i0] = getTri(t);
                // normals are constant per tri for STL; use any vertex's normal
                const nx = norAttr.getX(i0);
                const ny = norAttr.getY(i0);
                const nz = norAttr.getZ(i0);
                const n = new THREE.Vector3(nx, ny, nz);
                if (n.lengthSq() > 0) return n.normalize();
            }
            // Fallback: compute from positions
            const [a, b, c] = getTri(t);
            getPos(a, tmpA); getPos(b, tmpB); getPos(c, tmpC);
            tmpB.sub(tmpA); tmpC.sub(tmpA);
            const n = tmpB.clone().cross(tmpC);
            if (n.lengthSq() > 0) return n.normalize();
            return new THREE.Vector3(0, 0, 1);
        };

        // Build canonical vertices and triangle index triplets
        for (let t = 0; t < triCount; t++) {
            const [ia, ib, ic] = getTri(t);
            const a = getPos(ia, tmpA.clone());
            const b = getPos(ib, tmpB.clone());
            const c = getPos(ic, tmpC.clone());

            const keyA = gridKey(a.x, a.y, a.z);
            const keyB = gridKey(b.x, b.y, b.z);
            const keyC = gridKey(c.x, c.y, c.z);

            let ai = keyToIndex.get(keyA);
            if (ai === undefined) {
                ai = indexToPos.length;
                keyToIndex.set(keyA, ai);
                const [xr, yr, zr] = (q <= 0) ? [a.x, a.y, a.z] : [Math.round(a.x / q) * q, Math.round(a.y / q) * q, Math.round(a.z / q) * q];
                indexToPos.push([xr, yr, zr]);
            }
            let bi = keyToIndex.get(keyB);
            if (bi === undefined) {
                bi = indexToPos.length;
                keyToIndex.set(keyB, bi);
                const [xr, yr, zr] = (q <= 0) ? [b.x, b.y, b.z] : [Math.round(b.x / q) * q, Math.round(b.y / q) * q, Math.round(b.z / q) * q];
                indexToPos.push([xr, yr, zr]);
            }
            let ci = keyToIndex.get(keyC);
            if (ci === undefined) {
                ci = indexToPos.length;
                keyToIndex.set(keyC, ci);
                const [xr, yr, zr] = (q <= 0) ? [c.x, c.y, c.z] : [Math.round(c.x / q) * q, Math.round(c.y / q) * q, Math.round(c.z / q) * q];
                indexToPos.push([xr, yr, zr]);
            }

            triVerts[t] = [ai, bi, ci];
            triNormals[t] = getTriNormal(t);
        }

        // Build adjacency via undirected edge -> list of triangle indices
        const ek = (u, v) => (u < v ? `${u},${v}` : `${v},${u}`);
        const edgeToTris = new Map();
        for (let t = 0; t < triCount; t++) {
            const [a, b, c] = triVerts[t];
            const edges = [[a, b], [b, c], [c, a]];
            for (const [u, v] of edges) {
                const key = ek(u, v);
                let list = edgeToTris.get(key);
                if (!list) { list = []; edgeToTris.set(key, list); }
                list.push(t);
            }
        }

        // Convert to per-triangle neighbor lists
        const neighbors = new Array(triCount);
        for (let i = 0; i < triCount; i++) neighbors[i] = [];
        for (const list of edgeToTris.values()) {
            if (list.length < 2) continue;
            // each pair of triangles sharing this edge are neighbors
            for (let i = 0; i < list.length; i++) {
                for (let j = i + 1; j < list.length; j++) {
                    const a = list[i], b = list[j];
                    neighbors[a].push(b);
                    neighbors[b].push(a);
                }
            }
        }

        // Region grow faces by deflection angle between neighboring triangle normals
        const maxAngleRad = Math.max(0, this.faceDeflectionAngle) * Math.PI / 180.0;
        const cosThresh = Math.cos(maxAngleRad);
        const visited = new Uint8Array(triCount);
        let faceCounter = 0;
        const triFaceName = new Array(triCount);

        const dot = (a, b) => {
            const d = a.x * b.x + a.y * b.y + a.z * b.z;
            const la = Math.hypot(a.x, a.y, a.z);
            const lb = Math.hypot(b.x, b.y, b.z);
            if (la === 0 || lb === 0) return 1; // treat degenerate as same
            return d / (la * lb);
        };

        for (let seed = 0; seed < triCount; seed++) {
            if (visited[seed]) continue;
            const faceName = `STL_FACE_${++faceCounter}`;
            // BFS using pairwise deflection with the parent triangle
            const queue = [seed];
            visited[seed] = 1;
            triFaceName[seed] = faceName;
            while (queue.length) {
                const t = queue.shift();
                const nrmT = triNormals[t];
                for (const nb of neighbors[t]) {
                    if (visited[nb]) continue;
                    const nrmN = triNormals[nb];
                    // If normals are close (angle <= threshold), grow region
                    if (dot(nrmT, nrmN) >= cosThresh) {
                        visited[nb] = 1;
                        triFaceName[nb] = faceName;
                        queue.push(nb);
                    }
                }
            }
        }

        // Author triangles into this Solid with their face labels
        for (let t = 0; t < triCount; t++) {
            const name = triFaceName[t] || `STL_FACE_${faceCounter + 1}`;
            const [a, b, c] = triVerts[t];
            const pa = indexToPos[a];
            const pb = indexToPos[b];
            const pc = indexToPos[c];
            this.addTriangle(name, pa, pb, pc);
        }

        // Let downstream visualization build per-face meshes and edges
        // We'll leave winding correction/orientation to _manifoldize()
    }
}
