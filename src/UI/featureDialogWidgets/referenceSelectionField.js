import { normalizeReferenceList, normalizeReferenceName } from './utils.js';

export function renderReferenceSelectionField({ ui, key, def, id, controlWrap, valueAdapter = null }) {
    const inputEl = document.createElement('input');
    inputEl.type = 'hidden';
    inputEl.id = id;

    const isMulti = !!def.multiple;
    if (isMulti) inputEl.dataset.multiple = 'true';

    const placeholderText = (typeof def.placeholder === 'string' && def.placeholder.trim())
        ? def.placeholder.trim()
        : 'Click then select in scene…';

    const adapter = (valueAdapter && typeof valueAdapter === 'object') ? valueAdapter : null;
    const readRawValue = () => {
        if (adapter && typeof adapter.read === 'function') {
            try { return adapter.read(); } catch (_) { return null; }
        }
        return ui._pickInitialValue(key, def);
    };
    const writeRawValue = (next) => {
        if (adapter && typeof adapter.write === 'function') {
            try { adapter.write(next); return; } catch (_) { return; }
        }
        ui.params[key] = next;
    };
    const emitChange = (value) => {
        if (adapter && typeof adapter.emit === 'function') {
            try { adapter.emit(value); return; } catch (_) { return; }
        }
        ui._emitParamsChange(key, value);
    };

    const refWrap = document.createElement('div');
    refWrap.className = isMulti ? 'ref-multi-wrap' : 'ref-single-wrap';

    let chipsWrap = null;
    if (isMulti) {
        chipsWrap = document.createElement('div');
        chipsWrap.className = 'ref-chips';
        chipsWrap.addEventListener('click', () => ui._activateReferenceSelection(inputEl, def));
        refWrap.appendChild(chipsWrap);
        try {
            const initial = readRawValue();
            const current = normalizeReferenceList(Array.isArray(initial) ? initial : []);
            writeRawValue(current);
            ui._renderChips(chipsWrap, key, current);
        } catch (_) { }
    } else {
        const valueWrap = document.createElement('button');
        valueWrap.type = 'button';
        valueWrap.className = 'ref-single-display';
        valueWrap.title = placeholderText;
        valueWrap.dataset.placeholder = placeholderText;

        const label = document.createElement('span');
        label.className = 'ref-single-label';
        valueWrap.appendChild(label);

        const clearBtn = document.createElement('span');
        clearBtn.className = 'ref-chip-remove';
        clearBtn.role = 'button';
        clearBtn.tabIndex = 0;
        clearBtn.title = 'Clear selection';
        clearBtn.textContent = '✕';

        const clearSelection = (ev) => {
            ev.stopPropagation();
            ev.preventDefault?.();
            writeRawValue(null);
            inputEl.value = '';
            updateSingleDisplay(null);
            emitChange(null);
        };

        clearBtn.addEventListener('click', clearSelection);
        clearBtn.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                clearSelection(ev);
            }
        });
        valueWrap.appendChild(clearBtn);

        const updateSingleDisplay = (val) => {
            const normalized = normalizeReferenceName(val);
            label.textContent = normalized || placeholderText;
            clearBtn.style.visibility = normalized ? 'visible' : 'hidden';
        };

        const initial = normalizeReferenceName(readRawValue());
        writeRawValue(initial);
        updateSingleDisplay(initial);
        inputEl.value = initial ?? '';

        valueWrap.addEventListener('click', () => ui._activateReferenceSelection(inputEl, def));
        refWrap.appendChild(valueWrap);

        inputEl.addEventListener('change', () => {
            updateSingleDisplay(inputEl.value);
            const normalized = normalizeReferenceName(inputEl.value);
            writeRawValue(normalized);
            emitChange(normalized);
        });
    }

    ui._setInputValue(inputEl, def.type, readRawValue());

    inputEl.addEventListener('change', () => {
        const raw = inputEl.value;
        if (isMulti) {
            if (inputEl.dataset && inputEl.dataset.forceClear === 'true') {
                writeRawValue([]);
                if (chipsWrap) ui._renderChips(chipsWrap, key, []);
                inputEl.value = '';
                delete inputEl.dataset.forceClear;
                emitChange(adapter ? readRawValue() : []);
                return;
            }
            let incoming = [];
            let parsedArray = false;
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) { incoming = parsed; parsedArray = true; }
            } catch (_) { }
            if (!parsedArray && raw != null && String(raw).trim() !== '') incoming = [String(raw).trim()];

            const existingRaw = readRawValue();
            const current = Array.isArray(existingRaw) ? existingRaw : [];
            const next = current.slice();
            for (const name of incoming) {
                const normalized = normalizeReferenceName(name);
                if (!normalized) continue;
                if (!next.includes(normalized)) next.push(normalized);
            }
            const normalizedList = normalizeReferenceList(next);
            writeRawValue(normalizedList);
            if (chipsWrap) ui._renderChips(chipsWrap, key, normalizedList);
            inputEl.value = '';
            emitChange(adapter ? readRawValue() : normalizedList);
        } else {
            const normalized = normalizeReferenceName(raw);
            inputEl.value = normalized ?? '';
            writeRawValue(normalized);
            emitChange(normalized);
        }
    });

    refWrap.appendChild(inputEl);
    controlWrap.appendChild(refWrap);

    const activate = () => ui._activateReferenceSelection(inputEl, def);

    return {
        inputEl,
        activate,
        readValue() {
            const value = readRawValue();
            if (Array.isArray(value)) return normalizeReferenceList(value);
            return normalizeReferenceName(value);
        },
    };
}
