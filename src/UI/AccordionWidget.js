// AccordionWidget.rewritten.js
// ES6, framework-free, dark mode, no animations.
// All public methods are async and resolve AFTER the DOM has painted.

export class AccordionSection {
  /**
   * Represents a single accordion section.
   * Properties:
   *  - title {string}
   *  - titleElement {HTMLElement}
   *  - callbackOpen {Function|null}
   *  - callbackClose {Function|null}
   *  - uiElement {HTMLElement}   // content container for this section
   */
  constructor({ title, titleElement, contentElement, onExpand, onCollapse, toggleButton }) {
    this.title = title;
    this.titleElement = titleElement;
    this.callbackOpen = null;
    this.callbackClose = null;
    this.uiElement = contentElement || document.createElement("div");
    this.contentElement = this.uiElement;
    this.onExpand = typeof onExpand === "function" ? onExpand : null;
    this.onCollapse = typeof onCollapse === "function" ? onCollapse : null;
    this.toggleButton = toggleButton || null;
    this._autoCollapsed = false;

    if (this.toggleButton) {
      this.toggleButton.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      this.toggleButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this._applyCollapsedState(!this.uiElement.classList.contains("collapsed"), { source: "manual" });
      });
    } else {
      // Click toggles collapsed state and fires callbacks (not awaited to preserve original behavior)
      titleElement.addEventListener("click", () => {
        this._applyCollapsedState(!this.uiElement.classList.contains("collapsed"), { source: "manual" });
      });
    }

    this._syncToggleButton();
  }

  /**
   * Collapse this section and resolve after paint.
   */
  async collapse() {
    this._applyCollapsedState(true, { source: "api" });
    await _flushAfterPaint();
    return true;
  }

  /**
   * Expand this section and resolve after paint.
   */
  async expand() {
    this._applyCollapsedState(false, { source: "api" });
    await _flushAfterPaint();
    return true;
  }

  _applyCollapsedState(collapsed, { source = "manual", skipLayout = false } = {}) {
    const wasCollapsed = this.uiElement.classList.contains("collapsed");
    if (collapsed === wasCollapsed) {
      if (source !== "auto") this._autoCollapsed = false;
      return false;
    }
    if (source !== "auto") this._autoCollapsed = false;
    if (source === "auto" && collapsed) this._autoCollapsed = true;

    if (collapsed) this.uiElement.classList.add("collapsed");
    else this.uiElement.classList.remove("collapsed");
    this._syncToggleButton();

    if (collapsed) {
      if (typeof this.callbackClose === "function") this.callbackClose(this);
      if (typeof this.onCollapse === "function") this.onCollapse(this, { source, skipLayout });
    } else {
      if (typeof this.callbackOpen === "function") this.callbackOpen(this);
      if (typeof this.onExpand === "function") this.onExpand(this, { source, skipLayout });
    }
    return true;
  }

  _syncToggleButton() {
    if (!this.toggleButton) return;
    const collapsed = this.uiElement.classList.contains("collapsed");
    this.toggleButton.classList.toggle("is-collapsed", collapsed);
    this.toggleButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const label = collapsed ? "Expand" : "Collapse";
    this.toggleButton.setAttribute("aria-label", label);
    this.toggleButton.setAttribute("title", label);
  }
}

export class AccordionWidget {
  constructor(options = {}) {
    this.uiElement = document.createElement("div");
    this._ensureStyles();
    this.uiElement.classList.add("accordion");
    this._dockLayout = options.dockLayout || null;
    this._dockZone = options.dock || "left";
    this._dockCollapsePadding = Number.isFinite(options.collapsePadding) ? options.collapsePadding : 0;
    this._sectionOrderCounter = 0;
    this._sectionByContent = new WeakMap();
    if (this._dockLayout) this.uiElement.classList.add("accordion-dockable");
  }

  _ensureStyles() {
    if (document.getElementById("accordion-widget-styles")) return;
    const style = document.createElement("style");
    style.id = "accordion-widget-styles";
    style.textContent = `
      .accordion {
        border: 1px solid #1f2937;
        border-radius: 8px;
        overflow: scfroll;
        background: #0b0f13; /* dark */
        color: #e5e7eb;      /* light text */
      }
      .accordion.accordion-dockable {
        border: none;
        border-radius: 0;
        overflow: visible;
        background: transparent;
      }
      .accordion.accordion-dockable .accordion-title {
        display: flex;
        align-items: center;
        gap: 8px;
        background: transparent;
        border-bottom: none;
        padding: 6px 10px;
        cursor: grab;
      }
      .accordion.accordion-dockable .accordion-title:hover {
        background: rgba(255,255,255,0.04);
      }
      .accordion.accordion-dockable .accordion-title-text {
        flex: 1 1 auto;
        min-width: 0;
        cursor: inherit;
      }
      .accordion.accordion-dockable .accordion-toggle {
        width: 22px;
        height: 22px;
        border-radius: 6px;
        border: 1px solid #1f2937;
        background: rgba(17,24,39,0.75);
        color: #e5e7eb;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        line-height: 1;
      }
      .accordion.accordion-dockable .accordion-toggle::before {
        content: "-";
        font-weight: 700;
      }
      .accordion.accordion-dockable .accordion-toggle.is-collapsed::before {
        content: "+";
      }
      .accordion-title {
        padding: 8px 10px;
        cursor: pointer;
        border-bottom: 1px solid #1f2937;
        font-weight: 700;
        user-select: none;
        background: #111827;
        user-select: none;
      }
      .accordion-title:hover {
        background: #203955ff;
      }
      .accordion-content {
        padding: 0px;
        background: #0b0f13;
      }
      .accordion-content.collapsed {
        display: none;
      }
      .accordion-section {
        width: 100%;
        height: 100%;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Add a new section, expand it, and return the AccordionSection.
   * @param {string} title
   * @param {{dock?: string, size?: number, order?: number}} [opts]
   * @returns {Promise<AccordionSection>}
   */
  async addSection(title, opts = {}) {
    // Title element
    const titleElement = document.createElement("div");
    titleElement.classList.add("accordion-title");
    titleElement.name = `accordion-title-${title}`;
    let titleTextEl = null;
    let toggleButton = null;
    if (this._dockLayout) {
      titleElement.classList.add("dl-handle-title");
      titleTextEl = document.createElement("span");
      titleTextEl.classList.add("accordion-title-text", "dl-drag-title");
      titleTextEl.textContent = title;
      titleElement.appendChild(titleTextEl);
      toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.classList.add("accordion-toggle");
      toggleButton.setAttribute("aria-label", "Collapse");
      toggleButton.setAttribute("title", "Collapse");
      titleElement.appendChild(toggleButton);
    } else {
      titleElement.textContent = title;
    }
    if (this._dockLayout) titleElement.classList.add("dl-handle-title");

    // Content element
    const contentElement = document.createElement("div");
    contentElement.classList.add("accordion-content");
    contentElement.name = `accordion-content-${title}`;
    contentElement.id = `accordion-content-${title}`;
    let sectionContainer = null;
    if (this._dockLayout) {
      sectionContainer = document.createElement("div");
      sectionContainer.classList.add("accordion-section");
      sectionContainer.appendChild(titleElement);
      sectionContainer.appendChild(contentElement);
      this.uiElement.appendChild(sectionContainer);
    } else {
      this.uiElement.appendChild(titleElement);
      this.uiElement.appendChild(contentElement);
    }

    const section = new AccordionSection({
      title,
      titleElement,
      contentElement,
      toggleButton,
    });
    section.titleElement = titleElement;
    section.contentElement = contentElement;
    section.titleTextElement = titleTextEl;
    section.containerElement = sectionContainer;
    this._sectionByContent.set(contentElement, section);

    if (this._dockLayout && sectionContainer) {
      const dockOpts = {
        dock: opts.dock || this._dockZone,
        order: Number.isFinite(opts.order) ? opts.order : this._sectionOrderCounter++,
      };
      if (Number.isFinite(opts.size)) dockOpts.size = opts.size;
      section._dockPanel = this._dockLayout.register(sectionContainer, dockOpts);
      if (Number.isFinite(section._dockPanel.minSize)) {
        section._dockPanel.contentMinSize = section._dockPanel.minSize;
      }
      section._dockPanel._accordionSection = section;
      section._dockPanel._getCollapsedSize = () => this._getDockCollapsedSize(section);
      section._dockPanel._setCollapsedState = (collapsed, opts = {}) => {
        section._applyCollapsedState(!!collapsed, opts);
      };
      section._dockPanel._syncToggle = () => section._syncToggleButton();
      section.onExpand = (_section, opts = {}) => this._setDockCollapsed(section, false, opts);
      section.onCollapse = (_section, opts = {}) => this._setDockCollapsed(section, true, opts);
    }

    // Ensure the new nodes are in the DOM
    await _flushAfterPaint();

    // Expand the new section (matches original behavior)
    await this.expandSection(title);

    return section;
  }

  /**
   * Remove a section by title (returns true if removed).
   * @param {string|AccordionSection|HTMLElement} target
   */
  async removeSection(target) {
    const { titleEl, contentEl, containerEl } = this._resolveSectionNodes(target);
    let changed = false;

    if (containerEl) {
      if (this._dockLayout && typeof this._dockLayout.unregister === "function") {
        try { this._dockLayout.unregister(containerEl); } catch { /* ignore */ }
      }
      if (containerEl.parentNode) containerEl.parentNode.removeChild(containerEl);
      changed = true;
    } else {
      if (titleEl && titleEl.parentNode) {
        titleEl.parentNode.removeChild(titleEl);
        changed = true;
      }
      if (contentEl && contentEl.parentNode) {
        contentEl.parentNode.removeChild(contentEl);
        changed = true;
      }
    }

    if (contentEl) this._sectionByContent?.delete?.(contentEl);

    if (changed) {
      await _flushAfterPaint();
      if (this._dockLayout) this._dockLayout.layout();
      return true;
    }
    return false;
  }

  /**
   * Clear all sections.
   */
  async clear() {
    if (this._dockLayout && typeof this._dockLayout.unregister === "function") {
      const sections = Array.from(this.uiElement.querySelectorAll(".accordion-section"));
      sections.forEach((section) => {
        try { this._dockLayout.unregister(section); } catch { /* ignore */ }
      });
    }
    this.uiElement.innerHTML = "";
    this._sectionByContent = new WeakMap();
    await _flushAfterPaint();
    if (this._dockLayout) this._dockLayout.layout();
    return true;
  }

  /**
   * Collapse all sections (does not invoke per-section callbacks, preserving original behavior).
   */
  async collapseAll() {
    const els = Array.from(this.uiElement.querySelectorAll(".accordion-content"));
    els.forEach((el) => el.classList.add("collapsed"));
    if (this._dockLayout) {
      els.forEach((el) => {
        const section = this._sectionByContent.get(el);
        if (section) {
          section._syncToggleButton?.();
          this._setDockCollapsed(section, true, { skipLayout: true });
        }
      });
      this._dockLayout.layout();
    } else {
      els.forEach((el) => this._sectionByContent.get(el)?._syncToggleButton?.());
    }
    await _flushAfterPaint();
    return true;
  }

  /**
   * Expand all sections (does not invoke per-section callbacks, preserving original behavior).
   */
  async expandAll() {
    const els = Array.from(this.uiElement.querySelectorAll(".accordion-content"));
    els.forEach((el) => el.classList.remove("collapsed"));
    if (this._dockLayout) {
      els.forEach((el) => {
        const section = this._sectionByContent.get(el);
        if (section) {
          section._syncToggleButton?.();
          this._setDockCollapsed(section, false, { skipLayout: true });
        }
      });
      this._dockLayout.layout();
    } else {
      els.forEach((el) => this._sectionByContent.get(el)?._syncToggleButton?.());
    }
    await _flushAfterPaint();
    return true;
  }

  /**
   * Expand a specific section by title. Returns true if found & expanded.
   * @param {string} title
   */
  async expandSection(title) {
    const titleEl = this._findTitleEl(title);
    const contentEl = this._findContentEl(title, titleEl) || document.getElementById(`accordion-content-${title}`);
    if (!contentEl) return false;
    contentEl.classList.remove("collapsed");
    const section = this._sectionByContent.get(contentEl);
    if (section) section._syncToggleButton?.();
    if (this._dockLayout && section) {
      this._setDockCollapsed(section, false, { skipLayout: true });
      this._dockLayout.layout();
    }
    await _flushAfterPaint();
    return true;
  }

  /**
   * Hide a section (title + content) by title.
   * @param {string} title
   * @returns {boolean} true if found
   */
  hideSection(title) {
    const titleEl = this._findTitleEl(title);
    const contentEl = this._findContentEl(title, titleEl);
    const containerEl = this._getSectionContainer(titleEl, contentEl);
    let changed = false;
    if (containerEl) {
      containerEl.style.display = 'none';
      containerEl.hidden = true;
      containerEl.setAttribute('aria-hidden', 'true');
      changed = true;
    }
    if (titleEl) {
      titleEl.style.display = 'none';
      titleEl.hidden = true;
      titleEl.setAttribute('aria-hidden', 'true');
      changed = true;
    }
    if (contentEl) {
      contentEl.style.display = 'none';
      contentEl.hidden = true;
      contentEl.setAttribute('aria-hidden', 'true');
      contentEl.classList.add('collapsed');
      changed = true;
    }
    const section = contentEl ? this._sectionByContent.get(contentEl) : null;
    if (section) section._syncToggleButton?.();
    if (changed && this._dockLayout) this._dockLayout.layout();
    return changed;
  }

  /**
   * Show a section (title + content) by title.
   * @param {string} title
   * @returns {boolean} true if found
   */
  showSection(title) {
    const titleEl = this._findTitleEl(title);
    const contentEl = this._findContentEl(title, titleEl);
    const containerEl = this._getSectionContainer(titleEl, contentEl);
    let changed = false;
    if (containerEl) {
      containerEl.style.display = '';
      containerEl.hidden = false;
      containerEl.setAttribute('aria-hidden', 'false');
      changed = true;
    }
    if (titleEl) {
      titleEl.style.display = '';
      titleEl.hidden = false;
      titleEl.setAttribute('aria-hidden', 'false');
      changed = true;
    }
    if (contentEl) {
      contentEl.style.display = '';
      contentEl.hidden = false;
      contentEl.setAttribute('aria-hidden', 'false');
      contentEl.classList.remove('collapsed');
      changed = true;
    }
    const section = contentEl ? this._sectionByContent.get(contentEl) : null;
    if (section) section._syncToggleButton?.();
    if (changed && this._dockLayout) this._dockLayout.layout();
    return changed;
  }

  moveSectionBefore(sectionRef, beforeRef) {
    const section = this._resolveSectionNodes(sectionRef);
    const before = this._resolveSectionNodes(beforeRef);
    const parent = this.uiElement;
    const beforeNode = before?.containerEl || before?.titleEl;
    if (!section || (!section.containerEl && !section.titleEl && !section.contentEl)) return false;
    if (!beforeNode || beforeNode.parentNode !== parent) return false;

    if (section.containerEl) {
      parent.insertBefore(section.containerEl, beforeNode);
    } else {
      const frag = document.createDocumentFragment();
      if (section.titleEl) frag.appendChild(section.titleEl);
      if (section.contentEl) frag.appendChild(section.contentEl);
      parent.insertBefore(frag, beforeNode);
    }

    this._syncDockOrder();
    return true;
  }

  prependSections(sectionRefs = []) {
    const parent = this.uiElement;
    const fragment = document.createDocumentFragment();
    let hasAny = false;
    for (const ref of sectionRefs) {
      const section = this._resolveSectionNodes(ref);
      if (!section) continue;
      if (section.containerEl) {
        fragment.appendChild(section.containerEl);
        hasAny = true;
      } else if (section.titleEl || section.contentEl) {
        if (section.titleEl) fragment.appendChild(section.titleEl);
        if (section.contentEl) fragment.appendChild(section.contentEl);
        hasAny = true;
      }
    }
    if (!hasAny) return false;
    parent.insertBefore(fragment, parent.firstChild || null);
    this._syncDockOrder();
    return true;
  }

  _resolveSectionNodes(target) {
    let titleEl = null;
    let contentEl = null;
    let containerEl = null;

    if (typeof target === "string") {
      titleEl = this._findTitleEl(target);
      contentEl = this._findContentEl(target, titleEl);
    } else if (target instanceof HTMLElement) {
      if (target.classList.contains("accordion-section")) {
        containerEl = target;
        titleEl = containerEl.querySelector(".accordion-title");
        contentEl = containerEl.querySelector(".accordion-content");
      } else if (target.classList.contains("accordion-title")) {
        titleEl = target;
      } else if (target.classList.contains("accordion-content")) {
        contentEl = target;
      }
    } else if (target && target.uiElement instanceof HTMLElement) {
      contentEl = target.uiElement;
      titleEl = target.titleElement || contentEl.previousElementSibling;
    }

    if (!titleEl && contentEl) {
      const prev = contentEl.previousElementSibling;
      if (prev && prev.classList.contains("accordion-title")) titleEl = prev;
    }
    if (!contentEl && titleEl) {
      const next = titleEl.nextElementSibling;
      if (next && next.classList.contains("accordion-content")) contentEl = next;
    }

    if (!containerEl) {
      containerEl = this._getSectionContainer(titleEl, contentEl);
      if (containerEl && !titleEl) titleEl = containerEl.querySelector(".accordion-title");
      if (containerEl && !contentEl) contentEl = containerEl.querySelector(".accordion-content");
    }

    return { titleEl, contentEl, containerEl };
  }

  _getSectionContainer(titleEl, contentEl) {
    if (!this._dockLayout) return null;
    return titleEl?.closest?.(".accordion-section") || contentEl?.closest?.(".accordion-section") || null;
  }

  _setDockCollapsed(section, collapsed, { skipLayout = false } = {}) {
    if (!this._dockLayout || !section || !section._dockPanel) return;
    const panel = section._dockPanel;
    if (panel.dock === "floating" || panel.dock === "top" || panel.dock === "bottom") return;

    if (collapsed) {
      if (!Number.isFinite(section._dockExpandedSize)) section._dockExpandedSize = panel.size;
      const collapsedSize = this._getDockCollapsedSize(section);
      if (!Number.isFinite(panel.contentMinSize)) panel.contentMinSize = panel.minSize;
      panel.minSize = collapsedSize;
      panel.size = collapsedSize;
    } else if (Number.isFinite(section._dockExpandedSize)) {
      const minSize = Number.isFinite(panel.contentMinSize) ? panel.contentMinSize : (this._dockLayout?.options?.minPanelSize || 0);
      let target = section._dockExpandedSize;
      if (!Number.isFinite(target) || target <= minSize) target = minSize + 1;
      panel.size = Math.max(minSize, target);
      section._dockExpandedSize = null;
      panel.minSize = minSize;
    }

    if (!skipLayout) this._dockLayout.layout();
  }

  _getDockCollapsedSize(section) {
    const handleEl = section?.containerElement?.querySelector?.(":scope > .dl-handle");
    const handleHeight = handleEl?.getBoundingClientRect?.().height || this._dockLayout?.options?.handleSize || 0;
    const raw = Math.ceil(handleHeight + this._dockCollapsePadding);
    if (!Number.isFinite(raw) || raw <= 0) return Math.ceil(this._dockLayout?.options?.handleSize || 24);
    return raw;
  }

  _syncDockOrder() {
    if (!this._dockLayout || !this._dockLayout._panels || !this._dockLayout._zones) return;
    const sections = Array.from(this.uiElement.querySelectorAll(".accordion-section"));
    let order = 0;
    sections.forEach((section) => {
      const panel = this._dockLayout._panels.get(section);
      if (!panel || panel.dock !== this._dockZone) return;
      panel.order = order++;
    });
    const zone = this._dockLayout._zones[this._dockZone];
    if (Array.isArray(zone)) zone.sort((a, b) => a.order - b.order);
    this._dockLayout.layout();
  }

  _findTitleEl(title) {
    const direct = this.uiElement.querySelector(`.accordion-title[name="accordion-title-${title}"]`);
    if (direct) return direct;
    const titles = Array.from(this.uiElement.querySelectorAll('.accordion-title'));
    const norm = String(title || '').trim().toUpperCase();
    return titles.find((el) => {
      const text = (el.textContent || '').trim().toUpperCase();
      return text === norm || text.startsWith(norm) || norm.startsWith(text);
    }) || null;
  }

  _findContentEl(title, titleEl = null) {
    const direct = this.uiElement.querySelector(`.accordion-content[name="accordion-content-${title}"]`);
    if (direct) return direct;
    if (titleEl && titleEl.nextElementSibling && titleEl.nextElementSibling.classList.contains('accordion-content')) {
      return titleEl.nextElementSibling;
    }
    // Fallback: find content by id match start
    const contents = Array.from(this.uiElement.querySelectorAll('.accordion-content'));
    const norm = String(title || '').trim().toUpperCase();
    return contents.find((el) => {
      const id = (el.id || '').trim().toUpperCase();
      const name = (el.getAttribute('name') || '').trim().toUpperCase();
      return id.includes(norm) || name.includes(norm);
    }) || null;
  }
}

/* -------------------------------------------------------
   Internal: resolve AFTER the browser has had a chance to
   apply style changes and paint. Two rAFs are used because:
   - rAF #1: runs before layout/paint of the next frame
   - rAF #2: ensures the paint has occurred
-------------------------------------------------------- */
function _nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function _flushAfterPaint() {
  await _nextFrame();
  await _nextFrame();
}
