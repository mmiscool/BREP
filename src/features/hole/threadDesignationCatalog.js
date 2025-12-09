import { ThreadStandard } from '../../BREP/threadGeometry.js';

const makeOptions = (list) => list
  .map((entry) => {
    if (typeof entry === 'string') return { value: entry, label: entry };
    if (Array.isArray(entry) && entry[0]) {
      return { value: String(entry[0]), label: String(entry[1] || entry[0]) };
    }
    return null;
  })
  .filter(Boolean);

const ISO_METRIC = makeOptions([
  ['M2x0.4', 'M2 x 0.4'],
  ['M2.5x0.45', 'M2.5 x 0.45'],
  ['M3x0.5', 'M3 x 0.5'],
  ['M4x0.7', 'M4 x 0.7'],
  ['M5x0.8', 'M5 x 0.8'],
  ['M6x1', 'M6 x 1 (coarse)'],
  ['M6x0.75', 'M6 x 0.75 (fine)'],
  ['M8x1.25', 'M8 x 1.25 (coarse)'],
  ['M8x1', 'M8 x 1 (fine)'],
  ['M10x1.5', 'M10 x 1.5 (coarse)'],
  ['M10x1.25', 'M10 x 1.25 (fine)'],
  ['M12x1.75', 'M12 x 1.75 (coarse)'],
  ['M12x1.25', 'M12 x 1.25 (fine)'],
  ['M16x2', 'M16 x 2'],
  ['M16x1.5', 'M16 x 1.5'],
  ['M20x2.5', 'M20 x 2.5'],
  ['M20x1.5', 'M20 x 1.5'],
  ['M24x3', 'M24 x 3'],
  ['M24x2', 'M24 x 2'],
  ['M30x3.5', 'M30 x 3.5'],
]);

const UNIFIED = makeOptions([
  ['#2-56UNF', '#2-56 UNF'],
  ['#4-40UNC', '#4-40 UNC'],
  ['#6-32UNC', '#6-32 UNC'],
  ['#8-32UNC', '#8-32 UNC'],
  ['#8-36UNF', '#8-36 UNF'],
  ['#10-24UNC', '#10-24 UNC'],
  ['#10-32UNF', '#10-32 UNF'],
  ['1/4-20UNC', '1/4-20 UNC'],
  ['1/4-28UNF', '1/4-28 UNF'],
  ['5/16-18UNC', '5/16-18 UNC'],
  ['5/16-24UNF', '5/16-24 UNF'],
  ['3/8-16UNC', '3/8-16 UNC'],
  ['3/8-24UNF', '3/8-24 UNF'],
  ['7/16-14UNC', '7/16-14 UNC'],
  ['7/16-20UNF', '7/16-20 UNF'],
  ['1/2-13UNC', '1/2-13 UNC'],
  ['1/2-20UNF', '1/2-20 UNF'],
  ['5/8-11UNC', '5/8-11 UNC'],
  ['5/8-18UNF', '5/8-18 UNF'],
  ['3/4-10UNC', '3/4-10 UNC'],
  ['3/4-16UNF', '3/4-16 UNF'],
  ['7/8-9UNC', '7/8-9 UNC'],
  ['1-8UNC', '1-8 UNC'],
  ['1-12UNF', '1-12 UNF'],
]);

const TRAPEZOIDAL_METRIC = makeOptions([
  ['Tr8x1.5', 'Tr8 x 1.5'],
  ['Tr10x2', 'Tr10 x 2'],
  ['Tr12x3', 'Tr12 x 3'],
  ['Tr16x4', 'Tr16 x 4'],
  ['Tr20x4', 'Tr20 x 4'],
  ['Tr20x5', 'Tr20 x 5'],
  ['Tr24x5', 'Tr24 x 5'],
  ['Tr30x6', 'Tr30 x 6'],
  ['Tr36x6', 'Tr36 x 6'],
]);

const ACME = makeOptions([
  ['1/4-16', '1/4-16 Acme'],
  ['3/8-12', '3/8-12 Acme'],
  ['1/2-10', '1/2-10 Acme'],
  ['5/8-8', '5/8-8 Acme'],
  ['3/4-6', '3/4-6 Acme'],
  ['1-5', '1-5 Acme'],
  ['1.25-5', '1.25-5 Acme'],
  ['1.5-4', '1.5-4 Acme'],
  ['2-4', '2-4 Acme'],
]);

const STUB_ACME = makeOptions([
  ['3/8-16', '3/8-16 Stub Acme'],
  ['1/2-16', '1/2-16 Stub Acme'],
  ['5/8-12', '5/8-12 Stub Acme'],
  ['3/4-12', '3/4-12 Stub Acme'],
  ['1-10', '1-10 Stub Acme'],
  ['1.25-10', '1.25-10 Stub Acme'],
  ['1.5-8', '1.5-8 Stub Acme'],
  ['2-6', '2-6 Stub Acme'],
]);

const WHITWORTH = makeOptions([
  ['1/8-40', '1/8-40 BSW'],
  ['3/16-32', '3/16-32 BSW'],
  ['1/4-20', '1/4-20 BSW'],
  ['5/16-18', '5/16-18 BSW'],
  ['3/8-16', '3/8-16 BSW'],
  ['7/16-14', '7/16-14 BSW'],
  ['1/2-12', '1/2-12 BSW'],
  ['5/8-11', '5/8-11 BSW'],
  ['3/4-10', '3/4-10 BSW'],
  ['1-8', '1-8 BSW'],
  ['1/4-26', '1/4-26 BSF'],
  ['5/16-22', '5/16-22 BSF'],
  ['3/8-20', '3/8-20 BSF'],
  ['7/16-18', '7/16-18 BSF'],
  ['1/2-16', '1/2-16 BSF'],
]);

const NPT = makeOptions([
  ['1/16-27NPT', '1/16-27 NPT'],
  ['1/8-27NPT', '1/8-27 NPT'],
  ['1/4-18NPT', '1/4-18 NPT'],
  ['3/8-18NPT', '3/8-18 NPT'],
  ['1/2-14NPT', '1/2-14 NPT'],
  ['3/4-14NPT', '3/4-14 NPT'],
  ['1-11.5NPT', '1-11.5 NPT'],
  ['1.25-11.5NPT', '1-1/4-11.5 NPT'],
  ['1.5-11.5NPT', '1-1/2-11.5 NPT'],
  ['2-11.5NPT', '2-11.5 NPT'],
]);

export const THREAD_DESIGNATION_PRESETS = {
  [ThreadStandard.ISO_METRIC]: ISO_METRIC,
  [ThreadStandard.UNIFIED]: UNIFIED,
  [ThreadStandard.TRAPEZOIDAL_METRIC]: TRAPEZOIDAL_METRIC,
  [ThreadStandard.ACME]: ACME,
  [ThreadStandard.STUB_ACME]: STUB_ACME,
  [ThreadStandard.WHITWORTH]: WHITWORTH,
  [ThreadStandard.NPT]: NPT,
};

export function normalizeThreadStandard(standard) {
  if (standard == null && standard !== 0) return 'NONE';
  return String(standard).toUpperCase();
}

export function getThreadDesignationOptions(standard) {
  const key = normalizeThreadStandard(standard);
  const list = THREAD_DESIGNATION_PRESETS[key] || [];
  // Return a shallow copy so callers cannot mutate the shared presets.
  return list.map((opt) => ({ ...opt }));
}
