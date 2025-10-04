// PMIMode.js
// Lightweight PMI editing mode modeled after SketchMode3D UI patterns.
// - Hides Viewer sidebar and main toolbar
// - Adds a top-right Finish control
// - Adds a simple top toolbar for annotation tools
// - Adds a right-side overlay panel listing annotations for the current PMI view
// - Persists annotations back into the PMI view entry on Finish

import * as THREE from 'three';
import { genFeatureUI } from '../featureDialogs.js';
import { annotationRegistry } from './AnnotationRegistry.js';
import { AnnotationHistory } from './AnnotationHistory.js';
import { LabelOverlay } from './LabelOverlay.js';

// Register built-in annotation types
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
    this._annGroup = null;
    this._originalSections = null;
    this._pmiModeViewsSection = null;
    this._pmiViewsDomRestore = null;
    this._pmiAnnotationsSection = null;
    this._pmiViewSettingsSection = null;
    this._pmiToolOptionsSection = null;
    this._sectionCreationPromises = [];
    this._opts = { noteText: '', leaderText: 'TEXT HERE', dimDecimals: 3 };
    this._onCanvasDown = this._handlePointerDown.bind(this);
    this._onControlsChange = this._refreshOverlays.bind(this);
    this._gfuByIndex = new Map(); // idx -> genFeatureUI instance for dim widgets
    this._labelOverlay = null; // manages overlay labels
    this._baseMatrixSessionKey = `pmi-base-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this._hasBaseMatrices = false;

    // Annotation history stores inputParams/persistentData similar to PartHistory
    this._annotationHistory = new AnnotationHistory(this);
    const src = Array.isArray(this.viewEntry.annotations) ? this.viewEntry.annotations : [];
    this._annotationHistory.load(JSON.parse(JSON.stringify(src)));
    try {
      const uiAnnotations = this._annotationHistory.getAnnotationsForUI();
      uiAnnotations.forEach(ann => {
        try { this.#normalizeAnnotation(ann); } catch { }
        ann.__open = false;
      });
    } catch { }
  }

  open() {
    const v = this.viewer;
    if (!v || !v.container) return;

    // Save and hide existing accordion sections instead of hiding the whole sidebar
    this.#hideOriginalSidebarSections();

    // Build styles once
    this.#ensureStyles();

    // Mount overlay UI
    this.#mountTopRightControls();
    // Add PMI sections to existing accordion instead of creating a new sidebar
    this.#mountPMISections();

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

    // Remember modeling-space transforms so we can restore/apply PMI offsets deterministically
    this.#ensureBaseSolidMatrices();
    this.#resetSolidsToBaseMatrices();

    // Apply view-specific transforms from ViewTransform annotations AFTER annotations are processed
    this.#applyViewTransforms();
    // Initialize label overlay manager
    try {
      this._labelOverlay = new LabelOverlay(this.viewer,
        (idx, ann, ev) => this.#startLabelDrag(idx, ann, ev),
        (idx, ann, ev) => this.#focusAnnotationDialog(idx, ann, ev),
        (idx, ann, ev) => this.#handleLabelClick(idx, ann, ev),
        (idx, ann, ev) => this.#handleLabelDragEnd(idx, ann, ev));
    } catch { }

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
    try { if (v.controls) v.controls.enabled = true; } catch { }
  }

  applyViewTransformsSequential() {
    try {
      this.#applyViewTransforms();
      this._refreshOverlays();
    } catch (error) {
      console.warn('Failed to apply view transforms sequentially:', error);
    }
  }

  async finish() {
    // Persist annotations back into the view entry and refresh PMI widget
    try { this.#_persistView(true); } catch { }
    // Immediately return scene solids to modeling state before we notify the viewer
    try { this.#restoreViewTransforms(); } catch { }
    try { this.#resetSolidsToBaseMatrices(); } catch { }
    try { this.viewer.onPMIFinished?.(this.viewEntry); } catch { }
    await this.dispose();
  }

  async dispose() {
    console.log('PMI dispose started');
    const v = this.viewer;

    // Restore original transforms when exiting PMI mode
    this.#restoreViewTransforms();
    this.#resetSolidsToBaseMatrices();

    try { v.renderer.domElement.removeEventListener('pointerdown', this._onCanvasDown, { capture: true }); } catch { }
    // Remove controls change listeners
    try {
      if (v.controls && typeof this._onControlsChange === 'function') {
        v.controls.removeEventListener('change', this._onControlsChange);
        try { v.controls.removeEventListener('end', this._onControlsChange); } catch { }
      }
    } catch { }
    // Remove overlay UI
    try { this._uiTopRight?.remove(); } catch { }

    console.log('About to remove PMI sections');
    // IMPORTANT: Remove PMI-specific accordion sections FIRST, then restore original sections
    // This prevents visual glitches where both sets of sections are visible simultaneously
    await this.#removePMISections();

    console.log('About to restore original sections');
    // Now restore original sidebar sections after PMI sections are completely removed
    this.#restoreOriginalSidebarSections();

    // Remove annotation group
    try { if (this._annGroup && this._annGroup.parent) this._annGroup.parent.remove(this._annGroup); } catch { }
    this._annGroup = null;
    try { if (this._refreshTimer) clearInterval(this._refreshTimer); } catch { } this._refreshTimer = null;
    // Remove labels overlay and destroy feature UIs
    try { this._labelOverlay?.dispose?.(); } catch { }
    this._labelOverlay = null;
    try { this._gfuByIndex && this._gfuByIndex.forEach(ui => ui?.destroy?.()); this._gfuByIndex && this._gfuByIndex.clear(); } catch { }

    // Clear PMI base matrices once we're back in modeling mode
    this.#clearBaseSolidMatrices();

    // Note: Main toolbar is no longer hidden so no restoration needed
    // Restore camera controls enabled state
    try { if (this.viewer?.controls) this.viewer.controls.enabled = !!this._controlsEnabledPrev; } catch { }
  }

  // Persist the current in-memory annotations back onto the view entry and save via PMI widget
  #_persistView(refreshList = false) {
    try {
      if (!this.viewEntry) return;
      // Serialize annotations using annotation history (inputParams + persistentData)
      const history = this._annotationHistory;
      const baseSerialized = history ? history.toSerializable() : [];
      const uiAnnotations = history ? history.getAnnotationsForUI() : [];
      const serializedAnnotations = baseSerialized.map((entry, idx) => {
        const ann = uiAnnotations[idx];
        const handler = annotationRegistry.getSafe?.(ann?.type || entry.type) || annotationRegistry.getSafe?.(entry.type) || null;
        if (handler && typeof handler.serialize === 'function') {
          try {
            const custom = handler.serialize(ann, entry);
            if (custom) return custom;
          } catch {
            // fall back to base entry if serialize throws
          }
        }
        return entry;
      });
      this.viewEntry.annotations = JSON.parse(JSON.stringify(serializedAnnotations));
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
      /* Top-right buttons */
      .pmi-top-right { position: absolute; top: 48px; right: 0px; display: flex; gap: 8px; z-index: 1001; }
      .pmi-btn { appearance: none; border: 1px solid #262b36; border-radius: 8px; padding: 6px 10px; cursor: pointer; background: rgba(255,255,255,.05); color: #e6e6e6; font-weight: 700; }
      .pmi-btn.primary { background: linear-gradient(180deg, rgba(110,168,254,.25), rgba(110,168,254,.15)); }

      /* Annotations list */
      .pmi-ann-list { flex: 1 1 auto; overflow: auto; display: flex; flex-direction: column; gap: 4px; }

      /* Mini accordion for per-annotation dialogs */
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

      /* Overlay labels */
      .pmi-label-root { position: absolute; left: 0; top: 0; right: 0; bottom: 0; pointer-events: none; z-index: 6; }
      .pmi-label { position: absolute; transform: translate(-50%, -50%); background: rgba(17,24,39,.92); color: #ffffff; border: 1px solid #111827; border-radius: 6px; padding: 2px 8px; font-weight: 700; pointer-events: auto; cursor: grab; user-select: none; font-size: 14px; line-height: 1.2; box-shadow: 0 2px 6px rgba(0,0,0,.35); white-space: pre-wrap; word-break: break-word; text-align: left; }
      .pmi-label[data-anchor-position="Left Top"] { transform: translate(-100%, 0); text-align: right; }
      .pmi-label[data-anchor-position="Left Middle"] { transform: translate(-100%, -50%); text-align: right; }
      .pmi-label[data-anchor-position="Left Bottom"] { transform: translate(-100%, -100%); text-align: right; }
      .pmi-label[data-anchor-position="Right Top"] { transform: translate(0, 0); text-align: left; }
      .pmi-label[data-anchor-position="Right Middle"] { transform: translate(0, -50%); text-align: left; }
      .pmi-label[data-anchor-position="Right Bottom"] { transform: translate(0, -100%); text-align: left; }
      .pmi-label:active { cursor: grabbing; }
      .pmi-label-edit { font-size: 14px; font-weight: 700; text-align: left; outline: 2px solid #3b82f6; background: rgba(17,24,39,.95); color: #ffffff; border: 1px solid #374151; border-radius: 6px; padding: 2px 8px; box-shadow: 0 2px 8px rgba(0,0,0,.5); }

      /* Form fields for View Settings / Tool Options */
      .pmi-vfield { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; }
      .pmi-vlabel { color: #9ca3af; font-size: 12px; }
      .pmi-input { border: 1px solid #374151; border-radius: 6px; padding: 4px 6px; }
      .pmi-number { width: 80px; border: 1px solid #374151; border-radius: 6px; padding: 4px 6px; }
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

    const btnFinish = document.createElement('button');
    btnFinish.className = 'pmi-btn primary';
    btnFinish.textContent = 'Finish';
    btnFinish.addEventListener('click', () => this.finish());
    wrap.appendChild(btnFinish);
    host.appendChild(wrap);
    this._uiTopRight = wrap;
  }
  #hideOriginalSidebarSections() {
    try {
      const v = this.viewer;
      if (!v || !v.accordion) return;

      // Store original accordion sections for restoration later
      this._originalSections = [];
      const accordion = v.accordion.uiElement;

      // Find all accordion sections and hide them
      const titles = accordion.querySelectorAll('.accordion-title');
      const contents = accordion.querySelectorAll('.accordion-content');

      titles.forEach(title => {
        this._originalSections.push({
          element: title,
          display: title.style.display || '',
          visibility: title.style.visibility || ''
        });
        title.style.display = 'none';
      });

      contents.forEach(content => {
        this._originalSections.push({
          element: content,
          display: content.style.display || '',
          visibility: content.style.visibility || ''
        });
        content.style.display = 'none';
      });
    } catch (e) {
      console.warn('Failed to hide original sidebar sections:', e);
    }
  }

  #restoreOriginalSidebarSections() {
    try {
      if (!this._originalSections) {
        console.log('No original sections to restore');
        return;
      }

      console.log('Restoring original sections:', this._originalSections.length);

      // Restore all original sections
      this._originalSections.forEach(({ element, display, visibility }, index) => {
        if (element && element.parentNode) {
          element.style.display = display;
          element.style.visibility = visibility;
          console.log(`Restored section ${index}: ${element.className || element.tagName}`);
        } else {
          console.warn(`Section ${index} element no longer exists in DOM`);
        }
      });

      this._originalSections = null;
      console.log('Original sections restoration complete');
    } catch (e) {
      console.warn('Failed to restore original sidebar sections:', e);
    }
  }

  async #removePMISections() {
    try {
      const v = this.viewer;
      if (!v || !v.accordion) return;

      // Wait for any pending section creation to complete first
      if (this._sectionCreationPromises && this._sectionCreationPromises.length > 0) {
        try {
          await Promise.allSettled(this._sectionCreationPromises);
        } catch (e) {
          console.warn('Some section creation promises failed:', e);
        }
      }

      console.log('Removing PMI sections...');

      // Remove PMI sections from the accordion
      const sectionsToRemove = [
        'PMI Views (PMI Mode)',
        'Annotations — ' + (this.viewEntry?.name || ''),
        'View Settings',
        'Tool Options'
      ];

      console.log('Sections to remove:', sectionsToRemove);

      if (this._pmiViewsDomRestore && this.pmiWidget?.uiElement) {
        try {
          const widgetEl = this.pmiWidget.uiElement;
          const { parent, next } = this._pmiViewsDomRestore;
          if (widgetEl && parent) {
            if (next && next.parentNode === parent) {
              parent.insertBefore(widgetEl, next);
            } else {
              parent.appendChild(widgetEl);
            }
          }
        } catch (err) {
          console.warn('Failed to restore PMI Views widget before removal:', err);
        }
      }
      this._pmiViewsDomRestore = null;

      // First, try to use the stored section references for direct removal
      const storedSections = [this._pmiModeViewsSection, this._pmiAnnotationsSection, this._pmiViewSettingsSection, this._pmiToolOptionsSection];
      storedSections.forEach((section, index) => {
        if (section && section.uiElement) {
          try {
            // Remove the title element
            const titleEl = section.uiElement.previousElementSibling;
            if (titleEl && titleEl.classList.contains('accordion-title')) {
              titleEl.remove();
            }
            // Remove the content element
            section.uiElement.remove();
            console.log(`Removed stored section ${index}`);
          } catch (e) {
            console.warn(`Failed to remove stored section ${index}:`, e);
          }
        }
      });

      // Aggressively search and remove any PMI-related elements
      try {
        const accordion = v.accordion.uiElement;

        // Look for elements with PMI-related text content
        const allTitles = Array.from(accordion.querySelectorAll('.accordion-title'));
        const allContents = Array.from(accordion.querySelectorAll('.accordion-content'));

        console.log(`Found ${allTitles.length} titles and ${allContents.length} contents in accordion`);

        // Remove elements that match PMI section patterns
        allTitles.forEach(titleEl => {
          const text = titleEl.textContent || '';
          if (text.includes('Annotations') || text === 'View Settings' || text === 'Tool Options') {
            console.log('Removing title:', text);
            // Find and remove the associated content element as well
            const nextEl = titleEl.nextElementSibling;
            if (nextEl && nextEl.classList.contains('accordion-content')) {
              console.log('Also removing associated content');
              nextEl.remove();
            }
            titleEl.remove();
          }
        });

        // Remove any remaining content elements that might have been missed
        allContents.forEach(contentEl => {
          if (!contentEl.parentNode) return; // Already removed
          const id = contentEl.id || '';
          const name = contentEl.getAttribute('name') || '';
          if (name.includes('Annotations') || name === 'accordion-content-View Settings' || name === 'accordion-content-Tool Options' ||
            id.includes('Annotations') || id === 'accordion-content-View Settings' || id === 'accordion-content-Tool Options') {
            console.log('Removing content:', name || id);
            contentEl.remove();
          }
        });

        // Additional cleanup: remove any elements that contain PMI-specific classes or content
        const pmiElements = accordion.querySelectorAll('.pmi-ann-list, .pmi-scrollable-content, .pmi-inline-menu, .pmi-ann-footer, .pmi-vfield');
        pmiElements.forEach(el => {
          console.log('Removing PMI element:', el.className);
          // Remove the entire parent accordion section if this is PMI content
          let parent = el.parentNode;
          while (parent && !parent.classList.contains('accordion-content')) {
            parent = parent.parentNode;
          }
          if (parent && parent.classList.contains('accordion-content')) {
            const titleEl = parent.previousElementSibling;
            if (titleEl && titleEl.classList.contains('accordion-title')) {
              console.log('Removing parent title too');
              titleEl.remove();
            }
            parent.remove();
          } else {
            el.remove();
          }
        });

        // Final nuclear option: remove any sections that weren't there originally
        // This is a bit aggressive but ensures complete cleanup
        const remainingTitles = Array.from(accordion.querySelectorAll('.accordion-title'));
        const originalSectionCount = this._originalSections ? Math.floor(this._originalSections.length / 2) : 0;
        console.log(`After cleanup: ${remainingTitles.length} titles remain, originally had ${originalSectionCount} sections`);

      } catch (e) {
        console.warn('Failed to manually clean up PMI section elements:', e);
      }

      // Try to remove sections using the accordion API as a fallback
      for (const title of sectionsToRemove) {
        try {
          if (v.accordion && typeof v.accordion.removeSection === 'function') {
            await v.accordion.removeSection(title);
            console.log('Removed section via API:', title);
          }
        } catch (e) {
          console.warn(`Failed to remove section "${title}" via API:`, e);
        }
      }

      // Clear stored section references
      this._pmiModeViewsSection = null;
      this._pmiAnnotationsSection = null;
      this._pmiViewSettingsSection = null;
      this._pmiToolOptionsSection = null;
      this._sectionCreationPromises = [];

      console.log('PMI sections removal complete');

    } catch (e) {
      console.warn('Failed to remove PMI sections:', e);
    }
  }

  #mountPMISections() {
    try {
      const v = this.viewer;
      if (!v || !v.accordion) return;

      // Use the existing accordion instead of creating a new one
      this._acc = v.accordion;

      const pmiViewsPromise = this._acc.addSection('PMI Views (PMI Mode)').then((sec) => {
        try {
          this._pmiModeViewsSection = sec;
          const titleEl = sec.uiElement.previousElementSibling;
          if (titleEl) {
            titleEl.textContent = 'PMI Views';
          }

          const widget = this.pmiWidget;
          const widgetEl = widget?.uiElement;
          if (widgetEl) {
            if (!this._pmiViewsDomRestore) {
              this._pmiViewsDomRestore = {
                parent: widgetEl.parentNode || null,
                next: widgetEl.nextSibling || null,
              };
            }
            sec.uiElement.appendChild(widgetEl);
          }

          this.#applyPMIPanelLayout();
        } catch (e) {
          console.warn('Failed to setup PMI Views section:', e);
        }
      });
      this._sectionCreationPromises.push(pmiViewsPromise);

      // Build Annotations section
      this._annListEl = document.createElement('div');
      this._annListEl.className = 'pmi-ann-list';

      const annotationsPromise = this._acc.addSection(`Annotations — ${this.viewEntry?.name || ''}`).then((sec) => {
        try {
          console.log('Created annotations section:', sec);
          // Container for the section content
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
              transition: 'background-color .15s ease'
            });
            btn.addEventListener('mouseenter', () => btn.style.background = '#374151');
            btn.addEventListener('mouseleave', () => btn.style.background = 'transparent');
            btn.addEventListener('click', () => {
              this.#addNewAnnotation(type);
              toggleMenu(false);
            });
            return btn;
          };

          const resolveType = (handler) => {
            if (!handler) return '';
            const candidates = [handler.type, handler.featureShortName, handler.featureName, handler.name];
            for (const candidate of candidates) {
              if (candidate === null || candidate === undefined) continue;
              const str = String(candidate).trim();
              if (str) return str;
            }
            return '';
          };

          const formatLabel = (handler, type) => {
            if (handler?.featureName) return handler.featureName;
            if (handler?.title) return handler.title;
            const base = String(type || '').replace(/[-_]/g, ' ').trim();
            if (!base) return 'Annotation';
            return base.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
          };

          const registryHandlersRaw = typeof annotationRegistry.list === 'function'
            ? annotationRegistry.list()
            : [];
          const registryHandlers = Array.isArray(registryHandlersRaw) ? registryHandlersRaw : [];
          const seenTypes = new Set();
          for (const handler of registryHandlers) {
            const type = resolveType(handler);
            if (!type) continue;
            const key = type.toLowerCase();
            if (seenTypes.has(key)) continue;
            seenTypes.add(key);
            const label = formatLabel(handler, type);
            inlineMenu.appendChild(makeItem(label, type));
          }

          const hasMenuItems = inlineMenu.childElementCount > 0;

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
            if (!hasMenuItems) return;
            ev.stopPropagation();
            toggleMenu(inlineMenu.style.display === 'none');
          });

          if (!hasMenuItems) {
            addBtn.disabled = true;
            addBtn.title = 'No annotation types available';
            addBtn.style.opacity = '0.5';
            addBtn.style.cursor = 'default';
            const empty = document.createElement('div');
            empty.textContent = 'No annotation types registered';
            empty.style.color = '#9ca3af';
            empty.style.fontSize = '14px';
            empty.style.textAlign = 'center';
            empty.style.padding = '8px 0';
            inlineMenu.appendChild(empty);
          }

          footer.appendChild(addBtn);

          // Add everything to the section
          sec.uiElement.appendChild(scrollableContent);
          sec.uiElement.appendChild(footer);

          // Store section for later cleanup
          this._pmiAnnotationsSection = sec;
          this.#applyPMIPanelLayout();
        } catch (e) {
          console.warn('Failed to setup annotations section:', e);
        }
      });
      this._sectionCreationPromises.push(annotationsPromise);

      // View Settings section
      this._viewSettingsEl = document.createElement('div');
      this._viewSettingsEl.style.padding = '6px';
      const viewSettingsPromise = this._acc.addSection('View Settings').then((sec) => {
        try {
          console.log('Created view settings section:', sec);
          sec.uiElement.appendChild(this._viewSettingsEl);
          this.#renderViewSettings();
          this._pmiViewSettingsSection = sec;
          this.#applyPMIPanelLayout();
        } catch (e) {
          console.warn('Failed to setup view settings section:', e);
        }
      });
      this._sectionCreationPromises.push(viewSettingsPromise);

      // Tool Options section
      this._toolOptsEl = document.createElement('div');
      this._toolOptsEl.style.padding = '6px';
      const toolOptionsPromise = this._acc.addSection('Tool Options').then((sec) => {
        try {
          console.log('Created tool options section:', sec);
          sec.uiElement.appendChild(this._toolOptsEl);
          this.#renderToolOptions();
          this._pmiToolOptionsSection = sec;
          this.#applyPMIPanelLayout();
        } catch (e) {
          console.warn('Failed to setup tool options section:', e);
        }
      });
      this._sectionCreationPromises.push(toolOptionsPromise);

      this.#renderAnnList();
    } catch (e) {
      console.warn('Failed to mount PMI sections:', e);
    }
  }

  #applyPMIPanelLayout() {
    try {
      const accordion = this.viewer?.accordion?.uiElement;
      if (!accordion) return;
      const sections = [
        this._pmiModeViewsSection,
        this._pmiAnnotationsSection,
        this._pmiToolOptionsSection,
        this._pmiViewSettingsSection,
      ];
      const fragment = document.createDocumentFragment();
      let hasAny = false;
      for (const section of sections) {
        if (!section || !section.uiElement) continue;
        const titleEl = section.uiElement.previousElementSibling;
        if (!titleEl) continue;
        fragment.appendChild(titleEl);
        fragment.appendChild(section.uiElement);
        hasAny = true;
      }
      if (!hasAny) return;
      accordion.insertBefore(fragment, accordion.firstChild || null);
    } catch (e) {
      console.warn('Failed to apply PMI panel layout:', e);
    }
  }

  #addNewAnnotation(type) {
    const key = String(type || 'dim');
    const handler = annotationRegistry.getSafe?.(key) || annotationRegistry.getSafe?.(type) || null;
    if (!handler) {
      console.warn('PMI: unknown annotation type', key);
      return;
    }

    try {
      const ann = this._annotationHistory.createAnnotation(handler.type || key);
      try { this.#normalizeAnnotation(ann); } catch { }
      this.#renderAnnList();
      this.#markAnnotationsDirty();
    } catch { }
  }

  #renderAnnList() {
    const list = this._annListEl;
    if (!list) return;
    try { this._gfuByIndex && this._gfuByIndex.forEach(ui => ui?.destroy?.()); this._gfuByIndex && this._gfuByIndex.clear(); } catch { }
    list.textContent = '';
    const anns = this._annotationHistory ? this._annotationHistory.getAnnotationsForUI() : [];
    try { if (!list.classList.contains('pmi-acc')) list.classList.add('pmi-acc'); } catch { }

    const helpers = {
      formatReferenceLabel: (ann, text) => { try { return this.#formatReferenceLabel(ann, text); } catch { return text; } },
      defaultOptions: () => ({ dimDecimals: this._opts?.dimDecimals, leaderText: this._opts?.leaderText, noteText: this._opts?.noteText }),
    };

    anns.forEach((a, i) => {
      const handler = annotationRegistry.getSafe?.(a.type) || null;
      const item = document.createElement('div');
      item.className = 'pmi-acc-item acc-item';

      const headerRow = document.createElement('div');
      headerRow.className = 'pmi-acc-header pmi-acc-header-row acc-header-row';

      const headBtn = document.createElement('button');
      headBtn.type = 'button';
      headBtn.className = 'pmi-acc-headbtn acc-header';

      const rawShort = handler?.featureShortName || handler?.title || String(a.type || 'Annotation');
      const shortName = typeof rawShort === 'string' ? rawShort.toUpperCase() : String(rawShort);
      const annId = String(a?.annotationID || a?.inputParams?.annotationID || `ANN${i + 1}`);
      const title = document.createElement('span');
      title.className = 'pmi-acc-title acc-title';
      title.textContent = `${shortName} — #${annId}`;
      headBtn.appendChild(title);

      const actions = document.createElement('div');
      actions.className = 'acc-actions';

      const makeIconBtn = (label, text, handlerFn) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'icon-btn';
        btn.setAttribute('aria-label', label);
        btn.title = label;
        btn.textContent = text;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          handlerFn();
        });
        return btn;
      };

      const moveUp = makeIconBtn('Move annotation up', '▲', () => {
        if (this._annotationHistory.moveUp(i)) {
          this.#renderAnnList();
          this.#markAnnotationsDirty();
          if (typeof this.applyViewTransformsSequential === 'function') {
            this.applyViewTransformsSequential();
          }
        }
      });

      const moveDown = makeIconBtn('Move annotation down', '▼', () => {
        if (this._annotationHistory.moveDown(i)) {
          this.#renderAnnList();
          this.#markAnnotationsDirty();
          if (typeof this.applyViewTransformsSequential === 'function') {
            this.applyViewTransformsSequential();
          }
        }
      });

      const delBtn = makeIconBtn('Delete annotation', '✕', () => {
        try {
          if (a?.type === 'viewTransform' && handler) {
            try {
              if (typeof handler._resolveSolidReferences === 'function') handler._resolveSolidReferences(a, this, false);
            } catch { /* ignore */ }
            try {
              if (typeof handler.restoreOriginalTransforms === 'function') handler.restoreOriginalTransforms(a, this);
            } catch { /* ignore restore errors */ }
          }
          this._annotationHistory.removeAt(i);
          this.#renderAnnList();
          this.#markAnnotationsDirty();
          if (typeof this.applyViewTransformsSequential === 'function') {
            this.applyViewTransformsSequential();
          }
        } catch { }
      });
      delBtn.classList.add('danger');

      actions.appendChild(moveUp);
      actions.appendChild(moveDown);
      actions.appendChild(delBtn);

      headerRow.appendChild(headBtn);
      headerRow.appendChild(actions);
      item.appendChild(headerRow);

      let schema = {}; let params = {};
      try {
        if (handler && typeof handler.getSchema === 'function') {
          const res = handler.getSchema(this, a, helpers) || {};
          schema = res.schema || {};
          params = res.params || {};
        }
      } catch { }

      const content = document.createElement('div'); content.className = 'pmi-acc-content acc-content';
      const ui = new genFeatureUI(schema, params, {
        viewer: this.viewer,
        excludeKeys: ['annotationID'],
        onChange: () => {
          try {
            const p = ui.getParams();
            let res = null;
            if (handler && typeof handler.applyParams === 'function') {
              res = handler.applyParams(this, a, p, helpers) || null;
            } else {
              Object.assign(a, p);
            }
            const patch = res && res.paramsPatch ? res.paramsPatch : null;
            if (patch && typeof patch === 'object') { Object.assign(ui.params, patch); ui.refreshFromParams(); }
            this.#markAnnotationsDirty();
          } catch (e) {
            console.warn('PMI onChange error:', e);
          }
        }
      });
      content.appendChild(ui.uiElement);
      try { this._gfuByIndex.set(i, ui); } catch { }
      item.appendChild(content);

      const setCollapsed = (collapsed) => {
        item.classList.toggle('collapsed', !!collapsed);
        item.classList.toggle('open', !collapsed);
        content.hidden = !!collapsed;
        headBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      };
      setCollapsed(!a.__open);
      headBtn.addEventListener('click', () => {
        a.__open = !a.__open;
        setCollapsed(!a.__open);
      });
      list.appendChild(item);
    });

    try { this.viewer.render(); } catch { }
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

    // Restore camera button
    const restoreCameraBtn = document.createElement('button');
    restoreCameraBtn.textContent = 'Restore Camera';
    restoreCameraBtn.className = 'pmi-btn';
    restoreCameraBtn.style.width = '100%';
    restoreCameraBtn.style.marginTop = '8px';
    restoreCameraBtn.addEventListener('click', () => {
      this.#restoreStoredCamera(restoreCameraBtn);
    });

    const btnRow = document.createElement('div');
    btnRow.style.margin = '8px 0';
    btnRow.appendChild(updateCameraBtn);
    btnRow.appendChild(restoreCameraBtn);
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

  #restoreStoredCamera(btnEl) {
    try {
      const camera = this.viewer?.camera;
      const ctrls = this.viewer?.controls;
      const storedCamera = this.viewEntry?.camera;

      if (!camera || !storedCamera) {
        // Visual feedback - show error if no stored camera
        const btn = btnEl || document.querySelector('.pmi-btn');
        if (btn) {
          const originalText = btn.textContent;
          btn.textContent = 'No Stored Camera';
          btn.style.background = 'rgba(239, 68, 68, 0.25)';
          setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '';
          }, 1000);
        }
        return;
      }

      // Restore camera position
      if (storedCamera.position) {
        camera.position.set(
          storedCamera.position.x,
          storedCamera.position.y,
          storedCamera.position.z
        );
      }

      // Restore camera quaternion
      if (storedCamera.quaternion) {
        camera.quaternion.set(
          storedCamera.quaternion.x,
          storedCamera.quaternion.y,
          storedCamera.quaternion.z,
          storedCamera.quaternion.w
        );
      }

      // Restore camera up vector
      if (storedCamera.up) {
        camera.up.set(
          storedCamera.up.x,
          storedCamera.up.y,
          storedCamera.up.z
        );
      }

      // Restore camera zoom
      if (typeof storedCamera.zoom === 'number') {
        camera.zoom = storedCamera.zoom;
      }

      // Restore controls target if available
      if (ctrls && ctrls.target && storedCamera.target) {
        ctrls.target.set(
          storedCamera.target.x,
          storedCamera.target.y,
          storedCamera.target.z
        );
      }

      // Update camera matrices and controls
      camera.updateProjectionMatrix();
      if (ctrls && typeof ctrls.update === 'function') {
        ctrls.update();
      }

      // Trigger a render
      if (this.viewer?.render) {
        this.viewer.render();
      }

      // Visual feedback - briefly flash the button
      const btn = btnEl || document.querySelector('.pmi-btn');
      if (btn) {
        const originalText = btn.textContent;
        btn.textContent = 'Camera Restored';
        btn.style.background = 'rgba(34, 197, 94, 0.25)';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '';
        }, 1000);
      }
    } catch { }
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

  // Apply view-specific transforms from ViewTransform annotations
  #applyViewTransforms() {
    try {
      this.#ensureBaseSolidMatrices();
      // Always return solids to their modeling positions before applying PMI offsets
      this.#resetSolidsToBaseMatrices();

      const anns = this._annotationHistory ? this._annotationHistory.getAnnotationsForUI() : [];
      if (!Array.isArray(anns) || anns.length === 0) return;

      console.log('Applying view transforms, found', anns.length, 'annotations');

      const handler = annotationRegistry.getSafe?.('viewTransform') || null;
      if (!handler) {
        console.warn('No handler found for viewTransform');
        return;
      }

      const viewAnns = [];
      for (const ann of anns) {
        if (ann.type === 'viewTransform') viewAnns.push(ann);
      }

      const cumulativeState = new Map();

      for (const ann of viewAnns) {
        console.log('Processing ViewTransform annotation:', ann);

        if (typeof handler._resolveSolidReferences === 'function') {
          handler._resolveSolidReferences(ann, this, false);
        }

        if (typeof handler._ensureOriginalSnapshots === 'function') {
          const solids = Array.isArray(ann.solids) ? ann.solids : [];
          handler._ensureOriginalSnapshots(ann, solids, false);
        }
      }

      const cloneSnapshot = (snapshot) => {
        if (!snapshot || typeof snapshot !== 'object') return null;
        return {
          position: Array.isArray(snapshot.position) ? snapshot.position.slice() : [0, 0, 0],
          quaternion: Array.isArray(snapshot.quaternion) ? snapshot.quaternion.slice() : [0, 0, 0, 1],
          scale: Array.isArray(snapshot.scale) ? snapshot.scale.slice() : [1, 1, 1],
          worldPosition: Array.isArray(snapshot.worldPosition) ? snapshot.worldPosition.slice() : null,
        };
      };

      for (const ann of viewAnns) {
        const solids = Array.isArray(ann.solids) ? ann.solids : [];
        if (!solids.length) {
          if (typeof handler.applyTransformsToSolids === 'function') {
            handler.applyTransformsToSolids(ann, this, { startSnapshots: new Map(), cumulativeState });
          }
          continue;
        }

        let startSnapshots = null;
        if (typeof handler.getOriginalSnapshotMap === 'function') {
          const origMap = handler.getOriginalSnapshotMap(ann);
          startSnapshots = new Map();
          for (const solid of solids) {
            if (!solid || !solid.uuid) continue;
            if (cumulativeState.has(solid.uuid)) {
              const snap = cloneSnapshot(cumulativeState.get(solid.uuid));
              if (snap) startSnapshots.set(solid.uuid, snap);
            } else if (origMap && origMap.has(solid.uuid)) {
              const snap = cloneSnapshot(origMap.get(solid.uuid));
              if (snap) startSnapshots.set(solid.uuid, snap);
            }
          }
        }

        if (typeof handler.applyTransformsToSolids === 'function') {
          handler.applyTransformsToSolids(ann, this, { startSnapshots, cumulativeState });
        } else if (typeof handler._applyTransformsToSolids === 'function') {
          handler._applyTransformsToSolids(ann, this);
        }
      }

      // Trigger a render to show the transformed objects
      if (this.viewer?.render) {
        this.viewer.render();
      }
    } catch (error) {
      console.warn('Failed to apply view transforms:', error);
    }
  }

  // Restore original transforms for all ViewTransform annotations
  #restoreViewTransforms() {
    try {
      const anns = this._annotationHistory ? this._annotationHistory.getAnnotationsForUI() : [];
      if (!Array.isArray(anns) || anns.length === 0) return;

      const handler = annotationRegistry.getSafe?.('viewTransform') || null;
      if (!handler) return;

      for (const ann of anns) {
        if (ann.type !== 'viewTransform') continue;

        // Restore original transforms
        if (typeof handler.restoreOriginalTransforms === 'function') {
          handler.restoreOriginalTransforms(ann, this);
        }
      }

      // Trigger a render to show the restored objects
      if (this.viewer?.render) {
        this.viewer.render();
      }
    } catch (error) {
      console.warn('Failed to restore view transforms:', error);
    }
  }

  #ensureBaseSolidMatrices() {
    if (this._hasBaseMatrices) return;
    try {
      const scene = this.viewer?.scene;
      if (!scene || typeof scene.traverse !== 'function') return;
      const sessionKey = this._baseMatrixSessionKey;
      scene.traverse((obj) => {
        if (!obj || !obj.isObject3D || obj.type !== 'SOLID') return;
        const data = obj.userData || (obj.userData = {});
        try { obj.updateMatrixWorld(true); } catch { }
        const matrix = data.__pmiBaseMatrix;
        if (matrix && typeof matrix.copy === 'function' && matrix.isMatrix4) {
          matrix.copy(obj.matrix);
        } else {
          data.__pmiBaseMatrix = obj.matrix.clone();
        }
        data.__pmiBaseMatrixSession = sessionKey;
      });
      this._hasBaseMatrices = true;
    } catch (error) {
      console.warn('Failed to record base matrices for PMI mode:', error);
    }
  }

  #resetSolidsToBaseMatrices() {
    if (!this._hasBaseMatrices) return;
    try {
      const scene = this.viewer?.scene;
      if (!scene || typeof scene.traverse !== 'function') return;
      const sessionKey = this._baseMatrixSessionKey;
      scene.traverse((obj) => {
        if (!obj || !obj.isObject3D || obj.type !== 'SOLID') return;
        const data = obj.userData;
        const base = data?.__pmiBaseMatrix;
        if (!base || !base.isMatrix4 || data.__pmiBaseMatrixSession !== sessionKey) return;
        try {
          obj.matrix.copy(base);
          obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
          if (obj.matrixAutoUpdate) {
            obj.updateMatrix();
          }
          obj.updateMatrixWorld(true);
        } catch { /* ignore per-object restore errors */ }
      });
      try { this.viewer?.render?.(); } catch { }
    } catch (error) {
      console.warn('Failed to reset solids to PMI base matrices:', error);
    }
  }

  #clearBaseSolidMatrices() {
    if (!this._hasBaseMatrices) {
      this._baseMatrixSessionKey = `pmi-base-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return;
    }
    try {
      const scene = this.viewer?.scene;
      if (!scene || typeof scene.traverse !== 'function') return;
      const sessionKey = this._baseMatrixSessionKey;
      scene.traverse((obj) => {
        if (!obj || !obj.isObject3D || obj.type !== 'SOLID') return;
        const data = obj.userData;
        if (!data || data.__pmiBaseMatrixSession !== sessionKey) return;
        delete data.__pmiBaseMatrix;
        delete data.__pmiBaseMatrixSession;
      });
    } catch (error) {
      console.warn('Failed to clear PMI base matrices:', error);
    } finally {
      this._hasBaseMatrices = false;
      this._baseMatrixSessionKey = `pmi-base-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
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
    // Rebuild overlays on camera changes (simpler and type-agnostic)
    if (this._refreshPending) return;
    this._refreshPending = true;
    requestAnimationFrame(() => {
      this._refreshPending = false;
      try { this.#rebuildAnnotationObjects(); } catch { }
    });
  }




  #markAnnotationsDirty() {
    this._annotationsDirty = true;
    // Immediately rebuild annotations instead of waiting for timer
    try {
      this.#rebuildAnnotationObjects();
      this._annotationsDirty = false;
      this.#_persistView();
    } catch (error) {
      console.warn('Failed to rebuild annotations:', error);
    }
  }

  // Public: allow external handlers to refresh the side list and 3D objects
  refreshAnnotationsUI() {
    try { this.#renderAnnList(); } catch { }
    try {
      this.#rebuildAnnotationObjects();
      this._annotationsDirty = false;
      this.#_persistView();
    } catch { }
  }

  #rebuildAnnotationObjects() {
    this.#clearAnnGroup();
    const group = this._annGroup;
    if (!group) return;
    // Ensure overlay exists; do not clear between frames so labels remain visible even if a render is skipped
    // overlay root managed by LabelOverlay
    const anns = this._annotationHistory ? this._annotationHistory.getAnnotationsForUI() : [];
    const ctx = {
      pmimode: this,
      screenSizeWorld: (px) => { try { return this.#_screenSizeWorld(px); } catch { return 0; } },
      alignNormal: (alignment, ann) => { try { return this.#_alignNormal(alignment, ann); } catch { return new THREE.Vector3(0, 0, 1); } },
      updateLabel: (idx, text, worldPos, ann) => { try { this._labelOverlay?.updateLabel?.(idx, text, worldPos, ann); } catch { } },
      formatReferenceLabel: (ann, text) => { try { return this.#formatReferenceLabel(ann, text); } catch { return text; } },
      // keep only generic helpers
      // specific drawing/measuring handled by annotation handlers now
    };
    anns.forEach((a, i) => {
      try {
        const Handler = annotationRegistry.getSafe?.(a.type) || null;
        if (!Handler) return;
        const instance = new Handler();
        instance.inputParams = a;
        let persistent = a?.persistentData;
        if (!persistent || typeof persistent !== 'object') {
          persistent = {};
          try { a.persistentData = persistent; } catch { }
        }
        instance.persistentData = persistent;
        const renderingContext = {
          pmimode: this,
          group,
          idx: i,
          ctx,
        };
        const runResult = instance.run(renderingContext);
        if (runResult && typeof runResult.then === 'function') {
          runResult.catch(() => {});
        }
      } catch { }
    });
    try { this.viewer.render(); } catch { }
    // No post-check necessary
  }

  // Wrap label text in parentheses when marked as a reference dimension
  #formatReferenceLabel(ann, text) {
    try {
      const t = String(text ?? '');
      if (!t) return t;
      if (ann && (ann.isReference === true)) return `(${t})`;
      return t;
    } catch { return text; }
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





  _handlePointerDown(e) {
    // Only left-clicks
    if (e.button !== 0) return;
    // Avoid interfering if clicking overlays
    try {
      const path = e.composedPath?.() || [];
      if (path.some((el) => el === this._uiTopRight || (el?.classList?.contains?.('pmi-side')))) return;
    } catch { }

    // If a feature reference_selection is active, let selection widget handle it
    try { const activeRef = document.querySelector('[active-reference-selection="true"],[active-reference-selection=true]'); if (activeRef) return; } catch { }

    return;
  }

  #handleLabelClick(idx, ann, e) {
    try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
    this.#collapseAnnotationsToIndex(idx);
  }

  #handleLabelDragEnd(idx, ann, e) {
    // Expand the dialog associated with the label that was dragged
    this.#collapseAnnotationsToIndex(idx);
  }

  #collapseAnnotationsToIndex(targetIdx) {
    const anns = this._annotationHistory ? this._annotationHistory.getAnnotationsForUI() : [];
    if (!anns.length) return;
    if (!Number.isInteger(targetIdx) || targetIdx < 0 || targetIdx >= anns.length) return;
    let changed = false;
    anns.forEach((ann, i) => {
      const shouldOpen = i === targetIdx;
      if (!!ann.__open !== shouldOpen) {
        ann.__open = shouldOpen;
        changed = true;
      }
    });
    if (!changed) return;
    this.#renderAnnList();
    requestAnimationFrame(() => {
      try {
        const section = this._pmiAnnotationsSection?.uiElement;
        if (!section) return;
        const items = section.querySelectorAll('.pmi-acc-item');
        const target = items && items[targetIdx];
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ block: 'nearest' });
        }
      } catch { }
    });
  }



  #startLabelDrag(idx, ann, e) {
    e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation();
    try { if (this.viewer?.controls) this.viewer.controls.enabled = false; } catch { }
    const v = this.viewer; const cam = v?.camera; if (!cam) return;

    try {
      const handler = annotationRegistry.getSafe?.(ann?.type) || null;
      if (handler && typeof handler.onLabelPointerDown === "function") {
        const ctx = {
          pmimode: this,
          screenSizeWorld: (px) => { try { return this.#_screenSizeWorld(px); } catch { return 0; } },
          alignNormal: (alignment, a) => { try { return this.#_alignNormal(alignment, a); } catch { return new THREE.Vector3(0, 0, 1); } },
          updateLabel: (i, text, worldPos, a) => { try { this._labelOverlay?.updateLabel?.(i, text, worldPos, a); } catch { } },
          raycastFromEvent: (ev) => {
            const rect = v.renderer.domElement.getBoundingClientRect();
            const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -(((ev.clientY - rect.top) / rect.height) * 2 - 1));
            v.raycaster.setFromCamera(ndc, cam);
            return v.raycaster.ray;
          },
        };
        handler.onLabelPointerDown(this, idx, ann, e, ctx);
        return;
      }
    } catch { }

    try { if (this.viewer?.controls) this.viewer.controls.enabled = true; } catch { }
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
}
