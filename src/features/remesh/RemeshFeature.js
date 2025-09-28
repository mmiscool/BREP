 

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the remesh feature",
  },
  targetSolid: {
    type: "reference_selection",
    selectionFilter: ["SOLID"],
    multiple: false,
    default_value: null,
    hint: "Select a solid to remesh (clone is created)",
  },
  maxEdgeLength: {
    type: "number",
    step: 0.1,
    default_value: 1,
    hint: "Split edges longer than this length",
  },
  maxIterations: {
    type: "number",
    step: 1,
    default_value: 10,
    hint: "Maximum refinement passes",
  },
};

export class RemeshFeature {
  static featureShortName = "RM";
  static featureName = "Remesh";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const scene = partHistory.scene;

    // Resolve target solid
    const targetEntry = Array.isArray(this.inputParams.targetSolid)
      ? (this.inputParams.targetSolid[0] || null)
      : (this.inputParams.targetSolid || null);
    const target = (targetEntry && typeof targetEntry === 'object')
      ? targetEntry
      : (targetEntry ? await scene.getObjectByName(String(targetEntry)) : null);

    if (!target || target.type !== 'SOLID') return [];

    const L = Number(this.inputParams.maxEdgeLength);
    const I = Number(this.inputParams.maxIterations);
    const maxEdgeLength = (Number.isFinite(L) && L > 0) ? L : 1;
    const maxIterations = (Number.isFinite(I) && I > 0) ? I : 10;

    // Clone, remesh clone, keep original intact
    const remeshed = target.clone();
    remeshed.remesh({ maxEdgeLength, maxIterations });

    // Name and visualize for UI
    try { remeshed.name = `(${target.name || 'Solid'})`; } catch (_) {}
    try { remeshed.visualize(); } catch (_) {}

    try { target.__removeFlag = true; } catch {}
    return [remeshed];
  }
}
