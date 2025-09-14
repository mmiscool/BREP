import { Solid } from './BetterSolid.js';
import * as THREE from 'three';
const DEBUG = false;

export class FacesSolid extends Solid {
  constructor({ name = 'FromFaces' } = {}) {
    super();
    this.name = name;
  }

  /**
   * Reads this Group's descendant meshes, packs geometry arrays, and seeds
   * per-triangle labels and face name mapping based on each mesh's name.
   * After calling, this Solid can visualize and participate in booleans.
   * Returns `this` for chaining.
   */
  manifoldFromFaces() {
    // Ensure world transforms are up to date
    if (DEBUG) console.log(`[FacesSolid] manifoldFromFaces start: name=${this.name}`);
    this.updateWorldMatrix(true, true);

    // Collect meshes recursively under this Solid. Exclude line-based helpers (Line/Line2/etc.)
    const meshes = [];
    this.traverse(obj => {
      if (!obj || !obj.isMesh || !obj.geometry) return;
      // Skip any kind of line visuals (Line, Line2, LineSegments, LineLoop)
      if (obj.isLine || obj.isLine2 || obj.isLineSegments || obj.isLineLoop) return;
      meshes.push(obj);
    });
    if (DEBUG) console.log(`[FacesSolid] found ${meshes.length} mesh children:`, meshes.map(m => m.name));
    if (meshes.length === 0) {
      throw new Error('FacesSolid.manifoldFromFaces: no meshes found under this group');
    }

    // Determine totals
    let totalVerts = 0;
    let totalTriIndices = 0;
    let totalTris = 0;
    const entries = [];
    for (const mesh of meshes) {
      const geom = mesh.geometry;
      const posAttr = geom.getAttribute('position');
      if (!posAttr) continue;
      const vCount = posAttr.count >>> 0;
      const indexAttr = geom.getIndex();
      let triCount;
      if (indexAttr) triCount = (indexAttr.count / 3) >>> 0;
      else triCount = (vCount / 3) >>> 0;
      if (vCount === 0 || triCount === 0) continue;
      entries.push({ mesh, vCount, triCount, indexed: !!indexAttr });
      totalVerts += vCount;
      totalTris += triCount;
      totalTriIndices += triCount * 3;
    }
    if (entries.length === 0) {
      throw new Error('FacesSolid.manifoldFromFaces: no valid triangle meshes found');
    }
    if (DEBUG) console.log(`[FacesSolid] totals before weld: verts=${totalVerts}, tris=${totalTris}`);

    // Weld vertices across meshes by exact-coordinate keys (no tolerance snapping).
    // Accumulate canonical vertices and remap triangle indices accordingly.
    const numProp = 3;
    const faceInfo = {};
    // No tolerance: use exact float string keys for positions
    const keyOf = (x, y, z) => `${x},${y},${z}`;
    const key2canon = new Map();
    const canonPos = [];
    let canonCount = 0;
    const triVertsDyn = [];
    const triLabelsDyn = [];
    let nextLabel = 1;
    const v = new THREE.Vector3();

    for (const { mesh, vCount, triCount, indexed } of entries) {
      const geom = mesh.geometry;
      const posAttr = geom.getAttribute('position');
      const indexAttr = geom.getIndex();
      const label = nextLabel++;
      const meshName = mesh.name || `Face_${label}`;
      faceInfo[label] = { name: meshName };

      // Build local map: original vertex index -> canonical index
      const local2canon = new Uint32Array(vCount);
      for (let i = 0; i < vCount; i++) {
        v.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
        const key = keyOf(v.x, v.y, v.z);
        let ci = key2canon.get(key);
        if (ci == null) {
          ci = canonCount++;
          key2canon.set(key, ci);
          canonPos.push(v.x, v.y, v.z);
        }
        local2canon[i] = ci;
      }

      if (indexed && indexAttr) {
        for (let k = 0; k < triCount; k++) {
          const a = local2canon[indexAttr.getX(3 * k + 0) >>> 0];
          const b = local2canon[indexAttr.getX(3 * k + 1) >>> 0];
          const c = local2canon[indexAttr.getX(3 * k + 2) >>> 0];
          if (a === b || b === c || c === a) continue; // drop degenerate
          triVertsDyn.push(a, b, c);
          triLabelsDyn.push(label);
        }
      } else {
        for (let k = 0; k < triCount; k++) {
          const a = local2canon[3 * k + 0];
          const b = local2canon[3 * k + 1];
          const c = local2canon[3 * k + 2];
          if (a === b || b === c || c === a) continue;
          triVertsDyn.push(a, b, c);
          triLabelsDyn.push(label);
        }
      }
    }

    const vertProperties = new Float32Array(canonPos);
    const triVerts = new Uint32Array(triVertsDyn);
    const triLabels = new Uint32Array(triLabelsDyn);
    // Extra sanity log: max index
    let maxIndex = 0;
    for (let i = 0; i < triVerts.length; i++) if (triVerts[i] > maxIndex) maxIndex = triVerts[i];
    if (maxIndex >= (vertProperties.length / numProp)) {
      console.error('[FacesSolid] index OOB before setArrays', { maxIndex, vCount: vertProperties.length / numProp });
    }
    const dropped = totalTris - triLabels.length;
    if (DEBUG) console.log(`[FacesSolid] after weld: verts=${vertProperties.length / numProp}, tris=${triVerts.length / 3}, droppedDegenerate=${dropped}`);

    // Install arrays onto this Solid; Manifold will be built on demand
    this.setArrays({ numProp, vertProperties, triVerts, triLabels, faceInfo });
    if (DEBUG) console.log('[FacesSolid] setArrays done:', { numProp, vCount: vertProperties.length / numProp, triCount: triVerts.length / 3 });

    // Seed faceNames for provenance-aligned display
    const inner = new Map();
    for (const [labelStr, info] of Object.entries(faceInfo)) {
      inner.set(Number(labelStr), info?.name ?? `Face_${labelStr}`);
    }
    const faceNames = new Map();
    faceNames.set(this._originalID, inner);
    this.faceNames = faceNames;
    if (DEBUG) console.log('[FacesSolid] faceNames seeded for originalID', this._originalID, 'labels:', Array.from(inner.entries()));

    return this;
  }
}

/**
 * Sweep: extrude a single Face by a vector (from a path or distance).
 * - Caps use the input face triangles directly; start cap is reversed.
 * - Side faces are generated per face edge (one face per input edge)
 *   and named `${edgeName}_SW`.
 */
export class Sweep extends FacesSolid {
  constructor({ face, sweepPathEdges = [], distance = 1, mode = 'translate', name = 'Sweep' } = {}) {
    super({ name });
    this.params = { face, distance, sweepPathEdges, mode, name };
    this.generate();
  }

  generate() {
    const { face, distance, sweepPathEdges, mode } = this.params;
    if (!face || !face.geometry) return;

    // Clear any existing children (visualization) and reset authoring arrays
    for (let i = this.children.length - 1; i >= 0; --i) this.remove(this.children[i]);
    // Reset Solid authoring state to rebuild fresh
    this._numProp = 3;
    this._vertProperties = [];
    this._triVerts = [];
    this._triIDs = [];
    this._vertKeyToIndex = new Map();
    this._faceNameToID = new Map();
    this._idToFaceName = new Map();
    this._dirty = true;
    this._manifold = null;
    this._faceIndex = null;

    // Helper to extract world-space polyline from an edge-like object
    const extractPathPolylineWorld = (edgeObj) => {
      const pts = [];
      const cached = edgeObj?.userData?.polylineLocal;
      const isWorld = !!(edgeObj?.userData?.polylineWorld);
      const v = new THREE.Vector3();
      if (Array.isArray(cached) && cached.length >= 2) {
        if (isWorld) {
          for (const p of cached) pts.push([p[0], p[1], p[2]]);
        } else {
          for (const p of cached) {
            v.set(p[0], p[1], p[2]).applyMatrix4(edgeObj.matrixWorld);
            pts.push([v.x, v.y, v.z]);
          }
        }
      } else {
        const posAttr = edgeObj?.geometry?.getAttribute?.('position');
        if (posAttr && posAttr.itemSize === 3 && posAttr.count >= 2) {
          for (let i = 0; i < posAttr.count; i++) {
            v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(edgeObj.matrixWorld);
            pts.push([v.x, v.y, v.z]);
          }
        } else {
          const aStart = edgeObj?.geometry?.attributes?.instanceStart;
          const aEnd = edgeObj?.geometry?.attributes?.instanceEnd;
          if (aStart && aEnd && aStart.itemSize === 3 && aEnd.itemSize === 3 && aStart.count === aEnd.count && aStart.count >= 1) {
            v.set(aStart.getX(0), aStart.getY(0), aStart.getZ(0)).applyMatrix4(edgeObj.matrixWorld);
            pts.push([v.x, v.y, v.z]);
            for (let i = 0; i < aEnd.count; i++) {
              v.set(aEnd.getX(i), aEnd.getY(i), aEnd.getZ(i)).applyMatrix4(edgeObj.matrixWorld);
              pts.push([v.x, v.y, v.z]);
            }
          }
        }
      }
      // remove consecutive duplicates
      for (let i = pts.length - 2; i >= 0; i--) {
        const a = pts[i], b = pts[i + 1];
        if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) pts.splice(i + 1, 1);
      }
      return pts;
    };

    // Build a single combined path from multiple selected edges by chaining
    // Matches both start and end points with tolerance and orders edges into
    // a continuous polyline (prefers endpoints with degree 1 when available).
    const combinePathPolylines = (edges, tol = 1e-5) => {
      if (!Array.isArray(edges) || edges.length === 0) return [];
      const polys = [];
      for (const e of edges) {
        const p = extractPathPolylineWorld(e);
        if (p.length >= 2) polys.push(p);
      }
      if (polys.length === 0) return [];

      // Derive an adaptive tolerance based on scale if caller used default
      if (tol === 1e-5) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const segLens = [];
        for (const p of polys) {
          for (let i = 0; i < p.length; i++) {
            const v = p[i];
            if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
            if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
            if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
            if (i > 0) {
              const a = p[i - 1]; const b = v;
              const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
              segLens.push(Math.hypot(dx, dy, dz));
            }
          }
        }
        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        const diag = Math.hypot(dx, dy, dz) || 1;
        segLens.sort((a, b) => a - b);
        const med = segLens.length ? segLens[(segLens.length >> 1)] : diag;
        // Allow up to 0.1% of diag, capped to 10% of median segment length
        const adaptive = Math.min(Math.max(1e-5, diag * 1e-3), med * 0.1);
        tol = adaptive;
      }

      const tol2 = tol * tol;
      const d2 = (a, b) => {
        const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
        return dx * dx + dy * dy + dz * dz;
      };
      const q = (v) => [
        Math.round(v[0] / tol) * tol,
        Math.round(v[1] / tol) * tol,
        Math.round(v[2] / tol) * tol,
      ];
      const k = (v) => `${v[0]},${v[1]},${v[2]}`;

      // Build endpoint graph: node key -> { p:[x,y,z], edges: Set(index) }
      const nodes = new Map();
      const endpoints = []; // [{sKey,eKey} per poly]
      const addNode = (pt) => {
        const qp = q(pt);
        const key = k(qp);
        if (!nodes.has(key)) nodes.set(key, { p: qp, edges: new Set() });
        return key;
      };
      for (let i = 0; i < polys.length; i++) {
        const p = polys[i];
        const sKey = addNode(p[0]);
        const eKey = addNode(p[p.length - 1]);
        nodes.get(sKey).edges.add(i);
        nodes.get(eKey).edges.add(i);
        endpoints.push({ sKey, eKey });
      }

      // Pick a start: prefer a node with odd degree (open chain); else any
      let startNodeKey = null;
      for (const [key, val] of nodes.entries()) {
        if ((val.edges.size % 2) === 1) { startNodeKey = key; break; }
      }
      if (!startNodeKey) startNodeKey = nodes.keys().next().value;

      const used = new Array(polys.length).fill(false);
      const chain = [];

      // Helper to append a polyline ensuring joints aren’t duplicated
      const appendPoly = (poly, reverse = false) => {
        const pts = reverse ? poly.slice().reverse() : poly;
        if (chain.length === 0) { chain.push(...pts); return; }
        // remove duplicated joint
        const last = chain[chain.length - 1];
        const first = pts[0];
        if (d2(last, first) <= tol2) chain.push(...pts.slice(1));
        else chain.push(...pts);
      };

      // Grow forward from chosen start
      let cursorKey = startNodeKey;
      // If multiple edges at the start node, just pick one arbitrarily and then greedily continue
      const tryConsumeFromNode = (nodeKey) => {
        const node = nodes.get(nodeKey);
        if (!node) return false;
        for (const ei of Array.from(node.edges)) {
          if (used[ei]) continue;
          const { sKey, eKey } = endpoints[ei];
          const forward = (sKey === nodeKey);
          used[ei] = true;
          // Remove this edge index from both endpoint sets for cleanliness
          nodes.get(sKey)?.edges.delete(ei);
          nodes.get(eKey)?.edges.delete(ei);
          appendPoly(polys[ei], !forward); // if we enter at end, reverse to keep continuity
          cursorKey = forward ? eKey : sKey;
          return true;
        }
        return false;
      };

      // Seed chain: if start node has no edges (deg 0), bail
      if (!tryConsumeFromNode(cursorKey)) {
        // Fall back to simple greedy merge of all polylines
        const simple = polys[0].slice();
        const used2 = new Array(polys.length).fill(false); used2[0] = true;
        let extended = true;
        while (extended) {
          extended = false;
          for (let i = 1; i < polys.length; i++) {
            if (used2[i]) continue;
            const curStart = simple[0];
            const curEnd = simple[simple.length - 1];
            const p = polys[i];
            const pStart = p[0];
            const pEnd = p[p.length - 1];
            if (d2(curEnd, pStart) <= tol2) { simple.push(...p.slice(1)); used2[i] = true; extended = true; continue; }
            if (d2(curEnd, pEnd) <= tol2) { const rev = p.slice().reverse(); simple.push(...rev.slice(1)); used2[i] = true; extended = true; continue; }
            if (d2(curStart, pEnd) <= tol2) { simple.unshift(...p.slice(0, p.length - 1)); used2[i] = true; extended = true; continue; }
            if (d2(curStart, pStart) <= tol2) { const rev = p.slice().reverse(); simple.unshift(...rev.slice(0, rev.length - 1)); used2[i] = true; extended = true; continue; }
          }
        }
        // de-dupe consecutive
        for (let i = simple.length - 2; i >= 0; i--) { const a = simple[i], b = simple[i + 1]; if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) simple.splice(i + 1, 1); }
        return simple;
      }

      // Continue consuming until stuck
      while (tryConsumeFromNode(cursorKey)) { }

      // If some edges remain unused (disconnected components), return the longest chain across components
      let best = chain.slice();
      for (let s = 0; s < polys.length; s++) {
        if (used[s]) continue;
        // Build a local chain from this unused edge
        const localUsed = new Array(polys.length).fill(false);
        const localChain = [];
        const sEnds = endpoints[s];
        const startForward = true; // arbitrary orientation
        localUsed[s] = true;
        const append = (poly, reverse = false) => {
          const pts = reverse ? poly.slice().reverse() : poly;
          if (localChain.length === 0) { localChain.push(...pts); return; }
          const last = localChain[localChain.length - 1];
          const first = pts[0];
          if (d2(last, first) <= tol2) localChain.push(...pts.slice(1)); else localChain.push(...pts);
        };
        append(polys[s], !startForward);
        let head = k(q(localChain[0]));
        let tail = k(q(localChain[localChain.length - 1]));
        let grew = true;
        while (grew) {
          grew = false;
          for (let i = 0; i < polys.length; i++) {
            if (localUsed[i]) continue;
            const { sKey, eKey } = endpoints[i];
            if (sKey === tail) { append(polys[i], false); tail = eKey; localUsed[i] = true; grew = true; continue; }
            if (eKey === tail) { append(polys[i], true); tail = sKey; localUsed[i] = true; grew = true; continue; }
            if (eKey === head) { const pts = polys[i].slice(); localChain.unshift(...pts.slice(0, pts.length - 1)); head = sKey; localUsed[i] = true; grew = true; continue; }
            if (sKey === head) { const pts = polys[i].slice().reverse(); localChain.unshift(...pts.slice(0, pts.length - 1)); head = eKey; localUsed[i] = true; grew = true; continue; }
          }
        }
        if (localChain.length > best.length) best = localChain;
      }

      // Remove duplicate consecutive points in final result
      for (let i = best.length - 2; i >= 0; i--) {
        const a = best[i], b = best[i + 1];
        if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) best.splice(i + 1, 1);
      }
      return best;
    };

    // Determine whether to sweep along a path edge
    let pathPts = [];
    if (Array.isArray(sweepPathEdges) && sweepPathEdges.length > 0) {
      const edges = sweepPathEdges.filter(Boolean);
      if (edges.length > 0) pathPts = combinePathPolylines(edges);
    }

    // Refine the path to avoid harsh kinks causing self-intersections.
    // - Only used for pathAlign mode. Translate mode keeps only segment joints.
    // - Subdivide long segments to a target length based on model scale.
    // - Add small pre/post points around sharp corners to ease orientation.
    const refinePath = (pts) => {
      if (!Array.isArray(pts) || pts.length < 2) return pts || [];
      // Compute scale
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const p of pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2]; }
      const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
      const target = Math.min(diag * 0.03, Math.max(diag * 0.005, 1e-4)); // 0.5%..3% of diag

      const out = [];
      const V = (a, b) => [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const L = (v) => Math.hypot(v[0], v[1], v[2]);
      const N = (v) => { const l = L(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
      const add = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      out.push(pts[0]);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const seg = V(a, b); const len = L(seg);
        // Subdivide long segments
        const n = Math.max(0, Math.min(20, Math.ceil(len / target) - 1));
        for (let k = 1; k <= n; k++) out.push(add(a, b, k / (n + 1)));
        out.push(b);
      }

      // Soften sharp joints by inserting small offsets around the corner
      const softened = [];
      softened.push(out[0]);
      for (let i = 1; i < out.length - 1; i++) {
        const p0 = out[i - 1], p1 = out[i], p2 = out[i + 1];
        const v0 = N(V(p1, p0));
        const v1 = N(V(p1, p2));
        const dot = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2];
        const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
        // Corner if turning more than ~35 degrees
        if (ang > (35 * Math.PI / 180)) {
          const d0 = L(V(p0, p1));
          const d1 = L(V(p1, p2));
          const s = 0.12 * Math.min(d0, d1);
          const pre = [p1[0] - v0[0] * s, p1[1] - v0[1] * s, p1[2] - v0[2] * s];
          const post = [p1[0] - v1[0] * s, p1[1] - v1[1] * s, p1[2] - v1[2] * s];
          // Only keep if not degenerate
          const nearEq = (A, B) => Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) < 1e-8;
          const last = softened[softened.length - 1];
          if (!nearEq(last, pre)) softened.push(pre);
          softened.push(p1);
          if (!nearEq(p1, post)) softened.push(post);
        } else {
          softened.push(p1);
        }
      }
      softened.push(out[out.length - 1]);
      // Final pass: remove exact duplicates
      for (let i = softened.length - 2; i >= 0; i--) {
        const a = softened[i], b = softened[i + 1];
        if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) softened.splice(i + 1, 1);
      }
      return softened;
    };
    // Translate mode should only place cross sections at segment joints.
    // For pathAlign we may refine to improve frame stability.
    if (pathPts.length >= 2) {
      if (mode === 'pathAlign') {
        pathPts = refinePath(pathPts);
      } else {
        // Simplify by removing collinear interior points
        const isCollinear = (a, b, c, eps = 1e-12) => {
          const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
          const bcx = c[0] - b[0], bcy = c[1] - b[1], bcz = c[2] - b[2];
          const cx = aby * bcz - abz * bcy;
          const cy = abz * bcx - abx * bcz;
          const cz = abx * bcy - aby * bcx;
          return (cx*cx + cy*cy + cz*cz) <= eps;
        };
        const simplified = [];
        simplified.push(pathPts[0]);
        for (let i = 1; i < pathPts.length - 1; i++) {
          const prev = simplified[simplified.length - 1];
          const cur = pathPts[i];
          const next = pathPts[i + 1];
          // Drop if exactly duplicated or strictly collinear between prev and next
          if ((cur[0] === prev[0] && cur[1] === prev[1] && cur[2] === prev[2]) || isCollinear(prev, cur, next)) continue;
          simplified.push(cur);
        }
        simplified.push(pathPts[pathPts.length - 1]);
        // Remove any remaining consecutive duplicates
        for (let i = simplified.length - 2; i >= 0; i--) {
          const a = simplified[i], b = simplified[i + 1];
          if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) simplified.splice(i + 1, 1);
        }
        pathPts = simplified;
      }
    }

    // Orient path so it starts near the profile face centroid (if available)
    if (pathPts.length >= 2) {
      let centroid = null;
      const loops = Array.isArray(face?.userData?.boundaryLoopsWorld) ? face.userData.boundaryLoopsWorld : null;
      if (loops && loops.length) {
        // use first outer loop (isHole !== true)
        const outer = loops.find(l => !l.isHole) || loops[0];
        const pts = Array.isArray(outer?.pts) ? outer.pts : outer;
        if (Array.isArray(pts) && pts.length >= 3) {
          centroid = new THREE.Vector3();
          for (const p of pts) centroid.add(new THREE.Vector3(p[0], p[1], p[2]));
          centroid.multiplyScalar(1 / pts.length);
        }
      }
      if (!centroid) {
        // fallback to face geometry centroid
        const posAttr = face?.geometry?.getAttribute?.('position');
        if (posAttr) {
          centroid = new THREE.Vector3();
          const v = new THREE.Vector3();
          for (let i = 0; i < posAttr.count; i++) {
            v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(face.matrixWorld);
            centroid.add(v);
          }
          centroid.multiplyScalar(1 / Math.max(1, posAttr.count));
        }
      }
      if (centroid) {
        const d2 = (a, b) => { const dx = a[0] - b.x, dy = a[1] - b.y, dz = a[2] - b.z; return dx * dx + dy * dy + dz * dz; };
        const startD = d2(pathPts[0], centroid);
        const endD = d2(pathPts[pathPts.length - 1], centroid);
        if (endD < startD) pathPts.reverse();
      }
    }

    // Build offsets along path (relative to first point)
    let offsets = [];
    if (pathPts.length >= 2) {
      const p0 = pathPts[0];
      for (let i = 0; i < pathPts.length; i++) {
        const p = pathPts[i];
        offsets.push(new THREE.Vector3(p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]));
      }
      // Collapse near-duplicate steps to avoid zero-area side faces
      const filtered = [offsets[0]];
      for (let i = 1; i < offsets.length; i++) {
        const prev = filtered[filtered.length - 1];
        const cur = offsets[i];
        const d2 = cur.clone().sub(prev).lengthSq();
        if (d2 > 1e-14) filtered.push(cur);
      }
      offsets = filtered;
    }

    // Determine sweep vector for cap translation only (single-shot extrude or end cap of path)
    let dir = null;
    if (offsets.length >= 2) {
      dir = offsets[offsets.length - 1].clone();
    } else if (distance instanceof THREE.Vector3) {
      dir = distance.clone();
    } else if (typeof distance === 'number') {
      const n = typeof face.getAverageNormal === 'function'
        ? face.getAverageNormal().clone()
        : new THREE.Vector3(0, 1, 0);
      dir = n.multiplyScalar(distance);
    } else {
      dir = new THREE.Vector3(0, 1, 0);
    }

    const startName = `${face.name || 'Face'}_START`;
    const endName = `${face.name || 'Face'}_END`;

    // Note: pathAlign support removed. If reintroducing, add helpers here.

    // Prefer rebuilding caps using 2D profile groups from the sketch to ensure
    // identical boundary vertices with side walls.
    const groups = Array.isArray(face?.userData?.profileGroups) ? face.userData.profileGroups : null;
    if (groups && groups.length) {
      // Translate-only caps
      for (const g of groups) {
        const contour2D = g.contour2D || [];
        const holes2D = g.holes2D || [];
        const contourW = g.contourW || [];
        const holesW = g.holesW || [];
        if (contour2D.length < 3 || contourW.length !== contour2D.length) continue;
        // triangulate using 2D; index into world array built as contourW + holesW
        const contourV2 = contour2D.map(p => new THREE.Vector2(p[0], p[1]));
        const holesV2 = holes2D.map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
        const tris = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);
        const allW = contourW.concat(...holesW);
        for (const t of tris) {
          const p0 = allW[t[0]], p1 = allW[t[1]], p2 = allW[t[2]];
          // Start cap reversed
          this.addTriangle(startName, p0, p2, p1);
          // End cap: translate-only (pathAlign TODO)
          const q0 = [p0[0] + dir.x, p0[1] + dir.y, p0[2] + dir.z];
          const q1 = [p1[0] + dir.x, p1[1] + dir.y, p1[2] + dir.z];
          const q2 = [p2[0] + dir.x, p2[1] + dir.y, p2[2] + dir.z];
          this.addTriangle(endName, q0, q1, q2);
        }
      }
    } else {
      // Fallback: use face geometry
      const baseGeom = face.geometry;
      const posAttr = baseGeom.getAttribute('position');
      if (!posAttr) return;
      const idxAttr = baseGeom.getIndex();
      const hasIndex = !!idxAttr;
      // Build world-space vertex array for the face once
      const faceWorld = new Array(posAttr.count);
      const v = new THREE.Vector3();
      for (let i = 0; i < posAttr.count; i++) {
        v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(face.matrixWorld);
        faceWorld[i] = [v.x, v.y, v.z];
      }
      // Translate-only caps; no path/frame alignment needed

      const addCapTris = (i0, i1, i2) => {
        const p0 = faceWorld[i0], p1 = faceWorld[i1], p2 = faceWorld[i2];
        this.addTriangle(startName, p0, p2, p1);
        const q0 = [p0[0] + dir.x, p0[1] + dir.y, p0[2] + dir.z];
        const q1 = [p1[0] + dir.x, p1[1] + dir.y, p1[2] + dir.z];
        const q2 = [p2[0] + dir.x, p2[1] + dir.y, p2[2] + dir.z];
        this.addTriangle(endName, q0, q1, q2);
      };
      if (hasIndex) {
        for (let t = 0; t < idxAttr.count; t += 3) {
          const i0 = idxAttr.getX(t + 0) >>> 0;
          const i1 = idxAttr.getX(t + 1) >>> 0;
          const i2 = idxAttr.getX(t + 2) >>> 0;
          addCapTris(i0, i1, i2);
        }
      } else {
        const triCount = (posAttr.count / 3) >>> 0;
        for (let t = 0; t < triCount; t++) {
          const i0 = 3 * t + 0, i1 = 3 * t + 1, i2 = 3 * t + 2;
          addCapTris(i0, i1, i2);
        }
      }
    }

    // Side faces: Prefer boundary loops to ensure vertex matching with caps.
    // This avoids T-junctions and ensures a watertight manifold. If loops are
    // unavailable (legacy faces), fall back to per-edge polylines.
    const boundaryLoops = Array.isArray(face?.userData?.boundaryLoopsWorld) ? face.userData.boundaryLoopsWorld : null;
    const doPathSweep = offsets.length >= 2;
    if (boundaryLoops && boundaryLoops.length) {
      // Build a quick lookup from boundary points to their originating sketch edge(s)
      // so we can label side walls per curve while still using cap-matching vertices.
      const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;
      const edges = Array.isArray(face?.edges) ? face.edges : [];
      const pointToEdgeNames = new Map(); // key -> Set(edgeName)
      for (const e of edges) {
        const name = `${e?.name || 'EDGE'}_SW`;
        const poly = e?.userData?.polylineLocal;
        const isWorld = !!(e?.userData?.polylineWorld);
        if (Array.isArray(poly) && poly.length >= 2) {
          for (const p of poly) {
            const w = isWorld ? p : new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(e.matrixWorld),
              arr = Array.isArray(w) ? w : [w.x, w.y, w.z];
            const k = key(arr);
            let set = pointToEdgeNames.get(k);
            if (!set) { set = new Set(); pointToEdgeNames.set(k, set); }
            set.add(name);
          }
        } else {
          // Fallback: positions attribute if present
          const pos = e?.geometry?.getAttribute?.('position');
          if (pos && pos.itemSize === 3) {
            const v = new THREE.Vector3();
            for (let i = 0; i < pos.count; i++) {
              v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(e.matrixWorld);
              const k = key([v.x, v.y, v.z]);
              let set = pointToEdgeNames.get(k);
              if (!set) { set = new Set(); pointToEdgeNames.set(k, set); }
              set.add(name);
            }
          }
        }
      }

      // pathAlign removed: no frame alignment
      const frames = null;

      for (const loop of boundaryLoops) {
        const pts = Array.isArray(loop?.pts) ? loop.pts : loop;
        const isHole = !!(loop && loop.isHole);
        const base = pts.slice();
        // ensure closed
        if (base.length >= 2) {
          const first = base[0];
          const last = base[base.length - 1];
          if (!(first[0] === last[0] && first[1] === last[1] && first[2] === last[2])) base.push([first[0], first[1], first[2]]);
        }
        // remove consecutive duplicates if any
        for (let i = base.length - 2; i >= 0; i--) {
          const a = base[i], b = base[i + 1];
          if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) base.splice(i + 1, 1);
        }

        if (!doPathSweep) {
          // single-vector extrude (original behavior)
          for (let i = 0; i < base.length - 1; i++) {
            const a = base[i];
            const b = base[i + 1];
            if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
            const a2 = [a[0] + dir.x, a[1] + dir.y, a[2] + dir.z];
            const b2 = [b[0] + dir.x, b[1] + dir.y, b[2] + dir.z];
            const setA = pointToEdgeNames.get(key(a));
            const setB = pointToEdgeNames.get(key(b));
            let name = `${face.name || 'FACE'}_SW`;
            if (setA && setB) { for (const n of setA) { if (setB.has(n)) { name = n; break; } } }
            if (isHole) {
              this.addTriangle(name, a, b2, b);
              this.addTriangle(name, a, a2, b2);
            } else {
              this.addTriangle(name, a, b, b2);
              this.addTriangle(name, a, b2, a2);
            }
          }
        } else {
          // Path sweep: translate-only between successive offsets (pathAlign removed)
          for (let seg = 0; seg < offsets.length - 1; seg++) {
            const off0 = offsets[seg], off1 = offsets[seg + 1];
            if (off1.x === off0.x && off1.y === off0.y && off1.z === off0.z) continue;
            for (let i = 0; i < base.length - 1; i++) {
              const a = base[i];
              const b = base[i + 1];
              if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
              const A0 = [a[0] + off0.x, a[1] + off0.y, a[2] + off0.z];
              const B0 = [b[0] + off0.x, b[1] + off0.y, b[2] + off0.z];
              const A1 = [a[0] + off1.x, a[1] + off1.y, a[2] + off1.z];
              const B1 = [b[0] + off1.x, b[1] + off1.y, b[2] + off1.z];
              const setA = pointToEdgeNames.get(key(a));
              const setB = pointToEdgeNames.get(key(b));
              let name = `${face.name || 'FACE'}_SW`;
              if (setA && setB) { for (const n of setA) { if (setB.has(n)) { name = n; break; } } }
              if (isHole) { this.addTriangle(name, A0, B1, B0); this.addTriangle(name, A0, A1, B1); }
              else { this.addTriangle(name, A0, B0, B1); this.addTriangle(name, A0, B1, A1); }
            }
          }
        }
      }
    } else {
      // Fallback: build from per-edge polylines (may not match cap vertices exactly)
      const edges = Array.isArray(face.edges) ? face.edges : [];
      if (edges.length) {
        // pathAlign removed: translate-only per-edge fallback
        for (const edge of edges) {
          const name = `${edge.name || 'EDGE'}_SW`;

          // Robustly extract world-space polyline points
          const pA = [];
          const wv = new THREE.Vector3();
          const cached = edge?.userData?.polylineLocal;
          const isWorld = !!(edge?.userData?.polylineWorld);
          if (Array.isArray(cached) && cached.length >= 2) {
            if (isWorld) {
              for (let i = 0; i < cached.length; i++) { const p = cached[i]; pA.push([p[0], p[1], p[2]]); }
            } else {
              for (let i = 0; i < cached.length; i++) { const p = cached[i]; wv.set(p[0], p[1], p[2]).applyMatrix4(edge.matrixWorld); pA.push([wv.x, wv.y, wv.z]); }
            }
          } else {
            const posAttr = edge?.geometry?.getAttribute?.('position');
            if (posAttr && posAttr.itemSize === 3 && posAttr.count >= 2) {
              for (let i = 0; i < posAttr.count; i++) { wv.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(edge.matrixWorld); pA.push([wv.x, wv.y, wv.z]); }
            } else {
              const aStart = edge?.geometry?.attributes?.instanceStart;
              const aEnd = edge?.geometry?.attributes?.instanceEnd;
              if (aStart && aEnd && aStart.itemSize === 3 && aEnd.itemSize === 3 && aStart.count === aEnd.count && aStart.count >= 1) {
                wv.set(aStart.getX(0), aStart.getY(0), aStart.getZ(0)).applyMatrix4(edge.matrixWorld); pA.push([wv.x, wv.y, wv.z]);
                for (let i = 0; i < aEnd.count; i++) { wv.set(aEnd.getX(i), aEnd.getY(i), aEnd.getZ(i)).applyMatrix4(edge.matrixWorld); pA.push([wv.x, wv.y, wv.z]); }
              }
            }
          }

          // Remove exact duplicate consecutive points to avoid degenerate quads
          for (let i = pA.length - 2; i >= 0; i--) {
            const a = pA[i], b = pA[i + 1];
            if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) pA.splice(i + 1, 1);
          }

          const n = pA.length;
          if (n < 2) continue;
          const isHole = !!(edge && edge.userData && edge.userData.isHole);

          if (!doPathSweep) {
            // Single-vector extrude
            for (let i = 0; i < n - 1; i++) {
              const a = pA[i];
              const b = pA[i + 1];
              if ((a[0] === b[0] && a[1] === b[1] && a[2] === b[2])) continue; // guard
              const a2 = [a[0] + dir.x, a[1] + dir.y, a[2] + dir.z];
              const b2 = [b[0] + dir.x, b[1] + dir.y, b[2] + dir.z];
              if (isHole) { this.addTriangle(name, a, b2, b); this.addTriangle(name, a, a2, b2); }
              else { this.addTriangle(name, a, b, b2); this.addTriangle(name, a, b2, a2); }
            }
          } else {
            // Path-based
            for (let seg = 0; seg < offsets.length - 1; seg++) {
              const off0 = offsets[seg], off1 = offsets[seg + 1];
              // Skip degenerate steps
              if (off1.x === off0.x && off1.y === off0.y && off1.z === off0.z) continue;
              for (let i = 0; i < n - 1; i++) {
                const a = pA[i];
                const b = pA[i + 1];
                if ((a[0] === b[0] && a[1] === b[1] && a[2] === b[2])) continue;
                const A0 = [a[0] + off0.x, a[1] + off0.y, a[2] + off0.z];
                const B0 = [b[0] + off0.x, b[1] + off0.y, b[2] + off0.z];
                const A1 = [a[0] + off1.x, a[1] + off1.y, a[2] + off1.z];
                const B1 = [b[0] + off1.x, b[1] + off1.y, b[2] + off1.z];
                if (isHole) { this.addTriangle(name, A0, B1, B0); this.addTriangle(name, A0, A1, B1); }
                else { this.addTriangle(name, A0, B0, B1); this.addTriangle(name, A0, B1, A1); }
              }
            }
          }
        }
      }

      // Weld seams by an adaptive epsilon to ensure caps and sides share
      // vertices exactly without collapsing geometry at small scales.
      // Use ~1e-6 of the overall diagonal, clamped to [1e-7, 1e-4].
      let eps = 1e-6;
      if (Array.isArray(this._vertProperties) && this._vertProperties.length >= 6) {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < this._vertProperties.length; i += 3) {
          const x = this._vertProperties[i + 0];
          const y = this._vertProperties[i + 1];
          const z = this._vertProperties[i + 2];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        const diag = Math.hypot(dx, dy, dz) || 1;
        eps = Math.min(1e-4, Math.max(1e-7, diag * 1e-6));
      }
      this.setEpsilon(eps);
      // Prune tiny floating fragments that can appear at sharp corners.
      try { this.removeSmallIslands({ maxTriangles: 12, removeInternal: true, removeExternal: true }); } catch (_) { }
      // Build the manifold now so callers get a ready solid. If it fails due
      // to borderline vertex mismatches, progressively increase epsilon and
      // retry a few times.
      let ok = false; let attempt = 0; let errLast = null;
      while (!ok && attempt < 3) {
        try {
          this.getMesh();
          ok = true;
        } catch (err) {
          errLast = err;
          eps *= 2;
          if (eps > 5e-4) break;
          try { this.setEpsilon(eps); } catch (_) { }
        }
        attempt++;
      }
      if (!ok && errLast) { console.warn('[Sweep] Manifold build failed after retries:', errLast.message || errLast); }
    }
  }
}
