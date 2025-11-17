import { Solid } from "../BetterSolid.js";
import * as THREE from 'three';
import {
    getScaleAdaptiveTolerance,
    getDistanceTolerance,
    getAngleTolerance,
    trimFilletCaches,
    getCachedFaceDataForTris,
    averageFaceNormalObjectSpace,
    localFaceNormalAtPoint,
    projectPointOntoFaceTriangles,
    batchProjectPointsOntoFace,
    clamp,
    isFiniteVec3,
} from './inset.js';
import {
    solveCenterFromOffsetPlanesAnchored,
} from './outset.js';
import { offsetAndMovePoints } from "./offsetHelper.js";
import { TubeSolid } from "../Tube.js";

export { clearFilletCaches, trimFilletCaches } from './inset.js';
export { fixTJunctionsAndPatchHoles } from './outset.js';
























/**
 * Detect and smooth spikes in closed loop polylines.
 * Spikes are identified as points that deviate significantly from the smooth curve.
 * 
 * @param {Array} points Array of points {x, y, z}
 * @param {number} radius Expected fillet radius for scale reference
 * @param {number} tolerance Distance tolerance for spike detection
 * @returns {Array} Smoothed array of points
 */
function smoothClosedLoopSpikes(points, radius, tolerance) {
    // This function is now simplified - just return points as-is since we handle spikes differently
    return points;
}

/**
 * Compute the fillet centerline polyline for an input edge without building the fillet solid.
 *
 * Returns polylines for:
 *  - points: locus of arc centers (centerline)
 *  - tangentA: tangency curve on face A (cylinder-face A intersection)
 *  - tangentB: tangency curve on face B (cylinder-face B intersection)
 * All points are returned as objects {x,y,z} for readability.
 * Downstream consumers that require array triples are still supported
 * via Solid.addAuxEdge, which now accepts both objects and [x,y,z] arrays.
 *
 * @param {any} edgeObj Edge object (expects `.faces[0/1]`, `.userData.polylineLocal`, and `.parent` solid)
 * @param {number} radius Fillet radius (> 0)
 * @param {'INSET'|'OUTSET'} sideMode Preferred side relative to outward normals (default 'INSET')
 * @returns {{ points: {x:number,y:number,z:number}[], tangentA?: {x:number,y:number,z:number}[], tangentB?: {x:number,y:number,z:number}[], edge?: {x:number,y:number,z:number}[], closedLoop: boolean }}
 */
export function computeFilletCenterline(edgeObj, radius = 1, sideMode = 'INSET') {
    const out = { points: [], tangentA: [], tangentB: [], edge: [], closedLoop: false };
    try {
        if (!edgeObj || !Number.isFinite(radius) || radius <= 0) return out;
        const solid = edgeObj.parentSolid || edgeObj.parent;
        if (!solid) return out;
        const faceA = edgeObj.faces?.[0];
        const faceB = edgeObj.faces?.[1];
        if (!faceA || !faceB) return out;

        const polyLocal = edgeObj.userData?.polylineLocal;
        if (!Array.isArray(polyLocal) || polyLocal.length < 2) return out;

        // Tolerances (scale-adaptive to radius)
        const eps = getScaleAdaptiveTolerance(radius, 1e-12);
        const distTol = getDistanceTolerance(radius);
        const angleTol = getAngleTolerance();
        const vecLengthTol = getScaleAdaptiveTolerance(radius, 1e-14);

        // Average outward normals per face (object space)
        const nAavg = averageFaceNormalObjectSpace(solid, faceA.name);
        const nBavg = averageFaceNormalObjectSpace(solid, faceB.name);
        if (!isFiniteVec3(nAavg) || !isFiniteVec3(nBavg)) return out;

        // Fetch triangles and cached data for both faces once
        const trisA = solid.getFace(faceA.name);
        const trisB = solid.getFace(faceB.name);
        if (!Array.isArray(trisA) || !trisA.length || !Array.isArray(trisB) || !trisB.length) return out;

        // Create unique cache keys that include solid identity and geometry hash to prevent cross-contamination
        const solidId = solid.uuid || solid.name || solid.constructor.name;
        const geometryHashA = trisA.length > 0 ? `${trisA.length}_${trisA[0].p1?.[0]?.toFixed(3) || 0}` : '0';
        const geometryHashB = trisB.length > 0 ? `${trisB.length}_${trisB[0].p1?.[0]?.toFixed(3) || 0}` : '0';
        const faceKeyA = `${solidId}:${faceA.name}:${geometryHashA}`;
        const faceKeyB = `${solidId}:${faceB.name}:${geometryHashB}`;
        const faceDataA = getCachedFaceDataForTris(trisA, faceKeyA);
        const faceDataB = getCachedFaceDataForTris(trisB, faceKeyB);

        // Robust closed-loop detection (prefer flags, else compare endpoints)
        let isClosed = !!(edgeObj.closedLoop || edgeObj.userData?.closedLoop);
        if (!isClosed && polyLocal.length > 2) {
            const a = polyLocal[0];
            const b = polyLocal[polyLocal.length - 1];
            if (a && b) {
                const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
                const d2 = dx * dx + dy * dy + dz * dz;
                const eps2 = distTol * distTol;
                if (d2 <= eps2) isClosed = true;
            }
        }
        out.closedLoop = isClosed;

        // Build sampling points: original vertices + midpoints (wrap for closed)
        let samples;
        {
            const src = polyLocal.slice();
            if (isClosed && src.length > 2) {
                const a = src[0], b = src[src.length - 1];
                if (a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) src.pop();
            }

            const outPts = [];
            for (let i = 0; i < src.length; i++) {
                const a = src[i];
                outPts.push(new THREE.Vector3(a[0], a[1], a[2]));
                const j = i + 1;
                if (isClosed) {
                    const b = src[(i + 1) % src.length];
                    outPts.push(new THREE.Vector3(0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1]), 0.5 * (a[2] + b[2])));
                } else if (j < src.length) {
                    const b = src[j];
                    outPts.push(new THREE.Vector3(0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1]), 0.5 * (a[2] + b[2])));
                }
            }
            samples = outPts;
        }

        // Project samples to both faces and compute local normals
        const sampleCount = samples.length;
        const qAList = batchProjectPointsOntoFace(trisA, samples, faceDataA, faceKeyA);
        const qBList = batchProjectPointsOntoFace(trisB, samples, faceDataB, faceKeyB);
        const normalsA = new Array(sampleCount);
        const normalsB = new Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            normalsA[i] = localFaceNormalAtPoint(solid, faceA.name, qAList[i], faceDataA, faceKeyA) || nAavg;
            normalsB[i] = localFaceNormalAtPoint(solid, faceB.name, qBList[i], faceDataB, faceKeyB) || nBavg;
        }

        // Scratch vectors
        const tangent = new THREE.Vector3();
        const tempU = new THREE.Vector3();
        const tempV = new THREE.Vector3();
        const fallbackDir = new THREE.Vector3();
        const bisector3 = new THREE.Vector3();
        const avgNormalScratch = new THREE.Vector3();

        const rEff = Math.max(eps, radius);
        let centers = [];
        let tanA = [];
        let tanB = [];
        let edgePts = [];
        for (let i = 0; i < sampleCount; i++) {
            const p = samples[i];
            const pPrev = isClosed ? samples[(i - 1 + sampleCount) % sampleCount] : samples[Math.max(0, i - 1)];
            const pNext = isClosed ? samples[(i + 1) % sampleCount] : samples[Math.min(sampleCount - 1, i + 1)];

            tangent.copy(pNext).sub(pPrev);

            if (tangent.lengthSq() < vecLengthTol) continue;
            tangent.normalize();

            const qA = qAList[i];
            const qB = qBList[i];
            let nA = normalsA[i] || nAavg;
            let nB = normalsB[i] || nBavg;

            const vA3 = tempU.copy(nA).cross(tangent);
            const vB3 = tempV.copy(nB).cross(tangent);
            if (vA3.lengthSq() < eps || vB3.lengthSq() < eps) continue;
            vA3.normalize(); vB3.normalize();

            const u = vA3.clone();
            const v = new THREE.Vector3().crossVectors(tangent, u).normalize();
            const d0_2 = new THREE.Vector2(1, 0);
            const d1_2 = new THREE.Vector2(vB3.dot(u), vB3.dot(v));
            d1_2.normalize();
            const dot2 = clamp(d0_2.x * d1_2.x + d0_2.y * d1_2.y, -1, 1);
            const angAbs = Math.acos(dot2);
            const sinHalf = Math.sin(0.5 * angAbs);
            if (Math.abs(sinHalf) < angleTol) continue;
            const expectDist = rEff / Math.abs(sinHalf);

            // 2D inward normals in section plane for fallback
            const inA3 = tangent.clone().cross(vA3).negate();
            const inB3 = tangent.clone().cross(vB3).negate();
            const n0_2 = new THREE.Vector2(inA3.dot(u), inA3.dot(v)).normalize();
            const n1_2 = new THREE.Vector2(inB3.dot(u), inB3.dot(v)).normalize();
            let bis2 = new THREE.Vector2(n0_2.x + n1_2.x, n0_2.y + n1_2.y);
            const lenBis2 = bis2.length();
            if (lenBis2 > 1e-9) bis2.multiplyScalar(1 / lenBis2); else bis2.set(0, 0);

            // Solve with anchored offset planes in 3D
            const C_in = solveCenterFromOffsetPlanesAnchored(p, tangent, nA, qA, -1, nB, qB, -1, rEff);
            const C_out = solveCenterFromOffsetPlanesAnchored(p, tangent, nA, qA, +1, nB, qB, +1, rEff);
            let pick = (String(sideMode).toUpperCase() === 'OUTSET') ? 'out' : 'in';
            let center = (pick === 'in') ? (C_in || C_out) : (C_out || C_in);



            // Initial tangency points from center (used to refine/fallback)
            const sA = (pick === 'in') ? -1 : +1;
            const sB = sA;
            let tA = center ? center.clone().addScaledVector(nA, -sA * rEff) : p.clone();
            let tB = center ? center.clone().addScaledVector(nB, -sB * rEff) : p.clone();

            // Fallback if intersection failed
            if (!center) {
                if (bis2.lengthSq() > eps) {
                    const dir3 = fallbackDir.set(0, 0, 0).addScaledVector(u, bis2.x).addScaledVector(v, bis2.y);
                    if (pick === 'out') dir3.negate();
                    dir3.normalize();
                    center = p.clone().addScaledVector(dir3, expectDist);
                } else {
                    const avgN = avgNormalScratch.copy(nA).add(nB);
                    if (avgN.lengthSq() > eps) {
                        avgN.normalize();
                        const sign = (pick === 'in') ? -1 : 1;
                        center = p.clone().addScaledVector(avgN, sign * expectDist);
                    } else {
                        // give up on this sample
                        continue;
                    }
                }
            }

            // Optional refinement: if initial p->center distance far from expected, recompute
            const initialDist = center.distanceTo(p);
            const needsRefinement = Math.abs(initialDist - expectDist) > 0.1 * rEff;
            if (needsRefinement) {
                try {
                    const qA1 = projectPointOntoFaceTriangles(trisA, tA, faceDataA);
                    const qB1 = projectPointOntoFaceTriangles(trisB, tB, faceDataB);
                    const nA1 = localFaceNormalAtPoint(solid, faceA.name, qA1, faceDataA, faceKeyA) || nAavg;
                    const nB1 = localFaceNormalAtPoint(solid, faceB.name, qB1, faceDataB, faceKeyB) || nBavg;
                    const C_ref = solveCenterFromOffsetPlanesAnchored(p, tangent, nA1, qA1, sA, nB1, qB1, sB, rEff);
                    if (C_ref) {
                        center = C_ref;
                        // Update normals used at tangency too
                        nA = nA1;
                        nB = nB1;
                        tA = center.clone().addScaledVector(nA, -sA * rEff);
                        tB = center.clone().addScaledVector(nB, -sB * rEff);
                    }
                } catch { /* ignore */ }
            }

            // Safety cap: if center is unreasonably far, snap to 2D bisector expectation
            {
                const pToC = center.distanceTo(p);
                const hardCap = 6 * rEff;
                const factor = 3.0;
                if (!Number.isFinite(pToC) || pToC > hardCap || pToC > factor * expectDist) {
                    let dir2 = new THREE.Vector2(bis2.x, bis2.y);
                    if (String(sideMode).toUpperCase() === 'OUTSET') dir2.multiplyScalar(-1);
                    if (dir2.lengthSq() > 1e-16) {
                        dir2.normalize();
                        const dir3 = bisector3.set(0, 0, 0).addScaledVector(u, dir2.x).addScaledVector(v, dir2.y).normalize();
                        center = p.clone().addScaledVector(dir3, expectDist);
                        // Recompute tangency points using latest normals
                        tA = center.clone().addScaledVector(nA, -sA * rEff);
                        tB = center.clone().addScaledVector(nB, -sB * rEff);
                    }
                }
            }

            centers.push({ x: center.x, y: center.y, z: center.z });
            tanA.push({ x: tA.x, y: tA.y, z: tA.z });
            tanB.push({ x: tB.x, y: tB.y, z: tB.z });
            edgePts.push({ x: p.x, y: p.y, z: p.z });
        }

        // For closed loops, explicitly duplicate the start point at the end
        // so the centerline is a closed polyline (last point equals first point).
        if (isClosed && centers.length >= 2) {
            const firstCenter = centers[0];
            const lastCenter = centers[centers.length - 1];

            const exactlyEqual = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

            if (!exactlyEqual(firstCenter, lastCenter)) {
                // Always append an explicit duplicate of the first point
                centers.push({ x: firstCenter.x, y: firstCenter.y, z: firstCenter.z });

                // Mirror closure on tangency curves and sampled edge points to keep arrays aligned
                if (tanA.length > 0) {
                    const a0 = tanA[0];
                    tanA.push({ x: a0.x, y: a0.y, z: a0.z });
                }
                if (tanB.length > 0) {
                    const b0 = tanB[0];
                    tanB.push({ x: b0.x, y: b0.y, z: b0.z });
                }
                if (edgePts.length > 0) {
                    const e0 = edgePts[0];
                    edgePts.push({ x: e0.x, y: e0.y, z: e0.z });
                }
            }
        }





        // out.points = !isClosed ? reorderPolyLine(centers) : centers;
        // out.tangentA = !isClosed ? reorderPolyLine(tanA) : tanA;
        // out.tangentB = !isClosed ? reorderPolyLine(tanB) : tanB;
        // out.edge = !isClosed ? reorderPolyLine(edgePts) : edgePts;


        out.points = centers;
        out.tangentA = tanA;
        out.tangentB = tanB;
        out.edge = edgePts;



        fixPolylineWinding(centers, tanA, tanB);



        return out;
    } catch (e) {
        console.warn('[computeFilletCenterline] failed:', e?.message || e);
        return out;
    }
}

function pointToPointDistance(a, b) {
    const ax = Array.isArray(a) ? a[0] : a?.x; const ay = Array.isArray(a) ? a[1] : a?.y; const az = Array.isArray(a) ? a[2] : a?.z;
    const bx = Array.isArray(b) ? b[0] : b?.x; const by = Array.isArray(b) ? b[1] : b?.y; const bz = Array.isArray(b) ? b[2] : b?.z;
    const dx = (ax - bx); const dy = (ay - by); const dz = (az - bz);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function findClosestPointInSet(pt, pointsArray) {
    // skip consumed points
    let minDist = Infinity;
    let closestPoint = null;
    for (const p of pointsArray) {
        if (p.consumed) continue;
        const dist = pointToPointDistance(pt, p);
        if (dist < minDist) {
            minDist = dist;
            closestPoint = p;
        }
    }
    return closestPoint;
}

function reorderPolyLine(pointsArray) {
    const returnPoints = [];

    // add first point to return array
    returnPoints.push(pointsArray[0]);
    pointsArray[0].consumed = true;

    // set the last point in the points array to be marked as consumed
    pointsArray[pointsArray.length - 1].consumed = true;

    // iteratively find closest point to last added point excluding the last point
    while (returnPoints.length < pointsArray.length) {
        const lastPoint = returnPoints[returnPoints.length - 1];
        const nextPoint = findClosestPointInSet(lastPoint, pointsArray);
        if (!nextPoint) break; // no more points found
        returnPoints.push(nextPoint);
        nextPoint.consumed = true;
    }

    // add the last point to close the loop
    returnPoints.push(pointsArray[pointsArray.length - 1]);

    return returnPoints;
}

/**
 * Fix polyline winding order to ensure consistent triangle orientation.
 * Checks all three polylines (centerline, tangentA, tangentB) for consistent winding.
 * 
 * @param {Array} centerline - Array of center points {x, y, z}
 * @param {Array} tangentA - Array of tangent A points {x, y, z}  
 * @param {Array} tangentB - Array of tangent B points {x, y, z}
 * @returns {Object} - {centerlineReversed: boolean, tangentAReversed: boolean, tangentBReversed: boolean}
 */
// Decide which polylines to reverse so that point i across
// centerline/tangentA/tangentB correspond to a consistent cross‑section.
// Uses an objective based on how close the tangent points are to the fillet
// radius from the centerline at sampled indices (quarter/half/three‑quarter).
// Falls back to direction/cross heuristics when radius is unavailable.
function fixPolylineWinding(centerline, tangentA, tangentB, expectedRadius = null) {
    try {
        console.log('Analyzing polyline winding directions...');
        // Fast-path: if any array is too small or lengths differ, do nothing
        if (!Array.isArray(centerline) || !Array.isArray(tangentA) || !Array.isArray(tangentB)) {
            return { centerlineReversed: false, tangentAReversed: false, tangentBReversed: false };
        }
        const n = Math.min(centerline.length, tangentA.length, tangentB.length);
        if (n < 3) {
            return { centerlineReversed: false, tangentAReversed: false, tangentBReversed: false };
        }

        // If we have a target radius, use it to search over combinations of
        // {reverse centerline, reverse A, reverse B} that best satisfy
        // dist(center[i], tangentX[i]) ≈ radius at a few sample locations.
        if (Number.isFinite(expectedRadius) && expectedRadius > 0) {
            const dist = (p, q) => {
                const dx = (q.x - p.x), dy = (q.y - p.y), dz = (q.z - p.z);
                return Math.hypot(dx, dy, dz);
            };

            // Choose robust sample indices near 1/4, 1/2, 3/4 along the polyline
            const idxs = [];
            const idxFromT = (t) => Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
            const pushUnique = (i) => { if (!idxs.includes(i)) idxs.push(i); };
            pushUnique(idxFromT(0.25));
            pushUnique(idxFromT(0.5));
            pushUnique(idxFromT(0.75));

            const combos = [
                [false, false, false],
                [false, true, false],
                [false, false, true],
                [true, false, false],
                [true, true, false],
                [true, false, true],
                [false, true, true],
                [true, true, true]
            ];

            let best = { cost: Infinity, rc: false, ra: false, rb: false };
            for (const [rc, ra, rb] of combos) {
                let cost = 0;
                for (const i of idxs) {
                    const ci = centerline[rc ? (n - 1 - i) : i];
                    const ai = tangentA[ra ? (n - 1 - i) : i];
                    const bi = tangentB[rb ? (n - 1 - i) : i];
                    const dA = dist(ci, ai);
                    const dB = dist(ci, bi);
                    // Sum absolute deviations from expected radius
                    cost += Math.abs(dA - expectedRadius) + Math.abs(dB - expectedRadius);
                }
                if (cost < best.cost) best = { cost, rc, ra, rb };
            }

            if (best.cost < Infinity) {
                return {
                    centerlineReversed: best.rc,
                    tangentAReversed: best.ra,
                    tangentBReversed: best.rb
                };
            }
        }

        // Primary heuristic: align the progression direction of tangents to the centerline.
        // We compare average segment directions (normalized sum) and flip if the dot is negative.
        const avgDir = (pts) => {
            let sx = 0, sy = 0, sz = 0;
            for (let i = 0; i < n - 1; i++) {
                const a = pts[i], b = pts[i + 1];
                sx += (b.x - a.x); sy += (b.y - a.y); sz += (b.z - a.z);
            }
            const len = Math.hypot(sx, sy, sz) || 1;
            return { x: sx / len, y: sy / len, z: sz / len };
        };
        const cDir = avgDir(centerline);
        const aDir = avgDir(tangentA);
        const bDir = avgDir(tangentB);

        const dot = (u, v) => (u.x * v.x + u.y * v.y + u.z * v.z);
        let centerlineReversed = false;
        let tangentAReversed = false;
        let tangentBReversed = false;

        // If a tangent flows opposite the centerline, flip it.
        if (dot(cDir, aDir) < 0) tangentAReversed = true;
        if (dot(cDir, bDir) < 0) tangentBReversed = true;

        // If both tangents are flipped by the above, it may be easier to flip the centerline
        // instead to keep A/B in their original indexing. Choose the minimal total reversals.
        if (tangentAReversed && tangentBReversed) {
            centerlineReversed = true;
            tangentAReversed = false;
            tangentBReversed = false;
        }

        // Secondary heuristic (legacy): examine relative cross-product signs to detect
        // inconsistent relationships. This complements the direction-alignment above
        // and only proposes additional flips if still inconsistent.
        // Sample several points along the polylines to determine consistent orientation
        const sampleCount = Math.min(8, Math.floor(centerline.length / 3));
        const sampleIndices = [];
        for (let i = 1; i < sampleCount - 1; i++) {
            const idx = Math.floor(i * (centerline.length - 2) / (sampleCount - 1));
            if (idx + 1 < centerline.length) {
                sampleIndices.push(idx);
            }
        }

        let centerlineToTangentA_CrossProducts = [];
        let centerlineToTangentB_CrossProducts = [];
        let tangentAToTangentB_CrossProducts = [];

        // Analyze the relationship between each pair of polylines
        for (const idx of sampleIndices) {
            if (idx + 1 >= centerline.length) continue;

            const c1 = centerline[idx];
            const c2 = centerline[idx + 1];
            const tA1 = tangentA[idx];
            const tA2 = tangentA[idx + 1];
            const tB1 = tangentB[idx];
            const tB2 = tangentB[idx + 1];

            // Validate all points are finite
            if (!isValidPoint(c1) || !isValidPoint(c2) ||
                !isValidPoint(tA1) || !isValidPoint(tA2) ||
                !isValidPoint(tB1) || !isValidPoint(tB2)) {
                continue; // Skip this sample if any point is invalid
            }

            // Vector along centerline
            const centerVec = { x: c2.x - c1.x, y: c2.y - c1.y, z: c2.z - c1.z };

            // Vector along tangent A
            const tangentAVec = { x: tA2.x - tA1.x, y: tA2.y - tA1.y, z: tA2.z - tA1.z };

            // Vector along tangent B
            const tangentBVec = { x: tB2.x - tB1.x, y: tB2.y - tB1.y, z: tB2.z - tB1.z };

            // Vector from centerline to tangent A
            const centerToTangentA = { x: tA1.x - c1.x, y: tA1.y - c1.y, z: tA1.z - c1.z };

            // Vector from centerline to tangent B
            const centerToTangentB = { x: tB1.x - c1.x, y: tB1.y - c1.y, z: tB1.z - c1.z };

            // Vector from tangent A to tangent B
            const tangentAToTangentB = { x: tB1.x - tA1.x, y: tB1.y - tA1.y, z: tB1.z - tA1.z };

            // Calculate cross products to determine relative orientations
            // We'll use the dot product of cross products with a consistent reference vector

            // Cross product: centerline direction × (center to tangentA)
            const cross1 = {
                x: centerVec.y * centerToTangentA.z - centerVec.z * centerToTangentA.y,
                y: centerVec.z * centerToTangentA.x - centerVec.x * centerToTangentA.z,
                z: centerVec.x * centerToTangentA.y - centerVec.y * centerToTangentA.x
            };

            // Cross product: centerline direction × (center to tangentB)
            const cross2 = {
                x: centerVec.y * centerToTangentB.z - centerVec.z * centerToTangentB.y,
                y: centerVec.z * centerToTangentB.x - centerVec.x * centerToTangentB.z,
                z: centerVec.x * centerToTangentB.y - centerVec.y * centerToTangentB.x
            };

            // Cross product: tangentA direction × (tangentA to tangentB)
            const cross3 = {
                x: tangentAVec.y * tangentAToTangentB.z - tangentAVec.z * tangentAToTangentB.y,
                y: tangentAVec.z * tangentAToTangentB.x - tangentAVec.x * tangentAToTangentB.z,
                z: tangentAVec.x * tangentAToTangentB.y - tangentAVec.y * tangentAToTangentB.x
            };

            // Use the magnitude of the Z component as a simple 2D projection heuristic
            centerlineToTangentA_CrossProducts.push(cross1.z);
            centerlineToTangentB_CrossProducts.push(cross2.z);
            tangentAToTangentB_CrossProducts.push(cross3.z);
        }

        // Analyze the consistency of cross products
        const validCenterToA = centerlineToTangentA_CrossProducts.filter(x => isFinite(x));
        const validCenterToB = centerlineToTangentB_CrossProducts.filter(x => isFinite(x));
        const validAToB = tangentAToTangentB_CrossProducts.filter(x => isFinite(x));

        const avgCenterToA = validCenterToA.length > 0 ?
            validCenterToA.reduce((a, b) => a + Math.sign(b), 0) / validCenterToA.length : 0;
        const avgCenterToB = validCenterToB.length > 0 ?
            validCenterToB.reduce((a, b) => a + Math.sign(b), 0) / validCenterToB.length : 0;
        const avgAToB = validAToB.length > 0 ?
            validAToB.reduce((a, b) => a + Math.sign(b), 0) / validAToB.length : 0;

        console.log(`Winding analysis:
            Center→TangentA avg: ${avgCenterToA.toFixed(3)}
            Center→TangentB avg: ${avgCenterToB.toFixed(3)}
            TangentA→TangentB avg: ${avgAToB.toFixed(3)}`);

        // Decision logic for which polylines to reverse (augmenting primary heuristic)
        console.log('Winding analysis results:');
        console.log(`  Center→A: ${avgCenterToA.toFixed(3)}`);
        console.log(`  Center→B: ${avgCenterToB.toFixed(3)}`);
        console.log(`  A→B: ${avgAToB.toFixed(3)}`);

        // For a proper fillet, we expect:
        // 1. Centerline and tangents should have consistent progression direction
        // 2. Tangent A and B should generally go in opposite directions relative to each other
        // 3. All three should form a consistent right-handed coordinate system

        const centerRelationshipInconsistent = (avgCenterToA > 0) !== (avgCenterToB > 0);
        const tangentsGoSameDirection = avgAToB > 0.5; // Strong positive correlation means same direction
        const tangentsGoOppositeDirection = avgAToB < -0.5; // Strong negative correlation means opposite directions

        if (centerRelationshipInconsistent && !(centerlineReversed || tangentAReversed || tangentBReversed)) {
            console.log('Detected inconsistent centerline-to-tangent relationships');

            // If centerline relationships are inconsistent AND tangents go in same direction,
            // this suggests the centerline itself might need reversal
            if (tangentsGoSameDirection) {
                console.log('Tangents go in same direction with inconsistent center relationships - reversing centerline');
                centerlineReversed = true;
            } else {
                // Heuristic: reverse the tangent with stronger inconsistency
                if (Math.abs(avgCenterToB) > Math.abs(avgCenterToA)) {
                    tangentBReversed = true;
                    console.log('Reversing tangent B based on center relationship analysis');
                } else {
                    tangentAReversed = true;
                    console.log('Reversing tangent A based on center relationship analysis');
                }
            }
        } else if (tangentsGoSameDirection && !(centerlineReversed || tangentAReversed || tangentBReversed)) {
            // Even if center relationships are consistent, if tangents go in same direction,
            // we likely need to reverse one tangent
            console.log('Tangents go in same direction - reversing tangent B to create opposing flow');
            tangentBReversed = true;
        }

        // Additional check: if all relationships are weak, there might be a fundamental issue
        if (Math.abs(avgCenterToA) < 0.2 && Math.abs(avgCenterToB) < 0.2 && Math.abs(avgAToB) < 0.2) {
            console.log('All winding relationships are weak - polylines may be nearly perpendicular or have issues');
        }

        return {
            centerlineReversed,
            tangentAReversed,
            tangentBReversed
        };
    } catch (error) {
        console.warn('Winding order analysis failed:', error?.message || error);
        return { centerlineReversed: false, tangentAReversed: false, tangentBReversed: false };
    }
}

/**
 * Convenience: compute and attach the fillet centerline as an auxiliary edge on a Solid.
 *
 * @param {any} solid Target solid to receive the aux edge (overlay)
 * @param {any} edgeObj Edge to analyze (must belong to `solid`)
 * @param {number} radius Fillet radius (>0)
 * @param {'INSET'|'OUTSET'} sideMode Side preference
 * @param {string} name Edge name (default 'FILLET_CENTERLINE')
 * @param {object} options Additional aux edge options (materialKey defaults to 'OVERLAY')
 * @returns {{ points: {x:number,y:number,z:number}[], closedLoop: boolean } | null}
 */
export function attachFilletCenterlineAuxEdge(solid, edgeObj, radius = 1, sideMode = 'INSET', name = 'FILLET_CENTERLINE', options = {}) {
    try {
        if (!solid || !edgeObj) return null;
        const res = computeFilletCenterline(edgeObj, radius, sideMode);
        if (res && Array.isArray(res.points) && res.points.length >= 2) {
            const opts = { materialKey: 'OVERLAY', closedLoop: !!res.closedLoop, ...(options || {}) };
            solid.addAuxEdge(name, res.points, opts);
            return res;
        }
        return null;
    } catch (e) {
        console.warn('[attachFilletCenterlineAuxEdge] failed:', e?.message || e);
        return null;
    }
}


// Functional API: builds fillet tube and wedge and returns them.
export function filletSolid({ edgeToFillet, radius = 1, sideMode = 'INSET', debug = false, name = 'fillet', inflate = 0.1 } = {}) {
    try {
        // Validate inputs
        if (!edgeToFillet) {
            throw new Error('filletSolid: edgeToFillet is required');
        }
        if (!Number.isFinite(radius) || radius <= 0) {
            throw new Error(`filletSolid: radius must be a positive number, got ${radius}`);
        }

        const side = String(sideMode).toUpperCase();
        console.log(`🔧 Starting fillet operation: edge=${edgeToFillet?.name || 'unnamed'}, radius=${radius}, side=${side}`);

        const res = computeFilletCenterline(edgeToFillet, radius, side);
        console.log('The fillet centerline result is:', res);

        if (!res) {
            throw new Error('computeFilletCenterline returned null/undefined');
        }

        const centerline = Array.isArray(res?.points) ? res.points : [];
        let tangentA = Array.isArray(res?.tangentA) ? res.tangentA : [];
        let tangentB = Array.isArray(res?.tangentB) ? res.tangentB : [];
        let edgePts = Array.isArray(res?.edge) ? res.edge : [];
        const closedLoop = !!res?.closedLoop;

        if (debug) {
            try { console.log('filletSolid: centerline/tangent edges computed'); } catch { }
        }

        // Clone into plain objects
        const centerlineCopy = centerline.map(pt => ({ x: pt.x, y: pt.y, z: pt.z }));
        let tangentACopy = tangentA.map(pt => ({ x: pt.x, y: pt.y, z: pt.z }));
        let tangentBCopy = tangentB.map(pt => ({ x: pt.x, y: pt.y, z: pt.z }));
        let edgeCopy = edgePts.map(pt => ({ x: pt.x, y: pt.y, z: pt.z }));
        // Working copy of the original edge points used for wedge construction.
        // Kept separate from `edgeCopy` so we can apply small insets/offsets without
        // disturbing other consumers that rely on the original edge sampling.
        let edgeWedgeCopy = edgeCopy.map(pt => ({ x: pt.x, y: pt.y, z: pt.z }));

        // Visualize original centerline in yellow before any manipulation
        if (debug && centerlineCopy.length >= 2) {
            console.log('🟡 ORIGINAL CENTERLINE (Yellow):');
            const originalVisualization = new Solid();
            originalVisualization.name = `${name}_ORIGINAL_CENTERLINE`;

            // Add centerline as line segments
            for (let i = 0; i < centerlineCopy.length - 1; i++) {
                const p1 = centerlineCopy[i];
                const p2 = centerlineCopy[i + 1];
                console.log(`  Segment ${i}: (${p1.x.toFixed(3)}, ${p1.y.toFixed(3)}, ${p1.z.toFixed(3)}) → (${p2.x.toFixed(3)}, ${p2.y.toFixed(3)}, ${p2.z.toFixed(3)})`);
            }

            // Convert to array format for addAuxEdge
            const originalCenterlineArray = centerlineCopy.map(pt => [pt.x, pt.y, pt.z]);
            originalVisualization.addAuxEdge('ORIGINAL_CENTERLINE', originalCenterlineArray, {
                materialKey: 'YELLOW',
                closedLoop: closedLoop,
                lineWidth: 3.0
            });

            try {
                originalVisualization.visualize();
                console.log('🟡 Original centerline visualization created (Yellow)');
            } catch (vizError) {
                console.warn('Failed to visualize original centerline:', vizError?.message || vizError);
            }
        }

        console.log('Checking all polyline winding orders...');
        if (centerlineCopy.length >= 2) {
            const c1 = centerlineCopy[0];
            const c2 = centerlineCopy[1];
            const cLast = centerlineCopy[centerlineCopy.length - 1];
            console.log(`Centerline: start=(${c1.x.toFixed(3)}, ${c1.y.toFixed(3)}, ${c1.z.toFixed(3)}) → (${c2.x.toFixed(3)}, ${c2.y.toFixed(3)}, ${c2.z.toFixed(3)}) ... end=(${cLast.x.toFixed(3)}, ${cLast.y.toFixed(3)}, ${cLast.z.toFixed(3)})`);
        }

        // Validate polyline data integrity before processing
        const validatePolylines = () => {
            const n = Math.min(centerlineCopy.length, tangentACopy.length, tangentBCopy.length, edgeCopy.length);
            for (let i = 0; i < n; i++) {
                const c = centerlineCopy[i];
                const tA = tangentACopy[i];
                const tB = tangentBCopy[i];
                const e = edgeCopy[i];
                if (!isFiniteVec3(c) || !isFiniteVec3(tA) || !isFiniteVec3(tB) || !isFiniteVec3(e)) {
                    // Only offset the wedge edge points (edgeWedgeCopy) inward toward the centerline
                    // Prepare wedge edge points (copy and offset inward)
                    let edgeWedgeCopy = edgeCopy.map(pt => ({ x: pt.x, y: pt.y, z: pt.z }));
                    const wedgeInsetDistance = -0.05; // Negative to push inward
                    for (let i = 0; i < edgeWedgeCopy.length; i++) {
                        const edgePt = edgeWedgeCopy[i];
                        const centerPt = centerlineCopy[i] || centerlineCopy[centerlineCopy.length - 1];
                        if (edgePt && centerPt) {
                            // Direction from edge to centerline
                            const dx = centerPt.x - edgePt.x;
                            const dy = centerPt.y - edgePt.y;
                            const dz = centerPt.z - edgePt.z;
                            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                            if (len > 1e-12) {
                                edgePt.x += (dx / len) * Math.abs(wedgeInsetDistance);
                                edgePt.y += (dy / len) * Math.abs(wedgeInsetDistance);
                                edgePt.z += (dz / len) * Math.abs(wedgeInsetDistance);
                            }
                        }
                    }
                    console.log(`Applied wedge inset of ${Math.abs(wedgeInsetDistance)} units to edge points only`);

                    // Make edgeWedgeCopy available for wedge construction
                }
            }
        }

        // Apply a small offset to the tangent curves relative to the centerline.
        // Keep OUTSET behavior unchanged: move tangents slightly toward the centerline;
        // INSET moves them outward. Closed loops skip inflation to avoid self‑intersection.
        {
            const base = Math.abs(inflate || 0);
            const offsetDistance = base;
            const n = Math.min(centerlineCopy.length, tangentACopy.length, tangentBCopy.length);
            for (let i = 0; i < n; i++) {
                const c = centerlineCopy[i];
                const ta = tangentACopy[i];
                const tb = tangentBCopy[i];
                if (c && ta) {
                    const dax = ta.x - c.x, day = ta.y - c.y, daz = ta.z - c.z;
                    const daL = Math.hypot(dax, day, daz);
                    if (daL > 1e-12) {
                        ta.x += (dax / daL) * offsetDistance;
                        ta.y += (day / daL) * offsetDistance;
                        ta.z += (daz / daL) * offsetDistance;
                    }
                }
                if (c && tb) {
                    const dbx = tb.x - c.x, dby = tb.y - c.y, dbz = tb.z - c.z;
                    const dbL = Math.hypot(dbx, dby, dbz);
                    if (dbL > 1e-12) {
                        tb.x += (dbx / dbL) * offsetDistance;
                        tb.y += (dby / dbL) * offsetDistance;
                        tb.z += (dbz / dbL) * offsetDistance;
                    }
                }
            }
            try { if (offsetDistance) console.log(`Applied tangent offsetDistance=${offsetDistance} to ${n} samples`); } catch { }
        }

        // Push wedge edge points slightly relative to the centerline to ensure
        // the wedge doesn't extend beyond the original geometry. For OUTSET this
        // nudge is inward (toward the centerline). For INSET it must be the
        // opposite direction (away from the centerline) to build the correct wedge.
        // Slightly offset edge points to guarantee robust boolean overlap.
        // Preserve OUTSET behavior (unchanged): use a small fixed nudge.
        // INSET uses the same magnitude but opposite direction to ensure the
        // cutter exits the target.
        const wedgeInsetMagnitude = closedLoop ? 0 : ((side === 'INSET') ? inflate : -0.05);
        for (let i = 0; i < edgeWedgeCopy.length; i++) {
            const edgeWedgePt = edgeWedgeCopy[i];
            const centerPt = centerlineCopy[i] || centerlineCopy[centerlineCopy.length - 1]; // Fallback to last point
            const tanAPt = tangentACopy[i] || tangentACopy[tangentACopy.length - 1];
            const tanBPt = tangentBCopy[i] || tangentBCopy[tangentBCopy.length - 1];

            if (edgeWedgePt && centerPt) {
                try {
                    const origWedgeEdge = { ...edgeWedgePt };

                    // Calculate direction from edge point toward the centerline (inward direction)
                    const inwardDir = {
                        x: centerPt.x - edgeWedgePt.x,
                        y: centerPt.y - edgeWedgePt.y,
                        z: centerPt.z - edgeWedgePt.z
                    };
                    const inwardLength = Math.sqrt(inwardDir.x * inwardDir.x + inwardDir.y * inwardDir.y + inwardDir.z * inwardDir.z);

                    if (inwardLength > 1e-12) {
                        // Normalize and apply inset
                        const normalizedInward = {
                            x: inwardDir.x / inwardLength,
                            y: inwardDir.y / inwardLength,
                            z: inwardDir.z / inwardLength
                        };
                        // Determine direction: OUTSET -> inward, INSET -> outward (opposite)
                        const dirSign = (side === 'INSET') ? -1 : 1;
                        const step = dirSign * wedgeInsetMagnitude;
                        // Apply
                        edgeWedgePt.x += normalizedInward.x * step;
                        edgeWedgePt.y += normalizedInward.y * step;
                        edgeWedgePt.z += normalizedInward.z * step;

                        // Validate the result
                        if (!isFiniteVec3(edgeWedgePt)) {
                            console.warn(`Invalid wedge edge point after inset at index ${i}, reverting to original`);
                            Object.assign(edgeWedgePt, origWedgeEdge);
                        }
                    } else {
                        console.warn(`Edge point ${i} is too close to centerline, skipping wedge inset`);
                    }
                } catch (insetError) {
                    console.warn(`Wedge edge inset failed at index ${i}: ${insetError?.message || insetError}`);
                }
            }
        }

        if (wedgeInsetMagnitude) console.log(`Applied wedge inset of ${wedgeInsetMagnitude} units (${side === 'INSET' ? 'outward' : 'inward'}) to ${edgeWedgeCopy.length} edge points`);


        // Do not reorder edge points. Centerline/tangent/edge points are produced in
        // lockstep elsewhere; reindexing the edge points breaks correspondence and
        // can create long crossing triangles. If orientation issues arise, reverse
        // the entire polylines together rather than reordering indices.

        // Visualize manipulated centerline after all processing
        if (debug && centerlineCopy.length >= 2) {
            console.log('🔵 MANIPULATED CENTERLINE (Blue):');
            const manipulatedVisualization = new Solid();
            manipulatedVisualization.name = `${name}_MANIPULATED_CENTERLINE`;

            // Add manipulated centerline as line segments
            for (let i = 0; i < centerlineCopy.length - 1; i++) {
                const p1 = centerlineCopy[i];
                const p2 = centerlineCopy[i + 1];
                console.log(`  Segment ${i}: (${p1.x.toFixed(3)}, ${p1.y.toFixed(3)}, ${p1.z.toFixed(3)}) → (${p2.x.toFixed(3)}, ${p2.y.toFixed(3)}, ${p2.z.toFixed(3)})`);
            }

            // Convert to array format for addAuxEdge
            const manipulatedCenterlineArray = centerlineCopy.map(pt => [pt.x, pt.y, pt.z]);
            manipulatedVisualization.addAuxEdge('MANIPULATED_CENTERLINE', manipulatedCenterlineArray, {
                materialKey: 'BLUE',
                closedLoop: closedLoop,
                lineWidth: 3.0
            });

            try {
                manipulatedVisualization.visualize();
                console.log('🔵 Manipulated centerline visualization created (Blue)');
            } catch (vizError) {
                console.warn('Failed to visualize manipulated centerline:', vizError?.message || vizError);
            }
        }

        console.log('centerlines all generated fine');

        // Validate spacing/variation for the path we will actually use for the tube
        const tubePathOriginal = Array.isArray(centerline) ? centerline : [];
        if (tubePathOriginal.length < 2) {
            console.error('Insufficient centerline points for tube generation');
            // Return debug information even on centerline failure
            return {
                tube: null,
                wedge: null,
                finalSolid: null,
                centerline: centerlineCopy || [],
                tangentA: tangentACopy || [],
                tangentB: tangentBCopy || [],
                error: 'Insufficient centerline points for tube generation'
            };
        }
        {
            const firstPt = tubePathOriginal[0];
            const hasVariation = tubePathOriginal.some(pt =>
                Math.abs(pt.x - firstPt.x) > 1e-6 ||
                Math.abs(pt.y - firstPt.y) > 1e-6 ||
                Math.abs(pt.z - firstPt.z) > 1e-6
            );
            if (!hasVariation) {
                console.error('Degenerate centerline: all points are identical');
                // Return debug information even on centerline failure
                return {
                    tube: null,
                    wedge: null,
                    finalSolid: null,
                    centerline: centerlineCopy || [],
                    tangentA: tangentACopy || [],
                    tangentB: tangentBCopy || [],
                    error: 'Degenerate centerline: all points are identical'
                };
            }
            const minSpacing = radius * 0.01;
            for (let i = 1; i < tubePathOriginal.length; i++) {
                const curr = tubePathOriginal[i];
                const prev = tubePathOriginal[i - 1];
                const distance = Math.hypot(curr.x - prev.x, curr.y - prev.y, curr.z - prev.z);
                if (distance < minSpacing) {
                    console.warn(`Centerline points ${i - 1} and ${i} are too close (distance: ${distance}), this may cause tube generation issues`);
                }
            }
        }

        // Build tube from the ORIGINAL centerline (not the modified copy)
        let filletTube = null;
        try {
            // TubeSolid expects [x,y,z] arrays; convert original {x,y,z} objects
            let tubePoints = tubePathOriginal.map(p => [p.x, p.y, p.z]);

            if (closedLoop) {
                console.log('Closed loop detected: preparing tube centerline...');
                // For closed loops: ensure the tube polyline has the same point at start and end
                if (tubePoints.length >= 2) {
                    const firstPt = tubePoints[0];
                    const lastPt = tubePoints[tubePoints.length - 1];

                    // Check if first and last points are different
                    const dx = firstPt[0] - lastPt[0];
                    const dy = firstPt[1] - lastPt[1];
                    const dz = firstPt[2] - lastPt[2];
                    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

                    // Add the first point at the end to close the loop
                    tubePoints.push([firstPt[0], firstPt[1], firstPt[2]]);
                    console.log('Closed loop: Added first point at end for tube generation');

                }
            } else {
                console.log('Non-closed loop detected: preparing tube centerline...');
                // For non-closed loops: extend the start and end segments of the centerline polyline for tube only
                if (tubePoints.length >= 2) {
                    console.log('Non-closed loop: Extending tube centerline segments...');
                    const extensionDistance = 0.1;

                    // Extend first segment backwards
                    const p0 = tubePoints[0];
                    const p1 = tubePoints[1];
                    const dir0 = [p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]];
                    const len0 = Math.sqrt(dir0[0] * dir0[0] + dir0[1] * dir0[1] + dir0[2] * dir0[2]);

                    if (len0 > 1e-12) {
                        const norm0 = [dir0[0] / len0, dir0[1] / len0, dir0[2] / len0];
                        const extendedStart = [
                            p0[0] + norm0[0] * extensionDistance,
                            p0[1] + norm0[1] * extensionDistance,
                            p0[2] + norm0[2] * extensionDistance
                        ];
                        tubePoints[0] = extendedStart;
                    }

                    // Extend last segment forwards
                    const lastIdx = tubePoints.length - 1;
                    const pLast = tubePoints[lastIdx];
                    const pPrev = tubePoints[lastIdx - 1];
                    const dirLast = [pLast[0] - pPrev[0], pLast[1] - pPrev[1], pLast[2] - pPrev[2]];
                    const lenLast = Math.sqrt(dirLast[0] * dirLast[0] + dirLast[1] * dirLast[1] + dirLast[2] * dirLast[2]);

                    if (lenLast > 1e-12) {
                        const normLast = [dirLast[0] / lenLast, dirLast[1] / lenLast, dirLast[2] / lenLast];
                        const extendedEnd = [
                            pLast[0] + normLast[0] * extensionDistance,
                            pLast[1] + normLast[1] * extensionDistance,
                            pLast[2] + normLast[2] * extensionDistance
                        ];
                        tubePoints[lastIdx] = extendedEnd;
                    }

                    console.log(`Extended tube centerline by ${extensionDistance} units at both ends`);
                }
            }

            const inflatedTubeRadius = radius * 1.01;
            filletTube = new TubeSolid({
                points: tubePoints,
                radius: inflatedTubeRadius,
                innerRadius: 0,
                resolution: 32,
                name: `${name}_TUBE`
            });

            // Store PMI metadata on the outer pipe face so downstream annotations
            // can recover the user radius instead of the inflated geometry value.
            try {
                const faceTag = `${name}_TUBE_Outer`;
                const overrideMeta = {
                    type: 'pipe',
                    source: 'FilletFeature',
                    featureID: name,
                    inflatedRadius: inflatedTubeRadius,
                    pmiRadiusOverride: radius,
                    radiusOverride: radius,
                };
                if (edgeToFillet?.name) overrideMeta.edgeReference = edgeToFillet.name;
                filletTube.setFaceMetadata(faceTag, overrideMeta);
            } catch {
                // Best-effort – lack of metadata should not abort fillet creation.
            }
        } catch (tubeError) {
            console.error('TubeSolid creation failed:', tubeError?.message || tubeError);

            // Return debug information even on tube failure
            const debugWedge = new Solid();
            debugWedge.name = `${name}_FAILED_TUBE_DEBUG`;
            return {
                tube: null,
                wedge: debugWedge,
                finalSolid: null,
                centerline: centerlineCopy,
                tangentA: tangentACopy,
                tangentB: tangentBCopy,
                error: `Tube generation failed: ${tubeError?.message || tubeError}`
            };
        }


        // Build wedge solid from triangles between centerline and tangency edges
        console.log('Creating wedge solid...');
        const wedgeSolid = new Solid();
        wedgeSolid.name = `${name}_WEDGE`;

        if (closedLoop) {
            // CLOSED LOOP PATH - preserve existing logic exactly
            try {
                const minTriangleArea = radius * radius * 1e-8;
                let validTriangles = 0;
                let skippedTriangles = 0;
                for (let i = 0; i < centerlineCopy.length - 1; i++) {
                    const c1 = centerlineCopy[i];
                    const c2 = centerlineCopy[i + 1];
                    const tA1 = tangentACopy[i];
                    const tA2 = tangentACopy[i + 1];
                    const tB1 = tangentBCopy[i];
                    const tB2 = tangentBCopy[i + 1];

                    const isValidTriangle = (p1, p2, p3) => {
                        const v1 = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z };
                        const v2 = { x: p3.x - p1.x, y: p3.y - p1.y, z: p3.z - p1.z };
                        const cross = {
                            x: v1.y * v2.z - v1.z * v2.y,
                            y: v1.z * v2.x - v1.x * v2.z,
                            z: v1.x * v2.y - v1.y * v2.x
                        };
                        const area = 0.5 * Math.sqrt(cross.x * cross.x + cross.y * cross.y + cross.z * cross.z);
                        return area > minTriangleArea;
                    };
                    const isValidPoint = (p) => isFinite(p.x) && isFinite(p.y) && isFinite(p.z);
                    const addTriangleWithValidation = (groupName, p1, p2, p3) => {
                        if (!isValidPoint(p1) || !isValidPoint(p2) || !isValidPoint(p3)) {
                            console.warn(`Invalid points detected - p1:(${p1.x},${p1.y},${p1.z}) p2:(${p2.x},${p2.y},${p2.z}) p3:(${p3.x},${p3.y},${p3.z})`);
                            return false;
                        }
                        wedgeSolid.addTriangle(groupName, [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z], [p3.x, p3.y, p3.z]);
                        return true;
                    };

                    // Tangent A side
                    if (isValidTriangle(c1, tA1, c2) && addTriangleWithValidation(`${name}_WEDGE_A`, c1, tA1, c2)) validTriangles++; else skippedTriangles++;
                    if (isValidTriangle(c2, tA1, tA2) && addTriangleWithValidation(`${name}_WEDGE_A`, c2, tA1, tA2)) validTriangles++; else skippedTriangles++;
                    // Tangent B side
                    if (isValidTriangle(c1, c2, tB1) && addTriangleWithValidation(`${name}_WEDGE_B`, c1, c2, tB1)) validTriangles++; else skippedTriangles++;
                    if (isValidTriangle(c2, tB2, tB1) && addTriangleWithValidation(`${name}_WEDGE_B`, c2, tB2, tB1)) validTriangles++; else skippedTriangles++;

                    // Side walls on original faces - use inset wedge edge points
                    const e1 = edgeWedgeCopy[i];
                    const e2 = edgeWedgeCopy[i + 1];
                    if (e1 && e2) {
                        if (isValidTriangle(e1, tA1, e2) && addTriangleWithValidation(`${name}_SIDE_A`, e1, tA1, e2)) validTriangles++; else skippedTriangles++;
                        if (isValidTriangle(e2, tA1, tA2) && addTriangleWithValidation(`${name}_SIDE_A`, e2, tA1, tA2)) validTriangles++; else skippedTriangles++;
                        if (isValidTriangle(e1, e2, tB1) && addTriangleWithValidation(`${name}_SIDE_B`, e1, e2, tB1)) validTriangles++; else skippedTriangles++;
                        if (isValidTriangle(e2, tB2, tB1) && addTriangleWithValidation(`${name}_SIDE_B`, e2, tB2, tB1)) validTriangles++; else skippedTriangles++;
                    }
                }
                console.log(`Wedge triangles added successfully (closed loop): ${validTriangles} valid, ${skippedTriangles} skipped`);
                if (validTriangles === 0) {
                    console.error('No valid triangles could be created for wedge solid - all were degenerate');
                    // Return debug information even on wedge failure
                    return {
                        tube: filletTube,
                        wedge: wedgeSolid,
                        finalSolid: null,
                        centerline: centerlineCopy,
                        tangentA: tangentACopy,
                        tangentB: tangentBCopy,
                        error: 'No valid triangles could be created for wedge solid - all were degenerate'
                    };
                }
            } catch (wedgeError) {
                console.error('Failed to create wedge triangles (closed loop):', wedgeError?.message || wedgeError);
                // Return debug information even on wedge error
                return {
                    tube: filletTube,
                    wedge: wedgeSolid,
                    finalSolid: null,
                    centerline: centerlineCopy,
                    tangentA: tangentACopy,
                    tangentB: tangentBCopy,
                    error: `Wedge triangle creation failed: ${wedgeError?.message || wedgeError}`
                };
            }
        } else {
            // NON-CLOSED LOOP PATH - specialized handling for open edges
            try {
                console.log('Creating wedge solid for non-closed loop...');
                const minTriangleArea = radius * radius * 1e-8;
                let validTriangles = 0;
                let skippedTriangles = 0;

                const isValidTriangle = (p1, p2, p3) => {
                    const v1 = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z };
                    const v2 = { x: p3.x - p1.x, y: p3.y - p1.y, z: p3.z - p1.z };
                    const cross = {
                        x: v1.y * v2.z - v1.z * v2.y,
                        y: v1.z * v2.x - v1.x * v2.z,
                        z: v1.x * v2.y - v1.y * v2.x
                    };
                    const area = 0.5 * Math.sqrt(cross.x * cross.x + cross.y * cross.y + cross.z * cross.z);
                    return area > minTriangleArea;
                };
                const isValidPoint = (p) => isFinite(p.x) && isFinite(p.y) && isFinite(p.z);
                const addTriangleWithValidation = (groupName, p1, p2, p3) => {
                    if (!isValidPoint(p1) || !isValidPoint(p2) || !isValidPoint(p3)) {
                        console.warn(`Invalid points detected - p1:(${p1.x},${p1.y},${p1.z}) p2:(${p2.x},${p2.y},${p2.z}) p3:(${p3.x},${p3.y},${p3.z})`);
                        return false;
                    }
                    wedgeSolid.addTriangle(groupName, [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z], [p3.x, p3.y, p3.z]);
                    return true;
                };

                // Create triangular strip along the fillet path
                // For open edges, we create a proper triangulated surface between centerline and tangent lines
                for (let i = 0; i < centerlineCopy.length - 1; i++) {
                    const c1 = centerlineCopy[i];
                    const c2 = centerlineCopy[i + 1];
                    const tA1 = tangentACopy[i];
                    const tA2 = tangentACopy[i + 1];
                    const tB1 = tangentBCopy[i];
                    const tB2 = tangentBCopy[i + 1];
                    const e1 = edgeWedgeCopy[i];
                    const e2 = edgeWedgeCopy[i + 1];

                    // Create triangulated surfaces between each pair of curves
                    // Surface between centerline and tangent A
                    if (isValidTriangle(c1, c2, tA1) && addTriangleWithValidation(`${name}_SURFACE_CA`, c1, c2, tA1)) validTriangles++; else skippedTriangles++;
                    if (isValidTriangle(c2, tA2, tA1) && addTriangleWithValidation(`${name}_SURFACE_CA`, c2, tA2, tA1)) validTriangles++; else skippedTriangles++;

                    // Surface between centerline and tangent B
                    if (isValidTriangle(c1, tB1, c2) && addTriangleWithValidation(`${name}_SURFACE_CB`, c1, tB1, c2)) validTriangles++; else skippedTriangles++;
                    if (isValidTriangle(c2, tB1, tB2) && addTriangleWithValidation(`${name}_SURFACE_CB`, c2, tB1, tB2)) validTriangles++; else skippedTriangles++;

                    // Surface between tangent A and edge (original face A)
                    if (e1 && e2) {
                        if (isValidTriangle(tA1, tA2, e1) && addTriangleWithValidation(`${name}_FACE_A`, tA1, tA2, e1)) validTriangles++; else skippedTriangles++;
                        if (isValidTriangle(tA2, e2, e1) && addTriangleWithValidation(`${name}_FACE_A`, tA2, e2, e1)) validTriangles++; else skippedTriangles++;

                        // Surface between tangent B and edge (original face B)  
                        if (isValidTriangle(tB1, e1, tB2) && addTriangleWithValidation(`${name}_FACE_B`, tB1, e1, tB2)) validTriangles++; else skippedTriangles++;
                        if (isValidTriangle(tB2, e1, e2) && addTriangleWithValidation(`${name}_FACE_B`, tB2, e1, e2)) validTriangles++; else skippedTriangles++;
                    }
                }

                // Add end caps for open edges to create a closed solid
                if (centerlineCopy.length >= 2) {
                    console.log('Adding end caps for non-closed loop...');

                    // First end cap
                    const firstC = centerlineCopy[0];
                    const firstTA = tangentACopy[0];
                    const firstTB = tangentBCopy[0];
                    const firstE = edgeWedgeCopy[0];

                    if (firstE && isValidPoint(firstC) && isValidPoint(firstTA) && isValidPoint(firstTB) && isValidPoint(firstE)) {
                        let endCapFirstC = firstC;
                        let endCapFirstTA = firstTA;
                        let endCapFirstTB = firstTB;
                        let endCapFirstE = firstE;

                        // Create triangular fan from centerline to form end cap
                        if (isValidTriangle(endCapFirstC, endCapFirstTB, endCapFirstTA) && addTriangleWithValidation(`${name}_END_CAP_1`, endCapFirstC, endCapFirstTB, endCapFirstTA)) validTriangles++; else skippedTriangles++;
                        if (isValidTriangle(endCapFirstTA, endCapFirstTB, endCapFirstE) && addTriangleWithValidation(`${name}_END_CAP_1`, endCapFirstTA, endCapFirstTB, endCapFirstE)) validTriangles++; else skippedTriangles++;
                    }

                    // Last end cap
                    const lastIndex = centerlineCopy.length - 1;
                    const lastC = centerlineCopy[lastIndex];
                    const lastTA = tangentACopy[lastIndex];
                    const lastTB = tangentBCopy[lastIndex];
                    const lastE = edgeWedgeCopy[lastIndex];

                    if (lastE && isValidPoint(lastC) && isValidPoint(lastTA) && isValidPoint(lastTB) && isValidPoint(lastE)) {
                        let endCapLastC = lastC;
                        let endCapLastTA = lastTA;
                        let endCapLastTB = lastTB;
                        let endCapLastE = lastE;

                        // Create triangular fan from centerline to form end cap (reversed winding for proper normal)
                        if (isValidTriangle(endCapLastC, endCapLastTA, endCapLastTB) && addTriangleWithValidation(`${name}_END_CAP_2`, endCapLastC, endCapLastTA, endCapLastTB)) validTriangles++; else skippedTriangles++;
                        if (isValidTriangle(endCapLastTA, endCapLastE, endCapLastTB) && addTriangleWithValidation(`${name}_END_CAP_2`, endCapLastTA, endCapLastE, endCapLastTB)) validTriangles++; else skippedTriangles++;
                    }
                }

                console.log(`Wedge triangles added successfully (non-closed loop): ${validTriangles} valid, ${skippedTriangles} skipped`);
                if (validTriangles === 0) {
                    console.error('No valid triangles could be created for non-closed wedge solid - all were degenerate');
                    // Return debug information even on wedge failure
                    return {
                        tube: filletTube,
                        wedge: wedgeSolid,
                        finalSolid: null,
                        centerline: centerlineCopy,
                        tangentA: tangentACopy,
                        tangentB: tangentBCopy,
                        error: 'No valid triangles could be created for non-closed wedge solid - all were degenerate'
                    };
                }
            } catch (wedgeError) {
                console.log('Failed to create wedge triangles (non-closed loop):', wedgeError?.message || wedgeError);
                // Return debug information even on wedge error
                return {
                    tube: filletTube,
                    wedge: wedgeSolid,
                    finalSolid: null,
                    centerline: centerlineCopy,
                    tangentA: tangentACopy,
                    tangentB: tangentBCopy,
                    error: `Non-closed wedge triangle creation failed: ${wedgeError?.message || wedgeError}`
                };
            }
        }

        // Triangle winding fix for all cases
        try {
            wedgeSolid.fixTriangleWindingsByAdjacency();
        } catch (windingError) {
            console.warn('Triangle winding fix failed:', windingError?.message || windingError);
        }

        if (debug) {
            console.log('Debug mode: wedge solid stored');
        }
        console.log('Wedge solid creation completed');
        const triangleCount = wedgeSolid._triVerts ? wedgeSolid._triVerts.length / 3 : 0;
        console.log('Wedge solid created with', triangleCount, 'triangles (raw count)');
        try { wedgeSolid.visualize(); } catch { }

        console.log(wedgeSolid);

        wedgeSolid.pushFace(`${name}_FACE_A`, 0.0001);
        wedgeSolid.pushFace(`${name}_FACE_B`, 0.0001);

        // Apply end cap offset for INSET fillets using pushFace method
        if (side === 'INSET' && !closedLoop) {
            console.log('Applying end cap offset to INSET fillet using pushFace...');
            try {
                // Push both end caps outward by 0.001
                wedgeSolid.pushFace(`${name}_END_CAP_1`, 0.0001);
                wedgeSolid.pushFace(`${name}_END_CAP_2`, 0.0001);
                wedgeSolid.visualize();
                console.log('End cap offset applied successfully');
            } catch (pushError) {
                console.warn('Failed to apply end cap offset:', pushError?.message || pushError);
            }
        }

        try {
            const finalSolid = wedgeSolid.subtract(filletTube);
            finalSolid.name = `${name}_FINAL_FILLET`;
            try { finalSolid.visualize(); } catch { }
            console.log('Final fillet solid created by subtracting tube from wedge', finalSolid);

            return { tube: filletTube, wedge: wedgeSolid, finalSolid, centerline: centerlineCopy, tangentA: tangentACopy, tangentB: tangentBCopy };
        } catch (booleanError) {
            console.log('Boolean operation failed:', booleanError?.message || booleanError);
            // Return debug information even on boolean failure
            return {
                tube: filletTube,
                wedge: wedgeSolid,
                finalSolid: null,
                centerline: centerlineCopy,
                tangentA: tangentACopy,
                tangentB: tangentBCopy,
                error: `Boolean operation failed: ${booleanError?.message || booleanError}`
            };
        }
    } catch (globalError) {
        console.log('Fillet operation failed completely:', globalError?.message || globalError);
        // Return minimal debug information even on complete failure
        return {
            tube: null,
            wedge: null,
            finalSolid: null,
            centerline: [],
            tangentA: [],
            tangentB: [],
            error: `Fillet operation failed: ${globalError?.message || globalError}`
        };
    }
}
