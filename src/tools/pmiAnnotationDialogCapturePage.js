import { annotationRegistry } from '../UI/pmi/AnnotationRegistry.js';
import { renderDialogCapturePage } from './dialogCapturePageFactory.js';

const handlers = annotationRegistry.list();

const entries = handlers
  .filter(Boolean)
  .map((Handler) => {
    const displayName = pickName(
      Handler.longName,
      Handler.title,
      Handler.featureName,
      Handler.name,
      'Annotation',
    );
    const shortName = pickName(
      Handler.shortName,
      Handler.featureShortName,
      Handler.type,
      displayName,
      'Annotation',
    );
    const schema = (Handler && typeof Handler.inputParamsSchema === 'object')
      ? Handler.inputParamsSchema
      : {};
    const initialParams = buildAnnotationParams(schema, shortName);
    return {
      displayName,
      shortName,
      captureName: displayName,
      schema,
      initialParams,
    };
  });

renderDialogCapturePage({
  title: 'PMI Annotation Dialog Reference',
  description: 'PMI annotation dialogs rendered directly from the annotation registry.',
  entries,
});

function pickName(...values) {
  for (const value of values) {
    if (value == null && value !== 0) continue;
    const str = String(value).trim();
    if (str.length) return str;
  }
  return 'Annotation';
}

function buildAnnotationParams(schema, shortName) {
  if (!schema || typeof schema !== 'object') return {};
  const idKey = Object.keys(schema).find((key) => {
    const lower = key.toLowerCase();
    return lower === 'id' || lower === 'annotationid';
  });
  if (!idKey) return {};
  const safe = String(shortName || 'annotation').replace(/[^a-z0-9._-]+/gi, '_');
  return { [idKey]: `${safe}-annotation` };
}
