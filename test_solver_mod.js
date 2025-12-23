
import { ConstraintEngine } from "./src/features/sketch/sketchSolver2D/ConstraintEngine.js";

async function testMidpoint() {
    console.log("--- Test 1: All Movable ---");
    // A(0,0), B(10,0). Midpoint should be (5,0). Current C(5, 10).
    const sketch1 = {
        points: [
            { id: 1, x: 0, y: 0, fixed: false },
            { id: 2, x: 10, y: 0, fixed: false },
            { id: 3, x: 5, y: 10, fixed: false }
        ],
        constraints: [
            { id: 1, type: "⋯", points: [1, 2, 3] }
        ]
    };

    // We expect them to meet somewhere.
    // Error is (0, 10). C moves down, A/B move up.
    // C should move by 2/3 of error * 2?? No.
    // Our formula: C += alpha * 2. A,B += alpha * -1.
    // alpha = -R/6.
    // R = 2C - A - B.
    // X: 2*5 - 0 - 10 = 0. No X error.
    // Y: 2*10 - 0 - 0 = 20.
    // alphaY = -20 / 6 = -3.333
    // C.y += -3.333 * 2 = -6.666 -> 3.333
    // A.y, B.y += -3.333 * -1 = 3.333 -> 3.333
    // Check: (3.33 + 3.33)/2 = 3.33. Perfectly matches C.

    const engine1 = new ConstraintEngine(JSON.stringify(sketch1));
    const result1 = engine1.solve(100);
    const p1 = result1.points;
    console.log(`A: (${p1[0].x.toFixed(3)}, ${p1[0].y.toFixed(3)})`);
    console.log(`B: (${p1[1].x.toFixed(3)}, ${p1[1].y.toFixed(3)})`);
    console.log(`C: (${p1[2].x.toFixed(3)}, ${p1[2].y.toFixed(3)})`);

    // Validate
    const midX = (p1[0].x + p1[1].x) / 2;
    const midY = (p1[0].y + p1[1].y) / 2;
    console.log(`Calculated Mid: (${midX.toFixed(3)}, ${midY.toFixed(3)})`);
    console.log(`Point C:      (${p1[2].x.toFixed(3)}, ${p1[2].y.toFixed(3)})`);

    if (Math.abs(midX - p1[2].x) < 0.001 && Math.abs(midY - p1[2].y) < 0.001) {
        console.log("PASS");
    } else {
        console.log("FAIL");
    }

    console.log("\n--- Test 2: A Fixed ---");
    // A(0,0) Fixed. B(10,0). C(5, 10).
    // Target A is fixed 0.
    // Error Y = 20.
    // Denom = 1 + 4 = 5. (B movable, C movable).
    // alphaY = -20 / 5 = -4.
    // C.y += -4 * 2 = -8 -> 2.
    // B.y += -4 * -1 = 4 -> 4.
    // A.y fixed at 0.
    // Check: (0 + 4) / 2 = 2. Matches C(2).
    const sketch2 = {
        points: [
            { id: 1, x: 0, y: 0, fixed: true },
            { id: 2, x: 10, y: 0, fixed: false },
            { id: 3, x: 5, y: 10, fixed: false }
        ],
        constraints: [
            { id: 1, type: "⋯", points: [1, 2, 3] },
            { id: 2, type: "⏚", points: [1] } // Ensure engine treats it as fixed if needed, though 'fixed' prop should handle it
        ]
    };

    const engine2 = new ConstraintEngine(JSON.stringify(sketch2));
    const result2 = engine2.solve(100);
    const p2 = result2.points;
    console.log(`A: (${p2[0].x.toFixed(3)}, ${p2[0].y.toFixed(3)}) Fixed: ${p2[0].fixed}`);
    console.log(`B: (${p2[1].x.toFixed(3)}, ${p2[1].y.toFixed(3)})`);
    console.log(`C: (${p2[2].x.toFixed(3)}, ${p2[2].y.toFixed(3)})`);

    const midX2 = (p2[0].x + p2[1].x) / 2;
    const midY2 = (p2[0].y + p2[1].y) / 2;

    if (Math.abs(midX2 - p2[2].x) < 0.001 && Math.abs(midY2 - p2[2].y) < 0.001 && p2[0].y === 0) {
        console.log("PASS");
    } else {
        console.log("FAIL");
    }

    console.log("\n--- Test 3: C Fixed ---");
    // A(0,0), B(10,0). C(5, 10) Fixed.
    // Midpoint must move to (5,10).
    // A and B should move to satisfy (A+B)/2 = (5,10).
    // A+B = (10, 20).
    // Currently A+B = (10, 0). Error in sum is (0, 20).
    // Distribute to A and B.
    const sketch3 = {
        points: [
            { id: 1, x: 0, y: 0, fixed: false },
            { id: 2, x: 10, y: 0, fixed: false },
            { id: 3, x: 5, y: 10, fixed: true }
        ],
        constraints: [
            { id: 1, type: "⋯", points: [1, 2, 3] },
            { id: 2, type: "⏚", points: [3] }
        ]
    };

    const engine3 = new ConstraintEngine(JSON.stringify(sketch3));
    const result3 = engine3.solve(100);
    const p3 = result3.points;
    console.log(`A: (${p3[0].x.toFixed(3)}, ${p3[0].y.toFixed(3)})`);
    console.log(`B: (${p3[1].x.toFixed(3)}, ${p3[1].y.toFixed(3)})`);
    console.log(`C: (${p3[2].x.toFixed(3)}, ${p3[2].y.toFixed(3)}) Fixed: ${p3[2].fixed}`);

    const midX3 = (p3[0].x + p3[1].x) / 2;
    const midY3 = (p3[0].y + p3[1].y) / 2;

    if (Math.abs(midX3 - p3[2].x) < 0.001 && Math.abs(midY3 - p3[2].y) < 0.001 && Math.abs(p3[2].y - 10) < 0.001) {
        console.log("PASS");
    } else {
        console.log("FAIL");
    }
}

testMidpoint();
