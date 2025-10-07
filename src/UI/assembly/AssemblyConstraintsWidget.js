import * as THREE from 'three';
import { genFeatureUI } from '../featureDialogs.js';
import { SelectionFilter } from '../SelectionFilter.js';
import { objectRepresentativePoint } from '../pmi/annUtils.js';

const ROOT_CLASS = 'constraints-history';

export class AssemblyConstraintsWidget {
  constructor(viewer) {
    this.viewer = viewer || null;
    this.partHistory = viewer?.partHistory || null;
    this.registry = this.partHistory?.assemblyConstraintRegistry || null;
    this.history = this.partHistory?.assemblyConstraintHistory || null;
    if (this.history) this.history.setPartHistory?.(this.partHistory);

    this._forms = new Map();
    this._highlighted = new Map();
    this._highlightPalette = ['#ff3b30', '#30d158', '#0a84ff', '#ffd60a'];

    this._defaultIterations = 100;
    this._normalArrows = new Set();
    this._debugNormalsEnabled = false;
    this._delayInput = null;

    this.uiElement = document.createElement('div');
    this.uiElement.className = ROOT_CLASS;

    this._solverControls = this._buildSolverControls();
    this.uiElement.appendChild(this._solverControls);

    this._delayControls = this._buildDelayControls();
    this.uiElement.appendChild(this._delayControls);

    this._debugControls = this._buildDebugControls();
    this.uiElement.appendChild(this._debugControls);

    this._accordion = document.createElement('div');
    this._accordion.className = 'accordion';
    this.uiElement.appendChild(this._accordion);

    this._footer = this._buildAddConstraintFooter();
    this.uiElement.appendChild(this._footer);

    this._unsubscribe = this.history?.onChange(() => this.render()) || null;

    this._onGlobalClick = (ev) => {
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      if (!path.includes(this._footer)) this._toggleAddMenu(false);
    };
    document.addEventListener('mousedown', this._onGlobalClick, true);

    this.render();
  }

  dispose() {
    this._clearHighlights();
    if (this._unsubscribe) {
      try { this._unsubscribe(); } catch { /* ignore */ }
      this._unsubscribe = null;
    }
    document.removeEventListener('mousedown', this._onGlobalClick, true);
    this._iterationInput = null;
    this._solveButton = null;
    for (const form of this._forms.values()) {
      try { form?.destroy?.(); } catch { /* ignore */ }
    }
    this._forms.clear();
  }

  render() {
    this._toggleAddMenu(false);
    this._clearHighlights();
    for (const form of this._forms.values()) {
      try { form?.destroy?.(); } catch { /* ignore */ }
    }
    this._forms.clear();
    this._accordion.textContent = '';

    const entries = this.history ? this.history.list() : [];
    if (!entries || entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No assembly constraints yet.';
      this._accordion.appendChild(empty);
      return;
    }

    entries.forEach((entry, index) => {
      const constraintID = entry?.inputParams?.constraintID || `constraint-${index}`;
      const isOpen = entry.__open !== false;
      const ConstraintClass = this._resolveConstraintClass(entry);
      const schema = ConstraintClass?.inputParamsSchema ? { ...ConstraintClass.inputParamsSchema } : {};
      if (entry?.inputParams) entry.inputParams.applyImmediately = true;
      const titleText = entry?.inputParams?.label || ConstraintClass?.constraintName || constraintID;
      const statusInfo = this.#statusText(entry);

      const item = document.createElement('div');
      item.className = 'acc-item';
      if (isOpen) item.classList.add('open');
      if (statusInfo.error) item.classList.add('has-error');

      const headerRow = document.createElement('div');
      headerRow.className = 'acc-header-row';
      item.appendChild(headerRow);

      const headerBtn = document.createElement('button');
      headerBtn.type = 'button';
      headerBtn.className = 'acc-header';
      headerBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      headerBtn.addEventListener('click', () => {
        const next = !isOpen;
        this.history?.setOpenState(constraintID, next);
      });

      const title = document.createElement('span');
      title.className = 'acc-title';
      title.textContent = titleText;
      headerBtn.appendChild(title);

      const status = document.createElement('span');
      status.className = 'acc-status';
      status.textContent = statusInfo.label;
      if (statusInfo.title) status.title = statusInfo.title;
      else status.removeAttribute('title');
      headerBtn.appendChild(status);

      headerRow.appendChild(headerBtn);

      const actions = document.createElement('div');
      actions.className = 'acc-actions';
      headerRow.appendChild(actions);

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'icon-btn';
      upBtn.textContent = '▲';
      upBtn.title = 'Move up';
      upBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.history?.moveConstraint(constraintID, -1);
      });
      actions.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'icon-btn';
      downBtn.textContent = '▼';
      downBtn.title = 'Move down';
      downBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.history?.moveConstraint(constraintID, 1);
      });
      actions.appendChild(downBtn);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'icon-btn danger';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove constraint';
      removeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.history?.removeConstraint(constraintID);
      });
      actions.appendChild(removeBtn);

      const content = document.createElement('div');
      content.className = 'acc-content';
      content.hidden = !isOpen;
      item.appendChild(content);

      if (isOpen) {
        const body = document.createElement('div');
        body.className = 'acc-body';
        content.appendChild(body);

        const form = new genFeatureUI(schema, entry.inputParams, {
          viewer: this.viewer,
          partHistory: this.partHistory,
          scene: this.viewer?.scene || null,
          featureRef: entry,
          excludeKeys: ['constraintID', 'applyImmediately'],
          onChange: (_featureId, details) => {
            const id = entry.inputParams?.constraintID;
            if (!id) return;
            this.history?.updateConstraintParams(id, (params) => {
              if (details && details.key && Object.prototype.hasOwnProperty.call(details, 'value')) {
                params[details.key] = details.value;
              }
            });
          },
          onReferenceChipRemove: (name) => {
            try { SelectionFilter.deselectItem?.(this.viewer?.scene, name); }
            catch { /* ignore */ }
          },
        });
        body.appendChild(form.uiElement);

        const actionsWrap = document.createElement('div');
        actionsWrap.className = 'constraint-dialog-actions';

        const highlightBtn = document.createElement('button');
        highlightBtn.type = 'button';
        highlightBtn.className = 'btn highlight-btn';
        highlightBtn.textContent = 'Highlight Selection';
        highlightBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this._highlightConstraint(entry, ConstraintClass);
        });
        actionsWrap.appendChild(highlightBtn);

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'btn';
        clearBtn.textContent = 'Clear Highlight';
        clearBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this._clearHighlights();
        });
        actionsWrap.appendChild(clearBtn);

        body.appendChild(actionsWrap);

        this._forms.set(constraintID, form);
      }

      this._accordion.appendChild(item);
    });
  }

  async _handleSolve() {
    if (!this.history) return;

    let iterations = Number(this._iterationInput?.value ?? this._defaultIterations ?? 1);
    if (!Number.isFinite(iterations) || iterations < 1) iterations = 1;
    iterations = Math.floor(iterations);
    if (this._iterationInput) this._iterationInput.value = String(iterations);

    const button = this._solveButton;
    if (button) button.disabled = true;
    try {
      await this.history.runAll(this.partHistory, {
        iterations,
        viewer: this.viewer || null,
        debugMode: !!this._debugNormalsEnabled,
        iterationDelayMs: this._debugNormalsEnabled ? 500 : 0,
      });
    } catch (error) {
      console.warn('[AssemblyConstraintsWidget] Solve failed:', error);
    } finally {
      if (button) button.disabled = false;
    }
  }

  _buildSolverControls() {
    const wrap = document.createElement('div');
    wrap.className = 'solver-controls';

    const label = document.createElement('label');
    label.className = 'solver-iterations';

    const labelText = document.createElement('span');
    labelText.className = 'solver-iterations-label';
    labelText.textContent = 'Iterations';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.inputMode = 'numeric';
    input.value = String(this._defaultIterations);
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 1) {
        input.value = String(this._defaultIterations);
      }
    });

    label.appendChild(labelText);
    label.appendChild(input);

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'btn solver-run-btn';
    runBtn.textContent = 'Solve';
    runBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._handleSolve();
    });

    wrap.appendChild(label);
    wrap.appendChild(runBtn);

    this._iterationInput = input;
    this._solveButton = runBtn;

    return wrap;
  }

  _buildDelayControls() {
    const wrap = document.createElement('div');
    wrap.className = 'delay-controls';

    const label = document.createElement('label');
    label.className = 'delay-iterations';

    const span = document.createElement('span');
    span.className = 'solver-iterations-label';
    span.textContent = 'Delay (ms)';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '50';
    input.inputMode = 'numeric';
    input.value = '500';
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) {
        input.value = '0';
      }
    });

    label.appendChild(span);
    label.appendChild(input);
    wrap.appendChild(label);

    this._delayInput = input;

    return wrap;
  }

  _buildDebugControls() {
    const wrap = document.createElement('div');
    wrap.className = 'debug-controls';

    const label = document.createElement('label');
    label.className = 'debug-toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      this._debugNormalsEnabled = checkbox.checked;
      if (!this._debugNormalsEnabled) {
        this._clearNormalArrows();
        try { this.viewer?.render?.(); } catch {}
      }
    });

    const span = document.createElement('span');
    span.textContent = 'Debug Normals';

    label.appendChild(checkbox);
    label.appendChild(span);
    wrap.appendChild(label);

    this._debugCheckbox = checkbox;

    return wrap;
  }

  _clearHighlights() {
    this._clearNormalArrows();
    for (const record of this._highlighted.values()) {
      try {
        if (record.replaced && record.originalMaterial) {
          record.object.material = record.originalMaterial;
        } else if (record.previousColor && record.object.material?.color) {
          record.object.material.color.copy(record.previousColor);
        }
      } catch { /* ignore */ }
    }
    this._highlighted.clear();
    this._clearNormalArrows();
    try { SelectionFilter.clearHover?.(); } catch { /* ignore */ }
    try { this.viewer?.render?.(); } catch { /* ignore */ }
  }

  _highlightConstraint(entry, ConstraintClass) {
    this._clearHighlights();
    const scene = this.viewer?.scene || null;
    if (!scene || !entry?.inputParams) return;

    const schema = ConstraintClass?.inputParamsSchema || {};
    const refFields = Object.entries(schema).filter(([, def]) => def?.type === 'reference_selection');

    let colorIndex = 0;
    for (const [key] of refFields) {
      const color = this._highlightPalette[colorIndex % this._highlightPalette.length];
      colorIndex += 1;
      const targets = this._resolveReferenceObjects(entry.inputParams[key]);
      for (const obj of targets) {
        this._applyHighlightMaterial(obj, color);
        if (this._isFaceObject(obj)) {
          this._createNormalArrow(obj, color, `${entry?.inputParams?.constraintID || 'constraint'}:${key}`);
        }
      }
    }

    if (this._highlighted.size === 0) {
      console.warn('[AssemblyConstraintsWidget] No reference objects could be highlighted for constraint:', entry?.inputParams?.constraintID);
    }

    if (this._normalArrows.size === 0) {
      console.warn('[AssemblyConstraintsWidget] No face normals could be visualized for constraint:', entry?.inputParams?.constraintID);
    }

    try { this.viewer?.render?.(); } catch { /* ignore */ }
  }

  _isFaceObject(object) {
    if (!object) return false;
    const type = object.userData?.type || object.userData?.brepType || object.type;
    return String(type).toUpperCase() === 'FACE';
  }

  _resolveReferenceObjects(value) {
    const scene = this.viewer?.scene || null;
    if (!scene) return [];
    const results = [];
    const values = Array.isArray(value) ? value : (value ? [value] : []);
    for (const item of values) {
      if (!item) continue;
      if (item.isObject3D) {
        results.push(item);
        continue;
      }
      const name = typeof item === 'string'
        ? item
        : (typeof item?.name === 'string' ? item.name : null);
      if (name) {
        const found = this._findObjectByName(scene, name);
        if (found) results.push(found);
      }
    }
    return results;
  }

  _findObjectByName(scene, name) {
    if (!scene || typeof scene.traverse !== 'function') return scene?.getObjectByName?.(name) || null;
    let best = null;
    scene.traverse((obj) => {
      if (!obj || obj.name !== name) return;
      if (!best) {
        best = obj;
        return;
      }
      const currentScore = this._scoreObjectForNormal(best);
      const newScore = this._scoreObjectForNormal(obj);
      if (newScore > currentScore) best = obj;
    });
    if (best) return best;
    if (typeof scene.getObjectByName === 'function') return scene.getObjectByName(name);
    return null;
  }

  _scoreObjectForNormal(object) {
    if (!object) return -Infinity;
    const type = object.userData?.type || object.userData?.brepType || object.type;
    if (String(type).toUpperCase() === 'FACE') return 3;
    if (object.geometry) return 2;
    return 1;
  }

  _applyHighlightMaterial(object, color) {
    if (!object || !color) return;

    const targets = [];
    object.traverse?.((child) => {
      if (!child || !child.isObject3D) return;
      if (child.material && child.material.color) targets.push(child);
    });
    if (targets.length === 0 && object.material && object.material.color) {
      targets.push(object);
    }

    for (const target of targets) {
      const key = target.uuid;
      if (this._highlighted.has(key)) continue;

      const originalMaterial = target.material;
      let replaced = false;
      let highlightMaterial = originalMaterial;
      if (originalMaterial && typeof originalMaterial.clone === 'function') {
        try {
          const clone = originalMaterial.clone();
          if (clone) {
            highlightMaterial = clone;
            replaced = clone !== originalMaterial;
          }
        } catch { /* ignore */ }
      }

      const previousColor = (!replaced && highlightMaterial?.color && highlightMaterial.color.clone)
        ? highlightMaterial.color.clone()
        : null;

      try { highlightMaterial?.color?.set(color); } catch { /* ignore */ }

      if (replaced) {
        target.material = highlightMaterial;
      }

      this._highlighted.set(key, {
        object: target,
        replaced,
        originalMaterial,
        previousColor,
      });
    }
  }

  _clearNormalArrows() {
    const scene = this.viewer?.scene || null;
    if (!scene || !this._normalArrows) return;
    for (const arrow of this._normalArrows) {
      try { arrow?.parent?.remove?.(arrow); }
      catch {}
    }
    this._normalArrows.clear();
  }

  _createNormalArrow(object, color, label) {
    const scene = this.viewer?.scene || null;
    if (!scene || !object) return;

    const origin = this._computeFaceOrigin(object);
    const normal = this._computeFaceNormal(object);
    if (!origin || !normal) return;

    const hexColor = new THREE.Color(color).getHex();
    const length = this._estimateArrowLength(object);
    const arrow = new THREE.ArrowHelper(normal, origin, length, hexColor, length * 0.25, length * 0.15);
    arrow.name = `selection-normal-${object.uuid}-${label || 'face'}`;
    scene.add(arrow);
    this._normalArrows.add(arrow);
  }

  _computeFaceOrigin(object) {
    if (!object) return null;
    try {
      const pt = objectRepresentativePoint?.(null, object);
      if (pt && typeof pt.clone === 'function') return pt.clone();
    } catch {}
    const geom = object.geometry;
    if (geom?.computeBoundingBox) {
      try {
        geom.computeBoundingBox();
        const center = geom.boundingBox?.getCenter(new THREE.Vector3());
        if (center) {
          object.updateMatrixWorld?.(true);
          return center.applyMatrix4(object.matrixWorld);
        }
      } catch {}
    }
    if (typeof object.getWorldPosition === 'function') {
      return object.getWorldPosition(new THREE.Vector3());
    }
    return null;
  }

  _computeFaceNormal(object) {
    if (!object) return null;
    try {
      if (typeof object.getAverageNormal === 'function') {
        const avg = object.getAverageNormal();
        if (avg && avg.lengthSq() > 1e-10) return avg.clone().normalize();
      }
    } catch {}

    const geom = object.geometry;
    if (!geom?.isBufferGeometry) return null;
    const pos = geom.getAttribute?.('position');
    if (!pos || pos.itemSize !== 3 || pos.count < 3) return null;
    const index = geom.getIndex?.();

    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const accum = new THREE.Vector3();

    object.updateMatrixWorld?.(true);

    const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
    const samples = Math.min(triCount, 60);
    let count = 0;
    for (let tri = 0; tri < samples; tri += 1) {
      let i0, i1, i2;
      if (index) {
        const base = tri * 3;
        if (base + 2 >= index.count) break;
        i0 = index.getX(base);
        i1 = index.getX(base + 1);
        i2 = index.getX(base + 2);
      } else {
        i0 = tri * 3;
        i1 = i0 + 1;
        i2 = i0 + 2;
        if (i2 >= pos.count) break;
      }

      v0.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(object.matrixWorld);
      v1.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(object.matrixWorld);
      v2.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2)).applyMatrix4(object.matrixWorld);

      edge1.subVectors(v1, v0);
      edge2.subVectors(v2, v0);
      const normal = new THREE.Vector3().crossVectors(edge1, edge2);
      if (normal.lengthSq() > 1e-10) {
        accum.add(normal);
        count += 1;
      }
    }

    if (count === 0) return null;
    accum.divideScalar(count);
    if (accum.lengthSq() <= 1e-10) return null;

    return accum.normalize();
  }

  _estimateArrowLength(object) {
    const geom = object?.geometry;
    if (geom?.computeBoundingSphere) {
      try {
        geom.computeBoundingSphere();
        const radius = geom.boundingSphere?.radius;
        if (Number.isFinite(radius) && radius > 0) return Math.max(radius, 10);
      } catch {}
    }
    return 10;
  }

  _buildAddConstraintFooter() {
    const footer = document.createElement('div');
    footer.className = 'footer';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'add-btn';
    addBtn.setAttribute('aria-expanded', 'false');
    addBtn.title = 'Add assembly constraint';
    addBtn.textContent = '+';
    footer.appendChild(addBtn);

    const menu = document.createElement('div');
    menu.className = 'add-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const items = this._listAvailableConstraints();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'menu-empty';
      empty.textContent = 'No constraints registered';
      menu.appendChild(empty);
      addBtn.disabled = true;
    } else {
      items.forEach(({ label, value }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item';
        btn.setAttribute('role', 'menuitem');
        btn.textContent = label;
        btn.dataset.type = value;
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          await this._handleAddConstraint(value);
        });
        menu.appendChild(btn);
      });
    }

    footer.appendChild(menu);

    addBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const isOpen = addBtn.getAttribute('aria-expanded') === 'true';
      this._toggleAddMenu(!isOpen);
    });

    this._addBtn = addBtn;
    this._addMenu = menu;

    return footer;
  }

  _toggleAddMenu(open) {
    if (!this._addBtn || !this._addMenu) return;
    const willOpen = Boolean(open);
    this._addBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    this._addMenu.hidden = !willOpen;
    this._footer?.classList.toggle('menu-open', willOpen);
  }

  async _handleAddConstraint(type) {
    this._toggleAddMenu(false);
    if (!type) return;
    try {
      const entry = await this.history?.addConstraint(type);
      if (entry && entry.inputParams?.constraintID) {
        this.history?.setOpenState(entry.inputParams.constraintID, true);
      }
    } catch (error) {
      console.warn('[AssemblyConstraintsWidget] Failed to add constraint:', error);
    }
  }

  _listAvailableConstraints() {
    if (!this.registry || typeof this.registry.list !== 'function') return [];
    const classes = this.registry.list();
    return classes.map((ConstraintClass) => {
      const value = ConstraintClass.constraintType || ConstraintClass.constraintShortName || ConstraintClass.name;
      const label = ConstraintClass.constraintName || ConstraintClass.name || value;
      return { label, value };
    });
  }

  _resolveConstraintClass(entry) {
    if (!entry) return null;
    if (entry.constraintClass) return entry.constraintClass;
    const type = entry.type || entry.inputParams?.type;
    if (!type) return null;
    if (this.registry && typeof this.registry.getSafe === 'function') {
      const cls = this.registry.getSafe(type);
      if (cls) return cls;
    }
    if (this.registry && typeof this.registry.get === 'function') {
      try { return this.registry.get(type); }
      catch { return null; }
    }
    return null;
  }

  #statusText(entry) {
    const pd = entry?.persistentData || {};
    const status = pd.status || 'Idle';
    const out = { label: '', title: '', error: false };
    if (status === 'unimplemented') {
      out.label = 'Unimplemented';
      out.title = pd.message || 'Constraint solver not implemented yet.';
      out.error = true;
      return out;
    }
    if (status === 'satisfied') {
      out.label = 'Satisfied';
      out.title = pd.message || 'Constraint satisfied within tolerance.';
      return out;
    }
    if (status === 'adjusted') {
      out.label = 'Adjusting';
      out.title = pd.message || 'Constraint nudging components toward the solution.';
      return out;
    }
    if (status === 'blocked') {
      out.label = 'Blocked';
      out.title = pd.message || 'Constraint cannot adjust locked components.';
      out.error = true;
      return out;
    }
    if (status === 'pending') {
      out.label = 'Pending';
      out.title = pd.message || 'Constraint awaiting convergence.';
      return out;
    }
    if (status === 'error') {
      out.label = 'Error';
      out.title = pd.message || 'Constraint evaluation failed.';
      out.error = true;
      return out;
    }
    if (status === 'applied' || status === 'computed') {
      const delta = Array.isArray(pd.lastDelta)
        ? pd.lastDelta.map((v) => Number(v).toFixed(3)).join(', ')
        : null;
      out.label = status === 'applied' ? 'Applied' : 'Pending';
      if (delta) out.label += ` · Δ[${delta}]`;
      if (Array.isArray(pd.lastAppliedMoves) && pd.lastAppliedMoves.length) {
        const summary = pd.lastAppliedMoves
          .map((move) => {
            if (!move || !Array.isArray(move.move)) return null;
            const vec = move.move.map((v) => Number(v).toFixed(3)).join(', ');
            return `${move.element}: [${vec}]`;
          })
          .filter(Boolean)
          .join(' | ');
        if (summary) out.title = summary;
      }
      return out;
    }
    if (status === 'incomplete') {
      out.label = 'Incomplete';
      out.title = 'Select the required components to define the constraint.';
      return out;
    }
    if (status === 'invalid-selection') {
      out.label = 'Invalid selection';
      out.title = 'Unable to resolve world positions for selections.';
      out.error = true;
      return out;
    }
    if (status === 'pending-component') {
      out.label = 'Pending component';
      out.title = 'Offset stored but no component selected to move.';
      return out;
    }
    if (status === 'fixed') {
      out.label = 'Locked';
      out.title = pd.message || 'Both components are fixed; nothing moved.';
      return out;
    }
    if (status === 'noop') {
      out.label = 'No change';
      out.title = pd.message || 'Selections already satisfy this constraint.';
      return out;
    }
    if (status === 'apply-failed') {
      out.label = 'Failed';
      out.title = pd.error || 'Apply failed';
      out.error = true;
      return out;
    }
    if (status && status !== 'Idle') {
      out.label = status.charAt(0).toUpperCase() + status.slice(1);
      if (pd.message) out.title = pd.message;
    }
    return out;
  }
}

(() => {
  if (typeof document === 'undefined') return;
  const styleId = 'assembly-constraints-widget-styles';
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .${ROOT_CLASS} {
      --bg: #0f1117;
      --bg-elev: #12141b;
      --border: #262b36;
      --text: #e6e6e6;
      --muted: #9aa4b2;
      --accent: #6ea8fe;
      --focus: #3b82f6;
      --danger: #ef4444;
      --input-bg: #0b0e14;
      color-scheme: dark;
      color: var(--text);
      background: var(--bg-elev);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 3px;
      box-shadow: 0 6px 24px rgba(0,0,0,.35);
      max-width: 100%;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .${ROOT_CLASS} .accordion {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .${ROOT_CLASS} .debug-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px 0 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .${ROOT_CLASS} .debug-toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    .${ROOT_CLASS} .debug-toggle input {
      width: 14px;
      height: 14px;
      cursor: pointer;
    }
    .${ROOT_CLASS} .solver-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
    }
    .${ROOT_CLASS} .solver-iterations {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
      font-size: 12px;
      color: var(--muted);
    }
    .${ROOT_CLASS} .solver-iterations-label {
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .${ROOT_CLASS} .solver-iterations input {
      appearance: none;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 10px;
      background: var(--input-bg);
      color: var(--text);
      font-size: 14px;
    }
    .${ROOT_CLASS} .solver-iterations input:focus {
      outline: none;
      border-color: var(--focus);
      box-shadow: 0 0 0 3px rgba(59,130,246,.15);
    }
    .${ROOT_CLASS} .solver-run-btn {
      appearance: none;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.04);
      color: var(--text);
      border-radius: 8px;
      padding: 8px 16px;
      font-weight: 600;
      cursor: pointer;
      transition: border-color .15s ease, background-color .15s ease, transform .05s ease;
    }
    .${ROOT_CLASS} .solver-run-btn:hover {
      border-color: var(--focus);
      background: rgba(59,130,246,.15);
    }
    .${ROOT_CLASS} .solver-run-btn:active {
      transform: translateY(1px);
    }
    .${ROOT_CLASS} .solver-run-btn:disabled {
      opacity: .6;
      cursor: default;
      transform: none;
    }
    .${ROOT_CLASS} .acc-item {
      background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }
    .${ROOT_CLASS} .acc-header-row {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: stretch;
    }
    .${ROOT_CLASS} .acc-header {
      appearance: none;
      width: 100%;
      text-align: left;
      background: transparent;
      color: var(--text);
      border: 0;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }
    .${ROOT_CLASS} .acc-header:focus { outline: none; }
    .${ROOT_CLASS} .acc-title { flex: 1; color: var(--text); }
    .${ROOT_CLASS} .acc-status { color: var(--muted); font-size: 12px; line-height: 1; }
    .${ROOT_CLASS} .acc-item.has-error .acc-status {
      color: var(--danger);
      font-weight: 600;
    }
    .${ROOT_CLASS} .acc-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 8px 6px 0;
    }
    .${ROOT_CLASS} .icon-btn {
      appearance: none;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.03);
      color: var(--text);
      border-radius: 8px;
      padding: 4px 8px;
      cursor: pointer;
      transition: border-color .15s ease, background-color .15s ease, transform .05s ease;
    }
    .${ROOT_CLASS} .icon-btn:hover { border-color: var(--focus); }
    .${ROOT_CLASS} .icon-btn:active { transform: translateY(1px); }
    .${ROOT_CLASS} .icon-btn.danger:hover { border-color: var(--danger); color: #fff; background: rgba(239,68,68,.15); }
    .${ROOT_CLASS} .acc-content {
      padding: 10px 12px 12px 12px;
      border-top: 1px solid var(--border);
    }
    .${ROOT_CLASS} .acc-body { display: block; }
    .${ROOT_CLASS} .constraint-dialog-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .${ROOT_CLASS} .constraint-dialog-actions .btn {
      appearance: none;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.03);
      color: var(--text);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: border-color .15s ease, background-color .15s ease, transform .05s ease;
    }
    .${ROOT_CLASS} .constraint-dialog-actions .btn:hover { border-color: var(--focus); }
    .${ROOT_CLASS} .constraint-dialog-actions .btn:active { transform: translateY(1px); }
    .${ROOT_CLASS} .constraint-dialog-actions .highlight-btn {
      border-color: var(--accent);
      color: var(--accent);
    }
    .${ROOT_CLASS} .constraint-dialog-actions .highlight-btn:hover {
      background: rgba(110,168,254,.15);
    }
    .${ROOT_CLASS} .empty {
      padding: 12px;
      text-align: center;
      color: var(--muted);
      font-style: italic;
    }
    .${ROOT_CLASS} .footer {
      position: relative;
      margin-top: 6px;
      padding-top: 10px;
      border-top: 1px dashed var(--border);
      display: flex;
      justify-content: center;
    }
    .${ROOT_CLASS} .add-btn {
      appearance: none;
      border: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.02));
      color: var(--text);
      border-radius: 9999px;
      padding: 6px 10px;
      width: 36px;
      height: 36px;
      line-height: 24px;
      text-align: center;
      cursor: pointer;
      transition: border-color .15s ease, box-shadow .15s ease, transform .05s ease;
    }
    .${ROOT_CLASS} .add-btn:hover { border-color: var(--focus); box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
    .${ROOT_CLASS} .add-btn:active { transform: translateY(1px); }
    .${ROOT_CLASS} .add-btn:disabled { opacity: 0.5; cursor: default; box-shadow: none; }
    .${ROOT_CLASS} .add-menu {
      position: absolute;
      bottom: 48px;
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.45);
      padding: 6px;
      z-index: 6;
    }
    .${ROOT_CLASS} .menu-item {
      appearance: none;
      width: 100%;
      text-align: left;
      background: transparent;
      color: var(--text);
      border: 0;
      border-radius: 8px;
      padding: 8px 10px;
      cursor: pointer;
      transition: background-color .12s ease, color .12s ease;
    }
    .${ROOT_CLASS} .menu-item:hover {
      background: rgba(110,168,254,.12);
      color: #fff;
    }
    .${ROOT_CLASS} .menu-empty {
      padding: 10px;
      color: var(--muted);
    }
  `;
  document.head.appendChild(style);
})();
