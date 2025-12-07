# BREP Kernel Reference

This page catalogs the core classes and helpers that make up the BREP kernel (everything under `src/BREP`). Use it alongside `docs/solid-methods.md` for `Solid` details and `docs/brep-api.md` for the export map.

## Core types
- **Solid / Face / Edge / Vertex** – Geometry + selection primitives (`Solid` API in `docs/solid-methods.md`).
- **AssemblyComponent** – Groups one or more solids for the assembly constraint solver. Options: `{ name='Component', fixed=false }`.

## Primitives (`src/BREP/primitives.js`)
All extend `Solid` and immediately generate geometry.
- `Cube({ x=1, y=1, z=1, name })`
- `Pyramid({ bL=1, s=4, h=1, name })` (`s` is side count ≥ 3)
- `Sphere({ r=1, resolution=24, name })`
- `Cylinder({ radius=1, height=1, resolution=32, name })`
- `Cone({ r1=0.5, r2=1, h=1, resolution=32, name })`
- `Torus({ mR=2, tR=0.5, resolution=48, arcDegrees=360, name })`

## Feature solids
- **ExtrudeSolid** – `{ face, distance=1 | dir:Vector3, distanceBack=0, name='Extrude' }`.
- **Sweep** – `{ face, sweepPathEdges=[], distance=1, distanceBack=0, mode='translate', name='Sweep', omitBaseCap=false }`.
- **Revolve** – `{ face, axis, angle=360, resolution=64, name='Revolve' }`.
- **TubeSolid (Tube)** – `{ points=[], radius=1, innerRadius=0, resolution=32, closed=false, name='Tube' }`.
- **ChamferSolid** – `{ edgeToChamfer, distance=1, sampleCount=50, snapSeamToEdge=true, sideStripSubdiv=8, seamInsetScale=1e-3, direction='INSET'|'OUTSET', inflate=0, flipSide=false, debug=false, debugStride=12 }`.
- **OffsetShellSolid.generate(sourceSolid, distance, { newSolidName, featureId='OffsetShell' })** – Static helper to build offset shells.

## Fillet utilities (`src/BREP/fillets/fillet.js`)
- `filletSolid({ edgeToFillet, radius, sideMode='INSET'|'OUTSET', debug=false, name='fillet', inflate=0.1 })` – Returns tube/wedge/final fillet solid.
- `computeFilletCenterline(edgeObj, radius, sideMode)` – Returns centerline/tangent data.
- `attachFilletCenterlineAuxEdge(solid, edgeObj, radius, sideMode='INSET', name='FILLET_CENTERLINE', options)` – Adds centerline as an aux edge; `options` mirrors `Solid.addAuxEdge`.

## Boolean helper
- `applyBooleanOperation(partHistory, baseSolid, booleanParam, featureID)` – Runs `UNION|INTERSECT|SUBTRACT` between `baseSolid` and `booleanParam.targets` (objects or names). Returns `{ added, removed }`. Subtract semantics invert: each target subtracts the new base.

## Conversion and repair
- **MeshToBrep** – `new MeshToBrep(geometryOrMesh, faceDeflectionAngle=30, weldTolerance=1e-5)` groups triangles into faces based on normal deflection and welds shared vertices.
- **MeshRepairer** – Per-geometry repair pipeline:
  - `weldVertices(geometry, epsilon=1e-4)`
  - `fixTJunctions(geometry, lineEps=5e-4, gridCell=0.01)`
  - `removeOverlappingTriangles(geometry, posEps=1e-6)`
  - `fillHoles(geometry)`
  - `fixTriangleNormals(geometry)`
  - `repairAll(geometry, { weldEps=5e-4, lineEps=5e-4, gridCell=0.01 })`
- **Point cloud wrapper** – `buildTightPointCloudWrap(rawPoints, { padding=0.02*diag, alphaRadius=0.6*medianKNN })` builds a solid via marching cubes over a density field.

## Misc helpers
- **MeshToBrep**, **MeshRepairer**, **applyBooleanOperation**, **PointCloudWrap** live in `src/BREP` and are re-exported via `BREP.js` (`docs/brep-api.md`).
- **SolidMethod docs** – `docs/solid-methods.md` covers all core operations (authoring, cleanup, booleans, export).

## Example: boolean with primitives
```js
import { BREP } from '../src/BREP/BREP.js';

const box = new BREP.Cube({ x: 20, y: 10, z: 10, name: 'Box' });
const hole = new BREP.Cylinder({ radius: 3, height: 10, name: 'Hole' });
hole.position.set(10, 5, 0);
hole.bakeTransform(hole.matrixWorld);

const result = box.subtract(hole);
result.name = 'BoxWithHole';
result.visualize();
```
