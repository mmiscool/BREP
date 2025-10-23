/**
 * Face metadata helpers.
 */

/** Set metadata for a face (e.g., radius for cylindrical faces). */
export function setFaceMetadata(faceName, metadata) {
    if (!metadata || typeof metadata !== 'object') return this;
    this._faceMetadata.set(faceName, { ...metadata });
    return this;
}

/** Get metadata for a face. */
export function getFaceMetadata(faceName) {
    return this._faceMetadata.get(faceName) || null;
}

/** Convenience: list all face names present in this solid. */
export function getFaceNames() {
    return [...this._faceNameToID.keys()];
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

