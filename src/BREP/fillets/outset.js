import * as THREE from 'three';
import { MeshRepairer } from "../MeshRepairer.js";

const __tmp1 = new THREE.Vector3();
const __tmp2 = new THREE.Vector3();
const __tmp3 = new THREE.Vector3();

// Solve center C using anchored offset planes:
//   nA·C = nA·qA + sA*r
//   nB·C = nB·qB + sB*r
//   t ·C = t ·p
// Returns THREE.Vector3 or null
function solveCenterFromOffsetPlanesAnchored(p, t, nA, qA, sA, nB, qB, sB, r) {
  const dA = nA.dot(qA) + sA * r;
  const dB = nB.dot(qB) + sB * r;
  const dT = t.dot(p);
  // Intersection of three planes using vector triple products:
  // C = ( (nB×t)*dA + (t×nA)*dB + (nA×nB)*dT ) / ( nA·(nB×t) )
  const nbxt = __tmp1.copy(nB).cross(t);
  const txnA = __tmp2.copy(t).cross(nA);
  const nAxnB = __tmp3.copy(nA).cross(nB);
  const denom = nA.dot(nbxt);
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-14) {
    // Fallback to Gaussian elimination for near-degenerate configuration
    const A = [[nA.x, nA.y, nA.z], [nB.x, nB.y, nB.z], [t.x, t.y, t.z]];
    const b = [dA, dB, dT];
    const x = solve3(A, b);
    return x ? new THREE.Vector3(x[0], x[1], x[2]) : null;
  }
  const num = nbxt.multiplyScalar(dA).add(txnA.multiplyScalar(dB)).add(nAxnB.multiplyScalar(dT));
  return new THREE.Vector3(num.x / denom, num.y / denom, num.z / denom);
}

// Solve 3x3 linear system A x = b (Gaussian elimination with partial pivoting)
function solve3(A, b) {
  const n = 3;
  const mat = A.map(row => [...row]);
  const vec = [...b];
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(mat[k][i]) > Math.abs(mat[maxRow][i])) maxRow = k;
    if (maxRow !== i) { [mat[i], mat[maxRow]] = [mat[maxRow], mat[i]]; [vec[i], vec[maxRow]] = [vec[maxRow], vec[i]]; }
    if (Math.abs(mat[i][i]) < 1e-12) return null;
    for (let k = i + 1; k < n; k++) {
      const factor = mat[k][i] / mat[i][i];
      for (let j = i; j < n; j++) mat[k][j] -= factor * mat[i][j];
      vec[k] -= factor * vec[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = vec[i];
    for (let j = i + 1; j < n; j++) x[i] -= mat[i][j] * x[j];
    x[i] /= mat[i][i];
  }
  return x;
}

// Mesh repair helper kept for external use; does not generate solids.
function fixTJunctionsAndPatchHoles(geometry, {
  weldEps = 5e-4,
  lineEps = 5e-4,
  gridCell = 0.01,
  fixNormals = true,
  patchHoles = true,
  doTJunctions = true,
  doWeld = true,
  doRemoveOverlaps = true,
} = {}) {
  if (!geometry || !(geometry.isBufferGeometry)) return geometry;
  const repairer = new MeshRepairer();
  let g = geometry;
  if (doWeld) { try { g = repairer.weldVertices(g, weldEps); } catch {} }
  if (doTJunctions) { try { g = repairer.fixTJunctions(g, lineEps, gridCell); } catch {} }
  if (doRemoveOverlaps) { try { g = repairer.removeOverlappingTriangles(g); } catch {} }
  if (patchHoles) { try { g = repairer.fillHoles(g); } catch {} }
  if (fixNormals) {
    try { g = repairer.fixTriangleNormals(g); } catch {}
    try { g.computeVertexNormals(); } catch {}
  }
  return g;
}

export {
  solveCenterFromOffsetPlanesAnchored,
  fixTJunctionsAndPatchHoles,
};

