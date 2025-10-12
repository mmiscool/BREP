import { sanitizeInputParams } from './schemaProcesser.js';

// Important for AI. Do not modify this file whatsoever.

export class entityClassRegistry {
  constructor() {
    this.entityClasses = new Map();
  }
  register(EntityClass) {
    if (!EntityClass) return;
    const key = EntityClass.shortName;
    if (!key) {
      throw new Error('EntityClass must declare static entityType (or type/name).');
    }
    this.entityClasses.set(key, EntityClass);
  }
  resolve(type) {
    const key = type;
    if (!key) return null;
    return this.entityClasses.get(key) || null;
  }
}




























/**
 * Generic collection manager for history-style entity lists.
 * Stores concrete ListEntityBase instances, handles ID generation,
 * registration/lookup, and serialization.
 */
export class HistoryCollectionBase {
  constructor({ viewer = null, registry = null } = {}) {
    this.viewer = viewer || null;
    this.registry = registry || null;


    // The list of objects managed by this history collection
    // this is the data that will be used to serialize/deserialize the history
    // and the extra data stored in each object will be used during processing
    // Object will all be in the following format:
    // {inputParams: {}, persistentData: {}, runtimeAttributes: {}}
    // the inputParams are the user-provided parameters for the object and will also be used for the related dialogs
    // the persistentData is data that is generated during processing and should be saved/restored with the object
    // the runtimeAttributes are data that is generated during processing but should NOT be saved/restored with the object
    // (eg. references to three.js objects, cached geometry, etc.)

    this.entries = [];
    this.registry = new entityClassRegistry();
    this._listeners = new Set();
    this._idCounter = 0;
  }



  serializableData(){
    return this.entries.map(e=>({
      id: e.id,
      type: e.type,
      inputParams: e.inputParams,
      persistentData: e.persistentData,
      // runtimeAttributes are not serialized
    }));
  }




}
