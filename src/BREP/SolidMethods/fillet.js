// Solid.fillet implementation: consolidates fillet logic so features call this API.
// Usage: solid.fillet({ radius, edgeNames, featureID, direction, inflate, resolution, debug, showTangentOverlays, combineEdges })
import { Manifold } from '../SolidShared.js';

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

function collectEdgePolylinesLocal(edges) {
  const polys = [];
  const validEdges = [];
  if (!Array.isArray(edges) || edges.length === 0) return { polys, edges: validEdges };
  for (const edge of edges) {
    const pts = getEdgePolylineLocal(edge);
    if (pts.length >= 2) {
      polys.push(pts);
      validEdges.push(edge);
    }
  }
  return { polys, edges: validEdges };
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

function combinePathPolylinesLocal(edges, tol = 1e-5) {
  const { polys } = collectEdgePolylinesLocal(edges);
  if (polys.length === 0) return [];
  if (polys.length === 1) return polys[0];

  const effectiveTol = deriveTolerance(polys, tol);
  const tol2 = effectiveTol * effectiveTol;
  const d2 = (a, b) => {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
  };
  const { q, k } = createQuantizer(effectiveTol);

  const nodes = new Map();
  const endpoints = [];
  const addNode = (pt) => {
    const qp = q(pt);
    const key = k(qp);
    if (!nodes.has(key)) nodes.set(key, { p: qp, edges: new Set() });
    return key;
  };
  for (let i = 0; i < polys.length; i++) {
    const p = polys[i];
    const sKey = addNode(p[0]);
    const eKey = addNode(p[p.length - 1]);
    nodes.get(sKey).edges.add(i);
    nodes.get(eKey).edges.add(i);
    endpoints.push({ sKey, eKey });
  }

  let startNodeKey = null;
  for (const [key, val] of nodes.entries()) {
    if ((val.edges.size % 2) === 1) { startNodeKey = key; break; }
  }
  if (!startNodeKey) startNodeKey = nodes.keys().next().value;

  const used = new Array(polys.length).fill(false);
  const chain = [];

  const appendPoly = (poly, reverse = false) => {
    const pts = reverse ? poly.slice().reverse() : poly;
    if (chain.length === 0) {
      chain.push(...pts);
      return;
    }
    const last = chain[chain.length - 1];
    const first = pts[0];
    if (d2(last, first) <= tol2) chain.push(...pts.slice(1));
    else chain.push(...pts);
  };

  const tryConsumeFromNode = (nodeKey) => {
    const node = nodes.get(nodeKey);
    if (!node) return false;
    for (const ei of Array.from(node.edges)) {
      if (used[ei]) continue;
      const { sKey, eKey } = endpoints[ei];
      const forward = (sKey === nodeKey);
      used[ei] = true;
      nodes.get(sKey)?.edges.delete(ei);
      nodes.get(eKey)?.edges.delete(ei);
      appendPoly(polys[ei], !forward);
      return forward ? eKey : sKey;
    }
    return null;
  };

  let cursorKey = startNodeKey;
  let nextKey = tryConsumeFromNode(cursorKey);
  while (nextKey) {
    cursorKey = nextKey;
    nextKey = tryConsumeFromNode(cursorKey);
  }

  let best = chain.slice();
  for (let s = 0; s < polys.length; s++) {
    if (used[s]) continue;
    const localUsed = new Array(polys.length).fill(false);
    const localChain = [];
    localUsed[s] = true;
    const append = (poly, reverse = false) => {
      const pts = reverse ? poly.slice().reverse() : poly;
      if (localChain.length === 0) { localChain.push(...pts); return; }
      const last = localChain[localChain.length - 1];
      const first = pts[0];
      if (d2(last, first) <= tol2) localChain.push(...pts.slice(1)); else localChain.push(...pts);
    };
    append(polys[s], false);
    let head = k(q(localChain[0]));
    let tail = k(q(localChain[localChain.length - 1]));
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < polys.length; i++) {
        if (localUsed[i]) continue;
        const { sKey, eKey } = endpoints[i];
        if (sKey === tail) { append(polys[i], false); tail = eKey; localUsed[i] = true; grew = true; continue; }
        if (eKey === tail) { append(polys[i], true); tail = sKey; localUsed[i] = true; grew = true; continue; }
        if (eKey === head) {
          const pts = polys[i].slice();
          localChain.unshift(...pts.slice(0, pts.length - 1));
          head = sKey;
          localUsed[i] = true;
          grew = true;
          continue;
        }
        if (sKey === head) {
          const pts = polys[i].slice().reverse();
          localChain.unshift(...pts.slice(0, pts.length - 1));
          head = eKey;
          localUsed[i] = true;
          grew = true;
          continue;
        }
      }
    }
    if (localChain.length > best.length) best = localChain;
  }

  for (let i = best.length - 2; i >= 0; i--) {
    const a = best[i];
    const b = best[i + 1];
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) best.splice(i + 1, 1);
  }
  return best;
}

function groupEdgesByConnectivityLocal(edges, tol = 1e-5) {
  const { polys, edges: validEdges } = collectEdgePolylinesLocal(edges);
  if (polys.length === 0) return [];

  const effectiveTol = deriveTolerance(polys, tol);
  const { q, k } = createQuantizer(effectiveTol);
  const nodeEdges = new Map();
  const endpoints = [];

  const register = (key, idx) => {
    if (!nodeEdges.has(key)) nodeEdges.set(key, new Set());
    nodeEdges.get(key).add(idx);
  };

  for (let i = 0; i < polys.length; i++) {
    const poly = polys[i];
    const startKey = k(q(poly[0]));
    const endKey = k(q(poly[poly.length - 1]));
    endpoints.push([startKey, endKey]);
    register(startKey, i);
    register(endKey, i);
  }

  const visited = new Array(polys.length).fill(false);
  const groups = [];
  for (let i = 0; i < polys.length; i++) {
    if (visited[i]) continue;
    const stack = [i];
    const component = [];
    visited[i] = true;
    while (stack.length) {
      const idx = stack.pop();
      component.push(validEdges[idx]);
      const [sKey, eKey] = endpoints[idx];
      const neighbors = new Set([...(nodeEdges.get(sKey) || []), ...(nodeEdges.get(eKey) || [])]);
      for (const n of neighbors) {
        if (visited[n]) continue;
        visited[n] = true;
        stack.push(n);
      }
    }
    if (component.length) groups.push(component);
  }
  return groups;
}

function isClosedLoopPolyline(poly, tol = 1e-6) {
  if (!Array.isArray(poly) || poly.length < 3) return false;
  const a = poly[0];
  const b = poly[poly.length - 1];
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return (dx * dx + dy * dy + dz * dz) <= (tol * tol);
}

function edgeFacePairNames(edge) {
  const a = edge?.faces?.[0]?.name || edge?.userData?.faceA || null;
  const b = edge?.faces?.[1]?.name || edge?.userData?.faceB || null;
  if (!a || !b) return null;
  return [a, b];
}

function combinePathPolylinesWithPairsLocal(edges, tol = 1e-5) {
  const { polys, edges: validEdges } = collectEdgePolylinesLocal(edges);
  if (polys.length === 0) return null;
  const pairs = validEdges.map(edgeFacePairNames);
  if (pairs.some(p => !Array.isArray(p) || p.length < 2)) return null;
  if (polys.length === 1) {
    return {
      points: polys[0],
      segmentFacePairs: Array.from({ length: Math.max(0, polys[0].length - 1) }, () => pairs[0]),
    };
  }

  const effectiveTol = deriveTolerance(polys, tol);
  const tol2 = effectiveTol * effectiveTol;
  const d2 = (a, b) => {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
  };
  const { q, k } = createQuantizer(effectiveTol);

  const nodes = new Map();
  const endpoints = [];
  const addNode = (pt) => {
    const qp = q(pt);
    const key = k(qp);
    if (!nodes.has(key)) nodes.set(key, { p: qp, edges: new Set() });
    return key;
  };
  for (let i = 0; i < polys.length; i++) {
    const p = polys[i];
    const sKey = addNode(p[0]);
    const eKey = addNode(p[p.length - 1]);
    nodes.get(sKey).edges.add(i);
    nodes.get(eKey).edges.add(i);
    endpoints.push({ sKey, eKey });
  }

  let startNodeKey = null;
  for (const [key, val] of nodes.entries()) {
    if ((val.edges.size % 2) === 1) { startNodeKey = key; break; }
  }
  if (!startNodeKey) startNodeKey = nodes.keys().next().value;

  const used = new Array(polys.length).fill(false);
  const chain = [];
  const segmentFacePairs = [];

  const appendPoly = (polyIdx, reverse = false) => {
    const poly = polys[polyIdx];
    const pts = reverse ? poly.slice().reverse() : poly;
    const pair = pairs[polyIdx];
    if (!pair) return false;
    if (chain.length === 0) {
      chain.push(...pts);
    } else {
      const last = chain[chain.length - 1];
      const first = pts[0];
      if (d2(last, first) <= tol2) chain.push(...pts.slice(1));
      else return false;
    }
    for (let i = 0; i < pts.length - 1; i++) segmentFacePairs.push(pair);
    return true;
  };

  const tryConsumeFromNode = (nodeKey) => {
    const node = nodes.get(nodeKey);
    if (!node) return null;
    for (const ei of Array.from(node.edges)) {
      if (used[ei]) continue;
      const { sKey, eKey } = endpoints[ei];
      const forward = (sKey === nodeKey);
      if (!appendPoly(ei, !forward)) return null;
      used[ei] = true;
      nodes.get(sKey)?.edges.delete(ei);
      nodes.get(eKey)?.edges.delete(ei);
      return forward ? eKey : sKey;
    }
    return null;
  };

  let cursorKey = startNodeKey;
  let nextKey = tryConsumeFromNode(cursorKey);
  while (nextKey) {
    cursorKey = nextKey;
    nextKey = tryConsumeFromNode(cursorKey);
  }

  if (used.some(v => !v)) return null;
  if (segmentFacePairs.length !== Math.max(0, chain.length - 1)) {
    segmentFacePairs.length = Math.max(0, chain.length - 1);
  }

  for (let i = chain.length - 2; i >= 0; i--) {
    const a = chain[i];
    const b = chain[i + 1];
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) {
      chain.splice(i + 1, 1);
      if (i < segmentFacePairs.length) segmentFacePairs.splice(i, 1);
    }
  }

  if (chain.length >= 3) {
    const a = chain[0];
    const b = chain[chain.length - 1];
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    const dz = a[2] - b[2];
    if ((dx * dx + dy * dy + dz * dz) <= tol2) {
      const lastPair = segmentFacePairs[segmentFacePairs.length - 1] || segmentFacePairs[0];
      if (lastPair) segmentFacePairs.push(lastPair);
    }
  }

  return { points: chain, segmentFacePairs };
}

function rotateAroundAxis(v, axis, angle) {
  const ax = axis[0], ay = axis[1], az = axis[2];
  const vx = v[0], vy = v[1], vz = v[2];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = ax * vx + ay * vy + az * vz;
  const cx = ay * vz - az * vy;
  const cy = az * vx - ax * vz;
  const cz = ax * vy - ay * vx;
  return [
    vx * cos + cx * sin + ax * dot * (1 - cos),
    vy * cos + cy * sin + ay * dot * (1 - cos),
    vz * cos + cz * sin + az * dot * (1 - cos),
  ];
}

function smoothCombinedPathWithPairs(points, segmentFacePairs, radius, closedLoop = false) {
  if (!Array.isArray(points) || points.length < 2) return { points, segmentFacePairs };
  if (!(radius > 0) || !Array.isArray(segmentFacePairs) || segmentFacePairs.length < 1) {
    return { points, segmentFacePairs };
  }

  const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const vLen = (v) => Math.hypot(v[0], v[1], v[2]);
  const vNorm = (v) => {
    const l = vLen(v);
    return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
  };
  const d2 = (a, b) => {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const minAngle = (10 * Math.PI) / 180;
  const epsD2 = 1e-16;

  const basePoints = points.slice();
  let isClosed = !!closedLoop;
  if (isClosed && basePoints.length >= 3) {
    const first = basePoints[0];
    const last = basePoints[basePoints.length - 1];
    if (d2(first, last) <= epsD2) basePoints.pop();
  }

  const pairsEqual = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) return false;
    return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
  };

  const simplifyCollinear = (pts, segPairs, closed) => {
    const outPts = pts.slice();
    const outPairs = segPairs.slice();
    const maxPass = Math.max(1, outPts.length);
    const angTol = Math.cos(5 * Math.PI / 180);
    let changed = true;
    let pass = 0;
    while (changed && pass < maxPass) {
      changed = false;
      pass++;
      const count = outPts.length;
      if (count < 3) break;
      const start = closed ? 0 : 1;
      const end = closed ? count : (count - 1);
      for (let i = start; i < end; i++) {
        const iPrev = (i - 1 + count) % count;
        const iNext = (i + 1) % count;
        if (!closed && (i === 0 || i === count - 1)) continue;
        const p0 = outPts[iPrev];
        const p1 = outPts[i];
        const p2 = outPts[iNext];
        const v0 = vNorm(vSub(p1, p0));
        const v1 = vNorm(vSub(p2, p1));
        if (vLen(v0) < 1e-12 || vLen(v1) < 1e-12) continue;
        const dot = vDot(v0, v1);
        if (dot < angTol) continue;
        const segIdx0 = iPrev % outPairs.length;
        const segIdx1 = i % outPairs.length;
        if (!pairsEqual(outPairs[segIdx0], outPairs[segIdx1])) continue;
        outPts.splice(i, 1);
        outPairs.splice(segIdx1, 1);
        changed = true;
        break;
      }
    }
    return { points: outPts, segmentFacePairs: outPairs };
  };

  const simplified = simplifyCollinear(basePoints, segmentFacePairs, isClosed);
  const basePts = simplified.points;
  const basePairs = simplified.segmentFacePairs;

  const n = basePts.length;
  if (isClosed) {
    if (basePairs.length < n) basePairs.push(basePairs[basePairs.length - 1] || basePairs[0]);
  } else if (basePairs.length < n - 1) {
    return { points, segmentFacePairs };
  }

  const computeCorner = (pPrev, pCorner, pNext) => {
    const v0 = vNorm(vSub(pPrev, pCorner));
    const v1 = vNorm(vSub(pNext, pCorner));
    const dot = clamp(vDot(v0, v1), -1, 1);
    const ang = Math.acos(dot);
    if (!Number.isFinite(ang) || ang < minAngle || ang > (Math.PI - minAngle)) return null;
    const len0 = vLen(vSub(pPrev, pCorner));
    const len1 = vLen(vSub(pNext, pCorner));
    if (!(len0 > 1e-9 && len1 > 1e-9)) return null;
    let t = radius * Math.tan(ang / 2);
    const maxT = 0.45 * Math.min(len0, len1);
    if (!(t > 1e-8)) return null;
    if (t > maxT) t = maxT;
    const pre = vAdd(pCorner, vScale(v0, t));
    const post = vAdd(pCorner, vScale(v1, t));
    const bis = vNorm(vAdd(v0, v1));
    if (vLen(bis) < 1e-9) return null;
    const sinHalf = Math.sin(ang / 2);
    if (Math.abs(sinHalf) < 1e-9) return null;
    const center = vAdd(pCorner, vScale(bis, radius / sinHalf));
    const startVec = vSub(pre, center);
    const endVec = vSub(post, center);
    let axis = vNorm(vCross(v0, v1));
    if (vLen(axis) < 1e-9) return null;
    const crossSE = vCross(startVec, endVec);
    if (vDot(crossSE, axis) < 0) axis = vScale(axis, -1);
    const step = Math.PI / 12;
    const steps = Math.max(2, Math.ceil(ang / step));
    const arcPts = [];
    for (let k = 1; k < steps; k++) {
      const a = (ang * k) / steps;
      const rv = rotateAroundAxis(startVec, axis, a);
      arcPts.push(vAdd(center, rv));
    }
    return { pre, post, arcPts, corner: pCorner };
  };

  const addSegmentPoint = (outPts, outPairs, pt, pair) => {
    const last = outPts[outPts.length - 1];
    if (last && d2(last, pt) <= epsD2) return;
    outPairs.push(pair);
    outPts.push(pt);
  };

  const addArc = (outPts, outPairs, arc, pairIn, pairOut) => {
    if (!arc) return;
    const arcPts = Array.isArray(arc.arcPts) ? arc.arcPts : [];
    const segCount = arcPts.length + 1;
    const isPairArray = (p) => Array.isArray(p) && p.length >= 2;
    let blendInfo = null;
    if (isPairArray(pairIn) && isPairArray(pairOut)) {
      const a0 = pairIn[0], a1 = pairIn[1];
      const b0 = pairOut[0], b1 = pairOut[1];
      let base = null;
      let sideIn = null;
      let sideOut = null;
      if (a0 === b0 || a0 === b1) {
        base = a0;
        sideIn = a1;
        sideOut = (b0 === a0) ? b1 : b0;
      } else if (a1 === b0 || a1 === b1) {
        base = a1;
        sideIn = a0;
        sideOut = (b0 === a1) ? b1 : b0;
      }
      if (base && sideIn && sideOut) {
        blendInfo = { base, sideA: sideIn, sideB: sideOut };
      }
    }

    if (!blendInfo) {
      const pickPair = (idx) => (idx < (segCount / 2)) ? (pairIn || pairOut) : (pairOut || pairIn);
      for (let i = 0; i < arcPts.length; i++) {
        const pair = pickPair(i);
        addSegmentPoint(outPts, outPairs, arcPts[i], pair);
      }
      const lastPair = pickPair(segCount - 1);
      addSegmentPoint(outPts, outPairs, arc.post, lastPair);
      return;
    }

    const corner = arc.corner || arc.post || arc.pre;
    for (let i = 0; i < arcPts.length; i++) {
      const t = (i + 1) / segCount;
      addSegmentPoint(outPts, outPairs, arcPts[i], { ...blendInfo, t, corner });
    }
    addSegmentPoint(outPts, outPairs, arc.post, { ...blendInfo, t: 1, corner });
  };

  if (!isClosed) {
    const outPts = [basePts[0]];
    const outPairs = [];
    for (let i = 0; i < n - 1; i++) {
      const p0 = basePts[i];
      const p1 = basePts[i + 1];
      const pairIn = basePairs[i];
      if (i + 1 < n - 1) {
        const p2 = basePts[i + 2];
        const corner = computeCorner(p0, p1, p2);
        if (corner) {
          addSegmentPoint(outPts, outPairs, corner.pre, pairIn);
          const pairOut = basePairs[i + 1];
          addArc(outPts, outPairs, corner, pairIn, pairOut);
          continue;
        }
      }
      addSegmentPoint(outPts, outPairs, p1, pairIn);
    }
    return { points: outPts, segmentFacePairs: outPairs };
  }

  const corners = new Array(n);
  for (let i = 0; i < n; i++) {
    const pPrev = basePts[(i - 1 + n) % n];
    const pCur = basePts[i];
    const pNext = basePts[(i + 1) % n];
    const corner = computeCorner(pPrev, pCur, pNext);
    corners[i] = corner || { pre: pCur, post: pCur, arcPts: [] };
  }

  const outPts = [corners[0].post];
  const outPairs = [];
  for (let segIdx = 0; segIdx < n; segIdx++) {
    const nextCorner = (segIdx + 1) % n;
    const segPair = basePairs[segIdx];
    addSegmentPoint(outPts, outPairs, corners[nextCorner].pre, segPair);
    const pairOut = basePairs[nextCorner];
    addArc(outPts, outPairs, corners[nextCorner], segPair, pairOut);
  }

  return { points: outPts, segmentFacePairs: outPairs };
}

function buildCombinedEdgesForFillet(solid, edges, featureID, radius) {
  const combined = [];
  const { edges: validEdges } = collectEdgePolylinesLocal(edges);
  const invalidEdges = edges.filter(e => !validEdges.includes(e));
  const edgeGroups = groupEdgesByConnectivityLocal(validEdges);
  if (!edgeGroups.length) return edges.slice();

  let chainIdx = 0;
  for (const component of edgeGroups) {
    if (component.length === 1) {
      combined.push(component[0]);
      continue;
    }
    const result = combinePathPolylinesWithPairsLocal(component);
    if (!result || !Array.isArray(result.points) || result.points.length < 2 || !Array.isArray(result.segmentFacePairs) || result.segmentFacePairs.length < 1) {
      combined.push(...component);
      continue;
    }
    const baseEdge = component.find(e => Array.isArray(e?.faces) && e.faces.length >= 2) || component[0];
    const tol = deriveTolerance([result.points], 1e-5);
    const closedLoop = isClosedLoopPolyline(result.points, tol);
    const smoothed = smoothCombinedPathWithPairs(result.points, result.segmentFacePairs, radius, closedLoop);
    const finalPoints = Array.isArray(smoothed?.points) && smoothed.points.length >= 2 ? smoothed.points : result.points;
    const finalPairs = Array.isArray(smoothed?.segmentFacePairs) && smoothed.segmentFacePairs.length >= 1 ? smoothed.segmentFacePairs : result.segmentFacePairs;
    const finalClosed = isClosedLoopPolyline(finalPoints, deriveTolerance([finalPoints], 1e-5));
    const baseName = baseEdge?.name || `${featureID}_EDGE_CHAIN_${chainIdx}`;
    const name = `${baseName}_CHAIN_${chainIdx}`;
    combined.push({
      type: 'EDGE',
      name,
      faces: baseEdge?.faces || [],
      parentSolid: solid,
      parent: solid,
      userData: { polylineLocal: finalPoints, closedLoop: finalClosed, segmentFacePairs: finalPairs },
      closedLoop: finalClosed,
    });
    chainIdx++;
  }
  if (invalidEdges.length) combined.push(...invalidEdges);
  return combined;
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
  console.log('[Solid.fillet] Begin', {
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
    console.log('[Solid.fillet] combineEdges enabled: using corner hulls for shared endpoints.');
  }

  // Build fillet solids per edge using existing core implementation
  const filletEntries = [];
  let idx = 0;
  const debugAdded = [];
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
    return c;
  }
  console.log('[Solid.fillet] Built fillet solids for edges', filletEntries.length);

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
  for (const filletSolid of solidsToApply) {
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
