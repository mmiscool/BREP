/**
 * Export helpers (STL output).
 */

export function toSTL(name = "solid", precision = 6) {
    const mesh = this.getMesh();
    const { vertProperties, triVerts } = mesh;

    const fmt = (n) => Number.isFinite(n) ? n.toFixed(precision) : "0";
    const parts = [];
    parts.push(`solid ${name}`);

    const triCount = (triVerts.length / 3) | 0;
    for (let t = 0; t < triCount; t++) {
        const i0 = triVerts[t * 3 + 0];
        const i1 = triVerts[t * 3 + 1];
        const i2 = triVerts[t * 3 + 2];

        const p0 = [
            vertProperties[i0 * 3 + 0],
            vertProperties[i0 * 3 + 1],
            vertProperties[i0 * 3 + 2],
        ];
        const p1 = [
            vertProperties[i1 * 3 + 0],
            vertProperties[i1 * 3 + 1],
            vertProperties[i1 * 3 + 2],
        ];
        const p2 = [
            vertProperties[i2 * 3 + 0],
            vertProperties[i2 * 3 + 1],
            vertProperties[i2 * 3 + 2],
        ];

        const ux = p1[0] - p0[0];
        const uy = p1[1] - p0[1];
        const uz = p1[2] - p0[2];
        const vx = p2[0] - p0[0];
        const vy = p2[1] - p0[1];
        const vz = p2[2] - p0[2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;

        parts.push(`  facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`);
        parts.push(`    outer loop`);
        parts.push(`      vertex ${fmt(p0[0])} ${fmt(p0[1])} ${fmt(p0[2])}`);
        parts.push(`      vertex ${fmt(p1[0])} ${fmt(p1[1])} ${fmt(p1[2])}`);
        parts.push(`      vertex ${fmt(p2[0])} ${fmt(p2[1])} ${fmt(p2[2])}`);
        parts.push(`    endloop`);
        parts.push(`  endfacet`);
    }

    parts.push(`endsolid ${name}`);
    try { return parts.join("\n"); } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { } }
}

export async function writeSTL(filePath, name = "solid", precision = 6) {
    if (typeof window !== "undefined") {
        throw new Error("writeSTL is only available in Node.js environments");
    }
    const { writeFile } = await import('node:fs/promises');
    const stl = this.toSTL(name, precision);
    await writeFile(filePath, stl, 'utf8');
    return filePath;
}

