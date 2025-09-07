// newBREP/example_boolean.js
// Minimal demo: Cube ⊖ Cylinder (through-hole) using your new BREP core.

import * as THREE from 'three';
import { Cube, Cylinder, Torus } from './primitives.js';
import { CADmaterials } from '../UI/CADmaterials.js';
import { ArcballControls } from 'three/examples/jsm/Addons.js';
import { OutlineEffect } from 'three/examples/jsm/Addons.js';

// --- scene (dark mode) -------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f19);

const aspect = window.innerWidth / window.innerHeight;
const frustumSize = 100;
const camera = new THREE.OrthographicCamera(
  (-frustumSize * aspect) / 2,
  (frustumSize * aspect) / 2,
  frustumSize / 2,
  -frustumSize / 2,
  0.1,
  1000
);
camera.position.set(60, 40, 60);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.style.margin = '0';
document.body.style.background = '#0b0f19';
document.body.appendChild(renderer.domElement);

// Set fat-line resolution and desired pixel width
if (CADmaterials?.EDGE?.BASE?.resolution) {
  const bufSize = new THREE.Vector2();
  renderer.getDrawingBufferSize(bufSize);
  CADmaterials.EDGE.BASE.resolution.copy(bufSize);
  CADmaterials.EDGE.BASE.linewidth = 4; // CSS pixels
  // Optional: increase z nudge if you still see z-fighting
  if (CADmaterials.EDGE.BASE.userData?.ndcOffset) CADmaterials.EDGE.BASE.userData.ndcOffset.value = 1e-3;
}


const arcballControls = new ArcballControls(camera, renderer.domElement);
const outlineEffect = new OutlineEffect(renderer);

// --- primitives --------------------------------------------------------------
// Cube centered at origin, 30³
const cube = new Cube({ x: 50, y: 20, z: 20, name: 'Block' });
// Cylinder along +Y/−Y (height > cube to fully cut through)
const cyl = new Cylinder({ radius: 12, height: 60, resolution: 8, name: 'cyl' });


// Boolean: Block - Drill
const result = cube.boolean(cyl, 'SUBTRACT');

printNamesOfFaces(cube);
printNamesOfFaces(cyl);



//result.visualize();
printNamesOfFaces(result);


const torus1 = new Torus({ mR: 22, tR: 3, resolution: 50, arcDegrees: 180, name: 'Torus1' });
printNamesOfFaces(torus1);
//scene.add(torus1);

const result2 = cube.boolean(torus1, 'UNION');

printNamesOfFaces(result2);


scene.add(result2);






let currentFaceIndex = 0;
// --- loop --------------------------------------------------------------------
renderer.setAnimationLoop(() => {
  // Use the OutlineEffect as the single renderer so outlines aren't overwritten
  // Keep fat-line resolution synced with the drawing buffer in case DPR or size changes
  if (CADmaterials?.EDGE?.BASE?.resolution) {
    const bufSize = new THREE.Vector2();
    renderer.getDrawingBufferSize(bufSize);
    if (!CADmaterials.EDGE.BASE.resolution.equals(bufSize)) {
      CADmaterials.EDGE.BASE.resolution.copy(bufSize);
    }
  }
  outlineEffect.render(scene, camera);
});



// resize
addEventListener('resize', () => {
  const aspect = innerWidth / innerHeight;
  camera.left = (-frustumSize * aspect) / 2;
  camera.right = (frustumSize * aspect) / 2;
  camera.top = frustumSize / 2;
  camera.bottom = -frustumSize / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  // Update fat-line resolution for consistent pixel widths
  if (CADmaterials?.EDGE?.BASE?.resolution) {
    const bufSize = new THREE.Vector2();
    renderer.getDrawingBufferSize(bufSize);
    CADmaterials.EDGE.BASE.resolution.copy(bufSize);
  }
});



function printNamesOfFaces(solid) {
  solid.visualize();
  console.log(solid.children);
  const faces = solid.children.filter(c => c instanceof THREE.Mesh);
  const faceNames = [];
  for (const face of faces) {
    faceNames.push(face.name);
  }
  console.log(faceNames);
  return faceNames;
}
