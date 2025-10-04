import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { makeOverlayLine, addArrowCone, getElementDirection, objectRepresentativePoint, screenSizeWorld } from '../annUtils.js';

const inputParamsSchema = {
  annotationID: {
    type: 'string',
    default_value: null,
    label: 'ID',
    hint: 'unique identifier for the angle dimension',
  },
  decimals: {
    type: 'number',
    default_value: 1,
    defaultResolver: ({ pmimode }) => {
      const dec = Number.isFinite(pmimode?._opts?.angleDecimals)
        ? (pmimode._opts.angleDecimals | 0)
        : undefined;
      if (!Number.isFinite(dec)) return undefined;
      return Math.max(0, Math.min(3, dec));
    },
    label: 'Decimals',
    hint: 'Number of decimal places to display',
    min: 0,
    max: 3,
    step: 1,
  },
  elementARefName: {
    type: 'reference_selection',
    selectionFilter: ['FACE', 'EDGE'],
    multiple: false,
    default_value: '',
    label: 'Element A',
    hint: 'Select first element (face or edge)',
  },
  elementBRefName: {
    type: 'reference_selection',
    selectionFilter: ['FACE', 'EDGE'],
    multiple: false,
    default_value: '',
    label: 'Element B',
    hint: 'Select second element (face or edge)',
  },
  planeRefName: {
    type: 'reference_selection',
    selectionFilter: ['FACE', 'PLANE'],
    multiple: false,
    default_value: '',
    label: 'Projection Plane',
    hint: 'Override projection plane (optional)',
  },
  alignment: {
    type: 'options',
    default_value: 'view',
    options: ['view', 'XY', 'YZ', 'ZX'],
    label: 'Alignment',
    hint: 'Angle alignment mode',
  },
  offset: {
    type: 'number',
    default_value: 0,
    label: 'Offset',
    hint: 'Distance to offset the dimension arc',
    step: 'any',
  },
  isReference: {
    type: 'boolean',
    default_value: false,
    label: 'Reference',
    hint: 'Mark as reference dimension (parentheses)',
  },
  useReflexAngle: {
    type: 'boolean',
    default_value: false,
    label: 'Reflex Angle (>180°)',
    hint: 'Display the reflex angle instead of the acute angle',
  },
};

export class AngleDimensionAnnotation extends BaseAnnotation {
  static type = 'angle';
  static title = 'Angle';
  static featureShortName = 'angle';
  static featureName = 'Angle Dimension';
  static inputParamsSchema = inputParamsSchema;

  async run(renderingContext) {
    const { pmimode, group, idx, ctx } = renderingContext;
    const ann = this.inputParams;
    const measured = measureAngleValue(pmimode, ann);
    const labelInfo = formatAngleLabel(measured, ann);
    ann.value = labelInfo.display;

    ensurePersistent(ann);
    try {
      const elements = computeAngleElementsWithGeometry(pmimode, ann, ctx);
      if (!elements || !elements.__2d) return [];

      const color = 0xf59e0b;
      const { N, P, A_p, B_p, A_d, B_d, V2, basis } = elements.__2d;

      let R = null;
      if (ann.persistentData?.labelWorld) {
        const labelVec = vectorFromAny(ann.persistentData.labelWorld);
        if (labelVec) {
          const projected = projectPointToPlane(labelVec, P, N);
          const L2 = to2D(projected, P, basis);
          R = L2.clone().sub(V2).length();
        }
      }
      if (!Number.isFinite(R) || R <= 0) {
        const rawOffset = Number(ann.offset);
        if (Number.isFinite(rawOffset) && rawOffset > 0) R = rawOffset;
        else R = ctx.screenSizeWorld ? ctx.screenSizeWorld(60) : screenSizeWorld(pmimode?.viewer, 60);
      }
      R = Math.max(R, ctx.screenSizeWorld ? ctx.screenSizeWorld(30) : screenSizeWorld(pmimode?.viewer, 30));

      const signed = signedAngle2D(A_d, B_d);
      const baseAngle = Math.abs(signed);
      const useReflex = Boolean(ann.useReflexAngle);
      const sweep = useReflex ? (2 * Math.PI - baseAngle) : baseAngle;
      const dirSign = useReflex ? -Math.sign(signed || 1) : Math.sign(signed || 1);
      const steps = Math.max(48, Math.floor(sweep * 64));

      const arcPoints = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const angle = dirSign * sweep * t;
        const rot = rotate2D(A_d, angle);
        const pt2 = new THREE.Vector2(
          V2.x + rot.x * R,
          V2.y + rot.y * R,
        );
        arcPoints.push(from2D(pt2, P, basis));
      }
      if (arcPoints.length >= 2) {
        for (let i = 0; i < arcPoints.length - 1; i++) {
          group.add(makeOverlayLine(arcPoints[i], arcPoints[i + 1], color));
        }
      }

      const arrowLength = ctx.screenSizeWorld ? ctx.screenSizeWorld(10) : screenSizeWorld(pmimode?.viewer, 10);
      const arrowWidth = ctx.screenSizeWorld ? ctx.screenSizeWorld(4) : screenSizeWorld(pmimode?.viewer, 4);
      addArrowCone(group, arcPoints[0], arcPoints[0].clone().sub(arcPoints[1]).normalize(), arrowLength, arrowWidth, color);
      const last = arcPoints[arcPoints.length - 1];
      const beforeLast = arcPoints[arcPoints.length - 2] || last.clone();
      addArrowCone(group, last, last.clone().sub(beforeLast).normalize(), arrowLength, arrowWidth, color);

      const ext = R + (ctx.screenSizeWorld ? ctx.screenSizeWorld(25) : screenSizeWorld(pmimode?.viewer, 25));
      const stub = ctx.screenSizeWorld ? ctx.screenSizeWorld(12) : screenSizeWorld(pmimode?.viewer, 12);
      const A1 = from2D(new THREE.Vector2(V2.x + A_d.x * ext, V2.y + A_d.y * ext), P, basis);
      const B1 = from2D(new THREE.Vector2(V2.x + B_d.x * ext, V2.y + B_d.y * ext), P, basis);
      const A0 = from2D(new THREE.Vector2(V2.x - A_d.x * stub, V2.y - A_d.y * stub), P, basis);
      const B0 = from2D(new THREE.Vector2(V2.x - B_d.x * stub, V2.y - B_d.y * stub), P, basis);
      const V3 = from2D(V2, P, basis);
      group.add(makeOverlayLine(V3, A1, color));
      group.add(makeOverlayLine(V3, B1, color));
      group.add(makeOverlayLine(V3, A0, color));
      group.add(makeOverlayLine(V3, B0, color));

      if (typeof measured === 'number') {
        const info = formatAngleLabel(measured, ann);
        const raw = info.raw;
        ann.value = info.display;
        const txt = ctx.formatReferenceLabel ? ctx.formatReferenceLabel(ann, raw) : info.display;
        const labelPos = resolveLabelPosition(pmimode, ann, elements, R, ctx);
        if (labelPos) ctx.updateLabel(idx, txt, labelPos, ann);
      }
    } catch { /* ignore rendering errors */ }
    return [];
  }

  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const elements = computeAngleElementsWithGeometry(pmimode, ann, ctx);
      if (!elements) return;
      const planeInfo = resolveAnglePlane(pmimode, ann, elements, ctx);
      const normal = planeInfo?.n || new THREE.Vector3(0, 0, 1);
      const anchorPoint = planeInfo?.p || new THREE.Vector3();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchorPoint);

      const onMove = (ev) => {
        const ray = ctx.raycastFromEvent ? ctx.raycastFromEvent(ev) : null;
        if (!ray) return;
        const out = new THREE.Vector3();
        if (ray.intersectPlane(plane, out)) {
          ensurePersistent(ann);
          ann.persistentData.labelWorld = [out.x, out.y, out.z];
          ctx.updateLabel(idx, null, out, ann);
          pmimode.refreshAnnotationsUI?.();
        }
      };

      const onUp = (ev) => {
        try {
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
        } catch { }
        try { if (pmimode.viewer?.controls) pmimode.viewer.controls.enabled = true; } catch { }
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch { }
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    } catch { /* ignore */ }
  }

}

function ensurePersistent(ann) {
  if (!ann.persistentData || typeof ann.persistentData !== 'object') {
    ann.persistentData = {};
  }
}

function formatAngleLabel(measured, ann) {
  if (typeof measured !== 'number' || !Number.isFinite(measured)) {
    return { raw: '—', display: '—' };
  }
  const decRaw = Number(ann?.decimals);
  const decimals = Number.isFinite(decRaw) ? Math.max(0, Math.min(3, decRaw | 0)) : 1;
  const raw = `${measured.toFixed(decimals)}°`;
  const display = ann?.isReference ? `(${raw})` : raw;
  return { raw, display };
}

function measureAngleValue(pmimode, ann) {
  try {
    const elements = computeAngleElements(pmimode, ann);
    const plane = resolveAnglePlane(pmimode, ann, elements);
    if (!plane) return null;
    const lineA = lineInPlaneForElement(pmimode, ann.elementARefName, plane.n, plane.p);
    const lineB = lineInPlaneForElement(pmimode, ann.elementBRefName, plane.n, plane.p);
    if (!lineA || !lineB) return null;
    const basis = planeBasis(plane.n, lineA.d);
    const dA2 = dirTo2D(lineA.d, basis).normalize();
    const dB2 = dirTo2D(lineB.d, basis).normalize();
    const dot = Math.max(-1, Math.min(1, dA2.dot(dB2)));
    let angle = Math.acos(dot) * 180 / Math.PI;
    if (ann.useReflexAngle) angle = 360 - angle;
    return angle;
  } catch {
    return null;
  }
}

function computeAngleElements(pmimode, ann) {
  try {
    const scene = pmimode?.viewer?.partHistory?.scene;
    if (!scene) return null;
    const objA = ann.elementARefName ? scene.getObjectByName(ann.elementARefName) : null;
    const objB = ann.elementBRefName ? scene.getObjectByName(ann.elementBRefName) : null;
    if (!objA || !objB) return null;
    const dirA = getElementDirection(pmimode.viewer, objA);
    const dirB = getElementDirection(pmimode.viewer, objB);
    const pointA = objectRepresentativePoint(pmimode.viewer, objA);
    const pointB = objectRepresentativePoint(pmimode.viewer, objB);
    let plane = null;
    if (ann.planeRefName) {
      const planeObj = scene.getObjectByName(ann.planeRefName);
      if (planeObj) plane = getElementDirection(pmimode.viewer, planeObj);
    }
    return { dirA, dirB, pointA, pointB, plane };
  } catch {
    return null;
  }
}

function computeAngleElementsWithGeometry(pmimode, ann, ctx) {
  try {
    const elements = computeAngleElements(pmimode, ann);
    if (!elements || !elements.dirA || !elements.dirB) return null;
    const plane = resolveAnglePlane(pmimode, ann, elements, ctx);
    if (!plane) return null;
    const lineA = lineInPlaneForElement(pmimode, ann.elementARefName, plane.n, plane.p);
    const lineB = lineInPlaneForElement(pmimode, ann.elementBRefName, plane.n, plane.p);
    if (!lineA || !lineB) return null;
    const basis = planeBasis(plane.n, lineA.d);
    const A_p = to2D(lineA.p, plane.p, basis);
    const B_p = to2D(lineB.p, plane.p, basis);
    const A_d = dirTo2D(lineA.d, basis).normalize();
    const B_d = dirTo2D(lineB.d, basis).normalize();
    let V2 = intersectLines2D(A_p, A_d, B_p, B_d);
    if (!V2) V2 = new THREE.Vector2().addVectors(A_p, B_p).multiplyScalar(0.5);
    return { ...elements, __2d: { N: plane.n, P: plane.p, basis, A_p, B_p, A_d, B_d, V2 } };
  } catch {
    return null;
  }
}

function resolveAnglePlane(pmimode, ann, elements, ctx) {
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
    if (elements?.dirA && elements?.dirB) {
      const cross = new THREE.Vector3().crossVectors(elements.dirA, elements.dirB);
      if (cross.lengthSq() > 1e-12) {
        const p = (elements.pointA && elements.pointB)
          ? new THREE.Vector3().addVectors(elements.pointA, elements.pointB).multiplyScalar(0.5)
          : (elements.pointA || elements.pointB || new THREE.Vector3());
        return { n: cross.normalize(), p };
      }
    }
    const fallbackNormal = ctx?.alignNormal ? ctx.alignNormal(ann?.alignment || 'view', ann) : null;
    const n2 = fallbackNormal || elements?.plane || new THREE.Vector3(0, 0, 1);
    const p2 = (elements?.pointA && elements?.pointB)
      ? new THREE.Vector3().addVectors(elements.pointA, elements.pointB).multiplyScalar(0.5)
      : (elements?.pointA || elements?.pointB || new THREE.Vector3());
    return { n: n2.clone().normalize(), p: p2 };
  } catch {
    return { n: new THREE.Vector3(0, 0, 1), p: new THREE.Vector3() };
  }
}

function lineInPlaneForElement(pmimode, refName, planeNormal, planePoint) {
  try {
    if (!refName) return null;
    const scene = pmimode?.viewer?.partHistory?.scene;
    if (!scene) return null;
    const obj = scene.getObjectByName(refName);
    if (!obj) return null;

    const N = (planeNormal && planeNormal.lengthSq() > 1e-12)
      ? planeNormal.clone().normalize()
      : new THREE.Vector3(0, 0, 1);
    const basePoint = objectRepresentativePoint(pmimode.viewer, obj) || planePoint || new THREE.Vector3();
    const planeAnchor = planePoint || basePoint;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(N, planeAnchor);

    const elementDir = getElementDirection(pmimode.viewer, obj);
    const worldDir = elementDir ? elementDir.clone().normalize() : null;

    const userData = obj?.userData || {};
    const objType = userData.type || userData.brepType || obj.type;

    if (objType === 'FACE' && worldDir && worldDir.lengthSq() > 1e-12) {
      const faceNormal = worldDir.clone().normalize();
      const direction = new THREE.Vector3().crossVectors(faceNormal, N);
      const denom = direction.lengthSq();
      if (denom > 1e-12) {
        const d1 = faceNormal.dot(basePoint);
        const d2 = N.dot(planeAnchor);
        const termA = new THREE.Vector3().crossVectors(N, direction).multiplyScalar(d1);
        const termB = new THREE.Vector3().crossVectors(direction, faceNormal).multiplyScalar(d2);
        const pointOnIntersection = termA.add(termB).divideScalar(denom);
        return { p: plane.projectPoint(pointOnIntersection, pointOnIntersection.clone()), d: direction.normalize() };
      }
    }

    let planePointOnLine = basePoint.clone();
    if (worldDir && worldDir.lengthSq() > 1e-12) {
      const denom = worldDir.dot(N);
      if (Math.abs(denom) > 1e-9) {
        const target = planeAnchor.clone();
        const t = target.clone().sub(basePoint).dot(N) / denom;
        planePointOnLine = basePoint.clone().addScaledVector(worldDir, t);
      }
    }
    const projectedPoint = plane.projectPoint(planePointOnLine, planePointOnLine.clone());

    let projectedDir = worldDir ? worldDir.clone().projectOnPlane(N) : null;
    if (!projectedDir || projectedDir.lengthSq() < 1e-12) {
      const basis = planeBasis(N);
      projectedDir = basis.U.clone();
    }
    projectedDir.normalize();
    return { p: projectedPoint, d: projectedDir };
  } catch {
    return null;
  }
}

function resolveLabelPosition(pmimode, ann, elements, radiusOverride, ctx) {
  try {
    const { N, P, A_d, B_d, V2, basis } = elements.__2d;
    let bisector = new THREE.Vector2().addVectors(A_d, B_d);
    if (bisector.lengthSq() < 1e-10) bisector.set(-A_d.y, A_d.x);
    bisector.normalize();
    if (ann.useReflexAngle) bisector.multiplyScalar(-1);
    const offsetWorld = ctx.screenSizeWorld ? ctx.screenSizeWorld(70) : screenSizeWorld(pmimode?.viewer, 70);
    let off = Number(ann?.offset);
    if (!Number.isFinite(off) || off <= 0) off = offsetWorld; else off = off + offsetWorld * 0.3;
    if (Number.isFinite(radiusOverride) && radiusOverride > 0) off = radiusOverride + offsetWorld * 0.3;
    const label2 = new THREE.Vector2(V2.x + bisector.x * off, V2.y + bisector.y * off);
    return from2D(label2, P, basis);
  } catch {
    return null;
  }
}

function planeBasis(normal, preferDir) {
  const N = normal.clone().normalize();
  let U = (preferDir ? preferDir.clone() : new THREE.Vector3(1, 0, 0)).projectOnPlane(N);
  if (U.lengthSq() < 1e-12) {
    U = Math.abs(N.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(N) : new THREE.Vector3(0, 1, 0).cross(N);
  }
  U.normalize();
  const V = new THREE.Vector3().crossVectors(N, U).normalize();
  return { U, V, N };
}

function to2D(point, planePoint, basis) {
  const r = point.clone().sub(planePoint);
  return new THREE.Vector2(r.dot(basis.U), r.dot(basis.V));
}

function dirTo2D(dir, basis) {
  return new THREE.Vector2(dir.dot(basis.U), dir.dot(basis.V));
}

function from2D(p2, planePoint, basis) {
  return planePoint.clone()
    .add(basis.U.clone().multiplyScalar(p2.x))
    .add(basis.V.clone().multiplyScalar(p2.y));
}

function intersectLines2D(p1, d1, p2, d2) {
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-12) return null;
  const v = new THREE.Vector2().subVectors(p2, p1);
  const t = (v.x * d2.y - v.y * d2.x) / cross;
  return new THREE.Vector2(p1.x + d1.x * t, p1.y + d1.y * t);
}

function rotate2D(vec, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return new THREE.Vector2(vec.x * c - vec.y * s, vec.x * s + vec.y * c);
}

function signedAngle2D(a, b) {
  const cross = a.x * b.y - a.y * b.x;
  const dot = a.x * b.x + a.y * b.y;
  return Math.atan2(cross, dot);
}

function projectPointToPlane(point, planePoint, planeNormal) {
  const d = point.clone().sub(planePoint).dot(planeNormal);
  return point.clone().sub(planeNormal.clone().multiplyScalar(d));
}

function vectorFromAny(value) {
  if (!value) return null;
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value)) return new THREE.Vector3(value[0] || 0, value[1] || 0, value[2] || 0);
  if (typeof value === 'object') {
    return new THREE.Vector3(value.x || 0, value.y || 0, value.z || 0);
  }
  return null;
}
