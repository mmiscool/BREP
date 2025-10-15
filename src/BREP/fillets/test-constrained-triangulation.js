// Test constrained triangulation for endcap generation
import * as THREE from 'three';

class ConstrainedTriangulationTest {
    constructor() {
        this.debug = true;
        this.patchedTriangles = [];
    }

    addTriangle(faceName, v1, v2, v3) {
        this.patchedTriangles.push({
            face: faceName,
            vertices: [v1, v2, v3]
        });
        console.log(`Added constrained triangle to ${faceName}: [${v1.join(',')}] -> [${v2.join(',')}] -> [${v3.join(',')}]`);
    }

    // Include the new constrained triangulation methods
    _addFanPatch(positions, normal, patchName) {
        const interiorPoint = this._findInteriorPoint(positions, normal);
        
        if (!interiorPoint) {
            console.log(`No safe interior point found for ${patchName}, using ear clipping`);
            return this._addEarClippingPatch(positions, normal, patchName);
        }

        console.log(`Using interior point for ${patchName}: [${interiorPoint.x.toFixed(2)}, ${interiorPoint.y.toFixed(2)}, ${interiorPoint.z.toFixed(2)}]`);

        let validTriangles = 0;
        for (let i = 0; i < positions.length; i++) {
            const p1 = positions[i];
            const p2 = positions[(i + 1) % positions.length];
            
            if (this._isTriangleInsideBoundary([interiorPoint, p1, p2], positions)) {
                const edgeNormal = new THREE.Vector3()
                    .subVectors(p1, interiorPoint)
                    .cross(new THREE.Vector3().subVectors(p2, interiorPoint))
                    .normalize();

                if (edgeNormal.dot(normal) < 0) {
                    this.addTriangle(patchName, 
                        [interiorPoint.x, interiorPoint.y, interiorPoint.z], 
                        [p2.x, p2.y, p2.z], 
                        [p1.x, p1.y, p1.z]);
                } else {
                    this.addTriangle(patchName, 
                        [interiorPoint.x, interiorPoint.y, interiorPoint.z], 
                        [p1.x, p1.y, p1.z], 
                        [p2.x, p2.y, p2.z]);
                }
                validTriangles++;
            } else {
                console.log(`Skipped triangle ${i} - would extend outside boundary`);
            }
        }
        
        console.log(`Generated ${validTriangles} valid triangles for ${patchName}`);
        return true;
    }

    _findInteriorPoint(positions, normal) {
        if (positions.length < 3) return null;

        const centroid = new THREE.Vector3();
        for (const pos of positions) {
            centroid.add(pos);
        }
        centroid.divideScalar(positions.length);

        if (this._isPointInsidePolygon(centroid, positions)) {
            console.log('Using centroid as interior point');
            return centroid;
        }

        const inscribedCenter = this._findInscribedCircleCenter(positions, normal);
        if (inscribedCenter && this._isPointInsidePolygon(inscribedCenter, positions)) {
            console.log('Using inscribed circle center as interior point');
            return inscribedCenter;
        }

        console.log('No safe interior point found');
        return null;
    }

    _isPointInsidePolygon(point, polygon) {
        let inside = false;
        const n = polygon.length;

        for (let i = 0, j = n - 1; i < n; j = i++) {
            const pi = polygon[i];
            const pj = polygon[j];

            if (((pi.y > point.y) !== (pj.y > point.y)) &&
                (point.x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y) + pi.x)) {
                inside = !inside;
            }
        }

        return inside;
    }

    _isTriangleInsideBoundary(triangle, boundary) {
        let boundaryVertices = 0;
        let interiorVertices = 0;
        
        for (const vertex of triangle) {
            const onBoundary = this._isPointOnBoundary(vertex, boundary);
            const inside = this._isPointInsidePolygon(vertex, boundary);
            
            if (onBoundary) {
                boundaryVertices++;
            } else if (inside) {
                interiorVertices++;
            } else {
                return false;
            }
        }
        
        if (boundaryVertices + interiorVertices !== 3) {
            return false;
        }
        
        return this._checkTriangleEdges(triangle, boundary);
    }

    _checkTriangleEdges(triangle, boundary) {
        for (let i = 0; i < 3; i++) {
            const triEdgeStart = triangle[i];
            const triEdgeEnd = triangle[(i + 1) % 3];
            
            let isSharedBoundaryEdge = false;
            for (let j = 0; j < boundary.length; j++) {
                const boundEdgeStart = boundary[j];
                const boundEdgeEnd = boundary[(j + 1) % boundary.length];
                
                if ((this._pointsEqual(triEdgeStart, boundEdgeStart) && this._pointsEqual(triEdgeEnd, boundEdgeEnd)) ||
                    (this._pointsEqual(triEdgeStart, boundEdgeEnd) && this._pointsEqual(triEdgeEnd, boundEdgeStart))) {
                    isSharedBoundaryEdge = true;
                    break;
                }
            }
            
            if (isSharedBoundaryEdge) {
                continue;
            }
            
            for (let j = 0; j < boundary.length; j++) {
                const boundEdgeStart = boundary[j];
                const boundEdgeEnd = boundary[(j + 1) % boundary.length];
                
                if (this._pointsEqual(triEdgeStart, boundEdgeStart) || 
                    this._pointsEqual(triEdgeStart, boundEdgeEnd) ||
                    this._pointsEqual(triEdgeEnd, boundEdgeStart) || 
                    this._pointsEqual(triEdgeEnd, boundEdgeEnd)) {
                    continue;
                }
                
                if (this._edgesIntersect(triEdgeStart, triEdgeEnd, boundEdgeStart, boundEdgeEnd)) {
                    return false;
                }
            }
        }
        
        return true;
    }

    _pointsEqual(p1, p2, tolerance = 1e-10) {
        return p1.distanceTo(p2) < tolerance;
    }

    _isPointOnBoundary(point, polygon) {
        const tolerance = 1e-10;
        
        for (let i = 0; i < polygon.length; i++) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % polygon.length];
            
            const dist = this._pointToLineDistance(point, p1, p2);
            if (dist < tolerance) {
                const segLength = p1.distanceTo(p2);
                const dist1 = point.distanceTo(p1);
                const dist2 = point.distanceTo(p2);
                
                if (Math.abs(dist1 + dist2 - segLength) < tolerance) {
                    return true;
                }
            }
        }
        
        return false;
    }

    _pointToLineDistance(point, lineStart, lineEnd) {
        const line = new THREE.Vector3().subVectors(lineEnd, lineStart);
        const pointVec = new THREE.Vector3().subVectors(point, lineStart);
        const cross = new THREE.Vector3().crossVectors(pointVec, line);
        return cross.length() / line.length();
    }

    _edgesIntersect(p1, q1, p2, q2) {
        const orientation = (p, q, r) => {
            const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
            if (Math.abs(val) < 1e-10) return 0;
            return val > 0 ? 1 : 2;
        };

        const onSegment = (p, q, r) => {
            return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
                   q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
        };

        const o1 = orientation(p1, q1, p2);
        const o2 = orientation(p1, q1, q2);
        const o3 = orientation(p2, q2, p1);
        const o4 = orientation(p2, q2, q1);

        if (o1 !== o2 && o3 !== o4) return true;

        if (o1 === 0 && onSegment(p1, p2, q1)) return true;
        if (o2 === 0 && onSegment(p1, q2, q1)) return true;
        if (o3 === 0 && onSegment(p2, p1, q2)) return true;
        if (o4 === 0 && onSegment(p2, q1, q2)) return true;

        return false;
    }

    _findInscribedCircleCenter(positions, normal) {
        const centroid = new THREE.Vector3();
        for (const pos of positions) {
            centroid.add(pos);
        }
        centroid.divideScalar(positions.length);

        let bestPoint = centroid.clone();
        let maxMinDistance = 0;

        const samples = 10; // Reduced for test
        const radius = this._getBoundingRadius(positions) * 0.5;

        for (let i = 0; i < samples; i++) {
            for (let j = 0; j < samples; j++) {
                const testPoint = centroid.clone();
                testPoint.x += (i / samples - 0.5) * radius;
                testPoint.y += (j / samples - 0.5) * radius;

                if (!this._isPointInsidePolygon(testPoint, positions)) continue;

                let minDistToEdge = Infinity;
                for (let k = 0; k < positions.length; k++) {
                    const p1 = positions[k];
                    const p2 = positions[(k + 1) % positions.length];
                    const dist = this._pointToLineDistance(testPoint, p1, p2);
                    minDistToEdge = Math.min(minDistToEdge, dist);
                }

                if (minDistToEdge > maxMinDistance) {
                    maxMinDistance = minDistToEdge;
                    bestPoint = testPoint.clone();
                }
            }
        }

        return maxMinDistance > 0 ? bestPoint : null;
    }

    _getBoundingRadius(positions) {
        const center = new THREE.Vector3();
        for (const pos of positions) {
            center.add(pos);
        }
        center.divideScalar(positions.length);

        let maxDist = 0;
        for (const pos of positions) {
            maxDist = Math.max(maxDist, center.distanceTo(pos));
        }
        return maxDist;
    }

    _addEarClippingPatch(positions, normal, patchName) {
        console.log(`Using ear clipping for ${patchName} with ${positions.length} vertices`);
        // Simplified ear clipping for test
        if (positions.length >= 3) {
            for (let i = 1; i < positions.length - 1; i++) {
                this.addTriangle(patchName, 
                    [positions[0].x, positions[0].y, positions[0].z],
                    [positions[i].x, positions[i].y, positions[i].z],
                    [positions[i + 1].x, positions[i + 1].y, positions[i + 1].z]);
            }
        }
        return true;
    }
}

// Test cases
function testConstrainedTriangulation() {
    console.log('=== Testing Constrained Triangulation ===\n');
    
    const tester = new ConstrainedTriangulationTest();
    
    // Test case 1: Simple convex polygon (should work with centroid)
    console.log('Test 1: Convex pentagon');
    const convexPentagon = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(2, 0, 0),
        new THREE.Vector3(2.5, 1.5, 0),
        new THREE.Vector3(1, 2.5, 0),
        new THREE.Vector3(-0.5, 1.5, 0)
    ];
    const normal = new THREE.Vector3(0, 0, 1);
    
    tester._addFanPatch(convexPentagon, normal, 'CONVEX_ENDCAP');
    
    console.log('\n--- Test 1 Results ---');
    console.log(`Triangles generated: ${tester.patchedTriangles.length}`);
    
    // Test case 2: Concave polygon (centroid might be outside)
    console.log('\nTest 2: Concave L-shape');
    tester.patchedTriangles = []; // Reset
    
    const concaveL = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(3, 0, 0),
        new THREE.Vector3(3, 1, 0),
        new THREE.Vector3(1, 1, 0),
        new THREE.Vector3(1, 3, 0),
        new THREE.Vector3(0, 3, 0)
    ];
    
    tester._addFanPatch(concaveL, normal, 'CONCAVE_ENDCAP');
    
    console.log('\n--- Test 2 Results ---');
    console.log(`Triangles generated: ${tester.patchedTriangles.length}`);
    
    // Verify all triangles are within bounds
    let validTriangles = 0;
    for (const tri of tester.patchedTriangles) {
        const vertices = tri.vertices.map(v => new THREE.Vector3(v[0], v[1], v[2]));
        if (tester._isTriangleInsideBoundary(vertices, concaveL)) {
            validTriangles++;
        }
    }
    
    console.log(`Valid triangles (within boundary): ${validTriangles}/${tester.patchedTriangles.length}`);
    console.log('\n✓ Constrained triangulation test completed!');
}

// Run the test
testConstrainedTriangulation();