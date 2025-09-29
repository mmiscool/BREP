import JSZip from 'jszip';
import { generate3MF } from '../../exporters/threeMF.js';
import { jsonToXml } from '../../utils/jsonXml.js';

async function _captureThumbnail(viewer, size = 256) {
  try {
    const canvas = viewer?.renderer?.domElement;
    if (!canvas) return null;
    const srcW = canvas.width || canvas.clientWidth || 1;
    const srcH = canvas.height || canvas.clientHeight || 1;
    const dst = document.createElement('canvas');
    dst.width = size; dst.height = size;
    const ctx = dst.getContext('2d');
    if (!ctx) return null;
    try { ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, size, size); } catch {}
    const scale = Math.min(size / srcW, size / srcH);
    const dw = Math.max(1, Math.floor(srcW * scale));
    const dh = Math.max(1, Math.floor(srcH * scale));
    const dx = Math.floor((size - dw) / 2);
    const dy = Math.floor((size - dh) / 2);
    try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; } catch {}
    ctx.drawImage(canvas, 0, 0, srcW, srcH, dx, dy, dw, dh);
    return dst.toDataURL('image/png');
  } catch { return null; }
}

export function createExportButton(viewer) {
  const onClick = () => _openExportDialog(viewer);
  return { label: '📤', title: 'Export…', onClick };
}

// Helpers moved from MainToolbar
function _ensureExportDialogStyles() {
  if (document.getElementById('export-dialog-styles')) return;
  const style = document.createElement('style');
  style.id = 'export-dialog-styles';
  style.textContent = `
      .exp-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 11; }
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

function _unitScale(unit) {
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

function _meshToAsciiSTL(mesh, name = 'solid', precision = 6, scale = 1) {
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

function _meshToAsciiOBJ(mesh, name = 'object', precision = 6, scale = 1) {
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  const fmt = (n) => Number.isFinite(n) ? n.toFixed(precision) : '0';
  const out = [];
  // Object/group name (safe ASCII)
  out.push(`# Exported by BREP`);
  out.push(`o ${name}`);
  // Emit unique vertices referenced by triVerts to keep file smaller
  const indexMap = new Map(); // original index -> 1-based OBJ index
  let nextIndex = 1;
  const faces = []; // store triples of mapped indices
  const triCount = (tv.length / 3) | 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = tv[t * 3 + 0] >>> 0;
    const i1 = tv[t * 3 + 1] >>> 0;
    const i2 = tv[t * 3 + 2] >>> 0;
    const mapIndex = (i) => {
      let id = indexMap.get(i);
      if (!id) {
        const x = vp[i * 3 + 0] * scale;
        const y = vp[i * 3 + 1] * scale;
        const z = vp[i * 3 + 2] * scale;
        out.push(`v ${fmt(x)} ${fmt(y)} ${fmt(z)}`);
        id = nextIndex++;
        indexMap.set(i, id);
      }
      return id;
    };
    const a = mapIndex(i0), b = mapIndex(i1), c = mapIndex(i2);
    faces.push([a, b, c]);
  }
  // Faces (referencing v indices; no normals/UVs)
  for (const f of faces) out.push(`f ${f[0]} ${f[1]} ${f[2]}`);
  return out.join('\n');
}

function _collectSolids(viewer) {
  const scene = viewer?.partHistory?.scene || viewer?.scene;
  if (!scene) return [];
  const solids = [];
  scene.traverse((o) => {
    if (!o || !o.visible) return;
    if (o.type === 'SOLID' && typeof o.toSTL === 'function') solids.push(o);
  });
  const selected = solids.filter(o => o.selected === true);
  return selected.length ? selected : solids;
}

function _download(filename, data, mime = 'application/octet-stream') {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

function _safeName(raw, fallback = 'solid') {
  const s = String(raw || '').trim();
  return (s.length ? s : fallback).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

function _openExportDialog(viewer) {
  _ensureExportDialogStyles();
  const solids = _collectSolids(viewer);
  if (!solids.length) { alert('No solids to export.'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'exp-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'exp-modal';

  const title = document.createElement('div');
  title.className = 'exp-title';
  title.textContent = 'Export';

  const baseDefault = _safeName(viewer?.fileManagerWidget?.currentName || solids[0]?.name || 'part');

  // Filename
  const rowName = document.createElement('div'); rowName.className = 'exp-row';
  const labName = document.createElement('div'); labName.className = 'exp-label'; labName.textContent = 'Filename';
  const inpName = document.createElement('input'); inpName.className = 'exp-input'; inpName.value = baseDefault;
  rowName.appendChild(labName); rowName.appendChild(inpName);

  // Format
  const rowFmt = document.createElement('div'); rowFmt.className = 'exp-row';
  const labFmt = document.createElement('div'); labFmt.className = 'exp-label'; labFmt.textContent = 'Format';
  const selFmt = document.createElement('select'); selFmt.className = 'exp-select';
  const opt3mf = document.createElement('option'); opt3mf.value = '3mf'; opt3mf.textContent = '3MF (+history)'; selFmt.appendChild(opt3mf);
  const optStl = document.createElement('option'); optStl.value = 'stl'; optStl.textContent = 'STL (ASCII)'; selFmt.appendChild(optStl);
  const optJson = document.createElement('option'); optJson.value = 'json'; optJson.textContent = 'BREP JSON (history only)'; selFmt.appendChild(optJson);
  const optObj = document.createElement('option'); optObj.value = 'obj'; optObj.textContent = 'OBJ (ASCII)'; selFmt.appendChild(optObj);
  rowFmt.appendChild(labFmt); rowFmt.appendChild(selFmt);

  // Units
  const rowUnit = document.createElement('div'); rowUnit.className = 'exp-row';
  const labUnit = document.createElement('div'); labUnit.className = 'exp-label'; labUnit.textContent = 'Units';
  const selUnit = document.createElement('select'); selUnit.className = 'exp-select';
  const units = [
    ['millimeter', 'Millimeters (mm)'],
    ['centimeter', 'Centimeters (cm)'],
    ['meter', 'Meters (m)'],
    ['micron', 'Microns (µm)'],
    ['inch', 'Inches (in)'],
    ['foot', 'Feet (ft)'],
  ];
  for (const [v, label] of units) { const o = document.createElement('option'); o.value = v; o.textContent = label; selUnit.appendChild(o); }
  try { selUnit.value = 'millimeter'; } catch {}
  rowUnit.appendChild(labUnit); rowUnit.appendChild(selUnit);

  // Toggle unit row visibility based on format
  const updateUnitVisibility = () => {
    const fmt = selFmt.value;
    rowUnit.style.display = (fmt === 'stl' || fmt === '3mf' || fmt === 'obj') ? 'flex' : 'none';
  };
  selFmt.addEventListener('change', updateUnitVisibility);
  updateUnitVisibility();

  const hint = document.createElement('div'); hint.className = 'exp-hint'; hint.textContent = '3MF includes feature history when available. STL/OBJ export triangulated meshes. BREP JSON saves editable feature history only.';

  // Buttons
  const buttons = document.createElement('div'); buttons.className = 'exp-buttons';
  const btnCancel = document.createElement('button'); btnCancel.className = 'exp-btn'; btnCancel.textContent = 'Cancel';
  btnCancel.addEventListener('click', () => { try { document.body.removeChild(overlay); } catch {} });
  const btnExport = document.createElement('button'); btnExport.className = 'exp-btn'; btnExport.textContent = 'Export';

  const close = () => { try { document.body.removeChild(overlay); } catch {} };

  btnExport.addEventListener('click', async () => {
    try {
      const base = String(inpName.value || baseDefault).trim() || baseDefault;
      const fmt = selFmt.value;
      const unit = selUnit.value;
      const scale = _unitScale(unit);

      if (fmt === 'json') {
        try {
          const json = await viewer?.partHistory?.toJSON?.();
          const text = typeof json === 'string' ? json : JSON.stringify(json || {});
          _download(`${base}.BREP.json`, text, 'application/json');
          close();
          return;
        } catch (e) { /* fall through to show alert below */ }
      }

      if (fmt === '3mf') {
        // Possibly include feature history in metadata
        let additionalFiles = undefined;
        let modelMetadata = undefined;
        try {
          const json = await viewer?.partHistory?.toJSON?.();
          if (json && typeof json === 'string') {
            const obj = JSON.parse(json);
            if (obj && typeof obj === 'object') {
              const fhXml = jsonToXml(obj, 'featureHistory');
              additionalFiles = { 'Metadata/featureHistory.xml': fhXml };
              modelMetadata = { featureHistoryPath: '/Metadata/featureHistory.xml' };
            }
          }
        } catch {}

        // Gracefully handle non-manifold solids by skipping them
        const solidsForExport = [];
        const skipped = [];
        solids.forEach((s, idx) => {
          try {
            const mesh = s?.getMesh?.();
            if (mesh && mesh.vertProperties && mesh.triVerts) {
              solidsForExport.push(s);
            } else {
              const name = _safeName(s?.name || `solid_${idx}`);
              skipped.push(name);
            }
          } catch (e) {
            const name = _safeName(s?.name || `solid_${idx}`);
            skipped.push(name);
          }
        });

        // Capture a preview thumbnail to embed (best-effort)
        const thumbnail = await _captureThumbnail(viewer, 256);

        let data;
        try {
          data = await generate3MF(solidsForExport, { unit, precision: 6, scale, additionalFiles, modelMetadata, thumbnail });
        } catch (e) {
          // As a last resort, attempt exporting only the feature history (no solids)
          try {
            data = await generate3MF([], { unit, precision: 6, scale, additionalFiles, modelMetadata, thumbnail });
          } catch (e2) {
            throw e; // fall back to outer error handler
          }
        }

        _download(`${base}.3mf`, data, 'model/3mf');
        close();
        if (skipped.length > 0) {
          const msg = (solidsForExport.length === 0)
            ? `Exported 3MF with feature history only. Skipped non-manifold solids: ${skipped.join(', ')}`
            : `Exported 3MF. Skipped non-manifold solids: ${skipped.join(', ')}`;
          try { alert(msg); } catch {}
        }
        return;
      }

      if (fmt === 'obj') {
        // Single solid -> OBJ
        if (solids.length === 1) {
          const s = solids[0];
          const mesh = s.getMesh();
          const obj = _meshToAsciiOBJ(mesh, base, 6, scale);
          try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {}
          _download(`${base}.obj`, obj, 'text/plain');
          close();
          return;
        }
        // Multiple solids -> ZIP of individual OBJs
        const zip = new JSZip();
        solids.forEach((s, idx) => {
          try {
            const safe = _safeName(s.name || `solid_${idx}`);
            const mesh = s.getMesh();
            const obj = _meshToAsciiOBJ(mesh, safe, 6, scale);
            try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {}
            zip.file(`${safe}.obj`, obj);
          } catch {}
        });
        const blob = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        _download(`${base}_obj.zip`, blob, 'application/zip');
        close();
        return;
      }

      // STL path
      if (solids.length === 1) {
        const s = solids[0];
        const mesh = s.getMesh();
        const stl = _meshToAsciiSTL(mesh, base, 6, scale);
        try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {}
        _download(`${base}.stl`, stl, 'model/stl');
        close();
        return;
      }
      // Multiple solids -> ZIP of individual STLs
      const zip = new JSZip();
      solids.forEach((s, idx) => {
        try {
          const safe = _safeName(s.name || `solid_${idx}`);
          const mesh = s.getMesh();
          const stl = _meshToAsciiSTL(mesh, safe, 6, scale);
          try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {}
          zip.file(`${safe}.stl`, stl);
        } catch {}
      });
      const blob = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      _download(`${base}_stl.zip`, blob, 'application/zip');
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
