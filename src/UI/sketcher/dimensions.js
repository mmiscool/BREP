import * as THREE from 'three';
import { drawConstraintGlyphs } from './glyphs.js';

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
    d.style.position = 'absolute';
    d.style.padding = '2px 6px';
    d.style.border = '1px solid #364053';
    d.style.borderRadius = '6px';
    d.style.background = 'rgba(20,24,30,.9)';
    d.style.color = '#e6e6e6';
    d.style.font = '12px system-ui,sans-serif';
    d.style.pointerEvents = 'auto';
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

    // Drag + click-to-select support with small-move threshold
    let dragging = false, moved = false, sx = 0, sy = 0, start = {};
    let sClientX = 0, sClientY = 0;
    // Precomputed helpers for distance/radius modes
    let distNx = 0, distNy = 0, distStartD = 0;
    let radRx = 0, radRy = 0, radNx = 0, radNy = 0, radStartDr = 0, radStartDp = 0;
    d.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false;
      const uv = pointerToPlaneUV(inst, e);
      sx = uv?.u || 0; sy = uv?.v || 0;
      start = { ...(inst._dimOffsets.get(c.id) || {}) };
      sClientX = e.clientX || 0; sClientY = e.clientY || 0;
      // Prepare mode-specific baselines
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
          distNx = -(dy / L); distNy = dx / L;
          // If previous offset was vector {du,dv}, project onto normal to get scalar d
          const du0 = Number(start.du) || 0, dv0 = Number(start.dv) || 0;
          distStartD = (typeof start.d === 'number') ? Number(start.d) : (du0 * distNx + dv0 * distNy);
        }
      }
      // Prevent camera from starting a spin while interacting with dimensions
      try { if (inst.viewer?.controls) inst.viewer.controls.enabled = false; } catch {}
      try { d.setPointerCapture(e.pointerId); } catch {}
      // Do not prevent default here so click/dblclick can still fire
    });
    d.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const uv = pointerToPlaneUV(inst, e); if (!uv) return;
      // Activate drag only after a small pixel threshold to keep click reliable
      const pxThreshold = 3;
      const pxDx = Math.abs((e.clientX || 0) - sClientX);
      const pxDy = Math.abs((e.clientY || 0) - sClientY);
      if (!moved && (pxDx + pxDy) < pxThreshold) return;
      moved = true;
      if (c.type === '⟺' && c.displayStyle === 'radius' && Array.isArray(c.points) && c.points.length >= 2) {
        // Radius/diameter: track along radial (dr) and perpendicular (dp)
        // Compute change from pointerdown so live label moves relative to the
        // original rendered position (world already includes start dr/dp).
        const du = uv.u - sx;
        const dv = uv.v - sy;
        const dr = (Number(radStartDr)||0) + (du*radRx + dv*radRy);
        const dp = (Number(radStartDp)||0) + (du*radNx + dv*radNy);
        inst._dimOffsets.set(c.id, { dr, dp });
        const ddr = dr - (Number(radStartDr)||0);
        const ddp = dp - (Number(radStartDp)||0);
        const labelOff = { du: radRx*ddr + radNx*ddp, dv: radRy*ddr + radNy*ddp };
        updateOneDimPosition(inst, d, world, labelOff);
      } else if (c.type === '⟺' && Array.isArray(c.points) && c.points.length >= 2) {
        // Distance between two points: store scalar offset along normal (d)
        const deltaN = (uv.u - sx) * distNx + (uv.v - sy) * distNy;
        const newD = distStartD + deltaN;
        inst._dimOffsets.set(c.id, { d: newD });
        // Live position of label using current camera scale factor (base)
        const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
        const base = Math.max(0.1, worldPerPixel(inst.viewer.camera, rect.width, rect.height) * 20);
        updateOneDimPosition(inst, d, world, { du: distNx*(base + newD), dv: distNy*(base + newD) });
      }
      // Consume during drag to avoid text selection; suppress click
      e.preventDefault(); e.stopPropagation(); try { e.stopImmediatePropagation(); } catch {}
    });
    d.addEventListener('pointerup', (e) => {
      const wasDragging = dragging; dragging = false;
      try { d.releasePointerCapture(e.pointerId); } catch {}
      // Re-enable camera controls after finishing interaction
      try { if (inst.viewer?.controls) inst.viewer.controls.enabled = true; } catch {}
      if (wasDragging && moved) {
        // Finalize by re-rendering leaders + label
        try { renderDimensions(inst); } catch {}
        // Prevent generating a click when we dragged
        e.preventDefault(); e.stopPropagation(); try { e.stopImmediatePropagation(); } catch {}
      }
      // If it was a click (not moved), let the click/dblclick handlers run
    });

    // Hover should reflect in the sidebar and 3D overlays
    d.addEventListener('pointerenter', () => {
      try { inst.hoverConstraintFromLabel?.(c.id); } catch {}
    });
    d.addEventListener('pointerleave', () => {
      try { inst.clearHoverFromLabel?.(c.id); } catch {}
    });

    d.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      const v = prompt('Enter value', String(c.value ?? ''));
      if (v == null) return;
      const ph = inst?.viewer?.partHistory;
      const exprSrc = ph?.expressions || '';

      // Evaluate using the same approach as feature dialogs
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

      // If it's a plain number, store numeric. Otherwise store both expr and numeric.
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

    // Click toggles constraint selection; ignore the second click in a double-click (detail>1)
    d.addEventListener('click', (e) => {
      if (e.detail > 1) return; // let dblclick handle editing
      try { inst.toggleSelectConstraint?.(c.id); } catch {}
      e.preventDefault(); e.stopPropagation(); try { e.stopImmediatePropagation(); } catch {}
    });

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
        const offSaved = inst._dimOffsets.get(c.id) || {}; const dr = Number(offSaved.dr)||0; const dp = Number(offSaved.dp)||0;
        const label = to3(pr.x + rx*dr + nx*dp, pr.y + ry*dr + ny*dp);
        const val = Number(c.value) ?? 0;
        const txt = c.displayStyle === 'diameter' ? `⌀${(2*val).toFixed(3)}     Diameter` : `R${val.toFixed(3)}     Radius`;
        mk(c, txt, label, { du: 0, dv: 0 });
      } else if (c.points?.length >= 2) {
        const p0 = P(c.points[0]), p1 = P(c.points[1]); if (!p0 || !p1) continue;
        const nxny = (()=>{ const dx=p1.x-p0.x, dy=p1.y-p0.y; const L=Math.hypot(dx,dy)||1; const tx=dx/L, ty=dy/L; return { nx:-ty, ny:tx }; })();
        const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
        const base = Math.max(0.1, worldPerPixel(inst.viewer.camera, rect.width, rect.height) * 20);
        const offSaved = inst._dimOffsets.get(c.id) || { du:0, dv:0 };
        const d = typeof offSaved.d === 'number' ? offSaved.d : (offSaved.du||0)*nxny.nx + (offSaved.dv||0)*nxny.ny;
        const col = sel ? DIM_COLOR_SELECTED : (hov ? DIM_COLOR_HOVER : DIM_COLOR_DEFAULT);
        dimDistance3D(inst, p0, p1, c.id, col);
        mk(c, String((Number(c.value) ?? 0).toFixed(3)), to3((p0.x+p1.x)/2, (p0.y+p1.y)/2), { du: nxny.nx*(base+d), dv: nxny.ny*(base+d) });
      }
    }
    if (c.type === '∠' && c.points?.length >= 4) {
      const p0=P(c.points[0]), p1=P(c.points[1]), p2=P(c.points[2]), p3=P(c.points[3]); if (!p0||!p1||!p2||!p3) continue;
      const I = intersect(p0,p1,p2,p3);
      const col = sel ? DIM_COLOR_SELECTED : (hov ? DIM_COLOR_HOVER : DIM_COLOR_DEFAULT);
      dimAngle3D(inst, p0,p1,p2,p3,c.id,I, col);
      mk(c, String(c.value ?? ''), to3(I.x, I.y));
    } else {
      // Non-dimension constraints: collect for grouped glyph rendering
      glyphConstraints.push(c);
    }
  }

  // Render grouped glyphs (non-dimension constraints)
  try { drawConstraintGlyphs(inst, glyphConstraints); } catch {}
}

// Helpers (module-local)
function updateOneDimPosition(inst, el, world, off) {
  const du = Number(off?.du) || 0; const dv = Number(off?.dv) || 0;
  const O = inst._lock.basis.origin, X = inst._lock.basis.x, Y = inst._lock.basis.y;
  // Base world position for the label
  let w = world.clone().add(X.clone().multiplyScalar(du)).add(Y.clone().multiplyScalar(dv));
  // Compute plane coords
  try {
    const d = w.clone().sub(O);
    let u = d.dot(X.clone().normalize());
    let v = d.dot(Y.clone().normalize());
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
    // Rebuild world position from nudged (u,v)
    w = new THREE.Vector3().copy(O).addScaledVector(X, u).addScaledVector(Y, v);
  } catch {}
  const pt = w.project(inst.viewer.camera);
  const rect2 = inst.viewer.renderer.domElement.getBoundingClientRect();
  const x = (pt.x * 0.5 + 0.5) * rect2.width; const y = (-pt.y * 0.5 + 0.5) * rect2.height;
  el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px`;
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
  return { u, v: v2 };
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
  const vx=pr.x-pc.x, vy=pr.y-pc.y; const L=Math.hypot(vx,vy)||1; const rx=vx/L, ry=vy/L; const nx=-ry, ny=rx; const dr=Number(off.dr)||0; const dp=Number(off.dp)||0;
  const elbow={u: pr.x + rx*dr, v: pr.y + ry*dr}; const dogleg={u: elbow.u + nx*dp, v: elbow.v + ny*dp};
  add([{u:pc.x,v:pc.y},{u:pr.x,v:pr.y}]); add([{u:pr.x,v:pr.y}, elbow]); add([elbow, dogleg]);
  const ah = 0.06; const s=0.6; const tip={u:pr.x, v:pr.y}; const A={u: tip.u - rx*ah + nx*ah*0.6, v: tip.v - ry*ah + ny*ah*0.6}; const B={u: tip.u - rx*ah - nx*ah*0.6, v: tip.v - ry*ah - ny*ah*0.6};
  add([tip, A]); add([tip, B]);
}

export function dimAngle3D(inst, p0,p1,p2,p3,cid,I, color = 0x69a8ff) {
  const off = inst._dimOffsets.get(cid) || { du:0, dv:0 };
  const X=inst._lock.basis.x, Y=inst._lock.basis.y, O=inst._lock.basis.origin; const P=(u,v)=> new THREE.Vector3().copy(O).addScaledVector(X,u).addScaledVector(Y,v);
  const d1=new THREE.Vector2(p1.x-p0.x, p1.y-p0.y).normalize(); const d2=new THREE.Vector2(p3.x-p2.x, p3.y-p2.y).normalize();
  let a0=Math.atan2(d1.y,d1.x), a1=Math.atan2(d2.y,d2.x); let d=a1-a0; while(d<=-Math.PI)d+=2*Math.PI; while(d>Math.PI)d-=2*Math.PI;
  const r=0.6; const cx=I.x+off.du, cy=I.y+off.dv; const segs=32; const uvs=[]; for(let i=0;i<=segs;i++){ const t=a0+d*(i/segs); uvs.push({u:cx+Math.cos(t)*r, v:cy+Math.sin(t)*r}); }
  const blue=new THREE.LineBasicMaterial({color, depthTest:false, depthWrite:false, transparent:true}); const g=new THREE.BufferGeometry().setFromPoints(uvs.map(q=>P(q.u,q.v))); const ln=new THREE.Line(g, blue); ln.userData={kind:'dim',cid}; ln.renderOrder = 10020; try { ln.layers.set(31); } catch {} inst._dim3D.add(ln);
  const ah=0.06, s=0.6; const addArrowUV=(t)=>{ const tx=-Math.sin(t), ty=Math.cos(t); const wx=-ty, wy=tx; const tip={u:cx+Math.cos(t)*r, v:cy+Math.sin(t)*r}; const A={u:tip.u+tx*ah+wx*ah*s, v:tip.v+ty*ah+wy*ah*s}; const B={u:tip.u+tx*ah-wx*ah*s, v:tip.v+ty*ah-wy*ah*s}; const gg1=new THREE.BufferGeometry().setFromPoints([P(tip.u,tip.v),P(A.u,A.v)]); const gg2=new THREE.BufferGeometry().setFromPoints([P(tip.u,tip.v),P(B.u,B.v)]); const la=new THREE.Line(gg1, blue.clone()); const lb=new THREE.Line(gg2, blue.clone()); la.renderOrder = 10020; lb.renderOrder = 10020; try { la.layers.set(31); lb.layers.set(31); } catch {} inst._dim3D.add(la); inst._dim3D.add(lb); };
  addArrowUV(a0); addArrowUV(a0+d);
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

function intersect(A,B,C,D){
  const den=(A.x-B.x)*(C.y-D.y)-(A.y-B.y)*(C.x-D.x); if(Math.abs(den)<1e-9) return {x:B.x,y:B.y};
  const x=((A.x*A.y-B.x*B.y)*(C.x-D.x)-(A.x-B.x)*(C.x*C.y-D.x*D.y))/den;
  const y=((A.x*A.y-B.x*B.y)*(C.y-D.y)-(A.y-B.y)*(C.x*C.y-D.x*D.y))/den;
  return {x,y};
}
