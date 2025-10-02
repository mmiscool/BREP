// Lightweight GitHub plugin loader: try GitHub Raw first, then fall back to jsDelivr.

// Parse common GitHub URL shapes.
// Supports:
//  - https://github.com/USER/REPO
//  - https://github.com/USER/REPO/tree/REF
//  - https://github.com/USER/REPO/tree/REF/sub/dir
import { BREP } from "../BREP/BREP.js";
import { localStorage as LS } from "../localStorageShim.js";




export function parseGithubUrl(input) {
  const url = new URL(input);
  const parts = url.pathname.split('/').filter(Boolean);
  const user = parts[0];
  const repo = parts[1];
  let ref = null;
  let subdir = '';
  const idx = parts.indexOf('tree');
  if (idx !== -1) {
    ref = parts[idx + 1] || null;
    const rest = parts.slice(idx + 2);
    subdir = rest.length ? '/' + rest.join('/') : '';
  }
  if (!user || !repo) throw new Error('Invalid GitHub repo URL');
  return { user, repo, ref, subdir };
}

async function fetchAndPrepareEntryViaWorker(entryUrls, baseUrls, ts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ghLoader.worker.js', import.meta.url), { type: 'module' });
    const cleanup = () => { try { worker.terminate(); } catch { } };
    worker.onmessage = (ev) => {
      const data = ev.data || {};
      if (data.ok) {
        // Do NOT terminate here; caller will keep the worker alive
        // long enough for blob: dependencies to load.
        resolve({ ...data, __worker: worker, __cleanup: cleanup });
      } else {
        cleanup();
        reject(new Error(data.error || 'Worker failed'));
      }
    };
    worker.onerror = (e) => { cleanup(); reject(new Error(String(e?.message || e))); };
    worker.postMessage({ type: 'load', urls: entryUrls, bases: baseUrls, ts: ts ?? Date.now() });
  });
}

export async function importGithubPlugin(repoUrl) {
  const { user, repo, ref, subdir } = parseGithubUrl(repoUrl);
  const t = Date.now();

  // Build candidate sources in order: GitHub Raw first (ref/main/master), then jsDelivr (ref/latest)
  const entryUrls = [];
  const baseUrls = [];

  // 1) GitHub Raw candidates
  if (ref) {
    const rawBase = `https://raw.githubusercontent.com/${user}/${repo}/${ref}${subdir || ''}`;
    entryUrls.push(`${rawBase}/plugin.js?t=${t}`);
    baseUrls.push(rawBase);
  } else {
    for (const branch of ['main', 'master']) {
      const rawBase = `https://raw.githubusercontent.com/${user}/${repo}/${branch}${subdir || ''}`;
      entryUrls.push(`${rawBase}/plugin.js?t=${t}`);
      baseUrls.push(rawBase);
    }
  }

  // 2) jsDelivr fallback (prefer specific ref if provided, else @latest)
  const cdnRef = ref ? ref : 'latest';
  const jsdBase = `https://cdn.jsdelivr.net/gh/${user}/${repo}@${cdnRef}${subdir || ''}`;
  entryUrls.push(`${jsdBase}/plugin.js?t=${t}`);
  baseUrls.push(jsdBase);

  try { console.log('[PluginLoader] Candidates:', entryUrls); } catch { }
  // Web worker fetch + rewrite to absolute imports for the chosen base
  const { code, usedUrl, usedBase, __worker, __cleanup } = await fetchAndPrepareEntryViaWorker(entryUrls, baseUrls, t);
  try { console.log('[PluginLoader] Fetched from:', usedUrl, ' (base:', usedBase, ')'); } catch { }
  try {
    console.log('[PluginLoader] Downloaded code length:', (code && code.length) || 0);
    console.log('[PluginLoader] Downloaded code:\n' + String(code || ''));
  } catch { }
  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try { console.log('[PluginLoader] Importing module from blob:', url); } catch { }
  try {
    const mod = await import(/* webpackIgnore: true */ url);
    return mod;
  } finally {
    // Clean up the blob URL; module stays cached
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch { }
      // Now safe to terminate worker that created dependency blob: URLs.
      try { (__cleanup || (()=>{}))(); } catch { }
      try { __worker && __worker.terminate && __worker.terminate(); } catch { }
    }, 0);
  }
}

// Plugin app object: exposes the full viewer and helper hooks for plugins.
function buildApp(viewer) {
  const app = {
    BREP,
    viewer,
    registerFeature(FeatureClass) {
      try {
        FeatureClass.fromPlugin = true;

        FeatureClass.featureShortName = "🔌" + (FeatureClass.featureShortName || "Feature");

        FeatureClass.featureName = "🔌 " + FeatureClass.featureName;

        viewer?.partHistory?.featureRegistry?.register?.(FeatureClass);

      } catch { }
    },
    registerAnnotation(AnnotationHandler) {
      try {
        // Optional: prefix plugin marker in titles if present
        if (AnnotationHandler && typeof AnnotationHandler === 'object') {
          if (AnnotationHandler.title) AnnotationHandler.title = `🔌 ${AnnotationHandler.title}`;
        }
        viewer?.annotationRegistry?.register?.(AnnotationHandler);
      } catch {}
    },
    addToolbarButton(label, title, onClick) {
      if (!viewer) return;
      try { viewer.addToolbarButton(label, title, onClick); } catch { }
    },
    async addSidePanel(title, content) {
      try {
        if (typeof viewer?.addPluginSidePanel === 'function') {
          return await viewer.addPluginSidePanel(title, content);
        }
        // Fallback: add immediately if helper is unavailable
        const sec = await viewer?.accordion?.addSection?.(String(title || 'Plugin'));
        if (!sec) return null;
        if (typeof content === 'function') {
          const el = await content();
          if (el) sec.uiElement.appendChild(el);
        } else if (content instanceof HTMLElement) {
          sec.uiElement.appendChild(content);
        } else if (content != null) {
          const pre = document.createElement('pre');
          pre.textContent = String(content);
          sec.uiElement.appendChild(pre);
        }
        return sec;
      } catch { return null; }
    },
  };
  return app;
}

export async function loadPluginFromRepoUrl(viewer, repoUrl) {
  const mod = await importGithubPlugin(repoUrl);
  const app = buildApp(viewer);
  if (typeof mod?.default === 'function') {
    await mod.default(app);
    return true;
  }
  if (typeof mod?.install === 'function') {
    await mod.install(app);
    return true;
  }
  console.warn('Plugin loaded but no default() or install() found:', repoUrl);
  return false;
}

export async function loadPlugins(viewer, repoUrls) {
  const urls = (Array.isArray(repoUrls) ? repoUrls : []).map(s => String(s || '').trim()).filter(Boolean);
  const results = [];
  for (const u of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const ok = await loadPluginFromRepoUrl(viewer, u);
      results.push({ url: u, ok, error: null });
    } catch (e) {
      console.error('Failed to load plugin:', u, e);
      results.push({ url: u, ok: false, error: e });
    }
  }
  return results;
}

const STORAGE_KEY = '__BREP_PLUGIN_URLS__';
const STORAGE_ENABLED_KEY = '__BREP_PLUGIN_ENABLED__';

export function getSavedPluginUrls() {
  try {
    const raw = LS.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(s => String(s || '').trim()).filter(Boolean);
  } catch { return []; }
}

export function savePluginUrls(urls) {
  try { LS.setItem(STORAGE_KEY, JSON.stringify((urls || []).map(s => String(s || '').trim()).filter(Boolean))); } catch { }
}

// Enabled/disabled state per plugin URL. Defaults to enabled if missing.
export function getPluginEnabledMap() {
  try {
    const raw = LS.getItem(STORAGE_ENABLED_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
}

export function savePluginEnabledMap(map) {
  try {
    const obj = (map && typeof map === 'object') ? map : {};
    LS.setItem(STORAGE_ENABLED_KEY, JSON.stringify(obj));
  } catch { }
}

export function setPluginEnabled(url, enabled) {
  try {
    const m = getPluginEnabledMap();
    if (!url) return;
    m[String(url)] = Boolean(enabled);
    savePluginEnabledMap(m);
  } catch { }
}

export async function loadSavedPlugins(viewer) {
  const urls = getSavedPluginUrls();
  if (!urls.length) return [];
  const enabled = getPluginEnabledMap();
  // Default to enabled when state not yet saved
  const urlsToLoad = urls.filter(u => enabled[u] !== false);
  return loadPlugins(viewer, urlsToLoad);
}
