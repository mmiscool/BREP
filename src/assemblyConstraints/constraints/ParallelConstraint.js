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

export class ParallelConstraint extends BaseAssemblyConstraint {
  static constraintShortName = '∥';
  static constraintName = '∥ Parallel Constraint';
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
    const selA = firstSelection(this.inputParams.element_A);
    const selB = firstSelection(this.inputParams.element_B);

    if ((context.iteration ?? 0) === 0) {
      this.#clearNormalDebug(context.scene || null);
    }

    if (!selA || !selB) {
      pd.status = 'incomplete';
      pd.message = 'Select two references to define the constraint.';
      pd.satisfied = false;
      return { ok: false, status: 'incomplete', satisfied: false, applied: false, message: pd.message };
    }

    const result = solveParallelAlignment({
      constraint: this,
      context,
      selectionA: selA,
      selectionB: selB,
      opposeNormals: !!this.inputParams.opposeNormals,
    });

    const infoA = result.infoA || null;
    const infoB = result.infoB || null;

    if (context.debugMode && infoA && infoB) {
      this.#updateNormalDebug(context, infoA, infoB);
    }

    if (infoA && infoB) {
      const dirA = infoA.direction;
      const dirB = infoB.direction;
      const angle = typeof result.angle === 'number' ? result.angle : null;
      const angleDeg = typeof result.angleDeg === 'number'
        ? result.angleDeg
        : (typeof angle === 'number' ? THREE.MathUtils.radToDeg(angle) : null);

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


function firstSelection(value) {
  if (!value) return null;
  return Array.isArray(value) ? value.find((item) => item != null) ?? null : value;
}