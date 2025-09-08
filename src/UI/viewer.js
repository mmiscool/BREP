// ES6 module
// Requires three and ArcballControls from three/examples:
//   import * as THREE from 'three';
//   import { ArcballControls } from 'three/examples/jsm/controls/ArcballControls.js';

import * as THREE from 'three';
import { ArcballControls } from 'three/examples/jsm/controls/ArcballControls.js';
import { SceneListing } from './SceneListing.js';
import { CADmaterials, CADmaterialWidget } from './CADmaterials.js';
import { AccordionWidget } from './AccordionWidget.js';
import { OrthoCameraIdle } from './OrthoCameraIdle.js';
import { HistoryWidget } from './HistoryWidget.js';
import { PartHistory } from '../PartHistory.js';
import { SelectionFilter } from './SelectionFilter.js';
import './expressionsManager.js'
import { expressionsManager } from './expressionsManager.js';
import { SelectionFilterWidget } from './selectionFilterWidget.js';
import { FileManagerWidget } from './fileManagerWidget.js';
import './mobile.js';
import { SketchMode3D } from './SketchMode3D.js';

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
                        try { g.computeBoundingSphere(); } catch(_) { /* noop */ }
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

        // Raycaster for picking
        this.raycaster = new THREE.Raycaster();
        // Slightly generous line threshold for edge picking (world units)
        try { this.raycaster.params.Line.threshold = 0.1; } catch { }

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

        // Events
        const el = this.renderer.domElement;
        el.addEventListener('pointermove', this._onPointerMove, { passive: true });
        el.addEventListener('pointerleave', () => {
            try { SelectionFilter.clearHover(); } catch (_) {}
            // When pointer leaves the canvas, forget the last pointer event
            this._lastPointerEvent = null;
        }, { passive: true });
        el.addEventListener('pointerenter', (ev) => { this._lastPointerEvent = ev; }, { passive: true });
        el.addEventListener('pointerdown', this._onPointerDown, { passive: false });
        // Use capture on pointerup to ensure we end interactions even if pointerup fires off-element
        window.addEventListener('pointerup', this._onPointerUp, { passive: false, capture: true });
        el.addEventListener('contextmenu', this._onContextMenu);
        window.addEventListener('resize', this._onResize);
        // Keep camera updates; no picking to sync
        this.controls.addEventListener('change', this._onControlsChange);

        this.SelectionFilter = SelectionFilter;

        // Initial sizing + start
        this._resizeRendererToDisplaySize();
        this._loop();
        this.setupAccordion();
    }


    async setupAccordion() {
        // Setup accordion
        this.accordion = await new AccordionWidget();
        await this.sidebar.appendChild(this.accordion.uiElement);






        const fm = new FileManagerWidget(this);
        const fmSection = await this.accordion.addSection('File Manager');
        fmSection.uiElement.appendChild(fm.uiElement);

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

        // setup expressions
        this.expressionsManager = await new expressionsManager(this);
        const expressionsSection = await this.accordion.addSection("Expressions");
        await expressionsSection.uiElement.appendChild(await this.expressionsManager.uiElement);

        // Setup sceneManagerUi
        this.sceneManagerUi = await new SceneListing(this.scene);
        const sceneSection = await this.accordion.addSection("Scene Manager");
        await sceneSection.uiElement.appendChild(this.sceneManagerUi.uiElement);



        // CADmaterials
        this.cadMaterialsUi = await new CADmaterialWidget();
        const displaySection = await this.accordion.addSection("Display Settings");
        await displaySection.uiElement.appendChild(this.cadMaterialsUi.uiElement);

        await this.accordion.collapseAll();
        await this.accordion.expandSection("Scene Manager");

        await this.accordion.expandSection("History");



        this.selectionFilterWidget = new SelectionFilterWidget(this);
    }

    // ————————————————————————————————————————
    // Public API
    // ————————————————————————————————————————
    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        cancelAnimationFrame(this._raf);
        const el = this.renderer.domElement;
        el.removeEventListener('pointermove', this._onPointerMove);
        el.removeEventListener('pointerdown', this._onPointerDown);
        window.removeEventListener('pointerup', this._onPointerUp, { capture: true });
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
                try { this.sidebar.style.removeProperty('display'); } catch {}
                this.sidebar.style.display = this.sidebar.style.display || '';
                this.sidebar.style.visibility = 'visible';
                this.sidebar.style.opacity = .9;
                // Ensure sidebar is drawn above everything else again
                this.sidebar.style.zIndex = String(2147483646);
            }
        } catch { }
        try { if (this.controls) this.controls.enabled = true; } catch { }

        // Clean up any legacy overlays that might still be mounted (from old 2D mode)
        try {
            const c = this.container;
            if (c && typeof c.querySelectorAll === 'function') {
                const leftovers = c.querySelectorAll('.sketch-overlay');
                leftovers.forEach(el => { try { el.parentNode && el.parentNode.removeChild(el); } catch {} });
            }
        } catch { }
    }

    render() {
        this.renderer.render(this.scene, this.camera);
    }

    // ————————————————————————————————————————
    // Internal: Animation Loop
    // ————————————————————————————————————————
    _loop() {
        this._raf = requestAnimationFrame(this._loop);
        this.controls.update();
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
        if (!event) return { hit: null, target: null };
        const ndc = this._getPointerNDC(event);
        this.raycaster.setFromCamera(ndc, this.camera);
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
        if (target && typeof target.onClick === 'function') {
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
        this._updateHover(event);
    }

    _onPointerDown(event) {
        if (this._disposed) return;
        this._pointerDown = true;
        this._downButton = event.button;
        this._downPos.x = event.clientX;
        this._downPos.y = event.clientY;
        this.controls.enabled = true;
        // Prevent default to avoid unwanted text selection/scroll on drag
        try { event.preventDefault(); } catch { }
    }

    _onPointerUp(event) {
        if (this._disposed) return;
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
            }
            if (CADmaterials?.LOOP) {
                setRes(CADmaterials.LOOP.BASE);
                setRes(CADmaterials.LOOP.SELECTED);
            }
        } catch { }

        // Update orthographic frustum for new aspect
        const aspect = width / height || 1;
        const v = this.viewSize;
        this.camera.left = -v * aspect;
        this.camera.right = v * aspect;
        this.camera.top = v;
        this.camera.bottom = -v;
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
        });
    }

    // Re-evaluate hover while the camera animates/moves (e.g., orbiting)
    _onControlsChange() {
        if (this._disposed) return;
        // Re-evaluate hover while camera moves (if we have a last pointer)
        if (this._lastPointerEvent) this._updateHover(this._lastPointerEvent);
    }
}
