# Assembly Constraint Solver

Status: Implemented

The assembly constraint solver manages constraint instances attached to an assembly and iteratively applies translations or rotations until every constraint reports that it is satisfied (or until the iteration budget is exhausted). It lives alongside the constraint implementations in `src/assemblyConstraints` and mirrors the documentation pattern already used for PMI annotations.

## Key Files
- `src/assemblyConstraints/AssemblyConstraintHistory.js` – orchestrates constraint storage, scheduling, and the iterative solve loop.
- `src/assemblyConstraints/AssemblyConstraintRegistry.js` – registers built-in constraint classes and resolves aliases.
- `src/assemblyConstraints/BaseAssemblyConstraint.js` – base class that exposes shared helpers and metadata conventions for concrete constraints.

## Runtime Flow
- Every constraint entry carries a `type`, `inputParams`, and `persistentData`. Defaults come from the constraint's `inputParamsSchema`, and each entry receives an auto-generated `id` (for example `COIN12`).
- `AssemblyConstraintHistory.runAll()` is the primary entry point. It validates entries, removes disabled constraints, detects duplicates before instantiating anything, and then constructs one runtime instance per constraint.
- During each iteration the solver calls `solve(context)` (or `run(context)` for legacy classes) on every instance. A constraint may mark itself satisfied, request additional adjustments, or block if both components are fixed.
- When a constraint applies a motion it must call `context.applyTranslation(component, vector)` or `context.applyRotation(component, quaternion)`, both of which update the component transform and record that the component needs to be synced back to feature data.
- The loop stops early if an iteration makes no changes, if all constraints are satisfied, or if an abort signal supplied through the controller is triggered.
- After the run completes, persistent data (status, message, last applied moves, etc.) is merged back into the stored constraint entries so the UI reflects the latest state.

## Solver Context
Each constraint receives the same runtime context object. The most frequently used fields are:
- `tolerance`, `translationGain`, and `rotationGain` – clamped values supplied through solver options to moderate how aggressively each constraint moves parts.
- `resolveObject(selection)` and `resolveComponent(selection)` – turn serialized selection info back into scene objects or assembly components.
- `applyTranslation(component, THREE.Vector3)` and `applyRotation(component, THREE.Quaternion)` – helpers that mutate component transforms and keep the solver's bookkeeping in sync.
- `isComponentFixed(component)` – reports whether a component is already locked by a Fixed constraint or by feature metadata.
- `renderScene()` and `viewer` – allow constraints or debug hooks to request a redraw between iterations.
- `debugMode` – when true, constraint implementations may emit temporary helpers (for example normal arrows).

## Hooks, Scheduling, and Debugging
- `runAll()` accepts an optional controller with an abort `signal` and `hooks` object. The solver will attempt to invoke `onStart`, `onIterationStart`, `onConstraintStart`, `onConstraintEnd`, `onConstraintSkipped`, `onIterationComplete`, and `onComplete` at appropriate times.
- Adding, removing, or editing constraints schedules an automatic background solve via `AssemblyConstraintHistory.#scheduleAutoRun()`. The auto-run uses the default tolerance, gain, and iteration count unless the caller overrides them.
- Duplicate detection (`checkConstraintErrors()` and `#detectDuplicateConstraints()`) ensures identical selections are not solved twice; duplicates inherit a `status: 'duplicate'` result and are skipped during the run.
- Constraint implementations may stash arbitrary data (for example `lastAppliedMoves`) inside `persistentData`; the solver copies those fields back onto the stored entry after each run so the UI can display progress.

## Constraint Catalog
Built-in constraints are registered in the registry and documented individually:
- [Angle Constraint](angle-constraint.md)
- [Coincident Constraint](coincident-constraint.md)
- [Distance Constraint](distance-constraint.md)
- [Fixed Constraint](fixed-constraint.md)
- [Parallel Constraint](parallel-constraint.md)
- [Touch Align Constraint](touch-align-constraint.md)

## Adding Components for Constraints
Assembly constraints operate on `AssemblyComponent` instances, not ad-hoc solids. Add every part to the assembly using the [Assembly Component](../features/assembly-component.md) feature first; this inserts the 3MF-backed component into the assembly graph, preserves face/body naming for selections, and exposes the transform that constraints manipulate. Solids added by other modeling features won’t participate in the constraint solver until they’re brought in as assembly components.
