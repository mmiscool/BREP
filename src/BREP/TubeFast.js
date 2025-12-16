import { Solid } from './BetterSolid.js';
import * as THREE from 'three';

const EPS = 1e-9;
const EPS_SQ = EPS * EPS;
const DEFAULT_SEGMENTS = 32;
const DEBUG_LOGS = false;

const tmpVecA = new THREE.Vector3();
const tmpVecB = new THREE.Vector3();
const tmpVecC = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();

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

  // For simple paths (2 points), no trimming needed
  if (points.length === 2) {
    return points.map(p => p.clone());
  }

  const out = [];
  out.push(points[0].clone());

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    // Check for valid points
    if (!prev || !curr || !next) {
      out.push(curr.clone());
      continue;
    }

    const vPrev = curr.clone().sub(prev);
    const vNext = next.clone().sub(curr);

    // Check for degenerate segments
    if (vPrev.lengthSq() < EPS_SQ || vNext.lengthSq() < EPS_SQ) {
      out.push(curr.clone());
      continue;
    }

    vPrev.normalize();
    vNext.normalize();

    const dot = THREE.MathUtils.clamp(vPrev.dot(vNext), -1, 1);

    // Calculate the angle between the segments
    const angle = Math.acos(Math.abs(dot));

    // Only trim for very sharp corners to be less aggressive
    if (angle > Math.PI / 3) { // Only angles sharper than 60 degrees
      const halfAngle = angle * 0.5;

      // Calculate the distance from corner where tubes would intersect
      const intersectionDist = tubeRadius / Math.tan(halfAngle);

      // Calculate trimmed points that prevent intersection
      const distPrev = prev.distanceTo(curr);
      const distNext = curr.distanceTo(next);

      // Be more conservative with trimming
      const trimDistPrev = Math.min(intersectionDist * 0.8, distPrev * 0.6);
      const trimDistNext = Math.min(intersectionDist * 0.8, distNext * 0.6);

      // Only trim if we have enough distance
      if (trimDistPrev > tubeRadius * 0.1 && trimDistNext > tubeRadius * 0.1) {
        const trimmedPrev = curr.clone().addScaledVector(vPrev, -trimDistPrev);
        const trimmedNext = curr.clone().addScaledVector(vNext, trimDistNext);

        // Add the trimmed points
        if (out[out.length - 1].distanceTo(trimmedPrev) > 1e-6) {
          out.push(trimmedPrev);
        }

        out.push(trimmedNext);
      } else {
        // Not enough room to trim safely, just add the corner
        out.push(curr.clone());
      }
    } else {
      // For gentler corners, no trimming needed
      out.push(curr.clone());
    }
  }

  out.push(points[points.length - 1].clone());
  return dedupeVectors(out, 1e-6);
}

function smoothPath(points, tubeRadius) {
  // Just apply intersection trimming and return - no corner "smoothing" for now
  try {
    const trimmedPoints = calculateTubeIntersectionTrimming(points, tubeRadius);
    if (DEBUG_LOGS) console.log(`smoothPath: Original ${points.length} -> Trimmed ${trimmedPoints.length}`);

    if (!Array.isArray(trimmedPoints) || trimmedPoints.length < 2) {
      console.warn('smoothPath: Insufficient points after trimming');
      return Array.isArray(points) ? points.map(p => p.clone()) : [];
    }

    return dedupeVectors(trimmedPoints, 1e-9);
  } catch (error) {
    console.error('Error in smoothPath:', error);
    // Fallback: return original points
    return points.map(p => p.clone());
  }
}

function computeFrames(points, closed = false) {
  const tangents = [];
  const normals = [];
  const binormals = [];
  if (!Array.isArray(points) || points.length < 2) return { tangents, normals, binormals };

  const vec = new THREE.Vector3();
  const normalSeed = new THREE.Vector3();

  // Compute tangents with better smoothing
  for (let i = 0; i < points.length; i++) {
    const tangent = new THREE.Vector3();

    if (closed) {
      // For closed loops, always use central difference with wraparound
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
      // Original open path logic
      if (i === 0) {
        // Forward difference for first point
        tangent.subVectors(points[1], points[0]);
      } else if (i === points.length - 1) {
        // Backward difference for last point
        tangent.subVectors(points[i], points[i - 1]);
      } else {
        // Central difference for intermediate points
        const forward = new THREE.Vector3().subVectors(points[i + 1], points[i]);
        const backward = new THREE.Vector3().subVectors(points[i], points[i - 1]);

        // Weighted average based on segment lengths for better smoothing
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
          // Fallback to previous tangent
          if (tangents.length > 0) {
            tangent.copy(tangents[tangents.length - 1]);
          } else {
            tangent.set(0, 0, 1);
          }
        }
      }
    }

    if (tangent.lengthSq() < EPS_SQ) {
      if (tangents.length > 0) {
        tangent.copy(tangents[tangents.length - 1]);
      } else {
        tangent.set(0, 0, 1);
      }
    } else {
      tangent.normalize();
    }

    tangents.push(tangent);
  }

  // Compute initial normal using most stable axis
  const firstTan = tangents[0];
  let min = Infinity;
  const ax = Math.abs(firstTan.x);
  const ay = Math.abs(firstTan.y);
  const az = Math.abs(firstTan.z);

  if (ax <= min) { min = ax; normalSeed.set(1, 0, 0); }
  if (ay <= min) { min = ay; normalSeed.set(0, 1, 0); }
  if (az <= min) { normalSeed.set(0, 0, 1); }

  // Create initial orthonormal frame
  vec.crossVectors(firstTan, normalSeed);
  if (vec.lengthSq() < EPS_SQ) {
    // Try different seed if cross product is zero
    normalSeed.set(0, 1, 0);
    vec.crossVectors(firstTan, normalSeed);
    if (vec.lengthSq() < EPS_SQ) {
      normalSeed.set(1, 0, 0);
      vec.crossVectors(firstTan, normalSeed);
    }
  }
  vec.normalize();

  const firstBinormal = vec.clone();
  const firstNormal = new THREE.Vector3().crossVectors(firstBinormal, firstTan).normalize();

  normals[0] = firstNormal;
  binormals[0] = firstBinormal;

  // Propagate frames using parallel transport to minimize twisting
  for (let i = 1; i < points.length; i++) {
    const prevTan = tangents[i - 1];
    const currTan = tangents[i];
    const prevNormal = normals[i - 1];

    // Use parallel transport (rotation minimizing frame)
    const rotAxis = new THREE.Vector3().crossVectors(prevTan, currTan);

    if (rotAxis.lengthSq() > EPS_SQ) {
      rotAxis.normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(prevTan.dot(currTan), -1, 1));

      // Rotate the normal by the same rotation that takes prevTan to currTan
      const rotation = new THREE.Matrix4().makeRotationAxis(rotAxis, angle);
      const newNormal = prevNormal.clone().applyMatrix4(rotation);

      // Ensure orthogonality (Gram-Schmidt)
      const projection = currTan.clone().multiplyScalar(newNormal.dot(currTan));
      newNormal.sub(projection).normalize();

      normals[i] = newNormal;
    } else {
      // Tangents are parallel, just copy the normal
      normals[i] = prevNormal.clone();
    }

    // Compute binormal
    binormals[i] = new THREE.Vector3().crossVectors(currTan, normals[i]).normalize();
  }

  // For closed loops, adjust frames to minimize twist around the entire loop
  if (closed && points.length > 2) {
    // Check if the final frame is reasonably aligned with the initial frame
    const firstNormal = normals[0];
    const lastNormal = normals[normals.length - 1];
    const firstTangent = tangents[0];
    const lastTangent = tangents[tangents.length - 1];

    // Calculate the rotation needed to align last frame with first frame
    const rotAxis = new THREE.Vector3().crossVectors(lastTangent, firstTangent);

    if (rotAxis.lengthSq() > EPS_SQ) {
      rotAxis.normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(lastTangent.dot(firstTangent), -1, 1));
      const rotation = new THREE.Matrix4().makeRotationAxis(rotAxis, angle);
      const alignedLastNormal = lastNormal.clone().applyMatrix4(rotation);

      // Ensure orthogonality
      const projection = firstTangent.clone().multiplyScalar(alignedLastNormal.dot(firstTangent));
      alignedLastNormal.sub(projection).normalize();

      // Calculate the twist needed to align normals
      const normalDot = firstNormal.dot(alignedLastNormal);
      const twistAngle = Math.acos(THREE.MathUtils.clamp(normalDot, -1, 1));

      // Check if we need to apply the twist in the opposite direction
      const crossProduct = new THREE.Vector3().crossVectors(firstNormal, alignedLastNormal);
      if (crossProduct.dot(firstTangent) < 0) {
        // Apply the twist distributed over the entire path to minimize discontinuity
        const twistPerSegment = -twistAngle / (points.length - 1);

        for (let i = 1; i < points.length; i++) {
          const segmentTwist = twistPerSegment * i;
          const twistRotation = new THREE.Matrix4().makeRotationAxis(tangents[i], segmentTwist);
          normals[i].applyMatrix4(twistRotation);
          binormals[i] = new THREE.Vector3().crossVectors(tangents[i], normals[i]).normalize();
        }
      }
    }
  }

  return { tangents, normals, binormals };
}

function buildRings(points, normals, binormals, radius, innerRadius, segments) {
  const outer = [];
  const inner = innerRadius > 0 ? [] : null;
  if (!Array.isArray(points)) return { outer, inner };
  const step = (Math.PI * 2) / segments;
  const dir = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const center = points[i];
    const n = normals[i];
    const b = binormals[i];
    const ringOuter = new Array(segments);
    const ringInner = inner ? new Array(segments) : null;
    for (let j = 0; j < segments; j++) {
      const angle = j * step;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      dir.set(
        n.x * ca + b.x * sa,
        n.y * ca + b.y * sa,
        n.z * ca + b.z * sa
      ).normalize();
      ringOuter[j] = [center.x + dir.x * radius, center.y + dir.y * radius, center.z + dir.z * radius];
      if (ringInner) {
        ringInner[j] = [center.x + dir.x * innerRadius, center.y + dir.y * innerRadius, center.z + dir.z * innerRadius];
      }
    }
    outer.push(ringOuter);
    if (ringInner) inner.push(ringInner);
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

// Copy manifold-backed geometry and metadata from `source` onto `target`
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

export class TubeFast extends Solid {
  /**
   * Build a tube solid along a polyline.
   * @param {object} [opts]
   * @param {Array<[number,number,number]>} [opts.points=[]] Path points for the tube centerline
   * @param {number} [opts.radius=1] Outer radius
   * @param {number} [opts.innerRadius=0] Optional inner radius (0 for solid tube)
   * @param {number} [opts.resolution=32] Segment count around the tube
   * @param {boolean} [opts.closed=false] Whether the path is closed (auto-detected if endpoints match)
   * @param {string} [opts.name='Tube'] Name for the solid
   */
  constructor(opts = {}) {
    super();
    const { points = [], radius = 1, innerRadius = 0, resolution = DEFAULT_SEGMENTS, closed = false, name = 'Tube' } = opts;
    this.params = { points, radius, innerRadius, resolution, closed, name };
    this.name = name;


    // if the start point equals the end point, set closed to true
    if (Array.isArray(points) && points.length >= 2) {
      const firstPoint = points[0];
      const lastPoint = points[points.length - 1];
      if (firstPoint[0] === lastPoint[0] && firstPoint[1] === lastPoint[1] && firstPoint[2] === lastPoint[2]) {
        this.params.closed = true;
      }
    }


    // Only auto-generate when we have a valid param set.
    // When created via boolean ops (_fromManifold), the constructor is
    // invoked with no arguments and geometry will be populated from the
    // Manifold mesh immediately after construction. Avoid calling
    // generate() in that case to prevent errors.
    try {
      const hasPath = Array.isArray(points) && points.length >= 2;
      const validRadius = Number(radius) > 0;
      if (hasPath && validRadius) {
        this.generate().visualize();
        this.visualize();
      }
    } catch {
      // Fail-quietly to keep boolean reconstruction safe
    }
  }

  generate() {

    let { points, radius, innerRadius, resolution, closed, name } = this.params;
    let isClosed = !!closed;
    //console.log(points, radius, innerRadius, resolution, closed, name);
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

    const vecPoints = dedupeVectors(toVector3Array(points));
    if (DEBUG_LOGS) console.log(`Tube generation: Input points: ${points.length}, Valid points: ${vecPoints.length}`);

    if (vecPoints.length < 2) {
      throw new Error(`Tube requires at least two distinct path points. Got ${vecPoints.length} valid points from ${points.length} input points.`);
    }

    // Use a scale-adaptive tolerance for closed-loop detection and endpoint snapping
    const scaleEstimate = vecPoints.reduce((m, p) => Math.max(m, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)), Math.max(1e-6, radius));
    const closureTol = Math.max(1e-7, radius * 1e-5, scaleEstimate * 1e-6);
    const closureTolSq = closureTol * closureTol;

    if (!isClosed && vecPoints.length >= 2) {
      const rawDistSq = vecPoints[0].distanceToSquared(vecPoints[vecPoints.length - 1]);
      if (rawDistSq <= closureTolSq) isClosed = true;
    }

    // Apply path smoothing with proper intersection handling
    let smoothed;
    try {
      smoothed = smoothPath(vecPoints, radius);
      if (DEBUG_LOGS) console.log(`Tube generation: Smoothed points: ${smoothed.length}`);
    } catch (error) {
      console.error('Error in smoothPath:', error);
      throw new Error(`Path smoothing failed: ${error.message}`);
    }

    if (smoothed.length < 2) {
      throw new Error(`Tube path collapsed after smoothing; check input. Original: ${vecPoints.length}, Smoothed: ${smoothed.length}`);
    }

    // For closed loops, ensure we don't have duplicate points at the closure after smoothing
    if (smoothed.length > 1) {
      const first = smoothed[0];
      const last = smoothed[smoothed.length - 1];
      const closureDistSq = first.distanceToSquared(last);
      if (!isClosed && closureDistSq <= closureTolSq) isClosed = true;

      // Remove an explicit duplicate endpoint to avoid zero-length segments,
      // but only when the loop is actually closed within tolerance.
      if (isClosed && closureDistSq <= closureTolSq && smoothed.length > 2) {
        smoothed = smoothed.slice(0, -1);
        if (DEBUG_LOGS) console.log(`Tube generation: Removed duplicate closure point, now ${smoothed.length} points`);
      }
    }

    this.params.closed = isClosed;

    const { tangents, normals, binormals } = computeFrames(smoothed, isClosed);
    if (tangents.length < 2) {
      throw new Error('Unable to compute frames for tube path.');
    }

    const { outer, inner: innerRings } = buildRings(smoothed, normals, binormals, radius, inner, segs);
    const faceTag = name || 'Tube';

    // Generate outer surface with consistent winding
    const ringCount = isClosed ? outer.length : outer.length - 1;
    for (let i = 0; i < ringCount; i++) {
      const ringA = outer[i];
      const ringB = outer[(i + 1) % outer.length]; // For closed loops, wrap around to first ring
      const nextIdx = (i + 1) % smoothed.length;
      const pathDir = smoothed[nextIdx].clone().sub(smoothed[i]).normalize();

      for (let j = 0; j < segs; j++) {
        const j1 = (j + 1) % segs;

        // Ensure outward-facing normal for outer surface
        // Order: A[j] -> A[j1] -> B[j1] -> B[j] forms outward quads
        addQuadOriented(this, `${faceTag}_Outer`,
          ringA[j], ringA[j1], ringB[j1], ringB[j], pathDir);
      }
    }

    // Generate inner surface with consistent winding (inward-facing)
    if (innerRings) {
      const innerRingCount = isClosed ? innerRings.length : innerRings.length - 1;
      for (let i = 0; i < innerRingCount; i++) {
        const ringA = innerRings[i];
        const ringB = innerRings[(i + 1) % innerRings.length]; // For closed loops, wrap around to first ring
        const nextIdx = (i + 1) % smoothed.length;
        const pathDir = smoothed[nextIdx].clone().sub(smoothed[i]).normalize();
        const inwardDir = pathDir.clone().negate(); // Inward for hollow interior

        for (let j = 0; j < segs; j++) {
          const j1 = (j + 1) % segs;

          // Reverse winding for inward-facing inner surface
          addQuadOriented(this, `${faceTag}_Inner`,
            ringA[j], ringB[j], ringB[j1], ringA[j1], inwardDir);
        }
      }
    }

    // Only add caps for open tubes (not closed loops)
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
        // Explicitly close the helper polyline so endpoints coincide visually and in metadata
        if (distSq > 0) {
          auxPath.push([first[0], first[1], first[2]]);
        }
      }
      this.addAuxEdge(`${faceTag}_PATH`, auxPath, { polylineWorld: true, materialKey: 'OVERLAY', closedLoop: !!isClosed });
    } catch (_) {
      // ignore auxiliary path errors
    }

    // Boolean the tube with itself to let Manifold split any self-intersections,
    // then copy the result back onto this instance so callers retain params/metadata.
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
    try { inputManifold = this._manifoldize(); } catch { /* best-effort manifold build before boolean */ }
    try {
      const booleaned = this.union(this);
      copySolidState(this, booleaned, { auxEdges: auxEdgesSnapshot });
      if (inputManifold && inputManifold !== this._manifold) {
        try { if (typeof inputManifold.delete === 'function') inputManifold.delete(); } catch { }
      }
    } catch (error) {
      console.warn('Self-union failed; returning raw tube geometry.', error);
    }


    return this;
  }
}
