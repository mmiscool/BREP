import { generate3MF } from '../../exporters/threeMF.js';
import { jsonToXml } from '../../utils/jsonXml.js';

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
  async function onClick() {
    // Prefer the FileManagerWidget if present
    try {
      if (viewer?.fileManagerWidget?.saveCurrent) {
        await viewer.fileManagerWidget.saveCurrent();
        return;
      }
    } catch {}
    // Fallback: quick autosave to localStorage
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
      const bytes = await generate3MF([], { unit: 'millimeter', precision: 6, scale: 1, additionalFiles, modelMetadata });
      const b64 = _uint8ToBase64(bytes);
      const payload = { savedAt: new Date().toISOString(), data3mf: b64 };
      localStorage.setItem('__BREP_MODEL__:autosave', JSON.stringify(payload));
      localStorage.setItem('__BREP_MODELS_LASTNAME__', 'autosave');
      alert('Saved as "autosave"');
    } catch {
      alert('Save failed.');
    }
  }

  return { label: '💾', title: 'Save current model', onClick };
}
