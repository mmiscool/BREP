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

