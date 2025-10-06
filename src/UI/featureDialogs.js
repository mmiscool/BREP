"use strict";

import { SelectionFilter } from './SelectionFilter.js';
import * as THREE from 'three';
import { TransformControls as TransformControlsDirect } from 'three/examples/jsm/controls/TransformControls.js';
//import { TransformControls as TransformControlsAddons } from 'three/examples/jsm/Addons.js';
import { getWidgetRenderer } from './featureDialogWidgets/index.js';
import { normalizeReferenceList, normalizeReferenceName } from './featureDialogWidgets/utils.js';







////////////////////////////////////////////////////////////////////////////////////////////////////
// SchemaForm: dark-mode, framework-free, ES module UI generator for schema-driven dialogs.
// - Renders inputs from a schema and keeps a provided `params` object in sync.
// - refreshFromParams() updates inputs when params are changed elsewhere.
// - Supports feature dialogs and annotation dialogs with shared widget implementations.
// - Special: type === "reference_selection" uses a scene-driven picker instead of a text box.
export class SchemaForm {
    // Track a single globally-active reference selection input across all instances
    static __activeRefInput = null;
    static __setGlobalActiveRefInput(el) {
        try {
            // If another input was active, clear its visual + attribute
            const prev = SchemaForm.__activeRefInput;
            if (prev && prev !== el) {
                try { prev.style.filter = 'none'; } catch (_) { }
                try { prev.removeAttribute('active-reference-selection'); } catch (_) { }
            }
        } catch (_) { }
        SchemaForm.__activeRefInput = el || null;
    }

    // Track a single globally-active transform controls session across all instances
    static __activeXform = {
        owner: null,
        key: null,
        inputEl: null,
        wrapEl: null,
        target: null,
        controls: null,
        viewer: null,
        group: null,
        controlsChangeHandler: null,
        captureHandlers: null,
        stepId: null,
        valueAdapter: null,
        baseTransform: null,
    };
    static __stopGlobalActiveXform() {
        const s = SchemaForm.__activeXform;
        if (!s || !s.controls) return;
        try {
            // Detach and dispose controls
            s.controls.detach();
            if (s.viewer && s.viewer.scene) {
                try { if (s.controls && s.controls.isObject3D) s.viewer.scene.remove(s.controls); } catch (_) {}
                try { if (s.controls && s.controls.__helper && s.controls.__helper.isObject3D) s.viewer.scene.remove(s.controls.__helper); } catch (_) {}
                try { if (s.group && s.group.isObject3D) s.viewer.scene.remove(s.group); } catch (_) {}
            }
            try { s.controls.dispose(); } catch (_) {}
        } catch (_) { }
        try {
            // Remove any capture-phase event listeners installed during activation
            const h = s.captureHandlers;
            if (h && h.canvas && h.onDownCapture) {
                h.canvas.removeEventListener('pointerdown', h.onDownCapture, true);
            }
            if (h && h.win && h.onUpCapture) {
                h.win.removeEventListener('pointerup', h.onUpCapture, true);
            }
        } catch (_) { }
        try {
            if (s && s.viewer && s.viewer.controls && s.controlsChangeHandler && typeof s.viewer.controls.removeEventListener === 'function') {
                s.viewer.controls.removeEventListener('change', s.controlsChangeHandler);
            }
        } catch (_) { }
        try {
            // Remove target object
            if (s.viewer && s.viewer.scene && s.target) s.viewer.scene.remove(s.target);
        } catch (_) { }
        try { if (window.__BREP_activeXform) window.__BREP_activeXform = null; } catch (_) { }
        try {
            // Restore camera controls
            if (s.viewer && s.viewer.controls) s.viewer.controls.enabled = true;
        } catch (_) { }
        try {
            // Clear highlight
            if (s.inputEl) s.inputEl.removeAttribute('active-transform');
            const wrap = s.wrapEl;
            if (wrap) wrap.classList.remove('ref-active');
        } catch (_) { }
        SchemaForm.__activeXform = {
            owner: null,
            key: null,
            stepId: null,
            inputEl: null,
            wrapEl: null,
            target: null,
            controls: null,
            viewer: null,
            group: null,
            captureHandlers: null,
            controlsChangeHandler: null,
            valueAdapter: null,
            baseTransform: null,
        };
    }

    static getActiveTransformState() {
        return SchemaForm.__activeXform;
    }

    static getActiveReferenceInput() {
        return SchemaForm.__activeRefInput;
    }

    get activeTransform() {
        return SchemaForm.__activeXform;
    }

    get activeReferenceInput() {
        return SchemaForm.__activeRefInput;
    }

    isTransformSessionActiveFor(inputEl) {
        const active = SchemaForm.__activeXform;
        return Boolean(active && active.inputEl === inputEl);
    }

    setActiveTransformMode(inputEl, mode) {
        const active = SchemaForm.__activeXform;
        if (!active || active.inputEl !== inputEl || !active.controls) return;
        try { active.controls.setMode(mode); } catch (_) { }
    }

    stopTransformSessionIfOwnedByThis() {
        const active = SchemaForm.__activeXform;
        if (active && active.owner === this) {
            SchemaForm.__stopGlobalActiveXform();
        }
    }
    /**
     * @param {Object} schema - e.g. { sizeX: {type:'number', default_value:'2*t', hint:'Width formula' }, ... }
     * @param {Object} params - a live object to keep in sync with user edits
     * @param {Object} [options]
     * @param {(featureID:string|null)=>void} [options.onChange] - Callback fired on any field change
     */
    constructor(schema, params, options = {}) {
        if (!schema || typeof schema !== 'object') throw new Error('schema must be an object');
        if (!params || typeof params !== 'object') throw new Error('params must be an object');

        this.schema = schema;
        this.params = params;
        this.options = options;
        this._useShadowDOM = options && Object.prototype.hasOwnProperty.call(options, 'useShadowDOM')
            ? options.useShadowDOM !== false
            : true;
        this._inputs = new Map();
        this._widgets = new Map();
        this._excludedKeys = new Set(['featureID']); // exclude from defaults & rendering
        if (Array.isArray(options.excludeKeys)) {
            for (const key of options.excludeKeys) {
                if (typeof key === 'string' && key.length) this._excludedKeys.add(key);
            }
        }

        this.uiElement = document.createElement('div');
        if (!this._useShadowDOM) {
            this.uiElement.classList.add('schema-form-host');
        }
        this._shadow = this._useShadowDOM
            ? this.uiElement.attachShadow({ mode: 'open' })
            : this.uiElement;

        this._shadow.appendChild(this._makeStyle());
        this._panel = document.createElement('div');
        this._panel.className = 'panel';
        this._shadow.appendChild(this._panel);

        this._fieldsWrap = document.createElement('div');
        this._fieldsWrap.className = 'fields';
        this._panel.appendChild(this._fieldsWrap);

        this._renderAllFields();

        // Deactivate reference selection when focusing or clicking into any other control
        const stopIfOtherControl = (target) => {
            try {
                // If the active input is not the current focus target, stop selection
                const active = SchemaForm.__activeRefInput || null;
                if (!active) return;
                if (target === active) return;
                // If target is inside the same active element (e.g., clicking within the input), skip
                if (target && typeof target.closest === 'function') {
                    if (target.closest('[active-reference-selection]')) return;
                }
                this._stopActiveReferenceSelection();
            } catch (_) { }
            try {
                // Close active transform session if clicking outside its wrapper; commit changes
                const s = SchemaForm.__activeXform;
                if (s && s.owner === this) {
                    if (!(target && typeof target.closest === 'function' && target.closest('.transform-wrap'))) {
                        const val = this.params[s.key];
                        SchemaForm.__stopGlobalActiveXform();
                        this._emitParamsChange(s.key, val);
                    }
                }
            } catch (_) { }
        };
        // Capture focus changes within this form
        this._shadow.addEventListener('focusin', (ev) => {
            stopIfOtherControl(ev.target);
        }, true);
        // Also capture mouse interactions to be safe
        this._shadow.addEventListener('mousedown', (ev) => {
            stopIfOtherControl(ev.target);
        }, true);
    }

    destroy() {
        // Clean up any active transform session owned by this instance
        try {
            const s = SchemaForm.__activeXform;
            if (s && s.owner === this) SchemaForm.__stopGlobalActiveXform();
        } catch (_) { }
    }

    /** Returns the live params object (already kept in sync). */
    getParams() {
        return this.params;
    }

    /** Programmatically refresh input widgets from the current params object. */
    refreshFromParams() {
        for (const [key, el] of this._inputs.entries()) {
            const def = this.schema[key] || {};
            const v = this._pickInitialValue(key, def);
            // Special composite types handle their own refresh
            if (def && def.type === 'boolean_operation') {
                const row = this._fieldsWrap.querySelector(`[data-key="${key}"]`);
                const select = row ? row.querySelector('select[data-role="bool-op"]') : null;
                if (select) {
                    const opVal = (v && typeof v === 'object') ? (v.operation) : null;
                    select.value = opVal ? String(opVal) : 'NONE';
                }
                const chips = row ? row.querySelector('.ref-chips') : null;
                const targets = (v && typeof v === 'object' && Array.isArray(v.targets)) ? v.targets : [];
                if (chips) this._renderChips(chips, key, targets);
                continue;
            }
            this._setInputValue(el, def.type, v);

            // If this is a reference selection, refresh custom UI
            if (def && def.type === 'reference_selection') {
                const row = this._fieldsWrap.querySelector(`[data-key="${key}"]`);
                if (def.multiple) {
                    const normalized = normalizeReferenceList(Array.isArray(v) ? v : []);
                    this.params[key] = normalized;
                    const chips = row ? row.querySelector('.ref-chips') : null;
                    if (chips) this._renderChips(chips, key, normalized);
                } else {
                    const display = row ? row.querySelector('.ref-single-display') : null;
                    const normalized = normalizeReferenceName(v);
                    this.params[key] = normalized ?? null;
                    if (display) {
                        const label = display.querySelector('.ref-single-label');
                        const placeholder = display.dataset?.placeholder || 'Click then select in scene…';
                        if (label) label.textContent = normalized || placeholder;
                        else display.textContent = normalized || placeholder;
                        const clearBtn = display.querySelector('.ref-chip-remove');
                        if (clearBtn) clearBtn.style.visibility = normalized ? 'visible' : 'hidden';
                    }
                }
                continue;
            }

            // Transform widget: refresh info line
            if (def && def.type === 'transform') {
                const row = this._fieldsWrap.querySelector(`[data-key="${key}"]`);
                const info = row ? row.querySelector('.transform-info') : null;
                if (info) {
                    const fmt = (n) => {
                        const x = Number(n);
                        if (!Number.isFinite(x)) return '0';
                        const a = Math.abs(x);
                        const prec = a >= 100 ? 0 : (a >= 10 ? 1 : 2);
                        return String(x.toFixed(prec));
                    };
                    const p = Array.isArray(v?.position) ? v.position : [0,0,0];
                    const r = Array.isArray(v?.rotationEuler) ? v.rotationEuler : [0,0,0];
                    info.textContent = `pos(${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])})  rot(${fmt(r[0])}, ${fmt(r[1])}, ${fmt(r[2])})`;
                }
                continue;
            }
        }
    }

    // --- Internal: rendering & behavior ---------------------------------------

    _renderAllFields() {
        // Ensure params has defaults for missing keys (without clobbering provided values)
        for (const key in this.schema) {
            if (!Object.prototype.hasOwnProperty.call(this.schema, key)) continue;
            const defRaw = this.schema[key];
            const def = (defRaw && typeof defRaw === 'object') ? defRaw : {};
            if (this._excludedKeys.has(key)) continue;
            if (!(key in this.params)) {
                const raw = ('default_value' in def) ? def.default_value : this._defaultForType(def.type);
                this.params[key] = this._cloneDefault(raw);
            }
        }

        this._widgets.clear();

        // Build field rows
        for (const key in this.schema) {
            if (!Object.prototype.hasOwnProperty.call(this.schema, key)) continue;
            const defRaw = this.schema[key];
            const def = (defRaw && typeof defRaw === 'object') ? defRaw : {};
            if (this._excludedKeys.has(key)) continue;

            const row = document.createElement('div');
            row.className = 'field-row';
            row.dataset.key = key;

            if (def.hint != null && def.hint !== '') {
                row.setAttribute('title', String(def.hint));
            }

            const id = 'gfu_' + key + '_' + Math.random().toString(36).slice(2, 8);

            const label = document.createElement('label');
            label.className = 'label';
            label.setAttribute('for', id);
            // Allow schema to override the row label via `label`
            label.textContent = String((def && def.label) ? def.label : this._prettyLabel(key));
            row.appendChild(label);

            const controlWrap = document.createElement('div');
            controlWrap.className = 'control-wrap';

            let inputEl;
            let inputRegistered = true;

            const renderer = getWidgetRenderer(def.type);
            const widget = renderer({
                ui: this,
                key,
                def,
                id,
                controlWrap,
                row,
            }) || {};

            inputEl = widget.inputEl;
            if (typeof widget.inputRegistered === 'boolean') {
                inputRegistered = widget.inputRegistered;
            }

            if (widget && typeof widget === 'object') {
                this._widgets.set(key, widget);
            }

            if (!inputEl || !(inputEl instanceof HTMLElement)) {
                inputRegistered = false;
                const placeholder = document.createElement('div');
                placeholder.className = 'control-placeholder';
                placeholder.textContent = 'Control unavailable';
                controlWrap.appendChild(placeholder);
            } else if (!inputEl.parentNode) {
                controlWrap.appendChild(inputEl);
            }

            row.appendChild(controlWrap);
            this._fieldsWrap.appendChild(row);
            if (inputRegistered && inputEl instanceof HTMLElement) {
                this._inputs.set(key, inputEl);
            }
        }
    }

    activateField(key) {
        const widget = this._widgets.get(key);
        if (widget && typeof widget.activate === 'function') {
            try { widget.activate(); } catch (_) { }
            return true;
        }
        return false;
    }

    readFieldValue(key) {
        const widget = this._widgets.get(key);
        if (widget && typeof widget.readValue === 'function') {
            try { return widget.readValue(); } catch (_) { }
        }
        return this.params[key];
    }

    _cloneDefault(val) {
        if (val == null) return val;
        if (Array.isArray(val)) return val.map(v => this._cloneDefault(v));
        if (typeof val === 'object') {
            const proto = Object.getPrototypeOf(val);
            if (proto === Object.prototype || proto === null) {
                const out = {};
                for (const k of Object.keys(val)) out[k] = this._cloneDefault(val[k]);
                return out;
            }
        }
        return val;
    }

    // Public: Activate the first reference_selection input in this form (if any)
    activateFirstReferenceSelection() {
        try {
            for (const key in this.schema) {
                if (!Object.prototype.hasOwnProperty.call(this.schema, key)) continue;
                const def = this.schema[key];
                if (def && def.type === 'reference_selection') {
                    const inputEl = this._inputs.get(key);
                    if (inputEl) {
                        this._activateReferenceSelection(inputEl, def);
                        return true;
                    }
                }
            }
        } catch (_) { }
        return false;
    }

    _activateReferenceSelection(inputEl, def) {
        // Clear any lingering scene selection so the new reference starts fresh
        try {
            const scene = this.options?.scene
                || this.options?.viewer?.partHistory?.scene
                || this.options?.viewer?.scene
                || null;
            if (scene) {
                SchemaForm.__setGlobalActiveRefInput(null);
                SelectionFilter.unselectAll(scene);
            }
        } catch (_) { }

        // Ensure only one control is globally marked as active
        SchemaForm.__setGlobalActiveRefInput(inputEl);

        // Also clear any duplicates within this shadow root (defensive)
        const clearLocal = (root) => {
            if (!root || typeof root.querySelectorAll !== 'function') return;
            root.querySelectorAll('[active-reference-selection="true"],[active-reference-selection=true]').forEach(el => {
                if (el !== inputEl) {
                    try { el.style.filter = 'none'; } catch (_) { }
                    try { el.removeAttribute('active-reference-selection'); } catch (_) { }
                    try {
                        const wrap = el.closest('.ref-single-wrap, .ref-multi-wrap');
                        if (wrap) wrap.classList.remove('ref-active');
                    } catch (_) { }
                }
            });
        };
        clearLocal(this._shadow);

        // Mark this control active with a recency timestamp for any external scanners
        try { inputEl.dataset.activatedAt = String(Date.now()); } catch (_) { }
        inputEl.style.filter = 'invert(1)';
        inputEl.setAttribute('active-reference-selection', 'true');
        try {
            const wrap = inputEl.closest('.ref-single-wrap, .ref-multi-wrap');
            if (wrap) wrap.classList.add('ref-active');
        } catch (_) { }

        // Apply selection filter from schema
        SelectionFilter.stashAllowedSelectionTypes();
        SelectionFilter.SetSelectionTypes(def.selectionFilter);
    }

    // Activate a TransformControls session for a transform widget
    _activateTransformWidget({ inputEl, wrapEl, key, def, valueAdapter = null }) {
        try { this._stopActiveReferenceSelection(); } catch (_) {}
        // Toggle logic: if already active for this input, stop and hide
        try {
            const s = SchemaForm.__activeXform;
            if (s && s.inputEl === inputEl) {
                const currentVal = this.params[key];
                SchemaForm.__stopGlobalActiveXform();
                this._emitParamsChange(key, currentVal);
                return;
            }
            // If a different transform is active, stop it before starting this one
            if (s && s.inputEl !== inputEl) {
                SchemaForm.__stopGlobalActiveXform();
            }
        } catch (_) { }

        const viewer = this.options?.viewer || null;
        if (!viewer || !viewer.scene || !viewer.camera || !viewer.renderer) return;

        // (Toggle handled above)

        const adapter = (valueAdapter && typeof valueAdapter === 'object') ? valueAdapter : null;
        const ensureArray3 = (arr, fallback) => {
            const out = Array.isArray(arr) ? arr.slice(0, 3) : [];
            while (out.length < 3) out.push(fallback);
            return out;
        };
        const ensureArray4 = (arr, fallback) => {
            if (Array.isArray(arr) && arr.length >= 4) {
                const vals = [];
                for (let i = 0; i < 4; i++) {
                    const n = Number(arr[i]);
                    vals.push(Number.isFinite(n) ? n : (i === 3 ? 1 : 0));
                }
                return vals;
            }
            return fallback;
        };
        const sanitizeTRS = (value) => {
            const obj = (value && typeof value === 'object') ? value : {};
            return {
                position: ensureArray3(obj.position, 0),
                rotationEuler: ensureArray3(obj.rotationEuler, 0),
                scale: ensureArray3(obj.scale, 1),
            };
        };
        const sanitizeBase = (value) => {
            const obj = (value && typeof value === 'object') ? value : {};
            const base = {
                position: ensureArray3(obj.position, 0),
                rotationEuler: ensureArray3(obj.rotationEuler, 0),
                quaternion: ensureArray4(obj.quaternion, null),
                scale: ensureArray3(obj.scale, 1),
            };
            if (!base.quaternion) {
                try {
                    const e = base.rotationEuler;
                    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2], 'XYZ'));
                    base.quaternion = [q.x, q.y, q.z, q.w];
                } catch (_) {
                    base.quaternion = [0, 0, 0, 1];
                }
            }
            return base;
        };
        const safeNumber = (v, fallback) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : fallback;
        };
        const safeDiv = (num, denom) => {
            const d = safeNumber(denom, 1);
            if (Math.abs(d) < 1e-12) return safeNumber(num, 0);
            return safeNumber(num, 0) / d;
        };
        const readBaseValue = () => {
            if (adapter && typeof adapter.getBase === 'function') {
                try { return sanitizeBase(adapter.getBase()); } catch (_) { return sanitizeBase(null); }
            }
            return sanitizeBase(null);
        };
        const readCurrentValue = () => {
            if (adapter && typeof adapter.get === 'function') {
                try { return sanitizeTRS(adapter.get()); } catch (_) { return sanitizeTRS(null); }
            }
            return sanitizeTRS(this._pickInitialValue(key, def));
        };
        const writeCurrentValue = (next) => {
            const sanitized = sanitizeTRS(next);
            if (adapter && typeof adapter.set === 'function') {
                try { adapter.set(sanitized); } catch (_) { }
            } else {
                this.params[key] = sanitized;
            }
            return sanitized;
        };
        const base = readBaseValue();
        const cur = readCurrentValue();
        const combineWithBase = (baseTransform, deltaTransform) => {
            const basePos = new THREE.Vector3(
                safeNumber(baseTransform.position[0], 0),
                safeNumber(baseTransform.position[1], 0),
                safeNumber(baseTransform.position[2], 0),
            );
            const baseQuat = new THREE.Quaternion().fromArray(baseTransform.quaternion);
            const baseScale = new THREE.Vector3(
                safeNumber(baseTransform.scale[0], 1),
                safeNumber(baseTransform.scale[1], 1),
                safeNumber(baseTransform.scale[2], 1),
            );

            const deltaPos = new THREE.Vector3(
                safeNumber(deltaTransform.position[0], 0),
                safeNumber(deltaTransform.position[1], 0),
                safeNumber(deltaTransform.position[2], 0),
            );
            const deltaQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
                safeNumber(deltaTransform.rotationEuler[0], 0),
                safeNumber(deltaTransform.rotationEuler[1], 0),
                safeNumber(deltaTransform.rotationEuler[2], 0),
                'XYZ',
            ));
            const deltaScale = new THREE.Vector3(
                safeNumber(deltaTransform.scale[0], 1),
                safeNumber(deltaTransform.scale[1], 1),
                safeNumber(deltaTransform.scale[2], 1),
            );

            const absPos = basePos.clone().add(deltaPos);
            const absQuat = baseQuat.clone().multiply(deltaQuat);
            const absScale = baseScale.clone().multiply(deltaScale);
            return { position: absPos, quaternion: absQuat, scale: absScale };
        };
        const absolute = combineWithBase(base, cur);

        const target = new THREE.Object3D();
        try {
            target.position.copy(absolute.position);
            target.quaternion.copy(absolute.quaternion);
            target.scale.copy(absolute.scale);
        } catch (_) { }
        viewer.scene.add(target);

        // Prefer the direct controls build; fallback to Addons
        let TCctor = TransformControlsDirect || TransformControlsAddons;
        try {
            if (!TCctor) TCctor = TransformControlsAddons;
        } catch (_) { /* no-op */ }
        if (!TCctor) {
            console.warn('[TransformControls] Not available from imports; skipping gizmo.');
            return;
        }
        const tc = new TCctor(viewer.camera, viewer.renderer.domElement);
        const desiredMode = (inputEl && inputEl.dataset && inputEl.dataset.xformMode) ? String(inputEl.dataset.xformMode) : 'translate';
        const safeMode = (desiredMode === 'scale') ? 'translate' : desiredMode;
        tc.setMode(safeMode);
        // Newer three.js TransformControls emit mouseDown/mouseUp instead of dragging-changed
        let __lastCommitAt = 0;
        const commitTransform = () => {
            const now = Date.now();
            if (now - __lastCommitAt < 5) return; // dedupe if two events fire together
            __lastCommitAt = now;
            try {
                const featureID = (this.params && Object.prototype.hasOwnProperty.call(this.params, 'featureID'))
                    ? this.params.featureID
                    : null;
                if (typeof this.options.onChange === 'function') {
                    this.options.onChange(featureID);
                }
            } catch (_) { }
            // After history re-runs (which clears the scene), re-add the gizmo and target so it stays active
            try {
                const addBack = () => {
                    try {
                        const activeState = SchemaForm.__activeXform;
                        if (!activeState) return;
                        if (activeState.owner !== this) return;
                        if (activeState.inputEl !== inputEl) return;
                        if (activeState.key !== key) return;
                        if (adapter && typeof adapter.stepId === 'string' && activeState.stepId && activeState.stepId !== adapter.stepId) return;
                        if (!viewer || !viewer.scene) return;
                        if (!tc || typeof tc.attach !== 'function') return;
                        if (target && target.isObject3D) { try { viewer.scene.add(target); } catch (_) { } }
                        const helper = (typeof tc.getHelper === 'function') ? tc.getHelper() : null;
                        if (helper && helper.isObject3D) { try { viewer.scene.add(helper); tc.__helper = helper; } catch (_) { } }
                        else if (tc && tc.isObject3D) { try { viewer.scene.add(tc); } catch (_) { } }
                        else if (tc.__fallbackGroup && tc.__fallbackGroup.isObject3D) { try { viewer.scene.add(tc.__fallbackGroup); } catch (_) { } }
                        try { if (typeof tc.attach === 'function') tc.attach(target); } catch (_) { }
                        try {
                            const m = (typeof tc.getMode === 'function') ? tc.getMode() : (tc.mode || 'translate');
                            if (typeof tc.setMode === 'function') tc.setMode(m);
                        } catch (_) { }
                        try { viewer.render && viewer.render(); } catch (_) { }
                        try { refreshOverlay(); } catch (_) { }
                        try { updateForCamera(); } catch (_) { }
                    } catch (_) { }
                };
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(addBack);
                else setTimeout(addBack, 0);
            } catch (_) { }
        };
        const markOverlay = (obj) => {
            if (!obj || !obj.isObject3D) return;
            const apply = (node) => {
                try {
                    if (!node || !node.isObject3D) return;
                    const ud = node.userData || (node.userData = {});
                    if (ud.__brepOverlayHook) return;
                    const prev = node.onBeforeRender;
                    node.onBeforeRender = function(renderer, scene, camera, geometry, material, group) {
                        try { renderer.clearDepth(); } catch (_) { }
                        if (typeof prev === 'function') {
                            prev.call(this, renderer, scene, camera, geometry, material, group);
                        }
                    };
                    ud.__brepOverlayHook = true;
                } catch (_) { }
            };
            apply(obj);
            if (typeof obj.traverse === 'function') obj.traverse((child) => apply(child));
        };

        const refreshOverlay = () => {
            try {
                markOverlay(tc);
                markOverlay(tc._gizmo);
                markOverlay(tc._helper);
                markOverlay(tc.gizmo);
                markOverlay(tc.helper);
                markOverlay(tc.__helper);
                markOverlay(tc.__fallbackGroup);
            } catch (_) { }
        };

        const updateForCamera = () => {
            try {
                if (typeof tc.update === 'function') tc.update();
                else tc.updateMatrixWorld(true);
            } catch (_) { }
            refreshOverlay();
        };
        try { updateForCamera(); } catch (_) {}
        try {
            if (viewer?.controls && typeof viewer.controls.addEventListener === 'function') {
                viewer.controls.addEventListener('change', updateForCamera);
            }
        } catch (_) { }

        try { tc.addEventListener('mouseDown', () => { try { if (viewer.controls) viewer.controls.enabled = false; } catch (_) {} refreshOverlay(); }); } catch (_) {}
        try { tc.addEventListener('mouseUp',   () => { try { if (viewer.controls) viewer.controls.enabled = true;  } catch (_) {} commitTransform(); refreshOverlay(); }); } catch (_) {}
        // Backward/compat: older builds fire dragging-changed
        try {
            tc.addEventListener('dragging-changed', (ev) => {
                try { if (viewer.controls) viewer.controls.enabled = !ev.value; } catch (_) {}
                if (!ev.value) commitTransform();
                refreshOverlay();
            });
        } catch (_) {}

        const updateParamFromTarget = () => {
            const basePosVec = new THREE.Vector3(
                safeNumber(base.position[0], 0),
                safeNumber(base.position[1], 0),
                safeNumber(base.position[2], 0),
            );
            const relPosVec = new THREE.Vector3(target.position.x, target.position.y, target.position.z).sub(basePosVec);

            const baseQuatObj = new THREE.Quaternion().fromArray(base.quaternion);
            const relQuat = baseQuatObj.clone().invert().multiply(target.quaternion.clone());
            const relEuler = new THREE.Euler().setFromQuaternion(relQuat, 'XYZ');

            const baseScaleVec = new THREE.Vector3(
                safeNumber(base.scale[0], 1),
                safeNumber(base.scale[1], 1),
                safeNumber(base.scale[2], 1),
            );
            const relScaleVec = new THREE.Vector3(
                safeDiv(target.scale.x, baseScaleVec.x),
                safeDiv(target.scale.y, baseScaleVec.y),
                safeDiv(target.scale.z, baseScaleVec.z),
            );

            const next = {
                position: [relPosVec.x, relPosVec.y, relPosVec.z],
                rotationEuler: [relEuler.x, relEuler.y, relEuler.z],
                scale: [relScaleVec.x, relScaleVec.y, relScaleVec.z],
            };
            const stored = writeCurrentValue(next);
            if (!adapter) {
                try {
                    const row = this._fieldsWrap.querySelector(`[data-key="${key}"]`);
                    const info = row ? row.querySelector('.transform-info') : null;
                    if (info) {
                        const fmt = (n) => {
                            const x = Number(n);
                            if (!Number.isFinite(x)) return '0';
                            const a = Math.abs(x);
                            const prec = a >= 100 ? 0 : (a >= 10 ? 1 : 2);
                            return String(x.toFixed(prec));
                        };
                        info.textContent = `pos(${fmt(stored.position[0])}, ${fmt(stored.position[1])}, ${fmt(stored.position[2])})  rot(${fmt(stored.rotationEuler[0])}, ${fmt(stored.rotationEuler[1])}, ${fmt(stored.rotationEuler[2])})`;
                    }
                    try {
                        const pairs = [
                            ['.tf-pos-x', stored.position[0]],
                            ['.tf-pos-y', stored.position[1]],
                            ['.tf-pos-z', stored.position[2]],
                            ['.tf-rot-x', stored.rotationEuler[0]],
                            ['.tf-rot-y', stored.rotationEuler[1]],
                            ['.tf-rot-z', stored.rotationEuler[2]],
                        ];
                        for (const [sel, val] of pairs) {
                            const el = row ? row.querySelector(sel) : null;
                            if (el) this._setInputValue(el, 'number', val);
                        }
                    } catch (_) { }
                } catch (_) { }
            }
        };
        tc.addEventListener('change', (ev) => { updateParamFromTarget(ev); refreshOverlay(); });
        // Fallback commit for cases where mouseUp/dragging-changed are unreliable (some builds)
        try { tc.addEventListener('objectChange', () => { try { if (!tc.dragging) commitTransform(); } catch (_) {} refreshOverlay(); }); } catch (_) {}

        // Expose an isOver helper for Viewer to suppress its own handlers when interacting with gizmo
        const isOver = (ev) => {
            try {
                const canvas = viewer.renderer.domElement;
                const rect = canvas.getBoundingClientRect();
                const x = (ev.clientX - rect.left) / rect.width; // 0..1
                const y = (ev.clientY - rect.top) / rect.height; // 0..1
                // Use viewer helper for consistent NDC mapping
                const ndc = (typeof viewer._getPointerNDC === 'function')
                    ? viewer._getPointerNDC({ clientX: ev.clientX, clientY: ev.clientY })
                    : new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
                viewer.raycaster.setFromCamera(ndc, viewer.camera);
                // Prefer precise picker meshes for the current mode; fallback to whole gizmo
                const mode = (typeof tc.getMode === 'function') ? tc.getMode() : (tc.mode || desiredMode || 'translate');
                const giz = tc._gizmo || tc.gizmo || null;
                const pick = (giz && giz.picker) ? (giz.picker[mode] || giz.picker.translate || giz.picker.rotate) : null;
                const pickRoot = pick || giz || tc.__fallbackGroup || null;
                if (!pickRoot) return false;
                const hits = viewer.raycaster.intersectObject(pickRoot, true) || [];
                return hits.length > 0;
            } catch (_) { return false; }
        };
        try {
            window.__BREP_activeXform = {
                controls: tc,
                viewer,
                isOver,
                target,
                group: tc.__fallbackGroup || (tc && tc.isObject3D ? tc : null),
                updateForCamera,
            };
        } catch (_) { }

        let addedToScene = false;
        try { markOverlay(tc._gizmo); } catch (_) { }
        try { markOverlay(tc._helper); } catch (_) { }
        try { markOverlay(tc.gizmo); } catch (_) { }
        try { markOverlay(tc.helper); } catch (_) { }

        try {
            // Preferred modern API: helper root on the controls
            const helper = (typeof tc.getHelper === 'function') ? tc.getHelper() : null;
            if (helper && helper.isObject3D) {
                try { helper.userData = helper.userData || {}; helper.userData.excludeFromFit = true; } catch (_) {}
                markOverlay(helper);
                viewer.scene.add(helper); addedToScene = true; tc.__helper = helper;
            }
            else if (tc && tc.isObject3D) {
                try { tc.userData = tc.userData || {}; tc.userData.excludeFromFit = true; } catch (_) {}
                markOverlay(tc);
                viewer.scene.add(tc); addedToScene = true;
            }
        } catch (_) { /* tolerate builds where controls aren't Object3D */ }
        if (!addedToScene) {
            // Fallback: try adding known internal object3D parts if present
            try {
                const group = new THREE.Group();
                group.name = 'TransformControlsGroup';
                const candidates = [tc?.gizmo, tc?._gizmo, tc?.picker, tc?._picker, tc?.helper, tc?._helper];
                let attached = 0;
                for (const cand of candidates) {
                    if (cand && cand.isObject3D) { try { group.add(cand); attached++; } catch (_) {} }
                }
                if (attached > 0) {
                    try { group.userData = group.userData || {}; group.userData.excludeFromFit = true; } catch (_) {}
                    markOverlay(group);
                    viewer.scene.add(group); addedToScene = true; tc.__fallbackGroup = group;
                }
            } catch (_) { /* ignore */ }
            if (!addedToScene) {
                // eslint-disable-next-line no-console
                console.warn('[TransformControls] Could not add gizmo to scene (no Object3D found).');
            }
        }
        try { tc.showX = true; tc.showY = true; tc.showZ = true; } catch (_) { }
        try { tc.setSpace('world'); } catch (_) { }
        try { tc.addEventListener('change', () => { try { viewer.render(); } catch (_) {} }); } catch (_) { }
        try { tc.attach(target); markOverlay(tc); markOverlay(tc.__helper); markOverlay(tc.__fallbackGroup); } catch (_) { }

        // Mark active
        inputEl.setAttribute('active-transform', 'true');
        try { wrapEl.classList.add('ref-active'); } catch (_) { }

        SchemaForm.__activeXform = {
            owner: this,
            key,
            stepId: adapter && typeof adapter.stepId === 'string' ? adapter.stepId : null,
            inputEl,
            wrapEl,
            target,
            controls: tc,
            viewer,
            group: tc.__fallbackGroup || (tc && tc.isObject3D ? tc : null),
            captureHandlers: null,
            controlsChangeHandler: updateForCamera,
            valueAdapter: adapter || null,
            baseTransform: base,
        };

        // Install capture-phase listeners to disable ArcballControls early when pressing gizmo
        try {
            const canvas = viewer && viewer.renderer ? viewer.renderer.domElement : null;
            if (canvas && typeof canvas.addEventListener === 'function') {
                const onDownCapture = (ev) => {
                    try {
                        if (isOver(ev)) {
                            if (viewer && viewer.controls) viewer.controls.enabled = false;
                        }
                    } catch (_) { }
                };
                const onUpCapture = (ev) => {
                    // Re-enable controls on pointer release to be safe
                    try { if (viewer && viewer.controls) viewer.controls.enabled = true; } catch (_) { }
                    void ev;
                };
                canvas.addEventListener('pointerdown', onDownCapture, { passive: true, capture: true });
                // Use window to ensure we catch release even if released off-canvas
                window.addEventListener('pointerup', onUpCapture, { passive: true, capture: true });
                SchemaForm.__activeXform.captureHandlers = { canvas, win: window, onDownCapture, onUpCapture };
            }
        } catch (_) { /* ignore */ }
    }

    _stopActiveTransformWidget() {
        try { SchemaForm.__stopGlobalActiveXform(); } catch (_) { }
    }


    _stopActiveReferenceSelection() {
        // Clear global active if it belongs to this instance
        try {
            if (SchemaForm.__activeRefInput) {
                try { SchemaForm.__activeRefInput.style.filter = 'none'; } catch (_) { }
                try { SchemaForm.__activeRefInput.removeAttribute('active-reference-selection'); } catch (_) { }
                try {
                    const wrap = SchemaForm.__activeRefInput.closest('.ref-single-wrap, .ref-multi-wrap');
                    if (wrap) wrap.classList.remove('ref-active');
                } catch (_) { }
            }
        } catch (_) { }
        SchemaForm.__activeRefInput = null;
        SelectionFilter.restoreAllowedSelectionTypes();
    }

    _renderChips(chipsWrap, key, values) {
        chipsWrap.textContent = '';
        const arr = Array.isArray(values) ? values : [];
        const normalizedValues = normalizeReferenceList(arr);
        if (Array.isArray(this.params[key])) {
            this.params[key] = normalizedValues;
        } else if (this.params[key] && typeof this.params[key] === 'object' && Array.isArray(this.params[key].targets)) {
            this.params[key].targets = normalizedValues;
        }
        for (const name of normalizedValues) {
            const chip = document.createElement('span');
            chip.className = 'ref-chip';

            const label = document.createElement('span');
            label.className = 'ref-chip-label';
            label.textContent = name;
            chip.appendChild(label);

            // Hover highlight on chip hover
            chip.addEventListener('mouseenter', () => {
                try { SelectionFilter.setHoverByName(this.options?.scene || null, name); } catch (_) { }
            });
            chip.addEventListener('mouseleave', () => {
                try { SelectionFilter.clearHover(); } catch (_) { }
            });

            const btn = document.createElement('span');
            btn.className = 'ref-chip-remove';
            btn.textContent = '✕';
            btn.title = 'Remove';
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                // Support both plain array params and object-with-targets
                let currentArrayRef = null;
                if (Array.isArray(this.params[key])) {
                    currentArrayRef = this.params[key];
                } else if (this.params[key] && typeof this.params[key] === 'object' && Array.isArray(this.params[key].targets)) {
                    currentArrayRef = this.params[key].targets;
                } else {
                    // Initialize as array if nothing sensible exists
                    this.params[key] = [];
                    currentArrayRef = this.params[key];
                }
                const idx = currentArrayRef.indexOf(name);
                if (idx >= 0) currentArrayRef.splice(idx, 1);
                this._renderChips(chipsWrap, key, currentArrayRef);
                this._emitParamsChange(key, this.params[key]);
                try {
                    if (typeof this.options.onReferenceChipRemove === 'function') {
                        this.options.onReferenceChipRemove(name, key);
                    }
                } catch (_) { }
            });
            chip.appendChild(btn);

            chipsWrap.appendChild(chip);
        }
        if (arr.length === 0) {
            const hint = document.createElement('span');
            hint.className = 'ref-chip';
            hint.style.opacity = '0.6';
            hint.textContent = 'Click then pick items in scene';
            chipsWrap.appendChild(hint);
        }
    }

    _emitParamsChange(key, value) {
        // Suppress auto-run if a transform editing session is active on this form
        try {
            const s = SchemaForm.__activeXform;
            if (s && s.owner === this) return;
        } catch (_) { }
        if (typeof this.options.onChange === 'function') {
            const featureID = (this.params && Object.prototype.hasOwnProperty.call(this.params, 'featureID'))
                ? this.params.featureID
                : null;
            const details = { key, value, params: this.params, form: this };
            try {
                this.options.onChange(featureID, details);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.log(error);
            }
        }
    }

    _pickInitialValue(key, def) {
        if (this.params[key] !== undefined && this.params[key] !== null) return this.params[key];
        if (Object.prototype.hasOwnProperty.call(def, 'default_value')) return def.default_value;
        return this._defaultForType(def.type);
    }

    _defaultForType(type) {
        switch (type) {
            case 'boolean': return false;
            case 'options': return '';
            case 'reference_selection': return null;
            case 'transform': return { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] };
            case 'vec3': return [0, 0, 0];
            default: return '';
        }
    }

    _setInputValue(el, type, value) {
        switch (type) {
            case 'boolean':
                el.checked = Boolean(value);
                break;
            case 'number': {
                // Accept formulas or plain numbers. If the value is not purely numeric,
                // render the input as text so the expression is visible.
                const str = value == null ? '' : String(value);
                const numericLike = /^\s*[-+]?((\d+(?:\.\d*)?)|(\.\d+))(?:[eE][-+]?\d+)?\s*$/.test(str);
                try {
                    if (numericLike) {
                        if (el.type !== 'number') el.type = 'number';
                        // Re-apply numeric attributes if we previously toggled away
                        if (el.dataset && el.dataset.step) el.step = el.dataset.step;
                        if (el.dataset && el.dataset.min) el.min = el.dataset.min;
                        if (el.dataset && el.dataset.max) el.max = el.dataset.max;
                    } else {
                        if (el.type !== 'text') el.type = 'text';
                    }
                } catch (_) { /* ignore */ }
                el.value = str;
                break;
            }
            case 'options': {
                const asStr = String(value == null ? '' : value);
                let has = false;
                for (let i = 0; i < el.options.length; i++) {
                    if (el.options[i].value === asStr) { has = true; break; }
                }
                el.value = has ? asStr : (el.options[0] ? el.options[0].value : '');
                break;
            }
            case 'file': {
                // Update the info label adjacent to the button
                try {
                    const wrap = el && el.parentNode ? el.parentNode : null;
                    const info = wrap ? wrap.querySelector('.file-info') : null;
                    if (info) {
                        if (typeof value === 'string' && value.startsWith('data:') && value.includes(';base64,')) {
                            const b64 = value.split(',')[1] || '';
                            const size = Math.floor((b64.length * 3) / 4);
                            info.textContent = `Loaded (${size} bytes)`;
                        } else if (value && String(value).length) {
                            info.textContent = `Loaded (${String(value).length} chars)`;
                        } else {
                            info.textContent = 'No file selected';
                        }
                    }
                } catch (_) { }
                break;
            }
            default:
                el.value = value == null ? '' : String(value);
                break;
        }
    }

    _prettyLabel(key) {
        const withSpaces = String(key)
            .replace(/_/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/\s+/g, ' ')
            .trim();
        return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
    }

    _makeStyle() {
        const style = document.createElement('style');
        style.textContent = `
      :host, .schema-form-host, .panel {
        --bg: #0f1117;
        --bg-elev: #12141b;
        --border: #262b36;
        --text: #e6e6e6;
        --muted: #9aa4b2;
        --accent: #6ea8fe;
        --focus: #3b82f6;
        --input-bg: #0b0e14;
        --radius: 12px;
        --gap: 3px;
        color-scheme: dark;
      }

      .panel {
        color: var(--text);
        background: transparent;
        border-radius: var(--radius);
        max-width: 100%;
      }

      .fields {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .field-row {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
      }

      .label {
        color: var(--muted);
      }

      .control-wrap { display: flex; flex-direction: column; gap: 6px; }

      .input, .select {
        appearance: none;
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 10px;
        outline: none;
        transition: border-color .15s ease, box-shadow .15s ease;
        width: 100%;
        box-sizing: border-box;
      }
      textarea.input {
        resize: vertical;
        line-height: 1.4;
        min-height: 72px;
        font-family: inherit;
      }
      .btn {
        appearance: none;
        background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 12px;
        cursor: pointer;
        transition: border-color .15s ease, box-shadow .15s ease, transform .05s ease;
      }
      .btn.btn-slim { padding: 6px 10px; border-radius: 8px; font-size: 12px; }
      .btn.selected { border-color: var(--focus); color: #fff; }
      .btn:hover { border-color: var(--focus); box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
      .btn:active { transform: translateY(1px); }
      .input:focus, .select:focus {
        border-color: var(--focus);
        
      }
      .file-info { font-size: 12px; color: var(--muted); }

      .checkbox {
        width: 18px; height: 18px;
        accent-color: var(--accent);
      }

      .ref-select-placeholder {
        min-height: 36px;
        border: 1px dashed var(--border);
        border-radius: 10px;
        background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
      }
      /* Single reference display (replaces textbox) */
      .ref-single-wrap { display: block; }
      .ref-single-display {
        appearance: none;
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 10px;
        outline: none;
        cursor: pointer;
        user-select: none;
        min-height: 36px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .ref-single-label { flex: 1 1 auto; overflow-wrap: anywhere; text-align: left; }
      /* Active highlight for ref widgets */
      .ref-single-wrap.ref-active .ref-single-display,
      .ref-multi-wrap.ref-active .ref-chips {
        border-color: var(--focus);
        box-shadow: 0 0 0 3px rgba(59,130,246,.15);
      }
      /* Multi reference chips */
      .ref-multi-wrap { display: flex; flex-direction: column; gap: 6px; }
      .ref-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px; border: 1px dashed var(--border); border-radius: 10px; cursor: pointer; background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01)); max-width: 100%; }
      .ref-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; background: #1a2030; border: 1px solid var(--border); font-size: 12px; max-width: 100%; }
      .ref-chip-label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; word-break: break-word; white-space: normal; }
      .ref-chip-remove { color: var(--muted); cursor: pointer; flex: 0 0 auto; }
      .ref-chip-remove:hover { color: var(--danger); }

      /* Transform widget */
      .transform-wrap { display: flex; flex-direction: column; gap: 8px; }
      .transform-modes { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .transform-info { font-size: 12px; color: var(--muted); }
      .transform-details { display: none; }
      .transform-wrap.ref-active .transform-details { display: block; }
      .transform-grid { display: flex; flex-direction: column; gap: 6px; }
      .transform-row { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 8px; }
      .transform-label { color: var(--muted); font-size: 12px; }
      .transform-inputs { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 6px; }
      .transform-input { padding: 6px 8px; }
      .transform-wrap.ref-active .btn { border-color: var(--focus); box-shadow: 0 0 0 3px rgba(59,130,246,.15); }

      .multi-transform-wrap { display: flex; flex-direction: column; gap: 10px; }
      .mt-list { display: flex; flex-direction: column; gap: 10px; }
      .mt-item { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px; border: 1px solid var(--border); background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01)); }
      .mt-item-header { display: flex; justify-content: space-between; align-items: center; font-weight: 500; }
      .mt-item-actions { display: inline-flex; gap: 4px; }
      .mt-item-actions .btn-icon { font-size: 12px; line-height: 1; padding: 4px 6px; }
      .mt-row { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: center; }
      .mt-row-label { font-size: 12px; color: var(--muted); }
      .mt-row-inputs { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 6px; }
      .mt-number { padding: 6px 8px; }
      .control-placeholder { padding: 8px; font-size: 12px; color: var(--muted); border: 1px dashed var(--border); border-radius: 10px; background: rgba(15,23,42,0.35); }
    `;
        return style;
    }
}

export { SchemaForm as genFeatureUI };
