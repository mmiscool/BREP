// deepClone.js
// Shared deep clone utility for plain objects, arrays, Maps/Sets, and simple primitives.

function clonePlainObject(obj) {
  const out = {};
  for (const key of Object.keys(obj)) {
    out[key] = deepClone(obj[key]);
  }
  return out;
}

function cloneMap(map) {
  const out = new Map();
  for (const [key, value] of map.entries()) {
    out.set(key, deepClone(value));
  }
  return out;
}

function cloneSet(set) {
  const out = new Set();
  for (const value of set.values()) {
    out.add(deepClone(value));
  }
  return out;
}

function cloneTypedArray(value) {
  if (typeof value.slice === 'function') {
    try { return value.slice(); } catch { /* fallthrough */ }
  }
  const Ctor = value.constructor;
  try { return new Ctor(value); } catch { return value; }
}

export function deepClone(value) {
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item));
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof Map) {
    return cloneMap(value);
  }

  if (value instanceof Set) {
    return cloneSet(value);
  }

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return cloneTypedArray(value);
  }

  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return clonePlainObject(value);
    }
    // Fall back to identity for non-plain objects (class instances, DOM nodes, etc.)
    return value;
  }

  return value;
}
