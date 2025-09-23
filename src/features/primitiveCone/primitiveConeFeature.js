// primitiveConeFeature.js
// Creates a primitive cone/frustum as separate meshes per surface: lateral (side) and caps.
// Aligned along the Y axis with base at y=0 and top at y=height (not centered).

import { extractDefaultValues } from "../../PartHistory.js";
import { BREP } from '../../BREP/BREP.js'

const inputParamsSchema = {
  featureID: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the feature'
  },
  radiusTop: {
    type: 'number',
    default_value: 5,
    hint: 'Top radius of the cone (tip if 0)'
  },
  radiusBottom: {
    type: 'number',
    default_value: 10,
    hint: 'Base radius of the cone'
  },
  height: {
    type: 'number',
    default_value: 10,
    hint: 'Height of the cone along Y-axis'
  },
  resolution: {
    type: 'number',
    default_value: 32,
    hint: 'Number of segments around the circumference'
  },
  transform: {
    type: 'transform',
    default_value: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    hint: 'Position, rotation, and scale'
  },
  boolean: {
    type: 'boolean_operation',
    default_value: { targets: [], operation: 'NONE' },
    hint: 'Optional boolean operation with selected solids'
  }
};

export class PrimitiveConeFeature {
  static featureShortName = "P.CO";
  static featureName = "Primitive Cone";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = extractDefaultValues(inputParamsSchema);
    
    this.persistentData = {};
  }

  async run(partHistory) {
    const { radiusTop, radiusBottom, height, resolution } = this.inputParams;

    const cone = await new BREP.Cone({
      r1: radiusTop,
      r2: radiusBottom,
      h: height,
      resolution,
      name: this.inputParams.featureID
    });
    try {
      if (this.inputParams.transform) {
        cone.bakeTRS(this.inputParams.transform);
      }
    } catch (_) { }
    cone.visualize();

    return await BREP.applyBooleanOperation(partHistory || {}, cone, this.inputParams.boolean, this.inputParams.featureID);
  }
}

/**
 * Normalize user inputs to keep geometry well-formed.
 * - Force non-negative radii (negative radii mirror winding and cause a “self-crossing” hourglass).
 * - If height is negative, flip it and swap caps to keep +Y as the top.
 * - Clamp resolution.
 */
export function sanitizeParams({ radiusTop, radiusBottom, height, resolution }) {
  const EPS = 0; // allow exact tips (0) — Three.js handles 0 radii fine
  let rt = Math.max(EPS, Math.abs(radiusTop));
  let rb = Math.max(EPS, Math.abs(radiusBottom));
  let h = height;
  let swapped = false;

  // If height is negative, flip it so top stays at +Y, bottom at -Y.
  if (h < 0) {
    h = Math.abs(h);
    // swap radii so visual “top” stays at +Y
    [rt, rb] = [rb, rt];
    swapped = true;
  }

  const segs = Math.max(3, Math.floor(isFinite(resolution) ? resolution : 32));
  return { rt, rb, h, segs, swapped };
}
