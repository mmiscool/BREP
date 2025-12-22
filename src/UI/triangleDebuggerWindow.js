import * as THREE from 'three';
import { ArcballControls } from 'three/examples/jsm/controls/ArcballControls.js';
import { FloatingWindow } from './FloatingWindow.js';

const DEFAULT_BG = 0x0b0d10;

function ensureStyles() {
    if (document.getElementById('triangle-debugger-styles')) return;
    const style = document.createElement('style');
    style.id = 'triangle-debugger-styles';
    style.textContent = `
    .tri-debugger {
        height: 100%;
        width: 100%;
        display: grid;
        grid-template-columns: 320px 1fr;
        gap: 10px;
        padding: 6px;
        box-sizing: border-box;
        background: #0b0d10;
        color: #e5e7eb;
        font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    .tri-debugger__sidebar {
        background: #0f141a;
        border: 1px solid #1e2430;
        border-radius: 12px;
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        box-shadow: 0 10px 24px rgba(0,0,0,0.22);
        min-height: 0;
    }
    .tri-debugger__solid {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .tri-debugger__solid-name {
        font-weight: 700;
        letter-spacing: 0.2px;
        color: #e5e7eb;
    }
    .tri-debugger__solid-meta {
        color: #9aa4b2;
        font-size: 11px;
    }
    .tri-debugger__search {
        width: 100%;
        box-sizing: border-box;
        background: #0b0f14;
        border: 1px solid #1e2430;
        color: #e5e7eb;
        border-radius: 8px;
        padding: 6px 8px;
    }
    .tri-debugger__list {
        flex: 1 1 auto;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-height: 0;
    }
    .tri-debugger__row {
        width: 100%;
        border: 1px solid #1e2430;
        background: #121821;
        color: #e5e7eb;
        border-radius: 10px;
        padding: 8px 10px;
        text-align: left;
        cursor: pointer;
        transition: border-color .12s ease, background .12s ease, transform .08s ease;
    }
    .tri-debugger__row:hover { border-color: #7aa2f7; background: #162033; transform: translateY(-1px); }
    .tri-debugger__row.is-selected { border-color: #7aa2f7; background: rgba(122,162,247,0.12); box-shadow: 0 4px 14px rgba(0,0,0,0.24); }
    .tri-debugger__row-title { font-weight: 700; display: flex; gap: 6px; align-items: center; }
    .tri-debugger__row-face { color: #9aa4b2; font-weight: 600; }
    .tri-debugger__row-meta { color: #9aa4b2; font-size: 11px; margin-top: 2px; }
    .tri-debugger__empty { color: #9aa4b2; font-style: italic; padding: 6px 2px; }
    .tri-debugger__filters {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .tri-debugger__toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: #9aa4b2;
        font-size: 11px;
        user-select: none;
    }
    .tri-debugger__toggle input {
        accent-color: #7aa2f7;
    }

    .tri-debugger__main { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
    .tri-debugger__viewport {
        position: relative;
        flex: 1 1 auto;
        background: #0b0d10;
        border: 1px solid #1e2430;
        border-radius: 12px;
        overflow: hidden;
        min-height: 280px;
        box-shadow: 0 10px 32px rgba(0,0,0,0.28);
    }
    .tri-debugger__canvas-host {
        position: absolute;
        inset: 0;
    }
    .tri-debugger__status {
        position: absolute;
        top: 10px;
        left: 12px;
        padding: 6px 10px;
        background: rgba(15,20,26,0.9);
        border: 1px solid #1e2430;
        border-radius: 8px;
        color: #9aa4b2;
        z-index: 2;
        pointer-events: none;
    }
    .tri-debugger__info {
        background: #0f141a;
        border: 1px solid #1e2430;
        border-radius: 12px;
        padding: 10px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px 12px;
        box-sizing: border-box;
    }
    .tri-debugger__info h4 {
        margin: 0;
        font-size: 12px;
        color: #9aa4b2;
        letter-spacing: 0.3px;
    }
    .tri-debugger__info .value {
        font-weight: 700;
        color: #e5e7eb;
        margin-top: 2px;
        word-break: break-word;
    }
    .tri-debugger__badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
    }
    .tri-debugger__badge {
        border-radius: 8px;
        padding: 4px 6px;
        background: #162033;
        border: 1px solid #1e2430;
        font-size: 11px;
        color: #e5e7eb;
        cursor: pointer;
    }
    .tri-debugger__badge.is-selected {
        border-color: #7aa2f7;
        background: rgba(122,162,247,0.12);
    }
    @media (max-width: 1100px) {
        .tri-debugger { grid-template-columns: 280px 1fr; }
    }
    @media (max-width: 900px) {
        .tri-debugger { grid-template-columns: 1fr; grid-template-rows: 240px 1fr; }
        .tri-debugger__sidebar { min-height: 220px; }
    }
    `;
    document.head.appendChild(style);
}

const round = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    if (Math.abs(v) < 1e-12) return 0;
    return Number(v.toFixed(6));
};

export class TriangleDebuggerWindow {
    constructor({ viewer } = {}) {
        this.viewer = viewer || null;
        this.window = null;
        this.root = null;
        this.content = null;
        this.listEl = null;
        this.infoEl = null;
        this.canvasHost = null;
        this.statusEl = null;
        this.filterInput = null;
        this.solidNameEl = null;
        this.solidMetaEl = null;

        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.controls = null;

        this.baseMesh = null;
        this.edgeLines = null;
        this.highlightMesh = null;
        this.adjacentMesh = null;

        this.triangles = [];
        this._listButtons = new Map();
        this._filterText = '';
        this._filterHighValence = false;
        this._selectedIndex = null;
        this._resizeObserver = null;
        this._raf = null;
        this._currentTarget = null;
        this._orthoSize = 4;
        this._raycaster = new THREE.Raycaster();
        this._pointer = new THREE.Vector2();
        this._onCanvasPointerDown = (ev) => this._pickTriangle(ev);
        this._onWindowResize = () => this._onResize();
        this._onInfoClick = (ev) => this._handleInfoClick(ev);
        this._selectedEdgeKey = null;
    }

    isOpen() {
        return !!(this.root && this.root.style.display !== 'none');
    }

    close() {
        if (this.root) this.root.style.display = 'none';
        this._stopRenderLoop();
    }

    openFor(target) {
        this._currentTarget = target || null;
        this._ensureWindow();
        this._startRenderLoop();
        if (this.root) this.root.style.display = 'flex';
        this._bringToFront();
        const solid = this._extractSolid(target);
        if (!solid) {
            this._setStatus('Select a Solid to debug.');
            this._clearGeometry();
            return;
        }
        this._setStatus('');
        this._loadSolid(solid);
    }

    refreshTarget(target) {
        this._currentTarget = target || null;
        if (!this.isOpen()) return;
        this.openFor(target);
    }

    _bringToFront() {
        try { if (this.window && typeof this.window._bringToFront === 'function') this.window._bringToFront(); } catch { }
    }

    _ensureWindow() {
        if (this.root) return;
        ensureStyles();
        const fw = new FloatingWindow({
            title: 'Triangle Debugger',
            width: 1120,
            height: 740,
            right: 12,
            top: 40,
            shaded: false,
            onClose: () => this.close(),
        });

        const btnFit = document.createElement('button');
        btnFit.className = 'fw-btn';
        btnFit.textContent = 'Fit view';
        btnFit.addEventListener('click', () => this._fitCamera());
        fw.addHeaderAction(btnFit);

        const btnClear = document.createElement('button');
        btnClear.className = 'fw-btn';
        btnClear.textContent = 'Clear';
        btnClear.addEventListener('click', () => this._clearGeometry());
        fw.addHeaderAction(btnClear);

        const content = document.createElement('div');
        content.className = 'tri-debugger';
        content.style.width = '100%';
        content.style.height = '100%';
        fw.content.appendChild(content);

        const sidebar = document.createElement('div');
        sidebar.className = 'tri-debugger__sidebar';
        const solidBox = document.createElement('div');
        solidBox.className = 'tri-debugger__solid';
        this.solidNameEl = document.createElement('div');
        this.solidNameEl.className = 'tri-debugger__solid-name';
        this.solidNameEl.textContent = 'No solid selected';
        this.solidMetaEl = document.createElement('div');
        this.solidMetaEl.className = 'tri-debugger__solid-meta';
        this.solidMetaEl.textContent = '-';
        solidBox.append(this.solidNameEl, this.solidMetaEl);

        const filterRow = document.createElement('div');
        filterRow.className = 'tri-debugger__filters';
        this.filterInput = document.createElement('input');
        this.filterInput.className = 'tri-debugger__search';
        this.filterInput.placeholder = 'Filter by face or triangle #';
        this.filterInput.addEventListener('input', () => {
            this._filterText = (this.filterInput.value || '').trim().toLowerCase();
            this._populateList();
        });
        const toggleWrap = document.createElement('label');
        toggleWrap.className = 'tri-debugger__toggle';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.addEventListener('change', () => {
            this._filterHighValence = !!toggle.checked;
            this._populateList();
        });
        const toggleText = document.createElement('span');
        toggleText.textContent = 'Only edges with >2 adjacents';
        toggleWrap.append(toggle, toggleText);
        filterRow.append(this.filterInput, toggleWrap);

        this.listEl = document.createElement('div');
        this.listEl.className = 'tri-debugger__list';

        sidebar.append(solidBox, filterRow, this.listEl);

        const main = document.createElement('div');
        main.className = 'tri-debugger__main';

        const viewport = document.createElement('div');
        viewport.className = 'tri-debugger__viewport';
        this.statusEl = document.createElement('div');
        this.statusEl.className = 'tri-debugger__status';
        this.statusEl.textContent = 'Select a Solid to debug.';

        this.canvasHost = document.createElement('div');
        this.canvasHost.className = 'tri-debugger__canvas-host';
        viewport.append(this.canvasHost, this.statusEl);

        this.infoEl = document.createElement('div');
        this.infoEl.className = 'tri-debugger__info';
        this.infoEl.innerHTML = '<div class="tri-debugger__empty">Select a triangle to see details.</div>';
        this.infoEl.addEventListener('click', this._onInfoClick);

        main.append(viewport, this.infoEl);
        content.append(sidebar, main);

        this.window = fw;
        this.root = fw.root;
        this.content = content;

        this._initThree();
        try { window.addEventListener('resize', this._onWindowResize, { passive: true }); } catch { }
        this._startRenderLoop();
    }

    _initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(DEFAULT_BG);
        const ambient = new THREE.AmbientLight(0xffffff, 0.6);
        const dir1 = new THREE.DirectionalLight(0xffffff, 0.75);
        dir1.position.set(3, 4, 3);
        const dir2 = new THREE.DirectionalLight(0xffffff, 0.45);
        dir2.position.set(-3, -2, 2);
        this.scene.add(ambient, dir1, dir2);

        this.camera = new THREE.OrthographicCamera(-4, 4, 4, -4, 0.001, 10000);
        this.camera.position.set(6, 5, 6);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(100, 100, false);
        this.renderer.setClearColor(new THREE.Color(DEFAULT_BG), 1);
        if (this.canvasHost) this.canvasHost.appendChild(this.renderer.domElement);
        this.renderer.domElement.addEventListener('pointerdown', this._onCanvasPointerDown, { capture: true });

        this.controls = new ArcballControls(this.camera, this.renderer.domElement, this.scene);
        try { this.controls.setGizmosVisible(false); } catch { }
        this.controls.addEventListener('change', () => this._renderOnce());

        if (window.ResizeObserver && this.canvasHost) {
            this._resizeObserver = new ResizeObserver(() => this._onResize());
            this._resizeObserver.observe(this.canvasHost);
        }
        this._onResize();
    }

    _onResize() {
        if (!this.canvasHost || !this.renderer || !this.camera) return;
        const rect = this.canvasHost.getBoundingClientRect();
        const width = Math.max(50, rect.width || 0);
        const height = Math.max(50, rect.height || 0);
        this.renderer.setSize(width, height, false);
        this._applyOrthoFrustum(width / height);
        this._renderOnce();
    }

    _startRenderLoop() {
        if (this._raf) return;
        const loop = () => {
            this._raf = window.requestAnimationFrame(loop);
            if (this.controls) this.controls.update();
            this._renderOnce();
        };
        this._raf = window.requestAnimationFrame(loop);
    }

    _stopRenderLoop() {
        if (this._raf) window.cancelAnimationFrame(this._raf);
        this._raf = null;
    }

    _renderOnce() {
        if (!this.renderer || !this.scene || !this.camera) return;
        try { this.renderer.render(this.scene, this.camera); } catch { }
    }

    _applyOrthoFrustum(aspect = 1) {
        if (!this.camera || !(this.camera instanceof THREE.OrthographicCamera)) return;
        const size = Math.max(0.001, this._orthoSize || 4);
        const a = Math.max(0.001, aspect || 1);
        this.camera.left = -size * a;
        this.camera.right = size * a;
        this.camera.top = size;
        this.camera.bottom = -size;
        this.camera.updateProjectionMatrix();
    }

    _pickTriangle(ev) {
        if (!this.baseMesh || !this.renderer || !this.camera) return;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        this._pointer.set(x, y);
        this._raycaster.setFromCamera(this._pointer, this.camera);
        const hits = this._raycaster.intersectObject(this.baseMesh, false);
        if (!hits.length) return;
        const idx = hits[0]?.faceIndex;
        if (!Number.isFinite(idx)) return;
        const triIdx = Math.max(0, Math.min(this.triangles.length - 1, idx | 0));
        if (!this.triangles[triIdx]) return;
        ev.preventDefault();
        ev.stopPropagation();
        this._selectTriangle(triIdx);
    }

    _setStatus(msg) {
        if (this.statusEl) this.statusEl.textContent = msg || '';
    }

    _extractSolid(target) {
        if (!target) return null;
        const isSolid = (obj) => obj && (String(obj.type || '').toUpperCase() === 'SOLID');
        if (isSolid(target)) return target;
        if (target.parentSolid && isSolid(target.parentSolid)) return target.parentSolid;
        if (target.userData && target.userData.parentSolid && isSolid(target.userData.parentSolid)) return target.userData.parentSolid;
        let cur = target.parent || null;
        while (cur) {
            if (isSolid(cur)) return cur;
            if (cur.parentSolid && isSolid(cur.parentSolid)) return cur.parentSolid;
            cur = cur.parent || null;
        }
        return null;
    }

    _clearGeometry(showPlaceholder = true) {
        if (this.baseMesh) {
            try { this.scene.remove(this.baseMesh); } catch { }
            try { this.baseMesh.geometry?.dispose(); } catch { }
            try {
                const mat = this.baseMesh.material;
                if (Array.isArray(mat)) mat.forEach(m => m?.dispose && m.dispose());
                else if (mat && typeof mat.dispose === 'function') mat.dispose();
            } catch { }
        }
        if (this.edgeLines) {
            try { this.scene.remove(this.edgeLines); } catch { }
            try { this.edgeLines.geometry?.dispose(); } catch { }
            try { this.edgeLines.material?.dispose?.(); } catch { }
        }
        this.baseMesh = null;
        this.edgeLines = null;
        this.triangles = [];
        this._listButtons.clear();
        this._selectedIndex = null;
        this._selectedEdgeKey = null;
        if (this.listEl) {
            this.listEl.innerHTML = '';
            if (showPlaceholder) {
                const empty = document.createElement('div');
                empty.className = 'tri-debugger__empty';
                empty.textContent = 'No triangles loaded.';
                this.listEl.appendChild(empty);
            }
        }
        if (this.infoEl && showPlaceholder) {
            this.infoEl.innerHTML = '<div class="tri-debugger__empty">Select a triangle to see details.</div>';
        }
        if (this.highlightMesh) this.highlightMesh.visible = false;
        if (this.adjacentMesh) this.adjacentMesh.visible = false;
        this._renderOnce();
    }

    _loadSolid(solid) {
        if (!solid || typeof solid.getMesh !== 'function') {
            this._setStatus('Selected item is not a Solid.');
            this._clearGeometry();
            return;
        }
        this._filterText = '';
        if (this.filterInput) this.filterInput.value = '';
        this._clearGeometry(false);
        let mesh = null;
        try {
            mesh = solid.getMesh();
            const vp = mesh?.vertProperties || [];
            const tv = mesh?.triVerts || [];
            const faceIDs = (mesh?.faceID && mesh.faceID.length === (tv.length / 3)) ? mesh.faceID : null;
            const triCount = (tv.length / 3) | 0;
            const fallbackIDs = (!faceIDs && Array.isArray(solid._triIDs) && solid._triIDs.length === triCount) ? solid._triIDs : null;
            if (!triCount) {
                this._setStatus('Solid has no triangles.');
                this._clearGeometry();
                return;
            }

            const idToFace = new Map();
            try { if (solid._idToFaceName && solid._idToFaceName.forEach) solid._idToFaceName.forEach((name, id) => idToFace.set(id, name)); } catch { }
            const faceNameFor = (id, idx) => {
                if (idToFace.has(id)) return idToFace.get(id);
                if (id !== undefined && id !== null) return `Face ${id}`;
                return `Face ${idx}`;
            };

            const positions = new Float32Array(triCount * 9);
            const triangles = new Array(triCount);
            const edgeToTris = new Map();
            const posEdgeToTris = new Map();
            let pw = 0;

            const edgeKeyFromPoints = (a, b) => {
                const pa = [round(a[0]), round(a[1]), round(a[2])];
                const pb = [round(b[0]), round(b[1]), round(b[2])];
                const sa = pa.join(',');
                const sb = pb.join(',');
                return sa < sb ? `${sa}|${sb}` : `${sb}|${sa}`;
            };

            for (let t = 0; t < triCount; t++) {
                const base = t * 3;
                const i0 = tv[base + 0] | 0;
                const i1 = tv[base + 1] | 0;
                const i2 = tv[base + 2] | 0;
                const p0 = [vp[i0 * 3 + 0], vp[i0 * 3 + 1], vp[i0 * 3 + 2]];
                const p1 = [vp[i1 * 3 + 0], vp[i1 * 3 + 1], vp[i1 * 3 + 2]];
                const p2 = [vp[i2 * 3 + 0], vp[i2 * 3 + 1], vp[i2 * 3 + 2]];
                const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
                const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
                const nx = uy * vz - uz * vy;
                const ny = uz * vx - ux * vz;
                const nz = ux * vy - uy * vx;
                const nlen = Math.hypot(nx, ny, nz) || 1;
                const area = 0.5 * nlen;
                const normal = [round(nx / nlen), round(ny / nlen), round(nz / nlen)];
                const centroid = [round((p0[0] + p1[0] + p2[0]) / 3), round((p0[1] + p1[1] + p2[1]) / 3), round((p0[2] + p1[2] + p2[2]) / 3)];
                const fid = faceIDs ? faceIDs[t] : (fallbackIDs ? fallbackIDs[t] : undefined);
                const faceName = faceNameFor(fid, t);

                triangles[t] = {
                    index: t,
                    faceName,
                    indices: [i0, i1, i2],
                    p1: p0, p2: p1, p3: p2,
                    normal,
                    area: round(area),
                    centroid,
                    adjacent: new Set(),
                    hasCrowdedEdge: false,
                    edgeAdjacencies: [],
                    _edgeDefs: [],
                };

                positions[pw++] = p0[0]; positions[pw++] = p0[1]; positions[pw++] = p0[2];
                positions[pw++] = p1[0]; positions[pw++] = p1[1]; positions[pw++] = p1[2];
                positions[pw++] = p2[0]; positions[pw++] = p2[1]; positions[pw++] = p2[2];

                const edges = [
                    { verts: [i0, i1], pts: [p0, p1] },
                    { verts: [i1, i2], pts: [p1, p2] },
                    { verts: [i2, i0], pts: [p2, p0] },
                ];
                for (const edge of edges) {
                    const [a0, b0] = edge.verts;
                    const a = Math.min(a0, b0);
                    const b = Math.max(a0, b0);
                    const key = `${a}|${b}`;
                    const posKey = edgeKeyFromPoints(edge.pts[0], edge.pts[1]);
                    let arr = edgeToTris.get(key);
                    if (!arr) { arr = []; edgeToTris.set(key, arr); }
                    arr.push(t);
                    let arrPos = posEdgeToTris.get(posKey);
                    if (!arrPos) { arrPos = []; posEdgeToTris.set(posKey, arrPos); }
                    arrPos.push(t);
                    triangles[t]._edgeDefs.push({ verts: [a0, b0], keyIndex: key, keyPos: posKey });
                }
            }

            const addAdjacencyFromMap = (map) => {
                for (const [, arr] of map.entries()) {
                    if (!arr || arr.length < 2) continue;
                    const isCrowded = arr.length > 2;
                    for (let i = 0; i < arr.length; i++) {
                        const ti = arr[i];
                        const tri = triangles[ti];
                        if (!tri) continue;
                        for (let j = 0; j < arr.length; j++) {
                            if (i === j) continue;
                            tri.adjacent.add(arr[j]);
                        }
                        if (isCrowded) tri.hasCrowdedEdge = true;
                    }
                }
            };

            addAdjacencyFromMap(edgeToTris);
            addAdjacencyFromMap(posEdgeToTris);

            // Build per-triangle edge adjacency detail (triangles that share each edge, index or position keyed)
            for (const tri of triangles) {
                const detailMap = new Map();
                for (const def of tri._edgeDefs) {
                    const { verts, keyIndex, keyPos } = def;
                    const addEntry = (key, neighborList) => {
                        if (!neighborList || neighborList.length < 2) return;
                        let entry = detailMap.get(key);
                        if (!entry) {
                            entry = { key, verts, neighbors: new Set(), crowded: neighborList.length > 2 };
                            detailMap.set(key, entry);
                        }
                        for (const n of neighborList) {
                            if (Number.isInteger(n) && n !== tri.index) entry.neighbors.add(n);
                        }
                        if (neighborList.length > 2) entry.crowded = true;
                    };
                    addEntry(keyIndex, edgeToTris.get(keyIndex));
                    addEntry(keyPos, posEdgeToTris.get(keyPos));
                }
                tri.edgeAdjacencies = Array.from(detailMap.values()).map(e => ({
                    key: e.key,
                    verts: e.verts,
                    neighbors: Array.from(e.neighbors),
                    crowded: !!e.crowded,
                }));
                tri._edgeDefs = null;
            }
            for (const tri of triangles) tri.adjacent = Array.from(tri.adjacent);

            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geom.computeVertexNormals();
            geom.computeBoundingBox();
            geom.computeBoundingSphere();

            const mat = new THREE.MeshBasicMaterial({
                color: 0x2a3545,
                wireframe: true,
                transparent: true,
                opacity: 0.65,
                side: THREE.DoubleSide,
                depthWrite: false,
            });
            this.baseMesh = new THREE.Mesh(geom, mat);
            this.baseMesh.renderOrder = 1;
            this.scene.add(this.baseMesh);

            try {
                const edgesGeom = new THREE.EdgesGeometry(geom, 15);
                const edgesMat = new THREE.LineBasicMaterial({ color: 0x304050, transparent: true, opacity: 0.45 });
                this.edgeLines = new THREE.LineSegments(edgesGeom, edgesMat);
                this.edgeLines.renderOrder = 2;
                this.scene.add(this.edgeLines);
            } catch { }

            if (!this.highlightMesh) {
                const hGeom = new THREE.BufferGeometry();
                hGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
                this.highlightMesh = new THREE.Mesh(hGeom, new THREE.MeshBasicMaterial({
                    color: 0xffc857,
                    transparent: true,
                    opacity: 0.9,
                    side: THREE.DoubleSide,
                    depthTest: false,
                    depthWrite: false,
                }));
                this.highlightMesh.renderOrder = 3;
                this.highlightMesh.visible = false;
                this.scene.add(this.highlightMesh);
            }
            if (!this.adjacentMesh) {
                this.adjacentMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
                    color: 0x4cc9f0,
                    transparent: true,
                    opacity: 0.35,
                    side: THREE.DoubleSide,
                    depthTest: false,
                    depthWrite: false,
                }));
                this.adjacentMesh.renderOrder = 2.5;
                this.adjacentMesh.visible = false;
                this.scene.add(this.adjacentMesh);
            }

            this.triangles = triangles;
            const faceCount = new Set(triangles.map(t => t.faceName)).size;
            if (this.solidNameEl) this.solidNameEl.textContent = solid.name || 'Solid';
            if (this.solidMetaEl) this.solidMetaEl.textContent = `${triCount} triangles | ${faceCount} faces`;

            this._populateList();
            this._fitCamera(geom);
            if (triangles.length) this._selectTriangle(0);
            this._renderOnce();
        } catch (e) {
            console.warn('[TriangleDebugger] Failed to load solid:', e);
            this._setStatus('Failed to build debug view.');
            this._clearGeometry();
        } finally {
            try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch { }
        }
    }

    _populateList() {
        if (!this.listEl) return;
        this.listEl.innerHTML = '';
        this._listButtons.clear();
        const filter = this._filterText;
        let rendered = 0;
        const frag = document.createDocumentFragment();
        for (const tri of this.triangles) {
            const label = `#${tri.index} ${tri.faceName || ''}`.toLowerCase();
            if (filter && !label.includes(filter)) continue;
            if (this._filterHighValence && !tri.hasCrowdedEdge) continue;
            rendered++;
            const btn = document.createElement('button');
            btn.className = 'tri-debugger__row';
            btn.dataset.index = String(tri.index);
            const adjText = `Adj ${tri.adjacent?.length ?? 0}${tri.hasCrowdedEdge ? ' • crowd' : ''}`;
            btn.innerHTML = `<div class="tri-debugger__row-title">#${tri.index}<span class="tri-debugger__row-face">${tri.faceName || 'face'}</span></div>
                <div class="tri-debugger__row-meta">Area ${tri.area ?? 0} | Normal (${tri.normal.join(', ')}) | ${adjText}</div>`;
            btn.addEventListener('click', () => this._selectTriangle(tri.index));
            frag.appendChild(btn);
            this._listButtons.set(tri.index, btn);
        }
        if (rendered === 0) {
            const empty = document.createElement('div');
            empty.className = 'tri-debugger__empty';
            empty.textContent = filter ? 'No triangles match this filter.' : 'No triangles.';
            this.listEl.appendChild(empty);
        } else {
            this.listEl.appendChild(frag);
        }
        this._highlightListSelection();
    }

    _highlightListSelection() {
        for (const [idx, btn] of this._listButtons.entries()) {
            btn.classList.toggle('is-selected', idx === this._selectedIndex);
        }
    }

    _selectTriangle(index) {
        if (!this.triangles || !this.triangles.length) return;
        const tri = this.triangles[index];
        if (!tri) return;
        this._selectedIndex = index;
        this._selectedEdgeKey = null;
        this._highlightListSelection();
        this._updateHighlight(tri);
        this._updateAdjacentHighlight(tri);
        this._renderInfo(tri);
        this._renderOnce();
        // Scroll into view if needed
        const btn = this._listButtons.get(index);
        if (btn && typeof btn.scrollIntoView === 'function') {
            try { btn.scrollIntoView({ block: 'nearest', behavior: 'auto' }); } catch { }
        }
    }

    _updateHighlight(tri) {
        if (!this.highlightMesh) return;
        const g = this.highlightMesh.geometry;
        const attr = g.getAttribute('position');
        if (!attr || attr.count < 3) {
            g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
        }
        const pos = g.getAttribute('position');
        const pts = [tri.p1, tri.p2, tri.p3];
        let w = 0;
        for (const p of pts) {
            pos.array[w++] = p[0]; pos.array[w++] = p[1]; pos.array[w++] = p[2];
        }
        pos.needsUpdate = true;
        g.computeVertexNormals();
        this.highlightMesh.visible = true;
    }

    _updateAdjacentHighlight(tri) {
        if (!this.adjacentMesh) return;
        const adj = (tri.adjacent || []).map(i => this.triangles[i]).filter(Boolean);
        if (!adj.length) {
            this.adjacentMesh.visible = false;
            return;
        }
        const arr = new Float32Array(adj.length * 9);
        let w = 0;
        for (const t of adj) {
            arr[w++] = t.p1[0]; arr[w++] = t.p1[1]; arr[w++] = t.p1[2];
            arr[w++] = t.p2[0]; arr[w++] = t.p2[1]; arr[w++] = t.p2[2];
            arr[w++] = t.p3[0]; arr[w++] = t.p3[1]; arr[w++] = t.p3[2];
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        geom.computeVertexNormals();
        if (this.adjacentMesh.geometry) {
            try { this.adjacentMesh.geometry.dispose(); } catch { }
        }
        this.adjacentMesh.geometry = geom;
        this.adjacentMesh.visible = true;
    }

    _renderInfo(tri) {
        if (!this.infoEl || !tri) return;
        const adjBadges = (tri.adjacent || []).map((idx) => {
            const face = this.triangles[idx]?.faceName || 'face';
            const sel = idx === this._selectedIndex;
            return `<span class="tri-debugger__badge${sel ? ' is-selected' : ''}" data-adj-index="${idx}">#${idx} | ${face}</span>`;
        }).join('') || '<span class="tri-debugger__badge">None</span>';
        const edges = Array.isArray(tri.edgeAdjacencies) ? tri.edgeAdjacencies : [];
        const edgeBadges = edges.map((e) => {
            const sel = this._selectedEdgeKey === e.key;
            const count = e.neighbors?.length ?? 0;
            const tag = e.crowded ? ' • crowd' : '';
            return `<span class="tri-debugger__badge${sel ? ' is-selected' : ''}" data-edge-key="${e.key}">${e.verts[0]}-${e.verts[1]} | ${count} adj${tag}</span>`;
        }).join('') || '<span class="tri-debugger__badge">None</span>';
        const selEdge = edges.find(e => e.key === this._selectedEdgeKey) || null;
        const edgeNeighbors = selEdge ? selEdge.neighbors || [] : [];
        const edgeNeighborBadges = edgeNeighbors.length
            ? edgeNeighbors.map(idx => {
                const face = this.triangles[idx]?.faceName || 'face';
                return `<span class="tri-debugger__badge" data-adj-index="${idx}">#${idx} | ${face}</span>`;
            }).join('')
            : '<span class="tri-debugger__badge">Select an edge</span>';
        this.infoEl.innerHTML = `
            <div>
                <h4>Triangle</h4>
                <div class="value">#${tri.index}</div>
            </div>
            <div>
                <h4>Face</h4>
                <div class="value">${tri.faceName || '-'}</div>
            </div>
            <div>
                <h4>Indices</h4>
                <div class="value">${tri.indices.join(', ')}</div>
            </div>
            <div>
                <h4>Area</h4>
                <div class="value">${tri.area}</div>
            </div>
            <div>
                <h4>Normal</h4>
                <div class="value">(${tri.normal.join(', ')})</div>
            </div>
            <div>
                <h4>Centroid</h4>
                <div class="value">(${tri.centroid.join(', ')})</div>
            </div>
            <div style="grid-column: 1 / -1;">
                <h4>Adjacent triangles</h4>
                <div class="tri-debugger__badges">${adjBadges}</div>
            </div>
            <div>
                <h4>Edges</h4>
                <div class="tri-debugger__badges">${edgeBadges}</div>
            </div>
            <div>
                <h4>Edge neighbors</h4>
                <div class="tri-debugger__badges">${edgeNeighborBadges}</div>
            </div>
        `;
    }

    _fitCamera(geom = null) {
        if (!this.camera || !this.controls) return;
        const g = geom || this.baseMesh?.geometry;
        if (!g) return;
        try { if (!g.boundingSphere) g.computeBoundingSphere(); } catch { }
        const sphere = g.boundingSphere;
        if (!sphere) return;
        const { center, radius } = sphere;
        const safeRadius = Math.max(0.001, radius);
        const aspect = (() => {
            const rect = this.renderer?.domElement?.getBoundingClientRect();
            return rect && rect.height > 0 ? (rect.width / rect.height) : 1;
        })();
        const size = safeRadius * 1.6;
        this._orthoSize = Math.max(size, 0.001);
        this._applyOrthoFrustum(aspect);

        const dir = new THREE.Vector3(1, 0.8, 1).normalize();
        const dist = safeRadius * 4;
        const pos = dir.multiplyScalar(dist).add(center);
        this.camera.position.copy(pos);
        this.controls.target.copy(center);
        this.camera.near = Math.max(0.001, dist - safeRadius * 6);
        this.camera.far = dist + safeRadius * 6;
        this.camera.updateProjectionMatrix();
        this.controls.update();
        this._renderOnce();
    }

    _handleInfoClick(ev) {
        const target = ev.target;
        if (!target) return;
        const edge = target.closest && target.closest('[data-edge-key]');
        if (edge) {
            const key = edge.dataset.edgeKey || null;
            this._selectedEdgeKey = key;
            const tri = this.triangles[this._selectedIndex];
            if (tri) this._renderInfo(tri);
            return;
        }
        const badge = target.closest && target.closest('[data-adj-index]');
        if (!badge) return;
        const idx = Number(badge.dataset.adjIndex);
        if (!Number.isFinite(idx)) return;
        if (!this.triangles[idx]) return;
        ev.preventDefault();
        ev.stopPropagation();
        this._selectTriangle(idx);
    }
}
