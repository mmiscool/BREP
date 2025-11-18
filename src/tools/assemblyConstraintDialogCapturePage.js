import { AssemblyConstraintRegistry } from '../assemblyConstraints/AssemblyConstraintRegistry.js';
import { renderDialogCapturePage } from './dialogCapturePageFactory.js';

const registry = new AssemblyConstraintRegistry();

const entries = registry.list()
  .filter(Boolean)
  .map((ConstraintClass) => {
    const displayName = pickName(
      ConstraintClass.longName,
      ConstraintClass.constraintName,
      ConstraintClass.name,
      'Constraint',
    );
    const shortName = pickName(
      ConstraintClass.shortName,
      ConstraintClass.constraintShortName,
      ConstraintClass.constraintType,
      displayName,
      'Constraint',
    );
    const schema = (ConstraintClass && typeof ConstraintClass.inputParamsSchema === 'object')
      ? ConstraintClass.inputParamsSchema
      : {};
    const initialParams = buildConstraintParams(schema, shortName);
    return {
      displayName,
      shortName,
      captureName: displayName,
      schema,
      initialParams,
    };
  });

renderDialogCapturePage({
  title: 'Assembly Constraint Dialog Reference',
  description: 'Dialogs for built-in assembly constraints captured from the constraint registry.',
  entries,
});

function pickName(...values) {
  for (const value of values) {
    if (value == null && value !== 0) continue;
    const str = String(value).trim();
    if (str.length) return str;
  }
  return 'Constraint';
}

function buildConstraintParams(schema, shortName) {
  if (!schema || typeof schema !== 'object') return {};
  const idKey = Object.keys(schema).find((key) => key.toLowerCase() === 'constraintid');
  if (!idKey) return {};
  const safe = String(shortName || 'constraint').replace(/[^a-z0-9._-]+/gi, '_');
  return { [idKey]: `${safe}-constraint` };
}
