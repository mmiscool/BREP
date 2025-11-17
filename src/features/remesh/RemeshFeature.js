 

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
  mode: {
    type: "options",
    options: ["Increase resolution", "Simplify"],
    default_value: "Increase resolution",
    hint: "Choose remeshing mode",
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
  tolerance: {
    type: "number",
    step: 0.1,
    default_value: 0.1,
    hint: "Simplify tolerance (used in Simplify mode)",
  },
};

export class RemeshFeature {
  static shortName = "RM";
  static longName = "Remesh";
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

    if (!target || target.type !== 'SOLID') return { added: [], removed: [] };

    const modeRaw = this.inputParams.mode || 'Increase resolution';
    const mode = String(modeRaw).toLowerCase();

    // Clone target to preserve original
    const outSolid = target.clone();

    if (mode === 'simplify') {
      const T = Number(this.inputParams.tolerance);
      const tol = Number.isFinite(T) && T >= 0 ? T : undefined;
      try {
        if (tol === undefined) outSolid.simplify();
        else outSolid.simplify(tol);
      } catch (e) {
        console.warn('[RemeshFeature] Simplify failed; returning original clone.', e);
      }
    } else {
      const L = Number(this.inputParams.maxEdgeLength);
      const I = Number(this.inputParams.maxIterations);
      const maxEdgeLength = (Number.isFinite(L) && L > 0) ? L : 1;
      const maxIterations = (Number.isFinite(I) && I > 0) ? I : 10;
      try { outSolid.remesh({ maxEdgeLength, maxIterations }); } catch (e) {
        console.warn('[RemeshFeature] Remesh failed; returning original clone.', e);
      }
    }

    // Name and visualize for UI
    try { outSolid.name = `(${target.name || 'Solid'})`; } catch (_) {}
    try { outSolid.visualize(); } catch (_) {}

    try { target.__removeFlag = true; } catch {}
    return { added: [outSolid], removed: [target] };
  }
}
