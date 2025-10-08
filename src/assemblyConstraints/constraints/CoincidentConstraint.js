import * as THREE from 'three';
import { BaseAssemblyConstraint } from '../BaseAssemblyConstraint.js';
import { objectRepresentativePoint } from '../../UI/pmi/annUtils.js';

const inputParamsSchema = {
  constraintID: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the constraint.',
  },
  element_A: {
    type: 'reference_selection',
    label: 'Element A',
    hint: 'Select the first reference (vertex, edge, face, or component).',
    selectionFilter: ['VERTEX', 'EDGE', 'FACE', 'COMPONENT'],
  },
  element_B: {
    type: 'reference_selection',
    label: 'Element B',
    hint: 'Select the second reference (vertex, edge, face, or component).',
    selectionFilter: ['VERTEX', 'EDGE', 'FACE', 'COMPONENT'],
  },
  applyImmediately: {
    type: 'boolean',
    label: 'Apply Immediately',
    default_value: false,
    hint: 'Maintained for compatibility; runtime solver applies adjustments iteratively.',
  },
  faceNormalOpposed: {
    type: 'boolean',
    label: 'Oppose Face Normals',
    default_value: false,
    hint: 'Preserved for future expansion.',
  },
};

export class CoincidentConstraint extends BaseAssemblyConstraint {
  static constraintShortName = 'COIN';
  static constraintName = 'Coincident Constraint';
  static constraintType = 'coincident';
  static aliases = ['mate', 'coincident', 'coincident constraint'];
  static inputParamsSchema = inputParamsSchema;

  async solve(context = {}) {
    const pd = this.persistentData = this.persistentData || {};
    const tolerance = context.tolerance ?? 1e-4;

    const selA = firstSelection(this.inputParams.element_A);
    const selB = firstSelection(this.inputParams.element_B);

    if (!selA || !selB) {
      pd.status = 'incomplete';
      pd.message = 'Select two references to define the constraint.';
      pd.satisfied = false;
      return { ok: false, status: 'incomplete', satisfied: false, applied: false, message: pd.message };
    }

    const infoA = selectionInfo(this, context, selA);
    const infoB = selectionInfo(this, context, selB);

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

    if (!infoA.point || !infoB.point) {
      pd.status = 'invalid-selection';
      pd.message = 'Unable to resolve world-space positions for one or both selections.';
      pd.satisfied = false;
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message: pd.message };
    }

    const delta = new THREE.Vector3().subVectors(infoA.point, infoB.point);
    const distance = delta.length();

    const fixedA = context.isComponentFixed?.(infoA.component);
    const fixedB = context.isComponentFixed?.(infoB.component);
    const translationGain = context.translationGain ?? 1;

    if (distance <= tolerance) {
      pd.status = 'satisfied';
      pd.message = 'Selections are coincident within tolerance.';
      pd.error = distance;
      pd.satisfied = true;
      pd.lastAppliedMoves = [];
      return { ok: true, status: 'satisfied', satisfied: true, applied: false, error: distance, message: pd.message };
    }

    if (fixedA && fixedB) {
      pd.status = 'blocked';
      pd.message = 'Both components are fixed; unable to adjust positions.';
      pd.error = distance;
      pd.satisfied = false;
      pd.lastAppliedMoves = [];
      return { ok: false, status: 'blocked', satisfied: false, applied: false, error: distance, message: pd.message };
    }

    const moves = [];
    let applied = false;

    const applyMove = (component, moveVector) => {
      if (!component || !moveVector || moveVector.lengthSq() === 0) return false;
      const ok = context.applyTranslation?.(component, moveVector);
      if (ok) {
        moves.push({ component: component.name || component.uuid, move: vectorToArray(moveVector) });
      }
      return ok;
    };

    if (!fixedA && !fixedB) {
      const step = delta.clone().multiplyScalar(0.5 * translationGain);
      if (step.lengthSq() > 0) {
        applied = applyMove(infoA.component, step.clone().multiplyScalar(-1)) || applied;
        applied = applyMove(infoB.component, step) || applied;
      }
    } else if (fixedA && !fixedB) {
      const step = delta.clone().multiplyScalar(translationGain);
      if (step.lengthSq() > 0) applied = applyMove(infoB.component, step) || applied;
    } else if (!fixedA && fixedB) {
      const step = delta.clone().multiplyScalar(translationGain);
      if (step.lengthSq() > 0) applied = applyMove(infoA.component, step.clone().multiplyScalar(-1)) || applied;
    }

    const status = applied ? 'adjusted' : 'pending';
    const message = applied ? 'Applied translation to reduce separation.' : 'Waiting for a movable component to adjust.';

    pd.status = status;
    pd.message = message;
    pd.error = distance;
    pd.satisfied = false;
    if (moves.length) pd.lastAppliedMoves = moves;

    return {
      ok: true,
      status,
      satisfied: false,
      applied,
      error: distance,
      message,
      diagnostics: { distance, moves },
    };
  }

  async run(context = {}) {
    return this.solve(context);
  }
}


function firstSelection(value) {
  if (!value) return null;
  return Array.isArray(value) ? value.find((item) => item != null) ?? null : value;
}

function resolvePoint(constraint, object, component) {
  if (object) {
    try {
      const rep = objectRepresentativePoint(null, object);
      if (rep && typeof rep.clone === 'function') return rep.clone();
    } catch {}
    const worldPoint = constraint.getWorldPoint(object);
    if (worldPoint) return worldPoint;
  }
  if (component) {
    component.updateMatrixWorld?.(true);
    const worldPoint = constraint.getWorldPoint(component);
    if (worldPoint) return worldPoint;
  }
  return null;
}

function selectionInfo(constraint, context, selection) {
  const object = context.resolveObject?.(selection) || null;
  const component = context.resolveComponent?.(selection) || null;
  const point = resolvePoint(constraint, object, component);
  return { object, component, point };
}

function vectorToArray(vec) {
  if (!vec) return [0, 0, 0];
  return [vec.x, vec.y, vec.z];
}

