// CombinedTransformControls — lightweight move + rotate gizmo
// Drop-in replacement for three/examples TransformControls used by this app.
// Focuses on orthographic cameras and the needs of the BREP Viewer.
//
// Public API compatibility (subset):
// - constructor(camera, domElement)
// - extends THREE.Object3D so it can be added to the scene
// - properties: enabled, dragging, mode, showX/Y/Z, isTransformGizmo
// - methods: attach(obj), detach(), setMode(mode), getMode(), update(), dispose(), getHelper()
// - events: 'change', 'dragging-changed', 'objectChange'
// - picking roots available at this.gizmo.picker.translate / .rotate
//
import * as THREE from 'three';

export class CombinedTransformControls extends THREE.Object3D {
  constructor(camera, domElement) {
    super();
    this.type = 'CombinedTransformControls';
    this.camera = camera;
    this.domElement = domElement;
    this.enabled = true;
    this.dragging = false;
    this.mode = 'translate'; // kept for compatibility; both gizmos are active
    this.showX = true; this.showY = true; this.showZ = true;
    this.isTransformGizmo = true; // used by PartHistory cleanup logic
    this._sizeMultiplier = 3; // larger default on‑screen size
    this.renderOrder = 10020; // Use same render order as overlay elements (centerlines, dimensions)

    this.target = null; // Object3D we drive

    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._plane = new THREE.Plane();

    // Visuals
    this.gizmo = this._buildGizmo();
    this.add(this.gizmo.root);

    // Events
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    if (this.domElement) {
      this.domElement.addEventListener('pointerdown', this._onPointerDown, { passive: false });
      window.addEventListener('pointermove', this._onPointerMove, { passive: false });
      window.addEventListener('pointerup', this._onPointerUp, { passive: false, capture: true });
    }
  }

  dispose() {
    try { this.domElement?.removeEventListener('pointerdown', this._onPointerDown); } catch {}
    try { window.removeEventListener('pointermove', this._onPointerMove); } catch {}
    try { window.removeEventListener('pointerup', this._onPointerUp, { capture: true }); } catch {}
  }

  getHelper() { return this; }
  getMode() { return this.mode; }
  setMode(mode) { this.mode = String(mode || 'translate'); }
  setSize(s) { this._sizeMultiplier = Number(s) || 1; this.update(); }

  attach(object) {
    this.target = object || null;
    if (this.target) {
      try { this.target.updateMatrixWorld(true); } catch {}
      this.position.copy(this.target.getWorldPosition(new THREE.Vector3()));
      this.quaternion.copy(this.target.getWorldQuaternion(new THREE.Quaternion()));
      this.updateMatrixWorld(true);
      try { this.update(); } catch {}
    }
  }
  detach() { this.target = null; }

  update() {
    // Keep a roughly constant on‑screen scale (ortho-friendly)
    const scale = this._computeGizmoScale() * (this._sizeMultiplier || 1);
    this.gizmo.root.scale.setScalar(scale);
    // Face camera for labels
    if (this.gizmo && this.gizmo.labels) {
      const q = this.camera.quaternion;
      for (const s of this.gizmo.labels) s.quaternion.copy(q);
    }
  }

  // ————————————————————————————————————————
  // Internals: visuals
  // ————————————————————————————————————————
  _buildGizmo() {
    const root = new THREE.Group();
    root.name = 'HybridXformGizmoRoot';
    root.userData.excludeFromFit = true;
    root.renderOrder = this.renderOrder; // Ensure gizmo renders on top of all other geometry

    // For compatibility with the viewer's hover checks, expose picker roots.
    // Point them at the root so our oriented per-handle meshes are included.
    const picker = { translate: root, rotate: root };

    // Materials - using overlay pattern (depthTest: false, depthWrite: false)
    const mAxis = new THREE.MeshBasicMaterial({ color: 0xbfbfbf, toneMapped: false, depthTest: false, depthWrite: false, transparent: true });
    const mArrow = new THREE.MeshBasicMaterial({ color: 0xf2c14e, toneMapped: false, depthTest: false, depthWrite: false, transparent: true });
    const mArc = new THREE.MeshBasicMaterial({ color: 0xd6d6d6, toneMapped: false, depthTest: false, depthWrite: false, transparent: true });
    const mDot = new THREE.MeshBasicMaterial({ color: 0xf29e4c, toneMapped: false, depthTest: false, depthWrite: false, transparent: true });

    // Geometries (shared)
    const gRod = new THREE.CylinderGeometry(0.03, 0.03, 1.0, 16);
    const gArrow = new THREE.ConeGeometry(0.08, 0.25, 20);
    const gDot = new THREE.SphereGeometry(0.06, 16, 12);

    // Axis builders
    const axes = [];
    const addAxis = (axis, colorText, spriteLabel) => {
      const group = new THREE.Group();
      group.renderOrder = this.renderOrder; // Ensure gizmo renders on top of all other geometry
      group.name = `Axis${axis}`;

      const rod = new THREE.Mesh(gRod, mAxis);
      rod.renderOrder = this.renderOrder;
      rod.position.y = 0.5; // rod extends from center along +Y before orientation
      group.add(rod);

      const tip = new THREE.Mesh(gArrow, mArrow);
      tip.renderOrder = this.renderOrder;
      tip.position.y = 1.0 + 0.125;
      tip.userData.handle = { kind: 'translate', axis };
      group.add(tip);

      // Orient group
      if (axis === 'X') group.rotation.z = -Math.PI / 2;
      if (axis === 'Z') group.rotation.x = -Math.PI / 2;

      // Label sprite (XC/YC/ZC)
      const spr = this._makeTextSprite(`${axis}C`, colorText);
      // Place label along the axis positive direction (local +Y before rotation)
      spr.position.set(0, 1.3, 0);
      group.add(spr);

      root.add(group);
      axes.push({ group, spr });
    };

    addAxis('X', '#ff6666');
    addAxis('Y', '#7ddc6f');
    addAxis('Z', '#6aa9ff');

    // Rotation arcs: quarter circles in XY (Z axis), YZ (X axis), ZX (Y axis)
    const rot = {};
    const addRotate = (axis) => {
      const grp = new THREE.Group();
      grp.name = `Rotate${axis}`;
      grp.renderOrder = this.renderOrder;
      const r = 0.9;
      const arcShape = new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 33 }, (_, i) => {
          const t = (i / 32) * (Math.PI / 2);
          return new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r, 0);
        })
      );
      const arcMat = new THREE.LineBasicMaterial({ color: 0xe0e0e0, linewidth: 2, toneMapped: false, depthTest: false, depthWrite: false, transparent: true });
      const arc = new THREE.Line(arcShape, arcMat);
      arc.renderOrder = this.renderOrder;
      grp.add(arc);

      // Single decorative dot along the arc (one per axis)
      const tDot = Math.PI / 4; // 45° along the arc
      const dot = new THREE.Mesh(gDot, mDot);
      dot.position.set(Math.cos(tDot) * r, Math.sin(tDot) * r, 0);
      dot.renderOrder = this.renderOrder;
      // Make the dot itself a rotate handle so dragging it feels natural
      dot.userData.handle = { kind: 'rotate', axis };
      grp.add(dot);

      // Orient to axis
      if (axis === 'X') grp.rotation.y = Math.PI / 2;      // arc in YZ plane -> rotate around X
      if (axis === 'Y') grp.rotation.x = -Math.PI / 2;     // arc in ZX plane -> rotate around Y
      // axis Z: default in XY plane

      root.add(grp);
      rot[axis] = { group: grp, dot, radius: r };
    };

    addRotate('Z');
    addRotate('Y');
    addRotate('X');

    return { root, picker, labels: axes.map(a => a.spr), rot };
  }

  _makeTextSprite(text, color = '#ffffff') {
    const size = 256;
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = size;
    const ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, size, size);
    ctx.font = 'bold 64px system-ui, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(String(text || ''), size / 2, size / 2);
    const tex = new THREE.CanvasTexture(cvs);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const spr = new THREE.Sprite(mat);
    spr.scale.setScalar(0.6);
    spr.renderOrder = this.renderOrder;
    return spr;
  }

  _computeGizmoScale() {
    // For OrthographicCamera, constant screen size ≈ inverse of zoom.
    const cam = this.camera;
    if (cam && cam.isOrthographicCamera) {
      const z = Math.max(0.0001, cam.zoom || 1);
      return 1 / z;
    }
    // Perspective: scale with distance, using simple heuristic
    const pos = this.getWorldPosition(this._tmpV);
    const camPos = this.camera.getWorldPosition(this._tmpV2);
    const d = pos.distanceTo(camPos);
    const f = Math.tan((this.camera.fov || 50) * Math.PI / 360) * 2.0;
    return (d * f) / 10; // heuristic constant
  }

  // ————————————————————————————————————————
  // Internals: interaction
  // ————————————————————————————————————————
  _setPointerFromEvent(e) {
    const rect = this.domElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._pointer.set(x, y);
  }

  _intersections(root) {
    this._raycaster.setFromCamera(this._pointer, this.camera);
    return this._raycaster.intersectObject(root, true) || [];
  }

  _handlePointerDown(e) {
    if (!this.enabled || !this.visible) return;
    if (!this.target) return;
    this._setPointerFromEvent(e);
    // Prefer picker matching current mode, then fallback to all
    const giz = this.gizmo;
    const pickRoot = giz.picker[this.mode] || giz.root; // tolerate missing picker grouping
    const hits = this._intersections(pickRoot);
    const hit = Array.isArray(hits) ? hits.find(it => it?.object?.userData?.handle) : null;
    if (!hit) return;
    const h = hit.object.userData.handle;
    if (!h || !h.kind) return;
    e.preventDefault();
    e.stopPropagation?.();

    this._drag = this._drag || {};
    this._drag.handle = h; // { kind, axis }
    // Use the gizmo's current world pose as the drag reference so
    // subsequent drags operate relative to the gizmo orientation/position
    try { this.updateMatrixWorld(true); } catch {}
    this._drag.startPos = this.getWorldPosition(new THREE.Vector3());
    this._drag.startQuat = this.getWorldQuaternion(new THREE.Quaternion());
    this._drag.axis = this._axisWorld(h.axis);

    // Establish reference plane and initial point
    if (h.kind === 'translate') {
      const camDir = this.camera.getWorldDirection(new THREE.Vector3());
      // screen plane through startPos
      this._plane.setFromNormalAndCoplanarPoint(camDir, this._drag.startPos);
    } else if (h.kind === 'rotate') {
      this._plane.setFromNormalAndCoplanarPoint(this._drag.axis, this._drag.startPos);
    }
    this._drag.startPoint = this._planeIntersect();
    if (!this._drag.startPoint) { this._drag = null; return; }

    // For rotation, track incremental deltas so angles can exceed 180°
    if (h.kind === 'rotate') {
      this._drag.prevPoint = this._drag.startPoint.clone();
      const rotRef = (this.gizmo && this.gizmo.rot) ? this.gizmo.rot[h.axis] : null;
      this._drag.rotVis = rotRef || null;
    }

    this.dragging = true;
    this.dispatchEvent({ type: 'dragging-changed', value: true });
  }

  _handlePointerMove(e) {
    if (!this.dragging || !this._drag) return;
    this._setPointerFromEvent(e);
    const p = this._planeIntersect();
    if (!p) return;

    const { handle, startPos, startQuat, axis, startPoint } = this._drag;
    if (handle.kind === 'translate') {
      const diff = this._tmpV.copy(p).sub(startPoint);
      const amt = diff.dot(axis);
      const pos = this._tmpV2.copy(startPos).add(this._tmpV.copy(axis).multiplyScalar(amt));
      this.target.position.copy(pos);
    } else if (handle.kind === 'rotate') {
      // Compute incremental angle since last move to avoid wrap-around at 180°
      const prev = (this._drag.prevPoint || startPoint);
      const vPrev = this._tmpV.copy(prev).sub(startPos).normalize();
      const vNow = this._tmpV2.copy(p).sub(startPos).normalize();
      const cross = new THREE.Vector3().crossVectors(vPrev, vNow);
      const dot = THREE.MathUtils.clamp(vPrev.dot(vNow), -1, 1);
      const dAngle = Math.atan2(cross.dot(axis), dot);
      
      // Apply incremental rotation using the current axis orientation
      const currentAxis = this._axisWorld(handle.axis); // Get current axis orientation
      const deltaQ = new THREE.Quaternion().setFromAxisAngle(currentAxis, dAngle);
      this.target.quaternion.multiplyQuaternions(deltaQ, this.target.quaternion);
      
      this._drag.prevPoint = p.clone();

      // Move the decorative dot along the circle perpendicular to the axis
      try {
        const rotVis = this._drag.rotVis;
        if (rotVis && rotVis.dot && rotVis.group && handle.axis) {
          const r = rotVis.radius || 0.9;
          
          // Keep the dot at a fixed position during drag to avoid jumping
          // The visual feedback is primarily from the object rotation itself
          // We could calculate the exact angle, but a fixed position works fine for UX
          const fixedAngle = Math.PI / 4; // 45° - same as initial position
          rotVis.dot.position.set(Math.cos(fixedAngle) * r, Math.sin(fixedAngle) * r, 0);
        }
      } catch {}
    }

    // Keep gizmo aligned with target (position + rotation)
    this.position.copy(this.target.position);
    this.quaternion.copy(this.target.quaternion);
    this.updateMatrixWorld(true);

    this.dispatchEvent({ type: 'change' });
  }

  _handlePointerUp(e) {
    if (!this.dragging) return;
    this.dragging = false;
    this._drag = null;
    this.dispatchEvent({ type: 'dragging-changed', value: false });
    this.dispatchEvent({ type: 'objectChange' });
  }

  _axisWorld(axis) {
    const v = new THREE.Vector3(
      axis === 'X' ? 1 : 0,
      axis === 'Y' ? 1 : 0,
      axis === 'Z' ? 1 : 0,
    );
    // Axis is defined in gizmo/target local; rotate to world using current gizmo quaternion
    return v.applyQuaternion(this.quaternion).normalize();
  }

  _planeIntersect() {
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const p = new THREE.Vector3();
    const hit = this._raycaster.ray.intersectPlane(this._plane, p);
    return hit ? p.clone() : null;
  }
}

// Keep original name for compatibility with existing import sites
export { CombinedTransformControls as TransformControls };
