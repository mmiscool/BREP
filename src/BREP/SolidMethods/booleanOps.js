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
export function simplify(tolerance = 1) {
    const Solid = this.constructor;
    const m = this._manifoldize();
    const outM = (tolerance === undefined) ? m.simplify() : m.simplify(tolerance);
    const mapCopy = new Map(this._idToFaceName);
    const out = Solid._fromManifold(outM, mapCopy);
    try { out._auxEdges = Array.isArray(this._auxEdges) ? this._auxEdges.slice() : []; } catch { }
    return out;
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

