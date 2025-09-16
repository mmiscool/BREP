import { Solid } from "./BetterSolid.js";
import * as THREE from 'three';


export class FilletSolid extends Solid {
    constructor({ edgeToFillet, radius = 1, arcSegments = 16, sampleCount = 50, invert2D = true, reverseTangent = false, swapFaces = false, sideMode = 'INSET', debug = false, debugStride = 12, inflate = 0, snapSeamToEdge = true, sideStripSubdiv = 8, seamInsetScale = 1e-3, projectStripsOpenEdges = false, forceSeamInset = false }) {
        super();
        this.edgeToFillet = edgeToFillet;
        this.radius = radius;
        // Grow/shrink the fillet tool solid by this absolute amount (units of model space).
        // Positive inflates the solid slightly (useful to avoid thin remainders after CSG).
        this.inflate = Number.isFinite(inflate) ? inflate : 0;
        this.arcSegments = Math.max(3, (arcSegments | 0));
        this.sampleCount = Math.max(8, (sampleCount | 0));
        // Controls which side of the cross-section the fillet falls on.
        // When true, multiplies 2D (x,y) by -1 during mapping back to 3D.
        this.invert2D = !!invert2D;
        // Reverse the edge tangent used for section frame (t -> -t)
        this.reverseTangent = !!reverseTangent;
        // Swap which face defines the section's +u axis (vA3 vs vB3)
        this.swapFaces = !!swapFaces;
        // sideMode: 'AUTO' | 'INSET' | 'OUTSET' (relative to outward average normal)
        this.sideMode = (sideMode).toUpperCase();
        // Debug helpers
        this.debug = !!debug;
        this.debugStride = Math.max(1, (debugStride | 0));
        this._debugObjects = [];
        this.operationTargetSolid = null;
        this.filletType = null; // will be set to either "UNION" or "SUBTRACT" 
        // If true, use the original input edge vertices for the seam (P-rail)
        // so the side-strip shared edge coincides exactly with the input edge.
        this.snapSeamToEdge = !!snapSeamToEdge;
        this.sideStripSubdiv = Math.max(1, (sideStripSubdiv | 0));
        // Scale used to bias seams/side strips just inside the source faces
        // to avoid CSG residue from coincident geometry; applied as
        //   inset = max(1e-9, seamInsetScale * radius)
        this.seamInsetScale = Number.isFinite(seamInsetScale) ? seamInsetScale : 1e-3;
        // Prefer projecting side strips onto the source faces for closed loops,
        // and optionally also for open edges when enabled.
        this.projectStripsOpenEdges = !!projectStripsOpenEdges;
        // When true, apply seam inset even for open edges; default false to
        // preserve previous behavior that worked better for INSET fillets.
        this.forceSeamInset = !!forceSeamInset;
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

        // Build the section samples along the edge.
        // When snapSeamToEdge is true, use the original edge vertices so
        // the P‑rail used by side strips matches the input edge exactly.
        // For closed loops, drop a duplicated terminal vertex if present.
        const isClosed = !!(this.edgeToFillet.closedLoop || this.edgeToFillet.userData?.closedLoop);
        let samples;
        if (this.snapSeamToEdge) {
            const src = polyLocal.slice();
            if (isClosed && src.length > 2) {
                const a = src[0], b = src[src.length - 1];
                if (a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) src.pop();
            }
            samples = src;
        } else {
            // Uniform resampling for smoother frames
            samples = resamplePolyline3(polyLocal, this.sampleCount, isClosed);
        }
        const rings = [];

        // Compute per-sample centerline by intersecting the two offset planes
        // (nA·C = nA·p - r, nB·C = nB·p - r) with the cross-section plane (t·C = t·p)
        const centers = [];
        const radialHints = []; // vector from center toward edge (for ring orientation)
        const signedAngles = [];
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
            const t = new THREE.Vector3().subVectors(pNext, pPrev);
            if (t.lengthSq() < 1e-14) continue;
            t.normalize();
            if (this.reverseTangent) t.multiplyScalar(-1);

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
            if (this.swapFaces) {
                const tmp = vA3; vA3 = vB3; vB3 = tmp;
            }

            // Orthonormal basis (u,v) with u aligned to vA3 for stable 2D mapping
            let u = vA3.clone();
            const v = new THREE.Vector3().crossVectors(t, u).normalize();

            // 2D unit directions of face traces in the section
            const d0_2 = new THREE.Vector2(1, 0); // vA3 == +u
            const d1_2 = new THREE.Vector2(vB3.dot(u), vB3.dot(v));
            d1_2.normalize();
            const dot2 = clamp(d0_2.x * d1_2.x + d0_2.y * d1_2.y, -1, 1);
            const angAbs = Math.acos(dot2);
            signedAngles.push(angAbs);

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
            const outwardAvg = nA.clone().add(nB);
            if (outwardAvg.lengthSq() > 0) outwardAvg.normalize();

            // Solve with offset planes anchored to the face triangles (n·x = n·q ± r)
            const C_in  = solveCenterFromOffsetPlanesAnchored(p, t, nA, qA, -1, nB, qB, -1, rEff); // inside
            const C_out = solveCenterFromOffsetPlanesAnchored(p, t, nA, qA, +1, nB, qB, +1, rEff); // outside

            // Determine preferred side
            let pick = 'in'; // default to inset
            if (this.sideMode === 'OUTSET') pick = 'out';
            // UI flip toggle
            if (this.invert2D) pick = (pick === 'in') ? 'out' : 'in';

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

            // Closed-loop robustness: if p→center distance is unreasonably large,
            // use a 2D bisector construction in the section plane.
            if (isClosed) {
                const pToC = center.distanceTo(p);
                const hardCap = 4 * rEff; // absolute cap
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

            centers.push(center.clone());
            radialHints.push(new THREE.Vector3().subVectors(p, center).normalize());
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
        // surfaces from leaving sliver shards after subtraction. For open
        // (non-closed) edges, keep inset = 0 unless forceSeamInset is true
        // to avoid creating gaps that can lead to a non-manifold tool.
        let seamInset = ((isClosed || this.forceSeamInset) ? Math.max(1e-9, this.seamInsetScale * rEff) : 0);
        // Clamp inset on closed loops to avoid foldovers on slanted faces
        if (isClosed) seamInset = Math.min(seamInset, 0.02 * rEff);
        if (seamInset > 0) {
            seamA = insetPolylineAlongFaceNormals(trisA, seamA, +seamInset); // into face A
            seamB = insetPolylineAlongFaceNormals(trisB, seamB, +seamInset); // into face B
        }

        const baseName = `FILLET_${faceA.name}|${faceB.name}`;
        // Use face‑projected side strips for closed loops by default; allow
        // enabling them for open edges via option.
        const useFaceProjectedStrips = (isClosed || this.projectStripsOpenEdges);

        // Build curved fillet; snap ring endpoints to seamA/seamB
        buildWedgeDirect(this, baseName,
            railP, sectorDefs, rEff, radialSegments, isClosed, seamA, seamB, /*skipSideStrips*/ useFaceProjectedStrips);

        if (useFaceProjectedStrips) {
            // Rebuild the two side strips directly on original faces using projected grids
            buildSideStripOnFace(this, `${baseName}_SIDE_A`, railP, seamA, isClosed, trisA, this.sideStripSubdiv, seamInset);
            buildSideStripOnFace(this, `${baseName}_SIDE_B`, railP, seamB, isClosed, trisB, this.sideStripSubdiv, seamInset);
        }

        // Heuristic: decide union vs subtract based on bisector direction vs outward normals
        this.filletType = classifyFilletBoolean(nAavg, nBavg, polyLocal);

        // Before inflating, ensure triangles are coherently oriented and pre-clean
        // in authoring space to avoid requiring a Manifold build too early.
        try {
            this.fixTriangleWindingsByAdjacency();
            const q = Math.max(1e-9, 1e-5 * rEff);
            quantizeVerticesAuthoring(this, q);
            removeDegenerateTrianglesAuthoring(this, Math.max(1e-12, 1e-8 * rEff * rEff));
            // Ensure global outward orientation so positive inflation expands the tool
            ensureOutwardOrientationAuthoring(this);
            this.fixTriangleWindingsByAdjacency();
            // Light weld to collapse near-coincident verts created by projections
            // and snapping. This reduces the chance of 3+ faces sharing a nearly
            // duplicated edge which Manifold treats as non-manifold.
            this._weldVerticesByEpsilon(Math.max(1e-9, 5e-6 * rEff));
        } catch {}

        // Inflate only the side-strip faces for all modes (OUTSET/INSET).
        // The curved fillet face remains at the exact geometric radius.
        if (Math.abs(this.inflate) > 0) {
            inflateSideFacesInPlace(this, this.inflate);
            try { this.fixTriangleWindingsByAdjacency(); } catch {}
        }

        // Final clean: weld and drop any tiny degenerates created during inflation
        try {
            this._weldVerticesByEpsilon(Math.max(1e-9, 5e-6 * rEff));
            removeDegenerateTrianglesAuthoring(this, Math.max(1e-12, 1e-8 * rEff * rEff));
            this.fixTriangleWindingsByAdjacency();
        } catch {}




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
        }

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

function chooseInteriorDirections(nAraw, nBraw, t) {
    // Try flips on both normals; pick the pair whose bisector points opposite average outward
    const outAvg = nAraw.clone().add(nBraw);
    if (outAvg.lengthSq() > 0) outAvg.normalize();
    let best = null;
    const signs = [+1, -1];
    for (const sA of signs) {
        for (const sB of signs) {
            const d0 = projectPerp(nAraw.clone().multiplyScalar(sA), t).normalize();
            const d1 = projectPerp(nBraw.clone().multiplyScalar(sB), t).normalize();
            const bis = d0.clone().add(d1);
            if (bis.lengthSq() === 0) continue;
            bis.normalize();
            const score = outAvg.lengthSq() ? bis.dot(outAvg) : 0;
            // Prefer most negative score (pointing inwards relative to outward average)
            if (!best || score < best.score) {
                best = { d0, d1, sA, sB, score };
            }
        }
    }
    if (!best) {
        // Fallback to previous behavior
        return { d0: projectPerp(nAraw.clone().negate(), t).normalize(), d1: projectPerp(nBraw.clone(), t).normalize(), sA: -1, sB: +1 };
    }
    return { d0: best.d0, d1: best.d1, sA: best.sA, sB: best.sB };
}

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

function resamplePolyline3(pts, count, closed) {
    const V = pts.map(arrToV);
    const list = V.slice();
    if (closed && V.length > 2) list.push(V[0].clone()); // include wrap segment
    const totalLen = polylineLength(list);
    if (totalLen <= 0 || count <= 2) return pts;
    const out = [];
    if (closed) {
        for (let s = 0; s < count; s++) {
            const t = s / count; // avoid duplicate at end
            const d = t * totalLen;
            const p = pointAtArcLength(list, d);
            out.push([p.x, p.y, p.z]);
        }
    } else {
        for (let s = 0; s < count; s++) {
            const t = s / (count - 1);
            const d = t * totalLen;
            const p = pointAtArcLength(list, d);
            out.push([p.x, p.y, p.z]);
        }
    }
    return out;
}

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
function buildSideStripOnFace(solid, faceName, railP, seam, closeLoop, tris, widthSubdiv = 8, inset = 0) {
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
            let q = projectPointOntoFaceTriangles(tris, v);
            if (inset > 0) {
                const n = normalFromFaceTriangles(tris, q);
                q = q.addScaledVector(n, -inset);
            }
            row[k] = q;
        }
        rows[i] = row;
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
            // Checkerboard to avoid long strips
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

function triangulateCapFan(solid, faceName, ring, flip = false) {
    const c = new THREE.Vector3();
    for (const p of ring) c.add(p);
    c.multiplyScalar(1 / ring.length);
    for (let j = 0; j < ring.length - 1; j++) {
        const a = ring[j], b = ring[j + 1];
        if (!flip) solid.addTriangle(faceName, vToArr(c), vToArr(a), vToArr(b));
        else       solid.addTriangle(faceName, vToArr(c), vToArr(b), vToArr(a));
    }
}

function triangulateCapToPoint(solid, faceName, ring, apex, flip = false) {
    for (let j = 0; j < ring.length - 1; j++) {
        const a = ring[j], b = ring[j + 1];
        if (!flip) solid.addTriangle(faceName, vToArr(apex), vToArr(a), vToArr(b));
        else       solid.addTriangle(faceName, vToArr(apex), vToArr(b), vToArr(a));
    }
}

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

function buildTubeFromCenterline(solid, faceName, centers, radialHints, radius, radialSegments, closeLoop, apex0 = null, apex1 = null) {
    if (!centers || centers.length < 2) return;
    const rings = [];
    let uPrev = null;
    for (let i = 0; i < centers.length; i++) {
        const c = centers[i];
        const cPrev = centers[Math.max(0, i - 1)];
        const cNext = centers[Math.min(centers.length - 1, i + 1)];
        const Ti = new THREE.Vector3().subVectors(cNext, cPrev);
        if (Ti.lengthSq() < 1e-14) continue;
        Ti.normalize();

        let u = null;
        const hint = radialHints[i] ? radialHints[i].clone() : null;
        if (uPrev) {
            // Parallel transport: project previous u onto plane perp to Ti
            u = uPrev.clone().addScaledVector(Ti, -uPrev.dot(Ti));
            if (u.lengthSq() < 1e-10) u = null;
        }
        if (!u && hint) {
            u = hint.addScaledVector(Ti, -hint.dot(Ti));
            if (u.lengthSq() < 1e-10) u = null;
        }
        if (!u) {
            // Fallback stable perpendicular
            u = Math.abs(Ti.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
            u.addScaledVector(Ti, -u.dot(Ti));
        }
        u.normalize();
        const v = new THREE.Vector3().crossVectors(Ti, u).normalize();
        uPrev = u.clone();

        const ring = [];
        for (let j = 0; j <= radialSegments; j++) {
            const a = (j / radialSegments) * Math.PI * 2;
            const dir = u.clone().multiplyScalar(Math.cos(a)).add(v.clone().multiplyScalar(Math.sin(a)));
            ring.push(c.clone().addScaledVector(dir, radius));
        }
        rings.push(ring);
    }

    // Connect rings
    for (let i = 0; i < rings.length - 1; i++) {
        const r0 = rings[i];
        const r1 = rings[i + 1];
        const segs = Math.min(r0.length, r1.length) - 1;
        for (let j = 0; j < segs; j++) {
            const p00 = r0[j],   p01 = r0[j + 1];
            const p10 = r1[j],   p11 = r1[j + 1];
            solid.addTriangle(faceName, vToArr(p00), vToArr(p10), vToArr(p11));
            solid.addTriangle(faceName, vToArr(p00), vToArr(p11), vToArr(p01));
        }
    }
    if (closeLoop && rings.length > 2) {
        const r0 = rings[rings.length - 1];
        const r1 = rings[0];
        const segs = Math.min(r0.length, r1.length) - 1;
        for (let j = 0; j < segs; j++) {
            const p00 = r0[j],   p01 = r0[j + 1];
            const p10 = r1[j],   p11 = r1[j + 1];
            solid.addTriangle(faceName, vToArr(p00), vToArr(p10), vToArr(p11));
            solid.addTriangle(faceName, vToArr(p00), vToArr(p11), vToArr(p01));
        }
    } else {
        // Conical caps to the actual edge corner points (apex0/apex1)
        if (rings[0]?.length >= 3 && apex0) triangulateCapToPoint(solid, `${faceName}_CAP0`, rings[0], apex0, false);
        if (rings[rings.length - 1]?.length >= 3 && apex1) triangulateCapToPoint(solid, `${faceName}_CAP1`, rings[rings.length - 1], apex1, true);
    }
}

// Build a single, watertight fillet wedge directly:
// - Curved fillet surface (arc rings lofted along the edge)
// - Two planar side strips from vertex rail P to arc start/end
// - End caps at first/last sections if the edge is open
function buildWedgeDirect(solid, faceName, railP, sectorDefs, radius, arcSegments, closeLoop, seamA = null, seamB = null, skipSideStrips = false) {
    const n = Math.min(railP.length, sectorDefs.length);
    if (n < 2) return;

    // Derive sub-face names for clearer tagging
    const faceArc    = `${faceName}_ARC`;
    const faceCap0   = `${faceName}_CAP0`;
    const faceCap1   = `${faceName}_CAP1`;
    const faceSideA  = `${faceName}_SIDE_A`;
    const faceSideB  = `${faceName}_SIDE_B`;

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

    // Align parameterization ring-to-ring by allowing both flip and cyclic shift.
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
    for (let i = 0; i < n - 1; i++) {
        const r0 = arcRings[i];
        const r1 = arcRings[i + 1];
        for (let j = 0; j < arcSegments; j++) {
            const p00 = r0[j],   p01 = r0[j + 1];
            const p10 = r1[j],   p11 = r1[j + 1];
            const checker = ((i + j) & 1) === 0;
            if (checker) {
                solid.addTriangle(faceArc, vToArr(p00), vToArr(p10), vToArr(p11));
                solid.addTriangle(faceArc, vToArr(p00), vToArr(p11), vToArr(p01));
            } else {
                solid.addTriangle(faceArc, vToArr(p00), vToArr(p10), vToArr(p01));
                solid.addTriangle(faceArc, vToArr(p01), vToArr(p10), vToArr(p11));
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

    // Side strips: (P ↔ arc start) and (P ↔ arc end)
    if (!skipSideStrips) {
        for (let i = 0; i < n - 1; i++) {
            const P0 = railP[i], P1 = railP[i + 1];
            const A0 = arcRings[i][0], A1 = arcRings[i + 1][0];
            const B0 = arcRings[i][arcSegments], B1 = arcRings[i + 1][arcSegments];
            // P-A (side A strip)
            solid.addTriangle(faceSideA, vToArr(P0), vToArr(A0), vToArr(A1));
            solid.addTriangle(faceSideA, vToArr(P0), vToArr(A1), vToArr(P1));
            // P-B (side B strip)
            solid.addTriangle(faceSideB, vToArr(P0), vToArr(B1), vToArr(B0));
            solid.addTriangle(faceSideB, vToArr(P0), vToArr(P1), vToArr(B1));
        }
    }

    if (!skipSideStrips && closeLoop && n > 2) {
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
        // seam for side A
        solid.addTriangle(faceSideA, vToArr(P0), vToArr(A0), vToArr(A1));
        solid.addTriangle(faceSideA, vToArr(P0), vToArr(A1), vToArr(P1));
        // seam for side B
        solid.addTriangle(faceSideB, vToArr(P0), vToArr(B1), vToArr(B0));
        solid.addTriangle(faceSideB, vToArr(P0), vToArr(P1), vToArr(B1));
    }

    // End caps for open edges: fan from P to arc ring
    if (!closeLoop) {
        const Pstart = railP[0];
        const Astart = arcRings[0];
        for (let j = 0; j < arcSegments; j++) {
            const a0 = Astart[j], a1 = Astart[j + 1];
            solid.addTriangle(faceCap0, vToArr(Pstart), vToArr(a0), vToArr(a1));
        }
        const Pend = railP[n - 1];
        const Aend = arcRings[n - 1];
        for (let j = 0; j < arcSegments; j++) {
            const a0 = Aend[j], a1 = Aend[j + 1];
            solid.addTriangle(faceCap1, vToArr(Pend), vToArr(a1), vToArr(a0));
        }
    }
}
// Build a closed triangular prism by skinning 3 rails: P (edge), A (tangent to faceA), B (tangent to faceB)
function buildCornerPrism(solid, faceName, railP, railA, railB, closeLoop) {
    const n = Math.min(railP.length, railA.length, railB.length);
    if (n < 2) return;

    const link = (a0, a1, b0, b1) => {
        solid.addTriangle(faceName, vToArr(a0), vToArr(b0), vToArr(b1));
        solid.addTriangle(faceName, vToArr(a0), vToArr(b1), vToArr(a1));
    };

    for (let i = 0; i < n - 1; i++) {
        // Surfaces between rails
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
        // Triangular caps at ends
        solid.addTriangle(faceName, vToArr(railP[0]), vToArr(railA[0]), vToArr(railB[0]));
        solid.addTriangle(faceName, vToArr(railP[n-1]), vToArr(railB[n-1]), vToArr(railA[n-1]));
    }
}

// Solve for center C such that:
//   nA·C = nA·p - r
//   nB·C = nB·p - r
//   t ·C = t ·p
// Returns THREE.Vector3 or null
function solveCenterFromOffsetPlanes(p, t, nA, nB, r) {
    const dA = nA.dot(p) - r;
    const dB = nB.dot(p) - r;
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

// Variant that accepts chosen offset directions for each face normal.
function solveCenterFromOffsetPlanesSigned(p, t, nA, sA, nB, sB, r) {
    const dA = nA.dot(p) + sA * r;
    const dB = nB.dot(p) + sB * r;
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
function inflateSolidInPlace(solid, distance) {
    if (!Number.isFinite(distance) || distance === 0) return;
    // Get an oriented, deduplicated mesh from Manifold
    const mesh = solid.getMesh();
    const vp = mesh.vertProperties; // Float32Array length = 3*nv
    const tv = mesh.triVerts;       // Uint32Array length = 3*nt
    const fid = mesh.faceID;        // Uint32Array length = nt

    const nv = (vp.length / 3) | 0;
    const normals = new Float32Array(vp.length);

    // Accumulate area-weighted normals per vertex (triangle orientation is outward)
    for (let t = 0, tri = 0; t < tv.length; t += 3, tri++) {
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

    // Normalize and compute displaced positions
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

    // Re-author a new solid from displaced vertices, preserving face names
    const rebuilt = new Solid();
    for (let t = 0, tri = 0; t < tv.length; t += 3, tri++) {
        const i0 = tv[t + 0] >>> 0;
        const i1 = tv[t + 1] >>> 0;
        const i2 = tv[t + 2] >>> 0;
        const faceName = solid._idToFaceName.get(fid[tri]) || 'FILLET';
        rebuilt.addTriangle(
            faceName,
            [out[i0 * 3 + 0], out[i0 * 3 + 1], out[i0 * 3 + 2]],
            [out[i1 * 3 + 0], out[i1 * 3 + 1], out[i1 * 3 + 2]],
            [out[i2 * 3 + 0], out[i2 * 3 + 1], out[i2 * 3 + 2]]
        );
    }

    // Adopt rebuilt data into the original solid
    copyFromSolid(solid, rebuilt);
}

// Inflate only a subset of faces (by name predicate), accumulating
// area-weighted normals from those faces and offsetting the vertices
// that participate in them. Vertices not touched by the predicate
// remain in place. Shared seam vertices will shift accordingly,
// preserving watertightness while biasing only the intended faces.
function inflateSolidFacesInPlace(solid, distance, namePredicate) {
    if (!Number.isFinite(distance) || distance === 0) return;
    // Align sign with outward orientation so positive distance always expands the tool
    const vol = signedVolumeAuthoring(solid);
    const dirSign = (Number.isFinite(vol) && vol !== 0) ? (vol > 0 ? 1 : -1) : 1;
    const dist = distance * dirSign;
    // Operate on authoring arrays directly to avoid requiring a Manifold here.
    const vp = solid._vertProperties;
    const tv = solid._triVerts;
    const fid = solid._triIDs;

    const triCount = (tv.length / 3) | 0;
    const nv = (vp.length / 3) | 0;
    if (triCount === 0 || nv === 0) return;

    // Build mask per triangle whether its face name matches predicate
    const triUse = new Uint8Array(triCount);
    for (let t = 0; t < triCount; t++) {
        const id = fid ? fid[t] : undefined;
        const name = id !== undefined ? solid._idToFaceName.get(id) : undefined;
        triUse[t] = namePredicate && namePredicate(name) ? 1 : 0;
    }

    // Accumulate normals only from selected triangles
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

    // Compute displaced positions for affected vertices; others copy through
    const out = new Float32Array(vp.length);
    for (let i = 0; i < nv; i++) {
        const nx = normals[i * 3 + 0];
        const ny = normals[i * 3 + 1];
        const nz = normals[i * 3 + 2];
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-20) {
            const sx = nx / len, sy = ny / len, sz = nz / len;
            out[i * 3 + 0] = vp[i * 3 + 0] + sx * dist;
            out[i * 3 + 1] = vp[i * 3 + 1] + sy * dist;
            out[i * 3 + 2] = vp[i * 3 + 2] + sz * dist;
        } else {
            out[i * 3 + 0] = vp[i * 3 + 0];
            out[i * 3 + 1] = vp[i * 3 + 1];
            out[i * 3 + 2] = vp[i * 3 + 2];
        }
    }

    // Adopt displaced positions in-place; connectivity and face IDs remain unchanged
    solid._vertProperties = Array.from(out);
    // Rebuild exact-key map
    solid._vertKeyToIndex = new Map();
    for (let i = 0; i < solid._vertProperties.length; i += 3) {
        const x = solid._vertProperties[i], y = solid._vertProperties[i + 1], z = solid._vertProperties[i + 2];
        solid._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
    }
    solid._dirty = true;
    solid._faceIndex = null;
}

// Convenience: inflate just the fillet side-strip faces ("..._SIDE_A" / "..._SIDE_B")
function inflateSideFacesInPlace(solid, distance) {
    return inflateSolidFacesInPlace(solid, distance, (name) => {
        if (typeof name !== 'string') return false;
        return name.includes('_SIDE_A') || name.includes('_SIDE_B');
    });
}

// Convenience: inflate just the curved fillet arc faces ("..._ARC")
function inflateArcFacesInPlace(solid, distance) {
    return inflateSolidFacesInPlace(solid, distance, (name) => {
        if (typeof name !== 'string') return false;
        return name.endsWith('_ARC') || name.includes('_ARC');
    });
}
