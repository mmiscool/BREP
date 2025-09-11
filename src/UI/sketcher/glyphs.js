import * as THREE from 'three';

// Draw small glyphs to visualize non-dimension constraints on the sketch plane.
// Expects `inst` to be a SketchMode3D instance with fields: viewer, _dim3D, _lock, _solver
export function drawConstraintGlyph(inst, c) {
  if (!inst || !inst._dim3D || !inst._lock || !inst._solver) return;
  const s = inst._solver.sketchObject;
  const to3 = (u, v) => new THREE.Vector3()
    .copy(inst._lock.basis.origin)
    .addScaledVector(inst._lock.basis.x, u)
    .addScaledVector(inst._lock.basis.y, v);
  const addLine = (u0, v0, u1, v1, color = 0x69a8ff) => {
    const g = new THREE.BufferGeometry().setFromPoints([to3(u0, v0), to3(u1, v1)]);
    const m = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
    const ln = new THREE.Line(g, m);
    ln.userData = { kind: 'dim', cid: c.id };
    ln.renderOrder = 10020;
    try { ln.layers.set(31); } catch {}
    inst._dim3D.add(ln);
  };
  const addRing = (u, v, r, color = 0x69a8ff) => {
    const seg = 20; const pts = [];
    for (let i = 0; i <= seg; i++) { const t = (i / seg) * Math.PI * 2; pts.push(to3(u + r * Math.cos(t), v + r * Math.sin(t))); }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
    const ln = new THREE.Line(g, m);
    ln.userData = { kind: 'dim', cid: c.id };
    ln.renderOrder = 10020;
    try { ln.layers.set(31); } catch {}
    inst._dim3D.add(ln);
  };
  const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
  const wpp = worldPerPixel(inst.viewer.camera, rect.width, rect.height);
  const base = Math.max(0.1, wpp * 14);
  const P = (id) => s.points.find((p) => p.id === id);
  const mid = (a, b) => ({ u: (a.x + b.x) / 2, v: (a.y + b.y) / 2 });
  const dir = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y; const L = Math.hypot(dx, dy) || 1; return { tx: dx / L, ty: dy / L, nx: -dy / L, ny: dx / L }; };
  const proj = (A, B, C) => { const d = dir(A, B); const vx = C.x - A.x, vy = C.y - A.y; const t = vx * d.tx + vy * d.ty; return { u: A.x + t * d.tx, v: A.y + t * d.ty, nx: d.nx, ny: d.ny }; };

  try {
    if (c.type === '⟺' || c.type === '∠') return; // dimensions handled elsewhere
    if (c.type === '━' && (c.points || []).length >= 2) {
      const a = P(c.points[0]), b = P(c.points[1]); if (!a || !b) return; const m = mid(a, b);
      addLine(m.u - base * 0.6, m.v, m.u + base * 0.6, m.v);
    } else if (c.type === '│' && (c.points || []).length >= 2) {
      const a = P(c.points[0]), b = P(c.points[1]); if (!a || !b) return; const m = mid(a, b);
      addLine(m.u, m.v - base * 0.6, m.u, m.v + base * 0.6);
    } else if (c.type === '≡' && (c.points || []).length >= 2) {
      const p = P(c.points[0]); if (!p) return; addRing(p.x, p.y, base * 0.5);
    } else if (c.type === '⏛' && (c.points || []).length >= 3) {
      const A = P(c.points[0]), B = P(c.points[1]), C = P(c.points[2]); if (!A || !B || !C) return; const F = proj(A, B, C);
      addLine(C.x, C.y, F.u, F.v);
      addLine(F.u - F.nx * base * 0.25, F.v - F.ny * base * 0.25, F.u + F.nx * base * 0.25, F.v + F.ny * base * 0.25);
    } else if (c.type === '∥' && (c.points || []).length >= 4) {
      const A = P(c.points[0]), B = P(c.points[1]), C = P(c.points[2]), D = P(c.points[3]); if (!A || !B || !C || !D) return; const m1 = mid(A, B), d1 = dir(A, B); const m2 = mid(C, D), d2 = dir(C, D);
      addLine(m1.u - d1.tx * base * 0.6, m1.v - d1.ty * base * 0.6, m1.u + d1.tx * base * 0.6, m1.v + d1.ty * base * 0.6);
      addLine(m2.u - d2.tx * base * 0.6, m2.v - d2.ty * base * 0.6, m2.u + d2.tx * base * 0.6, m2.v + d2.ty * base * 0.6);
    } else if (c.type === '⟂' && (c.points || []).length >= 4) {
      const A = P(c.points[0]), B = P(c.points[1]), C = P(c.points[2]), D = P(c.points[3]); if (!A || !B || !C || !D) return; const m1 = mid(A, B); const d1 = dir(A, B); const d2 = dir(C, D);
      addLine(m1.u, m1.v, m1.u + d1.tx * base * 0.6, m1.v + d1.ty * base * 0.6);
      addLine(m1.u, m1.v, m1.u + d2.tx * base * 0.6, m1.v + d2.ty * base * 0.6);
    } else if (c.type === '⏚' && (c.points || []).length >= 1) {
      const p = P(c.points[0]); if (!p) return;
      addLine(p.x - base * 0.45, p.y, p.x + base * 0.45, p.y);
      addLine(p.x, p.y - base * 0.45, p.x, p.y + base * 0.45);
    } else if (c.type === '⋯' && (c.points || []).length >= 3) {
      const A = P(c.points[0]), B = P(c.points[1]), M = P(c.points[2]); if (!A || !B || !M) return; const d = dir(A, B); const r = base * 0.5;
      const u1 = M.x + d.nx * r, v1 = M.y + d.ny * r;
      const u2 = M.x - d.nx * r * 0.75 + d.tx * r * 0.75, v2 = M.y - d.ny * r * 0.75 + d.ty * r * 0.75;
      const u3 = M.x - d.nx * r * 0.75 - d.tx * r * 0.75, v3 = M.y - d.ny * r * 0.75 - d.ty * r * 0.75;
      addLine(u1, v1, u2, v2); addLine(u2, v2, u3, v3); addLine(u3, v3, u1, v1);
    }
  } catch {}
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
