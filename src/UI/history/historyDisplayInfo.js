import { constraintStatusInfo } from '../assembly/constraintStatusUtils.js';

function firstString(value) {
  if (value == null && value !== 0) return '';
  const str = String(value).trim();
  return str;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function resolveEntryId(entry, index = 0) {
  const fallbackId = `entry-${index}`;
  const params = entry?.inputParams || {};
  if (params.id != null) return String(params.id);
  if (params.featureID != null) return String(params.featureID);
  if (params.constraintID != null) return String(params.constraintID);
  if (entry?.featureID != null) return String(entry.featureID);
  if (entry?.id != null) return String(entry.id);
  return fallbackId;
}

function resolveEntityClass(entry, history = null) {
  const type =
    entry?.type ||
    entry?.entityType ||
    entry?.constraintType ||
    entry?.inputParams?.type ||
    null;
  let foundInRegistry = false;
  if (!type) return { entityClass: entry?.constraintClass || entry?.constructor || null, foundInRegistry };

  const registry = history?.registry || history?.featureRegistry || null;
  if (registry) {
    if (typeof registry.resolve === 'function') {
      const resolved = registry.resolve(type);
      if (resolved) return { entityClass: resolved, foundInRegistry: true };
    }
    if (typeof registry.getSafe === 'function') {
      const resolved = registry.getSafe(type) || registry.get?.(type);
      if (resolved) return { entityClass: resolved, foundInRegistry: true };
    }
    if (registry.entityClasses instanceof Map) {
      const mapValue = registry.entityClasses.get(type);
      if (mapValue) return { entityClass: mapValue, foundInRegistry: true };
      for (const value of registry.entityClasses.values()) {
        if (!value) continue;
        if (
          value.entityType === type ||
          value.shortName === type ||
          value.type === type
        ) return { entityClass: value, foundInRegistry: true };
      }
    }
  }
  return { entityClass: entry?.constraintClass || entry?.constructor || null, foundInRegistry };
}

function resolveStatus(entry) {
  if (entry?.lastRun) {
    const duration = entry.lastRun.durationMs;
    const parts = [];
    const label = formatDuration(duration);
    if (label) parts.push(label);
    if (entry.lastRun.ok === false) parts.push('✖');
    return {
      label: parts.join(' ').trim(),
      error: entry.lastRun.ok === false,
    };
  }

  if (entry?.persistentData || entry?.constraintClass) {
    try {
      const info = constraintStatusInfo(entry) || {};
      return {
        label: info.label || '',
        title: info.title || '',
        color: info.color || '',
        error: Boolean(info.error),
      };
    } catch {
      return { label: '', title: '' };
    }
  }

  return { label: '' };
}

export function resolveHistoryDisplayInfo(entry, {
  history = null,
  index = 0,
} = {}) {
  const { entityClass, foundInRegistry } = resolveEntityClass(entry, history);
  const resolvedType =
    entry?.type ||
    entry?.entityType ||
    entry?.constraintType ||
    entry?.inputParams?.type ||
    '';
  const longName = firstString(
    entityClass?.longName ||
    entityClass?.constraintName ||
    entityClass?.displayName ||
    entityClass?.name ||
    entry?.type ||
    entry?.entityType ||
    ''
  );
  const shortName = firstString(
    entityClass?.shortName ||
    entityClass?.constraintShortName ||
    entityClass?.entityType ||
    entityClass?.type ||
    entry?.type ||
    entry?.entityType ||
    ''
  );
  const id = resolveEntryId(entry, index);
  const status = resolveStatus(entry);

  return {
    name: longName || shortName || `Item ${index + 1}`,
    id,
    statusText: status.label || '',
    statusTitle: status.title || '',
    statusColor: status.color || '',
    badge: '',
    hasError: Boolean(status.error || (!foundInRegistry && !!resolvedType)),
  };
}
