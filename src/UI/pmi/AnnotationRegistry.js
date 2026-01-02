// Simple registry for PMI annotation types. Allows lookup by type string or aliases.

import { LinearDimensionAnnotation } from './dimensions/LinearDimensionAnnotation.js';
import { RadialDimensionAnnotation } from './dimensions/RadialDimensionAnnotation.js';
import { AngleDimensionAnnotation } from './dimensions/AngleDimensionAnnotation.js';
import { LeaderAnnotation } from './dimensions/LeaderAnnotation.js';
import { NoteAnnotation } from './dimensions/NoteAnnotation.js';
import { ExplodeBodyAnnotation } from './dimensions/ExplodeBodyAnnotation.js';
import { HoleCalloutAnnotation } from './dimensions/HoleCalloutAnnotation.js';

const normalizeKey = (name) => {
  if (!name && name !== 0) return '';
  return String(name).trim().toLowerCase();
};

class AnnotationRegistry {
  constructor() {
    this._map = new Map();
    this._aliases = new Map();
  }

  register(handler) {
    if (!handler) return;
    if (typeof handler === 'function') {
      const ctor = handler;
      if (!ctor.shortName) {
        ctor.shortName = ctor.featureShortName || ctor.name || ctor.type || 'ANN';
      }
      if (!ctor.longName) {
        ctor.longName = ctor.featureName || ctor.name || ctor.shortName || ctor.type || 'Annotation';
      }
    }
    const typeKey = normalizeKey(
      handler.type
      || handler.shortName
      || handler.featureShortName
      || handler.name
      || handler.longName
      || handler.featureName,
    );
    if (!typeKey) return;
    this._map.set(typeKey, handler);

    if (Array.isArray(handler.aliases)) {
      for (const alias of handler.aliases) {
        const aliasKey = normalizeKey(alias);
        if (aliasKey) this._aliases.set(aliasKey, handler);
      }
    }
  }

  get(name) {
    const key = normalizeKey(name);
    if (!key) {
      throw new Error('Annotation type must be a non-empty string');
    }
    const handler = this._map.get(key) || this._aliases.get(key);
    if (!handler) {
      throw new Error(`Annotation type "${name}" is not registered.`);
    }
    return handler;
  }

  getSafe(name) {
    try {
      return this.get(name);
    } catch {
      return null;
    }
  }

  has(name) {
    return !!this.getSafe(name);
  }

  list() {
    return Array.from(this._map.values());
  }
}

export const annotationRegistry = new AnnotationRegistry();

// Register built-in annotation handlers once
annotationRegistry.register(LinearDimensionAnnotation);
annotationRegistry.register(RadialDimensionAnnotation);
annotationRegistry.register(AngleDimensionAnnotation);
annotationRegistry.register(LeaderAnnotation);
annotationRegistry.register(NoteAnnotation);
annotationRegistry.register(ExplodeBodyAnnotation);
annotationRegistry.register(HoleCalloutAnnotation);
