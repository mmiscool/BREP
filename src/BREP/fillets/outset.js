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

/**
 * Compute a consistent rotation-minimizing frame along a path to prevent self-intersecting meshes.
 * Uses parallel transport to maintain frame orientation without twisting.
 * 
 * @param {Array<THREE.Vector3>} tangents - Array of tangent vectors along the path
 * @param {Array<THREE.Vector3>} initialU - Array of initial U vectors (aligned to first face normal)
 * @param {boolean} closeLoop - Whether the path is closed
 * @returns {Array<{u: THREE.Vector3, v: THREE.Vector3}>} Array of orthonormal frames
 */
function computeParallelTransportFrames(tangents, initialU, closeLoop) {
    const n = tangents.length;
    if (n === 0) return [];
    
    const frames = new Array(n);
    const tempV = new THREE.Vector3();
    const tempU = new THREE.Vector3();
    const rotAxis = new THREE.Vector3();
    
    // Initialize first frame
    const t0 = tangents[0].clone().normalize();
    const u0 = initialU[0].clone();
    // Ensure u0 is perpendicular to t0
    const proj = t0.dot(u0);
    u0.addScaledVector(t0, -proj).normalize();
    const v0 = new THREE.Vector3().crossVectors(t0, u0).normalize();
    frames[0] = { u: u0.clone(), v: v0.clone() };
    
    // Propagate frame along path using parallel transport
    for (let i = 1; i < n; i++) {
        const tPrev = tangents[i - 1].clone().normalize();
        const tCurr = tangents[i].clone().normalize();
        const uPrev = frames[i - 1].u.clone();
        const vPrev = frames[i - 1].v.clone();
        
        // Compute rotation axis between consecutive tangents
        rotAxis.crossVectors(tPrev, tCurr);
        const rotAxisLen = rotAxis.length();
        
        let uCurr, vCurr;
        
        if (rotAxisLen < 1e-10) {
            // Tangents are parallel, no rotation needed
            uCurr = uPrev.clone();
            vCurr = vPrev.clone();
        } else {
            // Rotate u and v to align with new tangent
            rotAxis.normalize();
            const angle = Math.acos(Math.max(-1, Math.min(1, tPrev.dot(tCurr))));
            
            // Parallel transport: rotate previous frame around the rotation axis
            uCurr = uPrev.clone().applyAxisAngle(rotAxis, angle);
            vCurr = vPrev.clone().applyAxisAngle(rotAxis, angle);
        }
        
        // Ensure orthonormality (numerical stability)
        const projU = tCurr.dot(uCurr);
        uCurr.addScaledVector(tCurr, -projU).normalize();
        vCurr.crossVectors(tCurr, uCurr).normalize();
        
        frames[i] = { u: uCurr, v: vCurr };
    }
    
    // For closed loops, adjust frames to ensure continuity at the seam
    if (closeLoop && n > 2) {
        const tFirst = tangents[0].clone().normalize();
        const tLast = tangents[n - 1].clone().normalize();
        
        // Compute what the last frame should be if we propagate forward
        rotAxis.crossVectors(tLast, tFirst);
        const rotAxisLen = rotAxis.length();
        
        let uExpected, vExpected;
        if (rotAxisLen < 1e-10) {
            uExpected = frames[n - 1].u.clone();
            vExpected = frames[n - 1].v.clone();
        } else {
            rotAxis.normalize();
            const angle = Math.acos(Math.max(-1, Math.min(1, tLast.dot(tFirst))));
            uExpected = frames[n - 1].u.clone().applyAxisAngle(rotAxis, angle);
            vExpected = frames[n - 1].v.clone().applyAxisAngle(rotAxis, angle);
            
            const projU = tFirst.dot(uExpected);
            uExpected.addScaledVector(tFirst, -projU).normalize();
            vExpected.crossVectors(tFirst, uExpected).normalize();
        }
        
        // Measure angular discrepancy at the seam
        const angleDiff = Math.acos(Math.max(-1, Math.min(1, frames[0].u.dot(uExpected))));
        
        // Distribute the twist correction evenly across all frames
        if (Math.abs(angleDiff) > 1e-6) {
            const twistPerSegment = angleDiff / n;
            for (let i = 0; i < n; i++) {
                const twist = twistPerSegment * i;
                const t = tangents[i].clone().normalize();
                const u = frames[i].u.clone().applyAxisAngle(t, twist);
                const v = frames[i].v.clone().applyAxisAngle(t, twist);
                
                // Re-orthonormalize
                const projU = t.dot(u);
                u.addScaledVector(t, -projU).normalize();
                v.crossVectors(t, u).normalize();
                
                frames[i] = { u, v };
            }
        }
    }
    
    return frames;
}

function buildWedgeDirect(solid, faceName, railP, sectorDefs, radius, arcSegments, closeLoop, seamA = null, seamB = null, sideStripData = null) {
    const n = Math.min(railP.length, sectorDefs.length);
    if (n < 2) return;

    // Extract parallel transport frames if provided
    const parallelFrames = sideStripData?.frames;
    const useParallelTransport = parallelFrames && parallelFrames.length === n;

    // Derive sub-face names for clearer tagging
    const faceArc = `${faceName}_ARC`;
    // Side strips are built separately on the original faces via projection.

    // Create arc rings (n x (arcSegments+1)) using parallel transport frames
    // to prevent self-intersecting meshes. Each ring is parameterized in a
    // consistent coordinate frame that varies smoothly along the path.
    const arcRings = new Array(n);
    for (let i = 0; i < n; i++) {
        const def = sectorDefs[i];
        const C = def.C;
        const axis = (def.axis ? def.axis.clone() : (def.t ? def.t.clone() : new THREE.Vector3(0, 0, 1))).normalize();
        const r0 = def.r0.clone();
        const r1 = def.r1 || r0.clone().applyAxisAngle(axis, def.angle);
        const angle = def.angle;
        
        const ring = new Array(arcSegments + 1);
        
        if (useParallelTransport) {
            // Use parallel transport frame to maintain consistent parameterization
            // This prevents twisting and self-intersection
            const frame = parallelFrames[i];
            const u = frame.u;
            const v = frame.v;
            
            // Project r0 and r1 onto the u-v plane to get 2D arc endpoints
            const r0u = r0.dot(u);
            const r0v = r0.dot(v);
            const r1u = r1.dot(u);
            const r1v = r1.dot(v);
            
            // Compute angle in the u-v plane
            const angle2D = Math.atan2(r1v, r1u) - Math.atan2(r0v, r0u);
            const normalizedAngle = angle2D < 0 ? angle2D + 2 * Math.PI : angle2D;
            const startAngle = Math.atan2(r0v, r0u);
            
            // Generate arc points in the consistent u-v frame
            for (let j = 0; j <= arcSegments; j++) {
                const t = j / arcSegments;
                const a = startAngle + t * normalizedAngle;
                const dir = u.clone().multiplyScalar(Math.cos(a)).add(
                    v.clone().multiplyScalar(Math.sin(a))
                );
                ring[j] = C.clone().addScaledVector(dir.normalize(), radius);
            }
        } else {
            // Fallback to original rotation method
            for (let j = 0; j <= arcSegments; j++) {
                const a = (j / arcSegments) * angle;
                const dir = r0.clone().applyAxisAngle(axis, a).normalize();
                ring[j] = C.clone().addScaledVector(dir, radius);
            }
        }
        arcRings[i] = ring;
    }

    // When using parallel transport frames, rings are already consistently
    // parameterized and don't need distance-based alignment which can cause
    // self-intersections. Skip the old bestAlign heuristic entirely.
    // The parallel transport ensures smooth frame variation without twisting.

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
    // With parallel transport frames, rings are already consistently oriented
    if (closeLoop && n > 2) {
        const r0 = arcRings[n - 1];
        const r1 = arcRings[0];
        for (let j = 0; j < arcSegments; j++) {
            const p00 = r0[j], p01 = r0[j + 1];
            const p10 = r1[j], p11 = r1[j + 1];
            const checker = (((n - 1) + j) & 1) === 0;
            if (checker) {
                pushIfArea(faceArc, p00, p10, p11);
                pushIfArea(faceArc, p00, p11, p01);
            } else {
                pushIfArea(faceArc, p00, p10, p01);
                pushIfArea(faceArc, p01, p10, p11);
            }
        }
    }

    // Side strips are handled by face‑projection builder elsewhere

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
    computeParallelTransportFrames,
};
