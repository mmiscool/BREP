// LabelOverlay.js
// Manages creation and positioning of PMI label overlays in viewer container.

export class LabelOverlay {
  constructor(viewer, onPointerDown, onDblClick) {
    this.viewer = viewer;
    this.onPointerDown = typeof onPointerDown === 'function' ? onPointerDown : null;
    this.onDblClick = typeof onDblClick === 'function' ? onDblClick : null;
    this._labelMap = new Map(); // idx -> HTMLElement
    this._root = null;
    this._ensureRoot();
  }

  _ensureRoot() {
    if (this._root && this._root.parentNode) return;
    const host = this.viewer?.container;
    if (!host) return;
    try { if (!host.style.position || host.style.position === 'static') host.style.position = 'relative'; } catch {}
    const div = document.createElement('div');
    div.className = 'pmi-label-root';
    host.appendChild(div);
    this._root = div;
  }

  updateLabel(idx, text, worldPos, ann) {
    this._ensureRoot();
    let el = this._labelMap.get(idx);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pmi-label';
      if (text != null) {
        const normalized = String(text).replace(/\r\n/g, '\n');
        el.textContent = normalized;
      }
      if (this.onPointerDown) el.addEventListener('pointerdown', (e) => this.onPointerDown(idx, ann, e));
      if (this.onDblClick) el.addEventListener('dblclick', (e) => this.onDblClick(idx, ann, e));
      try { this._root.appendChild(el); this._labelMap.set(idx, el); } catch {}
    } else if (text != null) {
      const normalized = String(text).replace(/\r\n/g, '\n');
      el.textContent = normalized;
    }

    if (ann && typeof ann.anchorSide === 'string' && ann.anchorSide) {
      el.dataset.anchorSide = ann.anchorSide;
    } else {
      delete el.dataset.anchorSide;
    }
    if (worldPos) this._position(el, worldPos);
  }

  _position(el, world) {
    try {
      const v = this.viewer; if (!v) return;
      const vec = world.clone().project(v.camera);
      const canvasRect = v.renderer.domElement.getBoundingClientRect();
      const rootRect = this._root?.getBoundingClientRect?.() || canvasRect;
      const x = rootRect.left + (vec.x * 0.5 + 0.5) * canvasRect.width;
      const y = rootRect.top + (-vec.y * 0.5 + 0.5) * canvasRect.height;
      const relX = x - rootRect.left;
      const relY = y - rootRect.top;
      el.style.left = `${relX}px`;
      el.style.top = `${relY}px`;
    } catch {}
  }

  clear() {
    try { this._labelMap.forEach((el) => el?.remove()); } catch {}
    try { this._labelMap.clear(); } catch {}
  }

  dispose() {
    this.clear();
    try { this._root?.remove(); } catch {}
    this._root = null;
  }
}
