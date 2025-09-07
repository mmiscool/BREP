// fileManagerWidget.js
// A lightweight widget to save/load/delete models from browser localStorage.
// Designed to be embedded as an Accordion section (similar to expressionsManager).

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
          items.push({ name, savedAt: parsed?.savedAt, data: parsed?.data });
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
      return { name, savedAt: parsed?.savedAt, data: parsed?.data };
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

  // ----- UI -----
  _ensureStyles() {
    if (document.getElementById('file-manager-widget-styles')) return;
    const style = document.createElement('style');
    style.id = 'file-manager-widget-styles';
    style.textContent = `
      .fm-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; }
      .fm-row.header { border-bottom: 1px solid #1f2937; padding-bottom: 8px; margin-bottom: 4px; }
      .fm-grow { flex: 1 1 auto; overflow: hidden; }
      .fm-input { width: 100%; box-sizing: border-box; padding: 6px 8px; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 6px; }
      .fm-btn { background: #1f2937; color: #f9fafb; border: 1px solid #374151; padding: 2px 6px; border-radius: 6px; cursor: pointer; font-weight: 700; font-size: 12px; line-height: 1; min-width: 26px; height: 24px; display: inline-flex; align-items: center; justify-content: center; }
      .fm-btn:hover { background: #0f172a; }
      .fm-btn.danger { border-color: #7f1d1d; color: #fecaca; }
      .fm-list { padding: 4px 0; }
      .fm-left { display: flex; flex-direction: column; min-width: 0; }
      .fm-name { font-weight: 600; color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
      .fm-date { font-size: 11px; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
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

    const jsonString = await this.viewer.partHistory.toJSON();
    // Store structured data (object), not a JSON string, to avoid double-encoding
    let jsonObj;
    try {
      jsonObj = JSON.parse(jsonString);
    } catch {
      // Fallback: if parsing fails, keep the raw string
      jsonObj = jsonString;
    }
    const now = new Date().toISOString();
    const record = { savedAt: now, data: jsonObj };
    this._setModel(name, record);
    this.currentName = name;
    this._saveLastName(name);
    this.refreshList();
  }

  async loadModel(name) {
    if (!this.viewer || !this.viewer.partHistory) return;
    const rec = this._getModel(name);
    if (!rec) return alert('Model not found.');
    await this.viewer.partHistory.reset();
    // Support both legacy string payloads and structured objects
    const payload = (typeof rec.data === 'string') ? rec.data : JSON.stringify(rec.data);
    await this.viewer.partHistory.fromJSON(payload);
    await this.viewer.partHistory.runHistory();
    this.currentName = name;
    this.nameInput.value = name;
    this._saveLastName(name);
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
    for (const it of sorted) {
      const row = document.createElement('div');
      row.className = 'fm-row';

      const left = document.createElement('div');
      left.className = 'fm-left fm-grow';
      const nameSpan = document.createElement('div');
      nameSpan.className = 'fm-name';
      nameSpan.textContent = it.name;
      // Double-click file name to load the model
      nameSpan.addEventListener('dblclick', () => this.loadModel(it.name));
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
}
