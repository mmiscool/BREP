// Simple registry for PMI annotation types

export class AnnotationRegistry {
  constructor() {
    this._types = new Map();
  }

  register(handler) {
    if (!handler || !handler.type) return;
    this._types.set(String(handler.type), handler);
  }

  get(type) {
    return this._types.get(String(type)) || null;
  }

  list() {
    return Array.from(this._types.values());
  }
}

export const annotationRegistry = new AnnotationRegistry();

