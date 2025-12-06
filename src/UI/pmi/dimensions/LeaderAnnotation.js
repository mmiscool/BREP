import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { getPMIStyle } from '../pmiStyle.js';
import {
  addArrowCone,
  makeOverlayLine,
  makeOverlaySphere,
  objectRepresentativePoint,
  screenSizeWorld,
} from '../annUtils.js';

const inputParamsSchema = {
  id: {
    type: 'string',
    default_value: null,
    label: 'ID',
    hint: 'unique identifier for the leader',
  },
  target: {
    type: 'reference_selection',
    selectionFilter: ['VERTEX'],
    multiple: true,
    default_value: '',
    label: 'Target Point',
    hint: 'Select target point',
  },
  text: {
    type: 'textarea',
    default_value: 'TEXT HERE',
    defaultResolver: ({ pmimode }) => {
      const txt = pmimode?._opts?.leaderText;
      return (typeof txt === 'string' && txt.length) ? txt : undefined;
    },
    label: 'Text',
    hint: 'Leader text content',
    rows: 3,
  },
  anchorPosition: {
    type: 'options',
    default_value: 'Right Middle',
    options: [
      'Left Top',
      'Left Middle',
      'Left Bottom',
      'Right Top',
      'Right Middle',
      'Right Bottom',
    ],
    label: 'Anchor Position',
    hint: 'Preferred label alignment relative to anchor',
  },
  endStyle: {
    type: 'options',
    default_value: 'arrow',
    options: ['arrow', 'dot'],
    label: 'Leader End',
    hint: 'Choose arrowhead or dot for end marker',
  },
};

export class LeaderAnnotation extends BaseAnnotation {
  static entityType = 'leader';
  static type = 'leader';
  static shortName = 'LEAD';
  static longName = 'Leader';
  static title = 'Leader';
  static inputParamsSchema = inputParamsSchema;

  constructor(opts = {}) {
    super(opts);
  }

  async run(renderingContext) {
    this.renderingContext = renderingContext;
    const { pmimode, group, idx, ctx } = renderingContext;
    const ann = this.inputParams || {};
    const style = getPMIStyle();
    ensurePersistentData(ann);
    ann.anchorPosition = normalizeAnchorPosition(ann.anchorPosition ?? ann.anchorSide);
    delete ann.anchorSide;

    const viewer = pmimode?.viewer;
    const scene = viewer?.partHistory?.scene;

    const targets = resolveTargetPoints(viewer, scene, ann);
    const labelPos = resolveLabelPosition(pmimode, ann, targets, ctx);
    const displayText = ctx?.formatReferenceLabel
      ? ctx.formatReferenceLabel(ann, sanitizeText(ann.text))
      : sanitizeText(ann.text);

    ann.value = displayText;

    if (labelPos) {
      ctx?.updateLabel?.(idx, displayText, labelPos, ann);
    }

    if (!targets.length || !labelPos) {
      return [];
    }

    const color = style.lineColor ?? 0x93c5fd;
    const basis = computeViewBasis(pmimode, viewer, ann);
    const originPoint = averageTargets(targets) || labelPos;
    const shoulderDir = computeShoulderDirection(labelPos, originPoint, basis);
    const approachSpacing = Math.max(ctx?.screenSizeWorld ? ctx.screenSizeWorld(18) : screenSizeWorld(viewer, 18), 1e-4);
    const shoulderLength = Math.max(
      ctx?.screenSizeWorld ? ctx.screenSizeWorld(36) : screenSizeWorld(viewer, 36),
      1e-4,
    );
    const sortedTargets = sortTargetsByViewUp(targets, basis, labelPos);

    const halfCount = (sortedTargets.length - 1) * 0.5;
    sortedTargets.forEach(({ point, order }) => {
      const verticalOffset = (order - halfCount) * approachSpacing;
      const approachPoint = labelPos.clone()
        .addScaledVector(shoulderDir, -shoulderLength)
        .addScaledVector(basis.up, verticalOffset);

      group.add(makeOverlayLine(point, approachPoint, color));
      group.add(makeOverlayLine(approachPoint, labelPos, color));

      if (ann.endStyle === 'dot') {
        const dotPx = style.leaderDotRadiusPx ?? 6;
        const dotRadius = ctx?.screenSizeWorld ? ctx.screenSizeWorld(dotPx) : screenSizeWorld(viewer, dotPx);
        const dot = makeOverlaySphere(Math.max(dotRadius, 1e-4), style.dotColor ?? color);
        dot.position.copy(point);
        group.add(dot);
      } else {
        const direction = point.clone().sub(approachPoint);
        if (!direction.lengthSq()) direction.copy(shoulderDir);
        direction.normalize();
        const arrowLenPx = style.arrowLengthPx ?? 12;
        const arrowWidthPx = style.arrowWidthPx ?? 4;
        const arrowLength = ctx?.screenSizeWorld ? ctx.screenSizeWorld(arrowLenPx) : screenSizeWorld(viewer, arrowLenPx);
        const arrowWidth = ctx?.screenSizeWorld ? ctx.screenSizeWorld(arrowWidthPx) : screenSizeWorld(viewer, arrowWidthPx);
        addArrowCone(group, point, direction, arrowLength, arrowWidth, style.arrowColor ?? color);
      }
    });
    return [];
  }

  static applyParams(pmimode, ann, params) {
    super.applyParams(pmimode, ann, params);
    ann.text = sanitizeText(ann.text);
    if (!Array.isArray(ann.target)) {
      ann.target = ann.target ? [String(ann.target)] : [];
    }
    ann.anchorPosition = normalizeAnchorPosition(ann.anchorPosition ?? ann.anchorSide);
    delete ann.anchorSide;
    ann.endStyle = normalizeEndStyle(ann.endStyle);
    return { paramsPatch: {} };
  }

  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const viewer = pmimode?.viewer;
      const targets = resolveTargetPoints(viewer, viewer?.partHistory?.scene, ann);
      const labelPos = resolveLabelPosition(pmimode, ann, targets, ctx) || new THREE.Vector3();
      const basis = computeViewBasis(pmimode, viewer, ann);
      const normal = basis.forward;
      const anchor = (targets && targets.length && targets[0]) ? targets[0] : (averageTargets(targets) || labelPos);
      if (!ctx?.raycastFromEvent) return;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor);
      LeaderAnnotation.dragLabelOnPlane(pmimode, ctx, {
        makePlane: () => plane,
        onDrag: (hit) => {
          ensurePersistentData(ann);
          ann.persistentData.labelWorld = [hit.x, hit.y, hit.z];
          ctx.updateLabel(idx, null, hit, ann);
          pmimode?.refreshAnnotationsUI?.();
        },
        onEnd: () => {
          try { if (pmimode?.viewer?.controls) pmimode.viewer.controls.enabled = true; } catch {}
        },
      });
    } catch {
      // ignore drag failures
    }
  }
}

function ensurePersistentData(ann) {
  if (!ann.persistentData || typeof ann.persistentData !== 'object') {
    ann.persistentData = {};
  }
}

function sanitizeText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function normalizeAnchorPosition(value) {
  const OPTIONS = new Set([
    'Left Top',
    'Left Middle',
    'Left Bottom',
    'Right Top',
    'Right Middle',
    'Right Bottom',
  ]);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (OPTIONS.has(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    if (lower === 'left') return 'Left Middle';
    if (lower === 'right') return 'Right Middle';
    if (lower === 'left-top' || lower === 'lefttop') return 'Left Top';
    if (lower === 'left-bottom' || lower === 'leftbottom') return 'Left Bottom';
    if (lower === 'right-top' || lower === 'righttop') return 'Right Top';
    if (lower === 'right-bottom' || lower === 'rightbottom') return 'Right Bottom';
  }
  if (value && typeof value === 'object') {
    const str = String(value.label || value.value || value.name || '').trim();
    if (OPTIONS.has(str)) return str;
  }
  return 'Right Middle';
}

function normalizeEndStyle(value) {
  return value === 'dot' ? 'dot' : 'arrow';
}

function resolveTargetPoints(viewer, scene, ann) {
  const names = Array.isArray(ann?.target) ? ann.target : [];
  if (!names.length || !scene) return [];
  const out = [];
  const unique = new Set();
  for (const name of names) {
    const key = typeof name === 'string' ? name : String(name ?? '');
    if (!key || unique.has(key)) continue;
    unique.add(key);
    try {
      const obj = scene.getObjectByName?.(key);
      if (!obj) continue;
      let pos = objectRepresentativePoint(viewer, obj);
      if (!pos && typeof obj.getWorldPosition === 'function') {
        pos = obj.getWorldPosition(new THREE.Vector3());
      }
      if (pos) out.push(pos.clone());
    } catch { /* ignore */ }
  }
  return out;
}

function resolveLabelPosition(pmimode, ann, targets, ctx) {
  const viewer = pmimode?.viewer;
  const basis = computeViewBasis(pmimode, viewer, ann);
  const anchor = (targets && targets.length && targets[0])
    ? targets[0].clone()
    : (averageTargets(targets) || new THREE.Vector3());
  const planeNormal = (basis?.forward && basis.forward.lengthSq()) ? basis.forward.clone() : new THREE.Vector3(0, 0, 1);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, anchor);

  const stored = vectorFromAny(ann?.persistentData?.labelWorld);
  if (stored) {
    const projected = stored.clone();
    plane.projectPoint(projected, projected);
    return projected;
  }

  const horizontal = Math.max(ctx?.screenSizeWorld ? ctx.screenSizeWorld(90) : screenSizeWorld(viewer, 90), 1e-4);
  const vertical = Math.max(ctx?.screenSizeWorld ? ctx.screenSizeWorld(36) : screenSizeWorld(viewer, 36), 1e-4);
  const rightAxis = (basis?.right && basis.right.lengthSq()) ? basis.right.clone() : new THREE.Vector3(1, 0, 0);
  const upAxis = (basis?.up && basis.up.lengthSq()) ? basis.up.clone() : new THREE.Vector3(0, 1, 0);
  const label = anchor.clone()
    .addScaledVector(rightAxis, horizontal)
    .addScaledVector(upAxis, vertical);
  plane.projectPoint(label, label);
  return label;
}

function computeViewBasis(pmimode, viewer, ann) {
  const saved = basisFromSavedCamera(pmimode?.viewEntry?.camera);
  if (saved) return saved;

  const forward = new THREE.Vector3(0, 0, -1);
  const up = new THREE.Vector3(0, 1, 0);
  try {
    if (viewer?.camera?.getWorldDirection) {
      viewer.camera.getWorldDirection(forward);
      forward.normalize();
    }
    if (viewer?.camera?.up) {
      up.copy(viewer.camera.up).normalize();
    }
  } catch { }
  if (!forward.lengthSq()) forward.set(0, 0, -1);
  if (!up.lengthSq()) up.set(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, up);
  if (!right.lengthSq()) {
    if (Math.abs(forward.z) < 0.9) {
      up.set(0, 0, 1);
    } else {
      up.set(1, 0, 0);
    }
    right.crossVectors(forward, up);
  }
  right.normalize();
  const trueUp = new THREE.Vector3().crossVectors(right, forward);
  if (!trueUp.lengthSq()) {
    trueUp.copy(up.lengthSq() ? up : new THREE.Vector3(0, 1, 0));
  }
  trueUp.normalize();
  const normForward = forward.clone().normalize();
  return { right, up: trueUp, forward: normForward };
}

function computeShoulderDirection(labelPos, originPoint, basis) {
  try {
    const dir = labelPos.clone().sub(originPoint || new THREE.Vector3());
    if (dir.lengthSq() > 1e-10) return dir.normalize();
  } catch { /* ignore */ }
  const fallback = basis?.right?.clone?.() || new THREE.Vector3(1, 0, 0);
  if (!fallback.lengthSq()) fallback.set(1, 0, 0);
  return fallback.normalize();
}

function sortTargetsByViewUp(points, basis, labelPos) {
  if (!points.length) return [];
  const upAxis = (basis?.up && basis.up.lengthSq()) ? basis.up : new THREE.Vector3(0, 1, 0);
  const records = points.map((point, i) => {
    const rel = point.clone().sub(labelPos || new THREE.Vector3());
    const upVal = rel.dot(upAxis);
    return { point, metric: upVal, index: i };
  });
  records.sort((a, b) => a.metric - b.metric);
  return records.map((rec, orderIndex) => ({ point: rec.point, order: orderIndex }));
}

function basisFromSavedCamera(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const quat = quaternionFromSnapshot(snapshot);
  if (!quat) return null;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  if (!forward.lengthSq()) return null;
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  let right = new THREE.Vector3().crossVectors(forward, up);
  if (!right.lengthSq()) {
    right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
  }
  if (!right.lengthSq()) right.set(1, 0, 0);
  right.normalize();
  const trueUp = new THREE.Vector3().crossVectors(right, forward);
  if (!trueUp.lengthSq()) trueUp.copy(up.lengthSq() ? up : new THREE.Vector3(0, 1, 0));
  trueUp.normalize();
  const normForward = forward.clone().normalize();
  return { right, up: trueUp, forward: normForward };
}

function quaternionFromSnapshot(snapshot) {
  const q = snapshot?.quaternion || snapshot?.camera?.quaternion;
  if (Array.isArray(q) && q.length >= 4) {
    const [x, y, z, w] = q;
    if ([x, y, z, w].every((n) => Number.isFinite(n))) {
      return new THREE.Quaternion(x, y, z, w).normalize();
    }
  }
  if (q && typeof q === 'object') {
    const x = Number(q.x); const y = Number(q.y); const z = Number(q.z); const w = Number(q.w);
    if ([x, y, z, w].every((n) => Number.isFinite(n))) {
      return new THREE.Quaternion(x, y, z, w).normalize();
    }
  }
  const matrixArr = snapshot?.worldMatrix || snapshot?.cameraMatrix || snapshot?.matrix;
  const elements = Array.isArray(matrixArr?.elements) ? matrixArr.elements : matrixArr;
  if (Array.isArray(elements) && elements.length === 16) {
    const mat = new THREE.Matrix4().fromArray(elements);
    const pos = new THREE.Vector3();
    const quatOut = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    mat.decompose(pos, quatOut, scale);
    return quatOut.normalize();
  }
  return null;
}

function vectorFromAny(value) {
  if (!value && value !== 0) return null;
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value) && value.length >= 3) {
    const [x, y, z] = value;
    if ([x, y, z].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null;
    return new THREE.Vector3(x, y, z);
  }
  if (typeof value === 'object') {
    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);
    if ([x, y, z].every((n) => Number.isFinite(n))) {
      return new THREE.Vector3(x, y, z);
    }
  }
  return null;
}

function averageTargets(points) {
  if (!points || !points.length) return null;
  const sum = new THREE.Vector3();
  points.forEach((p) => sum.add(p));
  return sum.multiplyScalar(1 / points.length);
}
