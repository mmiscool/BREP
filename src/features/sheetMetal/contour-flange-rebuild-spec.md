# Sheet Metal Contour Flange - Complete Specification

## Overview
The Sheet Metal Contour Flange feature creates a sheet metal part by extruding a strip along a path with optional bend radii at corners. This document provides a complete specification for rebuilding the feature from scratch.

## Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | null | Unique identifier for the feature |
| `path` | reference_selection | null | Open sketch or connected edges defining the flange path |
| `distance` | number | 20 | Extrusion height (perpendicular to sketch plane) |
| `thickness` | number | 2 | Sheet metal thickness (width of the strip) |
| `reverseSheetSide` | boolean | false | Flip the strip to opposite side of path |
| `bendRadius` | number | 1 | Inside bend radius at corners |
| `consumePathSketch` | boolean | true | Remove sketch after feature creation |

## Core Concept

### Geometry Definition
The contour flange creates a **strip** (rectangular cross-section) that follows a path:

1. **Path**: A 2D polyline in a sketch plane (e.g., an L-shape, U-shape, etc.)
2. **Strip Width**: The `thickness` parameter defines how wide the strip is
3. **Strip Placement**: 
   - When `reverseSheetSide = false` (unchecked): Strip is offset to the LEFT of the path
   - When `reverseSheetSide = true` (checked): Strip is offset to the RIGHT of the path
4. **Extrusion**: The strip is extruded perpendicular to the sketch plane by `distance`

### Bend Radius Behavior

The `bendRadius` parameter represents the **INSIDE radius** of any bend in the final sheet metal part.

#### Critical Rule: Path Position vs Bend Geometry

**When reverseSheetSide = true (checked):**
- The path travels along the INSIDE of the bend
- Inside radius = `bendRadius`
- Outside radius = `bendRadius + thickness`
- Path is at radius `bendRadius` from the corner
- Arc center is at radius `bendRadius` from corner

**When reverseSheetSide = false (unchecked):**
- The path travels along the OUTSIDE of the bend
- Inside radius = `bendRadius` (still!)
- Outside radius = `bendRadius + thickness` 
- Path is at radius `bendRadius + thickness` from the corner
- Arc center is at radius `bendRadius + thickness` from corner

This ensures the **inside bend radius is always constant** regardless of which side the sheet is on.

## Algorithm Overview

### Phase 1: Path Extraction
1. Resolve selected sketch or edges to 3D polyline points
2. Extract or compute sketch plane basis (origin, xAxis, yAxis, planeNormal)
3. Convert 3D path to 2D coordinates in sketch plane

### Phase 2: Path Processing with Fillets

For each corner in the path:

#### Step 1: Determine Bend Geometry
```
corner_angle = angle between incoming and outgoing segments
turn_direction = cross product sign (left turn vs right turn)
```

#### Step 2: Calculate Path Radius
```
if reverseSheetSide == true:
    path_radius = bendRadius
else:
    path_radius = bendRadius + thickness
```

#### Step 3: Calculate Tangent Points
The tangent points where the arc meets the straight segments are **always** based on the bend radius geometry at the corner:

```
tangent_offset = bendRadius / tan(corner_angle / 2)
tangent_offset = min(tangent_offset, 0.9 * segment_lengths)

arc_start = corner - incoming_direction * tangent_offset
arc_end = corner + outgoing_direction * tangent_offset
```

#### Step 4: Calculate Arc Center
The center is positioned so the arc has radius `path_radius`:

```
perpendicular_direction = rotate incoming/outgoing direction by 90° (toward inside of turn)
center_offset = path_radius
arc_center = average of:
    - arc_start + perpendicular * center_offset
    - arc_end + perpendicular * center_offset
```

#### Step 5: Generate Arc Points
```
arc_radius = path_radius
start_angle = atan2(arc_start - arc_center)
end_angle = atan2(arc_end - arc_center)
sweep_direction = based on turn_direction

Generate points along arc from start_angle to end_angle
```

### Phase 3: Strip Face Creation

#### Step 1: Offset Path
Create parallel offset path at distance `thickness`:
- If `reverseSheetSide = true`: offset to LEFT (negative perpendicular)
- If `reverseSheetSide = false`: offset to RIGHT (positive perpendicular)

At corners with arcs, the offset must account for tangent directions.

#### Step 2: Build Strip Polygon
For each segment of the path:
```
polygon = [
    path_points[i],
    path_points[i+1],
    ...,
    offset_points[i+1] (reversed order),
    offset_points[i] (reversed order)
]
```

#### Step 3: Triangulate
Convert polygon to triangulated mesh (BufferGeometry).

### Phase 4: Extrusion

1. Extrude each strip face by `distance` in the `planeNormal` direction
2. Use BREP.Sweep with mode "translate"
3. Union multiple sweeps if path has multiple segments

### Phase 5: Metadata

#### Face Type Tagging
- **Type A faces**: Sidewalls from original path edges
- **Type B faces**: Sidewalls from offset path edges  
- **Thickness faces**: End caps and closure faces

#### Cylindrical Face Metadata
For bend regions, detect curved sidewalls and tag with:
```javascript
{
    type: "cylindrical",
    radius: measured_radius,
    height: extrusion_distance,
    axis: [x, y, z],
    center: [x, y, z],
    pmiRadiusOverride: bendRadius  // Always report inside radius
}
```

## Key Geometric Relationships

### Corner Geometry (90° bend example)

```
For 90° bend with bendRadius=3, thickness=1:

When checked (reverseSheetSide=true):
    path_radius = 3
    tangent_offset = 3 / tan(45°) = 3
    arc drawn at radius 3
    center at radius 3 from corner

When unchecked (reverseSheetSide=false):
    path_radius = 4 (3 + 1)
    tangent_offset = 3 / tan(45°) = 3  ← SAME!
    arc drawn at radius 4
    center at radius 4 from corner

The tangent offset is ALWAYS based on bendRadius geometry,
NOT on where the path/arc travels!
```

### Why Tangent Offset is Constant

The tangent offset represents the geometric distance from the corner where a circular arc of a given bend radius would naturally meet a straight line. This is a property of the bend geometry itself and is independent of which surface (inside or outside) the path follows.

## Implementation Notes

### 2D/3D Coordinate Handling
- All fillet/offset operations done in 2D (u,v) coordinates
- Convert to 3D for final geometry creation
- Maintain w-coordinate for points slightly off-plane

### Edge Cases
- Acute angles: Clamp tangent offset to 90% of segment length
- Collinear segments: Skip filleting
- Self-intersecting paths: Allow but may produce unexpected results

### Performance
- Fillet multiple corners in single pass
- Minimize 2D-3D coordinate conversions
- Reuse computed tangent directions for offset calculation

## Testing Checklist

- [ ] Simple L-shape, checked: Inside radius = bendRadius
- [ ] Simple L-shape, unchecked: Inside radius = bendRadius
- [ ] U-shape with multiple bends
- [ ] Path with acute angles (< 30°)
- [ ] Path with obtuse angles (> 150°)
- [ ] Very small bend radius (0.1)
- [ ] Very large bend radius (> segment length)
- [ ] Zero bend radius (sharp corners)
- [ ] Verify cylindrical face metadata reports correct inside radius
- [ ] Verify visual appearance: arcs connect smoothly at tangent points

## Dependencies

### Required Imports
```javascript
import { BREP } from "../../BREP/BREP.js";
import { normalizeThickness, normalizeBendRadius, applySheetMetalMetadata } from "./sheetMetalMetadata.js";
import { setSheetMetalFaceTypeMetadata, SHEET_METAL_FACE_TYPES, propagateSheetMetalFaceTypesToEdges } from "./sheetMetalFaceTypes.js";
```

### External Functions Used
- `BREP.Sweep` - Extrude faces
- `BREP.applyBooleanOperation` - Union operations
- `THREE.Vector3` - 3D vector math
- `THREE.BufferGeometry` - Mesh creation
- `THREE.ShapeUtils.triangulateShape` - Polygon triangulation

## Function Structure (Suggested)

```
SheetMetalContourFlangeFeature.run()
  ↓
resolvePathSelection() - Extract edges/sketches
  ↓
buildPathPoints() - Chain edges into connected path
  ↓
computePlaneBasis() - Determine sketch plane
  ↓
filletPolyline() - Add bend radii at corners
  ↓
buildContourFlangeStripFaces() - Create strip faces
  ↓
BREP.Sweep() - Extrude strip
  ↓
tagContourFlangeFaceTypes() - Metadata
  ↓
addCylMetadataToSideFaces() - Cylindrical metadata
```

## Known Issues to Avoid

1. **Tangent offset calculation**: Must always use `bendRadius`, not `path_radius`
2. **Arc radius**: Must use `path_radius` which varies by sheet side
3. **Center positioning**: Must match `path_radius`
4. **Metadata**: Always report `bendRadius` as inside radius, not measured radius
5. **Offset direction**: Must account for tangent directions at arc endpoints

