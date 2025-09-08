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
    selectionFilter: ["FACE", "SKETCH",],
    multiple: false,
    default_value: null,
    hint: "Select the profile to sweep",
  },
  distance: {
    type: "number",
    default_value: 1,
    hint: "Extrude distance when no path is provided",
  },
  boolean: {
    type: "boolean_operation",
    default_value: { targets: [], operation: 'NONE', opperation: 'NONE' },
    hint: "Optional boolean operation with selected solids"
  }
};

export class ExtrudeFeature {
  static featureShortName = "E";
  static featureName = "Extrude";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = extractDefaultValues(inputParamsSchema);

    this.persistentData = {};
  }

  async run(partHistory) {
    // actual code to create the extrude feature.
    const { profile, distance, twistAngle } = this.inputParams;

    // Resolve profile: accept FACE name or a SKETCH group name
    const obj = partHistory.scene.getObjectByName(profile);
    let faceObj = obj;
    if (obj && obj.type === 'SKETCH') {
      // Find child FACE named PROFILE (or any FACE child)
      faceObj = obj.children.find(ch => ch.type === 'FACE') || obj.children.find(ch => ch.userData?.faceName);
    }

    // if the face is a child of a sketch we need to remove the sketch from the scene
    if (faceObj && faceObj.type === 'FACE' && faceObj.parent && faceObj.parent.type === 'SKETCH') faceObj.parent.remove = true;



    // Create the extrude using the sweep solid
    const extrude = new BREP.Sweep({
      face: faceObj,
      sweepPathEdges: [],
      distance: distance * -1,
      name: this.inputParams.featureID
    });
    extrude.visualize();

    // Apply optional boolean operation via shared helper
    return await applyBooleanOperation(partHistory || {}, extrude, this.inputParams.boolean, this.inputParams.featureID);
  }
}
