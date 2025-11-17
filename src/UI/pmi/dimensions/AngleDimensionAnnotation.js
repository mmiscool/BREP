import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { makeOverlayLine, addArrowCone, getElementDirection, objectRepresentativePoint, screenSizeWorld } from '../annUtils.js';

const inputParamsSchema = {
  id: {
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
  reverseElementOrder: {
    type: 'boolean',
    default_value: false,
    label: 'Reverse Selection Order',
    hint: 'Swap Element A and Element B to flip the measured side',
  },
  isReference: {
    type: 'boolean',
    default_value: false,
    label: 'Reference',
    hint: 'Mark as reference dimension (parentheses)',
  },
  angleType: {
    type: 'options',
    default_value: 'acute',
    options: ['acute', 'obtuse', 'reflex'],
    label: 'Angle Type',
    hint: 'Choose which angle (acute, obtuse, or reflex) to display',
  },
};

export class AngleDimensionAnnotation extends BaseAnnotation {
  static entityType = 'angle';
  static type = 'angle';
  static shortName = 'ANG';
  static longName = 'Angle Dimension';
  static title = 'Angle';
  static inputParamsSchema = inputParamsSchema;

  constructor(opts = {}) {
    super(opts);
  }

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
      const { N, P, A_p, B_p, A_d, B_d, V2, basis, sweep = 0, dirSign = 1 } = elements.__2d;

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
        R = ctx.screenSizeWorld ? ctx.screenSizeWorld(60) : screenSizeWorld(pmimode?.viewer, 60);
      }
      R = Math.max(R, ctx.screenSizeWorld ? ctx.screenSizeWorld(30) : screenSizeWorld(pmimode?.viewer, 30));

      const arcPoints = [];
      if (sweep > 1e-6) {
        const steps = Math.max(48, Math.floor(sweep * 64));
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
      }
      if (arcPoints.length >= 2) {
        for (let i = 0; i < arcPoints.length - 1; i++) {
          group.add(makeOverlayLine(arcPoints[i], arcPoints[i + 1], color));
        }
      }

      const arrowLength = ctx.screenSizeWorld ? ctx.screenSizeWorld(10) : screenSizeWorld(pmimode?.viewer, 10);
      const arrowWidth = ctx.screenSizeWorld ? ctx.screenSizeWorld(4) : screenSizeWorld(pmimode?.viewer, 4);
      if (arcPoints.length >= 2) {
        addArrowCone(group, arcPoints[0], arcPoints[0].clone().sub(arcPoints[1]).normalize(), arrowLength, arrowWidth, color);
        const last = arcPoints[arcPoints.length - 1];
        const beforeLast = arcPoints[arcPoints.length - 2] || last.clone();
        addArrowCone(group, last, last.clone().sub(beforeLast).normalize(), arrowLength, arrowWidth, color);
      }

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

function resolveElementRefNames(ann) {
  const elementARefName = ann?.elementARefName || '';
  const elementBRefName = ann?.elementBRefName || '';
  if (ann?.reverseElementOrder) {
    return {
      elementARefName: elementBRefName,
      elementBRefName: elementARefName,
    };
  }
  return { elementARefName, elementBRefName };
}

function resolveAngleType(ann) {
  const raw = ann?.angleType;
  if (raw === 'acute' || raw === 'obtuse' || raw === 'reflex') return raw;
  if (ann?.useReflexAngle) return 'reflex';
  return 'acute';
}

function isAngleTypeExplicit(ann) {
  if (!ann || typeof ann !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(ann, 'angleType')) return false;
  return ann.angleType === 'acute' || ann.angleType === 'obtuse' || ann.angleType === 'reflex';
}

function resolveAngleOrientation2D(A_dir, B_dir, angleType, isExplicitType = true) {
  if (!A_dir || !B_dir) return null;
  const combos = [
    createAngleCombo(A_dir, B_dir, false, false),
    createAngleCombo(A_dir, B_dir, false, true),
    createAngleCombo(A_dir, B_dir, true, false),
    createAngleCombo(A_dir, B_dir, true, true),
  ];

  const halfPi = Math.PI / 2;
  const eps = 1e-6;

  const selectByAngle = (items, comparator) => {
    if (!items.length) return null;
    const copy = items.slice().sort(comparator);
    return copy[0];
  };

  if (angleType === 'reflex') {
    const base = combos[0];
    const baseAbs = Math.abs(base.signedAngle);
    let reflexAngle = baseAbs < 1e-6 ? 0 : (2 * Math.PI) - baseAbs;
    const dirSign = -Math.sign(base.signedAngle || 1);
    const bisector = base.A.clone().add(base.B);
    if (bisector.lengthSq() < 1e-10) bisector.set(-base.A.y, base.A.x);
    bisector.normalize().multiplyScalar(-1);
    return {
      start: base.A.clone(),
      end: base.B.clone(),
      sweep: reflexAngle,
      dirSign,
      angleRad: reflexAngle,
      bisector,
      angleType: 'reflex',
      signedAngle: base.signedAngle,
    };
  }

  if (angleType === 'acute') {
    if (!isExplicitType) {
      const base = combos[0];
      const bisector = base.A.clone().add(base.B);
      if (bisector.lengthSq() < 1e-10) bisector.set(-base.A.y, base.A.x);
      bisector.normalize();
      const sign = Math.abs(base.signedAngle) < 1e-8 ? 1 : Math.sign(base.signedAngle);
      const sweep = Math.abs(base.signedAngle);
      return {
        start: base.A.clone(),
        end: base.B.clone(),
        sweep,
        dirSign: sign,
        angleRad: sweep,
        bisector,
        angleType: 'acute',
        signedAngle: base.signedAngle,
      };
    }
    const candidates = combos.filter((c) => c.angle <= halfPi + eps);
    const selected = selectByAngle(candidates.length ? candidates : combos, (a, b) => a.angle - b.angle);
    if (!selected) return null;
    const bisector = selected.A.clone().add(selected.B);
    if (bisector.lengthSq() < 1e-10) bisector.set(-selected.A.y, selected.A.x);
    bisector.normalize();
    const sign = Math.abs(selected.signedAngle) < 1e-8 ? 1 : Math.sign(selected.signedAngle);
    return {
      start: selected.A.clone(),
      end: selected.B.clone(),
      sweep: selected.angle,
      dirSign: sign,
      angleRad: selected.angle,
      bisector,
      angleType: 'acute',
      signedAngle: selected.signedAngle,
    };
  }

  if (angleType === 'obtuse') {
    const candidates = combos.filter((c) => c.angle >= halfPi - eps);
    let selected = selectByAngle(candidates, (a, b) => a.angle - b.angle);
    if (!selected) selected = selectByAngle(combos, (a, b) => b.angle - a.angle);
    if (!selected) return null;
    const bisector = selected.A.clone().add(selected.B);
    if (bisector.lengthSq() < 1e-10) bisector.set(-selected.A.y, selected.A.x);
    bisector.normalize();
    const sign = Math.abs(selected.signedAngle) < 1e-8 ? 1 : Math.sign(selected.signedAngle);
    return {
      start: selected.A.clone(),
      end: selected.B.clone(),
      sweep: selected.angle,
      dirSign: sign,
      angleRad: selected.angle,
      bisector,
      angleType: 'obtuse',
      signedAngle: selected.signedAngle,
    };
  }

  return null;
}

function createAngleCombo(A_dir, B_dir, flipA, flipB) {
  const a = flipA ? A_dir.clone().multiplyScalar(-1) : A_dir.clone();
  const b = flipB ? B_dir.clone().multiplyScalar(-1) : B_dir.clone();
  const dot = clampToUnit(a.dot(b));
  const angle = Math.acos(dot);
  const signedAngle = signedAngle2D(a, b);
  return { A: a, B: b, angle, signedAngle };
}

function clampToUnit(value) {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return value;
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
    const { elementARefName, elementBRefName } = resolveElementRefNames(ann);
    const lineA = lineInPlaneForElement(pmimode, elementARefName, plane.n, plane.p);
    const lineB = lineInPlaneForElement(pmimode, elementBRefName, plane.n, plane.p);
    if (!lineA || !lineB) return null;
    const basis = planeBasis(plane.n, lineA.d);
    const dA2 = dirTo2D(lineA.d, basis).normalize();
    const dB2 = dirTo2D(lineB.d, basis).normalize();
    const type = resolveAngleType(ann);
    const typeExplicit = isAngleTypeExplicit(ann) || Boolean(ann?.useReflexAngle);
    const orientation = resolveAngleOrientation2D(dA2, dB2, type, typeExplicit);
    if (!orientation) return null;
    const angle = THREE.MathUtils.radToDeg(orientation.angleRad);
    return angle;
  } catch {
    return null;
  }
}

function computeAngleElements(pmimode, ann) {
  try {
    const scene = pmimode?.viewer?.partHistory?.scene;
    if (!scene) return null;
    const { elementARefName, elementBRefName } = resolveElementRefNames(ann);
    const objA = elementARefName ? scene.getObjectByName(elementARefName) : null;
    const objB = elementBRefName ? scene.getObjectByName(elementBRefName) : null;
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
    const { elementARefName, elementBRefName } = resolveElementRefNames(ann);
    const lineA = lineInPlaneForElement(pmimode, elementARefName, plane.n, plane.p);
    const lineB = lineInPlaneForElement(pmimode, elementBRefName, plane.n, plane.p);
    if (!lineA || !lineB) return null;
    const basis = planeBasis(plane.n, lineA.d);
    const A_p = to2D(lineA.p, plane.p, basis);
    const B_p = to2D(lineB.p, plane.p, basis);
    let A_d = dirTo2D(lineA.d, basis).normalize();
    let B_d = dirTo2D(lineB.d, basis).normalize();
    if (ann?.reverseElementOrder) {
      A_d = A_d.multiplyScalar(-1);
      B_d = B_d.multiplyScalar(-1);
    }
    const angleType = resolveAngleType(ann);
    const angleExplicit = isAngleTypeExplicit(ann) || Boolean(ann?.useReflexAngle);
    const orientation = resolveAngleOrientation2D(A_d, B_d, angleType, angleExplicit);
    if (!orientation) return null;
    const A_ray = orientation.start.clone();
    const B_ray = orientation.end.clone();
    let V2 = intersectLines2D(A_p, A_ray, B_p, B_ray);
    if (!V2) V2 = new THREE.Vector2().addVectors(A_p, B_p).multiplyScalar(0.5);
    return {
      ...elements,
      __2d: {
        N: plane.n,
        P: plane.p,
        basis,
        A_p,
        B_p,
        A_d: A_ray,
        B_d: B_ray,
        V2,
        sweep: orientation.sweep,
        dirSign: orientation.dirSign,
        angleRad: orientation.angleRad,
        angleType: orientation.angleType,
        bisector: orientation.bisector,
      },
    };
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
    const fallbackNormal = ctx?.alignNormal ? ctx.alignNormal('view', ann) : null;
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
    const { N, P, A_d, B_d, V2, basis, bisector: storedBisector } = elements.__2d;
    let bisector = storedBisector ? storedBisector.clone() : new THREE.Vector2().addVectors(A_d, B_d);
    if (bisector.lengthSq() < 1e-10) bisector.set(-A_d.y, A_d.x);
    bisector.normalize();
    const offsetWorld = ctx.screenSizeWorld ? ctx.screenSizeWorld(70) : screenSizeWorld(pmimode?.viewer, 70);
    let off = offsetWorld;
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
