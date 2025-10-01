// PMIMode.js
// Lightweight PMI editing mode modeled after SketchMode3D UI patterns.
// - Hides Viewer sidebar and main toolbar
// - Adds top-right Finish/Cancel controls
// - Adds a simple top toolbar for annotation tools
// - Adds a right-side overlay panel listing annotations for the current PMI view
// - Persists annotations back into the PMI view entry on Finish

import * as THREE from 'three';
import { AccordionWidget } from './AccordionWidget.js';
import { SelectionFilterWidget } from './selectionFilterWidget.js';
import { genFeatureUI } from './featureDialogs.js';

export class PMIMode {
  /**
   * @param {Viewer} viewer
   * @param {Object} viewEntry - reference to the PMI view object from PMIViewsWidget
   * @param {number} viewIndex - index of the view in PMIViewsWidget.views
   * @param {PMIViewsWidget} pmiWidget - widget instance for persistence/refresh
   */
  constructor(viewer, viewEntry, viewIndex, pmiWidget) {
    this.viewer = viewer;
    this.viewEntry = viewEntry || { name: 'View', camera: {}, annotations: [] };
    this.viewIndex = viewIndex;
    this.pmiWidget = pmiWidget;

    this._uiTopRight = null;
    this._uiTopBar = null;
    this._uiSide = null;
    this._annGroup = null;
    this._savedSidebarStyles = null;
    this._savedToolbarDisplay = null;
    this._tool = 'select'; // default tool
    this._opts = { noteText: '', leaderText: 'TEXT HERE', dimDecimals: 3 };
    this._pending = null; // for multi-click tools
    this._onCanvasDown = this._handlePointerDown.bind(this);
    this._pdConsumed = false; // track if PMI handled the current gesture
    this._onCanvasUp = (e) => {
      if (this._pdConsumed) {
        try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
        this._pdConsumed = false;
      }
    };
    this._onControlsChange = this._refreshOverlays.bind(this);
    this._gfuByIndex = new Map(); // idx -> genFeatureUI instance for dim widgets
    this._labelMap = new Map(); // idx -> HTML label element for annotations

    // Clone annotations to allow cancel; normalize legacy fields
    const src = Array.isArray(this.viewEntry.annotations) ? this.viewEntry.annotations : [];
    this._annotations = JSON.parse(JSON.stringify(src));
    // Migrate any legacy leader/dim fields to anchor-based refs (non-destructive in-memory)
    try { this._annotations = this._annotations.map(a => this.#normalizeAnnotation(a)); } catch { }
    // Ensure all annotations are closed by default when entering PMI view editor
    this._annotations.forEach(a => { a.__open = false; });
  }

  open() {
    const v = this.viewer;
    if (!v || !v.container) return;

    // Hide main sidebar and toolbar
    try {
      if (v.sidebar) {
        this._savedSidebarStyles = {
          hidden: v.sidebar.hidden,
          display: v.sidebar.style.display,
          visibility: v.sidebar.style.visibility,
        };
        v.sidebar.hidden = true;
        v.sidebar.style.display = 'none';
        v.sidebar.style.visibility = 'hidden';
      }
    } catch { }
    try {
      if (v.mainToolbar?.root) {
        this._savedToolbarDisplay = v.mainToolbar.root.style.display;
        v.mainToolbar.root.style.display = 'none';
      }
    } catch { }

    // Build styles once
    this.#ensureStyles();

    // Mount overlay UI
    this.#mountTopRightControls();
    // No top insert toolbar; additions via "+" in sidebar
    this.#mountLeftPanel();

    // Apply stored view settings for this PMI view (e.g., wireframe)
    try {
      const vs = this.viewEntry?.viewSettings || this.viewEntry?.settings;
      if (vs && typeof vs.wireframe === 'boolean') {
        this.#toggleWireframeMode(Boolean(vs.wireframe));
      }
    } catch { }

    // Build annotation group and render existing annotations
    this._annGroup = new THREE.Group();
    this._annGroup.name = `__PMI_ANN__:${this.viewEntry?.name || 'view'}`;
    this._annGroup.renderOrder = 9995;
    try { v.scene.add(this._annGroup); } catch { }
    this._annotationsDirty = true; // Flag to track when rebuild is needed
    this._lastCameraState = null; // Track camera changes for overlay updates
    this.#rebuildAnnotationObjects();
    this.#ensureLabelRoot();

    // Initial refresh of overlay positions
    setTimeout(() => this._refreshOverlays(), 100);

    // Periodically refresh to follow model changes, but only if needed
    try {
      this._refreshTimer = setInterval(() => {
        try {
          if (this._annotationsDirty) {
            this.#rebuildAnnotationObjects();
            this._annotationsDirty = false;
          }
          // Also check if camera has changed as fallback for overlay updates
          this.#checkCameraChange();
        } catch { }
      }, 1000);
    } catch { }

    // Listen on canvas for tool inputs
    // Use capture to preempt Viewer handlers and ArcballControls
    try { v.renderer.domElement.addEventListener('pointerdown', this._onCanvasDown, { passive: false, capture: true }); } catch { }
    try { window.addEventListener('pointerup', this._onCanvasUp, { passive: false, capture: true }); } catch { }
    // Listen for camera/controls changes to update label positions
    try {
      if (v.controls && typeof this._onControlsChange === 'function') {
        v.controls.addEventListener('change', this._onControlsChange);
        // Some controls use 'end' instead of 'change' for the final position
        if (typeof v.controls.addEventListener === 'function') {
          try { v.controls.addEventListener('end', this._onControlsChange); } catch { }
        }
      }
    } catch { }

    // Apply camera controls policy based on current tool
    try { this._controlsEnabledPrev = !!v.controls?.enabled; } catch { this._controlsEnabledPrev = true; }
    this.#applyControlsPolicy();

    // Add keyboard listener for escape key
    this._onKeyDown = (e) => {
      // Text position selection no longer needed
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  finish() {
    // Persist annotations back into the view entry and refresh PMI widget
    try { this.#_persistView(true); } catch { }
    try { this.viewer.onPMIFinished?.(this.viewEntry); } catch { }
    this.dispose();
  }

  cancel() {
    try { this.viewer.onPMICancelled?.(); } catch { }
    this.dispose();
  }

  dispose() {
    const v = this.viewer;
    
    // Clear any element highlights
    try { this.#clearElementHighlights(); } catch { }
    
    try { v.renderer.domElement.removeEventListener('pointerdown', this._onCanvasDown, { capture: true }); } catch { }
    try { window.removeEventListener('pointerup', this._onCanvasUp, { capture: true }); } catch { }
    // Remove controls change listeners
    try {
      if (v.controls && typeof this._onControlsChange === 'function') {
        v.controls.removeEventListener('change', this._onControlsChange);
        try { v.controls.removeEventListener('end', this._onControlsChange); } catch { }
      }
    } catch { }
    try { window.removeEventListener('keydown', this._onKeyDown); } catch { }
    // Remove overlay UI
    try { this._uiTopRight?.remove(); } catch { }
    try { this._uiTopBar?.remove(); } catch { }
    try { this._uiSide?.remove(); } catch { }
    // Clean up selection filter
    try { this._selectionFilter?.uiElement?.remove(); this._selectionFilter = null; } catch { }
    // Remove annotation group
    try { if (this._annGroup && this._annGroup.parent) this._annGroup.parent.remove(this._annGroup); } catch { }
    this._annGroup = null;
    try { if (this._refreshTimer) clearInterval(this._refreshTimer); } catch { } this._refreshTimer = null;
    // Remove labels overlay and destroy feature UIs
    try { this._labelMap && this._labelMap.forEach(el => el?.remove()); this._labelMap && this._labelMap.clear(); } catch { }
    try { this._labelRoot?.remove(); } catch { }
    try { this._gfuByIndex && this._gfuByIndex.forEach(ui => ui?.destroy?.()); this._gfuByIndex && this._gfuByIndex.clear(); } catch { }
    // Restore sidebar and toolbar
    try {
      const v = this.viewer;
      if (v.sidebar && this._savedSidebarStyles) {
        v.sidebar.hidden = this._savedSidebarStyles.hidden;
        v.sidebar.style.display = this._savedSidebarStyles.display || '';
        v.sidebar.style.visibility = this._savedSidebarStyles.visibility || 'visible';
      }
    } catch { }
    try {
      const v = this.viewer;
      if (v.mainToolbar?.root) {
        v.mainToolbar.root.style.display = this._savedToolbarDisplay || '';
      }
    } catch { }
    // Restore camera controls enabled state
    try { if (this.viewer?.controls) this.viewer.controls.enabled = !!this._controlsEnabledPrev; } catch { }
  }

  // Persist the current in-memory annotations back onto the view entry and save via PMI widget
  #_persistView(refreshList = false) {
    try {
      if (!this.viewEntry) return;
      // Write annotations
      this.viewEntry.annotations = JSON.parse(JSON.stringify(this._annotations || []));
      // Ensure the widget's views array references the same entry
      if (this.pmiWidget && Number.isFinite(this.viewIndex) && Array.isArray(this.pmiWidget.views)) {
        this.pmiWidget.views[this.viewIndex] = this.viewEntry;
      }
      // Save to storage
      this.pmiWidget?._persist?.();
      if (refreshList) this.pmiWidget?._renderList?.();
    } catch { /* ignore */ }
  }

  // --- UI construction ---
  #ensureStyles() {
    if (document.getElementById('pmi-mode-styles')) return;
    const style = document.createElement('style');
    style.id = 'pmi-mode-styles';
    style.textContent = `
      .pmi-top-right { position: absolute; top: 8px; right: 8px; display: flex; gap: 8px; z-index: 1001; }
      .pmi-btn { appearance: none; border: 1px solid #262b36; border-radius: 8px; padding: 6px 10px; cursor: pointer; background: rgba(255,255,255,.05); color: #e6e6e6; font-weight: 700; }
      .pmi-btn.primary { background: linear-gradient(180deg, rgba(110,168,254,.25), rgba(110,168,254,.15)); }
      .pmi-topbar { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; justify-content: center; gap: 6px; z-index: 1001; background: rgba(17,24,39,.7); border: 1px solid #1f2937; border-radius: 8px; padding: 6px; backdrop-filter: blur(4px); }
      .pmi-tool { appearance: none; border: 1px solid #374151; border-radius: 6px; padding: 4px 8px; cursor: pointer; color: #e5e7eb; background: rgba(255,255,255,.05); }
      .pmi-tool.active { border-color: #3b82f6; background: rgba(59,130,246,.15); }
      .pmi-side { position: absolute; top: 56px; left: 8px; width: 280px; bottom: 8px; display: flex; flex-direction: column; gap: 6px; z-index: 1001; background: rgba(11,15,19,.9); border: 1px solid #1f2937; border-radius: 8px; padding: 8px; overflow: hidden; }
      .pmi-side h3 { margin: 0 0 6px 0; font-size: 14px; color: #e5e7eb; }
      .pmi-ann-list { flex: 1 1 auto; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
      .pmi-ann-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-bottom: 1px solid #1f2937; }
      .pmi-ann-row:last-child { border-bottom: 0; }
      .pmi-ann-type { font-weight: 700; color: #93c5fd; min-width: 70px; }
      .pmi-ann-text { flex: 1 1 auto; color: #e5e7eb; }
      .pmi-del { border: 1px solid #7f1d1d; color: #fecaca; background: rgba(127,29,29,.2); border-radius: 6px; padding: 2px 6px; cursor: pointer; }
      .pmi-ann-card { border: 1px solid #1f2937; border-radius: 8px; padding: 8px; background: rgba(17,24,39,.6); display: flex; flex-direction: column; gap: 6px; }
      .pmi-rowline { display: flex; align-items: center; gap: 6px; }
      .pmi-tag { font-size: 11px; color: #93c5fd; border: 1px solid #334155; border-radius: 4px; padding: 0px 6px; }
      .pmi-field { display: flex; align-items: center; gap: 6px; }
      .pmi-field label { width: 110px; color: #9ca3af; }
      .pmi-input, .pmi-select, .pmi-number { background:  border: 1px solid #374151; border-radius: 6px; padding: 4px 6px; }
      .pmi-number { width: 80px; }
      /* Mini accordion for per-dimension dialogs */
      .pmi-acc { display: flex; flex-direction: column; gap: 4px; }
      .pmi-acc-item { background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01)); border: 1px solid #1f2937; border-radius: 10px; overflow: hidden; }
      .pmi-acc-header { display: grid; grid-template-columns: 1fr auto; align-items: stretch; }
      .pmi-acc-headbtn { appearance: none; width: 100%; text-align: left; background: transparent; color: #e5e7eb; border: 0; padding: 8px 10px; display: flex; align-items: center; gap: 6px; cursor: pointer; }
      .pmi-acc-title { flex: 1; }
      .pmi-acc-status { margin-left: 8px; color: #9ca3af; font-size: 12px; line-height: 1; }
      .pmi-acc-actions { display: flex; align-items: center; gap: 4px; padding: 6px 8px 6px 0; }
      .pmi-acc-content { padding: 8px 10px 10px 10px; border-top: 1px solid #1f2937; }
      .pmi-acc-item.collapsed .pmi-acc-content { display: none; }
      .pmi-acc-del { appearance: none; border: 1px solid #374151; background: rgba(255,255,255,.03); color: #e5e7eb; border-radius: 8px; padding: 4px 8px; cursor: pointer; }
      .pmi-acc-del:hover { border-color: #ef4444; color: #fff; background: rgba(239,68,68,.15); }
      .pmi-label-root { position: absolute; left: 0; top: 0; right: 0; bottom: 0; pointer-events: none; z-index:6; }
      .pmi-label { position: absolute; transform: translate(-50%, -50%); background: rgba(17,24,39,.92); color: #ffffff; border: 1px solid #111827; border-radius: 6px; padding: 2px 8px; font-weight: 700; pointer-events: auto; cursor: grab; user-select: none; font-size: 14px; line-height: 1.2; box-shadow: 0 2px 6px rgba(0,0,0,.35); }
      .pmi-label:active { cursor: grabbing; }
      .pmi-label-edit { font-size: 14px; font-weight: 700; text-align: left; outline: 2px solid #3b82f6; background: rgba(17,24,39,.95); color: #ffffff; border: 1px solid #374151; border-radius: 6px; padding: 2px 8px; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
      /* Vertical form fields for View Settings / Tool Options */
      .pmi-vfield { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; }
      .pmi-vlabel { color: #9ca3af; font-size: 12px; }
      .pmi-vfield .pmi-input, .pmi-vfield .pmi-number { width: 100%; box-sizing: border-box; background: #0b0e14; color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; padding: 6px 8px; }
      .pmi-vcheck { display: flex; align-items: center; gap: 8px; }
    `;
    document.head.appendChild(style);
  }

  #mountTopRightControls() {
    const host = this.viewer.container;
    host.style.position = host.style.position || 'relative';
    const wrap = document.createElement('div');
    wrap.className = 'pmi-top-right';

    // Add selection filter widget
    const filterContainer = document.createElement('div');
    filterContainer.style.display = 'flex';
    filterContainer.style.alignItems = 'center';
    this._selectionFilter = new SelectionFilterWidget(this.viewer, { inline: true, mountEl: filterContainer });
    wrap.appendChild(filterContainer);

    const btnFinish = document.createElement('button');
    btnFinish.className = 'pmi-btn primary';
    btnFinish.textContent = 'Finish';
    btnFinish.addEventListener('click', () => this.finish());
    const btnCancel = document.createElement('button');
    btnCancel.className = 'pmi-btn';
    btnCancel.textContent = 'Cancel';
    btnCancel.addEventListener('click', () => this.cancel());
    wrap.appendChild(btnFinish);
    wrap.appendChild(btnCancel);
    host.appendChild(wrap);
    this._uiTopRight = wrap;
  }

  #mountTopToolbar() {
    const host = this.viewer.container;
    const bar = document.createElement('div');
    bar.className = 'pmi-topbar';
    const mk = (id, label) => {
      const b = document.createElement('button');
      b.className = 'pmi-tool' + (this._tool === id ? ' active' : '');
      b.textContent = label;
      b.addEventListener('click', () => { this._tool = id; this.#refreshTopbar(bar); });
      return b;
    };
    bar.appendChild(mk('select', 'Select'));
    bar.appendChild(mk('note', 'Note'));
    bar.appendChild(mk('leader', 'Leader'));
    bar.appendChild(mk('dim', 'Linear Dim'));
    host.appendChild(bar);
    this._uiTopBar = bar;
  }

  #refreshTopbar(bar) {
    try {
      const btns = bar.querySelectorAll('.pmi-tool');
      btns.forEach((b) => {
        const id = (b.textContent || '').toLowerCase();
        const map = { 'select': 'select', 'note': 'note', 'leader': 'leader', 'linear dim': 'dim' };
        const bid = map[id] || 'select';
        if (bid === this._tool) b.classList.add('active'); else b.classList.remove('active');
      });
    } catch { }
    this.#applyControlsPolicy();
  }

  #applyControlsPolicy() {
    try {
      if (this.viewer?.controls) this.viewer.controls.enabled = (this._tool === 'select');
    } catch { }
  }

  #mountLeftPanel() {
    const host = this.viewer.container;
    const side = document.createElement('div');
    side.className = 'pmi-side';
    // Make the entire side panel scrollable
    Object.assign(side.style, {
      overflowY: 'auto',
      overflowX: 'hidden',
    });
    // Accordion side panel
    this._acc = new AccordionWidget();
    side.appendChild(this._acc.uiElement);
    // Build Annotations section asynchronously so the panel paints first
    this._annListEl = document.createElement('div');
    this._annListEl.className = 'pmi-ann-list';
    try {
      this._acc.addSection(`Annotations — ${this.viewEntry?.name || ''}`).then((sec) => {
        try {
          // Container for the section content (no fixed height)
          const scrollableContent = document.createElement('div');
          scrollableContent.className = 'pmi-scrollable-content';
          
          // List container
          scrollableContent.appendChild(this._annListEl);
          
          // Inline menu for annotation types (initially hidden)
          const inlineMenu = document.createElement('div');
          inlineMenu.className = 'pmi-inline-menu';
          Object.assign(inlineMenu.style, { 
            display: 'none',
            marginTop: '8px',
            padding: '8px',
            background: '#1a1d23',
            border: '1px solid #374151',
            borderRadius: '8px'
          });
          
          const makeItem = (label, type) => {
            const btn = document.createElement('button');
            btn.type = 'button'; btn.textContent = label; btn.style.display = 'block';
            Object.assign(btn.style, { 
              width: '100%', 
              textAlign: 'left', 
              background: 'transparent', 
              color: '#e5e7eb', 
              border: '0', 
              borderRadius: '6px', 
              padding: '8px 12px', 
              cursor: 'pointer',
              marginBottom: '2px'
            });
            btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(110,168,254,.12)'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
            btn.addEventListener('click', (ev) => {
              ev.stopPropagation();
              try {
                inlineMenu.style.display = 'none';
                this.#addNewAnnotation(type);
              } catch { }
            });
            return btn;
          };
          
          inlineMenu.appendChild(makeItem('Dimension', 'dim'));
          inlineMenu.appendChild(makeItem('Radial Dimension', 'radial'));
          inlineMenu.appendChild(makeItem('Angle', 'angle'));
          inlineMenu.appendChild(makeItem('Leader', 'leader'));
          inlineMenu.appendChild(makeItem('Note', 'note'));
          
          scrollableContent.appendChild(inlineMenu);
          
          // Footer with add button
          const footer = document.createElement('div');
          footer.className = 'pmi-ann-footer';
          Object.assign(footer.style, { 
            marginTop: '8px', 
            paddingTop: '8px', 
            borderTop: '1px dashed #1f2937', 
            display: 'flex', 
            justifyContent: 'center' 
          });
          
          const addBtn = document.createElement('button');
          addBtn.type = 'button'; addBtn.title = 'Add annotation'; addBtn.textContent = '+';
          Object.assign(addBtn.style, { 
            border: '1px solid #374151', 
            background: 'rgba(255,255,255,.03)', 
            color: '#e5e7eb', 
            borderRadius: '9999px', 
            width: '36px', 
            height: '36px', 
            cursor: 'pointer' 
          });
          
          const toggleMenu = (open) => { inlineMenu.style.display = open ? 'block' : 'none'; };
          addBtn.addEventListener('click', (ev) => { 
            ev.stopPropagation(); 
            toggleMenu(inlineMenu.style.display === 'none'); 
          });
          
          footer.appendChild(addBtn);
          
          // Add everything to the section
          sec.uiElement.appendChild(scrollableContent);
          sec.uiElement.appendChild(footer);
        } catch { }
      });
      // View Settings section
      this._viewSettingsEl = document.createElement('div');
      this._viewSettingsEl.style.padding = '6px';
      this._acc.addSection('View Settings').then((sec) => {
        try { sec.uiElement.appendChild(this._viewSettingsEl); this.#renderViewSettings(); } catch { }
      });
      
      // Tool Options section
      this._toolOptsEl = document.createElement('div');
      this._toolOptsEl.style.padding = '6px';
      this._acc.addSection('Tool Options').then((sec) => {
        try { sec.uiElement.appendChild(this._toolOptsEl); this.#renderToolOptions(); } catch { }
      });
    } catch {
      // Fallback: if accordion fails, append list directly
      const title = document.createElement('h3');
      title.textContent = `Annotations — ${this.viewEntry?.name || ''}`;
      side.appendChild(title);
      side.appendChild(this._annListEl);
    }
    host.appendChild(side);
    this._uiSide = side;
    this.#renderAnnList();
  }

  #addNewDimension() {
    try {
      const newDim = {
        type: 'dim',
        decimals: Number.isFinite(this._opts?.dimDecimals) ? (this._opts.dimDecimals | 0) : 3,
        aRefName: '',
        bRefName: '',
        alignment: 'view',
        __open: true,
      };
      this._annotations.push(newDim);
      this.#renderAnnList();
      this.#rebuildAnnotationObjects();
    } catch { }
  }

  #addNewAnnotation(type) {
    const t = String(type || 'dim').toLowerCase();
    if (t === 'note') {
      this._annotations.push({ type: 'note', text: '', __open: true });
      this.#renderAnnList();
      this.#rebuildAnnotationObjects();
      return;
    }
    if (t === 'leader') {
      this._annotations.push({
        type: 'leader',
        anchorRefName: '', // Target point (uses reference selection) 
        planeRefName: '', // Plane/face reference for alignment
        textPosition: null, // Text placement (absolute position, no reference)
        text: this._opts.leaderText || 'TEXT HERE',
        __open: true
      });
      this.#renderAnnList();
      this.#rebuildAnnotationObjects();
      return;
    }
    if (t === 'radial') {
      this._annotations.push({
        type: 'radial',
        decimals: Number.isFinite(this._opts?.dimDecimals) ? (this._opts.dimDecimals | 0) : 3,
        centerRefName: '', // Center point (vertex or point on arc/circle)
        edgeRefName: '', // Arc or circular edge to measure radius from
        planeRefName: '', // Face/plane to project the dimension onto
        displayStyle: 'radius', // 'radius' or 'diameter'
        alignment: 'view',
        offset: 0,
        __open: true,
      });
      this.#renderAnnList();
      this.#rebuildAnnotationObjects();
      return;
    }
    if (t === 'angle') {
      this._annotations.push({
        type: 'angle',
        decimals: Number.isFinite(this._opts?.angleDecimals) ? (this._opts.angleDecimals | 0) : 1,
        elementARefName: '', // First element (face or edge)
        elementBRefName: '', // Second element (face or edge)
        planeRefName: '', // Plane to project the angle onto
        alignment: 'view',
        offset: 0,
        __open: true,
      });
      this.#renderAnnList();
      this.#rebuildAnnotationObjects();
      return;
    }
    // default: dimension
    this.#addNewDimension();
  }

  #renderAnnList() {
    const list = this._annListEl;
    if (!list) return;
    try { this._gfuByIndex && this._gfuByIndex.forEach(ui => ui?.destroy?.()); this._gfuByIndex && this._gfuByIndex.clear(); } catch { }
    list.textContent = '';
    const anns = Array.isArray(this._annotations) ? this._annotations : [];
    // Wrap list in local accordion container for better spacing
    try { if (!list.classList.contains('pmi-acc')) list.classList.add('pmi-acc'); } catch { }
    anns.forEach((a, i) => {
      if (a.type === 'note') {
        // Collapsible item for Note
        const item = document.createElement('div'); item.className = 'pmi-acc-item acc-item open';
        const header = document.createElement('div'); header.className = 'pmi-acc-header';
        const headBtn = document.createElement('button'); headBtn.type = 'button'; headBtn.className = 'pmi-acc-headbtn';
        const title = document.createElement('div'); title.className = 'pmi-acc-title'; title.textContent = `Note ${i + 1}`;
        const status = document.createElement('div'); status.className = 'pmi-acc-status'; status.textContent = (a.text || '').slice(0, 24);
        headBtn.appendChild(title); headBtn.appendChild(status); header.appendChild(headBtn);
        const actions = document.createElement('div'); actions.className = 'pmi-acc-actions';
        const del = document.createElement('button'); del.className = 'pmi-acc-del'; del.textContent = 'Delete'; del.addEventListener('click', () => { this._annotations.splice(i, 1); this.#renderAnnList(); this.#rebuildAnnotationObjects(); });
        actions.appendChild(del); header.appendChild(actions); item.appendChild(header);
        const content = document.createElement('div'); content.className = 'pmi-acc-content';
        const schema = { text: { type: 'string', label: 'Text', default_value: a.text || '' } };
        const params = { text: schema.text.default_value };
        const ui = new genFeatureUI(schema, params, {
          viewer: this.viewer, onChange: () => {
            try { const p = ui.getParams(); a.text = String(p.text || ''); status.textContent = (a.text || '').slice(0, 24); this.#markAnnotationsDirty(); } catch { }
          }
        });
        content.appendChild(ui.uiElement); this._gfuByIndex.set(i, ui);
        item.appendChild(content);
        const setCollapsed = (c) => { item.classList.toggle('collapsed', !!c); };
        setCollapsed(!a.__open); headBtn.addEventListener('click', () => { a.__open = !a.__open; setCollapsed(!a.__open); });
        list.appendChild(item);
      }
      if (a.type === 'leader') {
        // Collapsible item for Leader (matching dimension/angle structure)
        const item = document.createElement('div'); item.className = 'pmi-acc-item acc-item open';
        const header = document.createElement('div'); header.className = 'pmi-acc-header';
        const headBtn = document.createElement('button'); headBtn.type = 'button'; headBtn.className = 'pmi-acc-headbtn';
        const title = document.createElement('div'); title.className = 'pmi-acc-title'; title.textContent = `Leader ${i + 1}`;
        const status = document.createElement('div'); status.className = 'pmi-acc-status'; status.textContent = (a.text || '').slice(0, 24);
        headBtn.appendChild(title); headBtn.appendChild(status);
        header.appendChild(headBtn);
        const actions = document.createElement('div'); actions.className = 'pmi-acc-actions';
        const del = document.createElement('button'); del.className = 'pmi-acc-del'; del.textContent = 'Delete'; del.addEventListener('click', () => { this._annotations.splice(i, 1); this.#renderAnnList(); this.#rebuildAnnotationObjects(); });
        actions.appendChild(del);
        header.appendChild(actions);
        item.appendChild(header);
        // Content
        const content = document.createElement('div'); content.className = 'pmi-acc-content';
        const schema = {
          anchor: { type: 'reference_selection', label: 'Target Point', selectionFilter: ['VERTEX'], default_value: a.anchorRefName || '' },
          planeRef: { type: 'reference_selection', label: 'Plane/Face', selectionFilter: ['FACE', 'PLANE'], default_value: a.planeRefName || '' },
          text: { type: 'textarea', label: 'Text', default_value: a.text || this._opts.leaderText || 'TEXT HERE', rows: 3 },
          anchorSide: { type: 'options', label: 'Anchor Side', options: ['left', 'right'], default_value: a.anchorSide || 'right' }
        };
        const params = { anchor: schema.anchor.default_value, planeRef: schema.planeRef.default_value, text: schema.text.default_value, anchorSide: schema.anchorSide.default_value };

        const ui = new genFeatureUI(schema, params, {
          viewer: this.viewer, onChange: () => {
            try {
              const p = ui.getParams();
              const oldAnchor = a.anchorRefName;
              a.anchorRefName = String(p.anchor || '');
              a.planeRefName = String(p.planeRef || '');
              a.text = String(p.text || '');
              a.anchorSide = String(p.anchorSide || 'right');

              // When the anchor changes, reset any manual text position
              // so label repositions relative to the new anchor + side.
              if (a.anchorRefName && a.anchorRefName !== oldAnchor) {
                delete a.textPosition;
                delete a._useDraggedPosition;
              }

              // Update header status
              status.textContent = (a.text || '').slice(0, 24);

              this.#markAnnotationsDirty();
            } catch { }
          }
        });

        content.appendChild(ui.uiElement);
        this._gfuByIndex.set(i, ui);

        // Add reset position button if text has been dragged
        if (a.textPosition) {
          const resetDiv = document.createElement('div');
          resetDiv.style.marginTop = '10px';
          const resetBtn = document.createElement('button');
          resetBtn.textContent = 'Reset to Anchor Position';
          resetBtn.className = 'pmi-reset-btn';
          resetBtn.style.cssText = 'padding: 4px 8px; font-size: 12px; background: #374151; border: 1px solid #4b5563; border-radius: 4px; cursor: pointer; color: #e5e7eb;';
          resetBtn.addEventListener('click', () => {
            delete a.textPosition;
            delete a._useDraggedPosition;
            this.#markAnnotationsDirty();
            this.#renderAnnList(); // Refresh UI to hide the button
          });
          resetDiv.appendChild(resetBtn);
          content.appendChild(resetDiv);
        }

        item.appendChild(content);
        // Toggle collapse
        const setCollapsed = (c) => { item.classList.toggle('collapsed', !!c); item.classList.toggle('open', !c); };
        setCollapsed(!a.__open);
        headBtn.addEventListener('click', () => { a.__open = !a.__open; setCollapsed(!a.__open); });
        list.appendChild(item);
      }
      if (a.type === 'dim') {
        // Collapsible mini-accordion item (similar to HistoryWidget entries)
        const item = document.createElement('div'); item.className = 'pmi-acc-item acc-item open';
        const header = document.createElement('div'); header.className = 'pmi-acc-header';
        const headBtn = document.createElement('button'); headBtn.type = 'button'; headBtn.className = 'pmi-acc-headbtn';
        const title = document.createElement('div'); title.className = 'pmi-acc-title'; title.textContent = `Dimension ${i + 1}`;
        const status = document.createElement('div'); status.className = 'pmi-acc-status';
        const measured = this.#measureDimValue(a); const dec = Number.isFinite(a.decimals) ? a.decimals : (this._opts.dimDecimals | 0);
        status.textContent = (typeof measured === 'number') ? `${measured.toFixed(dec)} (wu)` : '';
        headBtn.appendChild(title); headBtn.appendChild(status);
        header.appendChild(headBtn);
        const actions = document.createElement('div'); actions.className = 'pmi-acc-actions';
        const del = document.createElement('button'); del.className = 'pmi-acc-del'; del.textContent = 'Delete'; del.addEventListener('click', () => { this._annotations.splice(i, 1); this.#renderAnnList(); this.#rebuildAnnotationObjects(); });
        actions.appendChild(del);
        header.appendChild(actions);
        item.appendChild(header);
        // Content
        const content = document.createElement('div'); content.className = 'pmi-acc-content';
        const schema = {
          decimals: { type: 'number', label: 'Decimals', min: 0, max: 8, step: 1, default_value: Number.isFinite(a.decimals) ? a.decimals : (this._opts.dimDecimals | 0) },
          anchorA: { type: 'reference_selection', label: 'Point A', selectionFilter: ['VERTEX', 'EDGE'], default_value: a.aRefName || '' },
          anchorB: { type: 'reference_selection', label: 'Point B', selectionFilter: ['VERTEX', 'EDGE'], default_value: a.bRefName || '' },
          planeRef: { type: 'reference_selection', label: 'Face/Plane', selectionFilter: ['FACE', 'PLANE'], default_value: a.planeRefName || '' },
          alignment: { type: 'options', label: 'Alignment', options: ['view', 'XY', 'YZ', 'ZX'], default_value: a.alignment || 'view' },
          offset: { type: 'number', label: 'Offset', step: 'any', default_value: (Number.isFinite(a.offset) ? a.offset : 0) },
          showExt: { type: 'boolean', label: 'Extension Lines', default_value: (a.showExt !== false) },
          value: { type: 'string', label: 'Value', default_value: (() => { const dec = Number.isFinite(a.decimals) ? a.decimals : (this._opts.dimDecimals | 0); const v = this.#measureDimValue(a); return (typeof v === 'number') ? `${v.toFixed(dec)} (wu)` : '—'; })() },
        };
        const params = { decimals: schema.decimals.default_value, anchorA: schema.anchorA.default_value, anchorB: schema.anchorB.default_value, planeRef: schema.planeRef.default_value, alignment: schema.alignment.default_value, offset: schema.offset.default_value, showExt: schema.showExt.default_value, value: schema.value.default_value };
        const ui = new genFeatureUI(schema, params, {
          viewer: this.viewer, onChange: () => {
            try {
              const p = ui.getParams();
              a.decimals = Math.max(0, Math.min(8, Number(p.decimals) | 0));
              a.alignment = String(p.alignment || 'view');
              a.aRefName = String(p.anchorA || '');
              a.bRefName = String(p.anchorB || '');
              a.planeRefName = String(p.planeRef || '');
              a.offset = Number(p.offset);
              a.showExt = Boolean(p.showExt);
              // Reflect measured value
              const v = this.#measureDimValue(a);
              ui.params.value = (typeof v === 'number') ? `${v.toFixed(a.decimals)} (wu)` : '—';
              ui.refreshFromParams();
              // Update header status too
              try { status.textContent = (typeof v === 'number') ? `${v.toFixed(a.decimals)} (wu)` : ''; } catch { }
              this.#markAnnotationsDirty();
            } catch { }
          }
        });
        content.appendChild(ui.uiElement);
        this._gfuByIndex.set(i, ui);
        item.appendChild(content);
        // Toggle collapse
        const setCollapsed = (c) => { item.classList.toggle('collapsed', !!c); item.classList.toggle('open', !c); };
        setCollapsed(!a.__open);
        headBtn.addEventListener('click', () => { a.__open = !a.__open; setCollapsed(!a.__open); });
        list.appendChild(item);
      } else if (a.type === 'angle') {
        // Collapsible item for Angle measurement
        const item = document.createElement('div'); item.className = 'pmi-acc-item acc-item open';
        const header = document.createElement('div'); header.className = 'pmi-acc-header';
        const headBtn = document.createElement('button'); headBtn.type = 'button'; headBtn.className = 'pmi-acc-headbtn';
        const title = document.createElement('div'); title.className = 'pmi-acc-title'; title.textContent = `Angle ${i + 1}`;
        const status = document.createElement('div'); status.className = 'pmi-acc-status';
        const measured = this.#measureAngleValue(a); const dec = Number.isFinite(a.decimals) ? a.decimals : 1;
        status.textContent = (typeof measured === 'number') ? `${measured.toFixed(dec)}°` : '';
        headBtn.appendChild(title); headBtn.appendChild(status);
        header.appendChild(headBtn);
        const actions = document.createElement('div'); actions.className = 'pmi-acc-actions';
        const del = document.createElement('button'); del.className = 'pmi-acc-del'; del.textContent = 'Delete'; del.addEventListener('click', () => { this._annotations.splice(i, 1); this.#renderAnnList(); this.#rebuildAnnotationObjects(); });
        actions.appendChild(del);
        header.appendChild(actions);
        item.appendChild(header);
        // Content
        const content = document.createElement('div'); content.className = 'pmi-acc-content';
        const schema = {
          decimals: { type: 'number', label: 'Decimals', min: 0, max: 3, step: 1, default_value: Number.isFinite(a.decimals) ? a.decimals : 1 },
          elementA: { type: 'reference_selection', label: 'Element A', selectionFilter: ['FACE', 'EDGE'], default_value: a.elementARefName || '' },
          elementB: { type: 'reference_selection', label: 'Element B', selectionFilter: ['FACE', 'EDGE'], default_value: a.elementBRefName || '' },
          planeRef: { type: 'reference_selection', label: 'Projection Plane', selectionFilter: ['FACE', 'PLANE'], default_value: a.planeRefName || '' },
          alignment: { type: 'options', label: 'Alignment', options: ['view', 'XY', 'YZ', 'ZX'], default_value: a.alignment || 'view' },
          offset: { type: 'number', label: 'Offset', step: 'any', default_value: (Number.isFinite(a.offset) ? a.offset : 0) },
          useReflexAngle: { type: 'boolean', label: 'Reflex Angle (>180°)', default_value: (a.useReflexAngle === true) },
          value: { type: 'string', label: 'Angle', default_value: (() => { const dec = Number.isFinite(a.decimals) ? a.decimals : 1; const v = this.#measureAngleValue(a); return (typeof v === 'number') ? `${v.toFixed(dec)}°` : '—'; })() },
        };
        const params = { decimals: schema.decimals.default_value, elementA: schema.elementA.default_value, elementB: schema.elementB.default_value, planeRef: schema.planeRef.default_value, alignment: schema.alignment.default_value, offset: schema.offset.default_value, useReflexAngle: schema.useReflexAngle.default_value, value: schema.value.default_value };
        const ui = new genFeatureUI(schema, params, {
          viewer: this.viewer, 
          onChange: () => {
            try {
              const p = ui.getParams();
              a.decimals = Math.max(0, Math.min(3, Number(p.decimals) | 0));
              a.alignment = String(p.alignment || 'view');
              a.elementARefName = String(p.elementA || '');
              a.elementBRefName = String(p.elementB || '');
              a.planeRefName = String(p.planeRef || '');
              a.offset = Number(p.offset);
              a.useReflexAngle = Boolean(p.useReflexAngle);
              // Reflect measured value
              const v = this.#measureAngleValue(a);
              ui.params.value = (typeof v === 'number') ? `${v.toFixed(a.decimals)}°` : '—';
              ui.refreshFromParams();
              // Update header status too
              try { status.textContent = (typeof v === 'number') ? `${v.toFixed(a.decimals)}°` : ''; } catch { }
              this.#markAnnotationsDirty();
            } catch { }
          }
        });
        content.appendChild(ui.uiElement);
        
        // Add custom highlight button
        const highlightBtn = document.createElement('button');
        highlightBtn.type = 'button';
        highlightBtn.className = 'pmi-highlight-btn';
        highlightBtn.textContent = 'Highlight Selected Elements';
        highlightBtn.style.cssText = 'width: 100%; margin: 8px 0; padding: 8px; background: #007acc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px;';
        highlightBtn.addEventListener('mouseenter', () => {
          highlightBtn.style.background = '#005a9e';
        });
        highlightBtn.addEventListener('mouseleave', () => {
          highlightBtn.style.background = '#007acc';
        });
        highlightBtn.addEventListener('click', () => {
          this.#highlightAngleElements(a);
        });
        content.appendChild(highlightBtn);
        this._gfuByIndex.set(i, ui);
        item.appendChild(content);
        // Toggle collapse
        const setCollapsed = (c) => { item.classList.toggle('collapsed', !!c); item.classList.toggle('open', !c); };
        setCollapsed(!a.__open);
        headBtn.addEventListener('click', () => { a.__open = !a.__open; setCollapsed(!a.__open); });
        list.appendChild(item);
      } else if (a.type === 'radial') {
        // Collapsible item for Radial Dimension measurement
        const item = document.createElement('div'); item.className = 'pmi-acc-item acc-item open';
        const header = document.createElement('div'); header.className = 'pmi-acc-header';
        const headBtn = document.createElement('button'); headBtn.type = 'button'; headBtn.className = 'pmi-acc-headbtn';
        const title = document.createElement('div'); title.className = 'pmi-acc-title'; title.textContent = `Radial ${i + 1}`;
        const status = document.createElement('div'); status.className = 'pmi-acc-status';
        const measured = this.#measureRadialValue(a); const dec = Number.isFinite(a.decimals) ? a.decimals : 3;
        const displayValue = (typeof measured === 'number') ? (a.displayStyle === 'diameter' ? (measured * 2) : measured) : null;
        status.textContent = (typeof displayValue === 'number') ? `${(a.displayStyle === 'diameter' ? '⌀' : 'R')}${displayValue.toFixed(dec)}` : '';
        headBtn.appendChild(title); headBtn.appendChild(status);
        header.appendChild(headBtn);
        const actions = document.createElement('div'); actions.className = 'pmi-acc-actions';
        const del = document.createElement('button'); del.className = 'pmi-acc-del'; del.textContent = 'Delete'; del.addEventListener('click', () => { this._annotations.splice(i, 1); this.#renderAnnList(); this.#rebuildAnnotationObjects(); });
        actions.appendChild(del);
        header.appendChild(actions);
        item.appendChild(header);
        // Content
        const content = document.createElement('div'); content.className = 'pmi-acc-content';
        const schema = {
          decimals: { type: 'number', label: 'Decimals', min: 0, max: 8, step: 1, default_value: Number.isFinite(a.decimals) ? a.decimals : 3 },
          centerRef: { type: 'reference_selection', label: 'Center Point', selectionFilter: ['VERTEX'], default_value: a.centerRefName || '' },
          edgeRef: { type: 'reference_selection', label: 'Arc/Circle', selectionFilter: ['EDGE'], default_value: a.edgeRefName || '' },
          planeRef: { type: 'reference_selection', label: 'Projection Plane', selectionFilter: ['FACE'], default_value: a.planeRefName || '' },
          displayStyle: { type: 'options', label: 'Display Style', options: ['radius', 'diameter'], default_value: a.displayStyle || 'radius' },
          alignment: { type: 'options', label: 'Alignment', options: ['view', 'XY', 'YZ', 'ZX'], default_value: a.alignment || 'view' },
          offset: { type: 'number', label: 'Offset', step: 'any', default_value: (Number.isFinite(a.offset) ? a.offset : 0) },
          value: { type: 'string', label: 'Value', default_value: (() => { const dec = Number.isFinite(a.decimals) ? a.decimals : 3; const v = this.#measureRadialValue(a); const dv = (typeof v === 'number') ? (a.displayStyle === 'diameter' ? (v * 2) : v) : null; return (typeof dv === 'number') ? `${(a.displayStyle === 'diameter' ? '⌀' : 'R')}${dv.toFixed(dec)} (wu)` : '—'; })() },
        };
        const params = { decimals: schema.decimals.default_value, centerRef: schema.centerRef.default_value, edgeRef: schema.edgeRef.default_value, planeRef: schema.planeRef.default_value, displayStyle: schema.displayStyle.default_value, alignment: schema.alignment.default_value, offset: schema.offset.default_value, value: schema.value.default_value };
        const ui = new genFeatureUI(schema, params, {
          viewer: this.viewer, onChange: () => {
            try {
              const p = ui.getParams();
              a.decimals = Math.max(0, Math.min(8, Number(p.decimals) | 0));
              a.alignment = String(p.alignment || 'view');
              a.centerRefName = String(p.centerRef || '');
              a.edgeRefName = String(p.edgeRef || '');
              a.planeRefName = String(p.planeRef || '');
              a.displayStyle = String(p.displayStyle || 'radius');
              a.offset = Number(p.offset);
              // Reflect measured value
              const v = this.#measureRadialValue(a);
              const dv = (typeof v === 'number') ? (a.displayStyle === 'diameter' ? (v * 2) : v) : null;
              ui.params.value = (typeof dv === 'number') ? `${(a.displayStyle === 'diameter' ? '⌀' : 'R')}${dv.toFixed(a.decimals)} (wu)` : '—';
              ui.refreshFromParams();
              // Update header status too
              try { status.textContent = (typeof dv === 'number') ? `${(a.displayStyle === 'diameter' ? '⌀' : 'R')}${dv.toFixed(a.decimals)}` : ''; } catch { }
              this.#markAnnotationsDirty();
            } catch { }
          }
        });
        content.appendChild(ui.uiElement);
        this._gfuByIndex.set(i, ui);
        item.appendChild(content);
        // Toggle collapse
        const setCollapsed = (c) => { item.classList.toggle('collapsed', !!c); item.classList.toggle('open', !c); };
        setCollapsed(!a.__open);
        headBtn.addEventListener('click', () => { a.__open = !a.__open; setCollapsed(!a.__open); });
        list.appendChild(item);
      }
    });
  }

  #makeField(labelText, inputEl) {
    const wrap = document.createElement('div'); wrap.className = 'pmi-field';
    const lab = document.createElement('label'); lab.textContent = labelText; wrap.appendChild(lab); wrap.appendChild(inputEl); return wrap;
  }

  #renderToolOptions() {
    const el = this._toolOptsEl;
    if (!el) return;
    el.textContent = '';

    const makeVField = (label, input) => {
      const wrap = document.createElement('div');
      wrap.className = 'pmi-vfield';
      const lab = document.createElement('div');
      lab.className = 'pmi-vlabel';
      lab.textContent = label;
      wrap.appendChild(lab);
      wrap.appendChild(input);
      return wrap;
    };

    const mkText = (placeholder, value, onChange) => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder;
      inp.value = value || '';
      inp.className = 'pmi-input';
      inp.addEventListener('change', () => onChange(inp.value));
      return inp;
    };

    const mkNumber = (value, onChange, { min = 0, max = 8 } = {}) => {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = String(min); inp.max = String(max);
      inp.value = String(value);
      inp.className = 'pmi-number';
      inp.addEventListener('change', () => {
        let v = Number(inp.value);
        if (!Number.isFinite(v)) v = 3;
        v = Math.max(min, Math.min(max, v));
        onChange(v);
      });
      return inp;
    };

    const noteDefault = mkText('Default note text', this._opts.noteText, (v) => { this._opts.noteText = v; });
    el.appendChild(makeVField('Note text', noteDefault));

    const leaderDefault = mkText('Default leader text', this._opts.leaderText, (v) => { this._opts.leaderText = v; });
    el.appendChild(makeVField('Leader text', leaderDefault));

    const dimDec = mkNumber(this._opts.dimDecimals, (v) => { this._opts.dimDecimals = v | 0; this.#renderAnnList(); }, { min: 0, max: 8 });
    el.appendChild(makeVField('Dim decimals', dimDec));
  }

  #renderViewSettings() {
    const el = this._viewSettingsEl;
    if (!el) return;
    el.textContent = '';

    const makeVField = (label, input) => {
      const wrap = document.createElement('div');
      wrap.className = 'pmi-vfield';
      const lab = document.createElement('div');
      lab.className = 'pmi-vlabel';
      lab.textContent = label;
      wrap.appendChild(lab);
      wrap.appendChild(input);
      return wrap;
    };

    // View name input
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = this.viewEntry?.name || '';
    nameInput.placeholder = 'View name';
    nameInput.style.flex = '1 1 auto';
    nameInput.style.background = '#0b0e14';
    nameInput.style.color = '#e5e7eb';
    nameInput.style.border = '1px solid #374151';
    nameInput.style.borderRadius = '6px';
    nameInput.style.padding = '4px 6px';
    nameInput.addEventListener('change', () => {
      if (this.viewEntry) {
        this.viewEntry.name = nameInput.value.trim() || 'View';
        // Update accordion section title
        this.#updateAnnotationsSectionTitle();
      }
    });
    nameInput.className = 'pmi-input';
    el.appendChild(makeVField('View Name', nameInput));

    // Wireframe toggle
    const wireframeToggle = document.createElement('input');
    wireframeToggle.type = 'checkbox';
    wireframeToggle.id = 'pmi-wireframe-toggle';
    // Prefer stored view setting if available
    const storedWireframe = (this.viewEntry?.viewSettings || this.viewEntry?.settings)?.wireframe;
    wireframeToggle.checked = (typeof storedWireframe === 'boolean') ? storedWireframe : this.#isWireframeMode();
    wireframeToggle.style.accentColor = '#3b82f6';
    wireframeToggle.addEventListener('change', () => {
      const on = Boolean(wireframeToggle.checked);
      this.#toggleWireframeMode(on);
      try {
        // Persist into the view entry
        if (!this.viewEntry.viewSettings) this.viewEntry.viewSettings = {};
        this.viewEntry.viewSettings.wireframe = on;
        this.pmiWidget?._persist?.();
      } catch { }
    });
    
    const toggleLabel = document.createElement('label');
    toggleLabel.htmlFor = 'pmi-wireframe-toggle';
    toggleLabel.textContent = 'Wireframe';
    toggleLabel.style.color = '#e5e7eb';
    toggleLabel.style.cursor = 'pointer';
    
    const toggleContainer = document.createElement('div');
    toggleContainer.style.display = 'flex';
    toggleContainer.style.alignItems = 'center';
    toggleContainer.style.gap = '8px';
    toggleContainer.className = 'pmi-vcheck';
    toggleContainer.appendChild(wireframeToggle);
    toggleContainer.appendChild(toggleLabel);
    el.appendChild(makeVField('Render Mode', toggleContainer));

    // Update camera button
    const updateCameraBtn = document.createElement('button');
    updateCameraBtn.textContent = 'Update Camera';
    updateCameraBtn.className = 'pmi-btn';
    updateCameraBtn.style.width = '100%';
    updateCameraBtn.addEventListener('click', () => {
      this.#updateStoredCamera(updateCameraBtn);
    });
    
    const btnRow = document.createElement('div');
    btnRow.style.margin = '8px 0';
    btnRow.appendChild(updateCameraBtn);
    el.appendChild(btnRow);
  }

  #updateAnnotationsSectionTitle() {
    try {
      // Find and update the annotations section title
      const sections = this._acc?.uiElement?.querySelectorAll('.accordion-header');
      if (sections) {
        sections.forEach(header => {
          const titleEl = header.querySelector('.accordion-title');
          if (titleEl && titleEl.textContent.includes('Annotations')) {
            titleEl.textContent = `Annotations — ${this.viewEntry?.name || ''}`;
          }
        });
      }
    } catch { }
  }

  #isWireframeMode() {
    try {
      // Check if the scene materials are in wireframe mode
      const scene = this.viewer?.scene;
      if (!scene) return false;
      
      // Check if any mesh has wireframe enabled
      let hasWireframe = false;
      scene.traverse((obj) => {
        if (obj.material && obj.material.wireframe === true) {
          hasWireframe = true;
        }
      });
      return hasWireframe;
    } catch {
      return false;
    }
  }

  #toggleWireframeMode(isWireframe) {
    try {
      const scene = this.viewer?.scene;
      if (!scene) return;
      
      // Toggle wireframe on all materials in the scene
      scene.traverse((obj) => {
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach(mat => {
              if (mat) mat.wireframe = isWireframe;
            });
          } else {
            obj.material.wireframe = isWireframe;
          }
        }
      });
      
      // Trigger a render update
      if (this.viewer?.render) {
        this.viewer.render();
      }
    } catch { }
  }

  #updateStoredCamera(btnEl) {
    try {
      const camera = this.viewer?.camera;
      if (!camera || !this.viewEntry) return;
      
      // Store current camera position and quaternion (not rotation), up and zoom
      const snap = {
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        quaternion: { x: camera.quaternion.x, y: camera.quaternion.y, z: camera.quaternion.z, w: camera.quaternion.w },
        up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
        zoom: camera.zoom || 1,
      };
      // Also store controls target if available
      const ctrls = this.viewer?.controls;
      if (ctrls && ctrls.target) {
        snap.target = { x: ctrls.target.x, y: ctrls.target.y, z: ctrls.target.z };
      }
      this.viewEntry.camera = snap;
      
      // Persist the changes if we have a PMI widget
      if (this.pmiWidget?._persist) {
        this.pmiWidget._persist();
      }
      
      // Visual feedback - briefly flash the button
      const btn = btnEl || document.querySelector('.pmi-btn');
      if (btn) {
        const originalText = btn.textContent;
        btn.textContent = 'Camera Updated';
        btn.style.background = 'rgba(34, 197, 94, 0.25)';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '';
        }, 1000);
      }
    } catch { }
  }

  // --- Annotation 3D visuals ---
  #clearAnnGroup() {
    try {
      if (!this._annGroup) return;
      for (let i = this._annGroup.children.length - 1; i >= 0; i--) {
        const c = this._annGroup.children[i];
        this._annGroup.remove(c);
        if (c.geometry) c.geometry.dispose?.();
        if (c.material) c.material.dispose?.();
      }
    } catch { }
  }

  _refreshOverlays() {
    // Throttle refresh to prevent excessive updates during camera movement
    if (this._refreshPending) return;
    this._refreshPending = true;

    requestAnimationFrame(() => {
      this._refreshPending = false;
      this.#doRefreshOverlays();
    });
  }

  #checkCameraChange() {
    // Check if camera has changed and refresh overlays if needed
    try {
      const camera = this.viewer?.camera;
      if (!camera) return;

      // Get current camera state
      const currentState = {
        px: camera.position.x, py: camera.position.y, pz: camera.position.z,
        rx: camera.rotation.x, ry: camera.rotation.y, rz: camera.rotation.z,
        zoom: camera.zoom || 1
      };

      // Compare with previous state
      if (!this._lastCameraState) {
        this._lastCameraState = currentState;
        return;
      }

      const prev = this._lastCameraState;
      const threshold = 0.0001; // Small threshold for floating point comparison

      const changed =
        Math.abs(currentState.px - prev.px) > threshold ||
        Math.abs(currentState.py - prev.py) > threshold ||
        Math.abs(currentState.pz - prev.pz) > threshold ||
        Math.abs(currentState.rx - prev.rx) > threshold ||
        Math.abs(currentState.ry - prev.ry) > threshold ||
        Math.abs(currentState.rz - prev.rz) > threshold ||
        Math.abs(currentState.zoom - prev.zoom) > threshold;

      if (changed) {
        this._lastCameraState = currentState;
        this._refreshOverlays();
      }
    } catch (e) {
      console.warn('Error checking camera change:', e);
    }
  }

  #doRefreshOverlays() {
    // Update all label positions when camera changes (pan, zoom, rotate)
    try {
      if (!this._labelMap || this._labelMap.size === 0) return;

      // Update each label's position based on its associated 3D world position
      this._labelMap.forEach((el, idx) => {
        try {
          const ann = this._annotations?.[idx];
          if (!ann) return;

          // Determine the world position for this annotation
          let worldPos = null;

          if (ann.type === 'leader') {
            if (ann._useDraggedPosition && ann.textPosition) {
              // Use dragged position
              worldPos = new THREE.Vector3(ann.textPosition.x, ann.textPosition.y, ann.textPosition.z);
            } else {
              // Use anchor point for anchor-relative positioning
              const fallback = (ann.start ? new THREE.Vector3(ann.start.x || 0, ann.start.y || 0, ann.start.z || 0) : null);
              worldPos = this.#resolveRefNameToWorld(ann.anchorRefName, fallback) || this.#resolveAnchorToWorld(ann.anchor) || fallback || new THREE.Vector3();
            }
          } else if (ann.type === 'dim') {
            // For dimensions, use labelWorld if available
            if (ann.labelWorld) {
              worldPos = new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
            }
          } else if (ann.type === 'note') {
            // For notes, use labelWorld if available
            if (ann.labelWorld) {
              worldPos = new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
            }
          } else if (ann.type === 'angle') {
            // For angles, place label on the selected plane
            const elements = this.#computeAngleElements(ann);
            if (ann.labelWorld) {
              worldPos = new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
              // Project any existing label position to the plane to keep it consistent
              try {
                const planeNormal = (elements && elements.plane && elements.plane.lengthSq() > 0) ? elements.plane.clone().normalize() : null;
                if (planeNormal) {
                  let planePoint = new THREE.Vector3();
                  if (ann.planeRefName) {
                    const planeObj = this.viewer?.partHistory?.scene?.getObjectByName(ann.planeRefName);
                    if (planeObj) planePoint = this.#objectRepresentativePoint(planeObj) || planePoint;
                  }
                  worldPos = this.#projectPointToPlane(worldPos, planePoint, planeNormal);
                }
              } catch {}
            } else if (elements) {
              // Compute default position based on angle elements (in plane)
              worldPos = this.#computeAngleLabelPosition(ann, elements);
            }
          } else if (ann.type === 'radial') {
            // For radial dimensions, use labelWorld if available
            if (ann.labelWorld) {
              worldPos = new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
            } else {
              // Compute default position based on radial elements
              const radialData = this.#computeRadialPoints(ann);
              if (radialData && radialData.center && radialData.radiusPoint) {
                worldPos = this.#computeRadialLabelPosition(ann, radialData.center, radialData.radiusPoint);
              }
            }
          }

          // Update the label position
          if (worldPos) {
            if (ann.type === 'leader' && !ann._useDraggedPosition) {
              // Use anchor-relative positioning for leaders
              this.#positionLeaderLabel(el, worldPos, ann);
            } else {
              // Use standard positioning
              this.#positionLabel(el, worldPos);
            }
          }

          // Update leader lines for leader annotations since they depend on camera orientation
          if (ann.type === 'leader' && worldPos && this._annGroup) {
            try {
              const anchorPoint = this.#resolveRefNameToWorld(ann.anchorRefName) || worldPos;
              if (ann._useDraggedPosition && ann.textPosition) {
                const textPos = new THREE.Vector3(ann.textPosition.x, ann.textPosition.y, ann.textPosition.z);
                this.#createLeaderLineToDraggedText(this._annGroup, anchorPoint, textPos, idx, ann);
              } else {
                this.#createLeaderLineToText(this._annGroup, anchorPoint, idx, ann);
              }
            } catch (e) {
              console.warn('Error updating leader lines:', e);
            }
          }
        } catch (e) {
          console.warn('Error refreshing label position:', e);
        }
      });
    } catch (e) {
      console.warn('Error refreshing overlays:', e);
    }
  }

  #markAnnotationsDirty() {
    this._annotationsDirty = true;
  }

  #rebuildAnnotationObjects() {
    this.#clearAnnGroup();
    const group = this._annGroup;
    if (!group) return;
    // Ensure overlay exists; do not clear between frames so labels remain visible even if a render is skipped
    try { this.#ensureLabelRoot(); } catch { }
    const anns = Array.isArray(this._annotations) ? this._annotations : [];
    const makeSphere = (color = 0x93c5fd, size = 0.08) => {
      const g = new THREE.SphereGeometry(size, 16, 12);
      const m = new THREE.MeshBasicMaterial({ color });
      m.depthTest = false; m.depthWrite = false; m.transparent = true;
      return new THREE.Mesh(g, m);
    };
    const makeLine = (a, b, color = 0x93c5fd) => {
      const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
      const mat = new THREE.LineBasicMaterial({ color });
      mat.depthTest = false; mat.depthWrite = false; mat.transparent = true;
      return new THREE.Line(geom, mat);
    };
    let expectedLabels = 0;
    anns.forEach((a, i) => {
      if (a.type === 'note') {
        const p = new THREE.Vector3(a.position?.x || 0, a.position?.y || 0, a.position?.z || 0);
        const dot = makeSphere(0x93c5fd, 0.08);
        dot.position.copy(p);
        group.add(dot);
        // Note text label near the point (slightly offset toward screen up-right)
        const offset = this.#_screenSizeWorld(16);
        const n = this.#_alignNormal('view', a);
        const camRight = new THREE.Vector3();
        const camUp = new THREE.Vector3(0, 1, 0);
        try { this.viewer?.camera?.getWorldDirection?.(camRight); camRight.crossVectors(n, camUp).normalize(); } catch { camRight.set(1, 0, 0); }
        const labelPos = a.labelWorld ? new THREE.Vector3(a.labelWorld.x, a.labelWorld.y, a.labelWorld.z) : p.clone().addScaledVector(camRight, offset).addScaledVector(n, offset * 0.25);
        const txt = String(a.text || '');
        if (txt) { this.#updateDimLabel(i, txt, labelPos, a); expectedLabels++; }
      } else if (a.type === 'leader') {
        // Target point (with reference)
        const fallback = (a.start ? new THREE.Vector3(a.start.x || 0, a.start.y || 0, a.start.z || 0) : null);
        const p0 = this.#resolveRefNameToWorld(a.anchorRefName, fallback) || this.#resolveAnchorToWorld(a.anchor) || fallback || new THREE.Vector3();

        // Check if text has been manually positioned (dragged)
        const textPos = a.textPosition ? new THREE.Vector3(a.textPosition.x, a.textPosition.y, a.textPosition.z) : null;

        if (p0) {
          const txt = String(a.text || '');
          if (txt) {
            if (textPos) {
              // Use dragged position - disable anchor-relative positioning
              a._useDraggedPosition = true;
              this.#updateDimLabel(i, txt, textPos, a);

              // Create leader line from anchor to dragged text position
              this.#createLeaderLineToDraggedText(group, p0, textPos, i, a);
            } else {
              // Use anchor-relative positioning
              a._useDraggedPosition = false;
              this.#updateDimLabel(i, txt, p0, a);

              // Create leader line from anchor point to text edge
              this.#createLeaderLineToText(group, p0, i, a);
            }
            expectedLabels++;
          }
        } else {
          // If no text position is set yet, just show the target point
          const head = makeSphere(0xf59e0b, 0.06);
          head.position.copy(p0);
          group.add(head);
        }
      } else if (a.type === 'dim') {
        const pts = this.#computeDimPoints(a);
        const p0 = pts?.p0 || new THREE.Vector3(0, 0, 0);
        const p1 = pts?.p1 || new THREE.Vector3(0, 0, 0);
        this.#drawDimension(group, a, p0, p1);
        // Label overlay update
        const dec = Number.isFinite(a.decimals) ? a.decimals : (this._opts.dimDecimals | 0);
        const val = p0.distanceTo(p1);
        const labelPos = a.labelWorld ? new THREE.Vector3(a.labelWorld.x, a.labelWorld.y, a.labelWorld.z)
          : new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
        this.#updateDimLabel(i, `${val.toFixed(dec)}`, labelPos, a);
        expectedLabels++;
      } else if (a.type === 'angle') {
        const elements = this.#computeAngleElements(a);
        if (elements && elements.dirA && elements.dirB) {
          // Draw angle annotation
          this.#drawAngle(group, a, elements);

          // Label overlay update
          const dec = Number.isFinite(a.decimals) ? a.decimals : 1;
          const angleValue = this.#measureAngleValue(a);
          if (typeof angleValue === 'number') {
            const labelPos = a.labelWorld ? new THREE.Vector3(a.labelWorld.x, a.labelWorld.y, a.labelWorld.z)
              : this.#computeAngleLabelPosition(a, elements);
            this.#updateDimLabel(i, `${angleValue.toFixed(dec)}°`, labelPos, a);
            expectedLabels++;
          }
        }
      } else if (a.type === 'radial') {
        const radialValue = this.#measureRadialValue(a);
        // Always try to draw radial dimension, even with fallback values
        let actualRadialValue = (typeof radialValue === 'number') ? radialValue : 5.0;
        const radialData = this.#computeRadialPoints(a);
        
        if (radialData && radialData.center && radialData.radiusPoint) {
          
          // Draw radial dimension annotation
          this.#drawRadialDimension(group, a, radialData.center, radialData.radiusPoint, actualRadialValue, radialData.planeNormal);

          // Label overlay update
          const dec = Number.isFinite(a.decimals) ? a.decimals : 3;
          const displayValue = (a.displayStyle === 'diameter') ? (actualRadialValue * 2) : actualRadialValue;
          const prefix = (a.displayStyle === 'diameter') ? '⌀' : 'R';
          const labelPos = a.labelWorld ? new THREE.Vector3(a.labelWorld.x, a.labelWorld.y, a.labelWorld.z)
            : this.#computeRadialLabelPosition(a, radialData.center, radialData.radiusPoint);
          this.#updateDimLabel(i, `${prefix}${displayValue.toFixed(dec)}`, labelPos, a);
          expectedLabels++;
        } else {
          console.warn('Failed to compute radial points for radial dimension');
        }
      }
    });
    try { this.viewer.render(); } catch { }
    // After render, verify we have expected labels attached; alert once globally if missing
    try {
      const check = () => {
        try {
          const root = this._labelRoot;
          const count = root && root.children ? root.children.length : 0;
          if (expectedLabels > 0 && count === 0 && !this.__alertedNoLabels) {
            this.__alertedNoLabels = true;
            console.warn('PMI: No labels were inserted into .pmi-label-root even though annotations require them.');
          }
        } catch { console.warn('PMI: failed to verify annotation labels.'); }
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(check); else setTimeout(check, 0);
    } catch { }
  }

  #ensureLabelRoot() {
    if (this._labelRoot && this._labelRoot.parentNode) return;
    const host = this.viewer?.container; if (!host) return;
    try { if (!host.style.position || host.style.position === 'static') host.style.position = 'relative'; } catch { }
    const div = document.createElement('div'); div.className = 'pmi-label-root';
    host.appendChild(div); this._labelRoot = div;
  }

  #updateDimLabel(idx, text, worldPos, ann) {
    this.#ensureLabelRoot();
    let el = this._labelMap.get(idx);
    if (!el) {
      el = document.createElement('div'); el.className = 'pmi-label'; el.textContent = text;
      el.addEventListener('pointerdown', (e) => { this.#startLabelDrag(idx, ann, e); });
      // Add double-click to focus text field in annotation dialog
      el.addEventListener('dblclick', (e) => { this.#focusAnnotationDialog(idx, ann, e); });
      try { this._labelRoot.appendChild(el); this._labelMap.set(idx, el); } catch { }
      // Verify it was actually inserted; alert once per annotation if not
      try {
        const checkOnce = () => {
          try {
            const ok = !!(el && el.isConnected && this._labelRoot && this._labelRoot.contains(el));
            if (!ok && ann && !ann.__labelAlerted) {
              ann.__labelAlerted = true;
              console.warn(`PMI: failed to insert label for ${String(ann?.type || 'annotation')} #${String(idx)}. Inspect .pmi-label-root overlay.`);
            }
          } catch { }
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(checkOnce); else setTimeout(checkOnce, 0);
      } catch { }
    } else { el.textContent = text; }

    // Special positioning for leader annotations
    if (ann && ann.type === 'leader') {
      if (ann._useDraggedPosition) {
        // Use standard positioning for dragged text (worldPos is the dragged position)
        this.#positionLabel(el, worldPos);
      } else {
        // Use anchor-relative positioning (worldPos is the anchor point)
        this.#positionLeaderLabel(el, worldPos, ann);
      }
    } else {
      this.#positionLabel(el, worldPos);
    }
  }

  #positionLabel(el, world) {
    try {
      const v = this.viewer; if (!v) return;
      const vec = world.clone().project(v.camera);
      const canvasRect = v.renderer.domElement.getBoundingClientRect();
      const rootRect = this._labelRoot?.getBoundingClientRect?.() || canvasRect;
      const x = rootRect.left + (vec.x * 0.5 + 0.5) * canvasRect.width;
      const y = rootRect.top + (-vec.y * 0.5 + 0.5) * canvasRect.height;
      // Convert to coordinates relative to the label root
      const relX = x - rootRect.left;
      const relY = y - rootRect.top;
      el.style.left = `${relX}px`; el.style.top = `${relY}px`;
    } catch { }
  }

  #positionLeaderLabel(el, world, ann) {
    try {
      const v = this.viewer; if (!v) return;

      // Convert 3D world position to 2D screen coordinates
      const vec = world.clone().project(v.camera);
      const canvasRect = v.renderer.domElement.getBoundingClientRect();
      const rootRect = this._labelRoot?.getBoundingClientRect?.() || canvasRect;
      const x = rootRect.left + (vec.x * 0.5 + 0.5) * canvasRect.width;
      const y = rootRect.top + (-vec.y * 0.5 + 0.5) * canvasRect.height;

      // Convert to coordinates relative to the label root
      const relX = x - rootRect.left;
      const relY = y - rootRect.top;

      // Get the anchor side (default to 'right')
      const anchorSide = ann.anchorSide || 'right';

      // Add offset from anchor point (40 pixels horizontally + 20 pixels of leader line = 60px total)
      const offsetDistance = 60; // Total distance from anchor point
      let textX = relX;

      if (anchorSide === 'left') {
        textX = relX - offsetDistance; // Position text to the left with offset
      } else {
        textX = relX + offsetDistance; // Position text to the right with offset
      }

      // Set position
      el.style.position = 'absolute';
      el.style.top = `${relY}px`;
      el.style.left = `${textX}px`;

      // Align label so its near edge sits at textX.
      // - For 'right' side: left edge at textX.
      // - For 'left' side: right edge at textX (translateX(-100%)).
      if (anchorSide === 'left') {
        el.style.transformOrigin = 'left center';
        el.style.transform = 'translate(-100%, -50%)';
      } else {
        el.style.transformOrigin = 'left center';
        el.style.transform = 'translateY(-50%)';
      }

    } catch (e) {
      console.warn('Error in positionLeaderLabel:', e);
    }
  }

  #createLeaderLineToText(group, anchorPoint, labelIdx, ann) {
    try {
      const v = this.viewer;
      if (!v) return;

      // Remove any existing leader lines for this annotation
      const existingLines = group.children.filter(child =>
        child.userData && child.userData.isLeaderLine && child.userData.labelIdx === labelIdx
      );
      existingLines.forEach(line => group.remove(line));

      // Calculate positions in world space based on our known offset (60px total, 20px leader)
      const anchorSide = ann.anchorSide || 'right';
      const pixelOffset = this.#_screenSizeWorld(20) || 0.1; // 20px leader line
      const textOffset = this.#_screenSizeWorld(40) || 0.2;   // 40px from anchor to text start

      // Get camera vectors for screen-space calculations
      const camera = v.camera;
      const horizontal = new THREE.Vector3();

      if (camera) {
        // Get camera's right vector (perpendicular to view direction)
        const cameraDirection = new THREE.Vector3();
        camera.getWorldDirection(cameraDirection);
        const up = new THREE.Vector3(0, 1, 0);
        horizontal.crossVectors(up, cameraDirection).normalize();

        // Adjust direction based on anchor side
        if (anchorSide === 'left') {
          horizontal.multiplyScalar(-1); // Point left
        }
        // For right, keep the direction as is
      } else {
        // Fallback if no camera
        horizontal.set(anchorSide === 'left' ? -1 : 1, 0, 0);
      }

      // Calculate key points
      const textStart = anchorPoint.clone().add(horizontal.clone().multiplyScalar(textOffset));
      const bendPoint = anchorPoint.clone().add(horizontal.clone().multiplyScalar(textOffset + pixelOffset));

      // Create horizontal line from text to bend point
      const horizontalLine = new THREE.BufferGeometry().setFromPoints([textStart, bendPoint]);
      const horizontalMat = new THREE.LineBasicMaterial({ color: 0x93c5fd });
      horizontalMat.depthTest = false;
      horizontalMat.depthWrite = false;
      horizontalMat.transparent = true;
      const horizontalMesh = new THREE.Line(horizontalLine, horizontalMat);
      horizontalMesh.userData = { isLeaderLine: true, labelIdx };
      group.add(horizontalMesh);

      // Create angled line from bend point to anchor
      const angledLine = new THREE.BufferGeometry().setFromPoints([bendPoint, anchorPoint]);
      const angledMat = new THREE.LineBasicMaterial({ color: 0x93c5fd });
      angledMat.depthTest = false;
      angledMat.depthWrite = false;
      angledMat.transparent = true;
      const angledMesh = new THREE.Line(angledLine, angledMat);
      angledMesh.userData = { isLeaderLine: true, labelIdx };
      group.add(angledMesh);

      // Create arrowhead at anchor point
      const arrowhead = this.#makeArrowhead(bendPoint, anchorPoint, 0x93c5fd);
      arrowhead.userData = { isLeaderLine: true, labelIdx };
      group.add(arrowhead);

    } catch (e) {
      console.warn('Error creating leader line to text:', e);
    }
  }

  #createLeaderLineToDraggedText(group, anchorPoint, textPosition, labelIdx, ann) {
    try {
      // Remove any existing leader lines for this annotation
      const existingLines = group.children.filter(child =>
        child.userData && child.userData.isLeaderLine && child.userData.labelIdx === labelIdx
      );
      existingLines.forEach(line => group.remove(line));

      // Calculate 20 pixels in world space for the horizontal offset
      const pixelOffset = this.#_screenSizeWorld(20) || 0.1;

      // Get camera right vector for horizontal direction
      const camera = this.viewer?.camera;
      const horizontal = new THREE.Vector3();

      if (camera) {
        // Get camera's right vector (perpendicular to view direction)
        const cameraDirection = new THREE.Vector3();
        camera.getWorldDirection(cameraDirection);
        const up = new THREE.Vector3(0, 1, 0);
        horizontal.crossVectors(up, cameraDirection).normalize();

        // Determine which way to extend the horizontal line based on text position relative to anchor
        const toAnchor = new THREE.Vector3().subVectors(anchorPoint, textPosition);
        const rightDot = horizontal.dot(toAnchor);

        if (rightDot > 0) {
          horizontal.multiplyScalar(pixelOffset); // Extend right toward anchor
        } else {
          horizontal.multiplyScalar(-pixelOffset); // Extend left toward anchor
        }
      } else {
        // Fallback if no camera
        const toAnchor = new THREE.Vector3().subVectors(anchorPoint, textPosition);
        horizontal.set(toAnchor.x > 0 ? pixelOffset : -pixelOffset, 0, 0);
      }

      // Calculate bend point (end of horizontal segment)
      const bendPoint = new THREE.Vector3().addVectors(textPosition, horizontal);

      // Create horizontal line from text position
      const horizontalLine = new THREE.BufferGeometry().setFromPoints([textPosition, bendPoint]);
      const horizontalMat = new THREE.LineBasicMaterial({ color: 0x93c5fd });
      horizontalMat.depthTest = false;
      horizontalMat.depthWrite = false;
      horizontalMat.transparent = true;
      const horizontalMesh = new THREE.Line(horizontalLine, horizontalMat);
      horizontalMesh.userData = { isLeaderLine: true, labelIdx };
      group.add(horizontalMesh);

      // Create angled line from bend point to anchor
      const angledLine = new THREE.BufferGeometry().setFromPoints([bendPoint, anchorPoint]);
      const angledMat = new THREE.LineBasicMaterial({ color: 0x93c5fd });
      angledMat.depthTest = false;
      angledMat.depthWrite = false;
      angledMat.transparent = true;
      const angledMesh = new THREE.Line(angledLine, angledMat);
      angledMesh.userData = { isLeaderLine: true, labelIdx };
      group.add(angledMesh);

      // Create arrowhead at anchor point
      const arrowhead = this.#makeArrowhead(bendPoint, anchorPoint, 0x93c5fd);
      arrowhead.userData = { isLeaderLine: true, labelIdx };
      group.add(arrowhead);

    } catch (e) {
      console.warn('Error creating leader line to dragged text:', e);
    }
  }

  #focusAnnotationDialog(idx, ann, e) {
    e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation();

    // Find and focus the text field in the annotation dialog
    try {
      // Find the text input for this annotation in the dialog
      const textInput = document.querySelector(`#gfu_text_${idx}, input[data-annotation-idx="${idx}"][data-field="text"], textarea[data-annotation-idx="${idx}"][data-field="text"]`);
      if (textInput) {
        textInput.focus();
        textInput.select();
      } else {
        // Fallback: look for any text input in the expanded annotation
        const annotationElement = document.querySelector(`.pmi-acc-item:nth-child(${idx + 1})`);
        if (annotationElement) {
          const textField = annotationElement.querySelector('input[type="text"], textarea');
          if (textField) {
            textField.focus();
            textField.select();
          }
        }
      }
    } catch (error) {
      console.warn('Could not focus annotation dialog text field:', error);
    }
  }

  #startLabelDrag(idx, ann, e) {
    e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation();
    try { if (this.viewer?.controls) this.viewer.controls.enabled = false; } catch { }
    const v = this.viewer; const cam = v?.camera; if (!cam) return;

    // For dimensions, calculate offset distance when dragging
    if (ann.type === 'dim') {
      // Get dimension points
      const pts = this.#computeDimPoints(ann);
      if (!pts || !pts.p0 || !pts.p1) return;
      const p0 = pts.p0, p1 = pts.p1;

      // Dimension line direction and perpendicular
      const normal = this.#_alignNormal(ann?.alignment || 'view', ann);
      const dir = new THREE.Vector3().subVectors(p1, p0).normalize();
      const t = new THREE.Vector3().crossVectors(normal, dir).normalize();

      // Current offset (or default)
      let currentOffset = Number(ann?.offset);
      if (!Number.isFinite(currentOffset)) currentOffset = this.#_screenSizeWorld(20);

      const onMove = (ev) => {
        try {
          const rect = v.renderer.domElement.getBoundingClientRect();
          const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -(((ev.clientY - rect.top) / rect.height) * 2 - 1));
          v.raycaster.setFromCamera(ndc, cam);

          // Project mouse ray onto the plane containing the dimension line
          const dimMid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, dimMid);
          const rayPoint = new THREE.Vector3();

          if (v.raycaster.ray.intersectPlane(plane, rayPoint)) {
            // Calculate distance from dimension line to mouse position
            const toMouse = new THREE.Vector3().subVectors(rayPoint, dimMid);
            const offsetDist = toMouse.dot(t); // Signed distance along perpendicular

            // Update annotation offset
            ann.offset = offsetDist;

            // Update label position to follow mouse
            ann.labelWorld = { x: rayPoint.x, y: rayPoint.y, z: rayPoint.z };
            const el = this._labelMap.get(idx);
            if (el) this.#positionLabel(el, rayPoint);

            // Rebuild the dimension graphics with new offset
            this.#rebuildAnnotationObjects();
          }
        } catch { }
      };

      const onUp = (ev) => {
        try { window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); } catch { }
        try { if (this.viewer?.controls) this.viewer.controls.enabled = (this._tool === 'select'); } catch { }
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch { }
        // Refresh the annotation list to show updated offset value
        this.#renderAnnList();
        // Persist immediately so the change survives a Finish or mode exit
        try { this.#_persistView(false); } catch { }
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    } else if (ann.type === 'angle') {
      // For angle annotations, drag the label constrained to the selected plane
      const elements = this.#computeAngleElements(ann);
      if (!elements || !elements.dirA || !elements.dirB) return;

      // Plane for dragging: explicit reference plane if present, else alignment
      const planeNormal = (elements.plane && elements.plane.lengthSq() > 0)
        ? elements.plane.clone().normalize()
        : this.#_alignNormal(ann?.alignment || 'view', ann);

      // Determine a stable vertex as the intersection of projected lines on the plane
      const planeRefObj = (ann.planeRefName && this.viewer?.partHistory?.scene?.getObjectByName(ann.planeRefName)) || null;
      const planePoint = planeRefObj ? (this.#objectRepresentativePoint(planeRefObj) || new THREE.Vector3())
                                     : (elements.pointA && elements.pointB ? new THREE.Vector3().addVectors(elements.pointA, elements.pointB).multiplyScalar(0.5) : new THREE.Vector3());

      const projPointA = this.#projectPointToPlane(elements.pointA, planePoint, planeNormal);
      const projPointB = this.#projectPointToPlane(elements.pointB, planePoint, planeNormal);
      const projDirA = elements.dirA.clone().projectOnPlane(planeNormal).normalize();
      const projDirB = elements.dirB.clone().projectOnPlane(planeNormal).normalize();
      let vertex = this.#calculatePlaneLineIntersection(projPointA, projDirA, projPointB, projDirB, planePoint, planeNormal);
      if (!vertex) vertex = new THREE.Vector3().addVectors(projPointA, projPointB).multiplyScalar(0.5);

      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, vertex);

      const onMove = (ev) => {
        try {
          const rect = v.renderer.domElement.getBoundingClientRect();
          const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -(((ev.clientY - rect.top) / rect.height) * 2 - 1));
          v.raycaster.setFromCamera(ndc, cam);
          const rayPoint = new THREE.Vector3();

          if (v.raycaster.ray.intersectPlane(plane, rayPoint)) {
            // Update label position
            ann.labelWorld = { x: rayPoint.x, y: rayPoint.y, z: rayPoint.z };
            const el = this._labelMap.get(idx);
            if (el) this.#positionLabel(el, rayPoint);

            // Update offset based on distance from vertex
            const distance = rayPoint.distanceTo(vertex);
            ann.offset = distance;

            // Rebuild the angle graphics with new position
            this.#rebuildAnnotationObjects();
          }
        } catch { }
      };

      const onUp = (ev) => {
        try { window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); } catch { }
        try { if (this.viewer?.controls) this.viewer.controls.enabled = (this._tool === 'select'); } catch { }
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch { }
        // Refresh the annotation list to show updated offset value
        this.#renderAnnList();
        try { this.#_persistView(false); } catch { }
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    } else if (ann.type === 'radial') {
      // For radial dimensions, drag adjusts the offset and label position
      const radialData = this.#computeRadialPoints(ann);
      if (!radialData || !radialData.center || !radialData.radiusPoint) return;

      // Use a plane perpendicular to the radial direction
      const radialDir = new THREE.Vector3().subVectors(radialData.radiusPoint, radialData.center).normalize();
      const normal = this.#_alignNormal(ann?.alignment || 'view', ann);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, radialData.radiusPoint);

      const onMove = (ev) => {
        try {
          const rect = v.renderer.domElement.getBoundingClientRect();
          const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -(((ev.clientY - rect.top) / rect.height) * 2 - 1));
          v.raycaster.setFromCamera(ndc, cam);
          const rayPoint = new THREE.Vector3();

          if (v.raycaster.ray.intersectPlane(plane, rayPoint)) {
            // Update label position
            ann.labelWorld = { x: rayPoint.x, y: rayPoint.y, z: rayPoint.z };
            const el = this._labelMap.get(idx);
            if (el) this.#positionLabel(el, rayPoint);

            // Calculate offset as distance from radius point in radial direction
            const toMouse = new THREE.Vector3().subVectors(rayPoint, radialData.radiusPoint);
            const offsetDist = toMouse.dot(radialDir);
            ann.offset = offsetDist;

            // Rebuild the radial graphics with new position
            this.#rebuildAnnotationObjects();
          }
        } catch { }
      };

      const onUp = (ev) => {
        try { window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); } catch { }
        try { if (this.viewer?.controls) this.viewer.controls.enabled = (this._tool === 'select'); } catch { }
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch { }
        // Refresh the annotation list to show updated offset value
        this.#renderAnnList();
        try { this.#_persistView(false); } catch { }
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    } else {
      // For other non-dimension annotations (notes, leaders), use original behavior
      const normal = (() => {
        const mode = ann.alignment || 'view';
        if (mode === 'XY') return new THREE.Vector3(0, 0, 1);
        if (mode === 'YZ') return new THREE.Vector3(1, 0, 0);
        if (mode === 'ZX') return new THREE.Vector3(0, 1, 0);
        const n = new THREE.Vector3(); cam.getWorldDirection(n); return n; // view plane
      })();
      // For leaders, use textPosition; for notes, use labelWorld
      const point = ann.type === 'leader' && ann.textPosition ?
        new THREE.Vector3(ann.textPosition.x, ann.textPosition.y, ann.textPosition.z) :
        ann.labelWorld ? new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z) : null;
      const planePoint = point || new THREE.Vector3();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, planePoint);

      const onMove = (ev) => {
        try {
          const rect = v.renderer.domElement.getBoundingClientRect();
          const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -(((ev.clientY - rect.top) / rect.height) * 2 - 1));
          v.raycaster.setFromCamera(ndc, cam);
          const out = new THREE.Vector3();
          if (v.raycaster.ray.intersectPlane(plane, out)) {
            // For leaders, update textPosition; for notes, use labelWorld
            if (ann.type === 'leader') {
              ann.textPosition = { x: out.x, y: out.y, z: out.z };
              // Also rebuild the 3D objects since leader line needs to update
              this.#rebuildAnnotationObjects();
            } else {
              ann.labelWorld = { x: out.x, y: out.y, z: out.z };
            }
            const el = this._labelMap.get(idx); if (el) this.#positionLabel(el, out);
          }
        } catch { }
      };

      const onUp = (ev) => {
        try { window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); } catch { }
        try { if (this.viewer?.controls) this.viewer.controls.enabled = (this._tool === 'select'); } catch { }
        try { ev.preventDefault(); ev.stopImmediatePropagation?.(); ev.stopPropagation(); } catch { }
        try { this.#_persistView(false); } catch { }
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    }
  }

  #makeArrowhead(fromPos, toPos, color = 0x333333) {
    const direction = new THREE.Vector3().subVectors(toPos, fromPos).normalize();
    const arrowLength = 0.12;
    const arrowWidth = 0.04;

    // Create arrowhead geometry (cone pointing along +Y axis initially)
    const arrowGeometry = new THREE.ConeGeometry(arrowWidth, arrowLength, 8);
    const arrowMaterial = new THREE.MeshBasicMaterial({ color });
    arrowMaterial.depthTest = false;
    arrowMaterial.depthWrite = false;
    arrowMaterial.transparent = true;

    const arrowMesh = new THREE.Mesh(arrowGeometry, arrowMaterial);

    // Position arrowhead near the target point (slightly offset along the line)
    const offset = direction.clone().multiplyScalar(arrowLength * 0.5);
    arrowMesh.position.copy(toPos).sub(offset);

    // Create a quaternion to rotate from default cone orientation (0,1,0) to line direction
    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    arrowMesh.setRotationFromQuaternion(quaternion);

    return arrowMesh;
  }


  #drawDimension(group, ann, p0, p1) {
    try {
      const color = 0x10b981; // teal
      const normal = this.#_alignNormal(ann?.alignment || 'view', ann);
      const dir = new THREE.Vector3().subVectors(p1, p0).normalize();
      const t = new THREE.Vector3().crossVectors(normal, dir).normalize();

      // Offset and extension lines
      let off = Number(ann?.offset);
      if (!Number.isFinite(off)) off = this.#_screenSizeWorld(20);
      const p0o = p0.clone().addScaledVector(t, off);
      const p1o = p1.clone().addScaledVector(t, off);
      if (ann?.showExt !== false && off !== 0) {
        group.add(this.#_makeOverlayLine(p0, p0o, color));
        group.add(this.#_makeOverlayLine(p1, p1o, color));
      }

      // Main line on offset
      const mainLine = this.#_makeOverlayLine(p0o, p1o, color);
      group.add(mainLine);

      // Arrowheads on offset line (cone style, like radial)
      const arrowLength = this.#_screenSizeWorld(12);
      const arrowWidth = this.#_screenSizeWorld(4);
      // p0 arrow points inward along -dir
      this.#addArrowhead(group, p0o, dir.clone().negate().normalize(), arrowLength, arrowWidth, color);
      // p1 arrow points inward along +dir
      this.#addArrowhead(group, p1o, dir.clone().normalize(), arrowLength, arrowWidth, color);

      // If user dragged the label away from the offset line, draw a short red extension
      try {
        if (ann.labelWorld) {
          const labelPos = new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
          const lineLen = p0o.distanceTo(p1o);
          if (lineLen > 1e-6) {
            const toLabel = labelPos.clone().sub(p0o);
            const along = toLabel.dot(dir); // signed distance along line
            const clamped = Math.max(0, Math.min(lineLen, along));
            const nearest = p0o.clone().addScaledVector(dir, clamped);
            const perpDist = labelPos.distanceTo(nearest);
            const threshold = this.#_screenSizeWorld(6);
            if (perpDist > threshold) {
              // Draw extension in the same style/color as the dimension lines
              group.add(this.#_makeOverlayLine(nearest, labelPos, color));
            }
          }
        }
      } catch {}

      // Adjust label default position to offset line midpoint
      try {
        if (!ann.labelWorld) {
          const mid = new THREE.Vector3().addVectors(p0o, p1o).multiplyScalar(0.5).addScaledVector(t, this.#_screenSizeWorld(6));
          // Update overlay immediately
          const dec = Number.isFinite(ann.decimals) ? ann.decimals : (this._opts.dimDecimals | 0);
          const val = p0.distanceTo(p1);
          this.#updateDimLabel(-1, `${val.toFixed(dec)}`, mid, ann); // idx not used for default preview here
        }
      } catch { }
    } catch { }
  }

  #_makeOverlayLine(a, b, color) {
    const geom = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
    const mat = new THREE.LineBasicMaterial({ color });
    mat.depthTest = false; mat.depthWrite = false; mat.transparent = true;
    return new THREE.Line(geom, mat);
  }

  #_makeOverlaySphere(size, color) {
    const g = new THREE.SphereGeometry(size, 12, 8);
    const m = new THREE.MeshBasicMaterial({ color });
    m.depthTest = false; m.depthWrite = false; m.transparent = true;
    return new THREE.Mesh(g, m);
  }

  #_screenSizeWorld(pixels) {
    try {
      const rect = this.viewer?.renderer?.domElement?.getBoundingClientRect?.() || { width: 800, height: 600 };
      const wpp = this.#worldPerPixel(this.viewer.camera, rect.width, rect.height);
      return Math.max(0.0001, wpp * (pixels || 1));
    } catch { return 0.01; }
  }

  #_alignNormal(alignment, ann) {
    // If a face/plane reference is provided, use its world normal
    try {
      const name = ann?.planeRefName || '';
      if (name) {
        const scene = this.viewer?.partHistory?.scene;
        const obj = scene?.getObjectByName(name);
        if (obj) {
          // Face average normal → world
          if (obj.type === 'FACE' && typeof obj.getAverageNormal === 'function') {
            const local = obj.getAverageNormal().clone();
            const nm = new THREE.Matrix3(); nm.getNormalMatrix(obj.matrixWorld);
            return local.applyMatrix3(nm).normalize();
          }
          // PLANE or any Object3D: attempt to use its Z axis as normal
          const w = new THREE.Vector3(0, 0, 1);
          try { obj.updateMatrixWorld(true); w.applyMatrix3(new THREE.Matrix3().getNormalMatrix(obj.matrixWorld)); } catch { }
          if (w.lengthSq()) return w.normalize();
        }
      }
    } catch { }
    // Fallback: explicit axis or camera view direction
    const mode = String(alignment || 'view').toLowerCase();
    if (mode === 'xy') return new THREE.Vector3(0, 0, 1);
    if (mode === 'yz') return new THREE.Vector3(1, 0, 0);
    if (mode === 'zx') return new THREE.Vector3(0, 1, 0);
    const n = new THREE.Vector3();
    try { this.viewer?.camera?.getWorldDirection?.(n); } catch { }
    return n.lengthSq() ? n : new THREE.Vector3(0, 0, 1);
  }

  #drawAngle(group, ann, elements) {
    try {
      const color = 0xf59e0b; // amber

      // 1) Resolve plane and build in-plane lines for A and B
      const { n: N, p: P } = this.#_resolveAnglePlane(ann, elements);
      const lineA = this.#_lineInPlaneForElementRef(ann.elementARefName, N, P);
      const lineB = this.#_lineInPlaneForElementRef(ann.elementBRefName, N, P);
      if (!lineA || !lineB) return;

      // 2) Build a 2D basis for the plane, project everything to 2D
      const basis = this.#_planeBasis(N, lineA.d);
      const A_p = this.#_to2D(lineA.p, P, basis);
      const B_p = this.#_to2D(lineB.p, P, basis);
      const A_d = this.#_dirTo2D(lineA.d, basis).normalize();
      const B_d = this.#_dirTo2D(lineB.d, basis).normalize();

      // 3) Vertex in pure 2D
      let V2 = this.#_intersectLines2D(A_p, A_d, B_p, B_d);
      if (!V2) V2 = new THREE.Vector2().addVectors(A_p, B_p).multiplyScalar(0.5);

      // 4) Radius in 2D
      let R;
      if (ann.labelWorld) {
        const Lw = new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z);
        const L2 = this.#_to2D(this.#projectPointToPlane(Lw, P, N), P, basis);
        R = L2.clone().sub(V2).length();
      }
      if (!Number.isFinite(R) || R <= 0) R = Number(ann.offset);
      if (!Number.isFinite(R) || R <= 0) R = this.#_screenSizeWorld(40);

      // 5) Arc angle/orientation in 2D
      const dot = Math.max(-1, Math.min(1, A_d.dot(B_d)));
      const crossZ = A_d.x * B_d.y - A_d.y * B_d.x;
      const signed = Math.atan2(crossZ, dot); // [-pi, pi]
      const base = Math.abs(signed);          // small angle
      const useReflex = Boolean(ann.useReflexAngle);
      const sweep = useReflex ? (2 * Math.PI - base) : base;
      const rotSign = useReflex ? -Math.sign(signed || 1) : Math.sign(signed || 1);

      // 6) Build arc in 2D then lift to 3D
      const steps = Math.max(24, Math.floor(sweep * 48));
      const points3 = [];
      for (let i = 0; i <= steps; i++) {
        const t = (sweep * i / steps) * rotSign;
        const ct = Math.cos(t), st = Math.sin(t);
        const dir2 = new THREE.Vector2(A_d.x * ct - A_d.y * st, A_d.x * st + A_d.y * ct);
        const p2 = new THREE.Vector2(V2.x + dir2.x * R, V2.y + dir2.y * R);
        points3.push(this.#_from2D(p2, P, basis));
      }
      // Snap the last arc point exactly to B direction to avoid small gaps
      if (points3.length > 0) {
        const end2 = new THREE.Vector2(V2.x + B_d.x * R, V2.y + B_d.y * R);
        points3[points3.length - 1] = this.#_from2D(end2, P, basis);
      }
      for (let i = 0; i < points3.length - 1; i++) group.add(this.#_makeOverlayLine(points3[i], points3[i + 1], color));

      // Arrowheads at arc ends (cone style)
      try {
        const arrowLength = this.#_screenSizeWorld(12);
        const arrowWidth = this.#_screenSizeWorld(4);
        if (points3.length >= 2) {
          // Start arrow: reversed (flip tangent)
          const startTip = points3[0];
          const startTan = points3[0].clone().sub(points3[1]).normalize();
          this.#addArrowhead(group, startTip, startTan, arrowLength, arrowWidth, color);

          // End arrow: reversed relative to previous fix (use forward tangent)
          const endTip = points3[points3.length - 1];
          const endTan = points3[points3.length - 1].clone().sub(points3[points3.length - 2]).normalize();
          this.#addArrowhead(group, endTip, endTan, arrowLength, arrowWidth, color);
        }
      } catch {}

      // 7) Legs and stubs in 2D lifted to 3D
      const ext = Math.max(this.#_screenSizeWorld(10), R * 1.05);
      const stub = this.#_screenSizeWorld(12);
      const V3 = this.#_from2D(V2, P, basis);
      const A1 = this.#_from2D(new THREE.Vector2(V2.x + A_d.x * ext, V2.y + A_d.y * ext), P, basis);
      const B1 = this.#_from2D(new THREE.Vector2(V2.x + B_d.x * ext, V2.y + B_d.y * ext), P, basis);
      const A0 = this.#_from2D(new THREE.Vector2(V2.x - A_d.x * stub, V2.y - A_d.y * stub), P, basis);
      const B0 = this.#_from2D(new THREE.Vector2(V2.x - B_d.x * stub, V2.y - B_d.y * stub), P, basis);
      group.add(this.#_makeOverlayLine(V3, A1, color));
      group.add(this.#_makeOverlayLine(V3, B1, color));
      group.add(this.#_makeOverlayLine(V3, A0, color));
      group.add(this.#_makeOverlayLine(V3, B0, color));
    } catch (e) {
      console.warn('Error drawing angle annotation:', e);
    }
  }

  #drawRadialDimension(group, ann, center, radiusPoint, radiusValue, planeNormal = null) {
    try {
      const color = 0xff6b35; // Orange color for better visibility
      
      // Calculate direction from center to radius point
      let direction = new THREE.Vector3().subVectors(radiusPoint, center);
      const distance = direction.length();
      
      // Safety check: if points are too close, use a default direction
      if (distance < 0.001) {
        direction = new THREE.Vector3(1, 0, 0);
        // Adjust radius point to be at proper distance
        radiusPoint = center.clone().addScaledVector(direction, radiusValue);
      } else {
        direction.normalize();
      }
      
      // Apply plane constraint - prioritize user-selected plane reference
      let constraintNormal = null;
      
      // First priority: explicit plane reference selected by user
      if (ann.planeRefName) {
        const planeObj = this.viewer?.partHistory?.scene?.getObjectByName(ann.planeRefName);
        if (planeObj) {
          constraintNormal = this.#getElementDirection(planeObj);
          console.log('Using user-selected plane reference:', ann.planeRefName, 'normal:', constraintNormal);
        }
      }
      
      // Second priority: alignment system
      if (!constraintNormal) {
        constraintNormal = this.#_alignNormal(ann?.alignment || 'view', ann);
        console.log('Using alignment-based plane constraint, normal:', constraintNormal);
      }
      
      // Third priority: extracted geometry plane
      if (!constraintNormal && planeNormal && planeNormal.length() > 0.1) {
        constraintNormal = planeNormal;
        console.log('Using geometry-extracted plane constraint, normal:', constraintNormal);
      }
      
      // Apply the constraint
      if (constraintNormal && constraintNormal.length() > 0.1) {
        console.log('Applying plane constraint. Original direction:', direction);
        
        // Project the direction onto the constraint plane
        const projectedDirection = direction.clone().projectOnPlane(constraintNormal).normalize();
        
        console.log('Projected direction:', projectedDirection, 'length:', projectedDirection.length());
        
        // Update direction to be constrained to the plane
        if (projectedDirection.length() > 0.1) {
          direction = projectedDirection;
          // Recalculate radius point on the constrained plane
          radiusPoint = center.clone().addScaledVector(direction, radiusValue);
          console.log('Applied plane constraint successfully');
        }
      } else {
        console.log('No plane constraint applied');
      }
      
      // Common arrow dimensions
      const arrowLength = this.#_screenSizeWorld(12);
      const arrowWidth = this.#_screenSizeWorld(4);
      
      if (ann.displayStyle === 'diameter') {
        // DIAMETER MODE: Single line from one side through center to text label
        
        // Get the actual label position
        const labelPos = ann.labelWorld ? new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z) : null;
        
        let lineDirection, lineEndPoint;
        
        if (labelPos) {
          // Calculate direction from center to label
          lineDirection = new THREE.Vector3().subVectors(labelPos, center).normalize();
          
          // Apply the same plane constraint to label direction
          if (constraintNormal && constraintNormal.length() > 0.1) {
            const projectedLabelDir = lineDirection.clone().projectOnPlane(constraintNormal).normalize();
            if (projectedLabelDir.length() > 0.1) {
              lineDirection = projectedLabelDir;
            }
          }
          
          // Recalculate label position with constrained direction
          const labelDistance = center.distanceTo(labelPos);
          lineEndPoint = center.clone().addScaledVector(lineDirection, labelDistance);
        } else {
          // Fallback: use the original radial direction
          lineDirection = direction;
          let offsetDistance = Number(ann.offset);
          if (!Number.isFinite(offsetDistance) || offsetDistance === 0) {
            offsetDistance = this.#_screenSizeWorld(50);
          }
          lineEndPoint = center.clone().addScaledVector(lineDirection, radiusValue + Math.abs(offsetDistance));
        }
        
        // Calculate the diameter start point (opposite side of circle from label)
        const diameterStart = center.clone().addScaledVector(lineDirection, -radiusValue);
        
        // Calculate the two circle intersection points
        const circlePoint1 = center.clone().addScaledVector(lineDirection, radiusValue);
        const circlePoint2 = center.clone().addScaledVector(lineDirection, -radiusValue);
        
        // Draw the single diameter line from one side of circle through center to label
        const diameterLine = this.#_makeOverlayLine(diameterStart, lineEndPoint, color);
        diameterLine.material.linewidth = 3;
        group.add(diameterLine);
        
        // Add arrowheads at both circle intersection points
        this.#addArrowhead(group, circlePoint1, lineDirection, arrowLength, arrowWidth, color);
        this.#addArrowhead(group, circlePoint2, lineDirection.clone().negate(), arrowLength, arrowWidth, color);
        
        // Add center point marker
        const centerSize = this.#_screenSizeWorld(6);
        const centerMarker = this.#_makeOverlaySphere(centerSize, 0xff6b35);
        centerMarker.position.copy(center);
        group.add(centerMarker);
        
      } else {
        // RADIUS MODE: Draw line from center to edge with single arrow pointing outward
        
        // Get the actual label position to draw a single line from center to label
        const labelPos = ann.labelWorld ? new THREE.Vector3(ann.labelWorld.x, ann.labelWorld.y, ann.labelWorld.z) : null;
        let lineEndPoint, lineDirection;
        
        if (labelPos) {
          // Calculate direction from center to label for arrowhead alignment
          lineDirection = new THREE.Vector3().subVectors(labelPos, center).normalize();
          
          // Apply the same plane constraint to label direction
          if (constraintNormal && constraintNormal.length() > 0.1) {
            const projectedLabelDir = lineDirection.clone().projectOnPlane(constraintNormal).normalize();
            if (projectedLabelDir.length() > 0.1) {
              lineDirection = projectedLabelDir;
            }
          }
          
          // Recalculate label position with constrained direction
          const labelDistance = center.distanceTo(labelPos);
          lineEndPoint = center.clone().addScaledVector(lineDirection, labelDistance);
        } else {
          // Fallback: extend beyond the circle edge in the radial direction
          let offsetDistance = Number(ann.offset);
          if (!Number.isFinite(offsetDistance) || offsetDistance === 0) {
            offsetDistance = this.#_screenSizeWorld(50);
          }
          lineEndPoint = center.clone().addScaledVector(direction, radiusValue + Math.abs(offsetDistance));
          lineDirection = direction;
        }
        
        // Draw the single radius line from center to the label position
        const radiusLine = this.#_makeOverlayLine(center, lineEndPoint, color);
        radiusLine.material.linewidth = 3;
        group.add(radiusLine);
        
        // Calculate the correct arrowhead position: on the line to the label at radius distance from center
        const arrowheadPosition = center.clone().addScaledVector(lineDirection, radiusValue);
        
        // Add arrowhead at the correct position on the line going to the annotation
        this.#addArrowhead(group, arrowheadPosition, lineDirection, arrowLength, arrowWidth, color);
        
        // Add center point marker
        const centerSize = this.#_screenSizeWorld(6);
        const centerMarker = this.#_makeOverlaySphere(centerSize, 0xff6b35);
        centerMarker.position.copy(center);
        group.add(centerMarker);
      }
      
    } catch (e) {
      console.warn('Error drawing radial dimension:', e);
    }
  }

  // Helper method to create arrowheads using cone geometry
  #addArrowhead(group, tip, direction, arrowLength, arrowWidth, color) {
    try {
      // Create cone geometry for the arrowhead
      const coneGeometry = new THREE.ConeGeometry(arrowWidth, arrowLength, 8);
      const coneMaterial = new THREE.MeshBasicMaterial({ 
        color: color,
        depthTest: false,
        depthWrite: false,
        transparent: true
      });
      
      const arrowCone = new THREE.Mesh(coneGeometry, coneMaterial);
      
      // Position the cone at the tip point, but offset back by half the length
      // so the tip of the cone is at the exact tip point
      const conePosition = tip.clone().addScaledVector(direction, -arrowLength * 0.5);
      arrowCone.position.copy(conePosition);
      
      // Orient the cone to point in the direction
      // The cone's default orientation has its tip pointing up (positive Y)
      // We need to rotate it to point in our desired direction
      const upVector = new THREE.Vector3(0, 1, 0);
      const quaternion = new THREE.Quaternion();
      quaternion.setFromUnitVectors(upVector, direction);
      arrowCone.setRotationFromQuaternion(quaternion);
      
      // Set render order to ensure it's visible
      arrowCone.renderOrder = 9996;
      
      group.add(arrowCone);
      
    } catch (e) {
      console.warn('Error creating arrowhead:', e);
    }
  }

  // Helper method to get a perpendicular vector
  #getPerpendicularVector(direction) {
    const up = new THREE.Vector3(0, 0, 1);
    let perpendicular = new THREE.Vector3().crossVectors(direction, up);
    
    // If direction is parallel to Z, use Y as reference
    if (perpendicular.lengthSq() < 0.01) {
      perpendicular.crossVectors(direction, new THREE.Vector3(0, 1, 0));
    }
    
    return perpendicular.normalize();
  }

  #computeAngleLabelPosition(ann, elements) {
    try {
      // Resolve plane and in-plane lines
      const { n: N, p: P } = this.#_resolveAnglePlane(ann, elements);
      const lineA = this.#_lineInPlaneForElementRef(ann.elementARefName, N, P);
      const lineB = this.#_lineInPlaneForElementRef(ann.elementBRefName, N, P);
      if (!lineA || !lineB) return P.clone();

      // 2D basis and projection
      const basis = this.#_planeBasis(N, lineA.d);
      const A_p = this.#_to2D(lineA.p, P, basis);
      const B_p = this.#_to2D(lineB.p, P, basis);
      const A_d = this.#_dirTo2D(lineA.d, basis).normalize();
      const B_d = this.#_dirTo2D(lineB.d, basis).normalize();
      let V2 = this.#_intersectLines2D(A_p, A_d, B_p, B_d);
      if (!V2) V2 = new THREE.Vector2().addVectors(A_p, B_p).multiplyScalar(0.5);

      // 2D bisector
      let bis2 = new THREE.Vector2().addVectors(A_d, B_d);
      if (bis2.lengthSq() < 1e-10) bis2.set(-A_d.y, A_d.x); else bis2.normalize();
      if (ann.useReflexAngle) bis2.multiplyScalar(-1);

      let off = Number(ann?.offset);
      if (!Number.isFinite(off) || off <= 0) off = this.#_screenSizeWorld(60); else off = off + this.#_screenSizeWorld(20);
      const L2 = new THREE.Vector2(V2.x + bis2.x * off, V2.y + bis2.y * off);
      return this.#_from2D(L2, P, basis);
    } catch (e) {
      console.warn('Error computing angle label position:', e);
      return new THREE.Vector3();
    }
  }

  #cancelTextPositionSelection() {
    // Text position selection no longer needed - method kept for compatibility
    // Leaders now auto-position at target point
  }

  _handlePointerDown(e) {
    // Only left-clicks
    if (e.button !== 0) return;
    // Avoid interfering if clicking overlays
    try {
      const path = e.composedPath?.() || [];
      if (path.some((el) => el === this._uiTopRight || el === this._uiSide || (el?.classList?.contains?.('pmi-side')))) return;
    } catch { }

    // If a feature reference_selection is active, let selection widget handle it
    try { const activeRef = document.querySelector('[active-reference-selection="true"],[active-reference-selection=true]'); if (activeRef) return; } catch { }

    // Text position selection is no longer needed - leaders auto-position at target

    // Legacy reassign via picking (store names)
    if (this._reassign && Number.isFinite(this._reassign.idx)) {
      const pick = this.#pickAnchor(e);
      if (pick && pick.anchor) {
        const ann = this._annotations[this._reassign.idx];
        if (ann) {
          const nm = pick.anchor.type === 'vertex' ? String(pick.anchor.name || '') : (pick.anchor.type === 'edge' ? String(pick.anchor.edgeName || '') : '');
          if (this._reassign.key === 'a') ann.aRefName = nm;
          else if (this._reassign.key === 'b') ann.bRefName = nm;
          else if (this._reassign.key === 'anchor') ann.anchorRefName = nm;
          this._reassign = null;
          this._pdConsumed = true; try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
          this.#renderAnnList(); this.#rebuildAnnotationObjects();
        }
      }
      return;
    }

    // No canvas-based insertion; use the "+" button in the sidebar
    return;

    if (this._tool === 'note') {
      const text = (this._opts.noteText && String(this._opts.noteText)) || prompt('Note text:') || '';
      this._annotations.push({ type: 'note', text, position: { x: world.x, y: world.y, z: world.z } });
      this.#renderAnnList();
      this.#rebuildAnnotationObjects();
      // Deactivate tool after creation -> Select
      this._tool = 'select';
      this.#refreshTopbar(this._uiTopBar);
      this._pdConsumed = true; try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
      return;
    }
    if (this._tool === 'leader') {
      if (!this._pending) {
        const aName = (() => { const an = anchorHit?.anchor; if (!an) return ''; if (an.type === 'vertex') return String(an.name || ''); if (an.type === 'edge') return String(an.edgeName || ''); return ''; })();
        this._pending = { start: world.clone(), anchorName: aName };
        this._pdConsumed = true; try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
        return;
      } else {
        const start = this._pending.start;
        const end = world.clone();
        const anchorRefName = this._pending.anchorName || (() => { const an = anchorHit?.anchor; if (!an) return ''; if (an.type === 'vertex') return String(an.name || ''); if (an.type === 'edge') return String(an.edgeName || ''); return ''; })();
        this._annotations.push({ type: 'leader', anchorRefName, start: this.#v3(start), end: this.#v3(end), text: (this._opts.leaderText && String(this._opts.leaderText)) || '' });
        this._pending = null;
        this.#renderAnnList();
        this.#rebuildAnnotationObjects();
        // Deactivate tool after creation -> Select
        this._tool = 'select';
        this.#refreshTopbar(this._uiTopBar);
        this._pdConsumed = true; try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
      }
      return;
    }
    if (this._tool === 'dim') {
      if (!this._pending) {
        // Store only names via reference_selection semantics
        const aName = (() => { const an = anchorHit?.anchor; if (!an) return ''; if (an.type === 'vertex') return String(an.name || ''); if (an.type === 'edge') return String(an.edgeName || ''); return ''; })();
        this._pending = { p0: world.clone(), aName };
        this._pdConsumed = true; try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
        return;
      } else {
        const p0 = this._pending.p0;
        const p1 = world.clone();
        const aName = this._pending.aName || (() => { const an = anchorHit?.anchor; if (!an) return ''; if (an.type === 'vertex') return String(an.name || ''); if (an.type === 'edge') return String(an.edgeName || ''); return ''; })();
        const bName = (() => { const an = anchorHit?.anchor; if (!an) return ''; if (an.type === 'vertex') return String(an.name || ''); if (an.type === 'edge') return String(an.edgeName || ''); return ''; })();
        const value = p0.distanceTo(p1);
        this._annotations.push({ type: 'dim', aRefName: aName, bRefName: bName, p0: this.#v3(p0), p1: this.#v3(p1), value });
        this._pending = null;
        this.#renderAnnList();
        this.#rebuildAnnotationObjects();
        // Deactivate tool after creation -> Select
        this._tool = 'select';
        this.#refreshTopbar(this._uiTopBar);
        this._pdConsumed = true; try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
      }
      return;
    }

  }

  #v3(v) { return { x: v.x, y: v.y, z: v.z }; }

  #anchorToString(a) {
    if (!a) return '';
    try { if (a.type === 'vertex') return `Vertex ${a.name || a.vertexId}`; if (a.type === 'edge') return `Edge ${a.edgeName || a.edgeId} @ ${(+a.t).toFixed(3)}`; } catch { }
    return '';
  }

  // Convert legacy annotation shapes to anchor-based ones (in-memory only)
  #normalizeAnnotation(a) {
    try {
      if (!a || typeof a !== 'object') return a;
      if (a.type === 'leader') {
        if (!a.anchor && a.start) {
          // Attempt to map start to nearest edge point fraction
          const near = this.#nearestEdgeAnchor(new THREE.Vector3(a.start.x || 0, a.start.y || 0, a.start.z || 0));
          if (near) a.anchor = near;
        }
      } else if (a.type === 'dim') {
        if (!a.a && a.p0) {
          const near = this.#nearestEdgeAnchor(new THREE.Vector3(a.p0.x || 0, a.p0.y || 0, a.p0.z || 0));
          if (near) a.a = near;
        }
        if (!a.b && a.p1) {
          const near = this.#nearestEdgeAnchor(new THREE.Vector3(a.p1.x || 0, a.p1.y || 0, a.p1.z || 0));
          if (near) a.b = near;
        }
      }
    } catch { }
    return a;
  }

  // Return an anchor ref near a world point by scanning edges/vertices
  #nearestEdgeAnchor(world) {
    try {
      const v = this.viewer;
      const edges = [];
      v.scene.traverse((obj) => { if (obj && obj.type === 'EDGE' && obj.visible !== false) edges.push(obj); });
      let best = null, bestD = Infinity;
      for (const e of edges) {
        const info = this.#edgeFractionAtWorld(e, world);
        if (info && info.dist < bestD) { best = { type: 'edge', edgeId: e.id, edgeName: e.name || null, solidName: e.parent?.name || null, t: info.t }; bestD = info.dist; }
      }
      if (best) return best;
    } catch { }
    return null;
  }

  // Hit-test for anchor: prefer VERTEX, else EDGE at fraction along length
  #pickAnchor(e) {
    const v = this.viewer;
    if (!v) return null;
    // First, try vertices via raycast
    try {
      const rect = v.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -(((e.clientY - rect.top) / rect.height) * 2 - 1),
      );
      v.raycaster.setFromCamera(ndc, v.camera);
      // include Points children; we'll walk up to VERTEX parents
      const targets = [];
      v.scene.traverse((obj) => { if (obj && (obj.type === 'VERTEX' || obj.isPoints) && obj.visible !== false) targets.push(obj); });
      const hits = targets.length ? v.raycaster.intersectObjects(targets, true) : [];
      if (hits && hits.length) {
        let obj = hits[0].object;
        while (obj && obj.type !== 'VERTEX' && obj.parent) obj = obj.parent;
        if (obj && obj.type === 'VERTEX') {
          const w = obj.getWorldPosition(new THREE.Vector3());
          return { anchor: { type: 'vertex', vertexId: obj.id, name: obj.name || null, solidName: obj.parent?.name || null }, world: w };
        }
      }
    } catch { }

    // Next, try edges using a generous Line/Line2 threshold
    try {
      const rect = v.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -(((e.clientY - rect.top) / rect.height) * 2 - 1),
      );
      v.raycaster.setFromCamera(ndc, v.camera);
      try {
        const { width, height } = { width: rect.width, height: rect.height };
        const wpp = this.#worldPerPixel(v.camera, width, height);
        v.raycaster.params.Line = v.raycaster.params.Line || {};
        v.raycaster.params.Line.threshold = Math.max(0.05, wpp * 6);
        const dpr = (window.devicePixelRatio || 1);
        v.raycaster.params.Line2 = v.raycaster.params.Line2 || {};
        v.raycaster.params.Line2.threshold = Math.max(1, 2 * dpr);
      } catch { }
      const edges = [];
      v.scene.traverse((obj) => { if (obj && obj.type === 'EDGE' && obj.visible !== false) edges.push(obj); });
      const hits = edges.length ? v.raycaster.intersectObjects(edges, true) : [];
      if (hits && hits.length) {
        const hit = hits[0];
        const edge = hit.object;
        const info = this.#edgeFractionAtWorld(edge, hit.point);
        if (info) {
          return { anchor: { type: 'edge', edgeId: edge.id, edgeName: edge.name || null, solidName: edge.parent?.name || null, t: info.t }, world: info.point };
        }
      }
    } catch { }
    return null;
  }

  // Compute closest fraction t along EDGE polyline to a world point
  #edgeFractionAtWorld(edge, worldPoint) {
    try {
      const pts = edge.points(true);
      if (!Array.isArray(pts) || pts.length < 2) return null;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), p = worldPoint.clone();
      let total = 0, best = { t: 0, dist: Infinity, point: pts[0] };
      let accum = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        a.set(pts[i].x, pts[i].y, pts[i].z);
        b.set(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
        const segLen = a.distanceTo(b) || 1e-12;
        // project p onto segment ab
        const ab = b.clone().sub(a);
        const ap = p.clone().sub(a);
        let t = ab.dot(ap) / (segLen * segLen);
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const q = a.clone().addScaledVector(ab, t);
        const d = q.distanceTo(p);
        if (d < best.dist) {
          const tTotal = (accum + t * segLen);
          best = { t: tTotal, dist: d, point: { x: q.x, y: q.y, z: q.z } };
        }
        accum += segLen; total += segLen;
      }
      if (total <= 1e-9) return null;
      return { t: best.t / total, dist: best.dist, point: best.point };
    } catch { return null; }
  }

  // Convert anchor ref to current world position
  #resolveAnchorToWorld(anchor) {
    if (!anchor || typeof anchor !== 'object') return null;
    try {
      if (anchor.type === 'edge') {
        let edge = this.viewer?.partHistory?.scene?.getObjectById(anchor.edgeId);
        if (!edge || edge.type !== 'EDGE') {
          // Fallback by name chain
          const scene = this.viewer?.partHistory?.scene;
          if (scene && anchor.solidName) {
            const solid = scene.getObjectByName(anchor.solidName);
            if (solid) {
              let found = null; solid.traverse((o) => { if (!found && o.type === 'EDGE' && o.name === anchor.edgeName) found = o; });
              if (found) edge = found;
            }
          }
          if ((!edge || edge.type !== 'EDGE') && anchor.edgeName) {
            let found = null; this.viewer?.partHistory?.scene?.traverse((o) => { if (!found && o.type === 'EDGE' && o.name === anchor.edgeName) found = o; });
            if (found) edge = found;
          }
        }
        if (edge && edge.type === 'EDGE') {
          const pts = edge.points(true);
          if (!Array.isArray(pts) || pts.length < 2) return null;
          // sample by length fraction
          const t = Math.min(1, Math.max(0, Number(anchor.t || 0)));
          const res = this.#pointAtPolylineFraction(pts, t);
          return new THREE.Vector3(res.x, res.y, res.z);
        }
      } else if (anchor.type === 'vertex') {
        let vert = this.viewer?.partHistory?.scene?.getObjectById(anchor.vertexId);
        if (!vert || vert.type !== 'VERTEX') {
          const scene = this.viewer?.partHistory?.scene;
          if (scene && anchor.name) {
            let found = null; scene.traverse((o) => { if (!found && o.type === 'VERTEX' && o.name === anchor.name) found = o; });
            if (found) vert = found;
          }
        }
        if (vert && vert.type === 'VERTEX') {
          return vert.getWorldPosition(new THREE.Vector3());
        }
      }
    } catch { }
    return null;
  }

  #pointAtPolylineFraction(pts, t) {
    // pts: array of {x,y,z} in order; t in [0,1]
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    let total = 0; const segLens = [];
    for (let i = 0; i < pts.length - 1; i++) { a.set(pts[i].x, pts[i].y, pts[i].z); b.set(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z); const L = a.distanceTo(b); segLens.push(L); total += L; }
    if (total <= 1e-12) return pts[0];
    let target = t * total; let accum = 0;
    for (let i = 0; i < segLens.length; i++) {
      const L = segLens[i];
      if (accum + L >= target) {
        const localT = (target - accum) / (L || 1);
        a.set(pts[i].x, pts[i].y, pts[i].z); b.set(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
        return { x: a.x + (b.x - a.x) * localT, y: a.y + (b.y - a.y) * localT, z: a.z + (b.z - a.z) * localT };
      }
      accum += L;
    }
    const last = pts[pts.length - 1];
    return { x: last.x, y: last.y, z: last.z };
  }

  #measureDimValue(a) {
    try {
      const pts = this.#computeDimPoints(a);
      if (pts && pts.p0 && pts.p1) return pts.p0.distanceTo(pts.p1);
    } catch { }
    return null;
  }

  #measureAngleValue(a) {
    try {
      const elements = this.#computeAngleElements(a);
      if (!elements) return null;

      const { n: N, p: P } = this.#_resolveAnglePlane(a, elements);
      const lineA = this.#_lineInPlaneForElementRef(a.elementARefName, N, P);
      const lineB = this.#_lineInPlaneForElementRef(a.elementBRefName, N, P);
      if (!lineA || !lineB) return null;

      const basis = this.#_planeBasis(N, lineA.d);
      const dA2 = this.#_dirTo2D(lineA.d, basis).normalize();
      const dB2 = this.#_dirTo2D(lineB.d, basis).normalize();
      const dot = Math.max(-1, Math.min(1, dA2.dot(dB2)));
      let angle = Math.acos(dot);
      if (Boolean(a.useReflexAngle)) angle = 2 * Math.PI - angle;
      return THREE.MathUtils.radToDeg(angle);
    } catch (e) {
      console.warn('Error measuring angle:', e);
      return null;
    }
  }

  #measureRadialValue(a) {
    try {
      const centerRefName = a.centerRefName;
      const edgeRefName = a.edgeRefName;

      if (!centerRefName && !edgeRefName) return null;

      // First try to get radius from edge geometry if we have an edge selected
      if (edgeRefName && edgeRefName !== centerRefName) {
        const edgeObj = this.viewer?.partHistory?.scene?.getObjectByName(edgeRefName);
        if (edgeObj && edgeObj.userData && edgeObj.userData.brepType === 'EDGE') {
          // Try to extract radius from circular edge geometry
          const geometry = edgeObj.geometry;
          if (geometry && geometry.parameters) {
            // Handle different circular geometry types
            if (geometry.parameters.radius !== undefined) {
              return geometry.parameters.radius;
            }
            if (geometry.parameters.radiusTop !== undefined) {
              return geometry.parameters.radiusTop;
            }
          }

          // Fallback: try to calculate radius from edge vertices
          if (geometry && geometry.attributes && geometry.attributes.position) {
            const positions = geometry.attributes.position.array;
            if (positions.length >= 6) { // At least 2 vertices
              // For circular arcs, calculate radius from center and first point
              if (centerRefName) {
                const centerObj = this.viewer?.partHistory?.scene?.getObjectByName(centerRefName);
                if (centerObj) {
                  const centerWorld = this.#resolveAnchorToWorld({ refName: centerRefName }) || this.#objectRepresentativePoint(centerObj);
                  const firstPoint = new THREE.Vector3(positions[0], positions[1], positions[2]);
                  edgeObj.localToWorld(firstPoint);
                  return centerWorld.distanceTo(firstPoint);
                }
              }

              // If no center point specified, try to estimate from arc points
              const points = [];
              for (let i = 0; i < Math.min(positions.length, 18); i += 3) { // Sample up to 6 points
                const p = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
                edgeObj.localToWorld(p);
                points.push(p);
              }

              if (points.length >= 3) {
                // Use three points to calculate circle center and radius
                const [p1, p2, p3] = points;
                const center = this.#calculateCircleCenter(p1, p2, p3);
                if (center) {
                  return center.distanceTo(p1);
                }
              }
            }
          }
        }
      }

      // Enhanced fallback: if center point is specified, look for circular edges or use default radius
      if (centerRefName) {
        const centerObj = this.viewer?.partHistory?.scene?.getObjectByName(centerRefName);
        if (centerObj) {
          const centerWorld = this.#resolveAnchorToWorld({ refName: centerRefName }) || this.#objectRepresentativePoint(centerObj);
          
          // Look for nearby circular edges in the scene
          const scene = this.viewer?.partHistory?.scene;
          if (scene) {
            let bestRadius = null;
            let bestScore = -1;
            
            scene.traverse((obj) => {
              if (obj.userData && obj.userData.brepType === 'EDGE' && obj.geometry) {
                const geometry = obj.geometry;
                
                // First check for explicit radius parameters
                if (geometry.parameters && geometry.parameters.radius !== undefined) {
                  if (geometry.attributes && geometry.attributes.position) {
                    const positions = geometry.attributes.position.array;
                    if (positions.length >= 3) {
                      const edgePoint = new THREE.Vector3(positions[0], positions[1], positions[2]);
                      obj.localToWorld(edgePoint);
                      const distance = centerWorld.distanceTo(edgePoint);
                      
                      // Prefer edges where the measured distance matches the parameter radius
                      const paramRadius = geometry.parameters.radius;
                      const radiusError = Math.abs(distance - paramRadius) / Math.max(distance, paramRadius);
                      
                      if (radiusError < 0.1 && distance > 0.1) { // Within 10% error and reasonable size
                        const score = 1.0 - radiusError; // Higher score for better match
                        if (score > bestScore) {
                          bestScore = score;
                          bestRadius = paramRadius;
                        }
                      }
                    }
                  }
                }
                
                // Also check for circular-looking geometry patterns
                if (geometry.attributes && geometry.attributes.position) {
                  const positions = geometry.attributes.position.array;
                  const pointCount = positions.length / 3;
                  
                  if (pointCount >= 8) { // Enough points for a circle
                    // Sample points and check circularity
                    const samplePoints = [];
                    const step = Math.max(1, Math.floor(pointCount / 8));
                    
                    for (let i = 0; i < pointCount; i += step) {
                      const idx = i * 3;
                      const point = new THREE.Vector3(positions[idx], positions[idx + 1], positions[idx + 2]);
                      obj.localToWorld(point);
                      samplePoints.push(point);
                    }
                    
                    if (samplePoints.length >= 4) {
                      const distances = samplePoints.map(p => centerWorld.distanceTo(p));
                      const avgDistance = distances.reduce((a, b) => a + b, 0) / distances.length;
                      const variance = distances.reduce((sum, d) => sum + Math.pow(d - avgDistance, 2), 0) / distances.length;
                      const stdDev = Math.sqrt(variance);
                      
                      // Low standard deviation indicates circular geometry
                      if (avgDistance > 0.5 && stdDev < (avgDistance * 0.15)) {
                        const circularityScore = Math.max(0, 1.0 - (stdDev / avgDistance));
                        if (circularityScore > bestScore) {
                          bestScore = circularityScore;
                          bestRadius = avgDistance;
                        }
                      }
                    }
                  }
                }
              }
            });
            
            if (bestRadius !== null && bestRadius > 0) {
              return bestRadius;
            }
            
            // Final fallback: return a reasonable default radius
            return 5.0;
          }
        }
      }

      return null;
    } catch (e) {
      console.warn('Error measuring radial value:', e);
      return null;
    }
  }

  // Helper method to calculate circle center from three points
  #calculateCircleCenter(p1, p2, p3) {
    try {
      // Calculate the circumcenter of triangle formed by three points
      const ax = p1.x, ay = p1.y;
      const bx = p2.x, by = p2.y;
      const cx = p3.x, cy = p3.y;

      const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(d) < 1e-10) return null; // Points are collinear

      const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
      const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;

      return new THREE.Vector3(ux, uy, (p1.z + p2.z + p3.z) / 3); // Average Z coordinate
    } catch {
      return null;
    }
  }

  #computeAngleElements(a) {
    try {
      const elementAName = a.elementARefName;
      const elementBName = a.elementBRefName;

      if (!elementAName || !elementBName) return null;

      const objA = this.viewer?.partHistory?.scene?.getObjectByName(elementAName);
      const objB = this.viewer?.partHistory?.scene?.getObjectByName(elementBName);

      if (!objA || !objB) return null;

      const dirA = this.#getElementDirection(objA);
      const dirB = this.#getElementDirection(objB);

      if (!dirA || !dirB) return null;

      // Get representative points for positioning the angle vertex
      const pointA = this.#objectRepresentativePoint(objA);
      const pointB = this.#objectRepresentativePoint(objB);

      // Get plane normal for projection
      let plane = null;
      if (a.planeRefName) {
        console.log('Looking for plane object with name:', a.planeRefName);
        const planeObj = this.viewer?.partHistory?.scene?.getObjectByName(a.planeRefName);
        if (planeObj) {
          console.log('Found plane object:', planeObj.name, 'type:', planeObj.userData?.type || planeObj.userData?.brepType || planeObj.type);
          plane = this.#getElementDirection(planeObj);
          console.log('Extracted plane normal:', plane);
          // Ensure the plane normal is properly normalized and valid
          if (plane && plane.lengthSq() > 0) {
            plane.normalize();
            console.log('Normalized plane normal:', plane);
          } else {
            console.warn('Invalid plane normal extracted');
            plane = null;
          }
        } else {
          console.warn('Plane object not found for name:', a.planeRefName);
        }
      }
      
      if (!plane) {
        // Smart fallback: if no plane is specified, calculate an optimal plane
        // based on the two direction vectors and their positions
        const cross = new THREE.Vector3().crossVectors(dirA, dirB);
        if (cross.lengthSq() > 1e-10) {
          // The directions are not parallel, use their cross product as plane normal
          plane = cross.normalize();
        } else {
          // Directions are parallel or anti-parallel, use alignment-based plane normal
          plane = this.#_alignNormal(a?.alignment || 'view', a);
        }
      }

      // Ensure plane normal is valid
      if (!plane || plane.lengthSq() === 0) {
        plane = new THREE.Vector3(0, 0, 1); // Default to XY plane
      }

      return { dirA, dirB, pointA, pointB, plane };
    } catch (e) {
      console.warn('Error computing angle elements:', e);
      return null;
    }
  }

  #getElementDirection(obj) {
    try {
      if (!obj) return null;

      // Check for object type in multiple places
      const userData = obj.userData || {};
      const objType = userData.type || userData.brepType || obj.type;

      // For faces, return the face normal (averaged if needed)
      if (objType === 'FACE') {
        console.log('Getting face normal for:', obj.name, 'userData:', userData);
        
        // Try getAverageNormal method first
        if (typeof obj.getAverageNormal === 'function') {
          const localNormal = obj.getAverageNormal();
          // Transform to world space
          obj.updateMatrixWorld(true);
          const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
          const worldNormal = localNormal.applyMatrix3(normalMatrix).normalize();
          console.log('Face normal from getAverageNormal:', worldNormal);
          return worldNormal;
        }

        // Enhanced geometry-based normal calculation
        const geometry = obj.geometry;
        if (geometry) {
          // First try to get normal from geometry attributes
          if (geometry.attributes && geometry.attributes.normal) {
            const normals = geometry.attributes.normal.array;
            if (normals.length >= 3) {
              // Average all normals for better accuracy
              const avgNormal = new THREE.Vector3(0, 0, 0);
              const normalCount = normals.length / 3;
              for (let i = 0; i < normalCount; i++) {
                const idx = i * 3;
                avgNormal.add(new THREE.Vector3(normals[idx], normals[idx + 1], normals[idx + 2]));
              }
              avgNormal.divideScalar(normalCount);
              
              // Transform to world space
              obj.updateMatrixWorld(true);
              const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
              const worldNormal = avgNormal.applyMatrix3(normalMatrix).normalize();
              console.log('Face normal from geometry normals:', worldNormal);
              return worldNormal;
            }
          }

          // Calculate normal from vertices using multiple triangles for better accuracy
          if (geometry.attributes && geometry.attributes.position) {
            const positions = geometry.attributes.position.array;
            if (positions.length >= 9) {
              // Use multiple triangles to get a better average normal
              const avgNormal = new THREE.Vector3(0, 0, 0);
              let normalCount = 0;
              
              obj.updateMatrixWorld(true);
              
              // Sample multiple triangles across the face
              const vertexCount = positions.length / 3;
              const sampleCount = Math.min(5, Math.floor(vertexCount / 3)); // Sample up to 5 triangles
              
              for (let i = 0; i < sampleCount; i++) {
                const baseIdx = i * 9; // Each triangle uses 3 vertices
                if (baseIdx + 8 < positions.length) {
                  const p1 = new THREE.Vector3(positions[baseIdx], positions[baseIdx + 1], positions[baseIdx + 2]);
                  const p2 = new THREE.Vector3(positions[baseIdx + 3], positions[baseIdx + 4], positions[baseIdx + 5]);
                  const p3 = new THREE.Vector3(positions[baseIdx + 6], positions[baseIdx + 7], positions[baseIdx + 8]);

                  // Transform to world space
                  p1.applyMatrix4(obj.matrixWorld);
                  p2.applyMatrix4(obj.matrixWorld);
                  p3.applyMatrix4(obj.matrixWorld);

                  const v1 = p2.clone().sub(p1);
                  const v2 = p3.clone().sub(p1);
                  const normal = v1.cross(v2);
                  
                  if (normal.lengthSq() > 1e-10) {
                    normal.normalize();
                    avgNormal.add(normal);
                    normalCount++;
                  }
                }
              }
              
              if (normalCount > 0) {
                avgNormal.divideScalar(normalCount).normalize();
                console.log('Face normal from vertex calculation:', avgNormal);
                return avgNormal;
              }
            }
          }
        }

        // Last resort: use object's Z-axis as normal
        const worldZ = new THREE.Vector3(0, 0, 1);
        obj.updateMatrixWorld(true);
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
        const fallbackNormal = worldZ.applyMatrix3(normalMatrix).normalize();
        console.log('Face normal fallback to Z-axis:', fallbackNormal);
        return fallbackNormal;

      } else if (objType === 'EDGE') {
        // For edges, use the edge direction vector
        const geometry = obj.geometry;
        if (geometry && geometry.attributes && geometry.attributes.position) {
          const positions = geometry.attributes.position.array;
          if (positions.length >= 6) {
            const p1 = new THREE.Vector3(positions[0], positions[1], positions[2]);
            const p2 = new THREE.Vector3(positions[3], positions[4], positions[5]);

            // Transform to world space
            obj.updateMatrixWorld(true);
            p1.applyMatrix4(obj.matrixWorld);
            p2.applyMatrix4(obj.matrixWorld);

            return p2.clone().sub(p1).normalize();
          }
        }

        // Fallback: use object's X-axis as direction
        const worldX = new THREE.Vector3(1, 0, 0);
        obj.updateMatrixWorld(true);
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
        return worldX.applyMatrix3(normalMatrix).normalize();
      }

      console.warn('Unable to determine direction for element:', {
        type: objType,
        userData: userData,
        hasGeometry: !!obj.geometry,
        name: obj.name
      });
      return null;
    } catch (e) {
      console.warn('Error getting element direction:', e);
      return null;
    }
  }

  #computeDimPoints(a) {
    // Prefer name-based refs; fallback to legacy anchors or stored p0/p1
    try {
      const aName = a.aRefName || null;
      const bName = a.bRefName || null;
      if (aName || bName) {
        const objA = aName ? this.viewer?.partHistory?.scene?.getObjectByName(aName) : null;
        const objB = bName ? this.viewer?.partHistory?.scene?.getObjectByName(bName) : null;
        if (objA && objB) {
          return this.#closestPointsForObjects(objA, objB);
        }
        if (objA && !objB) {
          const pA = this.#objectRepresentativePoint(objA);
          const pB = (a.p1 ? new THREE.Vector3(a.p1.x || 0, a.p1.y || 0, a.p1.z || 0) : this.#resolveAnchorToWorld(a.b) || null);
          if (pA && pB) return { p0: pA, p1: (pB instanceof THREE.Vector3 ? pB : new THREE.Vector3(pB.x, pB.y, pB.z)) };
        }
        if (!objA && objB) {
          const pB = this.#objectRepresentativePoint(objB);
          const pA = (a.p0 ? new THREE.Vector3(a.p0.x || 0, a.p0.y || 0, a.p0.z || 0) : this.#resolveAnchorToWorld(a.a) || null);
          if (pA && pB) return { p0: (pA instanceof THREE.Vector3 ? pA : new THREE.Vector3(pA.x, pA.y, pA.z)), p1: pB };
        }
      }
    } catch { }
    // Fallback to legacy anchor objects or stored world points
    const wp0 = this.#resolveAnchorToWorld(a.a) || (a.p0 ? new THREE.Vector3(a.p0.x || 0, a.p0.y || 0, a.p0.z || 0) : null) || new THREE.Vector3(0, 0, 0);
    const wp1 = this.#resolveAnchorToWorld(a.b) || (a.p1 ? new THREE.Vector3(a.p1.x || 0, a.p1.y || 0, a.p1.z || 0) : null) || new THREE.Vector3(0, 0, 0);
    const p0 = wp0 instanceof THREE.Vector3 ? wp0 : new THREE.Vector3(wp0.x || 0, wp0.y || 0, wp0.z || 0);
    const p1 = wp1 instanceof THREE.Vector3 ? wp1 : new THREE.Vector3(wp1.x || 0, wp1.y || 0, wp1.z || 0);
    return { p0, p1 };
  }

  #computeRadialPoints(a) {
    try {
      const centerRefName = a.centerRefName;
      const edgeRefName = a.edgeRefName;

      let center = null;
      let radiusPoint = null;

      // Get center point
      if (centerRefName) {
        const centerObj = this.viewer?.partHistory?.scene?.getObjectByName(centerRefName);
        if (centerObj) {
          center = this.#resolveAnchorToWorld({ refName: centerRefName }) || this.#objectRepresentativePoint(centerObj);
        }
      }

      // Get radius point from edge (if it's different from center)
      if (edgeRefName && edgeRefName !== centerRefName) {
        const edgeObj = this.viewer?.partHistory?.scene?.getObjectByName(edgeRefName);
        if (edgeObj) {
          radiusPoint = this.#objectRepresentativePoint(edgeObj);
          
          // If no center specified, try to compute it from edge geometry
          if (!center && edgeObj.geometry && edgeObj.geometry.attributes && edgeObj.geometry.attributes.position) {
            const positions = edgeObj.geometry.attributes.position.array;
            if (positions.length >= 9) { // At least 3 points
              const points = [];
              for (let i = 0; i < Math.min(positions.length, 18); i += 3) {
                const p = new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]);
                edgeObj.localToWorld(p);
                points.push(p);
              }
              
              if (points.length >= 3) {
                center = this.#calculateCircleCenter(points[0], points[1], points[2]);
              }
            }
          }
        }
      }

      // Enhanced fallback logic for when we have center but need radius point
      if (center && !radiusPoint) {
        // First, try to find circular/arc edges near the center
        const scene = this.viewer?.partHistory?.scene;
        let bestCircularEdge = null;
        let bestRadius = null;
        
        if (scene) {
          scene.traverse((obj) => {
            if (obj.userData && obj.userData.brepType === 'EDGE' && obj.geometry) {
              const geometry = obj.geometry;
              
              // Check if this looks like a circular edge
              if (geometry.attributes && geometry.attributes.position) {
                const positions = geometry.attributes.position.array;
                const pointCount = positions.length / 3;
                
                // Look for edges with multiple points (indicating arcs/circles)
                if (pointCount >= 8) { // Circular arcs typically have many points
                  // Sample several points to check if they form a circle
                  const samplePoints = [];
                  const step = Math.max(1, Math.floor(pointCount / 8)); // Sample ~8 points
                  
                  for (let i = 0; i < pointCount; i += step) {
                    const idx = i * 3;
                    const point = new THREE.Vector3(positions[idx], positions[idx + 1], positions[idx + 2]);
                    obj.localToWorld(point);
                    samplePoints.push(point);
                  }
                  
                  // Check if these points are roughly equidistant from our center
                  if (samplePoints.length >= 3) {
                    const distances = samplePoints.map(p => center.distanceTo(p));
                    const avgDistance = distances.reduce((a, b) => a + b, 0) / distances.length;
                    
                    // Check variance - low variance means points are on a circle
                    const variance = distances.reduce((sum, d) => sum + Math.pow(d - avgDistance, 2), 0) / distances.length;
                    
                    if (variance < (avgDistance * 0.1) && avgDistance > 0.5) { // Low variance = circular
                      bestCircularEdge = samplePoints[0]; // Use first point on the circle
                      bestRadius = avgDistance;
                    }
                  }
                }
              }
            }
          });
        }
        
        if (bestCircularEdge && bestRadius) {
          radiusPoint = bestCircularEdge;
        } else {
          // Create a radius point at a default distance from center
          const radialValue = this.#measureRadialValue(a) || 5.0;
          // Use a more intelligent direction - try to point towards camera or use world X
          const cameraDirection = this.viewer?.camera ? 
            new THREE.Vector3().subVectors(this.viewer.camera.position, center).normalize() : 
            new THREE.Vector3(1, 0, 0);
          
          radiusPoint = center.clone().addScaledVector(cameraDirection, radialValue);
        }
      }

      // Fallback: if we have radius point but no center, place center at origin or compute from context
      if (radiusPoint && !center) {
        center = new THREE.Vector3(0, 0, 0);
      }

      // Handle the special case where both refs are the same vertex
      if (centerRefName && edgeRefName === centerRefName) {
        // Both point to the same vertex - create a default radius visualization
        const radialValue = this.#measureRadialValue(a) || 5.0;
        radiusPoint = center.clone().add(new THREE.Vector3(radialValue, 0, 0));
      }

      // Final safety check - if we still don't have both points, create defaults
      if (!center) {
        center = new THREE.Vector3(0, 0, 0);
      }
      if (!radiusPoint) {
        const radialValue = this.#measureRadialValue(a) || 5.0;
        radiusPoint = center.clone().add(new THREE.Vector3(radialValue, 0, 0));
      }

      // Compute plane normal from circular geometry if available
      let planeNormal = null;
      console.log('Attempting to compute plane normal. center:', !!center, 'radiusPoint:', !!radiusPoint, 'edgeRefName:', edgeRefName);
      
      if (center && radiusPoint && edgeRefName) {
        const edgeObj = this.viewer?.partHistory?.scene?.getObjectByName(edgeRefName);
        console.log('Found edge object:', !!edgeObj, 'has geometry:', !!edgeObj?.geometry);
        
        if (edgeObj && edgeObj.geometry && edgeObj.geometry.attributes && edgeObj.geometry.attributes.position) {
          const positions = edgeObj.geometry.attributes.position.array;
          const pointCount = positions.length / 3;
          
          console.log('Computing plane normal for radial dimension, pointCount:', pointCount);
          
          // Extract multiple points from the arc to calculate plane normal
          if (pointCount >= 3) {
            const worldPoints = [];
            const step = Math.max(1, Math.floor(pointCount / 6)); // Sample ~6 points
            
            for (let i = 0; i < Math.min(pointCount, 18); i += step) { // Max 6 points
              const idx = i * 3;
              const point = new THREE.Vector3(positions[idx], positions[idx + 1], positions[idx + 2]);
              edgeObj.localToWorld(point);
              worldPoints.push(point);
            }
            
            console.log('Sampled points for plane calculation:', worldPoints.length);
            
            // Calculate plane normal using cross product of two vectors in the arc plane
            if (worldPoints.length >= 3) {
              // Use points that are further apart for better numerical stability
              const p1 = worldPoints[0];
              const p2 = worldPoints[Math.floor(worldPoints.length / 2)];
              const p3 = worldPoints[worldPoints.length - 1];
              
              const v1 = new THREE.Vector3().subVectors(p2, p1);
              const v2 = new THREE.Vector3().subVectors(p3, p1);
              
              console.log('Vector 1:', v1);
              console.log('Vector 2:', v2);
              
              planeNormal = new THREE.Vector3().crossVectors(v1, v2).normalize();
              
              console.log('Calculated plane normal:', planeNormal, 'length:', planeNormal.length());
              
              // Ensure the normal has reasonable magnitude
              if (planeNormal.length() < 0.1) {
                console.log('Plane normal too small, setting to null');
                planeNormal = null;
              }
            }
          }
        }
      }
      
      // Fallback: if we couldn't extract plane from geometry, try to infer it
      if (!planeNormal && center && radiusPoint) {
        console.log('Using fallback plane calculation');
        
        // Try to use the current view plane as a constraint
        const camera = this.viewer?.camera;
        if (camera) {
          const cameraDirection = new THREE.Vector3().subVectors(center, camera.position).normalize();
          const radialDirection = new THREE.Vector3().subVectors(radiusPoint, center).normalize();
          
          // Create a plane normal perpendicular to both the camera direction and radial direction
          planeNormal = new THREE.Vector3().crossVectors(radialDirection, cameraDirection).normalize();
          
          // If the cross product is too small, use a different approach
          if (planeNormal.length() < 0.1) {
            // Use the camera's up vector to create a plane
            const upVector = camera.up.clone().normalize();
            planeNormal = new THREE.Vector3().crossVectors(radialDirection, upVector).normalize();
          }
          
          console.log('Fallback plane normal:', planeNormal, 'length:', planeNormal.length());
        }
      }

      return (center && radiusPoint) ? { center, radiusPoint, planeNormal } : null;
    } catch (e) {
      console.warn('Error computing radial points:', e);
      return null;
    }
  }

  #computeRadialLabelPosition(a, center, radiusPoint) {
    try {
      if (!center || !radiusPoint) return new THREE.Vector3();

      // Calculate direction from center to radius point
      const direction = new THREE.Vector3().subVectors(radiusPoint, center).normalize();
      
      // Calculate offset distance - make it more substantial for better visibility
      let offsetDistance = Number(a.offset);
      if (!Number.isFinite(offsetDistance) || Math.abs(offsetDistance) < 1) {
        offsetDistance = this.#_screenSizeWorld(50); // Larger default offset for better text positioning
      }

      // For diameter mode, position from the diameter end
      if (a.displayStyle === 'diameter') {
        const radiusValue = this.#measureRadialValue(a) || 5.0;
        const diameterEnd = center.clone().addScaledVector(direction, radiusValue);
        return diameterEnd.clone().addScaledVector(direction, offsetDistance);
      } else {
        // For radius mode, position from radius point plus offset in radial direction
        return radiusPoint.clone().addScaledVector(direction, offsetDistance);
      }
    } catch {
      return new THREE.Vector3();
    }
  }

  #objectRepresentativePoint(obj) {
    try {
      if (!obj) return null;
      // Faces: return a point guaranteed to lie on the face plane (centroid of vertices in world space)
      const kind = obj.userData?.type || obj.userData?.brepType || obj.type;
      if (kind === 'FACE') {
        const g = obj.geometry;
        if (g && g.attributes && g.attributes.position) {
          const pos = g.attributes.position.array;
          if (pos && pos.length >= 3) {
            let sx = 0, sy = 0, sz = 0, c = 0;
            const v = new THREE.Vector3();
            obj.updateMatrixWorld(true);
            for (let i = 0; i < pos.length; i += 3) {
              v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(obj.matrixWorld);
              sx += v.x; sy += v.y; sz += v.z; c++;
            }
            if (c > 0) return new THREE.Vector3(sx / c, sy / c, sz / c);
          }
        }
        // Fallback: bounding box center in world space
        if (g) {
          g.computeBoundingBox?.();
          const bb = g.boundingBox;
          if (bb) {
            const center = bb.getCenter(new THREE.Vector3());
            return center.applyMatrix4(obj.matrixWorld);
          }
        }
        // Last resort
        return obj.getWorldPosition(new THREE.Vector3());
      }

      if (obj.type === 'VERTEX') {
        return obj.getWorldPosition(new THREE.Vector3());
      }
      if (obj.type === 'EDGE') {
        try {
          const pts = obj.points(true);
          if (pts && pts.length) return new THREE.Vector3(pts[0].x, pts[0].y, pts[0].z);
        } catch { }
      }
      // Any other object: world position
      return obj.getWorldPosition(new THREE.Vector3());
    } catch { return null; }
  }

  #resolveRefNameToWorld(name, fallback) {
    try {
      if (!name || !this.viewer || !this.viewer.partHistory) return null;
      const scene = this.viewer.partHistory.scene;
      const obj = scene.getObjectByName(String(name));
      if (!obj) return null;
      if (obj.type === 'VERTEX') return obj.getWorldPosition(new THREE.Vector3());
      if (obj.type === 'EDGE') {
        if (fallback && fallback.isVector3) return this.#closestPointOnEdgeToPoint(obj, fallback);
        const pts = obj.points(true); if (pts && pts.length) return new THREE.Vector3(pts[0].x, pts[0].y, pts[0].z);
      }
      // Fallback: any object, return world position
      return obj.getWorldPosition(new THREE.Vector3());
    } catch { return null; }
  }

  #closestPointsForObjects(objA, objB) {
    if (objA.type === 'VERTEX' && objB.type === 'VERTEX') {
      return { p0: objA.getWorldPosition(new THREE.Vector3()), p1: objB.getWorldPosition(new THREE.Vector3()) };
    }
    if (objA.type === 'EDGE' && objB.type === 'VERTEX') {
      const v = objB.getWorldPosition(new THREE.Vector3());
      const p = this.#closestPointOnEdgeToPoint(objA, v);
      return { p0: p, p1: v };
    }
    if (objA.type === 'VERTEX' && objB.type === 'EDGE') {
      const v = objA.getWorldPosition(new THREE.Vector3());
      const p = this.#closestPointOnEdgeToPoint(objB, v);
      return { p0: v, p1: p };
    }
    if (objA.type === 'EDGE' && objB.type === 'EDGE') {
      return this.#closestPointsBetweenEdges(objA, objB);
    }
    // Fallback: representative points
    return { p0: this.#objectRepresentativePoint(objA) || new THREE.Vector3(), p1: this.#objectRepresentativePoint(objB) || new THREE.Vector3() };
  }

  #closestPointOnEdgeToPoint(edge, point) {
    try {
      const pts = edge.points(true);
      if (!pts || pts.length < 2) return edge.getWorldPosition(new THREE.Vector3());
      const p = point.clone();
      let best = { d2: Infinity, q: null };
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      for (let i = 0; i < pts.length - 1; i++) {
        a.set(pts[i].x, pts[i].y, pts[i].z);
        b.set(pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
        const q = this.#closestPointOnSegment(a, b, p);
        const d2 = q.distanceToSquared(p);
        if (d2 < best.d2) best = { d2, q };
      }
      return best.q || edge.getWorldPosition(new THREE.Vector3());
    } catch { return edge.getWorldPosition(new THREE.Vector3()); }
  }

  #closestPointsBetweenEdges(e1, e2) {
    try {
      const pts1 = e1.points(true); const pts2 = e2.points(true);
      if (!pts1 || pts1.length < 2 || !pts2 || pts2.length < 2) return { p0: this.#objectRepresentativePoint(e1), p1: this.#objectRepresentativePoint(e2) };
      const a0 = new THREE.Vector3(), a1 = new THREE.Vector3(), b0 = new THREE.Vector3(), b1 = new THREE.Vector3();
      let best = { d2: Infinity, p: null, q: null };
      for (let i = 0; i < pts1.length - 1; i++) {
        a0.set(pts1[i].x, pts1[i].y, pts1[i].z);
        a1.set(pts1[i + 1].x, pts1[i + 1].y, pts1[i + 1].z);
        for (let j = 0; j < pts2.length - 1; j++) {
          b0.set(pts2[j].x, pts2[j].y, pts2[j].z);
          b1.set(pts2[j + 1].x, pts2[j + 1].y, pts2[j + 1].z);
          const { p, q } = this.#closestPointsOnSegments(a0, a1, b0, b1);
          const d2 = p.distanceToSquared(q);
          if (d2 < best.d2) best = { d2, p, q };
        }
      }
      return { p0: best.p || this.#objectRepresentativePoint(e1), p1: best.q || this.#objectRepresentativePoint(e2) };
    } catch { return { p0: this.#objectRepresentativePoint(e1), p1: this.#objectRepresentativePoint(e2) }; }
  }

  #closestPointOnSegment(a, b, p) {
    const ab = b.clone().sub(a);
    const t = Math.max(0, Math.min(1, ab.dot(p.clone().sub(a)) / (ab.lengthSq() || 1)));
    return a.clone().addScaledVector(ab, t);
  }

  #closestPointsOnSegments(p1, q1, p2, q2) {
    // Returns closest points on segments p1q1 and p2q2 using standard algorithm
    const d1 = q1.clone().sub(p1);
    const d2 = q2.clone().sub(p2);
    const r = p1.clone().sub(p2);
    const a = d1.dot(d1);
    const e = d2.dot(d2);
    const f = d2.dot(r);
    let s, t;
    const EPS = 1e-12;
    if (a <= EPS && e <= EPS) { s = 0; t = 0; }
    else if (a <= EPS) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
    else {
      const c = d1.dot(r);
      if (e <= EPS) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else {
        const b = d1.dot(d2);
        const denom = a * e - b * b;
        s = denom !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
        else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
      }
    }
    const cp1 = p1.clone().addScaledVector(d1, s);
    const cp2 = p2.clone().addScaledVector(d2, t);
    return { p: cp1, q: cp2 };
  }

  #calculateEdgeIntersection(pointA, dirA, pointB, dirB, planeNormal) {
    try {
      // Project directions onto the plane
      const projDirA = dirA.clone().projectOnPlane(planeNormal);
      const projDirB = dirB.clone().projectOnPlane(planeNormal);

      // Check if directions are valid after projection
      if (projDirA.lengthSq() < 1e-10 || projDirB.lengthSq() < 1e-10) {
        return null;
      }

      projDirA.normalize();
      projDirB.normalize();

      // Project points to the plane by finding the closest point on the plane
      const planePoint = new THREE.Vector3(0, 0, 0); // Assume plane passes through origin
      const projPointA = this.#projectPointToPlane(pointA, planePoint, planeNormal);
      const projPointB = this.#projectPointToPlane(pointB, planePoint, planeNormal);

      // Calculate intersection of two lines using parametric form
      // Line 1: projPointA + t * projDirA  
      // Line 2: projPointB + s * projDirB
      // Solve: projPointA + t * projDirA = projPointB + s * projDirB

      const d = projPointB.clone().sub(projPointA);
      const det = projDirA.x * projDirB.z - projDirA.z * projDirB.x + 
                  projDirA.y * projDirB.x - projDirA.x * projDirB.y +
                  projDirA.z * projDirB.y - projDirA.y * projDirB.z;
      
      if (Math.abs(det) < 1e-10) {
        // Lines are parallel or coincident
        return null;
      }

      const t = (d.x * projDirB.z - d.z * projDirB.x + d.y * projDirB.x - d.x * projDirB.y) / det;
      
      // Calculate intersection point
      const intersection = projPointA.clone().add(projDirA.clone().multiplyScalar(t));
      
      return intersection;
    } catch (e) {
      console.warn('Error calculating edge intersection:', e);
      return null;
    }
  }

  #calculatePlaneLineIntersection(pointA, dirA, pointB, dirB, planePoint, planeNormal) {
    try {
      // Robust intersection of two lines constrained to a plane:
      // 1) Build a 2D basis (U,V) for the plane
      const n = planeNormal.clone().normalize();
      if (!Number.isFinite(n.x) || n.lengthSq() < 1e-12) return null;

      // Use projected A direction as U when possible for numerical stability
      let U = dirA.clone().projectOnPlane(n);
      if (U.lengthSq() < 1e-10) {
        // Pick any vector not parallel to n
        U = Math.abs(n.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        U.crossVectors(n, U);
      }
      U.normalize();
      const V = new THREE.Vector3().crossVectors(n, U).normalize();

      // Helper to map world -> plane 2D
      const to2D = (p) => {
        const r = p.clone().sub(planePoint);
        return new THREE.Vector2(r.dot(U), r.dot(V));
      };

      const p1 = to2D(pointA);
      const p2 = to2D(pointB);
      const d1 = new THREE.Vector2(dirA.dot(U), dirA.dot(V));
      const d2 = new THREE.Vector2(dirB.dot(U), dirB.dot(V));

      // 2D cross product helper
      const cross2 = (a, b) => a.x * b.y - a.y * b.x;

      const denom = cross2(d1, d2);
      if (Math.abs(denom) < 1e-12) return null; // Parallel in plane

      const t = cross2(p2.clone().sub(p1), d2) / denom;
      const world = pointA.clone().addScaledVector(dirA, t);
      return this.#projectPointToPlane(world, planePoint, n);
    } catch (e) {
      console.warn('Error calculating plane line intersection:', e);
      return null;
    }
  }

  #projectPointToPlane(point, planePoint, planeNormal) {
    const d = point.clone().sub(planePoint).dot(planeNormal);
    return point.clone().sub(planeNormal.clone().multiplyScalar(d));
  }

  // Resolve measurement plane for an angle annotation
  #_resolveAnglePlane(ann, elements) {
    try {
      // Prefer explicit plane reference if provided
      if (ann?.planeRefName) {
        const planeObj = this.viewer?.partHistory?.scene?.getObjectByName(ann.planeRefName);
        if (planeObj) {
          const n = this.#getElementDirection(planeObj) || new THREE.Vector3(0, 0, 1);
          if (n.lengthSq() > 1e-12) {
            const p = this.#objectRepresentativePoint(planeObj) || new THREE.Vector3();
            return { n: n.clone().normalize(), p };
          }
        }
      }
      // Fallback to elements' computed plane or alignment
      const n2 = elements?.plane || this.#_alignNormal(ann?.alignment || 'view', ann) || new THREE.Vector3(0, 0, 1);
      const p2 = (elements?.pointA && elements?.pointB)
        ? new THREE.Vector3().addVectors(elements.pointA, elements.pointB).multiplyScalar(0.5)
        : new THREE.Vector3();
      return { n: n2.clone().normalize(), p: p2 };
    } catch {
      return { n: new THREE.Vector3(0, 0, 1), p: new THREE.Vector3() };
    }
  }

  // Produce a 3D direction that lies in the plane for a given element reference
  #_directionInPlaneForRef(refName, planeNormal) {
    try {
      if (!refName) return null;
      const scene = this.viewer?.partHistory?.scene;
      const obj = scene?.getObjectByName(refName);
      if (!obj) return null;

      const type = obj.userData?.type || obj.userData?.brepType || obj.type;
      const d = this.#getElementDirection(obj);
      if (!d || d.lengthSq() < 1e-12) return null;

      if (type === 'FACE') {
        // Direction of intersection between the selected plane and the face plane
        const cross = new THREE.Vector3().crossVectors(planeNormal, d);
        if (cross.lengthSq() < 1e-12) return null; // Parallel planes
        return cross.normalize();
      }

      // For edges or generic directions, project onto the plane
      const proj = d.clone().projectOnPlane(planeNormal);
      if (proj.lengthSq() < 1e-12) return null;
      return proj.normalize();
    } catch {
      return null;
    }
  }

  // Returns a line (point p on plane, direction d in plane) for a given element
  #_lineInPlaneForElementRef(refName, planeNormal, planePoint) {
    try {
      if (!refName) return null;
      const scene = this.viewer?.partHistory?.scene;
      const obj = scene?.getObjectByName(refName);
      if (!obj) return null;

      const type = obj.userData?.type || obj.userData?.brepType || obj.type;

      if (type === 'FACE') {
        const n1 = this.#getElementDirection(obj);
        const p1 = this.#objectRepresentativePoint(obj) || new THREE.Vector3();
        if (!n1 || n1.lengthSq() < 1e-12) return null;
        // Direction is intersection of planes
        const l = new THREE.Vector3().crossVectors(n1, planeNormal);
        if (l.lengthSq() < 1e-12) return null; // Parallel planes

        // Compute a specific point on the intersection line
        const d1 = n1.dot(p1);
        const d2 = planeNormal.dot(planePoint);
        const l2 = l.lengthSq();

        const term1 = new THREE.Vector3().crossVectors(planeNormal, l).multiplyScalar(d1);
        const term2 = new THREE.Vector3().crossVectors(l, n1).multiplyScalar(d2);
        const x0 = term1.add(term2).divideScalar(l2);

        return { p: x0, d: l.normalize() };
      }

      // EDGE or other: project its direction and a representative point onto plane
      const d = this.#getElementDirection(obj);
      if (!d || d.lengthSq() < 1e-12) return null;
      const projDir = d.clone().projectOnPlane(planeNormal);
      if (projDir.lengthSq() < 1e-12) return null;
      const rep = this.#objectRepresentativePoint(obj) || new THREE.Vector3();
      const p = this.#projectPointToPlane(rep, planePoint, planeNormal);
      return { p, d: projDir.normalize() };
    } catch {
      return null;
    }
  }

  // ---- Plane 2D helpers ----
  #_planeBasis(normal, preferDir) {
    const N = normal.clone().normalize();
    let U = (preferDir ? preferDir.clone() : new THREE.Vector3(1, 0, 0)).projectOnPlane(N);
    if (U.lengthSq() < 1e-12) {
      U = Math.abs(N.z) < 0.9 ? new THREE.Vector3(0, 0, 1).cross(N) : new THREE.Vector3(0, 1, 0).cross(N);
    }
    U.normalize();
    const V = new THREE.Vector3().crossVectors(N, U).normalize();
    return { U, V, N };
  }

  #_to2D(point, planePoint, basis) {
    const r = point.clone().sub(planePoint);
    return new THREE.Vector2(r.dot(basis.U), r.dot(basis.V));
  }

  #_dirTo2D(dir, basis) {
    return new THREE.Vector2(dir.dot(basis.U), dir.dot(basis.V));
  }

  #_from2D(p2, planePoint, basis) {
    return planePoint.clone()
      .add(basis.U.clone().multiplyScalar(p2.x))
      .add(basis.V.clone().multiplyScalar(p2.y));
  }

  #_intersectLines2D(p1, d1, p2, d2) {
    // Lines: p1 + t d1, p2 + s d2
    const cross = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(cross) < 1e-12) return null; // Parallel
    const v = new THREE.Vector2().subVectors(p2, p1);
    const t = (v.x * d2.y - v.y * d2.x) / cross;
    return new THREE.Vector2(p1.x + d1.x * t, p1.y + d1.y * t);
  }

  #highlightAngleElements(angleAnnotation) {
    try {
      // Clear any existing highlights first
      this.#clearElementHighlights();
      
      const elementAName = angleAnnotation.elementARefName;
      const elementBName = angleAnnotation.elementBRefName;
      const planeRefName = angleAnnotation.planeRefName;
      
      if (!elementAName && !elementBName && !planeRefName) {
        console.warn('No elements selected for angle annotation');
        return;
      }
      
      const scene = this.viewer?.partHistory?.scene;
      if (!scene) return;
      
      // Highlight Element A in orange
      if (elementAName) {
        const objA = scene.getObjectByName(elementAName);
        if (objA) {
          this.#highlightElement(objA, 0xff8800, 'Element A'); // Orange
          console.log('Highlighted Element A:', elementAName);
        }
      }
      
      // Highlight Element B in orange (same color as Element A)
      if (elementBName) {
        const objB = scene.getObjectByName(elementBName);
        if (objB) {
          this.#highlightElement(objB, 0xff8800, 'Element B'); // Orange
          console.log('Highlighted Element B:', elementBName);
        }
      }
      
      // Highlight Projection Plane in green
      if (planeRefName) {
        const planeObj = scene.getObjectByName(planeRefName);
        if (planeObj) {
          this.#highlightElement(planeObj, 0x00ff00, 'Projection Plane'); // Green
          console.log('Highlighted Projection Plane:', planeRefName);
        }
      }
      
      // Auto-clear highlights after 5 seconds
      setTimeout(() => {
        this.#clearElementHighlights();
      }, 5000);
      
    } catch (e) {
      console.warn('Error highlighting angle elements:', e);
    }
  }

  #highlightElement(obj, color, label) {
    try {
      if (!obj || !obj.material) return;
      
      // Store original material for restoration
      if (!this._originalMaterials) {
        this._originalMaterials = new Map();
      }
      
      if (!this._originalMaterials.has(obj.uuid)) {
        this._originalMaterials.set(obj.uuid, {
          material: obj.material,
          emissive: obj.material.emissive ? obj.material.emissive.clone() : new THREE.Color(0x000000)
        });
      }
      
      // Create highlighted material
      if (obj.material.clone) {
        const highlightMaterial = obj.material.clone();
        highlightMaterial.emissive = new THREE.Color(color);
        highlightMaterial.emissiveIntensity = 0.3;
        obj.material = highlightMaterial;
      } else {
        // Fallback for materials without clone method
        obj.material.emissive = new THREE.Color(color);
        if (obj.material.emissiveIntensity !== undefined) {
          obj.material.emissiveIntensity = 0.3;
        }
      }
      
      // Add to highlighted objects list
      if (!this._highlightedObjects) {
        this._highlightedObjects = new Set();
      }
      this._highlightedObjects.add(obj);
      
      console.log(`Highlighted ${label} with color ${color.toString(16)}`);
      
    } catch (e) {
      console.warn('Error applying highlight to element:', e);
    }
  }

  #clearElementHighlights() {
    try {
      if (this._highlightedObjects && this._originalMaterials) {
        for (const obj of this._highlightedObjects) {
          const original = this._originalMaterials.get(obj.uuid);
          if (original && obj.material) {
            obj.material = original.material;
          }
        }
        this._highlightedObjects.clear();
        this._originalMaterials.clear();
        console.log('Cleared element highlights');
      }
    } catch (e) {
      console.warn('Error clearing highlights:', e);
    }
  }

  #refreshOverlays() {
    // Rebuild visuals on camera motion; keeps any future screen-space overlays in sync
    try { this.#rebuildAnnotationObjects(); } catch { }
  }

  #pickWorldPoint(e) {
    try {
      const v = this.viewer;
      const rect = v.renderer.domElement.getBoundingClientRect();
      const ndc = {
        x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
      };
      v.raycaster.setFromCamera(ndc, v.camera);
      // Intersect visible geometry
      const targets = [];
      v.scene.traverse((obj) => {
        if (!obj || !obj.visible) return;
        const isGeom = !!(obj.isMesh || obj.isLine || obj.isLineSegments || obj.isLineLoop || obj.isLine2 || obj.isPoints);
        if (!isGeom) return;
        // Skip controls gizmos if present
        try {
          const c = v.controls; const giz = c?._gizmos; const grid = c?._grid;
          let p = obj; while (p) { if (p === giz || p === grid) return; p = p.parent; }
        } catch { }
        targets.push(obj);
      });
      const hits = v.raycaster.intersectObjects(targets, true);
      if (hits && hits.length) {
        return hits[0].point.clone();
      }
      // Fallback: project onto a plane through camera target, perpendicular to camera forward
      const fwd = new THREE.Vector3(); v.camera.getWorldDirection(fwd);
      const target = v.controls?.target?.clone?.() || new THREE.Vector3();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(fwd, target);
      const ray = v.raycaster.ray; const out = new THREE.Vector3();
      if (ray.intersectPlane(plane, out)) return out;
    } catch { }
    return null;
  }

  // Utility: world units per pixel for thresholds
  #worldPerPixel(camera, width, height) {
    try {
      if (camera && camera.isOrthographicCamera) {
        const zoom = (typeof camera.zoom === 'number' && camera.zoom > 0) ? camera.zoom : 1;
        const wppX = (camera.right - camera.left) / (width * zoom);
        const wppY = (camera.top - camera.bottom) / (height * zoom);
        return Math.max(Math.abs(wppX), Math.abs(wppY));
      }
      const dist = camera.position.length();
      const fovRad = (camera.fov * Math.PI) / 180;
      const h = 2 * Math.tan(fovRad / 2) * dist;
      return h / height;
    } catch { return 1; }
  }

  // Automatically position leader text at the target point location
  _autoPositionLeaderText(annotation) {
    try {
      if (!annotation.anchorRefName) return;

      // Get the target point position from the anchor using existing method
      const targetPos = this.#resolveRefNameToWorld(annotation.anchorRefName);
      if (!targetPos) return;

      // Add a small offset so text doesn't overlap the point
      const offset = this.#_screenSizeWorld(16) || 0.1;
      const camRight = new THREE.Vector3();
      const camUp = new THREE.Vector3(0, 1, 0);
      try {
        this.viewer?.camera?.getWorldDirection?.(camRight);
        camRight.crossVectors(new THREE.Vector3(0, 0, 1), camUp).normalize();
      } catch {
        camRight.set(1, 0, 0);
      }

      // Position text slightly offset from the target point
      const textPos = targetPos.clone().addScaledVector(camRight, offset).addScaledVector(camUp, offset * 0.5);

      // Set the text position
      annotation.textPosition = {
        x: textPos.x,
        y: textPos.y,
        z: textPos.z
      };

    } catch (error) {
      console.warn('Failed to auto-position leader text:', error);
    }
  }


}
