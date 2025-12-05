# File Formats: Import and Export

## 3MF (Feature Aware)
- **Export**: Generates a 3MF container that includes triangulated geometry plus an embedded copy of the feature history at `Metadata/featureHistory.json`. PMI views (camera, view settings, and annotations) are part of that history, and when views exist the exporter also writes labeled PNG captures to `/views/<view-name>.png` with relationships from the package root. Multiple solids export as separate objects in a single file. Units are configurable (default millimeter). Non-manifold solids are skipped with a notification, but the export proceeds.
- **Import**: Loads 3MF files and restores the embedded feature history when present. If no history is stored, the geometry imports as editable mesh only.
- **Compatibility**: The extra history metadata is ignored by other 3MF viewers, but the file remains valid.

## STL
- **Export**: Writes ASCII STL. If multiple solids are selected, the dialog produces a ZIP archive with one STL per solid. Unit scaling applies at export time.
- **Import**: Supports ASCII or binary STL. Imports as geometry only without feature history.

## OBJ
- **Export**: Writes ASCII OBJ (ZIP with one OBJ per solid when multiple bodies are selected). Unit scaling applies at export time.

## BREP JSON
- **Export**: Saves the feature history only as JSON (`.BREP.json`) with no mesh data. Useful for versioning or quick backups.
- **Import**: Reloads the saved history and recomputes the model.

## Implementation Notes
- 3MF exporter lives at `src/exporters/threeMF.js` and packages geometry plus attachments through JSZip.
- Export dialog logic resides in `src/UI/toolbarButtons/exportButton.js`.
- Import button handling lives in `src/UI/toolbarButtons/importButton.js`.
- Feature history is embedded directly as JSON without XML conversion.
- Face labels carry through export via per-object BaseMaterials, providing human-readable names in other tools. Materials and textures are not reconstructed on import.
