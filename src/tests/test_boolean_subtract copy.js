
export async function test_boolean_subtract(partHistory) {
    const cone = await partHistory.newFeature("P.CO");
    cone.inputParams.radiusTop = 3;
    cone.inputParams.radiusBottom = .5;
    cone.inputParams.height = 5.2;
    cone.inputParams.resolution = 20;



    const torus2 = await partHistory.newFeature("P.T");
    torus2.inputParams.majorRadius = 5;
    torus2.inputParams.tubeRadius = 3;
    torus2.inputParams.resolution = 30;
    // arc with 90 degrees
    torus2.inputParams.arc =  360;




    const booleanFeature = await partHistory.newFeature("B");
    booleanFeature.inputParams.toolSolid = cone.inputParams.featureID;
    booleanFeature.inputParams.targetSolid = torus2.inputParams.featureID;
    booleanFeature.inputParams.operation = "SUBTRACT";










    const cube = await partHistory.newFeature("P.CU");    
    cube.inputParams.sizeX = 2;
    cube.inputParams.sizeY = 2;
    cube.inputParams.sizeZ = 20;








    const booleanFeature2 = await partHistory.newFeature("B");
    booleanFeature2.inputParams.toolSolid = cone.inputParams.featureID;
    booleanFeature2.inputParams.targetSolid = booleanFeature.inputParams.featureID;
    booleanFeature2.inputParams.operation = "UNION";








    // subtract one cube from another
    // make 2 new cubes first
    const cube2 = await partHistory.newFeature("P.CU");
    cube2.inputParams.sizeX = 5;
    cube2.inputParams.sizeY = 10;
    cube2.inputParams.sizeZ = 15;

    const cube3 = await partHistory.newFeature("P.CU");
    cube3.inputParams.sizeX = 10;
    cube3.inputParams.sizeY = 6;
    cube3.inputParams.sizeZ = 7;

    const booleanFeature3 = await partHistory.newFeature("B");
    booleanFeature3.inputParams.toolSolid = cube2.inputParams.featureID;
    booleanFeature3.inputParams.targetSolid = cube3.inputParams.featureID;
    booleanFeature3.inputParams.operation = "SUBTRACT";

    //const artifacts = await partHistory.runHistory();
    return partHistory;
}
