// Solid.chamfer implementation: wraps ChamferSolid builder and applies booleans.

/**
 * Apply chamfers to this Solid and return a new Solid with the result.
 *
 * @param {Object} opts
 * @param {number} opts.distance Required chamfer distance (> 0)
 * @param {string[]} [opts.edgeNames] Optional edge names to chamfer
 * @param {any[]} [opts.edges] Optional pre-resolved Edge objects (must belong to this Solid)
 * @param {string} [opts.direction] 'INSET' | 'OUTSET' (default 'INSET')
 * @param {number} [opts.inflate] Grow/shrink chamfer tool (default 0.1; negated for OUTSET)
 * @param {boolean} [opts.debug] Enable debug helpers on ChamferSolid
 * @param {string} [opts.featureID] For naming of intermediates and result
 * @returns {import('../BetterSolid.js').Solid}
 */
export async function chamfer(opts = {}) {
  const { ChamferSolid } = await import("../chamfer.js");
  const distance = Number(opts.distance);
  if (!Number.isFinite(distance) || distance <= 0) {
    throw new Error(`Solid.chamfer: distance must be > 0, got ${opts.distance}`);
  }
  const dir = String(opts.direction || 'INSET').toUpperCase();
  const inflateRaw = Number.isFinite(opts.inflate) ? Number(opts.inflate) : 0.1;
  const inflateForSolid = (dir === 'OUTSET') ? -inflateRaw : inflateRaw;
  const debug = !!opts.debug;
  const featureID = opts.featureID || 'CHAMFER';
  console.log('[Solid.chamfer] Begin', {
    featureID,
    solid: this?.name,
    distance,
    direction: dir,
    inflate: inflateRaw,
    inflateApplied: inflateForSolid,
    debug,
    requestedEdgeNames: Array.isArray(opts.edgeNames) ? opts.edgeNames : [],
    providedEdgeCount: Array.isArray(opts.edges) ? opts.edges.length : 0,
  });

  // Resolve edges from names and/or provided objects
  const edgeObjs = [];
  const wantNames = Array.isArray(opts.edgeNames) ? Array.from(new Set(opts.edgeNames.map(String))) : [];
  if (wantNames.length) {
    for (const ch of this.children || []) {
      if (ch && ch.type === 'EDGE' && wantNames.includes(ch.name)) {
        if (ch.parentSolid === this || ch.parent === this) edgeObjs.push(ch);
      }
    }
  }
  if (Array.isArray(opts.edges)) {
    for (const e of opts.edges) {
      if (e && (e.parentSolid === this || e.parent === this)) edgeObjs.push(e);
    }
  }
  // Dedup
  const unique = [];
  const seen = new Set();
  for (const e of edgeObjs) { if (e && !seen.has(e)) { seen.add(e); unique.push(e); } }
  if (unique.length === 0) {
    console.warn('[Solid.chamfer] No edges resolved on target solid; returning clone.', { featureID, solid: this?.name });
    const c = this.clone();
    try { c.name = this.name; } catch { }
    return c;
  }

  const chamferSolids = [];
  let idx = 0;
  for (const e of unique) {
    const name = `${featureID}_CHAMFER_${idx++}`;
    try {
      const chamfer = new ChamferSolid({
        edgeToChamfer: e,
        distance,
        direction: dir,
        inflate: inflateForSolid,
        debug,
        sampleCount: opts.sampleCount,
        snapSeamToEdge: opts.snapSeamToEdge,
        sideStripSubdiv: opts.sideStripSubdiv,
        seamInsetScale: opts.seamInsetScale,
        flipSide: opts.flipSide,
        debugStride: opts.debugStride,
      });
      try { chamfer.name = name; } catch { }
      chamferSolids.push(chamfer);
    } catch (err) {
      console.warn('[Solid.chamfer] Failed to build chamfer solid for edge', { edge: e?.name, error: err?.message || err });
    }
  }

  if (chamferSolids.length === 0) {
    console.error('[Solid.chamfer] All chamfer solids failed; returning clone.', { featureID, edgeCount: unique.length });
    const c = this.clone();
    try { c.name = this.name; } catch { }
    return c;
  }
  console.log('[Solid.chamfer] Built chamfer solids for edges', chamferSolids.length);

  // Apply to base solid (union for OUTSET, subtract for INSET)
  let result = this;
  for (const chamferSolid of chamferSolids) {
    const beforeTri = Array.isArray(result?._triVerts) ? (result._triVerts.length / 3) : 0;
    result = (dir === 'OUTSET') ? result.union(chamferSolid) : result.subtract(chamferSolid);
    const afterTri = Array.isArray(result?._triVerts) ? (result._triVerts.length / 3) : 0;
    console.log('[Solid.chamfer] Applied chamfer boolean', {
      featureID,
      operation: (dir === 'OUTSET') ? 'union' : 'subtract',
      beforeTriangles: beforeTri,
      afterTriangles: afterTri,
    });
    try { result.name = this.name; } catch { }
  }

  // Expose chamfer tool solids for debug/inspection (e.g., ChamferFeature)
  try { result.__debugChamferSolids = chamferSolids; } catch { }

  const finalTriCount = Array.isArray(result?._triVerts) ? (result._triVerts.length / 3) : 0;
  const finalVertCount = Array.isArray(result?._vertProperties) ? (result._vertProperties.length / 3) : 0;
  if (!result || finalTriCount === 0 || finalVertCount === 0) {
    console.error('[Solid.chamfer] Chamfer result is empty or missing geometry.', {
      featureID,
      finalTriCount,
      finalVertCount,
      edgeCount: unique.length,
      direction: dir,
      inflate: inflateRaw,
    });
  } else {
    console.log('[Solid.chamfer] Completed', { featureID, triangles: finalTriCount, vertices: finalVertCount });
  }

  return result;
}
