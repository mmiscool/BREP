// applyBooleanOperation.js
// Helper to apply a boolean operation between a newly created base solid and
// a list of scene solids referenced by name via the boolean param widget.
//
// Usage:
//   const out = await applyBooleanOperation(partHistory, baseSolid, this.inputParams.boolean, this.inputParams.featureID);
//   return out; // array of solids to add to scene

export async function applyBooleanOperation(partHistory, baseSolid, booleanParam, featureID) {
  try {
    if (!booleanParam || typeof booleanParam !== 'object') return { added: [baseSolid], removed: [] };
    // Back-compat: accept both `operation` and misspelled `opperation`
    const opRaw = (booleanParam.operation != null) ? booleanParam.operation : booleanParam.opperation;
    const op = String(opRaw || 'NONE').toUpperCase();
    const tgt = Array.isArray(booleanParam.targets) ? booleanParam.targets.filter(Boolean) : [];

    if (op === 'NONE' || tgt.length === 0) {
      return { added: [baseSolid], removed: [] };
    }

    const scene = partHistory && partHistory.scene ? partHistory.scene : null;
    if (!scene) return { added: [baseSolid], removed: [] };

    // Collect unique tool solids: support either objects or names for back-compat
    const seen = new Set();
    const tools = [];
    for (const entry of tgt) {
      if (!entry) continue;
      if (typeof entry === 'object') {
        const obj = entry;
        const key = obj.uuid || obj.id || obj.name || `${Date.now()}_${tools.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tools.push(obj);
      } else {
        const key = String(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        const obj = await scene.getObjectByName(key);
        if (obj) tools.push(obj);
      }
    }

    if (tools.length === 0) return { added: [baseSolid], removed: [] };

    // Bias distance (nudge magnitude) from UI; fallback to 0.1 if missing
    const biasDistanceRaw = (booleanParam && typeof booleanParam === 'object') ? (booleanParam.biasDistance ?? booleanParam.bias ?? booleanParam.epsilon) : undefined;
    const biasDistance = Number.isFinite(Number(biasDistanceRaw)) ? Number(biasDistanceRaw) : 0.00001;

    // Apply selected boolean
    if (op === 'SUBTRACT') {
      // Inverted semantics for subtract: subtract the new baseSolid (tool)
      // FROM each selected target solid.
      // Robustness tweak: if tool points are near the target surface,
      // nudge the TOOL slightly to the OUTSIDE to avoid exact coplanarity
      // and sliver residue.
      const results = [];
      let idx = 0;
      for (const target of tools) {
        // Clone and bias the tool against this target only where close
        const toolBiased = baseSolid.clone();
        try { toolBiased.nudgeCoplanarAgainst(target, { mode: 'OUTSIDE', epsilon: biasDistance*10 }); } catch (_) {}

        const out = target.subtract(toolBiased);
        out.visualize();
        try { out.name = (featureID ? `${featureID}_${++idx}` : out.name || 'RESULT'); } catch (_) { }
        results.push(out);
      }
      // In SUBTRACT: removed = [all targets, baseSolid]
      const removed = [...tools];
      if (baseSolid) removed.push(baseSolid);
      return { added: results.length ? results : [baseSolid], removed };
    }

    // UNION / INTERSECT keep original semantics: fold tools into the new baseSolid
    let result = baseSolid;
    for (const tool of tools) {
      // For UNION, bias the target/result toward OUTSIDE so nearly-coplanar
      // points move into the solid and guarantee positive overlap.
      if (op === 'UNION') {
        const resultBiased = result.clone();
        try { resultBiased.nudgeCoplanarAgainst(tool, { mode: 'OUTSIDE', epsilon: biasDistance }); } catch (_) {}
        result = resultBiased.union(tool);
      } else if (op === 'INTERSECT') {
        // Keep INTERSECT unchanged unless requested otherwise
        result = result.intersect(tool);
      } else {
        // Unknown op → pass through
        return { added: [baseSolid], removed: [] };
      }
    }
    result.visualize();
    try { result.name = featureID || result.name || 'RESULT'; } catch (_) { }
    // UNION/INTERSECT: removed tools; base stays
    return { added: [result], removed: tools.slice() };
  } catch (err) {
    // On failure, pass through original to avoid breaking the pipeline
    console.warn('[applyBooleanOperation] failed:', err?.message || err);
    return { added: [baseSolid], removed: [] };
  }
}
