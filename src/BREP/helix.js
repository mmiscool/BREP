import * as THREE from 'three';

const EPS = 1e-9;

const finiteOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toVec3 = (value, fallback = [0, 0, 0]) => {
  if (value && typeof value.x === 'number') {
    return new THREE.Vector3(
      Number(value.x) || 0,
      Number(value.y) || 0,
      Number(value.z) || 0,
    );
  }
  if (Array.isArray(value)) {
    return new THREE.Vector3(
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
    );
  }
  return new THREE.Vector3(
    Number(fallback?.[0]) || 0,
    Number(fallback?.[1]) || 0,
    Number(fallback?.[2]) || 0,
  );
};

const normalizedOr = (vec, fallback = new THREE.Vector3(0, 0, 1)) => {
  const out = vec.clone();
  if (out.lengthSq() < EPS) return fallback.clone().normalize();
  return out.normalize();
};

const matrixFromTransform = (transform) => {
  if (!transform) return null;
  if (transform.isMatrix4) return transform.clone();

  const pos = Array.isArray(transform.position) ? transform.position : [0, 0, 0];
  const rot = Array.isArray(transform.rotationEuler) ? transform.rotationEuler : [0, 0, 0];
  const scl = Array.isArray(transform.scale) ? transform.scale : [1, 1, 1];

  const position = new THREE.Vector3(
    Number(pos[0]) || 0,
    Number(pos[1]) || 0,
    Number(pos[2]) || 0,
  );
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(Number(rot[0]) || 0),
    THREE.MathUtils.degToRad(Number(rot[1]) || 0),
    THREE.MathUtils.degToRad(Number(rot[2]) || 0),
    'XYZ',
  );
  const quat = new THREE.Quaternion().setFromEuler(euler);
  const scale = new THREE.Vector3(
    Math.abs(Number(scl[0]) || 1),
    Math.abs(Number(scl[1]) || 1),
    Math.abs(Number(scl[2]) || 1),
  );

  return new THREE.Matrix4().compose(position, quat, scale);
};

const buildPlacementMatrix = (opts = {}) => {
  const fromTransform = matrixFromTransform(opts.transform);
  if (fromTransform) return fromTransform;

  const origin = toVec3(opts.origin, [0, 0, 0]);
  const axisDir = normalizedOr(toVec3(opts.axis, [0, 0, 1]), new THREE.Vector3(0, 0, 1));

  let xDir = opts.xDirection ? toVec3(opts.xDirection) : null;
  if (!xDir || xDir.lengthSq() < EPS) {
    const fallback = Math.abs(axisDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    xDir = new THREE.Vector3().crossVectors(fallback, axisDir);
  } else {
    // Remove any component along the axis so we remain perpendicular
    xDir = xDir.addScaledVector(axisDir, -xDir.dot(axisDir));
  }
  if (xDir.lengthSq() < EPS) {
    const fallback = Math.abs(axisDir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    xDir = new THREE.Vector3().crossVectors(axisDir, fallback);
  }
  xDir.normalize();
  const yDir = new THREE.Vector3().crossVectors(axisDir, xDir).normalize();

  const m = new THREE.Matrix4().makeBasis(xDir, yDir, axisDir);
  m.setPosition(origin);
  return m;
};

/**
 * Build a helix polyline in 3D.
 * - Generates points for a right/left-handed helix with optional taper.
 * - Orientation is controlled by a transform matrix, or by origin/axis/xDirection.
 * - Returns world-space polyline points for reuse by features (threads, sweep paths, etc.).
 * Options: radius/endRadius, pitch + (turns|height via lengthMode), startAngleDeg/startAngle, clockwise,
 * segmentsPerTurn (or resolution), and placement via `transform` or `{ origin, axis, xDirection }`.
 */
export function buildHelixPolyline(opts = {}) {
  const r0 = Math.max(1e-6, Math.abs(finiteOr(opts.radius, 5)));
  const hasEndRadius = opts.endRadius != null && Number.isFinite(Number(opts.endRadius));
  const r1 = hasEndRadius ? Math.max(1e-6, Math.abs(finiteOr(opts.endRadius, r0))) : r0;

  let pitch = Math.max(1e-6, Math.abs(finiteOr(opts.pitch, 1)));
  const lengthMode = String(opts.lengthMode || opts.mode || 'turns').toLowerCase();
  let turns = finiteOr(opts.turns, NaN);
  let height = finiteOr(opts.height, NaN);

  // Allow negative height to flip the axis direction while keeping a positive magnitude
  let axisSign = 1;
  if (Number.isFinite(height) && height < 0) {
    axisSign = -1;
    height = Math.abs(height);
  }

  if (lengthMode === 'height' && Number.isFinite(height) && height > EPS) {
    turns = height / pitch;
  } else {
    if (!Number.isFinite(turns) || turns <= 0) {
      if (Number.isFinite(height) && height > EPS) turns = height / pitch;
      else turns = 1;
    }
    height = Number.isFinite(height) && height > EPS ? height : pitch * turns;
  }

  // Keep pitch consistent with the resolved height/turns
  if (Number.isFinite(turns) && turns > EPS) pitch = height / turns;
  else {
    turns = 1;
    height = pitch;
  }

  const segsPerTurn = Math.max(8, Math.floor(finiteOr(opts.segmentsPerTurn, finiteOr(opts.resolution, 64))));
  const totalSeg = Math.max(1, Math.round(segsPerTurn * Math.max(turns, EPS)));

  const startAngleDeg = finiteOr(opts.startAngleDeg, NaN);
  const startAngleRad = Number.isFinite(startAngleDeg)
    ? THREE.MathUtils.degToRad(startAngleDeg)
    : finiteOr(opts.startAngle, 0);
  const handedRaw = String(opts.handedness || (opts.clockwise ? 'left' : 'right')).toLowerCase();
  const clockwise = handedRaw === 'left' || opts.clockwise === true;
  const angleSign = clockwise ? -1 : 1;

  const placement = buildPlacementMatrix(opts);
  const normalMat = new THREE.Matrix3();
  normalMat.getNormalMatrix(placement);

  const origin = new THREE.Vector3().setFromMatrixPosition(placement);
  const axisDir = new THREE.Vector3(0, 0, axisSign).applyMatrix3(normalMat).normalize();

  const polyline = [];
  const tmp = new THREE.Vector3();
  for (let i = 0; i <= totalSeg; i++) {
    const t = i / totalSeg;
    const theta = startAngleRad + angleSign * (turns * t * Math.PI * 2);
    const radius = r0 + (r1 - r0) * t;
    tmp.set(Math.cos(theta) * radius, Math.sin(theta) * radius, height * t * axisSign);
    tmp.applyMatrix4(placement);
    polyline.push([tmp.x, tmp.y, tmp.z]);
  }

  const axisEnd = origin.clone().addScaledVector(axisDir, height);

  return {
    polyline,
    closedLoop: false,
    pitch,
    turns,
    height,
    radiusStart: r0,
    radiusEnd: r1,
    clockwise,
    handedness: clockwise ? 'left' : 'right',
    startAngleRad,
    origin: [origin.x, origin.y, origin.z],
    axisDirection: [axisDir.x, axisDir.y, axisDir.z],
    axisLine: [
      [origin.x, origin.y, origin.z],
      [axisEnd.x, axisEnd.y, axisEnd.z],
    ],
  };
}
