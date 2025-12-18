import { BREP } from "../../BREP/BREP.js";
import {
  SHEET_METAL_FACE_TYPES,
  setSheetMetalFaceTypeMetadata,
  propagateSheetMetalFaceTypesToEdges,
} from "./sheetMetalFaceTypes.js";
import { applySheetMetalMetadata } from "./sheetMetalMetadata.js";
import { resolveProfileFace } from "./profileUtils.js";

const inputParamsSchema = {
  id: {
    type: "string",
    default_value: null,
    hint: "Unique identifier for the sheet metal cutout",
  },
  sheet: {
    type: "reference_selection",
    selectionFilter: ["SOLID"],
    multiple: false,
    default_value: null,
    hint: "Target sheet metal solid to cut",
  },
  profile: {
    type: "reference_selection",
    selectionFilter: ["SOLID", "FACE", "SKETCH",],
    multiple: false,
    default_value: null,
    hint: "Solid tool or sketch/face to extrude as a cutting tool.",
  },
  forwardDistance: {
    type: "number",
    default_value: 1,
    min: 0,
    hint: "Extrude distance forward from the profile (sketch/face only).",
  },
  backDistance: {
    type: "number",
    default_value: 0,
    min: 0,
    hint: "Extrude distance backward from the profile (sketch/face only).",
  },
  keepTool: {
    type: "boolean",
    default_value: false,
    hint: "Keep the generated cutting tool in the scene (for debugging).",
  },
  debugCutter: {
    type: "boolean",
    default_value: false,
    hint: "Keep the internal cleanup cutter used for the final subtract.",
  },
};

export class SheetMetalCutoutFeature {
  static shortName = "SM.CUTOUT";
  static longName = "Sheet Metal Cutout";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
    this.debugTool = null;
  }

  uiFieldsTest(partHistory) {
    const include = ["sheet", "profile", "keepTool", "debugCutter"];
    const exclude = [];
    const profileRef = firstSelection(this.inputParams?.profile);
    const resolvedProfile = resolveProfileFace(profileRef, partHistory) || profileRef;
    const profileType = resolvedProfile?.type;
    const allowDistances = (profileType === "FACE" || profileType === "SKETCH");
    if (allowDistances) {
      include.push("forwardDistance", "backDistance");
    } else {
      exclude.push("forwardDistance", "backDistance");
    }

    return { include, exclude };
  }

  async run(partHistory) {
    const scene = partHistory?.scene;
    const metadataManager = partHistory?.metadataManager;
    const sheetRef = firstSelection(this.inputParams?.sheet);
    let sheetSolid = resolveSolidRef(sheetRef, scene);

    const tools = [];
    this.debugTool = null;

    // Profile can be a solid (use directly) or a face/sketch (extrude).
    const profileSelection = firstSelection(this.inputParams?.profile);
    const profileSolid = (profileSelection && profileSelection.type === "SOLID")
      ? profileSelection
      : (typeof profileSelection === "string" ? partHistory?.getObjectByName?.(profileSelection) : null);
    if (profileSolid && profileSolid.type === "SOLID") {
      tools.push(profileSolid);
    } else {
      const profileFace = resolveProfileFace(profileSelection, partHistory);
      if (profileFace && profileFace.type === "FACE") {
        const profileTool = buildToolFromProfile(profileFace, this.inputParams, this.inputParams?.featureID || "SM_CUTOUT_PROFILE");
        if (profileTool) {
          tools.push(profileTool);
          this.debugTool = profileTool;
        }
      }
    }

    // Require explicit sheet; if missing, try to infer from sheet metadata in scene as a last resort.
    if (!sheetSolid) {
      sheetSolid = findFirstSheetMetalSolid(scene, metadataManager);
    }

    if (!sheetSolid) throw new Error("Sheet Metal Cutout requires a valid sheet metal solid selection.");
    if (!tools.length) {
      throw new Error("Sheet Metal Cutout needs a Profile selection (solid or face) to build the cutting tool.");
    }

    const toolUnion = unionSolids(tools);
    if (!toolUnion) throw new Error("Failed to combine cutting tools for Sheet Metal Cutout.");

    const sheetThickness = resolveSheetThickness(sheetSolid, partHistory?.metadataManager);
    if (!(sheetThickness > 0)) throw new Error("Sheet Metal Cutout could not resolve sheet metal thickness.");

    let added = [];
    let removed = [];
    const keepCutter = this.inputParams?.debugCutter === true;
    let working = sheetSolid;

    // Step 1: remove the original tool volume to honor its shape.
    if (toolUnion) {
      try {
        working = sheetSolid.subtract(toolUnion);
        working.visualize?.();
        removed.push(sheetSolid, toolUnion);
      } catch (toolErr) {
        console.warn("[SheetMetalCutout] Subtracting cutting tool failed, falling back to boolean", toolErr);
        const effects = await BREP.applyBooleanOperation(
          partHistory || {},
          toolUnion,
          { operation: "SUBTRACT", targets: [sheetSolid] },
          this.inputParams?.featureID,
        );
        const candidate = Array.isArray(effects?.added) ? effects.added[0] : null;
        if (!candidate) throw new Error("Sheet Metal Cutout could not subtract the cutting tool.");
        candidate.visualize?.();
        working = candidate;
        removed.push(...(effects?.removed || []), sheetSolid, toolUnion);
      }
    }

    const sheetFaces = collectSheetFaces(working);
    if (!sheetFaces.A.length && !sheetFaces.B.length) {
      throw new Error("Sheet Metal Cutout could not find sheet metal A/B faces on the target. Ensure the target solid has sheet-metal metadata.");
    }

    const faceInfoMap = buildSheetFaceInfoMap(sheetFaces);
    const faceTypeMap = buildFaceTypeMap(working);
    let prisms = buildPrismsFromBoundaryLoops(working, faceInfoMap, faceTypeMap, sheetThickness, this.inputParams?.featureID);

    if (!prisms.length) {
      const intersection = safeIntersect(sheetSolid, toolUnion) || await safeIntersectFallbackBoolean(partHistory, sheetSolid, toolUnion, this.inputParams?.featureID);
      if (intersection) {
        prisms = buildPrismsFromIntersection(intersection, sheetSolid, sheetThickness, this.inputParams?.featureID);
      }
    }

    let cutPrism = null;
    if (!prisms.length) {
      console.warn("[SheetMetalCutout] Cleanup footprint not found; keeping direct subtract result.");
      if (working) {
        try { working.name = this.inputParams?.featureID || working.name || sheetSolid.name; } catch { /* ignore */ }
        added = [working];
      }
      removed.push(...tools);
    } else {
      cutPrism = prisms[0];
      for (let i = 1; i < prisms.length; i++) {
        try { cutPrism = cutPrism.union(prisms[i]); } catch { cutPrism = prisms[i]; }
      }
      if (this.inputParams?.featureID && cutPrism) {
        try { cutPrism.name = `${this.inputParams.featureID}_CUTOUT_CUTTER`; } catch { /* best effort */ }
      }

      // Step 2: cut perpendicular walls using the planar footprint prisms on the original sheet.
      try {
        const finalCut = sheetSolid.subtract(cutPrism);
        finalCut.visualize?.();
        try { finalCut.name = sheetSolid?.name || finalCut.name; } catch { /* ignore */ }
        added = [finalCut];
        removed.push(sheetSolid, working, cutPrism, ...tools);
      } catch (directErr) {
        console.warn("[SheetMetalCutout] Subtracting cleanup prisms failed, falling back to boolean", directErr);
        const effects = await BREP.applyBooleanOperation(
          partHistory || {},
          cutPrism,
          { operation: "SUBTRACT", targets: [sheetSolid] },
          this.inputParams?.featureID,
        );
        const candidate = Array.isArray(effects?.added) ? effects.added[0] : null;
        if (!candidate) throw new Error("Sheet Metal Cutout could not complete the cleanup cut.");
        try { candidate.name = sheetSolid?.name || candidate.name; } catch { /* ignore */ }
        removed.push(...(effects?.removed || []), sheetSolid, working, cutPrism, ...tools);
        added = effects?.added || [];
      }
    }

    if (keepCutter && cutPrism) {
      added.push(cutPrism);
      removed = removed.filter((o) => o !== cutPrism);
      try { cutPrism.visualize?.(); } catch { /* ignore */ }
    }

    const keepTool = this.inputParams?.keepTool === true;
    if (keepTool && tools?.length) {
      removed = removed.filter((o) => !tools.includes(o) && o !== toolUnion);
    }
    try { for (const obj of removed) { if (obj) obj.__removeFlag = true; } } catch { /* ignore */ }

    propagateSheetMetalFaceTypesToEdges(added);
    applySheetMetalMetadata(added, partHistory?.metadataManager, {
      featureID: this.inputParams?.featureID || null,
      thickness: sheetThickness,
      baseType: sheetSolid?.userData?.sheetMetal?.baseType || null,
      bendRadius: sheetSolid?.userData?.sheetMetal?.bendRadius ?? null,
      extra: { sourceFeature: "CUTOUT" },
      forceBaseOverwrite: false,
    });

    // Optionally keep the generated tool for debugging
    if (this.inputParams?.keepTool && this.debugTool) {
      added.push(this.debugTool);
      try { this.debugTool.visualize?.(); } catch { /* ignore */ }
    }

    this.persistentData = {
      sheetName: sheetSolid?.name || null,
      toolCount: tools.length,
      sheetThickness,
      footprintFaceTypes: {
        A: sheetFaces.A.length,
        B: sheetFaces.B.length,
      },
    };

    return { added, removed };
  }
}

function firstSelection(sel) {
  if (Array.isArray(sel)) return sel[0] || null;
  return sel || null;
}

function resolveSolidRef(ref, scene) {
  const target = firstSelection(ref);
  if (!target) return null;
  if (target.type === "SOLID") return target;
  if (target.type === "FACE") return findAncestorSolid(target);
  if (typeof target === "string" && scene?.getObjectByName) {
    const obj = scene.getObjectByName(target);
    if (obj?.type === "SOLID") return obj;
    if (obj?.type === "FACE") return findAncestorSolid(obj);
  }
  return null;
}

function findAncestorSolid(obj) {
  let current = obj;
  while (current) {
    if (current.type === "SOLID") return current;
    current = current.parent;
  }
  return null;
}

function findFirstSheetMetalSolid(scene, metadataManager) {
  if (!scene || !Array.isArray(scene.children)) return null;
  for (const child of scene.children) {
    if (child && child.type === "SOLID" && resolveSheetThickness(child, metadataManager)) {
      return child;
    }
  }
  return null;
}

function buildToolFromProfile(face, params, name) {
  if (!face) return null;
  const fdRaw = Number(params?.forwardDistance ?? 0);
  const bdRaw = Number(params?.backDistance ?? 0);
  const fd = Number.isFinite(fdRaw) ? Math.max(0, fdRaw) : 0;
  const bd = Number.isFinite(bdRaw) ? Math.max(0, bdRaw) : 0;
  const minTravel = 1e-4;
  const travelF = fd > 0 ? fd : minTravel;
  const travelB = bd > 0 ? bd : 0;
  return new BREP.ExtrudeSolid({
    face,
    distance: travelF,
    distanceBack: travelB,
    name: name || "SM_CUTOUT_PROFILE",
  });
}


function unionSolids(solids) {
  if (!Array.isArray(solids) || !solids.length) return null;
  let combined = solids[0];
  for (let i = 1; i < solids.length; i++) {
    try { combined = combined.union(solids[i]); }
    catch { combined = solids[i]; }
  }
  return combined;
}

function safeIntersect(a, b) {
  try {
    const out = a.intersect(b);
    out.visualize?.();
    return out;
  } catch (err) {
    console.warn("[SheetMetalCutout] Intersection failed", err);
    // Fallback: try a light weld/clean if possible
    try {
      const aa = typeof a.clone === "function" ? a.clone() : a;
      const bb = typeof b.clone === "function" ? b.clone() : b;
      const scale = 1;
      const eps = Math.max(1e-9, 1e-6 * scale);
      try { aa.setEpsilon?.(eps); bb.setEpsilon?.(eps); } catch { }
      try { aa.fixTriangleWindingsByAdjacency?.(); bb.fixTriangleWindingsByAdjacency?.(); } catch { }
      const out2 = aa.intersect(bb);
      out2.visualize?.();
      return out2;
    } catch (fallbackErr) {
      console.warn("[SheetMetalCutout] Intersection fallback failed", fallbackErr);
    }
    return null;
  }
}

async function safeIntersectFallbackBoolean(partHistory, sheetSolid, toolUnion, featureID) {
  try {
    const effects = await BREP.applyBooleanOperation(
      partHistory || {},
      sheetSolid,
      { operation: "INTERSECT", targets: [toolUnion] },
      featureID,
    );
    if (effects?.added?.length) {
      const pick = Array.isArray(effects.added) ? effects.added[0] : null;
      pick?.visualize?.();
      return pick;
    }
  } catch (err) {
    console.warn("[SheetMetalCutout] Boolean fallback intersect failed", err);
  }
  return null;
}

function resolveSheetThickness(solid, metadataManager) {
  const candidates = [];
  const push = (v) => { const n = Number(v); if (Number.isFinite(n) && Math.abs(n) > 1e-9) candidates.push(Math.abs(n)); };
  if (solid?.userData?.sheetMetal) {
    const sm = solid.userData.sheetMetal;
    push(sm.thickness); push(sm.baseThickness);
  }
  push(solid?.userData?.sheetThickness);
  if (metadataManager && solid?.name) {
    try {
      const meta = metadataManager.getOwnMetadata(solid.name);
      push(meta?.sheetMetalThickness);
    } catch { /* ignore */ }
  }
  return candidates.find((v) => v > 0) || null;
}

function collectSheetFaces(solid) {
  const faces = { A: [], B: [] };
  if (!solid || typeof solid.getFaceNames !== "function") return faces;
  const THREE = BREP.THREE;
  const matrixWorld = solid.matrixWorld || new THREE.Matrix4();

  for (const name of solid.getFaceNames()) {
    const meta = solid.getFaceMetadata(name) || {};
    const type = meta.sheetMetalFaceType;
    if (type !== SHEET_METAL_FACE_TYPES.A && type !== SHEET_METAL_FACE_TYPES.B) continue;
    const tris = solid.getFace(name);
    if (!Array.isArray(tris) || !tris.length) continue;
    const { normal, origin } = faceNormalAndOrigin(tris, matrixWorld);
    if (!normal) continue;
    const entry = { faceName: name, triangles: tris, normal, origin };
    if (type === SHEET_METAL_FACE_TYPES.A) faces.A.push(entry);
    else faces.B.push(entry);
  }
  faces.A.sort((a, b) => b.triangles.length - a.triangles.length);
  faces.B.sort((a, b) => b.triangles.length - a.triangles.length);
  return faces;
}

function buildSheetFaceInfoMap(sheetFaces) {
  const map = new Map();
  for (const entry of sheetFaces.A) {
    map.set(entry.faceName, { ...entry, targetType: SHEET_METAL_FACE_TYPES.A });
  }
  for (const entry of sheetFaces.B) {
    map.set(entry.faceName, { ...entry, targetType: SHEET_METAL_FACE_TYPES.B });
  }
  return map;
}

function buildFaceTypeMap(solid) {
  const map = new Map();
  if (!solid || typeof solid.getFaceNames !== "function") return map;
  for (const name of solid.getFaceNames()) {
    const meta = solid.getFaceMetadata(name) || {};
    map.set(name, meta.sheetMetalFaceType || null);
  }
  return map;
}

function renameExtrudeCapFaces(solid, baseName) {
  if (!solid || typeof solid.getFaceNames !== "function" || typeof solid.renameFace !== "function") return;
  const safeBase = baseName || "SM_CUTOUT_PRISM";
  const capName = `${safeBase}_ENDCAP`;
  for (const name of solid.getFaceNames()) {
    if (typeof name !== "string") continue;
    if (name.endsWith("_START")) {
      solid.renameFace(name, capName);
    } else if (name.endsWith("_END")) {
      solid.renameFace(name, capName);
    }
  }
}

function buildPrismsFromBoundaryLoops(solid, faceInfoMap, faceTypeMap, sheetThickness, featureID) {
  const loopsByFace = collectCutoutLoopsFromBoundary(solid, faceTypeMap);
  const prisms = [];
  const THREE = BREP.THREE;
  for (const [faceName, loops] of loopsByFace.entries()) {
    const faceInfo = faceInfoMap.get(faceName);
    if (!faceInfo || !Array.isArray(loops) || !loops.length) continue;
    const loopPoints = loops.map((loop) => loop.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
    const loopEdgeGroups = loops.map((loop) => loop.edgeGroups);
    const profiles = buildFaceProfiles(loopPoints, faceInfo.normal, faceInfo.origin, featureID, loopEdgeGroups);
    for (const profile of profiles) {
      const dir = faceInfo.normal.clone().normalize().multiplyScalar(
        faceInfo.targetType === SHEET_METAL_FACE_TYPES.B ? sheetThickness : -sheetThickness
      );
      const travel = sheetThickness;
      const prism = new BREP.ExtrudeSolid({
        face: profile,
        distance: travel * 0.1,
        distanceBack: travel * 1.1,
        name: featureID,
      });
      renameExtrudeCapFaces(prism, featureID || "SM_CUTOUT_PRISM");
      tagThicknessFaces(prism);
      prisms.push(prism);
    }
  }
  return prisms;
}

function buildPrismsFromIntersection(intersection, sheetSolid, sheetThickness, featureID) {
  if (!intersection) return [];
  const footprintFaces = collectSheetFaces(intersection);
  const hasA = footprintFaces.A.length > 0;
  const hasB = footprintFaces.B.length > 0;
  if (!hasA && !hasB) return [];
  const basisFaces = [
    ...footprintFaces.A.map((f) => ({ ...f, targetType: SHEET_METAL_FACE_TYPES.A })),
    ...footprintFaces.B.map((f) => ({ ...f, targetType: SHEET_METAL_FACE_TYPES.B })),
  ];
  const prisms = [];
  for (const faceInfo of basisFaces) {
    const loops = buildBoundaryLoops(faceInfo.triangles, intersection?.matrixWorld || sheetSolid.matrixWorld);
    if (!loops.length) continue;
    const profiles = buildFaceProfiles(loops, faceInfo.normal, faceInfo.origin, featureID);
    for (const profile of profiles) {
      const dir = faceInfo.normal.clone().normalize().multiplyScalar(
        faceInfo.targetType === SHEET_METAL_FACE_TYPES.B ? sheetThickness : -sheetThickness
      );
      const travel = Math.max(sheetThickness, 1e-6);
      const prism = new BREP.ExtrudeSolid({
        face: profile,
        dir,
        distance: travel,
        distanceBack: travel,
        name: featureID || "SM_CUTOUT_PRISM",
      });
      renameExtrudeCapFaces(prism, featureID || "SM_CUTOUT_PRISM");
      tagThicknessFaces(prism);
      prisms.push(prism);
    }
  }
  return prisms;
}

function collectCutoutLoopsFromBoundary(solid, faceTypeMap) {
  const THREE = BREP.THREE;
  const loopsByFace = new Map();
  if (!solid || typeof solid.getBoundaryEdgePolylines !== "function") return loopsByFace;
  const polylines = solid.getBoundaryEdgePolylines() || [];
  const mat = solid.matrixWorld || new THREE.Matrix4();

  for (const poly of polylines) {
    const typeA = faceTypeMap.get(poly.faceA) || null;
    const typeB = faceTypeMap.get(poly.faceB) || null;
    const isSheetA = typeA === SHEET_METAL_FACE_TYPES.A || typeA === SHEET_METAL_FACE_TYPES.B;
    const isSheetB = typeB === SHEET_METAL_FACE_TYPES.A || typeB === SHEET_METAL_FACE_TYPES.B;
    if (isSheetA === isSheetB) continue;
    const otherType = isSheetA ? typeB : typeA;
    if (otherType === SHEET_METAL_FACE_TYPES.THICKNESS) continue;
    const sheetFace = isSheetA ? poly.faceA : poly.faceB;
    const toolFace = isSheetA ? poly.faceB : poly.faceA;
    const pts = [];
    const raw = Array.isArray(poly.positions) ? poly.positions : [];
    for (const p of raw) {
      const v = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(mat);
      pts.push([v.x, v.y, v.z]);
    }
    const clean = dedupPolylinePoints(pts);
    if (clean.length < 2) continue;
    const entry = loopsByFace.get(sheetFace) || [];
    entry.push({ name: toolFace, pts: clean });
    loopsByFace.set(sheetFace, entry);
  }

  const out = new Map();
  for (const [faceName, segments] of loopsByFace.entries()) {
    const loops = stitchCutoutLoops(segments);
    if (loops.length) out.set(faceName, loops);
  }
  return out;
}

function stitchCutoutLoops(segments) {
  const loops = [];
  const used = new Set();
  const clonePts = (pts) => pts.map((p) => [p[0], p[1], p[2]]);

  const appendGroup = (groups, name, pts) => {
    if (!pts.length) return;
    if (groups.length && groups[groups.length - 1].name === name) {
      groups[groups.length - 1].pts.push(...pts.slice(1));
    } else {
      groups.push({ name, pts: pts.slice() });
    }
  };

  const prependGroup = (groups, name, pts) => {
    if (!pts.length) return;
    if (groups.length && groups[0].name === name) {
      groups[0].pts = pts.slice(0, -1).concat(groups[0].pts);
    } else {
      groups.unshift({ name, pts: pts.slice() });
    }
  };

  for (let i = 0; i < segments.length; i++) {
    if (used.has(i)) continue;
    const seg = segments[i];
    if (!seg || !Array.isArray(seg.pts) || seg.pts.length < 2) continue;
    let loopPts = clonePts(seg.pts);
    let groups = [{ name: seg.name, pts: clonePts(seg.pts) }];
    used.add(i);

    let advanced = true;
    while (advanced) {
      advanced = false;
      const start = loopPts[0];
      const end = loopPts[loopPts.length - 1];
      if (pointsEqual(start, end)) break;

      for (let j = 0; j < segments.length; j++) {
        if (used.has(j)) continue;
        const s = segments[j];
        if (!s || !Array.isArray(s.pts) || s.pts.length < 2) continue;
        const sPts = clonePts(s.pts);
        const sStart = sPts[0];
        const sEnd = sPts[sPts.length - 1];

        if (pointsEqual(end, sStart) || pointsEqual(end, sEnd)) {
          const forward = pointsEqual(end, sStart);
          const segPts = forward ? sPts : sPts.slice().reverse();
          loopPts = loopPts.concat(segPts.slice(1));
          appendGroup(groups, s.name, segPts);
          used.add(j);
          advanced = true;
          break;
        }

        if (pointsEqual(start, sEnd) || pointsEqual(start, sStart)) {
          const forward = pointsEqual(start, sEnd);
          const segPts = forward ? sPts : sPts.slice().reverse();
          loopPts = segPts.slice(0, -1).concat(loopPts);
          prependGroup(groups, s.name, segPts);
          used.add(j);
          advanced = true;
          break;
        }
      }
    }

    const closed = loopPts.length >= 3 && pointsEqual(loopPts[0], loopPts[loopPts.length - 1]);
    if (!closed) continue;
    loopPts = loopPts.slice(0, -1);

    if (loopPts.length >= 3) {
      loops.push({
        points: loopPts,
        edgeGroups: groups.map((g) => ({ name: g.name, pts: dedupPolylinePoints(g.pts) })),
      });
    }
  }
  return loops;
}

function dedupPolylinePoints(pts, eps = 1e-5) {
  const out = [];
  for (const p of pts || []) {
    if (!out.length || !pointsEqual(out[out.length - 1], p, eps)) {
      out.push([p[0], p[1], p[2]]);
    }
  }
  return out;
}

function pointsEqual(a, b, eps = 1e-5) {
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) <= eps
    && Math.abs(a[1] - b[1]) <= eps
    && Math.abs(a[2] - b[2]) <= eps;
}

function faceNormalAndOrigin(triangles, matrixWorld) {
  const THREE = BREP.THREE;
  const n = new THREE.Vector3();
  const accum = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let count = 0;
  for (const tri of triangles) {
    a.fromArray(tri.p1).applyMatrix4(matrixWorld);
    b.fromArray(tri.p2).applyMatrix4(matrixWorld);
    c.fromArray(tri.p3).applyMatrix4(matrixWorld);
    const ab = b.clone().sub(a);
    const ac = c.clone().sub(a);
    const cross = ac.cross(ab);
    n.add(cross);
    accum.add(a).add(b).add(c);
    count += 3;
  }
  if (n.lengthSq() < 1e-14) return { normal: null, origin: null };
  n.normalize();
  const origin = count ? accum.multiplyScalar(1 / count) : new THREE.Vector3();
  return { normal: n, origin };
}

function buildBoundaryLoops(triangles, matrixWorld) {
  const THREE = BREP.THREE;
  const mat = (matrixWorld && matrixWorld.isMatrix4) ? matrixWorld : new THREE.Matrix4();
  const verts = [];
  const keyToIndex = new Map();
  const indices = [];
  const keyFor = (p) => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`;

  const tmp = new THREE.Vector3();
  for (const tri of triangles) {
    const pts = [tri.p1, tri.p2, tri.p3].map((p) => tmp.fromArray(p).applyMatrix4(mat).clone());
    const idx = pts.map((p) => {
      const k = keyFor(p);
      if (keyToIndex.has(k)) return keyToIndex.get(k);
      const i = verts.length;
      verts.push(p.clone());
      keyToIndex.set(k, i);
      return i;
    });
    indices.push(...idx);
  }

  const edgeCount = new Map(); // "a:b" -> count
  const edgeKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const edges = [[a, b], [b, c], [c, a]];
    for (const [u, v] of edges) {
      const k = edgeKey(u, v);
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    }
  }

  const adjacency = new Map(); // v -> Set(neighbors)
  for (const [k, count] of edgeCount.entries()) {
    if (count !== 1) continue;
    const [a, b] = k.split(":").map((s) => parseInt(s, 10));
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a).add(b);
    adjacency.get(b).add(a);
  }

  const visited = new Set();
  const loopList = [];
  const visitEdge = (a, b) => visited.add(edgeKey(a, b));
  const seenEdge = (a, b) => visited.has(edgeKey(a, b));

  for (const [start, nbrs] of adjacency.entries()) {
    for (const nbor of nbrs) {
      if (seenEdge(start, nbor)) continue;
      const loop = [];
      let prev = start;
      let curr = nbor;
      visitEdge(prev, curr);
      loop.push(prev, curr);
      while (true) {
        const neighbors = adjacency.get(curr) || new Set();
        let next = null;
        for (const cand of neighbors) {
          if (cand === prev) continue;
          if (seenEdge(curr, cand)) continue;
          next = cand; break;
        }
        if (next === null || next === undefined) break;
        prev = curr;
        curr = next;
        visitEdge(prev, curr);
        if (curr === loop[0]) break;
        loop.push(curr);
      }
      if (loop.length >= 3) loopList.push(loop.map((idx) => verts[idx].clone()));
    }
  }
  return loopList;
}

function buildFaceProfiles(loopPoints, normal, originHint, featureID, loopEdgeGroups = null) {
  const THREE = BREP.THREE;
  const origin = originHint ? originHint.clone() : loopPoints[0]?.[0]?.clone() || new THREE.Vector3();
  const { u, v: basisV } = buildBasis(normal);

  const loops2D = loopPoints.map((pts) => pts.map((p) => {
    const rel = p.clone().sub(origin);
    return new THREE.Vector2(rel.dot(u), rel.dot(basisV));
  }));

  const meta = loops2D.map((loop, idx) => {
    const area = area2D(loop);
    return {
      idx,
      loop,
      area,
      absArea: Math.abs(area),
    };
  });

  // Assign each loop to the smallest containing parent (if any) to preserve disjoint cutouts.
  for (const entry of meta) {
    const sample = entry.loop[0];
    let parent = null;
    let parentArea = Infinity;
    for (const candidate of meta) {
      if (candidate.idx === entry.idx) continue;
      if (candidate.absArea <= entry.absArea) continue;
      if (!pointInPoly(sample, candidate.loop)) continue;
      if (candidate.absArea < parentArea) {
        parentArea = candidate.absArea;
        parent = candidate.idx;
      }
    }
    entry.parent = parent;
  }

  const faces = [];
  const outers = meta.filter((m) => m.parent == null);
  for (const outerMeta of outers) {
    const shape = new THREE.Shape();
    const outerLoop = ensureOrientation(outerMeta.loop, true);
    moveToPath(shape, outerLoop);

    const holes = meta.filter((m) => m.parent === outerMeta.idx);
    for (const hole of holes) {
      const path = new THREE.Path();
      const oriented = ensureOrientation(hole.loop, false);
      moveToPath(path, oriented);
      shape.holes.push(path);
    }

    const geom = new THREE.ShapeGeometry(shape);
    const pos = geom.getAttribute("position");
    const tmpV = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      tmpV.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      const world = origin.clone().addScaledVector(u, tmpV.x).addScaledVector(basisV, tmpV.y);
      pos.setXYZ(i, world.x, world.y, world.z);
    }
    geom.computeVertexNormals();

    const face = new BREP.Face(geom);
    face.name = featureID ? `${featureID}_CUTOUT_FACE` : "CUTOUT_FACE";
    face.userData = face.userData || {};
    const loopsForFace = [outerMeta.idx, ...holes.map((h) => h.idx)];
    face.userData.boundaryLoopsWorld = loopsForFace.map((idx) => ({
      pts: loopPoints[idx].map((p) => [p.x, p.y, p.z]),
      isHole: idx !== outerMeta.idx,
    }));
    if (Array.isArray(loopEdgeGroups)) {
      const edgeGroups = [];
      for (const idx of loopsForFace) {
        const groups = loopEdgeGroups[idx];
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
          if (!g || !Array.isArray(g.pts) || g.pts.length < 2) continue;
          edgeGroups.push({
            name: g.name,
            pts: g.pts.map((p) => (Array.isArray(p) ? [p[0], p[1], p[2]] : [p.x, p.y, p.z])),
            isHole: idx !== outerMeta.idx,
          });
        }
      }
      if (edgeGroups.length) {
        face.userData.boundaryEdgeGroups = edgeGroups;
      }
    }
    face.updateMatrixWorld?.(true);
    faces.push(face);
  }

  return faces;
}

function buildBasis(normal) {
  const THREE = BREP.THREE;
  const n = normal.clone().normalize();
  const ref = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(ref, n);
  if (u.lengthSq() < 1e-10) u.set(1, 0, 0);
  u.normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v, n };
}

function area2D(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    a += p.x * q.y - q.x * p.y;
  }
  return 0.5 * a;
}

function ensureOrientation(loop, wantCCW) {
  const a = area2D(loop);
  const isCCW = a > 0;
  if ((wantCCW && isCCW) || (!wantCCW && !isCCW)) return loop.slice();
  return loop.slice().reverse();
}

function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y))
      && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 1e-16) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function moveToPath(path, loop) {
  if (!loop.length) return;
  path.moveTo(loop[0].x, loop[0].y);
  for (let i = 1; i < loop.length; i++) {
    path.lineTo(loop[i].x, loop[i].y);
  }
  path.lineTo(loop[0].x, loop[0].y);
}

function tagThicknessFaces(solid) {
  if (!solid || typeof solid.getFaceNames !== "function") return;
  const sideFaces = solid.getFaceNames().filter((n) => n && n.endsWith("_SW"));
  setSheetMetalFaceTypeMetadata(solid, sideFaces, SHEET_METAL_FACE_TYPES.THICKNESS);
}
