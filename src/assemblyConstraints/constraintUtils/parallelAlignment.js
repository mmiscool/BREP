import * as THREE from 'three';
import { objectRepresentativePoint, getElementDirection } from '../../UI/pmi/annUtils.js';

export const ANGLE_TOLERANCE = THREE.MathUtils.degToRad(0.001);
export const MAX_ROTATION_PER_ITERATION = THREE.MathUtils.degToRad(10);
const MAX_EDGE_SAMPLE_POINTS = 256;
const DEFAULT_PARALLEL_ALIGNMENT_TOLERANCE = 1e-12;

function getWorldNormal(object) {
  if (!object) return null;
  object.updateMatrixWorld?.(true);

  if (typeof object.getAverageNormal === 'function') {
    try {
      const avg = object.getAverageNormal();
      if (avg && avg.lengthSq() > 1e-10) {
        return avg.clone().normalize();
      }
    } catch {}
  }

  return computeNormalFromObject(object);
}

function resolveOrigin(object, component) {
  let origin = null;
  if (object) {
    try {
      origin = objectRepresentativePoint(null, object);
    } catch {}
  }
  if (!origin && component) {
    try {
      origin = objectRepresentativePoint(null, component);
    } catch {}
    if (!origin && typeof component.getWorldPosition === 'function') {
      origin = component.getWorldPosition(new THREE.Vector3());
    }
  }
  return origin || null;
}

function computeNormalFromObject(object, depth = 0) {
  if (!object || depth > 3) return null;

  const geometry = object.geometry;
  if (geometry && geometry.isBufferGeometry) {
    const normal = computeNormalFromGeometry(object, geometry);
    if (normal) return normal;
  }

  if (Array.isArray(object.children)) {
    for (const child of object.children) {
      const normal = computeNormalFromObject(child, depth + 1);
      if (normal && normal.lengthSq() > 0) return normal;
    }
  }
  return null;
}

function computeNormalFromGeometry(object, geometry) {
  if (!geometry?.isBufferGeometry) return null;
  const positionAttr = geometry.getAttribute?.('position');
  if (!positionAttr || positionAttr.itemSize !== 3 || positionAttr.count < 3) return null;

  const indexAttr = geometry.getIndex?.();
  const triangleCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(positionAttr.count / 3);
  if (triangleCount <= 0) return null;

  object.updateMatrixWorld?.(true);

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const accum = new THREE.Vector3();

  const sampleCount = Math.min(triangleCount, 60);
  let count = 0;
  for (let tri = 0; tri < sampleCount; tri += 1) {
    let i0;
    let i1;
    let i2;
    if (indexAttr) {
      const base = tri * 3;
      if (base + 2 >= indexAttr.count) break;
      i0 = indexAttr.getX(base);
      i1 = indexAttr.getX(base + 1);
      i2 = indexAttr.getX(base + 2);
    } else {
      i0 = tri * 3;
      i1 = i0 + 1;
      i2 = i0 + 2;
      if (i2 >= positionAttr.count) break;
    }

    v0.set(positionAttr.getX(i0), positionAttr.getY(i0), positionAttr.getZ(i0)).applyMatrix4(object.matrixWorld);
    v1.set(positionAttr.getX(i1), positionAttr.getY(i1), positionAttr.getZ(i1)).applyMatrix4(object.matrixWorld);
    v2.set(positionAttr.getX(i2), positionAttr.getY(i2), positionAttr.getZ(i2)).applyMatrix4(object.matrixWorld);

    edge1.subVectors(v1, v0);
    edge2.subVectors(v2, v0);
    normal.crossVectors(edge1, edge2);
    if (normal.lengthSq() > 1e-10) {
      accum.add(normal);
      count += 1;
    }
  }

  if (count === 0) return null;

  accum.divideScalar(count);
  if (accum.lengthSq() <= 1e-10) return null;
  return accum.normalize();
}

function normalizeOrNull(vec) {
  if (!vec) return null;
  const clone = vec instanceof THREE.Vector3
    ? vec.clone()
    : new THREE.Vector3(vec.x ?? 0, vec.y ?? 0, vec.z ?? 0);
  if (clone.lengthSq() <= 1e-12) return null;
  return clone.normalize();
}

function readAttributeVector(attr, index) {
  if (!attr || typeof attr.getX !== 'function') return null;
  if (index < 0 || index >= attr.count) return null;
  return new THREE.Vector3(attr.getX(index), attr.getY(index), attr.getZ(index));
}

function elementDirectionFrom(target) {
  if (!target) return null;
  try {
    const dir = getElementDirection(null, target);
    if (dir && dir.lengthSq() > 1e-12) {
      return dir.clone ? dir.clone() : new THREE.Vector3(dir.x, dir.y, dir.z);
    }
  } catch {}
  return null;
}

function collectEdgeSamplePoints(target, maxSamples = MAX_EDGE_SAMPLE_POINTS) {
  if (!target) return null;

  const polyline = target.userData?.polylineLocal;
  const closedLoop = !!target.userData?.closedLoop;
  const points = [];

  target.updateMatrixWorld?.(true);
  const matrixWorld = target.matrixWorld;

  const pushPoint = (x, y, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const p = new THREE.Vector3(x, y, z);
    p.applyMatrix4(matrixWorld);
    points.push(p);
  };

  if (Array.isArray(polyline) && polyline.length >= 2) {
    for (const entry of polyline) {
      if (!entry) continue;
      if (Array.isArray(entry) && entry.length >= 3) {
        pushPoint(entry[0], entry[1], entry[2]);
        continue;
      }
      if (typeof entry === 'object') {
        pushPoint(entry.x ?? entry[0] ?? 0, entry.y ?? entry[1] ?? 0, entry.z ?? entry[2] ?? 0);
      }
    }
    return points.length >= 2 ? { points, closedLoop } : null;
  }

  const geom = target.geometry;
  if (!geom) return null;

  const sampleAttribute = (attrCount, getter) => {
    if (attrCount <= 0) return;
    const total = attrCount;
    const sampleCount = Math.min(Math.max(total, 1), Math.max(2, Math.min(total, maxSamples)));
    const denom = sampleCount > 1 ? (sampleCount - 1) : 1;
    let lastIndex = -1;
    for (let i = 0; i < sampleCount; i += 1) {
      const t = denom === 0 ? 0 : i / denom;
      const idx = Math.min(total - 1, Math.round(t * (total - 1)));
      if (idx === lastIndex) continue;
      lastIndex = idx;
      const vec = getter(idx);
      if (vec) pushPoint(vec.x, vec.y, vec.z);
    }
    if (lastIndex !== total - 1) {
      const tail = getter(total - 1);
      if (tail) pushPoint(tail.x, tail.y, tail.z);
    }
  };

  const posAttr = geom.getAttribute?.('position');
  if (posAttr && posAttr.itemSize === 3 && posAttr.count >= 1) {
    sampleAttribute(posAttr.count, (idx) => readAttributeVector(posAttr, idx));
    return points.length >= 2 ? { points, closedLoop } : null;
  }

  const arr = geom.attributes?.position?.array;
  if (arr && (Array.isArray(arr) || ArrayBuffer.isView(arr))) {
    const total = Math.floor(arr.length / 3);
    if (total <= 0) return null;
    sampleAttribute(total, (idx) => {
      const base = idx * 3;
      return new THREE.Vector3(arr[base], arr[base + 1], arr[base + 2]);
    });
    return points.length >= 2 ? { points, closedLoop } : null;
  }

  return null;
}

function principalAxisFromPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const centroid = new THREE.Vector3();
  for (const p of points) centroid.add(p);
  centroid.multiplyScalar(1 / points.length);

  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  for (const p of points) {
    const dx = p.x - centroid.x;
    const dy = p.y - centroid.y;
    const dz = p.z - centroid.z;
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }

  const vec = new THREE.Vector3(1, 0, 0);
  if (yy > xx && yy >= zz) vec.set(0, 1, 0);
  else if (zz > xx && zz > yy) vec.set(0, 0, 1);

  for (let i = 0; i < 10; i += 1) {
    const x = xx * vec.x + xy * vec.y + xz * vec.z;
    const y = xy * vec.x + yy * vec.y + yz * vec.z;
    const z = xz * vec.x + yz * vec.y + zz * vec.z;
    const len = Math.hypot(x, y, z);
    if (len <= 1e-9) return null;
    vec.set(x / len, y / len, z / len);
  }
  return vec.normalize();
}

function resolveEdgeData(object) {
  if (!object) return null;
  const samplePayload = collectEdgeSamplePoints(object);
  if (!samplePayload) return null;

  const { points: samples, closedLoop } = samplePayload;
  if (!samples || samples.length < 2) return null;

  if (closedLoop) {
    const error = new Error('ParallelConstraint: Selected edge is a closed loop and has no unique tangent direction.');
    error.details = {
      objectName: object?.name || null,
      reason: 'edge-closed-loop',
    };
    throw error;
  }

  const first = samples[0].clone();
  const last = samples[samples.length - 1].clone();
  const endpoints = [first.clone(), last.clone()];

  const centroid = samples.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / samples.length);
  const midpoint = first.distanceToSquared(last) > 1e-14
    ? first.clone().add(last).multiplyScalar(0.5)
    : centroid.clone();

  const segmentAccum = new THREE.Vector3();
  let totalSegmentLength = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const seg = samples[i].clone().sub(samples[i - 1]);
    const segLength = seg.length();
    if (segLength > 1e-9) {
      segmentAccum.add(seg);
      totalSegmentLength += segLength;
    }
  }

  const chord = last.clone().sub(first);
  const chordLength = chord.length();

  let direction = principalAxisFromPoints(samples);
  let directionSource = direction ? 'edge-principal-axis' : null;

  if (!direction && totalSegmentLength > 1e-9) {
    direction = segmentAccum.clone().normalize();
    directionSource = 'edge-segment-average';
  }

  if (!direction && chordLength > 1e-9) {
    direction = chord.clone().normalize();
    directionSource = 'edge-chord';
  }

  if (!direction || direction.lengthSq() <= 1e-12) {
    return {
      endpoints,
      midpoint,
      sampleCount: samples.length,
      chord: chordLength > 1e-9 ? chord.clone() : null,
      segmentAccum: totalSegmentLength > 1e-9 ? segmentAccum.clone() : null,
      direction: null,
      directionSource: 'edge-direction-unresolved',
      totalSegmentLength,
      chordLength,
    };
  }

  if (chordLength > 1e-9 && direction.dot(chord) < 0) {
    direction.negate();
  }

  return {
    endpoints,
    midpoint,
    sampleCount: samples.length,
    chord: chordLength > 1e-9 ? chord.clone() : null,
    segmentAccum: totalSegmentLength > 1e-9 ? segmentAccum.clone() : null,
    direction: direction ? direction.clone() : null,
    directionSource,
    totalSegmentLength,
    chordLength,
    closedLoop: !!closedLoop,
  };
}

function resolveDirection(object, component, kind, edgeData) {
  const preferEdgeTangent = kind === 'EDGE';
  const elementDirCandidate = preferEdgeTangent
    ? null
    : normalizeOrNull(elementDirectionFrom(object) || elementDirectionFrom(component));

  if (preferEdgeTangent) {
    const edgeDir = normalizeOrNull(edgeData?.direction);
    if (edgeDir) {
      return { direction: edgeDir, source: edgeData?.directionSource || 'edge-data' };
    }

    return { direction: null, source: edgeData?.directionSource || 'edge-direction-unresolved' };
  }

  const worldNormal = normalizeOrNull(getWorldNormal(object));
  if (worldNormal) {
    return { direction: worldNormal, source: 'surface-normal' };
  }

  if (elementDirCandidate) {
    const source = preferEdgeTangent ? 'edge-element-direction' : 'element-direction';
    return { direction: elementDirCandidate, source };
  }

  const geometryNormal = normalizeOrNull(computeNormalFromObject(object));
  if (geometryNormal) {
    return { direction: geometryNormal, source: 'geometry-normal' };
  }

  return { direction: null, source: preferEdgeTangent ? 'edge-direction-unresolved' : 'unresolved' };
}

function selectionKindFrom(object, selection) {
  const candidates = [];
  if (selection && typeof selection.kind === 'string') candidates.push(selection.kind);
  const userData = object?.userData;
  if (userData?.type) candidates.push(userData.type);
  if (userData?.brepType) candidates.push(userData.brepType);
  if (object?.type) candidates.push(object.type);

  for (const raw of candidates) {
    const val = String(raw || '').toUpperCase();
    if (!val) continue;
    if (val.includes('FACE')) return 'FACE';
    if (val.includes('EDGE')) return 'EDGE';
    if (val.includes('VERTEX') || val.includes('POINT')) return 'POINT';
    if (val.includes('COMPONENT')) return 'COMPONENT';
  }
  return 'UNKNOWN';
}

function selectionDirection(constraint, context, selection, selectionLabel) {
  const object = context.resolveObject?.(selection) || null;
  const component = context.resolveComponent?.(selection) || null;
  const kind = selectionKindFrom(object, selection);
  const preferEdgeTangent = kind === 'EDGE';
  const edgeData = preferEdgeTangent ? resolveEdgeData(object) : null;
  if (context.scene?.updateMatrixWorld) {
    try { context.scene.updateMatrixWorld(true); } catch {}
  }
  component?.updateMatrixWorld?.(true);
  object?.updateMatrixWorld?.(true);

  let origin = resolveOrigin(object, component);
  if (edgeData?.midpoint) {
    origin = edgeData.midpoint.clone();
  }

  const resolved = resolveDirection(object, component, kind, edgeData);
  const dirFromObject = resolved.direction;
  if (!dirFromObject || dirFromObject.lengthSq() === 0) {
    const failureDetails = {
      selectionLabel,
      selection,
      objectName: object?.name || null,
      componentName: component?.name || null,
      kind,
      edgeData: edgeData ? {
        endpoints: edgeData.endpoints?.map?.((p) => p.toArray()) || null,
        directionSource: edgeData.directionSource || null,
        sampleCount: edgeData.sampleCount ?? null,
        chordLength: edgeData.chordLength ?? null,
        totalSegmentLength: edgeData.totalSegmentLength ?? null,
        closedLoop: edgeData.closedLoop ?? null,
      } : null,
      reason: resolved.source,
    };
    const error = new Error('ParallelConstraint: Unable to resolve a surface normal for the provided selection.');
    error.details = failureDetails;
    console.error('[ParallelConstraint] Failed to resolve normal for selection.', failureDetails, error);
    throw error;
  }

  return {
    direction: dirFromObject.clone().normalize(),
    origin,
    object,
    component: component || null,
    directionSource: resolved.source,
    kind,
    edgeData,
  };
}

function describeSelectionLabel(label) {
  if (!label) return 'selection';
  const match = /^elements\[(\d+)\]$/i.exec(String(label));
  if (match) {
    const index = Number(match[1]);
    if (Number.isFinite(index)) return `Element ${index + 1}`;
  }
  const trimmed = String(label).trim();
  if (!trimmed) return 'selection';
  return trimmed
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b([a-z])/gi, (m, ch) => ch.toUpperCase());
}

function normalizeQuaternion(quaternion) {
  if (!quaternion) return null;
  const q = quaternion instanceof THREE.Quaternion
    ? quaternion.clone()
    : new THREE.Quaternion(quaternion.x ?? 0, quaternion.y ?? 0, quaternion.z ?? 0, quaternion.w ?? 1);
  if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) return null;
  if (Math.abs(1 - q.lengthSq()) > 1e-6) q.normalize();
  return q;
}

function computeRotation(fromDir, toDir, gain = 1) {
  if (!fromDir || !toDir) return null;
  const a = fromDir.clone().normalize();
  const b = toDir.clone().normalize();
  const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  let angle = Math.acos(dot);
  if (!Number.isFinite(angle) || angle <= 1e-6) return null;
  const axis = new THREE.Vector3().crossVectors(a, b);
  if (axis.lengthSq() <= 1e-12) {
    axis.set(1, 0, 0).cross(a);
    if (axis.lengthSq() <= 1e-12) axis.set(0, 1, 0).cross(a);
  }
  axis.normalize();
  const clampedGain = Math.max(0, Math.min(1, gain));
  const intendedAngle = angle * clampedGain;
  const appliedAngle = Math.min(intendedAngle, MAX_ROTATION_PER_ITERATION, angle);
  if (appliedAngle <= 1e-6) return null;
  return new THREE.Quaternion().setFromAxisAngle(axis, appliedAngle);
}

function attemptRotation(context, component, fromDir, toDir, gain) {
  if (!component) return false;
  const quat = computeRotation(fromDir, toDir, gain);
  if (!quat) return false;
  const normalized = normalizeQuaternion(quat);
  if (!normalized) return false;
  const ok = context.applyRotation?.(component, normalized);
  return ok ? { component, quaternion: normalized } : false;
}

// Shared business logic for making two selections parallel; reuse in future constraints (e.g., distance).
export function solveParallelAlignment({
  constraint,
  context = {},
  selectionA,
  selectionB,
  opposeNormals = false,
  selectionLabelA = 'elements[0]',
  selectionLabelB = 'elements[1]',
}) {
  if (!constraint) throw new Error('solveParallelAlignment requires a constraint instance.');

  const labelA = describeSelectionLabel(selectionLabelA);
  const labelB = describeSelectionLabel(selectionLabelB);

  let infoA;
  let infoB;
  try {
    infoA = selectionDirection(constraint, context, selectionA, selectionLabelA);
  } catch (error) {
    return {
      ok: false,
      status: 'normal-resolution-failed',
      satisfied: false,
      applied: false,
      message: `Failed to resolve a normal for ${labelA}.`,
      exception: error,
      infoA: null,
      infoB: null,
    };
  }

  try {
    infoB = selectionDirection(constraint, context, selectionB, selectionLabelB);
  } catch (error) {
    return {
      ok: false,
      status: 'normal-resolution-failed',
      satisfied: false,
      applied: false,
      message: `Failed to resolve a normal for ${labelB}.`,
      exception: error,
      infoA,
      infoB: null,
    };
  }

  if (!infoA.component || !infoB.component) {
    return {
      ok: false,
      status: 'invalid-selection',
      satisfied: false,
      applied: false,
      message: 'Both selections must belong to assembly components.',
      infoA,
      infoB,
    };
  }

  if (infoA.component === infoB.component) {
    return {
      ok: false,
      status: 'invalid-selection',
      satisfied: false,
      applied: false,
      message: 'Select references from two different components.',
      infoA,
      infoB,
    };
  }

  const dirA = infoA.direction;
  const dirB = infoB.direction;

  if (!dirA || !dirB) {
    return {
      ok: false,
      status: 'invalid-selection',
      satisfied: false,
      applied: false,
      message: 'Unable to resolve directions for one or both selections.',
      infoA,
      infoB,
    };
  }

  const targetForB = opposeNormals ? dirA.clone().negate() : dirA.clone();
  const targetForA = opposeNormals ? dirB.clone().negate() : dirB.clone();

  const dot = THREE.MathUtils.clamp(dirB.dot(targetForB), -1, 1);
  const angle = Math.acos(dot);
  const angleDeg = THREE.MathUtils.radToDeg(angle);

  const contextTolerance = Math.abs(context.tolerance ?? DEFAULT_PARALLEL_ALIGNMENT_TOLERANCE);
  const angleTolerance = Math.max(ANGLE_TOLERANCE, contextTolerance * 10);

  const fixedA = context.isComponentFixed?.(infoA.component);
  const fixedB = context.isComponentFixed?.(infoB.component);
  const rotationGain = context.rotationGain ?? 1;

  if (angle <= angleTolerance) {
    return {
      ok: true,
      status: 'satisfied',
      satisfied: true,
      applied: false,
      angle,
      angleDeg,
      error: angle,
      infoA,
      infoB,
      message: 'Reference directions are parallel within tolerance.',
    };
  }

  if (fixedA && fixedB) {
    return {
      ok: false,
      status: 'blocked',
      satisfied: false,
      applied: false,
      angle,
      angleDeg,
      error: angle,
      infoA,
      infoB,
      message: 'Both components are fixed; unable to rotate to satisfy constraint.',
    };
  }

  const rotations = [];
  let applied = false;

  const pushRotation = (attempt) => {
    if (!attempt) return false;
    const { component, quaternion } = attempt;
    rotations.push({ component: component.name || component.uuid, quaternion: quaternion.toArray() });
    component.updateMatrixWorld?.(true);
    return true;
  };

  if (!fixedA && !fixedB) {
    applied = pushRotation(attemptRotation(context, infoA.component, dirA, targetForA, rotationGain * 0.5)) || applied;
    applied = pushRotation(attemptRotation(context, infoB.component, dirB, targetForB, rotationGain * 0.5)) || applied;
  } else if (fixedA && !fixedB) {
    applied = pushRotation(attemptRotation(context, infoB.component, dirB, targetForB, rotationGain)) || applied;
  } else if (!fixedA && fixedB) {
    applied = pushRotation(attemptRotation(context, infoA.component, dirA, targetForA, rotationGain)) || applied;
  }

  const status = applied ? 'adjusted' : 'pending';
  const message = applied
    ? 'Applied rotation to improve parallelism.'
    : 'Waiting for a movable component to rotate.';

  return {
    ok: true,
    status,
    satisfied: false,
    applied,
    angle,
    angleDeg,
    error: angle,
    infoA,
    infoB,
    message,
    rotations,
    diagnostics: { angle, angleDeg, rotations },
  };
}

export function resolveParallelSelection(constraint, context, selection, selectionLabel) {
  return selectionDirection(constraint, context, selection, selectionLabel);
}
