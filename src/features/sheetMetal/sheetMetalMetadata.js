import { deepClone } from '../../utils/deepClone.js';

const MIN_THICKNESS = 1e-6;
const MIN_BEND_RADIUS = 0;

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
  { featureID = null, thickness = null, bendRadius = null, baseType = null, extra = null } = {},
) {
  if (!Array.isArray(solids) || !solids.length) return;
  for (const solid of solids) {
    if (!solid || typeof solid !== 'object') continue;
    try {
      solid.userData = solid.userData || {};
      solid.userData.sheetMetal = {
        ...(solid.userData.sheetMetal || {}),
        baseType: baseType || solid.userData.sheetMetal?.baseType || null,
        thickness,
        bendRadius,
        featureID,
        ...(extra || {}),
      };
      if (thickness != null) solid.userData.sheetThickness = thickness;
      if (bendRadius != null) solid.userData.sheetBendRadius = bendRadius;
    } catch { /* metadata best-effort */ }

    const metaTarget = solid.name || featureID;
    if (metaTarget && metadataManager && typeof metadataManager.setMetadata === 'function') {
      const existing = metadataManager.getOwnMetadata(metaTarget);
      const merged = {
        ...(existing ? deepClone(existing) : {}),
        sheetMetalThickness: thickness,
        sheetMetalBendRadius: bendRadius,
        sheetMetalBaseType: baseType,
        sheetMetalFeatureId: featureID,
        sheetMetalExtra: extra || null,
      };
      metadataManager.setMetadataObject(metaTarget, merged);
    }
  }
}
