
import { Edge, Face, Solid } from "./BetterSolid.js";
import { Cube, Pyramid, Sphere, Cylinder, Cone, Torus } from "./primitives.js";
import { Sweep} from "./Sweep.js";
import { ChamferSolid } from "./chamfer.js";
import { ExtrudeSolid } from "./Extrude.js";
import { FilletSolid } from "./fillet.js";

export const BREP = {
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
    FilletSolid
}
