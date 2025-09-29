import * as THREE from 'three';
import { Solid } from './BetterSolid.js';

// Simple spatial hash grid for neighbor queries
class SpatialHash {
  constructor(points, cellSize) {
    this.cellSize = cellSize;
    this.map = new Map();
    for (const p of points) {
      const k = this._key(p.x, p.y, p.z);
      let arr = this.map.get(k);
      if (!arr) { arr = []; this.map.set(k, arr); }
      arr.push(p);
    }
  }
  _key(x, y, z) {
    const cs = this.cellSize;
    const ix = Math.floor(x / cs);
    const iy = Math.floor(y / cs);
    const iz = Math.floor(z / cs);
    return ix + '|' + iy + '|' + iz;
  }
  queryNeighborhood(x, y, z, radius) {
    const cs = this.cellSize;
    const r = Math.max(radius, cs);
    const ix = Math.floor(x / cs);
    const iy = Math.floor(y / cs);
    const iz = Math.floor(z / cs);
    const dr = Math.ceil(r / cs) + 1;
    const out = [];
    for (let dx = -dr; dx <= dr; dx++) {
      for (let dy = -dr; dy <= dr; dy++) {
        for (let dz = -dr; dz <= dr; dz++) {
          const k = (ix + dx) + '|' + (iy + dy) + '|' + (iz + dz);
          const arr = this.map.get(k);
          if (arr) out.push(...arr);
        }
      }
    }
    return out;
  }
}

function computeMedianKNNDistance(points, k = 8) {
  if (!points.length) return 0;
  // Build spatial hash at heuristic cell size
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; if (p.z > maxZ) maxZ = p.z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const cell = diag / Math.cbrt(Math.max(8, points.length));
  const sh = new SpatialHash(points, cell);

  const dists = new Array(points.length).fill(0);
  const tmp = new Array(k).fill(Infinity);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const nbrs = sh.queryNeighborhood(p.x, p.y, p.z, cell * 2.5);
    // track k nearest
    for (let j = 0; j < nbrs.length; j++) {
      const q = nbrs[j];
      if (q === p) continue;
      const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
      const d = Math.hypot(dx, dy, dz);
      let worstIdx = -1, worst = -1;
      for (let t = 0; t < k; t++) { if (tmp[t] > worst) { worst = tmp[t]; worstIdx = t; } }
      if (d < worst) tmp[worstIdx] = d;
    }
    // use median of tmp (ignore Infinity)
    const vals = tmp.filter(Number.isFinite).sort((a,b)=>a-b);
    dists[i] = vals.length ? vals[Math.floor(vals.length/2)] : cell;
    for (let t = 0; t < k; t++) tmp[t] = Infinity;
  }
  const sorted = dists.filter(Number.isFinite).sort((a,b)=>a-b);
  return sorted.length ? sorted[Math.floor(sorted.length/2)] : cell;
}

// Marching Cubes lookup tables (edgeTable, triTable)
// Tables adapted from Paul Bourke, public domain.
const edgeTable = new Int32Array([
0x0,0x109,0x203,0x30a,0x406,0x50f,0x605,0x70c,0x80c,0x905,0xa0f,0xb06,0xc0a,0xd03,0xe09,0xf00,
0x190,0x99,0x393,0x29a,0x596,0x49f,0x795,0x69c,0x99c,0x895,0xb9f,0xa96,0xd9a,0xc93,0xf99,0xe90,
0x230,0x339,0x33,0x13a,0x636,0x73f,0x435,0x53c,0xa3c,0xb35,0x83f,0x936,0xe3a,0xf33,0xc39,0xd30,
0x3a0,0x2a9,0x1a3,0xaa,0x7a6,0x6af,0x5a5,0x4ac,0xbac,0xaa5,0x9af,0x8a6,0xfaa,0xea3,0xda9,0xca0,
0x460,0x569,0x663,0x76a,0x66,0x16f,0x265,0x36c,0xc6c,0xd65,0xe6f,0xf66,0x86a,0x963,0xa69,0xb60,
0x5f0,0x4f9,0x7f3,0x6fa,0x1f6,0xff,0x3f5,0x2fc,0xdfc,0xcf5,0xfff,0xef6,0x9fa,0x8f3,0xbf9,0xaf0,
0x650,0x759,0x453,0x55a,0x256,0x35f,0x55,0x15c,0xe5c,0xf55,0xc5f,0xd56,0xa5a,0xb53,0x859,0x950,
0x7c0,0x6c9,0x5c3,0x4ca,0x3c6,0x2cf,0x1c5,0xcc,0xfcc,0xec5,0xdcf,0xcc6,0xbca,0xac3,0x9c9,0x8c0,
0x8c0,0x9c9,0xac3,0xbca,0xcc6,0xdcf,0xec5,0xfcc,0xcc,0x1c5,0x2cf,0x3c6,0x4ca,0x5c3,0x6c9,0x7c0,
0x950,0x859,0xb53,0xa5a,0xd56,0xc5f,0xf55,0xe5c,0x15c,0x55,0x35f,0x256,0x55a,0x453,0x759,0x650,
0xaf0,0xbf9,0x8f3,0x9fa,0xef6,0xfff,0xcf5,0xdfc,0x2fc,0x3f5,0xff,0x1f6,0x6fa,0x7f3,0x4f9,0x5f0,
0xb60,0xa69,0x963,0x86a,0xf66,0xe6f,0xd65,0xc6c,0x36c,0x265,0x16f,0x66,0x76a,0x663,0x569,0x460,
0xca0,0xda9,0xea3,0xfaa,0x8a6,0x9af,0xaa5,0xbac,0x4ac,0x5a5,0x6af,0x7a6,0xaa,0x1a3,0x2a9,0x3a0,
0xd30,0xc39,0xf33,0xe3a,0x936,0x83f,0xb35,0xa3c,0x53c,0x435,0x73f,0x636,0x13a,0x33,0x339,0x230,
0xe90,0xf99,0xc93,0xd9a,0xa96,0xb9f,0x895,0x99c,0x69c,0x795,0x49f,0x596,0x29a,0x393,0x99,0x190,
0xf00,0xe09,0xd03,0xc0a,0xb06,0xa0f,0x905,0x80c,0x70c,0x605,0x50f,0x406,0x30a,0x203,0x109,0x0
]);

const triTable = [
[],[0,8,3],[0,1,9],[1,8,3,9,8,1],[1,2,10],[0,8,3,1,2,10],[9,2,10,0,2,9],[2,8,3,2,10,8,10,9,8],
[3,11,2],[0,11,2,8,11,0],[1,9,0,2,3,11],[1,11,2,1,9,11,9,8,11],[3,10,1,11,10,3],[0,10,1,0,8,10,8,11,10],[3,9,0,3,11,9,11,10,9],[9,8,10,10,8,11],
[4,7,8],[4,3,0,7,3,4],[0,1,9,8,4,7],[4,1,9,4,7,1,7,3,1],[1,2,10,8,4,7],[3,4,7,3,0,4,1,2,10],[9,2,10,9,0,2,8,4,7],[2,10,9,2,9,7,2,7,3,7,9,4],
[8,4,7,3,11,2],[11,4,7,11,2,4,2,0,4],[9,0,1,8,4,7,2,3,11],[4,7,11,9,4,11,9,11,2,9,2,1],[3,10,1,3,11,10,7,8,4],[1,11,10,1,4,11,1,0,4,7,11,4],[4,7,8,9,0,11,9,11,10,11,0,3],[4,7,11,4,11,9,9,11,10],
[9,5,4],[9,5,4,0,8,3],[0,5,4,1,5,0],[8,5,4,8,3,5,3,1,5],[1,2,10,9,5,4],[3,0,8,1,2,10,4,9,5],[5,2,10,5,4,2,4,0,2],[2,10,5,3,2,5,3,5,4,3,4,8],
[9,5,4,2,3,11],[0,11,2,0,8,11,4,9,5],[0,5,4,0,1,5,2,3,11],[2,1,5,2,5,8,2,8,11,4,8,5],[10,3,11,10,1,3,9,5,4],[4,9,5,0,8,1,8,10,1,8,11,10],[5,4,0,5,0,11,5,11,10,11,0,3],[5,4,8,5,8,10,10,8,11],
[9,7,8,5,7,9],[9,3,0,9,5,3,5,7,3],[0,7,8,0,1,7,1,5,7],[1,5,3,3,5,7],[9,5,4,10,1,2,8,3,7],[5,7,9,7,8,9,1,2,10,0,3,4,3,7,4],[8,0,2,8,2,5,8,5,7,10,5,2],[2,10,5,2,5,3,3,5,7],
[7,9,5,7,8,9,3,11,2],[9,5,7,9,7,2,9,2,0,2,7,11],[2,3,11,0,1,8,1,7,8,1,5,7],[11,2,1,11,1,7,7,1,5],[9,5,4,10,1,6,11,2,3,7,8,4],[6,10,1,6,1,7,7,1,0,7,0,8,4,9,5],[7,8,4,6,10,3,6,3,7,3,10,1,0,5,4],[6,10,5,6,5,7,4,7,5],
[10,6,5],[8,3,0,5,10,6],[0,1,9,5,10,6],[8,1,9,8,3,1,10,6,5],[1,2,10,6,5,8,6,8,11,8,5,4],[1,2,10,3,0,11,0,6,11,0,4,6,6,5,11],[4,11,6,4,6,0,0,6,2,5,10,6],[2,3,11,4,6,5,4,0,6,0,1,6,1,10,6],
[3,2,8,8,2,4,4,2,6,10,6,5],[0,4,2,2,4,6,1,9,5,10,6,5],[5,10,6,1,9,2,2,9,11,11,9,8],[6,5,10,3,11,0,0,11,6,0,6,4,4,6,8],[9,5,4,10,6,1,1,6,11,1,11,3],[11,1,0,11,0,6,6,0,4,8,9,5,8,5,6],[6,11,3,6,3,4,4,3,8,6,5,10],[5,10,6,4,6,8,8,6,11,8,11,3],
[5,9,4,6,7,11],[0,8,3,4,5,9,11,6,7],[1,5,0,5,4,0,7,11,6],[8,3,1,8,1,6,8,6,7,6,1,5],[1,2,10,9,4,5,6,7,11],[1,2,10,0,8,3,4,5,9,6,7,11],[7,11,6,5,4,10,10,4,2,2,4,0],[8,3,4,4,3,5,5,3,2,5,2,10,11,6,7],
[9,4,5,2,3,7,2,7,6,7,3,8],[0,9,4,0,4,7,0,7,3,6,7,2,2,7,1,1,7,5],[6,7,2,2,7,1,1,7,5,0,1,4,4,1,5],[6,7,2,2,7,1,1,7,5,8,3,4,4,3,5],[2,10,1,11,6,7,9,4,5],[11,6,7,1,2,10,0,8,3,5,9,4],[4,5,9,0,1,7,0,7,8,7,1,6,1,10,6],[11,6,7,2,10,3,3,10,8,8,10,5,8,5,4],
[6,7,11,10,6,5],[0,8,3,5,10,6,11,6,7],[9,0,1,5,10,6,11,6,7],[1,8,3,1,9,8,5,10,6,11,6,7],[1,6,5,2,6,1,3,0,8,11,6,7],[2,6,1,1,6,5,0,2,9,9,2,11,9,11,6,9,6,5,11,6,7],[6,5,2,2,5,3,3,5,9,3,9,8,11,6,7],[2,6,5,2,5,3,3,5,8,8,5,9,11,6,7],
[7,11,6,8,4,9,8,9,3,3,9,1,5,10,6],[5,10,6,0,1,4,4,1,8,8,1,3,11,6,7],[11,6,7,1,4,9,1,2,4,2,6,4,8,3,0,5,10,6],[11,6,7,1,2,5,5,2,6,3,0,8,9,4,1],[6,7,11,2,3,10,10,3,5,5,3,4,5,4,9],[2,0,10,10,0,5,5,0,4,11,6,7,8,3,1,1,3,6,1,6,5,3,6,7],[5,10,6,0,4,8,3,0,8,11,6,7,2,0,1],[5,10,6,2,1,11,11,1,7,7,1,4,7,4,8,11,6,7],
[9,4,5,7,11,6,10,2,1],[6,7,11,1,10,2,0,8,3,4,5,9],[7,11,6,10,2,1,8,3,4,4,3,5,5,3,1,5,1,9],[6,7,11,10,2,1,9,0,5,5,0,4],[4,5,9,2,3,10,10,3,6,6,3,7],[6,7,10,10,7,1,1,7,8,1,8,0,4,5,9],[7,6,3,3,6,0,0,6,2,4,5,9,1,10,2],[7,6,8,8,6,3,3,6,2,8,4,5,5,4,9,10,2,1],
[2,3,6,6,3,7],[0,8,2,2,8,6,6,8,7],[1,9,0,2,3,6,6,3,7],[1,8,2,1,9,8,2,8,6,6,8,7],[10,2,1,6,7,0,0,7,9,9,7,8],[10,2,1,0,6,7,0,7,8],[6,7,2,2,7,3,0,1,9],[6,7,2,2,7,3,1,9,8,1,8,3],
[7,8,3,7,3,6,6,3,2],[7,0,8,7,6,0,6,2,0],[2,7,6,2,3,7,0,1,9],[1,6,2,1,9,6,9,7,6,9,8,7,3,7,2],[9,7,8,9,6,7,9,1,6,1,2,6],[1,6,2,1,9,6,9,7,6,0,6,3,0,3,8],[0,6,3,0,1,6,1,2,6],[6,2,1,6,1,3,3,1,8,8,1,9],
[1,10,2,3,7,8,3,6,7],[10,2,1,0,8,6,0,6,7,0,7,3],[9,0,1,8,3,6,8,6,7,2,6,3,10,2,1],[6,7,8,6,8,2,2,8,0,10,2,1,9,0,1],[7,3,6,6,3,2,1,10,0,0,10,8,8,10,6],[1,10,2,3,6,7,0,3,7,0,7,8,6,7,10,0,10,8],[6,7,2,2,7,3,9,0,1],[7,2,6,7,3,2,8,9,0,8,1,9],
[10,6,5],[0,8,3,5,10,6],[9,0,1,5,10,6],[1,8,3,1,9,8,5,10,6],[1,6,5,2,6,1],[1,6,5,1,2,6,3,0,8],[9,6,5,9,0,6,0,2,6],[5,9,8,5,8,2,2,8,3,6,5,2],
[2,3,11,10,6,5],[11,0,8,11,2,0,10,6,5],[0,1,9,2,3,11,5,10,6],[5,10,6,1,9,2,2,9,11,11,9,8],[6,3,11,6,5,3,5,1,3,10,6,1],[0,8,11,0,11,5,0,5,1,5,11,6,10,6,5],[3,11,6,3,6,0,0,6,5,0,5,9,10,6,5],[6,5,9,6,9,11,11,9,8],
[5,10,6,4,7,8],[4,3,0,4,7,3,6,5,10],[1,9,0,5,10,6,8,4,7],[10,6,5,1,9,7,1,7,3,7,9,4],[6,1,2,6,5,1,4,7,8],[1,2,5,5,2,6,3,0,4,3,4,7],[8,4,7,9,0,5,5,0,6,6,0,2],[7,3,4,7,8,3,6,5,2,2,5,1],
[9,4,5,11,2,3,7,8,6,8,6,7],[2,11,0,0,11,4,4,11,6,9,4,5,10,6,5,7,8,3],[2,3,11,0,1,9,4,7,8,5,10,6],[9,1,4,4,1,7,7,1,3,6,5,10,2,11,3,3,11,7],[4,7,8,6,5,10,3,11,1,1,11,0],[1,0,9,8,4,7,11,6,5,11,5,3,3,5,0],[7,8,4,11,6,5,3,0,6,0,5,6,0,1,5],[7,8,4,3,6,5,3,5,1,6,3,2,10,6,5],
[7,2,3,7,6,2,5,10,4,4,10,9,8,4,7],[9,5,4,0,1,6,0,6,7,0,7,8,2,6,1,10,6,5],[3,2,7,7,2,6,0,1,4,4,1,5,8,4,7,10,6,5],[6,2,7,6,7,5,5,7,8,5,8,4,1,9,0,3,2,7],
[2,3,6,6,3,7,10,6,5,8,4,9,9,4,5],[5,10,6,1,9,0,7,2,6,7,3,2,8,4,7],[0,8,3,4,7,2,4,2,5,5,2,6,10,6,5,1,9,0],[6,5,10,2,1,7,7,1,4,7,4,8,3,2,7],
[9,5,4,10,6,5],[3,0,8,9,5,4,10,6,5],[5,4,0,5,0,10,10,0,2,6,5,10],[8,3,1,8,1,4,4,1,5,2,6,1,1,6,10],
[1,2,10,9,5,4,3,0,8],[4,9,5,0,10,6,0,1,10,0,6,7,0,7,8,6,5,7,2,3,6],[5,4,9,1,10,2,0,8,6,0,6,7,0,7,3],[6,7,2,2,7,0,0,7,8,1,10,2,5,4,9],
[6,5,10,2,3,11,4,9,5,8,4,7],[5,10,6,11,2,1,11,1,8,8,1,9,4,7,8,0,4,9],[3,11,2,0,1,10,0,10,6,0,6,7,4,9,5],[6,7,8,6,8,10,10,8,1,1,8,3,5,10,6,4,9,5],
[5,10,6,4,9,7,7,9,3,3,9,8,11,2,3],[6,5,10,4,9,7,7,9,8,2,1,11,11,1,0],[1,10,6,1,6,3,3,6,7,0,1,4,4,1,5,8,4,7,2,3,11],[6,7,8,6,8,10,10,8,1,4,5,9,11,2,3,0,1,0],
[6,7,11,10,6,5,8,4,9,8,9,3,3,9,1],[0,8,4,4,8,5,5,8,1,11,6,7,10,6,5],[11,6,7,1,9,5,1,5,0,0,5,4,3,1,0],[6,7,11,5,10,4,4,10,0,0,10,2,1,9,5,8,3,0],
[7,11,6,5,10,4,4,10,2,4,2,8,8,2,3,9,5,4],[5,10,6,4,9,2,4,2,0,11,6,7,8,4,3,3,4,2],[11,6,7,8,4,3,3,4,2,10,6,5,1,9,0],[7,11,6,8,4,3,10,6,5,2,1,0],
[7,11,6,8,4,3],[7,11,6]
];

function marchingCubesSDF({ nx, ny, nz, h, origin, sample, iso = 1.0 }) {
  const solid = new Solid();
  const vtx = (x,y,z) => [x, y, z];
  // Cache of interpolated edge vertices
  const interpCache = new Map();
  const keyEdge = (i,j,k,e) => `${i}|${j}|${k}|${e}`;
  const lerp = (p1, p2, v1, v2) => {
    const t = (iso - v1) / (v2 - v1 + 1e-20);
    return new THREE.Vector3(
      p1.x + t * (p2.x - p1.x),
      p1.y + t * (p2.y - p1.y),
      p1.z + t * (p2.z - p1.z)
    );
  };

  // Precompute scalar field per grid node
  const val = new Float32Array(nx * ny * nz);
  const idx3 = (i,j,k) => (k*ny + j)*nx + i;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = origin.x + i * h;
        const y = origin.y + j * h;
        const z = origin.z + k * h;
        val[idx3(i,j,k)] = sample(x,y,z);
      }
    }
  }

  // Corner offsets
  const co = [
    [0,0,0],[1,0,0],[1,1,0],[0,1,0],
    [0,0,1],[1,0,1],[1,1,1],[0,1,1]
  ];
  // Edges: pairs of corners
  const eCorners = [
    [0,1],[1,2],[2,3],[3,0],
    [4,5],[5,6],[6,7],[7,4],
    [0,4],[1,5],[2,6],[3,7]
  ];

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        // Gather cube values
        const cube = new Float32Array(8);
        const p = new Array(8);
        for (let c = 0; c < 8; c++) {
          const ii = i + co[c][0], jj = j + co[c][1], kk = k + co[c][2];
          cube[c] = val[idx3(ii,jj,kk)];
          p[c] = new THREE.Vector3(origin.x + ii*h, origin.y + jj*h, origin.z + kk*h);
        }
        // Compute cube index
        let ci = 0;
        for (let c = 0; c < 8; c++) if (cube[c] < iso) ci |= (1 << c);
        const et = edgeTable[ci];
        if (et === 0) continue;
        const vertList = new Array(12);
        for (let e = 0; e < 12; e++) {
          if (et & (1 << e)) {
            const kcache = keyEdge(i,j,k,e);
            let v = interpCache.get(kcache);
            if (!v) {
              const a = eCorners[e][0], b = eCorners[e][1];
              v = lerp(p[a], p[b], cube[a], cube[b]);
              interpCache.set(kcache, v);
            }
            vertList[e] = v;
          }
        }
        const tris = triTable[ci];
        for (let t = 0; t < tris.length; t += 3) {
          const a = vertList[tris[t+0]];
          const b = vertList[tris[t+1]];
          const c = vertList[tris[t+2]];
          solid.addTriangle('FILLET_TOOL_WRAP', [a.x,a.y,a.z], [b.x,b.y,b.z], [c.x,c.y,c.z]);
        }
      }
    }
  }
  try { solid.fixTriangleWindingsByAdjacency(); } catch {}
  try { solid._weldVerticesByEpsilon(1e-8); } catch {}
  try { solid.fixTriangleWindingsByAdjacency(); } catch {}
  return solid;
}

export function buildTightPointCloudWrap(rawPoints, opts = {}) {
  const points = rawPoints
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  if (points.length < 4) return new Solid();
  // Bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; if (p.z > maxZ) maxZ = p.z;
  }
  const pad = opts.padding != null ? opts.padding : 0.02 * Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  minX -= pad; minY -= pad; minZ -= pad;
  maxX += pad; maxY += pad; maxZ += pad;

  // Choose radius from median kNN distance for tightness
  const medianNN = computeMedianKNNDistance(points, 8);
  const R = Math.max(1e-6, (opts.alphaRadius || 0.6 * medianNN));

  // Grid resolution
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const baseCells = Math.max(24, Math.min(96, Math.floor(diag / (R * 0.75))));
  const sizeX = maxX - minX, sizeY = maxY - minY, sizeZ = maxZ - minZ;
  const maxSize = Math.max(sizeX, sizeY, sizeZ);
  const buildAtScale = (scale) => {
    const cells = Math.max(24, Math.min(192, Math.floor(baseCells * scale)));
    const h = maxSize / cells;
    const nx = Math.max(8, Math.floor(sizeX / h) + 1);
    const ny = Math.max(8, Math.floor(sizeY / h) + 1);
    const nz = Math.max(8, Math.floor(sizeZ / h) + 1);
    const origin = new THREE.Vector3(minX, minY, minZ);
    const solid = marchingCubesSDF({ nx, ny, nz, h, origin, sample, iso: R });
    try { solid.fixTriangleWindingsByAdjacency(); } catch {}
    try { solid._weldVerticesByEpsilon(Math.max(1e-9, 1e-4 * R)); } catch {}
    try { solid.fixTriangleWindingsByAdjacency(); } catch {}
    return solid;
  };

  // Spatial hash for fast nearest
  const sh = new SpatialHash(points, Math.max(h, R));
  const R2 = R * R;
  const sample = (x,y,z) => {
    // Distance to nearest point (Euclidean)
    const nbrs = sh.queryNeighborhood(x,y,z, R * 2.5);
    let best2 = Infinity;
    for (let i = 0; i < nbrs.length; i++) {
      const q = nbrs[i];
      const dx = x - q.x, dy = y - q.y, dz = z - q.z;
      const d2 = dx*dx + dy*dy + dz*dz;
      if (d2 < best2) best2 = d2;
    }
    return Math.sqrt(best2);
  };

  // Try increasing resolutions until the mesh manifoldizes
  const scales = [1, 1.5, 2.0, 3.0];
  let out = null;
  for (let s = 0; s < scales.length; s++) {
    out = buildAtScale(scales[s]);
    try {
      // Probe manifoldization
      const __m = out.getMesh();
      try { /* probe */ } finally { try { if (__m && typeof __m.delete === 'function') __m.delete(); } catch {} }
      break; // success
    } catch (e) {
      if (s === scales.length - 1) {
        // Give up and return the best-effort mesh
        try { console.warn('[PointCloudWrap] Manifoldization failed at max refinement:', e?.message || e); } catch {}
      } else {
        continue;
      }
    }
  }
  return out;
}
