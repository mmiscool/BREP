// ES6, no frameworks. Dark-mode UI. Full class, ready to paste.
// Tree UI for Solid → Face/Edge/Loop with per-object (non-recursive) visibility + selection sync.
import { SelectionFilter } from './SelectionFilter.js';

export class SceneListing {
    /**
     * @param {THREE.Scene} scene
     * @param {{autoStart?: boolean, onSelection?: (obj: any) => void}} [options]
     */
    constructor(scene, { autoStart = true, onSelection = null } = {}) {
        if (!scene) throw new Error("SceneListing requires a THREE.Scene.");
        this.scene = scene;
        this._onSelection = (typeof onSelection === 'function') ? onSelection : null;

        // --- UI root ----------------------------------------------------------------
        this.uiElement = document.createElement("div");
        this.uiElement.className = "scene-tree";
        this.uiElement.setAttribute("role", "region");
        this.uiElement.setAttribute("aria-label", "Scene");

        // Toolbar (minimal)
        this.toolbar = document.createElement("div");
        this.toolbar.className = "scene-tree__toolbar";
        this.uiElement.appendChild(this.toolbar);

        this.#attachTypeVisibilityButtons();

        // Tree container
        this.treeRoot = document.createElement("ul");
        this.treeRoot.className = "scene-tree__list";
        this.uiElement.appendChild(this.treeRoot);

        this.#ensureStyles();

        // --- State ------------------------------------------------------------------
        /** @type {Map<string, {obj: any, li: HTMLLIElement, chk: HTMLInputElement, nameEl: HTMLButtonElement, childrenUL?: HTMLUListElement, lastSelected?: boolean}>} */
        this.nodes = new Map();
        // Remember per-solid expand/collapse state across scene rebuilds (keyed by solid name)
        this._expandedByName = new Map(); // name -> boolean
        this._running = false;
        this._raf = 0;

        // Wire toolbar
        // this.toolbar.querySelector(".st-expand").addEventListener("click", () => this.#setAllOpen(true));
        // this.toolbar.querySelector(".st-collapse").addEventListener("click", () => this.#setAllOpen(false));

        // Initial build
        this.refresh();
        if (autoStart) this.start();
    }



    setScene(scene) {
        if (!scene) throw new Error("setScene(scene) requires a THREE.Scene.");
        this.stop();
        this.scene = scene;
        this.clear();
        this.refresh();
        this.start();
    }

    refresh() {
        // Rebuild membership (solids and children)
        this.#syncMembership();
        // Then ensure attributes (visibility / selection) reflect scene
        this.#syncAttributes();
    }

    start() {
        if (this._running) return;
        this._running = true;
        const tick = () => {
            if (!this._running) return;
            this.#syncMembership();
            this.#syncAttributes();
            this._raf = requestAnimationFrame(tick);
        };
        this._raf = requestAnimationFrame(tick);
    }

    stop() {
        this._running = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
    }

    // Helpers ------------------------------------------------------------------

    clear() {
        this.nodes.clear();
        this.treeRoot.innerHTML = "";
    }

    dispose() {
        this.stop();
        this.clear();
        this.uiElement.remove();
    }

    // Internal -----------------------------------------------------------------

    #isSolid(obj) {
        // Treat SOLID, COMPONENT, SKETCH, DATUM, and HELIX groups as top-level items in the tree
        return obj && obj.isObject3D && (obj.type === "SOLID" || obj.type === "COMPONENT" || obj.type === "SKETCH" || obj.type === "DATUM" || obj.type === "HELIX");
    }
    #isFace(obj) { return obj && obj.type === "FACE"; }
    #isEdge(obj) { return obj && obj.type === "EDGE"; }
    #isLoop(obj) { return obj && obj.type === "LOOP"; }
    #isVertex(obj) { return obj && obj.type === "VERTEX"; }
    #isPlane(obj) { return obj && obj.type === "PLANE"; }

    #syncMembership() {
        const present = new Set();

        // Find solids at any depth (simple stack)
        const stack = [...this.scene.children];
        while (stack.length) {
            const o = stack.pop();
            if (!o || !o.isObject3D) continue;
            if (this.#isSolid(o)) {
                const parentSolid = (o.parent && this.#isSolid(o.parent)) ? o.parent : null;
                // Ensure node for Solid (or component) with awareness of parent containers
                this.#ensureNodeFor(o, parentSolid);
                // Ensure children nodes for faces/edges/loops/vertices/planes (direct children of Solid/Sketch/Datum)
                for (const child of o.children) {
                    if (this.#isFace(child) || this.#isEdge(child) || this.#isLoop(child) || this.#isVertex(child) || this.#isPlane(child)) {
                        this.#ensureNodeFor(child, o);
                    }
                }
            }
            // continue traversal
            if (o.children && o.children.length) stack.push(...o.children);
        }

        // Track present uuids
        for (const [uuid, info] of this.nodes) {
            if (info.obj && info.obj.parent) present.add(uuid);
        }

        // Remove nodes whose objects are gone
        for (const [uuid, info] of [...this.nodes]) {
            if (!present.has(uuid)) this.#removeNode(uuid);
        }
    }

    #ensureNodeFor(obj, parentSolid /* may be null for Solid itself */) {
        if (this.nodes.has(obj.uuid)) return this.nodes.get(obj.uuid);

        // Parent UL: solids go at root; others under their owning solid node
        let parentUL = this.treeRoot;
        if (parentSolid) {
            const pInfo = this.nodes.get(parentSolid.uuid) || this.#ensureNodeFor(parentSolid, null);
            if (!pInfo.childrenUL) {
                pInfo.childrenUL = document.createElement("ul");
                pInfo.childrenUL.className = "scene-tree__list scene-tree__list--child";
                pInfo.li.appendChild(pInfo.childrenUL);
                pInfo.li.classList.add("is-parent");
            }
            parentUL = pInfo.childrenUL;
        }

        const li = document.createElement("li");
        li.className = "scene-tree__item";
        li.dataset.uuid = obj.uuid;

        // Row content: [▸][☑][name (button)]
        const row = document.createElement("div");
        row.className = "scene-tree__row";

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "st-caret";
        toggle.title = "Expand/Collapse";
        toggle.textContent = "▸";
        // Solids/components can expand; leaves don't show caret
        if (this.#isSolid(obj)) {
            toggle.addEventListener("click", (e) => {
                e.stopPropagation();
                const open = !li.classList.contains("open");
                this.#setOpen(li, open);
            });
        } else {
            toggle.classList.add("is-leaf");
            toggle.disabled = true;
            toggle.textContent = "•";
            toggle.title = "";
        }

        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.className = "st-chk";
        chk.title = "Toggle visibility";

        const nameBtn = document.createElement("button");
        nameBtn.type = "button";
        nameBtn.className = "st-name";
        nameBtn.textContent = this.#labelFor(obj);
        nameBtn.title = nameBtn.textContent;

        // Visibility: checkbox -> set ONLY this object's visibility (no recursion)
        chk.addEventListener("change", (e) => {
            const on = chk.checked;
            if (typeof obj.visible !== "undefined") obj.visible = on;
            // Immediate reflect
            this.#syncAttributes();
            e.stopPropagation();
        });

        // Selection: name click -> recursive toggle selection (unchanged)
        nameBtn.addEventListener("click", (e) => {
            // If any descendant (including self) is not selected, select all; otherwise deselect all.
            const anyUnselected = this.#anyRecursive(obj, n => !!n.selected === false);
            const target = anyUnselected ? true : false;
            //this.#setSelectedRecursive(obj, target);
            this.#syncAttributes();

            try { obj.onClick(); } catch { }
            this.#notifySelection(obj);
            // Scroll highlight
            //li.scrollIntoView({ behavior: "smooth", block: "nearest" });
            e.stopPropagation();
        });

        // Hover highlight respecting selection filter
        nameBtn.addEventListener('mouseenter', () => {
            try { SelectionFilter.setHoverByName(this.scene, obj.name); } catch (_) { }
        });
        nameBtn.addEventListener('mouseleave', () => {
            try { SelectionFilter.clearHover(); } catch (_) { }
        });

        // Row assembly
        row.appendChild(toggle);
        row.appendChild(chk);
        row.appendChild(nameBtn);
        li.appendChild(row);
        parentUL.appendChild(li);

        const info = {
            obj,
            li,
            chk,
            nameEl: nameBtn,
            childrenUL: null,
            lastSelected: undefined
        };
        this.nodes.set(obj.uuid, info);

        // Initial state: solids collapsed by default; restore remembered open state by name
        if (this.#isSolid(obj)) this.#setOpen(li, this.#wantOpen(obj));
        this.#applyTypeClass(li, obj);
        return info;
    }

    #removeNode(uuid) {
        const info = this.nodes.get(uuid);
        if (!info) return;
        info.li.remove();
        this.nodes.delete(uuid);
    }

    #syncAttributes() {
        // Reflect plain per-object visibility & selection back into UI
        for (const info of this.nodes.values()) {
            const obj = info.obj;

            // Checkbox: reflect ONLY obj.visible
            const desiredChecked = !!obj.visible;
            if (info.chk.checked !== desiredChecked) info.chk.checked = desiredChecked;
            if (info.chk.indeterminate) info.chk.indeterminate = false;

            // Selection highlight
            const sel = !!obj.selected;
            if (sel !== info.lastSelected) {
                info.lastSelected = sel;
                info.li.classList.toggle("is-selected", sel);
            }

            // Keep label fresh (names may change externally)
            const wantLabel = this.#labelFor(obj);
            if (info.nameEl.textContent !== wantLabel) {
                info.nameEl.textContent = wantLabel;
                info.nameEl.title = wantLabel;
            }
        }
    }

    // ---- Actions --------------------------------------------------------------

    #setSelectedRecursive(obj, sel) {
        if ("selected" in obj) {
            try { obj.selected = sel; } catch (_) { }
        }
        if (obj.children && obj.children.length) {
            for (const c of obj.children) this.#setSelectedRecursive(c, sel);
        }
    }

    #anyRecursive(obj, predicate) {
        if (predicate(obj)) return true;
        if (obj.children) {
            for (const c of obj.children) if (this.#anyRecursive(c, predicate)) return true;
        }
        return false;
    }

    // ---- UI helpers -----------------------------------------------------------

    #attachTypeVisibilityButtons() {
        const makeTypeButton = (label, title, predicate) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "st-btn st-btn--type";
            btn.textContent = label;
            btn.title = title;
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.#toggleVisibility(predicate);
            });
            return btn;
        };

        const isFace = (obj) => this.#isFace(obj);
        const isEdge = (obj) => this.#isEdge(obj);
        const isVertex = (obj) => this.#isVertex(obj);

        this.toolbar.appendChild(makeTypeButton("Face", "Toggle visibility of all Faces", isFace));
        this.toolbar.appendChild(makeTypeButton("Edge", "Toggle visibility of all Edges", isEdge));
        this.toolbar.appendChild(makeTypeButton("Point", "Toggle visibility of all Points", isVertex));
    }

    #toggleVisibility(predicate) {
        // Decide target: if any matching obj is visible, hide all; otherwise show all.
        let anyVisible = false;
        for (const info of this.nodes.values()) {
            const obj = info.obj;
            if (predicate(obj) && obj && obj.visible !== false) {
                anyVisible = true;
                break;
            }
        }
        const target = !anyVisible;
        for (const info of this.nodes.values()) {
            const obj = info.obj;
            if (predicate(obj) && obj) {
                if (typeof obj.visible !== "undefined") obj.visible = target;
            }
        }
        this.#syncAttributes();
    }

    #labelFor(obj) {
        const base =
            this.#isSolid(obj) ? (obj.name || "Solid") :
                this.#isFace(obj) ? (obj.name || "Face") :
                    this.#isEdge(obj) ? (obj.name || "Edge") :
                        this.#isLoop(obj) ? (obj.name || "Loop") :
                            this.#isVertex(obj) ? (obj.name || "Vertex") :
                            (obj.name || obj.type || "Item");
        return base;
    }

    #notifySelection(obj) {
        if (!this._onSelection) return;
        try { this._onSelection(obj); } catch { }
    }

    #applyTypeClass(li, obj) {
        if (this.#isSolid(obj)) li.classList.add("t-solid");
        else if (this.#isFace(obj)) li.classList.add("t-face");
        else if (this.#isEdge(obj)) li.classList.add("t-edge");
        else if (this.#isLoop(obj)) li.classList.add("t-loop");
        else if (this.#isVertex(obj)) li.classList.add("t-vertex");
        else if (this.#isPlane(obj)) li.classList.add("t-plane");
    }

    #setOpen(li, open) {
        if (!li) return;
        const caret = li.querySelector(".st-caret");
        if (open) {
            li.classList.add("open");
            if (caret) caret.textContent = "▾";
        } else {
            li.classList.remove("open");
            if (caret) caret.textContent = "▸";
        }
        // Persist state for solids by name
        try {
            const uuid = li?.dataset?.uuid;
            const info = uuid ? this.nodes.get(uuid) : null;
            const obj = info ? info.obj : null;
            if (obj && this.#isSolid(obj)) {
                const key = (obj.name && String(obj.name).length) ? String(obj.name) : null;
                if (key) this._expandedByName.set(key, !!open);
            }
        } catch (_) { }
    }

    #setAllOpen(open) {
        for (const info of this.nodes.values()) {
            if (this.#isSolid(info.obj)) this.#setOpen(info.li, open);
        }
    }

    // Remembered open state for solids (by name), default collapsed when unknown/unnamed
    #wantOpen(obj) {
        try {
            if (!obj || !this.#isSolid(obj)) return false;
            const key = (obj.name && String(obj.name).length) ? String(obj.name) : null;
            if (!key) return false;
            return !!this._expandedByName.get(key);
        } catch (_) {
            return false;
        }
    }

    #ensureStyles() {
        const ID = "scene-tree-styles";
        if (document.getElementById(ID)) return;
        const style = document.createElement("style");
        style.id = ID;
        style.textContent = `
/* Dark, minimalist tree for CAD scene - Expand/Collapse fix included */
.scene-tree{
  color-scheme: dark;
  --bg:#0a0f14;
  --row:#0e141b;
  --row2:#0b1016;
  --hover:#111826;
  --sel:#1e2a3a;
  --muted:#8b98a9;
  --fg:#e6edf3;
  --accent:#4aa3ff;
  --border:#17202b;
  background:var(--bg);
  color:var(--fg);
  border:1px solid var(--border);
  border-radius:12px;
  padding:3px;
  overflow:auto;
}
.scene-tree__toolbar{
  display:flex; gap:6px; margin-bottom:6px; flex-wrap:wrap;
}
.st-btn{
  background:#0f1722; color:var(--fg); border:1px solid var(--border);
  padding:4px; border-radius:8px; cursor:pointer;
}
.st-btn--type{
  font-size:11px;
  padding:2px 8px;
}
.st-btn:hover{ background:var(--hover); }
.scene-tree__list{
  list-style:none; margin:0; padding:0;
}
.scene-tree__item{
  border-bottom:1px solid #0f1620;
}
.scene-tree__row{
  display:flex; align-items:center; gap:2px; padding:2px 2px; background:var(--row);
}
.scene-tree__item:nth-child(even) > .scene-tree__row{ background:var(--row2); }
.scene-tree__item.is-selected > .scene-tree__row{
  background: var(--sel);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.scene-tree__item.is-parent.open > .scene-tree__row{ border-bottom:1px solid #111a26; }
.st-caret{
  width:20px; height:20px; border:0; background:transparent; color:var(--muted);
  cursor:pointer; line-height:1; padding:0;
}
.st-caret.is-leaf{ opacity:.35; cursor:default; }
.st-chk{
  width:14px; height:14px; accent-color: var(--accent);
  cursor:pointer;
}
.st-name{
  background:transparent; border:0; color:var(--fg); cursor:pointer; padding:0;
  font:inherit; text-align:left;
  width: 100%;
}
.st-name:hover{ text-decoration: underline; }
.scene-tree__list--child{
  margin:0; padding-left:24px;
}

/* ▼▼ Expand/Collapse behavior (fix): hide child UL when parent isn't open */
.scene-tree__item.is-parent > .scene-tree__list--child { display: none; }
.scene-tree__item.is-parent.open > .scene-tree__list--child { display: block; }
/* ▲▲ */

/* Type tint (subtle) */
.t-face  .st-name{ color:#c7e0ff; }
.t-edge  .st-name{ color:#bfe4d0; }
.t-loop  .st-name{ color:#e7ced6; }
.t-vertex .st-name{ color:#ffe6a6; }
.t-plane .st-name{ color:#c7ffcf; }

`;
        document.head.appendChild(style);
    }
}
