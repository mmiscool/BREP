// fileManagerWidget.js
// A lightweight widget to save/load/delete models using localStorage shim.
// Designed to be embedded as an Accordion section (similar to expressionsManager).
import * as THREE from 'three';
import JSZip from 'jszip';
import { generate3MF } from '../exporters/threeMF.js';
import { localStorage as LS } from '../localStorageShim.js';
import {
  listComponentRecords,
  getComponentRecord,
  setComponentRecord,
  removeComponentRecord,
  MODEL_STORAGE_PREFIX,
  uint8ArrayToBase64,
  base64ToUint8Array,
} from '../services/componentLibrary.js';

export class FileManagerWidget {
  constructor(viewer) {
    this.viewer = viewer;
    this.uiElement = document.createElement('div');
    // Legacy aggregate index key (pre-refactor)
    this._storageKey = '__BREP_MODELS__';
    // New per-model storage prefix
    this._modelPrefix = MODEL_STORAGE_PREFIX;
    this._lastKey = '__BREP_MODELS_LASTNAME__';
    this.currentName = this._loadLastName() || '';
    this._iconsOnly = this._loadIconsPref();
    this._loadSeq = 0; // guards async load races
    this._thumbCache = new Map();
    this._ensureStyles();
    this._buildUI();
    // Attempt migration from legacy single-key storage to per-model keys
    this._migrateFromLegacy();
    this.refreshList();

    // Refresh UI thumbnails/list when any model key changes via storage events (cross-tab and other code paths)
    try {
      this._onStorage = (ev) => {
        try {
          const key = (ev && (ev.key ?? (ev.detail && ev.detail.key))) || '';
          if (!key) return;
          if (key.startsWith(this._modelPrefix)) {
            // Invalidate cache for this model and refresh list
            try {
              const encName = key.slice(this._modelPrefix.length);
              const name = decodeURIComponent(encName);
              if (name) this._thumbCache.delete(name);
            } catch {}
            this.refreshList();
          } else if (key === this._lastKey || key === '__BREP_FM_ICONSVIEW__') {
            // Preferences updated elsewhere; re-sync
            this.currentName = this._loadLastName() || this.currentName || '';
            this._iconsOnly = this._loadIconsPref();
            this.refreshList();
          }
        } catch { /* ignore */ }
      };
      window.addEventListener('storage', this._onStorage);
    } catch { /* ignore */ }

    // Ensure shim hydration completes, then re-sync prefs/list and auto-load last
    try {
      Promise.resolve(LS.ready()).then(() => {
        try {
          this.currentName = this._loadLastName() || this.currentName || '';
          this._iconsOnly = this._loadIconsPref();
          this._migrateFromLegacy();
          this.refreshList();
          const last = this._loadLastName();
          if (last && this._getModel(last)) this.loadModel(last);
        } catch { /* ignore */ }
      });
    } catch { /* ignore */ }

    // Auto-load the last opened/saved model (if present)
    // Keeps the UX seamless across page reloads.
    try {
      const last = this._loadLastName();
      if (last) {
        const exists = this._getModel(last);
        if (exists) {
          // Fire and forget; constructor cannot be async
          this.loadModel(last);
        }
      }
    } catch { /* ignore auto-load failures */ }
  }

  // ----- Storage helpers -----
  // Build a namespaced per-model key
  _modelKey(name) {
    return this._modelPrefix + encodeURIComponent(String(name || ''));
  }
  // List all saved model records from per-model keys
  _listModels() {
    const records = listComponentRecords();
    return records.map(({ name, savedAt, record }) => ({
      name,
      savedAt,
      data: record?.data,
      data3mf: record?.data3mf,
      thumbnail: record?.thumbnail,
    }));
  }
  // Fetch one model record
  _getModel(name) {
    return getComponentRecord(name);
  }
  // Persist one model record
  _setModel(name, dataObj) {
    setComponentRecord(name, dataObj);
  }
  // Remove one model record
  _removeModel(name) {
    removeComponentRecord(name);
  }
  // One-time migration from legacy aggregate index array to per-model keys
  _migrateFromLegacy() {
    try {
      const raw = LS.getItem(this._storageKey);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const it of arr) {
        if (!it || !it.name) continue;
        const existing = getComponentRecord(it.name);
        if (existing) continue; // don't overwrite existing per-model
        const record = { savedAt: it.savedAt || new Date().toISOString(), data: it.data };
        this._setModel(it.name, record);
      }
      // Remove legacy blob after migrating
      LS.removeItem(this._storageKey);
    } catch {
      // ignore migration failures
    }
  }
  _saveLastName(name) {
    if (name) LS.setItem(this._lastKey, name);
  }
  _loadLastName() {
    return LS.getItem(this._lastKey) || '';
  }
  _saveIconsPref(v) {
    try { LS.setItem('__BREP_FM_ICONSVIEW__', v ? '1' : '0'); } catch {}
  }
  _loadIconsPref() {
    try { return LS.getItem('__BREP_FM_ICONSVIEW__') === '1'; } catch { return false; }
  }



  // ----- UI -----
  _ensureStyles() {
    if (document.getElementById('file-manager-widget-styles')) return;
    const style = document.createElement('style');
    style.id = 'file-manager-widget-styles';
    style.textContent = `
      /* Layout */
      .fm-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-bottom: 1px solid #1f2937; background: transparent; transition: background-color .12s ease; }
      .fm-row:hover { background: #0f172a; }
      .fm-row.header { background: #111827; border-bottom: 1px solid #1f2937; padding-bottom: 8px; margin-bottom: 4px; }
      .fm-row:last-child { border-bottom: 0; }
      .fm-grow { flex: 1 1 auto; overflow: hidden; }
      .fm-thumb { flex: 0 0 auto; width: 60px; height: 60px; border-radius: 6px; border: 1px solid #1f2937; background: #0b0e14; object-fit: contain; image-rendering: auto; }

      /* Inputs (keep text size and padding) */
      .fm-input { width: 100%; box-sizing: border-box; padding: 6px 8px; background: #0b0e14; color: #e5e7eb; border: 1px solid #374151; border-radius: 8px; outline: none; transition: border-color .15s ease, box-shadow .15s ease; }
      .fm-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.15); }

      /* Buttons (keep text size and padding) */
      .fm-btn { background: rgba(255,255,255,.03); color: #f9fafb; border: 1px solid #374151; padding: 2px 6px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 12px; line-height: 1; min-width: 26px; height: 24px; display: inline-flex; align-items: center; justify-content: center; transition: border-color .15s ease, background-color .15s ease, transform .05s ease; }
      .fm-btn:hover { border-color: #3b82f6; background: rgba(59,130,246,.12); }
      .fm-btn:active { transform: translateY(1px); }
      .fm-btn.danger { border-color: #7f1d1d; color: #fecaca; }
      .fm-btn.danger:hover { border-color: #ef4444; background: rgba(239,68,68,.15); color: #fff; }

      /* List + text (keep sizes) */
      .fm-list { padding: 4px 0; }
      .fm-left { display: flex; flex-direction: column; min-width: 0; }
      .fm-name { font-weight: 600; color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
      .fm-date { font-size: 11px; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }

      /* Icons view */
      .fm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 8px; padding: 6px; }
      .fm-item { position: relative; display: flex; align-items: center; justify-content: center; padding: 8px; border: 1px solid #1f2937; border-radius: 8px; background: transparent; transition: background-color .12s ease, border-color .12s ease; }
      .fm-item:hover { background: #0f172a; border-color: #334155; }
      .fm-item .fm-thumb { width: 60px; height: 60px; border: 1px solid #1f2937; background: #0b0e14; border-radius: 6px; }
      .fm-item .fm-del { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; padding: 0; line-height: 1; }
    `;
    document.head.appendChild(style);
  }

  _buildUI() {
    // Header: name input + Save + New
    const header = document.createElement('div');
    header.className = 'fm-row header';

    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.placeholder = 'Model name';
    this.nameInput.value = this.currentName;
    this.nameInput.className = 'fm-input fm-grow';
    header.appendChild(this.nameInput);
    
    // View toggle: list ↔ icons-only
    this.viewToggleBtn = document.createElement('button');
    this.viewToggleBtn.className = 'fm-btn';
    this.viewToggleBtn.addEventListener('click', () => this.toggleViewMode());
    header.appendChild(this.viewToggleBtn);

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'fm-btn';
    saveBtn.addEventListener('click', () => this.saveCurrent());
    header.appendChild(saveBtn);



    const newBtn = document.createElement('button');
    newBtn.textContent = 'New';
    newBtn.className = 'fm-btn';
    newBtn.addEventListener('click', () => this.newModel());
    header.appendChild(newBtn);

    this.uiElement.appendChild(header);

    // List container
    this.listEl = document.createElement('div');
    this.listEl.className = 'fm-list';
    this.uiElement.appendChild(this.listEl);

    this._updateViewToggleUI();
  }

  // ----- Actions -----
  async newModel() {
    if (!this.viewer || !this.viewer.partHistory) return;
    const proceed = confirm('Clear current model and start a new one?');
    if (!proceed) return;
    await this.viewer.partHistory.reset();
    this.viewer.partHistory.currentHistoryStepId = null;
    await this.viewer.partHistory.runHistory();
    this.currentName = '';
    this.nameInput.value = '';
  }

  async saveCurrent() {
    if (!this.viewer || !this.viewer.partHistory) return;
    let name = (this.nameInput.value || '').trim();
    if (!name) {
      name = prompt('Enter a name for this model:') || '';
      name = name.trim();
      if (!name) return;
      this.nameInput.value = name;
    }

    // Load PMI views into PartHistory before serializing
    try {
      this.viewer.partHistory.loadPMIViewsFromLocalStorage(name);
      console.log('[FileManagerWidget] Loaded PMI views for model:', name, 'found views:', this.viewer.partHistory.pmiViews?.length || 0);
    } catch (e) {
      console.warn('[FileManagerWidget] Failed to load PMI views:', e);
    }

    // Get feature history JSON (now includes PMI views) and embed into a 3MF archive as Metadata/featureHistory.json
    const jsonString = await this.viewer.partHistory.toJSON();
    let additionalFiles = undefined;
    let modelMetadata = undefined;
    if (jsonString) {
      additionalFiles = { 'Metadata/featureHistory.json': jsonString };
      modelMetadata = { featureHistoryPath: '/Metadata/featureHistory.json' };
    }
    // Capture a 60x60 thumbnail of the current view
    let thumbnail = null;
    try {
      thumbnail = await this._captureThumbnail(60);
    } catch { /* ignore thumbnail failures */ }

    // Generate a compact 3MF. For local storage we only need history (no meshes), but we do embed a thumbnail.
    const threeMfBytes = await generate3MF([], { unit: 'millimeter', precision: 6, scale: 1, additionalFiles, modelMetadata, thumbnail });
    const threeMfB64 = uint8ArrayToBase64(threeMfBytes);
    const now = new Date().toISOString();

    // Store only the 3MF (with embedded thumbnail) and timestamp
    const record = { savedAt: now, data3mf: threeMfB64 };
    if (thumbnail) record.thumbnail = thumbnail;
    this._setModel(name, record);
    // Update in-memory thumbnail cache so UI reflects the new preview immediately
    try { if (thumbnail) this._thumbCache.set(name, thumbnail); } catch { }
    this.currentName = name;
    this._saveLastName(name);
    this.refreshList();
  }

  async loadModel(name) {
    if (!this.viewer || !this.viewer.partHistory) return;
    const seq = ++this._loadSeq; // only the last call should win
    const rec = this._getModel(name);
    if (!rec) return alert('Model not found.');
    await this.viewer.partHistory.reset();
    // Prefer new 3MF-based storage
    if (rec.data3mf && typeof rec.data3mf === 'string') {
      try {
        let b64 = rec.data3mf;
        if (b64.startsWith('data:') && b64.includes(';base64,')) {
          b64 = b64.split(';base64,')[1];
        }
        const bytes = base64ToUint8Array(b64);
        // Try to extract feature history from 3MF
        const zip = await JSZip.loadAsync(bytes.buffer);
        const files = {};
        Object.keys(zip.files || {}).forEach(p => files[p.toLowerCase()] = p);
        let fhKey = files['metadata/featurehistory.json'];
        if (!fhKey) {
          for (const k of Object.keys(files)) { if (k.endsWith('featurehistory.json')) { fhKey = files[k]; break; } }
        }
        if (fhKey) {
          const jsonData = await zip.file(fhKey).async('string');
          let root = null;
          try { root = JSON.parse(jsonData); } catch {}
          // Ensure expressions is a string if present
          if (root && root.expressions != null && typeof root.expressions !== 'string') {
            try { root.expressions = String(root.expressions); } catch { root.expressions = String(root.expressions); }
          }
          if (root) {
            await this.viewer.partHistory.fromJSON(JSON.stringify(root));
            // Sync Expressions UI with imported code
            try { if (this.viewer?.expressionsManager?.textArea) this.viewer.expressionsManager.textArea.value = this.viewer.partHistory.expressions || ''; } catch {}
            
            // Sync PMI views from PartHistory to localStorage for widget compatibility
            try {
              this.viewer.partHistory.savePMIViewsToLocalStorage(name);
              console.log('[FileManagerWidget] Restored', this.viewer.partHistory.pmiViews?.length || 0, 'PMI views for model:', name);
              // Refresh PMI views UI if it exists - trigger after model name is set
              setTimeout(() => {
                try { 
                  if (this.viewer?.pmiViewsWidget) {
                    // Force refresh the PMI views widget by triggering model change
                    this.viewer.pmiViewsWidget.currentModelName = name;
                    this.viewer.pmiViewsWidget.views = this.viewer.pmiViewsWidget._loadViewsFor(name);
                    this.viewer.pmiViewsWidget._renderList?.();
                  }
                } catch {}
              }, 100);
            } catch (e) {
              console.warn('[FileManagerWidget] Failed to restore PMI views:', e);
            }

            if (seq !== this._loadSeq) return;
            this.currentName = name;
            this.nameInput.value = name;
            this._saveLastName(name);
            await this.viewer.partHistory.runHistory();
            return;
          }
        }
        // No feature history found → fallback to import raw 3MF as mesh via Import3D feature
        try {
          const feat = await this.viewer?.partHistory?.newFeature?.('IMPORT3D');
          if (feat) {
            feat.inputParams.fileToImport = bytes.buffer; // Import3dModelFeature can auto-detect 3MF zip
            feat.inputParams.deflectionAngle = 15;
            feat.inputParams.centerMesh = true;
          }
          await this.viewer?.partHistory?.runHistory?.();
          if (seq !== this._loadSeq) return;
          this.currentName = name;
          this.nameInput.value = name;
          this._saveLastName(name);
          return;
        } catch {}
      } catch (e) {
        console.warn('[FileManagerWidget] Failed to load 3MF from localStorage; falling back to legacy JSON if present.', e);
      }
    }
    // Legacy JSON path
    try {
      const payload = (typeof rec.data === 'string') ? rec.data : JSON.stringify(rec.data);
      await this.viewer.partHistory.fromJSON(payload);
      // Sync Expressions UI with imported code
      try { if (this.viewer?.expressionsManager?.textArea) this.viewer.expressionsManager.textArea.value = this.viewer.partHistory.expressions || ''; } catch {}
    } catch (e) {
      alert('Failed to load model (invalid data).');
      console.error(e);
      return;
    }
    if (seq !== this._loadSeq) return;
    this.currentName = name;
    this.nameInput.value = name;
    this._saveLastName(name);
    await this.viewer.partHistory.runHistory();
  }

  deleteModel(name) {
    const rec = this._getModel(name);
    if (!rec) return;
    const proceed = confirm(`Delete model "${name}"? This cannot be undone.`);
    if (!proceed) return;
    this._removeModel(name);
    if (this.currentName === name) {
      this.currentName = '';
      if (this.nameInput.value === name) this.nameInput.value = '';
    }
    this.refreshList();
  }

  refreshList() {
    const items = this._listModels();
    while (this.listEl.firstChild) this.listEl.removeChild(this.listEl.firstChild);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'fm-row';
      empty.textContent = 'No saved models yet.';
      this.listEl.appendChild(empty);
      return;
    }

    const sorted = items.slice().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    if (this._iconsOnly) {
      this._renderIconsView(sorted);
      return;
    }

    for (const it of sorted) {
      const row = document.createElement('div');
      row.className = 'fm-row';

      const thumb = document.createElement('img');
      thumb.className = 'fm-thumb';
      thumb.alt = `${it.name} thumbnail`;
      this._applyThumbnailToImg(it, thumb);
      thumb.addEventListener('click', () => this.loadModel(it.name));
      row.appendChild(thumb);

      const left = document.createElement('div');
      left.className = 'fm-left fm-grow';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'fm-name';
      nameDiv.textContent = it.name;
      nameDiv.addEventListener('click', () => this.loadModel(it.name));
      left.appendChild(nameDiv);
      const dt = new Date(it.savedAt);
      const dateEl = document.createElement('div');
      dateEl.className = 'fm-date';
      dateEl.textContent = isNaN(dt) ? String(it.savedAt || '') : dt.toLocaleString();
      left.appendChild(dateEl);
      row.appendChild(left);

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'fm-btn';
      openBtn.textContent = '📂';
      openBtn.addEventListener('click', () => this.loadModel(it.name));
      row.appendChild(openBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'fm-btn danger';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => this.deleteModel(it.name));
      row.appendChild(delBtn);

      this.listEl.appendChild(row);
    }
  }

  toggleViewMode() {
    this._iconsOnly = !this._iconsOnly;
    this._saveIconsPref(this._iconsOnly);
    this._updateViewToggleUI();
    this.refreshList();
  }
  _updateViewToggleUI() {
    if (!this.viewToggleBtn) return;
    if (this._iconsOnly) {
      this.viewToggleBtn.textContent = '☰';
      this.viewToggleBtn.title = 'Switch to list view';
    } else {
      this.viewToggleBtn.textContent = '🔳';
      this.viewToggleBtn.title = 'Switch to icons view';
    }
  }

  _renderIconsView(items) {
    const grid = document.createElement('div');
    grid.className = 'fm-grid';
    this.listEl.appendChild(grid);

    for (const it of items) {
      const cell = document.createElement('div');
      cell.className = 'fm-item';
      const dt = new Date(it.savedAt);
      cell.title = `${it.name}\n${isNaN(dt) ? String(it.savedAt || '') : dt.toLocaleString()}`;
      cell.addEventListener('click', () => this.loadModel(it.name));

      const img = document.createElement('img');
      img.className = 'fm-thumb';
      img.alt = `${it.name} thumbnail`;
      this._applyThumbnailToImg(it, img);
      cell.appendChild(img);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'fm-btn danger fm-del';
      del.textContent = '✕';
      del.title = `Delete ${it.name}`;
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.deleteModel(it.name);
      });
      cell.appendChild(del);

      grid.appendChild(cell);
    }
  }
  async _applyThumbnailToImg(rec, imgEl) {
    try {
      if (!imgEl) return;
      if (!rec?.data3mf) {
        imgEl.style.display = 'none';
        return;
      }
      imgEl.style.display = '';
      if (rec.thumbnail) {
        imgEl.src = rec.thumbnail;
        if (this._thumbCache) this._thumbCache.set(rec.name, rec.thumbnail);
        return;
      }
      if (this._thumbCache && this._thumbCache.has(rec.name)) {
        const cached = this._thumbCache.get(rec.name);
        if (cached) imgEl.src = cached;
        return;
      }
      const src = await extractThumbnailFrom3MFBase64(rec.data3mf);
      if (src) {
        imgEl.src = src;
        if (this._thumbCache) this._thumbCache.set(rec.name, src);
        this._persistThumbnail(rec.name, src);
      } else {
        imgEl.style.display = 'none';
      }
    } catch {
      if (imgEl) imgEl.style.display = 'none';
    }
  }

  _persistThumbnail(name, thumbnail) {
    if (!name || !thumbnail) return;
    const existing = getComponentRecord(name);
    if (!existing) return;
    const payload = {
      savedAt: existing.savedAt || new Date().toISOString(),
      data3mf: existing.data3mf,
      data: existing.data,
      thumbnail,
    };
    setComponentRecord(name, payload);
  }

  async _captureThumbnail(size = 60) {
    try {
      const renderer = this.viewer?.renderer;
      const canvas = renderer?.domElement;
      const cam = this.viewer?.camera;
      const controls = this.viewer?.controls;
      if (!canvas || !cam) return null;

      // Temporarily reorient exactly like clicking the ViewCube corner (top-front-right)
      try {
        const dir = new THREE.Vector3(1, 1, 1); // matches TOP FRONT RIGHT corner
        if (this.viewer?.viewCube && typeof this.viewer.viewCube._reorientCamera === 'function') {
          this.viewer.viewCube._reorientCamera(dir, 'SAVE THUMBNAIL');
        } else {
          // Fallback: replicate ViewCube corner logic if widget unavailable
          const pivot = (controls && controls._gizmos && controls._gizmos.position)
            ? controls._gizmos.position.clone()
            : new THREE.Vector3(0, 0, 0);
          const dist = cam.position.distanceTo(pivot) || cam.position.length() || 10;
          const pos = pivot.clone().add(dir.clone().normalize().multiplyScalar(dist));
          const useZup = Math.abs(dir.y) > 0.9;
          const up = useZup ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
          cam.position.copy(pos);
          cam.up.copy(up);
          cam.lookAt(pivot);
          cam.updateMatrixWorld(true);
          if (controls?.updateMatrixState) { try { controls.updateMatrixState(); } catch {} }
        }
        // Fit geometry within this oriented view
        try { this.viewer.zoomToFit(1.1); } catch {}
      } catch { /* ignore orientation failures */ }

      // Ensure a fresh frame before capture
      try { this.viewer.render(); } catch {}

      // Wait one frame to be safe
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const srcW = canvas.width || canvas.clientWidth || 1;
      const srcH = canvas.height || canvas.clientHeight || 1;
      const dst = document.createElement('canvas');
      dst.width = size; dst.height = size;
      const ctx = dst.getContext('2d');
      if (!ctx) return null;
      // Fill with viewer background for letterboxing
      try { ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, size, size); } catch {}
      // Compute contain fit
      const scale = Math.min(size / srcW, size / srcH);
      const dw = Math.max(1, Math.floor(srcW * scale));
      const dh = Math.max(1, Math.floor(srcH * scale));
      const dx = Math.floor((size - dw) / 2);
      const dy = Math.floor((size - dh) / 2);
      try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; } catch {}
      ctx.drawImage(canvas, 0, 0, srcW, srcH, dx, dy, dw, dh);
      const dataUrl = dst.toDataURL('image/png');
      return dataUrl;
    } catch {
      return null;
    }
  }
}
