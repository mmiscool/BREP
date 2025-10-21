import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;

export const DEFAULT_RESOLUTION = 24;

const ensurePoint = (point, fallbackId, fallbackPosition) => {
  const positionSource = Array.isArray(point?.position)
    ? point.position
    : Array.isArray(fallbackPosition)
      ? fallbackPosition
      : [0, 0, 0];
  const position = [
    Number(positionSource[0]) || 0,
    Number(positionSource[1]) || 0,
    Number(positionSource[2]) || 0,
  ];
  return {
    id: String(point?.id ?? fallbackId ?? `pt-${Math.random().toString(36).slice(2)}`),
    position,
  };
};

const ensureWeight = (weight, fallbackId, anchor) => {
  const anchorPos = Array.isArray(anchor?.position)
    ? anchor.position
    : [0, 0, 0];
  const src = Array.isArray(weight?.position) ? weight.position : null;
  const position = src
    ? [
        Number(src[0]) || 0,
        Number(src[1]) || 0,
        Number(src[2]) || 0,
      ]
    : [
        (Number(anchorPos[0]) || 0) + 1,
        Number(anchorPos[1]) || 0,
        Number(anchorPos[2]) || 0,
      ];
  return {
    id: String(weight?.id ?? fallbackId ?? `wt-${Math.random().toString(36).slice(2)}`),
    position,
  };
};

export function normalizeSplineData(rawSpline) {
  let spline = rawSpline;
  if (!spline || typeof spline !== "object") {
    spline = null;
  }

  let points = Array.isArray(spline?.points) ? spline.points : null;
  if (!points || points.length < 2) {
    points = [
      { id: "p0", position: [0, 0, 0] },
      { id: "p1", position: [5, 0, 0] },
    ];
  }

  const normalizedPoints = points.map((pt, index) =>
    ensurePoint(pt, `p${index}`)
  );

  const startWeight = ensureWeight(
    spline?.startWeight,
    "ws",
    normalizedPoints[0]
  );
  const endWeight = ensureWeight(
    spline?.endWeight,
    "we",
    normalizedPoints[normalizedPoints.length - 1]
  );

  return {
    points: normalizedPoints,
    startWeight,
    endWeight,
  };
}

function computeTangents(points, startHandle, endHandle) {
  const tangents = [];
  const count = points.length;
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      const vec = new THREE.Vector3().subVectors(startHandle, points[0]);
      if (vec.lengthSq() < 1e-6 && count >= 2) {
        vec.subVectors(points[1], points[0]);
      }
      tangents.push(vec);
      continue;
    }
    if (i === count - 1) {
      const vec = new THREE.Vector3().subVectors(endHandle, points[i]);
      if (vec.lengthSq() < 1e-6 && count >= 2) {
        vec.subVectors(points[i], points[i - 1]);
      }
      tangents.push(vec);
      continue;
    }
    const prev = points[i - 1];
    const next = points[i + 1];
    tangents.push(new THREE.Vector3().subVectors(next, prev).multiplyScalar(0.5));
  }
  return tangents;
}

const hermitePoint = (p0, p1, t0, t1, t) => {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  const out = new THREE.Vector3();
  out
    .addScaledVector(p0, h00)
    .addScaledVector(t0, h10)
    .addScaledVector(p1, h01)
    .addScaledVector(t1, h11);
  return out;
};

export function buildHermitePolyline(spline, resolution = DEFAULT_RESOLUTION) {
  const anchors = Array.isArray(spline?.points)
    ? spline.points.map(
        (pt) =>
          new THREE.Vector3(
            Number(pt.position?.[0]) || 0,
            Number(pt.position?.[1]) || 0,
            Number(pt.position?.[2]) || 0,
          )
      )
    : [];

  if (anchors.length < 2) {
    return { positions: [], polyline: [] };
  }

  const startHandle = new THREE.Vector3(
    Number(spline?.startWeight?.position?.[0]) || anchors[0].x,
    Number(spline?.startWeight?.position?.[1]) || anchors[0].y,
    Number(spline?.startWeight?.position?.[2]) || anchors[0].z,
  );
  const endHandle = new THREE.Vector3(
    Number(spline?.endWeight?.position?.[0]) || anchors[anchors.length - 1].x,
    Number(spline?.endWeight?.position?.[1]) || anchors[anchors.length - 1].y,
    Number(spline?.endWeight?.position?.[2]) || anchors[anchors.length - 1].z,
  );

  const tangents = computeTangents(anchors, startHandle, endHandle);
  const samplesPerSegment = Math.max(4, Math.floor(resolution));
  const positions = [];
  const polyline = [];

  for (let seg = 0; seg < anchors.length - 1; seg++) {
    const a = anchors[seg];
    const b = anchors[seg + 1];
    const ta = tangents[seg];
    const tb = tangents[seg + 1];
    const localSamples = samplesPerSegment;

    for (let i = 0; i <= localSamples; i++) {
      if (seg > 0 && i === 0) continue;
      const t = i / localSamples;
      const point = hermitePoint(a, b, ta, tb, t);
      positions.push(point.x, point.y, point.z);
      polyline.push([point.x, point.y, point.z]);
    }
  }

  return { positions, polyline };
}

export function cloneSplineData(spline) {
  return JSON.parse(JSON.stringify(spline || null));
}
