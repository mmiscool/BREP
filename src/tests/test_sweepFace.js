export async function test_SweepFace(partHistory) {
    const cone = await partHistory.newFeature("P.CO");
    cone.inputParams.radiusTop = 3;
    cone.inputParams.radiusBottom = .5;
    cone.inputParams.height = 5.2;
    cone.inputParams.resolution = 20;


    const sweep = await partHistory.newFeature("SW");
    sweep.inputParams.profile = `${cone.inputParams.featureID}_T`;
    sweep.inputParams.distance = 5;

    // perform a boolean operation between the 2 solids.
    const boolean = await partHistory.newFeature("B");
    boolean.inputParams.targetSolid = cone.inputParams.featureID;
    boolean.inputParams.toolSolid = sweep.inputParams.featureID;
    boolean.inputParams.operation = "UNION";

    return partHistory;
}
