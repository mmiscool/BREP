export async function test_mirror(partHistory) {
    // Create a base cube to mirror
    const cube = await partHistory.newFeature("P.CU");
    cube.inputParams.sizeX = 4;
    cube.inputParams.sizeY = 3;
    cube.inputParams.sizeZ = 2;

    // Mirror the cube across one of its own faces (PX face plane)
    const mirror = await partHistory.newFeature("M");
    mirror.inputParams.solids = [cube.inputParams.featureID];
    mirror.inputParams.mirrorPlane = `${cube.inputParams.featureID}_PX`;
    mirror.inputParams.offsetDistance = 0; // on-face mirror

    return partHistory;
}

