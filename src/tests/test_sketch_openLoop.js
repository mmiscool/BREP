export async function test_sketch_openLoop(partHistory) {
    const plane = await partHistory.newFeature("P");
    plane.inputParams.orientation = "XY";

    const sketch = await partHistory.newFeature("S");
    sketch.inputParams.sketchPlane = plane.inputParams.featureID;
    sketch.persistentData.sketch = {
        points: [
            { id: 0, x: 0, y: 0, fixed: true },
            { id: 1, x: 20, y: 0, fixed: false },
            { id: 2, x: 20, y: 15, fixed: false },
        ],
        geometries: [
            { id: 100, type: "line", points: [0, 1], construction: false },
            { id: 101, type: "line", points: [1, 2], construction: false },
        ],
        constraints: [
            { id: 0, type: "⏚", points: [0] },
        ],
    };
}

export async function afterRun_sketch_openLoop(partHistory) {
    const sketchFeature = partHistory.features.find((f) => f?.type === "S");
    if (!sketchFeature) {
        throw new Error("Sketch feature missing from history");
    }
    const sketchGroup = partHistory.scene.getObjectByName(sketchFeature.inputParams.featureID);
    if (!sketchGroup) {
        throw new Error("Sketch group not found in scene");
    }
    let faceCount = 0;
    let edgeCount = 0;
    sketchGroup.traverse((obj) => {
        if (!obj) return;
        if (obj.type === "FACE") faceCount++;
        else if (obj.type === "EDGE") edgeCount++;
    });
    if (faceCount !== 0) {
        throw new Error(`Open sketch generated ${faceCount} face(s)`);
    }
    if (edgeCount === 0) {
        throw new Error("Open sketch should expose at least one EDGE");
    }
}
