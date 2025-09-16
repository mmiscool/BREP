export async function test_ExtrudeFace(partHistory) {
    const cone = await partHistory.newFeature("P.CO");
    cone.inputParams.radiusTop = 3;
    cone.inputParams.radiusBottom = .5;
    cone.inputParams.height = 5.2;
    cone.inputParams.resolution = 20;


    const extrude = await partHistory.newFeature("E");
    extrude.inputParams.profile = `${cone.inputParams.featureID}_T`;
    extrude.inputParams.distance = 5;

    // perform a boolean operation between the 2 solids.
    const boolean = await partHistory.newFeature("B");
    boolean.inputParams.targetSolid = cone.inputParams.featureID;
    boolean.inputParams.toolSolid = extrude.inputParams.featureID;
    boolean.inputParams.operation = "UNION";

    return partHistory;
}
