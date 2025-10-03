# Transform

Status: Implemented

Transform applies translation, rotation, and scale to selected solids.

## Inputs
- `solids` – solids to transform. Faces/edges are promoted to their owning solids.
- `space` – apply translation/rotation in `WORLD` or `LOCAL` space.
- `pivot` – `ORIGIN` or the source solid’s bounding box center.
- `translate`, `rotateEulerDeg`, `scale` – vector values applied about the chosen pivot.
- `copy` – when enabled the original solids remain and transformed copies are added; otherwise originals are replaced.

## Behaviour
- Transforms are baked directly into the cloned solid’s geometry, keeping subsequent operations simple.
- When replacing the original, the new solid inherits the source name; copies receive a `_COPY` suffix and the originals remain in the scene.
