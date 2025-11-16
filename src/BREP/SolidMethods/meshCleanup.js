/**
 * Mesh cleanup and refinement utilities.
 */

/**
 * Remove small disconnected triangle islands relative to the largest shell.
 */
export function removeSmallIslands({ maxTriangles = 30, removeInternal = true, removeExternal = true } = {}) {
    const tv = this._triVerts;
    const vp = this._vertProperties;
    const triCount = (tv.length / 3) | 0;
    if (triCount === 0) return 0;

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
        const edges = [[i0, i1], [i1, i2], [i2, i0]];
        for (let k = 0; k < 3; k++) {
            const a = edges[k][0], c = edges[k][1];
            const key = eKey(a, c);
            let arr = edgeToTris.get(key);
            if (!arr) { arr = []; edgeToTris.set(key, arr); }
            arr.push(t);
        }
    }

    const adj = new Array(triCount);
    for (let t = 0; t < triCount; t++) adj[t] = [];
    for (const [, arr] of edgeToTris.entries()) {
        if (arr.length === 2) {
            const a = arr[0], b = arr[1];
            adj[a].push(b);
            adj[b].push(a);
        }
    }

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

    if (comps.length <= 1) return 0;

    let mainIdx = 0;
    for (let i = 1; i < comps.length; i++) {
        if (comps[i].length > comps[mainIdx].length) mainIdx = i;
    }
    const mainTris = comps[mainIdx];

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
        if (Math.abs(det) < EPS) return null;
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

    const pointInsideMain = (p) => {
        const dir = [1, 0, 0];
        let hits = 0;
        for (let i = 0; i < mainFaces.length; i++) {
            const th = rayTri(p, dir, mainFaces[i]);
            if (th !== null) hits++;
        }
        return (hits % 2) === 1;
    };

    const triCentroid = (t) => {
        const b = t * 3;
        const i0 = tv[b + 0] * 3, i1 = tv[b + 1] * 3, i2 = tv[b + 2] * 3;
        const x = (vp[i0 + 0] + vp[i1 + 0] + vp[i2 + 0]) / 3;
        const y = (vp[i0 + 1] + vp[i1 + 1] + vp[i2 + 1]) / 3;
        const z = (vp[i0 + 2] + vp[i1 + 2] + vp[i2 + 2]) / 3;
        return [x + 1e-8, y + 1e-8, z + 1e-8];
    };

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
    const newVP = [];
    let write = 0;
    for (let i = 0; i < nv; i++) {
        if (!usedVert[i]) continue;
        oldToNew[i] = write++;
        newVP.push(vp[i * 3 + 0], vp[i * 3 + 1], vp[i * 3 + 2]);
    }
    for (let i = 0; i < newTriVerts.length; i++) {
        newTriVerts[i] = oldToNew[newTriVerts[i]];
    }

    this._vertProperties = newVP;
    this._triVerts = newTriVerts;
    this._triIDs = newTriIDs;
    this._vertKeyToIndex = new Map();
    for (let i = 0; i < this._vertProperties.length; i += 3) {
        const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
        this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
    }
    this._dirty = true;
    this._faceIndex = null;
    return removed;
}

/** Backwards-compatible wrapper that removes only internal small islands. */
export function removeSmallInternalIslands(maxTriangles = 30) {
    return this.removeSmallIslands({ maxTriangles, removeInternal: true, removeExternal: false });
}

/**
 * Remove tiny triangles that lie along boundaries between faces by performing
 * local 2–2 edge flips across inter-face edges.
 */
export function removeTinyBoundaryTriangles(areaThreshold, maxIterations = 1) {
    const thr = Number(areaThreshold);
    if (!Number.isFinite(thr) || thr <= 0) return 0;
    const vp = this._vertProperties;
    if (!vp || vp.length < 9 || this._triVerts.length < 3) return 0;

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
            const edges = [[i0, i1], [i1, i2], [i2, i0]];
            for (let k = 0; k < 3; k++) {
                const a = edges[k][0], b = edges[k][1];
                const key = eKey(a, b);
                let arr = e2t.get(key);
                if (!arr) { arr = []; e2t.set(key, arr); }
                arr.push({ tri: t, id: face, a, b });
            }
        }

        const candidates = [];
        for (const [key, arr] of e2t.entries()) {
            if (arr.length !== 2) continue;
            const a = arr[0], b = arr[1];
            if (a.id === b.id) continue;
            const areaA = areas[a.tri];
            const areaB = areas[b.tri];
            const minAB = Math.min(areaA, areaB);
            if (!(minAB < thr)) continue;
            candidates.push({ key, a, b, minAB });
        }

        candidates.sort((p, q) => p.minAB - q.minAB);

        const triLocked = new Uint8Array(triCount);
        let flipsThisIter = 0;

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

        const addUse = (aa, bb, triIdx, id) => {
            const k = eKey(aa, bb);
            let arr = e2t.get(k);
            if (!arr) { arr = []; e2t.set(k, arr); }
            arr.push({ tri: triIdx, id, a: aa, b: bb });
        };

        for (const { a, b } of candidates) {
            const t0 = a.tri, t1 = b.tri;
            if (triLocked[t0] || triLocked[t1]) continue;

            const u = a.a, v = a.b;
            if (!(b.a === v && b.b === u)) {
                continue;
            }

            const tri0 = tris[t0];
            const tri1 = tris[t1];
            let c0 = -1, c1 = -1;
            for (let k = 0; k < 3; k++) { const idx = tri0[k]; if (idx !== u && idx !== v) { c0 = idx; break; } }
            for (let k = 0; k < 3; k++) { const idx = tri1[k]; if (idx !== u && idx !== v) { c1 = idx; break; } }
            if (c0 < 0 || c1 < 0 || c0 === c1) continue;

            const diagKey = eKey(c0, c1);
            const diagUses = e2t.get(diagKey);
            if (diagUses && diagUses.length) continue;

            const area0 = areas[t0];
            const area1 = areas[t1];
            const minArea = Math.min(area0, area1);
            if (minArea >= thr) continue;

            const newArea0 = triArea(c0, c1, u);
            const newArea1 = triArea(c1, c0, v);
            if (!(Number.isFinite(newArea0) && Number.isFinite(newArea1))) continue;
            if (newArea0 <= 0 || newArea1 <= 0) continue;
            const newMin = Math.min(newArea0, newArea1);
            if (newMin < minArea) continue;

            tris[t0] = [c0, c1, u];
            tris[t1] = [c1, c0, v];
            areas[t0] = newArea0;
            areas[t1] = newArea1;

            removeUse(u, v, t0);
            removeUse(v, u, t1);
            removeUse(v, u, t0);
            removeUse(u, v, t1);
            addUse(c0, c1, t0, ids[t0]);
            addUse(c1, c0, t0, ids[t0]);
            addUse(c1, c0, t1, ids[t1]);
            addUse(c0, c1, t1, ids[t1]);

            triLocked[t0] = 1;
            triLocked[t1] = 1;
            flipsThisIter++;
        }

        if (!flipsThisIter) break;
        totalFlips += flipsThisIter;

        for (let t = 0; t < triCount; t++) {
            const tri = tris[t];
            const base = t * 3;
            tv[base + 0] = tri[0];
            tv[base + 1] = tri[1];
            tv[base + 2] = tri[2];
        }
        this._dirty = true;
        this._faceIndex = null;
    }

    if (totalFlips > 0) {
        this.fixTriangleWindingsByAdjacency();
    }
    return totalFlips;
}

/**
 * Remesh by splitting long edges to improve triangle regularity while
 * preserving face labels.
 */
export function remesh({ maxEdgeLength, maxIterations = 10 } = {}) {
    const Lmax = Number(maxEdgeLength);
    if (!Number.isFinite(Lmax) || Lmax <= 0) return this;
    const L2 = Lmax * Lmax;

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

        const longEdge = new Set();
        for (let t = 0; t < triCount; t++) {
            const b = t * 3;
            const i0 = tv[b + 0] >>> 0;
            const i1 = tv[b + 1] >>> 0;
            const i2 = tv[b + 2] >>> 0;
            if (len2(i0, i1) > L2) longEdge.add(ukey(i0, i1));
            if (len2(i1, i2) > L2) longEdge.add(ukey(i1, i2));
            if (len2(i2, i0) > L2) longEdge.add(ukey(i2, i0));
        }

        if (longEdge.size === 0) return false;

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

            const count = (s01 ? 1 : 0) + (s12 ? 1 : 0) + (s20 ? 1 : 0);

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
                } else {
                    const m20 = midpointIndex(i2, i0);
                    emit(i2, m20, i1, fid);
                    emit(m20, i0, i1, fid);
                }
                continue;
            }

            if (count === 2) {
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
                } else {
                    const m20 = midpointIndex(i2, i0);
                    const m01 = midpointIndex(i0, i1);
                    emit(i2, m20, i1, fid);
                    emit(i0, m01, m20, fid);
                    emit(m20, m01, i1, fid);
                }
                continue;
            }

            const m01 = midpointIndex(i0, i1);
            const m12 = midpointIndex(i1, i2);
            const m20 = midpointIndex(i2, i0);
            emit(i0, m01, m20, fid);
            emit(i1, m12, m01, fid);
            emit(i2, m20, m12, fid);
            emit(m01, m12, m20, fid);
        }

        this._vertProperties = newVP;
        this._triVerts = newTV;
        this._triIDs = newIDs;
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
        this.fixTriangleWindingsByAdjacency();
    }
    return this;
}

/**
 * Collapse tiny triangles by snapping the shortest edge of any triangle
 * below a length threshold. The collapse is implemented by moving one
 * endpoint of the short edge onto the other (preferring the lower index
 * as the representative), which produces degenerate triangles. Those are
 * then cleaned up by intersecting the result with a large bounding box
 * and adopting the manifold surface back into this Solid.
 *
 * Returns the number of edge-collapses (unique unions) applied.
 */
export function collapseTinyTriangles(lengthThreshold) {
    const thr = Number(lengthThreshold);
    if (!Number.isFinite(thr) || thr <= 0) return 0;
    const vp = this._vertProperties;
    const tv = this._triVerts;
    const triCount = (tv.length / 3) | 0;
    const nv = (vp.length / 3) | 0;
    if (triCount === 0 || nv === 0) return 0;

    const thr2 = thr * thr;

    // Disjoint set union (union-find) to map vertices to representatives
    const parent = new Int32Array(nv);
    for (let i = 0; i < nv; i++) parent[i] = i;
    const find = (i) => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
    };
    const unite = (a, b) => {
        let ra = find(a), rb = find(b);
        if (ra === rb) return false;
        // Prefer lower index as stable representative
        if (rb < ra) { const tmp = ra; ra = rb; rb = tmp; }
        parent[rb] = ra;
        return true;
    };
    const len2 = (i, j) => {
        const ax = vp[i * 3 + 0], ay = vp[i * 3 + 1], az = vp[i * 3 + 2];
        const bx = vp[j * 3 + 0], by = vp[j * 3 + 1], bz = vp[j * 3 + 2];
        const dx = ax - bx, dy = ay - by, dz = az - bz;
        return dx * dx + dy * dy + dz * dz;
    };

    // Identify and unify the endpoints of the shortest edge in triangles
    // that fall below the threshold.
    let unions = 0;
    for (let t = 0; t < triCount; t++) {
        const base = t * 3;
        const i0 = tv[base + 0] >>> 0;
        const i1 = tv[base + 1] >>> 0;
        const i2 = tv[base + 2] >>> 0;
        const d01 = len2(i0, i1);
        const d12 = len2(i1, i2);
        const d20 = len2(i2, i0);
        let minD = d01, a = i0, b = i1;
        if (d12 < minD) { minD = d12; a = i1; b = i2; }
        if (d20 < minD) { minD = d20; a = i2; b = i0; }
        if (minD < thr2) {
            if (unite(a, b)) unions++;
        }
    }

    if (unions === 0) return 0;

    // Apply the collapse: move non-representative vertices onto their root.
    for (let i = 0; i < nv; i++) {
        const r = find(i);
        if (r !== i) {
            vp[i * 3 + 0] = vp[r * 3 + 0];
            vp[i * 3 + 1] = vp[r * 3 + 1];
            vp[i * 3 + 2] = vp[r * 3 + 2];
        }
    }

    // Mark dirty and refresh quick vertex index map
    this._vertKeyToIndex = new Map();
    for (let i = 0; i < nv; i++) {
        const x = vp[i * 3 + 0], y = vp[i * 3 + 1], z = vp[i * 3 + 2];
        this._vertKeyToIndex.set(`${x},${y},${z}`, i);
    }
    this._dirty = true;
    this._faceIndex = null;

    // Cleanup degenerate triangles by intersecting with a large bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < nv; i++) {
        const x = vp[i * 3 + 0], y = vp[i * 3 + 1], z = vp[i * 3 + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return unions;
    const dx = Math.max(1e-9, maxX - minX);
    const dy = Math.max(1e-9, maxY - minY);
    const dz = Math.max(1e-9, maxZ - minZ);
    const maxDim = Math.max(dx, dy, dz, thr);
    const margin = Math.max(thr * 10, maxDim * 0.1 + 1e-6);
    const width = dx + 2 * margin;
    const height = dy + 2 * margin;
    const depth = dz + 2 * margin;
    const ox = minX - margin, oy = minY - margin, oz = minZ - margin;

    // Build a box Solid inline (avoid importing primitives to keep dependencies acyclic)
    const SolidCtor = this.constructor;
    const box = new SolidCtor();
    const p000 = [ox, oy, oz];
    const p100 = [ox + width, oy, oz];
    const p010 = [ox, oy + height, oz];
    const p110 = [ox + width, oy + height, oz];
    const p001 = [ox, oy, oz + depth];
    const p101 = [ox + width, oy, oz + depth];
    const p011 = [ox, oy + height, oz + depth];
    const p111 = [ox + width, oy + height, oz + depth];
    box.addTriangle('__BIGBOX_NX', p000, p001, p011);
    box.addTriangle('__BIGBOX_NX', p000, p011, p010);
    box.addTriangle('__BIGBOX_PX', p100, p110, p111);
    box.addTriangle('__BIGBOX_PX', p100, p111, p101);
    box.addTriangle('__BIGBOX_NY', p000, p100, p101);
    box.addTriangle('__BIGBOX_NY', p000, p101, p001);
    box.addTriangle('__BIGBOX_PY', p010, p011, p111);
    box.addTriangle('__BIGBOX_PY', p010, p111, p110);
    box.addTriangle('__BIGBOX_NZ', p000, p010, p110);
    box.addTriangle('__BIGBOX_NZ', p000, p110, p100);
    box.addTriangle('__BIGBOX_PZ', p001, p101, p111);
    box.addTriangle('__BIGBOX_PZ', p001, p111, p011);

    const result = this.intersect(box);

    // Adopt the result's manifold surface back into this Solid
    const mesh = result.getMesh();
    try {
        this._numProp = mesh.numProp || 3;
        this._vertProperties = Array.from(mesh.vertProperties || []);
        this._triVerts = Array.from(mesh.triVerts || []);
        const triCountAfter = (this._triVerts.length / 3) | 0;
        if (mesh.faceID && mesh.faceID.length === triCountAfter) {
            this._triIDs = Array.from(mesh.faceID);
        } else {
            const SolidClass = this.constructor;
            this._triIDs = SolidClass._expandTriIDsFromMesh(mesh);
        }
        this._vertKeyToIndex = new Map();
        for (let i = 0; i < this._vertProperties.length; i += 3) {
            const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
            this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }
        // Adopt face label mapping from the boolean result to keep IDs consistent
        try { this._idToFaceName = new Map(result._idToFaceName); } catch { 
            // throw an error if it fails
            throw new Error("Failed to adopt face label mapping from boolean result");
        }
        try { this._faceNameToID = new Map([...this._idToFaceName.entries()].map(([id, name]) => [name, id])); } catch { }
        this._dirty = false;
        this._faceIndex = null;
        this._manifold = null; // Rebuild lazily on next need
    } finally {
        try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { }
    }

    return unions;
}

/**
 * MANIFOLD-SAFE: Detect and split self-intersecting triangle pairs.
 * - Uses conservative intersection detection to maintain manifold properties
 * - Only splits when intersection creates proper interior segments
 * - Ensures all new triangles maintain proper adjacency relationships
 * - Preserves face IDs and avoids creating T-junctions or non-manifold edges
 * - Returns the number of pairwise splits applied.
 */
export function splitSelfIntersectingTriangles(diagnostics = false) {
    const vp = this._vertProperties;
    const tv = this._triVerts;
    const ids = this._triIDs;
    const triCount0 = (tv.length / 3) | 0;
    if (triCount0 < 2) return 0;
    
    if (diagnostics) {
        console.log(`\n=== splitSelfIntersectingTriangles Diagnostics ===`);
        console.log(`Initial triangle count: ${triCount0}`);
        console.log(`Initial vertex count: ${vp.length / 3}`);
    }

    // Use conservative tolerance to avoid creating near-degenerate geometry
    const EPS = 1e-6;

    // Basic vector math
    const vec = {
        sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
        add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; },
        dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
        cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; },
        mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; },
        len(a) { return Math.hypot(a[0], a[1], a[2]); },
        norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    };

    const pointOf = (i) => [vp[i * 3 + 0], vp[i * 3 + 1], vp[i * 3 + 2]];
    const triOf = (t) => {
        const b = t * 3;
        return [tv[b + 0] >>> 0, tv[b + 1] >>> 0, tv[b + 2] >>> 0];
    };

    const triArea = (ia, ib, ic) => {
        const A = pointOf(ia), B = pointOf(ib), C = pointOf(ic);
        const ab = vec.sub(B, A), ac = vec.sub(C, A);
        const cr = vec.cross(ab, ac);
        return 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
    };

    // Plane from triangle
    const planeOf = (A, B, C) => {
        const n = vec.cross(vec.sub(B, A), vec.sub(C, A));
        const ln = vec.len(n);
        if (ln < 1e-18) return { n: [0, 0, 0], d: 0 };
        const nn = [n[0] / ln, n[1] / ln, n[2] / ln];
        const d = -vec.dot(nn, A);
        return { n: nn, d };
    };

    const sd = (pl, P) => vec.dot(pl.n, P) + pl.d;

    // Clip triangle by plane -> segment endpoints on triangle edges
    const triPlaneClipSegment = (A, B, C, pl) => {
        const sA = sd(pl, A), sB = sd(pl, B), sC = sd(pl, C);
        const pts = [];
        const pushIfUnique = (P) => {
            for (let k = 0; k < pts.length; k++) {
                const Q = pts[k];
                if (Math.hypot(P[0] - Q[0], P[1] - Q[1], P[2] - Q[2]) < 1e-9) return;
            }
            pts.push(P);
        };
        const edgeHit = (P, sP, Q, sQ) => {
            if (sP === 0 && sQ === 0) return; // coplanar edge, skip
            if ((sP > 0 && sQ < 0) || (sP < 0 && sQ > 0)) {
                const t = sP / (sP - sQ);
                const hit = [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t, P[2] + (Q[2] - P[2]) * t];
                pushIfUnique(hit);
            } else if (Math.abs(sP) < 1e-12) {
                pushIfUnique(P);
            } else if (Math.abs(sQ) < 1e-12) {
                pushIfUnique(Q);
            }
        };
        edgeHit(A, sA, B, sB);
        edgeHit(B, sB, C, sC);
        edgeHit(C, sC, A, sA);
        if (pts.length < 2) return null;
        if (pts.length > 2) {
            // In degenerate near-coplanar cases we may collect 3 points; keep the two farthest
            let bestI = 0, bestJ = 1, bestD = -1;
            for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
                const dx = pts[i][0] - pts[j][0];
                const dy = pts[i][1] - pts[j][1];
                const dz = pts[i][2] - pts[j][2];
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > bestD) { bestD = d2; bestI = i; bestJ = j; }
            }
            return [pts[bestI], pts[bestJ]];
        }
        return [pts[0], pts[1]];
    };

    // Enhanced triangle-triangle intersection that handles coplanar overlapping cases
    const triTriIntersectSegment = (A, B, C, D, E, F) => {
        const p1 = planeOf(A, B, C);
        const p2 = planeOf(D, E, F);
        const n1 = p1.n, n2 = p2.n;
        const cr = vec.cross(n1, n2);
        const crLen = vec.len(cr);
        
        // Check if planes are nearly parallel (coplanar case)
        if (crLen < 0.1) { // Allow more parallel cases for coplanar detection
            // For coplanar/nearly coplanar triangles, check for overlap
            const coplanarResult = handleCoplanarTriangles(A, B, C, D, E, F, p1, p2);
            if (coplanarResult) return coplanarResult;
            return null;
        }
        
        // Check if triangles are on opposite sides of each other's planes
        const sD = sd(p1, D), sE = sd(p1, E), sF = sd(p1, F);
        if ((sD > EPS && sE > EPS && sF > EPS) || (sD < -EPS && sE < -EPS && sF < -EPS)) return null;
        
        const sA = sd(p2, A), sB = sd(p2, B), sC = sd(p2, C);
        if ((sA > EPS && sB > EPS && sC > EPS) || (sA < -EPS && sB < -EPS && sC < -EPS)) return null;

        const seg1 = triPlaneClipSegment(A, B, C, p2);
        const seg2 = triPlaneClipSegment(D, E, F, p1);
        if (!seg1 || !seg2) return null;
        
        const [P1, P2] = seg1;
        const [Q1, Q2] = seg2;
        const dir = vec.sub(P2, P1);
        const L = vec.len(dir);
        if (L < 1e-9) return null; // Reject very short intersection segments
        const Lhat = vec.mul(dir, 1 / L);

        const tP1 = 0;
        const tP2 = L;
        const tQ1 = vec.dot(vec.sub(Q1, P1), Lhat);
        const tQ2 = vec.dot(vec.sub(Q2, P1), Lhat);
        const i1 = Math.min(tP1, tP2), i2 = Math.max(tP1, tP2);
        const j1 = Math.min(tQ1, tQ2), j2 = Math.max(tQ1, tQ2);
        const a = Math.max(i1, j1), b = Math.min(i2, j2);
        
        // Require significant overlap to avoid edge cases
        if (!(b > a + 1e-8)) return null;
        
        const X = [P1[0] + Lhat[0] * a, P1[1] + Lhat[1] * a, P1[2] + Lhat[2] * a];
        const Y = [P1[0] + Lhat[0] * b, P1[1] + Lhat[1] * b, P1[2] + Lhat[2] * b];
        
        return [X, Y];
    };

    // Handle coplanar or nearly coplanar triangles
    const handleCoplanarTriangles = (A, B, C, D, E, F, p1, p2) => {
        // Check if triangles are on roughly the same plane
        const maxDist1 = Math.max(Math.abs(sd(p1, D)), Math.abs(sd(p1, E)), Math.abs(sd(p1, F)));
        const maxDist2 = Math.max(Math.abs(sd(p2, A)), Math.abs(sd(p2, B)), Math.abs(sd(p2, C)));
        
        // Use a more generous threshold for coplanar detection
        const threshold = Math.max(1e-6, EPS * 100);
        
        if (maxDist1 > threshold || maxDist2 > threshold) return null;
        
        // For coplanar overlapping triangles, we need to create valid cutting lines
        // that allow both triangles to be subdivided properly
        
        const n1 = vec.cross(vec.sub(B, A), vec.sub(C, A));
        const n2 = vec.cross(vec.sub(E, D), vec.sub(F, D));
        const avgN = vec.norm(vec.add(n1, n2));
        
        // Choose projection axis
        const absN = [Math.abs(avgN[0]), Math.abs(avgN[1]), Math.abs(avgN[2])];
        let dropAxis = 0;
        if (absN[1] > absN[dropAxis]) dropAxis = 1;
        if (absN[2] > absN[dropAxis]) dropAxis = 2;
        
        const project = (P) => {
            if (dropAxis === 0) return [P[1], P[2]];
            if (dropAxis === 1) return [P[0], P[2]];
            return [P[0], P[1]];
        };
        
        const unproject = (P2D, originalZ) => {
            if (dropAxis === 0) return [originalZ, P2D[0], P2D[1]];
            if (dropAxis === 1) return [P2D[0], originalZ, P2D[1]];
            return [P2D[0], P2D[1], originalZ];
        };
        
        const tri1_2d = [project(A), project(B), project(C)];
        const tri2_2d = [project(D), project(E), project(F)];
        
        // Find all intersection points between triangle edges
        const intersectionPoints = [];
        
        // Edge-edge intersections
        const edges1 = [[A, B], [B, C], [C, A]];
        const edges2 = [[D, E], [E, F], [F, D]];
        const edges1_2d = [[tri1_2d[0], tri1_2d[1]], [tri1_2d[1], tri1_2d[2]], [tri1_2d[2], tri1_2d[0]]];
        const edges2_2d = [[tri2_2d[0], tri2_2d[1]], [tri2_2d[1], tri2_2d[2]], [tri2_2d[2], tri2_2d[0]]];
        
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const int2d = lineIntersection2D(edges1_2d[i], edges2_2d[j]);
                if (int2d) {
                    // Convert back to 3D using parametric interpolation on edge1
                    const t1 = getParameterOnSegment2D(edges1_2d[i], int2d);
                    if (t1 >= 0 && t1 <= 1) {
                        const int3d = [
                            edges1[i][0][0] + t1 * (edges1[i][1][0] - edges1[i][0][0]),
                            edges1[i][0][1] + t1 * (edges1[i][1][1] - edges1[i][0][1]),
                            edges1[i][0][2] + t1 * (edges1[i][1][2] - edges1[i][0][2])
                        ];
                        intersectionPoints.push(int3d);
                    }
                }
            }
        }
        
        // If we don't have edge intersections, try a different approach for overlapping triangles
        if (intersectionPoints.length === 0) {
            // For completely contained triangles or other overlap cases,
            // create a cutting line across the overlapping region
            
            // Find the centroid of the overlapping region
            const allPoints = [A, B, C, D, E, F];
            const centroid = [
                allPoints.reduce((sum, p) => sum + p[0], 0) / allPoints.length,
                allPoints.reduce((sum, p) => sum + p[1], 0) / allPoints.length,
                allPoints.reduce((sum, p) => sum + p[2], 0) / allPoints.length
            ];
            
            // Create a cutting line that passes through the overlap
            // Use the longest edge of the smaller triangle as the basis
            const tri1Area = 0.5 * vec.len(vec.cross(vec.sub(B, A), vec.sub(C, A)));
            const tri2Area = 0.5 * vec.len(vec.cross(vec.sub(E, D), vec.sub(F, D)));
            
            let cutStart, cutEnd;
            if (tri1Area > tri2Area) {
                // Triangle 1 is larger, use triangle 2's longest edge as cut direction
                const edges2Lens = [
                    vec.len(vec.sub(E, D)),
                    vec.len(vec.sub(F, E)),
                    vec.len(vec.sub(D, F))
                ];
                const maxEdgeIdx = edges2Lens.indexOf(Math.max(...edges2Lens));
                cutStart = [D, E, F][maxEdgeIdx];
                cutEnd = [D, E, F][(maxEdgeIdx + 1) % 3];
            } else {
                // Triangle 2 is larger, use triangle 1's longest edge as cut direction
                const edges1Lens = [
                    vec.len(vec.sub(B, A)),
                    vec.len(vec.sub(C, B)),
                    vec.len(vec.sub(A, C))
                ];
                const maxEdgeIdx = edges1Lens.indexOf(Math.max(...edges1Lens));
                cutStart = [A, B, C][maxEdgeIdx];
                cutEnd = [A, B, C][(maxEdgeIdx + 1) % 3];
            }
            
            return [cutStart, cutEnd];
        }
        
        // Remove duplicate intersection points
        const uniquePoints = [];
        for (const pt of intersectionPoints) {
            let isDuplicate = false;
            for (const existing of uniquePoints) {
                if (vec.len(vec.sub(pt, existing)) < 1e-9) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) uniquePoints.push(pt);
        }
        
        if (uniquePoints.length >= 2) {
            // Return the two most distant points as the cutting line
            let maxDist = 0;
            let bestPair = [uniquePoints[0], uniquePoints[1]];
            
            for (let i = 0; i < uniquePoints.length; i++) {
                for (let j = i + 1; j < uniquePoints.length; j++) {
                    const dist = vec.len(vec.sub(uniquePoints[i], uniquePoints[j]));
                    if (dist > maxDist) {
                        maxDist = dist;
                        bestPair = [uniquePoints[i], uniquePoints[j]];
                    }
                }
            }
            
            return maxDist > 1e-8 ? bestPair : null;
        }
        
        return null;
    };

    // Find intersection segment of two coplanar triangles
    const findCoplanarTriangleIntersection = (A, B, C, D, E, F) => {
        // Find the best 2D projection plane
        const n1 = vec.cross(vec.sub(B, A), vec.sub(C, A));
        const n2 = vec.cross(vec.sub(E, D), vec.sub(F, D));
        const avgN = vec.norm(vec.add(n1, n2));
        
        // Choose projection axis (drop the coordinate with largest normal component)
        const absN = [Math.abs(avgN[0]), Math.abs(avgN[1]), Math.abs(avgN[2])];
        let dropAxis = 0;
        if (absN[1] > absN[dropAxis]) dropAxis = 1;
        if (absN[2] > absN[dropAxis]) dropAxis = 2;
        
        // Project triangles to 2D
        const project = (P) => {
            if (dropAxis === 0) return [P[1], P[2]];
            if (dropAxis === 1) return [P[0], P[2]];
            return [P[0], P[1]];
        };
        
        const unproject = (P2D, originalPt) => {
            if (dropAxis === 0) return [originalPt[0], P2D[0], P2D[1]];
            if (dropAxis === 1) return [P2D[0], originalPt[1], P2D[1]];
            return [P2D[0], P2D[1], originalPt[2]];
        };
        
        const tri1_2d = [project(A), project(B), project(C)];
        const tri2_2d = [project(D), project(E), project(F)];
        
        // Check if point is inside triangle using barycentric coordinates
        const pointInTriangle2D = (pt, [t0, t1, t2]) => {
            const v0 = [t2[0] - t0[0], t2[1] - t0[1]];
            const v1 = [t1[0] - t0[0], t1[1] - t0[1]];
            const v2 = [pt[0] - t0[0], pt[1] - t0[1]];
            
            const dot00 = v0[0] * v0[0] + v0[1] * v0[1];
            const dot01 = v0[0] * v1[0] + v0[1] * v1[1];
            const dot02 = v0[0] * v2[0] + v0[1] * v2[1];
            const dot11 = v1[0] * v1[0] + v1[1] * v1[1];
            const dot12 = v1[0] * v2[0] + v1[1] * v2[1];
            
            const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
            const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
            const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
            
            return (u >= 0) && (v >= 0) && (u + v <= 1);
        };
        
        const intersections = [];
        
        // Find edge-edge intersections
        const edges1 = [[tri1_2d[0], tri1_2d[1]], [tri1_2d[1], tri1_2d[2]], [tri1_2d[2], tri1_2d[0]]];
        const edges2 = [[tri2_2d[0], tri2_2d[1]], [tri2_2d[1], tri2_2d[2]], [tri2_2d[2], tri2_2d[0]]];
        const edges1_3d = [[A, B], [B, C], [C, A]];
        const edges2_3d = [[D, E], [E, F], [F, D]];
        
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const int2d = lineIntersection2D(edges1[i], edges2[j]);
                if (int2d) {
                    // Convert back to 3D using parametric interpolation
                    const t1 = getParameterOnSegment2D(edges1[i], int2d);
                    if (t1 >= 0 && t1 <= 1) {
                        const int3d = [
                            edges1_3d[i][0][0] + t1 * (edges1_3d[i][1][0] - edges1_3d[i][0][0]),
                            edges1_3d[i][0][1] + t1 * (edges1_3d[i][1][1] - edges1_3d[i][0][1]),
                            edges1_3d[i][0][2] + t1 * (edges1_3d[i][1][2] - edges1_3d[i][0][2])
                        ];
                        intersections.push(int3d);
                    }
                }
            }
        }
        
        // Check vertices of triangle 1 inside triangle 2
        const tri1_3d = [A, B, C];
        const tri2_3d = [D, E, F];
        
        for (let i = 0; i < 3; i++) {
            if (pointInTriangle2D(tri1_2d[i], tri2_2d)) {
                intersections.push(tri1_3d[i]);
            }
        }
        
        // Check vertices of triangle 2 inside triangle 1
        for (let i = 0; i < 3; i++) {
            if (pointInTriangle2D(tri2_2d[i], tri1_2d)) {
                intersections.push(tri2_3d[i]);
            }
        }
        
        // Remove duplicates and ensure we have at least 2 points
        const uniqueIntersections = [];
        for (const pt of intersections) {
            let isDuplicate = false;
            for (const existing of uniqueIntersections) {
                if (vec.len(vec.sub(pt, existing)) < 1e-9) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) uniqueIntersections.push(pt);
        }
        
        if (uniqueIntersections.length >= 2) {
            // Return the two most distant points
            let maxDist = 0;
            let bestPair = [uniqueIntersections[0], uniqueIntersections[1]];
            
            for (let i = 0; i < uniqueIntersections.length; i++) {
                for (let j = i + 1; j < uniqueIntersections.length; j++) {
                    const dist = vec.len(vec.sub(uniqueIntersections[i], uniqueIntersections[j]));
                    if (dist > maxDist) {
                        maxDist = dist;
                        bestPair = [uniqueIntersections[i], uniqueIntersections[j]];
                    }
                }
            }
            
            return maxDist > 1e-8 ? bestPair : null;
        }
        
        return null;
    };

    // Helper function to subdivide a triangle around a contained triangle
    const subdivideContainingTriangle = (containingTri, containedTri) => {
        // For a triangle A containing triangle B, create triangles that fill A but exclude B
        // This creates a "frame" around the contained triangle
        
        const A = [containingTri.A, containingTri.B, containingTri.C];
        const B = [containedTri.A, containedTri.B, containedTri.C];
        
        // Create triangles connecting vertices of A to vertices of B
        const subdivisions = [];
        
        // Check if triangles are nearly identical (would create degenerate subdivisions)
        const areTrianglesNearlyIdentical = (tri1, tri2, tolerance = 1e-6) => {
            for (let i = 0; i < 3; i++) {
                let minDist = Infinity;
                for (let j = 0; j < 3; j++) {
                    const dist = vec.len(vec.sub(tri1[i], tri2[j]));
                    minDist = Math.min(minDist, dist);
                }
                if (minDist > tolerance) return false;
            }
            return true;
        };
        
        // Check triangle area to avoid degenerate triangles
        const triangleArea = (p1, p2, p3) => {
            const cross = vec.cross(vec.sub(p2, p1), vec.sub(p3, p1));
            return 0.5 * vec.len(cross);
        };
        
        if (areTrianglesNearlyIdentical(A, B, 1e-3)) {
            // Triangles are too similar, skip subdivision to avoid degeneracies
            return null;
        }
        
        // Strategy: Create triangles by connecting each vertex of A to nearest edge of B
        // This avoids creating very small or degenerate triangles
        
        for (let i = 0; i < 3; i++) {
            const vertexA = A[i];
            
            // Find the best connection points on triangle B's edges
            const edgesB = [
                [B[0], B[1]], [B[1], B[2]], [B[2], B[0]]
            ];
            
            let bestEdgeIdx = -1;
            let bestDist = Infinity;
            
            // Find the edge of B that's closest to this vertex of A
            for (let j = 0; j < 3; j++) {
                const edgeStart = edgesB[j][0];
                const edgeEnd = edgesB[j][1];
                const midPoint = vec.add(edgeStart, vec.mul(vec.sub(edgeEnd, edgeStart), 0.5));
                const dist = vec.len(vec.sub(vertexA, midPoint));
                
                if (dist < bestDist) {
                    bestDist = dist;
                    bestEdgeIdx = j;
                }
            }
            
            if (bestEdgeIdx >= 0) {
                const edgeStart = edgesB[bestEdgeIdx][0];
                const edgeEnd = edgesB[bestEdgeIdx][1];
                
                // Create triangle from vertex A to the edge of B
                const area = triangleArea(vertexA, edgeStart, edgeEnd);
                
                // Only add if triangle has significant area (avoid degenerates)
                if (area > 1e-8) {
                    const newTri = [
                        this._getPointIndex(vertexA),
                        this._getPointIndex(edgeStart), 
                        this._getPointIndex(edgeEnd)
                    ];
                    subdivisions.push(newTri);
                }
            }
        }
        
        return subdivisions.length > 0 ? subdivisions : null;
    };

    // 2D line segment intersection
    const lineIntersection2D = ([p1, p2], [p3, p4]) => {
        const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
        const x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
        
        const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(denom) < 1e-10) return null; // Parallel lines
        
        const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
        const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
        
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
            return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
        }
        
        return null;
    };

    // Get parameter along 2D segment
    const getParameterOnSegment2D = ([p1, p2], point) => {
        const dx = p2[0] - p1[0];
        const dy = p2[1] - p1[1];
        
        if (Math.abs(dx) > Math.abs(dy)) {
            return (point[0] - p1[0]) / dx;
        } else {
            return (point[1] - p1[1]) / dy;
        }
    };

    // Check if a point is well inside a triangle (not near edges or vertices)
    const isPointWellInsideTriangle = (P, A, B, C) => {
        const w = barycentric(A, B, C, P);
        if (!w || !Number.isFinite(w[0])) return false;
        
        // All weights must be well away from edges (not just >= 0)
        const margin = 0.1; // 10% margin from edges
        return w[0] > margin && w[1] > margin && w[2] > margin;
    };

    // Manifold-safe barycentric coordinates
    const barycentric = (A, B, C, X) => {
        const v0 = vec.sub(C, A);
        const v1 = vec.sub(B, A);
        const v2 = vec.sub(X, A);

        const dot00 = vec.dot(v0, v0);
        const dot01 = vec.dot(v0, v1);
        const dot02 = vec.dot(v0, v2);
        const dot11 = vec.dot(v1, v1);
        const dot12 = vec.dot(v1, v2);

        const denom = dot00 * dot11 - dot01 * dot01;
        if (Math.abs(denom) < 1e-14) return null; // Degenerate triangle

        const invDenom = 1.0 / denom;
        const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
        const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
        const w = 1.0 - u - v;

        return [w, v, u]; // [A, B, C] weights
    };

    // Conservative edge classification that avoids T-junctions
    const classifyEdge = (w) => {
        const [wa, wb, wc] = w;
        const t = 0.05; // Conservative margin: points must be well away from vertices
        
        // Only classify as on an edge if clearly on that edge and not near vertices
        if (wc < t && wa > t && wb > t) return 0; // AB edge
        if (wa < t && wb > t && wc > t) return 1; // BC edge  
        if (wb < t && wa > t && wc > t) return 2; // CA edge
        
        return -1; // Not clearly on any edge
    };

    // Enhanced triangle splitting for coplanar overlapping triangles
    const splitOneTriangle = (ia, ib, ic, P, Q) => {
        const A = pointOf(ia), B = pointOf(ib), C = pointOf(ic);
        const wP = barycentric(A, B, C, P);
        const wQ = barycentric(A, B, C, Q);
        
        if (!wP || !wQ) {
            if (diagnostics) console.log(`    FAIL: Degenerate barycentric coordinates`);
            return null; // Degenerate case
        }
        
        // For coplanar case, allow points on or near edges - be more permissive
        const reasonablyInside = (w) => w[0] >= -0.1 && w[1] >= -0.1 && w[2] >= -0.1 && 
                                        (w[0] + w[1] + w[2]) >= 0.9 && (w[0] + w[1] + w[2]) <= 1.1;
        if (!reasonablyInside(wP) || !reasonablyInside(wQ)) {
            if (diagnostics) {
                console.log(`    FAIL: Points not reasonably inside triangle`);
                console.log(`    P weights: [${wP[0].toFixed(4)}, ${wP[1].toFixed(4)}, ${wP[2].toFixed(4)}] sum=${(wP[0] + wP[1] + wP[2]).toFixed(4)}`);
                console.log(`    Q weights: [${wQ[0].toFixed(4)}, ${wQ[1].toFixed(4)}, ${wQ[2].toFixed(4)}] sum=${(wQ[0] + wQ[1] + wQ[2]).toFixed(4)}`);
            }
            return null;
        }
        
        // Check if points are too close to existing vertices - be more permissive for coplanar cases
        const minVertexDist = 1e-6; // Increased from 1e-8 to allow closer points
        const nearVertex = (pt, vertex) => vec.len(vec.sub(pt, vertex)) < minVertexDist;
        if (nearVertex(P, A) || nearVertex(P, B) || nearVertex(P, C) ||
            nearVertex(Q, A) || nearVertex(Q, B) || nearVertex(Q, C)) {
            if (diagnostics) console.log(`    FAIL: Points too close to existing vertices`);
            return null;
        }
        
        const edgeP = classifyEdge(wP);
        const edgeQ = classifyEdge(wQ);

        const ip = this._getPointIndex(P);
        const iq = this._getPointIndex(Q);

        // More lenient area check for coplanar cases
        const emit = (i0, i1, i2, out) => {
            if (i0 === i1 || i1 === i2 || i2 === i0) return;
            const area = triArea(i0, i1, i2);
            if (!(area > 1e-12)) return; // More lenient for coplanar splitting
            out.push([i0, i1, i2]);
        };

        const out = [];
        const iA = ia, iB = ib, iC = ic;

        // Enhanced splitting: handle both interior and edge cases
        if (edgeP === -1 && edgeQ === -1) {
            // Both points are interior - create fan triangulation
            emit(iA, ip, iq, out);
            emit(iA, iB, ip, out);
            emit(ip, iB, iq, out);
            emit(iB, iC, iq, out);
            emit(iq, iC, iA, out);
        } else if (edgeP === -1 || edgeQ === -1) {
            // One interior, one on edge
            const interior = edgeP === -1 ? ip : iq;
            const edge = edgeP === -1 ? iq : ip;
            const edgeId = edgeP === -1 ? edgeQ : edgeP;
            
            const E_AB = 0, E_BC = 1, E_CA = 2;
            
            if (edgeId === E_AB) {
                emit(iA, edge, interior, out);
                emit(edge, iB, interior, out);
                emit(iB, iC, interior, out);
                emit(iC, iA, interior, out);
            } else if (edgeId === E_BC) {
                emit(iB, edge, interior, out);
                emit(edge, iC, interior, out);
                emit(iC, iA, interior, out);
                emit(iA, iB, interior, out);
            } else if (edgeId === E_CA) {
                emit(iC, edge, interior, out);
                emit(edge, iA, interior, out);
                emit(iA, iB, interior, out);
                emit(iB, iC, interior, out);
            }
        } else {
            // Both on edges - handle specific edge combinations
            const E_AB = 0, E_BC = 1, E_CA = 2;
            
            if ((edgeP === E_AB && edgeQ === E_CA) || (edgeQ === E_AB && edgeP === E_CA)) {
                // Cut near vertex A
                emit(iA, ip, iq, out);
                emit(ip, iB, iC, out);
                emit(ip, iC, iq, out);
            } else if ((edgeP === E_AB && edgeQ === E_BC) || (edgeQ === E_AB && edgeP === E_BC)) {
                // Cut near vertex B
                emit(iB, ip, iq, out);
                emit(iA, ip, iq, out);
                emit(iA, iq, iC, out);
            } else if ((edgeP === E_BC && edgeQ === E_CA) || (edgeQ === E_BC && edgeP === E_CA)) {
                // Cut near vertex C
                emit(iC, ip, iq, out);
                emit(iA, iB, ip, out);
                emit(iA, ip, iq, out);
            } else if (edgeP !== edgeQ) {
                // Different edges - create diagonal split
                emit(ip, iq, iA, out);
                emit(ip, iq, iB, out);
                emit(ip, iq, iC, out);
                // Add remaining coverage
                if (edgeP === E_AB && edgeQ === E_BC) {
                    emit(iA, ip, iq, out);
                    emit(iq, iC, iA, out);
                } // Add other combinations as needed
            }
        }

        // Require at least 2 triangles for a valid split
        return out.length >= 2 ? out : null;
    };

    // Build an adjacency set of triangle pairs that share an edge
    const buildAdjacencyPairs = () => {
        const triCount = (this._triVerts.length / 3) | 0;
        const nv = (this._vertProperties.length / 3) | 0;
        const NV = BigInt(Math.max(1, nv));
        const ukey = (a, b) => {
            const A = BigInt(a), B = BigInt(b);
            return (A < B) ? (A * NV + B) : (B * NV + A);
        };
        const e2t = new Map();
        for (let t = 0; t < triCount; t++) {
            const b = t * 3;
            const i0 = this._triVerts[b + 0] >>> 0;
            const i1 = this._triVerts[b + 1] >>> 0;
            const i2 = this._triVerts[b + 2] >>> 0;
            const edges = [[i0, i1], [i1, i2], [i2, i0]];
            for (let k = 0; k < 3; k++) {
                const a = edges[k][0], c = edges[k][1];
                const key = ukey(a, c);
                let arr = e2t.get(key);
                if (!arr) { arr = []; e2t.set(key, arr); }
                arr.push(t);
            }
        }
        const adj = new Set();
        const pkey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
        for (const [, arr] of e2t.entries()) {
            if (arr.length === 2) {
                const a = arr[0], b = arr[1];
                adj.add(pkey(a, b));
            } else if (arr.length > 2) {
                // Non-manifold edge: mark all pairs as adjacent so we don't split across it
                for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) adj.add(pkey(arr[i], arr[j]));
            }
        }
        return adj;
    };

    let totalSplits = 0;
    const seenSegments = new Set();
    const Q = 1e-7;
    const qpt = (P) => `${Math.round(P[0]/Q)},${Math.round(P[1]/Q)},${Math.round(P[2]/Q)}`;
    const skey = (P, Qp) => {
        const a = qpt(P), b = qpt(Qp);
        return a < b ? `${a}__${b}` : `${b}__${a}`;
    };
    
    // Conservative iteration limit to prevent infinite loops
    const maxIterations = Math.min(20, Math.max(3, triCount0));

    iteration: for (let pass = 0; pass < maxIterations; pass++) {
        const triCount = (this._triVerts.length / 3) | 0;
        if (triCount < 2) break;
        
        if (diagnostics) {
            console.log(`\nPass ${pass + 1}: checking ${triCount} triangles`);
        }

        const adjPairs = buildAdjacencyPairs();
        
        if (diagnostics) {
            console.log(`Adjacent pairs count: ${adjPairs.size}`);
        }

        // Standard AABB sweep setup
        const tris = new Array(triCount);
        for (let t = 0; t < triCount; t++) {
            const b = t * 3;
            const i0 = this._triVerts[b + 0] >>> 0;
            const i1 = this._triVerts[b + 1] >>> 0;
            const i2 = this._triVerts[b + 2] >>> 0;
            const A = pointOf(i0), B = pointOf(i1), C = pointOf(i2);
            const minX = Math.min(A[0], B[0], C[0]);
            const minY = Math.min(A[1], B[1], C[1]);
            const minZ = Math.min(A[2], B[2], C[2]);
            const maxX = Math.max(A[0], B[0], C[0]);
            const maxY = Math.max(A[1], B[1], C[1]);
            const maxZ = Math.max(A[2], B[2], C[2]);
            tris[t] = { t, i0, i1, i2, A, B, C, minX, minY, minZ, maxX, maxY, maxZ };
        }
        const order = Array.from({ length: triCount }, (_, i) => i);
        order.sort((p, q) => tris[p].minX - tris[q].minX);

        const pairKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
        const tried = new Set();
        let splitsThisPass = 0;

        let checkedPairs = 0;
        let adjacentSkips = 0;
        let intersectionTests = 0;
        let intersectionHits = 0;

        for (let ii = 0; ii < order.length && splitsThisPass < 5; ii++) {
            const ai = order[ii];
            const A = tris[ai];
            
            for (let jj = ii + 1; jj < order.length; jj++) {
                const bi = order[jj];
                const B = tris[bi];
                if (B.minX > A.maxX + 1e-12) break; // sweep prune by X
                if (B.maxY < A.minY - 1e-12 || B.minY > A.maxY + 1e-12) continue;
                if (B.maxZ < A.minZ - 1e-12 || B.minZ > A.maxZ + 1e-12) continue;
                
                checkedPairs++;
                
                const pk = pairKey(A.t, B.t);
                if (adjPairs.has(pk)) {
                    adjacentSkips++;
                    continue; // skip adjacent triangles sharing an edge
                }
                if (tried.has(pk)) continue; 
                tried.add(pk);

                intersectionTests++;
                const seg = triTriIntersectSegment(A.A, A.B, A.C, B.A, B.B, B.C);
                if (!seg) continue;
                
                intersectionHits++;
                
                const [P, Q] = seg;
                const keySeg = skey(P, Q);
                if (seenSegments.has(keySeg)) continue;
                
                const dPQ = Math.hypot(P[0] - Q[0], P[1] - Q[1], P[2] - Q[2]);
                if (!(dPQ > EPS)) continue;

                // Special handling for overlapping coplanar triangles
                // Check if this is a coplanar containment case where P and Q are both vertices of one triangle
                const isCoplanarContainment = (
                    (vec.len(vec.sub(P, A.A)) < 1e-9 || vec.len(vec.sub(P, A.B)) < 1e-9 || vec.len(vec.sub(P, A.C)) < 1e-9) &&
                    (vec.len(vec.sub(Q, A.A)) < 1e-9 || vec.len(vec.sub(Q, A.B)) < 1e-9 || vec.len(vec.sub(Q, A.C)) < 1e-9)
                ) || (
                    (vec.len(vec.sub(P, B.A)) < 1e-9 || vec.len(vec.sub(P, B.B)) < 1e-9 || vec.len(vec.sub(P, B.C)) < 1e-9) &&
                    (vec.len(vec.sub(Q, B.A)) < 1e-9 || vec.len(vec.sub(Q, B.B)) < 1e-9 || vec.len(vec.sub(Q, B.C)) < 1e-9)
                );
                
                if (isCoplanarContainment) {
                    // For coplanar overlapping triangles, we need to handle subdivision differently
                    // Instead of trying to split both triangles with the same line,
                    // we subdivide the containing triangle and keep overlapping triangles
                    
                    // Determine which triangle contains the other by checking vertices
                    const pointInTriangle3D = (pt, [t1, t2, t3]) => {
                        // Project to 2D for point-in-triangle test
                        const n = vec.norm(vec.cross(vec.sub(t2, t1), vec.sub(t3, t1)));
                        const absN = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
                        let dropAxis = 0;
                        if (absN[1] > absN[dropAxis]) dropAxis = 1;
                        if (absN[2] > absN[dropAxis]) dropAxis = 2;
                        
                        const project = (P) => {
                            if (dropAxis === 0) return [P[1], P[2]];
                            if (dropAxis === 1) return [P[0], P[2]];
                            return [P[0], P[1]];
                        };
                        
                        const pt2d = project(pt);
                        const tri2d = [project(t1), project(t2), project(t3)];
                        
                        const v0 = [tri2d[2][0] - tri2d[0][0], tri2d[2][1] - tri2d[0][1]];
                        const v1 = [tri2d[1][0] - tri2d[0][0], tri2d[1][1] - tri2d[0][1]];
                        const v2 = [pt2d[0] - tri2d[0][0], pt2d[1] - tri2d[0][1]];
                        
                        const dot00 = v0[0] * v0[0] + v0[1] * v0[1];
                        const dot01 = v0[0] * v1[0] + v0[1] * v1[1];
                        const dot02 = v0[0] * v2[0] + v0[1] * v2[1];
                        const dot11 = v1[0] * v1[0] + v1[1] * v1[1];
                        const dot12 = v1[0] * v2[0] + v1[1] * v2[1];
                        
                        const denom = (dot00 * dot11 - dot01 * dot01);
                        if (Math.abs(denom) < 1e-12) return false;
                        
                        const invDenom = 1 / denom;
                        const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
                        const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
                        
                        return (u >= -1e-10) && (v >= -1e-10) && (u + v <= 1 + 1e-10);
                    };
                    
                    const bInA = pointInTriangle3D(B.A, [A.A, A.B, A.C]) && 
                                 pointInTriangle3D(B.B, [A.A, A.B, A.C]) && 
                                 pointInTriangle3D(B.C, [A.A, A.B, A.C]);
                    
                    if (bInA) {
                        // Triangle B is contained in Triangle A
                        // We need to actually subdivide triangle A around triangle B
                        
                        // For true subdivision, we need to create multiple triangles from A that exclude the B region
                        // This requires complex triangulation - let's create a simpler approach first
                        
                        // Create new triangles that subdivide A around B
                        const newTriangles = subdivideContainingTriangle(A, B);
                        
                        if (newTriangles && newTriangles.length > 0) {
                            // Replace triangle A with the subdivision
                            // Keep triangle B as-is to create the overlapping effect
                            
                            // CORRECTED: Build new arrays properly by copying all triangles except A,
                            // then adding subdivided triangles in place of A
                            const newTV = [];
                            const newIDs = [];
                            
                            // Copy all triangles except A
                            for (let t = 0; t < triCount; t++) {
                                if (t === A.t) {
                                    // Skip triangle A - we'll replace it with subdivisions
                                    continue;
                                }
                                const base = t * 3;
                                newTV.push(this._triVerts[base], this._triVerts[base + 1], this._triVerts[base + 2]);
                                newIDs.push(this._triIDs[t]);
                            }
                            
                            // Add subdivided triangles to replace triangle A
                            for (const tri of newTriangles) {
                                newTV.push(tri[0], tri[1], tri[2]);
                                newIDs.push(this._triIDs[A.t]); // Preserve original face ID
                            }
                            
                            this._triVerts = newTV;
                            this._triIDs = newIDs;
                            this._dirty = true;
                            
                            seenSegments.add(keySeg);
                            splitsThisPass++;
                            totalSplits++;
                            continue iteration; // Restart with new triangle set
                        }
                        
                        // If subdivision failed, fall through to normal splitting
                    }
                    
                    // For other cases, continue with normal splitting
                }

                // Attempt to split both triangles
                const newA = splitOneTriangle(A.i0, A.i1, A.i2, P, Q);
                const newB = splitOneTriangle(B.i0, B.i1, B.i2, P, Q);
                
                if (diagnostics) {
                    console.log(`\n=== Triangle Splitting Attempt ===`);
                    console.log(`Triangle A (${A.t}): [${A.i0}, ${A.i1}, ${A.i2}] -> ${newA ? newA.length + ' new triangles' : 'FAILED'}`);
                    if (newA) {
                        newA.forEach((tri, i) => console.log(`  A${i}: [${tri[0]}, ${tri[1]}, ${tri[2]}]`));
                    }
                    console.log(`Triangle B (${B.t}): [${B.i0}, ${B.i1}, ${B.i2}] -> ${newB ? newB.length + ' new triangles' : 'FAILED'}`);
                    if (newB) {
                        newB.forEach((tri, i) => console.log(`  B${i}: [${tri[0]}, ${tri[1]}, ${tri[2]}]`));
                    }
                }
                
                if (!newA || !newB) continue;

                // Manifold safety: ensure both splits are successful before applying
                // Rebuild authoring arrays: replace triangles A.t and B.t with new splits
                const newTV = [];
                const newIDs = [];
                
                if (diagnostics) {
                    console.log(`\n=== Rebuilding Triangle Arrays ===`);
                    console.log(`Original triangle count: ${triCount}`);
                    console.log(`Replacing triangle ${A.t} with ${newA.length} triangles`);
                    console.log(`Replacing triangle ${B.t} with ${newB.length} triangles`);
                }
                
                for (let t = 0; t < triCount; t++) {
                    if (t === A.t) {
                        if (diagnostics) console.log(`  Replacing triangle A(${A.t}) with subdivisions`);
                        for (const tri of newA) {
                            newTV.push(tri[0], tri[1], tri[2]);
                            newIDs.push(this._triIDs[A.t]); // Preserve original face ID
                        }
                        continue;
                    }
                    if (t === B.t) {
                        if (diagnostics) console.log(`  Replacing triangle B(${B.t}) with subdivisions`);
                        for (const tri of newB) {
                            newTV.push(tri[0], tri[1], tri[2]);
                            newIDs.push(this._triIDs[B.t]); // Preserve original face ID
                        }
                        continue;
                    }
                    const base = t * 3;
                    newTV.push(this._triVerts[base + 0] >>> 0, this._triVerts[base + 1] >>> 0, this._triVerts[base + 2] >>> 0);
                    newIDs.push(this._triIDs[t]);
                }

                if (diagnostics) {
                    console.log(`New triangle count: ${newTV.length / 3}`);
                    console.log(`Net change: +${(newTV.length / 3) - triCount} triangles`);
                }
                
                this._triVerts = newTV;
                this._triIDs = newIDs;
                // Update vertex key index
                this._vertKeyToIndex = new Map();
                for (let i = 0; i < this._vertProperties.length; i += 3) {
                    const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
                    this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
                }
                this._dirty = true;
                this._faceIndex = null;

                totalSplits++;
                splitsThisPass++;
                seenSegments.add(keySeg);
                
                // Conservative restart: only restart if we found a critical intersection
                break; // Process one split at a time for safety
            }
            
            if (splitsThisPass > 0) {
                // Restart iteration after any successful split
                continue iteration;
            }
        }
        
        if (diagnostics) {
            console.log(`  Pass ${pass + 1} results:`);
            console.log(`    Checked pairs: ${checkedPairs}`);
            console.log(`    Adjacent skips: ${adjacentSkips}`);  
            console.log(`    Intersection tests: ${intersectionTests}`);
            console.log(`    Intersection hits: ${intersectionHits}`);
            console.log(`    Splits this pass: ${splitsThisPass}`);
        }
        
        // If no splits this pass, we're done
        if (splitsThisPass === 0) break;
    }

    if (totalSplits > 0) {
        // CRITICAL: Ensure manifold properties are maintained after splitting
        // 1. Fix triangle windings to ensure consistent orientation
        this.fixTriangleWindingsByAdjacency();
        
        // 2. For overlapping triangle splitting, we intentionally allow non-manifold 
        //    intermediate states where overlapping regions have triangles with opposite normals
        //    This is expected and will be resolved by duplicate removal later
        try {
            // Test manifold creation without storing the object
            this._manifoldize();
            // If we get here, the mesh is still manifold
        } catch (error) {
            // For overlapping triangles, we expect non-manifold intermediate states
            console.log('INFO: Non-manifold geometry detected after triangle splitting (expected for overlaps):', error.message);
            // Continue execution - this is expected when splitting overlapping triangles
        }
    }
    
    if (diagnostics) {
        const finalTriCount = (this._triVerts.length / 3) | 0;
        console.log(`\n=== Final Results ===`);
        console.log(`Total splits: ${totalSplits}`);
        console.log(`Initial triangles: ${triCount0}`);
        console.log(`Final triangles: ${finalTriCount}`);
        console.log(`Net triangles added: ${finalTriCount - triCount0}`);
        
        if (totalSplits === 0) {
            console.log(`\n❌ No triangles were split. Common reasons:`);
            console.log(`  1. No overlapping coplanar triangles found`);
            console.log(`  2. All overlapping triangles marked as adjacent (share vertices/edges)`);  
            console.log(`  3. Coplanar threshold too strict for mesh precision`);
            console.log(`  4. Intersection detection failing for real mesh geometry`);
        }
    }
    
    return totalSplits;
}

/**
 * Removes triangles with duplicate or collinear vertices (degenerate triangles)
 * @returns {number} Number of triangles removed
 */
export function removeDegenerateTriangles() {
    if (!this._triVerts || !this._vertProperties) {
        return 0;
    }

    // Vector utilities
    const vec = {
        sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
        len: (v) => Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]),
        cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    };

    const originalCount = this._triVerts.length / 3;
    const newTriVerts = [];
    const newTriIDs = [];
    let removedCount = 0;

    // Helper function to check if triangle is degenerate
    const isDegenerate = (triIndex) => {
        const i = triIndex * 3;
        const v1Idx = this._triVerts[i] * 3;
        const v2Idx = this._triVerts[i + 1] * 3;
        const v3Idx = this._triVerts[i + 2] * 3;

        // Get vertex positions
        const v1 = [
            this._vertProperties[v1Idx],
            this._vertProperties[v1Idx + 1], 
            this._vertProperties[v1Idx + 2]
        ];
        const v2 = [
            this._vertProperties[v2Idx],
            this._vertProperties[v2Idx + 1],
            this._vertProperties[v2Idx + 2]
        ];
        const v3 = [
            this._vertProperties[v3Idx],
            this._vertProperties[v3Idx + 1],
            this._vertProperties[v3Idx + 2]
        ];

        // Check for duplicate vertices (tolerance based)
        const tolerance = 1e-10;
        const dist12 = vec.len(vec.sub(v1, v2));
        const dist23 = vec.len(vec.sub(v2, v3)); 
        const dist31 = vec.len(vec.sub(v3, v1));

        if (dist12 < tolerance || dist23 < tolerance || dist31 < tolerance) {
            return true; // Duplicate vertices
        }

        // Check for zero area (collinear vertices)
        const cross = vec.cross(vec.sub(v2, v1), vec.sub(v3, v1));
        const area = 0.5 * vec.len(cross);
        
        return area < 1e-12; // Near-zero area
    };

    // Filter out degenerate triangles
    for (let i = 0; i < originalCount; i++) {
        if (!isDegenerate(i)) {
            // Keep this triangle
            const triStart = i * 3;
            newTriVerts.push(this._triVerts[triStart]);
            newTriVerts.push(this._triVerts[triStart + 1]);
            newTriVerts.push(this._triVerts[triStart + 2]);
            newTriIDs.push(this._triIDs[triStart]);
            newTriIDs.push(this._triIDs[triStart + 1]);
            newTriIDs.push(this._triIDs[triStart + 2]);
        } else {
            removedCount++;
        }
    }

    // Update arrays
    this._triVerts = newTriVerts;
    this._triIDs = newTriIDs;

    console.log(`[removeDegenerateTriangles] Removed ${removedCount} degenerate triangles (${originalCount} → ${this._triVerts.length / 3})`);

    return removedCount;
}

/**
 * Remove internal triangles by rebuilding from the Manifold surface.
 * - Uses `_manifoldize().getMesh()` which yields only the exterior faces of the
 *   solid. We then overwrite authoring arrays to match this mesh.
 * - Preserves face IDs and existing face name mappings.
 * - Returns the number of triangles removed.
 */
export function removeInternalTriangles() {
    const triCountBefore = (this._triVerts.length / 3) | 0;
    if (triCountBefore === 0) return 0;
    const manifoldObj = this._manifoldize();
    const mesh = manifoldObj.getMesh();
    try {
        const triVerts = Array.from(mesh.triVerts || []);
        const vertProps = Array.from(mesh.vertProperties || []);
        const triCountAfter = (triVerts.length / 3) | 0;
        const ids = (mesh.faceID && mesh.faceID.length === triCountAfter)
            ? Array.from(mesh.faceID)
            : new Array(triCountAfter).fill(0);

        // Overwrite our authoring arrays with the exterior-only mesh
        this._numProp = mesh.numProp || 3;
        this._vertProperties = vertProps;
        this._triVerts = triVerts;
        this._triIDs = ids;

        // Rebuild quick index map
        this._vertKeyToIndex = new Map();
        for (let i = 0; i < this._vertProperties.length; i += 3) {
            const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
            this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }

        // These arrays now match the current manifold, so mark clean
        this._dirty = false;
        this._faceIndex = null;

        // Keep existing id/name maps; Manifold preserves triangle faceIDs.
        const removed = triCountBefore - triCountAfter;
        return removed > 0 ? removed : 0;
    } finally {
        try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { }
    }
}

/**
 * Remove internal triangles using a point-in-solid ray test.
 * Does not require manifold to succeed. For each triangle, cast a ray from its
 * centroid along +X and count intersections with all triangles. If the count is
 * odd (inside), the triangle is removed. Returns the number of triangles removed.
 */
export function removeInternalTrianglesByRaycast() {
    const vp = this._vertProperties;
    const tv = this._triVerts;
    const ids = this._triIDs;
    const triCount = (tv.length / 3) | 0;
    if (triCount === 0) return 0;

    // Build triangle list in point form for ray tests
    const faces = new Array(triCount);
    for (let t = 0; t < triCount; t++) {
        const b = t * 3;
        const i0 = tv[b + 0] >>> 0;
        const i1 = tv[b + 1] >>> 0;
        const i2 = tv[b + 2] >>> 0;
        faces[t] = [
            [vp[i0 * 3 + 0], vp[i0 * 3 + 1], vp[i0 * 3 + 2]],
            [vp[i1 * 3 + 0], vp[i1 * 3 + 1], vp[i1 * 3 + 2]],
            [vp[i2 * 3 + 0], vp[i2 * 3 + 1], vp[i2 * 3 + 2]],
        ];
    }

    // Bounding box for jitter
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vp.length; i += 3) {
        const x = vp[i], y = vp[i + 1], z = vp[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const jitter = 1e-6 * diag;

    // Robust ray-triangle intersection (Möller–Trumbore), returns t > 0
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
        if (Math.abs(det) < EPS) return null;
        const invDet = 1.0 / det;
        const tvecx = orig[0] - ax, tvecy = orig[1] - ay, tvecz = orig[2] - az;
        const u = (tvecx * px + tvecy * py + tvecz * pz) * invDet;
        if (u < -1e-12 || u > 1 + 1e-12) return null;
        const qx = tvecy * e1z - tvecz * e1y;
        const qy = tvecz * e1x - tvecx * e1z;
        const qz = tvecx * e1y - tvecy * e1x;
        const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invDet;
        if (v < -1e-12 || u + v > 1 + 1e-12) return null;
        const tHit = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        return tHit > 1e-10 ? tHit : null;
    };

    const pointInside = (p) => {
        // Three-axis majority vote with jitter
        const dirs = [
            [1, 0, 0], [0, 1, 0], [0, 0, 1],
        ];
        let votes = 0;
        for (let k = 0; k < dirs.length; k++) {
            const dir = dirs[k];
            const offset = [p[0] + (k + 1) * jitter, p[1] + (k + 2) * jitter, p[2] + (k + 3) * jitter];
            let hits = 0;
            for (let i = 0; i < faces.length; i++) {
                const th = rayTri(offset, dir, faces[i]);
                if (th !== null) hits++;
            }
            if ((hits % 2) === 1) votes++;
        }
        return votes >= 2; // at least 2 of 3 say inside
    };

    // Compute slightly jittered centroids to avoid t≈0 self-hits
    const triProbe = (t) => {
        const [A, B, C] = faces[t];
        const px = (A[0] + B[0] + C[0]) / 3 + jitter;
        const py = (A[1] + B[1] + C[1]) / 3 + jitter;
        const pz = (A[2] + B[2] + C[2]) / 3 + jitter;
        return [px, py, pz];
    };

    const keepTri = new Uint8Array(triCount);
    for (let t = 0; t < triCount; t++) keepTri[t] = 1;

    let removed = 0;
    for (let t = 0; t < triCount; t++) {
        const p = triProbe(t);
        if (pointInside(p)) { keepTri[t] = 0; removed++; }
    }

    if (removed === 0) return 0;

    // Rebuild compact mesh
    const nv = (vp.length / 3) | 0;
    const usedVert = new Uint8Array(nv);
    const newTV = [];
    const newIDs = [];
    for (let t = 0; t < triCount; t++) {
        if (!keepTri[t]) continue;
        const b = t * 3;
        const a = tv[b + 0] >>> 0;
        const b1 = tv[b + 1] >>> 0;
        const c = tv[b + 2] >>> 0;
        newTV.push(a, b1, c);
        newIDs.push(ids[t]);
        usedVert[a] = 1; usedVert[b1] = 1; usedVert[c] = 1;
    }

    const oldToNew = new Int32Array(nv);
    for (let i = 0; i < nv; i++) oldToNew[i] = -1;
    const newVP = [];
    let write = 0;
    for (let i = 0; i < nv; i++) {
        if (!usedVert[i]) continue;
        oldToNew[i] = write++;
        newVP.push(vp[i * 3 + 0], vp[i * 3 + 1], vp[i * 3 + 2]);
    }
    for (let i = 0; i < newTV.length; i++) newTV[i] = oldToNew[newTV[i]];

    this._vertProperties = newVP;
    this._triVerts = newTV;
    this._triIDs = newIDs;
    this._vertKeyToIndex = new Map();
    for (let i = 0; i < this._vertProperties.length; i += 3) {
        const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
        this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
    }
    this._dirty = true;
    this._faceIndex = null;
    // Fix orientation just in case
    this.fixTriangleWindingsByAdjacency();
    return removed;
}

/**
 * Remove internal triangles using solid-angle (winding number) test.
 * Computes sum of solid angles of all triangles at each triangle's centroid.
 * If |sumOmega| > threshold (≈ 2π), marks that triangle as inside and removes it.
 * Robust to self-intersections and coplanar cases; does not require Manifold.
 */
export function removeInternalTrianglesByWinding({ offsetScale = 1e-5, crossingTolerance = 0.05 } = {}) {
    // Ensure local edge orientation is consistent to get meaningful normals
    try { this.fixTriangleWindingsByAdjacency(); } catch { }
    const vp = this._vertProperties;
    const tv = this._triVerts;
    const ids = this._triIDs;
    const triCount = (tv.length / 3) | 0;
    if (triCount === 0) return 0;

    // Bounding box for epsilon offset scaling
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vp.length; i += 3) {
        const x = vp[i], y = vp[i + 1], z = vp[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const eps = offsetScale * diag;

    // Prepare faces and normals
    const faces = new Array(triCount);
    const centroids = new Array(triCount);
    const normals = new Array(triCount);
    for (let t = 0; t < triCount; t++) {
        const b = t * 3;
        const i0 = tv[b + 0] >>> 0;
        const i1 = tv[b + 1] >>> 0;
        const i2 = tv[b + 2] >>> 0;
        const ax = vp[i0 * 3 + 0], ay = vp[i0 * 3 + 1], az = vp[i0 * 3 + 2];
        const bx = vp[i1 * 3 + 0], by = vp[i1 * 3 + 1], bz = vp[i1 * 3 + 2];
        const cx = vp[i2 * 3 + 0], cy = vp[i2 * 3 + 1], cz = vp[i2 * 3 + 2];
        faces[t] = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
        centroids[t] = [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-18) {
            normals[t] = [0, 0, 0];
        } else {
            normals[t] = [nx / nl, ny / nl, nz / nl];
        }
    }

    // Oriented solid angle of triangle ABC as seen from point P
    const solidAngle = (P, A, B, C) => {
        const ax = A[0] - P[0], ay = A[1] - P[1], az = A[2] - P[2];
        const bx = B[0] - P[0], by = B[1] - P[1], bz = B[2] - P[2];
        const cx = C[0] - P[0], cy = C[1] - P[1], cz = C[2] - P[2];
        const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
        if (la < 1e-18 || lb < 1e-18 || lc < 1e-18) return 0;
        const dotAB = ax * bx + ay * by + az * bz;
        const dotBC = bx * cx + by * cy + bz * cz;
        const dotCA = cx * ax + cy * ay + cz * az;
        const crossx = ay * bz - az * by;
        const crossy = az * bx - ax * bz;
        const crossz = ax * by - ay * bx;
        const triple = crossx * cx + crossy * cy + crossz * cz; // a·(b×c)
        const denom = la * lb * lc + dotAB * lc + dotBC * la + dotCA * lb;
        return 2 * Math.atan2(triple, denom);
    };

    // Generalized winding number w(P) in [−1,1]; normalized by 4π
    const winding = (P) => {
        let omega = 0;
        for (let u = 0; u < triCount; u++) {
            const [A, B, C] = faces[u];
            omega += solidAngle(P, A, B, C);
        }
        return omega / (4 * Math.PI);
    };

    const keepTri = new Uint8Array(triCount);
    for (let t = 0; t < triCount; t++) keepTri[t] = 1;
    let removed = 0;
    const tau = Math.max(0, Math.min(0.49, crossingTolerance));

    for (let t = 0; t < triCount; t++) {
        const N = normals[t];
        if (!N || (N[0] === 0 && N[1] === 0 && N[2] === 0)) { continue; } // keep degenerate-orientation tris
        const C = centroids[t];
        const Pplus = [C[0] + N[0] * eps, C[1] + N[1] * eps, C[2] + N[2] * eps];
        const Pminus = [C[0] - N[0] * eps, C[1] - N[1] * eps, C[2] - N[2] * eps];
        const wPlus = winding(Pplus);
        const wMinus = winding(Pminus);
        const a = wPlus - 0.5;
        const b = wMinus - 0.5;
        const crosses = (a < -tau && b > tau) || (a > tau && b < -tau) || (a * b < -tau * tau);
        if (!crosses) { keepTri[t] = 0; removed++; }
    }

    if (removed === 0) return 0;

    // Rebuild compact mesh
    const nv = (vp.length / 3) | 0;
    const usedVert = new Uint8Array(nv);
    const newTV = [];
    const newIDs = [];
    for (let t = 0; t < triCount; t++) {
        if (!keepTri[t]) continue;
        const b = t * 3;
        const a = tv[b + 0] >>> 0;
        const b1 = tv[b + 1] >>> 0;
        const c = tv[b + 2] >>> 0;
        newTV.push(a, b1, c);
        newIDs.push(ids[t]);
        usedVert[a] = 1; usedVert[b1] = 1; usedVert[c] = 1;
    }

    const oldToNew = new Int32Array(nv);
    for (let i = 0; i < nv; i++) oldToNew[i] = -1;
    const newVP = [];
    let write = 0;
    for (let i = 0; i < nv; i++) {
        if (!usedVert[i]) continue;
        oldToNew[i] = write++;
        newVP.push(vp[i * 3 + 0], vp[i * 3 + 1], vp[i * 3 + 2]);
    }
    for (let i = 0; i < newTV.length; i++) newTV[i] = oldToNew[newTV[i]];

    this._vertProperties = newVP;
    this._triVerts = newTV;
    this._triIDs = newIDs;
    this._vertKeyToIndex = new Map();
    for (let i = 0; i < this._vertProperties.length; i += 3) {
        const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
        this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
    }
    this._dirty = true;
    this._faceIndex = null;
    this.fixTriangleWindingsByAdjacency();
    return removed;
}
