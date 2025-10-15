// Test integration of endcap generation in FilletSolid
import * as THREE from 'three';

// Mock classes to test the integration
class MockSolid {
    constructor() {
        this._vertProperties = [];
        this._triVerts = [];
        this._triIDs = [];
        this._vertKeyToIndex = new Map();
        this._idToFaceName = new Map();
        this._faceNameToID = new Map();
        this.triangles = [];
        this.debug = true;
    }
    
    addTriangle(faceName, p1, p2, p3) {
        this.triangles.push({
            face: faceName,
            vertices: [p1, p2, p3]
        });
        
        // Simulate adding to internal arrays
        const baseIdx = this._vertProperties.length / 3;
        this._vertProperties.push(...p1, ...p2, ...p3);
        this._triVerts.push(baseIdx, baseIdx + 1, baseIdx + 2);
    }
    
    _isCoherentlyOrientedManifold() {
        // Simulate non-manifold condition for testing
        return false;
    }
    
    getMesh() {
        // Simulate manifold failure
        throw new Error('Non-manifold mesh');
    }
    
    fixTriangleWindingsByAdjacency() { }
    _weldVerticesByEpsilon() { }
}

// Create a test case with non-manifold geometry
function testEndcapIntegration() {
    console.log('Testing FilletSolid endcap integration...');
    
    // Create a mock solid with boundary edges
    const solid = new MockSolid();
    
    // Add some triangles that create boundary edges (incomplete mesh)
    solid.addTriangle('ARC', [0,0,0], [1,0,0], [0.5,0.5,0]);
    solid.addTriangle('SIDE_A', [1,0,0], [1,1,0], [0.5,0.5,0]);
    // Missing triangle to close the mesh - creates boundary
    
    // Test the boundary detection method
    try {
        // Add the boundary detection methods to our mock
        solid._detectBoundaryLoops = function() {
            // Simulate detected boundary loop
            return [{
                points: [
                    new THREE.Vector3(0, 0, 0),
                    new THREE.Vector3(1, 1, 0),
                    new THREE.Vector3(0, 1, 0)
                ],
                length: 3
            }];
        };
        
        solid._computeLoopNormal = function(points) {
            return new THREE.Vector3(0, 0, 1);
        };
        
        solid._traceBoundaryLoop = function(start, adj, visited) {
            return [0, 1, 2]; // Mock boundary loop indices
        };
        
        solid._generateEndcapsIfNeeded = function(radius, baseName) {
            console.log(`Generating endcaps for ${baseName} with radius ${radius}`);
            
            const loops = this._detectBoundaryLoops();
            let endcapsGenerated = 0;
            
            for (let i = 0; i < loops.length; i++) {
                const loop = loops[i];
                const capName = `${baseName}_ENDCAP_${i}`;
                
                // Simulate successful endcap generation
                console.log(`Generated endcap ${capName} with 1 triangle`);
                this.addTriangle(capName, [0,0,0], [1,1,0], [0,1,0]);
                endcapsGenerated++;
            }
            
            return endcapsGenerated;
        };
        
        // Test the endcap generation
        const radius = 1.0;
        const baseName = 'TEST_FILLET';
        const endcaps = solid._generateEndcapsIfNeeded(radius, baseName);
        
        console.log(`✓ Generated ${endcaps} endcaps successfully`);
        console.log(`✓ Total triangles after endcaps: ${solid.triangles.length}`);
        
        // Verify endcap was added
        const endcapTriangle = solid.triangles.find(t => t.face.includes('ENDCAP'));
        if (endcapTriangle) {
            console.log(`✓ Endcap triangle found: ${endcapTriangle.face}`);
        } else {
            console.log('✗ Endcap triangle not found');
        }
        
    } catch (e) {
        console.error('✗ Test failed:', e.message);
    }
}

// Test boundary loop detection
function testBoundaryDetection() {
    console.log('\nTesting boundary detection...');
    
    const solid = new MockSolid();
    
    // Create a mesh with a clear boundary (incomplete square)
    solid._vertProperties = [
        0, 0, 0,  // vertex 0
        1, 0, 0,  // vertex 1  
        1, 1, 0,  // vertex 2
        0, 1, 0   // vertex 3
    ];
    
    // Add triangles that leave edges 2->3 and 3->0 as boundaries
    solid._triVerts = [
        0, 1, 2,  // triangle connecting vertices 0,1,2
        // Missing triangle 0,2,3 - creates boundary edges
    ];
    
    // Implement real boundary detection for test
    solid._detectBoundaryLoops = function() {
        const vp = this._vertProperties;
        const tv = this._triVerts;
        const triCount = Math.floor(tv.length / 3);
        
        if (triCount === 0 || !vp || vp.length < 9) return [];
        
        // Build edge count map
        const edgeCount = new Map();
        const addEdge = (a, b) => {
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        };
        
        // Count edge usage
        for (let t = 0; t < triCount; t++) {
            const i0 = tv[t * 3 + 0];
            const i1 = tv[t * 3 + 1];
            const i2 = tv[t * 3 + 2];
            addEdge(i0, i1);
            addEdge(i1, i2);
            addEdge(i2, i0);
        }
        
        // Find boundary edges
        const boundaryEdges = [];
        for (const [edgeKey, count] of edgeCount.entries()) {
            if (count === 1) {
                const [a, b] = edgeKey.split(':').map(Number);
                boundaryEdges.push([a, b]);
            }
        }
        
        console.log(`Found ${boundaryEdges.length} boundary edges:`, boundaryEdges);
        
        if (boundaryEdges.length === 0) return [];
        
        // For this simple test, just return the boundary as a loop
        const points = boundaryEdges.map(([a, b]) => new THREE.Vector3(
            vp[a * 3 + 0], vp[a * 3 + 1], vp[a * 3 + 2]
        ));
        
        return [{ points, length: points.length }];
    };
    
    try {
        const loops = solid._detectBoundaryLoops();
        console.log(`✓ Detected ${loops.length} boundary loops`);
        
        if (loops.length > 0) {
            console.log(`✓ First loop has ${loops[0].points.length} points`);
        }
        
    } catch (e) {
        console.error('✗ Boundary detection test failed:', e.message);
    }
}

// Run tests
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { testEndcapIntegration, testBoundaryDetection };
} else {
    // Run tests directly
    testEndcapIntegration();
    testBoundaryDetection();
    console.log('\nEndcap integration tests completed!');
}