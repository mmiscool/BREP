/**
 * Face and edge metadata helpers.
 */

/** Set metadata for a face (e.g., radius for cylindrical faces). */
export function setFaceMetadata(faceName, metadata) {
    if (!metadata || typeof metadata !== 'object') return this;
    const existing = this.getFaceMetadata(faceName);
    const base = existing && typeof existing === 'object' ? existing : {};
    this._faceMetadata.set(faceName, { ...base, ...metadata });
    return this;
}

/** Get metadata for a face. */
export function getFaceMetadata(faceName) {
    return this._faceMetadata.get(faceName) || {};
}

/** Convenience: list all face names present in this solid. */
export function getFaceNames() {
    return [...this._faceNameToID.keys()];
}

/** Set metadata for an edge. */
export function setEdgeMetadata(edgeName, metadata) {
    if (!metadata || typeof metadata !== 'object') return this;
    const existing = this.getEdgeMetadata(edgeName);
    const base = existing && typeof existing === 'object' ? existing : {};
    this._edgeMetadata.set(edgeName, { ...base, ...metadata });
    return this;
}

/** Get metadata for an edge. */
export function getEdgeMetadata(edgeName) {
    return this._edgeMetadata.get(edgeName) || null;
}

/** Combine face metadata maps across two solids. */
export function _combineFaceMetadata(other) {
    const merged = new Map(this._faceMetadata);
    if (other && other._faceMetadata) {
        for (const [faceName, metadata] of other._faceMetadata.entries()) {
            merged.set(faceName, { ...metadata });
        }
    }
    return merged;
}

/** Combine edge metadata maps across two solids. */
export function _combineEdgeMetadata(other) {
    const merged = new Map(this._edgeMetadata);
    if (other && other._edgeMetadata) {
        for (const [edgeName, metadata] of other._edgeMetadata.entries()) {
            merged.set(edgeName, { ...metadata });
        }
    }
    return merged;
}
