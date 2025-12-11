import { Solid } from './BetterSolid.js';
import { Manifold, THREE } from './SolidShared.js';

const DEFAULT_SEGMENTS = 32;
const EPS = 1e-9;

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

function buildHullChain(points, radius, resolution, closed, customSpheres = null) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const baseSphere = Manifold.sphere(radius, resolution);
  const spheres = customSpheres && Array.isArray(customSpheres) && customSpheres.length === points.length
    ? customSpheres
    : points.map(pt => baseSphere.translate([pt.x, pt.y, pt.z]));
  try { if (!customSpheres && typeof baseSphere.delete === 'function') baseSphere.delete(); } catch { }

  const hulls = [];
  const segmentCount = closed ? points.length : points.length - 1;
  for (let i = 0; i < segmentCount; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    if (a.distanceToSquared(b) < EPS * EPS) continue;
    hulls.push(Manifold.hull([spheres[i], spheres[(i + 1) % spheres.length]]));
  }

  if (!customSpheres) {
    for (const s of spheres) { try { if (s && typeof s.delete === 'function') s.delete(); } catch { } }
  }

  if (!hulls.length) return null;
  if (hulls.length === 1) return hulls[0];

  let combined = null;
  try {
    combined = Manifold.union(hulls);
    return combined;
  } finally {
    for (const h of hulls) {
      if (h && h !== combined) {
        try { if (typeof h.delete === 'function') h.delete(); } catch { }
      }
    }
  }
}

function trimOpenEnds(manifold, points, closed) {
  if (closed || !manifold || points.length < 2) return manifold;

  let trimmed = manifold;
  const maybeTrim = (normalVec, anchorPoint) => {
    if (!normalVec || normalVec.lengthSq() <= EPS || !anchorPoint) return;
    normalVec.normalize();
    const offset = normalVec.dot(anchorPoint);
    const next = trimmed.trimByPlane([normalVec.x, normalVec.y, normalVec.z], offset);
    if (next && next !== trimmed) {
      try { if (trimmed !== manifold && typeof trimmed.delete === 'function') trimmed.delete(); } catch { }
      trimmed = next;
    } else {
      trimmed = next;
    }
  };

  const startDir = new THREE.Vector3().subVectors(points[1], points[0]);
  maybeTrim(startDir, points[0]);

  const endDir = new THREE.Vector3().subVectors(points[points.length - 1], points[points.length - 2]);
  if (endDir.lengthSq() > EPS) endDir.normalize().negate(); // point back into the tube
  maybeTrim(endDir, points[points.length - 1]);

  return trimmed;
}

function buildHullTube(points, radius, resolution, closed) {
  const hull = buildHullChain(points, radius, resolution, closed);
  if (!hull) throw new Error('Unable to build tube hulls from the supplied path.');
  const trimmed = trimOpenEnds(hull, points, closed);
  if (trimmed !== hull) {
    try { if (hull && typeof hull.delete === 'function') hull.delete(); } catch { }
  }
  return trimmed;
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
    if (!closed && nStart && Math.abs(nStart.dot(centroid) - startOffset) <= capTol) {
      assigned = idCapStart;
    } else if (!closed && nEnd && Math.abs(nEnd.dot(centroid) - endOffset) <= capTol) {
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

export class TubeSolid extends Solid {
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
    const { points = [], radius = 1, innerRadius = 0, resolution = DEFAULT_SEGMENTS, closed = false, name = 'Tube' } = opts;
    this.params = { points, radius, innerRadius, resolution, closed, name };
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

  generate() {
    const { points, radius, innerRadius, resolution, closed, name } = this.params;
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
    // Endpoint normals for relabeling and trimming
    const startNormal = isClosed ? null : firstTangent(cleanPoints);
    const endNormal = isClosed ? null : lastTangent(cleanPoints);
    const endCutNormal = endNormal ? endNormal.clone().negate() : null; // point back into tube

    const outerHull = buildHullChain(cleanPoints, radius, segs, isClosed);
    if (!outerHull) {
      throw new Error('Unable to build tube hulls from the supplied path.');
    }
    const outerManifold = trimOpenEnds(outerHull, cleanPoints, isClosed);
    if (outerManifold !== outerHull) {
      try { if (outerHull && typeof outerHull.delete === 'function') outerHull.delete(); } catch { }
    }
    let finalSolid;

    if (inner > 0) {
      const innerHull = buildHullChain(cleanPoints, inner, segs, isClosed);
      if (!innerHull) {
        throw new Error('Unable to build tube hulls for inner radius.');
      }
      const innerManifold = trimOpenEnds(innerHull, cleanPoints, isClosed);
      if (innerManifold !== innerHull) {
        try { if (innerHull && typeof innerHull.delete === 'function') innerHull.delete(); } catch { }
      }

      const outerSolid = Solid._fromManifold(outerManifold, new Map([[0, `${faceTag}_Outer`]]));
      const innerSolid = Solid._fromManifold(innerManifold, new Map([[0, `${faceTag}_Inner`]]));
      finalSolid = outerSolid.subtract(innerSolid);
      try { outerSolid.free(); } catch { }
      try { innerSolid.free(); } catch { }
      try { if (innerManifold && typeof innerManifold.delete === 'function') innerManifold.delete(); } catch { }
    } else {
      finalSolid = Solid._fromManifold(outerManifold, new Map([[0, `${faceTag}_Outer`]]));
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
  }
}
