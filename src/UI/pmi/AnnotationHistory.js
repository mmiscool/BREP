import { annotationRegistry } from './AnnotationRegistry.js';

function deepClone(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(deepClone);
  if (typeof value === 'object') {
    const out = {};
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      out[key] = deepClone(value[key]);
    }
    return out;
  }
  return value;
}

function normalizeTypeString(type) {
  if (!type && type !== 0) return '';
  return String(type).trim();
}

const RESERVED_INPUT_KEYS = new Set(['type', 'persistentData', '__open', '__legacy']);

export class AnnotationHistory {
  constructor(pmimode = null) {
    this.pmimode = pmimode;
    this.annotations = [];
    this.idCounter = 0;
  }

  setPMIMode(pmimode) {
    this.pmimode = pmimode;
  }

  load(serializedAnnotations) {
    this.annotations = [];
    if (!Array.isArray(serializedAnnotations)) {
      this.idCounter = 0;
      return;
    }
    for (const raw of serializedAnnotations) {
      const entry = this.#normalizeEntry(raw);
      this.annotations.push(entry);
    }
    this.#recalculateIdCounter();
  }

  toSerializable() {
    return this.annotations.map((entry) => this.#serializeEntry(entry));
  }

  get size() {
    return this.annotations.length;
  }

  getEntries() {
    return this.annotations.slice();
  }

  getEntry(index) {
    if (index < 0 || index >= this.annotations.length) return null;
    return this.annotations[index];
  }

  getAnnotationForUI(index) {
    const entry = this.getEntry(index);
    if (!entry) return null;
    return this.#wrapLegacy(entry);
  }

  getAnnotationsForUI() {
    return this.annotations.map((entry) => this.#wrapLegacy(entry));
  }

  findEntries(predicate) {
    if (typeof predicate !== 'function') return [];
    const result = [];
    for (let i = 0; i < this.annotations.length; i++) {
      const entry = this.annotations[i];
      if (predicate(entry, i)) {
        result.push(entry);
      }
    }
    return result;
  }

  createAnnotation(type, initialData = null) {
    const handler = this.#resolveHandler(type);
    const schemaDefaults = this.#defaultsFromSchema(handler, this.pmimode);
    let defaults = { ...schemaDefaults };
    try {
      if (initialData && typeof initialData === 'object') {
        defaults = { ...defaults, ...deepClone(initialData) };
      } else if (handler && typeof handler.create === 'function') {
        const created = handler.create(this.pmimode) || {};
        defaults = { ...defaults, ...created };
      }
    } catch {
      defaults = { ...schemaDefaults };
    }

    const normalizedType = normalizeTypeString(defaults.type || type || (handler && handler.type));
    const entry = this.#normalizeEntry({
      type: normalizedType,
      inputParams: defaults,
      persistentData: defaults?.persistentData,
      __open: defaults?.__open,
    });

    entry.__open = true;

    if (!entry.inputParams.annotationID) {
      entry.inputParams.annotationID = this.generateId(normalizedType || 'ANN');
    }

    this.annotations.push(entry);
    return this.#wrapLegacy(entry);
  }

  removeAt(index) {
    if (index < 0 || index >= this.annotations.length) return null;
    const [entry] = this.annotations.splice(index, 1);
    if (entry) {
      delete entry.__legacy;
    }
    return entry;
  }

  moveUp(index) {
    if (index <= 0 || index >= this.annotations.length) return false;
    const [entry] = this.annotations.splice(index, 1);
    this.annotations.splice(index - 1, 0, entry);
    return true;
  }

  moveDown(index) {
    if (index < 0 || index >= this.annotations.length - 1) return false;
    const [entry] = this.annotations.splice(index, 1);
    this.annotations.splice(index + 1, 0, entry);
    return true;
  }

  clear() {
    for (const entry of this.annotations) {
      delete entry.__legacy;
    }
    this.annotations = [];
    this.idCounter = 0;
  }

  generateId(typeHint = 'ANN') {
    const prefix = normalizeTypeString(typeHint).replace(/[^a-z0-9]/gi, '').toUpperCase() || 'ANN';
    this.idCounter += 1;
    return `${prefix}${this.idCounter}`;
  }

  #resolveHandler(type) {
    if (!type && type !== 0) return null;
    let handler = null;
    try {
      if (typeof annotationRegistry.getSafe === 'function') {
        handler = annotationRegistry.getSafe(type);
      }
    } catch { handler = null; }

    if (!handler && typeof annotationRegistry.get === 'function') {
      try { handler = annotationRegistry.get(type); }
      catch { handler = null; }
    }

    return handler || null;
  }

  #normalizeEntry(raw) {
    const fallbackType = 'annotation';
    if (!raw || typeof raw !== 'object') {
      return {
        type: fallbackType,
        inputParams: {},
        persistentData: {},
        __open: false,
      };
    }

    const type = normalizeTypeString(raw.type || raw.inputParams?.type || fallbackType);

    let inputParams;
    if (raw.inputParams && typeof raw.inputParams === 'object') {
      inputParams = this.#cloneWithoutReserved(raw.inputParams);
    } else {
      inputParams = this.#cloneWithoutReserved(raw);
    }

    let persistentData = {};
    if (raw.persistentData && typeof raw.persistentData === 'object') {
      persistentData = deepClone(raw.persistentData);
    } else if (inputParams.persistentData && typeof inputParams.persistentData === 'object') {
      persistentData = deepClone(inputParams.persistentData);
      delete inputParams.persistentData;
    }

    const entry = {
      type,
      inputParams,
      persistentData,
      __open: Boolean(raw.__open),
    };

    try {
      const handler = this.#resolveHandler(type);
      if (handler && typeof handler.applyParams === 'function') {
        handler.applyParams(this.pmimode, entry.inputParams, entry.inputParams);
      }
    } catch { /* ignore sanitize errors */ }

    return entry;
  }

  #cloneWithoutReserved(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      if (RESERVED_INPUT_KEYS.has(key)) continue;
      out[key] = deepClone(obj[key]);
    }
    return out;
  }

  #wrapLegacy(entry) {
    if (entry.__legacy) return entry.__legacy;
    const target = entry.inputParams;
    if (!target || typeof target !== 'object') {
      entry.inputParams = {};
      return this.#wrapLegacy(entry);
    }

    const descriptor = { configurable: true, enumerable: false };

    if (!Object.prototype.hasOwnProperty.call(target, 'persistentData')) {
      Object.defineProperty(target, 'persistentData', {
        ...descriptor,
        get: () => entry.persistentData,
        set: (value) => { entry.persistentData = (value && typeof value === 'object') ? value : {}; },
      });
    }

    if (!Object.prototype.hasOwnProperty.call(target, 'type')) {
      Object.defineProperty(target, 'type', {
        ...descriptor,
        get: () => entry.type,
        set: () => {},
      });
    }

    Object.defineProperty(target, '__open', {
      ...descriptor,
      get: () => entry.__open,
      set: (value) => { entry.__open = Boolean(value); },
    });

    Object.defineProperty(target, '__entryRef', {
      ...descriptor,
      value: entry,
    });

    entry.__legacy = target;
    return target;
  }

  #defaultsFromSchema(handler, pmimode) {
    const out = {};
    if (!handler) return out;

    const schema = handler.inputParamsSchema;
    if (!schema || typeof schema !== 'object') {
      out.persistentData = {};
      return out;
    }

    for (const key of Object.keys(schema)) {
      if (RESERVED_INPUT_KEYS.has(key)) continue;
      const def = schema[key];
      if (!def || typeof def !== 'object') continue;

      let value;
      if (typeof def.defaultResolver === 'function') {
        try {
          const resolved = def.defaultResolver({ pmimode, handler });
          if (resolved !== undefined) value = resolved;
        } catch (_) {
          value = undefined;
        }
      }

      if (value === undefined && Object.prototype.hasOwnProperty.call(def, 'default_value')) {
        value = def.default_value;
      }

      if (value !== undefined) {
        out[key] = deepClone(value);
      }
    }

    if (!Object.prototype.hasOwnProperty.call(out, 'persistentData')) {
      out.persistentData = {};
    }

    return out;
  }

  #serializeEntry(entry) {
    const out = {
      type: entry.type,
      inputParams: deepClone(entry.inputParams),
      persistentData: deepClone(entry.persistentData),
    };
    if (entry.__open) out.__open = true;
    return out;
  }

  #recalculateIdCounter() {
    let maxId = 0;
    for (const entry of this.annotations) {
      const annId = entry?.inputParams?.annotationID;
      if (!annId) continue;
      const match = String(annId).match(/(\d+)$/);
      if (!match) continue;
      const num = parseInt(match[1], 10);
      if (Number.isFinite(num) && num > maxId) maxId = num;
    }
    this.idCounter = maxId;
  }
}
