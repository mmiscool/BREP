import * as THREE from 'three';
import { BaseAssemblyConstraint } from '../BaseAssemblyConstraint.js';
import { ANGLE_TOLERANCE, MAX_ROTATION_PER_ITERATION, resolveParallelSelection } from '../constraintUtils/parallelAlignment.js';
import { objectRepresentativePoint, getElementDirection } from '../../UI/pmi/annUtils.js';

const DEFAULT_ANGLE_LINEAR_TOLERANCE = 1e-12;

const inputParamsSchema = {
  constraintID: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the constraint.',
  },
  elements: {
    type: 'reference_selection',
    label: 'Elements',
    hint: 'Select two faces or edges.',
    selectionFilter: ['FACE', 'EDGE'],
    multiple: true,
    minSelections: 2,
    maxSelections: 2,
  },
  angle: {
    type: 'number',
    label: 'Angle (deg)',
    default_value: 90,
    hint: 'Desired signed angle between Element A and Element B in degrees (-360 to 360).',
  },
};


export class AngleConstraint extends BaseAssemblyConstraint {
  static constraintShortName = '∠';
  static constraintName = '∠ Angle Constraint';
  static constraintType = 'angle';
  static aliases = ['angle', 'angle_between', 'angular', 'ANGL'];
  static inputParamsSchema = inputParamsSchema;

  constructor(partHistory) {
    super(partHistory);
  }

  async solve(context = {}) {
    const pd = this.persistentData = this.persistentData || {};
    const [selA, selB] = selectionPair(this.inputParams);
    const targetAngleValue = Number(this.inputParams.angle ?? 0);
    const targetAngleDeg = clampAndNormalizeAngleDeg(targetAngleValue);
    const targetAngleRad = THREE.MathUtils.degToRad(targetAngleDeg);

    if (!selA || !selB) {
      pd.status = 'incomplete';
      pd.message = 'Select two references to define the constraint.';
      pd.satisfied = false;
      pd.error = null;
      pd.errorDeg = null;
      pd.lastAppliedRotations = [];
      pd.lastAppliedMoves = [];
      return { ok: false, status: 'incomplete', satisfied: false, applied: false, message: pd.message };
    }

    let infoA;
    let infoB;

    try {
      infoA = this.#resolveSelectionInfo(context, selA, 'elements[0]');
      infoB = this.#resolveSelectionInfo(context, selB, 'elements[1]');
    } catch (error) {
      const message = error?.message || 'Unable to resolve selection references.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.error = null;
      pd.errorDeg = null;
      pd.lastAppliedRotations = [];
      pd.lastAppliedMoves = [];
      pd.exception = error;
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message, exception: error };
    }

    if (!infoA || !infoB || !infoA.direction || !infoB.direction) {
      const message = 'Unable to resolve directions for the selected references.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.error = null;
      pd.errorDeg = null;
      pd.lastAppliedRotations = [];
      pd.lastAppliedMoves = [];
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    if (!infoA.component || !infoB.component) {
      const message = 'Both selections must belong to assembly components.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.error = null;
      pd.errorDeg = null;
      pd.lastAppliedRotations = [];
      pd.lastAppliedMoves = [];
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    if (infoA.component === infoB.component) {
      const message = 'Select references from two different components.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.error = null;
      pd.errorDeg = null;
      pd.lastAppliedRotations = [];
      pd.lastAppliedMoves = [];
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    const measurement = this.#measureAngle(infoA, infoB);
    if (!measurement) {
      const message = 'Unable to measure angle between selections.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.error = null;
      pd.errorDeg = null;
      pd.lastAppliedRotations = [];
      pd.lastAppliedMoves = [];
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    const angle = measurement.angle;
    const angleDeg = measurement.angleDeg;
    const signedAngle = measurement.signedAngle;
    const signedAngleDeg = measurement.signedAngleDeg;
    const error = signedAngle - targetAngleRad;

    const fixedA = context.isComponentFixed?.(infoA.component);
    const fixedB = context.isComponentFixed?.(infoB.component);

    const linearTolerance = Math.abs(context.tolerance ?? DEFAULT_ANGLE_LINEAR_TOLERANCE);
    const explicitAngleTol = Number.isFinite(context.angleTolerance) ? Math.abs(context.angleTolerance) : null;
    const angleTolerance = explicitAngleTol && explicitAngleTol > 0
      ? Math.max(ANGLE_TOLERANCE, explicitAngleTol)
      : Math.max(ANGLE_TOLERANCE, linearTolerance * 10);

    pd.error = Math.abs(error);
    pd.errorDeg = Math.abs(THREE.MathUtils.radToDeg(error));

    if (Math.abs(error) <= angleTolerance) {
      const message = 'Angle satisfied within tolerance.';
      pd.status = 'satisfied';
      pd.message = message;
      pd.satisfied = true;
      pd.lastAppliedRotations = [];
      pd.lastAppliedMoves = [];
      if (pd.exception) delete pd.exception;
      return {
        ok: true,
        status: 'satisfied',
        satisfied: true,
        applied: false,
        angle,
        angleDeg,
        signedAngle,
        signedAngleDeg,
        targetAngle: targetAngleRad,
        error,
        message,
        infoA,
        infoB,
      };
    }

    if (fixedA && fixedB) {
      const message = 'Both components are fixed; unable to adjust angle.';
      pd.status = 'blocked';
      pd.message = message;
      pd.satisfied = false;
      pd.lastAppliedRotations = [];
      pd.lastAppliedMoves = [];
      if (pd.exception) delete pd.exception;
      return {
        ok: false,
        status: 'blocked',
        satisfied: false,
        applied: false,
        angle,
        angleDeg,
        targetAngle: targetAngleRad,
        error,
        message,
        infoA,
        infoB,
      };
    }

    const desiredSignedAngle = targetAngleRad;
    const delta = signedAngle - desiredSignedAngle;

    const phiACurrent = 0;
    const phiBCurrent = signedAngle;
    let phiATarget;
    let phiBTarget;

    if (!fixedA && !fixedB) {
      const halfDelta = delta / 2;
      phiATarget = phiACurrent + halfDelta;
      phiBTarget = phiBCurrent - halfDelta;
    } else if (!fixedA && fixedB) {
      phiBTarget = phiBCurrent;
      phiATarget = phiBTarget - desiredSignedAngle;
    } else {
      phiATarget = phiACurrent;
      phiBTarget = phiATarget + desiredSignedAngle;
    }

    const rotationGain = Math.max(0, Math.min(1, context.rotationGain ?? 1));
    const rotations = [];
    let applied = false;

    const applyRotation = (info, currentDir, targetDir, gainMultiplier) => {
      if (!info?.component || !currentDir || !targetDir) return false;
      const quaternion = computeRotationTowards(currentDir, targetDir, rotationGain * gainMultiplier);
      if (!quaternion) return false;
      const ok = context.applyRotation?.(info.component, quaternion);
      if (!ok) return false;
      rotations.push({ component: info.component.name || info.component.uuid, quaternion: quaternion.toArray() });
      info.component.updateMatrixWorld?.(true);
      return true;
    };

    const shareA = (!fixedA && !fixedB) ? 0.5 : (!fixedA ? 1 : 0);
    const shareB = (!fixedA && !fixedB) ? 0.5 : (!fixedB ? 1 : 0);

    if (shareA > 0) {
      const targetDirA = this.#directionFromAngle(measurement, phiATarget);
      applied = applyRotation(infoA, measurement.dirA, targetDirA, shareA) || applied;
    }

    if (shareB > 0) {
      const targetDirB = this.#directionFromAngle(measurement, phiBTarget);
      applied = applyRotation(infoB, measurement.dirB, targetDirB, shareB) || applied;
    }

    const status = applied ? 'adjusted' : 'pending';
    const message = applied
      ? 'Applied rotation to move toward target angle.'
      : 'Waiting for a movable component to rotate.';

    pd.status = status;
    pd.message = message;
    pd.satisfied = false;
    pd.lastAppliedRotations = rotations;
    pd.lastAppliedMoves = [];
    if (pd.exception) delete pd.exception;

    return {
      ok: true,
      status,
      satisfied: false,
      applied,
      angle,
      angleDeg,
      signedAngle,
      signedAngleDeg,
      targetAngle: targetAngleRad,
      error,
      message,
      infoA,
      infoB,
      rotations,
      diagnostics: {
        angle,
        angleDeg,
        signedAngle,
        signedAngleDeg,
        targetAngle: targetAngleRad,
        error,
        shareA,
        shareB,
        desiredSignedAngle,
      },
    };
  }

  async run(context = {}) {
    return this.solve(context);
  }

  #resolveSelectionInfo(context, selection, label) {
    const object = context.resolveObject?.(selection) || null;
    const component = context.resolveComponent?.(selection) || null;
    const kind = selectionKindFrom(object, selection);

    if (kind === 'FACE') {
      return resolveParallelSelection(this, context, selection, label);
    }

    if (kind !== 'EDGE') {
      throw new Error(`AngleConstraint: Unsupported selection for ${label}.`);
    }

    const origin = this.#resolveOrigin(object, component) || new THREE.Vector3();
    const direction = this.#resolveEdgeDirection(object, component);

    if (!direction) {
      throw new Error('AngleConstraint: Unable to resolve edge direction.');
    }

    return {
      selection,
      object,
      component: component || null,
      origin,
      direction,
      kind,
    };
  }

  #resolveOrigin(object, component) {
    if (object) {
      try {
        const rep = objectRepresentativePoint(null, object);
        if (rep && typeof rep.clone === 'function') return rep.clone();
      } catch { }
      if (typeof object.getWorldPosition === 'function') {
        return object.getWorldPosition(new THREE.Vector3());
      }
      if (object.isVector3) return object.clone();
    }
    if (component) {
      component.updateMatrixWorld?.(true);
      if (typeof component.getWorldPosition === 'function') {
        return component.getWorldPosition(new THREE.Vector3());
      }
      if (component.position) {
        const pos = component.position.clone();
        component.parent?.updateMatrixWorld?.(true);
        if (component.parent?.matrixWorld) {
          return pos.applyMatrix4(component.parent.matrixWorld.clone());
        }
        return pos;
      }
    }
    return null;
  }

  #resolveEdgeDirection(object, component) {
    const dir = getElementDirection(null, object);
    if (dir && dir.lengthSq() > 0) return dir.clone().normalize();
    if (component) {
      const compDir = getElementDirection(null, component);
      if (compDir && compDir.lengthSq() > 0) return compDir.clone().normalize();
    }
    const geom = object?.geometry;
    if (geom?.getAttribute) {
      const pos = geom.getAttribute('position');
      if (pos && pos.count >= 2) {
        const a = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0));
        const b = new THREE.Vector3(pos.getX(1), pos.getY(1), pos.getZ(1));
        object.updateMatrixWorld?.(true);
        a.applyMatrix4(object.matrixWorld);
        b.applyMatrix4(object.matrixWorld);
        return b.sub(a).normalize();
      }
    }
    return null;
  }

  #measureAngle(infoA, infoB) {
    const dirA = normalizeOrNull(infoA?.direction);
    const dirB = normalizeOrNull(infoB?.direction);
    if (!dirA || !dirB) return null;

    let axis = new THREE.Vector3().crossVectors(dirA, dirB);
    if (axis.lengthSq() <= 1e-12) {
      axis = arbitraryPerpendicular(dirA);
    }
    if (axis.lengthSq() <= 1e-12) return null;
    axis.normalize();

    let basisU = new THREE.Vector3().crossVectors(axis, dirA);
    if (basisU.lengthSq() <= 1e-12) {
      basisU = arbitraryPerpendicular(dirA);
    }
    if (basisU.lengthSq() <= 1e-12) return null;
    basisU.normalize();

    const cosVal = THREE.MathUtils.clamp(dirA.dot(dirB), -1, 1);
    const sinVal = THREE.MathUtils.clamp(basisU.dot(dirB), -1, 1);
    const signedAngle = Math.atan2(sinVal, cosVal);
    const angle = Math.acos(cosVal);

    return {
      angle,
      angleDeg: THREE.MathUtils.radToDeg(angle),
      signedAngle,
      signedAngleDeg: THREE.MathUtils.radToDeg(signedAngle),
      axis,
      basisU,
      dirA,
      dirB,
    };
  }

  #directionFromAngle(measurement, angle) {
    if (!measurement) return null;
    const { dirA, basisU } = measurement;
    if (!dirA || !basisU) return null;
    const cosVal = Math.cos(angle);
    const sinVal = Math.sin(angle);
    const out = dirA.clone().multiplyScalar(cosVal).add(basisU.clone().multiplyScalar(sinVal));
    if (out.lengthSq() === 0) return null;
    return out.normalize();
  }
}




function selectionPair(params) {
  if (!params || typeof params !== 'object') return [null, null];
  const raw = Array.isArray(params.elements) ? params.elements : [];
  const picks = raw.filter((item) => item != null).slice(0, 2);
  params.elements = picks;
  if (picks.length === 2) return picks;
  if (picks.length === 1) return [picks[0], null];
  return [null, null];
}

function selectionKindFrom(object, selection) {
  const val = (selection && typeof selection.kind === 'string') ? selection.kind : null;
  const raw = (object?.userData?.type || object?.userData?.brepType || object?.type || val || '')
    .toString()
    .toUpperCase();
  if (!raw) return 'UNKNOWN';
  if (raw.includes('FACE')) return 'FACE';
  if (raw.includes('EDGE')) return 'EDGE';
  if (raw.includes('VERTEX') || raw.includes('POINT')) return 'POINT';
  if (raw.includes('COMPONENT')) return 'COMPONENT';
  return raw;
}

function normalizeOrNull(vec) {
  if (!vec) return null;
  if (vec.lengthSq() === 0) return null;
  return vec.clone().normalize();
}

function arbitraryPerpendicular(dir) {
  if (!dir || dir.lengthSq() === 0) return new THREE.Vector3(0, 0, 1);
  const axis = Math.abs(dir.dot(new THREE.Vector3(0, 0, 1))) < 0.9
    ? new THREE.Vector3(0, 0, 1)
    : new THREE.Vector3(0, 1, 0);
  const perp = new THREE.Vector3().crossVectors(dir, axis);
  if (perp.lengthSq() === 0) {
    perp.crossVectors(dir, new THREE.Vector3(1, 0, 0));
  }
  return perp.lengthSq() === 0 ? new THREE.Vector3(1, 0, 0) : perp.normalize();
}

function clampAndNormalizeAngleDeg(value) {
  const safeValue = Number.isFinite(value) ? THREE.MathUtils.clamp(value, -360, 360) : 0;
  const wrapped = ((safeValue % 360) + 360) % 360;
  if (wrapped === 180) return safeValue < 0 ? -180 : 180;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

function computeRotationTowards(fromDir, toDir, gain = 1) {
  if (!fromDir || !toDir) return null;
  const a = fromDir.clone().normalize();
  const b = toDir.clone().normalize();
  const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  let angle = Math.acos(dot);
  if (!Number.isFinite(angle) || angle <= 1e-6) return null;
  let axis = new THREE.Vector3().crossVectors(a, b);
  if (axis.lengthSq() <= 1e-12) {
    axis = arbitraryPerpendicular(a);
  }
  if (axis.lengthSq() <= 1e-12) return null;
  axis.normalize();
  const clampedGain = Math.max(0, Math.min(1, gain));
  const intendedAngle = angle * clampedGain;
  const appliedAngle = Math.min(intendedAngle, MAX_ROTATION_PER_ITERATION, angle);
  if (appliedAngle <= 1e-6) return null;
  return new THREE.Quaternion().setFromAxisAngle(axis, appliedAngle);
}
