import * as THREE from 'three';

const COLOR_DEFAULT = 0x69a8ff;
const COLOR_HOVER = 0xffd54a;
const COLOR_SELECTED = 0x6fe26f;

// Grouped glyph renderer: draws small glyphs for non-dimension constraints,
// grouping those that act on the same set of points at a single location.
// Also records per-constraint centers for hit-testing.
export function drawConstraintGlyphs(inst, constraints) {
  if (!inst || !inst._dim3D || !inst._lock || !inst._solver) return;
  const s = inst._solver.sketchObject;
  inst._glyphCenters = new Map();
  const to3 = (u, v) => new THREE.Vector3()
    .copy(inst._lock.basis.origin)
    .addScaledVector(inst._lock.basis.x, u)
    .addScaledVector(inst._lock.basis.y, v);
  // Project plane (u,v) to screen and place an HTML glyph label with the unicode char
  const placeGlyphLabel = (c, text, u, v, colorHex) => {
    try {
      if (!inst._dimRoot) return;
      const world = to3(u, v);
      const pt = world.project(inst.viewer.camera);
      const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
      const x = (pt.x * 0.5 + 0.5) * rect.width;
      const y = (-pt.y * 0.5 + 0.5) * rect.height;
      const el = document.createElement('div');
      el.className = 'glyph-label';
      el.textContent = String(text);
      el.style.position = 'absolute';
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.style.transform = 'translate(-50%, -50%)';
    el.style.pointerEvents = 'auto';
    // Prevent selecting glyph text while dragging/hovering
    el.style.userSelect = 'none';
    el.style.webkitUserSelect = 'none';
    el.style.MozUserSelect = 'none';
    el.setAttribute('draggable', 'false');
    el.onselectstart = () => false;
    el.style.font = '14px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    el.style.lineHeight = '1';
    el.style.color = '#e6e6e6';
    el.style.padding = '1px 6px';
      el.style.borderRadius = '6px';
      el.style.border = '1px solid #364053';
      el.style.background = 'rgba(20,24,30,.85)';
      if (colorHex === COLOR_SELECTED) {
        el.style.background = 'rgba(111,226,111,.16)';
        el.style.border = '1px solid #2f6d2f';
      } else if (colorHex === COLOR_HOVER) {
        el.style.background = 'rgba(255,213,74,.12)';
        el.style.border = '1px solid #6f5a12';
      }

      // Interactions: click to toggle selection; hover to reflect
      el.addEventListener('pointerdown', (e) => {
        try { if (inst.viewer?.controls) inst.viewer.controls.enabled = false; } catch { }
        try { el.setPointerCapture(e.pointerId); } catch { }
        e.preventDefault(); e.stopPropagation();
      });
      el.addEventListener('pointerup', (e) => {
        try { el.releasePointerCapture(e.pointerId); } catch { }
        try { if (inst.viewer?.controls) inst.viewer.controls.enabled = true; } catch { }
        try { inst.toggleSelectConstraint?.(c.id); } catch { }
        e.preventDefault(); e.stopPropagation();
      });
      el.addEventListener('pointerenter', () => { try { inst.hoverConstraintFromLabel?.(c.id); } catch { } });
      el.addEventListener('pointerleave', () => { try { inst.clearHoverFromLabel?.(c.id); } catch { } });

      inst._dimRoot.appendChild(el);
    } catch { }
  };
  const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
  const wpp = worldPerPixel(inst.viewer.camera, rect.width, rect.height);
  const base = Math.max(0.1, wpp * 14);
  const handleR = Math.max(0.02, wpp * 8 * 0.5);
  const iconR = Math.max(base * 0.9, handleR * 1.9); // approx glyph half size in world units
  const P = (id) => s.points.find((p) => p.id === id);

  // Nudge a (u,v) position away from nearby sketch points to avoid overlap
  const nudgeFromPoints = (u, v) => {
    const pts = (s && Array.isArray(s.points)) ? s.points : [];
    // Ensure clearance relative to both handle size and glyph label size
    const minDist = iconR;
    let uu = u, vv = v;
    let iter = 0;
    while (iter++ < 10) {
      let nearest = null, nd = Infinity;
      for (const p of pts) {
        const d = Math.hypot(uu - p.x, vv - p.y);
        if (d < nd) { nd = d; nearest = p; }
      }
      if (!nearest || nd >= minDist) break;
      let dx = uu - nearest.x, dy = vv - nearest.y;
      let L = Math.hypot(dx, dy);
      if (L < 1e-6) { dx = 0.70710678; dy = 0.70710678; L = 1; }
      const push = (minDist - nd) + (0.35 * minDist);
      uu = nearest.x + (dx / L) * (nd + push);
      vv = nearest.y + (dy / L) * (nd + push);
    }
    return { u: uu, v: vv };
  };

  // Avoid both points and existing glyphs; keeps result near (u0,v0)
  const placedIcons = [];
  const freeFromIcons = (u, v) => placedIcons.every(p => Math.hypot(u - p.u, v - p.v) >= iconR * 1.2);
  const avoidAll = (u0, v0) => {
    // First clear from points
    let p = nudgeFromPoints(u0, v0);
    if (freeFromIcons(p.u, p.v)) return p;
    // Spiral search outwards
    const step = iconR * 0.6;
    const maxRings = 16;
    for (let ring = 1; ring <= maxRings; ring++) {
      const r = ring * step;
      const spokes = 8 + ring * 2;
      for (let i = 0; i < spokes; i++) {
        const ang = (i / spokes) * Math.PI * 2;
        const cu = u0 + Math.cos(ang) * r;
        const cv = v0 + Math.sin(ang) * r;
        const q = nudgeFromPoints(cu, cv);
        if (freeFromIcons(q.u, q.v)) return q;
      }
    }
    return p; // fallback
  };
  // Build groups by sorted unique point set
  const groups = new Map();
  for (const c of (constraints || [])) {
    if (!c || c.type === '⟺' || c.type === '∠') continue;
    const ids = Array.from(new Set((c.points || []).map(Number))).sort((a, b) => a - b);
    if (!ids.length) continue;
    const key = ids.join(',');
    const arr = groups.get(key) || []; arr.push(c); groups.set(key, arr);
  }

  // Compute anchor per group
  const lineIntersect = (A, B, C, D) => {
    // Returns intersection of infinite lines AB and CD; fallback to average of midpoints
    const A1 = B.y - A.y; const B1 = A.x - B.x; const C1 = A1 * A.x + B1 * A.y;
    const A2 = D.y - C.y; const B2 = C.x - D.x; const C2 = A2 * C.x + B2 * C.y;
    const den = A1 * B2 - A2 * B1;
    if (Math.abs(den) < 1e-9) {
      const m1 = { x: (A.x + B.x) * 0.5, y: (A.y + B.y) * 0.5 };
      const m2 = { x: (C.x + D.x) * 0.5, y: (C.y + D.y) * 0.5 };
      return { x: (m1.x + m2.x) * 0.5, y: (m1.y + m2.y) * 0.5 };
    }
    const x = (B2 * C1 - B1 * C2) / den;
    const y = (A1 * C2 - A2 * C1) / den;
    return { x, y };
  };
  const anchorFor = (ids, arr) => {
    // If any perpendicular exists in this group, use line intersection of its two lines as anchor
    const perp = (arr || []).find(c => c && c.type === '⟂' && Array.isArray(c.points) && c.points.length >= 4);
    if (perp) {
      const A = P(perp.points[0]); const B = P(perp.points[1]);
      const C = P(perp.points[2]); const D = P(perp.points[3]);
      if (A && B && C && D) {
        const I = lineIntersect(A, B, C, D);
        const off = nudgeFromPoints(I.x, I.y);
        return { u: off.u, v: off.v };
      }
    }
    // If the group is only coincident constraints, anchor near the first point
    if ((arr || []).length && (arr || []).every(c => c && c.type === '≡')) {
      const p0 = P(ids[0]);
      if (p0) {
        const off = nudgeFromPoints(p0.x, p0.y);
        return { u: off.u, v: off.v };
      }
    }
    // Default: centroid of unique points, nudged slightly for visibility
    let sx = 0, sy = 0, n = 0;
    for (const id of ids) { const p = P(id); if (p) { sx += p.x; sy += p.y; n++; } }
    if (!n) return { u: 0, v: 0 };
    const u = sx / n, v = sy / n;
    const off = nudgeFromPoints(u, v);
    return { u: off.u, v: off.v };
  };

  // Draw each group: lay out symbols in a row centered at anchor
  const selSet = new Set(Array.from(inst._selection || []).filter(it => it.type === 'constraint').map(it => it.id));
  const hovId = (inst._hover && inst._hover.type === 'constraint') ? inst._hover.id : null;

  for (const [key, arr] of groups.entries()) {
    const ids = key.split(',').map(Number);
    const anchor = anchorFor(ids, arr);
    const spacing = base * 0.7;
    const startU = anchor.u - spacing * (arr.length - 1) / 2;
    const y = anchor.v;
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      const cx = startU + i * spacing;
      const adj = avoidAll(cx, y);
      // Record for hit-testing
      try { inst._glyphCenters.set(c.id, { u: adj.u, v: adj.v }); } catch { }
      placedIcons.push({ u: adj.u, v: adj.v });
      // Small pick radius disk (invisible) for selection
      try {
        const pickR = iconR;
        const g = new THREE.CircleGeometry(pickR, 20);
        // Orient the circle in plane XY mapped to sketch plane
        const X = inst._lock.basis.x.clone().normalize();
        const Y = inst._lock.basis.y.clone().normalize();
        const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
        const m = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(to3(adj.u, adj.v));
        const mat = new THREE.MeshBasicMaterial({ visible: false });
        const mesh = new THREE.Mesh(g, mat);
        mesh.applyMatrix4(m);
        mesh.renderOrder = 10030;
        
        mesh.userData = { kind: 'glyphHit', cid: c.id };
        inst._dim3D.add(mesh);
      } catch { }

      // Draw the glyph symbol itself as unicode character from constraint.type
      try {
        const color = selSet.has(c.id) ? COLOR_SELECTED : (hovId === c.id ? COLOR_HOVER : COLOR_DEFAULT);
        placeGlyphLabel(c, c.type || '?', adj.u, adj.v, color);
      } catch { }
    }
  }
}

function worldPerPixel(camera, width, height) {
  if (camera && camera.isOrthographicCamera) {
    const zoom = typeof camera.zoom === 'number' && camera.zoom > 0 ? camera.zoom : 1;
    const wppX = (camera.right - camera.left) / (width * zoom);
    const wppY = (camera.top - camera.bottom) / (height * zoom);
    return Math.max(wppX, wppY);
  }
  const dist = camera.position.length();
  const fovRad = (camera.fov * Math.PI) / 180;
  return (2 * Math.tan(fovRad / 2) * dist) / height;
}
