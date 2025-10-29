// Utility vector ops (immutable)
const v = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  len: (a) => Math.hypot(a.x, a.y, a.z),
  norm: (a) => {
    const L = Math.hypot(a.x, a.y, a.z);
    if (L === 0) return { x: 0, y: 0, z: 0 };
    return { x: a.x / L, y: a.y / L, z: a.z / L };
  }
};

// Project a 3D point to a 2D plane basis (origin O, basis e1,e2)
function project2D(P, O, e1, e2) {
  const OP = v.sub(P, O);
  return { x: v.dot(OP, e1), y: v.dot(OP, e2) };
}

// Lift a 2D point to 3D using plane basis (origin O, basis e1,e2)
function lift3D(p2, O, e1, e2) {
  return v.add(O, v.add(v.scale(e1, p2.x), v.scale(e2, p2.y)));
}

// 2D helpers
const v2 = {
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  len: (a) => Math.hypot(a.x, a.y),
  norm: (a) => {
    const L = Math.hypot(a.x, a.y);
    if (L === 0) return { x: 0, y: 0 };
    return { x: a.x / L, y: a.y / L };
  },
  // rotate +90°: (x,y) -> (-y, x)
  leftNormal: (d) => ({ x: -d.y, y: d.x })
};

// Intersect two 2D lines given in Hesse form: (n · x = s)
// Returns a 2D point. Throws if lines are (near) parallel.
function intersectHesse2D(n1, s1, n2, s2, eps = 1e-12) {
  // Solve:
  // [n1.x n1.y] [x] = [s1]
  // [n2.x n2.y] [y]   [s2]
  const det = n1.x * n2.y - n1.y * n2.x;
  if (Math.abs(det) < eps) {
    throw new Error("Offset lines are nearly parallel; check offsets/winding.");
  }
  const x = (s1 * n2.y - n1.y * s2) / det;
  const y = (-s1 * n2.x + n1.x * s2) / det;
  return { x, y };
}

/**
 * Offsets each edge of triangle ABC (3D) by given distances, inside the plane.
 * Positive offset moves the edge toward the triangle interior.
 * A, B, C are modified in place to the new (offset) triangle vertices.
 *
 * @param {Object} A {x,y,z}
 * @param {Object} B {x,y,z}
 * @param {Object} C {x,y,z}
 * @param {number} offsetAB distance for edge AB (toward interior if positive)
 * @param {number} offsetBC distance for edge BC (toward interior if positive)
 * @param {number} offsetCA distance for edge CA (toward interior if positive)
 */
export function offsetAndMovePoints(A, B, C, offsetAB, offsetBC, offsetCA) {
  const EPS = 1e-12;

  // 1) Build plane basis from triangle
  const AB = v.sub(B, A);
  const AC = v.sub(C, A);
  const n = v.cross(AB, AC);
  const nL = v.len(n);
  if (nL < EPS) {
    throw new Error("Degenerate triangle: points are collinear or identical.");
  }
  const nHat = v.norm(n);

  // Choose e1 along AB (or fallback to AC if AB is tiny), e2 = n × e1
  let e1 = v.norm(AB);
  if (v.len(e1) < EPS) {
    e1 = v.norm(AC);
    if (v.len(e1) < EPS) {
      throw new Error("Degenerate triangle: zero-length edges.");
    }
  }
  const e2 = v.norm(v.cross(nHat, e1)); // in-plane, perpendicular to e1

  // 2) Project triangle to 2D (plane coords)
  const a2 = project2D(A, A, e1, e2); // becomes (0,0)
  const b2 = project2D(B, A, e1, e2);
  const c2 = project2D(C, A, e1, e2);
  // a2 is origin (0,0) by construction

  // Helper to compute offset line for edge P->Q with opposite point R, offset d
  // Returns { n: normal (unit), s: scalar } for Hesse form (n · x = s)
  function edgeOffsetLine2D(P, Q, R, d) {
    const dir = v2.norm(v2.sub(Q, P));         // along edge
    if (v2.len(dir) < EPS) throw new Error("Degenerate edge encountered.");
    let n2 = v2.leftNormal(dir);               // left normal
    // Ensure n2 points toward interior (toward R)
    const toOpp = v2.sub(R, P);
    if (v2.dot(toOpp, n2) < 0) {
      n2 = v2.scale(n2, -1);
    }
    // Normalize n2 (leftNormal already unit if dir is unit, but be safe)
    n2 = v2.norm(n2);

    // Offset inward by +d: line equation n2 · x = n2 · P + d
    const s = v2.dot(n2, P) + d;
    return { n: n2, s };
  }

  // 3) Build three offset lines (2D)
  const lineAB = edgeOffsetLine2D(a2, b2, c2, offsetAB); // for edge AB
  const lineBC = edgeOffsetLine2D(b2, c2, a2, offsetBC); // for edge BC
  const lineCA = edgeOffsetLine2D(c2, a2, b2, offsetCA); // for edge CA

  // 4) Intersections give new vertices (2D)
  // New A' is intersection of offset lines for CA and AB
  const a2p = intersectHesse2D(lineCA.n, lineCA.s, lineAB.n, lineAB.s);
  // New B' is intersection of AB and BC
  const b2p = intersectHesse2D(lineAB.n, lineAB.s, lineBC.n, lineBC.s);
  // New C' is intersection of BC and CA
  const c2p = intersectHesse2D(lineBC.n, lineBC.s, lineCA.n, lineCA.s);

  // 5) Lift back to 3D and write in place
  const Ap = lift3D(a2p, A, e1, e2);
  const Bp = lift3D(b2p, A, e1, e2);
  const Cp = lift3D(c2p, A, e1, e2);

  A.x = Ap.x; A.y = Ap.y; A.z = Ap.z;
  B.x = Bp.x; B.y = Bp.y; B.z = Bp.z;
  C.x = Cp.x; C.y = Cp.y; C.z = Cp.z;
}

// --------- Example usage ----------
// const A = {x:0, y:0, z:0};
// const B = {x:1, y:0, z:0};
// const C = {x:0, y:1, z:0};
// offsetAndMovePoints(A,B,C, 0.1, 0.1, 0.1);
// console.log(A,B,C);
