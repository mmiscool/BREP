// Solid.fillet implementation: consolidates fillet logic so features call this API.
// Usage: solid.fillet({ radius, edgeNames, featureID, direction, inflate, resolution, debug, showTangentOverlays, combineEdges })
import { Manifold } from '../SolidShared.js';

const debugMode = false;

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
        consoleLogReplacement('[Solid.fillet] Merged tiny fillet face into round face', {
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

function getEdgePolylineLocal(edgeObj) {
  if (!edgeObj) return [];
  const cached = edgeObj?.userData?.polylineLocal;
  if (Array.isArray(cached) && cached.length >= 2) {
    return cached.map(p => [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0]);
  }
  if (typeof edgeObj.points === 'function') {
    const pts = edgeObj.points(false);
    if (Array.isArray(pts) && pts.length >= 2) {
      return pts.map(p => [Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0]);
    }
  }
  const pos = edgeObj?.geometry?.getAttribute?.('position');
  if (pos && pos.itemSize === 3 && pos.count >= 2) {
    const out = [];
    for (let i = 0; i < pos.count; i++) {
      out.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
    }
    return out;
  }
  return [];
}

function deriveTolerance(polys, baseTol = 1e-5) {
  if (!Array.isArray(polys) || polys.length === 0) return baseTol;
  if (baseTol !== 1e-5) return baseTol;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const segLens = [];
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const v = p[i];
      if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
      if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
      if (i > 0) {
        const a = p[i - 1];
        const dx = a[0] - v[0], dy = a[1] - v[1], dz = a[2] - v[2];
        segLens.push(Math.hypot(dx, dy, dz));
      }
    }
  }
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  const diag = Math.hypot(dx, dy, dz) || 1;
  segLens.sort((a, b) => a - b);
  const med = segLens.length ? segLens[(segLens.length >> 1)] : diag;
  return Math.min(Math.max(1e-5, diag * 1e-3), med * 0.1);
}

function createQuantizer(tol) {
  const t = tol || 1e-5;
  const q = (v) => [
    Math.round(v[0] / t) * t,
    Math.round(v[1] / t) * t,
    Math.round(v[2] / t) * t,
  ];
  const k = (v) => `${v[0]},${v[1]},${v[2]}`;
  return { q, k };
}

function dedupePoints(points, tol = 1e-5) {
  const out = [];
  const seen = new Set();
  const { q, k } = createQuantizer(tol);
  for (const p of points || []) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const qp = q(p);
    const key = k(qp);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(qp);
  }
  return out;
}

function collectFacePoints(solid, faceName, out) {
  if (!solid || typeof solid.getFace !== 'function' || !faceName) return out;
  const tris = solid.getFace(faceName);
  if (!Array.isArray(tris) || tris.length === 0) return out;
  const dst = Array.isArray(out) ? out : [];
  for (const tri of tris) {
    const p1 = tri?.p1;
    const p2 = tri?.p2;
    const p3 = tri?.p3;
    if (Array.isArray(p1) && p1.length >= 3) dst.push([Number(p1[0]) || 0, Number(p1[1]) || 0, Number(p1[2]) || 0]);
    if (Array.isArray(p2) && p2.length >= 3) dst.push([Number(p2[0]) || 0, Number(p2[1]) || 0, Number(p2[2]) || 0]);
    if (Array.isArray(p3) && p3.length >= 3) dst.push([Number(p3[0]) || 0, Number(p3[1]) || 0, Number(p3[2]) || 0]);
  }
  return dst;
}

function buildHullSolidFromPoints(points, name, SolidCtor, tol = 1e-5) {
  const unique = dedupePoints(points, tol);
  if (unique.length < 4) return null;
  let hull = null;
  try {
    hull = Manifold.hull(unique);
  } catch {
    return null;
  }
  try {
    const solid = SolidCtor._fromManifold(hull, new Map([[0, name]]));
    try { solid.name = name; } catch { }
    const faceNames = (typeof solid.getFaceNames === 'function') ? solid.getFaceNames() : [];
    for (const faceName of faceNames) {
      if (!faceName || faceName === name) continue;
      mergeFaceIntoTarget(solid, faceName, name);
    }
    return solid;
  } catch {
    return null;
  }
}

function averageFaceNormalSimple(solid, faceName) {
  if (!solid || typeof solid.getFace !== 'function' || !faceName) return null;
  const tris = solid.getFace(faceName);
  if (!Array.isArray(tris) || tris.length === 0) return null;
  let nx = 0, ny = 0, nz = 0;
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
    const cxn = uy * vz - uz * vy;
    const cyn = uz * vx - ux * vz;
    const czn = ux * vy - uy * vx;
    nx += cxn;
    ny += cyn;
    nz += czn;
  }
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-12)) return null;
  return [nx / len, ny / len, nz / len];
}

function deriveSolidToleranceFromVerts(solid, baseTol = 1e-5) {
  const vp = Array.isArray(solid?._vertProperties) ? solid._vertProperties : null;
  if (!vp || vp.length < 6) return baseTol;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vp.length; i += 3) {
    const x = vp[i + 0];
    const y = vp[i + 1];
    const z = vp[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  const diag = Math.hypot(dx, dy, dz) || 1;
  return Math.max(baseTol, diag * 1e-6);
}

function buildAdjacencyFromBoundaryPolylines(solid) {
  const map = new Map();
  if (!solid || typeof solid.getBoundaryEdgePolylines !== 'function') return map;
  const boundaries = solid.getBoundaryEdgePolylines() || [];
  for (const poly of boundaries) {
    const a = poly?.faceA;
    const b = poly?.faceB;
    if (!a || !b) continue;
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(b)) map.set(b, new Set());
    map.get(a).add(b);
    map.get(b).add(a);
  }
  return map;
}

function buildAdjacencyFromFaceEdges(solid, faceNames, tol) {
  const { q, k } = createQuantizer(tol);
  const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const edgeToFaces = new Map();
  const faceToEdges = new Map();
  for (const faceName of faceNames) {
    const tris = solid.getFace(faceName);
    if (!Array.isArray(tris) || tris.length === 0) continue;
    const counts = new Map();
    for (const tri of tris) {
      const p1 = tri?.p1;
      const p2 = tri?.p2;
      const p3 = tri?.p3;
      if (!Array.isArray(p1) || !Array.isArray(p2) || !Array.isArray(p3)) continue;
      const v1 = k(q(p1));
      const v2 = k(q(p2));
      const v3 = k(q(p3));
      const e12 = edgeKey(v1, v2);
      const e23 = edgeKey(v2, v3);
      const e31 = edgeKey(v3, v1);
      counts.set(e12, (counts.get(e12) || 0) + 1);
      counts.set(e23, (counts.get(e23) || 0) + 1);
      counts.set(e31, (counts.get(e31) || 0) + 1);
    }
    const boundary = new Set();
    for (const [key, count] of counts.entries()) {
      if (count === 1) boundary.add(key);
    }
    faceToEdges.set(faceName, boundary);
    for (const key of boundary) {
      let set = edgeToFaces.get(key);
      if (!set) { set = new Set(); edgeToFaces.set(key, set); }
      set.add(faceName);
    }
  }
  const adj = new Map();
  for (const [faceName, edges] of faceToEdges.entries()) {
    const set = new Set();
    for (const key of edges) {
      const faces = edgeToFaces.get(key);
      if (!faces) continue;
      for (const f of faces) {
        if (f !== faceName) set.add(f);
      }
    }
    adj.set(faceName, set);
  }
  return adj;
}

function mergeInsetEndCapsByNormal(resultSolid, featureID, direction, dotThreshold = 0.999) {
  if (!resultSolid || String(direction).toUpperCase() !== 'INSET') return;
  if (typeof resultSolid.getFaceNames !== 'function') return;
  const faceNames = resultSolid.getFaceNames() || [];
  if (!Array.isArray(faceNames) || faceNames.length === 0) return;
  const faceHasTris = (name) => {
    if (!name || typeof resultSolid.getFace !== 'function') return false;
    const tris = resultSolid.getFace(name);
    return Array.isArray(tris) && tris.length > 0;
  };
  const activeFaceNames = faceNames.filter(faceHasTris);
  const prefix = featureID ? `${featureID}_FILLET_` : '';
  const endCapFaces = activeFaceNames.filter((name) => {
    if (typeof name !== 'string') return false;
    if (prefix && !name.startsWith(prefix)) return false;
    return /_END_CAP_\d+$/.test(name);
  });
  consoleLogReplacement('[Solid.fillet] Inset end cap scan', {
    featureID,
    direction,
    endCapFaces,
  });

  if (!endCapFaces.length) return;

  const adjacentMap = buildAdjacencyFromBoundaryPolylines(resultSolid);
  const tol = deriveSolidToleranceFromVerts(resultSolid, 1e-5);
  const edgeAdjMap = buildAdjacencyFromFaceEdges(resultSolid, activeFaceNames, tol);

  const normalCache = new Map();
  const getNormal = (name) => {
    if (normalCache.has(name)) return normalCache.get(name);
    const n = averageFaceNormalSimple(resultSolid, name);
    normalCache.set(name, n);
    return n;
  };
  const fmtNormal = (n) => (Array.isArray(n) && n.length >= 3)
    ? [Number(n[0].toFixed(6)), Number(n[1].toFixed(6)), Number(n[2].toFixed(6))]
    : null;

  const tryMergeWithAdj = (capName, adj) => {
    if (!adj || adj.size === 0) return false;
    const nCap = getNormal(capName);
    if (!nCap) return false;
    for (const neighbor of adj) {
      if (neighbor === capName) continue;
      const nAdj = getNormal(neighbor);
      if (!nAdj) continue;
      const dot = (nCap[0] * nAdj[0]) + (nCap[1] * nAdj[1]) + (nCap[2] * nAdj[2]);
      if (dot >= dotThreshold) {
        mergeFaceIntoTarget(resultSolid, capName, neighbor);
        return true;
      }
    }
    return false;
  };

  let mergedCount = 0;
  for (const capName of endCapFaces) {
    const adj = adjacentMap.get(capName);
    const adjEdge = edgeAdjMap.get(capName);
    const adjAll = new Set([
      ...(adj ? Array.from(adj) : []),
      ...(adjEdge ? Array.from(adjEdge) : []),
    ]);
    consoleLogReplacement('[Solid.fillet] Inset end cap normals', {
      featureID,
      capName,
      capNormal: fmtNormal(getNormal(capName)),
      adjacent: Array.from(adjAll).map((name) => ({
        name,
        normal: fmtNormal(getNormal(name)),
      })),
    });
    if (tryMergeWithAdj(capName, adj)) {
      consoleLogReplacement('[Solid.fillet] Inset end cap merged', { featureID, capName });
      mergedCount++;
      continue;
    }
    if (tryMergeWithAdj(capName, edgeAdjMap.get(capName))) {
      consoleLogReplacement('[Solid.fillet] Inset end cap merged', { featureID, capName });
      mergedCount++;
      continue;
    }
  }
  consoleLogReplacement('[Solid.fillet] Inset end cap merge summary', { featureID, mergedCount });
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
 * @param {boolean} [opts.combineEdges=false] Combine connected edges that share face pairs into single paths
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
  const combineEdges = (dir !== 'INSET') && !!opts.combineEdges;
  const showTangentOverlays = !!opts.showTangentOverlays;
  const featureID = opts.featureID || 'FILLET';
  const SolidCtor = this?.constructor;
  consoleLogReplacement('[Solid.fillet] Begin', {
    featureID,
    solid: this?.name,
    radius,
    direction: dir,
    inflate,
    resolution,
    debug,
    showTangentOverlays,
    combineEdges,
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

  const combineCornerHulls = combineEdges && unique.length > 1;
  let filletEdges = unique;
  if (combineCornerHulls) {
    consoleLogReplacement('[Solid.fillet] combineEdges enabled: using corner hulls for shared endpoints.');
  }

  // Build fillet solids per edge using existing core implementation
  const filletEntries = [];
  let idx = 0;
  const debugAdded = [];
  const attachDebugSolids = (target, reason = '') => {
    if (!target || debugAdded.length === 0) return;
    try { target.__debugAddedSolids = debugAdded; } catch { }
    const prefix = debug ? '🐛 Debug' : '⚠️ Failure Debug';
    const suffix = reason ? ` (${reason})` : '';
    consoleLogReplacement(`${prefix}: Added ${debugAdded.length} debug solids to result${suffix}`);
  };
  for (const e of filletEdges) {
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
    filletEntries.push({
      filletSolid: res.finalSolid,
      filletName: name,
      mergeCandidates,
      roundFaceName,
      wedgeSolid: res.wedge || null,
      tubeSolid: res.tube || null,
      edgeObj: e,
      edgePoints: Array.isArray(res.edge) ? res.edge : [],
    });
    if (debug) {
      try { if (res.tube) debugAdded.push(res.tube); } catch { }
      try { if (res.wedge) debugAdded.push(res.wedge); } catch { }
    }
  }
  if (filletEntries.length === 0) {
    console.error('[Solid.fillet] All edge fillets failed; returning clone.', { featureID, edgeCount: unique.length });
    const c = this.clone();
    try { c.name = this.name; } catch { }
    attachDebugSolids(c, 'all fillets failed');
    return c;
  }
  consoleLogReplacement('[Solid.fillet] Built fillet solids for edges', filletEntries.length);

  const cornerWedgeHulls = [];
  const cornerTubeHulls = [];
  let combinedFilletSolid = null;
  if (combineCornerHulls && SolidCtor && filletEntries.length > 1) {
    try {
      const polylines = [];
      for (const entry of filletEntries) {
        const poly = getEdgePolylineLocal(entry.edgeObj);
        if (poly.length >= 2) polylines.push(poly);
      }
      const cornerTol = deriveTolerance(polylines, 1e-5);
      const { q, k } = createQuantizer(cornerTol);
      const groups = new Map();

      const addEndpoint = (pt, entry, cap) => {
        if (!Array.isArray(pt) || pt.length < 3) return;
        const qp = q(pt);
        const key = k(qp);
        if (!groups.has(key)) groups.set(key, { point: qp, items: [] });
        groups.get(key).items.push({ entry, cap });
      };

      for (const entry of filletEntries) {
        let poly = getEdgePolylineLocal(entry.edgeObj);
        if (poly.length < 2 && Array.isArray(entry.edgePoints) && entry.edgePoints.length >= 2) {
          poly = entry.edgePoints.map(p => [Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0]);
        }
        if (poly.length < 2) continue;
        addEndpoint(poly[0], entry, 'start');
        addEndpoint(poly[poly.length - 1], entry, 'end');
      }

      let cornerIdx = 0;
      for (const group of groups.values()) {
        if (!group || !Array.isArray(group.items) || group.items.length < 2) continue;
        const wedgePoints = [];
        const tubePoints = [];
        for (const item of group.items) {
          const entry = item.entry;
          if (!entry) continue;
          const filletName = entry.filletName;
          const wedge = entry.wedgeSolid;
          const tube = entry.tubeSolid;
          const capSuffix = (item.cap === 'start') ? '_END_CAP_1' : '_END_CAP_2';
          const tubeSuffix = (item.cap === 'start') ? '_TUBE_CapStart' : '_TUBE_CapEnd';
          if (wedge) collectFacePoints(wedge, `${filletName}${capSuffix}`, wedgePoints);
          if (tube) collectFacePoints(tube, `${filletName}${tubeSuffix}`, tubePoints);
        }

        const wedgeHull = buildHullSolidFromPoints(wedgePoints, `${featureID}_CORNER_${cornerIdx}_WEDGE_HULL`, SolidCtor, cornerTol);
        const tubeHull = buildHullSolidFromPoints(tubePoints, `${featureID}_CORNER_${cornerIdx}_TUBE_HULL`, SolidCtor, cornerTol);
        if (!wedgeHull || !tubeHull) {
          cornerIdx++;
          continue;
        }
        cornerWedgeHulls.push(wedgeHull);
        cornerTubeHulls.push(tubeHull);
        if (debug) {
          debugAdded.push(wedgeHull);
          debugAdded.push(tubeHull);
        }
        cornerIdx++;
      }
      const wedgeParts = [];
      const tubeParts = [];
      for (const entry of filletEntries) {
        if (entry.wedgeSolid) wedgeParts.push(entry.wedgeSolid);
        if (entry.tubeSolid) tubeParts.push(entry.tubeSolid);
      }
      if (cornerWedgeHulls.length) wedgeParts.push(...cornerWedgeHulls);
      if (cornerTubeHulls.length) tubeParts.push(...cornerTubeHulls);

      const unionAll = (parts) => {
        let acc = null;
        for (const solid of parts) {
          acc = acc ? acc.union(solid) : solid;
        }
        return acc;
      };

      const combinedWedge = unionAll(wedgeParts);
      const combinedTube = unionAll(tubeParts);
      if (combinedWedge && combinedTube) {
        combinedFilletSolid = combinedWedge.subtract(combinedTube);
        try { combinedFilletSolid.name = `${featureID}_FILLET_COMBINED`; } catch { }
        if (debug) {
          debugAdded.push(combinedWedge);
          debugAdded.push(combinedTube);
        }
      }
    } catch (err) {
      console.warn('[Solid.fillet] Corner hull build failed', { featureID, error: err?.message || err });
    }
  }

  // Apply to base solid (union for OUTSET, subtract for INSET)
  let result = this;
  const solidsToApply = combinedFilletSolid ? [combinedFilletSolid] : filletEntries.map(entry => entry.filletSolid);
  try {
    for (const filletSolid of solidsToApply) {
      const operation = (dir === 'OUTSET') ? 'union' : 'subtract';
      result = (operation === 'union') ? result.union(filletSolid) : result.subtract(filletSolid);

      result.visualize();

      // Name the result for scene grouping/debugging
      try { result.name = this.name; } catch { }
    }
  } catch (err) {
    console.error('[Solid.fillet] Fillet boolean failed; returning clone.', { featureID, error: err?.message || err });
    const fallback = this.clone();
    try { fallback.name = this.name; } catch { }
    attachDebugSolids(fallback, 'boolean failure');
    return fallback;
  }

  try {
    const boundaryCache = { current: null };
    const resultAreaCache = buildFaceAreaCache(result);
    for (const entry of filletEntries) {
      const { filletSolid, filletName } = entry;
      const mergeSolid = combinedFilletSolid || filletSolid;
      const roundFaceName = entry.roundFaceName || guessRoundFaceName(mergeSolid, filletName);
      const candidateNames = (Array.isArray(entry.mergeCandidates) && entry.mergeCandidates.length)
        ? entry.mergeCandidates
        : getFilletMergeCandidateNames(mergeSolid);
      mergeTinyFacesIntoRoundFace(result, mergeSolid, candidateNames, roundFaceName, featureID, boundaryCache, resultAreaCache);
      mergeSideFacesIntoRoundFace(result, filletName, roundFaceName);
    }
  } catch (err) {
    console.warn('[Solid.fillet] Tiny fillet face merge failed', { featureID, error: err?.message || err });
  }

  try {
    if (dir === 'INSET' && typeof result.mergeTinyFaces === 'function') {
      await result.mergeTinyFaces(0.001);
    }
  } catch (err) {
    console.warn('[Solid.fillet] mergeTinyFaces failed', { featureID, error: err?.message || err });
  }

  try {
    await mergeInsetEndCapsByNormal(result, featureID, dir);
  } catch (err) {
    console.warn('[Solid.fillet] Inset end cap merge failed', { featureID, error: err?.message || err });
  }

  try {
    await result.collapseTinyTriangles(0.0009);
  } catch (err) {
    console.warn('[Solid.fillet] collapseTinyTriangles failed', { featureID, error: err?.message || err });
  }

  // Attach debug artifacts for callers that want to add them to the scene
  attachDebugSolids(result);

  // Simplify the final result in place to clean up artifacts from booleans.
  try {
    await result.removeSmallIslands();
  } catch (err) {
    console.warn('[Solid.fillet] simplify failed; continuing without simplification', { featureID, error: err?.message || err });
  }

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
    consoleLogReplacement('[Solid.fillet] Completed', { featureID, triangles: finalTriCount, vertices: finalVertCount });
  }

  return result;
}



function consoleLogReplacement(args){
  if (debugMode) console.log(...args);
}
