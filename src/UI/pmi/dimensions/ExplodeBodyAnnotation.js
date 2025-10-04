// ViewTransformAnnotation.js
// View-specific solid transforms for PMI mode

import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { makeOverlayDashedLine, objectRepresentativePoint } from '../annUtils.js';


const inputParamsSchema = {
  annotationID: {
    type: 'string',
    default_value: null,
    hint: 'unique identifier for the view transform',
  },
  targets: {
    type: 'reference_selection',
    multiple: true,
    default_value: [],
    label: 'Target Objects',
    selectionFilter: ['SOLID'],
    hint: 'Choose the solids to reposition in this view',
  },
  transform: {
    type: 'transform',
    label: 'Transform',
    hint: 'Translation and rotation applied relative to the reference point',
  },
  showTraceLine: {
    type: 'boolean',
    default_value: true,
    label: 'Show trace lines',
    hint: 'Draw a line from the original position to the transformed position',
  },
};

export class ExplodeBodyAnnotation extends BaseAnnotation {
  static type = 'explodeBody';
  static title = 'Explode Body';
  static featureShortName = 'explodeBody';
  static featureName = 'Explode Body';
  static inputParamsSchema = inputParamsSchema;
  static aliases = ['viewTransform'];

  constructor() {
    super();
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(renderingContext) {
    const { pmimode, group } = renderingContext;
    if (!pmimode || !group) return [];

    const ann = this.inputParams || {};
    ensurePersistent(ann);
    ann.transform = sanitizeTransform(ann.transform);

    const solids = ExplodeBodyAnnotation._resolveSolidReferences(ann, pmimode, true);
    if (!solids.length) return [];

    const snapshots = ExplodeBodyAnnotation._ensureOriginalSnapshots(ann, solids, false, pmimode?.viewer);
    if (ann.showTraceLine === false) return [];

    solids.forEach((solid) => {
      try {
        const snap = snapshots.get(solid.uuid);
        let start = vectorFromArray(snap?.centerWorld)
          || (pmimode ? objectRepresentativePoint(pmimode.viewer, solid, snap) : null)
          || vectorFromArray(snap?.worldPosition)
          || vectorFromArray(snap?.position);
        if (!start) return;
        const end = objectRepresentativePoint(pmimode.viewer, solid)
          || solid.getWorldPosition(new THREE.Vector3());
        if (!end) return;
        if (start.distanceToSquared(end) < 1e-8) return;
        group.add(makeOverlayDashedLine(start, end, 0xf5a524));
      } catch {
        /* ignore trace failures */
      }
    });

    return [];
  }

  static _resolveSolidReferences(ann, pmimode, refresh = false) {
    if (!ann || !pmimode) return [];
    const viewer = pmimode.viewer;
    const scene = viewer?.partHistory?.scene || viewer?.scene;
    if (!scene) return [];

    if (!refresh && Array.isArray(ann.__resolvedSolids) && ann.__resolvedSolids.length) {
      const filtered = ann.__resolvedSolids.filter((obj) => obj && obj.isObject3D);
      setHiddenProperty(ann, '__resolvedSolids', filtered);
      setHiddenProperty(ann, 'solids', filtered);
      return filtered;
    }

    const refs = Array.isArray(ann.targets) ? ann.targets : [];
    const out = [];
    refs.forEach((ref) => {
      const obj = resolveSolidObject(ref, scene);
      if (obj && obj.isObject3D) out.push(obj);
    });
    setHiddenProperty(ann, '__resolvedSolids', out);
    setHiddenProperty(ann, 'solids', out);
    return out;
  }

  static _ensureOriginalSnapshots(ann, solids, forceRefresh = false) {
    ensurePersistent(ann);
    let map = ann.__originalSnapshots;
    if (!(map instanceof Map)) {
      map = snapshotArrayToMap(ann.persistentData?.originalTransforms);
    }
    if (!(map instanceof Map)) map = new Map();

    const list = Array.isArray(solids) ? solids : [];
    list.forEach((solid) => {
      if (!solid || !solid.uuid) return;
      if (forceRefresh || !map.has(solid.uuid)) {
        map.set(solid.uuid, captureSnapshot(solid));
      }
    });

    setHiddenProperty(ann, '__originalSnapshots', map);
    ann.persistentData.originalTransforms = snapshotMapToArray(map);
    return map;
  }

  static getOriginalSnapshotMap(ann) {
    if (!ann) return new Map();
    if (ann.__originalSnapshots instanceof Map) return ann.__originalSnapshots;
    const map = snapshotArrayToMap(ann?.persistentData?.originalTransforms);
    setHiddenProperty(ann, '__originalSnapshots', map instanceof Map ? map : new Map());
    return ann.__originalSnapshots;
  }

  static applyTransformsToSolids(ann, pmimode, options = {}) {
    if (!ann || !pmimode) return;
    const solids = ExplodeBodyAnnotation._resolveSolidReferences(ann, pmimode, true);
    if (!solids.length) return;

    const startSnapshots = (options && options.startSnapshots instanceof Map)
      ? options.startSnapshots
      : ExplodeBodyAnnotation.getOriginalSnapshotMap(ann);
    const cumulativeState = options?.cumulativeState instanceof Map ? options.cumulativeState : null;

    const delta = sanitizeTransform(ann.transform);
    ann.transform = delta;
    const deltaPos = vectorFromArray(delta.position, new THREE.Vector3(0, 0, 0));
    const deltaQuat = quaternionFromEuler(delta.rotationEuler);
    const deltaScale = vectorFromArray(delta.scale, new THREE.Vector3(1, 1, 1));

    solids.forEach((solid) => {
      if (!solid || !solid.uuid) return;
      const snap = startSnapshots.get(solid.uuid)
        || ExplodeBodyAnnotation.getOriginalSnapshotMap(ann).get(solid.uuid)
        || captureSnapshot(solid);
      if (!snap) return;

      const basePos = vectorFromArray(snap.position, new THREE.Vector3(0, 0, 0));
      const baseQuat = quaternionFromArray(snap.quaternion, new THREE.Quaternion());
      const baseScale = vectorFromArray(snap.scale, new THREE.Vector3(1, 1, 1));

      const finalPos = basePos.clone().add(deltaPos);
      const finalQuat = baseQuat.clone().multiply(deltaQuat);
      const finalScale = baseScale.clone().multiply(deltaScale);

      solid.position.copy(finalPos);
      solid.quaternion.copy(finalQuat);
      solid.scale.copy(finalScale);
      solid.updateMatrixWorld(true);

      if (cumulativeState) {
        const wp = solid.getWorldPosition(new THREE.Vector3());
        cumulativeState.set(solid.uuid, {
          position: finalPos.toArray(),
          quaternion: finalQuat.toArray(),
          scale: finalScale.toArray(),
          worldPosition: wp.toArray(),
        });
      }
    });
  }

  static restoreOriginalTransforms(ann, pmimode) {
    if (!ann || !pmimode) return;
    const solids = ExplodeBodyAnnotation._resolveSolidReferences(ann, pmimode, true);
    if (!solids.length) return;
    const originals = ExplodeBodyAnnotation.getOriginalSnapshotMap(ann);

    solids.forEach((solid) => {
      if (!solid || !solid.uuid) return;
      const snap = originals.get(solid.uuid);
      if (!snap) return;
      const pos = vectorFromArray(snap.position, new THREE.Vector3(0, 0, 0));
      const quat = quaternionFromArray(snap.quaternion, new THREE.Quaternion());
      const scale = vectorFromArray(snap.scale, new THREE.Vector3(1, 1, 1));
      solid.position.copy(pos);
      solid.quaternion.copy(quat);
      solid.scale.copy(scale);
      solid.updateMatrixWorld(true);
    });
  }

  static applyParams(pmimode, ann, params) {
    super.applyParams(pmimode, ann, params);
    ann.targets = arrayOfStrings(ann.targets);
    ann.transform = sanitizeTransform(ann.transform);
    ann.showTraceLine = ann.showTraceLine === false ? false : true;
    try {
      if (pmimode && typeof pmimode.applyViewTransformsSequential === 'function') {
        pmimode.applyViewTransformsSequential();
      }
    } catch { }
    return { paramsPatch: {} };
  }
}

function ensurePersistent(ann) {
  if (!ann.persistentData || typeof ann.persistentData !== 'object') {
    ann.persistentData = {};
  }
}

function setHiddenProperty(obj, key, value) {
  if (!obj || typeof obj !== 'object') return;
  try {
    Object.defineProperty(obj, key, {
      value,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch {
    obj[key] = value;
  }
}

function sanitizeTransform(value) {
  const obj = (value && typeof value === 'object') ? value : {};
  const sanitizeArray = (arr, fallback) => {
    if (!Array.isArray(arr)) return fallback.slice();
    const out = fallback.slice();
    for (let i = 0; i < out.length; i += 1) {
      const num = Number(arr[i]);
      out[i] = Number.isFinite(num) ? num : out[i];
    }
    return out;
  };
  return {
    position: sanitizeArray(obj.position, [0, 0, 0]),
    rotationEuler: sanitizeArray(obj.rotationEuler, [0, 0, 0]),
    scale: sanitizeArray(obj.scale, [1, 1, 1]),
  };
}

function arrayOfStrings(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter((s) => s.length);
}

function resolveSolidObject(ref, scene) {
  if (!scene) return null;
  if (!ref && ref !== 0) return null;
  let info = null;
  if (typeof ref === 'string' && ref.trim().length) {
    const trimmed = ref.trim();
    if (trimmed[0] === '{') {
      try { info = JSON.parse(trimmed); }
      catch { info = { name: trimmed }; }
    } else {
      info = { name: trimmed };
    }
  } else if (typeof ref === 'object') {
    info = { ...ref };
  }
  if (!info) return null;

  const tryNames = [];
  if (info.name && typeof info.name === 'string') tryNames.push(info.name.trim());
  if (Array.isArray(info.path) && info.path.length) {
    tryNames.push(String(info.path[info.path.length - 1]));
  }

  for (const name of tryNames) {
    if (!name) continue;
    const found = scene.getObjectByName(name);
    if (found && found.type === 'SOLID') return found;
    if (found) return found;
  }

  if (typeof info.uuid === 'string') {
    const obj = scene.getObjectByProperty('uuid', info.uuid);
    if (obj) return obj;
  }

  if (Number.isInteger(info.id)) {
    try {
      const obj = scene.getObjectById(info.id);
      if (obj) return obj;
    } catch {
      /* ignore */
    }
  }

  return null;
}

function captureSnapshot(object) {
  try { object.updateMatrixWorld(true); } catch { }
  const pos = object.position.clone();
  const quat = object.quaternion.clone();
  const scale = object.scale.clone();
  const world = object.getWorldPosition(new THREE.Vector3());
  return {
    position: pos.toArray(),
    quaternion: quat.toArray(),
    scale: scale.toArray(),
    worldPosition: world.toArray(),
  };
}

function snapshotArrayToMap(arr) {
  if (!Array.isArray(arr)) return new Map();
  const map = new Map();
  arr.forEach((item) => {
    if (!item || typeof item !== 'object' || !item.uuid) return;
    map.set(item.uuid, {
      position: toArray(item.position, [0, 0, 0]),
      quaternion: toArray(item.quaternion, [0, 0, 0, 1]),
      scale: toArray(item.scale, [1, 1, 1]),
      worldPosition: toArray(item.worldPosition, null),
    });
  });
  return map;
}

function snapshotMapToArray(map) {
  if (!(map instanceof Map)) return [];
  const arr = [];
  map.forEach((value, key) => {
    if (!key) return;
    arr.push({
      uuid: key,
      position: toArray(value.position, [0, 0, 0]),
      quaternion: toArray(value.quaternion, [0, 0, 0, 1]),
      scale: toArray(value.scale, [1, 1, 1]),
      worldPosition: toArray(value.worldPosition, null),
    });
  });
  return arr;
}

function toArray(src, fallback) {
  if (Array.isArray(src)) return src.slice();
  if (src && typeof src === 'object' && typeof src.length === 'number') {
    const out = [];
    for (let i = 0; i < src.length; i += 1) out.push(Number(src[i]));
    return out;
  }
  if (src && typeof src.x === 'number' && typeof src.y === 'number' && typeof src.z === 'number') {
    if (typeof src.w === 'number') return [src.x, src.y, src.z, src.w];
    return [src.x, src.y, src.z];
  }
  return fallback ? fallback.slice() : fallback;
}

function vectorFromArray(arr, fallbackVector) {
  if (Array.isArray(arr) && arr.length >= 3) {
    const x = Number(arr[0]);
    const y = Number(arr[1]);
    const z = Number(arr[2]);
    if ([x, y, z].every((n) => Number.isFinite(n))) return new THREE.Vector3(x, y, z);
  }
  if (arr && typeof arr === 'object' && Number.isFinite(arr.x) && Number.isFinite(arr.y) && Number.isFinite(arr.z)) {
    return new THREE.Vector3(arr.x, arr.y, arr.z);
  }
  if (fallbackVector && fallbackVector.isVector3) return fallbackVector.clone();
  return new THREE.Vector3();
}

function quaternionFromArray(arr, fallbackQuat) {
  if (Array.isArray(arr) && arr.length >= 4) {
    const x = Number(arr[0]);
    const y = Number(arr[1]);
    const z = Number(arr[2]);
    const w = Number(arr[3]);
    if ([x, y, z, w].every((n) => Number.isFinite(n))) return new THREE.Quaternion(x, y, z, w);
  }
  if (arr && typeof arr === 'object' && Number.isFinite(arr.x) && Number.isFinite(arr.y)
    && Number.isFinite(arr.z) && Number.isFinite(arr.w)) {
    return new THREE.Quaternion(arr.x, arr.y, arr.z, arr.w);
  }
  if (fallbackQuat && fallbackQuat.isQuaternion) return fallbackQuat.clone();
  return new THREE.Quaternion();
}

function quaternionFromEuler(eulerArray) {
  const euler = Array.isArray(eulerArray) ? eulerArray : [0, 0, 0];
  const x = Number(euler[0]) || 0;
  const y = Number(euler[1]) || 0;
  const z = Number(euler[2]) || 0;
  try {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
  } catch {
    return new THREE.Quaternion();
  }
}
