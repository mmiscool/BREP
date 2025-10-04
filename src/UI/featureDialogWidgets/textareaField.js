export function renderTextareaField({ ui, key, def, id }) {
    const inputEl = document.createElement('textarea');
    inputEl.id = id;
    inputEl.className = 'input textarea';

    if (def && def.rows != null) {
        const rows = parseInt(def.rows, 10);
        if (Number.isFinite(rows) && rows > 0) inputEl.rows = rows;
    }
    if (def && typeof def.placeholder === 'string') inputEl.placeholder = def.placeholder;

    ui._setInputValue(inputEl, 'string', ui._pickInitialValue(key, def));

    inputEl.addEventListener('change', () => {
        ui.params[key] = inputEl.value;
        ui._emitParamsChange(key, inputEl.value);
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
