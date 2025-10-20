#!/usr/bin/env node

/**
 * Debug helper for investigating boolean failures inside PartHistory runs.
 *
 * Usage:
 *   pnpm run debug:boolean -- badBoolean
 *   pnpm run debug:boolean -- badBoolean --feature=E4
 *
 * Flags:
 *   --feature=ID[,ID...]   Force DEBUG_BOOLEAN filter (defaults to all boolean-bearing features)
 *   --list                 Print the features in the part file and exit
 *   --verbose              Print extra diagnostic details per feature
 *   --stop=FEATURE_ID      Stop execution after this feature (mirrors UI stop-at behaviour)
 */

import path from 'node:path';
import fs from 'node:fs/promises';

const args = process.argv.slice(2);

let partArg = null;
const manualFeatureFilters = new Set();
let listOnly = false;
let verbose = false;
let stopAfter = null;

for (const arg of args) {
  if (arg === '--') {
    continue;
  }
  if (arg === '--list') {
    listOnly = true;
    continue;
  }
  if (arg === '--verbose') {
    verbose = true;
    continue;
  }
  if (arg.startsWith('--feature=')) {
    const raw = arg.slice('--feature='.length).split(/[,;|]+/g).map(t => t.trim()).filter(Boolean);
    raw.forEach(t => manualFeatureFilters.add(t));
    continue;
  }
  if (arg.startsWith('--stop=')) {
    stopAfter = arg.slice('--stop='.length).trim();
    continue;
  }
  if (!partArg) {
    partArg = arg;
    continue;
  }
  manualFeatureFilters.add(arg);
}

const partName = partArg || 'badBoolean';
const cwd = process.cwd();
const candidatePath = partName.endsWith('.json')
  ? path.resolve(cwd, partName)
  : path.resolve(cwd, 'src', 'tests', 'partFiles', `${partName}.json`);

let partJSON = null;
try {
  partJSON = await fs.readFile(candidatePath, 'utf8');
} catch (err) {
  console.error(`[debugBoolean] Failed to read part file at ${candidatePath}: ${err?.message || err}`);
  process.exitCode = 1;
  process.exit(1);
}

let partData = null;
try {
  partData = JSON.parse(partJSON);
} catch (err) {
  console.error(`[debugBoolean] Part file is not valid JSON: ${err?.message || err}`);
  process.exitCode = 1;
  process.exit(1);
}

const features = Array.isArray(partData.features) ? partData.features : [];
const booleanFeatures = features.filter((feature) => {
  const op = feature?.inputParams?.boolean?.operation;
  const opCanonical = String(op || 'NONE').toUpperCase();
  const targets = feature?.inputParams?.boolean?.targets;
  const targetCount = Array.isArray(targets) ? targets.filter(Boolean).length : 0;
  return opCanonical !== 'NONE' && targetCount > 0;
});

if (listOnly) {
  console.log(`Part file: ${candidatePath}`);
  console.log(`Total features: ${features.length}`);
  if (features.length) {
    features.forEach((feature, idx) => {
      const id = feature?.inputParams?.featureID ?? '(no id)';
      console.log(
        `${String(idx + 1).padStart(2, '0')}. ${id}  type=${feature?.type || '??'}`
      );
    });
  }
  if (booleanFeatures.length === 0) {
    console.log('No boolean-bearing features detected.');
  } else {
    console.log('\nBoolean-bearing features:');
    for (const feature of booleanFeatures) {
      const id = feature?.inputParams?.featureID ?? '(no id)';
      const op = feature?.inputParams?.boolean?.operation ?? 'NONE';
      const targets = feature?.inputParams?.boolean?.targets ?? [];
      console.log(` - ${id}: op=${op}, targets=${JSON.stringify(targets)}`);
    }
  }
  process.exit(0);
}

const defaultFilters = booleanFeatures
  .map(f => f?.inputParams?.featureID)
  .filter(id => id != null)
  .map(id => String(id));

if (!process.env.DEBUG_BOOLEAN) {
  const combined = new Set([...defaultFilters, ...manualFeatureFilters]);
  if (combined.size) {
    process.env.DEBUG_BOOLEAN = Array.from(combined).join(',');
  }
}

const { PartHistory } = await import('../PartHistory.js');

const partHistory = new PartHistory();
await partHistory.fromJSON(partJSON);
if (stopAfter) {
  partHistory.currentHistoryStepId = stopAfter;
}

const featureIndex = new Map();
features.forEach((feature, idx) => {
  const id = feature?.inputParams?.featureID;
  if (id != null) featureIndex.set(String(id), { feature, index: idx });
});

const summarizeSolid = (solid) => {
  if (!solid || typeof solid !== 'object') return { name: '(null)' };
  const summary = {
    name: solid.name || solid.owningFeatureID || solid.id || solid.uuid || '(unnamed)',
  };
  if (solid.owningFeatureID && solid.owningFeatureID !== summary.name) {
    summary.owningFeatureID = solid.owningFeatureID;
  }
  try {
    const vp = solid._vertProperties;
    if (Array.isArray(vp)) summary.vertexCount = Math.floor(vp.length / 3);
  } catch { }
  try {
    const tris = solid._triVerts || solid._triangles;
    if (Array.isArray(tris)) summary.triangleCount = Math.floor(tris.length / 3);
  } catch { }
  return summary;
};

partHistory.callbacks.run = async (featureID) => {
  const meta = featureIndex.get(String(featureID));
  const idx = meta?.index ?? -1;
  const label = (idx >= 0) ? `${idx + 1}/${features.length}` : `?/ ${features.length}`;
  const type = meta?.feature?.type || 'unknown';
  console.log(`[debugBoolean] Running ${label} → ${featureID} (${type})`);
};

const startedAt = Date.now();
try {
  await partHistory.runHistory();
} catch (err) {
  console.error('[debugBoolean] PartHistory.runHistory failed:', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exitCode = 1;
  process.exit(1);
}
const durationMs = Date.now() - startedAt;
console.log(`[debugBoolean] runHistory complete in ${durationMs} ms`);

const formatEffectsSummary = (effects) => {
  if (!effects || typeof effects !== 'object') return { added: 0, removed: 0 };
  const added = Array.isArray(effects.added) ? effects.added.length : 0;
  const removed = Array.isArray(effects.removed) ? effects.removed.length : 0;
  return { added, removed };
};

console.log('\n[debugBoolean] Feature outcomes:');
partHistory.features.forEach((feature, idx) => {
  const id = feature?.inputParams?.featureID ?? '(no id)';
  const lastRun = feature?.lastRun;
  const ok = lastRun?.ok ?? false;
  const status = ok ? 'OK ' : 'ERR';
  const duration = lastRun ? `${lastRun.durationMs ?? 0}ms` : 'n/a';
  const effectsSummary = formatEffectsSummary(feature?.effects);
  let line = `${String(idx + 1).padStart(2, '0')}. [${status}] ${id} (${feature?.type || 'unknown'})`;
  line += ` | t=${duration} | added=${effectsSummary.added} removed=${effectsSummary.removed}`;
  if (!ok && lastRun?.error?.message) {
    line += ` | error=${lastRun.error.message}`;
  }
  console.log(line);
  if (verbose) {
    if (feature?.effects?.added?.length) {
      console.log('    added:', feature.effects.added.map(summarizeSolid));
    }
    if (feature?.effects?.removed?.length) {
      console.log('    removed:', feature.effects.removed.map(summarizeSolid));
    }
  }
});

const solids = (partHistory.scene?.children || []).filter(obj => obj?.type === 'SOLID');
if (solids.length) {
  console.log('\n[debugBoolean] Solids in scene after run:');
  solids.forEach((solid, idx) => {
    const summary = summarizeSolid(solid);
    console.log(` - ${idx + 1}: ${summary.name} ${JSON.stringify(summary)}`);
  });
} else {
  console.log('\n[debugBoolean] No solids present in the scene after run.');
}

if (!process.env.DEBUG_BOOLEAN) {
  console.log('\n[debugBoolean] Tip: set DEBUG_BOOLEAN env var or pass --feature=ID for detailed CSG tracing.');
} else {
  console.log(`\n[debugBoolean] DEBUG_BOOLEAN=${process.env.DEBUG_BOOLEAN}`);
}
