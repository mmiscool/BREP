// normalizeTypeString.js
// Shared helper to coerce type-like values into trimmed strings.

export function normalizeTypeString(type) {
  if (type === 0) return '0';
  if (!type) return '';
  return String(type).trim();
}
