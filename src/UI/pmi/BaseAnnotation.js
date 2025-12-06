// BaseAnnotation.js
// Base class for all PMI annotations built on the shared list entity foundation.

import * as THREE from 'three';
import { ListEntityBase } from '../../core/entities/ListEntityBase.js';

export class BaseAnnotation extends ListEntityBase {
  static entityType = 'annotation';
  static shortName = 'ANN';
  static longName = 'Annotation';
  static inputParamsSchema = {}; 

  constructor(opts = {}) {
    super({ history: opts.history || null, registry: opts.registry || null });
    this.resultArtifacts = [];
  }

  async run(renderingContext) {
    // Base implementation - subclasses should override
    // renderingContext contains: { pmimode, group, idx, ctx }
    console.warn(`BaseAnnotation.run() not implemented for ${this.constructor.name}`);
    return [];
  }

  // Helper methods that annotations can use
  getScene() {
    const partHistory = this.renderingContext?.pmimode?.viewer?.partHistory;
    return partHistory?.scene || null;
  }

  getObjectByName(name) {
    const scene = this.getScene();
    return scene ? scene.getObjectByName(name) : null;
  }

  // Schema helpers mirror feature engine: schema drives UI, no extra per-ann plumbing
  static getSchema(pmimode, ann) {
    const schema = {};
    const params = {};
    const input = ann || {};

    for (const key in this.inputParamsSchema) {
      if (!Object.prototype.hasOwnProperty.call(this.inputParamsSchema, key)) continue;
      const def = this.inputParamsSchema[key] || {};
      const clonedDef = { ...def };
      const currentValue = Object.prototype.hasOwnProperty.call(input, key)
        ? __cloneValue(input[key])
        : __cloneValue(def.default_value);
      if (clonedDef && Object.prototype.hasOwnProperty.call(clonedDef, 'default_value')) {
        clonedDef.default_value = __cloneValue(currentValue);
      }
      schema[key] = clonedDef;
      params[key] = currentValue;
    }

    return { schema, params };
  }

  static applyParams(pmimode, ann, params) {
    const sanitized = sanitizeAnnotationParams(this.inputParamsSchema, params, ann);
    Object.assign(ann, sanitized);
    return { paramsPatch: {} };
  }

  static ensurePersistentData(ann) {
    if (!ann || typeof ann !== 'object') return null;
    if (!ann.persistentData || typeof ann.persistentData !== 'object') {
      ann.persistentData = {};
    }
    return ann.persistentData;
  }

  /**
   * Shared label-drag helper. Creates a drag plane and wires pointer events so subclasses only
   * need to provide the plane and what to do on drag.
   */
  static dragLabelOnPlane(pmimode, ctx, options = {}) {
    if (!ctx || typeof options.makePlane !== 'function') return;
    const plane = options.makePlane();
    if (!plane || (!(plane instanceof THREE.Plane) && !plane.isPlane)) return;
    const target = options.eventTarget || window;
    const viewer = pmimode?.viewer;

    const onMove = (ev) => {
      const ray = ctx.raycastFromEvent ? ctx.raycastFromEvent(ev) : null;
      if (!ray) return;
      const hit = new THREE.Vector3();
      const intersected = ctx.intersectPlane
        ? ctx.intersectPlane(ray, plane, hit)
        : ray.intersectPlane(plane, hit);
      if (!intersected) return;
      if (typeof options.onDrag === 'function') {
        options.onDrag(hit, ev, plane);
      }
    };

    const onUp = (ev) => {
      try { target.removeEventListener('pointermove', onMove, true); } catch { }
      try { target.removeEventListener('pointerup', onUp, true); } catch { }
      if (options.suspendControls === true) {
        try { if (viewer?.controls) viewer.controls.enabled = true; } catch { }
      }
      try { pmimode?.hideDragPlaneHelper?.(); } catch { }
      if (typeof options.onEnd === 'function') {
        try { options.onEnd(ev); } catch { /* ignore */ }
      }
      if (options.preventDefault !== false) {
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch { }
      }
    };

    try { pmimode?.showDragPlaneHelper?.(plane); } catch { }
    if (options.suspendControls === true) {
      try { if (viewer?.controls) viewer.controls.enabled = false; } catch { }
    }

    try { target.addEventListener('pointermove', onMove, true); } catch { }
    try { target.addEventListener('pointerup', onUp, true); } catch { }
  }

  onIdChanged() {
    if (!this.inputParams || typeof this.inputParams !== 'object') {
      this.inputParams = {};
    }
    this.inputParams.id = this.id;
  }

  onParamsChanged() {
    if (!this.inputParams || typeof this.inputParams !== 'object') {
      this.inputParams = {};
    }
    if (!this.inputParams.id) {
      this.inputParams.id = this.id;
    }
    if (!this.inputParams.type) {
      this.inputParams.type = this.type || this.entityType || 'annotation';
    }
  }

  onPersistentDataChanged() {
    // Ensure persistentData is always an object for UI bindings
    if (!this.persistentData || typeof this.persistentData !== 'object') {
      this.persistentData = {};
    }
  }
}

function sanitizeAnnotationParams(schema, rawParams, ann) {
  const sanitized = {};
  const params = rawParams && typeof rawParams === 'object' ? rawParams : {};

  for (const key in schema) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) continue;
    const def = schema[key] || {};
    if (def.readOnly) {
      // Preserve existing read-only values or fall back to defaults
      if (ann && Object.prototype.hasOwnProperty.call(ann, key)) {
        sanitized[key] = ann[key];
      } else {
        sanitized[key] = __cloneValue(def.default_value);
      }
      continue;
    }
    const value = params[key];
    const hasExisting = ann && Object.prototype.hasOwnProperty.call(ann, key);
    if (value === undefined) {
      sanitized[key] = hasExisting ? __cloneValue(ann[key]) : __cloneValue(def.default_value);
      continue;
    }
    switch (def.type) {
      case 'number': {
        const num = Number(value);
        sanitized[key] = Number.isFinite(num)
          ? num
          : (hasExisting && Number.isFinite(ann[key]) ? Number(ann[key])
            : (Number.isFinite(def.default_value) ? def.default_value : 0));
        break;
      }
      case 'boolean':
        sanitized[key] = value === 'false' ? false : Boolean(value);
        break;
      case 'options': {
        const opts = Array.isArray(def.options) ? def.options : [];
        const asString = value == null ? '' : String(value);
        if (opts.includes(asString)) {
          sanitized[key] = asString;
        } else if (hasExisting && opts.includes(ann[key])) {
          sanitized[key] = ann[key];
        } else {
          sanitized[key] = opts.includes(def.default_value) ? def.default_value : (opts[0] || '');
        }
        break;
      }
      case 'reference_selection': {
        if (def.multiple) {
          const arr = Array.isArray(value) ? value : (value ? [value] : []);
          sanitized[key] = arr.map((v) => (v == null ? '' : String(v))).filter((s) => s.length);
          if (!sanitized[key].length && hasExisting && Array.isArray(ann[key])) {
            sanitized[key] = ann[key].slice();
          }
        } else {
          sanitized[key] = value == null ? (hasExisting ? String(ann[key] ?? '') : '') : String(value);
        }
        break;
      }
      case 'textarea':
      case 'string':
        sanitized[key] = value == null ? (hasExisting ? String(ann[key] ?? '') : '') : String(value);
        break;
      case 'object':
        sanitized[key] = (value && typeof value === 'object') ? __cloneValue(value) : __cloneValue(def.default_value);
        break;
      case 'transform':
        sanitized[key] = normalizeTransform(value, def.default_value);
        break;
      case 'vec3':
        sanitized[key] = normalizeVec3(value, def.default_value);
        break;
      default:
        sanitized[key] = __cloneValue(value);
        break;
    }
  }

  return sanitized;
}

function normalizeTransform(value, fallback) {
  const raw = value && typeof value === 'object' ? value : (fallback || {});
  const toArray = (src, defaults, len = 3) => {
    const arr = Array.isArray(src) ? src : (defaults && Array.isArray(defaults) ? defaults : []);
    const out = [];
    for (let i = 0; i < len; i += 1) {
      const v = arr[i];
      const n = Number(v);
      out[i] = Number.isFinite(n) ? n : 0;
    }
    return out;
  };
  return {
    position: toArray(raw.position, fallback?.position || [0, 0, 0]),
    rotationEuler: toArray(raw.rotationEuler, fallback?.rotationEuler || [0, 0, 0]),
    scale: toArray(raw.scale, fallback?.scale || [1, 1, 1]),
  };
}

function normalizeVec3(value, fallback) {
  const source = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' ? [value.x, value.y, value.z] : fallback);
  if (!Array.isArray(source)) return [0, 0, 0];
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const n = Number(source[i]);
    out[i] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

function __cloneValue(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => __cloneValue(v));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = __cloneValue(value[k]);
    return out;
  }
  return value;
}
