
import { ConstraintEngine } from './sketchSolver2D/ConstraintEngine.js';
import { extractDefaultValues } from "../../PartHistory.js";
import * as THREE from 'three';
import { Face, Edge } from '../../BREP/BetterSolid.js';
import { LineGeometry } from 'three/examples/jsm/Addons.js';

const inputParamsSchema = {
    featureID: {
        type: "string",
        default_value: null,
        hint: "unique identifier for the sketch feature",
    },
    sketchPlane: {
        type: "reference_selection",
        selectionFilter: ["PLANE", "FACE"],
        multiple: false,
        default_value: null,
        hint: "Select the plane or face for the sketch",
    },
    editSketch: {
        type: "button",
        label: "Edit Sketch",
        default_value: null,
        hint: "Launch the 2D sketch editor",
        actionFunction: (ctx) => {
            try {
                if (ctx && ctx.viewer && typeof ctx.viewer.startSketchMode === 'function') {
                    ctx.viewer.startSketchMode(ctx.featureID);
                } else {
                    throw new Error('viewer.startSketchMode unavailable');
                }
            } catch (e) {
                console.warn('[SketchFeature] Failed to start sketch mode:', e?.message || e);
            }
        }
    },
    curveResolution: {
        type: "number",
        default_value: 64,
        hint: "Segments for circles; arcs scale proportionally",
    },
};

export class SketchFeature {
    static featureShortName = "S";
    static featureName = "Sketch";
    static inputParamsSchema = inputParamsSchema;

    constructor(partHistory) {
        this.partHistory = partHistory;
        this.inputParams = extractDefaultValues(inputParamsSchema);

        // Persisted between edits: { basis, sketch }
        this.persistentData = this.persistentData || {};
    }

    // Build (and persist) a plane basis from the selected sketchPlane.
    // Always recompute from the current referenced object transform if available,
    // so the sketch follows moves/updates of the face/plane.
    // basis = { origin: [x,y,z], x: [x,y,z], y: [x,y,z], z: [x,y,z], refName?: string }
    _getOrCreateBasis() {
        const currentRef = this.inputParams?.sketchPlane || null;
        const pdBasis = this.persistentData?.basis || null;
        const ph = this.partHistory;
        const refName = currentRef;
        const refObj = refName ? ph?.scene?.getObjectByName(refName) : null;

        const x = new THREE.Vector3(1,0,0);
        const y = new THREE.Vector3(0,1,0);
        const z = new THREE.Vector3(0,0,1);
        const origin = new THREE.Vector3();

        if (refObj) {
            refObj.updateWorldMatrix(true, true);
            // Prefer geometric center if available
            try {
                const g = refObj.geometry;
                if (g) {
                    const bs = g.boundingSphere || (g.computeBoundingSphere(), g.boundingSphere);
                    if (bs) origin.copy(refObj.localToWorld(bs.center.clone()));
                    else origin.copy(refObj.getWorldPosition(new THREE.Vector3()));
                } else origin.copy(refObj.getWorldPosition(new THREE.Vector3()));
            } catch { origin.copy(refObj.getWorldPosition(new THREE.Vector3())); }
            // For Face, use its avg normal; otherwise use object orientation
            if (refObj.type === 'FACE' && typeof refObj.getAverageNormal === 'function') {
                const n = refObj.getAverageNormal();
                const worldUp = new THREE.Vector3(0,1,0);
                const tmp = new THREE.Vector3();
                const zx = Math.abs(n.dot(worldUp)) > 0.9 ? new THREE.Vector3(1,0,0) : worldUp;
                x.copy(tmp.crossVectors(zx, n).normalize());
                y.copy(tmp.crossVectors(n, x).normalize());
                z.copy(n.clone().normalize());
            } else {
                const n = new THREE.Vector3(0,0,1).applyQuaternion(refObj.getWorldQuaternion(new THREE.Quaternion())).normalize();
                const worldUp = new THREE.Vector3(0,1,0);
                const tmp = new THREE.Vector3();
                const zx = Math.abs(n.dot(worldUp)) > 0.9 ? new THREE.Vector3(1,0,0) : worldUp;
                x.copy(tmp.crossVectors(zx, n).normalize());
                y.copy(tmp.crossVectors(n, x).normalize());
                z.copy(n);
            }
        }

        // If the reference object is missing (e.g., deleted), keep prior basis if present
        if (!refObj && pdBasis) return pdBasis;

        const basis = {
            origin: [origin.x, origin.y, origin.z],
            x: [x.x, x.y, x.z],
            y: [y.x, y.y, y.z],
            z: [z.x, z.y, z.z],
            refName: refName || undefined,
        };
        this.persistentData = this.persistentData || {};
        this.persistentData.basis = basis;
        return basis;
    }

    // Visualize sketch curves and points as a Group for selection (type='SKETCH').
    // Returns [group]
    async run() {
        const sceneGroup = new THREE.Group();
        sceneGroup.name = this.inputParams.featureID || 'Sketch';
        sceneGroup.type = 'SKETCH';
        // Provide a harmless onClick so Scene Manager rows don't error
        sceneGroup.onClick = () => {};

        const basis = this._getOrCreateBasis();
        const bO = new THREE.Vector3().fromArray(basis.origin);
        const bX = new THREE.Vector3().fromArray(basis.x);
        const bY = new THREE.Vector3().fromArray(basis.y);

        // Start from persisted sketch
        let sketch = this.persistentData?.sketch || { points: [{ id:0, x:0, y:0, fixed:true }], geometries: [], constraints: [{ id:0, type:"⏚", points:[0]}] };

        // Evaluate any expression-backed values on points/constraints using global expressions
        try {
            const exprSrc = this.partHistory?.expressions || '';
            const runExpr = (expressions, equation) => {
                try {
                    const fn = `${expressions}; return ${equation} ;`;
                    let result = Function(fn)();
                    if (typeof result === 'string') {
                        const num = Number(result);
                        if (!Number.isNaN(num)) return num;
                    }
                    return result;
                } catch { return null; }
            };
            if (Array.isArray(sketch?.points)) {
                for (const p of sketch.points) {
                    if (typeof p.x === 'string') {
                        const n = runExpr(exprSrc, p.x);
                        if (n != null && Number.isFinite(n)) p.x = Number(n);
                    }
                    if (typeof p.y === 'string') {
                        const n = runExpr(exprSrc, p.y);
                        if (n != null && Number.isFinite(n)) p.y = Number(n);
                    }
                }
            }
            if (Array.isArray(sketch?.constraints)) {
                for (const c of sketch.constraints) {
                    if (typeof c?.valueExpr === 'string') {
                        const n = runExpr(exprSrc, c.valueExpr);
                        if (n != null && Number.isFinite(n)) c.value = Number(n);
                    } else if (typeof c?.value === 'string') {
                        const n = runExpr(exprSrc, c.value);
                        if (n != null && Number.isFinite(n)) c.value = Number(n);
                    }
                }
            }
            // Re-solve sketch with evaluated values to reflect latest expressions
            try {
                const engine = new ConstraintEngine(JSON.stringify(sketch));
                const solved = engine.solve(500);
                sketch = solved;
                this.persistentData.sketch = solved;
            } catch {}
        } catch {}
        // Update external reference points by projecting selected model edge endpoints
        try {
            const scene = this.partHistory?.scene;
            const refs = Array.isArray(this.persistentData?.externalRefs) ? this.persistentData.externalRefs : [];
            if (scene && refs.length) {
                const toUV = (w)=>{ const d = new THREE.Vector3().copy(w).sub(bO); return { u: d.dot(bX), v: d.dot(bY) }; };
                const edgeEndpoints = (edge)=>{
                    if (!edge) return null;
                    const a = new THREE.Vector3();
                    const b = new THREE.Vector3();
                    const toW = (v)=> v.applyMatrix4(edge.matrixWorld);
                    const pts = Array.isArray(edge?.userData?.polylineLocal) ? edge.userData.polylineLocal : null;
                    if (pts && pts.length >= 2) {
                        a.set(pts[0][0], pts[0][1], pts[0][2]);
                        b.set(pts[pts.length-1][0], pts[pts.length-1][1], pts[pts.length-1][2]);
                        return { a: toW(a), b: toW(b) };
                    }
                    const pos = edge?.geometry?.getAttribute?.('position');
                    if (pos && pos.itemSize === 3 && pos.count >= 2) {
                        a.set(pos.getX(0), pos.getY(0), pos.getZ(0));
                        b.set(pos.getX(pos.count-1), pos.getY(pos.count-1), pos.getZ(pos.count-1));
                        return { a: toW(a), b: toW(b) };
                    }
                    return null;
                };
                const ptById = new Map(sketch.points.map(p=>[p.id,p]));
                let changed = false;
                for (const r of refs) {
                    try {
                        let edge = scene.getObjectById(r.edgeId);
                        if (!edge || edge.type !== 'EDGE') {
                            // Fallback by solidName + edgeName, then global by edgeName
                            if (r.solidName) {
                                const solid = this.partHistory?.scene?.getObjectByName(r.solidName);
                                if (solid) {
                                    let found = null;
                                    solid.traverse((obj) => { if (!found && obj.type === 'EDGE' && obj.name === r.edgeName) found = obj; });
                                    if (found) edge = found;
                                }
                            }
                            if ((!edge || edge.type !== 'EDGE') && r.edgeName) {
                                let found = null;
                                this.partHistory?.scene?.traverse((obj) => { if (!found && obj.type === 'EDGE' && obj.name === r.edgeName) found = obj; });
                                if (found) edge = found;
                            }
                            if (edge && edge.type === 'EDGE') {
                                // refresh stored id/name metadata
                                r.edgeId = edge.id;
                                try { r.edgeName = edge.name || r.edgeName || null; } catch {}
                                try { r.solidName = edge.parent?.name || r.solidName || null; } catch {}
                                changed = true;
                            }
                        }
                        if (!edge || edge.type !== 'EDGE') continue; // keep existing points if edge vanished
                        const ends = edgeEndpoints(edge);
                        if (!ends) continue;
                        const uvA = toUV(ends.a);
                        const uvB = toUV(ends.b);
                        const p0 = ptById.get(r.p0);
                        const p1 = ptById.get(r.p1);
                        if (p0 && (p0.x !== uvA.u || p0.y !== uvA.v)) { p0.x = uvA.u; p0.y = uvA.v; changed = true; }
                        if (p1 && (p1.x !== uvB.u || p1.y !== uvB.v)) { p1.x = uvB.u; p1.y = uvB.v; changed = true; }
                        if (p0) p0.fixed = true; if (p1) p1.fixed = true;
                        // Ensure ground constraints exist for these points so solver treats them fixed
                        const ensureGround = (pid)=>{
                            if (!sketch.constraints.some(c=>c.type==='⏚' && Array.isArray(c.points) && c.points[0]===pid)){
                                const cid = Math.max(0, ...sketch.constraints.map(c=> +c.id || 0)) + 1;
                                sketch.constraints.push({ id: cid, type: '⏚', points:[pid] });
                                changed = true;
                            }
                        };
                        if (p0) ensureGround(p0.id);
                        if (p1) ensureGround(p1.id);
                    } catch {}
                }
                if (changed) {
                    try {
                        const engine = new ConstraintEngine(JSON.stringify(sketch));
                        const solved = engine.solve(500);
                        sketch = solved;
                        this.persistentData.sketch = solved;
                    } catch {}
                }
            }
        } catch {}
        const curveRes = Math.max(8, Math.floor(Number(this.inputParams?.curveResolution) || 64));

        // Helper: 2D → 3D
        const to3D = (u, v) => new THREE.Vector3().copy(bO).addScaledVector(bX, u).addScaledVector(bY, v);

        // Do not add point/curve debug visuals in scene; editor handles those.

        // (no curve preview lines added)

        // ---- Build PROFILE face from sketch with loop detection + holes ----
        const pointById = new Map(sketch.points.map(p => [p.id, { x: p.x, y: p.y }]));
        const segs = [];
        const edges = [];
        const toWorld = (u,v)=> to3D(u,v);

        const edgeBySegId = new Map();
        for (const g of (sketch.geometries||[])) {
            if (g.type==='line' && g.points?.length===2) {
                const a = pointById.get(g.points[0]); const b = pointById.get(g.points[1]); if(!a||!b) continue;
                segs.push({ id:g.id, pts:[[a.x,a.y],[b.x,b.y]] });
                const aw = toWorld(a.x,a.y); const bw = toWorld(b.x,b.y);
                const lg = new LineGeometry();
                lg.setPositions([aw.x, aw.y, aw.z, bw.x, bw.y, bw.z]);
                const e = new Edge(lg); e.name = `G${g.id}`; e.userData = { polylineLocal:[[aw.x,aw.y,aw.z],[bw.x,bw.y,bw.z]], polylineWorld:true }; edges.push(e); edgeBySegId.set(g.id, e);
            } else if (g.type==='arc' && g.points?.length===3) {
                const c = pointById.get(g.points[0]); const sa=pointById.get(g.points[1]); const sb=pointById.get(g.points[2]); if(!c||!sa||!sb) continue;
                const cx=c.x, cy=c.y; const r=Math.hypot(sa.x-cx, sa.y-cy);
                let a0=Math.atan2(sa.y-cy, sa.x-cx), a1=Math.atan2(sb.y-cy, sb.x-cx);
                // CCW sweep in [0, 2π). If start≈end, treat as full circle.
                let d = a1 - a0; d = ((d % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI); if (Math.abs(d) < 1e-6) d = 2*Math.PI;
                const n=Math.max(8, Math.ceil(curveRes*(d)/(2*Math.PI)));
                const pts=[]; for(let i=0;i<=n;i++){ const t=a0+d*(i/n); pts.push([cx+r*Math.cos(t), cy+r*Math.sin(t)]);} 
                segs.push({ id:g.id, pts });
                const flat=[]; const worldPts=[]; for(const p of pts){ const v=toWorld(p[0],p[1]); flat.push(v.x,v.y,v.z); worldPts.push([v.x,v.y,v.z]); }
                const lg = new LineGeometry(); lg.setPositions(flat);
                const e = new Edge(lg); e.name = `G${g.id}`; e.userData = { polylineLocal: worldPts, polylineWorld:true }; edges.push(e); edgeBySegId.set(g.id, e);
            } else if (g.type==='circle' && g.points?.length===2) {
                const c = pointById.get(g.points[0]); const rp=pointById.get(g.points[1]); if(!c||!rp) continue;
                const cx=c.x, cy=c.y; const r=Math.hypot(rp.x-cx, rp.y-cy); const n=Math.max(8, curveRes); const pts=[]; for(let i=0;i<=n;i++){ const t=(i/n)*Math.PI*2; pts.push([cx+r*Math.cos(t), cy+r*Math.sin(t)]);} 
                segs.push({ id:g.id, pts });
                const flat=[]; const worldPts=[]; for(const p of pts){ const v=toWorld(p[0],p[1]); flat.push(v.x,v.y,v.z); worldPts.push([v.x,v.y,v.z]); }
                const lg = new LineGeometry(); lg.setPositions(flat);
                const e = new Edge(lg); e.name = `G${g.id}`; e.userData = { polylineLocal: worldPts, polylineWorld:true }; edges.push(e); edgeBySegId.set(g.id, e);
            }
        }

        // Utility helpers for loops
        const key=(x,y)=> `${x.toFixed(6)},${y.toFixed(6)}`;
        const nearlyEqual=(a,b,eps=1e-6)=> Math.abs(a-b)<=eps;
        const closePt=(p,q)=> nearlyEqual(p[0],q[0]) && nearlyEqual(p[1],q[1]);
        const ensureClosed=(arr)=>{
            if (arr.length<3) return arr;
            const f=arr[0], l=arr[arr.length-1];
            if (!closePt(f,l)) arr.push([f[0],f[1]]);
            return arr;
        };
        const dedupeConsecutive=(arr)=>{
            const out=[]; let prev=null;
            for(const p of arr){ if(!prev || !closePt(prev,p)){ out.push([p[0],p[1]]); prev=p; } }
            return out;
        };
        const removeCollinear=(arr, eps=1e-9)=>{
            if (arr.length <= 3) return arr;
            const ring = arr.slice();
            const n0 = ring.length;
            const out = [];
            for (let i=0;i<n0;i++){
                const a = ring[(i-1+n0)%n0];
                const b = ring[i];
                const c = ring[(i+1)%n0];
                const abx = b[0]-a[0], aby=b[1]-a[1];
                const bcx = c[0]-b[0], bcy=c[1]-b[1];
                const cross = abx*bcy - aby*bcx;
                if (Math.abs(cross) > eps) out.push(b);
            }
            return out.length>=3 ? out : arr;
        };
        const signedArea = (loop)=>{
            let a=0; for(let i=0;i<loop.length-1;i++){ const p=loop[i], q=loop[i+1]; a+= (p[0]*q[1]-q[0]*p[1]); } return 0.5*a;
        };
        const centroid2 = (loop)=>{
            const n = loop.length;
            if (n === 0) return [0,0];
            const first = loop[0];
            const last = loop[n-1];
            const ring = (nearlyEqual(first[0], last[0]) && nearlyEqual(first[1], last[1])) ? loop.slice(0, n-1) : loop;
            let cx=0, cy=0; let m=ring.length; for(const p of ring){ cx+=p[0]; cy+=p[1]; } return [cx/(m||1), cy/(m||1)];
        };
        const pointInPoly = (pt, poly)=>{
            // Winding number test. Poly may be closed; trim duplicate.
            const n = poly.length; if (n<3) return false;
            const first=poly[0], last=poly[n-1];
            const ring = (nearlyEqual(first[0],last[0])&&nearlyEqual(first[1],last[1]))? poly.slice(0,n-1): poly;
            const x = pt[0], y = pt[1];
            let wn=0;
            const isLeft=(ax,ay,bx,by,cx,cy)=> (bx-ax)*(cy-ay) - (by-ay)*(cx-ax);
            for (let i=0;i<ring.length;i++){
                const a = ring[i];
                const b = ring[(i+1)%ring.length];
                if (a[1] <= y) {
                    if (b[1] > y && isLeft(a[0],a[1],b[0],b[1],x,y) > 0) wn++;
                } else {
                    if (b[1] <= y && isLeft(a[0],a[1],b[0],b[1],x,y) < 0) wn--;
                }
            }
            return wn !== 0;
        };
        const reverseIfCW = (loop)=>{ if (signedArea(loop) < 0) return loop.slice().reverse(); return loop; };
        const makeCW = (loop)=>{ if (signedArea(loop) > 0) return loop.slice().reverse(); return loop; };

        // Build multiple loops by chaining segments greedily per connected component
        const unused = new Set(segs.map((_,i)=>i));
        const startKey = new Map(); // pointKey -> Set(segIndex as start)
        const endKey = new Map();   // pointKey -> Set(segIndex as end)
        const addTo = (map, k, v)=>{ let s=map.get(k); if(!s){ s=new Set(); map.set(k,s);} s.add(v); };
        segs.forEach((s,i)=>{ const a=s.pts[0], b=s.pts[s.pts.length-1]; addTo(startKey, key(a[0],a[1]), i); addTo(endKey, key(b[0],b[1]), i); });

        const loopsInfo=[]; // { pts, segIDs }
        while (unused.size){
            // seed with any remaining segment
            const seedIndex = unused.values().next().value;
            unused.delete(seedIndex);
            let chain = segs[seedIndex].pts.slice();
            const usedSegs = [seedIndex];

            let extended=true;
            while(extended){
                extended=false;
                // try extend forward
                const tail = chain[chain.length-1]; const tk = key(tail[0],tail[1]);
                let nextIdx = null; let reverse=false;
                for (const si of (startKey.get(tk)||[])) { if (unused.has(si)) { nextIdx=si; reverse=false; break; } }
                if (nextIdx===null){ for (const ei of (endKey.get(tk)||[])) { if (unused.has(ei)) { nextIdx=ei; reverse=true; break; } } }
                if (nextIdx!==null){
                    const pts = segs[nextIdx].pts;
                    const add = reverse ? pts.slice().reverse() : pts.slice();
                    // avoid duplicating joint point
                    chain.pop();
                    chain.push(...add);
                    unused.delete(nextIdx);
                    usedSegs.push(nextIdx);
                    extended=true;
                    continue;
                }
                // try extend backward
                const head = chain[0]; const hk = key(head[0],head[1]);
                nextIdx = null; reverse=false;
                for (const ei of (endKey.get(hk)||[])) { if (unused.has(ei)) { nextIdx=ei; reverse=false; break; } }
                if (nextIdx===null){ for (const si of (startKey.get(hk)||[])) { if (unused.has(si)) { nextIdx=si; reverse=true; break; } } }
                if (nextIdx!==null){
                    const pts = segs[nextIdx].pts;
                    const add = reverse ? pts.slice().reverse() : pts.slice();
                    // avoid duplicating joint point
                    add.pop();
                    chain = add.concat(chain);
                    unused.delete(nextIdx);
                    usedSegs.push(nextIdx);
                    extended=true;
                }
            }

            chain = dedupeConsecutive(chain);
            chain = ensureClosed(chain);
            // Simplify to avoid near-collinear noise
            let simple = chain.slice(0, chain.length-1);
            simple = removeCollinear(simple);
            simple.push(simple[0]);
            if (simple.length>=4){ loopsInfo.push({ pts: simple, segIDs: usedSegs.slice() }); }
        }

        // Classify loops (outer/holes) by nesting parity and normalize winding
        const normalizedLoops = loopsInfo.map(obj=>{
            const lp = obj.pts;
            // ensure closed single duplicate at end
            let l = lp.slice();
            if (!closePt(l[0], l[l.length-1])) l.push([l[0][0], l[0][1]]);
            // robust area; skip degenerate
            const a = Math.abs(signedArea(l));
            return a < 1e-12 ? null : l;
        }).filter(Boolean);
        // Keep segID lists aligned; drop those for degenerate loops we filtered
        const loopSegIDs = [];
        for (const info of loopsInfo){
            const lp = info.pts;
            let l = lp.slice();
            if (!closePt(l[0], l[l.length-1])) l.push([l[0][0], l[0][1]]);
            const a = Math.abs(signedArea(l));
            if (a >= 1e-12) loopSegIDs.push(info.segIDs.slice());
        }

        // Compute depth (number of containers)
        const depth = new Array(normalizedLoops.length).fill(0);
        const repPoint = (loop)=>{
            const n = loop.length; if (n===0) return [0,0];
            const first = loop[0]; const last = loop[n-1];
            const ring = (nearlyEqual(first[0], last[0]) && nearlyEqual(first[1], last[1])) ? loop.slice(0, n-1) : loop;
            return ring[0];
        };
        const reps = normalizedLoops.map(repPoint);
        for (let i=0;i<normalizedLoops.length;i++){
            for (let j=0;j<normalizedLoops.length;j++){
                if (i===j) continue;
                if (pointInPoly(reps[i], normalizedLoops[j])) depth[i]++;
            }
        }

        // Group into shapes: each even-depth loop is an outer; assign immediate odd-depth children as holes
        const groups=[]; // { outer, holes: [] }
        for (let i=0;i<normalizedLoops.length;i++){
            if ((depth[i] % 2) === 0){
                groups.push({ outer:i, holes:[] });
            }
        }
        // Assign holes to nearest containing outer
        for (let h=0; h<normalizedLoops.length; h++){
            if ((depth[h] % 2) !== 1) continue; // only odd-depth are holes
            // find smallest-depth containing outer
            let bestOuter = -1; let bestOuterDepth = Infinity;
            for (let g=0; g<groups.length; g++){
                const oi = groups[g].outer;
                if (pointInPoly(reps[h], normalizedLoops[oi])){
                    if (depth[oi] < bestOuterDepth){ bestOuter = g; bestOuterDepth = depth[oi]; }
                }
            }
            if (bestOuter>=0) groups[bestOuter].holes.push(h);
        }

        // Triangulate groups using THREE.ShapeUtils.triangulateShape
        let profileFace=null;
        if (groups.length){
            const triPositions = [];
            const boundaryEdges = new Set();
            const boundaryLoopsWorld = [];
            const profileGroups = [];
            for (const grp of groups){
                // Prepare contour and holes (remove duplicate last point for API)
                let contour = normalizedLoops[grp.outer].slice(); contour.pop();
                // Earcut expects outer CW, holes CCW. Enforce CW for outer
                if (signedArea([...contour, contour[0]]) > 0) contour = contour.slice().reverse();
                // Record boundary edges for outer
                for (const sid of (loopSegIDs[grp.outer] || [])) {
                    const e = edgeBySegId.get(segs[sid]?.id);
                    if (e) {
                        try { e.userData = e.userData || {}; e.userData.isHole = false; } catch {}
                        boundaryEdges.add(e);
                    }
                }
                const holes = grp.holes.map(idx=>{
                    let h = normalizedLoops[idx].slice(); h.pop();
                    // Ensure CCW for holes (outer is CW per earcut convention)
                    if (signedArea([...h, h[0]]) < 0) h = h.slice().reverse();
                    for (const sid of (loopSegIDs[idx] || [])) {
                        const e = edgeBySegId.get(segs[sid]?.id);
                        if (e) {
                            try { e.userData = e.userData || {}; e.userData.isHole = true; } catch {}
                            boundaryEdges.add(e);
                        }
                    }
                    return h;
                });

                const contourV2 = contour.map(p=> new THREE.Vector2(p[0], p[1]));
                const holesV2 = holes.map(arr => arr.map(p=> new THREE.Vector2(p[0], p[1])));

                // Triangulate using ShapeUtils (earcut) directly
                const tris = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);
                const allPts = contour.concat(...holes);
                for (const t of tris){
                    const a = allPts[t[0]], b = allPts[t[1]], c = allPts[t[2]];
                    triPositions.push(a[0],a[1],0, b[0],b[1],0, c[0],c[1],0);
                }

                // Save world-space loops for robust sweep side construction
                const toW = (p)=> toWorld(p[0], p[1]);
                const worldOuter = contour.map(p=>{ const v=toW(p); return [v.x,v.y,v.z]; });
                const worldHoles = holes.map(h=> h.map(p=>{ const v=toW(p); return [v.x,v.y,v.z]; }));
                boundaryLoopsWorld.push({ pts: worldOuter, isHole: false });
                for (const h of worldHoles) boundaryLoopsWorld.push({ pts: h, isHole: true });
                profileGroups.push({ contour2D: contour.slice(), holes2D: holes.map(h=>h.slice()), contourW: worldOuter.slice(), holesW: worldHoles.map(h=>h.slice()) });
            }

            if (triPositions.length){
                const geom2D = new THREE.BufferGeometry();
                geom2D.setAttribute('position', new THREE.Float32BufferAttribute(triPositions,3));
                // Map from plane to world
                const m = new THREE.Matrix4();
                const bO2 = new THREE.Vector3().fromArray(basis.origin);
                const bX2 = new THREE.Vector3().fromArray(basis.x);
                const bY2 = new THREE.Vector3().fromArray(basis.y);
                const bZ2 = new THREE.Vector3().crossVectors(bX2,bY2).normalize();
                m.makeBasis(bX2,bY2,bZ2); m.setPosition(bO2);
                geom2D.applyMatrix4(m); geom2D.computeVertexNormals(); geom2D.computeBoundingSphere();
                const face = new Face(geom2D); face.name = `${sceneGroup.name}:PROFILE`; face.userData.faceName = face.name; face.edges = Array.from(boundaryEdges); face.userData.boundaryLoopsWorld = boundaryLoopsWorld; face.userData.profileGroups = profileGroups;
                sceneGroup.add(face);
                for (const e of edges) { sceneGroup.add(e); }
                profileFace = face;
            }
        }

        return [sceneGroup];
    }
}
