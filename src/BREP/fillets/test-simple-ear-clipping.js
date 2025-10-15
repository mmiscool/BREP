// Test simplified ear clipping approach
import * as THREE from 'three';

class SimpleEarClippingTest {
    constructor() {
        this.debug = true;
        this.patchedTriangles = [];
    }

    addTriangle(faceName, v1, v2, v3) {
        this.patchedTriangles.push({
            face: faceName,
            vertices: [v1, v2, v3]
        });
        console.log(`Added triangle to ${faceName}: [${v1.join(',')}] -> [${v2.join(',')}] -> [${v3.join(',')}]`);
    }

    // Simple triangulation methods
    _addTrianglePatch(positions, normal, patchName) {
        const [p0, p1, p2] = positions;
        const computedNormal = new THREE.Vector3()
            .subVectors(p1, p0)
            .cross(new THREE.Vector3().subVectors(p2, p0))
            .normalize();

        if (computedNormal.dot(normal) < 0) {
            this.addTriangle(patchName, [p0.x, p0.y, p0.z], [p2.x, p2.y, p2.z], [p1.x, p1.y, p1.z]);
        } else {
            this.addTriangle(patchName, [p0.x, p0.y, p0.z], [p1.x, p1.y, p1.z], [p2.x, p2.y, p2.z]);
        }
        return true;
    }

    _addEarClippingPatch(positions, normal, patchName) {
        if (positions.length < 3) return false;
        if (positions.length === 3) {
            return this._addTrianglePatch(positions, normal, patchName);
        }

        console.log(`Ear clipping for ${patchName} with ${positions.length} vertices`);

        const vertices = [...positions];
        let triangleCount = 0;

        while (vertices.length > 3) {
            let earRemoved = false;

            for (let i = 0; i < vertices.length; i++) {
                const prev = vertices[(i - 1 + vertices.length) % vertices.length];
                const curr = vertices[i];
                const next = vertices[(i + 1) % vertices.length];

                if (this._isConvexVertex(prev, curr, next, normal)) {
                    let hasVertexInside = false;
                    for (let j = 0; j < vertices.length; j++) {
                        if (j === i || j === (i - 1 + vertices.length) % vertices.length || j === (i + 1) % vertices.length) {
                            continue;
                        }
                        
                        if (this._isPointInTriangle(vertices[j], prev, curr, next)) {
                            hasVertexInside = true;
                            break;
                        }
                    }

                    if (!hasVertexInside) {
                        this._addTrianglePatch([prev, curr, next], normal, patchName);
                        vertices.splice(i, 1);
                        earRemoved = true;
                        triangleCount++;
                        break;
                    }
                }
            }

            if (!earRemoved) {
                console.log(`No ear found, using simple fan for remaining ${vertices.length} vertices`);
                for (let i = 1; i < vertices.length - 1; i++) {
                    this._addTrianglePatch([vertices[0], vertices[i], vertices[i + 1]], normal, patchName);
                    triangleCount++;
                }
                break;
            }
        }

        if (vertices.length === 3) {
            this._addTrianglePatch(vertices, normal, patchName);
            triangleCount++;
        }

        console.log(`Generated ${triangleCount} triangles for ${patchName}`);
        return triangleCount > 0;
    }

    _isConvexVertex(prev, curr, next, normal) {
        const v1 = new THREE.Vector3().subVectors(prev, curr);
        const v2 = new THREE.Vector3().subVectors(next, curr);
        const cross = new THREE.Vector3().crossVectors(v1, v2);
        return cross.dot(normal) > 0;
    }

    _isPointInTriangle(point, a, b, c) {
        const v0 = new THREE.Vector3().subVectors(c, a);
        const v1 = new THREE.Vector3().subVectors(b, a);
        const v2 = new THREE.Vector3().subVectors(point, a);

        const dot00 = v0.dot(v0);
        const dot01 = v0.dot(v1);
        const dot02 = v0.dot(v2);
        const dot11 = v1.dot(v1);
        const dot12 = v1.dot(v2);

        const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
        const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
        const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

        return (u >= 0) && (v >= 0) && (u + v <= 1);
    }
}

function testSimpleEarClipping() {
    console.log('=== Testing Simple Ear Clipping ===\n');
    
    const tester = new SimpleEarClippingTest();
    const normal = new THREE.Vector3(0, 0, 1);
    
    // Test 1: Simple square
    console.log('Test 1: Square');
    const square = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(1, 1, 0),
        new THREE.Vector3(0, 1, 0)
    ];
    
    tester._addEarClippingPatch(square, normal, 'SQUARE_PATCH');
    console.log(`Square result: ${tester.patchedTriangles.length} triangles\n`);
    
    // Reset for next test
    tester.patchedTriangles = [];
    
    // Test 2: Pentagon
    console.log('Test 2: Pentagon');
    const pentagon = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(1.2, 0.8, 0),
        new THREE.Vector3(0.5, 1.2, 0),
        new THREE.Vector3(-0.2, 0.8, 0)
    ];
    
    tester._addEarClippingPatch(pentagon, normal, 'PENTAGON_PATCH');
    console.log(`Pentagon result: ${tester.patchedTriangles.length} triangles\n`);
    
    console.log('✓ Simple ear clipping test completed!');
}

// Run the test
testSimpleEarClipping();