import { HistoryCollectionBase } from '../core/entities/HistoryCollectionBase.js';
import { ListEntityBase } from '../core/entities/ListEntityBase.js';
import { HistoryCollectionWidget } from '../UI/history/HistoryCollectionWidget.js';
import { sanitizeInputParams } from '../core/entities/schemaProcesser.js';

class DemoNoteEntity extends ListEntityBase {
  static entityType = 'DEMO_NOTE';
  static shortName = 'Note';
  static longName = 'Demo Note';
  static inputParamsSchema = {
    id: { type: 'string', default_value: null, hint: 'Identifier' },
    name: { type: 'string', default_value: 'Untitled note', hint: 'Display name' },
    message: { type: 'string', default_value: 'Write details here.', hint: 'Freeform text' },
    emphasis: { type: 'number', default_value: 1, hint: 'Arbitrary weight (0-10)', min: 0, max: 10, step: 'any' },
  };

  constructor(opts = {}) {
    super(opts);
  }

  // eslint-disable-next-line class-methods-use-this
  run() {
    return null;
  }

  onIdChanged() {}
  onParamsChanged() {}
  onPersistentDataChanged() {}
}

class DemoToggleEntity extends ListEntityBase {
  static entityType = 'DEMO_TOGGLE';
  static shortName = 'Toggle';
  static longName = 'Demo Toggle';
  static inputParamsSchema = {
    id: { type: 'string', default_value: null, hint: 'Identifier' },
    label: { type: 'string', default_value: 'Untitled toggle', hint: 'Display label' },
    isEnabled: { type: 'boolean', default_value: true, hint: 'Active state' },
    mode: { type: 'options', default_value: 'primary', options: ['primary', 'secondary', 'tertiary'], hint: 'Mode selector' },
  };

  constructor(opts = {}) {
    super(opts);
  }

  // eslint-disable-next-line class-methods-use-this
  run() {
    return null;
  }

  onIdChanged() {}
  onParamsChanged() {}
  onPersistentDataChanged() {}
}

async function createEntity(EntityClass, history, overrides = {}) {
  const entry = new EntityClass({ history, registry: history.registry });
  const id = overrides.id || nextId(history, EntityClass);
  if (typeof entry.setId === 'function') entry.setId(id);
  else {
    entry.id = id;
    entry.inputParams = entry.inputParams || {};
    entry.inputParams.id = id;
  }
  const schema = EntityClass.inputParamsSchema || {};
  const seeded = { ...overrides, id, type: EntityClass.entityType };
  const sanitized = await sanitizeInputParams(schema, seeded, null, () => null);
  if (typeof entry.setParams === 'function') entry.setParams(sanitized);
  else entry.inputParams = sanitized;
  entry.type = entry.type || EntityClass.entityType;
  entry.entityType = entry.entityType || EntityClass.entityType;
  entry.title = entry.title || EntityClass.longName || EntityClass.shortName;
  return entry;
}

function nextId(history, EntityClass) {
  const prefix = String(
    EntityClass?.shortName ||
    EntityClass?.entityType ||
    EntityClass?.name ||
    'entry'
  ).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'entry';
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  const existing = new Set(entries.map((entry, index) => {
    if (!entry) return '';
    if (entry.id != null) return String(entry.id);
    const params = entry.inputParams || {};
    if (params.id != null) return String(params.id);
    return `entry-${index + 1}`;
  }));
  let counter = (history && typeof history._idCounter === 'number') ? history._idCounter : entries.length;
  let candidate = '';
  do {
    counter += 1;
    candidate = `${prefix}-${counter}`;
  } while (existing.has(candidate));
  if (history && typeof history._idCounter === 'number') {
    history._idCounter = counter;
  }
  return candidate;
}

async function buildDemoHistory(viewer) {
  const history = new HistoryCollectionBase({ viewer });
  history.registry.register(DemoNoteEntity);
  history.registry.register(DemoToggleEntity);

  const entries = history.entries;
  entries.push(await createEntity(DemoNoteEntity, history, {
    name: 'Welcome Note',
    message: 'This demo shows how HistoryCollectionWidget drives schema forms.',
    emphasis: 3,
  }));
  entries.push(await createEntity(DemoToggleEntity, history, {
    label: 'Enable proxy feature',
    isEnabled: false,
    mode: 'secondary',
  }));
  return history;
}

export async function installHistoryCollectionDemo(viewer) {
  const history = await buildDemoHistory(viewer);
  const widget = new HistoryCollectionWidget({
    history,
    viewer,
    onEntryChange: ({ entry }) => {
      try {
        if (viewer && typeof viewer.render === 'function') viewer.render();
      } catch (_) { /* ignore */ }
      // eslint-disable-next-line no-console
      console.debug('[HistoryCollectionDemo] Entry updated:', entry?.id || entry);
    },
    onCollectionChange: ({ reason, entry }) => {
      // eslint-disable-next-line no-console
      console.debug(`[HistoryCollectionDemo] Collection ${reason}`, entry?.id || entry);
    },
  });
  return { history, widget };
}
