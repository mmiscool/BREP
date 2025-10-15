// Test file for generateEndcapFaces function
import * as THREE from 'three';
import { generateEndcapFaces } from './common.js';

// Mock solid object with addTriangle method for testing
class MockSolid {
    constructor() {
        this.triangles = [];
    }
    
    addTriangle(faceName, p1, p2, p3) {
        this.triangles.push({
            face: faceName,
            vertices: [p1, p2, p3]
        });
    }
    
    getTriangleCount() {
        return this.triangles.length;
    }
}

// Test function
function testEndcapGeneration() {
    console.log('Testing generateEndcapFaces function...');
    
    // Test 1: Simple triangle
    console.log('\nTest 1: Simple triangle');
    const solid1 = new MockSolid();
    const trianglePoints = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0), 
        new THREE.Vector3(0.5, 1, 0)
    ];
    const count1 = generateEndcapFaces(solid1, 'TEST_CAP_1', trianglePoints);
    console.log(`Generated ${count1} triangles, expected 1`);
    console.log(`Actual triangles created: ${solid1.getTriangleCount()}`);
    
    // Test 2: Square (4 points)
    console.log('\nTest 2: Square');
    const solid2 = new MockSolid();
    const squarePoints = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(1, 1, 0),
        new THREE.Vector3(0, 1, 0)
    ];
    const count2 = generateEndcapFaces(solid2, 'TEST_CAP_2', squarePoints);
    console.log(`Generated ${count2} triangles for square, expected 2`);
    console.log(`Actual triangles created: ${solid2.getTriangleCount()}`);
    
    // Test 3: Pentagon using centroid method
    console.log('\nTest 3: Pentagon with centroid method');
    const solid3 = new MockSolid();
    const pentagonPoints = [];
    for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2;
        pentagonPoints.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0));
    }
    const count3 = generateEndcapFaces(solid3, 'TEST_CAP_3', pentagonPoints, null, {
        triangulationMethod: 'centroid'
    });
    console.log(`Generated ${count3} triangles for pentagon, expected 5`);
    console.log(`Actual triangles created: ${solid3.getTriangleCount()}`);
    
    // Test 4: Test with array input format
    console.log('\nTest 4: Array format input');
    const solid4 = new MockSolid();
    const arrayPoints = [
        [0, 0, 0],
        [1, 0, 0],
        [0.5, 1, 0]
    ];
    const count4 = generateEndcapFaces(solid4, 'TEST_CAP_4', arrayPoints);
    console.log(`Generated ${count4} triangles from array input, expected 1`);
    console.log(`Actual triangles created: ${solid4.getTriangleCount()}`);
    
    console.log('\nAll tests completed!');
}

// Export test for use in Node.js or browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { testEndcapGeneration, MockSolid };
} else if (typeof window !== 'undefined') {
    window.testEndcapGeneration = testEndcapGeneration;
}

// Run test if this file is executed directly
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].includes('test-endcap.js')) {
    testEndcapGeneration();
}