const DEFAULT_PMI_STYLE = Object.freeze({
  lineColor: 0x93c5fd,
  dotColor: 0x93c5fd,
  arrowColor: 0x93c5fd,
  arrowLengthPx: 12,
  arrowWidthPx: 4,
  leaderDotRadiusPx: 6,
  noteDotRadius: 0.08,
  noteDotColor: 0x93c5fd,
});

let currentStyle = { ...DEFAULT_PMI_STYLE };

export function getPMIStyle() {
  return currentStyle;
}

export function setPMIStyle(overrides = {}) {
  if (!overrides || typeof overrides !== 'object') return currentStyle;
  currentStyle = { ...currentStyle, ...overrides };
  return currentStyle;
}

export function sanitizePMIStyle(raw = {}) {
  const out = { ...DEFAULT_PMI_STYLE };
  const assign = (key, fallback) => {
    const v = raw[key];
    if (Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'string' && key.toLowerCase().includes('color')) {
      const n = parseInt(v.replace('#', ''), 16);
      if (Number.isFinite(n)) out[key] = n;
    } else if (v != null) out[key] = fallback;
  };
  assign('lineColor', DEFAULT_PMI_STYLE.lineColor);
  assign('dotColor', DEFAULT_PMI_STYLE.dotColor);
  assign('arrowColor', DEFAULT_PMI_STYLE.arrowColor);
  assign('arrowLengthPx', DEFAULT_PMI_STYLE.arrowLengthPx);
  assign('arrowWidthPx', DEFAULT_PMI_STYLE.arrowWidthPx);
  assign('leaderDotRadiusPx', DEFAULT_PMI_STYLE.leaderDotRadiusPx);
  assign('lineWidth', DEFAULT_PMI_STYLE.lineWidth || 1);
  assign('noteDotRadius', DEFAULT_PMI_STYLE.noteDotRadius);
  assign('noteDotColor', DEFAULT_PMI_STYLE.noteDotColor);
  return out;
}
