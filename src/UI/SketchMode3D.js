// SketchMode3D: In-scene sketch editing with camera locked to a plane.
// Phase 1: camera lock + minimal Finish/Cancel overlay UI + panning only.

import * as THREE from 'three';

export class SketchMode3D {
  constructor(viewer, featureID) {
    this.viewer = viewer;
    this.featureID = featureID;
    this._ui = null;
    this._saved = null; // camera + controls snapshot
    this._lock = null;  // { basis:{x,y,z,origin}, distance, target }
    this._panning = false;
    this._panStart = { x: 0, y: 0 };
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
      ? ph.features.find(f => f?.inputParams?.featureID === this.featureID)
      : null;
    const refName = feature?.inputParams?.sketchPlane || null;
    const refObj = refName ? ph.scene.getObjectByName(refName) : null;

    // Compute basis from reference (fallback to world XY)
    const basis = this.#basisFromReference(refObj);

    // Determine distance so entire plane is visible
    const d = 20; // generic distance along normal; ortho camera ignores distance for scale, but we keep it stable

    // Apply camera lock
    const q = this.#quatFromAxes(basis.x, basis.y, basis.z);
    v.camera.up.copy(basis.y);
    v.camera.position.copy(basis.origin).addScaledVector(basis.z, d);
    v.camera.quaternion.copy(q);
    v.camera.updateProjectionMatrix();

    // Disable arcball rotations; keep it enabled for internal bookkeeping but we’ll override orientation
    v.controls.enabled = false; // we'll handle panning ourselves for deterministic behavior

    this._lock = { basis, distance: d, target: basis.origin.clone() };

    // Attach lightweight UI (top-right). Ensure sidebar remains visible during mode.
    try {
      const sb = v.sidebar;
      if (sb) { sb.hidden = false; sb.style.visibility = 'visible'; sb.style.opacity = .9; }
    } catch {}
    // UI overlay
    this.#mountOverlayUI();

    // Pointer listeners for panning
    const el = v.renderer.domElement;
    this._onMove = (e) => this.#onPointerMove(e);
    this._onDown = (e) => this.#onPointerDown(e);
    this._onUp = (e) => this.#onPointerUp(e);
    el.addEventListener('pointermove', this._onMove, { passive: false });
    el.addEventListener('pointerdown', this._onDown, { passive: false });
    window.addEventListener('pointerup', this._onUp, { passive: false, capture: true });
  }

  close() {
    const v = this.viewer;
    if (this._ui && v?.container) { try { v.container.removeChild(this._ui); } catch { } this._ui = null; }
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
      try { el.removeEventListener('pointermove', this._onMove); } catch {}
      try { el.removeEventListener('pointerdown', this._onDown); } catch {}
    }
    try { window.removeEventListener('pointerup', this._onUp, true); } catch {}
    this._lock = null;
  }

  dispose() { this.close(); }

  finish() {
    // Hand back to viewer; the actual sketch data will be managed elsewhere later.
    try { if (typeof this.viewer?.onSketchFinished === 'function') this.viewer.onSketchFinished(this.featureID, null); } catch { }
    this.close();
  }

  cancel() {
    try { if (typeof this.viewer?.onSketchCancelled === 'function') this.viewer.onSketchCancelled(this.featureID); } catch { }
    this.close();
  }

  // -------------------------- internals --------------------------
  #mountOverlayUI() {
    const v = this.viewer;
    const host = v?.container;
    if (!host) return;
    const ui = document.createElement('div');
    ui.style.position = 'absolute';
    ui.style.top = '8px';
    ui.style.right = '8px';
    ui.style.display = 'flex';
    ui.style.gap = '8px';
    ui.style.zIndex = '1000';

    const mk = (label, primary, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.appearance = 'none';
      b.style.border = '1px solid #262b36';
      b.style.borderRadius = '8px';
      b.style.padding = '6px 10px';
      b.style.cursor = 'pointer';
      b.style.background = primary ? 'linear-gradient(180deg, rgba(110,168,254,.25), rgba(110,168,254,.15))' : 'rgba(255,255,255,.05)';
      b.style.color = '#e6e6e6';
      b.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
      return b;
    };
    ui.appendChild(mk('Finish', true, () => this.finish()));
    ui.appendChild(mk('Cancel', false, () => this.cancel()));
    host.style.position = host.style.position || 'relative';
    host.appendChild(ui);
    this._ui = ui;
  }

  #onPointerDown(e) {
    // Begin panning on any button not handled by object tools
    this._panning = true;
    this._panStart.x = e.clientX;
    this._panStart.y = e.clientY;
    e.preventDefault();
    try { e.stopPropagation(); } catch {}
  }

  #onPointerMove(e) {
    if (!this._panning || !this._lock) return;
    const dx = e.clientX - this._panStart.x;
    const dy = e.clientY - this._panStart.y;
    if (dx === 0 && dy === 0) return;
    this._panStart.x = e.clientX;
    this._panStart.y = e.clientY;

    const v = this.viewer;
    const { width, height } = this.#canvasClientSize(v.renderer.domElement);
    const wpp = this.#worldPerPixel(v.camera, width, height);

    // Screen +X = world +basis.x, Screen +Y = world +basis.y (camera up aligned)
    const move = new THREE.Vector3();
    move.addScaledVector(this._lock.basis.x, -dx * wpp);
    move.addScaledVector(this._lock.basis.y, dy * wpp);

    v.camera.position.add(move);
    // Keep camera oriented (already aligned), distance along normal preserved automatically
    e.preventDefault();
    try { e.stopPropagation(); } catch {}
  }

  #onPointerUp(_e) { this._panning = false; }

  #canvasClientSize(canvas) {
    return { width: canvas.clientWidth || canvas.width || 1, height: canvas.clientHeight || canvas.height || 1 };
  }

  #worldPerPixel(camera, width, height) {
    if (camera && camera.isOrthographicCamera) {
      const wppX = (camera.right - camera.left) / width;
      const wppY = (camera.top - camera.bottom) / height;
      return Math.max(wppX, wppY);
    }
    // Perspective fallback
    const dist = camera.position.length();
    const fovRad = (camera.fov * Math.PI) / 180;
    return (2 * Math.tan(fovRad / 2) * dist) / height;
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
    if (obj.type === 'FACE' && typeof obj.getAverageNormal === 'function') {
      const n = obj.getAverageNormal();
      const worldUp = new THREE.Vector3(0, 1, 0);
      const tmp = new THREE.Vector3();
      const zx = Math.abs(n.dot(worldUp)) > 0.9 ? new THREE.Vector3(1, 0, 0) : worldUp; // pick a non-parallel ref
      x.copy(tmp.crossVectors(zx, n).normalize());
      y.copy(tmp.crossVectors(n, x).normalize());
      z.copy(n.clone().normalize());
      // origin ~ face centroid if available
      const g = obj.geometry;
      try {
        const bs = g.boundingSphere || (g.computeBoundingSphere(), g.boundingSphere);
        if (bs) origin.copy(obj.localToWorld(bs.center.clone()));
      } catch { }
      return { x, y, z, origin };
    }

    // For generic Mesh (plane), derive z from its world normal
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion())).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const tmp = new THREE.Vector3();
    const zx = Math.abs(n.dot(worldUp)) > 0.9 ? new THREE.Vector3(1, 0, 0) : worldUp; // non-parallel ref
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
}
