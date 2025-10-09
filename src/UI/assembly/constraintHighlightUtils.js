export function applyHighlightMaterial(object, color, store, skipSets = [store]) {
  if (!object || !color || !store) return false;

  const guardSets = Array.isArray(skipSets)
    ? skipSets.filter((m) => m && typeof m.has === 'function')
    : [];
  if (guardSets.length === 0) guardSets.push(store);

  const targets = [];
  object.traverse?.((child) => {
    if (!child || !child.isObject3D) return;
    if (child.material && child.material.color) targets.push(child);
  });
  if (targets.length === 0 && object.material && object.material.color) {
    targets.push(object);
  }

  let modified = false;
  for (const target of targets) {
    const key = target.uuid;
    if (guardSets.some((map) => map.has(key))) continue;

    const originalMaterial = target.material;
    let replaced = false;
    let highlightMaterial = originalMaterial;
    if (originalMaterial && typeof originalMaterial.clone === 'function') {
      try {
        const clone = originalMaterial.clone();
        if (clone) {
          highlightMaterial = clone;
          replaced = clone !== originalMaterial;
        }
      } catch { /* ignore */ }
    }

    const previousColor = (!replaced && highlightMaterial?.color && highlightMaterial.color.clone)
      ? highlightMaterial.color.clone()
      : null;

    try { highlightMaterial?.color?.set(color); } catch { /* ignore */ }

    if (replaced) {
      target.material = highlightMaterial;
    }

    store.set(key, {
      object: target,
      replaced,
      originalMaterial,
      previousColor,
    });
    modified = true;
  }

  return modified;
}

export function restoreHighlightRecords(map) {
  if (!map || typeof map.size !== 'number' || map.size === 0) return;
  for (const record of map.values()) {
    try {
      if (record.replaced && record.originalMaterial) {
        record.object.material = record.originalMaterial;
      } else if (record.previousColor && record.object.material?.color) {
        record.object.material.color.copy(record.previousColor);
      }
    } catch { /* ignore */ }
  }
  map.clear();
}
