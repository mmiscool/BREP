import JSZip from 'jszip';
import { xmlToJson } from '../../utils/jsonXml.js';

export function createImportButton(viewer) {
  async function onClick() {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.3mf,model/3mf,application/vnd.ms-package.3dmanufacturing-3dmodel+xml,.json,application/json';
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        try {
          const file = input.files && input.files[0];
          try { if (input.parentNode) input.parentNode.removeChild(input); } catch {}
          if (!file) return;

          const buf = await file.arrayBuffer();
          const u8 = new Uint8Array(buf);
          const isZip = u8.length >= 2 && u8[0] === 0x50 && u8[1] === 0x4b; // 'PK'
          const isJSON = String(file.name || '').toLowerCase().endsWith('.json');

          if (!isZip && isJSON) {
            // JSON path (backward compatible)
            const text = await new Response(buf).text();
            let payload = text;
            try {
              const obj = JSON.parse(text);
              if (obj && typeof obj === 'object') {
                // Normalize sketch arrays if present
                const ensureArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
                const normalizeSketch = (sk) => {
                  if (!sk || typeof sk !== 'object') return sk;
                  sk.points = ensureArray(sk.points);
                  sk.geometries = ensureArray(sk.geometries);
                  sk.constraints = ensureArray(sk.constraints);
                  if (Array.isArray(sk.geometries)) {
                    for (const g of sk.geometries) {
                      if (!g) continue;
                      g.points = Array.isArray(g?.points) ? g.points : (g?.points != null ? [g.points] : []);
                      if (Array.isArray(g.points)) g.points = g.points.map((x) => Number(x));
                    }
                  }
                  if (Array.isArray(sk.constraints)) {
                    for (const c of sk.constraints) {
                      if (!c) continue;
                      c.points = Array.isArray(c?.points) ? c.points : (c?.points != null ? [c.points] : []);
                      if (Array.isArray(c.points)) c.points = c.points.map((x) => Number(x));
                    }
                  }
                  return sk;
                };
                if (Array.isArray(obj.features)) {
                  for (const f of obj.features) {
                    if (f?.persistentData?.sketch) f.persistentData.sketch = normalizeSketch(f.persistentData.sketch);
                  }
                } else if (obj.data && Array.isArray(obj.data.features)) {
                  for (const f of obj.data.features) {
                    if (f?.persistentData?.sketch) f.persistentData.sketch = normalizeSketch(f.persistentData.sketch);
                  }
                }
                // Re-stringify payload
                if (Array.isArray(obj.features)) payload = JSON.stringify(obj);
                else if (obj.data) payload = (typeof obj.data === 'string') ? obj.data : JSON.stringify(obj.data);
              }
            } catch {}
            await viewer?.partHistory?.reset?.();
            await viewer?.partHistory?.fromJSON?.(payload);
            // Sync Expressions UI with imported code
            try { if (viewer?.expressionsManager?.textArea) viewer.expressionsManager.textArea.value = viewer.partHistory.expressions || ''; } catch {}
            await viewer?.partHistory?.runHistory?.();
            try { viewer?.zoomToFit?.(1.1); } catch {}
            try { _updateCurrentNameFromFile(viewer, file); } catch {}
            return;
          }

          if (isZip) {
            // 3MF path → check for embedded feature history first
            const zip = await JSZip.loadAsync(buf);
            // Build lower-case path map
            const files = {};
            Object.keys(zip.files || {}).forEach(p => files[p.toLowerCase()] = p);
            let fhKey = files['metadata/featurehistory.xml'];
            if (!fhKey) {
              // search any *featurehistory.xml
              for (const k of Object.keys(files)) { if (k.endsWith('featurehistory.xml')) { fhKey = files[k]; break; } }
            }
            if (fhKey) {
              const xml = await zip.file(fhKey).async('string');
              const obj = xmlToJson(xml);
              // Expect shape { featureHistory: { ...original json... } }
              let root = obj && (obj.featureHistory || obj.FeatureHistory || null);
              // Normalize arrays possibly collapsed by XML → JSON round-trip
              const ensureArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
              const normalizeSketch = (sk) => {
                if (!sk || typeof sk !== 'object') return sk;
                sk.points = ensureArray(sk.points);
                sk.geometries = ensureArray(sk.geometries);
                sk.constraints = ensureArray(sk.constraints);
                // Normalize geometry.points (indices) possibly collapsed
                if (Array.isArray(sk.geometries)) {
                  for (const g of sk.geometries) {
                    if (!g) continue;
                    g.points = Array.isArray(g?.points) ? g.points : (g?.points != null ? [g.points] : []);
                    // Coerce to numbers if strings
                    if (Array.isArray(g.points)) g.points = g.points.map((x) => Number(x));
                  }
                }
                // Normalize constraint.points similarly
                if (Array.isArray(sk.constraints)) {
                  for (const c of sk.constraints) {
                    if (!c) continue;
                    c.points = Array.isArray(c?.points) ? c.points : (c?.points != null ? [c.points] : []);
                    if (Array.isArray(c.points)) c.points = c.points.map((x) => Number(x));
                  }
                }
                return sk;
              };
              const normalizeHistory = (h) => {
                if (!h || typeof h !== 'object') return h;
                h.features = ensureArray(h.features);
                for (const f of h.features) {
                  if (!f || typeof f !== 'object') continue;
                  if (f.persistentData && typeof f.persistentData === 'object') {
                    if (f.persistentData.sketch) f.persistentData.sketch = normalizeSketch(f.persistentData.sketch);
                    if (Array.isArray(f.persistentData.externalRefs)) {
                      // ok
                    } else if (f.persistentData.externalRefs != null) {
                      f.persistentData.externalRefs = ensureArray(f.persistentData.externalRefs);
                    }
                  }
                }
                return h;
              };
              if (root) root = normalizeHistory(root);
              // Ensure expressions is a string (some XML → JSON tools might wrap differently)
              if (root && root.expressions != null && typeof root.expressions !== 'string') {
                try {
                  if (Array.isArray(root.expressions)) root.expressions = root.expressions.join('\n');
                  else if (typeof root.expressions === 'object' && Array.isArray(root.expressions.item)) root.expressions = root.expressions.item.join('\n');
                  else root.expressions = String(root.expressions);
                } catch { root.expressions = String(root.expressions); }
              }
              if (root) {
                await viewer?.partHistory?.reset?.();
                await viewer?.partHistory?.fromJSON?.(JSON.stringify(root));
                // Sync Expressions UI with imported code
                try { if (viewer?.expressionsManager?.textArea) viewer.expressionsManager.textArea.value = viewer.partHistory.expressions || ''; } catch {}
                await viewer?.partHistory?.runHistory?.();
                try { viewer?.zoomToFit?.(1.1); } catch {}
                try { _updateCurrentNameFromFile(viewer, file); } catch {}
                return;
              }
            }

            // No feature history → create a new STL Import feature with the raw 3MF
            await viewer?.partHistory?.reset?.();
            const feat = await viewer?.partHistory?.newFeature?.('STL');
            if (feat) {
              feat.inputParams.fileToImport = buf; // stlImport can auto-detect 3MF zip
              feat.inputParams.deflectionAngle = 15;
              feat.inputParams.centerMesh = true;
            }
            await viewer?.partHistory?.runHistory?.();
            try { viewer?.zoomToFit?.(1.1); } catch {}
            try { _updateCurrentNameFromFile(viewer, file); } catch {}
            return;
          }

          alert('Unsupported file format. Please select a 3MF or JSON file.');
        } catch (e) {
          alert('Import failed. See console for details.');
          console.error(e);
        }
      }, { once: true });
      document.body.appendChild(input);
      input.click();
    } catch (e) {
      alert('Unable to open file dialog.');
      console.error(e);
    }
  }

  return { label: '📥', title: 'Import… (3MF/JSON)', onClick };
}

function _updateCurrentNameFromFile(viewer, file) {
  const fm = viewer?.fileManagerWidget;
  if (!fm) return;
  const name = String(file?.name || '').replace(/\.[^.]+$/, '');
  if (!name) return;
  fm.currentName = name;
  if (fm.nameInput) fm.nameInput.value = name;
  fm.refreshList && fm.refreshList();
  fm._saveLastName && fm._saveLastName(name);
}
