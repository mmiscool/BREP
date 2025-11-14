import * as THREE from "three";
import { CombinedTransformControls as TransformControlsDirect } from "../../UI/controls/CombinedTransformControls.js";
import { BREP } from "../../BREP/BREP.js";
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
    if (!this._transformsById) {
      return;
    }

    // Check if preview group exists, if not rebuild it
    this._ensurePreviewGroup();

    for (const [id, transformEntry] of this._transformsById.entries()) {
      if (!transformEntry) {
        continue;
      }
      const { control } = transformEntry;
      const active = id === this._selectedId;

      if (control) {
        control.enabled = active;
        control.visible = active;

        // Ensure proper scene management - remove from scene when inactive
        if (this.viewer?.scene) {
          if (active) {
            // Add to scene if not already present
            if (!this.viewer.scene.children.includes(control)) {
              this.viewer.scene.add(control);
            }
          } else {
            // Remove from scene when inactive
            if (this.viewer.scene.children.includes(control)) {
              this.viewer.scene.remove(control);
            }
          }
        }
      }
    }
    if (!this._selectedId) {
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
   * @param {string} [options.initialSelection]
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

    // Set up initial selection before rebuild
    const initialSelection = options.initialSelection || null;
    if (initialSelection) {
      this._selectedId = initialSelection;
    }

    this._rebuildAll({ preserveSelection: !!initialSelection });

    this._active = true;

    // Register with viewer to enable spline mode (suppress normal scene picking)
    if (this.viewer && typeof this.viewer.startSplineMode === 'function') {
      this.viewer.startSplineMode(this);
    }

    // Hook into viewer's controls change event to update transform controls
    this._setupControlsListener();

    this._notifySelectionChange(this._selectedId);
    this._renderOnce();
    return true;
  }

  /**
   * Tear down preview/controls and restore original artifacts.
   */
  dispose() {
    // Unregister from viewer to disable spline mode
    if (this.viewer && typeof this.viewer.endSplineMode === 'function') {
      this.viewer.endSplineMode();
    }

    // Remove controls change listener
    this._teardownControlsListener();

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

    // Update the feature's persistent data immediately
    this._updateFeaturePersistentData();

    // CRITICAL FIX: Don't rebuild everything if this is just a transform update
    if (reason === "transform" && preserveSelection) {
      // Just update the preview line, don't rebuild point handles (which destroys transforms)
      this._rebuildPreviewLine();
      this._updateExtensionLines();
    } else {
      this._rebuildAll({ preserveSelection });
    }

    if (!silent) {
      this._notifySplineChange(reason);
    } else {
      this._renderOnce();
    }
  }

  selectObject(id, options = {}) {
    const selectStart = performance.now();

    const { silent = false, forceRedraw = false } = options || {};
    const nextId = id == null ? null : String(id);

    if (this._selectedId === nextId && !forceRedraw) {
      if (!silent) {
        this._notifySelectionChange(this._selectedId);
      }
      return;
    }

    // Ensure preview group exists before changing selection
    this._ensurePreviewGroup();

    this._selectedId = nextId;

    // If forcing redraw, rebuild everything to ensure fresh state
    if (forceRedraw) {
      this._rebuildAll({ preserveSelection: true });
    }

    const visualStart = performance.now();
    this._updateSelectionVisuals();

    const transformStart = performance.now();
    this._updateTransformVisibility();

    if (!silent) {
      const notifyStart = performance.now();
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

  /**
   * Force cleanup of any stale objects in the scene
   */
  forceCleanup() {

    if (!this.viewer?.scene) return;

    // Find and remove any stale transform controls
    const toRemove = [];
    this.viewer.scene.traverse((obj) => {
      // Look for transform controls that might be stale
      if (obj.type === 'CombinedTransformControls' || obj.isTransformGizmo) {
        // Check if this control is in our current transforms map
        let isValid = false;
        if (this._transformsById) {
          for (const entry of this._transformsById.values()) {
            if (entry.control === obj) {
              isValid = true;
              break;
            }
          }
        }
        if (!isValid) {
          toRemove.push(obj);
        }
      }
    });

    // Remove stale objects
    for (const obj of toRemove) {
      try {
        this.viewer.scene.remove(obj);
        obj.dispose?.();
      } catch (error) {
        /* ignore */
      }
    }

    this._renderOnce();
  }

  _renderOnce() {
    try {
      this.viewer?.render?.();
    } catch {
      /* noop */
    }
  }

  _setupControlsListener() {
    // Listen to camera/controls changes to update transform controls screen size
    this._controlsChangeHandler = () => {
      if (this._transformsById) {
        for (const [id, transformEntry] of this._transformsById.entries()) {
          const control = transformEntry?.control;
          if (control && typeof control.update === 'function') {
            try {
              control.update();
            } catch (error) {
              console.warn(`SplineEditorSession: Failed to update transform control ${id}:`, error);
            }
          }
        }
      }
    };

    // Hook into the viewer's controls change event
    if (this.viewer?.controls && typeof this.viewer.controls.addEventListener === 'function') {
      this.viewer.controls.addEventListener('change', this._controlsChangeHandler);
      this.viewer.controls.addEventListener('end', this._controlsChangeHandler);
    }
  }

  _teardownControlsListener() {
    if (this._controlsChangeHandler && this.viewer?.controls) {
      try {
        this.viewer.controls.removeEventListener('change', this._controlsChangeHandler);
        this.viewer.controls.removeEventListener('end', this._controlsChangeHandler);
      } catch (error) {
        console.warn('SplineEditorSession: Failed to remove controls listeners:', error);
      }
    }
    this._controlsChangeHandler = null;
  }

  _notifySplineChange(reason, extra = null) {
    try {
      this._onSplineChange(this.getSplineData(), reason, extra);
    } catch {
      /* ignore listener errors */
    }
  }

  _updateFeaturePersistentData() {
    // Update the feature's persistent data immediately
    if (this._featureRef) {
      this._featureRef.persistentData = this._featureRef.persistentData || {};
      this._featureRef.persistentData.spline = cloneSplineData(this._splineData);
      
      // Mark the feature as dirty for rebuild
      this._featureRef.lastRunInputParams = {};
      this._featureRef.timestamp = 0;
      this._featureRef.dirty = true;
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



    // remove the actual spline from the scene. The spline generated by the feature it self, not the preview
    // The object to be removed from the scene will have the same name as the feature ID
    const existingSpline = scene.getObjectByName(this.featureID);
    if (existingSpline) {
      scene.remove(existingSpline);
    }

    // Search the scene for an existing preview group and reuse it rather than creating a new one
    const existingGroupName = `SplineEditorPreview:${this.featureID || ""}`;
    const existingGroup = scene.getObjectByName(existingGroupName);
    if (existingGroup) {
      this._previewGroup = existingGroup;
      // remove all children from existing group
      while (this._previewGroup.children.length > 0) {
        this._previewGroup.remove(this._previewGroup.children[0]);
      }
    } else {
      this._previewGroup = new THREE.Group();
    }


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

  _ensurePreviewGroup() {
    const scene = this.viewer.scene;
    // remove the actual spline from the scene. The spline generated by the feature it self

    // search the scene children for the 



    // Check if the preview group still exists in the scene
    if (!this._previewGroup || !this.viewer?.scene) {
      this._buildPreviewGroup();
      return;
    }

    // Check if the preview group was removed from the scene

    const existingGroupName = `SplineEditorPreview:${this.featureID || ""}`;
    const foundInScene = scene.getObjectByName(existingGroupName);

    if (!foundInScene) {
      // Preview group was removed, sync with latest persistent data and rebuild
      const latestSplineData = this._featureRef?.persistentData?.spline;
      if (latestSplineData) {
        this._splineData = normalizeSplineData(cloneSplineData(latestSplineData));
      }

      // Update preview resolution from current feature parameters
      const resCandidate = Number(this._featureRef?.inputParams?.curveResolution);
      if (Number.isFinite(resCandidate) && resCandidate >= 4) {
        this._previewResolution = Math.max(4, Math.floor(resCandidate));
      }

      this._buildPreviewGroup();
      this._rebuildAll({ preserveSelection: true });
    }
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
    if (!this.viewer?.scene || !this.viewer?.camera || !this.viewer?.renderer) {

      return null;
    }
    if (!TransformControlsDirect) {

      return null;
    }
    const control = new TransformControlsDirect(
      this.viewer.camera,
      this.viewer.renderer.domElement
    );

    control.name = `SplineEditorControl:${id}`;

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
    // Add keyboard listener to switch between translate and rotate modes
    const keyHandler = (event) => {
      if (control.enabled && (event.key === 'r' || event.key === 'R')) {
        event.preventDefault();
        const currentMode = control.getMode();
        control.setMode(currentMode === 'translate' ? 'rotate' : 'translate');
      }
    };
    document.addEventListener('keydown', keyHandler);

    // Add the transform control directly to the scene
    this.viewer.scene.add(control);

    const changeHandler = () => this._handleTransformChangeFor(id);
    const dragHandler = (event) => {
      this._handleTransformDragging(!!event?.value);
    };
    control.addEventListener("change", changeHandler);
    control.addEventListener("dragging-changed", dragHandler);

    this._transformsById.set(id, { control, keyHandler });
    this._transformListeners.set(id, { changeHandler, dragHandler });
    return control;
  }

  _teardownAllTransforms() {
    //  alert(`Tearing down all transforms`);

    if (!this._transformsById?.size) {
      this._isTransformDragging = false;
      return;
    }

    for (const [id, transformEntry] of this._transformsById.entries()) {

      const control = transformEntry?.control || null;
      const keyHandler = transformEntry?.keyHandler || null;
      const listeners = this._transformListeners.get(id);

      if (control && listeners) {
        try {
          control.removeEventListener("change", listeners.changeHandler);
        } catch (error) {
          /* ignore */
        }
        try {
          control.removeEventListener("dragging-changed", listeners.dragHandler);
        } catch (error) {
          /* ignore */
        }
      }

      // Remove keyboard listener
      if (keyHandler) {
        try {
          document.removeEventListener('keydown', keyHandler);
        } catch (error) {
          /* ignore */
        }
      }

      try {
        control?.detach?.();
      } catch (error) {
        /* ignore */
      }

      // Remove control from scene
      if (control) {
        try {
          this.viewer?.scene?.remove(control);
        } catch (error) {
          /* ignore */
        }
      }

      try {
        control?.dispose?.();
      } catch (error) {
        /* ignore */
      }
    }
    this._transformsById.clear();
    this._transformListeners.clear();
    this._isTransformDragging = false;
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

    // Force cleanup of any stale objects before rebuild
    this.forceCleanup();

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

    // More thorough cleanup of stale objects
    const stale = [];
    for (const entry of this._objectsById.values()) {
      if (entry.mesh) {
        stale.push(entry.mesh);
        // Also dispose mesh geometry and materials to prevent memory leaks
        try {
          entry.mesh.geometry?.dispose();
          entry.mesh.material?.dispose();
        } catch {
          /* noop */
        }
      }
    }

    // Remove from preview group and scene
    for (const mesh of stale) {
      try {
        if (mesh.parent) {
          mesh.parent.remove(mesh);
        }
        // Also remove directly from scene in case it's there
        if (this.viewer?.scene?.children.includes(mesh)) {
          this.viewer.scene.remove(mesh);
        }
      } catch (error) {
        /* ignore */
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

      // Create a clickable vertex at the same position using BREP.Vertex
      const vertex = new BREP.Vertex([position[0], position[1], position[2]], {
        name: `SplineVertex:${pt.id}`,
      });

      // Add click handler to the vertex to trigger selection
      vertex.onClick = () => {
        this.selectObject(`point:${pt.id}`);
      };

      // Store reference to the point for identification - set on both vertex and internal point
      vertex.userData = vertex.userData || {};
      vertex.userData.splineFeatureId = this.featureID;
      vertex.userData.splinePointId = pt.id;
      vertex.userData.isSplineVertex = true;

      // Also set userData on the internal Points object that gets hit by raycaster
      if (vertex._point) {
        vertex._point.userData = vertex._point.userData || {};
        vertex._point.userData.splineFeatureId = this.featureID;
        vertex._point.userData.splinePointId = pt.id;
        vertex._point.userData.isSplineVertex = true;
        // Copy the onClick handler to the internal point
        vertex._point.onClick = vertex.onClick;
      }

      // Add vertex to preview group
      this._previewGroup.add(vertex);

      const entryId = `point:${pt.id}`;
      const transform = this._createTransformControl(entryId, mesh);
      this._objectsById.set(entryId, {
        type: "point",
        mesh,
        vertex, // Store reference to the clickable vertex
        data: pt,
        transform,
      });
    });

    // Create handles for start and end weights
    const weights = [
      { key: "weight:start", keyName: "startWeight", data: this._splineData.startWeight },
      { key: "weight:end", keyName: "endWeight", data: this._splineData.endWeight }
    ];

    weights.forEach(({ key, keyName, data }) => {
      if (!data || !data.position) return;

      const position = new Float32Array([
        Number(data.position[0]) || 0,
        Number(data.position[1]) || 0,
        Number(data.position[2]) || 0
      ]);

      // Create an invisible mesh for raycasting and transform attachment
      const weightMaterial = new THREE.MeshBasicMaterial({ visible: false });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), weightMaterial);
      mesh.position.set(position[0], position[1], position[2]);
      mesh.name = `SplineWeight:${keyName}`;
      this._previewGroup.add(mesh);

      // Create a clickable vertex at the same position using BREP.Vertex
      const vertex = new BREP.Vertex([position[0], position[1], position[2]], {
        name: `SplineWeightVertex:${keyName}`,
      });

      // Add click handler to the vertex to trigger selection
      vertex.onClick = () => {
        this.selectObject(key);
      };

      // Store reference to the weight for identification - set on both vertex and internal point
      vertex.userData = vertex.userData || {};
      vertex.userData.splineFeatureId = this.featureID;
      vertex.userData.splineWeightKey = keyName;
      vertex.userData.isSplineWeight = true;

      // Also set userData on the internal Points object that gets hit by raycaster
      if (vertex._point) {
        vertex._point.userData = vertex._point.userData || {};
        vertex._point.userData.splineFeatureId = this.featureID;
        vertex._point.userData.splineWeightKey = keyName;
        vertex._point.userData.isSplineWeight = true;
        // Copy the onClick handler to the internal point
        vertex._point.onClick = vertex.onClick;
      }

      // Add vertex to preview group
      this._previewGroup.add(vertex);

      const transform = this._createTransformControl(key, mesh);
      this._objectsById.set(key, {
        type: "weight",
        mesh,
        vertex, // Store reference to the clickable vertex
        data,
        keyName, // Store the key name for easy access
        transform,
      });
    });

    this._updateTransformVisibility();
    this._ensureExtensionLines();
    this._updateExtensionLines();
  }

  _rebuildPreviewLine() {
    if (!this._line) return;

    // Clean up old geometry to prevent memory leaks
    const oldGeometry = this._line.geometry;
    if (oldGeometry) {
      // Clear old attributes
      const positionAttr = oldGeometry.getAttribute("position");
      if (positionAttr) {
        positionAttr.needsUpdate = true;
      }
    }

    const bendRadius = Number.isFinite(Number(this._featureRef?.inputParams?.bendRadius))
      ? Math.max(0.1, Math.min(5.0, Number(this._featureRef.inputParams.bendRadius)))
      : 1.0;

    const { positions } = buildHermitePolyline(
      this._splineData,
      this._previewResolution || DEFAULT_RESOLUTION,
      bendRadius
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
    // Update vertex selection states to show which vertex is selected
    for (const [id, entry] of this._objectsById.entries()) {
      if (entry.vertex) {
        const isSelected = id === this._selectedId;
        entry.vertex.selected = isSelected;
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
    const rot = entry.mesh.rotation;

    if (entry.type === "point") {
      // Update point position
      entry.data.position = [pos.x, pos.y, pos.z];

      // Update point rotation - extract rotation matrix from mesh
      const rotMatrix = new THREE.Matrix3().setFromMatrix4(entry.mesh.matrix);
      entry.data.rotation = rotMatrix.elements.slice(); // Store as flat array

      // Update the vertex position to match the mesh
      if (entry.vertex) {
        entry.vertex.position.set(pos.x, pos.y, pos.z);
      }

    } else if (entry.type === "weight") {
      // Update weight position
      entry.data.position = [pos.x, pos.y, pos.z];

      // Update the vertex position to match the mesh
      if (entry.vertex) {
        entry.vertex.position.set(pos.x, pos.y, pos.z);
      }

    }

    // Update persistent data immediately after transform changes
    this._updateFeaturePersistentData();

    this._rebuildPreviewLine();
    this._updateExtensionLines();
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
    } catch (error) {
      /* ignore */
    }

    // Important: Do NOT clear transforms when dragging stops!
    // This was causing the gizmos to disappear after dragging
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
