// ViewCube.js
// Minimal view cube overlay rendered with scissor viewport.
// - Syncs orientation with a target camera
// - Click faces to reorient target camera to axis-aligned views

import * as THREE from 'three';

export class ViewCube {
  /**
   * @param {Object} opts
   * @param {THREE.WebGLRenderer} opts.renderer
   * @param {THREE.Camera} opts.targetCamera
   * @param {Object} [opts.controls] - ArcballControls (optional)
   * @param {number} [opts.size=110] - widget size in pixels
   * @param {number} [opts.margin=10] - margin from top-right
   */
  constructor({ renderer, targetCamera, controls = null, size = 110, margin = 10 } = {}) {
    if (!renderer || !targetCamera) throw new Error('ViewCube requires { renderer, targetCamera }');
    this.renderer = renderer;
    this.targetCamera = targetCamera;
    this.controls = controls;
    this.size = size;
    this.margin = margin;

    // Scene + camera for the cube
    this.scene = new THREE.Scene();
    this.scene.autoUpdate = true;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.camera.position.set(0, 0, 3);
    this.camera.lookAt(0, 0, 0);

    // Root that mirrors target camera orientation
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // Sub-group for picking faces
    this.pickGroup = new THREE.Group();
    this.root.add(this.pickGroup);

    // Visual cube
    const baseGeom = new THREE.BoxGeometry(1, 1, 1);
    const baseMat = new THREE.MeshBasicMaterial({ color: 0xaaaaaa, opacity: 0.6, transparent: true });
    const baseMesh = new THREE.Mesh(baseGeom, baseMat);
    this.root.add(baseMesh);

    // Edges for contrast
    try {
      const edges = new THREE.EdgesGeometry(baseGeom);
      const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff }));
      this.root.add(line);
    } catch {}

    // Create text label sprite
    const makeLabel = (text, color = '#ffffff') => {
      const pad = 16;
      const fontSize = 64;
      const canvas = document.createElement('canvas');
      canvas.width = 512; canvas.height = 256; // 2:1 ratio
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 8;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      ctx.strokeText(text, cx, cy);
      ctx.fillText(text, cx, cy);
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
      const spr = new THREE.Sprite(mat);
      // Scale sprite to fit face nicely
      const w = 0.8, h = 0.4; // in cube units
      spr.scale.set(w, h, 1);
      spr.renderOrder = 2;
      return spr;
    };

    // Face planes for picking + labels
    const mkFace = (dir, color, name) => {
      const g = new THREE.PlaneGeometry(0.98, 0.98);
      const m = new THREE.MeshBasicMaterial({ color, opacity: 0.35, transparent: true, side: THREE.DoubleSide });
      const p = new THREE.Mesh(g, m);
      p.position.copy(dir.clone().multiplyScalar(0.5));
      // orient plane to face outward
      const q = new THREE.Quaternion();
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
      p.quaternion.copy(q);
      p.userData = { dir: dir.clone().normalize(), name };
      p.renderOrder = 1; // draw on top of base box
      this.pickGroup.add(p);

      // Add centered label slightly above the surface
      try {
        const label = makeLabel(name, '#ffffff');
        label.position.set(0, 0, 0.01);
        p.add(label);
      } catch {}
      return p;
    };

    mkFace(new THREE.Vector3( 1, 0, 0), 0xd86b6b, 'RIGHT');
    mkFace(new THREE.Vector3(-1, 0, 0), 0x6b8ad8, 'LEFT');
    mkFace(new THREE.Vector3( 0, 1, 0), 0x6bd88f, 'TOP');
    mkFace(new THREE.Vector3( 0,-1, 0), 0xd8c86b, 'BOTTOM');
    mkFace(new THREE.Vector3( 0, 0, 1), 0xd86bd5, 'FRONT');
    mkFace(new THREE.Vector3( 0, 0,-1), 0x6bd8d8, 'BACK');

    // Soft ambient to ensure steady colors regardless of renderer state
    const amb = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(amb);

    // Raycaster for cube picking
    this._raycaster = new THREE.Raycaster();
  }

  // Keep cube orientation in sync with target camera
  syncWithCamera() {
    if (!this.targetCamera) return;
    this.root.quaternion.copy(this.targetCamera.quaternion);
  }

  // Compute viewport rectangle (bottom-right). Returns both CSS(top-left) and GL(bottom-left) coords.
  _viewportRect() {
    const el = this.renderer.domElement;
    const width = el.clientWidth || 1;
    const height = el.clientHeight || 1;
    const w = Math.min(this.size, width);
    const h = Math.min(this.size, height);
    const xCss = width - w - this.margin;   // from top-left
    const yCss = height - h - this.margin;  // bottom-right in CSS coords
    const xGL = xCss;                        // same horizontally
    const yGL = this.margin;                 // bottom margin in GL coords
    return { xCss, yCss, xGL, yGL, w, h, width, height };
  }

  // Render the view cube using scissor in the top-right corner
  render() {
    const { xGL, yGL, w, h, width, height } = this._viewportRect();
    const r = this.renderer;
    const prev = {
      scissorTest: r.getScissorTest && r.getScissorTest(),
      autoClear: r.autoClear,
    };

    // Update camera for aspect
    const aspect = w / h || 1;
    this.camera.left = -1 * aspect;
    this.camera.right = 1 * aspect;
    this.camera.top = 1;
    this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();

    // Render cube without clearing color to keep background transparent
    r.setScissorTest(true);
    r.autoClear = false;
    r.setScissor(xGL, yGL, w, h);
    r.setViewport(xGL, yGL, w, h);
    r.clearDepth();
    this.syncWithCamera();
    r.render(this.scene, this.camera);

    // Restore viewport/scissor for main renderer
    r.setViewport(0, 0, width, height);
    r.setScissor(0, 0, width, height);
    r.setScissorTest(!!prev.scissorTest);
    r.autoClear = prev.autoClear;
  }

  // Check if a DOM pointer event is inside the cube viewport
  isEventInside(event) {
    const rect = this._viewportRect();
    const elRect = this.renderer.domElement.getBoundingClientRect();
    const px = event.clientX - elRect.left;
    const py = event.clientY - elRect.top;
    return (px >= rect.xCss && px <= rect.xCss + rect.w &&
            py >= rect.yCss && py <= rect.yCss + rect.h);
  }

  // Attempt to handle a click; returns true if consumed
  handleClick(event) {
    if (!this.isEventInside(event)) return false;
    const { xCss, yCss, w, h } = this._viewportRect();
    const elRect = this.renderer.domElement.getBoundingClientRect();
    const cx = event.clientX - elRect.left;
    const cy = event.clientY - elRect.top;
    const nx = ( (cx - xCss) / w ) * 2 - 1;
    const ny = -( (cy - yCss) / h ) * 2 + 1;
    const ndc = new THREE.Vector2(nx, ny);

    this._raycaster.setFromCamera(ndc, this.camera);
    const intersects = this._raycaster.intersectObjects(this.pickGroup.children, false);
    if (intersects && intersects.length) {
      const face = intersects[0].object;
      const dir = face?.userData?.dir;
      if (dir) this._reorientCamera(dir);
      return true;
    }
    return false;
  }

  _reorientCamera(dir) {
    const cam = this.targetCamera;
    if (!cam) return;

    // Keep same distance from origin
    const dist = cam.position.length() || 10;
    const pos = dir.clone().normalize().multiplyScalar(dist);

    // Choose a stable up vector for the final view
    const useZup = Math.abs(dir.y) > 0.9; // top/bottom -> Z up to avoid roll
    const up = useZup ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);

    // Compute target orientation quaternion that looks at origin with chosen up
    const lookQuat = (eye, target, upv) => {
      const m = new THREE.Matrix4();
      m.lookAt(eye, target, upv);
      m.invert();
      const q = new THREE.Quaternion();
      q.setFromRotationMatrix(m);
      return q;
    };

    const fromPos = cam.position.clone();
    const toPos = pos;
    const fromQuat = cam.quaternion.clone();
    const toQuat = lookQuat(toPos, new THREE.Vector3(0, 0, 0), up);
    const fromUp = cam.up.clone();

    // Smooth animation
    const dur = 350; // ms
    const t0 = performance.now();
    const controls = this.controls;
    if (controls) controls.enabled = false;

    const ease = (t) => t * t * (3 - 2 * t); // smoothstep
    const step = () => {
      const now = performance.now();
      const t = Math.min(1, (now - t0) / dur);
      const k = ease(t);

      cam.position.lerpVectors(fromPos, toPos, k);
      cam.quaternion.copy(fromQuat);
      cam.quaternion.slerp(toQuat, k);
      // Keep up vector trending toward target up for numerical stability
      cam.up.lerpVectors(fromUp, up, k);
      cam.updateMatrixWorld(true);

      if (controls && controls.updateMatrixState) controls.updateMatrixState();

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        // Ensure final exact values
        cam.position.copy(toPos);
        cam.quaternion.copy(toQuat);
        cam.up.copy(up);
        cam.updateMatrixWorld(true);
        if (controls) { controls.enabled = true; if (controls.update) controls.update(); }
      }
    };
    requestAnimationFrame(step);
  }
}
