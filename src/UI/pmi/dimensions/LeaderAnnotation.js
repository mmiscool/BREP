import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { addArrowCone } from '../annUtils.js';

const inputParamsSchema = {
  annotationID: {
    type: 'string',
    default_value: null,
    label: 'ID',
    hint: 'unique identifier for the leader',
  },
  anchorRefName: {
    type: 'reference_selection',
    selectionFilter: ['VERTEX'],
    multiple: false,
    default_value: '',
    label: 'Target Point',
    hint: 'Select target point',
  },
  planeRefName: {
    type: 'reference_selection',
    selectionFilter: ['FACE', 'PLANE'],
    multiple: false,
    default_value: '',
    label: 'Plane/Face',
    hint: 'Optional plane or face used for text drag plane',
  },
  text: {
    type: 'textarea',
    default_value: 'TEXT HERE',
    label: 'Text',
    hint: 'Leader text content',
    rows: 3,
  },
  anchorSide: {
    type: 'options',
    default_value: 'right',
    options: ['left', 'right'],
    label: 'Anchor Side',
    hint: 'Preferred side for auto placement',
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

  constructor() {
    super();
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(renderingContext) {
    LeaderAnnotation.render3D(
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
    return {
      type: this.type,
      anchorRefName: '',
      planeRefName: '',
      text: typeof defaults.leaderText === 'string' ? defaults.leaderText : 'TEXT HERE',
      anchorSide: 'right',
      endStyle: 'arrow',
      persistentData: {},
      __open: true,
    };
  }

  static getSchema(pmimode, ann) {
    const schema = {
      anchor: { ...inputParamsSchema.anchorRefName, default_value: ann.anchorRefName || '' },
      planeRef: { ...inputParamsSchema.planeRefName, default_value: ann.planeRefName || '' },
      text: { ...inputParamsSchema.text, default_value: ann.text || pmimode?._opts?.leaderText || 'TEXT HERE' },
      anchorSide: { ...inputParamsSchema.anchorSide, default_value: ann.anchorSide || 'right' },
      endStyle: { ...inputParamsSchema.endStyle, default_value: ann.endStyle || 'arrow' },
    };
    const params = {
      anchor: schema.anchor.default_value,
      planeRef: schema.planeRef.default_value,
      text: schema.text.default_value,
      anchorSide: schema.anchorSide.default_value,
      endStyle: schema.endStyle.default_value,
    };
    return { schema, params };
  }

  static applyParams(pmimode, ann, params) {
    const previousAnchor = String(ann.anchorRefName || '');
    ann.anchorRefName = String(params.anchor || '');
    ann.planeRefName = String(params.planeRef || '');
    ann.text = String(params.text || 'TEXT HERE');
    ann.anchorSide = String(params.anchorSide || 'right');
    ann.endStyle = String(params.endStyle || 'arrow');
    if (ann.anchorRefName && ann.anchorRefName !== previousAnchor) {
      delete ann.textPosition;
      delete ann.persistentData?.labelWorld;
    }
    return { paramsPatch: {}, statusText: (ann.text || '').slice(0, 24) };
  }

  static statusText(pmimode, ann) {
    return (ann.text || '').slice(0, 24);
  }

  static render3D(pmimode, group, ann, idx, ctx) {
    ensurePersistent(ann);
    const anchorPoint = resolveAnchorWorld(pmimode, ann) || new THREE.Vector3();
    const text = String(ann.text || '');
    if (!text) return;

    const textPos = ann.textPosition ? vectorFromAny(ann.textPosition) : null;
    const labelPos = textPos || computeAutoLabelPosition(pmimode, ann, anchorPoint, ctx);
    if (labelPos) ctx.updateLabel(idx, text, labelPos, ann);

    drawLeaderGraphics(group, ann, anchorPoint, labelPos, idx, ctx);
  }

  static getLabelWorld(pmimode, ann, ctx) {
    try {
      if (ann.textPosition) return vectorFromAny(ann.textPosition);
      const anchor = resolveAnchorWorld(pmimode, ann) || new THREE.Vector3();
      return computeAutoLabelPosition(pmimode, ann, anchor, ctx);
    } catch {
      return null;
    }
  }

  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const planeInfo = resolveDragPlane(pmimode, ann, ctx);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeInfo.normal, planeInfo.point);

      const onMove = (ev) => {
        const ray = ctx.raycastFromEvent ? ctx.raycastFromEvent(ev) : null;
        if (!ray) return;
        const out = new THREE.Vector3();
        if (ray.intersectPlane(plane, out)) {
          ann.textPosition = { x: out.x, y: out.y, z: out.z };
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
    if (ann.textPosition) out.inputParams.textPosition = cloneValue(ann.textPosition);
    return out;
  }
}

function ensurePersistent(ann) {
  if (!ann.persistentData || typeof ann.persistentData !== 'object') ann.persistentData = {};
}

function resolveAnchorWorld(pmimode, ann) {
  try {
    const fallback = ann.start ? new THREE.Vector3(ann.start.x || 0, ann.start.y || 0, ann.start.z || 0) : null;
    if (!pmimode) return fallback || new THREE.Vector3();
    const scene = pmimode.viewer?.partHistory?.scene;
    const obj = ann.anchorRefName && scene ? scene.getObjectByName(ann.anchorRefName) : null;
    if (obj && obj.isObject3D) {
      const out = new THREE.Vector3();
      obj.getWorldPosition(out);
      return out;
    }
    return fallback || new THREE.Vector3();
  } catch {
    return new THREE.Vector3();
  }
}

function computeAutoLabelPosition(pmimode, ann, anchorPoint, ctx) {
  try {
    const offset = ctx.screenSizeWorld ? ctx.screenSizeWorld(40) : 0.2;
    const side = (ann.anchorSide || 'right').toLowerCase();
    const cam = pmimode?.viewer?.camera;
    const horizontal = new THREE.Vector3();
    if (cam) {
      const camDir = new THREE.Vector3();
      cam.getWorldDirection(camDir);
      const up = new THREE.Vector3(0, 1, 0);
      horizontal.crossVectors(up, camDir).normalize();
      if (!horizontal.lengthSq()) horizontal.set(1, 0, 0);
      if (side === 'left') horizontal.multiplyScalar(-1);
    } else {
      horizontal.set(side === 'left' ? -1 : 1, 0, 0);
    }
    const base = anchorPoint.clone().add(horizontal.multiplyScalar(offset));
    const planeInfo = resolveConstraintPlane(pmimode, ann, anchorPoint);
    if (planeInfo) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeInfo.normal, planeInfo.point);
      plane.projectPoint(base, base);
    }
    return base;
  } catch {
    return anchorPoint.clone();
  }
}

function drawLeaderGraphics(group, ann, anchorPoint, labelPos, labelIdx, ctx) {
  try {
    const existing = group.children.filter((ch) => ch.userData && ch.userData.isLeaderLine && ch.userData.labelIdx === labelIdx);
    existing.forEach((ch) => group.remove(ch));

    if (!labelPos) return;

    const pmimode = ctx?.pmimode || ctx?.__pmimode || null;
    const anchorProjected = projectOntoConstraintPlane(pmimode, ann, anchorPoint) || anchorPoint;
    const labelProjected = projectOntoConstraintPlane(pmimode, ann, labelPos) || labelPos;

    const addLine = (a, b) => {
      const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
      const mat = new THREE.LineBasicMaterial({ color: 0x93c5fd, depthTest: false, depthWrite: false, transparent: true });
      const line = new THREE.Line(geom, mat);
      line.userData = { isLeaderLine: true, labelIdx };
      group.add(line);
    };

    addLine(anchorProjected, labelProjected);
    addEndMarker(group, ann, anchorProjected, labelProjected, labelIdx, ctx);
  } catch (e) {
    console.warn('LeaderAnnotation render error:', e);
  }
}

function addEndMarker(group, ann, anchorPoint, labelPos, labelIdx, ctx) {
  try {
    const style = (ann.endStyle || 'arrow').toLowerCase();
    if (style === 'dot') {
      const radius = ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : 0.03;
      const geom = new THREE.SphereGeometry(radius, 16, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0x93c5fd, depthTest: false, depthWrite: false, transparent: true });
      const dot = new THREE.Mesh(geom, mat);
      dot.position.copy(anchorPoint);
      dot.renderOrder = 9996;
      dot.userData = { isLeaderLine: true, labelIdx };
      group.add(dot);
    } else {
      const dir = new THREE.Vector3().subVectors(anchorPoint, labelPos);
      if (!dir.lengthSq()) dir.set(1, 0, 0);
      else dir.normalize();
      const arrowLength = ctx.screenSizeWorld ? ctx.screenSizeWorld(12) : 0.08;
      const arrowWidth = ctx.screenSizeWorld ? ctx.screenSizeWorld(4) : 0.03;
      const arrow = addArrowCone(group, anchorPoint, dir, arrowLength, arrowWidth, 0x93c5fd);
      if (arrow) {
        arrow.renderOrder = 9996;
        arrow.userData = { isLeaderLine: true, labelIdx };
      }
    }
  } catch (e) {
    console.warn('LeaderAnnotation end marker error:', e);
  }
}

function resolveDragPlane(pmimode, ann, ctx) {
  try {
    const anchor = resolveAnchorWorld(pmimode, ann) || new THREE.Vector3();
    const constraint = resolveConstraintPlane(pmimode, ann, anchor);
    if (constraint) return constraint;
    const camDir = pmimode?.viewer?.camera?.getWorldDirection(new THREE.Vector3()) || new THREE.Vector3(0, 0, 1);
    return { normal: camDir.normalize(), point: anchor };
  } catch {
    return { normal: new THREE.Vector3(0, 0, 1), point: new THREE.Vector3() };
  }
}

function projectOntoConstraintPlane(pmimode, ann, point) {
  if (!pmimode || !point) return null;
  const constraint = resolveConstraintPlane(pmimode, ann, point);
  if (!constraint) return null;
  try {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(constraint.normal, constraint.point);
    const projected = point.clone();
    plane.projectPoint(point, projected);
    return projected;
  } catch {
    return null;
  }
}

function resolveConstraintPlane(pmimode, ann, fallbackPoint) {
  try {
    if (!ann.planeRefName) return null;
    const scene = pmimode?.viewer?.partHistory?.scene;
    const planeObj = scene?.getObjectByName(ann.planeRefName);
    if (!planeObj) return null;
    const normal = getElementDirection(pmimode?.viewer, planeObj) || new THREE.Vector3(0, 0, 1);
    if (!normal.lengthSq()) return null;
    const point = objectRepresentativePoint(pmimode?.viewer, planeObj) || fallbackPoint || new THREE.Vector3();
    return { normal: normal.clone().normalize(), point: point.clone() };
  } catch {
    return null;
  }
}

function vectorFromAny(value) {
  if (!value) return null;
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value)) return new THREE.Vector3(value[0] || 0, value[1] || 0, value[2] || 0);
  if (typeof value === 'object') return new THREE.Vector3(value.x || 0, value.y || 0, value.z || 0);
  return null;
}

function clonePlainInput(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const key of Object.keys(src)) {
    if (key === 'persistentData' || key === '__entryRef' || key === '__open') continue;
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
