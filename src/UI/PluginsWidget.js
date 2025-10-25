// PluginsWidget — manage plugin URLs (GitHub repos or generic base/entry URLs)
import { getSavedPluginUrls, savePluginUrls, loadPlugins, parseGithubUrl, getPluginEnabledMap, savePluginEnabledMap } from '../plugins/pluginManager.js';

export class PluginsWidget {
  constructor(viewer) {
    this.viewer = viewer;
    this.uiElement = document.createElement('div');
    this._ensureStyles();
    this._buildUI();
  }

  _ensureStyles() {
    if (document.getElementById('plugins-widget-styles')) return;
    const style = document.createElement('style');
    style.id = 'plugins-widget-styles';
    style.textContent = `
      .plg-col { display: flex; flex-direction: column; gap: 6px; }
      .plg-row { display: flex; gap: 6px; align-items: center; }
      .plg-list { width: 100%; min-height: 120px; max-height: 220px; overflow: auto; background: #0b0e14; color: #e5e7eb; border: 1px solid #1f2937; border-radius: 8px; padding: 4px; }
      .plg-item { display: grid; grid-template-columns: 18px 1fr; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: default; }
      .plg-item:hover { background: rgba(255,255,255,.03); }
      .plg-item.selected { outline: 1px solid #374151; background: rgba(59,130,246,.08); }
      .plg-url { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; user-select: text; }
      .plg-btn { background: rgba(255,255,255,.03); color: #f9fafb; border: 1px solid #374151; padding: 4px 8px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 12px; line-height: 1; transition: border-color .15s ease, background-color .15s ease, transform .05s ease; }
      .plg-btn:hover { border-color: #3b82f6; background: rgba(59,130,246,.12); }
      .plg-btn:active { transform: translateY(1px); }
      .plg-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
      .plg-hint { color: #9aa0aa; font-size: 11px; }
      .plg-status { color: #9ca3af; font-size: 11px; white-space: pre-wrap; }

      /* Modal styles */
      .plg-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 10; }
      .plg-modal { background: #0b0e14; color: #e5e7eb; border: 1px solid #1f2937; border-radius: 10px; padding: 14px; width: min(520px, calc(100vw - 32px)); box-shadow: 0 10px 40px rgba(0,0,0,.5); }
      .plg-modal h3 { margin: 0 0 8px 0; font-size: 14px; }
      .plg-modal p { margin: 6px 0; color: #9aa0aa; font-size: 12px; }
      .plg-input { width: 100%; border-radius: 8px; padding: 6px 8px; margin-bottom: 20px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
      .plg-modal .plg-row { margin-top: 10px; justify-content: flex-end; }
      .plg-err { color: #ef4444; font-size: 12px; min-height: 16px; }
    `;
    document.head.appendChild(style);
  }

  _buildUI() {
    const col = document.createElement('div');
    col.className = 'plg-col';
    // internal list state
    this.urls = getSavedPluginUrls();
    this.enabledMap = getPluginEnabledMap();
    this._selectedIndex = -1;

    // List of plugins as a custom list with checkboxes
    this.listEl = document.createElement('div');
    this.listEl.className = 'plg-list';
    this._refreshList();

    const actions = document.createElement('div');
    actions.className = 'plg-row';
    const addBtn = document.createElement('button');
    addBtn.className = 'plg-btn';
    addBtn.textContent = 'Add';
    this.delBtn = document.createElement('button');
    this.delBtn.className = 'plg-btn';
    this.delBtn.textContent = 'Delete';
    const loadBtn = document.createElement('button');
    loadBtn.className = 'plg-btn';
    loadBtn.textContent = 'Load Plugins Now';
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'plg-status';

    addBtn.addEventListener('click', () => this._openAddModal());
    this.delBtn.addEventListener('click', () => this._deleteSelected());
    loadBtn.addEventListener('click', async () => {
      this._setStatus('Loading...');
      const list = Array.isArray(this.urls) ? this.urls : [];
      const enabled = this.enabledMap && typeof this.enabledMap === 'object' ? this.enabledMap : {};
      const toLoad = list.filter(u => enabled[u] !== false);
      const res = await loadPlugins(this.viewer, toLoad || []);
      const lines = res.map(r => `${r.ok ? 'OK' : 'ERR'}  ${r.url}${r.ok ? '' : '  ' + (r.error?.message || r.error)}`);
      this._setStatus(lines.join('\n') || 'No plugins listed.');
    });

    actions.appendChild(addBtn);
    actions.appendChild(this.delBtn);
    actions.appendChild(loadBtn);


    col.appendChild(this.listEl);
    col.appendChild(actions);
    col.appendChild(this.statusEl);
    this.uiElement.appendChild(col);
  }

  _refreshList() {
    try { this.listEl.innerHTML = ''; } catch { }
    const list = Array.isArray(this.urls) ? this.urls : [];
    const enabled = this.enabledMap && typeof this.enabledMap === 'object' ? this.enabledMap : {};
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'plg-item';
      empty.style.opacity = '0.7';
      empty.textContent = 'No plugins saved';
      this.listEl.appendChild(empty);
      this._selectedIndex = -1;
    } else {
      list.forEach((url, idx) => {
        const row = document.createElement('div');
        row.className = 'plg-item' + (idx === this._selectedIndex ? ' selected' : '');

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = enabled[url] !== false; // default to true
        cb.title = 'Enable/disable loading this plugin';
        cb.addEventListener('change', () => {
          this.enabledMap[url] = Boolean(cb.checked);
          try { savePluginEnabledMap(this.enabledMap); } catch {}
        });

        const label = document.createElement('div');
        label.className = 'plg-url';
        label.textContent = url;

        const selectRow = (e) => {
          // Avoid toggling selection when clicking checkbox intentionally
          if (e && e.target === cb) return;
          this._selectedIndex = idx;
          Array.from(this.listEl.children).forEach((child, i) => {
            if (!(child instanceof HTMLElement)) return;
            child.classList.toggle('selected', i === idx);
          });
          if (this.delBtn) this.delBtn.disabled = list.length === 0 || this._selectedIndex < 0;
        };
        row.addEventListener('click', selectRow);

        row.appendChild(cb);
        row.appendChild(label);
        this.listEl.appendChild(row);
      });
      if (this._selectedIndex < 0 && list.length > 0) {
        this._selectedIndex = 0;
        if (this.listEl.firstChild) this.listEl.firstChild.classList.add('selected');
      }
    }
    if (this.delBtn) this.delBtn.disabled = list.length === 0 || this._selectedIndex < 0;
  }

  _save() { try { savePluginUrls(this.urls || []); } catch { } }

  _openAddModal() {
    const overlay = document.createElement('div');
    overlay.className = 'plg-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'plg-modal';

    const title = document.createElement('h3');
    title.textContent = 'Add third-party plugin';
    const h2 = document.createElement('h2');
    h2.style.color = 'red';
    h2.innerHTML = `Installing third-party plugins can be risky. <br><br>
    These plugins run code that we do not control, and malicious or poorly written plugins could compromise your data, expose sensitive information, or harm the stability and security of your application.
    <br><br>Only proceed if you fully trust the source of the plugin.
    <br><br>Enter either:
    <br>- a GitHub repository URL (e.g., https://github.com/USER/REPO or with /tree/branch)
    <br>- or a base/entry URL where plugin files are served (e.g., http://localhost:8080/ or https://example.com/my-plugin/plugin.js)`;

    const urlInput = document.createElement('input');
    urlInput.className = 'plg-input';
    urlInput.placeholder = 'GitHub repo or base/entry URL (e.g., https://github.com/USER/REPO or http://localhost:8080/)';

    const p2 = document.createElement('h2');
    p2.innerHTML = '<br>To proceed, type "yes" below to confirm you understand the risks of third-party plugins.';
    const confirmInput = document.createElement('input');
    confirmInput.className = 'plg-input';
    confirmInput.placeholder = 'type yes to confirm';

    const err = document.createElement('div');
    err.className = 'plg-err';

    const buttons = document.createElement('div');
    buttons.className = 'plg-row';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'plg-btn';
    cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.className = 'plg-btn';
    okBtn.textContent = 'Add Plugin';
    okBtn.disabled = true;

    const close = () => { try { document.body.removeChild(overlay); } catch { } };

    const validate = () => {
      const v = String(urlInput.value || '').trim();
      const c = String(confirmInput.value || '').trim().toLowerCase();
      let urlOk = false;
      err.textContent = '';
      if (v) {
        try {
          const u = new URL(v);
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            if (u.hostname === 'github.com') {
              // Enforce GitHub URL shape if it's a GitHub host
              parseGithubUrl(v);
            }
            urlOk = true;
          } else {
            throw new Error('URL must start with http(s)');
          }
        } catch (e) {
          urlOk = false;
          err.textContent = String(e?.message || 'Invalid URL');
        }
      }
      const confirmed = c === 'yes';
      okBtn.disabled = !(urlOk && confirmed);
    };

    urlInput.addEventListener('input', validate);
    confirmInput.addEventListener('input', validate);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    okBtn.addEventListener('click', () => {
      const v = String(urlInput.value || '').trim();
      const c = String(confirmInput.value || '').trim().toLowerCase();
      if (!v || c !== 'yes') return; // safety
      // For GitHub URLs, ensure shape is valid; otherwise accept generic http(s) URL
      try {
        const u = new URL(v);
        if (u.hostname === 'github.com') parseGithubUrl(v);
      } catch { return; }
      // prevent duplicates
      this.urls = Array.isArray(this.urls) ? this.urls : [];
      if (!this.urls.includes(v)) this.urls.push(v);
      this._save();
      // Default to enabled when adding
      try {
        this.enabledMap = this.enabledMap && typeof this.enabledMap === 'object' ? this.enabledMap : {};
        this.enabledMap[v] = true;
        savePluginEnabledMap(this.enabledMap);
      } catch { }
      this._refreshList();
      this._setStatus('Saved.');
      close();
    });

    modal.appendChild(title);
    modal.appendChild(h2);
    modal.appendChild(urlInput);
    modal.appendChild(p2);
    modal.appendChild(confirmInput);
    modal.appendChild(err);
    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    modal.appendChild(buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    try { urlInput.focus(); } catch { }
  }

  _deleteSelected() {
    const idx = this._selectedIndex;
    const list = Array.isArray(this.urls) ? this.urls : [];
    if (idx < 0 || idx >= list.length) return;
    const [removed] = list.splice(idx, 1);
    this.urls = list;
    this._save();
    try {
      if (removed && this.enabledMap && typeof this.enabledMap === 'object') {
        delete this.enabledMap[removed];
        savePluginEnabledMap(this.enabledMap);
      }
    } catch { }
    this._selectedIndex = Math.min(idx, Math.max(0, list.length - 1));
    this._refreshList();
    this._setStatus('Deleted.');
  }

  _setStatus(text) {
    this.statusEl.textContent = String(text || '');
  }
}
