// Module Worker: Fetches plugin entry from candidate URLs (e.g., GitHub Raw, jsDelivr)
// and rewrites relative imports to absolute URLs based on the matching base.
// Input message: { type: 'load', urls: string[], bases: string[] }
// - Tries each urls[i] in order, using bases[i] as the base for rewriting
// Output message: { ok: true, code, usedUrl, usedBase } or { ok: false, error }

function rewriteRelativeImports(code, base) {
  // Ensure base ends with slash for proper URL resolution
  const baseUrl = base.endsWith('/') ? base : (base + '/');

  // Static import/export with from: import ... from '...'; export ... from '...'; and bare import '...';
  const reStatic = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?(["'])(\.[^"']*)(\1)/g;
  // Dynamic import('...')
  const reDyn = /\bimport\s*\(\s*(["'])(\.[^"']*)(\1)\s*\)/g;

  const replacer = (_m, q, spec) => {
    try {
      const abs = new URL(spec, baseUrl).href;
      return `${q}${abs}${q}`;
    } catch {
      return `${q}${spec}${q}`;
    }
  };

  let out = code.replace(reStatic, (m, q, spec, _q2) => m.replace(`${q}${spec}${q}`, replacer(m, q, spec)));
  out = out.replace(reDyn, (m, q, spec, _q2) => m.replace(`${q}${spec}${q}`, replacer(m, q, spec)));
  return out;
}

self.addEventListener('message', async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'load') return;
  const urls = Array.isArray(msg.urls) ? msg.urls : [];
  const bases = Array.isArray(msg.bases) ? msg.bases : [];
  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const base = bases[i] || '';
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const code = rewriteRelativeImports(text, base);
      self.postMessage({ ok: true, code, usedUrl: url, usedBase: base });
      return;
    } catch (e) {
      lastErr = e;
      // try next candidate
    }
  }
  self.postMessage({ ok: false, error: String(lastErr || 'Failed to load plugin') });
});
