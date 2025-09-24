// PluginsWidget — simple textarea UI to manage GitHub plugin repo URLs (one per line)
import { getSavedPluginUrls, savePluginUrls, loadPlugins } from '../plugins/pluginManager.js';

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
      .plg-textarea { width: 100%; min-height: 120px; background: #0b0e14; color: #e5e7eb; border: 1px solid #1f2937; border-radius: 8px; padding: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
      .plg-btn { background: rgba(255,255,255,.03); color: #f9fafb; border: 1px solid #374151; padding: 4px 8px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 12px; line-height: 1; transition: border-color .15s ease, background-color .15s ease, transform .05s ease; }
      .plg-btn:hover { border-color: #3b82f6; background: rgba(59,130,246,.12); }
      .plg-btn:active { transform: translateY(1px); }
      .plg-hint { color: #9aa0aa; font-size: 11px; }
      .plg-status { color: #9ca3af; font-size: 11px; white-space: pre-wrap; }
    `;
    document.head.appendChild(style);
  }

  _buildUI() {
    const col = document.createElement('div');
    col.className = 'plg-col';

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'plg-textarea';
    this.textarea.placeholder = 'Paste GitHub repo URLs here (one per line)\nExamples:\nhttps://github.com/USER/REPO\nhttps://github.com/USER/REPO/tree/branch\nhttps://github.com/USER/REPO/tree/branch/sub/dir';
    const saved = getSavedPluginUrls();
    this.textarea.value = saved.join('\n');

    const actions = document.createElement('div');
    actions.className = 'plg-row';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'plg-btn';
    saveBtn.textContent = 'Save';
    const loadBtn = document.createElement('button');
    loadBtn.className = 'plg-btn';
    loadBtn.textContent = 'Load Plugins Now';
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'plg-status';

    saveBtn.addEventListener('click', () => {
      const urls = this._readLines();
      savePluginUrls(urls);
      this._setStatus('Saved.');
    });
    loadBtn.addEventListener('click', async () => {
      const urls = this._readLines();
      savePluginUrls(urls);
      this._setStatus('Loading...');
      const res = await loadPlugins(this.viewer, urls);
      const lines = res.map(r => `${r.ok ? 'OK' : 'ERR'}  ${r.url}${r.ok ? '' : '  ' + (r.error?.message || r.error)}`);
      this._setStatus(lines.join('\n') || 'No plugins listed.');
    });

    actions.appendChild(saveBtn);
    actions.appendChild(loadBtn);

    const hint = document.createElement('div');
    hint.className = 'plg-hint';
    hint.textContent = 'No manifest; loader expects plugin.js at that path. Uses jsDelivr + a worker; relative imports are rewritten to absolute.';

    col.appendChild(this.textarea);
    col.appendChild(actions);
    col.appendChild(hint);
    col.appendChild(this.statusEl);
    this.uiElement.appendChild(col);
  }

  _readLines() {
    return String(this.textarea.value || '')
      .split(/\r?\n/g)
      .map(s => s.trim())
      .filter(Boolean);
  }

  _setStatus(text) {
    this.statusEl.textContent = String(text || '');
  }
}

