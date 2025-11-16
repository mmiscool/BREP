// Solid.fillet implementation: consolidates fillet logic so features call this API.
// Usage: solid.fillet({ radius, edgeNames, featureID, direction, inflate, debug, snapSeam })

import { getDistanceTolerance } from "../fillets/inset.js";

/**
 * Apply fillets to this Solid and return a new Solid with the result.
 * Accepts either `edgeNames` (preferred) or explicit `edges` objects.
 *
 * @param {Object} opts
 * @param {number} opts.radius Required fillet radius (> 0)
 * @param {string[]} [opts.edgeNames] Optional edge names to fillet (resolved from this Solid's children)
 * @param {any[]} [opts.edges] Optional pre-resolved Edge objects (must belong to this Solid)
 * @param {string} [opts.direction] 'INSET' | 'OUTSET' (default 'INSET')
 * @param {number} [opts.inflate] Inflation for cutting tube (default 0.1)
 * @param {boolean} [opts.debug] Enable debug visuals in fillet builder
 * @param {boolean} [opts.snapSeam] Snap boolean seams to tangent polylines (INSET only, default true)
 * @param {string} [opts.featureID] For naming of intermediates and result
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
  const snapSeam = (opts.snapSeam === undefined) ? true : !!opts.snapSeam;
  const featureID = opts.featureID || 'FILLET';

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
    // Nothing to do — return an unchanged clone so caller can replace scene node safely
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
    const res = filletSolid({ edgeToFillet: e, radius, sideMode: dir, inflate, debug, name }) || {};
    
    // Handle debug solids even on failure
    if (debug || !res.finalSolid) {
      try { if (res.tube) debugAdded.push(res.tube); } catch { }
      try { if (res.wedge) debugAdded.push(res.wedge); } catch { }
      
      // If there was an error, log it and add debug info
      if (res.error) {
        console.warn(`Fillet failed for edge ${e?.name || idx}: ${res.error}`);
      }
    }
    
    if (!res.finalSolid) continue;
    
    const tangents = [];
    // Use actual tangent polylines returned from builder for accurate snapping and overlays
    try {
      const tA = Array.isArray(res.tangentA) ? res.tangentA : [];
      const tB = Array.isArray(res.tangentB) ? res.tangentB : [];
      if (tA.length >= 2) tangents.push({ points: tA, radius, label: `${name}_TANGENT_A`, owner: (e?.name || '') });
      if (tB.length >= 2) tangents.push({ points: tB, radius, label: `${name}_TANGENT_B`, owner: (e?.name || '') });
    } catch { }
    filletEntries.push({ filletSolid: res.finalSolid, tangents });
    if (debug) {
      try { if (res.tube) debugAdded.push(res.tube); } catch { }
      try { if (res.wedge) debugAdded.push(res.wedge); } catch { }
    }
  }
  if (filletEntries.length === 0) {
    const c = this.clone();
    try { c.name = this.name; } catch { }
    return c;
  }

  // Apply to base solid (union for OUTSET, subtract for INSET)
  let result = this;
  for (const { filletSolid } of filletEntries) {
    result = (dir === 'OUTSET') ? result.union(filletSolid) : result.subtract(filletSolid);
    // Name the result for scene grouping/debugging
    try { result.name = this.name; } catch { }
  }


  // Optional seam snapping (INSET only) using provided tangents
  if (dir === 'INSET' && snapSeam) {
    try {
      const targets = [];
      for (const { tangents } of filletEntries) {
        for (const t of tangents) {
          targets.push(t);
        }
      }
      snapBooleanEdgesToTangents(result, targets);
    } catch { /* best effort */ }
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


  // await result._manifoldize();
  // await result._weldVerticesByEpsilon(0.07);
  // await result._manifoldize();
  // await result._weldVerticesByEpsilon(.1);
  // await result._manifoldize();
  // await result.simplify(1, true);
  // await result._manifoldize();
  // await result.visualize();


  return result;
}

// Internal helper: ported from FilletFeature._snapBooleanEdgesToTangents to be reusable here.
function snapBooleanEdgesToTangents(solidResult, targets = []) {
  if (!solidResult || !Array.isArray(targets) || targets.length === 0) return;

  const toArrayPoint = (p) => Array.isArray(p) ? [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0] : [Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0];
  const tangentPolys = targets.map(t => ({
    pts: (Array.isArray(t.points) ? t.points : []).map(toArrayPoint),
    r: Number.isFinite(t.radius) ? Math.abs(t.radius) : undefined,
    label: t.label || 'TANGENT',
    owner: t.owner || ''
  })).filter(t => t.pts.length >= 2);
  if (!tangentPolys.length) return;

  const boundary = solidResult.getBoundaryEdgePolylines() || [];
  if (!boundary.length) return;

  const polyLength = (arr) => {
    let L = 0; for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], b = arr[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      L += Math.hypot(dx, dy, dz);
    } return L;
  };
  const closestOnPolylineWithParam = (p, poly) => {
    let best = null, bestD2 = Infinity, bestIdx = 1, bestT = 0;
    let cum = [0];
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz);
      cum.push(cum[cum.length - 1] + len);
    }
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      const ax = a[0], ay = a[1], az = a[2];
      const bx = b[0], by = b[1], bz = b[2];
      const px = p[0], py = p[1], pz = p[2];
      const vx = bx - ax, vy = by - ay, vz = bz - az;
      const wx = px - ax, wy = py - ay, wz = pz - az;
      const vv = vx * vx + vy * vy + vz * vz;
      let t = vv > 0 ? (wx * vx + wy * vy + wz * vz) / vv : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = ax + vx * t, qy = ay + vy * t, qz = az + vz * t;
      const dx = qx - px, dy = qy - py, dz = qz - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = [qx, qy, qz]; bestIdx = i; bestT = t; }
    }
    const totalLen = cum[cum.length - 1] || 0;
    const segLen = (bestIdx >= 1 ? (cum[bestIdx] - cum[bestIdx - 1]) : 0);
    const arcAt = (bestIdx >= 1 ? (cum[bestIdx - 1] + segLen * bestT) : 0);
    return { q: best || poly[0].slice(), arcAt, totalLen, segIndex: bestIdx, t: bestT };
  };
  const closestOnPolyline = (p, poly) => closestOnPolylineWithParam(p, poly).q;
  const bboxOf = (pts) => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of pts) {
      const x = p[0], y = p[1], z = p[2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
  };
  const aabbIntersects = (A, B) => !(A.minX > B.maxX || A.maxX < B.minX || A.minY > B.maxY || A.maxY < B.minY || A.minZ > B.maxZ || A.maxZ < B.minZ);
  const expandAABB = (B, h) => ({ minX: B.minX - h, minY: B.minY - h, minZ: B.minZ - h, maxX: B.maxX + h, maxY: B.maxY + h, maxZ: B.maxZ + h });
  const aabbDiag = (B) => Math.hypot(B.maxX - B.minX, B.maxY - B.minY, B.maxZ - B.minZ);

  const vp = solidResult._vertProperties;
  if (!Array.isArray(vp) || vp.length < 3) return;
  const ownerToTangents = new Map();
  for (const t of tangentPolys) {
    const key = String(t.owner || '');
    if (!ownerToTangents.has(key)) ownerToTangents.set(key, []);
    ownerToTangents.get(key).push(t);
  }

  for (const [owner, tangs] of ownerToTangents.entries()) {
    const allTPts = [];
    let groupR = 0, rCount = 0;
    for (const t of tangs) {
      if (Array.isArray(t.pts)) for (const p of t.pts) allTPts.push(p);
      if (Number.isFinite(t.r)) { groupR += Math.abs(t.r); rCount++; }
    }
    const groupBBox = bboxOf(allTPts);
    const diag = aabbDiag(groupBBox);
    const rEst = rCount ? (groupR / rCount) : (diag > 0 ? diag * 0.2 : 1);
    const halo = Math.max(rEst * 2, diag * 0.15, 1e-6);
    const expanded = expandAABB(groupBBox, halo);

    // Filter candidate boundaries
    const candidates = (solidResult.getBoundaryEdgePolylines() || []).map((b, idx) => ({
      idx,
      poly: b,
      faceA: String(b.faceA || ''),
      faceB: String(b.faceB || ''),
      bbox: bboxOf(b.positions || []),
    })).filter(e => aabbIntersects(expanded, e.bbox) || (owner && (e.faceA.includes(owner) || e.faceB.includes(owner))));

    const maxSamples = 10;
    const sampleIndices = (arrLen) => {
      if (arrLen <= maxSamples) return Array.from({ length: arrLen }, (_, i) => i);
      const out = new Set([0, arrLen - 1]);
      for (let k = 1; k < maxSamples - 1; k++) out.add(Math.floor((k * (arrLen - 1)) / (maxSamples - 1)));
      return Array.from(out).sort((a, b) => a - b);
    };

    for (const c of candidates) {
      const pts = c.poly.positions || [];
      if (!pts.length) continue;
      let minApprox = Infinity;
      const samples = sampleIndices(pts.length);
      for (const si of samples) {
        const p = pts[si];
        for (const t of tangs) {
          const q = closestOnPolyline(p, t.pts);
          const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
          const d = Math.hypot(dx, dy, dz);
          if (d < minApprox) minApprox = d;
        }
        if (minApprox <= rEst * 2.5) break;
      }
      if (!(minApprox <= rEst * 2.5 || aabbIntersects(expanded, c.bbox))) continue;

      // Choose nearest tangent by score
      let bestT = tangs[0];
      let bestScore = Infinity;
      for (const t of tangs) {
        const s = polyScore(c.poly, t.pts, t.r);
        if (s < bestScore) { bestScore = s; bestT = t; }
      }

      const idxChain = c.poly.indices || [];
      const moved = new Set();
      for (const vi of idxChain) {
        if (!Number.isFinite(vi) || vi < 0) continue;
        if (moved.has(vi)) continue; moved.add(vi);
        const px = vp[vi * 3 + 0], py = vp[vi * 3 + 1], pz = vp[vi * 3 + 2];
        const { q, arcAt, totalLen } = closestOnPolylineWithParam([px, py, pz], bestT.pts);
        const dx = q[0] - px, dy = q[1] - py, dz = q[2] - pz;
        const d = Math.hypot(dx, dy, dz);
        const threshold = (Number.isFinite(bestT.r) && bestT.r > 0) ? (1.1 * Math.abs(bestT.r)) : 0;
        const openTangent = !(bestT.pts && bestT.pts.length >= 3 && (bestT.pts[0][0] === bestT.pts[bestT.pts.length - 1][0] && bestT.pts[0][1] === bestT.pts[bestT.pts.length - 1][1] && bestT.pts[0][2] === bestT.pts[bestT.pts.length - 1][2]));
        const capWindow = (Number.isFinite(bestT.r) && bestT.r > 0) ? (1.0 * Math.abs(bestT.r)) : (0.05 * (totalLen || 0));
        const nearStart = (totalLen > 0) && (arcAt <= capWindow);
        const nearEnd = (totalLen > 0) && ((totalLen - arcAt) <= capWindow);
        const isEndpoint = (vi === idxChain[0] || vi === idxChain[idxChain.length - 1]);
        if (threshold > 0 && d <= threshold && !(openTangent && (nearStart || nearEnd) && !isEndpoint)) {
          vp[vi * 3 + 0] = q[0]; vp[vi * 3 + 1] = q[1]; vp[vi * 3 + 2] = q[2];
        }
      }
    }
  }

  // Cleanup small degenerates after snapping
  try { solidResult.collapseTinyTriangles(); } catch { }
  solidResult._faceIndex = null;

  function polyScore(boundaryPoly, tangentPoly, radius) {
    const pts = boundaryPoly?.positions || [];
    if (!pts.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = closestOnPolyline(p, tangentPoly);
      const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
      sum += Math.hypot(dx, dy, dz);
    }
    const avg = sum / pts.length;
    const Lb = polyLength(pts);
    const Lt = polyLength(tangentPoly);
    const relLen = Math.abs(Lb - Lt) / Math.max(Lt, 1e-9);
    const tol = getDistanceTolerance(Number.isFinite(radius) ? radius : Lt || 1);
    return avg + 0.2 * relLen * Math.max(tol, 1e-6);
  }
}
