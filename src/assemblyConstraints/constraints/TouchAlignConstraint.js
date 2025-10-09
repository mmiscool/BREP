import * as THREE from 'three';
import { BaseAssemblyConstraint } from '../BaseAssemblyConstraint.js';
import { solveParallelAlignment, resolveParallelSelection } from '../constraintUtils/parallelAlignment.js';
import { objectRepresentativePoint } from '../../UI/pmi/annUtils.js';

const DEFAULT_TOUCH_TOLERANCE = 1e-6;
const MAX_POINT_ROTATION_STEP = THREE.MathUtils.degToRad(5);

const inputParamsSchema = {
  constraintID: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the constraint.',
  },
  elements: {
    type: 'reference_selection',
    label: 'Elements',
    hint: 'Select two faces, edges, or vertices.',
    selectionFilter: ['FACE', 'EDGE', 'VERTEX'],
    multiple: true,
    minSelections: 2,
    maxSelections: 2,
  },
  reverse: {
    type: 'boolean',
    label: 'Reverse',
    default_value: false,
    hint: 'Flip the stored orientation preference.',
  },
};

export class TouchAlignConstraint extends BaseAssemblyConstraint {
  static constraintShortName = '⪥';
  static constraintName = '⪥ Touch Align Constraint';
  static constraintType = 'touch_align';
  static aliases = ['touch', 'touch_align', 'touch-align', 'TALN'];
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

  async run(context = {}) {
    const pd = this.persistentData = this.persistentData || {};
    const [selA, selB] = selectionPair(this.inputParams);

    if ((context.iteration ?? 0) === 0) {
      this.#clearNormalDebug(context.scene || null);
    }

    if (!selA || !selB) {
      pd.status = 'incomplete';
      pd.message = 'Select two references to define the constraint.';
      pd.satisfied = false;
      pd.lastAppliedMoves = [];
      pd.lastAppliedRotations = [];
      return { ok: false, status: 'incomplete', satisfied: false, applied: false, message: pd.message };
    }

    const objectA = context.resolveObject?.(selA) || null;
    const objectB = context.resolveObject?.(selB) || null;
    const kindA = normalizeSelectionKind(selectionKindFrom(objectA, selA));
    const kindB = normalizeSelectionKind(selectionKindFrom(objectB, selB));

    if (kindA === 'FACE' && kindB === 'FACE') {
      return this.faceToFace(context, selA, selB);
    }

    if (kindA === 'EDGE' && kindB === 'EDGE') {
      return this.edgeToEdge(context, selA, selB);
    }

    if (kindA === 'POINT' && kindB === 'POINT') {
      return this.pointToPoint(context, selA, selB);
    }

    const message = 'Touch Align requires two selections of the same type. Face-to-face alignment is currently supported.';
    pd.status = 'unsupported-selection';
    pd.message = message;
    pd.satisfied = false;
    pd.error = null;
    pd.errorDeg = null;
    pd.lastAppliedMoves = [];
    pd.lastAppliedRotations = [];
    if (pd.exception) delete pd.exception;
    return { ok: false, status: 'unsupported-selection', satisfied: false, applied: false, message };
  }

  async solve(context = {}) {
    return this.run(context);
  }

  #effectiveOppose(context, selectionA, selectionB) {
    const base = this.#preferredOppose(context, selectionA, selectionB);
    const reverseToggle = !!this.inputParams.reverse;
    return reverseToggle ? !base : base;
  }

  #preferredOppose(context, selectionA, selectionB) {
    const pd = this.persistentData = this.persistentData || {};
    if (typeof pd.preferredOppose !== 'boolean') {
      const infoA = resolveParallelSelection(this, context, selectionA, 'elements[0]');
      const infoB = resolveParallelSelection(this, context, selectionB, 'elements[1]');
      const dirA = infoA?.direction?.clone()?.normalize();
      const dirB = infoB?.direction?.clone()?.normalize();
      if (!dirA || !dirB || dirA.lengthSq() === 0 || dirB.lengthSq() === 0) {
        throw new Error('TouchAlignConstraint: Unable to resolve directions for orientation preference.');
      }
      const dot = THREE.MathUtils.clamp(dirA.dot(dirB), -1, 1);
      pd.preferredOppose = dot < 0;
      pd.lastOrientationDot = dot;
    }
    pd.isNewConstraint = false;
    return !!pd.preferredOppose;
  }

  async faceToFace(context, selA, selB) {
    const pd = this.persistentData = this.persistentData || {};

    const opposeNormals = this.#effectiveOppose(context, selA, selB);

    const parallelResult = solveParallelAlignment({
      constraint: this,
      context,
      selectionA: selA,
      selectionB: selB,
      opposeNormals,
      selectionLabelA: 'elements[0]',
      selectionLabelB: 'elements[1]',
    });

    const infoA = parallelResult.infoA || null;
    const infoB = parallelResult.infoB || null;

    if (context.debugMode && infoA && infoB) {
      this.#updateNormalDebug(context, infoA, infoB);
    }

    pd.lastAppliedRotations = Array.isArray(parallelResult.rotations) ? parallelResult.rotations : [];

    if (!parallelResult.ok) {
      pd.status = parallelResult.status;
      pd.message = parallelResult.message || '';
      pd.satisfied = false;
      pd.error = parallelResult.error ?? null;
      pd.errorDeg = parallelResult.angleDeg ?? null;
      pd.exception = parallelResult.exception || null;
      return parallelResult;
    }

    if (!parallelResult.satisfied) {
      pd.status = parallelResult.status;
      pd.message = parallelResult.message || 'Aligning surface orientations…';
      pd.satisfied = false;
      pd.error = parallelResult.angle ?? null;
      pd.errorDeg = parallelResult.angleDeg ?? null;
      pd.lastAppliedMoves = [];
      if (pd.exception) delete pd.exception;
      return {
        ...parallelResult,
        stage: 'orientation',
      };
    }

    if (!infoA || !infoB || !infoA.origin || !infoB.origin || !infoA.direction) {
      const message = 'Unable to resolve contact data after alignment.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    const fixedA = context.isComponentFixed?.(infoA.component);
    const fixedB = context.isComponentFixed?.(infoB.component);
    const translationGain = context.translationGain ?? 1;
    const tolerance = Math.max(Math.abs(context.tolerance ?? DEFAULT_TOUCH_TOLERANCE), 1e-8);

    const dirA = infoA.direction.clone().normalize();
    const delta = new THREE.Vector3().subVectors(infoB.origin, infoA.origin);
    const moves = [];
    let applied = false;

    const applyMove = (component, vec) => {
      if (!component || !vec || vec.lengthSq() === 0) return false;
      const ok = context.applyTranslation?.(component, vec);
      if (ok) {
        moves.push({ component: component.name || component.uuid, move: vectorToArray(vec) });
      }
      return ok;
    };

    const separation = delta.dot(dirA);
    const distance = Math.abs(separation);

    if (distance <= tolerance) {
      const message = 'Faces are touching within tolerance.';
      pd.status = 'satisfied';
      pd.message = message;
      pd.satisfied = true;
      pd.error = distance;
      pd.errorDeg = 0;
      pd.lastAppliedMoves = [];
      return {
        ok: true,
        status: 'satisfied',
        satisfied: true,
        applied: false,
        error: distance,
        message,
        infoA,
        infoB,
        diagnostics: { separation, moves: [] },
      };
    }

    if (fixedA && fixedB) {
      const message = 'Both components are fixed; unable to translate to touch.';
      pd.status = 'blocked';
      pd.message = message;
      pd.satisfied = false;
      pd.error = distance;
      pd.errorDeg = 0;
      return {
        ok: false,
        status: 'blocked',
        satisfied: false,
        applied: false,
        error: distance,
        message,
        infoA,
        infoB,
        diagnostics: { separation, moves: [] },
      };
    }

    const correction = -separation * Math.max(0, Math.min(1, translationGain));
    const halfCorrection = correction * 0.5;

    if (!fixedA && !fixedB) {
      const moveA = dirA.clone().multiplyScalar(-halfCorrection);
      const moveB = dirA.clone().multiplyScalar(halfCorrection);
      applied = applyMove(infoA.component, moveA) || applied;
      applied = applyMove(infoB.component, moveB) || applied;
    } else if (fixedA && !fixedB) {
      const moveB = dirA.clone().multiplyScalar(correction);
      applied = applyMove(infoB.component, moveB) || applied;
    } else if (!fixedA && fixedB) {
      const moveA = dirA.clone().multiplyScalar(-correction);
      applied = applyMove(infoA.component, moveA) || applied;
    }

    const status = applied ? 'adjusted' : 'pending';
    const message = applied
      ? 'Applied translation to bring faces into contact.'
      : 'Waiting for a movable component to translate.';

    pd.status = status;
    pd.message = message;
    pd.satisfied = false;
    pd.error = distance;
    pd.errorDeg = 0;
    pd.lastAppliedMoves = moves;
    if (pd.exception) delete pd.exception;

    return {
      ok: true,
      status,
      satisfied: false,
      applied,
      error: distance,
      message,
      infoA,
      infoB,
      diagnostics: { separation, moves },
    };
  }

  async edgeToEdge(_context, _selA, _selB) {
    const context = _context || {};
    const pd = this.persistentData = this.persistentData || {};

    const opposeNormals = this.#effectiveOppose(context, _selA, _selB);

    const parallelResult = solveParallelAlignment({
      constraint: this,
      context,
      selectionA: _selA,
      selectionB: _selB,
      opposeNormals,
      selectionLabelA: 'elements[0]',
      selectionLabelB: 'elements[1]',
    });

    const infoA = parallelResult.infoA || null;
    const infoB = parallelResult.infoB || null;

    if (context.debugMode && infoA && infoB) {
      this.#updateNormalDebug(context, infoA, infoB);
    }

    pd.lastAppliedRotations = Array.isArray(parallelResult.rotations) ? parallelResult.rotations : [];

    if (!parallelResult.ok) {
      pd.status = parallelResult.status;
      pd.message = parallelResult.message || '';
      pd.satisfied = false;
      pd.error = parallelResult.error ?? null;
      pd.errorDeg = parallelResult.angleDeg ?? null;
      pd.lastAppliedMoves = [];
      pd.exception = parallelResult.exception || null;
      return parallelResult;
    }

    if (!parallelResult.satisfied) {
      pd.status = parallelResult.status;
      pd.message = parallelResult.message || 'Aligning edge directions…';
      pd.satisfied = false;
      pd.error = parallelResult.angle ?? null;
      pd.errorDeg = parallelResult.angleDeg ?? null;
      pd.lastAppliedMoves = [];
      if (pd.exception) delete pd.exception;
      return {
        ...parallelResult,
        stage: 'orientation',
      };
    }

    if (!infoA || !infoB || !infoA.origin || !infoB.origin || !infoA.direction) {
      const message = 'Unable to resolve edge data after alignment.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.lastAppliedMoves = [];
      pd.error = null;
      pd.errorDeg = null;
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    const fixedA = context.isComponentFixed?.(infoA.component);
    const fixedB = context.isComponentFixed?.(infoB.component);
    const translationGain = Math.max(0, Math.min(1, context.translationGain ?? 1));
    const tolerance = Math.max(Math.abs(context.tolerance ?? DEFAULT_TOUCH_TOLERANCE), 1e-8);

    const dir = infoA.direction.clone().normalize();
    const delta = new THREE.Vector3().subVectors(infoB.origin, infoA.origin);
    const parallelComponent = dir.clone().multiplyScalar(delta.dot(dir));
    const separationVec = delta.clone().sub(parallelComponent);
    const distance = separationVec.length();

    pd.error = distance;
    pd.errorDeg = null;

    if (distance <= tolerance) {
      const message = 'Edges are colinear within tolerance.';
      pd.status = 'satisfied';
      pd.message = message;
      pd.satisfied = true;
      pd.lastAppliedMoves = [];
      if (pd.exception) delete pd.exception;
      return {
        ok: true,
        status: 'satisfied',
        satisfied: true,
        applied: false,
        error: distance,
        message,
        infoA,
        infoB,
        diagnostics: {
          separationVector: separationVec.toArray(),
          parallelComponent: parallelComponent.toArray(),
        },
      };
    }

    if (fixedA && fixedB) {
      const message = 'Both components are fixed; unable to translate to make edges colinear.';
      pd.status = 'blocked';
      pd.message = message;
      pd.satisfied = false;
      pd.lastAppliedMoves = [];
      if (pd.exception) delete pd.exception;
      return {
        ok: false,
        status: 'blocked',
        satisfied: false,
        applied: false,
        error: distance,
        message,
        infoA,
        infoB,
        diagnostics: {
          separationVector: separationVec.toArray(),
          parallelComponent: parallelComponent.toArray(),
        },
      };
    }

    const correctionVec = separationVec.clone().multiplyScalar(translationGain);
    const moves = [];
    let applied = false;

    const applyMove = (component, vec) => {
      if (!component || !vec || vec.lengthSq() === 0) return false;
      const ok = context.applyTranslation?.(component, vec);
      if (ok) {
        moves.push({ component: component.name || component.uuid, move: vectorToArray(vec) });
      }
      return ok;
    };

    if (!fixedA && !fixedB) {
      const moveA = correctionVec.clone().multiplyScalar(0.5);
      const moveB = correctionVec.clone().multiplyScalar(-0.5);
      applied = applyMove(infoA.component, moveA) || applied;
      applied = applyMove(infoB.component, moveB) || applied;
    } else if (fixedA && !fixedB) {
      const moveB = correctionVec.clone().negate();
      applied = applyMove(infoB.component, moveB) || applied;
    } else if (!fixedA && fixedB) {
      const moveA = correctionVec.clone();
      applied = applyMove(infoA.component, moveA) || applied;
    }

    const status = applied ? 'adjusted' : 'pending';
    const message = applied
      ? 'Applied translation to bring edges onto the same line.'
      : 'Waiting for a movable component to translate.';

    pd.status = status;
    pd.message = message;
    pd.satisfied = false;
    pd.lastAppliedMoves = moves;
    if (pd.exception) delete pd.exception;

    return {
      ok: true,
      status,
      satisfied: false,
      applied,
      error: distance,
      message,
      infoA,
      infoB,
      diagnostics: {
        separationVector: separationVec.toArray(),
        parallelComponent: parallelComponent.toArray(),
        moves,
      },
      stage: 'translation',
    };
  }

  async pointToPoint(_context, _selA, _selB) {
    const context = _context || {};
    const pd = this.persistentData = this.persistentData || {};

    let infoA = resolvePointSelection(this, context, _selA);
    let infoB = resolvePointSelection(this, context, _selB);

    pd.pointToPointNextMode = pd.pointToPointNextMode === 'rotate' ? 'rotate' : 'translate';

    if (!infoA?.component || !infoB?.component) {
      const message = 'Point selections must belong to assembly components.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.error = null;
      pd.errorDeg = null;
      pd.lastAppliedMoves = [];
      pd.lastAppliedRotations = [];
      pd.pointToPointNextMode = 'translate';
      if (pd.exception) delete pd.exception;
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    if (infoA.component === infoB.component) {
      const message = 'Select points from different components for touch alignment.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.error = null;
      pd.errorDeg = null;
      pd.lastAppliedMoves = [];
      pd.lastAppliedRotations = [];
      pd.pointToPointNextMode = 'translate';
      if (pd.exception) delete pd.exception;
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    if (!infoA.point || !infoB.point) {
      const message = 'Unable to resolve world-space positions for the selected points.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.error = null;
      pd.errorDeg = null;
      pd.lastAppliedMoves = [];
      pd.lastAppliedRotations = [];
      pd.pointToPointNextMode = 'translate';
      if (pd.exception) delete pd.exception;
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    const tolerance = Math.max(Math.abs(context.tolerance ?? DEFAULT_TOUCH_TOLERANCE), 1e-8);
    const translationGain = Math.max(0, Math.min(1, context.translationGain ?? 1));
    const rotationGain = Math.max(0, Math.min(1, context.rotationGain ?? 1));

    const fixedA = context.isComponentFixed?.(infoA.component);
    const fixedB = context.isComponentFixed?.(infoB.component);

    let delta = new THREE.Vector3().subVectors(infoA.point, infoB.point);
    let distance = delta.length();

    const refreshInfo = () => {
      const nextA = resolvePointSelection(this, context, _selA);
      const nextB = resolvePointSelection(this, context, _selB);
      if (nextA?.point && nextB?.point) {
        infoA = nextA;
        infoB = nextB;
        delta = new THREE.Vector3().subVectors(infoA.point, infoB.point);
        distance = delta.length();
      }
    };

    pd.error = distance;
    pd.errorDeg = null;

    if (distance <= tolerance) {
      const message = 'Points are coincident within tolerance.';
      pd.status = 'satisfied';
      pd.message = message;
      pd.satisfied = true;
      pd.lastAppliedMoves = [];
      pd.lastAppliedRotations = [];
      pd.pointToPointNextMode = 'translate';
      if (pd.exception) delete pd.exception;
      return {
        ok: true,
        status: 'satisfied',
        satisfied: true,
        applied: false,
        error: distance,
        message,
        infoA,
        infoB,
        diagnostics: {
          distance,
          delta: delta.toArray(),
          moves: [],
          rotations: [],
          stage: 'satisfied',
        },
      };
    }

    const performRotation = () => {
      const rotations = [];
      const moves = [];
      let appliedRotation = false;

      const applyRotationTowards = (sourceInfo, targetPoint, share) => {
        const component = sourceInfo?.component;
        if (!component || share <= 0 || context.isComponentFixed?.(component)) return false;
        const pivot = resolveComponentMidpoint(this, component);
        if (!pivot) return false;

        const fromVec = sourceInfo.point.clone().sub(pivot);
        const toVec = targetPoint.clone().sub(pivot);

        if (fromVec.lengthSq() <= 1e-12 || toVec.lengthSq() <= 1e-12) return false;

        const nFrom = fromVec.clone().normalize();
        const nTo = toVec.clone().normalize();
        const dot = THREE.MathUtils.clamp(nFrom.dot(nTo), -1, 1);
        const angle = Math.acos(dot);
        if (!Number.isFinite(angle) || angle <= 1e-6) return false;

        const maxStep = Math.min(angle, MAX_POINT_ROTATION_STEP);
        const stepAngle = maxStep * rotationGain * share;
        if (!Number.isFinite(stepAngle) || stepAngle <= 1e-6) return false;

        const axis = fromVec.clone().cross(toVec);
        if (axis.lengthSq() <= 1e-12) return false;
        axis.normalize();

        const quaternion = new THREE.Quaternion().setFromAxisAngle(axis, stepAngle);

        component.updateMatrixWorld?.(true);
        const pivotWorld = pivot.clone();
        let pivotLocal = null;
        if (typeof component.worldToLocal === 'function' && typeof component.localToWorld === 'function') {
          pivotLocal = component.worldToLocal(pivot.clone());
        }

        const ok = context.applyRotation?.(component, quaternion);
        if (!ok) return false;

        appliedRotation = true;

        const record = {
          component: component.name || component.uuid,
          quaternion: quaternion.toArray(),
          axis: vectorToArray(axis),
          angleRad: stepAngle,
          angleDeg: THREE.MathUtils.radToDeg(stepAngle),
          pivot: vectorToArray(pivotWorld),
        };
        rotations.push(record);

        if (pivotLocal) {
          component.updateMatrixWorld?.(true);
          const pivotAfter = component.localToWorld(pivotLocal.clone());
          const correction = pivotWorld.clone().sub(pivotAfter);
          if (correction.lengthSq() > 1e-12) {
            const moved = context.applyTranslation?.(component, correction);
            if (moved) {
              moves.push({ component: component.name || component.uuid, move: vectorToArray(correction) });
            }
          }
        }

        return true;
      };

      const movableA = !fixedA && infoA.component;
      const movableB = !fixedB && infoB.component;

      if (!movableA && !movableB) {
        return { handled: false };
      }

      const shareA = movableA && movableB ? 0.5 : (movableA ? 1 : 0);
      const shareB = movableA && movableB ? 0.5 : (movableB ? 1 : 0);

      if (shareA > 0) applyRotationTowards(infoA, infoB.point, shareA);
      if (shareB > 0) applyRotationTowards(infoB, infoA.point, shareB);

      if (!appliedRotation) {
        return { handled: false };
      }

      refreshInfo();
      pd.error = distance;
      pd.status = 'adjusted';
      pd.message = 'Applied rotation to bring points closer.';
      pd.satisfied = false;
      pd.lastAppliedMoves = moves;
      pd.lastAppliedRotations = rotations;
      pd.pointToPointNextMode = 'translate';
      if (pd.exception) delete pd.exception;

      return {
        handled: true,
        applied: true,
        result: {
          ok: true,
          status: 'adjusted',
          satisfied: false,
          applied: true,
          error: distance,
          message: pd.message,
          infoA,
          infoB,
          diagnostics: {
            distance,
            delta: delta.toArray(),
            rotations,
            moves,
            stage: 'rotation',
          },
        },
      };
    };

    const performTranslation = () => {
      const moves = [];
      let appliedTranslation = false;

      const applyMove = (component, vec) => {
        if (!component || !vec || vec.lengthSq() === 0) return false;
        const ok = context.applyTranslation?.(component, vec);
        if (ok) {
          moves.push({ component: component.name || component.uuid, move: vectorToArray(vec) });
        }
        return ok;
      };

      if (fixedA && fixedB) {
        const message = 'Both components are fixed; unable to translate points into contact.';
        pd.status = 'blocked';
        pd.message = message;
        pd.satisfied = false;
        pd.lastAppliedMoves = [];
        pd.lastAppliedRotations = [];
        pd.pointToPointNextMode = 'translate';
        if (pd.exception) delete pd.exception;
        return {
          result: {
            ok: false,
            status: 'blocked',
            satisfied: false,
            applied: false,
            error: distance,
            message,
            infoA,
            infoB,
            diagnostics: {
              distance,
              delta: delta.toArray(),
              moves: [],
              rotations: [],
              stage: 'translation',
            },
          },
          applied: false,
        };
      }

      if (!fixedA && !fixedB) {
        const step = delta.clone().multiplyScalar(0.5 * translationGain);
        if (step.lengthSq() > 0) {
          appliedTranslation = applyMove(infoA.component, step.clone().negate()) || appliedTranslation;
          appliedTranslation = applyMove(infoB.component, step) || appliedTranslation;
        }
      } else if (fixedA && !fixedB) {
        const step = delta.clone().multiplyScalar(translationGain);
        if (step.lengthSq() > 0) {
          appliedTranslation = applyMove(infoB.component, step) || appliedTranslation;
        }
      } else if (!fixedA && fixedB) {
        const step = delta.clone().multiplyScalar(translationGain);
        if (step.lengthSq() > 0) {
          appliedTranslation = applyMove(infoA.component, step.clone().negate()) || appliedTranslation;
        }
      }

      if (appliedTranslation) {
        refreshInfo();
        pd.error = distance;
      }

      const status = appliedTranslation ? 'adjusted' : 'pending';
      const message = appliedTranslation
        ? 'Applied translation to align points.'
        : 'Waiting for a movable component to translate.';

      pd.status = status;
      pd.message = message;
      pd.satisfied = false;
      pd.lastAppliedMoves = moves;
      pd.lastAppliedRotations = [];
      pd.pointToPointNextMode = 'rotate';
      if (pd.exception) delete pd.exception;

      return {
        result: {
          ok: true,
          status,
          satisfied: false,
          applied: appliedTranslation,
          error: distance,
          message,
          infoA,
          infoB,
          diagnostics: {
            distance,
            delta: delta.toArray(),
            moves,
            rotations: [],
            stage: 'translation',
          },
        },
        applied: appliedTranslation,
      };
    };

    let finalResult = null;

    if (pd.pointToPointNextMode === 'rotate') {
      const rotationAttempt = performRotation();
      if (rotationAttempt?.handled) {
        return rotationAttempt.result;
      }
      // rotation skipped; fall through to translation
    }

    finalResult = performTranslation();
    return finalResult.result;
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
      arrow.name = `touch-align-normal-${this.inputParams?.constraintID || 'unknown'}-${label}-iter${iteration}`;
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


function selectionPair(params) {
  if (!params || typeof params !== 'object') return [null, null];
  const raw = Array.isArray(params.elements) ? params.elements : [];
  const picks = raw.filter((item) => item != null).slice(0, 2);
  params.elements = picks;
  if (picks.length === 2) return picks;
  if (picks.length === 1) return [picks[0], null];
  return [null, null];
}

function vectorToArray(vec) {
  if (!vec) return [0, 0, 0];
  return [vec.x, vec.y, vec.z];
}

function resolvePointSelection(constraint, context, selection) {
  if (!selection) return null;
  const object = context.resolveObject?.(selection) || null;
  const component = context.resolveComponent?.(selection) || null;
  const point = resolveSelectionPoint(constraint, object, component);
  return {
    selection,
    object,
    component: component || null,
    point,
  };
}

function resolveSelectionPoint(constraint, object, component) {
  if (object) {
    try {
      const rep = objectRepresentativePoint(null, object);
      if (rep && typeof rep.clone === 'function') return rep.clone();
    } catch {}
    const worldPoint = constraint.getWorldPoint(object);
    if (worldPoint) return worldPoint;
  }
  if (component) {
    try {
      const rep = objectRepresentativePoint(null, component);
      if (rep && typeof rep.clone === 'function') return rep.clone();
    } catch {}
    component.updateMatrixWorld?.(true);
    const worldPoint = constraint.getWorldPoint(component);
    if (worldPoint) return worldPoint;
  }
  return null;
}

function resolveComponentMidpoint(constraint, component) {
  if (!component) return null;
  component.updateMatrixWorld?.(true);
  try {
    const rep = objectRepresentativePoint(null, component);
    if (rep && typeof rep.clone === 'function') return rep.clone();
  } catch {}
  const worldPoint = constraint.getWorldPoint(component);
  if (worldPoint) return worldPoint;
  if (typeof component.getWorldPosition === 'function') {
    return component.getWorldPosition(new THREE.Vector3());
  }
  if (component.position) {
    const pos = component.position.clone();
    if (component.parent?.matrixWorld) {
      return pos.applyMatrix4(component.parent.matrixWorld);
    }
    return pos;
  }
  return null;
}

function selectionKindFrom(object, selection) {
  const raw = (selection?.kind
    || object?.userData?.type
    || object?.userData?.brepType
    || object?.type
    || '').toString().toUpperCase();
  if (!raw) return 'UNKNOWN';
  if (raw.includes('FACE')) return 'FACE';
  if (raw.includes('EDGE')) return 'EDGE';
  if (raw.includes('VERTEX') || raw.includes('POINT')) return 'POINT';
  if (raw.includes('COMPONENT')) return 'COMPONENT';
  return raw;
}

function normalizeSelectionKind(kind) {
  if (kind === 'COMPONENT') return 'FACE';
  return kind;
}
