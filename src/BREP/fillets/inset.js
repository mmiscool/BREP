import * as THREE from 'three';

// Scratch vectors
const __vAB = new THREE.Vector3();
const __vAC = new THREE.Vector3();
const __vAP = new THREE.Vector3();
const __vBP = new THREE.Vector3();
const __vCP = new THREE.Vector3();
const __vCB = new THREE.Vector3();
const __tmp1 = new THREE.Vector3();
const __tmp2 = new THREE.Vector3();
const __tmp3 = new THREE.Vector3();
const __tmp4 = new THREE.Vector3();
const __tmp5 = new THREE.Vector3();
const __tmp6 = new THREE.Vector3();
const __projOut = new THREE.Vector3();

function getScaleAdaptiveTolerance(radius, baseEpsilon = 1e-12) {
  return Math.max(baseEpsilon, baseEpsilon * Math.abs(radius));
}

function getDistanceTolerance(radius) {
  return Math.max(1e-9, 1e-6 * Math.abs(radius));
}

function getAngleTolerance() {
  return 1e-6; // radians
}

// Lightweight spatial index keyed by voxel cells for triangle centroid spheres
class TriangleSpatialIndex {
  constructor(triangleData, cellSize = null) {
    this.triangleData = triangleData || [];
    this.grid = new Map();
    if (!this.triangleData.length) return;
    if (cellSize == null) {
      const avgRad = this.triangleData.reduce((s, d) => s + (d.rad || 0), 0) / this.triangleData.length;
      cellSize = Math.max(avgRad * 2, 1e-6);
    }
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
    for (let i = 0; i < this.triangleData.length; i++) {
      for (const key of this.getTriangleCells(this.triangleData[i])) {
        if (!this.grid.has(key)) this.grid.set(key, []);
        this.grid.get(key).push(i);
      }
    }
  }
  cellKey(x, y, z) {
    const ix = Math.floor(x * this.invCellSize);
    const iy = Math.floor(y * this.invCellSize);
    const iz = Math.floor(z * this.invCellSize);
    return `${ix},${iy},${iz}`;
  }
  getTriangleCells({ cx, cy, cz, rad }) {
    const cells = new Set();
    const minX = (cx - rad) * this.invCellSize;
    const maxX = (cx + rad) * this.invCellSize;
    const minY = (cy - rad) * this.invCellSize;
    const maxY = (cy + rad) * this.invCellSize;
    const minZ = (cz - rad) * this.invCellSize;
    const maxZ = (cz + rad) * this.invCellSize;
    for (let ix = Math.floor(minX); ix <= Math.floor(maxX); ix++)
      for (let iy = Math.floor(minY); iy <= Math.floor(maxY); iy++)
        for (let iz = Math.floor(minZ); iz <= Math.floor(maxZ); iz++)
          cells.add(`${ix},${iy},${iz}`);
    return cells;
  }
  getNearbyTriangles(point, maxDistance = Infinity) {
    const key = this.cellKey(point.x, point.y, point.z);
    const list = this.grid.get(key) || [];
    if (maxDistance === Infinity || list.length) return list;
    const R = Math.ceil(maxDistance * this.invCellSize);
    const ix0 = Math.floor(point.x * this.invCellSize);
    const iy0 = Math.floor(point.y * this.invCellSize);
    const iz0 = Math.floor(point.z * this.invCellSize);
    const set = new Set();
    for (let ix = ix0 - R; ix <= ix0 + R; ix++)
      for (let iy = iy0 - R; iy <= iy0 + R; iy++)
        for (let iz = iz0 - R; iz <= iz0 + R; iz++) {
          const l = this.grid.get(`${ix},${iy},${iz}`);
          if (l) for (const i of l) set.add(i);
        }
    return Array.from(set);
  }
}

const __FACE_DATA_CACHE = new Map();
const __SPATIAL_INDEX_CACHE = new Map();
const MAX_CACHE_SIZE = 100;

function getCachedFaceDataForTris(tris, faceKey = null) {
  if (!Array.isArray(tris) || tris.length === 0) return [];
  const cacheKey = faceKey || tris;
  const existing = __FACE_DATA_CACHE.get(cacheKey);
  if (existing) return existing;
  if (__FACE_DATA_CACHE.size >= MAX_CACHE_SIZE) {
    const first = __FACE_DATA_CACHE.keys().next().value;
    __FACE_DATA_CACHE.delete(first);
    __SPATIAL_INDEX_CACHE.delete(first);
  }
  const a = __tmp1, b = __tmp2, c = __tmp3;
  const ab = __tmp4, ac = __tmp5, n = __tmp6;
  const faceData = tris.map(t => {
    a.set(t.p1[0], t.p1[1], t.p1[2]);
    b.set(t.p2[0], t.p2[1], t.p2[2]);
    c.set(t.p3[0], t.p3[1], t.p3[2]);
    const cx = (a.x + b.x + c.x) / 3;
    const cy = (a.y + b.y + c.y) / 3;
    const cz = (a.z + b.z + c.z) / 3;
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    const len = n.length();
    if (len < getScaleAdaptiveTolerance(1.0, 1e-14)) return null;
    n.multiplyScalar(1 / len);
    const dxA = a.x - cx, dyA = a.y - cy, dzA = a.z - cz;
    const dxB = b.x - cx, dyB = b.y - cy, dzB = b.z - cz;
    const dxC = c.x - cx, dyC = c.y - cy, dzC = c.z - cz;
    const rA2 = dxA * dxA + dyA * dyA + dzA * dzA;
    const rB2 = dxB * dxB + dyB * dyB + dzB * dzB;
    const rC2 = dxC * dxC + dyC * dyC + dzC * dzC;
    const rad = Math.sqrt(Math.max(rA2, rB2, rC2));
    return { cx, cy, cz, rad, normal: n.clone(), triangle: t };
  }).filter(Boolean);
  __FACE_DATA_CACHE.set(cacheKey, faceData);
  return faceData;
}

function getCachedSpatialIndex(faceData, faceKey = null) {
  const key = faceKey || faceData;
  let idx = __SPATIAL_INDEX_CACHE.get(key);
  if (!idx && Array.isArray(faceData) && faceData.length) {
    idx = new TriangleSpatialIndex(faceData);
    __SPATIAL_INDEX_CACHE.set(key, idx);
  }
  return idx;
}

function clearFilletCaches() {
  __FACE_DATA_CACHE.clear();
  __SPATIAL_INDEX_CACHE.clear();
}

function trimFilletCaches() {
  if (__FACE_DATA_CACHE.size > MAX_CACHE_SIZE * 2) {
    let count = 0;
    const toDrop = [];
    for (const k of __FACE_DATA_CACHE.keys()) {
      if (count++ > MAX_CACHE_SIZE) toDrop.push(k);
    }
    for (const k of toDrop) {
      __FACE_DATA_CACHE.delete(k);
      __SPATIAL_INDEX_CACHE.delete(k);
    }
  }
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function isFiniteVec3(v) { return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z); }

// Output-parameter version to avoid allocating new vectors per call
function closestPointOnTriangleToOut(P, A, B, C, out) {
  // Real-Time Collision Detection (Christer Ericson)
  const AB = __vAB.subVectors(B, A);
  const AC = __vAC.subVectors(C, A);
  const AP = __vAP.subVectors(P, A);
  const d1 = AB.dot(AP);
  const d2 = AC.dot(AP);
  if (d1 <= 0 && d2 <= 0) { out.copy(A); return out; }
  const BP = __vBP.subVectors(P, B);
  const d3 = AB.dot(BP);
  const d4 = AC.dot(BP);
  if (d3 >= 0 && d4 <= d3) { out.copy(B); return out; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out.copy(A).addScaledVector(AB, v); return out; }
  const CP = __vCP.subVectors(P, C);
  const d5 = AB.dot(CP);
  const d6 = AC.dot(CP);
  if (d6 >= 0 && d5 <= d6) { out.copy(C); return out; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out.copy(A).addScaledVector(AC, w); return out; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); out.copy(B).addScaledVector(__vCB.subVectors(C, B), w); return out; }
  const denom = 1 / (AB.dot(AB) * AC.dot(AC) - Math.pow(AB.dot(AC), 2));
  const v = (AC.dot(AC) * AB.dot(AP) - AB.dot(AC) * AC.dot(AP)) * denom;
  const w = (AB.dot(AB) * AC.dot(AP) - AB.dot(AC) * AB.dot(AP)) * denom;
  out.copy(A).addScaledVector(AB, v).addScaledVector(AC, w); return out;
}

function projectPointOntoFaceTriangles(tris, point, faceData = null, faceKey = null) {
  if (!Array.isArray(tris) || tris.length === 0) return point.clone();
  const data = faceData && Array.isArray(faceData) ? faceData : getCachedFaceDataForTris(tris, faceKey);
  if (!data || !data.length) return point.clone();
  const spatialIndex = getCachedSpatialIndex(data, faceKey);
  let best = null;
  const a = __tmp1, b = __tmp2, c = __tmp3, q = __projOut;
  if (spatialIndex) {
    const nearby = spatialIndex.getNearbyTriangles(point);
    if (nearby.length) {
      for (const idx of nearby) {
        if (idx >= data.length) continue;
        const t = data[idx].triangle;
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        closestPointOnTriangleToOut(point, a, b, c, q);
        const d2 = q.distanceToSquared(point);
        if (!best || d2 < best.d2) best = { d2, q: q.clone() };
      }
      if (best && data.length > 64) {
        const bestDist = Math.sqrt(best.d2);
        const visited = new Set(nearby);
        for (let i = 0; i < data.length; i++) {
          if (visited.has(i)) continue;
          const d = data[i];
          const dx = d.cx - point.x, dy = d.cy - point.y, dz = d.cz - point.z;
          const centerD2 = dx * dx + dy * dy + dz * dz;
          const rad = d.rad || 0;
          const thr = bestDist + rad;
          if (centerD2 > thr * thr) continue;
          const t = d.triangle;
          a.set(t.p1[0], t.p1[1], t.p1[2]);
          b.set(t.p2[0], t.p2[1], t.p2[2]);
          c.set(t.p3[0], t.p3[1], t.p3[2]);
          closestPointOnTriangleToOut(point, a, b, c, q);
          const d2 = q.distanceToSquared(point);
          if (d2 < best.d2) best = { d2, q: q.clone() };
        }
      }
    } else {
      const candidates = data.map((d, i) => ({ i, d2: (d.cx - point.x) ** 2 + (d.cy - point.y) ** 2 + (d.cz - point.z) ** 2 }));
      candidates.sort((a, b) => a.d2 - b.d2);
      const K = Math.min(16, candidates.length);
      for (let k = 0; k < K; k++) {
        const t = data[candidates[k].i].triangle;
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        closestPointOnTriangleToOut(point, a, b, c, q);
        const d2 = q.distanceToSquared(point);
        if (!best || d2 < best.d2) best = { d2, q: q.clone() };
      }
    }
  } else {
    const K = Math.min(16, data.length);
    const pairs = data.map((d, i) => ({ i, d2: (d.cx - point.x) ** 2 + (d.cy - point.y) ** 2 + (d.cz - point.z) ** 2 }));
    pairs.sort((a, b) => a.d2 - b.d2);
    for (let k = 0; k < K; k++) {
      const t = data[pairs[k].i].triangle;
      a.set(t.p1[0], t.p1[1], t.p1[2]);
      b.set(t.p2[0], t.p2[1], t.p2[2]);
      c.set(t.p3[0], t.p3[1], t.p3[2]);
      closestPointOnTriangleToOut(point, a, b, c, q);
      const d2 = q.distanceToSquared(point);
      if (!best || d2 < best.d2) best = { d2, q: q.clone() };
    }
  }
  return best ? best.q : point.clone();
}

function batchProjectPointsOntoFace(tris, points, faceData = null, faceKey = null) {
  if (!Array.isArray(points) || !points.length) return [];
  if (!Array.isArray(tris) || !tris.length) return points.map(p => p.clone());
  const data = faceData && Array.isArray(faceData) ? faceData : getCachedFaceDataForTris(tris, faceKey);
  const spatialIndex = getCachedSpatialIndex(data, faceKey);
  const results = new Array(points.length);
  if (spatialIndex) {
    const cell = new Map(); // cellKey -> indices
    const inv = spatialIndex.invCellSize;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const key = `${Math.floor(p.x * inv)},${Math.floor(p.y * inv)},${Math.floor(p.z * inv)}`;
      let arr = cell.get(key); if (!arr) { arr = []; cell.set(key, arr); }
      arr.push(i);
    }
    for (const [key, indices] of cell.entries()) {
      const [ix, iy, iz] = key.split(',').map(Number);
      const neigh = [];
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const k = `${ix + dx},${iy + dy},${iz + dz}`;
            const list = spatialIndex.grid.get(k);
            if (list) for (const t of list) neigh.push(t);
          }
      const unique = Array.from(new Set(neigh));
      for (const i of indices) {
        const p = points[i];
        let best = null;
        const a = __tmp1, b = __tmp2, c = __tmp3, q = __projOut;
        for (const idx of unique) {
          const d = data[idx]; if (!d) continue;
          const t = d.triangle;
          a.set(t.p1[0], t.p1[1], t.p1[2]);
          b.set(t.p2[0], t.p2[1], t.p2[2]);
          c.set(t.p3[0], t.p3[1], t.p3[2]);
          closestPointOnTriangleToOut(p, a, b, c, q);
          const d2 = q.distanceToSquared(p);
          if (!best || d2 < best.d2) best = { d2, q: q.clone() };
        }
        results[i] = best ? best.q : p.clone();
      }
    }
  } else {
    for (let i = 0; i < points.length; i++) {
      results[i] = projectPointOntoFaceTriangles(tris, points[i], data, faceKey);
    }
  }
  return results;
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
    accum.add(ab.clone().cross(ac));
  }
  if (accum.lengthSq() === 0) return new THREE.Vector3(0, 1, 0);
  return accum.normalize();
}

function localFaceNormalAtPoint(solid, faceName, p, faceData = null, faceKey = null) {
  const point = (p && typeof p.x === 'number') ? p : __tmp5.set(p?.[0] || 0, p?.[1] || 0, p?.[2] || 0);
  let data = (Array.isArray(faceData) && faceData.length) ? faceData : null;
  if (!data) {
    const tris = solid?.getFace ? solid.getFace(faceName) : null;
    if (!Array.isArray(tris) || tris.length === 0) return null;
    data = getCachedFaceDataForTris(tris, faceKey || faceName);
  }
  if (!data || !data.length) return null;
  const spatial = getCachedSpatialIndex(data, faceKey || faceName || null);
  let bestNormal = null;
  let bestDist = Infinity;
  const evalIdx = (idx) => {
    const e = data[idx]; if (!e) return;
    const dx = point.x - e.cx, dy = point.y - e.cy, dz = point.z - e.cz;
    const dist = Math.abs(e.normal.x * dx + e.normal.y * dy + e.normal.z * dz);
    if (dist < bestDist) { bestDist = dist; bestNormal = e.normal; }
  };
  if (spatial) {
    const r = Number.isFinite(spatial.cellSize) ? spatial.cellSize * 1.5 : Infinity;
    const near = spatial.getNearbyTriangles(point, r);
    if (Array.isArray(near)) for (const idx of near) evalIdx(idx);
  }
  if (!bestNormal) {
    const pick = Math.min(16, data.length);
    const candidates = [];
    for (let i = 0; i < data.length; i++) {
      const e = data[i]; if (!e) continue;
      const dx = point.x - e.cx, dy = point.y - e.cy, dz = point.z - e.cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (candidates.length < pick) {
        candidates.push({ idx: i, d2 });
        if (candidates.length === pick) candidates.sort((a, b) => a.d2 - b.d2);
      } else if (d2 < candidates[candidates.length - 1].d2) {
        candidates[candidates.length - 1] = { idx: i, d2 };
        candidates.sort((a, b) => a.d2 - b.d2);
      }
    }
    for (const c of candidates) evalIdx(c.idx);
  }
  return bestNormal || null;
}

export {
  getScaleAdaptiveTolerance,
  getDistanceTolerance,
  getAngleTolerance,
  getCachedFaceDataForTris,
  getCachedSpatialIndex,
  clearFilletCaches,
  trimFilletCaches,
  clamp,
  isFiniteVec3,
  projectPointOntoFaceTriangles,
  batchProjectPointsOntoFace,
  averageFaceNormalObjectSpace,
  localFaceNormalAtPoint,
};

