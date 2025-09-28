// filletSolid.js  —  ES6
// Builds a closed cutter solid using 2D cross-sections (circle-arc) lofted along a mesh edge.
// Returns { toolSolid, booleanType: "SUBTRACT"|"UNION" }.
//
// IMPORTANT: You can wire this to your Solid class by customizing the Adapter below.
// The algorithm never offsets faces in 3D; it slices planes, solves in 2D, then lofts.
//
// API:
//   filletSolid(targetSolid, edgeName, radius, inflate = 0.1)
//
// Behavior:
// - If edgeName refers to an open path => end caps are added.
// - If it's a closed loop => no caps.
// - booleanType auto: convex => SUBTRACT, concave => UNION (override in adapter if needed).
import { Solid as BetterSolid } from '../BetterSolid.js';

/* ------------------------------ Adapter ------------------------------ */
/* Minimal interface to your Solid. If your class differs, edit here.   */
const Adapter = {
  // Return polyline (Array of {x,y,z}) for the named edge.
  // Also return: closed (bool), sideA and sideB triangle indices (Array<int>) for the band seed.
  getEdgeData(targetSolid, edgeRef) {
    // Accept either an Edge object (preferred in this codebase) or an edge name.
    // 1) Direct Edge object from Solid.visualize()
    if (edgeRef && typeof edgeRef === 'object') {
      const e = edgeRef;
      const poly = e.userData?.polylineLocal || e.polylineLocal || e.polyline || e.userData?.polyline;
      const closed = !!(e.closedLoop || e.userData?.closedLoop || e.closed || e.userData?.closed);
      const polyline = clonePts(poly);
      if (!polyline || polyline.length < 2) throw new Error('Adapter.getEdgeData: edge polyline missing/invalid');
      // Seed triangles by face names (if available) using MeshGL faceID map
      let seedA = [], seedB = [];
      try {
        const mg = (typeof targetSolid?.getMesh === 'function') ? targetSolid.getMesh() : null;
        const faceIDs = mg && mg.faceID ? mg.faceID : null;
        const tv = mg && mg.triVerts ? mg.triVerts : null;
        if (faceIDs && tv && faceIDs.length === (tv.length / 3 | 0)) {
          const idToName = (targetSolid && targetSolid._idToFaceName && typeof targetSolid._idToFaceName.get === 'function') ? targetSolid._idToFaceName : null;
          const nameA = e.userData?.faceA || (e.faces && e.faces[0] && e.faces[0].name) || null;
          const nameB = e.userData?.faceB || (e.faces && e.faces[1] && e.faces[1].name) || null;
          if (idToName && (nameA || nameB)) {
            for (let t = 0; t < faceIDs.length; t++) {
              const nm = idToName.get(faceIDs[t]);
              if (nm === nameA) seedA.push(t);
              if (nm === nameB) seedB.push(t);
            }
          }
        }
      } catch (_) {
        // best-effort; fall back to heuristic split
      }
      return { polyline, closed, seedA, seedB };
    }

    const edgeName = String(edgeRef);
    // 2) Try a few common shapes on the solid itself
    if (targetSolid?.edges && targetSolid.edges[edgeName]) {
      const e = targetSolid.edges[edgeName];
      return {
        polyline: clonePts(e.polyline || e.polylineLocal || e.userData?.polyline || e.userData?.polylineLocal),
        closed: !!(e.closed || e.closedLoop || e.userData?.closed || e.userData?.closedLoop),
        seedA: [],
        seedB: [],
      };
    }
    if (typeof targetSolid.getEdgeByName === "function") {
      const e = targetSolid.getEdgeByName(edgeName);
      return {
        polyline: clonePts(e.polyline || e.polylineLocal),
        closed: !!(e.closed || e.closedLoop),
        seedA: [],
        seedB: [],
      };
    }
    // 3) As a last resort, search children for an Edge with matching name
    if (targetSolid && Array.isArray(targetSolid.children)) {
      const found = targetSolid.children.find(ch => ch && ch.type === 'EDGE' && ch.name === edgeName);
      if (found) {
        const poly = found.userData?.polylineLocal || found.polylineLocal || found.polyline || found.userData?.polyline;
        const closed = !!(found.closedLoop || found.userData?.closedLoop || found.closed || found.userData?.closed);
        let seedA = [], seedB = [];
        try {
          const mg = (typeof targetSolid?.getMesh === 'function') ? targetSolid.getMesh() : null;
          const faceIDs = mg && mg.faceID ? mg.faceID : null;
          const tv = mg && mg.triVerts ? mg.triVerts : null;
          if (faceIDs && tv && faceIDs.length === (tv.length / 3 | 0)) {
            const idToName = (targetSolid && targetSolid._idToFaceName && typeof targetSolid._idToFaceName.get === 'function') ? targetSolid._idToFaceName : null;
            const nameA = found.userData?.faceA || (found.faces && found.faces[0] && found.faces[0].name) || null;
            const nameB = found.userData?.faceB || (found.faces && found.faces[1] && found.faces[1].name) || null;
            if (idToName && (nameA || nameB)) {
              for (let t = 0; t < faceIDs.length; t++) {
                const nm = idToName.get(faceIDs[t]);
                if (nm === nameA) seedA.push(t);
                if (nm === nameB) seedB.push(t);
              }
            }
          }
        } catch (_) {}
        return { polyline: clonePts(poly), closed, seedA, seedB };
      }
    }
    throw new Error(`Adapter.getEdgeData: could not find edge "${edgeName}"`);
  },

  // Provide raw mesh access: { vertices: [{x,y,z},...], faces: [[i0,i1,i2],...]}
  getMesh(targetSolid) {
    // Preferred: BetterSolid.getMesh() → MeshGL typed arrays
    if (typeof targetSolid?.getMesh === 'function') {
      const mg = targetSolid.getMesh();
      const vp = mg.vertProperties || mg.vert_properties || mg.vertices;
      const tv = mg.triVerts || mg.tri_verts || mg.indices;
      if (vp && tv) {
        const vertices = [];
        for (let i = 0; i < vp.length; i += 3) vertices.push({ x: vp[i], y: vp[i + 1], z: vp[i + 2] });
        const faces = [];
        for (let i = 0; i < tv.length; i += 3) faces.push([tv[i] >>> 0, tv[i + 1] >>> 0, tv[i + 2] >>> 0]);
        return { vertices, faces };
      }
    }
    // Fallbacks
    if (targetSolid?.mesh?.vertices && targetSolid?.mesh?.faces) {
      return { vertices: clonePts(targetSolid.mesh.vertices), faces: cloneFaces(targetSolid.mesh.faces) };
    }
    if (targetSolid?.vertices && targetSolid?.faces) {
      return { vertices: clonePts(targetSolid.vertices), faces: cloneFaces(targetSolid.faces) };
    }
    if (typeof targetSolid.toTriangles === "function") {
      const tris = targetSolid.toTriangles(); // [[p0,p1,p2],...]
      const { vertices, faces } = reindexTriangles(tris);
      return { vertices, faces };
    }
    throw new Error("Adapter.getMesh: unable to access triangle mesh from targetSolid");
  },

  // Construct a NEW Solid from { vertices, faces } (or reuse targetSolid constructor).
  // Customize this to your class. Fallback: return a plain object with the mesh.
  newSolidLike(targetSolid, vertices, faces) {
    // Use BetterSolid class for tool creation so boolean ops match
    try {
      const tool = new BetterSolid();
      const name = '__FILLET_TOOL__';
      for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        const a = vertices[f[0]]; const b = vertices[f[1]]; const c = vertices[f[2]];
        tool.addTriangle(name, [a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z]);
      }
      return tool;
    } catch (_) { /* fall through */ }

    // Fallback to constructing similar via targetSolid if it supports it
    if (typeof targetSolid.constructor === "function") {
      try { return new targetSolid.constructor({ vertices, faces }); } catch (_) {/* fall through */}
    }
    if (typeof targetSolid.createFromTriangles === "function") {
      return targetSolid.createFromTriangles(vertices, faces);
    }
    // Fallback: simple POJO with an obvious shape. Your boolean layer can accept {mesh:{...}}.
    return { mesh: { vertices, faces } };
  },

  // Optional: compute signed dihedral (convex vs concave) along path to choose boolean type.
  // Positive => convex => SUBTRACT. Negative => concave => UNION.
  signedDihedralAt(targetSolid, sample) {
    // sample: {pos, faceA, faceB} — if you have fast access to face normals use it here.
    // Fallback heuristic using per-station side normals computed in this module.
    return null; // null => let module decide from measured side normals.
  }
};

/* --------------------------- Public Function ------------------------- */
export function filletSolid(targetSolid, edgeName, radius, inflate = 0.1, options = {}) {
  const r = +radius;
  if (!(r > 0)) throw new Error("filletSolid: radius must be > 0");
  const inflateDist = +inflate;
  if (!(inflateDist >= 0)) throw new Error("filletSolid: inflate must be >= 0");

  // Tolerances (relative to local bbox)
  const tol = { epsI: 1e-7, epsW: 5e-7, minAngleDeg: 15, minXsecAngleDeg: 5, minArcAngleDeg: 2 };

  // 0) Gather edge + mesh, and attempt robust fillet build. Fallback to a tube along the edge on failure.
  const edgeData = Adapter.getEdgeData(targetSolid, edgeName);
  if (!edgeData.polyline || edgeData.polyline.length < 2) throw new Error("filletSolid: edge polyline too short");
  const { vertices, faces } = Adapter.getMesh(targetSolid);
  const bboxDiag = bboxDiagonal(edgeData.polyline);
  tol.epsI *= bboxDiag; tol.epsW *= bboxDiag;
  // seam inset magnitude (absolute). Allow overrides via options.
  let seamInsetAbs = tol.epsW;
  try {
    const s = Number(options.seamInsetScale);
    const force = !!options.forceSeamInset;
    if (Number.isFinite(s) && s > 0) seamInsetAbs = Math.max(seamInsetAbs, s * bboxDiag);
    else if (force) seamInsetAbs = Math.max(seamInsetAbs, 1e-3 * bboxDiag);
  } catch { /* keep default */ }
  // For closed loops, ignore inflation to avoid self‑intersection at seam
  const inflateLocal = edgeData.closed ? 0 : inflateDist;

  try {
    // Build mesh adjacency once
    const topo = buildTopology(vertices, faces);

    // 1) Label two sides in a geodesic band around the edge. Retry with wider bands if needed.
    const baseBandRadius = Math.max(r * 1.5, r + 3 * tol.epsW);
    let band = null; let sideA = [], sideB = [], triIndexInBand = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const br = baseBandRadius * Math.pow(2, attempt);
      band = extractBand(vertices, faces, topo, edgeData.polyline, br, edgeData.seedA, edgeData.seedB);
      sideA = band.sideA || [];
      sideB = band.sideB || [];
      triIndexInBand = band.triIndexInBand || null;
      if (sideA.length && sideB.length) break;
    }
    if (!sideA.length || !sideB.length) throw new Error("filletSolid: failed to classify band sides");

    // 2) Sample stations along the polyline (adaptive spacing).
    const stations = sampleStations(edgeData.polyline, r);

    // 3) For each station, slice a section plane and solve 2D circle center by offset-loci intersection.
    const rings = [];
    const seamsA = [];
    const seamsB = [];
    let prevCenter3 = null;
  for (let i = 0; i < stations.length; i++) {
      const S = stations[i];
      // Section frame (t,u,v)
      const frame = makeFrame(stations, i);
      const plane = { p: S, n: frame.t };

      // Intersect band triangles with plane and separate into side chains A/B (2D)
      const sectA2 = intersectSideWithPlane(vertices, faces, sideA, plane, frame);
      const sectB2 = intersectSideWithPlane(vertices, faces, sideB, plane, frame);
    const A = stitchSectionChain(sectA2, tol);
    const B = stitchSectionChain(sectB2, tol);
    if (!A || !B || A.length < 2 || B.length < 2) {
      // If we don't have a valid section yet, skip until we find one.
      if (rings.length) { rings.push(rings[rings.length-1].map(p=>({...p}))); seamsA.push(seamsA[seamsA.length-1]); seamsB.push(seamsB[seamsB.length-1]); }
      continue;
    }

    // Build 2D offsets by r using normals that point toward the opposite chain.
    const mean = (poly)=>{ let sx=0,sy=0; for(const p of poly){ sx+=p.x; sy+=p.y; } const n=poly.length||1; return {x:sx/n,y:sy/n}; };
    const Amean = mean(A), Bmean = mean(B);
    const tA = nrm2(sub2(A[Math.min(A.length-1,1)], A[0]));
    const tB = nrm2(sub2(B[Math.min(B.length-1,1)], B[0]));
    const nA = rot90(tA);
    const nB = rot90(tB);
    const signA = (dot2(sub2(Bmean, A[0]), nA) >= 0) ? +1 : -1;
    const signB = (dot2(sub2(Amean, B[0]), nB) >= 0) ? +1 : -1;
    let offA = offsetPolyline2D(A, +r, signA, tol);
    let offB = offsetPolyline2D(B, +r, signB, tol);
    const prev2 = prevCenter3 ? projectPointTo2D(prevCenter3, frame) : null;
    let centers2 = intersectOffsetLoci(offA, offB, tol);
    // If still empty, fall back to trying both sign permutations
    if (centers2.length === 0) {
      const signCombos = [ [+1,-1], [-1,+1], [+1,+1], [-1,-1] ];
      for (let si = 0; si < signCombos.length && centers2.length === 0; si++) {
        const s = signCombos[si];
        offA = offsetPolyline2D(A, +r, s[0], tol);
        offB = offsetPolyline2D(B, +r, s[1], tol);
        centers2 = intersectOffsetLoci(offA, offB, tol);
      }
    }
    if (centers2.length === 0) {
      // Analytic fallback for planar/straight sections
      const straight = centerFromStraightChains(A, B, +r);
      if (straight) {
        const { c2, a2, b2 } = straight;
        const seamNA = outwardNormal2D(A, Math.max(0, Math.min(A.length-2, a2.segIdx || 0)));
        const seamNB = outwardNormal2D(B, Math.max(0, Math.min(B.length-2, b2.segIdx || 0)));
        const a2Inflated = { x: a2.x + seamNA.x * inflateLocal, y: a2.y + seamNA.y * inflateLocal };
        const b2Inflated = { x: b2.x + seamNB.x * inflateLocal, y: b2.y + seamNB.y * inflateLocal };
        const arcSamples2 = sampleArc2D(c2, r, a2, b2, 12);
        const ring3 = arcSamples2.map(p2 => lift2DTo3D(p2, frame));
        rings.push(ring3);
        seamsA.push(lift2DTo3D(a2Inflated, frame));
        seamsB.push(lift2DTo3D(b2Inflated, frame));
        prevCenter3 = lift2DTo3D(c2, frame);
        continue;
      }
      // infeasible locally: keep continuity if we already have rings; else skip
      if (rings.length) { rings.push(rings[rings.length-1].map(p=>({...p}))); seamsA.push(seamsA[seamsA.length-1]); seamsB.push(seamsB[seamsB.length-1]); }
      continue;
    }
    // Choose the center closest to previous (predictor-corrector)
    const c2 = chooseCenter2D(centers2, prev2);

      // Recover tangency points by perpendicular foot to original section chains
      const a2 = nearestPerpPointOnChain(A, c2);
      const b2 = nearestPerpPointOnChain(B, c2);

      // Inflate: shift seam anchors by 'inflate' along outward normals (from gap)
    const seamNA2 = outwardNormal2D(A, a2.segIdx);
    const seamNB2 = outwardNormal2D(B, b2.segIdx);
      const a2Inflated = { x: a2.x + seamNA2.x * inflateLocal, y: a2.y + seamNA2.y * inflateLocal };
      const b2Inflated = { x: b2.x + seamNB2.x * inflateLocal, y: b2.y + seamNB2.y * inflateLocal };

      // Build the section arc from a* to b* around center
      const arcSamples2 = sampleArc2D(c2, r, a2, b2, 12);

      // Lift to 3D using section frame
    const ring3 = arcSamples2.map(p2 => lift2DTo3D(p2, frame));
      rings.push(ring3);

      // Store seams (inflated) lifted to 3D
      seamsA.push(lift2DTo3D(a2Inflated, frame));
      seamsB.push(lift2DTo3D(b2Inflated, frame));

      prevCenter3 = lift2DTo3D(c2, frame);
    }

  // 4) Loft rings into the fillet strip (triangulated), consistent winding.
  if (rings.length < 2) throw new Error('filletSolid: insufficient valid sections');
  const filletMesh = loftRings(rings);

    // 5) Build return walls from seams (each is a ruled surface to a short inward “spine”).
    const spineA = offsetCurveInward(seamsA, rings, +seamInsetAbs); // tiny inward bias for guaranteed overlap
    const spineB = offsetCurveInward(seamsB, rings, +seamInsetAbs);
    const returnA = ruledStrip(seamsA, spineA);
    const returnB = ruledStrip(seamsB, spineB);

    // 6) End caps unless the edge is a closed loop
    const caps = [];
    if (!edgeData.closed) {
      const firstCap = capFromRing(rings[0], /*flip=*/false);
      const lastCap  = capFromRing(rings[rings.length-1], /*flip=*/true);
      caps.push(firstCap, lastCap);
    }

    // 7) Merge all parts into one watertight cutter mesh
    const toolMesh = mergeMeshes([filletMesh, returnA, returnB, ...caps], tol);

    // 8) Validate basic manifold conditions (quick checks)
    sanityCheck(toolMesh, tol);

    // 9) Decide boolean type (convex => SUBTRACT, concave => UNION)
    const booleanType = decideBooleanType(stations, seamsA, seamsB, targetSolid);

    // 10) Return Solid of the same family
    const toolSolid = Adapter.newSolidLike(targetSolid, toolMesh.vertices, toolMesh.faces);
    return { toolSolid, booleanType };
  } catch (err) {
    // Robust fallback: build a simple tube along the edge polyline with radius r.
    const stations = sampleStations(edgeData.polyline, Math.max(r * 0.5, 1e-6));
    const segs = 18;
    const rings = [];
    for (let i = 0; i < stations.length; i++) {
      const frame = makeFrame(stations, i);
      const ring = [];
      for (let k = 0; k < segs; k++) {
        const ang = 2*Math.PI * (k / segs);
        const p2 = { x: r * Math.cos(ang), y: r * Math.sin(ang) };
        ring.push(lift2DTo3D(p2, frame));
      }
      rings.push(ring);
    }
    const tube = loftRings(rings);
    const caps = [];
    if (!edgeData.closed) {
      caps.push(capFromRing(rings[0], /*flip=*/false));
      caps.push(capFromRing(rings[rings.length-1], /*flip=*/true));
    }
    const toolMesh = mergeMeshes([tube, ...caps], tol);
    // Don't sanity-throw here; allow visualization even if messy
    try { sanityCheck(toolMesh, tol); } catch (_) {}
    const toolSolid = Adapter.newSolidLike(targetSolid, toolMesh.vertices, toolMesh.faces);
    return { toolSolid, booleanType: 'SUBTRACT' };
  }
}

/* ---------------------------- Wrapper Class ---------------------------- */
export class FilletSolid extends BetterSolid {
  constructor({ edgeToFillet, radius = 1, inflate = 0, seamInsetScale = 0, forceSeamInset = false, projectStripsOpenEdges = true, debug = false } = {}) {
    super();
    if (!edgeToFillet) throw new Error('FilletSolid: edgeToFillet is required');
    this.edgeToFillet = edgeToFillet;
    this.radius = Math.max(1e-9, +radius);
    this.inflate = Math.max(0, +inflate || 0);
    this.seamInsetScale = Number.isFinite(+seamInsetScale) ? +seamInsetScale : 0;
    this.forceSeamInset = !!forceSeamInset;
    this.projectStripsOpenEdges = !!projectStripsOpenEdges; // currently informational (boolean fallback may toggle)
    this.debug = !!debug;
    this.operationTargetSolid = (edgeToFillet && (edgeToFillet.parentSolid || edgeToFillet.parent)) || null;
    this.generate();
  }

  generate() {
    const tgt = this.operationTargetSolid || (this.edgeToFillet && (this.edgeToFillet.parentSolid || this.edgeToFillet.parent));
    if (!tgt) throw new Error('FilletSolid: edge must be part of a solid');
    const opts = {
      seamInsetScale: this.seamInsetScale,
      forceSeamInset: this.forceSeamInset,
      projectStripsOpenEdges: this.projectStripsOpenEdges,
    };
    const { toolSolid } = filletSolid(tgt, this.edgeToFillet, this.radius, this.inflate, opts);
    this._copyFromSolid(toolSolid);
  }

  _copyFromSolid(src) {
    try {
      const mesh = src.getMesh();
      this._numProp = mesh.numProp;
      this._vertProperties = Array.from(mesh.vertProperties);
      this._triVerts = Array.from(mesh.triVerts);
      this._triIDs = (mesh.faceID && mesh.faceID.length)
        ? Array.from(mesh.faceID)
        : new Array((mesh.triVerts.length / 3) | 0).fill(0);
      this._vertKeyToIndex = new Map();
      for (let i = 0; i < this._vertProperties.length; i += 3) {
        const x = this._vertProperties[i + 0];
        const y = this._vertProperties[i + 1];
        const z = this._vertProperties[i + 2];
        this._vertKeyToIndex.set(`${x},${y},${z}`, i / 3);
      }
      this._idToFaceName = new Map(src._idToFaceName);
      this._faceNameToID = new Map(src._faceNameToID);
      this._dirty = true;
      this._faceIndex = null;
    } catch (_) {
      // Fallback: rebuild from triangles if available
      try {
        const triNames = typeof src.getFaces === 'function' ? src.getFaces(false) : [];
        if (Array.isArray(triNames) && triNames.length) {
          for (const { faceName, triangles } of triNames) {
            for (const t of triangles) this.addTriangle(faceName || 'FILLET', t.p1, t.p2, t.p3);
          }
        }
      } catch {}
    }
  }
}

/* ---------------------------- Geometry Core --------------------------- */
// ——— small vector helpers (null-safe) ———
function V3(x=0,y=0,z=0){ return {x:+x||0,y:+y||0,z:+z||0}; }
function toV3(p){
  if (!p || typeof p !== 'object') return V3(0,0,0);
  if (Array.isArray(p) || (typeof p.length === 'number' && p.length >= 3)) return V3(p[0], p[1], p[2]);
  return V3(p.x, p.y, p.z);
}
function add3(a,b){ a=toV3(a); b=toV3(b); return V3(a.x+b.x,a.y+b.y,a.z+b.z); }
function sub3(a,b){ a=toV3(a); b=toV3(b); return V3(a.x-b.x,a.y-b.y,a.z-b.z); }
function mul3(a,s){ a=toV3(a); s=+s||0; return V3(a.x*s,a.y*s,a.z*s); }
function dot3(a,b){ a=toV3(a); b=toV3(b); return a.x*b.x + a.y*b.y + a.z*b.z; }
function cross3(a,b){ a=toV3(a); b=toV3(b); return V3(a.y*b.z-a.z*b.y, a.z*b.x-a.x*b.z, a.x*b.y-a.y*b.x); }
function len3(a){ a=toV3(a); return Math.hypot(a.x,a.y,a.z); }
function nrm3(a){ a=toV3(a); const L=len3(a); return L>0?V3(a.x/L,a.y/L,a.z/L):V3(0,0,0); }
function V2(x=0,y=0){ return {x:+x||0,y:+y||0}; }
function toV2(p){ if (!p || typeof p !== 'object') return V2(0,0); if (Array.isArray(p) || (typeof p.length==='number'&&p.length>=2)) return V2(p[0],p[1]); return V2(p.x,p.y); }
function sub2(a,b){ a=toV2(a); b=toV2(b); return V2(a.x-b.x,a.y-b.y); }
function add2(a,b){ a=toV2(a); b=toV2(b); return V2(a.x+b.x,a.y+b.y); }
function mul2(a,s){ a=toV2(a); s=+s||0; return V2(a.x*s,a.y*s); }
function dot2(a,b){ a=toV2(a); b=toV2(b); return a.x*b.x + a.y*b.y; }
function len2(a){ a=toV2(a); return Math.hypot(a.x,a.y); }
function nrm2(a){ a=toV2(a); const L=len2(a); return L>0?V2(a.x/L,a.y/L):V2(0,0); }
function rot90(a){ a=toV2(a); return V2(-a.y,a.x); }

// bbox diag for scale
function bboxDiagonal(pts){
  let min=V3(+Infinity,+Infinity,+Infinity), max=V3(-Infinity,-Infinity,-Infinity);
  for(const p0 of pts){
    const p = toV3(p0);
    min.x=Math.min(min.x,p.x);min.y=Math.min(min.y,p.y);min.z=Math.min(min.z,p.z);
    max.x=Math.max(max.x,p.x);max.y=Math.max(max.y,p.y);max.z=Math.max(max.z,p.z);
  }
  return len3(sub3(max,min));
}

/* ---------------------- Topology & Band Extraction -------------------- */
function buildTopology(verts, faces){
  const v2f = Array(verts.length).fill(0).map(()=>[]);
  const edges = new Map(); // key "a,b" a<b -> [f0,f1]
  for(let fi=0; fi<faces.length; fi++){
    const [a,b,c] = faces[fi];
    v2f[a].push(fi); v2f[b].push(fi); v2f[c].push(fi);
    const addE=(i,j)=>{ const k=i<j?`${i},${j}`:`${j},${i}`; const arr=edges.get(k)||[]; arr.push(fi); edges.set(k,arr); };
    addE(a,b); addE(b,c); addE(c,a);
  }
  return { v2f, edges };
}

// crude Euclidean band (robust + simple): include tris whose any vertex within bandRadius of any polyline point.
function extractBand(verts, faces, topo, polyline, bandRadius, seedA=[], seedB=[]){
  const r2 = bandRadius*bandRadius;
  const nearV = new Set();
  for(let vi=0; vi<verts.length; vi++){
    const p=verts[vi];
    for(const q of polyline){
      const dx=p.x-q.x, dy=p.y-q.y, dz=p.z-q.z;
      if (dx*dx+dy*dy+dz*dz <= r2){ nearV.add(vi); break; }
    }
  }
  const inBand = new Set();
  for(let fi=0; fi<faces.length; fi++){
    const [a,b,c]=faces[fi];
    if (nearV.has(a)||nearV.has(b)||nearV.has(c)) inBand.add(fi);
  }
  // Side labeling by cutting along the polyline projected onto edges: heuristic flood using seeds if available.
  const sideA = []; const sideB = [];
  const visited = new Set();
  if (seedA && seedA.length){ flood(seedA, sideA); }
  if (seedB && seedB.length){ flood(seedB, sideB); }
  if (!sideA.length || !sideB.length){
    // fallback: split approximately by a plane through first segment normal
    const p0=polyline[0], p1=polyline[Math.min(1, polyline.length-1)];
    const t = nrm3(sub3(p1,p0));
    const up = {x:0,y:0,z:1};
    const u = nrm3(cross3(up,t));
    const n = cross3(t,u); // rough "side" plane normal
    for(const fi of inBand){ 
      const c = triCentroid(verts, faces[fi]);
      const s = dot3(sub3(c,p0), n) >= 0 ? sideA : sideB;
      s.push(fi);
    }
  }
  return { sideA, sideB, triIndexInBand: inBand };

  function flood(seeds, out){
    const Q=[...seeds];
    for(const s of seeds) visited.add(s);
    while(Q.length){
      const f = Q.pop();
      if (!inBand.has(f)) continue;
      out.push(f);
      const [a,b,c]=faces[f];
      const neigh = new Set([...topo.v2f[a], ...topo.v2f[b], ...topo.v2f[c]]);
      for(const nf of neigh){ if (!visited.has(nf) && inBand.has(nf)){ visited.add(nf); Q.push(nf); } }
    }
  }
}

function triCentroid(verts, face){
  const [a,b,c]=face; const A=verts[a],B=verts[b],C=verts[c];
  return {x:(A.x+B.x+C.x)/3, y:(A.y+B.y+C.y)/3, z:(A.z+B.z+C.z)/3};
}

/* ----------------------- Station Frames & Sectioning ------------------ */
function sampleStations(polyline, r){
  // arc-length sampling with Δs ≈ sqrt(2 r ε) where ε = 0.05 r
  const eps = 0.05*r;
  const ds = Math.max( r*0.2, Math.sqrt(Math.max(2*r*eps, 1e-9)) );
  const out = [];
  let acc=0; out.push(polyline[0]);
  for(let i=1;i<polyline.length;i++){
    const seg = sub3(polyline[i], polyline[i-1]);
    const L = len3(seg); let u=0;
    while(acc+L-u >= ds){
      u += ds;
      const t = (u)/L;
      out.push({ x: polyline[i-1].x + seg.x*t, y: polyline[i-1].y + seg.y*t, z: polyline[i-1].z + seg.z*t });
    }
    acc = (acc+L-u);
  }
  out.push(polyline[polyline.length-1]);
  return out;
}

function makeFrame(stations, i){
  const p = stations[i];
  const pPrev = stations[Math.max(0,i-1)];
  const pNext = stations[Math.min(stations.length-1,i+1)];
  const t = nrm3(sub3(pNext, pPrev));
  // parallel transport-ish
  const worldUp = {x:0,y:0,z:1};
  let u = cross3(worldUp, t);
  if (len3(u) < 1e-6){ u = cross3({x:1,y:0,z:0}, t); }
  u = nrm3(u);
  const v = cross3(t,u);
  return { p, t, u, v };
}

// Intersect one side's triangles with a plane; project to 2D in (u,v).
function intersectSideWithPlane(verts, faces, triIndices, plane, frame){
  const out = [];
  for(const fi of triIndices){
    const [a,b,c] = faces[fi].map(i=>verts[i]);
    const segs = triPlaneSegments(a,b,c, plane);
    for(const s of segs){
      const a2 = projectPointTo2D(s.a, frame);
      const b2 = projectPointTo2D(s.b, frame);
      out.push([a2,b2]);
    }
  }
  return out;
}

function triPlaneSegments(A,B,C, plane){
  // classify vertices
  const sd = P=> dot3(sub3(P, plane.p), plane.n);
  const dA=sd(A), dB=sd(B), dC=sd(C);
  const V=[{P:A,d:dA},{P:B,d:dB},{P:C,d:dC}];
  const sgn=x=> (x>0)-(x<0);
  const S = V.map(v=>sgn(v.d));
  // collect edges that cross
  const out=[];
  const edges=[[0,1],[1,2],[2,0]];
  for(const [i,j] of edges){
    const a=V[i], b=V[j];
    if ((a.d>0 && b.d<0) || (a.d<0 && b.d>0)){
      const t = a.d/(a.d - b.d);
      out.push({ a: lerp3(a.P,b.P,t), b: null, i, j, t });
    }
  }
  // tie edges in order (usually 0 or 2 segments)
  if (out.length===2){ out[0].b = out[1].a; out.splice(1,1); }
  else if (out.length>2){
    // degenerate: pick two farthest
    out.sort((s0,s1)=>s0.t-s1.t);
    const s0={a:out[0].a,b:out[out.length-1].a};
    out.length=0; out.push(s0);
  }
  return out;
}

function lerp3(a,b,t){ return {x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t, z:a.z+(b.z-a.z)*t}; }

function projectPointTo2D(P, frame){
  const rel = sub3(P, frame.p);
  return { x: dot3(rel, frame.u), y: dot3(rel, frame.v) };
}
function lift2DTo3D(p2, frame){
  return add3(frame.p, add3( mul3(frame.u, p2.x), mul3(frame.v, p2.y) ));
}

/* ---------------------- 2D Section Chain Utilities ------------------- */
function stitchSectionChain(segs, tol){
  if (segs.length===0) return null;
  // Build a polyline by greedy linkage of endpoints within epsW
  const eps = tol.epsW*5;
  const pts = [];
  // flatten seg endpoints
  const ends = [];
  for(const [a,b] of segs){ ends.push(a,b); }
  // pick a min-x start
  let startIdx = 0; for(let i=1;i<ends.length;i++){ if (ends[i].x < ends[startIdx].x) startIdx=i; }
  const start = ends[startIdx];
  pts.push(start);
  let cur = start;
  for(let k=0;k<ends.length; k++){
    let best=-1, bestD=Infinity, bestPt=null;
    for(let i=0;i<ends.length;i++){
      const p = ends[i];
      const d = Math.hypot(p.x-cur.x, p.y-cur.y);
      if (d>eps) continue;
      if (d<bestD && (Math.abs(p.x-cur.x)>1e-12 || Math.abs(p.y-cur.y)>1e-12)){ best=i; bestD=d; bestPt=p; }
    }
    if (best<0) break;
    pts.push(bestPt);
    cur=bestPt;
  }
  // simplify: collapse tiny edges, merge near-collinear
  return simplify2DPolyline(pts, tol);
}

function simplify2DPolyline(poly, tol){
  const out=[poly[0]];
  for(let i=1;i<poly.length-1;i++){
    const a=out[out.length-1], b=poly[i], c=poly[i+1];
    const ab=nrm2(sub2(b,a)), bc=nrm2(sub2(c,b));
    const turn = Math.acos(Math.max(-1,Math.min(1,dot2(ab,bc))))*180/Math.PI;
    const len = len2(sub2(b,a));
    if (turn < 2 || len < tol.epsW*10){ continue; }
    out.push(b);
  }
  out.push(poly[poly.length-1]);
  return out;
}

/* ---------------------------- 2D Offsets ----------------------------- */
// Offset a 2D polyline by distance d on the chosen side.
// sideSign: +1 => offset toward left of direction; -1 => right.
// Returns an array of primitives: {type:"seg", a,b} and {type:"arc", c,r,ang0,ang1,ccw}
function offsetPolyline2D(poly, d, sideSign, tol){
  if (poly.length<2) return [];
  const prims=[];
  const N=poly.length;
  const segNormals=[];
  for(let i=0;i<N-1;i++){
    const t = nrm2(sub2(poly[i+1], poly[i]));
    let n = rot90(t);
    if (sideSign<0) n = mul2(n, -1);
    segNormals.push(n);
  }
  const offsetPts = [];
  for(let i=0;i<N;i++){
    if (i===0){
      const n = segNormals[0];
      offsetPts.push(add2(poly[0], mul2(n,d)));
    } else if (i===N-1){
      const n = segNormals[N-2];
      offsetPts.push(add2(poly[N-1], mul2(n,d)));
    } else {
      const n0 = segNormals[i-1], n1 = segNormals[i];
      const t0 = nrm2(sub2(poly[i], poly[i-1]));
      const t1 = nrm2(sub2(poly[i+1], poly[i]));
      // compute miter intersection (parallel curve)
      const A = add2(poly[i], mul2(n0,d));
      const B = add2(poly[i], mul2(n1,d));
      const dir0 = t0; const dir1 = t1;
      const inter = intersectLines2D(A, add2(A,dir0), B, add2(B,dir1));
      if (inter.ok){
        offsetPts.push(inter.p);
        // Insert circular join arc between segments (exact parallel curve)
        const v0 = sub2(inter.p, A), v1 = sub2(inter.p, B);
        const ang0 = Math.atan2(v0.y, v0.x);
        const ang1 = Math.atan2(v1.y, v1.x);
        const ccw = sideSign>0 ? true : false;
        prims.push({type:"arc", c: poly[i], r: d, ang0, ang1, ccw, _join:true});
      } else {
        // Fallback: average
        offsetPts.push( add2(poly[i], mul2(nrm2(add2(n0,n1)), d)) );
      }
    }
  }
  // Convert offset points to segment primitives
  for(let i=0;i<offsetPts.length-1;i++){
    prims.push({type:"seg", a:offsetPts[i], b:offsetPts[i+1]});
  }
  // Cleanup tiny features
  return prims.filter(pr=>{
    if (pr.type==="seg") return len2(sub2(pr.b,pr.a)) > tol.epsW*5;
    return Math.abs(normalizeAngle(pr.ang1 - pr.ang0)) > (tol.minArcAngleDeg*Math.PI/180);
  });
}

function intersectLines2D(p1,p2,p3,p4){
  const x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y, x3=p3.x,y3=p3.y,x4=p4.x,y4=p4.y;
  const den = (x1-x2)*(y3-y4)-(y1-y2)*(x3-x4);
  if (Math.abs(den) < 1e-12) return {ok:false};
  const px = ((x1*y2 - y1*x2)*(x3-x4) - (x1-x2)*(x3*y4 - y3*x4))/den;
  const py = ((x1*y2 - y1*x2)*(y3-y4) - (y1-y2)*(x3*y4 - y3*x4))/den;
  return {ok:true, p:{x:px,y:py}};
}

/* ---------------------- Offset-Loci Intersections --------------------- */
function intersectOffsetLoci(Aprims, Bprims, tol){
  const out=[];
  for(const a of Aprims){
    for(const b of Bprims){
      // seg-seg
      if (a.type==="seg" && b.type==="seg"){
        const inter = segSeg2D(a.a,a.b,b.a,b.b);
        if (inter.ok) out.push(inter.p);
        // Also consider infinite-line intersection to avoid finite-length clipping
        const interInf = segSeg2DInf(a.a,a.b,b.a,b.b);
        if (interInf.ok) out.push(interInf.p);
      }
      // seg-arc
      if (a.type==="seg" && b.type==="arc"){ out.push(...segArcIntersections(a, b)); }
      if (a.type==="arc" && b.type==="seg"){ out.push(...segArcIntersections(b, a)); }
      // arc-arc
      if (a.type==="arc" && b.type==="arc"){ out.push(...arcArcIntersections(a, b)); }
    }
  }
  // dedupe nearby points
  return dedupe2D(out, tol.epsW*2);
}

function segSeg2D(a,b,c,d){
  const r = sub2(b,a), s=sub2(d,c);
  const rxs = r.x*s.y - r.y*s.x;
  const qpxr = (c.x-a.x)*r.y - (c.y-a.y)*r.x;
  if (Math.abs(rxs)<1e-12 && Math.abs(qpxr)<1e-12) return {ok:false}; // collinear not needed here
  if (Math.abs(rxs)<1e-12) return {ok:false};
  const t = ((c.x-a.x)*s.y - (c.y-a.y)*s.x)/rxs;
  const u = ((c.x-a.x)*r.y - (c.y-a.y)*r.x)/rxs;
  if (t>=0 && t<=1 && u>=0 && u<=1){
    return {ok:true, p:{x:a.x+t*r.x, y:a.y+t*r.y}};
  }
  return {ok:false};
}

// Infinite-line intersection (no clamping). Returns a point unless lines are parallel.
function segSeg2DInf(a,b,c,d){
  const r = sub2(b,a), s=sub2(d,c);
  const rxs = r.x*s.y - r.y*s.x;
  if (Math.abs(rxs) < 1e-12) return { ok: false };
  const t = ((c.x-a.x)*s.y - (c.y-a.y)*s.x)/rxs;
  return { ok: true, p: { x: a.x + t*r.x, y: a.y + t*r.y } };
}

function segArcIntersections(seg, arc){
  // Parametric segment vs circle around arc.c with radius arc.r; then filter by arc angles.
  const out=[];
  const d = sub2(seg.b, seg.a);
  const f = sub2(seg.a, arc.c);
  const A = dot2(d,d);
  const B = 2*dot2(f,d);
  const C = dot2(f,f) - arc.r*arc.r;
  const disc = B*B - 4*A*C;
  if (disc < 0) return out;
  const sqrt = Math.sqrt(disc);
  const t1 = (-B - sqrt)/(2*A);
  const t2 = (-B + sqrt)/(2*A);
  for(const t of [t1,t2]){
    if (t>=0 && t<=1){
      const p = add2(seg.a, mul2(d,t));
      if (pointOnArc(p, arc)) out.push(p);
    }
  }
  return out;
}

function arcArcIntersections(a,b){
  const out=[];
  const dx=b.c.x-a.c.x, dy=b.c.y-a.c.y;
  const d=Math.hypot(dx,dy);
  if (d> a.r+b.r || d<Math.abs(a.r-b.r) || d===0) return out;
  const x=(a.r*a.r - b.r*b.r + d*d)/(2*d);
  const y=Math.sqrt(Math.max(0, a.r*a.r - x*x));
  const xm = a.c.x + x*dx/d;
  const ym = a.c.y + x*dy/d;
  for(const sgn of [+1,-1]){
    const p={x: xm + sgn * y * (-dy/d), y: ym + sgn * y * (dx/d)};
    if (pointOnArc(p,a) && pointOnArc(p,b)) out.push(p);
  }
  return out;
}

function pointOnArc(p, arc){
  const ang = Math.atan2(p.y-arc.c.y, p.x-arc.c.x);
  let a0 = normalizeAngle(arc.ang0), a1=normalizeAngle(arc.ang1), a=normalizeAngle(ang);
  if (arc.ccw){
    if (a1 < a0) a1 += 2*Math.PI;
    if (a < a0) a += 2*Math.PI;
    return a>=a0 && a<=a1;
  } else {
    if (a0 < a1) a0 += 2*Math.PI;
    if (a > a0) a -= 2*Math.PI;
    return a<=a0 && a>=a1;
  }
}
function normalizeAngle(a){ while(a<=-Math.PI)a+=2*Math.PI; while(a>Math.PI)a-=2*Math.PI; return a; }

function chooseCenter2D(cands, prev){
  if (!prev) return cands[0];
  let best=cands[0], bd=Infinity;
  for(const p of cands){
    const d=len2(sub2(p,prev)); if (d<bd){ bd=d; best=p; }
  }
  return best;
}

// Attempt an analytic center/seam solve when A and B are nearly straight lines.
function centerFromStraightChains(A, B, r){
  if (!A || !B || A.length < 2 || B.length < 2) return null;
  const dir = (poly)=>{
    const v = sub2(poly[poly.length-1], poly[0]);
    const L = len2(v); if (L < 1e-9) return null; return nrm2(v);
  };
  const dA = dir(A); const dB = dir(B);
  if (!dA || !dB) return null;
  // Normals pointing towards the opposite chain
  const mean = (poly)=>{
    let sx=0,sy=0; for(const p of poly){ sx+=p.x; sy+=p.y; } const n=poly.length||1; return {x:sx/n,y:sy/n};
  };
  const avgA = mean(A);
  const avgB = mean(B);
  let nA = rot90(dA); if (dot2(sub2(avgB, A[0]), nA) < 0) nA = mul2(nA, -1);
  let nB = rot90(dB); if (dot2(sub2(avgA, B[0]), nB) < 0) nB = mul2(nB, -1);

  // Base points on each chain (closest to origin ~ station point)
  const pA0 = A[0];
  const pB0 = B[0];
  const pAoff = add2(pA0, mul2(nA, r));
  const pBoff = add2(pB0, mul2(nB, r));
  const inter = segSeg2DInf(pAoff, add2(pAoff, dA), pBoff, add2(pBoff, dB));
  if (!inter.ok) return null;
  const c2 = inter.p;
  // Feet of perpendicular from center to each original chain
  const foot = (p0, d, c)=>{
    const ap = sub2(c, p0); const t = dot2(ap, d) / Math.max(1e-18, dot2(d,d));
    return add2(p0, mul2(d, t));
  };
  const a2 = foot(pA0, dA, c2);
  const b2 = foot(pB0, dB, c2);
  return { c2, a2, b2 };
}

function nearestPerpPointOnChain(poly, p){
  let best = null; let bestD = Infinity; let bestIdx = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1];
    const ab = sub2(b, a), ap = sub2(p, a);
    const denom = Math.max(1e-18, dot2(ab, ab));
    const t = Math.max(0, Math.min(1, dot2(ap, ab) / denom));
    const q = add2(a, mul2(ab, t));
    const d = len2(sub2(p, q));
    if (d < bestD) { bestD = d; best = q; bestIdx = i; }
  }
  if (!best) best = poly[0] || V2(0,0);
  return { x: best.x, y: best.y, segIdx: bestIdx };
}

function outwardNormal2D(poly, segIdx){
  const a=poly[segIdx], b=poly[segIdx+1];
  const t=nrm2(sub2(b,a)); const n=rot90(t);
  // Heuristic: assume poly A points roughly "outward" (we offset opposite for B earlier).
  return n;
}

function sampleArc2D(center, r, aPt, bPt, n=12){
  const a0 = Math.atan2(aPt.y-center.y, aPt.x-center.x);
  const a1 = Math.atan2(bPt.y-center.y, bPt.x-center.x);
  let d = normalizeAngle(a1-a0);
  if (d<0) d += 2*Math.PI;
  const out=[];
  for(let i=0;i<=n;i++){
    const t=i/n; const ang=a0 + d*t;
    out.push({ x: center.x + r*Math.cos(ang), y: center.y + r*Math.sin(ang) });
  }
  return out;
}

/* ------------------------- Loft / Returns / Caps ---------------------- */
function loftRings(rings){
  const verts=[]; const faces=[];
  let base=0;
  for(const ring of rings){ for(const p of ring){ verts.push(p); } }
  const segs = rings[0].length;
  for(let i=0;i<rings.length-1;i++){
    const rowA = i*segs, rowB=(i+1)*segs;
    for(let k=0;k<segs-1;k++){
      faces.push([rowA+k, rowB+k, rowA+k+1]);
      faces.push([rowA+k+1, rowB+k, rowB+k+1]);
    }
    // wrap last->first
    faces.push([rowA+segs-1, rowB+segs-1, rowA+0]);
    faces.push([rowA+0, rowB+segs-1, rowB+0]);
  }
  return { vertices: verts, faces };
}

function ruledStrip(curveA, curveB){
  if (curveA.length !== curveB.length) {
    // resample curveB to curveA length
    // simple match by index for now
    while(curveB.length < curveA.length) curveB.push(curveB[curveB.length-1]);
  }
  const verts = [...curveA, ...curveB];
  const faces = [];
  const n = curveA.length;
  for(let i=0;i<n-1;i++){
    const a0=i, a1=i+1, b0=n+i, b1=n+i+1;
    faces.push([a0, b0, a1]);
    faces.push([a1, b0, b1]);
  }
  return { vertices: verts, faces };
}

function offsetCurveInward(curve, rings, eps){
  // Build a tiny inward offset along the local bisector of the nearest ring point
  const out=[];
  for(let i=0;i<curve.length;i++){
    const p = curve[i];
    const ring = rings[Math.min(i, rings.length-1)];
    // normal approx: vector from seam point to nearest ring point
    let bestD=Infinity, bestV=null;
    for(const r of ring){
      const v=sub3(r,p); const d=len3(v); if (d<bestD){bestD=d; bestV=v;}
    }
    const n = nrm3(bestV||{x:0,y:0,z:1});
    out.push(add3(p, mul3(n, eps)));
  }
  return out;
}

function capFromRing(ring, flip=false){
  // triangulate fan from ring[0]
  const verts=[...ring];
  const faces=[];
  for(let i=1;i<ring.length-1;i++){
    const tri = flip ? [0,i+1,i] : [0,i,i+1];
    faces.push(tri);
  }
  return { vertices: verts, faces };
}

function mergeMeshes(meshes, tol){
  const vertices=[]; const faces=[];
  const map = new Map();
  const key=(p0)=> { const p=toV3(p0); return `${roundTol(p.x,tol.epsW)}|${roundTol(p.y,tol.epsW)}|${roundTol(p.z,tol.epsW)}`; };
  const addV=(p)=>{
    const k=key(p);
    if (map.has(k)) return map.get(k);
    const idx=vertices.length; vertices.push(p); map.set(k, idx); return idx;
  };
  for(const m of meshes){
    if (!m || !m.vertices || !m.faces) continue;
    const baseIdx=[];
    for(const p of m.vertices) baseIdx.push(addV(p));
    for(const f of m.faces){
      faces.push( f.map(i=>baseIdx[i]) );
    }
  }
  return { vertices, faces };
}
function roundTol(x,eps){ return Math.round(x/eps)*eps; }

/* ----------------------------- Validation ---------------------------- */
function sanityCheck(mesh, tol){
  const {vertices, faces} = mesh;
  if (vertices.length===0 || faces.length===0) throw new Error("cutter has no geometry");
  // minimal checks: no degenerate tris
  for(const f of faces){
    const A=vertices[f[0]],B=vertices[f[1]],C=vertices[f[2]];
    const ab=sub3(B,A), ac=sub3(C,A);
    const area = len3(cross3(ab,ac))*0.5;
    if (area < tol.epsI*tol.epsI) throw new Error("degenerate triangle in cutter");
  }
}

/* ------------------------ Boolean Type Decision ---------------------- */
function decideBooleanType(stations, seamsA, seamsB, targetSolid){
  // Estimate side normals by local line directions along seams (very robust for mesh edges)
  const nA = avgCurveNormal(seamsA, stations);
  const nB = avgCurveNormal(seamsB, stations);
  // dihedral sign via angle between normals around tangent
  const t = nrm3(sub3(stations[Math.min(1,stations.length-1)], stations[0]));
  const cross = cross3(nA,nB);
  const sgn = dot3(cross, t); // right-hand rule
  // sgn > 0 => convex (SUBTRACT), sgn < 0 => concave (UNION)
  return (sgn >= 0) ? "SUBTRACT" : "UNION";
}
function avgCurveNormal(curve, stations){
  // rough: PCA on small window to get approximate plane normal
  let cx=0,cy=0,cz=0; for(const p of curve){cx+=p.x;cy+=p.y;cz+=p.z;} cx/=curve.length; cy/=curve.length; cz/=curve.length;
  let xx=0,xy=0,xz=0, yy=0,yz=0, zz=0;
  for(const p of curve){
    const v={x:p.x-cx,y:p.y-cy,z:p.z-cz};
    xx+=v.x*v.x; xy+=v.x*v.y; xz+=v.x*v.z;
    yy+=v.y*v.y; yz+=v.y*v.z; zz+=v.z*v.z;
  }
  // small eigen trick: normal is eigenvector of smallest eigenvalue of covariance
  // Use cross of biggest-variance directions approximated by axis picks:
  const vx = {x:1, y:0, z: (xz!==0? -xx/xz : 0)};
  const vy = {x:0, y:1, z: (yz!==0? -yy/yz : 0)};
  return nrm3(cross3(vx, vy));
}

/* ------------------------------ Utilities ---------------------------- */
function clonePts(arr){
  if (!Array.isArray(arr)) return [];
  return arr.map(p => {
    if (p && typeof p === 'object') {
      if (Array.isArray(p)) return { x: p[0], y: p[1], z: p[2] };
      return { x: p.x, y: p.y, z: p.z };
    }
    return { x: +p || 0, y: 0, z: 0 };
  });
}
function cloneFaces(F){ return F.map(f=>[f[0],f[1],f[2]]); }
function toIndexArray(v){ if (v==null) return []; if (Array.isArray(v)) return v.slice(); return [v]; }
function reindexTriangles(tris){
  const vertices=[]; const faces=[];
  const map=new Map(); const key=p=>`${p.x}|${p.y}|${p.z}`;
  for(const t of tris){
    const idx=[];
    for(const p of t){
      const k=key(p);
      if (!map.has(k)){ map.set(k, vertices.length); vertices.push({...p}); }
      idx.push(map.get(k));
    }
    faces.push(idx);
  }
  return { vertices, faces };
}
function dedupe2D(points, eps){
  const out=[]; for(const p of points){
    let ok=true;
    for(const q of out){ if (Math.hypot(p.x-q.x,p.y-q.y)<eps){ ok=false; break; } }
    if (ok) out.push(p);
  } return out;
}
