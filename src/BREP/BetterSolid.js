
/**
 * Solid: Authoring wrapper around manifold-3d Mesh/Manifold
 *
 * Requirements
 * - Environment: ES modules. For disk export (`writeSTL`) a Node.js runtime is required.
 * - Dependency: `setupManifold.js` must provide a ready-to-use `manifold` module
 *   exposing `{ Manifold, Mesh }` from `manifold-3d`.
 * - Geometry: Input triangles must describe a closed, watertight, 2‑manifold.
 *   The class includes helpers to fix triangle adjacency winding and will flip
 *   the entire mesh if overall orientation is inward, but it cannot repair
 *   topological holes or self-intersections.
 * - Vertex uniqueness: Vertices are uniqued by exact coordinate match
 *   (string key of `x,y,z`). If you author with floating tolerances, you must
 *   supply identical numeric values for shared vertices or change `_key()` to
 *   implement a tolerance strategy.
 *
 * Theory of Operation
 * - Authoring model:
 *   - Add triangles via `addTriangle(faceName, v1, v2, v3)`.
 *   - Each triangle stores three vertex indices in `_triVerts` and a per‑triangle
 *     face label ID in `_triIDs`. Face labels are mapped to globally unique
 *     IDs from `Manifold.reserveIDs()` so provenance persists through CSG.
 *   - Vertices are stored in `_vertProperties` in MeshGL layout `[x,y,z,...]`.
 *
 * - Manifold build (`_manifoldize`):
 *   - Before building, `fixTriangleWindingsByAdjacency()` enforces opposite
 *     orientation across shared edges; then a signed‑volume check flips all
 *     triangles if the mesh is inward‑facing.
 *   - A `Mesh` is constructed with `{ numProp, vertProperties, triVerts, faceID }`,
 *     where `faceID` is the per‑triangle label array. `mesh.merge()` is called
 *     to fill merge vectors when needed, then `new Manifold(mesh)` is created
 *     and cached until the authoring arrays change.
 *
 * - Provenance & queries:
 *   - After any boolean operation, Manifold propagates `faceID` so each output
 *     triangle keeps the original face label. `getFace(name)` and `getFaces()`
 *     read `mesh.faceID` to enumerate triangles by label (no planar grouping or
 *     merging), which supports faces comprised of many non‑coplanar triangles
 *     (e.g., cylinder side walls).
 *
 * - Boolean CSG:
 *   - `union`, `subtract`, `intersect` call Manifold’s CSG APIs on the cached
 *     Manifold objects and then rebuild a new Solid from the result. Face ID →
 *     name maps from both inputs are merged so all original labels remain
 *     available in the output.
 *
 * - Export:
 *   - `toSTL()` returns an ASCII STL string from the current Manifold mesh.
 *   - `writeSTL(path)` writes the STL to disk using a dynamic `fs` import so
 *     the module stays browser‑safe.
 *
 * Performance Notes
 * - Manifoldization is cached and only recomputed when authoring arrays change
 *   (`_dirty`). Face queries iterate triangles and filter by `faceID`, which is
 *   linear in triangle count.
 */
import {
    THREE,
    debugMode,
} from "./SolidShared.js";
import * as SolidMethods from "./SolidMethods/index.js";
export { Edge, Vertex, Face } from "./SolidShared.js";
/**
 * Solid
 * - Add triangles with a face name.
 * - Data is stored in Manifold's MeshGL layout (vertProperties, triVerts, faceID).
 * - Face names are mapped to globally-unique Manifold IDs so they propagate through boolean ops.
 * - Query triangles for a given face name after any CSG by reading runs back from MeshGL.
 */
export class Solid extends THREE.Group {
    constructor() {
        super(...arguments);
        SolidMethods.constructorImpl.apply(this, arguments);
    }

    bakeTransform(matrix) {
        return SolidMethods.bakeTransform.apply(this, arguments);
    }

    bakeTRS(trs) {
        return SolidMethods.bakeTRS.apply(this, arguments);
    }

    _key([x, y, z]) {
        return SolidMethods._key.apply(this, arguments);
    }

    _getPointIndex(p) {
        return SolidMethods._getPointIndex.apply(this, arguments);
    }

    _getOrCreateID(faceName) {
        return SolidMethods._getOrCreateID.apply(this, arguments);
    }

    addTriangle(faceName, v1, v2, v3) {
        return SolidMethods.addTriangle.apply(this, arguments);
    }

    addAuxEdge(name, points, options = {}) {
        return SolidMethods.addAuxEdge.apply(this, arguments);
    }

    addCenterline(a, b, name = 'CENTERLINE', options = {}) {
        return SolidMethods.addCenterline.apply(this, arguments);
    }

    setFaceMetadata(faceName, metadata) {
        return SolidMethods.setFaceMetadata.apply(this, arguments);
    }

    getFaceMetadata(faceName) {
        return SolidMethods.getFaceMetadata.apply(this, arguments);
    }

    remesh({ maxEdgeLength, maxIterations = 10 } = {}) {
        return SolidMethods.remesh.apply(this, arguments);
    }

    removeSmallIslands({ maxTriangles = 30, removeInternal = true, removeExternal = true } = {}) {
        return SolidMethods.removeSmallIslands.apply(this, arguments);
    }

    removeSmallInternalIslands(maxTriangles = 30) {
        return SolidMethods.removeSmallInternalIslands.apply(this, arguments);
    }

    mirrorAcrossPlane(point, normal) {
        return SolidMethods.mirrorAcrossPlane.apply(this, arguments);
    }

    pushFace(faceName, distance) {
        return SolidMethods.pushFace.apply(this, arguments);
    }

    removeTinyBoundaryTriangles(areaThreshold, maxIterations = 1) {
        return SolidMethods.removeTinyBoundaryTriangles.apply(this, arguments);
    }

    collapseTinyTriangles(lengthThreshold) {
        return SolidMethods.collapseTinyTriangles.apply(this, arguments);
    }

    invertNormals() {
        return SolidMethods.invertNormals.apply(this, arguments);
    }

    fixTriangleWindingsByAdjacency() {
        return SolidMethods.fixTriangleWindingsByAdjacency.apply(this, arguments);
    }

    _isCoherentlyOrientedManifold() {
        return SolidMethods._isCoherentlyOrientedManifold.apply(this, arguments);
    }

    setEpsilon(epsilon = 0) {
        return SolidMethods.setEpsilon.apply(this, arguments);
    }

    clone() {
        return SolidMethods.clone.apply(this, arguments);
    }

    _weldVerticesByEpsilon(eps) {
        return SolidMethods._weldVerticesByEpsilon.apply(this, arguments);
    }

    _manifoldize() {
        return SolidMethods._manifoldize.apply(this, arguments);
    }

    getMesh() {
        return SolidMethods.getMesh.apply(this, arguments);
    }

    free() {
        return SolidMethods.free.apply(this, arguments);
    }

    offsetFace(faceName, distance) {
        return SolidMethods.offsetFace.apply(this, arguments);
    }

    _ensureFaceIndex() {
        return SolidMethods._ensureFaceIndex.apply(this, arguments);
    }

    getFace(name) {
        return SolidMethods.getFace.apply(this, arguments);
    }

    getFaceNames() {
        return SolidMethods.getFaceNames.apply(this, arguments);
    }

    toSTL(name = "solid", precision = 6) {
        return SolidMethods.toSTL.apply(this, arguments);
    }

    async writeSTL(filePath, name = "solid", precision = 6) {
        return SolidMethods.writeSTL.apply(this, arguments);
    }

    getFaces(includeEmpty = false) {
        return SolidMethods.getFaces.apply(this, arguments);
    }

    visualize(options = {}) {
        return SolidMethods.visualize.apply(this, arguments);
    }

    getBoundaryEdgePolylines() {
        return SolidMethods.getBoundaryEdgePolylines.apply(this, arguments);
    }

    _combineIdMaps(other) {
        return SolidMethods._combineIdMaps.apply(this, arguments);
    }

    _combineFaceMetadata(other) {
        return SolidMethods._combineFaceMetadata.apply(this, arguments);
    }

    static _expandTriIDsFromMesh(mesh) {
        return SolidMethods._expandTriIDsFromMeshStatic.apply(this, arguments);
    }

    static _fromManifold(manifoldObj, idToFaceName) {
        return SolidMethods._fromManifoldStatic.apply(this, arguments);
    }

    union(other) {
        return SolidMethods.union.apply(this, arguments);
    }

    subtract(other) {
        return SolidMethods.subtract.apply(this, arguments);
    }

    intersect(other) {
        return SolidMethods.intersect.apply(this, arguments);
    }

    difference(other) {
        return SolidMethods.difference.apply(this, arguments);
    }

    simplify(tolerance = undefined) {
        return SolidMethods.simplify.apply(this, arguments);
    }

    setTolerance(tolerance) {
        return SolidMethods.setTolerance.apply(this, arguments);
    }

    volume() {
        return SolidMethods.volume.apply(this, arguments);
    }

    surfaceArea() {
        return SolidMethods.surfaceArea.apply(this, arguments);
    }

    getTriangleCount() {
        return SolidMethods.getTriangleCount.apply(this, arguments);
    }

    /**
     * Split any self-intersecting triangle pairs in-place.
     * Replaces the original triangles with subdivided triangles while
     * preserving per-triangle face IDs. Operates on authoring arrays
     * (_vertProperties/_triVerts/_triIDs) and marks the solid dirty.
     */
    splitSelfIntersectingTriangles() {
        return SolidMethods.splitSelfIntersectingTriangles.apply(this, arguments);
    }

    /**
     * Remove degenerate triangles (triangles with duplicate or collinear vertices).
     * Returns the number of triangles removed.
     */
    removeDegenerateTriangles() {
        return SolidMethods.removeDegenerateTriangles.apply(this, arguments);
    }

    /**
     * Remove internal triangles by rebuilding from the Manifold surface.
     * Keeps only exterior triangles, preserving face IDs. In-place.
     * Returns the number of triangles removed.
     */
    removeInternalTriangles() {
        return SolidMethods.removeInternalTriangles.apply(this, arguments);
    }

    /**
     * Remove internal triangles using a raycast point-in-solid test.
     * Works even on non-manifold authoring meshes. In-place.
     * Returns the number of triangles removed.
     */
    removeInternalTrianglesByRaycast() {
        return SolidMethods.removeInternalTrianglesByRaycast.apply(this, arguments);
    }

    /**
     * Remove internal triangles using solid-angle (winding number) test.
     * Robust to self-intersections; does not require manifold. In-place.
     */
    removeInternalTrianglesByWinding(options = {}) {
        return SolidMethods.removeInternalTrianglesByWinding.apply(this, [options]);
    }

    fillet(options = {}) {
        return SolidMethods.fillet.apply(this, [options]);
    }
}

// Helper to include the owning feature ID in Solid profiling logs
const __solidProfilingOwnerTag = (solidInstance) => {
    try {
        const owner = solidInstance?.owningFeatureID ?? solidInstance?.ID ?? null;
        return owner ? ` owningFeature=${owner}` : '';
    } catch {
        return '';
    }
};

const __solidSlowMethodThresholdMs = 1000;

const __solidProfilingFormatMessage = (prefix, methodName, phase, durationMs) => {
    const rounded = Math.round(durationMs);
    const label = `${prefix} ${methodName}`;
    switch (phase) {
        case 'resolved': return `${label} resolved in ${rounded} ms`;
        case 'rejected': return `${label} rejected in ${rounded} ms`;
        case 'completed': return `${label} in ${rounded} ms`;
        case 'threw': return `${label} threw in ${rounded} ms`;
        default: return null;
    }
};

const __solidProfilingLogTiming = (prefix, methodName, phase, durationMs) => {
    const message = __solidProfilingFormatMessage(prefix, methodName, phase, durationMs);
    if (!message) return;
    if (debugMode) {
        try { console.log(message); } catch { }
    }
    if (durationMs >= __solidSlowMethodThresholdMs) {
        const slowMsg = `${message} (SLOW > ${__solidSlowMethodThresholdMs} ms)`;
        try {
            if (typeof console !== 'undefined') {
                const warnFn = (typeof console.warn === 'function')
                    ? console.warn
                    : (typeof console.log === 'function' ? console.log : null);
                if (warnFn) warnFn.call(console, slowMsg);
            }
        } catch { }
    }
};

// --- Method-level time profiling for Solid -----------------------------------
// Wrap all prototype methods (except constructor and _manifoldize, which is
// already instrumented) to log execution time when debugMode is true, and
// always flag calls that exceed __solidSlowMethodThresholdMs.
(() => {
    try {
        if (Solid.__profiled) return;
        Solid.__profiled = true;
        const nowMs = () => (typeof performance !== 'undefined' && performance?.now ? performance.now() : Date.now());
        const skip = new Set(['constructor', '_manifoldize']);
        const proto = Solid.prototype;
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (skip.has(name)) continue;
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            if (!desc || typeof desc.value !== 'function') continue;
            const fn = desc.value;
            const wrapped = function (...args) {
                const prefix = `[Solid${__solidProfilingOwnerTag(this)}]`;
                const t0 = nowMs();
                const logPhase = (phase) => {
                    const duration = nowMs() - t0;
                    __solidProfilingLogTiming(prefix, name, phase, duration);
                };
                try {
                    const ret = fn.apply(this, args);
                    if (ret && typeof ret.then === 'function') {
                        return ret.then(
                            (val) => { logPhase('resolved'); return val; },
                            (err) => { logPhase('rejected'); throw err; }
                        );
                    }
                    logPhase('completed');
                    return ret;
                } catch (e) {
                    logPhase('threw');
                    throw e;
                }
            };
            try { Object.defineProperty(wrapped, 'name', { value: name, configurable: true }); } catch { }
            Object.defineProperty(proto, name, { ...desc, value: wrapped });
        }
    } catch { }
})();

// --- Example usage -----------------------------------------------------------
// Build a 10 x 10 x w box by triangles, naming each face.
// Then query triangles for a face and perform a boolean op.

if (import.meta && import.meta.url && typeof window === "undefined") {
    // If running under Node for a quick test, you can comment this guard and log outputs.
}
