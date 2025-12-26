export function renderNumberField({ ui, key, def, id, controlWrap }) {
    const wrap = document.createElement('div');
    wrap.className = 'number-input-wrap';

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.id = id;
    inputEl.className = 'input number-input';
    inputEl.dataset.forceText = 'true';

    try {
        if (def && (typeof def.step === 'number' || (typeof def.step === 'string' && def.step.trim() !== ''))) {
            inputEl.dataset.step = String(def.step);
        }
        if (def && (typeof def.min === 'number' || (typeof def.min === 'string' && def.min !== ''))) {
            inputEl.dataset.min = String(def.min);
        }
        if (def && (typeof def.max === 'number' || (typeof def.max === 'string' && def.max !== ''))) {
            inputEl.dataset.max = String(def.max);
        }
    } catch (_) { }

    const stepper = document.createElement('div');
    stepper.className = 'number-stepper';
    const stepUp = document.createElement('button');
    stepUp.type = 'button';
    stepUp.className = 'number-stepper-btn number-stepper-up';
    stepUp.setAttribute('aria-label', 'Increment');
    const stepDown = document.createElement('button');
    stepDown.type = 'button';
    stepDown.className = 'number-stepper-btn number-stepper-down';
    stepDown.setAttribute('aria-label', 'Decrement');
    stepper.appendChild(stepUp);
    stepper.appendChild(stepDown);

    wrap.appendChild(inputEl);
    wrap.appendChild(stepper);
    if (controlWrap) controlWrap.appendChild(wrap);

    ui._setInputValue(inputEl, def.type, ui._pickInitialValue(key, def));

    const commitValue = () => {
        ui.params[key] = inputEl.value;
        ui._emitParamsChange(key, inputEl.value);
    };

    inputEl.addEventListener('change', commitValue);

    inputEl.addEventListener('focus', () => {
        inputEl.select();
        ui._stopActiveReferenceSelection();
    });

    const numericLike = /^\s*[-+]?((\d+(?:\.\d*)?)|(\.\d+))(?:[eE][-+]?\d+)?\s*$/;
    const readLimit = (name) => {
        const raw = inputEl.dataset ? inputEl.dataset[name] : null;
        if (raw == null || raw === '') return null;
        const num = Number(raw);
        return Number.isFinite(num) ? num : null;
    };
    const readStep = () => {
        const raw = inputEl.dataset ? inputEl.dataset.step : null;
        const num = Number(raw);
        if (!Number.isFinite(num) || num === 0) return 1;
        return Math.abs(num);
    };
    const readBase = () => {
        const raw = String(inputEl.value || '').trim();
        if (!raw) {
            const minVal = readLimit('min');
            return Number.isFinite(minVal) ? minVal : 0;
        }
        if (!numericLike.test(raw)) return null;
        const num = Number(raw);
        return Number.isFinite(num) ? num : null;
    };
    const applyStep = (dir, options = {}) => {
        const { commit = true, focus = true } = options;
        const base = readBase();
        if (base == null) return false;
        const step = readStep();
        let next = base + dir * step;
        const minVal = readLimit('min');
        const maxVal = readLimit('max');
        if (Number.isFinite(minVal)) next = Math.max(minVal, next);
        if (Number.isFinite(maxVal)) next = Math.min(maxVal, next);
        ui._setInputValue(inputEl, 'number', next);
        if (commit) commitValue();
        if (focus) {
            inputEl.focus();
            inputEl.select();
        }
        return true;
    };
    const preventBlur = (ev) => {
        ev.preventDefault();
    };
    const repeat = { delay: 350, interval: 80 };
    let repeatTimeout = null;
    let repeatInterval = null;
    let clearClickTimeout = null;
    let didRepeatStep = false;
    let suppressClick = false;
    const stopRepeat = () => {
        if (repeatTimeout) clearTimeout(repeatTimeout);
        if (repeatInterval) clearInterval(repeatInterval);
        repeatTimeout = null;
        repeatInterval = null;
        if (didRepeatStep) {
            commitValue();
            didRepeatStep = false;
        }
        if (suppressClick) {
            if (clearClickTimeout) clearTimeout(clearClickTimeout);
            clearClickTimeout = setTimeout(() => { suppressClick = false; }, 200);
        }
    };
    const startRepeat = (dir) => {
        stopRepeat();
        didRepeatStep = applyStep(dir, { commit: false, focus: true });
        if (!didRepeatStep) return;
        repeatTimeout = setTimeout(() => {
            repeatInterval = setInterval(() => {
                if (applyStep(dir, { commit: false, focus: false })) didRepeatStep = true;
            }, repeat.interval);
        }, repeat.delay);
        window.addEventListener('pointerup', stopRepeat, { once: true });
        window.addEventListener('pointercancel', stopRepeat, { once: true });
        return true;
    };
    stepUp.addEventListener('pointerdown', (ev) => {
        preventBlur(ev);
        suppressClick = Boolean(startRepeat(1));
    });
    stepDown.addEventListener('pointerdown', (ev) => {
        preventBlur(ev);
        suppressClick = Boolean(startRepeat(-1));
    });
    stepUp.addEventListener('click', () => {
        if (suppressClick) {
            suppressClick = false;
            if (clearClickTimeout) clearTimeout(clearClickTimeout);
            return;
        }
        applyStep(1);
    });
    stepDown.addEventListener('click', () => {
        if (suppressClick) {
            suppressClick = false;
            if (clearClickTimeout) clearTimeout(clearClickTimeout);
            return;
        }
        applyStep(-1);
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
