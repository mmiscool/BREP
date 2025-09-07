// HistoryWidget.js
// ES6, framework-free, dark-mode. No external deps.
// Incremental sync with the viewer's feature history:
// - Only adds/removes/reorders accordion items when the features array changes.
// - Does NOT rebuild existing forms. It refreshes field values in-place when params change.
// - Each feature is its own accordion section.

"use strict";

import { SelectionFilter } from './SelectionFilter.js';

export class HistoryWidget {
    /**
     * @param {Object} viewer - expects viewer.partHistory with:
     *   - features: Array<{ type, inputParams: { featureID, ... } }>
     *   - featureRegistry: Map-like with .get(type).inputParamsSchema and .features[]
     *   - currentHistoryStepId: string (optional)
     *   - runHistory(): function (optional; we will patch to trigger sync)
     */
    constructor(viewer) {
        this.viewer = viewer;

        // Root and shadow
        this.uiElement = document.createElement("div");
        this._shadow = this.uiElement.attachShadow({ mode: "open" });

        // Styles + container
        this._shadow.appendChild(this._makeStyle());
        this._container = document.createElement("div");
        this._container.className = "history-widget";
        this._shadow.appendChild(this._container);

        // Accordion list container
        this._accordion = document.createElement("div");
        this._accordion.className = "accordion";
        this._container.appendChild(this._accordion);

        // Footer (add feature)
        this._footer = this._buildAddFeatureFooter();
        this._container.appendChild(this._footer);

        // Internal bookkeeping
        this._sections = new Map(); // id -> { root, headerBtn, titleText, content, ui, isOpen, paramsSig, type }
        this._idsSignature = "";    // joined list of IDs to detect add/remove/order changes
        this._syncScheduled = false;
        this._rafHandle = null;

        // global click (to close menu)
        this._onGlobalClick = (ev) => {
            // Close the add menu if clicking outside footer/menu
            const path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
            if (!path.includes(this._footer)) this._toggleAddMenu(false);
        };
        document.addEventListener("mousedown", this._onGlobalClick, true);

        // wire & watch
        this._wireViewerSignals();
        this._beginAutoSyncLoop();
    }

    /**
     * Clear all sections and internal state.
     */
    async reset() {
        for (const [, entry] of this._sections) {
            this._destroyEntry(entry);
        }
        this._sections.clear();
        this._accordion.textContent = "";
        this._testidsSignature = "";
        return true;
    }

    /**
     * Manual one-shot sync. Prefer scheduleSync() unless you must block on it.
     */
    async syncNow() {
        const ph = this._getPartHistory();
        const features = this._safeFeatures(ph);
        const idToFeature = new Map();
        const newIds = [];

        for (let i = 0; i < features.length; i++) {
            const f = features[i] || {};
            const id = f && f.inputParams ? f.inputParams.featureID : null;
            if (!id) continue;
            const sid = String(id);
            newIds.push(sid);
            idToFeature.set(sid, f);
        }

        const newSig = newIds.join("|");
        const oldIds = Array.from(this._sections.keys());
        const oldSig = this._idsSignature;

        if (newSig !== oldSig) {
            // Determine diffs
            const toRemove = [];
            for (let i = 0; i < oldIds.length; i++) {
                const id = oldIds[i];
                if (!idToFeature.has(id)) toRemove.push(id);
            }

            const toAdd = [];
            for (let i = 0; i < newIds.length; i++) {
                const id = newIds[i];
                if (!this._sections.has(id)) toAdd.push(id);
            }

            // Remove sections that no longer exist
            for (let i = 0; i < toRemove.length; i++) {
                const id = toRemove[i];
                await this._removeSection(id);
            }

            // Add new sections in order
            for (let i = 0; i < toAdd.length; i++) {
                const id = toAdd[i];
                const feature = idToFeature.get(id);
                if (feature) {
                    await this._addSectionForFeature(id, feature);
                }
            }

            // Reorder existing DOM to match newIds
            this._reorderSections(newIds);

            // Update signature AFTER DOM ops
            this._idsSignature = newSig;
        }

        // Even if IDs didn't change, params/type may have changed. Refresh in place.
        this._refreshExistingSections(idToFeature);

        // Ensure the current feature (if any) is expanded
        await this._ensureCurrentExpanded(ph);

        return true;
    }

    /**
     * Debounced incremental sync.
     */
    scheduleSync() {
        if (this._syncScheduled) return;
        this._syncScheduled = true;
        const doSync = async () => {
            this._syncScheduled = false;
            try {
                await this.syncNow();
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn("[HistoryWidget] sync failed:", err);
            }
        };
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => {
                if (typeof queueMicrotask === "function") queueMicrotask(doSync);
                else Promise.resolve().then(doSync);
            });
        } else {
            setTimeout(doSync, 0);
        }
    }

    /**
     * Legacy API shim for callers that expected a full rebuild.
     * Now performs incremental sync and expands current step.
     */
    async renderHistory() {
        await this.syncNow();
        return true;
    }

    /**
     * Programmatically expand a section by feature id.
     */
    expandSection(id) {
        const entry = this._sections.get(String(id));
        if (!entry) return;
        this._setItemOpen(entry, true, /*exclusive*/ true);
    }

    /**
     * Programmatically collapse a section by feature id.
     */
    collapseSection(id) {
        const entry = this._sections.get(String(id));
        if (!entry) return;
        this._setItemOpen(entry, false, /*exclusive*/ false);
    }

    /**
     * Stop the internal watcher (optional; call if you dispose the widget).
     */
    dispose() {
        if (this._rafHandle != null) {
            if (typeof cancelAnimationFrame === "function") {
                cancelAnimationFrame(this._rafHandle);
            } else {
                clearTimeout(this._rafHandle);
            }
            this._rafHandle = null;
        }
        if (this._onGlobalClick) {
            document.removeEventListener("mousedown", this._onGlobalClick, true);
            this._onGlobalClick = null;
        }
    }

    // ------------------------ internals ------------------------

    _getPartHistory() {
        const v = this.viewer;
        return v && v.partHistory ? v.partHistory : null;
    }

    _safeFeatures(ph) {
        if (!ph) return [];
        const arr = ph.features;
        return Array.isArray(arr) ? arr : [];
    }

    async _addSectionForFeature(id, feature) {
        const ph = this._getPartHistory();
        const fr = ph && ph.featureRegistry ? ph.featureRegistry : null;
        const def = fr && typeof fr.get === "function" ? fr.get(feature.type) : null;
        const schema = def && def.inputParamsSchema ? def.inputParamsSchema : {};

        // DOM: item
        const item = document.createElement("div");
        item.className = "acc-item";
        item.dataset.featureId = String(id);

        // DOM: header row (left: toggle button, right: actions)
        const headerRow = document.createElement("div");
        headerRow.className = "acc-header-row";

        // DOM: header button (toggle)
        const headerBtn = document.createElement("button");
        headerBtn.type = "button";
        headerBtn.className = "acc-header";
        headerBtn.setAttribute("aria-expanded", "false");
        headerBtn.setAttribute("aria-controls", `acc_${id}`);
        headerBtn.addEventListener("click", () => {
            const entry = this._sections.get(String(id));
            if (!entry) return;
            const openNext = !entry.isOpen;
            this._setItemOpen(entry, openNext, /*exclusive*/ true);
            // update currentHistoryStepId when user opens a panel
            const ph2 = this._getPartHistory();
            if (openNext && ph2) {
                ph2.currentHistoryStepId = String(id);
                // execute the feature history
                ph2.runHistory();
            }
        });

        // title text
        const titleText = document.createElement("span");
        titleText.className = "acc-title";
        titleText.textContent = this._composeTitle(feature, id);
        headerBtn.appendChild(titleText);

        // Actions (delete)
        const actions = document.createElement("div");
        actions.className = "acc-actions";

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "icon-btn danger";
        delBtn.setAttribute("aria-label", "Delete feature");
        delBtn.textContent = "✕";
        delBtn.title = "Delete feature";
        delBtn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            await this._handleDeleteFeature(String(id));
        });

        actions.appendChild(delBtn);

        headerRow.appendChild(headerBtn);
        headerRow.appendChild(actions);

        // DOM: content
        const content = document.createElement("div");
        content.className = "acc-content";
        content.id = `acc_${id}`;
        content.hidden = true;

        const body = document.createElement("div");
        body.className = "acc-body";
        content.appendChild(body);

        // Build UI for params
        const ui = new genFeatureUI(schema, feature.inputParams, {
            onChange: (featureID) => {
                const ph2 = this._getPartHistory();
                if (!ph2) return;
                ph2.currentHistoryStepId = featureID;
                if (ph2.runHistory && typeof ph2.runHistory === "function") {
                    try { ph2.runHistory(); } catch (_e) { }
                }
            },
            onAction: (featureID, actionKey) => {
                try {
                    const v = this.viewer;
                    if (!v) return;
                    if (actionKey === 'editSketch' && typeof v.startSketchMode === 'function') {
                        v.startSketchMode(featureID);
                    }
                } catch (_) { }
            },
            onReferenceChipRemove: (name) => {
                try {
                    const ph2 = this._getPartHistory();
                    const scene = ph2 && ph2.scene ? ph2.scene : null;
                    if (scene) {
                        SelectionFilter.deselectItem(scene, name);
                    }
                } catch (_) { }
            },
            scene: ph && ph.scene ? ph.scene : null
        });
        body.appendChild(ui.uiElement);

        // Mount
        item.appendChild(headerRow);
        item.appendChild(content);
        this._accordion.appendChild(item);

        // Track
        const entry = {
            id: String(id),
            root: item,
            headerBtn,
            titleText,
            content,
            ui,
            isOpen: false,
            paramsSig: this._computeParamsSig(feature.inputParams),
            type: feature.type
        };
        this._sections.set(String(id), entry);
    }

    async _removeSection(id) {
        const entry = this._sections.get(String(id));
        if (!entry) return;
        this._destroyEntry(entry);
        this._sections.delete(String(id));
    }

    _destroyEntry(entry) {
        // Best-effort destroy hook if UI had one
        if (entry.ui && typeof entry.ui.destroy === "function") {
            try { entry.ui.destroy(); } catch (_e) { }
        }
        if (entry.root && entry.root.parentNode) {
            entry.root.parentNode.removeChild(entry.root);
        }
    }

    _reorderSections(targetIds) {
        // Append in target order; existing nodes are moved, not recreated.
        for (let i = 0; i < targetIds.length; i++) {
            const id = targetIds[i];
            const entry = this._sections.get(id);
            if (!entry || !entry.root) continue;
            this._accordion.appendChild(entry.root);
        }
    }

    _refreshExistingSections(idToFeature) {
        // For unchanged IDs, check if their params or type changed; if so, refresh UI/title.
        for (const [id, entry] of this._sections) {
            const f = idToFeature.get(id);
            if (!f) continue;

            // Type/title change
            if (entry.type !== f.type) {
                entry.type = f.type;
                entry.titleText.textContent = this._composeTitle(f, id);
            }

            // Params changed?
            const newSig = this._computeParamsSig(f.inputParams);
            if (newSig !== entry.paramsSig) {
                entry.paramsSig = newSig;
                // Update the genFeatureUI's params reference and refresh views
                entry.ui.params = f.inputParams;
                try { entry.ui.refreshFromParams(); } catch (_e) { }
            }
        }
    }

    _composeTitle(feature, id) {
        const kind = feature && feature.type ? String(feature.type) : "Feature";
        return `${kind}  —  #${id}`;
    }

    async _ensureCurrentExpanded(ph) {
        if (!ph) return;
        const current = ph.currentHistoryStepId;
        if (!current) return;
        const entry = this._sections.get(String(current));
        if (!entry) return;
        this._setItemOpen(entry, true, /*exclusive*/ true);
    }

    _setItemOpen(entry, open, exclusive) {
        if (!entry) return;
        const wasOpen = Boolean(entry.isOpen);
        entry.isOpen = Boolean(open);
        entry.headerBtn.setAttribute("aria-expanded", entry.isOpen ? "true" : "false");
        entry.root.classList.toggle("open", entry.isOpen);
        entry.content.hidden = !entry.isOpen;

        if (exclusive && entry.isOpen) {
            // Close others
            for (const [, e] of this._sections) {
                if (e === entry) continue;
                if (e.isOpen) {
                    e.isOpen = false;
                    e.headerBtn.setAttribute("aria-expanded", "false");
                    e.root.classList.remove("open");
                    e.content.hidden = true;
                }
            }

            // Ensure a reference selection input activates only on transition closed->open
            if (!wasOpen) {
                try { entry.ui && typeof entry.ui.activateFirstReferenceSelection === 'function' && entry.ui.activateFirstReferenceSelection(); } catch (_) { }
            }
        }
    }

    _computeIdsSignature() {
        const ph = this._getPartHistory();
        const features = this._safeFeatures(ph);
        const ids = [];
        for (let i = 0; i < features.length; i++) {
            const f = features[i] || {};
            const id = f && f.inputParams ? f.inputParams.featureID : null;
            if (id) ids.push(String(id));
        }
        return ids.join("|");
    }

    _computeParamsSig(params) {
        if (!params || typeof params !== "object") return "";
        // Build a cheap, stable signature; ignore functions and nested objects.
        const keys = Object.keys(params).filter(k => k !== "featureID").sort();
        const parts = [];
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const v = params[k];
            if (v == null) {
                parts.push(`${k}:null`);
            } else if (typeof v === "object" || typeof v === "function") {
                // Skip deep structures to keep this light.
                parts.push(`${k}:[obj]`);
            } else {
                parts.push(`${k}:${String(v)}`);
            }
        }
        return parts.join("|");
    }

    _beginAutoSyncLoop() {
        // rAF-based watcher:
        // - If the list of IDs changes → scheduleSync (add/remove/reorder).
        // - Else, still check for lightweight params/title diffs and refresh in place.
        const tick = () => {
            const ph = this._getPartHistory();
            const sig = this._computeIdsSignature();
            if (sig !== this._idsSignature) {
                this.scheduleSync();
            } else {
                // Check params/title drift without rebuilding
                const features = this._safeFeatures(ph);
                const idToFeature = new Map();
                for (let i = 0; i < features.length; i++) {
                    const f = features[i] || {};
                    const id = f && f.inputParams ? f.inputParams.featureID : null;
                    if (!id) continue;
                    idToFeature.set(String(id), f);
                }
                this._refreshExistingSections(idToFeature);
                // Keep current expanded if viewer changed pointer
                this._ensureCurrentExpanded(ph);
            }
            this._rafHandle = typeof requestAnimationFrame === "function"
                ? requestAnimationFrame(tick)
                : setTimeout(tick, 33);
        };
        tick();
    }

    _wireViewerSignals() {
        const ph = this._getPartHistory();
        if (!ph) return;

        const listen = (target, method, eventName) => {
            try {
                if (target && typeof target[method] === "function") {
                    target[method](eventName, () => this.scheduleSync());
                }
            } catch (_e) { }
        };

        listen(ph, "addEventListener", "featuresChanged");
        listen(ph, "addEventListener", "historyChanged");
        listen(ph, "addEventListener", "runHistory:after");
        listen(ph, "addEventListener", "currentHistoryStepIdChanged");

        listen(ph, "on", "featuresChanged");
        listen(ph, "on", "historyChanged");
        listen(ph, "on", "runHistory:after");
        listen(ph, "on", "currentHistoryStepIdChanged");

        // Patch runHistory to trigger a sync after execution
        if (typeof ph.runHistory === "function" && !ph.__historyWidgetPatched) {
            const original = ph.runHistory.bind(ph);
            ph.runHistory = (...args) => {
                const res = original(...args);
                try { this.scheduleSync(); } catch (_e) { }
                return res;
            };
            ph.__historyWidgetPatched = true;
        }
    }

    // ------------------------ Add/Delete feature helpers ------------------------

    _listAvailableFeatures() {
        const ph = this._getPartHistory();
        const fr = ph && ph.featureRegistry ? ph.featureRegistry : null;
        const items = [];
        if (fr && Array.isArray(fr.features)) {
            for (const FC of fr.features) {
                if (!FC) continue;
                const label = String(FC.featureName || FC.featureShortName || FC.name || "Feature").trim();
                const value = String(FC.featureShortName || FC.featureName || FC.name || label).trim();
                items.push({ label, value });
            }
        }
        // Stable sort by label
        //items.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

        // don't change the order of the list. just populate the labels
        for (const item of items) {
            item.label = item.label || item.value || "Feature";
        }

        return items;
    }

    async _handleAddFeature(typeStr) {
        const ph = this._getPartHistory();
        if (!ph) return;
        try {
            const feature = await ph.newFeature(typeStr);
            // Focus new item & run
            ph.currentHistoryStepId = feature && feature.inputParams ? feature.inputParams.featureID : null;
            if (typeof ph.runHistory === "function") {
                await ph.runHistory();
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[HistoryWidget] add feature failed:", err);
        } finally {
            this._toggleAddMenu(false);
            this.scheduleSync();
        }
    }

    async _handleDeleteFeature(featureID) {
        const ph = this._getPartHistory();
        if (!ph) return;
        try {
            await ph.removeFeature(featureID);
            // If we deleted the "current" one, clear pointer
            if (ph.currentHistoryStepId === featureID) {
                ph.currentHistoryStepId = null;
            }
            if (typeof ph.runHistory === "function") {
                await ph.runHistory();
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[HistoryWidget] remove feature failed:", err);
        } finally {
            this.scheduleSync();
        }
    }

    _buildAddFeatureFooter() {
        const footer = document.createElement("div");
        footer.className = "footer";

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "add-btn";
        addBtn.setAttribute("aria-expanded", "false");
        addBtn.title = "Add feature";
        addBtn.textContent = "+";
        footer.appendChild(addBtn);

        // Menu
        const menu = document.createElement("div");
        menu.className = "add-menu";
        menu.setAttribute("role", "menu");
        menu.hidden = true;

        // Fill menu from registry
        const items = this._listAvailableFeatures();
        if (items.length === 0) {
            const empty = document.createElement("div");
            empty.className = "menu-empty";
            empty.textContent = "No features registered";
            menu.appendChild(empty);
        } else {

            for (const { label, value } of items) {
                const itemBtn = document.createElement("button");
                itemBtn.type = "button";
                itemBtn.className = "menu-item";
                itemBtn.setAttribute("role", "menuitem");
                itemBtn.textContent = label;
                itemBtn.dataset.type = value;
                itemBtn.addEventListener("click", async (ev) => {
                    ev.stopPropagation();
                    await this._handleAddFeature(value);
                });
                menu.appendChild(itemBtn);
            }
        }

        footer.appendChild(menu);

        addBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const isOpen = addBtn.getAttribute("aria-expanded") === "true";
            this._toggleAddMenu(!isOpen);
        });

        // stash for toggler
        this._addBtn = addBtn;
        this._addMenu = menu;

        return footer;
    }

    _toggleAddMenu(open) {
        if (!this._addBtn || !this._addMenu) return;
        const willOpen = Boolean(open);
        this._addBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
        this._addMenu.hidden = !willOpen;
        this._footer.classList.toggle("menu-open", willOpen);
    }

    _makeStyle() {
        const style = document.createElement("style");
        style.textContent = `
      :host, .history-widget {
        --bg: #0f1117;
        --bg-elev: #12141b;
        --border: #262b36;
        --text: #e6e6e6;
        --muted: #9aa4b2;
        --accent: #6ea8fe;
        --focus: #3b82f6;
        --danger: #ef4444;
        --input-bg: #0b0e14;
        --radius: 12px;
        color-scheme: dark;
      }
      .history-widget {
        color: var(--text);
        background: var(--bg-elev);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 3px;
        box-shadow: 0 6px 24px rgba(0,0,0,.35);
        max-width: 100%;
      }
      .accordion {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .acc-item {
        background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
      }
      .acc-item.open {
        
      }

      .acc-header-row {
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: stretch;
      }

      .acc-header {
        appearance: none;
        width: 100%;
        text-align: left;
        background: transparent;
        color: var(--text);
        border: 0;
        padding: 10px 12px;
        
       
        
        display: flex;
        align-items: center;
        gap: 3px;
        cursor: pointer;
      }
      .acc-header:focus {
        outline: none;
      }
      .acc-title {
        flex: 1;
        color: var(--text);
      }

      .acc-actions {
        display: flex;
        align-items: center;
        gap: 3px;
        padding: 6px 8px 6px 0;
      }

      .icon-btn {
        appearance: none;
        border: 1px solid var(--border);
        background: rgba(255,255,255,.03);
        color: var(--text);
        border-radius: 8px;
        padding: 4px 8px;
        cursor: pointer;
        transition: border-color .15s ease, background-color .15s ease, transform .05s ease;
      }
      .icon-btn:hover { border-color: var(--focus); }
      .icon-btn:active { transform: translateY(1px); }
      .icon-btn.danger:hover { border-color: var(--danger); color: #fff; background: rgba(239,68,68,.15); }

      .acc-content {
        padding: 10px 12px 12px 12px;
        border-top: 1px solid var(--border);
      }
      .acc-body {
        display: block;
      }

      /* Footer add button + menu */
      .footer {
        position: relative;
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px dashed var(--border);
        display: flex;
        justify-content: center;
      }
      .add-btn {
        appearance: none;
        border: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.02));
        color: var(--text);
        border-radius: 9999px;
        padding: 6px 10px;
        width: 36px;
        height: 36px;
        line-height: 24px;
        text-align: center;
        cursor: pointer;
        transition: border-color .15s ease, box-shadow .15s ease, transform .05s ease;
      }
      .add-btn:hover { border-color: var(--focus); box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
      .add-btn:active { transform: translateY(1px); }

      .add-menu {
        
        width:100%;
        /* max-height: 260px; */
        overflow: auto;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,.45);
        padding: 6px;
        z-index: 1000;
      }
      .menu-item {
        appearance: none;
        width: 100%;
        text-align: left;
        background: transparent;
        color: var(--text);
        border: 0;
        border-radius: 8px;
        padding: 8px 10px;
        cursor: pointer;
        transition: background-color .12s ease, color .12s ease;
      }
      .menu-item:hover {
        background: rgba(110,168,254,.12);
        color: #fff;
      }
      .menu-empty {
        padding: 10px;
        color: var(--muted);
      }
    `;
        return style;
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Dark-mode, framework-free, ES6 UI generator for feature schemas.
// - Renders inputs from schema.
// - Keeps the passed-in `params` object in sync as the user edits.
// - refreshFromParams() updates inputs when params are changed elsewhere.
// - Special: type === "reference_selection" → placeholder only.
class genFeatureUI {
    // Track a single globally-active reference selection input across all instances
    static __activeRefInput = null;
    static __setGlobalActiveRefInput(el) {
        try {
            // If another input was active, clear its visual + attribute
            const prev = genFeatureUI.__activeRefInput;
            if (prev && prev !== el) {
                try { prev.style.filter = 'none'; } catch (_) {}
                try { prev.removeAttribute('active-reference-selection'); } catch (_) {}
            }
        } catch (_) { }
        genFeatureUI.__activeRefInput = el || null;
    }
    /**
     * @param {Object} schema - e.g. { sizeX: {type:'number', default_value:'2*t', hint:'Width formula' }, ... }
     * @param {Object} params - a live object to keep in sync with user edits
     * @param {Object} [options]
     * @param {(featureID:string|null)=>void} [options.onChange] - Callback fired on any field change
     */
    constructor(schema, params, options = {}) {
        if (!schema || typeof schema !== 'object') throw new Error('schema must be an object');
        if (!params || typeof params !== 'object') throw new Error('params must be an object');

        this.schema = schema;
        this.params = params;
        this.options = options;
        this._inputs = new Map();
        this._excludedKeys = new Set(['featureID']); // exclude from defaults & rendering

        this.uiElement = document.createElement('div');
        this._shadow = this.uiElement.attachShadow({ mode: 'open' });

        this._shadow.appendChild(this._makeStyle());
        this._panel = document.createElement('div');
        this._panel.className = 'panel';
        this._shadow.appendChild(this._panel);

        this._fieldsWrap = document.createElement('div');
        this._fieldsWrap.className = 'fields';
        this._panel.appendChild(this._fieldsWrap);

        this._renderAllFields();
    }

    /** Returns the live params object (already kept in sync). */
    getParams() {
        return this.params;
    }

    /** Programmatically refresh input widgets from the current params object. */
    refreshFromParams() {
        for (const [key, el] of this._inputs.entries()) {
            const def = this.schema[key] || {};
            const v = this._pickInitialValue(key, def);
            this._setInputValue(el, def.type, v);

            // If this is a multi reference selection, also refresh chip list
            if (def && def.type === 'reference_selection' && def.multiple) {
                const row = this._fieldsWrap.querySelector(`[data-key="${key}"]`);
                const chips = row ? row.querySelector('.ref-chips') : null;
                if (chips) this._renderChips(chips, key, Array.isArray(v) ? v : []);
            }
        }
    }

    // --- Internal: rendering & behavior ---------------------------------------

    _renderAllFields() {
        // Ensure params has defaults for missing keys (without clobbering provided values)
        for (const key in this.schema) {
            if (!Object.prototype.hasOwnProperty.call(this.schema, key)) continue;
            const def = this.schema[key];
            if (this._excludedKeys.has(key)) continue;
            if (!(key in this.params)) {
                const v = ('default_value' in def) ? def.default_value : this._defaultForType(def.type);
                this.params[key] = v;
            }
        }

        // Build field rows
        for (const key in this.schema) {
            if (!Object.prototype.hasOwnProperty.call(this.schema, key)) continue;
            const def = this.schema[key];
            if (this._excludedKeys.has(key)) continue;

            const row = document.createElement('div');
            row.className = 'field-row';
            row.dataset.key = key;

            if (def.hint != null && def.hint !== '') {
                row.setAttribute('title', String(def.hint));
            }

            const id = 'gfu_' + key + '_' + Math.random().toString(36).slice(2, 8);

            const label = document.createElement('label');
            label.className = 'label';
            label.setAttribute('for', id);
            label.textContent = this._prettyLabel(key);
            row.appendChild(label);

            const controlWrap = document.createElement('div');
            controlWrap.className = 'control-wrap';

            let inputEl;

            switch (def.type) {
                case 'number':
                    inputEl = document.createElement('input');
                    inputEl.type = 'number';
                    inputEl.id = id;
                    inputEl.className = 'input';
                    // Optional numeric attributes from schema
                    try {
                        if (def && (typeof def.step === 'number' || (typeof def.step === 'string' && def.step.trim() !== '')))
                            inputEl.step = String(def.step);
                        if (def && (typeof def.min === 'number' || (typeof def.min === 'string' && def.min !== '')))
                            inputEl.min = String(def.min);
                        if (def && (typeof def.max === 'number' || (typeof def.max === 'string' && def.max !== '')))
                            inputEl.max = String(def.max);
                    } catch (_) { }

                    const numericPattern = /^-?\d*\.?\d*$/;

                    function isNumericLike(value) {
                        return numericPattern.test(value);
                    }

                    inputEl.addEventListener("beforeinput", (e) => {
                        console.log("beforeinput event fired");
                        console.log("inputEl.value:", inputEl.value);
                        console.log("e.data:", e.data);

                        if (isNumericLike(inputEl.value) && isNumericLike(e.data) && inputEl.type === "text") {
                            console.log("input type was text but we are changing it to a number")
                            if (inputEl.type !== "number") inputEl.type = "number";
                            return;
                        } else if (!isNumericLike(inputEl.value) || !isNumericLike(e.data) && inputEl.type === "number") {
                            if (inputEl.type !== "text") {
                                inputEl.type = "text";
                                inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);

                            }

                            // if character is a symbol or letter change the input type to text
                        }

                    });
                    this._setInputValue(inputEl, def.type, this._pickInitialValue(key, def));
                    inputEl.addEventListener('change', () => {
                        this.params[key] = inputEl.value;
                        this._emitParamsChange(key, inputEl.value);
                    });
                    inputEl.addEventListener('focus', () => {
                        inputEl.select();
                        if (isNumericLike(inputEl.value)) {
                            //console.log("is numeric like on focus");
                            inputEl.type = "number";
                            // Re-apply numeric attributes on type toggle
                            try {
                                if (def && (typeof def.step === 'number' || (typeof def.step === 'string' && def.step.trim() !== '')))
                                    inputEl.step = String(def.step);
                                if (def && (typeof def.min === 'number' || (typeof def.min === 'string' && def.min !== '')))
                                    inputEl.min = String(def.min);
                                if (def && (typeof def.max === 'number' || (typeof def.max === 'string' && def.max !== '')))
                                    inputEl.max = String(def.max);
                            } catch (_) { }
                        } else {
                            //console.log("is not numeric like on focus");
                            inputEl.type = "text";
                        }
                        this._stopActiveReferenceSelection();
                    });
                    break;

                case 'reference_selection': {
                    // Base input used to activate selection listening
                    inputEl = document.createElement('input');
                    inputEl.type = 'text';
                    inputEl.id = id;
                    inputEl.className = 'input';

                    // Multi-select support renders chip list next to input
                    const isMulti = !!def.multiple;
                    if (isMulti) inputEl.dataset.multiple = 'true';

                    // Wrapper so clicking anywhere can activate selection
                    const refWrap = document.createElement('div');
                    refWrap.className = isMulti ? 'ref-multi-wrap' : 'ref-wrap';

                    let chipsWrap = null;
                    if (isMulti) {
                        chipsWrap = document.createElement('div');
                        chipsWrap.className = 'ref-chips';
                        chipsWrap.addEventListener('click', () => {
                            this._activateReferenceSelection(inputEl, def);
                        });
                        refWrap.appendChild(chipsWrap);
                    }

                    this._setInputValue(inputEl, def.type, this._pickInitialValue(key, def));

                    // On change, update params: single → string, multi → array (merge unique)
                    inputEl.addEventListener('change', () => {
                        const raw = inputEl.value;
                        if (isMulti) {
                            // Handle force-clear (e.g., ESC from selection widget)
                            if (inputEl.dataset && inputEl.dataset.forceClear === 'true') {
                                this.params[key] = [];
                                if (chipsWrap) this._renderChips(chipsWrap, key, this.params[key]);
                                inputEl.value = '';
                                delete inputEl.dataset.forceClear;
                                this._emitParamsChange(key, this.params[key]);
                                return;
                            }
                            let incoming = [];
                            let parsedArray = false;
                            try {
                                const parsed = JSON.parse(raw);
                                if (Array.isArray(parsed)) { incoming = parsed; parsedArray = true; }
                            } catch (_) { /* not JSON */ }
                            if (!parsedArray && raw != null && String(raw).trim() !== '') incoming = [String(raw).trim()];

                            if (!Array.isArray(this.params[key])) this.params[key] = [];
                            // Merge unique (do not drop items missing from scene selection)
                            for (const name of incoming) {
                                if (!this.params[key].includes(name)) this.params[key].push(name);
                            }
                            if (chipsWrap) this._renderChips(chipsWrap, key, this.params[key]);
                            inputEl.value = '';
                            this._emitParamsChange(key, this.params[key]);
                        } else {
                            this.params[key] = raw;
                            this._emitParamsChange(key, raw);
                        }
                    });

                    // Activate selection on click
                    inputEl.addEventListener('click', () => this._activateReferenceSelection(inputEl, def));

                    if (isMulti && chipsWrap) {
                        const current = this._pickInitialValue(key, def);
                        if (Array.isArray(current) && current.length) this._renderChips(chipsWrap, key, current);
                        refWrap.appendChild(inputEl);
                        inputEl.placeholder = 'Click then select in scene…';
                        controlWrap.appendChild(refWrap);
                    } else {
                        controlWrap.appendChild(inputEl);
                    }
                    break;
                }

                case 'string': {
                    inputEl = document.createElement('input');
                    inputEl.type = 'text';
                    inputEl.id = id;
                    inputEl.className = 'input';
                    this._setInputValue(inputEl, def.type, this._pickInitialValue(key, def));
                    inputEl.addEventListener('change', () => {
                        this.params[key] = inputEl.value;
                        this._emitParamsChange(key, inputEl.value);
                        this._stopActiveReferenceSelection();
                    });

                    break;
                }
                case 'boolean': {
                    inputEl = document.createElement('input');
                    inputEl.type = 'checkbox';
                    inputEl.id = id;
                    inputEl.className = 'checkbox';
                    this._setInputValue(inputEl, 'boolean', this._pickInitialValue(key, def));
                    inputEl.addEventListener('change', () => {
                        const v = Boolean(inputEl.checked);
                        this.params[key] = v;
                        this._emitParamsChange(key, v);
                        this._stopActiveReferenceSelection();
                    });
                    break;
                }
                case 'options': {
                    inputEl = document.createElement('select');
                    inputEl.id = id;
                    inputEl.className = 'select';
                    const opts = Array.isArray(def.options) ? def.options : [];
                    for (let i = 0; i < opts.length; i++) {
                        const opt = opts[i];
                        const o = document.createElement('option');
                        o.value = String(opt);
                        o.textContent = String(opt);
                        inputEl.appendChild(o);
                    }
                    this._setInputValue(inputEl, 'options', this._pickInitialValue(key, def));
                    inputEl.addEventListener('change', () => {
                        const v = inputEl.value;
                        this.params[key] = v;
                        this._emitParamsChange(key, v);
                        this._stopActiveReferenceSelection();
                    });
                    break;
                }
                case 'file': {
                    // Visible button, hidden file input, and a small info label showing current status
                    inputEl = document.createElement('button');
                    inputEl.type = 'button';
                    inputEl.id = id;
                    inputEl.className = 'btn';
                    inputEl.textContent = String(def.label || 'Choose File…');

                    const info = document.createElement('div');
                    info.className = 'file-info';
                    const initial = this._pickInitialValue(key, def);
                    if (typeof initial === 'string' && initial.startsWith('data:') && initial.includes(';base64,')) {
                        // Estimate size from base64 length
                        const b64 = initial.split(',')[1] || '';
                        const size = Math.floor((b64.length * 3) / 4);
                        info.textContent = `Loaded (${size} bytes)`;
                    } else if (initial && String(initial).length) {
                        info.textContent = `Loaded (${String(initial).length} chars)`;
                    } else {
                        info.textContent = 'No file selected';
                    }

                    const fileInput = document.createElement('input');
                    fileInput.type = 'file';
                    fileInput.style.display = 'none';
                    if (def && def.accept) fileInput.setAttribute('accept', String(def.accept));

                    inputEl.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        fileInput.click();
                    });

                    fileInput.addEventListener('change', async () => {
                        const f = fileInput.files && fileInput.files[0];
                        if (!f) return;
                        try {
                            // Always store as base64 Data URL so binary survives JSON persistence
                            const ab = await f.arrayBuffer();
                            const bytes = new Uint8Array(ab);
                            // Convert to base64 in chunks to avoid stack overflow
                            let binary = '';
                            const chunk = 0x8000;
                            for (let i = 0; i < bytes.length; i += chunk) {
                                const sub = bytes.subarray(i, i + chunk);
                                binary += String.fromCharCode.apply(null, sub);
                            }
                            const b64 = (typeof btoa === 'function') ? btoa(binary) : (typeof Buffer !== 'undefined' ? Buffer.from(bytes).toString('base64') : '');
                            const mime = (f.type && f.type.length) ? f.type : 'application/octet-stream';
                            const dataUrl = `data:${mime};base64,${b64}`;
                            this.params[key] = dataUrl;
                            info.textContent = `${f.name} (${bytes.length} bytes)`;
                            this._emitParamsChange(key, dataUrl);
                        } catch (e) {
                            info.textContent = `Failed to read file: ${e?.message || e}`;
                        }
                    });

                    // Attach info and hidden input; the button itself will be appended below
                    controlWrap.appendChild(info);
                    controlWrap.appendChild(fileInput);

                    break;
                }
                case 'button': {
                    inputEl = document.createElement('button');
                    inputEl.type = 'button';
                    inputEl.id = id;
                    inputEl.className = 'btn';
                    inputEl.textContent = String(def.label || this._prettyLabel(key));
                    inputEl.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        this._stopActiveReferenceSelection();
                        const fid = (this.params && Object.prototype.hasOwnProperty.call(this.params, 'featureID'))
                            ? this.params.featureID
                            : null;
                        try { if (typeof this.options.onAction === 'function') this.options.onAction(fid, key); } catch (_) { }
                    });
                    break;
                }
                default: {
                    inputEl = document.createElement('input');
                    inputEl.type = 'text';
                    inputEl.id = id;
                    inputEl.className = 'input';
                    this._setInputValue(inputEl, 'string', this._pickInitialValue(key, def));
                    inputEl.addEventListener('change', () => {
                        this.params[key] = inputEl.value;
                        this._emitParamsChange(key, inputEl.value);
                    });

                }
            }

            controlWrap.appendChild(inputEl);
            row.appendChild(controlWrap);
            this._fieldsWrap.appendChild(row);
            this._inputs.set(key, inputEl);
        }
    }

    // Public: Activate the first reference_selection input in this form (if any)
    activateFirstReferenceSelection() {
        try {
            for (const key in this.schema) {
                if (!Object.prototype.hasOwnProperty.call(this.schema, key)) continue;
                const def = this.schema[key];
                if (def && def.type === 'reference_selection') {
                    const inputEl = this._inputs.get(key);
                    if (inputEl) {
                        this._activateReferenceSelection(inputEl, def);
                        return true;
                    }
                }
            }
        } catch (_) { }
        return false;
    }

    _activateReferenceSelection(inputEl, def) {
        // Ensure only one control is globally marked as active
        genFeatureUI.__setGlobalActiveRefInput(inputEl);

        // Also clear any duplicates within this shadow root (defensive)
        const clearLocal = (root) => {
            if (!root || typeof root.querySelectorAll !== 'function') return;
            root.querySelectorAll('[active-reference-selection="true"],[active-reference-selection=true]').forEach(el => {
                if (el !== inputEl) {
                    try { el.style.filter = 'none'; } catch (_) {}
                    try { el.removeAttribute('active-reference-selection'); } catch (_) {}
                }
            });
        };
        clearLocal(this._shadow);

        // Mark this control active with a recency timestamp for any external scanners
        try { inputEl.dataset.activatedAt = String(Date.now()); } catch (_) { }
        inputEl.style.filter = 'invert(1)';
        inputEl.setAttribute('active-reference-selection', 'true');

        try { console.log('Setting selection types:', def.selectionFilter); } catch (_) { }
        SelectionFilter.stashAllowedSelectionTypes();
        SelectionFilter.SetSelectionTypes(def.selectionFilter);
    }


    _stopActiveReferenceSelection() {
        // Clear global active if it belongs to this instance
        try {
            if (genFeatureUI.__activeRefInput) {
                try { genFeatureUI.__activeRefInput.style.filter = 'none'; } catch (_) {}
                try { genFeatureUI.__activeRefInput.removeAttribute('active-reference-selection'); } catch (_) {}
            }
        } catch (_) { }
        genFeatureUI.__activeRefInput = null;
        SelectionFilter.restoreAllowedSelectionTypes();
    }

    _renderChips(chipsWrap, key, values) {
        chipsWrap.textContent = '';
        const arr = Array.isArray(values) ? values : [];
        for (const name of arr) {
            const chip = document.createElement('span');
            chip.className = 'ref-chip';

            const label = document.createElement('span');
            label.className = 'ref-chip-label';
            label.textContent = name;
            chip.appendChild(label);

            // Hover highlight on chip hover
            chip.addEventListener('mouseenter', () => {
                try { SelectionFilter.setHoverByName(this.options?.scene || null, name); } catch (_) { }
            });
            chip.addEventListener('mouseleave', () => {
                try { SelectionFilter.clearHover(); } catch (_) { }
            });

            const btn = document.createElement('span');
            btn.className = 'ref-chip-remove';
            btn.textContent = '✕';
            btn.title = 'Remove';
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (!Array.isArray(this.params[key])) this.params[key] = [];
                const idx = this.params[key].indexOf(name);
                if (idx >= 0) this.params[key].splice(idx, 1);
                this._renderChips(chipsWrap, key, this.params[key]);
                this._emitParamsChange(key, this.params[key]);
                try {
                    if (typeof this.options.onReferenceChipRemove === 'function') {
                        this.options.onReferenceChipRemove(name, key);
                    }
                } catch (_) { }
            });
            chip.appendChild(btn);

            chipsWrap.appendChild(chip);
        }
        if (arr.length === 0) {
            const hint = document.createElement('span');
            hint.className = 'ref-chip';
            hint.style.opacity = '0.6';
            hint.textContent = 'Click then pick items in scene';
            chipsWrap.appendChild(hint);
        }
    }

    _emitParamsChange(key, value) {
        if (typeof this.options.onChange === 'function') {
            const featureID = (this.params && Object.prototype.hasOwnProperty.call(this.params, 'featureID'))
                ? this.params.featureID
                : null;
            try {
                this.options.onChange(featureID);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.log(error);
            }
        }
    }

    _pickInitialValue(key, def) {
        if (this.params[key] !== undefined && this.params[key] !== null) return this.params[key];
        if (Object.prototype.hasOwnProperty.call(def, 'default_value')) return def.default_value;
        return this._defaultForType(def.type);
    }

    _defaultForType(type) {
        switch (type) {
            case 'boolean': return false;
            case 'options': return '';
            case 'reference_selection': return null;
            default: return '';
        }
    }

    _setInputValue(el, type, value) {
        switch (type) {
            case 'boolean':
                el.checked = Boolean(value);
                break;
            case 'options': {
                const asStr = String(value == null ? '' : value);
                let has = false;
                for (let i = 0; i < el.options.length; i++) {
                    if (el.options[i].value === asStr) { has = true; break; }
                }
                el.value = has ? asStr : (el.options[0] ? el.options[0].value : '');
                break;
            }
            case 'file': {
                // Update the info label adjacent to the button
                try {
                    const wrap = el && el.parentNode ? el.parentNode : null;
                    const info = wrap ? wrap.querySelector('.file-info') : null;
                    if (info) {
                        if (typeof value === 'string' && value.startsWith('data:') && value.includes(';base64,')) {
                            const b64 = value.split(',')[1] || '';
                            const size = Math.floor((b64.length * 3) / 4);
                            info.textContent = `Loaded (${size} bytes)`;
                        } else if (value && String(value).length) {
                            info.textContent = `Loaded (${String(value).length} chars)`;
                        } else {
                            info.textContent = 'No file selected';
                        }
                    }
                } catch (_) { }
                break;
            }
            default:
                el.value = value == null ? '' : String(value);
                break;
        }
    }

    _prettyLabel(key) {
        const withSpaces = String(key)
            .replace(/_/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/\s+/g, ' ')
            .trim();
        return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
    }

    _makeStyle() {
        const style = document.createElement('style');
        style.textContent = `
      :host, .panel {
        --bg: #0f1117;
        --bg-elev: #12141b;
        --border: #262b36;
        --text: #e6e6e6;
        --muted: #9aa4b2;
        --accent: #6ea8fe;
        --focus: #3b82f6;
        --input-bg: #0b0e14;
        --radius: 12px;
        --gap: 3px;
        color-scheme: dark;
      }

      .panel {
        color: var(--text);
        background: transparent;
        border-radius: var(--radius);
        max-width: 100%;
      }

      .fields {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .field-row {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
      }

      .label {
        color: var(--muted);
      }

      .control-wrap { display: flex; flex-direction: column; gap: 6px; }

      .input, .select {
        appearance: none;
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 10px;
        outline: none;
        transition: border-color .15s ease, box-shadow .15s ease;
      }
      .btn {
        appearance: none;
        background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 12px;
        cursor: pointer;
        transition: border-color .15s ease, box-shadow .15s ease, transform .05s ease;
      }
      .btn:hover { border-color: var(--focus); box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
      .btn:active { transform: translateY(1px); }
      .input:focus, .select:focus {
        border-color: var(--focus);
        
      }
      .file-info { font-size: 12px; color: var(--muted); }

      .checkbox {
        width: 18px; height: 18px;
        accent-color: var(--accent);
      }

      .ref-select-placeholder {
        min-height: 36px;
        border: 1px dashed var(--border);
        border-radius: 10px;
        background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
      }
      /* Multi reference chips */
      .ref-multi-wrap { display: flex; flex-direction: column; gap: 6px; }
      .ref-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px; border: 1px dashed var(--border); border-radius: 10px; cursor: pointer; background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01)); max-width: 100%; }
      .ref-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; background: #1a2030; border: 1px solid var(--border); font-size: 12px; max-width: 100%; }
      .ref-chip-label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; word-break: break-word; white-space: normal; }
      .ref-chip-remove { color: var(--muted); cursor: pointer; flex: 0 0 auto; }
      .ref-chip-remove:hover { color: var(--danger); }
    `;
        return style;
    }
}
