//
import * as THREE from 'three';


// Feature classes live in their own files; registry wires them up.
import { FeatureRegistry } from './FeatureRegistry.js';
import { SelectionFilter } from './UI/SelectionFilter.js';
import Stats from 'stats.js';

export class PartHistory {
  constructor() {
    this.features = [];
    this.scene = new THREE.Scene();
    this.idCounter = 0;
    this.featureRegistry = new FeatureRegistry();
    this.callbacks = {};
    this.currentHistoryStepId = null;
    this.expressions = "//Examples:\nx = 10 + 6; \ny = x * 2;";
    this._ambientLight = null;
  }



  getObjectByName(name) {
    // traverse the scene to find an object with the given name
    return this.scene.getObjectByName(name);
  }

  // Removed: getObjectsByName (unused)

  async reset() {
    this.features = [];
    this.idCounter = 0;
    // empty the scene without destroying it
    await this.scene.clear();
    // Clear transient state
    this._ambientLight = null;
    if (this.callbacks.reset) {
      await this.callbacks.reset();
    }


    // sleep for a short duration to allow scene updates to complete
    //await new Promise(resolve => setTimeout(resolve, 1000));
    // console.log("PartHistory reset complete.");
  }

  async runHistory() {
    const whatStepToStopAt = this.currentHistoryStepId;

    await this.scene.clear();
    // add ambient light to scene
    const ambientLight = new THREE.AmbientLight(0xffffff, 2);
    this.scene.add(ambientLight);

    let skipFeature = false;
    let skipAllFeatures = false;
    const nowMs = () => (typeof performance !== 'undefined' && performance?.now ? performance.now() : Date.now());
    for (const feature of this.features) {
      if (skipFeature || skipAllFeatures) {
        continue;
      }

      stats.begin();


      if (whatStepToStopAt && feature.inputParams.featureID === whatStepToStopAt) {
        skipAllFeatures = true; // stop after this feature
      }

      this.currentHistoryStepId = feature.inputParams.featureID;

      if (this.callbacks.run) {
        await this.callbacks.run(feature.inputParams.featureID);
      }
      const FeatureClass = await this.featureRegistry.get(feature.type);
      const instance = new FeatureClass(this);

      await Object.assign(instance.inputParams, feature.inputParams);
      await Object.assign(instance.persistentData, feature.persistentData);

      instance.inputParams = await this.sanitizeInputParams(FeatureClass.inputParamsSchema, feature.inputParams);

      const debugMode = false;

      const t0 = nowMs();
      if (debugMode === true) {
        console.log("Debug mode is enabled");
        try {
          instance.resultArtifacts = await instance.run(this);
          // Normalize compatibility with legacy returns { added, removed }
          const effects = this._normalizeRunResult(instance.resultArtifacts, feature.inputParams.featureID);
          try { for (const r of effects.removed) { if (r) r.remove = true; } } catch { }
          instance.resultArtifacts = effects.added;
          const t1 = nowMs();
          const dur = Math.max(0, Math.round(t1 - t0));
          try {
            feature.lastRun = { ok: true, startedAt: t0, endedAt: t1, durationMs: dur, error: null };
          } catch { }
          try { console.log(`[PartHistory] ${feature.type} #${feature.inputParams.featureID} finished in ${dur} ms`); } catch { }
        } catch (e) {
          const t1 = nowMs();
          const dur = Math.max(0, Math.round(t1 - t0));
          try {
            feature.lastRun = { ok: false, startedAt: t0, endedAt: t1, durationMs: dur, error: { message: e?.message || String(e), name: e?.name || 'Error', stack: e?.stack || null } };
          } catch { }
          instance.errorString = `Error occurred while running feature ${feature.inputParams.featureID}: ${e.message}`;
          console.error(e);
          return;
        }
      } else {
        instance.resultArtifacts = await instance.run(this);
        // Normalize compatibility with legacy returns { added, removed }
        const effects = this._normalizeRunResult(instance.resultArtifacts, feature.inputParams.featureID);
        try { for (const r of effects.removed) { if (r) r.remove = true; } } catch { }
        instance.resultArtifacts = effects.added;
        const t1 = nowMs();
        const dur = Math.max(0, Math.round(t1 - t0));
        try {
          feature.lastRun = { ok: true, startedAt: t0, endedAt: t1, durationMs: dur, error: null };
        } catch { }
        try { console.log(`[PartHistory] ${feature.type} #${feature.inputParams.featureID} finished in ${dur} ms`); } catch { }
      }

      feature.persistentData = instance.persistentData;

      // set the owningFeatureID for each new artifact
      for (const artifact of instance.resultArtifacts) {
        artifact.owningFeatureID = feature.inputParams.featureID;
      }

      // Remove any existing scene children owned by this feature (rerun case)
      const toRemoveOwned = this.scene.children.slice().filter(ch => ch?.owningFeatureID === feature.inputParams.featureID);
      if (toRemoveOwned.length) {
        for (const ch of toRemoveOwned) this.scene.remove(ch);
      }

      // Also remove any scene children flagged for removal (e.g., boolean inputs)
      const flagged = this.scene.children.slice().filter(ch => ch?.remove === true);
      if (flagged.length) {
        for (const ch of flagged) this.scene.remove(ch);
      }

      // add the artifacts to the scene
      for (const artifact of instance.resultArtifacts) {
        await this.scene.add(artifact);

        // MONKEY PATCH .onClick() event on to the artifact
        artifact.onClick = () => {
          SelectionFilter.toggleSelection(artifact);
        };

        // MONKEY PATCH .onClick() to each child of the artifact
        for (const child of artifact.children) {
          child.onClick = () => {
            if (!SelectionFilter.toggleSelection(child.parent)) SelectionFilter.toggleSelection(child);
          };
        }
      }

      // Final sweep: remove any newly-flagged .remove items after adding artifacts
      const flaggedAfter = this.scene.children.slice().filter(ch => ch?.remove === true);
      if (flaggedAfter.length) {
        for (const ch of flaggedAfter) {
          try { this.scene.remove(ch); }
          catch (error) { console.warn(`[PartHistory] Failed to remove flagged child: ${error.message}`); }
        }
      }
      // monitored code goes here
      stats.end();
    }

    return this;
  }

  _ensureAmbientLight() {
    if (this._ambientLight && this.scene.children.includes(this._ambientLight)) return;
    // Remove any stray ambient lights if present
    const strays = this.scene.children.filter(o => o?.isLight && o?.type === 'AmbientLight');
    for (const s of strays) { try { this.scene.remove(s); } catch { } }
    this._ambientLight = new THREE.AmbientLight(0xffffff, 2);
    this.scene.add(this._ambientLight);
  }

  // Removed unused signature/canonicalization helpers

  _normalizeRunResult(result, featureID) {
    const out = { added: [], removed: [] };
    if (!result) return out;
    // New unified shape
    if (typeof result === 'object' && !Array.isArray(result) && (result.added || result.removed)) {
      out.added = Array.isArray(result.added) ? result.added.filter(Boolean) : [];
      out.removed = Array.isArray(result.removed) ? result.removed.filter(Boolean) : [];
      return out;
    }
    // Back-compat: plain array → all are additions
    if (Array.isArray(result)) {
      out.added = result.filter(Boolean);
      return out;
    }
    return out;
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
  // We will only store the features and the idCounter
  async toJSON() {
    return JSON.stringify({
      features: this.features,
      idCounter: this.idCounter,
      expressions: this.expressions
    }, null, 2);
  }

  async fromJSON(jsonString) {
    const importData = JSON.parse(jsonString);
    this.features = importData.features;
    this.idCounter = importData.idCounter;
    this.expressions = importData.expressions || "";
  }

  async generateId(prefix) {
    this.idCounter += 1;
    return `${prefix}${this.idCounter}`;
  }

  async newFeature(featureType) {
    const FeatureClass = this.featureRegistry.get(featureType);
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

    function runCodeAndGetNumber(expressions, equation) {
      //console.log("Running code:", equation);
      const functionString = `${expressions}; return ${equation} ;`;

      try {
        // Wrap the code in a function so the last expression is returned
        let result = Function(functionString)();

        // If it's a string, try to convert it
        if (typeof result === "string") {
          const num = Number(result);
          if (!isNaN(num)) {
            return num; // valid number string -> return as number
          }
        }

        //console.log("Code execution succeeded:", result);
        return result;
      } catch (err) {
        console.log(functionString);
        console.log("Code execution failed:", err.message);
        return null;
      }
    }





    let sanitized = {};

    for (const key in schema) {
      //console.log(`Sanitizing ${key}:`, inputParams[key]);
      if (inputParams[key] !== undefined) {
        // check if the schema type is number
        if (schema[key].type === "number") {
          // if it is a string use the eval() function to do some math and return it as a number
          sanitized[key] = runCodeAndGetNumber(this.expressions, inputParams[key]);
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
        } else {
          sanitized[key] = inputParams[key];
        }
      } else {
        // Clone structured defaults to avoid shared references across features
        sanitized[key] = __deepClone(schema[key].default_value);
      }
    }

    console.log("Sanitized input params:", sanitized);
    return sanitized;
  }
}

// Shallow-safe deep clone for plain objects/arrays used in schema defaults
function __deepClone(value) {
  if (value == null) return value;
  const t = typeof value;
  if (t !== 'object') return value;
  // Arrays
  if (Array.isArray(value)) return value.map(v => __deepClone(v));
  // Plain objects only; leave class instances as-is
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = __deepClone(value[k]);
    return out;
  }
  return value; // fallback: do not clone exotic instances
}

export function extractDefaultValues(schema) {
  const result = {};
  for (const key in schema) {
    if (Object.prototype.hasOwnProperty.call(schema, key)) {
      const def = schema[key] ? schema[key].default_value : undefined;
      result[key] = __deepClone(def);
    }
  }
  return result;
}
var stats = new Stats();
stats.showPanel(0);
stats.showPanel(1); // 0: fps, 1: ms, 2: mb, 3+: custom
stats.showPanel(2);
stats.showPanel(3);

document.body.appendChild(stats.dom);










// Removed unused debug helper logGeometryPoints
