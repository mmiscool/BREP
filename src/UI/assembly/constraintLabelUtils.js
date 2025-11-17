import { evaluateConstraintNumericValue } from '../../assemblyConstraints/constraintExpressionUtils.js';

export function constraintLabelText(entry, constraintClass, partHistory = null) {
  const cls = constraintClass || entry?.constraintClass || null;
  const rawShortName = cls?.shortName || cls?.constraintShortName;
  const shortName = rawShortName != null ? String(rawShortName).trim() : '';
  const base = shortName
    || cls?.longName
    || cls?.constraintName
    || entry?.constraintType
    || entry?.type
    || 'Constraint';

  let distanceSuffix = '';
  let angleSuffix = '';
  if (entry?.type === 'distance' || cls?.constraintType === 'distance') {
    const distance = evaluateConstraintNumericValue(partHistory, entry?.inputParams?.distance);
    if (distance != null) distanceSuffix = String(distance);
  }
  if (entry?.type === 'angle' || cls?.constraintType === 'angle') {
    const angle = evaluateConstraintNumericValue(partHistory, entry?.inputParams?.angle);
    if (angle != null) angleSuffix = `${angle}°`;
  }

  const parts = [];
  if (base) parts.push(String(base).trim());
  if (distanceSuffix) parts.push(distanceSuffix);
  if (angleSuffix) parts.push(angleSuffix);

  return parts.join(' ').trim();
}
