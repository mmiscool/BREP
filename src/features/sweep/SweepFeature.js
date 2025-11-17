import { BREP } from "../../BREP/BREP.js";

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
    multiple: true,
    default_value: null,
    hint: "Select one or more edges to define the sweep path (connected edges are chained)",
  },
  orientationMode: {
    type: "options",
    options: ["translate", "pathAlign"],
    default_value: "translate",
    hint: "Sweep orientation mode: 'translate' (fixed) or 'pathAlign' (profile aligns and rotates with path)",
  },
  twistAngle: {
    type: "number",
    default_value: 0,
    hint: "Twist angle for the sweep",
  },
  boolean: {
    type: "boolean_operation",
    default_value: { targets: [], operation: 'NONE' },
    hint: "Optional boolean operation with selected solids"
  }
};

export class SweepFeature {
  static shortName = "SW";
  static longName = "Sweep";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    // actual code to create the sweep feature.
    const { profile, path, twistAngle, orientationMode } = this.inputParams;

    // Require a valid path edge; sweep now only follows a path
    const pathArr = Array.isArray(path) ? path.filter(Boolean) : (path ? [path] : []);
    if (!pathArr.length) {
      throw new Error('Sweep requires a path edge selection. Please select an EDGE to sweep along.');
    }

    // Resolve profile object: accept FACE or SKETCH group object
    const obj = Array.isArray(profile) ? (profile[0] || null) : (profile || null);
    let faceObj = obj;
    if (obj && obj.type === 'SKETCH') {
      faceObj = obj.children.find(ch => ch.type === 'FACE') || obj.children.find(ch => ch.userData?.faceName);
    }

    const removed = [];
    // if the face is a child of a sketch we need to remove the sketch from the scene
    if (faceObj && faceObj.type === 'FACE' && faceObj.parent && faceObj.parent.type === 'SKETCH') removed.push(faceObj.parent);

    // Create the sweep solid
    const sweep = new BREP.Sweep({
      face: faceObj,
      sweepPathEdges: pathArr,
      mode: (orientationMode === 'pathAlign') ? 'pathAlign' : 'translate',
      name: this.inputParams.featureID
    });
    // Build and show the solid. Let errors surface so we can debug if needed.
    sweep.visualize();

    // Apply optional boolean operation via shared helper
    const effects = await BREP.applyBooleanOperation(partHistory || {}, sweep, this.inputParams.boolean, this.inputParams.featureID);
    effects.removed = [...removed, ...effects.removed];
    return effects;
  }
}
