// ViewTransformAnnotation.js
// View-specific solid transforms for PMI mode

import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { makeOverlayDashedLine } from '../annUtils.js';

const DEFAULT_TRS = Object.freeze({ position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] });

const inputParamsSchema = {
  annotationID: {
    type: 'string',
    default_value: null,
    hint: 'unique identifier for the view transform',
  },
  solidNames: {
    type: 'reference_selection',
    selectionFilter: ['SOLID'],
    multiple: true,
    default_value: [],
    label: 'Solids',
    hint: 'Select solids to reposition in this PMI view',
  },
  transforms: {
    type: 'multi_transform',
    default_value: [],
    label: 'Transforms',
    hint: 'Sequential transforms applied in order to the selected solids',
  },
  showTraceLine: {
    type: 'boolean',
    default_value: true,
    label: 'Show trace lines',
    hint: 'Draw a line from the original position to the transformed position',
  },
};

export class ViewTransformAnnotation extends BaseAnnotation {
  static type = 'viewTransform';
  static title = 'View Transform';
  static featureShortName = 'viewTransform';
  static featureName = 'View Transform';
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    super();
    this.inputParams = {};
    this.persistentData = {};
  }

  async run() {
    // View transforms are applied directly to scene solids; no additional mesh output needed
    return [];
  }

  static create() {
    return {
      type: this.type,
      solidNames: [],
      transforms: [cloneStep(DEFAULT_TRS)],
      showTraceLine: true,
      __open: true,
      persistentData: { __transformWorld: true },
    };
  }

  static getSchema(pmimode, ann) {
    const solids = normalizeNameArray(ann?.solidNames ?? ann?.solids);
    const steps = normalizeStepList(ann?.transforms ?? ann?.steps ?? (ann?.transform ? [ann.transform] : []));
    ann.transforms = steps.map(cloneStep);
    const showTraceLine = ann?.showTraceLine !== false;

    const schema = {
      solidNames: { ...inputParamsSchema.solidNames, default_value: solids },
      transforms: { ...inputParamsSchema.transforms, default_value: steps.map(cloneStep) },
      showTraceLine: { ...inputParamsSchema.showTraceLine, default_value: showTraceLine },
    };

    const params = {
      solidNames: solids.slice(),
      transforms: steps.map(cloneStep),
      showTraceLine,
    };

    return { schema, params };
  }

  static applyParams(pmimode, ann, params) {
    if (!ann || typeof ann !== 'object') return { statusText: '' };

    const names = normalizeNameArray(params?.solidNames ?? []);
    ann.solidNames = names.slice();

    const solidKey = makeSolidKey(names);
    const solidsChanged = ann.__solidKey !== solidKey;
    if (solidsChanged) {
      setNonEnumerable(ann, '__solidKey', solidKey);
      setNonEnumerable(ann, '__transformInitialized', false);
    }

    this._resolveSolidReferences(ann, pmimode, solidsChanged);

    const rawSteps = Array.isArray(params?.transforms) ? params.transforms : ann.transforms;
    let steps = normalizeStepList(rawSteps);
    if (!steps.length) steps = [cloneStep(DEFAULT_TRS)];
    ann.transforms = steps.map(cloneStep);
    ann.transform = cloneStep(ann.transforms[ann.transforms.length - 1]);
    setNonEnumerable(ann, '__transformInitialized', true);

    ann.showTraceLine = params?.showTraceLine !== false;

    if (pmimode && typeof pmimode.applyViewTransformsSequential === 'function') {
      try { pmimode.applyViewTransformsSequential(); }
      catch { this.applyTransformsToSolids(ann, pmimode); }
    } else {
      this.applyTransformsToSolids(ann, pmimode);
    }

    const statusText = this.statusText(pmimode, ann);
    return {
      statusText,
      paramsPatch: {
        solidNames: ann.solidNames.slice(),
        transforms: ann.transforms.map(cloneStep),
        showTraceLine: ann.showTraceLine,
      },
    };
  }

  static statusText(pmimode, ann) {
    const count = Array.isArray(ann?.solidNames) ? ann.solidNames.length : 0;
    const steps = Array.isArray(ann?.transforms) ? ann.transforms : [];
    const traceSets = Array.isArray(ann?.__stepTraces) ? ann.__stepTraces : [];
    let totalDist = 0;
    for (const trace of traceSets) {
      if (!(trace instanceof Map)) continue;
      const first = trace.values().next();
      if (!first || first.done) continue;
      const seg = first.value;
      if (!seg || !Array.isArray(seg.start) || !Array.isArray(seg.end)) continue;
      const a = new THREE.Vector3().fromArray(seg.start);
      const b = new THREE.Vector3().fromArray(seg.end);
      totalDist += a.distanceTo(b);
    }
    const pieces = [];
    pieces.push(count === 1 ? '1 solid' : `${count} solids`);
    pieces.push(steps.length === 1 ? '1 step' : `${steps.length} steps`);
    if (totalDist > 1e-4) pieces.push(`path ${totalDist.toFixed(totalDist >= 10 ? 1 : 2)}`);
    return pieces.join(', ');
  }

  static render3D(pmimode, group, ann, idx, ctx) {
    try {
      if (!group || !ann) return;

      const traceSets = Array.isArray(ann.__stepTraces) ? ann.__stepTraces : [];
      const showTrace = ann.showTraceLine !== false;

      if (showTrace && traceSets.length) {
        const dashSize = ctx.screenSizeWorld ? ctx.screenSizeWorld(16) : 0.1;
        const gapSize = ctx.screenSizeWorld ? ctx.screenSizeWorld(8) : 0.05;
        for (const trace of traceSets) {
          if (!(trace instanceof Map)) continue;
          for (const seg of trace.values()) {
            if (!seg || !Array.isArray(seg.start) || !Array.isArray(seg.end)) continue;
            const from = new THREE.Vector3().fromArray(seg.start);
            const to = new THREE.Vector3().fromArray(seg.end);
            if (from.distanceToSquared(to) < 1e-8) continue;
            const line = makeOverlayDashedLine(from, to, 0x60a5fa, dashSize, gapSize);
            if (line) {
              line.renderOrder = 9994;
              group.add(line);
            }
          }
        }
      }
    } catch { /* ignore draw errors */ }
  }

  static getLabelWorld(pmimode, ann, ctx) {
    try {
      if (ann?.persistentData?.labelWorld) {
        return new THREE.Vector3().fromArray(ann.persistentData.labelWorld);
      }
      const solids = Array.isArray(ann?.solids) ? ann.solids : [];
      if (solids.length > 0 && solids[0]?.isObject3D) {
        return solids[0].getWorldPosition(new THREE.Vector3());
      }
    } catch { /* ignore */ }
    return null;
  }

  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const cam = pmimode?.viewer?.camera;
      if (!cam) return;

      const start = this.getLabelWorld(pmimode, ann, ctx) || new THREE.Vector3();
      const normal = cam.getWorldDirection(new THREE.Vector3()).normalize();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, start.clone());

      const onMove = (ev) => {
        const ray = ctx?.raycastFromEvent ? ctx.raycastFromEvent(ev) : null;
        if (!ray) return;
        const hit = new THREE.Vector3();
        if (ray.intersectPlane(plane, hit)) {
          ann.persistentData = ann.persistentData || {};
          ann.persistentData.labelWorld = [hit.x, hit.y, hit.z];
          try { ctx.updateLabel(idx, null, hit, ann); } catch { }
        }
      };

      const onUp = (ev) => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        try { if (pmimode?.viewer?.controls) pmimode.viewer.controls.enabled = true; } catch { }
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch { }
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      try { if (pmimode?.viewer?.controls) pmimode.viewer.controls.enabled = false; } catch { }
    } catch { /* ignore */ }
  }

  static applyTransformsToSolids(ann, pmimode, options = {}) {
    const mode = pmimode || ann?.__pmimode || null;
    const solids = Array.isArray(ann?.solids) ? ann.solids : [];
    if (!solids.length) {
      setNonEnumerable(ann, '__stepTraces', []);
      return;
    }

    const steps = normalizeStepList(ann?.transforms ?? []);
    if (!steps.length) {
      this.restoreOriginalTransforms(ann, mode);
      return;
    }
    ann.transforms = steps.map(cloneStep);

    ann.persistentData = ann.persistentData || {};
    ann.persistentData.__transformWorld = true;

    const origMap = ensureOriginalMap(ann);
    this._ensureOriginalSnapshots(ann, solids, false);

    const cumulativeState = options.cumulativeState instanceof Map ? options.cumulativeState : null;
    let startSnapshots = cloneSnapshotMap(options.startSnapshots instanceof Map ? options.startSnapshots : null);
    if (!startSnapshots || startSnapshots.size === 0) {
      startSnapshots = new Map();
      for (const solid of solids) {
        if (!solid || !solid.uuid) continue;
        const snap = origMap.get(solid.uuid);
        if (snap) startSnapshots.set(solid.uuid, cloneSnapshot(snap, false));
      }
    }

    const traces = [];
    let snapshotCursor = startSnapshots;

    for (const step of ann.transforms) {
      const { trace, nextState } = this._applyStepToSolids(ann, step, {
        mode,
        solids,
        startSnapshots: snapshotCursor,
        origMap,
        cumulativeState,
      });
      traces.push(trace);
      snapshotCursor = nextState;
    }

    if (ann.transforms.length) {
      ann.transform = cloneStep(ann.transforms[ann.transforms.length - 1]);
      setNonEnumerable(ann, '__transformInitialized', true);
    }

    setNonEnumerable(ann, '__stepTraces', traces);
    try { mode?.viewer?.render(); } catch { }
  }

  static _applyStepToSolids(ann, step, { mode, solids, startSnapshots, origMap, cumulativeState }) {
    const transform = normalizeStep(step);
    step.position = transform.position.slice();
    step.rotationEuler = transform.rotationEuler.slice();
    step.scale = transform.scale.slice();

    const deltaPos = new THREE.Vector3().fromArray(transform.position);
    const deltaEuler = new THREE.Euler(transform.rotationEuler[0], transform.rotationEuler[1], transform.rotationEuler[2], 'XYZ');
    const deltaQuat = new THREE.Quaternion().setFromEuler(deltaEuler);
    const deltaScale = new THREE.Vector3().fromArray(transform.scale);

    const identity = isIdentityTransform({ position: transform.position, rotationEuler: transform.rotationEuler, scale: transform.scale });
    const trace = new Map();
    const nextState = new Map();

    for (const solid of solids) {
      if (!solid || !solid.isObject3D) continue;
      const uuid = solid.uuid;
      const snapshot = startSnapshots.get(uuid) || origMap.get(uuid);
      if (!snapshot) continue;

      const startWorld = snapshot && Array.isArray(snapshot.worldPosition)
        ? new THREE.Vector3().fromArray(snapshot.worldPosition)
        : solid.getWorldPosition(new THREE.Vector3());

      let endWorld = startWorld.clone();

      if (!identity) {
        const basePos = new THREE.Vector3().fromArray(snapshot.position);
        const baseQuat = snapshot.quaternion ? new THREE.Quaternion().fromArray(snapshot.quaternion) : new THREE.Quaternion();
        const baseScale = new THREE.Vector3().fromArray(snapshot.scale || [1, 1, 1]);

        const nextPos = basePos.clone().add(deltaPos);
        const nextQuat = baseQuat.clone().multiply(deltaQuat);
        const nextScale = baseScale.clone().multiply(deltaScale);

        solid.position.copy(nextPos);
        solid.quaternion.copy(nextQuat);
        solid.scale.copy(nextScale);
        solid.updateMatrixWorld(true);

        endWorld = solid.getWorldPosition(new THREE.Vector3());
      }

      trace.set(uuid, {
        start: [startWorld.x, startWorld.y, startWorld.z],
        end: [endWorld.x, endWorld.y, endWorld.z],
      });

      const nextSnapshot = {
        position: [solid.position.x, solid.position.y, solid.position.z],
        quaternion: [solid.quaternion.x, solid.quaternion.y, solid.quaternion.z, solid.quaternion.w],
        scale: [solid.scale.x, solid.scale.y, solid.scale.z],
        worldPosition: [endWorld.x, endWorld.y, endWorld.z],
        __fromCumulative: true,
      };
      nextState.set(uuid, nextSnapshot);
      if (cumulativeState) cumulativeState.set(uuid, cloneSnapshot(nextSnapshot, true));
    }

    return { trace, nextState };
  }

  static restoreOriginalTransforms(ann, pmimode) {
    const mode = pmimode || ann?.__pmimode || null;
    const solids = Array.isArray(ann?.solids) ? ann.solids : [];
    if (!solids.length) return;

    const origMap = ensureOriginalMap(ann);
    for (const solid of solids) {
      if (!solid || !solid.isObject3D) continue;
      const snapshot = origMap.get(solid.uuid);
      if (!snapshot) continue;

      solid.position.set(snapshot.position[0], snapshot.position[1], snapshot.position[2]);
      solid.quaternion.set(snapshot.quaternion[0], snapshot.quaternion[1], snapshot.quaternion[2], snapshot.quaternion[3]);
      solid.scale.set(snapshot.scale[0], snapshot.scale[1], snapshot.scale[2]);
      solid.updateMatrixWorld(true);
    }

    const baseCenter = getOriginalCenter(ann, solids);
    if (baseCenter) {
      const normalized = normalizeTransform(ann.transform || DEFAULT_TRS, baseCenter, true);
      ann.transform = normalized;
      setNonEnumerable(ann, '__transformInitialized', true);
    }

    ann.transforms = normalizeStepList(ann.transforms ?? []);
    setNonEnumerable(ann, '__stepTraces', []);

    try { mode?.viewer?.render(); } catch { }
  }

  static _resolveSolidReferences(ann, pmimode, forceCapture = false) {
    if (!ann || typeof ann !== 'object') return;
    if (pmimode) {
      setNonEnumerable(ann, '__pmimode', pmimode);
    }

    const viewer = pmimode?.viewer || ann?.__pmimode?.viewer || null;
    const scene = viewer?.scene || null;
    const names = normalizeNameArray(ann.solidNames ?? []);

    const solids = [];
    if (scene) {
      for (const name of names) {
        if (!name) continue;
        let obj = scene.getObjectByName?.(name) || null;
        if (obj && obj.type !== 'SOLID') {
          let parent = obj;
          while (parent && parent.type !== 'SOLID') parent = parent.parent;
          if (parent && parent.type === 'SOLID') obj = parent;
        }
        if (obj && obj.type === 'SOLID') {
          solids.push(obj);
        }
      }
    }

    setNonEnumerable(ann, 'solids', solids);
    this._ensureOriginalSnapshots(ann, solids, forceCapture);

    const baseCenter = getOriginalCenter(ann, solids);
    if (baseCenter) setNonEnumerable(ann, '__baseCenter', baseCenter.slice());

    const usesWorld = ann?.persistentData?.__transformWorld === true;
    const lastStep = Array.isArray(ann?.transforms) && ann.transforms.length ? ann.transforms[ann.transforms.length - 1] : DEFAULT_TRS;
    let normalized = normalizeTransform(lastStep, baseCenter, usesWorld);
    if (!usesWorld && baseCenter) {
      const baseVec = new THREE.Vector3().fromArray(baseCenter);
      const offsetVec = new THREE.Vector3().fromArray(normalized.position);
      const worldVec = baseVec.clone().add(offsetVec);
      normalized = {
        position: [worldVec.x, worldVec.y, worldVec.z],
        rotationEuler: normalized.rotationEuler,
        scale: normalized.scale,
      };
    }
    ann.transform = normalized;
    setNonEnumerable(ann, '__transformInitialized', true);
    ann.persistentData = ann.persistentData || {};
    ann.persistentData.__transformWorld = true;
  }

  static _ensureOriginalSnapshots(ann, solids, forceCapture = false) {
    const map = ensureOriginalMap(ann);
    for (const solid of solids) {
      if (!solid || !solid.isObject3D) continue;
      if (!forceCapture && map.has(solid.uuid)) {
        const existing = map.get(solid.uuid);
        if (existing && (!Array.isArray(existing.worldPosition) || existing.worldPosition.length < 3)) {
          const world = solid.getWorldPosition(new THREE.Vector3());
          existing.worldPosition = [world.x, world.y, world.z];
          map.set(solid.uuid, existing);
        }
        continue;
      }

      const world = solid.getWorldPosition(new THREE.Vector3());
      const snapshot = {
        position: [solid.position.x, solid.position.y, solid.position.z],
        quaternion: [solid.quaternion.x, solid.quaternion.y, solid.quaternion.z, solid.quaternion.w],
        scale: [solid.scale.x, solid.scale.y, solid.scale.z],
        worldPosition: [world.x, world.y, world.z],
      };
      map.set(solid.uuid, snapshot);
    }
  }

  static serialize(ann, entry) {
    const out = entry ? { ...entry } : { type: this.type };
    const cleanInput = clonePlainInput(ann);
    cleanInput.solidNames = normalizeNameArray(cleanInput.solidNames ?? []);
    cleanInput.transforms = normalizeStepList(cleanInput.transforms ?? (cleanInput.transform ? [cleanInput.transform] : []));
    delete cleanInput.transform;
    cleanInput.showTraceLine = cleanInput.showTraceLine !== false;
    cleanInput.type = this.type;

    out.type = this.type;
    out.inputParams = cleanInput;
    out.persistentData = clonePersistentData(ann?.persistentData) || {};
    if (ann && Object.prototype.hasOwnProperty.call(ann, '__open')) {
      out.__open = !!ann.__open;
    }
    return out;
}

  static getOriginalSnapshotMap(ann) {
    return ensureOriginalMap(ann);
  }
}

function normalizeTransform(raw, baseCenter, useWorldPosition = true) {
  const hasBase = Array.isArray(baseCenter) && baseCenter.length === 3;
  const base = (raw && typeof raw === 'object') ? raw : {};
  let position;
  if (base.position != null) {
    position = toArray3(base.position, 0);
  } else if (useWorldPosition && hasBase) {
    position = baseCenter.slice();
  } else {
    position = [0, 0, 0];
  }
  const rotationEuler = toArray3(base.rotationEuler, 0);
  const scale = toArray3(base.scale, 1);
  return { position, rotationEuler, scale };
}

function computeCenterFromSnapshots(startSnapshots, solids, origMap) {
  const accum = new THREE.Vector3();
  let count = 0;
  if (startSnapshots instanceof Map) {
    for (const snapshot of startSnapshots.values()) {
      if (!snapshot || !Array.isArray(snapshot.worldPosition)) continue;
      accum.x += snapshot.worldPosition[0];
      accum.y += snapshot.worldPosition[1];
      accum.z += snapshot.worldPosition[2];
      count++;
    }
  }

  if (count === 0 && origMap) {
    for (const solid of solids) {
      const snap = origMap.get(solid.uuid);
      if (!snap || !Array.isArray(snap.worldPosition)) continue;
      accum.x += snap.worldPosition[0];
      accum.y += snap.worldPosition[1];
      accum.z += snap.worldPosition[2];
      count++;
    }
  }

  if (count === 0) return null;
  accum.multiplyScalar(1 / count);
  return [accum.x, accum.y, accum.z];
}

function cloneSnapshot(snapshot, fromCumulative = false) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const clone = {
    position: Array.isArray(snapshot.position) ? snapshot.position.slice() : [0, 0, 0],
    quaternion: Array.isArray(snapshot.quaternion) ? snapshot.quaternion.slice() : [0, 0, 0, 1],
    scale: Array.isArray(snapshot.scale) ? snapshot.scale.slice() : [1, 1, 1],
    worldPosition: Array.isArray(snapshot.worldPosition) ? snapshot.worldPosition.slice() : null,
  };
  if (!clone.worldPosition && Array.isArray(snapshot.position)) {
    clone.worldPosition = snapshot.position.slice();
  }
  if (fromCumulative || snapshot.__fromCumulative) clone.__fromCumulative = true;
  return clone;
}

function cloneSnapshotMap(map) {
  if (!(map instanceof Map)) return null;
  const out = new Map();
  for (const [key, snap] of map.entries()) {
    const cloned = cloneSnapshot(snap, snap?.__fromCumulative);
    if (cloned) out.set(key, cloned);
  }
  return out;
}

function normalizeStepList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((step) => normalizeStep(step));
}

function normalizeStep(step) {
  if (!step || typeof step !== 'object') step = DEFAULT_TRS;
  return {
    position: toArray3(step.position, 0),
    rotationEuler: toArray3(step.rotationEuler, 0),
    scale: toArray3(step.scale, 1),
    id: step.id,
  };
}

function cloneStep(step) {
  const normalized = normalizeStep(step);
  const ensureId = normalized.id || `mt-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: ensureId,
    position: normalized.position.slice(),
    rotationEuler: normalized.rotationEuler.slice(),
    scale: normalized.scale.slice(),
  };
}

function isIdentityTransform(trs) {
  if (!trs) return true;
  const eps = 1e-6;
  const pos = trs.position || [];
  const rot = trs.rotationEuler || [];
  const scl = trs.scale || [];
  const posZero = Math.abs(pos[0] || 0) < eps && Math.abs(pos[1] || 0) < eps && Math.abs(pos[2] || 0) < eps;
  const rotZero = Math.abs(rot[0] || 0) < eps && Math.abs(rot[1] || 0) < eps && Math.abs(rot[2] || 0) < eps;
  const scaleOne = Math.abs((scl[0] || 1) - 1) < eps && Math.abs((scl[1] || 1) - 1) < eps && Math.abs((scl[2] || 1) - 1) < eps;
  return posZero && rotZero && scaleOne;
}

function toArray3(value, fallback) {
  if (Array.isArray(value)) {
    return [toNumber(value[0], fallback), toNumber(value[1], fallback), toNumber(value[2], fallback)];
  }
  if (value && typeof value === 'object') {
    return [toNumber(value.x ?? value[0], fallback), toNumber(value.y ?? value[1], fallback), toNumber(value.z ?? value[2], fallback)];
  }
  if (typeof value === 'number') {
    const n = toNumber(value, fallback);
    return [n, n, n];
  }
  return [fallback, fallback, fallback];
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeNameArray(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const result = [];
  const seen = new Set();
  for (const item of arr) {
    if (item == null) continue;
    const txt = String(item).trim();
    if (!txt || seen.has(txt)) continue;
    seen.add(txt);
    result.push(txt);
  }
  return result;
}

function makeSolidKey(names) {
  if (!Array.isArray(names) || !names.length) return '';
  return names.map((n) => String(n).trim()).filter(Boolean).sort().join('||');
}

function getOriginalCenter(ann, solidsOverride) {
  if (!ann) return null;
  const accum = new THREE.Vector3(0, 0, 0);
  let count = 0;

  const map = ann.originalTransforms instanceof Map ? ann.originalTransforms : null;
  if (map && map.size) {
    for (const snapshot of map.values()) {
      const wp = snapshot?.worldPosition;
      if (!Array.isArray(wp) || wp.length < 3) continue;
      accum.x += wp[0];
      accum.y += wp[1];
      accum.z += wp[2];
      count++;
    }
  }

  const solids = Array.isArray(solidsOverride) ? solidsOverride : (Array.isArray(ann?.solids) ? ann.solids : null);
  if (count === 0 && solids) {
    for (const solid of solids) {
      if (!solid || !solid.isObject3D) continue;
      const pos = solid.getWorldPosition(new THREE.Vector3());
      accum.add(pos);
      count++;
    }
  }

  if (count === 0) {
    const stored = ann?.__baseCenter;
    if (Array.isArray(stored) && stored.length === 3) return stored.slice();
    return null;
  }

  accum.multiplyScalar(1 / count);
  return [accum.x, accum.y, accum.z];
}

function ensureOriginalMap(ann) {
  if (!ann) return new Map();
  const existing = ann.originalTransforms;
  if (existing instanceof Map) return existing;
  if (existing && typeof existing === 'object') {
    const map = new Map();
    for (const key of Object.keys(existing)) {
      map.set(key, existing[key]);
    }
    setNonEnumerable(ann, 'originalTransforms', map);
    return map;
  }
  const map = new Map();
  setNonEnumerable(ann, 'originalTransforms', map);
  return map;
}

function setNonEnumerable(target, key, value) {
  if (!target) return;
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (!desc) {
    Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
  } else if (desc.writable) {
    target[key] = value;
  } else {
    Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
  }
}

function clonePlainInput(src) {
  if (!src || typeof src !== 'object') return {};
  const out = {};
  for (const key of Object.keys(src)) {
    if (key === 'persistentData' || key === '__entryRef' || key === '__open') continue;
    out[key] = cloneValue(src[key]);
  }
  return out;
}

function clonePersistentData(src) {
  if (!src || typeof src !== 'object') return null;
  return cloneValue(src);
}

function cloneValue(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value instanceof THREE.Vector3) return value.clone();
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
    return out;
  }
  return value;
}
