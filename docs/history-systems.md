# History Systems

BREP keeps several independent “history” timelines so modeling, PMI, and assembly constraint editing can all replay their steps deterministically. Each history owns the data it needs to recompute results but follows a shared pattern: store a list of entries, redo work by iterating through that list, and serialize just the declarative inputs plus any persistent outputs.

## Shared building blocks

- `ListEntityBase` (`src/core/entities/ListEntityBase.js`) standardizes the three buckets found across every history entry: `inputParams` (user-editable data), `persistentData` (saved outputs), and `runtimeAttributes` (ephemeral session state).
- `HistoryCollectionBase` (`src/core/entities/HistoryCollectionBase.js`) provides the minimal scaffolding for history managers: it keeps the `entries` array, an `entityClassRegistry`, listener bookkeeping, and a monotonically increasing `_idCounter`. PMI annotations inherit from this base directly, while the other histories implement the same shape manually for flexibility.
- Registries translate user-facing strings into constructors. Modeling relies on `FeatureRegistry`, PMI uses `AnnotationRegistry`, and assembly uses `AssemblyConstraintRegistry`. Every registry exposes tolerant lookups (`getSafe`) so importing legacy files or plugins does not blow up the run loop.
- Each history exposes `toSerializable`/`toJSON` style helpers that deep-clone fields suitable for storage (3MF metadata, `.BREP.json` dumps, etc.) and matching load/replace helpers so the UI can restore state without bespoke glue.

## Part History (Modeling)

`PartHistory` (`src/PartHistory.js:20`) is the backbone of modeling mode. It wires together the feature registry, the shared Three.js scene, PMI views, metadata, and the assembly constraint history.

- Constructor duties include initializing `features`, `scene`, registries, `PMIViewsManager`, and a default expression scratchpad (`src/PartHistory.js:20-38`). The class also injects a soft override on `scene.add/remove` so debugging geometry churn is possible.
- `runHistory()` iterates over `features`, lazily instantiates the correct feature class, sanitizes inputs, tracks “dirty” state, runs the feature, and records timestamps plus error metadata (`src/PartHistory.js:120-280`). Clearing happens up front so each rerun rebuilds the scene from a clean slate.
- `newFeature()` allocates the declarative entry object `{ type, inputParams, persistentData }`, seeds defaults via `extractDefaultValues`, and assigns a unique `id` produced by `generateId()` (`src/PartHistory.js:642-654`). `sanitizeInputParams()` later evaluates expressions, resolves reference selections back into live scene objects, and normalizes booleans, vectors, transforms, or boolean-operation payloads (`src/PartHistory.js:665-758`).
- Dialog field types, defaults, and selection filters come from each entry’s `inputParamsSchema`; see [Input Params Schema](./input-params-schema.md) for every widget option.
- `toJSON()` exports the bare inputs for every feature, expression code, PMI views, metadata, and a snapshot of the assembly constraint history (`src/PartHistory.js:426-455`). `fromJSON()` performs the inverse and forwards constraint payloads into `AssemblyConstraintHistory.replaceAll()` so the solver can pick up where it left off (`src/PartHistory.js:457-478`).
- File manager save/load uses the JSON helper to embed the complete part history (including PMI and constraints) inside a 3MF metadata entry (`src/UI/fileManagerWidget.js:248-320`), ensuring a single file captures all three timelines.

## PMI Annotation History

PMI mode keeps its own list of annotations per saved PMI view. `AnnotationHistory` (`src/UI/pmi/AnnotationHistory.js:9`) extends `HistoryCollectionBase` so it inherits the listener set, `_idCounter`, and serializable entry helpers.

- On construction, it registers every available annotation handler with the underlying registry and remembers the active `PMIMode` viewer (`src/UI/pmi/AnnotationHistory.js:9-20`). `PMIMode` wires this up whenever a PMI view is opened so annotation changes stay scoped to that view (`src/UI/pmi/PMIMode.js:66-88`).
- `load()` and `toSerializable()` deep-clone the stored annotation descriptors, strip runtime-only flags (like accordion open state), and keep the declarative input payloads tiny for 3MF persistence (`src/UI/pmi/AnnotationHistory.js:23-55`).
- `createAnnotation()` looks up the handler via `AnnotationRegistry`, merges schema defaults with the caller-provided seed, assigns a generated ID, and marks runtime flags like `__open` or `enabled` (`src/UI/pmi/AnnotationHistory.js:95-129`). Because annotations subclass `ListEntityBase`, they expose a `run()` method that PMIMode calls when rebuilding temporary geometry, but only their inputs/persistent data get serialized.
- Helpers such as `setAnnotationEnabled()`, `moveUp()/moveDown()`, and `clear()` are thin wrappers around `entries` mutations that also emit listener events to refresh the PMI widget (`src/UI/pmi/AnnotationHistory.js:84-159`).

## Assembly Constraint History

`AssemblyConstraintHistory` (`src/assemblyConstraints/AssemblyConstraintHistory.js:168-188`) mirrors the modeling history but focuses on constraint records and solver execution.

- The constructor receives the owning `PartHistory` plus a registry and sets up arrays, listeners, and auto-run bookkeeping. Internally it normalizes constraint IDs, links runtime attributes (open state, entity references), and keeps `constraintClass` pointers on each entry so the solver can call static helpers like `applyParams`.
- `snapshot()` and `replaceAll()` provide the serialization surface. `snapshot()` deep-clones `type`, `inputParams`, and `persistentData` so `PartHistory.toJSON()` can embed the full constraint set (`src/assemblyConstraints/AssemblyConstraintHistory.js:512-546`). `replaceAll()` rebuilds the constraints array from imported JSON, copies schema defaults, rehydrates runtime links, and rebuilds the ID counter before notifying listeners (`src/assemblyConstraints/AssemblyConstraintHistory.js:512-620`).
- `generateId()` encodes the constraint type into the prefix (e.g., `DISTANCE1`) so UI rows remain human-readable even after reordering (`src/assemblyConstraints/AssemblyConstraintHistory.js:741-748`).
- `runAll()` is the high-level solver. It pulls the active `PartHistory`, crawls the scene to resolve constraint selections, applies translation/rotation corrections with configurable gains, and emits viewer render hooks for debugging (`src/assemblyConstraints/AssemblyConstraintHistory.js:749-860`). The helper integrates with controller hooks so UI widgets can report progress or cancel iterations.
- Error checking (`checkConstraintErrors()`), duplicate detection, and auto-run scheduling keep the timeline responsive; listener callbacks keep the assembly constraint widget UI synchronized whenever entries change.

## Using the histories together

Part history is the orchestrator: it owns the Three.js scene and instantiates both PMI and assembly histories. Each PMI view stores a serialized annotation history entry, and every part export bundles feature inputs + annotation descriptors + constraint graph. Because all three systems follow the same entry/persistent-data conventions, plugins or new tools can treat them uniformly—populate `inputParams`, call the relevant history manager, and rely on the shared JSON helpers to persist the result.
