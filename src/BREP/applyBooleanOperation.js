// applyBooleanOperation.js
// Helper to apply a boolean operation between a newly created base solid and
// a list of scene solids referenced by name via the boolean param widget.
//
// Usage:
//   const out = await applyBooleanOperation(partHistory, baseSolid, this.inputParams.boolean, this.inputParams.featureID);
//   return out; // array of solids to add to scene

export async function applyBooleanOperation(partHistory, baseSolid, booleanParam, featureID) {
  try {
    if (!booleanParam || typeof booleanParam !== 'object') return [baseSolid];
    const op = String(booleanParam.opperation || 'NONE').toUpperCase();
    const names = Array.isArray(booleanParam.targets) ? booleanParam.targets.filter(Boolean) : [];

    if (op === 'NONE' || names.length === 0) {
      return [baseSolid];
    }

    const scene = partHistory && partHistory.scene ? partHistory.scene : null;
    if (!scene) return [baseSolid];

    // Collect unique tool solids by name
    const seen = new Set();
    const tools = [];
    for (const n of names) {
      const key = String(n);
      if (seen.has(key)) continue;
      seen.add(key);
      const obj = await scene.getObjectByName(key);
      if (obj) tools.push(obj);
    }

    if (tools.length === 0) return [baseSolid];

    // Apply selected boolean
    if (op === 'SUBTRACT') {
      // Inverted semantics for subtract: subtract the new baseSolid (tool)
      // FROM each selected target solid. Return all resulting target solids.
      const results = [];
      let idx = 0;
      for (const target of tools) {
        const out = target.subtract(baseSolid);
        out.visualize();
        // Remove the original target; also remove the tool (base) after processing
        target.remove = true;
        try { out.name = (featureID ? `${featureID}_${++idx}` : out.name || 'RESULT'); } catch (_) { }
        results.push(out);
      }
      // Remove base tool solid as it served only as cutter
      try { baseSolid.remove = true; } catch (_) { }
      return results.length ? results : [baseSolid];
    }

    // UNION / INTERSECT keep original semantics: fold tools into the new baseSolid
    let result = baseSolid;
    for (const tool of tools) {
      if (op === 'UNION') result = result.union(tool);
      else if (op === 'INTERSECT') result = result.intersect(tool);
      else {
        // Unknown op → pass through
        return [baseSolid];
      }
    }
    result.visualize();
    // Remove tool bodies (selected solids) after operation; keep the new result
    for (const t of tools) t.remove = true;
    try { result.name = featureID || result.name || 'RESULT'; } catch (_) { }
    return [result];
  } catch (err) {
    // On failure, pass through original to avoid breaking the pipeline
    console.warn('[applyBooleanOperation] failed:', err?.message || err);
    return [baseSolid];
  }
}
