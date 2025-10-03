// LabelOverlay.js
// Manages creation and positioning of PMI label overlays in viewer container.

export class LabelOverlay {
  constructor(viewer, onPointerDown, onDblClick, onClick, onDragEnd) {
    this.viewer = viewer;
    this.onPointerDown = typeof onPointerDown === 'function' ? onPointerDown : null;
    this.onDblClick = typeof onDblClick === 'function' ? onDblClick : null;
    this.onClick = typeof onClick === 'function' ? onClick : null;
    this.onDragEnd = typeof onDragEnd === 'function' ? onDragEnd : null;
    this._labelMap = new Map(); // idx -> HTMLElement
    this._root = null;
    this._activePointers = new Map(); // pointerId -> { idx, ann, startX, startY, moved }
    this._onGlobalPointerMove = (ev) => this.#handleGlobalPointerMove(ev);
    this._onGlobalPointerUp = (ev) => this.#handleGlobalPointerUp(ev);
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
      if (this.onPointerDown || this.onClick) {
        el.addEventListener('pointerdown', (e) => {
          try {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation?.();
          } catch {}
          if (this.onClick || this.onPointerDown) {
            this.#trackPointerDown(e, idx, ann);
          }
        });
      }
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

  #trackPointerDown(e, idx, ann) {
    console.log('LabelOverlay #trackPointerDown called', { e, idx, ann });
    if (typeof e !== 'object') return;
    if (e.button != null && e.button !== 0) return; // left-click only
    const entry = {
      idx,
      ann,
      startX: typeof e.clientX === 'number' ? e.clientX : 0,
      startY: typeof e.clientY === 'number' ? e.clientY : 0,
      hasMoved: false,
      dragStarted: false,
      initialEvent: e,
    };
    this._activePointers.set(e.pointerId ?? 'mouse', entry);
    try { window.addEventListener('pointermove', this._onGlobalPointerMove, true); } catch { }
    try { window.addEventListener('pointerup', this._onGlobalPointerUp, true); } catch { }
  }

  #handleGlobalPointerMove(ev) {
    const id = ev.pointerId ?? 'mouse';
    const state = this._activePointers.get(id);
    if (!state) return;
    const cx = ev.clientX;
    const cy = ev.clientY;
    if (cx == null || cy == null) {
      state.hasMoved = true;
      return;
    }
    const dx = cx - state.startX;
    const dy = cy - state.startY;
    const threshold = 4;
    if (!state.hasMoved && (dx * dx + dy * dy) >= threshold * threshold) {
      state.hasMoved = true;
      if (!state.dragStarted && this.onPointerDown) {
        state.dragStarted = true;
        try { this.onPointerDown(state.idx, state.ann, state.initialEvent); } catch {}
      }
    }
  }

  #handleGlobalPointerUp(ev) {
    const id = ev.pointerId ?? 'mouse';
    const state = this._activePointers.get(id);
    if (!state) return;
    this._activePointers.delete(id);
    if (this._activePointers.size === 0) {
      try { window.removeEventListener('pointermove', this._onGlobalPointerMove, true); } catch { }
      try { window.removeEventListener('pointerup', this._onGlobalPointerUp, true); } catch { }
    }

    if (state.dragStarted) {
      if (this.onDragEnd) {
        try { this.onDragEnd(state.idx, state.ann, ev); } catch {}
      }
      return;
    }
    if (!this.onClick) return;
    if (state.hasMoved) return;
    if (ev.button != null && ev.button !== 0) return;
    try { this.onClick(state.idx, state.ann, ev); } catch { }
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
    this._activePointers.clear();
    try { window.removeEventListener('pointermove', this._onGlobalPointerMove, true); } catch {}
    try { window.removeEventListener('pointerup', this._onGlobalPointerUp, true); } catch {}
  }
}
