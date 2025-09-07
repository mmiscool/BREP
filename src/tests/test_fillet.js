export async function test_Fillet(partHistory) {
  // Base solid: cylinder to provide a clean closed-loop edge at the top cap
  const cyl = await partHistory.newFeature("P.CY");
  cyl.inputParams.radius = 5;
  cyl.inputParams.height = 10;
  cyl.inputParams.resolution = 48;

  // Apply a fillet along all edges of the top face (closed ring between _T and _S)
  const fillet = await partHistory.newFeature("F");
  fillet.inputParams.edges = [`${cyl.inputParams.featureID}_T`]; // select face to grab its edges
  fillet.inputParams.radius = 1.0;
  fillet.inputParams.inflate = 0.1; // tiny inflation to avoid sliver leftovers
  fillet.inputParams.direction = "INSET"; // subtract from the base body

  return partHistory;
}

