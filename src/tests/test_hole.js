const CUBE_SIZE = 12;
const HOLE_DIAMETER = 2;
const CSK_DIAMETER = 6;
const CSK_ANGLE = 90;
const CSK_DEPTH = 6;
const CBORE_DIAMETER = 6;
const CBORE_DEPTH = 3;
const CBORE_TOTAL_DEPTH = 7;
const EPS = 1e-6;

function buildSketchWithPoints(sketchFeature, points) {
  const pointList = [
    { id: 0, x: 0, y: 0, fixed: true },
    ...points.map((p, idx) => ({
      id: idx + 1,
      x: p[0],
      y: p[1],
      fixed: false,
    })),
  ];
  sketchFeature.persistentData.sketch = {
    points: pointList,
    geometries: [],
    constraints: [{ id: 0, type: "⏚", points: [0] }],
  };
}

function findHoleFeature(partHistory) {
  return partHistory.features.find((f) => f?.type === "H") || null;
}

function countHoleMetadata(solids) {
  let count = 0;
  for (const solid of solids) {
    const meta = solid?._faceMetadata;
    if (!(meta instanceof Map)) continue;
    for (const value of meta.values()) {
      if (value?.hole) count++;
    }
  }
  return count;
}

function getPrimarySolid(partHistory) {
  const solids = (partHistory.scene?.children || []).filter((o) => o?.type === "SOLID");
  return solids[0] || null;
}

function expectApprox(value, expected, label) {
  if (!Number.isFinite(value) || Math.abs(value - expected) > EPS) {
    throw new Error(`${label} expected ${expected}, got ${value}`);
  }
}

export async function test_hole_through(partHistory) {
  const cube = await partHistory.newFeature("P.CU");
  cube.inputParams.sizeX = CUBE_SIZE;
  cube.inputParams.sizeY = CUBE_SIZE;
  cube.inputParams.sizeZ = CUBE_SIZE;

  const plane = await partHistory.newFeature("P");
  plane.inputParams.orientation = "XY";

  const sketch = await partHistory.newFeature("S");
  sketch.inputParams.sketchPlane = plane.inputParams.featureID;
  buildSketchWithPoints(sketch, [[CUBE_SIZE * 0.5, CUBE_SIZE * 0.5]]);

  const hole = await partHistory.newFeature("H");
  hole.inputParams.face = sketch.inputParams.featureID;
  hole.inputParams.holeType = "SIMPLE";
  hole.inputParams.diameter = HOLE_DIAMETER;
  hole.inputParams.throughAll = true;
  hole.inputParams.boolean = {
    targets: [cube.inputParams.featureID],
    operation: "SUBTRACT",
  };

  return partHistory;
}

export async function afterRun_hole_through(partHistory) {
  const holeFeature = findHoleFeature(partHistory);
  if (!holeFeature) throw new Error("[hole_through] Hole feature missing");
  const holes = holeFeature.persistentData?.holes || [];
  if (!holes.length) throw new Error("[hole_through] No hole records");
  if (!holes[0]?.throughAll) throw new Error("[hole_through] Expected through-all hole record");
  if (String(holes[0]?.type || "").toUpperCase() !== "SIMPLE") {
    throw new Error(`[hole_through] Expected SIMPLE hole, got ${holes[0]?.type}`);
  }

  const solid = getPrimarySolid(partHistory);
  if (!solid) throw new Error("[hole_through] No solids created");
  const faceCount = solid._faceNameToID?.size || 0;
  if (faceCount <= 6) throw new Error("[hole_through] Hole did not add faces");

  const holeMetaCount = countHoleMetadata([solid]);
  if (holeMetaCount === 0) throw new Error("[hole_through] No hole face metadata found");
}

export async function test_hole_thread_symbolic(partHistory) {
  const cube = await partHistory.newFeature("P.CU");
  cube.inputParams.sizeX = CUBE_SIZE;
  cube.inputParams.sizeY = CUBE_SIZE;
  cube.inputParams.sizeZ = CUBE_SIZE;

  const plane = await partHistory.newFeature("P");
  plane.inputParams.orientation = "XY";

  const sketch = await partHistory.newFeature("S");
  sketch.inputParams.sketchPlane = plane.inputParams.featureID;
  buildSketchWithPoints(sketch, [[CUBE_SIZE * 0.35, CUBE_SIZE * 0.35]]);

  const hole = await partHistory.newFeature("H");
  hole.inputParams.face = sketch.inputParams.featureID;
  hole.inputParams.holeType = "THREADED";
  hole.inputParams.depth = 6;
  hole.inputParams.throughAll = false;
  hole.inputParams.threadStandard = "ISO_METRIC";
  hole.inputParams.threadDesignation = "M6x1";
  hole.inputParams.threadMode = "SYMBOLIC";
  hole.inputParams.boolean = {
    targets: [cube.inputParams.featureID],
    operation: "SUBTRACT",
  };

  return partHistory;
}

export async function afterRun_hole_thread_symbolic(partHistory) {
  const holeFeature = findHoleFeature(partHistory);
  if (!holeFeature) throw new Error("[hole_thread_symbolic] Hole feature missing");
  const holes = holeFeature.persistentData?.holes || [];
  if (!holes.length) throw new Error("[hole_thread_symbolic] No hole records");
  const record = holes[0];
  if (String(record?.type || "").toUpperCase() !== "THREADED") {
    throw new Error(`[hole_thread_symbolic] Expected THREADED hole, got ${record?.type}`);
  }
  if (!record?.thread || String(record.thread.mode || "").toUpperCase() !== "SYMBOLIC") {
    throw new Error("[hole_thread_symbolic] Expected symbolic thread metadata");
  }
}

export async function test_hole_thread_modeled(partHistory) {
  const cube = await partHistory.newFeature("P.CU");
  cube.inputParams.sizeX = CUBE_SIZE;
  cube.inputParams.sizeY = CUBE_SIZE;
  cube.inputParams.sizeZ = CUBE_SIZE;

  const plane = await partHistory.newFeature("P");
  plane.inputParams.orientation = "XY";

  const sketch = await partHistory.newFeature("S");
  sketch.inputParams.sketchPlane = plane.inputParams.featureID;
  buildSketchWithPoints(sketch, [[CUBE_SIZE * 0.65, CUBE_SIZE * 0.35]]);

  const hole = await partHistory.newFeature("H");
  hole.inputParams.face = sketch.inputParams.featureID;
  hole.inputParams.holeType = "THREADED";
  hole.inputParams.depth = 4;
  hole.inputParams.throughAll = false;
  hole.inputParams.threadStandard = "ISO_METRIC";
  hole.inputParams.threadDesignation = "M6x1";
  hole.inputParams.threadMode = "MODELED";
  hole.inputParams.boolean = {
    targets: [cube.inputParams.featureID],
    operation: "SUBTRACT",
  };

  return partHistory;
}

export async function afterRun_hole_thread_modeled(partHistory) {
  const holeFeature = findHoleFeature(partHistory);
  if (!holeFeature) throw new Error("[hole_thread_modeled] Hole feature missing");
  const holes = holeFeature.persistentData?.holes || [];
  if (!holes.length) throw new Error("[hole_thread_modeled] No hole records");
  const record = holes[0];
  if (String(record?.type || "").toUpperCase() !== "THREADED") {
    throw new Error(`[hole_thread_modeled] Expected THREADED hole, got ${record?.type}`);
  }
  if (!record?.thread || String(record.thread.mode || "").toUpperCase() !== "MODELED") {
    throw new Error("[hole_thread_modeled] Expected modeled thread metadata");
  }
}

export async function test_hole_countersink(partHistory) {
  const cube = await partHistory.newFeature("P.CU");
  cube.inputParams.sizeX = CUBE_SIZE;
  cube.inputParams.sizeY = CUBE_SIZE;
  cube.inputParams.sizeZ = CUBE_SIZE;

  const plane = await partHistory.newFeature("P");
  plane.inputParams.orientation = "XY";

  const sketch = await partHistory.newFeature("S");
  sketch.inputParams.sketchPlane = plane.inputParams.featureID;
  buildSketchWithPoints(sketch, [[CUBE_SIZE * 0.25, CUBE_SIZE * 0.65]]);

  const hole = await partHistory.newFeature("H");
  hole.inputParams.face = sketch.inputParams.featureID;
  hole.inputParams.holeType = "COUNTERSINK";
  hole.inputParams.diameter = HOLE_DIAMETER;
  hole.inputParams.depth = CSK_DEPTH;
  hole.inputParams.throughAll = false;
  hole.inputParams.countersinkDiameter = CSK_DIAMETER;
  hole.inputParams.countersinkAngle = CSK_ANGLE;
  hole.inputParams.boolean = {
    targets: [cube.inputParams.featureID],
    operation: "SUBTRACT",
  };

  return partHistory;
}

export async function afterRun_hole_countersink(partHistory) {
  const holeFeature = findHoleFeature(partHistory);
  if (!holeFeature) throw new Error("[hole_countersink] Hole feature missing");
  const holes = holeFeature.persistentData?.holes || [];
  if (!holes.length) throw new Error("[hole_countersink] No hole records");
  const record = holes[0];
  if (String(record?.type || "").toUpperCase() !== "COUNTERSINK") {
    throw new Error(`[hole_countersink] Expected COUNTERSINK hole, got ${record?.type}`);
  }
  if (record?.throughAll) throw new Error("[hole_countersink] Expected non-through hole");
  if (!(record?.countersinkHeight > 0)) throw new Error("[hole_countersink] Expected countersink height > 0");
  expectApprox(record?.countersinkDiameter, CSK_DIAMETER, "[hole_countersink] countersink diameter");
  expectApprox(record?.countersinkAngle, CSK_ANGLE, "[hole_countersink] countersink angle");

  const solid = getPrimarySolid(partHistory);
  if (!solid) throw new Error("[hole_countersink] No solids created");
  const holeMetaCount = countHoleMetadata([solid]);
  if (holeMetaCount === 0) throw new Error("[hole_countersink] No hole face metadata found");
}

export async function test_hole_counterbore(partHistory) {
  const cube = await partHistory.newFeature("P.CU");
  cube.inputParams.sizeX = CUBE_SIZE;
  cube.inputParams.sizeY = CUBE_SIZE;
  cube.inputParams.sizeZ = CUBE_SIZE;

  const plane = await partHistory.newFeature("P");
  plane.inputParams.orientation = "XY";

  const sketch = await partHistory.newFeature("S");
  sketch.inputParams.sketchPlane = plane.inputParams.featureID;
  buildSketchWithPoints(sketch, [[CUBE_SIZE * 0.75, CUBE_SIZE * 0.65]]);

  const hole = await partHistory.newFeature("H");
  hole.inputParams.face = sketch.inputParams.featureID;
  hole.inputParams.holeType = "COUNTERBORE";
  hole.inputParams.diameter = HOLE_DIAMETER;
  hole.inputParams.depth = CBORE_TOTAL_DEPTH;
  hole.inputParams.throughAll = false;
  hole.inputParams.counterboreDiameter = CBORE_DIAMETER;
  hole.inputParams.counterboreDepth = CBORE_DEPTH;
  hole.inputParams.boolean = {
    targets: [cube.inputParams.featureID],
    operation: "SUBTRACT",
  };

  return partHistory;
}

export async function afterRun_hole_counterbore(partHistory) {
  const holeFeature = findHoleFeature(partHistory);
  if (!holeFeature) throw new Error("[hole_counterbore] Hole feature missing");
  const holes = holeFeature.persistentData?.holes || [];
  if (!holes.length) throw new Error("[hole_counterbore] No hole records");
  const record = holes[0];
  if (String(record?.type || "").toUpperCase() !== "COUNTERBORE") {
    throw new Error(`[hole_counterbore] Expected COUNTERBORE hole, got ${record?.type}`);
  }
  if (record?.throughAll) throw new Error("[hole_counterbore] Expected non-through hole");
  expectApprox(record?.counterboreDiameter, CBORE_DIAMETER, "[hole_counterbore] counterbore diameter");
  expectApprox(record?.counterboreDepth, CBORE_DEPTH, "[hole_counterbore] counterbore depth");
  expectApprox(record?.straightDepth, CBORE_TOTAL_DEPTH - CBORE_DEPTH, "[hole_counterbore] straight depth");

  const solid = getPrimarySolid(partHistory);
  if (!solid) throw new Error("[hole_counterbore] No solids created");
  const holeMetaCount = countHoleMetadata([solid]);
  if (holeMetaCount === 0) throw new Error("[hole_counterbore] No hole face metadata found");
}
