import { extractDefaultValues } from "../../PartHistory.js";
import { BREP } from "../../BREP/BREP.js";
import { applyBooleanOperation } from "../../BREP/applyBooleanOperation.js";

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the extrude feature",
  },
  profile: {
    type: "reference_selection",
    selectionFilter: ["FACE", "SKETCH"],
    multiple: false,
    default_value: null,
    hint: "Select the profile to extrude",
  },
  distance: {
    type: "number",
    default_value: 1,
    hint: "Extrude distance when no path is provided",
  },
  distanceBack: {
    type: "number",
    default_value: 0,
    hint: "Optional backward extrude distance (two-sided extrude)",
  },
  boolean: {
    type: "boolean_operation",
    default_value: { targets: [], operation: 'NONE' },
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
    const { profile, distance, distanceBack } = this.inputParams;

    // Resolve profile object: accept FACE object or a SKETCH group object
    const obj = Array.isArray(profile) ? (profile[0] || null) : (profile || null);
    let faceObj = obj;
    if (obj && obj.type === 'SKETCH') {
      // Find child FACE named PROFILE (or any FACE child)
      faceObj = obj.children.find(ch => ch.type === 'FACE') || obj.children.find(ch => ch.userData?.faceName);
    }

    const removed = [];
    // if the face is a child of a sketch we need to remove the sketch from the scene
    if (faceObj && faceObj.type === 'FACE' && faceObj.parent && faceObj.parent.type === 'SKETCH') removed.push(faceObj.parent);



    // Create the extrude using the sweep solid
    const extrude = new BREP.ExtrudeSolid({
      face: faceObj,
      distance: distance,
      distanceBack: distanceBack,
      name: this.inputParams.featureID
    });
    extrude.visualize();

    // Apply optional boolean operation via shared helper
    const effects = await applyBooleanOperation(partHistory || {}, extrude, this.inputParams.boolean, this.inputParams.featureID);
    // Flag removals (sketch parent + boolean effects) for PartHistory to collect
    try { for (const obj of [...removed, ...effects.removed]) { if (obj) obj.remove = true; } } catch {}
    // Return only artifacts to add
    return effects.added || [];
  }
}
