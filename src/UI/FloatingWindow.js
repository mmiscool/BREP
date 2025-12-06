// FloatingWindow.js - lightweight draggable, shadable, resizable window
// Framework-free ES module used across UI widgets.

export class FloatingWindow {
  constructor({
    title = 'Window',
    width = 420,
    height = 320,
    minWidth = 260,
    minHeight = 140,
    x = null,
    y = null,
    right = 16,    // if x is null and right provided, compute from viewport width
    top = 40,      // default top if y not provided
    bottom = null, // if provided and y is null, compute from viewport height
    shaded = false,
    zIndex = 6,
  } = {}) {
    this._minW = Math.max(160, Number(minWidth) || 260);
    this._minH = Math.max(100, Number(minHeight) || 140);
    this._isShaded = Boolean(shaded);
    this._dragging = false;
    this._resizing = false;
    this._dragStart = { x: 0, y: 0, left: 0, top: 0 };
    this._resizeStart = { x: 0, y: 0, w: 0, h: 0 };
    this._unshadedH = null; // cache last expanded height
    this._movedDuringPress = false;
    this._moveThreshold = 5; // px to distinguish click vs drag

    this._ensureStyles();

    const root = document.createElement('div');
    root.className = 'floating-window';
    root.style.zIndex = String(zIndex);
    root.style.width = Math.max(this._minW, Number(width) || 420) + 'px';
    root.style.height = Math.max(this._minH, Number(height) || 320) + 'px';

    // Positioning (fixed)
    const { innerWidth: vw = 0, innerHeight: vh = 0 } = window || {};
    let left = (x != null) ? Number(x) : null;
    let topPx = (y != null) ? Number(y) : null;
    if (left == null && right != null && Number.isFinite(Number(right))) {
      const w = parseInt(root.style.width, 10) || 0;
      left = Math.max(8, (vw - w - Number(right)));
    }
    if (topPx == null) {
      if (bottom != null && Number.isFinite(Number(bottom))) {
        const h = parseInt(root.style.height, 10) || 0;
        topPx = Math.max(8, (vh - h - Number(bottom)));
      } else {
        topPx = Number(top) || 40;
      }
    }
    root.style.position = 'fixed';
    root.style.left = (Math.max(0, left ?? 16)) + 'px';
    root.style.top = (Math.max(0, topPx ?? 40)) + 'px';

    // Header
    const header = document.createElement('div');
    header.className = 'floating-window__header';
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');

    const titleEl = document.createElement('div');
    titleEl.className = 'floating-window__title';
    titleEl.textContent = String(title || '');
    const actions = document.createElement('div');
    actions.className = 'floating-window__actions';
    header.appendChild(titleEl);
    header.appendChild(actions);

    // Content
    const content = document.createElement('div');
    content.className = 'floating-window__content';

    // Resizer (bottom-right)
    const resizer = document.createElement('div');
    resizer.className = 'floating-window__resizer';
    root.appendChild(header);
    root.appendChild(content);
    root.appendChild(resizer);
    document.body.appendChild(root);

    // Persist refs
    this.root = root;
    this.header = header;
    this.titleEl = titleEl;
    this.actionsEl = actions;
    this.content = content;
    this.resizer = resizer;

    // Initial shaded state
    this.setShaded(this._isShaded);

    // Events: drag-to-move on header (but click toggles shade if not dragged)
    header.addEventListener('pointerdown', (ev) => this._onHeaderPointerDown(ev));
    // Prevent text selection while dragging
    header.addEventListener('dragstart', (e) => { try { e.preventDefault(); } catch {} });

    // Events: resize on resizer
    resizer.addEventListener('pointerdown', (ev) => this._onResizerPointerDown(ev));

    // Keyboard: toggle shade
    header.addEventListener('keydown', (ev) => {
      // Only toggle when focus is on header or title; ignore when on action buttons/inputs
      const t = ev.target;
      const onHeader = (t === header) || (this.titleEl && this.titleEl.contains(t));
      if (!onHeader) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this.toggleShaded();
      }
    });
  }

  destroy() {
    try { this.root && this.root.parentNode && this.root.parentNode.removeChild(this.root); } catch {}
    this.root = null; this.header = null; this.actionsEl = null; this.titleEl = null; this.content = null; this.resizer = null;
  }

  setTitle(text) { if (this.titleEl) this.titleEl.textContent = String(text || ''); }
  addHeaderAction(el) { if (el && this.actionsEl) this.actionsEl.appendChild(el); }
  setShaded(shaded) {
    this._isShaded = Boolean(shaded);
    if (!this.root || !this.content) return;
    this.root.classList.toggle('is-shaded', this._isShaded);
    if (this._isShaded) {
      const rect = this.root.getBoundingClientRect();
      this._unshadedH = Math.max(this._minH, Math.round(rect.height));
      const hh = this._headerHeight();
      this.content.hidden = true;
      this.root.style.height = hh + 'px';
    } else {
      const restore = Math.max(this._minH, Number(this._unshadedH) || parseInt(this.root.style.height, 10) || 320);
      this.content.hidden = false;
      this.root.style.height = restore + 'px';
    }
    try {
      this.root.dispatchEvent(new CustomEvent('shadechange', { detail: { shaded: this._isShaded } }));
    } catch {}
  }
  toggleShaded() { this.setShaded(!this._isShaded); }

  _onHeaderPointerDown(ev) {
    if (ev.button !== 0) return;
    // Ignore drags starting from header action controls (buttons/links/inputs)
    const t = ev.target;
    const interactive = (node) => {
      if (!node) return false;
      const tag = (node.tagName || '').toLowerCase();
      if (['button','a','input','select','textarea','label'].includes(tag)) return true;
      if (node.closest && (node.closest('.floating-window__actions') || node.closest('[data-no-drag]'))) return true;
      return false;
    };
    if (interactive(t)) return; // let the inner control handle the gesture
    this._dragging = true; this._movedDuringPress = false;
    this.header.setPointerCapture?.(ev.pointerId);
    const rect = this.root.getBoundingClientRect();
    this._dragStart = { x: ev.clientX, y: ev.clientY, left: rect.left, top: rect.top };
    const onMove = (e) => {
      const dx = (e.clientX - this._dragStart.x);
      const dy = (e.clientY - this._dragStart.y);
      if (Math.abs(dx) + Math.abs(dy) > this._moveThreshold) this._movedDuringPress = true;
      const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
      const w = this.root.offsetWidth || 0, h = this.root.offsetHeight || 0;
      let nx = this._dragStart.left + dx; let ny = this._dragStart.top + dy;
      nx = Math.min(Math.max(0, nx), Math.max(0, vw - w));
      const hh = this._headerHeight();
      ny = Math.min(Math.max(0, ny), Math.max(0, vh - (this._isShaded ? hh : h)));
      this.root.style.left = nx + 'px';
      this.root.style.top = ny + 'px';
    };
    const onUp = (e) => {
      this._dragging = false;
      try { this.header.releasePointerCapture?.(ev.pointerId); } catch {}
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      const totalMove = Math.abs(e.clientX - this._dragStart.x) + Math.abs(e.clientY - this._dragStart.y);
      if (totalMove <= this._moveThreshold) {
        this.toggleShaded();
      }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    try { ev.preventDefault(); ev.stopPropagation(); } catch {}
  }

  _onResizerPointerDown(ev) {
    if (ev.button !== 0) return;
    this._resizing = true;
    this.root.classList.add('is-resizing');
    this.resizer.setPointerCapture?.(ev.pointerId);
    const rect = this.root.getBoundingClientRect();
    this._resizeStart = { x: ev.clientX, y: ev.clientY, w: rect.width, h: rect.height };
    const onMove = (e) => {
      const dx = (e.clientX - this._resizeStart.x);
      const dy = (e.clientY - this._resizeStart.y);
      const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
      let nw = Math.max(this._minW, this._resizeStart.w + dx);
      let nh = Math.max(this._minH, this._resizeStart.h + dy);
      nw = Math.min(nw, vw - (this.root.getBoundingClientRect().left || 0) - 8);
      nh = Math.min(nh, vh - (this.root.getBoundingClientRect().top || 0) - 8);
      this.root.style.width = nw + 'px';
      this.root.style.height = nh + 'px';
    };
    const onUp = (_e) => {
      this._resizing = false;
      try { this.resizer.releasePointerCapture?.(ev.pointerId); } catch {}
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      this.root.classList.remove('is-resizing');
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    try { ev.preventDefault(); ev.stopPropagation(); } catch {}
  }

  _ensureStyles() {
    if (document.getElementById('floating-window-styles')) return;
    const style = document.createElement('style');
    style.id = 'floating-window-styles';
    style.textContent = `
      .floating-window { position: fixed; background:#0b0b0e; color:#e5e7eb; border:1px solid #2a2a33; border-radius:12px; box-shadow:0 10px 28px rgba(0,0,0,.55); display:flex; flex-direction:column; overflow:hidden; user-select:none; }
      .floating-window.is-shaded { overflow:hidden; }
      .floating-window__header { display:flex; align-items:center; gap:8px; padding:8px 10px; border-bottom:1px solid #23232b; cursor:grab; font:600 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; letter-spacing:.2px; }
      .floating-window__title { flex:1; }
      .floating-window__actions { display:flex; align-items:center; gap:6px; }
      .floating-window__actions .fw-btn { background:#1f2937; color:#f9fafb; border:1px solid #374151; padding:6px 8px; border-radius:8px; cursor:pointer; font:700 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      .floating-window__actions .fw-btn:hover { background:#2b3545; }
      .floating-window__content { flex:1; overflow:auto; padding:8px; }
      .floating-window.is-shaded .floating-window__content { display:none; }
      .floating-window__resizer { position:absolute; width:16px; height:16px; right:2px; bottom:2px; cursor:se-resize; }
      .floating-window.is-shaded .floating-window__resizer { display:none; }
      .floating-window__resizer::after { content:""; position:absolute; right:3px; bottom:3px; width:10px; height:10px; border-right:2px solid #4b5563; border-bottom:2px solid #4b5563; opacity:.8; }
      .floating-window.is-resizing, .floating-window__header:active { cursor:grabbing; }
    `;
    document.head.appendChild(style);
  }

  _headerHeight() {
    try {
      const r = this.header.getBoundingClientRect();
      return Math.max(28, Math.round(r.height));
    } catch { return 42; }
  }
}
