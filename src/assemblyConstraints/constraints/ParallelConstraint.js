import * as THREE from 'three';
import { BaseAssemblyConstraint } from '../BaseAssemblyConstraint.js';
import { objectRepresentativePoint, getElementDirection } from '../../UI/pmi/annUtils.js';

const inputParamsSchema = {
  constraintID: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the constraint.',
  },
  element_A: {
    type: 'reference_selection',
    label: 'Element A',
    hint: 'Select the first face, edge, or component.',
    selectionFilter: ['FACE', 'EDGE', 'COMPONENT'],
  },
  element_B: {
    type: 'reference_selection',
    label: 'Element B',
    hint: 'Select the second face, edge, or component.',
    selectionFilter: ['FACE', 'EDGE', 'COMPONENT'],
  },
  applyImmediately: {
    type: 'boolean',
    label: 'Apply Immediately',
    default_value: false,
    hint: 'Maintained for compatibility; solver applies adjustments iteratively.',
  },
  opposeNormals: {
    type: 'boolean',
    label: 'Oppose Normals',
    default_value: false,
    hint: 'Rotate so the reference directions point opposite each other.',
  },
};

const ANGLE_TOLERANCE = THREE.MathUtils.degToRad(0.5);
const MAX_ROTATION_PER_ITERATION = THREE.MathUtils.degToRad(20);

function firstSelection(value) {
  if (!value) return null;
  return Array.isArray(value) ? value.find((item) => item != null) ?? null : value;
}

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

export class ParallelConstraint extends BaseAssemblyConstraint {
  static constraintShortName = 'PARA';
  static constraintName = 'Parallel Constraint';
  static constraintType = 'parallel';
  static aliases = ['parallel', 'parallel_faces', 'face_parallel'];
  static inputParamsSchema = inputParamsSchema;

  constructor(partHistory) {
    super(partHistory);
    this._debugHelpers = [];
  }

  clearDebugArrows(context = {}) {
    const scene = context.scene || null;
    if (!scene) return;
    this.#clearNormalDebug(scene);
  }

  async solve(context = {}) {
    const pd = this.persistentData = this.persistentData || {};
    const selA = firstSelection(this.inputParams.element_A);
    const selB = firstSelection(this.inputParams.element_B);

    if ((context.iteration ?? 0) === 0) {
    if ((context.iteration ?? 0) === 0) {
      this.#clearNormalDebug(context.scene || null);
    }
    }

    if (!selA || !selB) {
      pd.status = 'incomplete';
      pd.message = 'Select two references to define the constraint.';
      pd.satisfied = false;
      return { ok: false, status: 'incomplete', satisfied: false, applied: false, message: pd.message };
    }

    let infoA;
    let infoB;
    try {
      infoA = selectionDirection(this, context, selA, 'element_A');
    } catch (error) {
      const message = 'Failed to resolve a normal for Element A.';
      pd.status = 'normal-resolution-failed';
      pd.message = message;
      pd.satisfied = false;
      pd.exception = error;
      return {
        ok: false,
        status: 'normal-resolution-failed',
        satisfied: false,
        applied: false,
        message,
        error,
      };
    }

    try {
      infoB = selectionDirection(this, context, selB, 'element_B');
    } catch (error) {
      const message = 'Failed to resolve a normal for Element B.';
      pd.status = 'normal-resolution-failed';
      pd.message = message;
      pd.satisfied = false;
      pd.exception = error;
      return {
        ok: false,
        status: 'normal-resolution-failed',
        satisfied: false,
        applied: false,
        message,
        error,
      };
    }

    if (!infoA.component || !infoB.component) {
      pd.status = 'invalid-selection';
      pd.message = 'Both selections must belong to assembly components.';
      pd.satisfied = false;
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message: pd.message };
    }

    if (infoA.component === infoB.component) {
      pd.status = 'invalid-selection';
      pd.message = 'Select references from two different components.';
      pd.satisfied = false;
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message: pd.message };
    }

    const dirA = infoA.direction;
    const dirB = infoB.direction;

    if (!dirA || !dirB) {
      pd.status = 'invalid-selection';
      pd.message = 'Unable to resolve directions for one or both selections.';
      pd.satisfied = false;
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message: pd.message };
    }

    const oppose = !!this.inputParams.opposeNormals;
    const targetForB = oppose ? dirA.clone().negate() : dirA.clone();
    const targetForA = oppose ? dirB.clone().negate() : dirB.clone();

    const dot = THREE.MathUtils.clamp(dirB.dot(targetForB), -1, 1);
    const angle = Math.acos(dot);
    const angleDeg = THREE.MathUtils.radToDeg(angle);

    const angleTolerance = Math.max(ANGLE_TOLERANCE, (context.tolerance ?? 1e-4) * 10);

    const fixedA = context.isComponentFixed?.(infoA.component);
    const fixedB = context.isComponentFixed?.(infoB.component);
    const rotationGain = context.rotationGain ?? 1;

    if (context.debugMode) {
      this.#updateNormalDebug(context, infoA, infoB);
    }

    console.log('[ParallelConstraint] normals', {
      constraintID: this.inputParams?.constraintID || null,
      faceA: {
        normal: dirA?.toArray?.() || null,
        point: infoA.origin?.toArray?.() || null,
        source: infoA.directionSource,
      },
      faceB: {
        normal: dirB?.toArray?.() || null,
        point: infoB.origin?.toArray?.() || null,
        source: infoB.directionSource,
      },
      angleRad: angle,
      angleDeg,
    });

    if (angle <= angleTolerance) {
      pd.status = 'satisfied';
      pd.message = 'Reference directions are parallel within tolerance.';
      pd.satisfied = true;
      pd.error = angle;
      pd.errorDeg = angleDeg;
      pd.lastAppliedRotations = [];
      return { ok: true, status: 'satisfied', satisfied: true, applied: false, error: angle, message: pd.message };
    }

    if (fixedA && fixedB) {
      pd.status = 'blocked';
      pd.message = 'Both components are fixed; unable to rotate to satisfy constraint.';
      pd.satisfied = false;
      pd.error = angle;
      pd.errorDeg = angleDeg;
      pd.lastAppliedRotations = [];
      return { ok: false, status: 'blocked', satisfied: false, applied: false, error: angle, message: pd.message };
    }

    const rotations = [];
    let applied = false;

    if (!fixedA && !fixedB) {
      const quatA = computeRotation(dirA, targetForA, rotationGain * 0.5);
      const quatB = computeRotation(dirB, targetForB, rotationGain * 0.5);
      if (quatA) {
        const normalized = normalizeQuaternion(quatA);
        if (normalized && context.applyRotation?.(infoA.component, normalized)) {
          applied = true;
          rotations.push({ component: infoA.component.name || infoA.component.uuid, quaternion: normalized.toArray() });
        }
      }
      if (quatB) {
        const normalized = normalizeQuaternion(quatB);
        if (normalized && context.applyRotation?.(infoB.component, normalized)) {
          applied = true;
          rotations.push({ component: infoB.component.name || infoB.component.uuid, quaternion: normalized.toArray() });
        }
      }
    } else if (fixedA && !fixedB) {
      const quatB = computeRotation(dirB, targetForB, rotationGain);
      const normalized = normalizeQuaternion(quatB);
      if (normalized && context.applyRotation?.(infoB.component, normalized)) {
        applied = true;
        rotations.push({ component: infoB.component.name || infoB.component.uuid, quaternion: normalized.toArray() });
      }
    } else if (!fixedA && fixedB) {
      const quatA = computeRotation(dirA, targetForA, rotationGain);
      const normalized = normalizeQuaternion(quatA);
      if (normalized && context.applyRotation?.(infoA.component, normalized)) {
        applied = true;
        rotations.push({ component: infoA.component.name || infoA.component.uuid, quaternion: normalized.toArray() });
      }
    }

    const status = applied ? 'adjusted' : 'pending';
    const message = applied ? 'Applied rotation to improve parallelism.' : 'Waiting for a movable component to rotate.';

    pd.status = status;
    pd.message = message;
    pd.satisfied = false;
    pd.error = angle;
    pd.errorDeg = angleDeg;
    if (rotations.length) pd.lastAppliedRotations = rotations;

    return {
      ok: true,
      status,
      satisfied: false,
      applied,
      error: angle,
      message,
      diagnostics: { angle, angleDeg, rotations },
    };
  }

  async run(context = {}) {
    return this.solve(context);
  }

  #updateNormalDebug(context, infoA, infoB) {
    if (!context?.debugMode) return;
    const scene = context.scene || null;
    if (!scene) return;

    const iteration = context.iteration ?? 0;
    const entries = [
      { info: infoA, color: 0xff4d4d, label: 'A' },
      { info: infoB, color: 0x4dff91, label: 'B' },
    ];

    for (const { info, color, label } of entries) {
      if (!info?.direction || !info.origin) continue;
      const dir = info.direction.clone().normalize();
      if (dir.lengthSq() === 0) continue;

      const origin = info.origin.clone();
      const length = Math.max(this.#estimateHelperLength(info), 10);
      const arrow = new THREE.ArrowHelper(dir, origin, length, color, length * 0.25, length * 0.15);
      arrow.name = `parallel-constraint-normal-${this.inputParams?.constraintID || 'unknown'}-${label}-iter${iteration}`;
      scene.add(arrow);
      this._debugHelpers.push(arrow);
    }
  }

  #clearNormalDebug(scene) {
    if (!this._debugHelpers) return;
    for (const helper of this._debugHelpers) {
      if (!helper) continue;
      if (scene && helper.parent === scene) {
        scene.remove(helper);
      } else if (helper.parent) {
        helper.parent.remove(helper);
      }
    }
    this._debugHelpers.length = 0;
  }

  #estimateHelperLength(info) {
    const candidates = [];
    const pushBound = (obj) => {
      if (!obj) return;
      if (obj.geometry?.computeBoundingSphere && !obj.geometry.boundingSphere) {
        try { obj.geometry.computeBoundingSphere(); } catch {}
      }
      const sphere = obj.geometry?.boundingSphere;
      if (sphere?.radius) candidates.push(Math.abs(sphere.radius));
      if (obj.geometry?.computeBoundingBox && !obj.geometry.boundingBox) {
        try { obj.geometry.computeBoundingBox(); } catch {}
      }
      const box = obj.geometry?.boundingBox;
      if (box) candidates.push(box.getSize(new THREE.Vector3()).length() / 2);
      if (typeof obj.getWorldScale === 'function') {
        const scale = obj.getWorldScale(new THREE.Vector3());
        candidates.push(scale.length() * 5);
      }
    };

    pushBound(info.object);
    if (Array.isArray(info.component?.children)) {
      for (const child of info.component.children) {
        pushBound(child);
      }
    }

    candidates.push(info.component?.userData?.boundingRadius || 0);

    const max = candidates.reduce((acc, val) => (Number.isFinite(val) ? Math.max(acc, val) : acc), 0);
    return Number.isFinite(max) && max > 0 ? max : 0;
  }
}
