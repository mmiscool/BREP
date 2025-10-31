import { BREP } from '../../BREP/BREP.js';

const inputParamsSchema = {
  featureID: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the tube feature'
  },
  path: {
    type: 'reference_selection',
    selectionFilter: ['EDGE'],
    multiple: true,
    default_value: null,
    hint: 'Select one or more connected edges defining the tube path'
  },
  radius: {
    type: 'number',
    default_value: 5,
    hint: 'Outer radius of the tube'
  },
  innerRadius: {
    type: 'number',
    default_value: 0,
    hint: 'Optional inner radius for hollow tubes (0 for solid)'
  },
  resolution: {
    type: 'number',
    default_value: 32,
    hint: 'Segments around the tube circumference'
  },
  boolean: {
    type: 'boolean_operation',
    default_value: { targets: [], operation: 'NONE' },
    hint: 'Optional boolean operation with target solids'
  }
};

const THREE = BREP.THREE;

function extractPathPolylineWorld(edgeObj) {
  const pts = [];
  if (!edgeObj) return pts;
  const cached = edgeObj?.userData?.polylineLocal;
  const isWorld = !!(edgeObj?.userData?.polylineWorld);
  const v = new THREE.Vector3();
  if (Array.isArray(cached) && cached.length >= 2) {
    if (isWorld) {
      for (const p of cached) pts.push([p[0], p[1], p[2]]);
    } else {
      for (const p of cached) {
        v.set(p[0], p[1], p[2]).applyMatrix4(edgeObj.matrixWorld);
        pts.push([v.x, v.y, v.z]);
      }
    }
  } else {
    const posAttr = edgeObj?.geometry?.getAttribute?.('position');
    if (posAttr && posAttr.itemSize === 3 && posAttr.count >= 2) {
      for (let i = 0; i < posAttr.count; i++) {
        v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(edgeObj.matrixWorld);
        pts.push([v.x, v.y, v.z]);
      }
    } else {
      const aStart = edgeObj?.geometry?.attributes?.instanceStart;
      const aEnd = edgeObj?.geometry?.attributes?.instanceEnd;
      if (aStart && aEnd && aStart.itemSize === 3 && aEnd.itemSize === 3 && aStart.count === aEnd.count && aStart.count >= 1) {
        v.set(aStart.getX(0), aStart.getY(0), aStart.getZ(0)).applyMatrix4(edgeObj.matrixWorld);
        pts.push([v.x, v.y, v.z]);
        for (let i = 0; i < aEnd.count; i++) {
          v.set(aEnd.getX(i), aEnd.getY(i), aEnd.getZ(i)).applyMatrix4(edgeObj.matrixWorld);
          pts.push([v.x, v.y, v.z]);
        }
      }
    }
  }
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) pts.splice(i + 1, 1);
  }
  return pts;
}

function collectEdgePolylines(edges) {
  const polys = [];
  const validEdges = [];
  if (!Array.isArray(edges) || edges.length === 0) return { polys, edges: validEdges };
  for (const edge of edges) {
    const pts = extractPathPolylineWorld(edge);
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

function combinePathPolylines(edges, tol = 1e-5) {
  const { polys } = collectEdgePolylines(edges);
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

function groupEdgesByConnectivity(edges, tol = 1e-5) {
  const { polys, edges: validEdges } = collectEdgePolylines(edges);
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

function dedupePoints(points, eps = 1e-7) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const epsSq = eps * eps;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const prev = out[out.length - 1];
    const dx = p[0] - prev[0];
    const dy = p[1] - prev[1];
    const dz = p[2] - prev[2];
    if ((dx * dx + dy * dy + dz * dz) > epsSq) out.push(p);
  }
  return out;
}

function extendPathEndpoints(points, extension = 0) {
  if (!Array.isArray(points) || points.length < 2 || !(extension > 0)) {
    return Array.isArray(points) ? points.map(p => Array.isArray(p) ? [p[0], p[1], p[2]] : p) : points;
  }
  const extended = points.map(p => [p[0], p[1], p[2]]);
  const start = extended[0];
  const next = extended[1];
  const sx = next[0] - start[0];
  const sy = next[1] - start[1];
  const sz = next[2] - start[2];
  const startLen = Math.hypot(sx, sy, sz);
  if (startLen > 1e-9) {
    const inv = extension / startLen;
    start[0] -= sx * inv;
    start[1] -= sy * inv;
    start[2] -= sz * inv;
  }

  const end = extended[extended.length - 1];
  const prev = extended[extended.length - 2];
  const ex = end[0] - prev[0];
  const ey = end[1] - prev[1];
  const ez = end[2] - prev[2];
  const endLen = Math.hypot(ex, ey, ez);
  if (endLen > 1e-9) {
    const inv = extension / endLen;
    end[0] += ex * inv;
    end[1] += ey * inv;
    end[2] += ez * inv;
  }

  return extended;
}

export class TubeFeature {
  static featureShortName = 'TU';
  static featureName = 'Tube';
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const { featureID, path, radius, innerRadius, resolution } = this.inputParams;
    const radiusValue = Number(radius);
    if (!(radiusValue > 0)) {
      throw new Error('Tube requires a positive radius.');
    }
    const inner = Number(innerRadius) || 0;
    if (inner < 0) {
      throw new Error('Inside radius cannot be negative.');
    }
    if (inner > 0 && inner >= radiusValue) {
      throw new Error('Inside radius must be smaller than the outer radius.');
    }
    const edges = Array.isArray(path) ? path.filter(Boolean) : (path ? [path] : []);
    if (!edges.length) {
      throw new Error('Tube requires at least one EDGE selection for the path.');
    }

    const edgeGroups = groupEdgesByConnectivity(edges);
    if (!edgeGroups.length) {
      throw new Error('Unable to build a connected path for the tube.');
    }

    const baseResolution = Math.max(8, Math.floor(Number(resolution) || 32));
    const outerSolids = [];
    const innerSolids = [];
    for (let i = 0; i < edgeGroups.length; i++) {
      const group = edgeGroups[i];
      const pathPoints = dedupePoints(combinePathPolylines(group));
      if (pathPoints.length < 2) {
        throw new Error('Unable to build a connected path for the tube.');
      }

      const isClosedLoop = pathPoints.length > 2 && (() => {
        const first = pathPoints[0];
        const last = pathPoints[pathPoints.length - 1];
        const dx = first[0] - last[0];
        const dy = first[1] - last[1];
        const dz = first[2] - last[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        const pathScale = Math.max(...pathPoints.map(p => Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])))) || 1;
        const tolerance = pathScale * 1e-6;
        return distSq <= tolerance * tolerance;
      })();

      const finalPoints = isClosedLoop ? pathPoints.slice(0, -1) : pathPoints;
      const tubeName = (() => {
        if (!featureID) return featureID;
        if (edgeGroups.length === 1) return featureID;

        // get the name of the first edge in the group if possible
        const firstEdge = group[0];
        if (firstEdge) {
          const edgeName = firstEdge.name || firstEdge.id;
          if (edgeName) {
            return `${featureID}_${edgeName}`;
          }
        }

        return `${featureID}_${i + 1}`;
      })();

      const outerTube = new BREP.Tube({
        points: finalPoints,
        radius: radiusValue,
        innerRadius: 0,
        resolution: baseResolution,
        closed: isClosedLoop,
        name: tubeName,
      });
      outerSolids.push(outerTube);

      if (inner > 0) {
        const innerName = tubeName ? `${tubeName}_Inner` : null;
        const baseScale = Math.max(radiusValue, inner);
        const capExtension = (!isClosedLoop && baseScale > 0)
          ? Math.max(baseScale * 5e-3, 1e-4)
          : 0;
        const innerPoints = (!isClosedLoop && capExtension > 0)
          ? extendPathEndpoints(finalPoints, capExtension)
          : finalPoints;
        const innerTube = new BREP.Tube({
          points: innerPoints,
          radius: inner,
          innerRadius: 0,
          resolution: baseResolution,
          closed: isClosedLoop,
          name: innerName,
        });
        innerSolids.push(innerTube);
      }
    }

    if (!outerSolids.length) {
      throw new Error('Unable to build a connected path for the tube.');
    }

    const attemptUnionSolids = (solids, label) => {
      if (!Array.isArray(solids) || solids.length === 0) return null;
      if (solids.length === 1) {
        if (label) {
          try { solids[0].name = label; } catch (_) { }
        }
        return solids[0];
      }
      console.log('Attempting union of solids:', solids);



      try {
        let result = solids[0];

        for (let idx = 1; idx < solids.length; idx++) {
          try {
            result = result.union(solids[idx]);
          } catch (err) {
            console.warn(`[TubeFeature] Union step failed at index ${idx}:`, err?.message || err);
            return null;
          }
        }
        if (label) {
          try { result.name = label; } catch (_) { }
        }
        return result;
      } catch (error) {
        console.warn('[TubeFeature] Union attempt failed:', error?.message || error);
        return null;
      }
    };

    const booleanParam = this.inputParams.boolean;
    const booleanOp = String(booleanParam?.operation || 'NONE').toUpperCase();
    const booleanTargets = Array.isArray(booleanParam?.targets) ? booleanParam.targets.filter(Boolean) : [];
    const shouldApplyBoolean = booleanOp !== 'NONE' && booleanTargets.length > 0;

    // Always attempt to union outer segments into one solid when possible
    const outerUnionLabel = featureID || outerSolids[0]?.name || 'TubeUnion';
    const outerUnion = (outerSolids.length > 1) ? attemptUnionSolids(outerSolids, outerUnionLabel) : (outerSolids[0] || null);

    // Always attempt to union inner segments into one cutter when inside radius is set
    const innerUnionLabel = featureID ? `${featureID}_InnerUnion` : (innerSolids[0]?.name || null);
    const innerUnion = (inner > 0 && innerSolids.length > 0)
      ? ((innerSolids.length > 1) ? attemptUnionSolids(innerSolids, innerUnionLabel) : innerSolids[0])
      : null;

    // Build the base (hollow) shell per required pipeline:
    // final = union(outer) minus union(inner)
    let baseSolids = [];
    if (inner > 0) {
      // Preferred path: single subtract of the two unions
      if (outerUnion && innerUnion) {
        try {
          baseSolids = [outerUnion.subtract(innerUnion)];
        } catch (e) {
          console.warn('[TubeFeature] Subtract of unioned inner from unioned outer failed; falling back:', e?.message || e);
        }
      }

      // Fallbacks if the preferred single subtract was not possible
      if (!baseSolids.length) {
        if (outerUnion && innerSolids.length > 0) {
          // Subtract each inner from the outer union
          let shell = outerUnion;
          for (const cutter of innerUnion ? [innerUnion] : innerSolids) {
            try { if (cutter) shell = shell.subtract(cutter); } catch (err) {
              console.warn('[TubeFeature] Fallback subtract (outerUnion - cutter) failed:', err?.message || err);
            }
          }
          baseSolids = [shell];
        } else if (!outerUnion && innerUnion && outerSolids.length > 0) {
          // Subtract inner union from each outer, then try to union the result
          const shells = [];
          for (const outer of outerSolids) {
            try { shells.push(outer.subtract(innerUnion)); } catch (err) {
              console.warn('[TubeFeature] Fallback subtract (outer - innerUnion) failed:', err?.message || err);
              shells.push(outer);
            }
          }
          const unifiedShell = attemptUnionSolids(shells, outerUnionLabel) || null;
          baseSolids = unifiedShell ? [unifiedShell] : shells.filter(Boolean);
        } else {
          // Last resort: pairwise subtract matching inners when available
          const shells = [];
          for (let i = 0; i < outerSolids.length; i++) {
            const outer = outerSolids[i];
            const cutter = innerSolids[i] || innerUnion || null;
            if (outer) {
              try {
                shells.push(cutter ? outer.subtract(cutter) : outer);
              } catch (err) {
                console.warn(`[TubeFeature] Pairwise subtract failed for segment ${i}:`, err?.message || err);
                shells.push(outer);
              }
            }
          }
          const unifiedShell = attemptUnionSolids(shells, outerUnionLabel) || null;
          baseSolids = unifiedShell ? [unifiedShell] : shells.filter(Boolean);
        }
      }
    } else {
      // Solid tube (no inner). Prefer a unified outer shell if available
      baseSolids = outerUnion ? [outerUnion] : outerSolids.slice();
    }

    baseSolids = baseSolids.filter(Boolean);

    if (!baseSolids.length) {
      throw new Error('Tube generation failed to produce a valid solid.');
    }

    for (const solid of baseSolids) {
      if (!solid) continue;
      if (featureID) {
        try { solid.owningFeatureID = featureID; } catch (_) { }
        if (!solid.name) {
          try { solid.name = featureID; } catch (_) { }
        }
      }
      try { solid.visualize(); } catch (_) { }
    }

    if (shouldApplyBoolean) {
      const added = [];
      const removed = [];
      let booleanBases = baseSolids;
      if (booleanOp === 'UNION' && baseSolids.length > 1) {
        const unionLabel = featureID || baseSolids[0]?.name || 'TubeUnion';
        const unified = attemptUnionSolids(baseSolids, unionLabel);
        if (unified) {
          booleanBases = [unified];
          try { unified.owningFeatureID = featureID; } catch (_) { }
          try { unified.visualize(); } catch (_) { }
        }
      }
      for (const base of booleanBases) {
        const effects = await BREP.applyBooleanOperation(partHistory || {}, base, booleanParam, featureID);
        if (effects?.added?.length) {
          for (const solid of effects.added) {
            if (solid) added.push(solid);
          }
        }
        if (effects?.removed?.length) {
          for (const solid of effects.removed) {
            if (solid) removed.push(solid);
          }
        }
      }
      return { added, removed };
    }

    return { added: baseSolids, removed: [] };
  }
}
