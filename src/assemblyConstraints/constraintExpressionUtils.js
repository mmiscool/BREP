/**
 * Evaluate a constraint numeric parameter using the part history expressions.
 * Returns a finite number when evaluation succeeds, otherwise null.
 * @param {import('../PartHistory.js').PartHistory|null} partHistory
 * @param {*} value
 * @returns {number|null}
 */
export function evaluateConstraintNumericValue(partHistory, value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  let result = null;

  try {
    if (partHistory && typeof partHistory.evaluateExpression === 'function') {
      result = partHistory.evaluateExpression(value);
    }
  } catch {
    result = null;
  }

  if (typeof result === 'number' && Number.isFinite(result)) {
    return result;
  }

  const numericFromResult = Number(result);
  if (Number.isFinite(numericFromResult)) {
    return numericFromResult;
  }

  const fallback = Number(value);
  return Number.isFinite(fallback) ? fallback : null;
}
