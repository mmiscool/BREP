/*
  DockableLayout.js
  - ES6, no dependencies.
  - Absolute/fixed positioning only (no DOM re-parenting).
  - Supports docking to 4 sides, multiple panels per dock zone,
    and draggable splitters for resizing within a dock zone.
  - Prevents page overflow (locks body to viewport); panel content can scroll.

  Usage (minimal):
    import { DockableLayout } from './dockable-layout.js';
    const layout = new DockableLayout();
    layout.register(document.querySelector('#leftPanel'));
    layout.register(document.querySelector('#rightPanel'));

  Notes:
  - You can call layout.register(el, {dock:'left', size:280}) to start docked.
  - Panels are positioned with `position: fixed`.
  - Handles are added inside the panel; panel's own content remains intact.
*/

export class DockableLayout {
  constructor(options = {}) {
    this.options = {
      edgeSnapPx: 72,
      minPanelSize: 120,
      minCenterSize: 120,
      handleSize: 16,
      splitterSize: 6,
      dragThresholdPx: 4,
      zIndexBase: 1000,
      initialDockSize: 280,
      guideOpacity: 0.12,
      allowTopDock: true,
      onLayout: null,
      onZoneResize: null,
      ...options,
    };

    this._panels = new Map(); // el -> panel
    this._zones = {
      left: [],
      right: [],
      top: [],
      bottom: [],
      floating: [],
      center: [],
    };

    this._activeDrag = null;
    this._activeResize = null;
    this._activeZoneResize = null;
    this._zoneSizes = {
      left: null,
      right: null,
      top: null,
      bottom: null,
    };

    this._ensureGlobalStyles();

    // Overlay for guides and splitters
    this._overlay = document.createElement('div');
    this._overlay.className = 'dl-overlay';
    document.body.appendChild(this._overlay);

    this._guide = document.createElement('div');
    this._guide.className = 'dl-guide';
    this._overlay.appendChild(this._guide);
    this._guide.style.display = 'none';

    this._splitters = [];

    this._onWindowResize = () => this.layout();
    window.addEventListener('resize', this._onWindowResize, { passive: true });

    this.layout();
  }

  destroy() {
    window.removeEventListener('resize', this._onWindowResize);

    for (const panel of this._panels.values()) {
      this._teardownPanel(panel);
    }

    this._panels.clear();
    for (const key of Object.keys(this._zones)) this._zones[key] = [];

    this._removeSplitters();

    if (this._overlay && this._overlay.parentNode) this._overlay.parentNode.removeChild(this._overlay);
    this._overlay = null;
  }

  /**
   * Register an element as a dockable panel.
   * @param {HTMLElement} el
   * @param {{dock?: 'left'|'right'|'top'|'bottom'|'floating'|'center', size?: number, order?: number}} opts
   */
  register(el, opts = {}) {
    if (!(el instanceof HTMLElement)) throw new Error('DockableLayout.register expects an HTMLElement');
    if (this._panels.has(el)) return this._panels.get(el);

    let dock = opts.dock || 'floating';
    if (!this.options.allowTopDock && dock === 'top') dock = 'floating';
    const panel = {
      el,
      id: this._uid('panel'),
      dock,
      // size is along the stacking axis within a zone.
      // - left/right: height of each stacked panel
      // - top/bottom: width of each stacked panel
      // - floating/center: width/height controlled by rect
      size: Number.isFinite(opts.size) ? opts.size : this.options.initialDockSize,
      // For floating panels we keep a rect
      rect: {
        x: 80,
        y: 80,
        w: Math.max(260, this.options.initialDockSize),
        h: Math.max(220, this.options.initialDockSize),
      },
      order: Number.isFinite(opts.order) ? opts.order : 0,
      minSize: this.options.minPanelSize,
      contentMinSize: this.options.minPanelSize,
    };

    this._panels.set(el, panel);
    this._zones[panel.dock].push(panel);

    this._setupPanel(panel);
    this.layout();
    return panel;
  }

  /**
   * Unregister a panel and remove dockable decorations.
   * @param {HTMLElement} el
   */
  unregister(el) {
    const panel = this._panels.get(el);
    if (!panel) return false;

    const zone = this._zones[panel.dock];
    const idx = zone.indexOf(panel);
    if (idx >= 0) zone.splice(idx, 1);

    this._teardownPanel(panel);
    this._panels.delete(el);

    this.layout();
    return true;
  }

  /**
   * Make a panel docked to a zone (or floating).
   * @param {HTMLElement} el
   * @param {'left'|'right'|'top'|'bottom'|'floating'|'center'} dock
   */
  dock(el, dock) {
    const panel = this._panels.get(el);
    if (!panel) return;
    if (!this.options.allowTopDock && dock === 'top') dock = 'floating';
    if (!this._zones[dock]) throw new Error(`Unknown dock: ${dock}`);
    if (panel.dock === dock) return;

    // Remove from old zone
    const oldZone = this._zones[panel.dock];
    const idx = oldZone.indexOf(panel);
    if (idx >= 0) oldZone.splice(idx, 1);

    // Add to new zone
    panel.dock = dock;
    panel.order = this._zones[dock].length;
    this._zones[dock].push(panel);

    this._bringToFront(panel);
    this.layout();
  }

  /**
   * Update floating rect (only meaningful for dock==='floating').
   */
  setFloatingRect(el, rect) {
    const panel = this._panels.get(el);
    if (!panel) return;
    panel.rect = {
      x: rect.x ?? panel.rect.x,
      y: rect.y ?? panel.rect.y,
      w: rect.w ?? panel.rect.w,
      h: rect.h ?? panel.rect.h,
    };
    if (panel.dock === 'floating') this.layout();
  }

  /**
   * Force recompute positions.
   */
  layout() {
    this._removeSplitters();

    if (!this.options.allowTopDock && this._zones.top?.length) {
      const moved = this._zones.top.splice(0);
      for (const panel of moved) {
        panel.dock = 'floating';
        panel.order = this._zones.floating.length;
        this._zones.floating.push(panel);
      }
    }

    for (const zone of Object.keys(this._zones)) {
      this._zones[zone].sort((a, b) => a.order - b.order);
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Compute dock zone extents (outer frame reserved sizes)
    const leftWidth = this._zoneThickness('left', 'x', vw, vh);
    const rightWidth = this._zoneThickness('right', 'x', vw, vh);
    const topHeight = this.options.allowTopDock ? this._zoneThickness('top', 'y', vw, vh) : 0;
    const bottomHeight = this._zoneThickness('bottom', 'y', vw, vh);

    const centerW = Math.max(0, vw - leftWidth - rightWidth);
    const centerH = Math.max(0, vh - topHeight - bottomHeight);

    this._makeZoneSplitters({
      vw,
      vh,
      leftWidth,
      rightWidth,
      topHeight,
      bottomHeight,
      centerW,
      centerH,
    });

    const center = {
      x: leftWidth,
      y: topHeight,
      w: centerW,
      h: centerH,
    };

    // Lay out each dock zone's panels (stacking)
    this._layoutVerticalZone('left', { x: 0, y: 0, w: leftWidth, h: vh });
    this._layoutVerticalZone('right', { x: vw - rightWidth, y: 0, w: rightWidth, h: vh });

    if (this.options.allowTopDock) {
      this._layoutHorizontalZone('top', { x: leftWidth, y: 0, w: vw - leftWidth - rightWidth, h: topHeight });
    }
    this._layoutHorizontalZone('bottom', { x: leftWidth, y: vh - bottomHeight, w: vw - leftWidth - rightWidth, h: bottomHeight });

    // Center dock zone behaves like a single full rect per panel (stacked like tabs isn't done here).
    // If multiple center panels exist, we stack them vertically by default.
    this._layoutVerticalZone('center', { ...center });

    // Floating panels
    for (const panel of this._visiblePanels('floating')) {
      this._applyRect(panel, {
        x: this._clamp(panel.rect.x, 0, vw - this.options.minPanelSize),
        y: this._clamp(panel.rect.y, 0, vh - this.options.minPanelSize),
        w: this._clamp(panel.rect.w, this.options.minPanelSize, vw),
        h: this._clamp(panel.rect.h, this.options.minPanelSize, vh),
      });
    }

    // Ensure docked panels are behind floating ones
    this._restackZ();
    if (typeof this.options.onLayout === 'function') {
      try { this.options.onLayout(); } catch { /* ignore */ }
    }
  }

  // -------------------- Internal: layout helpers --------------------

  getZoneSize(zone) {
    if (!this._zones?.[zone]) return 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const axis = (zone === 'left' || zone === 'right') ? 'x' : 'y';
    return this._zoneThickness(zone, axis, vw, vh);
  }

  _zoneThickness(zone, axis, vw, vh) {
    if (zone === 'top' && this.options.allowTopDock === false) return 0;
    const panels = this._visiblePanels(zone);
    if (!panels || panels.length === 0) return 0;

    const override = this._zoneSizes?.[zone];
    if (Number.isFinite(override) && override > 0) {
      if (zone === 'left' || zone === 'right') {
        return this._clamp(override, 160, Math.floor(vw * 0.7));
      }
      if (zone === 'top' || zone === 'bottom') {
        return this._clamp(override, 72, Math.floor(vh * 0.6));
      }
    }

    // Default thickness: based on first panel's current size in the *other* axis.
    // For left/right, thickness is width; for top/bottom thickness is height.
    // We store per-panel "size" as stack size; thickness comes from panel.el's current rect if available.

    // Prefer explicit CSS variable if set on element: --dock-thickness
    for (const p of panels) {
      const css = getComputedStyle(p.el);
      let v = parseFloat(css.getPropertyValue(`--dock-thickness-${zone}`));
      if (!Number.isFinite(v) || v <= 0) v = parseFloat(css.getPropertyValue('--dock-thickness'));
      if (Number.isFinite(v) && v > 0) {
        if (axis === 'x') return this._clamp(v, 160, Math.floor(vw * 0.7));
        return this._clamp(v, 120, Math.floor(vh * 0.7));
      }
    }

    // Fallback to a reasonable default
    if (zone === 'left' || zone === 'right') return this._clamp(this.options.initialDockSize, 160, Math.floor(vw * 0.7));
    if (zone === 'top' || zone === 'bottom') return this._clamp(Math.floor(vh * 0.18), 72, Math.floor(vh * 0.6));
    return 0;
  }

  _layoutVerticalZone(zone, rect) {
    const panels = this._visiblePanels(zone);
    if (!panels || panels.length === 0) return;

    // Vertical stack: each panel consumes height = panel.size (except last gets remainder).
    // Add splitters between them to resize adjacent sizes.
    const mins = panels.map((panel) => this._panelMinSize(panel));
    const total = rect.h;

    // Normalize sizes to fit
    let sizes = this._normalizeSizes(panels.map(p => p.size), total, mins, zone);
    for (let i = 0; i < panels.length; i++) panels[i].size = sizes[i];
    sizes = this._applyAutoCollapse(panels, sizes, total, zone);
    for (let i = 0; i < panels.length; i++) panels[i].size = sizes[i];

    const collapsedFlags = panels.map((panel) => this._isPanelCollapsed(panel));
    let bottomStart = null;
    if (collapsedFlags.some(Boolean)) {
      sizes = this._applyCollapsedAnchorsVertical(panels, sizes, total, collapsedFlags);
      for (let i = 0; i < panels.length; i++) panels[i].size = sizes[i];
      const tailStart = this._tailCollapsedStart(collapsedFlags);
      if (tailStart >= 0) {
        if (tailStart === 0) {
          if (panels.length > 1) bottomStart = 1;
        } else {
          bottomStart = tailStart;
        }
      }
    }

    let y = rect.y;
    let bottomStackStart = null;
    if (bottomStart !== null) {
      const tailSum = sizes.slice(bottomStart).reduce((a, b) => a + b, 0);
      bottomStackStart = rect.y + total - tailSum;
    }

    for (let i = 0; i < panels.length; i++) {
      if (bottomStart !== null && i === bottomStart) y = bottomStackStart;
      const h = sizes[i];
      const p = panels[i];
      this._applyRect(p, { x: rect.x, y, w: rect.w, h });

      // splitter between i and i+1
      if (i < panels.length - 1) {
        let splitterY = y + h - Math.floor(this.options.splitterSize / 2);
        if (bottomStart !== null && i + 1 === bottomStart && bottomStackStart !== null && bottomStackStart > y + h) {
          splitterY = bottomStackStart - Math.floor(this.options.splitterSize / 2);
        }
        this._makeSplitter({
          zone,
          index: i,
          orientation: 'h',
          x: rect.x,
          y: splitterY,
          w: rect.w,
          h: this.options.splitterSize,
          a: panels[i],
          b: panels[i + 1],
        });
      }
      y += h;
    }
  }

  _layoutHorizontalZone(zone, rect) {
    const panels = this._visiblePanels(zone);
    if (!panels || panels.length === 0) return;

    // Horizontal stack: each panel consumes width = panel.size
    const mins = panels.map((panel) => this._panelMinSize(panel));
    const total = rect.w;

    let sizes = this._normalizeSizes(panels.map(p => p.size), total, mins, zone);
    for (let i = 0; i < panels.length; i++) panels[i].size = sizes[i];
    sizes = this._applyAutoCollapse(panels, sizes, total, zone);
    for (let i = 0; i < panels.length; i++) panels[i].size = sizes[i];

    let x = rect.x;
    for (let i = 0; i < panels.length; i++) {
      const w = sizes[i];
      const p = panels[i];
      this._applyRect(p, { x, y: rect.y, w, h: rect.h });

      if (i < panels.length - 1) {
        this._makeSplitter({
          zone,
          index: i,
          orientation: 'v',
          x: x + w - Math.floor(this.options.splitterSize / 2),
          y: rect.y,
          w: this.options.splitterSize,
          h: rect.h,
          a: panels[i],
          b: panels[i + 1],
        });
      }
      x += w;
    }
  }

  _normalizeSizes(raw, total, min, zone) {
    const mins = Array.isArray(min) ? min.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0)) : raw.map(() => min);
    if (raw.length === 1) return [Math.max(mins[0] || 0, total)];

    // Clamp each to min first
    let sizes = raw.map((v, i) => (Number.isFinite(v) ? Math.max(mins[i] || 0, v) : (mins[i] || 0)));

    const sum = sizes.reduce((a, b) => a + b, 0);

    if (sum === total) return sizes;

    // If too large, shrink proportionally (down to min)
    if (sum > total) {
      let over = sum - total;
      // Repeatedly take from largest until it fits (keeps stability)
      sizes = sizes.slice();
      while (over > 0.5) {
        let idx = 0;
        let best = 0;
        for (let i = 0; i < sizes.length; i++) {
          const can = Math.max(0, sizes[i] - (mins[i] || 0));
          if (can > best) {
            best = can;
            idx = i;
          }
        }
        const can = Math.max(0, sizes[idx] - (mins[idx] || 0));
        if (can <= 0) break;
        const take = Math.min(can, over);
        sizes[idx] -= take;
        over -= take;
      }
      // If still over (all at min), force last to remainder
      const newSum = sizes.reduce((a, b) => a + b, 0);
      if (newSum !== total) {
        const last = sizes.length - 1;
        sizes[last] = Math.max(mins[last] || 0, sizes[last] - (newSum - total));
      }
      return sizes;
    }

    // If too small, give remainder to last
    const under = total - sum;
    sizes = sizes.slice();
    sizes[sizes.length - 1] += under;
    return sizes;
  }

  _applyRect(panel, rect) {
    const el = panel.el;

    el.style.position = 'fixed';
    el.style.left = `${Math.round(rect.x)}px`;
    el.style.top = `${Math.round(rect.y)}px`;
    el.style.width = `${Math.round(rect.w)}px`;
    el.style.height = `${Math.round(rect.h)}px`;

    // No page overflow; let contents scroll.
    el.style.boxSizing = 'border-box';
    el.style.overflow = 'hidden';

    // Ensure content wrapper scrolls
    const body = el.querySelector(':scope > .dl-body');
    const handle = el.querySelector(':scope > .dl-handle');
    if (body) {
      body.style.overflow = 'auto';
      const handleHeight = Math.ceil(handle?.getBoundingClientRect?.().height || this.options.handleSize);
      body.style.height = `calc(100% - ${handleHeight}px)`;
    }

    if (panel._resize) {
      panel._resize.style.display = panel.dock === 'floating' ? 'block' : 'none';
    }

    // Update floating rect cache
    if (panel.dock === 'floating') {
      panel.rect.x = rect.x;
      panel.rect.y = rect.y;
      panel.rect.w = rect.w;
      panel.rect.h = rect.h;
    }
  }

  // -------------------- Internal: panel setup --------------------
  _visiblePanels(zone) {
    const panels = this._zones[zone] || [];
    return panels.filter((panel) => !panel.el.hidden && panel.el.style.display !== 'none');
  }

  _setupPanel(panel) {
    const el = panel.el;

    // Wrap existing children into a body container without reparenting the panel itself.
    // This DOES move children, but keeps the panel element in place (the requirement is about not
    // reparenting the panel when docking).
    if (!el.querySelector(':scope > .dl-handle')) {
      const handle = document.createElement('div');
      handle.className = 'dl-handle';
      handle.title = 'Drag to move / dock';

      const grip = document.createElement('div');
      grip.className = 'dl-grip';
      handle.appendChild(grip);

      // Body wrapper
      const body = document.createElement('div');
      body.className = 'dl-body';

      while (el.firstChild) body.appendChild(el.firstChild);
      el.appendChild(handle);
      el.appendChild(body);

      panel._handle = handle;
      panel._body = body;

      const handleTitle = body.querySelector(':scope > .dl-handle-title');
      if (handleTitle) {
        handle.classList.add('dl-handle-has-title');
        handle.appendChild(handleTitle);
      }

      const dragEl = handleTitle || handle;
      dragEl.addEventListener('pointerdown', (e) => this._startDrag(e, panel));
      panel._dragEl = dragEl;

      if (!el.querySelector(':scope > .dl-resize')) {
        const resize = document.createElement('div');
        resize.className = 'dl-resize';
        resize.title = 'Resize';
        resize.addEventListener('pointerdown', (e) => this._startPanelResize(e, panel));
        el.appendChild(resize);
        panel._resize = resize;
      }

      // Click-to-front
      el.addEventListener('pointerdown', () => this._bringToFront(panel), { passive: true });
    }

    // Baseline styling hints (user can override)
    el.classList.add('dl-panel');
    el.style.minWidth = `${this.options.minPanelSize}px`;
    el.style.minHeight = `${this.options.minPanelSize}px`;
    el.style.zIndex = `${this.options.zIndexBase}`;

    // If the element is already sized/positioned, prefer that as initial floating rect.
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      panel.rect.w = Math.max(this.options.minPanelSize, r.width);
      panel.rect.h = Math.max(this.options.minPanelSize, r.height);
      panel.rect.x = r.left;
      panel.rect.y = r.top;
    }
  }

  _teardownPanel(panel) {
    const el = panel.el;
    el.classList.remove('dl-panel');

    // Unwrap: move body children back
    const handle = el.querySelector(':scope > .dl-handle');
    const body = el.querySelector(':scope > .dl-body');
    if (handle) {
      const grip = handle.querySelector(':scope > .dl-grip');
      const extras = Array.from(handle.childNodes).filter((node) => node !== grip);
      extras.forEach((node) => el.insertBefore(node, handle));
    }
    if (body) {
      while (body.firstChild) el.insertBefore(body.firstChild, handle || null);
      body.remove();
    }
    if (handle) handle.remove();
    if (panel._resize) {
      panel._resize.remove();
      panel._resize = null;
    }

    // Remove positioning
    el.style.position = '';
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
    el.style.zIndex = '';
    el.style.overflow = '';
  }

  // -------------------- Dragging & docking --------------------

  _startDrag(e, panel) {
    // Only left button / primary
    if (e.button !== 0) return;
    const rect = panel.el.getBoundingClientRect();
    this._pendingDrag = {
      panel,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
    };

    window.addEventListener('pointermove', this._onDragPendingMove, { passive: false });
    window.addEventListener('pointerup', this._onDragPendingEnd, { passive: false, once: true });
  }

  _onDragPendingMove = (e) => {
    const pending = this._pendingDrag;
    if (!pending) return;
    const dx = e.clientX - pending.startX;
    const dy = e.clientY - pending.startY;
    const threshold = this.options.dragThresholdPx || 4;
    if (Math.hypot(dx, dy) < threshold) return;
    e.preventDefault();
    window.removeEventListener('pointermove', this._onDragPendingMove);
    window.removeEventListener('pointerup', this._onDragPendingEnd);
    this._pendingDrag = null;
    this._beginDrag(e, pending);
  };

  _onDragPendingEnd = () => {
    window.removeEventListener('pointermove', this._onDragPendingMove);
    this._pendingDrag = null;
  };

  _beginDrag(e, pending) {
    const { panel, offsetX, offsetY, startX, startY } = pending;
    this._bringToFront(panel);

    const rect = panel.el.getBoundingClientRect();
    // Force floating while dragging (still no reparenting)
    if (panel.dock !== 'floating') {
      // Keep current rect
      panel.rect = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
      this.dock(panel.el, 'floating');
    }

    this._activeDrag = {
      panel,
      offsetX,
      offsetY,
      startX,
      startY,
      lastDockHint: null,
      pointerId: e.pointerId,
    };

    panel._handle?.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', this._onDragMove, { passive: false });
    window.addEventListener('pointerup', this._onDragEnd, { passive: false, once: true });

    this._onDragMove(e);
  }

  _startPanelResize(e, panel) {
    if (e.button !== 0) return;
    if (panel.dock !== 'floating') return;
    e.preventDefault();
    this._bringToFront(panel);
    const rect = panel.el.getBoundingClientRect();
    this._activePanelResize = {
      panel,
      startX: e.clientX,
      startY: e.clientY,
      startW: rect.width,
      startH: rect.height,
      originX: rect.left,
      originY: rect.top,
      pointerId: e.pointerId,
    };
    panel._resize?.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', this._onPanelResizeMove, { passive: false });
    window.addEventListener('pointerup', this._onPanelResizeEnd, { passive: false, once: true });
  }

  _onPanelResizeMove = (e) => {
    if (!this._activePanelResize) return;
    e.preventDefault();
    const { panel, startX, startY, startW, startH, originX, originY } = this._activePanelResize;
    const min = this.options.minPanelSize;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = this._clamp(startW + (e.clientX - startX), min, Math.max(min, vw - originX));
    const h = this._clamp(startH + (e.clientY - startY), min, Math.max(min, vh - originY));
    panel.rect.w = w;
    panel.rect.h = h;
    this._applyRect(panel, {
      x: panel.rect.x,
      y: panel.rect.y,
      w,
      h,
    });
  };

  _onPanelResizeEnd = (e) => {
    if (!this._activePanelResize) return;
    e.preventDefault();
    window.removeEventListener('pointermove', this._onPanelResizeMove);
    this._activePanelResize = null;
  };

  _onDragMove = (e) => {
    if (!this._activeDrag) return;
    e.preventDefault();

    const { panel, offsetX, offsetY } = this._activeDrag;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const x = this._clamp(e.clientX - offsetX, 0, vw - this.options.minPanelSize);
    const y = this._clamp(e.clientY - offsetY, 0, vh - this.options.minPanelSize);

    // Move floating rect
    panel.rect.x = x;
    panel.rect.y = y;

    // Dock hint based on cursor proximity to edges OR to existing dock zones
    const hint = this._dockHintForPoint(e.clientX, e.clientY);
    this._activeDrag.lastDockHint = hint;

    this._showGuide(hint);

    // Apply immediate rect for smoothness
    this._applyRect(panel, {
      x: panel.rect.x,
      y: panel.rect.y,
      w: panel.rect.w,
      h: panel.rect.h,
    });
  };

  _onDragEnd = (e) => {
    if (!this._activeDrag) return;
    e.preventDefault();

    window.removeEventListener('pointermove', this._onDragMove);

    const { panel, lastDockHint } = this._activeDrag;
    this._activeDrag = null;

    this._hideGuide();

    if (lastDockHint && lastDockHint.dock !== 'floating') {
      // Dock it
      this.dock(panel.el, lastDockHint.dock);
      // For dock zones, pick a default stack size if panel.size isn't set
      if (!Number.isFinite(panel.size) || panel.size < this.options.minPanelSize) {
        panel.size = this.options.initialDockSize;
      }
    } else {
      // Stay floating
      this.dock(panel.el, 'floating');
    }

    this.layout();
  };

  _dockHintForPoint(x, y) {
    const snap = this.options.edgeSnapPx;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const allowTop = this.options.allowTopDock !== false;

    const leftW = this._zoneThickness('left', 'x', vw, vh);
    const rightW = this._zoneThickness('right', 'x', vw, vh);
    const leftBoundary = leftW > 0 ? leftW : 0;
    const rightBoundary = rightW > 0 ? vw - rightW : vw;

    // Edge snap zones
    const nearLeft = x <= snap;
    const nearRight = x >= vw - snap;
    const nearTop = y <= snap;
    const nearBottom = y >= vh - snap;

    if (nearLeft || x < leftBoundary) return { dock: 'left', rect: this._dockGuideRect('left') };
    if (nearRight || x > rightBoundary) return { dock: 'right', rect: this._dockGuideRect('right') };

    const min = Math.min(x, vw - x, y, vh - y);
    if (min > snap) return { dock: 'floating', rect: null };

    if (allowTop && nearTop && x >= leftBoundary && x <= rightBoundary) {
      return { dock: 'top', rect: this._dockGuideRect('top') };
    }
    if (nearBottom && x >= leftBoundary && x <= rightBoundary) {
      return { dock: 'bottom', rect: this._dockGuideRect('bottom') };
    }
    return { dock: 'floating', rect: null };
  }

  _dockGuideRect(dock) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (dock === 'top' && this.options.allowTopDock === false) return null;

    const leftW = this._zoneThickness('left', 'x', vw, vh);
    const rightW = this._zoneThickness('right', 'x', vw, vh);
    const topH = this._zoneThickness('top', 'y', vw, vh);
    const bottomH = this._zoneThickness('bottom', 'y', vw, vh);

    // If that zone currently has no thickness (no panels), use defaults (or last known size)
    const zoneHint = (zone) => {
      const v = this._zoneSizes?.[zone];
      if (!Number.isFinite(v) || v <= 0) return null;
      if (zone === 'left' || zone === 'right') return this._clamp(v, 160, Math.floor(vw * 0.7));
      return this._clamp(v, 72, Math.floor(vh * 0.6));
    };

    const defaultLeftW = zoneHint('left') ?? this._clamp(this.options.initialDockSize, 160, Math.floor(vw * 0.7));
    const defaultRightW = zoneHint('right') ?? defaultLeftW;
    const defaultTopH = zoneHint('top') ?? this._clamp(Math.floor(vh * 0.18), 72, Math.floor(vh * 0.6));
    const defaultBottomH = zoneHint('bottom') ?? defaultTopH;

    const L = leftW || defaultLeftW;
    const R = rightW || defaultRightW;
    const T = topH || defaultTopH;
    const B = bottomH || defaultBottomH;

    const leftBound = leftW > 0 ? leftW : 0;
    const rightBound = rightW > 0 ? rightW : 0;
    const centerW = Math.max(0, vw - leftBound - rightBound);

    if (dock === 'left') return { x: 0, y: 0, w: L, h: vh };
    if (dock === 'right') return { x: vw - R, y: 0, w: R, h: vh };
    if (dock === 'top') return { x: leftBound, y: 0, w: centerW, h: T };
    if (dock === 'bottom') return { x: leftBound, y: vh - B, w: centerW, h: B };
    return null;
  }

  _showGuide(hint) {
    if (!hint || !hint.rect || hint.dock === 'floating') {
      this._hideGuide();
      return;
    }
    const r = hint.rect;
    this._guide.style.display = 'block';
    this._guide.style.left = `${Math.round(r.x)}px`;
    this._guide.style.top = `${Math.round(r.y)}px`;
    this._guide.style.width = `${Math.round(r.w)}px`;
    this._guide.style.height = `${Math.round(r.h)}px`;
  }

  _hideGuide() {
    if (this._guide) this._guide.style.display = 'none';
  }

  // -------------------- Splitters (resizing) --------------------

  _makeSplitter(spec) {
    const s = document.createElement('div');
    s.className = `dl-splitter dl-splitter-${spec.orientation}`;
    s.style.left = `${Math.round(spec.x)}px`;
    s.style.top = `${Math.round(spec.y)}px`;
    s.style.width = `${Math.round(spec.w)}px`;
    s.style.height = `${Math.round(spec.h)}px`;
    s.style.zIndex = `${this.options.zIndexBase + 500}`;

    s.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const panels = this._visiblePanels(spec.zone);
      let indexA = panels.indexOf(spec.a);
      let indexB = panels.indexOf(spec.b);
      if (indexA < 0 && Number.isFinite(spec.index)) indexA = spec.index;
      if (indexB < 0 && Number.isFinite(indexA)) indexB = Math.min(indexA + 1, panels.length - 1);
      this._activeResize = {
        spec,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        panels,
        sizes: panels.map((p) => p.size),
        indexA,
        indexB,
      };
      s.setPointerCapture?.(e.pointerId);
      window.addEventListener('pointermove', this._onResizeMove, { passive: false });
      window.addEventListener('pointerup', this._onResizeEnd, { passive: false, once: true });
    });

    this._overlay.appendChild(s);
    this._splitters.push(s);
  }

  _makeZoneSplitters({ vw, vh, leftWidth, rightWidth, topHeight, bottomHeight, centerW, centerH }) {
    const size = this.options.splitterSize;
    const half = Math.floor(size / 2);
    const sizes = {
      left: leftWidth,
      right: rightWidth,
      top: topHeight,
      bottom: bottomHeight,
    };

    if (leftWidth > 0 && centerW > 0) {
      this._makeZoneSplitter({
        zone: 'left',
        orientation: 'v',
        x: leftWidth - half,
        y: 0,
        w: size,
        h: vh,
        sizes,
        vw,
        vh,
      });
    }
    if (rightWidth > 0 && centerW > 0) {
      this._makeZoneSplitter({
        zone: 'right',
        orientation: 'v',
        x: vw - rightWidth - half,
        y: 0,
        w: size,
        h: vh,
        sizes,
        vw,
        vh,
      });
    }

    if (topHeight > 0 && centerH > 0 && centerW > 0) {
      this._makeZoneSplitter({
        zone: 'top',
        orientation: 'h',
        x: leftWidth,
        y: topHeight - half,
        w: centerW,
        h: size,
        sizes,
        vw,
        vh,
      });
    }
    if (bottomHeight > 0 && centerH > 0 && centerW > 0) {
      this._makeZoneSplitter({
        zone: 'bottom',
        orientation: 'h',
        x: leftWidth,
        y: vh - bottomHeight - half,
        w: centerW,
        h: size,
        sizes,
        vw,
        vh,
      });
    }
  }

  _makeZoneSplitter(spec) {
    const s = document.createElement('div');
    s.className = `dl-splitter dl-zone-splitter dl-splitter-${spec.orientation}`;
    s.style.left = `${Math.round(spec.x)}px`;
    s.style.top = `${Math.round(spec.y)}px`;
    s.style.width = `${Math.round(spec.w)}px`;
    s.style.height = `${Math.round(spec.h)}px`;
    s.style.zIndex = `${this.options.zIndexBase + 600}`;

    s.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const { zone, sizes, vw, vh } = spec;
      this._activeZoneResize = {
        zone,
        sizes: { ...sizes },
        startX: e.clientX,
        startY: e.clientY,
        startSize: sizes[zone] || 0,
        vw,
        vh,
        pointerId: e.pointerId,
      };
      s.setPointerCapture?.(e.pointerId);
      window.addEventListener('pointermove', this._onZoneResizeMove, { passive: false });
      window.addEventListener('pointerup', this._onZoneResizeEnd, { passive: false, once: true });
    });

    this._overlay.appendChild(s);
    this._splitters.push(s);
  }

  _onResizeMove = (e) => {
    if (!this._activeResize) return;
    e.preventDefault();

    const { spec, startX, startY, panels, sizes, indexA, indexB } = this._activeResize;
    if (!panels || panels.length < 2 || indexA < 0 || indexB < 0 || indexA >= panels.length) return;

    const delta = spec.orientation === 'h' ? (e.clientY - startY) : (e.clientX - startX);
    const nextSizes = sizes.slice();
    const applied = this._applySplitterDelta(panels, nextSizes, indexA, indexB, delta);
    if (applied === 0) return;
    this._autoExpandCollapsedFromResize(panels, nextSizes);
    for (let i = 0; i < panels.length; i++) panels[i].size = nextSizes[i];

    this.layout();
  };

  _onZoneResizeMove = (e) => {
    if (!this._activeZoneResize) return;
    e.preventDefault();

    const { zone, sizes, startX, startY, startSize, vw, vh } = this._activeZoneResize;
    const delta = (zone === 'left' || zone === 'right') ? (e.clientX - startX) : (e.clientY - startY);
    let next = startSize;
    if (zone === 'left' || zone === 'top') next = startSize + delta;
    else next = startSize - delta;

    const minCenter = Number.isFinite(this.options.minCenterSize) ? this.options.minCenterSize : 0;
    const baseMax = (zone === 'left' || zone === 'right') ? Math.floor(vw * 0.7) : Math.floor(vh * 0.6);
    let max = baseMax;
    if (zone === 'left') max = Math.min(baseMax, vw - sizes.right - minCenter);
    if (zone === 'right') max = Math.min(baseMax, vw - sizes.left - minCenter);
    if (zone === 'top') max = Math.min(baseMax, vh - sizes.bottom - minCenter);
    if (zone === 'bottom') max = Math.min(baseMax, vh - sizes.top - minCenter);
    if (!Number.isFinite(max)) max = baseMax;
    if (max < 0) max = 0;

    let min = (zone === 'left' || zone === 'right') ? 160 : 72;
    if (max < min) min = max;

    const clamped = this._clamp(next, min, max);
    if (!Number.isFinite(clamped)) return;

    const rounded = Math.round(clamped);
    if (this._zoneSizes[zone] === rounded) return;
    this._zoneSizes[zone] = rounded;

    if (typeof this.options.onZoneResize === 'function') {
      try { this.options.onZoneResize(zone, rounded, { sizes: { ...sizes } }); } catch { /* ignore */ }
    }

    this.layout();
  };

  _onZoneResizeEnd = (e) => {
    if (!this._activeZoneResize) return;
    e.preventDefault();
    window.removeEventListener('pointermove', this._onZoneResizeMove);
    this._activeZoneResize = null;
  };

  _onResizeEnd = (e) => {
    if (!this._activeResize) return;
    e.preventDefault();

    window.removeEventListener('pointermove', this._onResizeMove);
    this._activeResize = null;
  };

  _removeSplitters() {
    for (const s of this._splitters) s.remove();
    this._splitters.length = 0;
  }

  // -------------------- Z ordering --------------------

  _bringToFront(panel) {
    panel._z = (this._zCounter = (this._zCounter || this.options.zIndexBase) + 1);
    panel.el.style.zIndex = `${panel._z}`;
  }

  _restackZ() {
    // Docked zones at base, floating above.
    let z = this.options.zIndexBase;

    const docked = ['left', 'right', 'top', 'bottom', 'center'];
    for (const zone of docked) {
      for (const p of this._zones[zone]) {
        p._z = ++z;
        p.el.style.zIndex = `${p._z}`;
      }
    }

    for (const p of this._zones.floating) {
      p._z = ++z;
      p.el.style.zIndex = `${p._z}`;
    }

    this._zCounter = z;
  }

  // -------------------- Utilities --------------------

  _uid(prefix) {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  }

  _clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  _panelMinSize(panel) {
    const base = this.options.minPanelSize;
    const panelMin = Number.isFinite(panel.minSize) ? panel.minSize : base;
    return Math.max(0, panelMin);
  }

  _panelContentMinSize(panel) {
    const base = this.options.minPanelSize;
    const panelMin = Number.isFinite(panel.contentMinSize) ? panel.contentMinSize : base;
    return Math.max(0, panelMin);
  }

  _isPanelCollapsed(panel) {
    const section = panel?._accordionSection;
    const content = section?.uiElement;
    if (content?.classList?.contains?.('collapsed')) return true;
    if (Number.isFinite(panel?.contentMinSize) && Number.isFinite(panel?.minSize)) {
      return panel.minSize < panel.contentMinSize - 0.5;
    }
    return false;
  }

  _tailCollapsedStart(flags) {
    if (!Array.isArray(flags) || flags.length === 0) return -1;
    let tailStart = -1;
    for (let i = flags.length - 1; i >= 0; i--) {
      if (!flags[i]) break;
      tailStart = i;
    }
    return tailStart;
  }

  _applyCollapsedAnchorsVertical(panels, sizes, total, collapsedFlags) {
    if (!panels.length) return sizes;
    const next = sizes.slice();
    const anyExpanded = collapsedFlags.some((isCollapsed) => !isCollapsed);
    const collapsedSizes = panels.map((panel, i) => {
      if (!collapsedFlags[i]) return next[i];
      const collapsedSize = this._panelCollapsedSize(panel);
      panel.minSize = collapsedSize;
      return collapsedSize;
    });
    if (!anyExpanded) return collapsedSizes;

    let sum = collapsedSizes.reduce((a, b) => a + b, 0);
    const target = collapsedFlags.findIndex((isCollapsed) => !isCollapsed);
    if (target >= 0 && sum < total) {
      collapsedSizes[target] += (total - sum);
      sum = total;
    }
    return collapsedSizes;
  }

  _panelCollapsedSize(panel) {
    const fallback = this._panelMinSize(panel);
    if (typeof panel?._getCollapsedSize === 'function') {
      const v = panel._getCollapsedSize();
      if (Number.isFinite(v) && v > 0) return v;
    }
    return fallback;
  }

  _applyAutoCollapse(panels, sizes, total, zone) {
    if (zone === 'top' || zone === 'bottom') return sizes;
    let changed = false;
    const next = sizes.slice();
    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i];
      const section = panel?._accordionSection;
      if (!section || typeof panel._getCollapsedSize !== 'function') continue;
      if (panel.dock === 'floating') continue;
      const isCollapsed = section.uiElement?.classList?.contains?.('collapsed');
      if (isCollapsed) continue;
      const contentMin = this._panelContentMinSize(panel);
      if (next[i] > contentMin + 0.5) continue;
      const collapsedSize = panel._getCollapsedSize?.() ?? this._panelMinSize(panel);
      if (Number.isFinite(collapsedSize) && collapsedSize > 0) {
        if (!Number.isFinite(section._dockExpandedSize)) section._dockExpandedSize = next[i];
        panel.minSize = collapsedSize;
        next[i] = collapsedSize;
        if (typeof panel._setCollapsedState === 'function') {
          panel._setCollapsedState(true, { source: 'auto', skipLayout: true });
        } else {
          try { section.uiElement?.classList?.add?.('collapsed'); } catch { /* ignore */ }
        }
        if (typeof panel._syncToggle === 'function') panel._syncToggle();
        changed = true;
      }
    }
    if (!changed) return sizes;
    const mins = panels.map((panel) => this._panelMinSize(panel));
    return this._normalizeSizes(next, total, mins, zone);
  }

  _applySplitterDelta(panels, sizes, indexA, indexB, delta) {
    if (!Number.isFinite(delta) || delta === 0) return 0;
    if (delta > 0) {
      let remaining = delta;
      for (let j = indexB; j < panels.length; j++) {
        const min = this._panelMinSize(panels[j]);
        const can = sizes[j] - min;
        if (can <= 0) continue;
        const take = Math.min(can, remaining);
        sizes[j] -= take;
        remaining -= take;
        if (remaining <= 0) break;
      }
      const applied = delta - remaining;
      if (applied > 0) sizes[indexA] += applied;
      return applied;
    }

    let remaining = -delta;
    for (let j = indexA; j >= 0; j--) {
      const min = this._panelMinSize(panels[j]);
      const can = sizes[j] - min;
      if (can <= 0) continue;
      const take = Math.min(can, remaining);
      sizes[j] -= take;
      remaining -= take;
      if (remaining <= 0) break;
    }
    const applied = -((-delta) - remaining);
    if (applied < 0) sizes[indexB] += -applied;
    return applied;
  }

  _autoExpandCollapsedFromResize(panels, sizes) {
    let changed = false;
    for (let i = 0; i < panels.length; i++) {
      const panel = panels[i];
      if (!this._isPanelCollapsed(panel)) continue;
      const contentMin = this._panelContentMinSize(panel);
      if (!Number.isFinite(contentMin)) continue;
      if (sizes[i] <= contentMin + 0.5) continue;

      const section = panel?._accordionSection;
      if (section) section._dockExpandedSize = sizes[i];
      panel.minSize = contentMin;
      if (typeof panel._setCollapsedState === 'function') {
        panel._setCollapsedState(false, { source: 'resize', skipLayout: true });
      } else {
        try { section?.uiElement?.classList?.remove?.('collapsed'); } catch { /* ignore */ }
      }
      if (typeof panel._syncToggle === 'function') panel._syncToggle();
      panel.size = Math.max(contentMin, sizes[i]);
      sizes[i] = panel.size;
      changed = true;
    }
    return changed;
  }

  _ensureGlobalStyles() {
    if (document.getElementById('dl-styles')) return;

    // Lock page to viewport (no page taller than window)
    document.documentElement.style.height = '100%';
    document.body.style.height = '100%';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';

    const style = document.createElement('style');
    style.id = 'dl-styles';
    style.textContent = `
      .dl-overlay {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 999999;
      }

      .dl-guide {
        position: fixed;
        box-sizing: border-box;
        border: 2px solid rgba(30, 144, 255, 0.95);
        background: rgba(30, 144, 255, ${this.options.guideOpacity});
        border-radius: 10px;
        pointer-events: none;
      }

      .dl-panel {
        background: #0b0f14;
        color: #e6edf3;
        border: 1px solid rgba(120, 180, 255, 0.35);
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      }

      .dl-handle {
        height: ${this.options.handleSize}px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: grab;
        border-bottom: 1px solid rgba(120, 180, 255, 0.22);
        background: rgba(255,255,255,0.03);
        border-top-left-radius: 10px;
        border-top-right-radius: 10px;
        user-select: none;
        touch-action: none;
      }

      .dl-handle.dl-handle-has-title {
        height: auto;
        min-height: ${this.options.handleSize}px;
        padding: 0;
        display: block;
        align-items: stretch;
        gap: 0;
      }

      .dl-handle.dl-handle-has-title .dl-grip {
        display: none;
      }

      .dl-handle.dl-handle-has-title .dl-handle-title {
        cursor: default;
        width: 100%;
      }

      .dl-handle:active { cursor: grabbing; }

      .dl-grip {
        width: 56px;
        height: 6px;
        border-radius: 999px;
        background: rgba(120, 180, 255, 0.55);
        opacity: 0.75;
      }

      .dl-body {
        width: 100%;
        box-sizing: border-box;
      }

      .dl-resize {
        position: absolute;
        right: 6px;
        bottom: 6px;
        width: 14px;
        height: 14px;
        border-right: 2px solid rgba(120, 180, 255, 0.55);
        border-bottom: 2px solid rgba(120, 180, 255, 0.55);
        border-bottom-right-radius: 3px;
        cursor: se-resize;
        pointer-events: auto;
        opacity: 0.7;
        touch-action: none;
      }
      .dl-resize:hover { opacity: 1; }

      .dl-splitter {
        position: fixed;
        pointer-events: auto;
        background: rgba(120, 180, 255, 0.12);
      }
      .dl-zone-splitter {
        background: rgba(120, 180, 255, 0.22);
        box-shadow: inset 0 0 0 1px rgba(120, 180, 255, 0.35);
      }
      .dl-splitter-h { cursor: row-resize; }
      .dl-splitter-v { cursor: col-resize; }
      .dl-splitter:hover { background: rgba(120, 180, 255, 0.22); }
      .dl-zone-splitter:hover { background: rgba(120, 180, 255, 0.34); }
    `;

    document.head.appendChild(style);
  }
}

// Convenience: single function setup
export function makeDockable(el, layout, opts = {}) {
  if (!(layout instanceof DockableLayout)) throw new Error('makeDockable requires a DockableLayout instance');
  return layout.register(el, opts);
}
