import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import {
  addArrowCone,
  makeOverlayLine,
  makeOverlaySphere,
  objectRepresentativePoint,
  screenSizeWorld,
} from '../annUtils.js';

const inputParamsSchema = {
  annotationID: {
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
  static type = 'leader';
  static title = 'Leader';
  static featureShortName = 'leader';
  static featureName = 'Leader';
  static inputParamsSchema = inputParamsSchema;

  async run(renderingContext) {
    this.renderingContext = renderingContext;
    const { pmimode, group, idx, ctx } = renderingContext;
    const ann = this.inputParams || {};
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

    const color = 0x93c5fd;
    const basis = computeViewBasis(viewer, ann);
    const originPoint = averageTargets(targets) || labelPos;
    const shoulderDir = computeShoulderDirection(labelPos, originPoint, basis);
    const approachSpacing = Math.max(ctx?.screenSizeWorld ? ctx.screenSizeWorld(18) : screenSizeWorld(viewer, 18), 1e-4);
    const shoulderLength = Math.max(ctx?.screenSizeWorld ? ctx.screenSizeWorld(36) : screenSizeWorld(viewer, 36), 1e-4);
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
        const dotRadius = ctx?.screenSizeWorld ? ctx.screenSizeWorld(6) : screenSizeWorld(viewer, 6);
        const dot = makeOverlaySphere(Math.max(dotRadius, 1e-4), color);
        dot.position.copy(point);
        group.add(dot);
      } else {
        const direction = point.clone().sub(approachPoint);
        if (!direction.lengthSq()) direction.copy(shoulderDir);
        direction.normalize();
        const arrowLength = ctx?.screenSizeWorld ? ctx.screenSizeWorld(12) : screenSizeWorld(viewer, 12);
        const arrowWidth = ctx?.screenSizeWorld ? ctx.screenSizeWorld(4) : screenSizeWorld(viewer, 4);
        addArrowCone(group, point, direction, arrowLength, arrowWidth, color);
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
      const normal = computeViewBasis(viewer, ann).forward;
      if (!ctx?.raycastFromEvent) return;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, labelPos);

      const onMove = (ev) => {
        const ray = ctx.raycastFromEvent(ev);
        if (!ray) return;
        const hit = new THREE.Vector3();
        if (ray.intersectPlane(plane, hit)) {
          ann.persistentData.labelWorld = [hit.x, hit.y, hit.z];
          ctx.updateLabel(idx, null, hit, ann);
          pmimode?.refreshAnnotationsUI?.();
        }
      };

      const onUp = (evUp) => {
        try { window.removeEventListener('pointermove', onMove, true); } catch {}
        try { window.removeEventListener('pointerup', onUp, true); } catch {}
        try { if (pmimode?.viewer?.controls) pmimode.viewer.controls.enabled = true; } catch {}
        try { evUp.preventDefault(); evUp.stopImmediatePropagation?.(); evUp.stopPropagation(); } catch {}
      };

      try { window.addEventListener('pointermove', onMove, true); } catch {}
      try { window.addEventListener('pointerup', onUp, true); } catch {}
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
  const stored = vectorFromAny(ann?.persistentData?.labelWorld);
  if (stored) return stored;
  const viewer = pmimode?.viewer;
  const basis = computeViewBasis(viewer, ann);
  const origin = averageTargets(targets) || new THREE.Vector3();
  const horizontal = Math.max(ctx?.screenSizeWorld ? ctx.screenSizeWorld(90) : screenSizeWorld(viewer, 90), 1e-4);
  const vertical = Math.max(ctx?.screenSizeWorld ? ctx.screenSizeWorld(36) : screenSizeWorld(viewer, 36), 1e-4);
  const rightAxis = (basis?.right && basis.right.lengthSq()) ? basis.right.clone() : new THREE.Vector3(1, 0, 0);
  const upAxis = (basis?.up && basis.up.lengthSq()) ? basis.up.clone() : new THREE.Vector3(0, 1, 0);
  return origin.clone()
    .addScaledVector(rightAxis, horizontal)
    .addScaledVector(upAxis, vertical);
}

function computeViewBasis(viewer, ann) {
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
