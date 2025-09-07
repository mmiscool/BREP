export async function test_plane(partHistory) {
    await partHistory.newFeature("PLANE");
    return partHistory;
}
