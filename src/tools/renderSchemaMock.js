const EXCLUDED_KEYS = new Set(['featureID']);

/**
 * Create a stylized canvas rendering of a feature dialog schema.
 * Returns { dataUrl, width, height } in CSS pixels.
 */
export function renderSchemaMock(featureName, schema, options = {}) {
  const scale = Number.isFinite(options.scale) ? options.scale : 2;
  const targetWidth = Number.isFinite(options.width) ? options.width : 520;
  const padding = Number.isFinite(options.padding) ? options.padding : 28;
  const gap = Number.isFinite(options.gap) ? options.gap : 18;
  const controlHeight = Number.isFinite(options.controlHeight) ? options.controlHeight : 44;
  const showHints = Object.prototype.hasOwnProperty.call(options, 'showHints') ? Boolean(options.showHints) : false;
  const showSubtitle = Object.prototype.hasOwnProperty.call(options, 'showSubtitle') ? Boolean(options.showSubtitle) : true;

  const fields = Object.entries(schema || {})
    .filter(([key]) => !EXCLUDED_KEYS.has(key))
    .map(([key, def]) => ({ key, def: def && typeof def === 'object' ? def : {} }));

  const measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) throw new Error('Canvas 2D context unavailable');
  const labelFont = '600 16px "Inter", "Segoe UI", system-ui, sans-serif';
  const valueFont = '500 15px "Inter", "Segoe UI", system-ui, sans-serif';
  const hintFont = '400 13px "Inter", "Segoe UI", system-ui, sans-serif';
  const headerFont = '700 24px "Inter", "Segoe UI", system-ui, sans-serif';

  measureCtx.font = valueFont;

  const innerWidth = targetWidth - padding * 2;
  const layouts = [];
  const titleBaseline = padding + 32;
  const subtitleBaseline = titleBaseline + 22;
  const firstFieldOffset = showSubtitle ? subtitleBaseline + 30 : titleBaseline + 30;
  let cursorY = firstFieldOffset;

  for (const { key, def } of fields) {
    const label = _labelForField(key, def);
    const typeLabel = options.showTypes ? _typeLabel(def.type) : '';
    const valueSample = _valueSample(def);
    const hintLines = showHints && def.hint
      ? _wrapLines(measureCtx, String(def.hint), innerWidth, hintFont)
      : [];
    const labelBlockHeight = typeLabel ? 32 : 24;
    const fieldBlockHeight = labelBlockHeight + controlHeight + (hintLines.length ? 8 + hintLines.length * 18 : 0);
    layouts.push({ key, label, typeLabel, valueSample, hintLines, top: cursorY });
    cursorY += fieldBlockHeight + gap;
  }

  const totalHeight = Math.max(cursorY - gap + padding, padding * 2 + 120);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(targetWidth * scale);
  canvas.height = Math.round(totalHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.scale(scale, scale);

  // Background gradient
  const gradient = ctx.createLinearGradient(0, 0, 0, totalHeight);
  gradient.addColorStop(0, '#0a0f1c');
  gradient.addColorStop(1, '#04060b');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, targetWidth, totalHeight);

  // Card background
  ctx.fillStyle = 'rgba(17, 24, 39, 0.92)';
  _roundRect(ctx, padding / 2, padding / 2, targetWidth - padding, totalHeight - padding, 18, true, false);

  // Header text
  ctx.font = headerFont;
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(featureName, padding, titleBaseline);
  if (showSubtitle) {
    ctx.font = '500 14px "Inter", "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Auto-generated feature dialog overview', padding, subtitleBaseline);
  }

  for (const layout of layouts) {
    const top = layout.top;
    const boxY = top + 16;

    // Label + type
    ctx.font = labelFont;
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(layout.label, padding, top);
    if (layout.typeLabel) {
      ctx.font = '500 13px "Inter", "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#64748b';
      ctx.fillText(layout.typeLabel, padding, top + 18);
    }

    // Control box
    const boxWidth = innerWidth;
    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.lineWidth = 1.5;
    _roundRect(ctx, padding, boxY, boxWidth, controlHeight, 12, true, true);

    // Value sample text
    ctx.font = valueFont;
    ctx.fillStyle = '#cbd5f5';
    const textY = boxY + controlHeight / 2 + 6;
    const truncated = _truncateToWidth(ctx, layout.valueSample, boxWidth - 24);
    ctx.fillText(truncated, padding + 12, textY);

    // Hint text
    if (layout.hintLines.length) {
      ctx.font = hintFont;
      ctx.fillStyle = '#8ba0c2';
      let hintY = boxY + controlHeight + 18;
      for (const line of layout.hintLines) {
        ctx.fillText(line, padding, hintY);
        hintY += 18;
      }
    }
  }

  const dataUrl = canvas.toDataURL('image/png');
  return { dataUrl, width: targetWidth * scale, height: totalHeight * scale };
}

function _labelForField(key, def) {
  if (def.label) return String(def.label);
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function _typeLabel(type) {
  const map = {
    number: 'number',
    string: 'text',
    boolean: 'toggle',
    button: 'action',
    options: 'select',
    reference_selection: 'reference',
    transform: 'transform',
    file: 'file upload',
    boolean_operation: 'boolean op',
    array: 'list',
  };
  return `Type: ${map[type] || (type ? String(type) : 'value')}`;
}

function _valueSample(def) {
  if (def.type === 'boolean') {
    return def.default_value ? 'Enabled' : 'Disabled';
  }
  if (def.type === 'number') {
    if (def.default_value == null) return '0';
    return String(def.default_value);
  }
  if (def.type === 'button') {
    return def.label ? `${def.label}` : 'Run Action';
  }
  if (def.type === 'reference_selection') {
    return def.multiple ? 'Add selections…' : 'Pick from scene…';
  }
  if (def.type === 'options' && Array.isArray(def.options) && def.options.length) {
    const first = def.options.find((opt) => typeof opt === 'string') || def.options[0];
    if (first && typeof first === 'object') return String(first.label || first.value || 'Option');
    return String(first);
  }
  if (def.type === 'transform') {
    return 'Translate / Rotate / Scale';
  }
  if (def.type === 'file') {
    return def.default_value ? 'File loaded' : 'Choose file…';
  }
  if (def.type === 'boolean_operation') {
    return 'Operation: None';
  }
  if (def.default_value != null && def.default_value !== '') {
    if (typeof def.default_value === 'object') return 'Configured';
    return String(def.default_value);
  }
  return 'Enter value…';
}

function _wrapLines(measureCtx, text, maxWidth, hintFont) {
  if (!text) return [];
  measureCtx.font = hintFont;
  const lines = [];
  const paragraphs = String(text).split(/\n+/);
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = '';
    for (const word of words) {
      const tentative = current ? `${current} ${word}` : word;
      if (measureCtx.measureText(tentative).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = tentative;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function _truncateToWidth(ctx, text, maxWidth) {
  if (!text) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 0 && ctx.measureText(`${truncated}…`).width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

function _roundRect(ctx, x, y, width, height, radius, fill, stroke) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}
