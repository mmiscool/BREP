import { THREE } from "../SolidShared.js";
import { composeTrsMatrixDeg } from "../../utils/xformMath.js";

/**
 * Geometry transforms applied directly to authored data.
 */

/**
 * Apply a Matrix4 to all authored vertices (bake transform into geometry arrays).
 * Does not modify the Object3D transform; marks manifold dirty for rebuild.
 */
export function bakeTransform(matrix) {
    try {
        if (!matrix || typeof matrix.elements === 'undefined') return this;
        if (!Array.isArray(this._vertProperties) || this._vertProperties.length === 0) return this;
        const m = (matrix && matrix.isMatrix4) ? matrix : new THREE.Matrix4().fromArray(matrix.elements || matrix);
        const e = m.elements;
        const vp = this._vertProperties;
        // Inline mat4 multiply for speed
        for (let i = 0; i < vp.length; i += 3) {
            const x = vp[i + 0], y = vp[i + 1], z = vp[i + 2];
            const nx = e[0] * x + e[4] * y + e[8] * z + e[12];
            const ny = e[1] * x + e[5] * y + e[9] * z + e[13];
            const nz = e[2] * x + e[6] * y + e[10] * z + e[14];
            vp[i + 0] = nx; vp[i + 1] = ny; vp[i + 2] = nz;
        }
        // Rebuild exact-key map and mark dirty
        this._vertKeyToIndex = new Map();
        for (let i = 0; i < vp.length; i += 3) {
            const X = vp[i], Y = vp[i + 1], Z = vp[i + 2];
            this._vertKeyToIndex.set(`${X},${Y},${Z}`, (i / 3) | 0);
        }
        this._dirty = true;
        this._faceIndex = null;
        // Bake the same transform into any auxiliary edges
        try {
            if (Array.isArray(this._auxEdges) && this._auxEdges.length) {
                const tmp = new THREE.Vector3();
                for (const aux of this._auxEdges) {
                    const pts = Array.isArray(aux?.points) ? aux.points : null;
                    if (!pts) continue;
                    for (let i = 0; i < pts.length; i++) {
                        const p = pts[i];
                        if (!Array.isArray(p) || p.length !== 3) continue;
                        tmp.set(p[0], p[1], p[2]).applyMatrix4(m);
                        pts[i] = [tmp.x, tmp.y, tmp.z];
                    }
                }
            }
        } catch { /* ignore aux bake errors */ }

        // Bake the same transform into face metadata (center and axis vectors)
        try {
            if (this._faceMetadata && this._faceMetadata.size > 0) {
                const tmp = new THREE.Vector3();
                for (const [, metadata] of this._faceMetadata.entries()) {
                    if (!metadata || typeof metadata !== 'object') continue;

                    // Transform center point if present
                    if (Array.isArray(metadata.center) && metadata.center.length === 3) {
                        tmp.set(metadata.center[0], metadata.center[1], metadata.center[2]);
                        tmp.applyMatrix4(m);
                        metadata.center = [tmp.x, tmp.y, tmp.z];
                    }

                    // Transform axis direction if present (use transformDirection for vectors)
                    if (Array.isArray(metadata.axis) && metadata.axis.length === 3) {
                        tmp.set(metadata.axis[0], metadata.axis[1], metadata.axis[2]);
                        tmp.transformDirection(m).normalize();
                        metadata.axis = [tmp.x, tmp.y, tmp.z];
                    }
                }
            }
        } catch { /* ignore metadata bake errors */ }
    } catch (_) { /* ignore */ }
    return this;
}

/**
 * Convenience: compose TRS and bake transform.
 */
export function bakeTRS(trs) {
    try {
        const m = composeTrsMatrixDeg(trs, THREE);
        return this.bakeTransform(m);
    } catch (_) { return this; }
}

/**
 * Offset all vertices belonging to the given face along the face's
 * area-weighted average normal by the specified distance.
 */
export function offsetFace(faceName, distance) {
    const dist = Number(distance);
    if (!Number.isFinite(dist) || dist === 0) return this;
    const id = this._faceNameToID.get(faceName);
    if (id === undefined) return this; // unknown face name → no-op

    const mesh = this.getMesh();
    const vp = mesh.vertProperties; // Float32Array
    const tv = mesh.triVerts;       // Uint32Array
    const faceIDs = mesh.faceID;    // Uint32Array
    const triCount = (tv.length / 3) | 0;
    if (!faceIDs || faceIDs.length !== triCount) return this;

    // 1) Gather triangles and accumulate area-weighted normal.
    let nx = 0, ny = 0, nz = 0;
    const affectedVerts = new Set();
    for (let t = 0; t < triCount; t++) {
        if (faceIDs[t] !== id) continue;
        const b = t * 3;
        const i0 = tv[b + 0] >>> 0;
        const i1 = tv[b + 1] >>> 0;
        const i2 = tv[b + 2] >>> 0;
        affectedVerts.add(i0); affectedVerts.add(i1); affectedVerts.add(i2);

        const ax = vp[i0 * 3 + 0], ay = vp[i0 * 3 + 1], az = vp[i0 * 3 + 2];
        const bx = vp[i1 * 3 + 0], by = vp[i1 * 3 + 1], bz = vp[i1 * 3 + 2];
        const cx = vp[i2 * 3 + 0], cy = vp[i2 * 3 + 1], cz = vp[i2 * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        nx += uy * vz - uz * vy;
        ny += uz * vx - ux * vz;
        nz += ux * vy - uy * vx;
    }

    // 2) Normalize to get unit average normal.
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) return this;
    const sx = (nx / len) * dist;
    const sy = (ny / len) * dist;
    const sz = (nz / len) * dist;

    // 3) Apply translation to authoring vertex buffer.
    if (!this._vertProperties || this._vertProperties.length === 0) return this;
    for (const vi of affectedVerts) {
        const base = (vi * 3) | 0;
        this._vertProperties[base + 0] += sx;
        this._vertProperties[base + 1] += sy;
        this._vertProperties[base + 2] += sz;
    }

    // 4) Rebuild exact-key map and mark dirty so manifold rebuilds on demand.
    this._vertKeyToIndex = new Map();
    for (let i = 0; i < this._vertProperties.length; i += 3) {
        const x = this._vertProperties[i], y = this._vertProperties[i + 1], z = this._vertProperties[i + 2];
        this._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
    }
    this._dirty = true;
    this._faceIndex = null;
    try { return this; } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { } }
}

/**
 * Return a mirrored copy of this solid across a plane defined by a point and a normal.
 */
export function mirrorAcrossPlane(point, normal) {
    const Solid = this.constructor;
    const P0 = (point instanceof THREE.Vector3)
        ? point.clone()
        : new THREE.Vector3(point[0], point[1], point[2]);
    const n = (normal instanceof THREE.Vector3)
        ? normal.clone().normalize()
        : new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();

    const mesh = this.getMesh();
    try {
        const vp = mesh.vertProperties; // Float32Array
        const tv = mesh.triVerts;       // Uint32Array
        const faceIDs = mesh.faceID && mesh.faceID.length ? Array.from(mesh.faceID) : [];

        const mirrored = new Solid();
        mirrored._numProp = mesh.numProp || 3;

        // Reflect vertices across plane
        const outVP = new Array(vp.length);
        const X = new THREE.Vector3();
        for (let i = 0; i < vp.length; i += 3) {
            X.set(vp[i + 0], vp[i + 1], vp[i + 2]);
            const d = X.clone().sub(P0);
            const t = 2 * d.dot(n);
            const Xp = X.sub(n.clone().multiplyScalar(t));
            outVP[i + 0] = Xp.x;
            outVP[i + 1] = Xp.y;
            outVP[i + 2] = Xp.z;
        }
        mirrored._vertProperties = outVP;

        // Copy triangles and face IDs
        mirrored._triVerts = Array.from(tv);
        mirrored._triIDs = faceIDs.length ? faceIDs : new Array((tv.length / 3) | 0).fill(0);

        // Restore face name maps
        try {
            mirrored._idToFaceName = new Map(this._idToFaceName);
            mirrored._faceNameToID = new Map(this._faceNameToID);
        } catch (_) { }

        // Rebuild vertex key map for exact-key lookup consistency
        mirrored._vertKeyToIndex = new Map();
        for (let i = 0; i < mirrored._vertProperties.length; i += 3) {
            const x = mirrored._vertProperties[i];
            const y = mirrored._vertProperties[i + 1];
            const z = mirrored._vertProperties[i + 2];
            mirrored._vertKeyToIndex.set(`${x},${y},${z}`, (i / 3) | 0);
        }

        mirrored._dirty = true;  // manifold must rebuild on demand
        mirrored._faceIndex = null;
        mirrored._manifold = null;
        return mirrored;
    } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { } }
}
