import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;
import { LineGeometry } from "three/examples/jsm/Addons.js";
import {
  DEFAULT_RESOLUTION,
  normalizeSplineData,
  buildHermitePolyline,
  cloneSplineData,
} from "./splineUtils.js";
import { SplineEditorSession } from "./SplineEditorSession.js";

function renderSplinePointsWidget({ ui, key, controlWrap, row }) {
  const normalizeNumber = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  };
  const formatNumber = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return "0";
    return num.toFixed(3).replace(/\.?0+$/, "") || "0";
  };
  const getFeatureID = () => ui?.params?.featureID != null ? String(ui.params.featureID) : null;
  const getViewer = () => ui?.options?.viewer || null;
  const getPartHistory = () =>
    ui?.options?.partHistory || ui?.options?.viewer?.partHistory || null;
  const getFeatureRef = () => {
    const featureID = getFeatureID();
    if (!featureID) return null;
    const viaOption = ui?.options?.featureRef || null;
    if (
      viaOption &&
      String(viaOption?.inputParams?.featureID ?? "") === featureID
    ) {
      return viaOption;
    }
    const ph = getPartHistory();
    if (ph && Array.isArray(ph.features)) {
      return (
        ph.features.find(
          (f) => String(f?.inputParams?.featureID ?? "") === featureID
        ) || null
      );
    }
    return null;
  };
  const markDirty = (feature, data) => {
    if (!feature) return;
    feature.lastRunInputParams = {};
    feature.timestamp = 0;
    feature.dirty = true;
    feature.persistentData = feature.persistentData || {};
    feature.persistentData.spline = cloneSplineData(data);
  };
  const computeSignature = (data) => {
    let json;
    try {
      json = JSON.stringify(data);
    } catch {
      return String(Date.now());
    }
    let hash = 0;
    for (let i = 0; i < json.length; i++) {
      hash = (hash * 31 + json.charCodeAt(i)) | 0;
    }
    return `${json.length}:${hash >>> 0}`;
  };

  const host = document.createElement("div");
  host.className = "spline-widget";
  host.dataset.splineWidget = "true";
  const style = document.createElement("style");
  style.textContent = `
    .spline-widget {
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: 100%;
      box-sizing: border-box;
    }
    .spline-widget .spw-header {
      display: flex;
      justify-content: flex-start;
      gap: 8px;
      flex-wrap: wrap;
    }
    .spline-widget .spw-point-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
    }
    .spline-widget .spw-point-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: stretch;
      padding: 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      width: 100%;
      box-sizing: border-box;
    }
    .spline-widget .spw-row-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      width: 100%;
      box-sizing: border-box;
    }
    .spline-widget .spw-selected {
      background: rgba(58, 74, 109, 0.35);
    }
    .spline-widget .spw-title {
      font-weight: 600;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.88);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .spline-widget .spw-posline {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.75);
    }
    .spline-widget .spw-coords {
      display: grid;
      grid-template-columns: 1fr;
      gap: 6px;
      width: 100%;
      box-sizing: border-box;
    }
    .spline-widget .spw-axis {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.7);
      width: 100%;
      box-sizing: border-box;
    }
    .spline-widget .spw-axis input {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
      padding: 4px 6px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(0, 0, 0, 0.3);
      color: inherit;
      font-family: inherit;
      font-size: 12px;
    }
    .spline-widget .spw-axis input:focus {
      outline: none;
      border-color: rgba(108, 195, 255, 0.9);
      box-shadow: 0 0 0 1px rgba(108, 195, 255, 0.35);
    }
    .spline-widget .spw-actions {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .spline-widget .spw-btn,
    .spline-widget .spw-icon-btn,
    .spline-widget .spw-link {
      border: none;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      padding: 6px 10px;
      background: rgba(108, 195, 255, 0.12);
      color: rgba(223, 239, 255, 0.95);
      transition: background 0.15s ease, color 0.15s ease;
    }
    .spline-widget .spw-btn:hover,
    .spline-widget .spw-icon-btn:hover,
    .spline-widget .spw-link:hover {
      background: rgba(108, 195, 255, 0.22);
    }
    .spline-widget .spw-icon-btn {
      padding: 4px 6px;
      min-width: 28px;
      text-align: center;
    }
    .spline-widget .spw-icon-btn.danger {
      background: rgba(255, 107, 107, 0.14);
      color: rgba(255, 214, 214, 0.94);
    }
    .spline-widget .spw-icon-btn.danger:hover {
      background: rgba(255, 107, 107, 0.24);
    }
    .spline-widget .spw-link {
      background: none;
      padding: 0;
      color: rgba(108, 195, 255, 0.9);
    }
    .spline-widget .spw-link:hover {
      color: rgba(154, 214, 255, 0.95);
    }
    .spline-widget .spw-empty {
      opacity: 0.6;
      font-size: 12px;
      padding: 6px 0;
    }
  `;
  host.appendChild(style);

  if (row && typeof row.querySelector === "function") {
    const labelEl = row.querySelector(".label");
    if (labelEl) {
      labelEl.style.alignSelf = "flex-start";
      labelEl.style.paddingTop = "8px";
    }
  }

  const header = document.createElement("div");
  header.className = "spw-header";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "spw-btn";
  addBtn.textContent = "+";
  // tooltip for addBtn
  addBtn.title = "Add a new point to the spline";
  header.appendChild(addBtn);
  host.appendChild(header);

  const pointList = document.createElement("div");
  pointList.className = "spw-point-list";
  host.appendChild(pointList);

  controlWrap.appendChild(host);

  const state = {
    spline: null,
    signature: null,
    pendingFocusId: null,
    pendingFocusNode: null,
    session: null,
    selection: null,
    destroyed: false,
    creatingSession: false,
    refreshing: false,
    inSelectionChange: false, // Guard against recursive selection changes
    inSplineChange: false, // Guard against recursive spline changes
  };

  let pointRowMap = new Map();
  let pointButtonMap = new Map();

  const loadFromSource = () => {
    const feature = getFeatureRef();
    const raw = feature?.persistentData?.spline || null;
    const normalized = normalizeSplineData(raw);
    return cloneSplineData(normalized);
  };

  const ensureState = () => {
    if (!state.spline) {
      state.spline = loadFromSource();
      state.signature = computeSignature(state.spline);
      ui.params[key] = state.signature;
    }
  };

  const shouldIgnorePointerEvent = (event) => {
    const path =
      typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const el of path) {
      if (el === host) return true;
      if (el && el.dataset && el.dataset.splineWidget === "true") return true;
    }
    return false;
  };

  const disposeSession = (force = false) => {
    if (!state.session) return;

    // Always dispose when explicitly requested or forced
    try {
      state.session.dispose();
    } catch (error) {
      /* ignore */
    }
    state.session = null;
  };

  const handleSessionSelectionChange = (id) => {
    const changeStart = performance.now();

    if (state.destroyed || state.inSelectionChange) {
      return;
    }

    // Guard against recursive calls
    state.inSelectionChange = true;

    try {
      // CRITICAL FIX: Don't call session.selectObject from within a session selection change event!
      // This was causing infinite loops: session calls this handler -> we call selectObject -> triggers handler again
      state.selection = id || null;

      const renderStart = performance.now();
      renderAll({ fromSession: true });
    } finally {
      state.inSelectionChange = false;
    }
  };

  const handleSessionSplineChange = (nextData, reason = "transform") => {
    const changeStart = performance.now();

    if (state.destroyed || state.inSplineChange) {
      return;
    }

    // Guard against recursive calls
    state.inSplineChange = true;

    try {
      const normalizeStart = performance.now();
      state.spline = cloneSplineData(normalizeSplineData(nextData));

      // CRITICAL FIX: Always update persistent data when spline changes
      // This ensures transform changes are preserved when parameters change
      const feature = getFeatureRef();
      if (feature) {
        markDirty(feature, state.spline);
      }

      // CRITICAL CHANGE: Only update UI, don't trigger feature rebuild during editing
      // The session preview handles the visual updates, feature rebuild happens on dialog close

      const renderStart = performance.now();
      renderAll({ fromSession: true });
    } finally {
      state.inSplineChange = false;
    }
  };

  const ensureSession = () => {
    const viewer = getViewer();
    const featureID = getFeatureID();
    const sessionStart = performance.now();

    // Prevent creating multiple sessions or infinite loops
    if (state.session || state.creatingSession || state.destroyed) {
      return state.session;
    }
    if (!viewer || !featureID) {
      return null;
    }

    state.creatingSession = true;

    try {

      // Dispose any existing session first
      disposeSession(true); // Force disposal when creating new session

      const feature = getFeatureRef();
      if (!feature) {

        state.creatingSession = false;
        return null;
      }


      const sessionCreateStart = performance.now();
      const session = new SplineEditorSession(viewer, featureID, {
        featureRef: feature,
        onSplineChange: handleSessionSplineChange,
        onSelectionChange: handleSessionSelectionChange,
        shouldIgnorePointerEvent,
      });

      state.session = session;

      const res = Number(feature?.inputParams?.curveResolution);
      const preview = Number.isFinite(res) ? Math.max(4, Math.floor(res)) : undefined;


      const activateStart = performance.now();

      // Store desired selection before activation (since activation clears it)
      const desiredSelection = state.selection || (state.spline?.points?.[0] ? `point:${state.spline.points[0].id}` : null);

      session.activate(state.spline, {
        featureRef: feature,
        previewResolution: preview,
        initialSelection: desiredSelection,
      });


      // After activation, restore or set the desired selection
      let currentSelection = desiredSelection;

      if (currentSelection) {

        session.selectObject(currentSelection);
      } else {

      }

      state.selection = currentSelection;

      // Force transform controls to be visible by triggering a rebuild
      // This ensures the controls appear immediately when the session is first created
      if (currentSelection) {


        session.setSplineData(state.spline, {
          preserveSelection: true,
          silent: true,
          reason: "initial-selection"
        });



        // Double-check selection is active
        if (session.getSelectedId() !== currentSelection) {

          session.selectObject(currentSelection);
        }

        // Force transform visibility update as a final fallback
        if (session._updateTransformVisibility) {

          session._updateTransformVisibility();
        }

        // Comprehensive debugging of session state and force rebuild if needed
        setTimeout(() => {


          // Check if transform controls exist and are in scene
          let hasVisibleControls = false;
          if (session._transformsById) {
            for (const [id, entry] of session._transformsById.entries()) {
              const control = entry?.control;
              const inScene = !!(control && session.viewer?.scene && session.viewer.scene.children.includes(control));

              if (control?.enabled && control?.visible && inScene) {
                hasVisibleControls = true;
              }
            }
          }

          // If no visible controls but we have a selection, force another rebuild
          if (!hasVisibleControls && currentSelection && session.isActive()) {


            // Force cleanup before rebuild
            if (session.forceCleanup) {
              session.forceCleanup();
            }

            session.setSplineData(state.spline, {
              preserveSelection: true,
              silent: true,
              reason: "force-controls-visible"
            });

            // Force selection again
            session.selectObject(currentSelection);

            // Force visibility update
            if (session._updateTransformVisibility) {
              session._updateTransformVisibility();
            }


          }
        }, 100);
      }

    } catch (error) {
      /* ignore */
      disposeSession(true); // Force disposal on error
    } finally {
      state.creatingSession = false;
    }


    return state.session;
  };

  const focusPendingPoint = () => {
    if (!state.pendingFocusNode) return;
    try {
      state.pendingFocusNode.focus();
      state.pendingFocusNode.select?.();
    } catch {
      /* ignore */
    }
    state.pendingFocusNode = null;
    state.pendingFocusId = null;
  };

  // Centralized function to activate a point (same as clicking edit button)
  const activatePoint = (pointId) => {
    const keyId = `point:${pointId}`;

    // Ensure session exists before selecting - this will create transform controls
    let activeSession = state.session;
    const viewer = getViewer();
    const featureID = getFeatureID();
    if (!activeSession && viewer && featureID && !state.creatingSession) {
      activeSession = ensureSession();
    }

    if (activeSession) {
      // Always force redraw to ensure preview and transform controls are rebuilt
      activeSession.selectObject(keyId, { forceRedraw: true });
    }

    state.selection = keyId;
    updateSelectionStyles();
  };

  const renderPointRows = () => {
    pointList.textContent = "";
    pointRowMap = new Map();
    pointButtonMap = new Map();
    state.pendingFocusNode = null;
    const points = Array.isArray(state.spline?.points)
      ? state.spline.points
      : [];
    if (!points.length) {
      const empty = document.createElement("div");
      empty.className = "spw-empty";
      empty.textContent = "No points defined.";
      pointList.appendChild(empty);
      pointRowMap.clear();
      pointButtonMap.clear();
      updateSelectionStyles();
      return;
    }
    points.forEach((pt, index) => {
      const keyId = `point:${pt.id}`;
      const rowEl = document.createElement("div");
      rowEl.className = "spw-point-row";
      rowEl.dataset.pointId = String(pt.id);

      // Header: title + actions
      const headerEl = document.createElement('div');
      headerEl.className = 'spw-row-header';
      const title = document.createElement("div");
      title.className = "spw-title";
      title.textContent = `Point ${index + 1}`;
      headerEl.appendChild(title);

      // Actions
      const actions = document.createElement("div");
      actions.className = "spw-actions";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "spw-btn";
      selectBtn.textContent = "🖉";
      selectBtn.addEventListener("click", () => {
        activatePoint(pt.id);
      });
      actions.appendChild(selectBtn);
      pointButtonMap.set(keyId, selectBtn);

      const flipBtn = document.createElement("button");
      flipBtn.type = "button";
      flipBtn.className = "spw-btn";
      flipBtn.textContent = ">|<";
      flipBtn.title = "Toggle spline direction";
      flipBtn.addEventListener("click", () => {
        activatePoint(pt.id);
        state.spline.points[index].flipDirection = !state.spline.points[index].flipDirection;
        commit("flip-direction");
      });
      actions.appendChild(flipBtn);

      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "spw-icon-btn";
      upBtn.textContent = "↑";
      upBtn.title = "Move up";
      if (index === 0) upBtn.disabled = true;
      upBtn.addEventListener("click", () => {
        activatePoint(pt.id);
        movePoint(index, -1);
      });
      actions.appendChild(upBtn);

      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "spw-icon-btn";
      downBtn.textContent = "↓";
      downBtn.title = "Move down";
      if (index === points.length - 1) downBtn.disabled = true;
      downBtn.addEventListener("click", () => {
        activatePoint(pt.id);
        movePoint(index, 1);
      });
      actions.appendChild(downBtn);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "spw-icon-btn danger";
      removeBtn.textContent = "✕";
      removeBtn.title = "Remove point";
      if (points.length <= 2) removeBtn.disabled = true;
      removeBtn.addEventListener("click", () => {
        activatePoint(pt.id);
        removePoint(index);
      });
      actions.appendChild(removeBtn);

      headerEl.appendChild(actions);
      rowEl.appendChild(headerEl);

      // Extension Distances section
      const extensionSection = document.createElement("div");
      extensionSection.className = "spw-section";
      const extensionTitle = document.createElement("div");
      extensionTitle.className = "spw-section-title";
      extensionTitle.textContent = "Extension Distances";
      extensionSection.appendChild(extensionTitle);

      const extensionCoords = document.createElement("div");
      extensionCoords.className = "spw-coords";

      // Forward distance
      const forwardWrap = document.createElement("label");
      forwardWrap.className = "spw-axis";
      forwardWrap.textContent = "Forward:";
      const forwardInput = document.createElement("input");
      forwardInput.type = "number";
      forwardInput.step = "0.1";
      forwardInput.min = "0";
      forwardInput.value = formatNumber(pt.forwardDistance ?? 1.0);
      forwardInput.addEventListener("change", () => {
        activatePoint(pt.id);
        const next = Math.max(0, normalizeNumber(forwardInput.value));
        if (pt.forwardDistance === next) return;
        state.spline.points[index].forwardDistance = next;
        commit("update-forward-distance");
      });
      forwardInput.addEventListener("focus", () => {
        forwardInput.select?.();
      });
      forwardWrap.appendChild(forwardInput);
      extensionCoords.appendChild(forwardWrap);

      // Backward distance
      const backwardWrap = document.createElement("label");
      backwardWrap.className = "spw-axis";
      backwardWrap.textContent = "Backward:";
      const backwardInput = document.createElement("input");
      backwardInput.type = "number";
      backwardInput.step = "0.1";
      backwardInput.min = "0";
      backwardInput.value = formatNumber(pt.backwardDistance ?? 1.0);
      backwardInput.addEventListener("change", () => {
        activatePoint(pt.id);
        const next = Math.max(0, normalizeNumber(backwardInput.value));
        if (pt.backwardDistance === next) return;
        state.spline.points[index].backwardDistance = next;
        commit("update-backward-distance");
      });
      backwardInput.addEventListener("focus", () => {
        backwardInput.select?.();
      });
      backwardWrap.appendChild(backwardInput);
      extensionCoords.appendChild(backwardWrap);

      extensionSection.appendChild(extensionCoords);
      rowEl.appendChild(extensionSection);

      pointList.appendChild(rowEl);
      pointRowMap.set(keyId, rowEl);
    });
    updateSelectionStyles();
  };

  const updateSelectionStyles = () => {
    const selected = state.selection || null;
    for (const [key, rowEl] of pointRowMap.entries()) {
      rowEl.classList.toggle('spw-selected', selected === key);
    }
    for (const [key, btn] of pointButtonMap.entries()) {
      const isSelected = selected === key;
      btn.style.background = isSelected ? 'rgba(58, 74, 109, 0.45)' : 'rgba(108, 195, 255, 0.12)';
      btn.style.opacity = isSelected ? '1' : '0.95';
    }
  };

  const renderAll = ({ fromSession = false } = {}) => {
    const viewer = getViewer();
    const featureID = getFeatureID();
    const renderStart = performance.now();

    if (state.destroyed || state.creatingSession) {
      return;
    }

    ensureState();

    // Always ensure session exists when we have viewer and featureID (but not during updates from session)
    let activeSession = state.session;
    if (!fromSession && viewer && featureID && !state.creatingSession) {
      if (!activeSession) {
        const sessionStart = performance.now();
        activeSession = ensureSession();
      } else {
      }
    } else {

    }

    if (activeSession && !fromSession) {
      const selectionStart = performance.now();
      state.selection = activeSession.getSelectedId?.() || state.selection;
    }

    const pointsStart = performance.now();
    renderPointRows();

    addBtn.disabled = !getFeatureRef();
    focusPendingPoint();
  };

  const movePoint = (index, delta) => {
    const points = Array.isArray(state.spline?.points)
      ? state.spline.points
      : [];
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= points.length) return;
    const [item] = points.splice(index, 1);
    points.splice(nextIndex, 0, item);
    state.pendingFocusId = item.id;
    commit("reorder-point", { preserveSelection: true });
  };

  const removePoint = (index) => {
    const points = Array.isArray(state.spline?.points)
      ? state.spline.points
      : [];
    if (points.length <= 2) return;

    const [removed] = points.splice(index, 1);

    // Determine fallback selection after removal
    let newSelection = null;
    if (points.length > 0) {
      const fallbackIdx = Math.min(index, points.length - 1);
      const fallback = points[fallbackIdx];
      if (fallback) {
        newSelection = `point:${fallback.id}`;
        state.pendingFocusId = fallback.id;
      }
    }

    commit("remove-point", {
      preserveSelection: false,
      newSelection: newSelection
    });
  };

  const commitChangesToFeature = () => {

    const normalized = normalizeSplineData(state.spline);
    state.spline = cloneSplineData(normalized);

    const oldSignature = state.signature;
    state.signature = computeSignature(state.spline);

    ui.params[key] = state.signature;

    const feature = getFeatureRef();
    markDirty(feature, state.spline);

    const ph = getPartHistory();
    if (ph && Array.isArray(ph.features)) {
      for (const item of ph.features) {
        if (
          String(item?.inputParams?.featureID ?? "") === featureID &&
          item !== feature
        ) {
          markDirty(item, state.spline);
        }
      }
    }

    ui._emitParamsChange(key, {
      signature: state.signature,
      reason: "dialog-close",
      timestamp: Date.now(),
    });
  };

  const commit = (reason, options = {}) => {

    const { skipSessionSync = false, preserveSelection = true, newSelection = null } = options;
    const focusId = state.pendingFocusId || null;
    const normalized = normalizeSplineData(state.spline);
    state.spline = cloneSplineData(normalized);
    state.pendingFocusId = focusId;

    // For manual commits (add/remove/reorder points), we do need to update the feature
    // But for transform operations, we rely on preview mode

    const oldSignature = state.signature;
    state.signature = computeSignature(state.spline);

    ui.params[key] = state.signature;

    const feature = getFeatureRef();
    markDirty(feature, state.spline);

    const ph = getPartHistory();
    const featureID = getFeatureID();
    if (ph && Array.isArray(ph.features)) {
      for (const item of ph.features) {
        if (
          String(item?.inputParams?.featureID ?? "") === featureID &&
          item !== feature
        ) {
          markDirty(item, state.spline);
        }
      }
    }

    if (!skipSessionSync && !state.creatingSession) {
      // For structural changes (add/remove/reorder points), restart the session completely
      const isStructuralChange = reason === "add-point" || reason === "remove-point" || reason === "reorder-point";

      if (isStructuralChange) {
        console.log(`SplineWidget: Restarting session due to structural change: ${reason}`);

        // Completely dispose and recreate the session
        disposeSession(true);
        state.session = null;

        // Create new session with updated spline data
        const session = ensureSession();
        if (session && newSelection) {
          session.selectObject(newSelection);
        }
      } else {
        // For non-structural changes, just update the existing session
        const session = ensureSession();
        if (session) {
          session.setFeatureRef(feature);
          session.setSplineData(state.spline, {
            preserveSelection,
            silent: true,
            reason,
          });
          if (newSelection) session.selectObject(newSelection);
        }
      }
    }
    if (skipSessionSync && newSelection) {
      state.selection = newSelection;
    }
    if (!state.session && newSelection) {
      state.selection = newSelection;
    }

    // CRITICAL: Never trigger feature rebuild while session is active!
    // The session handles all preview updates. Feature rebuild only happens when dialog closes.
    // This prevents Spline.run() from being called while editing, which would interfere with the session.

    // Only save the signature change, but don't emit params change to prevent feature rebuild
    // Feature will be rebuilt when the dialog closes via commitChangesToFeature()
    renderAll();
  };

  addBtn.addEventListener("click", () => {
    ensureState();
    const points = Array.isArray(state.spline?.points)
      ? state.spline.points
      : [];

    if (points.length === 0) {
      // If no points exist, add first point at origin
      const newPoint = {
        id: `p${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 6)}`,
        position: [0, 0, 0],
        forwardDistance: 1.0,
        backwardDistance: 1.0,
      };
      points.push(newPoint);
      state.pendingFocusId = newPoint.id;
      commit("add-point", {
        preserveSelection: false,
        newSelection: `point:${newPoint.id}`
      });
      return;
    }

    // Helper function to calculate a point along the Hermite curve at parameter t (0 to 1)
    const calculateHermitePoint = (p0, p1, t0, t1, t) => {
      // Hermite basis functions
      const h00 = 2 * t * t * t - 3 * t * t + 1;
      const h10 = t * t * t - 2 * t * t + t;
      const h01 = -2 * t * t * t + 3 * t * t;
      const h11 = t * t * t - t * t;

      // Calculate position using Hermite interpolation
      const x = h00 * p0[0] + h10 * t0[0] + h01 * p1[0] + h11 * t1[0];
      const y = h00 * p0[1] + h10 * t0[1] + h01 * p1[1] + h11 * t1[1];
      const z = h00 * p0[2] + h10 * t0[2] + h01 * p1[2] + h11 * t1[2];

      return [x, y, z];
    };

    // Helper function to calculate tangent at parameter t along the Hermite curve
    const calculateHermiteTangent = (p0, p1, t0, t1, t) => {
      // Derivatives of Hermite basis functions
      const dh00 = 6 * t * t - 6 * t;
      const dh10 = 3 * t * t - 4 * t + 1;
      const dh01 = -6 * t * t + 6 * t;
      const dh11 = 3 * t * t - 2 * t;

      // Calculate tangent vector using derivatives
      const tx = dh00 * p0[0] + dh10 * t0[0] + dh01 * p1[0] + dh11 * t1[0];
      const ty = dh00 * p0[1] + dh10 * t0[1] + dh01 * p1[1] + dh11 * t1[1];
      const tz = dh00 * p0[2] + dh10 * t0[2] + dh01 * p1[2] + dh11 * t1[2];

      // Normalize the tangent
      const length = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (length > 0) {
        return [tx / length, ty / length, tz / length];
      }
      return [1, 0, 0]; // Default to X-axis if tangent is zero
    };

    // Helper function to create rotation matrix from tangent direction
    const createRotationFromTangent = (tangent) => {
      // Use tangent as X-axis (forward direction)
      const xAxis = [...tangent];

      // Create Y-axis perpendicular to tangent
      // Try Y-up first, but use Z-up if tangent is already along Y
      let yAxis;
      if (Math.abs(tangent[1]) < 0.9) {
        // Tangent is not along Y, use Y-up
        yAxis = [0, 1, 0];
      } else {
        // Tangent is along Y, use Z-up
        yAxis = [0, 0, 1];
      }

      // Cross product to get perpendicular axis
      const cross = (a, b) => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
      ];

      // Calculate Z-axis = X cross Y
      let zAxis = cross(xAxis, yAxis);
      let zLength = Math.sqrt(zAxis[0] * zAxis[0] + zAxis[1] * zAxis[1] + zAxis[2] * zAxis[2]);
      if (zLength > 0) {
        zAxis = [zAxis[0] / zLength, zAxis[1] / zLength, zAxis[2] / zLength];
      } else {
        zAxis = [0, 0, 1];
      }

      // Recalculate Y-axis = Z cross X to ensure orthogonality
      yAxis = cross(zAxis, xAxis);
      let yLength = Math.sqrt(yAxis[0] * yAxis[0] + yAxis[1] * yAxis[1] + yAxis[2] * yAxis[2]);
      if (yLength > 0) {
        yAxis = [yAxis[0] / yLength, yAxis[1] / yLength, yAxis[2] / yLength];
      } else {
        yAxis = [0, 1, 0];
      }

      // Return rotation matrix as flat array
      return [
        xAxis[0], xAxis[1], xAxis[2],
        yAxis[0], yAxis[1], yAxis[2],
        zAxis[0], zAxis[1], zAxis[2]
      ];
    };

    // Helper function to calculate tangent vector from point data
    const calculateTangent = (pointData, isForward) => {
      const rotation = pointData.rotation || [1, 0, 0, 0, 1, 0, 0, 0, 1];
      let direction = [rotation[0], rotation[1], rotation[2]]; // X-axis from rotation matrix

      if (pointData.flipDirection) {
        direction = [-direction[0], -direction[1], -direction[2]];
      }

      const distance = isForward ? pointData.forwardDistance : pointData.backwardDistance;
      const tangentDir = isForward ? direction : [-direction[0], -direction[1], -direction[2]];

      return [
        tangentDir[0] * distance,
        tangentDir[1] * distance,
        tangentDir[2] * distance
      ];
    };

    // Find the currently selected point
    let selectedIndex = -1;
    const selectedId = state.selection?.replace("point:", "") || null;
    if (selectedId) {
      selectedIndex = points.findIndex(p => p.id === selectedId);
    }

    // Determine insertion position and calculate new point position
    let insertIndex;
    let newPosition;
    let newRotation = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // Default identity matrix

    if (selectedIndex === -1 || selectedIndex === points.length - 1) {
      // No selection or last point selected - insert before last point
      if (points.length === 1) {
        // Only one point exists, add second point offset from first
        const base = points[0].position;
        newPosition = [base[0] + 2, base[1], base[2]];
        insertIndex = points.length; // Add at end
        // Keep default orientation for second point
      } else {
        insertIndex = points.length - 1; // Insert before last
        // Calculate point at 50% along curve between second-to-last and last point
        const p0 = points[points.length - 2];
        const p1 = points[points.length - 1];
        const t0 = calculateTangent(p0, true); // Forward tangent of first point
        const t1 = calculateTangent(p1, false); // Backward tangent of second point
        newPosition = calculateHermitePoint(p0.position, p1.position, t0, t1, 0.5);
        // Calculate orientation based on curve tangent at midpoint
        const curveTangent = calculateHermiteTangent(p0.position, p1.position, t0, t1, 0.5);
        newRotation = createRotationFromTangent(curveTangent);
      }
    } else {
      // Insert after selected point
      insertIndex = selectedIndex + 1;
      if (insertIndex >= points.length) {
        // Selected point is last, add at end offset from selected
        const base = points[selectedIndex].position;
        newPosition = [base[0] + 2, base[1], base[2]];
        // Keep default orientation when adding at end
      } else {
        // Calculate point at 50% along curve between selected point and next point
        const p0 = points[selectedIndex];
        const p1 = points[selectedIndex + 1];
        const t0 = calculateTangent(p0, true); // Forward tangent of first point
        const t1 = calculateTangent(p1, false); // Backward tangent of second point
        newPosition = calculateHermitePoint(p0.position, p1.position, t0, t1, 0.5);
        // Calculate orientation based on curve tangent at midpoint
        const curveTangent = calculateHermiteTangent(p0.position, p1.position, t0, t1, 0.5);
        newRotation = createRotationFromTangent(curveTangent);
      }
    }

    const newPoint = {
      id: `p${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      position: newPosition,
      rotation: newRotation,
      forwardDistance: 0,
      backwardDistance: 0,
    };

    // Insert the point at the calculated position
    points.splice(insertIndex, 0, newPoint);
    state.pendingFocusId = newPoint.id;
    commit("add-point", {
      preserveSelection: false,
      newSelection: `point:${newPoint.id}`
    });
  });

  ensureState();

  // Set up initial selection to first point if no selection exists
  if (!state.selection && state.spline?.points?.length > 0) {
    const firstPoint = state.spline.points[0];
    state.selection = `point:${firstPoint.id}`;
  }

  renderAll();

  // If session creation failed initially due to missing viewer/featureID, retry multiple times
  if (!state.session) {

    // Try multiple times with increasing delays
    const retryDelays = [50, 200, 500, 1000]; // Try at 50ms, 200ms, 500ms, and 1s

    retryDelays.forEach((delay, index) => {
      setTimeout(() => {
        if (!state.session && !state.destroyed) {
          renderAll();

          // If we successfully created a session and have a selection, make sure transform controls are visible
          if (state.session && state.selection) {
            state.session.selectObject(state.selection);
          }
        }
      }, delay);
    });
  }

  return {
    inputEl: host,
    inputRegistered: false,
    skipDefaultRefresh: true,
    refreshFromParams() {
      if (state.destroyed || state.creatingSession || state.refreshing) return;

      const viewer = getViewer();
      const featureID = getFeatureID();

      const stack = new Error().stack;
      state.refreshing = true;

      try {
        const next = loadFromSource();
        const nextSig = computeSignature(next);
        if (nextSig !== state.signature) {
          state.spline = next;
          state.signature = nextSig;
          ui.params[key] = state.signature;

          // Only update existing session, don't create new one during refresh
          if (state.session) {
            state.session.setFeatureRef(getFeatureRef());
            state.session.setSplineData(state.spline, {
              preserveSelection: true,
              silent: true,
            });
            state.selection = state.session.getSelectedId?.() || state.selection;
          }
          renderAll({ fromSession: true });
        } else if (state.session) {
          // Only update existing session
          state.session.setFeatureRef(getFeatureRef());
          renderAll({ fromSession: true });
        }

        // Try to create session if it doesn't exist and viewer/featureID are now available
        if (!state.session && viewer && featureID && !state.creatingSession) {
          renderAll(); // This will create the session
        }
      } catch (error) {
        /* ignore */
      } finally {
        // Use setTimeout to prevent rapid successive calls - increase delay to break loops
        setTimeout(() => {
          state.refreshing = false;
        }, 200); // Increased from 50ms to 200ms to break refresh loops
      }
    },
    destroy() {
      // CRITICAL: Commit all changes to the feature when dialog closes
      if (!state.destroyed && state.spline) {
        commitChangesToFeature();
      }

      state.destroyed = true;



      disposeSession(true); // Force disposal during destroy




    },
  };
}

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the spline feature",
  },
  curveResolution: {
    type: "number",
    default_value: DEFAULT_RESOLUTION,
    hint: "Samples per segment used to visualize the spline",
  },
  bendRadius: {
    type: "number",
    default_value: 1.0,
    label: "Bend Radius",
    hint: "Controls the smoothness of curve transitions. Lower values create sharper bends, higher values create smoother curves.",
    min: 0.1,
    step: 0.5,
  },
  splinePoints: {
    type: "string",
    label: "Spline Points",
    hint: "Add, reorder, and position spline anchors",
    renderWidget: renderSplinePointsWidget,
  },
};

export class SplineFeature {
  static featureShortName = "SP";
  static featureName = "Spline";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = this.persistentData || {};
  }

  destroy() {
    // Dispose the spline session if it exists to remove preview and transform controls
    if (this._splineSession) {
      this._splineSession.dispose();
      this._splineSession = null;
    }

    // Mark as destroyed to prevent further operations
    this._destroyed = true;
  }



  _ensureSplineData() {
    const source = this.persistentData?.spline || null;
    const normalized = normalizeSplineData(source);
    this.persistentData = this.persistentData || {};
    this.persistentData.spline = normalized;
    return normalized;
  }

  async run(partHistory) {
    const spline = this._ensureSplineData();
    const featureId = this.inputParams?.featureID
      ? String(this.inputParams.featureID)
      : "Spline";

    const sceneGroup = new THREE.Group();
    sceneGroup.name = featureId;
    sceneGroup.type = "SKETCH";
    sceneGroup.onClick = () => { };

    const resolution = Number.isFinite(Number(this.inputParams?.curveResolution))
      ? Math.max(4, Number(this.inputParams.curveResolution))
      : DEFAULT_RESOLUTION;

    const bendRadius = Number.isFinite(Number(this.inputParams?.bendRadius))
      ? Math.max(0.1, Math.min(5.0, Number(this.inputParams.bendRadius)))
      : 1.0;

    const { positions, polyline } = buildHermitePolyline(spline, resolution, bendRadius);

    if (positions.length >= 6) {
      const geometry = new LineGeometry();
      geometry.setPositions(positions);

      const edge = new BREP.Edge(geometry);
      edge.name = `${featureId}:SplineEdge`;
      edge.userData = {
        polylineLocal: polyline.map((p) => [p[0], p[1], p[2]]),
        polylineWorld: true,
        splineFeatureId: featureId,
      };
      sceneGroup.add(edge);
    }

    try {
      const vertices = spline.points.map((pt, idx) => {
        const vertex = new BREP.Vertex(pt.position, {
          name: `${featureId}:P${idx}`,
        });
        vertex.userData = vertex.userData || {};
        vertex.userData.splineFeatureId = featureId;
        vertex.userData.splinePointId = pt.id;
        return vertex;
      });
      for (const v of vertices) {
        sceneGroup.add(v);
      }
    } catch {
      // optional vertices failed; ignore
    }

    try {
      // Add extension handles as vertices for visualization
      spline.points.forEach((pt, idx) => {
        const forwardPos = [
          pt.position[0] + pt.forwardExtension[0],
          pt.position[1] + pt.forwardExtension[1],
          pt.position[2] + pt.forwardExtension[2]
        ];
        const backwardPos = [
          pt.position[0] + pt.backwardExtension[0],
          pt.position[1] + pt.backwardExtension[1],
          pt.position[2] + pt.backwardExtension[2]
        ];

        const forwardVertex = new BREP.Vertex(forwardPos, {
          name: `${featureId}:F${idx}`,
        });
        forwardVertex.userData = {
          splineFeatureId: featureId,
          splinePointId: pt.id,
          extensionType: "forward",
        };

        const backwardVertex = new BREP.Vertex(backwardPos, {
          name: `${featureId}:B${idx}`,
        });
        backwardVertex.userData = {
          splineFeatureId: featureId,
          splinePointId: pt.id,
          extensionType: "backward",
        };

        sceneGroup.add(forwardVertex);
        sceneGroup.add(backwardVertex);
      });
    } catch {
      /* ignore extension vertex creation failure */
    }

    this.persistentData = this.persistentData || {};
    this.persistentData.spline = cloneSplineData(spline);

    // remove all children of the scene that have a name starting with "SplineEditorPreview"
    const existingPreviews = partHistory.scene.children.filter(child =>

      child.name.startsWith("SplineEditor")
    );
    for (const preview of existingPreviews) {
      preview.userData.preventRemove = false;
      partHistory.scene.remove(preview);
    }



    return { added: [sceneGroup], removed: [] };
  }
}
