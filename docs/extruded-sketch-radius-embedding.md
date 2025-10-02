# Radius Metadata for Extruded Sketches

This document details how radius metadata is automatically embedded when extruding circular or arc-based sketch elements.

## How It Works

### Automatic Detection
When extruding a sketch face, the system automatically scans all edges in the sketch for circular geometry:

1. **Circle Detection**: Edges with `sketchGeomType: 'circle'` and radius/center data
2. **Arc Detection**: Edges with `sketchGeomType: 'arc'` and radius/center data (any arc angle)
3. **Metadata Application**: Cylindrical face metadata is applied to the resulting side walls

### Edge Data Requirements
For automatic detection, sketch edges need this `userData` structure:

#### Circles
```javascript
edge.userData = {
    sketchGeomType: 'circle',
    circleCenter: [x, y, z],     // Center point in local coordinates
    circleRadius: number         // Radius value
}
```

#### Arcs  
```javascript
edge.userData = {
    sketchGeomType: 'arc',
    arcCenter: [x, y, z],        // Center point in local coordinates  
    arcRadius: number,           // Radius value
    arcAngle: number            // Arc angle in radians (any value)
}
```

## Generated Metadata

### Cylindrical Face Metadata Structure
```javascript
{
    type: 'cylindrical',
    radius: 6.5,                    // Original radius from sketch
    height: 12.0,                   // Extrusion distance
    axis: [0, 1, 0],               // Extrusion direction (normalized)
    center: [0, 6.0, 0]            // Center point along cylinder axis
}
```

### Face Naming Convention
Side walls are named using the pattern: `${featureName}:${edgeName}_SW`

Examples:
- `ExtrudedPart:CircleEdge1_SW`
- `HousingExtrude:OuterCircle_SW`
- `EXTRUDE_001:ArcEdge_SW`

## Coordinate Transformations

### Local to World Conversion
The system properly handles coordinate transformations:

1. **Edge Transforms**: If the edge has a `matrixWorld`, center points are transformed
2. **Extrusion Direction**: Direction vectors are transformed through the edge matrix
3. **Final Positioning**: Center points are positioned along the extrusion axis

### Example Transformation
```javascript
// Original sketch data (local coordinates)
circleCenter: [5, 0, 3]
circleRadius: 2.5

// After transformation and extrusion
metadata: {
    center: [5, 6.0, 3],  // Moved to mid-height of extrusion
    radius: 2.5,          // Preserved original radius
    height: 12.0,         // Total extrusion distance
    axis: [0, 1, 0]       // Normalized extrusion direction
}
```

## Supported Sketch Configurations

### Single Circle
```javascript
// Sketch with one circular edge
edges: [
    { 
        userData: { 
            sketchGeomType: 'circle', 
            circleCenter: [0, 0, 0], 
            circleRadius: 5.0 
        } 
    }
]
// Results in one cylindrical face with radius 5.0
```

### Multiple Circles (Ring/Tube)
```javascript
// Sketch with outer and inner circles
edges: [
    { userData: { sketchGeomType: 'circle', circleRadius: 10.0 } }, // Outer
    { userData: { sketchGeomType: 'circle', circleRadius: 6.0 } }   // Inner
]
// Results in two cylindrical faces with different radii
```

### Arc Segments
```javascript
// Sketch with arc edges
edges: [
    { userData: { sketchGeomType: 'arc', arcRadius: 8.0, arcAngle: Math.PI } }
]
// Results in cylindrical face with radius 8.0 (angle doesn't matter for extrusion)
```

### Mixed Geometry
```javascript
// Sketch with circles, arcs, and lines
edges: [
    { userData: { sketchGeomType: 'circle', circleRadius: 4.0 } },
    { userData: { sketchGeomType: 'arc', arcRadius: 7.0 } },
    { userData: { sketchGeomType: 'line' } }  // Ignored - not circular
]
// Results in two cylindrical faces (4.0 and 7.0 radius)
```

## Integration with PMI Dimensions

### Automatic Radius Detection
When creating radial dimensions:

1. **Face Selection**: User selects any extruded cylindrical face
2. **Metadata Lookup**: System finds embedded radius from original sketch
3. **Precise Measurement**: Uses exact radius value instead of geometric approximation

### Example Usage
```javascript
// Create radial dimension
const radialDim = RadialDimension.create(pmiMode);
radialDim.cylindricalFaceRef = 'ExtrudedCircle:OuterRing_SW';

// System automatically uses radius: 7.5 from original sketch geometry
// No need to specify center points or edge references
```

## Error Handling

### Missing or Invalid Data
- **No sketch geometry**: Falls back to geometric calculation from mesh
- **Invalid radius values**: Skips metadata embedding for that edge  
- **Transform errors**: Uses identity transform as fallback
- **Duplicate edges**: Each edge gets its own metadata entry

### Graceful Degradation
```javascript
try {
    // Attempt metadata embedding
    this.setFaceMetadata(faceName, metadata);
} catch (err) {
    // Silently continue - dimension system will fall back to geometric calculation
}
```

## Performance Benefits

### Computational Efficiency
- **Direct Lookup**: O(1) metadata retrieval vs O(n) mesh analysis
- **No Approximation**: Exact values from design intent
- **Cached Results**: Metadata persists through boolean operations

### Memory Usage
- **Minimal Overhead**: Small metadata objects per cylindrical face
- **Selective Storage**: Only circular/arc edges generate metadata
- **Automatic Cleanup**: Metadata removed when faces are deleted

## Future Enhancements

### Additional Geometry Types
- **Elliptical Arcs**: Store major/minor axis information
- **Spline Curves**: Store control point and knot data
- **Complex Profiles**: Multi-radius and transitional curves

### Enhanced Metadata
```javascript
// Future expanded metadata structure
{
    type: 'cylindrical',
    radius: 5.0,
    height: 10.0,
    axis: [0, 1, 0],
    center: [0, 5.0, 0],
    
    // Enhanced information
    sourceSketch: 'Sketch001',
    sourceEdge: 'Circle1',
    tolerance: { 
        radius: ±0.1,
        position: ±0.05 
    },
    materialThickness: 2.0,
    surfaceFinish: 'machined'
}
```

This system provides exact radius information for dimensioning while maintaining backward compatibility with existing geometric calculation methods.