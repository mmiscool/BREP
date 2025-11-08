import { Manifold, ManifoldMesh, CrossSection } from "./setupManifold.js";

import * as THREE from "three";
import { CADmaterials } from "../UI/CADmaterials.js";
import { Line2, LineGeometry } from "three/examples/jsm/Addons.js";

import { Edge } from "./Edge.js";
import { Vertex } from "./Vertex.js";
import { Face } from "./Face.js";

// Use named exports from setupManifold.js

const debugMode = false;

export { Edge, Vertex, Face };

export {
    Manifold,
    ManifoldMesh,
    CrossSection,
    THREE,
    CADmaterials,
    Line2,
    LineGeometry,
    debugMode,
};
