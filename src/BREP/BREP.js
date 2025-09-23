
import { Edge, Face, Solid } from "./BetterSolid.js";
import { Cube, Pyramid, Sphere, Cylinder, Cone, Torus } from "./primitives.js";
import { Sweep } from "./Sweep.js";
import { ChamferSolid } from "./chamfer.js";
import { ExtrudeSolid } from "./Extrude.js";
import { FilletSolid } from "./fillet.js";
import { applyBooleanOperation } from "./applyBooleanOperation.js";
import { MeshToBrep } from "./meshToBrep.js";
import { MeshRepairer } from "./MeshRepairer.js";
import * as THREE from 'three';

export const BREP = {
    THREE,
    Solid,
    Face,
    Edge,
    Cube,
    Pyramid,
    Sphere,
    Cylinder,
    Cone,
    Torus,
    Sweep,
    ExtrudeSolid,
    ChamferSolid,
    FilletSolid,
    applyBooleanOperation,
    MeshToBrep,
    MeshRepairer,

}
