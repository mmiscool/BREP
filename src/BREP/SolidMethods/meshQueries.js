/**
 * Mesh queries and face utilities.
 */

/** Return the underlying MeshGL (fresh from Manifold so it reflects any CSG). */
export function getMesh() {
    return this._manifoldize().getMesh();
}

/** Build a cache: faceID -> array of triangle indices. */
export function _ensureFaceIndex() {
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
    try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { }
}

/**
 * Get all triangles belonging to a face by name.
 * Returns objects with positions; also includes vertex indices.
 */
export function getFace(name) {
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
    try { return out; } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { } }
}

/**
 * Enumerate faces with their triangles in one pass.
 */
export function getFaces(includeEmpty = false) {
    this._ensureFaceIndex();
    const mesh = this.getMesh();
    const { vertProperties, triVerts } = mesh;

    const out = [];
    const nameToTris = new Map();
    if (includeEmpty) {
        for (const fname of this.getFaceNames()) nameToTris.set(fname, []);
    }

    for (const [id, triList] of this._faceIndex.entries()) {
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
 * Compute connected polylines for boundary edges between pairs of face labels.
 */
export function getBoundaryEdgePolylines() {
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

        const e2t = new Map(); // key -> [{id, a, b, tri}...]
        for (let t = 0; t < triCount; t++) {
            const id = faceID ? faceID[t] : undefined;
            const base = t * 3;
            const i0 = triVerts[base + 0], i1 = triVerts[base + 1], i2 = triVerts[base + 2];
            const edges = [[i0, i1], [i1, i2], [i2, i0]];
            for (let k = 0; k < 3; k++) {
                const a = edges[k][0], b = edges[k][1];
                const key = ukey(a, b);
                let arr = e2t.get(key);
                if (!arr) { arr = []; e2t.set(key, arr); }
                arr.push({ id, a, b, tri: t });
            }
        }

        const pairToEdges = new Map(); // pairKey(JSON '[nameA,nameB]') -> array of [u,v]
        for (const [, arr] of e2t.entries()) {
            if (arr.length !== 2) continue;
            const a = arr[0], b = arr[1];
            if (a.id === b.id) continue;
            const nameA = this._idToFaceName.get(a.id) || `FACE_${a.id}`;
            const nameB = this._idToFaceName.get(b.id) || `FACE_${b.id}`;
            const pair = nameA < nameB ? [nameA, nameB] : [nameB, nameA];
            const pairKey = JSON.stringify(pair);
            let list = pairToEdges.get(pairKey);
            if (!list) { list = []; pairToEdges.set(pairKey, list); }
            const v0 = Math.min(a.a, a.b);
            const v1 = Math.max(a.a, a.b);
            list.push([v0, v1]);
        }

        const polylines = [];
        for (const [pairKey, edges] of pairToEdges.entries()) {
            const adj = new Map(); // v -> Set(neighbors)
            const edgeVisited = new Set(); // `${min},${max}`
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

            for (const [v, nbrs] of adj.entries()) {
                if ((nbrs.size | 0) === 1) {
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
                const start = chain[0];
                const last = chain[chain.length - 1];
                const nbrsLast = adj.get(last) || new Set();
                if (nbrsLast.has(start)) {
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
    } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { } }
}

