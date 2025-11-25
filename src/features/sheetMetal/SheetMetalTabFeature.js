import { BREP } from "../../BREP/BREP.js";
import { normalizeThickness, normalizeBendRadius, applySheetMetalMetadata } from "./sheetMetalMetadata.js";
import { setSheetMetalFaceTypeMetadata, SHEET_METAL_FACE_TYPES, propagateSheetMetalFaceTypesToEdges } from "./sheetMetalFaceTypes.js";
import { resolveProfileFace, collectSketchParents } from "./profileUtils.js";

const inputParamsSchema = {
  id: {
    type: "string",
    default_value: null,
    hint: "Unique identifier for the sheet metal tab",
  },
  profile: {
    type: "reference_selection",
    selectionFilter: ["FACE", "SKETCH"],
    multiple: false,
    default_value: null,
    hint: "Closed sketch or face defining the tab footprint",
  },
  thickness: {
    type: "number",
    default_value: 1,
    min: 0,
    hint: "Sheet metal thickness. Also used as the tab extrusion distance.",
  },
  placementMode: {
    type: "options",
    options: ["forward", "reverse", "midplane"],
    default_value: "forward",
    hint: "Controls whether material is added forward, backward, or split about the sketch plane.",
  },
  bendRadius: {
    type: "number",
    default_value: 0.125,
    min: 0,
    hint: "Default bend radius captured with the sheet-metal base feature.",
  },
  boolean: {
    type: "boolean_operation",
    default_value: { targets: [], operation: "NONE" },
    hint: "Optional boolean operation with existing solids.",
  },
};

export class SheetMetalTabFeature {
  static shortName = "SM.TAB";
  static longName = "Sheet Metal Tab";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const faceObj = resolveProfileFace(this.inputParams?.profile, partHistory);
    if (!faceObj) {
      throw new Error("Sheet Metal Tab requires a valid FACE or SKETCH selection.");
    }

    const sketchParentsToRemove = collectSketchParents(faceObj);
    const { magnitude: thicknessAbs, signed: signedThickness } = normalizeThickness(
      this.inputParams?.thickness ?? 1
    );
    const bendRadius = normalizeBendRadius(this.inputParams?.bendRadius ?? 0.125);
    const placement = resolvePlacementMode(this.inputParams?.placementMode, signedThickness);
    const extrudeDistances = toExtrudeDistances(thicknessAbs, placement);

    const sweep = new BREP.Sweep({
      face: faceObj,
      distance: extrudeDistances.distance,
      distanceBack: extrudeDistances.distanceBack,
      mode: "translate",
      name: this.inputParams?.featureID,
      omitBaseCap: false,
    });
    sweep.visualize();
    tagTabFaceTypes(sweep);

    const effects = await BREP.applyBooleanOperation(
      partHistory || {},
      sweep,
      this.inputParams?.boolean,
      this.inputParams?.featureID
    );

    const removedArtifacts = [...sketchParentsToRemove, ...(effects?.removed || [])];
    const added = effects?.added || [];

    propagateSheetMetalFaceTypesToEdges(added);

    applySheetMetalMetadata(added, partHistory?.metadataManager, {
      featureID: this.inputParams?.featureID || null,
      thickness: thicknessAbs,
      bendRadius,
      baseType: "TAB",
      extra: { placementMode: placement, signedThickness },
      forceBaseOverwrite: true,
    });

    this.persistentData = this.persistentData || {};
    this.persistentData.sheetMetal = {
      baseType: "TAB",
      thickness: thicknessAbs,
      bendRadius,
      placementMode: placement,
      signedThickness,
      profileName: faceObj?.name || null,
    };

    // Flag removed parents so history cleans them up
    try {
      for (const obj of removedArtifacts) {
        if (obj) obj.__removeFlag = true;
      }
    } catch { /* flag optional */ }

    return { added, removed: removedArtifacts };
  }
}

function resolvePlacementMode(requested, signedThickness) {
  const normalized = String(requested || "").toLowerCase();
  if (normalized === "forward" || normalized === "reverse" || normalized === "midplane") {
    return normalized;
  }
  return signedThickness < 0 ? "reverse" : "forward";
}

function toExtrudeDistances(thickness, placementMode) {
  if (placementMode === "reverse") return { distance: 0, distanceBack: thickness };
  if (placementMode === "midplane") {
    const half = thickness / 2;
    return { distance: half, distanceBack: half };
  }
  return { distance: thickness, distanceBack: 0 };
}

function tagTabFaceTypes(sweep) {
  if (!sweep || typeof sweep.getFaceNames !== "function") return;
  const faceNames = sweep.getFaceNames();
  const startFaces = faceNames.filter((name) => name.endsWith("_START"));
  const endFaces = faceNames.filter((name) => name.endsWith("_END"));
  const thicknessFaces = faceNames.filter((name) => name.endsWith("_SW"));
  setSheetMetalFaceTypeMetadata(sweep, startFaces, SHEET_METAL_FACE_TYPES.A);
  setSheetMetalFaceTypeMetadata(sweep, endFaces, SHEET_METAL_FACE_TYPES.B);
  setSheetMetalFaceTypeMetadata(sweep, thicknessFaces, SHEET_METAL_FACE_TYPES.THICKNESS);
}
