import * as THREE from 'three';

// Remove triangles with area below the tolerance and rebuild supporting arrays.
export function removeDegenerateTrianglesAuthoring(solid, areaEps = 1e-12) {
    const vp = solid._vertProperties;
    const tv = solid._triVerts;
    const ids = solid._triIDs;
    const triCount = (tv.length / 3) | 0;
    if (triCount === 0) return 0;
    const keep = new Uint8Array(triCount);
    let removed = 0;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
        const i0 = tv[t * 3 + 0] * 3;
        const i1 = tv[t * 3 + 1] * 3;
        const i2 = tv[t * 3 + 2] * 3;
        A.set(vp[i0 + 0], vp[i0 + 1], vp[i0 + 2]);
        B.set(vp[i1 + 0], vp[i1 + 1], vp[i1 + 2]);
        C.set(vp[i2 + 0], vp[i2 + 1], vp[i2 + 2]);
        const area = B.clone().sub(A).cross(C.clone().sub(A)).length() * 0.5;
        if (Number.isFinite(area) && area > areaEps) keep[t] = 1; else removed++;
    }
    if (removed === 0) return 0;
    const used = new Uint8Array((vp.length / 3) | 0);
    const newTriVerts = [];
    const newTriIDs = [];
    for (let t = 0; t < triCount; t++) {
        if (!keep[t]) continue;
        const a = tv[t * 3 + 0] >>> 0;
        const b = tv[t * 3 + 1] >>> 0;
        const c = tv[t * 3 + 2] >>> 0;
        newTriVerts.push(a, b, c);
        if (ids) newTriIDs.push(ids[t]);
        used[a] = 1; used[b] = 1; used[c] = 1;
    }
    const oldToNew = new Int32Array((vp.length / 3) | 0);
    for (let i = 0; i < oldToNew.length; i++) oldToNew[i] = -1;
    const newVP = [];
    let w = 0;
    for (let i = 0; i < used.length; i++) {
        if (!used[i]) continue;
        const j = i * 3;
        newVP.push(vp[j + 0], vp[j + 1], vp[j + 2]);
        oldToNew[i] = w++;
    }
    for (let k = 0; k < newTriVerts.length; k++) newTriVerts[k] = oldToNew[newTriVerts[k]];
    solid._vertProperties = newVP;
    solid._triVerts = newTriVerts;
    solid._triIDs = ids ? newTriIDs : null;
    solid._vertKeyToIndex = new Map();
    for (let i = 0; i < newVP.length; i += 3) {
        solid._vertKeyToIndex.set(`${newVP[i]},${newVP[i + 1]},${newVP[i + 2]}`, (i / 3) | 0);
    }
    solid._dirty = true;
    solid._faceIndex = null;
    solid.fixTriangleWindingsByAdjacency();
    return removed;
}

// Snap authoring vertices to a 3D grid and rebuild lookup tables.
export function quantizeVerticesAuthoring(solid, q = 1e-6) {
    if (!(q > 0)) return 0;
    const vp = solid._vertProperties;
    let changes = 0;
    for (let i = 0; i < vp.length; i++) {
        const v = vp[i];
        const snapped = Math.round(v / q) * q;
        if (snapped !== v) { vp[i] = snapped; changes++; }
    }
    if (changes) {
        solid._vertKeyToIndex = new Map();
        for (let i = 0; i < vp.length; i += 3) {
            const x = vp[i + 0], y = vp[i + 1], z = vp[i + 2];
            solid._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }
        solid._dirty = true;
        solid._faceIndex = null;
        solid.fixTriangleWindingsByAdjacency();
    }
    return (changes / 3) | 0;
}
