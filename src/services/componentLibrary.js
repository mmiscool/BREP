import JSZip from 'jszip';
import { localStorage as LS } from '../idbStorage.js';

export const MODEL_STORAGE_PREFIX = '__BREP_MODEL__:';

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function decodeModelKey(key) {
  try {
    return decodeURIComponent(key.slice(MODEL_STORAGE_PREFIX.length));
  } catch {
    return key.slice(MODEL_STORAGE_PREFIX.length);
  }
}

export function listComponentRecords() {
  const items = [];
  try {
    for (let i = 0; i < LS.length; i++) {
      const key = LS.key(i);
      if (!key || !key.startsWith(MODEL_STORAGE_PREFIX)) continue;
      const raw = LS.getItem(key);
      if (!raw) continue;
      const parsed = safeParse(raw);
      if (!parsed || (!parsed.data3mf && !parsed.data)) continue;
      const name = decodeModelKey(key);
      items.push({
        name,
        savedAt: parsed.savedAt || null,
        has3mf: typeof parsed.data3mf === 'string' && parsed.data3mf.length > 0,
        record: parsed,
      });
    }
  } catch {
    // ignore storage issues
  }

  items.sort((a, b) => {
    const aTime = a.savedAt ? Date.parse(a.savedAt) : 0;
    const bTime = b.savedAt ? Date.parse(b.savedAt) : 0;
    return bTime - aTime;
  });

  return items;
}

export function getComponentRecord(name) {
  if (!name) return null;
  const key = MODEL_STORAGE_PREFIX + encodeURIComponent(String(name));
  try {
    const raw = LS.getItem(key);
    if (!raw) return null;
    const parsed = safeParse(raw);
    if (!parsed) return null;
    return {
      name,
      savedAt: parsed.savedAt || null,
      data3mf: typeof parsed.data3mf === 'string' ? parsed.data3mf : null,
      data: parsed.data || null,
      thumbnail: typeof parsed.thumbnail === 'string' ? parsed.thumbnail : null,
    };
  } catch {
    return null;
  }
}

export function base64ToUint8Array(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return new Uint8Array();
  let payload = b64;
  if (payload.startsWith('data:') && payload.includes(';base64,')) {
    payload = payload.split(';base64,')[1] || '';
  }
  try {
    const binary = atob(payload);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
}

export function uint8ArrayToBase64(uint8) {
  if (!(uint8 instanceof Uint8Array) || uint8.length === 0) return '';
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < uint8.length; i += chunk) {
    const sub = uint8.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

export function setComponentRecord(name, dataObj) {
  if (!name) return;
  const key = MODEL_STORAGE_PREFIX + encodeURIComponent(String(name));
  try {
    LS.setItem(key, JSON.stringify(dataObj || {}));
  } catch {}
}

export function removeComponentRecord(name) {
  if (!name) return;
  const key = MODEL_STORAGE_PREFIX + encodeURIComponent(String(name));
  try {
    LS.removeItem(key);
  } catch {}
}

export async function extractThumbnailFrom3MFBase64(b64) {
  try {
    if (!b64) return null;
    let payload = b64;
    if (payload.startsWith('data:') && payload.includes(';base64,')) {
      payload = payload.split(';base64,')[1] || '';
    }
    const bytes = base64ToUint8Array(payload);
    const zip = await JSZip.loadAsync(bytes.buffer);
    const files = {};
    Object.keys(zip.files || {}).forEach((p) => { files[p.toLowerCase()] = p; });

    const readThumb = async (lfPath) => {
      const real = files[lfPath];
      if (!real) return null;
      const mime = lfPath.endsWith('.png') ? 'image/png' : (lfPath.match(/\.(jpe?g)$/) ? 'image/jpeg' : 'application/octet-stream');
      const imgU8 = await zip.file(real).async('uint8array');
      return `data:${mime};base64,${uint8ArrayToBase64(imgU8)}`;
    };

    const relsRoot = files['_rels/.rels'];
    if (relsRoot) {
      try {
        const relsXml = await zip.file(relsRoot).async('string');
        const relRe = /<Relationship\s+[^>]*Type="[^"]*metadata\/thumbnail[^"]*"[^>]*>/ig;
        const tgtRe = /Target="([^"]+)"/i;
        let match;
        while ((match = relRe.exec(relsXml))) {
          const tag = match[0];
          const tm = tgtRe.exec(tag);
          if (tm && tm[1]) {
            let target = tm[1];
            if (target.startsWith('/')) target = target.replace(/^\/+/, '');
            else target = target.replace(/^\/+/, '');
            const lf = target.toLowerCase();
            const thumb = await readThumb(lf);
            if (thumb) return thumb;
          }
        }
      } catch { /* ignore */ }
    }

    const relsModel = files['3d/_rels/3dmodel.model.rels'];
    if (relsModel) {
      try {
        const relsXml = await zip.file(relsModel).async('string');
        const relRe = /<Relationship\s+[^>]*Type="[^"]*metadata\/thumbnail[^"]*"[^>]*>/ig;
        const tgtRe = /Target="([^"]+)"/i;
        let match;
        while ((match = relRe.exec(relsXml))) {
          const tag = match[0];
          const tm = tgtRe.exec(tag);
          if (tm && tm[1]) {
            let target = tm[1];
            if (target.startsWith('/')) target = target.replace(/^\/+/, '');
            else {
              target = '3D/' + target;
              target = target.replace(/(^|\/)\.{2}\/(?!\.{2}|$)/g, '/');
              target = target.replace(/^\/+/, '');
            }
            const lf = target.toLowerCase();
            const thumb = await readThumb(lf);
            if (thumb) return thumb;
          }
        }
      } catch { /* ignore */ }
    }

    let thumbPath = Object.keys(files).find((k) => k.startsWith('metadata/') && (k.endsWith('.png') || k.endsWith('.jpg') || k.endsWith('.jpeg')));
    if (!thumbPath) {
      thumbPath = Object.keys(files).find((k) => k.startsWith('thumbnails/') && (k.endsWith('.png') || k.endsWith('.jpg') || k.endsWith('.jpeg')));
    }
    if (thumbPath) {
      const real = files[thumbPath];
      const mime = thumbPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const imgU8 = await zip.file(real).async('uint8array');
      return `data:${mime};base64,${uint8ArrayToBase64(imgU8)}`;
    }
    return null;
  } catch {
    return null;
  }
}
