// BaseAnnotation.js
// Base class for all PMI annotations following the feature pattern

export class BaseAnnotation {
  static featureShortName = "ANN";
  static featureName = "Annotation";
  static inputParamsSchema = {
    annotationID: {
      type: "string",
      default_value: null,
      hint: "unique identifier for the annotation",
    }
  };

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
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

  // Schema validation helpers
  static getSchema(pmimode, ann) {
    // Default implementation returns the class schema
    // Subclasses can override for dynamic schema generation
    const schema = {};
    const params = {};
    
    for (const key in this.inputParamsSchema) {
      const def = this.inputParamsSchema[key];
      schema[key] = { ...def };
      params[key] = def.default_value;
    }
    
    return { schema, params };
  }

  static applyParams(pmimode, ann, params) {
    // Default implementation copies params to annotation
    // Subclasses can override for custom parameter handling
    Object.assign(ann, params);
    return { paramsPatch: {}, statusText: '' };
  }

  static statusText(pmimode, ann) {
    // Default status text
    return ann.annotationID || '';
  }
}