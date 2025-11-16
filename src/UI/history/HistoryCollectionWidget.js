import { SchemaForm } from '../featureDialogs.js';
import { HISTORY_COLLECTION_WIDGET_CSS } from './historyCollectionWidget.css.js';

const noop = () => {};

/**
 * Generic collection widget that renders HistoryCollectionBase-like lists using SchemaForm.
 * Supports optional hooks for form customization, expansion state, and toggle notifications.
 */
export class HistoryCollectionWidget {
  constructor({
    history = null,
    viewer = null,
    onEntryChange = null,
    onCollectionChange = null,
    formOptions = null,
    determineInitialExpanded = null,
    onEntryToggle = null,
    onFormReady = null,
    autoSyncOpenState = false,
    createEntry = null,
  } = {}) {
    this.history = null;
    this.viewer = viewer || null;
    this.onEntryChange = typeof onEntryChange === 'function' ? onEntryChange : noop;
    this.onCollectionChange = typeof onCollectionChange === 'function' ? onCollectionChange : noop;
    this._formOptionsProvider = typeof formOptions === 'function' ? formOptions : null;
    this._determineExpanded = typeof determineInitialExpanded === 'function' ? determineInitialExpanded : null;
    this._onEntryToggle = typeof onEntryToggle === 'function' ? onEntryToggle : null;
    this._onFormReady = typeof onFormReady === 'function' ? onFormReady : null;
    this._autoSyncOpenState = Boolean(autoSyncOpenState);
    this._createEntryFunc = typeof createEntry === 'function' ? createEntry : null;

    this.uiElement = document.createElement('div');
    this.uiElement.className = 'history-collection-widget-host';
    this._shadow = this.uiElement.attachShadow({ mode: 'open' });
    this._shadow.appendChild(this._makeStyle());

    this._container = document.createElement('div');
    this._container.className = 'hc-widget';
    this._shadow.appendChild(this._container);

    this._listEl = document.createElement('div');
    this._listEl.className = 'hc-list';
    this._container.appendChild(this._listEl);

    this._footer = this._buildFooter();
    this._container.appendChild(this._footer);

    this._expandedId = null;
    this._titleEls = new Map();
    this._forms = new Map();
    this._boundHistoryListener = null;
    this._listenerUnsub = null;
    this._suppressHistoryListener = false;

    if (history) this.setHistory(history);
  }

  dispose() {
    if (typeof this._listenerUnsub === 'function') {
      try { this._listenerUnsub(); } catch (_) {}
    }
    this._listenerUnsub = null;
    this._boundHistoryListener = null;
    this._expandedId = null;
    this._titleEls.clear();
    this._forms.clear();
  }

  setHistory(history) {
    if (history === this.history) {
      this.render();
      return;
    }
    if (typeof this._listenerUnsub === 'function') {
      try { this._listenerUnsub(); } catch (_) {}
    }
    this._listenerUnsub = null;
    this._boundHistoryListener = null;
    this.history = history || null;
    if (this.history) this._subscribeToHistory(this.history);
    this._expandedId = null;
    this.render();
  }

  render() {
    this._refreshAddMenu();
    this._titleEls.clear();
    this._forms.clear();
    const entries = this._getEntries();
    this._listEl.textContent = '';

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'hc-empty';
      empty.textContent = 'No entries yet.';
      this._listEl.appendChild(empty);
      return;
    }

    const determineExpanded = this._determineExpanded || (this._autoSyncOpenState ? this._defaultDetermineExpanded.bind(this) : null);
    const entryIds = entries.map((entry, index) => this._extractEntryId(entry, index));
    const validIds = new Set(entryIds);
    let targetId = (this._expandedId && validIds.has(this._expandedId)) ? this._expandedId : null;

    if (determineExpanded) {
      let determinedId = null;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        try {
          const shouldOpen = !!determineExpanded(entry, i);
          if (shouldOpen) {
            determinedId = entryIds[i];
            break;
          }
        } catch (_) { /* ignore */ }
      }
      if (determinedId != null) {
        targetId = determinedId;
      }
    }

    if (targetId && !validIds.has(targetId)) {
      targetId = null;
    }
    this._expandedId = targetId;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const id = entryIds[i];
      const itemEl = this._renderEntry(entry, id, i, targetId === id);
      this._listEl.appendChild(itemEl);
    }
  }

  getFormForEntry(id) {
    return this._forms.get(String(id)) || null;
  }

  _getEntries() {
    if (!this.history) return [];
    if (Array.isArray(this.history.entries)) return this.history.entries;
    if (Array.isArray(this.history.features)) return this.history.features;
    return [];
  }

  _findEntryInfoById(targetId) {
    if (targetId == null) return null;
    const id = String(targetId);
    const entries = this._getEntries();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (this._extractEntryId(entry, i) === id) {
        return { entry, index: i };
      }
    }
    return null;
  }

  _extractEntryId(entry, index) {
    if (entry && entry.id != null) return String(entry.id);
    const params = entry && entry.inputParams ? entry.inputParams : null;
    if (params && params.id != null) return String(params.id);
    if (params && params.featureID != null) return String(params.featureID);
    return `entry-${index}`;
  }

  _guessEntryLabel(entry, index) {
    const params = entry && entry.inputParams ? entry.inputParams : {};
    const primary =
      entry?.title ||
      params.name ||
      params.label ||
      params.title ||
      entry?.constructor?.longName ||
      entry?.constructor?.shortName ||
      entry?.type ||
      entry?.entityType ||
      `Entry ${index + 1}`;
    return String(primary);
  }

  _guessTypeLabel(entry) {
    return (
      entry?.type ||
      entry?.entityType ||
      entry?.constructor?.shortName ||
      entry?.constructor?.name ||
      ''
    );
  }

  _renderEntry(entry, id, index, isOpen = false) {
    const item = document.createElement('div');
    item.className = 'hc-item';
    item.dataset.entryId = id;
    if (isOpen) item.classList.add('open');

    const headerRow = document.createElement('div');
    headerRow.className = 'hc-header-row';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'hc-toggle';
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    toggle.addEventListener('click', () => { this._toggleEntry(id); });

    const title = document.createElement('span');
    title.className = 'hc-title';
    title.textContent = this._guessEntryLabel(entry, index);
    this._titleEls.set(id, title);
    toggle.appendChild(title);

    const badge = document.createElement('span');
    badge.className = 'hc-type';
    badge.textContent = this._guessTypeLabel(entry);
    toggle.appendChild(badge);

    headerRow.appendChild(toggle);

    const controls = document.createElement('div');
    controls.className = 'hc-controls';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'hc-btn';
    upBtn.title = 'Move up';
    upBtn.textContent = '↑';
    if (index === 0) upBtn.disabled = true;
    upBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._moveEntry(id, -1);
    });
    controls.appendChild(upBtn);

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'hc-btn';
    downBtn.title = 'Move down';
    downBtn.textContent = '↓';
    if (index === this._getEntries().length - 1) downBtn.disabled = true;
    downBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._moveEntry(id, 1);
    });
    controls.appendChild(downBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'hc-btn danger';
    delBtn.title = 'Delete';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._deleteEntry(id);
    });
    controls.appendChild(delBtn);

    headerRow.appendChild(controls);
    item.appendChild(headerRow);

    const body = document.createElement('div');
    body.className = 'hc-body';
    body.hidden = !isOpen;

    if (isOpen) {
      const schema = this._resolveSchema(entry);
      if (!schema) {
        const missing = document.createElement('div');
        missing.className = 'hc-missing';
        missing.textContent = `No schema available for "${this._guessTypeLabel(entry) || 'entity'}".`;
        body.appendChild(missing);
      } else {
        const params = entry && entry.inputParams ? entry.inputParams : {};
        const contextInfo = {
          entry,
          id,
          index,
          schema,
          params,
        };
        let formRef = null;
        const options = this._composeFormOptions(contextInfo, () => formRef);

        if (!Object.prototype.hasOwnProperty.call(options, 'viewer')) {
          options.viewer = this.viewer || null;
        }
        if (!Object.prototype.hasOwnProperty.call(options, 'scene')) {
          options.scene = this.viewer && this.viewer.scene ? this.viewer.scene : null;
        }
        if (!Object.prototype.hasOwnProperty.call(options, 'partHistory')) {
          options.partHistory = this.history || null;
        }

        const form = new SchemaForm(schema, params, options);
        formRef = form;
        body.appendChild(form.uiElement);
        this._forms.set(String(id), form);
        if (this._onFormReady) {
          try { this._onFormReady({ id, index, entry, form }); } catch (_) { /* ignore */ }
        }
      }
    }

    item.appendChild(body);
    return item;
  }

  _toggleEntry(id) {
    if (id == null) return;
    const targetId = String(id);
    const currentId = this._expandedId;
    const targetInfo = this._findEntryInfoById(targetId);
    const targetEntry = targetInfo?.entry || null;

    if (currentId === targetId) {
      if (this._autoSyncOpenState && targetEntry) {
        this._applyOpenState(targetEntry, false);
      }
      this._expandedId = null;
      this.render();
      this._notifyEntryToggle(targetEntry, false);
      return;
    }

    const previousInfo = currentId ? this._findEntryInfoById(currentId) : null;
    if (this._autoSyncOpenState) {
      if (previousInfo?.entry) this._applyOpenState(previousInfo.entry, false);
      if (targetEntry) this._applyOpenState(targetEntry, true);
    }
    this._expandedId = targetEntry ? targetId : null;
    this.render();
    if (previousInfo?.entry) this._notifyEntryToggle(previousInfo.entry, false);
    if (targetEntry) this._notifyEntryToggle(targetEntry, true);
  }

  _notifyEntryToggle(entry, isOpen) {
    if (!this._onEntryToggle) return;
    try {
      this._onEntryToggle(entry || null, isOpen);
    } catch (_) { /* ignore toggle hook errors */ }
  }

  async _moveEntry(id, delta) {
    if (!id) return;
    const entries = this._getEntries();
    const idx = entries.findIndex((entry, i) => this._extractEntryId(entry, i) === id);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= entries.length) return;
    const [entry] = entries.splice(idx, 1);
    entries.splice(target, 0, entry);
    if (id != null) this._expandedId = String(id);
    this.render();
    this._emitCollectionChange('reorder', entry);
  }

  _deleteEntry(id) {
    if (!id) return;
    const entries = this._getEntries();
    const idx = entries.findIndex((entry, i) => this._extractEntryId(entry, i) === id);
    if (idx < 0) return;
    const [removed] = entries.splice(idx, 1);
    if (this._expandedId && String(id) === this._expandedId) {
      this._expandedId = null;
    }
    this._forms.delete(String(id));
    if (this._autoSyncOpenState && removed) {
      this._applyOpenState(removed, false);
    }
    this.render();
    this._emitCollectionChange('remove', removed);
  }

  async _handleAddEntry(typeStr) {
    if (!typeStr) return;
    if (typeof this._createEntryFunc === 'function') {
      let entry = null;
      try {
        entry = await this._createEntryFunc(typeStr);
      } catch (error) {
        console.warn('[HistoryCollectionWidget] Failed to create entry:', error);
        return;
      }
      if (!entry) return;
      try {
        const entries = this._getEntries();
        const idx = entries.indexOf(entry);
        const id = this._extractEntryId(entry, idx >= 0 ? idx : entries.length - 1);
        if (id != null) {
          const normalizedId = String(id);
          const previousId = this._expandedId;
          if (this._autoSyncOpenState && previousId && previousId !== normalizedId) {
            const prevInfo = this._findEntryInfoById(previousId);
            if (prevInfo?.entry) this._applyOpenState(prevInfo.entry, false);
          }
          if (this._autoSyncOpenState) this._applyOpenState(entry, true);
          this._expandedId = normalizedId;
        }
      } catch (_) { /* ignore */ }
      this.render();
      this._emitCollectionChange('add', entry);
      return;
    }
    const entry = await this._instantiateEntryForType(typeStr);
    if (!entry) return;
    const entries = this._getEntries();
    entries.push(entry);
    const id = this._extractEntryId(entry, entries.length - 1);
    if (id != null) {
      const normalizedId = String(id);
      const previousId = this._expandedId;
      if (this._autoSyncOpenState && previousId && previousId !== normalizedId) {
        const prevInfo = this._findEntryInfoById(previousId);
        if (prevInfo?.entry) this._applyOpenState(prevInfo.entry, false);
      }
      if (this._autoSyncOpenState) this._applyOpenState(entry, true);
      this._expandedId = normalizedId;
    }
    this.render();
    this._emitCollectionChange('add', entry);
  }

  _handleSchemaChange(id, entry, details) {
    this._updateTitleElement(id, entry);
    try {
      this.onEntryChange({ id, entry, details, history: this.history });
    } catch (_) { /* ignore */ }
    this._emitCollectionChange('update', entry);
  }

  _updateTitleElement(id, entry) {
    const titleEl = this._titleEls.get(id);
    if (!titleEl) return;
    const entries = this._getEntries();
    const idx = entries.findIndex((it, i) => this._extractEntryId(it, i) === id);
    titleEl.textContent = this._guessEntryLabel(entry, idx >= 0 ? idx : 0);
  }

  _resolveSchema(entry) {
    if (!entry) return null;
    const type = entry.type || entry.entityType || (entry.inputParams && entry.inputParams.type);
    const registry = this.history && this.history.registry ? this.history.registry : null;
    if (type && registry) {
      if (typeof registry.resolve === 'function') {
        const resolved = registry.resolve(type);
        if (resolved && resolved.inputParamsSchema) return resolved.inputParamsSchema;
      }
      const classes = registry.entityClasses;
      if (classes instanceof Map) {
        if (classes.has(type)) {
          const found = classes.get(type);
          if (found && found.inputParamsSchema) return found.inputParamsSchema;
        }
        for (const value of classes.values()) {
          if (!value) continue;
          if ((value.entityType && value.entityType === type) || (value.shortName && value.shortName === type)) {
            if (value.inputParamsSchema) return value.inputParamsSchema;
          }
        }
      }
    }
    if (entry.constructor && entry.constructor.inputParamsSchema) {
      return entry.constructor.inputParamsSchema;
    }
    return null;
  }

  async _instantiateEntryForType(typeStr) {
    const history = this.history;
    if (!history) return null;
    const EntityClass = this._resolveEntityClass(typeStr);
    if (!EntityClass) return null;
    let entry = null;
    try {
      entry = new EntityClass({ history, registry: history.registry });
    } catch (error) {
      console.warn('[HistoryCollectionWidget] Failed to create entity:', error);
      return null;
    }
    const id = this._generateEntryId(EntityClass);
    if (typeof entry.setId === 'function') {
      entry.setId(id);
    } else {
      entry.id = id;
      if (entry.inputParams && entry.inputParams.id == null) {
        entry.inputParams.id = id;
      }
    }
    if (!entry.inputParams) entry.inputParams = {};
    entry.inputParams.type = entry.inputParams.type || entry.type || typeStr;
    const defaults = this._defaultsFromSchema(entry.constructor);
    entry.setParams({ ...defaults, ...entry.inputParams });
    return entry;
  }

  _resolveEntityClass(typeStr) {
    const history = this.history;
    if (!history) return null;
    if (history.registry && typeof history.registry.resolve === 'function') {
      try {
        const resolved = history.registry.resolve(typeStr);
        if (resolved) return resolved;
      } catch (_) { /* ignore */ }
    }
    if (history.registry && history.registry.entityClasses instanceof Map) {
      const MapClass = history.registry.entityClasses.get(typeStr);
      if (MapClass) return MapClass;
      for (const value of history.registry.entityClasses.values()) {
        if (!value) continue;
        if (value.entityType === typeStr || value.shortName === typeStr || value.type === typeStr) return value;
      }
    }
    return null;
  }

  _defaultsFromSchema(EntityClass) {
    if (!EntityClass || !EntityClass.inputParamsSchema) return {};
    const schema = EntityClass.inputParamsSchema;
    const defaults = {};
    for (const key of Object.keys(schema)) {
      const def = schema[key];
      if (!def || typeof def !== 'object') continue;
      if (Object.prototype.hasOwnProperty.call(def, 'default_value')) {
        defaults[key] = def.default_value;
      }
    }
    return defaults;
  }

  _generateEntryId(EntityClass) {
    const history = this.history;
    if (!history || typeof history.generateId !== 'function') return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const hint =
      EntityClass?.shortName ||
      EntityClass?.featureShortName ||
      EntityClass?.featureName ||
      EntityClass?.entityType ||
      'ENTRY';
    return history.generateId(hint);
  }

  _refreshAddMenu() {
    if (!this._footer) return;
    const select = this._footer.querySelector('.hc-add-select');
    if (!select) return;
    select.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Add…';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    const history = this.history;
    if (!history || !history.registry) return;
    const entries = this._getEntries();
    const existingTypes = new Set(entries.map((entry) => entry?.type || entry?.entityType).filter(Boolean));
    const available = typeof history.registry.listAvailable === 'function'
      ? history.registry.listAvailable()
      : Array.isArray(history.registry.entityClasses)
        ? history.registry.entityClasses
        : (history.registry.entityClasses instanceof Map
          ? Array.from(history.registry.entityClasses.values())
          : []);
    if (!Array.isArray(available)) return;
    for (const info of available) {
      if (!info) continue;
      const type = info.type || info.entityType || info.shortName;
      if (!type) continue;
      const opt = document.createElement('option');
      opt.value = type;
      const has = existingTypes.has(type);
      opt.textContent = has ? `${info.longName || info.featureName || type} (existing)` : (info.longName || info.featureName || type);
      select.appendChild(opt);
    }
  }

  _buildFooter() {
    const footer = document.createElement('div');
    footer.className = 'hc-footer';
    const label = document.createElement('span');
    label.className = 'hc-add-label';
    label.textContent = 'Add annotation';
    footer.appendChild(label);
    const select = document.createElement('select');
    select.className = 'hc-add-select';
    select.addEventListener('change', async () => {
      const value = select.value;
      select.value = '';
      await this._handleAddEntry(value);
    });
    footer.appendChild(select);
    this._refreshAddMenu();
    return footer;
  }

  _subscribeToHistory(history) {
    if (!history || typeof history.addListener !== 'function') return;
    const handler = (payload = {}) => {
      if (this._suppressHistoryListener) return;
      this._handleHistoryEvent(payload);
    };
    this._boundHistoryListener = handler;
    this._listenerUnsub = history.addListener(handler);
  }

  _handleHistoryEvent(payload) {
    this.render();
    try {
      if (payload && payload.reason) {
        this._emitCollectionChange(payload.reason, payload.entry || null);
      }
    } catch (_) { /* ignore */ }
  }

  _emitCollectionChange(reason, entry) {
    try {
      this.onCollectionChange({ reason, entry, history: this.history });
    } catch (_) { /* ignore */ }
  }

  _defaultDetermineExpanded(entry) {
    if (!entry) return false;
    try {
      if (entry.runtimeAttributes && Object.prototype.hasOwnProperty.call(entry.runtimeAttributes, '__open')) {
        return Boolean(entry.runtimeAttributes.__open);
      }
      const params = entry.inputParams;
      if (params && Object.prototype.hasOwnProperty.call(params, '__open')) {
        return Boolean(params.__open);
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  _applyOpenState(entry, isOpen) {
    if (!entry) return;
    try {
      if (!entry.runtimeAttributes || typeof entry.runtimeAttributes !== 'object') {
        entry.runtimeAttributes = {};
      }
      entry.runtimeAttributes.__open = Boolean(isOpen);
      if (entry.inputParams && typeof entry.inputParams === 'object') {
        entry.inputParams.__open = Boolean(isOpen);
      }
    } catch (_) { /* ignore */ }
  }

  _composeFormOptions(context, getFormRef) {
    const provider = this._formOptionsProvider;
    const providerContext = { ...(context || {}) };
    const userOptions = provider ? (provider(providerContext) || {}) : {};
    const options = { ...userOptions };
    const userOnChange = typeof options.onChange === 'function' ? options.onChange : null;
    const userOnAction = typeof options.onAction === 'function' ? options.onAction : null;
    const getForm = (typeof getFormRef === 'function') ? getFormRef : null;

    options.onChange = (_entryId, details) => {
      const changeDetails = (details && typeof details === 'object') ? details : {};
      const helpers = this._createHelperContext({
        ...(context || {}),
        form: (getForm ? getForm() : null) || changeDetails.form || null,
        details: changeDetails,
      });
      if (helpers && typeof helpers === 'object') {
        const existing = (changeDetails.helpers && typeof changeDetails.helpers === 'object')
          ? changeDetails.helpers
          : {};
        changeDetails.helpers = { ...existing, ...helpers };
      }
      if (userOnChange) {
        try { userOnChange(_entryId, changeDetails); } catch (_) { /* ignore user handler errors */ }
      }
      const entryId = (context && context.id != null) ? String(context.id) : context?.id;
      this._handleSchemaChange(entryId, context?.entry, changeDetails);
    };

    options.onAction = (featureID, actionKey) => {
      if (userOnAction) {
        try { userOnAction(featureID, actionKey); } catch (_) { /* ignore */ }
      }
    };

    return options;
  }

  _createHelperContext(context = {}) {
    const {
      entry = null,
      id = null,
      index = null,
      schema = null,
      params = null,
      form = null,
    } = context;
    const baseHelpers = {
      widget: this,
      history: this.history || null,
      viewer: this.viewer || null,
      entry,
      id,
      index,
      schema,
      params,
      form,
      getForm: () => {
        if (form) return form;
        if (id == null) return null;
        return this.getFormForEntry(String(id));
      },
    };
    const augmented = this._augmentHelperContext(baseHelpers, context);
    if (augmented && typeof augmented === 'object' && Object.keys(augmented).length) {
      return { ...baseHelpers, ...augmented };
    }
    return baseHelpers;
  }

  // Subclasses can override to add extra helper utilities.
  // eslint-disable-next-line class-methods-use-this, no-unused-vars
  _augmentHelperContext(_baseHelpers, _context) {
    return {};
  }

  _makeStyle() {
    const style = document.createElement('style');
    style.textContent = HISTORY_COLLECTION_WIDGET_CSS;
    return style;
  }
}
