
export async function test_primitiveSphere(partHistory) {
    const sphere = await partHistory.newFeature("P.S");
    sphere.inputParams.radius = 5;
    sphere.inputParams.resolution =10;

    return partHistory;
}









