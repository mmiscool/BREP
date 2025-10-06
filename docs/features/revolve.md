# Revolve

Status: Implemented

![Revolve feature dialog](revolve.png)

Revolve sweeps a face or sketch profile around an edge-defined axis to create lathe-style solids.

## Inputs
- `profile` – a face or sketch containing a face. Sketch parents are removed after the revolve is generated.
- `axis` – an edge that defines the rotation axis. The feature samples the edge polyline/geometry in world space.
- `angle` – revolution angle in degrees (0–360). Values below 360 create end caps.
- `boolean` – optional union/subtract/intersect against other solids.

## Behaviour
- Boundary loops are read from the profile’s metadata when available so holes remain aligned; otherwise edge polylines are sampled.
- The feature builds start/end caps for partial revolves and names side faces using the first profile’s edge labels.
- After the revolve solid is created the optional boolean helper runs. Consumed sketches and solids are flagged for removal automatically.
