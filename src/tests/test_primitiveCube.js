export async function test_primitiveCube(partHistory) {
    const cube = await partHistory.newFeature("P.CU");
    cube.inputParams.sizeX = 5;
    cube.inputParams.sizeY = 10;
    cube.inputParams.sizeZ = 15;
    return partHistory;
}
