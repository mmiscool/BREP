import { Solid } from "./BetterSolid.js";
import * as THREE from 'three';

// Planar chamfer wedge builder along an input edge shared by two faces.
// Builds a closed solid consisting of:
// - A ruled "bevel" surface between two offset rails (one on each face)
// - Two side strips that lie exactly on the original faces (edge → offset rail)
// - End caps at first/last sections for open edges
export class ChamferSolid extends Solid {
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

            const nA = localFaceNormalAtPoint(solid, faceA.name, p) || nAavg;
            const nB = localFaceNormalAtPoint(solid, faceB.name, p) || nBavg;
            let vA3 = nA.clone().cross(t);
            let vB3 = nB.clone().cross(t);
            if (vA3.lengthSq() < 1e-12 || vB3.lengthSq() < 1e-12) continue;
            vA3.normalize(); vB3.normalize();

            const Ai = p.clone().addScaledVector(vA3, sA * this.distance);
            const Bi = p.clone().addScaledVector(vB3, sB * this.distance);
            railP.push(p.clone());
            railA.push(Ai);
            railB.push(Bi);

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

        const closeLoop = !!isClosed;
        const baseName = `CHAMFER_${faceA.name}|${faceB.name}`;
        // Build a closed triangular prism and tag faces: _SIDE_A, _SIDE_B, _BEVEL, _CAP0, _CAP1
        buildChamferPrismNamed(this, baseName, railP, railA, railB, closeLoop);

        // Inflate only the two side faces (on original faces) to avoid slivers; bevel remains untouched
        if (Math.abs(this.inflate) > 0) {
            inflateSolidFacesInPlace(this, this.inflate, (name) => {
                if (typeof name !== 'string') return false;
                return name.includes('_SIDE_A') || name.includes('_SIDE_B');
            });
        }
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

function projectPointOntoFaceTriangles(tris, point) {
    if (!Array.isArray(tris) || tris.length === 0) return point.clone();
    const P = point.clone();
    let best = null;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (const t of tris) {
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        const q = closestPointOnTriangle(P, a, b, c);
        const d2 = q.distanceToSquared(P);
        if (!best || d2 < best.d2) best = { d2, q };
    }
    return best ? best.q.clone() : P.clone();
}

function closestPointOnTriangle(P, A, B, C) {
    const AB = new THREE.Vector3().subVectors(B, A);
    const AC = new THREE.Vector3().subVectors(C, A);
    const AP = new THREE.Vector3().subVectors(P, A);

    const d1 = AB.dot(AP);
    const d2 = AC.dot(AP);
    if (d1 <= 0 && d2 <= 0) return A.clone();

    const BP = new THREE.Vector3().subVectors(P, B);
    const d3 = AB.dot(BP);
    const d4 = AC.dot(BP);
    if (d3 >= 0 && d4 <= d3) return B.clone();

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return A.clone().addScaledVector(AB, v);
    }

    const CP = new THREE.Vector3().subVectors(P, C);
    const d5 = AB.dot(CP);
    const d6 = AC.dot(CP);
    if (d6 >= 0 && d5 <= d6) return C.clone();

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return A.clone().addScaledVector(AC, w);
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return B.clone().addScaledVector(new THREE.Vector3().subVectors(C, B), w);
    }

    const denom = 1 / (AB.dot(AB) * AC.dot(AC) - Math.pow(AB.dot(AC), 2));
    const v = (AC.dot(AC) * AB.dot(AP) - AB.dot(AC) * AC.dot(AP)) * denom;
    const w = (AB.dot(AB) * AC.dot(AP) - AB.dot(AC) * AB.dot(AP)) * denom;
    return A.clone().addScaledVector(AB, v).addScaledVector(AC, w);
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

function insetPolylineAlongFaceNormals(tris, points, amount) {
    if (!Array.isArray(points)) return points;
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const n = normalFromFaceTriangles(tris, p);
        out[i] = p.clone().addScaledVector(n, -amount); // inward
    }
    return out;
}

function normalFromFaceTriangles(tris, point) {
    if (!Array.isArray(tris) || tris.length === 0) return new THREE.Vector3(0, 1, 0);
    const P = point.clone();
    let best = null;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (const t of tris) {
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        const q = closestPointOnTriangle(P, a, b, c);
        const d2 = q.distanceToSquared(P);
        if (!best || d2 < best.d2) best = { d2, a: a.clone(), b: b.clone(), c: c.clone(), q };
    }
    if (!best) return new THREE.Vector3(0, 1, 0);
    const ab = new THREE.Vector3().subVectors(best.b, best.a);
    const ac = new THREE.Vector3().subVectors(best.c, best.a);
    const n = new THREE.Vector3().crossVectors(ab, ac);
    const len = n.length();
    if (len < 1e-14) return new THREE.Vector3(0, 1, 0);
    n.multiplyScalar(1 / len);
    return n;
}

function buildSideStripOnFace(solid, faceName, railP, seam, closeLoop, tris, widthSubdiv = 8, inset = 0) {
    const n = Math.min(railP.length, seam.length);
    if (n < 2) return;
    const W = Math.max(1, widthSubdiv);

    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
        const Pi = railP[i];
        const Si = seam[i];
        const row = new Array(W + 1);
        for (let k = 0; k <= W; k++) {
            const t = k / W;
            if (k === 0) { row[k] = Pi.clone(); continue; }
            if (k === W) { row[k] = Si.clone(); continue; }
            const v = new THREE.Vector3(
                Pi.x + (Si.x - Pi.x) * t,
                Pi.y + (Si.y - Pi.y) * t,
                Pi.z + (Si.z - Pi.z) * t,
            );
            let q = projectPointOntoFaceTriangles(tris, v);
            if (inset > 0) {
                const n = normalFromFaceTriangles(tris, q);
                q = q.addScaledVector(n, -inset);
            }
            row[k] = q;
        }
        rows[i] = row;
    }

    const emitQuad = (iA, iB) => {
        const rowA = rows[iA];
        const rowB = rows[iB];
        for (let k = 0; k < W; k++) {
            const a0 = rowA[k];
            const a1 = rowA[k + 1];
            const b0 = rowB[k];
            const b1 = rowB[k + 1];
            const checker = ((iA + k) & 1) === 0;
            if (checker) {
                solid.addTriangle(faceName, vToArr(a0), vToArr(b0), vToArr(b1));
                solid.addTriangle(faceName, vToArr(a0), vToArr(b1), vToArr(a1));
            } else {
                solid.addTriangle(faceName, vToArr(a0), vToArr(b0), vToArr(a1));
                solid.addTriangle(faceName, vToArr(a1), vToArr(b0), vToArr(b1));
            }
        }
    };

    for (let i = 0; i < n - 1; i++) emitQuad(i, i + 1);
    if (closeLoop && n > 2) emitQuad(n - 1, 0);
}

function skinBetweenRails(solid, faceName, rail0, rail1, closeLoop) {
    const n = Math.min(rail0.length, rail1.length);
    if (n < 2) return;
    const link = (a0, a1, b0, b1) => {
        solid.addTriangle(faceName, vToArr(a0), vToArr(b0), vToArr(b1));
        solid.addTriangle(faceName, vToArr(a0), vToArr(b1), vToArr(a1));
    };
    for (let i = 0; i < n - 1; i++) link(rail0[i], rail0[i + 1], rail1[i], rail1[i + 1]);
    if (closeLoop) link(rail0[n - 1], rail0[0], rail1[n - 1], rail1[0]);
}

function triangulateEndCapTriangle(solid, faceName, P, A, B, flip = false) {
    if (!P || !A || !B) return;
    if (!flip) {
        solid.addTriangle(faceName, vToArr(P), vToArr(A), vToArr(B));
    } else {
        solid.addTriangle(faceName, vToArr(P), vToArr(B), vToArr(A));
    }
}

// Inflate whole solid along outward vertex normals by a small distance.
function inflateSolidInPlace(solid, distance) {
    if (!Number.isFinite(distance) || distance === 0) return;
    const mesh = solid.getMesh();
    const vp = mesh.vertProperties; // Float32Array length = 3*nv
    const tv = mesh.triVerts;       // Uint32Array
    const fid = mesh.faceID;        // Uint32Array
    const nv = (vp.length / 3) | 0;
    if (nv === 0) return;

    const normals = new Float32Array(vp.length);
    for (let t = 0; t < tv.length; t += 3) {
        const i0 = tv[t + 0] >>> 0;
        const i1 = tv[t + 1] >>> 0;
        const i2 = tv[t + 2] >>> 0;
        const ax = vp[i0 * 3 + 0], ay = vp[i0 * 3 + 1], az = vp[i0 * 3 + 2];
        const bx = vp[i1 * 3 + 0], by = vp[i1 * 3 + 1], bz = vp[i1 * 3 + 2];
        const cx = vp[i2 * 3 + 0], cy = vp[i2 * 3 + 1], cz = vp[i2 * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        normals[i0 * 3 + 0] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
        normals[i1 * 3 + 0] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
        normals[i2 * 3 + 0] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
    }

    const out = new Float32Array(vp.length);
    for (let i = 0; i < nv; i++) {
        let nx = normals[i * 3 + 0];
        let ny = normals[i * 3 + 1];
        let nz = normals[i * 3 + 2];
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-20) { nx /= len; ny /= len; nz /= len; } else { nx = ny = nz = 0; }
        out[i * 3 + 0] = vp[i * 3 + 0] + nx * distance;
        out[i * 3 + 1] = vp[i * 3 + 1] + ny * distance;
        out[i * 3 + 2] = vp[i * 3 + 2] + nz * distance;
    }

    const rebuilt = new Solid();
    for (let t = 0; t < tv.length; t += 3) {
        const i0 = tv[t + 0] >>> 0;
        const i1 = tv[t + 1] >>> 0;
        const i2 = tv[t + 2] >>> 0;
        const faceName = solid._idToFaceName.get(fid[(t/3)|0]) || 'CHAMFER';
        rebuilt.addTriangle(
            faceName,
            [out[i0 * 3 + 0], out[i0 * 3 + 1], out[i0 * 3 + 2]],
            [out[i1 * 3 + 0], out[i1 * 3 + 1], out[i1 * 3 + 2]],
            [out[i2 * 3 + 0], out[i2 * 3 + 1], out[i2 * 3 + 2]]
        );
    }
    copyFromSolid(solid, rebuilt);
    try { /* fallthrough */ }
    finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
}

// Triangular prism between rails P, A, B; caps on ends if open.
function buildCornerPrism(solid, faceName, railP, railA, railB, closeLoop) {
    const n = Math.min(railP.length, railA.length, railB.length);
    if (n < 2) return;
    const link = (a0, a1, b0, b1) => {
        solid.addTriangle(faceName, vToArr(a0), vToArr(b0), vToArr(b1));
        solid.addTriangle(faceName, vToArr(a0), vToArr(b1), vToArr(a1));
    };
    for (let i = 0; i < n - 1; i++) {
        link(railP[i], railP[i+1], railA[i], railA[i+1]); // P-A
        link(railP[i], railP[i+1], railB[i], railB[i+1]); // P-B
        link(railA[i], railA[i+1], railB[i], railB[i+1]); // A-B
    }
    if (closeLoop) {
        const i = n - 1, j = 0;
        link(railP[i], railP[j], railA[i], railA[j]);
        link(railP[i], railP[j], railB[i], railB[j]);
        link(railA[i], railA[j], railB[i], railB[j]);
    } else {
        solid.addTriangle(faceName, vToArr(railP[0]), vToArr(railA[0]), vToArr(railB[0]));
        solid.addTriangle(faceName, vToArr(railP[n-1]), vToArr(railB[n-1]), vToArr(railA[n-1]));
    }
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

// Inflate a subset of faces (predicate by name) outward along vertex normals.
function inflateSolidFacesInPlace(solid, distance, namePredicate) {
    if (!Number.isFinite(distance) || distance === 0) return;
    const mesh = solid.getMesh();
    const vp = mesh.vertProperties;
    const tv = mesh.triVerts;
    const fid = mesh.faceID;

    const triCount = (tv.length / 3) | 0;
    const nv = (vp.length / 3) | 0;
    if (triCount === 0 || nv === 0) return;

    const triUse = new Uint8Array(triCount);
    for (let t = 0; t < triCount; t++) {
        const id = fid ? fid[t] : undefined;
        const name = id !== undefined ? solid._idToFaceName.get(id) : undefined;
        triUse[t] = namePredicate && namePredicate(name) ? 1 : 0;
    }

    const normals = new Float64Array(vp.length);
    for (let t = 0; t < triCount; t++) {
        if (!triUse[t]) continue;
        const i0 = tv[t * 3 + 0] >>> 0;
        const i1 = tv[t * 3 + 1] >>> 0;
        const i2 = tv[t * 3 + 2] >>> 0;
        const ax = vp[i0 * 3 + 0], ay = vp[i0 * 3 + 1], az = vp[i0 * 3 + 2];
        const bx = vp[i1 * 3 + 0], by = vp[i1 * 3 + 1], bz = vp[i1 * 3 + 2];
        const cx = vp[i2 * 3 + 0], cy = vp[i2 * 3 + 1], cz = vp[i2 * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        normals[i0 * 3 + 0] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
        normals[i1 * 3 + 0] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
        normals[i2 * 3 + 0] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
    }

    const out = new Float32Array(vp.length);
    for (let i = 0; i < nv; i++) {
        const nx = normals[i * 3 + 0];
        const ny = normals[i * 3 + 1];
        const nz = normals[i * 3 + 2];
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-20) {
            const sx = nx / len, sy = ny / len, sz = nz / len;
            out[i * 3 + 0] = vp[i * 3 + 0] + sx * distance;
            out[i * 3 + 1] = vp[i * 3 + 1] + sy * distance;
            out[i * 3 + 2] = vp[i * 3 + 2] + sz * distance;
        } else {
            out[i * 3 + 0] = vp[i * 3 + 0];
            out[i * 3 + 1] = vp[i * 3 + 1];
            out[i * 3 + 2] = vp[i * 3 + 2];
        }
    }

    const rebuilt = new Solid();
    for (let t = 0; t < tv.length; t += 3) {
        const i0 = tv[t + 0] >>> 0;
        const i1 = tv[t + 1] >>> 0;
        const i2 = tv[t + 2] >>> 0;
        const faceName = solid._idToFaceName.get(fid[(t/3)|0]) || 'CHAMFER';
        rebuilt.addTriangle(
            faceName,
            [out[i0 * 3 + 0], out[i0 * 3 + 1], out[i0 * 3 + 2]],
            [out[i1 * 3 + 0], out[i1 * 3 + 1], out[i1 * 3 + 2]],
            [out[i2 * 3 + 0], out[i2 * 3 + 1], out[i2 * 3 + 2]]
        );
    }

    // Copy rebuilt into original
    copyFromSolid(solid, rebuilt);
    try { /* fallthrough */ }
    finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
}

function copyFromSolid(dst, src) {
    const mesh = src.getMesh();
    dst._numProp = mesh.numProp;
    dst._vertProperties = Array.from(mesh.vertProperties);
    dst._triVerts = Array.from(mesh.triVerts);
    dst._triIDs = (mesh.faceID && mesh.faceID.length)
        ? Array.from(mesh.faceID)
        : new Array((mesh.triVerts.length / 3) | 0).fill(0);
    dst._vertKeyToIndex = new Map();
    for (let i = 0; i < dst._vertProperties.length; i += 3) {
        const x = dst._vertProperties[i + 0];
        const y = dst._vertProperties[i + 1];
        const z = dst._vertProperties[i + 2];
        dst._vertKeyToIndex.set(`${x},${y},${z}`, i / 3);
    }
    dst._idToFaceName = new Map(src._idToFaceName);
    dst._faceNameToID = new Map(src._faceNameToID);
    dst._dirty = true;
    dst._faceIndex = null;
    try { /* done */ } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
}
