// applyBooleanOperation.js
// Helper to apply a boolean operation between a newly created base solid and
// a list of scene solids referenced by name via the boolean param widget.
//
// Usage:
//   const out = await applyBooleanOperation(partHistory, baseSolid, this.inputParams.boolean, this.inputParams.featureID);
//   return out; // array of solids to add to scene

import manifold from "./setupManifold.js";
import { Solid } from "./BetterSolid.js";

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

    // Optional: Offset sweep start/end cap faces on the tool when coplanar with target faces.
    // Applies only for SUBTRACT where `baseSolid` acts as the tool against scene targets.
    // Configuration:
    //  - booleanParam.offsetCoplanarCap: one of 'START_POS', 'START_NEG', 'END_POS', 'END_NEG',
    //    or shorthand 'start+', 'start-', 'end+', 'end-'. Case-insensitive.
    //  - booleanParam.offsetDistance: magnitude to use; falls back to booleanParam.biasDistance or 0.1
    if (op === 'SUBTRACT' && baseSolid && typeof baseSolid.getFaceNames === 'function') {
      try {
        const flag = String(booleanParam.offsetCoplanarCap || '').trim();
        const distMag = (() => {
          const d = Number(booleanParam.offsetDistance);
          if (Number.isFinite(d) && d !== 0) return Math.abs(d);
          const b = Number(booleanParam.biasDistance);
          if (Number.isFinite(b) && b !== 0) return Math.abs(b);
          return 0.1;
        })();

        const parseFlag = (str) => {
          const s = String(str || '').toUpperCase();
          const out = { start: 0, end: 0 };
          if (!s) return out;
          const tok = s.split(/[\s,;|]+/g).filter(Boolean);
          for (const t of tok) {
            const key = t.replace(/\s+/g, '');
            if (key === 'START+' || key === 'START_POS' || key === 'STARTPOS') out.start = +1;
            else if (key === 'START-' || key === 'START_NEG' || key === 'STARTNEG') out.start = -1;
            else if (key === 'END+' || key === 'END_POS' || key === 'ENDPOS') out.end = +1;
            else if (key === 'END-' || key === 'END_NEG' || key === 'ENDNEG') out.end = -1;
          }
          return out;
        };

        const want = parseFlag(flag);

        // Only proceed when the flag is present and we can find cap faces.
        if ((want.start || want.end) && distMag > 0) {
          // Precompute a size scale for tolerances from the tool's bounds
          const getSolidScale = (solid) => {
            try {
              const mesh = solid.getMesh();
              try {
                const vp = mesh?.vertProperties;
                if (!vp || !vp.length) return 1;
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
              } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
            } catch { return 1; }
          };

          const scale = getSolidScale(baseSolid);
          const NORM_EPS = 1e-4; // normal alignment tolerance
          const DIST_EPS = Math.max(1e-6, 1e-6 * scale);

          const getFacePlane = (solid, faceName) => {
            const tris = solid.getFace(faceName) || [];
            if (!tris.length) return null;
            // Use first triangle to define plane; face is planar for sweep caps.
            const t = tris[0];
            const a = t.p1, b = t.p2, c = t.p3;
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
            const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            let nx = uy * vz - uz * vy;
            let ny = uz * vx - ux * vz;
            let nz = ux * vy - uy * vx;
            const len = Math.hypot(nx, ny, nz);
            if (!(len > 0)) return null;
            nx /= len; ny /= len; nz /= len;
            const d = -(nx * a[0] + ny * a[1] + nz * a[2]);
            return { n: [nx, ny, nz], d };
          };

          const faceCentroid = (solid, faceName) => {
            const tris = solid.getFace(faceName) || [];
            if (!tris.length) return null;
            let sx = 0, sy = 0, sz = 0, cnt = 0;
            for (const t of tris) {
              const p = t.p1; sx += p[0]; sy += p[1]; sz += p[2]; cnt++;
              const q = t.p2; sx += q[0]; sy += q[1]; sz += q[2]; cnt++;
              const r = t.p3; sx += r[0]; sy += r[1]; sz += r[2]; cnt++;
            }
            if (!cnt) return null;
            return [sx / cnt, sy / cnt, sz / cnt];
          };

          const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
          const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
          const abs = Math.abs;

          const faceNames = Array.isArray(baseSolid.getFaceNames?.()) ? baseSolid.getFaceNames() : [];
          const startFaces = faceNames.filter(n => /_START$/i.test(String(n)));
          const endFaces = faceNames.filter(n => /_END$/i.test(String(n)));

          const checkCoplanarWithAnyTargetFace = (plane) => {
            for (const target of tools) {
              if (!target || typeof target.getFaceNames !== 'function') continue;
              const tNames = target.getFaceNames();
              for (const tn of tNames) {
                const tp = getFacePlane(target, tn);
                if (!tp) continue;
                const align = Math.abs(dot(plane.n, tp.n));
                if (align < (1 - NORM_EPS)) continue;
                // test a representative point from target face against tool plane
                const tTris = target.getFace(tn);
                if (!tTris || !tTris.length) continue;
                const q = tTris[0].p1;
                const dist = abs(dot(plane.n, q) + plane.d);
                if (dist <= DIST_EPS) return true;
              }
            }
            return false;
          };

          const maybeOffsetGroup = (groupFaces, sign) => {
            if (!groupFaces || !groupFaces.length || !sign) return;
            // Use the first face to determine plane and measure thickness to the opposite cap if available
            const fname = groupFaces[0];
            const plane = getFacePlane(baseSolid, fname);
            if (!plane) return;

            // Only act if coplanar with any target face
            const isCoplanar = checkCoplanarWithAnyTargetFace(plane);
            if (!isCoplanar) return;

            // Compute a conservative thickness using the paired cap if present
            // Pairing rule: find corresponding faces from the other group that share the same prefix before _START/_END
            const counterpartFaces = (/_START$/i.test(fname)) ? endFaces : startFaces;
            let thickness = Infinity;
            if (counterpartFaces && counterpartFaces.length) {
              // Try to match by common prefix up to the last underscore
              const basePrefix = String(fname).replace(/_START$/i, '').replace(/_END$/i, '');
              const cands = counterpartFaces.filter(n => String(n).startsWith(basePrefix));
              const centersThis = groupFaces.map(n => faceCentroid(baseSolid, n)).filter(Boolean);
              const centersOther = (cands.length ? cands : counterpartFaces).map(n => faceCentroid(baseSolid, n)).filter(Boolean);
              // Measure along this plane normal between nearest centroid pairs
              for (const ca of centersThis) {
                for (const cb of centersOther) {
                  const t = Math.abs(dot(plane.n, sub(cb, ca)));
                  if (t > 0 && t < thickness) thickness = t;
                }
              }
            }
            if (!Number.isFinite(thickness) || !(thickness > 0)) thickness = Infinity;

            // Clamp offset to at most 49% of thickness (if known) to avoid inverting or making paper-thin walls
            const maxAllowed = Number.isFinite(thickness) && thickness < Infinity ? 0.49 * thickness : distMag;
            const delta = Math.sign(sign) * Math.min(distMag, maxAllowed);
            if (!(delta !== 0)) return;

            // Apply to all faces in the group that are coplanar (safety double-check per face)
            for (const n of groupFaces) {
              const p = getFacePlane(baseSolid, n);
              if (!p) continue;
              if (!checkCoplanarWithAnyTargetFace(p)) continue;
              try { baseSolid.offsetFace(n, delta); } catch (_) { /* ignore */ }
            }
          };

          maybeOffsetGroup(startFaces, want.start);
          maybeOffsetGroup(endFaces, want.end);
        }
      } catch (_) { /* ignore offset errors; continue with CSG */ }
    }

    // Previously used to bias/nudge near-coplanar faces; no longer needed.

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

      const hullFromAuthoring = (solid) => {
        try {
          const { Manifold } = manifold;
          const vp = solid && solid._vertProperties;
          if (!Array.isArray(vp)) return null;
          const uniq = new Set();
          const pts = [];
          for (let i = 0; i + 2 < vp.length; i += 3) {
            const x = vp[i], y = vp[i + 1], z = vp[i + 2];
            const k = `${x},${y},${z}`;
            if (uniq.has(k)) continue;
            uniq.add(k);
            pts.push({ x, y, z });
          }
          if (pts.length < 4) return null;
          const hullM = Manifold.hull(pts);
          const name = (solid && solid.name) || 'FILLET_TOOL';
          const map = new Map([[0, name]]);
          return Solid._fromManifold(hullM, map);
        } catch { return null; }
      };

      // Helper: try to rebuild a Fillet tool for SUBTRACT to bias seams inward
      // on open edges and avoid coplanar contacts that lead to no-ops.
      const maybeRegenFilletSubtract = (tool, scaleHint) => {
        try {
          const isFillet = tool && Object.prototype.hasOwnProperty.call(tool, 'edgeToFillet') && typeof tool.generate === 'function';
          if (!isFillet) return false;
          const edge = tool.edgeToFillet || {};
          const isClosed = !!(edge.closedLoop || edge?.userData?.closedLoop);
          if (isClosed) return false; // issue is mainly open edges
          // Bias seams slightly inside the target faces and avoid face‑projected
          // strips which can leave surfaces exactly coplanar.
          tool.projectStripsOpenEdges = false;
          tool.forceSeamInset = true;
          // Use a conservative inset relative to scale to ensure overlap but
          // keep it visually negligible.
          const scl = Math.max(1, scaleHint || 1);
          tool.seamInsetScale = Math.max(tool.seamInsetScale || 0, 1e-3);
          // Keep inflate neutral for subtract; we only need inward bias.
          if (!Number.isFinite(tool.inflate)) tool.inflate = 0;
          tool.generate();
          preCleanLocal(tool, Math.max(1e-9, 1e-6 * scl));
          return true;
        } catch { return false; }
      };

      for (const target of tools) {
        try {
          let out = target.subtract(baseSolid);
          // If subtraction produced almost no change, try a more robust tool
          // configuration aimed at open-edge INSET fillets.
          try {
            const beforeV = target.volume();
            const afterV = out.volume();
            const scale = Math.max(1, approxScaleLocal(target));
            const tol = Math.max(1e-9, 1e-6 * beforeV + 1e-9 * (scale * scale * scale));
            if (Math.abs(afterV - beforeV) <= tol) {
              const changed = maybeRegenFilletSubtract(baseSolid, scale);
              if (changed) {
                const a = typeof target.clone === 'function' ? target.clone() : target;
                preCleanLocal(a, Math.max(1e-9, 1e-6 * scale));
                out = a.subtract(baseSolid);
              }
            }
          } catch (_) { /* volume probes are best-effort */ }
          out.visualize();
          try { out.name = (featureID ? `${featureID}_${++idx}` : out.name || 'RESULT'); } catch (_) { }
          results.push(out);
          continue;
        } catch (e1) {
          // Fallback A: try on welded clones with tiny epsilon
          debugLog('Primary subtract failed; attempting welded fallback', {
            message: e1?.message || e1,
            target: __booleanDebugSummarizeSolid(target),
            tool: __booleanDebugSummarizeSolid(baseSolid),
          });
          try {
            const a = typeof target.clone === 'function' ? target.clone() : target;
            const b = typeof baseSolid.clone === 'function' ? baseSolid.clone() : baseSolid;
            const scale = Math.max(1, approxScaleLocal(a));
            const eps = Math.max(1e-9, 1e-6 * scale);
            preCleanLocal(a, eps);
            preCleanLocal(b, eps);
            const out = a.subtract(b);
            out.visualize();
            try { out.name = (featureID ? `${featureID}_${++idx}` : out.name || 'RESULT'); } catch (_) { }
            results.push(out);
            continue;
          } catch (e2) {
            // Fallback B1: tweak Fillet tool for open-edge subtract and retry
            try {
              debugLog('Welded subtract fallback failed; attempting fillet regenerate fallback', {
                message: e2?.message || e2,
              });
              const scale = Math.max(1, approxScaleLocal(target));
              const changed = maybeRegenFilletSubtract(baseSolid, scale);
              if (changed) {
                const a = typeof target.clone === 'function' ? target.clone() : target;
                preCleanLocal(a, Math.max(1e-9, 1e-6 * scale));
                const out = a.subtract(baseSolid);
                out.visualize();
                try { out.name = (featureID ? `${featureID}_${++idx}` : out.name || 'RESULT'); } catch (_) { }
                results.push(out);
                continue;
              }
            } catch (_) {}
            // Fallback B2: attempt a convex hull of the tool's authored points
            try {
              debugLog('Fillet regenerate fallback failed; attempting hull fallback');
              const hull = hullFromAuthoring(baseSolid);
              if (hull) {
                const out = target.subtract(hull);
                out.visualize();
                try { out.name = (featureID ? `${featureID}_${++idx}` : out.name || 'RESULT'); } catch (_) { }
                results.push(out);
                continue;
              }
            } catch (_) {}
            // Give up on this target; add it unchanged so pipeline continues
            try { console.warn('[applyBooleanOperation] SUBTRACT failed; passing through target unchanged'); } catch {}
            debugLog('All subtract fallbacks failed; passing through target', {
              target: __booleanDebugSummarizeSolid(target),
            });
            results.push(target);
          }
        }
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
      try { if (typeof solid.setEpsilon === 'function') solid.setEpsilon(eps); } catch {}
      try { if (typeof solid.fixTriangleWindingsByAdjacency === 'function') solid.fixTriangleWindingsByAdjacency(); } catch {}
    };

    // Helper: if tool looks like a FilletSolid built on an open edge with
    // face-projected side strips, rebuild it without that option and force a
    // small seam inset for robustness.
    const maybeRegenerateFilletTool = (tool, opKind, scaleHint) => {
      try {
        const isFillet = tool && Object.prototype.hasOwnProperty.call(tool, 'edgeToFillet') && typeof tool.generate === 'function';
        if (!isFillet) return false;
        const edge = tool.edgeToFillet || {};
        const isClosed = !!(edge.closedLoop || edge?.userData?.closedLoop);
        if (isClosed) return false; // issue primarily seen on open edges
        if (!tool.projectStripsOpenEdges) return false; // nothing to change

        // Tweak options and rebuild
        tool.projectStripsOpenEdges = false; // avoid face-projected side strips on open edges
        tool.forceSeamInset = true;          // ensure slight inset to prevent coplanar overlap
        // Nudge outward slightly for UNION so the tool clearly dominates at seam
        if (String(opKind) === 'UNION') {
          const mag = Math.max(1e-9, 1e-6 * (scaleHint || 1));
          if (!Number.isFinite(tool.inflate) || tool.inflate <= 0) tool.inflate = mag;
        }
        tool.generate();
        // Authoring-space tidy up
        preClean(tool, Math.max(1e-9, 1e-6 * (scaleHint || 1)));
        return true;
      } catch { return false; }
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
        result = (op === 'UNION') ? result.union(tool) : result.intersect(tool);
      } catch (e1) {
        debugLog('Primary union/intersect failed; attempting welded fallback', {
          message: e1?.message || e1,
          tool: __booleanDebugSummarizeSolid(tool),
          epsilon: eps,
        });
        // Fallback A: try on welded clones with tiny epsilon
        try {
          const a = typeof result.clone === 'function' ? result.clone() : result;
          const b = typeof tool.clone === 'function' ? tool.clone() : tool;
          preClean(a, eps);
          preClean(b, eps);
          result = (op === 'UNION') ? a.union(b) : a.intersect(b);
        } catch (e2) {
          // Fallback B: if tool is a FilletSolid on an open edge with projected strips,
          // rebuild it without projection and retry.
          let retried = false;
          try {
            debugLog('Welded fallback failed; attempting fillet regenerate fallback', {
              message: e2?.message || e2,
            });
            const changed = maybeRegenerateFilletTool(tool, op, scale);
            if (changed) {
              const a2 = typeof result.clone === 'function' ? result.clone() : result;
              preClean(a2, eps);
              preClean(tool, eps);
              result = (op === 'UNION') ? a2.union(tool) : a2.intersect(tool);
              retried = true;
            }
          } catch (e3) {
            // Will fall through to outer catch
            throw e3;
          }
          if (!retried) throw e2;
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
