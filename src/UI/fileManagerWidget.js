// fileManagerWidget.js
// A lightweight widget to save/load/delete models from browser localStorage.
// Designed to be embedded as an Accordion section (similar to expressionsManager).
import * as THREE from 'three';
import JSZip from 'jszip';
import { generate3MF } from '../exporters/threeMF.js';
import { jsonToXml, xmlToJson } from '../utils/jsonXml.js';

export class FileManagerWidget {
  constructor(viewer) {
    this.viewer = viewer;
    this.uiElement = document.createElement('div');
    // Legacy aggregate index key (pre-refactor)
    this._storageKey = '__BREP_MODELS__';
    // New per-model storage prefix
    this._modelPrefix = '__BREP_MODEL__:';
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
    const items = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(this._modelPrefix)) continue;
        try {
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          const encName = k.slice(this._modelPrefix.length);
          const name = decodeURIComponent(encName);
          // Keep both legacy JSON (data) and new 3MF (data3mf) fields
          // Do NOT persist thumbnail separately anymore; extract from 3MF when needed.
          items.push({ name, savedAt: parsed?.savedAt, data: parsed?.data, data3mf: parsed?.data3mf });
        } catch {
          // skip malformed entries
        }
      }
    } catch {
      // localStorage access issue; return empty list
    }
    return items;
  }
  // Fetch one model record
  _getModel(name) {
    try {
      const raw = localStorage.getItem(this._modelKey(name));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      // Do not surface legacy 'thumbnail' field anymore; we derive from 3MF on demand
      return { name, savedAt: parsed?.savedAt, data: parsed?.data, data3mf: parsed?.data3mf };
    } catch { return null; }
  }
  // Persist one model record
  _setModel(name, dataObj) {
    localStorage.setItem(this._modelKey(name), JSON.stringify(dataObj));
  }
  // Remove one model record
  _removeModel(name) {
    localStorage.removeItem(this._modelKey(name));
  }
  // One-time migration from legacy aggregate index array to per-model keys
  _migrateFromLegacy() {
    try {
      const raw = localStorage.getItem(this._storageKey);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const it of arr) {
        if (!it || !it.name) continue;
        const existing = localStorage.getItem(this._modelKey(it.name));
        if (existing) continue; // don't overwrite existing per-model
        const record = { savedAt: it.savedAt || new Date().toISOString(), data: it.data };
        this._setModel(it.name, record);
      }
      // Remove legacy blob after migrating
      localStorage.removeItem(this._storageKey);
    } catch {
      // ignore migration failures
    }
  }
  _saveLastName(name) {
    if (name) localStorage.setItem(this._lastKey, name);
  }
  _loadLastName() {
    return localStorage.getItem(this._lastKey) || '';
  }
  _saveIconsPref(v) {
    try { localStorage.setItem('__BREP_FM_ICONSVIEW__', v ? '1' : '0'); } catch {}
  }
  _loadIconsPref() {
    try { return localStorage.getItem('__BREP_FM_ICONSVIEW__') === '1'; } catch { return false; }
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

  // Convert Uint8Array to base64 string in chunks (browser-safe)
  _uint8ToBase64(uint8) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < uint8.length; i += chunk) {
      const sub = uint8.subarray(i, i + chunk);
      binary += String.fromCharCode.apply(null, sub);
    }
    return btoa(binary);
  }
  // Convert base64 string back to Uint8Array
  _base64ToUint8(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
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

    // Get feature history JSON and embed into a 3MF archive as Metadata/featureHistory.xml
    const jsonString = await this.viewer.partHistory.toJSON();
    let featureHistoryObj = null;
    try { featureHistoryObj = JSON.parse(jsonString); } catch {}
    // Build additional files map only if JSON parsed cleanly
    let additionalFiles = undefined;
    let modelMetadata = undefined;
    if (featureHistoryObj && typeof featureHistoryObj === 'object') {
      const fhXml = jsonToXml(featureHistoryObj, 'featureHistory');
      additionalFiles = { 'Metadata/featureHistory.xml': fhXml };
      modelMetadata = { featureHistoryPath: '/Metadata/featureHistory.xml' };
    }
    // Capture a 60x60 thumbnail of the current view
    let thumbnail = null;
    try {
      thumbnail = await this._captureThumbnail(60);
    } catch { /* ignore thumbnail failures */ }

    // Generate a compact 3MF. For local storage we only need history (no meshes), but we do embed a thumbnail.
    const threeMfBytes = await generate3MF([], { unit: 'millimeter', precision: 6, scale: 1, additionalFiles, modelMetadata, thumbnail });
    const threeMfB64 = this._uint8ToBase64(threeMfBytes);
    const now = new Date().toISOString();

    // Store only the 3MF (with embedded thumbnail) and timestamp
    const record = { savedAt: now, data3mf: threeMfB64 };
    this._setModel(name, record);
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
        const bytes = this._base64ToUint8(b64);
        // Try to extract feature history from 3MF
        const zip = await JSZip.loadAsync(bytes.buffer);
        const files = {};
        Object.keys(zip.files || {}).forEach(p => files[p.toLowerCase()] = p);
        let fhKey = files['metadata/featurehistory.xml'];
        if (!fhKey) {
          for (const k of Object.keys(files)) { if (k.endsWith('featurehistory.xml')) { fhKey = files[k]; break; } }
        }
        if (fhKey) {
          const xml = await zip.file(fhKey).async('string');
          const obj = xmlToJson(xml);
          let root = obj && (obj.featureHistory || obj.FeatureHistory || null);
          // Normalize any arrays possibly collapsed by XML round-trip
          const ensureArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
          const normalizeSketch = (sk) => {
            if (!sk || typeof sk !== 'object') return sk;
            sk.points = ensureArray(sk.points);
            sk.geometries = ensureArray(sk.geometries);
            sk.constraints = ensureArray(sk.constraints);
            if (Array.isArray(sk.geometries)) {
              for (const g of sk.geometries) {
                if (!g) continue;
                g.points = Array.isArray(g?.points) ? g.points : (g?.points != null ? [g.points] : []);
                if (Array.isArray(g.points)) g.points = g.points.map((x) => Number(x));
              }
            }
            if (Array.isArray(sk.constraints)) {
              for (const c of sk.constraints) {
                if (!c) continue;
                c.points = Array.isArray(c?.points) ? c.points : (c?.points != null ? [c.points] : []);
                if (Array.isArray(c.points)) c.points = c.points.map((x) => Number(x));
              }
            }
            return sk;
          };
          const normalizeHistory = (h) => {
            if (!h || typeof h !== 'object') return h;
            h.features = ensureArray(h.features);
            for (const f of h.features) {
              if (!f || typeof f !== 'object') continue;
              if (f.persistentData && typeof f.persistentData === 'object') {
                if (f.persistentData.sketch) f.persistentData.sketch = normalizeSketch(f.persistentData.sketch);
                if (Array.isArray(f.persistentData.externalRefs)) {
                  // ok
                } else if (f.persistentData.externalRefs != null) {
                  f.persistentData.externalRefs = ensureArray(f.persistentData.externalRefs);
                }
              }
            }
            return h;
          };
          if (root) root = normalizeHistory(root);
          // Ensure expressions is a string if present
          if (root && root.expressions != null && typeof root.expressions !== 'string') {
            try {
              if (Array.isArray(root.expressions)) root.expressions = root.expressions.join('\n');
              else if (typeof root.expressions === 'object' && Array.isArray(root.expressions.item)) root.expressions = root.expressions.item.join('\n');
              else root.expressions = String(root.expressions);
            } catch { root.expressions = String(root.expressions); }
          }
          if (root) {
            await this.viewer.partHistory.fromJSON(JSON.stringify(root));
            // Sync Expressions UI with imported code
            try { if (this.viewer?.expressionsManager?.textArea) this.viewer.expressionsManager.textArea.value = this.viewer.partHistory.expressions || ''; } catch {}
            if (seq !== this._loadSeq) return;
            this.currentName = name;
            this.nameInput.value = name;
            this._saveLastName(name);
            await this.viewer.partHistory.runHistory();
            return;
          }
        }
        // No feature history found → fallback to import raw 3MF as mesh via STL feature
        try {
          const feat = await this.viewer?.partHistory?.newFeature?.('STL');
          if (feat) {
            feat.inputParams.fileToImport = bytes.buffer; // stlImport can auto-detect 3MF zip
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
    // Clear
    while (this.listEl.firstChild) this.listEl.removeChild(this.listEl.firstChild);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'fm-row';
      empty.textContent = 'No saved models yet.';
      this.listEl.appendChild(empty);
      return;
    }

    // Newest first
    const sorted = items.slice().sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    if (this._iconsOnly) {
      this._renderIconsView(sorted);
      return;
    }
    for (const it of sorted) {
      const row = document.createElement('div');
      row.className = 'fm-row';

      // Thumbnail (60x60) if available
      const thumb = document.createElement('img');
      thumb.className = 'fm-thumb';
      // Defer loading: extract from embedded 3MF thumbnail
      thumb.alt = `${it.name} thumbnail`;
      this._applyThumbnailToImg(it, thumb);
      // Make thumbnail clickable to open
      thumb.addEventListener('click', () => this.loadModel(it.name));
      row.appendChild(thumb);

      const left = document.createElement('div');
      left.className = 'fm-left fm-grow';
      const nameSpan = document.createElement('div');
      nameSpan.className = 'fm-name';
      nameSpan.textContent = it.name;
      // Click file name to load the model
      nameSpan.addEventListener('click', () => this.loadModel(it.name));
      left.appendChild(nameSpan);
      const dt = new Date(it.savedAt);
      const dateLine = document.createElement('div');
      dateLine.className = 'fm-date';
      dateLine.textContent = isNaN(dt) ? String(it.savedAt) : dt.toLocaleString();
      left.appendChild(dateLine);
      row.appendChild(left);

      const openBtn = document.createElement('button');
      openBtn.className = 'fm-btn';
      // Use an open folder icon
      openBtn.textContent = '📂';
      openBtn.addEventListener('click', () => this.loadModel(it.name));
      row.appendChild(openBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'fm-btn danger';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => this.deleteModel(it.name));
      row.appendChild(delBtn);

      this.listEl.appendChild(row);
    }
  }

  _renderIconsView(items) {
    const grid = document.createElement('div');
    grid.className = 'fm-grid';
    this.listEl.appendChild(grid);

    for (const it of items) {
      const cell = document.createElement('div');
      cell.className = 'fm-item';
      cell.title = `${it.name}\n${new Date(it.savedAt).toLocaleString()}`;
      cell.addEventListener('click', () => this.loadModel(it.name));

      const img = document.createElement('img');
      img.className = 'fm-thumb';
      img.alt = `${it.name} thumbnail`;
      // Load embedded 3MF thumbnail on demand
      this._applyThumbnailToImg(it, img);
      cell.appendChild(img);

      const del = document.createElement('button');
      del.className = 'fm-btn danger fm-del';
      del.textContent = '✕';
      del.title = `Delete ${it.name}`;
      del.addEventListener('click', (e) => { e.stopPropagation(); this.deleteModel(it.name); });
      cell.appendChild(del);

      grid.appendChild(cell);
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

  // ----- Thumbnail helpers -----
  async _extractThumbnailFrom3MFBase64(b64) {
    try {
      if (!b64) return null;
      if (b64.startsWith('data:') && b64.includes(';base64,')) {
        // Extract the base64 payload from a data URL
        b64 = b64.split(';base64,')[1];
      }
      const bytes = this._base64ToUint8(b64);
      const zip = await JSZip.loadAsync(bytes.buffer);
      const files = {};
      Object.keys(zip.files || {}).forEach(p => files[p.toLowerCase()] = p);

      // 1) Check model part relationships for a thumbnail target
      let relsKey = files['3d/_rels/3dmodel.model.rels'];
      if (relsKey) {
        try {
          const relsXml = await zip.file(relsKey).async('string');
          // Lightweight parse for Target with thumbnail relationship type
          const relRe = /<Relationship\s+[^>]*Type="[^"]*metadata\/thumbnail[^"]*"[^>]*>/ig;
          const tgtRe = /Target="([^"]+)"/i;
          let m;
          while ((m = relRe.exec(relsXml))) {
            const tag = m[0];
            const tm = tgtRe.exec(tag);
            if (tm && tm[1]) {
              let target = tm[1];
              // Resolve relative to 3D/ (model part location)
              if (target.startsWith('/')) {
                target = target.replace(/^\/+/, '');
              } else {
                // e.g., '../Thumbnails/thumbnail.png' or 'Thumbnails/thumbnail.png'
                target = '3D/' + target;
                // Normalize '../'
                target = target.replace(/(^|\/)\.{2}\/(?!\.{2}|$)/g, '/');
                target = target.replace(/^\/+/, '');
              }
              const lf = target.toLowerCase();
              const real = files[lf];
              if (real) {
                // Determine mime by extension
                const mime = lf.endsWith('.png') ? 'image/png' : (lf.match(/\.(jpe?g)$/) ? 'image/jpeg' : 'application/octet-stream');
                const imgU8 = await zip.file(real).async('uint8array');
                const imgB64 = this._uint8ToBase64(imgU8);
                return `data:${mime};base64,${imgB64}`;
              }
            }
          }
        } catch { /* ignore rels parse errors */ }
      }

      // 2) Fallback: first image under Thumbnails/
      const thumbPath = Object.keys(files).find(k => k.startsWith('thumbnails/') && (k.endsWith('.png') || k.endsWith('.jpg') || k.endsWith('.jpeg')));
      if (thumbPath) {
        const real = files[thumbPath];
        const mime = thumbPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        const imgU8 = await zip.file(real).async('uint8array');
        const imgB64 = this._uint8ToBase64(imgU8);
        return `data:${mime};base64,${imgB64}`;
      }
      return null;
    } catch { return null; }
  }

  async _applyThumbnailToImg(rec, imgEl) {
    try {
      if (!rec?.data3mf || !imgEl) return;
      if (this._thumbCache && this._thumbCache.has(rec.name)) {
        const cached = this._thumbCache.get(rec.name);
        if (cached) imgEl.src = cached;
        return;
      }
      const src = await this._extractThumbnailFrom3MFBase64(rec.data3mf);
      if (src) {
        imgEl.src = src;
        if (this._thumbCache) this._thumbCache.set(rec.name, src);
      }
    } catch {}
  }

  async _captureThumbnail(size = 60) {
    try {
      const renderer = this.viewer?.renderer;
      const canvas = renderer?.domElement;
      const cam = this.viewer?.camera;
      const controls = this.viewer?.controls;
      if (!canvas || !cam) return null;

      // Save camera state to restore after capture
      const saved = {
        position: cam.position.clone(),
        quaternion: cam.quaternion.clone(),
        up: cam.up.clone(),
        zoom: cam.zoom,
      };

      // Temporarily set an isometric orientation and zoom to fit
      try {
        const pivot = (controls && controls._gizmos && controls._gizmos.position)
          ? controls._gizmos.position.clone()
          : new THREE.Vector3(0, 0, 0);
        const dist = Math.max(1e-6, cam.position.distanceTo(pivot) || cam.position.length() || 10);
        const dir = new THREE.Vector3(1, 1, 1).normalize();
        const pos = pivot.clone().add(dir.multiplyScalar(dist));
        cam.position.copy(pos);
        cam.up.set(0, 1, 0); // keep default Y-up for stability
        cam.lookAt(pivot);
        cam.updateMatrixWorld(true);
        if (controls?.updateMatrixState) { try { controls.updateMatrixState(); } catch {} }
        // Fit geometry within current orientation
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

      // Restore camera state
      try {
        cam.position.copy(saved.position);
        cam.quaternion.copy(saved.quaternion);
        cam.up.copy(saved.up);
        cam.zoom = saved.zoom;
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        if (controls?.updateMatrixState) { try { controls.updateMatrixState(); } catch {} }
        this.viewer.render();
      } catch { /* ignore restore failures */ }

      return dataUrl;
    } catch {
      return null;
    }
  }
}
