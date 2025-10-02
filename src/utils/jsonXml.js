// jsonXml.js — Minimal JSON ↔ XML conversion utilities for feature history payloads
//
// DEPRECATED: Feature history now uses JSON directly without XML conversion.
// This file is no longer used by the application as of the JSON migration.
// It may be removed in a future version.

function sanitizeTagName(name) {
  let n = String(name == null ? '' : name);
  if (!n) return 'item';
  // Replace invalid characters with underscore
  n = n.replace(/[^A-Za-z0-9_.-]+/g, '_');
  // XML names cannot start with a digit, hyphen, or dot
  if (/^[0-9.-]/.test(n)) n = 'n_' + n;
  return n;
}

function escapeText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function valueToXml(value, key) {
  const tag = sanitizeTagName(key || 'item');
  if (value == null) return `<${tag}/>`;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return `<${tag}>${escapeText(value)}</${tag}>`;
  }
  if (Array.isArray(value)) {
    // Arrays: wrap elements in <tag><item>...</item></tag> to preserve single-element arrays
    const inner = value.map(v => valueToXml(v, 'item')).join('');
    return `<${tag}>${inner}</${tag}>`;
  }
  if (t === 'object') {
    const inner = Object.keys(value).map(k => valueToXml(value[k], k)).join('');
    return `<${tag}>${inner}</${tag}>`;
  }
  // Fallback to string
  return `<${tag}>${escapeText(String(value))}</${tag}>`;
}

export function jsonToXml(obj, rootName = 'root') {
  const root = sanitizeTagName(rootName || 'root');
  const body = valueToXml(obj, root);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

function textToPrimitive(text) {
  const s = String(text == null ? '' : text).trim();
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  const n = Number(s);
  if (Number.isFinite(n) && String(n) === s) return n;
  return s;
}

function elementToJson(el) {
  if (!el) return null;
  // If any child elements exist, build an object/array structure.
  const children = Array.from(el.children || []);
  if (children.length === 0) {
    return textToPrimitive(el.textContent || '');
  }
  // Special-case: array wrapper <tag><item>...</item><item>...</item></tag>
  const allItems = children.length > 0 && children.every(c => c.tagName === 'item');
  if (allItems) {
    return children.map(ch => elementToJson(ch));
  }
  const obj = {};
  for (const child of children) {
    const name = child.tagName;
    const val = elementToJson(child);
    if (Object.prototype.hasOwnProperty.call(obj, name)) {
      // existing key → make it an array
      const prev = obj[name];
      if (Array.isArray(prev)) prev.push(val);
      else obj[name] = [prev, val];
    } else {
      obj[name] = val;
    }
  }
  return obj;
}

export function xmlToJson(xmlString) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(xmlString || ''), 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('Invalid XML');
    const root = doc.documentElement;
    const out = {};
    out[root.tagName] = elementToJson(root);
    return out;
  } catch (e) {
    console.warn('[xmlToJson] Failed to parse XML:', e);
    return null;
  }
}

export default { jsonToXml, xmlToJson };
