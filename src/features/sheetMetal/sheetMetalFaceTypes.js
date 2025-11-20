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
