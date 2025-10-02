# Cylindrical Face Radius Embedding

This feature adds automatic radius information embedding for cylindrical faces in BREP solids, making the radius values available for downstream operations like dimensioning.

## How It Works

### 1. Automatic Radius Embedding

When cylindrical faces are created, the system automatically stores radius metadata:

```javascript
// For primitive cylinders
const cylinder = new BREP.Cylinder({
    radius: 5.0,
    height: 10.0,
    name: 'MyCylinder'
});

// The side face 'MyCylinder_S' will automatically have metadata:
// {
//   type: 'cylindrical',
//   radius: 5.0,
//   height: 10.0,
//   axis: [0, 1, 0],
//   center: [0, 5.0, 0]
// }
```

### 2. Extrude Operations

When extruding circular sketches, cylindrical faces are automatically detected and radius metadata is embedded:

```javascript
// If you extrude a circular face with radius 3.0
const extruded = new BREP.ExtrudeSolid({
    face: circularFace,
    distance: 8.0
});

// The side wall will have cylindrical metadata with radius: 3.0
```

### 3. Accessing Face Metadata

You can retrieve the embedded radius information:

```javascript
// Get metadata for a specific face
const metadata = solid.getFaceMetadata('MyCylinder_S');

if (metadata && metadata.type === 'cylindrical') {
    console.log('Radius:', metadata.radius);
    console.log('Height:', metadata.height);
    console.log('Axis:', metadata.axis);
    console.log('Center:', metadata.center);
}
```

### 4. Setting Custom Metadata

You can also manually set face metadata:

```javascript
solid.setFaceMetadata('CustomFace', {
    type: 'cylindrical',
    radius: 7.5,
    height: 12.0,
    axis: [1, 0, 0],
    center: [0, 0, 0]
});
```

## Benefits for Dimensioning

### Radial Dimensions

The PMI system automatically uses embedded radius values when creating radial dimensions:

1. **Automatic Detection**: When you select a cylindrical face for dimensioning, the system first checks for embedded radius metadata
2. **Precise Values**: Uses the exact radius value from the original geometry instead of approximating from triangle vertices
3. **Performance**: No need to perform geometric calculations to determine the radius

### Usage in PMI Mode

```javascript
// In PMI mode, when creating a radial dimension:
// 1. Select the cylindrical face edge
// 2. The system automatically detects the embedded radius
// 3. Displays the correct radius value for dimensioning
```

## Metadata Persistence

Face metadata is automatically preserved through:

- **Boolean Operations**: Union, subtract, intersect operations preserve metadata from both input solids
- **Transformations**: Metadata travels with the face through transformations
- **Feature Operations**: Fillets, chamfers, and other operations maintain source metadata when possible

## Supported Face Types

- **Cylindrical**: Full circular cylinders with consistent radius
- **Conical**: Truncated cones (when top/bottom radii are equal, treated as cylindrical)
- **Future**: Spherical, toroidal, and other curved surfaces can be added using the same pattern

## Implementation Notes

The system uses a `Map` to store face metadata:
- Key: Face name (string)
- Value: Metadata object with type, geometric parameters

This approach is:
- **Lightweight**: Only stores essential geometric information
- **Extensible**: Easy to add new face types and metadata
- **Compatible**: Works with existing BREP boolean operations
- **Robust**: Gracefully handles missing or invalid metadata