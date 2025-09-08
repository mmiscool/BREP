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
  constructor({ face, sweepPathEdges = [], distance = 1, name = 'Sweep' } = {}) {
    super({ name });
    this.params = { face, distance, sweepPathEdges, name };
    this.generate();
  }

  generate() {
    const { face, distance } = this.params;
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

    // Determine sweep vector
    let dir = null;
    if (distance instanceof THREE.Vector3) {
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

    // Prefer rebuilding caps using 2D profile groups from the sketch to ensure
    // identical boundary vertices with side walls.
    const groups = Array.isArray(face?.userData?.profileGroups) ? face.userData.profileGroups : null;
    if (groups && groups.length) {
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
          // End cap translated
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

      for (const loop of boundaryLoops) {
        const pts = Array.isArray(loop?.pts) ? loop.pts : loop;
        const isHole = !!(loop && loop.isHole);
        const pA = pts.slice();
        // ensure closed
        if (pA.length >= 2) {
          const first = pA[0];
          const last = pA[pA.length - 1];
          if (!(first[0] === last[0] && first[1] === last[1] && first[2] === last[2])) pA.push([first[0], first[1], first[2]]);
        }
        // remove consecutive duplicates if any
        for (let i = pA.length - 2; i >= 0; i--) {
          const a = pA[i], b = pA[i + 1];
          if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) pA.splice(i + 1, 1);
        }
        // build side quads around the loop using exact cap boundary vertices
        for (let i = 0; i < pA.length - 1; i++) {
          const a = pA[i];
          const b = pA[i + 1];
          if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) continue;
          const a2 = [a[0] + dir.x, a[1] + dir.y, a[2] + dir.z];
          const b2 = [b[0] + dir.x, b[1] + dir.y, b[2] + dir.z];
          // Pick face label by matching endpoints to originating edge; fallback to face-level label
          const setA = pointToEdgeNames.get(key(a));
          const setB = pointToEdgeNames.get(key(b));
          let name = `${face.name || 'FACE'}_SW`;
          if (setA && setB) {
            for (const n of setA) { if (setB.has(n)) { name = n; break; } }
          }
          if (isHole) {
            // reverse winding for hole walls to maintain outward orientation
            this.addTriangle(name, a, b2, b);
            this.addTriangle(name, a, a2, b2);
          } else {
            this.addTriangle(name, a, b, b2);
            this.addTriangle(name, a, b2, a2);
          }
        }
      }
    } else {
      // Fallback: build from per-edge polylines (may not match cap vertices exactly)
      const edges = Array.isArray(face.edges) ? face.edges : [];
      if (edges.length) {
        for (const edge of edges) {
          const name = `${edge.name || 'EDGE'}_SW`;

          // Helper: robustly extract world-space polyline points from Line, Line2, or cached polyline
          const pA = [];
          const wv = new THREE.Vector3();

          // 1) Prefer cached polyline provided during visualize
          const cached = edge?.userData?.polylineLocal;
          const isWorld = !!(edge?.userData?.polylineWorld);
          if (Array.isArray(cached) && cached.length >= 2) {
            if (isWorld) {
              for (let i = 0; i < cached.length; i++) {
                const p = cached[i];
                pA.push([p[0], p[1], p[2]]);
              }
            } else {
              for (let i = 0; i < cached.length; i++) {
                const p = cached[i];
                wv.set(p[0], p[1], p[2]).applyMatrix4(edge.matrixWorld);
                pA.push([wv.x, wv.y, wv.z]);
              }
            }
          } else {
            // 2) Try Buffer/LineGeometry position attribute
            const posAttr = edge?.geometry?.getAttribute?.('position');
            if (posAttr && posAttr.itemSize === 3 && posAttr.count >= 2) {
              for (let i = 0; i < posAttr.count; i++) {
                wv.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(edge.matrixWorld);
                pA.push([wv.x, wv.y, wv.z]);
              }
            } else {
              // 3) Fallback for LineSegments-based fat lines
              const aStart = edge?.geometry?.attributes?.instanceStart;
              const aEnd = edge?.geometry?.attributes?.instanceEnd;
              if (aStart && aEnd && aStart.itemSize === 3 && aEnd.itemSize === 3 && aStart.count === aEnd.count && aStart.count >= 1) {
                wv.set(aStart.getX(0), aStart.getY(0), aStart.getZ(0)).applyMatrix4(edge.matrixWorld);
                pA.push([wv.x, wv.y, wv.z]);
                for (let i = 0; i < aEnd.count; i++) {
                  wv.set(aEnd.getX(i), aEnd.getY(i), aEnd.getZ(i)).applyMatrix4(edge.matrixWorld);
                  pA.push([wv.x, wv.y, wv.z]);
                }
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
          for (let i = 0; i < n - 1; i++) {
            const a = pA[i];
            const b = pA[i + 1];
            if ((a[0] === b[0] && a[1] === b[1] && a[2] === b[2])) continue; // guard
            const a2 = [a[0] + dir.x, a[1] + dir.y, a[2] + dir.z];
            const b2 = [b[0] + dir.x, b[1] + dir.y, b[2] + dir.z];
            // two triangles; reverse winding for hole walls to maintain outward orientation
            if (isHole) {
              this.addTriangle(name, a, b2, b);
              this.addTriangle(name, a, a2, b2);
            } else {
              this.addTriangle(name, a, b, b2);
              this.addTriangle(name, a, b2, a2);
            }
          }
        }
      }

      // Weld seams by a tiny epsilon to ensure caps and sides share vertices exactly
      this.setEpsilon(1e-6);
      // Build the manifold now so callers get a ready solid
      try { this.getMesh(); } catch (_) { /* leave for caller to inspect if invalid */ }
    }
  }
}
