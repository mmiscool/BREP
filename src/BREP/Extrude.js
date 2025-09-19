import * as THREE from 'three';
import { Solid } from './BetterSolid.js';

// Build a closed extruded solid from a single face by translating
// the face and sweeping exactly one side wall per original edge.
//
// Guarantees
// - One labeled side wall per input edge: `${edge.name||'EDGE'}_SW`.
// - Caps are a translation of the original face triangles: start is reversed,
//   end is translated by `dirF`. If `dirB` is provided, start cap is placed at
//   `face + dirB`; otherwise it uses the base face.
// - Never attempts to close an open edge polyline unless its endpoints are
//   exactly identical. Consecutive duplicate points are removed.
// - Calls `setEpsilon(adaptive)` to weld vertices and drop degenerates.
export class ExtrudeSolid extends Solid {
  constructor({ face, distance = 1, dir = null, distanceBack = 0, name = 'Extrude' } = {}) {
    super();
    this.name = name;
    this.params = { face, distance, dir, distanceBack };
    this.generate();
  }

  generate() {
    const { face, distance, dir, distanceBack } = this.params;
    if (!face || !face.geometry) return this;

    // Compute forward/backward translation vectors
    let dirF = null; let dirB = null;
    if (dir && dir.isVector3) {
      dirF = dir.clone();
    } else if (distance instanceof THREE.Vector3) {
      dirF = distance.clone();
    } else if (typeof distance === 'number') {
      const n = (typeof face.getAverageNormal === 'function') ? face.getAverageNormal().clone() : new THREE.Vector3(0, 1, 0);
      if (n.lengthSq() < 1e-20) n.set(0, 1, 0);
      dirF = n.normalize().multiplyScalar(distance);
    } else {
      dirF = new THREE.Vector3(0, 1, 0);
    }
    if (Number.isFinite(distanceBack) && distanceBack !== 0) {
      const n = dirF.clone();
      if (n.lengthSq() < 1e-20) {
        const nf = (typeof face.getAverageNormal === 'function') ? face.getAverageNormal().clone() : new THREE.Vector3(0, 1, 0);
        dirB = nf.normalize().multiplyScalar(-distanceBack); // supports negative values
      } else {
        dirB = n.normalize().multiplyScalar(-distanceBack); // supports negative values
      }
    }

    const startName = `${face.name || 'Face'}_START`;
    const endName = `${face.name || 'Face'}_END`;

    // Helper: add two triangles for a quad using the better diagonal.
    const addQuad = (faceName, A0, B0, B1, A1, isHole) => {
      const v = (p, q) => new THREE.Vector3(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      const areaTri = (a, b, c) => v(a, b).cross(v(a, c)).length();
      const areaD1 = areaTri(A0, B0, B1) + areaTri(A0, B1, A1);
      const areaD2 = areaTri(A0, B0, A1) + areaTri(B0, B1, A1);
      const epsA = 1e-18;
      if (!(areaD1 > epsA || areaD2 > epsA)) return;
      if (areaD2 > areaD1) {
        if (isHole) { this.addTriangle(faceName, A0, A1, B0); this.addTriangle(faceName, B0, A1, B1); }
        else        { this.addTriangle(faceName, A0, B0, A1); this.addTriangle(faceName, B0, B1, A1); }
      } else {
        if (isHole) { this.addTriangle(faceName, A0, B1, B0); this.addTriangle(faceName, A0, A1, B1); }
        else        { this.addTriangle(faceName, A0, B0, B1); this.addTriangle(faceName, A0, B1, A1); }
      }
    };

    // Caps: copy face triangles in world space, translate end, reverse start.
    const baseGeom = face.geometry;
    const posAttr = baseGeom.getAttribute && baseGeom.getAttribute('position');
    if (posAttr) {
      const idxAttr = baseGeom.getIndex && baseGeom.getIndex();
      const v = new THREE.Vector3();
      const world = new Array(posAttr.count);
      for (let i = 0; i < posAttr.count; i++) {
        v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(face.matrixWorld);
        world[i] = [v.x, v.y, v.z];
      }
      const emit = (i0, i1, i2) => {
        const p0 = world[i0], p1 = world[i1], p2 = world[i2];
        // Start cap
        if (dirB) {
          const b0 = [p0[0] + dirB.x, p0[1] + dirB.y, p0[2] + dirB.z];
          const b1 = [p1[0] + dirB.x, p1[1] + dirB.y, p1[2] + dirB.z];
          const b2 = [p2[0] + dirB.x, p2[1] + dirB.y, p2[2] + dirB.z];
          this.addTriangle(startName, b0, b2, b1);
        } else {
          this.addTriangle(startName, p0, p2, p1);
        }
        // End cap
        const q0 = [p0[0] + dirF.x, p0[1] + dirF.y, p0[2] + dirF.z];
        const q1 = [p1[0] + dirF.x, p1[1] + dirF.y, p1[2] + dirF.z];
        const q2 = [p2[0] + dirF.x, p2[1] + dirF.y, p2[2] + dirF.z];
        this.addTriangle(endName, q0, q1, q2);
      };
      if (idxAttr) {
        for (let t = 0; t < idxAttr.count; t += 3) emit(idxAttr.getX(t + 0) >>> 0, idxAttr.getX(t + 1) >>> 0, idxAttr.getX(t + 2) >>> 0);
      } else {
        const triCount = (posAttr.count / 3) | 0;
        for (let t = 0; t < triCount; t++) emit(3 * t + 0, 3 * t + 1, 3 * t + 2);
      }
    }

    // Helper: get world-space polyline for an edge. Never auto-close.
    const extractPolylineWorld = (edge) => {
      const out = [];
      const cached = edge?.userData?.polylineLocal;
      const isWorld = !!(edge?.userData?.polylineWorld);
      const v = new THREE.Vector3();
      if (Array.isArray(cached) && cached.length >= 2) {
        if (isWorld) {
          for (const p of cached) out.push([p[0], p[1], p[2]]);
        } else {
          for (const p of cached) { v.set(p[0], p[1], p[2]).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]); }
        }
      } else {
        const pos = edge?.geometry?.getAttribute?.('position');
        if (pos && pos.itemSize === 3 && pos.count >= 2) {
          for (let i = 0; i < pos.count; i++) { v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]); }
        } else {
          const aStart = edge?.geometry?.attributes?.instanceStart;
          const aEnd = edge?.geometry?.attributes?.instanceEnd;
          if (aStart && aEnd && aStart.itemSize === 3 && aEnd.itemSize === 3 && aStart.count === aEnd.count && aStart.count >= 1) {
            v.set(aStart.getX(0), aStart.getY(0), aStart.getZ(0)).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]);
            for (let i = 0; i < aEnd.count; i++) { v.set(aEnd.getX(i), aEnd.getY(i), aEnd.getZ(i)).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]); }
          }
        }
      }
      // Remove consecutive duplicates only
      for (let i = out.length - 2; i >= 0; i--) {
        const a = out[i], b = out[i + 1];
        if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) out.splice(i + 1, 1);
      }
      return out;
    };

    // One ribbon per edge
    const edges = Array.isArray(face?.edges) ? face.edges : [];
    for (const edge of edges) {
      const name = `${edge?.name || 'EDGE'}_SW`;
      // Pre-count triangles already authored for this sidewall label so we
      // can verify how many were added for this edge (should be 2 per segment).
      const sideID = this._getOrCreateID(name);
      const triCountByID = (id) => {
        let c = 0; const ids = this._triIDs;
        for (let i = 0; i < ids.length; i++) if (ids[i] === id) c++;
        return c;
      };
      const beforeTris = triCountByID(sideID);
      const poly = extractPolylineWorld(edge);
      if (!Array.isArray(poly) || poly.length < 2) continue;
      // Do NOT drop the final point even if it duplicates the start. We only
      // generate quads between consecutive samples and never auto-close the
      // polyline (no last->first segment). Keeping the duplicate ensures the
      // last actual segment (second-to-last -> last) is emitted for closed
      // edge polylines that repeat the first point at the end.
      const n = poly.length;
      const isHole = !!(edge && edge.userData && edge.userData.isHole);
      const expectedSegments = Math.max(0, n - 1);
      if (dirB) {
        for (let i = 0; i < n - 1; i++) {
          const a = poly[i];
          const b = poly[i + 1];
          const A0 = [a[0] + dirB.x, a[1] + dirB.y, a[2] + dirB.z];
          const B0 = [b[0] + dirB.x, b[1] + dirB.y, b[2] + dirB.z];
          const A1 = [a[0] + dirF.x, a[1] + dirF.y, a[2] + dirF.z];
          const B1 = [b[0] + dirF.x, b[1] + dirF.y, b[2] + dirF.z];
          addQuad(name, A0, B0, B1, A1, isHole);
        }
      } else {
        for (let i = 0; i < n - 1; i++) {
          const a = poly[i];
          const b = poly[i + 1];
          const A0 = [a[0], a[1], a[2]];
          const B0 = [b[0], b[1], b[2]];
          const A1 = [a[0] + dirF.x, a[1] + dirF.y, a[2] + dirF.z];
          const B1 = [b[0] + dirF.x, b[1] + dirF.y, b[2] + dirF.z];
          addQuad(name, A0, B0, B1, A1, isHole);
        }
      }

      // Post-check: count how many triangles were added for this sidewall.
      const afterTris = triCountByID(sideID);
      const added = afterTris - beforeTris;
      const expected = expectedSegments * 2;
      if (added !== expected) {
        alert(`Extrude sidewall triangle mismatch for ${edge?.name || 'EDGE'}: segments=${expectedSegments}, triangles=${added} (expected ${expected})`);
        const msg = `Extrude sidewall triangle mismatch for ${edge?.name || 'EDGE'}: segments=${expectedSegments}, triangles=${added} (expected ${expected})`;
        try {
          if (typeof window !== 'undefined' && typeof window.alert === 'function') {
            window.alert(msg);
          } else {
            console.warn(msg);
          }
        } catch (_) { console.warn(msg); }
      }
    }

    // Adaptive weld epsilon so caps and sides share vertices exactly.
    let eps = 1e-5;
    if (this._vertProperties.length >= 6) {
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
      const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
      eps = Math.min(1e-4, Math.max(1e-7, diag * 1e-6));
    }
    this.setEpsilon(eps);
    try { this.removeSmallIslands({ maxTriangles: 12, removeInternal: true, removeExternal: true }); } catch {}
    // this.fixTriangleWindingsByAdjacency();
    // this.fixTriangleWindingsByAdjacency();
    return this;
  }
}

export function extrudeFace({ face, distance = 1, dir = null, distanceBack = 0, name = 'Extrude' } = {}) {
  return new ExtrudeSolid({ face, distance, dir, distanceBack, name });
}
