import * as THREE from "three";
import { CombinedTransformControls as TransformControlsDirect } from "../../UI/controls/CombinedTransformControls.js";
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
    this._extensionLines = new Map();
    this._selectedId = null;
    this._hiddenArtifacts = [];
    this._raycaster = new THREE.Raycaster();

    this._transformsById = new Map();
    this._transformListeners = new Map();
    this._isTransformDragging = false;
    this._onCanvasPointerDown = null;

    this._weightLineMaterial = null;

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
    console.log(`SplineEditorSession: _updateTransformVisibility called, selectedId=${this._selectedId}, transforms count=${this._transformsById?.size || 0}`);
    
    if (!this._transformsById) {
      console.log(`SplineEditorSession: no _transformsById map`);
      return;
    }
    
    for (const [id, transformEntry] of this._transformsById.entries()) {
      if (!transformEntry) {
        console.log(`SplineEditorSession: no transformEntry for ${id}`);
        continue;
      }
      const { control } = transformEntry;
      const active = id === this._selectedId;
      
      console.log(`SplineEditorSession: updating transform ${id}, active=${active}, control exists=${!!control}`);
      
      if (control) {
        control.enabled = active;
        control.visible = active;
        console.log(`SplineEditorSession: set transform ${id} enabled=${active}, visible=${active}`);
      }
    }
    if (!this._selectedId) {
      console.log(`SplineEditorSession: no selection, setting dragging to false`);
      this._isTransformDragging = false;
    }
  }

  isActive() {
    return this._active;
  }

  hasTransformControls() {
    return this._transformsById && this._transformsById.size > 0;
  }

  getTransformControlCount() {
    return this._transformsById ? this._transformsById.size : 0;
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
    console.log(`SplineEditorSession: setSplineData called`, {
      reason: options.reason,
      silent: options.silent,
      preserveSelection: options.preserveSelection
    });
    
    const {
      preserveSelection = true,
      silent = false,
      reason = "manual",
    } = options;
    
    const normalized = normalizeSplineData(cloneSplineData(spline));
    this._splineData = normalized;
    
    // CRITICAL FIX: Don't rebuild everything if this is just a transform update
    if (reason === "transform" && preserveSelection) {
      console.log(`SplineEditorSession: transform update - skipping full rebuild to preserve controls`);
      // Just update the preview line, don't rebuild point handles (which destroys transforms)
      this._rebuildPreviewLine();
      this._updateExtensionLines();
    } else {
      console.log(`SplineEditorSession: full rebuild required for reason=${reason}`);
      this._rebuildAll({ preserveSelection });
    }
    
    if (!silent) {
      this._notifySplineChange(reason);
    } else {
      this._renderOnce();
    }
  }

  selectObject(id, options = {}) {
    console.log(`SplineEditorSession: selectObject called with id=${id}, current=${this._selectedId}`);
    const selectStart = performance.now();
    
    const { silent = false } = options || {};
    const nextId = id == null ? null : String(id);
    
    if (this._selectedId === nextId) {
      console.log(`SplineEditorSession: same selection, no change needed`);
      if (!silent) {
        this._notifySelectionChange(this._selectedId);
      }
      return;
    }
    
    this._selectedId = nextId;
    console.log(`SplineEditorSession: selection changed to ${nextId}`);
    
    const visualStart = performance.now();
    this._updateSelectionVisuals();
    console.log(`SplineEditorSession: _updateSelectionVisuals took ${(performance.now() - visualStart).toFixed(1)}ms`);
    
    const transformStart = performance.now();
    this._updateTransformVisibility();
    console.log(`SplineEditorSession: _updateTransformVisibility took ${(performance.now() - transformStart).toFixed(1)}ms`);
    
    if (!silent) {
      const notifyStart = performance.now();
      this._notifySelectionChange(this._selectedId);
      console.log(`SplineEditorSession: _notifySelectionChange took ${(performance.now() - notifyStart).toFixed(1)}ms`);
    }
    
    this._renderOnce();
    console.log(`SplineEditorSession: selectObject completed in ${(performance.now() - selectStart).toFixed(1)}ms`);
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
    this._weightLineMaterial = new THREE.LineDashedMaterial({
      color: 0xffb703,
      dashSize: 0.35,
      gapSize: 0.2,
      linewidth: 1,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
  }

  _disposeMaterials() {
    try {
      this._weightLineMaterial?.dispose?.();
    } catch {
      /* noop */
    }
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
    this._removeExtensionLines();
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
    this._extensionLines.clear();
  }

  _createTransformControl(id, mesh) {
    console.log(`SplineEditorSession: _createTransformControl called for ${id}, mesh exists=${!!mesh}`);
    
    if (!this.viewer?.scene || !this.viewer?.camera || !this.viewer?.renderer) {
      console.warn("Cannot create transform control: viewer is not properly initialized.");
      return null;
    }
    if (!TransformControlsDirect) {
      console.warn("TransformControlsDirect not available");
      return null;
    }

    console.log(`SplineEditorSession: creating TransformControlsDirect for ${id}`);
    const control = new TransformControlsDirect(
      this.viewer.camera,
      this.viewer.renderer.domElement
    );
    
    // Enable both translation and rotation
    control.setMode("translate");
    control.showX = true;
    control.showY = true;
    control.showZ = true;
    control.setSize(1.6);
    control.enabled = false; // Will be enabled when selected
    control.attach(mesh);
    control.userData = control.userData || {};
    control.userData.excludeFromFit = true;

    console.log(`SplineEditorSession: transform control created for ${id}, attached to mesh`);

    // Add keyboard listener to switch between translate and rotate modes
    const keyHandler = (event) => {
      if (control.enabled && (event.key === 'r' || event.key === 'R')) {
        event.preventDefault();
        const currentMode = control.getMode();
        control.setMode(currentMode === 'translate' ? 'rotate' : 'translate');
        console.log(`SplineEditorSession: switched transform mode to ${control.getMode()} for ${id}`);
      }
    };
    document.addEventListener('keydown', keyHandler);

    // Add the transform control directly to the scene
    this.viewer.scene.add(control);
    console.log(`SplineEditorSession: transform control added to scene for ${id}`);

    const changeHandler = () => this._handleTransformChangeFor(id);
    const dragHandler = (event) => {
      console.log(`SplineEditorSession: drag event for ${id}, dragging=${!!event?.value}`);
      this._handleTransformDragging(!!event?.value);
    };
    control.addEventListener("change", changeHandler);
    control.addEventListener("dragging-changed", dragHandler);

    this._transformsById.set(id, { control, keyHandler });
    this._transformListeners.set(id, { changeHandler, dragHandler });
    
    console.log(`SplineEditorSession: transform control setup complete for ${id}`);
    return control;
  }

  _teardownAllTransforms() {
    console.log(`SplineEditorSession: _teardownAllTransforms called, transforms count=${this._transformsById?.size || 0}`);
    
    if (!this._transformsById?.size) {
      console.log(`SplineEditorSession: no transforms to teardown`);
      this._isTransformDragging = false;
      return;
    }
    
    for (const [id, transformEntry] of this._transformsById.entries()) {
      console.log(`SplineEditorSession: tearing down transform ${id}`);
      
      const control = transformEntry?.control || null;
      const keyHandler = transformEntry?.keyHandler || null;
      const listeners = this._transformListeners.get(id);
      
      if (control && listeners) {
        try {
          control.removeEventListener("change", listeners.changeHandler);
          console.log(`SplineEditorSession: removed change listener for ${id}`);
        } catch (error) {
          console.warn(`SplineEditorSession: error removing change listener for ${id}:`, error);
        }
        try {
          control.removeEventListener("dragging-changed", listeners.dragHandler);
          console.log(`SplineEditorSession: removed drag listener for ${id}`);
        } catch (error) {
          console.warn(`SplineEditorSession: error removing drag listener for ${id}:`, error);
        }
      }
      
      // Remove keyboard listener
      if (keyHandler) {
        try {
          document.removeEventListener('keydown', keyHandler);
          console.log(`SplineEditorSession: removed keyboard listener for ${id}`);
        } catch (error) {
          console.warn(`SplineEditorSession: error removing keyboard listener for ${id}:`, error);
        }
      }
      
      try {
        control?.detach?.();
        console.log(`SplineEditorSession: detached control for ${id}`);
      } catch (error) {
        console.warn(`SplineEditorSession: error detaching control for ${id}:`, error);
      }
      
      // Remove control from scene
      if (control) {
        try {
          this.viewer?.scene?.remove(control);
          console.log(`SplineEditorSession: removed control from scene for ${id}`);
        } catch (error) {
          console.warn(`SplineEditorSession: error removing control from scene for ${id}:`, error);
        }
      }
      
      try {
        control?.dispose?.();
        console.log(`SplineEditorSession: disposed control for ${id}`);
      } catch (error) {
        console.warn(`SplineEditorSession: error disposing control for ${id}:`, error);
      }
    }
    this._transformsById.clear();
    this._transformListeners.clear();
    this._isTransformDragging = false;
    console.log(`SplineEditorSession: all transforms torn down`);
  }

  _attachCanvasEvents() {
    // Skip canvas event attachment since we're using UI buttons for selection
    // This prevents performance issues from pointer event handling
    return;
  }

  _detachCanvasEvents() {
    // Canvas events are not attached, so nothing to detach
    return;
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

    // Only handle clicks on our objects, don't clear selection on blank clicks
    const dom = this.viewer?.renderer?.domElement;
    if (!dom) return;
    const rect = dom.getBoundingClientRect();
    const ndc = {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
    };
    this._raycaster.setFromCamera(ndc, this.viewer.camera);

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
            event.stopImmediatePropagation();
            event.preventDefault();
            this.selectObject(id);
            return;
          }
        }
      }
    }
    
    // Don't clear selection on blank clicks - removed this functionality
  }

  _rebuildAll({ preserveSelection }) {
    console.log(`SplineEditorSession: _rebuildAll called, preserveSelection=${preserveSelection}, currentSelection=${this._selectedId}`);
    
    const previousSelection = preserveSelection ? this._selectedId : null;
    
    console.log(`SplineEditorSession: calling _buildPointHandles - THIS TEARS DOWN TRANSFORMS!`);
    this._buildPointHandles();
    
    console.log(`SplineEditorSession: rebuilding preview line`);
    this._rebuildPreviewLine();
    
    if (preserveSelection && previousSelection) {
      console.log(`SplineEditorSession: restoring selection to ${previousSelection}`);
      this.selectObject(previousSelection, { silent: true });
    } else if (!preserveSelection) {
      console.log(`SplineEditorSession: clearing selection`);
      this.selectObject(null, { silent: true });
    }
    
    console.log(`SplineEditorSession: _rebuildAll completed`);
  }

  _buildPointHandles() {
    console.log(`SplineEditorSession: _buildPointHandles called - DANGER: this tears down all transforms!`);
    
    if (!this._previewGroup) return;

    console.log(`SplineEditorSession: tearing down all transforms in _buildPointHandles`);
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
    this._removeExtensionLines();

    this._initMaterials();

    // Create handles for each point - no separate extension handles
    this._splineData.points.forEach((pt, index) => {
      // Create a simple point geometry for invisible click target
      const pointGeometry = new THREE.BufferGeometry();
      const position = new Float32Array([
        Number(pt.position[0]) || 0,
        Number(pt.position[1]) || 0,
        Number(pt.position[2]) || 0
      ]);
      pointGeometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
      
      // Create an invisible mesh for raycasting and transform attachment
      const pointMaterial = new THREE.MeshBasicMaterial({ visible: false });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), pointMaterial);
      mesh.position.set(position[0], position[1], position[2]);
      
      // Apply stored rotation to the mesh
      if (pt.rotation && Array.isArray(pt.rotation) && pt.rotation.length === 9) {
        const rotMatrix = new THREE.Matrix3().fromArray(pt.rotation);
        const matrix4 = new THREE.Matrix4().setFromMatrix3(rotMatrix);
        mesh.setRotationFromMatrix(matrix4);
      }
      
      mesh.name = `SplinePoint:${pt.id}`;
      this._previewGroup.add(mesh);
      
      const entryId = `point:${pt.id}`;
      const transform = this._createTransformControl(entryId, mesh);
      this._objectsById.set(entryId, {
        type: "point",
        mesh,
        data: pt,
        transform,
      });
    });

    this._updateTransformVisibility();
    this._ensureExtensionLines();
    this._updateExtensionLines();
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
    // Currently no visual selection indicators since we removed sphere visibility
    // This method is kept for compatibility and future enhancements
  }

  _handleTransformChangeFor(id = null) {
    console.log(`SplineEditorSession: _handleTransformChangeFor called for ${id}, dragging=${this._isTransformDragging}`);
    
    const targetId =
      id && this._objectsById.has(id) ? id : this._selectedId;
    if (!targetId) return;
    const entry = this._objectsById.get(targetId);
    if (!entry || !entry.mesh || !entry.data) return;
    
    const pos = entry.mesh.position;
    const rot = entry.mesh.rotation;
    
    if (entry.type === "point") {
      // Update point position
      entry.data.position = [pos.x, pos.y, pos.z];
      
      // Update point rotation - extract rotation matrix from mesh
      const rotMatrix = new THREE.Matrix3().setFromMatrix4(entry.mesh.matrix);
      entry.data.rotation = rotMatrix.elements.slice(); // Store as flat array
      
      console.log(`SplineEditorSession: updated point ${id} position to [${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}]`);
    }
    
    console.log(`SplineEditorSession: rebuilding preview (not full rebuild)`);
    this._rebuildPreviewLine();
    this._updateExtensionLines();
    
    console.log(`SplineEditorSession: notifying spline change - THIS MAY CAUSE REFRESH LOOP`);
    this._notifySplineChange("transform", { selection: targetId });
    this._renderOnce();
  }

  _handleTransformDragging(isDragging) {
    const dragging = !!isDragging;
    console.log(`SplineEditorSession: _handleTransformDragging called, isDragging=${dragging}, current=${this._isTransformDragging}`);
    
    this._isTransformDragging = dragging;
    
    try {
      if (this.viewer?.controls) {
        this.viewer.controls.enabled = !dragging;
        console.log(`SplineEditorSession: set viewer controls enabled=${!dragging}`);
      }
    } catch (error) {
      console.warn(`SplineEditorSession: error setting viewer controls:`, error);
    }
    
    // Important: Do NOT clear transforms when dragging stops!
    // This was causing the gizmos to disappear after dragging
    console.log(`SplineEditorSession: transform dragging state updated, selectedId=${this._selectedId}`);
  }

  _ensureExtensionLines() {
    if (!this._previewGroup || !this._weightLineMaterial) return;
    
    this._splineData.points.forEach((pt, index) => {
      const forwardKey = `forward-line:${pt.id}`;
      const backwardKey = `backward-line:${pt.id}`;
      
      // Forward extension line
      if (!this._extensionLines.has(forwardKey)) {
        const geometry = new THREE.BufferGeometry();
        const line = new THREE.LineSegments(geometry, this._weightLineMaterial);
        line.name = `SplineForwardLine:${pt.id}`;
        this._previewGroup.add(line);
        this._extensionLines.set(forwardKey, line);
      }
      
      // Backward extension line
      if (!this._extensionLines.has(backwardKey)) {
        const geometry = new THREE.BufferGeometry();
        const line = new THREE.LineSegments(geometry, this._weightLineMaterial);
        line.name = `SplineBackwardLine:${pt.id}`;
        this._previewGroup.add(line);
        this._extensionLines.set(backwardKey, line);
      }
    });
  }

  _removeExtensionLines() {
    for (const line of this._extensionLines.values()) {
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
    }
    this._extensionLines.clear();
  }

  _updateExtensionLines() {
    const updateLine = (line, anchor, direction, distance) => {
      if (!line || !anchor || !direction || distance <= 0) return;
      const posAttr = line.geometry.getAttribute("position");
      const start = anchor;
      const end = [
        anchor[0] + direction[0] * distance,
        anchor[1] + direction[1] * distance,
        anchor[2] + direction[2] * distance
      ];
      
      if (!posAttr) {
        line.geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(
            [start[0], start[1], start[2], end[0], end[1], end[2]],
            3
          )
        );
      } else {
        const arr = posAttr.array;
        arr[0] = start[0];
        arr[1] = start[1];
        arr[2] = start[2];
        arr[3] = end[0];
        arr[4] = end[1];
        arr[5] = end[2];
        posAttr.needsUpdate = true;
      }
      line.computeLineDistances?.();
      line.geometry.computeBoundingSphere?.();
    };

    this._splineData.points.forEach((pt, index) => {
      const forwardLine = this._extensionLines.get(`forward-line:${pt.id}`);
      const backwardLine = this._extensionLines.get(`backward-line:${pt.id}`);
      
      // Get X-axis direction from stored rotation matrix
      const rotation = pt.rotation || [1, 0, 0, 0, 1, 0, 0, 0, 1];
      let xAxisDirection = [rotation[0], rotation[1], rotation[2]]; // X-axis from rotation matrix
      
      // Normalize the direction (should already be normalized, but just in case)
      const length = Math.sqrt(
        xAxisDirection[0] * xAxisDirection[0] + 
        xAxisDirection[1] * xAxisDirection[1] + 
        xAxisDirection[2] * xAxisDirection[2]
      );
      if (length > 0) {
        xAxisDirection = [
          xAxisDirection[0] / length,
          xAxisDirection[1] / length,
          xAxisDirection[2] / length
        ];
      }
      
      // Apply flip if needed
      const forwardDir = pt.flipDirection ? 
        [-xAxisDirection[0], -xAxisDirection[1], -xAxisDirection[2]] : 
        xAxisDirection;
      const backwardDir = pt.flipDirection ? 
        xAxisDirection : 
        [-xAxisDirection[0], -xAxisDirection[1], -xAxisDirection[2]];
      
      if (forwardLine) {
        updateLine(forwardLine, pt.position, forwardDir, pt.forwardDistance);
      }
      
      if (backwardLine) {
        updateLine(backwardLine, pt.position, backwardDir, pt.backwardDistance);
      }
    });
  }
}
