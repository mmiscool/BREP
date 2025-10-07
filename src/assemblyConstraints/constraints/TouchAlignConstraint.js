import * as THREE from 'three';
import { BaseAssemblyConstraint } from '../BaseAssemblyConstraint.js';
import { solveParallelAlignment } from '../constraintUtils/parallelAlignment.js';

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
  opposeNormals: {
    type: 'boolean',
    label: 'Oppose Normals',
    default_value: false,
    hint: 'When enabled, Element B will be aligned to face Element A.',
  },
};

function firstSelection(value) {
  if (!value) return null;
  return Array.isArray(value) ? value.find((item) => item != null) ?? null : value;
}

function vectorToArray(vec) {
  if (!vec) return [0, 0, 0];
  return [vec.x, vec.y, vec.z];
}

export class TouchAlignConstraint extends BaseAssemblyConstraint {
  static constraintShortName = 'TALN';
  static constraintName = 'Touch Align Constraint';
  static constraintType = 'touch_align';
  static aliases = ['touch', 'touch_align', 'touch-align'];
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
      this.#clearNormalDebug(context.scene || null);
    }

    if (!selA || !selB) {
      pd.status = 'incomplete';
      pd.message = 'Select two references to define the constraint.';
      pd.satisfied = false;
      pd.lastAppliedMoves = [];
      return { ok: false, status: 'incomplete', satisfied: false, applied: false, message: pd.message };
    }

    const parallelResult = solveParallelAlignment({
      constraint: this,
      context,
      selectionA: selA,
      selectionB: selB,
      opposeNormals: !!this.inputParams.opposeNormals,
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
    const tolerance = Math.max(Math.abs(context.tolerance ?? 1e-4), 1e-8);

    const dirA = infoA.direction.clone().normalize();
    const delta = new THREE.Vector3().subVectors(infoB.origin, infoA.origin);
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
