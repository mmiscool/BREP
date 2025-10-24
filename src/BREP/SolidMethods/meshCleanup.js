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
 * Detect and split self-intersecting triangle pairs.
 * - Finds non-adjacent triangle pairs that intersect along a segment.
 * - Splits both triangles along the intersection segment and triangulates
 *   the resulting polygons, preserving face IDs.
 * - Modifies this solid in place; returns the number of pairwise splits applied.
 */
export function splitSelfIntersectingTriangles() {
    const vp = this._vertProperties;
    const tv = this._triVerts;
    const ids = this._triIDs;
    const triCount0 = (tv.length / 3) | 0;
    if (triCount0 < 2) return 0;

    const EPS = 1e-9;

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

    // Triangle-triangle intersection segment (non-coplanar)
    const triTriIntersectSegment = (A, B, C, D, E, F) => {
        const p1 = planeOf(A, B, C);
        const p2 = planeOf(D, E, F);
        const n1 = p1.n, n2 = p2.n;
        const cr = vec.cross(n1, n2);
        const crLen = vec.len(cr);
        if (crLen < 1e-12) {
            // Parallel or coplanar; skip coplanar overlaps in this implementation
            return null;
        }

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
        if (L < 1e-12) return null;
        const Lhat = vec.mul(dir, 1 / L);

        const tP1 = 0;
        const tP2 = L;
        const tQ1 = vec.dot(vec.sub(Q1, P1), Lhat);
        const tQ2 = vec.dot(vec.sub(Q2, P1), Lhat);
        const i1 = Math.min(tP1, tP2), i2 = Math.max(tP1, tP2);
        const j1 = Math.min(tQ1, tQ2), j2 = Math.max(tQ1, tQ2);
        const a = Math.max(i1, j1), b = Math.min(i2, j2);
        if (!(b > a + 1e-12)) return null; // no overlap (> point)
        const X = [P1[0] + Lhat[0] * a, P1[1] + Lhat[1] * a, P1[2] + Lhat[2] * a];
        const Y = [P1[0] + Lhat[0] * b, P1[1] + Lhat[1] * b, P1[2] + Lhat[2] * b];
        return [X, Y];
    };

    // Barycentric weights for point X in ABC (via 2D projection)
    const barycentric = (A, B, C, X) => {
        const u = vec.sub(B, A);
        const v = vec.sub(C, A);
        const n = vec.cross(u, v);
        const nu = vec.cross(v, n);
        const nv = vec.cross(n, u);
        const denom = vec.dot(u, nu); // = |n|^2
        if (Math.abs(denom) < 1e-20) return [NaN, NaN, NaN];
        const w1 = vec.dot(vec.sub(X, A), nu) / denom; // weight for B
        const w2 = vec.dot(vec.sub(X, A), nv) / denom; // weight for C
        const w0 = 1 - w1 - w2; // weight for A
        return [w0, w1, w2];
    };

    const classifyEdge = (w) => {
        // Return which edge the point lies on: 0: AB, 1: BC, 2: CA
        const [wa, wb, wc] = w;
        const t = 1e-6;
        if (Math.abs(wc) <= t) return 0; // AB
        if (Math.abs(wa) <= t) return 1; // BC
        if (Math.abs(wb) <= t) return 2; // CA
        // Fallback: choose the smallest magnitude weight
        const m = Math.abs(wa) < Math.abs(wb) ? (Math.abs(wa) < Math.abs(wc) ? 1 : 0) : (Math.abs(wb) < Math.abs(wc) ? 2 : 0);
        return m;
    };

    // Split a triangle by chord P-Q; returns array of new [i,j,k] (indices)
    const splitOneTriangle = (ia, ib, ic, P, Q) => {
        const A = pointOf(ia), B = pointOf(ib), C = pointOf(ic);
        const wP = barycentric(A, B, C, P);
        const wQ = barycentric(A, B, C, Q);
        if (!wP || !wQ || !Number.isFinite(wP[0]) || !Number.isFinite(wQ[0])) return null;
        const edgeP = classifyEdge(wP);
        const edgeQ = classifyEdge(wQ);

        // Avoid no-op: if either endpoint sits on a vertex, skip
        const nearV = (X, Y) => Math.hypot(X[0] - Y[0], X[1] - Y[1], X[2] - Y[2]) < 1e-9;
        if (nearV(P, A) || nearV(P, B) || nearV(P, C) || nearV(Q, A) || nearV(Q, B) || nearV(Q, C)) return null;

        // Must cut across two different edges
        if (edgeP === edgeQ) return null;

        const ip = this._getPointIndex(P);
        const iq = this._getPointIndex(Q);

        const emit = (i0, i1, i2, out) => {
            if (i0 === i1 || i1 === i2 || i2 === i0) return;
            const area = triArea(i0, i1, i2);
            if (!(area > 1e-14)) return;
            out.push([i0, i1, i2]);
        };

        const out = [];
        const E_AB = 0, E_BC = 1, E_CA = 2;
        const iA = ia, iB = ib, iC = ic;

        // Case sets
        if ((edgeP === E_AB && edgeQ === E_CA) || (edgeQ === E_AB && edgeP === E_CA)) {
            // Near A: [A, P, Q], quad -> [P, B, C] + [P, C, Q]
            emit(iA, ip, iq, out);
            emit(ip, iB, iC, out);
            emit(ip, iC, iq, out);
        } else if ((edgeP === E_AB && edgeQ === E_BC) || (edgeQ === E_AB && edgeP === E_BC)) {
            // Near B: [B, P, Q], quad -> [A, P, Q] + [A, Q, C]
            emit(iB, ip, iq, out);
            emit(iA, ip, iq, out);
            emit(iA, iq, iC, out);
        } else if ((edgeP === E_BC && edgeQ === E_CA) || (edgeQ === E_BC && edgeP === E_CA)) {
            // Near C: [C, P, Q], quad -> [A, B, P] + [A, P, Q]
            emit(iC, ip, iq, out);
            emit(iA, iB, ip, out);
            emit(iA, ip, iq, out);
        } else {
            return null; // unexpected configuration
        }

        // Require an actual split: we expect 3 triangles if both points are interior
        if (out.length < 3) return null;
        return out;
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
    const maxIterations = Math.max(1, triCount0 * 4);

    iteration: for (let pass = 0; pass < maxIterations; pass++) {
        const triCount = (this._triVerts.length / 3) | 0;
        if (triCount < 2) break;

        const adjPairs = buildAdjacencyPairs();

        // AABB sweep setup
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

        for (let ii = 0; ii < order.length; ii++) {
            const ai = order[ii];
            const A = tris[ai];
            for (let jj = ii + 1; jj < order.length; jj++) {
                const bi = order[jj];
                const B = tris[bi];
                if (B.minX > A.maxX + 1e-12) break; // sweep prune by X
                if (B.maxY < A.minY - 1e-12 || B.minY > A.maxY + 1e-12) continue;
                if (B.maxZ < A.minZ - 1e-12 || B.minZ > A.maxZ + 1e-12) continue;
                const pk = pairKey(A.t, B.t);
                if (adjPairs.has(pk)) continue; // skip adjacent triangles sharing an edge
                if (tried.has(pk)) continue; tried.add(pk);

                const seg = triTriIntersectSegment(A.A, A.B, A.C, B.A, B.B, B.C);
                if (!seg) continue;
                const [P, Q] = seg;
                const keySeg = skey(P, Q);
                if (seenSegments.has(keySeg)) continue;
                const dPQ = Math.hypot(P[0] - Q[0], P[1] - Q[1], P[2] - Q[2]);
                if (!(dPQ > EPS)) continue;

                // Attempt to split both triangles
                const newA = splitOneTriangle(A.i0, A.i1, A.i2, P, Q);
                const newB = splitOneTriangle(B.i0, B.i1, B.i2, P, Q);
                if (!newA || !newB) continue;

                // Rebuild authoring arrays: replace triangles A.t and B.t with new splits
                const newTV = [];
                const newIDs = [];
                for (let t = 0; t < triCount; t++) {
                    if (t === A.t) {
                        for (const tri of newA) {
                            newTV.push(tri[0], tri[1], tri[2]);
                            newIDs.push(this._triIDs[A.t]);
                        }
                        continue;
                    }
                    if (t === B.t) {
                        for (const tri of newB) {
                            newTV.push(tri[0], tri[1], tri[2]);
                            newIDs.push(this._triIDs[B.t]);
                        }
                        continue;
                    }
                    const base = t * 3;
                    newTV.push(this._triVerts[base + 0] >>> 0, this._triVerts[base + 1] >>> 0, this._triVerts[base + 2] >>> 0);
                    newIDs.push(this._triIDs[t]);
                }

                this._triVerts = newTV;
                this._triIDs = newIDs;
                // No need to touch _vertProperties except adding P/Q indices which were added by _getPointIndex
                this._vertKeyToIndex = new Map();
                for (let i = 0; i < this._vertProperties.length; i += 3) {
                    const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
                    this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
                }
                this._dirty = true;
                this._faceIndex = null;

                totalSplits++;
                seenSegments.add(keySeg);
                // Restart sweep on the updated mesh
                continue iteration;
            }
        }
        break; // No more intersections found
    }

    if (totalSplits > 0) {
        // Clean up any degenerate artifacts and enforce coherent orientation
        this.fixTriangleWindingsByAdjacency();
    }
    return totalSplits;
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
