export const SHEET_METAL_FACE_TYPES = {
  A: "A",
  B: "B",
  THICKNESS: "THICKNESS",
};

export function setSheetMetalFaceTypeMetadata(solid, faceNames, type) {
  if (!solid || !faceNames || !type) return;
  const list = Array.isArray(faceNames) ? faceNames : [faceNames];
  for (const name of list) {
    if (!name || typeof solid.setFaceMetadata !== "function") continue;
    const existing = typeof solid.getFaceMetadata === "function"
      ? (solid.getFaceMetadata(name) || {})
      : {};
    solid.setFaceMetadata(name, {
      ...existing,
      sheetMetalFaceType: type,
    });
  }
}

export function resolveSheetMetalFaceType(faceObj) {
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

export function propagateSheetMetalFaceTypesToEdges(targets) {
  const solids = [];
  const push = (item) => {
    if (!item) return;
    if (Array.isArray(item)) {
      for (const it of item) push(it);
    } else if (item.type === "SOLID") {
      solids.push(item);
    }
  };
  push(targets);
  for (const solid of solids) {
    let faces = [];
    try {
      faces = typeof solid.getFaces === "function" ? solid.getFaces() : [];
    } catch { faces = []; }
    if (!Array.isArray(faces) || !faces.length) continue;
    const edgeMap = new Map(); // edge -> {faces:Set(types)}
    const applied = [];
    const missing = [];

    for (const face of faces) {
      const type = resolveSheetMetalFaceType(face);
      if (type !== SHEET_METAL_FACE_TYPES.A && type !== SHEET_METAL_FACE_TYPES.B) continue;
      const edges = Array.isArray(face.edges) ? face.edges : [];
      for (const edge of edges) {
        if (!edge) continue;
        let entry = edgeMap.get(edge);
        if (!entry) { entry = new Set(); edgeMap.set(edge, entry); }
        entry.add(type);
      }
    }

    for (const [edge, types] of edgeMap.entries()) {
      if (!edge) continue;
      const hasA = types.has(SHEET_METAL_FACE_TYPES.A);
      const hasB = types.has(SHEET_METAL_FACE_TYPES.B);
      let finalType = null;
      if (hasA) finalType = SHEET_METAL_FACE_TYPES.A;
      else if (hasB) finalType = SHEET_METAL_FACE_TYPES.B;
      edge.userData = edge.userData || {};
      edge.userData.sheetMetalEdgeType = finalType;
      const name = typeof edge.name === "string" ? edge.name : null;
      const parent = edge.parentSolid || findAncestorSolid(edge) || solid;
      const faceNames = Array.isArray(edge.faces)
        ? edge.faces.map((f) => f?.userData?.faceName || f?.name).filter(Boolean)
        : [];
      const pairName = faceNames.length === 2
        ? faceNames.slice().sort().join("|")
        : null;
      if (finalType && name && parent && typeof parent.setEdgeMetadata === "function") {
        parent.setEdgeMetadata(name, { ...(parent.getEdgeMetadata(name) || {}), sheetMetalEdgeType: finalType });
      }
      if (finalType && pairName && parent && typeof parent.setEdgeMetadata === "function") {
        parent.setEdgeMetadata(pairName, { ...(parent.getEdgeMetadata(pairName) || {}), sheetMetalEdgeType: finalType });
      }
      applied.push({ edgeName: name || "UNNAMED", type: finalType || "NONE" });
      if (!finalType) {
        console.warn("[SheetMetal] Edge with no sheetMetalEdgeType after propagation", { edge: name || "UNNAMED" });
      }
    }

    for (const face of faces) {
      const type = resolveSheetMetalFaceType(face);
      if (type !== SHEET_METAL_FACE_TYPES.A && type !== SHEET_METAL_FACE_TYPES.B) continue;
      const edges = Array.isArray(face.edges) ? face.edges : [];
      for (const edge of edges) {
        const et = edge?.userData?.sheetMetalEdgeType;
        if (et !== type) {
          edge.userData = { ...(edge.userData || {}), sheetMetalEdgeType: type };
          const name = typeof edge?.name === "string" ? edge.name : null;
          const parent = edge?.parentSolid || findAncestorSolid(edge) || solid;
          const faceNames = Array.isArray(edge?.faces)
            ? edge.faces.map((f) => f?.userData?.faceName || f?.name).filter(Boolean)
            : [];
          const pairName = faceNames.length === 2
            ? faceNames.slice().sort().join("|")
            : null;
          if (name && parent && typeof parent.setEdgeMetadata === "function") {
            parent.setEdgeMetadata(name, { ...(parent.getEdgeMetadata(name) || {}), sheetMetalEdgeType: type });
          }
          if (pairName && parent && typeof parent.setEdgeMetadata === "function") {
            parent.setEdgeMetadata(pairName, { ...(parent.getEdgeMetadata(pairName) || {}), sheetMetalEdgeType: type });
          }
          missing.push({ edgeName: name || "UNNAMED", expected: type, actual: et });
        }
      }
    }

    console.log("[SheetMetal] Edge type propagation summary", {
      solid: solid?.name || solid,
      appliedCount: applied.length,
      missingCount: missing.length,
    });
    if (missing.length) {
      console.warn("[SheetMetal] Missing edge sheet-metal types after propagation (corrected)", missing);
    }
  }
}

function findAncestorSolid(obj) {
  let current = obj;
  while (current) {
    if (current.type === "SOLID") return current;
    current = current.parent;
  }
  return null;
}
