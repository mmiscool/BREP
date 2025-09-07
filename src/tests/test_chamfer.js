export async function test_Chamfer(partHistory) {
  // Base solid: cube to test planar chamfer along a face’s boundary
  const cube = await partHistory.newFeature("P.CU");
  cube.inputParams.sizeX = 20;
  cube.inputParams.sizeY = 20;
  cube.inputParams.sizeZ = 20;

  // Chamfer all edges of the +Z face (PZ)
  const chamfer = await partHistory.newFeature("CHAMFER");
  chamfer.inputParams.edges = [`${cube.inputParams.featureID}_PZ`]; // select face to include its edges
  chamfer.inputParams.distance = 3.0;
  chamfer.inputParams.inflate = 0.0005; // nudge to prevent tiny remainders
  chamfer.inputParams.direction = "INSET"; // subtract from the base body

  return partHistory;
}

