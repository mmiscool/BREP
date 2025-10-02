// SketchMode3D: In-scene sketch editing overlay (no camera locking).

import * as THREE from "three";
import ConstraintSolver from "../features/sketch/sketchSolver2D/ConstraintEngine.js";
import { updateListHighlights, applyHoverAndSelectionColors } from "./sketcher/highlights.js";
import { renderDimensions as dimsRender } from "./sketcher/dimensions.js";
import { AccordionWidget } from "./AccordionWidget.js";

export class SketchMode3D {
  constructor(viewer, featureID) {
    this.viewer = viewer;
    this.featureID = featureID;
    this._ui = null;
    this._saved = null; // (unused) legacy snapshot
    this._lock = null; // { basis:{x,y,z,origin} }
    // Editing state
    this._solver = null;
    this._sketchGroup = null;
    this._raycaster = new THREE.Raycaster();
    this._drag = { active: false, pointId: null };
    this._pendingDrag = { pointId: null, x: 0, y: 0, started: false };
    // Geometry dragging (move all points of a curve)
    this._dragGeo = { active: false, ids: [], startUV: { u: 0, v: 0 }, pointsStart: null };
    this._pendingGeo = { ids: null, x: 0, y: 0, startUV: null, started: false };
    // Track clicks on blank canvas area to clear selection on click (not drag)
    this._blankDown = { active: false, x: 0, y: 0 };
    this._selection = new Set();
    this._hover = null; // current hovered item {type,id}
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
    this._controlsPrev = null; // legacy controls state (unused)
    // Track SKETCH groups we hide while editing so we can restore visibility
    this._hiddenSketches = [];
    // No clipping plane; orientation must do the work
    // Reference object used for plane basis/orientation
    this._refObj = null;
  }

  open() {
    const v = this.viewer;
    if (!v) return;

    // Align camera to face/plane (look flat at the sketch reference)
    // while preserving current camera distance.

    // Find the sketch reference object
    const ph = v.partHistory;
    const feature = Array.isArray(ph?.features)
      ? ph.features.find((f) => f?.inputParams?.featureID === this.featureID)
      : null;
    const refName = feature?.inputParams?.sketchPlane || null;
    const refObj = refName ? ph.scene.getObjectByName(refName) : null;
    this._refObj = refObj || null;

    // Compute basis from reference (fallback to world XY), prefer persisted basis
    let basis = null;
    const saved = feature?.persistentData?.basis || null;
    const savedMatchesRef = saved && (saved.refName === refName);
    if (saved && savedMatchesRef) {
      basis = {
        x: new THREE.Vector3().fromArray(saved.x),
        y: new THREE.Vector3().fromArray(saved.y),
        z: new THREE.Vector3().fromArray(saved.z),
        origin: new THREE.Vector3().fromArray(saved.origin),
      };

      console.log("[SketchMode3D] Reusing saved basis for", refName);
    } else {
      basis = this.#basisFromReference(refObj);
      // Persist freshly computed basis tagged with refName so future edits reuse it
      try {
        if (feature) {
          feature.persistentData = feature.persistentData || {};
          feature.persistentData.basis = {
            origin: [basis.origin.x, basis.origin.y, basis.origin.z],
            x: [basis.x.x, basis.x.y, basis.x.z],
            y: [basis.y.x, basis.y.y, basis.y.z],
            z: [basis.z.x, basis.z.y, basis.z.z],
            refName: refName || undefined,
          };
        }
      } catch { }
    }

    // Basis used for projecting points to/from world; also align camera now
    const pivotBasis = basis.origin.clone();
    // Compute a better visual pivot: world-space center of the reference object (face/plane)
    let pivotLook = pivotBasis.clone();
    try {
      if (refObj) {
        refObj.updateWorldMatrix(true, true);
        // Prefer world-space bounding box center
        const box = new THREE.Box3().setFromObject(refObj);
        if (box && !box.isEmpty()) {
          pivotLook.copy(box.getCenter(new THREE.Vector3()));
        } else {
          // Fallback to bounding sphere center in local -> world
          const g = refObj.geometry;
          const bs = g && (g.boundingSphere || (g.computeBoundingSphere(), g.boundingSphere));
          if (bs) pivotLook.copy(refObj.localToWorld(bs.center.clone()));
          else pivotLook.copy(refObj.getWorldPosition(new THREE.Vector3()));
        }
      }
    } catch { }
    const currentDist = v.camera.position.distanceTo(pivotLook) * (-1); // read-only
    this._lock = { basis, distance: currentDist || 20 };

    // Reposition and orient camera to face the sketch plane head-on.
    try {
      const cam = v.camera;
      const dist = Math.max(0.01, this._lock.distance || 20);
      const z = basis.z.clone().normalize();
      const y = basis.y.clone().normalize();
      const pos = pivotLook.clone().add(z.multiplyScalar(dist));
      cam.position.copy(pos);
      cam.up.copy(y);
      cam.lookAt(pivotLook);
      cam.updateMatrixWorld(true);
      // Align Arcball target/pivot to the face center so first drag won't jump
      try { if (v.controls) v.controls.target.copy(pivotLook); } catch { }
      try { v.controls && v.controls._gizmos && v.controls._gizmos.position && v.controls._gizmos.position.copy(pivotLook); } catch { }
      // Sync internal control matrices and gizmo size/state
      try { v.controls && v.controls.update && v.controls.update(); } catch { }
      // Ensure gizmo matrices are current before snapshotting state (prevents first-pan jump)
      try { v.controls && v.controls._gizmos && v.controls._gizmos.updateMatrixWorld && v.controls._gizmos.updateMatrixWorld(true); } catch { }
      try { v.controls && v.controls.updateMatrixState && v.controls.updateMatrixState(); } catch { }
      try { v.render && v.render(); } catch { }
    } catch { }

    // Hide any existing SKETCH groups in the scene to avoid overlaying
    try {
      this._hiddenSketches = [];
      v.scene.traverse((obj) => {
        if (obj && obj.type === 'SKETCH') {
          const wasVisible = !!obj.visible;
          if (wasVisible) {
            this._hiddenSketches.push(obj);
            obj.visible = false;
          }
        }
      });
    } catch { }

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
    this._sketchGroup.renderOrder = 9999; // render last
    this._sketchGroup.name = `__SKETCH_EDIT__:${this.featureID}`;
    v.scene.add(this._sketchGroup);
    // Dimension 3D group
    this._dim3D = new THREE.Group();
    this._dim3D.renderOrder = 9998; // just before sketch group
    this._dim3D.name = `__SKETCH_DIMS__:${this.featureID}`;
    v.scene.add(this._dim3D);

    // No special camera layers needed
    this.#rebuildSketchGraphics();

    // Refresh external reference points to current model projection
    try { this.#refreshExternalPointsPositions(true); } catch { }

    // Removed debug vectors (camera ray + triangle normals)

    // Mount label overlay root and initial render
    this.#mountDimRoot();
    this.#renderDimensions();

    // Keep handles a constant screen size while zooming (no camera relock)
    const tick = () => {
      try {
        this.#updateHandleSizes();
      } catch { }
      // Removed debug vector updates
      // Light auto-refresh for external reference points (every ~300ms)
      try {
        const now = performance.now ? performance.now() : Date.now();
        this._lastExtRefresh = this._lastExtRefresh || 0;
        if (now - this._lastExtRefresh > 300) {
          this._lastExtRefresh = now;
          this.#refreshExternalPointsPositions(false);
        }
      } catch { }
      this._sizeRAF = requestAnimationFrame(tick);
    };
    this._sizeRAF = requestAnimationFrame(tick);

    // Pointer listeners for sketch interactions (no camera panning)
    const el = v.renderer.domElement;
    this._onMove = (e) => this.#onPointerMove(e);
    this._onDown = (e) => this.#onPointerDown(e);
    this._onUp = (e) => this.#onPointerUp(e);
    el.addEventListener("pointermove", this._onMove, { passive: false });
    // Use capture to prevent ArcballControls from starting spins on dimension/point/curve clicks
    el.addEventListener("pointerdown", this._onDown, { passive: false, capture: true });
    window.addEventListener("pointerup", this._onUp, {
      passive: false,
      capture: true,
    });
    // ESC key clears selection
    this._onKeyDown = (ev) => {
      const k = ev.key || ev.code || '';
      if (k === 'Escape' || k === 'Esc') {
        if (this._selection.size) {
          this._selection.clear();
          try { this.#refreshContextBar(); } catch { }
          try { this.#rebuildSketchGraphics(); } catch { }
          try { ev.preventDefault(); ev.stopPropagation(); } catch { }
        }
        return;
      }
      if (k === 'Delete' || k === 'Backspace') {
        // Remove selected items (constraints, geometries/curves, and points)
        const selection = Array.from(this._selection);
        const constraints = selection.filter(i => i.type === 'constraint');
        const geometries = selection.filter(i => i.type === 'geometry');
        const points = selection.filter(i => i.type === 'point');
        
        let deletedAny = false;
        
        if (this._solver) {
          // Remove constraints first
          if (constraints.length > 0) {
            try {
              for (const item of constraints) {
                this._solver.removeConstraintById?.(parseInt(item.id));
              }
              deletedAny = true;
            } catch { }
          }
          
          // Remove geometries/curves
          if (geometries.length > 0) {
            try {
              for (const item of geometries) {
                this._solver.removeGeometryById?.(parseInt(item.id));
              }
              deletedAny = true;
            } catch { }
          }
          
          // Remove points (but not point 0 which is the origin)
          if (points.length > 0) {
            try {
              for (const item of points) {
                const pointId = parseInt(item.id);
                if (pointId !== 0) {  // Protect the origin point
                  this._solver.removePointById?.(pointId);
                  deletedAny = true;
                }
              }
            } catch { }
          }
          
          // If anything was deleted, update the sketch
          if (deletedAny) {
            try { this._solver.solveSketch('full'); } catch { }
            this._selection.clear();
            this.#rebuildSketchGraphics();
            this.#refreshContextBar();
            try { ev.preventDefault(); ev.stopPropagation(); } catch { }
          }
        }
      }
    };
    window.addEventListener('keydown', this._onKeyDown, { passive: true });
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
    // No debug vectors to clean up
    // Do not restore or alter camera/controls
    // No clipping plane to restore
    // remove listeners
    const el = v?.renderer?.domElement;
    if (el) {
      try {
        el.removeEventListener("pointermove", this._onMove);
      } catch { }
      try {
        el.removeEventListener("pointerdown", this._onDown, { capture: true });
      } catch { }
    }
    try {
      window.removeEventListener("pointerup", this._onUp, true);
    } catch { }
    try { window.removeEventListener('keydown', this._onKeyDown); } catch { }
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

    // No camera layer changes to restore

    // Restore visibility of any SKETCH groups we hid on open
    try {
      if (Array.isArray(this._hiddenSketches)) {
        for (const obj of this._hiddenSketches) {
          if (obj && obj.type === 'SKETCH') obj.visible = true;
        }
      }
    } catch { }
    this._hiddenSketches = [];

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
    let consumed = false; // whether we handled the event and should block controls
    // Tool-based behavior
    if (this._tool !== "select" && e.button === 0) {
      // Pick Edges tool: click scene edges to add external refs
      if (this._tool === "pickEdges") {
        const hit = this.#hitTestSceneEdge(e);
        if (hit && hit.object?.type === 'EDGE') {
          this.#ensureExternalRefForEdge(hit.object);
          this.#persistExternalRefs();
          try { this._solver.solveSketch("full"); } catch { }
          this.#rebuildSketchGraphics();
          this.#refreshContextBar();
          this.#renderExternalRefsList();
        }
        try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
        consumed = true;
        return;
      }
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
            this.#rebuildSketchGraphics();
            this.#refreshLists();
            this.#refreshContextBar();
          }
        } else if (this._tool === "rect") {
          this.#toggleSelection({ type: "point", id: pid });
          if (
            Array.from(this._selection).filter((i) => i.type === "point")
              .length === 2
          ) {
            this._solver.geometryCreateRectangle();
            this._selection.clear();
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
            this.#rebuildSketchGraphics();
            this.#refreshLists();
            this.#refreshContextBar();
          }
        } else if (this._tool === "bezier") {
          // Cubic Bezier: end0, ctrl0, ctrl1, end1 (4 points)
          this._bezierSel = this._bezierSel || [];
          this._bezierSel.push(pid);
          this.#toggleSelection({ type: "point", id: pid });
          if (this._bezierSel.length === 4) {
            const [p0, p1, p2, p3] = this._bezierSel;
            // Create the curve
            this._solver.createGeometry("bezier", [p0, p1, p2, p3]);
            // Also create construction guide lines so they can be constrained
            try {
              const sObj = this._solver.sketchObject;
              const maxIdBefore = Math.max(0, ...sObj.geometries.map(g => +g.id || 0));
              // end0 -> ctrl0
              this._solver.createGeometry("line", [p0, p1]);
              const gid1 = Math.max(0, ...sObj.geometries.map(g => +g.id || 0));
              const g1 = sObj.geometries.find(g => g.id === gid1);
              if (g1) g1.construction = true;
              // end1 -> ctrl1
              this._solver.createGeometry("line", [p3, p2]);
              const gid2 = Math.max(0, ...sObj.geometries.map(g => +g.id || 0));
              const g2 = sObj.geometries.find(g => g.id === gid2);
              if (g2) g2.construction = true;
            } catch { }
            this._bezierSel = null;
            this._selection.clear();
            this.#rebuildSketchGraphics();
            this.#refreshLists();
            this.#refreshContextBar();
          }
        }
      }
      if (e.button === 0) {
        try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
        consumed = true;
      }
      return;
    }

    // Select tool: if clicking a point, arm a pending drag; else try dim/geometry; else pan
    const hit = this.#hitTestPoint(e);
    if (hit != null) {
      // Disable camera controls immediately when pressing on a sketch point
      if (e.button === 0) {
        try { if (this.viewer?.controls) this.viewer.controls.enabled = false; } catch { }
      }
      // Prevent dragging of external reference points; allow selection only
      try {
        const f = this.#getSketchFeature();
        const isExternal = (f?.persistentData?.externalRefs || []).some((r) => r.p0 === hit || r.p1 === hit);
        if (isExternal) {
          if (e.button === 0) {
            this.#toggleSelection({ type: "point", id: hit });
            this.#refreshContextBar();
            this.#rebuildSketchGraphics();
            try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
          }
          consumed = true;
          return;
        }
      } catch { }
      // Prevent dragging of fixed sketch points
      try {
        const p = this._solver?.getPointById?.(hit);
        if (p && p.fixed) {
          if (e.button === 0) {
            this.#toggleSelection({ type: "point", id: hit });
            this.#refreshContextBar();
            this.#rebuildSketchGraphics();
            try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
          }
          consumed = true;
          return;
        }
      } catch { }
      this._pendingDrag.pointId = hit;
      this._pendingDrag.x = e.clientX;
      this._pendingDrag.y = e.clientY;
      this._pendingDrag.started = false;
      consumed = true; // we are arming a drag → suppress controls
    } else {
      // Prefer selecting sketch geometry over constraints when clicking the canvas
      const ghit = this.#hitTestGeometry(e);
      if (ghit && e.button === 0) {
        // Arm a pending geometry drag (translate its points together)
        try {
          const s = this._solver?.sketchObject;
          const geo = (s?.geometries || []).find(g => g.id === parseInt(ghit.id));
          const idsRaw = Array.isArray(geo?.points) ? geo.points.slice() : [];
          const ids = Array.from(new Set(idsRaw.map(x => parseInt(x))));
          // Filter out external reference or fixed points (not draggable)
          const f = this.#getSketchFeature();
          const ext = (f?.persistentData?.externalRefs || []);
          const isExternal = (pid) => ext.some(r => r.p0 === pid || r.p1 === pid);
          const movable = ids.filter(pid => {
            const p = this._solver?.getPointById?.(pid);
            return p && !p.fixed && !isExternal(pid);
          });
          const uv = this.#pointerToPlaneUV(e);
          this._pendingGeo = { ids: movable, x: e.clientX, y: e.clientY, startUV: uv, started: false, geometryId: ghit.id };
        } catch { this._pendingGeo = { ids: null, x: 0, y: 0, startUV: null, started: false, geometryId: null }; }
        consumed = true;
        return;
      }
      // Then try dimension leaders/graphics selection in canvas
      const dhit = this.#hitTestDim(e);
      if (dhit && e.button === 0) {
        try { this.toggleSelectConstraint?.(dhit.cid); } catch { }
        // Re-render dimension styling to reflect selection state
        try { this.#renderDimensions(); } catch { }
        try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
        consumed = true;
        return;
      }
      // Finally, constraint glyph selection (non-dimension symbols)
      const ghit2 = this.#hitTestGlyph(e);
      if (ghit2 && e.button === 0) {
        try { this.toggleSelectConstraint?.(ghit2.cid); } catch { }
        try { this.#renderDimensions(); } catch { }
        try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
        consumed = true;
        return;
      } else {
        // Clicked empty space: do not consume so ArcballControls can spin the model.
        // Arm a blank click so on pointerup we can clear selection if it wasn't a drag.
        if (e.button === 0) {
          this._blankDown.active = true;
          this._blankDown.x = e.clientX;
          this._blankDown.y = e.clientY;
        }
      }
    }
    if (consumed && e.button === 0) {
      try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
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
        // Disable camera controls while dragging sketch points
        try { if (this.viewer?.controls) this.viewer.controls.enabled = false; } catch { }
        try { e.target.setPointerCapture?.(e.pointerId); } catch { }
      }
    }

    // Promote pending geometry drag
    if (!this._dragGeo.active && this._pendingGeo?.ids && Array.isArray(this._pendingGeo.ids)) {
      const d = Math.hypot((e.clientX - (this._pendingGeo.x || 0)), (e.clientY - (this._pendingGeo.y || 0)));
      if (d >= threshold && this._pendingGeo.ids.length > 0) {
        this._dragGeo.active = true;
        this._dragGeo.ids = this._pendingGeo.ids.slice();
        this._dragGeo.startUV = this._pendingGeo.startUV || this.#pointerToPlaneUV(e) || { u: 0, v: 0 };
        // Capture starting positions of all points
        this._dragGeo.pointsStart = new Map();
        try {
          for (const pid of this._dragGeo.ids) {
            const p = this._solver?.getPointById?.(pid);
            if (p) this._dragGeo.pointsStart.set(pid, { x: p.x, y: p.y });
          }
        } catch { }
        this._pendingGeo.started = true;
        try { if (this.viewer?.controls) this.viewer.controls.enabled = false; } catch { }
        try { e.target.setPointerCapture?.(e.pointerId); } catch { }
      }
    }

    if (this._drag.active) {
      const uv = this.#pointerToPlaneUV(e);
      if (!uv) return;
      const p = this._solver?.getPointById(this._drag.pointId);
      if (p) {
        if (p.fixed) {
          // Do not move fixed points
          try { e.preventDefault(); e.stopPropagation(); } catch { }
          this._drag.active = false;
          this._drag.pointId = null;
          return;
        }
        p.x = uv.u;
        p.y = uv.v;
        this._solver.solveSketch("full");
        this.#rebuildSketchGraphics();
      }
      try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
      return;
    }
    if (this._dragGeo.active) {
      const uv = this.#pointerToPlaneUV(e);
      if (uv) {
        const du = uv.u - (this._dragGeo.startUV?.u || 0);
        const dv = uv.v - (this._dragGeo.startUV?.v || 0);
        try {
          for (const pid of this._dragGeo.ids || []) {
            const p = this._solver?.getPointById?.(pid);
            const st = this._dragGeo.pointsStart?.get?.(pid);
            if (p && st) { p.x = st.x + du; p.y = st.y + dv; }
          }
        } catch { }
        try { this._solver.solveSketch("full"); } catch { }
        this.#rebuildSketchGraphics();
      }
      try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
      return;
    }
    if (this._dragDim?.active) {
      this.#moveDimDrag(e);
      try { e.preventDefault(); e.stopImmediatePropagation?.(); e.stopPropagation(); } catch { }
      return;
    }
    // Passive hover highlighting
    {
      // Edge picking cursor hint
      if (this._tool === 'pickEdges') {
        const h = this.#hitTestSceneEdge(e);
        try { this.viewer.renderer.domElement.style.cursor = h ? 'crosshair' : ''; } catch { }
      }
      const pid = this.#hitTestPoint(e);
      if (pid != null) this.#setHover({ type: "point", id: pid });
      else {
        const gh = this.#hitTestGeometry(e);
        if (gh) this.#setHover({ type: "geometry", id: gh.id });
        else {
          const dh = this.#hitTestDim(e) || this.#hitTestGlyph(e);
          if (dh && dh.cid != null) this.#setHover({ type: 'constraint', id: dh.cid });
          else this.#setHover(null);
        }
      }
    }

    // No manual camera panning or position changes
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
    // If geometry pending but not dragged, toggle its selection
    if (!this._dragGeo.active && this._pendingGeo?.ids && this._pendingGeo.started === false) {
      const gid = this._pendingGeo.geometryId != null ? parseInt(this._pendingGeo.geometryId) : null;
      if (gid != null) {
        this.#toggleSelection({ type: "geometry", id: gid });
        this.#refreshContextBar();
        this.#rebuildSketchGraphics();
      }
    }
    // If pressed on blank space and didn't drag, clear selection
    if (this._blankDown?.active) {
      const threshold = (this.viewer && typeof this.viewer._dragThreshold === 'number') ? this.viewer._dragThreshold : 5;
      const dx = (e.clientX || 0) - (this._blankDown.x || 0);
      const dy = (e.clientY || 0) - (this._blankDown.y || 0);
      const moved = Math.abs(dx) + Math.abs(dy) > threshold;
      if (!this._drag.active && !this._pendingDrag.started && !this._dragDim?.active && !moved) {
        if (this._selection.size) {
          this._selection.clear();
          this.#refreshContextBar();
          this.#rebuildSketchGraphics();
        }
      }
      this._blankDown.active = false;
    }
    // End any dimension drag
    try {
      if (this._dragDim?.active) this.#endDimDrag(e);
    } catch { }
    // End any geometry drag
    if (this._dragGeo.active) {
      this._dragGeo.active = false;
      this._dragGeo.ids = [];
      this._dragGeo.pointsStart = null;
      try { if (this.viewer?.controls) this.viewer.controls.enabled = true; } catch { }
    }
    // Re-enable camera controls after any sketch drag
    try { if (this.viewer?.controls) this.viewer.controls.enabled = true; } catch { }
    try { this.#notifyControlsEnd(e); } catch { }
    this._drag.active = false;
    this._drag.pointId = null;
    this._pendingDrag.pointId = null;
    this._pendingDrag.started = false;
    this._pendingGeo = { ids: null, x: 0, y: 0, startUV: null, started: false, geometryId: null };
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
    this.#setRayFromCamera(ndc);
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

  // Helper: set ray from camera and shift origin far behind camera along ray direction
  #setRayFromCamera(ndc) {
    const v = this.viewer;
    this._raycaster.setFromCamera(ndc, v.camera);
    try {
      const ray = this._raycaster.ray;
      // Use a large offset relative to camera frustum, fallback to fixed large number
      const span = Math.abs((v.camera?.far ?? 0) - (v.camera?.near ?? 0)) || 1;
      const back = Math.max(1e6, span * 10);
      ray.origin.addScaledVector(ray.direction, -back);
    } catch { /* noop */ }
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
      // Raw normal from face triangles (may be inward)
      let n = obj.getAverageNormal();
      const rawN = n.clone();
      // origin ~ face centroid if available (used for outward test)
      try {
        const g = obj.geometry;
        const bs = g.boundingSphere || (g.computeBoundingSphere(), g.boundingSphere);
        if (bs) origin.copy(obj.localToWorld(bs.center.clone()));
        else origin.copy(obj.getWorldPosition(new THREE.Vector3()));
      } catch { origin.copy(obj.getWorldPosition(new THREE.Vector3())); }

      // Determine solid center if possible
      let solidCenter = null;
      try {
        let solid = obj.parent;
        while (solid && solid.type !== 'SOLID') solid = solid.parent;
        if (solid) {
          const box = new THREE.Box3().setFromObject(solid);
          if (!box.isEmpty()) solidCenter = box.getCenter(new THREE.Vector3());
        }
      } catch { }

      // If we know a center, align normal to point from center -> face (outward)
      let flipped = false;
      if (solidCenter) {
        const toFace = origin.clone().sub(solidCenter).normalize();
        if (toFace.lengthSq() > 0 && n.dot(toFace) < 0) { n.multiplyScalar(-1); flipped = true; }
      }

      const worldUp = new THREE.Vector3(0, 1, 0);
      const tmp = new THREE.Vector3();
      const zx = Math.abs(n.dot(worldUp)) > 0.9 ? new THREE.Vector3(1, 0, 0) : worldUp; // pick a non-parallel ref
      x.copy(tmp.crossVectors(zx, n).normalize());
      y.copy(tmp.crossVectors(n, x).normalize());
      z.copy(n.clone().normalize());
      return { x, y, z, origin, rawNormal: rawN, flippedByCenter: flipped, solidCenter };
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
    return { x, y, z, origin, rawNormal: n.clone() };
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
    wrap.style.zIndex = "6";
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
      this._secExternal = await acc.addSection("External References");
      this.#mountExternalRefsUI();
      this.#refreshLists();
    })();
  }

  // Build UI for External References section
  #mountExternalRefsUI() {
    const sec = this._secExternal;
    if (!sec) return;
    const wrap = sec.uiElement;
    wrap.innerHTML = "";
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "6px";
    row.style.margin = "4px 0";

    const addBtn = document.createElement("button");
    addBtn.textContent = "Add Selected Edges";
    addBtn.style.flex = "1";
    addBtn.style.background = "transparent";
    addBtn.style.color = "#ddd";
    addBtn.style.border = "1px solid #364053";
    addBtn.style.borderRadius = "6px";
    addBtn.style.padding = "4px 8px";
    addBtn.onclick = () => this.#addExternalReferencesFromSelection();
    row.appendChild(addBtn);

    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "Refresh";
    refreshBtn.style.background = "transparent";
    refreshBtn.style.color = "#ddd";
    refreshBtn.style.border = "1px solid #364053";
    refreshBtn.style.borderRadius = "6px";
    refreshBtn.style.padding = "4px 8px";
    refreshBtn.onclick = () => this.#refreshExternalPointsPositions(true);
    row.appendChild(refreshBtn);

    wrap.appendChild(row);

    const list = document.createElement("div");
    list.className = "ext-ref-list";
    wrap.appendChild(list);
    this._extRefListEl = list;

    this.#renderExternalRefsList();
  }

  // Helper: get current Sketch feature object
  #getSketchFeature() {
    try {
      const ph = this.viewer?.partHistory;
      const f = Array.isArray(ph?.features)
        ? ph.features.find((x) => x?.inputParams?.featureID === this.featureID)
        : null;
      return f || null;
    } catch {
      return null;
    }
  }

  // Helper: compute world endpoints for a BREP Edge object
  #edgeEndpointsWorld(edge) {
    if (!edge) return null;
    const toWorld = (v) => v.applyMatrix4(edge.matrixWorld);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const pts = Array.isArray(edge?.userData?.polylineLocal)
      ? edge.userData.polylineLocal
      : null;
    if (pts && pts.length >= 2) {
      a.set(pts[0][0], pts[0][1], pts[0][2]);
      b.set(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[pts.length - 1][2]);
      return { a: toWorld(a), b: toWorld(b) };
    }
    // Try fat-line geometry (Line2/LineSegments2) endpoints
    const aStart = edge?.geometry?.attributes?.instanceStart;
    const aEnd = edge?.geometry?.attributes?.instanceEnd;
    if (aStart && aEnd && aStart.count >= 1) {
      a.set(aStart.getX(0), aStart.getY(0), aStart.getZ(0));
      b.set(aEnd.getX(0), aEnd.getY(0), aEnd.getZ(0));
      return { a: toWorld(a), b: toWorld(b) };
    }
    const pos = edge?.geometry?.getAttribute?.("position");
    if (pos && pos.itemSize === 3 && pos.count >= 2) {
      a.set(pos.getX(0), pos.getY(0), pos.getZ(0));
      b.set(pos.getX(pos.count - 1), pos.getY(pos.count - 1), pos.getZ(pos.count - 1));
      return { a: toWorld(a), b: toWorld(b) };
    }
    return null;
  }

  // Helper: project world point to current sketch UV
  #projectWorldToUV(world) {
    if (!this._lock?.basis) return { u: 0, v: 0 };
    const o = this._lock.basis.origin;
    const bx = this._lock.basis.x;
    const by = this._lock.basis.y;
    const d = world.clone().sub(o);
    return { u: d.dot(bx), v: d.dot(by) };
  }

  // Ensure external refs exist for currently selected edges
  #addExternalReferencesFromSelection() {
    try {
      const scene = this.viewer?.partHistory?.scene;
      if (!scene || !this._solver) return;
      const edges = [];
      scene.traverse((obj) => { if (obj?.type === 'EDGE' && obj.selected) edges.push(obj); });
      if (!edges.length) return;
      for (const e of edges) this.#ensureExternalRefForEdge(e);
      this.#persistExternalRefs();
      this._solver.solveSketch("full");
      this.#rebuildSketchGraphics();
      this.#refreshContextBar();
      this.#renderExternalRefsList();
    } catch { }
  }

  // Create mapping + points for edge if not present; else update positions
  #ensureExternalRefForEdge(edge) {
    const f = this.#getSketchFeature();
    if (!f || !this._solver || !edge) return;
    f.persistentData = f.persistentData || {};
    f.persistentData.externalRefs = Array.isArray(f.persistentData.externalRefs)
      ? f.persistentData.externalRefs
      : [];
    const refs = f.persistentData.externalRefs;
    let ref = refs.find((r) => r && (r.edgeId === edge.id || (r.edgeName && r.edgeName === edge.name)));
    const s = this._solver.sketchObject;
    const ends = this.#edgeEndpointsWorld(edge);
    if (!ends) return;
    const uvA = this.#projectWorldToUV(ends.a);
    const uvB = this.#projectWorldToUV(ends.b);

    const nextPointId = () => Math.max(0, ...s.points.map((p) => +p.id || 0)) + 1;

    if (!ref) {
      // Generate two unique point IDs for the edge endpoints.
      // Note: calling nextPointId() twice without pushing in between would return the same value.
      const id0 = nextPointId();
      const id1 = id0 + 1;
      const p0 = { id: id0, x: uvA.u, y: uvA.v, fixed: true };
      const p1 = { id: id1, x: uvB.u, y: uvB.v, fixed: true };
      s.points.push(p0, p1);
      const pushGround = (pid) => {
        const exists = s.constraints.some((c) => c.type === '⏚' && Array.isArray(c.points) && c.points[0] === pid);
        if (!exists) {
          const cid = Math.max(0, ...s.constraints.map((c) => +c.id || 0)) + 1;
          s.constraints.push({ id: cid, type: '⏚', points: [pid] });
        }
      };
      pushGround(p0.id);
      pushGround(p1.id);
      ref = { edgeId: edge.id, edgeName: edge.name || null, solidName: edge.parent?.name || null, p0: p0.id, p1: p1.id };
      refs.push(ref);
    } else {
      // Ensure referenced points exist and are distinct; repair legacy refs if needed
      let pt0 = s.points.find((p) => p.id === ref.p0);
      let pt1 = s.points.find((p) => p.id === ref.p1);
      if (!pt0) {
        const nid = nextPointId();
        pt0 = { id: nid, x: uvA.u, y: uvA.v, fixed: true };
        s.points.push(pt0);
        ref.p0 = nid;
      }
      if (!pt1 || ref.p1 === ref.p0) {
        const nid = Math.max(nextPointId(), pt0.id + 1);
        pt1 = { id: nid, x: uvB.u, y: uvB.v, fixed: true };
        s.points.push(pt1);
        ref.p1 = nid;
      }
      // Ensure stored name metadata stays fresh
      try { ref.edgeName = edge.name || ref.edgeName || null; } catch { }
      try { ref.solidName = edge.parent?.name || ref.solidName || null; } catch { }
      if (pt0) { pt0.x = uvA.u; pt0.y = uvA.v; pt0.fixed = true; }
      if (pt1) { pt1.x = uvB.u; pt1.y = uvB.v; pt1.fixed = true; }
      const ensureGround = (pid) => {
        const exists = s.constraints.some((c) => c.type === '⏚' && Array.isArray(c.points) && c.points[0] === pid);
        if (!exists) {
          const cid = Math.max(0, ...s.constraints.map((c) => +c.id || 0)) + 1;
          s.constraints.push({ id: cid, type: '⏚', points: [pid] });
        }
      };
      if (pt0) ensureGround(pt0.id);
      if (pt1) ensureGround(pt1.id);
    }
  }

  // Refresh positions for all existing external refs; optionally solve
  #refreshExternalPointsPositions(runSolve) {
    const f = this.#getSketchFeature();
    if (!f || !Array.isArray(f?.persistentData?.externalRefs) || !this._solver) return;
    const scene = this.viewer?.partHistory?.scene;
    const s = this._solver.sketchObject;
    let changed = false;
    for (const ref of f.persistentData.externalRefs) {
      try {
        let edge = scene.getObjectById(ref.edgeId);
        if (!edge || edge.type !== 'EDGE') {
          // Fallback by name within solid, then global
          if (ref.solidName) {
            const solid = this.viewer?.partHistory?.scene?.getObjectByName(ref.solidName);
            if (solid) {
              let found = null;
              solid.traverse((obj) => { if (!found && obj.type === 'EDGE' && obj.name === ref.edgeName) found = obj; });
              if (found) edge = found;
            }
          }
          if ((!edge || edge.type !== 'EDGE') && ref.edgeName) {
            let found = null;
            this.viewer?.partHistory?.scene?.traverse((obj) => { if (!found && obj.type === 'EDGE' && obj.name === ref.edgeName) found = obj; });
            if (found) edge = found;
          }
          if (edge && edge.type === 'EDGE') {
            // refresh stored id/name metadata
            ref.edgeId = edge.id;
            ref.edgeName = edge.name || ref.edgeName || null;
            ref.solidName = edge.parent?.name || ref.solidName || null;
          }
        }
        if (!edge || edge.type !== 'EDGE') continue;
        const ends = this.#edgeEndpointsWorld(edge);
        if (!ends) continue;
        const uvA = this.#projectWorldToUV(ends.a);
        const uvB = this.#projectWorldToUV(ends.b);
        let pt0 = s.points.find((p) => p.id === ref.p0);
        let pt1 = s.points.find((p) => p.id === ref.p1);
        // Repair legacy refs with missing/duplicate endpoint IDs
        if (!pt0) {
          const nid = Math.max(0, ...s.points.map((p) => +p.id || 0)) + 1;
          pt0 = { id: nid, x: uvA.u, y: uvA.v, fixed: true };
          s.points.push(pt0);
          ref.p0 = nid;
          changed = true;
        }
        if (!pt1 || ref.p1 === ref.p0) {
          const nid = Math.max(0, ...s.points.map((p) => +p.id || 0)) + 1;
          // Ensure pt1 ID is distinct from pt0
          const id1 = (nid === pt0.id) ? nid + 1 : nid;
          pt1 = { id: id1, x: uvB.u, y: uvB.v, fixed: true };
          s.points.push(pt1);
          ref.p1 = id1;
          changed = true;
        }
        if (pt0 && (pt0.x !== uvA.u || pt0.y !== uvA.v)) { pt0.x = uvA.u; pt0.y = uvA.v; pt0.fixed = true; changed = true; }
        if (pt1 && (pt1.x !== uvB.u || pt1.y !== uvB.v)) { pt1.x = uvB.u; pt1.y = uvB.v; pt1.fixed = true; changed = true; }
        const ensureGround = (pid) => {
          const exists = s.constraints.some((c) => c.type === '⏚' && Array.isArray(c.points) && c.points[0] === pid);
          if (!exists) {
            const cid = Math.max(0, ...s.constraints.map((c) => +c.id || 0)) + 1;
            s.constraints.push({ id: cid, type: '⏚', points: [pid] });
            changed = true;
          }
        };
        if (pt0) ensureGround(pt0.id);
        if (pt1) ensureGround(pt1.id);
      } catch { }
    }
    if (changed || runSolve) {
      try { this._solver.solveSketch("full"); } catch { }
      this.#rebuildSketchGraphics();
      this.#refreshContextBar();
      this.#renderExternalRefsList();
      this.#persistExternalRefs();
    }
  }

  // Persist refs (already on feature object)
  #persistExternalRefs() {
    const f = this.#getSketchFeature();
    if (!f) return;
    try { f.persistentData = f.persistentData || {}; } catch { }
  }

  // Render the list of external references
  #renderExternalRefsList() {
    const list = this._extRefListEl;
    if (!list) return;
    const f = this.#getSketchFeature();
    const s = this._solver?.sketchObject;
    const refs = (f?.persistentData?.externalRefs) || [];
    const row = (label, act, del) => `
      <div class="sk-row" style="display:flex;align-items:center;gap:6px;margin:2px 0">
        <button data-ext-act="${act}" style="flex:1;text-align:left;background:transparent;color:#ddd;border:1px solid #364053;border-radius:4px;padding:3px 6px">${label}</button>
        <button data-ext-del="${del}" title="Unlink" style="color:#ffcf8b;background:transparent;border:1px solid #5b4a2b;border-radius:4px;padding:3px 6px">Unlink</button>
      </div>`;
    list.innerHTML = refs
      .map((r) => {
        const p0 = s?.points?.find((p) => p.id === r.p0);
        const p1 = s?.points?.find((p) => p.id === r.p1);
        const p0s = p0 ? `P${p0.id} (${p0.x.toFixed(2)}, ${p0.y.toFixed(2)})` : "?";
        const p1s = p1 ? `P${p1.id} (${p1.x.toFixed(2)}, ${p1.y.toFixed(2)})` : "?";
        return row(`Edge #${r.edgeId} → ${p0s}, ${p1s}`, `e:${r.edgeId}`, `e:${r.edgeId}`);
      })
      .join("");

    list.onclick = (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      const del = t.getAttribute("data-ext-del");
      if (del) {
        const [_k, idStr] = del.split(":");
        const edgeId = parseInt(idStr);
        const f2 = this.#getSketchFeature();
        if (!f2) return;
        const arr = Array.isArray(f2?.persistentData?.externalRefs)
          ? f2.persistentData.externalRefs
          : [];
        const idx = arr.findIndex((r) => r.edgeId === edgeId);
        if (idx >= 0) {
          const r = arr[idx];
          arr.splice(idx, 1);
          try {
            const sObj = this._solver?.sketchObject;
            if (sObj) {
              sObj.constraints = sObj.constraints.filter((c) => !(c.type === '⏚' && Array.isArray(c.points) && (c.points[0] === r.p0 || c.points[0] === r.p1)));
            }
          } catch { }
          this.#persistExternalRefs();
          this._solver?.solveSketch("full");
          this.#rebuildSketchGraphics();
          this.#refreshContextBar();
          this.#renderExternalRefsList();
        }
        return;
      }
      const act = t.getAttribute("data-ext-act");
      if (act) {
        const [_k, idStr] = act.split(":");
        const edgeId = parseInt(idStr);
        const f2 = this.#getSketchFeature();
        const r = (f2?.persistentData?.externalRefs || []).find((x) => x.edgeId === edgeId);
        if (r) {
          this._selection.clear();
          if (this._solver?.getPointById(r.p0)) this._selection.add({ type: 'point', id: r.p0 });
          if (this._solver?.getPointById(r.p1)) this._selection.add({ type: 'point', id: r.p1 });
          this.#refreshContextBar();
          this.#rebuildSketchGraphics();
        }
      }
    };
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
    bar.style.zIndex = "5";
    bar.style.userSelect = "none";
    // Track buttons to reflect active tool
    this._toolButtons = this._toolButtons || new Map();

    const mk = (label, tool) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.color = "#ddd";
      b.style.background = "transparent";
      b.style.border = "1px solid #364053";
      b.style.borderRadius = "6px";
      b.style.padding = "4px 8px";
      b.setAttribute("data-tool", tool);
      b.onclick = () => { this.#setTool(tool); };
      this._toolButtons.set(tool, b);
      return b;
    };
    bar.appendChild(mk("Select", "select"));
    bar.appendChild(mk("Line", "line"));
    bar.appendChild(mk("Rectangle", "rect"));
    bar.appendChild(mk("Circle", "circle"));
    bar.appendChild(mk("Arc", "arc"));
    bar.appendChild(mk("Bezier", "bezier"));
    bar.appendChild(mk("Link external edge", "pickEdges"));
    this._topbar = bar;
    host.appendChild(bar);

    this.#refreshTopToolbarActive();
  }

  #setTool(tool) {
    this._tool = tool;
    // Clear any pending creation state when switching tools
    try { this._arcSel = null; } catch { }
    try { this._bezierSel = null; } catch { }
    this.#refreshTopToolbarActive();
  }

  #refreshTopToolbarActive() {
    if (!this._toolButtons) return;
    for (const [tool, btn] of this._toolButtons.entries()) {
      const active = (tool === this._tool);
      btn.style.background = active ? "linear-gradient(180deg, rgba(110,168,254,.25), rgba(110,168,254,.15))" : "transparent";
      btn.style.borderColor = active ? "#6ea8fe" : "#364053";
      btn.style.color = active ? "#e9f0ff" : "#ddd";
      btn.style.boxShadow = active ? "0 0 0 1px rgba(110,168,254,.2) inset" : "none";
    }
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
        try { updateListHighlights(this); } catch { }
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

    // Hover sync from list to 3D
    this._acc.uiElement.onmousemove = (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      const act = t.getAttribute("data-act");
      if (!act) return this.#setHover(null);
      const [k, id] = act.split(":");
      if (k === "p") this.#setHover({ type: "point", id: parseInt(id) });
      else if (k === "g") this.#setHover({ type: "geometry", id: parseInt(id) });
      else if (k === "c") this.#setHover({ type: "constraint", id: parseInt(id) });
    };
    this._acc.uiElement.onmouseleave = () => this.#setHover(null);

    // Immediately style with selection/hover states
    try { updateListHighlights(this); } catch { }
  }

  #updateListHighlights() { try { updateListHighlights(this); } catch { } }
  #applyHoverAndSelectionColors() { try { applyHoverAndSelectionColors(this); } catch { } }

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

    // Construction toggle for selected geometry
    if (geos.length > 0) {
      const allCons = geos.every((g) => !!g.construction);
      const btn = document.createElement("button");
      btn.textContent = allCons ? "Make Regular" : "Make Construction";
      btn.title = "Toggle construction on selected curves";
      btn.style.color = "#ddd";
      btn.style.background = "transparent";
      btn.style.border = "1px solid #364053";
      btn.style.borderRadius = "6px";
      btn.style.padding = "4px 8px";
      btn.onclick = () => {
        try { this._solver.toggleConstruction(); } catch { }
        try { this._solver.solveSketch("full"); } catch { }
        this.#rebuildSketchGraphics();
        this.#refreshLists();
        this.#refreshContextBar();
      };
      this._ctxBar.appendChild(btn);
    }

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

    // Geometry x Geometry (2 lines) → Parallel / Perp / Angle / Equal Length
    const twoLines = geos.length === 2 && geos.every((g) => g?.type === "line");
    if (twoLines) {
      this._ctxBar.appendChild(mk("Parallel ∥", "∥"));
      this._ctxBar.appendChild(mk("Perpendicular ⟂", "⟂"));
      this._ctxBar.appendChild(mk("Angle ∠", "∠"));
      this._ctxBar.appendChild(mk("Equal Distance ⇌", "⇌"));
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

    // Geometry x Geometry (2 arcs/circles) → Equal Radius
    const twoRadial = geos.length === 2 && geos.every((g) => g && (g.type === "arc" || g.type === "circle"));
    if (twoRadial) {
      // Equal distance between center→rim pairs implies equal radii
      this._ctxBar.appendChild(mk("Equal Distance ⇌", "⇌"));
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

    // Geometry x Geometry (line + arc/circle) → Tangent
    const lineAndRadial = geos.length === 2 && 
      ((geos[0]?.type === "line" && (geos[1]?.type === "arc" || geos[1]?.type === "circle")) ||
       (geos[1]?.type === "line" && (geos[0]?.type === "arc" || geos[0]?.type === "circle")));
    if (lineAndRadial) {
      this._ctxBar.appendChild(mk("Tangent ⟠", "⟠"));
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
      this._ctxBar.appendChild(mk("Colinear ⏛", "⋯"));
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
    try { updateListHighlights(this); } catch { }
    try { applyHoverAndSelectionColors(this); } catch { }
    // Keep dimension visuals in sync with constraint selection state
    try { this.#renderDimensions(); } catch { }
    // Ensure the corresponding list section is visible and the row is in view
    try { this.revealListForItem?.(item.type, item.id); } catch { }
  }

  #setHover(item) {
    const prev = this._hover ? this._hover.type + ":" + this._hover.id : null;
    const next = item ? item.type + ":" + item.id : null;
    if (prev === next) return;
    this._hover = item;
    try { updateListHighlights(this); } catch { }
    try { applyHoverAndSelectionColors(this); } catch { }
    // Auto-expand and reveal hovered item in the list
    if (item && item.type && (item.id != null)) {
      try { this.revealListForItem?.(item.type, item.id); } catch { }
    }
  }

  // Public: allow external UI (e.g., dim labels) to set hover on constraints
  hoverConstraintFromLabel(cid) {
    this.#setHover({ type: 'constraint', id: cid });
    try { this.revealListForItem?.('constraint', cid); } catch { }
  }
  clearHoverFromLabel(_cid) {
    // Only clear if we're not dragging a dimension
    if (this._dragDim?.active) return;
    this.#setHover(null);
  }

  // Public: toggle select a constraint from label click
  toggleSelectConstraint(cid) {
    this.#toggleSelection({ type: 'constraint', id: cid });
    this.#refreshContextBar();
    this.#rebuildSketchGraphics();
  }

  // Ensure the relevant accordion section is expanded and the row scrolled into view
  async revealListForItem(kind, id) {
    try {
      const acc = this._acc; if (!acc) return;
      const title = kind === 'point' ? 'Points' : (kind === 'geometry' ? 'Curves' : (kind === 'constraint' ? 'Constraints' : null));
      if (!title) return;
      // Expand the section
      try { await acc.expandSection(title); } catch { }
      // Find and scroll the row into view
      const root = acc.uiElement; if (!root) return;
      const key = (kind === 'point') ? `p:${id}` : (kind === 'geometry') ? `g:${id}` : `c:${id}`;
      const btn = root.querySelector(`[data-act="${key}"]`);
      const row = btn && btn.closest ? btn.closest('.sk-row') : null;
      if (row && typeof row.scrollIntoView === 'function') {
        try { row.scrollIntoView({ block: 'nearest' }); } catch { row.scrollIntoView(); }
      }
    } catch { /* noop */ }
  }

  #hitTestPoint(e) {
    if (!this._sketchGroup || !this._solver) return null;
    const v = this.viewer;
    const uv = this.#pointerToPlaneUV(e);
    if (!uv) return null;
    const s = this._solver.sketchObject;
    const { width, height } = this.#canvasClientSize(v.renderer.domElement);
    const wpp = this.#worldPerPixel(v.camera, width, height);
    // Match handle radius used for point spheres
    const handleR = Math.max(0.02, wpp * 8 * 0.5);
    const tol = handleR * 1.2;
    let bestId = null, bestD = Infinity;
    for (const p of s.points || []) {
      const d = Math.hypot(uv.u - p.x, uv.v - p.y);
      if (d < bestD) { bestD = d; bestId = p.id; }
    }
    return (bestId != null && bestD <= tol) ? bestId : null;
  }

  #hitTestGeometry(e) {
    // Prefer true closest distance in sketch plane (u,v) over ray hit order
    const v = this.viewer;
    if (!v || !this._solver || !this._lock) return null;
    const uv = this.#pointerToPlaneUV(e);
    if (!uv) return null;
    const s = this._solver.sketchObject;
    if (!s) return null;

    // Tolerance based on screen scale (world units per pixel)
    const { width, height } = this.#canvasClientSize(v.renderer.domElement);
    const wpp = this.#worldPerPixel(v.camera, width, height);
    const tol = Math.max(0.05, wpp * 6);

    let best = null;
    let bestDist = Infinity;

    const distToSeg = (ax, ay, bx, by, px, py) => {
      const vx = bx - ax, vy = by - ay;
      const wx = px - ax, wy = py - ay;
      const L2 = vx * vx + vy * vy || 1e-12;
      let t = (wx * vx + wy * vy) / L2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const nx = ax + vx * t, ny = ay + vy * t;
      const dx = px - nx, dy = py - ny;
      return Math.hypot(dx, dy);
    };

    const normAng = (a) => {
      const twoPi = Math.PI * 2;
      a = a % twoPi; if (a < 0) a += twoPi; return a;
    };

    for (const geo of s.geometries || []) {
      if (geo.type === 'line' && Array.isArray(geo.points) && geo.points.length >= 2) {
        const p0 = s.points.find(p => p.id === geo.points[0]);
        const p1 = s.points.find(p => p.id === geo.points[1]);
        if (!p0 || !p1) continue;
        const d = distToSeg(p0.x, p0.y, p1.x, p1.y, uv.u, uv.v);
        if (d < bestDist) { bestDist = d; best = { id: geo.id, type: 'line' }; }
      } else if (geo.type === 'circle' && Array.isArray(geo.points) && geo.points.length >= 2) {
        const pc = s.points.find(p => p.id === geo.points[0]);
        const pr = s.points.find(p => p.id === geo.points[1]);
        if (!pc || !pr) continue;
        const rr = Math.hypot(pr.x - pc.x, pr.y - pc.y);
        const d = Math.abs(Math.hypot(uv.u - pc.x, uv.v - pc.y) - rr);
        if (d < bestDist) { bestDist = d; best = { id: geo.id, type: 'circle' }; }
      } else if (geo.type === 'arc' && Array.isArray(geo.points) && geo.points.length >= 3) {
        const pc = s.points.find(p => p.id === geo.points[0]);
        const pa = s.points.find(p => p.id === geo.points[1]);
        const pb = s.points.find(p => p.id === geo.points[2]);
        if (!pc || !pa || !pb) continue;
        const cx = pc.x, cy = pc.y;
        const rr = Math.hypot(pa.x - cx, pa.y - cy);
        let a0 = Math.atan2(pa.y - cy, pa.x - cx);
        let a1 = Math.atan2(pb.y - cy, pb.x - cx);
        a0 = normAng(a0); a1 = normAng(a1);
        let dAng = a1 - a0; if (dAng < 0) dAng += Math.PI * 2; // CCW sweep [0,2π)
        // If start≈end, treat as full circle fallback
        const fullCircle = (Math.abs(dAng) < 1e-6);
        if (fullCircle) {
          const d = Math.abs(Math.hypot(uv.u - cx, uv.v - cy) - rr);
          if (d < bestDist) { bestDist = d; best = { id: geo.id, type: 'arc' }; }
        } else {
          // Project point angle to arc range
          let av = normAng(Math.atan2(uv.v - cy, uv.u - cx));
          let t = (av - a0); if (t < 0) t += Math.PI * 2; t = t / dAng;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const px = cx + rr * Math.cos(a0 + t * dAng);
          const py = cy + rr * Math.sin(a0 + t * dAng);
          const d = Math.hypot(uv.u - px, uv.v - py);
          if (d < bestDist) { bestDist = d; best = { id: geo.id, type: 'arc' }; }
        }
      } else if (geo.type === 'bezier' && Array.isArray(geo.points) && geo.points.length >= 4) {
        const p0 = s.points.find(p => p.id === geo.points[0]);
        const p1 = s.points.find(p => p.id === geo.points[1]);
        const p2 = s.points.find(p => p.id === geo.points[2]);
        const p3 = s.points.find(p => p.id === geo.points[3]);
        if (!p0 || !p1 || !p2 || !p3) continue;
        const segs = 64;
        let prevx = p0.x, prevy = p0.y;
        for (let i = 1; i <= segs; i++) {
          const t = i / segs;
          const mt = 1 - t;
          const bx = mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x;
          const by = mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y;
          const d = distToSeg(prevx, prevy, bx, by, uv.u, uv.v);
          if (d < bestDist) { bestDist = d; best = { id: geo.id, type: 'bezier' }; }
          prevx = bx; prevy = by;
        }
      }
    }

    if (best && bestDist <= tol) return best;
    return null;
  }
  // Hit-test any EDGE in the whole scene (for external ref picking)
  #hitTestSceneEdge(e) {
    const v = this.viewer;
    if (!v) return null;
    const rect = v.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.#setRayFromCamera(ndc);
    try {
      const { width, height } = this.#canvasClientSize(v.renderer.domElement);
      const wpp = this.#worldPerPixel(v.camera, width, height);
      this._raycaster.params.Line = this._raycaster.params.Line || {};
      this._raycaster.params.Line.threshold = Math.max(0.05, wpp * 6);
      // Ensure fat-line intersections are generous enough in pixels
      const dpr = (window.devicePixelRatio || 1);
      this._raycaster.params.Line2 = this._raycaster.params.Line2 || {};
      this._raycaster.params.Line2.threshold = Math.max(1, 2 * dpr);
    } catch { }
    // Intersect only EDGE objects (ignore faces and everything else)
    const edgeObjects = [];
    try {
      v.scene.traverse((obj) => { if (obj && obj.type === 'EDGE' && obj.visible !== false) edgeObjects.push(obj); });
    } catch { }
    const hits = edgeObjects.length ? this._raycaster.intersectObjects(edgeObjects, true) : [];
    if (hits && hits.length) return hits[0];
    return null;
  }
  #hitTestDim(e) {
    // Choose the closest dimension (constraint) in plane-space to the cursor
    const v = this.viewer;
    if (!v || !this._solver || !this._lock) return null;
    const uv = this.#pointerToPlaneUV(e);
    if (!uv) return null;
    const s = this._solver.sketchObject;
    if (!s) return null;
    const P = (id) => s.points.find((p) => p.id === id);
    const { width, height } = this.#canvasClientSize(v.renderer.domElement);
    const wpp = this.#worldPerPixel(v.camera, width, height);
    const tol = Math.max(0.05, wpp * 10);

    const distToSeg = (ax, ay, bx, by, px, py) => {
      const vx = bx - ax, vy = by - ay;
      const wx = px - ax, wy = py - ay;
      const L2 = vx * vx + vy * vy || 1e-12;
      let t = (wx * vx + wy * vy) / L2; if (t < 0) t = 0; else if (t > 1) t = 1;
      const nx = ax + vx * t, ny = ay + vy * t;
      return Math.hypot(px - nx, py - ny);
    };
    const intersect = (A, B, C, D) => {
      const den = (A.x - B.x) * (C.y - D.y) - (A.y - B.y) * (C.x - D.x);
      if (Math.abs(den) < 1e-9) return { x: B.x, y: B.y };
      const x = ((A.x * A.y - B.x * B.y) * (C.x - D.x) - (A.x - B.x) * (C.x * C.y - D.x * D.y)) / den;
      const y = ((A.x * A.y - B.x * B.y) * (C.y - D.y) - (A.y - B.y) * (C.x * C.y - D.x * D.y)) / den;
      return { x, y };
    };
    const normAng = (a) => { const t = Math.PI * 2; a = a % t; return a < 0 ? a + t : a; };

    let bestCid = null;
    let bestDist = Infinity;

    for (const c of (s.constraints || [])) {
      if (c.type === '⟺' && Array.isArray(c.points) && c.points.length >= 2) {
        if (c.displayStyle === 'radius') {
          const pc = P(c.points[0]); const pr = P(c.points[1]); if (!pc || !pr) continue;
          const rr = Math.hypot(pr.x - pc.x, pr.y - pc.y);
          const d = Math.abs(Math.hypot(uv.u - pc.x, uv.v - pc.y) - rr);
          if (d < bestDist) { bestDist = d; bestCid = c.id; }
        } else {
          const p0 = P(c.points[0]); const p1 = P(c.points[1]); if (!p0 || !p1) continue;
          const d = distToSeg(p0.x, p0.y, p1.x, p1.y, uv.u, uv.v);
          if (d < bestDist) { bestDist = d; bestCid = c.id; }
        }
      } else if (c.type === '∠' && Array.isArray(c.points) && c.points.length >= 4) {
        const p0 = P(c.points[0]), p1 = P(c.points[1]), p2 = P(c.points[2]), p3 = P(c.points[3]);
        if (!p0 || !p1 || !p2 || !p3) continue;
        const I = intersect(p0, p1, p2, p3);
        // Approximate: distance to circular arc at nominal radius around I
        const rSel = Math.max(0.2, wpp * 12);
        const d = Math.abs(Math.hypot(uv.u - I.x, uv.v - I.y) - rSel);
        if (d < bestDist) { bestDist = d; bestCid = c.id; }
      }
    }

    if (bestCid != null && bestDist <= tol) return { cid: bestCid };
    return null;
  }

  #hitTestGlyph(e) {
    // Hit test constraint glyph centers placed by glyph renderer
    const v = this.viewer;
    if (!v || !this._lock || !this._glyphCenters) return null;
    const uv = this.#pointerToPlaneUV(e);
    if (!uv) return null;
    const { width, height } = this.#canvasClientSize(v.renderer.domElement);
    const wpp = this.#worldPerPixel(v.camera, width, height);
    const tol = Math.max(0.05, wpp * 8);
    let best = null, bestD = Infinity;
    try {
      for (const [cid, pt] of this._glyphCenters.entries()) {
        const d = Math.hypot((uv.u - pt.u), (uv.v - pt.v));
        if (d < bestD) { bestD = d; best = cid; }
      }
    } catch { }
    return (best != null && bestD <= tol) ? { cid: best } : null;
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
    // Sketch curves should always render on top of scene geometry
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xffff88,
      depthTest: false,        // <- renders on top regardless of depth
      depthWrite: false,       // <- doesn't modify the depth buffer
      transparent: true,
    });
    const dashedMatBase = new THREE.LineDashedMaterial({
      color: 0xffff88,
      depthTest: false,        // <- renders on top regardless of depth
      depthWrite: false,       // <- doesn't modify the depth buffer
      transparent: true,
      dashSize: 0.1, // placeholder; scaled per viewport below
      gapSize: 0.08,
    });
    // Determine world-per-pixel to scale dash size for consistent screen appearance
    let wpp = 0.05;
    try {
      const { width, height } = this.#canvasClientSize(this.viewer.renderer.domElement);
      wpp = this.#worldPerPixel(this.viewer.camera, width, height);
    } catch { }
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
        const mat = (geo.construction ? dashedMatBase.clone() : lineMat.clone());
        if (geo.construction) {
          try { mat.dashSize = Math.max(0.02, 8 * wpp); mat.gapSize = Math.max(0.01, 6 * wpp); } catch { }
        }
        try {
          mat.color.set(sel ? 0x6fe26f : 0xffff88);
        } catch { }
        const ln = new THREE.Line(bg, mat);
        if (geo.construction) { try { ln.computeLineDistances(); } catch { } }
        ln.renderOrder = 10000;
        
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
        const mat = (geo.construction ? dashedMatBase.clone() : lineMat.clone());
        if (geo.construction) {
          try { mat.dashSize = Math.max(0.02, 8 * wpp); mat.gapSize = Math.max(0.01, 6 * wpp); } catch { }
        }
        try {
          mat.color.set(sel ? 0x6fe26f : 0xffff88);
        } catch { }
        const ln = new THREE.Line(bg, mat);
        if (geo.construction) { try { ln.computeLineDistances(); } catch { } }
        ln.renderOrder = 10000;
        
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
        // Use CCW sweep in [0, 2π). If start≈end, draw full circle (2π).
        let d = a1 - a0;
        d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (Math.abs(d) < 1e-6) d = 2 * Math.PI;
        const segs = Math.max(8, Math.ceil((64 * d) / (2 * Math.PI)));
        const pts = [];
        for (let i = 0; i <= segs; i++) {
          const t = a0 + d * (i / segs);
          pts.push(to3(cx + rr * Math.cos(t), cy + rr * Math.sin(t)));
        }
        const bg = new THREE.BufferGeometry().setFromPoints(pts);
        const sel = Array.from(this._selection).some(
          (it) => it.type === "geometry" && it.id === geo.id,
        );
        const mat = (geo.construction ? dashedMatBase.clone() : lineMat.clone());
        if (geo.construction) {
          try { mat.dashSize = Math.max(0.02, 8 * wpp); mat.gapSize = Math.max(0.01, 6 * wpp); } catch { }
        }
        try {
          mat.color.set(sel ? 0x6fe26f : 0xffff88);
        } catch { }
        const ln = new THREE.Line(bg, mat);
        if (geo.construction) { try { ln.computeLineDistances(); } catch { } }
        ln.renderOrder = 10000;
        
        ln.userData = { kind: "geometry", id: geo.id, type: geo.type };
        grp.add(ln);
      } else if (geo.type === "bezier") {
        const ids = geo.points || [];
        const p0 = s.points.find((p) => p.id === ids[0]);
        const p1 = s.points.find((p) => p.id === ids[1]);
        const p2 = s.points.find((p) => p.id === ids[2]);
        const p3 = s.points.find((p) => p.id === ids[3]);
        if (!p0 || !p1 || !p2 || !p3) continue;
        const segs = 64;
        const pts = [];
        for (let i = 0; i <= segs; i++) {
          const t = i / segs;
          const mt = 1 - t;
          const bx = mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x;
          const by = mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y;
          pts.push(to3(bx, by));
        }
        const bg = new THREE.BufferGeometry().setFromPoints(pts);
        const sel = Array.from(this._selection).some(
          (it) => it.type === "geometry" && it.id === geo.id,
        );
        const mat = (geo.construction ? dashedMatBase.clone() : lineMat.clone());
        if (geo.construction) {
          try { mat.dashSize = Math.max(0.02, 8 * wpp); mat.gapSize = Math.max(0.01, 6 * wpp); } catch { }
        }
        try { mat.color.set(sel ? 0x6fe26f : 0xffff88); } catch { }
        const ln = new THREE.Line(bg, mat);
        if (geo.construction) { try { ln.computeLineDistances(); } catch { } }
        ln.renderOrder = 10000;
        
        ln.userData = { kind: "geometry", id: geo.id, type: geo.type };
        grp.add(ln);

        // No explicit guide rendering here: actual construction lines are created on curve creation
      }
    }
    const { width, height } = this.#canvasClientSize(
      this.viewer.renderer.domElement,
    );
    wpp = this.#worldPerPixel(this.viewer.camera, width, height);
    const r = Math.max(0.02, wpp * 8 * 0.5);
    for (const p of s.points || []) {
      const selected = Array.from(this._selection).some(
        (it) => it.type === "point" && it.id === p.id,
      );
      const mat = new THREE.MeshBasicMaterial({
        color: selected ? 0x6fe26f : 0x9ec9ff,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
      const m = new THREE.Mesh(this._handleGeom, mat);
      m.renderOrder = 10001;
      
      m.position.copy(to3(p.x, p.y));
      m.userData = { kind: "point", id: p.id };
      // Enlarge selected points 2x for better visibility
      m.scale.setScalar(selected ? r * 2 : r);
      grp.add(m);
    }
    this.#refreshLists();
    this.#renderDimensions();
    this.#applyHoverAndSelectionColors();
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
      if (ch?.userData?.kind === "point") {
        const isSelected = Array.from(this._selection).some(
          (it) => it.type === 'point' && it.id === ch.userData.id,
        );
        ch.scale.setScalar(isSelected ? r * 2 : r);
      }
    }
  }

  // Camera locking/remapping removed: no camera adjustments during sketch mode

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



  #renderDimensions() { try { dimsRender(this); } catch { } }

  // Public: called by Viewer when camera or viewport changes
  onCameraChanged() {
    try { this.#renderDimensions(); } catch { }
  }








  // Lookup a constraint by id from the current sketch
  #getConstraintById(id) {
    const s = this._solver?.sketchObject;
    if (!s) return null;
    const cid = parseInt(id);
    return (s.constraints || []).find((c) => parseInt(c.id) === cid) || null;
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
    // Disable camera controls during dimension drag
    try { if (this.viewer?.controls) this.viewer.controls.enabled = false; } catch { }
    e.preventDefault();
    try { e.stopImmediatePropagation(); } catch { }
    e.stopPropagation();
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
    // Notify controls that interaction ended (no lock/unlock)
    try { if (this.viewer?.controls) this.viewer.controls.enabled = true; } catch { }
    setTimeout(() => { this.#notifyControlsEnd(e); }, 30);
  }

  #notifyControlsEnd(e) {
    // Notify controls the interaction ended without synthesizing DOM events,
    // to avoid re-entering our own pointerup handler.
    try { this.viewer?.controls?.dispatchEvent?.({ type: "end" }); } catch { }
  }
  // Controls locking removed
}
