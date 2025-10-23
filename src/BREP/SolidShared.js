import manifold from "./setupManifold.js";

import * as THREE from "three";
import { CADmaterials } from "../UI/CADmaterials.js";
import { Line2, LineGeometry } from "three/examples/jsm/Addons.js";

import Edge from "./Edge.js";
import Vertex from "./Vertex.js";
import Face from "./Face.js";

const { Manifold, Mesh: ManifoldMesh } = manifold;

const debugMode = false;

export { Edge, Vertex, Face };

export {
    manifold,
    Manifold,
    ManifoldMesh,
    THREE,
    CADmaterials,
    Line2,
    LineGeometry,
    debugMode,
};
