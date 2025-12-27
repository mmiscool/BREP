// MainToolbar.js - top toolbar that manages layout and button registration.
// Button logic is implemented externally and registered via addCustomButton()/viewer.addToolbarButton.

export class MainToolbar {
  constructor(viewer) {
    this.viewer = viewer;
    // Guard against duplicate toolbars if constructed twice (e.g., hot reloads)
    try {
      const existing = document.getElementById('main-toolbar');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    } catch { /* ignore */ }
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
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px;
        background: rgba(20,24,30,.85);
        border: 1px solid #262b36;
        border-radius: 8px;
        z-index: 10;
        pointer-events: auto;
        user-select: none;
      }
      .mtb-left, .mtb-right { display: flex; align-items: center; gap: 6px; }
      .mtb-spacer { flex: 1; }

      .mtb-btn {
        background: transparent;
        color: #ddd;
        border: 1px solid #364053;
        padding: 4px 8px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        line-height: 18px;
        user-select: none;
      }
      .mtb-btn.mtb-icon {
        min-width: 36px;
        font-size: 16px;
      }
      .mtb-btn.is-active {
        background: linear-gradient(180deg, rgba(110,168,254,.25), rgba(110,168,254,.15));
        border-color: #6ea8fe;
        color: #e9f0ff;
        box-shadow: 0 0 0 1px rgba(110,168,254,.2) inset;
      }
    `;
    document.head.appendChild(style);
  }

  _buildUI() {
    const left = document.createElement('div');
    left.className = 'mtb-left';
    this._left = left;

    // Buttons are provided by external modules via addCustomButton()/viewer.addToolbarButton

    const right = document.createElement('div');
    right.className = 'mtb-right';

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

  // Public: allow plugins to add custom buttons to the left cluster
  addCustomButton({ label, title, onClick }) {
    try {
      const btn = this._btn(String(label ?? '🔧'), String(title || ''), onClick);
      this._left?.appendChild(btn);
      return btn;
    } catch { return null; }
  }

  _positionWithSidebar() {
    try {
      const sb = this.viewer?.sidebar;
      const w = Math.ceil(sb?.getBoundingClientRect?.().width || sb?.offsetWidth || 0);
      this.root.style.left = `${w}px`;
    } catch { this.root.style.left = '0px'; }
  }
}
