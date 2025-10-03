# Datum

Status: Implemented

Datum creates a lightweight reference group that exposes orthogonal XY/XZ/YZ planes for downstream selections.

## Inputs
- `transform` – position, rotation, and scale applied to the three reference planes.

## Behaviour
- The feature emits a `THREE.Group` named after the feature ID with three plane meshes (`XY`, `XZ`, `YZ`).
- No references are inherited from other geometry yet; the datum always starts at the world origin before the supplied transform is applied.
- Each plane is selectable through the `PLANE` selection filter so other features (e.g. sketches) can lock to the datum.
