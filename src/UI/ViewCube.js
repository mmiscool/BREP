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
  constructor({ renderer, targetCamera, controls = null, size = 110, margin = 10, colors = null } = {}) {
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

    // Visual cube (subtle base)
    const baseGeom = new THREE.BoxGeometry(1, 1, 1);
    const baseMat = new THREE.MeshBasicMaterial({ color: 0x9a9a9a, opacity: 0.18, transparent: true });
    const baseMesh = new THREE.Mesh(baseGeom, baseMat);
    this.root.add(baseMesh);

    // Edges for contrast
    try {
      const edges = new THREE.EdgesGeometry(baseGeom);
      const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff }));
      this.root.add(line);
    } catch { }

    // Small helpers for color + label texture
    const hexToRgb = (hex) => ({ r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 });
    const relLuma = (hex) => {
      const { r, g, b } = hexToRgb(hex);
      const s = [r, g, b].map(v => v / 255);
      const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      const [R, G, B] = s.map(lin);
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    // Convert a CSS color or hex-int to a normalized css hex string and hex-int
    const toCssAndHex = (input) => {
      let css = '#ffffff';
      if (typeof input === 'number') {
        css = `#${input.toString(16).padStart(6, '0')}`;
      } else if (typeof input === 'string') {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 1;
          const ctx2 = c.getContext('2d');
          ctx2.fillStyle = '#000';
          ctx2.fillStyle = input; // lets canvas parse CSS colors
          const val = ctx2.fillStyle; // canonical string
          if (typeof val === 'string') {
            if (val.startsWith('#')) {
              // #rgb, #rrggbb, or #rrggbbaa
              let hex = val.replace('#', '');
              if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
              else if (hex.length === 8) hex = hex.slice(0, 6);
              css = `#${hex.toLowerCase()}`;
            } else {
              // rgb/rgba(r,g,b[,a])
              const m = val.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\)/i);
              if (m) {
                const r = Math.max(0, Math.min(255, parseInt(m[1], 10)));
                const g = Math.max(0, Math.min(255, parseInt(m[2], 10)));
                const b = Math.max(0, Math.min(255, parseInt(m[3], 10)));
                const hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
                css = `#${hex}`;
              }
            }
          }
        } catch { }
      }
      const hex = parseInt(css.slice(1), 16) & 0xffffff;
      return { css, hex };
    };

    // Create a texture with the face color and imprinted label
    const makeFaceTexture = (text, faceColor) => {
      const size = 512; // square to avoid distortion on a square plane
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Background fill
      const { css: faceCss, hex: faceHex } = toCssAndHex(faceColor);
      ctx.fillStyle = faceCss;
      ctx.fillRect(0, 0, size, size);
      // Imprinted text effect: shadow + highlight to look engraved
      const fontSize = 100; // smaller labels for better balance
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const cx = size / 2, cy = size / 2;
      const luma = relLuma(faceHex);
      const baseText = luma < 0.45 ? '#f0f0f0' : '#111111';
      const shadow = luma < 0.45 ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)';
      const highlight = luma < 0.45 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.55)';
      // Soft inner shadow (dark offset)
      ctx.fillStyle = shadow;
      ctx.fillText(text, cx + 3, cy + 3);
      // Highlight edge (light offset)
      ctx.fillStyle = highlight;
      ctx.fillText(text, cx - 1, cy - 1);
      // Base text color chosen for contrast
      ctx.fillStyle = baseText;
      ctx.fillText(text, cx, cy);
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      return tex;
    };

    // Helper: distance from origin so a plane with normal from {0,±1}^3 passes through cube boundary
    const planeOffsetForMask = (maskVec) => {
      const k = Math.abs(maskVec.x) + Math.abs(maskVec.y) + Math.abs(maskVec.z); // 1, 2 or 3
      return 0.5 * Math.sqrt(k);
    };

    // Face planes for picking + labels (main 6 faces)
    const mkFace = (dir, color, name) => {
      const g = new THREE.PlaneGeometry(0.98, 0.98);
      const m = new THREE.MeshBasicMaterial({ map: makeFaceTexture(name, color), side: THREE.FrontSide });
      const p = new THREE.Mesh(g, m);
      // place at distance where face coincides with cube side (0.5)
      const off = planeOffsetForMask(dir);
      const n = dir.clone().normalize();
      p.position.copy(n.multiplyScalar(off));
      // orient plane to face outward
      const q = new THREE.Quaternion();
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
      p.quaternion.copy(q);
      p.userData = { dir: dir.clone().normalize(), name };
      p.renderOrder = 1; // draw on top of base box
      this.pickGroup.add(p);

      return p;
    };

    // Dark-mode friendly distinct colors for the 6 faces
    // Accept any CSS color string or hex. You can override via constructor
    // with { colors: { faces: { RIGHT: 'tomato', ... }, edge: '...', corner: '...' } }
    const FACE_DEFAULTS = {
      RIGHT: '#ff0000',
      LEFT: '#0055ffff',
      TOP: '#00ff77ff',
      BOTTOM: '#ffb300ff',
      FRONT: '#ff00b7ff',
      BACK: '#00ffe5ff',
    };
    let faceOverrides = {};
    if (colors) {
      if (colors.faces) faceOverrides = colors.faces;
      else if (colors.RIGHT || colors.LEFT || colors.TOP || colors.BOTTOM || colors.FRONT || colors.BACK) faceOverrides = colors;
    }
    const FACE = Object.assign({}, FACE_DEFAULTS, faceOverrides);

    // Edge/corner colors (define before creating materials)
    const EDGE_COLOR = (colors && colors.edge) || '#ffffffff';
    const CORNER_COLOR = (colors && colors.corner) || '#3a3636ff';
    const EDGE_COLOR_CSS = toCssAndHex(EDGE_COLOR).css;
    const CORNER_COLOR_CSS = toCssAndHex(CORNER_COLOR).css;
    mkFace(new THREE.Vector3(1, 0, 0), FACE.RIGHT, 'RIGHT');
    mkFace(new THREE.Vector3(-1, 0, 0), FACE.LEFT, 'LEFT');
    mkFace(new THREE.Vector3(0, 1, 0), FACE.TOP, 'TOP');
    mkFace(new THREE.Vector3(0, -1, 0), FACE.BOTTOM, 'BOTTOM');
    mkFace(new THREE.Vector3(0, 0, 1), FACE.FRONT, 'FRONT');
    mkFace(new THREE.Vector3(0, 0, -1), FACE.BACK, 'BACK');

    // Edge faces (12) — beveled rectangles to mimic chamfered edges
    const mkEdge = (normalMask, along, name) => {
      const n = normalMask.clone().normalize();
      const u = along.clone().normalize(); // width axis on the plane (edge direction)
      const v = new THREE.Vector3().crossVectors(n, u).normalize();
      const matBasis = new THREE.Matrix4().makeBasis(u, v, n);
      const q = new THREE.Quaternion().setFromRotationMatrix(matBasis);
      const g = new THREE.PlaneGeometry(0.98, 0.16);
      const m = new THREE.MeshBasicMaterial({ color: EDGE_COLOR_CSS, opacity: 1.0, transparent: false, side: THREE.FrontSide });
      const mesh = new THREE.Mesh(g, m);
      mesh.quaternion.copy(q);
      const off = planeOffsetForMask(normalMask);
      mesh.position.copy(n.clone().multiplyScalar(off));
      mesh.userData = { dir: n.clone(), name };
      mesh.renderOrder = 2;
      this.pickGroup.add(mesh);
      return mesh;
    };

    // X± Y± edges -> along Z
    mkEdge(new THREE.Vector3(1, 1, 0), new THREE.Vector3(0, 0, 1), 'TOP RIGHT EDGE');
    mkEdge(new THREE.Vector3(-1, 1, 0), new THREE.Vector3(0, 0, 1), 'TOP LEFT EDGE');
    mkEdge(new THREE.Vector3(1, -1, 0), new THREE.Vector3(0, 0, 1), 'BOTTOM RIGHT EDGE');
    mkEdge(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(0, 0, 1), 'BOTTOM LEFT EDGE');

    // X± Z± edges -> along Y
    mkEdge(new THREE.Vector3(1, 0, 1), new THREE.Vector3(0, 1, 0), 'FRONT RIGHT EDGE');
    mkEdge(new THREE.Vector3(-1, 0, 1), new THREE.Vector3(0, 1, 0), 'FRONT LEFT EDGE');
    mkEdge(new THREE.Vector3(1, 0, -1), new THREE.Vector3(0, 1, 0), 'BACK RIGHT EDGE');
    mkEdge(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(0, 1, 0), 'BACK LEFT EDGE');

    // Y± Z± edges -> along X
    mkEdge(new THREE.Vector3(0, 1, 1), new THREE.Vector3(1, 0, 0), 'TOP FRONT EDGE');
    mkEdge(new THREE.Vector3(0, -1, 1), new THREE.Vector3(1, 0, 0), 'BOTTOM FRONT EDGE');
    mkEdge(new THREE.Vector3(0, 1, -1), new THREE.Vector3(1, 0, 0), 'TOP BACK EDGE');
    mkEdge(new THREE.Vector3(0, -1, -1), new THREE.Vector3(1, 0, 0), 'BOTTOM BACK EDGE');

    // Corner knobs for isometric views (clickable)
    // Slightly protruding spheres at cube corners, each maps to a diagonal view
    const mkCorner = (dirMask, color, name) => {
      const n = dirMask.clone().normalize();
      // Triangular disk to resemble a chamfered corner
      const g = new THREE.CircleGeometry(0.14, 3);
      const m = new THREE.MeshBasicMaterial({ color: CORNER_COLOR_CSS, opacity: 1.0, transparent: false, side: THREE.FrontSide });
      const tri = new THREE.Mesh(g, m);
      // Build basis so X axis is some stable vector in the plane
      let u = new THREE.Vector3(0, 1, 0);
      if (Math.abs(n.dot(u)) > 0.9) u = new THREE.Vector3(1, 0, 0); // avoid parallel
      u = new THREE.Vector3().crossVectors(u, n).normalize();
      const v = new THREE.Vector3().crossVectors(n, u).normalize();
      const matBasis = new THREE.Matrix4().makeBasis(u, v, n);
      const q = new THREE.Quaternion().setFromRotationMatrix(matBasis);
      tri.quaternion.copy(q);
      const off = planeOffsetForMask(dirMask);
      tri.position.copy(n.clone().multiplyScalar(off));
      tri.userData = { dir: n, name };
      tri.renderOrder = 3;
      this.pickGroup.add(tri);
      return tri;
    };

    // Define all 8 corners with readable names
    const C = (x, y, z) => new THREE.Vector3(x, y, z);
    mkCorner(C(1, 1, 1), CORNER_COLOR, 'TOP FRONT RIGHT');
    mkCorner(C(-1, 1, 1), CORNER_COLOR, 'TOP FRONT LEFT');
    mkCorner(C(1, 1, -1), CORNER_COLOR, 'TOP BACK RIGHT');
    mkCorner(C(-1, 1, -1), CORNER_COLOR, 'TOP BACK LEFT');
    mkCorner(C(1, -1, 1), CORNER_COLOR, 'BOTTOM FRONT RIGHT');
    mkCorner(C(-1, -1, 1), CORNER_COLOR, 'BOTTOM FRONT LEFT');
    mkCorner(C(1, -1, -1), CORNER_COLOR, 'BOTTOM BACK RIGHT');
    mkCorner(C(-1, -1, -1), CORNER_COLOR, 'BOTTOM BACK LEFT');

    // Soft ambient to ensure steady colors regardless of renderer state
    const amb = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(amb);

    // Raycaster for cube picking
    this._raycaster = new THREE.Raycaster();
  }

  // Keep cube orientation in sync with target camera
  syncWithCamera() {
    if (!this.targetCamera) return;
    // Use the inverse of the target camera's rotation so the widget
    // represents world orientation as seen from the camera (avoids mirroring).
    this.root.quaternion.copy(this.targetCamera.quaternion).invert();
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
    const nx = ((cx - xCss) / w) * 2 - 1;
    const ny = -((cy - yCss) / h) * 2 + 1;
    const ndc = new THREE.Vector2(nx, ny);

    this._raycaster.setFromCamera(ndc, this.camera);
    const intersects = this._raycaster.intersectObjects(this.pickGroup.children, false);
    if (intersects && intersects.length) {
      const face = intersects[0].object;
      const dir = face?.userData?.dir;
      const name = face?.userData?.name || '';
      if (dir) this._reorientCamera(dir, name);
      return true;
    }
    return false;
  }

  _reorientCamera(dir, faceName = '') {
    const cam = this.targetCamera;
    if (!cam) return;

    // Determine current pivot (ArcballControls center) and keep distance to it
    const pivot = (this.controls && this.controls._gizmos && this.controls._gizmos.position)
      ? this.controls._gizmos.position.clone()
      : new THREE.Vector3(0, 0, 0);
    const dist = cam.position.distanceTo(pivot) || cam.position.length() || 10;
    const pos = pivot.clone().add(dir.clone().normalize().multiplyScalar(dist));

    // Choose a stable up vector for the final view
    const useZup = Math.abs(dir.y) > 0.9; // top/bottom -> Z up to avoid roll
    const up = useZup ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);

    const toPos = pos;

    // Immediate reorientation: absolute pose using lookAt toward pivot
    cam.position.copy(toPos);
    cam.up.copy(up);
    cam.lookAt(pivot);
    cam.updateMatrixWorld(true);

    // Sync controls to the new absolute state
    const controls = this.controls;
    if (controls && controls.updateMatrixState) {
      try { controls.updateMatrixState(); } catch { }
    }
    if (controls) controls.enabled = true;
  }
}
