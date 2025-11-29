import { SelectionFilter } from './SelectionFilter.js';
import { HistoryCollectionWidget } from './history/HistoryCollectionWidget.js';

const FALLBACK_INTERVAL_MS = 200;

export class HistoryWidget extends HistoryCollectionWidget {
  constructor(viewer) {
    const partHistory = viewer?.partHistory || null;
    super({ history: partHistory, viewer });
    this.viewer = viewer || null;
    this.partHistory = partHistory || null;

    // Override configurable hooks from the base widget after super() so they can access `this`.
    this._autoSyncOpenState = true;
    this._determineExpanded = (entry) => this.#shouldExpandEntry(entry);
    this._formOptionsProvider = (context) => this.#buildFormOptions(context);
    this._decorateEntryHeader = (context) => this.#decorateEntryHeader(context);
    this._buildEntryControls = null; // stick with defaults; override move/delete behaviours directly.
    this._onEntryToggle = (entry, isOpen) => this.#handleEntryToggle(entry, isOpen);
    this._onFormReady = (payload) => this.#handleFormReady(payload);
    this._createEntryFunc = (type) => this.#createFeatureEntry(type);
    this.onEntryChange = (payload) => this.#handleEntryChange(payload);

    this._metaEls = new Map();
    this._itemEls = new Map();
    this._paramSignatures = new Map();
    this._idsSignature = this.#computeIdsSignature();
    this._rafHandle = null;
    this._rafIsTimeout = false;
    this._runPromise = null;

    this.uiElement.classList.add('history-widget');
    this.render();
    this.#startAutoSyncLoop();
    this.#patchRunHistory();
  }

  dispose() {
    this.#stopAutoSyncLoop();
    super.dispose();
  }

  render() {
    if (!this._metaEls) this._metaEls = new Map();
    if (!this._itemEls) this._itemEls = new Map();
    if (!this._paramSignatures) this._paramSignatures = new Map();
    this._metaEls.clear();
    this._itemEls.clear();
    super.render();
    this._syncHeaderState();
  }

  async _moveEntry(id, delta) {
    const entryInfo = this.#findEntryInfo(id);
    if (!entryInfo) return;
    super._moveEntry(id, delta);
    this._idsSignature = this.#computeIdsSignature();
    const feature = entryInfo.entry;
    if (feature) {
      feature.lastRunInputParams = null;
      const featureId = this.#entryId(feature);
      if (featureId) this.#setCurrentHistoryStep(featureId);
    }
    this.#safeRunHistory();
  }

  _deleteEntry(id) {
    const entryInfo = this.#findEntryInfo(id);
    super._deleteEntry(id);
    const featureId = entryInfo ? this.#entryId(entryInfo.entry) : null;
    if (featureId && this.partHistory && this.partHistory.currentHistoryStepId === featureId) {
      this.partHistory.currentHistoryStepId = null;
    }
    this._idsSignature = this.#computeIdsSignature();
    this.#safeRunHistory();
  }

  _refreshAddMenu() {
    if (!this._addMenu || !this._addBtn) return;
    const registry = this._getFeatureRegistry();
    const features = Array.isArray(registry?.features) ? registry.features : [];
    this._addMenu.textContent = '';
    if (!features.length) {
      this._addBtn.disabled = true;
      const empty = document.createElement('div');
      empty.className = 'hc-menu-empty';
      empty.textContent = 'No features registered';
      this._addMenu.appendChild(empty);
      return;
    }
    const items = [];
    for (const FC of features) {
      if (!FC) continue;
      const names = this._extractDisplayNames(
        FC,
        FC?.shortName || FC?.name || 'Feature',
        FC?.longName || FC?.name || 'Feature',
      );
      const label = names.longName || names.shortName || 'Feature';
      const value = FC?.shortName || FC?.type || FC?.name || names.shortName || label;
      const item = this._composeMenuItem(value, label, FC);
      if (item) items.push(item);
    }
    if (!items.length) {
      this._addBtn.disabled = true;
      const empty = document.createElement('div');
      empty.className = 'hc-menu-empty';
      empty.textContent = 'No features registered';
      this._addMenu.appendChild(empty);
      return;
    }
    this._addBtn.disabled = false;
    for (const { type, text } of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hc-menu-item';
      btn.textContent = text;
      btn.dataset.type = type;
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const targetType = ev?.currentTarget?.dataset?.type || type;
        try {
          await this._handleAddEntry(targetType);
        } finally {
          this._toggleAddMenu(false);
        }
      });
      this._addMenu.appendChild(btn);
    }
  }

  _resolveSchema(entry) {
    const FeatureClass = this._resolveFeatureClass(entry?.type);
    return FeatureClass?.inputParamsSchema || null;
  }

  #findEntryInfo(id) {
    if (id == null) return null;
    const entries = this._getEntries();
    const stringId = String(id);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const entryId = this._extractEntryId(entry, i);
      if (entryId === stringId) {
        return { entry, index: i };
      }
    }
    return null;
  }

  #startAutoSyncLoop() {
    const useRaf = typeof requestAnimationFrame === 'function';
    this._rafIsTimeout = !useRaf;
    const tick = () => {
      const sig = this.#computeIdsSignature();
      if (sig !== this._idsSignature) {
        this._idsSignature = sig;
        this.render();
      } else {
        this.#refreshOpenForms();
        this._syncHeaderState();
        this.#ensureCurrentExpanded();
      }
      if (useRaf) this._rafHandle = requestAnimationFrame(tick);
      else this._rafHandle = setTimeout(tick, FALLBACK_INTERVAL_MS);
    };
    tick();
  }

  #stopAutoSyncLoop() {
    if (this._rafHandle == null) return;
    if (this._rafIsTimeout) clearTimeout(this._rafHandle);
    else if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._rafHandle);
    this._rafHandle = null;
  }

  #patchRunHistory() {
    const ph = this.partHistory;
    if (!ph || typeof ph.runHistory !== 'function' || ph.__historyWidgetPatched) return;
    const original = ph.runHistory.bind(ph);
    ph.runHistory = async (...args) => {
      const res = await original(...args);
      this.#afterPartHistoryMutated();
      return res;
    };
    ph.__historyWidgetPatched = true;
  }

  #afterPartHistoryMutated() {
    this._idsSignature = this.#computeIdsSignature();
    this._syncHeaderState();
    this.#refreshOpenForms();
    try { this.viewer?._refreshAssemblyConstraintsPanelVisibility?.(); } catch { /* ignore */ }
  }

  async #createFeatureEntry(typeStr) {
    const ph = this.partHistory;
    if (!ph || typeof ph.newFeature !== 'function') return null;
    try {
      const feature = await ph.newFeature(typeStr);
      const newId = this.#entryId(feature);
      if (newId) this.#setCurrentHistoryStep(newId);
      await this.#safeRunHistory();
      this._idsSignature = this.#computeIdsSignature();
      return feature;
    } catch (error) {
      console.warn('[HistoryWidget] Failed to create feature:', error);
      return null;
    }
  }

  #shouldExpandEntry(entry) {
    const target = this.partHistory?.currentHistoryStepId;
    if (!target) return false;
    const id = this.#entryId(entry);
    if (id == null || String(id) !== String(target)) return false;
    const runtimeOpen = entry?.runtimeAttributes?.__open;
    const paramOpen = entry?.inputParams?.__open;
    if (runtimeOpen === false || paramOpen === false) return false;
    return true;
  }

  #handleEntryToggle(entry, isOpen) {
    if (!this.partHistory) return;
    const id = this.#entryId(entry);
    if (!id) return;
    if (isOpen) {
      this.#setCurrentHistoryStep(id);
    } else {
      if (String(this.partHistory.currentHistoryStepId) === String(id)) {
        this.partHistory.currentHistoryStepId = null;
      }
    }
    this.#safeRunHistory();
  }

  #handleEntryChange({ entry }) {
    const id = this.#entryId(entry);
    if (id) this.#setCurrentHistoryStep(id);
    this.#safeRunHistory();
  }

  #handleFormReady({ id, entry }) {
    if (!id || !entry) return;
    this._paramSignatures.set(String(id), this.#computeParamsSig(entry.inputParams));
  }

  #buildFormOptions(context = {}) {
    const entry = context?.entry || null;
    const featureId = this.#entryId(entry);
    return {
      onChange: () => {
        if (featureId) this.#setCurrentHistoryStep(featureId);
      },
      onAction: (_id, actionKey) => this.#handleFormAction(featureId, actionKey),
      onReferenceChipRemove: (name) => this.#handleReferenceChipRemove(name),
      scene: this.viewer?.scene || null,
      viewer: this.viewer || null,
      partHistory: this.partHistory || null,
      featureRef: entry || null,
    };
  }

  #handleFormAction(featureID, actionKey) {
    if (!actionKey || !this.viewer) return;
    try {
      if (actionKey === 'editSketch' && typeof this.viewer.startSketchMode === 'function') {
        this.viewer.startSketchMode(featureID);
      } else if (actionKey === 'editSpline' && typeof this.viewer.startSplineMode === 'function') {
        this.viewer.startSplineMode(featureID);
      }
    } catch {
      /* ignore */
    }
  }

  #handleReferenceChipRemove(name) {
    if (!name) return;
    try {
      const scene = this.viewer?.scene || null;
      if (scene) SelectionFilter.deselectItem(scene, name);
    } catch {
      /* ignore */
    }
  }

  #decorateEntryHeader(context = {}) {
    const id = context?.id != null ? String(context.id) : null;
    const entry = context?.entry || null;
    const elements = context?.elements || {};
    const titleEl = elements.titleEl || null;
    const metaEl = elements.metaEl || null;
    const item = elements.item || null;
    if (titleEl) titleEl.textContent = this.#composeTitle(entry);
    if (metaEl) {
      metaEl.textContent = this.#composeStatus(entry);
      if (id) this._metaEls.set(id, metaEl);
    }
    if (item && id) {
      item.classList.toggle('has-error', this.#hasError(entry));
      this._itemEls.set(id, item);
    }
    this.#decorateMissingFeaturePanel(entry, context);
  }

  #decorateMissingFeaturePanel(entry, context = {}) {
    if (!context.isOpen) return;
    const FeatureClass = this._resolveFeatureClass(entry?.type);
    if (FeatureClass) return;
    const body = context.elements?.bodyEl;
    if (!body) return;
    body.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'missing-feature-panel';
    const msg = document.createElement('div');
    msg.className = 'missing-msg';
    msg.textContent = `Feature type "${entry?.type || ''}" is not available. Remove it or install a plugin that provides it.`;
    wrap.appendChild(msg);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'hc-btn danger';
    removeBtn.textContent = 'Remove from history';
    removeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._deleteEntry(context.id);
    });
    wrap.appendChild(removeBtn);
    body.appendChild(wrap);
  }

  _syncHeaderState() {
    const features = this._collectFeatureMap();
    for (const [id, metaEl] of this._metaEls) {
      const feature = features.get(id);
      if (!feature || !metaEl) continue;
      metaEl.textContent = this.#composeStatus(feature);
      const item = this._itemEls.get(id);
      if (item) item.classList.toggle('has-error', this.#hasError(feature));
    }
  }

  _collectFeatureMap() {
    const map = new Map();
    const entries = this._getEntries();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const id = this._extractEntryId(entry, i);
      if (id != null) map.set(String(id), entry);
    }
    return map;
  }

  #refreshOpenForms() {
    const entries = this._getEntries();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const id = this._extractEntryId(entry, i);
      if (id == null) continue;
      const form = this.getFormForEntry(id);
      if (!form) continue;
      const sig = this.#computeParamsSig(entry?.inputParams);
      if (this._paramSignatures.get(id) === sig) continue;
      this._paramSignatures.set(id, sig);
      try { form.refreshFromParams?.(); } catch { /* ignore */ }
    }
  }

  #ensureCurrentExpanded() {
    const ph = this.partHistory;
    if (!ph) return;
    const target = ph.currentHistoryStepId;
    if (!target) return;
    if (this._expandedId && String(this._expandedId) === String(target)) return;
    const entries = this._getEntries();
    const exists = entries.some((entry, idx) => this._extractEntryId(entry, idx) === String(target));
    if (!exists) return;
    this._expandedId = String(target);
    this.render();
  }

  #hasError(entry) {
    if (!entry) return false;
    const missing = !this._resolveFeatureClass(entry.type);
    const failed = entry?.lastRun?.ok === false;
    return missing || failed;
  }

  #composeTitle(entry) {
    const type = entry?.type || 'Feature';
    const id = this.#entryId(entry) ?? '—';
    return `${type} — #${id}`;
  }

  #composeStatus(entry) {
    if (!entry) return '';
    const parts = [];
    const duration = entry?.lastRun?.durationMs;
    if (Number.isFinite(duration)) parts.push(this.#formatDuration(duration));
    if (entry?.lastRun && entry.lastRun.ok === false) parts.push('✖');
    return parts.join(' ');
  }

  #formatDuration(ms) {
    if (!Number.isFinite(ms)) return '';
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
    return `${Math.round(ms)} ms`;
  }

  #computeIdsSignature() {
    const features = this._getEntries();
    return features
      .map((entry, idx) => this._extractEntryId(entry, idx))
      .filter((id) => id != null)
      .join('|');
  }

  #computeParamsSig(params) {
    if (!params || typeof params !== 'object') return '';
    const keys = Object.keys(params).filter((k) => k !== 'featureID' && k !== 'id').sort();
    const parts = [];
    for (const key of keys) {
      const value = params[key];
      if (value == null) parts.push(`${key}:null`);
      else if (typeof value === 'object' || typeof value === 'function') parts.push(`${key}:[obj]`);
      else parts.push(`${key}:${String(value)}`);
    }
    return parts.join('|');
  }

  #entryId(entry) {
    if (!entry) return null;
    const params = entry.inputParams || {};
    if (params.id != null) return String(params.id);
    if (params.featureID != null) return String(params.featureID);
    if (params.id != null) return String(params.id);
    if (entry.id != null) return String(entry.id);
    return null;
  }

  #setCurrentHistoryStep(id) {
    if (!this.partHistory) return;
    this.partHistory.currentHistoryStepId = id != null ? String(id) : null;
  }

  #safeRunHistory() {
    if (!this.partHistory || typeof this.partHistory.runHistory !== 'function') {
      return Promise.resolve();
    }
    const previous = this._runPromise || Promise.resolve();
    const next = previous.then(async () => {
      try {
        await this.partHistory.runHistory();
      } catch (error) {
        console.warn('[HistoryWidget] runHistory failed:', error);
      }
    });
    this._runPromise = next.catch((error) => {
      console.warn('[HistoryWidget] runHistory sequence failed:', error);
    });
    return this._runPromise;
  }

  _getFeatureRegistry() {
    return this.partHistory?.featureRegistry || null;
  }

  _resolveFeatureClass(type) {
    if (!type) return null;
    const registry = this._getFeatureRegistry();
    if (!registry) return null;
    try {
      return registry.getSafe?.(type) || registry.get?.(type) || null;
    } catch {
      return null;
    }
  }
}
