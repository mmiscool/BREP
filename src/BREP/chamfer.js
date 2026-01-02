import { Solid } from "./BetterSolid.js";
import * as THREE from 'three';

// Planar chamfer wedge builder along an input edge shared by two faces.
// Builds a closed solid consisting of:
// - A ruled "bevel" surface between two offset rails (one on each face)
// - Two side strips that lie exactly on the original faces (edge → offset rail)
// - End caps at first/last sections for open edges
export class ChamferSolid extends Solid {
    /**
     * @param {object} opts
     * @param {any} opts.edgeToChamfer Target edge (must belong to a Solid)
     * @param {number} [opts.distance=1] Chamfer distance (> 0)
     * @param {number} [opts.sampleCount=50] Sample count along the edge when resampling
     * @param {boolean} [opts.snapSeamToEdge=true] Snap seam to the source edge instead of resampling
     * @param {number} [opts.sideStripSubdiv=8] Subdivisions along side strips
     * @param {number} [opts.seamInsetScale=1e-3] Inset scale for seam stabilization
     * @param {'INSET'|'OUTSET'|string} [opts.direction='INSET'] Boolean behavior (subtract vs union)
     * @param {number} [opts.inflate=0] Tool inflation (negated for OUTSET)
     * @param {boolean} [opts.flipSide=false] Flip side selection
     * @param {boolean} [opts.debug=false] Enable debug aids
     * @param {number} [opts.debugStride=12] Sampling stride for debug output
     */
    constructor({ edgeToChamfer, distance = 1, sampleCount = 50, snapSeamToEdge = true, sideStripSubdiv = 8, seamInsetScale = 1e-3, direction = 'INSET', inflate = 0, flipSide = false, debug = false, debugStride = 12 }) {
        super();
        this.edgeToChamfer = edgeToChamfer;
        this.distance = Math.max(1e-9, distance);
        this.sampleCount = Math.max(8, (sampleCount | 0));
        this.snapSeamToEdge = !!snapSeamToEdge;
        this.sideStripSubdiv = Math.max(1, (sideStripSubdiv | 0));
        this.seamInsetScale = Number.isFinite(seamInsetScale) ? seamInsetScale : 1e-3;
        this.direction = (direction || 'INSET').toUpperCase(); // 'INSET' | 'OUTSET'
        this.inflate = Number.isFinite(inflate) ? inflate : 0;
        this.flipSide = !!flipSide;
        this.debug = !!debug;
        this.debugStride = Math.max(1, (debugStride | 0));
        this._debugObjects = [];
        this.operationTargetSolid = null;
        this.generate();
    }

    generate() {
        if (this.edgeToChamfer && this.edgeToChamfer.parent) {
            this.operationTargetSolid = this.edgeToChamfer.parent;
        } else {
            throw new Error("Edge must be part of a solid");
        }

        // Clear prior debug helpers
        if (this._debugObjects?.length) {
            const scene = this.operationTargetSolid?.parent;
            if (scene) {
                for (const o of this._debugObjects) scene.remove(o);
            }
            this._debugObjects.length = 0;
        }

        const solid = this.operationTargetSolid;
        const faceA = this.edgeToChamfer.faces?.[0];
        const faceB = this.edgeToChamfer.faces?.[1];
        if (!faceA || !faceB) throw new Error('ChamferSolid: edge must have two adjacent faces.');

        const polyLocal = this.edgeToChamfer.userData?.polylineLocal;
        if (!Array.isArray(polyLocal) || polyLocal.length < 2) throw new Error('ChamferSolid: edge polyline missing.');

        const nAavg = averageFaceNormalObjectSpace(solid, faceA.name);
        const nBavg = averageFaceNormalObjectSpace(solid, faceB.name);

        const isClosed = !!(this.edgeToChamfer.closedLoop || this.edgeToChamfer.userData?.closedLoop);
        let samples;
        if (this.snapSeamToEdge) {
            const src = polyLocal.slice();
            if (isClosed && src.length > 2) {
                const a = src[0], b = src[src.length - 1];
                if (a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) src.pop();
            }
            samples = src;
        } else {
            samples = resamplePolyline3(polyLocal, this.sampleCount, isClosed);
        }

        const railP = [];
        const railA = []; // on faceA (offset inward/outward per face)
        const railB = []; // on faceB (offset inward/outward per face)
        const normalsA = [];
        const normalsB = [];
        const tangents = [];

        // Decide a global offset sign sSign ∈ {+1,-1} so the bevel consistently
        // goes INSET (toward inward) or OUTSET (toward outward) along the edge.
        // Evaluate at mid sample using local face normals.
        const midIdx = (samples.length / 2) | 0;
        const pm = arrToV(samples[midIdx]);
        const pmPrev = arrToV(samples[Math.max(0, midIdx - 1)]);
        const pmNext = arrToV(samples[Math.min(samples.length - 1, midIdx + 1)]);
        const tm = new THREE.Vector3().subVectors(pmNext, pmPrev).normalize();
        const nAm = localFaceNormalAtPoint(solid, faceA.name, pm) || nAavg;
        const nBm = localFaceNormalAtPoint(solid, faceB.name, pm) || nBavg;
        const vAm = nAm.clone().cross(tm).normalize();
        const vBm = nBm.clone().cross(tm).normalize();
        const outwardAvgMid = nAm.clone().add(nBm);
        if (outwardAvgMid.lengthSq() > 0) outwardAvgMid.normalize();
        const want = (this.direction === 'OUTSET') ? +1 : -1; // desired sign of dot(offsetDir, outwardAvg)
        const sVAm = signNonZero(vAm.dot(outwardAvgMid));
        const sVBm = signNonZero(vBm.dot(outwardAvgMid));
        const sAglobal = want * sVAm; // ensures dot(sA*vAm, outwardAvg) has desired sign
        const sBglobal = want * sVBm; // ensures dot(sB*vBm, outwardAvg) has desired sign
        const sFlip = this.flipSide ? -1 : 1;
        const sA = sAglobal * sFlip;
        const sB = sBglobal * sFlip;

        // Build offset rails with the chosen global sign
        for (let i = 0; i < samples.length; i++) {
            const p = arrToV(samples[i]);
            const pPrev = isClosed
                ? arrToV(samples[(i - 1 + samples.length) % samples.length])
                : arrToV(samples[Math.max(0, i - 1)]);
            const pNext = isClosed
                ? arrToV(samples[(i + 1) % samples.length])
                : arrToV(samples[Math.min(samples.length - 1, i + 1)]);
            const t = new THREE.Vector3().subVectors(pNext, pPrev);
            if (t.lengthSq() < 1e-14) continue;
            t.normalize();

            const nA = (localFaceNormalAtPoint(solid, faceA.name, p) || nAavg).clone();
            const nB = (localFaceNormalAtPoint(solid, faceB.name, p) || nBavg).clone();
            let vA3 = nA.clone().cross(t);
            let vB3 = nB.clone().cross(t);
            if (vA3.lengthSq() < 1e-12 || vB3.lengthSq() < 1e-12) continue;
            vA3.normalize(); vB3.normalize();

            const Ai = p.clone().addScaledVector(vA3, sA * this.distance);
            const Bi = p.clone().addScaledVector(vB3, sB * this.distance);
            railP.push(p.clone());
            railA.push(Ai);
            railB.push(Bi);
            normalsA.push(nA.normalize());
            normalsB.push(nB.normalize());
            tangents.push(t.clone());

            if (this.debug && (i % this.debugStride === 0)) {
                const scene = this.operationTargetSolid?.parent;
                if (scene) {
                    const addLine = (from, to, color) => {
                        const g = new THREE.BufferGeometry().setFromPoints([from, to]);
                        const m = new THREE.LineBasicMaterial({ color });
                        const L = new THREE.Line(g, m);
                        L.renderOrder = 10;
                        scene.add(L);
                        this._debugObjects.push(L);
                    };
                    const Ls = Math.max(0.4 * this.distance, 1e-3);
                    addLine(p, p.clone().addScaledVector(vA3, Ls * sA), 0x00ffff);
                    addLine(p, p.clone().addScaledVector(vB3, Ls * sB), 0xffff00);
                    addLine(Ai, Bi, 0xff00ff);
                }
            }
        }

        reorderChamferRailSamples({
            railP,
            railA,
            railB,
            normalsA,
            normalsB,
            tangents,
            isClosed,
        });

        const closeLoop = !!isClosed;
        const baseName = `CHAMFER_${faceA.name}|${faceB.name}`;
        let railPused = railP;
        let railAused = railA;
        let railBused = railB;
        if (Math.abs(this.inflate) > 1e-12) {
            const inflated = inflateChamferRails({
                railP,
                railA,
                railB,
                normalsA,
                normalsB,
                tangents,
                inflate: this.inflate,
            });
            if (inflated) {
                railPused = inflated.railP;
                railAused = inflated.railA;
                railBused = inflated.railB;
            }
        }
        resolveChamferSelfIntersections([railPused, railAused, railBused], closeLoop);

        // Build a closed triangular prism and tag faces: _SIDE_A, _SIDE_B, _BEVEL, _CAP0, _CAP1
        buildChamferPrismNamed(this, baseName, railPused, railAused, railBused, closeLoop);
        // use pushFace to push end caps out by a tiny amount to avoid z-fighting with original faces
        const tinyPush = 0.0001;
        this.pushFace(`${baseName}_CAP0`, tinyPush);
        this.pushFace(`${baseName}_CAP1`, tinyPush);

    }
}

// ---------- Helpers (mostly adapted from fillet.js minimal subset) ----------

function arrToV(a) { return new THREE.Vector3(a[0], a[1], a[2]); }
function vToArr(v) { return [v.x, v.y, v.z]; }

function resamplePolyline3(src, n, close) {
    if (!Array.isArray(src) || src.length < 2) return src;
    const list = src.map(arrToV);
    if (close) list.push(list[0].clone());
    const totalLen = polylineLength(list);
    const out = [];
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const d = t * totalLen;
        const p = pointAtArcLength(list, d);
        out.push([p.x, p.y, p.z]);
    }
    return out;
}

function signNonZero(x) { return (x >= 0) ? +1 : -1; }

function polylineLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += pts[i].distanceTo(pts[i - 1]);
    return L;
}

function resolveChamferSelfIntersections(railGroup, isClosed) {
    if (isClosed || !Array.isArray(railGroup) || railGroup.length === 0) return;
    const baseLen = railGroup[0]?.length || 0;
    if (baseLen < 4) return;
    for (const rail of railGroup) {
        if (!Array.isArray(rail) || rail.length !== baseLen) return;
    }
    const maxIterations = Math.min(4096, baseLen * baseLen * railGroup.length);
    for (let iter = 0; iter < maxIterations; iter++) {
        let best = null;
        for (let r = 0; r < railGroup.length; r++) {
            const hit = nextRailSelfIntersection(railGroup[r]);
            if (!hit) continue;
            if (!best || hit.i < best.i || (hit.i === best.i && hit.j < best.j)) {
                best = { ...hit };
            }
        }
        if (!best) break;
        collapseRailsAtIntersection(railGroup, best);
    }
}

function nextRailSelfIntersection(points) {
    const projection = projectPolylineToPlane(points);
    if (!projection) return null;
    const coords = projection.planar;
    const n = coords.length;
    if (n < 4) return null;
    for (let i = 0; i < n - 3; i++) {
        const a0 = coords[i];
        const a1 = coords[i + 1];
        for (let j = i + 2; j < n - 1; j++) {
            if (j === i + 1) continue;
            const b0 = coords[j];
            const b1 = coords[j + 1];
            const hit = segmentIntersection2D(a0, a1, b0, b1);
            if (hit) return { i, j, t: clamp01(hit.t), u: clamp01(hit.u) };
        }
    }
    return null;
}

function collapseRailsAtIntersection(railGroup, { i, j, t, u }) {
    if (!(j > i + 1)) return;
    const removeCount = j - i;
    for (const arr of railGroup) {
        if (!Array.isArray(arr) || arr.length <= j) return;
    }
    for (const arr of railGroup) {
        const merged = averagePointOnSegments(arr, i, t, j, u);
        arr.splice(i + 1, removeCount, merged);
    }
}

function averagePointOnSegments(arr, i, t, j, u) {
    const a0 = arr[i];
    const a1 = arr[i + 1];
    const b0 = arr[j];
    const b1 = arr[j + 1];
    if (!a0 || !a1 || !b0 || !b1) return a0 ? a0.clone() : new THREE.Vector3();
    const pA = a0.clone().lerp(a1, t);
    const pB = b0.clone().lerp(b1, u);
    return pA.add(pB).multiplyScalar(0.5);
}

function segmentIntersection2D(a1, a2, b1, b2, tol = 1e-12) {
    const r = { x: a2.x - a1.x, y: a2.y - a1.y };
    const s = { x: b2.x - b1.x, y: b2.y - b1.y };
    const denom = r.x * s.y - r.y * s.x;
    if (Math.abs(denom) < tol) return null;
    const dx = b1.x - a1.x;
    const dy = b1.y - a1.y;
    const t = (dx * s.y - dy * s.x) / denom;
    const u = (dx * r.y - dy * r.x) / denom;
    if (t >= -tol && t <= 1 + tol && u >= -tol && u <= 1 + tol) {
        return { t, u };
    }
    return null;
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

function projectPolylineToPlane(points) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const origin = points[0].clone();
    let axisU = null;
    for (let i = 1; i < points.length; i++) {
        const v = points[i].clone().sub(origin);
        if (v.lengthSq() > 1e-12) { axisU = v.normalize(); break; }
    }
    if (!axisU) return null;
    const normal = new THREE.Vector3();
    const tmp1 = new THREE.Vector3();
    const tmp2 = new THREE.Vector3();
    for (let i = 0; i < points.length - 2; i++) {
        tmp1.subVectors(points[i + 1], points[i]);
        tmp2.subVectors(points[i + 2], points[i + 1]);
        const cross = new THREE.Vector3().crossVectors(tmp1, tmp2);
        if (cross.lengthSq() > 1e-16) normal.add(cross);
    }
    if (normal.lengthSq() < 1e-16) {
        const fallback = Math.abs(axisU.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        normal.crossVectors(axisU, fallback);
        if (normal.lengthSq() < 1e-16) normal.set(0, 0, 1);
    }
    normal.normalize();
    const axisV = new THREE.Vector3().crossVectors(normal, axisU);
    if (axisV.lengthSq() < 1e-16) return null;
    axisV.normalize();
    const planar = points.map((p) => {
        const rel = p.clone().sub(origin);
        return {
            x: rel.dot(axisU),
            y: rel.dot(axisV),
        };
    });
    return { origin, axisU, axisV, planar };
}

function reorderChamferRailSamples({ railP, railA, railB, normalsA, normalsB, tangents, isClosed }) {
    const order = computeChamferRailOrder(railP, isClosed);
    if (!order) return;
    const apply = (arr) => {
        if (!Array.isArray(arr) || arr.length !== order.length) return;
        const re = new Array(order.length);
        for (let i = 0; i < order.length; i++) re[i] = arr[order[i]];
        arr.length = 0;
        for (const item of re) arr.push(item);
    };
    apply(railP);
    apply(railA);
    apply(railB);
    apply(normalsA);
    apply(normalsB);
    apply(tangents);
}

function computeChamferRailOrder(points, isClosed) {
    if (isClosed || !Array.isArray(points) || points.length < 3) return null;
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return null;
    if (first.distanceTo(last) < 1e-9) return null;

    const n = points.length;
    const used = new Array(n).fill(false);
    const order = [];
    const pushIdx = (idx) => {
        order.push(idx);
        used[idx] = true;
    };
    pushIdx(0);
    used[n - 1] = true; // keep final endpoint reserved
    while (order.length < n - 1) {
        const curr = points[order[order.length - 1]];
        if (!curr) break;
        let best = -1;
        let bestDist = Infinity;
        for (let i = 1; i < n - 1; i++) {
            if (used[i]) continue;
            const candidate = points[i];
            if (!candidate) continue;
            const dist = curr.distanceTo(candidate);
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        if (best === -1) break;
        pushIdx(best);
    }
    order.push(n - 1);
    if (order.length !== n) return null;

    let changed = false;
    for (let i = 0; i < n; i++) {
        if (order[i] !== i) { changed = true; break; }
    }
    if (!changed) return null;

    const originalLength = polylineLength(points);
    const reorderedLength = polylineLengthFromOrder(points, order);
    const tolerance = Math.max(1e-6, originalLength * 1e-4);
    if (!(reorderedLength + tolerance < originalLength)) return null;
    return order;
}

function polylineLengthFromOrder(points, order) {
    if (!Array.isArray(points) || !Array.isArray(order) || order.length < 2) return 0;
    let L = 0;
    for (let i = 1; i < order.length; i++) {
        const a = points[order[i - 1]];
        const b = points[order[i]];
        if (!a || !b) continue;
        L += a.distanceTo(b);
    }
    return L;
}

function pointAtArcLength(pts, dist) {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
        const seg = pts[i].distanceTo(pts[i - 1]);
        if (acc + seg >= dist) {
            const t = (dist - acc) / seg;
            return new THREE.Vector3().lerpVectors(pts[i - 1], pts[i], t);
        }
        acc += seg;
    }
    return pts[pts.length - 1].clone();
}

function averageFaceNormalObjectSpace(solid, faceName) {
    const tris = solid.getFace(faceName);
    if (!tris || !tris.length) return new THREE.Vector3(0, 1, 0);
    const accum = new THREE.Vector3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3();
    for (const t of tris) {
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        accum.add(ab.clone().cross(ac));
    }
    if (accum.lengthSq() === 0) return new THREE.Vector3(0, 1, 0);
    return accum.normalize();
}

function localFaceNormalAtPoint(solid, faceName, p) {
    const tris = solid.getFace(faceName);
    if (!tris || !tris.length) return null;
    let best = null;
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    for (const t of tris) {
        pa.set(t.p1[0], t.p1[1], t.p1[2]);
        pb.set(t.p2[0], t.p2[1], t.p2[2]);
        pc.set(t.p3[0], t.p3[1], t.p3[2]);
        const ab = new THREE.Vector3().subVectors(pb, pa);
        const ac = new THREE.Vector3().subVectors(pc, pa);
        const n = new THREE.Vector3().crossVectors(ab, ac);
        if (n.lengthSq() < 1e-14) continue;
        n.normalize();
        centroid.copy(pa).add(pb).add(pc).multiplyScalar(1 / 3);
        const d = Math.abs(n.dot(new THREE.Vector3().subVectors(p, centroid)));
        if (!best || d < best.d) best = { d, n: n.clone() };
    }
    return best ? best.n : null;
}

function inflateChamferRails({ railP, railA, railB, normalsA, normalsB, tangents, inflate }) {
    if (!Number.isFinite(inflate) || inflate === 0) return null;
    const count = Math.min(
        railP.length,
        railA.length,
        railB.length,
        normalsA.length,
        normalsB.length,
        tangents.length
    );
    if (count < 2) return null;
    const outP = new Array(count);
    const outA = new Array(count);
    const outB = new Array(count);
    const ab = new THREE.Vector3();
    const bevelNormal = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
        const P = railP[i];
        const A = railA[i];
        const B = railB[i];
        const nA = normalsA[i];
        const nB = normalsB[i];
        outP[i] = shiftEdgePoint(P, nA, nB, inflate);

        if (!A || !B) {
            outA[i] = A ? A.clone() : new THREE.Vector3();
            outB[i] = B ? B.clone() : new THREE.Vector3();
            continue;
        }

        const t = tangents[i];
        if (!t || t.lengthSq() < 1e-14) {
            outA[i] = A.clone();
            outB[i] = B.clone();
            continue;
        }
        tangent.copy(t).normalize();
        ab.copy(B).sub(A);
        if (ab.lengthSq() < 1e-18) {
            outA[i] = A.clone();
            outB[i] = B.clone();
            continue;
        }
        bevelNormal.crossVectors(ab, tangent);
        const len = bevelNormal.length();
        if (len < 1e-18) {
            outA[i] = A.clone();
            outB[i] = B.clone();
            continue;
        }
        bevelNormal.multiplyScalar(1 / len);
        outA[i] = translatePointWithinPlane(A, nA, bevelNormal, inflate);
        outB[i] = translatePointWithinPlane(B, nB, bevelNormal, inflate);
    }
    return { railP: outP, railA: outA, railB: outB };
}

function shiftEdgePoint(point, normalA, normalB, inflate) {
    if (!point) return new THREE.Vector3();
    if (!normalA || !normalB) return point.clone();
    const nA = normalA.clone().normalize();
    const nB = normalB.clone().normalize();
    const sum = nA.clone().add(nB);
    const denom = 1 + nA.dot(nB);
    if (Math.abs(denom) < 1e-9 || sum.lengthSq() < 1e-18) return point.clone();
    return point.clone().addScaledVector(sum, inflate / denom);
}

function translatePointWithinPlane(point, faceNormal, planeNormal, inflate) {
    if (!point) return new THREE.Vector3();
    if (!faceNormal || !planeNormal) return point.clone();
    const n = faceNormal.clone().normalize();
    const plane = planeNormal.clone().normalize();
    const dir = n.sub(plane.clone().multiplyScalar(plane.dot(n)));
    const lenSq = dir.lengthSq();
    if (lenSq < 1e-18) return point.clone();
    return point.clone().addScaledVector(dir, inflate / lenSq);
}

// Triangular prism with named faces for selective inflation: SIDE_A, SIDE_B, BEVEL, CAPs
function buildChamferPrismNamed(solid, baseName, railP, railA, railB, closeLoop) {
    const n = Math.min(railP.length, railA.length, railB.length);
    if (n < 2) return;
    const namePA = `${baseName}_SIDE_A`;
    const namePB = `${baseName}_SIDE_B`;
    const nameAB = `${baseName}_BEVEL`;
    const link = (nm, a0, a1, b0, b1) => {
        solid.addTriangle(nm, vToArr(a0), vToArr(b0), vToArr(b1));
        solid.addTriangle(nm, vToArr(a0), vToArr(b1), vToArr(a1));
    };
    for (let i = 0; i < n - 1; i++) {
        link(namePA, railP[i], railP[i+1], railA[i], railA[i+1]); // P-A side
        link(namePB, railP[i], railP[i+1], railB[i], railB[i+1]); // P-B side
        link(nameAB, railA[i], railA[i+1], railB[i], railB[i+1]); // bevel
    }
    if (closeLoop) {
        const i = n - 1, j = 0;
        link(namePA, railP[i], railP[j], railA[i], railA[j]);
        link(namePB, railP[i], railP[j], railB[i], railB[j]);
        link(nameAB, railA[i], railA[j], railB[i], railB[j]);
    } else {
        solid.addTriangle(`${baseName}_CAP0`, vToArr(railP[0]), vToArr(railA[0]), vToArr(railB[0]));
        solid.addTriangle(`${baseName}_CAP1`, vToArr(railP[n-1]), vToArr(railB[n-1]), vToArr(railA[n-1]));
    }
}
