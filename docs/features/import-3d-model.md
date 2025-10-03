# Import 3D Model

Status: Implemented

The Import 3D Model feature accepts STL or 3MF data, detects the format automatically, and rebuilds the geometry into an editable solid. When feature history is embedded inside a 3MF, BREP restores it so you can keep editing within the history tree.

## Workflow
- Add an Import 3D Model feature to the history timeline or use the top toolbar Import button.
- Drop in STL or 3MF data from a file picker, URL string, or ArrayBuffer; the feature identifies the format for you.
- After loading, optional centering and mesh repair passes run before the solid is emitted into the part.

## Supported Formats
- **STL**: ASCII or binary. Parsed with `three/examples/jsm/loaders/STLLoader.js` and imported as geometry only.
- **3MF**: ZIP based. Parsed with `three/examples/jsm/loaders/3MFLoader.js`, merged into a single editable mesh, and checked for embedded feature history.
- **BREP JSON**: History-only saves that can be restored to rebuild the model exactly as authored.

## History Preservation
When a 3MF contains `Metadata/featureHistory.json`, the importer hydrates the timeline rather than just the mesh. That makes imported features editable and keeps downstream selections stable.

## Programmatic Example
```js
import { PartHistory } from './src/PartHistory.js';

const history = new PartHistory();
const feature = await history.newFeature('IMPORT3D');
feature.inputParams.fileToImport = someStlOr3mfData;
feature.inputParams.deflectionAngle = 15; // degrees used to cluster triangles into faces
await history.runHistory();
```

## Repair Pipeline
After parsing, the importer can weld vertices, fix T-junctions, remove overlaps, fill holes, and enforce consistent normals. Triangles are then grouped into faces by deflection angle before being authored into a `Solid` for use with the Manifold CSG kernel.
