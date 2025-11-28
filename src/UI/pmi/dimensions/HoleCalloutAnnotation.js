import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import {
  makeOverlayLine,
  objectRepresentativePoint,
  screenSizeWorld,
  addArrowCone,
} from '../annUtils.js';
import { getPMIStyle } from '../pmiStyle.js';

const inputParamsSchema = {
  id: {
    type: 'string',
    default_value: null,
    label: 'ID',
    hint: 'unique identifier for the hole callout',
  },
  target: {
    type: 'reference_selection',
    selectionFilter: ['VERTEX', 'EDGE', 'FACE'],
    multiple: false,
    default_value: '',
    label: 'Target',
    hint: 'Pick the hole edge/vertex/face to call out',
  },
  quantity: {
    type: 'number',
    default_value: 1,
    label: 'Quantity',
    hint: 'Number of identical holes this callout represents',
  },
  anchorPosition: {
    type: 'options',
    default_value: 'Right Top',
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
};

export class HoleCalloutAnnotation extends BaseAnnotation {
  static entityType = 'holeCallout';
  static type = 'holeCallout';
  static shortName = 'HOLE';
  static longName = 'Hole Callout';
  static title = 'Hole Callout';
  static inputParamsSchema = inputParamsSchema;

  constructor(opts = {}) {
    super(opts);
  }

  async run(renderingContext) {
    this.renderingContext = renderingContext;
    const { pmimode, group, idx, ctx } = renderingContext;
    const ann = this.inputParams || {};

    const viewer = pmimode?.viewer;
    const scene = viewer?.partHistory?.scene;
    const targetObj = resolveTargetObject(viewer, ann.target);
    const descriptor = findHoleDescriptor(viewer?.partHistory, targetObj, null, ann.target);
    const targetPoint = descriptor?.center ? arrToVec(descriptor.center) : objectRepresentativePoint(scene, targetObj);
    if (!targetPoint) return [];

    const labelText = descriptor ? formatHoleCallout(descriptor, Math.max(1, Math.round(ann.quantity || 1))) : '';
    ann.value = labelText;

    const basis = computeViewBasis(viewer);
    const offset = ctx?.screenSizeWorld ? ctx.screenSizeWorld(80) : screenSizeWorld(viewer, 80);
    const upOffset = ctx?.screenSizeWorld ? ctx.screenSizeWorld(30) : screenSizeWorld(viewer, 30);
    const saved = arrToVec(ann?.persistentData?.labelWorld);
    const labelPos = saved || targetPoint.clone()
      .addScaledVector(basis.right, anchorSign(ann.anchorPosition || 'Right Top') * offset)
      .addScaledVector(basis.up, anchorVertical(ann.anchorPosition || 'Right Top') * upOffset);

    if (ctx?.updateLabel) {
      ctx.updateLabel(idx, labelText, labelPos, ann);
    }

    const style = getPMIStyle();
    const color = style.lineColor ?? 0xffea00;
    group.add(makeOverlayLine(labelPos, targetPoint, color));
    const arrowLenPx = style.arrowLengthPx ?? 12;
    const arrowWidthPx = style.arrowWidthPx ?? 4;
    const arrowLength = ctx?.screenSizeWorld ? ctx.screenSizeWorld(arrowLenPx) : screenSizeWorld(viewer, arrowLenPx);
    const arrowWidth = ctx?.screenSizeWorld ? ctx.screenSizeWorld(arrowWidthPx) : screenSizeWorld(viewer, arrowWidthPx);
    const dir = targetPoint.clone().sub(labelPos);
    if (dir.lengthSq() > 1e-12) {
      dir.normalize();
      addArrowCone(group, targetPoint, dir, arrowLength, arrowWidth, style.arrowColor ?? color);
    }

    return [];
  }

  static applyParams(pmimode, ann, params) {
    super.applyParams(pmimode, ann, params);
    const qty = Number(params?.quantity);
    ann.quantity = Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 1;
    ann.anchorPosition = normalizeAnchorPosition(ann.anchorPosition);
    return { paramsPatch: {} };
  }

  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    const viewer = pmimode?.viewer;
    const targetObj = resolveTargetObject(viewer, ann.target);
    const scene = viewer?.partHistory?.scene;
    const targetPoint = objectRepresentativePoint(scene, targetObj) || arrToVec(ann?.persistentData?.labelWorld);
    if (!targetPoint) return;
    const basis = computeViewBasis(viewer);
    const normal = basis.forward;
    if (!ctx?.raycastFromEvent) return;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, targetPoint);

    const onMove = (ev) => {
      const ray = ctx.raycastFromEvent(ev);
      if (!ray) return;
      const hit = new THREE.Vector3();
      if (ray.intersectPlane(plane, hit)) {
        ensurePersistentData(ann);
        ann.persistentData.labelWorld = [hit.x, hit.y, hit.z];
        ctx.updateLabel(idx, null, hit, ann);
        pmimode?.refreshAnnotationsUI?.();
      }
    };

    const onUp = (evUp) => {
      try { window.removeEventListener('pointermove', onMove, true); } catch {}
      try { window.removeEventListener('pointerup', onUp, true); } catch {}
      try { if (viewer?.controls) viewer.controls.enabled = true; } catch {}
      try { evUp.preventDefault(); evUp.stopImmediatePropagation?.(); evUp.stopPropagation(); } catch {}
    };

    try { if (viewer?.controls) viewer.controls.enabled = false; } catch {}
    try { window.addEventListener('pointermove', onMove, true); } catch {}
    try { window.addEventListener('pointerup', onUp, true); } catch {}
  }
}

function resolveTargetObject(viewer, target) {
  if (!viewer || !target) return null;
  const scene = viewer.partHistory?.scene;
  if (!scene) return null;
  if (typeof target === 'string') {
    const obj = scene.getObjectByName?.(target);
    if (obj) return obj;
  }
  if (typeof target === 'object') return target;
  return scene.getObjectByName?.(String(target)) || null;
}

function findHoleDescriptor(partHistory, targetObj, fallbackPoint, targetName = null) {
  const features = Array.isArray(partHistory?.features) ? partHistory.features : [];
  const descriptors = [];
  for (const f of features) {
    const holes = Array.isArray(f?.persistentData?.holes) ? f.persistentData.holes : [];
    for (const h of holes) {
      descriptors.push(h);
    }
  }
  if (!descriptors.length) return null;

  const targetId = targetObj?.uuid || targetObj?.id || targetObj?.name || null;
  if (targetName) {
    const direct = descriptors.find((d) => d?.sourceName && String(d.sourceName) === String(targetName));
    if (direct) return direct;
  }
  if (targetId) {
    const direct = descriptors.find((d) => d?.targetId && String(d.targetId) === String(targetId));
    if (direct) return direct;
  }
  if (fallbackPoint) {
    let best = null;
    let bestD2 = Infinity;
    for (const d of descriptors) {
      const c = arrToVec(d?.center);
      if (!c) continue;
      const d2 = c.distanceToSquared(fallbackPoint);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = d;
      }
    }
    return best;
  }
  return descriptors[0];
}

function formatHoleCallout(desc, quantity = 1) {
  if (!desc) return '';
  const lines = [];
  const prefix = quantity > 1 ? `${quantity}× ` : '';
  const depthValue = Number(desc.totalDepth ?? desc.straightDepth);
  const depthStr = (!desc.throughAll && depthValue > 0)
    ? ` ↧ ${fmt(depthValue)}`
    : (desc.throughAll ? ' THRU ALL' : '');

  lines.push(`${prefix}⌀${fmt(desc.diameter)}${depthStr}`);

  if (desc.type === 'COUNTERSINK') {
    lines.push(`⌵ ⌀${fmt(desc.countersinkDiameter)} × ${fmt(desc.countersinkAngle, 0)}°`);
  } else if (desc.type === 'COUNTERBORE') {
    lines.push(`⌴ ⌀${fmt(desc.counterboreDiameter)} ↧ ${fmt(desc.counterboreDepth)}`);
  }
  return lines.join('\n');
}

function computeViewBasis(viewer) {
  const cam = viewer?.camera;
  const forward = new THREE.Vector3();
  if (cam?.getWorldDirection) cam.getWorldDirection(forward);
  else forward.set(0, 0, -1);
  forward.normalize();
  const up = cam?.up ? cam.up.clone() : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();
  const realUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  return { forward, right, up: realUp };
}

function anchorSign(anchor) {
  return String(anchor || '').startsWith('Left') ? -1 : 1;
}

function anchorVertical(anchor) {
  if (!anchor) return 1;
  if (anchor.includes('Bottom')) return -1;
  if (anchor.includes('Middle')) return 0;
  return 1;
}

function normalizeAnchorPosition(value) {
  const opts = new Set([
    'Left Top',
    'Left Middle',
    'Left Bottom',
    'Right Top',
    'Right Middle',
    'Right Bottom',
  ]);
  const val = opts.has(value) ? value : 'Right Top';
  return val;
}

function fmt(v, digits = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(digits);
}

function arrToVec(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const [x, y, z] = arr;
  if (![x, y, z].every((v) => Number.isFinite(Number(v)))) return null;
  return new THREE.Vector3(Number(x), Number(y), Number(z));
}

function vecToArr(vec) {
  if (!vec) return null;
  return [Number(vec.x) || 0, Number(vec.y) || 0, Number(vec.z) || 0];
}

function ensurePersistentData(ann) {
  if (!ann.persistentData || typeof ann.persistentData !== 'object') {
    ann.persistentData = {};
  }
}
