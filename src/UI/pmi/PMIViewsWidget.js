// PMIViewsWidget.js
// ES6, no frameworks. Provides a simple list of saved PMI views
// (camera snapshots) with capture, rename, apply, and delete.
// Views are persisted with the PartHistory instance.

import { captureCameraSnapshot, applyCameraSnapshot, adjustOrthographicFrustum } from './annUtils.js';

const UPDATE_CAMERA_TOOLTIP = 'Update this view to match the current camera';

export class PMIViewsWidget {
  constructor(viewer) {
    this.viewer = viewer;
    this.uiElement = document.createElement('div');
    this.uiElement.className = 'pmi-views-root';
    this._ensureStyles();

    this.views = [];
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

    this.newNameInput = document.createElement('input');
    this.newNameInput.type = 'text';
    this.newNameInput.placeholder = 'New view name';
    this.newNameInput.className = 'pmi-input pmi-grow';
    header.appendChild(this.newNameInput);

    const capBtn = document.createElement('button');
    capBtn.className = 'pmi-btn';
    capBtn.title = 'Capture current camera as a view';
    capBtn.textContent = 'Capture';
    capBtn.addEventListener('click', () => this._captureCurrent());
    header.appendChild(capBtn);

    this.uiElement.appendChild(header);

    this.listEl = document.createElement('div');
    this.listEl.className = 'pmi-list';
    this.uiElement.appendChild(this.listEl);
  }

  _renderList() {
    this._closeActiveMenu();
    this.listEl.textContent = '';
    const views = Array.isArray(this.views) ? this.views : [];
    views.forEach((v, idx) => {
      const row = document.createElement('div');
      row.className = 'pmi-row';

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
        this._applyView(v);
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
  _captureCurrent() {
    try {
      const v = this.viewer;
      const cam = v?.camera;
      if (!cam) return;
      const cameraSnap = captureCameraSnapshot(cam, { controls: this.viewer?.controls });
      if (!cameraSnap) return;
      const nameRaw = this.newNameInput?.value || '';
      const fallbackIndex = Array.isArray(this.views) ? this.views.length : 0;
      const name = String(nameRaw || '').trim() || `View ${fallbackIndex + 1}`;
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
      this.newNameInput.value = '';
      this._renderList();
    } catch { /* ignore */ }
  }

  _applyView(view) {
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

    try { this._applyView(view); } catch {}
    try { this.viewer.startPMIMode?.(view, index, this); } catch {}
  }

  // --- Helpers: view settings ---
  _detectWireframe(scene) {
    try {
      if (!scene) return false;
      let wf = false;
      scene.traverse((obj) => {
        if (wf) return;
        const m = obj?.material;
        if (!m) return;
        if (Array.isArray(m)) {
          for (const mm of m) { if (mm?.wireframe) { wf = true; break; } }
        } else if (m.wireframe) {
          wf = true;
        }
      });
      return wf;
    } catch { return false; }
  }

  _applyWireframe(scene, isWireframe) {
    try {
      if (!scene) return;
      scene.traverse((obj) => {
        const m = obj?.material;
        if (!m) return;
        if (Array.isArray(m)) {
          for (const mm of m) { if (mm) mm.wireframe = isWireframe; }
        } else {
          m.wireframe = isWireframe;
        }
      });
    } catch { /* ignore */ }
  }

}
