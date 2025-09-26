import { SelectionFilter } from './SelectionFilter.js';
const DEBUG = false;


export class SelectionFilterWidget {
    // options: { inline?: boolean, mountEl?: HTMLElement }
    constructor(viewer, options = {}) {
        this.options = { inline: false, mountEl: null, ...options };
        this.uiElement = document.createElement("div");
        this.selectedEntities = new Set();
        this.viewer = viewer;
        this.initUI();
    }

    initUI() {
        this.uiElement.innerHTML = ""; // Clear existing UI

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                if (DEBUG) console.log('Escape key pressed!');
                if (DEBUG) console.log(this.viewer.partHistory.scene.children);
                SelectionFilter.unselectAll(this.viewer.partHistory.scene);
                // iterate over all the objects within the scene including their children
                const activeRefSelect = findActiveReferenceSelection();
                if (activeRefSelect) {
                    const isMulti = String(activeRefSelect.dataset?.multiple || '') === 'true';
                    // For multi, ESC clears the list explicitly
                    if (isMulti) {
                        activeRefSelect.dataset.forceClear = 'true';
                        activeRefSelect.value = '[]';
                        activeRefSelect.dispatchEvent(new Event('change'));
                    }
                    activeRefSelect.removeAttribute("active-reference-selection");
                    activeRefSelect.style.filter = "none";
                    try {
                        const wrap = activeRefSelect.closest('.ref-single-wrap, .ref-multi-wrap');
                        if (wrap) wrap.classList.remove('ref-active');
                    } catch (_) { }
                    // Restore the selection types to the previous state
                    try { SelectionFilter.restoreAllowedSelectionTypes(); } catch (_) { }
                }

            }
        });
        // create style
        const style = document.createElement("style");


        style.textContent = `
            :root {
                --sfw-bg: #121519;
                --sfw-border: #1c2128;
                --sfw-shadow: rgba(0,0,0,0.35);
                --sfw-text: #d6dde6;
                --sfw-accent: #7aa2f7;
                --sfw-muted: #8b98a5;
            }

            .selection-filter-widget {
                position: absolute;
                bottom: 10px;
                right: 10px;
                min-width: 280px;
                max-width: 380px;
                border-radius: 8px;
                padding: 8px 10px;
                box-shadow: 0 8px 22px var(--sfw-shadow);
                background: linear-gradient(180deg, rgba(18,21,25,0.96), rgba(18,21,25,0.90));
                border: 1px solid var(--sfw-border);
                color: var(--sfw-text);
                font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica Neue, Arial, "Apple Color Emoji", "Segoe UI Emoji";
                font-size: 12px;
                backdrop-filter: blur(6px);
            }

            /* Inline variant for embedding (e.g., main toolbar) */
            .selection-filter-widget.inline {
                position: static;
                bottom: auto; right: auto;
                min-width: 0; max-width: none;
                padding: 2px 6px;
                border-radius: 8px;
                background: transparent;
                border: none;
                box-shadow: none;
                backdrop-filter: none;
            }

            .sfw-row {
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .sfw-title {
                font-weight: 600;
                color: var(--sfw-muted);
                letter-spacing: .3px;
                margin-right: 8px;
                user-select: none;
            }

            .sfw-select {
                appearance: none;
                -webkit-appearance: none;
                background: #0e1116;
                border: 1px solid var(--sfw-border);
                color: var(--sfw-text);
                border-radius: 6px;
                padding: 6px 26px 6px 8px;
                outline: none;
                font-size: 12px;
                line-height: 1;
                cursor: pointer;
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
            }

            .sfw-select:focus {
                border-color: var(--sfw-accent);
                box-shadow: 0 0 0 2px rgba(122,162,247,0.25);
            }

            .sfw-spacer { flex: 1; }
            .sfw-kbd {
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                background: #0e1116;
                border: 1px solid var(--sfw-border);
                color: var(--sfw-muted);
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 11px;
                user-select: none;
            }
        `;
        document.head.appendChild(style);

        this.uiElement.innerHTML = ""; // Clear existing UI

        // Create the main UI container
        this.uiElement.classList.add("selection-filter-widget");
        if (this.options.inline) this.uiElement.classList.add('inline');
        const mount = this.options.mountEl || (this.options.inline ? null : document.body);
        // If mounting inline, remove any prior instance inside the mount to avoid duplicates
        if (mount) {
            try {
                const prior = mount.querySelector('.selection-filter-widget');
                if (prior && prior !== this.uiElement) prior.remove();
            } catch (_) { /* no-op */ }
            mount.appendChild(this.uiElement);
        }

        // Set the callback to update the UI when selection filter changes
        SelectionFilter.uiCallback = () => this.updateUI();



        // Event-driven selection updates (no polling)
        const onSelectionChanged = () => {
            const before = Array.isArray(this.selectedEntities) ? [...this.selectedEntities] : [];
            const now = this.getSelectedEntities();
            this.selectedEntities = now;
            const changed = (now.length !== before.length) || now.some(id => !before.includes(id)) || before.some(id => !now.includes(id));
            if (!changed) return;
            if (DEBUG) console.log('Selection changed:', now);

            const activeRefSelect = findActiveReferenceSelection();
            if (DEBUG) console.log(activeRefSelect);
            if (!activeRefSelect) return;
            // Only route to widgets within the currently open history section
            if (!isRefInOpenHistoryItem(activeRefSelect)) return;

            const isMulti = String(activeRefSelect.dataset?.multiple || '') === 'true';
            if (isMulti) {
                // Only push when non-empty to avoid wiping chips on reruns
                if ((now || []).length > 0) {
                    try {
                        activeRefSelect.value = JSON.stringify(now || []);
                    } catch (_) {
                        activeRefSelect.value = '[]';
                    }
                    activeRefSelect.dispatchEvent(new Event('change'));
                }
            } else {
                activeRefSelect.value = now[0] || '';
                // remove active-reference-selection
                activeRefSelect.removeAttribute('active-reference-selection');
                activeRefSelect.style.filter = 'none';
                activeRefSelect.dispatchEvent(new Event('change'));
                // Restore selection types to what they were before activation
                try {
                    const wrap = activeRefSelect.closest('.ref-single-wrap, .ref-multi-wrap');
                    if (wrap) wrap.classList.remove('ref-active');
                } catch (_) { }
                try { SelectionFilter.restoreAllowedSelectionTypes(); } catch (_) { }
            }
        };
        window.addEventListener('selection-changed', onSelectionChanged);
        this.updateUI();

    }


    updateUI() { // Update the UI based on the current selection
        this.uiElement.innerHTML = ""; // Clear existing UI
        // Build a single-select dropdown with only available types
        const wrap = document.createElement('div');
        wrap.className = 'sfw-row';

        const title = document.createElement('div');
        title.className = 'sfw-title';
        title.textContent = 'Selection';
        wrap.appendChild(title);

        const select = document.createElement('select');
        select.className = 'sfw-select';
        select.title = 'Selection Type';
        const types = SelectionFilter.getAvailableTypes();

        // Populate options
        select.innerHTML = '';
        for (const t of types) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            select.appendChild(opt);
        }

        // Default current type to first available if not set
        const cur = SelectionFilter.getCurrentType();
        const defaultType = cur && types.includes(cur) ? cur : (types[0] || null);
        if (defaultType && defaultType !== cur) {
            SelectionFilter.setCurrentType(defaultType);
        }
        if (defaultType) select.value = defaultType;

        // Change handler: updates the active single selection type
        select.addEventListener('change', () => {
            const next = select.value;
            SelectionFilter.setCurrentType(next);
            // Do not alter existing selections; only future picks are affected
        });

        wrap.appendChild(select);
        const spacer = document.createElement('div');
        spacer.className = 'sfw-spacer';
        wrap.appendChild(spacer);
        this.uiElement.innerHTML = ""; // Clear existing UI
        this.uiElement.appendChild(wrap);
    }


    getSelectedEntities() {
        let selectedItemsInScene = [];
        this.viewer.partHistory.scene.traverse((object) => {
            if (object.selected === true) {
                selectedItemsInScene.push(object.name);
            }
        });
        return selectedItemsInScene;
    }
}



const findActiveReferenceSelection = (root = document) => {
    // Collect all matches in this root
    const matches = [];
    try {
        const here = root.querySelectorAll('[active-reference-selection="true"],[active-reference-selection=true]');
        here && here.forEach?.(el => matches.push(el));
    } catch (_) { }

    // Recurse into shadow roots and same-origin iframes
    const all = (() => { try { return root.querySelectorAll('*'); } catch (_) { return []; } })();
    for (const el of all) {
        if (el && el.shadowRoot) {
            const hit = findActiveReferenceSelection(el.shadowRoot);
            if (hit) matches.push(hit);
        }
        if (el && el.tagName === 'IFRAME') {
            try {
                const doc = el.contentDocument || el.contentWindow?.document;
                if (doc) {
                    const hit = findActiveReferenceSelection(doc);
                    if (hit) matches.push(hit);
                }
            } catch (_) { /* cross-origin iframe; ignore */ }
        }
    }

    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];

    // Prefer the most recently activated based on dataset.activatedAt
    let best = null;
    let bestTs = -Infinity;
    for (const el of matches) {
        let ts = -Infinity;
        try { ts = Number(el?.dataset?.activatedAt || -Infinity); } catch (_) { ts = -Infinity; }
        if (ts > bestTs) { bestTs = ts; best = el; }
    }
    return best || matches[0];
};

// Returns true only if the element is inside an open HistoryWidget accordion item
const isRefInOpenHistoryItem = (el) => {
    if (!el) return false;
    let n = el;
    const seen = new Set();
    while (n && !seen.has(n)) {
        seen.add(n);
        try {
            if (n.classList && n.classList.contains('acc-item')) {
                return n.classList.contains('open');
            }
        } catch (_) { /* no-op */ }
        if (n.parentElement) { n = n.parentElement; continue; }
        const root = (typeof n.getRootNode === 'function') ? n.getRootNode() : null;
        if (root && root.host) { n = root.host; continue; }
        break;
    }
    return false;
};
