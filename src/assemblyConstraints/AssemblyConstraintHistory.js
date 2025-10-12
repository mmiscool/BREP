import * as THREE from 'three';
import { AssemblyConstraintRegistry } from './AssemblyConstraintRegistry.js';
import { evaluateConstraintNumericValue } from './constraintExpressionUtils.js';
import { deepClone } from '../utils/deepClone.js';
import { normalizeTypeString } from '../utils/normalizeTypeString.js';

const RESERVED_KEYS = new Set(['type', 'persistentData', '__open']);

function shallowArrayEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function extractDefaults(schema) {
  const result = {};
  if (!schema || typeof schema !== 'object') return result;
  for (const key in schema) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) continue;
    if (RESERVED_KEYS.has(key)) continue;
    const def = schema[key] ? schema[key].default_value : undefined;
    result[key] = deepClone(def);
  }
  return result;
}

function formatUnknownConstraintMessage(type) {
  const label = type != null ? String(type) : 'unknown';
  return `Unknown constraint type: ${label}`;
}

const DUPLICATE_TYPE_MAP = new Map([
  ['touch_align', 'touch_align'],
  ['touch-align', 'touch_align'],
  ['touchalign', 'touch_align'],
  ['touch align', 'touch_align'],
  ['touch align constraint', 'touch_align'],
  ['touchalignconstraint', 'touch_align'],
  ['touch', 'touch_align'],
  ['distance', 'distance'],
  ['distance constraint', 'distance'],
  ['distanceconstraint', 'distance'],
  ['angle', 'angle'],
  ['angle constraint', 'angle'],
  ['angleconstraint', 'angle'],
]);

const DUPLICATE_TYPE_LABELS = {
  touch_align: 'Touch Align',
  distance: 'Distance',
  angle: 'Angle',
};

const DEFAULT_SOLVER_TOLERANCE = 1e-6;
const DEFAULT_SOLVER_ITERATIONS = 1;
const DEFAULT_TRANSLATION_GAIN = 0.5;
const DEFAULT_ROTATION_GAIN = 0.5;
const AUTO_RUN_ITERATIONS = Math.max(1, DEFAULT_SOLVER_ITERATIONS);
const DISABLED_STATUS_MESSAGE = 'Constraint disabled.';

function toFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clampIterations(value) {
  const num = Math.floor(toFiniteNumber(value, DEFAULT_SOLVER_ITERATIONS));
  if (!Number.isFinite(num) || num < 1) return DEFAULT_SOLVER_ITERATIONS;

  return num;
}

function clampGain(value, fallback) {
  const num = toFiniteNumber(value, fallback);
  if (!Number.isFinite(num)) return fallback;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function removeExistingDebugArrows(scene) {
  if (!scene || typeof scene.traverse !== 'function') return;
  const toRemove = [];
  const prefixes = [
    'parallel-constraint-normal-',
    'distance-constraint-normal-',
    'touch-align-normal-',
  ];
  scene.traverse((obj) => {
    if (!obj || typeof obj.name !== 'string') return;
    if (prefixes.some((prefix) => obj.name.startsWith(prefix))) {
      toRemove.push(obj);
    }
  });
  for (const obj of toRemove) {
    try { obj.parent?.remove?.(obj); }
    catch {}
  }
}

function resolveSelectionObject(scene, selection) {
  if (!scene || selection == null) return null;
  let target = selection;
  if (Array.isArray(selection)) {
    target = selection.find((item) => item != null) ?? null;
  }
  if (!target) return null;
  if (target.isObject3D) return target;
  try {
    if (typeof target === 'string') {
      if (typeof scene.traverse === 'function') {
        let best = null;
        scene.traverse((obj) => {
          if (!obj || obj.name !== target) return;
          if (!best) best = obj;
          const component = resolveComponentFromObject(obj);
          const bestComponent = best ? resolveComponentFromObject(best) : null;
          if (component && !bestComponent) {
            best = obj;
          }
        });
        if (best) return best;
      }
      return typeof scene.getObjectByName === 'function'
        ? scene.getObjectByName(target)
        : null;
    }
    if (typeof target?.uuid === 'string' && typeof scene.getObjectByProperty === 'function') {
      const found = scene.getObjectByProperty('uuid', target.uuid);
      if (found) return found;
    }
    if (typeof target?.name === 'string' && typeof scene.getObjectByName === 'function') {
      const found = scene.getObjectByName(target.name);
      if (found) return found;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveComponentFromObject(obj) {
  let current = obj;
  while (current) {
    if (current.isAssemblyComponent || current.type === 'COMPONENT') return current;
    current = current.parent || null;
  }
  return null;
}

function vectorFrom(value) {
  if (!value) return null;
  if (value instanceof THREE.Vector3) return value.clone();
  if (typeof value === 'object') {
    const { x, y, z } = value;
    const vx = Number.isFinite(x) ? x : 0;
    const vy = Number.isFinite(y) ? y : 0;
    const vz = Number.isFinite(z) ? z : 0;
    return new THREE.Vector3(vx, vy, vz);
  }
  return null;
}

export class AssemblyConstraintHistory {
  constructor(partHistory = null, registry = null) {
    this.partHistory = partHistory || null;
    this.registry = registry || new AssemblyConstraintRegistry();
    this.constraints = [];
    this.idCounter = 0;
    this._listeners = new Set();
    this._autoRunScheduled = false;
    this._autoRunActive = false;
    this._autoRunOptions = null;
  }

  setPartHistory(partHistory) {
    this.partHistory = partHistory || null;
    if (this.partHistory && this.constraints.length) {
      this.#scheduleAutoRun();
    }
  }

  setRegistry(registry) {
    this.registry = registry || this.registry;
  }

  onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  list() {
    return this.constraints;
  }

  get size() {
    return this.constraints.length;
  }

  findById(constraintID) {
    const id = normalizeTypeString(constraintID);
    if (!id) return null;
    return this.constraints.find((entry) => normalizeTypeString(entry?.inputParams?.constraintID) === id) || null;
  }

  async addConstraint(type, initialInput = null) {
    const ConstraintClass = this.#resolveConstraint(type);
    if (!ConstraintClass) throw new Error(`Constraint type "${type}" is not registered.`);

    const schema = ConstraintClass.inputParamsSchema || {};
    const defaults = extractDefaults(schema);
    const normalizedType = normalizeTypeString(ConstraintClass.constraintType || type || ConstraintClass.name);
    const entry = {
      type: normalizedType,
      inputParams: { ...defaults },
      persistentData: {},
      __open: true,
      enabled: true,
    };

    Object.defineProperty(entry, 'constraintClass', {
      value: ConstraintClass,
      configurable: true,
      writable: true,
      enumerable: false,
    });

    const nextId = this.generateId(ConstraintClass.constraintShortName || normalizedType || 'CONST');
    entry.inputParams.constraintID = entry.inputParams.constraintID || nextId;

    if (initialInput && typeof initialInput === 'object') {
      Object.assign(entry.inputParams, deepClone(initialInput));
    }

    entry.inputParams.applyImmediately = true;

    this.constraints.push(entry);
    this.#emitChange();
    this.checkConstraintErrors(this.partHistory);
    this.#scheduleAutoRun();
    return entry;
  }

  removeConstraint(constraintID) {
    const id = normalizeTypeString(constraintID);
    if (!id) return false;
    const prevLength = this.constraints.length;
    this.constraints = this.constraints.filter((entry) => normalizeTypeString(entry?.inputParams?.constraintID) !== id);
    const changed = this.constraints.length !== prevLength;
    if (changed) {
      this.#emitChange();
      this.checkConstraintErrors(this.partHistory);
      this.#scheduleAutoRun();
    }
    return changed;
  }

  moveConstraint(constraintID, delta) {
    const id = normalizeTypeString(constraintID);
    if (!id) return false;
    const index = this.constraints.findIndex((entry) => normalizeTypeString(entry?.inputParams?.constraintID) === id);
    if (index < 0) return false;
    const target = index + delta;
    if (target < 0 || target >= this.constraints.length) return false;
    const [entry] = this.constraints.splice(index, 1);
    this.constraints.splice(target, 0, entry);
    this.#emitChange();
    this.#scheduleAutoRun();
    return true;
  }

  updateConstraintParams(constraintID, mutateFn) {
    const entry = this.findById(constraintID);
    if (!entry || typeof mutateFn !== 'function') return false;
    mutateFn(entry.inputParams);
    this.#emitChange();
    this.checkConstraintErrors(this.partHistory);
    this.#scheduleAutoRun();
    return true;
  }

  setConstraintEnabled(constraintID, enabled) {
    const entry = this.findById(constraintID);
    if (!entry) return false;

    const next = enabled !== false;
    const prev = entry.enabled !== false;

    if (prev === next) {
      if (entry.enabled !== next) entry.enabled = next;
      if (!next && entry.persistentData?.status !== 'disabled') {
        const pd = { ...(entry.persistentData || {}) };
        pd.status = 'disabled';
        if (!pd.message) pd.message = DISABLED_STATUS_MESSAGE;
        entry.persistentData = pd;
        this.#emitChange();
      }
      return false;
    }

    entry.enabled = next;
    const pd = { ...(entry.persistentData || {}) };

    if (!next) {
      pd.status = 'disabled';
      if (!pd.message) pd.message = DISABLED_STATUS_MESSAGE;
      entry.persistentData = pd;
      this.#emitChange();
      this.checkConstraintErrors(this.partHistory);
      this.#scheduleAutoRun();
      return true;
    }

    if (pd.status === 'disabled') {
      pd.status = 'pending';
      if (pd.message === DISABLED_STATUS_MESSAGE) delete pd.message;
      entry.persistentData = pd;
    }

    this.#emitChange();
    this.checkConstraintErrors(this.partHistory);
    this.#scheduleAutoRun();
    return true;
  }

  setOpenState(constraintID, isOpen) {
    const entry = this.findById(constraintID);
    if (!entry) return false;
    entry.__open = !!isOpen;
    this.#emitChange();
    return true;
  }

  setExclusiveOpen(constraintID) {
    const targetId = normalizeTypeString(constraintID);
    if (!targetId) return false;
    let changed = false;
    for (const entry of this.constraints) {
      if (!entry) continue;
      const entryId = normalizeTypeString(entry?.inputParams?.constraintID);
      const shouldOpen = entryId === targetId;
      const currentOpen = entry.__open !== false;
      if (currentOpen !== shouldOpen) {
        entry.__open = shouldOpen;
        changed = true;
      }
    }
    if (changed) this.#emitChange();
    return changed;
  }

  clear() {
    this.constraints = [];
    this.idCounter = 0;
    this.#emitChange();
  }

  snapshot() {
    return {
      idCounter: this.idCounter,
      constraints: this.constraints.map((entry) => ({
        type: entry?.type || null,
        inputParams: deepClone(entry?.inputParams) || {},
        persistentData: deepClone(entry?.persistentData) || {},
        open: entry?.__open !== false,
        enabled: entry?.enabled !== false,
      })),
    };
  }

  async replaceAll(constraints = [], idCounter = 0) {
    const resolved = [];
    const list = Array.isArray(constraints) ? constraints : [];
    let maxId = Number.isFinite(Number(idCounter)) ? Number(idCounter) : 0;

    for (const item of list) {
      if (!item) continue;
      const typeHint = item.type || item.constraintType || null;
      const ConstraintClass = this.#resolveConstraint(typeHint);
      if (!ConstraintClass) continue;

      const defaults = extractDefaults(ConstraintClass.inputParamsSchema);
      const normalizedType = normalizeTypeString(ConstraintClass.constraintType || typeHint || ConstraintClass.name);
      const entry = {
        type: normalizedType,
        inputParams: { ...defaults, ...deepClone(item.inputParams || {}) },
        persistentData: deepClone(item.persistentData || {}),
        __open: item.open !== false,
        enabled: item.enabled !== false,
      };

      if (!entry.inputParams.constraintID) {
        const prefix = (ConstraintClass.constraintShortName || normalizedType || 'CONST')
          .replace(/[^a-z0-9]/gi, '')
          .toUpperCase() || 'CONST';
        maxId += 1;
        entry.inputParams.constraintID = `${prefix}${maxId}`;
      } else {
        const match = String(entry.inputParams.constraintID).match(/(\d+)$/);
        if (match) {
          const numeric = Number(match[1]);
          if (Number.isFinite(numeric)) maxId = Math.max(maxId, numeric);
        }
      }

      entry.inputParams.applyImmediately = true;

      Object.defineProperty(entry, 'constraintClass', {
        value: ConstraintClass,
        configurable: true,
        writable: true,
        enumerable: false,
      });

      resolved.push(entry);
    }

    this.idCounter = maxId;
    this.constraints = resolved;
    this.#emitChange();
    if (this.constraints.length) {
      this.checkConstraintErrors(this.partHistory);
      this.#scheduleAutoRun();
    }
  }

  async deserialize(serialized) {
    const payload = serialized && typeof serialized === 'object' ? serialized : {};
    const list = Array.isArray(payload.constraints)
      ? payload.constraints
      : Array.isArray(serialized) ? serialized : [];
    const counter = Number.isFinite(Number(payload.idCounter)) ? Number(payload.idCounter) : undefined;
    await this.replaceAll(list, counter);
  }

  generateId(typeHint = 'CONST') {
    const prefix = normalizeTypeString(typeHint).replace(/[^a-z0-9]/gi, '').toUpperCase() || 'CONST';
    this.idCounter += 1;
    return `${prefix}${this.idCounter}`;
  }

  checkConstraintErrors(partHistory = this.partHistory, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const emit = opts.emit !== false;
    const updatePersistentData = opts.updatePersistentData !== false;

    const ph = partHistory || this.partHistory || null;
    if (ph) this.partHistory = ph;

    const duplicates = this.#detectDuplicateConstraints();
    const results = [];
    let changed = false;

    const mutatePersistentData = (entry, mutator) => {
      const previous = entry?.persistentData && typeof entry.persistentData === 'object'
        ? entry.persistentData
        : {};
      const next = { ...previous };
      let modified = false;

      const set = (key, value) => {
        const prevValue = next[key];
        if (value === undefined) {
          if (Object.prototype.hasOwnProperty.call(next, key)) {
            delete next[key];
            modified = true;
          }
          return;
        }
        if (Array.isArray(prevValue) && Array.isArray(value)) {
          if (shallowArrayEqual(prevValue, value)) return;
        } else if (prevValue === value) {
          return;
        }
        next[key] = value;
        modified = true;
      };

      const remove = (key) => {
        if (Object.prototype.hasOwnProperty.call(next, key)) {
          delete next[key];
          modified = true;
        }
      };

      try {
        mutator({ set, remove, data: next, previous });
      } catch (error) {
        console.warn('[AssemblyConstraintHistory] Failed to update persistent data:', error);
      }

      if (modified) {
        entry.persistentData = next;
      }
      return modified;
    };

    for (const entry of this.constraints) {
      if (!entry) continue;

      const constraintID = entry?.inputParams?.constraintID || null;
      const type = entry?.type || null;
      const result = {
        constraintID,
        type,
        status: 'ok',
        message: '',
        duplicateConstraintIDs: null,
        duplicateSignature: null,
      };

      if (entry.enabled === false) {
        result.status = 'disabled';
        result.message = DISABLED_STATUS_MESSAGE;
        if (updatePersistentData) {
          changed = mutatePersistentData(entry, ({ set, remove, previous }) => {
            set('status', 'disabled');
            if (!previous.message || previous.message === DISABLED_STATUS_MESSAGE) {
              set('message', DISABLED_STATUS_MESSAGE);
            }
            set('satisfied', false);
            remove('duplicateConstraintIDs');
            remove('duplicateSignature');
          }) || changed;
        }
        results.push(result);
        continue;
      }

      const constraintClass = this.#resolveConstraint(type);
      const duplicate = duplicates.get(entry);

      if (!constraintClass) {
        const message = formatUnknownConstraintMessage(type);
        result.status = 'error';
        result.message = message;
        if (updatePersistentData) {
          changed = mutatePersistentData(entry, ({ set, remove }) => {
            set('status', 'error');
            set('message', message);
            set('satisfied', false);
            remove('duplicateConstraintIDs');
            remove('duplicateSignature');
          }) || changed;
        }
        results.push(result);
        continue;
      }

      if (duplicate) {
        const relatedIds = Array.isArray(duplicate.relatedIds)
          ? duplicate.relatedIds.filter(Boolean)
          : [];
        const signature = duplicate.signature || null;

        result.status = 'duplicate';
        result.message = duplicate.message || 'Duplicate constraint selections.';
        result.duplicateConstraintIDs = relatedIds.length ? relatedIds : null;
        result.duplicateSignature = signature;

        if (updatePersistentData) {
          changed = mutatePersistentData(entry, ({ set, remove }) => {
            set('status', 'duplicate');
            set('message', result.message);
            set('satisfied', false);
            if (result.duplicateConstraintIDs) set('duplicateConstraintIDs', result.duplicateConstraintIDs);
            else remove('duplicateConstraintIDs');
            if (signature) set('duplicateSignature', signature);
            else remove('duplicateSignature');
          }) || changed;
        }
        results.push(result);
        continue;
      }

      if (updatePersistentData) {
        changed = mutatePersistentData(entry, ({ set, remove, previous }) => {
          if (previous.status === 'duplicate') {
            set('status', 'pending');
            if (typeof previous.message === 'string'
              && previous.message.startsWith('Duplicate constraint selections')) {
              remove('message');
            }
          }
          if (previous.status === 'error'
            && typeof previous.message === 'string'
            && previous.message.startsWith('Unknown constraint type:')) {
            set('status', 'pending');
            remove('message');
          }
          remove('duplicateConstraintIDs');
          remove('duplicateSignature');
        }) || changed;
      }

      results.push(result);
    }

    if (updatePersistentData && changed && emit) {
      this.#emitChange();
    }

    return results;
  }

  async runAll(partHistory = this.partHistory, options = {}) {
    const ph = partHistory || this.partHistory;
    if (!ph) return [];

    this.partHistory = ph;
    this.checkConstraintErrors(ph, { emit: false });

    const tolerance = Math.abs(toFiniteNumber(options?.tolerance, DEFAULT_SOLVER_TOLERANCE)) || DEFAULT_SOLVER_TOLERANCE;
    const maxIterations = clampIterations(options?.iterations);
    const translationGain = clampGain(options?.translationGain, DEFAULT_TRANSLATION_GAIN);
    const rotationGain = clampGain(options?.rotationGain, DEFAULT_ROTATION_GAIN);
    const debugMode = options?.debugMode === true;
    const defaultDelay = debugMode ? 500 : 0;
    const iterationDelayMsRaw = toFiniteNumber(options?.delayMs ?? options?.iterationDelayMs, defaultDelay);
    const iterationDelayMs = Math.max(0, Number.isFinite(iterationDelayMsRaw) ? iterationDelayMsRaw : defaultDelay);

    const viewer = options?.viewer || ph.viewer || null;
    const renderScene = () => {
      try { viewer?.render?.(); } catch {}
      try { viewer?.requestRender?.(); } catch {}
    };

    const controller = options?.controller && typeof options.controller === 'object'
      ? options.controller
      : null;
    const signal = controller?.signal || options?.signal || null;

    let aborted = false;
    const shouldAbort = () => {
      if (signal?.aborted) {
        aborted = true;
        return true;
      }
      return false;
    };

    const rawHooks = controller?.hooks || options?.hooks;
    const hooks = rawHooks && typeof rawHooks === 'object' ? rawHooks : {};
    const safeCallHook = async (name, payload = {}) => {
      const fn = hooks?.[name];
      if (typeof fn !== 'function') return;
      try {
        await fn({ controller, signal, aborted, ...payload });
      } catch (error) {
        console.warn(`[AssemblyConstraintHistory] hook "${name}" failed:`, error);
      }
    };

    const scene = ph.scene || null;

    const features = Array.isArray(ph.features) ? ph.features.filter(Boolean) : [];
    const featureById = new Map();
    for (const feature of features) {
      const id = normalizeTypeString(feature?.inputParams?.featureID);
      if (id) featureById.set(id, feature);
    }

    const updatedComponents = new Set();

    const resolveObject = (selection) => resolveSelectionObject(scene, selection);
    const resolveComponent = (selection) => {
      const obj = resolveObject(selection);
      return resolveComponentFromObject(obj);
    };

    const getFeatureForComponent = (component) => {
      if (!component) return null;
      const featureId = normalizeTypeString(component.owningFeatureID);
      if (!featureId) return null;
      return featureById.get(featureId) || null;
    };

    const isComponentFixed = (component) => {
      if (!component) return true;
      if (component.fixed) return true;
      if (component.userData?.fixedByConstraint) return true;
      const feature = getFeatureForComponent(component);
      if (feature?.inputParams?.isFixed) return true;
      return false;
    };

    const markUpdated = (component) => {
      if (!component) return;
      updatedComponents.add(component);
    };

    const applyTranslation = (component, delta) => {
      const vec = vectorFrom(delta);
      if (!component || !vec || vec.lengthSq() === 0) return false;
      component.position.add(vec);
      component.updateMatrixWorld?.(true);
      markUpdated(component);
      return true;
    };

    const applyRotation = (component, quaternion) => {
      if (!component || !quaternion) return false;
      let q;
      if (quaternion instanceof THREE.Quaternion) {
        q = quaternion.clone();
      } else {
        const x = toFiniteNumber(quaternion?.x, 0);
        const y = toFiniteNumber(quaternion?.y, 0);
        const z = toFiniteNumber(quaternion?.z, 0);
        const w = Number.isFinite(quaternion?.w) ? quaternion.w : 1;
        q = new THREE.Quaternion(x, y, z, w);
      }
      if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) {
        return false;
      }
      if (Math.abs(1 - q.lengthSq()) > 1e-6) q.normalize();
      component.quaternion.premultiply(q);
      component.updateMatrixWorld?.(true);
      markUpdated(component);
      return true;
    };

    const baseContext = {
      partHistory: ph,
      scene,
      tolerance,
      translationGain,
      rotationGain,
      resolveObject,
      resolveComponent,
      applyTranslation,
      applyRotation,
      isComponentFixed,
      getFeatureForComponent,
      markUpdated,
      viewer,
      renderScene,
      debugMode,
    };


    removeExistingDebugArrows(scene);

    const duplicateInfo = this.#detectDuplicateConstraints();

    const runtimeEntries = this.constraints.map((entry) => {
      if (entry?.enabled === false) {
        const constraintID = entry?.inputParams?.constraintID || null;
        const result = {
          ok: true,
          status: 'disabled',
          message: DISABLED_STATUS_MESSAGE,
          applied: false,
          satisfied: false,
          iteration: 0,
          constraintID,
        };
        return {
          entry,
          instance: null,
          result,
          skipReason: 'disabled',
        };
      }

      const duplicate = duplicateInfo.get(entry);
      if (duplicate) {
        const constraintID = entry?.inputParams?.constraintID || null;
        const relatedIds = Array.isArray(duplicate.relatedIds) ? duplicate.relatedIds.slice() : [];
        const result = {
          ok: false,
          status: 'duplicate',
          message: duplicate.message,
          applied: false,
          satisfied: false,
          iteration: 0,
          constraintID,
          duplicateConstraintIDs: relatedIds,
          duplicateSignature: duplicate.signature,
        };
        return {
          entry,
          instance: null,
          result,
          skipReason: 'duplicate',
        };
      }

      const ConstraintClass = this.#resolveConstraint(entry.type);
      if (!ConstraintClass) {
        const message = formatUnknownConstraintMessage(entry.type);
        const constraintID = entry?.inputParams?.constraintID || null;
        entry.persistentData = {
          status: 'error',
          message,
          lastRunAt: Date.now(),
          lastIteration: 0,
        };
        return {
          entry,
          instance: null,
          result: {
            ok: false,
            status: 'error',
            message,
            applied: false,
            satisfied: false,
            iteration: 0,
            constraintID,
          },
          skipReason: 'unregistered',
        };
      }

      const originalInputParams = deepClone(entry.inputParams) || {};
      const runtimeInputParams = deepClone(entry.inputParams) || {};

      const instance = new ConstraintClass(ph);
      this.#applyNumericExpressions(runtimeInputParams, ConstraintClass.inputParamsSchema || {});

      try { instance.inputParams = runtimeInputParams; }
      catch { instance.inputParams = { ...runtimeInputParams }; }
      try { Object.assign(instance.persistentData, deepClone(entry.persistentData)); }
      catch { instance.persistentData = { ...(entry.persistentData || {}) }; }

      return { entry, instance, result: null, originalInputParams };
    });

    for (const runtime of runtimeEntries) {
      runtime.instance?.clearDebugArrows?.({ scene });
    }

    await safeCallHook('onStart', {
      maxIterations,
      constraintCount: runtimeEntries.length,
    });

    let iterationsCompleted = 0;
    const totalConstraints = runtimeEntries.length;

    outerLoop:
    for (let iter = 0; iter < maxIterations; iter += 1) {
      if (shouldAbort()) break;

      await safeCallHook('onIterationStart', {
        iteration: iter,
        maxIterations,
      });
      if (shouldAbort()) break;

      let iterationApplied = false;

      for (let idx = 0; idx < runtimeEntries.length; idx += 1) {
        if (shouldAbort()) break outerLoop;
        const runtime = runtimeEntries[idx];
        const constraintID = runtime?.entry?.inputParams?.constraintID || null;
        const constraintType = runtime?.entry?.type || null;
        const hookBase = {
          iteration: iter,
          index: idx,
          constraintID,
          constraintType,
          totalConstraints,
        };

        if (!runtime.instance) {
          await safeCallHook('onConstraintSkipped', { ...hookBase, skipReason: runtime.skipReason || null });
          continue;
        }

        await safeCallHook('onConstraintStart', hookBase);
        if (shouldAbort()) break outerLoop;

        const context = { ...baseContext, iteration: iter, maxIterations };

        let result;
        try {
          if (typeof runtime.instance.solve === 'function') {
            result = await runtime.instance.solve(context);
          } else {
            result = await runtime.instance.run(context);
          }
        } catch (error) {
          console.warn('[AssemblyConstraintHistory] Constraint solve failed:', error);
          result = {
            ok: false,
            status: 'error',
            message: error?.message || 'Constraint evaluation failed.',
            error,
          };
          runtime.instance.persistentData = runtime.instance.persistentData || {};
          runtime.instance.persistentData.status = 'error';
          runtime.instance.persistentData.message = result.message;
        }

        runtime.result = this.#finalizeConstraintResult(runtime.instance, result, iter);

        if (runtime.result.applied) iterationApplied = true;

        await safeCallHook('onConstraintEnd', {
          ...hookBase,
          result: runtime.result,
        });
        if (shouldAbort()) break outerLoop;
      }

      if (typeof baseContext.renderScene === 'function') {
        try { baseContext.renderScene(); }
        catch {}
      }
      if (iterationDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, iterationDelayMs));
      }

      if (shouldAbort()) break;

      iterationsCompleted = iter + 1;

      await safeCallHook('onIterationComplete', {
        iteration: iter,
        maxIterations,
        applied: iterationApplied,
      });
      if (shouldAbort()) break;

      if (!iterationApplied) break;
    }

    aborted = aborted || signal?.aborted || false;

    const now = Date.now();
    const finalResults = [];

    for (const runtime of runtimeEntries) {
      const { entry, instance } = runtime;
      const result = runtime.result || this.#finalizeConstraintResult(
        instance,
        { ok: false, status: 'pending', message: 'Constraint was not evaluated.' },
        Math.max(0, maxIterations - 1),
      );

      const sourcePD = instance?.persistentData && Object.keys(instance.persistentData).length
        ? instance.persistentData
        : entry.persistentData || {};

      const nextPersistent = { ...sourcePD };
      if (result.status) nextPersistent.status = result.status;
      if (result.message !== undefined) {
        if (result.message) nextPersistent.message = result.message;
        else if (nextPersistent.message) delete nextPersistent.message;
      }
      nextPersistent.satisfied = !!result.satisfied;
      if (typeof result.error === 'number' && Number.isFinite(result.error)) {
        nextPersistent.error = result.error;
      }
      nextPersistent.lastRunAt = now;
      nextPersistent.lastIteration = result.iteration;
      nextPersistent.lastRequestedIterations = maxIterations;
      if (result.status === 'duplicate') {
        if (Array.isArray(result.duplicateConstraintIDs) && result.duplicateConstraintIDs.length) {
          nextPersistent.duplicateConstraintIDs = result.duplicateConstraintIDs.slice();
        } else if (nextPersistent.duplicateConstraintIDs) {
          delete nextPersistent.duplicateConstraintIDs;
        }
        if (result.duplicateSignature) {
          nextPersistent.duplicateSignature = result.duplicateSignature;
        } else if (nextPersistent.duplicateSignature) {
          delete nextPersistent.duplicateSignature;
        }
      } else {
        if (nextPersistent.duplicateConstraintIDs) delete nextPersistent.duplicateConstraintIDs;
        if (nextPersistent.duplicateSignature) delete nextPersistent.duplicateSignature;
      }

      entry.persistentData = nextPersistent;
      if (runtime.originalInputParams) {
        const target = (entry.inputParams && typeof entry.inputParams === 'object')
          ? entry.inputParams
          : {};
        for (const key of Object.keys(target)) {
          if (!Object.prototype.hasOwnProperty.call(runtime.originalInputParams, key)) {
            delete target[key];
          }
        }
        Object.assign(target, runtime.originalInputParams);
        entry.inputParams = target;
      } else {
        entry.inputParams = { ...(entry.inputParams || {}) };
      }

      finalResults.push({
        constraintID: entry?.inputParams?.constraintID || null,
        type: entry?.type || null,
        ...result,
      });
    }

    if (updatedComponents.size) {
      try {
        ph.syncAssemblyComponentTransforms?.();
      } catch (error) {
        console.warn('[AssemblyConstraintHistory] Failed to sync component transforms:', error);
      }
    }

    this.#emitChange();

    await safeCallHook('onComplete', {
      results: finalResults.slice(),
      aborted,
      iterationsCompleted,
      maxIterations,
    });

    return finalResults;
  }

  #applyNumericExpressions(inputParams, schema) {
    if (!inputParams || !schema) return;
    for (const key in schema) {
      if (!Object.prototype.hasOwnProperty.call(schema, key)) continue;
      const def = schema[key];
      if (!def || def.type !== 'number') continue;
      const evaluated = evaluateConstraintNumericValue(this.partHistory, inputParams[key]);
      if (evaluated != null) {
        inputParams[key] = evaluated;
      }
    }
  }

  #detectDuplicateConstraints() {
    const grouped = new Map();
    for (const entry of this.constraints) {
      if (!entry) continue;
      const baseType = this.#normalizeDuplicateConstraintType(entry?.type);
      if (!baseType) continue;
      const signature = this.#buildSelectionSignature(entry?.inputParams);
      if (!signature) continue;
      if (!grouped.has(signature)) grouped.set(signature, []);
      const constraintID = normalizeTypeString(entry?.inputParams?.constraintID) || null;
      const typeLabel = DUPLICATE_TYPE_LABELS[baseType] || baseType;
      grouped.get(signature).push({
        entry,
        type: baseType,
        typeLabel,
        id: constraintID,
      });
    }

    const duplicates = new Map();
    for (const [signature, list] of grouped.entries()) {
      if (!Array.isArray(list) || list.length <= 1) continue;
      const byType = new Map();
      for (const item of list) {
        if (!byType.has(item.type)) byType.set(item.type, []);
        byType.get(item.type).push(item);
      }
      for (const item of list) {
        const sameType = (byType.get(item.type) || []).filter((other) => other !== item);
        const otherTypes = [];
        for (const [type, entries] of byType.entries()) {
          if (type === item.type) continue;
          otherTypes.push({ type, entries });
        }

        const formatConstraintPhrase = (base, ids) => {
          const unique = Array.from(new Set(
            ids.map((id) => (id && id.trim()) ? id.trim() : null).filter(Boolean),
          ));
          if (unique.length === 0) {
            return `${base} constraint`;
          }
          const plural = unique.length > 1 ? 'constraints' : 'constraint';
          return `${base} ${plural} ${unique.join(', ')}`;
        };

        const parts = [];
        if (sameType.length) {
          const ids = sameType.map((other) => other.id);
          parts.push(formatConstraintPhrase(`shares selections with ${item.typeLabel}`, ids));
        }
        for (const group of otherTypes) {
          const label = DUPLICATE_TYPE_LABELS[group.type] || group.type;
          const ids = group.entries.map((other) => other.id);
          parts.push(formatConstraintPhrase(`conflicts with ${label}`, ids));
        }
        const message = parts.length
          ? `Duplicate constraint selections: ${parts.join('. ')}.`
          : 'Duplicate constraint selections.';

        const otherIds = list
          .filter((other) => other !== item)
          .map((other) => other.id)
          .filter(Boolean);
        duplicates.set(item.entry, {
          message,
          signature,
          relatedIds: Array.from(new Set(otherIds)),
          type: item.type,
        });
      }
    }

    return duplicates;
  }

  #normalizeDuplicateConstraintType(type) {
    const normalized = normalizeTypeString(type).toLowerCase();
    if (!normalized) return null;
    return DUPLICATE_TYPE_MAP.get(normalized) || null;
  }

  #scheduleAutoRun(options = null) {
    if (!this.partHistory) return;
    const opts = options && typeof options === 'object' ? { ...options } : null;
    this._autoRunOptions = opts;
    if (this._autoRunScheduled) return;
    this._autoRunScheduled = true;
    Promise.resolve().then(() => {
      try { this.#executeAutoRun(); }
      catch (error) { console.warn('[AssemblyConstraintHistory] Failed to schedule auto run:', error); }
    });
  }

  async #executeAutoRun() {
    if (!this._autoRunScheduled) return;
    if (this._autoRunActive) return;

    const options = this._autoRunOptions ? { ...this._autoRunOptions } : {};
    this._autoRunOptions = null;
    this._autoRunScheduled = false;

    const iterationsRaw = Number(options.iterations);
    const iterations = Number.isFinite(iterationsRaw) && iterationsRaw >= 1
      ? Math.floor(iterationsRaw)
      : AUTO_RUN_ITERATIONS;

    const ph = this.partHistory;
    if (!ph) return;

    this._autoRunActive = true;
    try {
      await this.runAll(ph, { ...options, iterations });
    } catch (error) {
      console.warn('[AssemblyConstraintHistory] Auto run failed:', error);
    } finally {
      this._autoRunActive = false;
      if (this._autoRunScheduled) {
        Promise.resolve().then(() => {
          try { this.#executeAutoRun(); }
          catch (error) { console.warn('[AssemblyConstraintHistory] Failed to re-run auto cycle:', error); }
        });
      }
    }
  }

  #buildSelectionSignature(params) {
    if (!params || typeof params !== 'object') return null;
    const selections = this.#extractSelectionPair(params);
    if (!selections) return null;
    const keys = [];
    for (const selection of selections) {
      const key = this.#selectionKey(selection, 0, new Set());
      if (!key) return null;
      keys.push(key);
    }
    if (keys.length !== 2) return null;
    keys.sort();
    return `${keys[0]}|${keys[1]}`;
  }

  #extractSelectionPair(params) {
    const raw = Array.isArray(params?.elements) ? params.elements : [];
    const picks = [];
    for (const item of raw) {
      if (item == null) continue;
      picks.push(item);
      if (picks.length >= 2) break;
    }
    return picks.length >= 2 ? picks.slice(0, 2) : null;
  }

  #selectionKey(selection, depth = 0, seen = new Set()) {
    if (selection == null) return null;
    if (depth > 5) return null;

    if (Array.isArray(selection)) {
      for (const item of selection) {
        const key = this.#selectionKey(item, depth + 1, seen);
        if (key) return key;
      }
      return null;
    }

    const type = typeof selection;
    if (type === 'string' || type === 'number' || type === 'boolean') {
      return `${type}:${String(selection)}`;
    }
    if (type !== 'object') return null;

    if (seen.has(selection)) return null;
    seen.add(selection);
    try {
      if (selection.isObject3D && typeof selection.uuid === 'string' && selection.uuid) {
        return `uuid:${selection.uuid}`;
      }

      const preferredFields = [
        'selectionID', 'selectionId', 'fullName', 'fullPath',
        'pathKey', 'pathId', 'pathID', 'id', 'uuid', 'entityUUID',
        'brepId', 'brepID', 'objectUUID', 'objectId', 'objectID',
      ];
      for (const field of preferredFields) {
        const value = selection[field];
        if (typeof value === 'string' && value.trim()) return `${field}:${value.trim()}`;
      }

      const nameFields = [
        'name',
        'label',
        'displayName',
        'componentName',
        'faceName',
        'edgeName',
        'vertexName',
        'reference',
        'refName',
      ];
      for (const field of nameFields) {
        const value = selection[field];
        if (typeof value === 'string' && value.trim()) return `${field}:${value.trim()}`;
      }

      if (Array.isArray(selection.path) && selection.path.length) {
        const joined = selection.path.map((part) => String(part)).join('/');
        if (joined) return `path:${joined}`;
      }

      if (selection.component && typeof selection.component === 'object') {
        const compKey = this.#selectionKey(selection.component, depth + 1, seen);
        if (compKey) return `component:${compKey}`;
      }

      if (selection.object && typeof selection.object === 'object') {
        const objKey = this.#selectionKey(selection.object, depth + 1, seen);
        if (objKey) return `object:${objKey}`;
      }

      const keys = Object.keys(selection).filter((key) => key !== '__proto__').sort();
      const parts = [];
      for (const key of keys) {
        const value = selection[key];
        if (value == null) continue;
        if (typeof value === 'function' || typeof value === 'symbol') continue;
        let repr = null;
        if (typeof value === 'object') {
          const nested = this.#selectionKey(value, depth + 1, seen);
          if (nested) repr = nested;
        } else {
          repr = `${typeof value}:${String(value)}`;
        }
        if (repr) {
          parts.push(`${key}=${repr}`);
          if (parts.length >= 8) break;
        }
      }
      if (parts.length) {
        return `obj:${parts.join(',')}`;
      }
      return null;
    } finally {
      seen.delete(selection);
    }
  }

  #finalizeConstraintResult(instance, rawResult, iteration) {
    const result = rawResult && typeof rawResult === 'object' ? rawResult : {};
    const satisfied = !!result.satisfied;
    const applied = !!result.applied;
    const ok = result.ok !== false;
    const message = typeof result.message === 'string' ? result.message : '';
    let status = typeof result.status === 'string' && result.status.trim()
      ? result.status.trim()
      : null;
    if (!status) {
      if (!ok) status = 'error';
      else if (satisfied) status = 'satisfied';
      else if (applied) status = 'adjusted';
      else status = 'pending';
    }
    const errorValue = Number.isFinite(result.error) ? result.error : null;

    // Ensure persistent data on the instance reflects the normalized status.
    if (instance) {
      instance.persistentData = instance.persistentData || {};
      if (!instance.persistentData.status) instance.persistentData.status = status;
      if (message && !instance.persistentData.message) instance.persistentData.message = message;
      instance.persistentData.satisfied = satisfied;
      if (errorValue != null) instance.persistentData.error = errorValue;
    }

    return {
      ok,
      status,
      satisfied,
      applied,
      error: errorValue,
      message,
      iteration,
      diagnostics: result.diagnostics || null,
    };
  }

  #resolveConstraint(type) {
    const t = normalizeTypeString(type);
    if (!t) return null;
    if (this.registry && typeof this.registry.getSafe === 'function') {
      const found = this.registry.getSafe(t);
      if (found) return found;
    }
    if (this.registry && typeof this.registry.get === 'function') {
      try { return this.registry.get(t); }
      catch { return null; }
    }
    return null;
  }

  #emitChange() {
    for (const listener of this._listeners) {
      try {
        listener(this);
      } catch { /* ignore */ }
    }
  }

}
