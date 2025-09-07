export async function test_primitivePyramid(partHistory) {
    const pyramid = await partHistory.newFeature("P.PY");
    pyramid.inputParams.baseSideLength = 5;
    pyramid.inputParams.height = 8;
    pyramid.inputParams.sides = 4;

    return partHistory;
}

