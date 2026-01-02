export async function test_SweepFace(partHistory) {
    const cone = await partHistory.newFeature("P.CO");
    cone.inputParams.radiusTop = 3;
    cone.inputParams.radiusBottom = .5;
    cone.inputParams.height = 5.2;
    cone.inputParams.resolution = 20;

    // Build a simple sketch with a straight path edge of length 5 along +Z.
    // We place the sketch on an XZ plane so the line from (0,0)→(0,5) maps to +Z in world.
    const plane = await partHistory.newFeature("P");
    plane.inputParams.orientation = "YZ";

    const sketch = await partHistory.newFeature("S");
    sketch.inputParams.sketchPlane = plane.inputParams.featureID;
    // Define a minimal sketch: one path line (id:100) and a tiny closed loop so edges get added to the scene.
    sketch.persistentData.sketch = {
        points: [
            { id: 0, x: 0, y: 0, fixed: true },   // ground
            { id: 1, x: 8, y: 20, fixed: false },  // path end (+Z since XZ plane)
            // tiny square to ensure a profile face is created (so edges are added to scene)
            { id: 10, x: -0.5, y: -0.5, fixed: false },
            { id: 11, x:  0.5, y: -0.5, fixed: false },
            { id: 12, x:  0.5, y:  0.5, fixed: false },
            { id: 13, x: -0.5, y:  0.5, fixed: false },
        ],
        geometries: [
            // Path edge geometry (name will be G100)
            { id: 100, type: "line", points: [0, 1], construction: false },
            // Closed loop (small square) so the sketch emits edges and a face group
            { id: 200, type: "line", points: [10, 11], construction: false },
            { id: 201, type: "line", points: [11, 12], construction: false },
            { id: 202, type: "line", points: [12, 13], construction: false },
            { id: 203, type: "line", points: [13, 10], construction: false },
        ],
        constraints: [
            { id: 0, type: "⏚", points: [0] }, // ground point 0
        ],
    };

    // Create the path-based Sweep from the cone's top face, following the sketch edge G100.
    const sweep = await partHistory.newFeature("SW");
    sweep.inputParams.profile = `${cone.inputParams.featureID}_T`;
    sweep.inputParams.path = [`${sketch.inputParams.featureID}:G100`]; // resolve to the sketch edge created above
    sweep.inputParams.orientationMode = "translate"; // default, but make explicit

    // perform a boolean operation between the 2 solids.
    const boolean = await partHistory.newFeature("B");
    boolean.inputParams.targetSolid = cone.inputParams.featureID;
    boolean.inputParams.boolean = {
        targets: [sweep.inputParams.featureID],
        operation: "UNION",
    };

    return partHistory;
}
