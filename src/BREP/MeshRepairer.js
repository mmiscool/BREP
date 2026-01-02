import * as THREE from 'three';

// ---------------------------------------------
// MeshRepairer: weld / T-junction fix / remove overlaps / hole fill / fix triangle normals
// ---------------------------------------------
export class MeshRepairer {
  constructor() { }

  // ---------- Helpers ----------
  static _ensureIndexed(geom) {
    if (!geom.index) {
      const count = geom.attributes.position.count;
      const idx = new Uint32Array(count);
      for (let i = 0; i < count; i++) idx[i] = i;
      geom.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    return geom;
  }
  static _getArrays(geom) {
    const pos = geom.attributes.position.array;
    const uv = geom.attributes.uv ? geom.attributes.uv.array : null;
    const norm = geom.attributes.normal ? geom.attributes.normal.array : null;
    const idx = geom.index.array;
    return { pos, uv, norm, idx };
  }
  static _vec3Of(arr, i) { const o = 3 * i; return [arr[o], arr[o + 1], arr[o + 2]]; }
  static _sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  static _dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  static _len2(a) { return this._dot(a, a); }
  static _cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  static _norm(a) { const l = Math.sqrt(this._len2(a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  static _add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  static _scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  static _triangleArea2(a, b, c) {
    const ab = this._sub(b, a), ac = this._sub(c, a);
    const cr = this._cross(ab, ac);
    return Math.sqrt(this._dot(cr, cr));
  }
  static _edgeKey(i, j) { return i < j ? `${i}/${j}` : `${j}/${i}`; }

  static _newellNormal(points) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return this._norm([nx, ny, nz]);
  }
  static _basisFromNormal(n) {
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    const t = ax < 0.9 ? [1, 0, 0] : (ay < 0.9 ? [0, 1, 0] : [0, 0, 1]);
    const u = this._norm(this._cross(t, n));
    const v = this._norm(this._cross(n, u));
    return { u, v, n };
  }
  static _projectToPlane(points, basis) {
    const { u, v } = basis;
    return points.map(p => [this._dot(p, u), this._dot(p, v)]);
  }
  static _polyArea2D(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      a += x1 * y2 - x2 * y1;
    }
    return a * 0.5;
  }
  static _pointInTri2D(p, a, b, c) {
    const v0 = [c[0] - a[0], c[1] - a[1]];
    const v1 = [b[0] - a[0], b[1] - a[1]];
    const v2 = [p[0] - a[0], p[1] - a[1]];
    const den = v0[0] * v1[1] - v1[0] * v0[1];
    if (Math.abs(den) < 1e-20) return false;
    const u = (v2[0] * v1[1] - v1[0] * v2[1]) / den;
    const v = (v0[0] * v2[1] - v2[0] * v0[1]) / den;
    return u >= -1e-10 && v >= -1e-10 && (u + v) <= 1 + 1e-10;
  }
  static _isConvex2D(prev, curr, next, sign) {
    const ax = curr[0] - prev[0], ay = curr[1] - prev[1];
    const bx = next[0] - curr[0], by = next[1] - curr[1];
    const cross = ax * by - ay * bx;
    return sign > 0 ? cross > 1e-20 : cross < -1e-20;
  }
  static _earClip2D(loop2D) {
    const n = loop2D.length;
    if (n < 3) return [];
    const idx = Array.from({ length: n }, (_, i) => i);
    const area = this._polyArea2D(loop2D);
    const sign = area >= 0 ? 1 : -1;
    if (sign < 0) idx.reverse();
    const tris = [];
    let counter = 0, maxIters = n * n;
    while (idx.length > 3 && counter++ < maxIters) {
      let ear = false;
      for (let i = 0; i < idx.length; i++) {
        const i0 = idx[(i - 1 + idx.length) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
        const a = loop2D[i0], b = loop2D[i1], c = loop2D[i2];
        if (!this._isConvex2D(a, b, c, 1)) continue;
        let inside = false;
        for (let k = 0; k < idx.length; k++) {
          const ik = idx[k];
          if (ik === i0 || ik === i1 || ik === i2) continue;
          if (this._pointInTri2D(loop2D[ik], a, b, c)) { inside = true; break; }
        }
        if (!inside) { tris.push([i0, i1, i2]); idx.splice(i, 1); ear = true; break; }
      }
      if (!ear) break;
    }
    if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
    return tris;
  }
  static _buildEdgeUse(idx) {
    const map = new Map(); // key -> {count, faces:[{tri, i, j, k}]}
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const edges = [[a, b, c], [b, c, a], [c, a, b]];
      for (const [i, j, k] of edges) {
        const key = this._edgeKey(i, j);
        let e = map.get(key);
        if (!e) { e = { count: 0, faces: [] }; map.set(key, e); }
        e.count++;
        e.faces.push({ tri: t, i, j, k });
      }
    }
    return map;
  }
  static _boundaryEdges(edgeUse) {
    const boundary = [];
    for (const [key, e] of edgeUse.entries()) {
      if (e.count === 1) {
        const [a, b] = key.split('/').map(s => parseInt(s, 10));
        boundary.push([a, b]);
      }
    }
    return boundary;
  }
  static _buildBoundaryLoops(boundaryEdges) {
    const adj = new Map();
    for (const [a, b] of boundaryEdges) {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b); adj.get(b).add(a);
    }
    const visited = new Set();
    const loops = [];
    const edgeId = (u, v) => u < v ? `${u}-${v}` : `${v}-${u}`;
    for (const [start, nbrs] of adj.entries()) {
      for (const n of nbrs) {
        const eid = edgeId(start, n);
        if (visited.has(eid)) continue;
        const loop = [start, n];
        visited.add(eid);
        let prev = start, curr = n;
        while (true) {
          const neighbors = Array.from(adj.get(curr) || []);
          const next = neighbors.find(x => x !== prev && !visited.has(edgeId(curr, x)));
          if (next == null) break;
          visited.add(edgeId(curr, next));
          loop.push(next);
          prev = curr; curr = next;
          if (next === start) break;
        }
        if (loop.length >= 3 && loop[0] === loop[loop.length - 1]) {
          loop.pop(); loops.push(loop);
        }
      }
    }
    return loops;
  }

  // ---------- 1) Weld identical/nearby vertices ----------
  weldVertices(geometry, epsilon = 1e-4) {
    MeshRepairer._ensureIndexed(geometry);
    const { pos, uv, norm, idx } = MeshRepairer._getArrays(geometry);

    const quant = (v) => [Math.round(v[0] / epsilon), Math.round(v[1] / epsilon), Math.round(v[2] / epsilon)].join(',');
    const map = new Map(); // key -> new index
    const sums = [];
    const remap = new Uint32Array(geometry.attributes.position.count);

    for (let i = 0; i < remap.length; i++) {
      const p = MeshRepairer._vec3Of(pos, i);
      const key = quant(p);
      let ni = map.get(key);
      if (ni === undefined) {
        ni = sums.length; map.set(key, ni);
        sums.push({
          pos: [p[0], p[1], p[2]],
          uv: uv ? [uv[2 * i], uv[2 * i + 1]] : null,
          norm: norm ? [norm[3 * i], norm[3 * i + 1], norm[3 * i + 2]] : null,
          count: 1
        });
      } else {
        const s = sums[ni];
        s.pos[0] += p[0]; s.pos[1] += p[1]; s.pos[2] += p[2];
        if (s.uv) { s.uv[0] += uv[2 * i]; s.uv[1] += uv[2 * i + 1]; }
        if (s.norm) { s.norm[0] += norm[3 * i]; s.norm[1] += norm[3 * i + 1]; s.norm[2] += norm[3 * i + 2]; }
        s.count++;
      }
      remap[i] = ni;
    }

    const newPos = new Float32Array(sums.length * 3);
    const newUv = uv ? new Float32Array(sums.length * 2) : null;
    const newNo = norm ? new Float32Array(sums.length * 3) : null;

    for (let i = 0; i < sums.length; i++) {
      const s = sums[i], inv = 1 / s.count;
      newPos[3 * i] = s.pos[0] * inv; newPos[3 * i + 1] = s.pos[1] * inv; newPos[3 * i + 2] = s.pos[2] * inv;
      if (newUv) { newUv[2 * i] = s.uv[0] * inv; newUv[2 * i + 1] = s.uv[1] * inv; }
      if (newNo) {
        const n = MeshRepairer._norm([s.norm[0], s.norm[1], s.norm[2]]);
        newNo[3 * i] = n[0]; newNo[3 * i + 1] = n[1]; newNo[3 * i + 2] = n[2];
      }
    }

    const outIdx = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
      if (a === b || b === c || c === a) continue;
      const A = MeshRepairer._vec3Of(newPos, a);
      const B = MeshRepairer._vec3Of(newPos, b);
      const C = MeshRepairer._vec3Of(newPos, c);
      if (MeshRepairer._triangleArea2(A, B, C) < 1e-20) continue;
      outIdx.push(a, b, c);
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
    if (newUv) out.setAttribute('uv', new THREE.BufferAttribute(newUv, 2));
    if (newNo) out.setAttribute('normal', new THREE.BufferAttribute(newNo, 3));
    out.setIndex(outIdx);
    out.computeVertexNormals();
    return out;
  }

  // ---------- 2) Fix T-junctions ----------
  fixTJunctions(geometry, lineEps = 5e-4, gridCell = 0.01) {
    MeshRepairer._ensureIndexed(geometry);
    const pos = geometry.attributes.position.array;
    const vertCount = pos.length / 3;
    const idx = Array.from(geometry.index.array);

    // Precompute triangle planes (unit normal + offset) for coplanarity checks
    const triCount = Math.floor(idx.length / 3);
    const triN = new Float32Array(triCount * 3);
    const triD = new Float32Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const ia = idx[3 * t], ib = idx[3 * t + 1], ic = idx[3 * t + 2];
      const ax = pos[3 * ia], ay = pos[3 * ia + 1], az = pos[3 * ia + 2];
      const bx = pos[3 * ib], by = pos[3 * ib + 1], bz = pos[3 * ib + 2];
      const cx = pos[3 * ic], cy = pos[3 * ic + 1], cz = pos[3 * ic + 2];
      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const acx = cx - ax, acy = cy - ay, acz = cz - az;
      let nx = aby * acz - abz * acy;
      let ny = abz * acx - abx * acz;
      let nz = abx * acy - aby * acx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-20) {
        nx /= len; ny /= len; nz /= len;
        triN[3 * t] = nx; triN[3 * t + 1] = ny; triN[3 * t + 2] = nz;
        triD[t] = -(nx * ax + ny * ay + nz * az);
      } else {
        triN[3 * t] = 0; triN[3 * t + 1] = 0; triN[3 * t + 2] = 0;
        triD[t] = 0;
      }
    }

    // Build edge usage to know which planes are relevant for an edge
    const edgeUse = MeshRepairer._buildEdgeUse(idx);

    // Spatial grid of vertices (hash grid)
    const cellKey = (x, y, z) => `${Math.floor(x / gridCell)}|${Math.floor(y / gridCell)}|${Math.floor(z / gridCell)}`;
    const grid = new Map();
    for (let i = 0; i < vertCount; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      const k = cellKey(x, y, z);
      let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); }
      arr.push(i);
    }

    // Fast per-edge candidate collector using 3D DDA voxel traversal along the segment
    function candidatesNearEdge(i, j) {
      const ax = pos[3 * i], ay = pos[3 * i + 1], az = pos[3 * i + 2];
      const bx = pos[3 * j], by = pos[3 * j + 1], bz = pos[3 * j + 2];

      // If the edge is extremely short, just query its containing cell
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      const set = new Set();
      if (len2 < 1e-24) {
        const key = cellKey(ax, ay, az);
        const arr = grid.get(key);
        if (arr) for (let k = 0; k < arr.length; k++) set.add(arr[k]);
        return set;
      }

      // Amanatides & Woo 3D DDA for grid traversal
      let ix = Math.floor(ax / gridCell), iy = Math.floor(ay / gridCell), iz = Math.floor(az / gridCell);
      const ix1 = Math.floor(bx / gridCell), iy1 = Math.floor(by / gridCell), iz1 = Math.floor(bz / gridCell);

      const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
      const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
      const stepZ = dz > 0 ? 1 : (dz < 0 ? -1 : 0);

      const invDx = dx !== 0 ? 1 / Math.abs(dx) : 0;
      const invDy = dy !== 0 ? 1 / Math.abs(dy) : 0;
      const invDz = dz !== 0 ? 1 / Math.abs(dz) : 0;

      // Compute param t at which we cross first voxel boundary on each axis
      let tMaxX;
      if (stepX > 0) tMaxX = ((ix + 1) * gridCell - ax) * invDx;
      else if (stepX < 0) tMaxX = (ax - ix * gridCell) * invDx;
      else tMaxX = Infinity;
      let tMaxY;
      if (stepY > 0) tMaxY = ((iy + 1) * gridCell - ay) * invDy;
      else if (stepY < 0) tMaxY = (ay - iy * gridCell) * invDy;
      else tMaxY = Infinity;
      let tMaxZ;
      if (stepZ > 0) tMaxZ = ((iz + 1) * gridCell - az) * invDz;
      else if (stepZ < 0) tMaxZ = (az - iz * gridCell) * invDz;
      else tMaxZ = Infinity;
      const tDeltaX = stepX !== 0 ? gridCell * invDx : Infinity;
      const tDeltaY = stepY !== 0 ? gridCell * invDy : Infinity;
      const tDeltaZ = stepZ !== 0 ? gridCell * invDz : Infinity;

      // Visit cells until reaching the end cell; include both endpoints' cells
      const maxVisits = 1 + Math.abs(ix1 - ix) + Math.abs(iy1 - iy) + Math.abs(iz1 - iz) + 2; // small cushion
      let visits = 0;
      while (true) {
        const key = `${ix}|${iy}|${iz}`;
        const arr = grid.get(key);
        if (arr) { for (let k = 0; k < arr.length; k++) set.add(arr[k]); }
        if (ix === ix1 && iy === iy1 && iz === iz1) break;
        if (++visits > maxVisits) break; // safety
        // Step along the smallest tMax
        if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { ix += stepX; tMaxX += tDeltaX; }
        else if (tMaxY <= tMaxX && tMaxY <= tMaxZ) { iy += stepY; tMaxY += tDeltaY; }
        else { iz += stepZ; tMaxZ += tDeltaZ; }
      }
      return set; // return Set to avoid duplicate work
    }

    // Return t in (0,1) if p projects inside segment ab and is within lineEps; else null
    function onSegmentParam(i, j, p) {
      const ax = pos[3 * i], ay = pos[3 * i + 1], az = pos[3 * i + 2];
      const bx = pos[3 * j], by = pos[3 * j + 1], bz = pos[3 * j + 2];
      const px = pos[3 * p], py = pos[3 * p + 1], pz = pos[3 * p + 2];
      const abx = bx - ax, aby = by - ay, abz = bz - az;
      const apx = px - ax, apy = py - ay, apz = pz - az;
      const ab2 = abx * abx + aby * aby + abz * abz;
      if (ab2 < 1e-24) return null;
      const t = (apx * abx + apy * aby + apz * abz) / ab2;
      if (t <= 1e-6 || t >= 1 - 1e-6) return null;
      const qx = ax + abx * t, qy = ay + aby * t, qz = az + abz * t;
      const dx = px - qx, dy = py - qy, dz = pz - qz;
      if (dx * dx + dy * dy + dz * dz <= lineEps * lineEps) return t;
      return null;
    }

    // Plane filter: p must be near at least one incident triangle plane
    const planeEps = Math.max(lineEps * 2, 1e-7);
    function nearIncidentPlane(i, j, p) {
      const key = MeshRepairer._edgeKey(i, j);
      const e = edgeUse.get(key);
      if (!e) return true; // fallback if unexpected
      const px = pos[3 * p], py = pos[3 * p + 1], pz = pos[3 * p + 2];
      for (let f = 0; f < e.faces.length; f++) {
        const triBase = e.faces[f].tri; // base index in idx array
        const t = Math.floor(triBase / 3);
        const nx = triN[3 * t], ny = triN[3 * t + 1], nz = triN[3 * t + 2];
        const d = triD[t];
        const dist = Math.abs(nx * px + ny * py + nz * pz + d);
        if (dist <= planeEps) return true;
      }
      return false;
    }

    // Collect splits per unique edge with coplanarity filter
    const splits = new Map(); // edge key -> [{p,t}] (t is along min->max orientation)
    function addSplit(i, j, p, t) {
      const key = MeshRepairer._edgeKey(i, j);
      const tt = i < j ? t : 1 - t;
      let arr = splits.get(key); if (!arr) { arr = []; splits.set(key, arr); }
      // avoid duplicates
      for (let k = 0; k < arr.length; k++) { if (arr[k].p === p) return; }
      arr.push({ p, t: tt });
    }

    // Iterate each unique unordered edge exactly once
    for (const [ekey, e] of edgeUse.entries()) {
      const parts = ekey.split('/');
      const i = parseInt(parts[0], 10);
      const j = parseInt(parts[1], 10);
      const candSet = candidatesNearEdge(i, j);
      for (const p of candSet) {
        if (p === i || p === j) continue;
        if (!nearIncidentPlane(i, j, p)) continue;
        const tp = onSegmentParam(i, j, p);
        if (tp !== null) addSplit(i, j, p, tp);
      }
    }
    for (const arr of splits.values()) arr.sort((a, b) => a.t - b.t);

    // Helper to get splits in i->j order (return vertex indices only)
    function orientedSplits(i, j) {
      const arr = splits.get(MeshRepairer._edgeKey(i, j)) || [];
      if (!arr.length) return [];
      if (i < j) return arr.map(s => s.p);
      const r = new Array(arr.length);
      for (let k = 0; k < arr.length; k++) r[k] = arr[arr.length - 1 - k].p;
      return r;
    }

    let totalSplitsApplied = 0;
    const newIdx = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const sAB = orientedSplits(a, b);
      const sBC = orientedSplits(b, c);
      const sCA = orientedSplits(c, a);
      const polyLen = 3 + sAB.length + sBC.length + sCA.length;
      if (polyLen === 3) {
        newIdx.push(a, b, c);
        continue;
      }
      // Fan triangulation from the first vertex of the original tri
      const poly = new Array(polyLen);
      let w = 0;
      poly[w++] = a; for (let k = 0; k < sAB.length; k++) poly[w++] = sAB[k];
      poly[w++] = b; for (let k = 0; k < sBC.length; k++) poly[w++] = sBC[k];
      poly[w++] = c; for (let k = 0; k < sCA.length; k++) poly[w++] = sCA[k];
      for (let i = 1; i < poly.length - 1; i++) newIdx.push(poly[0], poly[i], poly[i + 1]);
      totalSplitsApplied += poly.length - 3;
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', geometry.attributes.position);
    if (geometry.attributes.uv) out.setAttribute('uv', geometry.attributes.uv);
    if (geometry.attributes.normal) out.setAttribute('normal', geometry.attributes.normal);
    out.setIndex(newIdx);
    out.computeVertexNormals();
    out.userData.__tjunctionSplits = totalSplitsApplied;
    return out;
  }

  // ---------- 3) Remove overlapping triangles ----------
  removeOverlappingTriangles(geometry, posEps = 1e-6) {
    MeshRepairer._ensureIndexed(geometry);
    const pos = geometry.attributes.position.array;
    const idx = Array.from(geometry.index.array);
    const keyOf = (a, b, c) => {
      const pts = [a, b, c].map(i => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
      pts.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
      return pts.map(p => {
        return `${Math.round(p[0] / posEps)}|${Math.round(p[1] / posEps)}|${Math.round(p[2] / posEps)}`;
      }).join("|");
    };
    const seen = new Set();
    const newIdx = [];
    let removed = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const key = keyOf(idx[t], idx[t + 1], idx[t + 2]);
      if (seen.has(key)) { removed++; continue; }
      seen.add(key);
      newIdx.push(idx[t], idx[t + 1], idx[t + 2]);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', geometry.attributes.position);
    if (geometry.attributes.uv) out.setAttribute('uv', geometry.attributes.uv);
    if (geometry.attributes.normal) out.setAttribute('normal', geometry.attributes.normal);
    out.setIndex(newIdx);
    out.computeVertexNormals();
    out.userData.__overlapsRemoved = removed;
    return out;
  }

  // ---------- 4) Fill holes ----------
  fillHoles(geometry) {
    MeshRepairer._ensureIndexed(geometry);
    const { pos } = MeshRepairer._getArrays(geometry);
    const idx = Array.from(geometry.index.array);

    const edgeUse = MeshRepairer._buildEdgeUse(idx);
    const boundary = MeshRepairer._boundaryEdges(edgeUse);
    const loops = MeshRepairer._buildBoundaryLoops(boundary);

    const addedTris = [];
    for (const loop of loops) {
      if (loop.length < 3) continue;
      const pts3 = loop.map(i => MeshRepairer._vec3Of(pos, i));
      const n = MeshRepairer._newellNormal(pts3);
      const basis = MeshRepairer._basisFromNormal(n);
      const loop2D = MeshRepairer._projectToPlane(pts3, basis);
      const area = MeshRepairer._polyArea2D(loop2D);
      const order = area >= 0 ? loop.slice() : loop.slice().reverse();
      const loop2Dccw = area >= 0 ? loop2D : loop2D.slice().reverse();
      const trisLocal = MeshRepairer._earClip2D(loop2Dccw);
      for (const [i0, i1, i2] of trisLocal) {
        addedTris.push(order[i0], order[i1], order[i2]);
      }
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', geometry.attributes.position);
    if (geometry.attributes.uv) out.setAttribute('uv', geometry.attributes.uv);
    if (geometry.attributes.normal) out.setAttribute('normal', geometry.attributes.normal);
    out.setIndex(idx.concat(addedTris));
    out.computeVertexNormals();
    out.userData.__boundaryEdges = boundary.length;
    out.userData.__holesFilled = addedTris.length / 3;
    this.fixTriangleNormals(out);
    this.fixTriangleNormals(out);
    this.fixTriangleNormals(out);
    return out;
  }

  // (removed) 4.5) Split self-intersections and discard interior triangles

  // ---------- 5) Fix triangle normals (consistent winding + outward orientation) ----------
  fixTriangleNormals(geometry) {
    MeshRepairer._ensureIndexed(geometry);
    const idx = Array.from(geometry.index.array);
    const pos = geometry.attributes.position.array;

    // For each unordered edge, track the two triangles and their local edge directions
    const triCount = idx.length / 3;
    const triVerts = Array.from({ length: triCount }, (_, t) => [idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]]);
    const edgeToTris = new Map(); // key -> [{t, dir:+1/-1 w.r.t (i->j) in that tri}, ...]

    function addEdge(t, i, j) {
      const key = MeshRepairer._edgeKey(i, j);
      const dir = (i < j) ? +1 : -1; // store whether tri uses (min->max) or (max->min)
      if (!edgeToTris.has(key)) edgeToTris.set(key, []);
      edgeToTris.get(key).push({ t, dir });
    }

    for (let t = 0; t < triCount; t++) {
      const [a, b, c] = triVerts[t];
      addEdge(t, a, b);
      addEdge(t, b, c);
      addEdge(t, c, a);
    }

    // BFS to make windings consistent
    const visited = new Uint8Array(triCount);
    const flip = new Uint8Array(triCount); // 0 keep, 1 flip

    for (let seed = 0; seed < triCount; seed++) {
      if (visited[seed]) continue;
      visited[seed] = 1;
      flip[seed] = 0;
      const q = [seed];

      while (q.length) {
        const t = q.shift();
        const [a, b, c] = triVerts[t];
        const edges = [[a, b], [b, c], [c, a]];

        for (const [i, j] of edges) {
          const key = MeshRepairer._edgeKey(i, j);
          const group = edgeToTris.get(key) || [];
          // Determine our local direction for this unordered edge:
          const ourDir = (i < j) ? +1 : -1;

          for (const { t: u, dir: neighborDir } of group) {
            if (u === t || visited[u]) continue;

            // If both triangles reference the shared edge with the SAME direction,
            // neighbor must be flipped relative to us; else keep parity.
            const sameDirection = (neighborDir === ourDir);
            flip[u] = flip[t] ^ (sameDirection ? 1 : 0);
            visited[u] = 1;
            q.push(u);
          }
        }
      }
    }

    // Apply flips for consistency
    for (let t = 0; t < triCount; t++) {
      if (flip[t]) {
        const base = 3 * t;
        const tmp = idx[base + 1];
        idx[base + 1] = idx[base + 2];
        idx[base + 2] = tmp;
        // Update triVerts for volume calc
        const [a, b, c] = triVerts[t];
        triVerts[t] = [a, c, b];
      }
    }

    // Outward orientation using signed volume (if roughly closed)
    let vol6 = 0.0;
    for (let t = 0; t < triCount; t++) {
      const [a, b, c] = triVerts[t];
      const A = MeshRepairer._vec3Of(pos, a);
      const B = MeshRepairer._vec3Of(pos, b);
      const C = MeshRepairer._vec3Of(pos, c);
      const AxB = MeshRepairer._cross(A, B);
      vol6 += MeshRepairer._dot(AxB, C);
    }
    if (Math.abs(vol6) > 1e-18 && vol6 < 0) {
      for (let t = 0; t < idx.length; t += 3) {
        const tmp = idx[t + 1];
        idx[t + 1] = idx[t + 2];
        idx[t + 2] = tmp;
      }
    }

    const out = new THREE.BufferGeometry();
    out.setAttribute('position', geometry.attributes.position);
    if (geometry.attributes.uv) out.setAttribute('uv', geometry.attributes.uv);
    if (geometry.attributes.normal) out.setAttribute('normal', geometry.attributes.normal);
    out.setIndex(idx);
    out.computeVertexNormals();
    return out;
  }

  // ---------- Convenience pipeline ----------
  repairAll(geometry, { weldEps = 5e-4, lineEps = 5e-4, gridCell = 0.01 } = {}) {
    let g = this.weldVertices(geometry, weldEps);
    g = this.fixTJunctions(g, lineEps, gridCell);
    g = this.removeOverlappingTriangles(g);
    g = this.fillHoles(g);
    g = this.fixTriangleNormals(g);
    g = this.fillHoles(g);
    g = this.fixTriangleNormals(g);
    g.computeVertexNormals();
    return g;
  }
}
