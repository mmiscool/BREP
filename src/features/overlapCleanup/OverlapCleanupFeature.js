import { BREP } from "../../BREP/BREP.js";

const THREE = BREP.THREE;

const inputParamsSchema = {
  id: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the overlap cleanup feature",
  },
  targetSolid: {
    type: "reference_selection",
    selectionFilter: ["SOLID"],
    multiple: false,
    default_value: null,
    hint: "Select a solid to clean up by overlap intersection",
  },
  distance: {
    type: "number",
    default_value: 0.0001,
    step: 0.0001,
    hint: "Translation distance for each axis-shifted copy",
  },
};

export class OverlapCleanupFeature {
  static shortName = "OVL";
  static longName = "Overlap Cleanup";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const scene = partHistory?.scene;
    const targetEntry = Array.isArray(this.inputParams.targetSolid)
      ? (this.inputParams.targetSolid[0] || null)
      : (this.inputParams.targetSolid || null);
    const target = (targetEntry && typeof targetEntry === "object")
      ? targetEntry
      : (targetEntry ? await scene?.getObjectByName(String(targetEntry)) : null);

    if (!target || target.type !== "SOLID") return { added: [], removed: [] };

    const distanceRaw = Number(this.inputParams.distance);
    const distance = Number.isFinite(distanceRaw) ? distanceRaw : 0.0001;
    const featureID = this.inputParams.featureID || this.inputParams.id || null;

    const base = target.clone();
    const copies = [];
    const shifts = [
      [distance, 0, 0],
      [0, distance, 0],
      [0, 0, distance],
    ];

    for (const [dx, dy, dz] of shifts) {
      const copy = target.clone();
      const t = new THREE.Matrix4().makeTranslation(dx, dy, dz);
      copy.bakeTransform(t);
      copies.push(copy);
    }

    const effects = await BREP.applyBooleanOperation(
      partHistory || {},
      base,
      { operation: "INTERSECT", targets: copies },
      featureID,
    );

    const added = Array.isArray(effects.added) ? effects.added : [];
    if (added.length > 0) {
      const result = added[0];
      const baseName = featureID || target.name || "Solid";
      try { result.name = `${baseName}_Overlap`; } catch (_) {}
    }

    const removed = Array.isArray(effects.removed) ? effects.removed.slice() : [];
    removed.push(target);
    try { for (const obj of removed) { if (obj) obj.__removeFlag = true; } } catch {}
    return { added, removed };
  }
}
