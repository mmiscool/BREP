// HistoryWidget.js
// ES6, framework-free, dark-mode. No external deps.
// Incremental sync with the viewer's feature history:
// - Only adds/removes/reorders accordion items when the features array changes.
// - Does NOT rebuild existing forms. It refreshes field values in-place when params change.
// - Each feature is its own accordion section.

"use strict";

import { SelectionFilter } from './SelectionFilter.js';
import * as THREE from 'three';
import { TransformControls as TransformControlsDirect } from 'three/examples/jsm/controls/TransformControls.js';
import { TransformControls as TransformControlsAddons } from 'three/examples/jsm/Addons.js';

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
                try { prev.style.filter = 'none'; } catch (_) { }
                try { prev.removeAttribute('active-reference-selection'); } catch (_) { }
            }
        } catch (_) { }
        genFeatureUI.__activeRefInput = el || null;
    }

    // Track a single globally-active transform controls session across all instances
    static __activeXform = {
        owner: null,
        key: null,
        inputEl: null,
        wrapEl: null,
        target: null,
        controls: null,
        viewer: null,
    };
    static __stopGlobalActiveXform() {
        const s = genFeatureUI.__activeXform;
        if (!s || !s.controls) return;
        try {
            // Detach and dispose controls
            s.controls.detach();
            if (s.viewer && s.viewer.scene) {
                try { if (s.controls && s.controls.isObject3D) s.viewer.scene.remove(s.controls); } catch (_) {}
                try { if (s.controls && s.controls.__helper && s.controls.__helper.isObject3D) s.viewer.scene.remove(s.controls.__helper); } catch (_) {}
                try { if (s.group && s.group.isObject3D) s.viewer.scene.remove(s.group); } catch (_) {}
            }
            try { s.controls.dispose(); } catch (_) {}
        } catch (_) { }
        try {
            // Remove any capture-phase event listeners installed during activation
            const h = s.captureHandlers;
            if (h && h.canvas && h.onDownCapture) {
                h.canvas.removeEventListener('pointerdown', h.onDownCapture, true);
            }
            if (h && h.win && h.onUpCapture) {
                h.win.removeEventListener('pointerup', h.onUpCapture, true);
            }
        } catch (_) { }
        try {
            // Remove target object
            if (s.viewer && s.viewer.scene && s.target) s.viewer.scene.remove(s.target);
        } catch (_) { }
        try { if (window.__BREP_activeXform) window.__BREP_activeXform = null; } catch (_) { }
        try {
            // Restore camera controls
            if (s.viewer && s.viewer.controls) s.viewer.controls.enabled = true;
        } catch (_) { }
        try {
            // Clear highlight
            if (s.inputEl) s.inputEl.removeAttribute('active-transform');
            const wrap = s.wrapEl;
            if (wrap) wrap.classList.remove('ref-active');
        } catch (_) { }
        genFeatureUI.__activeXform = { owner: null, key: null, inputEl: null, wrapEl: null, target: null, controls: null, viewer: null, captureHandlers: null };
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

        // Deactivate reference selection when focusing or clicking into any other control
        const stopIfOtherControl = (target) => {
            try {
                // If the active input is not the current focus target, stop selection
                const active = genFeatureUI.__activeRefInput || null;
                if (!active) return;
                if (target === active) return;
                // If target is inside the same active element (e.g., clicking within the input), skip
                if (target && typeof target.closest === 'function') {
                    if (target.closest('[active-reference-selection]')) return;
                }
                this._stopActiveReferenceSelection();
            } catch (_) { }
            try {
                // Close active transform session if clicking outside its wrapper; commit changes
                const s = genFeatureUI.__activeXform;
                if (s && s.owner === this) {
                    if (!(target && typeof target.closest === 'function' && target.closest('.transform-wrap'))) {
                        const val = this.params[s.key];
                        genFeatureUI.__stopGlobalActiveXform();
                        this._emitParamsChange(s.key, val);
                    }
                }
            } catch (_) { }
        };
        // Capture focus changes within this form
        this._shadow.addEventListener('focusin', (ev) => {
            stopIfOtherControl(ev.target);
        }, true);
        // Also capture mouse interactions to be safe
        this._shadow.addEventListener('mousedown', (ev) => {
            stopIfOtherControl(ev.target);
        }, true);
    }

    destroy() {
        // Clean up any active transform session owned by this instance
        try {
            const s = genFeatureUI.__activeXform;
            if (s && s.owner === this) genFeatureUI.__stopGlobalActiveXform();
        } catch (_) { }
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
            // Special composite types handle their own refresh
            if (def && def.type === 'boolean_operation') {
                const row = this._fieldsWrap.querySelector(`[data-key="${key}"]`);
                const select = row ? row.querySelector('select[data-role="bool-op"]') : null;
                if (select) {
                    const opVal = (v && typeof v === 'object') ? (v.operation) : null;
                    select.value = opVal ? String(opVal) : 'NONE';
                }
                const chips = row ? row.querySelector('.ref-chips') : null;
                const targets = (v && typeof v === 'object' && Array.isArray(v.targets)) ? v.targets : [];
                if (chips) this._renderChips(chips, key, targets);
                continue;
            }

            this._setInputValue(el, def.type, v);

            // If this is a reference selection, refresh custom UI
            if (def && def.type === 'reference_selection') {
                const row = this._fieldsWrap.querySelector(`[data-key="${key}"]`);
                if (def.multiple) {
                    const chips = row ? row.querySelector('.ref-chips') : null;
                    if (chips) this._renderChips(chips, key, Array.isArray(v) ? v : []);
                } else {
                    const display = row ? row.querySelector('.ref-single-display') : null;
                    if (display) {
                        const txt = (v == null || String(v).trim() === '') ? 'Click then select in scene…' : String(v);
                        display.textContent = txt;
                    }
                }
                continue;
            }

            // Transform widget: refresh info line
            if (def && def.type === 'transform') {
                const row = this._fieldsWrap.querySelector(`[data-key="${key}"]`);
                const info = row ? row.querySelector('.transform-info') : null;
                if (info) {
                    const fmt = (n) => {
                        const x = Number(n);
                        if (!Number.isFinite(x)) return '0';
                        const a = Math.abs(x);
                        const prec = a >= 100 ? 0 : (a >= 10 ? 1 : 2);
                        return String(x.toFixed(prec));
                    };
                    const p = Array.isArray(v?.position) ? v.position : [0,0,0];
                    const r = Array.isArray(v?.rotationEuler) ? v.rotationEuler : [0,0,0];
                    info.textContent = `pos(${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])})  rot(${fmt(r[0])}, ${fmt(r[1])}, ${fmt(r[2])})`;
                }
                continue;
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
                const raw = ('default_value' in def) ? def.default_value : this._defaultForType(def.type);
                this.params[key] = this._cloneDefault(raw);
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
                        if (def && (typeof def.step === 'number' || (typeof def.step === 'string' && def.step.trim() !== ''))) {
                            inputEl.step = String(def.step);
                            inputEl.dataset.step = String(def.step);
                        }
                        if (def && (typeof def.min === 'number' || (typeof def.min === 'string' && def.min !== ''))) {
                            inputEl.min = String(def.min);
                            inputEl.dataset.min = String(def.min);
                        }
                        if (def && (typeof def.max === 'number' || (typeof def.max === 'string' && def.max !== ''))) {
                            inputEl.max = String(def.max);
                            inputEl.dataset.max = String(def.max);
                        }
                    } catch (_) { }

                    const numericPattern = /^-?\d*\.?\d*$/;

                    function isNumericLike(value) {
                        console.log("isNumericLike:", value);
                        return numericPattern.test(value);
                    }

                    const DEBUG_UI = false;
                    inputEl.addEventListener("beforeinput", (e) => {
                        if (DEBUG_UI) console.log("beforeinput event fired");
                        if (DEBUG_UI) console.log("inputEl.value:", inputEl.value);
                        if (DEBUG_UI) console.log("e.data:", e.data);

                        if (isNumericLike(inputEl.value) && isNumericLike(e.data) && inputEl.type === "text") {
                            if (DEBUG_UI) console.log("input type was text but we are changing it to a number")
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
                    // Ensure initial type matches content: if value is an equation
                    // or any non-numeric string, render as text so the equation is visible.
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
                                if (inputEl.dataset && inputEl.dataset.step) inputEl.step = inputEl.dataset.step;
                                if (inputEl.dataset && inputEl.dataset.min) inputEl.min = inputEl.dataset.min;
                                if (inputEl.dataset && inputEl.dataset.max) inputEl.max = inputEl.dataset.max;
                            } catch (_) { }
                        } else {
                            //console.log("is not numeric like on focus");
                            inputEl.type = "text";
                        }
                        this._stopActiveReferenceSelection();
                    });
                    break;

                case 'reference_selection': {
                    // Hidden input used as event/value carrier; visible UI is custom
                    inputEl = document.createElement('input');
                    inputEl.type = 'hidden';
                    inputEl.id = id;
                    // Multi-select support renders chip list next to hidden input
                    const isMulti = !!def.multiple;
                    if (isMulti) inputEl.dataset.multiple = 'true';

                    // Wrapper so clicking anywhere can activate selection
                    const refWrap = document.createElement('div');
                    refWrap.className = isMulti ? 'ref-multi-wrap' : 'ref-single-wrap';

                    let chipsWrap = null;
                    if (isMulti) {
                        chipsWrap = document.createElement('div');
                        chipsWrap.className = 'ref-chips';
                        chipsWrap.addEventListener('click', () => {
                            this._activateReferenceSelection(inputEl, def);
                        });
                        refWrap.appendChild(chipsWrap);
                        // Initial render of any existing chips
                        try {
                            const current = this._pickInitialValue(key, def);
                            this._renderChips(chipsWrap, key, Array.isArray(current) ? current : []);
                        } catch (_) { }
                    } else {
                        // Single-select: render a clickable display that looks like an input
                        const display = document.createElement('div');
                        display.className = 'ref-single-display';
                        display.title = 'Click then select in scene';
                        const setDisplay = (val) => {
                            const txt = (val == null || String(val).trim() === '') ? 'Click then select in scene…' : String(val);
                            display.textContent = txt;
                        };
                        setDisplay(this._pickInitialValue(key, def));
                        display.addEventListener('click', () => this._activateReferenceSelection(inputEl, def));
                        refWrap.appendChild(display);

                        // Keep display in sync when value changes
                        inputEl.addEventListener('change', () => setDisplay(inputEl.value));
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

                    // Keep hidden input inside wrapper so ESC/highlight logic can find it
                    refWrap.appendChild(inputEl);
                    controlWrap.appendChild(refWrap);
                    break;
                }

                case 'transform': {
                    // Hidden input placeholder to carry active state (for consistency)
                    inputEl = document.createElement('input');
                    inputEl.type = 'hidden';
                    inputEl.id = id;

                    const wrap = document.createElement('div');
                    wrap.className = 'transform-wrap';

                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'btn';
                    btn.textContent = String(def.label || 'Position in 3D…');

                    // Info line showing current TRS
                    const info = document.createElement('div');
                    info.className = 'transform-info';
                    const fmt = (n) => {
                        const v = Number(n);
                        if (!Number.isFinite(v)) return '0';
                        const a = Math.abs(v);
                        const prec = a >= 100 ? 0 : (a >= 10 ? 1 : 2);
                        return String(v.toFixed(prec));
                    };
                    const updateInfo = () => {
                        const v = this._pickInitialValue(key, def) || {};
                        const p = Array.isArray(v.position) ? v.position : [0, 0, 0];
                        const r = Array.isArray(v.rotationEuler) ? v.rotationEuler : [0, 0, 0];
                        info.textContent = `pos(${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])})  rot(${fmt(r[0])}, ${fmt(r[1])}, ${fmt(r[2])})`;
                    };
                    updateInfo();

                    // Mode toggles
                    const modes = document.createElement('div');
                    modes.className = 'transform-modes';
                    const mkModeBtn = (label, mode) => {
                        const b = document.createElement('button');
                        b.type = 'button';
                        b.className = 'btn btn-slim';
                        b.textContent = label;
                        b.dataset.mode = mode;
                        b.addEventListener('click', () => {
                            inputEl.dataset.xformMode = mode;
                            try {
                                const s = genFeatureUI.__activeXform;
                                if (s && s.inputEl === inputEl && s.controls) s.controls.setMode(mode);
                            } catch (_) { }
                            // update visual selected state (only for mode buttons)
                            modes.querySelectorAll('button[data-mode]').forEach(x => x.classList.toggle('selected', x === b));
                        });
                        return b;
                    };
                    const bT = mkModeBtn('Move', 'translate');
                    const bR = mkModeBtn('Rotate', 'rotate');
                    bT.setAttribute('data-mode', 'translate');
                    bR.setAttribute('data-mode', 'rotate');
                    modes.appendChild(bT); modes.appendChild(bR);
                    // Default selected (fallback to translate if unrecognized or 'scale')
                    const defMode = inputEl.dataset.xformMode || 'translate';
                    ({ translate: bT, rotate: bR }[defMode] || bT).classList.add('selected');

                    // Numeric-like helper for inline TRS inputs
                    const numericPattern = /^-?\d*\.?\d*$/;
                    const isNumericLike = (value) => {
                        if (value === '' || value == null) return true;
                        return numericPattern.test(String(value));
                    };
                    const onFocusToggleType = (el) => {
                        try {
                            if (isNumericLike(el.value)) {
                                el.type = 'number';
                            } else {
                                el.type = 'text';
                            }
                        } catch (_) { }
                    };

                    // Helper to get current TRS from params safely
                    const getTRS = () => {
                        const v = this._pickInitialValue(key, def) || {};
                        return {
                            position: Array.isArray(v.position) ? v.position.slice(0, 3) : [0, 0, 0],
                            rotationEuler: Array.isArray(v.rotationEuler) ? v.rotationEuler.slice(0, 3) : [0, 0, 0],
                            scale: Array.isArray(v.scale) ? v.scale.slice(0, 3) : [1, 1, 1],
                        };
                    };
                    // Helper to set TRS in params and optionally update active gizmo target
                    const setTRS = (next, applyTarget = true) => {
                        this.params[key] = { position: next.position.slice(0,3), rotationEuler: next.rotationEuler.slice(0,3), scale: next.scale.slice(0,3) };
                        // update info
                        try { updateInfo(); } catch (_) {}
                        // update inputs
                        try {
                            const row = this._fieldsWrap.querySelector(`[data-key="${key}"]`);
                            const map = [
                                ['.tf-pos-x', next.position[0]],
                                ['.tf-pos-y', next.position[1]],
                                ['.tf-pos-z', next.position[2]],
                                ['.tf-rot-x', next.rotationEuler[0]],
                                ['.tf-rot-y', next.rotationEuler[1]],
                                ['.tf-rot-z', next.rotationEuler[2]],
                            ];
                            for (const [sel, val] of map) {
                                const el = row ? row.querySelector(sel) : null;
                                if (el) this._setInputValue(el, 'number', val);
                            }
                        } catch (_) {}
                        // update active gizmo target
                        if (applyTarget) {
                            try {
                                const s = genFeatureUI.__activeXform;
                                if (s && s.inputEl === inputEl && s.target) {
                                    const toNum = (v) => (typeof v === 'number' ? v : (isNumericLike(v) ? Number(v) : 0));
                                    s.target.position.set(toNum(next.position[0]), toNum(next.position[1]), toNum(next.position[2]));
                                    s.target.rotation.set(toNum(next.rotationEuler[0]), toNum(next.rotationEuler[1]), toNum(next.rotationEuler[2]));
                                }
                            } catch (_) { }
                        }
                    };

                    // Inline TRS input grid (Position/Rotation)
                    const grid = document.createElement('div');
                    grid.className = 'transform-grid';
                    const addRow = (labelTxt, clsPrefix, valuesArr) => {
                        const rowEl = document.createElement('div');
                        rowEl.className = 'transform-row';
                        const lab = document.createElement('div');
                        lab.className = 'transform-label';
                        lab.textContent = labelTxt;
                        const inputs = document.createElement('div');
                        inputs.className = 'transform-inputs';
                        const axes = ['x','y','z'];
                        for (let i = 0; i < 3; i++) {
                            const inp = document.createElement('input');
                            inp.className = 'input transform-input ' + `tf-${clsPrefix}-${axes[i]}`;
                            inp.type = 'number';
                            inp.step = 'any';
                            this._setInputValue(inp, 'number', valuesArr[i] ?? 0);
                            inp.addEventListener('focus', () => { onFocusToggleType(inp); this._stopActiveReferenceSelection(); });
                            inp.addEventListener('change', () => {
                                const cur = getTRS();
                                const val = inp.value;
                                if (clsPrefix === 'pos') cur.position[i] = val;
                                else cur.rotationEuler[i] = val;
                                setTRS(cur, true);
                                this._emitParamsChange(key, this.params[key]);
                            });
                            inputs.appendChild(inp);
                        }
                        rowEl.appendChild(lab);
                        rowEl.appendChild(inputs);
                        grid.appendChild(rowEl);
                    };
                    const curTRS = getTRS();
                    addRow('Position', 'pos', curTRS.position);
                    addRow('Rotation', 'rot', curTRS.rotationEuler);

                    // Reset button: zero out position and rotation
                    const resetBtn = document.createElement('button');
                    resetBtn.type = 'button';
                    resetBtn.className = 'btn btn-slim';
                    resetBtn.textContent = 'Reset';
                    resetBtn.title = 'Reset translation and rotation to 0';
                    resetBtn.addEventListener('click', () => {
                        const cur = getTRS();
                        const next = { position: [0,0,0], rotationEuler: [0,0,0], scale: cur.scale };
                        setTRS(next, true);
                        this._emitParamsChange(key, this.params[key]);
                    });
                    modes.appendChild(resetBtn);

                    const activate = () => this._activateTransformWidget({ inputEl, wrapEl: wrap, key, def });
                    btn.addEventListener('click', activate);

                    // Compose
                    wrap.appendChild(btn);
                    const details = document.createElement('div');
                    details.className = 'transform-details';
                    details.appendChild(modes);
                    details.appendChild(grid);
                    details.appendChild(info);
                    wrap.appendChild(details);
                    // Keep hidden input inside to aid traversal
                    wrap.appendChild(inputEl);
                    controlWrap.appendChild(wrap);
                    break;
                }

                case 'boolean_operation': {
                    // Ensure default object exists
                    if (!this.params[key] || typeof this.params[key] !== 'object') {
                        this.params[key] = { targets: [], operation: 'NONE', operation: 'NONE' };
                    } else {
                        if (!Array.isArray(this.params[key].targets)) this.params[key].targets = [];
                        if (!this.params[key].operation && !this.params[key].operation) this.params[key].operation = 'NONE';
                    }

                    const wrap = document.createElement('div');
                    wrap.className = 'bool-op-wrap';

                    // Operation dropdown
                    const sel = document.createElement('select');
                    sel.className = 'select';
                    sel.dataset.role = 'bool-op';
                    const ops = Array.isArray(def.options) && def.options.length ? def.options : ['NONE', 'UNION', 'SUBTRACT', 'INTERSECT'];
                    for (const op of ops) {
                        const opt = document.createElement('option');
                        opt.value = String(op);
                        opt.textContent = String(op);
                        sel.appendChild(opt);
                    }
                    sel.value = String((this.params[key].operation ?? this.params[key].operation) || 'NONE');
                    sel.addEventListener('change', () => {
                        if (!this.params[key] || typeof this.params[key] !== 'object') this.params[key] = { targets: [], operation: 'NONE' };
                        // Keep both keys in sync for backward compatibility
                        this.params[key].operation = sel.value;
                        this.params[key].operation = sel.value;
                        this._emitParamsChange(key, this.params[key]);
                    });
                    wrap.appendChild(sel);

                    // Target multi-select (solids)
                    const refWrap = document.createElement('div');
                    refWrap.className = 'ref-multi-wrap';
                    const chipsWrap = document.createElement('div');
                    chipsWrap.className = 'ref-chips';
                    refWrap.appendChild(chipsWrap);

                    const inputElTargets = document.createElement('input');
                    inputElTargets.type = 'text';
                    inputElTargets.className = 'input';
                    inputElTargets.dataset.multiple = 'true';
                    inputElTargets.placeholder = 'Click then select solids…';
                    // initialize chips
                    this._renderChips(chipsWrap, key, Array.isArray(this.params[key].targets) ? this.params[key].targets : []);

                    const activate = () => {
                        // Activate with SOLID-only selection filter
                        this._activateReferenceSelection(inputElTargets, { selectionFilter: ['SOLID'] });
                    };
                    chipsWrap.addEventListener('click', activate);
                    inputElTargets.addEventListener('click', activate);

                    // On change, parse incoming list and update targets
                    inputElTargets.addEventListener('change', () => {
                        // Handle force-clear (e.g., ESC from selection widget)
                        if (inputElTargets.dataset && inputElTargets.dataset.forceClear === 'true') {
                            if (!this.params[key] || typeof this.params[key] !== 'object') this.params[key] = { targets: [], operation: 'NONE' };
                            this.params[key].targets = [];
                            this._renderChips(chipsWrap, key, this.params[key].targets);
                            inputElTargets.value = '';
                            delete inputElTargets.dataset.forceClear;
                            this._emitParamsChange(key, this.params[key]);
                            return;
                        }
                        if (!this.params[key] || typeof this.params[key] !== 'object') this.params[key] = { targets: [], operation: 'NONE' };
                        let incoming = [];
                        try {
                            const parsed = JSON.parse(inputElTargets.value);
                            if (Array.isArray(parsed)) incoming = parsed;
                        } catch (_) {
                            if (inputElTargets.value && String(inputElTargets.value).trim() !== '') incoming = [String(inputElTargets.value).trim()];
                        }
                        // Merge unique into targets
                        const cur = Array.isArray(this.params[key].targets) ? this.params[key].targets : [];
                        for (const name of incoming) {
                            if (!cur.includes(name)) cur.push(name);
                        }
                        this.params[key].targets = cur;
                        this._renderChips(chipsWrap, key, cur);
                        inputElTargets.value = '';
                        this._emitParamsChange(key, this.params[key]);
                    });

                    refWrap.appendChild(inputElTargets);
                    wrap.appendChild(refWrap);

                    // No explicit bias UI; default applied in boolean helper

                    controlWrap.appendChild(wrap);
                    // Track the hidden input for refresh convenience
                    inputEl = inputElTargets;
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
                        // First: schema-defined actionFunction (universal button support)
                        let handled = false;
                        try {
                            if (def && typeof def.actionFunction === 'function') {
                                const ctx = {
                                    featureID: fid,
                                    key,
                                    viewer: this.options?.viewer || null,
                                    partHistory: this.options?.partHistory || null,
                                    feature: this.options?.featureRef || null,
                                    params: this.params,
                                    schemaDef: def,
                                };
                                const r = def.actionFunction(ctx);
                                // Treat non-undefined return as handled; otherwise assume handled too
                                handled = true;
                                void r;
                            }
                        } catch (_) { /* swallow to allow fallback */ }
                        // Backward-compatibility: delegate to onAction if not handled by schema
                        if (!handled) {
                            try { if (typeof this.options.onAction === 'function') this.options.onAction(fid, key); } catch (_) { }
                        }
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

            if (!inputEl.parentNode) controlWrap.appendChild(inputEl);
            row.appendChild(controlWrap);
            this._fieldsWrap.appendChild(row);
            this._inputs.set(key, inputEl);
        }
    }

    _cloneDefault(val) {
        if (val == null) return val;
        if (Array.isArray(val)) return val.map(v => this._cloneDefault(v));
        if (typeof val === 'object') {
            const proto = Object.getPrototypeOf(val);
            if (proto === Object.prototype || proto === null) {
                const out = {};
                for (const k of Object.keys(val)) out[k] = this._cloneDefault(val[k]);
                return out;
            }
        }
        return val;
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
                    try { el.style.filter = 'none'; } catch (_) { }
                    try { el.removeAttribute('active-reference-selection'); } catch (_) { }
                    try {
                        const wrap = el.closest('.ref-single-wrap, .ref-multi-wrap');
                        if (wrap) wrap.classList.remove('ref-active');
                    } catch (_) { }
                }
            });
        };
        clearLocal(this._shadow);

        // Mark this control active with a recency timestamp for any external scanners
        try { inputEl.dataset.activatedAt = String(Date.now()); } catch (_) { }
        inputEl.style.filter = 'invert(1)';
        inputEl.setAttribute('active-reference-selection', 'true');
        try {
            const wrap = inputEl.closest('.ref-single-wrap, .ref-multi-wrap');
            if (wrap) wrap.classList.add('ref-active');
        } catch (_) { }

        try { console.log('Setting selection types:', def.selectionFilter); } catch (_) { }
        SelectionFilter.stashAllowedSelectionTypes();
        SelectionFilter.SetSelectionTypes(def.selectionFilter);
    }

    // Activate a TransformControls session for a transform widget
    _activateTransformWidget({ inputEl, wrapEl, key, def }) {
        try { this._stopActiveReferenceSelection(); } catch (_) {}
        // Toggle logic: if already active for this input, stop and hide
        try {
            const s = genFeatureUI.__activeXform;
            if (s && s.inputEl === inputEl) {
                const currentVal = this.params[key];
                genFeatureUI.__stopGlobalActiveXform();
                this._emitParamsChange(key, currentVal);
                return;
            }
            // If a different transform is active, stop it before starting this one
            if (s && s.inputEl !== inputEl) {
                genFeatureUI.__stopGlobalActiveXform();
            }
        } catch (_) { }

        const viewer = this.options?.viewer || null;
        if (!viewer || !viewer.scene || !viewer.camera || !viewer.renderer) return;

        // (Toggle handled above)

        // Build or reuse target object from current param value
        const cur = this._pickInitialValue(key, def) || {};
        const p = Array.isArray(cur.position) ? cur.position : [0, 0, 0];
        const r = Array.isArray(cur.rotationEuler) ? cur.rotationEuler : [0, 0, 0];
        const s = Array.isArray(cur.scale) ? cur.scale : [1, 1, 1];

        const target = new THREE.Object3D();
        try {
            target.position.set(Number(p[0]||0), Number(p[1]||0), Number(p[2]||0));
            target.rotation.set(Number(r[0]||0), Number(r[1]||0), Number(r[2]||0));
            target.scale.set(Number(s[0]||1), Number(s[1]||1), Number(s[2]||1));
        } catch (_) { }
        viewer.scene.add(target);

        // Prefer the direct controls build; fallback to Addons
        let TCctor = TransformControlsDirect || TransformControlsAddons;
        try {
            if (!TCctor) TCctor = TransformControlsAddons;
        } catch (_) { /* no-op */ }
        if (!TCctor) {
            console.warn('[TransformControls] Not available from imports; skipping gizmo.');
            return;
        }
        const tc = new TCctor(viewer.camera, viewer.renderer.domElement);
        const desiredMode = (inputEl && inputEl.dataset && inputEl.dataset.xformMode) ? String(inputEl.dataset.xformMode) : 'translate';
        const safeMode = (desiredMode === 'scale') ? 'translate' : desiredMode;
        tc.setMode(safeMode);
        // Newer three.js TransformControls emit mouseDown/mouseUp instead of dragging-changed
        let __lastCommitAt = 0;
        const commitTransform = () => {
            const now = Date.now();
            if (now - __lastCommitAt < 5) return; // dedupe if two events fire together
            __lastCommitAt = now;
            try {
                const featureID = (this.params && Object.prototype.hasOwnProperty.call(this.params, 'featureID'))
                    ? this.params.featureID
                    : null;
                if (typeof this.options.onChange === 'function') {
                    this.options.onChange(featureID);
                }
            } catch (_) { }
            // After history re-runs (which clears the scene), re-add the gizmo and target so it stays active
            try {
                const addBack = () => {
                    try {
                        if (!viewer || !viewer.scene) return;
                        if (target && target.isObject3D) { try { viewer.scene.add(target); } catch (_) { } }
                        const helper = (typeof tc.getHelper === 'function') ? tc.getHelper() : null;
                        if (helper && helper.isObject3D) { try { viewer.scene.add(helper); tc.__helper = helper; } catch (_) { } }
                        else if (tc && tc.isObject3D) { try { viewer.scene.add(tc); } catch (_) { } }
                        else if (tc.__fallbackGroup && tc.__fallbackGroup.isObject3D) { try { viewer.scene.add(tc.__fallbackGroup); } catch (_) { } }
                        try { if (typeof tc.attach === 'function') tc.attach(target); } catch (_) { }
                        try {
                            const m = (typeof tc.getMode === 'function') ? tc.getMode() : (tc.mode || 'translate');
                            if (typeof tc.setMode === 'function') tc.setMode(m);
                        } catch (_) { }
                        try { viewer.render && viewer.render(); } catch (_) { }
                    } catch (_) { }
                };
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(addBack);
                else setTimeout(addBack, 0);
            } catch (_) { }
        };
        try { tc.addEventListener('mouseDown', () => { try { if (viewer.controls) viewer.controls.enabled = false; } catch (_) {} }); } catch (_) {}
        try { tc.addEventListener('mouseUp',   () => { try { if (viewer.controls) viewer.controls.enabled = true;  } catch (_) {} commitTransform(); }); } catch (_) {}
        // Backward/compat: older builds fire dragging-changed
        try { tc.addEventListener('dragging-changed', (ev) => { try { if (viewer.controls) viewer.controls.enabled = !ev.value; } catch (_) {} if (!ev.value) commitTransform(); }); } catch (_) {}

        const updateParamFromTarget = () => {
            const pos = [target.position.x, target.position.y, target.position.z];
            const rot = [target.rotation.x, target.rotation.y, target.rotation.z];
            const scl = [target.scale.x, target.scale.y, target.scale.z];
            const next = { position: pos, rotationEuler: rot, scale: scl };
            this.params[key] = next;
            try {
                // Update info line if present
                const row = this._fieldsWrap.querySelector(`[data-key="${key}"]`);
                const info = row ? row.querySelector('.transform-info') : null;
                if (info) {
                    const fmt = (n) => {
                        const x = Number(n);
                        if (!Number.isFinite(x)) return '0';
                        const a = Math.abs(x);
                        const prec = a >= 100 ? 0 : (a >= 10 ? 1 : 2);
                        return String(x.toFixed(prec));
                    };
                    info.textContent = `pos(${fmt(pos[0])}, ${fmt(pos[1])}, ${fmt(pos[2])})  rot(${fmt(rot[0])}, ${fmt(rot[1])}, ${fmt(rot[2])})`;
                }
                // Sync inline inputs if present
                try {
                    const pairs = [
                        ['.tf-pos-x', pos[0]],
                        ['.tf-pos-y', pos[1]],
                        ['.tf-pos-z', pos[2]],
                        ['.tf-rot-x', rot[0]],
                        ['.tf-rot-y', rot[1]],
                        ['.tf-rot-z', rot[2]],
                    ];
                    for (const [sel, val] of pairs) {
                        const el = row ? row.querySelector(sel) : null;
                        if (el) this._setInputValue(el, 'number', val);
                    }
                } catch (_) { }
            } catch (_) { }
        };
        tc.addEventListener('change', updateParamFromTarget);
        // Fallback commit for cases where mouseUp/dragging-changed are unreliable (some builds)
        try { tc.addEventListener('objectChange', () => { try { if (!tc.dragging) commitTransform(); } catch (_) {} }); } catch (_) {}

        // Expose an isOver helper for Viewer to suppress its own handlers when interacting with gizmo
        const isOver = (ev) => {
            try {
                const canvas = viewer.renderer.domElement;
                const rect = canvas.getBoundingClientRect();
                const x = (ev.clientX - rect.left) / rect.width; // 0..1
                const y = (ev.clientY - rect.top) / rect.height; // 0..1
                // Use viewer helper for consistent NDC mapping
                const ndc = (typeof viewer._getPointerNDC === 'function')
                    ? viewer._getPointerNDC({ clientX: ev.clientX, clientY: ev.clientY })
                    : new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
                viewer.raycaster.setFromCamera(ndc, viewer.camera);
                // Prefer precise picker meshes for the current mode; fallback to whole gizmo
                const mode = (typeof tc.getMode === 'function') ? tc.getMode() : (tc.mode || desiredMode || 'translate');
                const giz = tc._gizmo || tc.gizmo || null;
                const pick = (giz && giz.picker) ? (giz.picker[mode] || giz.picker.translate || giz.picker.rotate) : null;
                const pickRoot = pick || giz || tc.__fallbackGroup || null;
                if (!pickRoot) return false;
                const hits = viewer.raycaster.intersectObject(pickRoot, true) || [];
                return hits.length > 0;
            } catch (_) { return false; }
        };
        try { window.__BREP_activeXform = { controls: tc, viewer, isOver }; } catch (_) { }

        let addedToScene = false;
        try {
            // Preferred modern API: helper root on the controls
            const helper = (typeof tc.getHelper === 'function') ? tc.getHelper() : null;
            if (helper && helper.isObject3D) {
                try { helper.userData = helper.userData || {}; helper.userData.excludeFromFit = true; } catch (_) {}
                viewer.scene.add(helper); addedToScene = true; tc.__helper = helper;
            }
            else if (tc && tc.isObject3D) {
                try { tc.userData = tc.userData || {}; tc.userData.excludeFromFit = true; } catch (_) {}
                viewer.scene.add(tc); addedToScene = true;
            }
        } catch (_) { /* tolerate builds where controls aren't Object3D */ }
        if (!addedToScene) {
            // Fallback: try adding known internal object3D parts if present
            try {
                const group = new THREE.Group();
                group.name = 'TransformControlsGroup';
                const candidates = [tc?.gizmo, tc?._gizmo, tc?.picker, tc?._picker, tc?.helper, tc?._helper];
                let attached = 0;
                for (const cand of candidates) {
                    if (cand && cand.isObject3D) { try { group.add(cand); attached++; } catch (_) {} }
                }
                if (attached > 0) {
                    try { group.userData = group.userData || {}; group.userData.excludeFromFit = true; } catch (_) {}
                    viewer.scene.add(group); addedToScene = true; tc.__fallbackGroup = group;
                }
            } catch (_) { /* ignore */ }
            if (!addedToScene) {
                // eslint-disable-next-line no-console
                console.warn('[TransformControls] Could not add gizmo to scene (no Object3D found).');
            }
        }
        try { tc.showX = true; tc.showY = true; tc.showZ = true; } catch (_) { }
        try { tc.setSpace('world'); } catch (_) { }
        try { tc.addEventListener('change', () => { try { viewer.render(); } catch (_) {} }); } catch (_) { }
        try { tc.attach(target); } catch (_) { }

        // Mark active
        inputEl.setAttribute('active-transform', 'true');
        try { wrapEl.classList.add('ref-active'); } catch (_) { }

        genFeatureUI.__activeXform = {
            owner: this,
            key,
            inputEl,
            wrapEl,
            target,
            controls: tc,
            viewer,
            group: tc.__fallbackGroup || (tc && tc.isObject3D ? tc : null),
            captureHandlers: null,
        };

        // Install capture-phase listeners to disable ArcballControls early when pressing gizmo
        try {
            const canvas = viewer && viewer.renderer ? viewer.renderer.domElement : null;
            if (canvas && typeof canvas.addEventListener === 'function') {
                const onDownCapture = (ev) => {
                    try {
                        if (isOver(ev)) {
                            if (viewer && viewer.controls) viewer.controls.enabled = false;
                        }
                    } catch (_) { }
                };
                const onUpCapture = (ev) => {
                    // Re-enable controls on pointer release to be safe
                    try { if (viewer && viewer.controls) viewer.controls.enabled = true; } catch (_) { }
                    void ev;
                };
                canvas.addEventListener('pointerdown', onDownCapture, { passive: true, capture: true });
                // Use window to ensure we catch release even if released off-canvas
                window.addEventListener('pointerup', onUpCapture, { passive: true, capture: true });
                genFeatureUI.__activeXform.captureHandlers = { canvas, win: window, onDownCapture, onUpCapture };
            }
        } catch (_) { /* ignore */ }
    }

    _stopActiveTransformWidget() {
        try { genFeatureUI.__stopGlobalActiveXform(); } catch (_) { }
    }


    _stopActiveReferenceSelection() {
        // Clear global active if it belongs to this instance
        try {
            if (genFeatureUI.__activeRefInput) {
                try { genFeatureUI.__activeRefInput.style.filter = 'none'; } catch (_) { }
                try { genFeatureUI.__activeRefInput.removeAttribute('active-reference-selection'); } catch (_) { }
                try {
                    const wrap = genFeatureUI.__activeRefInput.closest('.ref-single-wrap, .ref-multi-wrap');
                    if (wrap) wrap.classList.remove('ref-active');
                } catch (_) { }
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
                // Support both plain array params and object-with-targets
                let currentArrayRef = null;
                if (Array.isArray(this.params[key])) {
                    currentArrayRef = this.params[key];
                } else if (this.params[key] && typeof this.params[key] === 'object' && Array.isArray(this.params[key].targets)) {
                    currentArrayRef = this.params[key].targets;
                } else {
                    // Initialize as array if nothing sensible exists
                    this.params[key] = [];
                    currentArrayRef = this.params[key];
                }
                const idx = currentArrayRef.indexOf(name);
                if (idx >= 0) currentArrayRef.splice(idx, 1);
                this._renderChips(chipsWrap, key, currentArrayRef);
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
        // Suppress auto-run if a transform editing session is active on this form
        try {
            const s = genFeatureUI.__activeXform;
            if (s && s.owner === this) return;
        } catch (_) { }
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
            case 'transform': return { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] };
            default: return '';
        }
    }

    _setInputValue(el, type, value) {
        switch (type) {
            case 'boolean':
                el.checked = Boolean(value);
                break;
            case 'number': {
                // Accept formulas or plain numbers. If the value is not purely numeric,
                // render the input as text so the expression is visible.
                const str = value == null ? '' : String(value);
                const numericLike = /^\s*[-+]?((\d+(?:\.\d*)?)|(\.\d+))(?:[eE][-+]?\d+)?\s*$/.test(str);
                try {
                    if (numericLike) {
                        if (el.type !== 'number') el.type = 'number';
                        // Re-apply numeric attributes if we previously toggled away
                        if (el.dataset && el.dataset.step) el.step = el.dataset.step;
                        if (el.dataset && el.dataset.min) el.min = el.dataset.min;
                        if (el.dataset && el.dataset.max) el.max = el.dataset.max;
                    } else {
                        if (el.type !== 'text') el.type = 'text';
                    }
                } catch (_) { /* ignore */ }
                el.value = str;
                break;
            }
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
      .btn.btn-slim { padding: 6px 10px; border-radius: 8px; font-size: 12px; }
      .btn.selected { border-color: var(--focus); color: #fff; }
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
      /* Single reference display (replaces textbox) */
      .ref-single-wrap { display: block; }
      .ref-single-display {
        appearance: none;
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 10px;
        outline: none;
        cursor: pointer;
        user-select: none;
        min-height: 36px;
        display: flex;
        align-items: center;
      }
      /* Active highlight for ref widgets */
      .ref-single-wrap.ref-active .ref-single-display,
      .ref-multi-wrap.ref-active .ref-chips {
        border-color: var(--focus);
        box-shadow: 0 0 0 3px rgba(59,130,246,.15);
      }
      /* Multi reference chips */
      .ref-multi-wrap { display: flex; flex-direction: column; gap: 6px; }
      .ref-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px; border: 1px dashed var(--border); border-radius: 10px; cursor: pointer; background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01)); max-width: 100%; }
      .ref-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; background: #1a2030; border: 1px solid var(--border); font-size: 12px; max-width: 100%; }
      .ref-chip-label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; word-break: break-word; white-space: normal; }
      .ref-chip-remove { color: var(--muted); cursor: pointer; flex: 0 0 auto; }
      .ref-chip-remove:hover { color: var(--danger); }

      /* Transform widget */
      .transform-wrap { display: flex; flex-direction: column; gap: 8px; }
      .transform-modes { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .transform-info { font-size: 12px; color: var(--muted); }
      .transform-details { display: none; }
      .transform-wrap.ref-active .transform-details { display: block; }
      .transform-grid { display: flex; flex-direction: column; gap: 6px; }
      .transform-row { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 8px; }
      .transform-label { color: var(--muted); font-size: 12px; }
      .transform-inputs { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 6px; }
      .transform-input { padding: 6px 8px; }
      .transform-wrap.ref-active .btn { border-color: var(--focus); box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
    `;
        return style;
    }
}
