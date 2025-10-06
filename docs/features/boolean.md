# Boolean

Status: Implemented

![Boolean feature dialog](boolean.png)

Boolean combines existing solids by running Manifold CSG through `BREP.applyBooleanOperation`. The feature keeps face labels intact so downstream selections survive.

## Inputs
- `targetSolid` – the solid that supplies the base body for UNION/INTERSECT operations.
- `boolean.targets` – additional solids to use as tools. Duplicate entries are ignored.
- `boolean.operation` – `UNION`, `SUBTRACT`, or `INTERSECT`. `NONE` leaves the scene unchanged.

## Behaviour
- UNION and INTERSECT treat the target as the base body and remove the original target from the scene once the new solid is created.
- SUBTRACT unions all tool solids first, then removes that volume from the target so complex multi-tool cuts stay watertight.
- Each tool and the original target solid is flagged for removal after the operation; only the new solids returned by the kernel remain in the timeline.
