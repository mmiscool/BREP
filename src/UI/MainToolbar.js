// MainToolbar.js — modular top toolbar.
// Shows action buttons (left) and inline selection filter (right).

import { SelectionFilterWidget } from './selectionFilterWidget.js';

export class MainToolbar {
  constructor(viewer) {
    this.viewer = viewer;
    this.root = document.createElement('div');
    this.root.id = 'main-toolbar';
    this._ensureStyles();
    this._buildUI();
    this._positionWithSidebar();

    // Keep position in sync with sidebar and window resizes
    window.addEventListener('resize', () => this._positionWithSidebar());
    try {
      if (window.ResizeObserver && this.viewer?.sidebar) {
        const ro = new ResizeObserver(() => this._positionWithSidebar());
        ro.observe(this.viewer.sidebar);
        this._ro = ro;
      }
    } catch { /* ignore */ }
  }

  _ensureStyles() {
    if (document.getElementById('main-toolbar-styles')) return;
    const style = document.createElement('style');
    style.id = 'main-toolbar-styles';
    style.textContent = `
      #main-toolbar {
        position: fixed;
        top: 0; left: 0; right: 0;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 10px;
        background: rgba(11,13,16,0.92);
        border-bottom: 1px solid #1e2430;
        backdrop-filter: blur(6px);
        z-index: 2147483646;
        pointer-events: auto;
      }
      .mtb-left, .mtb-right { display: flex; align-items: center; gap: 8px; }
      .mtb-spacer { flex: 1; }

      .mtb-btn {
        background: rgba(255,255,255,0.03);
        color: #e5e7eb;
        border: 1px solid #2a3442;
        padding: 6px 10px;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 700;
        font-size: 12px;
        line-height: 1;
        transition: background .15s ease, border-color .15s ease, transform .05s ease;
        user-select: none;
      }
      .mtb-btn:hover { background: #1b2433; border-color: #334155; }
      .mtb-btn:active { transform: translateY(1px); }
    `;
    document.head.appendChild(style);
  }

  _buildUI() {
    const left = document.createElement('div');
    left.className = 'mtb-left';

    // Buttons (modular; add more later)
    left.appendChild(this._btn('Save', 'Save current model', () => this._onSave()));
    left.appendChild(this._btn('Zoom to fit', 'Frame all geometry', () => this.viewer?.zoomToFit?.()));
    left.appendChild(this._btn('Wireframe', 'Toggle wireframe', () => this.viewer?.toggleWireframe?.()));
    left.appendChild(this._btn('About', 'Open About page', () => window.open('about.html', '_blank')));

    const right = document.createElement('div');
    right.className = 'mtb-right';

    // Inline Selection Filter (now on the right)
    this.selectionFilter = new SelectionFilterWidget(this.viewer, { inline: true, mountEl: right });

    this.root.appendChild(left);
    this.root.appendChild(right);
    document.body.appendChild(this.root);
  }

  _btn(label, title, onClick) {
    const b = document.createElement('button');
    b.className = 'mtb-btn';
    b.textContent = label;
    b.title = title || label;
    b.addEventListener('click', (e) => { e.stopPropagation(); try { onClick && onClick(); } catch {} });
    return b;
  }

  async _onSave() {
    // Prefer the FileManagerWidget if present
    try {
      if (this.viewer?.fileManagerWidget?.saveCurrent) {
        await this.viewer.fileManagerWidget.saveCurrent();
        return;
      }
    } catch {}
    // Fallback: quick autosave to localStorage
    try {
      const json = await this.viewer?.partHistory?.toJSON?.();
      const payload = { savedAt: new Date().toISOString(), data: JSON.parse(json) };
      localStorage.setItem('__BREP_MODEL__:autosave', JSON.stringify(payload));
      localStorage.setItem('__BREP_MODELS_LASTNAME__', 'autosave');
      alert('Saved as "autosave"');
    } catch {
      alert('Save failed.');
    }
  }

  _positionWithSidebar() {
    try {
      const sb = this.viewer?.sidebar;
      const w = Math.ceil(sb?.getBoundingClientRect?.().width || sb?.offsetWidth || 0);
      this.root.style.left = `${w}px`;
    } catch { this.root.style.left = '0px'; }
  }
}
