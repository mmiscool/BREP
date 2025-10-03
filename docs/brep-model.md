# BREP Model and Classes

## Overview
- BREP combines a triangle mesh with per-triangle face labels. Labels map to globally unique IDs in Manifold so selections survive boolean operations.
- During manifoldization, triangle windings are made consistent, outward orientation is enforced, and an optional weld epsilon deduplicates vertices.
- Visualization builds one mesh per face label and edge polylines for label boundaries, enabling semantic selection in the UI and PMI tooling.

## Solid
- `Solid` is a `THREE.Group` subclass that handles authoring, CSG, queries, and export.
- Geometry storage uses `_vertProperties` (flat positions), `_triVerts` (triangle indices), and `_triIDs` (face IDs) plus name-to-ID maps.
- Key methods include `addTriangle`, `setEpsilon`, `mirrorAcrossPlane`, `invertNormals`, `fixTriangleWindingsByAdjacency`, `removeTinyBoundaryTriangles`, `getMesh`, `getFace`, `getFaces`, `getFaceNames`, `getBoundaryEdgePolylines`, `visualize`, `union`, `subtract`, `intersect`, `difference`, `simplify`, `setTolerance`, `volume`, `surfaceArea`, `toSTL`, and `writeSTL`.

## Face
- `Face` is a `THREE.Mesh` representing all triangles that share a label.
- Provides `getAverageNormal()` and `surfaceArea()` helpers for inspection and downstream logic.

## Edge
- `Edge` instances represent boundary polylines between two face labels and expose metadata describing the adjacent faces.
- Use edges for PMI dimension snapping, measurement, and preview visualization.

Additional implementation details can be explored in `src/BREP/BetterSolid.js` and related helpers.
