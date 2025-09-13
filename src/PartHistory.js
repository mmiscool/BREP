//
import * as THREE from 'three';


// Feature classes live in their own files; registry wires them up.
import { FeatureRegistry } from './FeatureRegistry.js';
import { SelectionFilter } from './UI/SelectionFilter.js';

export class PartHistory {
  constructor() {
    this.features = [];
    this.scene = new THREE.Scene();
    this.idCounter = 0;
    this.featureRegistry = new FeatureRegistry();
    this.callbacks = {};
    this.currentHistoryStepId = null;
    this.expressions = "//Examples:\nx = 10 + 6; \ny = x * 2;";
  }



  getObjectByName(name) {
    // traverse the scene to find an object with the given name
    return this.scene.getObjectByName(name);
  }

  getObjectsByName(references) {
    const objects = [];
    for (const ref of references) {
      const obj = this.getObjectByName(ref);
      if (obj) {
        objects.push(obj);
      }
    }
    return objects;
  }

  async reset() {
    this.features = [];
    this.idCounter = 0;
    // empty the scene without destroying it
    await this.scene.clear();
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

    // This method would run the history of features, executing them in order
    // and generating artifacts based on their output.

    let skipFeature = false;
    let skipAllFeatures = false;
    for (const feature of this.features) {



      if (skipFeature || skipAllFeatures) {
        // console.log(`Skipping feature: ${feature.inputParams.featureID}`);
        continue;
      }


      if (whatStepToStopAt && feature.inputParams.featureID === whatStepToStopAt) {
        // console.log(`Stopping history at feature: ${whatStepToStopAt}`);
        skipAllFeatures = true;
      }



      this.currentHistoryStepId = feature.inputParams.featureID;

      if (this.callbacks.run) {
        await this.callbacks.run(feature.inputParams.featureID);
      }
      const FeatureClass = await this.featureRegistry.get(feature.type);
      const instance = new FeatureClass(this);



      await Object.assign(instance.inputParams, feature.inputParams);
      await Object.assign(instance.persistentData, feature.persistentData);

      //console.log(FeatureClass.inputParamsSchema);
      //console.log(instance.inputParams);

      instance.inputParams = await this.sanitizeInputParams(FeatureClass.inputParamsSchema, feature.inputParams);

      const debugMode = false;

      if (debugMode === true) {
        console.log("Debug mode is enabled");
        try {
          instance.resultArtifacts = await instance.run(this);
        } catch (e) {
          instance.errorString = `Error occurred while running feature ${feature.inputParams.featureID}: ${e.message}`;
          console.error(e);
          return
        }
      } else {
        instance.resultArtifacts = await instance.run(this);
      }


      feature.persistentData = instance.persistentData;

      // set the owningFeatureID for each new artifact
      for (const artifact of instance.resultArtifacts) {
        artifact.owningFeatureID = feature.inputParams.featureID;
      }

      // Remove any existing scene children owned by this feature (rerun case)
      // Iterate a copy because we'll mutate scene.children during removal
      const toRemoveOwned = this.scene.children.slice().filter(ch => ch?.owningFeatureID === feature.inputParams.featureID);
      if (toRemoveOwned.length) {
        //console.log(`[PartHistory] Removing ${toRemoveOwned.length} prior artifact(s) owned by`, feature.inputParams.featureID);
        for (const ch of toRemoveOwned) this.scene.remove(ch);
      }

      // Also remove any scene children flagged for removal (e.g., boolean inputs)
      const flagged = this.scene.children.slice().filter(ch => ch?.remove === true);
      if (flagged.length) {
        //console.log(`[PartHistory] Removing ${flagged.length} child(ren) flagged .remove=true`);
        for (const ch of flagged) this.scene.remove(ch);
      }

      // add the artifacts to the scene
      for (const artifact of instance.resultArtifacts) {
        await this.scene.add(artifact);

        // MONKEY PATCH .onClick() event on to the artifact
        artifact.onClick = () => {
          // console.debug("Artifact clicked:", artifact?.name || artifact);
          SelectionFilter.toggleSelection(artifact);
        };

        // MONKEY PATCH .onClick() to each child of the artifact
        for (const child of artifact.children) {
          child.onClick = () => {

            console.debug("Child clicked:", child?.name, child);
            console.log("these are the points", child.points());
            // toggle selection of the parent artifact

            if (!SelectionFilter.toggleSelection(child.parent)) SelectionFilter.toggleSelection(child);
          };
        }

        //console.log("Added artifact to scene:", artifact);
      }

      // Final sweep: remove any newly-flagged .remove items after adding artifacts
      // (some features may flag preexisting items during run)
      const flaggedAfter = this.scene.children.slice().filter(ch => ch?.remove === true);
      if (flaggedAfter.length) {
        // console.debug(`[PartHistory] Post-add removal of ${flaggedAfter.length} flagged child(ren)`);
        for (const ch of flaggedAfter) {
          try {
            this.scene.remove(ch);
          }
          catch (error) {
            console.warn(`[PartHistory] Failed to remove flagged child: ${error.message}`);
          }
        }
      }
    }
    return this;
  }


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

  async reorderFeature(idOfFeatureToMove, idOfFeatureToMoveAfter) {
    const featureToMove = this.features.find(f => f.inputParams.featureID === idOfFeatureToMove);
    if (!featureToMove) {
      throw new Error(`Feature with ID "${idOfFeatureToMove}" not found.`);
    }
    this.features = this.features.filter(f => f.inputParams.featureID !== idOfFeatureToMove);
    const index = this.features.findIndex(f => f.inputParams.featureID === idOfFeatureToMoveAfter);
    if (index === -1) {
      this.features.push(featureToMove);
    } else {
      this.features.splice(index + 1, 0, featureToMove);
    }
  }

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
        } else {
          sanitized[key] = inputParams[key];
        }
      } else {
        sanitized[key] = schema[key].default_value;
      }
    }

    //console.log("Sanitized input params:", sanitized);
    return sanitized;
  }
}

export function extractDefaultValues(schema) {
  const result = {};
  for (const key in schema) {
    if (schema.hasOwnProperty(key)) {
      result[key] = schema[key].default_value;
    }
  }
  return result;
}









function logGeometryPoints(input, { deindex = true, applyWorld = true, unique = false, epsilon = 1e-8 } = {}) {
  const isMesh = !!(input && input.isMesh);
  const geometry = isMesh ? input.geometry : input;

  if (!geometry || !(geometry.isBufferGeometry || geometry.isGeometry)) {
    console.error("Input must be a THREE.Mesh or THREE.(Buffer)Geometry");
    return [];
  }

  // Normalize to BufferGeometry. NOTE: old THREE.Geometry only has its unique vertex list (e.g., 8 for a box).
  let geom;
  if (geometry.isBufferGeometry) {
    geom = geometry;
  } else {
    // Fallback: minimal conversion for legacy THREE.Geometry (positions only).
    // This preserves only the vertex list (no face splitting), so consider upgrading to BufferGeometry.
    const pos = new Float32Array(geometry.vertices.length * 3);
    for (let i = 0; i < geometry.vertices.length; i++) {
      const v = geometry.vertices[i];
      pos[i * 3 + 0] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
    }
    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  }

  // Optionally expand indexed geometry so each triangle corner is a separate point (e.g., box => 24)
  let workGeom = geom;
  if (deindex && workGeom.index) {
    workGeom = workGeom.toNonIndexed(); // creates a clone
  }

  const position = workGeom.attributes.position;
  if (!position) {
    console.warn("Geometry has no position attribute.");
    return [];
  }

  const out = [];
  const seen = unique ? new Set() : null;
  const v = new THREE.Vector3();

  for (let i = 0; i < position.count; i++) {
    v.set(position.getX(i), position.getY(i), position.getZ(i));

    if (applyWorld && isMesh) {
      v.applyMatrix4(input.matrixWorld);
    }

    if (unique) {
      const kx = Math.round(v.x / epsilon) * epsilon;
      const ky = Math.round(v.y / epsilon) * epsilon;
      const kz = Math.round(v.z / epsilon) * epsilon;
      const key = `${kx}|${ky}|${kz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x: kx, y: ky, z: kz });
    } else {
      out.push({ x: v.x, y: v.y, z: v.z });
    }
  }

  console.log(out);
  return out;
}

// Example usage:
// logAllPoints(mesh); // Mesh -> world-space, deindexed (more than 8 for a box)
// logAllPoints(mesh.geometry, { deindex: true, applyWorld: false }); // geometry only, local space
