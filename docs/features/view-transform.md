# View-Specific Transforms for PMI Mode

## Overview
View-specific transforms allow users to create exploded views, assembly documentation, and technical illustrations by positioning solids differently in each PMI view while preserving their original positions in the main model.

## Features

### ViewTransform Annotation
- **Solid Selection**: Choose one or more solids to transform in the current PMI view
- **Interactive Transform Controls**: Use Three.js TransformControls for intuitive positioning, rotation, and scaling
- **Reference Direction**: Optional reference face/edge to orient transform controls relative to geometry
- **Trace Lines**: Visual indicators showing the movement path from original to transformed position
- **Automatic Restoration**: Solids return to original positions when exiting PMI mode or switching views

### Usage Workflow

1. **Enter PMI Mode**: Click on a PMI view to enter edit mode
2. **Add View Transform**: Click the "+" button in the Annotations panel and select "View Transform"
3. **Select Solids**: Use the reference selection widget to pick solids to transform
4. **Configure Transform**: 
   - Use the interactive transform widget to position solids
   - Optionally select a reference direction for control orientation
   - Toggle trace line visibility
5. **Finish**: Click "Finish" to save the view-specific transforms

### Key Benefits
- **Non-destructive**: Original solid positions are preserved
- **View-specific**: Each PMI view can have different transforms
- **Interactive**: Real-time visual feedback with transform controls
- **Documentation-ready**: Perfect for exploded views and assembly instructions
- **Automatic restoration**: No manual cleanup required

### Implementation Details

#### ViewTransform Annotation Structure
```javascript
{
  type: 'viewTransform',
  solids: [], // Array of solid references
  transform: { position: [0,0,0], rotationEuler: [0,0,0], scale: [1,1,1] },
  referenceDirection: '', // Optional reference for control orientation
  showTraceLine: true, // Boolean to show/hide trace lines
  originalTransforms: Map() // Stored original positions for restoration
}
```

#### Integration with PMI System
- Registered in `AnnotationRegistry` like other PMI annotation types
- Uses existing `genFeatureUI` system for consistent UI generation
- Integrates with PMI mode lifecycle (open/finish/cancel/dispose)
- Follows PMI annotation patterns for persistence and rendering

#### Transform Application Lifecycle
1. **On PMI Mode Open**: `#applyViewTransforms()` applies stored transforms
2. **During Editing**: Real-time updates via `applyParams()` callback
3. **On Mode Exit**: `#restoreViewTransforms()` restores original positions
4. **On Cancel**: Restoration happens before disposing the mode

### Files Created/Modified
- **New**: `/src/UI/pmi/dimensions/viewTransform.js` - ViewTransform annotation class
- **Modified**: `/src/UI/pmi/PMIMode.js` - Added transform lifecycle management and menu item

### Future Enhancements
- Animation between original and transformed positions
- Multiple transform keyframes per view
- Automatic explosion along assembly hierarchy
- Integration with assembly mate relationships