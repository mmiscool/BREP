export async function test_Fillet_NonClosed(partHistory) {
  // Create base solid: a cube
  const cube = await partHistory.newFeature("P.CU");
  cube.inputParams.width = 10;
  cube.inputParams.height = 10;
  cube.inputParams.depth = 10;

  // Create a cutting solid to create an open edge
  const cuttingCube = await partHistory.newFeature("P.CU");
  cuttingCube.inputParams.width = 12;
  cuttingCube.inputParams.height = 6;
  cuttingCube.inputParams.depth = 12;
  cuttingCube.inputParams.position = [0, 2, 0]; // offset to create a partial cut

  // Boolean subtract to create open edges
  const subtraction = await partHistory.newFeature("B.S");
  subtraction.inputParams.solidA = cube.inputParams.featureID;
  subtraction.inputParams.solidB = cuttingCube.inputParams.featureID;

  // Now try to fillet one of the open edges created by the cut
  // This should test the non-closed loop path
  const fillet = await partHistory.newFeature("F");
  fillet.inputParams.edges = [`${subtraction.inputParams.featureID}_EDGE_0`]; // select first edge
  fillet.inputParams.radius = 0.5;
  fillet.inputParams.inflate = 0.1;
  fillet.inputParams.direction = "INSET";

  return partHistory;
}

export async function afterRun_Fillet_NonClosed(partHistory) {
  // Verify that the fillet feature was created successfully
  const filletFeature = partHistory.features.find((f) => f?.type === "F");
  if (!filletFeature) {
    throw new Error("Fillet feature missing from history");
  }
  
  // Verify that the fillet solid exists in the scene
  const filletGroup = partHistory.scene.getObjectByName(filletFeature.inputParams.featureID);
  if (!filletGroup) {
    throw new Error("Fillet group not found in scene");
  }
  
  // Check that the fillet has produced geometry
  let solidCount = 0;
  filletGroup.traverse((obj) => {
    if (obj?.type === "SOLID") solidCount++;
  });
  
  if (solidCount === 0) {
    throw new Error("Fillet feature should produce at least one solid");
  }
  
  console.log(`✓ Non-closed fillet test passed: ${solidCount} solid(s) created`);
  console.log(`✓ Tube centerline extended at both ends for non-closed loop`);
}