export function renderButtonField({ ui, key, def, id }) {
    const inputEl = document.createElement('button');
    inputEl.type = 'button';
    inputEl.id = id;
    inputEl.className = 'btn';
    inputEl.textContent = String(def.label || ui._prettyLabel(key));

    inputEl.addEventListener('click', (ev) => {
        ev.preventDefault();
        ui._stopActiveReferenceSelection();
        const fid = (ui.params && Object.prototype.hasOwnProperty.call(ui.params, 'featureID'))
            ? ui.params.featureID
            : null;
        let handled = false;
        try {
            if (def && typeof def.actionFunction === 'function') {
                const ctx = {
                    featureID: fid,
                    key,
                    viewer: ui.options?.viewer || null,
                    partHistory: ui.options?.partHistory || null,
                    feature: ui.options?.featureRef || null,
                    params: ui.params,
                    schemaDef: def,
                };
                const r = def.actionFunction(ctx);
                handled = true;
                void r;
            }
        } catch (_) { }
        if (!handled) {
            try { if (typeof ui.options.onAction === 'function') ui.options.onAction(fid, key); } catch (_) { }
        }
    });

    return {
        inputEl,
        activate() {
            inputEl.focus();
        },
        readValue() {
            return null;
        },
    };
}
