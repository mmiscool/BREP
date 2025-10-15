import { Solid } from "../BetterSolid.js";
import manifold from "../setupManifold.js";
import { buildTightPointCloudWrap } from "../PointCloudWrap.js";
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
    arrToV,
    vToArr,
    clamp,
    isFiniteVec3,
    insetPolylineAlongFaceNormals,
    computeSideStripRows,
    buildSideStripOnFace,
    validateCapStripSeam,
    displaceRailPForInflate,
    classifyFilletBoolean,
} from './inset.js';
import { generateEndcapFaces } from './common.js';
import {
    buildWedgeDirect,
    solveCenterFromOffsetPlanesAnchored,
    copyFromSolid,
    quantizeVerticesAuthoring,
    removeDegenerateTrianglesAuthoring,
    ensureOutwardOrientationAuthoring,
    enforceTwoManifoldByDropping,
} from './outset.js';

export { clearFilletCaches, trimFilletCaches } from './inset.js';
export { fixTJunctionsAndPatchHoles } from './outset.js';

export class FilletSolid extends Solid {
    // Public API accepts only UI-driven parameters; all other knobs are internal.
    constructor({ edgeToFillet, radius = 1, sideMode = 'INSET', debug = false, inflate = 0, capBulgeStart = 0, capBulgeEnd = 0 }) {
        super();
        this.edgeToFillet = edgeToFillet;
        this.radius = radius;

        // Scale-adaptive tolerances for numerical robustness
        this.eps = getScaleAdaptiveTolerance(radius, 1e-12);
        this.distTol = getDistanceTolerance(radius);
        this.angleTol = getAngleTolerance();
        this.vecLengthTol = getScaleAdaptiveTolerance(radius, 1e-14);

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
        this.capBulgeEnd = Number.isFinite(capBulgeEnd) ? +capBulgeEnd : 0;
        // Side-strip grid resolution and seam inset tuning
        this.sideStripSubdiv = 8;
        // Scale used to bias seams/side strips just inside the source faces
        // to avoid CSG residue from coincident geometry; applied as
        //   inset = max(eps, seamInsetScale * radius)
        this.seamInsetScale = 1e-3;
        // Prefer projecting side strips onto the source faces for both closed and open edges by default.
        this.projectStripsOpenEdges = true;
        // Apply a slight inward bias for INSET (avoid coplanar residue); OUTSET keeps seams on faces.
        this.forceSeamInset = (this.sideMode !== 'OUTSET');
        // Only use a convex hull as a last‑resort fallback (see later in generate()).
        // Forcing a hull here creates incorrect geometry for open/outset cases
        // because far end-strip vertices can dominate the hull. Keep false.
        this.forcePointCloudHull = false;

        // Input validation for robustness
        this.validate();

        this.generate();
    }

    validate() {
        // Early input validation to catch problems before expensive computation
        if (!this.edgeToFillet) {
            throw new Error("FilletSolid: edgeToFillet is required");
        }

        if (!Number.isFinite(this.radius) || this.radius <= 0) {
            throw new Error(`FilletSolid: radius must be a positive number, got ${this.radius}`);
        }

        // Warn about extreme radius values that may cause numerical issues
        if (this.radius < 1e-6) {
            console.warn(`FilletSolid: very small radius (${this.radius}), may cause precision issues`);
        }
        if (this.radius > 1e6) {
            console.warn(`FilletSolid: very large radius (${this.radius}), may cause precision issues`);
        }
    }

    generate() {
        // Generate fillet geometry based on this.edgeToFillet and this.radius

        if (this.edgeToFillet && this.edgeToFillet.parent) {
            this.operationTargetSolid = this.edgeToFillet.parent;
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
        const faceA = this.edgeToFillet.faces?.[0];
        const faceB = this.edgeToFillet.faces?.[1];
        if (!faceA || !faceB) throw new Error('FilletSolid: edge must have two adjacent faces.');

        // Pull edge polyline in local/object space (positions were authored from MeshGL)
        const polyLocal = this.edgeToFillet.userData?.polylineLocal;
        if (!Array.isArray(polyLocal) || polyLocal.length < 2) throw new Error('FilletSolid: edge polyline missing.');

        // Approximate per-face normals (object space) from Solid topology
        const nAavg = averageFaceNormalObjectSpace(solid, faceA.name);
        const nBavg = averageFaceNormalObjectSpace(solid, faceB.name);
        if (!isFiniteVec3(nAavg) || !isFiniteVec3(nBavg)) {
            throw new Error('FilletSolid: invalid face normals - faces may be degenerate or non-manifold');
        }

        // Check for nearly parallel faces which can cause numerical issues
        const normalDot = Math.abs(nAavg.dot(nBavg));
        if (normalDot > 0.95) {
            console.warn(`FilletSolid: faces are nearly parallel (dot=${normalDot.toFixed(3)}), fillet may be unstable`);
        }

        // Fetch triangle lists for both faces once; used for both per‑section
        // normal sampling and later for seam projection.
        let trisA, trisB;
        try {
            trisA = solid.getFace(faceA.name);
            trisB = solid.getFace(faceB.name);
        } catch (e) {
            throw new Error(`FilletSolid: failed to get face triangles - ${e.message}`);
        }

        if (!Array.isArray(trisA) || trisA.length === 0) {
            throw new Error(`FilletSolid: face A (${faceA.name}) has no triangles`);
        }
        if (!Array.isArray(trisB) || trisB.length === 0) {
            throw new Error(`FilletSolid: face B (${faceB.name}) has no triangles`);
        }

        // Fetch cached face data for faster point projections and normal calculations
        const faceDataA = getCachedFaceDataForTris(trisA, faceA.name);
        const faceDataB = getCachedFaceDataForTris(trisB, faceB.name);

        // Use a consistent outward hint for cap normals based on the average
        // of adjacent face outward normals. This avoids per-end frame flips
        // and keeps both end caps bulging in the same outward direction.
        this.capNormalHint = (() => {
            try {
                const h = nAavg.clone().add(nBavg);
                if (h.lengthSq() > 1e-20) return h.normalize();
            } catch { }
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
                const d2 = dx * dx + dy * dy + dz * dz;
                // Tolerance scaled by radius to be unit-friendly
                const eps = this.distTol * this.distTol;
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
        const rEff = Math.max(this.eps, this.radius);

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
            if (t.lengthSq() < this.vecLengthTol) continue;
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
            if (vA3.lengthSq() < this.eps || vB3.lengthSq() < this.eps) continue;
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
            if (Math.abs(sinHalf) < this.angleTol) continue;
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
            const C_in = solveCenterFromOffsetPlanesAnchored(p, t, nA, qA, -1, nB, qB, -1, rEff); // inside
            const C_out = solveCenterFromOffsetPlanesAnchored(p, t, nA, qA, +1, nB, qB, +1, rEff); // outside

            // Determine preferred side
            let pick = (this.sideMode === 'OUTSET') ? 'out' : 'in';

            let center = (pick === 'in') ? (C_in || C_out) : (C_out || C_in);

            // Robust fallback if offset plane intersection fails (e.g., nearly parallel faces)
            if (!center) {
                console.warn(`FilletSolid: offset plane intersection failed at sample ${i}, using bisector fallback`);
                // Use 2D bisector method as fallback
                if (bis2.lengthSq() > this.eps) {
                    const dir3 = __tmp4.set(0, 0, 0).addScaledVector(u, bis2.x).addScaledVector(v, bis2.y);
                    if (pick === 'out') dir3.negate();
                    dir3.normalize();
                    center = p.clone().addScaledVector(dir3, expectDist);
                } else {
                    // Last resort: use average normal direction
                    console.warn(`FilletSolid: bisector also failed at sample ${i}, using average normal fallback`);
                    const avgNormal = nA.clone().add(nB).normalize();
                    const sign = (pick === 'in') ? -1 : 1;
                    center = p.clone().addScaledVector(avgNormal, sign * expectDist);
                }
            }

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
                    const aEnd = p.clone().addScaledVector(u, Ls * d0_2.x).addScaledVector(v, Ls * d0_2.y);
                    const bEnd = p.clone().addScaledVector(u, Ls * d1_2.x).addScaledVector(v, Ls * d1_2.y);
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
        // Use batch processing for better performance
        let seamA = batchProjectPointsOntoFace(trisA, railA, faceDataA, faceA.name);
        let seamB = batchProjectPointsOntoFace(trisB, railB, faceDataB, faceB.name);

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

        // Generate endcaps for open edges after building the main geometry
        // This ensures the mesh is manifold before entering the cleanup phase
        if (!isClosed) {
            try {
                const initialEndcaps = this._generateEndcapsIfNeeded(rEff, baseName);
                if (initialEndcaps > 0 && this.debug) {
                    console.log(`FilletSolid: generated ${initialEndcaps} initial endcaps after wedge construction`);
                }
            } catch (e) {
                if (this.debug) {
                    console.warn('FilletSolid: initial endcap generation failed:', e?.message || e);
                }
            }
        }

        // Heuristic: decide union vs subtract based on bisector direction vs outward normals
        this.filletType = classifyFilletBoolean(nAavg, nBavg, polyLocal);

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
        } catch { }

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
        } catch { }

        // Generate endcaps for non-manifold boundaries to ensure manifold mesh
        // This step is crucial for open edges that would otherwise leave the mesh non-manifold
        try {
            if (!isClosed) {
                const endcapsGenerated = this._generateEndcapsIfNeeded(rEff, baseName);
                if (endcapsGenerated > 0 && this.debug) {
                    console.log(`FilletSolid: generated ${endcapsGenerated} endcaps for manifold closure`);
                }
            }
        } catch (e) {
            if (this.debug) {
                console.warn('FilletSolid: endcap generation failed:', e?.message || e);
            }
        }




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
                const wrapped = buildTightPointCloudWrap(pts, {});
                copyFromSolid(this, wrapped);
                this.filletType = this.filletType || 'SUBTRACT';
                this.name = 'FILLET_TOOL';
                try { this.fixTriangleWindingsByAdjacency(); } catch { }
                try { ensureOutwardOrientationAuthoring(this); } catch { }
                try { this._weldVerticesByEpsilon(1e-9); } catch { }
                try { removeDegenerateTrianglesAuthoring(this, 1e-14); } catch { }
                try { enforceTwoManifoldByDropping(this, 2); } catch { }
                try { this.fixTriangleWindingsByAdjacency(); } catch { }
            } catch (eHull) {
                try { console.warn('[FilletSolid] forced hull failed:', eHull?.message || eHull); } catch { }
            }
            return this;
        }

        // Proactive manifold check for OUTSET on open edges with face‑projected strips
        // (conical or highly slanted faces can occasionally produce foldovers
        // during projection). If the authored mesh fails to manifoldize, rebuild
        // once with a safer recipe: analytic side strips and a tiny seam inset.
        try {
            // Quick probe; throws on failure
            const __m = this.getMesh();
            try { /* probe */ } finally { try { if (__m && typeof __m.delete === 'function') __m.delete(); } catch { } }
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
                try { this.fixTriangleWindingsByAdjacency(); } catch { }
                try { ensureOutwardOrientationAuthoring(this); } catch { }
                try { this._weldVerticesByEpsilon(1e-9); } catch { }
                try { removeDegenerateTrianglesAuthoring(this, 1e-14); } catch { }
                this.name = 'FILLET_TOOL';
                try { this.userData = this.userData || {}; this.userData.debugBad = true; } catch { }
                // Mark dirty so visualize() rebuilds Three meshes from authoring arrays
                this._dirty = true; this._faceIndex = null; this._manifold = null;
                return this;
            }

        }

        // Final sanity: alert if the tool is non-manifold. This is a UX aid only
        // (does not stop execution). We first check authoring manifoldness and
        // then try to manifoldize. If either fails, pop a browser alert.
        try {
            let nonManifold = false;
            try { if (!this._isCoherentlyOrientedManifold()) nonManifold = true; } catch { nonManifold = true; }
            if (!nonManifold) {
                try {
                    const __m2 = this.getMesh();
                    try { /* probe */ } finally { try { if (__m2 && typeof __m2.delete === 'function') __m2.delete(); } catch { } }
                } catch { nonManifold = true; }
            }
            if (nonManifold) {
                const msg = `Fillet tool is non-manifold. Boolean may fail.\n` +
                    `Edge faces: ${faceA?.name || '?'} | ${faceB?.name || '?'}`;
                if (typeof window !== 'undefined' && typeof window.alert === 'function') {
                    window.alert(msg);
                } else if (typeof alert === 'function') {
                    alert(msg);
                } else {
                    try { console.warn(msg); } catch { }
                }
            }
        } catch { /* never block the pipeline */ }

        // Perform cache maintenance to prevent memory leaks
        trimFilletCaches();

        // No manual Three.js mesh here; rely on Solid.visualize() for inspection
        return this;
    }

    /**
     * Generate endcaps for non-manifold boundaries to create a proper manifold mesh.
     * This method detects open boundaries and triangulates them to close the mesh.
     * 
     * @param {number} radius - The fillet radius for scale-appropriate tolerances
     * @param {string} baseName - Base name for the endcap faces
     * @returns {number} Number of endcaps generated
     */
    _generateEndcapsIfNeeded(radius, baseName) {
        // Generate endcaps for manifold mesh creation
        if (this.debug) {
            console.log('Starting endcap generation for manifold mesh...');
        }
        
        try {
            // Check if we actually need endcaps
            const boundaryLoops = this._findBoundaryLoops();
            if (!boundaryLoops || boundaryLoops.length === 0) {
                if (this.debug) {
                    console.log('No boundary loops found - mesh already manifold');
                }
                return 0;
            }
            
            if (this.debug) {
                console.log(`Found ${boundaryLoops.length} boundary loops to patch:`);
                for (let i = 0; i < boundaryLoops.length; i++) {
                    const loop = boundaryLoops[i];
                    console.log(`  Loop ${i}: ${loop.vertices.length} vertices`);
                }
            }
            
            const patchCount = this._patchAllHoles(baseName);
            if (this.debug) {
                if (patchCount > 0) {
                    console.log(`✓ Successfully patched ${patchCount} holes for manifold mesh`);
                } else {
                    console.log(`⚠ No holes were patched - check boundary loop detection`);
                }
            }
            return patchCount;
        } catch (error) {
            if (this.debug) {
                console.error('Endcap generation failed:', error.message);
            }
            return 0;
        }
    }

    /**
     * Patch all holes in the mesh to ensure manifold topology
     * @param {string} baseName - Base name for patch faces
     * @returns {number} Number of holes patched
     */
    _patchAllHoles(baseName) {
        const boundaryLoops = this._findBoundaryLoops();
        if (!boundaryLoops || boundaryLoops.length === 0) {
            return 0;
        }

        let holesPatched = 0;
        for (let i = 0; i < boundaryLoops.length; i++) {
            const loop = boundaryLoops[i];
            if (loop.vertices && loop.vertices.length >= 3) {
                const patchName = `${baseName}_PATCH_${i}`;
                
                if (this.debug) {
                    console.log(`Attempting to patch hole ${patchName} with ${loop.vertices.length} vertices`);
                }
                
                try {
                    const triangleCount = this._patchHole(loop, patchName);
                    if (triangleCount > 0) {
                        holesPatched++;
                        if (this.debug) {
                            console.log(`✓ Generated endcap face ${patchName} with ${triangleCount} triangles`);
                        }
                    } else if (this.debug) {
                        console.log(`⚠ Failed to generate triangles for ${patchName}`);
                    }
                } catch (error) {
                    if (this.debug) {
                        console.error(`✗ Error patching ${patchName}:`, error.message);
                    }
                }
            } else if (this.debug) {
                console.log(`Skipping invalid loop ${i}: ${loop.vertices ? loop.vertices.length : 'no vertices'} vertices`);
            }
        }

        // Clean up after patching
        if (holesPatched > 0) {
            this._cleanupAfterPatching();
        }

        return holesPatched;
    }

    /**
     * Find boundary loops (holes) in the mesh
     * @returns {Array<{vertices: number[], positions: THREE.Vector3[]}>} Array of boundary loops
     */
    _findBoundaryLoops() {
        const vp = this._vertProperties;
        const tv = this._triVerts;
        if (!tv || tv.length < 3 || !vp || vp.length < 9) {
            return [];
        }

        // Build edge adjacency map
        const edgeCount = new Map();
        const triCount = Math.floor(tv.length / 3);

        // Count edge usage
        for (let t = 0; t < triCount; t++) {
            const i0 = tv[t * 3 + 0];
            const i1 = tv[t * 3 + 1];
            const i2 = tv[t * 3 + 2];

            const edges = [[i0, i1], [i1, i2], [i2, i0]];
            for (const [a, b] of edges) {
                const key = a < b ? `${a}:${b}` : `${b}:${a}`;
                edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
            }
        }

        // Find boundary edges (used only once)
        const boundaryEdges = [];
        for (const [key, count] of edgeCount) {
            if (count === 1) {
                const [a, b] = key.split(':').map(Number);
                boundaryEdges.push([a, b]);
            }
        }

        if (boundaryEdges.length === 0) {
            return [];
        }

        // Group boundary edges into loops
        return this._groupEdgesIntoLoops(boundaryEdges, vp);
    }

    /**
     * Group boundary edges into connected loops
     * @param {Array<[number, number]>} edges - Boundary edges
     * @param {Float32Array} vp - Vertex properties
     * @returns {Array<{vertices: number[], positions: THREE.Vector3[]}>} Loops
     */
    _groupEdgesIntoLoops(edges, vp) {
        const adjacency = new Map();
        
        // Build adjacency map
        for (const [a, b] of edges) {
            if (!adjacency.has(a)) adjacency.set(a, []);
            if (!adjacency.has(b)) adjacency.set(b, []);
            adjacency.get(a).push(b);
            adjacency.get(b).push(a);
        }

        const loops = [];
        const visited = new Set();

        for (const [startVertex] of adjacency) {
            if (visited.has(startVertex)) continue;

            const loop = this._traceLoop(startVertex, adjacency, visited, vp);
            if (loop && loop.vertices.length >= 3) {
                loops.push(loop);
            }
        }

        return loops;
    }

    /**
     * Trace a boundary loop starting from a vertex
     * @param {number} start - Starting vertex index
     * @param {Map} adjacency - Vertex adjacency map
     * @param {Set} visited - Set of visited vertices
     * @param {Float32Array} vp - Vertex properties
     * @returns {Object|null} Loop object or null if invalid
     */
    _traceLoop(start, adjacency, visited, vp) {
        const vertices = [];
        const positions = [];
        let current = start;
        let previous = -1;

        do {
            if (visited.has(current)) break;
            
            visited.add(current);
            vertices.push(current);
            
            // Add position
            const pos = new THREE.Vector3(
                vp[current * 3 + 0],
                vp[current * 3 + 1], 
                vp[current * 3 + 2]
            );
            positions.push(pos);

            // Find next vertex
            const neighbors = adjacency.get(current) || [];
            let next = -1;
            
            for (const neighbor of neighbors) {
                if (neighbor !== previous) {
                    next = neighbor;
                    break;
                }
            }

            if (next === -1 || next === start) break;
            
            previous = current;
            current = next;

        } while (current !== start && vertices.length < 1000); // Safety limit

        return vertices.length >= 3 ? { vertices, positions } : null;
    }

    /**
     * Patch a single hole using robust triangulation
     * @param {Object} loop - Boundary loop to patch
     * @param {string} patchName - Name for patch triangles
     * @returns {boolean} Success status
     */
    _patchHole(loop, patchName) {
        try {
            const positions = loop.positions;
            if (!positions || positions.length < 3) {
                if (this.debug) {
                    console.log(`Invalid loop for ${patchName}: ${positions ? positions.length : 0} positions`);
                }
                return 0;
            }

            if (this.debug) {
                console.log(`Patching hole ${patchName} with ${positions.length} vertices using robust triangulation`);
            }

            return this._robustTriangulateLoop(positions, patchName);
            
        } catch (error) {
            if (this.debug) {
                console.warn(`Failed to patch hole ${patchName}:`, error.message);
            }
            return 0;
        }
    }

    /**
     * Boundary-respecting triangulation that ONLY connects consecutive boundary vertices
     * This ensures no triangle spans across multiple boundary edge segments
     * @param {Array<THREE.Vector3>} positions - Loop positions  
     * @param {string} faceName - Name for triangles
     * @returns {number} Number of triangles created
     */
    _robustTriangulateLoop(positions, faceName) {
        if (positions.length < 3) return 0;

        // For triangles, add directly
        if (positions.length === 3) {
            this.addTriangle(faceName,
                [positions[0].x, positions[0].y, positions[0].z],
                [positions[1].x, positions[1].y, positions[1].z],
                [positions[2].x, positions[2].y, positions[2].z]);
            if (this.debug) {
                console.log(`Added direct triangle for ${faceName}`);
            }
            return 1;
        }

        if (positions.length === 4) {
            // For quads, use optimal diagonal to avoid long edges
            return this._triangulateQuadOptimal(positions, faceName);
        }

        // For larger polygons, use boundary-constrained approach
        return this._boundaryConstrainedTriangulation(positions, faceName);
    }

    /**
     * Triangulate a quad using the shorter diagonal to avoid long edges
     * @param {Array<THREE.Vector3>} positions - Quad vertices (4 positions)
     * @param {string} faceName - Face name
     * @returns {number} Number of triangles created
     */
    _triangulateQuadOptimal(positions, faceName) {
        const [p0, p1, p2, p3] = positions;
        
        // Calculate both diagonal lengths
        const diag1 = p0.distanceTo(p2); // 0-2 diagonal
        const diag2 = p1.distanceTo(p3); // 1-3 diagonal
        
        let triangleCount = 0;
        
        if (diag1 <= diag2) {
            // Use 0-2 diagonal (shorter or equal)
            const area1 = this._calculateTriangleArea(p0, p1, p2);
            const area2 = this._calculateTriangleArea(p0, p2, p3);
            
            if (area1 > 1e-12) {
                this.addTriangle(faceName, [p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z]);
                triangleCount++;
            }
            if (area2 > 1e-12) {
                this.addTriangle(faceName, [p0.x, p0.y, p0.z], [p2.x, p2.y, p2.z], [p3.x, p3.y, p3.z]);
                triangleCount++;
            }
        } else {
            // Use 1-3 diagonal (shorter)
            const area1 = this._calculateTriangleArea(p1, p2, p3);
            const area2 = this._calculateTriangleArea(p1, p3, p0);
            
            if (area1 > 1e-12) {
                this.addTriangle(faceName, [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z], [p3.x, p3.y, p3.z]);
                triangleCount++;
            }
            if (area2 > 1e-12) {
                this.addTriangle(faceName, [p1.x, p1.y, p1.z], [p3.x, p3.y, p3.z], [p0.x, p0.y, p0.z]);
                triangleCount++;
            }
        }
        
        if (this.debug) {
            console.log(`Quad triangulation created ${triangleCount} triangles for ${faceName} using ${diag1 <= diag2 ? '0-2' : '1-3'} diagonal`);
        }
        
        return triangleCount;
    }

    /**
     * Boundary-constrained triangulation that respects original edge segments
     * Only creates interior triangulation points, never spans across boundary segments
     * @param {Array<THREE.Vector3>} positions - Loop positions
     * @param {string} faceName - Face name
     * @returns {number} Number of triangles created
     */
    _boundaryConstrainedTriangulation(positions, faceName) {
        if (positions.length < 5) {
            // Fallback to fan for small polygons
            return this._fallbackFanTriangulation(positions, faceName);
        }

        try {
            // Calculate a safe interior point for triangulation
            const interiorPoint = this._calculateSafeInteriorPoint(positions);
            if (!interiorPoint) {
                if (this.debug) {
                    console.warn(`Could not find safe interior point for ${faceName}, using fallback`);
                }
                return this._fallbackFanTriangulation(positions, faceName);
            }

            // Create triangles from interior point to each boundary edge
            let triangleCount = 0;
            for (let i = 0; i < positions.length; i++) {
                const p1 = positions[i];
                const p2 = positions[(i + 1) % positions.length];
                
                // Each triangle connects: interior_point -> edge_vertex_1 -> edge_vertex_2
                // This ensures we only connect consecutive boundary vertices
                const area = this._calculateTriangleArea(interiorPoint, p1, p2);
                if (area > 1e-12) {
                    this.addTriangle(faceName,
                        [interiorPoint.x, interiorPoint.y, interiorPoint.z],
                        [p1.x, p1.y, p1.z],
                        [p2.x, p2.y, p2.z]);
                    triangleCount++;
                }
            }

            if (this.debug) {
                console.log(`Boundary-constrained triangulation created ${triangleCount} triangles for ${faceName}`);
            }
            
            return triangleCount;

        } catch (error) {
            if (this.debug) {
                console.warn(`Boundary-constrained triangulation failed for ${faceName}:`, error.message);
            }
            return this._fallbackFanTriangulation(positions, faceName);
        }
    }

    /**
     * Calculate a safe interior point that doesn't create long edges
     * @param {Array<THREE.Vector3>} positions - Boundary positions
     * @returns {THREE.Vector3|null} Interior point or null if none found
     */
    _calculateSafeInteriorPoint(positions) {
        // Start with the centroid
        const centroid = new THREE.Vector3();
        for (const pos of positions) {
            centroid.add(pos);
        }
        centroid.multiplyScalar(1 / positions.length);

        // Check if centroid is actually inside the polygon
        if (this._isPointInsidePolygon3D(centroid, positions)) {
            // Verify all triangles from centroid to boundary edges are reasonable
            let maxEdgeLength = 0;
            for (let i = 0; i < positions.length; i++) {
                const p1 = positions[i];
                const p2 = positions[(i + 1) % positions.length];
                
                const edge1 = centroid.distanceTo(p1);
                const edge2 = centroid.distanceTo(p2);
                const boundary = p1.distanceTo(p2);
                
                maxEdgeLength = Math.max(maxEdgeLength, edge1, edge2, boundary);
            }
            
            // If centroid creates reasonable triangles, use it
            if (maxEdgeLength < this._calculateBoundaryBounds(positions).maxDimension * 2) {
                return centroid;
            }
        }

        // If centroid doesn't work, try finding a point closer to the boundary
        return this._findConstrainedInteriorPoint(positions);
    }

    /**
     * Find an interior point by moving inward from boundary
     * @param {Array<THREE.Vector3>} positions - Boundary positions
     * @returns {THREE.Vector3|null} Interior point or null
     */
    _findConstrainedInteriorPoint(positions) {
        // Calculate boundary bounds
        const bounds = this._calculateBoundaryBounds(positions);
        const normal = this._calculateNewellNormal(positions);
        
        // Try several candidate points along the boundary inward direction
        for (let i = 0; i < positions.length; i++) {
            const p1 = positions[i];
            const p2 = positions[(i + 1) % positions.length];
            const p3 = positions[(i + 2) % positions.length];
            
            // Calculate inward direction at this edge
            const edge = new THREE.Vector3().subVectors(p2, p1);
            const edgeNormal = new THREE.Vector3().crossVectors(edge, normal).normalize();
            
            // Try points at various inward distances
            for (const inwardFactor of [0.1, 0.2, 0.3]) {
                const inwardDist = bounds.maxDimension * inwardFactor;
                const candidate = new THREE.Vector3()
                    .addVectors(p1, p2)
                    .multiplyScalar(0.5) // Midpoint of edge
                    .addScaledVector(edgeNormal, inwardDist);
                
                if (this._isPointInsidePolygon3D(candidate, positions)) {
                    return candidate;
                }
            }
        }
        
        return null; // No suitable interior point found
    }

    /**
     * Calculate boundary bounds for size reference
     * @param {Array<THREE.Vector3>} positions - Boundary positions
     * @returns {Object} Bounds information
     */
    _calculateBoundaryBounds(positions) {
        const min = new THREE.Vector3(Infinity, Infinity, Infinity);
        const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        
        for (const pos of positions) {
            min.min(pos);
            max.max(pos);
        }
        
        const size = new THREE.Vector3().subVectors(max, min);
        return {
            min, max, size,
            maxDimension: Math.max(size.x, size.y, size.z)
        };
    }

    /**
     * Test if point is inside 3D polygon using winding number
     * @param {THREE.Vector3} point - Point to test
     * @param {Array<THREE.Vector3>} positions - Polygon vertices
     * @returns {boolean} True if inside
     */
    _isPointInsidePolygon3D(point, positions) {
        // Project to 2D for point-in-polygon test
        const normal = this._calculateNewellNormal(positions);
        const absNormal = new THREE.Vector3(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
        
        let projectionPlane = 2; // Default to XY
        if (absNormal.x > absNormal.y && absNormal.x > absNormal.z) projectionPlane = 0;
        else if (absNormal.y > absNormal.z) projectionPlane = 1;
        
        // Project point and polygon to 2D
        const point2D = this._projectTo2D(point, projectionPlane);
        const polygon2D = positions.map(p => this._projectTo2D(p, projectionPlane));
        
        return this._pointInPolygon2D(point2D, polygon2D);
    }

    /**
     * Project 3D point to 2D based on plane
     * @param {THREE.Vector3} point - 3D point
     * @param {number} plane - Projection plane (0=YZ, 1=XZ, 2=XY)
     * @returns {Object} 2D point {x, y}
     */
    _projectTo2D(point, plane) {
        switch (plane) {
            case 0: return { x: point.y, y: point.z };
            case 1: return { x: point.x, y: point.z };
            default: return { x: point.x, y: point.y };
        }
    }

    /**
     * 2D point-in-polygon test using winding number
     * @param {Object} point - 2D point {x, y}
     * @param {Array<Object>} polygon - 2D polygon vertices
     * @returns {boolean} True if inside
     */
    _pointInPolygon2D(point, polygon) {
        let wn = 0; // Winding number
        
        for (let i = 0; i < polygon.length; i++) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % polygon.length];
            
            if (p1.y <= point.y) {
                if (p2.y > point.y && this._isLeft2D(p1, p2, point) > 0) {
                    wn++;
                }
            } else {
                if (p2.y <= point.y && this._isLeft2D(p1, p2, point) < 0) {
                    wn--;
                }
            }
        }
        
        return wn !== 0;
    }

    /**
     * Test if point is left of line in 2D
     * @param {Object} p0 - Line start {x, y}
     * @param {Object} p1 - Line end {x, y}
     * @param {Object} p2 - Test point {x, y}
     * @returns {number} >0 if left, <0 if right, 0 if on line
     */
    _isLeft2D(p0, p1, p2) {
        return (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
    }

    /**
     * Legacy constrained ear clipping (kept for fallback)
     * @param {Array<THREE.Vector3>} positions - Loop positions
     * @param {string} faceName - Face name
     * @returns {number} Number of triangles created
     */
    _constrainedEarClipping(positions, faceName) {
        if (positions.length < 3) return 0;

        // Calculate loop normal using Newell's method
        const normal = this._calculateNewellNormal(positions);
        
        // Find best projection plane (largest component of normal)
        const absNormal = new THREE.Vector3(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
        let projectionPlane = 2; // Default to XY (Z normal)
        if (absNormal.x > absNormal.y && absNormal.x > absNormal.z) projectionPlane = 0; // YZ plane
        else if (absNormal.y > absNormal.z) projectionPlane = 1; // XZ plane

        // Project to 2D for calculations
        const points2D = positions.map(p => {
            switch (projectionPlane) {
                case 0: return { x: p.y, y: p.z }; // YZ plane
                case 1: return { x: p.x, y: p.z }; // XZ plane
                default: return { x: p.x, y: p.y }; // XY plane
            }
        });

        // Clean up duplicate consecutive points but preserve original indices
        const { cleanPositions, indexMapping } = this._cleanupWithMapping(positions, points2D);
        if (cleanPositions.length < 3) {
            if (this.debug) {
                console.warn(`Too few unique points after cleaning for ${faceName}`);
            }
            return 0;
        }

        if (this.debug) {
            console.log(`Constrained ear clipping for ${faceName}: ${cleanPositions.length} vertices`);
        }

        // Perform constrained ear clipping
        const vertices = cleanPositions.slice(); // Work with copies
        const indices = Array.from({ length: vertices.length }, (_, i) => i);
        let triangleCount = 0;
        let attempts = 0;
        const maxAttempts = vertices.length * 2;

        while (vertices.length > 3 && attempts < maxAttempts) {
            let earFound = false;
            
            for (let i = 0; i < vertices.length; i++) {
                if (this._isValidConstrainedEar(vertices, indices, i, projectionPlane)) {
                    // Create triangle from ear
                    const prevIdx = (i - 1 + vertices.length) % vertices.length;
                    const nextIdx = (i + 1) % vertices.length;
                    
                    const p0 = vertices[prevIdx];
                    const p1 = vertices[i];
                    const p2 = vertices[nextIdx];
                    
                    const area = this._calculateTriangleArea(p0, p1, p2);
                    if (area > 1e-12) {
                        this.addTriangle(faceName,
                            [p0.x, p0.y, p0.z],
                            [p1.x, p1.y, p1.z],
                            [p2.x, p2.y, p2.z]);
                        triangleCount++;
                        
                        if (this.debug) {
                            console.log(`Added constrained ear triangle ${triangleCount} for ${faceName}`);
                        }
                    }

                    // Remove the ear vertex
                    vertices.splice(i, 1);
                    indices.splice(i, 1);
                    earFound = true;
                    break;
                }
            }
            
            if (!earFound) {
                if (this.debug) {
                    console.warn(`No ear found, switching to fallback for ${faceName}`);
                }
                break;
            }
            attempts++;
        }

        // Add the final triangle if we have exactly 3 vertices left
        if (vertices.length === 3) {
            const area = this._calculateTriangleArea(vertices[0], vertices[1], vertices[2]);
            if (area > 1e-12) {
                this.addTriangle(faceName,
                    [vertices[0].x, vertices[0].y, vertices[0].z],
                    [vertices[1].x, vertices[1].y, vertices[1].z],
                    [vertices[2].x, vertices[2].y, vertices[2].z]);
                triangleCount++;
                
                if (this.debug) {
                    console.log(`Added final triangle for ${faceName}`);
                }
            }
        }

        if (this.debug) {
            console.log(`Constrained ear clipping created ${triangleCount} triangles for ${faceName}`);
        }
        
        return triangleCount;
    }

    /**
     * Clean up positions while maintaining index mapping
     * @param {Array<THREE.Vector3>} positions3D - Original 3D positions
     * @param {Array<Object>} points2D - Projected 2D points
     * @returns {Object} - { cleanPositions, indexMapping }
     */
    _cleanupWithMapping(positions3D, points2D, eps = 1e-10) {
        const cleanPositions = [];
        const indexMapping = [];
        let prev2D = null;
        
        for (let i = 0; i < positions3D.length; i++) {
            const curr2D = points2D[i];
            if (!prev2D || Math.abs(curr2D.x - prev2D.x) > eps || Math.abs(curr2D.y - prev2D.y) > eps) {
                cleanPositions.push(positions3D[i]);
                indexMapping.push(i);
                prev2D = curr2D;
            }
        }
        
        return { cleanPositions, indexMapping };
    }

    /**
     * Check if vertex forms a valid constrained ear (respects boundary edges)
     * @param {Array<THREE.Vector3>} vertices - Current vertices
     * @param {Array<number>} indices - Current indices
     * @param {number} i - Index to test
     * @param {number} projectionPlane - Projection plane (0=YZ, 1=XZ, 2=XY)
     * @returns {boolean} True if valid ear
     */
    _isValidConstrainedEar(vertices, indices, i, projectionPlane) {
        const n = vertices.length;
        const prev = vertices[(i - 1 + n) % n];
        const curr = vertices[i];
        const next = vertices[(i + 1) % n];
        
        // Check if angle is convex in 2D projection
        const prevIdx = (i - 1 + n) % n;
        const nextIdx = (i + 1) % n;
        
        if (!this._isConvexVertex2D(vertices, prevIdx, i, nextIdx, projectionPlane)) {
            return false;
        }
        
        // Check that no other vertex lies inside the triangle
        for (let j = 0; j < n; j++) {
            if (j === prevIdx || j === i || j === nextIdx) continue;
            
            if (this._isPointInTriangle2D(vertices[j], prev, curr, next, projectionPlane)) {
                return false;
            }
        }
        
        return true;
    }

    /**
     * Check if vertex is convex in 2D projection
     * @param {Array<THREE.Vector3>} vertices - Vertices
     * @param {number} prevIdx - Previous vertex index
     * @param {number} currIdx - Current vertex index  
     * @param {number} nextIdx - Next vertex index
     * @param {number} projectionPlane - Projection plane
     * @returns {boolean} True if convex
     */
    _isConvexVertex2D(vertices, prevIdx, currIdx, nextIdx, projectionPlane) {
        const prev = vertices[prevIdx];
        const curr = vertices[currIdx];
        const next = vertices[nextIdx];
        
        // Get 2D coordinates based on projection plane
        let px, py, cx, cy, nx, ny;
        switch (projectionPlane) {
            case 0: // YZ plane
                px = prev.y; py = prev.z;
                cx = curr.y; cy = curr.z;
                nx = next.y; ny = next.z;
                break;
            case 1: // XZ plane
                px = prev.x; py = prev.z;
                cx = curr.x; cy = curr.z;
                nx = next.x; ny = next.z;
                break;
            default: // XY plane
                px = prev.x; py = prev.y;
                cx = curr.x; cy = curr.y;
                nx = next.x; ny = next.y;
                break;
        }
        
        // Calculate cross product to determine convexity
        const cross = (cx - px) * (ny - cy) - (cy - py) * (nx - cx);
        return cross > 0; // Counter-clockwise is convex
    }

    /**
     * Point-in-triangle test in 2D projection
     * @param {THREE.Vector3} point - Point to test
     * @param {THREE.Vector3} a - Triangle vertex A
     * @param {THREE.Vector3} b - Triangle vertex B
     * @param {THREE.Vector3} c - Triangle vertex C
     * @param {number} projectionPlane - Projection plane
     * @returns {boolean} True if inside triangle
     */
    _isPointInTriangle2D(point, a, b, c, projectionPlane) {
        // Get 2D coordinates
        let px, py, ax, ay, bx, by, cx, cy;
        switch (projectionPlane) {
            case 0: // YZ plane
                px = point.y; py = point.z;
                ax = a.y; ay = a.z;
                bx = b.y; by = b.z;
                cx = c.y; cy = c.z;
                break;
            case 1: // XZ plane
                px = point.x; py = point.z;
                ax = a.x; ay = a.z;
                bx = b.x; by = b.z;
                cx = c.x; cy = c.z;
                break;
            default: // XY plane
                px = point.x; py = point.y;
                ax = a.x; ay = a.y;
                bx = b.x; by = b.y;
                cx = c.x; cy = c.y;
                break;
        }
        
        // Barycentric coordinates test
        const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(denom) < 1e-10) return false; // Degenerate triangle
        
        const alpha = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / denom;
        const beta = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / denom;
        const gamma = 1 - alpha - beta;
        
        return alpha > 1e-10 && beta > 1e-10 && gamma > 1e-10;
    }

    /**
     * Calculate normal using Newell's method (robust for non-planar polygons)
     * @param {Array<THREE.Vector3>} positions - Loop positions
     * @returns {THREE.Vector3} Normal vector
     */
    _calculateNewellNormal(positions) {
        const normal = new THREE.Vector3();
        const n = positions.length;
        
        for (let i = 0; i < n; i++) {
            const p0 = positions[i];
            const p1 = positions[(i + 1) % n];
            
            normal.x += (p0.y - p1.y) * (p0.z + p1.z);
            normal.y += (p0.z - p1.z) * (p0.x + p1.x);
            normal.z += (p0.x - p1.x) * (p0.y + p1.y);
        }
        
        return normal.normalize();
    }

    /**
     * Remove consecutive duplicate points in 2D
     * @param {Array<THREE.Vector2>} points - 2D points
     * @returns {Array<THREE.Vector2>} Cleaned points
     */
    _removeDuplicatePoints2D(points, eps = 1e-10) {
        const cleaned = [];
        let prev = null;
        
        for (const point of points) {
            if (!prev || prev.distanceTo(point) > eps) {
                cleaned.push(point);
                prev = point;
            }
        }
        
        return cleaned;
    }

    /**
     * Fallback fan triangulation when robust method fails
     * @param {Array<THREE.Vector3>} positions - Loop positions
     * @param {string} faceName - Face name
     * @returns {number} Number of triangles created
     */
    _fallbackFanTriangulation(positions, faceName) {
        let triangleCount = 0;
        
        for (let i = 1; i < positions.length - 1; i++) {
            const area = this._calculateTriangleArea(positions[0], positions[i], positions[i + 1]);
            if (area > 1e-12) {
                this.addTriangle(faceName,
                    [positions[0].x, positions[0].y, positions[0].z],
                    [positions[i].x, positions[i].y, positions[i].z],
                    [positions[i + 1].x, positions[i + 1].y, positions[i + 1].z]);
                triangleCount++;
            }
        }
        
        if (this.debug) {
            console.log(`Fallback fan triangulation created ${triangleCount} triangles for ${faceName}`);
        }
        return triangleCount;
    }

    /**
     * Calculate triangle area
     * @param {THREE.Vector3} p0 - First vertex
     * @param {THREE.Vector3} p1 - Second vertex  
     * @param {THREE.Vector3} p2 - Third vertex
     * @returns {number} Triangle area
     */
    _calculateTriangleArea(p0, p1, p2) {
        const v1 = new THREE.Vector3().subVectors(p1, p0);
        const v2 = new THREE.Vector3().subVectors(p2, p0);
        return v1.cross(v2).length() * 0.5;
    }

    /**
     * Calculate normal vector for a boundary loop
     * @param {Array<THREE.Vector3>} positions - Loop positions
     * @returns {THREE.Vector3} Normal vector
     */
    _calculateLoopNormal(positions) {
        if (positions.length < 3) return new THREE.Vector3(0, 0, 1);
        return this._calculateNewellNormal(positions);
    }

    /**
     * Add triangular patch
     */
    _addTrianglePatch(positions, normal, patchName) {
        // Ensure correct winding order
        const [p0, p1, p2] = positions;
        const computedNormal = new THREE.Vector3()
            .subVectors(p1, p0)
            .cross(new THREE.Vector3().subVectors(p2, p0))
            .normalize();

        if (computedNormal.dot(normal) < 0) {
            // Reverse winding - all triangles use the same face name
            this.addTriangle(patchName, [p0.x, p0.y, p0.z], [p2.x, p2.y, p2.z], [p1.x, p1.y, p1.z]);
        } else {
            this.addTriangle(patchName, [p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z]);
        }
        return true;
    }

    /**
     * Add quadrilateral patch (two triangles)
     */
    _addQuadPatch(positions, normal, patchName) {
        const [p0, p1, p2, p3] = positions;
        
        // Split quad into two triangles - choose best diagonal
        const diag1Length = p0.distanceTo(p2);
        const diag2Length = p1.distanceTo(p3);
        
        if (diag1Length < diag2Length) {
            // Use p0-p2 diagonal - both triangles use the same face name
            this._addTrianglePatch([p0, p1, p2], normal, patchName);
            this._addTrianglePatch([p0, p2, p3], normal, patchName);
        } else {
            // Use p1-p3 diagonal - both triangles use the same face name
            this._addTrianglePatch([p0, p1, p3], normal, patchName);
            this._addTrianglePatch([p1, p2, p3], normal, patchName);
        }
        return true;
    }



    // Simple triangulation helper methods

    /**
     * Calculate loop normal for consistent orientation  
     */
    _calculateLoopNormal(positions) {
        if (positions.length < 3) return false;
        if (positions.length === 3) {
            return this._addTrianglePatch(positions, normal, patchName);
        }

        if (this.debug) {
            console.log(`Ear clipping triangulation for ${patchName} with ${positions.length} vertices`);
        }

        // Create a working copy of vertices
        const vertices = [...positions];
        let triangleCount = 0;

        // Simple ear clipping - find and remove ears until only 3 vertices remain
        while (vertices.length > 3) {
            let earRemoved = false;

            // Look for an ear (convex vertex with no other vertices inside the triangle)
            for (let i = 0; i < vertices.length; i++) {
                const prev = vertices[(i - 1 + vertices.length) % vertices.length];
                const curr = vertices[i];
                const next = vertices[(i + 1) % vertices.length];

                // Check if this vertex forms a convex angle
                if (this._isConvexVertex(prev, curr, next, normal)) {
                    // Check if any other vertex is inside this triangle
                    let hasVertexInside = false;
                    for (let j = 0; j < vertices.length; j++) {
                        if (j === i || j === (i - 1 + vertices.length) % vertices.length || j === (i + 1) % vertices.length) {
                            continue; // Skip the triangle vertices themselves
                        }
                        
                        if (this._isPointInTriangle(vertices[j], prev, curr, next)) {
                            hasVertexInside = true;
                            break;
                        }
                    }

                    // If no vertex is inside, this is an ear - triangulate it
                    if (!hasVertexInside) {
                        this._addTrianglePatch([prev, curr, next], normal, patchName);
                        vertices.splice(i, 1); // Remove the ear vertex
                        earRemoved = true;
                        triangleCount++;
                        break;
                    }
                }
            }

            // Safety fallback - if no ear found, force triangulation
            if (!earRemoved) {
                if (this.debug) {
                    console.log(`No ear found, using conservative triangulation for remaining ${vertices.length} vertices`);
                }
                
                // Find a vertex that creates the most "inward" triangles
                let bestCenter = 0;
                let maxInwardness = -Infinity;
                
                for (let centerIdx = 0; centerIdx < vertices.length; centerIdx++) {
                    let inwardness = 0;
                    for (let i = 0; i < vertices.length - 2; i++) {
                        const nextIdx = (centerIdx + 1 + i) % vertices.length;
                        const afterIdx = (centerIdx + 2 + i) % vertices.length;
                        
                        // Skip if indices are the same
                        if (nextIdx === centerIdx || afterIdx === centerIdx || nextIdx === afterIdx) continue;
                        
                        const center = vertices[centerIdx];
                        const next = vertices[nextIdx];
                        const after = vertices[afterIdx];
                        
                        // Measure how "inward" this triangle is
                        const v1 = new THREE.Vector3().subVectors(next, center);
                        const v2 = new THREE.Vector3().subVectors(after, center);
                        const cross = new THREE.Vector3().crossVectors(v1, v2);
                        inwardness += cross.dot(normal);
                    }
                    
                    if (inwardness > maxInwardness) {
                        maxInwardness = inwardness;
                        bestCenter = centerIdx;
                    }
                }
                
                // Create fan from best center vertex
                for (let i = 1; i < vertices.length - 1; i++) {
                    const nextIdx = (bestCenter + i) % vertices.length;
                    const afterIdx = (bestCenter + i + 1) % vertices.length;
                    
                    if (nextIdx !== bestCenter && afterIdx !== bestCenter) {
                        this._addTrianglePatch([vertices[bestCenter], vertices[nextIdx], vertices[afterIdx]], normal, patchName);
                        triangleCount++;
                    }
                }
                break;
            }
        }

        // Add the final triangle
        if (vertices.length === 3) {
            this._addTrianglePatch(vertices, normal, patchName);
            triangleCount++;
        }

        if (this.debug) {
            console.log(`Generated ${triangleCount} triangles for endcap ${patchName}`);
        }

        return triangleCount > 0;
    }

    /**
     * Check if vertex forms a convex angle
     */
    _isConvexVertex(prev, curr, next, normal) {
        const v1 = new THREE.Vector3().subVectors(prev, curr);
        const v2 = new THREE.Vector3().subVectors(next, curr);
        const cross = new THREE.Vector3().crossVectors(v1, v2);
        
        // Check if angle is convex relative to the surface normal
        return cross.dot(normal) > 0;
    }



    /**
     * Check if point is inside triangle
     */
    _isPointInTriangle(point, a, b, c) {
        const v0 = new THREE.Vector3().subVectors(c, a);
        const v1 = new THREE.Vector3().subVectors(b, a);
        const v2 = new THREE.Vector3().subVectors(point, a);

        const dot00 = v0.dot(v0);
        const dot01 = v0.dot(v1);
        const dot02 = v0.dot(v2);
        const dot11 = v1.dot(v1);
        const dot12 = v1.dot(v2);

        const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
        const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
        const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

        return (u >= 0) && (v >= 0) && (u + v <= 1);
    }

    /**
     * Clean up mesh after patching
     */
    _cleanupAfterPatching() {
        try {
            // Weld vertices to remove duplicates
            const tolerance = Math.max(1e-10, this.eps);
            if (this._weldVerticesByEpsilon) {
                this._weldVerticesByEpsilon(tolerance);
            }
            
            // Fix triangle windings
            if (this.fixTriangleWindingsByAdjacency) {
                this.fixTriangleWindingsByAdjacency();
            }

            // Validate manifold properties after patching
            if (this.debug) {
                const isManifold = this._validateManifoldProperties();
                console.log(`Manifold validation after patching: ${isManifold ? 'PASSED' : 'FAILED'}`);
            }
        } catch (error) {
            if (this.debug) {
                console.warn('Cleanup after patching failed:', error.message);
            }
        }
    }

    /**
     * Validate that mesh has proper manifold properties
     * @returns {boolean} True if mesh is manifold
     */
    _validateManifoldProperties() {
        try {
            const vp = this._vertProperties;
            const tv = this._triVerts;
            if (!tv || tv.length < 3 || !vp || vp.length < 9) {
                return true; // Empty mesh is technically manifold
            }

            const triCount = Math.floor(tv.length / 3);
            const edgeCount = new Map();
            let nonManifoldEdges = 0;

            // Count edge usage - in a manifold mesh, each edge should be used by exactly 2 triangles
            for (let t = 0; t < triCount; t++) {
                const i0 = tv[t * 3 + 0];
                const i1 = tv[t * 3 + 1];
                const i2 = tv[t * 3 + 2];

                const edges = [[i0, i1], [i1, i2], [i2, i0]];
                for (const [a, b] of edges) {
                    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
                    edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
                }
            }

            // Check for non-manifold edges
            let boundaryEdges = 0;
            let overusedEdges = 0;

            for (const [key, count] of edgeCount) {
                if (count === 1) {
                    boundaryEdges++;
                } else if (count > 2) {
                    overusedEdges++;
                    nonManifoldEdges++;
                }
            }

            if (this.debug && (boundaryEdges > 0 || overusedEdges > 0)) {
                console.log(`Manifold analysis: ${boundaryEdges} boundary edges, ${overusedEdges} overused edges`);
            }

            // Mesh is manifold if it has no overused edges
            // (boundary edges are OK - they represent holes that should be patched)
            return overusedEdges === 0;

        } catch (error) {
            if (this.debug) {
                console.warn('Manifold validation failed:', error.message);
            }
            return false;
        }
    }

    // DISABLED - These manifold methods are causing issues
    /*
    _detectManifoldBoundaries() {
        const vp = this._vertProperties;
        const tv = this._triVerts;
        const triCount = (tv.length / 3) | 0;

        if (triCount === 0 || !vp || vp.length < 9) return [];

        // Build comprehensive edge analysis
        const edgeToTriangles = new Map(); // edge -> [triangle_indices]
        const edgeToVertices = new Map();  // edge -> [vertex_a, vertex_b]
        const triangleNormals = new Array(triCount);

        const getEdgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;

        // Collect edge information and compute triangle normals
        for (let t = 0; t < triCount; t++) {
            const i0 = tv[t * 3 + 0];
            const i1 = tv[t * 3 + 1];
            const i2 = tv[t * 3 + 2];

            // Compute triangle normal for orientation consistency
            const v0 = new THREE.Vector3(vp[i0 * 3], vp[i0 * 3 + 1], vp[i0 * 3 + 2]);
            const v1 = new THREE.Vector3(vp[i1 * 3], vp[i1 * 3 + 1], vp[i1 * 3 + 2]);
            const v2 = new THREE.Vector3(vp[i2 * 3], vp[i2 * 3 + 1], vp[i2 * 3 + 2]);
            
            const edge1 = new THREE.Vector3().subVectors(v1, v0);
            const edge2 = new THREE.Vector3().subVectors(v2, v0);
            const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
            triangleNormals[t] = normal;

            // Process each edge of the triangle
            const edges = [[i0, i1], [i1, i2], [i2, i0]];
            for (const [a, b] of edges) {
                const key = getEdgeKey(a, b);
                
                if (!edgeToTriangles.has(key)) {
                    edgeToTriangles.set(key, []);
                    edgeToVertices.set(key, [a, b]);
                }
                edgeToTriangles.get(key).push(t);
            }
        }

        // Find true boundary edges (exactly 1 triangle) and validate orientation
        const boundaryEdges = new Map(); // edge_key -> {vertices, triangle_index, oriented_edge}
        
        for (const [edgeKey, triangles] of edgeToTriangles.entries()) {
            if (triangles.length === 1) {
                const [a, b] = edgeToVertices.get(edgeKey);
                const triangleIndex = triangles[0];
                
                // Find the oriented edge in the triangle (important for normal consistency)
                const t = triangleIndex;
                const i0 = tv[t * 3 + 0], i1 = tv[t * 3 + 1], i2 = tv[t * 3 + 2];
                
                let orientedEdge;
                if ((i0 === a && i1 === b) || (i0 === b && i1 === a)) orientedEdge = [i0, i1];
                else if ((i1 === a && i2 === b) || (i1 === b && i2 === a)) orientedEdge = [i1, i2];
                else if ((i2 === a && i0 === b) || (i2 === b && i0 === a)) orientedEdge = [i2, i0];
                
                if (orientedEdge) {
                    boundaryEdges.set(edgeKey, {
                        vertices: [a, b],
                        orientedEdge,
                        triangleIndex,
                        normal: triangleNormals[triangleIndex]
                    });
                }
            }
        }

        if (boundaryEdges.size === 0) return [];

        // Build proper boundary loops with consistent orientation
        return this._traceBoundaryLoopsManifold(boundaryEdges, vp);
    }

    /**
     * More robust manifold checking that considers edge count and orientation.
     * 
     * @returns {boolean} True if mesh is robustly manifold
     */
    _isRobustlyManifold() {
        // First check basic coherent orientation
        try {
            if (!this._isCoherentlyOrientedManifold()) return false;
        } catch {
            return false;
        }

        // Check edge manifoldness - each edge should have exactly 2 triangles
        const vp = this._vertProperties;
        const tv = this._triVerts;
        const triCount = (tv.length / 3) | 0;

        if (triCount === 0) return true; // Empty mesh is technically manifold

        const edgeCount = new Map();
        const getEdgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;

        // Count edge usage
        for (let t = 0; t < triCount; t++) {
            const i0 = tv[t * 3 + 0], i1 = tv[t * 3 + 1], i2 = tv[t * 3 + 2];

            for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]]) {
                const key = getEdgeKey(a, b);
                edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
            }
        }

        // Check that every edge has exactly 2 triangles (manifold condition)
        for (const count of edgeCount.values()) {
            if (count !== 2) return false; // Non-manifold edge found
        }

        return true;
    }

    /**
     * Trace boundary loops with manifold-aware orientation.
     * 
     * @param {Map} boundaryEdges - Map of boundary edge information
     * @param {Array} vertProperties - Vertex positions array
     * @returns {Array} Array of boundary loop objects
     */
    _traceBoundaryLoopsManifold(boundaryEdges, vertProperties) {
        const loops = [];
        const usedEdges = new Set();

        // Build adjacency for boundary vertices with orientation info
        const adjacency = new Map(); // vertex -> [{neighbor, edgeKey, normal}, ...]

        for (const [edgeKey, edgeInfo] of boundaryEdges.entries()) {
            const [a, b] = edgeInfo.vertices;
            const [oa, ob] = edgeInfo.orientedEdge;

            if (!adjacency.has(a)) adjacency.set(a, []);
            if (!adjacency.has(b)) adjacency.set(b, []);

            // Store both directions with edge key for tracking
            adjacency.get(a).push({ neighbor: b, edgeKey, normal: edgeInfo.normal, oriented: oa === a });
            adjacency.get(b).push({ neighbor: a, edgeKey, normal: edgeInfo.normal, oriented: ob === b });
        }

        // Trace each boundary loop
        for (const startVertex of adjacency.keys()) {
            if (adjacency.get(startVertex).some(edge => !usedEdges.has(edge.edgeKey))) {
                const loop = this._traceManifoldLoop(startVertex, adjacency, usedEdges, vertProperties);
                if (loop && loop.vertices.length >= 3) {
                    loops.push(loop);
                }
            }
        }

        return loops;
    }

    /**
     * Trace a single manifold boundary loop with proper orientation.
     * 
     * @param {number} startVertex - Starting vertex index
     * @param {Map} adjacency - Vertex adjacency information
     * @param {Set} usedEdges - Set of already used edge keys
     * @param {Array} vertProperties - Vertex positions
     * @returns {Object} Loop object with vertices, positions, and normal
     */
    _traceManifoldLoop(startVertex, adjacency, usedEdges, vertProperties) {
        const vertices = [startVertex];
        const positions = [];
        const normals = [];

        let current = startVertex;
        let prevEdgeKey = null;

        while (true) {
            // Add current vertex position
            positions.push(new THREE.Vector3(
                vertProperties[current * 3 + 0],
                vertProperties[current * 3 + 1],
                vertProperties[current * 3 + 2]
            ));

            // Find next unused edge from current vertex
            const currentEdges = adjacency.get(current) || [];
            let nextEdge = null;

            for (const edge of currentEdges) {
                if (edge.edgeKey === prevEdgeKey) continue; // Don't go back
                if (!usedEdges.has(edge.edgeKey)) {
                    nextEdge = edge;
                    break;
                }
            }

            if (!nextEdge) {
                // No more edges - check if we can close the loop
                if (vertices.length >= 3) {
                    // Try to find edge back to start
                    const backToStart = currentEdges.find(edge =>
                        edge.neighbor === startVertex && !usedEdges.has(edge.edgeKey));

                    if (backToStart) {
                        usedEdges.add(backToStart.edgeKey);
                        normals.push(backToStart.normal);

                        // Compute loop normal from accumulated normals
                        const avgNormal = new THREE.Vector3();
                        for (const n of normals) avgNormal.add(n);
                        avgNormal.normalize();

                        return {
                            vertices,
                            positions,
                            normal: avgNormal,
                            closed: true
                        };
                    }
                }
                break; // Open boundary or dead end
            }

            // Move to next vertex
            usedEdges.add(nextEdge.edgeKey);
            normals.push(nextEdge.normal);
            prevEdgeKey = nextEdge.edgeKey;
            current = nextEdge.neighbor;

            // Check for loop closure
            if (current === startVertex && vertices.length >= 3) {
                // Closed loop found
                const avgNormal = new THREE.Vector3();
                for (const n of normals) avgNormal.add(n);
                if (avgNormal.lengthSq() > 1e-10) avgNormal.normalize();
                else avgNormal.set(0, 0, 1); // Fallback

                return {
                    vertices,
                    positions,
                    normal: avgNormal,
                    closed: true
                };
            }

            vertices.push(current);

            // Prevent infinite loops
            if (vertices.length > 1000) {
                console.warn('Boundary loop tracing exceeded maximum length');
                break;
            }
        }

        // Return open boundary if we have enough vertices
        if (vertices.length >= 3) {
            const avgNormal = normals.length > 0
                ? normals.reduce((acc, n) => acc.add(n), new THREE.Vector3()).normalize()
                : new THREE.Vector3(0, 0, 1);

            return {
                vertices,
                positions,
                normal: avgNormal,
                closed: false
            };
        }

        return null;
    }

    /**
     * Generate a manifold-guaranteed endcap for a boundary loop.
     * Uses robust triangulation with proper orientation and edge matching.
     * 
     * @param {Object} loop - Boundary loop with vertices, positions, normal
     * @param {string} capName - Name for the endcap face
     * @param {number} minArea - Minimum triangle area threshold
     * @param {number} radius - Reference radius for tolerances
     * @returns {number} Number of triangles generated
     */
    _generateManifoldEndcap(loop, capName, minArea, radius) {
        if (!loop?.positions || loop.positions.length < 3) return 0;

        const positions = loop.positions.slice(); // Copy to avoid modifying original
        const normal = loop.normal || new THREE.Vector3(0, 0, 1);

        // Ensure loop is properly oriented for outward normal
        if (!loop.closed && positions.length > 0) {
            // For open boundaries, close the loop by duplicating the first vertex
            positions.push(positions[0].clone());
        }

        // Remove consecutive duplicates that can cause degenerate triangles
        const cleanPositions = this._cleanBoundaryPositions(positions, radius * 1e-6);
        if (cleanPositions.length < 3) return 0;

        // Determine winding order based on adjacent triangle normals
        const shouldReverse = this._shouldReverseWindingForManifold(cleanPositions, normal);
        if (shouldReverse) {
            cleanPositions.reverse();
        }

        let triangleCount = 0;

        // Use different strategies based on vertex count
        if (cleanPositions.length === 3) {
            // Single triangle - direct addition
            triangleCount = this._addManifoldTriangle(capName, cleanPositions, minArea);
        } else if (cleanPositions.length === 4) {
            // Quad - use optimal diagonal split
            triangleCount = this._triangulateQuadManifold(capName, cleanPositions, minArea);
        } else if (this._isConvexLoop(cleanPositions, normal)) {
            // Convex polygon - use fan triangulation from centroid for better quality
            triangleCount = this._triangulateFanFromCentroid(capName, cleanPositions, minArea);
        } else {
            // Complex/concave polygon - use robust ear clipping
            triangleCount = this._triangulateEarClippingRobust(capName, cleanPositions, normal, minArea);
        }

        return triangleCount;
    }

    /**
     * Clean boundary positions by removing near-duplicate consecutive vertices.
     * 
     * @param {Array<THREE.Vector3>} positions - Input positions
     * @param {number} tolerance - Distance tolerance for duplicates
     * @returns {Array<THREE.Vector3>} Cleaned positions
     */
    _cleanBoundaryPositions(positions, tolerance) {
        if (positions.length <= 1) return positions.slice();

        const cleaned = [positions[0]];
        const tol2 = tolerance * tolerance;

        for (let i = 1; i < positions.length; i++) {
            const curr = positions[i];
            const prev = cleaned[cleaned.length - 1];

            if (curr.distanceToSquared(prev) > tol2) {
                cleaned.push(curr);
            }
        }

        // Check if first and last are too close (for closed loops)
        if (cleaned.length > 2) {
            const first = cleaned[0];
            const last = cleaned[cleaned.length - 1];
            if (first.distanceToSquared(last) <= tol2) {
                cleaned.pop(); // Remove duplicate closing vertex
            }
        }

        return cleaned;
    }

    /**
     * Determine if winding order should be reversed for manifold consistency.
     * 
     * @param {Array<THREE.Vector3>} positions - Loop positions
     * @param {THREE.Vector3} expectedNormal - Expected outward normal
     * @returns {boolean} True if winding should be reversed
     */
    _shouldReverseWindingForManifold(positions, expectedNormal) {
        if (positions.length < 3) return false;

        // Compute actual normal from first three non-collinear vertices
        let actualNormal = null;

        for (let i = 0; i < positions.length - 2; i++) {
            const v0 = positions[i];
            const v1 = positions[i + 1];
            const v2 = positions[i + 2];

            const edge1 = new THREE.Vector3().subVectors(v1, v0);
            const edge2 = new THREE.Vector3().subVectors(v2, v0);
            const cross = new THREE.Vector3().crossVectors(edge1, edge2);

            if (cross.lengthSq() > 1e-12) {
                actualNormal = cross.normalize();
                break;
            }
        }

        if (!actualNormal) return false; // Degenerate loop

        // Reverse if normals point in opposite directions
        return actualNormal.dot(expectedNormal) < 0;
    }

    /**
     * Add a single manifold triangle with area validation.
     * 
     * @param {string} faceName - Face name
     * @param {Array<THREE.Vector3>} positions - Triangle vertices (must be 3)
     * @param {number} minArea - Minimum area threshold
     * @returns {number} Number of triangles added (0 or 1)
     */
    _addManifoldTriangle(faceName, positions, minArea) {
        if (positions.length !== 3) return 0;

        const [p0, p1, p2] = positions;

        // Compute triangle area
        const edge1 = new THREE.Vector3().subVectors(p1, p0);
        const edge2 = new THREE.Vector3().subVectors(p2, p0);
        const area = edge1.cross(edge2).length() * 0.5;

        if (area < minArea) return 0; // Skip degenerate triangle

        this.addTriangle(faceName, vToArr(p0), vToArr(p1), vToArr(p2));
        return 1;
    }

    /**
     * Triangulate a quad using optimal diagonal to avoid degenerate triangles.
     * 
     * @param {string} faceName - Face name
     * @param {Array<THREE.Vector3>} positions - Quad vertices (must be 4)
     * @param {number} minArea - Minimum area threshold
     * @returns {number} Number of triangles added
     */
    _triangulateQuadManifold(faceName, positions, minArea) {
        if (positions.length !== 4) return 0;

        const [p0, p1, p2, p3] = positions;

        // Test both diagonal splits and choose the one with better triangle quality
        const area1a = this._computeTriangleArea(p0, p1, p2);
        const area1b = this._computeTriangleArea(p0, p2, p3);
        const area2a = this._computeTriangleArea(p0, p1, p3);
        const area2b = this._computeTriangleArea(p1, p2, p3);

        const minAreaSplit1 = Math.min(area1a, area1b);
        const minAreaSplit2 = Math.min(area2a, area2b);

        let count = 0;

        if (minAreaSplit1 >= minAreaSplit2 && minAreaSplit1 >= minArea) {
            // Use diagonal 0-2
            if (area1a >= minArea) {
                this.addTriangle(faceName, vToArr(p0), vToArr(p1), vToArr(p2));
                count++;
            }
            if (area1b >= minArea) {
                this.addTriangle(faceName, vToArr(p0), vToArr(p2), vToArr(p3));
                count++;
            }
        } else if (minAreaSplit2 >= minArea) {
            // Use diagonal 1-3
            if (area2a >= minArea) {
                this.addTriangle(faceName, vToArr(p0), vToArr(p1), vToArr(p3));
                count++;
            }
            if (area2b >= minArea) {
                this.addTriangle(faceName, vToArr(p1), vToArr(p2), vToArr(p3));
                count++;
            }
        }

        return count;
    }

    /**
     * Check if a loop is convex for optimal triangulation strategy.
     * 
     * @param {Array<THREE.Vector3>} positions - Loop positions
     * @param {THREE.Vector3} normal - Loop normal
     * @returns {boolean} True if loop is convex
     */
    _isConvexLoop(positions, normal) {
        if (positions.length < 3) return true;

        for (let i = 0; i < positions.length; i++) {
            const p0 = positions[i];
            const p1 = positions[(i + 1) % positions.length];
            const p2 = positions[(i + 2) % positions.length];

            const edge1 = new THREE.Vector3().subVectors(p1, p0);
            const edge2 = new THREE.Vector3().subVectors(p2, p1);
            const cross = new THREE.Vector3().crossVectors(edge1, edge2);

            // Check if turn direction is consistent with normal
            if (cross.dot(normal) < -1e-10) {
                return false; // Concave angle found
            }
        }

        return true;
    }

    /**
     * Triangulate using fan from centroid for better triangle quality.
     * 
     * @param {string} faceName - Face name
     * @param {Array<THREE.Vector3>} positions - Loop positions
     * @param {number} minArea - Minimum area threshold
     * @returns {number} Number of triangles added
     */
    _triangulateFanFromCentroid(faceName, positions, minArea) {
        if (positions.length < 3) return 0;

        // Compute centroid
        const centroid = new THREE.Vector3();
        for (const pos of positions) {
            centroid.add(pos);
        }
        centroid.multiplyScalar(1 / positions.length);

        let count = 0;
        for (let i = 0; i < positions.length; i++) {
            const p0 = positions[i];
            const p1 = positions[(i + 1) % positions.length];

            const area = this._computeTriangleArea(centroid, p0, p1);
            if (area >= minArea) {
                this.addTriangle(faceName, vToArr(centroid), vToArr(p0), vToArr(p1));
                count++;
            }
        }

        return count;
    }

    /**
     * Robust ear clipping for complex polygons.
     * 
     * @param {string} faceName - Face name
     * @param {Array<THREE.Vector3>} positions - Loop positions
     * @param {THREE.Vector3} normal - Loop normal
     * @param {number} minArea - Minimum area threshold
     * @returns {number} Number of triangles added
     */
    _triangulateEarClippingRobust(faceName, positions, normal, minArea) {
        if (positions.length < 3) return 0;
        if (positions.length === 3) {
            return this._addManifoldTriangle(faceName, positions, minArea);
        }

        const vertices = positions.slice(); // Work with copy
        let count = 0;
        let attempts = 0;
        const maxAttempts = vertices.length * 2; // Prevent infinite loops

        while (vertices.length > 3 && attempts < maxAttempts) {
            let earFound = false;
            attempts++;

            for (let i = 0; i < vertices.length; i++) {
                const p0 = vertices[(i - 1 + vertices.length) % vertices.length];
                const p1 = vertices[i];
                const p2 = vertices[(i + 1) % vertices.length];

                if (this._isEarRobust(vertices, i, normal) &&
                    this._computeTriangleArea(p0, p1, p2) >= minArea) {

                    // Add triangle
                    this.addTriangle(faceName, vToArr(p0), vToArr(p1), vToArr(p2));
                    count++;

                    // Remove the ear vertex
                    vertices.splice(i, 1);
                    earFound = true;
                    break;
                }
            }

            if (!earFound) {
                // Fallback: force triangulation with remaining vertices
                break;
            }
        }

        // Add final triangle if we have exactly 3 vertices left
        if (vertices.length === 3) {
            const area = this._computeTriangleArea(vertices[0], vertices[1], vertices[2]);
            if (area >= minArea) {
                this.addTriangle(faceName, vToArr(vertices[0]), vToArr(vertices[1]), vToArr(vertices[2]));
                count++;
            }
        }

        return count;
    }

    /**
     * Robust ear test with better numerical stability.
     * 
     * @param {Array<THREE.Vector3>} vertices - Current vertex list
     * @param {number} i - Index to test for ear
     * @param {THREE.Vector3} normal - Loop normal
     * @returns {boolean} True if vertex i is an ear
     */
    _isEarRobust(vertices, i, normal) {
        const n = vertices.length;
        const p0 = vertices[(i - 1 + n) % n];
        const p1 = vertices[i];
        const p2 = vertices[(i + 1) % n];

        // Check if angle is convex with tolerance
        const v1 = new THREE.Vector3().subVectors(p0, p1);
        const v2 = new THREE.Vector3().subVectors(p2, p1);
        const cross = new THREE.Vector3().crossVectors(v1, v2);

        if (cross.dot(normal) <= 1e-10) return false; // Not sufficiently convex

        // Check if any other vertex is inside the triangle (with tolerance)
        const eps = 1e-10;
        for (let j = 0; j < n; j++) {
            if (j === (i - 1 + n) % n || j === i || j === (i + 1) % n) continue;

            if (this._isPointInTriangleTolerant(vertices[j], p0, p1, p2, eps)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Point-in-triangle test with numerical tolerance.
     * 
     * @param {THREE.Vector3} point - Point to test
     * @param {THREE.Vector3} a - Triangle vertex A
     * @param {THREE.Vector3} b - Triangle vertex B  
     * @param {THREE.Vector3} c - Triangle vertex C
     * @param {number} tolerance - Numerical tolerance
     * @returns {boolean} True if point is inside triangle
     */
    _isPointInTriangleTolerant(point, a, b, c, tolerance = 1e-10) {
        const v0 = new THREE.Vector3().subVectors(c, a);
        const v1 = new THREE.Vector3().subVectors(b, a);
        const v2 = new THREE.Vector3().subVectors(point, a);

        const dot00 = v0.dot(v0);
        const dot01 = v0.dot(v1);
        const dot02 = v0.dot(v2);
        const dot11 = v1.dot(v1);
        const dot12 = v1.dot(v2);

        const denom = dot00 * dot11 - dot01 * dot01;
        if (Math.abs(denom) < tolerance) return false; // Degenerate triangle

        const invDenom = 1 / denom;
        const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
        const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

        // Check if point is inside with tolerance
        return (u >= -tolerance) && (v >= -tolerance) && (u + v <= 1 + tolerance);
    }

    /**
     * Compute triangle area helper.
     * 
     * @param {THREE.Vector3} p0 - First vertex
     * @param {THREE.Vector3} p1 - Second vertex
     * @param {THREE.Vector3} p2 - Third vertex
     * @returns {number} Triangle area
     */
    _computeTriangleArea(p0, p1, p2) {
        const v1 = new THREE.Vector3().subVectors(p1, p0);
        const v2 = new THREE.Vector3().subVectors(p2, p0);
        return v1.cross(v2).length() * 0.5;
    }
}
