import { SelectionFilter } from './SelectionFilter.js';
const DEBUG = false;


export class SelectionFilterWidget {
    constructor(viewer) {
        this.uiElement = document.createElement("div");
        this.selectedEntities = new Set();
        this.viewer = viewer;
        this.initUI();
    }

    initUI() {

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
                }

            }
        });
        // create style
        const style = document.createElement("style");


        style.textContent = `
            .selection-filter-widget {
                position: absolute;
                bottom: 0px;
                right: 10px;
                width: 350px;
                height: 18px;
                border-radius: 4px;
                padding: 10px;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                /* horizontal row */
                display: flex;
                align-items: center;
                justify-content: space-between;

            }
            .selection-filter-widget > * {
                display: block;
                margin-bottom: 5px;
                /* vertically center elements */
                display: flex;
                align-items: center;
            }
        `;
        document.head.appendChild(style);

        // Create the main UI container
        this.uiElement.classList.add("selection-filter-widget");
        document.body.appendChild(this.uiElement);

        // Set the callback to update the UI when selection filter changes
        SelectionFilter.uiCallback = () => this.updateUI();
        this.updateUI();


        // refresh the list of selected entites in the scene every 100ms
        setInterval(() => {
            this.selectedEntitiesBefore = [...this.selectedEntities];
            this.selectedEntities = this.getSelectedEntities();
            // check if selection has changed
            if (this.selectedEntities.length !== this.selectedEntitiesBefore.length ||
                this.selectedEntities.some(id => !this.selectedEntitiesBefore.includes(id)) ||
                this.selectedEntitiesBefore.some(id => !this.selectedEntities.includes(id))) {
                if (DEBUG) console.log("Selection changed:", this.selectedEntities);



                const activeRefSelect = findActiveReferenceSelection();
                if (DEBUG) console.log(activeRefSelect);
                if (activeRefSelect) {
                    const isMulti = String(activeRefSelect.dataset?.multiple || '') === 'true';
                    if (isMulti) {
                        // Only push when non-empty to avoid wiping chips on reruns
                        if ((this.selectedEntities || []).length > 0) {
                            try {
                                activeRefSelect.value = JSON.stringify(this.selectedEntities || []);
                            } catch (_) {
                                activeRefSelect.value = '[]';
                            }
                            activeRefSelect.dispatchEvent(new Event("change"));
                        }
                    } else {
                        activeRefSelect.value = this.selectedEntities[0] || "";
                        // remove active-reference-selection
                        activeRefSelect.removeAttribute("active-reference-selection");
                        activeRefSelect.style.filter = "none";
                        activeRefSelect.dispatchEvent(new Event("change"));
                    }
                }

            }
        }, 100);


    }


    updateUI() { // Update the UI based on the current selection
        this.uiElement.innerHTML = "<b>Selection Filter:</b>"; // Clear existing UI

        // Build a single-select dropdown with only available types
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.gap = '8px';
        wrap.style.alignItems = 'center';

        const select = document.createElement('select');
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
