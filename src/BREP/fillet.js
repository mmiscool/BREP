import { Solid } from "./BetterSolid.js";
import manifold from "./setupManifold.js";
import { buildTightPointCloudWrap } from "./PointCloudWrap.js";
import * as THREE from 'three';


export class FilletSolid extends Solid {
    // Public API accepts only UI-driven parameters; all other knobs are internal.
    constructor({ edgeToFillet, radius = 1, sideMode = 'INSET', debug = false, inflate = 0 }) {
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
            const qA = projectPointOntoFaceTriangles(trisA, p);
            const qB = projectPointOntoFaceTriangles(trisB, p);
            const nA = localFaceNormalAtPoint(solid, faceA.name, qA) || nAavg;
            const nB = localFaceNormalAtPoint(solid, faceB.name, qB) || nBavg;

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
            try {
                const qA1 = projectPointOntoFaceTriangles(trisA, tA);
                const qB1 = projectPointOntoFaceTriangles(trisB, tB);
                const nA1 = localFaceNormalAtPoint(solid, faceA.name, qA1) || nAavg;
                const nB1 = localFaceNormalAtPoint(solid, faceB.name, qB1) || nBavg;
                const C_ref = solveCenterFromOffsetPlanesAnchored(p, t, nA1, qA1, sA, nB1, qB1, sB, rEff);
                if (C_ref) {
                    center = C_ref;
                    tA = center.clone().addScaledVector(nA1, -sA * rEff);
                    tB = center.clone().addScaledVector(nB1, -sB * rEff);
                }
            } catch (_) { /* ignore refine errors */ }

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
        let seamA = railA.map(p => projectPointOntoFaceTriangles(trisA, p));
        let seamB = railB.map(p => projectPointOntoFaceTriangles(trisB, p));

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

        // Build curved fillet; snap ring endpoints to seamA/seamB
        buildWedgeDirect(this, baseName,
            railPBuild, sectorDefs, rEff, radialSegments, isClosed, seamA, seamB);

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
        buildSideStripOnFace(this, `${baseName}_SIDE_A`, railPBuild, seamA, isClosed, trisA, widthSubdiv, seamInset, sideOffsetSigned, overshootLen, projectSide);
        buildSideStripOnFace(this, `${baseName}_SIDE_B`, railPBuild, seamB, isClosed, trisB, widthSubdiv, seamInset, sideOffsetSigned, overshootLen, projectSide);

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

// Approximate local face normal at a point using the nearest triangle of tris
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

// Build a side strip that lies exactly on an original face mesh by projecting
// a regular grid between railP (edge) and seam (projected tangency) onto the
// face triangles, then triangulating the grid.
// Build a side strip between the P-rail and the seam. When `project` is true,
// sample points are projected back to the source face triangles to lie exactly
// on the face; when false, the strip is built as a simple ruled surface in
// authoring space (robust for open/outset where projection may fold over).
function buildSideStripOnFace(solid, faceName, railP, seam, closeLoop, tris, widthSubdiv = 8, inset = 0, extraOffset = 0, endOvershoot = 0, project = true) {
    const n = Math.min(railP.length, seam.length);
    if (n < 2) return;
    const W = Math.max(1, widthSubdiv);

    // Precompute rows of projected points from edge -> seam
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
        const Pi = railP[i];
        const Si = seam[i];
        const row = new Array(W + 1);
        for (let k = 0; k <= W; k++) {
            const t = k / W;
            if (k === 0) {
                // Preserve exact input edge as the common seam
                row[k] = Pi.clone();
                continue;
            }
            if (k === W) {
                // Use the provided seam point exactly to match the curved surface seam
                row[k] = Si.clone();
                continue;
            }
            const v = new THREE.Vector3(
                Pi.x + (Si.x - Pi.x) * t,
                Pi.y + (Si.y - Pi.y) * t,
                Pi.z + (Si.z - Pi.z) * t,
            );
            if (project) {
                let q = projectPointOntoFaceTriangles(tris, v);
                const n = normalFromFaceTriangles(tris, q);
                // Apply signed extra offset (inflate) and a small inward bias (inset) to avoid coplanar artifacts.
                // Move = (+extraOffset) along +n (outward), and (−inset) along −n (inward).
                let move = 0;
                if (Number.isFinite(extraOffset) && extraOffset !== 0) move += extraOffset;
                if (inset > 0) move -= inset;
                if (move !== 0) q = q.addScaledVector(n, move);
                row[k] = q;
            } else {
                // Ruled surface: keep the linear interpolation without projection or normal offsets
                row[k] = v;
            }
        }
        rows[i] = row;
    }

    // Optionally prepend/append an extra row to extend beyond the selected edge ends
    if (!closeLoop && endOvershoot > 0) {
        const extendRow = (rowBase, rowNext, sign) => {
            const dir = new THREE.Vector3();
            // Estimate tangent along the rail using k=0 (edge seam) difference, fallback to average
            if (rowNext && rowBase) {
                dir.copy(rowBase[0]).sub(rowNext[0]);
            }
            if (dir.lengthSq() < 1e-20) {
                // average across width
                for (let k = 0; k <= W; k++) {
                    const a = rowBase[k], b = rowNext[k];
                    if (!a || !b) continue;
                    dir.add(new THREE.Vector3().subVectors(a, b));
                }
            }
            if (dir.lengthSq() < 1e-20) return null;
            dir.normalize().multiplyScalar(sign * endOvershoot);
            // Shift; optionally project back onto face triangles; reapply offsets
            const out = new Array(W + 1);
            for (let k = 0; k <= W; k++) {
                let p = (rowBase[k] || rowBase[0]).clone().add(dir);
                if (project) {
                    p = projectPointOntoFaceTriangles(tris, p);
                    const nrm = normalFromFaceTriangles(tris, p);
                    let move = 0; if (Number.isFinite(extraOffset) && extraOffset !== 0) move += extraOffset; if (inset > 0) move -= inset;
                    if (move !== 0 && nrm) p.addScaledVector(nrm, move);
                }
                out[k] = p;
            }
            return out;
        };
        // Prepend start extension (negative direction relative to forward growth)
        const row0 = rows[0], row1 = rows[1];
        const startExt = extendRow(row0, row1, +1);
        if (startExt) rows.unshift(startExt);
        // Append end extension (forward direction)
        const rowN1 = rows[rows.length - 1];
        const rowN2 = rows[rows.length - 2];
        const endExt = extendRow(rowN1, rowN2, +1);
        if (endExt) rows.push(endExt);
    }

    // Triangulate between consecutive rows
    const emitQuad = (iA, iB) => {
        const rowA = rows[iA];
        const rowB = rows[iB];
        for (let k = 0; k < W; k++) {
            const a0 = rowA[k];
            const a1 = rowA[k + 1];
            const b0 = rowB[k];
            const b1 = rowB[k + 1];
            // Choose diagonal that yields better shaped triangles and avoids skinny slivers
            // Skip degenerate micro-tris created by offset/projection
            const triArea2 = (p, q, r) => {
                const ux = q.x - p.x, uy = q.y - p.y, uz = q.z - p.z;
                const vx = r.x - p.x, vy = r.y - p.y, vz = r.z - p.z;
                const nx = uy * vz - uz * vy;
                const ny = uz * vx - ux * vz;
                const nz = ux * vy - uy * vx;
                return nx*nx + ny*ny + nz*nz; // squared doubled-area
            };
            const pushIfArea = (p, q, r) => {
                const a2 = triArea2(p,q,r);
                if (a2 > 1e-32) solid.addTriangle(faceName, vToArr(p), vToArr(q), vToArr(r));
            };
            // Evaluate both diagonals and pick the one with larger min area
            const A1 = triArea2(a0, b0, b1);
            const A2 = triArea2(a0, b1, a1);
            const B1 = triArea2(a0, b0, a1);
            const B2 = triArea2(a1, b0, b1);
            const minA = Math.min(A1, A2);
            const minB = Math.min(B1, B2);
            if (minA >= minB) {
                pushIfArea(a0, b0, b1);
                pushIfArea(a0, b1, a1);
            } else {
                pushIfArea(a0, b0, a1);
                pushIfArea(a1, b0, b1);
            }
        }
    };

    for (let i = 0; i < rows.length - 1; i++) emitQuad(i, i + 1);
    if (closeLoop && n > 2) emitQuad(rows.length - 1, 0);
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

function localFaceNormalAtPoint(solid, faceName, p) {
    const tris = solid.getFace(faceName);
    if (!tris || !tris.length) return null;
    let best = null;
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
    const n = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    for (const t of tris) {
        pa.set(t.p1[0], t.p1[1], t.p1[2]);
        pb.set(t.p2[0], t.p2[1], t.p2[2]);
        pc.set(t.p3[0], t.p3[1], t.p3[2]);
        // Triangle normal (area-weighted by magnitude implicitly via distance test)
        const ab = new THREE.Vector3().subVectors(pb, pa);
        const ac = new THREE.Vector3().subVectors(pc, pa);
        n.copy(ab).cross(ac); // right-handed orientation
        if (n.lengthSq() < 1e-14) continue;
        n.normalize();
        centroid.copy(pa).add(pb).add(pc).multiplyScalar(1/3);
        const d = Math.abs(n.dot(new THREE.Vector3().subVectors(p, centroid)));
        if (!best || d < best.d) best = { d, n: n.clone() };
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
function buildWedgeDirect(solid, faceName, railP, sectorDefs, radius, arcSegments, closeLoop, seamA = null, seamB = null) {
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

    // End caps for open edges: fan from P to arc ring
    if (!closeLoop) {
        const Pstart = railP[0];
        const Astart = arcRings[0];
        for (let j = 0; j < arcSegments; j++) {
            const a0 = Astart[j], a1 = Astart[j + 1];
            if (triArea2(Pstart, a0, a1) > 1e-32) solid.addTriangle(faceCapStart, vToArr(Pstart), vToArr(a0), vToArr(a1));
        }
        const Pend = railP[n - 1];
        const Aend = arcRings[n - 1];
        for (let j = 0; j < arcSegments; j++) {
            const a0 = Aend[j], a1 = Aend[j + 1];
            if (triArea2(Pend, a1, a0) > 1e-32) solid.addTriangle(faceCapEnd, vToArr(Pend), vToArr(a1), vToArr(a0));
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
    const A = [
        [nA.x, nA.y, nA.z],
        [nB.x, nB.y, nB.z],
        [t.x,  t.y,  t.z ],
    ];
    const b = [dA, dB, dT];
    const x = solve3(A, b);
    if (!x) return null;
    return new THREE.Vector3(x[0], x[1], x[2]);
}

// Solve 3x3 linear system A x = b using Cramer's rule
function solve3(A, b) {
    const detA = det3(A);
    if (Math.abs(detA) < 1e-10) return null;
    const Ax = [ [b[0], A[0][1], A[0][2]], [b[1], A[1][1], A[1][2]], [b[2], A[2][1], A[2][2]] ];
    const Ay = [ [A[0][0], b[0], A[0][2]], [A[1][0], b[1], A[1][2]], [A[2][0], b[2], A[2][2]] ];
    const Az = [ [A[0][0], A[0][1], b[0]], [A[1][0], A[1][1], b[1]], [A[2][0], A[2][1], b[2]] ];
    const x = det3(Ax) / detA;
    const y = det3(Ay) / detA;
    const z = det3(Az) / detA;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return [x, y, z];
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
    const out = new Array(railP.length);
    // For INSET (subtract), move the P-rail outward; for OUTSET (union), move inward.
    const sign = (String(sideMode).toUpperCase() === 'INSET') ? +1 : -1;
    const d = Math.abs(Number(distance) || 0) * sign;
    for (let i = 0; i < railP.length; i++) {
        const p = railP[i];
        // Sample normals from both faces near p
        const qA = projectPointOntoFaceTriangles(trisA, p);
        const qB = projectPointOntoFaceTriangles(trisB, p);
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
