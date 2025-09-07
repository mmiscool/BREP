# BREP

A feature-based modeling playground experimenting with BREP-style workflows on top of triangle meshes. It combines robust manifold CSG (via the Manifold library) with a simple face/edge representation, a history pipeline, and Three.js visualization. Import meshes (STL), repair and group them into faces, then perform boolean operations, fillets, chamfers, sweeps, lofts, and more.

This project is actively evolving; expect rough edges while APIs settle.

## Highlights

- Feature history pipeline with a compact UI to add, edit, and re-run features.
- Robust CSG powered by `manifold-3d` with face-label provenance carried through booleans.
- Mesh-to-BREP conversion that groups triangles into faces by normal deflection.
- Mesh repair pipeline: weld, T‑junction fix, overlap removal, hole fill, and consistent normals.
- Importers for both STL (using Three.js loaders).
- Primitive solids (cube, sphere, cylinder, cone, torus, pyramid) and typical CAD features (sketch/extrude, sweep, loft, revolve, fillet, chamfer, mirror, boolean ops).

## Features Status

- Primitive Cube: Implemented
- Primitive Cylinder: Implemented
- Primitive Cone: Implemented
- Primitive Sphere: Implemented
- Primitive Torus: Implemented
- Primitive Pyramid: Implemented
- Plane: Implemented
- Datium: Planned
- Sketch: Planned
- Extrude: Implemented
- Sweep: Work in progress 
- Loft: Planned
- Revolve: Planned
- Mirror: Planned
- Boolean: Implemented
- Fillet: Implemented
- Chamfer: Implemented
- STL Import: Implemented

## Getting Started

Prereqs: Node.js 18+ and `pnpm` installed.

- Install dependencies: `pnpm install`
- Run dev server (Vite): `pnpm dev`
  - Open the printed URL (usually http://localhost:5173). Try `index.html`, `sdf.html`, or `offsetSurfaceMeshTest.html` for sandboxes.
- Run tests: `pnpm test`
- Live testing while editing (Node): `pnpm liveTesting`

## Importing Models (STL and 3MF)

Use the “STL Import” feature in the history panel. It now supports both STL and 3MF:

- STL: ASCII or binary. Parsed with `three/examples/jsm/loaders/STLLoader.js`.

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

## How It Works

- `Solid` authoring uses arrays (triangles + per‑triangle face labels). Before building a Manifold, triangle windings are made consistent and orientation is fixed by signed volume.
- `manifold-3d` creates a robust manifold and propagates face IDs through CSG, so original face labels remain usable after unions/differences/intersections.
- Faces and edges are visualized via Three.js; face names remain accessible for downstream feature logic.

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
- Manifold (`manifold-3d`): WASM CSG/mesh library used for manifold construction, boolean operations, and mesh queries.
  - Loaded via `src/BREP/setupManifold.js` with `vite-plugin-wasm` in the browser.
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

## Status and Limitations

- Mesh repair is heuristic and may need tuning for specific models.
- 3MF: geometry is merged into one mesh; materials/textures are not preserved for editing (visualization only).
- APIs and file formats are subject to change as the project evolves.

## License

See `LICENSE.md`. This project uses a dual-licensing strategy managed by Autodrop3d LLC.
