import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;

export const DEFAULT_RESOLUTION = 24;

const ensurePoint = (point, fallbackId, fallbackPosition, index = 0) => {
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

  // Ensure forward and backward extension distances
  const forwardDistance = typeof point?.forwardDistance === "number" 
    ? Math.max(0, Number(point.forwardDistance)) 
    : 1.0; // Default forward distance

  const backwardDistance = typeof point?.backwardDistance === "number" 
    ? Math.max(0, Number(point.backwardDistance)) 
    : 1.0; // Default backward distance

  const flipDirection = typeof point?.flipDirection === "boolean" 
    ? point.flipDirection 
    : false;

  // Store complete transformation matrix (position + rotation)
  // Default to identity rotation (pointing along X-axis)
  const rotation = Array.isArray(point?.rotation) && point.rotation.length === 9
    ? point.rotation.slice() // Copy existing rotation matrix
    : [1, 0, 0, 0, 1, 0, 0, 0, 1]; // Default identity rotation (X-axis forward)

  return {
    id: String(point?.id ?? fallbackId ?? `pt-${Math.random().toString(36).slice(2)}`),
    position,
    rotation, // 3x3 rotation matrix stored as flat array
    forwardDistance,
    backwardDistance,
    flipDirection,
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
      { 
        id: "p0", 
        position: [0, 0, 0],
        rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], // Identity matrix
        forwardDistance: 1.0,
        backwardDistance: 1.0,
        flipDirection: false
      },
      { 
        id: "p1", 
        position: [5, 0, 0],
        rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], // Identity matrix
        forwardDistance: 1.0,
        backwardDistance: 1.0,
        flipDirection: false
      },
    ];
  }

  const normalizedPoints = points.map((pt, index) =>
    ensurePoint(pt, `p${index}`, null, index)
  );

  return {
    points: normalizedPoints,
  };
}

function computeTangents(pointsData, positions) {
  const tangents = [];
  const count = positions.length;
  
  for (let i = 0; i < count; i++) {
    const pointData = pointsData[i];
    
    // Extract X-axis direction from the stored rotation matrix
    const rotation = pointData.rotation || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let direction = new THREE.Vector3(rotation[0], rotation[1], rotation[2]);
    
    // Apply flip if needed
    if (pointData.flipDirection) {
      direction.multiplyScalar(-1);
    }
    
    // Use the appropriate distance for scaling
    const distance = i === 0 ? pointData.forwardDistance : 
                    i === count - 1 ? pointData.backwardDistance :
                    (pointData.forwardDistance + pointData.backwardDistance) * 0.5;
    
    const tangent = direction.multiplyScalar(distance);
    tangents.push(tangent);
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
  const pointsData = Array.isArray(spline?.points) ? spline.points : [];
  
  if (pointsData.length < 2) {
    return { positions: [], polyline: [] };
  }

  const anchors = pointsData.map(
    (pt) =>
      new THREE.Vector3(
        Number(pt.position?.[0]) || 0,
        Number(pt.position?.[1]) || 0,
        Number(pt.position?.[2]) || 0,
      )
  );

  const tangents = computeTangents(pointsData, anchors);
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
