export function resolveSelectionObject(scene, selection, options = {}) {
  const scoreFn = typeof options.scoreFn === 'function' ? options.scoreFn : scoreObjectForNormal;
  return internalResolveSelectionObject(scene, selection, { scoreFn });
}

function internalResolveSelectionObject(scene, selection, options) {
  if (!scene || selection == null) return null;
  if (selection.isObject3D) return selection;

  if (Array.isArray(selection)) {
    for (const item of selection) {
      const resolved = internalResolveSelectionObject(scene, item, options);
      if (resolved) return resolved;
    }
    return null;
  }

  if (typeof selection === 'string') {
    return resolveObjectFromString(scene, selection, options);
  }

  if (typeof selection === 'object') {
    if (selection.isObject3D) return selection;
    const {
      uuid,
      name,
      id,
      path,
      reference,
      target,
    } = selection;

    if (typeof uuid === 'string') {
      try {
        const found = scene.getObjectByProperty?.('uuid', uuid);
        if (found) return found;
      } catch { /* ignore */ }
    }

    const resolveCandidate = (candidate) => (
      typeof candidate === 'string'
        ? resolveObjectFromString(scene, candidate, options)
        : null
    );

    const nameCandidate = typeof name === 'string'
      ? name
      : (typeof selection?.selectionName === 'string' ? selection.selectionName : null);
    const idCandidate = typeof id === 'string' ? id : null;

    const nameResolved = resolveCandidate(nameCandidate);
    if (nameResolved) return nameResolved;

    const idResolved = resolveCandidate(idCandidate);
    if (idResolved) return idResolved;

    if (Array.isArray(path)) {
      for (let i = path.length - 1; i >= 0; i -= 1) {
        const segment = path[i];
        if (typeof segment !== 'string') continue;
        const resolved = resolveObjectFromString(scene, segment, options);
        if (resolved) return resolved;
      }
    }

    if (reference != null) {
      const resolved = internalResolveSelectionObject(scene, reference, options);
      if (resolved) return resolved;
    }

    if (target != null) {
      const resolved = internalResolveSelectionObject(scene, target, options);
      if (resolved) return resolved;
    }
  }

  return null;
}

function resolveObjectFromString(scene, value, options) {
  if (!scene || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed != null) {
        const resolved = internalResolveSelectionObject(scene, parsed, options);
        if (resolved) return resolved;
      }
    } catch { /* ignore JSON parse errors */ }
  }

  const direct = findObjectByName(scene, trimmed, options.scoreFn);
  if (direct) return direct;

  if (looksLikeUUID(trimmed)) {
    try {
      const byUuid = scene.getObjectByProperty?.('uuid', trimmed);
      if (byUuid) return byUuid;
    } catch { /* ignore */ }
  }

  const candidates = new Set();
  candidates.add(trimmed);

  const splitByDelims = trimmed.split(/›|>|\/|\||→|->/);
  if (splitByDelims.length > 1) {
    for (const segment of splitByDelims) {
      const s = segment.trim();
      if (s) candidates.add(s);
    }
  }

  if (trimmed.includes(':')) {
    for (const segment of trimmed.split(':')) {
      const s = segment.trim();
      if (s) candidates.add(s);
    }
  }

  for (const candidate of candidates) {
    const found = findObjectByName(scene, candidate, options.scoreFn);
    if (found) return found;
  }

  let fallback = null;
  try {
    scene.traverse?.((obj) => {
      if (fallback || !obj?.name) return;
      if (!trimmed.includes(obj.name)) return;
      if (!fallback) {
        fallback = obj;
        return;
      }
      const currentScore = options.scoreFn(fallback);
      const nextScore = options.scoreFn(obj);
      if (nextScore > currentScore || obj.name.length > fallback.name.length) {
        fallback = obj;
      }
    });
  } catch { /* ignore */ }

  return fallback;
}

function findObjectByName(scene, name, scoreFn) {
  if (!scene || typeof name !== 'string' || !name) return null;

  if (typeof scene.traverse !== 'function') {
    return scene?.getObjectByName?.(name) || null;
  }

  let best = null;
  scene.traverse((obj) => {
    if (!obj || obj.name !== name) return;
    if (!best) {
      best = obj;
      return;
    }
    const currentScore = scoreFn(best);
    const newScore = scoreFn(obj);
    if (newScore > currentScore) best = obj;
  });

  if (best) return best;
  if (typeof scene.getObjectByName === 'function') return scene.getObjectByName(name);
  return null;
}

function looksLikeUUID(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length !== 36) return false;
  return /^[0-9a-fA-F-]{36}$/.test(trimmed);
}

function scoreObjectForNormal(object) {
  if (!object) return -Infinity;
  const type = object.userData?.type || object.userData?.brepType || object.type;
  if (String(type).toUpperCase() === 'FACE') return 3;
  if (object.geometry) return 2;
  return 1;
}
