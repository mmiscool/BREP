import * as THREE from 'three';
import { BaseAssemblyConstraint } from '../BaseAssemblyConstraint.js';
import { solveParallelAlignment, resolveParallelSelection } from '../constraintUtils/parallelAlignment.js';
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
    hint: 'Select the first reference (point, edge, face, or component).',
    selectionFilter: [ 'FACE','VERTEX', 'EDGE',],
  },
  element_B: {
    type: 'reference_selection',
    label: 'Element B',
    hint: 'Select the second reference (point, edge, face, or component).',
    selectionFilter: ['FACE','VERTEX', 'EDGE', ],
  },
  distance: {
    type: 'number',
    label: 'Distance',
    default_value: 0,
    hint: 'Desired separation between references.',
  },
  opposeNormals: {
    type: 'boolean',
    label: 'Oppose Normals',
    default_value: false,
    hint: 'For face-to-face mode, flip Element B normal before alignment.',
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

function normalizeOrNull(vec) {
  if (!vec) return null;
  if (vec.lengthSq() === 0) return null;
  return vec.normalize();
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

function selectionKindFrom(object, selection) {
  const val = (selection && typeof selection.kind === 'string') ? selection.kind : null;
  const raw = (object?.userData?.type || object?.userData?.brepType || object?.type || val || '').toString().toUpperCase();
  if (!raw) return 'UNKNOWN';
  if (raw.includes('FACE')) return 'FACE';
  if (raw.includes('EDGE')) return 'EDGE';
  if (raw.includes('VERTEX') || raw.includes('POINT')) return 'POINT';
  if (raw.includes('COMPONENT')) return 'COMPONENT';
  return raw;
}

export class DistanceConstraint extends BaseAssemblyConstraint {
  static constraintShortName = 'DIST';
  static constraintName = 'Distance Constraint';
  static constraintType = 'distance';
  static aliases = ['distance', 'offset', 'gap'];
  static inputParamsSchema = inputParamsSchema;

  constructor(partHistory) {
    super(partHistory);
    this._debugHelpers = [];
  }

  async solve(context = {}) {
    const pd = this.persistentData = this.persistentData || {};
    const selA = firstSelection(this.inputParams.element_A);
    const selB = firstSelection(this.inputParams.element_B);
    const targetDistanceRaw = Number(this.inputParams.distance ?? 0);
    const targetDistance = Number.isFinite(targetDistanceRaw) ? Math.max(0, targetDistanceRaw) : 0;

    if ((context.iteration ?? 0) === 0) {
      this.#clearDebug(context.scene || null);
    }

    if (!selA || !selB) {
      pd.status = 'incomplete';
      pd.message = 'Select two references to define the constraint.';
      pd.satisfied = false;
      pd.error = null;
      pd.lastAppliedMoves = [];
      pd.lastAppliedRotations = [];
      return { ok: false, status: 'incomplete', satisfied: false, applied: false, message: pd.message };
    }

    const tolerance = Math.max(Math.abs(context.tolerance ?? 1e-4), 1e-8);
    const translationGain = Math.max(0, Math.min(1, context.translationGain ?? 1));

    const faceFace = this.#isFaceFace(context, selA, selB);
    let infoA;
    let infoB;
    let parallelResult = null;

    if (faceFace) {
      parallelResult = solveParallelAlignment({
        constraint: this,
        context,
        selectionA: selA,
        selectionB: selB,
        opposeNormals: !!this.inputParams.opposeNormals,
      });

      infoA = parallelResult.infoA || null;
      infoB = parallelResult.infoB || null;

      pd.lastAppliedRotations = Array.isArray(parallelResult.rotations) ? parallelResult.rotations : [];

      if (context.debugMode && infoA && infoB) {
        this.#updateNormalDebug(context, infoA, infoB);
      }

      if (!parallelResult.ok) {
        pd.status = parallelResult.status;
        pd.message = parallelResult.message || '';
        pd.satisfied = false;
        pd.error = parallelResult.error ?? null;
        pd.errorDeg = parallelResult.angleDeg ?? null;
        pd.exception = parallelResult.exception || null;
        pd.lastAppliedMoves = [];
        return { ...parallelResult, stage: 'orientation' };
      }

      if (!parallelResult.satisfied) {
        pd.status = parallelResult.status;
        pd.message = parallelResult.message || 'Aligning surfaces…';
        pd.satisfied = false;
        pd.error = parallelResult.angle ?? null;
        pd.errorDeg = parallelResult.angleDeg ?? null;
        pd.lastAppliedMoves = [];
        if (pd.exception) delete pd.exception;
        return { ...parallelResult, stage: 'orientation' };
      }
    } else {
      infoA = this.#resolveSelectionInfo(context, selA, 'element_A');
      infoB = this.#resolveSelectionInfo(context, selB, 'element_B');
    }

    if (!infoA || !infoB || !infoA.origin || !infoB.origin) {
      const message = 'Unable to resolve world-space references for the selection.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.error = null;
      pd.lastAppliedMoves = [];
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    const measurement = this.#measureDistance(infoA, infoB, targetDistance, tolerance);
    if (!measurement || !Number.isFinite(measurement.distance)) {
      const message = 'Unable to measure distance between selections.';
      pd.status = 'invalid-selection';
      pd.message = message;
      pd.satisfied = false;
      pd.error = null;
      pd.lastAppliedMoves = [];
      return { ok: false, status: 'invalid-selection', satisfied: false, applied: false, message };
    }

    const distance = measurement.distance;
    const error = distance - targetDistance;

    const fixedA = context.isComponentFixed?.(infoA.component);
    const fixedB = context.isComponentFixed?.(infoB.component);

    pd.error = Math.abs(error);
    pd.errorDeg = null;

    if (Math.abs(error) <= tolerance) {
      const message = 'Distance satisfied within tolerance.';
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
        error: Math.abs(error),
        message,
        infoA,
        infoB,
        diagnostics: { distance, targetDistance, error, stage: faceFace ? 'offset' : 'general' },
      };
    }

    if (fixedA && fixedB) {
      const message = 'Both components are fixed; unable to adjust distance.';
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
        error: Math.abs(error),
        message,
        infoA,
        infoB,
        diagnostics: { distance, targetDistance, error, stage: faceFace ? 'offset' : 'general' },
      };
    }

    const dirs = measurement.directions;
    const moves = [];
    let applied = false;

    const applyCorrection = (info, dir, share) => {
      if (!info?.component || !dir || dir.lengthSq() === 0 || share === 0) return false;
      const move = dir.clone().normalize().multiplyScalar(share * translationGain * (targetDistance - distance));
      if (move.lengthSq() === 0) return false;
      const ok = context.applyTranslation?.(info.component, move);
      if (ok) {
        moves.push({ component: info.component.name || info.component.uuid, move: vectorToArray(move) });
      }
      return ok;
    };

    const movableA = !fixedA && infoA.component;
    const movableB = !fixedB && infoB.component;

    if (movableA && movableB) {
      applied = applyCorrection(infoA, dirs.increaseA, 0.5) || applied;
      applied = applyCorrection(infoB, dirs.increaseB, 0.5) || applied;
    } else if (movableA && !movableB) {
      applied = applyCorrection(infoA, dirs.increaseA, 1) || applied;
    } else if (!movableA && movableB) {
      applied = applyCorrection(infoB, dirs.increaseB, 1) || applied;
    }

    const status = applied ? 'adjusted' : 'pending';
    const message = applied
      ? 'Applied translation to move toward target distance.'
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
      error: Math.abs(error),
      message,
      infoA,
      infoB,
      diagnostics: {
        distance,
        targetDistance,
        error,
        moves,
        stage: faceFace ? 'offset' : 'general',
      },
    };
  }

  async run(context = {}) {
    return this.solve(context);
  }

  #isFaceFace(context, selA, selB) {
    const objA = context.resolveObject?.(selA) || null;
    const objB = context.resolveObject?.(selB) || null;
    const kindA = selectionKindFrom(objA, selA);
    const kindB = selectionKindFrom(objB, selB);
    return kindA === 'FACE' && kindB === 'FACE';
  }

  #resolveSelectionInfo(context, selection, label) {
    const object = context.resolveObject?.(selection) || null;
    const component = context.resolveComponent?.(selection) || null;
    const kind = selectionKindFrom(object, selection);

    if (kind === 'FACE') {
      return resolveParallelSelection(this, context, selection, label);
    }

    const origin = this.#resolveOrigin(object, component) || new THREE.Vector3();
    let direction = null;

    if (kind === 'EDGE') {
      direction = this.#resolveEdgeDirection(object, component);
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
      } catch {}
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

  #measureDistance(infoA, infoB, targetDistance, tolerance) {
    const kindA = (infoA.kind || selectionKindFrom(infoA.object, infoA.selection)).toUpperCase?.()
      || selectionKindFrom(infoA.object, infoA.selection);
    const kindB = (infoB.kind || selectionKindFrom(infoB.object, infoB.selection)).toUpperCase?.()
      || selectionKindFrom(infoB.object, infoB.selection);

    if (kindA === 'FACE' && kindB === 'FACE') {
      return this.#faceFaceDistance(infoA, infoB);
    }
    if (kindA === 'FACE' && kindB !== 'FACE') {
      return this.#facePointLikeDistance(infoA, infoB);
    }
    if (kindB === 'FACE' && kindA !== 'FACE') {
      const swap = this.#facePointLikeDistance(infoB, infoA);
      if (!swap) return null;
      return {
        distance: swap.distance,
        directions: {
          increaseA: swap.directions.increaseB,
          increaseB: swap.directions.increaseA,
        },
      };
    }
    if (kindA === 'EDGE' && kindB === 'POINT') {
      return this.#pointEdgeDistance(infoB, infoA, true);
    }
    if (kindA === 'POINT' && kindB === 'EDGE') {
      return this.#pointEdgeDistance(infoA, infoB, false);
    }
    if (kindA === 'EDGE' && kindB === 'EDGE') {
      return this.#edgeEdgeDistance(infoA, infoB);
    }
    return this.#pointPointDistance(infoA, infoB);
  }

  #pointPointDistance(infoA, infoB) {
    const delta = new THREE.Vector3().subVectors(infoB.origin, infoA.origin);
    const dist = delta.length();
    const dir = dist > 1e-9 ? delta.clone().divideScalar(dist) : new THREE.Vector3(1, 0, 0);
    return {
      distance: dist,
      directions: {
        increaseA: dir.clone().negate(),
        increaseB: dir,
      },
    };
  }

  #pointEdgeDistance(pointInfo, edgeInfo, swapped) {
    const edgeDir = normalizeOrNull(edgeInfo.direction) || new THREE.Vector3(1, 0, 0);
    const linePoint = edgeInfo.origin.clone();
    const point = pointInfo.origin.clone();

    const delta = point.clone().sub(linePoint);
    const proj = delta.dot(edgeDir);
    const closest = linePoint.clone().add(edgeDir.clone().multiplyScalar(proj));
    const sep = point.clone().sub(closest);
    let dist = sep.length();
    let normal = dist > 1e-9 ? sep.clone().divideScalar(dist) : arbitraryPerpendicular(edgeDir);
    dist = Math.abs(dist);

    return swapped
      ? {
        distance: dist,
        directions: {
          increaseA: normal.clone().negate(),
          increaseB: normal.clone(),
        },
      }
      : {
        distance: dist,
        directions: {
          increaseA: normal.clone(),
          increaseB: normal.clone().negate(),
        },
      };
  }

  #edgeEdgeDistance(infoA, infoB) {
    const dirA = normalizeOrNull(infoA.direction);
    const dirB = normalizeOrNull(infoB.direction);
    if (!dirA || !dirB) return null;

    const p1 = infoA.origin.clone();
    const p2 = infoB.origin.clone();
    const r = dirA.clone();
    const s = dirB.clone();
    const w0 = p1.clone().sub(p2);

    const a = r.dot(r);
    const b = r.dot(s);
    const c = s.dot(s);
    const d = r.dot(w0);
    const e = s.dot(w0);
    const denom = a * c - b * b;

    let sc;
    let tc;
    if (Math.abs(denom) < 1e-8) {
      sc = 0;
      tc = (b > c ? d / b : e / c);
    } else {
      sc = (b * e - c * d) / denom;
      tc = (a * e - b * d) / denom;
    }

    const closestA = p1.clone().add(r.clone().multiplyScalar(sc));
    const closestB = p2.clone().add(s.clone().multiplyScalar(tc));
    const sep = closestB.clone().sub(closestA);
    const dist = sep.length();
    const dir = dist > 1e-9 ? sep.clone().divideScalar(dist) : arbitraryPerpendicular(r);

    return {
      distance: dist,
      directions: {
        increaseA: dir.clone().negate(),
        increaseB: dir,
      },
    };
  }

  #faceFaceDistance(infoA, infoB) {
    const normalA = normalizeOrNull(infoA.direction);
    const originA = infoA.origin.clone();
    const originB = infoB.origin.clone();
    if (!normalA) return null;

    const delta = originB.clone().sub(originA);
    let separation = delta.dot(normalA);
    if (!Number.isFinite(separation)) separation = 0;

    const dir = separation >= 0 ? normalA.clone() : normalA.clone().negate();
    const distance = Math.abs(separation);

    return {
      distance,
      directions: {
        increaseA: dir.clone().negate(),
        increaseB: dir,
      },
    };
  }

  #facePointLikeDistance(faceInfo, otherInfo) {
    const normal = normalizeOrNull(faceInfo.direction);
    if (!normal) return null;
    const originFace = faceInfo.origin.clone();
    const originOther = otherInfo.origin.clone();

    const delta = originOther.clone().sub(originFace);
    const separation = delta.dot(normal);
    const distance = Math.abs(separation);
    const dir = separation >= 0 ? normal.clone() : normal.clone().negate();

    return {
      distance,
      directions: {
        increaseA: dir.clone().negate(),
        increaseB: dir,
      },
    };
  }

  #updateNormalDebug(context, infoA, infoB) {
    if (!context?.debugMode) return;
    const scene = context.scene || null;
    if (!scene) return;

    const iteration = context.iteration ?? 0;
    const entries = [
      { info: infoA, color: 0xffa64d, label: 'A' },
      { info: infoB, color: 0x4dc3ff, label: 'B' },
    ];

    for (const { info, color, label } of entries) {
      if (!info?.direction || !info.origin) continue;
      const dir = info.direction.clone().normalize();
      if (dir.lengthSq() === 0) continue;

      const origin = info.origin.clone();
      const length = Math.max(this.#estimateHelperLength(info), 10);
      const arrow = new THREE.ArrowHelper(dir, origin, length, color, length * 0.25, length * 0.15);
      arrow.name = `distance-constraint-normal-${this.inputParams?.constraintID || 'unknown'}-${label}-iter${iteration}`;
      scene.add(arrow);
      this._debugHelpers.push(arrow);
    }
  }

  #clearDebug(scene) {
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
