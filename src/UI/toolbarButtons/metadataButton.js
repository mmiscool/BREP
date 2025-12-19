import { FloatingWindow } from '../FloatingWindow.js';

const PANEL_CONTROLLER = Symbol('MetadataPanelController');

class MetadataPanelController {
    constructor(viewer) {
        this.viewer = viewer;
        this.open = false;
        this.window = null;
        this.root = null;
        this.content = null;
        this.sortColumn = 'key';
        this.sortDir = 'asc';
        this.filterText = '';
        this.selectedKeys = new Set();
        this.measureCtx = null;
        this.currentTarget = null;
        this._cachedInputHeightPx = null;
        if (viewer) {
            viewer.__metadataPanelController = this;
        }
    }

    toggle() {
        if (this.open) this.close();
        else this.openPanel();
    }

    openPanel() {
        this._ensurePanel();
        if (this.open) {
            this.root.style.display = 'flex';
            if (this.currentTarget) this._render();
            else this._setPlaceholder('Click an object in the scene to view or edit its metadata.');
            return;
        }
        this.open = true;
        this.sortColumn = 'key';
        this.sortDir = 'asc';
        this.filterText = '';
        this.selectedKeys.clear();
        this.root.style.display = 'flex';
        if (this.currentTarget) this._render();
        else this._setPlaceholder('Click an object in the scene to view or edit its metadata.');
    }

    close() {
        if (!this.open) return;
        this.open = false;
        if (this.root) {
            try { this.root.style.display = 'none'; } catch {}
        }
    }

    handleSelection(target) {
        this.currentTarget = target || null;
        if (this.currentTarget) {
            try {
                const solid = this._findParentSolid(this.currentTarget);
                const name = this.currentTarget.name || this.currentTarget.userData?.faceName || null;
                const meta = (solid && name && typeof solid.getFaceMetadata === 'function')
                    ? solid.getFaceMetadata(name)
                    : null;
                console.log('[MetadataPanel] Selected object', {
                    name,
                    type: this.currentTarget.type,
                    faceName: this.currentTarget.userData?.faceName || null,
                    sheetMetalFaceType: this.currentTarget.userData?.sheetMetalFaceType || null,
                    sheetMetalEdgeType: this.currentTarget.userData?.sheetMetalEdgeType || null,
                    parentSolid: solid?.name || null,
                    metadata: meta || null,
                });
                console.log("Actual object:", this.currentTarget);
            } catch (e) {
                try { console.warn('[MetadataPanel] Selection log failed:', e); } catch { }
            }
        }
        if (!this.open) return;
        this._render();
    }

    _ensurePanel() {
        if (this.root) return;
        const height = Math.max(240, Math.floor((window?.innerHeight || 800) * 0.45));
        const fw = new FloatingWindow({
            title: 'Metadata',
            width: 500,
            height: 600,
            bottom: 12,
            shaded: false,
            onClose: () => this.close(),
        });

        const btnClear = document.createElement('button');
        btnClear.className = 'fw-btn';
        btnClear.textContent = 'Clear';
        btnClear.addEventListener('click', () => this._clearMetadataForCurrentTarget());

        fw.addHeaderAction(btnClear);

        const content = document.createElement('div');
        content.style.display = 'flex';
        content.style.flexDirection = 'column';
        content.style.gap = '8px';
        content.style.padding = '8px';
        content.style.width = '100%';
        content.style.height = '100%';
        content.style.boxSizing = 'border-box';
        content.style.overflowX = 'hidden';
        content.style.overflowY = 'auto';
        fw.content.appendChild(content);

        this.window = fw;
        this.root = fw.root;
        this.content = content;
        try { this.root.style.display = 'none'; } catch {}
    }

    _setPlaceholder(msg) {
        this._ensurePanel();
        if (!this.content) return;
        this.content.innerHTML = '';
        const p = document.createElement('div');
        p.textContent = msg || '';
        p.style.color = '#9aa4b2';
        p.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
        p.style.opacity = '0.9';
        this.content.appendChild(p);
    }

    _clearMetadataForCurrentTarget() {
        const target = this.currentTarget;
        const manager = this._getManager();
        if (!target || !target.name || !manager) return;
        let ok = true;
        try {
            ok = window.confirm ? window.confirm(`Remove all metadata for "${target.name}"?`) : true;
        } catch { ok = true; }
        if (!ok) return;
        try { manager.clearMetadata(target.name); } catch {}
        this.selectedKeys.clear();
        if (this.open) this._render();
    }

    _bulkDeleteSelectedMetadata() {
        const target = this.currentTarget;
        const manager = this._getManager();
        if (!target || !target.name || !manager) return;
        if (this.selectedKeys.size === 0) return;
        const count = this.selectedKeys.size;
        let ok = true;
        try {
            ok = window.confirm ? window.confirm(`Delete ${count} selected metadata entr${count === 1 ? 'y' : 'ies'}?`) : true;
        } catch { ok = true; }
        if (!ok) return;
        for (const key of Array.from(this.selectedKeys)) {
            manager.deleteMetadataKey(target.name, key);
        }
        this.selectedKeys.clear();
        if (this.open) this._render();
    }

    _render() {
        if (!this.open) return;
        this._ensurePanel();
        const manager = this._getManager();
        const target = this.currentTarget;
        if (!target) {
            this.selectedKeys.clear();
            this._setPlaceholder('Nothing selected.');
            return;
        }
        if (!target.name) {
            this.selectedKeys.clear();
            this._setPlaceholder('Selected object has no name. Assign a unique name to edit metadata.');
            return;
        }
        if (!manager) {
            this.selectedKeys.clear();
            this._setPlaceholder('Metadata manager not available.');
            return;
        }

        const name = target.name;
        const own = manager.getOwnMetadata(name);
        const effective = manager.getMetadata(name);
        const faceMetadata = this._getFaceMetadataForTarget(target);
        const edgeMetadata = this._getEdgeMetadataForTarget(target);

        // Merge edge metadata into the displayed entries so edge attributes are visible
        if (edgeMetadata && typeof edgeMetadata.metadata === 'object') {
            for (const [k, v] of Object.entries(edgeMetadata.metadata)) {
                own[k] = v;
                effective[k] = v;
            }
        }

        const entries = Object.entries(own).map(([key, value]) => ({
            key,
            value,
            valueString: this._stringifyMetadataValue(value)
        }));

        const filter = (this.filterText || '').trim().toLowerCase();
        const filtered = filter
            ? entries.filter(({ key, valueString }) => key.toLowerCase().includes(filter) || valueString.toLowerCase().includes(filter))
            : entries.slice();

        const dir = this.sortDir === 'desc' ? -1 : 1;
        const sortColumn = this.sortColumn === 'value' ? 'valueString' : 'key';
        filtered.sort((a, b) => {
            const av = a[sortColumn] || '';
            const bv = b[sortColumn] || '';
            return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * dir;
        });

        const existingKeys = new Set(entries.map(e => e.key));
        for (const key of Array.from(this.selectedKeys)) {
            if (!existingKeys.has(key)) this.selectedKeys.delete(key);
        }

        let keyColumnWidth = 120;
        for (const { key } of entries) {
            keyColumnWidth = Math.max(keyColumnWidth, this._measureKeyWidth(key) + 24);
        }

        const baseInputHeight = this._inputHeightPx();

        this.content.innerHTML = '';

        const header = document.createElement('div');
        header.style.font = '13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
        header.style.fontWeight = '600';
        header.style.whiteSpace = 'nowrap';
        header.style.textOverflow = 'ellipsis';
        header.textContent = `Object: ${name}`;
        this.content.appendChild(header);

        const controls = document.createElement('div');
        controls.style.display = 'flex';
        controls.style.alignItems = 'center';
        controls.style.gap = '8px';
        controls.style.flexWrap = 'wrap';
        controls.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

        const filterLabel = document.createElement('label');
        filterLabel.textContent = 'Filter';
        const filterInput = document.createElement('input');
        filterInput.type = 'search';
        filterInput.value = this.filterText;
        filterInput.placeholder = 'key or value';
        filterInput.style.flex = '1 1 160px';
        filterInput.style.minWidth = '140px';
        filterInput.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
        filterInput.style.padding = '4px 6px';
        filterInput.style.border = '1px solid #1f2937';
        filterInput.style.background = '#0f172a';
        filterInput.style.color = '#e2e8f0';
        filterInput.addEventListener('input', () => {
            this.filterText = filterInput.value;
            this._render();
        });

        const clearFilterBtn = document.createElement('button');
        clearFilterBtn.className = 'fw-btn';
        clearFilterBtn.textContent = 'Clear filter';
        clearFilterBtn.disabled = !(this.filterText || '').length;
        clearFilterBtn.addEventListener('click', () => {
            this.filterText = '';
            this._render();
        });

        controls.appendChild(filterLabel);
        controls.appendChild(filterInput);
        controls.appendChild(clearFilterBtn);
        this.content.appendChild(controls);

        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        table.style.tableLayout = 'auto';
        table.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const headers = [
            { text: 'Select', column: null, widthPx: 10 },
            { text: 'Attribute', column: 'key', widthPx: keyColumnWidth },
            { text: 'Value', column: 'value' },
            { text: 'Actions', column: null }
        ];

        for (const { text, column, widthPx } of headers) {
            const th = document.createElement('th');
            th.textContent = text;
            th.style.textAlign = column === 'value' ? 'left' : 'center';
            if (column === 'key') th.style.textAlign = 'left';
            th.style.padding = '6px';
            th.style.borderBottom = '1px solid #1f2937';
            th.style.fontWeight = '600';
            th.style.position = 'relative';
            th.style.whiteSpace = 'nowrap';
            if (widthPx) {
                th.style.width = `${widthPx}px`;
                th.style.minWidth = `${widthPx}px`;
                th.style.maxWidth = `${widthPx}px`;
            }

            if (column === 'key' || column === 'value') {
                th.style.cursor = 'pointer';
                const sortCol = column === 'value' ? 'value' : 'key';
                const arrow = document.createElement('span');
                arrow.style.marginLeft = '6px';
                arrow.style.opacity = this.sortColumn === sortCol ? '1' : '0.3';
                arrow.textContent = this.sortColumn === sortCol
                    ? (this.sortDir === 'asc' ? '▲' : '▼')
                    : '▲';
                th.appendChild(arrow);
                th.addEventListener('click', () => {
                    if (this.sortColumn === sortCol) {
                        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
                    } else {
                        this.sortColumn = sortCol;
                        this.sortDir = 'asc';
                    }
                    this._render();
                });
            }

            if (column === null && text === 'Select') {
                const master = document.createElement('input');
                master.type = 'checkbox';
                master.style.margin = '0 auto';
                master.checked = filtered.length > 0 && filtered.every(e => this.selectedKeys.has(e.key));
                master.indeterminate = filtered.some(e => this.selectedKeys.has(e.key)) && !master.checked;
                master.addEventListener('change', () => {
                    if (master.checked) {
                        for (const { key } of filtered) this.selectedKeys.add(key);
                    } else {
                        for (const { key } of filtered) this.selectedKeys.delete(key);
                    }
                    this._render();
                });
                th.textContent = '';
                th.appendChild(master);
            }

            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        const addRow = document.createElement('tr');
        addRow.style.borderBottom = '1px solid #1f2937';

        const addKeyCell = document.createElement('td');
        addKeyCell.style.padding = '4px';
        addKeyCell.style.verticalAlign = 'top';
        addKeyCell.style.width = `${keyColumnWidth}px`;
        addKeyCell.style.minWidth = `${keyColumnWidth}px`;
        const newKeyInput = document.createElement('input');
        newKeyInput.type = 'text';
        newKeyInput.placeholder = 'New attribute name';
        newKeyInput.style.width = '100%';
        newKeyInput.style.boxSizing = 'border-box';
        newKeyInput.style.font = '12px monospace';
        newKeyInput.style.padding = '4px 6px';
        newKeyInput.style.border = '1px solid #1f2937';
        newKeyInput.style.background = '#0f172a';
        newKeyInput.style.color = '#e2e8f0';
        addKeyCell.appendChild(newKeyInput);

        const addValueCell = document.createElement('td');
        addValueCell.style.padding = '4px';
        addValueCell.style.verticalAlign = 'top';
        const newValueTextarea = document.createElement('textarea');
        newValueTextarea.placeholder = 'Value (JSON or plain text)';
        newValueTextarea.style.width = '100%';
        newValueTextarea.style.font = '12px monospace';
        newValueTextarea.style.padding = '6px';
        newValueTextarea.style.border = '1px solid #1f2937';
        newValueTextarea.style.background = '#0f172a';
        newValueTextarea.style.color = '#e2e8f0';
        newValueTextarea.style.resize = 'vertical';
        newValueTextarea.style.boxSizing = 'border-box';
        newValueTextarea.setAttribute('wrap', 'soft');
        addValueCell.appendChild(newValueTextarea);
        autoResizeTextarea(newValueTextarea, baseInputHeight);

        const addSelectCell = document.createElement('td');
        addSelectCell.style.padding = '4px';
        addSelectCell.style.textAlign = 'center';
        addSelectCell.style.verticalAlign = 'middle';
        addSelectCell.textContent = '-';
        addSelectCell.style.color = '#475569';

        const addActionCell = document.createElement('td');
        addActionCell.style.padding = '4px';
        addActionCell.style.textAlign = 'center';
        const addBtn = document.createElement('button');
        addBtn.className = 'fw-btn';
        addBtn.textContent = 'Add attribute';
        addBtn.addEventListener('click', () => {
            const key = newKeyInput.value.trim();
            if (!key) {
                newKeyInput.focus();
                return;
            }
            const data = manager.getOwnMetadata(name);
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                try { alert('Metadata key already exists. Use a unique key.'); } catch {}
                return;
            }
            data[key] = this._parseMetadataValue(newValueTextarea.value);
            manager.setMetadataObject(name, data);
            newKeyInput.value = '';
            newValueTextarea.value = '';
            this.selectedKeys.add(key);
            this._render();
        });
        addActionCell.appendChild(addBtn);

        addRow.appendChild(addSelectCell);
        addRow.appendChild(addKeyCell);
        addRow.appendChild(addValueCell);
        addRow.appendChild(addActionCell);
        tbody.appendChild(addRow);

        if (filtered.length === 0) {
            const emptyRow = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 4;
            td.textContent = entries.length === 0 ? 'No metadata yet.' : 'No entries match the current filter.';
            td.style.padding = '12px';
            td.style.textAlign = 'center';
            td.style.color = '#94a3b8';
            emptyRow.appendChild(td);
            tbody.appendChild(emptyRow);
        }

        for (const { key, valueString } of filtered) {
            const row = document.createElement('tr');
            row.style.borderBottom = '1px solid #1f2937';

            const keyCell = document.createElement('td');
            keyCell.style.padding = '4px';
            keyCell.style.verticalAlign = 'top';
            keyCell.style.width = `${keyColumnWidth}px`;
            keyCell.style.minWidth = `${keyColumnWidth}px`;
            const keyInput = document.createElement('input');
            keyInput.type = 'text';
            keyInput.value = key;
            keyInput.title = 'Attribute name';
            keyInput.style.width = '100%';
            keyInput.style.boxSizing = 'border-box';
            keyInput.style.font = '12px monospace';
            keyInput.style.padding = '4px 6px';
            keyInput.style.border = '1px solid #1f2937';
            keyInput.style.background = '#0f172a';
            keyInput.style.color = '#e2e8f0';

            keyInput.addEventListener('blur', () => {
                const newKey = keyInput.value.trim();
                if (!newKey) {
                    keyInput.value = key;
                    return;
                }
                if (newKey === key) return;
                const data = manager.getOwnMetadata(name);
                if (Object.prototype.hasOwnProperty.call(data, newKey)) {
                    try { alert('Metadata key already exists. Use a unique key.'); } catch {}
                    keyInput.value = key;
                    return;
                }
                const currentValue = data[key];
                delete data[key];
                data[newKey] = currentValue;
                manager.setMetadataObject(name, data);
                if (this.selectedKeys.has(key)) {
                    this.selectedKeys.delete(key);
                    this.selectedKeys.add(newKey);
                }
                this._render();
            });

            keyCell.appendChild(keyInput);

            const valueCell = document.createElement('td');
            valueCell.style.padding = '4px';
            valueCell.style.verticalAlign = 'top';
            valueCell.style.width = 'auto';
            const valueTextarea = document.createElement('textarea');
            valueTextarea.value = valueString;
            valueTextarea.title = 'Value (JSON accepted)';
            valueTextarea.style.width = '100%';
            valueTextarea.style.font = '12px monospace';
            valueTextarea.style.padding = '6px';
            valueTextarea.style.border = '1px solid #1f2937';
            valueTextarea.style.background = '#0f172a';
            valueTextarea.style.color = '#e2e8f0';
            valueTextarea.style.resize = 'vertical';
            valueTextarea.style.boxSizing = 'border-box';
            valueTextarea.style.lineHeight = '1.4';
            valueTextarea.setAttribute('wrap', 'soft');

            valueTextarea.addEventListener('blur', () => {
                const data = manager.getOwnMetadata(name);
                data[key] = this._parseMetadataValue(valueTextarea.value);
                manager.setMetadataObject(name, data);
                this._render();
            });

            valueCell.appendChild(valueTextarea);
            autoResizeTextarea(valueTextarea, baseInputHeight);

            const selectCell = document.createElement('td');
            selectCell.style.padding = '4px';
            selectCell.style.verticalAlign = 'middle';
            selectCell.style.textAlign = 'center';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.selectedKeys.has(key);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) this.selectedKeys.add(key);
                else this.selectedKeys.delete(key);
                this._render();
            });
            selectCell.appendChild(checkbox);

            const actionCell = document.createElement('td');
            actionCell.style.padding = '4px';
            actionCell.style.textAlign = 'center';
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'fw-btn';
            deleteBtn.textContent = '✕';
            deleteBtn.title = 'Delete attribute';
            deleteBtn.addEventListener('click', () => {
                manager.deleteMetadataKey(name, key);
                this.selectedKeys.delete(key);
                this._render();
            });
            actionCell.appendChild(deleteBtn);

            row.appendChild(selectCell);
            row.appendChild(keyCell);
            row.appendChild(valueCell);
            row.appendChild(actionCell);
            tbody.appendChild(row);
        }

        table.appendChild(tbody);
        this.content.appendChild(table);

        const actionRow = document.createElement('div');
        actionRow.style.display = 'flex';
        actionRow.style.alignItems = 'center';
        actionRow.style.gap = '8px';
        actionRow.style.flexWrap = 'wrap';
        actionRow.style.marginTop = '4px';

        const bulkDeleteBtn = document.createElement('button');
        bulkDeleteBtn.className = 'fw-btn danger';
        bulkDeleteBtn.textContent = 'Delete selected';
        bulkDeleteBtn.disabled = this.selectedKeys.size === 0;
        bulkDeleteBtn.addEventListener('click', () => this._bulkDeleteSelectedMetadata());

        actionRow.appendChild(bulkDeleteBtn);
        this.content.appendChild(actionRow);

        if (faceMetadata) {
            const faceLabel = document.createElement('div');
            faceLabel.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
            faceLabel.style.color = '#cbd5e1';
            faceLabel.style.marginTop = '10px';
            faceLabel.textContent = `Face metadata (${faceMetadata.faceName})`;
            this.content.appendChild(faceLabel);

            const facePre = document.createElement('pre');
            facePre.textContent = JSON.stringify(faceMetadata.metadata, null, 2);
            facePre.style.margin = '0';
            facePre.style.padding = '8px';
            facePre.style.background = '#0f172a';
            facePre.style.color = '#e2e8f0';
            facePre.style.font = '12px monospace';
            facePre.style.border = '1px solid #1f2937';
            facePre.style.borderRadius = '4px';
            facePre.style.maxHeight = '160px';
            facePre.style.overflow = 'auto';
            facePre.style.whiteSpace = 'pre-wrap';
            facePre.style.wordBreak = 'break-word';
            this.content.appendChild(facePre);
        }

        const effectiveLabel = document.createElement('div');
        effectiveLabel.style.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
        effectiveLabel.style.color = '#cbd5e1';
        effectiveLabel.style.marginTop = '6px';
        effectiveLabel.textContent = 'Effective metadata (after inheritance)';
        this.content.appendChild(effectiveLabel);

        const effectivePre = document.createElement('pre');
        effectivePre.textContent = JSON.stringify(effective, null, 2);
        effectivePre.style.margin = '0';
        effectivePre.style.padding = '8px';
        effectivePre.style.background = '#0f172a';
        effectivePre.style.color = '#e2e8f0';
        effectivePre.style.font = '12px monospace';
        effectivePre.style.border = '1px solid #1f2937';
        effectivePre.style.borderRadius = '4px';
        effectivePre.style.maxHeight = '160px';
        effectivePre.style.overflow = 'auto';
        effectivePre.style.whiteSpace = 'pre-wrap';
        effectivePre.style.wordBreak = 'break-word';
        this.content.appendChild(effectivePre);
    }

    _stringifyMetadataValue(value) {
        if (typeof value === 'string') return value;
        if (value === undefined) return '';
        try { return JSON.stringify(value); }
        catch { return String(value); }
    }

    _parseMetadataValue(text) {
        const raw = String(text ?? '').trim();
        if (!raw) return '';
        try { return JSON.parse(raw); }
        catch { return raw; }
    }

    _measureKeyWidth(text) {
        if (!this.measureCtx) {
            const canvas = document.createElement('canvas');
            this.measureCtx = canvas.getContext('2d');
        }
        const ctx = this.measureCtx;
        try { ctx.font = '12px monospace'; } catch {}
        const metrics = ctx?.measureText ? ctx.measureText(String(text ?? '')) : { width: 0 };
        return Math.ceil((metrics?.width || 0));
    }

    _inputHeightPx() {
        if (this._cachedInputHeightPx) return this._cachedInputHeightPx;
        const probe = document.createElement('input');
        probe.type = 'text';
        probe.style.visibility = 'hidden';
        probe.style.position = 'absolute';
        probe.style.top = '-10000px';
        probe.style.font = '12px monospace';
        probe.style.padding = '4px 6px';
        probe.style.border = '1px solid #1f2937';
        probe.style.background = '#0f172a';
        probe.style.color = '#e2e8f0';
        probe.style.boxSizing = 'border-box';
        document.body.appendChild(probe);
        const h = probe.offsetHeight || 32;
        document.body.removeChild(probe);
        this._cachedInputHeightPx = h;
        return h;
    }

    _getManager() {
        return this.viewer?.partHistory?.metadataManager || null;
    }

    _getFaceMetadataForTarget(target) {
        if (!target) return null;
        const faceName = target.userData?.faceName || target.name;
        if (!faceName) return null;
        const solid = this._findParentSolid(target);
        if (!solid || typeof solid.getFaceMetadata !== "function") return null;
        const metadata = solid.getFaceMetadata(faceName);
        if (!metadata || typeof metadata !== "object" || Object.keys(metadata).length === 0) return null;
        return { faceName, metadata };
    }

    _getEdgeMetadataForTarget(target) {
        if (!target || target.type !== "EDGE") return null;
        const edgeName = target.name;
        if (!edgeName) return null;
        const solid = this._findParentSolid(target);
        if (!solid || typeof solid.getEdgeMetadata !== "function") return null;
        const metadata = solid.getEdgeMetadata(edgeName);
        if (!metadata || typeof metadata !== "object" || Object.keys(metadata).length === 0) return null;
        return { edgeName, metadata };
    }

    _findParentSolid(target) {
        if (!target) return null;
        if (target.parentSolid) return target.parentSolid;
        let current = target.parent;
        while (current) {
            if (current.parentSolid) return current.parentSolid;
            if (current.type === "SOLID") return current;
            current = current.parent;
        }
        return null;
    }
}

export function createMetadataButton(viewer) {
    if (!viewer) return null;
    if (!viewer[PANEL_CONTROLLER]) {
        viewer[PANEL_CONTROLLER] = new MetadataPanelController(viewer);
    }
    const controller = viewer[PANEL_CONTROLLER];
    const onClick = () => {
        controller.toggle();
    };
    return {
        label: '🏷️',
        title: 'Toggle Metadata panel',
        onClick
    };
}


/**
 * Automatically adjusts textarea height as the user types,
 * ensuring no scrollbars appear.
 *
 * @param {HTMLTextAreaElement} textarea - The textarea DOM element.
 * @param {number} [minHeightPx=0] - Minimum height in pixels the textarea should maintain.
*/
function autoResizeTextarea(textarea, minHeightPx = 0) {
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('Argument must be a textarea element');
  }

  const base = Number(minHeightPx) > 0 ? Number(minHeightPx) : 0;
  if (base > 0) {
    textarea.style.minHeight = `${base}px`;
  }
  textarea.style.overflowY = 'hidden';

  // Function that resizes based on scrollHeight
  const resize = () => {
    textarea.style.height = 'auto'; // Reset to compute true scrollHeight
    const target = Math.max(base, textarea.scrollHeight);
    textarea.style.height = `${target}px`;
  };

  const scheduleResize = () => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(resize);
    } else {
      resize();
    }
  };

  // Initial sizing
  scheduleResize();

  // Listen for input events (fires on every character add/remove)
  textarea.addEventListener('input', scheduleResize, false);
  textarea.addEventListener('change', scheduleResize, false);
}
