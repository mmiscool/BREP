import { AngleConstraint } from './constraints/AngleConstraint.js';
import { CoincidentConstraint } from './constraints/CoincidentConstraint.js';
import { DistanceConstraint } from './constraints/DistanceConstraint.js';
import { FixedConstraint } from './constraints/FixedConstraint.js';
import { ParallelConstraint } from './constraints/ParallelConstraint.js';
import { TouchAlignConstraint } from './constraints/TouchAlignConstraint.js';

const normalizeName = (value) => {
  if (value == null && value !== 0) return '';
  try {
    return String(value).trim();
  } catch {
    return '';
  }
};

const normalizeKey = (value) => normalizeName(value).toLowerCase();

const getShortName = (ConstraintClass) => normalizeName(
  ConstraintClass?.shortName
  ?? ConstraintClass?.constraintShortName
  ?? ConstraintClass?.name,
);

const getLongName = (ConstraintClass) => normalizeName(
  ConstraintClass?.longName
  ?? ConstraintClass?.constraintName
  ?? ConstraintClass?.name,
);

export class AssemblyConstraintRegistry {
  constructor() {
    this._map = new Map();
    this._aliases = new Map();

    // Register built-ins immediately.
    this.register(CoincidentConstraint);
    this.register(AngleConstraint);
    this.register(DistanceConstraint);
    this.register(FixedConstraint);
    this.register(ParallelConstraint);
    this.register(TouchAlignConstraint);
  }

  /**
   * Register a constraint class. Keys derive from `constraintType`, `shortName`, etc.
   * @param {typeof import('./BaseAssemblyConstraint.js').BaseAssemblyConstraint} ConstraintClass
   */
  register(ConstraintClass) {
    if (!ConstraintClass) return;
    if (!ConstraintClass.shortName) {
      ConstraintClass.shortName = ConstraintClass.constraintShortName || ConstraintClass.name || 'CONST';
    }
    if (!ConstraintClass.longName) {
      ConstraintClass.longName = ConstraintClass.constraintName || ConstraintClass.name || ConstraintClass.shortName || 'Constraint';
    }
    const keys = this.#collectKeys(ConstraintClass);
    if (!keys.typeKey) return;

    this._map.set(keys.typeKey, ConstraintClass);
    for (const alias of keys.aliases) {
      const aliasKey = normalizeKey(alias);
      if (aliasKey) this._aliases.set(aliasKey, ConstraintClass);
    }
  }

  get(name) {
    const key = normalizeKey(name);
    if (!key) {
      throw new Error('Constraint type must be a non-empty string');
    }
    const cls = this._map.get(key) || this._aliases.get(key);
    if (!cls) {
      throw new Error(`Constraint type "${name}" is not registered.`);
    }
    return cls;
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
    return Array.from(new Set(this._map.values()));
  }

  listAvailable() {
    return this.list();
  }

  #collectKeys(ConstraintClass) {
    const keys = new Set();
    const type = normalizeKey(ConstraintClass.constraintType || ConstraintClass.type || null);
    if (type) keys.add(type);

    const shortName = normalizeKey(getShortName(ConstraintClass));
    if (shortName && shortName !== type) keys.add(shortName);

    const longName = normalizeKey(getLongName(ConstraintClass));
    if (longName && longName !== type) keys.add(longName);

    const className = normalizeKey(ConstraintClass.name);
    if (className) keys.add(className);

    const aliases = Array.isArray(ConstraintClass.aliases)
      ? ConstraintClass.aliases.filter(Boolean)
      : [];

    const [typeKey, ...rest] = keys;
    return { typeKey: typeKey || null, aliases: rest.concat(aliases) };
  }
}
