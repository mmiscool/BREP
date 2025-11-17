import { HistoryCollectionWidget } from '../history/HistoryCollectionWidget.js';

export class AnnotationCollectionWidget extends HistoryCollectionWidget {
  constructor({
    history = null,
    pmimode = null,
    onEntryChange = null,
    onCollectionChange = null,
    onEntryToggle = null,
  } = {}) {
    const externalChange = typeof onEntryChange === 'function' ? onEntryChange : null;
    const externalCollection = typeof onCollectionChange === 'function' ? onCollectionChange : null;
    const externalToggle = typeof onEntryToggle === 'function' ? onEntryToggle : null;

    super({
      history,
      viewer: pmimode?.viewer || null,
      entryToggle: history ? {
        getTitle: () => 'Show or hide this annotation',
        isEnabled: ({ entry }) => entry?.enabled !== false,
        setEnabled: ({ entry }, value) => {
          const entryId = entry?.inputParams?.id || entry?.id;
          if (!entryId || typeof history.setAnnotationEnabled !== 'function') return;
          history.setAnnotationEnabled(entryId, value);
        },
      } : null,
      decorateEntryHeader: (context) => {
        const item = context?.elements?.item;
        if (!item) return;
        const disabled = context?.entry?.enabled === false;
        item.classList.toggle('annotation-disabled', disabled);
      },
      onEntryChange: (payload) => {
        this.#applyEntryChange(payload);
        if (externalChange) {
          try { externalChange(payload); } catch (_) { /* ignore */ }
        }
      },
      onCollectionChange: (payload) => {
        this.#handleCollectionChange(payload);
        if (externalCollection) {
          try { externalCollection(payload); } catch (_) { /* ignore */ }
        }
      },
      onEntryToggle: externalToggle ? ((entry, isOpen) => {
        try { externalToggle(entry, isOpen); } catch (_) { /* ignore */ }
      }) : null,
      autoSyncOpenState: true,
      createEntry: async (typeStr) => {
        if (!typeStr || !history || typeof history.createAnnotation !== 'function') return null;
        return history.createAnnotation(typeStr);
      },
    });

    this.pmimode = pmimode || null;
  }

  #applyEntryChange({ entry, details }) {
    if (!entry) return;
    try {
      const registry = this.history?.registry;
      let handler = null;
      if (registry && typeof registry.resolve === 'function') {
        handler = registry.resolve(entry.type || entry.entityType);
      }
      if (!handler && entry.constructor) handler = entry.constructor;
      if (handler && typeof handler.applyParams === 'function') {
        const helpers = details?.helpers;
        handler.applyParams(this.pmimode, entry.inputParams, entry.inputParams, helpers);
      }
    } catch (error) {
      console.warn('[AnnotationCollectionWidget] applyParams failed:', error);
    }
  }

  #handleCollectionChange({ reason, entry }) {
    if (!entry || !this.pmimode) return;
    try {
      switch (reason) {
        case 'add':
          this.pmimode.normalizeAnnotation(entry.inputParams);
          this.pmimode.markAnnotationsDirty();
          break;
        case 'remove':
          this.pmimode.handleAnnotationRemoval(entry);
          this.pmimode.markAnnotationsDirty();
          break;
        case 'reorder':
          this.pmimode.markAnnotationsDirty();
          this.pmimode.applyViewTransformsSequential?.();
          break;
        case 'update':
          this.pmimode.markAnnotationsDirty();
          break;
        default:
          break;
      }
    } catch (error) {
      console.warn('[AnnotationCollectionWidget] collection change handler failed:', error);
    }
  }

  _augmentHelperContext(baseHelpers, context) {
    const extra = super._augmentHelperContext(baseHelpers, context) || {};
    const pmimode = this.pmimode || null;
    if (!pmimode) return extra;
    const merged = {
      pmimode,
      viewer: pmimode.viewer || baseHelpers.viewer || null,
      refreshAnnotationsUI() {
        try { pmimode.refreshAnnotationsUI?.(); } catch (_) { /* ignore */ }
      },
      markAnnotationsDirty() {
        try { pmimode.markAnnotationsDirty?.(); } catch (_) { /* ignore */ }
      },
    };
    return { ...extra, ...merged };
  }

}
