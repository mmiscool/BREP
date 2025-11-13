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
  const featureID =
    ui?.params?.featureID != null ? String(ui.params.featureID) : null;
  const viewer = ui?.options?.viewer || null;
  const getPartHistory = () =>
    ui?.options?.partHistory || ui?.options?.viewer?.partHistory || null;
  const getFeatureRef = () => {
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
    .spline-widget .spw-point-list,
    .spline-widget .spw-weight-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
    }
    .spline-widget .spw-point-row,
    .spline-widget .spw-weight-row {
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
  addBtn.textContent = "Add Point";
  header.appendChild(addBtn);
  host.appendChild(header);

  const pointList = document.createElement("div");
  pointList.className = "spw-point-list";
  host.appendChild(pointList);

  const weightList = document.createElement("div");
  weightList.className = "spw-weight-list";
  host.appendChild(weightList);

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
  let weightRowMap = new Map();
  let weightButtonMap = new Map();

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
    console.log(`SplineFeature: disposeSession called - existing=${!!state.session}, force=${force}`);
    if (!state.session) return;
    
    // Don't dispose if this is a registered session unless forced (e.g., during destroy)
    if (!force && featureID && activeEditorSessions.has(featureID)) {
      console.log(`SplineFeature: preserving registered session for ${featureID}`);
      return;
    }
    
    try {
      console.log(`SplineFeature: calling session.dispose()`);
      state.session.dispose();
      console.log(`SplineFeature: session.dispose() completed`);
    } catch (error) {
      console.error(`SplineFeature: error in session.dispose():`, error);
    }
    state.session = null;
  };

  const handleSessionSelectionChange = (id) => {
    console.log(`SplineFeature: handleSessionSelectionChange called with id=${id}`);
    const changeStart = performance.now();
    
    if (state.destroyed || state.inSelectionChange) {
      console.log(`SplineFeature: handleSessionSelectionChange skipped - destroyed=${state.destroyed}, inProgress=${state.inSelectionChange}`);
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
      console.log(`SplineFeature: handleSessionSelectionChange renderAll took ${(performance.now() - renderStart).toFixed(1)}ms`);
    } finally {
      state.inSelectionChange = false;
    }
    
    console.log(`SplineFeature: handleSessionSelectionChange completed in ${(performance.now() - changeStart).toFixed(1)}ms`);
  };

  const handleSessionSplineChange = (nextData, reason = "transform") => {
    console.log(`SplineFeature: handleSessionSplineChange called with reason=${reason} - PREVIEW MODE`);
    const changeStart = performance.now();
    
    if (state.destroyed || state.inSplineChange) {
      console.log(`SplineFeature: handleSessionSplineChange skipped - destroyed=${state.destroyed}, inProgress=${state.inSplineChange}`);
      return;
    }
    
    // Guard against recursive calls
    state.inSplineChange = true;
    
    try {
      const normalizeStart = performance.now();
      state.spline = cloneSplineData(normalizeSplineData(nextData));
      console.log(`SplineFeature: spline normalization took ${(performance.now() - normalizeStart).toFixed(1)}ms`);
      
      // CRITICAL CHANGE: Only update UI, don't trigger feature rebuild during editing
      // The session preview handles the visual updates, feature rebuild happens on dialog close
      
      const renderStart = performance.now();
      renderAll({ fromSession: true });
      console.log(`SplineFeature: handleSessionSplineChange renderAll took ${(performance.now() - renderStart).toFixed(1)}ms`);
      
      console.log(`SplineFeature: preview update completed - no feature rebuild triggered`);
    } finally {
      state.inSplineChange = false;
    }
    
    console.log(`SplineFeature: handleSessionSplineChange completed in ${(performance.now() - changeStart).toFixed(1)}ms`);
  };

  const ensureSession = () => {
    console.log(`SplineFeature: ensureSession called - existing=${!!state.session}, creating=${state.creatingSession}, destroyed=${state.destroyed}`);
    const sessionStart = performance.now();
    
    // Prevent creating multiple sessions or infinite loops
    if (state.session || state.creatingSession || state.destroyed) {
      console.log(`SplineFeature: ensureSession returning existing session`);
      return state.session;
    }
    if (!viewer || !featureID) {
      console.log(`SplineFeature: ensureSession - missing viewer or featureID`);
      return null;
    }
    
    state.creatingSession = true;
    
    try {
      console.log(`SplineFeature: disposing any existing session`);
      // Dispose any existing session first
      disposeSession(true); // Force disposal when creating new session
      
      const feature = getFeatureRef();
      if (!feature) {
        console.log(`SplineFeature: ensureSession - no feature reference`);
        state.creatingSession = false;
        return null;
      }
      
      console.log(`SplineFeature: creating new SplineEditorSession`);
      const sessionCreateStart = performance.now();
      const session = new SplineEditorSession(viewer, featureID, {
        featureRef: feature,
        onSplineChange: handleSessionSplineChange,
        onSelectionChange: handleSessionSelectionChange,
        shouldIgnorePointerEvent,
      });
      console.log(`SplineFeature: SplineEditorSession constructor took ${(performance.now() - sessionCreateStart).toFixed(1)}ms`);
      state.session = session;
      
      const res = Number(feature?.inputParams?.curveResolution);
      const preview = Number.isFinite(res) ? Math.max(4, Math.floor(res)) : undefined;
      
      console.log(`SplineFeature: activating session with spline data`);
      const activateStart = performance.now();
      session.activate(state.spline, {
        featureRef: feature,
        previewResolution: preview,
      });
      console.log(`SplineFeature: session.activate took ${(performance.now() - activateStart).toFixed(1)}ms`);
      
      let currentSelection = session.getSelectedId?.() || null;
      if (!currentSelection) {
        const first = state.spline?.points?.[0];
        if (first) {
          currentSelection = `point:${first.id}`;
          console.log(`SplineFeature: selecting first point ${currentSelection}`);
          session.selectObject(currentSelection);
        }
      }
      state.selection = currentSelection;
      
    } catch (error) {
      console.error('Failed to activate spline session:', error);
      disposeSession(true); // Force disposal on error
    } finally {
      state.creatingSession = false;
    }
    
    console.log(`SplineFeature: ensureSession completed in ${(performance.now() - sessionStart).toFixed(1)}ms`);
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
      selectBtn.textContent = "Select";
      selectBtn.addEventListener("click", () => {
        console.log(`SplineFeature: selectBtn click started for ${keyId}`);
        const startTime = performance.now();
        
        // Use existing session if available, don't create new one on click
        if (state.session) {
          console.log(`SplineFeature: calling session.selectObject for ${keyId}`);
          state.session.selectObject(keyId);
          console.log(`SplineFeature: session.selectObject completed in ${(performance.now() - startTime).toFixed(1)}ms`);
        } else {
          console.warn(`SplineFeature: No session available for selectObject`);
        }
        state.selection = keyId;
        
        const styleStart = performance.now();
        updateSelectionStyles();
        console.log(`SplineFeature: updateSelectionStyles took ${(performance.now() - styleStart).toFixed(1)}ms`);
        
        console.log(`SplineFeature: selectBtn click completed in ${(performance.now() - startTime).toFixed(1)}ms`);
      });
      actions.appendChild(selectBtn);
      pointButtonMap.set(keyId, selectBtn);

      const flipBtn = document.createElement("button");
      flipBtn.type = "button";
      flipBtn.className = "spw-btn";
      flipBtn.textContent = pt.flipDirection ? "Flipped" : "Normal";
      flipBtn.title = "Toggle spline direction";
      flipBtn.addEventListener("click", () => {
        state.spline.points[index].flipDirection = !state.spline.points[index].flipDirection;
        flipBtn.textContent = state.spline.points[index].flipDirection ? "Flipped" : "Normal";
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

  const renderWeights = () => {
    weightList.textContent = "";
    weightRowMap = new Map();
    weightButtonMap = new Map();
    const points = Array.isArray(state.spline?.points)
      ? state.spline.points
      : [];
    const pairs = [
      { keyName: "startWeight", label: "Start Weight", anchor: points[0], key: "weight:start" },
      {
        keyName: "endWeight",
        label: "End Weight",
        anchor: points[points.length - 1],
        key: "weight:end",
      },
    ];
    pairs.forEach(({ keyName, label, anchor, key }) => {
      const weight = state.spline?.[keyName];
      if (!weight) return;
      const rowEl = document.createElement("div");
      rowEl.className = "spw-weight-row";
      rowEl.dataset.weightKey = keyName;

      // Header: title + actions
      const headerEl = document.createElement('div');
      headerEl.className = 'spw-row-header';
      const title = document.createElement("div");
      title.className = "spw-title";
      title.textContent = label;
      headerEl.appendChild(title);

      const coords = document.createElement("div");
      coords.className = "spw-coords";
      ["X", "Y", "Z"].forEach((axisLabel, axis) => {
        const axisWrap = document.createElement("label");
        axisWrap.className = "spw-axis";
        axisWrap.textContent = `${axisLabel}:`;
        const input = document.createElement("input");
        input.type = "number";
        input.step = "0.1";
        input.dataset.axis = String(axis);
        input.value = formatNumber(weight.position?.[axis] ?? 0);
        input.addEventListener("change", () => {
          const next = normalizeNumber(input.value);
          if (weight.position?.[axis] === next) return;
          state.spline[keyName].position[axis] = next;
          commit("update-weight");
        });
        input.addEventListener("focus", () => {
          input.select?.();
        });
        axisWrap.appendChild(input);
        coords.appendChild(axisWrap);
      });
      const actions = document.createElement("div");
      actions.className = "spw-actions";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "spw-btn";
      selectBtn.textContent = "Select";
      selectBtn.addEventListener("click", () => {
        console.log(`SplineFeature: weight selectBtn click started for ${key}`);
        const startTime = performance.now();
        
        if (state.session) {
          console.log(`SplineFeature: calling session.selectObject for weight ${key}`);
          state.session.selectObject(key);
          console.log(`SplineFeature: weight session.selectObject completed in ${(performance.now() - startTime).toFixed(1)}ms`);
        } else {
          console.warn(`SplineFeature: No session available for weight selectObject`);
        }
        state.selection = key;
        
        const styleStart = performance.now();
        updateSelectionStyles();
        console.log(`SplineFeature: weight updateSelectionStyles took ${(performance.now() - styleStart).toFixed(1)}ms`);
        
        console.log(`SplineFeature: weight selectBtn click completed in ${(performance.now() - startTime).toFixed(1)}ms`);
      });
      actions.appendChild(selectBtn);
      weightButtonMap.set(key, selectBtn);

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "spw-link";
      resetBtn.textContent = "Reset to anchor";
      resetBtn.disabled = !anchor;
      resetBtn.addEventListener("click", () => {
        resetWeight(keyName);
      });
      actions.appendChild(resetBtn);
      headerEl.appendChild(actions);
      rowEl.appendChild(headerEl);

      // Vector line under header
      const posLine = document.createElement('div');
      posLine.className = 'spw-posline';
      const posLabel = weight.position
        ? weight.position.map((c) => formatNumber(c)).join(", ")
        : "0, 0, 0";
      posLine.textContent = `[${posLabel}]`;
      rowEl.appendChild(posLine);

      // Vertical fields container
      rowEl.appendChild(coords);

      weightList.appendChild(rowEl);
      weightRowMap.set(key, rowEl);
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
      btn.textContent = isSelected ? 'Editing' : 'Select';
    }
    for (const [key, rowEl] of weightRowMap.entries()) {
      rowEl.classList.toggle('spw-selected', selected === key);
    }
    for (const [key, btn] of weightButtonMap.entries()) {
      const isSelected = selected === key;
      btn.style.background = isSelected ? 'rgba(58, 74, 109, 0.45)' : 'rgba(108, 195, 255, 0.12)';
      btn.style.opacity = isSelected ? '1' : '0.95';
      btn.textContent = isSelected ? 'Editing' : 'Select';
    }
  };

  const renderAll = ({ fromSession = false } = {}) => {
    console.log(`SplineFeature: renderAll called, fromSession=${fromSession}`);
    const renderStart = performance.now();
    
    if (state.destroyed || state.creatingSession) {
      console.log(`SplineFeature: renderAll skipped - destroyed=${state.destroyed}, creatingSession=${state.creatingSession}`);
      return;
    }
    
    ensureState();
    
    // Always ensure session exists when we have viewer and featureID (but not during updates from session)
    let activeSession = state.session;
    if (!fromSession && viewer && featureID && !state.creatingSession) {
      if (!activeSession) {
        console.log(`SplineFeature: creating session in renderAll`);
        const sessionStart = performance.now();
        activeSession = ensureSession();
        console.log(`SplineFeature: ensureSession took ${(performance.now() - sessionStart).toFixed(1)}ms`);
      }
    }
    
    if (activeSession && !fromSession) {
      const selectionStart = performance.now();
      state.selection = activeSession.getSelectedId?.() || state.selection;
      console.log(`SplineFeature: getSelectedId took ${(performance.now() - selectionStart).toFixed(1)}ms`);
    }
    
    const pointsStart = performance.now();
    renderPointRows();
    console.log(`SplineFeature: renderPointRows took ${(performance.now() - pointsStart).toFixed(1)}ms`);
    
    const weightsStart = performance.now();
    renderWeights();
    console.log(`SplineFeature: renderWeights took ${(performance.now() - weightsStart).toFixed(1)}ms`);
    
    addBtn.disabled = !getFeatureRef();
    focusPendingPoint();
    
    console.log(`SplineFeature: renderAll completed in ${(performance.now() - renderStart).toFixed(1)}ms`);
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
    if (removed && removed.id && !state.pendingFocusId) {
      const fallbackIdx = Math.min(index, points.length - 1);
      const fallback = points[fallbackIdx];
      state.pendingFocusId = fallback ? fallback.id : null;
    }
    if (!state.session && removed) {
      const removedKey = `point:${removed.id}`;
      if (state.selection === removedKey) state.selection = null;
    }
    if (points.length) {
      const first = points[0];
      const last = points[points.length - 1];
      if (first) {
        state.spline.startWeight.position = first.position.slice();
      }
      if (last) {
        state.spline.endWeight.position = last.position.slice();
      }
    }
    commit("remove-point", { preserveSelection: true });
  };

  const resetWeight = (keyName) => {
    const points = Array.isArray(state.spline?.points)
      ? state.spline.points
      : [];
    if (!points.length) return;
    const anchor =
      keyName === "startWeight" ? points[0] : points[points.length - 1];
    if (!anchor) return;
    state.spline[keyName].position = anchor.position.slice();
    commit("reset-weight", { preserveSelection: true });
  };

  const commitChangesToFeature = () => {
    console.log(`SplineFeature: commitChangesToFeature called - finalizing spline changes`);
    
    const normalized = normalizeSplineData(state.spline);
    state.spline = cloneSplineData(normalized);
    
    const oldSignature = state.signature;
    state.signature = computeSignature(state.spline);
    console.log(`SplineFeature: final commit signature change from ${oldSignature} to ${state.signature}`);
    
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

    console.log(`SplineFeature: calling _emitParamsChange for final commit`);
    ui._emitParamsChange(key, {
      signature: state.signature,
      reason: "dialog-close",
      timestamp: Date.now(),
    });
    
    console.log(`SplineFeature: commitChangesToFeature completed`);
  };

  const commit = (reason, options = {}) => {
    console.log(`SplineFeature: commit called with reason=${reason}`, {
      skipSessionSync: options.skipSessionSync,
      preserveSelection: options.preserveSelection,
      newSelection: options.newSelection
    });
    
    const { skipSessionSync = false, preserveSelection = true, newSelection = null } = options;
    const focusId = state.pendingFocusId || null;
    const normalized = normalizeSplineData(state.spline);
    state.spline = cloneSplineData(normalized);
    state.pendingFocusId = focusId;
    
    // For manual commits (add/remove/reorder points), we do need to update the feature
    // But for transform operations, we rely on preview mode
    
    const oldSignature = state.signature;
    state.signature = computeSignature(state.spline);
    console.log(`SplineFeature: commit signature change from ${oldSignature} to ${state.signature}`);
    
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

    if (!skipSessionSync && !state.creatingSession) {
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
    if (skipSessionSync && newSelection) {
      state.selection = newSelection;
    }
    if (!state.session && newSelection) {
      state.selection = newSelection;
    }

    // Only trigger feature rebuild for structural changes (add/remove/reorder points)
    // Transform operations stay in preview mode
    if (reason !== "transform" && reason !== "update-forward-distance" && reason !== "update-backward-distance") {
      console.log(`SplineFeature: commit calling _emitParamsChange for structural change: ${reason}`);
      ui._emitParamsChange(key, {
        signature: state.signature,
        reason,
        timestamp: Date.now(),
      });
    } else {
      console.log(`SplineFeature: skipping feature rebuild for preview change: ${reason}`);
    }
    
    console.log(`SplineFeature: commit calling renderAll`);
    renderAll();
    console.log(`SplineFeature: commit completed`);
  };

  addBtn.addEventListener("click", () => {
    ensureState();
    const points = Array.isArray(state.spline?.points)
      ? state.spline.points
      : [];
    const last = points[points.length - 1];
    const base = last?.position || [0, 0, 0];
    const viewerTarget = viewer?.controls?.target || null;
    const defaultPos = viewerTarget
      ? [viewerTarget.x, viewerTarget.y, viewerTarget.z]
      : [base[0] + 1, base[1], base[2]];
    const newPoint = {
      id: `p${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      position: defaultPos,
      forwardDistance: 1.0,
      backwardDistance: 1.0,
    };
    points.push(newPoint);
    state.pendingFocusId = newPoint.id;
    commit("add-point", {
      preserveSelection: false,
      newSelection: `point:${newPoint.id}`
    });
  });

  ensureState();
  renderAll();

  return {
    inputEl: host,
    inputRegistered: false,
    skipDefaultRefresh: true,
    refreshFromParams() {
      if (state.destroyed || state.creatingSession || state.refreshing) return;
      
      const stack = new Error().stack;
      console.log("SplineFeature: refreshFromParams called", { 
        stackTrace: stack.split('\n').slice(1, 4).join('\n') 
      });
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
      } catch (error) {
        console.error("Error in refreshFromParams:", error);
      } finally {
        // Use setTimeout to prevent rapid successive calls - increase delay to break loops
        setTimeout(() => {
          console.log(`SplineFeature: refreshing flag cleared`);
          state.refreshing = false;
        }, 200); // Increased from 50ms to 200ms to break refresh loops
      }
    },
    destroy() {
      console.log(`SplineFeature: destroy called - committing final changes`);
      
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
  splinePoints: {
    type: "string",
    label: "Spline Points",
    hint: "Add, reorder, and position spline anchors and weights",
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

    const { positions, polyline } = buildHermitePolyline(spline, resolution);

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

    console.log(`SplineFeature: run() completed for ${featureId} - feature geometry built`);

    return { added: [sceneGroup], removed: [] };
  }
}
