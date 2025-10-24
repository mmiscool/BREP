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
    const abs = Math.abs(num);
    const fixed =
      abs >= 1000
        ? num.toFixed(0)
        : abs >= 100
          ? num.toFixed(1)
          : abs >= 10
            ? num.toFixed(2)
            : num.toFixed(3);
    return fixed.replace(/\.?0+$/, "") || "0";
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
    }
    .spline-widget .spw-point-row,
    .spline-widget .spw-weight-row {
      display: grid;
      grid-template-columns: minmax(120px, 140px) minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
    }
    .spline-widget .spw-selected {
      background: rgba(58, 74, 109, 0.35);
    }
    .spline-widget .spw-title {
      font-weight: 600;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.88);
    }
    .spline-widget .spw-coords {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .spline-widget .spw-axis {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.7);
    }
    .spline-widget .spw-axis input {
      width: 70px;
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
  const hideBtn = document.createElement("button");
  hideBtn.type = "button";
  hideBtn.className = "spw-btn";
  hideBtn.textContent = "Hide Gizmo";
  header.appendChild(hideBtn);
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

  const disposeSession = () => {
    if (!state.session) return;
    try {
      state.session.dispose();
    } catch {
      /* noop */
    }
    state.session = null;
  };

  const handleSessionSelectionChange = (id) => {
    if (state.destroyed) return;
    state.selection = id || null;
    session.selectObject(state.selection);
    renderAll({ fromSession: true });
  };

  const handleSessionSplineChange = (nextData, reason = "transform") => {
    if (state.destroyed) return;
    state.spline = cloneSplineData(normalizeSplineData(nextData));
    state.signature = computeSignature(state.spline);
    ui.params[key] = state.signature;
    markDirty(getFeatureRef(), state.spline);
    renderAll({ fromSession: true });
    ui._emitParamsChange(key, {
      signature: state.signature,
      reason,
      timestamp: Date.now(),
    });
  };

  const ensureSession = () => {
    if (state.session || !viewer || !featureID) return state.session;
    const feature = getFeatureRef();
    const session = new SplineEditorSession(viewer, featureID, {
      featureRef: feature,
      onSplineChange: handleSessionSplineChange,
      onSelectionChange: handleSessionSelectionChange,
      shouldIgnorePointerEvent,
    });
    state.session = session;
    const res = Number(feature?.inputParams?.curveResolution);
    const preview = Number.isFinite(res) ? Math.max(4, Math.floor(res)) : undefined;
    session.activate(state.spline, {
      featureRef: feature,
      previewResolution: preview,
    });
    let currentSelection = session.getSelectedId?.() || null;
    if (!currentSelection) {
      const first = state.spline?.points?.[0];
      if (first) {
        currentSelection = `point:${first.id}`;
        session.selectObject(currentSelection);
      }
    }
    state.selection = currentSelection;
    return session;
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

      const title = document.createElement("div");
      title.className = "spw-title";
      const posLabel = pt.position.map((c) => formatNumber(c)).join(", ");
      title.textContent = `Point ${index + 1} • [${posLabel}]`;
      rowEl.appendChild(title);

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
        input.value = formatNumber(pt.position?.[axis] ?? 0);
        input.addEventListener("change", () => {
          const next = normalizeNumber(input.value);
          if (pt.position?.[axis] === next) return;
          state.spline.points[index].position[axis] = next;
          commit("update-point");
        });
        input.addEventListener("focus", () => {
          input.select?.();
        });
        if (state.pendingFocusId === pt.id && axis === 0) {
          state.pendingFocusNode = input;
        }
        axisWrap.appendChild(input);
        coords.appendChild(axisWrap);
      });
      rowEl.appendChild(coords);

      const actions = document.createElement("div");
      actions.className = "spw-actions";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "spw-btn";
      selectBtn.textContent = "Select";
      selectBtn.addEventListener("click", () => {
        const session = ensureSession();
        if (session) {
          session.selectObject(keyId);
        }
        state.selection = keyId;
        updateSelectionStyles();
      });
      actions.appendChild(selectBtn);
      pointButtonMap.set(keyId, selectBtn);

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

      rowEl.appendChild(actions);
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

      const title = document.createElement("div");
      title.className = "spw-title";
      const posLabel = weight.position
        ? weight.position.map((c) => formatNumber(c)).join(", ")
        : "0, 0, 0";
      title.textContent = `${label} • [${posLabel}]`;
      rowEl.appendChild(title);

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
      rowEl.appendChild(coords);

      const actions = document.createElement("div");
      actions.className = "spw-actions";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "spw-btn";
      selectBtn.textContent = "Select";
      selectBtn.addEventListener("click", () => {
        const session = ensureSession();
        if (session) {
          session.selectObject(key);
        }
        state.selection = key;
        updateSelectionStyles();
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
      rowEl.appendChild(actions);

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
    hideBtn.disabled = !(state.session && state.session.isActive?.());
  };

  const renderAll = ({ fromSession = false } = {}) => {
    if (state.destroyed) return;
    ensureState();
    let activeSession = state.session;
    if (!fromSession) {
      activeSession = ensureSession();
    }
    if (activeSession) {
      state.selection = activeSession.getSelectedId?.() || state.selection;
    }
    renderPointRows();
    renderWeights();
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

  const commit = (reason, options = {}) => {
    const { skipSessionSync = false, preserveSelection = true, newSelection = null } = options;
    const focusId = state.pendingFocusId || null;
    const normalized = normalizeSplineData(state.spline);
    state.spline = cloneSplineData(normalized);
    state.pendingFocusId = focusId;
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

    if (!skipSessionSync) {
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

    ui._emitParamsChange(key, {
      signature: state.signature,
      reason,
      timestamp: Date.now(),
    });
    renderAll();
  };

  hideBtn.addEventListener("click", () => {
    const session = ensureSession();
    if (session) session.hideGizmo();
    state.selection = null;
    updateSelectionStyles();
  });

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
      const next = loadFromSource();
      const nextSig = computeSignature(next);
      if (nextSig !== state.signature) {
        state.spline = next;
        state.signature = nextSig;
        ui.params[key] = state.signature;
        const session = state.session || ensureSession();
        if (session) {
          session.setFeatureRef(getFeatureRef());
          session.setSplineData(state.spline, {
            preserveSelection: true,
            silent: true,
          });
          state.selection = session.getSelectedId?.() || state.selection;
        }
        renderAll({ fromSession: true });
      } else {
        const session = state.session || ensureSession();
        if (session) session.setFeatureRef(getFeatureRef());
        renderAll({ fromSession: true });
      }
    },
    destroy() {
      state.destroyed = true;
      disposeSession();
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
    type: "spline_widget",
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
      const startVertex = new BREP.Vertex(spline.startWeight.position, {
        name: `${featureId}:WStart`,
      });
      startVertex.userData = {
        splineFeatureId: featureId,
        splineWeightType: "start",
      };
      const endVertex = new BREP.Vertex(spline.endWeight.position, {
        name: `${featureId}:WEnd`,
      });
      endVertex.userData = {
        splineFeatureId: featureId,
        splineWeightType: "end",
      };
      sceneGroup.add(startVertex);
      sceneGroup.add(endVertex);
    } catch {
      /* ignore weight vertex creation failure */
    }

    this.persistentData = this.persistentData || {};
    this.persistentData.spline = cloneSplineData(spline);

    return { added: [sceneGroup], removed: [] };
  }
}
