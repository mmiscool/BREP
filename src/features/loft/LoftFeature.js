import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the loft feature",
  },
  profiles: {
    type: "reference_selection",
    selectionFilter: ["SKETCH", "FACE"],
    multiple: true,
    default_value: [],
    hint: "Select 2+ profiles (faces) to loft",
  },
  referencePoints: {
    type: "reference_selection",
    selectionFilter: ["VERTEX"],
    multiple: true,
    default_value: [],
    label: "Start Points (optional)",
    hint: "Optionally select start vertex per profile (order matches profiles)",
  },
  guideCurves: {
    type: "reference_selection",
    selectionFilter: ["EDGE"],
    multiple: true,
    default_value: [],
    hint: "Optional guide curves (unused)",
  },
  loftType: {
    type: "options",
    options: ["normal"],
    default_value: "normal",
    hint: "Type of loft to create",
  },
  reverseFirstLoop: {
    type: "boolean",
    default_value: false,
    label: "Reverse first loop order",
    hint: "Reverse edge order of the first profile's outer loop",
  },
  boolean: {
    type: "boolean_operation",
    default_value: { targets: [], operation: 'NONE' },
    hint: "Optional boolean operation with selected solids"
  }
};

export class LoftFeature {
  static featureShortName = "LOFT";
  static featureName = "Loft";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const { profiles } = this.inputParams;
    if (!Array.isArray(profiles) || profiles.length < 2) {
      console.warn("LoftFeature: select at least two profiles (faces or sketches)");
      return [];
    }

    // Resolve input names to FACE objects; allow SKETCH that contains a FACE
    const faces = [];
    const removed = [];
    for (const obj of profiles) {
      if (!obj) continue;
      let faceObj = obj;
      if (obj && obj.type === 'SKETCH') {
        faceObj = obj.children.find(ch => ch.type === 'FACE') || obj.children.find(ch => ch.userData?.faceName);
      }
      if (faceObj && faceObj.type === 'FACE') {
        // If face came from a sketch, mark sketch for removal (structured)
        if (faceObj.parent && faceObj.parent.type === 'SKETCH') removed.push(faceObj.parent);
        faces.push(faceObj);
      }
    }

    if (faces.length < 2) {
      console.warn("LoftFeature: need at least two resolved FACE objects");
      return [];
    }

    // Build a sidewall naming map using ONLY the first face's edge names
    const firstFace = faces[0];
    const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;
    const pointToEdgeNames = new Map(); // key -> Set(edgeName)
    const seedEdgePoint = (edgeName, arrP) => {
      for (const p of arrP) {
        const k = key(p);
        let set = pointToEdgeNames.get(k);
        if (!set) { set = new Set(); pointToEdgeNames.set(k, set); }
        set.add(edgeName);
      }
    };
    const collectEdgePolylineWorld = (edge) => {
      const out = [];
      const cached = edge?.userData?.polylineLocal;
      const isWorld = !!(edge?.userData?.polylineWorld);
      const v = new THREE.Vector3();
      if (Array.isArray(cached) && cached.length >= 2) {
        if (isWorld) return cached.map(p => [p[0], p[1], p[2]]);
        for (const p of cached) { v.set(p[0], p[1], p[2]).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]); }
        return out;
      }
      const posAttr = edge?.geometry?.getAttribute?.('position');
      if (posAttr && posAttr.itemSize === 3 && posAttr.count >= 2) {
        for (let i = 0; i < posAttr.count; i++) { v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]); }
        return out;
      }
      const aStart = edge?.geometry?.attributes?.instanceStart;
      const aEnd = edge?.geometry?.attributes?.instanceEnd;
      if (aStart && aEnd && aStart.itemSize === 3 && aEnd.itemSize === 3 && aStart.count === aEnd.count && aStart.count >= 1) {
        v.set(aStart.getX(0), aStart.getY(0), aStart.getZ(0)).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]);
        for (let i = 0; i < aEnd.count; i++) { v.set(aEnd.getX(i), aEnd.getY(i), aEnd.getZ(i)).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]); }
        return out;
      }
      return out;
    };
    const edges0 = Array.isArray(firstFace?.edges) ? firstFace.edges : [];
    const firstEdgesWorld = [];
    for (const e of edges0) {
      const name = e?.name || 'EDGE'; // use raw edge name from first face
      const pts = collectEdgePolylineWorld(e);
      if (pts.length >= 2) { seedEdgePoint(name, pts); firstEdgesWorld.push({ name, pts }); }
    }
    const distSqPointToSeg = (p, a, b) => {
      const ax=a[0], ay=a[1], az=a[2];
      const bx=b[0], by=b[1], bz=b[2];
      const px=p[0], py=p[1], pz=p[2];
      const abx=bx-ax, aby=by-ay, abz=bz-az;
      const apx=px-ax, apy=py-ay, apz=pz-az;
      const ab2=abx*abx+aby*aby+abz*abz; if (ab2<=1e-18) { const dx=apx, dy=apy, dz=apz; return dx*dx+dy*dy+dz*dz; }
      const t=Math.max(0,Math.min(1,(apx*abx+apy*aby+apz*abz)/ab2));
      const qx=ax+t*abx, qy=ay+t*aby, qz=az+t*abz;
      const dx=px-qx, dy=py-qy, dz=pz-qz; return dx*dx+dy*dy+dz*dz;
    };
    const nearestFirstEdgeName = (p) => {
      let best=null, bestD=+Infinity;
      for (const ed of firstEdgesWorld) {
        const arr = ed.pts;
        for (let i=0;i<arr.length-1;i++){
          const d2 = distSqPointToSeg(p, arr[i], arr[i+1]);
          if (d2 < bestD) { bestD = d2; best = ed.name; }
        }
      }
      return best || `${firstFace.name || 'FACE'}_LF`;
    };

    // Helper: unify loop form and cleanup
    const closeAndDedup = (pts) => {
      const pA = pts.slice();
      if (pA.length >= 2) {
        const first = pA[0], last = pA[pA.length - 1];
        if (!(first[0] === last[0] && first[1] === last[1] && first[2] === last[2])) pA.push([first[0], first[1], first[2]]);
      }
      for (let i = pA.length - 2; i >= 0; i--) {
        const a = pA[i], b = pA[i + 1];
        if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) pA.splice(i + 1, 1);
      }
      return pA;
    };

    const getLoops = (face) => {
      const loops = Array.isArray(face?.userData?.boundaryLoopsWorld) ? face.userData.boundaryLoopsWorld : null;
      if (loops && loops.length) return loops.map(l => ({ isHole: !!(l && l.isHole), pts: Array.isArray(l?.pts) ? l.pts : l }));
      // Fallback: approximate a single outer loop by concatenating edge polylines
      const edges = Array.isArray(face?.edges) ? face.edges : [];
      const poly = [];
      for (const e of edges) {
        const pts = collectEdgePolylineWorld(e);
        if (pts.length) poly.push(...pts);
      }
      return poly.length ? [{ isHole: false, pts: poly }] : [];
    };

    // Helpers to manipulate loops: ensure closed, rotate start, and reverse
    const ensureClosed = (pts) => {
      if (!Array.isArray(pts) || pts.length === 0) return [];
      const out = pts.slice();
      if (out.length >= 2) {
        const a = out[0], b = out[out.length - 1];
        if (!(a[0] === b[0] && a[1] === b[1] && a[2] === b[2])) out.push([a[0], a[1], a[2]]);
      }
      return out;
    };
    const toOpen = (pts) => {
      if (!Array.isArray(pts) || pts.length === 0) return [];
      const out = pts.slice();
      if (out.length >= 2) {
        const a = out[0], b = out[out.length - 1];
        if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) out.pop();
      }
      return out;
    };
    const rotateStart = (ptsClosed, startIndex) => {
      const open = toOpen(ptsClosed);
      const n = open.length;
      if (n === 0) return ensureClosed(ptsClosed);
      const k = ((startIndex % n) + n) % n;
      const rotated = open.slice(k).concat(open.slice(0, k));
      return ensureClosed(rotated);
    };
    const reverseLoop = (ptsClosed) => {
      const open = toOpen(ptsClosed).slice().reverse();
      return ensureClosed(open);
    };

    // Precompute loops for all faces (closed + dedup)
    const loopsByFace = faces.map(f => getLoops(f).map(l => ({ ...l, pts: closeAndDedup(l.pts) })));

    // Apply optional start-point alignment and first-loop reversal
    try {
      const refNames = Array.isArray(this.inputParams?.referencePoints) ? this.inputParams.referencePoints : [];
      const scene = partHistory && partHistory.scene ? partHistory.scene : null;
      const refObjs = [];
      if (scene && refNames.length) {
        for (const nm of refNames) {
          try { refObjs.push(scene.getObjectByName(String(nm))); } catch { refObjs.push(null); }
        }
      }
      const tmpV = new THREE.Vector3();
      const dist2 = (a, b) => {
        const dx=a[0]-b[0], dy=a[1]-b[1], dz=a[2]-b[2];
        return dx*dx+dy*dy+dz*dz;
      };
      // For each face that has a provided vertex, rotate the OUTER loop (li=0) to start near that vertex
      for (let i = 0; i < faces.length; i++) {
        const ref = refObjs[i];
        if (!ref || !loopsByFace[i] || !loopsByFace[i].length) continue;
        try {
          tmpV.set(0,0,0); ref.getWorldPosition(tmpV);
        } catch { continue; }
        const loop0 = loopsByFace[i][0];
        const pts = Array.isArray(loop0?.pts) ? loop0.pts : [];
        if (pts.length < 2) continue;
        const rp = [tmpV.x, tmpV.y, tmpV.z];
        // Find nearest point index on the closed loop
        let bestIdx = 0; let bestD = +Infinity;
        for (let j = 0; j < pts.length - 1; j++) { // ignore duplicate last
          const d = dist2(pts[j], rp);
          if (d < bestD) { bestD = d; bestIdx = j; }
        }
        loopsByFace[i][0] = { ...loop0, pts: rotateStart(pts, bestIdx) };
      }
      // Reverse first face's outer loop if requested
      if (this.inputParams?.reverseFirstLoop && loopsByFace[0] && loopsByFace[0][0]) {
        loopsByFace[0][0] = { ...loopsByFace[0][0], pts: reverseLoop(loopsByFace[0][0].pts) };
      }
    } catch (_) { /* alignment optional; ignore errors to keep legacy behavior */ }

    // Robust pairwise alignment to prevent loft twisting
    // - Resample B loop to match A loop count
    // - Choose best rotation and orientation (reverse or not) to minimize distance
    const toOpenLoop = (pts) => toOpen(pts);
    const segLen = (p, q) => Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]);
    const ringLength = (open) => {
      const n = open.length; if (n === 0) return 0;
      let L = 0; for (let i=0;i<n;i++){ const a=open[i], b=open[(i+1)%n]; L += segLen(a,b);} return L;
    };
    const lerp = (a,b,t)=>[a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
    const resampleRing = (open, count) => {
      const n = open.length; if (n === 0 || count <= 0) return [];
      if (n === count) return open.slice();
      const total = ringLength(open);
      if (total <= 0) return open.slice(0, count);
      // build cumulative lengths
      const cum = new Array(n+1); cum[0]=0;
      for (let i=0;i<n;i++){ cum[i+1]=cum[i]+segLen(open[i], open[(i+1)%n]); }
      const out = new Array(count);
      const step = total / count;
      let seg = 0; // current segment index
      for (let k=0;k<count;k++){
        const s = k*step;
        // advance until cum[seg+1] >= s
        while (seg < n && cum[seg+1] < s - 1e-9) seg++;
        const a = open[seg % n];
        const b = open[(seg+1)%n];
        const segStart = cum[seg];
        const segLenTot = Math.max(1e-12, cum[seg+1]-segStart);
        const t = (s - segStart) / segLenTot;
        out[k] = lerp(a,b,Math.max(0,Math.min(1,t)));
      }
      return out;
    };
    const rotateOpen = (open, off)=>{
      const n=open.length; if (!n) return [];
      const k=((off%n)+n)%n; return open.slice(k).concat(open.slice(0,k));
    };
    const reverseOpen = (open)=>open.slice().reverse();
    const sumSqDist = (aOpen, bOpen)=>{
      const n=aOpen.length; let s=0; for(let i=0;i<n;i++){ const p=aOpen[i], q=bOpen[i]; const dx=p[0]-q[0], dy=p[1]-q[1], dz=p[2]-q[2]; s+=dx*dx+dy*dy+dz*dz; } return s;
    };
    const bestAlignBtoA = (aClosed, bClosed) => {
      const aOpen = toOpenLoop(aClosed);
      let bOpen = toOpenLoop(bClosed);
      const n = aOpen.length; if (n === 0 || bOpen.length === 0) return bClosed;
      if (bOpen.length !== n) bOpen = resampleRing(bOpen, n);
      let best = { cost: +Infinity, off: 0, rev: false };
      // same orientation
      for (let off=0; off<n; off++){
        const cand = rotateOpen(bOpen, off);
        const cost = sumSqDist(aOpen, cand);
        if (cost < best.cost) best = { cost, off, rev: false };
      }
      // reversed orientation
      const bRev = reverseOpen(bOpen);
      for (let off=0; off<n; off++){
        const cand = rotateOpen(bRev, off);
        const cost = sumSqDist(aOpen, cand);
        if (cost < best.cost) best = { cost, off, rev: true };
      }
      const chosenOpen = best.rev ? rotateOpen(bRev, best.off) : rotateOpen(bOpen, best.off);
      return ensureClosed(chosenOpen);
    };

    // Build an aligned copy of loops across faces to avoid twisting
    const loopsAligned = loopsByFace.map(faceLoops => faceLoops.map(l => ({ ...l, pts: l.pts.slice() })));
    for (let i = 0; i < faces.length - 1; i++) {
      const lfA = loopsAligned[i] || [];
      const lfB = loopsAligned[i + 1] || [];
      const L = Math.min(lfA.length, lfB.length);
      for (let li = 0; li < L; li++) {
        try {
          const a = lfA[li].pts;
          const b = lfB[li].pts;
          if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) continue;
          lfB[li] = { ...lfB[li], pts: bestAlignBtoA(a, b) };
        } catch (_) { /* continue */ }
      }
    }

    const solid = new BREP.Solid();
    solid.name = this.inputParams.featureID || 'Loft';

    // Caps on first and last faces
    const addCapFromFace = (face, capNamePrefix, reverseStart) => {
      const groups = Array.isArray(face?.userData?.profileGroups) ? face.userData.profileGroups : null;
      if (groups && groups.length) {
        for (const g of groups) {
          const contour2D = g.contour2D || [];
          const holes2D = g.holes2D || [];
          const contourW = g.contourW || [];
          const holesW = g.holesW || [];
          if (contour2D.length < 3 || contourW.length !== contour2D.length) continue;
          const contourV2 = contour2D.map(p => new THREE.Vector2(p[0], p[1]));
          const holesV2 = holes2D.map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
          const tris = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);
          const allW = contourW.concat(...holesW);
          for (const t of tris) {
            const p0 = allW[t[0]], p1 = allW[t[1]], p2 = allW[t[2]];
            if (reverseStart) solid.addTriangle(`${capNamePrefix}_START`, p0, p2, p1);
            else solid.addTriangle(`${capNamePrefix}_END`, p0, p1, p2);
          }
        }
      } else {
        const baseGeom = face.geometry;
        const posAttr = baseGeom?.getAttribute?.('position');
        if (posAttr) {
          const idx = baseGeom.getIndex();
          const hasIndex = !!idx;
          const v = new THREE.Vector3();
          const world = new Array(posAttr.count);
          for (let i = 0; i < posAttr.count; i++) { v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(face.matrixWorld); world[i] = [v.x, v.y, v.z]; }
          const addTri = (i0, i1, i2) => {
            const p0 = world[i0], p1 = world[i1], p2 = world[i2];
            if (reverseStart) solid.addTriangle(`${capNamePrefix}_START`, p0, p2, p1);
            else solid.addTriangle(`${capNamePrefix}_END`, p0, p1, p2);
          };
          if (hasIndex) { for (let i = 0; i < idx.count; i += 3) addTri(idx.getX(i+0)>>>0, idx.getX(i+1)>>>0, idx.getX(i+2)>>>0); }
          else { for (let t = 0; t < (posAttr.count/3|0); t++) addTri(3*t+0, 3*t+1, 3*t+2); }
        }
      }
    };

    // Add start and end caps
    addCapFromFace(faces[0], `${faces[0].name || 'Face'}`, true);
    addCapFromFace(faces[faces.length - 1], `${faces[faces.length - 1].name || 'Face'}`, false);

    // Side walls: connect corresponding edges (1:1) between consecutive faces
    const loops0 = (loopsAligned[0] && loopsAligned[0].length) ? loopsAligned[0] : ((loopsByFace[0] && loopsByFace[0].length) ? loopsByFace[0] : getLoops(faces[0]).map(l => ({ ...l, pts: closeAndDedup(l.pts) })));

    // Order edges around the loop by connectivity; orient to follow boundary
    const pointKey = (p)=> `${p[0].toFixed(5)},${p[1].toFixed(5)},${p[2].toFixed(5)}`;
    const getOrderedOuterEdges = (face) => {
      const all = Array.isArray(face?.edges) ? face.edges.filter(Boolean) : [];
      // Prefer only outer-loop edges when flagged by SketchFeature
      const outers = all.filter(e => !e?.userData?.isHole);
      const list = (outers.length ? outers : all).map(e => ({ e, name: e?.name || 'EDGE', pts: collectEdgePolylineWorld(e) }));
      // Build adjacency via endpoints
      const nodes = new Map(); // key -> array of {idx, end:'start'|'end'}
      const startKey = []; const endKey = [];
      for (let i=0;i<list.length;i++){
        const pts = list[i].pts;
        if (!pts || pts.length < 2) continue;
        const a = pts[0], b = pts[pts.length-1];
        const ka = pointKey(a), kb = pointKey(b);
        startKey[i]=ka; endKey[i]=kb;
        if (!nodes.has(ka)) nodes.set(ka, []); nodes.get(ka).push({ idx:i, end:'start' });
        if (!nodes.has(kb)) nodes.set(kb, []); nodes.get(kb).push({ idx:i, end:'end' });
      }
      if (!list.length) return [];
      // Pick a start edge (arbitrary deterministic)
      let curIdx = 0; let curPts = list[curIdx].pts.slice();
      let curEnd = endKey[curIdx];
      const used = new Set([curIdx]);
      const ordered = [{ name:list[curIdx].name, pts:curPts }];
      let guard = 0;
      while (used.size < list.length && guard++ < list.length*2) {
        const cand = (nodes.get(curEnd) || []).filter(n => !used.has(n.idx));
        if (!cand.length) {
          // Heuristic: find nearest unvisited edge start/end to curEnd
          let best=null, bestD=+Infinity;
          const toVec = (k)=>{ const s=k.split(',').map(Number); return {x:s[0],y:s[1],z:s[2]}; };
          const C = toVec(curEnd);
          for (let i=0;i<list.length;i++){
            if (used.has(i)) continue;
            const a=list[i].pts[0], b=list[i].pts[list[i].pts.length-1];
            const dA=Math.hypot(a[0]-C.x,a[1]-C.y,a[2]-C.z);
            const dB=Math.hypot(b[0]-C.x,b[1]-C.y,b[2]-C.z);
            if (dA<bestD){ bestD=dA; best={idx:i, end:'start'}; }
            if (dB<bestD){ bestD=dB; best={idx:i, end:'end'}; }
          }
          if (!best) break;
          cand.push(best);
        }
        const next = cand[0];
        used.add(next.idx);
        let pts = list[next.idx].pts.slice();
        // Orient to connect from current end
        if (next.end === 'start') {
          // already starts at curEnd
        } else {
          pts = pts.slice().reverse();
        }
        ordered.push({ name:list[next.idx].name, pts });
        curEnd = pointKey(pts[pts.length-1]);
      }
      return ordered;
    };

    // Rotate ring so a vertex (if provided) lies on the first edge
    const rotateEdgesByRef = (ring, refObj) => {
      if (!refObj || !Array.isArray(ring) || ring.length===0) return ring;
      const pos = new THREE.Vector3();
      try { refObj.getWorldPosition(pos); } catch { return ring; }
      const rp = [pos.x,pos.y,pos.z];
      let bestI=0, bestD=+Infinity;
      for (let i=0;i<ring.length;i++){
        const pts = ring[i].pts; if (!pts || pts.length===0) continue;
        const p = pts[0];
        const d = (p[0]-rp[0])*(p[0]-rp[0])+(p[1]-rp[1])*(p[1]-rp[1])+(p[2]-rp[2])*(p[2]-rp[2]);
        if (d<bestD){bestD=d; bestI=i;}
      }
      return ring.slice(bestI).concat(ring.slice(0,bestI));
    };

    const reverseEdgeRing = (ring) => ring.slice().reverse().map(seg => ({ name: seg.name, pts: seg.pts.slice().reverse() }));

    const edgeRingMidpoints = (ring) => ring.map(seg => {
      const pts = seg.pts || []; if (pts.length===0) return [0,0,0];
      const a = pts[0], b = pts[pts.length-1]; return [(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];
    });
    const sumDist = (A,B)=>{ let s=0; for(let i=0;i<A.length;i++){ const p=A[i], q=B[i]; const dx=p[0]-q[0], dy=p[1]-q[1], dz=p[2]-q[2]; s += Math.hypot(dx,dy,dz); } return s; };
    const rotateRing = (ring, off)=>{ const n=ring.length; const k=((off%n)+n)%n; return ring.slice(k).concat(ring.slice(0,k)); };
    const bestAlignRings = (ringA, ringB) => {
      // Try both orientations; choose rotation minimizing mid-point distance
      const midA = edgeRingMidpoints(ringA);
      let best = { rev:false, off:0, cost:+Infinity };
      const tryOrient = (RB, rev) => {
        const midB = edgeRingMidpoints(RB);
        for (let off=0; off<RB.length; off++){
          const rotB = rotateRing(midB, off);
          const cost = sumDist(midA, rotB);
          if (cost < best.cost) best = { rev, off, cost };
        }
      };
      tryOrient(ringB, false);
      tryOrient(reverseEdgeRing(ringB), true);
      return best;
    };

    const resampleOpen = (poly, count) => {
      const n = poly.length; if (n===0) return [];
      if (n===count) return poly.slice();
      // cumulative lengths
      const L = new Array(n); L[0]=0;
      const seg = (a,b)=> Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
      for (let i=1;i<n;i++) L[i]=L[i-1]+seg(poly[i-1],poly[i]);
      const total = L[n-1]; if (total<=1e-12) return new Array(count).fill(0).map(()=> poly[0].slice());
      const out = new Array(count);
      let j=1;
      for (let k=0;k<count;k++){
        const s = (k/(count-1))*total;
        while (j<n && L[j] < s) j++;
        const a = poly[j-1], b = poly[j] || poly[n-1];
        const t = (s - L[j-1]) / Math.max(1e-12, (L[j]||total) - L[j-1]);
        out[k] = [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
      }
      return out;
    };

    // Build reference of start points (optional) to rotate rings
    const refNames = Array.isArray(this.inputParams?.referencePoints) ? this.inputParams.referencePoints : [];
    const scene = partHistory && partHistory.scene ? partHistory.scene : null;
    const refObjs = [];
    if (scene && refNames.length) {
      for (const nm of refNames) { try { refObjs.push(scene.getObjectByName(String(nm))); } catch { refObjs.push(null); } }
    }

    for (let i = 0; i < faces.length - 1; i++) {
      // Outer ring only for now
      let ringA = getOrderedOuterEdges(faces[i]);
      let ringB = getOrderedOuterEdges(faces[i+1]);
      if (!ringA.length || !ringB.length) continue;

      // Optional: rotate by user-picked reference vertex
      if (refObjs[i]) ringA = rotateEdgesByRef(ringA, refObjs[i]);
      if (refObjs[i+1]) ringB = rotateEdgesByRef(ringB, refObjs[i+1]);
      // Optional: reverse first ring order
      if (i === 0 && this.inputParams?.reverseFirstLoop) ringA = reverseEdgeRing(ringA);

      // Align ringB to ringA (orientation + rotation)
      const align = bestAlignRings(ringA, ringB);
      if (align.rev) ringB = reverseEdgeRing(ringB);
      ringB = rotateRing(ringB, align.off);

      const N = Math.min(ringA.length, ringB.length);
      const d2 = (a,b)=>{ const dx=a[0]-b[0], dy=a[1]-b[1], dz=a[2]-b[2]; return dx*dx+dy*dy+dz*dz; };
      const triArea2 = (p0,p1,p2)=>{
        const ux=p1[0]-p0[0], uy=p1[1]-p0[1], uz=p1[2]-p0[2];
        const vx=p2[0]-p0[0], vy=p2[1]-p0[1], vz=p2[2]-p0[2];
        const cx=uy*vz-uz*vy, cy=uz*vx-ux*vz, cz=ux*vy-uy*vx;
        return cx*cx+cy*cy+cz*cz;
      };
      const dedup = (arr)=>{ const out=[]; for(const p of (arr||[])){ const q=out[out.length-1]; if(!q||d2(q,p)>1e-18) out.push(p); } return out; };
      const triangulateStripNoResample = (Araw, Braw, isHole, name) => {
        const A = dedup(Araw), B = dedup(Braw);
        const m = A.length, n = B.length;
        if (m < 2 || n < 2) return;
        let i = 0, j = 0;
        const da = m - 1, db = n - 1;
        // Balanced Bresenham-style walk so steps distribute evenly from both ends
        if (da >= db) {
          let err = (da - db) / 2; // shift start so the switch is centered
          for (let step = 0; step < da; step++) {
            // A step
            const p0 = A[i], p1 = A[i + 1], p2 = B[j];
            if (triArea2(p0, p1, p2) > 1e-24) {
              if (isHole) solid.addTriangle(name, p0, p2, p1);
              else       solid.addTriangle(name, p0, p1, p2);
            }
            i++;
            err -= db;
            if (err < 0 && j < db) {
              // B step
              const q0 = A[i], q1 = B[j + 1], q2 = B[j];
              if (triArea2(q0, q1, q2) > 1e-24) {
                if (isHole) solid.addTriangle(name, q0, q1, q2);
                else       solid.addTriangle(name, q0, q2, q1);
              }
              j++;
              err += da;
            }
          }
          while (j < db) {
            const r0 = A[i], r1 = B[j + 1], r2 = B[j];
            if (triArea2(r0, r1, r2) > 1e-24) {
              if (isHole) solid.addTriangle(name, r0, r1, r2);
              else       solid.addTriangle(name, r0, r2, r1);
            }
            j++;
          }
        } else {
          let err = (db - da) / 2; // symmetric start for B-major
          for (let step = 0; step < db; step++) {
            // B step
            const p0 = A[i], p1 = B[j + 1], p2 = B[j];
            if (triArea2(p0, p1, p2) > 1e-24) {
              if (isHole) solid.addTriangle(name, p0, p1, p2);
              else       solid.addTriangle(name, p0, p2, p1);
            }
            j++;
            err -= da;
            if (err < 0 && i < da) {
              // A step
              const q0 = A[i], q1 = A[i + 1], q2 = B[j];
              if (triArea2(q0, q1, q2) > 1e-24) {
                if (isHole) solid.addTriangle(name, q0, q2, q1);
                else       solid.addTriangle(name, q0, q1, q2);
              }
              i++;
              err += db;
            }
          }
          while (i < da) {
            const r0 = A[i], r1 = A[i + 1], r2 = B[j];
            if (triArea2(r0, r1, r2) > 1e-24) {
              if (isHole) solid.addTriangle(name, r0, r2, r1);
              else       solid.addTriangle(name, r0, r1, r2);
            }
            i++;
          }
        }
      };
      for (let ei = 0; ei < N; ei++) {
        const a = ringA[ei];
        const b = ringB[ei];
        const fname = a.name || `${firstFace.name || 'FACE'}_LF`;
        triangulateStripNoResample(a.pts, b.pts, false, fname);
      }
    }

    try { solid.setEpsilon(1e-6); } catch {}
    solid.visualize();
    const effects = await BREP.applyBooleanOperation(partHistory || {}, solid, this.inputParams.boolean, this.inputParams.featureID);
    // Flag removals (sketch parents + boolean effects)
    try { for (const obj of [...removed, ...effects.removed]) { if (obj) obj.__removeFlag = true; } } catch {}
    // Return only artifacts to add
    return effects.added || [];
  }
}
