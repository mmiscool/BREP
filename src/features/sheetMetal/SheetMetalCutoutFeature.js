import { BREP } from "../../BREP/BREP.js";
import {
  SHEET_METAL_FACE_TYPES,
  setSheetMetalFaceTypeMetadata,
  propagateSheetMetalFaceTypesToEdges,
} from "./sheetMetalFaceTypes.js";
import { applySheetMetalMetadata } from "./sheetMetalMetadata.js";

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
  boolean: {
    type: "boolean_operation",
    default_value: { targets: [], operation: "SUBTRACT" },
    hint: "Solids to use as cutting tools (combined as a union).",
  },
};

export class SheetMetalCutoutFeature {
  static shortName = "SM.CUTOUT";
  static longName = "Sheet Metal Cutout";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const scene = partHistory?.scene;
    const metadataManager = partHistory?.metadataManager;
    let sheetSolid = resolveSolidRef(this.inputParams?.sheet, scene);

    let { tools, op } = await resolveBooleanTools(this.inputParams?.boolean, scene);
    if (op === "NONE") return { added: [], removed: [] };

    // Fallback: if sheet not explicitly provided, infer it from selected solids.
    if (!sheetSolid) {
      const inferred = tools.find((t) => resolveSheetThickness(t, metadataManager));
      if (inferred) {
        sheetSolid = inferred;
        tools = tools.filter((t) => t !== inferred);
      }
    }

    if (!sheetSolid) {
      sheetSolid = findFirstSheetMetalSolid(scene, metadataManager);
    }

    if (!sheetSolid) throw new Error("Sheet Metal Cutout requires a valid sheet metal solid selection.");
    if (!tools.length) return { added: [], removed: [] };

    const toolUnion = unionSolids(tools);
    if (!toolUnion) throw new Error("Failed to combine cutting tools for Sheet Metal Cutout.");

    const intersection = safeIntersect(sheetSolid, toolUnion);
    if (!intersection) throw new Error("Sheet Metal Cutout could not compute the sheet/tool intersection.");

    const sheetThickness = resolveSheetThickness(sheetSolid, partHistory?.metadataManager);
    if (!(sheetThickness > 0)) throw new Error("Sheet Metal Cutout could not resolve sheet metal thickness.");

    const footprintFaces = collectSheetFaces(intersection);
    const targetType = footprintFaces.A.length ? SHEET_METAL_FACE_TYPES.A
      : (footprintFaces.B.length ? SHEET_METAL_FACE_TYPES.B : null);
    if (!targetType) {
      throw new Error("Sheet Metal Cutout could not find sheet metal A/B faces in the intersection. Ensure the target solid has sheet-metal metadata.");
    }

    const basisFaces = targetType === SHEET_METAL_FACE_TYPES.A ? footprintFaces.A : footprintFaces.B;
    const prisms = [];
    for (const faceInfo of basisFaces) {
      const loops = buildBoundaryLoops(faceInfo.triangles, intersection?.matrixWorld || sheetSolid.matrixWorld);
      if (!loops.length) continue;
      const profiles = buildFaceProfiles(loops, faceInfo.normal, faceInfo.origin, this.inputParams?.featureID);
      for (const profile of profiles) {
        const dir = faceInfo.normal.clone().normalize().multiplyScalar(
          targetType === SHEET_METAL_FACE_TYPES.B ? sheetThickness : -sheetThickness
        );
        const travel = Math.max(sheetThickness, 1e-6);
        const prism = new BREP.ExtrudeSolid({
          face: profile,
          dir,
          distance: travel,
          distanceBack: travel,
          name: this.inputParams?.featureID || "SM_CUTOUT_PRISM",
          sideFaceName: `${this.inputParams?.featureID || "SM_CUTOUT_PRISM"}_SW`,
        });
        tagThicknessFaces(prism);
        prisms.push(prism);
      }
    }

    if (!prisms.length) throw new Error("Sheet Metal Cutout could not derive a planar footprint from the intersection.");

    let cutPrism = prisms[0];
    for (let i = 1; i < prisms.length; i++) {
      try { cutPrism = cutPrism.union(prisms[i]); } catch { cutPrism = prisms[i]; }
    }
    if (this.inputParams?.featureID && cutPrism) {
      try { cutPrism.name = this.inputParams.featureID; } catch { /* best effort */ }
    }

    let added = [];
    let removed = [];
    try {
      const cut = sheetSolid.subtract(cutPrism);
      cut.visualize?.();
      try { cut.name = this.inputParams?.featureID || sheetSolid.name || cut.name; } catch { /* ignore */ }
      added = [cut];
      removed = [sheetSolid, cutPrism, ...tools].filter(Boolean);
    } catch (directErr) {
      console.warn("[SheetMetalCutout] Direct subtract failed, falling back to applyBooleanOperation", directErr);
      const effects = await BREP.applyBooleanOperation(
        partHistory || {},
        cutPrism,
        { operation: "SUBTRACT", targets: [sheetSolid] },
        this.inputParams?.featureID,
      );
      removed = [...(effects?.removed || []), ...tools, sheetSolid].filter(Boolean);
      added = effects?.added || [];
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

    this.persistentData = {
      sheetName: sheetSolid?.name || null,
      toolCount: tools.length,
      sheetThickness,
      footprintFaceType: targetType,
    };

    return { added, removed };
  }
}

function resolveSolidRef(ref, scene) {
  if (!ref) return null;
  if (typeof ref === "object" && ref.type === "SOLID") return ref;
  if (typeof ref === "object" && ref.type === "FACE") {
    return findAncestorSolid(ref);
  }
  if (typeof ref === "string" && scene?.getObjectByName) {
    const obj = scene.getObjectByName(ref);
    if (obj && obj.type === "SOLID") return obj;
    if (obj && obj.type === "FACE") return findAncestorSolid(obj);
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

async function resolveBooleanTools(booleanParam, scene) {
  const opRaw = booleanParam?.operation || "SUBTRACT";
  const op = String(opRaw || "NONE").toUpperCase();
  const refs = Array.isArray(booleanParam?.targets) ? booleanParam.targets : [];
  const tools = [];
  const seen = new Set();
  for (const ref of refs) {
    let obj = ref;
    if (typeof obj === "string" && scene?.getObjectByName) {
      obj = await scene.getObjectByName(obj);
    }
    if (!obj || obj.type !== "SOLID") continue;
    const key = obj.uuid || obj.id || obj.name || `${tools.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push(obj);
  }
  return { tools, op };
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
    return null;
  }
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

function buildFaceProfiles(loopPoints, normal, originHint, featureID) {
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
