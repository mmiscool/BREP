// Solid.fillet implementation: consolidates fillet logic so features call this API.
// Usage: solid.fillet({ radius, edgeNames, featureID, direction, inflate, resolution, debug, showTangentOverlays })

// Heuristic threshold for island cleanup after fillet subtraction.
// Uses current mesh size and fillet solid complexity, clamped to stay conservative.
function estimateIslandThreshold(result, filletSolid) {
  const triCount = Array.isArray(result?._triVerts) ? (result._triVerts.length / 3) : 0;
  const filletTris = Array.isArray(filletSolid?._triVerts) ? (filletSolid._triVerts.length / 3) : 0;
  const triBased = Math.round(triCount * 0.015);     // ~1.5% of current mesh
  const filletBased = Math.round(filletTris * 0.25); // quarter of fillet triangles
  const raw = Math.max(30, triBased, filletBased);
  return Math.min(5000, raw);
}

// Threshold for collapsing tiny end caps into the round face.
const END_CAP_AREA_RATIO_THRESHOLD = 0.05;

function computeFaceAreaByName(solid, faceName) {
  if (!solid || typeof solid.getFace !== 'function' || !faceName) return 0;
  try {
    const tris = solid.getFace(faceName);
    if (!Array.isArray(tris) || tris.length === 0) return 0;
    let area = 0;
    for (const tri of tris) {
      const p1 = tri?.p1;
      const p2 = tri?.p2;
      const p3 = tri?.p3;
      if (!Array.isArray(p1) || !Array.isArray(p2) || !Array.isArray(p3)) continue;
      const ax = Number(p1[0]) || 0, ay = Number(p1[1]) || 0, az = Number(p1[2]) || 0;
      const bx = Number(p2[0]) || 0, by = Number(p2[1]) || 0, bz = Number(p2[2]) || 0;
      const cx = Number(p3[0]) || 0, cy = Number(p3[1]) || 0, cz = Number(p3[2]) || 0;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      area += 0.5 * Math.hypot(nx, ny, nz);
    }
    return area;
  } catch {
    return 0;
  }
}

function buildFaceAreaCache(solid) {
  const cache = new Map();
  return {
    get(name) {
      if (!name) return 0;
      if (cache.has(name)) return cache.get(name);
      const area = computeFaceAreaByName(solid, name);
      cache.set(name, area);
      return area;
    }
  };
}

function findNeighborRoundFace(resultSolid, capName, areaCache, boundaryCache) {
  if (!resultSolid || !capName) return null;
  const boundaries = boundaryCache.current || resultSolid.getBoundaryEdgePolylines() || [];
  boundaryCache.current = boundaries;
  let best = null;
  let bestArea = 0;
  for (const poly of boundaries) {
    const a = poly?.faceA;
    const b = poly?.faceB;
    if (a !== capName && b !== capName) continue;
    const other = (a === capName) ? b : a;
    if (!other || typeof other !== 'string') continue;
    if (!other.includes('TUBE_Outer')) continue;
    const aVal = areaCache.get(other);
    if (aVal > bestArea) {
      bestArea = aVal;
      best = other;
    }
  }
  return best;
}

function findLargestRoundFace(resultSolid, areaCache) {
  if (!resultSolid || typeof resultSolid.getFaceNames !== 'function') return null;
  let best = null;
  let bestArea = 0;
  for (const name of resultSolid.getFaceNames()) {
    if (typeof name !== 'string' || !name.includes('TUBE_Outer')) continue;
    const a = areaCache.get(name);
    if (a > bestArea) {
      bestArea = a;
      best = name;
    }
  }
  return best;
}

function getFilletMergeCandidateNames(filletSolid) {
  if (!filletSolid || typeof filletSolid.getFaceNames !== 'function') return [];
  const names = filletSolid.getFaceNames();
  const out = [];
  for (const n of names) {
    if (typeof n !== 'string') continue;
    const meta = (typeof filletSolid.getFaceMetadata === 'function') ? filletSolid.getFaceMetadata(n) : {};
    if (meta && (meta.filletRoundFace || meta.filletSourceArea || meta.filletEndCap)) {
      out.push(n);
      continue;
    }
    if (n.includes('_END_CAP') || n.includes('_CapStart') || n.includes('_CapEnd') || n.includes('_WEDGE_A') || n.includes('_WEDGE_B')) {
      out.push(n);
    }
  }
  return out;
}

function guessRoundFaceName(filletSolid, filletName) {
  const faces = (filletSolid && typeof filletSolid.getFaceNames === 'function')
    ? filletSolid.getFaceNames()
    : [];
  const explicitOuter = faces.find(n => typeof n === 'string' && n.includes('_TUBE_Outer'));
  if (explicitOuter) return explicitOuter;
  if (filletName) {
    const guess = `${filletName}_TUBE_Outer`;
    if (faces.includes(guess)) return guess;
    return guess;
  }
  return null;
}

function mergeFaceIntoTarget(resultSolid, sourceFaceName, targetFaceName) {
  if (!resultSolid || !sourceFaceName || !targetFaceName) return false;
  const faceToId = resultSolid._faceNameToID instanceof Map ? resultSolid._faceNameToID : new Map();
  const idToFace = resultSolid._idToFaceName instanceof Map ? resultSolid._idToFaceName : new Map();
  const sourceID = faceToId.get(sourceFaceName);
  if (sourceID === undefined) return false;
  const targetID = faceToId.get(targetFaceName);

  // If target doesn't exist yet, just relabel the source.
  if (targetID === undefined) {
    idToFace.set(sourceID, targetFaceName);
    faceToId.delete(sourceFaceName);
    faceToId.set(targetFaceName, sourceID);
    if (resultSolid._faceMetadata instanceof Map) {
      const meta = resultSolid._faceMetadata;
      if (!meta.has(targetFaceName) && meta.has(sourceFaceName)) {
        meta.set(targetFaceName, meta.get(sourceFaceName));
      }
      meta.delete(sourceFaceName);
    }
    resultSolid._idToFaceName = idToFace;
    resultSolid._faceNameToID = faceToId;
    resultSolid._faceIndex = null;
    resultSolid._dirty = true;
    return true;
  }

  if (targetID === sourceID) return false;

  const triIDs = Array.isArray(resultSolid._triIDs) ? resultSolid._triIDs : null;
  let replaced = 0;
  if (triIDs) {
    for (let i = 0; i < triIDs.length; i++) {
      if ((triIDs[i] >>> 0) === sourceID) {
        triIDs[i] = targetID;
        replaced++;
      }
    }
    resultSolid._triIDs = triIDs;
  }

  idToFace.delete(sourceID);
  faceToId.delete(sourceFaceName);
  if (resultSolid._faceMetadata instanceof Map) {
    const meta = resultSolid._faceMetadata;
    if (!meta.has(targetFaceName) && meta.has(sourceFaceName)) {
      meta.set(targetFaceName, meta.get(sourceFaceName));
    }
    meta.delete(sourceFaceName);
  }
  resultSolid._idToFaceName = idToFace;
  resultSolid._faceNameToID = faceToId;
  resultSolid._faceIndex = null;
  resultSolid._dirty = true;
  return replaced > 0;
}

function mergeTinyFacesIntoRoundFace(resultSolid, filletSolid, candidateNames, roundFaceName, featureID, boundaryCache, resultAreaCache) {
  if (!resultSolid || !filletSolid || !Array.isArray(candidateNames) || candidateNames.length === 0) return;
  const areaCacheResult = resultAreaCache || buildFaceAreaCache(resultSolid);
  const areaCacheFillet = buildFaceAreaCache(filletSolid);

  for (const capName of candidateNames) {
    const capMeta = (typeof resultSolid.getFaceMetadata === 'function') ? resultSolid.getFaceMetadata(capName) : {};
    const referenceArea = Number(capMeta?.filletSourceArea) > 0 ? Number(capMeta.filletSourceArea) : areaCacheFillet.get(capName);
    if (!(referenceArea > 0)) continue;
    const finalArea = areaCacheResult.get(capName);
    if (!(finalArea > 0)) continue;
    if (finalArea < referenceArea * END_CAP_AREA_RATIO_THRESHOLD) {
      let targetFace = capMeta?.filletRoundFace || roundFaceName;
      const neighborRound = findNeighborRoundFace(resultSolid, capName, areaCacheResult, boundaryCache);
      if (neighborRound) targetFace = neighborRound;
      if (!targetFace) targetFace = findLargestRoundFace(resultSolid, areaCacheResult);
      if (!targetFace) continue;
      const merged = mergeFaceIntoTarget(resultSolid, capName, targetFace);
      if (merged) {
        console.log('[Solid.fillet] Merged tiny fillet face into round face', {
          featureID,
          capName,
          roundFaceName: targetFace,
          ratio: finalArea / referenceArea,
        });
      }
    }
  }
}

function mergeSideFacesIntoRoundFace(resultSolid, filletName, roundFaceName) {
  if (!resultSolid || !filletName || !roundFaceName) return;
  const sideA = `${filletName}_SIDE_A`;
  const sideB = `${filletName}_SIDE_B`;
  const surfaceCA = `${filletName}_SURFACE_CA`;
  const surfaceCB = `${filletName}_SURFACE_CB`;
  mergeFaceIntoTarget(resultSolid, sideA, roundFaceName);
  mergeFaceIntoTarget(resultSolid, sideB, roundFaceName);
  mergeFaceIntoTarget(resultSolid, surfaceCA, roundFaceName);
  mergeFaceIntoTarget(resultSolid, surfaceCB, roundFaceName);
}

/**
 * Apply fillets to this Solid and return a new Solid with the result.
 * Accepts either `edgeNames` (preferred) or explicit `edges` objects.
 *
 * @param {Object} opts
 * @param {number} opts.radius Required fillet radius (> 0)
 * @param {string[]} [opts.edgeNames] Optional edge names to fillet (resolved from this Solid's children)
 * @param {any[]} [opts.edges] Optional pre-resolved Edge objects (must belong to this Solid)
 * @param {'INSET'|'OUTSET'|string} [opts.direction='INSET'] Boolean behavior (subtract vs union)
 * @param {number} [opts.inflate=0.1] Inflation for cutting tube
 * @param {number} [opts.resolution=32] Tube resolution (segments around circumference)
 * @param {boolean} [opts.debug=false] Enable debug visuals in fillet builder
 * @param {boolean} [opts.showTangentOverlays=false] Show pre-inflate tangent overlays on the fillet tube
 * @param {string} [opts.featureID='FILLET'] For naming of intermediates and result
 * @returns {import('../BetterSolid.js').Solid}
 */
export async function fillet(opts = {}) {
  const { filletSolid } = await import("../fillets/fillet.js");
  const radius = Number(opts.radius);
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`Solid.fillet: radius must be > 0, got ${opts.radius}`);
  }
  const dir = String(opts.direction || 'INSET').toUpperCase();
  const inflate = Number.isFinite(opts.inflate) ? Number(opts.inflate) : 0.1;
  const debug = !!opts.debug;
  const resolutionRaw = Number(opts.resolution);
  const resolution = (Number.isFinite(resolutionRaw) && resolutionRaw > 0)
    ? Math.max(8, Math.floor(resolutionRaw))
    : 32;
  const showTangentOverlays = !!opts.showTangentOverlays;
  const featureID = opts.featureID || 'FILLET';
  console.log('[Solid.fillet] Begin', {
    featureID,
    solid: this?.name,
    radius,
    direction: dir,
    inflate,
    resolution,
    debug,
    showTangentOverlays,
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
    console.warn('[Solid.fillet] No edges resolved on target solid; returning clone.', { featureID, solid: this?.name });
    // Nothing to do - return an unchanged clone so caller can replace scene node safely
    const c = this.clone();
    try { c.name = this.name; } catch { }
    return c;
  }

  // Build fillet solids per edge using existing core implementation
  const filletEntries = [];
  let idx = 0;
  const debugAdded = [];
  for (const e of unique) {
    const name = `${featureID}_FILLET_${idx++}`;
    const res = filletSolid({ edgeToFillet: e, radius, sideMode: dir, inflate, resolution, debug, name, showTangentOverlays }) || {};

    // Handle debug solids even on failure
    if (debug || !res.finalSolid) {
      try { if (res.tube) debugAdded.push(res.tube); } catch { }
      try { if (res.wedge) debugAdded.push(res.wedge); } catch { }

      // If there was an error, log it and add debug info
      if (res.error) {
        console.warn(`Fillet failed for edge ${e?.name || idx}: ${res.error}`);
      }
    }
    if (!res.finalSolid) {
      console.warn('[Solid.fillet] Fillet builder returned no finalSolid.', {
        featureID,
        edge: e?.name,
        error: res.error,
        hasTube: !!res.tube,
        hasWedge: !!res.wedge,
      });
      continue;
    }

    const mergeCandidates = getFilletMergeCandidateNames(res.finalSolid);
    const roundFaceName = guessRoundFaceName(res.finalSolid, name);
    filletEntries.push({ filletSolid: res.finalSolid, filletName: name, mergeCandidates, roundFaceName });
    if (debug) {
      try { if (res.tube) debugAdded.push(res.tube); } catch { }
      try { if (res.wedge) debugAdded.push(res.wedge); } catch { }
    }
  }
  if (filletEntries.length === 0) {
    console.error('[Solid.fillet] All edge fillets failed; returning clone.', { featureID, edgeCount: unique.length });
    const c = this.clone();
    try { c.name = this.name; } catch { }
    return c;
  }
  console.log('[Solid.fillet] Built fillet solids for edges', filletEntries.length);

  // Apply to base solid (union for OUTSET, subtract for INSET)
  let result = this;
  for (const entry of filletEntries) {
    const { filletSolid } = entry;
    const beforeTri = Array.isArray(result?._triVerts) ? (result._triVerts.length / 3) : 0;
    const operation = (dir === 'OUTSET') ? 'union' : 'subtract';
    result = (operation === 'union') ? result.union(filletSolid) : result.subtract(filletSolid);

    // const islandThreshold = estimateIslandThreshold(result, filletSolid);
    // let removedIslands = 0;
    // try {
    //   removedIslands = await result.removeSmallIslands({
    //     maxTriangles: islandThreshold,
    //     removeInternal: true,
    //     removeExternal: true,
    //   });


    //   await result.removeZeroThicknessSections();

    //   if (removedIslands > 0) {
    //     console.log('[Solid.fillet] Removed small islands after fillet boolean', {
    //       featureID,
    //       removedTriangles: removedIslands,
    //       threshold: islandThreshold,
    //       operation,
    //     });
    //   }
    // } catch (err) {
    //   console.warn('[Solid.fillet] removeSmallIslands failed after fillet boolean', {
    //     featureID,
    //     error: err?.message || err,
    //     threshold: islandThreshold,
    //     operation,
    //   });
    // }

    result.visualize();

    const afterTri = Array.isArray(result?._triVerts) ? (result._triVerts.length / 3) : 0;
    // console.log('[Solid.fillet] Applied fillet boolean', {
    //   featureID,
    //   operation,
    //   beforeTriangles: beforeTri,
    //   afterTriangles: afterTri,
    //   removedIslands,
    //   islandThreshold,
    // });
    // Name the result for scene grouping/debugging
    try { result.name = this.name; } catch { }
  }

  try {
    const boundaryCache = { current: null };
    const resultAreaCache = buildFaceAreaCache(result);
    for (const entry of filletEntries) {
      const { filletSolid, filletName } = entry;
      const roundFaceName = entry.roundFaceName || guessRoundFaceName(filletSolid, filletName);
      const candidateNames = (Array.isArray(entry.mergeCandidates) && entry.mergeCandidates.length)
        ? entry.mergeCandidates
        : getFilletMergeCandidateNames(filletSolid);
      mergeTinyFacesIntoRoundFace(result, filletSolid, candidateNames, roundFaceName, featureID, boundaryCache, resultAreaCache);
      mergeSideFacesIntoRoundFace(result, filletName, roundFaceName);
    }
  } catch (err) {
    console.warn('[Solid.fillet] Tiny fillet face merge failed', { featureID, error: err?.message || err });
  }

  // Attach debug artifacts for callers that want to add them to the scene
  if (debug && debugAdded.length) {
    try { result.__debugAddedSolids = debugAdded; } catch { }
    console.log(`🐛 Debug: Added ${debugAdded.length} debug solids to result`);
  } else if (debugAdded.length) {
    // Always attach debug solids if any were created (even on failure)
    try { result.__debugAddedSolids = debugAdded; } catch { }
    console.log(`⚠️ Failure Debug: Added ${debugAdded.length} debug solids to result`);
  }

  // Simplify the final result in place to clean up artifacts from booleans.
  try {
    //await result._weldVerticesByEpsilon(.1);
    // await result.collapseTinyTriangles(.3);
    // await result.simplify(1, true);
    //await result._weldVerticesByEpsilon(.1);
    await result.removeSmallIslands();

    //await result.removeDegenerateTriangles();
  } catch (err) {
    console.warn('[Solid.fillet] simplify failed; continuing without simplification', { featureID, error: err?.message || err });
  }


  // await result._manifoldize();
  // await result._weldVerticesByEpsilon(0.07);
  // await result._manifoldize();
  // await result._weldVerticesByEpsilon(.1);
  // await result._manifoldize();
  // await result.simplify(1, true);
  // await result._manifoldize();
  // await result.visualize();

  const finalTriCount = Array.isArray(result?._triVerts) ? (result._triVerts.length / 3) : 0;
  const finalVertCount = Array.isArray(result?._vertProperties) ? (result._vertProperties.length / 3) : 0;
  if (!result || finalTriCount === 0 || finalVertCount === 0) {
    console.error('[Solid.fillet] Fillet result is empty or missing geometry.', {
      featureID,
      finalTriCount,
      finalVertCount,
      edgeCount: unique.length,
      direction: dir,
      inflate,
    });
  } else {
    console.log('[Solid.fillet] Completed', { featureID, triangles: finalTriCount, vertices: finalVertCount });
  }

  return result;
}
