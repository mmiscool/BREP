export function resolveProfileFace(profileRef, partHistory) {
  if (!profileRef) return null;
  const selection = Array.isArray(profileRef) ? (profileRef[0] || null) : profileRef;
  let obj = selection;
  if ((!obj || typeof obj !== "object") && selection && partHistory?.scene?.getObjectByName) {
    obj = partHistory.scene.getObjectByName(selection) || null;
  }
  if (!obj) return null;

  if (obj.type === "FACE") return obj;
  if (obj.type === "SKETCH" && Array.isArray(obj.children)) {
    const faceChild = obj.children.find((ch) => ch?.type === "FACE");
    if (faceChild) return faceChild;
    return obj.children.find((ch) => ch?.userData?.faceName) || null;
  }
  return obj;
}

export function collectSketchParents(face) {
  const targets = [];
  if (face && face.type === "FACE" && face.parent && face.parent.type === "SKETCH") {
    targets.push(face.parent);
  }
  return targets;
}
