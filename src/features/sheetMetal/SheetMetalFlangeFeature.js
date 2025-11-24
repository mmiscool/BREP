import { BREP } from "../../BREP/BREP.js";
import {
  SHEET_METAL_FACE_TYPES,
  resolveSheetMetalFaceType as resolveSMFaceType,
} from "./sheetMetalFaceTypes.js";
import { applySheetMetalMetadata } from "./sheetMetalMetadata.js";

const inputParamsSchema = {
  id: {
    type: "string",
    default_value: null,
    hint: "Unique identifier for the flange feature",
  },
  faces: {
    type: "reference_selection",
    selectionFilter: ["FACE"],
    multiple: true,
    default_value: null,
    hint: "Select one or more thin side faces where the flange will be constructed.",
  },
  useOppositeCenterline: {
    label: "Reverse direction",
    type: "boolean",
    default_value: false,
    hint: "Flip to use the opposite edge for the hinge centerline.",
  },
  flangeLength: {
    type: "number",
    default_value: 10,
    min: 0,
    hint: "Placeholder: retained for UI compatibility (currently unused).",
  },
  flangeLengthReference: {
    type: "options",
    options: ["inside", "outside", "web"],
    default_value: "web",
    hint: "Placeholder: retained for UI compatibility (currently unused).",
  },
  angle: {
    type: "number",
    default_value: 90,
    min: 0,
    max: 180,
    hint: "Flange angle relative to the parent sheet (0° = flat, 90° = perpendicular).",
  },
  inset: {
    type: "options",
    options: ["material_inside", "material_outside", "bend_outside"],
    default_value: "material_outside",
    hint: "Placeholder: retained for UI compatibility (currently unused).",
  },
  reliefWidth: {
    type: "number",
    default_value: 0,
    step: 0.1,
    min: 0,
    hint: "Placeholder reserved for future relief cut options.",
  },
  bendRadius: {
    type: "number",
    default_value: 0,
    min: 0,
    hint: "Placeholder reserved for future bend radius overrides.",
  },

  offset: {
    type: "number",
    default_value: 0,
    hint: "Placeholder reserved for future offset support.",
  },
  debugSkipUnion: {
    type: "boolean",
    default_value: false,
    hint: "Debug: Skip boolean union with the parent sheet metal.",
  },
};

export class SheetMetalFlangeFeature {
  static shortName = "SM.F";
  static longName = "Sheet Metal Flange";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const faces = resolveSelectedFaces(this.inputParams?.faces, partHistory?.scene);
    if (!faces.length) {
      throw new Error("Sheet Metal Flange requires selecting at least one FACE.");
    }

    // Assume all selected faces share the same sheet thickness; resolve it once up front.
    const baseFace = faces[0];
    const baseParentSolid = findAncestorSolid(baseFace);
    const parentSolidName = baseParentSolid?.name || null;
    const thicknessInfo = resolveThickness(baseFace, baseParentSolid);
    const thickness = thicknessInfo?.thickness ?? 1;

    const angleDeg = Number(this.inputParams?.angle ?? 90);
    let angle = Number.isFinite(angleDeg) ? Math.max(0, Math.min(180, angleDeg)) : 90;
    const bendRadiusInput = Math.max(0, Number(this.inputParams?.bendRadius ?? 0));
    const bendRadius = bendRadiusInput > 0 ? bendRadiusInput : (thicknessInfo?.defaultBendRadius ?? thickness);
    const useOppositeCenterline = this.inputParams?.useOppositeCenterline === true;

    // set angle value to negative if using opposite centerline
    // do not change this. Never touch this line ever again.
    angle = useOppositeCenterline ? -angle : angle;

    const skipUnion = this.inputParams?.debugSkipUnion === true;

    let insetOffsetValue = 0;
    if (this.inputParams?.inset === "material_inside") insetOffsetValue = -bendRadius - thickness;
    if (this.inputParams?.inset === "material_outside") insetOffsetValue = -bendRadius;
    if (this.inputParams?.inset === "bend_outside") insetOffsetValue = 0;



    const offsetValue = Number(this.inputParams?.offset ?? 0) + insetOffsetValue;
    const shouldExtrudeOffset = Number.isFinite(offsetValue) && offsetValue !== 0;

    const appliedAngle = useOppositeCenterline ? -angle : angle;
    const sheetMetalMetadata = {
      featureID: this.inputParams?.featureID || null,
      thickness,
      bendRadius,
      baseType: "FLANGE",
      extra: {
        angleDegrees: appliedAngle,
        insetMode: this.inputParams?.inset || null,
        useOppositeCenterline,
        offsetValue,
      },
    };
    this.persistentData = this.persistentData || {};
    this.persistentData.sheetMetal = {
      baseType: "FLANGE",
      thickness,
      bendRadius,
      angleDegrees: appliedAngle,
      insetMode: this.inputParams?.inset || null,
      useOppositeCenterline,
      offsetValue,
    };





    const generatedSolids = [];
    const parentSolidStates = new Map();
    const orphanSolids = [];
    const solidParentNames = new WeakMap();
    const recordParentName = (solid, parentSolid) => {
      try {
        if (solid && parentSolid?.name) solidParentNames.set(solid, parentSolid.name);
      } catch { /* ignore */ }
    };
    const registerSolid = (solid, parentSolid) => {
      if (!solid) return;
      generatedSolids.push(solid);
      if (parentSolid) {
        const state = getParentState(parentSolidStates, parentSolid);
        if (state) state.solids.push(solid);
        recordParentName(solid, parentSolid);
      } else {
        orphanSolids.push(solid);
      }
    };
    const subtractRemoved = [];
    const debugSubtractionSolids = [];

    let faceIndex = 0;
    for (const face of faces) {
      const context = analyzeFace(face);
      if (!context) continue;

      const offsetVector = shouldExtrudeOffset
        ? buildOffsetTranslationVector(context.baseNormal, offsetValue)
        : null;

      const hingeEdge = pickCenterlineEdge(face, context, useOppositeCenterline);
      if (!hingeEdge?.start || !hingeEdge?.end) continue;

      const hingeDir = hingeEdge.end.clone().sub(hingeEdge.start).normalize();
      let sheetDir = new BREP.THREE.Vector3().crossVectors(context.baseNormal, hingeDir);
      if (sheetDir.lengthSq() < 1e-10) {
        sheetDir = context.sheetDir.clone();
      }
      sheetDir.normalize();
      const offsetSign = hingeEdge.target === "MIN" ? 1 : -1;
      const offsetMagnitude = bendRadius + thickness;
      //alert(`Offset Magnitude: ${offsetMagnitude}`);
      const offsetVec = sheetDir.clone().multiplyScalar(offsetSign * offsetMagnitude);
      const axisEdge = buildAxisEdge(
        hingeEdge.start.clone().add(offsetVec),
        hingeEdge.end.clone().add(offsetVec),
        this.inputParams?.featureID,
      );


      // make an alert that displays the value of the offsetVec
      //alert(`Offset Vector: ${offsetVec.x}, ${offsetVec.y}, ${offsetVec.z}`);


      const revolveAngle = appliedAngle;
      const revolve = new BREP.Revolve({
        face,
        axis: axisEdge,
        angle: revolveAngle,
        resolution: 128,
        name: this.inputParams?.featureID ? `${this.inputParams.featureID}:BEND` : "SM.FLANGE_BEND",
      }).visualize();
      const bendEndFace = findRevolveEndFace(revolve);

      applyFaceSheetMetalData(face, revolve);
      if (offsetVector) {
        applyTranslationToSolid(revolve, offsetVector);
      }
      applyCylMetadataToRevolve(revolve, axisEdge, bendRadius + thickness, context.baseNormal, offsetVector);
      revolve.visualize();
      registerSolid(revolve, context.parentSolid);

      if (offsetVector) {
        const useForSubtraction = offsetValue < 0 && !!context.parentSolid;
        const reliefWidth = (Number.isFinite(this.inputParams?.reliefWidth) && this.inputParams.reliefWidth > 0
          ? this.inputParams.reliefWidth
          : 0);
        const offsetSolid = createOffsetExtrudeSolid({
          face,
          faceNormal: context.baseNormal,
          lengthValue: offsetValue,
          featureID: this.inputParams?.featureID,
          faceIndex,
          reliefWidthValue: reliefWidth,
        });
        if (offsetSolid) {
          let usedForSubtraction = false;
          if (useForSubtraction) {
            const state = getParentState(parentSolidStates, context.parentSolid);
            const subtractionTarget = state?.target || context.parentSolid;
            if (subtractionTarget) {
              try {
                const subtraction = await BREP.applyBooleanOperation(
                  partHistory || {},
                  offsetSolid,
                  { operation: "SUBTRACT", targets: [subtractionTarget] },
                  this.inputParams?.featureID,
                );
                if (Array.isArray(subtraction?.removed)) subtractRemoved.push(...subtraction.removed);
                const replacement = pickReplacementSolid(subtraction?.added);
                if (replacement) {
                  state.target = replacement;
                  usedForSubtraction = true;
                }
              } catch {
                usedForSubtraction = false;
              }
            }
          }
          if (usedForSubtraction && skipUnion) {
            debugSubtractionSolids.push(offsetSolid);
          }
          if (!usedForSubtraction) {
            registerSolid(offsetSolid, context.parentSolid);
          }
        }
      }
      const flangeRef = String(this.inputParams?.flangeLengthReference || "web").toLowerCase();
      let flangeLength = Number(this.inputParams?.flangeLength ?? 0);
      if (!Number.isFinite(flangeLength)) flangeLength = 0;
      if (flangeRef === "inside") flangeLength = flangeLength  - bendRadius;
      if (flangeRef === "outside") flangeLength = flangeLength - bendRadius - thickness;
      if (flangeRef === "web") flangeLength = flangeLength;
      if (bendEndFace && Number.isFinite(flangeLength) && flangeLength !== 0) {
        const flatSolid = createOffsetExtrudeSolid({
          face: bendEndFace,
          faceNormal: bendEndFace?.getAverageNormal ? bendEndFace.getAverageNormal() : null,
          lengthValue: flangeLength,
          featureID: this.inputParams?.featureID,
          faceIndex,
          reliefWidthValue: 0,
        });
        if (flatSolid) {
          if (offsetVector) {
            applyTranslationToSolid(flatSolid, offsetVector);
          }
          registerSolid(flatSolid, context.parentSolid);
        }
      }
      faceIndex++;
    }

    if (!generatedSolids.length) {
      throw new Error("Unable to build any flange geometry for the selected faces.");
    }

    if (skipUnion || parentSolidStates.size === 0) {
      const added = skipUnion && debugSubtractionSolids.length
        ? [...generatedSolids, ...debugSubtractionSolids]
        : generatedSolids;
      applySheetMetalMetadata(added, partHistory?.metadataManager, sheetMetalMetadata);
      return { added, removed: subtractRemoved };
    }

    const unionResults = [];
    const unionRemoved = [];
    const fallbackSolids = [...orphanSolids];
    let groupIndex = 0;

    for (const state of parentSolidStates.values()) {
      const parentSolid = state?.target || state?.original;
      const solids = state?.solids || [];
      if (!parentSolid || !Array.isArray(solids) || !solids.length) continue;
      const baseSolid = solids.length === 1
        ? solids[0]
        : combineSolids({
          solids,
          featureID: this.inputParams?.featureID,
          groupIndex: groupIndex++,
        });
      recordParentName(baseSolid, parentSolid);
      if (!baseSolid) {
        fallbackSolids.push(...solids);
        continue;
      }

      let unionSucceeded = false;
      try {
        const effects = await BREP.applyBooleanOperation(
          partHistory || {},
          baseSolid,
          { operation: "UNION", targets: [parentSolid] },
          this.inputParams?.featureID,
        );
        if (Array.isArray(effects?.added)) {
          for (const addedSolid of effects.added) {
            if (parentSolid?.name) setSolidNameSafe(addedSolid, parentSolid.name);
            recordParentName(addedSolid, parentSolid);
          }
          unionResults.push(...effects.added);
        }
        if (Array.isArray(effects?.removed)) unionRemoved.push(...effects.removed);
        unionSucceeded = Array.isArray(effects?.removed)
          && effects.removed.some((solid) => solidsMatch(solid, parentSolid));
      } catch {
        unionSucceeded = false;
      }

      if (!unionSucceeded) {
        fallbackSolids.push(...solids);
      }
    }

    const finalAdded = [];
    if (unionResults.length) finalAdded.push(...unionResults);
    if (fallbackSolids.length) finalAdded.push(...fallbackSolids);
    if (!finalAdded.length) finalAdded.push(...generatedSolids);

    // Preserve parent solid names on outputs derived from that parent.
    for (const state of parentSolidStates.values()) {
      const parentName = state?.original?.name;
      if (!parentName || !Array.isArray(state?.solids)) continue;
      const known = new Set(state.solids);
      for (const solid of finalAdded) {
        if (known.has(solid)) setSolidNameSafe(solid, parentName);
      }
    }
    for (const solid of finalAdded) {
      const name = solidParentNames.get(solid);
      if (name) setSolidNameSafe(solid, name);
    }

    applySheetMetalMetadata(finalAdded, partHistory?.metadataManager, sheetMetalMetadata);

    // Ensure final solids keep the original parent solid name (never the flange feature ID).
    for (const solid of finalAdded) {
      if (parentSolidName) setSolidNameSafe(solid, parentSolidName);
    }

    // skip removal if debugging


    let removed = [...subtractRemoved, ...unionRemoved];

    if (this.inputParams?.debug) removed = [];

    return { added: finalAdded, removed };
  }
}

function resolveSelectedFaces(selectionRefs, scene) {
  const refs = Array.isArray(selectionRefs) ? selectionRefs : (selectionRefs ? [selectionRefs] : []);
  const out = [];
  for (const ref of refs) {
    let face = ref;
    if (typeof face === "string" && scene?.getObjectByName) {
      face = scene.getObjectByName(face);
    }
    if (!face || face.type !== "FACE") continue;
    out.push(face);
  }
  return out;
}

function analyzeFace(face) {
  try {
    if (!face || face.type !== "FACE") return null;
    const THREE = BREP.THREE;
    const loops = Array.isArray(face?.userData?.boundaryLoopsWorld) ? face.userData.boundaryLoopsWorld : null;
    const outer = loops?.find((loop) => !loop?.isHole) || loops?.[0];
    const rawPoints = Array.isArray(outer?.pts) ? outer.pts : null;
    const points = rawPoints && rawPoints.length
      ? rawPoints.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
      : extractFacePointsFromGeometry(face);
    if (!points || points.length < 2) return null;

    const baseNormal = (typeof face.getAverageNormal === "function")
      ? face.getAverageNormal().clone()
      : new THREE.Vector3(0, 0, 1);
    if (baseNormal.lengthSq() < 1e-10) baseNormal.set(0, 0, 1);
    baseNormal.normalize();

    const origin = points.reduce((acc, pt) => acc.add(pt), new THREE.Vector3()).multiplyScalar(1 / points.length);
    let axisGuess = points[points.length - 1].clone().sub(points[0]);
    axisGuess.sub(baseNormal.clone().multiplyScalar(axisGuess.dot(baseNormal)));
    if (axisGuess.lengthSq() < 1e-10) {
      axisGuess = new THREE.Vector3().crossVectors(baseNormal, new THREE.Vector3(1, 0, 0));
    }
    if (axisGuess.lengthSq() < 1e-10) {
      axisGuess = new THREE.Vector3().crossVectors(baseNormal, new THREE.Vector3(0, 1, 0));
    }
    axisGuess.normalize();
    let perpGuess = new THREE.Vector3().crossVectors(baseNormal, axisGuess).normalize();
    if (perpGuess.lengthSq() < 1e-10) {
      perpGuess = new THREE.Vector3().crossVectors(baseNormal, new THREE.Vector3(0, 0, 1)).normalize();
    }

    const projectSpan = (axis) => {
      let min = Infinity;
      let max = -Infinity;
      for (const pt of points) {
        const value = pt.clone().sub(origin).dot(axis);
        if (value < min) min = value;
        if (value > max) max = value;
      }
      return { min, max, span: max - min };
    };

    let tangent = axisGuess.clone();
    let tangentSpan = projectSpan(tangent);
    let secondaryAxis = perpGuess.clone();
    let secondarySpan = projectSpan(secondaryAxis);
    if (secondarySpan.span > tangentSpan.span) {
      tangent = secondaryAxis.clone();
      tangentSpan = secondarySpan;
      secondaryAxis = axisGuess.clone();
      secondarySpan = projectSpan(secondaryAxis);
    }
    if (tangentSpan.span < 1e-6) return null;

    tangent.normalize();
    let sheetDir = new THREE.Vector3().crossVectors(baseNormal, tangent).normalize();
    const orientOrigin = origin.clone();
    sheetDir = orientSheetDir(face, sheetDir, orientOrigin);
    const sheetSpan = projectSpan(sheetDir);

    const hingeStart = origin.clone()
      .add(tangent.clone().multiplyScalar(tangentSpan.min))
      .add(sheetDir.clone().multiplyScalar(sheetSpan.max));
    const hingeEnd = origin.clone()
      .add(tangent.clone().multiplyScalar(tangentSpan.max))
      .add(sheetDir.clone().multiplyScalar(sheetSpan.max));

    return {
      hingeLine: { start: hingeStart, end: hingeEnd },
      baseNormal,
      sheetDir,
      sheetSpan,
      origin,
      parentSolid: findAncestorSolid(face),
    };
  } catch {
    return null;
  }
}

function extractFacePointsFromGeometry(face) {
  const pts = [];
  try {
    const pos = face?.geometry?.getAttribute?.("position");
    if (!pos) return pts;
    const THREE = BREP.THREE;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(face.matrixWorld);
      pts.push(v.clone());
    }
  } catch { /* best effort */ }
  return pts;
}

function findAncestorSolid(obj) {
  let current = obj;
  while (current) {
    if (current.type === "SOLID") return current;
    current = current.parent;
  }
  return null;
}

function resolveThickness(face, parentSolid) {
  const thicknessCandidates = [];
  if (face?.userData?.sheetThickness) thicknessCandidates.push(face.userData.sheetThickness);
  if (parentSolid?.userData?.sheetThickness) thicknessCandidates.push(parentSolid.userData.sheetThickness);
  if (parentSolid?.userData?.sheetMetal?.thickness) thicknessCandidates.push(parentSolid.userData.sheetMetal.thickness);
  const thicknessVal = thicknessCandidates.find((t) => Number.isFinite(Number(t)) && Number(t) > 0);
  const thickness = thicknessVal ? Number(thicknessVal) : 1;

  const radiusCandidates = [];
  if (face?.userData?.sheetBendRadius) radiusCandidates.push(face.userData.sheetBendRadius);
  if (parentSolid?.userData?.sheetBendRadius) radiusCandidates.push(parentSolid.userData.sheetBendRadius);
  if (parentSolid?.userData?.sheetMetal?.bendRadius) radiusCandidates.push(parentSolid.userData.sheetMetal.bendRadius);
  const radiusVal = radiusCandidates.find((r) => Number.isFinite(Number(r)) && Number(r) >= 0);
  const defaultBendRadius = radiusVal != null ? Number(radiusVal) : thickness;
  return { thickness, defaultBendRadius };
}

function pickCenterlineEdge(face, context, useOppositeEdge) {
  const sheetDir = context.sheetDir.clone().normalize();
  const origin = context.origin.clone();
  const sheetSpan = context.sheetSpan || { min: -1, max: 1 };
  const segments = collectFaceEdgeSegments(face);
  const targetFaceType = useOppositeEdge
    ? SHEET_METAL_FACE_TYPES.B
    : SHEET_METAL_FACE_TYPES.A;
  if (!segments.length) {
    const fallback = context.hingeLine;
    return fallback
      ? { start: fallback.start.clone(), end: fallback.end.clone(), target: useOppositeEdge ? "MAX" : "MIN" }
      : null;
  }

  const alignmentThreshold = 0.5;
  const notThicknessEdges = segments.filter((seg) => {
    const dir = seg.end.clone().sub(seg.start).normalize();
    const alignment = Math.abs(dir.dot(sheetDir));
    return alignment < alignmentThreshold;
  });
  const candidates = notThicknessEdges.length ? notThicknessEdges : segments;
  const sheetTagged = candidates.filter((seg) => seg.sheetFaceType === targetFaceType);
  const adjacentMatches = !sheetTagged.length
    ? candidates.filter((seg) => Array.isArray(seg.adjacentSheetFaceTypes)
      && seg.adjacentSheetFaceTypes.includes(targetFaceType))
    : sheetTagged;
  const anySheetSegments = adjacentMatches.length
    ? adjacentMatches
    : candidates.filter((seg) => !!seg.sheetFaceType);
  const pool = anySheetSegments.length ? anySheetSegments : candidates;
  const targetValue = useOppositeEdge ? sheetSpan.max : sheetSpan.min;
  const midPlane = (sheetSpan.min + sheetSpan.max) * 0.5;

  let best = null;
  let bestScore = Infinity;
  for (const seg of pool) {
    const mid = seg.start.clone().add(seg.end).multiplyScalar(0.5);
    const value = mid.clone().sub(origin).dot(sheetDir);
    const score = Math.abs(value - targetValue);
    if (score < bestScore) {
      bestScore = score;
      best = {
        start: seg.start.clone(),
        end: seg.end.clone(),
        target: value < midPlane ? "MIN" : "MAX",
      };
    }
  }
  return best;
}

function collectFaceEdgeSegments(face) {
  const result = [];
  const edges = Array.isArray(face?.edges) ? face.edges : [];
  for (const edge of edges) {
    const pts = extractEdgePolyline(edge);
    if (pts.length < 2) continue;
    const start = pts[0];
    const end = pts[pts.length - 1];
    const length = start.distanceTo(end);
    const adjacency = classifyEdgeSheetMetalTypes(edge, face);
    result.push({
      start,
      end,
      length,
      sourceEdge: edge,
      sheetFaceType: adjacency.primaryType,
      adjacentSheetFaceTypes: adjacency.adjacentTypes,
    });
  }
  return result;
}

function extractEdgePolyline(edge) {
  const pts = [];
  if (!edge) return pts;
  const tmp = new BREP.THREE.Vector3();
  const local = Array.isArray(edge?.userData?.polylineLocal) ? edge.userData.polylineLocal : null;
  const isWorld = !!edge?.userData?.polylineWorld;
  if (local && local.length >= 2) {
    for (const pt of local) {
      if (isWorld) {
        pts.push(new BREP.THREE.Vector3(pt[0], pt[1], pt[2]));
      } else {
        tmp.set(pt[0], pt[1], pt[2]).applyMatrix4(edge.matrixWorld);
        pts.push(tmp.clone());
      }
    }
    return pts;
  }

  const pos = edge?.geometry?.getAttribute?.("position");
  if (pos && pos.itemSize === 3 && pos.count >= 2) {
    for (let i = 0; i < pos.count; i++) {
      tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(edge.matrixWorld);
      pts.push(tmp.clone());
    }
  }
  return pts;
}

function orientSheetDir(face, sheetDir, originFallback) {
  const origin = originFallback || computeFaceCenter(face) || new BREP.THREE.Vector3();
  const neighbors = new Set();
  for (const edge of face?.edges || []) {
    if (!edge?.faces) continue;
    for (const neighbor of edge.faces) {
      if (neighbor && neighbor !== face) neighbors.add(neighbor);
    }
  }
  for (const neighbor of neighbors) {
    const normal = typeof neighbor.getAverageNormal === "function"
      ? neighbor.getAverageNormal().clone()
      : null;
    if (!normal || normal.lengthSq() < 1e-10) continue;
    normal.normalize();
    const alignment = Math.abs(normal.dot(sheetDir));
    if (alignment > 0.9) {
      const neighborCenter = computeFaceCenter(neighbor);
      if (!neighborCenter) continue;
      const toNeighbor = neighborCenter.clone().sub(origin);
      if (toNeighbor.dot(sheetDir) < 0) {
        sheetDir.multiplyScalar(-1);
      }
      break;
    }
  }
  return sheetDir;
}

function computeFaceCenter(face) {
  try {
    const pos = face?.geometry?.getAttribute?.("position");
    if (pos && pos.count >= 1) {
      const v = new BREP.THREE.Vector3();
      const center = new BREP.THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(face.matrixWorld);
        center.add(v);
      }
      return center.multiplyScalar(1 / pos.count);
    }
  } catch { /* ignore */ }
  const loops = Array.isArray(face?.userData?.boundaryLoopsWorld) ? face.userData.boundaryLoopsWorld : null;
  const loop = loops?.find((l) => Array.isArray(l?.pts) && l.pts.length);
  if (loop) {
    const center = new BREP.THREE.Vector3();
    let count = 0;
    for (const pt of loop.pts) {
      center.add(new BREP.THREE.Vector3(pt[0], pt[1], pt[2]));
      count++;
    }
    if (count) {
      return center.multiplyScalar(1 / count);
    }
  }
  return null;
}

function buildAxisEdge(start, end, featureID) {
  const geom = new BREP.THREE.BufferGeometry();
  const positions = new Float32Array([
    start.x, start.y, start.z,
    end.x, end.y, end.z,
  ]);
  geom.setAttribute("position", new BREP.THREE.BufferAttribute(positions, 3));
  const edge = new BREP.Edge(geom);
  edge.name = featureID ? `${featureID}:AXIS` : "SM.FLANGE_AXIS";
  edge.userData = {
    polylineLocal: [
      [start.x, start.y, start.z],
      [end.x, end.y, end.z],
    ],
    polylineWorld: true,
  };
  edge.matrixWorld = new BREP.THREE.Matrix4();
  edge.updateWorldMatrix = () => { };
  return edge;
}

function classifyEdgeSheetMetalTypes(edge, sourceFace) {
  const adjacentTypes = new Set();
  const neighbors = Array.isArray(edge?.faces) ? edge.faces : [];
  for (const neighbor of neighbors) {
    if (!neighbor || neighbor === sourceFace) continue;
    const type = resolveSMFaceType(neighbor);
    if (type) adjacentTypes.add(type);
  }

  const hasA = adjacentTypes.has(SHEET_METAL_FACE_TYPES.A);
  const hasB = adjacentTypes.has(SHEET_METAL_FACE_TYPES.B);
  let primaryType = null;
  if (hasA && !hasB) {
    primaryType = SHEET_METAL_FACE_TYPES.A;
  } else if (hasB && !hasA) {
    primaryType = SHEET_METAL_FACE_TYPES.B;
  }

  return {
    primaryType,
    adjacentTypes: Array.from(adjacentTypes),
  };
}

function getParentState(stateMap, parentSolid) {
  if (!parentSolid || !stateMap) return null;
  let state = stateMap.get(parentSolid);
  if (!state) {
    state = { original: parentSolid, target: parentSolid, solids: [] };
    stateMap.set(parentSolid, state);
  }
  return state;
}

function pickReplacementSolid(addedList) {
  if (!Array.isArray(addedList) || !addedList.length) return null;
  for (const solid of addedList) {
    if (solid) return solid;
  }
  return null;
}

function applyTranslationToSolid(solid, vector) {
  if (!solid || !vector || typeof vector.x !== "number" || typeof vector.y !== "number" || typeof vector.z !== "number") {
    return;
  }
  try {
    if (typeof solid.bakeTransform === "function") {
      const translation = new BREP.THREE.Matrix4().makeTranslation(vector.x, vector.y, vector.z);
      solid.bakeTransform(translation);
      return;
    }
  } catch { /* fallthrough to try Object3D translation */ }
  try {
    if (typeof solid.applyMatrix4 === "function") {
      const translation = new BREP.THREE.Matrix4().makeTranslation(vector.x, vector.y, vector.z);
      solid.applyMatrix4(translation);
      return;
    }
  } catch { /* ignore */ }
  try {
    if (solid.position && typeof solid.position.add === "function") {
      solid.position.add(vector);
    }
  } catch { /* ignore */ }
}

function buildOffsetTranslationVector(baseNormal, offsetValue) {
  if (!Number.isFinite(offsetValue) || offsetValue === 0) return null;
  const THREE = BREP.THREE;
  const normal = (baseNormal && typeof baseNormal.clone === "function" && baseNormal.lengthSq() > 1e-12)
    ? baseNormal.clone()
    : new THREE.Vector3(0, 0, 1);
  if (!normal || normal.lengthSq() < 1e-12) return null;
  normal.normalize();
  const vector = normal.multiplyScalar(-offsetValue);
  if (vector.lengthSq() < 1e-18) return null;
  return vector;
}

function findRevolveEndFace(revolveSolid) {
  if (!revolveSolid || !Array.isArray(revolveSolid.faces)) return null;
  for (const face of revolveSolid.faces) {
    const meta = typeof face.getMetadata === "function" ? face.getMetadata() : null;
    if (meta?.faceType === "ENDCAP") return face;
  }
  return revolveSolid.faces[revolveSolid.faces.length - 1] || null;
}

function createOffsetExtrudeSolid(params = {}) {
  const {
    face,
    faceNormal,
    lengthValue,
    featureID,
    faceIndex,
    reliefWidthValue = 0,
  } = params;
  if (!face || !Number.isFinite(lengthValue) || lengthValue === 0) return null;
  const THREE = BREP.THREE;
  const normal = (faceNormal && typeof faceNormal.clone === "function" && faceNormal.lengthSq() > 1e-12)
    ? faceNormal.clone()
    : (typeof face?.getAverageNormal === "function"
      ? face.getAverageNormal().clone()
      : new THREE.Vector3(0, 0, 1));
  if (!normal || normal.lengthSq() < 1e-12) return null;
  normal.normalize();

  // This is working correctly. Don't change how it inverts the lengthValue.
  const distance = normal.multiplyScalar(-lengthValue);
  if (distance.lengthSq() < 1e-18) return null;
  const suffix = Number.isFinite(faceIndex) ? `:${faceIndex}` : "";
  const sweep = new BREP.Sweep({
    face,
    distance,
    mode: "translate",
    name: featureID ? `${featureID}:OFFSET${suffix}` : "SM.FLANGE_OFFSET",
    omitBaseCap: false,
  });
  sweep.visualize();

  applyFaceSheetMetalData(face, sweep);

  const reliefWidth = 0.001 + reliefWidthValue;

  // use the solid.pushFace() method to nudge the faces with sheetMetalFaceType of "A" or "B" outward by a tiny amount to avoid z-fighting
  if (0 > lengthValue) {
    for (const solidFace of sweep.faces) {
      const faceMetadata = solidFace.getMetadata();
      let pushFace = true;
      if (faceMetadata?.sheetMetalFaceType === "A" || faceMetadata?.sheetMetalFaceType === "B") pushFace = true;
      if (faceMetadata?.faceType === "ENDCAP") pushFace = false;
      if (pushFace == true) sweep.pushFace(solidFace.name, reliefWidth);
    }
  }
  return sweep;
}

function applyCylMetadataToRevolve(revolve, axisEdge, radiusValue, baseNormal, offsetVector = null) {
  if (!revolve || !Array.isArray(revolve.faces) || !axisEdge) return;
  const THREE = BREP.THREE;
  try {
    const posAttr = axisEdge?.geometry?.getAttribute?.("position");
    const mat = axisEdge.matrixWorld || new THREE.Matrix4();
    const A = new THREE.Vector3(0, 0, 0);
    const B = new THREE.Vector3(0, 1, 0);
    if (posAttr && posAttr.count >= 2) {
      A.set(posAttr.getX(0), posAttr.getY(0), posAttr.getZ(0)).applyMatrix4(mat);
      B.set(posAttr.getX(posAttr.count - 1), posAttr.getY(posAttr.count - 1), posAttr.getZ(posAttr.count - 1)).applyMatrix4(mat);
    }
    if (offsetVector && offsetVector.x !== undefined) {
      A.add(offsetVector);
      B.add(offsetVector);
    }
    const axisDir = B.clone().sub(A);
    const height = axisDir.length();
    if (height < 1e-9) return;
    axisDir.normalize();
    const center = A.clone().addScaledVector(axisDir, height * 0.5);

    // Fit radius/center per side face from geometry to avoid relying on input radius alone.
    const axisOrigin = A.clone();
    const n = baseNormal && baseNormal.clone ? baseNormal.clone().normalize() : null;
    const tmp = new THREE.Vector3();
    for (const face of revolve.faces) {
      const meta = face.getMetadata?.() || {};
      if (meta.faceType && meta.faceType !== "SIDEWALL") continue;
      const pos = face.geometry?.getAttribute?.("position");
      if (!pos || pos.itemSize !== 3 || pos.count < 3) continue;
      let projMin = Infinity;
      let projMax = -Infinity;
      let sumRadius = 0;
      for (let i = 0; i < pos.count; i++) {
        tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(face.matrixWorld);
        const t = tmp.clone().sub(axisOrigin).dot(axisDir);
        if (t < projMin) projMin = t;
        if (t > projMax) projMax = t;
        const proj = axisOrigin.clone().add(axisDir.clone().multiplyScalar(t));
        sumRadius += tmp.distanceTo(proj);
      }
      const fitRadius = sumRadius / pos.count;
      const midT = (projMin + projMax) * 0.5;
      const fitCenter = axisOrigin.clone().add(axisDir.clone().multiplyScalar(midT));
      // Keep a slight preference for the intended radius but store the fit value so PMI reads geometry.
      const radius = Number.isFinite(fitRadius) && fitRadius > 1e-6 ? fitRadius : radiusValue;
      revolve.setFaceMetadata(face.name, {
        type: "cylindrical",
        radius,
        height: projMax - projMin,
        axis: [axisDir.x, axisDir.y, axisDir.z],
        center: [fitCenter.x, fitCenter.y, fitCenter.z],
        pmiRadiusOverride: radius,
      });
    }
  } catch { /* ignore cyl metadata errors */ }
}

function setSolidNameSafe(solid, name) {
  try {
    if (solid && name && typeof name === "string" && name.length) {
      solid.name = name;
    }
  } catch { /* ignore naming errors */ }
}

function resolveDirectionVector(vec) {
  if (!vec || typeof vec.x !== "number" || typeof vec.y !== "number" || typeof vec.z !== "number") return null;
  const THREE = BREP.THREE;
  const dir = new THREE.Vector3(vec.x, vec.y, vec.z);
  if (dir.lengthSq() < 1e-12) return null;
  return dir.normalize();
}

function applyFaceSheetMetalData(inputFace, inputSolid) {
  console.log(inputFace, inputFace.getMetadata());
  const inputFaceMetadata = inputFace.getMetadata();
  console.log(inputSolid.visualize());




  // extract all the faces of the input solid
  for (const solidFace of inputSolid.faces) {
    const faceMetadata = solidFace.getMetadata();
    //console.log("Comparing Solid Face:", solidFace.name, "with Input Face:", inputFace.name);
    if (faceMetadata.faceType == "STARTCAP" || faceMetadata.faceType == "ENDCAP") {
      solidFace.setMetadata(inputFaceMetadata);
      continue;
    }


    solidFace.setMetadata({ sheetMetalFaceType: "THICKNESS" });

  }



  // loop over each edge of the input face
  for (const edge of inputFace.edges) {
    const edgeMetadata = edge.getMetadata();
    console.log("Input Face Edge Metadata:", edge.name, edgeMetadata);

    // copy over the metadata from the input face edge to all edges in the solid that have a name that starts with the input edge name
    for (const solidFace of inputSolid.faces) {
      // look at the sourceEdgeName metadata for each face of the solid. Compare the faces to the current edge name
      if (solidFace.getMetadata()?.sourceEdgeName === edge.name) {
        console.log("Matching Solid Face Edge found:", solidFace.name, "for Input Edge:", edge.name);

        if (edgeMetadata?.sheetMetalEdgeType) {
          solidFace.setMetadata({ sheetMetalFaceType: edgeMetadata?.sheetMetalEdgeType });
        }
      }
    }
  }

}

function combineSolids(params = {}) {
  const {
    solids,
    featureID,
    groupIndex = 0,
  } = params;
  if (!Array.isArray(solids) || solids.length === 0) return null;
  let combined = null;
  for (const solid of solids) {
    if (!solid) continue;
    if (!combined) {
      combined = solid;
      continue;
    }
    let merged = null;
    try {
      merged = combined.union(solid);
    } catch {
      try {
        merged = solid.union(combined);
      } catch {
        merged = null;
      }
    }
    if (!merged) return null;
    combined = merged;
  }
  if (!combined) return null;
  try {
    const suffix = Number.isFinite(groupIndex) ? `_${groupIndex}` : "";
    combined.name = featureID
      ? `${featureID}:BENDS${suffix}`
      : combined.name || `SM.FLANGE_BENDS${suffix}`;
  } catch { /* optional */ }
  try { combined.visualize(); } catch { }
  return combined;
}

function solidsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.uuid && b.uuid && a.uuid === b.uuid) return true;
  if (a.name && b.name && a.name === b.name) return true;
  return false;
}
