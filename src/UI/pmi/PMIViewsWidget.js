// PMIViewsWidget.js
// ES6, no frameworks. Provides a simple list of saved PMI views
// (camera snapshots) with capture, rename, apply, and delete.
// Views are persisted with the PartHistory instance.

import * as THREE from 'three';
import { captureCameraSnapshot, applyCameraSnapshot, adjustOrthographicFrustum } from './annUtils.js';
import { AnnotationHistory } from './AnnotationHistory.js';

const UPDATE_CAMERA_TOOLTIP = 'Update this view to match the current camera';

export class PMIViewsWidget {
  constructor(viewer) {
    this.viewer = viewer;
    this.uiElement = document.createElement('div');
    this.uiElement.className = 'pmi-views-root';
    this._ensureStyles();

    this.views = [];
    this._activeViewIndex = null;
    this._activeMenu = null;
    this._menuOutsideHandler = null;
    this._onHistoryViewsChanged = (views) => {
      this.views = Array.isArray(views) ? views : this._getViewsFromHistory();
      this._renderList();
    };

    this._buildUI();
    this.refreshFromHistory();
    this._renderList();

    try {
      const manager = this.viewer?.partHistory?.pmiViewsManager;
      this._removeHistoryListener = manager ? manager.addListener(this._onHistoryViewsChanged) : null;
    } catch {
      this._removeHistoryListener = null;
    }
  }

  dispose() {
    if (typeof this._removeHistoryListener === 'function') {
      try { this._removeHistoryListener(); } catch {}
    }
    this._removeHistoryListener = null;
    this._closeActiveMenu();
  }

  refreshFromHistory() {
    this.views = this._getViewsFromHistory();
  }

  _getViewsFromHistory() {
    try {
      const manager = this.viewer?.partHistory?.pmiViewsManager;
      if (!manager || typeof manager.getViews !== 'function') return [];
      const views = manager.getViews();
      return Array.isArray(views) ? views : [];
    } catch {
      return [];
    }
  }

  _getActiveViewIndex() {
    const modeIndex = this.viewer?._pmiMode?.viewIndex;
    if (Number.isInteger(modeIndex) && modeIndex >= 0) return modeIndex;
    if (Number.isInteger(this._activeViewIndex) && this._activeViewIndex >= 0) return this._activeViewIndex;
    return null;
  }

  _setActiveViewIndex(index) {
    if (Number.isInteger(index) && index >= 0) {
      this._activeViewIndex = index;
    } else {
      this._activeViewIndex = null;
    }
  }

  _resolveViewName(view, index) {
    const fallback = `View ${index + 1}`;
    if (!view || typeof view !== 'object') return fallback;
    const name = typeof view.viewName === 'string' ? view.viewName : (typeof view.name === 'string' ? view.name : '');
    const trimmed = String(name || '').trim();
    return trimmed || fallback;
  }

  // ---- UI ----
  _ensureStyles() {
    if (document.getElementById('pmi-views-widget-styles')) return;
    const style = document.createElement('style');
    style.id = 'pmi-views-widget-styles';
    style.textContent = `
      .pmi-views-root { padding: 6px; }
      .pmi-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-bottom: 1px solid #1f2937; background: transparent; transition: background-color .12s ease; position: relative; }
      .pmi-row:hover { background: #0f172a; }
      .pmi-row.header { background: #111827; border-bottom: 1px solid #1f2937; padding-bottom: 8px; margin-bottom: 6px; border-radius: 4px; }
      .pmi-row.active { background: #0f172a; border-color: #2563eb; box-shadow: 0 0 0 1px rgba(37,99,235,.35); }
      .pmi-grow { flex: 1 1 auto; min-width: 0; }
      .pmi-input { width: 100%; box-sizing: border-box; padding: 6px 8px; background: #0b0e14; color: #e5e7eb; border: 1px solid #374151; border-radius: 8px; outline: none; transition: border-color .15s ease, box-shadow .15s ease; }
      .pmi-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
      .pmi-btn { background: rgba(255,255,255,.03); color: #f9fafb; border: 1px solid #374151; padding: 4px 8px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 12px; line-height: 1; height: 26px; display: inline-flex; align-items: center; justify-content: center; transition: border-color .15s ease, background-color .15s ease, transform .05s ease; }
      .pmi-btn.icon { width: 26px; padding: 0; font-size: 16px; }
      .pmi-btn:hover { border-color: #3b82f6; background: rgba(59,130,246,.12); }
      .pmi-btn:active { transform: translateY(1px); }
      .pmi-btn.danger { border-color: #7f1d1d; color: #fecaca; }
      .pmi-btn.danger:hover { border-color: #ef4444; background: rgba(239,68,68,.15); color: #fff; }
      .pmi-list { display: flex; flex-direction: column; gap: 2px; }
      .pmi-name { font-weight: 600; color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pmi-name-btn { background: none; border: none; padding: 0; margin: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; display: block; width: 100%; }
      .pmi-name-btn:hover { color: #93c5fd; }
      .pmi-name-btn:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
      .pmi-row-menu { position: absolute; right: 6px; top: calc(100% + 4px); background: #0b1120; border: 1px solid #1f2937; border-radius: 10px; padding: 8px; display: none; flex-direction: column; gap: 6px; min-width: 180px; box-shadow: 0 12px 24px rgba(0,0,0,.45); z-index: 20; }
      .pmi-row-menu.open { display: flex; }
      .pmi-row-menu .pmi-btn { width: 100%; justify-content: flex-start; }
      .pmi-row-menu .pmi-btn.danger { justify-content: center; }
      .pmi-row-menu-wireframe { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #e5e7eb; }
      .pmi-row-menu hr { border: none; border-top: 1px solid #1f2937; margin: 4px 0; }
    `;
    document.head.appendChild(style);
  }

  _buildUI() {
    // Header: input for new view name + Capture button
    const header = document.createElement('div');
    header.className = 'pmi-row header';

    const newViewLabel = document.createElement('div');
    newViewLabel.className = 'pmi-name pmi-grow';
    newViewLabel.textContent = 'New view';
    newViewLabel.title = 'Capture the current camera as a new PMI view';
    header.appendChild(newViewLabel);

    const capBtn = document.createElement('button');
    capBtn.className = 'pmi-btn';
    capBtn.title = 'Capture current camera as a view';
    capBtn.textContent = 'Capture';
    capBtn.addEventListener('click', () => this._captureCurrent());
    header.appendChild(capBtn);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'pmi-btn';
    exportBtn.title = 'Export all PMI views as images';
    exportBtn.textContent = 'Export Images';
    exportBtn.addEventListener('click', () => { this._exportImages(); });
    header.appendChild(exportBtn);

    this.uiElement.appendChild(header);

    this.listEl = document.createElement('div');
    this.listEl.className = 'pmi-list';
    this.uiElement.appendChild(this.listEl);
  }

  _renderList() {
    this._closeActiveMenu();
    this.listEl.textContent = '';
    const views = Array.isArray(this.views) ? this.views : [];
    const activeIndex = this._getActiveViewIndex();
    views.forEach((v, idx) => {
      const row = document.createElement('div');
      row.className = 'pmi-row';
      if (idx === activeIndex) {
        row.classList.add('active');
        row.setAttribute('aria-current', 'true');
      }

      const viewName = this._resolveViewName(v, idx);
      const nameButton = document.createElement('button');
      nameButton.type = 'button';
      nameButton.className = 'pmi-name pmi-name-btn pmi-grow';
      nameButton.textContent = viewName;
      nameButton.title = 'Click to edit annotations for this view';
      nameButton.addEventListener('click', () => {
        this._enterEditMode(v, idx);
        setTimeout(() => this._enterEditMode(v, idx), 200);
      });
      row.appendChild(nameButton);

      const startRename = () => {
        this._closeActiveMenu();
        if (!row.contains(nameButton)) {
          const existingInput = row.querySelector('input.pmi-input');
          if (existingInput) {
            existingInput.focus();
            existingInput.select?.();
          }
          return;
        }
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = viewName;
        nameInput.className = 'pmi-input pmi-grow';

        let finished = false;
        const finishRename = (commit) => {
          if (finished) return;
          finished = true;
          if (commit) {
            const fallback = viewName;
            const newName = nameInput.value.trim();
            const finalName = newName || fallback;
            if (finalName !== viewName) {
              const updateFn = (entry) => {
                if (!entry || typeof entry !== 'object') return entry;
                entry.viewName = finalName;
                entry.name = finalName;
                return entry;
              };
              const manager = this.viewer?.partHistory?.pmiViewsManager;
              const updated = manager?.updateView?.(idx, updateFn);
              if (!updated) {
                updateFn(v);
                this.refreshFromHistory();
              }
            }
          }
          this._renderList();
        };

        nameInput.addEventListener('keydown', (evt) => {
          if (evt.key === 'Enter') {
            finishRename(true);
          } else if (evt.key === 'Escape') {
            finishRename(false);
          }
        });
        nameInput.addEventListener('blur', () => finishRename(true));

        row.replaceChild(nameInput, nameButton);
        nameInput.focus();
        nameInput.select();
      };

      const deleteView = () => {
        const manager = this.viewer?.partHistory?.pmiViewsManager;
        const removed = manager?.removeView?.(idx);
        if (!removed) {
          this.views.splice(idx, 1);
          this.refreshFromHistory();
        }
        this._renderList();
      };

      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = 'pmi-btn icon';
      menuBtn.title = 'View options';
      menuBtn.setAttribute('aria-label', 'View options');
      menuBtn.textContent = '⋯';

      const menu = document.createElement('div');
      menu.className = 'pmi-row-menu';

      const makeMenuButton = (label, handler, opts = {}) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `pmi-btn${opts.danger ? ' danger' : ''}`;
        btn.textContent = label;
        if (opts.title) btn.title = opts.title;
        btn.addEventListener('click', (evt) => {
          evt.stopPropagation();
          handler();
          this._closeActiveMenu();
        });
        return btn;
      };

      menu.appendChild(makeMenuButton('Update Camera', () => this._updateViewCamera(idx), { title: UPDATE_CAMERA_TOOLTIP }));
      menu.appendChild(makeMenuButton('Rename View', startRename));
      menu.appendChild(makeMenuButton('Delete View', deleteView, { danger: true, title: 'Delete this view' }));
      const divider = document.createElement('hr');
      menu.appendChild(divider);

      const wireframeLabel = document.createElement('label');
      wireframeLabel.className = 'pmi-row-menu-wireframe';
      const wireframeCheckbox = document.createElement('input');
      wireframeCheckbox.type = 'checkbox';
      const storedWireframe = (v.viewSettings || v.settings)?.wireframe;
      wireframeCheckbox.checked = (typeof storedWireframe === 'boolean') ? storedWireframe : false;
      wireframeCheckbox.addEventListener('change', (evt) => {
        evt.stopPropagation();
        this._setViewWireframe(idx, Boolean(wireframeCheckbox.checked));
      });
      const wireframeText = document.createElement('span');
      wireframeText.textContent = 'Wireframe';
      wireframeLabel.appendChild(wireframeCheckbox);
      wireframeLabel.appendChild(wireframeText);
      menu.appendChild(wireframeLabel);

      menuBtn.addEventListener('click', (evt) => {
        evt.stopPropagation();
        this._toggleRowMenu(menu, menuBtn);
      });

      row.appendChild(menuBtn);
      row.appendChild(menu);

      row.addEventListener('dblclick', (e) => {
        const target = e.target;
        const tagName = target?.tagName;
        if (menu.contains(target) || target === menuBtn || tagName === 'INPUT') return;
        this._applyView(v, { index: idx });
      });

      this.listEl.appendChild(row);
    });
  }

  _toggleRowMenu(menu, trigger) {
    if (this._activeMenu && this._activeMenu !== menu) {
      this._closeActiveMenu();
    }
    if (menu.classList.contains('open')) {
      this._closeActiveMenu();
      return;
    }
    menu.classList.add('open');
    this._activeMenu = menu;
    this._menuOutsideHandler = (evt) => {
      if (!this._activeMenu) return;
      if (this._activeMenu.contains(evt.target) || trigger.contains(evt.target)) return;
      this._closeActiveMenu();
    };
    setTimeout(() => {
      if (this._menuOutsideHandler) {
        document.addEventListener('mousedown', this._menuOutsideHandler);
      }
    }, 0);
  }

  _closeActiveMenu() {
    if (this._activeMenu) {
      this._activeMenu.classList.remove('open');
      this._activeMenu = null;
    }
    if (this._menuOutsideHandler) {
      document.removeEventListener('mousedown', this._menuOutsideHandler);
      this._menuOutsideHandler = null;
    }
  }

  // ---- Actions ----
  async _captureCurrent() {
    try {
      const v = this.viewer;
      const cam = v?.camera;
      if (!cam) return;
      const cameraSnap = captureCameraSnapshot(cam, { controls: this.viewer?.controls });
      if (!cameraSnap) return;
      const fallbackIndex = Array.isArray(this.views) ? this.views.length : 0;
      const defaultName = `View ${fallbackIndex + 1}`;
      const promptFn = (typeof window !== 'undefined' && typeof window.prompt === 'function')
        ? window.prompt.bind(window)
        : (typeof prompt === 'function' ? prompt : null);
      const response = promptFn ? await promptFn('Enter a name for this view', defaultName) : defaultName;
      if (response === null) return; // user cancelled
      const name = String(response || '').trim() || defaultName;
      const snap = {
        viewName: name,
        name,
        camera: cameraSnap,
        // Persist basic view settings (extensible). Currently only wireframe render mode.
        viewSettings: {
          wireframe: this._detectWireframe(v?.scene)
        },
        annotations: [],
      };
      const manager = this.viewer?.partHistory?.pmiViewsManager;
      const added = manager?.addView?.(snap);
      if (!added) {
        this.views.push(snap);
        this.refreshFromHistory();
      }
      const newIndex = Array.isArray(this.views) ? Math.max(0, (this.views.length - 1)) : 0;
      this._setActiveViewIndex(newIndex);
      this._renderList();
    } catch { /* ignore */ }
  }

  async _exportImages() {
    if (this._exportingImages) return;
    const views = Array.isArray(this.views) ? this.views : [];
    if (!views.length) {
      alert('No PMI views to export.');
      return;
    }

    const viewer = this.viewer;
    const canvas = viewer?.renderer?.domElement;
    if (!viewer || !canvas) {
      alert('Viewer is not ready to export images.');
      return;
    }

    const captures = [];
    try {
      await this._withViewCubeHidden(async () => {
        this._exportingImages = true;
        const originalSnapshot = captureCameraSnapshot(viewer.camera, { controls: viewer.controls });
        const originalWireframe = this._detectWireframe(viewer.scene);
        const previousActive = this._getActiveViewIndex();

        try {
          for (let i = 0; i < views.length; i++) {
            const view = views[i];
            const name = this._resolveViewName(view, i);
            this._applyView(view, { index: i, suppressActive: true });
            const overlay = await this._buildExportAnnotations(view);
            await this._renderAndWait(2);
            const dataUrl = await this._captureCanvasImage(overlay.labels);
            if (!dataUrl) {
              throw new Error(`Failed to capture image for view "${name}"`);
            }
            captures.push({ name, dataUrl });
            try { overlay.cleanup?.(); } catch { }
          }
        } finally {
          this._restoreViewState(originalSnapshot, originalWireframe);
          if (previousActive != null) {
            this._setActiveViewIndex(previousActive);
            this._renderList();
          }
          this._exportingImages = false;
        }
      });
    } catch (err) {
      console.error('PMI export failed:', err);
      alert(`Export failed: ${err?.message || err}`);
      return;
    }

    if (!captures.length) {
      alert('No images were captured.');
      return;
    }

    const popup = (typeof window !== 'undefined' && typeof window.open === 'function')
      ? window.open('', '_blank')
      : null;
    if (!popup) {
      alert('Images generated, but pop-ups were blocked. Please allow pop-ups to view them.');
      return;
    }

    const doc = popup.document;
    doc.title = 'PMI View Images';
    doc.body.textContent = '';

    this._injectExportStyles(doc);

    const title = doc.createElement('div');
    title.className = 'pmi-export-title';
    title.textContent = 'PMI View Images';
    doc.body.appendChild(title);

    const grid = doc.createElement('div');
    grid.className = 'pmi-export-grid';
    doc.body.appendChild(grid);

    for (const { name, dataUrl } of captures) {
      const card = doc.createElement('div');
      card.className = 'pmi-export-card';
      const img = doc.createElement('img');
      img.src = dataUrl;
      img.alt = name;
      const caption = doc.createElement('div');
      caption.className = 'pmi-export-caption';
      caption.textContent = name;
      card.appendChild(img);
      card.appendChild(caption);
      grid.appendChild(card);
    }
  }

  // Generate labeled PNGs for all views (for packaging into 3MF). Throws on failure.
  async captureViewImagesForPackage() {
    if (this._exportingImages) throw new Error('PMI view export already in progress');
    const views = Array.isArray(this.views) ? this.views : [];
    if (!views.length) return {};

    const viewer = this.viewer;
    const canvas = viewer?.renderer?.domElement;
    if (!viewer || !canvas) throw new Error('Viewer is not ready to export images');

    const captures = [];
    try {
      await this._withViewCubeHidden(async () => {
        this._exportingImages = true;
        const originalSnapshot = captureCameraSnapshot(viewer.camera, { controls: viewer.controls });
        const originalWireframe = this._detectWireframe(viewer.scene);
        const previousActive = this._getActiveViewIndex();

        try {
          for (let i = 0; i < views.length; i++) {
            const view = views[i];
            const name = this._resolveViewName(view, i);
            this._applyView(view, { index: i, suppressActive: true });
            const overlay = await this._buildExportAnnotations(view);
            await this._renderAndWait(2);
            const dataUrl = await this._captureCanvasImage(overlay.labels);
            if (!dataUrl) {
              throw new Error(`Failed to capture image for view "${name}"`);
            }
            captures.push({ name, dataUrl });
            try { overlay.cleanup?.(); } catch { }
          }
        } finally {
          this._restoreViewState(originalSnapshot, originalWireframe);
          if (previousActive != null) {
            this._setActiveViewIndex(previousActive);
            this._renderList();
          }
          this._exportingImages = false;
        }
      });
    } finally {
    }

    const files = {};
    captures.forEach(({ name, dataUrl }) => {
      const fileName = `${this._safeFileName(name, 'view')}.png`;
      const path = `views/${fileName}`;
      files[path] = this._dataUrlToUint8Array(dataUrl);
    });
    return files;
  }

  async _buildExportAnnotations(view) {
    const cleanup = () => {};
    try {
      const viewer = this.viewer;
      const scene = viewer?.partHistory?.scene || viewer?.scene;
      if (!viewer || !scene) return { labels: [], cleanup };

      const pmimode = {
        viewer,
        _opts: {
          dimDecimals: 3,
          angleDecimals: 1,
          noteText: '',
          leaderText: 'TEXT HERE',
        },
        __explodeTraceState: new Map(),
      };
      const history = new AnnotationHistory(pmimode);
      try { history.load(Array.isArray(view?.annotations) ? view.annotations : []); } catch { }
      const entries = history.getEntries();
      if (!entries.length) return { labels: [], cleanup };

      const group = new THREE.Group();
      group.name = '__PMI_EXPORT_ANN__';
      group.renderOrder = 9994;
      scene.add(group);

      const labels = [];
      const ctx = {
        screenSizeWorld: (px) => this._screenSizeWorld(px),
        alignNormal: (alignment, ann) => this._alignNormal(alignment, ann),
        formatReferenceLabel: (ann, text) => this._formatReferenceLabel(ann, text),
        updateLabel: (idx, text, worldPos, ann) => {
          if (!worldPos || text == null) return;
          const world = this._normalizeLabelPosition(worldPos);
          if (!world) return;
          labels[idx] = {
            text: String(text),
            world,
            anchor: ann?.anchorPosition || ann?.alignmentAnchor || null,
          };
        },
      };

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || typeof entry.run !== 'function' || entry.enabled === false) continue;
        // eslint-disable-next-line no-await-in-loop
        await entry.run({ pmimode, group, idx: i, ctx });
      }

      if (entries.length && labels.length === 0) {
        throw new Error('Annotation export produced no labels');
      }

      const cleanupFn = () => {
        try { scene.remove(group); } catch { }
      };
      return { labels: labels.filter(Boolean), cleanup: cleanupFn };
    } catch (err) {
      throw err;
    }
  }

  async _captureCanvasImage(labels = []) {
    const canvas = this.viewer?.renderer?.domElement;
    const camera = this.viewer?.camera;
    if (!canvas || !camera) throw new Error('Renderer not ready for capture');
    const width = canvas.width || canvas.clientWidth || 1;
    const height = canvas.height || canvas.clientHeight || 1;
    const baseData = canvas.toDataURL('image/png');
    if (!Array.isArray(labels) || labels.length === 0) return baseData;

    const cssWidth = canvas.clientWidth || width;
    const cssHeight = canvas.clientHeight || height;
    const svgMarkup = this._composeLabelSVG(baseData, labels, width, height, cssWidth, cssHeight);
    if (!svgMarkup) throw new Error('Failed to compose SVG for labels');
    const svgPng = await this._svgToPngDataUrl(svgMarkup, width, height);
    if (!svgPng) throw new Error('Failed to convert SVG to PNG');
    return svgPng;
  }

  _resolveLabelAnchorOffsets(anchor) {
    const key = String(anchor || '').toLowerCase();
    if (key === 'left top') return { ox: 1, oy: 0 };
    if (key === 'left middle') return { ox: 1, oy: 0.5 };
    if (key === 'left bottom') return { ox: 1, oy: 1 };
    if (key === 'right top') return { ox: 0, oy: 0 };
    if (key === 'right middle') return { ox: 0, oy: 0.5 };
    if (key === 'right bottom') return { ox: 0, oy: 1 };
    return { ox: 0.5, oy: 0.5 };
  }

  _projectWorldToScreen(world, camera, viewport) {
    try {
      if (!world || !camera) return null;
      const { width = 1, height = 1 } = viewport || {};
      const v = world.clone ? world.clone() : new THREE.Vector3(world.x || 0, world.y || 0, world.z || 0);
      v.project(camera);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
      return {
        x: (v.x * 0.5 + 0.5) * width,
        y: (-v.y * 0.5 + 0.5) * height,
      };
    } catch { return null; }
  }

  _normalizeLabelPosition(worldPos) {
    try {
      if (!worldPos) return null;
      if (worldPos.isVector3) return worldPos.clone();
      if (Array.isArray(worldPos) && worldPos.length >= 3) {
        return new THREE.Vector3(Number(worldPos[0]) || 0, Number(worldPos[1]) || 0, Number(worldPos[2]) || 0);
      }
      if (typeof worldPos === 'object') {
    return new THREE.Vector3(Number(worldPos.x) || 0, Number(worldPos.y) || 0, Number(worldPos.z) || 0);
      }
      return null;
    } catch { return null; }
  }

  _drawRoundedRect(ctx, x, y, w, h, r = 6, fill = '#0f172a', stroke = '#1f2937') {
    const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _screenSizeWorld(pixels = 1) {
    try {
      const canvasRect = this.viewer?.renderer?.domElement?.getBoundingClientRect?.() || { width: 800, height: 600 };
      const wpp = this._worldPerPixel(this.viewer?.camera, canvasRect.width, canvasRect.height);
      return Math.max(0.0001, wpp * (pixels || 1));
    } catch { return 0.01; }
  }

  _worldPerPixel(camera, width, height) {
    try {
      if (camera && camera.isOrthographicCamera) {
        const zoom = (typeof camera.zoom === 'number' && camera.zoom > 0) ? camera.zoom : 1;
        const safeW = width || 1;
        const safeH = height || 1;
        const wppX = (camera.right - camera.left) / (safeW * zoom);
        const wppY = (camera.top - camera.bottom) / (safeH * zoom);
        return Math.max(Math.abs(wppX), Math.abs(wppY));
      }
      const dist = camera?.position?.length?.() || 1;
      const fovRad = (camera?.fov || 60) * Math.PI / 180;
      const h = 2 * Math.tan(fovRad / 2) * dist;
      return h / (height || 1);
    } catch { return 1; }
  }

  _alignNormal(alignment, ann) {
    try {
      const name = ann?.planeRefName || ann?.planeRef || '';
      if (name) {
        const scene = this.viewer?.partHistory?.scene;
        const obj = scene?.getObjectByName(name);
        if (obj) {
          if (obj.type === 'FACE' && typeof obj.getAverageNormal === 'function') {
            const local = obj.getAverageNormal().clone();
            const nm = new THREE.Matrix3(); nm.getNormalMatrix(obj.matrixWorld);
            return local.applyMatrix3(nm).normalize();
          }
          const w = new THREE.Vector3(0, 0, 1);
          try { obj.updateMatrixWorld(true); w.applyMatrix3(new THREE.Matrix3().getNormalMatrix(obj.matrixWorld)); } catch { }
          if (w.lengthSq()) return w.normalize();
        }
      }
    } catch { /* ignore */ }
    const mode = String(alignment || 'view').toLowerCase();
    if (mode === 'xy') return new THREE.Vector3(0, 0, 1);
    if (mode === 'yz') return new THREE.Vector3(1, 0, 0);
    if (mode === 'zx') return new THREE.Vector3(0, 1, 0);
    const n = new THREE.Vector3();
    try { this.viewer?.camera?.getWorldDirection?.(n); } catch { }
    return n.lengthSq() ? n : new THREE.Vector3(0, 0, 1);
  }

  _formatReferenceLabel(ann, text) {
    try {
      const t = String(text ?? '');
      if (!t) return t;
      if (ann && (ann.isReference === true)) return `(${t})`;
      return t;
    } catch { return text; }
  }

  _composeLabelSVG(baseImage, labels, width, height, cssWidth = null, cssHeight = null) {
    if (!baseImage) throw new Error('Base image missing for SVG composition');
    const camera = this.viewer?.camera;
    const safeCssWidth = Math.max(1, cssWidth || width);
    const safeCssHeight = Math.max(1, cssHeight || height);
    const dpr = Math.max(1, width / safeCssWidth);
    const paddingX = 8 * dpr;
    const paddingY = 6 * dpr;
    const lineHeight = 18 * dpr;
    const radius = 8 * dpr;
    const fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    const fontSize = 14 * dpr;

    const layout = [];
    labels.forEach((label) => {
      if (!label || !label.world || label.text == null) return;
      const screen = this._projectWorldToScreen(label.world, camera, { width, height });
      if (!screen) return;
      const lines = String(label.text).split(/\r?\n/);
      const textWidth = lines.reduce((max, line) => Math.max(max, this._measureTextApprox(line, fontSize, fontFamily)), 0);
      const boxWidth = textWidth + paddingX * 2;
      const boxHeight = lines.length * lineHeight + paddingY * 2;
      const { ox, oy } = this._resolveLabelAnchorOffsets(label.anchor);
      const x = screen.x - ox * boxWidth;
      const y = screen.y - oy * boxHeight;
      layout.push({ x, y, boxWidth, boxHeight, lines });
    });

    if (!layout.length && labels.length) {
      throw new Error('No label positions resolved for SVG composition');
    }

    const escape = (s) => this._escapeXML(String(s));
    const rects = layout.map(({ x, y, boxWidth, boxHeight }) =>
      `<rect x="${x.toFixed(3)}" y="${y.toFixed(3)}" rx="${radius}" ry="${radius}" width="${boxWidth.toFixed(3)}" height="${boxHeight.toFixed(3)}" fill="rgba(17,24,39,0.92)" stroke="#111827" stroke-width="1"/>`).join('');

    const texts = layout.map(({ x, y, lines }) => {
      const parts = [];
      const startY = y + paddingY + lineHeight / 2;
      const textX = x + paddingX;
      lines.forEach((line, idx) => {
        const ty = startY + lineHeight * idx;
        parts.push(`<text x="${textX.toFixed(3)}" y="${ty.toFixed(3)}" font-family="${escape(fontFamily)}" font-size="${fontSize}" font-weight="700" fill="#ffffff" dominant-baseline="middle">${escape(line)}</text>`);
      });
      return parts.join('');
    }).join('');

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <image href="${baseImage}" x="0" y="0" width="${width}" height="${height}" />
        ${rects}
        ${texts}
      </svg>
    `;
    return svg;
  }

  _measureTextApprox(text, fontSize = 14, _family = '') {
    if (!text) return 0;
    const avg = fontSize * 0.56; // rough average width per char
    return Math.max(fontSize, avg * String(text).length);
  }

  async _svgToPngDataUrl(svgMarkup, width, height) {
    const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      const dataUrl = await new Promise((resolve, reject) => {
        img.onload = () => {
          try {
            const out = document.createElement('canvas');
            out.width = width;
            out.height = height;
            const ctx = out.getContext('2d');
            if (!ctx) { reject(new Error('No 2D context for SVG rasterization')); return; }
            ctx.drawImage(img, 0, 0, width, height);
            resolve(out.toDataURL('image/png'));
          } catch (e) { reject(e); }
        };
        img.onerror = (e) => reject(e || new Error('Image load error for SVG'));
        img.src = url;
      });
      return dataUrl;
    } finally {
      try { URL.revokeObjectURL(url); } catch { }
    }
  }

  _escapeXML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _dataUrlToUint8Array(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      throw new Error('Invalid data URL for PNG export');
    }
    const parts = dataUrl.split(',');
    if (parts.length < 2) throw new Error('Malformed data URL');
    const base64 = parts[1];
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  _safeFileName(raw, fallback = 'view') {
    const s = String(raw || '').trim() || fallback;
    return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || fallback;
  }


  _injectExportStyles(doc) {
    try {
      if (!doc || doc.getElementById('pmi-export-styles')) return;
      const style = doc.createElement('style');
      style.id = 'pmi-export-styles';
      style.textContent = `
        body { margin: 16px; background: #0b0e14; color: #e5e7eb; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
        .pmi-export-title { font-size: 16px; font-weight: 700; margin-bottom: 12px; }
        .pmi-export-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
        .pmi-export-card { background: #0f172a; border: 1px solid #1f2937; border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 8px 20px rgba(0,0,0,.45); }
        .pmi-export-card img { width: 100%; border-radius: 8px; background: #000; }
        .pmi-export-caption { font-weight: 600; word-break: break-word; }
      `;
      doc.head.appendChild(style);
    } catch { /* ignore style injection failures */ }
  }

  _awaitNextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  async _renderAndWait(frames = 1) {
    const count = Math.max(1, frames | 0);
    for (let i = 0; i < count; i++) {
      try { this.viewer?.render?.(); } catch { }
      await this._awaitNextFrame();
    }
    try { this.viewer?.render?.(); } catch { }
  }

  _withViewCubeHidden(fn) {
    const cube = this.viewer?.viewCube || null;
    if (!cube) return fn();
    const prevRender = cube.render;
    const prevVisible = cube.scene?.visible;
    return (async () => {
      try {
        if (cube.scene) cube.scene.visible = false;
        cube.render = () => {};
        return await fn();
      } finally {
        cube.render = prevRender;
        if (cube.scene && prevVisible !== undefined) cube.scene.visible = prevVisible;
      }
    })();
  }

  _restoreViewState(snapshot, wireframe) {
    try {
      const viewer = this.viewer;
      if (snapshot && viewer?.camera) {
        const dom = viewer?.renderer?.domElement;
        const rect = dom?.getBoundingClientRect?.();
        const viewport = {
          width: rect?.width || dom?.width || 1,
          height: rect?.height || dom?.height || 1,
        };
        applyCameraSnapshot(viewer.camera, snapshot, { controls: viewer.controls, respectParent: true, syncControls: true, viewport });
        adjustOrthographicFrustum(viewer.camera, snapshot?.projection || null, viewport);
      }
      if (typeof wireframe === 'boolean') {
        this._applyWireframe(viewer?.scene, wireframe);
      }
      try { viewer?.render?.(); } catch { }
    } catch { /* ignore restore errors */ }
  }

  _applyView(view, { index = null, suppressActive = false } = {}) {
    try {
      const v = this.viewer;
      const cam = v?.camera;
      if (!cam || !view || !view.camera) return;

      const ctrls = this.viewer?.controls;
      const dom = this.viewer?.renderer?.domElement;
      const rect = dom?.getBoundingClientRect?.();
      const viewport = {
        width: rect?.width || dom?.width || 1,
        height: rect?.height || dom?.height || 1,
      };
      const applied = applyCameraSnapshot(cam, view.camera, { controls: ctrls, respectParent: true, syncControls: false, viewport });

      if (!applied) {
        // Fallback for legacy snapshots that somehow failed the structured restore
        const legacy = view.camera;
        if (legacy.position) {
          cam.position.set(legacy.position.x, legacy.position.y, legacy.position.z);
        }
        if (legacy.quaternion) {
          cam.quaternion.set(legacy.quaternion.x, legacy.quaternion.y, legacy.quaternion.z, legacy.quaternion.w);
        }
        if (legacy.up) {
          cam.up.set(legacy.up.x, legacy.up.y, legacy.up.z);
        }
        if (typeof legacy.zoom === 'number' && Number.isFinite(legacy.zoom) && legacy.zoom > 0) {
          cam.zoom = legacy.zoom;
        }
        if (legacy.target && ctrls) {
          try {
            if (typeof ctrls.setTarget === 'function') {
              ctrls.setTarget(legacy.target.x, legacy.target.y, legacy.target.z);
            } else if (ctrls.target) {
              ctrls.target.set(legacy.target.x, legacy.target.y, legacy.target.z);
            }
          } catch { /* ignore */ }
        }
        adjustOrthographicFrustum(cam, legacy?.projection || null, viewport);
        cam.updateMatrixWorld(true);
        try { ctrls?.update?.(); } catch {}
      }
      adjustOrthographicFrustum(cam, view.camera?.projection || null, viewport);
      try { ctrls?.updateMatrixState?.(); } catch {}
      // Apply persisted view settings (e.g., wireframe) if present
      try {
        const vs = view.viewSettings || {};
        if (typeof vs.wireframe === 'boolean') {
          this._applyWireframe(v?.scene, vs.wireframe);
        }
      } catch { }
      try { this.viewer.render(); } catch { }
      if (!suppressActive && Number.isInteger(index)) {
        this._setActiveViewIndex(index);
        this._renderList();
      }
    } catch { /* ignore */ }
  }

  _setViewWireframe(index, isWireframe) {
    const applyFlag = (entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      if (!entry.viewSettings || typeof entry.viewSettings !== 'object') {
        entry.viewSettings = {};
      }
      entry.viewSettings.wireframe = isWireframe;
      return entry;
    };

    let updated = false;
    const manager = this.viewer?.partHistory?.pmiViewsManager;
    if (manager && typeof manager.updateView === 'function') {
      const result = manager.updateView(index, (entry) => applyFlag(entry));
      updated = Boolean(result);
    } else if (Array.isArray(this.views) && this.views[index]) {
      applyFlag(this.views[index]);
      updated = true;
      this.refreshFromHistory();
    }

    if (!updated) {
      this.refreshFromHistory();
      this._renderList();
    }

    const activePMI = this.viewer?._pmiMode;
    if (activePMI && Number.isInteger(activePMI.viewIndex) && activePMI.viewIndex === index) {
      try {
        this._applyWireframe(this.viewer?.scene, isWireframe);
      } catch { /* ignore */ }
    }
  }

  _updateViewCamera(index) {
    try {
      const camera = this.viewer?.camera;
      if (!camera) return;
      const ctrls = this.viewer?.controls;
      const snap = captureCameraSnapshot(camera, { controls: ctrls });
      if (!snap) return;

      let updated = false;
      const manager = this.viewer?.partHistory?.pmiViewsManager;
      if (manager && typeof manager.updateView === 'function') {
        const result = manager.updateView(index, (entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          entry.camera = snap;
          return entry;
        });
        updated = Boolean(result);
      } else if (Array.isArray(this.views) && this.views[index]) {
        this.views[index].camera = snap;
        updated = true;
        this.refreshFromHistory();
      }

      if (!updated) {
        this.refreshFromHistory();
        this._renderList();
      }
    } catch { /* ignore */ }
  }

  async _enterEditMode(view, index) {
    try {
      const activePMI = this.viewer?._pmiMode;
      if (activePMI) {
        try {
          await activePMI.finish();
        } catch (err) {
          console.warn('PMI Views: failed to finish active PMI session before switching', err);
        }
      }
    } catch (err) {
      console.warn('PMI Views: unexpected PMI session check failure', err);
    }

    try { this._applyView(view, { index }); } catch {}
    try { this.viewer.startPMIMode?.(view, index, this); } catch {}
  }

  // --- Helpers: view settings ---
  _isFaceObject(obj) {
    return !!obj && (obj.type === 'FACE' || (obj.isMesh && typeof obj.userData?.faceName === 'string'));
  }

  _detectWireframe(scene) {
    try {
      if (!scene) return false;
      let wf = false;
      scene.traverse((obj) => {
        if (wf) return;
        if (!this._isFaceObject(obj)) return;
        const m = obj?.material;
        if (!m) return;
        if (Array.isArray(m)) {
          for (const mm of m) { if (mm && 'wireframe' in mm && mm.wireframe) { wf = true; break; } }
        } else if ('wireframe' in m && m.wireframe) {
          wf = true;
        }
      });
      return wf;
    } catch { return false; }
  }

  _applyWireframe(scene, isWireframe) {
    try {
      if (!scene) return;
      const apply = (mat) => { if (mat && 'wireframe' in mat) mat.wireframe = !!isWireframe; };
      scene.traverse((obj) => {
        if (!this._isFaceObject(obj)) return;
        const m = obj?.material;
        if (!m) return;
        if (Array.isArray(m)) {
          for (const mm of m) apply(mm);
        } else {
          apply(m);
        }
      });
    } catch { /* ignore */ }
  }

}
