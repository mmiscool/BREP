import * as THREE from 'three';
import { genFeatureUI } from '../featureDialogs.js';
import { SelectionFilter } from '../SelectionFilter.js';
import { objectRepresentativePoint } from '../pmi/annUtils.js';
import { LabelOverlay } from '../pmi/LabelOverlay.js';


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

    this._defaultIterations = 1000;
    this._normalArrows = new Set();
    this._debugNormalsEnabled = false;
    this._delayInput = null;
    this._constraintLines = new Map();
    this._labelPositions = new Map();
    this._onControlsChange = () => this._refreshConstraintLabels();
    this._onWindowResize = () => this._refreshConstraintLabels();
    this._constraintGraphicsEnabled = true;
    this._constraintGraphicsCheckbox = null;
    this._hoverHighlights = new Map();
    this._activeHoverConstraintId = null;

    this.uiElement = document.createElement('div');
    this.uiElement.className = ROOT_CLASS;

    if (this.viewer?.scene) {
      this._constraintGroup = new THREE.Group();
      this._constraintGroup.name = 'assembly-constraint-overlays';
      this._constraintGroup.userData.excludeFromFit = true;
      try { this.viewer.scene.add(this._constraintGroup); }
      catch { this._constraintGroup = null; }
    } else {
      this._constraintGroup = null;
    }

    if (this.viewer) {
      this._labelOverlay = new LabelOverlay(
        this.viewer,
        null,
        null,
        (idx, ann, ev) => { try { this.#handleLabelClick(idx, ann, ev); } catch {} },
      );
      try { this.viewer.controls?.addEventListener('change', this._onControlsChange); } catch {}
      try { window.addEventListener('resize', this._onWindowResize); } catch {}
    } else {
      this._labelOverlay = null;
    }

    this._controlsPanel = this._buildControlsPanel();
    this.uiElement.appendChild(this._controlsPanel);
    this._setConstraintGraphicsEnabled(this._constraintGraphicsEnabled);

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
    this._clearConstraintVisuals();
    try { this.viewer?.controls?.removeEventListener('change', this._onControlsChange); } catch {}
    try { window.removeEventListener('resize', this._onWindowResize); } catch {}
    if (this._constraintGroup && this.viewer?.scene) {
      try { this.viewer.scene.remove(this._constraintGroup); } catch {}
    }
    this._constraintGroup = null;
    this._constraintLines.clear();
    this._labelPositions.clear();
    try { this._labelOverlay?.dispose?.(); } catch {}
    this._labelOverlay = null;
    if (this._unsubscribe) {
      try { this._unsubscribe(); } catch { /* ignore */ }
      this._unsubscribe = null;
    }
    document.removeEventListener('mousedown', this._onGlobalClick, true);
    this._iterationInput = null;
    this._solveButton = null;
    this._constraintGraphicsCheckbox = null;
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
      this._clearConstraintVisuals();
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
      const titleText = entry?.inputParams?.label
        || ConstraintClass?.constraintShortName
        || ConstraintClass?.constraintName
        || constraintID;
      const statusInfo = this.#statusText(entry);

      const item = document.createElement('div');
      item.className = 'acc-item';
      item.dataset.constraintId = constraintID;
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

    this._updateConstraintVisuals(entries);
  }

  async _handleSolve() {
    if (!this.history) return;
    this.#clearConstraintDebugArrows();
    this._clearNormalArrows();

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

  _buildControlsPanel() {
    const wrap = document.createElement('div');
    wrap.className = 'constraints-control-panel';

    wrap.appendChild(this._buildSolverControls());
    wrap.appendChild(this._buildDelayControls());
    wrap.appendChild(this._buildVisualizationControls());
    wrap.appendChild(this._buildDebugControls());

    return wrap;
  }

  _buildSolverControls() {
    const wrap = document.createElement('div');
    wrap.className = 'control-panel-section solver-controls';

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
    input.style.width = '5em';
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
    wrap.className = 'control-panel-section delay-controls';

    const label = document.createElement('label');
    label.className = 'solver-iterations';

    const span = document.createElement('span');
    span.className = 'solver-iterations-label';
    span.textContent = 'Delay (ms)';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '50';
    input.inputMode = 'numeric';
    input.value = '20';
    input.style.width = '100%';
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

  _buildVisualizationControls() {
    const wrap = document.createElement('div');
    wrap.className = 'control-panel-section visualization-controls';

    const label = document.createElement('label');
    label.className = 'toggle-control';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this._constraintGraphicsEnabled;
    checkbox.addEventListener('change', () => {
      this._setConstraintGraphicsEnabled(checkbox.checked);
    });

    const span = document.createElement('span');
    span.textContent = 'Show Constraint Graphics';

    label.appendChild(checkbox);
    label.appendChild(span);
    wrap.appendChild(label);

    this._constraintGraphicsCheckbox = checkbox;

    return wrap;
  }

  _buildDebugControls() {
    const wrap = document.createElement('div');
    wrap.className = 'control-panel-section debug-controls';

    const label = document.createElement('label');
    label.className = 'toggle-control';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      this._debugNormalsEnabled = checkbox.checked;
      this.#clearConstraintDebugArrows();
      if (!this._debugNormalsEnabled) {
        this._clearNormalArrows();
      }
      try { this.viewer?.render?.(); } catch {}
    });

    const span = document.createElement('span');
    span.textContent = 'Debug Normals';

    label.appendChild(checkbox);
    label.appendChild(span);
    wrap.appendChild(label);

    this._debugCheckbox = checkbox;

    return wrap;
  }

  _setConstraintGraphicsEnabled(enabled) {
    const value = !!enabled;
    this._constraintGraphicsEnabled = value;

    if (this._constraintGroup) {
      this._constraintGroup.visible = value;
    }

    if (typeof this._labelOverlay?.setVisible === 'function') {
      this._labelOverlay.setVisible(value);
    }

    if (this._constraintGraphicsCheckbox && this._constraintGraphicsCheckbox.checked !== value) {
      this._constraintGraphicsCheckbox.checked = value;
    }

    if (value) {
      this._refreshConstraintLabels();
    } else {
      this.#clearActiveHoverHighlight();
    }

    try { this.viewer?.render?.(); } catch {}
  }

  _restoreHighlightRecords(map) {
    if (!map || typeof map.size !== 'number' || map.size === 0) return;
    for (const record of map.values()) {
      try {
        if (record.replaced && record.originalMaterial) {
          record.object.material = record.originalMaterial;
        } else if (record.previousColor && record.object.material?.color) {
          record.object.material.color.copy(record.previousColor);
        }
      } catch { /* ignore */ }
    }
    map.clear();
  }

  _clearHoverHighlights() {
    this._restoreHighlightRecords(this._hoverHighlights);
  }

  _clearHighlights() {
    this.#clearActiveHoverHighlight();
    this._restoreHighlightRecords(this._highlighted);
    this._clearNormalArrows();
    try { SelectionFilter.clearHover?.(); } catch { /* ignore */ }
    try { this.viewer?.render?.(); } catch { /* ignore */ }
  }

  _applyConstraintHighlight(entry, ConstraintClass, options = {}) {
    if (!entry?.inputParams) return false;

    const store = options.store ?? this._highlighted;
    const clearExisting = options.clearExisting !== false;
    const includeNormals = options.includeNormals ?? (store === this._highlighted);
    const skipSets = Array.isArray(options.skipSets) && options.skipSets.length
      ? options.skipSets
      : [store];
    const emitWarnings = options.emitWarnings || false;

    const useHoverStore = store === this._hoverHighlights;

    if (useHoverStore) {
      this._clearHoverHighlights();
      if (clearExisting && store !== this._highlighted) {
        this._restoreHighlightRecords(this._highlighted);
        this._clearNormalArrows();
      }
    } else if (clearExisting) {
      this._clearHighlights();
    }

    const schema = ConstraintClass?.inputParamsSchema || {};
    let refFields = Object.entries(schema).filter(([, def]) => def?.type === 'reference_selection');
    if (!refFields.length) {
      const fallbackKeys = ['element_A', 'element_B', 'element_a', 'element_b'];
      refFields = fallbackKeys
        .filter((key) => entry.inputParams[key] != null)
        .map((key) => [key, null]);
      if (!refFields.length) return false;
    }

    let colorIndex = 0;
    let foundTargets = false;
    for (const [key] of refFields) {
      const color = this._highlightPalette[colorIndex % this._highlightPalette.length];
      colorIndex += 1;
      const targets = this._resolveReferenceObjects(entry.inputParams[key]);
      if (!targets || targets.length === 0) continue;
      foundTargets = true;
      for (const obj of targets) {
        const changed = this._applyHighlightMaterial(obj, color, store, skipSets);
        if (changed && includeNormals && this._isFaceObject(obj)) {
          this._createNormalArrow(obj, color, `${entry?.inputParams?.constraintID || 'constraint'}:${key}`);
        }
      }
    }

    if (emitWarnings && !foundTargets) {
      console.warn('[AssemblyConstraintsWidget] No reference objects could be highlighted for constraint:', entry?.inputParams?.constraintID);
    }

    if (emitWarnings && includeNormals && this._normalArrows.size === 0) {
      console.warn('[AssemblyConstraintsWidget] No face normals could be visualized for constraint:', entry?.inputParams?.constraintID);
    }

    try { this.viewer?.render?.(); } catch { /* ignore */ }
    return foundTargets;
  }

  _highlightConstraint(entry, ConstraintClass) {
    this._applyConstraintHighlight(entry, ConstraintClass, {
      store: this._highlighted,
      clearExisting: true,
      includeNormals: true,
      skipSets: [this._highlighted],
      emitWarnings: true,
    });
  }

  #attachLabelHoverHandlers(element, entry, constraintID) {
    if (!element) return;
    const prev = element.__constraintHoverHandlers;
    if (prev) {
      element.removeEventListener('mouseenter', prev.enter);
      element.removeEventListener('mouseleave', prev.leave);
    }
    if (!entry) {
      element.__constraintHoverHandlers = null;
      return;
    }
    const onEnter = () => {
      try { this.#handleConstraintLabelHover(entry, constraintID); } catch {}
    };
    const onLeave = () => {
      try { this.#handleConstraintLabelHoverEnd(constraintID); } catch {}
    };
    element.addEventListener('mouseenter', onEnter);
    element.addEventListener('mouseleave', onLeave);
    element.__constraintHoverHandlers = { enter: onEnter, leave: onLeave };
  }

  #handleConstraintLabelHover(entry, constraintID) {
    if (!this._constraintGraphicsEnabled) return;
    if (this._activeHoverConstraintId && this._activeHoverConstraintId !== constraintID) {
      this.#clearActiveHoverHighlight();
    }

    const ConstraintClass = this._resolveConstraintClass(entry);

    this._activeHoverConstraintId = constraintID;
    this._applyConstraintHighlight(entry, ConstraintClass, {
      store: this._hoverHighlights,
      clearExisting: false,
      includeNormals: false,
      skipSets: [this._highlighted, this._hoverHighlights],
      emitWarnings: false,
    });
    this.#setConstraintLineHighlight(constraintID, true);
    try { this.viewer?.render?.(); } catch {}
  }

  #handleConstraintLabelHoverEnd(constraintID) {
    if (!constraintID) return;
    if (this._activeHoverConstraintId !== constraintID) {
      this.#setConstraintLineHighlight(constraintID, false);
      try { this.viewer?.render?.(); } catch {}
      return;
    }
    this.#clearActiveHoverHighlight();
  }

  #clearActiveHoverHighlight() {
    if (!this._activeHoverConstraintId) return;
    const activeId = this._activeHoverConstraintId;
    this._activeHoverConstraintId = null;
    this._clearHoverHighlights();
    this.#setConstraintLineHighlight(activeId, false);
    try { this.viewer?.render?.(); } catch {}
  }

  #setConstraintLineHighlight(constraintID, active) {
    const line = this._constraintLines.get(constraintID);
    if (!line || !line.material) return;
    const mat = line.material;
    line.userData = line.userData || {};

    if (active) {
      if (!line.userData.__hoverOriginal) {
        line.userData.__hoverOriginal = {
          color: mat.color ? mat.color.clone() : null,
          linewidth: mat.linewidth,
          opacity: mat.opacity,
          depthTest: mat.depthTest,
          depthWrite: mat.depthWrite,
        };
      }
      try { mat.color?.set('#ffffff'); } catch {}
      try { mat.opacity = 1; } catch {}
      try { mat.linewidth = 2; } catch {}
      try { mat.depthTest = false; mat.depthWrite = false; } catch {}
      line.renderOrder = 10050;
    } else {
      const original = line.userData.__hoverOriginal;
      if (original) {
        try {
          if (original.color && mat.color) mat.color.copy(original.color);
          if (original.opacity != null) mat.opacity = original.opacity;
          if (original.linewidth != null) mat.linewidth = original.linewidth;
          if (original.depthTest != null) mat.depthTest = original.depthTest;
          if (original.depthWrite != null) mat.depthWrite = original.depthWrite;
        } catch {}
      }
      delete line.userData.__hoverOriginal;
      line.renderOrder = 9999;
    }

    try { mat.needsUpdate = true; } catch {}
  }

  _updateConstraintVisuals(entries = []) {
    const scene = this.viewer?.scene || null;
    if (!scene) return;

    this.#clearActiveHoverHighlight();

    const activeIds = new Set();
    this._labelPositions.clear();
    if (this._labelOverlay) {
      try { this._labelOverlay.clear(); } catch {}
    }

    if (!entries || entries.length === 0) {
      this._removeUnusedConstraintLines(activeIds);
      this._refreshConstraintLabels();
      return;
    }

    entries.forEach((entry, index) => {
      if (!entry) return;
      const constraintID = entry?.inputParams?.constraintID || `constraint-${index}`;
      const points = this.#constraintPoints(entry);
      let labelPosition = null;

      if (Array.isArray(points) && points.length === 2) {
        const [pointA, pointB] = points;
        this.#upsertConstraintLine(constraintID, pointA, pointB);
        labelPosition = pointA.clone().add(pointB).multiplyScalar(0.5);
      } else {
        this.#removeConstraintLine(constraintID);
        labelPosition = this.#constraintStandalonePosition(entry);
      }

      if (!labelPosition) return;

      const text = this.#constraintLabelText(entry);
      const overlayData = { constraintID };

      if (this._constraintGraphicsEnabled) {
        try { this._labelOverlay?.updateLabel(constraintID, text, labelPosition.clone(), overlayData); } catch {}
        const el = this._labelOverlay?.getElement?.(constraintID);
        if (el) {
          try {
            el.classList.add('constraint-label');
            el.dataset.constraintId = constraintID;
          } catch {}
          this.#attachLabelHoverHandlers(el, entry, constraintID);
        }
      }

      this._labelPositions.set(constraintID, {
        position: labelPosition.clone(),
        text,
        data: overlayData,
        entry,
      });
      activeIds.add(constraintID);
    });

    this._removeUnusedConstraintLines(activeIds);
    this._refreshConstraintLabels();
    try { this.viewer?.render?.(); } catch {}
  }

  _refreshConstraintLabels() {
    if (!this._constraintGraphicsEnabled) return;
    if (!this._labelOverlay || !this._labelPositions.size) return;
    for (const [constraintID, record] of this._labelPositions.entries()) {
      if (!record || !record.position) continue;
      try {
        this._labelOverlay.updateLabel(constraintID, record.text, record.position.clone(), record.data);
        const el = this._labelOverlay.getElement(constraintID);
        if (el) {
          el.classList.add('constraint-label');
          el.dataset.constraintId = constraintID;
          this.#attachLabelHoverHandlers(el, record.entry, constraintID);
        }
      } catch {}
    }
  }

  _clearConstraintVisuals() {
    this.#clearActiveHoverHighlight();
    this._labelPositions.clear();
    if (this._labelOverlay) {
      try { this._labelOverlay.clear(); } catch {}
    }
    for (const constraintID of Array.from(this._constraintLines.keys())) {
      this.#removeConstraintLine(constraintID);
    }
  }

  _removeUnusedConstraintLines(activeIds) {
    for (const constraintID of Array.from(this._constraintLines.keys())) {
      if (!activeIds.has(constraintID)) {
        this.#removeConstraintLine(constraintID);
      }
    }
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

  _applyHighlightMaterial(object, color, store = this._highlighted, skipSets = [store]) {
    if (!object || !color || !store) return false;

    const guardSets = Array.isArray(skipSets) ? skipSets.filter((m) => m && typeof m.has === 'function') : [];
    if (guardSets.length === 0) guardSets.push(store);

    const targets = [];
    object.traverse?.((child) => {
      if (!child || !child.isObject3D) return;
      if (child.material && child.material.color) targets.push(child);
    });
    if (targets.length === 0 && object.material && object.material.color) {
      targets.push(object);
    }

    let modified = false;
    for (const target of targets) {
      const key = target.uuid;
      if (guardSets.some((map) => map.has(key))) continue;

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

      store.set(key, {
        object: target,
        replaced,
        originalMaterial,
        previousColor,
      });
      modified = true;
    }

    return modified;
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

  #clearConstraintDebugArrows() {
    const scene = this.viewer?.scene || null;
    if (!scene || typeof scene.traverse !== 'function') return;
    const prefixes = [
      'parallel-constraint-normal-',
      'distance-constraint-normal-',
      'touch-align-normal-',
    ];
    const toRemove = [];
    scene.traverse((obj) => {
      if (!obj || typeof obj.name !== 'string') return;
      if (prefixes.some((prefix) => obj.name.startsWith(prefix))) {
        toRemove.push(obj);
      }
    });
    for (const obj of toRemove) {
      try { obj.parent?.remove?.(obj); }
      catch {}
    }
  }

  #constraintPoints(entry) {
    if (!entry?.inputParams) return null;
    const pointA = this.#resolveSelectionPoint(entry.inputParams.element_A);
    const pointB = this.#resolveSelectionPoint(entry.inputParams.element_B);
    if (pointA && pointB) return [pointA, pointB];

    const refPoints = this.#collectReferenceSelectionPoints(entry);
    if (refPoints.length >= 2) return refPoints.slice(0, 2);

    return null;
  }

  #collectReferenceSelectionPoints(entry) {
    const cls = this._resolveConstraintClass(entry);
    const schema = cls?.inputParamsSchema || {};
    const refKeys = Object.entries(schema)
      .filter(([, def]) => def?.type === 'reference_selection')
      .map(([key]) => key);
    if (!refKeys.length) return [];

    const points = [];
    const pushSelection = (value) => {
      if (!value || points.length >= 2) return;
      if (Array.isArray(value)) {
        for (const item of value) {
          pushSelection(item);
          if (points.length >= 2) break;
        }
        return;
      }
      const point = this.#resolveSelectionPoint(value);
      if (point) points.push(point);
    };

    for (const key of refKeys) {
      pushSelection(entry.inputParams[key]);
      if (points.length >= 2) break;
    }

    return points;
  }

  #constraintLabelText(entry) {
    const cls = this._resolveConstraintClass(entry);
    const rawShortName = cls?.constraintShortName;
    const shortName = rawShortName != null ? String(rawShortName).trim() : '';
    const base = shortName
      || cls?.constraintName
      || entry?.constraintType
      || entry?.type
      || 'Constraint';

    let distanceSuffix = '';
    if (entry?.type === 'distance' || cls?.constraintType === 'distance') {
      const distance = Number(entry?.inputParams?.distance);
      if (Number.isFinite(distance)) distanceSuffix = String(distance);
    }

    const parts = [];
    if (base) parts.push(String(base).trim());
    if (distanceSuffix) parts.push(distanceSuffix);

    return parts.join(' ').trim();
  }

  #upsertConstraintLine(constraintID, pointA, pointB) {
    if (!this._constraintGroup) return;
    let line = this._constraintLines.get(constraintID);
    if (!line) {
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(6);
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({
        color: 0xffd60a,
        linewidth: 1,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false,
      });
      line = new THREE.Line(geometry, material);
      line.name = `constraint-line-${constraintID}`;
      line.renderOrder = 9999;
      line.userData.excludeFromFit = true;
      try { this._constraintGroup.add(line); } catch {}
      this._constraintLines.set(constraintID, line);
    }
    const attr = line.geometry.getAttribute('position');
    attr.setXYZ(0, pointA.x, pointA.y, pointA.z);
    attr.setXYZ(1, pointB.x, pointB.y, pointB.z);
    attr.needsUpdate = true;
    line.geometry.computeBoundingSphere?.();
  }

  #removeConstraintLine(constraintID) {
    const line = this._constraintLines.get(constraintID);
    if (!line) return;
    try { line.parent?.remove(line); } catch {}
    try { line.geometry?.dispose?.(); } catch {}
    try { line.material?.dispose?.(); } catch {}
    this._constraintLines.delete(constraintID);
  }

  #resolveSelectionPoint(selection) {
    if (!selection) return null;
    const candidates = this._resolveReferenceObjects(selection);
    const object = candidates?.find((obj) => obj) || null;
    if (object) {
      const point = this.#extractWorldPoint(object);
      if (point) return point;
    }
    if (Array.isArray(selection)) {
      for (const item of selection) {
        const point = this.#resolveSelectionPoint(item);
        if (point) return point;
      }
    }
    if (selection && typeof selection === 'object') {
      if (Number.isFinite(selection.x) && Number.isFinite(selection.y) && Number.isFinite(selection.z)) {
        return new THREE.Vector3(selection.x, selection.y, selection.z);
      }
      if (Array.isArray(selection) && selection.length >= 3 && selection.every((v) => Number.isFinite(v))) {
        return new THREE.Vector3(selection[0], selection[1], selection[2]);
      }
      if (selection.point && typeof selection.point === 'object') {
        const p = selection.point;
        if (Array.isArray(p) && p.length >= 3 && p.every((v) => Number.isFinite(v))) {
          return new THREE.Vector3(p[0], p[1], p[2]);
        }
        if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
          return new THREE.Vector3(p.x, p.y, p.z);
        }
      }
      if (selection.origin && Number.isFinite(selection.origin.x)) {
        return new THREE.Vector3(selection.origin.x, selection.origin.y, selection.origin.z);
      }
    }
    return null;
  }

  #constraintStandalonePosition(entry, cls) {
    if (!entry) return null;
    const constraintClass = cls || this._resolveConstraintClass(entry);
    const typeValue = entry?.type || constraintClass?.constraintType;
    const type = typeof typeValue === 'string' ? typeValue.toLowerCase() : String(typeValue || '').toLowerCase();
    if (type === 'fixed') {
      return this.#componentBoundingBoxCenter(entry?.inputParams?.component);
    }
    return null;
  }

  #componentBoundingBoxCenter(selection) {
    const objects = this._resolveReferenceObjects(selection);
    if (!objects || objects.length === 0) return null;

    const totalBox = new THREE.Box3();
    const tmpBox = new THREE.Box3();
    let hasBox = false;

    for (const obj of objects) {
      if (!obj) continue;
      try { obj.updateMatrixWorld?.(true); }
      catch {}

      tmpBox.makeEmpty();
      tmpBox.setFromObject(obj);

      const min = tmpBox.min;
      const max = tmpBox.max;
      const valid = Number.isFinite(min.x) && Number.isFinite(min.y) && Number.isFinite(min.z)
        && Number.isFinite(max.x) && Number.isFinite(max.y) && Number.isFinite(max.z)
        && !tmpBox.isEmpty();
      if (!valid) continue;

      if (!hasBox) {
        totalBox.copy(tmpBox);
        hasBox = true;
      } else {
        totalBox.union(tmpBox);
      }
    }

    if (hasBox) {
      const center = totalBox.getCenter(new THREE.Vector3());
      if (center && Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(center.z)) {
        return center;
      }
    }

    for (const obj of objects) {
      const fallback = this.#extractWorldPoint(obj);
      if (fallback) return fallback;
    }

    return null;
  }

  #extractWorldPoint(object) {
    if (!object) return null;
    try { object.updateMatrixWorld?.(true); }
    catch {}
    try {
      const rep = objectRepresentativePoint?.(null, object);
      if (rep && typeof rep.clone === 'function') return rep.clone();
      if (rep && rep.isVector3) return rep.clone();
    } catch {}
    try {
      if (typeof object.getWorldPosition === 'function') {
        return object.getWorldPosition(new THREE.Vector3());
      }
    } catch {}
    try {
      if (object.isVector3) return object.clone();
    } catch {}
    try {
      if (object.position) {
        const pos = object.position.clone ? object.position.clone() : new THREE.Vector3(object.position.x, object.position.y, object.position.z);
        if (object.parent?.matrixWorld) {
          object.parent.updateMatrixWorld?.(true);
          return pos.applyMatrix4(object.parent.matrixWorld);
        }
        return pos;
      }
    } catch {}
    return null;
  }

  #handleLabelClick(idx, _ann, ev) {
    if (idx == null) return;
    const id = String(idx);
    if (!id) return;
    if (ev) {
      try { ev.preventDefault(); } catch {}
      try { ev.stopPropagation(); } catch {}
    }
    let changed = false;
    if (typeof this.history?.setExclusiveOpen === 'function') {
      changed = this.history.setExclusiveOpen(id);
    }
    if (!changed) {
      const entries = this.history?.list?.() || [];
      for (const entry of entries) {
        const entryId = entry?.inputParams?.constraintID;
        const shouldOpen = entryId === id;
        const current = entry?.__open !== false;
        if (current !== shouldOpen) {
          this.history?.setOpenState(entryId, shouldOpen);
        }
      }
      this.history?.setOpenState?.(id, true);
    }

    requestAnimationFrame(() => {
      try {
        const selector = `.acc-item[data-constraint-id="${CSS?.escape ? CSS.escape(id) : id}"]`;
        const target = this._accordion?.querySelector?.(selector);
        if (target && typeof target.scrollIntoView === 'function') {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch {}
    });
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
    .${ROOT_CLASS} .constraints-control-panel {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px 8px 0 8px;
    }
    .${ROOT_CLASS} .control-panel-section {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.015));
    }
    .${ROOT_CLASS} .solver-controls {
      justify-content: space-between;
    }
    .${ROOT_CLASS} .delay-controls {
      justify-content: space-between;
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
    .${ROOT_CLASS} .toggle-control {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 13px;
      color: var(--text);
      user-select: none;
    }
    .${ROOT_CLASS} .toggle-control input {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--accent);
    }
    .${ROOT_CLASS} .toggle-control span {
      color: var(--muted);
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
    .pmi-label-root {
      position: absolute;
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 6;
      overflow: visible;
      contain: layout paint size;
      max-width: 100%;
      max-height: 100%;
    }
    .pmi-label {
      position: absolute;
      transform: translate(-50%, -50%);
      background: rgba(28, 31, 40, 0.92);
      color: #eceff7;
      padding: 4px 6px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      pointer-events: none;
      border: 1px solid rgba(110,168,254,0.35);
      box-shadow: 0 4px 12px rgba(0,0,0,0.35);
    }
    .pmi-label.constraint-label {
      background: rgba(15,17,23,0.92);
      border: 1px solid rgba(110,168,254,0.45);
      border-radius: 8px;
      padding: 4px 8px;
      color: #e6f1ff;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      pointer-events: auto;
      cursor: pointer;
      box-shadow: 0 6px 14px rgba(0,0,0,0.35);
      user-select: none;
    }
    .pmi-label.constraint-label:hover {
      border-color: rgba(110,168,254,0.8);
      background: rgba(17,20,27,0.96);
    }
  `;
  document.head.appendChild(style);
})();
