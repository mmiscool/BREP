//
import * as THREE from 'three';


// Feature classes live in their own files; registry wires them up.
import { FeatureRegistry } from './FeatureRegistry.js';
import { SelectionFilter } from './UI/SelectionFilter.js';
import { MetadataManager } from './metadataManager.js';
import { AssemblyConstraintRegistry } from './assemblyConstraints/AssemblyConstraintRegistry.js';
import { AssemblyConstraintHistory } from './assemblyConstraints/AssemblyConstraintHistory.js';
import { AssemblyComponentFeature } from './features/assemblyComponent/AssemblyComponentFeature.js';
import { getComponentRecord, base64ToUint8Array } from './services/componentLibrary.js';
import { PMIViewsManager } from './pmi/PMIViewsManager.js';
import { deepClone } from './utils/deepClone.js';


const debug = false;


export class PartHistory {
  constructor() {
    this.features = [];
    this.scene = new THREE.Scene();
    this.idCounter = 0;
    this.featureRegistry = new FeatureRegistry();
    this.assemblyConstraintRegistry = new AssemblyConstraintRegistry();
    this.assemblyConstraintHistory = new AssemblyConstraintHistory(this, this.assemblyConstraintRegistry);
    this.callbacks = {};
    this.currentHistoryStepId = null;
    this.expressions = "//Examples:\nx = 10 + 6; \ny = x * 2;";
    this.pmiViewsManager = new PMIViewsManager(this);
    this.metadataManager = new MetadataManager
    this.ambientLight = new THREE.AmbientLight(0xffffff, 2);
    if (this.assemblyConstraintHistory) {
      this.assemblyConstraintHistory.clear();
      this.assemblyConstraintHistory.setPartHistory(this);
    }


    // overide the scenes remove method to console log removals along with the stack trace

    const originalRemove = this.scene.remove;
    this.scene.remove = (...args) => {
      //console.log("Removing from scene:", args);
      if (args[0]?.userData?.preventRemove) {
        console.log("Removal prevented by object flag.");
        return;
      }

      //console.trace();
      originalRemove.apply(this.scene, args);
    };

    // overide the scenes add method to console log additions along with the stack trace
    const originalAdd = this.scene.add;
    this.scene.add = (...args) => {
      //console.log("Adding to scene:", args);
      //console.trace();
      originalAdd.apply(this.scene, args);
    };

  }

  static evaluateExpression(expressionsSource, equation) {
    const exprSource = typeof expressionsSource === 'string' ? expressionsSource : '';
    const fnBody = `${exprSource}; return ${equation} ;`;
    try {
      let result = Function(fnBody)();
      if (typeof result === 'string') {
        const num = Number(result);
        if (!Number.isNaN(num)) {
          return num;
        }
      }
      return result;
    } catch (err) {
      try { console.warn('[PartHistory] evaluateExpression failed:', err?.message || err); } catch { }
      return null;
    }
  }

  evaluateExpression(equation) {
    return PartHistory.evaluateExpression(this.expressions, equation);
  }



  getObjectByName(name) {
    // traverse the scene to find an object with the given name
    return this.scene.getObjectByName(name);
  }

  // Removed: getObjectsByName (unused)

  async reset() {
    this.features = [];
    this.idCounter = 0;
    this.pmiViewsManager.reset();
    this.expressions = "//Examples:\nx = 10 + 6; \ny = x * 2;";
    // Reset MetadataManager
    this.metadataManager = new MetadataManager();
    this.currentHistoryStepId = null;

    // empty the scene without destroying it
    await this.scene.clear();
    if (this.callbacks.reset) {
      await this.callbacks.reset();
    }

    if (this.assemblyConstraintHistory) {
      this.assemblyConstraintHistory.clear();
      this.assemblyConstraintHistory.setPartHistory(this);
    }

    // sleep for a short duration to allow scene updates to complete
    //await new Promise(resolve => setTimeout(resolve, 1000));
    // console.log("PartHistory reset complete.");
  }

  async runHistory() {
    const whatStepToStopAt = this.currentHistoryStepId;

    await this.scene.clear();
    // remove all objects from the scene except lights, camera and transform gizmos
    const toRemove = this.scene.children.slice().filter(ch => !ch.isLight && !ch.isCamera && !ch.isTransformGizmo);
    for (const ch of toRemove) {
      console.log("Removing from scene before runHistory:", ch);
      // print the object type and name
      console.log("Object type:", ch.type);
      console.log("Object name:", ch.name);
      this.scene.remove(ch);
    }


    this.scene.add(this.ambientLight);

    let skipAllFeatures = false;
    const features = Array.isArray(this.features) ? this.features : [];
    let previousFeatureTimestamp = features.length ? (features[0]?.timestamp ?? null) : null;
    const nowMs = () => (typeof performance !== 'undefined' && performance?.now ? performance.now() : Date.now());
    for (let i = 0; i < features.length; i++) {
      const feature = features[i];
      if (skipAllFeatures) {
        continue;
      }

      const nextFeature = features[i + 1];

      if (whatStepToStopAt && feature.inputParams.featureID === whatStepToStopAt) {
        skipAllFeatures = true; // stop after this feature
      }

      // Do NOT mutate currentHistoryStepId while running.
      // It is used by the UI to indicate which panel the user wants open
      // (and to determine the stop-at step). Updating it here caused the
      // HistoryWidget to constantly switch the open panel to whatever
      // feature happened to be executing, which made it impossible to
      // expand items after PNG imports and similar long-running steps.

      if (this.callbacks.run) {
        await this.callbacks.run(feature.inputParams.featureID);
      }
      const FeatureClass = this.featureRegistry.getSafe(feature.type);
      if (!FeatureClass) {
        // Record an error on the feature but do not abort the whole run.
        const t1 = nowMs();
        const msg = `Feature type \"${feature.type}\" is not installed`;
        try { feature.lastRun = { ok: false, startedAt: t1, endedAt: t1, durationMs: 0, error: { name: 'MissingFeature', message: msg, stack: null } }; } catch { }
        // Skip visualization/add/remove steps for this feature
        continue;
      }
      const instance = new FeatureClass(this);

      //await Object.assign(instance.inputParams, feature.inputParams);
      await Object.assign(instance.persistentData, feature.persistentData);

      // Remove any existing scene children owned by this feature (rerun case)
      const toRemoveOwned = this.scene.children.slice().filter(ch => ch?.owningFeatureID === feature.inputParams.featureID);
      if (toRemoveOwned.length) {
        for (const ch of toRemoveOwned) this.scene.remove(ch);
      }

      // if the previous feature had a timestamp later than this feature, we mark this feature as dirty to ensure it gets re-run
      if (previousFeatureTimestamp != null && Number.isFinite(feature.timestamp) && previousFeatureTimestamp > feature.timestamp) {
        feature.dirty = true;
      }
      // if the inputParams have changed since last run, mark dirty
      if (JSON.stringify(feature.inputParams) !== feature.lastRunInputParams) feature.dirty = true;

      instance.inputParams = await this.sanitizeInputParams(FeatureClass.inputParamsSchema, feature.inputParams);
      // check the timestamps of any objects referenced by reference_selection inputs; if any are newer than the feature timestamp, mark dirty
      for (const key in FeatureClass.inputParamsSchema) {
        if (Object.prototype.hasOwnProperty.call(FeatureClass.inputParamsSchema, key)) {
          const paramDef = FeatureClass.inputParamsSchema[key];
          if (paramDef.type === 'reference_selection') {
            const selected = Array.isArray(instance.inputParams[key]) ? instance.inputParams[key] : [];
            for (const obj of selected) {
              if (obj && typeof obj === 'object') {
                const objTime = Number(obj.timestamp);
                if (Number.isFinite(objTime) && (!Number.isFinite(feature.timestamp) || objTime > feature.timestamp)) {
                  feature.dirty = true;
                  //alert(`Marking feature ${feature.inputParams.featureID} dirty because referenced object ${obj.name || obj.id || ''} has newer timestamp.`);
                  break;
                }
              }
            }
          }
        }
      }

      // compare any numeric inputParams as evaluated by the sanitizeInputParams method and catch changes due to expressions
      // the instance.inputParams have already been sanitized

      for (const key in FeatureClass.inputParamsSchema) {
        if (Object.prototype.hasOwnProperty.call(FeatureClass.inputParamsSchema, key)) {
          const paramDef = FeatureClass.inputParamsSchema[key];
          if (feature.previouseExpressions === undefined) feature.previouseExpressions = {};
          if (paramDef.type === 'number') {
            try {

              if (feature.previouseExpressions[key] === undefined) feature.dirty = true;
              else if (Number(feature.previouseExpressions[key]) !== Number(instance.inputParams[key])) feature.dirty = true;
              feature.previouseExpressions[key] = instance.inputParams[key];
            } catch {
              feature.dirty = true;
              feature.previouseExpressions[key] = instance.inputParams[key];
            }
          }
        }
      }


      // manually run the sketch feature and then test if the geometry has changed
      // if so, mark dirty
      if (FeatureClass.featureName === 'Sketch') {
        try {
          instance.run(this);
          const sketchChanged = await instance.hasSketchChanged(feature);
          if (sketchChanged) feature.dirty = true;
        } catch (error) {
          console.warn('[PartHistory] Sketch change detection failed:', error);
          feature.dirty = true;
        }
      }

      if (feature.dirty) {
        if (debug) console.log("feature dirty");
        if (debug) console.log(`Running feature ${i + 1}/${features.length} (${feature.inputParams.featureID}) of type ${feature.type}...`, feature);
        // if this one is dirty, next one should be too (conservative)
        if (nextFeature) nextFeature.dirty = true;

        // Record the current input params as lastRunInputParams
        feature.lastRunInputParams = JSON.stringify(feature.inputParams);


        const t0 = nowMs();

        try {
          instance.resultArtifacts = await instance.run(this);
          feature.effects = {
            added: instance.resultArtifacts.added || [],
            removed: instance.resultArtifacts.removed || []
          }


          feature.timestamp = Date.now();
          previousFeatureTimestamp = feature.timestamp;

          const t1 = nowMs();
          const dur = Math.max(0, Math.round(t1 - t0));

          feature.lastRun = { ok: true, startedAt: t0, endedAt: t1, durationMs: dur, error: null };
          feature.dirty = false;
        } catch (e) {
          const t1 = nowMs();
          const dur = Math.max(0, Math.round(t1 - t0));
          feature.lastRun = { ok: false, startedAt: t0, endedAt: t1, durationMs: dur, error: { message: e?.message || String(e), name: e?.name || 'Error', stack: e?.stack || null } };
          feature.timestamp = Date.now();

          previousFeatureTimestamp = feature.timestamp;
          instance.errorString = `Error occurred while running feature ${feature.inputParams.featureID}: ${e.message}`;
          console.error(e);
          return;
        }
      }

      await this.applyFeatureEffects(feature.effects, feature.inputParams.featureID, feature);


      feature.persistentData = instance.persistentData;
    }

    try {
      await this.runAssemblyConstraints();
    } catch (error) {
      console.warn('[PartHistory] Assembly constraints run failed:', error);
    }

    // Do not clear currentHistoryStepId here. Keeping it preserves the UX of
    // "stop at the currently expanded feature" across subsequent runs. The
    // UI will explicitly clear it when no section is expanded.

    return this;
  }


  async _coerceRunEffects(result, featureType, featureID) {
    if (result == null) return { added: [], removed: [] };
    if (Array.isArray(result)) {
      throw new Error(`[PartHistory] Feature "${featureType}" returned an array; expected { added, removed } payload (featureID=${featureID}).`);
    }
    const added = Array.isArray(result.added) ? result.added.filter(Boolean) : [];
    const removed = Array.isArray(result.removed) ? result.removed.filter(Boolean) : [];

    // set the owningFeatureID for each item added by this feature
    for (const artifact of added) {
      artifact.owningFeatureID = featureID;
      try { await artifact.visualize(); } catch { }
      try { await artifact.free(); } catch { }

    }



    return { added, removed };
  }


  async applyFeatureEffects(effects, featureID, feature) {
    if (!effects || typeof effects !== 'object') return;
    const added = Array.isArray(effects.added) ? effects.added : [];
    const removed = Array.isArray(effects.removed) ? effects.removed : [];

    for (const r of removed) {
      await this._safeRemove(r);
    }

    for (const a of added) {
      if (a && typeof a === 'object') {
        try { await a.visualize(); } catch { }
        try { await a.free(); } catch { }
        await this.scene.add(a);
        // make sure the flag for removal is cleared
        try { a.__removeFlag = false; } catch { }




        const applyTimeStampToChildrenRecursively = (obj, timestamp) => {
          if (!obj || typeof obj !== 'object') return;
          try { obj.timestamp = timestamp || Date.now(); } catch { }
          const children = Array.isArray(obj.children) ? obj.children : [];
          for (const child of children) {
            applyTimeStampToChildrenRecursively(child, timestamp);
          }
        };

        // attach the timestamp from the feature to the object for traceability
        try {
          a.timestamp = feature.timestamp;
          applyTimeStampToChildrenRecursively(a, feature.timestamp);
        } catch { }

        this._attachSelectionHandlers(a);
      }
    }

    // apply the featureID to all added/removed items for traceability
    try { for (const obj of added) { if (obj) obj.owningFeatureID = featureID; } } catch { }
    try { for (const obj of removed) { if (obj) obj.owningFeatureID = featureID; } } catch { }


  }

  // Removed unused signature/canonicalization helpers



  _attachSelectionHandlers(obj) {
    if (!obj || typeof obj !== 'object') return;
    obj.onClick = () => {
      try {
        if (obj.type === SelectionFilter.SOLID && obj.parent && obj.parent.type === SelectionFilter.COMPONENT) {
          const handledByParent = SelectionFilter.toggleSelection(obj.parent);
          if (!handledByParent) SelectionFilter.toggleSelection(obj);
          return;
        }
        SelectionFilter.toggleSelection(obj);
      } catch (error) {
        try { console.warn('[PartHistory] toggleSelection failed:', error); }
        catch (_) { /* no-op */ }
      }
    };
    const children = Array.isArray(obj.children) ? obj.children : [];
    for (const child of children) {
      this._attachSelectionHandlers(child);
    }
  }

  _safeRemove(obj) {
    if (!obj) return;
    try {
      if (obj.parent) {
        const rm = obj.parent.remove;
        if (typeof rm === 'function') obj.parent.remove(obj);
        else if (rm !== undefined && THREE?.Object3D?.prototype?.remove) THREE.Object3D.prototype.remove.call(obj.parent, obj);
        else this.scene.remove(obj);
      } else {
        const rm = this.scene.remove;
        if (typeof rm === 'function') this.scene.remove(obj);
        else if (rm !== undefined && THREE?.Object3D?.prototype?.remove) THREE.Object3D.prototype.remove.call(this.scene, obj);
      }
    } catch { }
  }

  // Removed unused _safeAdd and _effectsAppearApplied







  // methods to store and retrieve feature history to JSON strings
  // We will store the features, idCounter, expressions, and optionally PMI views
  async toJSON() {
    const constraintsSnapshot = this.assemblyConstraintHistory?.snapshot?.() || { idCounter: 0, constraints: [] };


    // build features object keeping only the inputParams and persistentData
    const features = this.features.map(f => ({
      type: f.type,
      inputParams: f.inputParams,
      persistentData: f.persistentData,
      timestamp: f.timestamp || null,
    }));
    const pmiViews = this.pmiViewsManager.toSerializable();

    return JSON.stringify({
      features,
      idCounter: this.idCounter,
      expressions: this.expressions,
      pmiViews,
      metadata: this.metadataManager.metadata,
      assemblyConstraints: constraintsSnapshot.constraints,
      assemblyConstraintIdCounter: constraintsSnapshot.idCounter,
    }, null, 2);
  }

  async fromJSON(jsonString) {
    const importData = JSON.parse(jsonString);
    this.features = importData.features;
    this.idCounter = importData.idCounter;
    this.expressions = importData.expressions || "";
    this.pmiViewsManager.setViews(importData.pmiViews || []);
    this.metadataManager.metadata = importData.metadata || {};

    if (this.assemblyConstraintHistory) {
      this.assemblyConstraintHistory.setPartHistory(this);
      const constraintsList = Array.isArray(importData.assemblyConstraints)
        ? importData.assemblyConstraints
        : [];
      const constraintCounter = Number(importData.assemblyConstraintIdCounter) || 0;

      if (constraintsList.length > 0) {
        await this.assemblyConstraintHistory.replaceAll(constraintsList, constraintCounter);
      } else {
        this.assemblyConstraintHistory.clear();
        this.assemblyConstraintHistory.idCounter = constraintCounter;
      }
    }
  }

  async generateId(prefix) {
    this.idCounter += 1;
    return `${prefix}${this.idCounter}`;
  }

  async runAssemblyConstraints() {
    if (!this.assemblyConstraintHistory) return [];
    this.assemblyConstraintHistory.setPartHistory(this);
    return await this.assemblyConstraintHistory.runAll(this);
  }

  syncAssemblyComponentTransforms() {
    if (!this.scene || !Array.isArray(this.features)) return;

    const featureById = new Map();
    for (const feature of this.features) {
      if (!feature || !feature.inputParams) continue;
      const id = feature.inputParams.featureID;
      if (!id && id !== 0) continue;
      featureById.set(String(id), feature);
    }

    const tempEuler = new THREE.Euler();

    const syncOne = (component) => {
      if (!component || !component.isAssemblyComponent) return;
      const featureIdRaw = component.owningFeatureID;
      if (!featureIdRaw && featureIdRaw !== 0) return;
      const feature = featureById.get(String(featureIdRaw));
      if (!feature) return;

      component.updateMatrixWorld?.(true);

      const pos = component.position || new THREE.Vector3();
      const quat = component.quaternion || new THREE.Quaternion();
      const scl = component.scale || new THREE.Vector3(1, 1, 1);

      tempEuler.setFromQuaternion(quat, 'XYZ');

      const transform = {
        position: [pos.x, pos.y, pos.z],
        rotationEuler: [
          THREE.MathUtils.radToDeg(tempEuler.x),
          THREE.MathUtils.radToDeg(tempEuler.y),
          THREE.MathUtils.radToDeg(tempEuler.z),
        ],
        scale: [scl.x, scl.y, scl.z],
      };

      feature.inputParams = feature.inputParams || {};
      feature.inputParams.transform = transform;
    };

    if (typeof this.scene.traverse === 'function') {
      this.scene.traverse((obj) => { syncOne(obj); });
    } else {
      const children = Array.isArray(this.scene.children) ? this.scene.children : [];
      for (const child of children) syncOne(child);
    }
  }

  _collectAssemblyComponentUpdates() {
    if (!Array.isArray(this.features) || this.features.length === 0) {
      return [];
    }

    const updates = [];
    const targetName = String(AssemblyComponentFeature?.featureName || '').trim().toUpperCase();

    for (const feature of this.features) {
      if (!feature || !feature.type) continue;

      let FeatureClass = null;
      try {
        FeatureClass = this.featureRegistry?.getSafe?.(feature.type) || null;
      } catch {
        FeatureClass = null;
      }

      const isAssemblyComponent = FeatureClass === AssemblyComponentFeature
        || (FeatureClass && String(FeatureClass?.featureName || '').trim().toUpperCase() === targetName);
      if (!isAssemblyComponent) continue;

      const componentName = feature?.inputParams?.componentName;
      if (!componentName) continue;

      const record = getComponentRecord(componentName);
      if (!record || !record.data3mf) continue;

      const prevData = feature?.persistentData?.componentData?.data3mf || null;
      const prevSavedAt = feature?.persistentData?.componentData?.savedAt || null;
      const nextSavedAt = record.savedAt || null;

      const prevTime = prevSavedAt ? Date.parse(prevSavedAt) : NaN;
      const nextTime = nextSavedAt ? Date.parse(nextSavedAt) : NaN;

      const hasNewerTimestamp = Number.isFinite(nextTime) && (!Number.isFinite(prevTime) || nextTime > prevTime);
      const hasDifferentData = record.data3mf !== prevData;

      if (!hasNewerTimestamp && !hasDifferentData) continue;

      updates.push({
        feature,
        componentName,
        record,
        nextSavedAt,
      });
    }

    return updates;
  }

  getOutdatedAssemblyComponentCount() {
    return this._collectAssemblyComponentUpdates().length;
  }

  async updateAssemblyComponents(options = {}) {
    const { rerun = true } = options || {};
    const updates = this._collectAssemblyComponentUpdates();
    const updatedCount = updates.length;

    if (updatedCount === 0) {
      return { updatedCount: 0, reran: false };
    }

    for (const { feature, componentName, record, nextSavedAt } of updates) {
      let featureInfo = feature?.persistentData?.componentData?.featureInfo || null;
      try {
        const tempFeature = new AssemblyComponentFeature();
        if (typeof tempFeature._extractFeatureInfo === 'function') {
          const bytes = base64ToUint8Array(record.data3mf);
          if (bytes && bytes.length) {
            const info = await tempFeature._extractFeatureInfo(bytes);
            if (info) featureInfo = info;
          }
        }
      } catch (error) {
        console.warn('[PartHistory] Failed to extract feature info while updating component:', error);
      }

      feature.persistentData = feature.persistentData || {};
      feature.persistentData.componentData = {
        name: record.name || componentName,
        savedAt: nextSavedAt,
        data3mf: record.data3mf,
        featureInfo: featureInfo || null,
      };

      feature.lastRunInputParams = null;
      feature.timestamp = Date.now();
    }

    let reran = false;
    if (rerun && typeof this.runHistory === 'function') {
      await this.runHistory();
      reran = true;
    }

    return { updatedCount, reran };
  }

  async newFeature(featureType) {
    const FeatureClass = (this.featureRegistry && typeof this.featureRegistry.getSafe === 'function')
      ? (this.featureRegistry.getSafe(featureType) || this.featureRegistry.get(featureType))
      : this.featureRegistry.get(featureType);
    const feature = {
      type: featureType,
      inputParams: await extractDefaultValues(FeatureClass.inputParamsSchema),
      persistentData: {}
    };
    feature.inputParams.featureID = await this.generateId(featureType);
    // console.debug("New feature created:", feature.inputParams.featureID);
    this.features.push(feature);
    return feature;
  }

  // Removed unused reorderFeature

  async removeFeature(featureID) {
    this.features = this.features.filter(f => f.inputParams.featureID !== featureID);
  }



  async sanitizeInputParams(schema, inputParams) {

    let sanitized = {};

    for (const key in schema) {
      //console.log(`Sanitizing ${key}:`, inputParams[key]);
      if (inputParams[key] !== undefined) {
        // check if the schema type is number
        if (schema[key].type === "number") {
          // if it is a string use the eval() function to do some math and return it as a number
          sanitized[key] = PartHistory.evaluateExpression(this.expressions, inputParams[key]);
        } else if (schema[key].type === "reference_selection") {
          // Resolve references: accept objects directly or look up by name
          const val = inputParams[key];
          if (Array.isArray(val)) {
            const arr = [];
            for (const it of val) {
              if (!it) continue;
              if (typeof it === 'object') { arr.push(it); continue; }
              const obj = this.getObjectByName(String(it));
              if (obj) arr.push(obj);
            }
            sanitized[key] = arr;
          } else {
            if (!val) { sanitized[key] = []; }
            else if (typeof val === 'object') { sanitized[key] = [val]; }
            else {
              const obj = this.getObjectByName(String(val));
              sanitized[key] = obj ? [obj] : [];
            }
          }

        } else if (schema[key].type === "boolean_operation") {
          // If it's a boolean operation, normalize op key and resolve targets to objects.
          // Also pass through optional biasDistance (numeric) and new sweep cap offset controls.
          const raw = inputParams[key] || {};
          const op = raw.operation;
          const items = Array.isArray(raw.targets) ? raw.targets : [];
          const targets = [];
          for (const it of items) {
            if (!it) continue;
            if (typeof it === 'object') { targets.push(it); continue; }
            const obj = this.getObjectByName(String(it));
            if (obj) targets.push(obj);
          }
          const bias = Number(raw.biasDistance);
          const offsetCapFlag = (raw.offsetCoplanarCap != null) ? String(raw.offsetCoplanarCap) : undefined;
          const offsetDistance = Number(raw.offsetDistance);
          const out = {
            operation: op ?? 'NONE',
            targets,
            biasDistance: Number.isFinite(bias) ? bias : 0.1,
          };
          if (offsetCapFlag !== undefined) out.offsetCoplanarCap = offsetCapFlag;
          if (Number.isFinite(offsetDistance)) out.offsetDistance = offsetDistance;
          sanitized[key] = out;
        } else if (schema[key].type === "transform") {
          // Evaluate each component; allow expressions in position/rotation/scale entries
          const raw = inputParams[key] || {};
          const evalOne = (v) => {
            if (typeof v === 'number' && Number.isFinite(v)) return v;
            if (typeof v === 'string') return PartHistory.evaluateExpression(this.expressions, v);
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
          };
          const pos = Array.isArray(raw.position) ? raw.position.map(evalOne) : [0, 0, 0];
          const rot = Array.isArray(raw.rotationEuler) ? raw.rotationEuler.map(evalOne) : [0, 0, 0];
          const scl = Array.isArray(raw.scale) ? raw.scale.map(evalOne) : [1, 1, 1];
          sanitized[key] = { position: pos, rotationEuler: rot, scale: scl };
        } else if (schema[key].type === "vec3") {
          // Evaluate vec3 entries; accept array [x,y,z] or object {x,y,z}
          const raw = inputParams[key];
          const evalOne = (v) => {
            if (typeof v === 'number' && Number.isFinite(v)) return v;
            if (typeof v === 'string') return PartHistory.evaluateExpression(this.expressions, v);
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
          };
          if (Array.isArray(raw)) {
            sanitized[key] = [evalOne(raw[0]), evalOne(raw[1]), evalOne(raw[2])];
          } else if (raw && typeof raw === 'object') {
            sanitized[key] = [evalOne(raw.x), evalOne(raw.y), evalOne(raw.z)];
          } else {
            sanitized[key] = [0, 0, 0];
          }
        } else if (schema[key].type === "boolean") {
          sanitized[key] = Boolean(Object.prototype.hasOwnProperty.call(inputParams, key) ? inputParams[key] : schema[key].default_value);
        } else {
          sanitized[key] = inputParams[key];
        }
      } else {
        // Clone structured defaults to avoid shared references across features
        sanitized[key] = deepClone(schema[key].default_value);
      }
    }

    return sanitized;
  }
}

// Helper to extract default values using shared deepClone utility
export function extractDefaultValues(schema) {
  const result = {};
  for (const key in schema) {
    if (Object.prototype.hasOwnProperty.call(schema, key)) {
      const def = schema[key] ? schema[key].default_value : undefined;
      result[key] = deepClone(def);
    }
  }
  return result;
}
