import * as THREE from 'three';
import { removeDegenerateTrianglesAuthoring, quantizeVerticesAuthoring } from './common.js';

// Shared scratch vectors to reduce allocations in tight loops
const __vAB = new THREE.Vector3();
const __vAC = new THREE.Vector3();
const __vAP = new THREE.Vector3();
const __vBP = new THREE.Vector3();
const __vCP = new THREE.Vector3();
const __vCB = new THREE.Vector3();
const __tmp1 = new THREE.Vector3();
const __tmp2 = new THREE.Vector3();
const __tmp3 = new THREE.Vector3();
const __tmp4 = new THREE.Vector3();
const __tmp5 = new THREE.Vector3();
const __tmp6 = new THREE.Vector3();
const __projOut = new THREE.Vector3();

function getScaleAdaptiveTolerance(radius, baseEpsilon = 1e-12) {
    return Math.max(baseEpsilon, baseEpsilon * Math.abs(radius));
}

function getDistanceTolerance(radius) {
    return Math.max(1e-9, 1e-6 * Math.abs(radius));
}

function getAngleTolerance() {
    return 1e-6; // radians, roughly 0.00006 degrees
}

// Spatial hash grid for fast triangle lookup
class TriangleSpatialIndex {
    constructor(triangleData, cellSize = null) {
        this.triangleData = triangleData;
        this.grid = new Map();
        
        if (!triangleData || triangleData.length === 0) return;
        
        // Auto-calculate cell size if not provided (use average triangle bounding radius)
        if (cellSize === null) {
            const avgRad = triangleData.reduce((sum, d) => sum + (d.rad || 0), 0) / triangleData.length;
            cellSize = Math.max(avgRad * 2, 1e-6); // Ensure minimum cell size
        }
        this.cellSize = cellSize;
        this.invCellSize = 1.0 / cellSize;
        
        // Populate grid
        for (let i = 0; i < triangleData.length; i++) {
            const data = triangleData[i];
            const cells = this.getTriangleCells(data);
            for (const cellKey of cells) {
                if (!this.grid.has(cellKey)) {
                    this.grid.set(cellKey, []);
                }
                this.grid.get(cellKey).push(i);
            }
        }
    }
    
    getCellKey(x, y, z) {
        const ix = Math.floor(x * this.invCellSize);
        const iy = Math.floor(y * this.invCellSize);
        const iz = Math.floor(z * this.invCellSize);
        return `${ix},${iy},${iz}`;
    }
    
    getTriangleCells(triangleData) {
        const { cx, cy, cz, rad } = triangleData;
        const cells = new Set();
        
        // Get all cells that the triangle's bounding sphere intersects
        const minX = (cx - rad) * this.invCellSize;
        const maxX = (cx + rad) * this.invCellSize;
        const minY = (cy - rad) * this.invCellSize;
        const maxY = (cy + rad) * this.invCellSize;
        const minZ = (cz - rad) * this.invCellSize;
        const maxZ = (cz + rad) * this.invCellSize;
        
        for (let ix = Math.floor(minX); ix <= Math.floor(maxX); ix++) {
            for (let iy = Math.floor(minY); iy <= Math.floor(maxY); iy++) {
                for (let iz = Math.floor(minZ); iz <= Math.floor(maxZ); iz++) {
                    cells.add(`${ix},${iy},${iz}`);
                }
            }
        }
        return cells;
    }
    
    getNearbyTriangles(point, maxDistance = Infinity) {
        const { x, y, z } = point;
        const cellKey = this.getCellKey(x, y, z);
        const triangleIndices = this.grid.get(cellKey) || [];
        
        // If we need a larger search radius, check neighboring cells
        if (maxDistance < Infinity && triangleIndices.length === 0) {
            const searchRadius = Math.ceil(maxDistance * this.invCellSize);
            const ix0 = Math.floor(x * this.invCellSize);
            const iy0 = Math.floor(y * this.invCellSize);
            const iz0 = Math.floor(z * this.invCellSize);
            
            const nearbyIndices = new Set();
            for (let ix = ix0 - searchRadius; ix <= ix0 + searchRadius; ix++) {
                for (let iy = iy0 - searchRadius; iy <= iy0 + searchRadius; iy++) {
                    for (let iz = iz0 - searchRadius; iz <= iz0 + searchRadius; iz++) {
                        const key = `${ix},${iy},${iz}`;
                        const indices = this.grid.get(key);
                        if (indices) {
                            for (const idx of indices) nearbyIndices.add(idx);
                        }
                    }
                }
            }
            return Array.from(nearbyIndices);
        }
        
        return triangleIndices;
    }
}

// Enhanced per-face triangle data cache with spatial indexing
// Keyed by face name for better cache consistency across remeshing
const __FACE_DATA_CACHE = new Map();
const __SPATIAL_INDEX_CACHE = new Map();
const MAX_CACHE_SIZE = 100; // Prevent unbounded growth

function getCachedFaceDataForTris(tris, faceKey = null) {
    if (!Array.isArray(tris) || tris.length === 0) return [];
    
    // Use face key if provided, otherwise fall back to array instance
    const cacheKey = faceKey || tris;
    const existing = __FACE_DATA_CACHE.get(cacheKey);
    if (existing) return existing;
    
    // Implement LRU cache eviction
    if (__FACE_DATA_CACHE.size >= MAX_CACHE_SIZE) {
        const firstKey = __FACE_DATA_CACHE.keys().next().value;
        __FACE_DATA_CACHE.delete(firstKey);
        __SPATIAL_INDEX_CACHE.delete(firstKey);
    }
    
    const a = __tmp1, b = __tmp2, c = __tmp3;
    const ab = __tmp4, ac = __tmp5, n = __tmp6;
    
    const faceData = tris.map(t => {
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        const cx = (a.x + b.x + c.x) / 3;
        const cy = (a.y + b.y + c.y) / 3;
        const cz = (a.z + b.z + c.z) / 3;
        
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        n.crossVectors(ab, ac);
        const len = n.length();
        if (len < getScaleAdaptiveTolerance(1.0, 1e-14)) return null;
        n.multiplyScalar(1 / len);
        
        // Bounding radius from centroid that encloses the triangle
        const dxA = a.x - cx, dyA = a.y - cy, dzA = a.z - cz;
        const dxB = b.x - cx, dyB = b.y - cy, dzB = b.z - cz;
        const dxC = c.x - cx, dyC = c.y - cy, dzC = c.z - cz;
        const rA2 = dxA * dxA + dyA * dyA + dzA * dzA;
        const rB2 = dxB * dxB + dyB * dyB + dzB * dzB;
        const rC2 = dxC * dxC + dyC * dyC + dzC * dzC;
        const rad = Math.sqrt(Math.max(rA2, rB2, rC2));
        return { cx, cy, cz, rad, normal: n.clone(), triangle: t };
    }).filter(Boolean);
    
    __FACE_DATA_CACHE.set(cacheKey, faceData);
    return faceData;
}

function getCachedSpatialIndex(faceData, faceKey = null) {
    const cacheKey = faceKey || faceData;
    let spatialIndex = __SPATIAL_INDEX_CACHE.get(cacheKey);
    if (!spatialIndex && faceData && faceData.length > 0) {
        spatialIndex = new TriangleSpatialIndex(faceData);
        __SPATIAL_INDEX_CACHE.set(cacheKey, spatialIndex);
    }
    return spatialIndex;
}

// Cache management utilities for memory efficiency
function clearFilletCaches() {
    __FACE_DATA_CACHE.clear();
    __SPATIAL_INDEX_CACHE.clear();
}

function trimFilletCaches() {
    // Keep only the most recently used entries if caches are getting large
    if (__FACE_DATA_CACHE.size > MAX_CACHE_SIZE * 2) {
        const keysToDelete = [];
        let count = 0;
        for (const key of __FACE_DATA_CACHE.keys()) {
            if (count++ > MAX_CACHE_SIZE) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => {
            __FACE_DATA_CACHE.delete(key);
            __SPATIAL_INDEX_CACHE.delete(key);
        });
    }
}

function arrToV(p) { return new THREE.Vector3(p[0], p[1], p[2]); }
function vToArr(v) { return [v.x, v.y, v.z]; }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function isFiniteVec3(v) {
    return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function projectPerp(v, axis) {
    // Return component of v orthogonal to axis; ensure non-degenerate
    const res = v.addScaledVector(axis, -v.dot(axis));
    if (res.lengthSq() < 1e-12) {
        // choose a stable perpendicular
        const tmp = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        res.copy(tmp.sub(axis.clone().multiplyScalar(tmp.dot(axis))));
    }
    return res.normalize();
}

function projectPointOntoFaceTriangles(tris, point, faceData = null, faceKey = null) {
    if (!Array.isArray(tris) || tris.length === 0) return point.clone();
    
    // Acquire face data and spatial index (precomputed if possible)
    const data = faceData && Array.isArray(faceData) ? faceData : getCachedFaceDataForTris(tris, faceKey);
    if (!data || data.length === 0) return point.clone();
    
    const spatialIndex = getCachedSpatialIndex(data, faceKey);
    let best = null;
    
    // Use scratch vectors to reduce allocations
    const a = __tmp1, b = __tmp2, c = __tmp3;
    const qVec = __projOut;
    
    if (spatialIndex) {
        // Spatial index approach: get nearby triangles first
        const nearbyIndices = spatialIndex.getNearbyTriangles(point);
        
        // If spatial lookup gives us candidates, process them
        if (nearbyIndices.length > 0) {
            // Process nearby triangles first (most likely candidates)
            for (const idx of nearbyIndices) {
                if (idx >= data.length) continue; // Safety check
                const d = data[idx];
                const t = d.triangle;
                a.set(t.p1[0], t.p1[1], t.p1[2]);
                b.set(t.p2[0], t.p2[1], t.p2[2]);
                c.set(t.p3[0], t.p3[1], t.p3[2]);
                closestPointOnTriangleToOut(point, a, b, c, qVec);
                const d2 = qVec.distanceToSquared(point);
                if (!best || d2 < best.d2) {
                    best = { d2, q: qVec.clone() };
                }
            }
            
            // If we found a good candidate and we have many triangles, 
            // do selective culling on remaining triangles
            if (best && data.length > 64) {
                const bestDist = Math.sqrt(best.d2);
                const visitedSet = new Set(nearbyIndices);
                
                for (let i = 0; i < data.length; i++) {
                    if (visitedSet.has(i)) continue; // Skip already processed
                    
                    const d = data[i];
                    const dx = d.cx - point.x, dy = d.cy - point.y, dz = d.cz - point.z;
                    const centerDist2 = dx * dx + dy * dy + dz * dz;
                    const rad = d.rad || 0;
                    
                    // Cull triangles that cannot possibly beat current best
                    const threshold = bestDist + rad;
                    if (centerDist2 > threshold * threshold) continue;
                    
                    const t = d.triangle;
                    a.set(t.p1[0], t.p1[1], t.p1[2]);
                    b.set(t.p2[0], t.p2[1], t.p2[2]);
                    c.set(t.p3[0], t.p3[1], t.p3[2]);
                    closestPointOnTriangleToOut(point, a, b, c, qVec);
                    const d2 = qVec.distanceToSquared(point);
                    if (d2 < best.d2) {
                        best = { d2, q: qVec.clone() };
                    }
                }
            }
        } else {
            // No nearby triangles found in spatial index, fall back to distance-based culling
            // This can happen when the point is outside the face bounds
            const candidates = [];
            for (let i = 0; i < data.length; i++) {
                const d = data[i];
                const dx = d.cx - point.x, dy = d.cy - point.y, dz = d.cz - point.z;
                candidates.push({ d2: dx * dx + dy * dy + dz * dz, idx: i });
            }
            candidates.sort((a, b) => a.d2 - b.d2);
            
            // Process first 16 closest centroids
            const maxCandidates = Math.min(16, candidates.length);
            for (let i = 0; i < maxCandidates; i++) {
                const d = data[candidates[i].idx];
                const t = d.triangle;
                a.set(t.p1[0], t.p1[1], t.p1[2]);
                b.set(t.p2[0], t.p2[1], t.p2[2]);
                c.set(t.p3[0], t.p3[1], t.p3[2]);
                closestPointOnTriangleToOut(point, a, b, c, qVec);
                const d2 = qVec.distanceToSquared(point);
                if (!best || d2 < best.d2) {
                    best = { d2, q: qVec.clone() };
                }
            }
        }
    } else {
        // Fallback to original algorithm if no spatial index
        const K = Math.min(16, data.length); // Reduced K for better performance
        const candidates = [];
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const dx = d.cx - point.x, dy = d.cy - point.y, dz = d.cz - point.z;
            candidates.push({ d2: dx * dx + dy * dy + dz * dz, data: d });
        }
        candidates.sort((a, b) => a.d2 - b.d2);
        
        for (let i = 0; i < K; i++) {
            const t = candidates[i].data.triangle;
            a.set(t.p1[0], t.p1[1], t.p1[2]);
            b.set(t.p2[0], t.p2[1], t.p2[2]);
            c.set(t.p3[0], t.p3[1], t.p3[2]);
            closestPointOnTriangleToOut(point, a, b, c, qVec);
            const d2 = qVec.distanceToSquared(point);
            if (!best || d2 < best.d2) {
                best = { d2, q: qVec.clone() };
            }
        }
    }
    
    return best ? best.q : point.clone();
}

// Batch projection for better performance - processes multiple points at once
// to amortize spatial index setup and reduce allocation overhead
function batchProjectPointsOntoFace(tris, points, faceData = null, faceKey = null) {
    if (!Array.isArray(points) || points.length === 0) return [];
    if (!Array.isArray(tris) || tris.length === 0) return points.map(p => p.clone());
    
    // Get cached face data and spatial index once for all points
    const data = faceData && Array.isArray(faceData) ? faceData : getCachedFaceDataForTris(tris, faceKey);
    if (!data || data.length === 0) return points.map(p => p.clone());
    
    const spatialIndex = getCachedSpatialIndex(data, faceKey);
    const results = new Array(points.length);
    
    // Use shared scratch vectors for all projections
    const a = __tmp1, b = __tmp2, c = __tmp3;
    const qVec = __projOut;
    
    if (spatialIndex) {
        // Process points in batches to get better spatial locality
        const batchSize = Math.min(32, points.length);
        
        for (let batchStart = 0; batchStart < points.length; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, points.length);
            
            // For each point in this batch
            for (let i = batchStart; i < batchEnd; i++) {
                const point = points[i];
                const nearbyIndices = spatialIndex.getNearbyTriangles(point);
                let best = null;
                
                if (nearbyIndices.length > 0) {
                    // Check nearby triangles first
                    for (const idx of nearbyIndices) {
                        if (idx >= data.length) continue;
                        const d = data[idx];
                        const t = d.triangle;
                        a.set(t.p1[0], t.p1[1], t.p1[2]);
                        b.set(t.p2[0], t.p2[1], t.p2[2]);
                        c.set(t.p3[0], t.p3[1], t.p3[2]);
                        closestPointOnTriangleToOut(point, a, b, c, qVec);
                        const d2 = qVec.distanceToSquared(point);
                        if (!best || d2 < best.d2) {
                            best = { d2, q: qVec.clone() };
                        }
                    }
                } else {
                    // Fallback: find closest few centroids
                    let minDist2 = Infinity;
                    let closestIdx = -1;
                    for (let j = 0; j < Math.min(8, data.length); j++) {
                        const d = data[j];
                        const dx = d.cx - point.x, dy = d.cy - point.y, dz = d.cz - point.z;
                        const dist2 = dx * dx + dy * dy + dz * dz;
                        if (dist2 < minDist2) {
                            minDist2 = dist2;
                            closestIdx = j;
                        }
                    }
                    
                    if (closestIdx >= 0) {
                        const d = data[closestIdx];
                        const t = d.triangle;
                        a.set(t.p1[0], t.p1[1], t.p1[2]);
                        b.set(t.p2[0], t.p2[1], t.p2[2]);
                        c.set(t.p3[0], t.p3[1], t.p3[2]);
                        closestPointOnTriangleToOut(point, a, b, c, qVec);
                        best = { d2: qVec.distanceToSquared(point), q: qVec.clone() };
                    }
                }
                
                results[i] = best ? best.q : point.clone();
            }
        }
    } else {
        // Fallback without spatial index - still better than individual calls
        // because we reuse the face data
        for (let i = 0; i < points.length; i++) {
            results[i] = projectPointOntoFaceTriangles(tris, points[i], data, faceKey);
        }
    }
    
    return results;
}


// Output-parameter version to avoid allocating new vectors per call
function closestPointOnTriangleToOut(P, A, B, C, out) {
    // Adapted from Real-Time Collision Detection (Christer Ericson)
    const AB = __vAB.subVectors(B, A);
    const AC = __vAC.subVectors(C, A);
    const AP = __vAP.subVectors(P, A);

    const d1 = AB.dot(AP);
    const d2 = AC.dot(AP);
    if (d1 <= 0 && d2 <= 0) { out.copy(A); return out; }

    const BP = __vBP.subVectors(P, B);
    const d3 = AB.dot(BP);
    const d4 = AC.dot(BP);
    if (d3 >= 0 && d4 <= d3) { out.copy(B); return out; }

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        out.copy(A).addScaledVector(AB, v); return out;
    }

    const CP = __vCP.subVectors(P, C);
    const d5 = AB.dot(CP);
    const d6 = AC.dot(CP);
    if (d6 >= 0 && d5 <= d6) { out.copy(C); return out; }

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        out.copy(A).addScaledVector(AC, w); return out;
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        out.copy(B).addScaledVector(__vCB.subVectors(C, B), w); return out;
    }

    // Inside face region. Compute barycentric coordinates (u,v,w) and return
    const denom = 1 / (AB.dot(AB) * AC.dot(AC) - Math.pow(AB.dot(AC), 2));
    const v = (AC.dot(AC) * AB.dot(AP) - AB.dot(AC) * AC.dot(AP)) * denom;
    const w = (AB.dot(AB) * AC.dot(AP) - AB.dot(AC) * AB.dot(AP)) * denom;
    out.copy(A).addScaledVector(AB, v).addScaledVector(AC, w); return out;
}

// Approximate local face normal at a point using the nearest triangle of tris
function normalFromFaceTriangles(tris, point) {
    if (!Array.isArray(tris) || tris.length === 0) return new THREE.Vector3(0, 1, 0);
    const P = point.clone();
    let best = null;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const qVec = new THREE.Vector3();

    const data = getCachedFaceDataForTris(tris);
    const K = 32;
    if (data && data.length) {
        const pairs = new Array(data.length);
        for (let i = 0; i < data.length; i++) {
            const d = data[i];
            const dx = d.cx - P.x, dy = d.cy - P.y, dz = d.cz - P.z;
            pairs[i] = { d2: dx * dx + dy * dy + dz * dz, data: d };
        }
        pairs.sort((x, y) => x.d2 - y.d2);
        const N = Math.min(K, pairs.length);
        for (let i = 0; i < N; i++) {
            const d = pairs[i].data;
            const t = d.triangle;
            a.set(t.p1[0], t.p1[1], t.p1[2]);
            b.set(t.p2[0], t.p2[1], t.p2[2]);
            c.set(t.p3[0], t.p3[1], t.p3[2]);
            closestPointOnTriangleToOut(P, a, b, c, qVec);
            const d2 = qVec.distanceToSquared(P);
            if (!best || d2 < best.d2) best = { d2, normal: d.normal };
        }
        // Safe prune and refine using centroid-radius bound
        const bestDist = best ? Math.sqrt(best.d2) : Infinity;
        for (let i = N; i < pairs.length; i++) {
            const d = pairs[i].data;
            const rad = d.rad || 0;
            const threshold2 = (bestDist + rad) * (bestDist + rad);
            if (pairs[i].d2 > threshold2) continue;
            const t = d.triangle;
            a.set(t.p1[0], t.p1[1], t.p1[2]);
            b.set(t.p2[0], t.p2[1], t.p2[2]);
            c.set(t.p3[0], t.p3[1], t.p3[2]);
            closestPointOnTriangleToOut(P, a, b, c, qVec);
            const d2 = qVec.distanceToSquared(P);
            if (!best || d2 < best.d2) best = { d2, normal: d.normal };
        }
        return best ? best.normal : new THREE.Vector3(0, 1, 0);
    }

    // Fallback brute force
    for (const t of tris) {
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        closestPointOnTriangleToOut(P, a, b, c, qVec);
        const d2 = qVec.distanceToSquared(P);
        if (!best || d2 < best.d2) best = { d2, normal: new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize() };
    }
    return best ? best.normal : new THREE.Vector3(0, 1, 0);
}

// Push each point of a polyline slightly inward along the face normal to avoid
// exact coplanarity that can cause CSG residue.
function insetPolylineAlongFaceNormals(tris, points, amount) {
    if (!Array.isArray(points)) return points;
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const n = normalFromFaceTriangles(tris, p);
        out[i] = p.clone().addScaledVector(n, -amount); // inward (opposite face normal)
    }
    return out;
}

// Remove near-degenerate triangles (area < eps) from the authoring arrays of a Solid.
// Rebuilds compacted arrays and remaps vertex indices. Returns number removed.
// Sample a grid of points spanning the side strip between the original edge
// rail and the projected fillet seam on a face. Returns an array of rows, each
// containing `widthSubdiv+1` vertices ordered from rail (k=0) to seam (k=W).
function computeSideStripRows(railP, seam, closeLoop, tris, widthSubdiv = 8, inset = 0, extraOffset = 0, project = true) {
    const faceData = getCachedFaceDataForTris(tris);
    const n = Math.min(railP.length, seam.length);
    if (n < 2) return null;
    const W = Math.max(1, widthSubdiv);
    const rows = new Array(n);

    for (let i = 0; i < n; i++) {
        const Pi = railP[i];
        const Si = seam[i];
        const row = new Array(W + 1);
        for (let k = 0; k <= W; k++) {
            const t = k / W;
            if (k === 0) {
                row[k] = Pi.clone();
                continue;
            }
            if (k === W) {
                row[k] = Si.clone();
                continue;
            }
            const v = new THREE.Vector3(
                Pi.x + (Si.x - Pi.x) * t,
                Pi.y + (Si.y - Pi.y) * t,
                Pi.z + (Si.z - Pi.z) * t,
            );
            if (project) {
                let q = projectPointOntoFaceTriangles(tris, v, faceData);
                const nrm = normalFromFaceTriangles(tris, q);
                let move = 0;
                if (Number.isFinite(extraOffset) && extraOffset !== 0) move += extraOffset;
                if (inset > 0) move -= inset;
                if (move !== 0 && nrm) q = q.addScaledVector(nrm, move);
                row[k] = q;
            } else {
                row[k] = v;
            }
        }
        rows[i] = row;
    }

    return rows;
}

// Build a side strip between the P-rail and the seam on a source face.
// Accepts precomputed rows to maintain consistency with other consumers (e.g.,
// end-cap construction) and avoids introducing new seam vertices that could
// create T junctions.
function buildSideStripOnFace(solid, faceName, railP, seam, closeLoop, tris, widthSubdiv = 8, inset = 0, extraOffset = 0, endOvershoot = 0, project = true, precomputedRows = null) {
    const faceData = getCachedFaceDataForTris(tris);
    let baseRows = null;
    if (Array.isArray(precomputedRows) && precomputedRows.length >= 2) {
        baseRows = precomputedRows;
    } else {
        baseRows = computeSideStripRows(railP, seam, closeLoop, tris, widthSubdiv, inset, extraOffset, project);
    }
    if (!Array.isArray(baseRows) || baseRows.length < 2) return;

    const rows = baseRows.map(row => row.slice());
    const W = Math.max(1, (rows[0]?.length || 1) - 1);

    if (!closeLoop && endOvershoot > 0) {
        const extendRow = (rowBase, rowNext, sign) => {
            const dir = new THREE.Vector3();
            if (rowNext && rowBase) {
                dir.copy(rowBase[0]).sub(rowNext[0]);
            }
            if (dir.lengthSq() < 1e-20) {
                for (let k = 0; k <= W; k++) {
                    const a = rowBase[k], b = rowNext[k];
                    if (!a || !b) continue;
                    dir.add(new THREE.Vector3().subVectors(a, b));
                }
            }
            if (dir.lengthSq() < 1e-20) return null;
            dir.normalize().multiplyScalar(sign * endOvershoot);
            const out = new Array(W + 1);
            for (let k = 0; k <= W; k++) {
                let p = (rowBase[k] || rowBase[0]).clone().add(dir);
                if (project) {
                    p = projectPointOntoFaceTriangles(tris, p, faceData);
                    const nrm = normalFromFaceTriangles(tris, p);
                    let move = 0;
                    if (Number.isFinite(extraOffset) && extraOffset !== 0) move += extraOffset;
                    if (inset > 0) move -= inset;
                    if (move !== 0 && nrm) p.addScaledVector(nrm, move);
                }
                out[k] = p;
            }
            return out;
        };

        const row0 = rows[0];
        const row1 = rows[1];
        const startExt = extendRow(row0, row1, +1);
        if (startExt) rows.unshift(startExt);

        const rowN1 = rows[rows.length - 1];
        const rowN2 = rows[rows.length - 2];
        const endExt = extendRow(rowN1, rowN2, +1);
        if (endExt) rows.push(endExt);
    }

    const emitQuad = (iA, iB) => {
        const rowA = rows[iA];
        const rowB = rows[iB];
        const isStartEdge = (iA === 0);
        const isEndEdge = (iB === rows.length - 1);
        for (let k = 0; k < W; k++) {
            const a0 = rowA[k];
            const a1 = rowA[k + 1];
            const b0 = rowB[k];
            const b1 = rowB[k + 1];
            const triArea2 = (p, q, r) => {
                const ux = q.x - p.x, uy = q.y - p.y, uz = q.z - p.z;
                const vx = r.x - p.x, vy = r.y - p.y, vz = r.z - p.z;
                const nx = uy * vz - uz * vy;
                const ny = uz * vx - ux * vz;
                const nz = ux * vy - uy * vx;
                return nx * nx + ny * ny + nz * nz;
            };
            const pushIfArea = (p, q, r) => {
                if (triArea2(p, q, r) > 1e-32) solid.addTriangle(faceName, vToArr(p), vToArr(q), vToArr(r));
            };
            // Areas for both diagonal choices
            const A1 = triArea2(a0, b0, b1); // pair 1, tri (a0,b0,b1)
            const A2 = triArea2(a0, b1, a1); // pair 1, tri (a0,b1,a1) includes edge (a0,a1)
            const B1 = triArea2(a0, b0, a1); // pair 2, tri (a0,b0,a1)
            const B2 = triArea2(a1, b0, b1); // pair 2, tri (a1,b0,b1) includes edge (b0,b1)

            // Prefer the diagonal that creates boundary-aligned edges so the
            // cap can share those exact edges and avoid T junctions.
            let choosePair = 0; // 0 => pair A (A1+A2), 1 => pair B (B1+B2)
            if (isStartEdge) {
                // Need edge (a0,a1) to exist on the side strip at the start end
                // This edge appears in triangle (a0,b1,a1) => pair A
                choosePair = 0;
            } else if (isEndEdge) {
                // Need edge (b0,b1) to exist on the side strip at the end end
                // This edge appears in triangle (a1,b0,b1) => pair B
                choosePair = 1;
            } else {
                // Interior: pick the more stable diagonal (maximize min area)
                const minA = Math.min(A1, A2);
                const minB = Math.min(B1, B2);
                choosePair = (minA >= minB) ? 0 : 1;
            }

            if (choosePair === 0) {
                pushIfArea(a0, b0, b1);
                pushIfArea(a0, b1, a1);
            } else {
                pushIfArea(a0, b0, a1);
                pushIfArea(a1, b0, b1);
            }
        }
    };

    for (let i = 0; i < rows.length - 1; i++) emitQuad(i, i + 1);
    if (closeLoop && rows.length > 2) emitQuad(rows.length - 1, 0);
}

// --- Debug utility: verify that a side strip contains all consecutive
// edges along a provided boundary row. Returns an array of missing segments.
function validateCapStripSeam(solid, sideFaceName, boundaryRow, capFaceName) {
    if (!Array.isArray(boundaryRow) || boundaryRow.length < 2) return [];
    const id = solid._faceNameToID?.get(sideFaceName);
    if (id === undefined || id === null) return [];
    const tv = solid._triVerts || [];
    const fid = solid._triIDs || [];
    const edgeSet = new Set();
    const addEdge = (i, j) => {
        const a = Math.min(i, j), b = Math.max(i, j);
        edgeSet.add(a + ':' + b);
    };
    for (let t = 0; t < tv.length; t += 3) {
        const face = fid ? fid[(t / 3) | 0] : undefined;
        if (face !== id) continue;
        const i0 = tv[t] >>> 0, i1 = tv[t + 1] >>> 0, i2 = tv[t + 2] >>> 0;
        addEdge(i0, i1); addEdge(i1, i2); addEdge(i2, i0);
    }
    const keyToIndex = solid._vertKeyToIndex || new Map();
    const idxOf = (p) => keyToIndex.get(`${p.x},${p.y},${p.z}`);
    const missing = [];
    for (let k = 0; k < boundaryRow.length - 1; k++) {
        const a = boundaryRow[k];
        const b = boundaryRow[k + 1];
        const ia = idxOf(a); const ib = idxOf(b);
        if (ia === undefined || ib === undefined) { missing.push({ k, reason: 'vertex_not_found' }); continue; }
        const key = (Math.min(ia, ib)) + ':' + (Math.max(ia, ib));
        if (!edgeSet.has(key)) missing.push({ k, ia, ib, a: [a.x, a.y, a.z], b: [b.x, b.y, b.z] });
    }
    if (missing.length) {
        try { console.warn('[FilletSolid] Missing boundary edges on strip', { sideFaceName, capFaceName, count: missing.length, missing }); } catch { }
    }
    return missing;
}

// Displace the input P-rail along the average normals of the adjacent faces.
// Positive distance moves outward for INSET; OUTSET flips the sign.
function displaceRailPForInflate(railP, trisA, trisB, distance, sideMode = 'INSET') {
    const faceDataA = getCachedFaceDataForTris(trisA);
    const faceDataB = getCachedFaceDataForTris(trisB);
    const out = new Array(railP.length);
    const sign = (String(sideMode).toUpperCase() === 'INSET') ? +1 : -1;
    const d = Math.abs(Number(distance) || 0) * sign;
    for (let i = 0; i < railP.length; i++) {
        const p = railP[i];
        const qA = projectPointOntoFaceTriangles(trisA, p, faceDataA);
        const qB = projectPointOntoFaceTriangles(trisB, p, faceDataB);
        const nA = normalFromFaceTriangles(trisA, qA);
        const nB = normalFromFaceTriangles(trisB, qB);
        const n = new THREE.Vector3(nA.x + nB.x, nA.y + nB.y, nA.z + nB.z);
        if (n.lengthSq() > 1e-20) n.normalize(); else n.set(0, 0, 0);
        out[i] = p.clone().addScaledVector(n, d);
    }
    return out;
}

function averageFaceNormalObjectSpace(solid, faceName) {
    const tris = solid.getFace(faceName);
    if (!tris || !tris.length) return new THREE.Vector3(0, 1, 0);
    const accum = new THREE.Vector3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3();
    for (const t of tris) {
        a.set(t.p1[0], t.p1[1], t.p1[2]);
        b.set(t.p2[0], t.p2[1], t.p2[2]);
        c.set(t.p3[0], t.p3[1], t.p3[2]);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        // Use right-handed orientation: ab x ac
        accum.add(ab.clone().cross(ac));
    }
    if (accum.lengthSq() === 0) return new THREE.Vector3(0, 1, 0);
    return accum.normalize();
}

function localFaceNormalAtPoint(solid, faceName, p, faceData = null) {
    if (faceData) {
        // Use precomputed face data
        let best = null;
        for (const data of faceData) {
            const d = Math.abs(data.normal.dot(new THREE.Vector3().subVectors(p, new THREE.Vector3(data.cx, data.cy, data.cz))));
            if (!best || d < best.d) best = { d, n: data.normal };
        }
        return best ? best.n : null;
    }

    // Fallback to original implementation
    const tris = solid.getFace(faceName);
    if (!tris || !tris.length) return null;
    let best = null;
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3();
    const n = new THREE.Vector3();
    const centroid = new THREE.Vector3();

    // Precompute triangle data for faster processing
    const triangleData = tris.map(t => {
        pa.set(t.p1[0], t.p1[1], t.p1[2]);
        pb.set(t.p2[0], t.p2[1], t.p2[2]);
        pc.set(t.p3[0], t.p3[1], t.p3[2]);

        const ab = new THREE.Vector3().subVectors(pb, pa);
        const ac = new THREE.Vector3().subVectors(pc, pa);
        n.copy(ab).cross(ac);
        if (n.lengthSq() < 1e-14) return null;

        n.normalize();
        centroid.copy(pa).add(pb).add(pc).multiplyScalar(1 / 3);

        return { centroid: centroid.clone(), normal: n.clone(), triangle: t };
    }).filter(Boolean);

    // Find the triangle whose centroid is closest to the point
    for (const data of triangleData) {
        const d = Math.abs(data.normal.dot(new THREE.Vector3().subVectors(p, data.centroid)));
        if (!best || d < best.d) best = { d, n: data.normal };
    }

    return best ? best.n : null;
}

// (removed unused triangulateCapFan / triangulateCapToPoint)

function classifyFilletBoolean(nA, nB, polyLocal) {
    // Simple heuristic: use the bisector of projected directions at mid-edge and compare to outward average
    if (polyLocal.length < 2) return 'SUBTRACT';
    const midIdx = (polyLocal.length / 2) | 0;
    const p = arrToV(polyLocal[midIdx]);
    const pPrev = arrToV(polyLocal[Math.max(0, midIdx - 1)]);
    const pNext = arrToV(polyLocal[Math.min(polyLocal.length - 1, midIdx + 1)]);
    const t = new THREE.Vector3().subVectors(pNext, pPrev).normalize();
    const d0 = projectPerp(nA.clone().negate(), t);
    const d1 = projectPerp(nB.clone(), t);
    const bis = d0.clone().add(d1).normalize();
    const outwardAvg = nA.clone().add(nB).normalize();
    // If bisector points outward (roughly aligned with outward normals), fillet solid is outside -> subtract
    return (bis.dot(outwardAvg) >= 0) ? 'SUBTRACT' : 'UNION';
}

// (removed unused buildTubeFromCenterline)

// Build a single, watertight fillet wedge directly:
// - Curved fillet surface (arc rings lofted along the edge)
// - Two planar side strips from vertex rail P to arc start/end
// - End caps at first/last sections if the edge is open

export {
    getScaleAdaptiveTolerance,
    getDistanceTolerance,
    getAngleTolerance,
    getCachedFaceDataForTris,
    getCachedSpatialIndex,
    clearFilletCaches,
    trimFilletCaches,
    arrToV,
    vToArr,
    clamp,
    isFiniteVec3,
    projectPerp,
    projectPointOntoFaceTriangles,
    batchProjectPointsOntoFace,
    normalFromFaceTriangles,
    averageFaceNormalObjectSpace,
    localFaceNormalAtPoint,
    insetPolylineAlongFaceNormals,
    computeSideStripRows,
    buildSideStripOnFace,
    validateCapStripSeam,
    displaceRailPForInflate,
    classifyFilletBoolean,
};
