// ES6 module
// Requires three and ArcballControls from three/examples:
//   import * as THREE from 'three';
//   import { ArcballControls } from 'three/examples/jsm/controls/ArcballControls.js';

import * as THREE from 'three';
import { ArcballControls } from 'three/examples/jsm/controls/ArcballControls.js';
import { TransformControls as TransformControlsDirect } from 'three/examples/jsm/controls/TransformControls.js';
import { SceneListing } from './SceneListing.js';
import { CADmaterials, CADmaterialWidget } from './CADmaterials.js';
import { AccordionWidget } from './AccordionWidget.js';
import { OrthoCameraIdle } from './OrthoCameraIdle.js';
import { HistoryWidget } from './HistoryWidget.js';
import { AssemblyConstraintsWidget } from './assembly/AssemblyConstraintsWidget.js';
import { PartHistory } from '../PartHistory.js';
import { SelectionFilter } from './SelectionFilter.js';
import './expressionsManager.js'
import { expressionsManager } from './expressionsManager.js';
import { MainToolbar } from './MainToolbar.js';
import { registerDefaultToolbarButtons } from './toolbarButtons/registerDefaultButtons.js';
import { FileManagerWidget } from './fileManagerWidget.js';
import './mobile.js';
import { SketchMode3D } from './SketchMode3D.js';
import { ViewCube } from './ViewCube.js';
import { FloatingWindow } from './FloatingWindow.js';
import { generateObjectUI } from './objectDump.js';
import { PluginsWidget } from './PluginsWidget.js';
import { localStorage as LS } from '../localStorageShim.js';
import { loadSavedPlugins } from '../plugins/pluginManager.js';
import { PMIViewsWidget } from './pmi/PMIViewsWidget.js';
import { PMIMode } from './pmi/PMIMode.js';
import { annotationRegistry } from './pmi/AnnotationRegistry.js';
import { SchemaForm } from './featureDialogs.js';

export class Viewer {
    /**
     * @param {Object} opts
     * @param {HTMLElement} opts.container - DOM node to mount the canvas
     * @param {number} [opts.viewSize=10] - Ortho half-height at zoom=1 (world units)
     * @param {number} [opts.near=-1000]
     * @param {number} [opts.far=1000]
     * @param {number} [opts.pixelRatio=window.devicePixelRatio || 1]
     * @param {THREE.Color | number | string} [opts.clearColor=0x0b0d10] - dark background
     */
    constructor({
        container,
        viewSize = 10,
        near = -10000000,
        far = 10000000,
        pixelRatio = (window.devicePixelRatio || 1),
        clearColor = 0x0b0d10,
        sidebar = null,
        partHistory = new PartHistory(),
    }) {
        if (!container) throw new Error('Viewer requires { container }');


        this.partHistory = partHistory instanceof PartHistory ? partHistory : new PartHistory();




        // Core
        this.container = container;
        this.sidebar = sidebar;
        this.scene = partHistory instanceof PartHistory ? partHistory.scene : new THREE.Scene();

        // Apply persisted sidebar width early (before building UI)
        try {
            if (this.sidebar) {
                const raw = LS.getItem('__CAD_MATERIAL_SETTINGS__');
                if (raw) {
                    try {
                        const obj = JSON.parse(raw);
                        const w = parseInt(obj && obj['__SIDEBAR_WIDTH__']);
                        if (Number.isFinite(w) && w > 0) this.sidebar.style.width = `${w}px`;
                    } catch { /* ignore parse errors */ }
                }
            }
        } catch { /* ignore */ }

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, });
        this.renderer.setClearColor(new THREE.Color(clearColor), 1);
        this.pixelRatio = pixelRatio; // persist for future resizes
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.domElement.style.display = 'block';
        this.renderer.domElement.style.outline = 'none';
        this.renderer.domElement.style.userSelect = 'none';
        this.renderer.domElement.style.background = '#0b0d10'; // dark mode
        this.container.appendChild(this.renderer.domElement);





        // Camera (Orthographic)
        this.viewSize = viewSize;
        const { width, height } = this._getContainerSize();
        const aspect = width / height || 1;
        this.camera = new OrthoCameraIdle(
            -viewSize * aspect,
            viewSize * aspect,
            viewSize,
            -viewSize,
            near,
            far
        );





        // Nice default vantage
        this.camera.position.set(15, 12, 15);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(0, 0, 0);

        // Controls (Arcball)
        this.controls = new ArcballControls(this.camera, this.renderer.domElement, this.scene);
        this.controls.enableAnimations = false;
        this.controls.setGizmosVisible(false);
        this.controls.minDistance = 0.01; // relevant when switching to perspective; harmless here


        this.camera.enableIdleCallbacks({
            controls: this.controls,
            idleMs: 300,
            onMove: () => {
                // hide sidebar when moving
                if (this.sidebar) {
                    this.sidebar.style.opacity = .9;
                }
                // (quiet) camera moving
            },
            onIdle: () => {
                // show sidebar when idle
                if (this.sidebar) {
                    this.sidebar.style.opacity = .9;
                }

                // recompute bounding spheres for all geometries (Mesh, Line/Line2, Points)
                this.scene.traverse((object) => {
                    const g = object && object.geometry;
                    if (g && typeof g.computeBoundingSphere === 'function') {
                        try { g.computeBoundingSphere(); } catch (_) { /* noop */ }
                    }
                });
            }
        })




        // State for interaction
        this._pointerDown = false;
        this._downButton = 0;           // 0 left, 2 right
        this._downPos = { x: 0, y: 0 };
        this._dragThreshold = 5;        // pixels
        this._raf = null;
        this._disposed = false;
        this._sketchMode = null;
        this._lastPointerEvent = null;
        this._cubeActive = false;
        // Inspector panel state
        this._inspectorOpen = false;
        this._inspectorEl = null;
        this._inspectorContent = null;
        // Plugin-related state
        this._pendingToolbarButtons = [];
        // Component transform gizmo session state
        this._componentTransformSession = null;

        // Raycaster for picking
        this.raycaster = new THREE.Raycaster();
        // Initialize params containers; thresholds set per-pick for stability
        try { this.raycaster.params.Line = this.raycaster.params.Line || {}; } catch { }
        try { this.raycaster.params.Line2 = this.raycaster.params.Line2 || {}; } catch { }

        // Bindings
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);
        this._onContextMenu = this._onContextMenu.bind(this);
        this._onResize = this._onResize.bind(this);
        this._onControlsChange = this._onControlsChange.bind(this);
        this._loop = this._loop.bind(this);
        this._updateHover = this._updateHover.bind(this);
        this._selectAt = this._selectAt.bind(this);
        this._onDoubleClick = this._onDoubleClick.bind(this);

        // Events
        const el = this.renderer.domElement;
        el.addEventListener('pointermove', this._onPointerMove, { passive: true });
        el.addEventListener('pointerleave', () => {
            try { SelectionFilter.clearHover(); } catch (_) { }
            // When pointer leaves the canvas, forget the last pointer event
            this._lastPointerEvent = null;
        }, { passive: true });
        el.addEventListener('pointerenter', (ev) => { this._lastPointerEvent = ev; }, { passive: true });
        el.addEventListener('pointerdown', this._onPointerDown, { passive: false });
        // Use capture on pointerup to ensure we end interactions even if pointerup fires off-element
        window.addEventListener('pointerup', this._onPointerUp, { passive: false, capture: true });
        el.addEventListener('dblclick', this._onDoubleClick, { passive: false });
        el.addEventListener('contextmenu', this._onContextMenu);
        window.addEventListener('resize', this._onResize);
        // Keep camera updates; no picking to sync
        this.controls.addEventListener('change', this._onControlsChange);

        this.SelectionFilter = SelectionFilter;

        // Expose annotation registry for PMI modules and plugins
        this.annotationRegistry = annotationRegistry;

        // View cube overlay
        this.viewCube = new ViewCube({
            renderer: this.renderer,
            targetCamera: this.camera,
            controls: this.controls,
            size: 120,
            margin: 12,
        });

        // Initial sizing + start
        this._resizeRendererToDisplaySize();
        this._loop();
        this.setupAccordion();
    }


    async setupAccordion() {
        // Setup accordion
        this.accordion = await new AccordionWidget();
        await this.sidebar.appendChild(this.accordion.uiElement);


        // Load saved plugins early (before File Manager autoloads last model)
        // Defer rendering of plugin side panels until proper placement later.
        try {
            await loadSavedPlugins(this);
        } catch (e) { console.warn('Plugin auto-load failed:', e); }

        const fm = new FileManagerWidget(this);
        const fmSection = await this.accordion.addSection('File Manager');
        fmSection.uiElement.appendChild(fm.uiElement);
        // Expose for toolbar Save button
        this.fileManagerWidget = fm;

        // Setup historyWidget
        this.historyWidget = await new HistoryWidget(this);
        this.partHistory.callbacks.run = async (featureID) => {
            //await this.historyWidget.renderHistory(featureID);
        };
        this.partHistory.callbacks.reset = async () => {
            //await this.historyWidget.reset();
        };
        const historySection = await this.accordion.addSection("History");
        await historySection.uiElement.appendChild(await this.historyWidget.uiElement);

        this.assemblyConstraintsWidget = new AssemblyConstraintsWidget(this);
        const constraintsSection = await this.accordion.addSection('Assembly Constraints');
        constraintsSection.uiElement.appendChild(this.assemblyConstraintsWidget.uiElement);

        // setup expressions
        this.expressionsManager = await new expressionsManager(this);
        const expressionsSection = await this.accordion.addSection("Expressions");
        await expressionsSection.uiElement.appendChild(await this.expressionsManager.uiElement);

        // Setup sceneManagerUi
        this.sceneManagerUi = await new SceneListing(this.scene);
        const sceneSection = await this.accordion.addSection("Scene Manager");
        await sceneSection.uiElement.appendChild(this.sceneManagerUi.uiElement);

        // PMI Views (saved camera snapshots)
        this.pmiViewsWidget = new PMIViewsWidget(this);
        const pmiViewsSection = await this.accordion.addSection("PMI Views");
        pmiViewsSection.uiElement.appendChild(this.pmiViewsWidget.uiElement);

        // CADmaterials (Settings panel)
        this.cadMaterialsUi = await new CADmaterialWidget();
        const displaySection = await this.accordion.addSection("Display Settings");
        await displaySection.uiElement.appendChild(this.cadMaterialsUi.uiElement);

        // From this point on, plugin UI can be added immediately,
        // and should be inserted just before the "Display Settings" panel.
        this._pluginUiReady = true;

        // Drain any queued plugin side panels so they appear immediately before settings
        try {
            const q = Array.isArray(this._pendingSidePanels) ? this._pendingSidePanels : [];
            this._pendingSidePanels = [];
            for (const it of q) {
                try { await this._applyPluginSidePanel(it); } catch { }
            }
        } catch { }

        // Plugin setup panel (after settings)
        const pluginsSection = await this.accordion.addSection('Plugins');
        const pluginsWidget = new PluginsWidget(this);
        pluginsSection.uiElement.appendChild(pluginsWidget.uiElement);

        await this.accordion.collapseAll();
        await this.accordion.expandSection("Scene Manager");

        await this.accordion.expandSection("History");
        await this.accordion.expandSection("Assembly Constraints");
        await this.accordion.expandSection("PMI Views");



        // Mount the main toolbar (layout only; buttons registered externally)
        this.mainToolbar = new MainToolbar(this);
        // Register core/default toolbar buttons via the public API
        try { registerDefaultToolbarButtons(this); } catch { }
        // Drain any queued custom toolbar buttons from early plugin registration
        try {
            const q = Array.isArray(this._pendingToolbarButtons) ? this._pendingToolbarButtons : [];
            this._pendingToolbarButtons = [];
            for (const it of q) {
                try { this.mainToolbar.addCustomButton(it); } catch { }
            }
        } catch { }

        // Ensure toolbar sits above the canvas and doesn't block controls when not hovered
        try { this.renderer.domElement.style.marginTop = '0px'; } catch { }
    }

    // Public: allow plugins to add toolbar buttons even before MainToolbar is constructed
    addToolbarButton(label, title, onClick) {
        const item = { label, title, onClick };
        if (this.mainToolbar && typeof this.mainToolbar.addCustomButton === 'function') {
            try { return this.mainToolbar.addCustomButton(item); } catch { return null; }
        }
        this._pendingToolbarButtons = this._pendingToolbarButtons || [];
        this._pendingToolbarButtons.push(item);
        return null;
    }

    // Apply a single queued plugin side panel entry
    async _applyPluginSidePanel({ title, content }) {
        if (!this.accordion || typeof this.accordion.addSection !== 'function') return null;
        const t = String(title || 'Plugin');
        const sec = await this.accordion.addSection(t);
        if (!sec) return null;
        try {
            if (typeof content === 'function') {
                const el = await content();
                if (el) sec.uiElement.appendChild(el);
            } else if (content instanceof HTMLElement) {
                sec.uiElement.appendChild(content);
            } else if (content != null) {
                const pre = document.createElement('pre');
                pre.textContent = String(content);
                sec.uiElement.appendChild(pre);
            }
            // Reposition this plugin section to immediately before the Display Settings panel, if present
            try {
                const root = this.accordion.uiElement;
                const targetTitle = root.querySelector('.accordion-title[name="accordion-title-Display Settings"]');
                if (targetTitle) {
                    const secTitle = root.querySelector(`.accordion-title[name="accordion-title-${t}"]`);
                    if (secTitle && sec.uiElement && secTitle !== targetTitle) {
                        root.insertBefore(secTitle, targetTitle);
                        root.insertBefore(sec.uiElement, targetTitle);
                    }
                }
            } catch { }
        } catch { }
        return sec;
    }

    // Public: allow plugins to register side panels; queued until core UI/toolbar are ready
    async addPluginSidePanel(title, content) {
        const item = { title, content };
        if (this._pluginUiReady) {
            try { return await this._applyPluginSidePanel(item); } catch { return null; }
        }
        this._pendingSidePanels = this._pendingSidePanels || [];
        this._pendingSidePanels.push(item);
        return null;
    }

    // ————————————————————————————————————————
    // Public API
    // ————————————————————————————————————————
    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        cancelAnimationFrame(this._raf);
        try { this._stopComponentTransformSession(); } catch { }
        const el = this.renderer.domElement;
        el.removeEventListener('pointermove', this._onPointerMove);
        el.removeEventListener('pointerdown', this._onPointerDown);
        window.removeEventListener('pointerup', this._onPointerUp, { capture: true });
        el.removeEventListener('dblclick', this._onDoubleClick);
        el.removeEventListener('contextmenu', this._onContextMenu);
        window.removeEventListener('resize', this._onResize);
        this.controls.dispose();
        this.renderer.dispose();
        if (el.parentNode) el.parentNode.removeChild(el);
    }

    // ————————————————————————————————————————
    // Sketch Mode API
    // ————————————————————————————————————————
    startSketchMode(featureID) {
        // Hide the sketch in the scene if it exists
        try {
            const ph = this.partHistory.getObjectByName(featureID);
            if (ph) ph.visible = false;
        } catch (e) {
            console.log(e);
            console.log(this.viewer);
        }

        console.log('Starting Sketch Mode for featureID:', featureID);
        console.log(this.partHistory.scene);
        console.log(this.partHistory);
        console.log(this);

        try { if (this._sketchMode) this._sketchMode.dispose(); } catch { }
        this._sketchMode = new SketchMode3D(this, featureID);
        this._sketchMode.open();


    }

    onSketchFinished(featureID, sketchObject) {
        const ph = this.partHistory;
        if (!ph || !featureID) return;
        // Always restore normal UI first
        this.endSketchMode();
        const f = Array.isArray(ph.features) ? ph.features.find(x => x?.inputParams?.featureID === featureID) : null;
        if (!f) return;
        f.lastRunInputParams = {};
        f.timestamp = 0;
        f.dirty = true;
        f.persistentData = f.persistentData || {};
        f.persistentData.sketch = sketchObject || {};
        // re-run to keep downstream in sync (even if SketchFeature.run has no output yet)
        try { ph.runHistory(); } catch { }
    }

    onSketchCancelled(_featureID) {
        this.endSketchMode();
    }

    endSketchMode() {
        try { if (this._sketchMode) this._sketchMode.close(); } catch { }
        this._sketchMode = null;
        // Ensure core UI is visible and controls enabled
        try {
            if (this.sidebar) {
                this.sidebar.hidden = false;
                try { this.sidebar.style.removeProperty('display'); } catch { }
                this.sidebar.style.display = this.sidebar.style.display || '';
                this.sidebar.style.visibility = 'visible';
                this.sidebar.style.opacity = .9;
                // Ensure sidebar is drawn above everything else again
                this.sidebar.style.zIndex = String(7);
            }
        } catch { }
        try { if (this.controls) this.controls.enabled = true; } catch { }

        // Clean up any legacy overlays that might still be mounted (from old 2D mode)
        try {
            const c = this.container;
            if (c && typeof c.querySelectorAll === 'function') {
                const leftovers = c.querySelectorAll('.sketch-overlay');
                leftovers.forEach(el => { try { el.parentNode && el.parentNode.removeChild(el); } catch { } });
            }
        } catch { }
    }

    // ————————————————————————————————————————
    // PMI Edit Mode API
    // ————————————————————————————————————————
    startPMIMode(viewEntry, viewIndex, widget = this.pmiViewsWidget) {
        const alreadyActive = !!this._pmiMode;
        if (!alreadyActive) {
            try { this.assemblyConstraintsWidget?.onPMIModeEnter?.(); } catch { }
        }
        try { if (this._pmiMode) this._pmiMode.dispose(); } catch { }
        try {
            this._pmiMode = new PMIMode(this, viewEntry, viewIndex, widget);
            this._pmiMode.open();
        } catch (error) {
            this._pmiMode = null;
            if (!alreadyActive) {
                try { this.assemblyConstraintsWidget?.onPMIModeExit?.(); } catch { }
            }
            throw error;
        }
    }

    onPMIFinished(_updatedView) {
        this.endPMIMode();
    }

    onPMICancelled() {
        this.endPMIMode();
    }

    endPMIMode() {
        const hadMode = !!this._pmiMode;
        try { if (this._pmiMode) this._pmiMode.dispose(); } catch { }
        this._pmiMode = null;
        if (hadMode) {
            try { this.assemblyConstraintsWidget?.onPMIModeExit?.(); } catch { }
        }
        // Robustly restore core UI similar to endSketchMode
        try {
            if (this.sidebar) {
                this.sidebar.hidden = false;
                try { this.sidebar.style.removeProperty('display'); } catch { }
                this.sidebar.style.display = this.sidebar.style.display || '';
                this.sidebar.style.visibility = 'visible';
                this.sidebar.style.opacity = .9;
                this.sidebar.style.zIndex = String(7);
            }
        } catch { }
        try { if (this.controls) this.controls.enabled = true; } catch { }
    }

    render() {
        this.renderer.render(this.scene, this.camera);
        try { this.viewCube && this.viewCube.render(); } catch { }
    }

    // Zoom-to-fit using only ArcballControls operations (pan + zoom).
    // Does not alter camera orientation or frustum parameters (left/right/top/bottom).
    zoomToFit(margin = 1.1) {
        try {
            const c = this.controls;
            if (!c) return;

            // Build world-space bounds of all visible geometry (exclude UI + groups)
            const box = new THREE.Box3();
            box.makeEmpty();
            this.scene.traverse((obj) => {
                if (!obj || !obj.visible) return;
                // Only include leaf geometry objects to avoid pulling in excluded children via parents
                const isGeom = !!(obj.isMesh || obj.isLine || obj.isLineSegments || obj.isLineLoop || obj.isLine2 || obj.isPoints);
                if (!isGeom) return;
                // Exclude Arcball gizmos/grid from fitting
                if (this.controls) {
                    const giz = this.controls._gizmos;
                    const grid = this.controls._grid;
                    let p = obj;
                    while (p) {
                        if (p === giz || p === grid) return;
                        p = p.parent;
                    }
                }
                // Exclude active TransformControls gizmo/helper from fitting
                try {
                    const ax = (typeof window !== 'undefined') ? (window.__BREP_activeXform || null) : null;
                    if (ax) {
                        const tc = ax.controls || null;
                        const group = ax.group || null;
                        // Collect likely Object3D parts across three versions
                        const parts = new Set();
                        const addIfObj = (o) => { try { if (o && o.isObject3D) parts.add(o); } catch (_) { } };
                        addIfObj(group);
                        addIfObj(tc);
                        addIfObj(tc && tc.getHelper ? tc.getHelper() : null);
                        addIfObj(tc && tc.__helper);
                        addIfObj(tc && tc.__fallbackGroup);
                        addIfObj(tc && tc.gizmo);
                        addIfObj(tc && tc._gizmo);
                        addIfObj(tc && tc.picker);
                        addIfObj(tc && tc._picker);
                        addIfObj(tc && tc.helper);
                        addIfObj(tc && tc._helper);
                        let p = obj;
                        while (p) {
                            if (parts.has(p)) return;
                            // Also skip well-known fallback group name
                            if (p.name === 'TransformControlsGroup') return;
                            p = p.parent;
                        }
                    }
                } catch { /* ignore */ }
                // Heuristic: skip any objects named like TransformControls (defensive against unknown builds)
                try {
                    let p = obj;
                    while (p) {
                        const n = (p.name || '');
                        if (typeof n === 'string' && /TransformControls/i.test(n)) return;
                        p = p.parent;
                    }
                } catch { }
                // Custom opt-out
                try { if (obj.userData && obj.userData.excludeFromFit) return; } catch { }
                try { box.expandByObject(obj); } catch { /* ignore */ }
            });
            if (box.isEmpty()) return;

            // Ensure matrices are current
            this.camera.updateMatrixWorld(true);

            // Compute extents in camera space (preserve orientation)
            const corners = [
                new THREE.Vector3(box.min.x, box.min.y, box.min.z),
                new THREE.Vector3(box.min.x, box.min.y, box.max.z),
                new THREE.Vector3(box.min.x, box.max.y, box.min.z),
                new THREE.Vector3(box.min.x, box.max.y, box.max.z),
                new THREE.Vector3(box.max.x, box.min.y, box.min.z),
                new THREE.Vector3(box.max.x, box.min.y, box.max.z),
                new THREE.Vector3(box.max.x, box.max.y, box.min.z),
                new THREE.Vector3(box.max.x, box.max.y, box.max.z),
            ];
            const inv = new THREE.Matrix4().copy(this.camera.matrixWorld).invert();
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of corners) {
                p.applyMatrix4(inv);
                if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
            }
            const camWidth = Math.max(1e-6, (maxX - minX));
            const camHeight = Math.max(1e-6, (maxY - minY));

            // Compute target zoom for orthographic camera using current frustum and viewport aspect.
            const { width, height } = this._getContainerSize();
            const aspect = Math.max(1e-6, width / height);
            const v = this.viewSize; // current half-height before zoom scaling
            const halfW = camWidth / 2 * Math.max(1, margin);
            const halfH = camHeight / 2 * Math.max(1, margin);
            const maxZoomByHeight = v / halfH;
            const maxZoomByWidth = (v * aspect) / halfW;
            const targetZoom = Math.min(maxZoomByHeight, maxZoomByWidth);
            const currentZoom = this.camera.zoom || 1;
            const sizeFactor = Math.max(1e-6, targetZoom / currentZoom);

            // Compute world center of the box
            const center = box.getCenter(new THREE.Vector3());

            // Perform pan+zoom via ArcballControls only
            try { c.updateMatrixState && c.updateMatrixState(); } catch { }
            c.focus(center, sizeFactor);

            // Sync and render
            try { c.update && c.update(); } catch { }
            this.render();
        } catch { /* noop */ }
    }

    // Wireframe toggle for all materials
    setWireframe(enabled) {
        this._wireframeEnabled = !!enabled;
        try {
            this.scene.traverse((obj) => {
                // Exclude edge/loop/line objects from wireframe toggling
                if (!obj) return;
                if (obj.type === 'EDGE' || obj.type === 'LOOP' || obj.isLine || obj.isLine2 || obj.isLineSegments || obj.isLineLoop) return;

                const apply = (mat) => { if (mat && 'wireframe' in mat) mat.wireframe = !!enabled; };
                if (obj.material) {
                    if (Array.isArray(obj.material)) obj.material.forEach(apply); else apply(obj.material);
                }
            });
        } catch { /* ignore */ }
        this.render();
    }
    toggleWireframe() { this.setWireframe(!this._wireframeEnabled); }

    // ————————————————————————————————————————
    // Internal: Animation Loop
    // ————————————————————————————————————————
    _loop() {
        this._raf = requestAnimationFrame(this._loop);
        this.controls.update();
        try {
            const ax = (typeof window !== 'undefined') ? (window.__BREP_activeXform || null) : null;
            const tc = ax && ax.controls;
            if (tc) {
                if (typeof tc.update === 'function') tc.update();
                else tc.updateMatrixWorld(true);
            }
        } catch { }
        this.render();
    }

    // ————————————————————————————————————————
    // Internal: Picking helpers
    // ————————————————————————————————————————
    _getPointerNDC(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        // Convert to NDC (-1..1)
        return new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
    }

    _mapIntersectionToTarget(intersection) {
        if (!intersection || !intersection.object) return null;
        const curType = SelectionFilter.getCurrentType && SelectionFilter.getCurrentType();

        // Prefer the intersected object if it is clickable
        let obj = intersection.object;

        // If current selection is SOLID, promote to nearest SOLID ancestor
        if (curType === SelectionFilter.SOLID) {
            let p = obj;
            while (p) {
                if (p.type === SelectionFilter.SOLID) { obj = p; break; }
                p = p.parent;
            }
        }

        // If the object (or its ancestors) doesn't expose onClick, climb to one that does
        let target = obj;
        while (target && typeof target.onClick !== 'function') target = target.parent;
        if (!target) return null;

        // Respect selection filter: ensure target is a permitted type, or ALL
        if (typeof SelectionFilter.IsAllowed === 'function') {
            // Allow selecting already-selected items regardless (toggle off), consistent with SceneListing
            if (!SelectionFilter.IsAllowed(target.type) && !target.selected) {
                // Try to find a closer ancestor/descendant of allowed type that is clickable
                // Ascend first (e.g., FACE hit while EDGE is active should try parent SOLID only if allowed)
                let t = target.parent;
                while (t && typeof t.onClick === 'function' && !SelectionFilter.IsAllowed(t.type)) t = t.parent;
                if (t && typeof t.onClick === 'function' && SelectionFilter.IsAllowed(t.type)) target = t;
                else return null;
            }
        }
        return target;
    }

    _pickAtEvent(event) {
        // While Sketch Mode is active, suppress normal scene picking
        // SketchMode3D manages its own picking for sketch points/curves and model edges.
        if (this._sketchMode) return { hit: null, target: null };
        if (!event) return { hit: null, target: null };
        const ndc = this._getPointerNDC(event);
        this.raycaster.setFromCamera(ndc, this.camera);
        // Tune line picking thresholds per-frame based on zoom and DPI
        try {
            const rect = this.renderer.domElement.getBoundingClientRect();
            const wpp = this._worldPerPixel(this.camera, rect.width, rect.height);
            this.raycaster.params.Line = this.raycaster.params.Line || {};
            this.raycaster.params.Line.threshold = Math.max(0.05, wpp * 6);
            const dpr = (window.devicePixelRatio || 1);
            this.raycaster.params.Line2 = this.raycaster.params.Line2 || {};
            this.raycaster.params.Line2.threshold = Math.max(1, 2 * dpr);
            // Improve point picking tolerance using world-units per pixel
            this.raycaster.params.Points = this.raycaster.params.Points || {};
            this.raycaster.params.Points.threshold = Math.max(0.05, wpp * 6);
        } catch { }
        // Shift the ray origin far behind the camera along the ray direction
        try {
            const span = Math.abs((this.camera?.far ?? 0) - (this.camera?.near ?? 0)) || 1;
            const back = Math.max(1e6, span * 1000);
            this.raycaster.ray.origin.addScaledVector(this.raycaster.ray.direction, -back);
        } catch { }
        // Intersect everything; raycaster will skip non-geometry nodes
        const intersects = this.raycaster.intersectObjects(this.scene.children, true);
        for (const it of intersects) {
            const target = this._mapIntersectionToTarget(it);
            if (target) return { hit: it, target };
        }
        return { hit: null, target: null };
    }

    _updateHover(event) {
        const { target } = this._pickAtEvent(event);
        if (target) {
            try { SelectionFilter.setHoverObject(target); } catch { }
        } else {
            try { SelectionFilter.clearHover(); } catch { }
        }
    }

    _selectAt(event) {
        const { target } = this._pickAtEvent(event);
        if (!target) return;
        // One-shot diagnostic inspector
        if (this._diagPickOnce) {
            this._diagPickOnce = false;
            try { this._showDiagnosticsFor(target); } catch (e) { try { console.warn('Diagnostics failed:', e); } catch { } }
            // Restore selection filter if we changed it
            if (this._diagRestoreFilter) {
                try { SelectionFilter.restoreAllowedSelectionTypes && SelectionFilter.restoreAllowedSelectionTypes(); } catch { }
                this._diagRestoreFilter = false;
            }
        }
        // If inspector panel is open, update it immediately for the clicked object
        if (this._inspectorOpen) {
            try { this._updateInspectorFor(target); } catch (e) { try { console.warn('Inspector update failed:', e); } catch { } }
        }
        const metadataPanel = this.__metadataPanelController;
        if (metadataPanel && typeof metadataPanel.handleSelection === 'function') {
            try { metadataPanel.handleSelection(target); }
            catch (e) { try { console.warn('Metadata panel update failed:', e); } catch { } }
        }
        if (typeof target.onClick === 'function') {
            try { target.onClick(); } catch { }
        }
    }

    // ————————————————————————————————————————
    // Internal: Event Handlers
    // ————————————————————————————————————————
    _onPointerMove(event) {
        if (this._disposed) return;
        // Keep last pointer position and refresh hover
        this._lastPointerEvent = event;
        // If hovering over the view cube, avoid main-scene hover
        try {
            if (this.viewCube && this.viewCube.isEventInside(event)) return;
        } catch { }
        // If hovering TransformControls gizmo, skip scene hover handling
        try {
            const ax = (typeof window !== 'undefined') ? (window.__BREP_activeXform || null) : null;
            if (ax && typeof ax.isOver === 'function' && ax.isOver(event)) return;
        } catch { }
        this._updateHover(event);
    }

    _onPointerDown(event) {
        if (this._disposed) return;
        // If pointer is over TransformControls gizmo, let it handle the interaction
        try {
            const ax = (typeof window !== 'undefined') ? (window.__BREP_activeXform || null) : null;
            if (ax && typeof ax.isOver === 'function' && ax.isOver(event)) { try { event.preventDefault(); } catch { }; return; }
        } catch { }
        // If pressing in the view cube region, disable controls for this gesture
        try {
            this._cubeActive = !!(this.viewCube && this.viewCube.isEventInside(event));
        } catch { this._cubeActive = false; }
        this._pointerDown = true;
        this._downButton = event.button;
        this._downPos.x = event.clientX;
        this._downPos.y = event.clientY;
        this.controls.enabled = !this._cubeActive;
        // Prevent default to avoid unwanted text selection/scroll on drag
        try { event.preventDefault(); } catch { }
    }

    _onPointerUp(event) {
        if (this._disposed) return;
        // If releasing over TransformControls gizmo, skip scene selection
        try {
            const ax = (typeof window !== 'undefined') ? (window.__BREP_activeXform || null) : null;
            if (ax && typeof ax.isOver === 'function' && ax.isOver(event)) { try { event.preventDefault(); } catch { }; return; }
        } catch { }
        // If the gesture began in the cube, handle click there exclusively
        if (this._cubeActive) {
            try { if (this.viewCube && this.viewCube.handleClick(event)) { this._cubeActive = false; return; } } catch { }
            this._cubeActive = false;
        }
        // Click selection if within drag threshold and left button
        const dx = Math.abs(event.clientX - this._downPos.x);
        const dy = Math.abs(event.clientY - this._downPos.y);
        const moved = (dx + dy) > this._dragThreshold;
        if (this._pointerDown && this._downButton === 0 && !moved) {
            this._selectAt(event);
        }
        // Reset flags and keep controls enabled
        this._pointerDown = false;
        this.controls.enabled = true;
        void event;
    }

    _onContextMenu(event) {
        // No interactive targets; allow default context menu
        void event;
    }

    _findOwningComponent(obj) {
        let cur = obj;
        while (cur) {
            if (cur.isAssemblyComponent || cur.type === SelectionFilter.COMPONENT || cur.type === 'COMPONENT') {
                return cur;
            }
            cur = cur.parent;
        }
        return null;
    }

    _stopComponentTransformSession() {
        const session = this._componentTransformSession;
        if (!session) return;
        const { controls, helper, target, changeHandler, dragHandler, objectChangeHandler, globalState } = session;

        try { controls?.removeEventListener('change', changeHandler); } catch { }
        try { controls?.removeEventListener('dragging-changed', dragHandler); } catch { }
        try { controls?.removeEventListener('objectChange', objectChangeHandler); } catch { }

        try { controls?.detach?.(); } catch { }

        if (this.scene) {
            try { if (controls && controls.isObject3D) this.scene.remove(controls); } catch { }
            try { if (helper && helper.isObject3D) this.scene.remove(helper); } catch { }
            try { if (target && target.isObject3D) this.scene.remove(target); } catch { }
        }

        try { controls?.dispose?.(); } catch { }

        try {
            if (window.__BREP_activeXform === globalState) {
                window.__BREP_activeXform = null;
            }
        } catch { }

        this._componentTransformSession = null;
        try { if (this.controls) this.controls.enabled = true; } catch { }
        try { this.render(); } catch { }
    }

    _activateComponentTransform(component) {
        if (!component) return;
        if (component.fixed) return;
        const TCctor = TransformControlsDirect;
        if (!TCctor) {
            console.warn('[Viewer] TransformControls unavailable; cannot activate component gizmo.');
            return;
        }

        this._stopComponentTransformSession();
        try { if (SchemaForm && typeof SchemaForm.__stopGlobalActiveXform === 'function') SchemaForm.__stopGlobalActiveXform(); } catch { }

        const controls = new TCctor(this.camera, this.renderer.domElement);
        const initialMode = 'translate';
        try { controls.setMode(initialMode); } catch { controls.mode = initialMode; }
        try { controls.showX = controls.showY = controls.showZ = true; } catch { }

        const target = new THREE.Object3D();
        target.name = `ComponentTransformTarget:${component.name || component.uuid || ''}`;

        try { this.scene.updateMatrixWorld?.(true); } catch { }
        try { component.updateMatrixWorld?.(true); } catch { }

        const box = new THREE.Box3();
        const center = box.setFromObject(component).isEmpty()
            ? component.getWorldPosition(new THREE.Vector3())
            : box.getCenter(new THREE.Vector3());
        target.position.copy(center);

        const componentWorldQuat = component.getWorldQuaternion(new THREE.Quaternion());
        target.quaternion.copy(componentWorldQuat);

        const parent = component.parent || this.scene;
        try { parent?.updateMatrixWorld?.(true); } catch { }

        const offsetLocal = component.getWorldPosition(new THREE.Vector3()).sub(center);
        const initialTargetQuatInv = componentWorldQuat.clone().invert();
        offsetLocal.applyQuaternion(initialTargetQuatInv);

        const parentInverse = new THREE.Matrix4();
        if (parent && parent.isObject3D) {
            parentInverse.copy(parent.matrixWorld).invert();
        } else {
            parentInverse.identity();
        }

        this.scene.add(target);
        try { controls.attach(target); } catch { }
        try {
            controls.userData = controls.userData || {};
            controls.userData.excludeFromFit = true;
            this.scene.add(controls);
        } catch { }

        let helper = null;
        try {
            helper = typeof controls.getHelper === 'function' ? controls.getHelper() : null;
            if (helper && helper.isObject3D) {
                helper.userData = helper.userData || {};
                helper.userData.excludeFromFit = true;
                this.scene.add(helper);
            }
        } catch { helper = null; }

        const markOverlay = (obj) => {
            if (!obj || !obj.isObject3D) return;
            const apply = (node) => {
                if (!node || !node.isObject3D) return;
                const ud = node.userData || (node.userData = {});
                if (ud.__brepOverlayHook) return;
                const prev = node.onBeforeRender;
                node.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
                    try { renderer.clearDepth(); } catch { }
                    if (typeof prev === 'function') {
                        prev.call(this, renderer, scene, camera, geometry, material, group);
                    }
                };
                ud.__brepOverlayHook = true;
            };
            apply(obj);
            try { obj.traverse((child) => apply(child)); } catch { }
        };
        try { markOverlay(controls); } catch { }
        try { markOverlay(helper); } catch { }
        try { markOverlay(controls?._gizmo); } catch { }
        try { markOverlay(controls?.gizmo); } catch { }

        const scratchTargetWorld = new THREE.Vector3();
        const scratchComponentWorld = new THREE.Vector3();
        const scratchLocal = new THREE.Vector3();
        const scratchRotatedOffset = new THREE.Vector3();
        const scratchTargetQuat = new THREE.Quaternion();
        const scratchParentQuat = new THREE.Quaternion();
        const scratchParentQuatInv = new THREE.Quaternion();
        const scratchComponentQuat = new THREE.Quaternion();

        const updateComponentTransform = (commit = false) => {
            try {
                try { this.scene.updateMatrixWorld?.(true); } catch { }
                try { target.updateMatrixWorld?.(true); } catch { }
                if (parent && parent.isObject3D) {
                    try { parent.updateMatrixWorld?.(true); } catch { }
                    parentInverse.copy(parent.matrixWorld).invert();
                    parent.getWorldQuaternion(scratchParentQuat);
                    scratchParentQuatInv.copy(scratchParentQuat).invert();
                } else {
                    parentInverse.identity();
                    scratchParentQuat.set(0, 0, 0, 1);
                    scratchParentQuatInv.copy(scratchParentQuat);
                }

                target.getWorldPosition(scratchTargetWorld);
                target.getWorldQuaternion(scratchTargetQuat);

                scratchRotatedOffset.copy(offsetLocal).applyQuaternion(scratchTargetQuat);
                scratchComponentWorld.copy(scratchTargetWorld).add(scratchRotatedOffset);
                scratchLocal.copy(scratchComponentWorld);
                if (parent && parent.isObject3D) {
                    scratchLocal.applyMatrix4(parentInverse);
                }
                component.position.copy(scratchLocal);
                if (parent && parent.isObject3D) {
                    scratchComponentQuat.copy(scratchParentQuatInv).multiply(scratchTargetQuat);
                    component.quaternion.copy(scratchComponentQuat);
                } else {
                    component.quaternion.copy(scratchTargetQuat);
                }
                component.updateMatrixWorld?.(true);
                this.render();
                if (commit && this.partHistory && typeof this.partHistory.syncAssemblyComponentTransforms === 'function') {
                    this.partHistory.syncAssemblyComponentTransforms();
                }
            } catch (err) {
                console.warn('[Viewer] Failed to apply transform to component:', err);
            }
        };

        const changeHandler = () => { updateComponentTransform(false); };
        const dragHandler = (ev) => {
            const dragging = !!(ev && ev.value);
            try { if (this.controls) this.controls.enabled = !dragging; } catch { }
            if (!dragging) updateComponentTransform(true);
        };
        const objectChangeHandler = () => {
            if (!controls || controls.dragging) return;
            updateComponentTransform(true);
        };

        controls.addEventListener('change', changeHandler);
        controls.addEventListener('dragging-changed', dragHandler);
        try { controls.addEventListener('objectChange', objectChangeHandler); } catch { }

        const isOver = (ev) => {
            try {
                if (!ev) return false;
                const ndc = this._getPointerNDC(ev);
                this.raycaster.setFromCamera(ndc, this.camera);
                const mode = (typeof controls.getMode === 'function') ? controls.getMode() : (controls.mode || 'translate');
                const giz = controls._gizmo || controls.gizmo || null;
                const pickRoot = (giz && giz.picker) ? (giz.picker[mode] || giz.picker.translate || giz.picker.rotate || giz.picker.scale) : giz;
                const root = pickRoot || giz || helper || controls;
                if (!root) return false;
                const hits = this.raycaster.intersectObject(root, true) || [];
                return hits.length > 0;
            } catch { return false; }
        };

        const updateForCamera = () => {
            try {
                if (typeof controls.update === 'function') controls.update();
                else controls.updateMatrixWorld(true);
            } catch { }
        };

        const globalState = {
            controls,
            viewer: this,
            target,
            isOver,
            updateForCamera,
        };
        try { window.__BREP_activeXform = globalState; } catch { }

        const sessionMode = (typeof controls.getMode === 'function') ? controls.getMode() : (controls.mode || initialMode);

        this._componentTransformSession = {
            component,
            controls,
            helper,
            target,
            changeHandler,
            dragHandler,
            objectChangeHandler,
            globalState,
            mode: sessionMode,
        };

        updateComponentTransform(false);
        this.render();
    }

    _onDoubleClick(event) {
        if (this._disposed) return;
        try { event?.preventDefault?.(); } catch { }
        try {
            const ax = window.__BREP_activeXform;
            if (ax && typeof ax.isOver === 'function' && ax.isOver(event)) return;
        } catch { }

        const pick = this._pickAtEvent(event);
        const component = pick && pick.target ? this._findOwningComponent(pick.target) : null;

        if (!component) {
            this._stopComponentTransformSession();
            return;
        }

        if (component.fixed) {
            try {
                if (typeof this._toast === 'function') this._toast('Component is fixed and cannot be moved.');
            } catch { }
            return;
        }

        const session = this._componentTransformSession;
        if (session && session.component === component) {
            const controls = session.controls;
            const currentMode = (typeof controls?.getMode === 'function') ? controls.getMode() : (controls?.mode || session.mode || 'translate');
            if (currentMode === 'translate') {
                const nextMode = 'rotate';
                try { controls?.setMode(nextMode); } catch { if (controls) controls.mode = nextMode; }
                session.mode = nextMode;
                try { session.globalState?.updateForCamera?.(); } catch { }
                try { this.render(); } catch { }
                return;
            }
            if (currentMode === 'rotate') {
                this._stopComponentTransformSession();
                return;
            }
            this._stopComponentTransformSession();
            return;
        }

        this._activateComponentTransform(component);
    }

    // ————————————————————————————————————————
    // Diagnostics (one‑shot picker)
    // ————————————————————————————————————————
    enableDiagnosticPick() {
        this._diagPickOnce = true;
        // Do not modify the SelectionFilter; inspect will honor the current filter.
        try { this._toast('Click an item to inspect'); } catch { }
    }

    // ————————————————————————————————————————
    // Inspector panel (toggle + update-on-click)
    // ————————————————————————————————————————
    toggleInspectorPanel() { this._inspectorOpen ? this._closeInspectorPanel() : this._openInspectorPanel(); }
    _openInspectorPanel() {
        if (this._inspectorOpen) return;
        this._ensureInspectorPanel();
        this._inspectorEl.style.display = 'flex';
        this._inspectorOpen = true;
        // Placeholder message until user clicks an object
        try {
            this._setInspectorPlaceholder('Click an object in the scene to inspect.');
        } catch { }
    }
    _closeInspectorPanel() {
        if (!this._inspectorOpen) return;
        this._inspectorOpen = false;
        try { this._inspectorEl.style.display = 'none'; } catch { }
    }
    _ensureInspectorPanel() {
        if (this._inspectorEl) return;
        // Create a floating window anchored bottom-left, resizable and draggable
        const height = Math.max(260, Math.floor((window?.innerHeight || 800) * 0.7));
        const fw = new FloatingWindow({ title: 'Inspector', width: 520, height, x: 12, bottom: 12, shaded: false });
        // Header actions
        const btnDownload = document.createElement('button');
        btnDownload.className = 'fw-btn';
        btnDownload.textContent = 'Download JSON';
        btnDownload.addEventListener('click', () => {
            try {
                const json = this._lastInspectorDownload ? this._lastInspectorDownload() : (this._lastInspectorJSON || '{}');
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = 'diagnostics.json'; document.body.appendChild(a); a.click();
                setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
            } catch { }
        });
        const btnClose = document.createElement('button');
        btnClose.className = 'fw-btn';
        btnClose.textContent = 'Hide';
        btnClose.addEventListener('click', () => this._closeInspectorPanel());
        fw.addHeaderAction(btnDownload);
        fw.addHeaderAction(btnClose);

        // Wire content area
        const content = document.createElement('div');
        content.style.display = 'block';
        content.style.width = '100%';
        content.style.height = '100%';
        fw.content.appendChild(content);

        this._inspectorFW = fw;
        this._inspectorEl = fw.root;
        this._inspectorContent = content;
        this._lastInspectorDownload = null;
        this._lastInspectorJSON = '{}';
    }
    _setInspectorPlaceholder(msg) {
        if (!this._inspectorContent) return;
        this._inspectorContent.innerHTML = '';
        const p = document.createElement('div');
        p.textContent = msg || '';
        p.style.color = '#9aa4b2';
        p.style.font = '12px system-ui';
        p.style.opacity = '0.9';
        this._inspectorContent.appendChild(p);
        this._lastInspectorDownload = null;
        this._lastInspectorJSON = '{}';
    }
    _updateInspectorFor(target) {
        this._ensureInspectorPanel();
        if (!target) { this._setInspectorPlaceholder('Nothing selected.'); return; }
        try {
            const { out, downloadFactory } = this._buildDiagnostics(target);
            this._inspectorContent.innerHTML = '';
            // Attach object UI tree
            const ui = generateObjectUI(out, { title: 'Object Inspector', showTypes: true, collapsed: false });
            this._inspectorContent.appendChild(ui);
            // Persist download factory and raw JSON for header button
            this._lastInspectorDownload = downloadFactory;
            this._lastInspectorJSON = JSON.stringify(out, null, 2);
        } catch (e) {
            console.warn(e);
            this._setInspectorPlaceholder('Inspector failed. See console.');
        }
    }

    _round(n) { return Math.abs(n) < 1e-12 ? 0 : Number(n.toFixed(6)); }

    _edgePointsWorld(edge) {
        const pts = [];
        const v = new THREE.Vector3();
        const local = edge?.userData?.polylineLocal;
        const isWorld = !!(edge?.userData?.polylineWorld);
        if (Array.isArray(local) && local.length >= 2) {
            if (isWorld) {
                for (const p of local) pts.push([this._round(p[0]), this._round(p[1]), this._round(p[2])]);
            } else {
                for (const p of local) { v.set(p[0], p[1], p[2]).applyMatrix4(edge.matrixWorld); pts.push([this._round(v.x), this._round(v.y), this._round(v.z)]); }
            }
        } else {
            const pos = edge?.geometry?.getAttribute?.('position');
            if (pos && pos.itemSize === 3) {
                for (let i = 0; i < pos.count; i++) { v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(edge.matrixWorld); pts.push([this._round(v.x), this._round(v.y), this._round(v.z)]); }
            }
        }
        return pts;
    }

    _buildDiagnostics(target) {
        const out = { type: target?.type || String(target?.constructor?.name || 'Object'), name: target?.name || null };
        let downloadFactory = null; // optional closure that returns full JSON text for download

        // Add owning feature information if available
        try {
            if (target.owningFeatureID) {
                out.owningFeatureID = target.owningFeatureID;
                out._owningFeatureFormatted = `Created by: ${target.owningFeatureID}`;
            }
        } catch { }

        if (target.type === 'FACE') {
            // Triangles via Solid API to ensure correct grouping
            let solid = target.parent; while (solid && solid.type !== 'SOLID') solid = solid.parent;
            const faceName = target.userData?.faceName || target.name;
            try {
                if (solid && typeof solid.getFace === 'function' && faceName) {
                    const tris = solid.getFace(faceName) || [];
                    const mapTri = (t) => ({
                        indices: Array.isArray(t.indices) ? t.indices : undefined,
                        p1: t.p1.map(this._round), p2: t.p2.map(this._round), p3: t.p3.map(this._round),
                        normal: (() => { const a = t.p1, b = t.p2, c = t.p3; const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]; const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]; const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const len = Math.hypot(nx, ny, nz) || 1; return [this._round(nx / len), this._round(ny / len), this._round(nz / len)]; })(),
                        area: (() => { const a = t.p1, b = t.p2, c = t.p3; const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]; const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]; const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx; return this._round(0.5 * Math.hypot(cx, cy, cz)); })()
                    });
                    const triFull = tris.map(mapTri);
                    try {
                        let triMax = 5000; // preview cap
                        if (typeof window !== 'undefined' && Number.isFinite(window.BREP_DIAG_TRI_MAX_FACE)) triMax = window.BREP_DIAG_TRI_MAX_FACE | 0;
                        if (triMax < 0) triMax = triFull.length;
                        const count = Math.min(triFull.length, triMax);
                        // Make triangles lazy-loaded for performance
                        out._trianglesSummary = `${triFull.length} triangles (click to expand)`;
                        out._lazyTriangles = () => triFull.slice(0, count);
                        if (count < triFull.length) { out.trianglesTruncated = true; out.trianglesTotal = triFull.length; out.trianglesLimit = triMax; }
                    } catch {
                        out._trianglesSummary = `${triFull.length} triangles (click to expand)`;
                        out._lazyTriangles = () => triFull;
                    }
                    // Full JSON factory for download
                    downloadFactory = () => {
                        const full = JSON.parse(JSON.stringify(out));
                        full.triangles = triFull;
                        delete full.trianglesTruncated; delete full.trianglesLimit; delete full.trianglesTotal;
                        return JSON.stringify(full, null, 2);
                    };
                } else {
                    // Fallback: read triangles from the face geometry
                    const pos = target.geometry?.getAttribute?.('position');
                    if (pos) {
                        const v = new THREE.Vector3();
                        const triCount = (pos.count / 3) | 0;
                        const triFull = new Array(triCount);
                        for (let i = 0; i < triCount; i++) {
                            v.set(pos.getX(3 * i + 0), pos.getY(3 * i + 0), pos.getZ(3 * i + 0)).applyMatrix4(target.matrixWorld);
                            const p0 = [this._round(v.x), this._round(v.y), this._round(v.z)];
                            v.set(pos.getX(3 * i + 1), pos.getY(3 * i + 1), pos.getZ(3 * i + 1)).applyMatrix4(target.matrixWorld);
                            const p1 = [this._round(v.x), this._round(v.y), this._round(v.z)];
                            v.set(pos.getX(3 * i + 2), pos.getY(3 * i + 2), pos.getZ(3 * i + 2)).applyMatrix4(target.matrixWorld);
                            const p2 = [this._round(v.x), this._round(v.y), this._round(v.z)];
                            const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
                            const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
                            const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx; const len = Math.hypot(cx, cy, cz) || 1;
                            triFull[i] = { p1: p0, p2: p1, p3: p2, normal: [this._round(cx / len), this._round(cy / len), this._round(cz / len)], area: this._round(0.5 * Math.hypot(cx, cy, cz)) };
                        }
                        try {
                            let triMax = 5000; // preview cap for UI
                            if (typeof window !== 'undefined' && Number.isFinite(window.BREP_DIAG_TRI_MAX_FACE)) triMax = window.BREP_DIAG_TRI_MAX_FACE | 0;
                            if (triMax < 0) triMax = triFull.length;
                            const count = Math.min(triFull.length, triMax);
                            out.triangles = triFull.slice(0, count);
                            if (count < triFull.length) { out.trianglesTruncated = true; out.trianglesTotal = triFull.length; out.trianglesLimit = triMax; }
                        } catch { out.triangles = triFull; }
                        downloadFactory = () => {
                            const full = JSON.parse(JSON.stringify(out));
                            full.triangles = triFull;
                            delete full.trianglesTruncated; delete full.trianglesLimit; delete full.trianglesTotal;
                            return JSON.stringify(full, null, 2);
                        };
                    }
                }
            } catch { }

            // Edges connected to this face
            try {
                const edges = Array.isArray(target.edges) ? target.edges : [];
                out.edges = edges.map(e => ({ name: e.name || null, faces: (Array.isArray(e.faces) ? e.faces.map(f => f?.name || f?.userData?.faceName || null) : []), closedLoop: !!e.closedLoop, length: (typeof e.length === 'function' ? this._round(e.length()) : undefined), points: this._edgePointsWorld(e) }));
            } catch { out.edges = []; }

            // Lazy-load unique vertices to improve performance
            try {
                out._lazyUniqueVertices = () => {
                    const triangles = (out._lazyTriangles && typeof out._lazyTriangles === 'function') ? out._lazyTriangles() : [];
                    const uniq = new Map();
                    for (const tri of triangles) {
                        for (const P of [tri.p1, tri.p2, tri.p3]) {
                            const k = `${P[0]},${P[1]},${P[2]}`;
                            if (!uniq.has(k)) uniq.set(k, P);
                        }
                    }
                    return Array.from(uniq.values());
                };
            } catch { }

            // Basic metrics and orientation hints
            try { const n = target.getAverageNormal?.(); if (n) out.averageNormal = [this._round(n.x), this._round(n.y), this._round(n.z)]; } catch { }
            try {
                const a = target.surfaceArea?.();
                if (Number.isFinite(a)) {
                    out.surfaceArea = this._round(a);
                    // Make face area more prominent for easy reference
                    out._faceAreaFormatted = `${this._round(a)} units²`;
                }
            } catch { }
            try {
                // Bounding box in world coords from triangle points (lazy-loaded)
                out._lazyBbox = () => {
                    const pts = []; for (const tri of out.triangles || []) { pts.push(tri.p1, tri.p2, tri.p3); }
                    if (pts.length) {
                        let min = [+Infinity, +Infinity, +Infinity], max = [-Infinity, -Infinity, -Infinity];
                        for (const p of pts) { if (p[0] < min[0]) min[0] = p[0]; if (p[1] < min[1]) min[1] = p[1]; if (p[2] < min[2]) min[2] = p[2]; if (p[0] > max[0]) max[0] = p[0]; if (p[1] > max[1]) max[1] = p[1]; if (p[2] > max[2]) max[2] = p[2]; }
                        return { min, max };
                    }
                    return null;
                };
            } catch { }

            // Neighbor face names
            try { out.neighbors = Array.from(new Set((out.edges || []).flatMap(e => e.faces || []).filter(Boolean))); } catch { }

            // Boundary loops if available from metadata
            try {
                const loops = target.userData?.boundaryLoopsWorld;
                if (Array.isArray(loops) && loops.length) {
                    out.boundaryLoops = loops.map(l => ({ isHole: !!l.isHole, pts: (Array.isArray(l.pts) ? l.pts : l).map(p => [this._round(p[0]), this._round(p[1]), this._round(p[2])]) }));
                }
            } catch { }
        } else if (target.type === 'EDGE') {
            out.closedLoop = !!target.closedLoop;
            // Lazy-load points to improve performance
            out._lazyPoints = () => this._edgePointsWorld(target);
            try {
                const len = target.length();
                if (Number.isFinite(len)) {
                    out.length = this._round(len);
                    out._edgeLengthFormatted = `${this._round(len)} units`;
                }
            } catch { }
            try { out.faces = (Array.isArray(target.faces) ? target.faces.map(f => f?.name || f?.userData?.faceName || null) : []); } catch { }
        } else if (target.type === 'SOLID') {
            try {
                const faces = target.getFaces?.(false) || [];
                out.faceCount = faces.length;
                out.faces = faces.slice(0, 10).map(f => ({ faceName: f.faceName, triangles: (f.triangles || []).length }));
                if (faces.length > 10) out.facesTruncated = true;
            } catch { }
            // Gather geometry arrays (prefer manifold mesh, fallback to authoring arrays)
            let arrays = null; let usedAuthoring = false;
            try {
                const mesh = target.getMesh?.();
                if (mesh && mesh.vertProperties && mesh.triVerts) {
                    arrays = { vp: Array.from(mesh.vertProperties), tv: Array.from(mesh.triVerts), ids: Array.isArray(mesh.faceID) ? Array.from(mesh.faceID) : [] };
                }
            } catch { }
            if (!arrays) {
                try {
                    const vp = Array.isArray(target._vertProperties) ? target._vertProperties.slice() : [];
                    const tv = Array.isArray(target._triVerts) ? target._triVerts.slice() : [];
                    const ids = Array.isArray(target._triIDs) ? target._triIDs.slice() : [];
                    arrays = { vp, tv, ids }; usedAuthoring = true;
                } catch { }
            }

            if (arrays) {
                const { vp, tv, ids } = arrays;
                out.meshStats = { vertices: (vp.length / 3) | 0, triangles: (tv.length / 3) | 0, source: usedAuthoring ? 'authoring' : 'manifold' };
                // BBox
                let min = [+Infinity, +Infinity, +Infinity], max = [-Infinity, -Infinity, -Infinity];
                for (let i = 0; i < vp.length; i += 3) { const x = this._round(vp[i]), y = this._round(vp[i + 1]), z = this._round(vp[i + 2]); if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z; if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z; }
                if (min[0] !== Infinity) out.bbox = { min, max };

                // Triangles with points (cap output size in preview; full list available via Download)
                try {
                    const triCount = (tv.length / 3) | 0;
                    let triMax = 5000; // sane default for UI
                    try { if (typeof window !== 'undefined' && Number.isFinite(window.BREP_DIAG_TRI_MAX)) triMax = window.BREP_DIAG_TRI_MAX | 0; } catch { }
                    if (triMax < 0) triMax = triCount; // -1 => no cap
                    const count = Math.min(triCount, triMax);
                    const tris = new Array(count);
                    const nameOf = (id) => (target._idToFaceName && target._idToFaceName.get) ? target._idToFaceName.get(id) : undefined;
                    for (let t = 0; t < count; t++) {
                        const i0 = tv[3 * t + 0] >>> 0, i1 = tv[3 * t + 1] >>> 0, i2 = tv[3 * t + 2] >>> 0;
                        const p0 = [this._round(vp[3 * i0 + 0]), this._round(vp[3 * i0 + 1]), this._round(vp[3 * i0 + 2])];
                        const p1 = [this._round(vp[3 * i1 + 0]), this._round(vp[3 * i1 + 1]), this._round(vp[3 * i1 + 2])];
                        const p2 = [this._round(vp[3 * i2 + 0]), this._round(vp[3 * i2 + 1]), this._round(vp[3 * i2 + 2])];
                        let faceID = (Array.isArray(ids) && ids.length === triCount) ? ids[t] : undefined;
                        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
                        const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
                        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const nlen = Math.hypot(nx, ny, nz) || 1;
                        tris[t] = {
                            index: t,
                            faceID: faceID,
                            faceName: faceID !== undefined ? (nameOf(faceID) || null) : null,
                            p1: p0, p2: p1, p3: p2,
                            normal: [this._round(nx / nlen), this._round(ny / nlen), this._round(nz / nlen)],
                            area: this._round(0.5 * nlen)
                        };
                    }
                    // Make triangles lazy-loaded for performance
                    out._trianglesSummary = `${triCount} triangles (click to expand)`;
                    out._lazyTriangles = () => tris;
                    if (count < triCount) { out.trianglesTruncated = true; out.trianglesTotal = triCount; out.trianglesLimit = triMax; }
                    // Build full JSON on demand
                    downloadFactory = () => {
                        const trisFull = new Array(triCount);
                        const nameOf = (id) => (target._idToFaceName && target._idToFaceName.get) ? target._idToFaceName.get(id) : undefined;
                        for (let t = 0; t < triCount; t++) {
                            const i0 = tv[3 * t + 0] >>> 0, i1 = tv[3 * t + 1] >>> 0, i2 = tv[3 * t + 2] >>> 0;
                            const p0 = [this._round(vp[3 * i0 + 0]), this._round(vp[3 * i0 + 1]), this._round(vp[3 * i0 + 2])];
                            const p1 = [this._round(vp[3 * i1 + 0]), this._round(vp[3 * i1 + 1]), this._round(vp[3 * i1 + 2])];
                            const p2 = [this._round(vp[3 * i2 + 0]), this._round(vp[3 * i2 + 1]), this._round(vp[3 * i2 + 2])];
                            let faceID = (Array.isArray(ids) && ids.length === triCount) ? ids[t] : undefined;
                            const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
                            const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
                            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const nlen = Math.hypot(nx, ny, nz) || 1;
                            trisFull[t] = {
                                index: t,
                                faceID: faceID,
                                faceName: faceID !== undefined ? (nameOf(faceID) || null) : null,
                                p1: p0, p2: p1, p3: p2,
                                normal: [this._round(nx / nlen), this._round(ny / nlen), this._round(nz / nlen)],
                                area: this._round(0.5 * nlen)
                            };
                        }
                        const full = JSON.parse(JSON.stringify(out));
                        full.triangles = trisFull; delete full.trianglesTruncated; delete full.trianglesLimit; delete full.trianglesTotal;
                        return JSON.stringify(full, null, 2);
                    };
                } catch { }

                // Non-manifold / topology diagnostics (undirected edge uses)
                try {
                    const nv = (vp.length / 3) | 0; const NV = BigInt(Math.max(1, nv));
                    const eKey = (a, b) => { const A = BigInt(a), B = BigInt(b); return A < B ? A * NV + B : B * NV + A; };
                    const e2c = new Map();
                    const triCount = (tv.length / 3) | 0;
                    const degenerate = []; const used = new Uint8Array(nv);
                    for (let t = 0; t < triCount; t++) {
                        const i0 = tv[3 * t + 0] >>> 0, i1 = tv[3 * t + 1] >>> 0, i2 = tv[3 * t + 2] >>> 0;
                        used[i0] = 1; used[i1] = 1; used[i2] = 1;
                        const ax = vp[3 * i0 + 0], ay = vp[3 * i0 + 1], az = vp[3 * i0 + 2];
                        const bx = vp[3 * i1 + 0], by = vp[3 * i1 + 1], bz = vp[3 * i1 + 2];
                        const cx = vp[3 * i2 + 0], cy = vp[3 * i2 + 1], cz = vp[3 * i2 + 2];
                        const ux = bx - ax, uy = by - ay, uz = bz - az; const vx = cx - ax, vy = cy - ay, vz = cz - az;
                        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const area2 = nx * nx + ny * ny + nz * nz;
                        if (area2 <= 1e-30) degenerate.push(t);
                        const add = (a, b) => { const k = eKey(Math.min(a, b), Math.max(a, b)); e2c.set(k, (e2c.get(k) || 0) + 1); };
                        add(i0, i1); add(i1, i2); add(i2, i0);
                    }
                    let gt2 = 0, lt2 = 0, eq1 = 0; const exGT = [], exLT = [], exB = [];
                    for (const [k, c] of e2c.entries()) {
                        if (c > 2) { gt2++; if (exGT.length < 12) exGT.push({ edge: k.toString(), uses: c }); }
                        else if (c < 2) { lt2++; if (c === 1) { eq1++; if (exB.length < 12) exB.push({ edge: k.toString(), uses: c }); } else { if (exLT.length < 12) exLT.push({ edge: k.toString(), uses: c }); } }
                    }
                    let isolated = 0; for (let i = 0; i < nv; i++) if (!used[i]) isolated++;
                    const isClosed = (eq1 === 0);
                    const hasNonManifoldEdges = (gt2 > 0);
                    const isManifold = isClosed && !hasNonManifoldEdges;
                    out.topology = {
                        isManifold,
                        closed: isClosed,
                        nonManifoldEdges: hasNonManifoldEdges ? gt2 : 0,
                        degenerateTriangles: { count: degenerate.length, examples: degenerate.slice(0, 12) },
                        edges: { gt2, lt2, boundary: eq1, examples_gt2: exGT, examples_lt2: exLT, examples_boundary: exB },
                        isolatedVertices: isolated
                    };
                    // Expose quick boolean at root for easy scanning
                    out.isManifold = isManifold;
                } catch { }

                // Faces fallback from authoring arrays when manifold faces unavailable
                if (!out.faceCount || !Array.isArray(out.faces)) {
                    try {
                        const nameOf = (id) => (target._idToFaceName && target._idToFaceName.get) ? target._idToFaceName.get(id) : String(id);
                        const nameToTris = new Map();
                        const triCount = (tv.length / 3) | 0;
                        for (let t = 0; t < triCount; t++) {
                            const id = Array.isArray(ids) ? ids[t] : undefined;
                            const name = nameOf(id);
                            if (!name) continue;
                            let arr = nameToTris.get(name); if (!arr) { arr = []; nameToTris.set(name, arr); }
                            arr.push(t);
                        }
                        const facesRaw = [];
                        for (const [faceName, trisIdx] of nameToTris.entries()) facesRaw.push({ faceName, triangles: trisIdx.length });
                        facesRaw.sort((a, b) => b.triangles - a.triangles);
                        out.faceCount = facesRaw.length;
                        out.faces = facesRaw.slice(0, 20);
                        if (facesRaw.length > 20) out.facesTruncated = true;
                    } catch { }
                }
            }

            try { const vol = target.volume?.(); if (Number.isFinite(vol)) out.volume = this._round(vol); } catch { }
            try { const area = target.surfaceArea?.(); if (Number.isFinite(area)) out.surfaceArea = this._round(area); } catch { }
        }

        return { out, downloadFactory: downloadFactory || (() => JSON.stringify(out, null, 2)) };
    }

    _showDiagnosticsFor(target) {
        const { out, downloadFactory } = this._buildDiagnostics(target);
        const json = JSON.stringify(out, null, 2);
        this._showModal('Selection Diagnostics', json, { onDownload: downloadFactory });
    }

    _toast(msg, ms = 1200) {
        try {
            const el = document.createElement('div');
            el.textContent = msg;
            el.style.cssText = 'position:fixed;top:48px;left:50%;transform:translateX(-50%);background:#111c;backdrop-filter:blur(6px);color:#e5e7eb;padding:6px 10px;border:1px solid #2a3442;border-radius:8px;z-index:7;font:12px/1.2 system-ui;';
            document.body.appendChild(el);
            setTimeout(() => { try { el.parentNode && el.parentNode.removeChild(el); } catch { } }, ms);
        } catch { }
    }

    _showModal(title, text, opts = {}) {
        const mask = document.createElement('div');
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(2px);z-index:7;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'width:min(980px,90vw);height:min(70vh,720px);background:#0b0d10;border:1px solid #2a3442;border-radius:10px;box-shadow:0 12px 28px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #1e2430;color:#e5e7eb;font:600 13px system-ui;';
        header.textContent = title || 'Diagnostics';
        const close = document.createElement('button');
        close.textContent = '✕';
        close.title = 'Close';
        close.style.cssText = 'margin-left:auto;background:transparent;border:0;color:#9aa4b2;cursor:pointer;font:700 14px system-ui;padding:4px;';
        const pre = document.createElement('textarea');
        pre.readOnly = true;
        pre.value = text || '';
        pre.style.cssText = 'flex:1;resize:none;background:#0f141a;color:#e5e7eb;border:0;padding:10px 12px;font:12px/1.3 ui-monospace,Menlo,Consolas,monospace;white-space:pre;';
        const foot = document.createElement('div');
        foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:8px 12px;border-top:1px solid #1e2430;';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'mtb-btn';
        copyBtn.textContent = 'Copy JSON';
        copyBtn.style.cssText = 'background:#1b2433;border:1px solid #334155;color:#e5e7eb;padding:6px 10px;border-radius:8px;cursor:pointer;font-weight:700;font-size:12px;';
        copyBtn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(pre.value); copyBtn.textContent = 'Copied!'; setTimeout(() => copyBtn.textContent = 'Copy JSON', 900); } catch { } });
        const dlBtn = document.createElement('button');
        dlBtn.className = 'mtb-btn';
        dlBtn.textContent = 'Download';
        dlBtn.style.cssText = copyBtn.style.cssText;
        dlBtn.addEventListener('click', () => {
            try {
                const content = (opts && typeof opts.onDownload === 'function') ? opts.onDownload() : pre.value;
                const blob = new Blob([content], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = 'diagnostics.json'; document.body.appendChild(a); a.click();
                setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
            } catch { }
        });

        close.addEventListener('click', () => { try { document.body.removeChild(mask); } catch { } });
        mask.addEventListener('click', (e) => { if (e.target === mask) { try { document.body.removeChild(mask); } catch { } } });

        header.appendChild(close);
        box.appendChild(header);
        box.appendChild(pre);
        foot.appendChild(copyBtn);
        foot.appendChild(dlBtn);
        box.appendChild(foot);
        mask.appendChild(box);
        document.body.appendChild(mask);
    }

    // ————————————————————————————————————————
    // Internal: Resize & Camera Frustum
    // ————————————————————————————————————————
    _getContainerSize() {
        // Prefer clientWidth/Height so we get the laid-out CSS size.
        // Fallback to window size if the container hasn't been laid out yet.
        const w = this.container.clientWidth || window.innerWidth || 1;
        const h = this.container.clientHeight || window.innerHeight || 1;
        return { width: Math.max(1, w), height: Math.max(1, h) };
    }

    // REPLACE: _resizeRendererToDisplaySize()
    _resizeRendererToDisplaySize() {
        const { width, height } = this._getContainerSize();

        // Keep DPR current (handles moving across monitors)
        const dpr = window.devicePixelRatio || 1;
        const targetPR = Math.max(1, Math.min(this.pixelRatio || dpr, dpr));
        if (this.renderer.getPixelRatio() !== targetPR) {
            this.renderer.setPixelRatio(targetPR);
        }

        // Ensure canvas CSS size matches container (use updateStyle=true)
        const canvas = this.renderer.domElement;
        const needResize =
            canvas.width !== Math.floor(width * targetPR) ||
            canvas.height !== Math.floor(height * targetPR);

        if (needResize) {
            this.renderer.setSize(width, height, true);
        }

        // Keep fat-line materials in sync with canvas resolution
        try {
            const setRes = (mat) => mat && mat.resolution && typeof mat.resolution.set === 'function' && mat.resolution.set(width, height);
            if (CADmaterials?.EDGE) {
                setRes(CADmaterials.EDGE.BASE);
                setRes(CADmaterials.EDGE.SELECTED);
                if (CADmaterials.EDGE.OVERLAY) setRes(CADmaterials.EDGE.OVERLAY);
            }
            if (CADmaterials?.LOOP) {
                setRes(CADmaterials.LOOP.BASE);
                setRes(CADmaterials.LOOP.SELECTED);
            }
        } catch { }

        // Update orthographic frustum for new aspect
        const aspect = width / height || 1;
        if (this.camera.isOrthographicCamera) {
            const spanYRaw = Number.isFinite(this.camera.top) && Number.isFinite(this.camera.bottom)
                ? this.camera.top - this.camera.bottom
                : (this.viewSize * 2);
            const spanY = Math.abs(spanYRaw) > 1e-6 ? spanYRaw : (this.viewSize * 2);
            const centerY = (Number.isFinite(this.camera.top) && Number.isFinite(this.camera.bottom))
                ? (this.camera.top + this.camera.bottom) * 0.5
                : 0;
            const centerX = (Number.isFinite(this.camera.left) && Number.isFinite(this.camera.right))
                ? (this.camera.left + this.camera.right) * 0.5
                : 0;
            const halfHeight = Math.abs(spanY) * 0.5;
            const halfWidth = halfHeight * aspect;
            const signY = spanY >= 0 ? 1 : -1;
            this.camera.top = centerY + halfHeight * signY;
            this.camera.bottom = centerY - halfHeight * signY;
            this.camera.left = centerX - halfWidth;
            this.camera.right = centerX + halfWidth;
        } else {
            const v = this.viewSize;
            this.camera.left = -v * aspect;
            this.camera.right = v * aspect;
            this.camera.top = v;
            this.camera.bottom = -v;
        }
        this.camera.updateProjectionMatrix();

        // Optional: let controls know something changed
        if (this.controls && typeof this.controls.update === 'function') {
            this.controls.update();
        }
    }

    // REPLACE: _onResize()
    _onResize() {
        // Coalesce rapid resize events to one rAF
        if (this._resizeScheduled) return;
        this._resizeScheduled = true;
        requestAnimationFrame(() => {
            this._resizeScheduled = false;
            this._resizeRendererToDisplaySize();
            this.render();
            // Keep overlayed labels/leaders in sync with new viewport
            try { this._sketchMode?.onCameraChanged?.(); } catch { }
        });
    }

    // Re-evaluate hover while the camera animates/moves (e.g., orbiting)
    _onControlsChange() {
        if (this._disposed) return;
        // Re-evaluate hover while camera moves (if we have a last pointer)
        if (this._lastPointerEvent) this._updateHover(this._lastPointerEvent);
        // While orbiting/panning/zooming, reposition dimension labels/leaders
        try { this._sketchMode?.onCameraChanged?.(); } catch { }
    }

    // Compute world-units per screen pixel for current camera and viewport
    _worldPerPixel(camera, width, height) {
        if (camera && camera.isOrthographicCamera) {
            const zoom = (typeof camera.zoom === 'number' && camera.zoom > 0) ? camera.zoom : 1;
            const wppX = (camera.right - camera.left) / (width * zoom);
            const wppY = (camera.top - camera.bottom) / (height * zoom);
            return Math.max(wppX, wppY);
        }
        const dist = camera.position.length();
        const fovRad = (camera.fov * Math.PI) / 180;
        return (2 * Math.tan(fovRad / 2) * dist) / height;
    }
}
