import * as THREE from 'three';
import { BaseAssemblyConstraint } from '../BaseAssemblyConstraint.js';
import { solveParallelAlignment, resolveParallelSelection } from '../constraintUtils/parallelAlignment.js';

const inputParamsSchema = {
  constraintID: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the constraint.',
  },
  elements: {
    type: 'reference_selection',
    label: 'Elements',
    hint: 'Select two faces, edges, or components.',
    selectionFilter: ['FACE', 'EDGE', 'COMPONENT'],
    multiple: true,
    minSelections: 2,
    maxSelections: 2,
  },
  applyImmediately: {
    type: 'boolean',
    label: 'Apply Immediately',
    default_value: false,
    hint: 'Maintained for compatibility; solver applies adjustments iteratively.',
  },
  reverse: {
    type: 'boolean',
    label: 'Reverse',
    default_value: false,
    hint: 'Flip the stored orientation preference.',
  },
};

export class ParallelConstraint extends BaseAssemblyConstraint {
  static shortName = '∥';
  static longName = '∥ Parallel Constraint';
  static constraintType = 'parallel';
  static aliases = ['parallel', 'parallel_faces', 'face_parallel', 'PARA'];
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
    const [selA, selB] = selectionPair(this.inputParams);

    if ((context.iteration ?? 0) === 0) {
      this.#clearNormalDebug(context.scene || null);
    }

    if (!selA || !selB) {
      pd.status = 'incomplete';
      pd.message = 'Select two references to define the constraint.';
      pd.satisfied = false;
      return { ok: false, status: 'incomplete', satisfied: false, applied: false, message: pd.message };
    }

    const opposeNormals = this.#effectiveOppose(context, selA, selB);

    const result = solveParallelAlignment({
      constraint: this,
      context,
      selectionA: selA,
      selectionB: selB,
      opposeNormals,
      selectionLabelA: 'elements[0]',
      selectionLabelB: 'elements[1]',
    });

    const infoA = result.infoA || null;
    const infoB = result.infoB || null;

    if (context.debugMode && infoA && infoB) {
      this.#updateNormalDebug(context, infoA, infoB);
    }

    if (context.debugMode && infoA && infoB) {
      const dirA = infoA.direction;
      const dirB = infoB.direction;
      const angle = typeof result.angle === 'number' ? result.angle : null;
      const angleDeg = typeof result.angleDeg === 'number'
        ? result.angleDeg
        : (typeof angle === 'number' ? THREE.MathUtils.radToDeg(angle) : null);

      console.log('[ParallelConstraint] directions', {
        constraintID: this.inputParams?.constraintID || null,
        selectionA: {
          normal: dirA?.toArray?.() || null,
          point: infoA.origin?.toArray?.() || null,
          source: infoA.directionSource,
          kind: infoA.kind || null,
        },
        selectionB: {
          normal: dirB?.toArray?.() || null,
          point: infoB.origin?.toArray?.() || null,
          source: infoB.directionSource,
          kind: infoB.kind || null,
        },
        angleRad: angle,
        angleDeg,
      });
    }

    pd.status = result.status;
    pd.message = result.message || '';
    pd.satisfied = !!result.satisfied;

    if (typeof result.angle === 'number') {
      pd.error = result.angle;
      pd.errorDeg = typeof result.angleDeg === 'number'
        ? result.angleDeg
        : THREE.MathUtils.radToDeg(result.angle);
    } else {
      pd.error = null;
      pd.errorDeg = null;
    }

    if (Array.isArray(result.rotations) && result.rotations.length) {
      pd.lastAppliedRotations = result.rotations;
    } else if (pd.lastAppliedRotations && (!result.rotations || result.rotations.length === 0)) {
      pd.lastAppliedRotations = [];
    }

    if (result.exception) {
      pd.exception = result.exception;
    } else if (pd.exception) {
      delete pd.exception;
    }

    return result;
  }

  async run(context = {}) {
    return this.solve(context);
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
        throw new Error('ParallelConstraint: Unable to resolve directions for orientation preference.');
      }
      const dot = THREE.MathUtils.clamp(dirA.dot(dirB), -1, 1);
      pd.preferredOppose = dot < 0;
      pd.lastOrientationDot = dot;
    }
    pd.isNewConstraint = false;
    return !!pd.preferredOppose;
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


function selectionPair(params) {
  if (!params || typeof params !== 'object') return [null, null];
  const raw = Array.isArray(params.elements) ? params.elements : [];
  const picks = raw.filter((item) => item != null).slice(0, 2);
  params.elements = picks;
  if (picks.length === 2) return picks;
  if (picks.length === 1) return [picks[0], null];
  return [null, null];
}
