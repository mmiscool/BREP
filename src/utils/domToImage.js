// Minimal DOM → PNG renderer tailored for feature dialog capture tooling.
// Inspired by dom-to-image (MIT); rewritten for ES modules and simplified needs.

/**
 * Capture a DOM node as a PNG data URL.
 * @param {HTMLElement} node - The element to capture.
 * @param {Object} [options]
 * @param {number} [options.scale] - Multiplier applied to the output resolution. Defaults to devicePixelRatio or 2.
 * @param {number} [options.padding] - Padding (px) around the node in the captured image. Defaults to 24.
 * @param {string} [options.bgColor] - Background color for the capture. Defaults to the computed background or #0b0f16.
 * @param {number} [options.quality] - PNG quality (0-1). Defaults to 1.
 * @returns {Promise<{ dataUrl: string, width: number, height: number }>} PNG data URL and canvas size.
 */
export async function domNodeToPng(node, options = {}) {
  if (!node || typeof node !== 'object') {
    throw new Error('domNodeToPng requires a DOM node.');
  }

  const { width, height } = _computeNodeSize(node, options);
  const padding = Number.isFinite(options.padding) ? Number(options.padding) : 24;
  const scale = Number.isFinite(options.scale) ? Number(options.scale) : (window.devicePixelRatio || 2);
  const bgColor = typeof options.bgColor === 'string' ? options.bgColor : _fallbackBackground(node) || '#0b0f16';
  const quality = Number.isFinite(options.quality) ? Number(options.quality) : 1;

  // Clone the node and inline styles so the cloned markup can be serialized in isolation.
  const clone = node.cloneNode(true);
  _copyInputState(node, clone);
  _inlineComputedStyles(node, clone);

  // Wrap in a XHTML container with padding + background to make foreignObject rendering reliable.
  const wrapper = document.createElement('div');
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.style.boxSizing = 'border-box';
  wrapper.style.padding = `${padding}px`;
  wrapper.style.background = bgColor;
  wrapper.style.width = `${Math.ceil(width)}px`;
  wrapper.style.height = `${Math.ceil(height)}px`;
  wrapper.appendChild(clone);

  await _inlineExternalResources(wrapper);

  const svgWidth = Math.ceil(width + padding * 2);
  const svgHeight = Math.ceil(height + padding * 2);
  const serialized = new XMLSerializer().serializeToString(wrapper);
  const svg = _svgTemplate(svgWidth, svgHeight, serialized);

  if (document.fonts && typeof document.fonts.ready === 'object') {
    try { await document.fonts.ready; } catch (_) { /* ignore */ }
  }

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const image = await _loadImage(url);
    const canvasWidth = Math.max(1, Math.round(svgWidth * scale));
    const canvasHeight = Math.max(1, Math.round(svgHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.drawImage(image, 0, 0, canvasWidth, canvasHeight);
    const dataUrl = canvas.toDataURL('image/png', quality);
    return { dataUrl, width: canvasWidth, height: canvasHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function _computeNodeSize(node, options) {
  const rect = (node instanceof Element) ? node.getBoundingClientRect() : null;
  let width = Number.isFinite(options.width) ? Number(options.width) : rect?.width;
  let height = Number.isFinite(options.height) ? Number(options.height) : rect?.height;
  if (!width || width <= 0) {
    width = (node instanceof HTMLElement) ? node.offsetWidth || node.scrollWidth : 0;
  }
  if (!height || height <= 0) {
    height = (node instanceof HTMLElement) ? node.offsetHeight || node.scrollHeight : 0;
  }
  return {
    width: Math.max(1, Math.ceil(width || 1)),
    height: Math.max(1, Math.ceil(height || 1)),
  };
}

function _fallbackBackground(node) {
  if (!(node instanceof Element)) return '#0b0f16';
  let el = node;
  while (el && el !== document.documentElement) {
    const bg = window.getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    el = el.parentElement;
  }
  return '#0b0f16';
}

function _loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(new Error(`Failed to load generated SVG: ${err?.message || err}`));
    img.src = url;
  });
}

function _svgTemplate(width, height, markup) {
  return `<?xml version="1.0" standalone="no"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
}

function _inlineComputedStyles(source, target) {
  if (!source || !target) return;
  if (source instanceof Element && target instanceof Element) {
    const computed = window.getComputedStyle(source);
    const targetStyle = target.style;
    for (let i = 0; i < computed.length; i++) {
      const prop = computed[i];
      const value = computed.getPropertyValue(prop);
      if (value && typeof value === 'string' && value.toLowerCase().includes('url(')) {
        continue; // skip properties that reference external resources to avoid canvas tainting
      }
      try {
        targetStyle.setProperty(prop, value, computed.getPropertyPriority(prop));
      } catch (_) { /* ignore */ }
    }
    // Ensure CSS custom properties are copied even if not enumerated
    // Avoid copying cssText wholesale; it may include url() values that taint the canvas.
  }

  const srcChildren = source.childNodes || [];
  const tgtChildren = target.childNodes || [];
  for (let i = 0; i < srcChildren.length; i++) {
    _inlineComputedStyles(srcChildren[i], tgtChildren[i]);
  }
}

async function _inlineExternalResources(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  const canvases = Array.from(root.querySelectorAll('canvas'));
  for (const canvas of canvases) {
    let dataUrl = null;
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (_) {
      dataUrl = null;
    }
    const img = document.createElement('img');
    if (dataUrl) {
      img.src = dataUrl;
    } else {
      img.src = _transparentPixel();
      img.setAttribute('data-placeholder', 'canvas');
    }
    const rect = (typeof canvas.getBoundingClientRect === 'function') ? canvas.getBoundingClientRect() : { width: 0, height: 0 };
    const cssWidth = rect.width || Number.parseFloat(canvas.style?.width) || canvas.width;
    const cssHeight = rect.height || Number.parseFloat(canvas.style?.height) || canvas.height;
    if (cssWidth) img.style.width = `${cssWidth}px`;
    if (cssHeight) img.style.height = `${cssHeight}px`;
    img.width = canvas.width || cssWidth || 1;
    img.height = canvas.height || cssHeight || 1;
    img.style.objectFit = 'contain';
    canvas.replaceWith(img);
  }

  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(images.map(async (img) => {
    const src = img.getAttribute('src') || '';
    if (!src) return;
    if (src.startsWith('data:')) return;
    try {
      const dataUrl = await _imageToDataURL(src);
      if (dataUrl) {
        img.setAttribute('src', dataUrl);
      } else {
        img.setAttribute('src', _transparentPixel());
      }
    } catch (err) {
      console.warn('[domNodeToPng] Failed to inline image', src, err);
      img.setAttribute('src', _transparentPixel());
    }
    img.removeAttribute('srcset');
  }));

  const elements = Array.from(root.querySelectorAll('*'));
  for (const el of elements) {
    // Strip attributes that can introduce external resources
    const attrs = ['src', 'href', 'poster'];
    for (const attr of attrs) {
      if (!el.hasAttribute(attr)) continue;
      const val = el.getAttribute(attr) || '';
      if (!val) continue;
      if (!val.startsWith('data:')) {
        if (attr === 'src' && el.tagName === 'IMG') continue; // handled above
        el.setAttribute(attr, attr === 'href' ? 'about:blank' : _transparentPixel());
      }
    }

    // Remove inline styles that reference URL assets
    const styleAttr = el.getAttribute && el.getAttribute('style');
    if (styleAttr && /url\(/i.test(styleAttr)) {
      const cleaned = styleAttr.replace(/[^;]*url\([^)]*\)[^;]*;?/gi, '');
      if (cleaned.trim().length) el.setAttribute('style', cleaned);
      else el.removeAttribute('style');
    }

    // Collapse potentially unsafe elements
    if (el.tagName === 'IFRAME' || el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
      el.replaceWith(document.createElement('div'));
    }
  }
}

let __blankPixel = null;
function _transparentPixel() {
  if (__blankPixel) return __blankPixel;
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  __blankPixel = c.toDataURL('image/png');
  return __blankPixel;
}

async function _imageToDataURL(src) {
  const img = await new Promise((resolve, reject) => {
    const tmp = new Image();
    if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      tmp.crossOrigin = 'anonymous';
    }
    tmp.onload = () => resolve(tmp);
    tmp.onerror = (err) => reject(err);
    tmp.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width || 1;
  canvas.height = img.naturalHeight || img.height || 1;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.warn('[domNodeToPng] Failed to draw image for data URL', src, err);
    return null;
  }
}

function _copyInputState(source, target) {
  if (!source || !target) return;
  if (source instanceof HTMLInputElement && target instanceof HTMLInputElement) {
    target.value = source.value;
    target.setAttribute('value', source.value);
    if (source.type === 'checkbox' || source.type === 'radio') {
      target.checked = source.checked;
      if (source.checked) target.setAttribute('checked', '');
      else target.removeAttribute('checked');
    }
  } else if (source instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement) {
    target.value = source.value;
    target.textContent = source.value;
  } else if (source instanceof HTMLSelectElement && target instanceof HTMLSelectElement) {
    target.value = source.value;
    const optsSrc = source.options || [];
    const optsTgt = target.options || [];
    for (let i = 0; i < optsSrc.length; i++) {
      const srcOpt = optsSrc[i];
      const tgtOpt = optsTgt[i];
      if (!srcOpt || !tgtOpt) continue;
      tgtOpt.selected = srcOpt.selected;
      if (srcOpt.selected) tgtOpt.setAttribute('selected', '');
      else tgtOpt.removeAttribute('selected');
    }
  }

  const srcChildren = source.childNodes || [];
  const tgtChildren = target.childNodes || [];
  for (let i = 0; i < srcChildren.length; i++) {
    _copyInputState(srcChildren[i], tgtChildren[i]);
  }
}
