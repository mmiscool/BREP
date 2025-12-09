import { ThreadStandard } from '../../BREP/threadGeometry.js';

const MM_PER_INCH = 25.4;

const normalizeKey = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

// ISO 273 style clearance holes (fine=close, normal, coarse=loose)
const METRIC_CLEARANCE = {
  'M2': { CLOSE: 2.2, NORMAL: 2.4, LOOSE: 2.6 },
  'M2.5': { CLOSE: 2.8, NORMAL: 3.0, LOOSE: 3.2 },
  'M3': { CLOSE: 3.2, NORMAL: 3.4, LOOSE: 3.6 },
  'M4': { CLOSE: 4.3, NORMAL: 4.5, LOOSE: 4.8 },
  'M5': { CLOSE: 5.3, NORMAL: 5.5, LOOSE: 5.8 },
  'M6': { CLOSE: 6.4, NORMAL: 6.6, LOOSE: 7.0 },
  'M8': { CLOSE: 8.4, NORMAL: 9.0, LOOSE: 10.0 },
  'M10': { CLOSE: 10.5, NORMAL: 11.0, LOOSE: 12.0 },
  'M12': { CLOSE: 13.0, NORMAL: 13.5, LOOSE: 14.0 },
  'M16': { CLOSE: 17.0, NORMAL: 18.0, LOOSE: 19.0 },
  'M20': { CLOSE: 21.0, NORMAL: 22.0, LOOSE: 24.0 },
  'M24': { CLOSE: 25.0, NORMAL: 26.0, LOOSE: 28.0 },
  'M30': { CLOSE: 32.0, NORMAL: 33.0, LOOSE: 35.0 },
};

// Typical UNC/UNF clearance holes (in inches); converted to mm on read.
const UNIFIED_CLEARANCE = {
  '#2-56': { CLOSE: 0.089, NORMAL: 0.096, LOOSE: 0.106 },
  '#4-40': { CLOSE: 0.116, NORMAL: 0.128, LOOSE: 0.144 },
  '#6-32': { CLOSE: 0.140, NORMAL: 0.149, LOOSE: 0.169 },
  '#8-32': { CLOSE: 0.169, NORMAL: 0.182, LOOSE: 0.201 },
  '#8-36': { CLOSE: 0.169, NORMAL: 0.182, LOOSE: 0.201 },
  '#10-24': { CLOSE: 0.196, NORMAL: 0.201, LOOSE: 0.221 },
  '#10-32': { CLOSE: 0.196, NORMAL: 0.201, LOOSE: 0.221 },
  '1/4-20': { CLOSE: 0.257, NORMAL: 0.266, LOOSE: 0.281 },
  '1/4-28': { CLOSE: 0.257, NORMAL: 0.266, LOOSE: 0.281 },
  '5/16-18': { CLOSE: 0.320, NORMAL: 0.332, LOOSE: 0.352 },
  '5/16-24': { CLOSE: 0.320, NORMAL: 0.332, LOOSE: 0.352 },
  '3/8-16': { CLOSE: 0.385, NORMAL: 0.397, LOOSE: 0.421 },
  '3/8-24': { CLOSE: 0.385, NORMAL: 0.397, LOOSE: 0.421 },
  '7/16-14': { CLOSE: 0.438, NORMAL: 0.453, LOOSE: 0.484 },
  '7/16-20': { CLOSE: 0.438, NORMAL: 0.453, LOOSE: 0.484 },
  '1/2-13': { CLOSE: 0.515, NORMAL: 0.531, LOOSE: 0.562 },
  '1/2-20': { CLOSE: 0.515, NORMAL: 0.531, LOOSE: 0.562 },
  '5/8-11': { CLOSE: 0.642, NORMAL: 0.656, LOOSE: 0.688 },
  '5/8-18': { CLOSE: 0.642, NORMAL: 0.656, LOOSE: 0.688 },
  '3/4-10': { CLOSE: 0.769, NORMAL: 0.781, LOOSE: 0.812 },
  '3/4-16': { CLOSE: 0.769, NORMAL: 0.781, LOOSE: 0.812 },
  '7/8-9': { CLOSE: 0.885, NORMAL: 0.906, LOOSE: 0.938 },
  '1-8': { CLOSE: 1.027, NORMAL: 1.063, LOOSE: 1.094 },
  '1-12': { CLOSE: 1.027, NORMAL: 1.063, LOOSE: 1.094 },
};

function lookupUnified(designation, fit) {
  const key = normalizeKey(designation);
  for (const raw in UNIFIED_CLEARANCE) {
    if (!Object.prototype.hasOwnProperty.call(UNIFIED_CLEARANCE, raw)) continue;
    const candidate = normalizeKey(raw);
    if (candidate === key) {
      const diam = UNIFIED_CLEARANCE[raw]?.[fit];
      return typeof diam === 'number' ? diam * MM_PER_INCH : null;
    }
  }
  return null;
}

function lookupMetric(designation, fit) {
  const key = normalizeKey(designation).replace(/X.+$/, ''); // strip pitch, keep base size
  if (METRIC_CLEARANCE[key] && typeof METRIC_CLEARANCE[key][fit] === 'number') {
    return METRIC_CLEARANCE[key][fit];
  }
  return null;
}

export function getClearanceDiameter({ standard, designation, fit }) {
  const fitKey = String(fit || 'NONE').toUpperCase();
  if (fitKey === 'NONE') return null;
  if (!designation) return null;
  const std = String(standard || '').toUpperCase();
  if (std === ThreadStandard.UNIFIED) {
    return lookupUnified(designation, fitKey);
  }
  if (std === ThreadStandard.ISO_METRIC || std === ThreadStandard.TRAPEZOIDAL_METRIC) {
    return lookupMetric(designation, fitKey);
  }
  // fallback: try metric-style lookup anyway
  return lookupMetric(designation, fitKey) || lookupUnified(designation, fitKey);
}
