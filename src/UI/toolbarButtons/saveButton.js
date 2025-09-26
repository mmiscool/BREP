import { generate3MF } from '../../exporters/threeMF.js';
import { jsonToXml } from '../../utils/jsonXml.js';
import { localStorage as LS } from '../../localStorageShim.js';

function _uint8ToBase64(uint8) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    const sub = uint8.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, sub);
  }
  return btoa(binary);
}

export function createSaveButton(viewer) {
  async function _captureThumbnail(size = 60) {
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
  async function onClick() {
    // Prefer the FileManagerWidget if present
    try {
      if (viewer?.fileManagerWidget?.saveCurrent) {
        await viewer.fileManagerWidget.saveCurrent();
        return;
      }
    } catch {}
    // Fallback: quick autosave to localStorage shim
    try {
      // Produce a compact 3MF that embeds feature history only
      const json = await viewer?.partHistory?.toJSON?.();
      let additionalFiles = undefined;
      let modelMetadata = undefined;
      try {
        if (json && typeof json === 'string') {
          const obj = JSON.parse(json);
          if (obj && typeof obj === 'object') {
            const fhXml = jsonToXml(obj, 'featureHistory');
            additionalFiles = { 'Metadata/featureHistory.xml': fhXml };
            modelMetadata = { featureHistoryPath: '/Metadata/featureHistory.xml' };
          }
        }
      } catch {}
      const thumbnail = await _captureThumbnail(60);
      const bytes = await generate3MF([], { unit: 'millimeter', precision: 6, scale: 1, additionalFiles, modelMetadata, thumbnail });
      const b64 = _uint8ToBase64(bytes);
      // Do not persist a separate thumbnail; it's embedded in the 3MF
      const payload = { savedAt: new Date().toISOString(), data3mf: b64 };
      LS.setItem('__BREP_MODEL__:autosave', JSON.stringify(payload));
      LS.setItem('__BREP_MODELS_LASTNAME__', 'autosave');
      alert('Saved as "autosave"');
    } catch {
      alert('Save failed.');
    }
  }

  return { label: '💾', title: 'Save current model', onClick };
}
