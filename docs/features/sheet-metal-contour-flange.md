# Sheet Metal Contour Flange

Status: Implemented

Contour Flange converts an open sketch (neutral-line path) into a sheet metal body by sweeping a rectangular strip along the curves. The tool inserts bend radii wherever adjacent segments meet so downstream features inherit accurate manufacturing parameters.

## Inputs
- `path` – Sketch or edges describing the contour path (open chain). Paths are auto-sorted and filleted.
- `distance` – Width of the strip measured perpendicular to the selected path. Material is generated only on the chosen side.
- `thickness` – Sheet-metal thickness, extruded normal to the sketch plane.
- `bendRadius` – Default inside bend radius used to round every sharp joint.
- `sheetSide` – Select which normal direction the sheet extrudes toward (positive or negative relative to the sketch plane).
- `consumePathSketch` – Optional checkbox to remove the driving sketch after the body is created (disable to keep it visible for downstream edits).
- `boolean.operation` / `boolean.targets` – Optional boolean with existing solids.

## Behaviour
- Builds a rectangular sweep profile (`distance × thickness`) anchored to the selected path, then uses `BREP.Sweep` in `pathAlign` mode so bends follow the path curvature.
- Automatically fillets the path with the supplied bend radius (so two-line sketches become manufacturable flanges without extra work).
- Removes consumed sketch groups once the flange body is generated.
- Annotates created solids with `userData.sheetMetal` metadata (base type, thickness, bend radius, sheet side, etc.) for downstream flange/cutout operations.
