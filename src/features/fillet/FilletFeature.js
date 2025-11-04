import { clearFilletCaches, computeFilletCenterline, filletSolid } from "../../BREP/fillets/fillet.js";
import { applyBooleanOperation } from "../../BREP/applyBooleanOperation.js";
import { getDistanceTolerance } from "../../BREP/fillets/inset.js";
import Edge from "../../BREP/Edge.js";
import { THREE } from "../../BREP/SolidShared.js";


const inputParamsSchema = {
    edges: {
        type: "reference_selection",
        selectionFilter: ["FACE", "EDGE"],
        multiple: true,
        default_value: null,
        hint: "Select faces (or an edge) to fillet along shared edges",
    },
    radius: {
        type: "number",
        step: 0.1,
        default_value: 1,
        hint: "Fillet radius",
    },
    inflate: {
        type: "number",
        step: 0.1,
        default_value: 0.1,
        hint: "Grow the cutting solid by this amount (units). Keep tiny (e.g. 0.0005). Closed loops ignore inflation to avoid self‑intersection.",
    },
    direction: {
        type: "options",
        options: ["INSET", "OUTSET"],
        default_value: "INSET",
        hint: "Prefer fillet inside (INSET) or outside (OUTSET)",
    },
    debug: {
        type: "boolean",
        default_value: false,
        hint: "Draw diagnostic vectors for section frames (u,v, bisector, tangency)",
    }
}
    ;

export class FilletFeature {
    static featureShortName = "F";
    static featureName = "Fillet";
    static inputParamsSchema = inputParamsSchema;


    constructor() {
        this.inputParams = {};
        this.persistentData = {};
    }
    async run(partHistory) {
        // Clear caches between runs
        try { clearFilletCaches(); } catch { }
        const added = [];
        const removed = [];

        // Accept resolved objects from sanitizeInputParams
        const inputObjects = Array.isArray(this.inputParams.edges) ? this.inputParams.edges.filter(Boolean) : [];

        let edgeObjs = [];
        inputObjects.forEach(obj => {
            if (obj.type === "EDGE") {
                if (!edgeObjs.includes(obj)) edgeObjs.push(obj);
            }
            if (obj.type === "FACE") {
                for (const edge of obj.edges) {
                    edgeObjs.push(edge);
                }
            }
        });

        // Deduplicate and ensure edges belong to a solid
        edgeObjs = Array.from(new Set(edgeObjs));
        edgeObjs = edgeObjs.filter(e => (e && (e.parentSolid || e.parent)));

        if (edgeObjs.length === 0) {
            console.warn("No edges selected for fillet");
            return { added: [], removed: [] };
        }
        const solids = new Set(edgeObjs.map(e => e.parentSolid || e.parent));
        if (solids.size === 0) {
            console.warn("Selected edges do not belong to any solid");
            return { added: [], removed: [] };
        }
        if (solids.size > 1) {
            console.warn("Selected edges belong to multiple solids");
            return { added: [], removed: [] };
        }

        // Centerline-only mode: compute overlays and exit. No geometry changes.

        const dir = String(this.inputParams.direction || 'INSET').toUpperCase();
        const r = Number(this.inputParams.radius);



        const filletSolids = [];
        const debugSolids = []; // Store tube and wedge solids for debug mode

        if (Number.isFinite(r) && r > 0) {
            const fid = this.inputParams?.featureID || 'FILLET';
            let ci = 0;
            // Collect individual fillet solids per edge to combine later

            for (const e of edgeObjs) {
                try {
                    console.log(e);
                    try {
                        const filletName = `${fid}_FILLET_${ci++}`;
                        const res = filletSolid({
                            edgeToFillet: e,
                            radius: r,
                            sideMode: dir,
                            inflate: Number(this.inputParams.inflate) || 0,
                            debug: !!this.inputParams.debug,
                            name: filletName
                        });

                        const { finalSolid, tube, wedge, tangentA, tangentB } = res || {};
                        if (finalSolid) {
                            const tangents = [];
                            if (Array.isArray(tangentA) && tangentA.length >= 2) tangents.push({ points: tangentA, radius: r, label: `${filletName}_TA`, owner: filletName });
                            if (Array.isArray(tangentB) && tangentB.length >= 2) tangents.push({ points: tangentB, radius: r, label: `${filletName}_TB`, owner: filletName });
                            filletSolids.push({ finalSolid, target: e.parentSolid, tangents });

                            // Store debug solids for debug mode
                            if (tube) debugSolids.push(tube);
                            if (wedge) debugSolids.push(wedge);
                        }

                        console.log("Fillet solid created for edge:", e);

                    } catch (filletError) {
                        console.error("Failed to create FilletSolid:", filletError?.message || filletError);
                        // Continue with next edge instead of stopping entirely
                    }

                } catch (error) {
                    console.warn("Fillet generation failed for edge:", e, error);
                }
            }
        }


        //console.log("Fillet solids created:", filletSolids);
        // group fillet solids by their target solids
        const filletsByTarget = new Map();
        for (const { finalSolid, target, tangents } of filletSolids) {
            if (!filletsByTarget.has(target)) filletsByTarget.set(target, []);
            filletsByTarget.get(target).push({ finalSolid, tangents: Array.isArray(tangents) ? tangents : [] });
        }


        // Apply fillet solids to their target solids using the boolean union for outset and boolean subtract for inset
        for (const [targetSolid, filletSolids] of filletsByTarget.entries()) {
            console.log("Applying fillets to target solid:", targetSolid, filletSolids);
            let solidResult = targetSolid;

            // Collect tangent polylines for snapping, per-target
            const snapTargets = [];

            // loop over each fillet solid and apply boolean operation
            for (const entry of filletSolids) {
                const filletSolid = entry.finalSolid;
                // check if we are doing INSET or OUTSET
                if (dir === "OUTSET") {
                    solidResult = solidResult.union(filletSolid);
                } else if (dir === "INSET") {
                    solidResult = solidResult.subtract(filletSolid);
                }
                // accumulate tangents
                if (Array.isArray(entry.tangents)) {
                    for (const t of entry.tangents) {
                        if (t && Array.isArray(t.points) && t.points.length >= 2) snapTargets.push(t);
                    }
                }
            }

            removed.push(targetSolid);
            try {
                // Post-process: snap new boundary edges to computed tangent polylines
                if (snapTargets.length) {
                    this._snapBooleanEdgesToTangents(solidResult, snapTargets);
                }
                // In debug mode, visualize the calculated tangent polylines
                if (this.inputParams.debug && snapTargets.length) {
                    const isClosed = (arr) => {
                        if (!Array.isArray(arr) || arr.length < 2) return false;
                        const a = Array.isArray(arr[0]) ? arr[0] : [arr[0]?.x, arr[0]?.y, arr[0]?.z];
                        const b = Array.isArray(arr[arr.length-1]) ? arr[arr.length-1] : [arr[arr.length-1]?.x, arr[arr.length-1]?.y, arr[arr.length-1]?.z];
                        if (!Array.isArray(a) || !Array.isArray(b)) return false;
                        return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
                    };
                    for (const t of snapTargets) {
                        try {
                            solidResult.addAuxEdge(t.label || 'FILLET_TANGENT', t.points, { materialKey: 'OVERLAY', closedLoop: isClosed(t.points) });
                        } catch (_) { }
                    }
                }
            } catch (snapErr) {
                console.warn('Fillet post-snap failed:', snapErr?.message || snapErr);
            }
            added.push(solidResult);

        }


        // if debug is enabled, add all debug solids (tube and wedge solids)
        if (this.inputParams.debug) {
            debugSolids.forEach(debugSolid => {
                added.push(debugSolid);
            });



        }


        return { added, removed };
    }

    /**
     * Post-process the result solid: find boundary polylines created by booleans
     * and snap their vertices onto the precomputed tangent polylines.
     * @param {import('../../BREP/BetterSolid.js').Solid} solidResult
     * @param {{ points: Array<{x:number,y:number,z:number}|number[]>, radius?: number, label?: string }[]} targets
     */
    _snapBooleanEdgesToTangents(solidResult, targets = [], skip = true) {
        // Force on: absolutely every point along boolean-created edges should snap
        if (!solidResult || !Array.isArray(targets) || targets.length === 0) return;

        const toArrayPoint = (p) => Array.isArray(p) ? [Number(p[0])||0, Number(p[1])||0, Number(p[2])||0] : [Number(p.x)||0, Number(p.y)||0, Number(p.z)||0];
        const tangentPolys = targets.map(t => ({
            pts: (Array.isArray(t.points) ? t.points : []).map(toArrayPoint),
            r: Number.isFinite(t.radius) ? Math.abs(t.radius) : undefined,
            label: t.label || 'TANGENT',
            owner: t.owner || ''
        })).filter(t => t.pts.length >= 2);
        if (!tangentPolys.length) return;

        const boundary = solidResult.getBoundaryEdgePolylines() || [];
        if (!boundary.length) return;

        // Helper: polyline length
        const polyLength = (arr) => {
            let L = 0; for (let i = 1; i < arr.length; i++) {
                const a = arr[i-1], b = arr[i];
                const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
                L += Math.hypot(dx, dy, dz);
            } return L;
        };
        // Helper: closest point on segment ab to point p
        const closestOnSeg = (p, a, b) => {
            const ax = a[0], ay = a[1], az = a[2];
            const bx = b[0], by = b[1], bz = b[2];
            const px = p[0], py = p[1], pz = p[2];
            const vx = bx - ax, vy = by - ay, vz = bz - az;
            const wx = px - ax, wy = py - ay, wz = pz - az;
            const vv = vx*vx + vy*vy + vz*vz;
            let t = vv > 0 ? (wx*vx + wy*vy + wz*vz) / vv : 0;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            return [ax + vx*t, ay + vy*t, az + vz*t];
        };
        // Helper: closest point on a polyline to point p
        const closestOnPolyline = (p, poly) => {
            let best = null, bestD2 = Infinity;
            for (let i = 1; i < poly.length; i++) {
                const q = closestOnSeg(p, poly[i-1], poly[i]);
                const dx = q[0]-p[0], dy = q[1]-p[1], dz = q[2]-p[2];
                const d2 = dx*dx + dy*dy + dz*dz;
                if (d2 < bestD2) { bestD2 = d2; best = q; }
            }
            return best || poly[0].slice();
        };
        // Helper: average segment length
        const avgSegLen = (poly) => {
            if (!Array.isArray(poly) || poly.length < 2) return 0;
            let acc = 0, n = 0; for (let i=1;i<poly.length;i++){ const a=poly[i-1], b=poly[i]; acc += Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]); n++; }
            return n ? acc/n : 0;
        };
        // Helper: densify a polyline by inserting points every `step` along segments (keeps endpoints)
        const densifyPolyline = (poly, step) => {
            if (!Array.isArray(poly) || poly.length < 2 || !(step > 0)) return poly.slice();
            const out = [poly[0].slice()];
            for (let i = 1; i < poly.length; i++) {
                const a = poly[i-1];
                const b = poly[i];
                const dx = b[0]-a[0], dy = b[1]-a[1], dz = b[2]-a[2];
                const len = Math.hypot(dx,dy,dz);
                if (len <= step) { out.push(b.slice()); continue; }
                const count = Math.max(1, Math.floor(len/step));
                const inv = 1/len;
                const ux = dx*inv, uy = dy*inv, uz = dz*inv;
                for (let k=1;k<count;k++) {
                    const t = k*step;
                    out.push([a[0]+ux*t, a[1]+uy*t, a[2]+uz*t]);
                }
                out.push(b.slice());
            }
            return out;
        };
        // Compute score between a boundary polyline and a tangent polyline
        const polyScore = (boundaryPoly, tangentPoly, radius) => {
            const pts = boundaryPoly?.positions || [];
            if (!pts.length) return Infinity;
            let sum = 0;
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i];
                const q = closestOnPolyline(p, tangentPoly);
                const dx = q[0]-p[0], dy = q[1]-p[1], dz = q[2]-p[2];
                sum += Math.hypot(dx, dy, dz);
            }
            const avg = sum / pts.length;
            const Lb = polyLength(pts);
            const Lt = polyLength(tangentPoly);
            const relLen = Math.abs(Lb - Lt) / Math.max(Lt, 1e-9);
            const tol = getDistanceTolerance(Number.isFinite(radius) ? radius : Lt || 1);
            // Weighted score: average distance + small penalty for length mismatch
            return avg + 0.2 * relLen * Math.max(tol, 1e-6);
        };

        const vp = solidResult._vertProperties;
        if (!Array.isArray(vp) || vp.length < 3) return;
        // Group tangents by their owner (per-filleting instance)
        const ownerToTangents = new Map();
        for (const t of tangentPolys) {
            const key = String(t.owner || '');
            if (!ownerToTangents.has(key)) ownerToTangents.set(key, []);
            ownerToTangents.get(key).push(t);
        }

        // For each owner group, snap every boundary polyline that involves faces
        // from that fillet to the nearest tangent from the same owner.
        for (const [owner, tangs] of ownerToTangents.entries()) {
            // Find boundary polylines created by this boolean (faceA or faceB contains owner label)
            const candidates = boundary
                .map((b, idx) => ({ idx, poly: b, faceA: String(b.faceA||''), faceB: String(b.faceB||'') }))
                .filter(e => owner && (e.faceA.includes(owner) || e.faceB.includes(owner)));

            for (const c of candidates) {
                const pts = c.poly.positions || [];
                if (!pts.length) continue;
                // Choose the nearest tangent (A vs B) for this boundary
                let bestT = tangs[0];
                let bestScore = Infinity;
                for (const t of tangs) {
                    const s = polyScore(c.poly, t.pts, t.r);
                    if (s < bestScore) { bestScore = s; bestT = t; }
                }
                // Densify chosen tangent to match boundary spacing
                const step = Math.max(1e-9, avgSegLen(pts) * 0.5);
                const denseTangent = densifyPolyline(bestT.pts, step);

                // Snap absolutely every vertex on this boundary polyline
                const idxChain = c.poly.indices || [];
                const moved = new Set();
                for (const vi of idxChain) {
                    if (!Number.isFinite(vi) || vi < 0) continue;
                    if (moved.has(vi)) continue; moved.add(vi);
                    const px = vp[vi*3+0], py = vp[vi*3+1], pz = vp[vi*3+2];
                    const q = closestOnPolyline([px,py,pz], denseTangent);
                    vp[vi*3+0] = q[0]; vp[vi*3+1] = q[1]; vp[vi*3+2] = q[2];
                }
            }
        }

        // loop over all the solids and cleanup any degenerated triangles
        //solidResult.removeInternalTriangles();

        // Invalidate caches and rehash vertex keys
        solidResult._dirty = true;
        solidResult._faceIndex = null;
        try {
            if (solidResult._vertKeyToIndex && typeof solidResult._vertKeyToIndex.clear === 'function') solidResult._vertKeyToIndex.clear();
            const n = (vp.length/3)|0;
            for (let i = 0; i < n; i++) {
                const k = `${vp[i*3+0]},${vp[i*3+1]},${vp[i*3+2]}`;
                solidResult._vertKeyToIndex.set(k, i);
            }
        } catch {}
    }
}
