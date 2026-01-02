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
    default_value: 0,
    label: 'Quantity',
    hint: 'Number of identical holes this callout represents (0 = auto from feature)',
    min: 0,
  },
  showQuantity: {
    type: 'boolean',
    default_value: true,
    label: 'Show Quantity',
    hint: 'Include the hole count in the callout label',
  },
  beforeText: {
    type: 'string',
    default_value: '',
    label: 'Text Before',
    hint: 'Optional text to show before the callout',
  },
  afterText: {
    type: 'string',
    default_value: '',
    label: 'Text After',
    hint: 'Optional text to show after the callout',
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
    const objPoint = objectRepresentativePoint(scene, targetObj);
    const descriptor = findHoleDescriptor(viewer?.partHistory, targetObj, objPoint, ann.target);
    const targetPoint = descriptor?.center ? arrToVec(descriptor.center) : objPoint;
    if (!targetPoint) return [];

    const qty = resolveHoleQuantity(ann, descriptor, viewer?.partHistory);
    const labelText = descriptor ? formatHoleCallout(descriptor, qty, {
      showQuantity: ann.showQuantity !== false,
      beforeText: ann.beforeText,
      afterText: ann.afterText,
    }) : '';
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
    const qty = Number(ann?.quantity);
    ann.quantity = Number.isFinite(qty) ? Math.max(0, Math.round(qty)) : 1;
    ann.showQuantity = ann.showQuantity !== false;
    ann.beforeText = normalizeAddonText(ann.beforeText);
    ann.afterText = normalizeAddonText(ann.afterText);
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
    HoleCalloutAnnotation.dragLabelOnPlane(pmimode, ctx, {
      makePlane: () => plane,
      suspendControls: true,
      onDrag: (hit) => {
        ensurePersistentData(ann);
        ann.persistentData.labelWorld = [hit.x, hit.y, hit.z];
        ctx.updateLabel(idx, null, hit, ann);
        pmimode?.refreshAnnotationsUI?.();
      },
    });
  }
}

function resolveTargetObject(viewer, target) {
  if (!viewer || !target) return null;
  const scene = viewer.partHistory?.scene;
  if (!scene) return null;
  if (typeof target === 'string') {
    const direct = scene.getObjectByName?.(target);
    if (direct) return direct;
    const tokens = normalizeTargetTokens(target);
    for (const t of tokens) {
      const byToken = scene.getObjectByName?.(t);
      if (byToken) return byToken;
    }
    let fuzzy = null;
    try {
      scene.traverse((child) => {
        if (fuzzy) return;
        const name = child?.name ? String(child.name) : '';
        if (!name) return;
        for (const t of tokens) {
          if (!t) continue;
          if (name === t || name.endsWith(t) || name.includes(t)) {
            fuzzy = child;
            return;
          }
        }
      });
    } catch { /* ignore */ }
    if (fuzzy) return fuzzy;
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

  const metaHole = targetObj?.userData?.hole || targetObj?.userData?.metadata?.hole;
  if (metaHole) return metaHole;
  if (targetObj?.parent) {
    const parentHole = targetObj.parent.userData?.hole || targetObj.parent.userData?.metadata?.hole;
    if (parentHole) return parentHole;
  }

  const targetId = targetObj?.uuid || targetObj?.id || targetObj?.name || null;
  const tokens = normalizeTargetTokens(targetName, targetId);
  if (targetObj?.name) {
    for (const t of normalizeTargetTokens(targetObj.name)) tokens.add(t);
  }

  const directMatches = descriptors.filter((d) => {
    const sn = d?.sourceName ? String(d.sourceName) : null;
    const fid = d?.featureId ? String(d.featureId) : null;
    const tid = d?.targetId ? String(d.targetId) : null;
    return (sn && tokens.has(sn)) || (fid && tokens.has(fid)) || (tid && tokens.has(tid));
  });
  if (directMatches.length === 1) return directMatches[0];
  if (directMatches.length > 1 && fallbackPoint) {
    const best = nearestDescriptor(directMatches, fallbackPoint);
    if (best) return best;
  }

  if (targetId) {
    const byTarget = descriptors.filter((d) => d?.targetId && String(d.targetId) === String(targetId));
    if (byTarget.length === 1) return byTarget[0];
    if (byTarget.length > 1 && fallbackPoint) {
      const best = nearestDescriptor(byTarget, fallbackPoint);
      if (best) return best;
    }
  }

  if (targetName) {
    const t = String(targetName);
    const softList = descriptors.filter((d) => {
      const fid = d?.featureId ? String(d.featureId) : '';
      const source = d?.sourceName ? String(d.sourceName) : '';
      return (fid && t.includes(fid)) || (source && t.includes(source));
    });
    if (softList.length === 1) return softList[0];
    if (softList.length > 1 && fallbackPoint) {
      const best = nearestDescriptor(softList, fallbackPoint);
      if (best) return best;
    }
  }

  if (tokens.size) {
    const byTokenList = descriptors.filter((d) => {
      const fid = d?.featureId ? String(d.featureId) : '';
      const source = d?.sourceName ? String(d.sourceName) : '';
      const tid = d?.targetId ? String(d.targetId) : '';
      return tokens.has(fid) || tokens.has(source) || tokens.has(tid);
    });
    if (byTokenList.length === 1) return byTokenList[0];
    if (byTokenList.length > 1 && fallbackPoint) {
      const best = nearestDescriptor(byTokenList, fallbackPoint);
      if (best) return best;
    }
  }

  if (fallbackPoint) {
    const best = nearestDescriptor(descriptors, fallbackPoint);
    if (best) return best;
  }

  if (targetObj?.parent) {
    const parentTokens = normalizeTargetTokens(targetObj.parent.name);
    const byParentList = descriptors.filter((d) => {
      const fid = d?.featureId ? String(d.featureId) : '';
      const source = d?.sourceName ? String(d.sourceName) : '';
      const tid = d?.targetId ? String(d.targetId) : '';
      return parentTokens.has(fid) || parentTokens.has(source) || parentTokens.has(tid);
    });
    if (byParentList.length === 1) return byParentList[0];
    if (byParentList.length > 1 && fallbackPoint) {
      const best = nearestDescriptor(byParentList, fallbackPoint);
      if (best) return best;
    }
  }

  if (fallbackPoint) {
    const best = nearestDescriptor(descriptors, fallbackPoint);
    if (best) return best;
  }

  return descriptors[0];
}


function formatHoleCallout(desc, quantity = 1, options = {}) {
  if (!desc) return '';
  const lines = [];
  const before = normalizeAddonText(options.beforeText);
  if (before) lines.push(before);
  const includeQuantity = options.showQuantity !== false;
  const prefix = (includeQuantity && quantity > 1) ? `${quantity}× ` : '';
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
  const threadLine = formatThreadLine(desc?.thread);
  if (threadLine) lines.push(threadLine);
  const after = normalizeAddonText(options.afterText);
  if (after) lines.push(after);
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

function formatThreadLine(thread) {
  if (!thread || !thread.designation) return '';
  let designation = String(thread.designation).replace(/\s+/g, '').toUpperCase();
  const series = thread.series ? String(thread.series).toUpperCase() : '';
  if (series && !designation.includes(series)) {
    designation += series;
  }
  return `THREAD ${designation}`;
}

function arrToVec(arr) {
  if (!Array.isArray(arr) || arr.length < 3) return null;
  const [x, y, z] = arr;
  if (![x, y, z].every((v) => Number.isFinite(Number(v)))) return null;
  return new THREE.Vector3(Number(x), Number(y), Number(z));
}

function ensurePersistentData(ann) {
  if (!ann.persistentData || typeof ann.persistentData !== 'object') {
    ann.persistentData = {};
  }
}

function normalizeAddonText(value) {
  if (value == null) return '';
  const str = String(value).trim();
  return str.length ? str : '';
}

function normalizeTargetTokens(rawName, fallbackName = null) {
  const set = new Set();
  const push = (v) => {
    if (v == null) return;
    const s = String(v);
    if (!s) return;
    set.add(s);
    const bracket = s.match(/\[(.*?)\]/);
    if (bracket && bracket[1]) {
      const inner = bracket[1];
      set.add(inner);
      const axisStripped = inner.replace(/_AXIS_\d+$/, '');
      if (axisStripped && axisStripped !== inner) set.add(axisStripped);
    }
    const axisStrip = s.replace(/_AXIS_\d+$/, '');
    if (axisStrip && axisStrip !== s) set.add(axisStrip);
  };
  push(rawName);
  push(fallbackName);
  return set;
}

function nearestDescriptor(list, point) {
  if (!Array.isArray(list) || !list.length || !point) return null;
  let best = null;
  let bestD2 = Infinity;
  for (const d of list) {
    const c = arrToVec(d?.center);
    if (!c) continue;
    const d2 = c.distanceToSquared(point);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = d;
    }
  }
  return best;
}

function resolveHoleQuantity(ann, descriptor, partHistory) {
  const raw = Number(ann?.quantity);
  const requested = Number.isFinite(raw) ? Math.round(raw) : 1;
  if (requested > 0) return requested;
  const metaQty = countFeatureHoles(partHistory, descriptor);
  if (Number.isFinite(metaQty) && metaQty > 0) return metaQty;
  return 1;
}

function countFeatureHoles(partHistory, descriptor) {
  if (!partHistory || !descriptor) return null;
  const features = Array.isArray(partHistory.features) ? partHistory.features : [];
  const featureId = descriptor.featureId || null;
  let fallbackCount = null;
  for (const f of features) {
    const holes = Array.isArray(f?.persistentData?.holes) ? f.persistentData.holes : [];
    if (!holes.length) continue;
    if (holes.includes(descriptor)) return holes.length;
    const fid = resolveFeatureId(f);
    if (featureId && fid && String(fid) === String(featureId)) {
      fallbackCount = holes.length;
    }
  }
  return fallbackCount;
}

function resolveFeatureId(feature) {
  if (!feature || typeof feature !== 'object') return null;
  const params = feature.inputParams || {};
  return feature.id ?? params.id ?? params.featureID ?? null;
}
