# Simplified Radial Dimension Interface

The radial dimension interface has been significantly simplified to take advantage of embedded radius metadata in cylindrical faces. Users now only need to select the cylindrical face itself, rather than manually specifying center points and edges.

## New Interface

### Required Input
- **Cylindrical Face**: Select any cylindrical face (from primitives, extrusions, etc.)

### Optional Inputs
- **Projection Plane**: Optional face to define the drawing plane for the dimension
- **Display Style**: Choose between radius (R) or diameter (⌀) display
- **Alignment**: Control dimension orientation (view, XY, YZ, ZX)
- **Offset**: Adjust dimension line offset distance
- **Decimals**: Number of decimal places to display
- **Reference**: Mark as reference dimension (parentheses)

## Usage Examples

### Basic Cylindrical Face Selection

```javascript
// Create a radial dimension
const radialDim = RadialDimension.create(pmiMode);

// Simply select the cylindrical face - that's it!
radialDim.cylindricalFaceRef = 'MyCylinder_S';
radialDim.displayStyle = 'radius'; // or 'diameter'

// The system automatically:
// 1. Extracts radius from face metadata
// 2. Determines cylinder center and axis
// 3. Creates appropriate dimension geometry
```

### With Projection Plane

```javascript
// For dimensions that need specific orientation
radialDim.cylindricalFaceRef = 'MyCylinder_S';
radialDim.planeRef = 'WorkPlane_XY'; // Optional projection plane
radialDim.displayStyle = 'diameter';
```

## Benefits of the New Interface

### 1. **Simplified Workflow**
- **Before**: Select center point → Select edge/arc → Configure alignment
- **After**: Select cylindrical face → Done!

### 2. **Automatic Precision**
- Uses exact radius values from original geometry
- No approximation errors from triangle mesh sampling
- Consistent measurements regardless of mesh resolution

### 3. **Intelligent Detection**
- Automatically works with:
  - Primitive cylinders (`BREP.Cylinder`)
  - Extruded circular sketches
  - Revolved circular profiles
  - Boolean operation results

### 4. **Robust Behavior**
- Gracefully handles transformations (rotation, scaling, translation)
- Preserves accuracy through boolean operations
- Maintains metadata through complex modeling operations

## Supported Cylindrical Sources

### Primitive Cylinders
```javascript
const cylinder = new BREP.Cylinder({
    radius: 5.0,
    height: 10.0,
    name: 'Pipe'
});
// Side face 'Pipe_S' automatically gets radius metadata
```

### Extruded Circles
```javascript
const extruded = new BREP.ExtrudeSolid({
    face: circularSketch, // Circle with radius 3.0
    distance: 8.0
});
// Side wall gets cylindrical metadata with radius 3.0
```

### Equal-Radius Cones
```javascript
const cylinder = new BREP.Cone({
    r1: 4.0,
    r2: 4.0, // Equal radii = cylindrical
    h: 12.0
});
// Treated as cylindrical face with radius 4.0
```

## Technical Implementation

### Metadata Structure
Cylindrical faces store this metadata:
```javascript
{
    type: 'cylindrical',
    radius: 5.0,
    height: 10.0,
    axis: [0, 1, 0],      // Unit vector along cylinder axis
    center: [0, 5.0, 0]   // Center point of cylinder axis
}
```

### Dimension Calculation
1. **Face Selection**: User selects cylindrical face
2. **Metadata Lookup**: System retrieves stored radius value
3. **Geometry Computation**: Calculates center, axis, and surface points
4. **Projection**: Applies any plane constraints or alignment rules
5. **Rendering**: Draws dimension with exact radius value

### Fallback Behavior
If metadata is not available (legacy geometry), the system automatically falls back to geometric calculation from triangle mesh, ensuring backward compatibility.

## Migration from Old Interface

### Old Schema (Deprecated)
```javascript
{
    centerRef: 'CenterVertex',  // ❌ No longer needed
    edgeRef: 'CircularEdge',    // ❌ No longer needed  
    planeRef: 'ProjectionFace', // ✓ Still optional
    // ... other settings
}
```

### New Schema
```javascript
{
    cylindricalFaceRef: 'Cylinder_S',  // ✓ Simple face selection
    planeRef: 'ProjectionFace',        // ✓ Optional projection plane
    // ... other settings (unchanged)
}
```

## Error Handling

### Invalid Face Selection
- **Non-cylindrical faces**: Dimension creation fails gracefully
- **Missing metadata**: Falls back to geometric calculation
- **Transformed geometry**: Automatically applies transformations

### Missing References
- **No cylindrical face**: Shows error message in UI
- **Invalid plane reference**: Uses view alignment as fallback
- **Corrupted metadata**: Attempts geometric reconstruction

## Performance Benefits

- **No geometric analysis**: Direct metadata lookup vs mesh processing
- **Reduced computation**: Skip center/radius finding algorithms  
- **Faster updates**: Dimension updates use cached metadata values
- **Lower memory**: No need to store intermediate geometric calculations

## Future Enhancements

This simplified interface enables future improvements:

1. **Smart Face Detection**: Auto-suggest cylindrical faces when tool is activated
2. **Multi-Radius Display**: Show both inner/outer radii for thick cylinders
3. **Tolerance Integration**: Display radius tolerances from design intent
4. **Parametric Updates**: Dimensions update automatically when model changes