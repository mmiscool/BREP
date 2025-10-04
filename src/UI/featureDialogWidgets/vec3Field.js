export function renderVec3Field({ ui, key, def }) {
    const inputEl = document.createElement('div');
    inputEl.className = 'transform-grid';

    const showUniform = Boolean(def && (def.uniformToggle === true));
    let uniformChecked = Boolean(def && (def.uniformDefault === true));
    let uniformCb = null;
    if (showUniform) {
        const uniformWrap = document.createElement('div');
        uniformWrap.className = 'transform-row';
        const spacer = document.createElement('div');
        spacer.className = 'transform-label';
        spacer.textContent = '';
        const controls = document.createElement('div');
        controls.className = 'transform-inputs';
        const cbLabel = document.createElement('label');
        cbLabel.style.display = 'inline-flex';
        cbLabel.style.alignItems = 'center';
        cbLabel.style.gap = '6px';
        uniformCb = document.createElement('input');
        uniformCb.type = 'checkbox';
        uniformCb.checked = uniformChecked;
        const txt = document.createElement('span');
        txt.textContent = String(def.uniformLockLabel || 'Uniform');
        cbLabel.appendChild(uniformCb);
        cbLabel.appendChild(txt);
        controls.appendChild(cbLabel);
        uniformWrap.appendChild(spacer);
        uniformWrap.appendChild(controls);
        inputEl.appendChild(uniformWrap);
    }

    const mkRow = (labelText) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'transform-row';
        const lab = document.createElement('div');
        lab.className = 'transform-label';
        lab.textContent = labelText;
        const inputsWrap = document.createElement('div');
        inputsWrap.className = 'transform-inputs';
        rowEl.appendChild(lab);
        rowEl.appendChild(inputsWrap);
        return { rowEl, inputsWrap };
    };

    const { rowEl, inputsWrap } = mkRow('XYZ');
    inputEl.appendChild(rowEl);

    const valuesArr = (() => {
        const v = ui._pickInitialValue(key, def);
        if (Array.isArray(v)) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
        if (v && typeof v === 'object') return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
        return [0, 0, 0];
    })();

    const stepStr = (def && (def.step != null)) ? String(def.step) : 'any';

    const setParamFromInputs = () => {
        const inps = Array.from(inputsWrap.querySelectorAll('input'));
        const arr = inps.map((el) => el.value);
        ui.params[key] = [arr[0], arr[1], arr[2]];
        ui._emitParamsChange(key, ui.params[key]);
    };

    const inputs = [];
    const numericPattern = /^-?\d*\.?\d*$/;
    const isNumericLike = (value) => {
        if (value === '' || value == null) return true;
        return numericPattern.test(String(value));
    };
    const toggleTypeForContent = (el) => {
        try {
            if (isNumericLike(el.value)) el.type = 'number';
            else el.type = 'text';
        } catch (_) { }
    };

    for (let i = 0; i < 3; i++) {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.className = 'input transform-input';
        inp.step = stepStr;
        ui._setInputValue(inp, 'number', valuesArr[i] ?? 0);
        inp.addEventListener('focus', () => toggleTypeForContent(inp));
        inp.addEventListener('beforeinput', (e) => {
            try {
                const nextVal = String(inp.value || '') + String(e.data || '');
                if (!isNumericLike(nextVal)) {
                    if (inp.type !== 'text') inp.type = 'text';
                } else if (inp.type !== 'number') {
                    inp.type = 'number';
                }
            } catch (_) { }
        });
        inp.addEventListener('change', () => {
            if (showUniform && uniformCb && uniformCb.checked) {
                const v = inp.value;
                for (const other of inputsWrap.querySelectorAll('input')) other.value = v;
            }
            setParamFromInputs();
        });
        inputsWrap.appendChild(inp);
        inputs.push(inp);
    }

    if (showUniform && uniformCb) {
        const enforceUniformNow = () => {
            if (uniformCb.checked && inputs.length) {
                const v = inputs[0].value;
                for (let i = 0; i < inputs.length; i++) inputs[i].value = String(v);
                setParamFromInputs();
            }
        };
        uniformCb.addEventListener('change', () => enforceUniformNow());
        if (uniformChecked) enforceUniformNow();
    }

    return {
        inputEl,
        activate() {
            const first = inputEl.querySelector('input');
            if (first) first.focus();
        },
        readValue() {
            const current = ui.params[key];
            if (Array.isArray(current)) return current.slice(0, 3);
            if (current && typeof current === 'object') {
                return [current.x ?? 0, current.y ?? 0, current.z ?? 0];
            }
            return [0, 0, 0];
        },
    };
}
