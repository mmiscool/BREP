import { Solid } from "./BetterSolid.js";
import manifold from "./setupManifold.js";
import { buildTightPointCloudWrap } from "./PointCloudWrap.js";
import * as THREE from 'three';

// Shared scratch vectors to reduce allocations in tight loops
const __vAB = new THREE.Vector3();
const __vAC = new THREE.Vector3();
const __vAP = new THREE.Vector3();
const __vBP = new THREE.Vector3();
const __vCP = new THREE.Vector3();
const __vCB = new THREE.Vector3();
const __tmp1 = new THREE.Vector3();
const __tmp2 = new THREE.Vector3();
const __tmp3 = new THREE.Vector3();

// Lightweight per-face triangle data cache to accelerate repeated
// closest-point and normal queries during fillet construction.
// Keyed by the triangle array instance returned from getFace(...).
const __FACE_DATA_CACHE = (typeof WeakMap !== 'undefined') ? new WeakMap() : new Map();
function getCachedFaceDataForTris(tris) {
    if (!Array.isArray(tris) || tris.length === 0) return [];
    const existing = __FACE_DATA_CACHE.get(tris);
    if (existing) return existing;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const faceData = tris.map(t => {
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        const cx = (a.x + b.x + c.x) / 3;
        const cy = (a.y + b.y + c.y) / 3;
        const cz = (a.z + b.z + c.z) / 3;
        const ab = new THREE.Vector3().subVectors(b, a);
        const ac = new THREE.Vector3().subVectors(c, a);
        const n = new THREE.Vector3().crossVectors(ab, ac);
        const len = n.length();
        if (len < 1e-14) return null;
        n.multiplyScalar(1 / len);
        // Bounding radius from centroid that encloses the triangle
        const dxA = a.x - cx, dyA = a.y - cy, dzA = a.z - cz;
        const dxB = b.x - cx, dyB = b.y - cy, dzB = b.z - cz;
        const dxC = c.x - cx, dyC = c.y - cy, dzC = c.z - cz;
        const rA2 = dxA*dxA + dyA*dyA + dzA*dzA;
        const rB2 = dxB*dxB + dyB*dyB + dzB*dzB;
        const rC2 = dxC*dxC + dyC*dyC + dzC*dzC;
        const rad = Math.sqrt(Math.max(rA2, rB2, rC2));
        return { cx, cy, cz, rad, normal: n, triangle: t };
    }).filter(Boolean);
    __FACE_DATA_CACHE.set(tris, faceData);
    return faceData;
}


export class FilletSolid extends Solid {
    // Public API accepts only UI-driven parameters; all other knobs are internal.
    constructor({ edgeToFillet, radius = 1, sideMode = 'INSET', debug = false, inflate = 0, capBulgeStart = 0, capBulgeEnd = 0 }) {
        super();
        this.edgeToFillet = edgeToFillet;
        this.radius = radius;
        // Grow/shrink the fillet tool solid by this absolute amount (units of model space).
        // Positive inflates the solid slightly (useful to avoid thin remainders after CSG).
        this.inflate = Number.isFinite(inflate) ? inflate : 0;
        // Internal tuning (not exposed in UI)
        this.arcSegments = 16;
        this.sampleCount = 50;
        // sideMode: 'AUTO' | 'INSET' | 'OUTSET' (relative to outward average normal)
        this.sideMode = (sideMode).toUpperCase();
        // Debug helpers
        this.debug = !!debug;
        this.debugStride = 12;
        this._debugObjects = [];
        this.operationTargetSolid = null;
        this.filletType = null; // will be set to either "UNION" or "SUBTRACT" 
        // Optional outward bulge distances for end caps (absolute units).
        // If 0 or not set, a default of ~5% radius is used for INSET only.
        this.capBulgeStart = Number.isFinite(capBulgeStart) ? +capBulgeStart : 0;
        this.capBulgeEnd   = Number.isFinite(capBulgeEnd) ? +capBulgeEnd   : 0;
        // Side-strip grid resolution and seam inset tuning
        this.sideStripSubdiv = 8;
        // Scale used to bias seams/side strips just inside the source faces
        // to avoid CSG residue from coincident geometry; applied as
        //   inset = max(1e-9, seamInsetScale * radius)
        this.seamInsetScale = 1e-3;
        // Prefer projecting side strips onto the source faces for both closed and open edges by default.
        this.projectStripsOpenEdges = true;
        // Apply a slight inward bias for INSET (avoid coplanar residue); OUTSET keeps seams on faces.
        this.forceSeamInset = (this.sideMode !== 'OUTSET');
        // Only use a convex hull as a last‑resort fallback (see later in generate()).
        // Forcing a hull here creates incorrect geometry for open/outset cases
        // because far end-strip vertices can dominate the hull. Keep false.
        this.forcePointCloudHull = false;
        this.generate();
    }

    generate() {
        // Generate fillet geometry based on this.edgeToFillet and this.radius

        if (this.edgeToFillet && this.edgeToFillet.parent) {
            this.operationTargetSolid = this.edgeToFillet.parent;
        }else {
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
        const faceA = this.edgeToFillet.faces?.[0];
        const faceB = this.edgeToFillet.faces?.[1];
        if (!faceA || !faceB) throw new Error('FilletSolid: edge must have two adjacent faces.');

        // Pull edge polyline in local/object space (positions were authored from MeshGL)
        const polyLocal = this.edgeToFillet.userData?.polylineLocal;
        if (!Array.isArray(polyLocal) || polyLocal.length < 2) throw new Error('FilletSolid: edge polyline missing.');

        // Approximate per-face normals (object space) from Solid topology
        const nAavg = averageFaceNormalObjectSpace(solid, faceA.name);
        const nBavg = averageFaceNormalObjectSpace(solid, faceB.name);
        if (!isFiniteVec3(nAavg) || !isFiniteVec3(nBavg)) throw new Error('FilletSolid: invalid face normals.');

        // Fetch triangle lists for both faces once; used for both per‑section
        // normal sampling and later for seam projection.
        const trisA = solid.getFace(faceA.name);
        const trisB = solid.getFace(faceB.name);

        // Fetch cached face data for faster point projections and normal calculations
        const faceDataA = getCachedFaceDataForTris(trisA);
        const faceDataB = getCachedFaceDataForTris(trisB);

        // Use a consistent outward hint for cap normals based on the average
        // of adjacent face outward normals. This avoids per-end frame flips
        // and keeps both end caps bulging in the same outward direction.
        this.capNormalHint = (() => {
            try {
                const h = nAavg.clone().add(nBavg);
                if (h.lengthSq() > 1e-20) return h.normalize();
            } catch {}
            return null;
        })();

        // Build the section samples along the edge from the original edge
        // vertices so the P‑rail used by side strips matches the input edge
        // exactly. For closed loops, drop a duplicated terminal vertex if present.
        // Robust closed-loop detection: trust flags if present, otherwise
        // infer from the polyline geometry (first/last within epsilon).
        let isClosed = !!(this.edgeToFillet.closedLoop || this.edgeToFillet.userData?.closedLoop);
        if (!isClosed && Array.isArray(polyLocal) && polyLocal.length > 2) {
            const a = polyLocal[0];
            const b = polyLocal[polyLocal.length - 1];
            if (a && b) {
                const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
                const d2 = dx*dx + dy*dy + dz*dz;
                // Tolerance scaled by radius to be unit-friendly
                const eps = Math.max(1e-12, 1e-6 * this.radius * this.radius);
                if (d2 <= eps) isClosed = true;
            }
        }
        // Sampling: always use the exact input edge vertices (with midpoints) so
        // the side-strip rail coincides with the selected edge geometry.
        let samples;
        {
            const src = polyLocal.slice();
            if (isClosed && src.length > 2) {
                const a = src[0], b = src[src.length - 1];
                if (a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) src.pop();
            }
            const out = [];
            for (let i = 0; i < src.length; i++) {
                const a = src[i];
                out.push(a);
                const j = (i + 1);
                if (isClosed) {
                    const b = src[(i + 1) % src.length];
                    const mx = 0.5 * (a[0] + b[0]);
                    const my = 0.5 * (a[1] + b[1]);
                    const mz = 0.5 * (a[2] + b[2]);
                    out.push([mx, my, mz]);
                } else if (j < src.length) {
                    const b = src[j];
                    const mx = 0.5 * (a[0] + b[0]);
                    const my = 0.5 * (a[1] + b[1]);
                    const mz = 0.5 * (a[2] + b[2]);
                    out.push([mx, my, mz]);
                }
            }
            samples = out;
        }

        // Compute per-sample centerline by intersecting the two offset planes
        // (nA·C = nA·p - r, nB·C = nB·p - r) with the cross-section plane (t·C = t·p)
        // Build per-sample definitions for the arc sectors and the rails used
        // to assemble the wedge; no need to retain additional rings/centers.
        const railP = [];   // original edge samples p[i]
        const railA = [];   // tangency along faceA direction
        const railB = [];   // tangency along faceB direction
        const sectorDefs = []; // per-sample arc definition: {C,t,r0,angle}
        // Effective fillet arc radius (do not include inflate here).
        // Inflation is applied later as a uniform offset of the entire solid.
        const rEff = Math.max(1e-9, this.radius);

        for (let i = 0; i < samples.length; i++) {
            const p = arrToV(samples[i]);
            // Use wrap-around neighbors for closed loops to get a consistent
            // central-difference tangent at the seam. Without this the first
            // and last sections use one-sided tangents, which causes the
            // ring at the seam to twist and create crossing triangles.
            const pPrev = isClosed
                ? arrToV(samples[(i - 1 + samples.length) % samples.length])
                : arrToV(samples[Math.max(0, i - 1)]);
            const pNext = isClosed
                ? arrToV(samples[(i + 1) % samples.length])
                : arrToV(samples[Math.min(samples.length - 1, i + 1)]);
            // Cross‑section plane normal: average of the two adjacent segment
            // directions at this point (central difference) to stabilize
            // the frame through corners of a polyline.
            const t = new THREE.Vector3().subVectors(pNext, pPrev);
            if (t.lengthSq() < 1e-14) continue;
            t.normalize();
            // No tangent reversal toggle (was unused in UI)

            // Per-sample local normals from each adjacent face (handles curved faces)
            // Use per-face normals near the projected points on each face to
            // better approximate analytic curvature (important for cones).
            const qA = projectPointOntoFaceTriangles(trisA, p, faceDataA);
            const qB = projectPointOntoFaceTriangles(trisB, p, faceDataB);
            const nA = localFaceNormalAtPoint(solid, faceA.name, qA, faceDataA) || nAavg;
            const nB = localFaceNormalAtPoint(solid, faceB.name, qB, faceDataB) || nBavg;

            // Section frame and face trace directions ensure exact tangency
            // Face traces in the section plane: vA3 = normalize(nA x t), vB3 = normalize(nB x t)
            let vA3 = nA.clone().cross(t);
            let vB3 = nB.clone().cross(t);
            if (vA3.lengthSq() < 1e-12 || vB3.lengthSq() < 1e-12) continue;
            vA3.normalize(); vB3.normalize();
            // No face-swap toggle (was unused in UI)

            // Orthonormal basis (u,v) with u aligned to vA3 for stable 2D mapping
            let u = vA3.clone();
            const v = new THREE.Vector3().crossVectors(t, u).normalize();

            // 2D unit directions of face traces in the section
            const d0_2 = new THREE.Vector2(1, 0); // vA3 == +u
            const d1_2 = new THREE.Vector2(vB3.dot(u), vB3.dot(v));
            d1_2.normalize();
            const dot2 = clamp(d0_2.x * d1_2.x + d0_2.y * d1_2.y, -1, 1);
            const angAbs = Math.acos(dot2);

            const half = 0.5 * angAbs;
            const sinHalf = Math.sin(half);
            if (Math.abs(sinHalf) < 1e-6) continue;
            const expectDist = rEff / Math.abs(sinHalf);

            // For debug: inward projected normals and their bisector in 2D
            const inA3 = t.clone().cross(vA3).negate(); // == projection of (−nA) into section plane
            const inB3 = t.clone().cross(vB3).negate(); // == projection of (−nB) into section plane
            const n0_2 = new THREE.Vector2(inA3.dot(u), inA3.dot(v)).normalize();
            const n1_2 = new THREE.Vector2(inB3.dot(u), inB3.dot(v)).normalize();
            let bis2 = new THREE.Vector2(n0_2.x + n1_2.x, n0_2.y + n1_2.y);
            const lenBis2 = bis2.length();
            if (lenBis2 > 1e-9) bis2.multiplyScalar(1 / lenBis2); else bis2.set(0, 0);

            // Choose side using true 3D offset-plane intersection for exact tangency
            // Solve with offset planes anchored to the face triangles (n·x = n·q ± r)
            const C_in  = solveCenterFromOffsetPlanesAnchored(p, t, nA, qA, -1, nB, qB, -1, rEff); // inside
            const C_out = solveCenterFromOffsetPlanesAnchored(p, t, nA, qA, +1, nB, qB, +1, rEff); // outside

            // Determine preferred side
            let pick = (this.sideMode === 'OUTSET') ? 'out' : 'in';

            let center = (pick === 'in') ? (C_in || C_out) : (C_out || C_in);
            if (!center) continue;

            // Exact tangency points from plane offsets: tA = C - sA*r*nA, tB = C - sB*r*nB
            const sA = (pick === 'in') ? -1 : +1;
            const sB = sA; // same sign for both faces
            let tA = center.clone().addScaledVector(nA, -sA * rEff);
            let tB = center.clone().addScaledVector(nB, -sB * rEff);

            // Refine center using normals at the actual tangency points on the
            // faces (projected). This improves accuracy on curved meshes where
            // normals vary across the face near the edge.
            // Skip refinement if initial center is already close to expected distance
            const initialDist = center.distanceTo(p);
            const needsRefinement = Math.abs(initialDist - expectDist) > 0.1 * rEff;

            if (needsRefinement) {
                try {
                    const qA1 = projectPointOntoFaceTriangles(trisA, tA, faceDataA);
                    const qB1 = projectPointOntoFaceTriangles(trisB, tB, faceDataB);
                    const nA1 = localFaceNormalAtPoint(solid, faceA.name, qA1, faceDataA) || nAavg;
                    const nB1 = localFaceNormalAtPoint(solid, faceB.name, qB1, faceDataB) || nBavg;
                    const C_ref = solveCenterFromOffsetPlanesAnchored(p, t, nA1, qA1, sA, nB1, qB1, sB, rEff);
                    if (C_ref) {
                        center = C_ref;
                        tA = center.clone().addScaledVector(nA1, -sA * rEff);
                        tB = center.clone().addScaledVector(nB1, -sB * rEff);
                    }
                } catch (_) { /* ignore refine errors */ }
            }

            // Robustness: if p→center distance is unreasonably large,
            // recompute center using a 2D bisector construction in the
            // section plane. Originally only applied to closed loops, but
            // cones/oblique faces on open edges can also produce far centers
            // due to nearly parallel offset planes.
            {
                const pToC = center.distanceTo(p);
                const hardCap = 6 * rEff; // absolute cap
                const factor = 3.0;       // relative to 2D expectation
                if (!Number.isFinite(pToC) || pToC > hardCap || pToC > factor * expectDist) {
                    // Direction along inward bisector in 2D (flip for OUTSET)
                    let dir2 = new THREE.Vector2(bis2.x, bis2.y);
                    if (pick === 'out') dir2.multiplyScalar(-1);
                    if (dir2.lengthSq() > 1e-16) {
                        dir2.normalize();
                        const dir3 = new THREE.Vector3().addScaledVector(u, dir2.x).addScaledVector(v, dir2.y).normalize();
                        center = p.clone().addScaledVector(dir3, expectDist);
                        tA = center.clone().addScaledVector(nA, -sA * rEff);
                        tB = center.clone().addScaledVector(nB, -sB * rEff);
                    }
                }
            }

            railP.push(p.clone());
            railA.push(tA.clone());
            railB.push(tB.clone());

            // Store arc definition (3D) for later sector-solid build.
            // Build the arc directly in the plane that contains the exact
            // tangency points (tA, tB) and the center. This guarantees the
            // generated arc passes through the true tangency points, making
            // the fillet surface tangent to both faces at the seams.
            // Radius directions from center to tangency points:
            const r0 = tA.clone().sub(center).normalize();
            const r1 = tB.clone().sub(center).normalize();
            // Rotation axis = r0 x r1 (normal of the arc plane)
            let axis = new THREE.Vector3().crossVectors(r0, r1);
            let axisLen = axis.length();
            if (axisLen < 1e-12) {
                // Nearly colinear (faces almost parallel in section) —
                // fall back to using section axis `t` for rotation.
                axis = t.clone();
                axisLen = axis.length();
            }
            axis.normalize();
            const ang = Math.acos(clamp(r0.dot(r1), -1, 1)); // [0, pi]
            sectorDefs.push({ C: center.clone(), axis, r0: r0.clone(), angle: ang });

            // --- Debug helpers (draw section vectors) ---
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
                    const Ls = Math.max(0.4 * rEff, 1e-3);
                    // Axes u,v at p
                    addLine(p, p.clone().addScaledVector(u, Ls), 0xff0000); // u: red
                    addLine(p, p.clone().addScaledVector(v, Ls), 0x00ff00); // v: green
                    // p -> center
                    addLine(p, center, 0xff00ff); // magenta
                    // Face trace directions in 2D mapped to 3D (unit length)
                    const aEnd = p.clone().addScaledVector(u,  Ls * d0_2.x).addScaledVector(v, Ls * d0_2.y);
                    const bEnd = p.clone().addScaledVector(u,  Ls * d1_2.x).addScaledVector(v, Ls * d1_2.y);
                    addLine(p, aEnd, 0x00ffff); // cyan
                    addLine(p, bEnd, 0xffff00); // yellow
                    // Bisector ray in 3D
                    const bis3 = new THREE.Vector3().addScaledVector(u, bis2.x).addScaledVector(v, bis2.y).normalize();
                    addLine(p, p.clone().addScaledVector(bis3, Ls), 0xffffff); // white
                }
            }
        }

        // Build wedge directly: arc surface + two side surfaces + end caps
        const radialSegments = Math.max(8, this.arcSegments);
        this._vertProperties = [];
        this._triVerts = [];
        this._triIDs = [];
        this._vertKeyToIndex = new Map();
        // Snap arc seams to lie exactly on the original faces by projecting
        // the per-section tangency points onto the face triangle meshes.
        // Use precomputed face data when projecting seams for faster lookups
        let seamA = railA.map(p => projectPointOntoFaceTriangles(trisA, p, faceDataA));
        let seamB = railB.map(p => projectPointOntoFaceTriangles(trisB, p, faceDataB));

        // Bias seams slightly into the source solid to prevent coincident
        // surfaces from leaving sliver shards after subtraction. For OPEN
        // OUTSET edges, apply a tiny inset by default to avoid 3+ triangle
        // foldovers along the arc/side/cap junctions which often prevent
        // manifoldization.
        if (!isClosed && this.sideMode === 'OUTSET') {
            this.forceSeamInset = true;
            // Use a very small scale for open edges so the seam stays tight
            this.seamInsetScale = Math.min(this.seamInsetScale || 1e-3, 2e-4);
        }
        if (this.sideMode === 'INSET') {
            // Bias seams a little more for robustness. Extremely tiny insets
            // (1e-5*r) tend to quantize/weld away and can leave slivers or
            // boundaries that prevent manifoldization. Use a conservative
            // minimum of ~2e-4*r instead.
            this.seamInsetScale = Math.min(this.seamInsetScale || 1e-3, 2e-4);
        }
        let seamInset = ((isClosed || this.forceSeamInset) ? Math.max(1e-9, this.seamInsetScale * rEff) : 0);
        // Clamp inset on closed loops to avoid foldovers on slanted faces
        if (isClosed) seamInset = Math.min(seamInset, 0.02 * rEff);
        if (seamInset > 0) {
            seamA = insetPolylineAlongFaceNormals(trisA, seamA, +seamInset); // into face A
            seamB = insetPolylineAlongFaceNormals(trisB, seamB, +seamInset); // into face B
        }
        // Apply inflate at the tangency as well: move seam points along their
        // respective face normals by a signed amount. For INSET (subtract), push
        // outward (+inflate); for OUTSET (union), pull inward (−inflate).
        let seamInflate = (Math.abs(this.inflate) > 0)
            ? ((this.sideMode === 'INSET') ? +this.inflate : -this.inflate)
            : 0;
        if (!isClosed && this.sideMode === 'INSET' && seamInflate !== 0) {
            // Clamp outward bias so large UI values don't push the tool
            // completely off the target faces.
            const cap = 0.1 * rEff; // 10% of radius
            seamInflate = Math.min(Math.abs(seamInflate), cap);
        }
        if (seamInflate !== 0) {
            // `insetPolylineAlongFaceNormals` moves inward by +amount (along −n).
            // Passing a negative amount moves outward by |amount| (along +n).
            seamA = insetPolylineAlongFaceNormals(trisA, seamA, -seamInflate);
            seamB = insetPolylineAlongFaceNormals(trisB, seamB, -seamInflate);
        }

        const baseName = `FILLET_${faceA.name}|${faceB.name}`;
        // Side strips are always rebuilt on original faces via projection.

        // Pre‑displace the edge rail P so the side strips actually extend
        // outside the base body for INSET fillets. For OUTSET keep the
        // previous behavior (use only the small user inflate).
        // This makes the tool match the expected cross‑section with a sharp
        // outer corner offset from the edge.
        let railPBuild = railP;
        if (!isClosed) {
            let moveDist = 0;
            if (this.sideMode === 'INSET') {
                // Keep the actual edge rail fixed for INSET on open edges.
                moveDist = 0;
            } else {
                // OUTSET: allow the gentle user‑controlled offset
                moveDist = Math.abs(this.inflate) || 0;
            }
            if (moveDist > 0) {
                try {
                    railPBuild = displaceRailPForInflate(railP, trisA, trisB, moveDist, this.sideMode);
                } catch { railPBuild = railP; }
            }
        }

        // If inflating, prefer to apply it during face-projected side strip build,
        // which keeps a clean parameterization and avoids post-displacement overlap.
        const sideInflateDuringBuild = (Math.abs(this.inflate) > 0);
        // For INSET (subtract), push side strips OUTWARD relative to target faces (positive along face normals).
        // For OUTSET (union), pull side strips INWARD (negative along face normals).
        let sideOffsetSigned = sideInflateDuringBuild
            ? (this.sideMode === 'INSET' ? +this.inflate : -this.inflate)
            : 0;
        if (!isClosed && this.sideMode === 'INSET' && sideOffsetSigned !== 0) {
            const cap = 0.1 * rEff;
            sideOffsetSigned = Math.sign(sideOffsetSigned) * Math.min(Math.abs(sideOffsetSigned), cap);
        }

        // Rebuild the two side strips directly on original faces using projected grids
        // and extend them beyond the selected edge ends by a robust length.
        // Disable side-strip overshoot on open edges for now. The wedge end caps
        // are built exactly at the first/last section, so extending the side
        // strips beyond those sections leaves uncapped boundaries that can cause
        // non‑manifold tools (and bad hulls if a hull fallback triggers).
        let overshootLen = 0;
        // INSET: keep side strips on the original faces so subtraction leaves
        // the curved surface as the new boundary. OUTSET keeps configurable.
        const projectSide = (this.sideMode === 'INSET') ? true : this.projectStripsOpenEdges;
        // For open-edge INSET, use a single strip across width so the end-cap
        // seams (P→seamA, P→seamB) are actual triangle edges shared between
        // the side strips and the cap, preventing tiny gaps.
        const widthSubdiv = (!isClosed && this.sideMode === 'INSET') ? 1 : this.sideStripSubdiv;
        const sideRowsA = computeSideStripRows(railPBuild, seamA, isClosed, trisA, widthSubdiv, seamInset, sideOffsetSigned, projectSide);
        const sideRowsB = computeSideStripRows(railPBuild, seamB, isClosed, trisB, widthSubdiv, seamInset, sideOffsetSigned, projectSide);

        buildWedgeDirect(this, baseName,
            railPBuild, sectorDefs, rEff, radialSegments, isClosed, seamA, seamB,
            { rowsA: sideRowsA, rowsB: sideRowsB });

        buildSideStripOnFace(this, `${baseName}_SIDE_A`, railPBuild, seamA, isClosed, trisA, widthSubdiv, seamInset, sideOffsetSigned, overshootLen, projectSide, sideRowsA);
        buildSideStripOnFace(this, `${baseName}_SIDE_B`, railPBuild, seamB, isClosed, trisB, widthSubdiv, seamInset, sideOffsetSigned, overshootLen, projectSide, sideRowsB);

        // Heuristic: decide union vs subtract based on bisector direction vs outward normals
        this.filletType = classifyFilletBoolean(nAavg, nBavg, polyLocal);

        // Debug: validate cap/strip seams to detect any T-junctions early.
        if (this.debug && !isClosed) {
            try {
                const missA0 = validateCapStripSeam(this, `${baseName}_SIDE_A`, sideRowsA?.[0], `${baseName}_CAP_START`);
                const missB0 = validateCapStripSeam(this, `${baseName}_SIDE_B`, sideRowsB?.[0], `${baseName}_CAP_START`);
                const missA1 = validateCapStripSeam(this, `${baseName}_SIDE_A`, sideRowsA?.[sideRowsA.length-1], `${baseName}_CAP_END`);
                const missB1 = validateCapStripSeam(this, `${baseName}_SIDE_B`, sideRowsB?.[sideRowsB.length-1], `${baseName}_CAP_END`);
                const any = (missA0?.length||0)+(missB0?.length||0)+(missA1?.length||0)+(missB1?.length||0);
                if (any > 0) {
                    console.warn('[FilletSolid] seam validator: missing strip edges on cap boundary', {
                        baseName,
                        startA: missA0, startB: missB0,
                        endA: missA1,   endB: missB1,
                    });
                }
            } catch (e) { try { console.warn('[FilletSolid] seam validation failed:', e?.message||e); } catch {} }
        }

        // Before inflating, ensure triangles are coherently oriented and pre-clean
        // in authoring space to avoid requiring a Manifold build too early.
        try {
            this.fixTriangleWindingsByAdjacency();
            // Use a smaller quantization so tiny seam insets are preserved.
            const q = Math.max(1e-9, 1e-7 * rEff);
            quantizeVerticesAuthoring(this, q);
            removeDegenerateTrianglesAuthoring(this, Math.max(1e-12, 1e-8 * rEff * rEff));
            // Ensure global outward orientation so positive inflation expands the tool
            ensureOutwardOrientationAuthoring(this);
            this.fixTriangleWindingsByAdjacency();
            // Light weld to collapse near-coincident verts created by projections
            // and snapping. This reduces the chance of 3+ faces sharing a nearly
            // duplicated edge which Manifold treats as non-manifold.
            this._weldVerticesByEpsilon(Math.max(1e-9, 5e-7 * rEff));
            // Enforce strict 2‑manifoldness by dropping surplus triangles on edges
            // that exceed two incidents (prefer dropping SIDE, then CAP, keep ARC).
            enforceTwoManifoldByDropping(this);
            // Final orientation fix after dropping
            this.fixTriangleWindingsByAdjacency();
        } catch {}

        // Inflate only the side-strip faces for all modes (OUTSET/INSET).
        // Use a safe inflator that protects arc seam vertices and reduces
        // the step if any side-strip triangles would invert.
        // side inflation already applied during face-projected build

        // Final clean: weld and drop any tiny degenerates created during inflation
        try {
            this._weldVerticesByEpsilon(Math.max(1e-9, 5e-6 * rEff));
            removeDegenerateTrianglesAuthoring(this, Math.max(1e-12, 1e-8 * rEff * rEff));
            this.fixTriangleWindingsByAdjacency();
            enforceTwoManifoldByDropping(this);
            this.fixTriangleWindingsByAdjacency();
        } catch {}




        // If requested, force a manifold convex hull from the authored vertices now.
        if (this.forcePointCloudHull) {
            try {
                const vp = this._vertProperties || [];
                const uniq = new Set();
                const pts = [];
                for (let i = 0; i + 2 < vp.length; i += 3) {
                    const x = vp[i], y = vp[i + 1], z = vp[i + 2];
                    const k = `${x},${y},${z}`;
                    if (uniq.has(k)) continue;
                    uniq.add(k);
                    pts.push({ x, y, z });
                }
                const wrapped = buildTightPointCloudWrap(pts, { });
                copyFromSolid(this, wrapped);
                this.filletType = this.filletType || 'SUBTRACT';
                this.name = 'FILLET_TOOL';
                try { this.fixTriangleWindingsByAdjacency(); } catch {}
                try { ensureOutwardOrientationAuthoring(this); } catch {}
                try { this._weldVerticesByEpsilon(1e-9); } catch {}
                try { removeDegenerateTrianglesAuthoring(this, 1e-14); } catch {}
                try { enforceTwoManifoldByDropping(this, 2); } catch {}
                try { this.fixTriangleWindingsByAdjacency(); } catch {}
            } catch (eHull) {
                try { console.warn('[FilletSolid] forced hull failed:', eHull?.message || eHull); } catch {}
            }
            return this;
        }

        // Proactive manifold check for OUTSET on open edges with face‑projected strips
        // (conical or highly slanted faces can occasionally produce foldovers
        // during projection). If the authored mesh fails to manifoldize, rebuild
        // once with a safer recipe: analytic side strips and a tiny seam inset.
        try {
            // Quick probe; throws on failure
            this.getMesh();
        } catch (e) {
            const isClosed = !!(this.edgeToFillet?.closedLoop || this.edgeToFillet?.userData?.closedLoop);
            const isOutset = this.sideMode === 'OUTSET';
            // First fallback: if inflate caused issues, reduce it and retry once
            if (!this.__retryInflate && Math.abs(this.inflate) > 0) {
                this.__retryInflate = true;
                this.inflate *= 0.25; // aggressive shrink to find safe step
                // Reset authoring buffers
                this._vertProperties = [];
                this._triVerts = [];
                this._triIDs = [];
                this._vertKeyToIndex = new Map();
                this._idToFaceName = new Map();
                this._faceNameToID = new Map();
                this._dirty = true;
                this._manifold = null;
                this._faceIndex = null;
                return this.generate();
            }

            const mayRetry = isOutset && !isClosed && !this.__retryOnce;
            if (mayRetry) {
                this.__retryOnce = true;
                // Reset authoring buffers
                this._vertProperties = [];
                this._triVerts = [];
                this._triIDs = [];
                this._vertKeyToIndex = new Map();
                this._idToFaceName = new Map();
                this._faceNameToID = new Map();
                this._dirty = true;
                this._manifold = null;
                this._faceIndex = null;
                // Safer rebuild: toggle projection mode and add a tiny inset
                this.projectStripsOpenEdges = !this.projectStripsOpenEdges;
                this.forceSeamInset = true;          // bias seams slightly into faces
                this.seamInsetScale = Math.min(this.seamInsetScale || 1e-3, 2e-4);
                // Re-run
                return this.generate();
            }

            // Debug mode: keep the authored triangles as-is so the bad mesh is
            // visible in the scene via Solid.visualize()'s fallback path. Do not
            // replace with a convex hull. Light tidy for display only.
            if (this.debug) {
                try { this.fixTriangleWindingsByAdjacency(); } catch {}
                try { ensureOutwardOrientationAuthoring(this); } catch {}
                try { this._weldVerticesByEpsilon(1e-9); } catch {}
                try { removeDegenerateTrianglesAuthoring(this, 1e-14); } catch {}
                this.name = 'FILLET_TOOL';
                try { this.userData = this.userData || {}; this.userData.debugBad = true; } catch {}
                // Mark dirty so visualize() rebuilds Three meshes from authoring arrays
                this._dirty = true; this._faceIndex = null; this._manifold = null;
                return this;
            }

            // Final fallback: rebuild tool as the convex hull of the authored
            // vertex cloud. This guarantees a watertight manifold even if the
            // wedge triangulation had local non-manifold configurations.
            try {
                const { Manifold } = manifold;
                const vp = this._vertProperties || [];
                const uniq = new Set();
                const pts = [];
                for (let i = 0; i + 2 < vp.length; i += 3) {
                    const x = vp[i], y = vp[i + 1], z = vp[i + 2];
                    const k = `${x},${y},${z}`;
                    if (uniq.has(k)) continue;
                    uniq.add(k);
                    pts.push({ x, y, z });
                }
                if (pts.length >= 4) {
                    const hullM = Manifold.hull(pts);
                    // Wrap in Solid to copy arrays / bookkeeping, assign a simple face label
                    const tmp = Solid._fromManifold(hullM, new Map([[0, 'FILLET_TOOL']]));
                    copyFromSolid(this, tmp);
                    // Preserve intent and metadata
                    this.filletType = this.filletType || 'SUBTRACT';
                    this.name = 'FILLET_TOOL';
                    // Mark for rebuild and ensure coherent orientation
                    try { this.fixTriangleWindingsByAdjacency(); } catch {}
                    try { ensureOutwardOrientationAuthoring(this); } catch {}
                    // One more light weld to drop any accidental duplicates
                    try { this._weldVerticesByEpsilon(1e-9); } catch {}
                } else {
                    // Not enough unique points for a hull; keep authored data as-is
                }
            } catch (eHull) {
                try { console.warn('[FilletSolid] hull fallback failed:', eHull?.message || eHull); } catch {}
            }
        }

        // Final sanity: alert if the tool is non‑manifold. This is a UX aid only
        // (does not stop execution). We first check authoring manifoldness and
        // then try to manifoldize. If either fails, pop a browser alert.
        try {
            let nonManifold = false;
            try { if (!this._isCoherentlyOrientedManifold()) nonManifold = true; } catch { nonManifold = true; }
            if (!nonManifold) {
                try { this.getMesh(); } catch { nonManifold = true; }
            }
            if (nonManifold) {
                const msg = `Fillet tool is non-manifold. Boolean may fail.\n` +
                            `Edge faces: ${faceA?.name || '?'} | ${faceB?.name || '?'}`;
                if (typeof window !== 'undefined' && typeof window.alert === 'function') {
                    window.alert(msg);
                } else if (typeof alert === 'function') {
                    alert(msg);
                } else {
                    try { console.warn(msg); } catch {}
                }
            }
        } catch { /* never block the pipeline */ }

        // No manual Three.js mesh here; rely on Solid.visualize() for inspection
        return this;
    }
}

function buildEndCapEarcut(solid, faceName, arcRing, rowA, rowB, normalHint = null, bulge = 0, mirror = false) {
    if (!Array.isArray(arcRing) || arcRing.length < 2) return false;
    if (!Array.isArray(rowA) || !Array.isArray(rowB)) return false;
    if (rowA.length < 2 || rowB.length < 2) return false;

    const loop = buildEndCapLoop(arcRing, rowA, rowB, mirror);
    if (!loop || loop.length < 3) return false;

    if (triangulateCapWithEarcut(solid, faceName, loop, normalHint, bulge)) return true;
    triangulateCapFanFallback(solid, faceName, loop);
    return true;
}

function buildEndCapLoop(arcRing, rowA, rowB, mirror = false) {
    const loop = [];
    const eps2 = 1e-20;
    const pushUnique = (pt) => {
        if (!pt) return;
        const last = loop[loop.length - 1];
        if (last && last.distanceToSquared(pt) <= eps2) return;
        loop.push(pt.clone());
    };

    const pushArc = (ring, reverse) => {
        if (!Array.isArray(ring) || ring.length === 0) return;
        if (!reverse) {
            for (let i = 0; i < ring.length; i++) {
                const pt = ring[i];
                if (!pt) continue;
                if (i === ring.length - 1 && pt.distanceToSquared(ring[0]) <= eps2) continue;
                pushUnique(pt);
            }
        } else {
            for (let i = ring.length - 1; i >= 0; i--) {
                const pt = ring[i];
                if (!pt) continue;
                if (i === 0 && ring[ring.length - 1] && pt.distanceToSquared(ring[ring.length - 1]) <= eps2) continue;
                pushUnique(pt);
            }
        }
    };

    if (!mirror) {
        // Start end: arc A->B, then B seam -> rail, then rail -> A seam
        pushArc(arcRing, false);
        if (Array.isArray(rowB)) { for (let k = rowB.length - 1; k >= 0; k--) pushUnique(rowB[k]); }
        if (Array.isArray(rowA)) { for (let k = 1; k < rowA.length; k++) pushUnique(rowA[k]); }
    } else {
        // End end (mirrored): arc B->A, then A seam -> rail, then rail -> B seam
        pushArc(arcRing, true);
        if (Array.isArray(rowA)) { for (let k = rowA.length - 1; k >= 0; k--) pushUnique(rowA[k]); }
        if (Array.isArray(rowB)) { for (let k = 1; k < rowB.length; k++) pushUnique(rowB[k]); }
    }

    if (loop.length > 2 && loop[loop.length - 1].distanceToSquared(loop[0]) <= eps2) loop.pop();
    return loop;
}

// Estimate the cap plane normal from the current arc ring and boundary rows.
// Uses the same vertex ordering as buildEndCapLoop() for stability.
function computeCapPlaneNormal(arcRing, rowA, rowB, mirror = false, alignHint = null) {
    const loop = buildEndCapLoop(arcRing, rowA, rowB, mirror);
    if (!loop || loop.length < 3) return alignHint ? alignHint.clone() : null;
    let n = computeLoopNormal(loop);
    if (!n || n.lengthSq() < 1e-20) n = estimateLoopNormal(loop);
    if (!n || n.lengthSq() < 1e-20) return alignHint ? alignHint.clone() : null;
    n.normalize();
    if (alignHint && n.dot(alignHint) < 0) n.negate();
    return n;
}

// Triangulate the polygonal cap using Three.js earcut helper. Ensures every
// boundary vertex becomes part of the mesh to prevent T junctions along seams.
function triangulateCapWithEarcut(solid, faceName, polygon, normalHint = null, bulge = 0) {
    if (!Array.isArray(polygon) || polygon.length < 3) return false;

    // Copy the loop so we can safely reverse without affecting callers
    const outer = polygon.map(p => p.clone());

    // Compute a stable plane and basis for 2D projection
    let normal = computeLoopNormal(outer);
    if (normalHint && normal && normal.dot(normalHint) < 0) normal.negate();
    if (!normal || normal.lengthSq() < 1e-20) normal = normalHint ? normalHint.clone() : estimateLoopNormal(outer);
    if (!normal || normal.lengthSq() < 1e-20) return false;
    normal.normalize();

    // Decouple bulge direction from polygon winding adjustments below.
    // Always prefer the provided hint for bulge direction so both end caps
    // bulge outward consistently, regardless of any loop reversal we perform
    // for triangulation stability.
    const bulgeDir = (normalHint && normalHint.lengthSq() > 1e-20)
        ? normalHint.clone().normalize()
        : normal.clone();

    const origin = outer[0].clone();
    let u = null;
    for (let i = 1; i < outer.length; i++) {
        const diff = outer[i].clone().sub(origin);
        if (diff.lengthSq() > 1e-16) { u = diff.normalize(); break; }
    }
    if (!u) {
        const arbitrary = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        u = arbitrary.clone().cross(normal).normalize();
    }
    let v = new THREE.Vector3().crossVectors(normal, u);
    if (v.lengthSq() < 1e-16) {
        const arbitrary = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        u = arbitrary.clone().cross(normal).normalize();
        v = new THREE.Vector3().crossVectors(normal, u);
    }
    v.normalize();

    const project2D = (pt) => {
        const d = pt.clone().sub(origin);
        return new THREE.Vector2(d.dot(u), d.dot(v));
    };

    let points2D = outer.map(project2D);
    let area = THREE.ShapeUtils.area(points2D);
    // Ensure CCW for positive area for earcut. If we reverse the loop to fix
    // area sign, do NOT flip the bulge direction; bulge uses `bulgeDir` above.
    if (area < 0) {
        outer.reverse();
        points2D = outer.map(project2D);
        area = THREE.ShapeUtils.area(points2D);
    }
    if (Math.abs(area) < 1e-16) return false;

    // Triangulate polygon with earcut (uses current CCW orientation)
    const earTris = THREE.ShapeUtils.triangulateShape(points2D, []);
    if (!earTris || earTris.length === 0) return false;

    // Planar cap offset: translate the whole cap along the outward direction
    // by the requested bulge distance, preserving planarity and topology.
    // Keep boundary vertices EXACTLY on the original seam/side edges to ensure
    // perfect coincidence with adjacent faces. Any outward bias for SUBTRACT
    // is handled later during boolean via offsetCoplanarCap; do not move
    // boundary vertices here.
    const offsetOuter = outer;

    for (const tri of earTris) {
        const i0 = tri[0], i1 = tri[1], i2 = tri[2];
        const A = offsetOuter[i0];
        const B = offsetOuter[i1];
        const C = offsetOuter[i2];
        solid.addTriangle(faceName, vToArr(A), vToArr(B), vToArr(C));
    }
    return true;
}

function triangulateCapFanFallback(solid, faceName, polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return false;
    const anchor = polygon[0];
    for (let i = 1; i < polygon.length - 1; i++) {
        const b = polygon[i];
        const c = polygon[i + 1];
        solid.addTriangle(faceName, vToArr(anchor), vToArr(b), vToArr(c));
    }
    return true;
}

function computeLoopNormal(loop) {
    if (!Array.isArray(loop) || loop.length < 3) return null;
    const normal = new THREE.Vector3(0, 0, 0);
    const count = loop.length;
    for (let i = 0; i < count; i++) {
        const current = loop[i];
        const next = loop[(i + 1) % count];
        normal.x += (current.y - next.y) * (current.z + next.z);
        normal.y += (current.z - next.z) * (current.x + next.x);
        normal.z += (current.x - next.x) * (current.y + next.y);
    }
    return normal;
}

function estimateLoopNormal(loop) {
    if (!Array.isArray(loop) || loop.length < 3) return null;
    const origin = loop[0];
    for (let i = 1; i < loop.length - 1; i++) {
        const a = loop[i].clone().sub(origin);
        for (let j = i + 1; j < loop.length; j++) {
            const b = loop[j].clone().sub(origin);
            const n = a.clone().cross(b);
            if (n.lengthSq() > 1e-20) return n;
        }
    }
    return null;
}

// ===================== Helpers ===================== //

function arrToV(p) { return new THREE.Vector3(p[0], p[1], p[2]); }
function vToArr(v) { return [v.x, v.y, v.z]; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function isFiniteVec3(v) {
    return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function projectPerp(v, axis) {
    // Return component of v orthogonal to axis; ensure non-degenerate
    const res = v.addScaledVector(axis, -v.dot(axis));
    if (res.lengthSq() < 1e-12) {
        // choose a stable perpendicular
        const tmp = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        res.copy(tmp.sub(axis.clone().multiplyScalar(tmp.dot(axis))));
    }
    return res.normalize();
}

// (removed unused chooseInteriorDirections)

// Signed volume of the authoring triangle soup (expects coherent orientation).
// Positive means outward-facing triangles; negative means inward.
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

// (removed unused uniform resampling helpers)

// Compute closest point on a triangle mesh (array of {p1,p2,p3}) to a given point.
// Returns a THREE.Vector3 of the closest point. If tris is empty, returns the input point.
function projectPointOntoFaceTriangles(tris, point, faceData = null) {
    if (!Array.isArray(tris) || tris.length === 0) return point.clone();
    const P = point.clone();
    let best = null;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const qVec = new THREE.Vector3();

    // Acquire face data (precomputed if possible)
    const data = faceData && Array.isArray(faceData) ? faceData : getCachedFaceDataForTris(tris);

    // Two‑phase exact search with safe culling bound.
    // Phase 1: seed best using K nearest centroids (fast, approximate)
    // Phase 2: check the remaining triangles only if their centroid distance
    //          is within a conservative lower bound that can beat current best.
    const K = 32;
    if (data && data.length) {
        const pairs = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const dx = d.cx - P.x, dy = d.cy - P.y, dz = d.cz - P.z;
            pairs[i] = { d2: dx*dx + dy*dy + dz*dz, data: d };
        }
        pairs.sort((x, y) => x.d2 - y.d2);
        const N = Math.min(K, pairs.length);
        for (let i = 0; i < N; i++) {
            const t = pairs[i].data.triangle;
            a.set(t.p1[0], t.p1[1], t.p1[2]);
            b.set(t.p2[0], t.p2[1], t.p2[2]);
            c.set(t.p3[0], t.p3[1], t.p3[2]);
            closestPointOnTriangleToOut(P, a, b, c, qVec);
            const d2 = qVec.distanceToSquared(P);
            if (!best || d2 < best.d2) best = { d2, q: qVec.clone() };
        }
        // Phase 2: safe prune using centroid radius bound
        const bestDist = best ? Math.sqrt(best.d2) : Infinity;
        for (let i = N; i < pairs.length; i++) {
            const d = pairs[i].data;
            const rad = d.rad || 0;
            // If centroid distance is greater than (bestDist + rad), triangle cannot beat best
            const threshold2 = (bestDist + rad) * (bestDist + rad);
            if (pairs[i].d2 > threshold2) continue;
            const t = d.triangle;
            a.set(t.p1[0], t.p1[1], t.p1[2]);
            b.set(t.p2[0], t.p2[1], t.p2[2]);
            c.set(t.p3[0], t.p3[1], t.p3[2]);
            closestPointOnTriangleToOut(P, a, b, c, qVec);
            const d2 = qVec.distanceToSquared(P);
            if (!best || d2 < best.d2) { best = { d2, q: qVec.clone() }; }
        }
        return best ? best.q.clone() : P.clone();
    }

    // Fallback: brute force (should rarely happen)
    for (const t of tris) {
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        closestPointOnTriangleToOut(P, a, b, c, qVec);
        const d2 = qVec.distanceToSquared(P);
        if (!best || d2 < best.d2) best = { d2, q: qVec.clone() };
    }
    return best ? best.q.clone() : P.clone();
}

// Return the closest point to P on triangle ABC in 3D (barycentric clamp method)
function closestPointOnTriangle(P, A, B, C) {
    // Adapted from Real-Time Collision Detection (Christer Ericson)
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

    // Inside face region. Compute barycentric coordinates (u,v,w) and return
    const denom = 1 / (AB.dot(AB) * AC.dot(AC) - Math.pow(AB.dot(AC), 2));
    const v = (AC.dot(AC) * AB.dot(AP) - AB.dot(AC) * AC.dot(AP)) * denom;
    const w = (AB.dot(AB) * AC.dot(AP) - AB.dot(AC) * AB.dot(AP)) * denom;
    return A.clone().addScaledVector(AB, v).addScaledVector(AC, w);
}

// Output-parameter version to avoid allocating new vectors per call
function closestPointOnTriangleToOut(P, A, B, C, out) {
    // Adapted from Real-Time Collision Detection (Christer Ericson)
    const AB = __vAB.subVectors(B, A);
    const AC = __vAC.subVectors(C, A);
    const AP = __vAP.subVectors(P, A);

    const d1 = AB.dot(AP);
    const d2 = AC.dot(AP);
    if (d1 <= 0 && d2 <= 0) { out.copy(A); return out; }

    const BP = __vBP.subVectors(P, B);
    const d3 = AB.dot(BP);
    const d4 = AC.dot(BP);
    if (d3 >= 0 && d4 <= d3) { out.copy(B); return out; }

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        out.copy(A).addScaledVector(AB, v); return out;
    }

    const CP = __vCP.subVectors(P, C);
    const d5 = AB.dot(CP);
    const d6 = AC.dot(CP);
    if (d6 >= 0 && d5 <= d6) { out.copy(C); return out; }

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        out.copy(A).addScaledVector(AC, w); return out;
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        out.copy(B).addScaledVector(__vCB.subVectors(C, B), w); return out;
    }

    // Inside face region. Compute barycentric coordinates (u,v,w) and return
    const denom = 1 / (AB.dot(AB) * AC.dot(AC) - Math.pow(AB.dot(AC), 2));
    const v = (AC.dot(AC) * AB.dot(AP) - AB.dot(AC) * AC.dot(AP)) * denom;
    const w = (AB.dot(AB) * AC.dot(AP) - AB.dot(AC) * AB.dot(AP)) * denom;
    out.copy(A).addScaledVector(AB, v).addScaledVector(AC, w); return out;
}

// Approximate local face normal at a point using the nearest triangle of tris
function normalFromFaceTriangles(tris, point) {
    if (!Array.isArray(tris) || tris.length === 0) return new THREE.Vector3(0, 1, 0);
    const P = point.clone();
    let best = null;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const qVec = new THREE.Vector3();

    const data = getCachedFaceDataForTris(tris);
    const K = 32;
    if (data && data.length) {
        const pairs = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const dx = d.cx - P.x, dy = d.cy - P.y, dz = d.cz - P.z;
            pairs[i] = { d2: dx*dx + dy*dy + dz*dz, data: d };
        }
        pairs.sort((x, y) => x.d2 - y.d2);
        const N = Math.min(K, pairs.length);
        for (let i = 0; i < N; i++) {
            const d = pairs[i].data;
            const t = d.triangle;
            a.set(t.p1[0], t.p1[1], t.p1[2]);
            b.set(t.p2[0], t.p2[1], t.p2[2]);
            c.set(t.p3[0], t.p3[1], t.p3[2]);
            closestPointOnTriangleToOut(P, a, b, c, qVec);
            const d2 = qVec.distanceToSquared(P);
            if (!best || d2 < best.d2) best = { d2, normal: d.normal };
        }
        // Safe prune and refine using centroid-radius bound
        const bestDist = best ? Math.sqrt(best.d2) : Infinity;
        for (let i = N; i < pairs.length; i++) {
            const d = pairs[i].data;
            const rad = d.rad || 0;
            const threshold2 = (bestDist + rad) * (bestDist + rad);
            if (pairs[i].d2 > threshold2) continue;
            const t = d.triangle;
            a.set(t.p1[0], t.p1[1], t.p1[2]);
            b.set(t.p2[0], t.p2[1], t.p2[2]);
            c.set(t.p3[0], t.p3[1], t.p3[2]);
            closestPointOnTriangleToOut(P, a, b, c, qVec);
            const d2 = qVec.distanceToSquared(P);
            if (!best || d2 < best.d2) best = { d2, normal: d.normal };
        }
        return best ? best.normal : new THREE.Vector3(0, 1, 0);
    }

    // Fallback brute force
    for (const t of tris) {
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        closestPointOnTriangleToOut(P, a, b, c, qVec);
        const d2 = qVec.distanceToSquared(P);
        if (!best || d2 < best.d2) best = { d2, normal: new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize() };
    }
    return best ? best.normal : new THREE.Vector3(0, 1, 0);
}

// Push each point of a polyline slightly inward along the face normal to avoid
// exact coplanarity that can cause CSG residue.
function insetPolylineAlongFaceNormals(tris, points, amount) {
    if (!Array.isArray(points)) return points;
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const n = normalFromFaceTriangles(tris, p);
        out[i] = p.clone().addScaledVector(n, -amount); // inward (opposite face normal)
    }
    return out;
}

// Remove near-degenerate triangles (area < eps) from the authoring arrays of a Solid.
// Rebuilds compacted arrays and remaps vertex indices. Returns number removed.
function removeDegenerateTrianglesAuthoring(solid, areaEps = 1e-12) {
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
        newTriIDs.push(ids[t]);
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
    // Commit
    solid._vertProperties = newVP;
    solid._triVerts = newTriVerts;
    solid._triIDs = newTriIDs;
    // Rebuild vertex key map
    solid._vertKeyToIndex = new Map();
    for (let i = 0; i < newVP.length; i += 3) solid._vertKeyToIndex.set(`${newVP[i]},${newVP[i+1]},${newVP[i+2]}`, (i / 3) | 0);
    solid._dirty = true;
    solid._faceIndex = null;
    // Maintain coherent windings
    solid.fixTriangleWindingsByAdjacency();
    return removed;
}

// Snap authoring vertices to a uniform 3D grid (size q) to weld near-coincident
// points. Returns number of vertices changed.
function quantizeVerticesAuthoring(solid, q = 1e-6) {
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

// Sample a grid of points spanning the side strip between the original edge
// rail and the projected fillet seam on a face. Returns an array of rows, each
// containing `widthSubdiv+1` vertices ordered from rail (k=0) to seam (k=W).
function computeSideStripRows(railP, seam, closeLoop, tris, widthSubdiv = 8, inset = 0, extraOffset = 0, project = true) {
    const faceData = getCachedFaceDataForTris(tris);
    const n = Math.min(railP.length, seam.length);
    if (n < 2) return null;
    const W = Math.max(1, widthSubdiv);
    const rows = new Array(n);

    for (let i = 0; i < n; i++) {
        const Pi = railP[i];
        const Si = seam[i];
        const row = new Array(W + 1);
        for (let k = 0; k <= W; k++) {
            const t = k / W;
            if (k === 0) {
                row[k] = Pi.clone();
                continue;
            }
            if (k === W) {
                row[k] = Si.clone();
                continue;
            }
            const v = new THREE.Vector3(
                Pi.x + (Si.x - Pi.x) * t,
                Pi.y + (Si.y - Pi.y) * t,
                Pi.z + (Si.z - Pi.z) * t,
            );
            if (project) {
                let q = projectPointOntoFaceTriangles(tris, v, faceData);
                const nrm = normalFromFaceTriangles(tris, q);
                let move = 0;
                if (Number.isFinite(extraOffset) && extraOffset !== 0) move += extraOffset;
                if (inset > 0) move -= inset;
                if (move !== 0 && nrm) q = q.addScaledVector(nrm, move);
                row[k] = q;
            } else {
                row[k] = v;
            }
        }
        rows[i] = row;
    }

    return rows;
}

// Build a side strip between the P-rail and the seam on a source face.
// Accepts precomputed rows to maintain consistency with other consumers (e.g.,
// end-cap construction) and avoids introducing new seam vertices that could
// create T junctions.
function buildSideStripOnFace(solid, faceName, railP, seam, closeLoop, tris, widthSubdiv = 8, inset = 0, extraOffset = 0, endOvershoot = 0, project = true, precomputedRows = null) {
    const faceData = getCachedFaceDataForTris(tris);
    let baseRows = null;
    if (Array.isArray(precomputedRows) && precomputedRows.length >= 2) {
        baseRows = precomputedRows;
    } else {
        baseRows = computeSideStripRows(railP, seam, closeLoop, tris, widthSubdiv, inset, extraOffset, project);
    }
    if (!Array.isArray(baseRows) || baseRows.length < 2) return;

    const rows = baseRows.map(row => row.slice());
    const W = Math.max(1, (rows[0]?.length || 1) - 1);

    if (!closeLoop && endOvershoot > 0) {
        const extendRow = (rowBase, rowNext, sign) => {
            const dir = new THREE.Vector3();
            if (rowNext && rowBase) {
                dir.copy(rowBase[0]).sub(rowNext[0]);
            }
            if (dir.lengthSq() < 1e-20) {
                for (let k = 0; k <= W; k++) {
                    const a = rowBase[k], b = rowNext[k];
                    if (!a || !b) continue;
                    dir.add(new THREE.Vector3().subVectors(a, b));
                }
            }
            if (dir.lengthSq() < 1e-20) return null;
            dir.normalize().multiplyScalar(sign * endOvershoot);
            const out = new Array(W + 1);
            for (let k = 0; k <= W; k++) {
                let p = (rowBase[k] || rowBase[0]).clone().add(dir);
                if (project) {
                    p = projectPointOntoFaceTriangles(tris, p, faceData);
                    const nrm = normalFromFaceTriangles(tris, p);
                    let move = 0;
                    if (Number.isFinite(extraOffset) && extraOffset !== 0) move += extraOffset;
                    if (inset > 0) move -= inset;
                    if (move !== 0 && nrm) p.addScaledVector(nrm, move);
                }
                out[k] = p;
            }
            return out;
        };

        const row0 = rows[0];
        const row1 = rows[1];
        const startExt = extendRow(row0, row1, +1);
        if (startExt) rows.unshift(startExt);

        const rowN1 = rows[rows.length - 1];
        const rowN2 = rows[rows.length - 2];
        const endExt = extendRow(rowN1, rowN2, +1);
        if (endExt) rows.push(endExt);
    }

    const emitQuad = (iA, iB) => {
        const rowA = rows[iA];
        const rowB = rows[iB];
        const isStartEdge = (iA === 0);
        const isEndEdge   = (iB === rows.length - 1);
        for (let k = 0; k < W; k++) {
            const a0 = rowA[k];
            const a1 = rowA[k + 1];
            const b0 = rowB[k];
            const b1 = rowB[k + 1];
            const triArea2 = (p, q, r) => {
                const ux = q.x - p.x, uy = q.y - p.y, uz = q.z - p.z;
                const vx = r.x - p.x, vy = r.y - p.y, vz = r.z - p.z;
                const nx = uy * vz - uz * vy;
                const ny = uz * vx - ux * vz;
                const nz = ux * vy - uy * vx;
                return nx*nx + ny*ny + nz*nz;
            };
            const pushIfArea = (p, q, r) => {
                if (triArea2(p, q, r) > 1e-32) solid.addTriangle(faceName, vToArr(p), vToArr(q), vToArr(r));
            };
            // Areas for both diagonal choices
            const A1 = triArea2(a0, b0, b1); // pair 1, tri (a0,b0,b1)
            const A2 = triArea2(a0, b1, a1); // pair 1, tri (a0,b1,a1) includes edge (a0,a1)
            const B1 = triArea2(a0, b0, a1); // pair 2, tri (a0,b0,a1)
            const B2 = triArea2(a1, b0, b1); // pair 2, tri (a1,b0,b1) includes edge (b0,b1)

            // Prefer the diagonal that creates boundary-aligned edges so the
            // cap can share those exact edges and avoid T junctions.
            let choosePair = 0; // 0 => pair A (A1+A2), 1 => pair B (B1+B2)
            if (isStartEdge) {
                // Need edge (a0,a1) to exist on the side strip at the start end
                // This edge appears in triangle (a0,b1,a1) => pair A
                choosePair = 0;
            } else if (isEndEdge) {
                // Need edge (b0,b1) to exist on the side strip at the end end
                // This edge appears in triangle (a1,b0,b1) => pair B
                choosePair = 1;
            } else {
                // Interior: pick the more stable diagonal (maximize min area)
                const minA = Math.min(A1, A2);
                const minB = Math.min(B1, B2);
                choosePair = (minA >= minB) ? 0 : 1;
            }

            if (choosePair === 0) {
                pushIfArea(a0, b0, b1);
                pushIfArea(a0, b1, a1);
            } else {
                pushIfArea(a0, b0, a1);
                pushIfArea(a1, b0, b1);
            }
        }
    };

    for (let i = 0; i < rows.length - 1; i++) emitQuad(i, i + 1);
    if (closeLoop && rows.length > 2) emitQuad(rows.length - 1, 0);
}

// --- Debug utility: verify that a side strip contains all consecutive
// edges along a provided boundary row. Returns an array of missing segments.
function validateCapStripSeam(solid, sideFaceName, boundaryRow, capFaceName) {
    if (!Array.isArray(boundaryRow) || boundaryRow.length < 2) return [];
    const id = solid._faceNameToID?.get(sideFaceName);
    if (id === undefined || id === null) return [];
    const tv = solid._triVerts || [];
    const fid = solid._triIDs || [];
    const edgeSet = new Set();
    const addEdge = (i, j) => {
        const a = Math.min(i,j), b = Math.max(i,j);
        edgeSet.add(a+':'+b);
    };
    for (let t = 0; t < tv.length; t += 3) {
        const face = fid ? fid[(t/3)|0] : undefined;
        if (face !== id) continue;
        const i0 = tv[t]>>>0, i1 = tv[t+1]>>>0, i2 = tv[t+2]>>>0;
        addEdge(i0,i1); addEdge(i1,i2); addEdge(i2,i0);
    }
    const keyToIndex = solid._vertKeyToIndex || new Map();
    const idxOf = (p) => keyToIndex.get(`${p.x},${p.y},${p.z}`);
    const missing = [];
    for (let k = 0; k < boundaryRow.length - 1; k++) {
        const a = boundaryRow[k];
        const b = boundaryRow[k+1];
        const ia = idxOf(a); const ib = idxOf(b);
        if (ia === undefined || ib === undefined) { missing.push({k, reason:'vertex_not_found'}); continue; }
        const key = (Math.min(ia,ib))+':'+(Math.max(ia,ib));
        if (!edgeSet.has(key)) missing.push({k, ia, ib, a:[a.x,a.y,a.z], b:[b.x,b.y,b.z]});
    }
    if (missing.length) {
        try { console.warn('[FilletSolid] Missing boundary edges on strip', {sideFaceName, capFaceName, count:missing.length, missing}); } catch {}
    }
    return missing;
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
        // Use right-handed orientation: ab x ac
        accum.add(ab.clone().cross(ac));
    }
    if (accum.lengthSq() === 0) return new THREE.Vector3(0, 1, 0);
    return accum.normalize();
}

function localFaceNormalAtPoint(solid, faceName, p, faceData = null) {
    if (faceData) {
        // Use precomputed face data
        let best = null;
        for (const data of faceData) {
            const d = Math.abs(data.normal.dot(new THREE.Vector3().subVectors(p, new THREE.Vector3(data.cx, data.cy, data.cz))));
            if (!best || d < best.d) best = { d, n: data.normal };
        }
        return best ? best.n : null;
    }

    // Fallback to original implementation
    const tris = solid.getFace(faceName);
    if (!tris || !tris.length) return null;
    let best = null;
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
    const n = new THREE.Vector3();
    const centroid = new THREE.Vector3();

    // Precompute triangle data for faster processing
    const triangleData = tris.map(t => {
        pa.set(t.p1[0], t.p1[1], t.p1[2]);
        pb.set(t.p2[0], t.p2[1], t.p2[2]);
        pc.set(t.p3[0], t.p3[1], t.p3[2]);

        const ab = new THREE.Vector3().subVectors(pb, pa);
        const ac = new THREE.Vector3().subVectors(pc, pa);
        n.copy(ab).cross(ac);
        if (n.lengthSq() < 1e-14) return null;

        n.normalize();
        centroid.copy(pa).add(pb).add(pc).multiplyScalar(1/3);

        return { centroid: centroid.clone(), normal: n.clone(), triangle: t };
    }).filter(Boolean);

    // Find the triangle whose centroid is closest to the point
    for (const data of triangleData) {
        const d = Math.abs(data.normal.dot(new THREE.Vector3().subVectors(p, data.centroid)));
        if (!best || d < best.d) best = { d, n: data.normal };
    }

    return best ? best.n : null;
}

// (removed unused triangulateCapFan / triangulateCapToPoint)

function classifyFilletBoolean(nA, nB, polyLocal) {
    // Simple heuristic: use the bisector of projected directions at mid-edge and compare to outward average
    if (polyLocal.length < 2) return 'SUBTRACT';
    const midIdx = (polyLocal.length / 2) | 0;
    const p = arrToV(polyLocal[midIdx]);
    const pPrev = arrToV(polyLocal[Math.max(0, midIdx - 1)]);
    const pNext = arrToV(polyLocal[Math.min(polyLocal.length - 1, midIdx + 1)]);
    const t = new THREE.Vector3().subVectors(pNext, pPrev).normalize();
    const d0 = projectPerp(nA.clone().negate(), t);
    const d1 = projectPerp(nB.clone(), t);
    const bis = d0.clone().add(d1).normalize();
    const outwardAvg = nA.clone().add(nB).normalize();
    // If bisector points outward (roughly aligned with outward normals), fillet solid is outside -> subtract
    return (bis.dot(outwardAvg) >= 0) ? 'SUBTRACT' : 'UNION';
}

// (removed unused buildTubeFromCenterline)

// Build a single, watertight fillet wedge directly:
// - Curved fillet surface (arc rings lofted along the edge)
// - Two planar side strips from vertex rail P to arc start/end
// - End caps at first/last sections if the edge is open
function buildWedgeDirect(solid, faceName, railP, sectorDefs, radius, arcSegments, closeLoop, seamA = null, seamB = null, sideStripData = null) {
    const n = Math.min(railP.length, sectorDefs.length);
    if (n < 2) return;

    // Derive sub-face names for clearer tagging
    const faceArc      = `${faceName}_ARC`;
    // Name end caps deterministically so downstream logic (e.g., nudge coplanar caps)
    // can target them explicitly and faces propagate through CSG with readable labels.
    const faceCapStart = `${faceName}_CAP_START`;
    const faceCapEnd   = `${faceName}_CAP_END`;
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
        // Try all cyclic shifts at a coarse sampling; also consider reversal.
        // Return {flip:boolean, shift:int}
        const M = rA.length;
        const step = Math.max(1, Math.round((M - 1) / 8));
        let best = { flip: false, shift: 0, err: Infinity };
        for (const flip of [false, true]) {
            // Accessor for cand ring index (with optional flip)
            const getB = (k) => flip ? rB[(M - 1) - k] : rB[k];
            for (let s = 0; s < (M - 1); s++) {
                let e = 0;
                for (let j = 0; j < M; j += step) {
                    const k = (j % (M - 1));
                    const kb = (k + s) % (M - 1);
                    e += sqrDist(rA[k], getB(kb));
                }
                if (e < best.err) best = { flip, shift: s, err: e };
            }
        }
        return best;
    };

    // Align parameterization ring-to-ring.
    // For OPEN edges: keep a consistent A→B orientation across all rings and
    // avoid any reversal/rotation that can cause loft twisting and non‑manifold
    // connections at the end caps. For CLOSED loops, allow flexible alignment.
    if (closeLoop) {
        for (let i = 0; i < n - 1; i++) {
            const rA = arcRings[i];
            const rB = arcRings[i + 1];
            if (!rA || !rB) continue;
            const pick = bestAlign(rA, rB);
            if (pick.flip) reverseRingInPlace(rB);
            if (pick.shift) rotateRingInPlace(rB, pick.shift);
        }
    }

    // After alignment, snap ring endpoints to exact face-tangency points if provided.
    for (let i = 0; i < n; i++) {
        const ring = arcRings[i];
        if (seamA && seamA[i]) ring[0] = seamA[i].clone();
        if (seamB && seamB[i]) ring[arcSegments] = seamB[i].clone();
    }

    // Apply end-cap offsets BEFORE generating any triangles so surfaces stay
    // watertight. Offset the entire end section (arc ring + boundary rows)
    // along the cap plane normal, with sign chosen to point outward.
    if (!closeLoop) {
        const rowsA0 = sideStripData?.rowsA || null;
        const rowsB0 = sideStripData?.rowsB || null;
        const startRowA0 = rowsA0?.[0] || null;
        const startRowB0 = rowsB0?.[0] || null;
        const endRowA0   = rowsA0?.[rowsA0.length - 1] || null;
        const endRowB0   = rowsB0?.[rowsB0.length - 1] || null;

        const applySectionOffset = (dir, dist, ring, rowA, rowB) => {
            if (!(dir && Number.isFinite(dist) && Math.abs(dist) > 0)) return;
            const nrm = dir.clone().normalize();
            const shift = (pt) => { if (pt) pt.addScaledVector(nrm, dist); };
            if (Array.isArray(ring)) for (let j = 0; j < ring.length; j++) shift(ring[j]);
            if (Array.isArray(rowA)) for (let k = 0; k < rowA.length; k++) shift(rowA[k]);
            if (Array.isArray(rowB)) for (let k = 0; k < rowB.length; k++) shift(rowB[k]);
        };

        const defaultBulge = (String(solid?.sideMode || '').toUpperCase() === 'INSET') ? (0.05 * radius) : 0;
        const hasStart0 = (solid?.capBulgeStart !== undefined && solid?.capBulgeStart !== null);
        const hasEnd0   = (solid?.capBulgeEnd   !== undefined && solid?.capBulgeEnd   !== null);
        const bulgeStart0 = hasStart0 && Number.isFinite(+solid.capBulgeStart)
            ? (+solid.capBulgeStart)
            : defaultBulge;
        const bulgeEnd0 = hasEnd0 && Number.isFinite(+solid.capBulgeEnd)
            ? (+solid.capBulgeEnd)
            : defaultBulge;

        const capNStart0 = computeCapPlaneNormal(arcRings[0], startRowA0, startRowB0, false, solid.capNormalHint);
        const capNEnd0   = computeCapPlaneNormal(arcRings[n-1], endRowA0,   endRowB0,   true,  solid.capNormalHint);

        if (capNStart0 && Math.abs(bulgeStart0) > 0) {
            let d = bulgeStart0; if (solid.capNormalHint && capNStart0.dot(solid.capNormalHint) < 0) d = -d;
            applySectionOffset(capNStart0, d, arcRings[0], startRowA0, startRowB0);
        }
        if (capNEnd0 && Math.abs(bulgeEnd0) > 0) {
            let d = bulgeEnd0; if (solid.capNormalHint && capNEnd0.dot(solid.capNormalHint) < 0) d = -d;
            applySectionOffset(capNEnd0, d, arcRings[n-1], endRowA0, endRowB0);
        }
    }

    // Curved surface between successive arc rings. Alternate the quad
    // triangulation to avoid long zig-zag artifacts in the wireframe.
    const triArea2 = (p, q, r) => {
        const ux = q.x - p.x, uy = q.y - p.y, uz = q.z - p.z;
        const vx = r.x - p.x, vy = r.y - p.y, vz = r.z - p.z;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        return nx*nx + ny*ny + nz*nz;
    };
    const pushIfArea = (face, a, b, c) => {
        if (triArea2(a,b,c) > 1e-32) solid.addTriangle(face, vToArr(a), vToArr(b), vToArr(c));
    };
    for (let i = 0; i < n - 1; i++) {
        const r0 = arcRings[i];
        const r1 = arcRings[i + 1];
        for (let j = 0; j < arcSegments; j++) {
            const p00 = r0[j],   p01 = r0[j + 1];
            const p10 = r1[j],   p11 = r1[j + 1];
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
            const p00 = r0[idx],   p01 = r0[idxN];
            const p10 = r1[match(idx)],   p11 = r1[match(idxN)];
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

    if (!closeLoop) {
        const rowsA = Array.isArray(sideStripData?.rowsA) ? sideStripData.rowsA : null;
        const rowsB = Array.isArray(sideStripData?.rowsB) ? sideStripData.rowsB : null;

        const startRowA = rowsA?.[0] || null;
        const startRowB = rowsB?.[0] || null;
        const endRowA = rowsA?.[rowsA.length - 1] || null;
        const endRowB = rowsB?.[rowsB.length - 1] || null;

        const startTangent = (railP.length > 1)
            ? new THREE.Vector3().subVectors(railP[Math.min(1, railP.length - 1)], railP[0]).normalize()
            : null;
        const endTangent = (railP.length > 1)
            ? new THREE.Vector3().subVectors(railP[railP.length - 1], railP[Math.max(0, railP.length - 2)]).normalize()
            : null;

        const arcDirStart = (arcRings[0]?.[1] && arcRings[0]?.[0])
            ? new THREE.Vector3().subVectors(arcRings[0][1], arcRings[0][0]).normalize()
            : null;
        const arcDirEnd = (arcRings[n - 1]?.[arcSegments - 1] && arcRings[n - 1]?.[arcSegments])
            ? new THREE.Vector3().subVectors(arcRings[n - 1][arcSegments - 1], arcRings[n - 1][arcSegments]).normalize()
            : null;

        // Prefer a global outward hint derived from face normals to avoid
        // flips coming from local frame differences at each end. Fall back
        // to the per-end cross-product estimates if not available.
        let normalHintStart = solid.capNormalHint || ((startTangent && arcDirStart)
            ? new THREE.Vector3().crossVectors(startTangent, arcDirStart).normalize()
            : null);
        let normalHintEnd = solid.capNormalHint || ((endTangent && arcDirEnd)
            ? new THREE.Vector3().crossVectors(endTangent, arcDirEnd).normalize()
            : null);

        // Determine bulge distances per-end for triangulation hints and face naming
        const defaultBulge = (String(solid?.sideMode || '').toUpperCase() === 'INSET') ? (0.05 * radius) : 0;
        const hasStart = (solid?.capBulgeStart !== undefined && solid?.capBulgeStart !== null);
        const hasEnd   = (solid?.capBulgeEnd   !== undefined && solid?.capBulgeEnd   !== null);
        const bulgeStart = hasStart && Number.isFinite(+solid.capBulgeStart)
            ? (+solid.capBulgeStart)
            : defaultBulge;
        const bulgeEnd = hasEnd && Number.isFinite(+solid.capBulgeEnd)
            ? (+solid.capBulgeEnd)
            : defaultBulge;

        // Recompute normals after potential offset (direction only)
        let capNormalStart = computeCapPlaneNormal(arcRings[0], startRowA, startRowB, /*mirror*/ false, solid.capNormalHint);
        let capNormalEnd   = computeCapPlaneNormal(arcRings[n-1], endRowA,   endRowB,   /*mirror*/ true,  solid.capNormalHint);

        const builtStart = buildEndCapEarcut(
            solid,
            faceCapStart,
            arcRings[0],
            startRowA,
            startRowB,
            capNormalStart || normalHintStart,
            bulgeStart,
            /*mirror*/ false
        );
        if (!builtStart) {
            const Pstart = railP[0];
            const Astart = arcRings[0];
            for (let j = 0; j < arcSegments; j++) {
                const a0 = Astart[j], a1 = Astart[j + 1];
                if (triArea2(Pstart, a0, a1) > 1e-32) solid.addTriangle(faceCapStart, vToArr(Pstart), vToArr(a0), vToArr(a1));
            }
        }

        const builtEnd = buildEndCapEarcut(
            solid,
            faceCapEnd,
            arcRings[n - 1],
            endRowA,
            endRowB,
            capNormalEnd || normalHintEnd || normalHintStart || null,
            bulgeEnd,
            /*mirror*/ true
        );
        if (!builtEnd) {
            const Pend = railP[n - 1];
            const Aend = arcRings[n - 1];
            for (let j = 0; j < arcSegments; j++) {
                const a0 = Aend[j], a1 = Aend[j + 1];
                if (triArea2(Pend, a1, a0) > 1e-32) solid.addTriangle(faceCapEnd, vToArr(Pend), vToArr(a1), vToArr(a0));
            }
        }
    }
}

// Extend side strips (on face A and face B) beyond the first and last
// samples of the original edge by an absolute length `extendLen`, and close
// each extension with a triangular cap. Points on A/B are projected to their
// respective face triangle meshes to stay on-surface.
function estimateOvershootLength(targetSolid, rEff){
    try {
        const mesh = targetSolid?.getMesh();
        if (!mesh) return Math.max(10*rEff, 1e-3);
        const vp = mesh.vertProperties;
        let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
        for(let i=0;i<vp.length;i+=3){
            const x=vp[i],y=vp[i+1],z=vp[i+2];
            if(x<minX)minX=x; if(y<minY)minY=y; if(z<minZ)minZ=z;
            if(x>maxX)maxX=x; if(y>maxY)maxY=y; if(z>maxZ)maxZ=z;
        }
        const dx=maxX-minX, dy=maxY-minY, dz=maxZ-minZ;
        const diag = Math.hypot(dx,dy,dz);
        return Math.max(2*rEff, 0.3*diag);
    } catch { return Math.max(10*rEff, 1e-3); }
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
        const A = [ [nA.x, nA.y, nA.z], [nB.x, nB.y, nB.z], [t.x, t.y, t.z] ];
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

function det3(M) {
    const a = M[0][0], b = M[0][1], c = M[0][2];
    const d = M[1][0], e = M[1][1], f = M[1][2];
    const g = M[2][0], h = M[2][1], i = M[2][2];
    return a*(e*i - f*h) - b*(d*i - f*g) + c*(d*h - e*g);
}

// Replace `dst` authoring data with the contents of `src` Solid
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
}

// Offset every vertex of a closed solid along its outward vertex normal
// by a small distance. Intended for tiny epsilons to improve boolean
// robustness by removing thin slivers when subtracting the tool.
// Modifies `solid` in-place by rebuilding its authoring arrays from the
// inflated vertex positions while preserving face names.
// (removed unused inflateSolidInPlace)

// Inflate only a subset of faces (by name predicate), accumulating
// area-weighted normals from those faces and offsetting the vertices
// that participate in them. Vertices not touched by the predicate
// remain in place. Shared seam vertices will shift accordingly,
// preserving watertightness while biasing only the intended faces.
// (removed unused inflateSolidFacesInPlace)

// Convenience: inflate just the fillet side-strip faces ("..._SIDE_A" / "..._SIDE_B")
// (removed unused convenience inflators)

// Displace the input P-rail along the average of the two face normals.
// Positive distance moves along outward average for OUTSET, negative for INSET.
function displaceRailPForInflate(railP, trisA, trisB, distance, sideMode = 'INSET') {
    const faceDataA = getCachedFaceDataForTris(trisA);
    const faceDataB = getCachedFaceDataForTris(trisB);
    const out = new Array(railP.length);
    // For INSET (subtract), move the P-rail outward; for OUTSET (union), move inward.
    const sign = (String(sideMode).toUpperCase() === 'INSET') ? +1 : -1;
    const d = Math.abs(Number(distance) || 0) * sign;
    for (let i = 0; i < railP.length; i++) {
        const p = railP[i];
        // Sample normals from both faces near p
        const qA = projectPointOntoFaceTriangles(trisA, p, faceDataA);
        const qB = projectPointOntoFaceTriangles(trisB, p, faceDataB);
        const nA = normalFromFaceTriangles(trisA, qA);
        const nB = normalFromFaceTriangles(trisB, qB);
        const n = new THREE.Vector3(nA.x + nB.x, nA.y + nB.y, nA.z + nB.z);
        if (n.lengthSq() > 1e-20) n.normalize(); else n.set(0, 0, 0);
        out[i] = p.clone().addScaledVector(n, d);
    }
    return out;
}

// Enforce 2‑manifoldness by removing surplus triangles on edges with >2 incidents.
// Preference order for dropping: SIDE_* (lowest), *_CAP*, then *_ARC* (highest keep).
// Also prefers removing smaller‑area triangles first.
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
            const ax = vp[i0*3+0], ay = vp[i0*3+1], az = vp[i0*3+2];
            const bx = vp[i1*3+0], by = vp[i1*3+1], bz = vp[i1*3+2];
            const cx = vp[i2*3+0], cy = vp[i2*3+1], cz = vp[i2*3+2];
            const ux = bx-ax, uy = by-ay, uz = bz-az;
            const vx = cx-ax, vy = cy-ay, vz = cz-az;
            const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
            return 0.5 * Math.hypot(nx, ny, nz);
        };
        for (let t = 0; t < triCount; t++) {
            const i0 = tv[t*3+0]>>>0, i1 = tv[t*3+1]>>>0, i2 = tv[t*3+2]>>>0;
            const a = areaOf(i0, i1, i2); triArea[t] = a;
            const id = fid ? fid[t] : undefined;
            triName[t] = (id !== undefined) ? (solid._idToFaceName.get(id) || '') : '';
            const add = (a,b) => {
                const i = Math.min(a,b), j = Math.max(a,b);
                const key = i+":"+j;
                let arr = edgeMap.get(key);
                if (!arr) { arr = []; edgeMap.set(key, arr); }
                arr.push(t);
            };
            add(i0,i1); add(i1,i2); add(i2,i0);
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
            const arr = tris.slice().sort((ta,tb)=>{
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
            newTV.push(tv[t*3+0]>>>0, tv[t*3+1]>>>0, tv[t*3+2]>>>0);
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
