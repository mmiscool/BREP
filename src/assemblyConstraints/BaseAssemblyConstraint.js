import * as THREE from 'three';

/**
 * Base class for all assembly constraints. Mirrors the feature/annotation patterns:
 *  - subclasses define static metadata (shortName, longName, constraintType)
 *  - subclasses provide a static inputParamsSchema compatible with SchemaForm
 *  - instances expose `inputParams` and `persistentData` containers updated by the UI/runtime
 */
export class BaseAssemblyConstraint {
  static shortName = 'ACON';
  static longName = 'Assembly Constraint';
  static constraintType = 'assembly_constraint';
  static inputParamsSchema = {
    id: {
      type: 'string',
      default_value: null,
      hint: 'Unique identifier for the constraint.',
    },
  };

  constructor(partHistory = null) {
    this.partHistory = partHistory;
    this.inputParams = {};
    this.persistentData = {};
  }

  /**
   * Convenience accessor for subclasses: tries to resolve a world-space position for a selection.
   * @param {THREE.Object3D|undefined|null} obj
   * @returns {THREE.Vector3|null}
   */
  getWorldPoint(obj) {
    if (!obj) return null;
    try {
      const target = new THREE.Vector3();
      if (typeof obj.getWorldPosition === 'function') {
        obj.getWorldPosition(target);
        return target;
      }
      if (obj.isVector3) {
        return obj.clone();
      }
      if (obj.position) {
        target.copy(obj.position);
        if (obj.parent && obj.parent.isObject3D) {
          obj.parent.updateMatrixWorld?.(true);
          target.applyMatrix4(obj.parent.matrixWorld);
        }
        return target;
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Subclasses override to implement the constraint behaviour.
   * @param {import('../PartHistory.js').PartHistory} partHistory
   * @returns {Promise<unknown>}
   */
  async run(partHistory) { // eslint-disable-line no-unused-vars
    console.warn(`[${this.constructor.name}] run() not implemented.`);
    return null;
  }
}
