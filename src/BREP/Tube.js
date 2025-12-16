import { Solid } from './BetterSolid.js';
import { Manifold, THREE } from './SolidShared.js';

const DEFAULT_SEGMENTS = 32;
const EPS = 1e-9;
const EPS_SQ = EPS * EPS;

function toVector3Array(points) {
  const out = [];
  if (!Array.isArray(points)) return out;
  for (const p of points) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    const z = Number(p[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    out.push(new THREE.Vector3(x, y, z));
  }
  return out;
}

function dedupeVectors(vectors, eps = 1e-7) {
  if (!Array.isArray(vectors) || vectors.length === 0) return [];
  const epsSq = eps * eps;
  const out = [vectors[0].clone()];
  for (let i = 1; i < vectors.length; i++) {
    const v = vectors[i];
    if (!v) continue;
    if (v.distanceToSquared(out[out.length - 1]) > epsSq) out.push(v.clone());
  }
  return out;
}

function calculateTubeIntersectionTrimming(points, tubeRadius) {
  if (!Array.isArray(points) || points.length < 2) {
    return Array.isArray(points) ? points.map(p => p.clone()) : [];
  }

  if (points.length === 2) {
    return points.map(p => p.clone());
  }

  const out = [];
  out.push(points[0].clone());

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    if (!prev || !curr || !next) {
      out.push(curr.clone());
      continue;
    }

    const vPrev = curr.clone().sub(prev);
    const vNext = next.clone().sub(curr);

    if (vPrev.lengthSq() < EPS_SQ || vNext.lengthSq() < EPS_SQ) {
      out.push(curr.clone());
      continue;
    }

    vPrev.normalize();
    vNext.normalize();

    const dot = THREE.MathUtils.clamp(vPrev.dot(vNext), -1, 1);
    const angle = Math.acos(Math.abs(dot));

    if (angle > Math.PI / 3) {
      const halfAngle = angle * 0.5;
      const intersectionDist = tubeRadius / Math.tan(halfAngle);
      const distPrev = prev.distanceTo(curr);
      const distNext = curr.distanceTo(next);
      const trimDistPrev = Math.min(intersectionDist * 0.8, distPrev * 0.6);
      const trimDistNext = Math.min(intersectionDist * 0.8, distNext * 0.6);

      if (trimDistPrev > tubeRadius * 0.1 && trimDistNext > tubeRadius * 0.1) {
        const trimmedPrev = curr.clone().addScaledVector(vPrev, -trimDistPrev);
        const trimmedNext = curr.clone().addScaledVector(vNext, trimDistNext);

        if (out[out.length - 1].distanceTo(trimmedPrev) > 1e-6) {
          out.push(trimmedPrev);
        }

        out.push(trimmedNext);
      } else {
        out.push(curr.clone());
      }
    } else {
      out.push(curr.clone());
    }
  }

  out.push(points[points.length - 1].clone());
  return dedupeVectors(out, 1e-6);
}

function smoothPath(points, tubeRadius) {
  try {
    const trimmedPoints = calculateTubeIntersectionTrimming(points, tubeRadius);
    if (!Array.isArray(trimmedPoints) || trimmedPoints.length < 2) {
      return Array.isArray(points) ? points.map(p => p.clone()) : [];
    }
    return dedupeVectors(trimmedPoints, 1e-9);
  } catch (error) {
    console.error('Error in smoothPath:', error);
    return points.map(p => p.clone());
  }
}

const tmpVecA = new THREE.Vector3();
const tmpVecB = new THREE.Vector3();
const tmpVecC = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();

function computeFrames(points, closed = false) {
  const tangents = [];
  const normals = [];
  const binormals = [];
  if (!Array.isArray(points) || points.length < 2) return { tangents, normals, binormals };

  const vec = new THREE.Vector3();
  const normalSeed = new THREE.Vector3();

  for (let i = 0; i < points.length; i++) {
    const tangent = new THREE.Vector3();

    if (closed) {
      const prevIdx = (i - 1 + points.length) % points.length;
      const nextIdx = (i + 1) % points.length;
      const forward = new THREE.Vector3().subVectors(points[nextIdx], points[i]);
      const backward = new THREE.Vector3().subVectors(points[i], points[prevIdx]);

      const forwardLen = forward.length();
      const backwardLen = backward.length();

      if (forwardLen > EPS && backwardLen > EPS) {
        forward.normalize();
        backward.normalize();
        tangent.addVectors(forward, backward).normalize();
      } else if (forwardLen > EPS) {
        tangent.copy(forward).normalize();
      } else if (backwardLen > EPS) {
        tangent.copy(backward).normalize();
      } else {
        tangent.set(0, 0, 1);
      }
    } else {
      if (i === 0) {
        tangent.subVectors(points[1], points[0]);
      } else if (i === points.length - 1) {
        tangent.subVectors(points[i], points[i - 1]);
      } else {
        const forward = new THREE.Vector3().subVectors(points[i + 1], points[i]);
        const backward = new THREE.Vector3().subVectors(points[i], points[i - 1]);
        const forwardLen = forward.length();
        const backwardLen = backward.length();

        if (forwardLen > EPS && backwardLen > EPS) {
          forward.normalize();
          backward.normalize();
          tangent.addVectors(forward, backward).normalize();
        } else if (forwardLen > EPS) {
          tangent.copy(forward).normalize();
        } else if (backwardLen > EPS) {
          tangent.copy(backward).normalize();
        } else {
          tangent.copy(i > 0 ? tangents[i - 1] : new THREE.Vector3(0, 0, 1));
        }
      }
    }

    tangents.push(tangent.normalize());
  }

  normalSeed.set(0, 0, 1);
  if (Math.abs(tangents[0].dot(normalSeed)) > 0.99) {
    normalSeed.set(1, 0, 0);
  }

  normals.push(new THREE.Vector3().crossVectors(tangents[0], normalSeed).cross(tangents[0]).normalize());
  binormals.push(new THREE.Vector3().crossVectors(tangents[0], normals[0]).normalize());

  for (let i = 1; i < points.length; i++) {
    normals.push(normals[i - 1].clone());
    binormals.push(binormals[i - 1].clone());

    const deltaT = tangents[i - 1].dot(tangents[i]);
    if (deltaT <= 1 - EPS) {
      const axis = new THREE.Vector3().crossVectors(tangents[i - 1], tangents[i]).normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(deltaT, -1, 1));
      const mat = new THREE.Matrix4().makeRotationAxis(axis, angle);
      normals[i].applyMatrix4(mat).normalize();
      binormals[i].crossVectors(tangents[i], normals[i]).normalize();
    }
  }

  if (closed && points.length > 2) {
    const avgNormal = normals.reduce((acc, n) => acc.add(n), new THREE.Vector3()).normalize();
    for (let i = 0; i < normals.length; i++) {
      const projection = normals[i].clone().sub(tangents[i].clone().multiplyScalar(tangents[i].dot(normals[i])));
      if (projection.lengthSq() > EPS_SQ) {
        normals[i].copy(projection.normalize());
        binormals[i].crossVectors(tangents[i], projection).normalize();
      } else {
        normals[i].copy(avgNormal);
        binormals[i].crossVectors(tangents[i], avgNormal).normalize();
      }
    }
  }

  return { tangents, normals, binormals };
}

function buildRings(points, normals, binormals, radius, innerRadius, segments) {
  const outer = [];
  const inner = innerRadius > 0 ? [] : null;

  for (let i = 0; i < points.length; i++) {
    const normal = normals[i];
    const binormal = binormals[i];
    const ringOuter = [];
    const ringInner = inner ? [] : null;

    for (let j = 0; j < segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const offset = normal.clone().multiplyScalar(cos).add(binormal.clone().multiplyScalar(sin));

      const outerPoint = points[i].clone().addScaledVector(offset, radius);
      ringOuter.push([outerPoint.x, outerPoint.y, outerPoint.z]);

      if (inner && innerRadius > 0) {
        const innerPoint = points[i].clone().addScaledVector(offset, innerRadius);
        ringInner.push([innerPoint.x, innerPoint.y, innerPoint.z]);
      }
    }

    outer.push(ringOuter);
    if (inner && innerRadius > 0) inner.push(ringInner);
  }

  return { outer, inner };
}

function addTriangleOriented(solid, name, a, b, c, outwardDir) {
  if (!outwardDir || outwardDir.lengthSq() < 1e-10) {
    solid.addTriangle(name, a, b, c);
    return;
  }
  tmpVecA.set(a[0], a[1], a[2]);
  tmpVecB.set(b[0], b[1], b[2]).sub(tmpVecA);
  tmpVecC.set(c[0], c[1], c[2]).sub(tmpVecA);
  tmpNormal.copy(tmpVecB).cross(tmpVecC);
  if (tmpNormal.dot(outwardDir) < 0) {
    solid.addTriangle(name, a, c, b);
  } else {
    solid.addTriangle(name, a, b, c);
  }
}

function addQuadOriented(solid, name, a, b, c, d, outwardDir) {
  addTriangleOriented(solid, name, a, b, c, outwardDir);
  addTriangleOriented(solid, name, a, c, d, outwardDir);
}

function addDiskCap(solid, name, center, ring, outwardDir) {
  for (let j = 0; j < ring.length; j++) {
    const j1 = (j + 1) % ring.length;
    addTriangleOriented(solid, name, center, ring[j], ring[j1], outwardDir);
  }
}

function addRingCap(solid, name, outerRing, innerRing, outwardDir) {
  const count = outerRing.length;
  for (let j = 0; j < count; j++) {
    const j1 = (j + 1) % count;
    addQuadOriented(solid, name, outerRing[j], outerRing[j1], innerRing[j1], innerRing[j], outwardDir);
  }
}

function copySolidState(target, source, { auxEdges } = {}) {
  target._numProp = source._numProp;
  target._vertProperties = source._vertProperties;
  target._triVerts = source._triVerts;
  target._triIDs = source._triIDs;
  target._vertKeyToIndex = new Map(source._vertKeyToIndex);

  target._idToFaceName = new Map(source._idToFaceName);
  target._faceNameToID = new Map(source._faceNameToID);
  target._faceMetadata = new Map(source._faceMetadata);
  target._edgeMetadata = new Map(source._edgeMetadata);

  target._auxEdges = auxEdges !== undefined ? auxEdges : Array.isArray(source._auxEdges) ? source._auxEdges : [];
  target._manifold = source._manifold;
  target._dirty = false;
  target._faceIndex = null;
}

function normalizePath(points, requestedClosed, tol) {
  const clean = dedupeVectors(points, tol);
  if (clean.length < 2) return { points: clean, closed: false };

  const start = clean[0];
  const end = clean[clean.length - 1];
  const closureTol = Math.max(tol * 4, EPS);
  const isClosed = !!requestedClosed || start.distanceToSquared(end) <= closureTol * closureTol;
  if (isClosed && start.distanceToSquared(end) <= closureTol * closureTol) {
    clean.pop(); // drop the duplicate end point
  }
  return { points: clean, closed: isClosed };
}

function trimPlaneFromPoints(anchor, neighbor, invert = false) {
  if (!anchor || !neighbor) return null;
  const normalVec = new THREE.Vector3().subVectors(neighbor, anchor);
  if (normalVec.lengthSq() <= EPS) return null;
  if (invert) normalVec.negate();
  normalVec.normalize();
  return {
    anchor,
    normalVec,
    normalArray: [normalVec.x, normalVec.y, normalVec.z],
    offset: normalVec.dot(anchor),
  };
}

function applyTrimPlaneSequentially(spheres, points, radius, plane, iterateForward = true) {
  if (!plane || !Array.isArray(spheres) || !Array.isArray(points) || !(radius > 0)) return;

  const start = iterateForward ? 0 : spheres.length - 1;
  const end = iterateForward ? spheres.length : -1;
  const step = iterateForward ? 1 : -1;
  for (let idx = start; idx !== end; idx += step) {
    const center = points[idx];
    if (!center) continue;
    if (center.distanceTo(plane.anchor) > radius) break;
    const sphere = spheres[idx];
    if (!sphere) continue;
    const trimmed = sphere.trimByPlane(plane.normalArray, plane.offset);
    if (!trimmed) {
      spheres[idx] = trimmed;
      continue;
    }
    if (trimmed !== sphere) {
      try { if (typeof sphere.delete === 'function') sphere.delete(); } catch { }
      spheres[idx] = trimmed;
    } else {
      spheres[idx] = trimmed;
    }
  }
}

function buildHullChain(points, radius, resolution, closed, { keepSpheres = false, trimPlanes = null } = {}) {
  if (!Array.isArray(points) || points.length < 2) return { hull: null, spheres: [] };

  const baseSphere = Manifold.sphere(radius, resolution);
  const spheres = points.map(pt => baseSphere.translate([pt.x, pt.y, pt.z]));
  try { if (typeof baseSphere.delete === 'function') baseSphere.delete(); } catch { }

  if (!closed && trimPlanes) {
    if (trimPlanes.start) applyTrimPlaneSequentially(spheres, points, radius, trimPlanes.start, true);
    if (trimPlanes.end) applyTrimPlaneSequentially(spheres, points, radius, trimPlanes.end, false);
  }

  const hulls = [];
  const segmentCount = closed ? points.length : points.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const sphereA = spheres[i];
    const sphereB = spheres[(i + 1) % spheres.length];
    if (!a || !b || !sphereA || !sphereB) continue;
    if (a.distanceToSquared(b) < EPS * EPS) continue;
    hulls.push(Manifold.hull([sphereA, sphereB]));
  }

  if (!keepSpheres) {
    for (const s of spheres) { try { if (s && typeof s.delete === 'function') s.delete(); } catch { } }
  }

  if (!hulls.length) return { hull: null, spheres: keepSpheres ? spheres : [] };
  if (hulls.length === 1) return { hull: hulls[0], spheres: keepSpheres ? spheres : [] };

  let combined = null;
  try {
    combined = Manifold.union(hulls);
    return { hull: combined, spheres: keepSpheres ? spheres : [] };
  } finally {
    for (const h of hulls) {
      if (h && h !== combined) {
        try { if (typeof h.delete === 'function') h.delete(); } catch { }
      }
    }
  }
}

function buildHullTube(points, radius, resolution, closed, keepSpheres = false, trimPlanes = null) {
  const { hull, spheres } = buildHullChain(points, radius, resolution, closed, { keepSpheres, trimPlanes });
  if (!hull) throw new Error('Unable to build tube hulls from the supplied path.');
  return { manifold: hull, spheres };
}

function rebuildSolidFromManifold(target, manifold, faceMap) {
  const rebuilt = Solid._fromManifold(manifold, faceMap);

  // Copy authoring buffers and metadata without clobbering THREE.Object3D fields
  target._numProp = rebuilt._numProp;
  target._vertProperties = rebuilt._vertProperties;
  target._triVerts = rebuilt._triVerts;
  target._triIDs = rebuilt._triIDs;
  target._vertKeyToIndex = new Map(rebuilt._vertKeyToIndex);

  target._idToFaceName = new Map(rebuilt._idToFaceName);
  target._faceNameToID = new Map(rebuilt._faceNameToID);
  target._faceMetadata = new Map(rebuilt._faceMetadata);
  target._edgeMetadata = new Map(rebuilt._edgeMetadata);

  target._manifold = rebuilt._manifold;
  target._dirty = false;
  target._faceIndex = null;
  return target;
}

function distanceToSegmentSquared(p, a, b) {
  const ab = b.clone().sub(a);
  const ap = p.clone().sub(a);
  const t = THREE.MathUtils.clamp(ap.dot(ab) / ab.lengthSq(), 0, 1);
  const closest = a.clone().addScaledVector(ab, t);
  return p.distanceToSquared(closest);
}

function minDistanceToPolyline(points, polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) return Infinity;
  let minSq = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    minSq = Math.min(minSq, distanceToSegmentSquared(points, a, b));
  }
  return Math.sqrt(minSq);
}

function relabelFaces(solid, pathPoints, startNormal, endNormal, outerRadius, innerRadius, closed, faceTag) {
  if (!solid || !solid._vertProperties || !solid._triVerts) return solid;
  const triCount = (solid._triVerts.length / 3) | 0;
  if (!triCount) return solid;

  // Reset face ID maps so we allocate fresh, globally unique IDs. Manifold-built
  // hulls often reuse low IDs (e.g., 0) which collide across multiple tube
  // solids during booleans and cause distinct faces to merge under one label.
  solid._faceNameToID = new Map();
  solid._idToFaceName = new Map();

  const nStart = startNormal ? startNormal.clone().normalize() : null;
  const nEnd = endNormal ? endNormal.clone().normalize() : null;
  const startOffset = nStart ? nStart.dot(pathPoints[0]) : 0;
  const endOffset = nEnd ? nEnd.dot(pathPoints[pathPoints.length - 1]) : 0;
  const capTol = Math.max(outerRadius * 1e-2, 1e-5);

  const idOuter = solid._getOrCreateID(`${faceTag}_Outer`);
  const idInner = innerRadius > 0 ? solid._getOrCreateID(`${faceTag}_Inner`) : idOuter;
  const idCapStart = (!closed && nStart) ? solid._getOrCreateID(`${faceTag}_CapStart`) : idOuter;
  const idCapEnd = (!closed && nEnd) ? solid._getOrCreateID(`${faceTag}_CapEnd`) : idOuter;

  const newIDs = new Array(triCount);
  const vp = solid._vertProperties;
  const tv = solid._triVerts;
  const polyline = pathPoints;
  const innerOuterThreshold = innerRadius > 0 ? (innerRadius + outerRadius) * 0.5 : outerRadius * 0.5;

  for (let t = 0; t < triCount; t++) {
    const i0 = tv[t * 3 + 0] * 3;
    const i1 = tv[t * 3 + 1] * 3;
    const i2 = tv[t * 3 + 2] * 3;
    const cx = (vp[i0 + 0] + vp[i1 + 0] + vp[i2 + 0]) / 3;
    const cy = (vp[i0 + 1] + vp[i1 + 1] + vp[i2 + 1]) / 3;
    const cz = (vp[i0 + 2] + vp[i1 + 2] + vp[i2 + 2]) / 3;
    const centroid = new THREE.Vector3(cx, cy, cz);

    let assigned = idOuter;
    const distToStart = centroid.distanceTo(pathPoints[0]);
    const distToEnd = centroid.distanceTo(pathPoints[pathPoints.length - 1]);
    if (!closed && nStart && Math.abs(nStart.dot(centroid) - startOffset) <= capTol && distToStart <= outerRadius + capTol) {
      assigned = idCapStart;
    } else if (!closed && nEnd && Math.abs(nEnd.dot(centroid) - endOffset) <= capTol && distToEnd <= outerRadius + capTol) {
      assigned = idCapEnd;
    } else if (innerRadius > 0) {
      const dist = minDistanceToPolyline(centroid, polyline);
      assigned = dist <= innerOuterThreshold ? idInner : idOuter;
    }
    newIDs[t] = assigned;
  }

  solid._triIDs = newIDs;
  solid._idToFaceName = new Map([
    [idOuter, `${faceTag}_Outer`],
    ...(innerRadius > 0 ? [[idInner, `${faceTag}_Inner`]] : []),
    ...(!closed && nStart ? [[idCapStart, `${faceTag}_CapStart`]] : []),
    ...(!closed && nEnd ? [[idCapEnd, `${faceTag}_CapEnd`]] : []),
  ]);
  solid._faceNameToID = new Map(
    [...solid._idToFaceName.entries()].map(([id, name]) => [name, id]),
  );

  // Rebuild manifold with the new face IDs
  try { if (typeof solid.free === 'function') solid.free(); } catch { }
  solid._dirty = true;
  solid._faceIndex = null;
  try { solid._manifoldize(); } catch { /* leave dirty if rebuild fails */ }
  return solid;
}

function firstTangent(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  for (let i = 1; i < points.length; i++) {
    const dir = new THREE.Vector3().subVectors(points[i], points[i - 1]);
    if (dir.lengthSq() > EPS) return dir.normalize();
  }
  return null;
}

function lastTangent(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  for (let i = points.length - 1; i >= 1; i--) {
    const dir = new THREE.Vector3().subVectors(points[i], points[i - 1]);
    if (dir.lengthSq() > EPS) return dir.normalize();
  }
  return null;
}

function singleFaceSolidFromManifold(manifold, faceName) {
  const name = faceName || 'Sphere';
  const solid = Solid._fromManifold(manifold, new Map([[0, name]]));
  const id = solid._getOrCreateID(name);
  const triCount = (solid._triVerts.length / 3) | 0;
  solid._triIDs = new Array(triCount).fill(id);
  solid._idToFaceName = new Map([[id, name]]);
  solid._faceNameToID = new Map([[name, id]]);
  solid._dirty = true;
  try { solid._manifoldize(); } catch { }
  return solid;
}

export class Tube extends Solid {
  /**
   * Build a tube solid along a polyline using convex hulls between spheres.
   * @param {object} [opts]
   * @param {Array<[number,number,number]>} [opts.points=[]] Path points for the tube centerline
   * @param {number} [opts.radius=1] Outer radius
   * @param {number} [opts.innerRadius=0] Optional inner radius (0 for solid tube)
   * @param {number} [opts.resolution=32] Sphere segment count (controls smoothness)
   * @param {boolean} [opts.closed=false] Whether the path is closed (auto-detected if endpoints match)
   * @param {string} [opts.name='Tube'] Name for the solid
   */
  constructor(opts = {}) {
    super();
    const {
      points = [],
      radius = 1,
      innerRadius = 0,
      resolution = DEFAULT_SEGMENTS,
      closed = false,
      name = 'Tube',
      debugSpheres = false,
      useTubeFast = true,
      preferFast,
    } = opts;
    const preferFastValue = preferFast !== undefined ? !!preferFast : useTubeFast !== false;
    this.params = { points, radius, innerRadius, resolution, closed, name, debugSpheres, preferFast: preferFastValue };
    this.name = name;

    if (Array.isArray(points) && points.length >= 2) {
      const firstPoint = points[0];
      const lastPoint = points[points.length - 1];
      if (firstPoint[0] === lastPoint[0] && firstPoint[1] === lastPoint[1] && firstPoint[2] === lastPoint[2]) {
        this.params.closed = true;
      }
    }

    try {
      const hasPath = Array.isArray(points) && points.length >= 2;
      const validRadius = Number(radius) > 0;
      if (hasPath && validRadius) {
        this.generate();
        this.visualize();
      }
    } catch {
      // Fail-quietly to keep boolean reconstruction safe
    }
  }

  generate(){
    const preferFast = this.params?.preferFast !== false;
    if (preferFast) {
      try {
        this.generateFast();
        const stats = this._selfUnionStats;
        if (stats?.selfIntersectionLikely) {
          if (typeof this.free === 'function') { try { this.free(); } catch { } }
          return this.generateSlow();
        }
        return this;
      } catch (error) {
        console.warn('Tube fast generation failed; falling back to slow.', error);
        if (typeof this.free === 'function') { try { this.free(); } catch { } }
      }
    }
    return this.generateSlow();
  }

  generateFast() {
    let { points, radius, innerRadius, resolution, closed, name } = this.params;
    let isClosed = !!closed;
    if (!(radius > 0)) throw new Error('Tube radius must be greater than zero.');
    const inner = Number(innerRadius) || 0;
    if (inner < 0) throw new Error('Inside radius cannot be negative.');
    if (inner > 0 && inner >= radius) throw new Error('Inside radius must be smaller than the outer radius.');
    const segs = Math.max(8, Math.floor(Number(resolution) || DEFAULT_SEGMENTS));

    const vecPoints = dedupeVectors(toVector3Array(points));
    if (vecPoints.length < 2) throw new Error(`Tube requires at least two distinct path points. Got ${vecPoints.length} valid points from ${points.length} input points.`);

    const scaleEstimate = vecPoints.reduce((m, p) => Math.max(m, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)), Math.max(1e-6, radius));
    const closureTol = Math.max(1e-7, radius * 1e-5, scaleEstimate * 1e-6);
    const closureTolSq = closureTol * closureTol;

    if (!isClosed && vecPoints.length >= 2) {
      const rawDistSq = vecPoints[0].distanceToSquared(vecPoints[vecPoints.length - 1]);
      if (rawDistSq <= closureTolSq) isClosed = true;
    }

    let smoothed;
    try {
      smoothed = smoothPath(vecPoints, radius);
    } catch (error) {
      console.error('Error in smoothPath:', error);
      throw new Error(`Path smoothing failed: ${error.message}`);
    }

    if (smoothed.length < 2) {
      throw new Error(`Tube path collapsed after smoothing; check input. Original: ${vecPoints.length}, Smoothed: ${smoothed.length}`);
    }

    if (smoothed.length > 1) {
      const first = smoothed[0];
      const last = smoothed[smoothed.length - 1];
      const closureDistSq = first.distanceToSquared(last);
      if (!isClosed && closureDistSq <= closureTolSq) isClosed = true;
      if (isClosed && closureDistSq <= closureTolSq && smoothed.length > 2) {
        smoothed = smoothed.slice(0, -1);
      }
    }

    this.params.closed = isClosed;

    const { tangents, normals, binormals } = computeFrames(smoothed, isClosed);
    if (tangents.length < 2) throw new Error('Unable to compute frames for tube path.');

    // reset authoring buffers before building
    this._numProp = 3;
    this._vertProperties = [];
    this._triVerts = [];
    this._triIDs = [];
    this._vertKeyToIndex = new Map();
    this._idToFaceName = new Map();
    this._faceNameToID = new Map();
    this._faceMetadata = new Map();
    this._edgeMetadata = new Map();
    this._auxEdges = [];
    this._dirty = true;

    const { outer, inner: innerRings } = buildRings(smoothed, normals, binormals, radius, inner, segs);
    const faceTag = name || 'Tube';

    const ringCount = isClosed ? outer.length : outer.length - 1;
    for (let i = 0; i < ringCount; i++) {
      const ringA = outer[i];
      const ringB = outer[(i + 1) % outer.length];
      const nextIdx = (i + 1) % smoothed.length;
      const pathDir = smoothed[nextIdx].clone().sub(smoothed[i]).normalize();

      for (let j = 0; j < segs; j++) {
        const j1 = (j + 1) % segs;
        addQuadOriented(this, `${faceTag}_Outer`, ringA[j], ringA[j1], ringB[j1], ringB[j], pathDir);
      }
    }

    if (innerRings) {
      const innerRingCount = isClosed ? innerRings.length : innerRings.length - 1;
      for (let i = 0; i < innerRingCount; i++) {
        const ringA = innerRings[i];
        const ringB = innerRings[(i + 1) % innerRings.length];
        const nextIdx = (i + 1) % smoothed.length;
        const pathDir = smoothed[nextIdx].clone().sub(smoothed[i]).normalize();
        const inwardDir = pathDir.clone().negate();

        for (let j = 0; j < segs; j++) {
          const j1 = (j + 1) % segs;
          addQuadOriented(this, `${faceTag}_Inner`, ringA[j], ringB[j], ringB[j1], ringA[j1], inwardDir);
        }
      }
    }

    if (!isClosed) {
      const startCenter = [smoothed[0].x, smoothed[0].y, smoothed[0].z];
      const endCenter = [smoothed[smoothed.length - 1].x, smoothed[smoothed.length - 1].y, smoothed[smoothed.length - 1].z];
      const startDir = tangents[0].clone().negate();
      const endDir = tangents[tangents.length - 1].clone();

      if (innerRings) {
        addRingCap(this, `${faceTag}_CapStart`, outer[0], innerRings[0], startDir);
        addRingCap(this, `${faceTag}_CapEnd`, outer[outer.length - 1], innerRings[innerRings.length - 1], endDir);
      } else {
        addDiskCap(this, `${faceTag}_CapStart`, startCenter, outer[0], startDir);
        addDiskCap(this, `${faceTag}_CapEnd`, endCenter, outer[outer.length - 1], endDir);
      }
    }

    try {
      const auxPath = smoothed.map(p => [p.x, p.y, p.z]);
      if (isClosed && auxPath.length >= 2) {
        const first = auxPath[0];
        const last = auxPath[auxPath.length - 1];
        const dx = first[0] - last[0];
        const dy = first[1] - last[1];
        const dz = first[2] - last[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > 0) {
          auxPath.push([first[0], first[1], first[2]]);
        }
      }
      this.addAuxEdge(`${faceTag}_PATH`, auxPath, { polylineWorld: true, materialKey: 'OVERLAY', closedLoop: !!isClosed });
    } catch (_) { /* ignore auxiliary path errors */ }

    const preTriCount = (this._triVerts?.length || 0) / 3 | 0;
    let postTriCount = preTriCount;
    let unionSucceeded = false;
    const auxEdgesSnapshot = Array.isArray(this._auxEdges)
      ? this._auxEdges.map(e => ({
          name: e?.name,
          closedLoop: !!e?.closedLoop,
          polylineWorld: !!e?.polylineWorld,
          materialKey: e?.materialKey,
          points: Array.isArray(e?.points)
            ? e.points.map(p => (Array.isArray(p) ? [p[0], p[1], p[2]] : p))
            : [],
        }))
      : [];
    let inputManifold = null;
    try { inputManifold = this._manifoldize(); } catch { }
    try {
      const booleaned = this.union(this);
      postTriCount = (booleaned?._triVerts?.length || 0) / 3 | 0;
      copySolidState(this, booleaned, { auxEdges: auxEdgesSnapshot });
      if (inputManifold && inputManifold !== this._manifold) {
        try { if (typeof inputManifold.delete === 'function') inputManifold.delete(); } catch { }
      }
      unionSucceeded = true;
    } catch (error) {
      console.warn('Self-union failed; returning raw tube geometry.', error);
    }
    this._selfUnionStats = {
      preTriangles: preTriCount,
      postTriangles: postTriCount,
      selfIntersectionLikely: postTriCount > preTriCount,
      unionSucceeded,
    };
    this.name = name;
    return this;
  }

  generateSlow() {
    const { points, radius, innerRadius, resolution, closed, name, debugSpheres } = this.params;
    if (!(radius > 0)) {
      throw new Error('Tube radius must be greater than zero.');
    }
    const inner = Number(innerRadius) || 0;
    if (inner < 0) {
      throw new Error('Inside radius cannot be negative.');
    }
    if (inner > 0 && inner >= radius) {
      throw new Error('Inside radius must be smaller than the outer radius.');
    }

    const segs = Math.max(8, Math.floor(Number(resolution) || DEFAULT_SEGMENTS));
    const vecPoints = toVector3Array(points);
    const tolerance = Math.max(1e-7, radius * 1e-5);
    const { points: cleanPoints, closed: isClosed } = normalizePath(vecPoints, !!closed, tolerance);

    if (cleanPoints.length < 2) {
      throw new Error(`Tube requires at least two distinct path points. Got ${cleanPoints.length} valid points from ${points.length} input points.`);
    }
    if (isClosed && cleanPoints.length < 3) {
      throw new Error('Closed tubes require at least three unique points.');
    }

    if (typeof this.free === 'function') {
      this.free();
    }

    const faceTag = name || 'Tube';
    const keepSpheres = !!debugSpheres;
    const startNormal = isClosed ? null : firstTangent(cleanPoints);
    const endNormal = isClosed ? null : lastTangent(cleanPoints);
    const endCutNormal = endNormal ? endNormal.clone().negate() : null; // point back into tube
    const trimPlanes = isClosed
      ? null
      : {
          start: trimPlaneFromPoints(cleanPoints[0], cleanPoints[1]),
          end: trimPlaneFromPoints(cleanPoints[cleanPoints.length - 1], cleanPoints[cleanPoints.length - 2]),
        };

    const { manifold: outerManifold, spheres: outerSpheres } = buildHullTube(cleanPoints, radius, segs, isClosed, keepSpheres, trimPlanes);
    let finalSolid;

    if (inner > 0) {
      const { manifold: innerManifold, spheres: innerSpheres } = buildHullTube(cleanPoints, inner, segs, isClosed, keepSpheres, trimPlanes);

      const outerSolid = Solid._fromManifold(outerManifold, new Map([[0, `${faceTag}_Outer`]]));
      const innerSolid = Solid._fromManifold(innerManifold, new Map([[0, `${faceTag}_Inner`]]));
      finalSolid = outerSolid.subtract(innerSolid);
      try { outerSolid.free(); } catch { }
      try { innerSolid.free(); } catch { }
      try { if (innerManifold && typeof innerManifold.delete === 'function') innerManifold.delete(); } catch { }
      if (keepSpheres) {
        this.debugSphereSolids = [
          ...(this.debugSphereSolids || []),
          ...outerSpheres.map((m, idx) => singleFaceSolidFromManifold(m, `${faceTag}_sphere_outer_${idx + 1}`)),
          ...innerSpheres.map((m, idx) => singleFaceSolidFromManifold(m, `${faceTag}_sphere_inner_${idx + 1}`)),
        ];
      }
    } else {
      finalSolid = Solid._fromManifold(outerManifold, new Map([[0, `${faceTag}_Outer`]]));
      if (keepSpheres) {
        this.debugSphereSolids = outerSpheres.map((m, idx) => singleFaceSolidFromManifold(m, `${faceTag}_sphere_${idx + 1}`));
      }
    }

    let relabeled = relabelFaces(finalSolid, cleanPoints, startNormal, endCutNormal, radius, inner, isClosed, faceTag);
    // Ensure we have a manifold to copy from; if rebuild failed, fall back
    const manifoldForCopy = relabeled?._manifold || finalSolid._manifold;
    const faceMapForCopy = relabeled?._idToFaceName || finalSolid._idToFaceName;
    rebuildSolidFromManifold(this, manifoldForCopy, faceMapForCopy);
    this.name = name;
    this.params.closed = isClosed;

    try {
      const auxPath = cleanPoints.map(p => [p.x, p.y, p.z]);
      this.addAuxEdge(`${faceTag}_PATH`, auxPath, { polylineWorld: true, materialKey: 'OVERLAY', closedLoop: !!isClosed });
    } catch (_) {
      // ignore auxiliary path errors
    }
    this._selfUnionStats = null;
    return this;
  }
}
