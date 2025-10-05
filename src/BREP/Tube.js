import { Solid } from './BetterSolid.js';
import * as THREE from 'three';

const EPS = 1e-9;
const EPS_SQ = EPS * EPS;
const DEFAULT_SEGMENTS = 32;
const CORNER_STEP_RAD = Math.PI / 12; // ~15° per step
const MIN_CORNER_ANGLE_RAD = Math.PI / 180 * 5; // ignore bends under ~5° to keep curves smooth

const tmpVecA = new THREE.Vector3();
const tmpVecB = new THREE.Vector3();
const tmpVecC = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();

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

function smoothPath(points, cornerRadius, tubeRadius) {
  // Just apply intersection trimming and return - no corner "smoothing" for now
  try {
    const trimmedPoints = calculateTubeIntersectionTrimming(points, tubeRadius);
    console.log(`smoothPath: Original ${points.length} -> Trimmed ${trimmedPoints.length}`);
    
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

function computeFrames(points) {
  const tangents = [];
  const normals = [];
  const binormals = [];
  if (!Array.isArray(points) || points.length < 2) return { tangents, normals, binormals };

  const vec = new THREE.Vector3();
  const normalSeed = new THREE.Vector3();

  // Compute tangents with better smoothing
  for (let i = 0; i < points.length; i++) {
    const tangent = new THREE.Vector3();
    
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

function addQuad(solid, name, a, b, c, d) {
  solid.addTriangle(name, a, b, c);
  solid.addTriangle(name, a, c, d);
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

export class TubeSolid extends Solid {
  constructor({ points = [], radius = 1, innerRadius = 0, resolution = DEFAULT_SEGMENTS, name = 'Tube' } = {}) {
    super();
    this.params = { points, radius, innerRadius, resolution, name };
    this.name = name;
    this.generate();
  }

  generate() {
    const { points, radius, innerRadius, resolution, name } = this.params;
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
    console.log(`Tube generation: Input points: ${points.length}, Valid points: ${vecPoints.length}`);
    
    if (vecPoints.length < 2) {
      throw new Error(`Tube requires at least two distinct path points. Got ${vecPoints.length} valid points from ${points.length} input points.`);
    }

    // Apply path smoothing with proper intersection handling
    let smoothed;
    try {
      smoothed = smoothPath(vecPoints, radius, radius);
      console.log(`Tube generation: Smoothed points: ${smoothed.length}`);
    } catch (error) {
      console.error('Error in smoothPath:', error);
      throw new Error(`Path smoothing failed: ${error.message}`);
    }
    
    if (smoothed.length < 2) {
      throw new Error(`Tube path collapsed after smoothing; check input. Original: ${vecPoints.length}, Smoothed: ${smoothed.length}`);
    }

    const { tangents, normals, binormals } = computeFrames(smoothed);
    if (tangents.length < 2) {
      throw new Error('Unable to compute frames for tube path.');
    }

    const { outer, inner: innerRings } = buildRings(smoothed, normals, binormals, radius, inner, segs);
    const faceTag = name || 'Tube';

    // Generate outer surface with consistent winding
    for (let i = 0; i < outer.length - 1; i++) {
      const ringA = outer[i];
      const ringB = outer[i + 1];
      const pathDir = smoothed[i + 1].clone().sub(smoothed[i]).normalize();
      
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
      for (let i = 0; i < innerRings.length - 1; i++) {
        const ringA = innerRings[i];
        const ringB = innerRings[i + 1];
        const pathDir = smoothed[i + 1].clone().sub(smoothed[i]).normalize();
        const inwardDir = pathDir.clone().negate(); // Inward for hollow interior
        
        for (let j = 0; j < segs; j++) {
          const j1 = (j + 1) % segs;
          
          // Reverse winding for inward-facing inner surface
          addQuadOriented(this, `${faceTag}_Inner`,
            ringA[j], ringB[j], ringB[j1], ringA[j1], inwardDir);
        }
      }
    }

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

    try {
      const auxPath = smoothed.map(p => [p.x, p.y, p.z]);
      this.addAuxEdge(`${faceTag}_PATH`, auxPath, { polylineWorld: true, materialKey: 'OVERLAY' });
    } catch (_) {
      // ignore auxiliary path errors
    }
  }
}
