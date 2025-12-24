// Basic 3MF exporter using JSZip
// - Packages a minimal 3MF container with a single model file
// - Supports exporting one or multiple SOLID objects from the scene
// - Uses current manifold mesh data: vertProperties (float triples) and triVerts (index triples)

import JSZip from 'jszip';

function _parseDataUrl(dataUrl) {
  try {
    if (typeof dataUrl !== 'string') return null;
    if (!dataUrl.startsWith('data:')) return null;
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const header = dataUrl.slice(5, comma); // after 'data:' up to comma
    const payload = dataUrl.slice(comma + 1);
    const isBase64 = /;base64/i.test(header);
    const mime = header.split(';')[0] || 'application/octet-stream';
    const ext = (mime === 'image/png') ? 'png' : (mime === 'image/jpeg' ? 'jpg' : 'bin');
    let bytes;
    if (isBase64) {
      const bin = atob(payload);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      bytes = u8;
    } else {
      // URI-encoded data
      const str = decodeURIComponent(payload);
      const u8 = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i) & 0xFF;
      bytes = u8;
    }
    return { bytes, mime, ext };
  } catch {
    return null;
  }
}

function xmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function numStr(n, precision = 6) {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(precision);
  // Trim trailing zeros and optional dot for compactness
  return s.replace(/\.0+$/,'').replace(/(\.[0-9]*?)0+$/,'$1');
}

function _isIdentityMatrixElements(e) {
  if (!e || e.length !== 16) return true;
  return e[0] === 1 && e[4] === 0 && e[8] === 0 && e[12] === 0
    && e[1] === 0 && e[5] === 1 && e[9] === 0 && e[13] === 0
    && e[2] === 0 && e[6] === 0 && e[10] === 1 && e[14] === 0
    && e[3] === 0 && e[7] === 0 && e[11] === 0 && e[15] === 1;
}

function _clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function _rgbToHex(r, g, b) {
  return `#${_clampByte(r).toString(16).padStart(2, '0')}${_clampByte(g).toString(16).padStart(2, '0')}${_clampByte(b).toString(16).padStart(2, '0')}`;
}

function _parseRgbComponent(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (s.endsWith('%')) {
    const num = parseFloat(s.slice(0, -1));
    if (!Number.isFinite(num)) return NaN;
    return (num / 100) * 255;
  }
  const num = parseFloat(s);
  if (!Number.isFinite(num)) return NaN;
  return num;
}

function _parseHue(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return NaN;
  if (s.endsWith('turn')) {
    const num = parseFloat(s.slice(0, -4));
    if (!Number.isFinite(num)) return NaN;
    return num * 360;
  }
  if (s.endsWith('rad')) {
    const num = parseFloat(s.slice(0, -3));
    if (!Number.isFinite(num)) return NaN;
    return (num * 180) / Math.PI;
  }
  if (s.endsWith('deg')) {
    const num = parseFloat(s.slice(0, -3));
    if (!Number.isFinite(num)) return NaN;
    return num;
  }
  const num = parseFloat(s);
  if (!Number.isFinite(num)) return NaN;
  return num;
}

function _parsePercent(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  if (s.endsWith('%')) {
    const num = parseFloat(s.slice(0, -1));
    if (!Number.isFinite(num)) return NaN;
    return num / 100;
  }
  const num = parseFloat(s);
  if (!Number.isFinite(num)) return NaN;
  return num > 1 ? num / 100 : num;
}

function _hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0; let g = 0; let b = 0;
  if (hue < 60) { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return { r: r + m, g: g + m, b: b + m };
}

function _parseColorToHex(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.max(0, Math.min(0xffffff, Math.round(value)));
    return `#${n.toString(16).padStart(6, '0')}`;
  }
  if (typeof value === 'string') {
    const v = value.trim();
    if (!v) return null;
    const hexMatch = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hexMatch) {
      const h = hexMatch[1];
      if (h.length === 3) {
        return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
      }
      return `#${h.toLowerCase()}`;
    }
    const hex0xMatch = v.match(/^0x([0-9a-f]{6})$/i);
    if (hex0xMatch) return `#${hex0xMatch[1].toLowerCase()}`;
    const rgbMatch = v.match(/^rgba?\((.+)\)$/i);
    if (rgbMatch) {
      const inner = rgbMatch[1].replace('/', ' ');
      const parts = inner.split(/[, ]+/).map(p => p.trim()).filter(Boolean);
      if (parts.length < 3) return null;
      const r = _parseRgbComponent(parts[0]);
      const g = _parseRgbComponent(parts[1]);
      const b = _parseRgbComponent(parts[2]);
      if (![r, g, b].every(Number.isFinite)) return null;
      return _rgbToHex(r, g, b);
    }
    const hslMatch = v.match(/^hsla?\((.+)\)$/i);
    if (hslMatch) {
      const inner = hslMatch[1].replace('/', ' ');
      const parts = inner.split(/[, ]+/).map(p => p.trim()).filter(Boolean);
      if (parts.length < 3) return null;
      const h = _parseHue(parts[0]);
      const s = _parsePercent(parts[1]);
      const l = _parsePercent(parts[2]);
      if (![h, s, l].every(Number.isFinite)) return null;
      const rgb = _hslToRgb(h, s, l);
      return _rgbToHex(rgb.r * 255, rgb.g * 255, rgb.b * 255);
    }
    return null;
  }
  if (Array.isArray(value) && value.length >= 3) {
    const r = Number(value[0]);
    const g = Number(value[1]);
    const b = Number(value[2]);
    if (![r, g, b].every(Number.isFinite)) return null;
    const max = Math.max(r, g, b);
    return max <= 1 ? _rgbToHex(r * 255, g * 255, b * 255) : _rgbToHex(r, g, b);
  }
  if (typeof value === 'object') {
    const r = Number(value.r);
    const g = Number(value.g);
    const b = Number(value.b);
    if ([r, g, b].every(Number.isFinite)) {
      const max = Math.max(r, g, b);
      return max <= 1 ? _rgbToHex(r * 255, g * 255, b * 255) : _rgbToHex(r, g, b);
    }
  }
  return null;
}

function _pickColorValue(meta, keys) {
  if (!meta || typeof meta !== 'object') return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(meta, key)) continue;
    const raw = meta[key];
    if (raw == null) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    return raw;
  }
  return null;
}

function _resolveColorHex(meta, keys) {
  const raw = _pickColorValue(meta, keys);
  return _parseColorToHex(raw);
}

/**
 * Build the core 3MF model XML for one or more solids.
 * @param {Array} solids Array of SOLID-like objects that expose getMesh() and name.
 * @param {{unit?: 'millimeter'|'inch'|'foot'|'meter'|'centimeter'|'micron', precision?: number, scale?: number, metadataManager?: any, useMetadataColors?: boolean, includeFaceTags?: boolean, applyWorldTransform?: boolean}} opts
 * @returns {string}
 */
export function build3MFModelXML(solids, opts = {}) {
  const unit = opts.unit || 'millimeter';
  const precision = Number.isFinite(opts.precision) ? opts.precision : 6;
  const scale = Number.isFinite(opts.scale) ? opts.scale : 1.0;
  const modelMetadata = opts.modelMetadata && typeof opts.modelMetadata === 'object' ? opts.modelMetadata : null;
  const includeFaceTags = opts.includeFaceTags !== false; // default on
  const useMetadataColors = opts.useMetadataColors !== false;
  const applyWorldTransform = opts.applyWorldTransform !== false;

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<model xml:lang="en-US" unit="' + xmlEsc(unit) + '" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  if (modelMetadata) {
    for (const k of Object.keys(modelMetadata)) {
      const v = modelMetadata[k];
      lines.push(`  <metadata name="${xmlEsc(k)}">${xmlEsc(v)}</metadata>`);
    }
  }
  lines.push('  <resources>');

  // Resource/object id allocator (unique across the model)
  let nextId = 1;
  const buildItems = [];

  let solidIdx = 0;
  for (const s of (solids || [])) {
    if (!s || typeof s.getMesh !== 'function') continue;
    const mesh = s.getMesh();
    try {
    if (!mesh || !mesh.vertProperties || !mesh.triVerts) continue;
    const rawName = s.name || `solid_${solidIdx + 1}`;
    const name = xmlEsc(rawName);
    const vp = mesh.vertProperties; // Float32Array
    const tv = mesh.triVerts;       // Uint32Array
    const tCount = (tv.length / 3) | 0;
    const metadataManager = opts.metadataManager && typeof opts.metadataManager.getMetadata === 'function' ? opts.metadataManager : null;
    const idToFaceName = s && s._idToFaceName instanceof Map ? s._idToFaceName : null;
    let worldMatrixElements = null;
    if (applyWorldTransform) {
      try {
        if (typeof s.updateWorldMatrix === 'function') {
          s.updateWorldMatrix(true, false);
        } else if (typeof s.updateMatrixWorld === 'function') {
          s.updateMatrixWorld(true);
        }
      } catch { /* best-effort only */ }
      const wm = s && s.matrixWorld;
      if (wm && wm.elements && wm.elements.length === 16 && !_isIdentityMatrixElements(wm.elements)) {
        worldMatrixElements = wm.elements;
      }
    }

    // Optional: build per-object BaseMaterials for metadata colors or face tags.
    let matPid = null; // resource id for this object's material group
    let objectPidAttr = '';
    let objectPindexAttr = '';
    let faceColorById = null;
    let faceMatIndexById = null;
    let solidMatIndex = null;
    let useFaceTagsFallback = false;

    const faceIDs = (mesh.faceID && mesh.faceID.length === tCount) ? mesh.faceID : null;
    if (useMetadataColors) {
      let solidColorHex = null;
      try {
        const solidMeta = (metadataManager && s?.name)
          ? metadataManager.getMetadata(s.name)
          : null;
        solidColorHex = _resolveColorHex(solidMeta, ['solidColor', 'color'])
          || _resolveColorHex(s?.userData?.metadata || null, ['solidColor', 'color']);
      } catch { solidColorHex = null; }

      if (faceIDs && idToFaceName) {
        faceColorById = new Map();
        const seenFace = new Set();
        for (let t = 0; t < faceIDs.length; t++) {
          const fid = faceIDs[t] >>> 0;
          if (seenFace.has(fid)) continue;
          seenFace.add(fid);
          const faceName = idToFaceName.get(fid) || `FACE_${fid}`;
          let faceMeta = null;
          try { faceMeta = typeof s.getFaceMetadata === 'function' ? s.getFaceMetadata(faceName) : null; } catch { faceMeta = null; }
          let faceHex = null;
          if (metadataManager) {
            try { faceHex = _resolveColorHex(metadataManager.getMetadata(faceName), ['faceColor', 'color']); } catch { faceHex = null; }
          }
          if (!faceHex) faceHex = _resolveColorHex(faceMeta, ['faceColor', 'color']);
          if (faceHex) faceColorById.set(fid, faceHex);
        }
      }

      const hasFaceColors = faceColorById && faceColorById.size > 0;
      const hasSolidColor = !!solidColorHex;
      const hasMetadataColors = hasSolidColor || hasFaceColors;

      if (hasMetadataColors) {
        const materials = [];
        const colorToIndex = new Map();
        const addMaterial = (hex, label) => {
          if (!hex) return null;
          if (!colorToIndex.has(hex)) {
            colorToIndex.set(hex, materials.length);
            materials.push({ color: hex, name: label || '' });
          }
          return colorToIndex.get(hex);
        };

        if (hasSolidColor) solidMatIndex = addMaterial(solidColorHex, `${rawName}_SOLID`);
        if (hasFaceColors) {
          faceMatIndexById = new Map();
          for (const [fid, hex] of faceColorById.entries()) {
            const faceName = idToFaceName ? (idToFaceName.get(fid) || `FACE_${fid}`) : `FACE_${fid}`;
            const idx = addMaterial(hex, faceName);
            faceMatIndexById.set(fid, idx);
          }
        }

        if (materials.length > 0) {
          matPid = nextId++;
          lines.push(`    <basematerials id="${matPid}">`);
          for (const entry of materials) {
            const nm = entry.name ? xmlEsc(entry.name) : '';
            const nameAttr = nm ? ` name="${nm}"` : '';
            lines.push(`      <base${nameAttr} displaycolor="${entry.color}"/>`);
          }
          lines.push('    </basematerials>');
          if (solidMatIndex != null) {
            objectPidAttr = ` pid="${matPid}"`;
            objectPindexAttr = ` pindex="${solidMatIndex}"`;
          }
        }
      } else if (includeFaceTags && faceIDs) {
        useFaceTagsFallback = true;
      }
    } else if (includeFaceTags && faceIDs) {
      useFaceTagsFallback = true;
    }

    let faceIndexOf = null;
    if (useFaceTagsFallback && faceIDs) {
      // Gather unique face IDs present on this mesh
      const uniqueIds = [];
      const seen = new Set();
      for (let t = 0; t < faceIDs.length; t++) {
        const fid = faceIDs[t] >>> 0;
        if (!seen.has(fid)) { seen.add(fid); uniqueIds.push(fid); }
      }
      if (uniqueIds.length > 0) {
        // Map each ID to a readable name if available on the Solid, else fallback
        const idToName = new Map();
        for (let i = 0; i < uniqueIds.length; i++) {
          const fid = uniqueIds[i];
          const nm = (idToFaceName && idToFaceName.get(fid)) || `FACE_${fid}`;
          idToName.set(fid, String(nm));
        }

        // Assign contiguous indices in encounter order
        const idToMatIdx = new Map();
        for (let i = 0; i < uniqueIds.length; i++) idToMatIdx.set(uniqueIds[i], i);
        faceIndexOf = (fid) => idToMatIdx.get(fid) ?? 0;

        // Emit basematerials resource
        matPid = nextId++;
        lines.push(`    <basematerials id="${matPid}">`);
        for (let i = 0; i < uniqueIds.length; i++) {
          const fid = uniqueIds[i];
          const nm = idToName.get(fid);
          // Deterministic color derived from name hash for readability
          let color = '#808080';
          try {
            let h = 2166136261 >>> 0;
            const sname = nm || '';
            for (let k = 0; k < sname.length; k++) { h ^= sname.charCodeAt(k); h = (h * 16777619) >>> 0; }
            const r = ((h      ) & 0xFF);
            const g = ((h >>  8) & 0xFF);
            const b = ((h >> 16) & 0xFF);
            color = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
          } catch {}
          lines.push(`      <base name="${xmlEsc(nm)}" displaycolor="${color}"/>`);
        }
        lines.push('    </basematerials>');
      }
    }

    const objId = nextId++;
    lines.push(`    <object id="${objId}" type="model" name="${name}"${objectPidAttr}${objectPindexAttr}>`);
    lines.push('      <mesh>');

    // Vertices
    lines.push('        <vertices>');
    const vCount = (vp.length / 3) | 0;
    for (let i = 0; i < vCount; i++) {
      let x = vp[i * 3 + 0];
      let y = vp[i * 3 + 1];
      let z = vp[i * 3 + 2];
      if (worldMatrixElements) {
        const e = worldMatrixElements;
        const nx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const ny = e[1] * x + e[5] * y + e[9] * z + e[13];
        const nz = e[2] * x + e[6] * y + e[10] * z + e[14];
        x = nx; y = ny; z = nz;
      }
      const xs = numStr(x * scale, precision);
      const ys = numStr(y * scale, precision);
      const zs = numStr(z * scale, precision);
      lines.push(`          <vertex x="${xs}" y="${ys}" z="${zs}"/>`);
    }
    lines.push('        </vertices>');

    // Triangles
    lines.push('        <triangles>');
    if (faceIDs && faceMatIndexById && matPid != null && faceMatIndexById.size > 0) {
      for (let t = 0; t < tCount; t++) {
        const v1 = tv[t * 3 + 0] >>> 0;
        const v2 = tv[t * 3 + 1] >>> 0;
        const v3 = tv[t * 3 + 2] >>> 0;
        const fid = faceIDs[t] >>> 0;
        const idx = faceMatIndexById.get(fid);
        if (idx != null) {
          lines.push(`          <triangle v1="${v1}" v2="${v2}" v3="${v3}" pid="${matPid}" p1="${idx}" p2="${idx}" p3="${idx}"/>`);
        } else {
          lines.push(`          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`);
        }
      }
    } else if (matPid != null && faceIndexOf && faceIDs) {
      for (let t = 0; t < tCount; t++) {
        const v1 = tv[t * 3 + 0] >>> 0;
        const v2 = tv[t * 3 + 1] >>> 0;
        const v3 = tv[t * 3 + 2] >>> 0;
        const idx = faceIndexOf(faceIDs[t] >>> 0) >>> 0;
        lines.push(`          <triangle v1="${v1}" v2="${v2}" v3="${v3}" pid="${matPid}" p1="${idx}" p2="${idx}" p3="${idx}"/>`);
      }
    } else {
      for (let t = 0; t < tCount; t++) {
        const v1 = tv[t * 3 + 0] >>> 0;
        const v2 = tv[t * 3 + 1] >>> 0;
        const v3 = tv[t * 3 + 2] >>> 0;
        lines.push(`          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`);
      }
    }
    lines.push('        </triangles>');

    lines.push('      </mesh>');
    lines.push('    </object>');
    buildItems.push(objId);
    solidIdx++;
    } finally { try { if (mesh && typeof mesh.delete === 'function') mesh.delete(); } catch {} }
  }

  lines.push('  </resources>');
  lines.push('  <build>');
  for (const id of buildItems) {
    lines.push(`    <item objectid="${id}"/>`);
  }
  lines.push('  </build>');
  lines.push('</model>');

  return lines.join('\n');
}

function contentTypesXML() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
    '  <Default Extension="xml" ContentType="application/xml"/>',
    '  <Default Extension="png" ContentType="image/png"/>',
    '  <Default Extension="jpg" ContentType="image/jpeg"/>',
    '  <Default Extension="jpeg" ContentType="image/jpeg"/>',
    '</Types>'
  ].join('\n');
}

function rootRelsXML({ thumbnailPath, viewImages } = {}) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">');
  lines.push('  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>');
  if (thumbnailPath) {
    lines.push(`  <Relationship Target="${xmlEsc(thumbnailPath)}" Id="relThumb" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>`);
  }
  if (Array.isArray(viewImages) && viewImages.length) {
    viewImages.forEach((path, idx) => {
      const id = `relView${idx}`;
      const target = path.startsWith('/') ? path : `/${path}`;
      lines.push(`  <Relationship Target="${xmlEsc(target)}" Id="${xmlEsc(id)}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/other"/>`);
    });
  }
  lines.push('</Relationships>');
  return lines.join('\n');
}

function modelPartRelsXML({ thumbnailPath } = {}) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">');
  if (thumbnailPath) {
    lines.push(`  <Relationship Target="${xmlEsc(thumbnailPath)}" Id="relThumb" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>`);
  }
  lines.push('</Relationships>');
  return lines.join('\n');
}

/**
 * Generate a 3MF zip archive as Uint8Array.
 * @param {Array} solids Array of SOLID-like objects that expose getMesh() and name.
 * @param {{unit?: string, precision?: number, scale?: number, metadataManager?: any, useMetadataColors?: boolean, includeFaceTags?: boolean, applyWorldTransform?: boolean}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function generate3MF(solids, opts = {}) {
  const modelXml = build3MFModelXML(solids, opts);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXML());
  zip.folder('3D').file('3dmodel.model', modelXml);
  // Optional thumbnail embedding (PNG/JPEG)
  let thumbPkgRelPath = null;
  if (opts.thumbnail) {
    try {
      let bytes = null;
      let ext = 'png';
      if (typeof opts.thumbnail === 'string') {
        const parsed = _parseDataUrl(opts.thumbnail);
        if (parsed && parsed.bytes) { bytes = parsed.bytes; ext = (parsed.ext || 'png'); }
      } else if (opts.thumbnail instanceof Uint8Array) {
        bytes = opts.thumbnail;
        ext = 'png';
      }
      if (bytes && bytes.length > 0) {
        const fname = `thumbnail.${ext}`;
        const path = `Metadata/${fname}`;
        zip.folder('Metadata').file(fname, bytes);
        // Root/package-level relationship target (absolute from package root)
        thumbPkgRelPath = `/${path}`;
      }
    } catch { /* ignore thumbnail errors */ }
  }
  // Additional attachments (e.g., Metadata/featureHistory.json)
  const extra = opts.additionalFiles && typeof opts.additionalFiles === 'object' ? opts.additionalFiles : null;
  // Root-level relationships (3D model and optional thumbnail)
  const viewRelPaths = [];
  if (extra) {
    for (const p of Object.keys(extra)) {
      const lower = p.toLowerCase();
      if (lower.startsWith('views/') && lower.endsWith('.png')) {
        const clean = p.startsWith('/') ? p : `/${p}`;
        viewRelPaths.push(clean);
      }
    }
  }
  zip.folder('_rels').file('.rels', rootRelsXML({ thumbnailPath: thumbPkgRelPath, viewImages: viewRelPaths }));
  if (extra) {
    for (const p of Object.keys(extra)) {
      const path = String(p).replace(/^\/+/, '');
      const data = extra[p];
      // Detect if binary/Uint8Array; otherwise treat as string
      if (data instanceof Uint8Array) {
        zip.file(path, data);
      } else {
        zip.file(path, String(data));
      }
    }
  }
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return data;
}
