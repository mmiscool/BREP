import * as THREE from 'three';
import { makeOverlayLine, addArrowCone, getElementDirection, objectRepresentativePoint, screenSizeWorld } from '../annUtils.js';

export const AngleDimension = {
  type: 'angle',
  title: 'Angle',
  create(pmimode) {
    const defaults = pmimode?._opts || {};
    const decimals = Number.isFinite(defaults.angleDecimals) ? (defaults.angleDecimals | 0) : 1;
    return {
      type: 'angle',
      decimals,
      elementARefName: '',
      elementBRefName: '',
      planeRefName: '',
      alignment: 'view',
      offset: 0,
      isReference: false,
      useReflexAngle: false,
      __open: true,
    };
  },
  getSchema(pmimode, ann) {
    const measured = measureAngleValueLocal(pmimode, ann);
    const dec = Number.isFinite(ann.decimals) ? ann.decimals : 1;
    const schema = {
      decimals: { type: 'number', label: 'Decimals', min: 0, max: 3, step: 1, default_value: dec },
      elementA: { type: 'reference_selection', label: 'Element A', selectionFilter: ['FACE', 'EDGE'], default_value: ann.elementARefName || '' },
      elementB: { type: 'reference_selection', label: 'Element B', selectionFilter: ['FACE', 'EDGE'], default_value: ann.elementBRefName || '' },
      planeRef: { type: 'reference_selection', label: 'Projection Plane', selectionFilter: ['FACE', 'PLANE'], default_value: ann.planeRefName || '' },
      alignment: { type: 'options', label: 'Alignment', options: ['view', 'XY', 'YZ', 'ZX'], default_value: ann.alignment || 'view' },
      offset: { type: 'number', label: 'Offset', step: 'any', default_value: (Number.isFinite(ann.offset) ? ann.offset : 0) },
      isReference: { type: 'boolean', label: 'Reference Dimension', default_value: (ann.isReference === true) },
      useReflexAngle: { type: 'boolean', label: 'Reflex Angle (>180°)', default_value: (ann.useReflexAngle === true) },
      value: { type: 'string', label: 'Angle', default_value: (() => { const v = measured; let t = (typeof v === 'number') ? `${v.toFixed(dec)}°` : '—'; if (ann.isReference && t && t !== '—') t = `(${t})`; return t; })() },
    };
    const params = { decimals: schema.decimals.default_value, elementA: schema.elementA.default_value, elementB: schema.elementB.default_value, planeRef: schema.planeRef.default_value, alignment: schema.alignment.default_value, offset: schema.offset.default_value, isReference: schema.isReference.default_value, useReflexAngle: schema.useReflexAngle.default_value, value: schema.value.default_value };
    return { schema, params };
  },

  applyParams(pmimode, ann, params) {
    ann.decimals = Math.max(0, Math.min(3, Number(params.decimals) | 0));
    ann.alignment = String(params.alignment || 'view');
    ann.elementARefName = String(params.elementA || '');
    ann.elementBRefName = String(params.elementB || '');
    ann.planeRefName = String(params.planeRef || '');
    ann.offset = Number(params.offset);
    ann.isReference = Boolean(params.isReference);
    ann.useReflexAngle = Boolean(params.useReflexAngle);
    const v = measureAngleValueLocal(pmimode, ann);
    let textVal = (typeof v === 'number') ? `${v.toFixed(ann.decimals)}°` : '—';
    if (ann.isReference && textVal && textVal !== '—') textVal = `(${textVal})`;
    let st = (typeof v === 'number') ? `${v.toFixed(ann.decimals)}°` : '';
    if (ann.isReference && st) st = `(${st})`;
    return { paramsPatch: { value: textVal }, statusText: st };
  },

  statusText(pmimode, ann) {
    const v = measureAngleValueLocal(pmimode, ann);
    if (typeof v !== 'number') return '';
    const dec = Number.isFinite(ann.decimals) ? ann.decimals : 1;
    let st = `${v.toFixed(dec)}°`;
    if (ann.isReference) st = `(${st})`;
    return st;
  },

  render3D(pmimode, group, ann, idx, ctx) {
    try {
      // Compute angle elements locally
      const elements = computeAngleElementsWithGeometry(pmimode, ann);
      if (!elements || !elements.dirA || !elements.dirB) return;

      const color = 0xf59e0b;
      const { N, P, A_p, B_p, A_d, B_d, V2, basis } = elements.__2d;

      // Radius for arc
      let R;
      if (ann.labelWorld) {
        const Lw = new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
        const L2 = to2D(projectPointToPlane(Lw, P, N), P, basis);
        R = L2.clone().sub(V2).length();
      }
      if (!Number.isFinite(R) || R <= 0) R = Number(ann.offset);
      if (!Number.isFinite(R) || R <= 0) R = ctx.screenSizeWorld ? ctx.screenSizeWorld(40) : 0.2;

      // Sweep direction and arc samples
      const dot = Math.max(-1, Math.min(1, A_d.dot(B_d)));
      const crossZ = A_d.x * B_d.y - A_d.y * B_d.x;
      const signed = Math.atan2(crossZ, dot);
      const base = Math.abs(signed);
      const useReflex = Boolean(ann.useReflexAngle);
      const sweep = useReflex ? (2 * Math.PI - base) : base;
      const rotSign = useReflex ? -Math.sign(signed || 1) : Math.sign(signed || 1);

      const steps = Math.max(24, Math.floor(sweep * 48));
      const points3 = [];
      for (let i = 0; i <= steps; i++) {
        const t = (sweep * i / steps) * rotSign;
        const ct = Math.cos(t), st = Math.sin(t);
        const dir2 = new THREE.Vector2(A_d.x * ct - A_d.y * st, A_d.x * st + A_d.y * ct);
        const p2 = new THREE.Vector2(V2.x + dir2.x * R, V2.y + dir2.y * R);
        points3.push(from2D(p2, P, basis));
      }
      if (points3.length > 0) {
        const end2 = new THREE.Vector2(V2.x + B_d.x * R, V2.y + B_d.y * R);
        points3[points3.length - 1] = from2D(end2, P, basis);
      }
      for (let i = 0; i < points3.length - 1; i++) group.add(makeOverlayLine(points3[i], points3[i + 1], color));

      // Arrowheads
      try {
        const arrowLength = ctx.screenSizeWorld ? ctx.screenSizeWorld(12) : 0.08;
        const arrowWidth = ctx.screenSizeWorld ? ctx.screenSizeWorld(4) : 0.03;
        if (points3.length >= 2) {
          const startTip = points3[0];
          const startTan = points3[0].clone().sub(points3[1]).normalize();
          addArrowCone(group, startTip, startTan, arrowLength, arrowWidth, color);
          const endTip = points3[points3.length - 1];
          const endTan = points3[points3.length - 1].clone().sub(points3[points3.length - 2]).normalize();
          addArrowCone(group, endTip, endTan, arrowLength, arrowWidth, color);
        }
      } catch { }

      // Legs and stubs
      const ext = Math.max(ctx.screenSizeWorld ? ctx.screenSizeWorld(10) : 0.04, R * 1.05);
      const stub = ctx.screenSizeWorld ? ctx.screenSizeWorld(12) : 0.06;
      const V3 = from2D(V2, P, basis);
      const A1 = from2D(new THREE.Vector2(V2.x + A_d.x * ext, V2.y + A_d.y * ext), P, basis);
      const B1 = from2D(new THREE.Vector2(V2.x + B_d.x * ext, V2.y + B_d.y * ext), P, basis);
      const A0 = from2D(new THREE.Vector2(V2.x - A_d.x * stub, V2.y - A_d.y * stub), P, basis);
      const B0 = from2D(new THREE.Vector2(V2.x - B_d.x * stub, V2.y - B_d.y * stub), P, basis);
      group.add(makeOverlayLine(V3, A1, color));
      group.add(makeOverlayLine(V3, B1, color));
      group.add(makeOverlayLine(V3, A0, color));
      group.add(makeOverlayLine(V3, B0, color));

      // Label
      const dec = Number.isFinite(ann.decimals) ? ann.decimals : 1;
      const angleValue = measureAngleValueLocal(pmimode, ann);
      if (typeof angleValue === 'number') {
        const labelPos = ann.labelWorld ? new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z) : computeAngleLabelPosition(pmimode, ann, elements);
        const raw = `${angleValue.toFixed(dec)}°`; const txt = ctx.formatReferenceLabel ? ctx.formatReferenceLabel(ann, raw) : raw;
        if (labelPos) ctx.updateLabel(idx, txt, labelPos, ann);
      }
    } catch { }
  },

  getLabelWorld(pmimode, ann, ctx) {
    try {
      if (ann.labelWorld) return new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
      const elements = computeAngleElementsWithGeometry(pmimode, ann);
      if (!elements) return null;
      return computeAngleLabelPosition(pmimode, ann, elements);
    } catch { return null; }
  },

  onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const v = pmimode.viewer; const cam = v?.camera; if (!cam) return;
      const elements = computeAngleElementsWithGeometry(pmimode, ann);
      if (!elements) return;
      const planeInfo = resolveAnglePlane(pmimode, ann, elements);
      const normal = planeInfo?.n || (ctx.alignNormal ? ctx.alignNormal(ann.alignment || 'view', ann) : new THREE.Vector3(0, 0, 1));
      // choose a representative point on plane
      const P = planeInfo?.p || (elements.pointA && elements.pointB ? new THREE.Vector3().addVectors(elements.pointA, elements.pointB).multiplyScalar(0.5) : new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, P);
      const onMove = (ev) => {
        const ray = ctx.raycastFromEvent ? ctx.raycastFromEvent(ev) : null; if (!ray) return;
        const out = new THREE.Vector3();
        if (ray.intersectPlane(plane, out)) {
          ann.labelWorld = { x: out.x, y: out.y, z: out.z };
          try { ctx.updateLabel(idx, null, out, ann); } catch { }
          try { pmimode.refreshAnnotationsUI?.(); } catch { }
        }
      };
      const onUp = (ev) => {
        try { window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); } catch { }
        try { if (pmimode.viewer?.controls) pmimode.viewer.controls.enabled = (pmimode._tool === 'select'); } catch { }
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch { }
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    } catch { }
  },
};

// ---- Local helpers (moved from PMIMode) ----
function projectPointToPlane(point, planePoint, planeNormal) {
  const d = point.clone().sub(planePoint).dot(planeNormal);
  return point.clone().sub(planeNormal.clone().multiplyScalar(d));
}

function computeAngleElementsWithGeometry(pmimode, ann) {
  try {
    const elements = computeAngleElements(pmimode, ann);
    if (!elements || !elements.dirA || !elements.dirB) return null;
    const { n: N, p: P } = resolveAnglePlane(pmimode, ann, elements);
    const lineA = lineInPlaneForElementRef(pmimode, ann.elementARefName, N, P);
    const lineB = lineInPlaneForElementRef(pmimode, ann.elementBRefName, N, P);
    if (!lineA || !lineB) return null;
    const basis = planeBasis(N, lineA.d);
    const A_p = to2D(lineA.p, P, basis);
    const B_p = to2D(lineB.p, P, basis);
    const A_d = dirTo2D(lineA.d, basis).normalize();
    const B_d = dirTo2D(lineB.d, basis).normalize();
    let V2 = intersectLines2D(A_p, A_d, B_p, B_d);
    if (!V2) V2 = new THREE.Vector2().addVectors(A_p, B_p).multiplyScalar(0.5);
    return { ...elements, __2d: { N, P, basis, A_p, B_p, A_d, B_d, V2 } };
  } catch { return null; }
}

function computeAngleElements(pmimode, a) {
  try {
    const scene = pmimode?.viewer?.partHistory?.scene;
    if (!scene) return null;
    const objA = a.elementARefName ? scene.getObjectByName(a.elementARefName) : null;
    const objB = a.elementBRefName ? scene.getObjectByName(a.elementBRefName) : null;
    if (!objA || !objB) return null;
    const dirA = getElementDirection(pmimode.viewer, objA);
    const dirB = getElementDirection(pmimode.viewer, objB);
    const pointA = objectRepresentativePoint(pmimode.viewer, objA);
    const pointB = objectRepresentativePoint(pmimode.viewer, objB);
    let plane = null;
    if (a.planeRefName) {
      const planeObj = scene.getObjectByName(a.planeRefName);
      if (planeObj) plane = getElementDirection(pmimode.viewer, planeObj);
    }
    return { dirA, dirB, pointA, pointB, plane };
  } catch { return null; }
}

function resolveAnglePlane(pmimode, ann, elements) {
  try {
    if (ann?.planeRefName) {
      const planeObj = pmimode.viewer?.partHistory?.scene?.getObjectByName(ann.planeRefName);
      if (planeObj) {
        const n = getElementDirection(pmimode.viewer, planeObj) || new THREE.Vector3(0, 0, 1);
        if (n.lengthSq() > 1e-12) {
          const p = objectRepresentativePoint(pmimode.viewer, planeObj) || new THREE.Vector3();
          return { n: n.clone().normalize(), p };
        }
      }
    }
    const n2 = elements?.plane || alignNormal(pmimode, ann?.alignment || 'view', ann) || new THREE.Vector3(0, 0, 1);
    const p2 = (elements?.pointA && elements?.pointB) ? new THREE.Vector3().addVectors(elements.pointA, elements.pointB).multiplyScalar(0.5) : new THREE.Vector3();
    return { n: n2.clone().normalize(), p: p2 };
  } catch { return { n: new THREE.Vector3(0, 0, 1), p: new THREE.Vector3() }; }
}

function alignNormal(pmimode, alignment, ann) {
  try {
    const name = ann?.planeRefName || '';
    if (name) {
      const scene = pmimode.viewer?.partHistory?.scene;
      const obj = scene?.getObjectByName(name);
      if (obj) {
        if (obj.type === 'FACE' && typeof obj.getAverageNormal === 'function') {
          const local = obj.getAverageNormal().clone();
          const nm = new THREE.Matrix3(); nm.getNormalMatrix(obj.matrixWorld);
          return local.applyMatrix3(nm).normalize();
        }
        const w = new THREE.Vector3(0, 0, 1); obj.updateMatrixWorld(true); w.applyMatrix3(new THREE.Matrix3().getNormalMatrix(obj.matrixWorld)); if (w.lengthSq()) return w.normalize();
      }
    }
  } catch { }
  const mode = String(alignment || 'view').toLowerCase();
  if (mode === 'xy') return new THREE.Vector3(0, 0, 1);
  if (mode === 'yz') return new THREE.Vector3(1, 0, 0);
  if (mode === 'zx') return new THREE.Vector3(0, 1, 0);
  const n = new THREE.Vector3(); try { pmimode.viewer?.camera?.getWorldDirection?.(n); } catch { }
  return n.lengthSq() ? n : new THREE.Vector3(0, 0, 1);
}

function planeBasis(normal, preferDir) {
  const N = normal.clone().normalize();
  let U = (preferDir ? preferDir.clone() : new THREE.Vector3(1, 0, 0)).projectOnPlane(N);
  if (U.lengthSq() < 1e-12) U = Math.abs(N.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(N) : new THREE.Vector3(0, 1, 0).cross(N);
  U.normalize();
  const V = new THREE.Vector3().crossVectors(N, U).normalize();
  return { U, V, N };
}

function to2D(point, planePoint, basis) {
  const r = point.clone().sub(planePoint);
  return new THREE.Vector2(r.dot(basis.U), r.dot(basis.V));
}
function dirTo2D(dir, basis) { return new THREE.Vector2(dir.dot(basis.U), dir.dot(basis.V)); }
function from2D(p2, planePoint, basis) { return planePoint.clone().add(basis.U.clone().multiplyScalar(p2.x)).add(basis.V.clone().multiplyScalar(p2.y)); }
function intersectLines2D(p1, d1, p2, d2) {
  const cross = d1.x * d2.y - d1.y * d2.x; if (Math.abs(cross) < 1e-12) return null; const v = new THREE.Vector2().subVectors(p2, p1); const t = (v.x * d2.y - v.y * d2.x) / cross; return new THREE.Vector2(p1.x + d1.x * t, p1.y + d1.y * t);
}

function computeAngleLabelPosition(pmimode, ann, elements) {
  try {
    const { N, P, A_d, B_d, V2, basis } = elements.__2d;
    let bis2 = new THREE.Vector2().addVectors(A_d, B_d);
    if (bis2.lengthSq() < 1e-10) bis2.set(-A_d.y, A_d.x); else bis2.normalize();
    if (ann.useReflexAngle) bis2.multiplyScalar(-1);
    let off = Number(ann?.offset);
    const ssw = (px) => { try { return screenSizeWorld(pmimode?.viewer, px); } catch { return 0.06; } };
    if (!Number.isFinite(off) || off <= 0) off = ssw(60); else off = off + ssw(20);
    const L2 = new THREE.Vector2(V2.x + bis2.x * off, V2.y + bis2.y * off);
    return from2D(L2, P, basis);
  } catch { return new THREE.Vector3(); }
}

function measureAngleValueLocal(pmimode, a) {
  try {
    const elements = computeAngleElements(pmimode, a);
    const { n: N } = resolveAnglePlane(pmimode, a, elements);
    const lineA = lineInPlaneForElementRef(pmimode, a.elementARefName, N, objectRepresentativePoint(pmimode.viewer, pmimode.viewer?.partHistory?.scene?.getObjectByName(a.elementARefName)) || new THREE.Vector3());
    const lineB = lineInPlaneForElementRef(pmimode, a.elementBRefName, N, objectRepresentativePoint(pmimode.viewer, pmimode.viewer?.partHistory?.scene?.getObjectByName(a.elementBRefName)) || new THREE.Vector3());
    if (!lineA || !lineB) return null;
    const basis = planeBasis(N, lineA.d);
    const dA2 = dirTo2D(lineA.d, basis).normalize();
    const dB2 = dirTo2D(lineB.d, basis).normalize();
    const dot = Math.max(-1, Math.min(1, dA2.dot(dB2)));
    let angle = Math.acos(dot) * 180 / Math.PI;
    if (a.useReflexAngle) angle = 360 - angle;
    return angle;
  } catch { return null; }
}
