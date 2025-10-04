export function renderBooleanOperationField({ ui, key, def, controlWrap }) {
    if (!ui.params[key] || typeof ui.params[key] !== 'object') {
        ui.params[key] = { targets: [], operation: 'NONE', operation: 'NONE' };
    } else {
        if (!Array.isArray(ui.params[key].targets)) ui.params[key].targets = [];
        if (!ui.params[key].operation && !ui.params[key].operation) ui.params[key].operation = 'NONE';
    }

    const wrap = document.createElement('div');
    wrap.className = 'bool-op-wrap';

    const sel = document.createElement('select');
    sel.className = 'select';
    sel.dataset.role = 'bool-op';
    const ops = Array.isArray(def.options) && def.options.length ? def.options : ['NONE', 'UNION', 'SUBTRACT', 'INTERSECT'];
    for (const op of ops) {
        const opt = document.createElement('option');
        opt.value = String(op);
        opt.textContent = String(op);
        sel.appendChild(opt);
    }
    sel.value = String((ui.params[key].operation ?? ui.params[key].operation) || 'NONE');
    sel.addEventListener('change', () => {
        if (!ui.params[key] || typeof ui.params[key] !== 'object') ui.params[key] = { targets: [], operation: 'NONE' };
        ui.params[key].operation = sel.value;
        ui.params[key].operation = sel.value;
        ui._emitParamsChange(key, ui.params[key]);
    });
    wrap.appendChild(sel);

    const refWrap = document.createElement('div');
    refWrap.className = 'ref-multi-wrap';
    const chipsWrap = document.createElement('div');
    chipsWrap.className = 'ref-chips';
    refWrap.appendChild(chipsWrap);

    const inputElTargets = document.createElement('input');
    inputElTargets.type = 'text';
    inputElTargets.className = 'input';
    inputElTargets.dataset.multiple = 'true';
    inputElTargets.placeholder = 'Click then select solids…';
    ui._renderChips(chipsWrap, key, Array.isArray(ui.params[key].targets) ? ui.params[key].targets : []);

    const activate = () => {
        ui._activateReferenceSelection(inputElTargets, { selectionFilter: ['SOLID'] });
    };
    chipsWrap.addEventListener('click', activate);
    inputElTargets.addEventListener('click', activate);

    inputElTargets.addEventListener('change', () => {
        if (inputElTargets.dataset && inputElTargets.dataset.forceClear === 'true') {
            if (!ui.params[key] || typeof ui.params[key] !== 'object') ui.params[key] = { targets: [], operation: 'NONE' };
            ui.params[key].targets = [];
            ui._renderChips(chipsWrap, key, ui.params[key].targets);
            inputElTargets.value = '';
            delete inputElTargets.dataset.forceClear;
            ui._emitParamsChange(key, ui.params[key]);
            return;
        }
        if (!ui.params[key] || typeof ui.params[key] !== 'object') ui.params[key] = { targets: [], operation: 'NONE' };
        let incoming = [];
        try {
            const parsed = JSON.parse(inputElTargets.value);
            if (Array.isArray(parsed)) incoming = parsed;
        } catch (_) {
            if (inputElTargets.value && String(inputElTargets.value).trim() !== '') incoming = [String(inputElTargets.value).trim()];
        }
        const cur = Array.isArray(ui.params[key].targets) ? ui.params[key].targets : [];
        for (const name of incoming) {
            if (!cur.includes(name)) cur.push(name);
        }
        ui.params[key].targets = cur;
        ui._renderChips(chipsWrap, key, cur);
        inputElTargets.value = '';
        ui._emitParamsChange(key, ui.params[key]);
    });

    refWrap.appendChild(inputElTargets);
    wrap.appendChild(refWrap);

    controlWrap.appendChild(wrap);

    return {
        inputEl: inputElTargets,
        activate,
        readValue() {
            const current = ui.params[key];
            if (!current || typeof current !== 'object') {
                return { targets: [], operation: 'NONE' };
            }
            return {
                targets: Array.isArray(current.targets) ? current.targets.slice() : [],
                operation: current.operation || 'NONE',
            };
        },
    };
}
