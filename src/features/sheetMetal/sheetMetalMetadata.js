import { deepClone } from '../../utils/deepClone.js';

const MIN_THICKNESS = 1e-6;
const MIN_BEND_RADIUS = 0;

function isValidThickness(value) {
  const num = Number(value);
  return Number.isFinite(num) && Math.abs(num) > MIN_THICKNESS;
}

function isValidBendRadius(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= MIN_BEND_RADIUS;
}

function pickPersistentValue(existingValue, incomingValue, validator) {
  const existing = validator(existingValue) ? Number(existingValue) : null;
  if (existing != null) return existing;
  const incoming = validator(incomingValue) ? Number(incomingValue) : null;
  return incoming;
}

export function normalizeThickness(rawValue) {
  const num = Number(rawValue);
  if (!Number.isFinite(num)) {
    throw new Error('Sheet metal thickness must be a finite number.');
  }
  const magnitude = Math.abs(num);
  if (magnitude < MIN_THICKNESS) {
    throw new Error('Sheet metal thickness must be greater than zero.');
  }
  return { magnitude, signed: num };
}

export function normalizeBendRadius(rawValue, fallback = 0.5) {
  if (rawValue == null || rawValue === '') {
    return Math.max(fallback, MIN_BEND_RADIUS);
  }
  const num = Number(rawValue);
  if (!Number.isFinite(num)) {
    throw new Error('Sheet metal bend radius must be a finite number.');
  }
  if (num < MIN_BEND_RADIUS) {
    throw new Error('Sheet metal bend radius must be zero or greater.');
  }
  return num;
}

export function applySheetMetalMetadata(
  solids,
  metadataManager,
  {
    featureID = null,
    thickness = null,
    bendRadius = null,
    baseType = null,
    extra = null,
    forceBaseOverwrite = false,
  } = {},
) {
  if (!Array.isArray(solids) || !solids.length) return;
  for (const solid of solids) {
    if (!solid || typeof solid !== 'object') continue;
    const incomingThickness = isValidThickness(thickness) ? Number(thickness) : null;
    const incomingBendRadius = isValidBendRadius(bendRadius) ? Number(bendRadius) : null;
    let lockedThickness = null;
    let lockedBendRadius = null;
    try {
      solid.userData = solid.userData || {};
      const existingSM = solid.userData.sheetMetal || {};
      lockedThickness = pickPersistentValue(
        existingSM.baseThickness ?? solid.userData.sheetThickness ?? existingSM.thickness,
        thickness,
        isValidThickness,
      );
      lockedBendRadius = pickPersistentValue(
        existingSM.baseBendRadius ?? solid.userData.sheetBendRadius ?? existingSM.bendRadius,
        bendRadius,
        isValidBendRadius,
      );
      if (forceBaseOverwrite && incomingThickness != null) lockedThickness = incomingThickness;
      if (forceBaseOverwrite && incomingBendRadius != null) lockedBendRadius = incomingBendRadius;

      solid.userData.sheetMetal = {
        ...(existingSM || {}),
        baseType: baseType || existingSM.baseType || null,
        thickness: lockedThickness ?? null,
        bendRadius: lockedBendRadius ?? null,
        baseThickness: lockedThickness ?? null,
        baseBendRadius: lockedBendRadius ?? null,
        featureID,
        ...(extra || {}),
      };
      if (lockedThickness != null) solid.userData.sheetThickness = lockedThickness;
      if (lockedBendRadius != null) solid.userData.sheetBendRadius = lockedBendRadius;
    } catch { /* metadata best-effort */ }

    const metaTarget = solid.name || featureID;
    if (metaTarget && metadataManager && typeof metadataManager.setMetadata === 'function') {
      const existing = metadataManager.getOwnMetadata(metaTarget);
      const merged = existing ? deepClone(existing) : {};
      if (
        (forceBaseOverwrite && incomingThickness != null)
        || (!isValidThickness(merged.sheetMetalThickness) && isValidThickness(lockedThickness))
      ) {
        merged.sheetMetalThickness = incomingThickness != null ? incomingThickness : Number(lockedThickness);
      }
      if (
        (forceBaseOverwrite && incomingBendRadius != null)
        || (!isValidBendRadius(merged.sheetMetalBendRadius) && isValidBendRadius(lockedBendRadius))
      ) {
        merged.sheetMetalBendRadius = incomingBendRadius != null ? incomingBendRadius : Number(lockedBendRadius);
      }
      if (baseType && (forceBaseOverwrite || !merged.sheetMetalBaseType)) merged.sheetMetalBaseType = baseType;
      merged.sheetMetalFeatureId = featureID ?? merged.sheetMetalFeatureId ?? null;
      if (extra !== undefined) merged.sheetMetalExtra = extra || null;
      metadataManager.setMetadataObject(metaTarget, merged);
    }
  }
}
