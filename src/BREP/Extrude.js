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
  /**
   * @param {object} [opts]
   * @param {import('./Face.js').Face} opts.face Source face to extrude
   * @param {number|import('three').Vector3} [opts.distance=1] Extrusion distance or explicit vector
   * @param {import('three').Vector3|null} [opts.dir=null] Optional direction vector override
   * @param {number} [opts.distanceBack=0] Optional backward extrusion distance
   * @param {string} [opts.name='Extrude'] Name of the resulting solid
   * @param {string|null} [opts.sideFaceName=null] Optional override for all side-wall face names
   */
  constructor({ face, distance = 1, dir = null, distanceBack = 0, name = 'Extrude', sideFaceName = null } = {}) {
    super();
    this.name = name;
    this.params = { face, distance, dir, distanceBack, sideFaceName };
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
    const backMag = Math.abs(Number(distanceBack));
    if (Number.isFinite(backMag) && backMag > 0) {
      const n = dirF.clone();
      if (n.lengthSq() < 1e-20) {
        const nf = (typeof face.getAverageNormal === 'function') ? face.getAverageNormal().clone() : new THREE.Vector3(0, 1, 0);
        dirB = nf.normalize().multiplyScalar(-backMag); // back is opposite of forward
      } else {
        dirB = n.normalize().multiplyScalar(-backMag); // back is opposite of forward
      }
    }

    const featureTag = this.name ? `${this.name}:` : '';
    const startName = `${featureTag}${face.name || 'Face'}_START`;
    const endName = `${featureTag}${face.name || 'Face'}_END`;

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
    // Snap helpers to ensure side walls share exact vertices with caps
    let __capWorld = null; // base cap vertices in world coords
    let __snapStart = null; // Map rounded -> exact start cap vertex
    let __snapEnd = null;   // Map rounded -> exact end cap vertex
    const __key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)},${p[2].toFixed(7)}`;
    const __makeSnapMap = (worldPts, offset) => {
      if (!worldPts) return null;
      const off = offset || new THREE.Vector3(0,0,0);
      const m = new Map();
      for (let i = 0; i < worldPts.length; i++) {
        const w = worldPts[i];
        const q = [w[0] + off.x, w[1] + off.y, w[2] + off.z];
        m.set(__key(q), q);
      }
      return m;
    };
    const __snap = (map, p) => {
      if (!map) return p;
      const s = map.get(__key(p));
      return s ? s : p;
    };
    if (posAttr) {
      const idxAttr = baseGeom.getIndex && baseGeom.getIndex();
      const v = new THREE.Vector3();
      const world = new Array(posAttr.count);
      for (let i = 0; i < posAttr.count; i++) {
        v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(face.matrixWorld);
        world[i] = [v.x, v.y, v.z];
      }
      __capWorld = world;
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
    // Build snap maps once caps are authored
    if (__capWorld) {
      __snapStart = __makeSnapMap(__capWorld, dirB ? dirB : new THREE.Vector3(0,0,0));
      __snapEnd = __makeSnapMap(__capWorld, dirF);
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

    // Prefer explicit boundary loops (outer + holes) to guarantee identical
    // vertices with caps, but emit one side face per original sketch edge.
    // Fallback to per-edge polylines if loops are unavailable.
    const sideSegments = [];
    const loops = face?.userData?.boundaryLoopsWorld;
    const nearEq = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
    const samePt = (P, Q) => P && Q && nearEq(P[0], Q[0]) && nearEq(P[1], Q[1]) && nearEq(P[2], Q[2]);
    const findEdgeNameFor = (A, B) => {
      const edges = Array.isArray(face?.edges) ? face.edges : [];
      for (const e of edges) {
        const poly = e?.userData?.polylineLocal;
        const isWorld = !!(e?.userData?.polylineWorld);
        if (Array.isArray(poly) && poly.length >= 2) {
          const P = isWorld ? poly : poly.map(p => {
            const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(e.matrixWorld); return [v.x, v.y, v.z];
          });
          const p0 = P[0], p1 = P[P.length - 1];
          if ((samePt(p0, A) && samePt(p1, B)) || (samePt(p0, B) && samePt(p1, A))) {
            return `${featureTag}${e?.name || 'EDGE'}_SW`;
          }
        }
      }
      return null;
    };

    if (Array.isArray(loops) && loops.length) {
      for (let li = 0; li < loops.length; li++) {
        const l = loops[li];
        if (!l || !Array.isArray(l.pts) || l.pts.length < 2) continue;
        // Build per-segment ribbons along the loop: [p[i] -> p[i+1]] and closing [last -> first]
        const pts = [];
        for (const p of l.pts) { if (p && p.length >= 3) pts.push([p[0], p[1], p[2]]); }
        // Dedup consecutive duplicates
        for (let i = pts.length - 2; i >= 0; i--) { const a = pts[i], b = pts[i + 1]; if (samePt(a, b)) pts.splice(i + 1, 1); }
        const M = pts.length;
        if (M < 2) continue;
        const emitSeg = (A, B, segIdx) => {
          const nmRaw = findEdgeNameFor(A, B) || `${featureTag}${face.name || 'Face'}_${li}_SEG${segIdx}_SW`;
          const nm = this.params.sideFaceName ? this.params.sideFaceName : nmRaw;
          sideSegments.push({ name: nm, poly: [A, B], isHole: !!l.isHole });
        };
        for (let i = 0; i < M - 1; i++) emitSeg(pts[i], pts[i + 1], i);
        // Closing segment
        emitSeg(pts[M - 1], pts[0], M - 1);
      }
    } else {
      const edges = Array.isArray(face?.edges) ? face.edges : [];
      for (const edge of edges) {
        const poly = extractPolylineWorld(edge);
        // Keep as a single ribbon for legacy faces
        const nmRaw = `${featureTag}${edge?.name || 'EDGE'}_SW`;
        const nm = this.params.sideFaceName ? this.params.sideFaceName : nmRaw;
        sideSegments.push({ name: nm, poly, isHole: !!(edge && edge.userData && edge.userData.isHole) });
      }
    }

    // One ribbon per segment/polyline
    for (const { name, poly, isHole } of sideSegments) {
      // Pre-count triangles already authored for this sidewall label so we
      // can verify how many were added for this edge (should be 2 per segment).
      const sideID = this._getOrCreateID(name);
      const triCountByID = (id) => {
        let c = 0; const ids = this._triIDs;
        for (let i = 0; i < ids.length; i++) if (ids[i] === id) c++;
        return c;
      };
      const beforeTris = triCountByID(sideID);
      if (!Array.isArray(poly) || poly.length < 2) continue;
      // Do NOT drop the final point even if it duplicates the start. We only
      // generate quads between consecutive samples and never auto-close the
      // polyline (no last->first segment). Keeping the duplicate ensures the
      // last actual segment (second-to-last -> last) is emitted for closed
      // edge polylines that repeat the first point at the end.
      const n = poly.length;
      const expectedSegments = Math.max(0, n - 1);
      if (dirB) {
        for (let i = 0; i < n - 1; i++) {
          const a = poly[i];
          const b = poly[i + 1];
          let A0 = [a[0] + dirB.x, a[1] + dirB.y, a[2] + dirB.z];
          let B0 = [b[0] + dirB.x, b[1] + dirB.y, b[2] + dirB.z];
          let A1 = [a[0] + dirF.x, a[1] + dirF.y, a[2] + dirF.z];
          let B1 = [b[0] + dirF.x, b[1] + dirF.y, b[2] + dirF.z];
          A0 = __snap(__snapStart, A0); B0 = __snap(__snapStart, B0);
          A1 = __snap(__snapEnd, A1);   B1 = __snap(__snapEnd, B1);
          addQuad(name, A0, B0, B1, A1, isHole);
        }
        // Closing handled upstream by emitting an explicit last->first segment when loops are available.
      } else {
        for (let i = 0; i < n - 1; i++) {
          const a = poly[i];
          const b = poly[i + 1];
          let A0 = [a[0], a[1], a[2]];
          let B0 = [b[0], b[1], b[2]];
          let A1 = [a[0] + dirF.x, a[1] + dirF.y, a[2] + dirF.z];
          let B1 = [b[0] + dirF.x, b[1] + dirF.y, b[2] + dirF.z];
          A0 = __snap(__snapStart, A0); B0 = __snap(__snapStart, B0);
          A1 = __snap(__snapEnd, A1);   B1 = __snap(__snapEnd, B1);
          addQuad(name, A0, B0, B1, A1, isHole);
        }
        // Closing handled upstream by emitting an explicit last->first segment when loops are available.
      }

      // Post-check: count how many triangles were added for this sidewall.
      const afterTris = triCountByID(sideID);
      const added = afterTris - beforeTris;
      const expected = expectedSegments * 2;
      if (added !== expected) {
        const msg = `Extrude sidewall triangle mismatch for ${name}: segments=${expectedSegments}, triangles=${added} (expected ${expected})`;
        try {
          if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(msg);
        } catch {}
        try { console.warn(msg); } catch {}
      }
    }

    // Check for cylindrical face metadata from circular edges
    try {
      // Look for edges that might be circular/arc and add metadata
      if (face && Array.isArray(face.edges)) {
        for (const edge of face.edges) {
          if (edge && edge.userData) {
            const geomType = edge.userData.sketchGeomType;
            let radius = null;
            let center = null;
            
            // Check if it's a circle
            if (geomType === 'circle' && 
                Array.isArray(edge.userData.circleCenter) && 
                typeof edge.userData.circleRadius === 'number') {
              radius = edge.userData.circleRadius;
              center = edge.userData.circleCenter;
            }
            // Check if it's an arc (any arc creates cylindrical surface when extruded)
            else if (geomType === 'arc' && 
                     Array.isArray(edge.userData.arcCenter) && 
                     typeof edge.userData.arcRadius === 'number') {
              radius = edge.userData.arcRadius;
              center = edge.userData.arcCenter;
            }
            
            // If we found a circular edge, add cylindrical face metadata
            if (radius !== null && center !== null) {
              const sidewallName = `${featureTag}${edge?.name || 'EDGE'}_SW`;

              // Bring the sketch-space center into the solid's coordinate system
              const transformMatrix = edge?.matrixWorld || face?.matrixWorld || null;
              const centerVec = new THREE.Vector3(center[0], center[1], center[2]);
              if (transformMatrix) centerVec.applyMatrix4(transformMatrix);

              // Forward/back vectors describing the sweep in world space
              const forwardVec = dirF ? dirF.clone() : new THREE.Vector3(0, 1, 0);
              const backwardVec = dirB ? dirB.clone() : new THREE.Vector3(0, 0, 0);

              // Axis endpoints (start/end of the cylindrical wall)
              const startPoint = centerVec.clone().add(backwardVec);
              const endPoint = centerVec.clone().add(forwardVec);
              const axisVec = endPoint.clone().sub(startPoint);

              let height = axisVec.length();
              if (!Number.isFinite(height) || height <= 1e-9) {
                height = forwardVec.length() + backwardVec.length();
              }

              let axisDir = axisVec.clone();
              if (axisDir.lengthSq() > 1e-12) {
                axisDir.normalize();
              } else {
                axisDir = forwardVec.clone();
                if (axisDir.lengthSq() > 1e-12) axisDir.normalize();
                else axisDir.set(0, 1, 0);
              }

              const axisCenter = startPoint.clone().addScaledVector(axisVec, 0.5);
              if (!Number.isFinite(axisCenter.x) || !Number.isFinite(axisCenter.y) || !Number.isFinite(axisCenter.z)) {
                axisCenter.copy(centerVec);
              }

              if (!Number.isFinite(axisDir.x) || !Number.isFinite(axisDir.y) || !Number.isFinite(axisDir.z)) {
                axisDir.set(0, 1, 0);
              }

              this.setFaceMetadata(sidewallName, {
                type: 'cylindrical',
                radius: radius,
                height: Number.isFinite(height) ? height : 0,
                axis: [axisDir.x, axisDir.y, axisDir.z],
                center: [axisCenter.x, axisCenter.y, axisCenter.z]
              });
            }
          }
        }
      }
    } catch (err) {
      // Silently continue if metadata detection fails
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
