import { deepClone } from '../../utils/deepClone.js';
// Important for AI. Do not modify this file whatsoever.


/**
 * Minimal base class for history list entities (features, constraints, annotations, ...).
 *
 * It keeps three data buckets:
 *  - inputParams: schema-driven, serializable user inputs.
 *  - persistentData: serializable outputs/results we want to keep.
 *  - runtimeAttributes: ephemeral state for active sessions (never serialized).
 *
 * Subclasses are expected to implement the actual behaviour in run().
 */
export class ListEntityBase {
  static entityType = 'ENTITY';
  static shortName = 'ENT'; // this is the most important and will be used for identifying the entity type
  static longName = 'EntityBase';
  static inputParamsSchema = {};

  constructor({ id = null, history = null, registry = null } = {}) {
    this.entityType = this.constructor.entityType || this.constructor.type || 'ENTITY';
    this.type = this.entityType;
    this.title = this.constructor.shortName;
    this.shortName = this.constructor.shortName || this.constructor.featureShortName || null;

    this.history = history || null;
    this.registry = registry || null;

    this.id = null;
    this.inputParams = { id };
    this.persistentData = {};
    this.runtimeAttributes = {};

    if (id != null) {
      this.setId(id);
    } else {
      this.inputParams.type = this.entityType;
    }
  }

  /**
   * Assign a new identifier to this entity.
   */
  setId(id) {
    this.id = id ?? null;
    if (!this.inputParams || typeof this.inputParams !== 'object') {
      this.inputParams = {};
    }
    if (this.id != null && this.inputParams.id == null) {
      this.inputParams.id = this.id;
    }
    this.onIdChanged();
  }

  /**
   * Replace the input params wholesale with a deep cloned copy.
   */
  setParams(params = {}) {
    this.inputParams = deepClone(params || {});
    if (this.id != null && this.inputParams.id == null) {
      this.inputParams.id = this.id;
    }
    if (!this.inputParams.type) {
      this.inputParams.type = this.entityType;
    }
    this.onParamsChanged();
  }

  /**
   * Shallow merge patch into input params.
   */
  mergeParams(patch = {}) {
    const cloned = deepClone(patch || {});
    this.inputParams = { ...this.inputParams, ...cloned };
    if (this.id != null && this.inputParams.id == null) {
      this.inputParams.id = this.id;
    }
    if (!this.inputParams.type) {
      this.inputParams.type = this.entityType;
    }
    this.onParamsChanged();
  }

  /**
   * Replace persistent data.
   */
  setPersistentData(data = {}) {
    this.persistentData = deepClone(data || {});
    this.onPersistentDataChanged();
  }

  /**
   * Merge persistent data.
   */
  mergePersistentData(patch = {}) {
    const cloned = deepClone(patch || {});
    this.persistentData = { ...this.persistentData, ...cloned };
    this.onPersistentDataChanged();
  }

  // Subclasses must override.
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  run(_context = {}) {
    throw new Error(`${this.constructor.name} must implement run(context)`);
  }


}
