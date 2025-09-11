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
      el.style.font = '14px system-ui,sans-serif';
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
        try { if (inst.viewer?.controls) inst.viewer.controls.enabled = false; } catch {}
        try { el.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault(); e.stopPropagation();
      });
      el.addEventListener('pointerup', (e) => {
        try { el.releasePointerCapture(e.pointerId); } catch {}
        try { if (inst.viewer?.controls) inst.viewer.controls.enabled = true; } catch {}
        try { inst.toggleSelectConstraint?.(c.id); } catch {}
        e.preventDefault(); e.stopPropagation();
      });
      el.addEventListener('pointerenter', () => { try { inst.hoverConstraintFromLabel?.(c.id); } catch {} });
      el.addEventListener('pointerleave', () => { try { inst.clearHoverFromLabel?.(c.id); } catch {} });

      inst._dimRoot.appendChild(el);
    } catch {}
  };
  const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
  const wpp = worldPerPixel(inst.viewer.camera, rect.width, rect.height);
  const base = Math.max(0.1, wpp * 14);
  const P = (id) => s.points.find((p) => p.id === id);
  const mid = (a, b) => ({ u: (a.x + b.x) / 2, v: (a.y + b.y) / 2 });
  const dir = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y; const L = Math.hypot(dx, dy) || 1; return { tx: dx / L, ty: dy / L, nx: -dy / L, ny: dx / L }; };
  const proj = (A, B, C) => { const d = dir(A, B); const vx = C.x - A.x, vy = C.y - A.y; const t = vx * d.tx + vy * d.ty; return { u: A.x + t * d.tx, v: A.y + t * d.ty, nx: d.nx, ny: d.ny }; };
  // Build groups by sorted unique point set
  const groups = new Map();
  for (const c of (constraints || [])) {
    if (!c || c.type === '⟺' || c.type === '∠') continue;
    const ids = Array.from(new Set((c.points || []).map(Number))).sort((a,b)=>a-b);
    if (!ids.length) continue;
    const key = ids.join(',');
    const arr = groups.get(key) || []; arr.push(c); groups.set(key, arr);
  }

  // Compute anchor per group: average of unique points
  const anchorFor = (ids) => {
    let sx=0, sy=0, n=0;
    for (const id of ids) { const p = P(id); if (p) { sx += p.x; sy += p.y; n++; } }
    if (!n) return { u:0, v:0 };
    const u = sx / n, v = sy / n;
    // Nudge off-geometry slightly for visibility
    const nudge = base * 0.25; return { u: u + nudge, v: v + nudge };
  };

  // Draw each group: lay out symbols in a row centered at anchor
  const selSet = new Set(Array.from(inst._selection || []).filter(it => it.type === 'constraint').map(it => it.id));
  const hovId = (inst._hover && inst._hover.type === 'constraint') ? inst._hover.id : null;

  for (const [key, arr] of groups.entries()) {
    const ids = key.split(',').map(Number);
    const anchor = anchorFor(ids);
    const spacing = base * 0.7;
    const startU = anchor.u - spacing * (arr.length - 1) / 2;
    const y = anchor.v;
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      const cx = startU + i * spacing;
      // Record for hit-testing
      try { inst._glyphCenters.set(c.id, { u: cx, v: y }); } catch {}
      // Small pick radius disk (invisible) for selection
      try {
        const pickR = base * 0.45;
        const g = new THREE.CircleGeometry(pickR, 20);
        // Orient the circle in plane XY mapped to sketch plane
        const X = inst._lock.basis.x.clone().normalize();
        const Y = inst._lock.basis.y.clone().normalize();
        const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
        const m = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(to3(cx, y));
        const mat = new THREE.MeshBasicMaterial({ visible: false });
        const mesh = new THREE.Mesh(g, mat);
        mesh.applyMatrix4(m);
        mesh.renderOrder = 10030;
        try { mesh.layers.set(31); } catch {}
        mesh.userData = { kind: 'glyphHit', cid: c.id };
        inst._dim3D.add(mesh);
      } catch {}

      // Draw the glyph symbol itself as unicode character from constraint.type
      try {
        const color = selSet.has(c.id) ? COLOR_SELECTED : (hovId === c.id ? COLOR_HOVER : COLOR_DEFAULT);
        placeGlyphLabel(c, c.type || '?', cx, y, color);
      } catch {}
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
