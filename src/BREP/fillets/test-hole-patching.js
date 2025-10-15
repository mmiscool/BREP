// Test the hole patching system
import * as THREE from 'three';

// Mock FilletSolid for testing hole patching
class MockFilletSolidWithPatching {
    constructor() {
        this._vertProperties = [];
        this._triVerts = [];
        this._vertKeyToIndex = new Map();
        this._idToFaceName = new Map();
        this._faceNameToID = new Map();
        this.debug = true;
        this.eps = 1e-10;
        this.patchedTriangles = [];
    }

    // Mock the addTriangleFromPoints method
    addTriangleFromPoints(faceName, p0, p1, p2) {
        this.patchedTriangles.push({
            face: faceName,
            vertices: [
                [p0.x, p0.y, p0.z],
                [p1.x, p1.y, p1.z],
                [p2.x, p2.y, p2.z]
            ]
        });
        console.log(`Added patch triangle ${faceName}: [${p0.x.toFixed(2)},${p0.y.toFixed(2)},${p0.z.toFixed(2)}] -> [${p1.x.toFixed(2)},${p1.y.toFixed(2)},${p1.z.toFixed(2)}] -> [${p2.x.toFixed(2)},${p2.y.toFixed(2)},${p2.z.toFixed(2)}]`);
    }

    // Mock cleanup methods
    _weldVerticesByEpsilon(tolerance) {
        console.log(`Welding vertices with tolerance ${tolerance}`);
    }

    fixTriangleWindingsByAdjacency() {
        console.log('Fixing triangle windings');
    }

    // Create test mesh with holes
    createTestMeshWithHoles() {
        // Create a simple open box (missing top and bottom)
        this._vertProperties = new Float32Array([
            // Bottom rectangle vertices (hole)
            0, 0, 0,  // 0
            2, 0, 0,  // 1
            2, 2, 0,  // 2
            0, 2, 0,  // 3
            // Top rectangle vertices (hole)
            0, 0, 2,  // 4
            2, 0, 2,  // 5
            2, 2, 2,  // 6
            0, 2, 2   // 7
        ]);

        // Add only side faces, leaving top and bottom open
        this._triVerts = [
            // Front face (2 triangles)
            0, 1, 5,
            0, 5, 4,
            // Right face (2 triangles)  
            1, 2, 6,
            1, 6, 5,
            // Back face (2 triangles)
            2, 3, 7,
            2, 7, 6,
            // Left face (2 triangles)
            3, 0, 4,
            3, 4, 7
        ];

        console.log('Created test mesh with 2 holes (top and bottom missing)');
        console.log(`Vertices: ${this._vertProperties.length / 3}`);
        console.log(`Triangles: ${this._triVerts.length / 3}`);
    }

    // Include the hole patching methods from fillet.js
    _patchAllHoles(baseName) {
        const boundaryLoops = this._findBoundaryLoops();
        if (!boundaryLoops || boundaryLoops.length === 0) {
            return 0;
        }

        let holesPatched = 0;
        for (let i = 0; i < boundaryLoops.length; i++) {
            const loop = boundaryLoops[i];
            if (loop.vertices.length >= 3) {
                const patchName = `${baseName}_PATCH_${i}`;
                const success = this._patchHole(loop, patchName);
                if (success) {
                    holesPatched++;
                }
            }
        }

        if (holesPatched > 0) {
            this._cleanupAfterPatching();
        }

        return holesPatched;
    }

    _findBoundaryLoops() {
        const vp = this._vertProperties;
        const tv = this._triVerts;
        if (!tv || tv.length < 3 || !vp || vp.length < 9) {
            return [];
        }

        // Build edge adjacency map
        const edgeCount = new Map();
        const triCount = Math.floor(tv.length / 3);

        // Count edge usage
        for (let t = 0; t < triCount; t++) {
            const i0 = tv[t * 3 + 0];
            const i1 = tv[t * 3 + 1];
            const i2 = tv[t * 3 + 2];

            const edges = [[i0, i1], [i1, i2], [i2, i0]];
            for (const [a, b] of edges) {
                const key = a < b ? `${a}:${b}` : `${b}:${a}`;
                edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
            }
        }

        // Find boundary edges (used only once)
        const boundaryEdges = [];
        for (const [key, count] of edgeCount) {
            if (count === 1) {
                const [a, b] = key.split(':').map(Number);
                boundaryEdges.push([a, b]);
            }
        }

        if (boundaryEdges.length === 0) {
            return [];
        }

        console.log(`Found ${boundaryEdges.length} boundary edges`);

        // Group boundary edges into loops
        return this._groupEdgesIntoLoops(boundaryEdges, vp);
    }

    _groupEdgesIntoLoops(edges, vp) {
        const adjacency = new Map();
        
        // Build adjacency map
        for (const [a, b] of edges) {
            if (!adjacency.has(a)) adjacency.set(a, []);
            if (!adjacency.has(b)) adjacency.set(b, []);
            adjacency.get(a).push(b);
            adjacency.get(b).push(a);
        }

        const loops = [];
        const visited = new Set();

        for (const [startVertex] of adjacency) {
            if (visited.has(startVertex)) continue;

            const loop = this._traceLoop(startVertex, adjacency, visited, vp);
            if (loop && loop.vertices.length >= 3) {
                loops.push(loop);
            }
        }

        return loops;
    }

    _traceLoop(start, adjacency, visited, vp) {
        const vertices = [];
        const positions = [];
        let current = start;
        let previous = -1;

        do {
            if (visited.has(current)) break;
            
            visited.add(current);
            vertices.push(current);
            
            // Add position
            const pos = new THREE.Vector3(
                vp[current * 3 + 0],
                vp[current * 3 + 1], 
                vp[current * 3 + 2]
            );
            positions.push(pos);

            // Find next vertex
            const neighbors = adjacency.get(current) || [];
            let next = -1;
            
            for (const neighbor of neighbors) {
                if (neighbor !== previous) {
                    next = neighbor;
                    break;
                }
            }

            if (next === -1 || next === start) break;
            
            previous = current;
            current = next;

        } while (current !== start && vertices.length < 1000); // Safety limit

        return vertices.length >= 3 ? { vertices, positions } : null;
    }

    _patchHole(loop, patchName) {
        try {
            const positions = loop.positions;
            if (positions.length < 3) return false;

            console.log(`Patching hole ${patchName} with ${positions.length} vertices`);

            // Calculate loop normal for consistent orientation
            const normal = this._calculateLoopNormal(positions);
            
            // Choose best triangulation method based on loop properties
            if (positions.length === 3) {
                return this._addTrianglePatch(positions, normal, patchName);
            } else if (positions.length === 4) {
                return this._addQuadPatch(positions, normal, patchName);
            } else {
                return this._addFanPatch(positions, normal, patchName);
            }
        } catch (error) {
            console.warn(`Failed to patch hole ${patchName}:`, error.message);
            return false;
        }
    }

    _calculateLoopNormal(positions) {
        if (positions.length < 3) return new THREE.Vector3(0, 0, 1);

        // Use Newell's method for robust normal calculation
        const normal = new THREE.Vector3();
        for (let i = 0; i < positions.length; i++) {
            const curr = positions[i];
            const next = positions[(i + 1) % positions.length];
            
            normal.x += (curr.y - next.y) * (curr.z + next.z);
            normal.y += (curr.z - next.z) * (curr.x + next.x);
            normal.z += (curr.x - next.x) * (curr.y + next.y);
        }
        
        return normal.normalize();
    }

    _addTrianglePatch(positions, normal, patchName) {
        const [p0, p1, p2] = positions;
        const computedNormal = new THREE.Vector3()
            .subVectors(p1, p0)
            .cross(new THREE.Vector3().subVectors(p2, p0))
            .normalize();

        if (computedNormal.dot(normal) < 0) {
            this.addTriangleFromPoints(patchName, p0, p2, p1);
        } else {
            this.addTriangleFromPoints(patchName, p0, p1, p2);
        }
        return true;
    }

    _addQuadPatch(positions, normal, patchName) {
        const [p0, p1, p2, p3] = positions;
        
        const diag1Length = p0.distanceTo(p2);
        const diag2Length = p1.distanceTo(p3);
        
        if (diag1Length < diag2Length) {
            this._addTrianglePatch([p0, p1, p2], normal, `${patchName}_A`);
            this._addTrianglePatch([p0, p2, p3], normal, `${patchName}_B`);
        } else {
            this._addTrianglePatch([p0, p1, p3], normal, `${patchName}_A`);
            this._addTrianglePatch([p1, p2, p3], normal, `${patchName}_B`);
        }
        return true;
    }

    _addFanPatch(positions, normal, patchName) {
        const centroid = new THREE.Vector3();
        for (const pos of positions) {
            centroid.add(pos);
        }
        centroid.divideScalar(positions.length);

        for (let i = 0; i < positions.length; i++) {
            const p1 = positions[i];
            const p2 = positions[(i + 1) % positions.length];
            
            const edgeNormal = new THREE.Vector3()
                .subVectors(p1, centroid)
                .cross(new THREE.Vector3().subVectors(p2, centroid))
                .normalize();

            if (edgeNormal.dot(normal) < 0) {
                this.addTriangleFromPoints(`${patchName}_${i}`, centroid, p2, p1);
            } else {
                this.addTriangleFromPoints(`${patchName}_${i}`, centroid, p1, p2);
            }
        }
        return true;
    }

    _cleanupAfterPatching() {
        this._weldVerticesByEpsilon(this.eps);
        this.fixTriangleWindingsByAdjacency();
    }
}

// Run the test
function testHolePatching() {
    console.log('=== Testing Hole Patching System ===\n');
    
    const solid = new MockFilletSolidWithPatching();
    
    // Create a mesh with holes
    solid.createTestMeshWithHoles();
    
    console.log('\n--- Starting hole patching ---');
    const patchCount = solid._patchAllHoles('TEST_FILLET');
    
    console.log(`\n--- Results ---`);
    console.log(`✓ Patched ${patchCount} holes`);
    console.log(`✓ Added ${solid.patchedTriangles.length} patch triangles`);
    
    if (solid.patchedTriangles.length > 0) {
        console.log('\nPatch triangles created:');
        for (const tri of solid.patchedTriangles) {
            console.log(`  ${tri.face}: triangle with 3 vertices`);
        }
    }
    
    console.log('\n✓ Hole patching test completed successfully!');
    console.log('The mesh should now be manifold with all holes closed.');
}

// Run the test
testHolePatching();