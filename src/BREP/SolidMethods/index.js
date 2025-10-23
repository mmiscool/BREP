export { constructorImpl, clone, free } from "./lifecycle.js";
export {
    _key,
    _getPointIndex,
    _getOrCreateID,
    addTriangle,
    addAuxEdge,
    addCenterline,
} from "./authoring.js";
export {
    setFaceMetadata,
    getFaceMetadata,
    getFaceNames,
    _combineFaceMetadata,
} from "./metadata.js";
export {
    bakeTransform,
    bakeTRS,
    offsetFace,
    mirrorAcrossPlane,
} from "./transforms.js";
export {
    _manifoldize,
    setEpsilon,
    _weldVerticesByEpsilon,
    fixTriangleWindingsByAdjacency,
    _isCoherentlyOrientedManifold,
    invertNormals,
} from "./manifoldOps.js";
export {
    removeSmallIslands,
    removeSmallInternalIslands,
    removeTinyBoundaryTriangles,
    remesh,
} from "./meshCleanup.js";
export {
    getMesh,
    _ensureFaceIndex,
    getFace,
    getFaces,
    getBoundaryEdgePolylines,
} from "./meshQueries.js";
export {
    union,
    subtract,
    intersect,
    difference,
    _combineIdMaps,
    _expandTriIDsFromMesh as _expandTriIDsFromMeshStatic,
    _fromManifold as _fromManifoldStatic,
    setTolerance,
    simplify,
} from "./booleanOps.js";
export { toSTL, writeSTL } from "./io.js";
export { volume, surfaceArea } from "./metrics.js";
export { default as visualize } from "./visualize.js";
