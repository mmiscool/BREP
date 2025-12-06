/**
 * Solid lifecycle helpers: constructor, cloning, resource cleanup.
 */
export function constructorImpl() {
    // Geometry data (MeshGL layout, but we build incrementally in JS arrays)
    this._numProp = 3;                // x,y,z
    this._vertProperties = [];        // flat [x0,y0,z0, x1,y1,z1, ...]
    this._triVerts = [];              // flat [i0,i1,i2, i3,i4,i5, ...]
    this._triIDs = [];                // per-triangle Manifold ID (mapped from faceName)

    // Vertex uniquing
    this._vertKeyToIndex = new Map(); // "x,y,z" -> index

    // Face name <-> Manifold ID
    this._faceNameToID = new Map();
    this._idToFaceName = new Map();

    // Face and edge metadata storage
    this._faceMetadata = new Map(); // faceName -> metadata object
    this._edgeMetadata = new Map(); // edgeName -> metadata object

    // Laziness & caching
    this._dirty = true;               // arrays changed and manifold needs rebuild
    this._manifold = null;            // cached Manifold object built from arrays
    this._faceIndex = null;           // lazy cache: id -> [triIndices]
    this._epsilon = 0;                // optional vertex weld tolerance (off by default)
    this._freeTimer = null;           // handle for scheduled wasm cleanup

    this.type = 'SOLID';
    this.renderOrder = 1;
    // Custom auxiliary edges (e.g., centerlines) to visualize with this solid
    // Each item: { name?:string, points:[[x,y,z],...], closedLoop?:boolean, polylineWorld?:boolean, materialKey?:'OVERLAY'|'BASE' }
    this._auxEdges = [];
}

/**
 * Create a lightweight clone of this Solid that copies geometry arrays
 * and face maps, but not children or any THREE resources.
 */
export function clone() {
    const Solid = this.constructor;
    const s = new Solid();
    s._numProp = this._numProp;
    s._vertProperties = this._vertProperties.slice();
    s._triVerts = this._triVerts.slice();
    s._triIDs = this._triIDs.slice();
    s._vertKeyToIndex = new Map();
    for (let i = 0; i < s._vertProperties.length; i += 3) {
        const x = s._vertProperties[i];
        const y = s._vertProperties[i + 1];
        const z = s._vertProperties[i + 2];
        s._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
    }
    // Copy face name maps
    try {
        s._idToFaceName = new Map(this._idToFaceName);
        s._faceNameToID = new Map(this._faceNameToID);
    } catch (_) { /* ignore */ }
    try { s._faceMetadata = new Map(this._faceMetadata); } catch (_) { s._faceMetadata = new Map(); }
    try { s._edgeMetadata = new Map(this._edgeMetadata); } catch (_) { s._edgeMetadata = new Map(); }
    // Copy auxiliary edges (deep copy points)
    try {
        s._auxEdges = Array.isArray(this._auxEdges)
            ? this._auxEdges.map(e => ({
                name: e?.name,
                closedLoop: !!e?.closedLoop,
                polylineWorld: !!e?.polylineWorld,
                materialKey: e?.materialKey,
                points: Array.isArray(e?.points) ? e.points.map(p => Array.isArray(p) ? [p[0], p[1], p[2]] : p) : [],
            }))
            : [];
    } catch { s._auxEdges = []; }
    s._dirty = true;
    s._manifold = null;
    s._faceIndex = null;
    s.type = 'SOLID';
    s.renderOrder = this.renderOrder;
    return s;
}

/**
 * Free wasm resources associated with this Solid.
 *
 * Disposes the underlying Manifold instance (if any) to prevent
 * accumulating wasm memory across rebuilds. After calling free(),
 * the Solid remains usable - any subsequent call that needs the
 * manifold will trigger a fresh _manifoldize().
 */
export function free() {
    try {
        // Clear any pending auto-free timer first
        try { if (this._freeTimer) { clearTimeout(this._freeTimer); } } catch (_) { }
        this._freeTimer = null;
        if (this._manifold) {
            try { if (typeof this._manifold.delete === 'function') this._manifold.delete(); } catch (_) { }
            this._manifold = null;
        }
        this._dirty = true;
        this._faceIndex = null;
    } catch (_) { /* noop */ }
    return this;
}
