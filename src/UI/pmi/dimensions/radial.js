import * as THREE from 'three';
import { makeOverlayLine, makeOverlaySphere, addArrowCone, getElementDirection, objectRepresentativePoint, screenSizeWorld } from '../annUtils.js';

export const RadialDimension = {
  type: 'radial',
  title: 'Radial',
  create(pmimode) {
    const defaults = pmimode?._opts || {};
    const decimals = Number.isFinite(defaults.dimDecimals) ? (defaults.dimDecimals | 0) : 3;
    return {
      type: 'radial',
      decimals,
      cylindricalFaceRef: '',
      planeRef: '',
      displayStyle: 'radius',
      alignment: 'view',
      offset: 0,
      isReference: false,
      __open: true,
    };
  },
  getSchema(pmimode, ann) {
    const measured = measureRadialValueLocal(pmimode, ann);
    const dec = Number.isFinite(ann.decimals) ? ann.decimals : 3;
    const dv = (typeof measured === 'number') ? (ann.displayStyle === 'diameter' ? (measured * 2) : measured) : null;
    const schema = {
      decimals: { type: 'number', label: 'Decimals', min: 0, max: 8, step: 1, default_value: dec },
      cylindricalFaceRef: { type: 'reference_selection', label: 'Cylindrical Face', selectionFilter: ['FACE'], default_value: ann.cylindricalFaceRef || '' },
      planeRef: { type: 'reference_selection', label: 'Projection Plane (Optional)', selectionFilter: ['FACE'], default_value: ann.planeRef || '' },
      displayStyle: { type: 'options', label: 'Display Style', options: ['radius', 'diameter'], default_value: ann.displayStyle || 'radius' },
      alignment: { type: 'options', label: 'Alignment', options: ['view', 'XY', 'YZ', 'ZX'], default_value: ann.alignment || 'view' },
      offset: { type: 'number', label: 'Offset', step: 'any', default_value: (Number.isFinite(ann.offset) ? ann.offset : 0) },
      isReference: { type: 'boolean', label: 'Reference Dimension', default_value: (ann.isReference === true) },
      value: { type: 'string', label: 'Value', default_value: (() => { const t = (typeof dv === 'number') ? `${(ann.displayStyle === 'diameter' ? '⌀' : 'R')}${dv.toFixed(dec)} (wu)` : '—'; return ann.isReference && t && t !== '—' ? `(${t})` : t; })() },
    };
    const params = { decimals: schema.decimals.default_value, cylindricalFaceRef: schema.cylindricalFaceRef.default_value, planeRef: schema.planeRef.default_value, displayStyle: schema.displayStyle.default_value, alignment: schema.alignment.default_value, offset: schema.offset.default_value, isReference: schema.isReference.default_value, value: schema.value.default_value };
    return { schema, params };
  },

  applyParams(pmimode, ann, params) {
    ann.decimals = Math.max(0, Math.min(8, Number(params.decimals) | 0));
    ann.cylindricalFaceRef = String(params.cylindricalFaceRef || '');
    ann.planeRef = String(params.planeRef || '');
    ann.displayStyle = String(params.displayStyle || 'radius');
    ann.alignment = String(params.alignment || 'view');
    ann.offset = Number(params.offset);
    ann.isReference = Boolean(params.isReference);
    const v = measureRadialValueLocal(pmimode, ann);
    const dv = (typeof v === 'number') ? (ann.displayStyle === 'diameter' ? (v * 2) : v) : null;
    const prefix = (ann.displayStyle === 'diameter') ? '⌀' : 'R';
    let textVal = (typeof dv === 'number') ? `${prefix}${dv.toFixed(ann.decimals)} (wu)` : '—';
    if (ann.isReference && textVal && textVal !== '—') textVal = `(${textVal})`;
    let st = (typeof dv === 'number') ? `${prefix}${dv.toFixed(ann.decimals)}` : '';
    if (ann.isReference && st) st = `(${st})`;
    return { paramsPatch: { value: textVal }, statusText: st };
  },

  statusText(pmimode, ann) {
    const v = measureRadialValueLocal(pmimode, ann);
    if (typeof v !== 'number') return '';
    const dv = (ann.displayStyle === 'diameter') ? v * 2 : v;
    const dec = Number.isFinite(ann.decimals) ? ann.decimals : 3;
    let st = `${(ann.displayStyle === 'diameter' ? '⌀' : 'R')}${dv.toFixed(dec)}`;
    if (ann.isReference) st = `(${st})`;
    return st;
  },

  render3D(pmimode, group, ann, idx, ctx) {
    // Compute points
    const data = computeRadialPointsLocal(pmimode, ann);
    if (!data || !data.center || !data.radiusPoint) return;
    let { center, radiusPoint, planeNormal } = data;
    let radiusValue = measureRadialValueLocal(pmimode, ann) ?? center.distanceTo(radiusPoint);
    try {
      const color = 0xff6b35;
      // Direction from center
      let direction = new THREE.Vector3().subVectors(radiusPoint, center);
      if (direction.length() < 0.001) { direction = new THREE.Vector3(1, 0, 0); radiusPoint = center.clone().addScaledVector(direction, radiusValue); } else { direction.normalize(); }
      // Constraint normal
      let constraintNormal = null;
      if (ann.planeRef) {
        const planeObj = pmimode.viewer?.partHistory?.scene?.getObjectByName(ann.planeRef);
        if (planeObj) constraintNormal = getElementDirection(pmimode.viewer, planeObj);
      }
      if (!constraintNormal) constraintNormal = ctx.alignNormal ? ctx.alignNormal(ann?.alignment || 'view', ann) : null;
      if (!constraintNormal && planeNormal && planeNormal.length() > 0.1) constraintNormal = planeNormal;
      if (constraintNormal && constraintNormal.length() > 0.1) {
        const projectedDirection = direction.clone().projectOnPlane(constraintNormal).normalize();
        if (projectedDirection.length() > 0.1) { direction = projectedDirection; radiusPoint = center.clone().addScaledVector(direction, radiusValue); }
      }

      const arrowLength = ctx.screenSizeWorld ? ctx.screenSizeWorld(12) : 0.08;
      const arrowWidth = ctx.screenSizeWorld ? ctx.screenSizeWorld(4) : 0.03;

      if (ann.displayStyle === 'diameter') {
        const labelPos = ann.labelWorld ? new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z) : null;
        let lineDirection, lineEndPoint;
        if (labelPos) {
          lineDirection = new THREE.Vector3().subVectors(labelPos, center).normalize();
          if (constraintNormal && constraintNormal.length() > 0.1) {
            const projectedLabelDir = lineDirection.clone().projectOnPlane(constraintNormal).normalize();
            if (projectedLabelDir.length() > 0.1) lineDirection = projectedLabelDir;
          }
          const labelDistance = center.distanceTo(labelPos);
          lineEndPoint = center.clone().addScaledVector(lineDirection, labelDistance);
        } else {
          lineDirection = direction;
          let offsetDistance = Number(ann.offset); if (!Number.isFinite(offsetDistance) || offsetDistance === 0) offsetDistance = ctx.screenSizeWorld ? ctx.screenSizeWorld(50) : 0.2;
          lineEndPoint = center.clone().addScaledVector(lineDirection, radiusValue + Math.abs(offsetDistance));
        }
        const diameterStart = center.clone().addScaledVector(lineDirection, -radiusValue);
        const circlePoint1 = center.clone().addScaledVector(lineDirection, radiusValue);
        const circlePoint2 = center.clone().addScaledVector(lineDirection, -radiusValue);
        const diameterLine = makeOverlayLine(diameterStart, lineEndPoint, color); group.add(diameterLine);
        addArrowCone(group, circlePoint1, lineDirection, arrowLength, arrowWidth, color);
        addArrowCone(group, circlePoint2, lineDirection.clone().negate(), arrowLength, arrowWidth, color);
        const centerSize = ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : 0.02; const centerMarker = makeOverlaySphere(centerSize, color); centerMarker.position.copy(center); group.add(centerMarker);
      } else {
        const labelPos = ann.labelWorld ? new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z) : null;
        let lineEndPoint, lineDirection;
        if (labelPos) {
          lineDirection = new THREE.Vector3().subVectors(labelPos, center).normalize();
          if (constraintNormal && constraintNormal.length() > 0.1) {
            const projectedLabelDir = lineDirection.clone().projectOnPlane(constraintNormal).normalize();
            if (projectedLabelDir.length() > 0.1) lineDirection = projectedLabelDir;
          }
          const labelDistance = center.distanceTo(labelPos); lineEndPoint = center.clone().addScaledVector(lineDirection, labelDistance);
        } else {
          let offsetDistance = Number(ann.offset); if (!Number.isFinite(offsetDistance) || offsetDistance === 0) offsetDistance = ctx.screenSizeWorld ? ctx.screenSizeWorld(50) : 0.2;
          lineEndPoint = center.clone().addScaledVector(direction, radiusValue + Math.abs(offsetDistance)); lineDirection = direction;
        }
        group.add(makeOverlayLine(center, lineEndPoint, color));
        const arrowheadPosition = center.clone().addScaledVector(lineDirection, radiusValue);
        addArrowCone(group, arrowheadPosition, lineDirection, arrowLength, arrowWidth, color);
        const centerSize = ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : 0.02; const centerMarker = makeOverlaySphere(centerSize, color); centerMarker.position.copy(center); group.add(centerMarker);
      }

      const dec = Number.isFinite(ann.decimals) ? ann.decimals : 3;
      const displayValue = (typeof radiusValue === 'number') ? (ann.displayStyle === 'diameter' ? (radiusValue * 2) : radiusValue) : null;
      const prefix = (ann.displayStyle === 'diameter') ? '⌀' : 'R';
      const planeNormal = data.planeNormal;
      const planePoint = data.planePoint;
      let labelPos;
      if (ann.labelWorld) {
        labelPos = new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
      } else {
        labelPos = computeRadialLabelPosition(pmimode, ann, center, radiusPoint, planeNormal, planePoint);
      }
      if (planeNormal && planePoint && planeNormal.lengthSq() > 1e-6) {
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal.clone().normalize(), planePoint);
        plane.projectPoint(labelPos, labelPos);
        if (ann.labelWorld) ann.labelWorld = { x: labelPos.x, y: labelPos.y, z: labelPos.z };
      }
      const raw = `${prefix}${displayValue.toFixed(dec)}`; const txt = ctx.formatReferenceLabel ? ctx.formatReferenceLabel(ann, raw) : raw; ctx.updateLabel(idx, txt, labelPos, ann);
    } catch { }
  },

  getLabelWorld(pmimode, ann, ctx) {
    try {
      if (ann.labelWorld) return new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
      const data = computeRadialPointsLocal(pmimode, ann);
      if (!data || !data.center || !data.radiusPoint) return null;
      return computeRadialLabelPosition(pmimode, ann, data.center, data.radiusPoint, data.planeNormal, data.planePoint);
    } catch { return null; }
  },

  onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const v = pmimode.viewer; const cam = v?.camera; if (!cam) return;
      const data = computeRadialPointsLocal(pmimode, ann); if (!data || !data.center || !data.radiusPoint) return;
      const dragNormal = (data.planeNormal && data.planeNormal.lengthSq() > 1e-6)
        ? data.planeNormal.clone().normalize()
        : (ctx.alignNormal ? ctx.alignNormal(ann?.alignment || 'view', ann) : new THREE.Vector3(0, 0, 1));
      const planeAnchor = data.planePoint || data.radiusPoint;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dragNormal, planeAnchor);
      const radialDir = new THREE.Vector3().subVectors(data.radiusPoint, data.center).normalize();
      const onMove = (ev) => {
        const ray = ctx.raycastFromEvent ? ctx.raycastFromEvent(ev) : null; if (!ray) return;
        const out = new THREE.Vector3();
        if (ray.intersectPlane(plane, out)) {
          plane.projectPoint(out, out);
          ann.labelWorld = { x: out.x, y: out.y, z: out.z };
          const toMouse = new THREE.Vector3().subVectors(out, data.radiusPoint);
          ann.offset = toMouse.dot(radialDir);
          try { ctx.updateLabel(idx, null, out, ann); } catch { }
          try { pmimode.refreshAnnotationsUI?.(); } catch { }
        }
      };
      const onUp = (ev) => {
        try { window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); } catch { }
        try { if (pmimode.viewer?.controls) pmimode.viewer.controls.enabled = (pmimode._tool === 'select'); } catch { }
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch { }
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    } catch { }
  },
};

function computeRadialPointsLocal(pmimode, a) {
  try {
    const scene = pmimode?.viewer?.partHistory?.scene;
    if (!scene || !a.cylindricalFaceRef) return null;

    // Get the cylindrical face object
    const faceObj = scene.getObjectByName(a.cylindricalFaceRef);
    if (!faceObj) return null;

    // Walk up the hierarchy until we find something that can provide metadata
    let owner = faceObj;
    while (owner && typeof owner.getFaceMetadata !== 'function') owner = owner.parent;
    if (!owner || typeof owner.getFaceMetadata !== 'function') return null;

    // Get face metadata
    const metadata = owner.getFaceMetadata(a.cylindricalFaceRef);

    // Extract center, radius, and axis from metadata when available
    let center = null;
    let radius = null;
    let axis = null;
    let radiusPoint = null;
    let perpendicular = null;
    const originalCenter = new THREE.Vector3();

    if (metadata && (metadata.type === 'cylindrical' || metadata.type === 'conical')) {
      if (metadata.type === 'cylindrical') {
        center = new THREE.Vector3(metadata.center[0], metadata.center[1], metadata.center[2]);
        radius = metadata.radius;
        axis = new THREE.Vector3(metadata.axis[0], metadata.axis[1], metadata.axis[2]).normalize();
      } else if (Math.abs(metadata.radiusBottom - metadata.radiusTop) < 1e-6) {
        // Treat equal-radius cones as cylinders
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

    // Fallback: infer cylinder properties directly from geometry if metadata missing
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

    // Get plane normal if specified
    let planeNormal = null;
    let planePoint = null;
    if (a.planeRef) {
      const planeObj = scene.getObjectByName(a.planeRef);
      if (planeObj) {
        planeNormal = getElementDirection(pmimode.viewer, planeObj);
        planePoint = objectRepresentativePoint(pmimode.viewer, planeObj);
      }
    }

    if (planeNormal && planePoint && planeNormal.lengthSq() > 1e-6) {
      const n = planeNormal.clone().normalize();
      planeNormal = n;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, planePoint);

      // Project center onto the plane
      const projectedCenter = new THREE.Vector3();
      plane.projectPoint(center, projectedCenter);
      center = projectedCenter;

      // Build a radial direction that lies on the plane
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

    return { center, radiusPoint, planeNormal, planePoint, axis, radius: radius };
  } catch { return null; }
}

function measureRadialValueLocal(pmimode, a) {
  try {
    // Get radius directly from face metadata
    const data = computeRadialPointsLocal(pmimode, a);
    if (data && typeof data.radius === 'number') {
      return data.radius;
    }

    // Fallback to geometric calculation if metadata not available
    if (data && data.center && data.radiusPoint) {
      return data.center.distanceTo(data.radiusPoint);
    }

    return null;
  } catch { return null; }
}

function computeRadialLabelPosition(pmimode, ann, center, radiusPoint, planeNormal = null, planePoint = null) {
  try {
    const dir = new THREE.Vector3().subVectors(radiusPoint, center);
    if (dir.lengthSq() < 1e-12) return radiusPoint.clone();
    dir.normalize();
    let offsetDistance = Number(ann?.offset);
    if (!Number.isFinite(offsetDistance) || offsetDistance === 0) {
      offsetDistance = screenSizeWorld(pmimode?.viewer, 50);
    }
    const baseDistance = center.distanceTo(radiusPoint);
    const label = center.clone().addScaledVector(dir, baseDistance + Math.abs(offsetDistance));
    if (planeNormal && planePoint && planeNormal.lengthSq() > 1e-6) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal.clone().normalize(), planePoint);
      plane.projectPoint(label, label);
    }
    return label;
  } catch { return radiusPoint; }
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

    // Covariance matrix for PCA (symmetric)
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

    // Power iteration to find principal axis
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
