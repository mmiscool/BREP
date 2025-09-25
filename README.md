# [BREP](https://github.com/mmiscool/BREP)
## [Source repo https://github.com/mmiscool/BREP](https://github.com/mmiscool/BREP)

A feature-based modeling playground experimenting with BREP-style workflows on top of triangle meshes. It combines robust manifold CSG (via the [Manifold](https://github.com/elalish/manifold/) library) with a simple face/edge representation, a history pipeline, and Three.js visualization. Import meshes (STL), repair and group them into faces, then perform boolean operations, fillets, chamfers, sweeps, lofts, and more.

This project is actively evolving; expect rough edges while APIs settle.

## Highlights

- Feature history pipeline with a compact UI to add, edit, and re-run features.
- Robust CSG powered by `manifold-3d` with face-label provenance carried through booleans.
- Mesh-to-BREP conversion that groups triangles into faces by normal deflection.
- Mesh repair pipeline: weld, T‑junction fix, overlap removal, hole fill, and consistent normals.
- Import/export: STL, OBJ and feature‑aware 3MF (embedded history).
- Primitive solids (cube, sphere, cylinder, cone, torus, pyramid) and typical CAD features (sketch/extrude, sweep, loft, revolve, fillet, chamfer, mirror, boolean ops).
- Modular main toolbar with: Save, Zoom to Fit, Wireframe toggle, Import/Export, and About.
- Selection Filter surfaced in the toolbar for quick access.
- Browser test runner captures per-test canvas snapshots (with auto Zoom‑to‑Fit) and shows them in the log dialog.
- Easy to use plugin system lets you import your own plugins from github repos. 

## Plugins and Example

- Example plugin repository: https://github.com/mmiscool/BREPpluginExample
- Example plugin README: https://github.com/mmiscool/BREPpluginExample/blob/master/README.md
- Entrypoint: https://github.com/mmiscool/BREPpluginExample/blob/master/plugin.js
- Feature example: https://github.com/mmiscool/BREPpluginExample/blob/master/exampleFeature.js

## Features Status

- Primitive Cube: Implemented
- Primitive Cylinder: Implemented
- Primitive Cone: Implemented
- Primitive Sphere: Implemented
- Primitive Torus: Implemented
- Primitive Pyramid: Implemented
- Plane: Implemented
- Datum: Planned
- Sketch: Implemented
- Extrude: Implemented
- Sweep: Implemented
- Loft: Planned
- Revolve: Implemented
- Mirror: Implemented
- Boolean: Implemented
- Fillet: Implemented
- Chamfer: Implemented
- STL/3MF Import: Implemented
- PNG to Face (image trace): Implemented

## Getting Started

Prereqs: Node.js 18+ and `pnpm` installed.

- Install dependencies: `pnpm install`
- Run dev server (Vite): `pnpm dev`
  - Open the printed URL (usually http://localhost:5173). Try `index.html`, `sdf.html`, or `offsetSurfaceMeshTest.html` for sandboxes.
- Run tests: `pnpm test`
- Live testing while editing (Node): `pnpm liveTesting`

### UI overview (browser)

- Top toolbar (fixed):
  - Save: stores the current model to browser localStorage (integrates with File Manager).
  - Zoom to Fit: pans and zooms using ArcballControls to frame all visible geometry without changing orientation.
  - Wireframe: toggles mesh wireframe rendering for a quick inspection.
  - About: opens the third‑party license report.
  - Import…: opens a file picker for 3MF (with optional embedded history) or BREP JSON.
- Export…: opens a dialog to export as 3MF, STL, OBJ, or BREP JSON.
  - Selection Filter: now lives in the toolbar (right side) for quick changes; Esc clears selection.

## Importing Models (STL and 3MF)

Use the “STL Import” feature in the history panel. It now supports both STL and 3MF:

Alternatively, use the top‑toolbar “Import…” button to open 3MF (with or without embedded history) or BREP JSON. For STL files, add an “STL Import” feature to the history.

- STL: ASCII or binary. Parsed with `three/examples/jsm/loaders/STLLoader.js`.
- 3MF: ZIP-based format. Parsed with `three/examples/jsm/loaders/3MFLoader.js` and merged.

After parsing, an optional centering step runs, followed by the mesh repair pipeline (configurable levels). Finally, triangles are labeled into faces by deflection angle and authored into a `Solid` for CSG and visualization.

Programmatic example (from tests):

```
import { PartHistory } from './src/PartHistory.js';

const ph = new PartHistory();
const importFeature = await ph.newFeature('STL'); // also accepts 3MF
importFeature.inputParams.fileToImport = someStlOr3mfData; // string (ASCII or data URL) or ArrayBuffer
importFeature.inputParams.deflectionAngle = 15; // degrees to group triangles into faces
await ph.runHistory();
```

## File Formats: Import & Export

Supported formats and how they round‑trip through BREP:

- 3MF (feature‑aware):
  - Export: Generates a valid 3MF container that includes the triangulated geometry plus an embedded copy of your feature history so the file remains editable later in this app. Non‑manifold solids are detected and skipped (you will be notified), and the export still proceeds so you can share the file or fix later. The history is stored as XML at `Metadata/featureHistory.xml`, and a model metadata entry `featureHistoryPath` points to it. Multiple solids export as separate `<object>` items in a single 3MF. Units are configurable (default `millimeter`).
  - Import: If a 3MF contains `Metadata/featureHistory.xml` (or any `*featureHistory.xml`), BREP loads that history and rebuilds the model, preserving editable features. If not present, the 3MF is imported as pure geometry (mesh only).
  - Compatibility: The embedded history is non‑standard metadata; other 3MF viewers will ignore it, but the 3MF remains fully valid and viewable elsewhere.

- STL:
  - Export: ASCII STL. If multiple solids are selected, the Export dialog produces a ZIP with one STL per solid. Unit scaling is applied at export time.
  - Import: ASCII or binary supported. STL imports as geometry only (no feature history).

- OBJ:
  - Export: ASCII OBJ. If multiple solids are selected, the Export dialog produces a ZIP with one OBJ per solid. Unit scaling is applied at export time.

- BREP JSON:
  - Export: Saves only the feature history as JSON (`.BREP.json`) with no mesh. Useful for versioning or quick backups.
  - Import: Loads the saved history and recomputes the model. The Import button accepts `.json` files of this shape.

Where this lives in the code:
- 3MF exporter: `src/exporters/threeMF.js` (packages geometry and optional attachments using JSZip).
- Export dialog: `src/UI/toolbarButtons/exportButton.js`.
- Import logic: `src/UI/toolbarButtons/importButton.js`.
- JSON ↔ XML helpers for the embedded history: `src/utils/jsonXml.js`.

Notes and limitations
- 3MF export focuses on geometry and editable history; materials/textures are not currently exported.
- 3MF import merges geometry for editing and does not reconstruct materials.
- Embedded feature history is specific to BREP and may change as the project evolves.

## PNG to Face (Image Trace)

Use the “PNG to Face” feature to convert a monochrome PNG into a planar Face with boundary edges suitable for Extrude or Sweep. The image is binarized at a threshold and the foreground region is traced into closed loops with automatic hole detection. The result is returned as a SKETCH-like group containing:

- A triangulated Face (`...:PROFILE`) in the XY plane (Z=0)
- Edge loops for the outer boundary and holes

Parameters:
- fileToImport: PNG data (file picker or data URL)
- threshold: 0–255 cutoff (default 128)
- invert: swap foreground/background
- pixelScale: world units per pixel (default 1)
- center: center geometry at the origin (default on)
- rdpTolerance: optional simplification in world units (0 disables)
- placementPlane: select a PLANE or FACE to place the traced profile on (default is world XY)

Then select the produced Face (or the SKETCH group) as the `profile` for the Extrude feature.

## How It Works

- `Solid` authoring uses arrays (triangles + per‑triangle face labels). Before building a Manifold, triangle windings are made consistent and orientation is fixed by signed volume.
- `manifold-3d` creates a robust manifold and propagates face IDs through CSG, so original face labels remain usable after unions/differences/intersections.
- Faces and edges are visualized via Three.js; face names remain accessible for downstream feature logic.

## BREP Model and Classes

- **BREP model:** Triangle mesh plus per‑triangle face labels. Labels map to globally unique IDs in Manifold, which propagate through CSG so selections remain stable. Edges are derived at boundaries between distinct face labels and represented as polyline chains.
- **Manifoldization:** Authoring arrays are cleaned before build: triangle windings are made consistent by adjacency; outward orientation is enforced by signed volume; an optional weld epsilon removes duplicate vertices and degenerates. Results are cached until geometry mutates.
- **Visualization:** `Solid.visualize()` creates one `Face` mesh per face label and `Edge` polylines for label boundaries. Objects include semantic names to support selection and downstream features.

### Solid

- **Type:** `THREE.Group` subclass providing authoring, CSG, queries, and export.
- **Geometry storage:** `_vertProperties` (flat positions), `_triVerts` (triangle indices), `_triIDs` (per‑triangle face ID), with name↔ID maps to preserve labels through CSG.

- `addTriangle(faceName, v1, v2, v3)`: Adds a labeled triangle; inputs `faceName:string`, `v1:[x,y,z]`, `v2:[x,y,z]`, `v3:[x,y,z]`; returns `Solid` (this).
- `setEpsilon(epsilon = 0)`: Sets weld tolerance, welds vertices, drops degenerates, fixes windings; inputs `epsilon:number`; returns `Solid` (this).
- `mirrorAcrossPlane(point, normal)`: Returns a mirrored copy across a plane; inputs `point:THREE.Vector3|[x,y,z]`, `normal:THREE.Vector3|[x,y,z]`; returns `Solid`.
- `invertNormals()`: Flips triangle windings to invert normals; inputs none; returns `Solid` (this).
- `fixTriangleWindingsByAdjacency()`: Enforces consistent orientation across shared edges; inputs none; returns `Solid` (this).
- `removeTinyBoundaryTriangles(areaThreshold, maxIterations = 1)`: Removes sliver triangles along label boundaries via safe 2–2 flips; inputs `areaThreshold:number`, `maxIterations?:number`; returns `number` (flips performed).
- `getMesh()`: Gets current Manifold MeshGL; inputs none; returns `MeshGL` (`{ numProp, vertProperties, triVerts, faceID, ... }`).
- `getFace(name)`: Fetches triangles for a face label; inputs `name:string`; returns `Array<{ faceName, indices:number[], p1:[x,y,z], p2:[x,y,z], p3:[x,y,z] }>`.
- `getFaces(includeEmpty = false)`: Enumerates faces and their triangles; inputs `includeEmpty?:boolean`; returns `Array<{ faceName:string, triangles:Triangle[] }>`.
- `getFaceNames()`: Lists known face labels; inputs none; returns `string[]`.
- `getBoundaryEdgePolylines()`: Computes boundary polylines between distinct face labels; inputs none; returns `Array<{ name:string, faceA:string, faceB:string, indices:number[], positions:[x,y,z][], closedLoop?:boolean }>`.
- `visualize(options = {})`: Builds per‑face meshes and edge polylines into this group; inputs `options:{ showEdges?:boolean, materialForFace?:(name)=>Material, name?:string }`; returns `Solid` (this).
- `union(other)`: Boolean union; inputs `other:Solid`; returns `Solid`.
- `subtract(other)`: Boolean difference (A − B); inputs `other:Solid`; returns `Solid`.
- `intersect(other)`: Boolean intersection; inputs `other:Solid`; returns `Solid`.
- `difference(other)`: Boolean difference via Manifold API; inputs `other:Solid`; returns `Solid`.
- `simplify(tolerance?)`: Simplifies mesh preserving label boundaries; inputs `tolerance?:number`; returns `Solid`.
- `setTolerance(tolerance)`: Sets manifold tolerance (may simplify); inputs `tolerance:number`; returns `Solid`.
- `volume()`: Computes enclosed volume; inputs none; returns `number`.
- `surfaceArea()`: Computes total surface area; inputs none; returns `number`.
- `toSTL(name = 'solid', precision = 6)`: Exports ASCII STL; inputs `name?:string`, `precision?:number`; returns `string` (STL text).
- `writeSTL(filePath, name = 'solid', precision = 6)`: Writes ASCII STL to disk (Node only); inputs `filePath:string`, `name?:string`, `precision?:number`; returns `Promise<string>` (path written).

### Face

- **Type:** `THREE.Mesh` representing all triangles that share a face label (can be non‑planar or disjoint islands).
- **Properties:** `name` (label), `type` = `FACE`, `edges` (adjacent `Edge` objects), `geometry` (per‑face BufferGeometry built by `visualize()`).

- `getAverageNormal()`: Computes area‑weighted world‑space average normal; inputs none; returns `THREE.Vector3`.
- `surfaceArea()`: Computes world‑space surface area; inputs none; returns `number`.

### Edge

- **Type:** `Line2` polyline representing a boundary chain between two face labels.
- **Properties:** `name` (boundary name), `type` = `EDGE`, `faces` (the two adjacent `Face` objects when present), `closedLoop` (boolean), `userData.polylineLocal` (polyline points), `userData.faceA/faceB` (label names).

- `length()`: Computes world‑space polyline length; inputs none; returns `number`.

### How the BREP Works Here

- **Label‑driven topology:** Faces are semantic groups defined at authoring/import time and tracked per triangle. After booleans, label provenance survives so selections can continue to target the same named faces/edges.
- **Edges from labels:** Boundary edges are computed between triangles of different labels, then chained into polylines per label pair. This avoids fragile edge reconstruction and remains stable across many operations.
- **Manifold contract:** Inputs are assumed (or repaired to) be closed, watertight 2‑manifolds. The system corrects orientation and coherency but cannot heal gross self‑intersections or missing surfaces.

## Topological Naming

Topological naming is about keeping stable references to faces and edges as the model recomputes. This project uses per‑triangle face labels that propagate through CSG so features can reliably refer to geometry across edits.

- Face labels: Triangles are authored with a string face name. Internally each name maps to a globally unique Manifold ID and is stored as `faceID` per triangle. After boolean ops, Manifold preserves these IDs so the original face names remain available on the result.
- Edge identification: Edges are computed as polylines along boundaries between pairs of face labels. Each boundary chain is named `<faceA>|<faceB>[i]`, where `i` disambiguates multiple loops between the same two faces.
- Selections: The UI stores object names in feature parameters. Because face/edge objects are rebuilt from the propagated labels, references stay stable so long as some triangles of that face survive.
- Primitive conventions: Built‑in primitives assign semantic face names, e.g. `Cube_NX/PX/NY/PY/NZ/PZ`, `Cylinder_S` (side), `Cylinder_T/B` (top/bottom), `Torus_Side/Cap0/Cap1`. Imported meshes use `STL_FACE_<n>` groups derived by normal‑deflection clustering.
- Feature‑generated names: Operations derive clear, persistent names. For example, Fillet uses `FILLET_<faceA>|<faceB>_ARC`, `_SIDE_A`, `_SIDE_B`, `_CAP0`, `_CAP1`; Chamfer uses `CHAMFER_<faceA>|<faceB>_BEVEL`, `_SIDE_A`, `_SIDE_B`, `_CAP0`, `_CAP1`.

Guidelines and limitations
- Stability: Names persist through booleans and simplification; a name disappears only if all its triangles are removed by subsequent features.
- Splits/merges: A single face name can represent multiple disjoint islands after CSG. Edge loop indices `[i]` can change when topology changes; avoid hard‑coding the index when possible.
- Semantics vs geometry: Faces are label‑based, not re‑fitted analytic surfaces. Prefer selecting faces by their semantic names (from primitives or earlier features) rather than by geometric predicates alone.
- Authoring tips: When creating new solids or tools, choose descriptive face names and reuse source face names in derived outputs. This improves reference stability for downstream features.

Roadmap
- Optional GUIDs for selection sets to further reduce ambiguity when faces split.
- Enhanced matching heuristics (geometric signatures) to map selections across parameter changes that substantially remesh surfaces.

## Key Libraries

- Three.js (`three`): rendering and core geometry types.
  - STL loader: `three/examples/jsm/loaders/STLLoader.js`
  - 3MF loader: `three/examples/jsm/loaders/3MFLoader.js`
  - Geometry utilities: `three/examples/jsm/utils/BufferGeometryUtils.js`
- Manifold (`manifold-3d`): WASM CSG/mesh library used for manifold construction, boolean operations, and mesh queries. Repo: https://github.com/elalish/manifold/
  - Loaded via `src/BREP/setupManifold.js` with `vite-plugin-wasm` in the browser.
- JSZip (`jszip`): packages 3MF containers and ZIPs of multiple STLs.
- Vite (`vite`): dev server and build tooling.
- Nodemon (`nodemon`): convenient live testing for Node-based checks.

## Project Structure

- `src/features/` — Implementations of features (primitives, boolean, fillet, chamfer, sketch/extrude, sweep, loft, revolve, STL/3MF import, etc.).
- `src/BREP/` — Core BREP/solid authoring on top of Manifold, mesh repair, mesh-to-BREP conversion.
- `src/UI/` — Minimal UI widgets for the history pipeline and file management.
- `src/FeatureRegistry.js` — Registers features available to the pipeline.
- `src/PartHistory.js` — Orchestrates feature execution and artifact lifecycle.
- `index.html`, `sdf.html`, `offsetSurfaceMeshTest.html` — Standalone sandboxes and demos.

## Scripts

- `pnpm dev` — Run Vite dev server.
- `pnpm build` — Build for production.
- `pnpm test` — Run test suite.
- `pnpm liveTesting` — Auto-runs tests on file changes.

The project also includes a simple license report generator (`pnpm generateLicenses`) that writes `about.html`.

## Browser Test Runner

- A lightweight runner UI (mounted in the browser) lists all tests with controls to run individually or in sequence.
- After each test completes, the runner performs Zoom‑to‑Fit and captures a canvas snapshot. Clicking “Show Log” displays the snapshot above any logged output for that test.
- Between tests, an optional popup can show a running gallery of snapshots when auto‑progressing.

## Camera Zoom‑to‑Fit

- Zoom‑to‑Fit uses ArcballControls only (pan + orthographic zoom) to frame all visible geometry while preserving the current camera orientation.
- It computes a bounding box of scene content (excluding Arcball gizmos), projects to camera space to consider the current view, and determines the required zoom so both width and height fit with a small margin.
- No direct camera frustum or orientation changes are applied — this keeps controls and rendering in sync and avoids “jump” artifacts.

## Status and Limitations

- Mesh repair is heuristic and may need tuning for specific models.
- 3MF: geometry is merged into one mesh; materials/textures are not preserved for editing (visualization only). 3MF files exported by BREP include an embedded feature history for round‑tripping in BREP; other apps will ignore this metadata.
- APIs and file formats are subject to change as the project evolves.

## License

See `LICENSE.md`. This project uses a dual-licensing strategy managed by Autodrop3d LLC.




Todo: 
Area of face in inspector. 
