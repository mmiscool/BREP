export function renderBooleanField({ ui, key, def, id }) {
    const inputEl = document.createElement('input');
    inputEl.type = 'checkbox';
    inputEl.id = id;
    inputEl.className = 'checkbox';

    ui._setInputValue(inputEl, 'boolean', ui._pickInitialValue(key, def));

    inputEl.addEventListener('change', () => {
        const v = Boolean(inputEl.checked);
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
            return Boolean(inputEl.checked);
        },
    };
}
