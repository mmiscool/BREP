import * as THREE from 'three';
import { BaseAnnotation } from '../BaseAnnotation.js';
import { makeOverlayLine, addArrowCone, objectRepresentativePoint } from '../annUtils.js';

const inputParamsSchema = {
  id: {
    type: 'string',
    default_value: null,
    label: 'ID',
    hint: 'unique identifier for the linear dimension',
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
  targets: {
    type: 'reference_selection',
    selectionFilter: ['VERTEX', 'EDGE'],
    multiple: true,
    default_value: [],
    label: 'Targets',
    hint: 'Select two vertices, or a vertex and an edge, or a single edge',
  },
  planeRefName: {
    type: 'reference_selection',
    selectionFilter: ['FACE', 'PLANE'],
    multiple: false,
    default_value: '',
    label: 'Face/Plane',
    hint: 'Projection plane (optional)',
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
    hint: 'Offset distance for the dimension line',
    step: 'any',
  },
  showExt: {
    type: 'boolean',
    default_value: true,
    label: 'Extension Lines',
    hint: 'Draw extension lines from anchors to offset line',
  },
  isReference: {
    type: 'boolean',
    default_value: false,
    label: 'Reference',
    hint: 'Mark as reference dimension (parentheses)',
  },
};

export class LinearDimensionAnnotation extends BaseAnnotation {
  static entityType = 'linear';
  static type = 'linear';
  static shortName = 'DIM';
  static longName = 'Linear Dimension';
  static title = 'Linear';
  static inputParamsSchema = inputParamsSchema;

  constructor(opts = {}) {
    super(opts);
  }

  uiFieldsTest() {
    const planeRefName = this.inputParams?.planeRefName;
    const hasPlane = Array.isArray(planeRefName)
      ? planeRefName.length > 0
      : Boolean(String(planeRefName || '').trim());
    if (hasPlane) return { exclude: ['alignment'] };
    return null;
  }

  async run(renderingContext) {
    const { pmimode, group, idx, ctx } = renderingContext;
    const ann = this.inputParams;
    const pts = computeDimPoints(pmimode, ann);
    const measured = (pts && pts.p0 && pts.p1) ? pts.p0.distanceTo(pts.p1) : null;
    const labelInfo = formatLinearLabel(measured, ann);
    ann.value = labelInfo.display;

    if (!pts || !pts.p0 || !pts.p1) return [];

    if (!ann.persistentData || typeof ann.persistentData !== 'object') {
      ann.persistentData = {};
    }
    const persistent = ann.persistentData;

    try {
      const color = 0x10b981;
      const normal = ctx.alignNormal ? ctx.alignNormal(ann?.alignment || 'view', ann) : new THREE.Vector3(0, 0, 1);
      const dir = new THREE.Vector3().subVectors(pts.p1, pts.p0);
      if (dir.lengthSq() < 1e-8) return [];
      dir.normalize();
      const t = new THREE.Vector3().crossVectors(normal, dir).normalize();

      let off = Number(ann?.offset);
      if (!Number.isFinite(off)) off = ctx.screenSizeWorld ? ctx.screenSizeWorld(20) : 0.05;
      const p0o = pts.p0.clone().addScaledVector(t, off);
      const p1o = pts.p1.clone().addScaledVector(t, off);

      if (ann?.showExt !== false && off !== 0) {
        group.add(makeOverlayLine(pts.p0, p0o, color));
        group.add(makeOverlayLine(pts.p1, p1o, color));
      }
      group.add(makeOverlayLine(p0o, p1o, color));

      const arrowLength = ctx.screenSizeWorld ? ctx.screenSizeWorld(12) : 0.08;
      const arrowWidth = ctx.screenSizeWorld ? ctx.screenSizeWorld(4) : 0.03;
      addArrowCone(group, p0o, dir.clone().negate(), arrowLength, arrowWidth, color);
      addArrowCone(group, p1o, dir.clone(), arrowLength, arrowWidth, color);

      if (persistent.labelWorld) {
        try {
          const labelVec = arrayToVector(persistent.labelWorld);
          const lineLen = p0o.distanceTo(p1o);
          if (lineLen > 1e-6) {
            const toLabel = labelVec.clone().sub(p0o);
            const along = toLabel.dot(dir);
            const clamped = Math.max(0, Math.min(lineLen, along));
            const nearest = p0o.clone().addScaledVector(dir, clamped);
            const perpDist = labelVec.distanceTo(nearest);
            const threshold = ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : 0.02;
            if (perpDist > threshold) group.add(makeOverlayLine(nearest, labelVec, color));
          }
        } catch { /* ignore */ }
      }

      const dec = Number.isFinite(ann.decimals) ? ann.decimals : (pmimode?._opts?.dimDecimals | 0);
      const value = pts.p0.distanceTo(pts.p1);
      const displayInfo = formatLinearLabel(value, ann, dec);
      ann.value = displayInfo.display;
      const labelText = ctx.formatReferenceLabel ? ctx.formatReferenceLabel(ann, displayInfo.raw) : displayInfo.display;

      const labelPos = (() => {
        if (persistent.labelWorld) return arrayToVector(persistent.labelWorld);
        if (ann.labelWorld) return arrayToVector(ann.labelWorld);
        const mid = new THREE.Vector3().addVectors(p0o, p1o).multiplyScalar(0.5);
        const lift = ctx.screenSizeWorld ? ctx.screenSizeWorld(6) : 0.02;
        return mid.addScaledVector(t, lift);
      })();

      if (labelPos) ctx.updateLabel(idx, labelText, labelPos, ann);
    } catch { /* ignore */ }
    return [];
  }

  static onLabelPointerDown(pmimode, idx, ann, e, ctx) {
    try {
      const v = pmimode.viewer; const cam = v?.camera; if (!cam) return;
      const pts = computeDimPoints(pmimode, ann);
      if (!pts || !pts.p0 || !pts.p1) return;

      const p0 = pts.p0;
      const p1 = pts.p1;
      const normal = ctx.alignNormal ? ctx.alignNormal(ann?.alignment || 'view', ann) : new THREE.Vector3(0, 0, 1);
      const dir = new THREE.Vector3().subVectors(p1, p0).normalize();
      const t = new THREE.Vector3().crossVectors(normal, dir).normalize();
      const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, mid);

      LinearDimensionAnnotation.dragLabelOnPlane(pmimode, ctx, {
        makePlane: () => plane,
        onDrag: (hit) => {
          const toMouse = new THREE.Vector3().subVectors(hit, mid);
          const offsetDist = toMouse.dot(t);
          ann.offset = offsetDist;
          const vecOut = [hit.x, hit.y, hit.z];
          LinearDimensionAnnotation.ensurePersistentData(ann);
          ann.persistentData.labelWorld = vecOut;
          ann.labelWorld = vecOut;
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

function formatLinearLabel(measured, ann, overrideDecimals) {
  if (typeof measured !== 'number' || !Number.isFinite(measured)) {
    return { raw: '-', display: '-' };
  }
  const decRaw = overrideDecimals !== undefined ? overrideDecimals : Number(ann?.decimals);
  const decimals = Number.isFinite(decRaw) ? Math.max(0, Math.min(8, decRaw | 0)) : 3;
  const raw = `${measured.toFixed(decimals)}`;
  const display = ann?.isReference ? `(${raw})` : raw;
  return { raw, display };
}

function computeDimPoints(pmimode, ann) {
  const hasTargets = Array.isArray(ann?.targets);
  try {
    const scene = pmimode?.viewer?.partHistory?.scene;
    const targets = normalizeTargetList(hasTargets ? ann.targets : null);
    if (scene && targets.length) {
      const objects = resolveTargetObjects(scene, targets);
      if (objects.length) {
        const vertices = [];
        const edges = [];
        for (const obj of objects) {
          const type = typeof obj?.type === 'string' ? obj.type.toUpperCase() : '';
          if (type === 'VERTEX') vertices.push(obj);
          else if (type === 'EDGE') edges.push(obj);
        }
        const viewer = pmimode?.viewer;
        if (vertices.length >= 2) {
          const p0 = resolveVertexPoint(viewer, vertices[0]);
          const p1 = resolveVertexPoint(viewer, vertices[1]);
          if (p0 && p1) return { p0, p1 };
        }
        if (vertices.length === 1 && edges.length) {
          const p0 = resolveVertexPoint(viewer, vertices[0]);
          const p1 = p0 ? closestEndpointToPoint(edges, p0) : null;
          if (p0 && p1) return { p0, p1 };
        }
        if (!vertices.length && edges.length) {
          if (edges.length === 1) {
            const ends = edgeEndpointsWorld(edges[0]);
            if (ends) return { p0: ends.a, p1: ends.b };
          } else if (edges.length >= 2) {
            return closestPointsBetweenEdges(edges[0], edges[1]);
          }
        }
      }
    }
  } catch { /* ignore */ }
  if (!hasTargets) {
    try {
      const scene = pmimode?.viewer?.partHistory?.scene;
      const aName = ann?.aRefName || null;
      const bName = ann?.bRefName || null;
      if (scene && (aName || bName)) {
        const objA = aName ? scene.getObjectByName(aName) : null;
        const objB = bName ? scene.getObjectByName(bName) : null;
        if (objA && objB) return closestPointsForObjects(objA, objB);
        if (objA && !objB) {
          const pA = objectRepresentativePoint(pmimode.viewer, objA);
          const pB = vectorFromAnnotationPoint(ann.p1);
          if (pA && pB) return { p0: pA, p1: pB };
        }
        if (!objA && objB) {
          const pB = objectRepresentativePoint(pmimode.viewer, objB);
          const pA = vectorFromAnnotationPoint(ann.p0);
          if (pA && pB) return { p0: pA, p1: pB };
        }
      }
    } catch { /* ignore */ }
  }
  return {
    p0: vectorFromAnnotationPoint(ann?.p0) || new THREE.Vector3(0, 0, 0),
    p1: vectorFromAnnotationPoint(ann?.p1) || new THREE.Vector3(0, 0, 0),
  };
}

function normalizeTargetList(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function resolveTargetObjects(scene, targets) {
  if (!scene || !Array.isArray(targets)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of targets) {
    let obj = null;
    if (entry && typeof entry === 'object') {
      if (entry.isObject3D) obj = entry;
      else if (entry.name) obj = scene.getObjectByName(entry.name);
    } else if (entry != null) {
      const key = String(entry).trim();
      if (key) obj = scene.getObjectByName(key);
    }
    if (!obj) continue;
    const key = obj.uuid || obj.id || obj.name;
    if (key != null) {
      const keyStr = String(key);
      if (seen.has(keyStr)) continue;
      seen.add(keyStr);
    }
    out.push(obj);
  }
  return out;
}

function resolveVertexPoint(viewer, vertex) {
  const rep = objectRepresentativePoint(viewer, vertex);
  if (rep && rep.clone) return rep.clone();
  if (rep && rep.isVector3) return rep.clone();
  if (vertex?.getWorldPosition) return vertex.getWorldPosition(new THREE.Vector3());
  return null;
}

function closestEndpointToPoint(edges, point) {
  if (!Array.isArray(edges) || !point) return null;
  let best = null;
  let bestD2 = Infinity;
  for (const edge of edges) {
    const ends = edgeEndpointsWorld(edge);
    if (ends) {
      const d2a = ends.a.distanceToSquared(point);
      if (d2a < bestD2) { bestD2 = d2a; best = ends.a; }
      const d2b = ends.b.distanceToSquared(point);
      if (d2b < bestD2) { bestD2 = d2b; best = ends.b; }
      continue;
    }
    const fallback = closestPointOnEdgeToPoint(edge, point);
    if (fallback) {
      const d2 = fallback.distanceToSquared(point);
      if (d2 < bestD2) { bestD2 = d2; best = fallback; }
    }
  }
  return best ? best.clone() : null;
}

function edgeEndpointsWorld(edge) {
  if (!edge) return null;
  try { edge.updateMatrixWorld?.(true); } catch { /* ignore */ }
  try {
    if (typeof edge.points === 'function') {
      const pts = edge.points(true);
      if (Array.isArray(pts) && pts.length >= 2) {
        const a = arrayToVector(pts[0]);
        const b = arrayToVector(pts[pts.length - 1]);
        if (a && b) return { a, b };
      }
    }
  } catch { /* ignore */ }
  const poly = Array.isArray(edge?.userData?.polylineLocal)
    ? edge.userData.polylineLocal
    : null;
  if (poly && poly.length >= 2) {
    const a = arrayToVector(poly[0]);
    const b = arrayToVector(poly[poly.length - 1]);
    if (a && b) {
      if (edge.matrixWorld) {
        a.applyMatrix4(edge.matrixWorld);
        b.applyMatrix4(edge.matrixWorld);
      }
      return { a, b };
    }
  }
  const startAttr = edge?.geometry?.attributes?.instanceStart;
  const endAttr = edge?.geometry?.attributes?.instanceEnd;
  if (startAttr && endAttr && startAttr.count >= 1) {
    const a = new THREE.Vector3(startAttr.getX(0), startAttr.getY(0), startAttr.getZ(0));
    const b = new THREE.Vector3(endAttr.getX(0), endAttr.getY(0), endAttr.getZ(0));
    if (edge.matrixWorld) {
      a.applyMatrix4(edge.matrixWorld);
      b.applyMatrix4(edge.matrixWorld);
    }
    return { a, b };
  }
  const pos = edge?.geometry?.getAttribute?.('position');
  if (pos && pos.itemSize === 3 && pos.count >= 2) {
    const a = new THREE.Vector3(pos.getX(0), pos.getY(0), pos.getZ(0));
    const b = new THREE.Vector3(pos.getX(pos.count - 1), pos.getY(pos.count - 1), pos.getZ(pos.count - 1));
    if (edge.matrixWorld) {
      a.applyMatrix4(edge.matrixWorld);
      b.applyMatrix4(edge.matrixWorld);
    }
    return { a, b };
  }
  return null;
}

function closestPointsForObjects(objA, objB) {
  if (objA?.type === 'VERTEX' && objB?.type === 'VERTEX') {
    return { p0: objA.getWorldPosition(new THREE.Vector3()), p1: objB.getWorldPosition(new THREE.Vector3()) };
  }
  if (objA?.type === 'EDGE' && objB?.type === 'VERTEX') {
    const v = objB.getWorldPosition(new THREE.Vector3());
    const p = closestPointOnEdgeToPoint(objA, v);
    return { p0: p, p1: v };
  }
  if (objA?.type === 'VERTEX' && objB?.type === 'EDGE') {
    const v = objA.getWorldPosition(new THREE.Vector3());
    const p = closestPointOnEdgeToPoint(objB, v);
    return { p0: v, p1: p };
  }
  if (objA?.type === 'EDGE' && objB?.type === 'EDGE') {
    return closestPointsBetweenEdges(objA, objB);
  }
  return {
    p0: objectRepresentativePoint(null, objA) || new THREE.Vector3(),
    p1: objectRepresentativePoint(null, objB) || new THREE.Vector3(),
  };
}

function closestPointOnEdgeToPoint(edge, point) {
  try {
    const pts = edge.points(true);
    if (!pts || pts.length < 2) return edge.getWorldPosition(new THREE.Vector3());
    const p = point.clone();
    let best = { d2: Infinity, q: null };
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < pts.length - 1; i++) {
      a.set(pts[i].x, pts[i].y, pts[i].z);
      b.set(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
      const q = closestPointOnSegment(a, b, p);
      const d2 = q.distanceToSquared(p);
      if (d2 < best.d2) best = { d2, q };
    }
    return best.q || edge.getWorldPosition(new THREE.Vector3());
  } catch { return edge.getWorldPosition(new THREE.Vector3()); }
}

function closestPointsBetweenEdges(e1, e2) {
  try {
    const pts1 = e1.points(true);
    const pts2 = e2.points(true);
    if (!pts1 || pts1.length < 2 || !pts2 || pts2.length < 2) {
      return {
        p0: objectRepresentativePoint(null, e1) || new THREE.Vector3(),
        p1: objectRepresentativePoint(null, e2) || new THREE.Vector3(),
      };
    }
    const a0 = new THREE.Vector3();
    const a1 = new THREE.Vector3();
    const b0 = new THREE.Vector3();
    const b1 = new THREE.Vector3();
    let best = { d2: Infinity, p: null, q: null };
    for (let i = 0; i < pts1.length - 1; i++) {
      a0.set(pts1[i].x, pts1[i].y, pts1[i].z);
      a1.set(pts1[i + 1].x, pts1[i + 1].y, pts1[i + 1].z);
      for (let j = 0; j < pts2.length - 1; j++) {
        b0.set(pts2[j].x, pts2[j].y, pts2[j].z);
        b1.set(pts2[j + 1].x, pts2[j + 1].y, pts2[j + 1].z);
        const { p, q } = closestPointsOnSegments(a0, a1, b0, b1);
        const d2 = p.distanceToSquared(q);
        if (d2 < best.d2) best = { d2, p, q };
      }
    }
    return {
      p0: best.p || objectRepresentativePoint(null, e1) || new THREE.Vector3(),
      p1: best.q || objectRepresentativePoint(null, e2) || new THREE.Vector3(),
    };
  } catch {
    return {
      p0: objectRepresentativePoint(null, e1) || new THREE.Vector3(),
      p1: objectRepresentativePoint(null, e2) || new THREE.Vector3(),
    };
  }
}

function closestPointOnSegment(a, b, p) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, ab.dot(p.clone().sub(a)) / (ab.lengthSq() || 1)));
  return a.clone().addScaledVector(ab, t);
}

function closestPointsOnSegments(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s;
  let t;
  const EPS = 1e-12;
  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  const cp1 = p1.clone().addScaledVector(d1, s);
  const cp2 = p2.clone().addScaledVector(d2, t);
  return { p: cp1, q: cp2 };
}

function arrayToVector(value) {
  if (!value) return null;
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value)) return new THREE.Vector3(value[0] || 0, value[1] || 0, value[2] || 0);
  if (typeof value === 'object') {
    return new THREE.Vector3(value.x || 0, value.y || 0, value.z || 0);
  }
  return null;
}

function vectorFromAnnotationPoint(point) {
  if (!point) return null;
  if (point instanceof THREE.Vector3) return point.clone();
  if (Array.isArray(point)) return new THREE.Vector3(point[0] || 0, point[1] || 0, point[2] || 0);
  if (typeof point === 'object') return new THREE.Vector3(point.x || 0, point.y || 0, point.z || 0);
  return null;
}
