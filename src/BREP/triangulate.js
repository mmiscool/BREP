// CapOpenEndsNonMonotone.js
// ES6 module. Triangulates non-monotone boundary loops WITHOUT ear-clipping.
// Algorithm: Project loop to best-fit plane → y-monotone decomposition (sweep) → triangulate each monotone piece.
// Guarantees: uses ONLY the loop's original vertices (no simplification) to avoid T-junctions; watertight/manifold caps.

import * as THREE from 'three';

const EPS = 1e-12;

// ---------- Vector helpers ----------
function newellNormal(loop3D) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < loop3D.length; i++) {
    const p = loop3D[i], q = loop3D[(i + 1) % loop3D.length];
    nx += (p.y - q.y) * (p.z + q.z);
    ny += (p.z - q.z) * (p.x + q.x);
    nz += (p.x - q.x) * (p.y + q.y);
  }
  const n = new THREE.Vector3(nx, ny, nz);
  if (n.lengthSq() < EPS) {
    // fallback: first non-collinear triple
    for (let i = 0; i < loop3D.length; i++) {
      const a = loop3D[i], b = loop3D[(i + 1) % loop3D.length], c = loop3D[(i + 2) % loop3D.length];
      const v1 = new THREE.Vector3().subVectors(b, a);
      const v2 = new THREE.Vector3().subVectors(c, b);
      const t = new THREE.Vector3().crossVectors(v1, v2);
      if (t.lengthSq() > EPS) return t.normalize();
    }
    return new THREE.Vector3(0, 0, 1);
  }
  return n.normalize();
}
function buildLocalFrame(n) {
  const up = Math.abs(n.z) < 0.999 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(up, n).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v, n };
}
function projectTo2D(loop3D, u, v) {
  return loop3D.map(p => ({ x: p.dot(u), y: p.dot(v) }));
}
function areaSigned2D(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return 0.5 * a;
}
function isCCW(poly) { return areaSigned2D(poly) > 0; }
function orient(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

// ---------- Geometry / boundary detection ----------
function ensureIndexed(geometry) {
  if (!geometry.index) {
    // build a trivial index; we will not merge vertices to avoid changing boundary vertex set
    const pos = geometry.getAttribute('position');
    const index = new (pos.count > 65535 ? Uint32Array : Uint16Array)(pos.count);
    for (let i = 0; i < pos.count; i++) index[i] = i;
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }
  return geometry;
}
function edgeKey(a,b){ return a<b?`${a}:${b}`:`${b}:${a}`; }

function collectBoundaryLoops(geometry) {
  const idx = geometry.index.array;
  const pos = geometry.getAttribute('position');
  const counts = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i+1], c = idx[i+2];
    [[a,b],[b,c],[c,a]].forEach(([u,w])=>{
      const k = edgeKey(u,w);
      counts.set(k,(counts.get(k)||0)+1);
    });
  }
  // boundary edges appear exactly once
  const adj = new Map(); // vertex -> neighbors (boundary)
  for (const [k,c] of counts) {
    if (c === 1) {
      const [u,w] = k.split(':').map(Number);
      if (!adj.has(u)) adj.set(u,new Set());
      if (!adj.has(w)) adj.set(w,new Set());
      adj.get(u).add(w);
      adj.get(w).add(u);
    }
  }
  // walk loops
  const visitedE = new Set();
  const loops = [];
  const markEdge = (a,b)=>visitedE.add(`${a}>${b}`), seenEdge=(a,b)=>visitedE.has(`${a}>${b}`);
  for (const start of adj.keys()) {
    // try all incident edges
    for (const n of adj.get(start)) {
      if (seenEdge(start,n)) continue;
      const loop = [];
      let a = start, b = n;
      markEdge(a,b);
      loop.push(a);
      while (true) {
        loop.push(b);
        // choose the next neighbor of b that isn't a and boundary edge not visited
        const nbrs = Array.from(adj.get(b) || []);
        let cNext = undefined;
        for (const c of nbrs) {
          if (c === a) continue;
          if (!seenEdge(b,c)) { cNext = c; break; }
        }
        if (cNext === undefined) break;
        a = b; b = cNext; markEdge(a,b);
        if (b === loop[0]) break;
      }
      if (loop.length >= 3 && loop[0] === loop[loop.length-1]) loop.pop();
      if (loop.length >= 3) loops.push(loop);
    }
  }
  // return as arrays of vertex indices
  return loops;
}

// ---------- Monotone decomposition (Lee–Preparata) ----------
// We assume a simple polygon with unique vertices (no duplicates) and no self intersections.
// We do NOT remove collinear vertices.

function makeVertices(poly2D) {
  // annotate each vertex with indices of prev/next in circular list
  const n = poly2D.length;
  return poly2D.map((p,i)=>({
    x:p.x, y:p.y, i,
    prev:(i+n-1)%n,
    next:(i+1)%n
  }));
}

function above(p, q) { // p higher than q in sweep order (y descending, x tie by smaller)
  if (Math.abs(p.y - q.y) > EPS) return p.y > q.y;
  return p.x < q.x;
}

function vertexType(vs, i, ccw=true) {
  // Classify as start, end, split, merge, regular
  const v = vs[i], p = vs[v.prev], n = vs[v.next];

  const isHigherThanPrev = above(v, p);
  const isHigherThanNext = above(v, n);
  const isLowerThanPrev = above(p, v);
  const isLowerThanNext = above(n, v);

  const angleIsConvex = (ccw ? orient(p, v, n) > 0 : orient(p, v, n) < 0);

  if (isHigherThanPrev && isHigherThanNext) {
    // local maximum
    return angleIsConvex ? 'start' : 'split';
  }
  if (isLowerThanPrev && isLowerThanNext) {
    // local minimum
    return angleIsConvex ? 'end' : 'merge';
  }
  return 'regular';
}

function xAtYOfEdge(a, b, y) {
  if (Math.abs(a.y - b.y) < EPS) return Math.min(a.x, b.x); // horizontal; arbitrary pick min
  return a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
}

class StatusStructure {
  // Balanced tree substitute: we’ll keep a sorted array by x at current sweep y.
  // For typical cap loops (hundreds of verts) this is fine and simpler.
  constructor() { this.edges = []; this.y = Infinity; }
  setY(y) { this.y = y; this.sort(); }
  sort() {
    const y = this.y;
    this.edges.sort((e1,e2)=>{
      const x1 = xAtYOfEdge(e1.a, e1.b, y);
      const x2 = xAtYOfEdge(e2.a, e2.b, y);
      if (Math.abs(x1 - x2) > EPS) return x1 - x2;
      // tie-breaker by ids
      return e1.id - e2.id;
    });
  }
  insert(edge) { this.edges.push(edge); this.sort(); }
  remove(edge) {
    const k = this.edges.findIndex(e=>e.id===edge.id); if (k>=0) this.edges.splice(k,1);
  }
  leftOf(x) {
    // return edge strictly to the left of x (greatest x < x)
    let best = null, bestX = -Infinity;
    for (const e of this.edges) {
      const ex = xAtYOfEdge(e.a, e.b, this.y);
      if (ex < x - EPS && ex > bestX) { best = e; bestX = ex; }
    }
    return best;
  }
}

function monotoneDecompose(poly2D) {
  // Returns a list of diagonals (pairs of vertex indices) that decompose into y-monotone polygons.
  const n = poly2D.length;
  const vs = makeVertices(poly2D);

  const ccw = isCCW(poly2D); // sweep assumes CCW interior on left; handle both
  const order = [...vs].sort((a,b)=> {
    if (Math.abs(a.y - b.y) > EPS) return b.y - a.y; // descending y
    return a.x - b.x; // ascending x
  });

  const status = new StatusStructure();
  const helper = new Map(); // edge.id -> vertex index
  let edgeIdSeq = 1;

  function edgeOf(i, j) { // directed edge vi -> vj
    const a = vs[i], b = vs[j];
    return { a, b, id: edgeIdSeq++, i, j };
  }

  const diagonals = [];

  function addDiagonal(i, j) {
    if (i === j) return;
    diagonals.push([i, j]);
  }

  function addOrUpdateEdge(i, j, h) {
    const e = edgeOf(i, j);
    status.insert(e);
    if (h !== undefined) helper.set(e.id, h);
    return e;
  }

  function findEdgeLeftOf(x) {
    return status.leftOf(x);
  }

  for (const v of order) {
    status.setY(v.y + 1e-9); // slightly above v to order properly

    const t = vertexType(vs, v.i, ccw);

    if (t === 'start') {
      const e = addOrUpdateEdge(v.i, vs[v.next].i, v.i);
      // helper[e] = v
    }
    else if (t === 'end') {
      // check edge (prev, v)
      // find the edge whose (i -> v.i) exists in status: it’s the incoming edge from prev
      // We locate by scanning (small n), acceptable.
      let found = null, keyId = -1;
      for (const e of status.edges) {
        if (e.j === v.i) { found = e; keyId = e.id; break; }
      }
      if (found) {
        const h = helper.get(keyId);
        if (h !== undefined) {
          if (vertexType(vs, h, ccw) === 'merge') {
            addDiagonal(v.i, h);
          }
        }
        status.remove(found);
        helper.delete(keyId);
      }
    }
    else if (t === 'split') {
      // find left edge of v
      const eLeft = findEdgeLeftOf(v.x);
      if (!eLeft) {
        // degenerate; skip adding diagonal
      } else {
        const h = helper.get(eLeft.id);
        if (h !== undefined) addDiagonal(v.i, h);
        helper.set(eLeft.id, v.i);
      }
      // insert edge (v, next)
      const e = addOrUpdateEdge(v.i, vs[v.next].i, v.i);
    }
    else if (t === 'merge') {
      // handle incoming edge (prev, v)
      let incoming = null, incId = -1;
      for (const e of status.edges) {
        if (e.j === v.i) { incoming = e; incId = e.id; break; }
      }
      if (incoming) {
        const h = helper.get(incId);
        if (h !== undefined) addDiagonal(v.i, h);
        status.remove(incoming);
        helper.delete(incId);
      }
      // find left edge and check its helper
      const eLeft = findEdgeLeftOf(v.x);
      if (eLeft) {
        const h = helper.get(eLeft.id);
        if (h !== undefined && vertexType(vs, h, ccw) === 'merge') {
          addDiagonal(v.i, h);
        }
        helper.set(eLeft.id, v.i);
      }
    }
    else { // regular
      // Determine if interior lies to the left or right of the vertex
      // Using edge (prev -> v) orientation vs sweep direction
      const onLeftChain = above(vs[v.next], v); // if next is below, we are on left chain (descending along next)
      if (onLeftChain) {
        // like END
        let incoming = null, incId = -1;
        for (const e of status.edges) {
          if (e.j === v.i) { incoming = e; incId = e.id; break; }
        }
        if (incoming) {
          const h = helper.get(incId);
          if (h !== undefined && vertexType(vs, h, ccw) === 'merge') {
            addDiagonal(v.i, h);
          }
          status.remove(incoming);
          helper.delete(incId);
        }
        const e = addOrUpdateEdge(v.i, vs[v.next].i, v.i);
      } else {
        // like START side: connect to helper of left edge
        const eLeft = findEdgeLeftOf(v.x);
        if (eLeft) {
          const h = helper.get(eLeft.id);
          if (h !== undefined && vertexType(vs, h, ccw) === 'merge') {
            addDiagonal(v.i, h);
          }
          helper.set(eLeft.id, v.i);
        }
      }
    }
  }

  return diagonals;
}

// Split polygon by diagonals into monotone pieces (each as index cycle)
function buildPiecesFromDiagonals(loopIdxs, diagonals) {
  // Construct adjacency of a planar straight-line graph formed by original cycle + diagonals.
  // We then traverse faces that correspond to monotone pieces.
  const n = loopIdxs.length;
  const verts = loopIdxs.slice(); // indices into original mesh vertex buffer
  // map each local vertex i to its two neighbors (single cycle)
  const neighbors = new Map(); // localIndex -> Set of localIndices
  function addEdge(i,j) {
    if (!neighbors.has(i)) neighbors.set(i,new Set());
    if (!neighbors.has(j)) neighbors.set(j,new Set());
    neighbors.get(i).add(j);
    neighbors.get(j).add(i);
  }
  for (let i=0;i<n;i++){
    const a=i, b=(i+1)%n; addEdge(a,b);
  }
  for (const [a,b] of diagonals) addEdge(a,b);

  // Build all simple cycles (faces). We'll extract only inner faces (skip the outer).
  // Use half-edge traversal with angle sorting to walk around faces CCW.
  // For this we need embedded 2D positions; we’ll supply them at callsite.
  // Here we just produce an edge list; actual face extraction is done in triangulateByMonotone, which knows 2D pts.
  return { neighbors };
}

// Triangulate a single y-monotone polygon (given as sequence of local indices and its 2D coords)
function triangulateMonotonePiece(indices, pts) {
  // pts: array of {x,y} in local order (indices map to indices in this array)
  // Algorithm: sort vertices by y (desc), then use stack on left/right chains.
  // First, ensure the polygon is y-monotone and we have top/bottom.
  const n = indices.length;
  if (n < 3) return [];
  const poly = indices.map(i => pts[i]);

  // find top and bottom (max y and min y; break ties by x)
  let top = 0, bottom = 0;
  for (let k=1;k<n;k++){
    const p = poly[k], t = poly[top], b = poly[bottom];
    if (p.y > t.y + EPS || (Math.abs(p.y-t.y)<=EPS && p.x < t.x)) top = k;
    if (p.y < b.y - EPS || (Math.abs(p.y-b.y)<=EPS && p.x > b.x)) bottom = k;
  }

  // split into left/right chains walking from top to bottom along both directions
  const nextIdx = i => (i+1)%n, prevIdx = i => (i+n-1)%n;
  const left = []; const right = [];
  // walk clockwise from top to bottom
  let i = top;
  while (i !== bottom) { i = nextIdx(i); right.push(i); }
  // walk counter-clockwise
  i = top;
  while (i !== bottom) { i = prevIdx(i); left.push(i); }

  const chain = new Array(n).fill(''); // 'L' or 'R'
  chain[top] = 'L'; chain[bottom] = 'L';
  for (const k of left) chain[k]='L';
  for (const k of right) chain[k]='R';

  // sort vertices by y desc (x asc)
  const order = [];
  for (let k=0;k<n;k++) order.push(k);
  order.sort((a,b)=>{
    const A = poly[a], B = poly[b];
    if (Math.abs(A.y-B.y)>EPS) return B.y - A.y;
    return A.x - B.x;
  });

  const stack = [order[0], order[1]];
  const tris = [];

  for (let s=2; s<order.length-1; s++){
    const cur = order[s];
    if (chain[cur] !== chain[stack[stack.length-1]]) {
      // different chain: pop all and form fan
      for (let k=0; k<stack.length-1; k++){
        const a = stack[k], b = stack[k+1], c = cur;
        // ensure correct orientation (assume original polygon orientation)
        tris.push([indices[a], indices[b], indices[c]]);
      }
      stack.length = 0;
      stack.push(order[s-1], cur);
    } else {
      // same chain: pop while angle is convex
      let last = stack.pop();
      while (stack.length > 0) {
        const a = stack[stack.length-1], b = last, c = cur;
        const o = orient(poly[a], poly[b], poly[c]);
        // For CCW polygon, we keep making triangles while we have a "right turn" on left chain or "left turn" on right chain.
        const isConvex = (chain[cur]==='L') ? (o > EPS) : (o < -EPS);
        if (!isConvex) break;
        tris.push([indices[a], indices[b], indices[c]]);
        last = stack.pop();
      }
      stack.push(last, cur);
    }
  }
  // connect remaining
  const lastV = order[order.length-1];
  for (let k=0; k<stack.length-1; k++){
    const a = stack[k], b = stack[k+1], c = lastV;
    tris.push([indices[a], indices[b], indices[c]]);
  }
  return tris;
}

// Build monotone pieces (faces) from polygon + diagonals and triangulate them
function triangulateByMonotone(loop2D, diagonals) {
  // Build graph
  const localIdx = loop2D.map((_,i)=>i);
  const { neighbors } = buildPiecesFromDiagonals(localIdx, diagonals);

  // Convert neighbor graph into simple faces using angular sweep per vertex.
  // We’ll enumerate half-edges (u->v), and for each not yet visited, walk the face by always taking the next edge with smallest clockwise angle.
  const n = loop2D.length;
  const visitedHE = new Set();
  function heKey(u,v){return `${u}>${v}`;}

  // Precompute angle-sorted neighbors around each vertex
  const angNbrs = new Map();
  for (let i=0;i<n;i++){
    const p = loop2D[i];
    const nbrs = Array.from(neighbors.get(i)||[]);
    // sort by angle around p (atan2), clockwise from positive x
    nbrs.sort((a,b)=>{
      const va = {x: loop2D[a].x - p.x, y: loop2D[a].y - p.y};
      const vb = {x: loop2D[b].x - p.x, y: loop2D[b].y - p.y};
      const aa = Math.atan2(va.y, va.x);
      const ab = Math.atan2(vb.y, vb.x);
      return ab - aa; // descending = clockwise
    });
    angNbrs.set(i, nbrs);
  }

  const faces = [];

  for (let u=0; u<n; u++){
    const nbrs = angNbrs.get(u)||[];
    for (const v of nbrs) {
      const key = heKey(u,v);
      if (visitedHE.has(key)) continue;
      // start walking face keeping it on the left (CW next-edge rule as we sorted neighbors CW)
      const face = [];
      let a = u, b = v;
      while (true){
        visitedHE.add(heKey(a,b));
        face.push(a);
        // choose next edge at b: find a in its CW list, take the previous neighbor (turn right) to keep interior on left
        const list = angNbrs.get(b)||[];
        const k = list.indexOf(a);
        const nextIdx = (k - 1 + list.length) % list.length;
        const c = list[nextIdx];
        a = b; b = c;
        if (a === u && b === v) break;
        if (face.length > n + diagonals.length*2 + 5) break; // safety
      }
      if (face.length >= 3) {
        // Remove duplicate last if present
        if (face[0] === face[face.length-1]) face.pop();
        // Keep only inner faces: heuristic by signed area (same orientation as original polygon)
        const ar = areaSigned2D(face.map(i=>loop2D[i]));
        if (Math.abs(ar) > EPS) faces.push(face);
      }
    }
  }

  // Triangulate each face assuming it's monotone (by construction)
  const tris = [];
  for (const f of faces) {
    const t = triangulateMonotonePiece(f, loop2D);
    for (const tri of t) tris.push(tri);
  }
  return tris;
}

// ---------- End-to-end per loop ----------
function triangulateNonMonotoneLoop(loop3D, loopIdxMesh) {
  const n = loop3D.length;
  const normal = newellNormal(loop3D);
  const { u, v } = buildLocalFrame(normal);
  const loop2D = projectTo2D(loop3D, u, v);

  // Ensure polygon is CCW in (u,v) plane; if not, reverse consistently
  if (!isCCW(loop2D)) {
    loop2D.reverse();
    loopIdxMesh = loopIdxMesh.slice().reverse();
  }

  // Decompose into y-monotone pieces via diagonals (indices are local 0..n-1)
  const diagonals = monotoneDecompose(loop2D);

  // Triangulate all monotone pieces; triangles are local indices - map back to mesh indices
  const localTris = triangulateByMonotone(loop2D, diagonals);
  const meshTris = [];
  for (const [a,b,c] of localTris) {
    meshTris.push(loopIdxMesh[a], loopIdxMesh[b], loopIdxMesh[c]);
  }

  return { tris: meshTris, planeNormal: normal };
}

// ---------- Winding selection vs mesh outside ----------
function computeAverageBoundaryNormal(geometry, loopIdx) {
  const nAttr = geometry.getAttribute('normal');
  if (nAttr) {
    const acc = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (const i of loopIdx) {
      t.set(nAttr.getX(i), nAttr.getY(i), nAttr.getZ(i));
      acc.add(t);
    }
    if (acc.lengthSq() > EPS) return acc.normalize();
  }
  // fallback: Newell on loop positions
  const pos = geometry.getAttribute('position');
  const loop3D = loopIdx.map(i => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  return newellNormal(loop3D);
}

function addTrianglesToGeometry(geometry, trisToAppend) {
  const oldIndex = geometry.index.array;
  const ctor = oldIndex.constructor;
  const need32 = (oldIndex.length + trisToAppend.length) > 65535 && !(oldIndex instanceof Uint32Array);
  const finalCtor = need32 ? Uint32Array : ctor;
  const newIndex = new finalCtor(oldIndex.length + trisToAppend.length);
  newIndex.set(oldIndex, 0);
  newIndex.set(trisToAppend, oldIndex.length);
  geometry.setIndex(new THREE.BufferAttribute(newIndex, 1));
}

// ---------- Public API ----------
export function capOpenEndsNonMonotone(mesh, { recomputeNormals = true } = {}) {
  if (!mesh || !mesh.geometry) throw new Error('capOpenEndsNonMonotone: mesh with geometry is required.');
  const geometry = ensureIndexed(mesh.geometry);
  mesh.geometry = geometry;

  const pos = geometry.getAttribute('position');
  const loops = collectBoundaryLoops(geometry);
  if (loops.length === 0) return mesh;

  const allCapTris = [];

  for (const loopIdx of loops) {
    // gather 3D points
    const loop3D = loopIdx.map(i => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    const { tris, planeNormal } = triangulateNonMonotoneLoop(loop3D, loopIdx);

    if (tris.length === 0) {
      console.warn('capOpenEndsNonMonotone: triangulation produced no triangles for a loop (possibly self-intersecting).');
      continue;
    }

    // Choose winding so cap normal aligns with the "outside"
    const avgBoundaryNormal = computeAverageBoundaryNormal(geometry, loopIdx);
    const flip = planeNormal.dot(avgBoundaryNormal) < 0;

    if (flip) {
      for (let i=0;i<tris.length;i+=3){
        const a = tris[i], b = tris[i+1], c = tris[i+2];
        allCapTris.push(a, c, b);
      }
    } else {
      allCapTris.push(...tris);
    }
  }

  if (allCapTris.length) {
    addTrianglesToGeometry(geometry, allCapTris);
    if (recomputeNormals) geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return mesh;
}
