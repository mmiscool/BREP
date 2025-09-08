import { extractDefaultValues } from "../../PartHistory.js";
import { BREP } from "../../BREP/BREP.js";
import { applyBooleanOperation } from "../../BREP/applyBooleanOperation.js";

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the sweep feature",
  },
  profile: {
    type: "reference_selection",
    selectionFilter: ["SKETCH", "FACE"],
    multiple: false,
    default_value: null,
    hint: "Select the profile to sweep",
  },
  path: {
    type: "reference_selection",
    selectionFilter: ["EDGE"],
    multiple: false,
    default_value: null,
    hint: "Select the path to sweep along",
  },
  distance: {
    type: "number",
    default_value: 1,
    hint: "Extrude distance when no path is provided",
  },
  twistAngle: {
    type: "number",
    default_value: 0,
    hint: "Twist angle for the sweep",
  },
  boolean: {
    type: "boolean_operation",
    default_value: { targets: [], operation: 'NONE', opperation: 'NONE' },
    hint: "Optional boolean operation with selected solids"
  }
};

export class SweepFeature {
  static featureShortName = "SW";
  static featureName = "Sweep";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = extractDefaultValues(inputParamsSchema);
    
    this.persistentData = {};
  }

  async run(partHistory) {
    // actual code to create the sweep feature.
    const { profile, path, distance, twistAngle } = this.inputParams;

    console.log(profile);

    // Create the sweep solid
    const sweep = new BREP.Sweep({
      face: partHistory.scene.getObjectByName(profile),
      sweepPathEdges: path ? [partHistory.scene.getObjectByName(path)] : [],
      distance,
      name: this.inputParams.featureID
    });
    sweep.visualize();

    // Apply optional boolean operation via shared helper
    return await applyBooleanOperation(partHistory || {}, sweep, this.inputParams.boolean, this.inputParams.featureID);
  }
}
