import * as THREE from "three";
import { TransformControls as TransformControlsDirect } from "three/examples/jsm/controls/TransformControls.js";
import {
  DEFAULT_RESOLUTION,
  normalizeSplineData,
  buildHermitePolyline,
  cloneSplineData,
} from "./splineUtils.js";

const noop = () => { };

export class SplineEditorSession {
  constructor(viewer, featureID, options = {}) {
    this.viewer = viewer || null;
    this.featureID =
      featureID != null ? String(featureID) : options?.featureID || null;
    this.options = options || {};

    this._featureRef = options.featureRef || null;
    this._previewResolution = DEFAULT_RESOLUTION;
    this._splineData = normalizeSplineData(
      cloneSplineData(this._featureRef?.persistentData?.spline || null)
    );

    this._objectsById = new Map();
    this._weightLines = { start: null, end: null };
    this._selectedId = null;
    this._hiddenArtifacts = [];
    this._raycaster = new THREE.Raycaster();

    this._transformsById = new Map();
    this._transformListeners = new Map();
    this._isTransformDragging = false;
    this._onCanvasPointerDown = null;

    this._anchorBaseMaterial = null;
    this._anchorSelectedMaterial = null;
    this._weightBaseMaterial = null;
    this._weightSelectedMaterial = null;
    this._weightLineMaterial = null;
    this._sphereGeometry = null;

    this._previewGroup = null;
    this._line = null;

    this._onSplineChange =
      typeof options.onSplineChange === "function"
        ? options.onSplineChange
        : noop;
    this._onSelectionChange =
      typeof options.onSelectionChange === "function"
        ? options.onSelectionChange
        : noop;

    this._active = false;
  }

  _updateTransformVisibility() {
    if (!this._transformsById) return;
    for (const [id, transformEntry] of this._transformsById.entries()) {
      if (!transformEntry) continue;
      const { control, helper } = transformEntry;
      const active = id === this._selectedId;
      if (control) control.enabled = active;
      if (helper) helper.visible = active;
    }
    if (!this._selectedId) {
      this._isTransformDragging = false;
    }
  }

  isActive() {
    return this._active;
  }

  getSplineData() {
    return cloneSplineData(this._splineData);
  }

  getSelectedId() {
    return this._selectedId;
  }

  setFeatureRef(featureRef) {
    this._featureRef = featureRef || null;
  }

  /**
   * Activate the editing session. Builds preview geometry and attaches transform controls.
   * @param {Object|null} initialSpline
   * @param {Object} [options]
   * @param {Object} [options.featureRef]
   * @param {number} [options.previewResolution]
   * @returns {boolean}
   */
  activate(initialSpline = null, options = {}) {
    if (!this.viewer) return false;

    if (this._active) {
      this.dispose();
    }

    const featureRef = options.featureRef ?? this._featureRef ?? null;
    this._featureRef = featureRef;

    const resCandidate =
      options.previewResolution ??
      Number(featureRef?.inputParams?.curveResolution);
    if (Number.isFinite(resCandidate) && resCandidate >= 4) {
      this._previewResolution = Math.max(4, Math.floor(resCandidate));
    } else {
      this._previewResolution = DEFAULT_RESOLUTION;
    }

    const source = initialSpline
      ? cloneSplineData(initialSpline)
      : cloneSplineData(featureRef?.persistentData?.spline || null);
    this._splineData = normalizeSplineData(source);

    this._hideExistingArtifacts();
    this._initMaterials();
    this._buildPreviewGroup();
    this._attachCanvasEvents();
    this._rebuildAll({ preserveSelection: false });

    this._active = true;
    this._notifySelectionChange(this._selectedId);
    this._renderOnce();
    return true;
  }

  /**
   * Tear down preview/controls and restore original artifacts.
   */
  dispose() {
    this._detachCanvasEvents();
    this._teardownAllTransforms();
    this._destroyPreviewGroup();
    this._restoreArtifacts();
    this._disposeMaterials();
    if (this._selectedId !== null) {
      this._selectedId = null;
      this._notifySelectionChange(null);
    }
    this._active = false;
  }

  /**
   * Update session spline data and rebuild preview.
   * @param {Object} spline
   * @param {Object} [options]
   * @param {boolean} [options.preserveSelection=true]
    * @param {boolean} [options.silent=false]
   * @param {string} [options.reason="manual"]
   */
  setSplineData(spline, options = {}) {
    const {
      preserveSelection = true,
      silent = false,
      reason = "manual",
    } = options;
    const normalized = normalizeSplineData(cloneSplineData(spline));
    this._splineData = normalized;
    this._rebuildAll({ preserveSelection });
    if (!silent) {
      this._notifySplineChange(reason);
    } else {
      this._renderOnce();
    }
  }

  selectObject(id, options = {}) {
    const { silent = false } = options || {};
    const nextId = id == null ? null : String(id);
    if (this._selectedId === nextId) {
      if (!silent) {
        this._notifySelectionChange(this._selectedId);
      }
      return;
    }
    this._selectedId = nextId;
    this._updateSelectionVisuals();
    this._updateTransformVisibility();
    if (!silent) {
      this._notifySelectionChange(this._selectedId);
    }
    this._renderOnce();
  }

  clearSelection() {
    this.selectObject(null);
  }

  hideGizmo() {
    this.clearSelection();
  }

  _renderOnce() {
    try {
      this.viewer?.render?.();
    } catch {
      /* noop */
    }
  }

  _notifySplineChange(reason, extra = null) {
    try {
      this._onSplineChange(this.getSplineData(), reason, extra);
    } catch {
      /* ignore listener errors */
    }
  }

  _notifySelectionChange(id) {
    try {
      this._onSelectionChange(id);
    } catch {
      /* ignore listener errors */
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
    // add click event to the sphere geometry

    this._sphereGeometry


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
    this._weightLineMaterial = new THREE.LineDashedMaterial({
      color: 0xffb703,
      dashSize: 0.35,
      gapSize: 0.2,
      linewidth: 1,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });

    // add oncli
  }

  _disposeMaterials() {
    try {
      this._sphereGeometry?.dispose?.();
      this._anchorBaseMaterial?.dispose?.();
      this._anchorSelectedMaterial?.dispose?.();
      this._weightBaseMaterial?.dispose?.();
      this._weightSelectedMaterial?.dispose?.();
      this._weightLineMaterial?.dispose?.();
    } catch {
      /* noop */
    }
    this._sphereGeometry = null;
    this._anchorBaseMaterial = null;
    this._anchorSelectedMaterial = null;
    this._weightBaseMaterial = null;
    this._weightSelectedMaterial = null;
    this._weightLineMaterial = null;
  }

  _buildPreviewGroup() {
    const scene = this.viewer?.scene;
    if (!scene) return;

    this._previewGroup = new THREE.Group();
    this._previewGroup.name = `SplineEditorPreview:${this.featureID || ""}`;
    this._previewGroup.userData = this._previewGroup.userData || {};
    this._previewGroup.userData.excludeFromFit = true;
    this._previewGroup.userData.preventRemove = true;
    alert(this._previewGroup.name);

    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 2,
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([], 3));

    this._line = new THREE.Line(geometry, lineMaterial);
    this._line.userData = this._line.userData || {};
    this._line.userData.excludeFromFit = true;
    this._line.renderOrder = 10000;
    this._previewGroup.add(this._line);

    scene.add(this._previewGroup);
  }

  _destroyPreviewGroup() {
    if (!this._previewGroup || !this.viewer?.scene) {
      this._teardownAllTransforms();
      return;
    }
    this._teardownAllTransforms();
    this._removeWeightLines();
    try {
      if (this._line) {
        this._line.geometry?.dispose();
        this._line.material?.dispose();
      }
    } catch {
      /* noop */
    }
    try {
      //this.viewer.scene.remove(this._previewGroup);
    } catch {
      /* noop */
    }
    this._previewGroup = null;
    this._line = null;
    this._objectsById.clear();
    this._weightLines = { start: null, end: null };
  }

  _createTransformControl(id, mesh) {
    console.log(this._previewGroup);
    //this.viewerscene.add(this._previewGroup);
    if (!this.viewer?.scene || !this.viewer?.camera || !this.viewer?.renderer) {
      alert("Cannot create transform control: viewer is not properly initialized.");
      return null;
    }
    if (!TransformControlsDirect) return null;

    const control = new TransformControlsDirect(
      this.viewer.camera,
      this.viewer.renderer.domElement
    );
    control.setMode("translate");
    control.showX = true;
    control.showY = true;
    control.showZ = true;
    control.setSize(1);
    control.enabled = false;
    control.attach(mesh);
    control.userData = control.userData || {};
    control.userData.excludeFromFit = true;
    console.log(control);

    const helper =
      typeof control.getHelper === "function"
        ? control.getHelper()
        : null;


    const changeHandler = () => this._handleTransformChangeFor(id);
    const dragHandler = (event) => this._handleTransformDragging(!!event?.value);
    control.addEventListener("change", changeHandler);
    control.addEventListener("dragging-changed", dragHandler);

    this._transformsById.set(id, { control, helper });
    this._transformListeners.set(id, { changeHandler, dragHandler });
    helper.userData.preventRemove = true;

    this.viewer.scene.add(helper);
    console.log(this);
    window.test = this.viewer.scene.children;
    console.log(this.viewer.scene.children);
    return control;
  }

  _teardownAllTransforms() {
    if (!this._transformsById?.size) {
      this._isTransformDragging = false;
      return;
    }
    for (const [id, transformEntry] of this._transformsById.entries()) {
      const control = transformEntry?.control || null;
      const helper = transformEntry?.helper || null;
      const listeners = this._transformListeners.get(id);
      if (control && listeners) {
        try {
          control.removeEventListener("change", listeners.changeHandler);
        } catch {
          /* noop */
        }
        try {
          control.removeEventListener("dragging-changed", listeners.dragHandler);
        } catch {
          /* noop */
        }
      }
      try {
        control?.detach?.();
      } catch {
        /* noop */
      }
      try {
        control?.dispose?.();
      } catch {
        /* noop */
      }
      if (helper) {
        try {
          this.viewer?.scene?.remove(helper);
        } catch {
          /* noop */
        }
      }
    }
    this._transformsById.clear();
    this._transformListeners.clear();
    this._isTransformDragging = false;
  }

  _attachCanvasEvents() {
    const dom = this.viewer?.renderer?.domElement;
    if (!dom) return;
    this._onCanvasPointerDown = this._handlePointerDown.bind(this);
    dom.addEventListener("pointerdown", this._onCanvasPointerDown, {
      passive: false,
      capture: true,
    });
  }

  _detachCanvasEvents() {
    const dom = this.viewer?.renderer?.domElement;
    if (!dom) return;
    if (this._onCanvasPointerDown) {
      dom.removeEventListener("pointerdown", this._onCanvasPointerDown, {
        capture: true,
      });
      this._onCanvasPointerDown = null;
    }
  }

  _handlePointerDown(event) {
    if (!this.viewer || !this._previewGroup) return;
    if (event.button !== 0) return;
    if (this._isTransformDragging) return;

    if (
      typeof this.options.shouldIgnorePointerEvent === "function" &&
      this.options.shouldIgnorePointerEvent(event)
    ) {
      return;
    }

    const dom = this.viewer?.renderer?.domElement;
    if (!dom) return;
    const rect = dom.getBoundingClientRect();
    const ndc = {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
    };
    this._raycaster.setFromCamera(ndc, this.viewer.camera);

    const activeTransform =
      this._selectedId != null
        ? this._transformsById.get(this._selectedId) || null
        : null;
    const activeHelper = activeTransform?.helper || null;
    const isTransformClick = (() => {
      if (!activeHelper || !activeHelper.visible) return false;
      try {
        const hits = this._raycaster.intersectObject(activeHelper, true);
        return Array.isArray(hits) && hits.length > 0;
      } catch {
        return false;
      }
    })();

    if (isTransformClick) return;

    let consumed = false;

    const consume = () => {
      consumed = true;
      event.stopImmediatePropagation();
      event.preventDefault();
    };

    const intersects = [];
    for (const entry of this._objectsById.values()) {
      if (entry?.mesh) {
        intersects.push(entry.mesh);
      }
    }

    if (intersects.length) {
      let picked = null;
      try {
        const hits = this._raycaster.intersectObjects(intersects, true);
        if (Array.isArray(hits) && hits.length > 0) {
          picked = hits[0]?.object || null;
        }
      } catch {
        picked = null;
      }
      if (picked) {
        for (const [id, entry] of this._objectsById.entries()) {
          if (entry.mesh === picked) {
            consume();
            this.selectObject(id);
            return;
          }
        }
      }
    }

    if (!consumed && this._selectedId) {
      consume();
      this.selectObject(null);
    }
  }

  _rebuildAll({ preserveSelection }) {
    const previousSelection = preserveSelection ? this._selectedId : null;
    this._buildPointHandles();
    this._rebuildPreviewLine();
    if (preserveSelection && previousSelection) {
      this.selectObject(previousSelection, { silent: true });
    } else if (!preserveSelection) {
      this.selectObject(null, { silent: true });
    }
  }

  _buildPointHandles() {
    if (!this._previewGroup) return;

    this._teardownAllTransforms();

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
    this._removeWeightLines();

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
      mesh.onclick = () => {
        alert(`Point ${pt.id} clicked`);
        this.selectObject(`point:${pt.id}`);
      }
      const entryId = `point:${pt.id}`;
      const transform = this._createTransformControl(entryId, mesh);
      this._objectsById.set(entryId, {
        type: "point",
        mesh,
        data: pt,
        transform,
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
    const startId = "weight:start";
    const startTransform = this._createTransformControl(startId, startMesh);
    this._objectsById.set(startId, {
      type: "weight",
      mesh: startMesh,
      data: this._splineData.startWeight,
      transform: startTransform,
    });

    const endMesh = new THREE.Mesh(geom, this._weightBaseMaterial);
    endMesh.position.set(
      Number(this._splineData.endWeight.position[0]) || 0,
      Number(this._splineData.endWeight.position[1]) || 0,
      Number(this._splineData.endWeight.position[2]) || 0
    );
    endMesh.name = "SplineWeightEnd";
    this._previewGroup.add(endMesh);
    const endId = "weight:end";
    const endTransform = this._createTransformControl(endId, endMesh);
    this._objectsById.set(endId, {
      type: "weight",
      mesh: endMesh,
      data: this._splineData.endWeight,
      transform: endTransform,
    });

    this._updateSelectionVisuals();
    this._updateTransformVisibility();
    this._ensureWeightLine("start");
    this._ensureWeightLine("end");
    this._updateWeightLines();
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

  _handleTransformChangeFor(id = null) {
    const targetId =
      id && this._objectsById.has(id) ? id : this._selectedId;
    if (!targetId) return;
    const entry = this._objectsById.get(targetId);
    if (!entry || !entry.mesh || !entry.data) return;
    const pos = entry.mesh.position;
    entry.data.position = [pos.x, pos.y, pos.z];
    this._rebuildPreviewLine();
    this._updateWeightLines();
    this._notifySplineChange("transform", { selection: targetId });
    this._renderOnce();
  }

  _handleTransformDragging(isDragging) {
    const dragging = !!isDragging;
    this._isTransformDragging = dragging;
    try {
      if (this.viewer?.controls) {
        this.viewer.controls.enabled = !dragging;
      }
    } catch {
      /* noop */
    }
  }

  _ensureWeightLine(kind) {
    if (!this._previewGroup || !this._weightLineMaterial) return;
    const isStart = kind === "start";
    const anchor = isStart
      ? this._splineData.points?.[0]?.position
      : this._splineData.points?.[this._splineData.points.length - 1]?.position;
    const weight = isStart
      ? this._splineData.startWeight?.position
      : this._splineData.endWeight?.position;
    if (!anchor || !weight) return;

    const existing = this._weightLines[kind];
    if (existing) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [anchor[0], anchor[1], anchor[2], weight[0], weight[1], weight[2]],
        3
      )
    );

    const line = new THREE.LineSegments(geometry, this._weightLineMaterial);
    line.computeLineDistances?.();
    line.name = `SplineWeightLine:${kind}`;
    this._previewGroup.add(line);
    this._weightLines[kind] = line;
  }

  _removeWeightLines(kind = null) {
    if (!this._weightLines) {
      this._weightLines = { start: null, end: null };
    }
    const keys = kind ? [kind] : ["start", "end"];
    for (const key of keys) {
      const line = this._weightLines[key];
      if (line) {
        try {
          this._previewGroup?.remove(line);
        } catch {
          /* noop */
        }
        try {
          line.geometry?.dispose();
        } catch {
          /* noop */
        }
      }
      this._weightLines[key] = null;
    }
  }

  _updateWeightLines() {
    const updateLine = (line, anchor, weight) => {
      if (!line || !anchor || !weight) return;
      const posAttr = line.geometry.getAttribute("position");
      if (!posAttr) {
        line.geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(
            [anchor[0], anchor[1], anchor[2], weight[0], weight[1], weight[2]],
            3
          )
        );
      } else {
        const arr = posAttr.array;
        arr[0] = anchor[0];
        arr[1] = anchor[1];
        arr[2] = anchor[2];
        arr[3] = weight[0];
        arr[4] = weight[1];
        arr[5] = weight[2];
        posAttr.needsUpdate = true;
      }
      line.computeLineDistances?.();
      line.geometry.computeBoundingSphere?.();
    };

    const startAnchor = this._splineData.points?.[0]?.position;
    const endAnchor =
      this._splineData.points?.[this._splineData.points.length - 1]?.position;
    const startWeight = this._splineData.startWeight?.position;
    const endWeight = this._splineData.endWeight?.position;

    if (startAnchor && startWeight) {
      if (!this._weightLines.start) this._ensureWeightLine("start");
      updateLine(this._weightLines?.start, startAnchor, startWeight);
    } else {
      this._removeWeightLines("start");
    }

    if (endAnchor && endWeight) {
      if (!this._weightLines.end) this._ensureWeightLine("end");
      updateLine(this._weightLines?.end, endAnchor, endWeight);
    } else {
      this._removeWeightLines("end");
    }
  }
}
