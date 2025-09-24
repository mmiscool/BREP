// Module Worker: Fetches plugin entry from candidate URLs (preferring GitHub Raw),
// and builds a small in-memory module graph where all relative and raw.githubusercontent.com
// imports are fetched from Raw and rewritten to blob: URLs, avoiding MIME issues.
// Input:  { type: 'load', urls: string[], bases: string[], ts?: number }
// Output: { ok: true, code, usedUrl, usedBase } or { ok: false, error }

const RAW_HOST = 'raw.githubusercontent.com';

function isRawUrl(u) {
  try { return new URL(u).hostname === RAW_HOST; } catch { return false; }
}

function dirOf(u) {
  try { return new URL('.', u).href; } catch { return u; }
}

function normalize(u) {
  try {
    const url = new URL(u);
    // strip query/hash for graph keys
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return u; }
}

// Find string-literal specifiers in static and dynamic imports
function findSpecifiers(code) {
  const out = [];
  const reStatic = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?(["'])([^"']+)(\1)/g;
  const reDyn = /\bimport\s*\(\s*(["'])([^"']+)(\1)\s*\)/g;
  let m;
  while ((m = reStatic.exec(code))) {
    const q = m[1];
    const spec = m[2];
    out.push({ kind: 'static', q, spec });
  }
  while ((m = reDyn.exec(code))) {
    const q = m[1];
    const spec = m[2];
    out.push({ kind: 'dynamic', q, spec });
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
  return res.text();
}

// Build module graph, rewriting target module code to import blob: URLs for its deps.
async function buildGraph(entryUrl) {
  const blobBySrc = new Map(); // srcAbs -> blobUrl
  const codeBySrc = new Map(); // srcAbs -> rewritten code
  const loading = new Set();

  async function loadModule(srcAbs) {
    const key = normalize(srcAbs);
    if (blobBySrc.has(key)) return blobBySrc.get(key);
    if (loading.has(key)) {
      // Circular import: emit minimal stub to break the cycle.
      const stub = URL.createObjectURL(new Blob([`export {};`], { type: 'application/javascript' }));
      blobBySrc.set(key, stub);
      return stub;
    }
    loading.add(key);
    const rawCode = await fetchText(srcAbs);
    const baseDir = dirOf(srcAbs);
    const specs = findSpecifiers(rawCode).filter(s => s && typeof s.spec === 'string');

    // Determine which specifiers we will fetch and rewrite: relative or raw absolute.
    const targets = [];
    for (const s of specs) {
      const spec = s.spec.trim();
      if (!spec) continue;
      const isRel = spec.startsWith('.') || spec.startsWith('..');
      const isRawAbs = spec.startsWith('http://') || spec.startsWith('https://') ? isRawUrl(spec) : false;
      if (!isRel && !isRawAbs) continue;
      const abs = isRel ? new URL(spec, baseDir).href : spec;
      targets.push({ lit: spec, abs });
    }

    // Deduplicate by absolute URL
    const uniq = new Map();
    for (const t of targets) { const k = normalize(t.abs); if (!uniq.has(k)) uniq.set(k, t); }

    // Recursively load children first
    const mapLitToBlob = new Map();
    for (const [k, t] of uniq.entries()) {
      const childBlob = await loadModule(t.abs);
      mapLitToBlob.set(t.lit, childBlob);
    }

    // Rewrite code: replace each matched literal spec with its blob URL
    let out = rawCode;
    // Static
    out = out.replace(/\b(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?(["'])([^"']+)(\1)/g, (m, q, spec) => {
      const repl = mapLitToBlob.get(spec);
      if (repl) return m.replace(`${q}${spec}${q}`, `${q}${repl}${q}`);
      // If relative import and base is raw, rewrite to absolute raw so it resolves consistently
      if (spec.startsWith('.') || spec.startsWith('..')) {
        try { const abs = new URL(spec, baseDir).href; return m.replace(`${q}${spec}${q}`, `${q}${abs}${q}`); } catch {}
      }
      return m;
    });
    // Dynamic
    out = out.replace(/\bimport\s*\(\s*(["'])([^"']+)(\1)\s*\)/g, (m, q, spec) => {
      const repl = mapLitToBlob.get(spec);
      if (repl) return m.replace(`${q}${spec}${q}`, `${q}${repl}${q}`);
      if (spec.startsWith('.') || spec.startsWith('..')) {
        try { const abs = new URL(spec, baseDir).href; return m.replace(`${q}${spec}${q}`, `${q}${abs}${q}`); } catch {}
      }
      return m;
    });

    // Create blob for this module
    const blob = URL.createObjectURL(new Blob([out], { type: 'application/javascript' }));
    blobBySrc.set(key, blob);
    codeBySrc.set(key, out);
    loading.delete(key);
    return blob;
  }

  const entryBlob = await loadModule(entryUrl);
  // Return the rewritten code of the entry so the main thread can wrap or import it.
  const entryCode = codeBySrc.get(normalize(entryUrl)) || '';
  return { code: entryCode, entryBlob };
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
      // Build a blob-based module graph starting at the chosen candidate URL.
      const { code } = await buildGraph(url);
      self.postMessage({ ok: true, code, usedUrl: url, usedBase: base });
      return;
    } catch (e) {
      lastErr = e;
      // try next candidate
    }
  }
  self.postMessage({ ok: false, error: String(lastErr || 'Failed to load plugin') });
});
