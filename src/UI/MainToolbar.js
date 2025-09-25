// MainToolbar.js — modular top toolbar.
// Shows action buttons (left) and inline selection filter (right).

import { SelectionFilterWidget } from './selectionFilterWidget.js';
import { generate3MF } from '../exporters/threeMF.js';
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
    // Export/Import Part JSON
    left.appendChild(this._btn('📦', 'Export part JSON', () => this._onExportPartJSON()));
    left.appendChild(this._btn('📥', 'Import part JSON', () => this._onImportPartJSON()));
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

  async _onExportPartJSON() {
    try {
      const json = await this.viewer?.partHistory?.toJSON?.();
      if (!json) { alert('Nothing to export.'); return; }
      const base = this._safeName(this.viewer?.fileManagerWidget?.currentName || 'part');
      this._download(`${base}.part.json`, json, 'application/json');
    } catch (e) {
      alert('Export failed. See console for details.');
      console.error(e);
    }
  }

  _onImportPartJSON() {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        try {
          const file = input.files && input.files[0];
          try { if (input.parentNode) input.parentNode.removeChild(input); } catch {}
          if (!file) return;
          const text = await file.text();
          // Allow both raw PartHistory JSON and wrapper objects with { data }
          let payload = text;
          try {
            const obj = JSON.parse(text);
            if (obj && typeof obj === 'object') {
              if (Array.isArray(obj.features)) {
                payload = JSON.stringify(obj);
              } else if (obj.data) {
                payload = (typeof obj.data === 'string') ? obj.data : JSON.stringify(obj.data);
              }
            }
          } catch { /* keep raw text */ }

          await this.viewer?.partHistory?.reset?.();
          await this.viewer?.partHistory?.fromJSON?.(payload);
          await this.viewer?.partHistory?.runHistory?.();
          try { this.viewer?.zoomToFit?.(1.1); } catch {}

          // Optionally update File Manager current name to the imported filename (sans extension)
          try {
            const fm = this.viewer?.fileManagerWidget;
            if (fm) {
              const name = String(file.name || '').replace(/\.[^.]+$/, '');
              if (name) {
                fm.currentName = name;
                if (fm.nameInput) fm.nameInput.value = name;
                fm.refreshList && fm.refreshList();
                fm._saveLastName && fm._saveLastName(name);
              }
            }
          } catch { /* non-fatal */ }

          alert('Import complete.');
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
    selFmt.appendChild(opt3mf); selFmt.appendChild(optStl);
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
      } else {
        hint.textContent = '';
      }
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
        const fmt = selFmt.value; // '3mf' | 'stl'
        const unit = selUnit.value; // text value
        const scale = this._unitScale(unit);
        let base = this._safeName(inpName.value || baseDefault);
        if (!base) base = 'part';

        if (fmt === '3mf') {
          const data = await generate3MF(solids, { unit, precision: 6, scale });
          this._download(`${base}.3mf`, data, 'model/3mf');
          close();
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
}
