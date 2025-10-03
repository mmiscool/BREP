# Sketch

Status: Implemented

Sketch stores 2D geometry in feature-persistent data and visualises it on a selected plane or face.

## Inputs
- `sketchPlane` – face or datum plane that defines the sketch basis. The plane orientation updates automatically when the reference moves.
- `Edit Sketch` – opens the in-app sketcher (`viewer.startSketchMode`) so you can add points, curves, and constraints.
- `curveResolution` – tessellation setting used when generating circular geometry for downstream features.

## Behaviour
- The feature builds a local coordinate frame from the selected plane, saves it in persistent data, and reuses it on every regenerate so the sketch tracks its reference.
- Sketch geometry is kept as JSON, solved through the `ConstraintEngine`, and rendered as a `SKETCH` group containing faces and edges that other features (Extrude, Revolve, Sweep) can consume.
- External references are projected into sketch space at regenerate time and expression-backed dimensions are evaluated before solving.
