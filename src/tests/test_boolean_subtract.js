
export async function test_boolean_subtract(partHistory) {
    const cone = await partHistory.newFeature("P.CO");
    cone.inputParams.radiusTop = 3;
    cone.inputParams.radiusBottom = .5;
    cone.inputParams.height = 5.2;
    cone.inputParams.resolution = 20;


    const cube = await partHistory.newFeature("P.CU");    
    cube.inputParams.sizeX = 2;
    cube.inputParams.sizeY = 2;
    cube.inputParams.sizeZ = 20;


    const booleanFeature2 = await partHistory.newFeature("B");
    booleanFeature2.inputParams.targetSolid = cube.inputParams.featureID;
    booleanFeature2.inputParams.boolean = {
        targets: [cone.inputParams.featureID],
        operation: "SUBTRACT",
    };




    return partHistory;
}
