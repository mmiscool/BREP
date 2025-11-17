import { annotationRegistry } from './AnnotationRegistry.js';
import { deepClone } from '../../utils/deepClone.js';
import { normalizeTypeString } from '../../utils/normalizeTypeString.js';
import { HistoryCollectionBase } from '../../core/entities/HistoryCollectionBase.js';

const RESERVED_INPUT_KEYS = new Set(['type', 'persistentData', '__open']);
const DEFAULT_TYPE = 'annotation';

export class AnnotationHistory extends HistoryCollectionBase {
  constructor(pmimode = null) {
    super({ viewer: pmimode?.viewer || null });
    this.pmimode = pmimode || null;
    this.#registerAvailableAnnotations();
  }

  setPMIMode(pmimode) {
    this.pmimode = pmimode || null;
    if (pmimode?.viewer) {
      this.viewer = pmimode.viewer;
    }
  }

  load(serializedAnnotations) {
    this.entries = [];
    this._idCounter = 0;
    const list = Array.isArray(serializedAnnotations) ? serializedAnnotations : [];
    for (const raw of list) {
      const entity = this.#hydrateEntity(raw);
      if (!entity) continue;
      this.entries.push(entity);
      this.#bumpIdCounterFrom(entity);
      this.#linkInputParams(entity);
    }
    this.notifyListeners({ reason: 'load', history: this });
    return this.entries;
  }

  toSerializable() {
    return this.entries.map((entity) => {
      const open = Boolean(entity.runtimeAttributes?.__open);
      const input = deepClone(entity.inputParams || {});
      if (input && typeof input === 'object') {
        delete input.persistentData;
        delete input.__open;
        delete input.__entityRef;
      }
      return {
        type: entity.type || DEFAULT_TYPE,
        inputParams: input,
        persistentData: deepClone(entity.persistentData || {}),
        __open: open || undefined,
        enabled: entity.enabled !== false,
      };
    });
  }

  get size() {
    return this.entries.length;
  }

  getEntries() {
    return this.entries.slice();
  }

  getEntry(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.entries.length) return null;
    return this.entries[index] || null;
  }

  findById(entryId) {
    if (entryId == null) return null;
    const target = String(entryId);
    if (!target) return null;
    for (const entity of this.entries) {
      const params = entity?.inputParams;
      const candidate = params?.id ?? entity?.id;
      if (candidate != null && String(candidate) === target) {
        return entity;
      }
    }
    return null;
  }

  setAnnotationEnabled(annotationId, enabled) {
    const entry = this.findById(annotationId);
    if (!entry) return false;
    const next = enabled !== false;
    const prev = entry.enabled !== false;
    if (prev === next) return false;
    this.#applyEnabledState(entry, next);
    this.notifyListeners({ reason: 'update', entry, history: this });
    return true;
  }

  createAnnotation(type, initialData = null) {
    const EntityClass = this.#resolveHandler(type);
    if (!EntityClass) return null;
    const entity = new EntityClass({ history: this, registry: this.registry });
    entity.type = EntityClass.entityType || EntityClass.type || normalizeTypeString(type) || DEFAULT_TYPE;
    entity.entityType = entity.type;
    const defaults = this.#defaultsFromSchema(EntityClass);
    const seed = deepClone(initialData || {});
    const params = { ...defaults, ...seed };
    if (!params.type) params.type = entity.type;
    entity.setParams(params);
    entity.setPersistentData(params.persistentData || {});
    delete entity.inputParams.persistentData;
    this.#linkInputParams(entity);

    if (typeof EntityClass.applyParams === 'function') {
      try {
        const res = EntityClass.applyParams(this.pmimode, entity.inputParams, entity.inputParams) || null;
        if (res && res.paramsPatch && typeof res.paramsPatch === 'object') {
          entity.mergeParams(res.paramsPatch);
        }
      } catch {
        // ignore apply errors
      }
    }

    const id = entity.inputParams.id || this.generateId(entity.shortName || entity.type || 'ANN');
    entity.setId(id);
    entity.runtimeAttributes.__open = true;
    this.#applyEnabledState(entity, true);
    this.entries.push(entity);
    this.#bumpIdCounterFrom(entity);
    this.notifyListeners({ reason: 'add', entry: entity, history: this });
    return entity;
  }

  removeAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.entries.length) return null;
    const [entity] = this.entries.splice(index, 1);
    if (!entity) return null;
    this.notifyListeners({ reason: 'remove', entry: entity, history: this });
    return entity;
  }

  moveUp(index) {
    if (!Number.isInteger(index) || index <= 0 || index >= this.entries.length) return false;
    const [entity] = this.entries.splice(index, 1);
    this.entries.splice(index - 1, 0, entity);
    this.notifyListeners({ reason: 'reorder', entry: entity, history: this });
    return true;
  }

  moveDown(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.entries.length - 1) return false;
    const [entity] = this.entries.splice(index, 1);
    this.entries.splice(index + 1, 0, entity);
    this.notifyListeners({ reason: 'reorder', entry: entity, history: this });
    return true;
  }

  clear() {
    this.entries = [];
    this._idCounter = 0;
    this.notifyListeners({ reason: 'clear', history: this });
  }

  generateId(typeHint = 'ANN') {
    const safeHint = normalizeTypeString(typeHint) || 'ann';
    const prefix = safeHint.replace(/[^a-z0-9]/gi, '').toUpperCase() || 'ANN';
    const existing = new Set(this.entries.map((entity, i) => {
      const params = entity?.inputParams;
      if (params?.id) return String(params.id);
      if (entity?.id != null) return String(entity.id);
      return `ANN${i + 1}`;
    }));
    let candidate = '';
    do {
      this._idCounter += 1;
      candidate = `${prefix}${this._idCounter}`;
    } while (existing.has(candidate));
    return candidate;
  }

  addListener(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    return () => {
      try { this._listeners.delete(listener); } catch {
        // ignore
      }
    };
  }

  removeListener(listener) {
    if (typeof listener !== 'function') return;
    try { this._listeners.delete(listener); } catch {
      // ignore
    }
  }

  notifyListeners(payload = {}) {
    if (!(this._listeners instanceof Set)) return;
    for (const fn of Array.from(this._listeners)) {
      try { fn(payload, this); } catch {
        // ignore listener errors
      }
    }
  }

  #hydrateEntity(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const type = normalizeTypeString(source.type || source.inputParams?.type || DEFAULT_TYPE) || DEFAULT_TYPE;
    const EntityClass = this.#resolveHandler(type);
    if (!EntityClass) return null;
    const entity = new EntityClass({ history: this, registry: this.registry });
    entity.type = EntityClass.entityType || EntityClass.type || type;
    entity.entityType = entity.type;

    const params = this.#cloneWithoutReserved(source.inputParams || source);
    if (!params.type) params.type = entity.type;
    entity.setParams(params);
    entity.setPersistentData(deepClone(source.persistentData || {}));
    delete entity.inputParams.persistentData;

    if (typeof EntityClass.applyParams === 'function') {
      try {
        const res = EntityClass.applyParams(this.pmimode, entity.inputParams, entity.inputParams) || null;
        if (res && res.paramsPatch && typeof res.paramsPatch === 'object') {
          entity.mergeParams(res.paramsPatch);
        }
      } catch {
        // ignore
      }
    }

    const id = entity.inputParams.id || source.id || this.generateId(entity.shortName || entity.type);
    entity.setId(id);
    entity.runtimeAttributes.__open = Boolean(source.__open);
    this.#applyEnabledState(entity, source.enabled);
    this.#linkInputParams(entity);
    return entity;
  }

  #linkInputParams(entity) {
    if (!entity) return;
    if (!entity.runtimeAttributes || typeof entity.runtimeAttributes !== 'object') {
      entity.runtimeAttributes = {};
    }
    const params = entity.inputParams || {};
    const descriptor = { configurable: true, enumerable: false };

    if (!Object.prototype.hasOwnProperty.call(params, '__entityRef')) {
      Object.defineProperty(params, '__entityRef', { ...descriptor, value: entity });
    }

    if (!Object.prototype.hasOwnProperty.call(params, 'persistentData')) {
      Object.defineProperty(params, 'persistentData', {
        ...descriptor,
        get: () => entity.persistentData,
        set: (value) => {
          const next = (value && typeof value === 'object') ? value : {};
          entity.setPersistentData(next);
        },
      });
    }

    if (!Object.prototype.hasOwnProperty.call(params, '__open')) {
      Object.defineProperty(params, '__open', {
        ...descriptor,
        get: () => Boolean(entity.runtimeAttributes.__open),
        set: (value) => {
          entity.runtimeAttributes.__open = Boolean(value);
        },
      });
    }

    params.type = entity.type || params.type || DEFAULT_TYPE;
    if (params.id == null && entity.id != null) {
      params.id = entity.id;
    }
  }

  #defaultsFromSchema(EntityClass) {
    const out = {};
    const schema = EntityClass?.inputParamsSchema;
    if (!schema || typeof schema !== 'object') return out;
    for (const key of Object.keys(schema)) {
      if (RESERVED_INPUT_KEYS.has(key)) continue;
      const def = schema[key];
      if (!def || typeof def !== 'object') continue;
      if ('defaultResolver' in def && typeof def.defaultResolver === 'function') {
        try {
          const resolved = def.defaultResolver({ pmimode: this.pmimode, handler: EntityClass });
          if (resolved !== undefined) {
            out[key] = deepClone(resolved);
            continue;
          }
        } catch {
          // ignore resolver errors
        }
      }
      if ('default_value' in def) {
        out[key] = deepClone(def.default_value);
      }
    }
    return out;
  }

  #cloneWithoutReserved(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const key of Object.keys(obj)) {
      if (RESERVED_INPUT_KEYS.has(key)) continue;
      out[key] = deepClone(obj[key]);
    }
    return out;
  }

  #registerAvailableAnnotations() {
    const list = annotationRegistry.list();
    for (const Handler of list) {
      try { this.registry.register(Handler); } catch {
        // ignore duplicate registrations
      }
    }
  }

  #resolveHandler(type) {
    const handler = annotationRegistry.getSafe?.(type) || null;
    if (handler) {
      try { this.registry.register(handler); } catch {
        // ignore duplicate
      }
    }
    return handler;
  }

  #bumpIdCounterFrom(entity) {
    const id = entity?.inputParams?.id || entity?.id;
    if (!id) return;
    const match = String(id).match(/(\d+)$/);
    if (!match) return;
    const num = parseInt(match[1], 10);
    if (Number.isFinite(num) && num > this._idCounter) {
      this._idCounter = num;
    }
  }

  #applyEnabledState(entity, value) {
    if (!entity) return false;
    const enabled = value !== false;
    entity.enabled = enabled;
    if (!entity.runtimeAttributes || typeof entity.runtimeAttributes !== 'object') {
      entity.runtimeAttributes = {};
    }
    entity.runtimeAttributes.__enabled = enabled;
    return enabled;
  }
}
