import { generate3MF } from '../../exporters/threeMF.js';
import { localStorage as LS } from '../../localStorageShim.js';
import * as THREE from 'three';

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
      const renderer = viewer?.renderer;
      const canvas = renderer?.domElement;
      const cam = viewer?.camera;
      const controls = viewer?.controls;
      if (!canvas || !cam) return null;

      // Temporarily reorient exactly like clicking the ViewCube corner (top-front-right)
      try {
        const dir = new THREE.Vector3(1, 1, 1);
        if (viewer?.viewCube && typeof viewer.viewCube._reorientCamera === 'function') {
          viewer.viewCube._reorientCamera(dir, 'SAVE THUMBNAIL');
        }
        // Fit geometry within this oriented view
        try { viewer.zoomToFit(1.1); } catch { }
      } catch { /* ignore orientation failures */ }

      // Ensure a fresh frame before capture
      try { viewer.render(); } catch { }

      // Wait one frame to be safe
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const srcW = canvas.width || canvas.clientWidth || 1;
      const srcH = canvas.height || canvas.clientHeight || 1;
      const dst = document.createElement('canvas');
      dst.width = size; dst.height = size;
      const ctx = dst.getContext('2d');
      if (!ctx) return null;
      try { ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, size, size); } catch { }
      const scale = Math.min(size / srcW, size / srcH);
      const dw = Math.max(1, Math.floor(srcW * scale));
      const dh = Math.max(1, Math.floor(srcH * scale));
      const dx = Math.floor((size - dw) / 2);
      const dy = Math.floor((size - dh) / 2);
      try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; } catch { }
      ctx.drawImage(canvas, 0, 0, srcW, srcH, dx, dy, dw, dh);
      const dataUrl = dst.toDataURL('image/png');
      return dataUrl;
    } catch { return null; }
  }
  async function onClick() {
    // Prefer the FileManagerWidget if present
    try {
      if (viewer?.fileManagerWidget?.saveCurrent) {
        await viewer.fileManagerWidget.saveCurrent();
        return;
      }
    } catch { }
    // Fallback: quick autosave to localStorage shim
    try {
      // Load PMI views into PartHistory before serializing
      try {
        viewer.partHistory.loadPMIViewsFromLocalStorage('autosave');
        console.log('[SaveButton] Loaded PMI views for autosave, found views:', viewer.partHistory.pmiViews?.length || 0);
      } catch (e) {
        console.warn('[SaveButton] Failed to load PMI views:', e);
      }

      // Produce a compact 3MF that embeds feature history (now includes PMI views) only
      const json = await viewer?.partHistory?.toJSON?.();
      let additionalFiles = undefined;
      let modelMetadata = undefined;
      try {
        if (json && typeof json === 'string') {
          additionalFiles = { 'Metadata/featureHistory.json': json };
          modelMetadata = { featureHistoryPath: '/Metadata/featureHistory.json' };
        }
      } catch { }

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
