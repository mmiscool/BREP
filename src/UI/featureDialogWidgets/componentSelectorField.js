import { openComponentSelectorModal } from '../componentSelectorModal.js';

export function renderComponentSelectorField({ ui, key, def, id, controlWrap }) {
  const wrap = document.createElement('div');
  wrap.className = 'component-selector-wrap';

  const inputEl = document.createElement('input');
  inputEl.type = 'text';
  inputEl.id = id;
  inputEl.className = 'input component-selector-input';
  inputEl.readOnly = true;
  inputEl.value = String(ui._pickInitialValue(key, def) || '');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn component-selector-btn';
  btn.textContent = String(def.buttonLabel || 'Choose…');

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-slim component-selector-clear';
  clearBtn.textContent = 'Clear';

  const applyValue = (value, record) => {
    inputEl.value = value || '';
    ui.params[key] = value || '';
    ui._emitParamsChange(key, ui.params[key]);
    if (typeof def.onSelect === 'function') {
      try {
        const ctx = {
          featureID: ui.params?.featureID ?? ui.params?.id ?? null,
          key,
          viewer: ui.options?.viewer || null,
          partHistory: ui.options?.partHistory || null,
          feature: ui.options?.featureRef || null,
          form: ui,
        };
        def.onSelect(ctx, record || null);
      } catch (_) { /* ignore handler errors */ }
    }
  };

  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ui._stopActiveReferenceSelection();
    const record = await openComponentSelectorModal({ title: def.dialogTitle || 'Select Component' });
    if (!record || !record.data3mf) return;
    applyValue(record.name || '', record);
  });

  clearBtn.addEventListener('click', () => {
    applyValue('', null);
  });

  wrap.appendChild(inputEl);
  const controls = document.createElement('div');
  controls.className = 'component-selector-controls';
  controls.appendChild(btn);
  controls.appendChild(clearBtn);
  wrap.appendChild(controls);

  if (controlWrap instanceof HTMLElement) {
    controlWrap.appendChild(wrap);
  }

  return {
    inputEl,
    activate() {
      btn.focus();
    },
    readValue() {
      return inputEl.value;
    }
  };
}

(function ensureComponentSelectorStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('component-selector-field-styles')) return;
  const style = document.createElement('style');
  style.id = 'component-selector-field-styles';
  style.textContent = `
    .component-selector-wrap {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .component-selector-wrap .component-selector-input {
      flex: 1 1 auto;
      min-width: 0;
    }
    .component-selector-controls {
      display: flex;
      gap: 6px;
      flex: 0 0 auto;
    }
    .component-selector-clear {
      padding: 4px 8px;
    }
  `;
  document.head.appendChild(style);
})();
