import { Manifold } from "../SolidShared.js";

/**
 * Boolean operations and manifold reconstruction helpers.
 */

export function _combineIdMaps(other) {
    const merged = new Map(this._idToFaceName);
    for (const [id, name] of other._idToFaceName.entries()) {
        merged.set(id, name);
    }
    return merged;
}

export function union(other) {
    const Solid = this.constructor;
    const outManifold = Manifold.union(this._manifoldize(), other._manifoldize());
    const mergedMap = this._combineIdMaps(other);
    const out = Solid._fromManifold(outManifold, mergedMap);
    try { out._auxEdges = [...(this._auxEdges || []), ...(other?._auxEdges || [])]; } catch { }
    try { out._faceMetadata = this._combineFaceMetadata(other); } catch { }
    return out;
}

export function subtract(other) {
    const Solid = this.constructor;
    const outManifold = this._manifoldize().subtract(other._manifoldize());
    const mergedMap = this._combineIdMaps(other);
    const out = Solid._fromManifold(outManifold, mergedMap);
    try { out._auxEdges = [...(this._auxEdges || []), ...(other?._auxEdges || [])]; } catch { }
    try { out._faceMetadata = this._combineFaceMetadata(other); } catch { }
    return out;
}

export function intersect(other) {
    const Solid = this.constructor;
    const outManifold = Manifold.intersection(this._manifoldize(), other._manifoldize());
    const mergedMap = this._combineIdMaps(other);
    const out = Solid._fromManifold(outManifold, mergedMap);
    try { out._auxEdges = [...(this._auxEdges || []), ...(other?._auxEdges || [])]; } catch { }
    try { out._faceMetadata = this._combineFaceMetadata(other); } catch { }
    return out;
}

/**
 * Boolean difference A − B using Manifold's built-in API.
 * Equivalent to `subtract`, provided for semantic clarity.
 */
export function difference(other) {
    const Solid = this.constructor;
    const outManifold = Manifold.difference(this._manifoldize(), other._manifoldize());
    const mergedMap = this._combineIdMaps(other);
    const out = Solid._fromManifold(outManifold, mergedMap);
    try { out._auxEdges = [...(this._auxEdges || []), ...(other?._auxEdges || [])]; } catch { }
    try { out._faceMetadata = this._combineFaceMetadata(other); } catch { }
    return out;
}

export function setTolerance(tolerance) {
    const Solid = this.constructor;
    const m = this._manifoldize();
    const outM = m.setTolerance(tolerance);
    const mapCopy = new Map(this._idToFaceName);
    const out = Solid._fromManifold(outM, mapCopy);
    try { out._auxEdges = Array.isArray(this._auxEdges) ? this._auxEdges.slice() : []; } catch { }
    return out;
}
//3284
export function simplify(tolerance = undefined, updateInPlace = false) {
    const Solid = this.constructor;
    const m = this._manifoldize();

    // Log input manifold counts via MeshGL since Manifold does not expose numVerts/numFaces
    try {
        const meshIn = m.getMesh();
        try {
            const inVerts = (meshIn.vertProperties?.length || 0) / 3 | 0;
            const inFaces = (meshIn.triVerts?.length || 0) / 3 | 0;
            console.log(`Simplifying manifold with ${inVerts} vertices and ${inFaces} faces.`);
        } finally {
            try { if (meshIn && typeof meshIn.delete === 'function') meshIn.delete(); } catch { }
        }
    } catch { /* best-effort debug logging */ }

    // Run simplify on the manifold
    const outM = (tolerance === undefined) ? m.simplify() : m.simplify(tolerance);

    // Read back the simplified mesh and update this Solid in-place
    let meshOut = null;
    try {
        meshOut = outM.getMesh();
        const outVerts = (meshOut.vertProperties?.length || 0) / 3 | 0;
        const outFaces = (meshOut.triVerts?.length || 0) / 3 | 0;
        console.log(`Simplified manifold now has ${outVerts} vertices and ${outFaces} faces.`);

        // Replace geometry arrays
        this._numProp = meshOut.numProp;
        this._vertProperties = Array.from(meshOut.vertProperties);
        this._triVerts = Array.from(meshOut.triVerts);
        this._triIDs = Solid._expandTriIDsFromMesh(meshOut);

        // Rebuild vertex key map
        this._vertKeyToIndex = new Map();
        for (let i = 0; i < this._vertProperties.length; i += 3) {
            const x = this._vertProperties[i + 0];
            const y = this._vertProperties[i + 1];
            const z = this._vertProperties[i + 2];
            this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }

        // Keep existing face name map; best-effort completion for any new IDs
        const completeMap = new Map(this._idToFaceName);
        try {
            const ids = meshOut.faceID && meshOut.faceID.length ? meshOut.faceID : null;
            const triCount = (meshOut.triVerts?.length || 0) / 3 | 0;
            if (ids && ids.length === triCount) {
                const seen = new Set();
                for (let t = 0; t < triCount; t++) {
                    const id = ids[t] >>> 0;
                    if (seen.has(id)) continue;
                    seen.add(id);
                    if (!completeMap.has(id)) completeMap.set(id, `FACE_${id}`);
                }
            } else if (!ids) {
                if (!completeMap.has(0)) completeMap.set(0, 'FACE_0');
            }
        } catch { /* ignore */ }
        this._idToFaceName = completeMap;
        this._faceNameToID = new Map(
            [...this._idToFaceName.entries()].map(([id, name]) => [name, id]),
        );

        // Replace cached manifold and reset caches
        try { if (this._manifold && this._manifold !== outM && typeof this._manifold.delete === 'function') this._manifold.delete(); } catch { }
        this._manifold = outM;
        this._dirty = false;
        this._faceIndex = null;
    } finally {
        try { if (meshOut && typeof meshOut.delete === 'function') meshOut.delete(); } catch { }
    }

    console.log(`Simplification complete.`);

    const returnObject = updateInPlace ? this : Solid._fromManifold(outM, this._idToFaceName);

    this._manifoldize();
    // Return the mutated Solid (chainable)
    return returnObject;
}

export function _expandTriIDsFromMesh(mesh) {
    if (mesh.faceID && mesh.faceID.length) {
        return Array.from(mesh.faceID);
    }
    return new Array((mesh.triVerts.length / 3) | 0).fill(0);
}

export function _fromManifold(manifoldObj, idToFaceName) {
    const Solid = this;
    const mesh = manifoldObj.getMesh();
    const solid = new Solid();

    solid._numProp = mesh.numProp;
    solid._vertProperties = Array.from(mesh.vertProperties);
    solid._triVerts = Array.from(mesh.triVerts);
    solid._triIDs = Solid._expandTriIDsFromMesh(mesh);

    for (let i = 0; i < mesh.vertProperties.length; i += 3) {
        const x = mesh.vertProperties[i + 0];
        const y = mesh.vertProperties[i + 1];
        const z = mesh.vertProperties[i + 2];
        solid._vertKeyToIndex.set(`${x},${y},${z}`, i / 3);
    }

    const completeMap = new Map(idToFaceName);
    try {
        const ids = mesh.faceID && mesh.faceID.length ? mesh.faceID : null;
        const triCount = (mesh.triVerts?.length || 0) / 3 | 0;
        if (ids && ids.length === triCount) {
            const seen = new Set();
            for (let t = 0; t < triCount; t++) {
                const id = ids[t] >>> 0;
                if (seen.has(id)) continue;
                seen.add(id);
                if (!completeMap.has(id)) completeMap.set(id, `FACE_${id}`);
            }
        } else if (!ids) {
            if (!completeMap.has(0)) completeMap.set(0, 'FACE_0');
        }
    } catch (_) { /* best-effort completion */ }

    solid._idToFaceName = new Map(completeMap);
    solid._faceNameToID = new Map(
        [...solid._idToFaceName.entries()].map(([id, name]) => [name, id]),
    );

    solid._manifold = manifoldObj;
    solid._dirty = false;
    try { return solid; } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { } }
}
