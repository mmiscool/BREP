# [BREP](https://github.com/mmiscool/BREP)
## [Source repo https://github.com/mmiscool/BREP](https://github.com/mmiscool/BREP)

A feature-based modeling playground experimenting with BREP-style workflows on top of triangle meshes. It combines robust manifold CSG (via the [Manifold](https://github.com/elalish/manifold/) library) with a simple face and edge representation, a history pipeline, and Three.js visualization. Import meshes (STL), repair and group them into faces, then perform boolean operations, fillets, chamfers, sweeps, lofts, and more.

This project is actively evolving; expect rough edges while APIs settle.
[![Modeling Mode](docs/MODELING.png)](docs/modes/modeling.md)
[![Sketch Mode](docs/SKETCH.png)](docs/modes/sketch.md)
[![PMI Mode](docs/PMI.png)](docs/modes/pmi.md)
[![Image to Face 2D Trace](docs/features/image-to-face-2D_dialog.png)](docs/features/image-to-face.md)
[![Image to Face 3D Result](docs/features/image-to-face-3D_dialog.png)](docs/features/image-to-face.md)


## Documentation Map

- [Highlights](docs/highlights.md)
- [What's New](docs/whats-new.md)
- [Getting Started](docs/getting-started.md)
- [UI Overview (Browser)](docs/ui-overview.md)
- [How It Works](docs/how-it-works.md)
- [History Systems](docs/history-systems.md)
- [Input Params Schema](docs/input-params-schema.md)
- [BREP Model and Classes](docs/brep-model.md)
- [File Formats: Import and Export](docs/file-formats.md)
- [Plugins and Examples](docs/plugins.md)
- [Recent Inspector Improvements](docs/inspector-improvements.md)
- [Inspector](docs/inspector.md)

## Using as an npm package

- Install:
  - `pnpm add brep-io-kernel`
- Import options:
  - `import { BREP, PartHistory } from 'brep-io-kernel';`
  - `import { BREP } from 'brep-io-kernel/BREP';`
  - `import { PartHistory } from 'brep-io-kernel/PartHistory';`
  - `import { AssemblyConstraintHistory, AssemblyConstraintRegistry } from 'brep-io-kernel';`


## Dialog Screenshots

See [Dialog Screenshots](docs/dialog-screenshots.md) for the capture helpers, output locations, and configuration options.

## Application Mode Guides



- [Modeling Mode](docs/modes/modeling.md)
- [Sketch Mode](docs/modes/sketch.md)
- [PMI Mode](docs/modes/pmi.md)
- [Assembly Constraint Solver](docs/assembly-constraints/solver.md)

## Modeling Features

- [Primitive Cube](docs/features/primitive-cube.md) — Implemented
- [Primitive Cylinder](docs/features/primitive-cylinder.md) — Implemented
- [Primitive Cone](docs/features/primitive-cone.md) — Implemented
- [Primitive Sphere](docs/features/primitive-sphere.md) — Implemented
- [Primitive Torus](docs/features/primitive-torus.md) — Implemented
- [Primitive Pyramid](docs/features/primitive-pyramid.md) — Implemented
- [Plane](docs/features/plane.md) — Implemented
- [Datum](docs/features/datum.md) — Implemented
- [Sketch](docs/features/sketch.md) — Implemented
- [Extrude](docs/features/extrude.md) — Implemented
- [Sweep](docs/features/sweep.md) — Implemented
- [Tube](docs/features/tube.md) — Implemented
- [Loft](docs/features/loft.md) — Implemented
- [Revolve](docs/features/revolve.md) — Implemented
- [Mirror](docs/features/mirror.md) — Implemented
- [Boolean](docs/features/boolean.md) — Implemented
- [Fillet](docs/features/fillet.md) — Implemented
- [Chamfer](docs/features/chamfer.md) — Implemented
- [Remesh](docs/features/remesh.md) — Implemented
- [Import 3D Model (STL or 3MF)](docs/features/import-3d-model.md) — Implemented
- [Image to Face (image trace)](docs/features/image-to-face.md) — Implemented
- [Transform (move, rotate, scale)](docs/features/transform.md) — Implemented
- [Pattern Linear](docs/features/pattern-linear.md) — Implemented
- [Pattern Radial](docs/features/pattern-radial.md) — Implemented
- [Sheet Metal Tab](docs/features/sheet-metal-tab.md) — Implemented
- [Sheet Metal Contour Flange](docs/features/sheet-metal-contour-flange.md) — Implemented


## Assembly Constraints

Assemblies can be constrained with the iterative solver described in [Assembly Constraint Solver](docs/assembly-constraints/solver.md). Each constraint instance stores clear selections plus persistent solve data so runs resume quickly after edits. The constraint registry currently ships with:

- [Coincident](docs/assembly-constraints/coincident-constraint.md) – mates two datum points or implicit origins.
- [Distance](docs/assembly-constraints/distance-constraint.md) – fixes an offset between reference points along a chosen axis or free space.
- [Angle](docs/assembly-constraints/angle-constraint.md) – enforces a target angle between two axes or faces.
- [Parallel](docs/assembly-constraints/parallel-constraint.md) – locks component axes or normals into parallel alignment.
- [Touch Align](docs/assembly-constraints/touch-align-constraint.md) – slides surfaces until they touch and optionally shares tangency.
- [Fixed](docs/assembly-constraints/fixed-constraint.md) – anchors a component so downstream constraints treat it as immobile.

Adding, removing, or editing any of these entries queues an automatic background solve, and the UI exposes constraint status plus debugging messages pulled from each `persistentData` record.

## PMI annotations

PMI mode focuses on downstream manufacturing communication. Annotating the model augments the saved `.brep` history and the embedded 3MF metadata. The PMI tools mirror the dialog capture pages in `docs/pmi-annotations`:

- [Linear Dimension](docs/pmi-annotations/linear-dimension.md) – measures distances between vertices with alignment, offsets, and extension controls.
- [Radial Dimension](docs/pmi-annotations/radial-dimension.md) – reports diameter/radius for arcs, circles, and cylinders.
- [Angle Dimension](docs/pmi-annotations/angle-dimension.md) – dimension angular relationships across edges or faces.
- [Leader](docs/pmi-annotations/leader.md) – callouts with free-form text, arrowhead placement, and captured drag offsets.
- [Note](docs/pmi-annotations/note.md) – rich-text style annotations tied to PMI views without leader geometry.
- [Explode Body](docs/pmi-annotations/explode-body.md) – stores exploded-view offsets per component for presentation layouts.

Each annotation stores associative references and view metadata so reloading a part restores the PMI viewport, label placement, and formatting settings.

## License

See [LICENSE.md](LICENSE.md). This project uses a dual-licensing strategy managed by Autodrop3d LLC.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on submitting pull requests, reporting issues, and participating in discussions.
