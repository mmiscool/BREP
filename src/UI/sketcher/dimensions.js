import * as THREE from 'three';
import { drawConstraintGlyph } from './glyphs.js';

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
  const labels = Array.from(inst._dimRoot.querySelectorAll('.dim-label'));
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

    // Drag support
    let dragging = false, sx = 0, sy = 0, start = {};
    d.addEventListener('pointerdown', (e) => {
      dragging = true;
      const uv = pointerToPlaneUV(inst, e);
      sx = uv?.u || 0; sy = uv?.v || 0;
      start = { ...(inst._dimOffsets.get(c.id) || {}) };
      try { d.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault(); e.stopPropagation();
    });
    d.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const uv = pointerToPlaneUV(inst, e); if (!uv) return;
      if (c.type === '⟺' && c.displayStyle === 'radius' && Array.isArray(c.points) && c.points.length >= 2) {
        const sObj = inst._solver.sketchObject;
        const pc = sObj.points.find((p) => p.id === c.points[0]);
        const pr = sObj.points.find((p) => p.id === c.points[1]);
        if (!pc || !pr) return;
        const vx = pr.x - pc.x, vy = pr.y - pc.y; const L = Math.hypot(vx, vy) || 1; const rx = vx/L, ry = vy/L; const nx = -ry, ny = rx;
        const baseU = pr.x + (Number(start.dr)||0)*rx + (Number(start.dp)||0)*nx;
        const baseV = pr.y + (Number(start.dr)||0)*ry + (Number(start.dp)||0)*ny;
        const du = uv.u - baseU; const dv = uv.v - baseV;
        const dr = (Number(start.dr)||0) + (du*rx + dv*ry);
        const dp = (Number(start.dp)||0) + (du*nx + dv*ny);
        inst._dimOffsets.set(c.id, { dr, dp });
        const labelOff = { du: rx*dr + nx*dp, dv: ry*dr + ny*dp };
        updateOneDimPosition(inst, d, world, labelOff);
        renderDimensions(inst);
      } else {
        const du = (Number(start.du)||0) + (uv.u - sx);
        const dv = (Number(start.dv)||0) + (uv.v - sy);
        inst._dimOffsets.set(c.id, { du, dv });
        updateOneDimPosition(inst, d, world, { du, dv });
        renderDimensions(inst);
      }
      e.preventDefault(); e.stopPropagation();
    });
    d.addEventListener('pointerup', (e) => {
      dragging = false;
      try { d.releasePointerCapture(e.pointerId); } catch {}
      e.preventDefault(); e.stopPropagation();
    });

    d.addEventListener('dblclick', (e) => {
      e.preventDefault(); e.stopPropagation();
      const v = prompt('Enter value', String(c.value ?? ''));
      if (v == null) return; const num = parseFloat(v); if (!Number.isFinite(num)) return;
      c.value = num; try { inst._solver.solveSketch('full'); } catch {}
      try { inst._solver?.hooks?.updateCanvas?.(); } catch {}
    });

    inst._dimRoot.appendChild(d);
    const saved = inst._dimOffsets.get(c.id) || { du: 0, dv: 0 };
    const off = planeOffOverride || saved;
    updateOneDimPosition(inst, d, world, off);
  };

  for (const c of s.constraints || []) {
    if (c.type === '⟺') {
      if (c.displayStyle === 'radius' && c.points?.length >= 2) {
        const pc = P(c.points[0]), pr = P(c.points[1]); if (!pc || !pr) continue;
        dimRadius3D(inst, pc, pr, c.id);
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
        dimDistance3D(inst, p0, p1, c.id);
        mk(c, String((Number(c.value) ?? 0).toFixed(3)), to3((p0.x+p1.x)/2, (p0.y+p1.y)/2), { du: nxny.nx*(base+d), dv: nxny.ny*(base+d) });
      }
    }
    if (c.type === '∠' && c.points?.length >= 4) {
      const p0=P(c.points[0]), p1=P(c.points[1]), p2=P(c.points[2]), p3=P(c.points[3]); if (!p0||!p1||!p2||!p3) continue;
      const I = intersect(p0,p1,p2,p3);
      dimAngle3D(inst, p0,p1,p2,p3,c.id,I);
      mk(c, String(c.value ?? ''), to3(I.x, I.y));
    }
    // other constraints glyphs
    try { drawConstraintGlyph(inst, c); } catch {}
  }
}

// Helpers (module-local)
function updateOneDimPosition(inst, el, world, off) {
  const du = Number(off?.du) || 0; const dv = Number(off?.dv) || 0;
  const w = world.clone().add(inst._lock.basis.x.clone().multiplyScalar(du)).add(inst._lock.basis.y.clone().multiplyScalar(dv));
  const pt = w.project(inst.viewer.camera);
  const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
  const x = (pt.x * 0.5 + 0.5) * rect.width; const y = (-pt.y * 0.5 + 0.5) * rect.height;
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

export function dimDistance3D(inst, p0, p1, cid) {
  const off = inst._dimOffsets.get(cid) || { du:0, dv:0 };
  const X = inst._lock.basis.x, Y = inst._lock.basis.y, O = inst._lock.basis.origin;
  const u0=p0.x, v0=p0.y, u1=p1.x, v1=p1.y; const dx=u1-u0, dy=v1-v0; const L=Math.hypot(dx,dy)||1; const tx=dx/L, ty=dy/L; const nx=-ty, ny=tx;
  const rect = inst.viewer.renderer.domElement.getBoundingClientRect();
  const base = Math.max(0.1, worldPerPixel(inst.viewer.camera, rect.width, rect.height) * 20);
  const d = typeof off.d === 'number' ? off.d : (off.du||0)*nx + (off.dv||0)*ny;
  const ou = nx*(base+d), ov = ny*(base+d);
  const P = (u,v)=> new THREE.Vector3().copy(O).addScaledVector(X,u).addScaledVector(Y,v);
  const addLine=(pts,mat)=>{ const g=new THREE.BufferGeometry().setFromPoints(pts.map(p=>P(p.u,p.v))); const ln=new THREE.Line(g,mat); ln.userData={kind:'dim',cid}; inst._dim3D.add(ln); };
  const green=new THREE.LineBasicMaterial({color:0x67e667});
  addLine([{u:u0+ou,v:v0+ov},{u:u1+ou,v:v1+ov}], green);
  addLine([{u:u0,v:v0},{u:u0+ou,v:v0+ov}], green.clone());
  addLine([{u:u1,v:v1},{u:u1+ou,v:v1+ov}], green.clone());
  const ah = Math.max(0.06, worldPerPixel(inst.viewer.camera, rect.width, rect.height) * 6);
  const s = 0.6; const arrow=(ux,vy,dir)=>{ const tip={u:ux+ou,v:vy+ov}; const ax=dir*tx, ay=dir*ty; const wx=-ay, wy=ax; const A={u:tip.u+ax*ah+wx*ah*s,v:tip.v+ay*ah+wy*ah*s}; const B={u:tip.u+ax*ah-wx*ah*s,v:tip.v+ay*ah-wy*ah*s}; addLine([{u:tip.u,v:tip.v},A], green.clone()); addLine([{u:tip.u,v:tip.v},B], green.clone()); };
  arrow(u0,v0,1); arrow(u1,v1,-1);
}

export function dimRadius3D(inst, pc, pr, cid) {
  const off = inst._dimOffsets.get(cid) || {};
  const X = inst._lock.basis.x, Y = inst._lock.basis.y, O = inst._lock.basis.origin;
  const P=(u,v)=> new THREE.Vector3().copy(O).addScaledVector(X,u).addScaledVector(Y,v);
  const blue=new THREE.LineBasicMaterial({ color:0x69a8ff });
  const add=(uvs)=>{ const g=new THREE.BufferGeometry().setFromPoints(uvs.map(q=>P(q.u,q.v))); const ln=new THREE.Line(g, blue); ln.userData={kind:'dim',cid}; inst._dim3D.add(ln); };
  const vx=pr.x-pc.x, vy=pr.y-pc.y; const L=Math.hypot(vx,vy)||1; const rx=vx/L, ry=vy/L; const nx=-ry, ny=rx; const dr=Number(off.dr)||0; const dp=Number(off.dp)||0;
  const elbow={u: pr.x + rx*dr, v: pr.y + ry*dr}; const dogleg={u: elbow.u + nx*dp, v: elbow.v + ny*dp};
  add([{u:pc.x,v:pc.y},{u:pr.x,v:pr.y}]); add([{u:pr.x,v:pr.y}, elbow]); add([elbow, dogleg]);
  const ah = 0.06; const s=0.6; const tip={u:pr.x, v:pr.y}; const A={u: tip.u - rx*ah + nx*ah*0.6, v: tip.v - ry*ah + ny*ah*0.6}; const B={u: tip.u - rx*ah - nx*ah*0.6, v: tip.v - ry*ah - ny*ah*0.6};
  add([tip, A]); add([tip, B]);
}

export function dimAngle3D(inst, p0,p1,p2,p3,cid,I) {
  const off = inst._dimOffsets.get(cid) || { du:0, dv:0 };
  const X=inst._lock.basis.x, Y=inst._lock.basis.y, O=inst._lock.basis.origin; const P=(u,v)=> new THREE.Vector3().copy(O).addScaledVector(X,u).addScaledVector(Y,v);
  const d1=new THREE.Vector2(p1.x-p0.x, p1.y-p0.y).normalize(); const d2=new THREE.Vector2(p3.x-p2.x, p3.y-p2.y).normalize();
  let a0=Math.atan2(d1.y,d1.x), a1=Math.atan2(d2.y,d2.x); let d=a1-a0; while(d<=-Math.PI)d+=2*Math.PI; while(d>Math.PI)d-=2*Math.PI;
  const r=0.6; const cx=I.x+off.du, cy=I.y+off.dv; const segs=32; const uvs=[]; for(let i=0;i<=segs;i++){ const t=a0+d*(i/segs); uvs.push({u:cx+Math.cos(t)*r, v:cy+Math.sin(t)*r}); }
  const blue=new THREE.LineBasicMaterial({color:0x69a8ff}); const g=new THREE.BufferGeometry().setFromPoints(uvs.map(q=>P(q.u,q.v))); const ln=new THREE.Line(g, blue); ln.userData={kind:'dim',cid}; inst._dim3D.add(ln);
  const ah=0.06, s=0.6; const addArrowUV=(t)=>{ const tx=-Math.sin(t), ty=Math.cos(t); const wx=-ty, wy=tx; const tip={u:cx+Math.cos(t)*r, v:cy+Math.sin(t)*r}; const A={u:tip.u+tx*ah+wx*ah*s, v:tip.v+ty*ah+wy*ah*s}; const B={u:tip.u+tx*ah-wx*ah*s, v:tip.v+ty*ah-wy*ah*s}; const gg1=new THREE.BufferGeometry().setFromPoints([P(tip.u,tip.v),P(A.u,A.v)]); const gg2=new THREE.BufferGeometry().setFromPoints([P(tip.u,tip.v),P(B.u,B.v)]); inst._dim3D.add(new THREE.Line(gg1, blue.clone())); inst._dim3D.add(new THREE.Line(gg2, blue.clone())); };
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
