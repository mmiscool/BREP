// Basic 3MF exporter using JSZip
// - Packages a minimal 3MF container with a single model file
// - Supports exporting one or multiple SOLID objects from the scene
// - Uses current manifold mesh data: vertProperties (float triples) and triVerts (index triples)

import JSZip from 'jszip';

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

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<model xml:lang="en-US" unit="' + xmlEsc(unit) + '" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  lines.push('  <resources>');

  let objId = 1;
  const ids = [];
  for (const s of (solids || [])) {
    if (!s || typeof s.getMesh !== 'function') continue;
    const mesh = s.getMesh();
    if (!mesh || !mesh.vertProperties || !mesh.triVerts) continue;
    const name = xmlEsc(s.name || `solid_${objId}`);
    const vp = mesh.vertProperties; // Float32Array
    const tv = mesh.triVerts;       // Uint32Array

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
    for (let t = 0; t < tCount; t++) {
      const v1 = tv[t * 3 + 0] >>> 0;
      const v2 = tv[t * 3 + 1] >>> 0;
      const v3 = tv[t * 3 + 2] >>> 0;
      lines.push(`          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`);
    }
    lines.push('        </triangles>');

    lines.push('      </mesh>');
    lines.push('    </object>');
    ids.push(objId);
    objId++;
  }

  lines.push('  </resources>');
  lines.push('  <build>');
  for (const id of ids) {
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
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return data;
}

export default generate3MF;
