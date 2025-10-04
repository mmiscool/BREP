export function renderDefaultField({ ui, key, def, id }) {
    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.id = id;
    inputEl.className = 'input';

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
