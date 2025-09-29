// insetFilletSolid.js — builds INSET fillet cutter solids
// Split from filletSolid.js to keep inset/outset generation separate.
// Exports:
//   - insetFilletSolid(targetSolid, edgeName, radius, inflate = 0.1, options = {})
//   - InsetFilletSolid (class)

import { Solid as BetterSolid } from '../BetterSolid.js';

/* ------------------------------ Adapter ------------------------------ */
const Adapter = {
  getEdgeData(targetSolid, edgeRef) {
    if (edgeRef && typeof edgeRef === 'object') {
      const e = edgeRef;
      const poly = e.userData?.polylineLocal || e.polylineLocal || e.polyline || e.userData?.polyline;
      const closed = !!(e.closedLoop || e.userData?.closedLoop || e.closed || e.userData?.closed);
      const polyline = clonePts(poly);
      if (!polyline || polyline.length < 2) throw new Error('Adapter.getEdgeData: edge polyline missing/invalid');
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
      } catch (_) {}
      finally { try { if (mg && typeof mg.delete === 'function') mg.delete(); } catch {} }
      return { polyline, closed, seedA, seedB };
    }

    const edgeName = String(edgeRef);
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
        } catch {}
        finally { try { if (mg && typeof mg.delete === 'function') mg.delete(); } catch {} }
        return { polyline: clonePts(poly), closed, seedA, seedB };
      }
    }
    throw new Error(`Adapter.getEdgeData: edge ${edgeName} not found`);
  },

  getMesh(targetSolid) {
    if (typeof targetSolid?.getMesh === 'function') {
      try {
        const m = targetSolid.getMesh();
        if (m && m.triVerts && m.triVerts.length && m.vertProperties && m.vertProperties.length) {
          const outV = [];
          for (let i = 0; i + 2 < m.vertProperties.length; i += 3) {
            outV.push({ x: m.vertProperties[i + 0], y: m.vertProperties[i + 1], z: m.vertProperties[i + 2] });
          }
          const outF = [];
          for (let i = 0; i + 2 < m.triVerts.length; i += 3) {
            outF.push([m.triVerts[i + 0], m.triVerts[i + 1], m.triVerts[i + 2]]);
          }
          return { vertices: outV, faces: outF };
        }
      } catch (_) {}
      finally { try { if (m && typeof m.delete === 'function') m.delete(); } catch {} }
    }
    // Fallback: try a generic mesh-like shape
    try {
      const mesh = targetSolid.mesh;
      if (mesh && Array.isArray(mesh.vertices) && Array.isArray(mesh.faces)) {
        const vertices = mesh.vertices.map(p => ({ x: p.x, y: p.y, z: p.z }));
        const faces = mesh.faces.map(f => [f[0], f[1], f[2]]);
        return { vertices, faces };
      }
    } catch {}
    throw new Error('Adapter.getMesh: unable to fetch target mesh');
  },

  newSolidLike(targetSolid, vertices, faces) {
    try {
      const tool = new BetterSolid();
      const name = '__FILLET_TOOL__';
      for (let i = 0; i < faces.length; i++) {
        const f = faces[i];
        const a = vertices[f[0]]; const b = vertices[f[1]]; const c = vertices[f[2]];
        tool.addTriangle(name, [a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z]);
      }
      return tool;
    } catch (_) {}
    if (typeof targetSolid.constructor === "function") {
      try { return new targetSolid.constructor({ vertices, faces }); } catch (_) {}
    }
    if (typeof targetSolid.createFromTriangles === "function") {
      return targetSolid.createFromTriangles(vertices, faces);
    }
    return { mesh: { vertices, faces } };
  },

  signedDihedralAt(_targetSolid, _sample) { return null; }
};

/* --------------------------- Public Function ------------------------- */
export function insetFilletSolid(targetSolid, edgeName, radius, inflate = 0.1, options = {}) {
  const r = +radius;
  if (!(r > 0)) throw new Error("insetFilletSolid: radius must be > 0");
  const inflateDist = +inflate;
  if (!(inflateDist >= 0)) throw new Error("insetFilletSolid: inflate must be >= 0");

  const tol = { epsI: 1e-7, epsW: 5e-7, minAngleDeg: 15, minXsecAngleDeg: 5, minArcAngleDeg: 2 };
  const edgeData = Adapter.getEdgeData(targetSolid, edgeName);
  if (!edgeData.polyline || edgeData.polyline.length < 2) throw new Error("insetFilletSolid: edge polyline too short");
  const { vertices, faces } = Adapter.getMesh(targetSolid);
  const bboxDiag = bboxDiagonal(edgeData.polyline);
  tol.epsI *= bboxDiag; tol.epsW *= bboxDiag;
  let seamInsetAbs = tol.epsW;
  try {
    const s = Number(options.seamInsetScale);
    const force = true; // INSET prefers seam insets for robustness
    if (Number.isFinite(s) && s > 0) seamInsetAbs = Math.max(seamInsetAbs, s * bboxDiag);
    else if (force) seamInsetAbs = Math.max(seamInsetAbs, 1e-3 * bboxDiag);
  } catch {}
  const inflateLocal = edgeData.closed ? 0 : inflateDist;

  try {
    const topo = buildTopology(vertices, faces);
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
    if (!sideA.length || !sideB.length) throw new Error("insetFilletSolid: failed to classify band sides");

    const stations = sampleStations(edgeData.polyline, r);
    const rings = [];
    const seamsA = [];
    const seamsB = [];
    let prevCenter3 = null;
    for (let i = 0; i < stations.length; i++) {
      const S = stations[i];
      const frame = makeFrame(stations, i);
      const plane = { p: S, n: frame.t };
      const sectA2 = intersectSideWithPlane(vertices, faces, sideA, plane, frame);
      const sectB2 = intersectSideWithPlane(vertices, faces, sideB, plane, frame);
      const A = stitchSectionChain(sectA2, tol);
      const B = stitchSectionChain(sectB2, tol);
      if (!A || !B || A.length < 2 || B.length < 2) {
        if (rings.length) { rings.push(rings[rings.length-1].map(p=>({...p}))); seamsA.push(seamsA[seamsA.length-1]); seamsB.push(seamsB[seamsB.length-1]); }
        continue;
      }
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
        if (rings.length) { rings.push(rings[rings.length-1].map(p=>({...p}))); seamsA.push(seamsA[seamsA.length-1]); seamsB.push(seamsB[seamsB.length-1]); }
        continue;
      }
      const c2 = chooseCenter2D(centers2, prev2);
      const a2 = nearestPerpPointOnChain(A, c2);
      const b2 = nearestPerpPointOnChain(B, c2);
      const seamNA2 = outwardNormal2D(A, a2.segIdx);
      const seamNB2 = outwardNormal2D(B, b2.segIdx);
      const a2Inflated = { x: a2.x + seamNA2.x * inflateLocal, y: a2.y + seamNA2.y * inflateLocal };
      const b2Inflated = { x: b2.x + seamNB2.x * inflateLocal, y: b2.y + seamNB2.y * inflateLocal };
      const arcSamples2 = sampleArc2D(c2, r, a2, b2, 12);
      const ring3 = arcSamples2.map(p2 => lift2DTo3D(p2, frame));
      rings.push(ring3);
      seamsA.push(lift2DTo3D(a2Inflated, frame));
      seamsB.push(lift2DTo3D(b2Inflated, frame));
      prevCenter3 = lift2DTo3D(c2, frame);
    }

    if (rings.length < 2) throw new Error('insetFilletSolid: insufficient valid sections');
    const filletMesh = loftRings(rings);
    const spineA = offsetCurveInward(seamsA, rings, +seamInsetAbs);
    const spineB = offsetCurveInward(seamsB, rings, +seamInsetAbs);
    const returnA = ruledStrip(seamsA, spineA);
    const returnB = ruledStrip(seamsB, spineB);
    const caps = [];
    if (!edgeData.closed) {
      const firstCap = capFromRing(rings[0], /*flip=*/false);
      const lastCap  = capFromRing(rings[rings.length-1], /*flip=*/true);
      caps.push(firstCap, lastCap);
    }
    const toolMesh = mergeMeshes([filletMesh, returnA, returnB, ...caps], tol);
    sanityCheck(toolMesh, tol);
    const booleanType = 'SUBTRACT'; // INSET always subtracts
    const toolSolid = Adapter.newSolidLike(targetSolid, toolMesh.vertices, toolMesh.faces);
    return { toolSolid, booleanType };
  } catch (err) {
    const stations = sampleStations(edgeData.polyline, Math.max(1e-9, r));
    const rings = stations.map(p => circleSectionAt(p, stations, r));
    const tube = loftRings(rings);
    const caps = [];
    if (!edgeData.closed) {
      const firstCap = capFromRing(rings[0], /*flip=*/false);
      const lastCap  = capFromRing(rings[rings.length-1], /*flip=*/true);
      caps.push(firstCap, lastCap);
    }
    const toolMesh = mergeMeshes([tube, ...caps], tol);
    const toolSolid = Adapter.newSolidLike(targetSolid, toolMesh.vertices, toolMesh.faces);
    return { toolSolid, booleanType: 'SUBTRACT' };
  }
}

export class InsetFilletSolid extends BetterSolid {
  constructor({ edgeToFillet, radius = 1, debug = false, inflate = 0.1 } = {}) {
    super();
    if (!edgeToFillet) throw new Error('InsetFilletSolid: edgeToFillet is required');
    this.edgeToFillet = edgeToFillet;
    this.radius = +radius;
    this.inflate = Number.isFinite(inflate) ? +inflate : 0.1;
    this.debug = !!debug;
    const tgt = edgeToFillet.parent || edgeToFillet.parentSolid;
    if (!tgt) throw new Error('InsetFilletSolid: edge must be part of a solid');
    const { toolSolid } = insetFilletSolid(tgt, this.edgeToFillet, this.radius, this.inflate, {});
    new CopyFrom(toolSolid, this);
    this.filletType = 'SUBTRACT';
    this.name = 'FILLET_TOOL';
  }
}

/* -------------------- Simple Solid copy helper ----------------------- */
class CopyFrom {
  constructor(src, dst) {
    try {
      dst._vertProperties = Array.from(src._vertProperties);
      dst._triVerts = Array.from(src._triVerts);
      dst._triIDs = Array.from(src._triIDs);
      dst._vertKeyToIndex = new Map();
      for (let i = 0; i + 2 < dst._vertProperties.length; i += 3) {
        const x = dst._vertProperties[i + 0];
        const y = dst._vertProperties[i + 1];
        const z = dst._vertProperties[i + 2];
        dst._vertKeyToIndex.set(`${x},${y},${z}`, i / 3);
      }
      dst._idToFaceName = new Map(src._idToFaceName);
      dst._faceNameToID = new Map(src._faceNameToID);
      dst._dirty = true;
      dst._faceIndex = null;
    } catch (_) {}
  }
}

/* ---------------------------- Geometry Core --------------------------- */
function V3(x=0,y=0,z=0){ return {x:+x||0,y:+y||0,z:+z||0}; }
function toV3(p){ if (!p || typeof p !== 'object') return V3(0,0,0); if (Array.isArray(p) || (typeof p.length === 'number' && p.length >= 3)) return V3(p[0], p[1], p[2]); return V3(p.x, p.y, p.z); }
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

function bboxDiagonal(pts){ let min=V3(+Infinity,+Infinity,+Infinity), max=V3(-Infinity,-Infinity,-Infinity); for(const p0 of pts){ const p = toV3(p0); min.x=Math.min(min.x,p.x);min.y=Math.min(min.y,p.y);min.z=Math.min(min.z,p.z); max.x=Math.max(max.x,p.x);max.y=Math.max(max.y,p.y);max.z=Math.max(max.z,p.z);} return len3(sub3(max,min)); }

function buildTopology(verts, faces){ const v2f = Array(verts.length).fill(0).map(()=>[]); const edges = new Map(); for(let fi=0; fi<faces.length; fi++){ const [a,b,c] = faces[fi]; v2f[a].push(fi); v2f[b].push(fi); v2f[c].push(fi); const addE=(i,j)=>{ const k=i<j?`${i},${j}`:`${j},${i}`; const arr=edges.get(k)||[]; arr.push(fi); edges.set(k,arr); }; addE(a,b); addE(b,c); addE(c,a);} return { v2f, edges }; }
function extractBand(verts, faces, topo, polyline, bandRadius, seedA=[], seedB=[]){ const r2 = bandRadius*bandRadius; const nearV = new Set(); for(let vi=0; vi<verts.length; vi++){ const p=verts[vi]; for(const q of polyline){ const dx=p.x-q.x, dy=p.y-q.y, dz=p.z-q.z; if (dx*dx+dy*dy+dz*dz <= r2){ nearV.add(vi); break; } } } const inBand = new Set(); for(let fi=0; fi<faces.length; fi++){ const [a,b,c]=faces[fi]; if (nearV.has(a)||nearV.has(b)||nearV.has(c)) inBand.add(fi);} const sideA = []; const sideB = []; const visited = new Set(); if (seedA && seedA.length){ flood(seedA, sideA); } if (seedB && seedB.length){ flood(seedB, sideB); } if (!sideA.length || !sideB.length){ const p0=polyline[0], p1=polyline[Math.min(1, polyline.length-1)]; const t = nrm3(sub3(p1,p0)); const up = {x:0,y:0,z:1}; const u = nrm3(cross3(up,t)); const n = cross3(t,u); for(const fi of inBand){ const c = triCentroid(verts, faces[fi]); const s = dot3(sub3(c,p0), n) >= 0 ? sideA : sideB; s.push(fi);} } return { sideA, sideB, triIndexInBand: inBand }; function flood(seeds, out){ const Q=[...seeds]; for(const s of seeds) visited.add(s); while(Q.length){ const f = Q.pop(); if (!inBand.has(f)) continue; out.push(f); const [a,b,c]=faces[f]; const neigh = new Set([...topo.v2f[a], ...topo.v2f[b], ...topo.v2f[c]]); for(const nf of neigh){ if (!visited.has(nf) && inBand.has(nf)){ visited.add(nf); Q.push(nf); } } } } }
function triCentroid(verts, face){ const [a,b,c]=face; const A=verts[a],B=verts[b],C=verts[c]; return {x:(A.x+B.x+C.x)/3, y:(A.y+B.y+C.y)/3, z:(A.z+B.z+C.z)/3}; }

function sampleStations(polyline, r){ const eps = 0.05*r; const ds = Math.max( r*0.2, Math.sqrt(Math.max(2*r*eps, 1e-9)) ); const out = []; let acc=0; out.push(polyline[0]); for(let i=1;i<polyline.length;i++){ const seg = sub3(polyline[i], polyline[i-1]); const L = len3(seg); let u=0; while(acc+L-u >= ds){ u += ds; const t = (u)/L; out.push({ x: polyline[i-1].x + seg.x*t, y: polyline[i-1].y + seg.y*t, z: polyline[i-1].z + seg.z*t }); } acc = (acc+L-u);} out.push(polyline[polyline.length-1]); return out; }
function makeFrame(stations, i){ const p = stations[i]; const pPrev = stations[Math.max(0,i-1)]; const pNext = stations[Math.min(stations.length-1,i+1)]; const t = nrm3(sub3(pNext, pPrev)); const worldUp = {x:0,y:0,z:1}; let u = cross3(worldUp, t); if (len3(u) < 1e-6){ u = cross3({x:1,y:0,z:0}, t); } u = nrm3(u); const v = cross3(t,u); return { p, t, u, v }; }
function intersectSideWithPlane(verts, faces, triIndices, plane, frame){ const out = []; for(const fi of triIndices){ const [a,b,c] = faces[fi].map(i=>verts[i]); const segs = triPlaneSegments(a,b,c, plane); for(const s of segs){ const a2 = projectPointTo2D(s.a, frame); const b2 = projectPointTo2D(s.b, frame); out.push([a2,b2]); } } return out; }
function triPlaneSegments(A,B,C, plane){ const sd = P=> dot3(sub3(P, plane.p), plane.n); const dA=sd(A), dB=sd(B), dC=sd(C); const V=[{P:A,d:dA},{P:B,d:dB},{P:C,d:dC}]; const sgn=x=> (x>0)-(x<0); const S = V.map(v=>sgn(v.d)); const out=[]; const edges=[[0,1],[1,2],[2,0]]; for(const [i,j] of edges){ const a=V[i], b=V[j]; if ((a.d>0 && b.d<0) || (a.d<0 && b.d>0)){ const t = a.d/(a.d - b.d); out.push({ a: lerp3(a.P,b.P,t), b: null, i, j, t }); } } if (out.length===2){ out[0].b = out[1].a; out.splice(1,1); } else if (out.length>2){ out.sort((s0,s1)=>s0.t-s1.t); const s0={a:out[0].a,b:out[out.length-1].a}; out.length=0; out.push(s0);} return out; }
function lerp3(a,b,t){ return {x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t, z:a.z+(b.z-a.z)*t}; }
function projectPointTo2D(P, frame){ const rel = sub3(P, frame.p); return { x: dot3(rel, frame.u), y: dot3(rel, frame.v) }; }
function lift2DTo3D(p2, frame){ return add3(frame.p, add3( mul3(frame.u, p2.x), mul3(frame.v, p2.y) )); }

function stitchSectionChain(segs, tol){ if (segs.length===0) return null; const eps = tol.epsW*5; const pts = []; const ends = []; for(const [a,b] of segs){ ends.push(a,b); } let startIdx = 0; for(let i=1;i<ends.length;i++){ if (ends[i].x < ends[startIdx].x) startIdx=i; } const start = ends[startIdx]; pts.push(start); let cur = start; for(let k=0;k<ends.length; k++){ let best=-1, bestD=Infinity, bestPt=null; for(let i=0;i<ends.length;i++){ const p = ends[i]; const d = Math.hypot(p.x-cur.x, p.y-cur.y); if (d>eps) continue; if (d<bestD && (Math.abs(p.x-cur.x)>1e-12 || Math.abs(p.y-cur.y)>1e-12)){ best=i; bestD=d; bestPt=p; } } if (best<0) break; pts.push(bestPt); cur=bestPt; } return dedupe2D(pts, eps*0.25); }
function outwardNormal2D(poly, idx){ const i = Math.max(0, Math.min(poly.length-2, idx|0)); const a=poly[i], b=poly[i+1]; let t = nrm2(sub2(b,a)); let n = rot90(t); const cx = (a.x+b.x)*0.5, cy=(a.y+b.y)*0.5; const dx=(poly[0].x+poly[poly.length-1].x)*0.5 - cx; const dy=(poly[0].y+poly[poly.length-1].y)*0.5 - cy; if (dx*n.x + dy*n.y < 0) n = mul2(n, -1); return n; }
function offsetPolyline2D(poly, r, sign, tol){ const n = []; for(let i=0;i<poly.length-1;i++){ const a=poly[i], b=poly[i+1]; const t = nrm2(sub2(b,a)); const n2 = mul2(rot90(t), sign); const o0 = add2(a, mul2(n2,r)); const o1 = add2(b, mul2(n2,r)); n.push([o0,o1]); } return n; }
function intersectOffsetLoci(offA, offB, tol){ const pts=[]; for(const [a0,a1] of offA){ for(const [b0,b1] of offB){ const p = segSegIntersection2D(a0,a1,b0,b1,tol); if (p) pts.push(p); } } return dedupe2D(pts, tol.epsW*2); }
function segSegIntersection2D(a0,a1,b0,b1,tol){ const r=sub2(a1,a0); const s=sub2(b1,b0); const rxs = r.x*s.y - r.y*s.x; if (Math.abs(rxs) < 1e-12) return null; const qp = sub2(b0,a0); const t = (qp.x*s.y - qp.y*s.x)/rxs; const u = (qp.x*r.y - qp.y*r.x)/rxs; if (t>=-1e-9 && t<=1+1e-9 && u>=-1e-9 && u<=1+1e-9) return add2(a0, mul2(r,t)); return null; }
function nearestPerpPointOnChain(poly, c){ let best=null; let bestD=Infinity; let bestIdx=0; for(let i=0;i<poly.length-1;i++){ const a=poly[i], b=poly[i+1]; const ab=sub2(b,a); const ap=sub2(c,a); const t = (ap.x*ab.x + ap.y*ab.y)/Math.max(1e-20, ab.x*ab.x + ab.y*ab.y); const cl = add2(a, mul2(ab, Math.max(0, Math.min(1,t)))); const d = Math.hypot(cl.x-c.x, cl.y-c.y); if (d<bestD){ best=cl; bestD=d; bestIdx=i; } } best.segIdx=bestIdx; return best; }
function chooseCenter2D(cands, prev){ if (!cands || cands.length===0) return null; if (!prev) return cands[0]; let best=cands[0]; let bestD=Infinity; for(const p of cands){ const d = Math.hypot(p.x-prev.x, p.y-prev.y); if (d<bestD){ best=p; bestD=d; } } return best; }
function centerFromStraightChains(A, B, r){ if (!A || !B || A.length<2 || B.length<2) return null; const a0=A[0], a1=A[A.length-1]; const b0=B[0], b1=B[B.length-1]; const ta=nrm2(sub2(a1,a0)); const tb=nrm2(sub2(b1,b0)); const na=rot90(ta); const nb=rot90(tb); const a2=a0, b2=b0; const c2 = intersectLines2D(a2, add2(a2,na), b2, add2(b2,nb)); if (!c2) return null; return { c2, a2, b2 }; }
function intersectLines2D(p1,p2,p3,p4){ const x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y,x3=p3.x,y3=p3.y,x4=p4.x,y4=p4.y; const den=(x1-x2)*(y3-y4)-(y1-y2)*(x3-x4); if (Math.abs(den)<1e-12) return null; const px=((x1*y2-y1*x2)*(x3-x4)-(x1-x2)*(x3*y4-y3*x4))/den; const py=((x1*y2-y1*x2)*(y3-y4)-(y1-y2)*(x3*y4-y3*x4))/den; return {x:px,y:py}; }
function sampleArc2D(c, r, a2, b2, segs){ const A=Math.atan2(a2.y-c.y,a2.x-c.x); const B=Math.atan2(b2.y-c.y,b2.x-c.x); let d=B-A; while(d<=0) d+=Math.PI*2; const out=[]; for(let i=0;i<segs;i++){ const t=i/(segs-1); const ang=A + d*t; out.push({x:c.x + Math.cos(ang)*r, y:c.y + Math.sin(ang)*r}); } return out; }

function loftRings(rings){ const verts=[]; const faces=[]; for(const ring of rings){ for(const p of ring){ verts.push(p); } } const segs = rings[0].length; for(let i=0;i<rings.length-1;i++){ const rowA = i*segs, rowB=(i+1)*segs; for(let k=0;k<segs-1;k++){ faces.push([rowA+k, rowB+k, rowA+k+1]); faces.push([rowA+k+1, rowB+k, rowB+k+1]); } faces.push([rowA+segs-1, rowB+segs-1, rowA+0]); faces.push([rowA+0, rowB+segs-1, rowB+0]); } return { vertices: verts, faces }; }
function ruledStrip(curveA, curveB){ if (curveA.length !== curveB.length) { while(curveB.length < curveA.length) curveB.push(curveB[curveB.length-1]); } const verts = [...curveA, ...curveB]; const faces = []; const n = curveA.length; for(let i=0;i<n-1;i++){ const a0=i, a1=i+1, b0=n+i, b1=n+i+1; faces.push([a0, b0, a1]); faces.push([a1, b0, b1]); } return { vertices: verts, faces }; }
function offsetCurveInward(curve, rings, eps){ const out=[]; for(let i=0;i<curve.length;i++){ const p = curve[i]; const ring = rings[Math.min(i, rings.length-1)]; let bestD=Infinity, bestV=null; for(const r of ring){ const v=sub3(r,p); const d=len3(v); if (d<bestD){bestD=d; bestV=v;} } const n = nrm3(bestV||{x:0,y:0,z:1}); out.push(add3(p, mul3(n, eps))); } return out; }
function capFromRing(ring, flip=false){ const verts=[...ring]; const faces=[]; for(let i=1;i<ring.length-1;i++){ const tri = flip ? [0,i+1,i] : [0,i,i+1]; faces.push(tri); } return { vertices: verts, faces }; }
function mergeMeshes(meshes, tol){ const vertices=[]; const faces=[]; const map = new Map(); const key=(p0)=> { const p=toV3(p0); return `${roundTol(p.x,tol.epsW)}|${roundTol(p.y,tol.epsW)}|${roundTol(p.z,tol.epsW)}`; }; const addV=(p)=>{ const k=key(p); if (map.has(k)) return map.get(k); const idx=vertices.length; vertices.push(p); map.set(k, idx); return idx; }; for(const m of meshes){ if (!m || !m.vertices || !m.faces) continue; const baseIdx=[]; for(const p of m.vertices) baseIdx.push(addV(p)); for(const f of m.faces){ faces.push( f.map(i=>baseIdx[i]) ); } } return { vertices, faces }; }
function roundTol(x,eps){ return Math.round(x/eps)*eps; }
function sanityCheck(mesh, tol){ const {vertices, faces} = mesh; if (vertices.length===0 || faces.length===0) throw new Error("cutter has no geometry"); for(const f of faces){ const A=vertices[f[0]],B=vertices[f[1]],C=vertices[f[2]]; const ab=sub3(B,A), ac=sub3(C,A); const area = len3(cross3(ab,ac))*0.5; if (area < tol.epsI*tol.epsI) throw new Error("degenerate triangle in cutter"); } }

function circleSectionAt(p, stations, r){ const i = stations.indexOf(p); const frame = makeFrame(stations, Math.max(0,i)); const segs = 12; const pts=[]; for(let k=0;k<segs;k++){ const ang=2*Math.PI*k/segs; const pt2={x:Math.cos(ang)*r, y:Math.sin(ang)*r}; pts.push(lift2DTo3D(pt2, frame)); } return pts; }

function clonePts(arr){ if (!Array.isArray(arr)) return []; return arr.map(p => { if (p && typeof p === 'object') { if (Array.isArray(p)) return { x: p[0], y: p[1], z: p[2] }; return { x: p.x, y: p.y, z: p.z }; } return { x: +p || 0, y: 0, z: 0 }; }); }
function dedupe2D(points, eps){ const out=[]; for(const p of points){ let ok=true; for(const q of out){ if (Math.hypot(p.x-q.x,p.y-q.y)<eps){ ok=false; break; } } if (ok) out.push(p); } return out; }
