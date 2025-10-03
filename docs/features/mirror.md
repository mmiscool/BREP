# Mirror

Status: Implemented

Mirror clones the selected solids and reflects the copies across a reference plane or face.

## Inputs
- `solids` – one or more solids to mirror.
- `mirrorPlane` – a face or datum plane that supplies the mirror origin and normal. Plane meshes use their +Z direction.
- `offsetDistance` – optional signed offset applied along the plane normal before mirroring.

## Behaviour
- Each source solid is cloned, mirrored via `Solid.mirrorAcrossPlane`, and retagged so face names remain unique (`::FeatureID` suffix).
- The original solids are left in place; only the mirrored copies are returned. Use a downstream boolean if you need to join the results.
