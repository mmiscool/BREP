export function renderOptionsField({ ui, key, def, id }) {
    const inputEl = document.createElement('select');
    inputEl.id = id;
    inputEl.className = 'select';

    const opts = Array.isArray(def.options) ? def.options : [];
    for (let i = 0; i < opts.length; i++) {
        const opt = opts[i];
        const o = document.createElement('option');
        o.value = String(opt);
        o.textContent = String(opt);
        inputEl.appendChild(o);
    }

    ui._setInputValue(inputEl, 'options', ui._pickInitialValue(key, def));

    inputEl.addEventListener('change', () => {
        const v = inputEl.value;
        ui.params[key] = v;
        ui._emitParamsChange(key, v);
        ui._stopActiveReferenceSelection();
    });

    return {
        inputEl,
        activate() {
            inputEl.focus();
        },
        readValue() {
            return inputEl.value;
        },
    };
}
