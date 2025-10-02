// Test script to verify deterministic vertex naming
import { Solid } from '../src/BREP/BetterSolid.js';

console.log('Testing deterministic vertex naming...');

// Create a simple cube to test with
function createTestCube() {
    const solid = new Solid();
    
    // Define cube vertices
    const vertices = [
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], // bottom face
        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]  // top face
    ];
    
    // Add triangles for all 6 faces
    const faces = [
        // bottom (z=0)
        { name: 'bottom', triangles: [[0, 2, 1], [0, 3, 2]] },
        // top (z=1)  
        { name: 'top', triangles: [[4, 5, 6], [4, 6, 7]] },
        // front (y=0)
        { name: 'front', triangles: [[0, 1, 5], [0, 5, 4]] },
        // back (y=1)
        { name: 'back', triangles: [[2, 7, 6], [2, 3, 7]] },
        // left (x=0)
        { name: 'left', triangles: [[0, 4, 7], [0, 7, 3]] },
        // right (x=1)
        { name: 'right', triangles: [[1, 6, 5], [1, 2, 6]] }
    ];
    
    for (const face of faces) {
        for (const [i0, i1, i2] of face.triangles) {
            solid.addTriangle(face.name, vertices[i0], vertices[i1], vertices[i2]);
        }
    }
    
    return solid;
}

// Test 1: Create cube and check initial vertex names
const cube1 = createTestCube();
cube1.visualize();

console.log('Initial cube vertices:');
const initialVertices = cube1.children.filter(child => child.type === 'VERTEX');
initialVertices.forEach(vertex => {
    console.log(`  ${vertex.name} at (${vertex.position.x}, ${vertex.position.y}, ${vertex.position.z})`);
});

// Test 2: Create the same cube again and verify consistent naming
const cube2 = createTestCube();
cube2.visualize();

console.log('\nSecond cube vertices:');
const secondVertices = cube2.children.filter(child => child.type === 'VERTEX');
secondVertices.forEach(vertex => {
    console.log(`  ${vertex.name} at (${vertex.position.x}, ${vertex.position.y}, ${vertex.position.z})`);
});

// Test 3: Check that vertex names are the same for both cubes
console.log('\nChecking consistency...');
const initialNames = new Set(initialVertices.map(v => v.name));
const secondNames = new Set(secondVertices.map(v => v.name));

const consistent = initialNames.size === secondNames.size && 
                  [...initialNames].every(name => secondNames.has(name));

console.log(`Vertex naming is ${consistent ? 'CONSISTENT' : 'INCONSISTENT'}`);

if (consistent) {
    console.log('✅ Test passed: Vertex names are deterministic');
} else {
    console.log('❌ Test failed: Vertex names are not deterministic');
    console.log('Initial names:', [...initialNames].sort());
    console.log('Second names:', [...secondNames].sort());
}