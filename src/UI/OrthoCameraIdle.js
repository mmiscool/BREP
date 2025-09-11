// OrthoCameraIdle.js
// ES6, no frameworks. three >= 0.150
// Usage example at bottom.

import { OrthographicCamera, Matrix4 } from 'three';

export class OrthoCameraIdle extends OrthographicCamera {
  constructor(left, right, top, bottom, near = 0.000000001, far = 200000000) {
    super(left, right, top, bottom, near, far);

    this._idle = {
      onIdle: null,
      onMove: null,
      idleMs: 250,
      matrixEpsilon: 1e-6,
      projEpsilon: 1e-6,
      controls: null,
      prevWorld: new Matrix4(),
      prevProj: new Matrix4(),
      lastChange: performance.now(),
      moving: false,
      raf: 0,
      disposed: true,
      _controlsHandler: this._handleControlsChange.bind(this)
    };

    this.updateMatrixWorld(true);
    this._idle.prevWorld.copy(this.matrixWorld);
    this._idle.prevProj.copy(this.projectionMatrix);
  }

  /**
   * Start watching for camera idle/move.
   * @param {Object} opts
   * @param {Function} opts.onIdle   - required
   * @param {Function} [opts.onMove] - optional
   * @param {number}   [opts.idleMs=250]
   * @param {number}   [opts.matrixEpsilon=1e-6]
   * @param {number}   [opts.projEpsilon=1e-6]
   * @param {Object}   [opts.controls] - ArcballControls instance
   */
  enableIdleCallbacks({
    onIdle,
    onMove = null,
    idleMs = 250,
    matrixEpsilon = 1e-6,
    projEpsilon = 1e-6,
    controls = null
  } = {}) {
    if (typeof onIdle !== 'function') {
      throw new Error('OrthoCameraIdle.enableIdleCallbacks: onIdle(callback) is required.');
    }

    const s = this._idle;
    this.disableIdleCallbacks(); // reset if already running

    s.onIdle = onIdle;
    s.onMove = typeof onMove === 'function' ? onMove : null;
    s.idleMs = idleMs;
    s.matrixEpsilon = matrixEpsilon;
    s.projEpsilon = projEpsilon;
    s.controls = controls || null;
    s.lastChange = performance.now();
    s.moving = false;
    s.disposed = false;

    if (s.controls && typeof s.controls.addEventListener === 'function') {
      s.controls.addEventListener('start', s._controlsHandler);
      s.controls.addEventListener('change', s._controlsHandler);
      s.controls.addEventListener('end', s._controlsHandler);
      s.controls.addEventListener('wheel', s._controlsHandler);
    }

    const loop = () => {
      if (s.disposed) return;
      const now = performance.now();

      // ensure matrices current
      this.updateMatrixWorld(true);

      // detect any change in world transform OR projection (covers zoom/frustum)
      let changed = this._matrixChanged(this.matrixWorld, s.prevWorld, s.matrixEpsilon);
      if (!changed) {
        changed = this._matrixChanged(this.projectionMatrix, s.prevProj, s.projEpsilon);
      }

      if (changed) {
        s.prevWorld.copy(this.matrixWorld);
        s.prevProj.copy(this.projectionMatrix);
        s.lastChange = now;
        if (!s.moving) {
          s.moving = true;
          if (s.onMove) s.onMove();
        }
      } else if (s.moving && (now - s.lastChange) >= s.idleMs) {
        s.moving = false;
        s.onIdle();
      }

      s.raf = requestAnimationFrame(loop);
    };

    s.raf = requestAnimationFrame(loop);
    return this;
  }

  /**
   * Stop watching and detach any listeners.
   */
  disableIdleCallbacks() {
    const s = this._idle;
    if (s.disposed) return this;
    s.disposed = true;
    cancelAnimationFrame(s.raf);
    if (s.controls && typeof s.controls.removeEventListener === 'function') {
      s.controls.removeEventListener('start', s._controlsHandler);
      s.controls.removeEventListener('change', s._controlsHandler);
      s.controls.removeEventListener('end', s._controlsHandler);
      s.controls.removeEventListener('wheel', s._controlsHandler);
    }
    s.controls = null;
    return this;
  }

  /**
   * Swap/attach ArcballControls at runtime (keeps callbacks/settings).
   */
  attachControls(controls) {
    const s = this._idle;
    s.controls = controls;
    if (!s.disposed) {
      // Rebind listeners cleanly
      this.disableIdleCallbacks();
      this.enableIdleCallbacks({
        onIdle: s.onIdle,
        onMove: s.onMove,
        idleMs: s.idleMs,
        matrixEpsilon: s.matrixEpsilon,
        projEpsilon: s.projEpsilon,
        controls
      });
    }
    return this;
  }

  setIdleThreshold(ms) { this._idle.idleMs = ms; return this; }
  setIdleEpsilon({ matrixEpsilon, projEpsilon } = {}) {
    if (typeof matrixEpsilon === 'number') this._idle.matrixEpsilon = matrixEpsilon;
    if (typeof projEpsilon === 'number') this._idle.projEpsilon = projEpsilon;
    return this;
  }
  setIdleCallbacks({ onIdle, onMove } = {}) {
    if (typeof onIdle === 'function') this._idle.onIdle = onIdle;
    if (typeof onMove === 'function' || onMove === null) this._idle.onMove = onMove;
    return this;
  }

  // --- internals ---
  _handleControlsChange() {
    const s = this._idle;
    if (s.disposed) return;
    s.lastChange = performance.now();
    if (!s.moving) {
      s.moving = true;
      if (s.onMove) s.onMove();
    }
  }

  _matrixChanged(a, b, eps) {
    const ae = a.elements, be = b.elements;
    // Quick translation check (12, 13, 14)
    if (Math.abs(ae[12] - be[12]) > eps) return true;
    if (Math.abs(ae[13] - be[13]) > eps) return true;
    if (Math.abs(ae[14] - be[14]) > eps) return true;
    // Remaining entries
    for (let i = 0; i < 12; i++) {
      if (Math.abs(ae[i] - be[i]) > eps) return true;
    }
    if (Math.abs(ae[15] - be[15]) > eps) return true;
    return false;
  }
}

/* ---------- Minimal usage ----------
import { WebGLRenderer } from 'three';
import { ArcballControls } from 'three/examples/jsm/controls/ArcballControls.js';
import { OrthoCameraIdle } from './OrthoCameraIdle.js';

const renderer = new WebGLRenderer({ antialias: true });
document.body.appendChild(renderer.domElement);

const cam = new OrthoCameraIdle(-2, 2, 2, -2, 0.1, 1000);
cam.position.set(5, 5, 5);
cam.lookAt(0, 0, 0);

const controls = new ArcballControls(cam, renderer.domElement);
controls.update();

cam.enableIdleCallbacks({
  controls,
  idleMs: 300,
  onMove: () => console.log('camera moving...'),
  onIdle: () => console.log('camera stopped.')
});
------------------------------------*/

