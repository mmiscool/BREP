// PMIViewsWidget.js
// ES6, no frameworks. Provides a simple list of saved PMI views
// (camera snapshots) with capture, rename, apply, and delete.
// Views are persisted per model via the localStorage shim.

import { localStorage as LS } from '../../localStorageShim.js';
import { captureCameraSnapshot, applyCameraSnapshot, adjustOrthographicFrustum } from './annUtils.js';

export class PMIViewsWidget {
  constructor(viewer) {
    this.viewer = viewer;
    this.uiElement = document.createElement('div');
    this.uiElement.className = 'pmi-views-root';
    this._ensureStyles();

    this._prefix = '__BREP_PMI_VIEWS__:';
    this._lastModelKey = '__BREP_MODELS_LASTNAME__';
    this.currentModelName = this._getCurrentModelName();
    this.views = this._loadViewsFor(this.currentModelName);

    this._buildUI();
    this._renderList();

    // Re-sync after LS shim hydrates, to reflect any persisted views
    try { Promise.resolve(LS.ready()).then(() => { try { this.views = this._loadViewsFor(this.currentModelName); this._renderList(); } catch {} }); } catch {}

    // React to model changes via storage events (FileManager updates __BREP_MODELS_LASTNAME__)
    try {
      this._onStorage = (ev) => {
        try {
          const key = (ev && (ev.key ?? (ev.detail && ev.detail.key))) || '';
          if (!key) return;
          if (key === this._lastModelKey) {
            const nm = this._getCurrentModelName();
            if (nm !== this.currentModelName) {
              this.currentModelName = nm;
              this.views = this._loadViewsFor(this.currentModelName);
              this._renderList();
            }
          } else if (key.startsWith(this._prefix)) {
            // If current model's views changed elsewhere, refresh
            const enc = key.slice(this._prefix.length);
            const name = decodeURIComponent(enc);
            if (name === (this.currentModelName || '__DEFAULT__')) {
              this.views = this._loadViewsFor(this.currentModelName);
              this._renderList();
            }
          }
        } catch { /* ignore */ }
      };
      window.addEventListener('storage', this._onStorage);
    } catch { /* ignore */ }
  }

  dispose() {
    try { window.removeEventListener('storage', this._onStorage); } catch {}
  }

  // ---- Storage helpers ----
  _safeKeyName(name) {
    const n = String(name || '').trim();
    return n ? n : '__DEFAULT__';
  }
  _modelKey(name) {
    return this._prefix + encodeURIComponent(this._safeKeyName(name));
  }
  _getCurrentModelName() {
    try {
      const fmName = this.viewer?.fileManagerWidget?.currentName || '';
      return this._safeKeyName(fmName);
    } catch { return '__DEFAULT__'; }
  }
  _loadViewsFor(modelName) {
    try {
      const raw = LS.getItem(this._modelKey(modelName));
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(Boolean);
    } catch { return []; }
  }
  _saveViewsFor(modelName, views) {
    try {
      LS.setItem(this._modelKey(modelName), JSON.stringify(Array.isArray(views) ? views : []));
    } catch { /* ignore */ }
  }

  // ---- UI ----
  _ensureStyles() {
    if (document.getElementById('pmi-views-widget-styles')) return;
    const style = document.createElement('style');
    style.id = 'pmi-views-widget-styles';
    style.textContent = `
      .pmi-views-root { padding: 6px; }
      .pmi-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-bottom: 1px solid #1f2937; background: transparent; transition: background-color .12s ease; }
      .pmi-row:hover { background: #0f172a; }
      .pmi-row.header { background: #111827; border-bottom: 1px solid #1f2937; padding-bottom: 8px; margin-bottom: 6px; border-radius: 4px; }
      .pmi-grow { flex: 1 1 auto; min-width: 0; }
      .pmi-input { width: 100%; box-sizing: border-box; padding: 6px 8px; background: #0b0e14; color: #e5e7eb; border: 1px solid #374151; border-radius: 8px; outline: none; transition: border-color .15s ease, box-shadow .15s ease; }
      .pmi-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
      .pmi-btn { background: rgba(255,255,255,.03); color: #f9fafb; border: 1px solid #374151; padding: 4px 8px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 12px; line-height: 1; height: 26px; display: inline-flex; align-items: center; justify-content: center; transition: border-color .15s ease, background-color .15s ease, transform .05s ease; }
      .pmi-btn:hover { border-color: #3b82f6; background: rgba(59,130,246,.12); }
      .pmi-btn:active { transform: translateY(1px); }
      .pmi-btn.danger { border-color: #7f1d1d; color: #fecaca; }
      .pmi-btn.danger:hover { border-color: #ef4444; background: rgba(239,68,68,.15); color: #fff; }
      .pmi-list { display: flex; flex-direction: column; gap: 2px; }
      .pmi-name { font-weight: 600; color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pmi-name-btn { background: none; border: none; padding: 0; margin: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; display: block; width: 100%; }
      .pmi-name-btn:hover { color: #93c5fd; }
      .pmi-name-btn:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
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
    this.listEl.textContent = '';
    const views = Array.isArray(this.views) ? this.views : [];
    views.forEach((v, idx) => {
      const row = document.createElement('div');
      row.className = 'pmi-row';

      // View name displayed as clickable text
      const viewName = String(v.name || `View ${idx + 1}`);
      const nameButton = document.createElement('button');
      nameButton.type = 'button';
      nameButton.className = 'pmi-name pmi-name-btn pmi-grow';
      nameButton.textContent = viewName;
      nameButton.title = 'Click to edit annotations for this view';
      nameButton.addEventListener('click', () => {
        this._enterEditMode(v, idx);
        // Wait 200 ms and re-enter edit mode to ensure PMI mode is active
        setTimeout(() => {
          this._enterEditMode(v, idx);
        }, 200);
      });
      row.appendChild(nameButton);

      // Rename button swaps the name into an inline editor
      const renameBtn = document.createElement('button');
      renameBtn.className = 'pmi-btn';
      renameBtn.title = 'Rename this view';
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', () => {
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
            if (finalName !== v.name) {
              v.name = finalName;
            }
            this._persist();
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
      });
      row.appendChild(renameBtn);
      // Delete
      const delBtn = document.createElement('button');
      delBtn.className = 'pmi-btn danger';
      delBtn.title = 'Delete this view';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        this.views.splice(idx, 1);
        this._persist();
        this._renderList();
      });
      row.appendChild(delBtn);

      // Double-click anywhere on row to apply
      row.addEventListener('dblclick', (e) => {
        const target = e.target;
        const tagName = target?.tagName;
        if (target === delBtn || target === renameBtn || tagName === 'INPUT') return; // ignore if dblclick on control buttons or inline editor
        this._applyView(v);
      });

      this.listEl.appendChild(row);
    });
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
      const name = String(nameRaw || '').trim() || `View ${this.views.length + 1}`;
      const snap = {
        name,
        camera: cameraSnap,
        // Persist basic view settings (extensible). Currently only wireframe render mode.
        viewSettings: {
          wireframe: this._detectWireframe(v?.scene)
        }
      };
      this.views.push(snap);
      this._persist();
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

  _persist() {
    this._saveViewsFor(this.currentModelName, this.views);
  }
}
