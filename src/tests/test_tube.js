export async function test_tube(partHistory) {
    const plane = await partHistory.newFeature("P");
    plane.inputParams.orientation = "XY";

    const sketch = await partHistory.newFeature("S");
    sketch.inputParams.sketchPlane = plane.inputParams.featureID;
    sketch.persistentData.sketch = {
        points: [
            { id: 0, x: 0, y: 0, fixed: true },
            { id: 1, x: 0, y: 40, fixed: false },
            { id: 2, x: 25, y: 40, fixed: false },
            { id: 10, x: -2, y: -2, fixed: false },
            { id: 11, x: 2, y: -2, fixed: false },
            { id: 12, x: 2, y: 2, fixed: false },
            { id: 13, x: -2, y: 2, fixed: false },
        ],
        geometries: [
            { id: 200, type: "line", points: [0, 1], construction: false },
            { id: 201, type: "line", points: [1, 2], construction: false },
            { id: 300, type: "line", points: [10, 11], construction: false },
            { id: 301, type: "line", points: [11, 12], construction: false },
            { id: 302, type: "line", points: [12, 13], construction: false },
            { id: 303, type: "line", points: [13, 10], construction: false },
        ],
        constraints: [
            { id: 0, type: "⏚", points: [0] },
        ],
    };

    const edgePrefix = `${sketch.inputParams.featureID}:`;

    const solidTube = await partHistory.newFeature("TU");
    solidTube.inputParams.path = [`${edgePrefix}G200`, `${edgePrefix}G201`];
    solidTube.inputParams.radius = 4;
    solidTube.inputParams.innerRadius = 0;
    solidTube.inputParams.resolution = 32;

    const hollowTube = await partHistory.newFeature("TU");
    hollowTube.inputParams.path = [`${edgePrefix}G200`, `${edgePrefix}G201`];
    hollowTube.inputParams.radius = 5;
    hollowTube.inputParams.innerRadius = 2;
    hollowTube.inputParams.resolution = 48;

    return partHistory;
}
