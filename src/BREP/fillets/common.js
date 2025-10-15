import * as THREE from 'three';

// Helper functions for vector conversion
function arrToV(p) { return new THREE.Vector3(p[0], p[1], p[2]); }
function vToArr(v) { return [v.x, v.y, v.z]; }

/**
 * Generate endcap faces to create a manifold mesh by triangulating a boundary loop.
 * This function creates triangular faces that close off open boundaries in a mesh,
 * which is essential for maintaining manifold topology in CSG operations.
 * 
 * @param {Object} solid - The solid object to add triangles to
 * @param {string} faceName - Name/ID for the endcap face
 * @param {Array<THREE.Vector3|Array>} boundaryPoints - Ordered boundary loop vertices
 * @param {THREE.Vector3} [normal] - Optional normal vector for orientation (auto-computed if not provided)
 * @param {Object} [options] - Configuration options
 * @param {number} [options.minTriangleArea=1e-12] - Minimum triangle area threshold
 * @param {boolean} [options.ensureCounterClockwise=true] - Ensure proper winding order
 * @param {string} [options.triangulationMethod='fan'] - Method: 'fan', 'earcut', or 'centroid'
 * @returns {number} Number of triangles generated
 */
export function generateEndcapFaces(solid, faceName, boundaryPoints, normal = null, options = {}) {
    const {
        minTriangleArea = 1e-12,
        ensureCounterClockwise = true,
        triangulationMethod = 'fan'
    } = options;
    
    if (!solid || typeof solid.addTriangle !== 'function') {
        throw new Error('generateEndcapFaces: solid must have addTriangle method');
    }
    
    if (!Array.isArray(boundaryPoints) || boundaryPoints.length < 3) {
        console.warn('generateEndcapFaces: insufficient boundary points for triangulation');
        return 0;
    }
    
    // Convert boundary points to Vector3 if needed and validate
    const points = boundaryPoints.map(p => {
        const v = Array.isArray(p) ? arrToV(p) : p;
        if (!v || typeof v.x !== 'number' || !Number.isFinite(v.x + v.y + v.z)) {
            throw new Error('generateEndcapFaces: invalid point in boundary');
        }
        return v;
    });
    
    // Remove duplicate consecutive points
    const cleanPoints = [];
    const eps = Math.max(minTriangleArea, 1e-10);
    for (let i = 0; i < points.length; i++) {
        const curr = points[i];
        const next = points[(i + 1) % points.length];
        if (curr.distanceTo(next) > eps) {
            cleanPoints.push(curr);
        }
    }
    
    if (cleanPoints.length < 3) {
        console.warn('generateEndcapFaces: insufficient unique points after cleaning');
        return 0;
    }
    
    // Auto-compute normal if not provided using Newell's method for robustness
    let capNormal = normal;
    if (!capNormal || !Number.isFinite(capNormal.x + capNormal.y + capNormal.z)) {
        capNormal = computePolygonNormal(cleanPoints);
        if (capNormal.lengthSq() < eps) {
            console.warn('generateEndcapFaces: degenerate polygon, cannot compute normal');
            return 0;
        }
    }
    
    // Ensure consistent winding order
    if (ensureCounterClockwise) {
        const signedArea = computeSignedArea(cleanPoints, capNormal);
        if (signedArea < 0) {
            cleanPoints.reverse();
        }
    }
    
    let triangleCount = 0;
    
    // Choose triangulation method
    switch (triangulationMethod) {
        case 'centroid':
            triangleCount = triangulateCentroid(solid, faceName, cleanPoints, minTriangleArea);
            break;
        case 'earcut':
            triangleCount = triangulateEarcut(solid, faceName, cleanPoints, capNormal, minTriangleArea);
            break;
        case 'fan':
        default:
            triangleCount = triangulateFan(solid, faceName, cleanPoints, minTriangleArea);
            break;
    }
    
    return triangleCount;
}

/**
 * Compute polygon normal using Newell's method (robust for non-planar polygons)
 */
function computePolygonNormal(points) {
    const normal = new THREE.Vector3();
    const n = points.length;
    
    for (let i = 0; i < n; i++) {
        const p0 = points[i];
        const p1 = points[(i + 1) % n];
        
        normal.x += (p0.y - p1.y) * (p0.z + p1.z);
        normal.y += (p0.z - p1.z) * (p0.x + p1.x);
        normal.z += (p0.x - p1.x) * (p0.y + p1.y);
    }
    
    return normal.normalize();
}

/**
 * Compute signed area of polygon projected onto plane with given normal
 */
function computeSignedArea(points, normal) {
    const n = points.length;
    let area = 0;
    
    // Find the most significant component of the normal to choose projection plane
    const absNormal = new THREE.Vector3(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
    let maxComponent = 0; // 0=x, 1=y, 2=z
    if (absNormal.y > absNormal.x) maxComponent = 1;
    if (absNormal.z > absNormal[maxComponent === 0 ? 'x' : 'y']) maxComponent = 2;
    
    // Project to 2D and compute signed area
    for (let i = 0; i < n; i++) {
        const p0 = points[i];
        const p1 = points[(i + 1) % n];
        
        let u0, v0, u1, v1;
        if (maxComponent === 0) {
            u0 = p0.y; v0 = p0.z; u1 = p1.y; v1 = p1.z;
        } else if (maxComponent === 1) {
            u0 = p0.z; v0 = p0.x; u1 = p1.z; v1 = p1.x;
        } else {
            u0 = p0.x; v0 = p0.y; u1 = p1.x; v1 = p1.y;
        }
        
        area += (u0 * v1 - u1 * v0);
    }
    
    return area * 0.5;
}

/**
 * Simple fan triangulation from first vertex
 */
function triangulateFan(solid, faceName, points, minArea) {
    const n = points.length;
    if (n < 3) return 0;
    
    let count = 0;
    const p0 = points[0];
    
    for (let i = 1; i < n - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        
        const area = computeTriangleArea(p0, p1, p2);
        if (area > minArea) {
            solid.addTriangle(faceName, vToArr(p0), vToArr(p1), vToArr(p2));
            count++;
        }
    }
    
    return count;
}

/**
 * Centroid-based triangulation (good for convex polygons)
 */
function triangulateCentroid(solid, faceName, points, minArea) {
    const n = points.length;
    if (n < 3) return 0;
    
    // Compute centroid
    const centroid = new THREE.Vector3();
    for (const point of points) {
        centroid.add(point);
    }
    centroid.multiplyScalar(1 / n);
    
    let count = 0;
    for (let i = 0; i < n; i++) {
        const p0 = points[i];
        const p1 = points[(i + 1) % n];
        
        const area = computeTriangleArea(centroid, p0, p1);
        if (area > minArea) {
            solid.addTriangle(faceName, vToArr(centroid), vToArr(p0), vToArr(p1));
            count++;
        }
    }
    
    return count;
}

/**
 * Ear clipping triangulation (handles non-convex polygons)
 */
function triangulateEarcut(solid, faceName, points, normal, minArea) {
    const n = points.length;
    if (n < 3) return 0;
    
    // Simple ear clipping implementation
    const vertices = [...points];
    let count = 0;
    
    while (vertices.length > 3) {
        let earFound = false;
        
        for (let i = 0; i < vertices.length; i++) {
            const p0 = vertices[(i - 1 + vertices.length) % vertices.length];
            const p1 = vertices[i];
            const p2 = vertices[(i + 1) % vertices.length];
            
            if (isEar(vertices, i, normal)) {
                const area = computeTriangleArea(p0, p1, p2);
                if (area > minArea) {
                    solid.addTriangle(faceName, vToArr(p0), vToArr(p1), vToArr(p2));
                    count++;
                }
                vertices.splice(i, 1);
                earFound = true;
                break;
            }
        }
        
        if (!earFound) {
            // Fallback to fan triangulation if ear clipping fails
            console.warn('generateEndcapFaces: ear clipping failed, falling back to fan');
            return count + triangulateFan(solid, faceName, vertices, minArea);
        }
    }
    
    // Add final triangle
    if (vertices.length === 3) {
        const area = computeTriangleArea(vertices[0], vertices[1], vertices[2]);
        if (area > minArea) {
            solid.addTriangle(faceName, vToArr(vertices[0]), vToArr(vertices[1]), vToArr(vertices[2]));
            count++;
        }
    }
    
    return count;
}

/**
 * Check if vertex at index i is an ear (convex and contains no other vertices)
 */
function isEar(vertices, i, normal) {
    const n = vertices.length;
    const p0 = vertices[(i - 1 + n) % n];
    const p1 = vertices[i];
    const p2 = vertices[(i + 1) % n];
    
    // Check if angle is convex
    const v1 = new THREE.Vector3().subVectors(p0, p1);
    const v2 = new THREE.Vector3().subVectors(p2, p1);
    const cross = new THREE.Vector3().crossVectors(v1, v2);
    
    if (cross.dot(normal) <= 0) return false; // Not convex
    
    // Check if any other vertex is inside the triangle
    for (let j = 0; j < n; j++) {
        if (j === (i - 1 + n) % n || j === i || j === (i + 1) % n) continue;
        if (isPointInTriangle(vertices[j], p0, p1, p2)) return false;
    }
    
    return true;
}

/**
 * Test if point is inside triangle using barycentric coordinates
 */
function isPointInTriangle(point, a, b, c) {
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

/**
 * Compute triangle area using cross product
 */
function computeTriangleArea(p0, p1, p2) {
    const v1 = new THREE.Vector3().subVectors(p1, p0);
    const v2 = new THREE.Vector3().subVectors(p2, p0);
    return v1.cross(v2).length() * 0.5;
}

// Remove triangles with area below the tolerance and rebuild supporting arrays.
export function removeDegenerateTrianglesAuthoring(solid, areaEps = 1e-12) {
    const vp = solid._vertProperties;
    const tv = solid._triVerts;
    const ids = solid._triIDs;
    const triCount = (tv.length / 3) | 0;
    if (triCount === 0) return 0;
    const keep = new Uint8Array(triCount);
    let removed = 0;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
        const i0 = tv[t * 3 + 0] * 3;
        const i1 = tv[t * 3 + 1] * 3;
        const i2 = tv[t * 3 + 2] * 3;
        A.set(vp[i0 + 0], vp[i0 + 1], vp[i0 + 2]);
        B.set(vp[i1 + 0], vp[i1 + 1], vp[i1 + 2]);
        C.set(vp[i2 + 0], vp[i2 + 1], vp[i2 + 2]);
        const area = B.clone().sub(A).cross(C.clone().sub(A)).length() * 0.5;
        if (Number.isFinite(area) && area > areaEps) keep[t] = 1; else removed++;
    }
    if (removed === 0) return 0;
    const used = new Uint8Array((vp.length / 3) | 0);
    const newTriVerts = [];
    const newTriIDs = [];
    for (let t = 0; t < triCount; t++) {
        if (!keep[t]) continue;
        const a = tv[t * 3 + 0] >>> 0;
        const b = tv[t * 3 + 1] >>> 0;
        const c = tv[t * 3 + 2] >>> 0;
        newTriVerts.push(a, b, c);
        if (ids) newTriIDs.push(ids[t]);
        used[a] = 1; used[b] = 1; used[c] = 1;
    }
    const oldToNew = new Int32Array((vp.length / 3) | 0);
    for (let i = 0; i < oldToNew.length; i++) oldToNew[i] = -1;
    const newVP = [];
    let w = 0;
    for (let i = 0; i < used.length; i++) {
        if (!used[i]) continue;
        const j = i * 3;
        newVP.push(vp[j + 0], vp[j + 1], vp[j + 2]);
        oldToNew[i] = w++;
    }
    for (let k = 0; k < newTriVerts.length; k++) newTriVerts[k] = oldToNew[newTriVerts[k]];
    solid._vertProperties = newVP;
    solid._triVerts = newTriVerts;
    solid._triIDs = ids ? newTriIDs : null;
    solid._vertKeyToIndex = new Map();
    for (let i = 0; i < newVP.length; i += 3) {
        solid._vertKeyToIndex.set(`${newVP[i]},${newVP[i + 1]},${newVP[i + 2]}`, (i / 3) | 0);
    }
    solid._dirty = true;
    solid._faceIndex = null;
    solid.fixTriangleWindingsByAdjacency();
    return removed;
}

// Snap authoring vertices to a 3D grid and rebuild lookup tables.
export function quantizeVerticesAuthoring(solid, q = 1e-6) {
    if (!(q > 0)) return 0;
    const vp = solid._vertProperties;
    let changes = 0;
    for (let i = 0; i < vp.length; i++) {
        const v = vp[i];
        const snapped = Math.round(v / q) * q;
        if (snapped !== v) { vp[i] = snapped; changes++; }
    }
    if (changes) {
        solid._vertKeyToIndex = new Map();
        for (let i = 0; i < vp.length; i += 3) {
            const x = vp[i + 0], y = vp[i + 1], z = vp[i + 2];
            solid._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }
        solid._dirty = true;
        solid._faceIndex = null;
        solid.fixTriangleWindingsByAdjacency();
    }
    return (changes / 3) | 0;
}
