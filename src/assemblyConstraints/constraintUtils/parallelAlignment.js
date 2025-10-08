import * as THREE from 'three';
import { objectRepresentativePoint, getElementDirection } from '../../UI/pmi/annUtils.js';

export const ANGLE_TOLERANCE = THREE.MathUtils.degToRad(0.5);
export const MAX_ROTATION_PER_ITERATION = THREE.MathUtils.degToRad(20);

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

function resolveDirection(object) {
  if (!object) return null;
  const worldNormal = getWorldNormal(object);
  if (worldNormal && worldNormal.lengthSq() > 0) return worldNormal.normalize();
  try {
    const dir = getElementDirection(null, object);
    if (dir && dir.lengthSq() > 0) return dir.clone().normalize();
  } catch {}
  const fallback = computeNormalFromObject(object);
  if (fallback && fallback.lengthSq() > 0) return fallback.normalize();
  return null;
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

function selectionDirection(constraint, context, selection, selectionLabel) {
  const object = context.resolveObject?.(selection) || null;
  const component = context.resolveComponent?.(selection) || null;
  if (context.scene?.updateMatrixWorld) {
    try { context.scene.updateMatrixWorld(true); } catch {}
  }
  component?.updateMatrixWorld?.(true);
  object?.updateMatrixWorld?.(true);

  const origin = resolveOrigin(object, component);
  const dirFromObject = resolveDirection(object);
  if (!dirFromObject || dirFromObject.lengthSq() === 0) {
    const failureDetails = {
      selectionLabel,
      selection,
      objectName: object?.name || null,
      componentName: component?.name || null,
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
    directionSource: 'object',
  };
}

function describeSelectionLabel(label) {
  if (!label) return 'selection';
  if (label === 'element_A') return 'Element A';
  if (label === 'element_B') return 'Element B';
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
  selectionLabelA = 'element_A',
  selectionLabelB = 'element_B',
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

  const contextTolerance = Math.abs(context.tolerance ?? 1e-4);
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
