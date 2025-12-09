import { getThreadDesignationOptions, normalizeThreadStandard } from '../../features/hole/threadDesignationCatalog.js';

const CUSTOM_VALUE = '__custom__';

export function renderThreadDesignationField({ ui, key, def, id }) {
    const wrap = document.createElement('div');
    wrap.className = 'thread-designation-field';
    wrap.dataset.role = 'thread-designation-wrap';

    const select = document.createElement('select');
    select.id = id;
    select.className = 'select';
    select.dataset.role = 'thread-designation';
    wrap.appendChild(select);

    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.className = 'input';
    customInput.dataset.role = 'thread-designation-custom';
    customInput.placeholder = def?.hint || 'Enter thread designation';
    customInput.style.display = 'none';
    customInput.style.marginTop = '6px';
    wrap.appendChild(customInput);

    const standardKey = def?.standardField || 'threadStandard';
    const getStandard = () => normalizeThreadStandard(ui?.params?.[standardKey] || 'NONE');
    let lastStandard = getStandard();
    let lastValue = ui.params[key] ?? ui._pickInitialValue(key, def);

    const setValue = (value, emit = true) => {
        const next = value == null ? '' : String(value);
        ui.params[key] = next;
        if (emit && next !== lastValue) {
            lastValue = next;
            ui._emitParamsChange(key, next);
        } else {
            lastValue = next;
        }
    };

    const toggleCustom = (show) => {
        customInput.style.display = show ? 'block' : 'none';
    };

    const buildOptions = (std) => {
        const options = getThreadDesignationOptions(std);
        select.textContent = '';
        if (options.length) {
            for (const opt of options) {
                const el = document.createElement('option');
                el.value = opt.value;
                el.textContent = opt.label || opt.value;
                select.appendChild(el);
            }
            const customOpt = document.createElement('option');
            customOpt.value = CUSTOM_VALUE;
            customOpt.textContent = 'Custom...';
            select.appendChild(customOpt);
        } else {
            const customOpt = document.createElement('option');
            customOpt.value = CUSTOM_VALUE;
            customOpt.textContent = std === 'NONE'
                ? 'Select a thread standard or type custom'
                : 'Custom designation';
            select.appendChild(customOpt);
        }
        return options;
    };

    const syncSelection = (emit = false, preferPreset = false) => {
        const std = getStandard();
        lastStandard = std;
        const options = buildOptions(std);
        const current = ui.params[key] ?? ui._pickInitialValue(key, def);
        const match = options.find((o) => o.value === current);
        if (match) {
            select.value = match.value;
            toggleCustom(false);
            setValue(match.value, emit);
            return;
        }
        if ((preferPreset || !current) && options.length) {
            const fallback = options[0];
            select.value = fallback.value;
            toggleCustom(false);
            setValue(fallback.value, emit);
            return;
        }
        select.value = CUSTOM_VALUE;
        toggleCustom(true);
        customInput.value = current || customInput.value || '';
        setValue(customInput.value, emit);
    };

    const handleSelectChange = () => {
        if (select.value === CUSTOM_VALUE) {
            toggleCustom(true);
            setValue(customInput.value || '', true);
            customInput.focus();
        } else {
            toggleCustom(false);
            setValue(select.value, true);
        }
    };

    const handleCustomInput = () => {
        setValue(customInput.value, false);
    };

    const handleCustomCommit = () => {
        setValue(customInput.value, true);
    };

    select.addEventListener('change', handleSelectChange);
    customInput.addEventListener('input', handleCustomInput);
    customInput.addEventListener('change', handleCustomCommit);
    customInput.addEventListener('blur', handleCustomCommit);

    let cleanupStandardListener = null;
    const standardInput = ui?._inputs?.get?.(standardKey);
    if (standardInput && typeof standardInput.addEventListener === 'function') {
        const onStandardChange = () => {
            const nextStd = getStandard();
            const shouldEmit = nextStd !== lastStandard;
            syncSelection(shouldEmit, true);
        };
        standardInput.addEventListener('change', onStandardChange);
        cleanupStandardListener = () => standardInput.removeEventListener('change', onStandardChange);
    }

    syncSelection(false);

    return {
        inputEl: wrap,
        inputRegistered: true,
        skipDefaultRefresh: true,
        activate() {
            if (select.value === CUSTOM_VALUE) {
                customInput.focus();
            } else {
                select.focus();
            }
        },
        readValue() {
            return ui.params[key];
        },
        refreshFromParams(value) {
            if (value !== undefined) ui.params[key] = value;
            const stdChanged = getStandard() !== lastStandard;
            syncSelection(false, stdChanged);
        },
        destroy() {
            if (cleanupStandardListener) cleanupStandardListener();
            select.removeEventListener('change', handleSelectChange);
            customInput.removeEventListener('input', handleCustomInput);
            customInput.removeEventListener('change', handleCustomCommit);
            customInput.removeEventListener('blur', handleCustomCommit);
        },
    };
}
