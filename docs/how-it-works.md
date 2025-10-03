# How It Works

- `Solid` authoring uses flat arrays for triangles and per-triangle face labels. Windings are made consistent and orientation is fixed by signed volume before building a Manifold.
- `manifold-3d` produces robust manifold meshes while propagating face IDs through CSG, keeping selections stable after unions, differences, and intersections.
- Faces and edges are visualized with Three.js helpers. Face names remain accessible for downstream feature logic and PMI annotations.
