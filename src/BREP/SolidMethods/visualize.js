import {
    manifold,
    Manifold,
    ManifoldMesh,
    THREE,
    CADmaterials,
    Line2,
    LineGeometry,
    debugMode,
    Edge,
    Vertex,
    Face
} from "../SolidShared.js";

/**
 * Build a Three.js Group of per-face meshes for visualization.
 * - Each face label becomes its own Mesh with a single material.
 * - By default, generates a deterministic color per face name.
 * - Accepts a THREE reference or uses global window.THREE if available.
 *
 * @param {any} THREERef Optional reference to the three.js module/object.
 * @param {object} options Optional settings
 * @param {(name:string)=>any} options.materialForFace Optional factory returning a THREE.Material for a face
 * @param {boolean} options.wireframe Render materials as wireframe (default false)
 * @param {string} options.name Name for the group (default 'Solid')
 * @returns {any} THREE.Group containing one child Mesh per face
 */
export default function visualize(options = {}) {
        const Solid = this.constructor;
        // Clear existing children and dispose resources
        for (let i = this.children.length - 1; i >= 0; i--) {
            const child = this.children[i];
            this.remove(child);
            if (child.geometry && typeof child.geometry.dispose === 'function') child.geometry.dispose();
            const mat = child.material;
            if (mat) {
                if (Array.isArray(mat)) mat.forEach(m => m && m.dispose && m.dispose());
                else if (typeof mat.dispose === 'function') mat.dispose();
            }
        }

        const { showEdges = true, forceAuthoring = false, authoringOnly = false } = options;
        let faces; let usedFallback = false;
        if (!forceAuthoring && !authoringOnly) {
            try {
                faces = this.getFaces(false);
            } catch (err) {
                console.warn('[Solid.visualize] getFaces failed, falling back to raw arrays:', err?.message || err);
                usedFallback = true;
            }
        } else {
            usedFallback = true;
        }
        if (usedFallback || !faces) {
            // Fallback: group authored triangles by face name directly from arrays.
            // This enables visualization even if manifoldization failed, which helps debugging.
            const vp = this._vertProperties || [];
            const tv = this._triVerts || [];
            const ids = this._triIDs || [];
            const nameOf = (id) => this._idToFaceName && this._idToFaceName.get ? this._idToFaceName.get(id) : String(id);
            const nameToTris = new Map();
            const triCount = (tv.length / 3) | 0;
            for (let t = 0; t < triCount; t++) {
                const id = ids[t];
                const name = nameOf(id);
                if (!name) continue;
                let arr = nameToTris.get(name);
                if (!arr) { arr = []; nameToTris.set(name, arr); }
                const i0 = tv[t * 3 + 0], i1 = tv[t * 3 + 1], i2 = tv[t * 3 + 2];
                const p0 = [vp[i0 * 3 + 0], vp[i0 * 3 + 1], vp[i0 * 3 + 2]];
                const p1 = [vp[i1 * 3 + 0], vp[i1 * 3 + 1], vp[i1 * 3 + 2]];
                const p2 = [vp[i2 * 3 + 0], vp[i2 * 3 + 1], vp[i2 * 3 + 2]];
                arr.push({ faceName: name, indices: [i0, i1, i2], p1: p0, p2: p1, p3: p2 });
            }
            faces = [];
            for (const [faceName, triangles] of nameToTris.entries()) faces.push({ faceName, triangles });
        }

        // Build Face meshes and index by name
        const faceMap = new Map();
        for (const { faceName, triangles } of faces) {
            if (!triangles.length) continue;
            const positions = new Float32Array(triangles.length * 9);
            let w = 0;
            for (let t = 0; t < triangles.length; t++) {
                const tri = triangles[t];
                const p0 = tri.p1, p1 = tri.p2, p2 = tri.p3;
                
                // Validate triangle coordinates before adding to geometry
                const coords = [p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]];
                const hasInvalidCoords = coords.some(coord => !isFinite(coord));
                
                if (hasInvalidCoords) {
                    console.error(`Invalid triangle coordinates in face ${faceName}, triangle ${t}:`);
                    console.error('p0:', p0, 'p1:', p1, 'p2:', p2);
                    console.error('Triangle data:', tri);
                    // Skip this triangle by not incrementing w and not setting positions
                    continue;
                }
                
                positions[w++] = p0[0]; positions[w++] = p0[1]; positions[w++] = p0[2];
                positions[w++] = p1[0]; positions[w++] = p1[1]; positions[w++] = p1[2];
                positions[w++] = p2[0]; positions[w++] = p2[1]; positions[w++] = p2[2];
            }

            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geom.computeVertexNormals();
            geom.computeBoundingBox();
            geom.computeBoundingSphere();

            const faceObj = new Face(geom);
            faceObj.name = faceName;
            faceObj.userData.faceName = faceName;
            faceMap.set(faceName, faceObj);
            this.add(faceObj);
        }

        if (showEdges) {
            if (!usedFallback) {
                let polylines = [];
                try { polylines = this.getBoundaryEdgePolylines() || []; } catch { polylines = []; }
                // Safety net: if manifold-based extraction yielded no edges (e.g., faceID missing),
                // fall back to authoring-based boundary extraction so we still visualize edges.
                if (!Array.isArray(polylines) || polylines.length === 0) {
                    try { usedFallback = true; } catch { }
                }
                for (const e of polylines) {
                    const positions = new Float32Array(e.positions.length * 3);
                    let w = 0;
                    for (let i = 0; i < e.positions.length; i++) {
                        const p = e.positions[i];
                        positions[w++] = p[0]; positions[w++] = p[1]; positions[w++] = p[2];
                    }
                    const g = new LineGeometry();
                    g.setPositions(Array.from(positions));
                    try { g.computeBoundingSphere(); } catch { }

                    const edgeObj = new Edge(g);
                    edgeObj.name = e.name;
                    edgeObj.closedLoop = !!e.closedLoop;
                    edgeObj.userData = { faceA: e.faceA, faceB: e.faceB, polylineLocal: e.positions, closedLoop: !!e.closedLoop };
                    // For convenience in feature code, mirror THREE's parent with an explicit handle
                    edgeObj.parentSolid = this;
                    const fa = faceMap.get(e.faceA);
                    const fb = faceMap.get(e.faceB);
                    if (fa) fa.edges.push(edgeObj);
                    if (fb) fb.edges.push(edgeObj);
                    if (fa) edgeObj.faces.push(fa);
                    if (fb) edgeObj.faces.push(fb);
                    this.add(edgeObj);
                }
            }
            if (usedFallback) {
                // Fallback boundary extraction from raw authoring arrays.
                try {
                    const vp = this._vertProperties || [];
                    const tv = this._triVerts || [];
                    const ids = this._triIDs || [];
                    const nv = (vp.length / 3) | 0;
                    const triCount = (tv.length / 3) | 0;
                    const NV = BigInt(Math.max(1, nv));
                    const ukey = (a, b) => { const A = BigInt(a), B = BigInt(b); return A < B ? A * NV + B : B * NV + A; };
                    const e2t = new Map(); // key -> [{id,a,b,tri}...]
                    for (let t = 0; t < triCount; t++) {
                        const id = ids[t];
                        const base = t * 3;
                        const i0 = tv[base + 0] >>> 0, i1 = tv[base + 1] >>> 0, i2 = tv[base + 2] >>> 0;
                        const edges = [[i0, i1], [i1, i2], [i2, i0]];
                        for (let k = 0; k < 3; k++) {
                            const a = edges[k][0], b = edges[k][1];
                            const key = ukey(a, b);
                            let arr = e2t.get(key);
                            if (!arr) { arr = []; e2t.set(key, arr); }
                            arr.push({ id, a, b, tri: t });
                        }
                    }
                    // Create polyline objects between differing face IDs (authoring labels)
                    const nameOf = (id) => this._idToFaceName && this._idToFaceName.get ? this._idToFaceName.get(id) : String(id);
                    const pairToEdges = new Map(); // pairKey -> array of [u,v]
                    for (const [key, arr] of e2t.entries()) {
                        if (arr.length !== 2) continue;
                        const a = arr[0], b = arr[1];
                        if (a.id === b.id) continue;
                        const nameA = nameOf(a.id), nameB = nameOf(b.id);
                        const pair = nameA < nameB ? [nameA, nameB] : [nameB, nameA];
                        const pairKey = JSON.stringify(pair);
                        let list = pairToEdges.get(pairKey);
                        if (!list) { list = []; pairToEdges.set(pairKey, list); }
                        const u = Math.min(a.a, a.b), v = Math.max(a.a, a.b);
                        list.push([u, v]);
                    }

                    const addPolyline = (nameA, nameB, indices) => {
                        const visited = new Set();
                        const adj = new Map();
                        const ek = (u, v) => (u < v ? `${u},${v}` : `${v},${u}`);
                        for (const [u, v] of indices) {
                            if (!adj.has(u)) adj.set(u, new Set());
                            if (!adj.has(v)) adj.set(v, new Set());
                            adj.get(u).add(v); adj.get(v).add(u);
                        }
                        const verts = (idx) => [vp[idx * 3 + 0], vp[idx * 3 + 1], vp[idx * 3 + 2]];
                        for (const [u0] of adj.entries()) {
                            // find start (degree 1) or any if loop
                            if ([...adj.get(u0)].length !== 1) continue;
                            const poly = [];
                            let u = u0, prev = -1;
                            while (true) {
                                const nbrs = [...adj.get(u)];
                                let v = nbrs[0];
                                if (v === prev && nbrs.length > 1) v = nbrs[1];
                                if (v === undefined) break;
                                const key = ek(u, v);
                                if (visited.has(key)) break;
                                visited.add(key);
                                poly.push(verts(u));
                                prev = u; u = v;
                                if (!adj.has(u)) break;
                            }
                            poly.push(verts(u));
                            if (poly.length >= 2) {
                                // Validate polyline coordinates before creating geometry
                                const flatCoords = poly.flat();
                                const hasInvalidCoords = flatCoords.some(coord => !isFinite(coord));
                                
                                if (hasInvalidCoords) {
                                    console.error('Invalid coordinates detected in edge polyline:');
                                    console.error('Poly coordinates:', poly);
                                    console.error('Flat coordinates:', flatCoords);
                                    console.error('Face names:', nameA, '|', nameB);
                                    continue; // Skip this edge
                                }
                                
                                const g = new LineGeometry();
                                g.setPositions(flatCoords);
                                try { g.computeBoundingSphere(); } catch { }
                                const edgeObj = new Edge(g);
                                edgeObj.name = `${nameA}|${nameB}`;
                                edgeObj.closedLoop = false;
                                edgeObj.userData = { faceA: nameA, faceB: nameB, polylineLocal: poly, closedLoop: false };
                                edgeObj.parentSolid = this;
                                const fa = faceMap.get(nameA); const fb = faceMap.get(nameB);
                                if (fa) fa.edges.push(edgeObj); if (fb) fb.edges.push(edgeObj);
                                if (fa) edgeObj.faces.push(fa); if (fb) edgeObj.faces.push(fb);
                                this.add(edgeObj);
                            }
                        }
                    };
                    for (const [pairKey, edgeList] of pairToEdges.entries()) {
                        const [a, b] = JSON.parse(pairKey);
                        addPolyline(a, b, edgeList);
                    }
                } catch (_) { /* ignore fallback edge errors */ }
            }
        }

        // Add auxiliary edges stored on this solid (e.g., centerlines)
        try {
            if (Array.isArray(this._auxEdges) && this._auxEdges.length) {
                for (const aux of this._auxEdges) {
                    const pts = Array.isArray(aux?.points) ? aux.points.filter(p => Array.isArray(p) && p.length === 3) : [];
                    if (pts.length < 2) continue;
                    const flat = [];
                    for (const p of pts) { flat.push(p[0], p[1], p[2]); }
                    
                    // Validate auxiliary edge coordinates
                    const hasInvalidCoords = flat.some(coord => !isFinite(coord));
                    if (hasInvalidCoords) {
                        console.error('Invalid coordinates in auxiliary edge:', aux?.name || 'CENTERLINE');
                        console.error('Points:', pts);
                        console.error('Flat coordinates:', flat);
                        continue; // Skip this auxiliary edge
                    }
                    
                    const g = new LineGeometry();
                    g.setPositions(flat);
                    try { g.computeBoundingSphere(); } catch { }
                    const edgeObj = new Edge(g);
                    edgeObj.name = aux?.name || 'CENTERLINE';
                    edgeObj.closedLoop = !!aux?.closedLoop;
                    edgeObj.userData = { ...(edgeObj.userData || {}), polylineLocal: pts, polylineWorld: !!aux?.polylineWorld };
                    edgeObj.parentSolid = this;
                    try {
                        const useOverlay = (aux?.materialKey || 'OVERLAY').toUpperCase() === 'OVERLAY';
                        const mat = useOverlay ? (CADmaterials?.EDGE?.OVERLAY || CADmaterials?.EDGE?.BASE) : (CADmaterials?.EDGE?.BASE);
                        if (mat) edgeObj.material = mat;
                        if (useOverlay && edgeObj.material) { edgeObj.material.depthTest = false; edgeObj.material.depthWrite = false; }
                        edgeObj.renderOrder = 10020;
                    } catch { }
                    this.add(edgeObj);
                }
            }
        } catch { /* ignore aux edge errors */ }

        // Helper function to generate deterministic vertex names based on meeting edges
        const generateVertexName = (position, meetingEdges) => {
            if (!meetingEdges || meetingEdges.length === 0) {
                return `VERTEX(${position[0]},${position[1]},${position[2]})`;
            }
            // Sort edge names for consistency, then join them
            const sortedEdgeNames = [...meetingEdges].sort();
            return `VERTEX[${sortedEdgeNames.join('+')}]`;
        };

        // Generate unique vertex objects at the start and end points of all edges
        try {
            const endpoints = new Map();
            const vertexToEdges = new Map(); // Track which edges meet at each vertex
            const usedVertexNames = new Set();

            // First pass: collect all endpoint positions and track which edges meet at each vertex
            for (const ch of this.children) {
                if (!ch || ch.type !== 'EDGE') continue;
                const poly = ch.userData && Array.isArray(ch.userData.polylineLocal) ? ch.userData.polylineLocal : null;
                if (!poly || poly.length === 0) continue;

                const edgeName = ch.name || 'UNNAMED_EDGE';
                const first = poly[0];
                const last = poly[poly.length - 1];

                const addEP = (p) => {
                    if (!p || p.length !== 3) return;
                    const k = `${p[0]},${p[1]},${p[2]}`;
                    if (!endpoints.has(k)) endpoints.set(k, p);

                    // Track which edges meet at this vertex position
                    if (!vertexToEdges.has(k)) {
                        vertexToEdges.set(k, new Set());
                    }
                    vertexToEdges.get(k).add(edgeName);
                };

                addEP(first);
                addEP(last);
            }

            // Second pass: create vertices with deterministic names based on meeting edges
            if (endpoints.size) {
                for (const [positionKey, position] of endpoints.entries()) {
                    try {
                        const meetingEdges = vertexToEdges.get(positionKey);
                        let vertexName = generateVertexName(position, meetingEdges ? Array.from(meetingEdges) : []);
                        if (usedVertexNames.has(vertexName)) {
                            let suffix = 1;
                            while (usedVertexNames.has(`${vertexName}[${suffix}]`)) {
                                suffix++;
                            }
                            vertexName = `${vertexName}[${suffix}]`;
                        }
                        usedVertexNames.add(vertexName);
                        this.add(new Vertex(position, { name: vertexName }));
                    } catch { }
                }
            }
        } catch { /* best-effort vertices */ }

        return this;
    
}
