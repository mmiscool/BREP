import { CADmaterials } from "./CADmaterials.js";
import {BREP} from '../BREP/BREP.js';
export class SelectionFilter {
    static SOLID = "SOLID";
    static COMPONENT = "COMPONENT";
    static FACE = "FACE";
    static PLANE = "PLANE";
    static SKETCH = "SKETCH";
    static EDGE = "EDGE";
    static LOOP = "LOOP";
    static VERTEX = "VERTEX";
    static ALL = "ALL";

    // The set (or ALL) of types available in the current context
    static allowedSelectionTypes = SelectionFilter.ALL;
    static viewer = null;
    static previouseAllowedSelectionTypes = null;
    static _hovered = new Set(); // objects currently hover-highlighted
    static hoverColor = '#fbff00'; // default hover tint

    constructor() {
        throw new Error("SelectionFilter is static and cannot be instantiated.");
    }

    static get TYPES() { return [this.SOLID, this.COMPONENT, this.FACE, this.PLANE, this.SKETCH, this.EDGE, this.LOOP, this.VERTEX, this.ALL]; }

    // Convenience: return the list of selectable types for the dropdown (excludes ALL)
    static getAvailableTypes() {
        if (SelectionFilter.allowedSelectionTypes === SelectionFilter.ALL) {
            return SelectionFilter.TYPES.filter(t => t !== SelectionFilter.ALL);
        }
        const arr = Array.from(SelectionFilter.allowedSelectionTypes || []);
        return arr.filter(t => t && t !== SelectionFilter.ALL);
    }

    static getCurrentType() {
        // Current type tracking has been removed; keep method for compatibility.
        return null;
    }

    static setCurrentType(_type) {
        // No-op: current type is no longer tracked.
        void _type;
    }

    static SetSelectionTypes(types) {

        this.viewer.endSplineMode();
        if (types === SelectionFilter.ALL) {
            SelectionFilter.allowedSelectionTypes = SelectionFilter.ALL;
            SelectionFilter.triggerUI();
            SelectionFilter.#logAllowedTypesChange(SelectionFilter.allowedSelectionTypes, 'SetSelectionTypes');
            return;
        }
        const list = Array.isArray(types) ? types : [types];
        const invalid = list.filter(t => !SelectionFilter.TYPES.includes(t) || t === SelectionFilter.ALL);
        if (invalid.length) throw new Error(`Unknown selection type(s): ${invalid.join(", ")}`);
        SelectionFilter.allowedSelectionTypes = new Set(list);
        SelectionFilter.triggerUI();
        SelectionFilter.#logAllowedTypesChange(SelectionFilter.allowedSelectionTypes, 'SetSelectionTypes');
    }

    static stashAllowedSelectionTypes() {
        SelectionFilter.previouseAllowedSelectionTypes = SelectionFilter.allowedSelectionTypes;
    }

    static restoreAllowedSelectionTypes() {
        if (SelectionFilter.previouseAllowedSelectionTypes !== null) {
            SelectionFilter.allowedSelectionTypes = SelectionFilter.previouseAllowedSelectionTypes;
            SelectionFilter.previouseAllowedSelectionTypes = null;
            SelectionFilter.triggerUI();
            SelectionFilter.#logAllowedTypesChange(SelectionFilter.allowedSelectionTypes, 'RestoreSelectionTypes');
        }
    }



    static allowType(type) {
        // Legacy support: expand available set; does not change currentType
        if (type === SelectionFilter.ALL) { SelectionFilter.allowedSelectionTypes = SelectionFilter.ALL; SelectionFilter.triggerUI(); return; }
        if (SelectionFilter.TYPES.includes(type)) {
            if (SelectionFilter.allowedSelectionTypes === SelectionFilter.ALL) { SelectionFilter.triggerUI(); return; }
            SelectionFilter.allowedSelectionTypes.add(type);
        } else throw new Error(`Unknown selection type: ${type}`);
        SelectionFilter.triggerUI();
        SelectionFilter.#logAllowedTypesChange(SelectionFilter.allowedSelectionTypes, 'allowType');
    }

    static disallowType(type) {
        // Legacy support: shrink available set; does not change currentType (may become invalid until next SetSelectionTypes)
        if (SelectionFilter.allowedSelectionTypes === SelectionFilter.ALL) SelectionFilter.allowedSelectionTypes = new Set();
        if (SelectionFilter.TYPES.includes(type)) SelectionFilter.allowedSelectionTypes.delete(type);
        else throw new Error(`Unknown selection type: ${type}`);
        SelectionFilter.triggerUI();
        SelectionFilter.#logAllowedTypesChange(SelectionFilter.allowedSelectionTypes, 'disallowType');
    }

    static GetSelectionTypes() {
        const v = SelectionFilter.allowedSelectionTypes;
        return v === SelectionFilter.ALL ? SelectionFilter.ALL : Array.from(v);
    }

    // Check against the allowed set only (ignores currentType)
    static matchesAllowedType(type) {
        if (!type) return false;
        if (SelectionFilter.allowedSelectionTypes === SelectionFilter.ALL) return true;
        return SelectionFilter.allowedSelectionTypes?.has?.(type) || false;
    }

    static IsAllowed(type) {
        if (!type) return false;
        return SelectionFilter.matchesAllowedType(type);
    }

    static Reset() {
        SelectionFilter.allowedSelectionTypes = SelectionFilter.ALL;
        SelectionFilter.triggerUI();
        SelectionFilter.#logAllowedTypesChange(SelectionFilter.allowedSelectionTypes, 'Reset');
    }

    static #getBaseMaterial(obj) {
        if (!obj) return null;
        const ud = obj.userData || {};
        if (ud.__baseMaterial) return ud.__baseMaterial;
        if (obj.type === SelectionFilter.FACE) return CADmaterials.FACE?.BASE ?? CADmaterials.FACE ?? obj.material;
        if (obj.type === SelectionFilter.PLANE) return CADmaterials.PLANE?.BASE ?? CADmaterials.FACE?.BASE ?? obj.material;
        if (obj.type === SelectionFilter.EDGE) return CADmaterials.EDGE?.BASE ?? CADmaterials.EDGE ?? obj.material;
        if (obj.type === SelectionFilter.SOLID || obj.type === SelectionFilter.COMPONENT) return obj.material;
        return obj.material;
    }

    // ---------------- Hover Highlighting ----------------
    static getHoverColor() { return SelectionFilter.hoverColor; }
    static setHoverColor(hex) {
        if (!hex) return;
        try { SelectionFilter.hoverColor = String(hex); } catch (_) { }
        // Update current hovered objects live
        for (const o of Array.from(SelectionFilter._hovered)) {
            if (o && o.material && o.material.color && typeof o.material.color.set === 'function') {
                try { o.material.color.set(SelectionFilter.hoverColor); } catch (_) { }
            }
        }
    }

    static setHoverObject(obj, options = {}) {
        const { ignoreFilter = false } = options;
        // Clear existing hover first
        SelectionFilter.clearHover();
        if (!obj) return;
        // Highlight depending on type
        SelectionFilter.#applyHover(obj, { ignoreFilter });
    }

    static setHoverByName(scene, name) {
        if (!scene || !name) { SelectionFilter.clearHover(); return; }
        const obj = scene.getObjectByName(name);
        if (!obj) { SelectionFilter.clearHover(); return; }
        SelectionFilter.setHoverObject(obj);
    }

    static clearHover() {
        if (!SelectionFilter._hovered || SelectionFilter._hovered.size === 0) return;
        for (const o of Array.from(SelectionFilter._hovered)) {
            SelectionFilter.#restoreHover(o);
        }
        SelectionFilter._hovered.clear();
    }

    static #applyHover(obj, options = {}) {
        const { ignoreFilter = false } = options;
        if (!obj) return;
        // Respect selection filter: skip if disallowed
        const allowed = ignoreFilter
            || SelectionFilter.IsAllowed(obj.type)
            || SelectionFilter.matchesAllowedType(obj.type);
        if (!allowed) return;

        // Only ever highlight one object: the exact object provided, if it has a color
        const target = obj;
        if (!target) return;

        const applyToOne = (t) => {
            if (!t) return;
            if (!t.userData) t.userData = {};
            const origMat = t.material;
            if (!origMat) return;
            if (t.userData.__hoverMatApplied) { SelectionFilter._hovered.add(t); return; }
            let clone;
            try { clone = typeof origMat.clone === 'function' ? origMat.clone() : origMat; } catch { clone = origMat; }
            try { if (clone && clone.color && typeof clone.color.set === 'function') clone.color.set(SelectionFilter.hoverColor); } catch { }
            try {
                t.userData.__hoverOrigMat = origMat;
                t.userData.__hoverMatApplied = true;
                if (clone !== origMat) t.material = clone;
                t.userData.__hoverMat = clone;
            } catch { }
            SelectionFilter._hovered.add(t);
        };

        if (target.type === SelectionFilter.SOLID || target.type === SelectionFilter.COMPONENT) {
            // Highlight all immediate child faces/edges for SOLID or COMPONENT children
            if (Array.isArray(target.children)) {
                for (const ch of target.children) {
                    if (!ch) continue;
                    if (ch.type === SelectionFilter.SOLID || ch.type === SelectionFilter.COMPONENT) {
                        if (Array.isArray(ch.children)) {
                            for (const nested of ch.children) {
                                if (nested && (nested.type === SelectionFilter.FACE || nested.type === SelectionFilter.EDGE)) applyToOne(nested);
                            }
                        }
                    } else if (ch.type === SelectionFilter.FACE || ch.type === SelectionFilter.EDGE) {
                        applyToOne(ch);
                    }
                }
            }
            // Track the solid as a logical hovered root to clear later
            SelectionFilter._hovered.add(target);
            return;
        }

        if (target.type === SelectionFilter.VERTEX) {
            // Apply to the vertex object and any drawable children (e.g., Points)
            applyToOne(target);
            if (Array.isArray(target.children)) {
                for (const ch of target.children) {
                    applyToOne(ch);
                }
            }
            return;
        }

        applyToOne(target);
    }

    static #restoreHover(obj) {
        if (!obj) return;
        const restoreOne = (t) => {
            if (!t) return;
            const ud = t.userData || {};
            if (!ud.__hoverMatApplied) return;
            const cloneWithColor = (mat, colorHex) => {
                if (!mat) return mat;
                let c = mat;
                try {
                    c = typeof mat.clone === 'function' ? mat.clone() : mat;
                    if (c && c.color && typeof c.color.set === 'function' && colorHex) c.color.set(colorHex);
                } catch { c = mat; }
                return c;
            };
            const applySelectionMaterial = () => {
                if (t.type === SelectionFilter.FACE) return CADmaterials.FACE?.SELECTED ?? CADmaterials.FACE ?? ud.__hoverOrigMat ?? t.material;
                if (t.type === SelectionFilter.PLANE) return CADmaterials.PLANE?.SELECTED ?? CADmaterials.FACE?.SELECTED ?? ud.__hoverOrigMat ?? t.material;
                if (t.type === SelectionFilter.EDGE) {
                    const base = ud.__hoverOrigMat ?? t.material;
                    const selColor = CADmaterials.EDGE?.SELECTED?.color || CADmaterials.EDGE?.SELECTED?.color?.getHexString?.();
                    return cloneWithColor(base, selColor || '#ff00ff');
                }
                if (t.type === SelectionFilter.SOLID || t.type === SelectionFilter.COMPONENT) return CADmaterials.SOLID?.SELECTED ?? ud.__hoverOrigMat ?? t.material;
                return ud.__hoverOrigMat ?? t.material;
            };
            const applyDeselectedMaterial = () => {
                if (t.type === SelectionFilter.FACE) return ud.__hoverOrigMat ?? SelectionFilter.#getBaseMaterial(t) ?? t.material;
                if (t.type === SelectionFilter.PLANE) return ud.__hoverOrigMat ?? SelectionFilter.#getBaseMaterial(t) ?? t.material;
                if (t.type === SelectionFilter.EDGE) return ud.__hoverOrigMat ?? SelectionFilter.#getBaseMaterial(t) ?? t.material;
                if (t.type === SelectionFilter.SOLID || t.type === SelectionFilter.COMPONENT) return ud.__hoverOrigMat ?? t.material;
                return ud.__hoverOrigMat ?? t.material;
            };
            try {
                if (t.selected) {
                    const selMat = applySelectionMaterial();
                    if (selMat) t.material = selMat;
                } else {
                    const baseMat = applyDeselectedMaterial();
                    if (baseMat) t.material = baseMat;
                }
                if (ud.__hoverMat && ud.__hoverMat !== ud.__hoverOrigMat && typeof ud.__hoverMat.dispose === 'function') ud.__hoverMat.dispose();
            } catch { }
            try { delete t.userData.__hoverMatApplied; } catch { }
            try { delete t.userData.__hoverOrigMat; } catch { }
            try { delete t.userData.__hoverMat; } catch { }
        };

        if (obj.type === SelectionFilter.SOLID || obj.type === SelectionFilter.COMPONENT) {
            if (Array.isArray(obj.children)) {
                for (const ch of obj.children) restoreOne(ch);
            }
        }
        if (obj.type === SelectionFilter.VERTEX) {
            if (Array.isArray(obj.children)) {
                for (const ch of obj.children) restoreOne(ch);
            }
        }
        restoreOne(obj);
    }

    static #isInputUsable(el) {
        // Use the closest visible wrapper as the visibility anchor; hidden inputs themselves render display:none
        const anchor = (el && typeof el.closest === 'function')
            ? (el.closest('.ref-single-wrap, .ref-multi-wrap') || el)
            : el;
        if (!anchor || !anchor.isConnected) return false;
        const seen = new Set();
        let node = anchor;
        while (node && !seen.has(node)) {
            seen.add(node);
            if (node.hidden === true) return false;
            try {
                const style = window.getComputedStyle(node);
                if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
            } catch (_) { /* ignore */ }
            const root = (typeof node.getRootNode === 'function') ? node.getRootNode() : null;
            if (root && root.host && root !== node) {
                node = root.host;
                continue;
            }
            node = node.parentElement;
        }
        return true;
    }

    static toggleSelection(objectToToggleSelectionOn) {
        // get the type of the object
        const type = objectToToggleSelectionOn.type;
        if (!type) throw new Error("Object to toggle selection on must have a type.");

        // Check if a reference selection is active
        try {
            let activeRefInput = document.querySelector('[active-reference-selection="true"],[active-reference-selection=true]');
            if (!activeRefInput) {
                try { activeRefInput = window.__BREP_activeRefInput || null; } catch (_) { /* ignore */ }
            }
            if (activeRefInput) {
                const usable = SelectionFilter.#isInputUsable(activeRefInput);
                if (!usable) {
                    try { activeRefInput.removeAttribute('active-reference-selection'); } catch (_) { }
                    try { activeRefInput.style.filter = 'none'; } catch (_) { }
                    try { if (window.__BREP_activeRefInput === activeRefInput) window.__BREP_activeRefInput = null; } catch (_) { }
                    SelectionFilter.restoreAllowedSelectionTypes();
                    return false;
                }

                const dataset = activeRefInput.dataset || {};
                const isMultiRef = dataset.multiple === 'true';
                const maxSelections = Number(dataset.maxSelections);
                const hasMax = Number.isFinite(maxSelections) && maxSelections > 0;
                if (isMultiRef) {
                    let currentCount = 0;
                    try {
                        if (typeof activeRefInput.__getSelectionList === 'function') {
                            const list = activeRefInput.__getSelectionList();
                            if (Array.isArray(list)) currentCount = list.length;
                        } else if (dataset.selectedCount !== undefined) {
                            const parsed = Number(dataset.selectedCount);
                            if (Number.isFinite(parsed)) currentCount = parsed;
                        }
                    } catch (_) { /* ignore */ }
                    if (hasMax && currentCount >= maxSelections) {
                        try {
                            const wrap = activeRefInput.closest('.ref-single-wrap, .ref-multi-wrap');
                            if (wrap) {
                                wrap.classList.add('ref-limit-reached');
                                setTimeout(() => {
                                    try { wrap.classList.remove('ref-limit-reached'); } catch (_) { }
                                }, 480);
                            }
                        } catch (_) { }
                        return true;
                    }
                }
                const allowed = SelectionFilter.allowedSelectionTypes;
                const allowAll = allowed === SelectionFilter.ALL;
                const priorityOrder = [
                    SelectionFilter.VERTEX,
                    SelectionFilter.EDGE,
                    SelectionFilter.FACE,
                    SelectionFilter.PLANE,
                    SelectionFilter.SOLID,
                    SelectionFilter.COMPONENT,
                ];
                const allowedHas = (t) => !!(allowed && typeof allowed.has === 'function' && allowed.has(t));
                const allowedPriority = allowAll ? priorityOrder : priorityOrder.filter(t => allowedHas(t));

                // Helper: find first descendant matching a type
                const findDescendantOfType = (root, desired) => {
                    if (!root || !desired) return null;
                    let found = null;
                    try {
                        root.traverse?.((ch) => {
                            if (!found && ch && ch.type === desired) found = ch;
                        });
                    } catch (_) { /* ignore */ }
                    return found;
                };

                const findAncestorOfType = (obj, desired) => {
                    let cur = obj;
                    while (cur && cur.parent) {
                        if (cur.type === desired) return cur;
                        cur = cur.parent;
                    }
                    return null;
                };
                const pickByTypeList = (typeList) => {
                    if (!Array.isArray(typeList)) return null;
                    for (const desired of typeList) {
                        if (!desired) continue;
                        if (objectToToggleSelectionOn?.type === desired) return objectToToggleSelectionOn;
                        let picked = findDescendantOfType(objectToToggleSelectionOn, desired);
                        if (!picked) picked = findAncestorOfType(objectToToggleSelectionOn, desired);
                        if (picked) return picked;
                    }
                    return null;
                };

                let targetObj = null;
                // Prefer the exact object the user clicked if it is allowed.
                if (allowAll || allowedHas(objectToToggleSelectionOn?.type)) {
                    targetObj = objectToToggleSelectionOn;
                }
                if (!targetObj) {
                    targetObj = pickByTypeList(allowedPriority);
                }
                if (!targetObj && !allowAll && allowed && typeof allowed[Symbol.iterator] === 'function') {
                    targetObj = pickByTypeList(Array.from(allowed));
                }
                if (!targetObj && allowAll) {
                    targetObj = objectToToggleSelectionOn;
                }
                if (!targetObj) return false;

                // Update the reference input with the chosen object
                const objType = targetObj.type;
                const objectName = targetObj.name || `${objType}(${targetObj.position?.x || 0},${targetObj.position?.y || 0},${targetObj.position?.z || 0})`;

                const snapshotSelections = (inputEl) => {
                    const data = inputEl?.dataset || {};
                    let values = null;
                    if (data.selectedValues) {
                        try {
                            const parsed = JSON.parse(data.selectedValues);
                            if (Array.isArray(parsed)) values = parsed;
                        } catch (_) { /* ignore */ }
                    }
                    if (!Array.isArray(values) && typeof inputEl?.__getSelectionList === 'function') {
                        try {
                            const list = inputEl.__getSelectionList();
                            if (Array.isArray(list)) values = list.slice();
                        } catch (_) { /* ignore */ }
                    }
                    let count = 0;
                    if (Array.isArray(values)) {
                        count = values.length;
                    } else if (data.selectedCount !== undefined) {
                        const parsed = Number(data.selectedCount);
                        if (Number.isFinite(parsed) && parsed >= 0) count = parsed;
                    }
                    return count;
                };

                activeRefInput.value = objectName;
                activeRefInput.dispatchEvent(new Event('change'));
                const afterSelectionCount = snapshotSelections(activeRefInput);

                const didReachLimit = isMultiRef && hasMax && afterSelectionCount >= maxSelections;
                const keepActive = isMultiRef && !didReachLimit;

                if (!keepActive) {
                    // Clean up the reference selection state
                    activeRefInput.removeAttribute('active-reference-selection');
                    activeRefInput.style.filter = 'none';
                    try {
                        const wrap = activeRefInput.closest('.ref-single-wrap, .ref-multi-wrap');
                        if (wrap) wrap.classList.remove('ref-active');
                    } catch (_) { }
                    // Restore selection filter
                    SelectionFilter.restoreAllowedSelectionTypes();
                    try { if (window.__BREP_activeRefInput === activeRefInput) window.__BREP_activeRefInput = null; } catch (_) { }
                } else {
                    activeRefInput.setAttribute('active-reference-selection', 'true');
                    activeRefInput.style.filter = 'invert(1)';
                    try {
                        const wrap = activeRefInput.closest('.ref-single-wrap, .ref-multi-wrap');
                        if (wrap) wrap.classList.add('ref-active');
                    } catch (_) { }
                    try { window.__BREP_activeRefInput = activeRefInput; } catch (_) { }
                }
                return true; // handled as a reference selection
            }
        } catch (error) {
            console.warn("Error handling reference selection:", error);
        }

        let parentSelectedAction = false;
        // check if the object is selectable and if it is toggle the .selected atribute on the object. 
        // Allow toggling off even if type is currently disallowed; only block new selections
        if (SelectionFilter.IsAllowed(type) || objectToToggleSelectionOn.selected === true) {
            objectToToggleSelectionOn.selected = !objectToToggleSelectionOn.selected;
            // change the material on the object to indicate it is selected or not.
            if (objectToToggleSelectionOn.selected) {
                if (objectToToggleSelectionOn.type === SelectionFilter.FACE) {
                    objectToToggleSelectionOn.material = CADmaterials.FACE?.SELECTED ?? CADmaterials.FACE;
                } else if (objectToToggleSelectionOn.type === SelectionFilter.PLANE) {
                    objectToToggleSelectionOn.material = CADmaterials.PLANE?.SELECTED ?? CADmaterials.FACE?.SELECTED ?? objectToToggleSelectionOn.material;
                } else if (objectToToggleSelectionOn.type === SelectionFilter.EDGE) {
                    objectToToggleSelectionOn.material = CADmaterials.EDGE?.SELECTED ?? CADmaterials.EDGE;
                } else if (objectToToggleSelectionOn.type === SelectionFilter.VERTEX) {
                    // Vertex visuals are handled by its selected accessor (point + sphere)
                } else if (objectToToggleSelectionOn.type === SelectionFilter.SOLID || objectToToggleSelectionOn.type === SelectionFilter.COMPONENT) {
                    parentSelectedAction = true;
                    objectToToggleSelectionOn.children.forEach(child => {
                        // apply selected material based on object type for faces and edges
                        if (child.type === SelectionFilter.FACE) child.material = CADmaterials.FACE?.SELECTED ?? CADmaterials.FACE;
                        if (child.type === SelectionFilter.PLANE) child.material = CADmaterials.PLANE?.SELECTED ?? CADmaterials.FACE?.SELECTED ?? child.material;
                        if (child.type === SelectionFilter.EDGE) child.material = CADmaterials.EDGE?.SELECTED ?? CADmaterials.EDGE;
                    });
                }

            } else {
                if (objectToToggleSelectionOn.type === SelectionFilter.FACE) {
                    objectToToggleSelectionOn.material = SelectionFilter.#getBaseMaterial(objectToToggleSelectionOn) ?? objectToToggleSelectionOn.material;
                } else if (objectToToggleSelectionOn.type === SelectionFilter.PLANE) {
                    objectToToggleSelectionOn.material = SelectionFilter.#getBaseMaterial(objectToToggleSelectionOn) ?? objectToToggleSelectionOn.material;
                } else if (objectToToggleSelectionOn.type === SelectionFilter.EDGE) {
                    objectToToggleSelectionOn.material = SelectionFilter.#getBaseMaterial(objectToToggleSelectionOn) ?? objectToToggleSelectionOn.material;
                } else if (objectToToggleSelectionOn.type === SelectionFilter.VERTEX) {
                    // Vertex accessor handles its own visual reset
                } else if (objectToToggleSelectionOn.type === SelectionFilter.SOLID || objectToToggleSelectionOn.type === SelectionFilter.COMPONENT) {
                    parentSelectedAction = true;
                    objectToToggleSelectionOn.children.forEach(child => {
                        // apply selected material based on object type for faces and edges
                        if (child.type === SelectionFilter.FACE) child.material = child.selected ? CADmaterials.FACE?.SELECTED ?? CADmaterials.FACE : (SelectionFilter.#getBaseMaterial(child) ?? child.material);
                        if (child.type === SelectionFilter.PLANE) child.material = child.selected ? (CADmaterials.PLANE?.SELECTED ?? CADmaterials.FACE?.SELECTED ?? child.material) : (SelectionFilter.#getBaseMaterial(child) ?? child.material);
                        if (child.type === SelectionFilter.EDGE) child.material = child.selected ? CADmaterials.EDGE?.SELECTED ?? CADmaterials.EDGE : (SelectionFilter.#getBaseMaterial(child) ?? child.material);
                    });
                }
            }
            SelectionFilter._emitSelectionChanged();
        }

        return parentSelectedAction;
    }

    static unselectAll(scene) {
        // itterate over all children and nested children of the scene and set the .selected atribute to false. 
        scene.traverse((child) => {
            child.selected = false;
            // reset material to base
            if (child.type === SelectionFilter.FACE) {
                child.material = SelectionFilter.#getBaseMaterial(child) ?? child.material;
            } else if (child.type === SelectionFilter.PLANE) {
                child.material = SelectionFilter.#getBaseMaterial(child) ?? child.material;
            } else if (child.type === SelectionFilter.EDGE) {
                child.material = SelectionFilter.#getBaseMaterial(child) ?? child.material;
            }

        });
        SelectionFilter._emitSelectionChanged();
    }

    static selectItem(scene, itemName) {
        scene.traverse((child) => {
            if (child instanceof THREE.Mesh && child.name === itemName) {
                child.selected = true;
                // change material to selected
                if (child.type === SelectionFilter.FACE) {
                    child.material = CADmaterials.FACE?.SELECTED ?? CADmaterials.FACE;
                } else if (child.type === SelectionFilter.PLANE) {
                    child.material = CADmaterials.PLANE?.SELECTED ?? CADmaterials.FACE?.SELECTED ?? child.material;
                } else if (child.type === SelectionFilter.EDGE) {
                    child.material = CADmaterials.EDGE?.SELECTED ?? CADmaterials.EDGE;
                } else if (child.type === SelectionFilter.SOLID || child.type === SelectionFilter.COMPONENT) {
                    child.material = CADmaterials.SOLID?.SELECTED ?? CADmaterials.SOLID;
                }
            }
        });
        SelectionFilter._emitSelectionChanged();
    }

    static deselectItem(scene, itemName) {
        // Traverse scene and deselect a single item by name, updating materials appropriately
        scene.traverse((child) => {
            if (child.name === itemName) {
                child.selected = false;
                if (child.type === SelectionFilter.FACE) {
                    child.material = SelectionFilter.#getBaseMaterial(child) ?? child.material;
                } else if (child.type === SelectionFilter.PLANE) {
                    child.material = SelectionFilter.#getBaseMaterial(child) ?? child.material;
                } else if (child.type === SelectionFilter.EDGE) {
                    child.material = SelectionFilter.#getBaseMaterial(child) ?? child.material;
                } else if (child.type === SelectionFilter.SOLID || child.type === SelectionFilter.COMPONENT) {
                    // For solids, keep children materials consistent with their own selected flags
                    child.children.forEach(grandchild => {
                        if (grandchild.type === SelectionFilter.FACE) {
                            grandchild.material = grandchild.selected ? (CADmaterials.FACE?.SELECTED ?? CADmaterials.FACE) : (SelectionFilter.#getBaseMaterial(grandchild) ?? grandchild.material);
                        }
                        if (grandchild.type === SelectionFilter.PLANE) {
                            grandchild.material = grandchild.selected ? (CADmaterials.PLANE?.SELECTED ?? CADmaterials.FACE?.SELECTED ?? grandchild.material) : (SelectionFilter.#getBaseMaterial(grandchild) ?? grandchild.material);
                        }
                        if (grandchild.type === SelectionFilter.EDGE) {
                            grandchild.material = grandchild.selected ? (CADmaterials.EDGE?.SELECTED ?? CADmaterials.EDGE) : (SelectionFilter.#getBaseMaterial(grandchild) ?? grandchild.material);
                        }
                    });
                }
            }
        });
        SelectionFilter._emitSelectionChanged();
    }

    static set uiCallback(callback) { SelectionFilter._uiCallback = callback; }
    static triggerUI() { if (SelectionFilter._uiCallback) SelectionFilter._uiCallback(); }

    // Emit a global event so UI can react without polling
    static _emitSelectionChanged() {
        try {
            const ev = new CustomEvent('selection-changed');
            window.dispatchEvent(ev);
        } catch (_) { /* noop */ }
    }

    static #logAllowedTypesChange(next, reason = '') {
        try {
            const desc = next === SelectionFilter.ALL
                ? 'ALL'
                : JSON.stringify(Array.from(next || []));
            const prefix = reason ? `[SelectionFilter:${reason}]` : '[SelectionFilter]';
            console.log(`${prefix} Allowed types -> ${desc}`);
        } catch { /* ignore logging errors */ }
    }
}
