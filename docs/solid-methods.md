# Solid Methods Reference

`Solid` lives in `src/BREP/BetterSolid.js` and extends `THREE.Group`. Examples below assume:

```js
import { Solid } from '../src/BREP/BetterSolid.js';
const solid = new Solid();
```

## Lifecycle

### constructor()
Initializes empty authoring buffers, face/edge metadata maps, and flags the manifold cache as dirty.
```js
const s = new Solid();
```

### clone()
Creates a lightweight copy of geometry, face/edge metadata, and aux edges (no THREE children or GPU resources).
```js
const copy = solid.clone();
```

### free()
Disposes the cached `Manifold` instance to release wasm memory; the Solid remains usable and will rebuild on demand.
```js
solid.free();
```

### faces (getter)
Ensures `visualize()` has run, then returns `FACE` children currently attached to the group.
```js
const faceMeshes = solid.faces;
```

## Authoring

### addTriangle(faceName, v1, v2, v3)
Appends a CCW triangle labeled with `faceName`; vertices are uniqued by exact coordinates.
```js
solid.addTriangle('TOP', [0, 0, 0], [1, 0, 0], [0, 1, 0]);
```

### _key([x, y, z])
Internal: builds the exact string key used for vertex deduplication.
```js
const key = solid._key([0, 0, 0]); // "0,0,0"
```

### _getPointIndex(point)
Internal: returns the existing vertex index or appends the point to the authoring buffer.
```js
const idx = solid._getPointIndex([1, 2, 3]);
```

### _getOrCreateID(faceName)
Internal: maps a face name to a globally unique Manifold ID, creating one if needed.
```js
const faceId = solid._getOrCreateID('SIDE');
```

### addAuxEdge(name, points, options)
Stores a helper polyline (e.g., centerline) for visualization alongside the solid.
```js
solid.addAuxEdge('CENTER', [[0, 0, 0], [0, 0, 5]], {
  closedLoop: false,       // render as loop when true
  polylineWorld: false,    // points already in world space?
  materialKey: 'OVERLAY'   // visualization material tag
});
```

### addCenterline(a, b, name?, options?)
Convenience wrapper that records a two‑point aux edge.
```js
solid.addCenterline([0, 0, 0], [0, 0, 10], 'AXIS', {
  closedLoop: false,
  polylineWorld: false,
  materialKey: 'OVERLAY'
});
```

## Metadata

### setFaceMetadata(faceName, metadata)
Attaches arbitrary metadata to a face label (merged if it already exists).
```js
solid.setFaceMetadata('CYL_SIDE', { radius: 5, axis: [0, 0, 1] });
```

### getFaceMetadata(faceName)
Reads face metadata; returns `{}` when unset.
```js
const data = solid.getFaceMetadata('CYL_SIDE');
```

### getFaceNames()
Lists all face labels present on the solid.
```js
const names = solid.getFaceNames();
```

### setEdgeMetadata(edgeName, metadata) / getEdgeMetadata(edgeName)
Stores or reads metadata for boundary edges (used by PMI and downstream tooling).
```js
solid.setEdgeMetadata('EDGE_A', { tag: 'reference' });
const edgeInfo = solid.getEdgeMetadata('EDGE_A');
```

### _combineFaceMetadata(other)
Internal: merges face metadata maps across solids (used during booleans).
```js
const combined = solid._combineFaceMetadata(otherSolid);
```

## Transforms and offsets

### bakeTransform(matrix)
Applies a `THREE.Matrix4` to authored vertices and aux edges, rebuilding the vertex index map.
```js
const m = new THREE.Matrix4().makeTranslation(0, 0, 10);
solid.bakeTransform(m);
```

### bakeTRS(trs)
Composes and bakes a transform from `{ t, rDeg, s }` using `composeTrsMatrixDeg`.
```js
solid.bakeTRS({ t: [0, 0, 10], rDeg: [0, 45, 0], s: [1, 1, 1] });
```

### offsetFace(faceName, distance)
Moves all vertices of a labeled face along its average normal by `distance`.
```js
solid.offsetFace('TOP', 2.0);
```

### mirrorAcrossPlane(point, normal)
Returns a mirrored clone across a plane defined by a point and normal.
```js
const mirrored = solid.mirrorAcrossPlane([0, 0, 0], [1, 0, 0]);
```

### pushFace(faceName, distance)
Translates a face along its outward normal using current triangle windings.
```js
solid.pushFace('FRONT', 1.5);
```

## Manifold, orientation, and welding

### setEpsilon(epsilon)
Sets weld tolerance and optionally welds existing vertices, then fixes triangle winding.
```js
solid.setEpsilon(0.001);
```

### _weldVerticesByEpsilon(epsilon)
Internal: welds vertices on a grid using `epsilon`, drops degenerate triangles, and marks dirty.
```js
solid._weldVerticesByEpsilon(0.0005);
```

### fixTriangleWindingsByAdjacency()
Ensures shared edges have opposite orientation so the mesh is coherently oriented.
```js
solid.fixTriangleWindingsByAdjacency();
```

### _isCoherentlyOrientedManifold()
Checks whether every undirected edge is shared by two triangles with opposite directions.
```js
const ok = solid._isCoherentlyOrientedManifold();
```

### invertNormals()
Flips all triangles (swaps indices 1 and 2) and rebuilds the manifold cache.
```js
solid.invertNormals();
```

### _manifoldize()
Builds or returns the cached `Manifold` from authored arrays (fixes winding and orientation first).
```js
const manifold = solid._manifoldize();
```

## Mesh cleanup and refinement

### remesh({ maxEdgeLength, maxIterations })
Splits edges longer than `maxEdgeLength`, preserving face IDs, and fixes winding after changes.
```js
solid.remesh({
  maxEdgeLength: 5, // required threshold
  maxIterations: 2  // optional passes (default 10)
});
```

### removeSmallIslands({ maxTriangles, removeInternal, removeExternal })
Deletes small connected triangle components relative to the largest shell; returns count removed.
```js
const removed = solid.removeSmallIslands({
  maxTriangles: 20,    // island size threshold
  removeInternal: true, // drop islands inside main shell
  removeExternal: true  // drop islands outside main shell
});
```

### removeSmallInternalIslands(maxTriangles)
Convenience wrapper removing only internal islands under the given triangle count.
```js
solid.removeSmallInternalIslands(15);
```

### removeTinyBoundaryTriangles(areaThreshold, maxIterations?)
Performs edge flips across inter-face boundaries to remove triangles below `areaThreshold`.
```js
solid.removeTinyBoundaryTriangles(0.001, 3);
```

### collapseTinyTriangles(lengthThreshold)
Collapses triangles whose shortest edge is below `lengthThreshold`, then cleans up via a bounding-box intersect; returns number of edge collapses.
```js
const collapses = solid.collapseTinyTriangles(0.05);
```

### splitSelfIntersectingTriangles(diagnostics?)
Detects intersecting triangle pairs and subdivides them in place while preserving face IDs; returns splits applied.
```js
solid.splitSelfIntersectingTriangles();
```

### removeDegenerateTriangles()
Drops triangles with duplicate vertices or near-zero area; returns removed count.
```js
const removed = solid.removeDegenerateTriangles();
```

### removeInternalTriangles()
Rebuilds authoring arrays from the manifold’s exterior surface, removing internal faces; returns removed count.
```js
solid.removeInternalTriangles();
```

### removeInternalTrianglesByRaycast()
Uses centroid ray tests to cull triangles inside the solid without requiring manifoldization; returns removed count.
```js
solid.removeInternalTrianglesByRaycast();
```

### removeInternalTrianglesByWinding(options?)
Uses solid-angle winding numbers at triangle centroids to delete interior triangles; returns removed count.
```js
solid.removeInternalTrianglesByWinding({
  offsetScale: 1e-4,      // centroid offset relative to bbox diagonal
  crossingTolerance: 0.05 // tolerance for interior crossing test
});
```

## Queries and measurements

### getMesh()
Returns a fresh MeshGL view (`{ vertProperties, triVerts, faceID }`) from the cached manifold.
```js
const mesh = solid.getMesh();
console.log(mesh.triVerts.length / 3, 'triangles');
mesh.delete?.(); // cleanup when finished
```

### _ensureFaceIndex()
Internal: builds a cache mapping face IDs to triangle indices for fast lookups.
```js
solid._ensureFaceIndex();
```

### getFace(name)
Returns the triangles for a face label with positions and indices.
```js
const tris = solid.getFace('TOP');
```

### getFaces(includeEmpty?)
Enumerates all faces as `{ faceName, triangles }`, optionally including faces with no triangles.
```js
const faces = solid.getFaces();
```

### getBoundaryEdgePolylines()
Extracts boundary polylines between differing face labels.
```js
const edges = solid.getBoundaryEdgePolylines();
```

### getTriangleCount()
Counts triangles in the current manifold mesh.
```js
const triCount = solid.getTriangleCount();
```

### volume()
Computes absolute volume from the manifold mesh.
```js
const vol = solid.volume();
```

### surfaceArea()
Computes total surface area from the manifold mesh.
```js
const area = solid.surfaceArea();
```

## Boolean and reconstruction helpers

### _combineIdMaps(other)
Internal: merges face ID → name maps before constructing boolean results.
```js
const mergedMap = solid._combineIdMaps(otherSolid);
```

### union(other) / subtract(other) / intersect(other) / difference(other)
Runs the corresponding boolean CSG against `other`, returning a new Solid with merged face labels, metadata, and aux edges.
```js
const united = solid.union(otherSolid);
const cut = solid.subtract(toolSolid);
const common = solid.intersect(otherSolid);
const diff = solid.difference(otherSolid); // alias of subtract
```

### setTolerance(tolerance)
Returns a new Solid built from `Manifold.setTolerance(tolerance)` to adjust robustness.
```js
const tolerant = solid.setTolerance(0.02);
```

### simplify(tolerance?, updateInPlace?)
Calls `Manifold.simplify`; when `updateInPlace` is truthy the current solid is mutated, otherwise a new one is returned.
```js
const simplified = solid.simplify(0.5);       // new Solid
solid.simplify(0.5, true);                    // mutate in place
```

### _expandTriIDsFromMesh(mesh) (static)
Static helper that expands `faceID` on a MeshGL to a JS array, defaulting to zeros when absent.
```js
const ids = Solid._expandTriIDsFromMesh(mesh);
```

### _fromManifold(manifoldObj, idToFaceName) (static)
Static constructor that builds a Solid from an existing `Manifold` plus an ID → face-name map.
```js
const rebuilt = Solid._fromManifold(existingManifold, existingMap);
```

## Export and visualization

### toSTL(name?, precision?)
Generates an ASCII STL string from the current manifold mesh.
```js
const stl = solid.toSTL('part', 5);
```

### writeSTL(filePath, name?, precision?)
Node-only helper that writes the STL string to disk.
```js
await solid.writeSTL('out/part.stl', 'part', 6);
```

### visualize(options?)
Clears children, builds one `Face` mesh per face label, and optional boundary `Edge` polylines; attaches them as children for display.
```js
solid.visualize({
  showEdges: true,        // include boundary polylines
  forceAuthoring: false,  // force authoring arrays instead of manifold mesh
  authoringOnly: false    // skip manifold path entirely
});
scene.add(solid);
```

## Feature builders

### chamfer(options)
Asynchronously applies chamfers to named edges, returning a new Solid (union for OUTSET, subtract for INSET).
```js
const chamfered = await solid.chamfer({
  distance: 1,                // required
  edgeNames: ['EDGE_0'],      // edges to chamfer
  direction: 'INSET',         // or 'OUTSET'
  inflate: 0.1,               // tool inflation (negated for OUTSET)
  debug: false,
  featureID: 'CHAMFER',       // name prefix
  sampleCount: undefined,     // optional strip sampling override
  snapSeamToEdge: undefined,  // optional seam snapping
  sideStripSubdiv: undefined, // optional side strip subdivisions
  seamInsetScale: undefined,  // optional seam inset scale
  flipSide: undefined,        // optional side flip
  debugStride: undefined      // optional debug stride
});
```

### fillet(options)
Asynchronously applies constant-radius fillets to named edges, returning a new Solid (union for OUTSET, subtract for INSET).
```js
const filleted = await solid.fillet({
  radius: 2,                // required
  edgeNames: ['EDGE_0'],    // edges to fillet
  direction: 'OUTSET',      // or 'INSET'
  inflate: 0.1,             // tube inflation
  debug: false,
  snapSeam: true,           // snap boolean seams to tangents (INSET)
  featureID: 'FILLET'       // name prefix
});
```
