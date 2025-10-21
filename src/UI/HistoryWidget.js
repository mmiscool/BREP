// HistoryWidget.js
// ES6, framework-free, dark-mode. No external deps.
// Incremental sync with the viewer's feature history:
// - Only adds/removes/reorders accordion items when the features array changes.
// - Does NOT rebuild existing forms. It refreshes field values in-place when params change.
// - Each feature is its own accordion section.

"use strict";

import { SelectionFilter } from './SelectionFilter.js';
import { genFeatureUI } from './featureDialogs.js';
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
        let def = null;
        try {
            if (fr && typeof fr.getSafe === 'function') def = fr.getSafe(feature.type);
            else if (fr && typeof fr.get === 'function') def = fr.get(feature.type);
        } catch (_) { def = null; }
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
            if (ph2) {
                if (openNext) {
                    ph2.currentHistoryStepId = String(id);
                } else {
                    // No feature expanded → clear stop-at pointer
                    ph2.currentHistoryStepId = null;
                }
                // execute the feature history (will stop at pointer if set)
                ph2.runHistory();
            }
        });

        // title text
        const titleText = document.createElement("span");
        titleText.className = "acc-title";
        titleText.textContent = this._composeTitle(feature, id);
        headerBtn.appendChild(titleText);

        // status (runtime + error indicator)
        const statusText = document.createElement("span");
        statusText.className = "acc-status";
        statusText.textContent = this._composeStatus(feature);
        if (feature && feature.lastRun && feature.lastRun.ok === false && feature.lastRun.error && feature.lastRun.error.message) {
            statusText.title = String(feature.lastRun.error.message);
        }
        headerBtn.appendChild(statusText);

        // Actions (reorder, delete)
        const actions = document.createElement("div");
        actions.className = "acc-actions";

        const upBtn = document.createElement("button");
        upBtn.type = "button";
        upBtn.className = "icon-btn";
        upBtn.setAttribute("aria-label", "Move feature up");
        upBtn.title = "Move up";
        upBtn.textContent = "▲";
        upBtn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            await this._handleMoveFeatureUp(String(id));
        });

        const downBtn = document.createElement("button");
        downBtn.type = "button";
        downBtn.className = "icon-btn";
        downBtn.setAttribute("aria-label", "Move feature down");
        downBtn.title = "Move down";
        downBtn.textContent = "▼";
        downBtn.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            await this._handleMoveFeatureDown(String(id));
        });

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

        actions.appendChild(upBtn);
        actions.appendChild(downBtn);
        actions.appendChild(delBtn);
        // No "run to end" play button in legacy UI

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

        // Do not build UI yet; lazy-mount when expanded

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
            // Lazy UI mount/destroy
            ui: null,
            body,
            schema,
            isOpen: false,
            paramsSig: this._computeParamsSig(feature.inputParams),
            type: feature.type,
            statusText,
            missing: !def
        };
        // Mark error state if present or feature type is missing
        if ((feature && feature.lastRun && feature.lastRun.ok === false) || !def) {
            item.classList.add('has-error');
        }
        if (!def) {
            try { statusText.textContent = 'Missing'; } catch (_) {}
            try { statusText.title = `Feature type "${feature.type}" not available`; } catch (_) {}
        }
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
        if (entry.ui) {
            try { typeof entry.ui._stopActiveReferenceSelection === 'function' && entry.ui._stopActiveReferenceSelection(); } catch (_) { }
            try { typeof entry.ui.destroy === "function" && entry.ui.destroy(); } catch (_e) { }
            entry.ui = null;
        }
        try { entry.body && (entry.body.textContent = ""); } catch (_) { }
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

            // Update status (runtime + errors, and mark missing features)
            let isMissing = false;
            try {
                const ph = this._getPartHistory();
                const fr = ph && ph.featureRegistry ? ph.featureRegistry : null;
                if (fr) {
                    if (typeof fr.has === 'function') isMissing = !fr.has(f.type);
                    else if (typeof fr.getSafe === 'function') isMissing = !fr.getSafe(f.type);
                    else { try { fr.get(f.type); isMissing = false; } catch (_) { isMissing = true; } }
                }
            } catch (_) { isMissing = false; }
            entry.missing = isMissing;
            if (entry.statusText) {
                const status = isMissing ? 'Missing' : this._composeStatus(f);
                entry.statusText.textContent = status;
                if (isMissing) {
                    entry.statusText.title = `Feature type "${f.type}" not available`;
                } else if (f && f.lastRun && f.lastRun.ok === false && f.lastRun.error && f.lastRun.error.message) {
                    entry.statusText.title = String(f.lastRun.error.message);
                } else {
                    entry.statusText.removeAttribute('title');
                }
            }
            // Toggle error state class (error or missing)
            try {
                const hasErr = !!(f && f.lastRun && f.lastRun.ok === false);
                entry.root.classList.toggle('has-error', hasErr || isMissing);
            } catch (_) {}

            // Params changed?
            const newSig = this._computeParamsSig(f.inputParams);
            if (newSig !== entry.paramsSig) {
                entry.paramsSig = newSig;
                // Update only if UI is mounted
                if (entry.ui) {
                    entry.ui.params = f.inputParams;
                    try { entry.ui.refreshFromParams(); } catch (_e) { }
                }
            }
        }
    }

    _composeTitle(feature, id) {
        const kind = feature && feature.type ? String(feature.type) : "Feature";
        return `${kind}  —  #${id}`;
    }

    _composeStatus(feature) {
        if (!feature) return '';
        const lr = feature.lastRun || null;
        const pieces = [];
        if (lr && Number.isFinite(lr.durationMs)) pieces.push(this._formatDuration(lr.durationMs));
        if (lr && lr.ok === false) pieces.push('✖');
        return pieces.length ? pieces.join(' ') : '';
    }

    _formatDuration(ms) {
        if (!Number.isFinite(ms)) return '';
        if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
        return `${Math.round(ms)} ms`;
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

        // Mount UI on open, unmount on close
        if (entry.isOpen) {
            if (!entry.ui) {
                try {
                    const ph = this._getPartHistory();
                    const features = this._safeFeatures(ph);
                    const feature = features.find(f => f && f.inputParams && String(f.inputParams.featureID) === String(entry.id));
                    const fr = ph && ph.featureRegistry ? ph.featureRegistry : null;
                    let def = null;
                    try {
                        if (fr && typeof fr.getSafe === 'function') def = fr.getSafe(feature.type);
                        else if (fr && typeof fr.get === 'function') def = fr.get(feature.type);
                    } catch (_) { def = null; }
                    entry.missing = !def;
                    if (!def) {
                        const wrap = document.createElement('div');
                        wrap.className = 'missing-feature-panel';
                        const msg = document.createElement('div');
                        msg.className = 'missing-msg';
                        msg.textContent = `Feature type "${feature?.type || ''}" is not available. You can remove it or install a plugin that provides it.`;
                        wrap.appendChild(msg);
                        const del = document.createElement('button');
                        del.type = 'button';
                        del.className = 'btn btn-slim';
                        del.textContent = 'Remove from history';
                        del.addEventListener('click', (ev) => { ev.stopPropagation(); this._handleDeleteFeature(String(entry.id)); });
                        wrap.appendChild(del);
                        entry.body.appendChild(wrap);
                        entry.ui = wrap; // minimal marker
                    } else {
                        const schema = def && def.inputParamsSchema ? def.inputParamsSchema : (entry.schema || {});
                        const ui = new genFeatureUI(schema, feature ? feature.inputParams : {}, {
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
                                } else if (actionKey === 'editSpline' && typeof v.startSplineMode === 'function') {
                                    v.startSplineMode(featureID);
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
                        scene: ph && ph.scene ? ph.scene : null,
                        viewer: this.viewer || null,
                        partHistory: this._getPartHistory() || null,
                        featureRef: feature || null,
                        });
                        entry.body.appendChild(ui.uiElement);
                        entry.ui = ui;
                    }
                } catch (_) { }
            }
        } else {
            // closing
            try { entry.ui && typeof entry.ui._stopActiveReferenceSelection === 'function' && entry.ui._stopActiveReferenceSelection(); } catch (_) { }
            if (entry.ui) {
                try { typeof entry.ui.destroy === 'function' && entry.ui.destroy(); } catch (_) { }
                try { entry.body.textContent = ""; } catch (_) { }
                entry.ui = null;
            }
        }

        if (exclusive && entry.isOpen) {
            // Close others
            for (const [, e] of this._sections) {
                if (e === entry) continue;
                if (e.isOpen) {
                    e.isOpen = false;
                    e.headerBtn.setAttribute("aria-expanded", "false");
                    e.root.classList.remove("open");
                    e.content.hidden = true;
                    // Ensure any active reference selection is stopped when a section closes
                    try { e.ui && typeof e.ui._stopActiveReferenceSelection === 'function' && e.ui._stopActiveReferenceSelection(); } catch (_) { }
                    // Destroy UI for closed sections
                    if (e.ui) {
                        try { typeof e.ui.destroy === 'function' && e.ui.destroy(); } catch (_) { }
                        try { e.body && (e.body.textContent = ""); } catch (_) { }
                        e.ui = null;
                    }
                }
            }
            // Do not auto-activate reference selection; only activate on explicit user click
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

    async _handleMoveFeatureUp(featureID) {
        const ph = this._getPartHistory();
        if (!ph) return;
        try {
            const arr = this._safeFeatures(ph);
            const idx = arr.findIndex(f => f && f.inputParams && f.inputParams.featureID === featureID);
            if (idx <= 0) return; // already at top or not found
            const [item] = ph.features.splice(idx, 1);
            ph.features.splice(idx - 1, 0, item);
            ph.currentHistoryStepId = featureID;
            if (typeof ph.runHistory === "function") {
                await ph.runHistory();
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[HistoryWidget] move up failed:", err);
        } finally {
            this.scheduleSync();
        }
    }

    async _handleMoveFeatureDown(featureID) {
        const ph = this._getPartHistory();
        if (!ph) return;
        try {
            const arr = this._safeFeatures(ph);
            const idx = arr.findIndex(f => f && f.inputParams && f.inputParams.featureID === featureID);
            if (idx < 0 || idx >= arr.length - 1) return; // not found or already at bottom
            const [item] = ph.features.splice(idx, 1);
            ph.features.splice(idx + 1, 0, item);
            ph.currentHistoryStepId = featureID;
            if (typeof ph.runHistory === "function") {
                await ph.runHistory();
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[HistoryWidget] move down failed:", err);
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

      .acc-status {
        margin-left: 8px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1;
      }

      .acc-item.has-error .acc-status {
        color: var(--danger);
        font-weight: 600;
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

      /* Missing feature placeholder panel */
      .missing-feature-panel { display: flex; flex-direction: column; gap: 8px; }
      .missing-feature-panel .missing-msg { color: var(--muted); font-size: 13px; }

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
        z-index: 6;
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
