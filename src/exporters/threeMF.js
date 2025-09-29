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

/**
 * Build the core 3MF model XML for one or more solids.
 * @param {Array} solids Array of SOLID-like objects that expose getMesh() and name.
 * @param {{unit?: 'millimeter'|'inch'|'foot'|'meter'|'centimeter'|'micron', precision?: number}} opts
 * @returns {string}
 */
export function build3MFModelXML(solids, opts = {}) {
  const unit = opts.unit || 'millimeter';
  const precision = Number.isFinite(opts.precision) ? opts.precision : 6;
  const scale = Number.isFinite(opts.scale) ? opts.scale : 1.0;
  const modelMetadata = opts.modelMetadata && typeof opts.modelMetadata === 'object' ? opts.modelMetadata : null;
  const includeFaceTags = opts.includeFaceTags !== false; // default on

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
    const name = xmlEsc(s.name || `solid_${solidIdx + 1}`);
    const vp = mesh.vertProperties; // Float32Array
    const tv = mesh.triVerts;       // Uint32Array

    // Optional: build a per-object BaseMaterials resource to tag faces
    // We rely on mesh.faceID (Uint32Array) and, if available, a mapping on the Solid instance.
    let matPid = null; // resource id for this object's material group
    let faceIndexOf = null; // function: id -> material index
    if (includeFaceTags && mesh.faceID && mesh.faceID.length === (tv.length / 3 | 0)) {
      // Gather unique face IDs present on this mesh
      const faceIDs = mesh.faceID;
      const uniqueIds = [];
      const seen = new Set();
      for (let t = 0; t < faceIDs.length; t++) {
        const fid = faceIDs[t] >>> 0;
        if (!seen.has(fid)) { seen.add(fid); uniqueIds.push(fid); }
      }
      if (uniqueIds.length > 0) {
        // Map each ID to a readable name if available on the Solid, else fallback
        const idToName = new Map();
        const map = s && s._idToFaceName instanceof Map ? s._idToFaceName : null;
        for (let i = 0; i < uniqueIds.length; i++) {
          const fid = uniqueIds[i];
          const nm = (map && map.get(fid)) || `FACE_${fid}`;
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
          // Optional: deterministic color derived from name hash for readability
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
    lines.push(`    <object id="${objId}" type="model" name="${name}">`);
    lines.push('      <mesh>');

    // Vertices
    lines.push('        <vertices>');
    const vCount = (vp.length / 3) | 0;
    for (let i = 0; i < vCount; i++) {
      const x = numStr(vp[i * 3 + 0] * scale, precision);
      const y = numStr(vp[i * 3 + 1] * scale, precision);
      const z = numStr(vp[i * 3 + 2] * scale, precision);
      lines.push(`          <vertex x="${x}" y="${y}" z="${z}"/>`);
    }
    lines.push('        </vertices>');

    // Triangles
    lines.push('        <triangles>');
    const tCount = (tv.length / 3) | 0;
    if (matPid != null && mesh.faceID && mesh.faceID.length === tCount && faceIndexOf) {
      const faceIDs = mesh.faceID;
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

function rootRelsXML() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
    '</Relationships>'
  ].join('\n');
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
 * @param {{unit?: string, precision?: number}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function generate3MF(solids, opts = {}) {
  const modelXml = build3MFModelXML(solids, opts);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXML());
  zip.folder('_rels').file('.rels', rootRelsXML());
  zip.folder('3D').file('3dmodel.model', modelXml);
  // Optional thumbnail embedding (PNG/JPEG)
  let thumbRelPath = null;
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
        const path = `Thumbnails/${fname}`;
        zip.folder('Thumbnails').file(fname, bytes);
        thumbRelPath = `/${path}`; // absolute target from model part
      }
    } catch { /* ignore thumbnail errors */ }
  }
  // Add model part relationships if needed (e.g., thumbnail)
  if (thumbRelPath) {
    zip.folder('3D').folder('_rels').file('3dmodel.model.rels', modelPartRelsXML({ thumbnailPath: thumbRelPath }));
  }
  // Additional attachments (e.g., Metadata/featureHistory.xml)
  const extra = opts.additionalFiles && typeof opts.additionalFiles === 'object' ? opts.additionalFiles : null;
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

export default generate3MF;
