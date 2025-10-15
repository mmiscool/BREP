import * as THREE from 'three';
import { vToArr } from './inset.js';
import { removeDegenerateTrianglesAuthoring, quantizeVerticesAuthoring, generateEndcapFaces } from './common.js';
import { MeshRepairer } from "../MeshRepairer.js";

const __tmp1 = new THREE.Vector3();
const __tmp2 = new THREE.Vector3();
const __tmp3 = new THREE.Vector3();

// ===================== Helpers ===================== //

function signedVolumeAuthoring(solid) {
    const vp = solid._vertProperties;
    const tv = solid._triVerts;
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
    return vol6 / 6.0;
}

// Ensure triangles are oriented so signed volume is positive (outward normals).
function ensureOutwardOrientationAuthoring(solid) {
    const vol = signedVolumeAuthoring(solid);
    if (!(Number.isFinite(vol) && vol < 0)) return;
    const tv = solid._triVerts;
    for (let t = 0; t < tv.length; t += 3) {
        const tmp = tv[t + 1];
        tv[t + 1] = tv[t + 2];
        tv[t + 2] = tmp;
    }
    solid._dirty = true;
    solid._faceIndex = null;
}
function buildWedgeDirect(solid, faceName, railP, sectorDefs, radius, arcSegments, closeLoop, seamA = null, seamB = null, sideStripData = null) {
    const n = Math.min(railP.length, sectorDefs.length);
    if (n < 2) return;

    // Derive sub-face names for clearer tagging
    const faceArc = `${faceName}_ARC`;
    // Side strips are built separately on the original faces via projection.

    // Create arc rings (n x (arcSegments+1)) WITHOUT snapping to seams yet.
    // We align parameterization across rings first, then snap endpoints.
    const arcRings = new Array(n);
    for (let i = 0; i < n; i++) {
        const def = sectorDefs[i];
        // Back-compat: allow {t} older field as axis
        const C = def.C;
        const axis = (def.axis ? def.axis.clone() : (def.t ? def.t.clone() : new THREE.Vector3(0, 0, 1))).normalize();
        const r0 = def.r0.clone();
        const angle = def.angle;
        const ring = new Array(arcSegments + 1);
        for (let j = 0; j <= arcSegments; j++) {
            const a = (j / arcSegments) * angle;
            const dir = r0.clone().applyAxisAngle(axis, a).normalize();
            ring[j] = C.clone().addScaledVector(dir, radius);
        }
        arcRings[i] = ring;
    }

    // Helper utilities for alignment
    const sqrDist = (a, b) => a.distanceToSquared(b);
    const rotateRingInPlace = (ring, shift) => {
        // shift can be negative; keep within 0..M-1; last element duplicates first
        const M = ring.length; // = arcSegments + 1
        if (M <= 1) return ring;
        let s = ((shift % (M - 1)) + (M - 1)) % (M - 1);
        if (s === 0) return ring;
        const head = ring.slice(0, M - 1);
        head.unshift(...head.splice(head.length - s, s)); // rotate right by s
        for (let i = 0; i < M - 1; i++) ring[i] = head[i];
        ring[M - 1] = ring[0].clone();
        return ring;
    };
    const reverseRingInPlace = (ring) => {
        const M = ring.length;
        if (M <= 2) return ring;
        const head = ring.slice(0, M - 1).reverse();
        for (let i = 0; i < M - 1; i++) ring[i] = head[i];
        ring[M - 1] = ring[0].clone();
        return ring;
    };
    const bestAlign = (rA, rB) => {
        // Optimized alignment: try coarse sampling first, then refine
        const M = rA.length;
        if (M <= 2) return { flip: false, shift: 0, err: 0 };
        
        const step = Math.max(1, Math.round((M - 1) / 6)); // Reduced from /8 for speed
        let best = { flip: false, shift: 0, err: Infinity };
        
        // Coarse search with reduced shift sampling
        const coarseStep = Math.max(1, Math.round((M - 1) / 4));
        for (const flip of [false, true]) {
            const getB = (k) => flip ? rB[(M - 1) - k] : rB[k];
            for (let s = 0; s < (M - 1); s += coarseStep) {
                let e = 0;
                for (let j = 0; j < M; j += step) {
                    const k = (j % (M - 1));
                    const kb = (k + s) % (M - 1);
                    e += sqrDist(rA[k], getB(kb));
                }
                if (e < best.err) best = { flip, shift: s, err: e };
            }
        }
        
        // Refine around the best coarse result
        const refineDelta = Math.max(1, coarseStep);
        const minShift = Math.max(0, best.shift - refineDelta);
        const maxShift = Math.min(M - 1, best.shift + refineDelta);
        
        for (let s = minShift; s < maxShift; s++) {
            if (s === best.shift) continue; // Already tested
            const getB = (k) => best.flip ? rB[(M - 1) - k] : rB[k];
            let e = 0;
            for (let j = 0; j < M; j += step) {
                const k = (j % (M - 1));
                const kb = (k + s) % (M - 1);
                e += sqrDist(rA[k], getB(kb));
            }
            if (e < best.err) best = { flip: best.flip, shift: s, err: e };
        }
        
        return best;
    };

    // Align parameterization ring‑to‑ring for both closed and open edges.
    // Allow both reversal and cyclic rotation; seams are re‑snapped below
    // so index 0 and M‑1 always land on seamA/seamB respectively.
    for (let i = 0; i < n - 1; i++) {
        const rA = arcRings[i];
        const rB = arcRings[i + 1];
        if (!rA || !rB) continue;
        const pick = bestAlign(rA, rB);
        if (pick.flip) reverseRingInPlace(rB);
        if (pick.shift) rotateRingInPlace(rB, pick.shift);
    }

    // After alignment, snap ring endpoints to exact face-tangency points if provided.
    for (let i = 0; i < n; i++) {
        const ring = arcRings[i];
        if (seamA && seamA[i]) ring[0] = seamA[i].clone();
        if (seamB && seamB[i]) ring[arcSegments] = seamB[i].clone();
    }

    // Curved surface between successive arc rings. Alternate the quad
    // triangulation to avoid long zig-zag artifacts in the wireframe.
    const triArea2 = (p, q, r) => {
        const ux = q.x - p.x, uy = q.y - p.y, uz = q.z - p.z;
        const vx = r.x - p.x, vy = r.y - p.y, vz = r.z - p.z;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        return nx * nx + ny * ny + nz * nz;
    };
    const pushIfArea = (face, a, b, c) => {
        if (triArea2(a, b, c) > 1e-32) solid.addTriangle(face, vToArr(a), vToArr(b), vToArr(c));
    };
    for (let i = 0; i < n - 1; i++) {
        const r0 = arcRings[i];
        const r1 = arcRings[i + 1];
        for (let j = 0; j < arcSegments; j++) {
            const p00 = r0[j], p01 = r0[j + 1];
            const p10 = r1[j], p11 = r1[j + 1];
            const checker = ((i + j) & 1) === 0;
            if (checker) {
                pushIfArea(faceArc, p00, p10, p11);
                pushIfArea(faceArc, p00, p11, p01);
            } else {
                pushIfArea(faceArc, p00, p10, p01);
                pushIfArea(faceArc, p01, p10, p11);
            }
        }
    }

    // Stitch last-to-first if closed along length
    if (closeLoop && n > 2) {
        let r0 = arcRings[n - 1];
        let r1 = arcRings[0];
        // Allow both flip and cyclic rotation for the seam ring alignment as well
        const pick = bestAlign(r0, r1);
        let flip = false;
        if (pick.flip) { reverseRingInPlace(r1); flip = true; }
        if (pick.shift) rotateRingInPlace(r1, pick.shift);
        for (let j = 0; j < arcSegments; j++) {
            const idx = j;
            const idxN = j + 1;
            const match = (k) => flip ? (arcSegments - k) : k;
            const p00 = r0[idx], p01 = r0[idxN];
            const p10 = r1[match(idx)], p11 = r1[match(idxN)];
            const checker = (((n - 1) + j) & 1) === 0; // use i = n-1 for seam parity
            if (checker) {
                solid.addTriangle(faceArc, vToArr(p00), vToArr(p10), vToArr(p11));
                solid.addTriangle(faceArc, vToArr(p00), vToArr(p11), vToArr(p01));
            } else {
                solid.addTriangle(faceArc, vToArr(p00), vToArr(p10), vToArr(p01));
                solid.addTriangle(faceArc, vToArr(p01), vToArr(p10), vToArr(p11));
            }
        }
    }

    if (closeLoop && n > 2) {
        const i0 = n - 1, i1 = 0;
        const P0 = railP[i0], P1 = railP[i1];
        // For the seam, mirror A/B if the seam ring orientation was flipped.
        const r0 = arcRings[i0];
        const r1 = arcRings[i1];
        let seamSame = 0, seamFlip = 0;
        const step2 = Math.max(1, Math.round(arcSegments / 6));
        for (let j = 0; j <= arcSegments; j += step2) {
            const k = j;
            const kf = arcSegments - j;
            seamSame += sqrDist(r0[k], r1[k]);
            seamFlip += sqrDist(r0[k], r1[kf]);
        }
        const seamFlipped = (seamFlip + 1e-10 < seamSame);
        const A0 = r0[0];
        const A1 = seamFlipped ? r1[arcSegments] : r1[0];
        const B0 = r0[arcSegments];
        const B1 = seamFlipped ? r1[0] : r1[arcSegments];
        // Side strips are handled by face‑projection builder; nothing here.
    }

    // Finalize: fix T‑junctions and patch any holes on the authored wedge
    // Use a conservative tolerance scaled by the fillet radius to keep seams intact



}


// Build a closed triangular prism by skinning 3 rails: P (edge), A (tangent to faceA), B (tangent to faceB)
// (removed unused buildCornerPrism)

// Solve for center C such that:
//   nA·C = nA·p - r
//   nB·C = nB·p - r
//   t ·C = t ·p
// Returns THREE.Vector3 or null
// (removed unused solveCenterFromOffsetPlanes / solveCenterFromOffsetPlanesSigned)

// Variant anchored to points on each face. Uses plane constants from the
// nearest triangle points qA and qB so the offset planes are parallel to the
// actual face triangles, not merely translated through `p`. This improves
// tangency against curved meshes (e.g., cones) where triangle planes differ
// slightly around the edge.
//   nA·C = nA·qA + sA*r
//   nB·C = nB·qB + sB*r
//   t ·C = t ·p
function solveCenterFromOffsetPlanesAnchored(p, t, nA, qA, sA, nB, qB, sB, r) {
    const dA = nA.dot(qA) + sA * r;
    const dB = nB.dot(qB) + sB * r;
    const dT = t.dot(p);
    // Intersection of three planes using vector triple products:
    // C = ( (nB×t)*dA + (t×nA)*dB + (nA×nB)*dT ) / ( nA·(nB×t) )
    const nbxt = __tmp1.copy(nB).cross(t);
    const txnA = __tmp2.copy(t).cross(nA);
    const nAxnB = __tmp3.copy(nA).cross(nB);
    const denom = nA.dot(nbxt);
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-14) {
        // Fallback to Gaussian elimination for near-degenerate configuration
        const A = [[nA.x, nA.y, nA.z], [nB.x, nB.y, nB.z], [t.x, t.y, t.z]];
        const b = [dA, dB, dT];
        const x = solve3(A, b);
        return x ? new THREE.Vector3(x[0], x[1], x[2]) : null;
    }
    const num = nbxt.multiplyScalar(dA).add(txnA.multiplyScalar(dB)).add(nAxnB.multiplyScalar(dT));
    return new THREE.Vector3(num.x / denom, num.y / denom, num.z / denom);
}

// Solve 3x3 linear system A x = b using Gaussian elimination with partial pivoting
function solve3(A, b) {
    const n = 3;
    const mat = A.map(row => [...row]); // Copy matrix
    const vec = [...b]; // Copy vector

    // Forward elimination
    for (let i = 0; i < n; i++) {
        // Find pivot
        let maxRow = i;
        for (let k = i + 1; k < n; k++) {
            if (Math.abs(mat[k][i]) > Math.abs(mat[maxRow][i])) {
                maxRow = k;
            }
        }

        // Swap rows
        if (maxRow !== i) {
            [mat[i], mat[maxRow]] = [mat[maxRow], mat[i]];
            [vec[i], vec[maxRow]] = [vec[maxRow], vec[i]];
        }

        // Check for singular matrix
        if (Math.abs(mat[i][i]) < 1e-12) return null;

        // Eliminate
        for (let k = i + 1; k < n; k++) {
            const factor = mat[k][i] / mat[i][i];
            for (let j = i; j < n; j++) {
                mat[k][j] -= factor * mat[i][j];
            }
            vec[k] -= factor * vec[i];
        }
    }

    // Back substitution
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
        x[i] = vec[i];
        for (let j = i + 1; j < n; j++) {
            x[i] -= mat[i][j] * x[j];
        }
        x[i] /= mat[i][i];
    }

    if (!x.every(Number.isFinite)) return null;
    return x;
}
function copyFromSolid(dst, src) {
    const mesh = src.getMesh();
    dst._numProp = mesh.numProp;
    dst._vertProperties = Array.from(mesh.vertProperties);
    dst._triVerts = Array.from(mesh.triVerts);
    // Try to carry over face IDs if available; else default 0s
    dst._triIDs = (mesh.faceID && mesh.faceID.length)
        ? Array.from(mesh.faceID)
        : new Array((mesh.triVerts.length / 3) | 0).fill(0);

    // Rebuild vertex key map
    dst._vertKeyToIndex = new Map();
    for (let i = 0; i < dst._vertProperties.length; i += 3) {
        const x = dst._vertProperties[i + 0];
        const y = dst._vertProperties[i + 1];
        const z = dst._vertProperties[i + 2];
        dst._vertKeyToIndex.set(`${x},${y},${z}`, i / 3);
    }

    // Preserve face name maps from source so visualize() can group faces
    dst._idToFaceName = new Map(src._idToFaceName);
    dst._faceNameToID = new Map(src._faceNameToID);

    dst._dirty = true; // force manifold rebuild on next access
    dst._faceIndex = null;
    try { /* done */ } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { } }
}
function enforceTwoManifoldByDropping(solid, maxPasses = 3) {
    for (let pass = 0; pass < maxPasses; pass++) {
        const vp = solid._vertProperties;
        const tv = solid._triVerts;
        const fid = solid._triIDs;
        const triCount = (tv.length / 3) | 0;
        if (triCount === 0) return 0;

        // Build edge -> tris map (undirected)
        const edgeMap = new Map(); // key "i:j" with i<j -> [triIdx,...]
        const triArea = new Float64Array(triCount);
        const triName = new Array(triCount);
        const areaOf = (i0, i1, i2) => {
            const ax = vp[i0 * 3 + 0], ay = vp[i0 * 3 + 1], az = vp[i0 * 3 + 2];
            const bx = vp[i1 * 3 + 0], by = vp[i1 * 3 + 1], bz = vp[i1 * 3 + 2];
            const cx = vp[i2 * 3 + 0], cy = vp[i2 * 3 + 1], cz = vp[i2 * 3 + 2];
            const ux = bx - ax, uy = by - ay, uz = bz - az;
            const vx = cx - ax, vy = cy - ay, vz = cz - az;
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            return 0.5 * Math.hypot(nx, ny, nz);
        };
        for (let t = 0; t < triCount; t++) {
            const i0 = tv[t * 3 + 0] >>> 0, i1 = tv[t * 3 + 1] >>> 0, i2 = tv[t * 3 + 2] >>> 0;
            const a = areaOf(i0, i1, i2); triArea[t] = a;
            const id = fid ? fid[t] : undefined;
            triName[t] = (id !== undefined) ? (solid._idToFaceName.get(id) || '') : '';
            const add = (a, b) => {
                const i = Math.min(a, b), j = Math.max(a, b);
                const key = i + ":" + j;
                let arr = edgeMap.get(key);
                if (!arr) { arr = []; edgeMap.set(key, arr); }
                arr.push(t);
            };
            add(i0, i1); add(i1, i2); add(i2, i0);
        }

        const drop = new Uint8Array(triCount);
        let needDrop = 0;
        const priority = (name) => {
            if (typeof name !== 'string') return 0;
            if (name.includes('_ARC')) return 3; // keep most
            if (name.includes('_CAP')) return 2;
            if (name.includes('_SIDE_')) return 1; // drop first
            return 1;
        };

        for (const [key, tris] of edgeMap.entries()) {
            if (!tris || tris.length <= 2) continue;
            // Sort by (priority asc -> drop first), then by area asc
            const arr = tris.slice().sort((ta, tb) => {
                const pa = priority(triName[ta]);
                const pb = priority(triName[tb]);
                if (pa !== pb) return pa - pb;
                return triArea[ta] - triArea[tb];
            });
            const toRemove = arr.length - 2;
            for (let k = 0; k < toRemove; k++) { drop[arr[k]] = 1; needDrop++; }
        }

        if (!needDrop) return 0;
        // Rebuild arrays without dropped triangles
        const newTV = [];
        const newFID = [];
        for (let t = 0; t < triCount; t++) {
            if (drop[t]) continue;
            newTV.push(tv[t * 3 + 0] >>> 0, tv[t * 3 + 1] >>> 0, tv[t * 3 + 2] >>> 0);
            if (fid) newFID.push(fid[t]);
        }
        solid._triVerts = newTV;
        if (fid) solid._triIDs = newFID; else solid._triIDs = null;
        solid._dirty = true;
        solid._faceIndex = null;
        // Loop again in case removals reduced some >2 edges indirectly
    }
    return 0;
}

// ===================== Mesh Repair Convenience ===================== //

/**
 * Fix T‑junctions and patch holes on a THREE.BufferGeometry.
 * - Splits triangles where a vertex lies on an edge (T‑junction fix).
 * - Detects boundary loops and triangulates them to fill holes.
 * Returns a NEW geometry; the input is not mutated.
 * Populates `userData` with diagnostic counts: `__tjunctionSplits`, `__holesFilled`, `__boundaryEdges`.
 */
function fixTJunctionsAndPatchHoles(geometry, {
    weldEps = 5e-4,   // optional pre‑weld distance to unify near‑duplicate verts
    lineEps = 5e-4,   // tolerance for T‑junction point‑on‑segment
    gridCell = 0.01,  // hash‑grid cell size for candidate search
    fixNormals = true, // recompute consistent windings and normals at the end
    patchHoles = true, // optionally triangulate boundary loops
    doTJunctions = true,
    doWeld = true,
    doRemoveOverlaps = true,
} = {}) {
    if (!geometry || !(geometry.isBufferGeometry)) return geometry;
    const repairer = new MeshRepairer();
    let g = geometry;
    // Pre‑weld helps make T‑junction detection robust on nearly coincident vertices
    if (doWeld) { try { g = repairer.weldVertices(g, weldEps); } catch { } }
    if (doTJunctions) { try { g = repairer.fixTJunctions(g, lineEps, gridCell); } catch { } }
    if (doRemoveOverlaps) { try { g = repairer.removeOverlappingTriangles(g); } catch { } }
    if (patchHoles) {
        try { g = repairer.fillHoles(g); } catch { }
    }
    if (fixNormals) {
        try { g = repairer.fixTriangleNormals(g); } catch { }
        try { g.computeVertexNormals(); } catch { }
    }
    return g;
}

export {
    buildWedgeDirect,
    solveCenterFromOffsetPlanesAnchored,
    copyFromSolid,
    quantizeVerticesAuthoring,
    removeDegenerateTrianglesAuthoring,
    ensureOutwardOrientationAuthoring,
    enforceTwoManifoldByDropping,
    fixTJunctionsAndPatchHoles,
};
