# Primitive Cube

Status: Implemented

Primitive Cube builds an axis-aligned rectangular prism rooted at the origin.

## Inputs
- `sizeX`, `sizeY`, `sizeZ` – side lengths along the world X/Y/Z axes.
- `transform` – optional translation/rotation/scale baked into the cube before visualization.
- `boolean` – optional CSG operation applied immediately after the cube is created.

## Behaviour
- The cube extends in the positive axis directions from `(0,0,0)`; use the transform to reposition it in the scene.
- When a boolean is configured the feature returns the CSG results; otherwise the raw cube solid is emitted.
