# What's New

## 3D Model Import Improvements
- Import button favors 3MF with embedded feature history and falls back to geometry-only files when needed. BREP JSON remains supported for history-only import.
- Import 3D Model feature auto-detects STL versus 3MF from strings, data URLs, or ArrayBuffers. 3MFs merge to a single editable mesh; STLs import as geometry only.
- File Manager save and load now use compact 3MF with embedded feature history and a thumbnail. Legacy JSON stays compatible for older saves.

## Image to Face and Image Editor
- "Edit Image" opens an in-app paint-style editor. If no image is set, it starts with a 300 x 300 white canvas.
- Editor UI prefers dark mode, renders at true 1:1 pixels with device pixel ratio awareness, and appears immediately on open.
- Resize handle on the bottom-right expands or crops the canvas while preserving edits.
- Brush improvements include live cursor outline, multiple shapes (round, square, diamond), and an eraser that respects the selected shape.
- Paint Bucket tool with tolerance slider (0-255) fills contiguous regions based on the composited image and applies paint only to the draw layer.
- Finish saves the edits back to the feature and triggers a recompute; Cancel discards edits.
