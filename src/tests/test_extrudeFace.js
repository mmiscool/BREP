export async function test_ExtrudeFace(partHistory) {
    const cone = await partHistory.newFeature("P.CO");
    cone.inputParams.radiusTop = 3;
    cone.inputParams.radiusBottom = .5;
    cone.inputParams.height = 5.2;
    cone.inputParams.resolution = 20;


    const extrude = await partHistory.newFeature("E");
    extrude.inputParams.profile = `${cone.inputParams.featureID}_T`;
    // Use back distance instead of negative distance
    extrude.inputParams.distance = 0;
    extrude.inputParams.distanceBack = 5;

    // Use internal boolean on the extrude feature to union with the cone
    extrude.inputParams.boolean = {
        targets: [cone.inputParams.featureID],
        operation: "UNION",
    };

    // No separate boolean feature; handled internally by the extrude

    return partHistory;
}
