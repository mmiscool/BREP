// applyBooleanOperation.js
// Helper to apply a boolean operation between a newly created base solid and
// a list of scene solids referenced by name via the boolean param widget.

import * as THREE from 'three';
import { Manifold, ManifoldMesh } from "./SolidShared.js";
import { Solid } from "./BetterSolid.js";
import { MeshRepairer } from "./MeshRepairer.js";

const __booleanDebugConfig = (() => {
  try {
    if (typeof process === 'undefined' || !process?.env) return null;
    const raw = process.env.DEBUG_BOOLEAN;
    if (!raw) return null;
    const tokens = String(raw)
      .split(/[,;|]+|\s+/g)
      .map(t => t.trim())
      .filter(Boolean);
    if (!tokens.length) return null;
    const cfg = {
      all: false,
      ids: new Set(),
      names: [],
      ops: new Set(),
    };
    for (const tokenRaw of tokens) {
      const token = tokenRaw.trim();
      if (!token) continue;
      const upper = token.toUpperCase();
      if (upper === '*' || upper === 'ALL' || upper === 'TRUE' || upper === '1') {
        cfg.all = true;
        continue;
      }
      if (upper.startsWith('NAME:')) {
        const idx = token.indexOf(':');
        const namePart = idx >= 0 ? token.slice(idx + 1).trim().toLowerCase() : '';
        if (namePart) cfg.names.push(namePart);
        continue;
      }
      if (upper.startsWith('OP:')) {
        const opPart = upper.slice(3).trim();
        if (opPart) cfg.ops.add(opPart);
        continue;
      }
      cfg.ids.add(token);
    }
    return cfg;
  } catch {
    return null;
  }
})();

function __booleanDebugSummarizeSolid(solid) {
  if (!solid || typeof solid !== 'object') return { name: '(null)' };
  const summary = {
    name: solid.name || solid.owningFeatureID || solid.id || solid.uuid || '(unnamed)',
  };
  if (solid.owningFeatureID && solid.owningFeatureID !== summary.name) {
    summary.owningFeatureID = solid.owningFeatureID;
  }
  try {
    const vp = solid._vertProperties;
    if (Array.isArray(vp)) summary.vertexCount = Math.floor(vp.length / 3);
  } catch { }
  try {
    const tris = solid._triVerts || solid._triangles;
    if (Array.isArray(tris)) summary.triangleCount = Math.floor(tris.length / 3);
  } catch { }
  return summary;
}

function __booleanDebugMatch(featureID, op, baseSolid, tools) {
  const cfg = __booleanDebugConfig;
  if (!cfg) return false;
  if (cfg.all) return true;

  const ids = cfg.ids;
  const names = cfg.names;
  const ops = cfg.ops;

  const normalizeName = (obj) => {
    if (!obj || typeof obj !== 'object') return '';
    const raw = obj.name || obj.owningFeatureID || obj.id || obj.uuid || '';
    return String(raw || '').trim();
  };

  const matchesNamePattern = (value) => {
    if (!names || names.length === 0) return false;
    const lower = String(value || '').toLowerCase();
    if (!lower) return false;
    for (const pat of names) {
      if (lower.includes(pat)) return true;
    }
    return false;
  };

  if (featureID != null && ids.has(String(featureID))) return true;

  const opUpper = String(op || '').toUpperCase();
  if (opUpper && ops.has(opUpper)) return true;

  const baseName = normalizeName(baseSolid);
  if (baseName) {
    if (ids.has(baseName)) return true;
    if (matchesNamePattern(baseName)) return true;
  }

  for (const tool of tools || []) {
    const toolName = normalizeName(tool);
    if (!toolName) continue;
    if (ids.has(toolName)) return true;
    if (matchesNamePattern(toolName)) return true;
  }

  return false;
}

function __booleanDebugLogger(featureID, op, baseSolid, tools) {
  const shouldLog = __booleanDebugMatch(featureID, op, baseSolid, tools);
  if (!shouldLog) return () => {};
  const tag = (featureID != null) ? `[BooleanDebug ${featureID}]` : '[BooleanDebug]';
  return (...args) => {
    try { console.log(tag, ...args); } catch { }
  };
}

function __booleanSolidToGeometry(solid) {
  try {
    if (!solid || typeof solid !== 'object') return null;
    const vp = solid._vertProperties;
    const tv = solid._triVerts;
    const ids = solid._triIDs;
    if (!Array.isArray(vp) || vp.length < 9) return null;
    if (!Array.isArray(tv) || tv.length < 3) return null;
    if (!Array.isArray(ids) || ids.length !== (tv.length / 3)) return null;

    const vertArray = Float32Array.from(vp);
    const triArray = Uint32Array.from(tv);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(vertArray, 3));
    geom.setIndex(new THREE.BufferAttribute(triArray, 1));

    let minX = +Infinity, minY = +Infinity, minZ = +Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertArray.length; i += 3) {
      const x = vertArray[i];
      const y = vertArray[i + 1];
      const z = vertArray[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    const scale = Math.max(Math.hypot(dx, dy, dz), Math.abs(dx), Math.abs(dy), Math.abs(dz), 1);

    const idToFaceName = solid._idToFaceName instanceof Map ? solid._idToFaceName : new Map();
    const solidLabel = solid.name || solid.owningFeatureID || 'SOLID';
    const triangles = [];

    for (let t = 0; t < triArray.length; t += 3) {
      const triIndex = t / 3;
      const i0 = triArray[t];
      const i1 = triArray[t + 1];
      const i2 = triArray[t + 2];
      const ax = vertArray[i0 * 3], ay = vertArray[i0 * 3 + 1], az = vertArray[i0 * 3 + 2];
      const bx = vertArray[i1 * 3], by = vertArray[i1 * 3 + 1], bz = vertArray[i1 * 3 + 2];
      const cx = vertArray[i2 * 3], cy = vertArray[i2 * 3 + 1], cz = vertArray[i2 * 3 + 2];

      const centerX = (ax + bx + cx) / 3;
      const centerY = (ay + by + cy) / 3;
      const centerZ = (az + bz + cz) / 3;

      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) {
        nx /= len; ny /= len; nz /= len;
      } else {
        nx = 0; ny = 0; nz = 1;
      }

      const rawName = idToFaceName.get(ids[triIndex]);
      const faceName = rawName ? String(rawName) : `${solidLabel}_FACE_${ids[triIndex] ?? triIndex}`;
      triangles.push({
        center: [centerX, centerY, centerZ],
        normal: [nx, ny, nz],
        faceName,
      });
    }

    return {
      geometry: geom,
      triangles,
      scale,
      fallbackPrefix: `${solidLabel}_REPAIR`,
    };
  } catch {
    return null;
  }
}

function __booleanAssignFaceData(geometry, sourceMeta, debugLog) {
  try {
    if (!geometry) return null;
    const indexAttr = geometry.getIndex();
    const posAttr = geometry.getAttribute('position');
    if (!indexAttr || !posAttr) return null;
    const idx = indexAttr.array;
    const pos = posAttr.array;
    if (!idx || !pos) return null;
    const triCount = idx.length / 3;
    if (!(triCount > 0)) return null;

    const triangles = Array.isArray(sourceMeta?.triangles) ? sourceMeta.triangles : [];
    if (!triangles.length) return null;

    const scale = Math.max(1, Number(sourceMeta?.scale) || 1);
    const distLimit = Math.max(1e-9, Math.pow(scale * 5e-3, 2));
    const scoreLimit = Math.max(distLimit * 16, distLimit * 2, 1e-6);
    const fallbackPrefix = sourceMeta?.fallbackPrefix || 'REPAIRED';

    const faceIDs = new Uint32Array(triCount);
    const nameToID = new Map();
    const idToName = new Map();
    let nextID = 1;
    let fallbackCount = 0;

    for (let t = 0; t < triCount; t++) {
      const i0 = idx[t * 3];
      const i1 = idx[t * 3 + 1];
      const i2 = idx[t * 3 + 2];
      const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
      const bx = pos[i1 * 3], by = pos[i1 * 3 + 1], bz = pos[i1 * 3 + 2];
      const cx = pos[i2 * 3], cy = pos[i2 * 3 + 1], cz = pos[i2 * 3 + 2];

      const centerX = (ax + bx + cx) / 3;
      const centerY = (ay + by + cy) / 3;
      const centerZ = (az + bz + cz) / 3;

      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 0; nz = 1; }

      let bestName = null;
      let bestScore = Infinity;

      for (const tri of triangles) {
        const dx = centerX - tri.center[0];
        const dy = centerY - tri.center[1];
        const dz = centerZ - tri.center[2];
        const dist2 = dx * dx + dy * dy + dz * dz;

        const tn = tri.normal;
        const dot = Math.max(0, Math.min(1, Math.abs(nx * tn[0] + ny * tn[1] + nz * tn[2])));
        const normalPenalty = 1 - dot;

        const score = dist2 + normalPenalty * distLimit;
        if (score < bestScore) {
          bestScore = score;
          bestName = tri.faceName;
        }
      }

      let faceName = bestName;
      if (!faceName || !(bestScore <= scoreLimit)) {
        fallbackCount += 1;
        faceName = `${fallbackPrefix}_${fallbackCount}`;
      }

      let id = nameToID.get(faceName);
      if (!id) {
        id = nextID;
        nextID += 1;
        nameToID.set(faceName, id);
        idToName.set(id, faceName);
      }
      faceIDs[t] = id;
    }

    return { faceIDs, idToFaceName: idToName };
  } catch (err) {
    debugLog?.('Face reassignment failed', { message: err?.message || err });
    return null;
  }
}

function __booleanMakeSolidFromGeometry(geometry, faceIDs, idToFaceName, debugLog) {
  try {
    if (!geometry || !faceIDs || !idToFaceName) return null;
    const indexAttr = geometry.getIndex();
    const posAttr = geometry.getAttribute('position');
    if (!indexAttr || !posAttr) return null;
    const triArray = Uint32Array.from(indexAttr.array);
    const posArray = Float32Array.from(posAttr.array);
    const faceIDArray = faceIDs instanceof Uint32Array ? faceIDs : Uint32Array.from(faceIDs);
    const meshGL = new ManifoldMesh({
      numProp: 3,
      vertProperties: posArray,
      triVerts: triArray,
      faceID: faceIDArray,
    });
    meshGL.merge();
    const manifoldObj = new Manifold(meshGL);
    return Solid._fromManifold(manifoldObj, idToFaceName);
  } catch (err) {
    debugLog?.('Solid rebuild failed', { message: err?.message || err });
    return null;
  }
}

function __booleanAttemptRepairSolid(solid, eps, debugLog) {
  const source = __booleanSolidToGeometry(solid);
  if (!source) return null;

  const baseGeom = source.geometry;
  const repairer = new MeshRepairer();
  const baseWeld = Math.max(1e-5, Math.abs(eps || 0) * 10);
  const attemptScales = [1, 4, 16];

  try {
    for (const scale of attemptScales) {
      const weld = baseWeld * scale;
      const line = Math.max(1e-5, weld);
      const grid = Math.max(1e-4, weld * 2);

      const workingGeom = baseGeom.clone();
      let repairedGeom;
      try {
        repairedGeom = repairer.repairAll(workingGeom, { weldEps: weld, lineEps: line, gridCell: grid }) || workingGeom;
      } catch (err) {
        debugLog?.('Repair attempt failed', {
          attemptScale: scale,
          message: err?.message || err,
        });
        try { workingGeom.dispose(); } catch { }
        continue;
      }

      const faceData = __booleanAssignFaceData(repairedGeom, source, debugLog);
      if (!faceData) {
        try { repairedGeom.dispose(); } catch { }
        continue;
      }

      const rebuilt = __booleanMakeSolidFromGeometry(repairedGeom, faceData.faceIDs, faceData.idToFaceName, debugLog);
      try { repairedGeom.dispose(); } catch { }
      if (rebuilt) {
        try {
          rebuilt.name = solid.name || rebuilt.name;
          rebuilt.owningFeatureID = solid.owningFeatureID || rebuilt.owningFeatureID;
        } catch { }
        return rebuilt;
      }
    }
  } finally {
    try { baseGeom.dispose(); } catch { }
  }

  return null;
}

function __booleanMeshMergeUnion(baseSolid, toolSolid, eps, debugLog) {
  const srcA = __booleanSolidToGeometry(baseSolid);
  const srcB = __booleanSolidToGeometry(toolSolid);
  if (!srcA || !srcB) {
    try { srcA?.geometry?.dispose?.(); } catch { }
    try { srcB?.geometry?.dispose?.(); } catch { }
    return null;
  }

  const geomA = srcA.geometry;
  const geomB = srcB.geometry;

  const posA = geomA.getAttribute('position')?.array;
  const posB = geomB.getAttribute('position')?.array;
  const idxA = geomA.getIndex()?.array;
  const idxB = geomB.getIndex()?.array;
  if (!posA || !posB || !idxA || !idxB) {
    try { geomA.dispose(); } catch { }
    try { geomB.dispose(); } catch { }
    return null;
  }

  const mergedPosBase = new Float32Array(posA.length + posB.length);
  mergedPosBase.set(posA, 0);
  mergedPosBase.set(posB, posA.length);

  const mergedIdxBase = new Uint32Array(idxA.length + idxB.length);
  mergedIdxBase.set(idxA, 0);
  const offset = (posA.length / 3) >>> 0;
  for (let i = 0; i < idxB.length; i++) {
    mergedIdxBase[idxA.length + i] = idxB[i] + offset;
  }

  try { geomA.dispose(); } catch { }
  try { geomB.dispose(); } catch { }

  const sourceMeta = {
    triangles: [...srcA.triangles, ...srcB.triangles],
    scale: Math.max(srcA.scale || 1, srcB.scale || 1),
    fallbackPrefix: `${baseSolid?.name || toolSolid?.name || 'UNION'}_REPAIR`,
  };

  const repairer = new MeshRepairer();
  const baseWeld = Math.max(1e-5, Math.abs(eps || 0) * 10);
  const attemptScales = [1, 4, 16];

  const buildGeometry = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mergedPosBase.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(mergedIdxBase.slice(), 1));
    return g;
  };

  for (const scale of attemptScales) {
    const weld = baseWeld * scale;
    const line = Math.max(1e-5, weld);
    const grid = Math.max(1e-4, weld * 2);

    const workingGeom = buildGeometry();
    let repairedGeom;
    try {
      repairedGeom = repairer.repairAll(workingGeom, { weldEps: weld, lineEps: line, gridCell: grid }) || workingGeom;
    } catch (err) {
      debugLog?.('Mesh-merge repair attempt failed', {
        attemptScale: scale,
        message: err?.message || err,
      });
      try { workingGeom.dispose(); } catch { }
      continue;
    }

    const faceData = __booleanAssignFaceData(repairedGeom, sourceMeta, debugLog);
    if (!faceData) {
      try { repairedGeom.dispose(); } catch { }
      continue;
    }

    const rebuilt = __booleanMakeSolidFromGeometry(repairedGeom, faceData.faceIDs, faceData.idToFaceName, debugLog);
    try { repairedGeom.dispose(); } catch { }
    if (rebuilt) {
      try {
        rebuilt.name = baseSolid?.name || rebuilt.name;
        rebuilt.owningFeatureID = baseSolid?.owningFeatureID || rebuilt.owningFeatureID;
      } catch { }
      return rebuilt;
    }
  }

  return null;
}

export async function applyBooleanOperation(partHistory, baseSolid, booleanParam, featureID) {
  try {
    if (!booleanParam || typeof booleanParam !== 'object') return { added: [baseSolid], removed: [] };
    // Read canonical operation only
    const opRaw = booleanParam.operation;
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

    const debugLog = __booleanDebugLogger(featureID, op, baseSolid, tools);
    debugLog('Starting boolean', {
      featureID,
      operation: op,
      base: __booleanDebugSummarizeSolid(baseSolid),
      tools: tools.map(__booleanDebugSummarizeSolid),
      targetCount: tools.length,
    });

    // Apply selected boolean
    if (op === 'SUBTRACT') {
      // Inverted semantics for subtract: subtract the new baseSolid (tool)
      // FROM each selected target solid. Add robust fallbacks similar to UNION.
      const results = [];
      let idx = 0;
      // Local helpers (avoid depending on later declarations)
      const approxScaleLocal = (solid) => {
        try {
          const vp = solid && solid._vertProperties;
          if (!Array.isArray(vp) || vp.length < 3) return 1;
          let minX = +Infinity, minY = +Infinity, minZ = +Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          for (let i = 0; i < vp.length; i += 3) {
            const x = vp[i], y = vp[i + 1], z = vp[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          }
          const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
          const diag = Math.hypot(dx, dy, dz);
          return (diag > 0) ? diag : Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz), 1);
        } catch { return 1; }
      };
      const preCleanLocal = (solid, eps) => {
        try { if (typeof solid.setEpsilon === 'function') solid.setEpsilon(eps); } catch {}
        try { if (typeof solid.fixTriangleWindingsByAdjacency === 'function') solid.fixTriangleWindingsByAdjacency(); } catch {}
      };

      const addResult = (solid, target) => {
        solid.visualize();
        const inheritedName = target?.name || target?.uuid || null;
        const finalName = inheritedName || (featureID ? `${featureID}_${++idx}` : solid.name || 'RESULT');
        try { solid.name = finalName; } catch (_) { }
        try {
          if (target?.owningFeatureID) solid.owningFeatureID = target.owningFeatureID;
        } catch (_) { }
        results.push(solid);
      };

      for (const target of tools) {
        let success = false;
        try {
          const out = target.subtract(baseSolid);
          addResult(out, target);
          success = true;
        } catch (e1) {
          debugLog('Primary subtract failed; attempting welded fallback', {
            message: e1?.message || e1,
            target: __booleanDebugSummarizeSolid(target),
            tool: __booleanDebugSummarizeSolid(baseSolid),
          });
        }
        if (success) continue;

        try {
          const a = typeof target.clone === 'function' ? target.clone() : target;
          const b = typeof baseSolid.clone === 'function' ? baseSolid.clone() : baseSolid;
          const scale = Math.max(1, approxScaleLocal(a));
          const eps = Math.max(1e-9, 1e-6 * scale);
          preCleanLocal(a, eps);
          preCleanLocal(b, eps);
          const out = a.subtract(b);
          addResult(out, target);
          success = true;
        } catch (e2) {
          debugLog('Welded subtract fallback failed; passing target through', {
            message: e2?.message || e2,
            target: __booleanDebugSummarizeSolid(target),
          });
        }
        if (!success) results.push(target);
      }
      // In SUBTRACT: removed = [all targets, baseSolid]
      const removed = [...tools];
      if (baseSolid) removed.push(baseSolid);
      debugLog('Subtract boolean finished', {
        results: results.map(__booleanDebugSummarizeSolid),
        removed: removed.map(__booleanDebugSummarizeSolid),
      });


      return { added: results.length ? results : [baseSolid], removed };
    }

    // Helper: approximate scale from authoring arrays (avoids manifold build)
    const approxScale = (solid) => {
      try {
        const vp = solid && solid._vertProperties;
        if (!Array.isArray(vp) || vp.length < 3) return 1;
        let minX = +Infinity, minY = +Infinity, minZ = +Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < vp.length; i += 3) {
          const x = vp[i], y = vp[i + 1], z = vp[i + 2];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
        const diag = Math.hypot(dx, dy, dz);
        return (diag > 0) ? diag : Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz), 1);
      } catch { return 1; }
    };

    // Helper: light pre-clean in authoring space (no manifold build)
    const preClean = (solid, eps) => {
      try { if (typeof solid.fixTriangleWindingsByAdjacency === 'function') solid.fixTriangleWindingsByAdjacency(); } catch {}
      try { if (typeof solid.setEpsilon === 'function') solid.setEpsilon(eps); } catch (e) {console.warn(e, solid)}
    };

    // UNION / INTERSECT: fold tools into the new baseSolid and replace base
    let result = baseSolid;
    for (const tool of tools) {
      if (op !== 'UNION' && op !== 'INTERSECT') {
        // Unknown op → pass through
        return { added: [baseSolid], removed: [] };
      }

      const scale = Math.max(1, approxScale(result));
      const eps = Math.max(1e-9, 1e-6 * scale);

      try {
        // Attempt the boolean directly; repair fallback handles welding if needed.
        result = (op === 'UNION') ? result.union(tool) : result.intersect(tool);
      } catch (e1) {
        debugLog('Primary union/intersect failed; attempting welded fallback', {
          message: e1?.message || e1,
          tool: __booleanDebugSummarizeSolid(tool),
          epsilon: eps,
        });
        let repaired = false;
        try {
          const repairedBase = __booleanAttemptRepairSolid(result, eps, debugLog);
          const repairedTool = __booleanAttemptRepairSolid(tool, eps, debugLog);
          if (repairedBase || repairedTool) {
            debugLog('Attempting repair fallback', {
              repairedBase: !!repairedBase,
              repairedTool: !!repairedTool,
            });
            const baseOperand = repairedBase || (typeof result.clone === 'function' ? result.clone() : result);
            const toolOperand = repairedTool || (typeof tool.clone === 'function' ? tool.clone() : tool);
            preClean(baseOperand, eps);
            preClean(toolOperand, eps);
            result = (op === 'UNION') ? baseOperand.union(toolOperand) : baseOperand.intersect(toolOperand);
            repaired = true;
          }
        } catch (repairErr) {
          debugLog('Repair fallback failed', { message: repairErr?.message || repairErr });
        }
        if (repaired) continue;
        // Fallback A: try on welded clones with tiny epsilon
        try {
          const a = typeof result.clone === 'function' ? result.clone() : result;
          const b = typeof tool.clone === 'function' ? tool.clone() : tool;
          preClean(a, eps);
          preClean(b, eps);
          result = (op === 'UNION') ? a.union(b) : a.intersect(b);
        } catch (e2) {
          let meshRecovered = false;
          if (op === 'UNION') {
            try {
              const merged = __booleanMeshMergeUnion(result, tool, eps, debugLog);
              if (merged) {
                debugLog('Mesh-merge fallback succeeded');
                const repairedMerged = __booleanAttemptRepairSolid(merged, eps, debugLog) || merged;
                if (repairedMerged !== merged) {
                  debugLog('Mesh-merge result repaired');
                }
                result = repairedMerged;
                meshRecovered = true;
              }
            } catch (meshErr) {
              debugLog('Mesh-merge fallback failed', { message: meshErr?.message || meshErr });
            }
          }
          if (meshRecovered) continue;
          throw e2;
        }
      }
    }
    result.visualize();
    debugLog('Boolean successful', {
      result: __booleanDebugSummarizeSolid(result),
      removedCount: tools.length + (baseSolid ? 1 : 0),
    });
    try { result.name = featureID || result.name || 'RESULT'; } catch (_) { }
    // UNION/INTERSECT: remove tools and the base solid (replace base with result)
    const removed = tools.slice();
    if (baseSolid) removed.push(baseSolid);
    return { added: [result], removed };
  } catch (err) {
    // On failure, pass through original to avoid breaking the pipeline
    console.warn('[applyBooleanOperation] failed:', err?.message || err);
    const debugLog = __booleanDebugLogger(featureID, booleanParam?.operation, baseSolid, []);
    debugLog('applyBooleanOperation threw; returning base solid', {
      error: err?.message || err,
      stack: err?.stack || null,
    });
    return { added: [baseSolid], removed: [] };
  }
}
