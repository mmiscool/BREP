import * as THREE from "three";
import { TransformControls as TransformControlsDirect } from "three/examples/jsm/controls/TransformControls.js";
import {
  DEFAULT_RESOLUTION,
  normalizeSplineData,
  buildHermitePolyline,
  cloneSplineData,
} from "../features/spline/splineUtils.js";

const MODE_EDIT = "edit";
const MODE_ADD = "add";

export class SplineMode3D {
  constructor(viewer, featureID) {
    this.viewer = viewer;
    this.featureID = featureID;
    this._mode = MODE_EDIT;
    this._splineData = null;
    this._featureRef = null;

    this._overlay = null;
    this._modeButtons = {};
    this._pointList = null;
    this._addButton = null;

    this._previewGroup = null;
    this._line = null;
    this._objectsById = new Map();
    this._selectedId = null;
    this._hiddenArtifacts = [];
    this._raycaster = new THREE.Raycaster();
    this._previewResolution = DEFAULT_RESOLUTION;

    this._transform = null;
    this._transformHelper = null;
    this._onTransformChange = this._handleTransformChange.bind(this);
    this._onTransformDragging = this._handleTransformDragging.bind(this);

    this._onPointerDown = this._handlePointerDown.bind(this);

    this._anchorBaseMaterial = null;
    this._anchorSelectedMaterial = null;
    this._weightBaseMaterial = null;
    this._weightSelectedMaterial = null;
    this._sphereGeometry = null;
    this._prevToolbarDisplay = null;
  }

  open() {
    const v = this.viewer;
    if (!v || !v.renderer || !v.partHistory) return;

    this._featureRef = Array.isArray(v.partHistory.features)
      ? v.partHistory.features.find(
          (f) => f?.inputParams?.featureID === this.featureID
        )
      : null;

    const res = Number(this._featureRef?.inputParams?.curveResolution);
    if (Number.isFinite(res) && res >= 4) {
      this._previewResolution = Math.max(4, Math.floor(res));
    } else {
      this._previewResolution = DEFAULT_RESOLUTION;
    }

    const sourceSpline = this._featureRef?.persistentData?.spline
      ? cloneSplineData(this._featureRef.persistentData.spline)
      : null;

    this._splineData = normalizeSplineData(sourceSpline);

    this._hideExistingArtifacts();
    this._initMaterials();
    this._buildPreviewGroup();
    this._mountUI();
    this._setupTransformControls();
    this._attachCanvasEvents();
    this._setMode(MODE_EDIT);
    this._rebuildAll({ preserveSelection: false });
    this._renderPointList();

    try {
      if (v.sidebar) {
        v.sidebar.hidden = true;
        v.sidebar.style.display = "none";
        v.sidebar.style.visibility = "hidden";
      }
      if (v.mainToolbar?.root) {
        this._prevToolbarDisplay = v.mainToolbar.root.style.display;
        v.mainToolbar.root.style.display = "none";
      }
    } catch {
      /* noop */
    }

    try {
      v.render();
    } catch {
      /* noop */
    }
  }

  async finish() {
    const payload = cloneSplineData(this._splineData);
    try {
      if (typeof this.viewer?.onSplineFinished === "function") {
        this.viewer.onSplineFinished(this.featureID, payload);
      }
    } catch {
      /* noop */
    }
  }

  cancel() {
    try {
      if (typeof this.viewer?.onSplineCancelled === "function") {
        this.viewer.onSplineCancelled(this.featureID);
      }
    } catch {
      /* noop */
    }
  }

  close() {
    this.dispose();
  }

  dispose() {
    this._detachCanvasEvents();
    this._teardownTransformControls();
    this._destroyPreviewGroup();
    this._restoreArtifacts();
    this._destroyUI();
    this._disposeMaterials();

    try {
      const v = this.viewer;
      if (v) {
        if (v.sidebar) {
          v.sidebar.hidden = false;
          v.sidebar.style.display = "";
          v.sidebar.style.visibility = "visible";
          v.sidebar.style.opacity = 0.9;
          v.sidebar.style.zIndex = "7";
        }
        if (v.mainToolbar?.root) {
          v.mainToolbar.root.style.display =
            this._prevToolbarDisplay !== undefined
              ? this._prevToolbarDisplay
              : "";
        }
        if (v.controls) v.controls.enabled = true;
      }
    } catch {
      /* noop */
    }
  }

  _hideExistingArtifacts() {
    const scene = this.viewer?.scene;
    if (!scene) return;
    this._hiddenArtifacts = [];
    scene.traverse((obj) => {
      if (obj && obj.owningFeatureID === this.featureID && obj.visible) {
        this._hiddenArtifacts.push({ obj, visible: obj.visible });
        obj.visible = false;
      }
    });
  }

  _restoreArtifacts() {
    for (const entry of this._hiddenArtifacts) {
      try {
        entry.obj.visible = entry.visible;
      } catch {
        /* ignore */
      }
    }
    this._hiddenArtifacts = [];
  }

  _initMaterials() {
    this._sphereGeometry = new THREE.SphereGeometry(0.2, 20, 16);
    this._anchorBaseMaterial = new THREE.MeshBasicMaterial({
      color: 0x2b9bd8,
    });
    this._anchorSelectedMaterial = new THREE.MeshBasicMaterial({
      color: 0xff679d,
    });
    this._weightBaseMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb703,
    });
    this._weightSelectedMaterial = new THREE.MeshBasicMaterial({
      color: 0xfccf03,
    });
  }

  _disposeMaterials() {
    try { this._sphereGeometry?.dispose(); } catch { /* noop */ }
    try { this._anchorBaseMaterial?.dispose(); } catch { /* noop */ }
    try { this._anchorSelectedMaterial?.dispose(); } catch { /* noop */ }
    try { this._weightBaseMaterial?.dispose(); } catch { /* noop */ }
    try { this._weightSelectedMaterial?.dispose(); } catch { /* noop */ }
    this._sphereGeometry = null;
    this._anchorBaseMaterial = null;
    this._anchorSelectedMaterial = null;
    this._weightBaseMaterial = null;
    this._weightSelectedMaterial = null;
  }

  _buildPreviewGroup() {
    const scene = this.viewer?.scene;
    if (!scene) return;
    this._previewGroup = new THREE.Group();
    this._previewGroup.name = `__SplinePreview__${this.featureID}`;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([], 3)
    );
    const material = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 2,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this._line = new THREE.Line(geometry, material);
    this._line.name = "__SplinePreviewLine";
    this._line.renderOrder = 10000;
    this._previewGroup.add(this._line);

    scene.add(this._previewGroup);
  }

  _destroyPreviewGroup() {
    if (!this._previewGroup || !this.viewer?.scene) return;
    try {
      if (this._line) {
        this._line.geometry?.dispose();
        this._line.material?.dispose();
      }
    } catch {
      /* noop */
    }
    try {
      this.viewer.scene.remove(this._previewGroup);
    } catch {
      /* noop */
    }
    this._previewGroup = null;
    this._line = null;
    this._objectsById.clear();
  }

  _setupTransformControls() {
    if (!this.viewer?.camera || !this.viewer?.renderer) return;
    if (!TransformControlsDirect) return;

    this._transform = new TransformControlsDirect(
      this.viewer.camera,
      this.viewer.renderer.domElement
    );
    try {
      this._transform.disconnect();
      this._transform.connect(null);
    } catch {
      /* noop */
    }
    this._transform.setMode("translate");
    this._transform.showX = true;
    this._transform.showY = true;
    this._transform.showZ = true;
    this._transform.setSize(1.0);
    this._transform.addEventListener("change", this._onTransformChange);
    this._transform.addEventListener(
      "dragging-changed",
      this._onTransformDragging
    );

    const helper =
      typeof this._transform.getHelper === "function"
        ? this._transform.getHelper()
        : null;
    if (helper && helper.isObject3D) {
      this._transformHelper = helper;
      this._transformHelper.userData = this._transformHelper.userData || {};
      this._transformHelper.userData.excludeFromFit = true;
      this._transformHelper.renderOrder = 10000;
      this._transformHelper.visible = false;
      try {
        this._transformHelper.traverse((child) => {
          if (!child || !child.isObject3D) return;
          const mat = child.material;
          if (mat && typeof mat === "object") {
            if ("depthTest" in mat) mat.depthTest = false;
            if ("depthWrite" in mat) mat.depthWrite = false;
            if ("transparent" in mat) mat.transparent = true;
          }
        });
      } catch {
        /* noop */
      }
      try {
        this.viewer.scene.add(this._transformHelper);
      } catch {
        /* noop */
      }
    } else {
      this._transformHelper = null;
    }
  }

  _teardownTransformControls() {
    if (!this._transform) return;
    try {
      this._transform.removeEventListener("change", this._onTransformChange);
    } catch {
      /* noop */
    }
    try {
      this._transform.removeEventListener(
        "dragging-changed",
        this._onTransformDragging
      );
    } catch {
      /* noop */
    }
    try {
      this._transform.detach();
    } catch {
      /* noop */
    }
    try {
      this._transform.dispose?.();
    } catch {
      /* noop */
    }
    if (this._transformHelper && this._transformHelper.isObject3D) {
      try {
        this.viewer?.scene?.remove(this._transformHelper);
      } catch {
        /* noop */
      }
    }
    this._transformHelper = null;
    this._transform = null;
  }

  _attachCanvasEvents() {
    const dom = this.viewer?.renderer?.domElement;
    if (!dom) return;
    dom.addEventListener("pointerdown", this._onPointerDown, {
      passive: false,
      capture: true,
    });
  }

  _detachCanvasEvents() {
    const dom = this.viewer?.renderer?.domElement;
    if (!dom) return;
    dom.removeEventListener("pointerdown", this._onPointerDown, {
      capture: true,
    });
  }

  _handlePointerDown(event) {
    if (!this.viewer || !this._previewGroup) return;
    if (event.button !== 0) return;
    if (this._transform?.dragging) return;
    const path = event.composedPath ? event.composedPath() : [];
    for (const el of path) {
      if (el && el.classList && el.classList.contains("spline-mode-ui")) {
        return;
      }
    }

    const dom = this.viewer.renderer.domElement;
    const rect = dom.getBoundingClientRect();
    const ndc = {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
    };
    this._raycaster.setFromCamera(ndc, this.viewer.camera);

    if (this._transformHelper && this._transformHelper.visible) {
      try {
        const hits = this._raycaster.intersectObject(this._transformHelper, true);
        if (Array.isArray(hits) && hits.length) {
          return;
        }
      } catch {
        /* noop */
      }
    }

    try {
      event.preventDefault();
      event.stopPropagation();
    } catch {
      /* noop */
    }

    this._raycaster.setFromCamera(ndc, this.viewer.camera);

    const pickTargets = [];
    for (const entry of this._objectsById.values()) {
      if (entry?.mesh) pickTargets.push(entry.mesh);
    }
    const intersects = this._raycaster.intersectObjects(pickTargets, false);
    if (intersects.length) {
      const picked = intersects[0].object;
      for (const [id, entry] of this._objectsById.entries()) {
        if (entry.mesh === picked) {
          this._selectObject(id);
          return;
        }
      }
    }

    if (this._selectedId && this._transformHelper) {
      try {
        const hits = this._raycaster.intersectObject(this._transformHelper, true);
        if (Array.isArray(hits) && hits.length) {
          return;
        }
      } catch {
        /* noop */
      }
    }

    this._selectObject(null);
  }

  _setMode(mode) {
    const nextMode = mode === MODE_ADD ? MODE_ADD : MODE_EDIT;
    if (this._mode === nextMode) return;
    this._mode = nextMode;
    this._selectObject(this._mode === MODE_EDIT ? this._selectedId : null);
    this._updateModeButtons();
    this._renderPointList();
  }

  _updateModeButtons() {
    for (const key of Object.keys(this._modeButtons)) {
      const btn = this._modeButtons[key];
      if (!btn) continue;
      this._styleButton(btn);
      const isActive = key === this._mode;
      btn.classList.toggle("active", isActive);
      btn.style.background = isActive ? "#3a4a6d" : "#1f2433";
    }
    if (this._addButton) {
      this._addButton.disabled = this._mode !== MODE_ADD;
      this._addButton.style.opacity = this._mode === MODE_ADD ? "1" : "0.5";
      this._addButton.style.cursor =
        this._mode === MODE_ADD ? "pointer" : "not-allowed";
    }
    if (this._pointList) {
      const enabled = this._mode === MODE_ADD;
      this._pointList.style.pointerEvents = enabled ? "auto" : "none";
      this._pointList.style.opacity = enabled ? "1" : "0.55";
    }
  }

  _rebuildAll({ preserveSelection }) {
    const previousSelection = preserveSelection ? this._selectedId : null;
    this._buildPointHandles();
    this._rebuildPreviewLine();
    if (preserveSelection && previousSelection) {
      this._selectObject(previousSelection);
    } else {
      this._selectObject(null);
    }
  }

  _buildPointHandles() {
    if (!this._previewGroup) return;

    const stale = [];
    for (const entry of this._objectsById.values()) {
      if (entry.mesh && entry.mesh.parent === this._previewGroup) {
        stale.push(entry.mesh);
      }
    }
    for (const mesh of stale) {
      try {
        this._previewGroup.remove(mesh);
      } catch {
        /* noop */
      }
    }
    this._objectsById.clear();

    if (!this._sphereGeometry) this._initMaterials();

    const ensureGeometry = () =>
      this._sphereGeometry || new THREE.SphereGeometry(0.2, 20, 16);

    const geom = ensureGeometry();

    this._splineData.points.forEach((pt) => {
      const mesh = new THREE.Mesh(geom, this._anchorBaseMaterial);
      mesh.position.set(
        Number(pt.position[0]) || 0,
        Number(pt.position[1]) || 0,
        Number(pt.position[2]) || 0
      );
      mesh.name = `SplinePoint:${pt.id}`;
      this._previewGroup.add(mesh);
      this._objectsById.set(`point:${pt.id}`, {
        type: "point",
        mesh,
        data: pt,
      });
    });

    const startMesh = new THREE.Mesh(geom, this._weightBaseMaterial);
    startMesh.position.set(
      Number(this._splineData.startWeight.position[0]) || 0,
      Number(this._splineData.startWeight.position[1]) || 0,
      Number(this._splineData.startWeight.position[2]) || 0
    );
    startMesh.name = "SplineWeightStart";
    this._previewGroup.add(startMesh);
    this._objectsById.set("weight:start", {
      type: "weight",
      mesh: startMesh,
      data: this._splineData.startWeight,
    });

    const endMesh = new THREE.Mesh(geom, this._weightBaseMaterial);
    endMesh.position.set(
      Number(this._splineData.endWeight.position[0]) || 0,
      Number(this._splineData.endWeight.position[1]) || 0,
      Number(this._splineData.endWeight.position[2]) || 0
    );
    endMesh.name = "SplineWeightEnd";
    this._previewGroup.add(endMesh);
    this._objectsById.set("weight:end", {
      type: "weight",
      mesh: endMesh,
      data: this._splineData.endWeight,
    });

    this._updateSelectionVisuals();
  }

  _rebuildPreviewLine() {
    if (!this._line) return;
    const { positions } = buildHermitePolyline(
      this._splineData,
      this._previewResolution || DEFAULT_RESOLUTION
    );

    const array = new Float32Array(positions);
    this._line.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(array, 3)
    );
    if (positions.length >= 3) {
      this._line.geometry.computeBoundingSphere();
    }
  }

  _selectObject(id) {
    if (this._mode !== MODE_EDIT) {
      if (this._transform) this._transform.detach();
      if (this._transformHelper) this._transformHelper.visible = false;
      this._selectedId = null;
      this._updateSelectionVisuals();
      return;
    }

    if (!id || !this._objectsById.has(id)) {
      this._selectedId = null;
      if (this._transform) this._transform.detach();
      if (this._transformHelper) this._transformHelper.visible = false;
      this._updateSelectionVisuals();
      try {
        this.viewer?.render();
      } catch {
        /* noop */
      }
      return;
    }

    this._selectedId = id;
    const entry = this._objectsById.get(id);
    if (this._transform) {
      try {
        this._transform.attach(entry.mesh);
        if (this._transformHelper) {
          this._transformHelper.visible = true;
        }
      } catch {
        /* noop */
      }
    }
    this._updateSelectionVisuals();
    this._renderPointList();
    try {
      this.viewer?.render();
    } catch {
      /* noop */
    }
  }

  _updateSelectionVisuals() {
    for (const [id, entry] of this._objectsById.entries()) {
      if (!entry?.mesh) continue;
      const selected = id === this._selectedId;
      if (entry.type === "point") {
        entry.mesh.material = selected
          ? this._anchorSelectedMaterial
          : this._anchorBaseMaterial;
      } else {
        entry.mesh.material = selected
          ? this._weightSelectedMaterial
          : this._weightBaseMaterial;
      }
    }
  }

  _handleTransformChange() {
    if (!this._selectedId) return;
    const entry = this._objectsById.get(this._selectedId);
    if (!entry || !entry.mesh || !entry.data) return;
    const pos = entry.mesh.position;
    entry.data.position = [pos.x, pos.y, pos.z];
    this._rebuildPreviewLine();
    this._renderPointList();
    try {
      this.viewer?.render();
    } catch {
      /* noop */
    }
  }

  _handleTransformDragging(event) {
    const dragging = !!event?.value;
    try {
      if (this.viewer?.controls) {
        this.viewer.controls.enabled = !dragging;
      }
    } catch {
      /* noop */
    }
  }

  _mountUI() {
    const container = this.viewer?.container || this.viewer?.renderer?.domElement?.parentElement;
    if (!container) return;

    const overlay = document.createElement("div");
    overlay.className = "spline-mode-ui";
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.pointerEvents = "none";
    overlay.style.display = "flex";
    overlay.style.flexDirection = "column";
    overlay.style.justifyContent = "space-between";
    overlay.style.zIndex = "12";

    const topBar = document.createElement("div");
    topBar.style.display = "flex";
    topBar.style.justifyContent = "space-between";
    topBar.style.alignItems = "center";
    topBar.style.padding = "12px 16px";
    topBar.style.pointerEvents = "none";

    const leftGroup = document.createElement("div");
    leftGroup.style.display = "flex";
    leftGroup.style.gap = "8px";
    leftGroup.style.pointerEvents = "all";

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit Mode";
    editBtn.className = "spline-mode-button";
    this._styleButton(editBtn);
    editBtn.addEventListener("click", () => this._setMode(MODE_EDIT));
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add Mode";
    addBtn.className = "spline-mode-button";
    this._styleButton(addBtn);
    addBtn.addEventListener("click", () => this._setMode(MODE_ADD));
    this._modeButtons[MODE_EDIT] = editBtn;
    this._modeButtons[MODE_ADD] = addBtn;
    leftGroup.appendChild(editBtn);
    leftGroup.appendChild(addBtn);

    const rightGroup = document.createElement("div");
    rightGroup.style.display = "flex";
    rightGroup.style.gap = "8px";
    rightGroup.style.pointerEvents = "all";

    const finishBtn = document.createElement("button");
    finishBtn.textContent = "Finish";
    finishBtn.className = "spline-mode-button";
    this._styleButton(finishBtn);
    finishBtn.addEventListener("click", () => this.finish());

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.className = "spline-mode-button";
    this._styleButton(cancelBtn);
    cancelBtn.addEventListener("click", () => this.cancel());

    rightGroup.appendChild(finishBtn);
    rightGroup.appendChild(cancelBtn);

    topBar.appendChild(leftGroup);
    topBar.appendChild(rightGroup);

    const bottomPanel = document.createElement("div");
    bottomPanel.style.display = "flex";
    bottomPanel.style.justifyContent = "flex-start";
    bottomPanel.style.alignItems = "flex-end";
    bottomPanel.style.pointerEvents = "none";
    bottomPanel.style.padding = "16px";
    bottomPanel.style.width = "100%";
    bottomPanel.style.boxSizing = "border-box";

    const panel = document.createElement("div");
    panel.style.minWidth = "260px";
    panel.style.maxHeight = "60vh";
    panel.style.overflowY = "auto";
    panel.style.pointerEvents = "all";
    panel.style.background = "rgba(15, 17, 26, 0.92)";
    panel.style.padding = "12px";
    panel.style.borderRadius = "8px";
    panel.style.color = "#fff";
    panel.style.fontSize = "13px";
    panel.style.lineHeight = "1.4";
    panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
    panel.style.marginLeft = "0";
    panel.style.marginRight = "auto";

    const panelTitle = document.createElement("div");
    panelTitle.textContent = "Spline Points";
    panelTitle.style.fontWeight = "600";
    panelTitle.style.marginBottom = "8px";

    const addButton = document.createElement("button");
    addButton.textContent = "Add Point";
    addButton.style.width = "100%";
    addButton.style.marginBottom = "8px";
    this._styleButton(addButton);
    addButton.addEventListener("click", () => this._handleAddPoint());
    this._addButton = addButton;

    const list = document.createElement("div");
    list.className = "spline-point-list";
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.gap = "6px";
    this._pointList = list;

    panel.appendChild(panelTitle);
    panel.appendChild(addButton);
    panel.appendChild(list);
    bottomPanel.appendChild(panel);

    overlay.appendChild(topBar);
    overlay.appendChild(bottomPanel);

    container.style.position = container.style.position || "relative";
    container.appendChild(overlay);

    this._overlay = overlay;
    this._updateModeButtons();
  }

  _destroyUI() {
    if (!this._overlay) return;
    try {
      this._overlay.remove();
    } catch {
      /* noop */
    }
    this._overlay = null;
    this._modeButtons = {};
    this._pointList = null;
    this._addButton = null;
  }

  _styleButton(button) {
    if (!button) return;
    button.style.background = button.style.background || "#1f2433";
    button.style.color = "#ffffff";
    button.style.border = "1px solid #3b455f";
    button.style.borderRadius = "4px";
    button.style.padding = "6px 10px";
    button.style.cursor = "pointer";
    button.style.fontSize = "12px";
  }

  _renderPointList() {
    if (!this._pointList) return;
    this._pointList.innerHTML = "";

    this._splineData.points.forEach((pt, index) => {
      const row = document.createElement("div");
      row.style.display = "grid";
      row.style.gridTemplateColumns = "1fr auto auto auto auto";
      row.style.gap = "6px";
      row.style.alignItems = "center";

      const label = document.createElement("div");
      const pos = pt.position.map((c) => Number(c).toFixed(2)).join(", ");
      label.textContent = `Point ${index + 1} • [${pos}]`;
      label.style.fontFamily = "monospace";
      label.style.fontSize = "12px";

      const selectBtn = document.createElement("button");
      selectBtn.textContent = "Select";
      this._styleButton(selectBtn);
      selectBtn.disabled = this._mode !== MODE_EDIT;
      selectBtn.style.cursor = selectBtn.disabled ? "not-allowed" : "pointer";
      selectBtn.style.opacity = selectBtn.disabled ? "0.5" : "1";
      selectBtn.addEventListener("click", () =>
        this._selectObject(`point:${pt.id}`)
      );

      const upBtn = document.createElement("button");
      upBtn.textContent = "↑";
      upBtn.title = "Move Up";
      upBtn.disabled = index === 0;
      this._styleButton(upBtn);
      upBtn.style.cursor = upBtn.disabled ? "not-allowed" : "pointer";
      upBtn.style.opacity = upBtn.disabled ? "0.5" : "1";
      upBtn.addEventListener("click", () =>
        this._handleReorderPoint(pt.id, -1)
      );

      const downBtn = document.createElement("button");
      downBtn.textContent = "↓";
      downBtn.title = "Move Down";
      downBtn.disabled = index === this._splineData.points.length - 1;
      this._styleButton(downBtn);
      downBtn.style.cursor = downBtn.disabled ? "not-allowed" : "pointer";
      downBtn.style.opacity = downBtn.disabled ? "0.5" : "1";
      downBtn.addEventListener("click", () =>
        this._handleReorderPoint(pt.id, 1)
      );

      const removeBtn = document.createElement("button");
      removeBtn.textContent = "✕";
      removeBtn.title = "Remove Point";
      removeBtn.disabled = this._splineData.points.length <= 2;
      this._styleButton(removeBtn);
      removeBtn.style.cursor = removeBtn.disabled ? "not-allowed" : "pointer";
      removeBtn.style.opacity = removeBtn.disabled ? "0.5" : "1";
      removeBtn.addEventListener("click", () => this._handleRemovePoint(pt.id));

      row.appendChild(label);
      row.appendChild(selectBtn);
      row.appendChild(upBtn);
      row.appendChild(downBtn);
      row.appendChild(removeBtn);

      this._pointList.appendChild(row);
    });
  }

  _handleAddPoint() {
    if (this._mode !== MODE_ADD) return;
    const newId = `p${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const fallback = this._splineData.points[this._splineData.points.length - 1];
    const base = fallback?.position || [0, 0, 0];
    const target = this.viewer?.controls?.target;
    const defaultPos = target
      ? [target.x, target.y, target.z]
      : [base[0] + 1, base[1], base[2]];

    this._splineData.points.push({
      id: newId,
      position: defaultPos,
    });

    this._rebuildAll({ preserveSelection: false });
    this._renderPointList();
    this._selectObject(`point:${newId}`);
  }

  _handleRemovePoint(pointId) {
    if (this._mode !== MODE_ADD) return;
    if (this._splineData.points.length <= 2) return;
    const idx = this._splineData.points.findIndex((pt) => pt.id === pointId);
    if (idx === -1) return;
    this._splineData.points.splice(idx, 1);
    if (this._selectedId === `point:${pointId}`) {
      this._selectedId = null;
    }
    this._rebuildAll({ preserveSelection: true });
    this._renderPointList();
  }

  _handleReorderPoint(pointId, direction) {
    if (this._mode !== MODE_ADD) return;
    const idx = this._splineData.points.findIndex((pt) => pt.id === pointId);
    if (idx === -1) return;
    const newIndex = idx + direction;
    if (newIndex < 0 || newIndex >= this._splineData.points.length) return;
    const [item] = this._splineData.points.splice(idx, 1);
    this._splineData.points.splice(newIndex, 0, item);
    this._rebuildAll({ preserveSelection: true });
    this._renderPointList();
  }
}
