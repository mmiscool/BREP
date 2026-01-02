const CUBE_ID = 'PUSHFACE_CUBE';
const CYLINDER_ID = 'PUSHFACE_CYL';
const BOX_SIZE = 6;
const CYL_RADIUS = 1.25;
const PUSH_DISTANCE = 0.5;

export async function test_pushFace(partHistory) {
  const cube = await partHistory.newFeature("P.CU");
  cube.inputParams.id = CUBE_ID;
  cube.inputParams.sizeX = BOX_SIZE;
  cube.inputParams.sizeY = BOX_SIZE;
  cube.inputParams.sizeZ = BOX_SIZE;

  const cyl = await partHistory.newFeature("P.CY");
  cyl.inputParams.id = CYLINDER_ID;
  cyl.inputParams.radius = CYL_RADIUS;
  cyl.inputParams.height = BOX_SIZE;
  cyl.inputParams.transform = {
    position: [BOX_SIZE / 2, 0, BOX_SIZE / 2],
    rotationEuler: [0, 0, 0],
    scale: [1, 1, 1],
  };

  const booleanFeature = await partHistory.newFeature("B");
  booleanFeature.inputParams.targetSolid = cube.inputParams.featureID;
  booleanFeature.inputParams.boolean = {
    operation: "SUBTRACT",
    targets: [cyl.inputParams.featureID],
  };

  return partHistory;
}

function measureRadialExtent(solid, faceName, centerX, centerZ) {
  if (typeof solid.getFace !== 'function') throw new Error('Solid missing getFace()');
  const face = solid.getFace(faceName);
  if (!Array.isArray(face) || face.length === 0) throw new Error(`Face "${faceName}" not found on solid ${solid.name || ''}`);

  const seen = new Set();
  const radii = [];
  for (const tri of face) {
    for (const p of [tri.p1, tri.p2, tri.p3]) {
      if (!Array.isArray(p) || p.length < 3) continue;
      const key = `${p[0]},${p[1]},${p[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const x = p[0];
      const z = p[2];
      radii.push(Math.hypot(x - centerX, z - centerZ));
    }
  }
  if (!radii.length) throw new Error(`No vertices collected for face "${faceName}"`);
  const sum = radii.reduce((a, b) => a + b, 0);
  const avg = sum / radii.length;
  const min = Math.min(...radii);
  const max = Math.max(...radii);
  return { avg, min, max };
}

function estimateRadialNormalSign(solid, faceName, centerX, centerZ) {
  const face = solid.getFace(faceName);
  if (!Array.isArray(face) || face.length === 0) return 0;

  let sum = 0;
  for (const tri of face) {
    if (!Array.isArray(tri.p1) || !Array.isArray(tri.p2) || !Array.isArray(tri.p3)) continue;
    const ax = tri.p1[0], ay = tri.p1[1], az = tri.p1[2];
    const bx = tri.p2[0], by = tri.p2[1], bz = tri.p2[2];
    const cx = tri.p3[0], cy = tri.p3[1], cz = tri.p3[2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const nz = ux * vy - uy * vx;
    const mx = (ax + bx + cx) / 3;
    const mz = (az + bz + cz) / 3;
    const rx = mx - centerX;
    const rz = mz - centerZ;
    sum += rx * nx + rz * nz;
  }
  if (sum === 0) return 0;
  return sum > 0 ? 1 : -1;
}

export async function afterRun_pushFace(partHistory) {
  const solids = (partHistory.scene?.children || []).filter(o => o?.type === 'SOLID');
  if (!solids.length) throw new Error('[pushFace] No solids created');

  const solid = solids[0];
  const cavityFace = `${CYLINDER_ID}_S`;
  const center = { x: BOX_SIZE / 2, z: BOX_SIZE / 2 };

  const baseline = measureRadialExtent(solid, cavityFace, center.x, center.z);
  const inwardTest = solid.clone();
  const control = measureRadialExtent(inwardTest, cavityFace, center.x, center.z);

  solid.pushFace(cavityFace, PUSH_DISTANCE);
  const pushedOut = measureRadialExtent(solid, cavityFace, center.x, center.z);

  inwardTest.pushFace(cavityFace, -PUSH_DISTANCE);
  const pushedIn = measureRadialExtent(inwardTest, cavityFace, center.x, center.z);

  const normalSign = estimateRadialNormalSign(solid, cavityFace, center.x, center.z);
  const tol = 1e-6;
  if (normalSign === 0) {
    const outDelta = pushedOut.avg - baseline.avg;
    const inDelta = pushedIn.avg - control.avg;
    const opposite = (outDelta > tol && inDelta < -tol) || (outDelta < -tol && inDelta > tol);
    if (!opposite) {
      throw new Error(`[pushFace] Expected opposite radial motion, got ${outDelta} and ${inDelta}`);
    }
  } else if (normalSign > 0) {
    if (!(pushedOut.avg > baseline.avg + tol && pushedOut.min > baseline.min + tol / 10)) {
      throw new Error(`[pushFace] Positive distance failed to move face outward (avg ${baseline.avg} → ${pushedOut.avg})`);
    }
    if (!(pushedIn.avg < control.avg - tol && pushedIn.max < control.max - tol / 10)) {
      throw new Error(`[pushFace] Negative distance failed to move face inward (avg ${control.avg} → ${pushedIn.avg})`);
    }
  } else {
    if (!(pushedOut.avg < baseline.avg - tol && pushedOut.max < baseline.max - tol / 10)) {
      throw new Error(`[pushFace] Positive distance failed to move face inward (avg ${baseline.avg} → ${pushedOut.avg})`);
    }
    if (!(pushedIn.avg > control.avg + tol && pushedIn.min > control.min + tol / 10)) {
      throw new Error(`[pushFace] Negative distance failed to move face outward (avg ${control.avg} → ${pushedIn.avg})`);
    }
  }
}
