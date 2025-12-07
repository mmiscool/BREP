import { SchemaForm } from '../featureDialogs.js';
import { resolveEntryId, resolveHistoryDisplayInfo } from './historyDisplayInfo.js';
import { HISTORY_COLLECTION_WIDGET_CSS } from './historyCollectionWidget.css.js';

export const HISTORY_COLLECTION_REFRESH_EVENT = 'brep:history-collections-refresh';

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
    decorateEntryHeader = null,
    buildEntryControls = null,
    entryToggle = null,
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
    this._decorateEntryHeader = typeof decorateEntryHeader === 'function' ? decorateEntryHeader : null;
    this._buildEntryControls = typeof buildEntryControls === 'function' ? buildEntryControls : null;
    this._entryToggleConfig = this._normalizeEntryToggle(entryToggle);
    this._addBtn = null;
    this._addMenu = null;
    this._onGlobalClick = null;
    this._globalRefreshHandler = null;

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

    this._onGlobalClick = (ev) => {
      if (!this._footer) return;
      const target = ev?.target || null;
      const path = typeof ev?.composedPath === 'function' ? ev.composedPath() : null;
      const canCheckNode = typeof Node !== 'undefined';
      const isInScope = (el) => {
        if (!el) return false;
        if (path && path.includes(el)) return true;
        if (target && canCheckNode && target instanceof Node) {
          return typeof el.contains === 'function' ? el.contains(target) : false;
        }
        return false;
      };
      if (isInScope(this._addMenu) || isInScope(this._addBtn)) {
        return;
      }
      this._toggleAddMenu(false);
    };
    try {
      document.addEventListener('mousedown', this._onGlobalClick, true);
    } catch {
      this._onGlobalClick = null;
    }

    this._installGlobalRefreshHandler();

    this._expandedId = null;
    this._titleEls = new Map();
    this._metaEls = new Map();
    this._itemEls = new Map();
    this._forms = new Map();
    this._uiFieldSignatures = new Map();
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
    this._destroyAllForms();
    this._titleEls.clear();
    this._metaEls.clear();
    this._itemEls.clear();
    this._uiFieldSignatures.clear();
    this._addBtn = null;
    this._addMenu = null;
    if (this._onGlobalClick) {
      try { document.removeEventListener('mousedown', this._onGlobalClick, true); } catch (_) { /* ignore */ }
    }
    this._onGlobalClick = null;
    if (this._globalRefreshHandler) {
      try { window.removeEventListener(HISTORY_COLLECTION_REFRESH_EVENT, this._globalRefreshHandler); }
      catch (_) { /* ignore */ }
    }
    this._globalRefreshHandler = null;
  }

  setHistory(history) {
    if (history === this.history) {
      this.render();
      return;
    }
    this._uiFieldSignatures.clear();
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
    this._toggleAddMenu(false);
    this._refreshAddMenu();
    this._titleEls.clear();
    this._metaEls.clear();
    this._itemEls.clear();
    this._destroyAllForms();
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
      const itemEl = this._renderEntry(entry, id, i, targetId === id, entries.length);
      this._listEl.appendChild(itemEl);
    }
  }

  _destroyForm(id) {
    if (id == null) return;
    const key = String(id);
    const form = this._forms.get(key);
    if (!form) return;
    try {
      if (typeof form.destroy === 'function') form.destroy();
    } catch (_) { /* ignore form destroy errors */ }
    this._forms.delete(key);
  }

  _destroyAllForms() {
    if (!this._forms || this._forms.size === 0) return;
    const keys = Array.from(this._forms.keys());
    for (const key of keys) {
      this._destroyForm(key);
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
    return resolveEntryId(entry, index);
  }

  _applyDisplayInfo(entry, index, entryId, elements = {}) {
    const info = resolveHistoryDisplayInfo(entry, {
      history: this.history,
      index,
    });
    if (elements.titleEl) {
      elements.titleEl.textContent = info.name || '';
    }
    if (elements.metaEl) {
      const parts = [];
      if (info.id) parts.push(`#${info.id}`);
      if (info.statusText) parts.push(info.statusText);
      elements.metaEl.textContent = parts.join(' · ');
      elements.metaEl.title = info.statusTitle || '';
      elements.metaEl.style.color = info.statusColor || '';
    }
    if (elements.item) {
      elements.item.classList.toggle('has-error', Boolean(info.hasError));
    }
    return info;
  }

  _renderEntry(entry, id, index, isOpen = false, totalCount = 0) {
    const entryId = id != null ? String(id) : `entry-${index}`;
    const item = document.createElement('div');
    item.className = 'hc-item';
    item.dataset.entryId = entryId;
    if (isOpen) item.classList.add('open');

    const renderContext = this._createEntryRenderContext({
      entry,
      id: entryId,
      index,
      isOpen,
      totalCount,
      item,
    });

    const headerRow = document.createElement('div');
    headerRow.className = 'hc-header-row';

    const toggleControl = this._maybeRenderEntryToggle(renderContext);
    if (toggleControl) headerRow.appendChild(toggleControl);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'hc-toggle';
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    toggle.addEventListener('click', () => { this._toggleEntry(entryId); });

    const toggleMain = document.createElement('span');
    toggleMain.className = 'hc-toggle-main';
    const title = document.createElement('span');
    title.className = 'hc-title';
    this._titleEls.set(entryId, title);
    toggleMain.appendChild(title);
    const subline = document.createElement('span');
    subline.className = 'hc-subline';
    const meta = document.createElement('span');
    meta.className = 'hc-meta';
    this._metaEls.set(entryId, meta);
    subline.appendChild(meta);

    toggleMain.appendChild(subline);

    toggle.appendChild(toggleMain);
    headerRow.appendChild(toggle);

    const controls = document.createElement('div');
    controls.className = 'hc-controls';
    headerRow.appendChild(controls);
    item.appendChild(headerRow);

    renderContext.elements = {
      item,
      headerRow,
      toggleControl,
      toggle,
      toggleMain,
      titleEl: title,
      metaEl: meta,
      controlsEl: controls,
      bodyEl: null,
    };
    this._itemEls.set(entryId, item);
    const displayInfo = this._applyDisplayInfo(entry, index, entryId, renderContext.elements);

    const controlsConfig = this._buildControlsForEntry(renderContext);
    this._renderControls(controls, controlsConfig, renderContext);

    const body = document.createElement('div');
    body.className = 'hc-body';
    body.hidden = !isOpen;

    if (isOpen) {
      const schema = this._resolveSchema(entry);
      const filtered = this._filterSchemaForEntry(entry, schema, entryId);
      const effectiveSchema = filtered.schema;
      this._recordUiFieldSignature(entryId, filtered.visibleKeys);
      if (!schema) {
        const missing = document.createElement('div');
        missing.className = 'hc-missing';
        missing.textContent = `No schema available for "${displayInfo?.name || 'entity'}".`;
        body.appendChild(missing);
      } else {
        const hasFields = effectiveSchema && Object.keys(effectiveSchema).length > 0;
        if (!hasFields) {
          const empty = document.createElement('div');
          empty.className = 'hc-missing';
          empty.textContent = 'No inputs available for this configuration.';
          body.appendChild(empty);
        } else {
          const params = entry && entry.inputParams ? entry.inputParams : {};
          const contextInfo = {
            entry,
            id: entryId,
            index,
            schema: effectiveSchema,
            params,
          };
          let formRef = null;
          const options = this._composeFormOptions(contextInfo, () => formRef);
          options.excludeKeys = Array.isArray(options.excludeKeys) ? options.excludeKeys : [];
          if (!options.excludeKeys.includes('id')) {
            options.excludeKeys = [...options.excludeKeys, 'id'];
          }

          if (!Object.prototype.hasOwnProperty.call(options, 'viewer')) {
            options.viewer = this.viewer || null;
          }
          if (!Object.prototype.hasOwnProperty.call(options, 'scene')) {
            options.scene = this.viewer && this.viewer.scene ? this.viewer.scene : null;
          }
          if (!Object.prototype.hasOwnProperty.call(options, 'partHistory')) {
            options.partHistory = this.history || null;
          }

          const form = new SchemaForm(effectiveSchema || {}, params, options);
          formRef = form;
          body.appendChild(form.uiElement);
          this._forms.set(entryId, form);
          if (this._onFormReady) {
            try { this._onFormReady({ id: entryId, index, entry, form }); } catch (_) { /* ignore */ }
          }
        }
      }
    }

    renderContext.elements.bodyEl = body;
    this._applyEntryHeaderDecorators(renderContext);

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

  _createEntryRenderContext({
    entry = null,
    id = null,
    index = 0,
    isOpen = false,
    totalCount = 0,
    item = null,
  } = {}) {
    const entryId = id != null ? String(id) : null;
    const baseContext = {
      widget: this,
      history: this.history || null,
      viewer: this.viewer || null,
      entry,
      id: entryId,
      index,
      isOpen,
      totalCount,
      item,
      getForm: () => {
        if (entryId == null) return null;
        return this.getFormForEntry(entryId);
      },
      getHelpers: () => this._createHelperContext({
        entry,
        id: entryId,
        index,
        form: entryId == null ? null : this.getFormForEntry(entryId),
      }),
    };
    return baseContext;
  }

  _buildControlsForEntry(context) {
    const defaults = this._defaultControlDescriptors(context);
    if (typeof this._buildEntryControls === 'function') {
      try {
        const clone = defaults.map((descriptor) => ({ ...descriptor }));
        const custom = this._buildEntryControls(context, clone);
        if (Array.isArray(custom)) return custom;
        if (custom === null) return [];
      } catch (_) { /* ignore custom control errors */ }
    }
    return defaults;
  }

  _defaultControlDescriptors(context = {}) {
    const { id = null, index = 0, totalCount = 0 } = context;
    if (id == null) return [];
    const descriptors = [];
    descriptors.push({
      key: 'move-up',
      label: '↑',
      title: 'Move up',
      disabled: index <= 0,
      onClick: () => { this._moveEntry(id, -1); },
    });
    descriptors.push({
      key: 'move-down',
      label: '↓',
      title: 'Move down',
      disabled: index >= totalCount - 1,
      onClick: () => { this._moveEntry(id, 1); },
    });
    descriptors.push({
      key: 'delete',
      label: '✕',
      title: 'Delete',
      className: 'hc-btn danger',
      onClick: () => { this._deleteEntry(id); },
    });
    return descriptors;
  }

  _renderControls(container, descriptors, context) {
    container.textContent = '';
    let count = 0;
    if (Array.isArray(descriptors)) {
      for (const descriptor of descriptors) {
        if (!descriptor) continue;
        if (descriptor instanceof HTMLElement) {
          container.appendChild(descriptor);
          count += 1;
          continue;
        }
        const btn = document.createElement(descriptor.tagName || 'button');
        if (btn.tagName === 'BUTTON') {
          btn.type = descriptor.type || 'button';
        }
        btn.className = descriptor.className || 'hc-btn';
        if (descriptor.title) btn.title = descriptor.title;
        if (descriptor.label != null) btn.textContent = descriptor.label;
        if (descriptor.disabled) btn.disabled = true;
        if (!descriptor.disabled && typeof descriptor.onClick === 'function') {
          btn.addEventListener('click', (ev) => {
            if (descriptor.stopPropagation !== false) {
              ev.preventDefault();
              ev.stopPropagation();
            }
            try { descriptor.onClick(ev, context); } catch (_) { /* ignore */ }
          });
        }
        container.appendChild(btn);
        count += 1;
      }
    }
    container.hidden = count === 0;
  }

  _maybeRenderEntryToggle(context = {}) {
    const config = this._entryToggleConfig;
    if (!config) return null;
    let isEnabled = true;
    let disabled = false;
    let title = 'Enable entry';
    try {
      isEnabled = !!config.isEnabled(context);
    } catch {
      isEnabled = true;
    }
    try {
      disabled = config.isDisabled ? !!config.isDisabled(context) : false;
    } catch {
      disabled = false;
    }
    try {
      if (config.getTitle) {
        title = config.getTitle(context) || title;
      }
    } catch {
      /* ignore */
    }
    const wrap = document.createElement('label');
    wrap.className = config.className || 'hc-entry-toggle';
    if (title) wrap.title = title;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'hc-entry-toggle-checkbox';
    checkbox.checked = isEnabled;
    checkbox.disabled = disabled;
    if (title) checkbox.setAttribute('aria-label', title);
    checkbox.addEventListener('click', (ev) => {
      ev.stopPropagation();
    });
    checkbox.addEventListener('change', (ev) => {
      ev.stopPropagation();
      if (checkbox.disabled) return;
      try {
        config.setEnabled(context, checkbox.checked);
      } catch {
        // ignore
      }
    });
    wrap.appendChild(checkbox);
    return wrap;
  }

  _applyEntryHeaderDecorators(context) {
    if (!this._decorateEntryHeader) return;
    try {
      this._decorateEntryHeader(context);
    } catch (_) { /* ignore decorator errors */ }
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
    this._destroyForm(id);
    if (this._autoSyncOpenState && removed) {
      this._applyOpenState(removed, false);
    }
    this._uiFieldSignatures.delete(String(id));
    this.render();
    this._emitCollectionChange('remove', removed);
  }

  async _handleAddEntry(typeStr) {
    this._toggleAddMenu(false);
    if (!typeStr) return;
    let createdEntryId = null;
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
          createdEntryId = normalizedId;
        }
      } catch (_) { /* ignore */ }
      this.render();
      this._emitCollectionChange('add', entry);
      this._deferScrollToEntry(createdEntryId);
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
      createdEntryId = normalizedId;
    }
    this.render();
    this._emitCollectionChange('add', entry);
    this._deferScrollToEntry(createdEntryId);
  }

  _handleSchemaChange(id, entry, details) {
    this._updateTitleElement(id, entry);
    try {
      this.onEntryChange({ id, entry, details, history: this.history });
    } catch (_) { /* ignore */ }
    this._emitCollectionChange('update', entry);
  }

  _updateTitleElement(id, entry) {
    const entries = this._getEntries();
    const idx = entries.findIndex((it, i) => this._extractEntryId(it, i) === id);
    this._applyDisplayInfo(entry, idx >= 0 ? idx : 0, id, {
      titleEl: this._titleEls.get(id),
      metaEl: this._metaEls.get(id),
      typeEl: null,
      item: this._itemEls.get(id),
    });
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
      EntityClass?.longName ||
      EntityClass?.entityType ||
      EntityClass?.name ||
      'ENTRY';
    return history.generateId(hint);
  }

  _refreshAddMenu() {
    if (!this._addMenu || !this._addBtn) return;
    const menu = this._addMenu;
    menu.textContent = '';
    const history = this.history;
    if (!history || !history.registry) {
      this._addBtn.disabled = true;
      const empty = document.createElement('div');
      empty.className = 'hc-menu-empty';
      empty.textContent = 'No entries available';
      menu.appendChild(empty);
      return;
    }
    const available = typeof history.registry.listAvailable === 'function'
      ? history.registry.listAvailable()
      : Array.isArray(history.registry.entityClasses)
        ? history.registry.entityClasses
        : (history.registry.entityClasses instanceof Map
          ? Array.from(history.registry.entityClasses.values())
          : []);
    if (!Array.isArray(available)) {
      this._addBtn.disabled = true;
      const empty = document.createElement('div');
      empty.className = 'hc-menu-empty';
      empty.textContent = 'No entries available';
      menu.appendChild(empty);
      return;
    }
    const items = [];
    for (const info of available) {
      if (!info) continue;
      let rawType = null;
      let rawLabel = null;
      let source = null;
      if (typeof info === 'string') {
        rawType = info;
        rawLabel = info;
      } else {
        source = (typeof info === 'function' || typeof info === 'object') ? info : null;
        if (source) {
          rawType = source.type || source.entityType || source.shortName || source.name;
          rawLabel = source.longName || source.shortName || source.entityType || source.type || source.name;
        }
      }
      const item = this._composeMenuItem(rawType, rawLabel, source);
      if (item) items.push(item);
    }
    if (!items.length) {
      this._addBtn.disabled = true;
      const empty = document.createElement('div');
      empty.className = 'hc-menu-empty';
      empty.textContent = 'No entries available';
      menu.appendChild(empty);
      return;
    }
    this._addBtn.disabled = false;
    for (const { type, text } of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hc-menu-item';
      btn.setAttribute('role', 'menuitem');
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
      menu.appendChild(btn);
    }
  }

  _buildFooter() {
    const footer = document.createElement('div');
    footer.className = 'hc-footer';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'hc-add-btn';
    addBtn.setAttribute('aria-expanded', 'false');
    addBtn.setAttribute('aria-label', 'Add entry');
    addBtn.title = 'Add entry';
    addBtn.textContent = '+';
    footer.appendChild(addBtn);

    const menu = document.createElement('div');
    menu.className = 'hc-add-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    footer.appendChild(menu);

    addBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const isOpen = addBtn.getAttribute('aria-expanded') === 'true';
      this._scrollListIntoView();
      const nextState = !isOpen;
      this._toggleAddMenu(nextState);
      if (nextState) this._scrollFooterIntoView();
    });

    this._addBtn = addBtn;
    this._addMenu = menu;
    this._refreshAddMenu();
    return footer;
  }

  _toggleAddMenu(open) {
    if (!this._addBtn || !this._addMenu) return;
    const willOpen = Boolean(open);
    this._addBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    this._addMenu.hidden = !willOpen;
    if (this._footer) {
      this._footer.classList.toggle('menu-open', willOpen);
    }
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

  _installGlobalRefreshHandler() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const handler = () => {
      try { this.render(); }
      catch (_) { /* ignore */ }
    };
    try {
      window.addEventListener(HISTORY_COLLECTION_REFRESH_EVENT, handler);
      this._globalRefreshHandler = handler;
    } catch {
      this._globalRefreshHandler = null;
    }
  }

  _handleHistoryEvent(payload) {
    const reason = payload?.reason || 'update';
    const skipRender = reason === 'update' && this._hasActiveReferenceSelection();
    if (!skipRender) {
      this.render();
    }
    try {
      if (payload && payload.reason) {
        this._emitCollectionChange(payload.reason, payload.entry || null);
      }
    } catch (_) { /* ignore */ }
  }

  _hasActiveReferenceSelection() {
    const getActive = (typeof SchemaForm?.getActiveReferenceInput === 'function')
      ? SchemaForm.getActiveReferenceInput
      : null;
    if (!getActive) return false;

    const active = getActive();
    if (!active) return false;

    try {
      const root = (typeof active.getRootNode === 'function') ? active.getRootNode() : null;
      if (root && root === this._shadow) return true;
      if (root && root === this.uiElement) return true;
    } catch (_) { /* ignore */ }

    try {
      if (this._shadow && typeof this._shadow.contains === 'function' && this._shadow.contains(active)) {
        return true;
      }
    } catch (_) { /* ignore */ }

    try {
      if (this.uiElement && typeof this.uiElement.contains === 'function' && this.uiElement.contains(active)) {
        return true;
      }
    } catch (_) { /* ignore */ }

    return false;
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
      this._maybeRefreshUiFields(entryId, context?.entry);
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

  _normalizeEntryToggle(config) {
    if (!config || typeof config !== 'object') return null;
    const { isEnabled, setEnabled } = config;
    if (typeof isEnabled !== 'function' || typeof setEnabled !== 'function') return null;
    return {
      isEnabled,
      setEnabled,
      isDisabled: typeof config.isDisabled === 'function' ? config.isDisabled : null,
      getTitle: typeof config.getTitle === 'function'
        ? config.getTitle
        : (typeof config.title === 'string' ? () => config.title : null),
      className: typeof config.className === 'string' && config.className.trim()
        ? config.className
        : 'hc-entry-toggle',
    };
  }

  _composeMenuItem(rawType, rawLabel, source = null, extraNames = []) {
    if (!rawType && rawType !== 0) return null;
    const normalizedType = String(rawType);
    const nameInfo = this._extractDisplayNames(source, normalizedType, rawLabel);
    const labelText = nameInfo.longName || nameInfo.shortName || normalizedType;
    return { type: normalizedType, text: labelText };
  }

  _extractDisplayNames(source, fallbackType = '', fallbackLabel = '') {
    const shortName = this._firstNonEmptyString([
      source?.shortName,
      fallbackType,
      fallbackLabel,
    ]);
    let longName = this._firstNonEmptyString([
      source?.longName,
      fallbackLabel,
      fallbackType,
      shortName,
    ]);
    if (!longName) longName = '';
    return { shortName: shortName || '', longName: longName || '' };
  }

  _firstNonEmptyString(list = []) {
    if (!Array.isArray(list)) return '';
    for (const value of list) {
      if (value == null && value !== 0) continue;
      const str = String(value).trim();
      if (str.length) return str;
    }
    return '';
  }

  _filterSchemaForEntry(entry, schema, entryId = null) {
    const fallbackKeys = schema && typeof schema === 'object' ? Object.keys(schema) : [];
    if (!schema || typeof schema !== 'object') {
      return { schema, visibleKeys: fallbackKeys };
    }
    let entityClass = this._resolveEntityClass(entry?.type || entry?.entityType || null);
    if (!entityClass && this.history && this.history.featureRegistry) {
      try {
        entityClass =
          this.history.featureRegistry.getSafe?.(entry?.type)
          || this.history.featureRegistry.get?.(entry?.type)
          || null;
      } catch {
        entityClass = null;
      }
    }
    const context = this._createHelperContext({
      entry,
      id: entryId,
      schema,
      params: entry?.inputParams || {},
      form: entryId ? this.getFormForEntry(entryId) : null,
    }) || {};
    if (entityClass) context.entityClass = entityClass;
    const runTest = (owner, fn) => {
      if (typeof fn !== 'function') return null;
      try {
        return fn.call(owner || entry || null, context);
      } catch (error) {
        console.warn('[HistoryCollectionWidget] uiFieldsTest failed; falling back to full schema.', error);
        return null;
      }
    };
    let result = runTest(entry, entry?.uiFieldsTest);
    if (result == null && entityClass) {
      if (typeof entityClass.uiFieldsTest === 'function') {
        result = runTest(entityClass, entityClass.uiFieldsTest);
      } else if (entityClass.prototype && entityClass.prototype.uiFieldsTest && entityClass.prototype.uiFieldsTest !== entry?.uiFieldsTest) {
        result = runTest(entry, entityClass.prototype.uiFieldsTest);
      }
    }
    const { include, exclude } = this._normalizeUiFieldsResult(result);
    const allowedSet = this._normalizeKeySet(include, fallbackKeys);
    const blockedSet = this._normalizeKeySet(exclude, fallbackKeys);
    let keys = [...fallbackKeys];
    if (allowedSet.size > 0) keys = keys.filter((key) => allowedSet.has(key));
    if (blockedSet.size > 0) keys = keys.filter((key) => !blockedSet.has(key));
    if (keys.length === 0) return { schema: {}, visibleKeys: [] };
    const filtered = {};
    for (const key of keys) {
      filtered[key] = schema[key];
    }
    return { schema: filtered, visibleKeys: keys };
  }

  _normalizeUiFieldsResult(result) {
    if (result == null) return { include: null, exclude: null };
    if (Array.isArray(result)) return { include: result, exclude: null };
    if (typeof result === 'object') {
      const include = Array.isArray(result.include) ? result.include : null;
      const exclude = Array.isArray(result.exclude) ? result.exclude : null;
      if (include || exclude) return { include, exclude };
      const keys = Object.keys(result);
      if (!keys.length) return { include: null, exclude: null };
      const includeFromBools = keys.filter((k) => result[k] === true);
      const excludeFromBools = keys.filter((k) => result[k] === false);
      return {
        include: includeFromBools.length ? includeFromBools : null,
        exclude: excludeFromBools.length ? excludeFromBools : null,
      };
    }
    return { include: null, exclude: null };
  }

  _normalizeKeySet(list, fallbackKeys = []) {
    const set = new Set();
    if (!Array.isArray(list)) return set;
    const allowed = new Set(fallbackKeys);
    for (const raw of list) {
      if (raw == null) continue;
      const key = String(raw);
      if (allowed.has(key)) set.add(key);
    }
    return set;
  }

  _recordUiFieldSignature(entryId, keys = []) {
    if (entryId == null) return;
    const sig = this._uiFieldsSignatureFromKeys(keys);
    this._uiFieldSignatures.set(String(entryId), sig);
  }

  _maybeRefreshUiFields(entryId, entry) {
    if (entryId == null) return;
    const baseSchema = this._resolveSchema(entry);
    const { visibleKeys } = this._filterSchemaForEntry(entry, baseSchema, entryId);
    const nextSig = this._uiFieldsSignatureFromKeys(visibleKeys);
    const prevSig = this._uiFieldSignatures.get(String(entryId)) || null;
    if (nextSig !== prevSig) {
      this._uiFieldSignatures.set(String(entryId), nextSig);
      this.render();
    }
  }

  _uiFieldsSignatureFromKeys(keys = []) {
    if (!Array.isArray(keys) || !keys.length) return '';
    return keys.join('|');
  }

  _makeStyle() {
    const style = document.createElement('style');
    style.textContent = HISTORY_COLLECTION_WIDGET_CSS;
    return style;
  }

  _scrollListIntoView() {
    const target = this._listEl || this._container || this.uiElement;
    this._scrollElementIntoView(target);
  }

  _scrollFooterIntoView() {
    const target = this._footer || this._addBtn || this._addMenu;
    this._scrollElementIntoView(target);
  }

  _deferScrollToEntry(entryId) {
    if (!entryId) return;
    const exec = () => this._scrollEntryIntoView(entryId);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(exec);
    else setTimeout(exec, 0);
  }

  _scrollEntryIntoView(entryId) {
    if (!entryId || !this._listEl) return;
    const selector = `[data-entry-id="${this.#escapeCss(entryId)}"]`;
    const target = this._listEl.querySelector(selector);
    if (target) {
      this._scrollElementIntoView(target);
    }
  }

  _scrollElementIntoView(target) {
    if (target && typeof target.scrollIntoView === 'function') {
      try {
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch {
        target.scrollIntoView();
      }
    }
  }

  #escapeCss(value) {
    const str = String(value);
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(str);
    }
    return str.replace(/"/g, '\\"');
  }
}
