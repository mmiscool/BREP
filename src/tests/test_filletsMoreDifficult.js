export async function test_filletsMoreDifficult(partHistory) {
  // Recreate the scenario from the provided saved state

  // 1) Cone
  const cone = await partHistory.newFeature("P.CO");
  cone.inputParams.radiusTop = 3;
  cone.inputParams.radiusBottom = 0.5;
  cone.inputParams.height = 5.2;
  cone.inputParams.resolution = "128";
  // No boolean on cone (defaults to NONE)

  // 2) Cube unioned with cone
  const cube = await partHistory.newFeature("P.CU");
  cube.inputParams.sizeX = 5;
  cube.inputParams.sizeY = 2;
  cube.inputParams.sizeZ = 10;
  cube.inputParams.boolean.targets = [cone.inputParams.featureID];
  cube.inputParams.boolean.operation = 'UNION';

  // 3) Fillet across intersection edge between cone side and cube +Y face
  const fillet1 = await partHistory.newFeature("F");
  fillet1.inputParams.edges = [
    `${cone.inputParams.featureID}_S|${cube.inputParams.featureID}_PY[0]`,
  ];
  fillet1.inputParams.radius = 1;
  fillet1.inputParams.inflate = 0.1;
  fillet1.inputParams.direction = "OUTSET";
  fillet1.inputParams.debug = false;

  // 4) Fillet around top ring of the cone
  const fillet2 = await partHistory.newFeature("F");
  fillet2.inputParams.edges = [
    `${cone.inputParams.featureID}_S|${cone.inputParams.featureID}_T[0]`,
  ];
  fillet2.inputParams.radius = 1;
  fillet2.inputParams.inflate = 0.1;
  fillet2.inputParams.direction = "INSET";
  fillet2.inputParams.debug = false;

  return partHistory;
}

// Alias with the requested test name spelling for the runner/export folder
export async function test_fillets_more_dificult(partHistory) {
  return test_filletsMoreDifficult(partHistory);
}
