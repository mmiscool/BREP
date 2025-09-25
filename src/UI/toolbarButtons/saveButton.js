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
      const json = await viewer?.partHistory?.toJSON?.();
      const payload = { savedAt: new Date().toISOString(), data: JSON.parse(json) };
      localStorage.setItem('__BREP_MODEL__:autosave', JSON.stringify(payload));
      localStorage.setItem('__BREP_MODELS_LASTNAME__', 'autosave');
      alert('Saved as "autosave"');
    } catch {
      alert('Save failed.');
    }
  }

  return { label: '💾', title: 'Save current model', onClick };
}

