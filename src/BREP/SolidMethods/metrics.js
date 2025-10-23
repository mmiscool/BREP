/**
 * Geometric measurements.
 */

export function volume() {
    const mesh = this.getMesh();
    try {
        const vp = mesh.vertProperties;
        const tv = mesh.triVerts;
        let vol6 = 0;
        for (let t = 0; t < tv.length; t += 3) {
            const i0 = tv[t] * 3, i1 = tv[t + 1] * 3, i2 = tv[t + 2] * 3;
            const x0 = vp[i0], y0 = vp[i0 + 1], z0 = vp[i0 + 2];
            const x1 = vp[i1], y1 = vp[i1 + 1], z1 = vp[i1 + 2];
            const x2 = vp[i2], y2 = vp[i2 + 1], z2 = vp[i2 + 2];
            vol6 += x0 * (y1 * z2 - z1 * y2)
                - y0 * (x1 * z2 - z1 * x2)
                + z0 * (x1 * y2 - y1 * x2);
        }
        return Math.abs(vol6) / 6.0;
    } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { } }
}

export function surfaceArea() {
    const mesh = this.getMesh();
    try {
        const vp = mesh.vertProperties;
        const tv = mesh.triVerts;
        let area = 0;
        for (let t = 0; t < tv.length; t += 3) {
            const i0 = tv[t] * 3, i1 = tv[t + 1] * 3, i2 = tv[t + 2] * 3;
            const ax = vp[i0], ay = vp[i0 + 1], az = vp[i0 + 2];
            const bx = vp[i1], by = vp[i1 + 1], bz = vp[i1 + 2];
            const cx = vp[i2], cy = vp[i2 + 1], cz = vp[i2 + 2];
            const ux = bx - ax, uy = by - ay, uz = bz - az;
            const vx = cx - ax, vy = cy - ay, vz = cz - az;
            const nx = uy * vz - uz * vy;
            const ny = uz * vx - ux * vz;
            const nz = ux * vy - uy * vx;
            area += 0.5 * Math.hypot(nx, ny, nz);
        }
        return area;
    } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { } }
}

