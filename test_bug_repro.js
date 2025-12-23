
import { ConstraintEngine } from "./src/features/sketch/sketchSolver2D/ConstraintEngine.js";

async function testPointOnLine() {
    console.log("--- Test: Point on Line Collapse Check ---");
    // Scenario:
    // Line L(p1, p2).
    // Arc defined by Center(p3), Start(p1), End(p2). (Assuming coincident or reused IDs).
    // Note: Arc def usually center, start, end.
    // If we have Line(p1, p2) and Arc(p3, p1, p2), then p1 and p2 are shared.
    // Constraint: PointOnLine(p3, p1, p2). Center on Chord.
    // Expected: Semi-circle. p3 should lie on the line connecting p1, p2.
    // If it collapses, maybe all points go to 0,0 or similar.

    // Initial State:
    // p1 = (-5, 0)
    // p2 = (5, 0)
    // p3 = (0, 5)  (Standard semi-circle config)
    // Line length 10. Radius 5.
    // PointOnLine constraint should already be satisfied actually (0,5 projecting to y=0? No wait).
    // Line is on Y=0. C(0,5). PointOnLine should force C.y -> 0.
    // If C goes to (0,0), then Dist(C, p1) = 5. Dist(C, p2) = 5.
    // Arc Valid.
    // If it collapses to single point, then p1, p2, p3 all become same.

    const sketch = {
        points: [
            { id: 1, x: -5, y: 0, fixed: false },
            { id: 2, x: 5, y: 0, fixed: false },
            { id: 3, x: 0, y: 5, fixed: false }
        ],
        constraints: [
            // Implied Arc constraints (Equal Distance C-p1 and C-p2)
            // We simulate arc structure manually here or trust the engine if we passed geometry.
            // Let's rely on manual constraints to isolate the 'PointOnLine' behavior vs Arc behavior.
            { id: 10, type: "⇌", points: [3, 1, 3, 2] }, // C-Start == C-End (Radius)

            // The problematic constraint: Point C(3) on Line p1-p2
            { id: 1, type: "⏛", points: [1, 2, 3] }
        ]
    };

    // Add logic to print intermediate if possible, or just result.
    const engine = new ConstraintEngine(JSON.stringify(sketch));
    console.log("Initial:", JSON.stringify(sketch.points));

    // Solve
    const result = engine.solve(100);
    const p = result.points;

    console.log("Result:");
    p.forEach(pt => console.log(`ID ${pt.id}: (${pt.x.toFixed(3)}, ${pt.y.toFixed(3)})`));

    // Check for collapse
    const dist12 = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y); // Note indices 0,1,2 map to IDs 1,2,3
    console.log(`Distance p1-p2: ${dist12.toFixed(3)}`);

    if (dist12 < 0.1) {
        console.log("COLLAPSE DETECTED");
    } else {
        console.log("NO COLLAPSE");
    }
}

testPointOnLine();
