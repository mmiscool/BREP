// AccordionWidget.rewritten.js
// ES6, framework-free, dark mode, no animations.
// All public methods are async and resolve AFTER the DOM has painted.

export class AccordionSection {
  /**
   * Represents a single accordion section.
   * Properties:
   *  - title {string}
   *  - callbackOpen {Function|null}
   *  - callbackClose {Function|null}
   *  - uiElement {HTMLElement}   // content container for this section
   */
  constructor({ title, titleElement, contentElement }) {
    this.title = title;
    this.callbackOpen = null;
    this.callbackClose = null;
    this.uiElement = contentElement || document.createElement("div");

    // Click toggles collapsed state and fires callbacks (not awaited to preserve original behavior)
    titleElement.addEventListener("click", () => {
      const wasCollapsed = this.uiElement.classList.contains("collapsed");
      this.uiElement.classList.toggle("collapsed");

      if (wasCollapsed) {
        if (typeof this.callbackOpen === "function") this.callbackOpen(this);
      } else {
        if (typeof this.callbackClose === "function") this.callbackClose(this);
      }
    });
  }

  /**
   * Collapse this section and resolve after paint.
   */
  async collapse() {
    this.uiElement.classList.add("collapsed");
    if (typeof this.callbackClose === "function") this.callbackClose(this);
    await _flushAfterPaint();
    return true;
  }

  /**
   * Expand this section and resolve after paint.
   */
  async expand() {
    this.uiElement.classList.remove("collapsed");
    if (typeof this.callbackOpen === "function") this.callbackOpen(this);
    await _flushAfterPaint();
    return true;
  }
}

export class AccordionWidget {
  constructor() {
    this.uiElement = document.createElement("div");
    this._ensureStyles();
    this.uiElement.classList.add("accordion");
  }

  _ensureStyles() {
    if (document.getElementById("accordion-widget-styles")) return;
    const style = document.createElement("style");
    style.id = "accordion-widget-styles";
    style.textContent = `
      .accordion {
        border: 1px solid #1f2937;
        border-radius: 8px;
        overflow: hidden;
        background: #0b0f13; /* dark */
        color: #e5e7eb;      /* light text */
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
        background: #0f172a;
      }
      .accordion-content {
        padding: 0px;
        background: #0b0f13;
      }
      .accordion-content.collapsed {
        display: none;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Add a new section, expand it, and return the AccordionSection.
   * @param {string} title
   * @returns {Promise<AccordionSection>}
   */
  async addSection(title) {
    // Title element
    const titleElement = document.createElement("div");
    titleElement.classList.add("accordion-title");
    titleElement.textContent = title;
    titleElement.name = `accordion-title-${title}`;
    this.uiElement.appendChild(titleElement);

    // Content element
    const contentElement = document.createElement("div");
    contentElement.classList.add("accordion-content");
    contentElement.name = `accordion-content-${title}`;
    contentElement.id = `accordion-content-${title}`;
    this.uiElement.appendChild(contentElement);

    const section = new AccordionSection({
      title,
      titleElement,
      contentElement,
    });

    // Ensure the new nodes are in the DOM
    await _flushAfterPaint();

    // Expand the new section (matches original behavior)
    await this.expandSection(title);

    return section;
  }

  /**
   * Remove a section by title (returns true if removed).
   * @param {string} title
   */
  async removeSection(title) {
    const titleEl = this.uiElement.querySelector(
      `.accordion-title[name="accordion-title-${title}"]`
    );
    const contentEl = this.uiElement.querySelector(
      `.accordion-content[name="accordion-content-${title}"]`
    );

    let changed = false;
    if (titleEl) {
      this.uiElement.removeChild(titleEl);
      changed = true;
    }
    if (contentEl) {
      this.uiElement.removeChild(contentEl);
      changed = true;
    }

    if (changed) {
      await _flushAfterPaint();
      return true;
    }
    return false;
  }

  /**
   * Clear all sections.
   */
  async clear() {
    this.uiElement.innerHTML = "";
    await _flushAfterPaint();
    return true;
  }

  /**
   * Collapse all sections (does not invoke per-section callbacks, preserving original behavior).
   */
  async collapseAll() {
    const els = this.uiElement.querySelectorAll(".accordion-content");
    els.forEach((el) => el.classList.add("collapsed"));
    await _flushAfterPaint();
    return true;
  }

  /**
   * Expand all sections (does not invoke per-section callbacks, preserving original behavior).
   */
  async expandAll() {
    const els = this.uiElement.querySelectorAll(".accordion-content");
    await els.forEach(async(el) => await el.classList.remove("collapsed"));
    await _flushAfterPaint();
    return true;
  }

  /**
   * Expand a specific section by title. Returns true if found & expanded.
   * @param {string} title
   */
  async expandSection(title) {
    const contentEl = document.getElementById(`accordion-content-${title}`);
    if (!contentEl) return false;
    await contentEl.classList.remove("collapsed");
    await _flushAfterPaint();
    return true;
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
