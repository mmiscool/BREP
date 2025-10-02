import * as THREE from 'three';
import { makeOverlayLine, addArrowCone, objectRepresentativePoint } from '../annUtils.js';

export const LinearDimension = {
  type: 'dim',
  title: 'Linear',
  create(pmimode) {
    const defaults = pmimode?._opts || {};
    const decimals = Number.isFinite(defaults.dimDecimals) ? (defaults.dimDecimals | 0) : 3;
    return {
      type: 'dim',
      decimals,
      aRefName: '',
      bRefName: '',
      planeRefName: '',
      alignment: 'view',
      isReference: false,
      __open: true,
    };
  },
  getSchema(pmimode, ann) {
    const pts = computeDimPointsLocal(pmimode, ann);
    const measured = (pts && pts.p0 && pts.p1) ? pts.p0.distanceTo(pts.p1) : null;
    const decD = Number.isFinite(ann.decimals) ? ann.decimals : (pmimode?._opts?.dimDecimals | 0);
    const schema = {
      decimals: { type: 'number', label: 'Decimals', min: 0, max: 8, step: 1, default_value: decD },
      anchorA: { type: 'reference_selection', label: 'Point A', selectionFilter: ['VERTEX'], default_value: ann.aRefName || '' },
      anchorB: { type: 'reference_selection', label: 'Point B', selectionFilter: ['VERTEX'], default_value: ann.bRefName || '' },
      planeRef: { type: 'reference_selection', label: 'Face/Plane', selectionFilter: ['FACE', 'PLANE'], default_value: ann.planeRefName || '' },
      alignment: { type: 'options', label: 'Alignment', options: ['view', 'XY', 'YZ', 'ZX'], default_value: ann.alignment || 'view' },
      offset: { type: 'number', label: 'Offset', step: 'any', default_value: (Number.isFinite(ann.offset) ? ann.offset : 0) },
      showExt: { type: 'boolean', label: 'Extension Lines', default_value: (ann.showExt !== false) },
      isReference: { type: 'boolean', label: 'Reference Dimension', default_value: (ann.isReference === true) },
      value: { type: 'string', label: 'Value', default_value: (() => { const v = measured; let t = (typeof v === 'number') ? `${v.toFixed(decD)} (wu)` : '—'; if (ann.isReference && t && t !== '—') t = `(${t})`; return t; })() },
    };
    const params = { decimals: schema.decimals.default_value, anchorA: schema.anchorA.default_value, anchorB: schema.anchorB.default_value, planeRef: schema.planeRef.default_value, alignment: schema.alignment.default_value, offset: schema.offset.default_value, showExt: schema.showExt.default_value, isReference: schema.isReference.default_value, value: schema.value.default_value };
    return { schema, params };
  },

  applyParams(pmimode, ann, params) {
    ann.decimals = Math.max(0, Math.min(8, Number(params.decimals) | 0));
    ann.alignment = String(params.alignment || 'view');
    ann.aRefName = String(params.anchorA || '');
    ann.bRefName = String(params.anchorB || '');
    ann.planeRefName = String(params.planeRef || '');
    ann.offset = Number(params.offset);
    ann.showExt = Boolean(params.showExt);
    ann.isReference = Boolean(params.isReference);
    const pts = computeDimPointsLocal(pmimode, ann);
    const v = (pts && pts.p0 && pts.p1) ? pts.p0.distanceTo(pts.p1) : null;
    let textVal = (typeof v === 'number') ? `${v.toFixed(ann.decimals)} (wu)` : '—';
    if (ann.isReference && textVal && textVal !== '—') textVal = `(${textVal})`;
    const statusText = (typeof v === 'number') ? (ann.isReference ? `(${v.toFixed(ann.decimals)} (wu))` : `${v.toFixed(ann.decimals)} (wu)`) : '';
    return { paramsPatch: { value: textVal }, statusText };
  },

  statusText(pmimode, ann) {
    const pts = computeDimPointsLocal(pmimode, ann);
    const v = (pts && pts.p0 && pts.p1) ? pts.p0.distanceTo(pts.p1) : null;
    if (typeof v !== 'number') return '';
    const dec = Number.isFinite(ann.decimals) ? ann.decimals : (pmimode?._opts?.dimDecimals | 0);
    let st = `${v.toFixed(dec)} (wu)`;
    if (ann.isReference) st = `(${st})`;
    return st;
  },

  render3D(pmimode, group, ann, idx, ctx) {
    // Compute end points locally
    const { p0, p1 } = computeDimPointsLocal(pmimode, ann);

    try {
      const color = 0x10b981;
      const normal = ctx.alignNormal ? ctx.alignNormal(ann?.alignment || 'view', ann) : new THREE.Vector3(0,0,1);
      const dir = new THREE.Vector3().subVectors(p1, p0).normalize();
      const t = new THREE.Vector3().crossVectors(normal, dir).normalize();

      let off = Number(ann?.offset);
      if (!Number.isFinite(off)) off = ctx.screenSizeWorld ? ctx.screenSizeWorld(20) : 0.05;
      const p0o = p0.clone().addScaledVector(t, off);
      const p1o = p1.clone().addScaledVector(t, off);
      if (ann?.showExt !== false && off !== 0) {
        group.add(makeOverlayLine(p0, p0o, color));
        group.add(makeOverlayLine(p1, p1o, color));
      }
      group.add(makeOverlayLine(p0o, p1o, color));

      const arrowLength = ctx.screenSizeWorld ? ctx.screenSizeWorld(12) : 0.08;
      const arrowWidth = ctx.screenSizeWorld ? ctx.screenSizeWorld(4) : 0.03;
      addArrowCone(group, p0o, dir.clone().negate().normalize(), arrowLength, arrowWidth, color);
      addArrowCone(group, p1o, dir.clone().normalize(), arrowLength, arrowWidth, color);

      // Extension from offset line to dragged label if applicable
      try {
        if (ann.labelWorld) {
          const labelPos = new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
          const lineLen = p0o.distanceTo(p1o);
          if (lineLen > 1e-6) {
            const toLabel = labelPos.clone().sub(p0o);
            const along = toLabel.dot(dir);
            const clamped = Math.max(0, Math.min(lineLen, along));
            const nearest = p0o.clone().addScaledVector(dir, clamped);
            const perpDist = labelPos.distanceTo(nearest);
            const threshold = ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : 0.02;
            if (perpDist > threshold) group.add(makeOverlayLine(nearest, labelPos, color));
          }
        }
      } catch {}

      // Label at midpoint if not overridden
      try {
        if (!ann.labelWorld) {
          const mid = new THREE.Vector3().addVectors(p0o, p1o).multiplyScalar(0.5).addScaledVector(t, (ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : 0.02));
          const dec = Number.isFinite(ann.decimals) ? ann.decimals : (pmimode?._opts?.dimDecimals | 0);
          const val = p0.distanceTo(p1);
          ctx.updateLabel(idx, `${val.toFixed(dec)}`, mid, ann);
        }
      } catch {}

      // Final overlay label (actual position pref or midpoint of original p0/p1)
      const dec = Number.isFinite(ann.decimals) ? ann.decimals : (pmimode?._opts?.dimDecimals | 0);
      const val = p0.distanceTo(p1);
      const labelPos = ann.labelWorld ? new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z) : new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
      const raw = `${val.toFixed(dec)}`; const txt = ctx.formatReferenceLabel ? ctx.formatReferenceLabel(ann, raw) : raw; ctx.updateLabel(idx, txt, labelPos, ann);
    } catch {}
  },

  // Compute label world for overlay refresh
  getLabelWorld(pmimode, ann, ctx) {
    try {
      if (ann.labelWorld) return new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
      const { p0, p1 } = computeDimPointsLocal(pmimode, ann) || {};
      if (p0 && p1) return new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
    } catch {}
    return null;
  },

  // Drag behavior: adjust offset and label position along perpendicular plane
  onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const v = pmimode.viewer; const cam = v?.camera; if (!cam) return;
      const pts = computeDimPointsLocal(pmimode, ann);
      if (!pts || !pts.p0 || !pts.p1) return;
      const p0 = pts.p0, p1 = pts.p1;
      const normal = ctx.alignNormal ? ctx.alignNormal(ann?.alignment || 'view', ann) : new THREE.Vector3(0,0,1);
      const dir = new THREE.Vector3().subVectors(p1, p0).normalize();
      const t = new THREE.Vector3().crossVectors(normal, dir).normalize();
      const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, mid);
      const onMove = (ev) => {
        const ray = (ctx.raycastFromEvent ? ctx.raycastFromEvent(ev) : null);
        if (!ray) return;
        const out = new THREE.Vector3();
        if (ray.intersectPlane(plane, out)) {
          const toMouse = new THREE.Vector3().subVectors(out, mid);
          const offsetDist = toMouse.dot(t);
          ann.offset = offsetDist;
          ann.labelWorld = { x: out.x, y: out.y, z: out.z };
          try { ctx.updateLabel(idx, null, out, ann); } catch {}
          try { pmimode.refreshAnnotationsUI?.(); } catch {}
        }
      };
      const onUp = (ev) => {
        try { window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); } catch {}
        try { if (pmimode.viewer?.controls) pmimode.viewer.controls.enabled = (pmimode._tool === 'select'); } catch {}
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch {}
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    } catch {}
  },
};

function computeDimPointsLocal(pmimode, a) {
  try {
    const scene = pmimode?.viewer?.partHistory?.scene;
    const aName = a.aRefName || null; const bName = a.bRefName || null;
    if (scene && (aName || bName)) {
      const objA = aName ? scene.getObjectByName(aName) : null;
      const objB = bName ? scene.getObjectByName(bName) : null;
      if (objA && objB) return closestPointsForObjects(objA, objB);
      if (objA && !objB) {
        const pA = objectRepresentativePoint(pmimode.viewer, objA);
        const pB = a.p1 ? new THREE.Vector3(a.p1.x || 0, a.p1.y || 0, a.p1.z || 0) : null;
        if (pA && pB) return { p0: pA, p1: pB };
      }
      if (!objA && objB) {
        const pB = objectRepresentativePoint(pmimode.viewer, objB);
        const pA = a.p0 ? new THREE.Vector3(a.p0.x || 0, a.p0.y || 0, a.p0.z || 0) : null;
        if (pA && pB) return { p0: pA, p1: pB };
      }
    }
  } catch {}
  const wp0 = a.p0 ? new THREE.Vector3(a.p0.x || 0, a.p0.y || 0, a.p0.z || 0) : new THREE.Vector3(0,0,0);
  const wp1 = a.p1 ? new THREE.Vector3(a.p1.x || 0, a.p1.y || 0, a.p1.z || 0) : new THREE.Vector3(0,0,0);
  return { p0: wp0, p1: wp1 };
}

function closestPointsForObjects(objA, objB) {
  if (objA.type === 'VERTEX' && objB.type === 'VERTEX') {
    return { p0: objA.getWorldPosition(new THREE.Vector3()), p1: objB.getWorldPosition(new THREE.Vector3()) };
  }
  if (objA.type === 'EDGE' && objB.type === 'VERTEX') {
    const v = objB.getWorldPosition(new THREE.Vector3());
    const p = closestPointOnEdgeToPoint(objA, v);
    return { p0: p, p1: v };
  }
  if (objA.type === 'VERTEX' && objB.type === 'EDGE') {
    const v = objA.getWorldPosition(new THREE.Vector3());
    const p = closestPointOnEdgeToPoint(objB, v);
    return { p0: v, p1: p };
  }
  if (objA.type === 'EDGE' && objB.type === 'EDGE') {
    return closestPointsBetweenEdges(objA, objB);
  }
  return { p0: objectRepresentativePoint(null, objA) || new THREE.Vector3(), p1: objectRepresentativePoint(null, objB) || new THREE.Vector3() };
}

function closestPointOnEdgeToPoint(edge, point) {
  try {
    const pts = edge.points(true);
    if (!pts || pts.length < 2) return edge.getWorldPosition(new THREE.Vector3());
    const p = point.clone();
    let best = { d2: Infinity, q: null };
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let i = 0; i < pts.length - 1; i++) {
      a.set(pts[i].x, pts[i].y, pts[i].z);
      b.set(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
      const q = closestPointOnSegment(a, b, p);
      const d2 = q.distanceToSquared(p);
      if (d2 < best.d2) best = { d2, q };
    }
    return best.q || edge.getWorldPosition(new THREE.Vector3());
  } catch { return edge.getWorldPosition(new THREE.Vector3()); }
}

function closestPointsBetweenEdges(e1, e2) {
  try {
    const pts1 = e1.points(true); const pts2 = e2.points(true);
    if (!pts1 || pts1.length < 2 || !pts2 || pts2.length < 2) return { p0: objectRepresentativePoint(null, e1), p1: objectRepresentativePoint(null, e2) };
    const a0 = new THREE.Vector3(), a1 = new THREE.Vector3(), b0 = new THREE.Vector3(), b1 = new THREE.Vector3();
    let best = { d2: Infinity, p: null, q: null };
    for (let i = 0; i < pts1.length - 1; i++) {
      a0.set(pts1[i].x, pts1[i].y, pts1[i].z);
      a1.set(pts1[i + 1].x, pts1[i + 1].y, pts1[i + 1].z);
      for (let j = 0; j < pts2.length - 1; j++) {
        b0.set(pts2[j].x, pts2[j].y, pts2[j].z);
        b1.set(pts2[j + 1].x, pts2[j + 1].y, pts2[j + 1].z);
        const { p, q } = closestPointsOnSegments(a0, a1, b0, b1);
        const d2 = p.distanceToSquared(q);
        if (d2 < best.d2) best = { d2, p, q };
      }
    }
    return { p0: best.p || objectRepresentativePoint(null, e1), p1: best.q || objectRepresentativePoint(null, e2) };
  } catch { return { p0: objectRepresentativePoint(null, e1), p1: objectRepresentativePoint(null, e2) }; }
}

function closestPointOnSegment(a, b, p) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, ab.dot(p.clone().sub(a)) / (ab.lengthSq() || 1)));
  return a.clone().addScaledVector(ab, t);
}

function closestPointsOnSegments(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s, t;
  const EPS = 1e-12;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = d1.dot(r); if (e <= EPS) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
    else { const b = d1.dot(d2); const denom = a * e - b * b; s = denom !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0; t = (b * s + f) / e; if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); } }
  }
  const cp1 = p1.clone().addScaledVector(d1, s);
  const cp2 = p2.clone().addScaledVector(d2, t);
  return { p: cp1, q: cp2 };
}
