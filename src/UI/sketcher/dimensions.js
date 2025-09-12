import * as THREE from 'three';
import { drawConstraintGlyphs } from './glyphs.js';

// Debug switch for dimension label interactions
// Toggle at runtime via: window.__SKETCH_DIM_DEBUG = true/false
const DIM_DEBUG = false;
const dbg = (...args) => { try { if (DIM_DEBUG || window.__SKETCH_DIM_DEBUG) console.log('[DIM]', ...args); } catch {} };

// Unified dimension colors
const DIM_COLOR_DEFAULT = 0x69a8ff;   // blue
const DIM_COLOR_HOVER   = 0xffd54a;   // yellow
const DIM_COLOR_SELECTED= 0x6fe26f;   // green

export function mountDimRoot(inst) {
  const host = inst.viewer?.container;
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'sketch-dims';
  el.style.position = 'absolute';
  el.style.left = '0';
  el.style.top = '0';
  el.style.right = '0';
  el.style.bottom = '0';
  el.style.pointerEvents = 'none';
  // Prevent any text selection within the overlay while dragging labels
  el.style.userSelect = 'none';
  el.style.webkitUserSelect = 'none';
  el.style.MozUserSelect = 'none';
  el.style.touchAction = 'none';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.pointerEvents = 'none';
  el.appendChild(svg);
  host.appendChild(el);
  inst._dimSVG = svg;
  inst._dimRoot = el;
}

export function clearDims(inst) {
  if (!inst._dimRoot) return;
  const labels = Array.from(inst._dimRoot.querySelectorAll('.dim-label, .glyph-label'));
  labels.forEach((n) => n.parentNode && n.parentNode.removeChild(n));
  if (inst._dimSVG) while (inst._dimSVG.firstChild) inst._dimSVG.removeChild(inst._dimSVG.firstChild);
  if (inst._dim3D) {
    while (inst._dim3D.children.length) {
      const ch = inst._dim3D.children.pop();
      try { ch.geometry?.dispose(); ch.material?.dispose?.(); } catch {}
    }
  }
}

export function renderDimensions(inst) {
  if (!inst._dimRoot || !inst._solver || !inst._lock) return;
  // If a label drag is active, avoid tearing down/rebuilding HTML labels which
  // would drop pointer capture and prematurely end the drag. Only refresh 3D leaders.
  if (inst._suspendDimLabelRebuild) {
    try { _redrawDim3D(inst); } catch {}
    return;
  }
  clearDims(inst);
  const s = inst._solver.sketchObject;
  const to3 = (u, v) => new THREE.Vector3()
    .copy(inst._lock.basis.origin)
    .addScaledVector(inst._lock.basis.x, u)
    .addScaledVector(inst._lock.basis.y, v);
  const P = (id) => s.points.find((p) => p.id === id);

  const mk = (c, text, world, planeOffOverride = null) => {
    const d = document.createElement('div');
    d.className = 'dim-label';
    try { d.dataset.cid = String(c.id); } catch {}
    d.style.position = 'absolute';
    d.style.padding = '2px 6px';
    d.style.border = '1px solid #364053';
    d.style.borderRadius = '6px';
    d.style.background = 'rgba(20,24,30,.9)';
    d.style.color = '#e6e6e6';
    d.style.font = '12px system-ui,sans-serif';
    d.style.pointerEvents = 'auto';
    d.style.userSelect = 'none';
    d.style.webkitUserSelect = 'none';
    d.style.MozUserSelect = 'none';
    d.style.touchAction = 'none';
    d.setAttribute('draggable', 'false');
    d.onselectstart = () => false;
    d.textContent = text;

    // Selection/hover styling for labels
    const isSel = Array.from(inst._selection || []).some(it => it.type === 'constraint' && it.id === c.id);
    const isHov = inst._hover && inst._hover.type === 'constraint' && inst._hover.id === c.id;
    if (isSel) {
      d.style.border = '1px solid #2f6d2f';
      d.style.background = 'rgba(111,226,111,.16)';
    } else if (isHov) {
      d.style.border = '1px solid #6f5a12';
      d.style.background = 'rgba(255,213,74,.12)';
    }

    // Centralized event hookup for drag/edit/hover/click
    attachDimLabelEvents(inst, d, c, world);

    inst._dimRoot.appendChild(d);
    const saved = inst._dimOffsets.get(c.id) || { du: 0, dv: 0 };
    const off = planeOffOverride || saved;
    updateOneDimPosition(inst, d, world, off);
  };

  // Prepare glyph placement avoidance (used by drawConstraintGlyph)
  try {
    const rectForGlyph = inst.viewer.renderer.domElement.getBoundingClientRect();
    const baseGlyph = Math.max(0.1, worldPerPixel(inst.viewer.camera, rectForGlyph.width, rectForGlyph.height) * 14);
    inst._glyphAvoid = {
      placed: [],            // array of {u,v}
      minDist: baseGlyph * 0.9,
      step: baseGlyph * 0.3,
    };
  } catch {}

  const glyphConstraints = [];
  for (const c of s.constraints || []) {
    const sel = Array.from(inst._selection || []).some(it => it.type === 'constraint' && it.id === c.id);
    const hov = inst._hover && inst._hover.type === 'constraint' && inst._hover.id === c.id;
    if (c.type === '⟺') {
      if (c.displayStyle === 'radius' && c.points?.length >= 2) {
        const pc = P(c.points[0]), pr = P(c.points[1]); if (!pc || !pr) continue;
        const col = sel ? DIM_COLOR_SELECTED : (hov ? DIM_COLOR_HOVER : DIM_COLOR_DEFAULT);
        dimRadius3D(inst, pc, pr, c.id, col);
        const v = new THREE.Vector2(pr.x - pc.x, pr.y - pc.y); const L = v.length() || 1; const rx = v.x/L, ry = v.y/L; const nx = -ry, ny = rx;
        const offSaved = inst._dimOffsets.get(c.id) || {};
        const dr = (offSaved.dr !== undefined || offSaved.dp !== undefined)
          ? (Number(offSaved.dr)||0)
          : ((Number(offSaved.du)||0)*rx + (Number(offSaved.dv)||0)*ry);
        const dp = (offSaved.dr !== undefined || offSaved.dp !== undefined)
          ? (Number(offSaved.dp)||0)
          : ((Number(offSaved.du)||0)*nx + (Number(offSaved.dv)||0)*ny);
        const label = to3(pr.x + rx*dr + nx*dp, pr.y + ry*dr + ny*dp);
        const val = Number(c.value) ?? 0;
        const txt = c.displayStyle === 'diameter' ? `⌀${(2*val).toFixed(3)}     Diameter` : `R${val.toFixed(3)}     Radius`;
        mk(c, txt, label, { du: 0, dv: 0 });
      } else if (c.points?.length >= 2) {
        const p0 = P(c.points[0]), p1 = P(c.points[1]); if (!p0 || !p1) continue;
        const basis = (()=>{ const dx=p1.x-p0.x, dy=p1.y-p0.y; const L=Math.hypot(dx,dy)||1; const tx=dx/L, ty=dy/L; return { tx, ty, nx:-ty, ny:tx }; })();
        const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
        const base = Math.max(0.1, worldPerPixel(inst.viewer.camera, rect.width, rect.height) * 20);
        const offSaved = inst._dimOffsets.get(c.id) || { du:0, dv:0 };
        const d = typeof offSaved.d === 'number' ? offSaved.d : (offSaved.du||0)*basis.nx + (offSaved.dv||0)*basis.ny;
        const t = typeof offSaved.t === 'number' ? offSaved.t : (offSaved.du||0)*basis.tx + (offSaved.dv||0)*basis.ty;
        const col = sel ? DIM_COLOR_SELECTED : (hov ? DIM_COLOR_HOVER : DIM_COLOR_DEFAULT);
        dimDistance3D(inst, p0, p1, c.id, col);
        mk(c, String((Number(c.value) ?? 0).toFixed(3)), to3((p0.x+p1.x)/2, (p0.y+p1.y)/2), { du: basis.tx*t + basis.nx*(base+d), dv: basis.ty*t + basis.ny*(base+d) });
      }
    }
    if (c.type === '∠' && c.points?.length >= 4) {
      const p0=P(c.points[0]), p1=P(c.points[1]), p2=P(c.points[2]), p3=P(c.points[3]); if (!p0||!p1||!p2||!p3) continue;
      const I = intersect(p0,p1,p2,p3);
      const col = sel ? DIM_COLOR_SELECTED : (hov ? DIM_COLOR_HOVER : DIM_COLOR_DEFAULT);
      // Pass current numeric value to renderer so the arc length matches the annotation
      const angleValueDeg = (typeof c.value === 'number' && Number.isFinite(c.value)) ? Number(c.value) : null;
      dimAngle3D(inst, p0,p1,p2,p3,c.id,I, col, angleValueDeg);
      mk(c, String(c.value ?? ''), to3(I.x, I.y));
    } else {
      // Non-dimension constraints: collect for grouped glyph rendering
      glyphConstraints.push(c);
    }
  }

  // Render grouped glyphs (non-dimension constraints)
  try { drawConstraintGlyphs(inst, glyphConstraints); } catch {}
}

// Lightweight redraw of only the 3D leaders/arrows without touching HTML labels.
// Used during drag so pointer capture on the label is not lost.
function _redrawDim3D(inst, onlyCid = null) {
  try {
    if (!inst || !inst._solver || !inst._lock || !inst._dim3D) return;
    // Clear existing 3D primitives for either all dims or one cid
    for (let i = inst._dim3D.children.length - 1; i >= 0; i--) {
      const ch = inst._dim3D.children[i];
      const isDim = ch && ch.userData && ch.userData.kind === 'dim';
      const match = onlyCid == null || (isDim && ch.userData.cid === onlyCid);
      if (isDim && match) {
        inst._dim3D.remove(ch);
        try { ch.geometry?.dispose(); ch.material?.dispose?.(); } catch {}
      }
    }
    const s = inst._solver.sketchObject || {};
    const P = (id) => (s.points || []).find((p) => p.id === id);
    const selSet = new Set(Array.from(inst._selection || []).filter(it => it.type === 'constraint').map(it => it.id));
    const hovId = (inst._hover && inst._hover.type === 'constraint') ? inst._hover.id : null;
    for (const c of (s.constraints || [])) {
      if (onlyCid != null && c?.id !== onlyCid) continue;
      const sel = selSet.has(c?.id);
      const hov = (hovId === c?.id);
      const col = sel ? DIM_COLOR_SELECTED : (hov ? DIM_COLOR_HOVER : DIM_COLOR_DEFAULT);
      if (!c) continue;
      if (c.type === '⟺') {
        if (c.displayStyle === 'radius' && Array.isArray(c.points) && c.points.length >= 2) {
          const pc = P(c.points[0]); const pr = P(c.points[1]);
          if (pc && pr) dimRadius3D(inst, pc, pr, c.id, col);
        } else if (Array.isArray(c.points) && c.points.length >= 2) {
          const p0 = P(c.points[0]); const p1 = P(c.points[1]);
          if (p0 && p1) dimDistance3D(inst, p0, p1, c.id, col);
        }
      } else if (c.type === '∠' && Array.isArray(c.points) && c.points.length >= 4) {
        const p0 = P(c.points[0]), p1 = P(c.points[1]), p2 = P(c.points[2]), p3 = P(c.points[3]);
        if (!p0 || !p1 || !p2 || !p3) continue;
        const I = intersect(p0, p1, p2, p3);
        const angleValueDeg = (typeof c.value === 'number' && Number.isFinite(c.value)) ? Number(c.value) : null;
        dimAngle3D(inst, p0, p1, p2, p3, c.id, I, col, angleValueDeg);
      }
    }
  } catch {}
}

// Helpers (module-local)
function updateOneDimPosition(inst, el, world, off, noNudge = false) {
  const du = Number(off?.du) || 0; const dv = Number(off?.dv) || 0;
  const O = inst._lock.basis.origin, X = inst._lock.basis.x, Y = inst._lock.basis.y;
  // Base world position for the label
  let w = world.clone().add(X.clone().multiplyScalar(du)).add(Y.clone().multiplyScalar(dv));
  // Compute plane coords
  try {
    const d = w.clone().sub(O);
    let u = d.dot(X.clone().normalize());
    let v = d.dot(Y.clone().normalize());
    const u0 = u, v0 = v;
    if (!noNudge) {
      // Nudge away from nearby sketch points to avoid overlap
      const pts = (inst._solver && Array.isArray(inst._solver.sketchObject?.points)) ? inst._solver.sketchObject.points : [];
      const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
      const wpp = worldPerPixel(inst.viewer.camera, rect.width, rect.height);
      const handleR = Math.max(0.02, wpp * 8 * 0.5);
      const minDist = handleR * 1.2;
      let iter = 0;
      while (iter++ < 4) {
        let nearest = null, nd = Infinity;
        for (const p of pts) {
          const dd = Math.hypot(u - p.x, v - p.y);
          if (dd < nd) { nd = dd; nearest = p; }
        }
        if (!nearest || nd >= minDist) break;
        const dx = u - nearest.x, dy = v - nearest.y; const L = Math.hypot(dx, dy) || 1e-6;
        const push = (minDist - nd) + (0.15 * minDist);
        u = nearest.x + (dx / L) * (nd + push);
        v = nearest.y + (dy / L) * (nd + push);
      }
    }
    if (!noNudge && inst && inst._debugDragCID != null && String(inst._debugDragCID) === String(el?.dataset?.cid)) {
      const duN = u - u0, dvN = v - v0; const moved = Math.hypot(duN, dvN);
      if (moved > 1e-6) dbg('label-nudged', { cid: el?.dataset?.cid, from: {u:u0,v:v0}, to: {u,v}, delta:{du:duN,dv:dvN} });
    }
    // Rebuild world position from nudged (u,v)
    w = new THREE.Vector3().copy(O).addScaledVector(X, u).addScaledVector(Y, v);
  } catch {}
  const pt = w.project(inst.viewer.camera);
  const rect2 = inst.viewer.renderer.domElement.getBoundingClientRect();
  const x = (pt.x * 0.5 + 0.5) * rect2.width; const y = (-pt.y * 0.5 + 0.5) * rect2.height;
  el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px`;
  // Only log label placement for the dimension actively being dragged
  if (inst && inst._debugDragCID != null && String(inst._debugDragCID) === String(el?.dataset?.cid)) {
    dbg('label-place', { cid: el?.dataset?.cid, world: { x: w.x, y: w.y, z: w.z }, screen: { x: Math.round(x), y: Math.round(y) }, off: {du,dv}, noNudge });
  }
}

function pointerToPlaneUV(inst, e) {
  const v = inst.viewer; if (!v || !inst._lock) return null;
  const rect = v.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1, -(((e.clientY-rect.top)/rect.height)*2-1));
  inst._raycaster.setFromCamera(ndc, v.camera);
  const n = inst._lock?.basis?.z?.clone();
  const o = inst._lock?.basis?.origin?.clone();
  if (!n || !o) return null;
  const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
  const hit = new THREE.Vector3(); const ok = inst._raycaster.ray.intersectPlane(pl, hit); if (!ok) return null;
  const bx = inst._lock.basis.x; const by = inst._lock.basis.y;
  const u = hit.clone().sub(o).dot(bx.clone().normalize());
  const v2 = hit.clone().sub(o).dot(by.clone().normalize());
  const out = { u, v: v2 };
  // Only log during active drag to avoid spam
  if (inst && inst._debugDragCID != null) dbg('pointer->uv', { x: e.clientX, y: e.clientY }, out);
  return out;
}

// Centralized event wiring for dimension labels (drag, click, hover, edit)
function attachDimLabelEvents(inst, el, c, world) {
  // Click: toggle constraint selection (dblclick handled separately)
  el.addEventListener('click', (e) => {
    if (e.detail > 1) return;
    try { inst.toggleSelectConstraint?.(c.id); } catch {}
    e.preventDefault(); e.stopPropagation(); try { e.stopImmediatePropagation(); } catch {}
    dbg('click', { cid: c.id, type: c.type });
  });

  // Hover reflects in overlays/sidebar
  el.addEventListener('pointerenter', () => { try { inst.hoverConstraintFromLabel?.(c.id); } catch {} });
  el.addEventListener('pointerleave', () => { try { inst.clearHoverFromLabel?.(c.id); } catch {} });

  // Edit on double click (value expression support preserved)
  el.addEventListener('dblclick', (e) => {
    e.preventDefault(); e.stopPropagation();
    dbg('dblclick-edit', { cid: c.id, type: c.type, value: c.value });
    const v = prompt('Enter value', String(c.value ?? ''));
    if (v == null) return;
    const ph = inst?.viewer?.partHistory;
    const exprSrc = ph?.expressions || '';
    const runExpr = (expressions, equation) => {
      try {
        const fn = `${expressions}; return ${equation} ;`;
        let result = Function(fn)();
        if (typeof result === 'string') {
          const num = Number(result);
          if (!Number.isNaN(num)) return num;
        }
        return result;
      } catch (err) {
        console.log('Expression eval failed:', err?.message || err);
        return null;
      }
    };
    const plainNumberRe = /^\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?\s*$/i;
    let numeric = null;
    if (plainNumberRe.test(v)) {
      numeric = parseFloat(v);
      c.valueExpr = undefined;
    } else {
      numeric = runExpr(exprSrc, v);
      if (numeric == null || !Number.isFinite(numeric)) return;
      c.valueExpr = String(v);
    }
    c.value = Number(numeric);
    try { inst._solver.solveSketch('full'); } catch {}
    try { inst._solver?.hooks?.updateCanvas?.(); } catch {}
  });

  // Drag handling with commit-on-drop
  let dragging = false, moved = false, sx = 0, sy = 0, start = {};
  let sClientX = 0, sClientY = 0;
  let distNx = 0, distNy = 0, distTx = 0, distTy = 0, distStartD = 0, distStartT = 0;
  let radRx = 0, radRy = 0, radNx = 0, radNy = 0, radStartDr = 0, radStartDp = 0;
  let angStartDU = 0, angStartDV = 0;
  let pendingOff = null;

  el.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false; pendingOff = null;
    try { inst._suspendDimLabelRebuild = true; inst._activeDimLabelDragId = c.id; } catch {}
    try { inst._debugDragCID = c.id; } catch {}
    const uv = pointerToPlaneUV(inst, e);
    sx = uv?.u || 0; sy = uv?.v || 0;
    start = { ...(inst._dimOffsets.get(c.id) || {}) };
    sClientX = e.clientX || 0; sClientY = e.clientY || 0;
    dbg('pointerdown', { cid: c.id, type: c.type, startUV: { u: sx, v: sy }, startOffset: start });
    if (c.type === '⟺' && c.displayStyle === 'radius' && Array.isArray(c.points) && c.points.length >= 2) {
      const sObj = inst._solver.sketchObject;
      const pc = sObj.points.find((p) => p.id === c.points[0]);
      const pr = sObj.points.find((p) => p.id === c.points[1]);
      if (pc && pr) {
        const vx = pr.x - pc.x, vy = pr.y - pc.y; const L = Math.hypot(vx, vy) || 1;
        radRx = vx / L; radRy = vy / L; radNx = -radRy; radNy = radRx;
        radStartDr = Number(start.dr) || 0; radStartDp = Number(start.dp) || 0;
      }
    } else if (c.type === '⟺' && Array.isArray(c.points) && c.points.length >= 2) {
      const sObj = inst._solver.sketchObject;
      const p0 = sObj.points.find((p) => p.id === c.points[0]);
      const p1 = sObj.points.find((p) => p.id === c.points[1]);
      if (p0 && p1) {
        const dx = p1.x - p0.x, dy = p1.y - p0.y; const L = Math.hypot(dx, dy) || 1;
        const tx = dx / L, ty = dy / L; distTx = tx; distTy = ty;
        distNx = -ty; distNy = tx;
        const du0 = Number(start.du) || 0, dv0 = Number(start.dv) || 0;
        distStartD = (typeof start.d === 'number') ? Number(start.d) : (du0 * distNx + dv0 * distNy);
        distStartT = (typeof start.t === 'number') ? Number(start.t) : (du0 * distTx + dv0 * distTy);
      }
    } else if (c.type === '∠') {
      angStartDU = Number(start.du) || 0; angStartDV = Number(start.dv) || 0;
    }
    try { if (inst.viewer?.controls) inst.viewer.controls.enabled = false; } catch {}
    try { el.setPointerCapture(e.pointerId); } catch {}
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const uv = pointerToPlaneUV(inst, e); if (!uv) return;
    const pxThreshold = 3;
    const pxDx = Math.abs((e.clientX || 0) - sClientX);
    const pxDy = Math.abs((e.clientY || 0) - sClientY);
    if (!moved && (pxDx + pxDy) < pxThreshold) return;
    moved = true;
    dbg('pointermove', { cid: c.id, type: c.type, uv, pxDx, pxDy });
    const du = uv.u - sx; const dv = uv.v - sy;
    if (c.type === '⟺' && c.displayStyle === 'radius' && Array.isArray(c.points) && c.points.length >= 2) {
      const dr = (Number(radStartDr)||0) + (du*radRx + dv*radRy);
      const dp = (Number(radStartDp)||0) + (du*radNx + dv*radNy);
      pendingOff = { dr, dp };
      // live label preview without committing
      const toLabel = { du: radRx*dr + radNx*dp, dv: radRy*dr + radNy*dp };
      updateOneDimPosition(inst, el, world, toLabel, true);
      dbg('preview-radius', { cid: c.id, dr, dp, toLabel });
      try { inst._dimOffsets.set(c.id, toLabel); _redrawDim3D(inst, c.id); } catch {}
    } else if (c.type === '⟺' && Array.isArray(c.points) && c.points.length >= 2) {
      const deltaN = du * distNx + dv * distNy;
      const deltaT = du * distTx + dv * distTy;
      const newD = distStartD + deltaN; const newT = distStartT + deltaT;
      pendingOff = { d: newD, t: newT };
      const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
      const base = Math.max(0.1, worldPerPixel(inst.viewer.camera, rect.width, rect.height) * 20);
      const toLabel = { du: distTx*newT + distNx*(base + newD), dv: distTy*newT + distNy*(base + newD) };
      updateOneDimPosition(inst, el, world, toLabel, true);
      dbg('preview-distance', { cid: c.id, d: newD, t: newT, toLabel });
      try { inst._dimOffsets.set(c.id, { du: toLabel.du, dv: toLabel.dv }); _redrawDim3D(inst, c.id); } catch {}
    } else if (c.type === '∠') {
      const toLabel = { du: angStartDU + du, dv: angStartDV + dv };
      pendingOff = { ...toLabel };
      updateOneDimPosition(inst, el, world, toLabel, true);
      dbg('preview-angle', { cid: c.id, toLabel });
      try { inst._dimOffsets.set(c.id, toLabel); _redrawDim3D(inst, c.id); } catch {}
    }
    e.preventDefault(); e.stopPropagation(); try { e.stopImmediatePropagation(); } catch {}
  });

  const computePendingFromEvent = (e) => {
    const uv = pointerToPlaneUV(inst, e); if (!uv) return null;
    if (c.type === '⟺' && c.displayStyle === 'radius' && Array.isArray(c.points) && c.points.length >= 2) {
      const du = uv.u - sx; const dv = uv.v - sy;
      const dr = (Number(radStartDr)||0) + (du*radRx + dv*radRy);
      const dp = (Number(radStartDp)||0) + (du*radNx + dv*radNy);
      return { dr, dp };
    } else if (c.type === '⟺' && Array.isArray(c.points) && c.points.length >= 2) {
      const du = uv.u - sx; const dv = uv.v - sy;
      const deltaN = du * distNx + dv * distNy;
      const deltaT = du * distTx + dv * distTy;
      const newD = distStartD + deltaN; const newT = distStartT + deltaT;
      return { d: newD, t: newT };
    } else if (c.type === '∠') {
      const du = uv.u - sx; const dv = uv.v - sy;
      return { du: angStartDU + du, dv: angStartDV + dv };
    }
    return null;
  };

  const commitAndRefresh = () => {
    if (pendingOff) { try { inst._dimOffsets.set(c.id, pendingOff); dbg('commit', { cid: c.id, off: pendingOff }); } catch {} pendingOff = null; }
    try { inst._solver?.hooks?.updateCanvas?.(); } catch {}
    try { renderDimensions(inst); dbg('renderDimensions'); } catch {}
  };

  el.addEventListener('pointerup', (e) => {
    let hadPending = !!pendingOff;
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch {}
    try { if (inst.viewer?.controls) inst.viewer.controls.enabled = true; } catch {}
    if (!hadPending) { pendingOff = computePendingFromEvent(e); hadPending = !!pendingOff; dbg('pointerup-computed', { cid: c.id, pendingOff }); }
    if (hadPending) {
      commitAndRefresh();
      e.preventDefault(); e.stopPropagation(); try { e.stopImmediatePropagation(); } catch {}
    }
    try { inst._suspendDimLabelRebuild = false; inst._activeDimLabelDragId = null; } catch {}
    try { inst._debugDragCID = null; } catch {}
  });

  el.addEventListener('pointercancel', (e) => {
    let hadPending = !!pendingOff;
    dragging = false;
    try { el.releasePointerCapture(e.pointerId); } catch {}
    try { if (inst.viewer?.controls) inst.viewer.controls.enabled = true; } catch {}
    if (!hadPending) { pendingOff = computePendingFromEvent(e); hadPending = !!pendingOff; dbg('pointercancel-computed', { cid: c.id, pendingOff }); }
    if (hadPending) {
      commitAndRefresh();
      e.preventDefault(); e.stopPropagation(); try { e.stopImmediatePropagation(); } catch {}
    }
    try { inst._suspendDimLabelRebuild = false; inst._activeDimLabelDragId = null; } catch {}
    try { inst._debugDragCID = null; } catch {}
  });
}

export function dimDistance3D(inst, p0, p1, cid, color = 0x67e667) {
  const off = inst._dimOffsets.get(cid) || { du:0, dv:0 };
  const X = inst._lock.basis.x, Y = inst._lock.basis.y, O = inst._lock.basis.origin;
  const u0=p0.x, v0=p0.y, u1=p1.x, v1=p1.y; const dx=u1-u0, dy=v1-v0; const L=Math.hypot(dx,dy)||1; const tx=dx/L, ty=dy/L; const nx=-ty, ny=tx;
  const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
  const base = Math.max(0.1, worldPerPixel(inst.viewer.camera, rect.width, rect.height) * 20);
  const d = typeof off.d === 'number' ? off.d : (off.du||0)*nx + (off.dv||0)*ny;
  const ou = nx*(base+d), ov = ny*(base+d);
  const P = (u,v)=> new THREE.Vector3().copy(O).addScaledVector(X,u).addScaledVector(Y,v);
  const addLine=(pts,mat)=>{ const g=new THREE.BufferGeometry().setFromPoints(pts.map(p=>P(p.u,p.v))); const ln=new THREE.Line(g,mat); ln.userData={kind:'dim',cid}; ln.renderOrder = 10020; try { ln.layers.set(31); } catch {} inst._dim3D.add(ln); };
  const green=new THREE.LineBasicMaterial({color, depthTest:false, depthWrite:false, transparent:true});
  addLine([{u:u0+ou,v:v0+ov},{u:u1+ou,v:v1+ov}], green);
  addLine([{u:u0,v:v0},{u:u0+ou,v:v0+ov}], green.clone());
  addLine([{u:u1,v:v1},{u:u1+ou,v:v1+ov}], green.clone());
  const ah = Math.max(0.06, worldPerPixel(inst.viewer.camera, rect.width, rect.height) * 6);
  const s = 0.6; const arrow=(ux,vy,dir)=>{ const tip={u:ux+ou,v:vy+ov}; const ax=dir*tx, ay=dir*ty; const wx=-ay, wy=ax; const A={u:tip.u+ax*ah+wx*ah*s,v:tip.v+ay*ah+wy*ah*s}; const B={u:tip.u+ax*ah-wx*ah*s,v:tip.v+ay*ah-wy*ah*s}; addLine([{u:tip.u,v:tip.v},A], green.clone()); addLine([{u:tip.u,v:tip.v},B], green.clone()); };
  arrow(u0,v0,1); arrow(u1,v1,-1);
}

export function dimRadius3D(inst, pc, pr, cid, color = 0x69a8ff) {
  const off = inst._dimOffsets.get(cid) || {};
  const X = inst._lock.basis.x, Y = inst._lock.basis.y, O = inst._lock.basis.origin;
  const P=(u,v)=> new THREE.Vector3().copy(O).addScaledVector(X,u).addScaledVector(Y,v);
  const blue=new THREE.LineBasicMaterial({ color, depthTest:false, depthWrite:false, transparent:true });
  const add=(uvs)=>{ const g=new THREE.BufferGeometry().setFromPoints(uvs.map(q=>P(q.u,q.v))); const ln=new THREE.Line(g, blue); ln.userData={kind:'dim',cid}; ln.renderOrder = 10020; try { ln.layers.set(31); } catch {} inst._dim3D.add(ln); };
  const vx=pr.x-pc.x, vy=pr.y-pc.y; const L=Math.hypot(vx,vy)||1; const rx=vx/L, ry=vy/L; const nx=-ry, ny=rx;
  // Support both {dr,dp} and generic {du,dv}
  let dr = 0, dp = 0;
  if (off && (off.dr !== undefined || off.dp !== undefined)) {
    dr = Number(off.dr)||0; dp = Number(off.dp)||0;
  } else {
    const du = Number(off.du)||0; const dv = Number(off.dv)||0;
    dr = du*rx + dv*ry; dp = du*nx + dv*ny;
  }
  const elbow={u: pr.x + rx*dr, v: pr.y + ry*dr}; const dogleg={u: elbow.u + nx*dp, v: elbow.v + ny*dp};
  add([{u:pc.x,v:pc.y},{u:pr.x,v:pr.y}]); add([{u:pr.x,v:pr.y}, elbow]); add([elbow, dogleg]);
  const ah = 0.06; const s=0.6; const tip={u:pr.x, v:pr.y}; const A={u: tip.u - rx*ah + nx*ah*0.6, v: tip.v - ry*ah + ny*ah*0.6}; const B={u: tip.u - rx*ah - nx*ah*0.6, v: tip.v - ry*ah - ny*ah*0.6};
  add([tip, A]); add([tip, B]);
}

export function dimAngle3D(inst, p0,p1,p2,p3,cid,I, color = 0x69a8ff, valueDeg = null) {
  // Offset for label drag: translates the arc center together with the label
  const off = inst._dimOffsets.get(cid) || { du:0, dv:0 };
  const X=inst._lock.basis.x, Y=inst._lock.basis.y, O=inst._lock.basis.origin; const P=(u,v)=> new THREE.Vector3().copy(O).addScaledVector(X,u).addScaledVector(Y,v);

  // Unit direction of both lines
  const d1=new THREE.Vector2(p1.x-p0.x, p1.y-p0.y);
  const d2=new THREE.Vector2(p3.x-p2.x, p3.y-p2.y);
  if (d1.lengthSq() < 1e-12 || d2.lengthSq() < 1e-12) return; // degenerate
  d1.normalize(); d2.normalize();

  // Base orientation from first line; arc direction sign from the raw difference
  let a0=Math.atan2(d1.y,d1.x), a1=Math.atan2(d2.y,d2.x);
  let signedDelta=a1-a0; while(signedDelta<=-Math.PI)signedDelta+=2*Math.PI; while(signedDelta>Math.PI)signedDelta-=2*Math.PI;
  const sgn = signedDelta>=0 ? 1 : -1;

  // Use the constraint's numeric value when provided; otherwise draw the minor angle
  let mag = Math.abs(signedDelta);
  if (typeof valueDeg === 'number' && Number.isFinite(valueDeg)) {
    mag = (Math.abs(valueDeg) % 360) * (Math.PI/180);
    if (mag < 1e-6) mag = 1e-6; // ensure visible
  }
  let d = sgn * mag;
  // Clamp to [0, 2π]
  const twoPi = Math.PI*2; if (Math.abs(d) > twoPi) d = sgn * (twoPi - 1e-6);

  // Screen-scaled radius and arrow size so it stays visible at any zoom
  const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
  const wpp = worldPerPixel(inst.viewer.camera, rect.width, rect.height);
  const baseR = Math.max(0.3, wpp * 24);
  const ah = Math.max(0.06, wpp * 6);
  // Keep arc centered at the lines' intersection; use label offset magnitude to set radius
  const du = Number(off.du)||0, dv = Number(off.dv)||0;
  const r = baseR + Math.hypot(du, dv);
  const cx = I.x, cy = I.y;

  // Choose the arc side so the arc (+ arrows) are on the same side as the label.
  // Compare label direction with the arc bisector; if it's closer to the opposite
  // bisector, flip the start by PI which mirrors the arc side while preserving span.
  const labelAng = Math.atan2(dv, du); // direction from center to label offset
  const angNorm = (a)=>{ const t=2*Math.PI; a%=t; return a<0?a+t:a; };
  const angDiff = (a,b)=>{ let x=angNorm(a-b); if (x>Math.PI) x=2*Math.PI-x; return Math.abs(x); };
  let aStart = a0; // base start
  const bisector = aStart + d*0.5;
  const bisectorOpp = bisector + Math.PI;
  if (angDiff(labelAng, bisectorOpp) + 1e-6 < angDiff(labelAng, bisector)) {
    aStart += Math.PI; // flip arc side
  }

  // Author the arc polyline
  const segs=48; // smoother arc
  const uvs=[]; for(let i=0;i<=segs;i++){ const t=aStart+d*(i/segs); uvs.push({u:cx+Math.cos(t)*r, v:cy+Math.sin(t)*r}); }
  const blue=new THREE.LineBasicMaterial({color, depthTest:false, depthWrite:false, transparent:true});
  const g=new THREE.BufferGeometry().setFromPoints(uvs.map(q=>P(q.u,q.v)));
  const ln=new THREE.Line(g, blue); ln.userData={kind:'dim',cid}; ln.renderOrder = 10020; try { ln.layers.set(31); } catch {} inst._dim3D.add(ln);

  // Arrowheads at both arc ends (tangential)
  const s=0.6; const addArrowUV=(t)=>{ const tx=-Math.sin(t), ty=Math.cos(t); const wx=-ty, wy=tx; const tip={u:cx+Math.cos(t)*r, v:cy+Math.sin(t)*r}; const A={u:tip.u+tx*ah+wx*ah*s, v:tip.v+ty*ah+wy*ah*s}; const B={u:tip.u+tx*ah-wx*ah*s, v:tip.v+ty*ah-wy*ah*s}; const gg1=new THREE.BufferGeometry().setFromPoints([P(tip.u,tip.v),P(A.u,A.v)]); const gg2=new THREE.BufferGeometry().setFromPoints([P(tip.u,tip.v),P(B.u,B.v)]); const la=new THREE.Line(gg1, blue.clone()); const lb=new THREE.Line(gg2, blue.clone()); la.renderOrder = 10020; lb.renderOrder = 10020; try { la.layers.set(31); lb.layers.set(31); } catch {} inst._dim3D.add(la); inst._dim3D.add(lb); };
  addArrowUV(aStart); addArrowUV(aStart+d);
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

// Robust 2D infinite-line intersection (returns point even if segments don't overlap)
function intersect(A, B, C, D) {
  const r = { x: B.x - A.x, y: B.y - A.y };
  const s = { x: D.x - C.x, y: D.y - C.y };
  const rxs = r.x * s.y - r.y * s.x;
  // Parallel or nearly parallel: fall back to A to avoid NaNs
  if (Math.abs(rxs) < 1e-12) return { x: A.x, y: A.y };
  const t = ((C.x - A.x) * s.y - (C.y - A.y) * s.x) / rxs;
  return { x: A.x + t * r.x, y: A.y + t * r.y };
}
