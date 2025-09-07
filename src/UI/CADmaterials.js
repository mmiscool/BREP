import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/Addons.js';
import { SelectionFilter } from './SelectionFilter.js';

// CADmaterials for each entity type


export const CADmaterials = {
    EDGE: {
        BASE: new LineMaterial({
            color: "#ff0000",
            linewidth: 5,
            //linecap: "round",
            linejoin: "round",
            transparent: true,

  

        }),
        SELECTED: new LineMaterial({
            color: "#ff00ff",
            linewidth: 5,
            //linecap: "round",
            linejoin: "round",
            transparent: true,
        }),
    },
    LOOP: {
        BASE: new LineMaterial({
            color: "#ff0000",
            linewidth: 5,
            //linecap: "round",
            linejoin: "round",
            transparent: true,
        }),
        SELECTED: new LineMaterial({
            color: "#ff00ff",
            linewidth: 6,
            //linecap: "round",
            linejoin: "round",
            transparent: true,
        }),
    },
    FACE: {
        BASE: new THREE.MeshStandardMaterial({
            color: "#0000ff",
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.8,
            wireframe: false,
            flatShading: true,
            metalness: 0.5,
            polygonOffset: true,

        }),
        SELECTED: new THREE.MeshStandardMaterial({
            color: "#00ffff",
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.8,
            wireframe: false,
            flatShading: true,
            metalness: 0.5,
            polygonOffset: true,
        })
    },

};


// this will provide a UI widget to control CAD materials and will allow the user to change the following properties.
// - Color (html color picker)
// - Opacity (range slider)
// - Linewidth (range slider) (only shows on LineBasicMaterial)
// - Wireframe (checkbox) (only shows on MeshBasicMaterial) items
//
// We will make the UI controls for each material in the global CADmaterials object
export class CADmaterialWidget {
    constructor() {
        this.uiElement = document.createElement("div");
        this.uiElement.classList.add('cmw');
        this._storageKey = '__CAD_MATERIAL_SETTINGS__';
        this._settings = this._loadAllSettings();
        this._ensureStyles();
        this.createUI();
    }

    createUI() {
        // Hover color control (single global color)
        try {
            const savedHover = this._settings['__HOVER_COLOR__'];
            if (savedHover) SelectionFilter.setHoverColor(savedHover);
        } catch (_) {}

        const hoverRow = makeRightSpan();
        const hoverLabel = document.createElement('label');
        hoverLabel.className = 'cmw-label';
        hoverLabel.textContent = 'Hover Color';
        hoverRow.appendChild(hoverLabel);
        const hoverInput = document.createElement('input');
        hoverInput.type = 'color';
        hoverInput.className = 'cmw-input';
        const currentHover = this._settings['__HOVER_COLOR__'] || SelectionFilter.getHoverColor() || '#ffd54a';
        // Ensure hex format starting with #
        hoverInput.value = typeof currentHover === 'string' && currentHover.startsWith('#') ? currentHover : `#${new THREE.Color(currentHover).getHexString()}`;
        hoverInput.addEventListener('input', (event) => {
            const v = event.target.value;
            SelectionFilter.setHoverColor(v);
            this._settings['__HOVER_COLOR__'] = v;
            this._saveAllSettings();
        });
        hoverRow.appendChild(hoverInput);
        this.uiElement.appendChild(hoverRow);

        // For each top-level group (e.g., EDGE, LOOP, FACE), render variants (e.g., BASE, SELECTED)
        for (const [groupName, groupVal] of Object.entries(CADmaterials)) {
            const groupContainer = document.createElement("div");
            groupContainer.className = 'cmw-group';

            // Group header
            const groupHeader = document.createElement('div');
            groupHeader.className = 'cmw-header';
            groupHeader.textContent = groupName;
            groupContainer.appendChild(groupHeader);

            const isMaterial = (m) => m && (m.isMaterial === true || m instanceof THREE.Material);

            // Back-compat: allow either a direct THREE.Material or an object of variants
            if (isMaterial(groupVal)) {
                const matContainer = document.createElement("div");
                matContainer.className = 'cmw-mat';
                this._buildMaterialControls(matContainer, groupName, groupVal);
                groupContainer.appendChild(matContainer);
            } else if (groupVal && typeof groupVal === 'object') {
                for (const [variantName, mat] of Object.entries(groupVal)) {
                    if (!isMaterial(mat)) continue;
                    const matContainer = document.createElement("div");
                    matContainer.className = 'cmw-mat';
                    this._buildMaterialControls(matContainer, `${groupName} - ${variantName}`, mat);
                    groupContainer.appendChild(matContainer);
                }
            }

            this.uiElement.appendChild(groupContainer);
        }

        // Normalize label widths via CSS classes
    }

    // --- Persistence helpers (browser only) ---
    _loadAllSettings() {
        try {
            if (typeof localStorage === 'undefined') return {};
            const raw = localStorage.getItem(this._storageKey);
            const obj = raw ? JSON.parse(raw) : {};
            return (obj && typeof obj === 'object') ? obj : {};
        } catch { return {}; }
    }
    _saveAllSettings() {
        try {
            if (typeof localStorage === 'undefined') return;
            localStorage.setItem(this._storageKey, JSON.stringify(this._settings));
        } catch {/* ignore */}
    }
    _getMatKey(labelText) {
        return String(labelText);
    }
    _getSettingsFor(labelText) {
        const key = this._getMatKey(labelText);
        return this._settings[key] || {};
    }
    _setSettingsFor(labelText, kv) {
        const key = this._getMatKey(labelText);
        const prev = this._settings[key] || {};
        this._settings[key] = { ...prev, ...kv };
        this._saveAllSettings();
    }

    _sanitizeHexColor(value) {
        if (typeof value !== 'string') return value;
        if (!value.startsWith('#')) return value;
        // If color is in #RRGGBBAA form, drop alpha AA
        if (value.length === 9) return value.slice(0, 7);
        return value;
    }

    _applySavedToMaterial(labelText, material) {
        const s = this._getSettingsFor(labelText);
        if (s.color && material.color && typeof material.color.set === 'function') {
            material.color.set(this._sanitizeHexColor(s.color));
        }
        if (material instanceof THREE.LineBasicMaterial || material instanceof LineMaterial) {
            if (s.linewidth != null) material.linewidth = Number(s.linewidth);
        }
        if (
            material instanceof THREE.MeshBasicMaterial ||
            material instanceof THREE.MeshMatcapMaterial ||
            material instanceof THREE.MeshToonMaterial ||
            material instanceof THREE.MeshStandardMaterial
        ) {
            if (s.opacity != null) {
                material.opacity = Number(s.opacity);
                material.transparent = material.opacity < 1 ? true : material.transparent;
            }
            if (s.wireframe != null) material.wireframe = !!s.wireframe;
            if (s.doubleSided != null) material.side = s.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
        }
    }

    _buildMaterialControls(container, labelText, material) {
        // Apply saved settings first
        this._applySavedToMaterial(labelText, material);

        // Color row
        if (material.color && typeof material.color.getHexString === 'function') {
            const colorRow = makeRightSpan();
            const colorLabel = document.createElement("label");
            colorLabel.className = 'cmw-label';
            colorLabel.textContent = labelText;
            colorRow.appendChild(colorLabel);
            const colorInput = document.createElement("input");
            colorInput.type = "color";
            colorInput.className = 'cmw-input';
            colorInput.value = `#${material.color.getHexString()}`;
            colorInput.addEventListener("input", (event) => {
                const v = this._sanitizeHexColor(event.target.value);
                // Normalize UI value back to sanitized form so user sees what is applied
                if (v !== event.target.value) event.target.value = v;
                material.color.set(v);
                this._setSettingsFor(labelText, { color: v });
            });
            colorRow.appendChild(colorInput);
            container.appendChild(colorRow);
        }

        // Line-specific controls
        if (material instanceof THREE.LineBasicMaterial || material instanceof LineMaterial) {
            const lineWidthRow = makeRightSpan();
            const lwLabel = document.createElement("label");
            lwLabel.className = 'cmw-label';
            lwLabel.textContent = "Linewidth";
            lineWidthRow.appendChild(lwLabel);
            const lwVal = document.createElement("span");
            lwVal.className = 'cmw-val';
            lwVal.textContent = String(material.linewidth ?? '');
            const lwInput = document.createElement("input");
            lwInput.type = "range";
            lwInput.className = 'cmw-range';
            lwInput.min = 1;
            lwInput.max = 10;
            lwInput.step = 0.1;
            lwInput.value = material.linewidth ?? 1;
            lwInput.addEventListener("input", (event) => {
                const v = parseFloat(event.target.value);
                material.linewidth = v;
                lwVal.textContent = String(v);
                this._setSettingsFor(labelText, { linewidth: v });
            });
            lineWidthRow.appendChild(lwInput);
            lineWidthRow.appendChild(lwVal);
            container.appendChild(lineWidthRow);
        }

        // Mesh material common controls
        if (
            material instanceof THREE.MeshBasicMaterial ||
            material instanceof THREE.MeshMatcapMaterial ||
            material instanceof THREE.MeshToonMaterial ||
            material instanceof THREE.MeshStandardMaterial
        ) {
            // Opacity
            const opacityRow = makeRightSpan();
            const opLabel = document.createElement("label");
            opLabel.className = 'cmw-label';
            opLabel.textContent = "Opacity";
            opacityRow.appendChild(opLabel);
            const opInput = document.createElement("input");
            opInput.type = "range";
            opInput.className = 'cmw-range';
            opInput.min = 0;
            opInput.max = 1;
            opInput.step = 0.01;
            opInput.value = material.opacity ?? 1;
            opInput.addEventListener("input", (event) => {
                material.opacity = parseFloat(event.target.value);
                material.transparent = material.opacity < 1 ? true : material.transparent;
                this._setSettingsFor(labelText, { opacity: material.opacity });
            });
            opacityRow.appendChild(opInput);
            container.appendChild(opacityRow);

            // Wireframe
            const wfRow = makeRightSpan();
            const wfLabel = document.createElement("label");
            wfLabel.className = 'cmw-label';
            wfLabel.textContent = "Wireframe";
            wfRow.appendChild(wfLabel);
            const wfInput = document.createElement("input");
            wfInput.type = "checkbox";
            wfInput.className = 'cmw-check';
            wfInput.checked = !!material.wireframe;
            wfInput.addEventListener("change", (event) => {
                material.wireframe = !!event.target.checked;
                this._setSettingsFor(labelText, { wireframe: material.wireframe });
            });
            wfRow.appendChild(wfInput);
            container.appendChild(wfRow);

            // Double sided
            const dsRow = makeRightSpan();
            const dsLabel = document.createElement("label");
            dsLabel.className = 'cmw-label';
            dsLabel.textContent = "Double Sided";
            dsRow.appendChild(dsLabel);
            const dsInput = document.createElement("input");
            dsInput.type = "checkbox";
            dsInput.className = 'cmw-check';
            dsInput.checked = material.side === THREE.DoubleSide;
            dsInput.addEventListener("change", (event) => {
                material.side = event.target.checked ? THREE.DoubleSide : THREE.FrontSide;
                this._setSettingsFor(labelText, { doubleSided: event.target.checked });
            });
            dsRow.appendChild(dsInput);
            container.appendChild(dsRow);
        }
    }

    _ensureStyles() {
        if (document.getElementById('cad-materials-widget-styles')) return;
        const style = document.createElement('style');
        style.id = 'cad-materials-widget-styles';
        style.textContent = `
            /* Use HistoryWidget vars when present; fallback to similar values */
            :root { --cmw-border: var(--border, #262b36); --cmw-text: var(--text, #e6e6e6); --cmw-bg: var(--bg-elev, #12141b); }
            .cmw { display: flex; flex-direction: column; gap: 8px; color: var(--cmw-text); }
            .cmw-group {
                background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
                border: 1px solid var(--cmw-border);
                border-radius: 10px;
                overflow: hidden;
            }
            .cmw-header {
                padding: 10px 12px;
                font-weight: 700;
                color: var(--cmw-text);
                border-bottom: 1px solid var(--cmw-border);
                background: transparent;
            }
            .cmw-mat { display: flex; flex-direction: column; }
            .cmw-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; }
            .cmw-label { width: 160px; color: var(--cmw-text); }
            .cmw-input { background: #0b0e14; color: var(--cmw-text); border: 1px solid #374151; border-radius: 8px; padding: 4px 6px; height: 28px; }
            .cmw-range { width: 200px; accent-color: #60a5fa; }
            .cmw-check { accent-color: #60a5fa; }
            .cmw-val { width: 48px; text-align: right; color: #9aa4b2; }
        `;
        document.head.appendChild(style);
    }
}




function makeRightSpan() {
    const row = document.createElement('div');
    row.className = 'cmw-row';
    return row;
}
