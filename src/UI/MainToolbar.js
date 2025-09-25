// MainToolbar.js — modular top toolbar.
// Shows action buttons (left) and inline selection filter (right).

import { SelectionFilterWidget } from './selectionFilterWidget.js';
import { generate3MF } from '../exporters/threeMF.js';
import { jsonToXml, xmlToJson } from '../utils/jsonXml.js';
import JSZip from 'jszip';

export class MainToolbar {
  constructor(viewer) {
    this.viewer = viewer;
    // Guard against duplicate toolbars if constructed twice (e.g., hot reloads)
    try {
      const existing = document.getElementById('main-toolbar');
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    } catch { /* ignore */ }
    this.root = document.createElement('div');
    this.root.id = 'main-toolbar';
    this._ensureStyles();
    this._buildUI();
    this._positionWithSidebar();

    // Keep position in sync with sidebar and window resizes
    window.addEventListener('resize', () => this._positionWithSidebar());
    try {
      if (window.ResizeObserver && this.viewer?.sidebar) {
        const ro = new ResizeObserver(() => this._positionWithSidebar());
        ro.observe(this.viewer.sidebar);
        this._ro = ro;
      }
    } catch { /* ignore */ }
  }

  _ensureStyles() {
    if (document.getElementById('main-toolbar-styles')) return;
    const style = document.createElement('style');
    style.id = 'main-toolbar-styles';
    style.textContent = `
      #main-toolbar {
        position: fixed;
        top: 0; left: 0; right: 0;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 10px;
        background: rgba(11,13,16,0.92);
        border-bottom: 1px solid #1e2430;
        backdrop-filter: blur(6px);
        z-index: 2147483646;
        pointer-events: auto;
      }
      .mtb-left, .mtb-right { display: flex; align-items: center; gap: 8px; }
      .mtb-spacer { flex: 1; }

      .mtb-btn {
        background: rgba(255,255,255,0.03);
        color: #e5e7eb;
        border: 1px solid #2a3442;
        padding: 6px 10px;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 700;
        font-size: 12px;
        line-height: 1;
        transition: background .15s ease, border-color .15s ease, transform .05s ease;
        user-select: none;
      }
      .mtb-btn:hover { background: #1b2433; border-color: #334155; }
      .mtb-btn:active { transform: translateY(1px); }
    `;
    document.head.appendChild(style);
  }

  _buildUI() {
    const left = document.createElement('div');
    left.className = 'mtb-left';
    this._left = left;

    // Buttons (modular; add more later)
    // use unicode icons for compactness
    left.appendChild(this._btn('💾', 'Save current model', () => this._onSave()));
    left.appendChild(this._btn('🔍', 'Frame all geometry', () => this.viewer?.zoomToFit?.()));
    // Use a mesh-like icon to better suggest wireframe
    left.appendChild(this._btn('🕸️', 'Toggle wireframe', () => this.viewer?.toggleWireframe?.()));
    // Toggle persistent inspector panel (bottom-left, updates on click)
    left.appendChild(this._btn('🧪', 'Toggle Inspector panel', () => {
      try { this.viewer && this.viewer.toggleInspectorPanel && this.viewer.toggleInspectorPanel(); } catch {}
    }));
    // Import / Export
    left.appendChild(this._btn('📥', 'Import… (3MF/JSON)', () => this._onImport3MFOrJSON()));
    left.appendChild(this._btn('📤', 'Export…', () => this._openExportDialog()));
    left.appendChild(this._btn('ℹ️', 'Open About page', () => window.open('about.html', '_blank')));

    const right = document.createElement('div');
    right.className = 'mtb-right';

    // Inline Selection Filter (now on the right)
    this.selectionFilter = new SelectionFilterWidget(this.viewer, { inline: true, mountEl: right });

    this.root.appendChild(left);
    this.root.appendChild(right);
    document.body.appendChild(this.root);
  }

  _btn(label, title, onClick) {
    const b = document.createElement('button');
    b.className = 'mtb-btn';
    b.textContent = label;
    b.title = title || label;
    b.addEventListener('click', (e) => { e.stopPropagation(); try { onClick && onClick(); } catch {} });
    return b;
  }

  // Public: allow plugins to add custom buttons to the left cluster
  addCustomButton({ label, title, onClick }) {
    try {
      const btn = this._btn(String(label ?? '🔧'), String(title || ''), onClick);
      this._left?.appendChild(btn);
      return btn;
    } catch { return null; }
  }

  async _onSave() {
    // Prefer the FileManagerWidget if present
    try {
      if (this.viewer?.fileManagerWidget?.saveCurrent) {
        await this.viewer.fileManagerWidget.saveCurrent();
        return;
      }
    } catch {}
    // Fallback: quick autosave to localStorage
    try {
      const json = await this.viewer?.partHistory?.toJSON?.();
      const payload = { savedAt: new Date().toISOString(), data: JSON.parse(json) };
      localStorage.setItem('__BREP_MODEL__:autosave', JSON.stringify(payload));
      localStorage.setItem('__BREP_MODELS_LASTNAME__', 'autosave');
      alert('Saved as "autosave"');
    } catch {
      alert('Save failed.');
    }
  }

  _positionWithSidebar() {
    try {
      const sb = this.viewer?.sidebar;
      const w = Math.ceil(sb?.getBoundingClientRect?.().width || sb?.offsetWidth || 0);
      this.root.style.left = `${w}px`;
    } catch { this.root.style.left = '0px'; }
  }

  _collectSolids() {
    const scene = this.viewer?.partHistory?.scene || this.viewer?.scene;
    if (!scene) return [];
    const solids = [];
    scene.traverse((o) => {
      if (!o || !o.visible) return;
      if (o.type === 'SOLID' && typeof o.toSTL === 'function') solids.push(o);
    });
    // Prefer selected solids if any are selected
    const selected = solids.filter(o => o.selected === true);
    return selected.length ? selected : solids;
  }

  _download(filename, data, mime = 'application/octet-stream') {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  _safeName(raw, fallback = 'solid') {
    const s = String(raw || '').trim();
    return (s.length ? s : fallback).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  }

  // removed dedicated JSON export; JSON is available via Export dialog

  _onImportPartJSON() {
    return this._onImport3MFOrJSON();
  }

  _onExportSTL() {
    try {
      const solids = this._collectSolids();
      if (!solids.length) { alert('No solids to export.'); return; }

      // If there is exactly one solid, name the file after it; otherwise zip-like multi export.
      if (solids.length === 1) {
        const s = solids[0];
        const name = this._safeName(s.name || 'solid');
        const stl = s.toSTL(name, 6);
        this._download(`${name}.stl`, stl, 'model/stl');
        return;
      }

      // Multiple solids → create a pseudo-archive by concatenation with separators,
      // or prompt to export individually. Export individually for clarity.
      const exportAll = confirm(`Export ${solids.length} solids individually?`);
      if (!exportAll) return;
      solids.forEach((s, idx) => {
        try {
          const name = this._safeName(s.name || `solid_${idx}`);
          const stl = s.toSTL(name, 6);
          this._download(`${name}.stl`, stl, 'model/stl');
        } catch (e) { console.warn('STL export failed for a solid:', e); }
      });
    } catch (e) {
      alert('Export failed. See console for details.');
      console.error(e);
    }
  }

  // --- Unified Export Dialog ---
  _ensureExportDialogStyles() {
    if (document.getElementById('export-dialog-styles')) return;
    const style = document.createElement('style');
    style.id = 'export-dialog-styles';
    style.textContent = `
      .exp-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 10001; }
      .exp-modal { background: #0b0e14; color: #e5e7eb; border: 1px solid #1f2937; border-radius: 10px; padding: 14px; width: min(480px, calc(100vw - 32px)); box-shadow: 0 10px 40px rgba(0,0,0,.5); }
      .exp-title { margin: 0 0 8px 0; font-size: 14px; font-weight: 700; }
      .exp-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
      .exp-col { display: flex; flex-direction: column; gap: 6px; }
      .exp-label { width: 90px; color: #9aa0aa; font-size: 12px; }
      .exp-input, .exp-select { flex: 1 1 auto; padding: 6px 8px; border-radius: 8px; background: #0b0e14; color: #e5e7eb; border: 1px solid #374151; outline: none; font-size: 12px; }
      .exp-input:focus, .exp-select:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
      .exp-hint { color: #9aa0aa; font-size: 12px; margin-top: 6px; }
      .exp-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
      .exp-btn { background: rgba(255,255,255,.03); color: #f9fafb; border: 1px solid #374151; padding: 6px 10px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 12px; line-height: 1; }
      .exp-btn:hover { border-color: #3b82f6; background: rgba(59,130,246,.12); }
      .exp-btn:active { transform: translateY(1px); }
    `;
    document.head.appendChild(style);
  }

  _unitScale(unit) {
    switch (String(unit || 'millimeter')) {
      case 'millimeter': return 1;
      case 'centimeter': return 0.1;            // mm -> cm
      case 'meter': return 0.001;               // mm -> m
      case 'micron': return 1000;               // mm -> µm
      case 'inch': return 1 / 25.4;             // mm -> in
      case 'foot': return 1 / 304.8;            // mm -> ft
      default: return 1;
    }
  }

  _meshToAsciiSTL(mesh, name = 'solid', precision = 6, scale = 1) {
    const vp = mesh.vertProperties;
    const tv = mesh.triVerts;
    const fmt = (n) => Number.isFinite(n) ? n.toFixed(precision) : '0';
    const out = [];
    out.push(`solid ${name}`);
    const triCount = (tv.length / 3) | 0;
    for (let t = 0; t < triCount; t++) {
      const i0 = tv[t * 3 + 0] >>> 0;
      const i1 = tv[t * 3 + 1] >>> 0;
      const i2 = tv[t * 3 + 2] >>> 0;
      const ax = vp[i0 * 3 + 0] * scale, ay = vp[i0 * 3 + 1] * scale, az = vp[i0 * 3 + 2] * scale;
      const bx = vp[i1 * 3 + 0] * scale, by = vp[i1 * 3 + 1] * scale, bz = vp[i1 * 3 + 2] * scale;
      const cx = vp[i2 * 3 + 0] * scale, cy = vp[i2 * 3 + 1] * scale, cz = vp[i2 * 3 + 2] * scale;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      out.push(`  facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`);
      out.push('    outer loop');
      out.push(`      vertex ${fmt(ax)} ${fmt(ay)} ${fmt(az)}`);
      out.push(`      vertex ${fmt(bx)} ${fmt(by)} ${fmt(bz)}`);
      out.push(`      vertex ${fmt(cx)} ${fmt(cy)} ${fmt(cz)}`);
      out.push('    endloop');
      out.push('  endfacet');
    }
    out.push(`endsolid ${name}`);
    return out.join('\n');
  }

  _openExportDialog() {
    this._ensureExportDialogStyles();
    const solids = this._collectSolids();
    if (!solids.length) { alert('No solids to export.'); return; }

    const overlay = document.createElement('div');
    overlay.className = 'exp-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'exp-modal';

    const title = document.createElement('div');
    title.className = 'exp-title';
    title.textContent = 'Export';

    const baseDefault = this._safeName(this.viewer?.fileManagerWidget?.currentName || solids[0]?.name || 'part');

    // Filename
    const rowName = document.createElement('div'); rowName.className = 'exp-row';
    const labName = document.createElement('div'); labName.className = 'exp-label'; labName.textContent = 'Filename';
    const inpName = document.createElement('input'); inpName.className = 'exp-input'; inpName.type = 'text'; inpName.value = baseDefault;
    rowName.appendChild(labName); rowName.appendChild(inpName);

    // Format
    const rowFmt = document.createElement('div'); rowFmt.className = 'exp-row';
    const labFmt = document.createElement('div'); labFmt.className = 'exp-label'; labFmt.textContent = 'Format';
    const selFmt = document.createElement('select'); selFmt.className = 'exp-select';
    const opt3mf = document.createElement('option'); opt3mf.value = '3mf'; opt3mf.textContent = '3MF (*.3mf)';
    const optStl = document.createElement('option'); optStl.value = 'stl'; optStl.textContent = 'STL (ASCII) (*.stl)';
    const optJson = document.createElement('option'); optJson.value = 'json'; optJson.textContent = 'BREP JSON (*.BREP.json)';
    selFmt.appendChild(opt3mf); selFmt.appendChild(optStl); selFmt.appendChild(optJson);
    rowFmt.appendChild(labFmt); rowFmt.appendChild(selFmt);

    // Units
    const rowUnit = document.createElement('div'); rowUnit.className = 'exp-row';
    const labUnit = document.createElement('div'); labUnit.className = 'exp-label'; labUnit.textContent = 'Units';
    const selUnit = document.createElement('select'); selUnit.className = 'exp-select';
    const units = ['millimeter','centimeter','meter','inch','foot','micron'];
    for (const u of units) { const o = document.createElement('option'); o.value = u; o.textContent = u; selUnit.appendChild(o); }
    selUnit.value = 'millimeter';
    rowUnit.appendChild(labUnit); rowUnit.appendChild(selUnit);

    // Hint line for multi-STL
    const hint = document.createElement('div'); hint.className = 'exp-hint';
    const updateHint = () => {
      const fmt = selFmt.value;
      if (fmt === 'stl' && solids.length > 1) {
        hint.textContent = `Note: ${solids.length} solids selected — will export a ZIP with one STL per solid.`;
      } else if (fmt === 'json') {
        hint.textContent = 'Exports only the feature history as JSON (.BREP.json).';
      } else {
        hint.textContent = '';
      }
      // Units are not used for JSON; disable the units row when JSON is selected
      try { rowUnit.style.opacity = (fmt === 'json') ? '0.6' : '1'; } catch {}
    };
    selFmt.addEventListener('change', updateHint);
    updateHint();

    // Buttons
    const buttons = document.createElement('div'); buttons.className = 'exp-buttons';
    const btnCancel = document.createElement('button'); btnCancel.className = 'exp-btn'; btnCancel.textContent = 'Cancel';
    const btnExport = document.createElement('button'); btnExport.className = 'exp-btn'; btnExport.textContent = 'Export';
    const close = () => { try { document.body.removeChild(overlay); } catch {} };
    btnCancel.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    btnExport.addEventListener('click', async () => {
      try {
        const fmt = selFmt.value; // '3mf' | 'stl' | 'json'
        const unit = selUnit.value; // text value
        const scale = this._unitScale(unit);
        let base = this._safeName(inpName.value || baseDefault);
        if (!base) base = 'part';

        if (fmt === 'json') {
          const json = await this.viewer?.partHistory?.toJSON?.();
          if (!json) { alert('Nothing to export.'); return; }
          this._download(`${base}.BREP.json`, json, 'application/json');
          close();
          return;
        }

        if (fmt === '3mf') {
          let additionalFiles = null;
          let modelMetadata = null;
          try {
            const json = await this.viewer?.partHistory?.toJSON?.();
            if (json) {
              const obj = JSON.parse(json);
              const fhXml = jsonToXml(obj, 'featureHistory');
              additionalFiles = { 'Metadata/featureHistory.xml': fhXml };
              modelMetadata = { featureHistoryPath: '/Metadata/featureHistory.xml' };
            }
          } catch {}

          // Gracefully handle non-manifold solids by skipping them
          const solidsForExport = [];
          const skipped = [];
          solids.forEach((s, idx) => {
            try {
              const mesh = s?.getMesh?.();
              if (mesh && mesh.vertProperties && mesh.triVerts) {
                // Touching getMesh() can throw; if it did not, include this solid
                solidsForExport.push(s);
              } else {
                const name = this._safeName(s?.name || `solid_${idx}`);
                skipped.push(name);
              }
            } catch (e) {
              const name = this._safeName(s?.name || `solid_${idx}`);
              skipped.push(name);
            }
          });

          // Proceed with export even if none are manifold; the 3MF will still include feature history
          let data;
          try {
            data = await generate3MF(solidsForExport, { unit, precision: 6, scale, additionalFiles, modelMetadata });
          } catch (e) {
            // As a last resort, attempt exporting only the feature history (no solids)
            try {
              data = await generate3MF([], { unit, precision: 6, scale, additionalFiles, modelMetadata });
            } catch (e2) {
              throw e; // fall back to outer error handler
            }
          }

          this._download(`${base}.3mf`, data, 'model/3mf');
          close();
          if (skipped.length > 0) {
            const msg = (solidsForExport.length === 0)
              ? `Exported 3MF with feature history only. Skipped non-manifold solids: ${skipped.join(', ')}`
              : `Exported 3MF. Skipped non-manifold solids: ${skipped.join(', ')}`;
            try { alert(msg); } catch {}
          }
          return;
        }

        // STL path
        if (solids.length === 1) {
          const s = solids[0];
          const mesh = s.getMesh();
          const stl = this._meshToAsciiSTL(mesh, base, 6, scale);
          this._download(`${base}.stl`, stl, 'model/stl');
          close();
          return;
        }
        // Multiple solids -> ZIP of individual STLs
        const zip = new JSZip();
        solids.forEach((s, idx) => {
          try {
            const safe = this._safeName(s.name || `solid_${idx}`);
            const mesh = s.getMesh();
            const stl = this._meshToAsciiSTL(mesh, safe, 6, scale);
            zip.file(`${safe}.stl`, stl);
          } catch {}
        });
        const blob = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        this._download(`${base}_stl.zip`, blob, 'application/zip');
        close();
      } catch (e) {
        alert('Export failed. See console for details.');
        console.error(e);
      }
    });

    buttons.appendChild(btnCancel);
    buttons.appendChild(btnExport);

    modal.appendChild(title);
    modal.appendChild(rowName);
    modal.appendChild(rowFmt);
    modal.appendChild(rowUnit);
    modal.appendChild(hint);
    modal.appendChild(buttons);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    try { inpName.focus(); inpName.select(); } catch {}
  }

  async _onImport3MFOrJSON() {
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
            await this.viewer?.partHistory?.reset?.();
            await this.viewer?.partHistory?.fromJSON?.(payload);
            await this.viewer?.partHistory?.runHistory?.();
            try { this.viewer?.zoomToFit?.(1.1); } catch {}
            // Update current name
            try { this._updateCurrentNameFromFile(file); } catch {}
            //alert('Import complete.');
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
              if (root) {
                await this.viewer?.partHistory?.reset?.();
                await this.viewer?.partHistory?.fromJSON?.(JSON.stringify(root));
                await this.viewer?.partHistory?.runHistory?.();
                try { this.viewer?.zoomToFit?.(1.1); } catch {}
                try { this._updateCurrentNameFromFile(file); } catch {}
                //alert('Import complete.');
                return;
              }
            }

            // No feature history → create a new STL Import feature with the raw 3MF
            await this.viewer?.partHistory?.reset?.();
            const feat = await this.viewer?.partHistory?.newFeature?.('STL');
            if (feat) {
              feat.inputParams.fileToImport = buf; // stlImport can auto-detect 3MF zip
              feat.inputParams.deflectionAngle = 15;
              feat.inputParams.centerMesh = true;
            }
            await this.viewer?.partHistory?.runHistory?.();
            try { this.viewer?.zoomToFit?.(1.1); } catch {}
            try { this._updateCurrentNameFromFile(file); } catch {}
            //alert('Import complete.');
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

  _updateCurrentNameFromFile(file) {
    const fm = this.viewer?.fileManagerWidget;
    if (!fm) return;
    const name = String(file?.name || '').replace(/\.[^.]+$/, '');
    if (!name) return;
    fm.currentName = name;
    if (fm.nameInput) fm.nameInput.value = name;
    fm.refreshList && fm.refreshList();
    fm._saveLastName && fm._saveLastName(name);
  }
}
