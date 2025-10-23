import { Manifold, ManifoldMesh, debugMode } from "../SolidShared.js";

/**
 * Manifold lifecycle helpers: rebuild, welding, orientation fixes.
 */

/**
 * Build (or rebuild) the Manifold from our MeshGL arrays.
 * Uses faceID per triangle so face names survive CSG operations.
 */
export function _manifoldize() {
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
                    const triCountInfo = (this._triVerts?.length || 0) / 3 | 0;
                    const vertCountInfo = (this._vertProperties?.length || 0) / 3 | 0;
                    const faces = [];
                    try {
                        if (this.edgeToFillet && Array.isArray(this.edgeToFillet.faces)) {
                            for (const f of this.edgeToFillet.faces) if (f && f.name) faces.push(f.name);
                        }
                    } catch { }
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
                            vertices: vertCountInfo,
                            triangles: triCountInfo,
                            faceLabels: (this._faceNameToID && typeof this._faceNameToID.size === 'number') ? this._faceNameToID.size : undefined,
                        },
                    };
                    try { console.error(JSON.stringify(failure)); } catch { console.error('[FilletSolidManifoldFailure]', failure.message); }
                }
            } catch { }
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
 * Set vertex weld epsilon and optionally weld existing vertices and
 * remove degenerate triangles. Epsilon <= 0 disables welding.
 */
export function setEpsilon(epsilon = 0) {
    this._epsilon = Number(epsilon) || 0;
    if (this._epsilon > 0) {
        this._weldVerticesByEpsilon(this._epsilon);
    }
    // After adjusting vertices, attempt to correct triangle winding.
    this.fixTriangleWindingsByAdjacency();
    return this;
}

export function _weldVerticesByEpsilon(eps) {
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
    const area2Thresh = 0; // strict degenerate check
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
    this._vertKeyToIndex = new Map();
    for (let i = 0; i < this._vertProperties.length; i += 3) {
        const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
        this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
    }
    this._dirty = true;
    this._faceIndex = null;
}

/**
 * Ensures all triangles have consistent winding by making sure
 * shared edges are oriented oppositely between adjacent triangles.
 */
export function fixTriangleWindingsByAdjacency() {
    if (this._isCoherentlyOrientedManifold()) return;
    const triCount = (this._triVerts.length / 3) | 0;
    if (triCount === 0) return;

    const tris = new Array(triCount);
    for (let t = 0; t < triCount; t++) {
        const base = t * 3;
        tris[t] = [
            this._triVerts[base + 0],
            this._triVerts[base + 1],
            this._triVerts[base + 2],
        ];
    }

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
export function _isCoherentlyOrientedManifold() {
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

export function invertNormals() {
    for (let t = 0; t < this._triVerts.length; t += 3) {
        const tmp = this._triVerts[t + 1];
        this._triVerts[t + 1] = this._triVerts[t + 2];
        this._triVerts[t + 2] = tmp;
    }

    this._dirty = true;
    this._faceIndex = null;
    this._manifoldize();
    return this;
}

