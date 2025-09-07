// test-solver.mjs
// Run with: node test-solver.mjs  (Node 16+)
// This script exercises the refactored ConstraintSolver (no Web Worker).

import ConstraintSolver from "./ConstraintEngine.js";

// --- Minimal hooks (no UI in Node) ---
const hooks = {
  notifyUser: (message, type = "info") => {
    console.log(`[${type}] ${message}`);
  },
  updateCanvas: () => {
    // no-op in Node
  },
  getSelectionItems: () => {
    // not used in this headless test
    return [];
  },
};

// --- Define a simple sketch ---
// p0 is the grounded origin. We’ll constrain p1 horizontally from p0,
// and make the segment p1–p2 vertical with a fixed length (distance) of 40.
const sketch = {
  points: [
    { id: 0, x: 0,  y: 0, fixed: true },   // origin (grounded)
    { id: 1, x: 50, y: 10, fixed: false }, // arbitrary start
    { id: 2, x: 55, y: 60, fixed: false }, // arbitrary start
  ],
  geometries: [
    { id: 1, type: "line", points: [1, 2] }
  ],
  constraints: [
    { id: 0, type: "⏚", points: [0] },        // ground origin
    { id: 1, type: "│", points: [1, 2] },     // make line p1–p2 vertical (same x)
    { id: 2, type: "⟺", points: [1, 2], value: 40 }, // set length p1–p2 = 40
    { id: 3, type: "━", points: [0, 1] },     // make p1 horizontal with p0 (same y = 0)
  ]
};

// --- Instantiate and solve ---
const solver = new ConstraintSolver({
  sketch,
  ...hooks,
});

// You can pass a specific iteration count or "full"; here we’ll just use default loops:
const solved = solver.solveSketch();

// --- Inspect results ---
console.log("\n=== Solved Sketch ===");
console.log(JSON.stringify(solved, null, 2));

// --- Quick verification helpers ---
const byId = (pts, id) => pts.find(p => p.id === id);
const p0 = byId(solved.points, 0);
const p1 = byId(solved.points, 1);
const p2 = byId(solved.points, 2);

const sameX = (a, b, eps = 1e-4) => Math.abs(a.x - b.x) < eps;
const sameY = (a, b, eps = 1e-4) => Math.abs(a.y - b.y) < eps;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

console.log("\n=== Checks ===");
console.log("p1.y equals p0.y (horizontal):", sameY(p1, p0));
console.log("p1.x equals p2.x (vertical):", sameX(p1, p2));
console.log("distance(p1, p2) ≈ 40:", Math.abs(dist(p1, p2) - 40) < 1e-3);
