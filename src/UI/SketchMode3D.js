// SketchMode3D: In-scene sketch editing with camera locked to a plane.
// Phase 1: camera lock + minimal Finish/Cancel overlay UI + panning only.

import * as THREE from "three";
import ConstraintSolver from "../features/sketch/sketchSolver2D/ConstraintEngine.js";
import { AccordionWidget } from "./AccordionWidget.js";

export class SketchMode3D {
  constructor(viewer, featureID) {
    this.viewer = viewer;
    this.featureID = featureID;
    this._ui = null;
    this._saved = null; // camera + controls snapshot
    this._lock = null; // { basis:{x,y,z,origin}, distance, target }
    this._panning = false;
    this._panStart = { x: 0, y: 0 };
    // Editing state
    this._solver = null;
    this._sketchGroup = null;
    this._raycaster = new THREE.Raycaster();
    this._drag = { active: false, pointId: null };
    this._pendingDrag = { pointId: null, x: 0, y: 0, started: false };
    this._selection = new Set();
    this._tool = "select";
    this._ctxBar = null;
    // Handle sizing helpers
    this._handleGeom = new THREE.SphereGeometry(1, 12, 8); // unit sphere scaled per-frame
    this._lastHandleScale = -1;
    this._sizeRAF = 0;
    // Dimension overlay state
    this._dimRoot = null; // HTML overlay container for dimensions
    this._dimOffsets = new Map(); // constraintId -> {du,dv} in plane space
    this._dimSVG = null; // SVG element for leaders/arrows (deprecated for leaders)
    this._dim3D = null; // THREE.Group for 3D leaders/arrows on plane
    this._dragDim = {
      active: false,
      cid: null,
      sx: 0,
      sy: 0,
      start: { dx: 0, dy: 0 },
    };
    this._controlsPrev = null; // remember controls state when locking
  }

  open() {
    const v = this.viewer;
    if (!v) return;

    // Snapshot camera/controls state
    this._saved = {
      position: v.camera.position.clone(),
      quaternion: v.camera.quaternion.clone(),
      up: v.camera.up.clone(),
      controlsEnabled: v.controls.enabled,
    };

    // Find the sketch reference object
    const ph = v.partHistory;
    const feature = Array.isArray(ph?.features)
      ? ph.features.find((f) => f?.inputParams?.featureID === this.featureID)
      : null;
    const refName = feature?.inputParams?.sketchPlane || null;
    const refObj = refName ? ph.scene.getObjectByName(refName) : null;

    // Compute basis from reference (fallback to world XY), prefer persisted basis
    let basis = null;
    if (feature?.persistentData?.basis) {
      const b = feature.persistentData.basis;
      basis = {
        x: new THREE.Vector3().fromArray(b.x),
        y: new THREE.Vector3().fromArray(b.y),
        z: new THREE.Vector3().fromArray(b.z),
        origin: new THREE.Vector3().fromArray(b.origin),
      };
    } else {
      basis = this.#basisFromReference(refObj);
    }

    // Determine distance so entire plane is visible
    const d = 20; // generic distance along normal; ortho camera ignores distance for scale, but we keep it stable

    // Apply camera lock
    const q = this.#quatFromAxes(basis.x, basis.y, basis.z);
    v.camera.up.copy(basis.y);
    v.camera.position.copy(basis.origin).addScaledVector(basis.z, d);
    v.camera.quaternion.copy(q);
    v.camera.updateProjectionMatrix();

    // Keep Arcball controls enabled for zoom, but disable rotation; we handle pan ourselves
    //try { v.controls.enabled = true; } catch {}
    // try { v.controls.enableRotate = false; } catch {}
    // try { v.controls.enablePan = true; } catch {}
    // try { v.controls.enableZoom = true; } catch {}

    this._lock = { basis, distance: d, target: basis.origin.clone() };

    // Attach lightweight UI and hide the app sidebar + main toolbar during sketch mode
    try {
      if (v.sidebar) {
        v.sidebar.hidden = true;
        v.sidebar.style.display = "none";
        v.sidebar.style.visibility = "hidden";
      }
    } catch { }
    try {
      if (v.mainToolbar?.root) v.mainToolbar.root.style.display = "none";
    } catch { }
    // UI overlay
    this.#mountOverlayUI();
    this.#mountSketchSidebar();
    this.#mountTopToolbar();
    this.#mountContextBar();

    // Init solver with persisted sketch
    const initialSketch = feature?.persistentData?.sketch || null;
    this._solver = new ConstraintSolver({
      sketch: initialSketch || undefined,
      getSelectionItems: () => Array.from(this._selection),
      updateCanvas: () => this.#rebuildSketchGraphics(),
      notifyUser: (m) => {
        try {
          console.log("[Sketch]", m);
        } catch { }
      },
    });

    // Load persisted dimension offsets (plane-space {du,dv}) if present
    try {
      const savedOffsets = feature?.persistentData?.sketchDimOffsets || null;
      if (savedOffsets && typeof savedOffsets === "object") {
        this._dimOffsets = new Map();
        for (const [k, v] of Object.entries(savedOffsets)) {
          const cid = isNaN(+k) ? k : +k;
          if (v && typeof v === "object") {
            if (v.d !== undefined) {
              const d = Number(v.d) || 0;
              this._dimOffsets.set(cid, { d });
            } else if (v.dr !== undefined || v.dp !== undefined) {
              const dr = Number(v.dr) || 0;
              const dp = Number(v.dp) || 0;
              this._dimOffsets.set(cid, { dr, dp });
            } else {
              const du = Number(v.du) || 0;
              const dv = Number(v.dv) || 0;
              this._dimOffsets.set(cid, { du, dv });
            }
          }
        }
      }
    } catch { }

    // Build editing group
    this._sketchGroup = new THREE.Group();
    this._sketchGroup.name = `__SKETCH_EDIT__:${this.featureID}`;
    v.scene.add(this._sketchGroup);
    // Dimension 3D group
    this._dim3D = new THREE.Group();
    this._dim3D.name = `__SKETCH_DIMS__:${this.featureID}`;
    v.scene.add(this._dim3D);
    this.#rebuildSketchGraphics();

    // Mount label overlay root and initial render
    this.#mountDimRoot();
    this.#renderDimensions();

    // Keep handles a constant screen size while zooming
    const tick = () => {
      try {
        this.#updateHandleSizes();
      } catch { }
      this._sizeRAF = requestAnimationFrame(tick);
    };
    this._sizeRAF = requestAnimationFrame(tick);

    // Pointer listeners for panning
    const el = v.renderer.domElement;
    this._onMove = (e) => this.#onPointerMove(e);
    this._onDown = (e) => this.#onPointerDown(e);
    this._onUp = (e) => this.#onPointerUp(e);
    el.addEventListener("pointermove", this._onMove, { passive: false });
    el.addEventListener("pointerdown", this._onDown, { passive: false });
    window.addEventListener("pointerup", this._onUp, {
      passive: false,
      capture: true,
    });
  }

  close() {
    const v = this.viewer;
    if (this._ui && v?.container) {
      try {
        v.container.removeChild(this._ui);
      } catch { }
      this._ui = null;
    }
    if (this._left && v?.container) {
      try {
        v.container.removeChild(this._left);
      } catch { }
      this._left = null;
    }
    if (this._topbar && v?.container) {
      try {
        v.container.removeChild(this._topbar);
      } catch { }
      this._topbar = null;
    }
    if (this._ctxBar && v?.container) {
      try {
        v.container.removeChild(this._ctxBar);
      } catch { }
      this._ctxBar = null;
    }
    if (this._sketchGroup && v?.scene) {
      try {
        v.scene.remove(this._sketchGroup);
      } catch { }
      this._sketchGroup = null;
    }
    if (this._dim3D && v?.scene) {
      try {
        v.scene.remove(this._dim3D);
      } catch { }
      this._dim3D = null;
    }
    if (this._saved && v) {
      v.camera.position.copy(this._saved.position);
      v.camera.quaternion.copy(this._saved.quaternion);
      v.camera.up.copy(this._saved.up);
      v.camera.updateProjectionMatrix();
      v.controls.enabled = this._saved.controlsEnabled;
    }
    // remove listeners
    const el = v?.renderer?.domElement;
    if (el) {
      try {
        el.removeEventListener("pointermove", this._onMove);
      } catch { }
      try {
        el.removeEventListener("pointerdown", this._onDown);
      } catch { }
    }
    try {
      window.removeEventListener("pointerup", this._onUp, true);
    } catch { }
    this._lock = null;
    try {
      cancelAnimationFrame(this._sizeRAF);
    } catch { }
    // Remove dimension overlay
    try {
      if (this._dimRoot && v?.container) v.container.removeChild(this._dimRoot);
    } catch { }
    this._dimRoot = null;
    this._dimOffsets.clear();

    // Restore sidebar and main toolbar
    try {
      if (v.sidebar) {
        v.sidebar.hidden = false;
        v.sidebar.style.display = "";
        v.sidebar.style.visibility = "visible";
        v.sidebar.style.opacity = 0.9;
      }
    } catch { }
    try {
      if (v.mainToolbar?.root) v.mainToolbar.root.style.display = "";
    } catch { }
  }

  dispose() {
    this.close();
  }

  finish() {
    // Persist dimension offsets onto the feature before delegating to viewer
    try {
      const ph = this.viewer?.partHistory;
      const f = Array.isArray(ph?.features)
        ? ph.features.find((x) => x?.inputParams?.featureID === this.featureID)
        : null;
      if (f) {
        f.persistentData = f.persistentData || {};
        const obj = {};
        for (const [cid, off] of this._dimOffsets.entries()) {
          if (off && typeof off.d === "number") {
            obj[String(cid)] = { d: Number(off.d) };
          } else if (off && (off.dr !== undefined || off.dp !== undefined)) {
            obj[String(cid)] = {
              dr: Number(off.dr) || 0,
              dp: Number(off.dp) || 0,
            };
          } else {
            obj[String(cid)] = {
              du: Number(off?.du) || 0,
              dv: Number(off?.dv) || 0,
            };
          }
        }
        f.persistentData.sketchDimOffsets = obj;
      }
    } catch { }

    const sketch = this._solver ? this._solver.sketchObject : null;
    try {
      if (typeof this.viewer?.onSketchFinished === "function")
        this.viewer.onSketchFinished(this.featureID, sketch);
    } catch { }
    this.close();
  }

  cancel() {
    try {
      if (typeof this.viewer?.onSketchCancelled === "function")
        this.viewer.onSketchCancelled(this.featureID);
    } catch { }
    this.close();
  }

  // -------------------------- internals --------------------------
  #mountOverlayUI() {
    const v = this.viewer;
    const host = v?.container;
    if (!host) return;
    const ui = document.createElement("div");
    ui.style.position = "absolute";
    ui.style.top = "8px";
    ui.style.right = "8px";
    ui.style.display = "flex";
    ui.style.gap = "8px";
    ui.style.zIndex = "1000";

    const mk = (label, primary, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.appearance = "none";
      b.style.border = "1px solid #262b36";
      b.style.borderRadius = "8px";
      b.style.padding = "6px 10px";
      b.style.cursor = "pointer";
      b.style.background = primary
        ? "linear-gradient(180deg, rgba(110,168,254,.25), rgba(110,168,254,.15))"
        : "rgba(255,255,255,.05)";
      b.style.color = "#e6e6e6";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        onClick();
      });
      return b;
    };
    ui.appendChild(mk("Finish", true, () => this.finish()));
    ui.appendChild(mk("Cancel", false, () => this.cancel()));
    host.style.position = host.style.position || "relative";
    host.appendChild(ui);
    this._ui = ui;
  }

  #onPointerDown(e) {
    // Tool-based behavior
    if (this._tool !== "select" && e.button === 0) {
      const hit = this.#hitTestPoint(e);
      let pid = hit;
      if (pid == null) {
        // Create a new point at cursor on sketch plane
        const uv = this.#pointerToPlaneUV(e);
        if (uv) {
          const s = this._solver.sketchObject;
          const nextId = Math.max(0, ...s.points.map((p) => +p.id || 0)) + 1;
          s.points.push({ id: nextId, x: uv.u, y: uv.v, fixed: false });
          pid = nextId;
          this._solver.solveSketch("full");
          this.#rebuildSketchGraphics();
        }
      }
      if (pid != null) {
        // Geometry creation flows
        if (this._tool === "line") {
          this.#toggleSelection({ type: "point", id: pid });
          if (
            Array.from(this._selection).filter((i) => i.type === "point")
              .length === 2
          ) {
            this._solver.geometryCreateLine();
            this._selection.clear();
            this._tool = "select";
            this.#rebuildSketchGraphics();
            this.#refreshLists();
            this.#refreshContextBar();
          }
        } else if (this._tool === "circle") {
          this.#toggleSelection({ type: "point", id: pid });
          if (
            Array.from(this._selection).filter((i) => i.type === "point")
              .length === 2
          ) {
            this._solver.geometryCreateCircle();
            this._selection.clear();
            this._tool = "select";
            this.#rebuildSketchGraphics();
            this.#refreshLists();
            this.#refreshContextBar();
          }
        } else if (this._tool === "arc") {
          // Center -> start -> end ordering
          this._arcSel = this._arcSel || { c: null, a: null };
          if (!this._arcSel.c) {
            this._arcSel.c = pid;
            this.#toggleSelection({ type: "point", id: pid });
          } else if (!this._arcSel.a) {
            this._arcSel.a = pid;
            this.#toggleSelection({ type: "point", id: pid });
          } else {
            const c = this._arcSel.c,
              a = this._arcSel.a,
              b = pid;
            this._solver.createGeometry("arc", [c, a, b]);
            this._arcSel = null;
            this._selection.clear();
            this._tool = "select";
            this.#rebuildSketchGraphics();
            this.#refreshLists();
            this.#refreshContextBar();
          }
        }
      }
      if (e.button === 0) {
        try {
          e.preventDefault();
          e.stopPropagation();
        } catch { }
      }
      return;
    }

    // Select tool: if clicking a point, arm a pending drag; else try dim/geometry; else pan
    const hit = this.#hitTestPoint(e);
    if (hit != null) {
      this._pendingDrag.pointId = hit;
      this._pendingDrag.x = e.clientX;
      this._pendingDrag.y = e.clientY;
      this._pendingDrag.started = false;
    } else {
      const dhit = this.#hitTestDim(e);
      if (dhit && e.button === 0) {
        this.#startDimDrag(dhit.cid, e);
      } else {
        const ghit = this.#hitTestGeometry(e);
        if (ghit && e.button === 0) {
          this.#toggleSelection({ type: "geometry", id: ghit.id });
          this.#refreshContextBar();
          this.#rebuildSketchGraphics();
        } else {
          // clicked empty space → clear selection
          if (e.button === 0) {
            if (this._selection.size) {
              this._selection.clear();
              this.#refreshContextBar();
              this.#rebuildSketchGraphics();
            }
            this._panning = true;
            this._panStart.x = e.clientX;
            this._panStart.y = e.clientY;
          }
        }
      }
    }
    if (e.button === 0) {
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch { }
    }
  }

  #onPointerMove(e) {
    // Promote pending to active when moved sufficiently
    const threshold = 4;
    if (!this._drag.active && this._pendingDrag.pointId != null) {
      const d = Math.hypot(
        e.clientX - this._pendingDrag.x,
        e.clientY - this._pendingDrag.y,
      );
      if (d >= threshold) {
        this._drag.active = true;
        this._drag.pointId = this._pendingDrag.pointId;
        this._pendingDrag.started = true;
      }
    }

    if (this._drag.active) {
      const uv = this.#pointerToPlaneUV(e);
      if (!uv) return;
      const p = this._solver?.getPointById(this._drag.pointId);
      if (p) {
        p.x = uv.u;
        p.y = uv.v;
        this._solver.solveSketch("full");
        this.#rebuildSketchGraphics();
      }
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch { }
      return;
    }
    if (this._dragDim?.active) {
      this.#moveDimDrag(e);
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch { }
      return;
    }
    if (!this._panning || !this._lock) return;
    const dx = e.clientX - this._panStart.x;
    const dy = e.clientY - this._panStart.y;
    if (dx === 0 && dy === 0) return;
    this._panStart.x = e.clientX;
    this._panStart.y = e.clientY;
    const v = this.viewer;
    const { width, height } = this.#canvasClientSize(v.renderer.domElement);
    const wpp = this.#worldPerPixel(v.camera, width, height);
    const move = new THREE.Vector3();
    move.addScaledVector(this._lock.basis.x, -dx * wpp);
    move.addScaledVector(this._lock.basis.y, dy * wpp);
    v.camera.position.add(move);
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch { }
    // Update overlay positions while panning
    try {
      this.#updateDimPositions();
    } catch { }
  }

  #onPointerUp(e) {
    // If no drag happened, treat as selection toggle
    if (
      !this._drag.active &&
      this._pendingDrag.pointId != null &&
      !this._pendingDrag.started
    ) {
      // Toggle the clicked point without requiring a modifier key
      this.#toggleSelection({ type: "point", id: this._pendingDrag.pointId });
      this.#refreshContextBar();
      this.#rebuildSketchGraphics();
    }
    // End any dimension drag
    try {
      if (this._dragDim?.active) this.#endDimDrag(e);
    } catch { }
    this._panning = false;
    this._drag.active = false;
    this._drag.pointId = null;
    this._pendingDrag.pointId = null;
    this._pendingDrag.started = false;
  }

  #canvasClientSize(canvas) {
    return {
      width: canvas.clientWidth || canvas.width || 1,
      height: canvas.clientHeight || canvas.height || 1,
    };
  }

  #worldPerPixel(camera, width, height) {
    if (camera && camera.isOrthographicCamera) {
      const zoom =
        typeof camera.zoom === "number" && camera.zoom > 0 ? camera.zoom : 1;
      const wppX = (camera.right - camera.left) / (width * zoom);
      const wppY = (camera.top - camera.bottom) / (height * zoom);
      return Math.max(wppX, wppY);
    }
    // Perspective fallback
    const dist = camera.position.length();
    const fovRad = (camera.fov * Math.PI) / 180;
    return (2 * Math.tan(fovRad / 2) * dist) / height;
  }

  #plane() {
    const n = this._lock?.basis?.z?.clone();
    const o = this._lock?.basis?.origin?.clone();
    if (!n || !o) return null;
    return new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
  }

  #pointerToPlaneUV(e) {
    const v = this.viewer;
    if (!v || !this._lock) return null;
    const rect = v.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
    this._raycaster.setFromCamera(ndc, v.camera);
    const pl = this.#plane();
    if (!pl) return null;
    const hit = new THREE.Vector3();
    const ok = this._raycaster.ray.intersectPlane(pl, hit);
    if (!ok) return null;
    const o = this._lock.basis.origin;
    const bx = this._lock.basis.x;
    const by = this._lock.basis.y;
    const d = hit.clone().sub(o);
    return { u: d.dot(bx), v: d.dot(by) };
  }

  #basisFromReference(obj) {
    const x = new THREE.Vector3(1, 0, 0);
    const y = new THREE.Vector3(0, 1, 0);
    const z = new THREE.Vector3(0, 0, 1);
    const origin = new THREE.Vector3(0, 0, 0);
    if (!obj) return { x, y, z, origin };

    // Compute origin: object world position or centroid of geometry
    obj.updateWorldMatrix(true, true);
    origin.copy(obj.getWorldPosition(new THREE.Vector3()));

    // If FACE, attempt to use its average normal and a stable X axis
    if (obj.type === "FACE" && typeof obj.getAverageNormal === "function") {
      const n = obj.getAverageNormal();
      const worldUp = new THREE.Vector3(0, 1, 0);
      const tmp = new THREE.Vector3();
      const zx =
        Math.abs(n.dot(worldUp)) > 0.9 ? new THREE.Vector3(1, 0, 0) : worldUp; // pick a non-parallel ref
      x.copy(tmp.crossVectors(zx, n).normalize());
      y.copy(tmp.crossVectors(n, x).normalize());
      z.copy(n.clone().normalize());
      // origin ~ face centroid if available
      const g = obj.geometry;
      try {
        const bs =
          g.boundingSphere || (g.computeBoundingSphere(), g.boundingSphere);
        if (bs) origin.copy(obj.localToWorld(bs.center.clone()));
      } catch { }
      return { x, y, z, origin };
    }

    // For generic Mesh (plane), derive z from its world normal
    const n = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const tmp = new THREE.Vector3();
    const zx =
      Math.abs(n.dot(worldUp)) > 0.9 ? new THREE.Vector3(1, 0, 0) : worldUp; // non-parallel ref
    x.copy(tmp.crossVectors(zx, n).normalize());
    y.copy(tmp.crossVectors(n, x).normalize());
    z.copy(n);
    return { x, y, z, origin };
  }

  #quatFromAxes(x, y, z) {
    // Build a quaternion from orthonormal axes
    const m = new THREE.Matrix4();
    m.makeBasis(x, y, z);
    const q = new THREE.Quaternion();
    q.setFromRotationMatrix(m);
    return q;
  }

  // ---------- UI + Drawing ----------
  #mountSketchSidebar() {
    const v = this.viewer;
    const host = v?.container;
    if (!host) return;
    const wrap = document.createElement("div");
    wrap.style.position = "absolute";
    wrap.style.left = "8px";
    wrap.style.top = "8px";
    wrap.style.width = "300px";
    wrap.style.maxHeight = "85%";
    wrap.style.overflow = "auto";
    wrap.style.zIndex = "2147483646";
    const title = document.createElement("div");
    title.textContent = "Sketch";
    title.style.color = "#e6e6e6";
    title.style.margin = "0 0 6px 2px";
    title.style.font = "600 12px system-ui, sans-serif";
    wrap.appendChild(title);
    const acc = new AccordionWidget();
    wrap.appendChild(acc.uiElement);
    host.appendChild(wrap);
    this._left = wrap;
    this._acc = acc;
    (async () => {
      this._secConstraints = await acc.addSection("Constraints");
      this._secCurves = await acc.addSection("Curves");
      this._secPoints = await acc.addSection("Points");
      this.#refreshLists();
    })();
  }

  #mountTopToolbar() {
    const v = this.viewer;
    const host = v?.container;
    if (!host) return;
    const bar = document.createElement("div");
    bar.style.position = "absolute";
    bar.style.top = "8px";
    bar.style.left = "50%";
    bar.style.transform = "translateX(-50%)";
    bar.style.display = "flex";
    bar.style.gap = "6px";
    bar.style.background = "rgba(20,24,30,.85)";
    bar.style.border = "1px solid #262b36";
    bar.style.borderRadius = "8px";
    bar.style.padding = "6px";
    const mk = (label, tool) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.color = "#ddd";
      b.style.background = "transparent";
      b.style.border = "1px solid #364053";
      b.style.borderRadius = "6px";
      b.style.padding = "4px 8px";
      b.onclick = () => {
        this._tool = tool;
      };
      return b;
    };
    bar.appendChild(mk("Select", "select"));
    bar.appendChild(mk("Line", "line"));
    bar.appendChild(mk("Circle", "circle"));
    bar.appendChild(mk("Arc", "arc"));
    this._topbar = bar;
    host.appendChild(bar);
  }

  #mountContextBar() {
    const v = this.viewer;
    const host = v?.container;
    if (!host) return;
    const ctx = document.createElement("div");
    ctx.style.position = "absolute";
    ctx.style.top = "100px";
    ctx.style.right = "8px";
    ctx.style.display = "flex";
    ctx.style.gap = "6px";
    ctx.style.background = "rgba(20,24,30,.85)";
    ctx.style.border = "1px solid #262b36";
    ctx.style.borderRadius = "8px";
    ctx.style.padding = "6px";
    ctx.style.color = "#ddd";
    host.appendChild(ctx);
    this._ctxBar = ctx;
    this.#refreshContextBar();
  }

  #refreshLists() {
    if (!this._acc || !this._solver) return;
    const s = this._solver.sketchObject;
    const row = (label, act, delAct) => `
      <div class=\"sk-row\" style=\"display:flex;align-items:center;gap:6px;margin:2px 0\"> 
        <button data-act=\"${act}\" style=\"flex:1;text-align:left;background:transparent;color:#ddd;border:1px solid #364053;border-radius:4px;padding:3px 6px\">${label}</button>
        <button data-del=\"${delAct}\" title=\"Delete\" style=\"color:#ff8b8b;background:transparent;border:1px solid #5b2b2b;border-radius:4px;padding:3px 6px\">✕</button>
      </div>`;
    if (this._secConstraints)
      this._secConstraints.uiElement.innerHTML = (s.constraints || [])
        .map((c) =>
          row(
            `${c.id} ${c.type} ${c.value ?? ""} [${c.points?.join(",")}]`,
            `c:${c.id}`,
            `c:${c.id}`,
          ),
        )
        .join("");
    if (this._secCurves)
      this._secCurves.uiElement.innerHTML = (s.geometries || [])
        .map((g) =>
          row(
            `${g.type}:${g.id} [${g.points?.join(",")}]`,
            `g:${g.id}`,
            `g:${g.id}`,
          ),
        )
        .join("");
    if (this._secPoints)
      this._secPoints.uiElement.innerHTML = (s.points || [])
        .map((p) =>
          row(
            `P${p.id} (${p.x.toFixed(2)}, ${p.y.toFixed(2)})${p.fixed ? " ⏚" : ""}`,
            `p:${p.id}`,
            `p:${p.id}`,
          ),
        )
        .join("");
    // Delegate clicks for selection
    this._acc.uiElement.onclick = (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      const del = t.getAttribute("data-del");
      if (del) {
        const [k, id] = del.split(":");
        if (k === "p") {
          try {
            this._solver.removePointById?.(parseInt(id));
          } catch { }
        }
        if (k === "g") {
          try {
            this._solver.removeGeometryById?.(parseInt(id));
          } catch { }
        }
        if (k === "c") {
          try {
            this._solver.removeConstraintById?.(parseInt(id));
          } catch { }
        }
        try {
          this._solver.solveSketch("full");
        } catch { }
        this.#rebuildSketchGraphics();
        this.#refreshContextBar();
        return;
      }
      const act = t.getAttribute("data-act");
      if (!act) return;
      const [k, id] = act.split(":");
      if (k === "p") this.#toggleSelection({ type: "point", id: parseInt(id) });
      if (k === "g")
        this.#toggleSelection({ type: "geometry", id: parseInt(id) });
      if (k === "c") {
        this.#toggleSelection({ type: "constraint", id: parseInt(id) });
      }
      this.#refreshContextBar();
    };
  }

  #refreshContextBar() {
    if (!this._ctxBar || !this._solver) return;
    const items = Array.from(this._selection);
    const s = this._solver.sketchObject;
    // Gather point coverage from selection
    const points = new Set(
      items.filter((i) => i.type === "point").map((i) => i.id),
    );
    const geos = items
      .filter((i) => i.type === "geometry")
      .map((i) => s.geometries.find((g) => g.id === parseInt(i.id)))
      .filter(Boolean);
    for (const g of geos) {
      const gp = g.type === "arc" ? g.points.slice(0, 2) : g.points;
      gp.forEach((pid) => points.add(pid));
    }
    const pointCount = points.size;

    this._ctxBar.innerHTML = "";
    const mk = (label, type) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.color = "#ddd";
      b.style.background = "transparent";
      b.style.border = "1px solid #364053";
      b.style.borderRadius = "6px";
      b.style.padding = "4px 8px";
      b.onclick = () => {
        this._solver.createConstraint(type, items);
        this.#refreshLists();
        this.#refreshContextBar();
      };
      return b;
    };

    // Arc/Circle → Radius / Diameter
    const oneArc =
      geos.length === 1 &&
      (geos[0]?.type === "arc" || geos[0]?.type === "circle");
    if (oneArc) {
      const mkAct = (label, mode) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.color = "#ddd";
        b.style.background = "transparent";
        b.style.border = "1px solid #364053";
        b.style.borderRadius = "6px";
        b.style.padding = "4px 8px";
        b.onclick = () => {
          this.#addRadialDimension(mode, items);
        };
        return b;
      };
      this._ctxBar.appendChild(mkAct("Radius", "radius"));
      this._ctxBar.appendChild(mkAct("Diameter", "diameter"));
      // Also allow delete
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.style.color = "#ff8b8b";
      del.style.background = "transparent";
      del.style.border = "1px solid #5b2b2b";
      del.style.borderRadius = "6px";
      del.style.padding = "4px 8px";
      del.onclick = () => this.#deleteSelection();
      this._ctxBar.appendChild(del);
      return;
    }

    // Geometry x Geometry (2 lines) → Parallel / Perp / Angle
    const twoLines = geos.length === 2 && geos.every((g) => g?.type === "line");
    if (twoLines) {
      this._ctxBar.appendChild(mk("Parallel ∥", "∥"));
      this._ctxBar.appendChild(mk("Perpendicular ⟂", "⟂"));
      this._ctxBar.appendChild(mk("Angle ∠", "∠"));
      // Also allow delete when any selection exists
      if (items.length) {
        const del = document.createElement("button");
        del.textContent = "Delete";
        del.style.color = "#ff8b8b";
        del.style.background = "transparent";
        del.style.border = "1px solid #5b2b2b";
        del.style.borderRadius = "6px";
        del.style.padding = "4px 8px";
        del.onclick = () => this.#deleteSelection();
        this._ctxBar.appendChild(del);
      }
      return;
    }

    if (pointCount === 1) this._ctxBar.appendChild(mk("Ground ⏚", "⏚"));
    if (pointCount === 2) {
      this._ctxBar.appendChild(mk("H ━", "━"));
      this._ctxBar.appendChild(mk("V │", "│"));
      this._ctxBar.appendChild(mk("Coincident ≡", "≡"));
      this._ctxBar.appendChild(mk("Distance ⟺", "⟺"));
    }
    if (pointCount === 3) {
      this._ctxBar.appendChild(mk("Colinear ⋯", "⋯"));
      this._ctxBar.appendChild(mk("Angle ∠", "∠"));
    }

    // Generic Delete: show if any selection (points, curves, constraints)
    if (items.length) {
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.style.color = "#ff8b8b";
      del.style.background = "transparent";
      del.style.border = "1px solid #5b2b2b";
      del.style.borderRadius = "6px";
      del.style.padding = "4px 8px";
      del.onclick = () => this.#deleteSelection();
      this._ctxBar.appendChild(del);
    }
  }

  // Remove selected items (geometries first, then points) and refresh
  #deleteSelection() {
    try {
      const s = this._solver;
      if (!s) return;
      const items = Array.from(this._selection || []);
      // Delete constraints first
      for (const it of items)
        if (it?.type === "constraint") {
          try { s.removeConstraintById?.(parseInt(it.id)); } catch { }
        }
      // Delete geometries next to avoid dangling refs
      for (const it of items)
        if (it?.type === "geometry") {
          try {
            s.removeGeometryById?.(parseInt(it.id));
          } catch { }
        }
      for (const it of items)
        if (it?.type === "point") {
          try {
            s.removePointById?.(parseInt(it.id));
          } catch { }
        }
      try {
        s.solveSketch("full");
      } catch { }
      this._selection.clear();
      this.#rebuildSketchGraphics();
      this.#refreshContextBar();
    } catch { }
  }

  // Create a radial dimension visualization as a solver constraint
  #addRadialDimension(mode, items) {
    try {
      // Create a radius constraint via solver
      this._solver.createConstraint("⟺", items);
      // Find newest constraint
      const s = this._solver.sketchObject;
      const newest = (s.constraints || []).reduce(
        (a, b) => (+(a?.id || 0) > +b.id ? a : b),
        null,
      );
      if (!newest) return;
      // Set display style for visualization only
      newest.displayStyle = mode === "diameter" ? "diameter" : "radius";
      // Seed a default offset so text/leaders are visible outside the rim
      const rect = this.viewer.renderer.domElement.getBoundingClientRect();
      const base = Math.max(
        0.1,
        this.#worldPerPixel(this.viewer.camera, rect.width, rect.height) * 10,
      );
      this._dimOffsets.set(newest.id, { dr: base * 0.5, dp: base * 0.5 });
      // Re-solve and redraw
      this._solver.solveSketch("full");
      this.#rebuildSketchGraphics();
      this.#refreshContextBar();
    } catch { }
  }

  #toggleSelection(item) {
    const key = item.type + ":" + item.id;
    const existing = Array.from(this._selection).find(
      (s) => s.type + ":" + s.id === key,
    );
    if (existing) this._selection.delete(existing);
    else this._selection.add(item);
  }

  #hitTestPoint(e) {
    if (!this._sketchGroup) return null;
    const v = this.viewer;
    const rect = v.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
    this._raycaster.setFromCamera(ndc, v.camera);
    const hits = this._raycaster.intersectObjects(
      this._sketchGroup.children,
      true,
    );
    for (const h of hits) {
      const ud = h.object?.userData || {};
      if (ud.kind === "point" && Number.isFinite(ud.id)) return ud.id;
    }
    return null;
  }

  #hitTestGeometry(e) {
    if (!this._sketchGroup) return null;
    const v = this.viewer;
    const rect = v.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
    this._raycaster.setFromCamera(ndc, v.camera);
    try {
      const { width, height } = this.#canvasClientSize(v.renderer.domElement);
      const wpp = this.#worldPerPixel(v.camera, width, height);
      this._raycaster.params.Line = this._raycaster.params.Line || {};
      this._raycaster.params.Line.threshold = Math.max(0.05, wpp * 6);
    } catch { }
    const hits = this._raycaster.intersectObjects(
      this._sketchGroup.children,
      true,
    );
    for (const h of hits) {
      const ud = h.object?.userData || {};
      if (ud.kind === "geometry" && Number.isFinite(ud.id))
        return { id: ud.id, type: ud.type };
    }
    return null;
  }
  #hitTestDim(e) {
    if (!this._dim3D) return null;
    const v = this.viewer;
    const rect = v.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
    this._raycaster.setFromCamera(ndc, v.camera);
    try {
      const { width, height } = this.#canvasClientSize(v.renderer.domElement);
      const wpp = this.#worldPerPixel(v.camera, width, height);
      this._raycaster.params.Line = this._raycaster.params.Line || {};
      this._raycaster.params.Line.threshold = Math.max(0.05, wpp * 6);
    } catch { }
    const hits = this._raycaster.intersectObjects(this._dim3D.children, true);
    for (const h of hits) {
      const ud = h.object?.userData || {};
      if (ud.kind === "dim" && ud.cid !== undefined && ud.cid !== null)
        return { cid: ud.cid };
    }
    return null;
  }

  #rebuildSketchGraphics() {
    const grp = this._sketchGroup;
    if (!grp || !this._solver) return;
    for (let i = grp.children.length - 1; i >= 0; i--) {
      const ch = grp.children[i];
      grp.remove(ch);
      try {
        ch.geometry?.dispose();
        ch.material?.dispose?.();
      } catch { }
    }
    const s = this._solver.sketchObject;
    const b = this._lock?.basis;
    if (!b) return;
    const O = b.origin,
      X = b.x,
      Y = b.y;
    const to3 = (u, v) =>
      new THREE.Vector3().copy(O).addScaledVector(X, u).addScaledVector(Y, v);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffff88 });
    for (const geo of s.geometries || []) {
      if (geo.type === "line" && geo.points?.length === 2) {
        const p0 = s.points.find((p) => p.id === geo.points[0]);
        const p1 = s.points.find((p) => p.id === geo.points[1]);
        if (!p0 || !p1) continue;
        const a = to3(p0.x, p0.y),
          b3 = to3(p1.x, p1.y);
        const bg = new THREE.BufferGeometry().setFromPoints([a, b3]);
        const sel = Array.from(this._selection).some(
          (it) => it.type === "geometry" && it.id === geo.id,
        );
        const mat = lineMat.clone();
        try {
          mat.color.set(sel ? 0x6fe26f : 0xffff88);
        } catch { }
        const ln = new THREE.Line(bg, mat);
        ln.userData = { kind: "geometry", id: geo.id, type: "line" };
        grp.add(ln);
      } else if (geo.type === "circle") {
        const ids = geo.points || [];
        const pC = s.points.find((p) => p.id === ids[0]);
        const pR = s.points.find((p) => p.id === ids[1]);
        if (!pC || !pR) continue;
        const rr = Math.hypot(pR.x - pC.x, pR.y - pC.y);
        const segs = 64;
        const pts = [];
        for (let i = 0; i <= segs; i++) {
          const t = (i / segs) * Math.PI * 2;
          pts.push(to3(pC.x + rr * Math.cos(t), pC.y + rr * Math.sin(t)));
        }
        const bg = new THREE.BufferGeometry().setFromPoints(pts);
        const sel = Array.from(this._selection).some(
          (it) => it.type === "geometry" && it.id === geo.id,
        );
        const mat = lineMat.clone();
        try {
          mat.color.set(sel ? 0x6fe26f : 0xffff88);
        } catch { }
        const ln = new THREE.Line(bg, mat);
        ln.userData = { kind: "geometry", id: geo.id, type: geo.type };
        grp.add(ln);
      } else if (geo.type === "arc") {
        const ids = geo.points || [];
        const pC = s.points.find((p) => p.id === ids[0]);
        const pA = s.points.find((p) => p.id === ids[1]);
        const pB = s.points.find((p) => p.id === ids[2]);
        if (!pC || !pA || !pB) continue;
        const cx = pC.x,
          cy = pC.y;
        const rr = Math.hypot(pA.x - cx, pA.y - cy);
        let a0 = Math.atan2(pA.y - cy, pA.x - cx);
        let a1 = Math.atan2(pB.y - cy, pB.x - cx);
        let d = a1 - a0;
        while (d <= -Math.PI) d += 2 * Math.PI;
        while (d > Math.PI) d -= 2 * Math.PI;
        const segs = Math.max(8, Math.ceil((64 * Math.abs(d)) / (2 * Math.PI)));
        const pts = [];
        for (let i = 0; i <= segs; i++) {
          const t = a0 + d * (i / segs);
          pts.push(to3(cx + rr * Math.cos(t), cy + rr * Math.sin(t)));
        }
        const bg = new THREE.BufferGeometry().setFromPoints(pts);
        const sel = Array.from(this._selection).some(
          (it) => it.type === "geometry" && it.id === geo.id,
        );
        const mat = lineMat.clone();
        try {
          mat.color.set(sel ? 0x6fe26f : 0xffff88);
        } catch { }
        const ln = new THREE.Line(bg, mat);
        ln.userData = { kind: "geometry", id: geo.id, type: geo.type };
        grp.add(ln);
      }
    }
    const { width, height } = this.#canvasClientSize(
      this.viewer.renderer.domElement,
    );
    const wpp = this.#worldPerPixel(this.viewer.camera, width, height);
    const r = Math.max(0.02, wpp * 8 * 0.5);
    for (const p of s.points || []) {
      const selected = Array.from(this._selection).some(
        (it) => it.type === "point" && it.id === p.id,
      );
      const mat = new THREE.MeshBasicMaterial({
        color: selected ? 0x6fe26f : 0x9ec9ff,
      });
      const m = new THREE.Mesh(this._handleGeom, mat);
      m.position.copy(to3(p.x, p.y));
      m.userData = { kind: "point", id: p.id };
      m.scale.setScalar(r);
      grp.add(m);
    }
    this.#refreshLists();
    this.#renderDimensions();
  }

  #updateHandleSizes() {
    if (!this._sketchGroup) return;
    const { width, height } = this.#canvasClientSize(
      this.viewer.renderer.domElement,
    );
    const r = Math.max(
      0.02,
      this.#worldPerPixel(this.viewer.camera, width, height) * 8 * 0.5,
    );
    if (Math.abs(r - this._lastHandleScale) < 1e-4) return;
    this._lastHandleScale = r;
    for (const ch of this._sketchGroup.children) {
      if (ch?.userData?.kind === "point") ch.scale.setScalar(r);
    }
  }

  // ============================= Dimension overlays =============================
  #mountDimRoot() {
    const host = this.viewer?.container;
    if (!host) return;
    const el = document.createElement("div");
    el.className = "sketch-dims";
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.top = "0";
    el.style.right = "0";
    el.style.bottom = "0";
    el.style.pointerEvents = "none";
    // SVG for lines/leaders under labels
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.position = "absolute";
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.pointerEvents = "none";
    el.appendChild(svg);
    this._dimSVG = svg;

    host.appendChild(el);
    this._dimRoot = el;
  }

  #clearDims() {
    if (!this._dimRoot) return;
    // Clear labels
    const labels = Array.from(this._dimRoot.querySelectorAll(".dim-label"));
    labels.forEach((n) => n.parentNode && n.parentNode.removeChild(n));
    // Clear SVG content (kept empty for now)
    if (this._dimSVG)
      while (this._dimSVG.firstChild)
        this._dimSVG.removeChild(this._dimSVG.firstChild);
    // Clear 3D leaders
    if (this._dim3D) {
      while (this._dim3D.children.length) {
        const ch = this._dim3D.children.pop();
        try {
          ch.geometry?.dispose();
          ch.material?.dispose?.();
        } catch { }
      }
    }
  }

  #renderDimensions() {
    if (!this._dimRoot || !this._solver || !this._lock) return;
    this.#clearDims();
    const s = this._solver.sketchObject;
    const to3 = (u, v) =>
      new THREE.Vector3()
        .copy(this._lock.basis.origin)
        .addScaledVector(this._lock.basis.x, u)
        .addScaledVector(this._lock.basis.y, v);
    const P = (id) => s.points.find((p) => p.id === id);

    const mk = (c, text, world, planeOffOverride = null) => {
      const d = document.createElement("div");
      d.className = "dim-label";
      d.style.position = "absolute";
      d.style.padding = "2px 6px";
      d.style.border = "1px solid #364053";
      d.style.borderRadius = "6px";
      d.style.background = "rgba(20,24,30,.9)";
      d.style.color = "#e6e6e6";
      d.style.font = "12px system-ui,sans-serif";
      d.style.pointerEvents = "auto";
      d.textContent = text;

      // Drag support
      let dragging = false,
        sx = 0,
        sy = 0,
        start = {};
      d.addEventListener("pointerdown", (e) => {
        dragging = true;
        const uv = this.#pointerToPlaneUV(e);
        sx = uv?.u || 0;
        sy = uv?.v || 0;
        start = { ...(this._dimOffsets.get(c.id) || {}) };
        d.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
      });
      d.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const uv = this.#pointerToPlaneUV(e);
        if (!uv) return;
        if (
          c.type === "⟺" &&
          c.displayStyle === "radius" &&
          Array.isArray(c.points) &&
          c.points.length >= 2
        ) {
          const sObj = this._solver.sketchObject;
          const pc = sObj.points.find((p) => p.id === c.points[0]);
          const pr = sObj.points.find((p) => p.id === c.points[1]);
          if (!pc || !pr) return;
          const vx = pr.x - pc.x,
            vy = pr.y - pc.y;
          const L = Math.hypot(vx, vy) || 1;
          const rx = vx / L,
            ry = vy / L;
          const nx = -ry,
            ny = rx;
          const baseU =
            pr.x + (Number(start.dr) || 0) * rx + (Number(start.dp) || 0) * nx;
          const baseV =
            pr.y + (Number(start.dr) || 0) * ry + (Number(start.dp) || 0) * ny;
          const du = uv.u - baseU;
          const dv = uv.v - baseV;
          const dr = (Number(start.dr) || 0) + (du * rx + dv * ry);
          const dp = (Number(start.dp) || 0) + (du * nx + dv * ny);
          this._dimOffsets.set(c.id, { dr, dp });
          const labelOff = { du: rx * dr + nx * dp, dv: ry * dr + ny * dp };
          this.#updateOneDimPosition(d, world, labelOff);
          this.#renderDimensions();
        } else {
          const du = (Number(start.du) || 0) + (uv.u - sx);
          const dv = (Number(start.dv) || 0) + (uv.v - sy);
          this._dimOffsets.set(c.id, { du, dv });
          this.#updateOneDimPosition(d, world, { du, dv });
          this.#renderDimensions();
        }
        e.preventDefault();
        e.stopPropagation();
      });
      d.addEventListener("pointerup", (e) => {
        dragging = false;
        try {
          d.releasePointerCapture(e.pointerId);
        } catch { }
        e.preventDefault();
        e.stopPropagation();
      });

      // Edit on double click
      d.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const v = prompt("Enter value", String(c.value ?? ""));
        if (v == null) return;
        const num = parseFloat(v);
        if (!Number.isFinite(num)) return;
        c.value = num;
        try {
          this._solver.solveSketch("full");
        } catch { }
        this.#rebuildSketchGraphics();
      });

      this._dimRoot.appendChild(d);
      const saved = this._dimOffsets.get(c.id) || { du: 0, dv: 0 };
      const off = planeOffOverride || saved;
      this.#updateOneDimPosition(d, world, off);
    };

    for (const c of s.constraints || []) {
      if (c.type === "⟺") {
        if (c.displayStyle === "radius" && c.points?.length >= 2) {
          const pc = P(c.points[0]),
            pr = P(c.points[1]);
          if (!pc || !pr) continue;
          // Draw leader in 3D (with dr/dp dogleg)
          this.#dimRadius3D(pc, pr, c.id);
          // Compute label world from dr/dp
          const v = new THREE.Vector2(pr.x - pc.x, pr.y - pc.y);
          const L = v.length() || 1;
          const rx = v.x / L,
            ry = v.y / L; // radial unit
          const nx = -ry,
            ny = rx; // normal
          const offSaved = this._dimOffsets.get(c.id) || {};
          const dr = Number(offSaved.dr) || 0;
          const dp = Number(offSaved.dp) || 0;
          const label = to3(pr.x + rx * dr + nx * dp, pr.y + ry * dr + ny * dp);
          const val = Number(c.value) ?? 0;
          const txt =
            c.displayStyle === "diameter"
              ? `⌀${(2 * val).toFixed(3)}     Diameter`
              : `R${val.toFixed(3)}     Radius`;
          mk(c, txt, label, { du: 0, dv: 0 });
        } else if (c.points?.length >= 2) {
          const p0 = P(c.points[0]),
            p1 = P(c.points[1]);
          if (!p0 || !p1) continue;
          // Draw dimension line with arrows between p0,p1 (3D)
          const nxny = (() => {
            const dx = p1.x - p0.x,
              dy = p1.y - p0.y;
            const L = Math.hypot(dx, dy) || 1;
            const tx = dx / L,
              ty = dy / L;
            return { nx: -ty, ny: tx };
          })();
          const rect = this.viewer.renderer.domElement.getBoundingClientRect();
          const base = Math.max(
            0.1,
            this.#worldPerPixel(this.viewer.camera, rect.width, rect.height) *
            20,
          );
          const offSaved = this._dimOffsets.get(c.id) || { du: 0, dv: 0 };
          const d =
            typeof offSaved.d === "number"
              ? offSaved.d
              : (offSaved.du || 0) * nxny.nx + (offSaved.dv || 0) * nxny.ny;
          this.#dimDistance3D(p0, p1, c.id);
          mk(
            c,
            String((Number(c.value) ?? 0).toFixed(3)),
            to3((p0.x + p1.x) / 2, (p0.y + p1.y) / 2),
            { du: nxny.nx * (base + d), dv: nxny.ny * (base + d) },
          );
        }
      }
      if (c.type === "∠" && c.points?.length >= 4) {
        const p0 = P(c.points[0]),
          p1 = P(c.points[1]),
          p2 = P(c.points[2]),
          p3 = P(c.points[3]);
        if (!p0 || !p1 || !p2 || !p3) continue;
        const ix = (A, B, C, D) => {
          const den = (A.x - B.x) * (C.y - D.y) - (A.y - B.y) * (C.x - D.x);
          if (Math.abs(den) < 1e-9) return { x: B.x, y: B.y };
          const x =
            ((A.x * A.y - B.x * B.y) * (C.x - D.x) -
              (A.x - B.x) * (C.x * C.y - D.x * D.y)) /
            den;
          const y =
            ((A.x * A.y - B.x * B.y) * (C.y - D.y) -
              (A.y - B.y) * (C.x * C.y - D.x * D.y)) /
            den;
          return { x, y };
        };
        const I = ix(p0, p1, p2, p3);
        this.#dimAngle3D(p0, p1, p2, p3, c.id, I);
        mk(c, String(c.value ?? ""), to3(I.x, I.y));
      }
    }
  }

  #updateOneDimPosition(el, world, off) {
    const du = Number(off?.du) || 0;
    const dv = Number(off?.dv) || 0;
    const w = world
      .clone()
      .add(this._lock.basis.x.clone().multiplyScalar(du))
      .add(this._lock.basis.y.clone().multiplyScalar(dv));
    const pt = w.project(this.viewer.camera);
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const x = (pt.x * 0.5 + 0.5) * rect.width;
    const y = (-pt.y * 0.5 + 0.5) * rect.height;
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  #updateDimPositions() {
    this.#renderDimensions();
  }

  // Lookup a constraint by id from the current sketch
  #getConstraintById(id) {
    const s = this._solver?.sketchObject;
    if (!s) return null;
    const cid = parseInt(id);
    return (s.constraints || []).find((c) => parseInt(c.id) === cid) || null;
  }

  // ----- 3D Draw helpers on sketch plane -----
  #dimDistance3D(p0, p1, cid) {
    const off = this._dimOffsets.get(cid) || { du: 0, dv: 0 };
    const X = this._lock.basis.x,
      Y = this._lock.basis.y,
      O = this._lock.basis.origin;
    const u0 = p0.x,
      v0 = p0.y,
      u1 = p1.x,
      v1 = p1.y;
    const dx = u1 - u0,
      dy = v1 - v0;
    const L = Math.hypot(dx, dy) || 1;
    const tx = dx / L,
      ty = dy / L;
    const nx = -ty,
      ny = tx;
    // Base offset scaled by world-per-pixel so size remains readable (~20px)
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const wpp = this.#worldPerPixel(
      this.viewer.camera,
      rect.width,
      rect.height,
    );
    const base = Math.max(0.1, wpp * 20);
    // Scalar-only placement: project any saved {du,dv} onto normal; prefer explicit {d}
    const d =
      typeof off.d === "number"
        ? off.d
        : (off.du || 0) * nx + (off.dv || 0) * ny;
    const ou = nx * (base + d),
      ov = ny * (base + d);
    // UV helpers
    const P = (u, v) =>
      new THREE.Vector3().copy(O).addScaledVector(X, u).addScaledVector(Y, v);
    const addLine = (pts, mat) => {
      const g = new THREE.BufferGeometry().setFromPoints(
        pts.map((p) => P(p.u, p.v)),
      );
      const ln = new THREE.Line(g, mat);
      ln.userData = { kind: "dim", cid };
      this._dim3D.add(ln);
    };
    const green = new THREE.LineBasicMaterial({ color: 0x67e667 });
    // Dimension line (parallel to segment at offset ou,ov)
    addLine(
      [
        { u: u0 + ou, v: v0 + ov },
        { u: u1 + ou, v: v1 + ov },
      ],
      green,
    );
    // Extension lines (perpendicular to dimension, i.e., along normal)
    addLine(
      [
        { u: u0, v: v0 },
        { u: u0 + ou, v: v0 + ov },
      ],
      green.clone(),
    );
    addLine(
      [
        { u: u1, v: v1 },
        { u: u1 + ou, v: v1 + ov },
      ],
      green.clone(),
    );
    // Arrowheads in UV
    const ah = Math.max(0.06, wpp * 6);
    const s = 0.6; // arrow depth and wing scale
    const arrow = (ux, vy, dir) => {
      const tip = { u: ux + ou, v: vy + ov };
      const ax = dir * tx,
        ay = dir * ty; // along dimension
      const wx = -ay,
        wy = ax; // wing direction (perp to dim)
      const A = {
        u: tip.u + ax * ah + wx * ah * s,
        v: tip.v + ay * ah + wy * ah * s,
      };
      const B = {
        u: tip.u + ax * ah - wx * ah * s,
        v: tip.v + ay * ah - wy * ah * s,
      };
      addLine([{ u: tip.u, v: tip.v }, A], green.clone());
      addLine([{ u: tip.u, v: tip.v }, B], green.clone());
    };
    arrow(u0, v0, 1); // forward at first end
    arrow(u1, v1, -1); // backward at second end
  }

  #dimRadius3D(pc, pr, cid) {
    const off = this._dimOffsets.get(cid) || {};
    const X = this._lock.basis.x,
      Y = this._lock.basis.y,
      O = this._lock.basis.origin;
    const P = (u, v) =>
      new THREE.Vector3().copy(O).addScaledVector(X, u).addScaledVector(Y, v);
    const blue = new THREE.LineBasicMaterial({ color: 0x69a8ff });
    const add = (uvs) => {
      const g = new THREE.BufferGeometry().setFromPoints(
        uvs.map((q) => P(q.u, q.v)),
      );
      const ln = new THREE.Line(g, blue);
      ln.userData = { kind: "dim", cid };
      this._dim3D.add(ln);
    };
    // Compute radial and normal
    const vx = pr.x - pc.x,
      vy = pr.y - pc.y;
    const L = Math.hypot(vx, vy) || 1;
    const rx = vx / L,
      ry = vy / L;
    const nx = -ry,
      ny = rx;
    const dr = Number(off.dr) || 0;
    const dp = Number(off.dp) || 0;
    // Leader parts: center->rim, rim->elbow (radial), elbow->dogleg (normal)
    const elbow = { u: pr.x + rx * dr, v: pr.y + ry * dr };
    const dogleg = { u: elbow.u + nx * dp, v: elbow.v + ny * dp };
    add([
      { u: pc.x, v: pc.y },
      { u: pr.x, v: pr.y },
    ]);
    add([{ u: pr.x, v: pr.y }, elbow]);
    add([elbow, dogleg]);
    // Arrow at rim (pointing from rim toward center)
    const ah = Math.max(
      0.06,
      this.#worldPerPixel(
        this.viewer.camera,
        this.viewer.renderer.domElement.clientWidth,
        this.viewer.renderer.domElement.clientHeight,
      ) * 6,
    );
    const tip = { u: pr.x, v: pr.y };
    const A = {
      u: tip.u - rx * ah + nx * ah * 0.6,
      v: tip.v - ry * ah + ny * ah * 0.6,
    };
    const B = {
      u: tip.u - rx * ah - nx * ah * 0.6,
      v: tip.v - ry * ah - ny * ah * 0.6,
    };
    add([tip, A]);
    add([tip, B]);
  }

  #dimAngle3D(p0, p1, p2, p3, cid, I) {
    const off = this._dimOffsets.get(cid) || { du: 0, dv: 0 };
    const X = this._lock.basis.x,
      Y = this._lock.basis.y,
      O = this._lock.basis.origin;
    const P = (u, v) =>
      new THREE.Vector3().copy(O).addScaledVector(X, u).addScaledVector(Y, v);
    const d1 = new THREE.Vector2(p1.x - p0.x, p1.y - p0.y).normalize();
    const d2 = new THREE.Vector2(p3.x - p2.x, p3.y - p2.y).normalize();
    let a0 = Math.atan2(d1.y, d1.x),
      a1 = Math.atan2(d2.y, d2.x);
    let d = a1 - a0;
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    const r = 0.6;
    const cx = I.x + off.du,
      cy = I.y + off.dv;
    const segs = 32;
    const uvs = [];
    for (let i = 0; i <= segs; i++) {
      const t = a0 + d * (i / segs);
      uvs.push({ u: cx + Math.cos(t) * r, v: cy + Math.sin(t) * r });
    }
    const blue = new THREE.LineBasicMaterial({ color: 0x69a8ff });
    const g = new THREE.BufferGeometry().setFromPoints(
      uvs.map((q) => P(q.u, q.v)),
    );
    const ln = new THREE.Line(g, blue);
    ln.userData = { kind: "dim", cid };
    this._dim3D.add(ln);
    // Arrowheads at arc ends (tangent direction)
    const ah = 0.06;
    const s = 0.6;
    const addArrowUV = (t) => {
      const tx = -Math.sin(t),
        ty = Math.cos(t);
      const wx = -ty,
        wy = tx;
      const tip = { u: cx + Math.cos(t) * r, v: cy + Math.sin(t) * r };
      const A = {
        u: tip.u + tx * ah + wx * ah * s,
        v: tip.v + ty * ah + wy * ah * s,
      };
      const B = {
        u: tip.u + tx * ah - wx * ah * s,
        v: tip.v + ty * ah - wy * ah * s,
      };
      const mat = blue.clone();
      const gg1 = new THREE.BufferGeometry().setFromPoints([
        P(tip.u, tip.v),
        P(A.u, A.v),
      ]);
      const gg2 = new THREE.BufferGeometry().setFromPoints([
        P(tip.u, tip.v),
        P(B.u, B.v),
      ]);
      this._dim3D.add(new THREE.Line(gg1, mat));
      this._dim3D.add(new THREE.Line(gg2, mat));
    };
    addArrowUV(a0);
    addArrowUV(a0 + d);
  }

  #startDimDrag(cid, e) {
    this._dragDim.active = true;
    this._dragDim.cid = cid;
    const uv = this.#pointerToPlaneUV(e) || { u: 0, v: 0 };
    this._dragDim.sx = uv.u;
    this._dragDim.sy = uv.v;
    const off = this._dimOffsets.get(cid) || {};
    const c = this.#getConstraintById(cid);
    if (c && c.type === "⟺" && c.displayStyle === "radius") {
      this._dragDim.mode = "radius";
      this._dragDim.start = {
        dr: Number(off.dr) || 0,
        dp: Number(off.dp) || 0,
      };
    } else {
      this._dragDim.mode = "distance";
      this._dragDim.start = { d: typeof off.d === "number" ? off.d : 0 };
    }
    try {
      e.target.setPointerCapture?.(e.pointerId);
    } catch { }
    e.preventDefault();
    e.stopPropagation();
    this.#setControlsLocked(true);
  }
  #moveDimDrag(e) {
    if (!this._dragDim.active) return;
    const uv = this.#pointerToPlaneUV(e);
    if (!uv) return;
    const c = this.#getConstraintById(this._dragDim.cid);
    if (!c) return;
    const s = this._solver.sketchObject;
    if (
      c.type === "⟺" &&
      c.displayStyle === "radius" &&
      (c.points || []).length >= 2
    ) {
      const pc = s.points.find((p) => p.id === c.points[0]);
      const pr = s.points.find((p) => p.id === c.points[1]);
      if (!pc || !pr) return;
      const rx = pr.x - pc.x,
        ry = pr.y - pc.y;
      const L = Math.hypot(rx, ry) || 1;
      const ux = rx / L,
        uy = ry / L;
      const nx = -uy,
        ny = ux;
      const du = uv.u - pr.x,
        dv = uv.v - pr.y;
      const dr = this._dragDim.start.dr + (du * ux + dv * uy);
      const dp = this._dragDim.start.dp + (du * nx + dv * ny);
      this._dimOffsets.set(this._dragDim.cid, { dr, dp });
    } else if (c.type === "⟺" && (c.points || []).length >= 2) {
      const p0 = s.points.find((p) => p.id === c.points[0]);
      const p1 = s.points.find((p) => p.id === c.points[1]);
      if (!p0 || !p1) return;
      const dx = p1.x - p0.x,
        dy = p1.y - p0.y;
      const L = Math.hypot(dx, dy) || 1;
      const nx = -(dy / L),
        ny = dx / L;
      const deltaN =
        (uv.u - this._dragDim.sx) * nx + (uv.v - this._dragDim.sy) * ny;
      const d = this._dragDim.start.d + deltaN;
      this._dimOffsets.set(this._dragDim.cid, { d });
    }
    this.#renderDimensions();
    e.preventDefault();
    e.stopPropagation();
  }
  #endDimDrag(e) {
    this._dragDim.active = false;
    this._dragDim.last = null;
    try {
      e.target.releasePointerCapture?.(e.pointerId);
    } catch { }
    e.preventDefault();
    e.stopPropagation();
    // Defer re-enabling and then tell controls an interaction ended
    setTimeout(() => {
      this.#setControlsLocked(false);
      this.#notifyControlsEnd(e);
    }, 30);
  }

  #notifyControlsEnd(e) {
    try {
      const el = this.viewer?.renderer?.domElement;
      const ctrls = this.viewer?.controls;
      if (!el) return;
      const opts = {
        bubbles: true,
        cancelable: true,
        pointerId: e?.pointerId || 1,
        button: e?.button ?? 0,
        buttons: 0,
        clientX: e?.clientX ?? 0,
        clientY: e?.clientY ?? 0,
        pointerType: e?.pointerType || "mouse",
      };
      try {
        el.dispatchEvent(new PointerEvent("pointerup", opts));
      } catch { }
      try {
        el.dispatchEvent(new MouseEvent("mouseup", opts));
      } catch { }
      try {
        ctrls?.dispatchEvent?.({ type: "end" });
      } catch { }
    } catch { }
  }
  #setControlsLocked(lock) {
    const c = this.viewer?.controls;
    if (!c) return;
    if (lock) {
      if (!this._controlsPrev) this._controlsPrev = { enabled: c.enabled };
      c.enabled = false;
    } else {
      if (this._controlsPrev) {
        c.enabled = this._controlsPrev.enabled;
        this._controlsPrev = null;
      }
    }
  }
  #svgAngle(p0, p1, p2, p3, cid, I) {
    if (!this._dimSVG) return;
    const svg = this._dimSVG;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const toWorld = (pt) =>
      new THREE.Vector3()
        .copy(this._lock.basis.origin)
        .addScaledVector(this._lock.basis.x, pt.x)
        .addScaledVector(this._lock.basis.y, pt.y);
    const A = toWorld(p0),
      B = toWorld(p1),
      C = toWorld(p2),
      D = toWorld(p3),
      O = toWorld(I);
    const a = A.clone().sub(B),
      c = C.clone().sub(D); // directions from vertex
    const r = a.length() * 0.15; // small radius scaled by first segment
    // Build plane basis projection to screen for arc approximation: sample in world and project
    const nSamples = 24;
    const pts = [];
    const v0 = a.clone().normalize();
    const v1 = c.clone().normalize();
    // angle between v0 and v1 around +Z of sketch plane
    // Build an orthonormal 2D basis on plane to parametrize arc
    const X = this._lock.basis.x.clone().normalize();
    const Y = this._lock.basis.y.clone().normalize();
    const toUV = (w) => ({ u: w.dot(X), v: w.dot(Y) });
    const fromUV = (u, v) =>
      new THREE.Vector3().copy(O).addScaledVector(X, u).addScaledVector(Y, v);
    const v0uv = toUV(B.clone().add(v0).sub(O)),
      v1uv = toUV(D.clone().add(v1).sub(O));
    let a0 = Math.atan2(v0uv.v, v0uv.u);
    let a1 = Math.atan2(v1uv.v, v1uv.u);
    let d = a1 - a0;
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    for (let i = 0; i <= nSamples; i++) {
      const t = a0 + d * (i / nSamples);
      const P = fromUV(Math.cos(t) * r, Math.sin(t) * r);
      const p = P.clone().project(this.viewer.camera);
      const x = (p.x * 0.5 + 0.5) * rect.width;
      const y = (-p.y * 0.5 + 0.5) * rect.height;
      pts.push([x, y]);
    }
    const mk = (name, attrs) => {
      const el = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (const k in attrs) el.setAttribute(k, String(attrs[k]));
      svg.appendChild(el);
      return el;
    };
    // Polyline arc
    mk("polyline", {
      points: pts.map((p) => p.join(",")).join(" "),
      fill: "none",
      stroke: "#69a8ff",
      "stroke-width": 2,
    });
    // small arrows at ends
    const drawArrow = (p, q) => {
      const vx = q[0] - p[0],
        vy = q[1] - p[1];
      const len = Math.hypot(vx, vy) || 1;
      const ux = vx / len,
        uy = vy / len;
      const px = -uy,
        py = ux;
      const ah = 6;
      const points = `${q[0]},${q[1]} ${q[0] - ux * ah + px * ah * 0.6},${q[1] - uy * ah + py * ah * 0.6} ${q[0] - ux * ah - px * ah * 0.6},${q[1] - uy * ah - py * ah * 0.6}`;
      mk("polygon", { points, fill: "#69a8ff" });
    };
    if (pts.length >= 2) {
      drawArrow(pts[1], pts[0]);
      drawArrow(pts[pts.length - 2], pts[pts.length - 1]);
    }
  }
}
