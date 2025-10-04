export function renderFileField({ ui, key, def, id, controlWrap }) {
    const inputEl = document.createElement('button');
    inputEl.type = 'button';
    inputEl.id = id;
    inputEl.className = 'btn';
    inputEl.textContent = String(def.label || 'Choose File…');

    const info = document.createElement('div');
    info.className = 'file-info';
    const initial = ui._pickInitialValue(key, def);
    if (typeof initial === 'string' && initial.startsWith('data:') && initial.includes(';base64,')) {
        const b64 = initial.split(',')[1] || '';
        const size = Math.floor((b64.length * 3) / 4);
        info.textContent = `Loaded (${size} bytes)`;
    } else if (initial && String(initial).length) {
        info.textContent = `Loaded (${String(initial).length} chars)`;
    } else {
        info.textContent = 'No file selected';
    }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    if (def && def.accept) fileInput.setAttribute('accept', String(def.accept));

    inputEl.addEventListener('click', (ev) => {
        ev.preventDefault();
        fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        try {
            const ab = await f.arrayBuffer();
            const bytes = new Uint8Array(ab);
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
                const sub = bytes.subarray(i, i + chunk);
                binary += String.fromCharCode.apply(null, sub);
            }
            const b64 = (typeof btoa === 'function') ? btoa(binary) : (typeof Buffer !== 'undefined' ? Buffer.from(bytes).toString('base64') : '');
            const mime = (f.type && f.type.length) ? f.type : 'application/octet-stream';
            const dataUrl = `data:${mime};base64,${b64}`;
            ui.params[key] = dataUrl;
            info.textContent = `${f.name} (${bytes.length} bytes)`;
            ui._emitParamsChange(key, dataUrl);
        } catch (e) {
            info.textContent = `Failed to read file: ${e?.message || e}`;
        }
    });

    controlWrap.appendChild(info);
    controlWrap.appendChild(fileInput);

    return {
        inputEl,
        activate() {
            fileInput.click();
        },
        readValue() {
            return ui.params[key] ?? null;
        },
    };
}
