import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { makeOverlayLine, makeOverlaySphere, addArrowCone, getElementDirection, objectRepresentativePoint, screenSizeWorld } from '../annUtils.js';

const inputParamsSchema = {
  id: {
    type: 'string',
    default_value: null,
    label: 'ID',
    hint: 'unique identifier for the radial dimension',
  },
  decimals: {
    type: 'number',
    default_value: 3,
    defaultResolver: ({ pmimode }) => {
      const dec = Number.isFinite(pmimode?._opts?.dimDecimals)
        ? (pmimode._opts.dimDecimals | 0)
        : undefined;
      if (!Number.isFinite(dec)) return undefined;
      return Math.max(0, Math.min(8, dec));
    },
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
  static entityType = 'radial';
  static type = 'radial';
  static shortName = 'RAD';
  static longName = 'Radial Dimension';
  static title = 'Radial';
  static inputParamsSchema = inputParamsSchema;

  constructor(opts = {}) {
    super(opts);
  }

  uiFieldsTest() {
    const planeRef = this.inputParams?.planeRef;
    const hasPlane = Array.isArray(planeRef)
      ? planeRef.length > 0
      : Boolean(String(planeRef || '').trim());
    if (hasPlane) return { exclude: ['alignment'] };
    return null;
  }

  async run(renderingContext) {
    const { pmimode, group, idx, ctx } = renderingContext;
    const ann = this.inputParams;
    const measured = measureRadialValue(pmimode, ann);
    const labelInfo = formatRadialLabel(measured, ann);
    ann.value = labelInfo.display;

    ensurePersistent(ann);
    try {
      const data = computeRadialPoints(pmimode, ann, ctx);
      if (!data || !data.center || !data.radiusPoint) return [];
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

      if (typeof measured === 'number') {
        const info = formatRadialLabel(measured, ann);
        ann.value = info.display;
        const txt = ctx.formatReferenceLabel ? ctx.formatReferenceLabel(ann, info.raw) : info.display;
        const labelPos = resolveLabelPosition(pmimode, ann, center, radiusPoint, planeNormal, planePoint, ctx);
        if (labelPos) ctx.updateLabel(idx, txt, labelPos, ann);
      }
    } catch (e) {
      console.warn('RadialDimensionAnnotation render error:', e);
    }
    return [];
  }

  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const data = computeRadialPoints(pmimode, ann, ctx);
      if (!data || !data.center || !data.radiusPoint) return;
      const planeNormal = (data.planeNormal && data.planeNormal.lengthSq() > 1e-6)
        ? data.planeNormal.clone().normalize()
        : (ctx.alignNormal ? ctx.alignNormal(ann.alignment || 'view', ann) : new THREE.Vector3(0, 0, 1));
      const planePoint = data.planePoint || data.radiusPoint;
      const plane = (planeNormal && planePoint) ? new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, planePoint) : null;
      const radialDir = new THREE.Vector3().subVectors(data.radiusPoint, data.center).normalize();

      RadialDimensionAnnotation.dragLabelOnPlane(pmimode, ctx, {
        makePlane: () => plane,
        onDrag: (hit) => {
          plane.projectPoint(hit, hit);
          ensurePersistent(ann);
          ann.persistentData.labelWorld = [hit.x, hit.y, hit.z];
          const toMouse = new THREE.Vector3().subVectors(hit, data.center);
          ann.offset = toMouse.dot(radialDir) - data.radius;
          ctx.updateLabel(idx, null, hit, ann);
          pmimode.refreshAnnotationsUI?.();
        },
        onEnd: () => {
          try { if (pmimode?.viewer?.controls) pmimode.viewer.controls.enabled = true; } catch { }
        },
      });
    } catch { /* ignore */ }
  }

}

function formatRadialLabel(measured, ann) {
  if (typeof measured !== 'number' || !Number.isFinite(measured)) {
    return { raw: '-', display: '-' };
  }
  const baseValue = ann?.displayStyle === 'diameter' ? measured * 2 : measured;
  const decRaw = Number(ann?.decimals);
  const decimals = Number.isFinite(decRaw) ? Math.max(0, Math.min(8, decRaw | 0)) : 3;
  const prefix = ann?.displayStyle === 'diameter' ? '⌀' : 'R';
  const raw = `${prefix}${baseValue.toFixed(decimals)}`;
  const displayBase = `${raw} (wu)`;
  const display = ann?.isReference ? `(${displayBase})` : displayBase;
  return { raw, display };
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
    let metadata = null;
    let radiusOverride = null;

    if (owner && typeof owner.getFaceMetadata === 'function') {
      metadata = owner.getFaceMetadata(ann.cylindricalFaceRef);
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

      if (metadata && typeof metadata === 'object') {
        const overrideCandidate = metadata.pmiRadiusOverride ?? metadata.radiusOverride;
        if (Number.isFinite(overrideCandidate) && overrideCandidate > 0) {
          radiusOverride = Math.abs(overrideCandidate);
        }
      }
    }

    if ((!center || !axis || !Number.isFinite(radius) || radius <= 0) && owner) {
      const pipeData = inferPipeFaceDataFromAuxEdges(owner, faceObj);
      if (pipeData) {
        center = pipeData.center;
        axis = pipeData.axis;
        radius = pipeData.radius;
        radiusPoint = pipeData.radiusPoint;
        perpendicular = pipeData.perpendicular;
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

    if (radiusOverride && center) {
      let dir = null;
      if (perpendicular && perpendicular.lengthSq() > 1e-12) {
        dir = perpendicular.clone().normalize();
      } else if (radiusPoint) {
        dir = new THREE.Vector3().subVectors(radiusPoint, center);
        if (dir.lengthSq() > 1e-12) dir.normalize();
      }
      radius = radiusOverride;
      if (dir) {
        perpendicular = dir.clone();
        radiusPoint = center.clone().addScaledVector(dir, radius);
      }
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

function inferPipeFaceDataFromAuxEdges(owner, faceObj) {
  try {
    if (!owner || !faceObj) return null;
    const auxEdges = Array.isArray(owner._auxEdges) ? owner._auxEdges : null;
    if (!auxEdges || auxEdges.length === 0) return null;
    const faceName = (faceObj.name || faceObj.userData?.faceName || '').trim();
    if (!faceName) return null;
    const baseName = pipeFaceBaseName(faceName);
    if (!baseName) return null;
    const aux = findAuxEdgeByName(auxEdges, `${baseName}_PATH`);
    if (!aux || !Array.isArray(aux.points) || aux.points.length < 2) return null;

    owner.updateMatrixWorld?.(true);
    faceObj.updateMatrixWorld?.(true);

    const polyline = buildAuxPolylineWorld(aux, owner);
    if (!polyline || polyline.length < 2) return null;
    const samples = collectFaceSamplePoints(faceObj, 16);
    if (!samples.length) return null;

    let best = null;
    for (const sample of samples) {
      const info = closestPointOnPolyline(sample, polyline, !!aux.closedLoop);
      if (!info || !info.point) continue;
      const radialVec = new THREE.Vector3().subVectors(sample, info.point);
      const lenSq = radialVec.lengthSq();
      if (!(lenSq > 1e-10)) continue;
      const radius = Math.sqrt(lenSq);
      radialVec.normalize();
      if (!best || radius > best.radius) {
        best = {
          center: info.point.clone(),
          axis: info.direction ? info.direction.clone() : null,
          radius,
          radiusPoint: info.point.clone().addScaledVector(radialVec, radius),
          perpendicular: radialVec.clone(),
        };
      }
    }

    if (!best) return null;
    if (!best.axis || best.axis.lengthSq() < 1e-10) {
      best.axis = estimatePolylineTangent(polyline, best.center, !!aux.closedLoop) || new THREE.Vector3(0, 1, 0);
    }
    return best;
  } catch {
    return null;
  }
}

function findAuxEdgeByName(auxEdges, name) {
  if (!Array.isArray(auxEdges) || !name) return null;
  for (const aux of auxEdges) {
    if (aux?.name === name) return aux;
  }
  const lower = name.toLowerCase();
  for (const aux of auxEdges) {
    if (typeof aux?.name === 'string' && aux.name.toLowerCase() === lower) return aux;
  }
  return null;
}

function buildAuxPolylineWorld(aux, owner) {
  try {
    const pts = [];
    const matrix = (!aux.polylineWorld && owner?.matrixWorld) ? owner.matrixWorld : null;
    const tmp = new THREE.Vector3();
    for (const p of aux.points) {
      if (Array.isArray(p) && p.length >= 3) {
        tmp.set(p[0], p[1], p[2]);
      } else if (p && typeof p === 'object') {
        tmp.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
      } else {
        continue;
      }
      if (matrix) tmp.applyMatrix4(matrix);
      pts.push(tmp.clone());
    }
    return pts;
  } catch {
    return null;
  }
}

function collectFaceSamplePoints(faceObj, maxSamples = 16) {
  try {
    const geom = faceObj?.geometry;
    if (!geom) return [];
    const pos = typeof geom.getAttribute === 'function' ? geom.getAttribute('position') : null;
    const matrix = faceObj.matrixWorld || new THREE.Matrix4();
    const samples = [];
    const tmp = new THREE.Vector3();
    if (pos && pos.count > 0) {
      const step = Math.max(1, Math.floor(pos.count / maxSamples));
      for (let i = 0; i < pos.count && samples.length < maxSamples; i += step) {
        tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(matrix);
        samples.push(tmp.clone());
      }
    }
    if (!samples.length) {
      try {
        geom.computeBoundingSphere?.();
        if (geom.boundingSphere) {
          tmp.copy(geom.boundingSphere.center).applyMatrix4(matrix);
          samples.push(tmp.clone());
        }
      } catch { /* ignore */ }
    }
    return samples;
  } catch {
    return [];
  }
}

function closestPointOnPolyline(point, polyline, closedLoop = false) {
  if (!point || !Array.isArray(polyline) || polyline.length < 2) return null;
  const proj = new THREE.Vector3();
  const seg = new THREE.Vector3();
  const delta = new THREE.Vector3();
  let bestPoint = null;
  let bestDir = null;
  let bestDist = Infinity;
  const count = polyline.length;
  const limit = closedLoop ? count : count - 1;
  for (let i = 0; i < limit; i++) {
    const a = polyline[i];
    const b = polyline[(i + 1) % count];
    if (!a || !b) continue;
    seg.copy(b).sub(a);
    const lenSq = seg.lengthSq();
    if (lenSq < 1e-14) continue;
    delta.copy(point).sub(a);
    let t = delta.dot(seg) / lenSq;
    t = Math.max(0, Math.min(1, t));
    proj.copy(a).addScaledVector(seg, t);
    const distSq = proj.distanceToSquared(point);
    if (distSq < bestDist) {
      bestDist = distSq;
      bestPoint = proj.clone();
      bestDir = seg.clone().normalize();
    }
  }
  if (!bestPoint) return null;
  return { point: bestPoint, direction: bestDir, distanceSq: bestDist };
}

function estimatePolylineTangent(polyline, center, closedLoop = false) {
  if (!Array.isArray(polyline) || polyline.length < 2 || !center) return null;
  let closest = null;
  let bestDist = Infinity;
  const mid = new THREE.Vector3();
  const seg = new THREE.Vector3();
  const count = polyline.length;
  const limit = closedLoop ? count : count - 1;
  for (let i = 0; i < limit; i++) {
    const a = polyline[i];
    const b = polyline[(i + 1) % count];
    if (!a || !b) continue;
    mid.copy(a).add(b).multiplyScalar(0.5);
    const dist = mid.distanceToSquared(center);
    if (dist < bestDist) {
      bestDist = dist;
      seg.copy(b).sub(a);
      closest = seg.lengthSq() > 1e-14 ? seg.clone().normalize() : null;
    }
  }
  return closest;
}

function pipeFaceBaseName(faceName) {
  const match = /^(.*?)(_Outer|_Inner|_CapStart|_CapEnd)$/i.exec(faceName);
  return match ? match[1] : null;
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
