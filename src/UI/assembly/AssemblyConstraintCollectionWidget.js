import { HistoryCollectionWidget } from '../history/HistoryCollectionWidget.js';
import { SelectionFilter } from '../SelectionFilter.js';
import { constraintStatusInfo } from './constraintStatusUtils.js';
import { constraintLabelText } from './constraintLabelUtils.js';

const COLLECTION_EXTRA_CSS = `
  .constraint-enable-toggle {
    display: inline-flex;
    align-items: center;
    padding-left: 8px;
    padding-right: 4px;
  }
  .constraint-enable-toggle .hc-entry-toggle-checkbox {
    width: 16px;
    height: 16px;
    cursor: pointer;
    accent-color: var(--accent);
  }
  .hc-item.constraint-disabled .hc-title {
    opacity: 0.7;
  }
  .hc-item.constraint-disabled .hc-meta {
    opacity: 0.7;
  }
  .hc-item.has-error .hc-meta {
    color: var(--danger);
    font-weight: 600;
  }
  .constraint-dialog-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
  .constraint-dialog-actions .btn {
    appearance: none;
    border: 1px solid var(--border);
    background: rgba(255,255,255,.03);
    color: var(--text);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
    transition: border-color .15s ease, background-color .15s ease, transform .05s ease;
  }
  .constraint-dialog-actions .btn:hover {
    border-color: var(--focus);
  }
  .constraint-dialog-actions .btn:active {
    transform: translateY(1px);
  }
  .constraint-dialog-actions .highlight-btn {
    border-color: var(--accent);
    color: var(--accent);
  }
  .constraint-dialog-actions .highlight-btn:hover {
    background: rgba(110,168,254,.15);
  }
`;

function resolveEntryId(entry, fallback = null) {
  if (!entry) return fallback;
  if (entry.inputParams?.id != null) return String(entry.inputParams.id);
  if (entry.inputParams?.constraintID != null) return String(entry.inputParams.constraintID);
  if (entry.id != null) return String(entry.id);
  return fallback;
}

export class AssemblyConstraintCollectionWidget extends HistoryCollectionWidget {
  constructor({
    history = null,
    viewer = null,
    partHistory = null,
    onEntryChange = null,
    onCollectionChange = null,
    onEntryToggle = null,
    onHighlightRequest = null,
    onClearHighlight = null,
    onBeforeConstraintChange = null,
  } = {}) {
    const historyRef = history;
    const viewerRef = viewer;
    const beforeChangeHook = typeof onBeforeConstraintChange === 'function' ? onBeforeConstraintChange : null;
    const callBeforeChange = (payload = {}) => {
      if (!beforeChangeHook) return Promise.resolve();
      try {
        const result = beforeChangeHook(payload);
        if (result && typeof result.then === 'function') {
          return result.catch((error) => {
            console.warn('[AssemblyConstraintCollectionWidget] before change hook rejected:', error);
          });
        }
        return Promise.resolve(result);
      } catch (error) {
        console.warn('[AssemblyConstraintCollectionWidget] before change hook failed:', error);
        return Promise.resolve();
      }
    };
    const formOptionsProvider = (context = {}) => {
      const entry = context.entry || null;
      const constraintId = resolveEntryId(entry);
      return {
        excludeKeys: ['id', 'constraintID', 'applyImmediately'],
        onReferenceChipRemove: (name) => {
          try { SelectionFilter.deselectItem?.(viewerRef?.scene, name); }
          catch { /* ignore */ }
        },
        onChange: async (_entryId, details) => {
          if (!constraintId) return;
          const key = details?.key;
          if (!key || !Object.prototype.hasOwnProperty.call(details, 'value')) return;
          await callBeforeChange({ entry, reason: 'params', key, value: details.value });
          historyRef?.updateConstraintParams?.(constraintId, (params) => {
            if (!params || typeof params !== 'object') return;
            params[key] = details.value;
          });
        },
      };
    };

    const externalEntryChange = typeof onEntryChange === 'function' ? onEntryChange : null;
    const externalCollectionChange = typeof onCollectionChange === 'function' ? onCollectionChange : null;
    const externalToggle = typeof onEntryToggle === 'function' ? onEntryToggle : null;

    super({
      history,
      viewer,
      autoSyncOpenState: true,
      formOptions: formOptionsProvider,
      createEntry: async (typeStr) => {
        if (!typeStr) return null;
        if (typeof historyRef?.addConstraint !== 'function') return null;
        return historyRef.addConstraint(typeStr);
      },
      entryToggle: {
        className: 'constraint-enable-toggle',
        getTitle: () => 'Enable or disable this constraint',
        isEnabled: ({ entry }) => entry?.enabled !== false,
        setEnabled: async ({ entry }, value) => {
          const entryId = resolveEntryId(entry);
          if (!entryId) return;
          await callBeforeChange({ entry, reason: value ? 'enable' : 'disable' });
          historyRef?.setConstraintEnabled?.(entryId, value);
        },
      },
      onEntryChange: (payload) => {
        if (payload?.entry?.inputParams) {
          payload.entry.inputParams.applyImmediately = true;
        }
        if (externalEntryChange) {
          try { externalEntryChange(payload); } catch { /* ignore */ }
        }
      },
      onCollectionChange: (payload) => {
        if (externalCollectionChange) {
          try { externalCollectionChange(payload); } catch { /* ignore */ }
        }
      },
      onEntryToggle: (entry, isOpen) => {
        const entryId = resolveEntryId(entry);
        if (entryId && typeof historyRef?.setOpenState === 'function') {
          historyRef.setOpenState(entryId, isOpen);
        }
        if (externalToggle) {
          try { externalToggle(entry, isOpen); } catch { /* ignore */ }
        }
      },
      decorateEntryHeader: (context) => { this.#decorateEntry(context); },
      buildEntryControls: (context) => this.#buildControls(context),
      onFormReady: (payload) => { this.#handleFormReady(payload); },
    });

    this.partHistory = partHistory || null;
    this.viewer = viewer || null;
    this._highlightCallback = typeof onHighlightRequest === 'function' ? onHighlightRequest : null;
    this._clearHighlightCallback = typeof onClearHighlight === 'function' ? onClearHighlight : null;
    this._beforeConstraintChangeHandler = callBeforeChange;
    this.#injectAdditionalStyles();
  }

  setPartHistory(partHistory) {
    this.partHistory = partHistory || null;
  }

  focusEntryById(targetId, { behavior = 'smooth' } = {}) {
    if (targetId == null) return;
    const id = String(targetId);
    if (!id) return;
    this._expandedId = id;
    this.render();
    const root = this._shadow || null;
    if (!root) return;
    const selector = `.hc-item[data-entry-id="${CSS?.escape ? CSS.escape(id) : id}"]`;
    const el = root.querySelector(selector);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior, block: 'center' });
    }
  }

  #decorateEntry(context = {}) {
    const { entry = null, elements = {}, index = 0 } = context;
    if (!elements || !elements.item) return;
    const constraintClass = entry?.constraintClass || null;
    const statusInfo = constraintStatusInfo(entry);
    elements.item.classList.toggle('has-error', !!statusInfo.error);
    elements.item.classList.toggle('constraint-disabled', entry?.enabled === false);
    elements.item.dataset.constraintId = resolveEntryId(entry) || '';

    if (elements.metaEl) {
      elements.metaEl.textContent = statusInfo.label || '';
      elements.metaEl.title = statusInfo.title || '';
      elements.metaEl.style.color = statusInfo.color || '';
    }

    if (elements.titleEl) {
      elements.titleEl.textContent =
        constraintLabelText(entry, constraintClass, this.partHistory) || `Constraint ${index + 1}`;
    }

    if (elements.typeEl) {
      const shortName = constraintClass?.shortName || constraintClass?.constraintShortName;
      elements.typeEl.textContent =
        shortName
        || constraintClass?.constraintType
        || entry?.type
        || '';
    }
  }

  #buildControls(context = {}) {
    const entryId = resolveEntryId(context.entry);
    const total = context.totalCount || 0;
    const index = context.index || 0;
    const controls = [];
    controls.push({
      key: 'move-up',
      label: '↑',
      title: 'Move up',
      disabled: index <= 0,
      onClick: async () => {
        await this.#notifyBeforeChange({ entry: context.entry, reason: 'move-up' });
        if (entryId) this.history?.moveConstraint?.(entryId, -1);
      },
    });
    controls.push({
      key: 'move-down',
      label: '↓',
      title: 'Move down',
      disabled: index >= total - 1,
      onClick: async () => {
        await this.#notifyBeforeChange({ entry: context.entry, reason: 'move-down' });
        if (entryId) this.history?.moveConstraint?.(entryId, 1);
      },
    });
    controls.push({
      key: 'delete',
      label: '✕',
      className: 'hc-btn danger',
      title: 'Delete',
      onClick: async () => {
        await this.#notifyBeforeChange({ entry: context.entry, reason: 'delete' });
        if (entryId) this.history?.removeConstraint?.(entryId);
      },
    });
    return controls;
  }

  #notifyBeforeChange(payload = {}) {
    const handler = this._beforeConstraintChangeHandler;
    if (!handler) return Promise.resolve();
    try {
      const result = handler(payload);
      if (result && typeof result.then === 'function') {
        return result.catch((error) => {
          console.warn('[AssemblyConstraintCollectionWidget] before change hook rejected:', error);
        });
      }
      return Promise.resolve(result);
    } catch (error) {
      console.warn('[AssemblyConstraintCollectionWidget] before change hook threw:', error);
      return Promise.resolve();
    }
  }

  _resolveSchema(entry) {
    const constraintClass = entry?.constraintClass || null;
    if (constraintClass?.inputParamsSchema) return constraintClass.inputParamsSchema;
    const registry = this.history?.registry || null;
    const type = entry?.type || entry?.inputParams?.type;
    if (registry && type) {
      const resolved =
        (typeof registry.getSafe === 'function' && registry.getSafe(type))
        || (typeof registry.get === 'function' && registry.get(type));
      if (resolved?.inputParamsSchema) return resolved.inputParamsSchema;
    }
    return super._resolveSchema(entry);
  }

  #handleFormReady({ entry, form }) {
    if (!form?.uiElement) return;
    if (entry?.inputParams) entry.inputParams.applyImmediately = true;
    const host = form.uiElement.parentElement;
    if (!host) return;
    let actions = host.querySelector(':scope > .constraint-dialog-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'constraint-dialog-actions';
      host.appendChild(actions);
    } else {
      actions.textContent = '';
    }

    const highlightBtn = document.createElement('button');
    highlightBtn.type = 'button';
    highlightBtn.className = 'btn highlight-btn';
    highlightBtn.textContent = 'Highlight Selection';
    highlightBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (this._highlightCallback) {
        try { this._highlightCallback(entry); } catch { /* ignore */ }
      }
    });
    actions.appendChild(highlightBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn';
    clearBtn.textContent = 'Clear Highlight';
    clearBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (this._clearHighlightCallback) {
        try { this._clearHighlightCallback(); } catch { /* ignore */ }
      }
    });
    actions.appendChild(clearBtn);
  }

  #injectAdditionalStyles() {
    if (!this._shadow) return;
    const style = document.createElement('style');
    style.textContent = COLLECTION_EXTRA_CSS;
    this._shadow.appendChild(style);
  }

}
