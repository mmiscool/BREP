# Endcap Face Generation Function

## Overview

The `generateEndcapFaces` function in `common.js` is used to create manifold meshes by triangulating boundary loops to generate endcap faces. This is essential for closing off open boundaries in mesh geometry, which is crucial for CSG operations and maintaining proper manifold topology.

## Function Signature

```javascript
generateEndcapFaces(solid, faceName, boundaryPoints, normal = null, options = {})
```

## Parameters

- **solid** (Object): The solid object that must have an `addTriangle(faceName, p1, p2, p3)` method
- **faceName** (string): Name/ID for the endcap face group
- **boundaryPoints** (Array): Ordered array of boundary loop vertices (Vector3 or [x,y,z] arrays)
- **normal** (THREE.Vector3, optional): Normal vector for orientation (auto-computed using Newell's method if not provided)
- **options** (Object, optional): Configuration options

## Options

- **minTriangleArea** (number, default: 1e-12): Minimum triangle area threshold
- **ensureCounterClockwise** (boolean, default: true): Ensure proper winding order
- **triangulationMethod** (string, default: 'fan'): Triangulation method - 'fan', 'earcut', or 'centroid'

## Triangulation Methods

1. **'fan'**: Simple fan triangulation from the first vertex (fast, works for convex polygons)
2. **'centroid'**: Triangulates from polygon centroid (good for convex shapes, creates more uniform triangles)  
3. **'earcut'**: Ear clipping algorithm (handles non-convex polygons, more robust but slower)

## Returns

Returns the number of triangles generated.

## Usage Examples

### Basic Usage

```javascript
import { generateEndcapFaces } from './common.js';

// Simple triangular endcap
const boundaryPoints = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 0, 0), 
    new THREE.Vector3(0.5, 1, 0)
];

const triangleCount = generateEndcapFaces(solid, 'END_CAP', boundaryPoints);
```

### With Custom Options

```javascript
// Pentagon using centroid method with custom tolerance
const pentagonPoints = [];
for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    pentagonPoints.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0));
}

const count = generateEndcapFaces(solid, 'PENTAGON_CAP', pentagonPoints, null, {
    triangulationMethod: 'centroid',
    minTriangleArea: 1e-10,
    ensureCounterClockwise: true
});
```

### Using Array Format

```javascript
// Input as [x,y,z] arrays
const arrayPoints = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0]
];

const count = generateEndcapFaces(solid, 'SQUARE_CAP', arrayPoints);
```

### With Explicit Normal

```javascript
// Provide explicit normal vector for orientation control
const normal = new THREE.Vector3(0, 0, 1); // Z-up
const count = generateEndcapFaces(solid, 'ORIENTED_CAP', points, normal);
```

## Integration with Fillet System

The function is designed to integrate seamlessly with the existing fillet system:

```javascript
import { generateEndcapFaces } from './common.js';

// Example usage in fillet generation
function buildFilletEndcaps(solid, railP, seamA, seamB, faceName) {
    // Create boundary loop from rail and seam points
    const boundaryLoop = [];
    
    // Add rail points
    boundaryLoop.push(...railP);
    
    // Add seam points in reverse order to close the loop
    for (let i = seamA.length - 1; i >= 0; i--) {
        boundaryLoop.push(seamA[i]);
    }
    
    // Generate the endcap
    return generateEndcapFaces(solid, `${faceName}_ENDCAP`, boundaryLoop, null, {
        triangulationMethod: 'earcut', // Handle non-convex cases
        minTriangleArea: 1e-12
    });
}
```

## Error Handling

The function includes comprehensive error handling:

- Validates input parameters
- Removes duplicate consecutive points
- Handles degenerate cases gracefully
- Falls back to simpler triangulation methods if complex methods fail
- Provides informative console warnings for debugging

## Performance Notes

- **'fan'** method is fastest for simple convex polygons
- **'centroid'** provides good triangle quality for convex shapes
- **'earcut'** is most robust but slowest for complex non-convex polygons
- Function automatically removes duplicate points to improve robustness
- Uses Newell's method for robust normal computation on non-planar polygons