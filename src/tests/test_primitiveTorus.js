

export async function test_primitiveTorus(partHistory) {
    const torus = await partHistory.newFeature("P.T");
    torus.inputParams.majorRadius = 20;
    torus.inputParams.tubeRadius = 5;
    torus.inputParams.resolution = 10;
    // arc with 90 degrees
    torus.inputParams.arc =  300;


    const torus2 = await partHistory.newFeature("P.T");
    torus2.inputParams.majorRadius = 5;
    torus2.inputParams.tubeRadius = 3;
    torus2.inputParams.resolution = 30;
    // arc with 90 degrees
    torus2.inputParams.arc =  360;

    
    return partHistory;
}
