export async function test_primitiveCylinder(partHistory) {
    const cylinder = await partHistory.newFeature("P.CY");
    cylinder.inputParams.radius = 1;
    cylinder.inputParams.height = 5;
    cylinder.inputParams.resolution = 30;

    return partHistory;
}
