export function renderTransformField({ ui, key, def, id, controlWrap, valueAdapter = null }) {
    const inputEl = document.createElement('input');
    inputEl.type = 'hidden';
    inputEl.id = id;

    const wrap = document.createElement('div');
    wrap.className = 'transform-wrap';

    const adapter = (valueAdapter && typeof valueAdapter === 'object') ? valueAdapter : null;
    const activationKey = (adapter && typeof adapter.activationKey === 'string') ? adapter.activationKey : key;
    const clone3 = (arr, fallback) => {
        const copy = Array.isArray(arr) ? arr.slice(0, 3) : [];
        while (copy.length < 3) copy.push(fallback);
        return copy;
    };
    const sanitizeTRS = (raw) => {
        const obj = (raw && typeof raw === 'object') ? raw : {};
        return {
            position: clone3(obj.position, 0),
            rotationEuler: clone3(obj.rotationEuler, 0),
            scale: clone3(obj.scale, 1),
        };
    };
    const readTRS = () => {
        if (adapter && typeof adapter.get === 'function') {
            try { return sanitizeTRS(adapter.get()); } catch (_) { return sanitizeTRS(null); }
        }
        return sanitizeTRS(ui._pickInitialValue(key, def));
    };
    const writeTRS = (next) => {
        const sanitized = sanitizeTRS(next);
        if (adapter && typeof adapter.set === 'function') {
            try {
                adapter.set({
                    position: sanitized.position.slice(0, 3),
                    rotationEuler: sanitized.rotationEuler.slice(0, 3),
                    scale: sanitized.scale.slice(0, 3),
                });
            } catch (_) { /* ignore adapter errors */ }
        } else {
            ui.params[key] = {
                position: sanitized.position.slice(0, 3),
                rotationEuler: sanitized.rotationEuler.slice(0, 3),
                scale: sanitized.scale.slice(0, 3),
            };
        }
        return sanitized;
    };
    const emitChange = (value) => {
        if (adapter && typeof adapter.emit === 'function') {
            try { adapter.emit(value); return; } catch (_) { return; }
        }
        ui._emitParamsChange(activationKey, value);
    };

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = String(def.label || 'Position in 3D…');

    const info = document.createElement('div');
    info.className = 'transform-info';
    const fmt = (n) => {
        const v = Number(n);
        if (!Number.isFinite(v)) return '0';
        const a = Math.abs(v);
        const prec = a >= 100 ? 0 : (a >= 10 ? 1 : 2);
        return String(v.toFixed(prec));
    };
    const updateInfo = (value = null) => {
        const v = value ? sanitizeTRS(value) : readTRS();
        const p = Array.isArray(v.position) ? v.position : [0, 0, 0];
        const r = Array.isArray(v.rotationEuler) ? v.rotationEuler : [0, 0, 0];
        info.textContent = `pos(${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])})  rot(${fmt(r[0])}, ${fmt(r[1])}, ${fmt(r[2])})`;
    };
    updateInfo();

    const modes = document.createElement('div');
    modes.className = 'transform-modes';
    const mkModeBtn = (label, mode) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-slim';
        b.textContent = label;
        b.dataset.mode = mode;
        b.addEventListener('click', () => {
            inputEl.dataset.xformMode = mode;
            try { ui.setActiveTransformMode?.(inputEl, mode); } catch (_) { }
            modes.querySelectorAll('button[data-mode]').forEach((x) => x.classList.toggle('selected', x === b));
        });
        return b;
    };
    const bT = mkModeBtn('Move', 'translate');
    const bR = mkModeBtn('Rotate', 'rotate');
    bT.setAttribute('data-mode', 'translate');
    bR.setAttribute('data-mode', 'rotate');
    modes.appendChild(bT);
    modes.appendChild(bR);
    const defMode = inputEl.dataset.xformMode || 'translate';
    ({ translate: bT, rotate: bR }[defMode] || bT).classList.add('selected');

    const numericPattern = /^-?\d*\.?\d*$/;
    const isNumericLike = (value) => {
        if (value === '' || value == null) return true;
        return numericPattern.test(String(value));
    };
    const onFocusToggleType = (el) => {
        try {
            if (isNumericLike(el.value)) {
                el.type = 'number';
            } else {
                el.type = 'text';
            }
        } catch (_) { }
    };

    const getTRS = () => readTRS();
    const setTRS = (next, applyTarget = true, options = {}) => {
        const { skipWrite = false } = options;
        const sanitized = skipWrite ? sanitizeTRS(next) : writeTRS(next);
        try { updateInfo(sanitized); } catch (_) {}
        try {
            const row = ui._fieldsWrap.querySelector(`[data-key="${key}"]`);
            const scope = row || wrap;
            const map = [
                ['.tf-pos-x', sanitized.position[0]],
                ['.tf-pos-y', sanitized.position[1]],
                ['.tf-pos-z', sanitized.position[2]],
                ['.tf-rot-x', sanitized.rotationEuler[0]],
                ['.tf-rot-y', sanitized.rotationEuler[1]],
                ['.tf-rot-z', sanitized.rotationEuler[2]],
            ];
            for (const [sel, val] of map) {
                const el = scope ? scope.querySelector(sel) : null;
                if (el) ui._setInputValue(el, 'number', val);
            }
        } catch (_) {}
        if (applyTarget) {
            try {
                const active = ui.activeTransform;
                if (active && active.inputEl === inputEl && active.target) {
                    const toNum = (v) => (typeof v === 'number' ? v : (isNumericLike(v) ? Number(v) : 0));
                    active.target.position.set(toNum(sanitized.position[0]), toNum(sanitized.position[1]), toNum(sanitized.position[2]));
                    active.target.rotation.set(toNum(sanitized.rotationEuler[0]), toNum(sanitized.rotationEuler[1]), toNum(sanitized.rotationEuler[2]));
                }
            } catch (_) { }
        }
        return sanitized;
    };

    const grid = document.createElement('div');
    grid.className = 'transform-grid';
    const addRow = (labelTxt, clsPrefix, valuesArr) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'transform-row';
        const lab = document.createElement('div');
        lab.className = 'transform-label';
        lab.textContent = labelTxt;
        const inputs = document.createElement('div');
        inputs.className = 'transform-inputs';
        const axes = ['x', 'y', 'z'];
        for (let i = 0; i < 3; i++) {
            const inp = document.createElement('input');
            inp.className = 'input transform-input ' + `tf-${clsPrefix}-${axes[i]}`;
            inp.type = 'number';
            inp.step = 'any';
            ui._setInputValue(inp, 'number', valuesArr[i] ?? 0);
            const numericPatternLocal = /^-?\d*\.?\d*$/;
            const isNumericLikeLocal = (value) => {
                if (value === '' || value == null) return true;
                return numericPatternLocal.test(String(value));
            };
            const onFocusToggleTypeLocal = (el) => {
                try {
                    if (isNumericLikeLocal(el.value)) {
                        el.type = 'number';
                    } else {
                        el.type = 'text';
                    }
                } catch (_) { }
            };
            inp.addEventListener('focus', () => {
                onFocusToggleTypeLocal(inp);
                ui._stopActiveReferenceSelection();
            });
            inp.addEventListener('beforeinput', (e) => {
                try {
                    const nextVal = String(inp.value || '') + String(e.data || '');
                    if (!isNumericLikeLocal(nextVal)) {
                        if (inp.type !== 'text') inp.type = 'text';
                    } else if (inp.type !== 'number') {
                        inp.type = 'number';
                    }
                } catch (_) { }
            });
            inp.addEventListener('change', () => {
                const cur = getTRS();
                const val = inp.value;
                if (clsPrefix === 'pos') cur.position[i] = val;
                else cur.rotationEuler[i] = val;
                const updated = setTRS(cur, true);
                emitChange(updated);
            });
            inputs.appendChild(inp);
        }
        rowEl.appendChild(lab);
        rowEl.appendChild(inputs);
        grid.appendChild(rowEl);
    };
    const curTRS = getTRS();
    addRow('Position', 'pos', curTRS.position);
    addRow('Rotation', 'rot', curTRS.rotationEuler);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn btn-slim';
    resetBtn.textContent = 'Reset';
    resetBtn.title = 'Reset translation and rotation to 0';
    resetBtn.addEventListener('click', () => {
        const cur = getTRS();
        const next = { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: cur.scale };
        const updated = setTRS(next, true);
        emitChange(updated);
        const featureID = (ui.params && Object.prototype.hasOwnProperty.call(ui.params, 'featureID'))
            ? ui.params.featureID
            : null;
        if (typeof ui.options.onChange === 'function') ui.options.onChange(featureID);
    });
    modes.appendChild(resetBtn);

    const buildTransformAdapter = () => {
        if (!adapter) return null;
        const wrapper = {};
        if (typeof adapter.stepId === 'string') wrapper.stepId = adapter.stepId;
        wrapper.get = () => {
            if (typeof adapter.get === 'function') {
                try { return sanitizeTRS(adapter.get()); } catch (_) { return readTRS(); }
            }
            return readTRS();
        };
        wrapper.set = (value) => {
            const sanitized = sanitizeTRS(value);
            if (typeof adapter.set === 'function') {
                try { adapter.set(sanitized); } catch (_) { }
                setTRS(sanitized, true, { skipWrite: true });
            } else {
                setTRS(sanitized, true);
            }
            emitChange(sanitized);
        };
        if (typeof adapter.getBase === 'function') {
            wrapper.getBase = () => {
                try { return adapter.getBase(); } catch (_) { return null; }
            };
        }
        return wrapper;
    };
    const transformValueAdapter = buildTransformAdapter();
    const activate = () => ui._activateTransformWidget({ inputEl, wrapEl: wrap, key: activationKey, def, valueAdapter: transformValueAdapter });
    btn.addEventListener('click', activate);

    wrap.appendChild(btn);
    const details = document.createElement('div');
    details.className = 'transform-details';
    details.appendChild(modes);
    details.appendChild(grid);
    details.appendChild(info);
    wrap.appendChild(details);
    wrap.appendChild(inputEl);
    controlWrap.appendChild(wrap);

    return {
        inputEl,
        activate,
        readValue() {
            return readTRS();
        },
    };
}
