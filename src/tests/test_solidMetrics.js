// Builds a rectangular prism and validates Solid.volume(), Solid.surfaceArea(),
// Face.surfaceArea(), and Edge.length() via console output.
export async function test_solidMetrics(partHistory) {
  const cube = await partHistory.newFeature("P.CU");
  cube.inputParams.sizeX = 2;
  cube.inputParams.sizeY = 3;
  cube.inputParams.sizeZ = 4;
  // Name will be the featureID; visualize() is called by the feature implementation.
  return partHistory;
}

export async function afterRun_solidMetrics(partHistory) {
  try {
    const solids = (partHistory.scene?.children || []).filter(o => o && o.type === 'SOLID');
    if (!solids.length) { console.warn('[solidMetrics] No solids in scene.'); return; }
    const solid = solids[0];

    const X = 2, Y = 3, Z = 4;
    const expectedVolume = X * Y * Z; // 24
    const expectedSurfaceArea = 2 * (X * Y + Y * Z + Z * X); // 52

    const vol = typeof solid.volume === 'function' ? solid.volume() : NaN;
    const sa = typeof solid.surfaceArea === 'function' ? solid.surfaceArea() : NaN;

    const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
    const fmt = (n) => Number.isFinite(n) ? n.toFixed(6) : String(n);

    console.log(`[solidMetrics] Solid volume: ${fmt(vol)} (expected ${fmt(expectedVolume)}) ${approx(vol, expectedVolume) ? 'OK' : 'MISMATCH'}`);
    console.log(`[solidMetrics] Solid surface area: ${fmt(sa)} (expected ${fmt(expectedSurfaceArea)}) ${approx(sa, expectedSurfaceArea) ? 'OK' : 'MISMATCH'}`);

    // Face areas by suffix: NX/PX = Y*Z, NY/PY = X*Z, NZ/PZ = X*Y
    const faces = solid.children.filter(ch => ch?.type === 'FACE');
    const faceAreaBySuffix = new Map([
      ['_NX', Y * Z],
      ['_PX', Y * Z],
      ['_NY', X * Z],
      ['_PY', X * Z],
      ['_NZ', X * Y],
      ['_PZ', X * Y],
    ]);
    for (const f of faces) {
      const name = String(f?.name || '');
      const suffix = Array.from(faceAreaBySuffix.keys()).find(suf => name.endsWith(suf));
      if (!suffix) continue;
      const area = typeof f.surfaceArea === 'function' ? f.surfaceArea() : NaN;
      const expected = faceAreaBySuffix.get(suffix);
      console.log(`[solidMetrics] Face ${name} area: ${fmt(area)} (expected ${fmt(expected)}) ${approx(area, expected) ? 'OK' : 'MISMATCH'}`);
    }

    // Edge lengths: should be one of {X, Y, Z}
    const edges = solid.children.filter(ch => ch?.type === 'EDGE');
    const lens = edges.map(e => (typeof e.length === 'function') ? e.length() : NaN);
    const uniq = Array.from(new Set(lens.map(v => Number.isFinite(v) ? v.toFixed(6) : String(v))));
    console.log(`[solidMetrics] Distinct edge lengths: ${uniq.join(', ')} (expected ${[X,Y,Z].map(n=>n.toFixed(6)).join(', ')})`);
  } catch (e) {
    console.warn('[solidMetrics] afterRun error:', e?.message || e);
  }
}
