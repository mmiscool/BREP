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

export function buildHermitePolyline(spline, resolution = DEFAULT_RESOLUTION, bendRadius = 1.0) {
  const pointsData = Array.isArray(spline?.points) ? spline.points : [];
  
  if (pointsData.length < 2) {
    return { positions: [], polyline: [] };
  }

  const samplesPerSegment = Math.max(4, Math.floor(resolution));
  const positions = [];
  const polyline = [];

  // Clamp bend radius to reasonable range
  const clampedBendRadius = Math.max(0.1, Math.min(5.0, Number(bendRadius) || 1.0));

  // Helper function to calculate extension point
  const calculateExtensionPoint = (anchor, pointData, isForward) => {
    const rotation = pointData.rotation || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let direction = new THREE.Vector3(rotation[0], rotation[1], rotation[2]);
    
    if (pointData.flipDirection) {
      direction.multiplyScalar(-1);
    }
    
    const distance = isForward ? pointData.forwardDistance : pointData.backwardDistance;
    const extensionDir = isForward ? direction : direction.clone().multiplyScalar(-1);
    
    return anchor.clone().add(extensionDir.multiplyScalar(distance));
  };

  // Helper function to add straight line segment with specified number of samples
  const addStraightSegment = (start, end, samples) => {
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const point = start.clone().lerp(end, t);
      positions.push(point.x, point.y, point.z);
      polyline.push([point.x, point.y, point.z]);
    }
  };

  // Convert control points to THREE.Vector3
  const anchors = pointsData.map(
    (pt) =>
      new THREE.Vector3(
        Number(pt.position?.[0]) || 0,
        Number(pt.position?.[1]) || 0,
        Number(pt.position?.[2]) || 0,
      )
  );

  // Build the complete spline with straight and curved segments
  for (let i = 0; i < pointsData.length - 1; i++) {
    const currentAnchor = anchors[i];
    const nextAnchor = anchors[i + 1];
    const currentData = pointsData[i];
    const nextData = pointsData[i + 1];

    // Calculate extension points
    const currentForwardExt = calculateExtensionPoint(currentAnchor, currentData, true);
    const nextBackwardExt = calculateExtensionPoint(nextAnchor, nextData, false);

    // Use minimal samples for straight segments and maximum for curves
    const straightSamples = Math.max(1, Math.floor(samplesPerSegment * 0.15)); // Only 15% for straight parts
    const curvedSamples = Math.max(6, samplesPerSegment - (2 * straightSamples)); // Much more samples for smoother curves

    // Segment 1: Straight line from current anchor to its forward extension point
    if (i === 0) {
      // For the first segment, include the starting point
      addStraightSegment(currentAnchor, currentForwardExt, straightSamples);
    } else {
      // Skip the first point to avoid duplication
      for (let j = 1; j <= straightSamples; j++) {
        const t = j / straightSamples;
        const point = currentAnchor.clone().lerp(currentForwardExt, t);
        positions.push(point.x, point.y, point.z);
        polyline.push([point.x, point.y, point.z]);
      }
    }

    // Segment 2: Curved hermite interpolation from current forward extension to next backward extension
    // Create tangent vectors for the curved segment
    const currentExtDirection = currentForwardExt.clone().sub(currentAnchor).normalize();
    const nextExtDirection = nextAnchor.clone().sub(nextBackwardExt).normalize();
    
    // Calculate tangent scale based on user-controlled bend radius
    const extDistance = currentForwardExt.distanceTo(nextBackwardExt);
    const avgExtDistance = (currentData.forwardDistance + nextData.backwardDistance) * 0.5;
    
    // Use the bend radius to control curve smoothness
    // Lower bend radius = tighter curves, higher bend radius = smoother curves
    const baseScale = Math.max(extDistance * 0.3, avgExtDistance * 0.5); // Much more conservative base
    const tangentScale = baseScale * clampedBendRadius;
    
    const t0 = currentExtDirection.multiplyScalar(tangentScale);
    const t1 = nextExtDirection.multiplyScalar(tangentScale);

    // Add the curved segment (skip first point to avoid duplication)
    for (let j = 1; j <= curvedSamples; j++) {
      const t = j / curvedSamples;
      const point = hermitePoint(currentForwardExt, nextBackwardExt, t0, t1, t);
      positions.push(point.x, point.y, point.z);
      polyline.push([point.x, point.y, point.z]);
    }

    // Segment 3: Straight line from next backward extension to next anchor
    for (let j = 1; j <= straightSamples; j++) {
      const t = j / straightSamples;
      const point = nextBackwardExt.clone().lerp(nextAnchor, t);
      positions.push(point.x, point.y, point.z);
      polyline.push([point.x, point.y, point.z]);
    }
  }

  return { positions, polyline };
}

export function cloneSplineData(spline) {
  return JSON.parse(JSON.stringify(spline || null));
}
