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

  const vp = solid._vertProperties;
  const seen = new Set();
  const radii = [];
  for (const tri of face) {
    for (const idx of tri.indices || []) {
      const key = idx >>> 0;
      if (seen.has(key)) continue;
      seen.add(key);
      const base = key * 3;
      const x = vp[base + 0];
      const z = vp[base + 2];
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

  const tol = 1e-6;
  if (!(pushedOut.avg > baseline.avg + tol && pushedOut.min > baseline.min + tol / 10)) {
    throw new Error(`[pushFace] Positive distance failed to move face outward (avg ${baseline.avg} → ${pushedOut.avg})`);
  }
  if (!(pushedIn.avg < control.avg - tol && pushedIn.max < control.max - tol / 10)) {
    throw new Error(`[pushFace] Negative distance failed to move face inward (avg ${control.avg} → ${pushedIn.avg})`);
  }
}
