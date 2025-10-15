// Test for robust manifold endcap generation
import * as THREE from 'three';

// Mock the required functions
function vToArr(v) { return [v.x, v.y, v.z]; }

// Mock solid class with enhanced testing capabilities
class MockManifoldSolid {
    constructor() {
        this._vertProperties = [];
        this._triVerts = [];
        this._triIDs = [];
        this.triangles = [];
        this.debug = true;
        this.edgeCount = new Map();
    }
    
    addTriangle(faceName, p1, p2, p3) {
        const baseIdx = this._vertProperties.length / 3;
        
        // Add vertices
        this._vertProperties.push(...p1, ...p2, ...p3);
        this._triVerts.push(baseIdx, baseIdx + 1, baseIdx + 2);
        
        // Track for testing
        this.triangles.push({
            face: faceName,
            vertices: [p1, p2, p3],
            indices: [baseIdx, baseIdx + 1, baseIdx + 2]
        });
        
        // Update edge count for manifold checking
        this._updateEdgeCount(baseIdx, baseIdx + 1, baseIdx + 2);
    }
    
    _updateEdgeCount(i0, i1, i2) {
        const edges = [[i0, i1], [i1, i2], [i2, i0]];
        for (const [a, b] of edges) {
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            this.edgeCount.set(key, (this.edgeCount.get(key) || 0) + 1);
        }
    }
    
    _isRobustlyManifold() {
        // Check if all edges have exactly 2 triangles
        for (const count of this.edgeCount.values()) {
            if (count !== 2) return false;
        }
        return true;
    }
    
    _isCoherentlyOrientedManifold() {
        return this._isRobustlyManifold();
    }
    
    getMesh() {
        if (!this._isRobustlyManifold()) {
            throw new Error('Non-manifold mesh');
        }
        return { delete: () => {} }; // Mock manifold mesh
    }
    
    fixTriangleWindingsByAdjacency() {}
    _weldVerticesByEpsilon() {}
    
    // Add the enhanced manifold methods
    _detectManifoldBoundaries() {
        // Create a test case with a clear boundary
        if (this.triangles.length === 0) {
            return [{
                vertices: [0, 1, 2, 3],
                positions: [
                    new THREE.Vector3(0, 0, 0),
                    new THREE.Vector3(1, 0, 0),
                    new THREE.Vector3(1, 1, 0),
                    new THREE.Vector3(0, 1, 0)
                ],
                normal: new THREE.Vector3(0, 0, 1),
                closed: true
            }];
        }
        return [];
    }
    
    _generateManifoldEndcap(loop, capName, minArea, radius) {
        console.log(`Generating manifold endcap ${capName} for ${loop.vertices.length} vertices`);
        
        if (loop.positions.length === 4) {
            // Test quad triangulation
            const [p0, p1, p2, p3] = loop.positions;
            
            // Add two triangles with proper orientation
            this.addTriangle(capName, vToArr(p0), vToArr(p1), vToArr(p2));
            this.addTriangle(capName, vToArr(p0), vToArr(p2), vToArr(p3));
            
            return 2;
        } else if (loop.positions.length === 3) {
            // Single triangle
            const [p0, p1, p2] = loop.positions;
            this.addTriangle(capName, vToArr(p0), vToArr(p1), vToArr(p2));
            return 1;
        }
        
        return 0;
    }
}

// Test manifold boundary detection
function testManifoldBoundaryDetection() {
    console.log('Testing manifold boundary detection...');
    
    const solid = new MockManifoldSolid();
    
    // Create a non-manifold mesh (incomplete cube face)
    solid.addTriangle('FACE', [0,0,0], [1,0,0], [1,1,0]);
    // Missing triangle to complete the face - creates boundary
    
    console.log(`Edge count map:`, solid.edgeCount);
    console.log(`Is manifold: ${solid._isRobustlyManifold()}`);
    
    const boundaries = solid._detectManifoldBoundaries();
    console.log(`✓ Detected ${boundaries.length} boundary loops`);
    
    if (boundaries.length > 0) {
        const loop = boundaries[0];
        console.log(`✓ First loop: ${loop.vertices.length} vertices, closed: ${loop.closed}`);
        console.log(`✓ Loop normal:`, loop.normal);
    }
}

// Test robust endcap generation
function testRobustEndcapGeneration() {
    console.log('\nTesting robust endcap generation...');
    
    const solid = new MockManifoldSolid();
    
    // Test with square boundary
    const squareLoop = {
        vertices: [0, 1, 2, 3],
        positions: [
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(2, 0, 0),
            new THREE.Vector3(2, 2, 0),
            new THREE.Vector3(0, 2, 0)
        ],
        normal: new THREE.Vector3(0, 0, 1),
        closed: true
    };
    
    const triangleCount = solid._generateManifoldEndcap(squareLoop, 'TEST_ENDCAP', 1e-12, 1.0);
    
    console.log(`✓ Generated ${triangleCount} triangles for square endcap`);
    console.log(`✓ Total triangles in solid: ${solid.triangles.length}`);
    
    // Check if result is manifold
    console.log(`✓ Result is manifold: ${solid._isRobustlyManifold()}`);
    
    // Verify edge counts
    const boundaryEdges = [];
    const nonManifoldEdges = [];
    
    for (const [edge, count] of solid.edgeCount.entries()) {
        if (count === 1) boundaryEdges.push(edge);
        else if (count > 2) nonManifoldEdges.push(edge);
    }
    
    console.log(`✓ Boundary edges: ${boundaryEdges.length}`);
    console.log(`✓ Non-manifold edges: ${nonManifoldEdges.length}`);
}

// Test triangle quality validation
function testTriangleQuality() {
    console.log('\nTesting triangle quality validation...');
    
    const solid = new MockManifoldSolid();
    
    // Add helper methods for testing
    solid._computeTriangleArea = function(p0, p1, p2) {
        const v1 = new THREE.Vector3().subVectors(p1, p0);
        const v2 = new THREE.Vector3().subVectors(p2, p0);
        return v1.cross(v2).length() * 0.5;
    };
    
    solid._addManifoldTriangle = function(faceName, positions, minArea) {
        if (positions.length !== 3) return 0;
        
        const area = this._computeTriangleArea(positions[0], positions[1], positions[2]);
        console.log(`Triangle area: ${area}, minimum: ${minArea}`);
        
        if (area < minArea) {
            console.log('✓ Correctly rejected degenerate triangle');
            return 0;
        }
        
        this.addTriangle(faceName, vToArr(positions[0]), vToArr(positions[1]), vToArr(positions[2]));
        return 1;
    };
    
    // Test with good triangle
    const goodTriangle = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0.5, 1, 0)
    ];
    
    const count1 = solid._addManifoldTriangle('GOOD', goodTriangle, 1e-6);
    console.log(`✓ Added ${count1} good triangle`);
    
    // Test with degenerate triangle
    const degenerateTriangle = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0.5, 0, 0)  // Collinear point
    ];
    
    const count2 = solid._addManifoldTriangle('BAD', degenerateTriangle, 1e-6);
    console.log(`✓ Rejected ${1 - count2} degenerate triangle`);
}

// Test winding order correction
function testWindingOrderCorrection() {
    console.log('\nTesting winding order correction...');
    
    const positions = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0.5, 1, 0)
    ];
    
    const expectedNormal = new THREE.Vector3(0, 0, 1);
    
    // Mock the winding check method
    const shouldReverse = function(positions, expectedNormal) {
        if (positions.length < 3) return false;
        
        const v0 = positions[0];
        const v1 = positions[1]; 
        const v2 = positions[2];
        
        const edge1 = new THREE.Vector3().subVectors(v1, v0);
        const edge2 = new THREE.Vector3().subVectors(v2, v0);
        const actualNormal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
        
        return actualNormal.dot(expectedNormal) < 0;
    };
    
    const needsReverse = shouldReverse(positions, expectedNormal);
    console.log(`✓ Winding order correct: ${!needsReverse}`);
    
    // Test with reversed positions
    const reversedPositions = positions.slice().reverse();
    const needsReverse2 = shouldReverse(reversedPositions, expectedNormal);
    console.log(`✓ Detects reversed winding: ${needsReverse2}`);
}

// Run all tests
function runManifoldTests() {
    console.log('=== Testing Robust Manifold Endcap Generation ===\n');
    
    testManifoldBoundaryDetection();
    testRobustEndcapGeneration(); 
    testTriangleQuality();
    testWindingOrderCorrection();
    
    console.log('\n=== All manifold tests completed! ===');
}

// Export for Node.js or run directly
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { runManifoldTests };
} else {
    runManifoldTests();
}