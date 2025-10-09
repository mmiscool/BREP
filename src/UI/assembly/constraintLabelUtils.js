export function constraintLabelText(entry, constraintClass) {
  const cls = constraintClass || entry?.constraintClass || null;
  const rawShortName = cls?.constraintShortName;
  const shortName = rawShortName != null ? String(rawShortName).trim() : '';
  const base = shortName
    || cls?.constraintName
    || entry?.constraintType
    || entry?.type
    || 'Constraint';

  let distanceSuffix = '';
  if (entry?.type === 'distance' || cls?.constraintType === 'distance') {
    const distance = Number(entry?.inputParams?.distance);
    if (Number.isFinite(distance)) distanceSuffix = String(distance);
  }

  const parts = [];
  if (base) parts.push(String(base).trim());
  if (distanceSuffix) parts.push(distanceSuffix);

  return parts.join(' ').trim();
}
