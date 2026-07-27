function normalizeModelPath(input) {
  const raw = String(input || '').replace(/\\/g, '/');
  const out = [];
  for (const part of raw.split('/')) {
    const token = String(part || '').trim();
    if (!token || token === '.' || token === '..') continue;
    out.push(token);
  }
  return out.join('/');
}

export function requireModelRecord(name, record) {
  if (record) return record;
  const modelPath = normalizeModelPath(name);
  throw new Error(modelPath ? `Model not found: "${modelPath}"` : 'Model not found.');
}

export function invalidModelRecordError(name) {
  const modelPath = normalizeModelPath(name);
  return new Error(modelPath
    ? `Failed to load model "${modelPath}" (invalid data).`
    : 'Failed to load model (invalid data).');
}
