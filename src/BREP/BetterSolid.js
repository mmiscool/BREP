
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
    /**
     * Construct an empty Solid with authoring buffers, face/edge metadata, and aux-edge storage initialized.
     */
    constructor() {
        super(...arguments);
        SolidMethods.constructorImpl.apply(this, arguments);
    }

    /**
     * Bake a Matrix4 into authored vertices (and aux edges/metadata), marking the manifold dirty.
     * @param {THREE.Matrix4|{elements:number[]}} matrix Matrix or matrix-like object
     * @returns {Solid}
     */
    bakeTransform(matrix) {
        return SolidMethods.bakeTransform.apply(this, arguments);
    }

    /**
     * Compose TRS from `{ t, rDeg, s }` and bake it into authored geometry.
     * @param {{t?:number[],rDeg?:number[],s?:number[]}} trs TRS description in degrees
     * @returns {Solid}
     */
    bakeTRS(trs) {
        return SolidMethods.bakeTRS.apply(this, arguments);
    }

    /**
     * Internal: build the exact vertex deduplication key for a coordinate triple.
     * @param {[number,number,number]} param0
     * @returns {string}
     */
    _key([x, y, z]) {
        return SolidMethods._key.apply(this, arguments);
    }

    /**
     * Internal: fetch or create a vertex index for a point, validating finiteness.
     * @param {number[]|{x:number,y:number,z:number}} p
     * @returns {number} vertex index
     */
    _getPointIndex(p) {
        return SolidMethods._getPointIndex.apply(this, arguments);
    }

    /**
     * Internal: map a face name to a globally unique Manifold ID (creates if missing).
     * @param {string} faceName
     * @returns {number}
     */
    _getOrCreateID(faceName) {
        return SolidMethods._getOrCreateID.apply(this, arguments);
    }

    /**
     * Add a CCW triangle labeled with the given face name to the authoring buffers.
     * @param {string} faceName
     * @param {[number,number,number]} v1
     * @param {[number,number,number]} v2
     * @param {[number,number,number]} v3
     * @returns {Solid}
     */
    addTriangle(faceName, v1, v2, v3) {
        return SolidMethods.addTriangle.apply(this, arguments);
    }

    /**
     * Add an auxiliary polyline (e.g., centerline) to visualize alongside the solid.
     * @param {string} name
     * @param {Array<[number,number,number]>} points
     * @param {object} [options]
     * @param {boolean} [options.closedLoop=false] render as a closed loop when visualized
     * @param {boolean} [options.polylineWorld=false] whether points are already in world space
     * @param {'OVERLAY'|'BASE'|string} [options.materialKey='OVERLAY'] visualization material tag
     * @returns {Solid}
     */
    addAuxEdge(name, points, options = {}) {
        return SolidMethods.addAuxEdge.apply(this, arguments);
    }

    /**
     * Convenience helper to add a two-point centerline as an auxiliary edge.
     * @param {number[]|{x:number,y:number,z:number}} a
     * @param {number[]|{x:number,y:number,z:number}} b
     * @param {string} [name='CENTERLINE']
     * @param {object} [options]
     * @param {boolean} [options.closedLoop=false] render as a closed loop when visualized
     * @param {boolean} [options.polylineWorld=false] whether points are already in world space
     * @param {'OVERLAY'|'BASE'|string} [options.materialKey='OVERLAY'] visualization material tag
     * @returns {Solid}
     */
    addCenterline(a, b, name = 'CENTERLINE', options = {}) {
        return SolidMethods.addCenterline.apply(this, arguments);
    }

    /**
     * Merge and set metadata for a face label.
     * @param {string} faceName
     * @param {object} metadata
     * @returns {Solid}
     */
    setFaceMetadata(faceName, metadata) {
        return SolidMethods.setFaceMetadata.apply(this, arguments);
    }

    /**
     * Get metadata for a face label (empty object if none).
     * @param {string} faceName
     * @returns {object}
     */
    getFaceMetadata(faceName) {
        return SolidMethods.getFaceMetadata.apply(this, arguments);
    }

    /**
     * Rename a face; if the new name already exists, merge triangles/metadata into it.
     * @param {string} oldName
     * @param {string} newName
     * @returns {Solid}
     */
    renameFace(oldName, newName) {
        return SolidMethods.renameFace.apply(this, arguments);
    }

    /**
     * Merge and set metadata for a boundary edge label.
     * @param {string} edgeName
     * @param {object} metadata
     * @returns {Solid}
     */
    setEdgeMetadata(edgeName, metadata) {
        return SolidMethods.setEdgeMetadata.apply(this, arguments);
    }

    /**
     * Get metadata for a boundary edge label (null if none).
     * @param {string} edgeName
     * @returns {object|null}
     */
    getEdgeMetadata(edgeName) {
        return SolidMethods.getEdgeMetadata.apply(this, arguments);
    }

    /**
     * Remesh by splitting edges longer than a threshold; preserves face IDs and fixes winding.
     * @param {object} [options]
     * @param {number} options.maxEdgeLength maximum allowed edge length before splitting (required)
     * @param {number} [options.maxIterations=10] number of remesh passes to attempt
     * @returns {Solid}
     */
    remesh({ maxEdgeLength, maxIterations = 10 } = {}) {
        return SolidMethods.remesh.apply(this, arguments);
    }

    /**
     * Remove small disconnected triangle islands relative to the main shell.
     * @param {object} [options]
     * @param {number} [options.maxTriangles=30] triangle-count threshold for removal
     * @param {boolean} [options.removeInternal=true] drop islands inside the main shell
     * @param {boolean} [options.removeExternal=true] drop islands outside the main shell
     * @returns {number} triangles removed
     */
    removeSmallIslands({ maxTriangles = 30, removeInternal = true, removeExternal = true } = {}) {
        return SolidMethods.removeSmallIslands.apply(this, arguments);
    }

    /**
     * Remove only small internal islands (wrapper around removeSmallIslands).
     * @param {number} [maxTriangles=30]
     * @returns {number}
     */
    removeSmallInternalIslands(maxTriangles = 30) {
        return SolidMethods.removeSmallInternalIslands.apply(this, arguments);
    }

    /**
     * Mirror the solid across a plane defined by a point and a normal, returning a new Solid.
     * @param {number[]|THREE.Vector3} point
     * @param {number[]|THREE.Vector3} normal
     * @returns {Solid}
     */
    mirrorAcrossPlane(point, normal) {
        return SolidMethods.mirrorAcrossPlane.apply(this, arguments);
    }

    /**
     * Push a named face along its outward normal by the given distance.
     * @param {string} faceName
     * @param {number} distance
     * @returns {Solid}
     */
    pushFace(faceName, distance) {
        return SolidMethods.pushFace.apply(this, arguments);
    }

    /**
     * Remove tiny boundary-adjacent triangles via edge flips under an area threshold.
     * @param {number} areaThreshold
     * @param {number} [maxIterations=1]
     * @returns {number} flips applied
     */
    removeTinyBoundaryTriangles(areaThreshold, maxIterations = 1) {
        return SolidMethods.removeTinyBoundaryTriangles.apply(this, arguments);
    }

    /**
     * Collapse triangles whose shortest edge is below a threshold and clean up the mesh.
     * @param {number} lengthThreshold
     * @returns {number} edge collapses performed
     */
    collapseTinyTriangles(lengthThreshold) {
        return SolidMethods.collapseTinyTriangles.apply(this, arguments);
    }

    /**
     * Flip all triangle windings to invert normals and rebuild the manifold.
     * @returns {Solid}
     */
    invertNormals() {
        return SolidMethods.invertNormals.apply(this, arguments);
    }

    /**
     * Fix triangle winding coherency across shared edges.
     * @returns {Solid}
     */
    fixTriangleWindingsByAdjacency() {
        return SolidMethods.fixTriangleWindingsByAdjacency.apply(this, arguments);
    }

    /**
     * Check whether the authored mesh is a coherently oriented manifold.
     * @returns {boolean}
     */
    _isCoherentlyOrientedManifold() {
        return SolidMethods._isCoherentlyOrientedManifold.apply(this, arguments);
    }

    /**
     * Set vertex weld epsilon (<=0 disables) and optionally weld existing vertices.
     * @param {number} [epsilon=0]
     * @returns {Solid}
     */
    setEpsilon(epsilon = 0) {
        return SolidMethods.setEpsilon.apply(this, arguments);
    }

    /**
     * Create a lightweight clone of this Solid (copies geometry, labels, metadata, aux edges).
     * @returns {Solid}
     */
    clone() {
        return SolidMethods.clone.apply(this, arguments);
    }

    /**
     * Internal: weld vertices within epsilon using grid hashing and drop degenerates.
     * @param {number} eps
     * @returns {Solid}
     */
    _weldVerticesByEpsilon(eps) {
        return SolidMethods._weldVerticesByEpsilon.apply(this, arguments);
    }

    /**
     * Build (or reuse) the cached Manifold from authored arrays, fixing winding/orientation first.
     * @returns {import('./SolidShared.js').Manifold}
     */
    _manifoldize() {
        return SolidMethods._manifoldize.apply(this, arguments);
    }

    /**
     * Get a fresh MeshGL snapshot (`vertProperties`, `triVerts`, `faceID`) from the manifold.
     * @returns {import('./SolidShared.js').ManifoldMesh}
     */
    getMesh() {
        return SolidMethods.getMesh.apply(this, arguments);
    }

    /**
     * Dispose the cached Manifold to free wasm memory and mark the solid dirty.
     * @returns {Solid}
     */
    free() {
        return SolidMethods.free.apply(this, arguments);
    }

    /**
     * Offset all vertices of a named face along its average normal by a distance.
     * @param {string} faceName
     * @param {number} distance
     * @returns {Solid}
     */
    offsetFace(faceName, distance) {
        return SolidMethods.offsetFace.apply(this, arguments);
    }

    /**
     * Internal: build faceID -> triangle index cache if missing.
     * @returns {void}
     */
    _ensureFaceIndex() {
        return SolidMethods._ensureFaceIndex.apply(this, arguments);
    }

    /**
     * Get triangles belonging to a face label with positions and indices.
     * @param {string} name
     * @returns {Array<{faceName:string,indices:number[],p1:number[],p2:number[],p3:number[]}>}
     */
    getFace(name) {
        return SolidMethods.getFace.apply(this, arguments);
    }

    /**
     * List all face labels present on this solid.
     * @returns {string[]}
     */
    getFaceNames() {
        return SolidMethods.getFaceNames.apply(this, arguments);
    }

    /**
     * Generate an ASCII STL string for the current manifold mesh.
     * @param {string} [name='solid']
     * @param {number} [precision=6]
     * @returns {string}
     */
    toSTL(name = "solid", precision = 6) {
        return SolidMethods.toSTL.apply(this, arguments);
    }

    /**
     * Write an ASCII STL file to disk (Node.js only).
     * @param {string} filePath
     * @param {string} [name='solid']
     * @param {number} [precision=6]
     * @returns {Promise<string>} resolves with file path
     */
    async writeSTL(filePath, name = "solid", precision = 6) {
        return SolidMethods.writeSTL.apply(this, arguments);
    }

    /**
     * Enumerate faces with their triangles; optionally include empty labels.
     * @param {boolean} [includeEmpty=false]
     * @returns {Array<{faceName:string,triangles:any[]}>}
     */
    getFaces(includeEmpty = false) {
        return SolidMethods.getFaces.apply(this, arguments);
    }

    /**
     * Build per-face meshes and boundary edges as children for visualization.
     * @param {object} [options]
     * @param {boolean} [options.showEdges=true] include boundary edge polylines
     * @param {boolean} [options.forceAuthoring=false] force authoring arrays instead of manifold mesh
     * @param {boolean} [options.authoringOnly=false] skip manifold path entirely (fallback visualization)
     * @returns {void}
     */
    visualize(options = {}) {
        return SolidMethods.visualize.apply(this, arguments);
    }

    /**
     * Extract boundary polylines between differing face labels from the current mesh.
     * @returns {Array<{name:string,faceA:string,faceB:string,positions:number[][],indices:number[]}>}
     */
    getBoundaryEdgePolylines() {
        return SolidMethods.getBoundaryEdgePolylines.apply(this, arguments);
    }

    /**
     * Internal: merge face ID -> name maps from two solids (used during booleans).
     * @param {Solid} other
     * @returns {Map<number,string>}
     */
    _combineIdMaps(other) {
        return SolidMethods._combineIdMaps.apply(this, arguments);
    }

    /**
     * Internal: merge face metadata maps from two solids.
     * @param {Solid} other
     * @returns {Map<string,object>}
     */
    _combineFaceMetadata(other) {
        return SolidMethods._combineFaceMetadata.apply(this, arguments);
    }

    /**
     * Static helper: expand face IDs from a MeshGL into a JS array (or zeros when absent).
     * @param {import('./SolidShared.js').ManifoldMesh} mesh
     * @returns {number[]}
     */
    static _expandTriIDsFromMesh(mesh) {
        return SolidMethods._expandTriIDsFromMeshStatic.apply(this, arguments);
    }

    /**
     * Static helper: build a Solid from an existing Manifold and ID -> face-name map.
     * @param {import('./SolidShared.js').Manifold} manifoldObj
     * @param {Map<number,string>} idToFaceName
     * @returns {Solid}
     */
    static _fromManifold(manifoldObj, idToFaceName) {
        return SolidMethods._fromManifoldStatic.apply(this, arguments);
    }

    /**
     * Boolean union with another solid; merges face labels, metadata, and aux edges.
     * @param {Solid} other
     * @returns {Solid}
     */
    union(other) {
        return SolidMethods.union.apply(this, arguments);
    }

    /**
     * Boolean subtraction (this minus other); merges face labels, metadata, and aux edges.
     * @param {Solid} other
     * @returns {Solid}
     */
    subtract(other) {
        return SolidMethods.subtract.apply(this, arguments);
    }

    /**
     * Boolean intersection with another solid; merges face labels, metadata, and aux edges.
     * @param {Solid} other
     * @returns {Solid}
     */
    intersect(other) {
        return SolidMethods.intersect.apply(this, arguments);
    }

    /**
     * Boolean difference alias using Manifold.difference (same as subtract).
     * @param {Solid} other
     * @returns {Solid}
     */
    difference(other) {
        return SolidMethods.difference.apply(this, arguments);
    }

    /**
     * Simplify the manifold (optionally with tolerance and in-place update).
     * @param {number} [tolerance]
     * @param {boolean} [updateInPlace] when true, mutate this solid instead of returning a clone
     * @returns {Solid}
     */
    simplify(tolerance = undefined) {
        return SolidMethods.simplify.apply(this, arguments);
    }

    /**
     * Rebuild with Manifold tolerance applied, returning a new Solid.
     * @param {number} tolerance
     * @returns {Solid}
     */
    setTolerance(tolerance) {
        return SolidMethods.setTolerance.apply(this, arguments);
    }

    /**
     * Compute volume from the current manifold mesh.
     * @returns {number}
     */
    volume() {
        return SolidMethods.volume.apply(this, arguments);
    }

    /**
     * Compute total surface area from the current manifold mesh.
     * @returns {number}
     */
    surfaceArea() {
        return SolidMethods.surfaceArea.apply(this, arguments);
    }

    /**
     * Count triangles in the current manifold mesh.
     * @returns {number}
     */
    getTriangleCount() {
        return SolidMethods.getTriangleCount.apply(this, arguments);
    }

    /**
     * Split self-intersecting triangle pairs conservatively while preserving face IDs.
     * @param {boolean} [diagnostics=false]
     * @returns {number} splits applied
     */
    splitSelfIntersectingTriangles() {
        return SolidMethods.splitSelfIntersectingTriangles.apply(this, arguments);
    }

    /**
     * Remove triangles with duplicate or collinear vertices.
     * @returns {number} triangles removed
     */
    removeDegenerateTriangles() {
        return SolidMethods.removeDegenerateTriangles.apply(this, arguments);
    }

    /**
     * Rebuild authoring arrays from the manifold’s exterior surface, dropping internal faces.
     * @returns {number} triangles removed
     */
    removeInternalTriangles() {
        return SolidMethods.removeInternalTriangles.apply(this, arguments);
    }

    /**
     * Remove internal triangles via centroid ray tests without needing manifoldization.
     * @returns {number} triangles removed
     */
    removeInternalTrianglesByRaycast() {
        return SolidMethods.removeInternalTrianglesByRaycast.apply(this, arguments);
    }

    /**
     * Remove internal triangles using solid-angle (winding number) classification.
     * @param {object} [options]
     * @param {number} [options.offsetScale=1e-5] centroid offset scale relative to the model diagonal
     * @param {number} [options.crossingTolerance=0.05] tolerance for inside/outside crossing detection
     * @returns {number} triangles removed
     */
    removeInternalTrianglesByWinding(options = {}) {
        return SolidMethods.removeInternalTrianglesByWinding.apply(this, [options]);
    }

    /**
     * Merge faces smaller than the given area into their largest neighbor.
     * @param {number} [maxArea=0.001] area threshold
     * @returns {this}
     */
    mergeTinyFaces(maxArea = 0.001) {
        return SolidMethods.mergeTinyFaces.apply(this, arguments);
    }

    /**
     * Apply chamfers to named edges and return the booleaned result (async).
     * @param {object} [options]
     * @param {number} options.distance chamfer distance (required, > 0)
     * @param {string[]} [options.edgeNames] edge labels to chamfer
     * @param {any[]} [options.edges] pre-resolved Edge objects on this solid
     * @param {'INSET'|'OUTSET'|string} [options.direction='INSET'] subtract vs union behavior
     * @param {number} [options.inflate=0.1] tool inflation (negated for OUTSET)
     * @param {boolean} [options.debug=false] enable builder debug aids
     * @param {string} [options.featureID='CHAMFER'] name prefix for generated solids
     * @param {number} [options.sampleCount] optional sampling override for chamfer strip
     * @param {boolean} [options.snapSeamToEdge] force seam to snap to edge
     * @param {number} [options.sideStripSubdiv] side-strip subdivisions
     * @param {number} [options.seamInsetScale] inset scale for seam
     * @param {boolean} [options.flipSide] flip side selection
     * @param {number} [options.debugStride] sampling stride for debug output
     * @returns {Promise<Solid>}
     */
    chamfer(options = {}) {
        return SolidMethods.chamfer.apply(this, [options]);
    }

    /**
     * Apply constant-radius fillets to named edges and return the booleaned result (async).
     * @param {object} [options]
     * @param {number} options.radius fillet radius (required, > 0)
     * @param {string[]} [options.edgeNames] edge labels to fillet
     * @param {any[]} [options.edges] pre-resolved Edge objects on this solid
     * @param {'INSET'|'OUTSET'|string} [options.direction='INSET'] subtract vs union behavior
     * @param {number} [options.inflate=0.1] tube inflation for cutting/union
     * @param {number} [options.resolution=32] tube resolution (segments around circumference)
     * @param {boolean} [options.combineEdges=false] combine connected edges that share face pairs into single paths
     * @param {boolean} [options.debug=false] enable builder debug aids
     * @param {string} [options.featureID='FILLET'] name prefix for generated solids
     * @returns {Promise<Solid>}
     */
    fillet(options = {}) {
        return SolidMethods.fillet.apply(this, [options]);
    }


    /**
     * Getter to access current FACE children; triggers visualize() before returning them.
     * @returns {Array<any>}
     */
    get faces(){
        this.visualize();
        return this.children.filter(c=>c.type==='FACE');
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
