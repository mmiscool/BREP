import { Manifold } from "../SolidShared.js";

/**
 * Solid authoring helpers: vertex/face ID management and convenience geometry.
 */

/** Exact key for vertex uniquing (change to tolerance if needed). */
export function _key([x, y, z]) {
    return `${x},${y},${z}`;
}

/** Return the index of `p`, adding it to the vertex buffer if new. */
export function _getPointIndex(p) {
    // Validate that all coordinates are finite before adding to vertex buffer
    if (!Array.isArray(p) || p.length < 3) {
        console.error('Invalid point passed to _getPointIndex:', p);
        throw new Error('Point must be an array with at least 3 elements');
    }
    
    const x = p[0], y = p[1], z = p[2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
        console.error('Non-finite coordinates in _getPointIndex:', {x, y, z});
        throw new Error(`Invalid point coordinates: (${x}, ${y}, ${z}) - must be finite numbers`);
    }
    
    const k = this._key(p);
    const found = this._vertKeyToIndex.get(k);
    if (found !== undefined) return found;
    const idx = this._vertProperties.length / 3;
    this._vertProperties.push(x, y, z);
    this._vertKeyToIndex.set(k, idx);
    return idx;
}

/** Map face name to unique Manifold ID, creating one if absent. */
export function _getOrCreateID(faceName) {
    if (!this._faceNameToID.has(faceName)) {
        const id = Manifold.reserveIDs(1); // globally unique, propagates through CSG
        this._faceNameToID.set(faceName, id);
        this._idToFaceName.set(id, faceName);
    }
    return this._faceNameToID.get(faceName);
}

/**
 * Add a single triangle (CCW winding recommended).
 * @param {string} faceName
 * @param {[number,number,number]} v1
 * @param {[number,number,number]} v2
 * @param {[number,number,number]} v3
 */
export function addTriangle(faceName, v1, v2, v3) {
    const id = this._getOrCreateID(faceName);
    const i1 = this._getPointIndex(v1);
    const i2 = this._getPointIndex(v2);
    const i3 = this._getPointIndex(v3);
    this._triVerts.push(i1, i2, i3);
    this._triIDs.push(id);
    this._dirty = true;
    this._faceIndex = null;
    return this;
}

/**
 * Add a helper/auxiliary edge polyline to this solid (e.g., a centerline).
 */
export function addAuxEdge(name, points, options = {}) {
    try {
        const toArr = (p) => {
            if (Array.isArray(p) && p.length === 3) return [p[0], p[1], p[2]];
            if (p && typeof p === 'object') {
                const x = +p.x, y = +p.y, z = +p.z;
                if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return [x, y, z];
            }
            return null;
        };
        const pts = Array.isArray(points)
            ? points.map(toArr).filter(Boolean)
            : [];
        if (pts.length < 2) return this;
        const entry = {
            name: name || 'EDGE',
            points: pts,
            closedLoop: !!options.closedLoop,
            polylineWorld: !!options.polylineWorld,
            materialKey: options.materialKey || 'OVERLAY',
        };
        if (!Array.isArray(this._auxEdges)) this._auxEdges = [];
        this._auxEdges.push(entry);
    } catch { /* ignore */ }
    return this;
}

/** Convenience: add a two-point centerline. */
export function addCenterline(a, b, name = 'CENTERLINE', options = {}) {
    const A = Array.isArray(a) ? a : [a?.x || 0, a?.y || 0, a?.z || 0];
    const B = Array.isArray(b) ? b : [b?.x || 0, b?.y || 0, b?.z || 0];
    return this.addAuxEdge(name, [A, B], options);
}
