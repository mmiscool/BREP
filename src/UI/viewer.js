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
        this.raycaster = new THREE.Raycaster();
        this._pointerNDC = new THREE.Vector2();

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
                console.log('camera moving...');
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
        this._hovered = null;           // currently hovered interactive object (the "handler owner")
        this._active = null;            // object that received pointerdown (for drag/click)
        this._dragging = false;
        this._pointerDown = false;
        this._downButton = 0;           // 0 left, 2 right
        this._downPos = { x: 0, y: 0 };
        this._dragThreshold = 5;        // pixels
        this._raf = null;
        this._disposed = false;
        this._sketchMode = null;

        // Bindings
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);
        this._onContextMenu = this._onContextMenu.bind(this);
        this._onResize = this._onResize.bind(this);
        this._onControlsChange = this._onControlsChange.bind(this);
        this._loop = this._loop.bind(this);

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
        // Keep hover picking in sync while the camera moves
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
    // Internal: Pointer + Raycasting
    // ————————————————————————————————————————
    _updatePointerNDC(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this._pointerNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this._pointerNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    // For event-aware picking, pass a predicate that determines whether an ancestor "qualifies"
    _intersect(event, qualifiesPredicate = null) {
        this._updatePointerNDC(event);

        // Layers: match what’s rendered
        if (this.camera && this.camera.layers && this.raycaster.layers) {
            this.raycaster.layers.mask = this.camera.layers.mask;
        }

        // Build the picking ray for the current pointer
        this.raycaster.setFromCamera(this._pointerNDC, this.camera);

        // 🔑 Make line picking pixel-tight (≈1px) before intersecting
        // Support grouped CADmaterials (EDGE.BASE) with fallback
        const edgePickPx = (CADmaterials?.EDGE?.BASE?.linewidth ?? CADmaterials?.EDGE?.linewidth ?? 0.6);
        this._setPixelTightLineThreshold(edgePickPx);

        // Intersect everything (recursive); we'll filter below
        const hits = this.raycaster.intersectObjects(this.scene.children, true);
        if (!hits.length) return null;

        // sort hits by distance (nearest first) and then by type. If the distance is the same prefere edges over faces
        hits.sort((a, b) => {
            const distanceDiff = a.distance - b.distance;
            if (distanceDiff !== 0) return distanceDiff;
            // Prefer edges over faces
            const aIsEdge = a.object.isLine2;
            const bIsEdge = b.object.isLine2;
            if (aIsEdge && !bIsEdge) return -1;
            if (!aIsEdge && bIsEdge) return 1;
            return 0;
        });

        const isChainAllowed = (node) => {
            let cur = node;
            while (cur && cur !== this.scene) {
                if (cur.type && SelectionFilter.IsAllowed(cur.type)) return true;
                cur = cur.parent;
            }
            return false;
        };

        for (const hit of hits) {
            const obj = hit.object;
            // Only consider things that are actually visible / renderable
            if (!this._isActuallyVisible(obj)) continue;
            const owner = this._findHandlerOwner(obj, qualifiesPredicate);
            if (!owner) continue;
            // Respect the selection filter: allow if either the owner, the leaf, or any ancestor is allowed
            const allowed = isChainAllowed(owner) || isChainAllowed(obj);
            if (!allowed) continue;
            return { owner, hit };
        }
        return null;
    }

    _setPixelTightLineThreshold(pickPx = .5) {
        // pickPx is the half-width in pixels you consider "on the line".
        // 0.6 ≈ must be visually on the 1px line; raise slightly if selection feels too strict.

        const el = this.renderer.domElement;
        const width = el.clientWidth || el.width || 1;
        const height = el.clientHeight || el.height || 1;

        let worldPerPixel = 1e-6; // fallback tiny value

        if (this.camera && this.camera.isOrthographicCamera) {
            // For ortho, world-per-pixel is constant, derived from the frustum size.
            const wppX = (this.camera.right - this.camera.left) / width;
            const wppY = (this.camera.top - this.camera.bottom) / height;
            worldPerPixel = Math.max(wppX, wppY);
        } else if (this.camera && this.camera.isPerspectiveCamera) {
            // Reasonable approximation for perspective: use target-ish distance.
            // If your controls expose a target or distance, prefer that.
            const dist = this.controls && typeof this.controls.getDistance === 'function'
                ? this.controls.getDistance()
                : this.camera.position.length();

            const fovRad = (this.camera.fov * Math.PI) / 180;
            worldPerPixel = (2 * Math.tan(fovRad / 2) * dist) / height;
        }

        const threshold = Math.max(1e-6, worldPerPixel * pickPx);
        this.raycaster.params.Line = this.raycaster.params.Line || {};
        this.raycaster.params.Line.threshold = threshold;
        // Also set for Line2 raycasting
        this.raycaster.params.Line2 = this.raycaster.params.Line2 || {};
        this.raycaster.params.Line2.threshold = threshold;

        // (Optional) keep points tight as well, if you ever have them:
        // this.raycaster.params.Points = this.raycaster.params.Points || {};
        // this.raycaster.params.Points.threshold = threshold;
    }

    // Helper: true only if the object would be rendered (visibility chain, layers, and material visibility/alpha)
    _isActuallyVisible(object3D) {
        if (!object3D || !object3D.isObject3D) return false;
        if (object3D.visible === false) return false;
        // Visibility must be true for object and all ancestors
        for (let o = object3D; o; o = o.parent) {
            if (o.visible === false) return false;
            // Respect camera/layer visibility like the renderer
            if (this.camera && this.camera.layers && o.layers && !o.layers.test(this.camera.layers)) return false;
        }

        // If it’s a Mesh (or Line/Points with material), ensure at least one visible, non-fully-transparent material
        const materials = this._getMaterialList(object3D);
        if (materials.length) {
            let anyRenderable = false;
            for (const m of materials) {
                if (!m) continue;
                // material.visible=false should hide it; fully transparent shouldn’t catch clicks
                const visible = m.visible !== false;
                const alphaVisible = !(m.transparent === true && (m.opacity ?? 1) <= 0);
                if (visible && alphaVisible) {
                    anyRenderable = true;
                    break;
                }
            }
            if (!anyRenderable) return false;
        }

        return true;
    }

    // Normalize material(s) into an array for Mesh/Line/Points; empty array for objects without CADmaterials
    _getMaterialList(obj) {
        // Only Mesh/Line/Points (and their instanced variants) carry CADmaterials
        const isMaterialCarrier =
            obj && (
                obj.isMesh ||
                obj.isLine || obj.isLineSegments || obj.isLineLoop ||
                obj.isPoints ||
                obj.isInstancedMesh
            );

        if (!isMaterialCarrier) return [];

        const { material } = obj;
        if (Array.isArray(material)) return material;
        return material ? [material] : [];
    }

    _findHandlerOwner(obj, qualifiesPredicate = null) {
        // Accept either camelCase (onClick) or lowercase (onclick) etc.
        const anyHandler = (o) => {
            if (!o) return false;
            return !!(
                typeof this._getHandler(o, 'onClick') === 'function' ||
                typeof this._getHandler(o, 'onRightClick') === 'function' ||
                typeof this._getHandler(o, 'onDragStart') === 'function' ||
                typeof this._getHandler(o, 'onDragEnd') === 'function' ||
                typeof this._getHandler(o, 'onPointerEnter') === 'function' ||
                typeof this._getHandler(o, 'onPointerExit') === 'function' ||
                typeof this._getHandler(o, 'onPointerMove') === 'function'
            );
        };

        let cur = obj;
        while (cur && cur !== this.scene) {
            const qualifies = typeof qualifiesPredicate === 'function'
                ? !!qualifiesPredicate(cur)
                : anyHandler(cur);
            if (qualifies) return cur;
            cur = cur.parent;
        }
        return null;
    }

    _getHandler(obj, camelKey) {
        // Supports both `onClick` and `onclick` (and similar)
        const lowerKey = camelKey.toLowerCase();
        return obj[camelKey] || obj[lowerKey] || null;
    }

    _eventPayload(originalEvent, hit = null) {
        // payload passed into user callbacks
        return {
            type: originalEvent.type,
            originalEvent,
            environment: this,
            camera: this.camera,
            controls: this.controls,
            raycaster: this.raycaster,
            // Intersection details (if any)
            intersection: hit ? hit.hit : null,
            point: hit && hit.hit ? hit.hit.point : null,
            face: hit && hit.hit ? hit.hit.face : null,
            uv: hit && hit.hit ? hit.hit.uv : null,
            normal: hit && hit.hit && hit.hit.face ? hit.hit.face.normal : null,
        };
    }

    // Check if an object has a handler relevant for the current mouse button
    _qualifiesForButton(obj, event) {
        if (!obj) return false;
        const btn = event.button;
        if (btn === 0) {
            // Left: interactive if it can either click or drag
            return (
                typeof this._getHandler(obj, 'onClick') === 'function' ||
                typeof this._getHandler(obj, 'onDragStart') === 'function'
            );
        } else if (btn === 2) {
            // Right: needs an onRightClick
            return typeof this._getHandler(obj, 'onRightClick') === 'function';
        }
        return false; // middle or other buttons never block controls
    }

    // ————————————————————————————————————————
    // Internal: Event Handlers
    // ————————————————————————————————————————
    _onPointerMove(event) {
        if (this._disposed) return;

        // Remember the last known pointer event so we can recompute hover while the camera moves
        this._lastPointerEvent = event;

        // Hover highlighting (respect selection filter)
        try {
            // Update hover when not dragging an interactive object. While navigating the camera
            // (pointer down with no active object), still update hover so results track the view.
            const navigatingCamera = this._pointerDown && !this._active;
            if (!this._dragging && (!this._pointerDown || navigatingCamera)) {
                const hit = this._intersect(event, (o) => typeof this._getHandler(o, 'onClick') === 'function');
                if (hit && hit.hit) {
                    const leaf = hit.hit.object;
                    const owner = hit.owner;
                    const ownerAllowed = owner && owner.type ? SelectionFilter.IsAllowed(owner.type) : false;
                    const leafAllowed = leaf && leaf.type ? SelectionFilter.IsAllowed(leaf.type) : false;
                    // Find nearest allowed ancestor if needed (e.g., SOLID when hovering FACE)
                    const findAllowedAncestor = (node) => {
                        let cur = node;
                        while (cur && cur !== this.scene) {
                            if (cur.type && SelectionFilter.IsAllowed(cur.type)) return cur;
                            cur = cur.parent;
                        }
                        return null;
                    };
                    let target = null;
                    if (leafAllowed) target = leaf;
                    else if (ownerAllowed) target = owner;
                    else target = findAllowedAncestor(owner) || findAllowedAncestor(leaf);

                    if (target) SelectionFilter.setHoverObject(target);
                    else SelectionFilter.setHoverObject(null);
                } else {
                    SelectionFilter.setHoverObject(null);
                }
            }
        } catch (_) { }

        // If a drag should begin, start it only after threshold and only if the active object supports dragging.
        if (this._pointerDown && this._active && !this._dragging) {
            const dx = event.clientX - this._downPos.x;
            const dy = event.clientY - this._downPos.y;
            if (Math.hypot(dx, dy) > this._dragThreshold) {
                const fnDragStart = this._getHandler(this._active, 'onDragStart');
                if (typeof fnDragStart === 'function') {
                    this._dragging = true;
                    // Disable camera controls *only once* we truly entered an object drag.
                    this.controls.enabled = false;
                    fnDragStart.call(this._active, this._eventPayload(event));
                }
            }
        }

        // Hover & pointer move (hover works with any handler; does not disable controls)
        const hit = this._intersect(event); // may be null

        // Handle enter/exit
        const newHovered = this._active || (hit ? hit.owner : null); // lock hover to active during drag
        if (newHovered !== this._hovered) {
            // Exit old
            if (this._hovered) {
                const fnExit = this._getHandler(this._hovered, 'onPointerExit');
                if (typeof fnExit === 'function') fnExit.call(this._hovered, this._eventPayload(event, hit));
            }
            // Enter new
            if (newHovered) {
                const fnEnter = this._getHandler(newHovered, 'onPointerEnter');
                if (typeof fnEnter === 'function') fnEnter.call(newHovered, this._eventPayload(event, hit));
            }
            this._hovered = newHovered;
        }

        // Pointer move callback (prefer active object, else current hit owner)
        const moveTarget = this._active || (hit ? hit.owner : null);
        if (moveTarget) {
            const fnMove = this._getHandler(moveTarget, 'onPointerMove');
            if (typeof fnMove === 'function') fnMove.call(moveTarget, this._eventPayload(event, hit));
        }
    }

    _onPointerDown(event) {
        if (this._disposed) return;

        this._pointerDown = true;
        this._downButton = event.button;
        this._downPos.x = event.clientX;
        this._downPos.y = event.clientY;

        // Only consider objects that *qualify* for this button (don’t block controls otherwise)
        const hit = this._intersect(event, (o) => this._qualifiesForButton(o, event));

        if (hit && hit.owner) {
            // Begin potential object interaction: do NOT block controls yet.
            this._active = hit.owner;

            // Capture pointer to keep receiving move/up even if leaving canvas
            try { this.renderer.domElement.setPointerCapture(event.pointerId); } catch { /* noop */ }

            // Do not prevent default here; let controls receive the gesture until/iff a drag actually starts.
        } else {
            // No qualifying object under pointer => allow normal controls
            this._active = null;
            this.controls.enabled = true;
        }
    }

    _onPointerUp(event) {
        if (this._disposed) return;

        const wasActive = this._active;
        const wasDragging = this._dragging;

        // Release pointer capture if we had it
        try { this.renderer.domElement.releasePointerCapture(event.pointerId); } catch { /* noop */ }

        // Determine if this qualifies as a click (small movement + same button)
        const dx = event.clientX - this._downPos.x;
        const dy = event.clientY - this._downPos.y;
        const moved = Math.hypot(dx, dy) > this._dragThreshold;
        const sameButton = (event.button === this._downButton);

        let handled = false;

        if (wasActive) {
            // Fire drag end if we started a drag (we consider any movement beyond threshold as drag)
            if (wasDragging) {
                const fnDragEnd = this._getHandler(wasActive, 'onDragEnd');
                if (typeof fnDragEnd === 'function') {
                    fnDragEnd.call(wasActive, this._eventPayload(event));
                    handled = true;
                }
            } else if (!moved && sameButton) {
                // Click / RightClick — only on a qualifying owner
                const predicate = (o) => this._qualifiesForButton(o, event);
                const hit = this._intersect(event, predicate); // re-check under pointer respecting visibility & qualifiers
                if (hit && hit.owner === wasActive) {
                    if (event.button === 2) {
                        const fnRight = this._getHandler(wasActive, 'onRightClick');
                        if (typeof fnRight === 'function') {
                            fnRight.call(wasActive, this._eventPayload(event, hit));
                            handled = true;
                        }
                    } else if (event.button === 0) {
                        const fnClick = this._getHandler(wasActive, 'onClick');

                        if (typeof fnClick === 'function') {
                            fnClick.call(wasActive, this._eventPayload(event, hit));
                            handled = true;
                        }
                    }
                }
            }
        }

        // Reset interaction + restore controls
        this._pointerDown = false;
        this._dragging = false;
        this._active = null;
        this.controls.enabled = true;
        //console.log("Pointer up:", event,handled);

        // Only prevent default if we actually handled an object interaction
        if (handled) event.preventDefault();
    }

    _onContextMenu(event) {
        // Support onRightClick without showing the browser menu, only if an owner qualifies
        const hit = this._intersect(event, (o) => typeof this._getHandler(o, 'onRightClick') === 'function');
        if (hit && hit.owner) {
            const fnRight = this._getHandler(hit.owner, 'onRightClick');
            if (typeof fnRight === 'function') {
                fnRight.call(hit.owner, this._eventPayload(event, hit));
                event.preventDefault();
            }
        }
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
        if (this._dragging) return; // do not interfere with object drags
        if (!this._lastPointerEvent) return; // nothing to test against
        // Reuse the same logic as pointer move to refresh hover under the cursor
        this._onPointerMove(this._lastPointerEvent);
    }
}
