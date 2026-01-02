export async function test_tube_closedLoop(partHistory) {
    const plane = await partHistory.newFeature("P");
    plane.inputParams.orientation = "XY";

    const sketch = await partHistory.newFeature("S");
    sketch.inputParams.sketchPlane = plane.inputParams.featureID;
    
    // Create a closed loop path (hexagon)
    const numSides = 6;
    const radius = 20;
    const points = [];
    const geometries = [];
    
    // Generate hexagon points
    for (let i = 0; i < numSides; i++) {
        const angle = (i / numSides) * 2 * Math.PI;
        points.push({
            id: i,
            x: Math.cos(angle) * radius,
            y: Math.sin(angle) * radius,
            fixed: false
        });
    }
    
    // Create line segments between consecutive points
    for (let i = 0; i < numSides; i++) {
        const nextI = (i + 1) % numSides;
        geometries.push({
            id: 200 + i,
            type: "line",
            points: [i, nextI],
            construction: false
        });
    }

    sketch.persistentData.sketch = {
        points: points,
        geometries: geometries,
        constraints: [
            { id: 0, type: "⏚", points: [0] }, // Fix the first point
        ],
    };

    const edgePrefix = `${sketch.inputParams.featureID}:`;

    // Create a solid tube with the closed loop path
    const solidTube = await partHistory.newFeature("TU");
    solidTube.inputParams.path = geometries.map(g => `${edgePrefix}G${g.id}`);
    solidTube.inputParams.radius = 3;
    solidTube.inputParams.innerRadius = 0;
    solidTube.inputParams.resolution = 24;

    // Create a hollow tube with the closed loop path
    const hollowTube = await partHistory.newFeature("TU");
    hollowTube.inputParams.path = geometries.map(g => `${edgePrefix}G${g.id}`);
    hollowTube.inputParams.radius = 4;
    hollowTube.inputParams.innerRadius = 1;
    hollowTube.inputParams.resolution = 24;
    // Offset the hollow tube vertically so we can see both
    hollowTube.inputParams.transform = {
        position: [0, 0, 10],
        rotation: [0, 0, 0],
        scale: [1, 1, 1]
    };

    return partHistory;
}
