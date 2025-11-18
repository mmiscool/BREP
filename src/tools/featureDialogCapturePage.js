import { FeatureRegistry } from '../FeatureRegistry.js';
import { renderDialogCapturePage } from './dialogCapturePageFactory.js';

const registry = new FeatureRegistry();

const entries = registry.features
  .filter(Boolean)
  .map((FeatureClass) => {
    const featureName = pickName(FeatureClass.longName, FeatureClass.featureName, FeatureClass.name, 'Feature');
    const shortName = pickName(FeatureClass.shortName, FeatureClass.featureShortName, featureName, 'Feature');
    const schema = (FeatureClass && typeof FeatureClass.inputParamsSchema === 'object')
      ? FeatureClass.inputParamsSchema
      : {};
    const initialParams = buildFeatureParams(schema, shortName);
    return {
      displayName: featureName,
      shortName,
      captureName: featureName,
      schema,
      initialParams,
    };
  });

renderDialogCapturePage({
  title: 'Feature Dialog Reference',
  description: 'Dialogs are rendered live using SchemaForm. Use the automated capture script to export PNGs.',
  entries,
});

function pickName(...values) {
  for (const value of values) {
    if (value == null && value !== 0) continue;
    const str = String(value).trim();
    if (str.length) return str;
  }
  return 'Feature';
}

function buildFeatureParams(schema, shortName) {
  if (!schema || typeof schema !== 'object') return {};
  let key = null;
  if (Object.prototype.hasOwnProperty.call(schema, 'id')) key = 'id';
  else if (Object.prototype.hasOwnProperty.call(schema, 'featureID')) key = 'featureID';
  if (!key) return {};
  const fallback = String(shortName || 'feature').replace(/[^a-z0-9._-]+/gi, '_');
  return { [key]: `${fallback}-capture` };
}
