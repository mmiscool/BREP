import { BREP } from "../../BREP/BREP.js";
import { SHEET_METAL_FACE_TYPES } from "./sheetMetalFaceTypes.js";

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
    min: 0,
    hint: "Placeholder reserved for future relief cut options.",
  },
  bendRadius: {
    type: "number",
    default_value: 0,
    min: 0,
    hint: "Placeholder reserved for future bend radius overrides.",
  },
  useOppositeCenterline: {
    type: "boolean",
    default_value: false,
    hint: "Flip to use the opposite edge for the hinge centerline.",
  },
  offset: {
    type: "number",
    default_value: 0,
    hint: "Placeholder reserved for future offset support.",
  },
};

export class SheetMetalFlangeFeature {
  static shortName = "SM.FLANGE";
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

    const angleDeg = Number(this.inputParams?.angle ?? 90);
    let angle = Number.isFinite(angleDeg) ? Math.max(0, Math.min(180, angleDeg)) : 90;
    const bendRadiusInput = Math.max(0, Number(this.inputParams?.bendRadius ?? 0));
    const useOppositeCenterline = this.inputParams?.useOppositeCenterline === true;

    const added = [];
    for (const face of faces) {
      const context = analyzeFace(face);
      if (!context) continue;
      const thicknessInfo = resolveThickness(face, context.parentSolid);
      const thickness = thicknessInfo?.thickness ?? 1;
      const bendRadius = bendRadiusInput > 0 ? bendRadiusInput : (thicknessInfo?.defaultBendRadius ?? thickness);

      const hingeEdge = pickCenterlineEdge(face, context, useOppositeCenterline);
      if (!hingeEdge?.start || !hingeEdge?.end) continue;

      const sheetDir = context.sheetDir.clone().normalize();
      const offsetSign = hingeEdge.target === "MIN" ? 1 : -1;
      const offsetMagnitude = bendRadius + thickness;
      const offsetVec = sheetDir.clone().multiplyScalar(offsetSign * offsetMagnitude);
      const axisEdge = buildAxisEdge(
        hingeEdge.start.clone().add(offsetVec),
        hingeEdge.end.clone().add(offsetVec),
        this.inputParams?.featureID,
      );
      const revolveAngle = useOppositeCenterline ? -angle : angle;
      const revolve = new BREP.Revolve({
        face,
        axis: axisEdge,
        angle: revolveAngle,
        resolution: 128,
        name: this.inputParams?.featureID ? `${this.inputParams.featureID}:BEND` : "SM.FLANGE_BEND",
      });
      revolve.visualize();
      added.push(revolve);
    }

    if (!added.length) {
      throw new Error("Unable to build any flange geometry for the selected faces.");
    }

    return { added, removed: [] };
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
    const type = resolveSheetMetalFaceType(neighbor);
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

function resolveSheetMetalFaceType(faceObj) {
  if (!faceObj) return null;
  const direct = faceObj.userData?.sheetMetalFaceType;
  const solid = faceObj.parentSolid || findAncestorSolid(faceObj);
  const faceName = faceObj.userData?.faceName || faceObj.name;
  if (!solid || typeof solid.getFaceMetadata !== "function" || !faceName) {
    return direct || null;
  }
  try {
    const metadata = solid.getFaceMetadata(faceName);
    if (metadata && typeof metadata.sheetMetalFaceType === "string") {
      return metadata.sheetMetalFaceType;
    }
  } catch { /* ignore metadata lookup errors */ }
  return direct || null;
}
