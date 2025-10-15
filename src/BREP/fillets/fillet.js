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

        // Heuristic: decide union vs subtract based on bisector direction vs outward normals
        this.filletType = classifyFilletBoolean(nAavg, nBavg, polyLocal);

        // Debug: validate cap/strip seams to detect any T-junctions early.
        if (this.debug && !isClosed) {
            try {
                const missA0 = validateCapStripSeam(this, `${baseName}_SIDE_A`, sideRowsA?.[0], `${baseName}_CAP_START`);
                const missB0 = validateCapStripSeam(this, `${baseName}_SIDE_B`, sideRowsB?.[0], `${baseName}_CAP_START`);
                const missA1 = validateCapStripSeam(this, `${baseName}_SIDE_A`, sideRowsA?.[sideRowsA.length - 1], `${baseName}_CAP_END`);
                const missB1 = validateCapStripSeam(this, `${baseName}_SIDE_B`, sideRowsB?.[sideRowsB.length - 1], `${baseName}_CAP_END`);
                const any = (missA0?.length || 0) + (missB0?.length || 0) + (missA1?.length || 0) + (missB1?.length || 0);
                if (any > 0) {
                    console.warn('[FilletSolid] seam validator: missing strip edges on cap boundary', {
                        baseName,
                        startA: missA0, startB: missB0,
                        endA: missA1, endB: missB1,
                    });
                }
            } catch (e) { try { console.warn('[FilletSolid] seam validation failed:', e?.message || e); } catch { } }
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
                    try { this.fixTriangleWindingsByAdjacency(); } catch { }
                    try { ensureOutwardOrientationAuthoring(this); } catch { }
                    // One more light weld to drop any accidental duplicates
                    try { this._weldVerticesByEpsilon(1e-9); } catch { }
                } else {
                    // Not enough unique points for a hull; keep authored data as-is
                }
            } catch (eHull) {
                try { console.warn('[FilletSolid] hull fallback failed:', eHull?.message || eHull); } catch { }
            }
        }

        // Final sanity: alert if the tool is non‑manifold. This is a UX aid only
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
}
