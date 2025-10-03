import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { makeOverlayLine, makeOverlaySphere, addArrowCone, getElementDirection, objectRepresentativePoint, screenSizeWorld } from '../annUtils.js';

const inputParamsSchema = {
  annotationID: {
    type: 'string',
    default_value: null,
    label: 'ID',
    hint: 'unique identifier for the radial dimension',
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
  cylindricalFaceRef: {
    type: 'reference_selection',
    selectionFilter: ['FACE'],
    multiple: false,
    default_value: '',
    label: 'Cylindrical Face',
    hint: 'Select cylindrical face',
  },
  planeRef: {
    type: 'reference_selection',
    selectionFilter: ['FACE', 'PLANE'],
    multiple: false,
    default_value: '',
    label: 'Projection Plane',
    hint: 'Optional plane used to project the dimension',
  },
  displayStyle: {
    type: 'options',
    default_value: 'radius',
    options: ['radius', 'diameter'],
    label: 'Display Style',
    hint: 'Display as radius or diameter',
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
    hint: 'Distance to offset the dimension line',
    step: 'any',
  },
  isReference: {
    type: 'boolean',
    default_value: false,
    label: 'Reference',
    hint: 'Mark as reference dimension (parentheses)',
  },
};

export class RadialDimensionAnnotation extends BaseAnnotation {
  static type = 'radial';
  static title = 'Radial';
  static featureShortName = 'radial';
  static featureName = 'Radial Dimension';
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    super();
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(renderingContext) {
    RadialDimensionAnnotation.render3D(
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
      cylindricalFaceRef: '',
      planeRef: '',
      displayStyle: 'radius',
      alignment: 'view',
      offset: 0,
      isReference: false,
      persistentData: {},
      __open: true,
    };
  }

  static getSchema(pmimode, ann) {
    const measured = measureRadialValue(pmimode, ann);
    const dec = Number.isFinite(ann.decimals) ? ann.decimals : 3;
    const dv = (typeof measured === 'number') ? (ann.displayStyle === 'diameter' ? measured * 2 : measured) : null;
    const schema = {
      decimals: { ...inputParamsSchema.decimals, default_value: dec },
      cylindricalFaceRef: { ...inputParamsSchema.cylindricalFaceRef, default_value: ann.cylindricalFaceRef || '' },
      planeRef: { ...inputParamsSchema.planeRef, default_value: ann.planeRef || '' },
      displayStyle: { ...inputParamsSchema.displayStyle, default_value: ann.displayStyle || 'radius' },
      alignment: { ...inputParamsSchema.alignment, default_value: ann.alignment || 'view' },
      offset: { ...inputParamsSchema.offset, default_value: Number.isFinite(ann.offset) ? ann.offset : 0 },
      isReference: { ...inputParamsSchema.isReference, default_value: ann.isReference === true },
      value: {
        type: 'string',
        label: 'Value',
        readOnly: true,
        default_value: (() => {
          if (typeof dv !== 'number') return '—';
          let t = `${ann.displayStyle === 'diameter' ? '⌀' : 'R'}${dv.toFixed(dec)} (wu)`;
          if (ann.isReference) t = `(${t})`;
          return t;
        })(),
      },
    };
    const params = {
      decimals: schema.decimals.default_value,
      cylindricalFaceRef: schema.cylindricalFaceRef.default_value,
      planeRef: schema.planeRef.default_value,
      displayStyle: schema.displayStyle.default_value,
      alignment: schema.alignment.default_value,
      offset: schema.offset.default_value,
      isReference: schema.isReference.default_value,
      value: schema.value.default_value,
    };
    return { schema, params };
  }

  static applyParams(pmimode, ann, params) {
    ann.decimals = Math.max(0, Math.min(8, Number(params.decimals) | 0));
    ann.cylindricalFaceRef = String(params.cylindricalFaceRef || '');
    ann.planeRef = String(params.planeRef || '');
    ann.displayStyle = String(params.displayStyle || 'radius');
    ann.alignment = String(params.alignment || 'view');
    ann.offset = Number(params.offset);
    ann.isReference = Boolean(params.isReference);

    const measured = measureRadialValue(pmimode, ann);
    const displayValue = (typeof measured === 'number') ? (ann.displayStyle === 'diameter' ? measured * 2 : measured) : null;
    const prefix = ann.displayStyle === 'diameter' ? '⌀' : 'R';
    let textVal = (typeof displayValue === 'number') ? `${prefix}${displayValue.toFixed(ann.decimals)} (wu)` : '—';
    if (ann.isReference && textVal !== '—') textVal = `(${textVal})`;
    const statusText = (typeof displayValue === 'number')
      ? (ann.isReference ? `(${prefix}${displayValue.toFixed(ann.decimals)})` : `${prefix}${displayValue.toFixed(ann.decimals)}`)
      : '';
    return { paramsPatch: { value: textVal }, statusText };
  }

  static statusText(pmimode, ann) {
    const measured = measureRadialValue(pmimode, ann);
    if (typeof measured !== 'number') return '';
    const dec = Number.isFinite(ann.decimals) ? ann.decimals : 3;
    const val = ann.displayStyle === 'diameter' ? measured * 2 : measured;
    let txt = `${ann.displayStyle === 'diameter' ? '⌀' : 'R'}${val.toFixed(dec)}`;
    if (ann.isReference) txt = `(${txt})`;
    return txt;
  }

  static render3D(pmimode, group, ann, idx, ctx) {
    ensurePersistent(ann);
    try {
      const data = computeRadialPoints(pmimode, ann, ctx);
      if (!data || !data.center || !data.radiusPoint) return;
      const { center, radiusPoint, planeNormal, planePoint, radius } = data;
      const color = 0xff6b35;

      let direction = new THREE.Vector3().subVectors(radiusPoint, center);
      if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0);
      direction.normalize();

      let constraintNormal = planeNormal;
      if (!constraintNormal) {
        constraintNormal = ctx.alignNormal ? ctx.alignNormal(ann.alignment || 'view', ann) : null;
      }
      if (constraintNormal && constraintNormal.lengthSq() > 1e-6) {
        const projected = direction.clone().projectOnPlane(constraintNormal).normalize();
        if (projected.lengthSq() > 1e-6) direction = projected;
      }

      const arrowLength = ctx.screenSizeWorld ? ctx.screenSizeWorld(12) : screenSizeWorld(pmimode?.viewer, 12);
      const arrowWidth = ctx.screenSizeWorld ? ctx.screenSizeWorld(4) : screenSizeWorld(pmimode?.viewer, 4);

      const drawDiameter = ann.displayStyle === 'diameter';
      const storedLabel = ann.persistentData?.labelWorld ? vectorFromAny(ann.persistentData.labelWorld) : null;

      if (drawDiameter) {
        const lineDir = storedLabel ? storedLabel.clone().sub(center).normalize() : direction.clone();
        const endPoint = storedLabel
          ? center.clone().addScaledVector(lineDir, storedLabel.clone().sub(center).length())
          : center.clone().addScaledVector(lineDir, radius + Math.abs(Number(ann.offset) || ctx.screenSizeWorld ? ctx.screenSizeWorld(50) : screenSizeWorld(pmimode?.viewer, 50)));

        const start = center.clone().addScaledVector(lineDir, -radius);
        const positive = center.clone().addScaledVector(lineDir, radius);
        const negative = center.clone().addScaledVector(lineDir, -radius);

        group.add(makeOverlayLine(start, endPoint, color));
        addArrowCone(group, positive, lineDir.clone(), arrowLength, arrowWidth, color);
        addArrowCone(group, negative, lineDir.clone().negate(), arrowLength, arrowWidth, color);

        const centerMarker = makeOverlaySphere(ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : screenSizeWorld(pmimode?.viewer, 6), color);
        centerMarker.position.copy(center);
        group.add(centerMarker);
      } else {
        const labelTarget = storedLabel || computeRadialLabelPosition(pmimode, ann, center, radiusPoint, planeNormal, planePoint, ctx);
        const lineVector = labelTarget.clone().sub(center);
        let lineDir = lineVector.clone();
        if (!lineDir.lengthSq()) lineDir = direction.clone();
        lineDir.normalize();
        const endPoint = labelTarget;
        group.add(makeOverlayLine(center, endPoint, color));
        const arrowHead = center.clone().addScaledVector(lineDir, radius);
        addArrowCone(group, arrowHead, lineDir.clone(), arrowLength, arrowWidth, color);
        const centerMarker = makeOverlaySphere(ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : screenSizeWorld(pmimode?.viewer, 6), color);
        centerMarker.position.copy(center);
        group.add(centerMarker);
      }

      const dec = Number.isFinite(ann.decimals) ? ann.decimals : 3;
      const measured = measureRadialValue(pmimode, ann);
      const displayValue = (typeof measured === 'number') ? (ann.displayStyle === 'diameter' ? measured * 2 : measured) : null;
      if (typeof displayValue === 'number') {
        const prefix = ann.displayStyle === 'diameter' ? '⌀' : 'R';
        const raw = `${prefix}${displayValue.toFixed(dec)}`;
        const txt = ctx.formatReferenceLabel ? ctx.formatReferenceLabel(ann, raw) : raw;
        const labelPos = resolveLabelPosition(pmimode, ann, center, radiusPoint, planeNormal, planePoint, ctx);
        if (labelPos) ctx.updateLabel(idx, txt, labelPos, ann);
      }
    } catch (e) {
      console.warn('RadialDimensionAnnotation render error:', e);
    }
  }

  static getLabelWorld(pmimode, ann, ctx) {
    try {
      if (ann.persistentData?.labelWorld) return vectorFromAny(ann.persistentData.labelWorld);
      if (ann.labelWorld) return vectorFromAny(ann.labelWorld);
      const data = computeRadialPoints(pmimode, ann, ctx);
      if (!data) return null;
      return resolveLabelPosition(pmimode, ann, data.center, data.radiusPoint, data.planeNormal, data.planePoint, ctx);
    } catch {
      return null;
    }
  }

  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const data = computeRadialPoints(pmimode, ann, ctx);
      if (!data || !data.center || !data.radiusPoint) return;
      const planeNormal = (data.planeNormal && data.planeNormal.lengthSq() > 1e-6)
        ? data.planeNormal.clone().normalize()
        : (ctx.alignNormal ? ctx.alignNormal(ann.alignment || 'view', ann) : new THREE.Vector3(0, 0, 1));
      const planePoint = data.planePoint || data.radiusPoint;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, planePoint);
      const radialDir = new THREE.Vector3().subVectors(data.radiusPoint, data.center).normalize();

      const onMove = (ev) => {
        const ray = ctx.raycastFromEvent ? ctx.raycastFromEvent(ev) : null;
        if (!ray) return;
        const out = new THREE.Vector3();
        if (ray.intersectPlane(plane, out)) {
          plane.projectPoint(out, out);
          ensurePersistent(ann);
          ann.persistentData.labelWorld = [out.x, out.y, out.z];
          const toMouse = new THREE.Vector3().subVectors(out, data.center);
          ann.offset = toMouse.dot(radialDir) - data.radius;
          ctx.updateLabel(idx, null, out, ann);
          pmimode.refreshAnnotationsUI?.();
        }
      };

      const onUp = (ev) => {
        try {
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onUp, true);
        } catch { }
        try { if (pmimode.viewer?.controls) pmimode.viewer.controls.enabled = (pmimode._tool === 'select'); } catch { }
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

function ensurePersistent(ann) {
  if (!ann.persistentData || typeof ann.persistentData !== 'object') ann.persistentData = {};
}

function computeRadialPoints(pmimode, ann, ctx) {
  try {
    const scene = pmimode?.viewer?.partHistory?.scene;
    if (!scene || !ann.cylindricalFaceRef) return null;
    const faceObj = scene.getObjectByName(ann.cylindricalFaceRef);
    if (!faceObj) return null;

    let owner = faceObj;
    while (owner && typeof owner.getFaceMetadata !== 'function') owner = owner.parent;
    let center = null;
    let radius = null;
    let axis = null;
    let radiusPoint = null;
    let perpendicular = null;
    const originalCenter = new THREE.Vector3();

    if (owner && typeof owner.getFaceMetadata === 'function') {
      const metadata = owner.getFaceMetadata(ann.cylindricalFaceRef);
      if (metadata && (metadata.type === 'cylindrical' || metadata.type === 'conical')) {
        if (metadata.type === 'cylindrical') {
          center = new THREE.Vector3(metadata.center[0], metadata.center[1], metadata.center[2]);
          radius = metadata.radius;
          axis = new THREE.Vector3(metadata.axis[0], metadata.axis[1], metadata.axis[2]).normalize();
        } else if (Math.abs(metadata.radiusBottom - metadata.radiusTop) < 1e-6) {
          center = new THREE.Vector3(metadata.center[0], metadata.center[1], metadata.center[2]);
          radius = metadata.radiusBottom;
          axis = new THREE.Vector3(metadata.axis[0], metadata.axis[1], metadata.axis[2]).normalize();
        }
        if (center && axis) {
          if (faceObj.parent && faceObj.parent.matrixWorld) {
            center.applyMatrix4(faceObj.parent.matrixWorld);
            axis.transformDirection(faceObj.parent.matrixWorld).normalize();
          }
          perpendicular = new THREE.Vector3();
          if (Math.abs(axis.x) < 0.9) {
            perpendicular.crossVectors(axis, new THREE.Vector3(1, 0, 0)).normalize();
          } else {
            perpendicular.crossVectors(axis, new THREE.Vector3(0, 1, 0)).normalize();
          }
          radiusPoint = center.clone().addScaledVector(perpendicular, radius);
        }
      }
    }

    if (!center || !axis || !Number.isFinite(radius) || radius <= 0) {
      const inferred = inferCylinderFromGeometry(faceObj);
      if (!inferred) return null;
      center = inferred.center;
      axis = inferred.axis;
      radius = inferred.radius;
      radiusPoint = inferred.radiusPoint;
      perpendicular = new THREE.Vector3().subVectors(radiusPoint, center).normalize();
    }

    originalCenter.copy(center);

    let planeNormal = null;
    let planePoint = null;
    if (ann.planeRef) {
      const planeObj = scene.getObjectByName(ann.planeRef);
      if (planeObj) {
        planeNormal = getElementDirection(pmimode.viewer, planeObj);
        planePoint = objectRepresentativePoint(pmimode.viewer, planeObj);
      }
    }

    if (planeNormal && planePoint && planeNormal.lengthSq() > 1e-6) {
      const n = planeNormal.clone().normalize();
      planeNormal = n;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, planePoint);
      const projectedCenter = new THREE.Vector3();
      plane.projectPoint(center, projectedCenter);
      center = projectedCenter;
      let radialDir = new THREE.Vector3().subVectors(radiusPoint, originalCenter);
      if (radialDir.lengthSq() < 1e-12) radialDir = perpendicular.clone();
      let inPlaneDir = radialDir.projectOnPlane(n);
      if (inPlaneDir.lengthSq() < 1e-12) {
        inPlaneDir = axis.clone().cross(n);
        if (inPlaneDir.lengthSq() < 1e-12) {
          if (Math.abs(n.x) < 0.9) inPlaneDir = new THREE.Vector3().crossVectors(n, new THREE.Vector3(1, 0, 0));
          else inPlaneDir = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0));
        }
      }
      inPlaneDir.normalize();
      radiusPoint = center.clone().addScaledVector(inPlaneDir, radius);
    }

    return { center, radiusPoint, planeNormal, planePoint, axis, radius };
  } catch {
    return null;
  }
}

function measureRadialValue(pmimode, ann) {
  try {
    const data = computeRadialPoints(pmimode, ann);
    if (data && typeof data.radius === 'number') return data.radius;
    if (data && data.center && data.radiusPoint) return data.center.distanceTo(data.radiusPoint);
    return null;
  } catch {
    return null;
  }
}

function resolveLabelPosition(pmimode, ann, center, radiusPoint, planeNormal, planePoint, ctx) {
  try {
    let label = null;
    if (ann.persistentData?.labelWorld) label = vectorFromAny(ann.persistentData.labelWorld);
    else if (ann.labelWorld) label = vectorFromAny(ann.labelWorld);
    if (!label) label = computeRadialLabelPosition(pmimode, ann, center, radiusPoint, planeNormal, planePoint, ctx);
    if (planeNormal && planePoint && planeNormal.lengthSq() > 1e-6 && label) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal.clone().normalize(), planePoint);
      plane.projectPoint(label, label);
    }
    return label;
  } catch {
    return null;
  }
}

function computeRadialLabelPosition(pmimode, ann, center, radiusPoint, planeNormal, planePoint, ctx) {
  try {
    const dir = new THREE.Vector3().subVectors(radiusPoint, center);
    if (dir.lengthSq() < 1e-12) return radiusPoint.clone();
    dir.normalize();
    let offsetDistance = Number(ann?.offset);
    if (!Number.isFinite(offsetDistance) || offsetDistance === 0) offsetDistance = ctx.screenSizeWorld ? ctx.screenSizeWorld(50) : screenSizeWorld(pmimode?.viewer, 50);
    const baseDistance = center.distanceTo(radiusPoint);
    const label = center.clone().addScaledVector(dir, baseDistance + Math.abs(offsetDistance));
    if (planeNormal && planePoint && planeNormal.lengthSq() > 1e-6) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal.clone().normalize(), planePoint);
      plane.projectPoint(label, label);
    }
    return label;
  } catch {
    return radiusPoint ? radiusPoint.clone() : null;
  }
}

function inferCylinderFromGeometry(faceObj) {
  try {
    const geom = faceObj?.geometry;
    if (!geom || !geom.getAttribute) return null;
    const pos = geom.getAttribute('position');
    if (!pos || pos.count < 6) return null;
    const matrix = faceObj.matrixWorld || new THREE.Matrix4();
    const pts = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(matrix);
      pts.push(v.clone());
    }
    if (!pts.length) return null;

    const centroid = new THREE.Vector3();
    for (const p of pts) centroid.add(p);
    centroid.divideScalar(pts.length);

    const cov = new Float64Array(9);
    const diff = new THREE.Vector3();
    for (const p of pts) {
      diff.copy(p).sub(centroid);
      cov[0] += diff.x * diff.x;
      cov[1] += diff.x * diff.y;
      cov[2] += diff.x * diff.z;
      cov[4] += diff.y * diff.y;
      cov[5] += diff.y * diff.z;
      cov[8] += diff.z * diff.z;
    }
    cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];

    const axis = new THREE.Vector3(1, 0, 0);
    for (let iter = 0; iter < 20; iter++) {
      const x = cov[0] * axis.x + cov[1] * axis.y + cov[2] * axis.z;
      const y = cov[1] * axis.x + cov[4] * axis.y + cov[5] * axis.z;
      const z = cov[2] * axis.x + cov[5] * axis.y + cov[8] * axis.z;
      axis.set(x, y, z);
      const len = axis.length();
      if (len < 1e-12) {
        axis.set(0, 1, 0);
        break;
      }
      axis.divideScalar(len);
    }
    if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);

    let minProj = Infinity;
    let maxProj = -Infinity;
    let radialSum = 0;
    let radialCount = 0;
    const radialVec = new THREE.Vector3();
    const temp = new THREE.Vector3();
    const firstRadial = new THREE.Vector3();

    for (const p of pts) {
      diff.copy(p).sub(centroid);
      const t = diff.dot(axis);
      if (t < minProj) minProj = t;
      if (t > maxProj) maxProj = t;
      temp.copy(axis).multiplyScalar(t);
      radialVec.copy(diff).sub(temp);
      const len = radialVec.length();
      if (len > 1e-6) {
        if (radialCount === 0) firstRadial.copy(radialVec).normalize();
        radialSum += len;
        radialCount++;
      }
    }
    if (!radialCount) return null;

    const radius = radialSum / radialCount;
    const center = centroid.clone().add(axis.clone().multiplyScalar((minProj + maxProj) * 0.5));
    const dir = firstRadial.lengthSq() > 1e-12 ? firstRadial.clone() : new THREE.Vector3().crossVectors(axis, new THREE.Vector3(1, 0, 0)).normalize();
    if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0).cross(axis).normalize();
    const radiusPoint = center.clone().addScaledVector(dir, radius);

    return { center, axis: axis.normalize(), radius, radiusPoint };
  } catch {
    return null;
  }
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
