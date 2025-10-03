import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { makeOverlayLine, addArrowCone, objectRepresentativePoint } from '../annUtils.js';

const inputParamsSchema = {
  annotationID: {
    type: 'string',
    default_value: null,
    label: 'ID',
    hint: 'unique identifier for the linear dimension',
  },
  decimals: {
    type: 'number',
    default_value: 3,
    label: 'Decimals',
    hint: 'Number of decimal places to display',
    min: 0,
    max: 8,
    step: 1,
  },
  aRefName: {
    type: 'reference_selection',
    selectionFilter: ['VERTEX'],
    multiple: false,
    default_value: '',
    label: 'Point A',
    hint: 'Select start anchor (vertex)',
  },
  bRefName: {
    type: 'reference_selection',
    selectionFilter: ['VERTEX'],
    multiple: false,
    default_value: '',
    label: 'Point B',
    hint: 'Select end anchor (vertex)',
  },
  planeRefName: {
    type: 'reference_selection',
    selectionFilter: ['FACE', 'PLANE'],
    multiple: false,
    default_value: '',
    label: 'Face/Plane',
    hint: 'Projection plane (optional)',
  },
  alignment: {
    type: 'options',
    default_value: 'view',
    options: ['view', 'XY', 'YZ', 'ZX'],
    label: 'Alignment',
    hint: 'Dimension alignment mode',
  },
  offset: {
    type: 'number',
    default_value: 0,
    label: 'Offset',
    hint: 'Offset distance for the dimension line',
    step: 'any',
  },
  showExt: {
    type: 'boolean',
    default_value: true,
    label: 'Extension Lines',
    hint: 'Draw extension lines from anchors to offset line',
  },
  isReference: {
    type: 'boolean',
    default_value: false,
    label: 'Reference',
    hint: 'Mark as reference dimension (parentheses)',
  },
};

export class LinearDimensionAnnotation extends BaseAnnotation {
  static type = 'linear';
  static title = 'Linear';
  static featureShortName = 'linear';
  static featureName = 'Linear Dimension';
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    super();
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(renderingContext) {
    this.renderingContext = renderingContext;
    LinearDimensionAnnotation.render3D(
      renderingContext.pmimode,
      renderingContext.group,
      this.inputParams,
      renderingContext.idx,
      renderingContext.ctx,
    );
    return [];
  }

  static create(pmimode) {
    const defaults = pmimode?._opts || {};
    const decimals = Number.isFinite(defaults.dimDecimals) ? (defaults.dimDecimals | 0) : 3;
    return {
      type: this.type,
      decimals,
      aRefName: '',
      bRefName: '',
      planeRefName: '',
      alignment: 'view',
      offset: 0,
      showExt: true,
      isReference: false,
      persistentData: {},
      __open: true,
    };
  }

  static getSchema(pmimode, ann) {
    const pts = computeDimPoints(pmimode, ann);
    const measured = (pts && pts.p0 && pts.p1) ? pts.p0.distanceTo(pts.p1) : null;
    const dec = Number.isFinite(ann.decimals) ? ann.decimals : (pmimode?._opts?.dimDecimals | 0);
    const schema = {
      decimals: { ...inputParamsSchema.decimals, default_value: dec },
      anchorA: { ...inputParamsSchema.aRefName, default_value: ann.aRefName || '' },
      anchorB: { ...inputParamsSchema.bRefName, default_value: ann.bRefName || '' },
      planeRef: { ...inputParamsSchema.planeRefName, default_value: ann.planeRefName || '' },
      alignment: { ...inputParamsSchema.alignment, default_value: ann.alignment || 'view' },
      offset: { ...inputParamsSchema.offset, default_value: Number.isFinite(ann.offset) ? ann.offset : 0 },
      showExt: { ...inputParamsSchema.showExt, default_value: ann.showExt !== false },
      isReference: { ...inputParamsSchema.isReference, default_value: ann.isReference === true },
      value: {
        type: 'string',
        label: 'Value',
        readOnly: true,
        default_value: (() => {
          if (typeof measured !== 'number') return '—';
          let t = `${measured.toFixed(dec)} (wu)`;
          if (ann.isReference) t = `(${t})`;
          return t;
        })(),
      },
    };
    const params = {
      decimals: schema.decimals.default_value,
      anchorA: schema.anchorA.default_value,
      anchorB: schema.anchorB.default_value,
      planeRef: schema.planeRef.default_value,
      alignment: schema.alignment.default_value,
      offset: schema.offset.default_value,
      showExt: schema.showExt.default_value,
      isReference: schema.isReference.default_value,
      value: schema.value.default_value,
    };
    return { schema, params };
  }

  static applyParams(pmimode, ann, params) {
    ann.decimals = Math.max(0, Math.min(8, Number(params.decimals) | 0));
    ann.alignment = String(params.alignment || 'view');
    ann.aRefName = String(params.anchorA || '');
    ann.bRefName = String(params.anchorB || '');
    ann.planeRefName = String(params.planeRef || '');
    ann.offset = Number(params.offset);
    ann.showExt = Boolean(params.showExt);
    ann.isReference = Boolean(params.isReference);

    const pts = computeDimPoints(pmimode, ann);
    const measured = (pts && pts.p0 && pts.p1) ? pts.p0.distanceTo(pts.p1) : null;
    let display = (typeof measured === 'number') ? `${measured.toFixed(ann.decimals)} (wu)` : '—';
    if (ann.isReference && display !== '—') display = `(${display})`;
    const statusText = (typeof measured === 'number')
      ? (ann.isReference ? `(${measured.toFixed(ann.decimals)} (wu))` : `${measured.toFixed(ann.decimals)} (wu)`)
      : '';

    return { paramsPatch: { value: display }, statusText };
  }

  static statusText(pmimode, ann) {
    const pts = computeDimPoints(pmimode, ann);
    const measured = (pts && pts.p0 && pts.p1) ? pts.p0.distanceTo(pts.p1) : null;
    if (typeof measured !== 'number') return '';
    const dec = Number.isFinite(ann.decimals) ? ann.decimals : (pmimode?._opts?.dimDecimals | 0);
    let txt = `${measured.toFixed(dec)} (wu)`;
    if (ann.isReference) txt = `(${txt})`;
    return txt;
  }

  static render3D(pmimode, group, ann, idx, ctx) {
    const points = computeDimPoints(pmimode, ann);
    if (!points || !points.p0 || !points.p1) return;

    const { p0, p1 } = points;
    if (!ann.persistentData || typeof ann.persistentData !== 'object') {
      ann.persistentData = {};
    }
    const persistent = ann.persistentData;

    try {
      const color = 0x10b981;
      const normal = ctx.alignNormal ? ctx.alignNormal(ann?.alignment || 'view', ann) : new THREE.Vector3(0, 0, 1);
      const dir = new THREE.Vector3().subVectors(p1, p0);
      if (dir.lengthSq() < 1e-8) return;
      dir.normalize();
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
      addArrowCone(group, p0o, dir.clone().negate(), arrowLength, arrowWidth, color);
      addArrowCone(group, p1o, dir.clone(), arrowLength, arrowWidth, color);

      if (persistent.labelWorld) {
        try {
          const labelVec = arrayToVector(persistent.labelWorld);
          const lineLen = p0o.distanceTo(p1o);
          if (lineLen > 1e-6) {
            const toLabel = labelVec.clone().sub(p0o);
            const along = toLabel.dot(dir);
            const clamped = Math.max(0, Math.min(lineLen, along));
            const nearest = p0o.clone().addScaledVector(dir, clamped);
            const perpDist = labelVec.distanceTo(nearest);
            const threshold = ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : 0.02;
            if (perpDist > threshold) group.add(makeOverlayLine(nearest, labelVec, color));
          }
        } catch { /* ignore */ }
      }

      const dec = Number.isFinite(ann.decimals) ? ann.decimals : (pmimode?._opts?.dimDecimals | 0);
      const value = p0.distanceTo(p1);
      const textRaw = `${value.toFixed(dec)}`;
      const labelText = ctx.formatReferenceLabel ? ctx.formatReferenceLabel(ann, textRaw) : textRaw;

      const labelPos = (() => {
        if (persistent.labelWorld) return arrayToVector(persistent.labelWorld);
        if (ann.labelWorld) return arrayToVector(ann.labelWorld);
        const mid = new THREE.Vector3().addVectors(p0o, p1o).multiplyScalar(0.5);
        const lift = ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : 0.02;
        return mid.addScaledVector(t, lift);
      })();

      if (labelPos) ctx.updateLabel(idx, labelText, labelPos, ann);
    } catch { /* ignore */ }
  }

  static getLabelWorld(pmimode, ann, ctx) {
    try {
      const persistent = ann?.persistentData;
      if (persistent?.labelWorld) return arrayToVector(persistent.labelWorld);
      if (ann.labelWorld) return arrayToVector(ann.labelWorld);
      const pts = computeDimPoints(pmimode, ann);
      if (pts && pts.p0 && pts.p1) return new THREE.Vector3().addVectors(pts.p0, pts.p1).multiplyScalar(0.5);
    } catch { /* ignore */ }
    return null;
  }

  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const v = pmimode.viewer; const cam = v?.camera; if (!cam) return;
      const pts = computeDimPoints(pmimode, ann);
      if (!pts || !pts.p0 || !pts.p1) return;

      const p0 = pts.p0;
      const p1 = pts.p1;
      const normal = ctx.alignNormal ? ctx.alignNormal(ann?.alignment || 'view', ann) : new THREE.Vector3(0, 0, 1);
      const dir = new THREE.Vector3().subVectors(p1, p0).normalize();
      const t = new THREE.Vector3().crossVectors(normal, dir).normalize();
      const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, mid);

      const onMove = (ev) => {
        const ray = ctx.raycastFromEvent ? ctx.raycastFromEvent(ev) : null;
        if (!ray) return;
        const out = new THREE.Vector3();
        if (ray.intersectPlane(plane, out)) {
          const toMouse = new THREE.Vector3().subVectors(out, mid);
          const offsetDist = toMouse.dot(t);
          ann.offset = offsetDist;
          const vecOut = [out.x, out.y, out.z];
          try { ann.persistentData.labelWorld = vecOut; } catch { ann.labelWorld = vecOut; }
          ctx.updateLabel(idx, null, out, ann);
          pmimode.refreshAnnotationsUI?.();
        }
      };

      const onUp = (ev) => {
        try {
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
        } catch { /* ignore */ }
        try { if (pmimode.viewer?.controls) pmimode.viewer.controls.enabled = true; } catch { }
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch { }
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    } catch { /* ignore */ }
  }

  static serialize(ann, entry) {
    const out = entry ? { ...entry } : { type: this.type }; // eslint-disable-line prefer-object-spread
    out.type = this.type;
    out.inputParams = clonePlainInput(ann);
    out.persistentData = clonePersistent(ann?.persistentData) || clonePersistent(entry?.persistentData) || {};
    if (ann && Object.prototype.hasOwnProperty.call(ann, '__open')) {
      out.__open = Boolean(ann.__open);
    } else if (entry && Object.prototype.hasOwnProperty.call(entry, '__open')) {
      out.__open = Boolean(entry.__open);
    }
    return out;
  }
}

function computeDimPoints(pmimode, ann) {
  try {
    const scene = pmimode?.viewer?.partHistory?.scene;
    const aName = ann?.aRefName || null;
    const bName = ann?.bRefName || null;
    if (scene && (aName || bName)) {
      const objA = aName ? scene.getObjectByName(aName) : null;
      const objB = bName ? scene.getObjectByName(bName) : null;
      if (objA && objB) return closestPointsForObjects(objA, objB);
      if (objA && !objB) {
        const pA = objectRepresentativePoint(pmimode.viewer, objA);
        const pB = vectorFromAnnotationPoint(ann.p1);
        if (pA && pB) return { p0: pA, p1: pB };
      }
      if (!objA && objB) {
        const pB = objectRepresentativePoint(pmimode.viewer, objB);
        const pA = vectorFromAnnotationPoint(ann.p0);
        if (pA && pB) return { p0: pA, p1: pB };
      }
    }
  } catch { /* ignore */ }
  return {
    p0: vectorFromAnnotationPoint(ann?.p0) || new THREE.Vector3(0, 0, 0),
    p1: vectorFromAnnotationPoint(ann?.p1) || new THREE.Vector3(0, 0, 0),
  };
}

function closestPointsForObjects(objA, objB) {
  if (objA?.type === 'VERTEX' && objB?.type === 'VERTEX') {
    return { p0: objA.getWorldPosition(new THREE.Vector3()), p1: objB.getWorldPosition(new THREE.Vector3()) };
  }
  if (objA?.type === 'EDGE' && objB?.type === 'VERTEX') {
    const v = objB.getWorldPosition(new THREE.Vector3());
    const p = closestPointOnEdgeToPoint(objA, v);
    return { p0: p, p1: v };
  }
  if (objA?.type === 'VERTEX' && objB?.type === 'EDGE') {
    const v = objA.getWorldPosition(new THREE.Vector3());
    const p = closestPointOnEdgeToPoint(objB, v);
    return { p0: v, p1: p };
  }
  if (objA?.type === 'EDGE' && objB?.type === 'EDGE') {
    return closestPointsBetweenEdges(objA, objB);
  }
  return {
    p0: objectRepresentativePoint(null, objA) || new THREE.Vector3(),
    p1: objectRepresentativePoint(null, objB) || new THREE.Vector3(),
  };
}

function closestPointOnEdgeToPoint(edge, point) {
  try {
    const pts = edge.points(true);
    if (!pts || pts.length < 2) return edge.getWorldPosition(new THREE.Vector3());
    const p = point.clone();
    let best = { d2: Infinity, q: null };
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
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
    const pts1 = e1.points(true);
    const pts2 = e2.points(true);
    if (!pts1 || pts1.length < 2 || !pts2 || pts2.length < 2) {
      return {
        p0: objectRepresentativePoint(null, e1) || new THREE.Vector3(),
        p1: objectRepresentativePoint(null, e2) || new THREE.Vector3(),
      };
    }
    const a0 = new THREE.Vector3();
    const a1 = new THREE.Vector3();
    const b0 = new THREE.Vector3();
    const b1 = new THREE.Vector3();
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
    return {
      p0: best.p || objectRepresentativePoint(null, e1) || new THREE.Vector3(),
      p1: best.q || objectRepresentativePoint(null, e2) || new THREE.Vector3(),
    };
  } catch {
    return {
      p0: objectRepresentativePoint(null, e1) || new THREE.Vector3(),
      p1: objectRepresentativePoint(null, e2) || new THREE.Vector3(),
    };
  }
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
  let s;
  let t;
  const EPS = 1e-12;
  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  const cp1 = p1.clone().addScaledVector(d1, s);
  const cp2 = p2.clone().addScaledVector(d2, t);
  return { p: cp1, q: cp2 };
}

function arrayToVector(value) {
  if (!value) return null;
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value)) return new THREE.Vector3(value[0] || 0, value[1] || 0, value[2] || 0);
  if (typeof value === 'object') {
    return new THREE.Vector3(value.x || 0, value.y || 0, value.z || 0);
  }
  return null;
}

function vectorFromAnnotationPoint(point) {
  if (!point) return null;
  if (point instanceof THREE.Vector3) return point.clone();
  if (Array.isArray(point)) return new THREE.Vector3(point[0] || 0, point[1] || 0, point[2] || 0);
  if (typeof point === 'object') return new THREE.Vector3(point.x || 0, point.y || 0, point.z || 0);
  return null;
}

function clonePlainInput(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const key of Object.keys(src)) {
    if (key === 'persistentData' || key === '__entryRef') continue;
    if (key === '__open') continue;
    out[key] = cloneValue(src[key]);
  }
  return out;
}

function clonePersistent(src) {
  if (!src || typeof src !== 'object') return null;
  return cloneValue(src);
}

function cloneValue(value) {
  if (value == null) return value;
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value)) return value.map((v) => cloneValue(v));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
    return out;
  }
  return value;
}
