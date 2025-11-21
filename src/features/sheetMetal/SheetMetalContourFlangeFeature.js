import { BREP } from "../../BREP/BREP.js";
import {
  normalizeThickness,
  normalizeBendRadius,
  applySheetMetalMetadata,
} from "./sheetMetalMetadata.js";
import { setSheetMetalFaceTypeMetadata, SHEET_METAL_FACE_TYPES, propagateSheetMetalFaceTypesToEdges } from "./sheetMetalFaceTypes.js";

const THREE = BREP.THREE;

const inputParamsSchema = {
  id: {
    type: "string",
    default_value: null,
    hint: "Unique identifier for the contour flange feature",
  },
  path: {
    type: "reference_selection",
    selectionFilter: ["SKETCH", "EDGE"],
    multiple: true,
    default_value: null,
    hint: "Open sketch (or connected edges) defining the flange centerline.",
  },
  distance: {
    type: "number",
    default_value: 20,
    min: 0,
    hint: "How far the sheet extends from the selected path (strip width).",
  },
  thickness: {
    type: "number",
    default_value: 2,
    min: 0,
    hint: "Sheet metal thickness (extruded normal to the sketch plane).",
  },
  reverseSheetSide: {
    type: "boolean",
    default_value: false,
    hint: "Flip the sheet offset to the opposite side of the sketch.",
  },
  bendRadius: {
    type: "number",
    default_value: 1,
    min: 0,
    hint: "Default inside bend radius inserted wherever two lines meet.",
  },
  consumePathSketch: {
    type: "boolean",
    default_value: true,
    hint: "Remove the referenced sketch after creating the flange. Turn off to keep it in the scene.",
  },
};

export class SheetMetalContourFlangeFeature {
  static shortName = "SM.CF";
  static longName = "Sheet Metal Contour Flange";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const { edges, sketches, basisHint, pathOverride } = resolvePathSelection(
      this.inputParams?.path ?? this.inputParams?.profile,
      partHistory,
    );
    if (!edges.length) {
      throw new Error("Contour Flange requires selecting a SKETCH or one or more connected EDGEs.");
    }

    const { magnitude: thicknessAbs, signed: signedThickness } = normalizeThickness(
      this.inputParams?.thickness ?? 1,
    );
    const bendRadius = normalizeBendRadius(this.inputParams?.bendRadius ?? 0);
    const rawDistance = Number(this.inputParams?.distance ?? 0);
    if (!Number.isFinite(rawDistance) || rawDistance === 0) {
      throw new Error("Contour Flange distance must be a non-zero number.");
    }
    const distance = Math.abs(rawDistance);
    const extrudeDirectionSign = rawDistance >= 0 ? 1 : -1;

    const { sheetSide, reverseSheetSide } = resolveSheetSideOption(this.inputParams);

    const pathData = buildPathPoints(edges);
    let rawPath = pathData.points;
    let pathSegmentNames = pathData.segmentNames;
    if ((!rawPath || rawPath.length < 2) && Array.isArray(pathOverride) && pathOverride.length >= 2) {
      rawPath = pathOverride.map((pt) => (pt instanceof THREE.Vector3)
        ? pt.clone()
        : new THREE.Vector3(pt.x ?? pt[0] ?? 0, pt.y ?? pt[1] ?? 0, pt.z ?? pt[2] ?? 0));
      pathSegmentNames = buildDefaultSegmentNames(rawPath.length - 1);
    }
    if (!rawPath || rawPath.length < 2) {
      throw new Error("Contour Flange path must contain at least two points.");
    }
    pathSegmentNames = normalizeSegmentNameCount(pathSegmentNames, rawPath.length - 1);

    const planeBasis = computePlaneBasis(rawPath, basisHint);
    const filletResult = bendRadius > 0
      ? filletPolyline(rawPath, bendRadius, planeBasis, pathSegmentNames)
      : { points: rawPath.map((pt) => pt.clone()), segmentNames: pathSegmentNames.slice() };
    const filletedPath = filletResult.points;
    const filletedSegmentNames = normalizeSegmentNameCount(
      filletResult.segmentNames,
      filletedPath.length - 1,
    );

    if (filletedPath.length < 2) {
      throw new Error("Contour Flange requires at least two path points after filleting.");
    }

    const flangeFaces = buildContourFlangeStripFaces({
      featureID: this.inputParams?.featureID,
      pathPoints: filletedPath,
      pathSegmentNames: filletedSegmentNames,
      planeBasis,
      thickness: thicknessAbs,
      sheetSide,
    });

    const extrudeVector = planeBasis.planeNormal.clone().normalize().multiplyScalar(distance * extrudeDirectionSign);
    const sweeps = flangeFaces.map((face) => {
      const sweep = new BREP.Sweep({
        face,
        distance: extrudeVector,
        mode: "translate",
        name:this.inputParams?.featureID,
        omitBaseCap: false,
      });
      sweep.visualize();
      //alert(`Sweep created: ${sweep.name }    ${sweep.name || this.inputParams?.featureID || "Unnamed"}`);
      tagContourFlangeFaceTypes(sweep);
      return sweep;
    });
    if (!sweeps.length) {
      throw new Error("Contour flange failed to generate any extrusions from the selected path.");
    }
    let combinedSweep = sweeps[0];
    for (let i = 1; i < sweeps.length; i++) {
      try {
        combinedSweep = combinedSweep.union(sweeps[i]);
      } catch {
        combinedSweep = sweeps[i];
      }
    }

    const effects = await BREP.applyBooleanOperation(
      partHistory || {},
      combinedSweep,
      null,
      this.inputParams?.id,
    );

    const consumeSketch = this.inputParams?.consumePathSketch !== false;
    const sketchesToRemove = consumeSketch ? sketches : [];
    const removed = [
      ...sketchesToRemove,
      ...(effects?.removed || []),
    ];
    const added = effects?.added || [];
    try {
      for (const obj of removed) {
        if (obj) obj.__removeFlag = true;
      }
    } catch { /* best effort */ }

    applySheetMetalMetadata(added, partHistory?.metadataManager, {
      featureID: this.inputParams?.featureID || null,
      thickness: thicknessAbs,
      bendRadius,
      baseType: "CONTOUR_FLANGE",
      extra: {
        signedThickness,
        sheetSide,
        reverseSheetSide,
        signedDistance: rawDistance,
        distance,
        pathPointCount: filletedPath.length,
      },
    });

    this.persistentData = this.persistentData || {};
    this.persistentData.sheetMetal = {
      baseType: "CONTOUR_FLANGE",
      thickness: thicknessAbs,
      bendRadius,
      signedThickness,
      sheetSide,
      reverseSheetSide,
      signedDistance: rawDistance,
      distance,
      pathPointCount: filletedPath.length,
    };

    propagateSheetMetalFaceTypesToEdges(added);

    return { added, removed };
  }
}

function resolvePathSelection(pathRefs, partHistory) {
  const refs = Array.isArray(pathRefs) ? pathRefs : (pathRefs ? [pathRefs] : []);
  const edges = [];
  const sketches = new Set();
  const basisCandidates = [];
  let overridePath = null;

  for (const ref of refs) {
    let obj = ref;
    if (typeof obj === "string" && partHistory?.scene?.getObjectByName) {
      obj = partHistory.scene.getObjectByName(obj);
    }
    if (!obj) continue;
    if (obj.type === "EDGE") {
      edges.push(obj);
      const edgeBasis = extractBasisFromEdge(obj, partHistory);
      if (edgeBasis) basisCandidates.push(edgeBasis);
    } else if (obj.type === "SKETCH") {
      sketches.add(obj);
      const sketchBasis = extractBasisFromSketch(obj, partHistory);
      if (sketchBasis) basisCandidates.push(sketchBasis);
      if (!overridePath) {
        const diagPath = buildPathFromSketchDiagnostics(obj, partHistory, sketchBasis);
        if (diagPath && diagPath.points.length >= 2) {
          overridePath = diagPath.points;
          if (diagPath.basis) basisCandidates.push(diagPath.basis);
        }
      }
      const stack = Array.isArray(obj.children) ? obj.children.slice() : [];
      for (const child of stack) {
        if (child?.type === "EDGE") {
          edges.push(child);
          const childBasis = extractBasisFromEdge(child, partHistory);
          if (childBasis) basisCandidates.push(childBasis);
        }
      }
    }
  }

  return {
    edges,
    sketches: Array.from(sketches),
    basisHint: basisCandidates.find(Boolean) || null,
    pathOverride: overridePath,
  };
}

function extractBasisFromEdge(edge, partHistory) {
  if (!edge) return null;
  const direct = convertStoredBasis(edge.userData?.sheetMetalBasis || edge.userData?.basis);
  if (direct) return direct;
  const sketchId = edge.userData?.sketchFeatureId || edge.userData?.sketchId;
  const basis = findSketchBasis(sketchId, partHistory);
  return convertStoredBasis(basis);
}

function extractBasisFromSketch(sketchObj, partHistory) {
  if (!sketchObj) return null;
  const direct = convertStoredBasis(sketchObj.userData?.sheetMetalBasis || sketchObj.userData?.basis);
  if (direct) return direct;
  const sketchId = sketchObj.name || sketchObj.userData?.sketchFeatureId;
  const basis = findSketchBasis(sketchId, partHistory);
  return convertStoredBasis(basis);
}

function findSketchBasis(featureId, partHistory) {
  const normalized = normalizeId(featureId);
  if (!normalized || !partHistory) return null;
  const entry = findSketchFeatureEntry(partHistory, normalized);
  return entry?.persistentData?.basis || null;
}

function normalizeId(value) {
  if (value == null) return null;
  try {
    const str = String(value).trim();
    return str.length ? str : null;
  } catch {
    return null;
  }
}

function findSketchFeatureEntry(partHistory, normalizedId) {
  const list = Array.isArray(partHistory?.features) ? partHistory.features : [];
  for (const entry of list) {
    const entryId = normalizeId(entry?.inputParams?.id ?? entry?.id ?? entry?.inputParams?.featureID);
    if (entryId && entryId === normalizedId) return entry;
  }
  return null;
}

function buildPathFromSketchDiagnostics(sketchObj, partHistory, basisOverride = null) {
  if (!sketchObj || !partHistory) return null;
  const sketchId = normalizeId(sketchObj.name || sketchObj.userData?.sketchFeatureId);
  if (!sketchId) return null;
  const featureEntry = findSketchFeatureEntry(partHistory, sketchId);
  if (!featureEntry) return null;
  const diag = featureEntry?.persistentData?.lastProfileDiagnostics;
  const openChains = Array.isArray(diag?.openChains2D) ? diag.openChains2D : [];
  if (!openChains.length) return null;
  let selected = null;
  for (const chain of openChains) {
    if (!Array.isArray(chain) || chain.length < 2) continue;
    if (!selected || chain.length > selected.length) selected = chain;
  }
  if (!selected) return null;
  const basis = convertStoredBasis(basisOverride || featureEntry?.persistentData?.basis);
  if (!basis) return null;
  const worldPts = selected.map((point) => projectSketchUVToWorld(point, basis));
  return { points: worldPts, basis };
}

function convertStoredBasis(raw) {
  if (!raw || typeof raw !== "object") return null;
  const origin = vectorFromArray(raw.origin) || new THREE.Vector3(0, 0, 0);
  const xAxisRaw = vectorFromArray(raw.x || raw.xAxis) || new THREE.Vector3(1, 0, 0);
  const zAxisRaw = vectorFromArray(raw.z || raw.zAxis || raw.planeNormal) || new THREE.Vector3(0, 0, 1);
  if (xAxisRaw.lengthSq() < 1e-10 || zAxisRaw.lengthSq() < 1e-10) return null;
  const zAxis = zAxisRaw.clone().normalize();
  const xAxis = xAxisRaw.clone().sub(zAxis.clone().multiplyScalar(xAxisRaw.dot(zAxis))).normalize();
  let yAxis = vectorFromArray(raw.y || raw.yAxis);
  if (yAxis && yAxis.lengthSq() > 1e-10) {
    yAxis = yAxis.clone().normalize();
  } else {
    yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  }
  return {
    origin: origin.clone(),
    xAxis,
    yAxis,
    planeNormal: zAxis,
  };
}

function vectorFromArray(raw) {
  if (raw instanceof THREE.Vector3) return raw.clone();
  if (Array.isArray(raw) && raw.length >= 3) {
    const x = Number(raw[0]) || 0;
    const y = Number(raw[1]) || 0;
    const z = Number(raw[2]) || 0;
    return new THREE.Vector3(x, y, z);
  }
  return null;
}

function projectSketchUVToWorld(point, basis) {
  if (!basis) return new THREE.Vector3();
  const u = Array.isArray(point) ? Number(point[0]) || 0 : Number(point?.u || 0);
  const v = Array.isArray(point) ? Number(point[1]) || 0 : Number(point?.v || 0);
  return basis.origin.clone()
    .add(basis.xAxis.clone().multiplyScalar(u))
    .add(basis.yAxis.clone().multiplyScalar(v));
}

function buildPathPoints(edges) {
  if (!Array.isArray(edges) || !edges.length) {
    return { points: [], segmentNames: [] };
  }

  const tmp = new THREE.Vector3();
  const toWorld = (edge, pt) => {
    tmp.set(pt[0], pt[1], pt[2]);
    if (edge && typeof edge.updateWorldMatrix === "function") {
      edge.updateWorldMatrix(true, true);
    }
    return tmp.clone().applyMatrix4(edge.matrixWorld || new THREE.Matrix4());
  };

  const segments = [];
  let edgeCounter = 0;
  for (const edge of edges) {
    const pts = Array.isArray(edge?.userData?.polylineLocal)
      ? edge.userData.polylineLocal
      : null;
    let worldPts = null;
    if (pts && pts.length >= 2) {
      worldPts = pts.map((p) => toWorld(edge, p));
    } else {
      const pos = edge?.geometry?.getAttribute?.("position");
      if (pos && pos.itemSize === 3 && pos.count >= 2) {
        worldPts = [];
        for (let i = 0; i < pos.count; i++) {
          tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i));
          tmp.applyMatrix4(edge.matrixWorld || new THREE.Matrix4());
          worldPts.push(tmp.clone());
        }
      }
    }
    if (!worldPts || worldPts.length < 2) continue;
    const flat = worldPts.map((v) => [v.x, v.y, v.z]);
    segments.push({
      pts: flat,
      startKey: `${flat[0][0].toFixed(6)},${flat[0][1].toFixed(6)},${flat[0][2].toFixed(6)}`,
      endKey: `${flat[flat.length - 1][0].toFixed(6)},${flat[flat.length - 1][1].toFixed(6)},${flat[flat.length - 1][2].toFixed(6)}`,
      name: deriveEdgeBaseName(edge, edgeCounter++),
    });
  }

  if (!segments.length) {
    return { points: [], segmentNames: [] };
  }

  const used = new Array(segments.length).fill(false);
  let bestPoints = [];
  let bestSegmentMeta = [];
  const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    const base = segments[i];
    const chain = base.pts.slice();
    const chainSegments = [{ name: base.name, pts: base.pts.slice() }];
    used[i] = true;
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const seg = segments[j];
        const head = chain[0];
        const tail = chain[chain.length - 1];
        const headKey = key(head);
        const tailKey = key(tail);
        if (seg.startKey === tailKey) {
          chain.push(...seg.pts.slice(1));
          chainSegments.push({ name: seg.name, pts: seg.pts.slice() });
          used[j] = true;
          grew = true;
        } else if (seg.endKey === tailKey) {
          const ptsRev = seg.pts.slice().reverse();
          chain.push(...ptsRev.slice(1));
          chainSegments.push({ name: seg.name, pts: ptsRev });
          used[j] = true;
          grew = true;
        } else if (seg.endKey === headKey) {
          const pts = seg.pts.slice();
          chain.unshift(...pts.slice(0, pts.length - 1));
          chainSegments.unshift({ name: seg.name, pts: pts });
          used[j] = true;
          grew = true;
        } else if (seg.startKey === headKey) {
          const ptsRev = seg.pts.slice().reverse();
          chain.unshift(...ptsRev.slice(0, ptsRev.length - 1));
          chainSegments.unshift({ name: seg.name, pts: ptsRev });
          used[j] = true;
          grew = true;
        }
      }
    }
    if (chain.length > bestPoints.length) {
      bestPoints = chain.slice();
      bestSegmentMeta = chainSegments.map((entry) => ({ name: entry.name, pts: entry.pts.map((p) => p.slice()) }));
    }
  }

  if (!bestPoints.length) {
    return { points: [], segmentNames: [] };
  }

  const finalPoints = [];
  const segmentNames = [];
  for (const seg of bestSegmentMeta) {
    const pts = seg.pts;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!finalPoints.length) {
        finalPoints.push(p);
        continue;
      }
      const prev = finalPoints[finalPoints.length - 1];
      if (prev[0] === p[0] && prev[1] === p[1] && prev[2] === p[2]) {
        continue;
      }
      finalPoints.push(p);
      segmentNames[finalPoints.length - 2] = seg.name || `SEGMENT_${segmentNames.length}`;
    }
  }

  return {
    points: finalPoints.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    segmentNames,
  };
}

function computePlaneBasis(points, hintBasis = null) {
  if (hintBasis) {
    const origin = hintBasis.origin instanceof THREE.Vector3
      ? hintBasis.origin.clone()
      : Array.isArray(hintBasis.origin)
        ? new THREE.Vector3().fromArray(hintBasis.origin)
        : new THREE.Vector3(0, 0, 0);
    const zRaw = hintBasis.planeNormal || hintBasis.zAxis || hintBasis.z;
    const xRaw = hintBasis.xAxis || hintBasis.x;
    const yRaw = hintBasis.yAxis || hintBasis.y;
    const z = zRaw instanceof THREE.Vector3 ? zRaw.clone()
      : Array.isArray(zRaw) ? new THREE.Vector3().fromArray(zRaw)
        : null;
    const x = xRaw instanceof THREE.Vector3 ? xRaw.clone()
      : Array.isArray(xRaw) ? new THREE.Vector3().fromArray(xRaw)
        : null;
    const y = yRaw instanceof THREE.Vector3 ? yRaw.clone()
      : Array.isArray(yRaw) ? new THREE.Vector3().fromArray(yRaw)
        : null;
    if (z && z.lengthSq() > 1e-8 && x && x.lengthSq() > 1e-8) {
      const zn = z.clone().normalize();
      const xn = x.clone().normalize();
      const yn = (y && y.lengthSq() > 1e-8)
        ? y.clone().normalize()
        : new THREE.Vector3().crossVectors(zn, xn).normalize();
      return { origin, planeNormal: zn, xAxis: xn, yAxis: yn };
    }
  }

  if (!Array.isArray(points) || points.length < 2) {
    const origin = new THREE.Vector3(0, 0, 0);
    return {
      origin,
      planeNormal: new THREE.Vector3(0, 0, 1),
      xAxis: new THREE.Vector3(1, 0, 0),
      yAxis: new THREE.Vector3(0, 1, 0),
    };
  }
  const origin = points[0].clone();
  const xAxis = points[1].clone().sub(points[0]);
  if (xAxis.lengthSq() < 1e-8 && points.length > 2) {
    xAxis.copy(points[2]).sub(points[1]);
  }
  if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
  xAxis.normalize();

  let planeNormal = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < points.length - 2; i++) {
    const v0 = points[i + 1].clone().sub(points[i]);
    const v1 = points[i + 2].clone().sub(points[i + 1]);
    const n = v0.clone().cross(v1);
    if (n.lengthSq() > 1e-8) {
      planeNormal = n.normalize();
      break;
    }
  }
  if (planeNormal.lengthSq() < 1e-8) planeNormal.set(0, 0, 1);

  // Create proper right-handed coordinate system: Y = Z × X
  const yAxis = new THREE.Vector3().crossVectors(planeNormal, xAxis).normalize();
  if (yAxis.lengthSq() < 1e-8) {
    // If xAxis is parallel to planeNormal, choose a different approach
    const tempX = Math.abs(planeNormal.dot(new THREE.Vector3(1, 0, 0))) < 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
    const xAxis2 = new THREE.Vector3().crossVectors(planeNormal, tempX).normalize();
    const yAxis2 = new THREE.Vector3().crossVectors(planeNormal, xAxis2).normalize();
    return { origin, planeNormal, xAxis: xAxis2, yAxis: yAxis2 };
  }

  // Ensure xAxis is orthogonal to planeNormal (project and normalize)
  const xAxisCorrected = xAxis.clone().sub(planeNormal.clone().multiplyScalar(xAxis.dot(planeNormal))).normalize();

  return { origin, planeNormal, xAxis: xAxisCorrected, yAxis };
}

function filletPolyline(points, radius, basis, segmentNames = []) {
  if (!Array.isArray(points) || points.length < 2) {
    return { points: Array.isArray(points) ? points.map((pt) => pt.clone()) : [], segmentNames: [] };
  }

  const { origin, xAxis, yAxis, planeNormal } = basis;
  const to2D = (vec) => {
    const rel = vec.clone().sub(origin);
    return {
      u: rel.dot(xAxis),
      v: rel.dot(yAxis),
      w: rel.dot(planeNormal),
    };
  };
  const to3D = (coord) => {
    return origin.clone()
      .add(xAxis.clone().multiplyScalar(coord.u))
      .add(yAxis.clone().multiplyScalar(coord.v))
      .add(planeNormal.clone().multiplyScalar(coord.w || 0));
  };

  if (!radius || radius <= 1e-8 || points.length < 3) {
    return {
      points: points.map((pt) => pt.clone()),
      segmentNames: normalizeSegmentNameCount(segmentNames, points.length - 1),
    };
  }

  const coords = points.map((pt) => to2D(pt));
  const baseNames = normalizeSegmentNameCount(segmentNames, coords.length - 1);
  const segCount = coords.length - 1;
  const segmentStart = new Array(segCount);
  const segmentEnd = new Array(segCount);
  for (let i = 0; i < segCount; i++) {
    segmentStart[i] = { ...coords[i] };
    segmentEnd[i] = { ...coords[i + 1] };
  }

  const arcSamples = new Array(coords.length).fill(null);
  const arcNames = new Array(coords.length).fill(null);

  const len = (a, b) => Math.hypot(b.u - a.u, b.v - a.v);
  const norm = (a, b) => {
    const d = len(a, b) || 1;
    return { x: (b.u - a.u) / d, y: (b.v - a.v) / d };
  };

  for (let i = 1; i < coords.length - 1; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    const next = coords[i + 1];
    const dirPrev = norm(prev, curr);
    const dirNext = norm(curr, next);
    const turn = dirPrev.x * dirNext.y - dirPrev.y * dirNext.x;
    const dot = (-dirPrev.x) * dirNext.x + (-dirPrev.y) * dirNext.y;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (!Number.isFinite(angle) || angle < (5 * Math.PI / 180)) {
      continue;
    }
    let offset = radius / Math.tan(angle / 2);
    const lenPrev = len(prev, curr);
    const lenNext = len(curr, next);
    offset = Math.min(offset, lenPrev * 0.9, lenNext * 0.9);
    if (!Number.isFinite(offset) || offset <= 0) {
      continue;
    }
    const start = {
      u: curr.u - dirPrev.x * offset,
      v: curr.v - dirPrev.y * offset,
      w: curr.w,
    };
    const end = {
      u: curr.u + dirNext.x * offset,
      v: curr.v + dirNext.y * offset,
      w: curr.w,
    };
    const insideSign = Math.sign(turn) || 1;
    const normalPrev = insideSign > 0
      ? { x: -dirPrev.y, y: dirPrev.x }
      : { x: dirPrev.y, y: -dirPrev.x };
    const normalNext = insideSign > 0
      ? { x: -dirNext.y, y: dirNext.x }
      : { x: dirNext.y, y: -dirNext.x };

    const centerPrev = {
      u: start.u + normalPrev.x * radius,
      v: start.v + normalPrev.y * radius,
      w: curr.w,
    };
    const centerNext = {
      u: end.u + normalNext.x * radius,
      v: end.v + normalNext.y * radius,
      w: curr.w,
    };
    const center = {
      u: 0.5 * (centerPrev.u + centerNext.u),
      v: 0.5 * (centerPrev.v + centerNext.v),
      w: curr.w,
    };

    const startAng = Math.atan2(start.v - center.v, start.u - center.u);
    const endAng = Math.atan2(end.v - center.v, end.u - center.u);
    const sweepDir = insideSign > 0 ? 1 : -1;
    let delta = endAng - startAng;
    if (sweepDir > 0 && delta <= 0) delta += Math.PI * 2;
    if (sweepDir < 0 && delta >= 0) delta -= Math.PI * 2;
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 18)));

    segmentEnd[i - 1] = start;
    segmentStart[i] = end;
    const arcPts = [start];
    for (let step = 1; step < steps; step++) {
      const ang = startAng + sweepDir * (Math.abs(delta) * (step / steps));
      arcPts.push({
        u: center.u + Math.cos(ang) * radius,
        v: center.v + Math.sin(ang) * radius,
        w: curr.w,
      });
    }
    arcPts.push(end);
    arcSamples[i] = arcPts;
    arcNames[i] = buildFilletEdgeName(baseNames[i - 1], baseNames[i]);
  }

  const outCoords = [];
  const outNames = [];
  const coordsEqual = (a, b) => !a || !b
    ? false
    : (Math.abs(a.u - b.u) < 1e-9 && Math.abs(a.v - b.v) < 1e-9 && Math.abs((a.w || 0) - (b.w || 0)) < 1e-9);
  const pushCoord = (coord, segName) => {
    if (!coord) return false;
    const copy = { u: coord.u, v: coord.v, w: coord.w };
    if (!outCoords.length) {
      outCoords.push(copy);
      return true;
    }
    const last = outCoords[outCoords.length - 1];
    if (coordsEqual(last, copy)) return false;
    outCoords.push(copy);
    if (segName) {
      outNames[outCoords.length - 2] = segName;
    }
    return true;
  };

  for (let seg = 0; seg < segCount; seg++) {
    pushCoord(segmentStart[seg]);
    const segName = baseNames[seg] || `SEG_${seg}`;
    pushCoord(segmentEnd[seg], segName);
    const arc = arcSamples[seg + 1];
    if (arc && arc.length >= 2) {
      const arcName = arcNames[seg + 1] || buildFilletEdgeName(baseNames[seg], baseNames[seg + 1]);
      for (let j = 1; j < arc.length; j++) {
        pushCoord(arc[j], arcName);
      }
    }
  }

  const outPoints = outCoords.map((coord) => to3D(coord));
  return {
    points: outPoints,
    segmentNames: normalizeSegmentNameCount(outNames, outPoints.length - 1),
  };
}

function buildContourFlangeStripFaces({ featureID, pathPoints, pathSegmentNames, planeBasis, thickness, sheetSide }) {
  if (!Array.isArray(pathPoints) || pathPoints.length < 2) {
    throw new Error("Contour flange strip requires at least two path points.");
  }
  if (!(planeBasis?.origin && planeBasis?.xAxis && planeBasis?.yAxis && planeBasis?.planeNormal)) {
    throw new Error("Contour flange could not resolve a sketch plane basis.");
  }

  const converters = createPlaneBasisConverters(planeBasis);
  const path2D = pathPoints.map((pt) => converters.to2D(pt));
  const pathNames = normalizeSegmentNameCount(pathSegmentNames, path2D.length - 1);
  const offset2D = offsetPolyline2D(path2D, thickness, sheetSide);
  if (!offset2D || offset2D.length !== path2D.length) {
    throw new Error("Contour flange failed to compute the offset path.");
  }

  const areaTolerance = Math.max(thickness * thickness * 1e-6, 1e-9);
  const pathGroups = groupSegmentsByName(pathNames);
  if (!pathGroups.length && path2D.length >= 2) {
    pathGroups.push({ name: "SEG_0", startIndex: 0, endIndex: path2D.length - 2 });
  }
  const faces = [];
  let segmentCounter = 0;
  for (const group of pathGroups) {
    const face = buildSegmentFace({
      featureID,
      converters,
      path2D,
      offset2D,
      startIndex: group.startIndex,
      endIndex: group.endIndex,
      segmentName: group.name,
      areaTolerance,
      segmentIndex: segmentCounter++,
    });
    if (face) faces.push(face);
  }

  if (!faces.length) {
    throw new Error("Contour flange failed to create planar strip regions from the selected path.");
  }

  return faces;
}

function groupSegmentsByName(names) {
  const result = [];
  if (!Array.isArray(names) || !names.length) return result;
  let current = names[0];
  let startIndex = 0;
  for (let i = 1; i <= names.length; i++) {
    const next = names[i];
    if (next !== current) {
      result.push({ name: current, startIndex, endIndex: i - 1 });
      startIndex = i;
      current = next;
    }
  }
  return result;
}

function buildSegmentFace({
  featureID,
  converters,
  path2D,
  offset2D,
  startIndex,
  endIndex,
  segmentName,
  areaTolerance,
  segmentIndex,
}) {
  const pathSlice = [];
  const offsetSlice = [];
  for (let i = startIndex; i <= endIndex + 1 && i < path2D.length; i++) {
    pathSlice.push({ ...path2D[i] });
  }
  for (let i = startIndex; i <= endIndex + 1 && i < offset2D.length; i++) {
    offsetSlice.push({ ...offset2D[i] });
  }
  if (pathSlice.length < 2 || offsetSlice.length < 2) return null;

  const polygon = buildSegmentPolygon(pathSlice, offsetSlice);
  const loopCoords = dedupePolygonCoords(polygon);
  if (loopCoords.length < 3) return null;

  let area = polygonArea2D(loopCoords);
  if (!Number.isFinite(area) || Math.abs(area) < areaTolerance) return null;
  if (area < 0) loopCoords.reverse();

  const triangles = triangulatePolygon(loopCoords);
  if (!triangles.length) return null;

  const worldPts = loopCoords.map((coord) => converters.to3D(coord));
  const positionArray = new Float32Array(worldPts.length * 3);
  for (let i = 0; i < worldPts.length; i++) {
    positionArray[i * 3 + 0] = worldPts[i].x;
    positionArray[i * 3 + 1] = worldPts[i].y;
    positionArray[i * 3 + 2] = worldPts[i].z;
  }
  const indexArray = new Uint32Array(triangles.length * 3);
  for (let i = 0; i < triangles.length; i++) {
    const tri = triangles[i];
    indexArray[i * 3 + 0] = tri[0];
    indexArray[i * 3 + 1] = tri[1];
    indexArray[i * 3 + 2] = tri[2];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positionArray, 3));
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));

  const baseName = segmentName || `SEG_${segmentIndex}`;
  const face = new BREP.Face(geometry);
  face.name = featureID ? `${featureID}:${baseName}` : `SM.CF_${baseName}`;

  const loopWorld = worldPts.map((pt) => [pt.x, pt.y, pt.z]);
  if (loopWorld.length >= 2) {
    const first = loopWorld[0];
    const last = loopWorld[loopWorld.length - 1];
    if (first[0] === last[0] && first[1] === last[1] && first[2] === last[2]) {
      loopWorld.pop();
    }
  }
  face.userData = face.userData || {};
  face.userData.boundaryLoopsWorld = [{ pts: loopWorld, isHole: false }];

  const pathEdgePts = pathSlice.map((coord) => converters.to3D(coord));
  const offsetEdgePts = offsetSlice.map((coord) => converters.to3D(coord));
  const pathEdge = createPseudoEdge(baseName, pathEdgePts);
  const offsetEdge = createPseudoEdge(`${baseName}_OFFSET`, offsetEdgePts);
  const startClosure = createPseudoEdge(`${baseName}_START_CAP`, [pathEdgePts[0], offsetEdgePts[0]]);
  const endClosure = createPseudoEdge(
    `${baseName}_END_CAP`,
    [pathEdgePts[pathEdgePts.length - 1], offsetEdgePts[offsetEdgePts.length - 1]],
  );
  const edges = [pathEdge, offsetEdge, startClosure, endClosure].filter(Boolean);
  face.edges = edges;

  const baseEdges = pathEdge ? [pathEdge.name] : [];
  const offsetEdges = offsetEdge ? [offsetEdge.name] : [];
  const closureEdges = [startClosure?.name, endClosure?.name].filter(Boolean);
  face.userData.sheetMetalEdgeGroups = {
    baseEdges,
    offsetEdges,
    closureEdges,
  };
  return face;
}

function buildSegmentPolygon(pathSlice, offsetSlice) {
  const polygon = [];
  for (const coord of pathSlice) {
    polygon.push({ ...coord });
  }
  for (let i = offsetSlice.length - 1; i >= 0; i--) {
    polygon.push({ ...offsetSlice[i] });
  }
  return polygon;
}

function dedupePolygonCoords(coords) {
  const out = [];
  const push = (coord) => {
    if (!coord) return;
    if (!out.length || !coordsAlmostEqual(out[out.length - 1], coord)) {
      out.push({ u: coord.u, v: coord.v, w: coord.w });
    }
  };
  for (const coord of coords) push(coord);
  if (out.length >= 2 && coordsAlmostEqual(out[0], out[out.length - 1])) {
    out.pop();
  }
  return out;
}

function coordsAlmostEqual(a, b, eps = 1e-9) {
  if (!a || !b) return false;
  return (
    Math.abs(a.u - b.u) < eps
    && Math.abs(a.v - b.v) < eps
    && Math.abs((a.w || 0) - (b.w || 0)) < eps
  );
}

function triangulatePolygon(points) {
  if (!Array.isArray(points) || points.length < 3) return [];
  const contour = points.map((coord) => new THREE.Vector2(coord.u, coord.v));
  let tris = THREE.ShapeUtils.triangulateShape(contour, []);
  if (!Array.isArray(tris) || !tris.length) {
    tris = [];
    for (let i = 1; i < points.length - 1; i++) {
      tris.push([0, i, i + 1]);
    }
  }
  return tris;
}

let pseudoEdgeCounter = 0;
function createPseudoEdge(name, points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const sanitized = points.map((pt) => [pt.x, pt.y, pt.z]);
  return {
    type: "EDGE",
    name: name || `SMCF_EDGE_${pseudoEdgeCounter++}`,
    userData: { polylineLocal: sanitized },
    matrixWorld: new THREE.Matrix4(),
    closedLoop: false,
    updateWorldMatrix: () => { },
  };
}

function createPlaneBasisConverters(basis) {
  const origin = basis.origin instanceof THREE.Vector3
    ? basis.origin.clone()
    : Array.isArray(basis.origin)
      ? new THREE.Vector3().fromArray(basis.origin)
      : new THREE.Vector3(0, 0, 0);
  const xAxis = basis.xAxis instanceof THREE.Vector3
    ? basis.xAxis.clone()
    : Array.isArray(basis.xAxis)
      ? new THREE.Vector3().fromArray(basis.xAxis)
      : new THREE.Vector3(1, 0, 0);
  const yAxis = basis.yAxis instanceof THREE.Vector3
    ? basis.yAxis.clone()
    : Array.isArray(basis.yAxis)
      ? new THREE.Vector3().fromArray(basis.yAxis)
      : new THREE.Vector3(0, 1, 0);
  const planeNormal = basis.planeNormal instanceof THREE.Vector3
    ? basis.planeNormal.clone()
    : Array.isArray(basis.planeNormal)
      ? new THREE.Vector3().fromArray(basis.planeNormal)
      : new THREE.Vector3(0, 0, 1);
  return {
    to2D(vec) {
      const rel = vec.clone().sub(origin);
      return {
        u: rel.dot(xAxis),
        v: rel.dot(yAxis),
        w: rel.dot(planeNormal),
      };
    },
    to3D(coord) {
      return origin.clone()
        .add(xAxis.clone().multiplyScalar(coord.u))
        .add(yAxis.clone().multiplyScalar(coord.v))
        .add(planeNormal.clone().multiplyScalar(coord.w || 0));
    },
  };
}

function offsetPolyline2D(path2D, thickness, sheetSide) {
  if (!Array.isArray(path2D) || path2D.length < 2) return [];
  const EPS = 1e-10;
  const dirs = [];
  for (let i = 0; i < path2D.length - 1; i++) {
    const dx = path2D[i + 1].u - path2D[i].u;
    const dy = path2D[i + 1].v - path2D[i].v;
    const len = Math.hypot(dx, dy);
    dirs.push(len > EPS ? { x: dx / len, y: dy / len } : null);
  }

  let fallback = null;
  for (const dir of dirs) {
    if (dir) {
      fallback = dir;
      break;
    }
  }
  if (!fallback) fallback = { x: 1, y: 0 };

  const sideSign = sheetSide === "right" ? -1 : 1;
  const safeDir = (dir) => (dir && Number.isFinite(dir.x) && Number.isFinite(dir.y)
    ? dir
    : fallback);
  const rotateDir = (dir) => {
    const base = safeDir(dir);
    return { x: -base.y * sideSign, y: base.x * sideSign };
  };
  const offsetPoint = (pt, perp) => ({
    u: pt.u + perp.x * thickness,
    v: pt.v + perp.y * thickness,
    w: pt.w,
  });
  const offsets = new Array(path2D.length);
  const getPrevDir = (vertexIndex) => {
    for (let seg = vertexIndex - 1; seg >= 0; seg--) {
      if (dirs[seg]) return dirs[seg];
    }
    return fallback;
  };
  const getNextDir = (vertexIndex) => {
    for (let seg = vertexIndex; seg < dirs.length; seg++) {
      if (dirs[seg]) return dirs[seg];
    }
    return fallback;
  };

  offsets[0] = offsetPoint(path2D[0], rotateDir(getNextDir(0)));
  for (let i = 1; i < path2D.length - 1; i++) {
    const prevDir = safeDir(getPrevDir(i));
    const nextDir = safeDir(getNextDir(i));
    const perpPrev = rotateDir(prevDir);
    const perpNext = rotateDir(nextDir);
    const a = offsetPoint(path2D[i], perpPrev);
    const b = offsetPoint(path2D[i], perpNext);
    const hit = intersectLines2D(a, prevDir, b, nextDir);
    if (hit) {
      offsets[i] = { u: hit.u, v: hit.v, w: path2D[i].w };
    } else {
      offsets[i] = {
        u: 0.5 * (a.u + b.u),
        v: 0.5 * (a.v + b.v),
        w: path2D[i].w,
      };
    }
  }
  offsets[path2D.length - 1] = offsetPoint(path2D[path2D.length - 1], rotateDir(getPrevDir(path2D.length - 1)));
  return offsets;
}

function intersectLines2D(pointA, dirA, pointB, dirB) {
  const dAx = dirA?.x ?? 0;
  const dAy = dirA?.y ?? 0;
  const dBx = dirB?.x ?? 0;
  const dBy = dirB?.y ?? 0;
  const denom = dAx * dBy - dAy * dBx;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) {
    return null;
  }
  const diffX = pointB.u - pointA.u;
  const diffY = pointB.v - pointA.v;
  const t = (diffX * dBy - diffY * dBx) / denom;
  return {
    u: pointA.u + dAx * t,
    v: pointA.v + dAy * t,
    w: pointA.w,
  };
}

function polygonArea2D(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += (a.u * b.v) - (a.v * b.u);
  }
  return area / 2;
}

function resolveSheetSideOption(inputParams) {
  const legacyValue = inputParams?.sheetSide;
  const reverseRaw = inputParams?.reverseSheetSide;
  let sheetSide = "left";
  if (typeof reverseRaw === "boolean") {
    sheetSide = reverseRaw ? "right" : "left";
  } else if (legacyValue != null) {
    sheetSide = (String(legacyValue).toLowerCase() === "right") ? "right" : "left";
  }
  const reverseSheetSide = sheetSide === "right";
  if (inputParams && typeof reverseRaw !== "boolean") {
    inputParams.reverseSheetSide = reverseSheetSide;
  }
  return { sheetSide, reverseSheetSide };
}

function normalizeSegmentNameCount(names, expectedLength) {
  const count = Math.max(0, Number(expectedLength) || 0);
  const result = new Array(count);
  for (let i = 0; i < count; i++) {
    const raw = Array.isArray(names) ? names[i] : null;
    if (typeof raw === "string" && raw.trim().length) {
      result[i] = raw.trim();
    } else {
      result[i] = `SEG_${i}`;
    }
  }
  return result;
}

function buildDefaultSegmentNames(count) {
  const total = Math.max(0, Number(count) || 0);
  return Array.from({ length: total }, (_, i) => `SEG_${i}`);
}

function buildFilletEdgeName(nameA, nameB) {
  const left = (typeof nameA === "string" && nameA.trim().length) ? nameA.trim() : null;
  const right = (typeof nameB === "string" && nameB.trim().length) ? nameB.trim() : null;
  if (left && right && left !== right) return `${left}__${right}`;
  if (left && right) return `${left}_ARC`;
  if (left) return `${left}__SMCF`;
  if (right) return `SMCF__${right}`;
  return "SMCF_FILLET";
}

function deriveEdgeBaseName(edge, fallbackIndex) {
  const fallback = `EDGE_${fallbackIndex}`;
  if (!edge) return fallback;
  const direct = typeof edge.name === "string" && edge.name.trim().length ? edge.name.trim() : null;
  if (direct) return direct;
  const skId = edge.userData?.sketchGeometryId ?? edge.userData?.sketchGeomId ?? edge.userData?.id;
  if (skId != null) return `SKETCH_EDGE_${skId}`;
  const uid = edge.uuid ? String(edge.uuid).slice(0, 8) : null;
  if (uid) return `EDGE_${uid}`;
  return fallback;
}

function tagContourFlangeFaceTypes(sweep) {
  if (!sweep || typeof sweep.getFaceNames !== "function") return;
  const names = sweep.getFaceNames();
  const thicknessFaces = names.filter((name) =>
    name.endsWith("_START")
    || name.endsWith("_END")
    || name.includes("_CAP_SW"),
  );
  const bFaces = names.filter((name) => name.includes("_OFFSET_SW"));
  const aFaces = names.filter((name) =>
    name.endsWith("_SW")
    && !name.includes("_OFFSET_SW")
    && !name.includes("_CAP_SW"),
  );
  setSheetMetalFaceTypeMetadata(sweep, aFaces, SHEET_METAL_FACE_TYPES.A);
  setSheetMetalFaceTypeMetadata(sweep, bFaces, SHEET_METAL_FACE_TYPES.B);
  setSheetMetalFaceTypeMetadata(sweep, thicknessFaces, SHEET_METAL_FACE_TYPES.THICKNESS);
}
