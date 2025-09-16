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
          const map = {
            'START+': ['START', +1], 'START_POS': ['START', +1], 'STARTPOS': ['START', +1],
            'START-': ['START', -1], 'START_NEG': ['START', -1], 'STARTNEG': ['START', -1],
            'END+': ['END', +1],   'END_POS':   ['END', +1],   'ENDPOS':   ['END', +1],
            'END-': ['END', -1],   'END_NEG':   ['END', -1],   'ENDNEG':   ['END', -1],
          };
          const key = s.replace(/\s+/g, '');
          const m = map[key];
          if (m) { out[m[0].toLowerCase()] = m[1]; }
          return out;
        };

        const want = parseFlag(flag);

        // Only proceed when the flag is present and we can find cap faces.
        if ((want.start || want.end) && distMag > 0) {
          // Precompute a size scale for tolerances from the tool's bounds
          const getSolidScale = (solid) => {
            try {
              const mesh = solid.getMesh();
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
      // FROM each selected target solid.
      const results = [];
      let idx = 0;
      for (const target of tools) {
        const out = target.subtract(baseSolid);
        out.visualize();
        try { out.name = (featureID ? `${featureID}_${++idx}` : out.name || 'RESULT'); } catch (_) { }
        results.push(out);
      }
      // In SUBTRACT: removed = [all targets, baseSolid]
      const removed = [...tools];
      if (baseSolid) removed.push(baseSolid);
      return { added: results.length ? results : [baseSolid], removed };
    }

    // UNION / INTERSECT: fold tools into the new baseSolid and replace base
    let result = baseSolid;
    for (const tool of tools) {
      if (op === 'UNION') {
        result = result.union(tool);
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
    // UNION/INTERSECT: remove tools and the base solid (replace base with result)
    const removed = tools.slice();
    if (baseSolid) removed.push(baseSolid);
    return { added: [result], removed };
  } catch (err) {
    // On failure, pass through original to avoid breaking the pipeline
    console.warn('[applyBooleanOperation] failed:', err?.message || err);
    return { added: [baseSolid], removed: [] };
  }
}
