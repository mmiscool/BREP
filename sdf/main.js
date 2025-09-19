// Entry point. Bring your triangulated data here and mount the viewer.
import { mountViewer } from './viewer.js';

// If you already have vertices/indices from your DC pipeline, pass them directly:
// const vertices = [...]; // [[x,y,z], ...] or Float32Array flat
// const indices = [...];  // [i0,i1,i2, ...] (triangles)
//
// mountViewer(document.getElementById('app'), { vertices, indices });

// --- Minimal placeholder: show a tiny tetra if no data is provided ---
// Replace this block with your real data or import from your DC module.
function makeTestMesh() {
  const vertices = [
    [-0.4, -0.35,  0.0],
    [ 0.4, -0.35,  0.0],
    [ 0.0,  0.45,  0.0],
    [ 0.0,  0.0,   0.5]
  ];
  const indices = [
    0,1,2,
    0,1,3,
    1,2,3,
    2,0,3
  ];
  return { vertices, indices };
}

const viewer = mountViewer(
  document.getElementById('app'),
  makeTestMesh()
);

// If you want to expose a simple hook in dev tools to swap the mesh at runtime:
window.setMesh = (vertices, indices) => viewer.setMesh({ vertices, indices });
console.log('Viewer ready. Use setMesh(vertices, indices) from console to update.');
