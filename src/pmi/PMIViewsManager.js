// PMIViewsManager.js
// Encapsulates storage and lifecycle for PMI views associated with a PartHistory instance.

function deepClone(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(deepClone);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = deepClone(value[key]);
    }
    return out;
  }
  return value;
}

export class PMIViewsManager {
  constructor(partHistory) {
    this.partHistory = partHistory || null;
    this.views = [];
    this._listeners = new Set();
  }

  reset() {
    this.views = [];
    this._emit();
  }

  getViews() {
    this._normalizeViewsArray(this.views);
    return this.views;
  }

  setViews(views) {
    const arr = Array.isArray(views) ? Array.from(views) : [];
    this.views = arr;
    this._normalizeViewsArray(this.views);
    this._emit();
    return this.views;
  }

  addView(view) {
    const list = this.getViews();
    const normalized = this._normalizeView(view, list.length);
    list.push(normalized);
    this._emit();
    return normalized;
  }

  updateView(index, updater) {
    const list = this.getViews();
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return null;
    const current = list[idx];
    let next = current;
    if (typeof updater === 'function') {
      try {
        const result = updater(current);
        if (result && typeof result === 'object') {
          next = result;
        }
      } catch {
        // ignore updater errors
      }
    } else if (updater && typeof updater === 'object' && updater !== current) {
      next = Object.assign({}, current, updater);
    }
    if (next !== current) {
      list[idx] = next;
    }
    list[idx] = this._normalizeView(list[idx], idx);
    this._emit();
    return list[idx];
  }

  removeView(index) {
    const list = this.getViews();
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return null;
    const [removed] = list.splice(idx, 1);
    for (let i = 0; i < list.length; i++) {
      list[i] = this._normalizeView(list[i], i);
    }
    this._emit();
    return removed || null;
  }

  addListener(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    return () => {
      try { this._listeners.delete(listener); } catch { }
    };
  }

  removeListener(listener) {
    if (typeof listener !== 'function') return;
    try { this._listeners.delete(listener); } catch { }
  }

  notifyChanged() {
    this._emit();
  }

  toSerializable() {
    return this.getViews().map(view => deepClone(view));
  }

  _normalizeViewsArray(arrayRef) {
    if (!Array.isArray(arrayRef)) {
      this.views = [];
      return this.views;
    }
    for (let i = 0; i < arrayRef.length; i++) {
      arrayRef[i] = this._normalizeView(arrayRef[i], i);
    }
    return arrayRef;
  }

  _normalizeView(raw, index) {
    const fallbackIndex = Number.isInteger(index) ? index : 0;
    const view = (raw && typeof raw === 'object') ? raw : {};
    const legacyName = typeof view.name === 'string' ? view.name.trim() : '';
    const currentName = typeof view.viewName === 'string' ? view.viewName.trim() : '';
    const finalName = currentName || legacyName || `View ${fallbackIndex + 1}`;
    view.viewName = finalName;
    view.name = finalName;

    if (!Array.isArray(view.annotations)) view.annotations = [];
    if (!view.camera || typeof view.camera !== 'object') view.camera = {};
    if (!view.viewSettings || typeof view.viewSettings !== 'object') view.viewSettings = {};
    if (view.annotationHistory && typeof view.annotationHistory !== 'object') {
      delete view.annotationHistory;
    }
    return view;
  }

  _emit() {
    if (!this._listeners || this._listeners.size === 0) return;
    const views = this.getViews();
    for (const listener of Array.from(this._listeners)) {
      try { listener(views, this.partHistory || null); } catch { }
    }
  }
}
