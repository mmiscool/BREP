// PMIMode.js
// Lightweight PMI editing mode modeled after SketchMode3D UI patterns.
// - Hides Viewer sidebar and main toolbar
// - Adds a top-right Finish control
// - Adds a simple top toolbar for annotation tools
// - Adds a right-side overlay panel listing annotations for the current PMI view
// - Persists annotations back into the PMI view entry on Finish

import * as THREE from 'three';
import { annotationRegistry } from './AnnotationRegistry.js';
import { getPMIStyle, setPMIStyle, sanitizePMIStyle } from './pmiStyle.js';
import { AnnotationHistory } from './AnnotationHistory.js';
import { LabelOverlay } from './LabelOverlay.js';
import { AnnotationCollectionWidget } from './AnnotationCollectionWidget.js';
import { localStorage as LS } from '../../localStorageShim.js';

const cssEscape = (value) => {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(value);
  }
  return String(value).replace(/"/g, '\\"');
};

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
    this.viewEntry = (viewEntry && typeof viewEntry === 'object')
      ? viewEntry
      : { viewName: 'View', name: 'View', camera: {}, annotations: [] };
    if (!Array.isArray(this.viewEntry.annotations)) {
      this.viewEntry.annotations = [];
    }
    const resolvedName = typeof this.viewEntry.viewName === 'string'
      ? this.viewEntry.viewName
      : (typeof this.viewEntry.name === 'string' ? this.viewEntry.name : 'View');
    this.viewEntry.viewName = String(resolvedName || 'View').trim() || 'View';
    this.viewEntry.name = this.viewEntry.viewName;
    if (!this.viewEntry.camera || typeof this.viewEntry.camera !== 'object') {
      this.viewEntry.camera = {};
    }
    this.viewIndex = viewIndex;
    this.pmiWidget = pmiWidget;

    this._uiTopRight = null;
    this._annGroup = null;
    this._originalSections = null;
    this._pmiModeViewsSection = null;
    this._pmiViewsDomRestore = null;
    this._pmiAnnotationsSection = null;
    this._pmiToolOptionsSection = null;
    this._pmiStyleStorageKey = '__PMI_STYLE_SETTINGS__';
    this._sectionCreationPromises = [];
    this._opts = { noteText: '', leaderText: 'TEXT HERE', dimDecimals: 3 };
    this._onCanvasDown = this._handlePointerDown.bind(this);
    this._onControlsChange = this._refreshOverlays.bind(this);
    this._labelOverlay = null; // manages overlay labels
    this._baseMatrixSessionKey = `pmi-base-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this._hasBaseMatrices = false;
    this._annotationWidget = null;
    this._dragPlaneHelper = null;

    // Annotation history stores inputParams/persistentData similar to PartHistory
    this._annotationHistory = new AnnotationHistory(this);
    const src = Array.isArray(this.viewEntry.annotations) ? this.viewEntry.annotations : [];
    this._annotationHistory.load(JSON.parse(JSON.stringify(src)));
    this.#loadPMIStyle();
    try {
      for (const entity of this._annotationHistory.getEntries()) {
        try { this.#normalizeAnnotation(entity.inputParams); } catch { }
        if (!entity.runtimeAttributes || typeof entity.runtimeAttributes !== 'object') {
          entity.runtimeAttributes = {};
        }
        entity.runtimeAttributes.__open = false;
        if (entity.inputParams && typeof entity.inputParams === 'object') {
          entity.inputParams.__open = false;
        }
      }
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
    this._annGroup.name = `__PMI_ANN__:${this.#getViewDisplayName('view')}`;
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

    // IMPORTANT: Remove PMI-specific accordion sections FIRST, then restore original sections
    // This prevents visual glitches where both sets of sections are visible simultaneously
    await this.#removePMISections();

    // Now restore original sidebar sections after PMI sections are completely removed
    this.#restoreOriginalSidebarSections();

    // Remove annotation group
    try { if (this._annGroup && this._annGroup.parent) this._annGroup.parent.remove(this._annGroup); } catch { }
    this._annGroup = null;
    try { if (this._refreshTimer) clearInterval(this._refreshTimer); } catch { } this._refreshTimer = null;
    try { this.hideDragPlaneHelper(); } catch { }
    // Remove labels overlay and destroy feature UIs
    try { this._labelOverlay?.dispose?.(); } catch { }
    this._labelOverlay = null;
    try { this._annotationWidget?.dispose?.(); } catch { }

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
      const entities = history ? history.getEntries() : [];
      const serializedAnnotations = baseSerialized.map((entry, idx) => {
        const entity = entities[idx] || null;
        const ann = entity?.inputParams || null;
        const handler = annotationRegistry.getSafe?.(ann?.type || entry.type) || annotationRegistry.getSafe?.(entry.type) || null;
        if (handler && typeof handler.serialize === 'function') {
          try {
            const custom = handler.serialize(ann, entry, { entity });
            if (custom) return custom;
          } catch {
            // fall back to base entry if serialize throws
          }
        }
        return entry;
      });
      this.viewEntry.annotations = JSON.parse(JSON.stringify(serializedAnnotations));

      this.#notifyViewMutated(refreshList);
    } catch { /* ignore */ }
  }

  #notifyViewMutated(refreshList = false) {
    let updated = null;
    try {
      const manager = this.viewer?.partHistory?.pmiViewsManager;
      if (manager) {
        if (Number.isFinite(this.viewIndex) && typeof manager.updateView === 'function') {
          updated = manager.updateView(this.viewIndex, this.viewEntry);
        }
        if (!updated && typeof manager.notifyChanged === 'function') {
          manager.notifyChanged();
        }
      }
    } catch { }

    if (!updated && this.pmiWidget && Number.isFinite(this.viewIndex) && Array.isArray(this.pmiWidget.views)) {
      this.pmiWidget.views[this.viewIndex] = this.viewEntry;
    }

    if (refreshList) {
      try { this.pmiWidget?.refreshFromHistory?.(); } catch { }
      try { this.pmiWidget?._renderList?.(); } catch { }
    }
  }

  #getViewDisplayName(fallback = 'View') {
    const entry = this.viewEntry;
    if (!entry || typeof entry !== 'object') return fallback;
    const nm = typeof entry.viewName === 'string' ? entry.viewName : entry.name;
    const trimmed = String(nm || '').trim();
    return trimmed || fallback;
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

      /* Overlay labels are defined in LabelOverlay.css */

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
      const containers = new Set();

      titles.forEach(title => {
        const container = title.closest('.accordion-section');
        if (container) containers.add(container);
        this._originalSections.push({
          element: title,
          display: title.style.display || '',
          visibility: title.style.visibility || ''
        });
        title.style.display = 'none';
      });

      contents.forEach(content => {
        const container = content.closest('.accordion-section');
        if (container) containers.add(container);
        this._originalSections.push({
          element: content,
          display: content.style.display || '',
          visibility: content.style.visibility || ''
        });
        content.style.display = 'none';
      });

      containers.forEach(container => {
        this._originalSections.push({
          element: container,
          display: container.style.display || '',
          visibility: container.style.visibility || ''
        });
        container.style.display = 'none';
      });
    } catch (e) {
      console.warn('Failed to hide original sidebar sections:', e);
    }
  }

  #restoreOriginalSidebarSections() {
    try {
      if (!this._originalSections) {
        return;
      }


      // Restore all original sections
      this._originalSections.forEach(({ element, display, visibility }, index) => {
        if (element && element.parentNode) {
          element.style.display = display;
          element.style.visibility = visibility;
        } else {
          console.warn(`Section ${index} element no longer exists in DOM`);
        }
      });

      this._originalSections = null;
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


      // Remove PMI sections from the accordion
      const sectionsToRemove = [
        'PMI Views (PMI Mode)',
        'Annotations - ' + this.#getViewDisplayName(''),
        'View Settings',
        'PMI Settings'
      ];


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
      const storedSections = [this._pmiModeViewsSection, this._pmiAnnotationsSection, this._pmiToolOptionsSection];
      const removeTarget = async (target) => {
        if (v.accordion && typeof v.accordion.removeSection === 'function') {
          try {
            const removed = await v.accordion.removeSection(target);
            if (removed) return true;
          } catch (e) {
            console.warn('Failed to remove section via API:', e);
          }
        }
        if (target && target.parentNode) {
          try { target.parentNode.removeChild(target); } catch { /* ignore */ }
          return true;
        }
        return false;
      };
      for (let index = 0; index < storedSections.length; index++) {
        const section = storedSections[index];
        if (!section || !section.uiElement) continue;
        try {
          await removeTarget(section);
        } catch (e) {
          console.warn(`Failed to remove stored section ${index}:`, e);
        }
      }

      // Aggressively search and remove any PMI-related elements
      try {
        const accordion = v.accordion.uiElement;

        // Look for elements with PMI-related text content
        const allTitles = Array.from(accordion.querySelectorAll('.accordion-title'));
        const allContents = Array.from(accordion.querySelectorAll('.accordion-content'));


        // Remove elements that match PMI section patterns
        for (const titleEl of allTitles) {
          const text = titleEl.textContent || '';
          if (text.includes('Annotations') || text === 'View Settings' || text === 'PMI Settings') {
            await removeTarget(titleEl);
          }
        }

        // Remove any remaining content elements that might have been missed
        for (const contentEl of allContents) {
          if (!contentEl.parentNode) continue; // Already removed
          const id = contentEl.id || '';
          const name = contentEl.getAttribute('name') || '';
          if (name.includes('Annotations') || name === 'accordion-content-View Settings' || name === 'accordion-content-PMI Settings' ||
            id.includes('Annotations') || id === 'accordion-content-View Settings' || id === 'accordion-content-PMI Settings') {
            await removeTarget(contentEl);
          }
        }

        // Additional cleanup: remove any elements that contain PMI-specific classes or content
        const pmiElements = accordion.querySelectorAll('.pmi-ann-list, .pmi-scrollable-content, .pmi-inline-menu, .pmi-ann-footer, .pmi-vfield');
        for (const el of pmiElements) {
          // Remove the entire parent accordion section if this is PMI content
          let parent = el.parentNode;
          while (parent && !parent.classList.contains('accordion-content')) {
            parent = parent.parentNode;
          }
          if (parent && parent.classList.contains('accordion-content')) {
            await removeTarget(parent);
          } else {
            await removeTarget(el);
          }
        }

        // Final nuclear option: remove any sections that weren't there originally
        // This is a bit aggressive but ensures complete cleanup
        const remainingTitles = Array.from(accordion.querySelectorAll('.accordion-title'));
        const originalSectionCount = this._originalSections ? Math.floor(this._originalSections.length / 2) : 0;

      } catch (e) {
        console.warn('Failed to manually clean up PMI section elements:', e);
      }

      // Try to remove sections using the accordion API as a fallback
      for (const title of sectionsToRemove) {
        try {
          if (v.accordion && typeof v.accordion.removeSection === 'function') {
            await v.accordion.removeSection(title);
          }
        } catch (e) {
          console.warn(`Failed to remove section "${title}" via API:`, e);
        }
      }

      // Clear stored section references
      this._pmiModeViewsSection = null;
      this._pmiAnnotationsSection = null;
      this._pmiToolOptionsSection = null;
      this._sectionCreationPromises = [];


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

      const annotationsPromise = this._acc.addSection(`Annotations - ${this.#getViewDisplayName('')}`).then((sec) => {
        try {
          const widgetWrap = document.createElement('div');
          widgetWrap.className = 'pmi-ann-widget-wrap';
          sec.uiElement.appendChild(widgetWrap);

          this._annotationWidget = new AnnotationCollectionWidget({
            history: this._annotationHistory,
            pmimode: this,
            onCollectionChange: () => {
              this.#updateAnnotationSectionTitle();
              this.#markAnnotationsDirty();
            },
            onEntryChange: () => {
              this.#updateAnnotationSectionTitle();
              this.#markAnnotationsDirty();
            },
          });
          widgetWrap.appendChild(this._annotationWidget.uiElement);

          this._pmiAnnotationsSection = sec;
          this.#updateAnnotationSectionTitle();
          this.#applyPMIPanelLayout();
        } catch (e) {
          console.warn('Failed to setup annotations section:', e);
        }
      });
      this._sectionCreationPromises.push(annotationsPromise);

      // PMI Settings section
      this._toolOptsEl = document.createElement('div');
      this._toolOptsEl.style.padding = '6px';
      const toolOptionsPromise = this._acc.addSection('PMI Settings').then((sec) => {
        try {
          sec.uiElement.appendChild(this._toolOptsEl);
          this.#renderToolOptions();
          this._pmiToolOptionsSection = sec;
          this.#applyPMIPanelLayout();
        } catch (e) {
          console.warn('Failed to setup tool options section:', e);
        }
      });
      this._sectionCreationPromises.push(toolOptionsPromise);

      this._annotationWidget?.render();
    } catch (e) {
      console.warn('Failed to mount PMI sections:', e);
    }
  }

  #applyPMIPanelLayout() {
    try {
      const acc = this.viewer?.accordion;
      if (!acc) return;
      const sections = [
        this._pmiModeViewsSection,
        this._pmiAnnotationsSection,
        this._pmiToolOptionsSection,
      ];
      if (typeof acc.prependSections === 'function') {
        const moved = acc.prependSections(sections);
        if (moved) return;
      }
      const accordion = acc.uiElement;
      if (!accordion) return;
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

  markAnnotationsDirty() {
    this.#markAnnotationsDirty();
  }

  normalizeAnnotation(annotation) {
    if (!annotation) return annotation;
    return this.#normalizeAnnotation(annotation);
  }

  handleAnnotationRemoval(entry) {
    if (!entry) return;
    try {
      const handler = annotationRegistry.getSafe?.(entry.type) || entry.constructor || null;
      const ann = entry.inputParams || {};
      if (handler && typeof handler._resolveSolidReferences === 'function') {
        try { handler._resolveSolidReferences(ann, this, false); } catch { /* ignore */ }
      }
      if (handler && typeof handler.restoreOriginalTransforms === 'function') {
        try { handler.restoreOriginalTransforms(ann, this); } catch { /* ignore */ }
      }
    } catch (error) {
      console.warn('PMI: handleAnnotationRemoval failed:', error);
    }
    try { this.applyViewTransformsSequential?.(); } catch { /* ignore */ }
  }

  #updateAnnotationSectionTitle() {
    try {
      const sec = this._pmiAnnotationsSection;
      if (!sec || !sec.uiElement) return;
      const titleEl = sec.uiElement.previousElementSibling;
      if (titleEl) {
        titleEl.textContent = `Annotations - ${this.#getViewDisplayName('')}`;
      }
    } catch { /* ignore */ }
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

    const dimDec = mkNumber(this._opts.dimDecimals, (v) => { this._opts.dimDecimals = v | 0; this._annotationWidget?.render(); }, { min: 0, max: 8 });
    el.appendChild(makeVField('Dim decimals', dimDec));

    // Global PMI style controls
    const style = getPMIStyle();
    const mkColor = (value, onChange) => {
      const wrap = document.createElement('div');
      wrap.className = 'pmi-color-wrap';
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = toHex(value);
      inp.className = 'pmi-color';
      inp.addEventListener('input', () => onChange(inp.value));
      wrap.appendChild(inp);
      return wrap;
    };

    const updateStyle = (patch) => {
      setPMIStyle(patch);
      this.#markAnnotationsDirty();
      this._annotationWidget?.render();
      this.#savePMIStyle();
    };

    el.appendChild(makeVField('Line color', mkColor(style.lineColor, (v) => updateStyle({ lineColor: hexToInt(v) }))));
    el.appendChild(makeVField('Dot color', mkColor(style.dotColor, (v) => updateStyle({ dotColor: hexToInt(v) }))));
    el.appendChild(makeVField('Arrow color', mkColor(style.arrowColor, (v) => updateStyle({ arrowColor: hexToInt(v) }))));
    const mkPxNumber = (label, key, min = 1, max = 64) => {
      const inp = mkNumber(style[key] ?? 0, (v) => updateStyle({ [key]: v }), { min, max });
      el.appendChild(makeVField(label, inp));
    };
    mkPxNumber('Line width', 'lineWidth', 1, 8);
    mkPxNumber('Arrow length (px)', 'arrowLengthPx', 1, 64);
    mkPxNumber('Arrow width (px)', 'arrowWidthPx', 1, 32);
    mkPxNumber('Leader dot (px)', 'leaderDotRadiusPx', 1, 32);
    mkPxNumber('Hole dot (px)', 'holeDotRadiusPx', 1, 32);
    mkPxNumber('Note dot radius', 'noteDotRadius', 0.01, 1);
  }

  #loadPMIStyle() {
    try {
      const raw = LS.getItem(this._pmiStyleStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        setPMIStyle(sanitizePMIStyle(parsed));
      }
    } catch (e) {
      console.warn('[PMI] Failed to load PMI style settings:', e);
    }
  }

  #savePMIStyle() {
    try {
      const style = sanitizePMIStyle(getPMIStyle());
      LS.setItem(this._pmiStyleStorageKey, JSON.stringify(style));
    } catch (e) {
      console.warn('[PMI] Failed to save PMI style settings:', e);
    }
  }

  #toggleWireframeMode(isWireframe) {
    try {
      const scene = this.viewer?.scene;
      if (!scene) return;

      const isFace = (obj) => !!obj && (obj.type === 'FACE' || typeof obj.userData?.faceName === 'string');
      const apply = (mat) => { if (mat && 'wireframe' in mat) mat.wireframe = !!isWireframe; };
      // Toggle wireframe only on face materials.
      scene.traverse((obj) => {
        if (!isFace(obj)) return;
        const m = obj.material;
        if (!m) return;
        if (Array.isArray(m)) m.forEach(apply); else apply(m);
      });

      // Trigger a render update
      if (this.viewer?.render) {
        this.viewer.render();
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

      const annotationEntities = this._annotationHistory ? this._annotationHistory.getEntries() : [];
      if (!Array.isArray(annotationEntities) || annotationEntities.length === 0) return;
      const activeEntities = annotationEntities.filter((entity) => entity?.enabled !== false);
      if (!activeEntities.length) return;

      const anns = activeEntities.map((entity) => entity?.inputParams || {});


      const handler = annotationRegistry.getSafe?.('viewTransform') || null;
      if (!handler) {
        console.warn('No handler found for viewTransform');
        return;
      }

      const viewAnns = [];
      for (const ann of anns) {
        if (ann.type === 'viewTransform' || ann.type === 'explodeBody'  || ann.type === 'exp') viewAnns.push(ann);
      }

      const cumulativeState = new Map();

      for (const ann of viewAnns) {

        if (typeof handler._resolveSolidReferences === 'function') {
          handler._resolveSolidReferences(ann, this, false);
        }

        if (typeof handler._ensureOriginalSnapshots === 'function') {
          const solids = Array.isArray(ann.solids) ? ann.solids : [];
          handler._ensureOriginalSnapshots(ann, solids, false, this.viewer);
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
      const entities = this._annotationHistory ? this._annotationHistory.getEntries() : [];
      if (!Array.isArray(entities) || entities.length === 0) return;

      const handler = annotationRegistry.getSafe?.('viewTransform') || null;
      if (!handler) return;

      for (const entity of entities) {
        if (entity?.enabled === false) continue;
        const ann = entity?.inputParams;
        if (!ann || (ann.type !== 'viewTransform' && ann.type !== 'explodeBody' && ann.type !== 'exp')) continue;

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
    try { this._annotationWidget?.render(); } catch { }
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
    try { this._labelOverlay?.clear?.(); } catch { }
    // Ensure overlay exists before we start populating labels
    const entities = this._annotationHistory ? this._annotationHistory.getEntries() : [];
    const ctx = {
      pmimode: this,
      screenSizeWorld: (px) => { try { return this.#_screenSizeWorld(px); } catch { return 0; } },
      alignNormal: (alignment, ann) => { try { return this.#_alignNormal(alignment, ann); } catch { return new THREE.Vector3(0, 0, 1); } },
      updateLabel: (idx, text, worldPos, ann) => { try { this._labelOverlay?.updateLabel?.(idx, text, worldPos, ann); } catch { } },
      formatReferenceLabel: (ann, text) => { try { return this.#formatReferenceLabel(ann, text); } catch { return text; } },
      // keep only generic helpers
      // specific drawing/measuring handled by annotation handlers now
    };
    this.__explodeTraceState = new Map();
    entities.forEach((entity, i) => {
      try {
        if (entity?.enabled === false) return;
        if (!entity || typeof entity.run !== 'function') return;
        if (!entity.persistentData || typeof entity.persistentData !== 'object') {
          entity.setPersistentData({});
        }
        const renderingContext = {
          pmimode: this,
          group,
          idx: i,
          ctx,
        };
        const runResult = entity.run(renderingContext);
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

    try {
      const entries = this._annotationHistory ? this._annotationHistory.getEntries() : [];
      const entity = entries[idx];
      if (!entity) return;
      const entryId = entity.inputParams?.id || entity.id || idx;
      this._annotationWidget?.render();
      requestAnimationFrame(() => {
        try {
          const form = this._annotationWidget?.getFormForEntry(String(entryId));
          const host = form?.uiElement;
          if (!host) return;
          const root = host.shadowRoot || host;
          const row = root?.querySelector('[data-key="text"]');
          const textField = row ? row.querySelector('textarea, input[type="text"], input') : null;
          if (textField) {
            textField.focus();
            textField.select?.();
          }
        } catch (error) {
          console.warn('Could not focus annotation dialog text field:', error);
        }
      });
    } catch (error) {
      console.warn('Failed to focus annotation dialog:', error);
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
    const entries = this._annotationHistory ? this._annotationHistory.getEntries() : [];
    if (!entries.length) return;
    if (!Number.isInteger(targetIdx) || targetIdx < 0 || targetIdx >= entries.length) return;
    let changed = false;
    entries.forEach((entry, i) => {
      const shouldOpen = i === targetIdx;
      if (!entry.runtimeAttributes || typeof entry.runtimeAttributes !== 'object') entry.runtimeAttributes = {};
      if (entry.runtimeAttributes.__open !== shouldOpen) {
        entry.runtimeAttributes.__open = shouldOpen;
        changed = true;
      }
      if (entry.inputParams && typeof entry.inputParams === 'object') {
        entry.inputParams.__open = shouldOpen;
      }
    });
    if (!changed) return;
    const targetEntry = entries[targetIdx];
    const targetId = targetEntry ? (targetEntry.inputParams?.id || targetEntry.id || targetIdx) : targetIdx;
    this._annotationWidget?.render();
    requestAnimationFrame(() => {
      try {
        const root = this._annotationWidget?._shadow;
        if (!root) return;
        const selector = `[data-entry-id="${cssEscape(String(targetId))}"]`;
        const item = root.querySelector(selector);
        if (item && typeof item.scrollIntoView === 'function') item.scrollIntoView({ block: 'nearest' });
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
          intersectPlane: (ray, plane, out) => { try { return this.#_intersectPlaneBothSides(ray, plane, out); } catch { return null; } },
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

  // Debug helper: visualize the plane used during label drags
  showDragPlaneHelper(plane) {
    try {
      if (!plane || !plane.normal) return;
      this.hideDragPlaneHelper();
      const scene = this.viewer?.scene;
      if (!scene) return;
      const size = this.#estimateSceneSpan();
      const divisions = Math.max(6, Math.min(60, Math.round(size)));
      const grid = new THREE.GridHelper(size, divisions, 0x00ffff, 0x00ffff);
      const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
      mats.forEach((m) => { if (m) { m.transparent = true; m.opacity = 0.35; m.depthWrite = false; } });
      const up = new THREE.Vector3(0, 1, 0);
      const n = plane.normal.clone().normalize();
      if (n.lengthSq() < 1e-12) return;
      const q = new THREE.Quaternion().setFromUnitVectors(up, n);
      grid.quaternion.copy(q);
      const center = plane.coplanarPoint(new THREE.Vector3());
      grid.position.copy(center);
      grid.renderOrder = 9998;
      grid.name = '__PMI_DRAG_PLANE__';
      scene.add(grid);
      this._dragPlaneHelper = grid;
    } catch { }
  }

  hideDragPlaneHelper() {
    try {
      const g = this._dragPlaneHelper;
      if (g && g.parent) g.parent.remove(g);
      if (g?.geometry) g.geometry.dispose?.();
      if (g?.material) {
        const mats = Array.isArray(g.material) ? g.material : [g.material];
        mats.forEach((m) => m?.dispose?.());
      }
    } catch { }
    this._dragPlaneHelper = null;
  }

  #estimateSceneSpan() {
    try {
      const scene = this.viewer?.partHistory?.scene || this.viewer?.scene;
      if (scene) {
        const box = new THREE.Box3().setFromObject(scene);
        if (!box.isEmpty()) {
          const size = box.getSize(new THREE.Vector3());
          const span = Math.max(size.x, size.y, size.z);
          if (Number.isFinite(span) && span > 0) return Math.min(Math.max(span * 1.25, 1), 2000);
        }
      }
    } catch { }
    return 20;
  }

  // Allow ray-plane intersection even when the plane is "behind" the ray origin
  // by retrying with a flipped ray direction (infinite line cast).
  #_intersectPlaneBothSides(ray, plane, out = new THREE.Vector3()) {
    try {
      if (!ray || !plane) return null;
      const direct = ray.intersectPlane(plane, out);
      if (direct) return out;
      const invRay = new THREE.Ray(ray.origin.clone(), ray.direction.clone().negate());
      return invRay.intersectPlane(plane, out);
    } catch { return null; }
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
      } else if (a.type === 'linear') {
        if ((!Array.isArray(a.targets) || a.targets.length === 0) && (a.aRefName || a.bRefName)) {
          a.targets = [a.aRefName, a.bRefName].filter(Boolean);
        }
      } else if (a.type === 'angle') {
        if ((!Array.isArray(a.targets) || a.targets.length === 0) && (a.elementARefName || a.elementBRefName)) {
          a.targets = [a.elementARefName, a.elementBRefName].filter(Boolean);
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

function toHex(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  const hex = `000000${(safe >>> 0).toString(16)}`.slice(-6);
  return `#${hex}`;
}

function hexToInt(value) {
  if (typeof value !== 'string') return 0;
  const str = value.startsWith('#') ? value.slice(1) : value;
  const n = parseInt(str, 16);
  return Number.isFinite(n) ? n : 0;
}
