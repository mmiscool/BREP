import { deepClone } from '../../utils/deepClone.js';

function evaluateNumber(expressionsEvaluator, value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length) {
    if (expressionsEvaluator && typeof expressionsEvaluator.evaluate === 'function') {
      try {
        const result = expressionsEvaluator.evaluate(value);
        if (Number.isFinite(result)) return Number(result);
      } catch {
        /* ignore evaluation errors */
      }
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const fallback = Number(value);
  return Number.isFinite(fallback) ? fallback : 0;
}

export async function sanitizeInputParams(schema, inputParams, expressionsEvaluator, getObjectByName) {

    let sanitized = {};

    for (const key in schema) {
        //console.log(`Sanitizing ${key}:`, inputParams[key]);
        if (inputParams[key] !== undefined) {
            // check if the schema type is number
            if (schema[key].type === "number") {
                sanitized[key] = evaluateNumber(expressionsEvaluator, inputParams[key]);
            } else if (schema[key].type === "reference_selection") {
                // Resolve references: accept objects directly or look up by name
                const val = inputParams[key];
                if (Array.isArray(val)) {
                    const arr = [];
                    for (const it of val) {
                        if (!it) continue;
                        if (typeof it === 'object') { arr.push(it); continue; }
                        const obj = getObjectByName(String(it));
                        if (obj) arr.push(obj);
                    }
                    sanitized[key] = arr;
                } else {
                    if (!val) { sanitized[key] = []; }
                    else if (typeof val === 'object') { sanitized[key] = [val]; }
                    else {
                        const obj = getObjectByName(String(val));
                        sanitized[key] = obj ? [obj] : [];
                    }
                }

            } else if (schema[key].type === "boolean_operation") {
                // If it's a boolean operation, normalize op key and resolve targets to objects.
                // Also pass through optional biasDistance (numeric) and new sweep cap offset controls.
                const raw = inputParams[key] || {};
                const op = raw.operation;
                const items = Array.isArray(raw.targets) ? raw.targets : [];
                const targets = [];
                for (const it of items) {
                    if (!it) continue;
                    if (typeof it === 'object') { targets.push(it); continue; }
                    const obj = getObjectByName(String(it));
                    if (obj) targets.push(obj);
                }
                const bias = Number(raw.biasDistance);
                const offsetCapFlag = (raw.offsetCoplanarCap != null) ? String(raw.offsetCoplanarCap) : undefined;
                const offsetDistance = Number(raw.offsetDistance);
                const out = {
                    operation: op ?? 'NONE',
                    targets,
                    biasDistance: Number.isFinite(bias) ? bias : 0.1,
                };
                if (offsetCapFlag !== undefined) out.offsetCoplanarCap = offsetCapFlag;
                if (Number.isFinite(offsetDistance)) out.offsetDistance = offsetDistance;
                sanitized[key] = out;
            } else if (schema[key].type === "transform") {
                // Evaluate each component; allow expressions in position/rotation/scale entries
                const raw = inputParams[key] || {};
                const evalOne = (v) => evaluateNumber(expressionsEvaluator, v);
                const pos = Array.isArray(raw.position) ? raw.position.map(evalOne) : [0, 0, 0];
                const rot = Array.isArray(raw.rotationEuler) ? raw.rotationEuler.map(evalOne) : [0, 0, 0];
                const scl = Array.isArray(raw.scale) ? raw.scale.map(evalOne) : [1, 1, 1];
                sanitized[key] = { position: pos, rotationEuler: rot, scale: scl };
            } else if (schema[key].type === "vec3") {
                // Evaluate vec3 entries; accept array [x,y,z] or object {x,y,z}
                const raw = inputParams[key];
                const evalOne = (v) => evaluateNumber(expressionsEvaluator, v);
                if (Array.isArray(raw)) {
                    sanitized[key] = [evalOne(raw[0]), evalOne(raw[1]), evalOne(raw[2])];
                } else if (raw && typeof raw === 'object') {
                    sanitized[key] = [evalOne(raw.x), evalOne(raw.y), evalOne(raw.z)];
                } else {
                    sanitized[key] = [0, 0, 0];
                }
            } else if (schema[key].type === "boolean") {
                sanitized[key] = Boolean(Object.prototype.hasOwnProperty.call(inputParams, key) ? inputParams[key] : schema[key].default_value);
            } else {
                sanitized[key] = inputParams[key];
            }
        } else {
            // Clone structured defaults to avoid shared references across features
            sanitized[key] = deepClone(schema[key].default_value);
        }
    }

    return sanitized;
}
