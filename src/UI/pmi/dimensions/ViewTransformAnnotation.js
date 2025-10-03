// ViewTransformAnnotation.js
// View-specific solid transforms for PMI mode

import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { makeOverlayLine } from '../annUtils.js';

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
  transform: {
    type: 'transform',
    default_value: DEFAULT_TRS,
    label: 'Transform',
    hint: 'Use gizmo or fields to move and rotate the selected solids',
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
      transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      showTraceLine: true,
      __open: true,
      persistentData: { __transformWorld: true },
    };
  }

  static getSchema(pmimode, ann) {
    const solids = normalizeNameArray(ann?.solidNames ?? ann?.solids);
    const baseCenter = getOriginalCenter(ann);
    const transform = normalizeTransform(ann?.transform, baseCenter, ann?.persistentData?.__transformWorld === true);
    ann.transform = transform;
    const showTraceLine = ann?.showTraceLine !== false;

    const schema = {
      solidNames: { ...inputParamsSchema.solidNames, default_value: solids },
      transform: { ...inputParamsSchema.transform, default_value: transform },
      showTraceLine: { ...inputParamsSchema.showTraceLine, default_value: showTraceLine },
    };

    const params = {
      solidNames: solids.slice(),
      transform,
      showTraceLine,
    };

    return { schema, params };
  }

  static applyParams(pmimode, ann, params) {
    if (!ann || typeof ann !== 'object') return { statusText: '' };

    const names = normalizeNameArray(params?.solidNames ?? []);
    ann.solidNames = names.slice();

    const solidKey = makeSolidKey(names);
    if (ann.__solidKey !== solidKey) {
      setNonEnumerable(ann, '__solidKey', solidKey);
      setNonEnumerable(ann, '__transformInitialized', false);
    }

    this._resolveSolidReferences(ann, pmimode);

    const baseCenter = getOriginalCenter(ann);
    const transform = normalizeTransform(params?.transform ?? ann.transform, baseCenter, true);
    ann.transform = transform;
    setNonEnumerable(ann, '__transformInitialized', true);

    ann.showTraceLine = params?.showTraceLine !== false;

    this.applyTransformsToSolids(ann, pmimode);

    const statusText = this.statusText(pmimode, ann);
    return {
      statusText,
      paramsPatch: {
        solidNames: ann.solidNames.slice(),
        transform: { ...ann.transform, position: ann.transform.position.slice(), rotationEuler: ann.transform.rotationEuler.slice(), scale: ann.transform.scale.slice() },
        showTraceLine: ann.showTraceLine,
      },
    };
  }

  static statusText(pmimode, ann) {
    const count = Array.isArray(ann?.solidNames) ? ann.solidNames.length : 0;
    const baseCenter = getOriginalCenter(ann);
    const trs = normalizeTransform(ann?.transform, baseCenter, true);
    const delta = new THREE.Vector3(trs.position[0], trs.position[1], trs.position[2]);
    if (baseCenter) {
      delta.sub(new THREE.Vector3().fromArray(baseCenter));
    }
    const dist = delta.length();
    const pieces = [];
    pieces.push(count === 1 ? '1 solid' : `${count} solids`);
    if (dist > 1e-4) pieces.push(`Δ ${dist.toFixed(dist >= 10 ? 1 : 2)}`);
    return pieces.join(', ');
  }

  static render3D(pmimode, group, ann, idx, ctx) {
    try {
      if (!group || !ann) return;

      const solids = Array.isArray(ann.solids) ? ann.solids : [];
      if (!solids.length) return;

      const origMap = ensureOriginalMap(ann);
      const showTrace = ann.showTraceLine !== false;

      if (showTrace) {
        for (const solid of solids) {
          if (!solid || !solid.isObject3D) continue;
          const orig = origMap.get(solid.uuid);
          if (!orig || !orig.worldPosition) continue;
          const from = new THREE.Vector3().fromArray(orig.worldPosition);
          const to = solid.getWorldPosition(new THREE.Vector3());
          if (from.distanceToSquared(to) < 1e-8) continue;
          const line = makeOverlayLine(from, to, 0x60a5fa);
          if (line) {
            line.renderOrder = 9994;
            group.add(line);
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

  static applyTransformsToSolids(ann, pmimode) {
    const mode = pmimode || ann?.__pmimode || null;
    const solids = Array.isArray(ann?.solids) ? ann.solids : [];
    if (!solids.length) return;

    const origMap = ensureOriginalMap(ann);
    this._ensureOriginalSnapshots(ann, solids);
    const baseCenterArr = getOriginalCenter(ann, solids);
    const transform = normalizeTransform(ann?.transform, baseCenterArr, true);
    ann.transform = transform;
    ann.persistentData = ann.persistentData || {};
    ann.persistentData.__transformWorld = true;

    const targetPos = new THREE.Vector3().fromArray(transform.position);
    const baseCenter = baseCenterArr ? new THREE.Vector3().fromArray(baseCenterArr) : null;
    const offsetPos = baseCenter ? targetPos.clone().sub(baseCenter) : targetPos.clone();

    ann.transform.position = [targetPos.x, targetPos.y, targetPos.z];
    ann.transform.rotationEuler = transform.rotationEuler.slice();
    ann.transform.scale = transform.scale.slice();

    const offsetArray = [offsetPos.x, offsetPos.y, offsetPos.z];
    if (isIdentityTransform({ position: offsetArray, rotationEuler: transform.rotationEuler, scale: transform.scale })) {
      this.restoreOriginalTransforms(ann, mode);
      return;
    }

    const offsetEuler = new THREE.Euler(transform.rotationEuler[0], transform.rotationEuler[1], transform.rotationEuler[2], 'XYZ');
    const offsetQuat = new THREE.Quaternion().setFromEuler(offsetEuler);
    const offsetScale = new THREE.Vector3().fromArray(transform.scale);

    for (const solid of solids) {
      if (!solid || !solid.isObject3D) continue;
      const snapshot = origMap.get(solid.uuid);
      if (!snapshot) continue;

      const basePos = new THREE.Vector3().fromArray(snapshot.position);
      const baseQuat = new THREE.Quaternion().fromArray(snapshot.quaternion);
      const baseScale = new THREE.Vector3().fromArray(snapshot.scale);

      const nextPos = basePos.clone().add(offsetPos);
      const nextQuat = baseQuat.clone().multiply(offsetQuat);
      const nextScale = baseScale.clone().multiply(offsetScale);

      solid.position.copy(nextPos);
      solid.quaternion.copy(nextQuat);
      solid.scale.copy(nextScale);
      solid.updateMatrixWorld(true);
    }

    try { mode?.viewer?.render(); } catch { }
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
      ann.transform = normalizeTransform(ann.transform, baseCenter, true);
      ann.transform.position = baseCenter.slice();
      setNonEnumerable(ann, '__transformInitialized', true);
    }

    try { mode?.viewer?.render(); } catch { }
  }

  static _resolveSolidReferences(ann, pmimode) {
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
    this._ensureOriginalSnapshots(ann, solids, true);

    const baseCenter = getOriginalCenter(ann, solids);
    if (baseCenter) setNonEnumerable(ann, '__baseCenter', baseCenter.slice());

    const usesWorld = ann?.persistentData?.__transformWorld === true;
    if (!ann.__transformInitialized || !Array.isArray(ann.transform?.position)) {
      let normalized = normalizeTransform(ann.transform, baseCenter, usesWorld);
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
    }
    ann.persistentData = ann.persistentData || {};
    ann.persistentData.__transformWorld = true;
  }

  static _ensureOriginalSnapshots(ann, solids, forceCapture = false) {
    const map = ensureOriginalMap(ann);
    for (const solid of solids) {
      if (!solid || !solid.isObject3D) continue;
      if (!forceCapture && map.has(solid.uuid)) continue;

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
    cleanInput.transform = normalizeTransform(cleanInput.transform, null, true);
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
