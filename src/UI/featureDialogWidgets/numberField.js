export function renderNumberField({ ui, key, def, id }) {
    const inputEl = document.createElement('input');
    inputEl.type = 'number';
    inputEl.id = id;
    inputEl.className = 'input';

    try {
        if (def && (typeof def.step === 'number' || (typeof def.step === 'string' && def.step.trim() !== ''))) {
            inputEl.step = String(def.step);
            inputEl.dataset.step = String(def.step);
        }
        if (def && (typeof def.min === 'number' || (typeof def.min === 'string' && def.min !== ''))) {
            inputEl.min = String(def.min);
            inputEl.dataset.min = String(def.min);
        }
        if (def && (typeof def.max === 'number' || (typeof def.max === 'string' && def.max !== ''))) {
            inputEl.max = String(def.max);
            inputEl.dataset.max = String(def.max);
        }
    } catch (_) { }

    const numericPattern = /^-?\d*\.?\d*$/;

    function isNumericLike(value) {
        //console.log('isNumericLike:', value);
        return numericPattern.test(value);
    }

    const DEBUG_UI = false;
    inputEl.addEventListener('beforeinput', (e) => {
        if (DEBUG_UI) console.log('beforeinput event fired');
        if (DEBUG_UI) console.log('inputEl.value:', inputEl.value);
        if (DEBUG_UI) console.log('e.data:', e.data);

        if (isNumericLike(inputEl.value) && isNumericLike(e.data) && inputEl.type === 'text') {
            if (DEBUG_UI) console.log('input type was text but we are changing it to a number');
            if (inputEl.type !== 'number') inputEl.type = 'number';
            return;
        } else if (!isNumericLike(inputEl.value) || (!isNumericLike(e.data) && inputEl.type === 'number')) {
            if (inputEl.type !== 'text') {
                inputEl.type = 'text';
                inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
            }
        }
    });

    ui._setInputValue(inputEl, def.type, ui._pickInitialValue(key, def));

    inputEl.addEventListener('change', () => {
        ui.params[key] = inputEl.value;
        ui._emitParamsChange(key, inputEl.value);
    });

    inputEl.addEventListener('focus', () => {
        inputEl.select();
        if (isNumericLike(inputEl.value)) {
            inputEl.type = 'number';
            try {
                if (inputEl.dataset && inputEl.dataset.step) inputEl.step = inputEl.dataset.step;
                if (inputEl.dataset && inputEl.dataset.min) inputEl.min = inputEl.dataset.min;
                if (inputEl.dataset && inputEl.dataset.max) inputEl.max = inputEl.dataset.max;
            } catch (_) { }
        } else {
            inputEl.type = 'text';
        }
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
