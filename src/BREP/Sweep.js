import { Solid } from './BetterSolid.js';
import * as THREE from 'three';
const DEBUG = false;

// Debug helper for sweep/pathAlign. Enable by setting window.BREP_DEBUG_SWEEP = 1
// or adding '?sweepDebug=1' to the URL. Keeps logs grouped and throttled.
function sweepDebugEnabled() {
  try {
    // Enabled by default; allow explicit opt-out
    if (DEBUG) {
      if (typeof window !== 'undefined') {
        if (window.BREP_DEBUG_SWEEP === 0 || window.BREP_DEBUG_SWEEP === false) return false;
        const q = (window.location && window.location.search) || '';
        if (/[?&]sweepDebug=0/.test(q)) return false;
      }
      return true;
    }
    if (typeof window === 'undefined') return false;
    if (window.BREP_DEBUG_SWEEP) return true;
    const q = (window.location && window.location.search) || '';
    return /[?&]sweepDebug=1/.test(q);
  } catch (_) { return DEBUG; }
}
function dlog(group, msg, obj) {
  if (!sweepDebugEnabled()) return;
  try {
    if (group) console.log(`[SweepDBG] ${group}: ${msg}`, obj || '');
    else console.log(`[SweepDBG] ${msg}`, obj || '');
  } catch (_) {}
}
function djson(tag, obj) {
  if (!sweepDebugEnabled()) return;
  try {
    console.log(`[SweepDBG-JSON] ${tag} ` + JSON.stringify(obj));
  } catch (e) {
    try { console.log(`[SweepDBG-JSON] ${tag} (stringify failed)`, obj); } catch(_) {}
  }
}
const _round = (n)=> Math.abs(n) < 1e-12 ? 0 : Number(n.toFixed(6));
const _v3 = (v)=> (v && typeof v.x === 'number') ? [_round(v.x), _round(v.y), _round(v.z)] : v;

export class FacesSolid extends Solid {
  /**
   * @param {object} [opts]
   * @param {string} [opts.name='FromFaces'] Name of the solid
   */
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
  /**
   * @param {object} [opts]
   * @param {import('./Face.js').Face} opts.face Base face/profile to sweep
   * @param {any[]} [opts.sweepPathEdges=[]] Edges defining the sweep path
   * @param {number} [opts.distance=1] Forward sweep distance
   * @param {number} [opts.distanceBack=0] Backward sweep distance
   * @param {'translate'|'rotate'|string} [opts.mode='translate'] Sweep mode
   * @param {string} [opts.name='Sweep'] Name of the resulting solid
   * @param {boolean} [opts.omitBaseCap=false] Whether to skip the base cap
   */
  constructor({ face, sweepPathEdges = [], distance = 1, distanceBack = 0, mode = 'translate', name = 'Sweep', omitBaseCap = false } = {}) {
    super({ name });
    this.params = { face, distance, distanceBack, sweepPathEdges, mode, name, omitBaseCap };
    this.generate();
  }

  generate() {
    const { face, distance, distanceBack, sweepPathEdges, mode, omitBaseCap } = this.params;
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

    // Helper: robustly split a quad into two triangles choosing the better diagonal.
    // Keeps outward orientation for non-holes and reverses for holes.
    const addQuad = (faceName, A0, B0, B1, A1, isHole) => {
      const v = (p, q) => new THREE.Vector3(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      const areaTri = (a, b, c) => v(a, b).cross(v(a, c)).length();
      // Two possible diagonals: d1 = A0-B1, d2 = A0-B0
      const areaD1 = areaTri(A0, B0, B1) + areaTri(A0, B1, A1);
      const areaD2 = areaTri(A0, B0, A1) + areaTri(B0, B1, A1);
      const epsA = 1e-18;
      if (!(areaD1 > epsA || areaD2 > epsA)) return; // fully degenerate
      if (areaD2 > areaD1) {
        if (isHole) {
          this.addTriangle(faceName, A0, A1, B0);
          this.addTriangle(faceName, B0, A1, B1);
        } else {
          this.addTriangle(faceName, A0, B0, A1);
          this.addTriangle(faceName, B0, B1, A1);
        }
      } else {
        if (isHole) {
          this.addTriangle(faceName, A0, B1, B0);
          this.addTriangle(faceName, A0, A1, B1);
        } else {
          this.addTriangle(faceName, A0, B0, B1);
          this.addTriangle(faceName, A0, B1, A1);
        }
      }
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

    // Translate mode should only place cross sections at segment joints.
    // For pathAlign we keep user's direction and joints; translate may simplify.
    if (pathPts.length >= 2) {
      if (mode === 'pathAlign') {
        // no automatic reversal or heavy refinement here
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

    // Orient path to start near face centroid (only for translate). PathAlign respects selection order.
    if (pathPts.length >= 2 && mode !== 'pathAlign') {
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

    // Determine sweep vectors for cap translation only (single-shot extrude or end cap of path)
    let dir = null;     // forward vector (legacy name)
    let dirF = null;    // forward vector
    let dirB = null;    // backward vector (for two-sided extrude)
    if (offsets.length >= 2) {
      dir = offsets[offsets.length - 1].clone();
      dirF = dir.clone();
    } else if (distance instanceof THREE.Vector3) {
      dir = distance.clone();
      dirF = dir.clone();
    } else if (typeof distance === 'number') {
      const n = typeof face.getAverageNormal === 'function'
        ? face.getAverageNormal().clone()
        : new THREE.Vector3(0, 1, 0);
      dir = n.multiplyScalar(distance);
      dirF = dir.clone();
    } else {
      dir = new THREE.Vector3(0, 1, 0);
      dirF = dir.clone();
    }
    // Two-sided only applies to translate extrude (no path offsets)
    // Two-sided: allow any non-zero signed back distance so start can be
    // offset on either side of the base face.
    const twoSided = (offsets.length < 2) && typeof distanceBack === 'number' && isFinite(distanceBack) && Math.abs(distanceBack) > 1e-12;
    if (twoSided) {
      // If the forward vector is extremely small (e.g. distance ~ 0 with a tiny
      // bias from certain boolean modes), derive the back direction from the
      // face normal instead of the sign of dirF to avoid flipping semantics.
      const EPS_FWD = 1e-8;
      let n = null;
      if (dirF && dirF.length() > EPS_FWD) {
        n = dirF.clone().normalize();
      } else {
        n = (typeof face.getAverageNormal === 'function') ? face.getAverageNormal().clone() : new THREE.Vector3(0, 1, 0);
        if (n.lengthSq() < 1e-20) n.set(0, 1, 0);
        n.normalize();
      }
      // Preserve the sign of distanceBack: positive means offset "behind"
      // the base along -n; negative moves the start cap in the +n direction.
      dirB = n.multiplyScalar(-distanceBack);
    }

    const featureTag = (this.params && this.params.name) ? `${this.params.name}:` : '';
    const startName = `${featureTag}${face.name || 'Face'}_START`;
    const endName = `${featureTag}${face.name || 'Face'}_END`;

    const setFaceType = (name, faceType) => {
      if (!name || !faceType) return;
      try { this.setFaceMetadata(name, { faceType }); } catch { /* best effort */ }
    };

    setFaceType(startName, 'STARTCAP');
    setFaceType(endName, 'ENDCAP');

    // Note: pathAlign support removed. If reintroducing, add helpers here.

    // Prefer rebuilding caps using 2D profile groups from the sketch to ensure
    // identical boundary vertices with side walls.
    const groups = Array.isArray(face?.userData?.profileGroups) ? face.userData.profileGroups : null;
    if (groups && groups.length) {
      // Start cap: always uses original profile orientation (reverse winding)
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
          if (mode !== 'pathAlign') {
            if (twoSided && dirB) {
              // Start cap at back offset (reversed orientation)
              const b0 = [p0[0] + dirB.x, p0[1] + dirB.y, p0[2] + dirB.z];
              const b1 = [p1[0] + dirB.x, p1[1] + dirB.y, p1[2] + dirB.z];
              const b2 = [p2[0] + dirB.x, p2[1] + dirB.y, p2[2] + dirB.z];
              // back-offset cap is never the base cap; always keep
              this.addTriangle(startName, b0, b2, b1);
            } else {
              // Legacy: start cap at base
              if (!omitBaseCap) this.addTriangle(startName, p0, p2, p1);
            }
            // End cap at forward offset
            const q0 = [p0[0] + dirF.x, p0[1] + dirF.y, p0[2] + dirF.z];
            const q1 = [p1[0] + dirF.x, p1[1] + dirF.y, p1[2] + dirF.z];
            const q2 = [p2[0] + dirF.x, p2[1] + dirF.y, p2[2] + dirF.z];
            // If forward vector is zero, this cap lies on the base face
            const isEndBase = Math.abs(dirF.x) < 1e-20 && Math.abs(dirF.y) < 1e-20 && Math.abs(dirF.z) < 1e-20;
            if (!(omitBaseCap && isEndBase)) this.addTriangle(endName, q0, q1, q2);
          }
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
        if (mode !== 'pathAlign') {
          if (twoSided && dirB) {
            const b0 = [p0[0] + dirB.x, p0[1] + dirB.y, p0[2] + dirB.z];
            const b1 = [p1[0] + dirB.x, p1[1] + dirB.y, p1[2] + dirB.z];
            const b2 = [p2[0] + dirB.x, p2[1] + dirB.y, p2[2] + dirB.z];
            // back-offset cap is not at base; always keep
            this.addTriangle(startName, b0, b2, b1);
          } else {
            if (!omitBaseCap) this.addTriangle(startName, p0, p2, p1);
          }
          const q0 = [p0[0] + dirF.x, p0[1] + dirF.y, p0[2] + dirF.z];
          const q1 = [p1[0] + dirF.x, p1[1] + dirF.y, p1[2] + dirF.z];
          const q2 = [p2[0] + dirF.x, p2[1] + dirF.y, p2[2] + dirF.z];
          const isEndBase = Math.abs(dirF.x) < 1e-20 && Math.abs(dirF.y) < 1e-20 && Math.abs(dirF.z) < 1e-20;
          if (!(omitBaseCap && isEndBase)) this.addTriangle(endName, q0, q1, q2);
        }
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

    const isCylindricalSketchEdge = (edge) => {
      if (!edge || !edge.userData) return false;
      const kind = edge.userData.sketchGeomType;
      if (kind === 'circle' && typeof edge.userData.circleRadius === 'number') return edge.userData.circleRadius > 0;
      if (kind === 'arc' && typeof edge.userData.arcRadius === 'number') return edge.userData.arcRadius > 0;
      return false;
    };

    const canEmbedCylMetadata = (mode === 'translate') && !(offsets.length >= 2);
    const cylMetadataByName = new Map();
    const edgeSourceByName = new Map();
    const registerEdgeSource = (faceName, edge) => {
      if (!faceName || !edge) return;
      if (!edgeSourceByName.has(faceName)) {
        edgeSourceByName.set(faceName, edge?.name || 'EDGE');
      }
    };
    const registerCylMetadata = (name, meta) => {
      if (!name || !meta) return;
      if (!Number.isFinite(meta.radius) || meta.radius <= 0) return;
      if (!cylMetadataByName.has(name)) {
        cylMetadataByName.set(name, meta);
        try { this.setFaceMetadata(name, meta); } catch { }
      }
    };

    const computeCylMetadataForEdge = (edge) => {
      if (!canEmbedCylMetadata || !edge) return null;
      const kind = edge.userData?.sketchGeomType;
      let radius = null;
      let centerArr = null;
      if (kind === 'circle') {
        radius = edge.userData?.circleRadius;
        centerArr = edge.userData?.circleCenter;
      } else if (kind === 'arc') {
        radius = edge.userData?.arcRadius;
        centerArr = edge.userData?.arcCenter;
      } else {
        return null;
      }
      if (!Array.isArray(centerArr) || !Number.isFinite(radius) || radius <= 0) return null;
      const center = new THREE.Vector3(centerArr[0], centerArr[1], centerArr[2]);
      if (!edge?.userData?.polylineWorld && edge?.matrixWorld) center.applyMatrix4(edge.matrixWorld);
      const forwardVec = dirF ? dirF.clone() : new THREE.Vector3(0, 0, 0);
      const backwardVec = dirB ? dirB.clone() : new THREE.Vector3(0, 0, 0);
      const startPoint = center.clone().add(backwardVec);
      const endPoint = center.clone().add(forwardVec);
      const axisVec = endPoint.clone().sub(startPoint);
      let height = axisVec.length();
      let axisDir;
      if (height > 1e-9) {
        axisDir = axisVec.clone().normalize();
      } else {
        axisDir = forwardVec.clone();
        if (axisDir.lengthSq() < 1e-12) axisDir = new THREE.Vector3(0, 1, 0);
        axisDir.normalize();
        if (!Number.isFinite(height) || height <= 1e-9) height = forwardVec.length();
      }
      if (!Number.isFinite(height)) height = 0;
      const axisCenter = startPoint.clone().addScaledVector(axisVec, 0.5);
      return {
        type: 'cylindrical',
        radius,
        height,
        axis: [axisDir.x, axisDir.y, axisDir.z],
        center: [axisCenter.x, axisCenter.y, axisCenter.z],
      };
    };

    if (canEmbedCylMetadata && Array.isArray(face?.edges)) {
      for (const edge of face.edges) {
        if (!isCylindricalSketchEdge(edge)) continue;
        const meta = computeCylMetadataForEdge(edge);
        if (!meta) continue;
        const edgeName = `${featureTag}${edge?.name || 'EDGE'}_SW`;
        registerCylMetadata(edgeName, meta);
      }
    }

    const ensureMetadataForName = (name) => {
      if (!name) return;
      const meta = cylMetadataByName.get(name);
      if (meta) {
        try { this.setFaceMetadata(name, meta); } catch { }
      }
      const sourceEdgeName = edgeSourceByName.get(name);
      if (sourceEdgeName) {
        try { this.setFaceMetadata(name, { sourceEdgeName }); } catch { }
      }
    };

    // Side faces: Prefer boundary loops to ensure vertex matching with caps.
    // This avoids T-junctions and ensures a watertight manifold. If loops are
    // unavailable (legacy faces), fall back to per-edge polylines.
    // Try boundary loops from sketch metadata; otherwise reconstruct from face triangles
    let boundaryLoops = Array.isArray(face?.userData?.boundaryLoopsWorld) ? face.userData.boundaryLoopsWorld : null;
    const computeBoundaryLoopsFromFace = (faceObj) => {
      const loops = [];
      const geom = faceObj?.geometry; if (!geom) return loops;
      const pos = geom.getAttribute && geom.getAttribute('position'); if (!pos) return loops;
      const idx = geom.getIndex && geom.getIndex();
      // World-space vertices
      const world = new Array(pos.count);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) { v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(faceObj.matrixWorld); world[i] = [v.x, v.y, v.z]; }
      // Canonicalize coincident vertices (handles non-indexed geometry):
      // Map unique world positions -> canonical vertex index used for boundary detection.
      const keyOf = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)},${p[2].toFixed(7)}`;
      const canonMap = new Map(); // key -> canonical index
      const canonPts = [];        // canonical index -> world point
      const origToCanon = new Array(world.length);
      for (let i = 0; i < world.length; i++) {
        const k = keyOf(world[i]);
        let ci = canonMap.get(k);
        if (ci === undefined) { ci = canonPts.length; canonMap.set(k, ci); canonPts.push(world[i]); }
        origToCanon[i] = ci;
      }
      // Count undirected triangle edges
      const edgeCount = new Map(); // key min,max -> count
      const triIter = (cb)=>{
        if (idx) { for (let t=0;t<idx.count;t+=3){ cb(idx.getX(t+0)>>>0, idx.getX(t+1)>>>0, idx.getX(t+2)>>>0); } }
        else { const triCount=(pos.count/3)|0; for(let t=0;t<triCount;t++){ cb(3*t+0,3*t+1,3*t+2); } }
      };
      const inc = (a,b)=>{
        // Use canonical indices so shared positions are treated as one vertex
        const A = origToCanon[a] >>> 0; const B = origToCanon[b] >>> 0;
        const i=Math.min(A,B), j=Math.max(A,B); const k=`${i},${j}`;
        edgeCount.set(k, (edgeCount.get(k)||0)+1);
      };
      triIter((i0,i1,i2)=>{ inc(i0,i1); inc(i1,i2); inc(i2,i0); });
      // Keep only boundary edges (count==1) and build adjacency for both directions
      const adj = new Map(); // index -> Set(neighbor indices)
      const addAdj = (a,b)=>{ let s=adj.get(a); if(!s){ s=new Set(); adj.set(a,s);} s.add(b); };
      for (const [k,c] of edgeCount.entries()) {
        if (c === 1) {
          const [iStr, jStr] = k.split(','); const i = Number(iStr), j = Number(jStr);
          addAdj(i,j); addAdj(j,i);
        }
      }
      // Walk loops by following neighbors not equal to previous
      const visited = new Set(); // canonical edge keys "i,j" with i<j
      const edgeKey = (a,b)=>{ const i=Math.min(a,b), j=Math.max(a,b); return `${i},${j}`; };
      for (const [a, neigh] of adj.entries()) {
        for (const b of neigh) {
          const k = edgeKey(a,b); if (visited.has(k)) continue;
          const ring = [a, b];
          visited.add(k);
          let prev = a, cur = b, guard = 0;
          while (guard++ < 100000) {
            const nset = adj.get(cur) || new Set();
            // Choose the next neighbor that's not where we came from
            let next = null; for (const n of nset) { if (n !== prev) { next = n; break; } }
            if (next == null) break;
            const kk = edgeKey(cur, next); if (visited.has(kk)) break;
            visited.add(kk);
            ring.push(next);
            prev = cur; cur = next;
            if (cur === ring[0]) break; // closed
          }
          if (ring.length >= 3) {
            // Dedup consecutive duplicates and convert to points
            const pts = [];
            for (let i = 0; i < ring.length; i++) {
              const p = canonPts[ring[i]];
              if (pts.length) { const q = pts[pts.length - 1]; if (q[0]===p[0] && q[1]===p[1] && q[2]===p[2]) continue; }
              pts.push([p[0], p[1], p[2]]);
            }
            if (pts.length >= 3) loops.push({ pts, isHole: false });
          }
        }
      }
      // Classify holes by signed area in the face plane
      if (loops.length) {
        const n = (typeof faceObj.getAverageNormal === 'function') ? faceObj.getAverageNormal().clone() : new THREE.Vector3(0,0,1);
        if (n.lengthSq() < 1e-20) n.set(0,0,1); n.normalize();
        let ux = new THREE.Vector3(1,0,0); if (Math.abs(n.dot(ux)) > 0.99) ux.set(0,1,0);
        const U = new THREE.Vector3().crossVectors(n, ux).normalize();
        const V = new THREE.Vector3().crossVectors(n, U).normalize();
        const area2 = (arr)=>{ let a=0; for (let i=0;i<arr.length;i++){ const p=arr[i], q=arr[(i+1)%arr.length]; a += (p.x*q.y - q.x*p.y); } return 0.5*a; };
        const loopAreas = loops.map(loop => {
          const v2 = loop.pts.map(P => new THREE.Vector2(new THREE.Vector3(P[0],P[1],P[2]).sub(new THREE.Vector3()).dot(U), new THREE.Vector3(P[0],P[1],P[2]).dot(V)));
          return area2(v2);
        });
        let outerIdx = 0; let outerAbs = 0; for (let i=0;i<loopAreas.length;i++){ const ab = Math.abs(loopAreas[i]); if (ab>outerAbs){ outerAbs=ab; outerIdx=i; } }
        const outerSign = Math.sign(loopAreas[outerIdx] || 1);
        for (let i=0;i<loops.length;i++){ const sign = Math.sign(loopAreas[i] || 0); loops[i].isHole = (sign !== outerSign); }
      }
      return loops;
    };
    if (!boundaryLoops || !boundaryLoops.length) boundaryLoops = computeBoundaryLoopsFromFace(face);
    const doPathSweep = offsets.length >= 2;
    // Prefer boundary-loop based sidewalls whenever loops are available so
    // caps and walls share identical vertices and produce a watertight mesh.
    // This avoids non‑manifold vertical edges when input edges are split into
    // multiple segments (e.g., PNG trace linear regions). Falls back to
    // per-edge ribbons only when loops are unavailable.
    if (boundaryLoops && boundaryLoops.length) {
      const _inputDbg = { mode, pathCount: pathPts.length, loops: boundaryLoops.length, face: face?.name };
      dlog('Input', 'pathAlign params', _inputDbg);
      djson('Input', _inputDbg);
      // Build a quick lookup from boundary points to their originating sketch edge(s)
      // so we can label side walls per curve while still using cap-matching vertices.
      const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;
      // Use only non-closed edges for per-segment naming so vertical boundaries
      // between side panels remain distinct. Closed loop edges (from PNG trace)
      // cover the whole ring and would otherwise collapse all walls under one name.
      const edgesAll = Array.isArray(face?.edges) ? face.edges : [];
      const edges = edgesAll.filter(e => !e.closedLoop || isCylindricalSketchEdge(e));
      const pointToEdgeNames = new Map(); // key -> Set(edgeName)
      for (const e of edges) {
        const name = `${featureTag}${e?.name || 'EDGE'}_SW`;
        registerEdgeSource(name, e);
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

      // Compute face basis and path-aligned frames (for pathAlign mode)
      let frames = null;
      let baseOriginW = null, baseX = null, baseY = null, baseZ = null;
      if (doPathSweep && mode === 'pathAlign') {
        const P = pathPts.map(p => new THREE.Vector3(p[0], p[1], p[2]));
        // Face basis from profile itself
        baseZ = (typeof face.getAverageNormal === 'function') ? face.getAverageNormal().clone() : new THREE.Vector3(0, 0, 1);
        if (!baseZ || !isFinite(baseZ.x) || baseZ.lengthSq() < 1e-20) baseZ = new THREE.Vector3(0, 0, 1);
        baseZ.normalize();
        // Choose origin as centroid of outer loop (world)
        const outerLoop0 = boundaryLoops.find(l => !l.isHole) || boundaryLoops[0];
        const outerPts0 = Array.isArray(outerLoop0?.pts) ? outerLoop0.pts : outerLoop0;
        if (Array.isArray(outerPts0) && outerPts0.length) {
          baseOriginW = new THREE.Vector3();
          for (const p of outerPts0) baseOriginW.add(new THREE.Vector3(p[0], p[1], p[2]));
          baseOriginW.multiplyScalar(1 / outerPts0.length);
        } else {
          baseOriginW = new THREE.Vector3(P[0].x, P[0].y, P[0].z);
        }
        // Determine anchor point in world nearest to P0 before defining axes
        const P0 = P[0].clone();
        let anchorWorld = null;
        if (Array.isArray(outerPts0) && outerPts0.length) {
          let bestD2 = Infinity; let best = outerPts0[0];
          for (const p of outerPts0){ const dx=p[0]-P0.x, dy=p[1]-P0.y, dz=p[2]-P0.z; const d2=dx*dx+dy*dy+dz*dz; if (d2<bestD2){ bestD2=d2; best=p; } }
          anchorWorld = new THREE.Vector3(best[0], best[1], best[2]);
        } else {
          anchorWorld = P0.clone();
        }

        // Choose baseX toward anchor (projected into face plane)
        const toAnchor = anchorWorld.clone().sub(baseOriginW);
        baseX = toAnchor.clone().sub(baseZ.clone().multiplyScalar(toAnchor.dot(baseZ)));
        if (baseX.lengthSq() < 1e-12) baseX.set(1,0,0); // fallback
        baseX.normalize();
        baseY = new THREE.Vector3().crossVectors(baseZ, baseX).normalize();
        baseX = new THREE.Vector3().crossVectors(baseY, baseZ).normalize();
        // Tangents along path
        const T = P.map((_, i) => {
          if (i < P.length - 1) {
            const t = P[i + 1].clone().sub(P[i]);
            return (t.lengthSq() < 1e-20) ? new THREE.Vector3(0,0,1) : t.normalize();
          } else {
            const t = P[i].clone().sub(P[i - 1] || P[i]);
            return (t.lengthSq() < 1e-20) ? new THREE.Vector3(0,0,1) : t.normalize();
          }
        });
        // Reference world vector: prefer P0->anchor; if zero/near-zero, fall back to baseX
        let ref = anchorWorld.clone().sub(P[0]);
        if (ref.lengthSq() < 1e-12) ref = baseX.clone();
        const Xs = []; const Ys = []; const Zs = [];
        const dbgFrames = [];
        const EPS = 1e-12;
        for (let i = 0; i < P.length; i++) {
          const z = T[i].clone().normalize();
          // Project reference to plane orthogonal to z
          let xProj = ref.clone().sub(z.clone().multiplyScalar(ref.dot(z)));
          let xLen2 = xProj.lengthSq();
          // If projection is ill-conditioned, fall back to face upRef cross z
          if (xLen2 < EPS) {
            const alt = new THREE.Vector3().crossVectors(z, baseZ);
            if (alt.lengthSq() > EPS) xProj = alt; else if (i > 0) xProj = Xs[i - 1].clone();
            else xProj = (Math.abs(z.x) < 0.9 ? new THREE.Vector3(1,0,0) : new THREE.Vector3(0,1,0)).sub(z.clone().multiplyScalar(z.x)).normalize();
          }
          let x = xProj.normalize();
          // Choose sign to maximize alignment with both previous X and target baseX projection
          let score = 0;
          if (i > 0) score += x.dot(Xs[i - 1]);
          const t = baseX.clone().sub(z.clone().multiplyScalar(baseX.dot(z)));
          if (t.lengthSq() > EPS) { const tn = t.normalize(); score += x.dot(tn); }
          const flipped = (score < 0); if (flipped) x.multiplyScalar(-1);
          const y = new THREE.Vector3().crossVectors(z, x).normalize();
          Xs[i] = x; Ys[i] = y; Zs[i] = z;
          if (sweepDebugEnabled()) {
            dbgFrames.push({
              i,
              projLen: +Math.sqrt(xLen2).toExponential(3),
              z: [ +z.x.toFixed(5), +z.y.toFixed(5), +z.z.toFixed(5) ],
              x: [ +x.x.toFixed(5), +x.y.toFixed(5), +x.z.toFixed(5) ],
              y: [ +y.x.toFixed(5), +y.y.toFixed(5), +y.z.toFixed(5) ],
              alignedScore: +score.toFixed(5),
              flipped
            });
          }
        }
        // Bias rotation: align start frame to face's baseX projected into the start normal plane
        const target = baseX.clone().sub(Zs[0].clone().multiplyScalar(baseX.dot(Zs[0])));
        if (target.lengthSq() > 1e-14) {
          const t = target.normalize();
          const c = Xs[0].dot(t);
          const s = Ys[0].dot(t);
          const bias = Math.atan2(s, c);
          if (Math.abs(bias) > 1e-8) {
            const rotXY = (i) => {
              const cx = Math.cos(bias), sx = Math.sin(bias);
              const Xi = Xs[i], Yi = Ys[i];
              const Xr = new THREE.Vector3(
                Xi.x * cx + Yi.x * sx,
                Xi.y * cx + Yi.y * sx,
                Xi.z * cx + Yi.z * sx
              );
              const Yr = new THREE.Vector3(
                -Xi.x * sx + Yi.x * cx,
                -Xi.y * sx + Yi.y * cx,
                -Xi.z * sx + Yi.z * cx
              );
              Xs[i] = Xr.normalize(); Ys[i] = Yr.normalize();
            };
            for (let i = 0; i < Xs.length; i++) rotXY(i);
          }
        }
        // Enforce that start-frame Y points roughly along the original face normal
        // (keeps the profile on the intended side at the path start and propagates along the path)
        const y0dot = Ys[0].dot(baseZ);
        if (y0dot < 0) {
          for (let i = 0; i < Xs.length; i++) { Xs[i].multiplyScalar(-1); Ys[i].multiplyScalar(-1); }
          dlog('Frames', 'flipped XY to align Y with face normal', { y0dot: _round(y0dot) });
          djson('FramesAlignY', { y0dot: _round(y0dot) });
        }
        if (sweepDebugEnabled()) {
          const pathDbg = P.map((v,i)=>({ i, p:[+v.x.toFixed(4),+v.y.toFixed(4),+v.z.toFixed(4)],
            X:[+Xs[i].x.toFixed(4),+Xs[i].y.toFixed(4),+Xs[i].z.toFixed(4)],
            Y:[+Ys[i].x.toFixed(4),+Ys[i].y.toFixed(4),+Ys[i].z.toFixed(4)],
            Z:[+Zs[i].x.toFixed(4),+Zs[i].y.toFixed(4),+Zs[i].z.toFixed(4)] }));
          const framesMeta = { anchorWorld: _v3(anchorWorld), baseOriginW: _v3(baseOriginW), baseX: _v3(baseX), baseY: _v3(baseY), flips: pathDbg.slice(1).filter((f,i)=> Xs[i].dot(Xs[i+1])<0).length };
          dlog('Frames', 'computed frames', framesMeta);
          console.table(pathDbg);
          console.table(dbgFrames);
          djson('Frames', { meta: framesMeta, rows: pathDbg });
          djson('FramesDetail', dbgFrames);
        }
        // Frame origins sit on the path points so the path passes through the anchor
        frames = P.map((_, i) => ({ origin: P[i].clone(), X: Xs[i], Y: Ys[i], Z: Zs[i] }));

        // UV mapping from original profile basis at baseOriginW
        const uvCache = new Map(); // key(point as string) -> [u,v]
        const uvOf = (pArr) => {
          const k = key(pArr);
          const cached = uvCache.get(k);
          if (cached) return cached;
          const v = new THREE.Vector3(pArr[0] - baseOriginW.x, pArr[1] - baseOriginW.y, pArr[2] - baseOriginW.z);
          const u = v.dot(baseX);
          const w = v.dot(baseY);
          const uv = [u, w];
          uvCache.set(k, uv);
          return uv;
        };

        // Anchor profile to the path start: pick the outer-loop point nearest to P0
        let anchorU = 0, anchorV = 0;
        const outerLoop = boundaryLoops.find(l => !l.isHole) || boundaryLoops[0];
        const outerPts = Array.isArray(outerLoop?.pts) ? outerLoop.pts : outerLoop;
        if (Array.isArray(outerPts) && outerPts.length) {
          let bestD2 = Infinity; let best = outerPts[0];
          const P0 = frames[0].origin;
          for (const p of outerPts) {
            const dx = p[0]-P0.x, dy=p[1]-P0.y, dz=p[2]-P0.z; const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 < bestD2) { bestD2 = d2; best = p; }
          }
          const aUV = uvOf(best); anchorU = aUV[0]; anchorV = aUV[1];
          // If anchor is too close to base origin (ill-defined), choose farthest point instead
          const mag2 = anchorU*anchorU + anchorV*anchorV;
          if (mag2 < 1e-16) {
            let farD = -1; let far = best;
            for (const p of outerPts) { const uv = uvOf(p); const d = (uv[0]-anchorU)*(uv[0]-anchorU) + (uv[1]-anchorV)*(uv[1]-anchorV); if (d > farD) { farD = d; far = p; } }
            const uvF = uvOf(far); anchorU = uvF[0]; anchorV = uvF[1];
          }
        }

        // Side-of-path lock: use the anchor vector (non-zero by construction)
        const lockU = anchorU, lockV = anchorV;
        if ((lockU*lockU + lockV*lockV) > 1e-20) {
          for (let i = 1; i < frames.length; i++) {
            const prevVec = new THREE.Vector3().addScaledVector(frames[i - 1].X, lockU).addScaledVector(frames[i - 1].Y, lockV);
            const currVec = new THREE.Vector3().addScaledVector(frames[i].X, lockU).addScaledVector(frames[i].Y, lockV);
            const lp = prevVec.lengthSq(), lc = currVec.lengthSq();
            if (lp > 1e-24 && lc > 1e-24) {
              if (currVec.normalize().dot(prevVec.normalize()) < 0) { frames[i].X.multiplyScalar(-1); frames[i].Y.multiplyScalar(-1); }
            }
          }
        }

        // Helper to place a base boundary point at segment index
        var placeAt = (pArr, segIndex) => {
          const uv = uvOf(pArr);
          const f = frames[segIndex];
          const du = uv[0] - anchorU;
          const dv = uv[1] - anchorV;
          const x = f.origin.x + f.X.x * du + f.Y.x * dv;
          const y = f.origin.y + f.X.y * du + f.Y.y * dv;
          const z = f.origin.z + f.X.z * du + f.Y.z * dv;
          return [x, y, z];
        };
        const f0 = frames[0];
        dlog('Anchor', 'uv and start frame', { anchorU, anchorV, frame0: f0 });
        djson('Anchor', { anchorU, anchorV, frame0: { origin: _v3(f0.origin), X: _v3(f0.X), Y: _v3(f0.Y), Z: _v3(f0.Z) } });
      }

      // Deduplicate per-boundary segments so each undirected edge [A,B]
      // emits exactly one side-wall ribbon. This avoids duplicate walls when
      // loop reconstruction yields overlapping segments or when edge-name
      // mapping falls back to the generic face name on the same [A,B].
      const keyPt = (p) => `${Number(p[0]).toFixed(7)},${Number(p[1]).toFixed(7)},${Number(p[2]).toFixed(7)}`;
      const segKey = (A,B) => {
        const a = keyPt(A), b = keyPt(B);
        return (a < b) ? `${a}|${b}` : `${b}|${a}`;
      };
      const seenSegments = new Set();

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
          // translate-only
          if (twoSided && dirB) {
            for (let i = 0; i < base.length - 1; i++) {
              const a = base[i];
              const b = base[i + 1];
              if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
              const sk = segKey(a,b); if (seenSegments.has(sk)) continue; seenSegments.add(sk);
              const A0 = [a[0] + dirB.x, a[1] + dirB.y, a[2] + dirB.z];
              const B0 = [b[0] + dirB.x, b[1] + dirB.y, b[2] + dirB.z];
              const A1 = [a[0] + dirF.x, a[1] + dirF.y, a[2] + dirF.z];
              const B1 = [b[0] + dirF.x, b[1] + dirF.y, b[2] + dirF.z];
              const setA = pointToEdgeNames.get(key(a));
              const setB = pointToEdgeNames.get(key(b));
              let name = `${featureTag}${face.name || 'FACE'}_SW`;
              if (setA && setB) { for (const n of setA) { if (setB.has(n)) { name = n; break; } } }
              ensureMetadataForName(name);
              setFaceType(name, 'SIDEWALL');
              addQuad(name, A0, B0, B1, A1, isHole);
            }
          } else {
            // single-vector extrude (original behavior)
            for (let i = 0; i < base.length - 1; i++) {
              const a = base[i];
              const b = base[i + 1];
              if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
              const sk = segKey(a,b); if (seenSegments.has(sk)) continue; seenSegments.add(sk);
              const a2 = [a[0] + dirF.x, a[1] + dirF.y, a[2] + dirF.z];
              const b2 = [b[0] + dirF.x, b[1] + dirF.y, b[2] + dirF.z];
              const setA = pointToEdgeNames.get(key(a));
              const setB = pointToEdgeNames.get(key(b));
              let name = `${featureTag}${face.name || 'FACE'}_SW`;
              if (setA && setB) { for (const n of setA) { if (setB.has(n)) { name = n; break; } } }
              ensureMetadataForName(name);
              setFaceType(name, 'SIDEWALL');
              if (isHole) {
                this.addTriangle(name, a, b2, b);
                this.addTriangle(name, a, a2, b2);
              } else {
                this.addTriangle(name, a, b, b2);
                this.addTriangle(name, a, b2, a2);
              }
            }
          }
        } else {
          // Path sweep
            if (mode === 'pathAlign' && frames) {
              for (let seg = 0; seg < offsets.length - 1; seg++) {
                for (let i = 0; i < base.length - 1; i++) {
                const a = base[i];
                const b = base[i + 1];
                if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
                const A0 = placeAt(a, seg);
                const B0 = placeAt(b, seg);
                const A1 = placeAt(a, seg + 1);
                const B1 = placeAt(b, seg + 1);
                const setA = pointToEdgeNames.get(key(a));
                const setB = pointToEdgeNames.get(key(b));
                let name = `${featureTag}${face.name || 'FACE'}_SW`;
                if (setA && setB) { for (const n of setA) { if (setB.has(n)) { name = n; break; } } }
                ensureMetadataForName(name);
                setFaceType(name, 'SIDEWALL');
                addQuad(name, A0, B0, B1, A1, isHole);
              }
            }
          } else {
            // Translate-only between successive offsets
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
                let name = `${featureTag}${face.name || 'FACE'}_SW`;
                if (setA && setB) { for (const n of setA) { if (setB.has(n)) { name = n; break; } } }
                ensureMetadataForName(name);
                setFaceType(name, 'SIDEWALL');
                // Use robust splitting to avoid skinny/inside-crossing diagonals
                addQuad(name, A0, B0, B1, A1, isHole);
                if (sweepDebugEnabled() && seg===0 && i===0) {
                  const walls0 = { A0, B0, B1, A1 };
                  dlog('Walls','first quad', walls0);
                  djson('WallsFirstQuad', walls0);
                }
              }
            }
          }
        }
      }
      // Build start/end caps for pathAlign using initial and final frames
      if (doPathSweep && mode === 'pathAlign' && frames) {
        const buildCap = (frameIndex, capName) => {
          const frame = frames[frameIndex];
          // Map loops using the same placeAt used for walls so vertices match exactly
          const mapped = boundaryLoops.map(loop => {
            const pts = Array.isArray(loop?.pts) ? loop.pts : loop;
            // Build open ring without duplicate last point
            const arr = pts.map(p => placeAt(p, frameIndex));
            // Drop closing duplicate if present (keep interior points as-is)
            if (arr.length >= 2) {
              const f = arr[0], l = arr[arr.length - 1];
              if (f[0] === l[0] && f[1] === l[1] && f[2] === l[2]) arr.pop();
            }
            return { pts: arr, isHole: !!(loop && loop.isHole) };
          });
          const toXY = (P) => new THREE.Vector2((P[0] - frame.origin.x) * frame.X.x + (P[1] - frame.origin.y) * frame.X.y + (P[2] - frame.origin.z) * frame.X.z,
                                                (P[0] - frame.origin.x) * frame.Y.x + (P[1] - frame.origin.y) * frame.Y.y + (P[2] - frame.origin.z) * frame.Y.z);
          const area2 = (arr) => {
            let a = 0;
            for (let i = 0; i < arr.length; i++) { const p = arr[i], q = arr[(i + 1) % arr.length]; a += (p.x * q.y - q.x * p.y); }
            return 0.5 * a;
          };
          const outer = mapped.find(l => !l.isHole) || mapped[0];
          if (!outer || outer.pts.length < 3) return;
          const holes = mapped.filter(l => l !== outer && l.isHole).map(l => {
            const a = l.pts.slice();
            if (a.length >= 2) {
              const f = a[0], t = a[a.length - 1];
              if (f[0] === t[0] && f[1] === t[1] && f[2] === t[2]) a.pop();
            }
            return a;
          });
          let contourV2 = outer.pts.map(p => toXY(p));
          let holesV2 = holes.map(h => h.map(p => toXY(p)));
          if (area2(contourV2) > 0) contourV2 = contourV2.reverse();
          holesV2 = holesV2.map(h => (area2(h) < 0 ? h.reverse() : h));
          let tris = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);
          // Fallback triangulation if library returns too few triangles (rare numeric degeneracy)
          const need = Math.max(2, (contourV2.length - 2));
          if (!Array.isArray(tris) || tris.length < need) {
            const manual = [];
            // Simple fan triangulation around vertex 0 (no holes); orientation already enforced above
            for (let i = 1; i < contourV2.length - 1; i++) manual.push([0, i, i + 1]);
            tris = manual;
            dlog('Cap', 'fallback triangulation used', { capName, fanCount: manual.length });
            djson('CapFallback', { capName, contour: contourV2.map(v=>[_round(v.x),_round(v.y)]), holes: holesV2.map(h=> h.map(v=>[_round(v.x),_round(v.y)])) });
          }
          const all = outer.pts.concat(...holes);
          for (const t of tris) {
            const q0 = all[t[0]], q1 = all[t[1]], q2 = all[t[2]];
            if (capName.endsWith('_START')) this.addTriangle(capName, q0, q2, q1);
            else this.addTriangle(capName, q0, q1, q2);
          }
          const capInfo = { capName, frameIndex, triCount: tris?.length||0, outerLen: outer?.pts?.length||0, holes: holes?.length||0 };
          dlog('Cap', `built ${capName}`, capInfo);
          djson('Cap', capInfo);
        };
        buildCap(0, startName);
        buildCap(frames.length - 1, endName);
      }
    } else {
      // Fallback: build from per-edge polylines (may not match cap vertices exactly)
      const edges = Array.isArray(face.edges) ? face.edges : [];
      if (edges.length) {
        // Per-edge fallback; support translate and pathAlign
        for (const edge of edges) {
          const name = `${featureTag}${edge.name || 'EDGE'}_SW`;
          registerEdgeSource(name, edge);
          ensureMetadataForName(name);
          setFaceType(name, 'SIDEWALL');

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
            if (twoSided && dirB) {
              for (let i = 0; i < n - 1; i++) {
                const a = pA[i];
                const b = pA[i + 1];
                if ((a[0] === b[0] && a[1] === b[1] && a[2] === b[2])) continue; // guard
                const A0 = [a[0] + dirB.x, a[1] + dirB.y, a[2] + dirB.z];
                const B0 = [b[0] + dirB.x, b[1] + dirB.y, b[2] + dirB.z];
                const A1 = [a[0] + dirF.x, a[1] + dirF.y, a[2] + dirF.z];
                const B1 = [b[0] + dirF.x, b[1] + dirF.y, b[2] + dirF.z];
                if (isHole) { this.addTriangle(name, A0, B1, B0); this.addTriangle(name, A0, A1, B1); }
                else { this.addTriangle(name, A0, B0, B1); this.addTriangle(name, A0, B1, A1); }
              }
            } else {
              // Single-vector extrude
              for (let i = 0; i < n - 1; i++) {
                const a = pA[i];
                const b = pA[i + 1];
                if ((a[0] === b[0] && a[1] === b[1] && a[2] === b[2])) continue; // guard
                const a2 = [a[0] + dirF.x, a[1] + dirF.y, a[2] + dirF.z];
                const b2 = [b[0] + dirF.x, b[1] + dirF.y, b[2] + dirF.z];
                if (isHole) { this.addTriangle(name, a, b2, b); this.addTriangle(name, a, a2, b2); }
                else { this.addTriangle(name, a, b, b2); this.addTriangle(name, a, b2, a2); }
              }
            }
          } else {
            // Path-based
            if (mode === 'pathAlign' && doPathSweep) {
              // Build frames aligned to path tangents and UV from initial frame
              const P = pathPts.map(p => new THREE.Vector3(p[0], p[1], p[2]));
              const upRef = (typeof face.getAverageNormal === 'function') ? face.getAverageNormal().clone() : new THREE.Vector3(0,0,1);
              if (upRef.lengthSq() < 1e-20) upRef.set(0,0,1);
              upRef.normalize();
              const T = P.map((_, i) => (i < P.length - 1 ? P[i + 1].clone().sub(P[i]).normalize() : P[i].clone().sub(P[i - 1] || P[i]).normalize()));
              // Pick the edge polyline point nearest to the start of the path
              // and use it as a stable reference for initial frame orientation.
              let bestIndex = 0; let bestRefD2 = Infinity;
              for (let i = 0; i < pA.length; i++) {
                const dx = pA[i][0] - P[0].x, dy = pA[i][1] - P[0].y, dz = pA[i][2] - P[0].z;
                const d2 = dx*dx + dy*dy + dz*dz; if (d2 < bestRefD2) { bestRefD2 = d2; bestIndex = i; }
              }
              const ref = new THREE.Vector3(pA[bestIndex][0], pA[bestIndex][1], pA[bestIndex][2]).sub(P[0]);
              const Xs = []; const Ys = []; const Zs = [];
              for (let i = 0; i < P.length; i++) {
                const z = T[i].clone().normalize();
                let x = ref.clone().sub(z.clone().multiplyScalar(ref.dot(z)));
                if (x.lengthSq() < 1e-14) {
                  if (i > 0) x = Xs[i - 1].clone(); else x = new THREE.Vector3().crossVectors(upRef, z);
                }
                x.normalize();
                const t = new THREE.Vector3(pA[Math.min(bestIndex+1, pA.length-1)][0]-pA[bestIndex][0], pA[Math.min(bestIndex+1, pA.length-1)][1]-pA[bestIndex][1], pA[Math.min(bestIndex+1, pA.length-1)][2]-pA[bestIndex][2]);
                const tp = t.sub(z.clone().multiplyScalar(t.dot(z)));
                if (tp.lengthSq() > 1e-14) {
                  if (x.dot(tp.normalize()) < 0) x.multiplyScalar(-1);
                } else if (i > 0 && x.dot(Xs[i - 1]) < 0) {
                  x.multiplyScalar(-1);
                }
                const y = new THREE.Vector3().crossVectors(z, x).normalize();
                Xs[i] = x; Ys[i] = y; Zs[i] = z;
              }
              // Bias rotation at start to align with base edge direction
              const baseDir = new THREE.Vector3(pA[Math.min(bestIndex+1, pA.length-1)][0]-pA[bestIndex][0], pA[Math.min(bestIndex+1, pA.length-1)][1]-pA[bestIndex][1], pA[Math.min(bestIndex+1, pA.length-1)][2]-pA[bestIndex][2]).normalize();
              const tgt = baseDir.sub(Zs[0].clone().multiplyScalar(baseDir.dot(Zs[0])));
              if (tgt.lengthSq()>1e-14){
                const t = tgt.normalize();
                const c = Xs[0].dot(t), s = Ys[0].dot(t); const bias = Math.atan2(s,c);
                if (Math.abs(bias)>1e-8){
                  const cx=Math.cos(bias), sx=Math.sin(bias);
                  for (let i=0;i<Xs.length;i++){
                    const Xi=Xs[i], Yi=Ys[i];
                    const Xr=new THREE.Vector3(Xi.x*cx+Yi.x*sx, Xi.y*cx+Yi.y*sx, Xi.z*cx+Yi.z*sx);
                    const Yr=new THREE.Vector3(-Xi.x*sx+Yi.x*cx, -Xi.y*sx+Yi.y*cx, -Xi.z*sx+Yi.z*cx);
                    Xs[i]=Xr.normalize(); Ys[i]=Yr.normalize();
                  }
                }
              }
              const framesE = P.map((_, i) => ({ origin: P[i].clone(), X: Xs[i], Y: Ys[i] }));
              // Side-of-path lock using edge polyline centroid in initial frame
              let refU = 0, refV = 0; const m = pA.length; if (m>0){
                for (const p of pA){ const v = new THREE.Vector3(p[0]-framesE[0].origin.x, p[1]-framesE[0].origin.y, p[2]-framesE[0].origin.z); refU += v.dot(framesE[0].X); refV += v.dot(framesE[0].Y); }
                refU/=m; refV/=m;
                for (let i=1;i<framesE.length;i++){ const prev=new THREE.Vector3().addScaledVector(framesE[i-1].X,refU).addScaledVector(framesE[i-1].Y,refV).normalize(); const cur=new THREE.Vector3().addScaledVector(framesE[i].X,refU).addScaledVector(framesE[i].Y,refV).normalize(); if (cur.dot(prev)<0){ framesE[i].X.multiplyScalar(-1); framesE[i].Y.multiplyScalar(-1); } }
              }
              const uv = pA.map(p => {
                const v = new THREE.Vector3(p[0] - framesE[0].origin.x, p[1] - framesE[0].origin.y, p[2] - framesE[0].origin.z);
                return [v.dot(framesE[0].X), v.dot(framesE[0].Y)];
              });
              // Anchor to nearest polyline point to P0 so path passes through it
              let aU = 0, aV = 0, best = 0, bestD2 = Infinity;
              for (let i=0;i<pA.length;i++){
                const dx = pA[i][0]-framesE[0].origin.x, dy=pA[i][1]-framesE[0].origin.y, dz=pA[i][2]-framesE[0].origin.z;
                const d2 = dx*dx + dy*dy + dz*dz; if (d2 < bestD2){ bestD2 = d2; best = i; }
              }
              aU = uv[best][0]; aV = uv[best][1];
              // Use anchor (aU,aV) as lock vector for side-of-path
              for (let i=1;i<framesE.length;i++){
                const prev = new THREE.Vector3().addScaledVector(framesE[i-1].X, aU).addScaledVector(framesE[i-1].Y, aV);
                const curr = new THREE.Vector3().addScaledVector(framesE[i].X, aU).addScaledVector(framesE[i].Y, aV);
                if (prev.lengthSq()>1e-24 && curr.lengthSq()>1e-24 && curr.normalize().dot(prev.normalize())<0){ framesE[i].X.multiplyScalar(-1); framesE[i].Y.multiplyScalar(-1); }
              }
              for (let seg = 0; seg < offsets.length - 1; seg++) {
                for (let i = 0; i < n - 1; i++) {
                  const A0 = [framesE[seg].origin.x + framesE[seg].X.x * (uv[i][0]-aU) + framesE[seg].Y.x * (uv[i][1]-aV), framesE[seg].origin.y + framesE[seg].X.y * (uv[i][0]-aU) + framesE[seg].Y.y * (uv[i][1]-aV), framesE[seg].origin.z + framesE[seg].X.z * (uv[i][0]-aU) + framesE[seg].Y.z * (uv[i][1]-aV)];
                  const B0 = [framesE[seg].origin.x + framesE[seg].X.x * (uv[i+1][0]-aU) + framesE[seg].Y.x * (uv[i+1][1]-aV), framesE[seg].origin.y + framesE[seg].X.y * (uv[i+1][0]-aU) + framesE[seg].Y.y * (uv[i+1][1]-aV), framesE[seg].origin.z + framesE[seg].X.z * (uv[i+1][0]-aU) + framesE[seg].Y.z * (uv[i+1][1]-aV)];
                  const A1 = [framesE[seg+1].origin.x + framesE[seg+1].X.x * (uv[i][0]-aU) + framesE[seg+1].Y.x * (uv[i][1]-aV), framesE[seg+1].origin.y + framesE[seg+1].X.y * (uv[i][0]-aU) + framesE[seg+1].Y.y * (uv[i][1]-aV), framesE[seg+1].origin.z + framesE[seg+1].X.z * (uv[i][0]-aU) + framesE[seg+1].Y.z * (uv[i][1]-aV)];
                  const B1 = [framesE[seg+1].origin.x + framesE[seg+1].X.x * (uv[i+1][0]-aU) + framesE[seg+1].Y.x * (uv[i+1][1]-aV), framesE[seg+1].origin.y + framesE[seg+1].X.y * (uv[i+1][0]-aU) + framesE[seg+1].Y.y * (uv[i+1][1]-aV), framesE[seg+1].origin.z + framesE[seg+1].X.z * (uv[i+1][0]-aU) + framesE[seg+1].Y.z * (uv[i+1][1]-aV)];
                  addQuad(name, A0, B0, B1, A1, isHole);
                }
              }
            } else {
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
                  addQuad(name, A0, B0, B1, A1, isHole);
                }
              }
            }
          }
        }
      }
      // If we are in pathAlign mode here, also build start/end caps from face geometry via frames
      if (doPathSweep && mode === 'pathAlign') {
        // Build frames aligned to path
        const P = pathPts.map(p => new THREE.Vector3(p[0], p[1], p[2]));
        const upRef = (typeof face.getAverageNormal === 'function') ? face.getAverageNormal().clone() : new THREE.Vector3(0,0,1);
        if (upRef.lengthSq() < 1e-20) upRef.set(0,0,1);
        upRef.normalize();
        const T = P.map((_, i) => (i < P.length - 1 ? P[i + 1].clone().sub(P[i]).normalize() : P[i].clone().sub(P[i - 1] || P[i]).normalize()));
        const Z0 = T[0].clone().normalize();
        let X0 = new THREE.Vector3().crossVectors(upRef, Z0); if (X0.lengthSq() < 1e-12) { const alt = Math.abs(Z0.z) < 0.9 ? new THREE.Vector3(0,0,1) : new THREE.Vector3(1,0,0); X0 = new THREE.Vector3().crossVectors(alt, Z0); }
        X0.normalize(); const Y0 = new THREE.Vector3().crossVectors(Z0, X0).normalize();
        const Xs=[X0], Ys=[Y0], Zs=[Z0];
        for (let i=1;i<P.length;i++){ const z=T[i].clone().normalize(); let x=Xs[i-1].clone().sub(z.clone().multiplyScalar(Xs[i-1].dot(z))); if (x.lengthSq()<1e-14){ x=Ys[i-1].clone().sub(z.clone().multiplyScalar(Ys[i-1].dot(z))); if (x.lengthSq()<1e-14){ const tmp=Math.abs(z.z)<0.9? new THREE.Vector3(0,0,1): new THREE.Vector3(1,0,0); x=new THREE.Vector3().crossVectors(tmp,z);} } x.normalize(); const y=new THREE.Vector3().crossVectors(z,x).normalize(); Xs[i]=x; Ys[i]=y; Zs[i]=z; }
        const framesF = P.map((_,i)=>({ origin:P[i].clone(), X: Xs[i], Y: Ys[i] }));
        // Read face geometry world vertices once
        const baseGeom = face.geometry; const posAttr = baseGeom && baseGeom.getAttribute && baseGeom.getAttribute('position'); if (posAttr){
          const idxAttr = baseGeom.getIndex && baseGeom.getIndex(); const hasIndex = !!idxAttr;
          const v = new THREE.Vector3(); const faceWorld = new Array(posAttr.count);
          for (let i=0;i<posAttr.count;i++){ v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(face.matrixWorld); faceWorld[i] = [v.x,v.y,v.z]; }
          const mapAt = (p, f)=>{ const d = new THREE.Vector3(p[0]-framesF[0].origin.x, p[1]-framesF[0].origin.y, p[2]-framesF[0].origin.z); const u = d.dot(framesF[0].X), w = d.dot(framesF[0].Y); return [f.origin.x + f.X.x*u + f.Y.x*w, f.origin.y + f.X.y*u + f.Y.y*w, f.origin.z + f.X.z*u + f.Y.z*w]; };
          const addTriAt = (i0,i1,i2, fStart, fEnd)=>{
            const p0=faceWorld[i0], p1=faceWorld[i1], p2=faceWorld[i2];
            const s0 = mapAt(p0, fStart), s1 = mapAt(p1, fStart), s2 = mapAt(p2, fStart);
            this.addTriangle(startName, s0, s2, s1);
            const e0 = mapAt(p0, fEnd), e1 = mapAt(p1, fEnd), e2 = mapAt(p2, fEnd);
            this.addTriangle(endName, e0, e1, e2);
          };
          const fStart = framesF[0], fEnd = framesF[framesF.length-1];
          if (hasIndex) { for (let t=0;t<idxAttr.count;t+=3){ addTriAt(idxAttr.getX(t+0)>>>0, idxAttr.getX(t+1)>>>0, idxAttr.getX(t+2)>>>0, fStart, fEnd); } }
          else { const triCount = (posAttr.count/3)|0; for (let t=0;t<triCount;t++){ addTriAt(3*t+0, 3*t+1, 3*t+2, fStart, fEnd); } }
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
      // Skip automatic island removal for extrusions based on traced images; tiny
      // sliver panels near sharp corners can be valid and removing them can open
      // the shell. Users can run repair tools explicitly if needed.
      // Build the manifold now so callers get a ready solid. If it fails due
      // to borderline vertex mismatches, progressively increase epsilon and
      // retry a few times.
      let ok = false; let attempt = 0; let errLast = null;
      while (!ok && attempt < 3) {
        try {
          const __tmpMesh = this.getMesh();
          try { /* probe only */ } finally { try { if (__tmpMesh && typeof __tmpMesh.delete === 'function') __tmpMesh.delete(); } catch {} }
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
