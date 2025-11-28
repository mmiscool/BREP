import * as THREE from 'three';
import { getPMIStyle } from './pmiStyle.js';

function safeCloneJSON(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return {};
  }
}

function resolveCameraType(camera) {
  if (!camera) return 'Camera';
  if (camera.isPerspectiveCamera) return 'PerspectiveCamera';
  if (camera.isOrthographicCamera) return 'OrthographicCamera';
  return 'Camera';
}

function extractVector3(src) {
  if (!src) return null;
  if (Array.isArray(src) && src.length === 3) {
    return [Number(src[0]) || 0, Number(src[1]) || 0, Number(src[2]) || 0];
  }
  if (typeof src === 'object') {
    const { x, y, z } = src;
    if ([x, y, z].every((v) => Number.isFinite(v))) {
      return [x, y, z];
    }
  }
  return null;
}

function syncArcballControls(camera, controls, targetArray, snapshot, syncControls) {
  if (!controls) return;

  const storedState = snapshot?.controlsState;
  const hasState = storedState && typeof controls.setStateFromJSON === 'function';

  if (hasState) {
    const target = Array.isArray(storedState.target) ? storedState.target : targetArray;
    const arcState = {
      arcballState: {
        target: Array.isArray(target) ? target : [camera.target?.x || 0, camera.target?.y || 0, camera.target?.z || 0],
        cameraMatrix: { elements: Array.isArray(storedState.cameraMatrix) && storedState.cameraMatrix.length === 16 ? storedState.cameraMatrix : Array.from(camera.matrix.elements) },
        cameraUp: storedState.cameraUp || { x: camera.up.x, y: camera.up.y, z: camera.up.z },
        cameraNear: Number.isFinite(storedState.cameraNear) ? storedState.cameraNear : camera.near,
        cameraFar: Number.isFinite(storedState.cameraFar) ? storedState.cameraFar : camera.far,
        cameraZoom: Number.isFinite(storedState.cameraZoom) ? storedState.cameraZoom : camera.zoom,
        gizmoMatrix: { elements: Array.isArray(storedState.gizmoMatrix) && storedState.gizmoMatrix.length === 16 ? storedState.gizmoMatrix : Array.from((controls._gizmos?.matrix || new THREE.Matrix4()).elements) },
      }
    };
    const fov = Number.isFinite(storedState.cameraFov) ? storedState.cameraFov : snapshot?.projection?.fov;
    if (camera.isPerspectiveCamera && Number.isFinite(fov)) {
      arcState.arcballState.cameraFov = fov;
    }

    try {
      controls.setStateFromJSON(JSON.stringify(arcState));
    } catch (err) {
      console.warn('ArcballControls setStateFromJSON failed; falling back to manual sync', err);
      manualArcballSync(camera, controls, targetArray, snapshot);
      finalizeArcballSync(controls, syncControls);
      return;
    }

    finalizeArcballSync(controls, syncControls);
    return;
  }

  manualArcballSync(camera, controls, targetArray, snapshot);
  finalizeArcballSync(controls, syncControls);
}

function manualArcballSync(camera, controls, targetArray, snapshot) {
  const safeTarget = Array.isArray(targetArray) && targetArray.length === 3
    ? targetArray
    : (controls.target ? [controls.target.x, controls.target.y, controls.target.z] : [0, 0, 0]);

  const targetVector = new THREE.Vector3(safeTarget[0], safeTarget[1], safeTarget[2]);

  try {
    if (typeof controls.setTarget === 'function') {
      controls.setTarget(targetVector.x, targetVector.y, targetVector.z);
    } else if (controls.target?.set) {
      controls.target.set(targetVector.x, targetVector.y, targetVector.z);
    } else if (controls.target) {
      controls.target.x = targetVector.x;
      controls.target.y = targetVector.y;
      controls.target.z = targetVector.z;
    }
  } catch {}

  try {
    if (controls._currentTarget?.copy) controls._currentTarget.copy(targetVector);
    if (controls._target0?.copy) controls._target0.copy(targetVector);
  } catch {}

  const gizmos = controls._gizmos;
  if (gizmos) {
    try {
      gizmos.position.copy(targetVector);
      gizmos.updateMatrix();
      gizmos.updateMatrixWorld(true);
    } catch {}
    if (typeof controls.calculateTbRadius === 'function') {
      try { controls._tbRadius = controls.calculateTbRadius(camera); } catch {}
    }
    if (typeof controls.makeGizmos === 'function') {
      try { controls.makeGizmos(targetVector, controls._tbRadius || 1); } catch {}
    }
  }

  try {
    controls._cameraMatrixState?.copy?.(camera.matrix);
    controls._cameraMatrixState0?.copy?.(camera.matrix);
    if (gizmos?.matrix) {
      controls._gizmoMatrixState?.copy?.(gizmos.matrix);
      controls._gizmoMatrixState0?.copy?.(gizmos.matrix);
    }
    controls._cameraProjectionState?.copy?.(camera.projectionMatrix);
    if (typeof controls._zoomState === 'number') controls._zoomState = camera.zoom;
    if (typeof controls._zoom0 === 'number') controls._zoom0 = camera.zoom;
    if (typeof controls._fovState === 'number' && Number.isFinite(snapshot?.projection?.fov ?? camera.fov)) {
      controls._fovState = snapshot?.projection?.fov ?? camera.fov;
    }
    if (typeof controls._fov0 === 'number' && Number.isFinite(snapshot?.projection?.fov ?? camera.fov)) {
      controls._fov0 = snapshot?.projection?.fov ?? camera.fov;
    }
    if (typeof controls._nearPos === 'number') controls._nearPos = Number.isFinite(snapshot?.near) ? snapshot.near : camera.near;
    if (typeof controls._farPos === 'number') controls._farPos = Number.isFinite(snapshot?.far) ? snapshot.far : camera.far;
    controls._up0?.copy?.(camera.up);
  } catch {}

  try {
    if (typeof controls.updateTbState === 'function' && controls.STATE?.IDLE) {
      controls.updateTbState(controls.STATE.IDLE, false);
    } else if ('_state' in controls && controls.STATE?.IDLE) {
      controls._state = controls.STATE.IDLE;
    }
  } catch {}
}

function finalizeArcballSync(controls, syncControls) {
  try {
    if (typeof controls._animationId === 'number' && controls._animationId !== -1) {
      const cancel = typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame
        : (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
          ? window.cancelAnimationFrame.bind(window)
          : null);
      if (cancel) cancel(controls._animationId);
    }
    controls._animationId = -1;
    if (typeof controls._timeStart === 'number') controls._timeStart = -1;
  } catch {}

  try { controls.updateMatrixState?.(); } catch {}
  if (syncControls) {
    try { controls.update?.(); } catch {}
  }
}

function captureProjection(camera) {
  if (!camera) return null;
  if (camera.isPerspectiveCamera) {
    const view = camera.view && camera.view.enabled ? {
      enabled: true,
      fullWidth: camera.view.fullWidth,
      fullHeight: camera.view.fullHeight,
      offsetX: camera.view.offsetX,
      offsetY: camera.view.offsetY,
      width: camera.view.width,
      height: camera.view.height,
    } : { enabled: false };
    return {
      kind: 'perspective',
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
      zoom: camera.zoom ?? 1,
      filmGauge: camera.filmGauge ?? 35,
      filmOffset: camera.filmOffset ?? 0,
      view,
    };
  }

  if (camera.isOrthographicCamera) {
    const view = camera.view && camera.view.enabled ? {
      enabled: true,
      fullWidth: camera.view.fullWidth,
      fullHeight: camera.view.fullHeight,
      offsetX: camera.view.offsetX,
      offsetY: camera.view.offsetY,
      width: camera.view.width,
      height: camera.view.height,
    } : { enabled: false };
    return {
      kind: 'orthographic',
      left: camera.left,
      right: camera.right,
      top: camera.top,
      bottom: camera.bottom,
      near: camera.near,
      far: camera.far,
      zoom: camera.zoom ?? 1,
      view,
    };
  }

  return {
    kind: 'generic',
    near: camera.near ?? 0.1,
    far: camera.far ?? 2000,
  };
}

function applyProjection(camera, projection, overrideAspect = null) {
  if (!camera || !projection) return;

  if (camera.isPerspectiveCamera && projection.kind === 'perspective') {
    if (Number.isFinite(projection.fov)) camera.fov = projection.fov;
    if (Number.isFinite(projection.near)) camera.near = projection.near;
    if (Number.isFinite(projection.far)) camera.far = projection.far;
    if (Number.isFinite(projection.zoom)) camera.zoom = projection.zoom;
    if (Number.isFinite(projection.filmGauge)) camera.filmGauge = projection.filmGauge;
    if (Number.isFinite(projection.filmOffset)) camera.filmOffset = projection.filmOffset;
    if (overrideAspect != null && Number.isFinite(overrideAspect)) {
      camera.aspect = overrideAspect;
    }
    if (projection.view && projection.view.enabled && camera.setViewOffset) {
      camera.setViewOffset(
        projection.view.fullWidth,
        projection.view.fullHeight,
        projection.view.offsetX,
        projection.view.offsetY,
        projection.view.width,
        projection.view.height,
      );
    } else if (camera.clearViewOffset) {
      camera.clearViewOffset();
    }
    return;
  }

  if (camera.isOrthographicCamera && projection.kind === 'orthographic') {
    const keys = ['left', 'right', 'top', 'bottom', 'near', 'far', 'zoom'];
    for (const key of keys) {
      if (Number.isFinite(projection[key])) {
        camera[key] = projection[key];
      }
    }
    if (projection.view && projection.view.enabled && camera.setViewOffset) {
      camera.setViewOffset(
        projection.view.fullWidth,
        projection.view.fullHeight,
        projection.view.offsetX,
        projection.view.offsetY,
        projection.view.width,
        projection.view.height,
      );
    } else if (camera.clearViewOffset) {
      camera.clearViewOffset();
    }
    return;
  }

  if (Number.isFinite(projection.near)) camera.near = projection.near;
  if (Number.isFinite(projection.far)) camera.far = projection.far;
  if (Number.isFinite(projection.zoom)) camera.zoom = projection.zoom;
}

export function captureCameraSnapshot(camera, { controls = null } = {}) {
  if (!camera || !camera.isCamera) return null;
  try { camera.updateMatrixWorld(true); } catch {}

  const snapshot = {
    version: 2,
    type: resolveCameraType(camera),
    worldMatrix: camera.matrixWorld?.toArray?.() ?? null,
    projection: captureProjection(camera),
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    quaternion: { x: camera.quaternion.x, y: camera.quaternion.y, z: camera.quaternion.z, w: camera.quaternion.w },
    up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
    zoom: Number.isFinite(camera.zoom) ? camera.zoom : 1,
    near: Number.isFinite(camera.near) ? camera.near : undefined,
    far: Number.isFinite(camera.far) ? camera.far : undefined,
  };

  if (camera.layers?.mask !== undefined) {
    snapshot.layers = camera.layers.mask;
  }

  if (controls?.target && typeof controls.target === 'object') {
    snapshot.target = {
      x: controls.target.x,
      y: controls.target.y,
      z: controls.target.z,
    };
    try {
      const gizmoMatrix = controls._gizmos?.matrix;
      if (gizmoMatrix) {
        snapshot.controlsState = {
          target: [controls.target.x, controls.target.y, controls.target.z],
          cameraMatrix: Array.from(camera.matrix.elements),
          cameraUp: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
          cameraNear: camera.near,
          cameraFar: camera.far,
          cameraZoom: camera.zoom,
          cameraFov: camera.isPerspectiveCamera ? camera.fov : undefined,
          gizmoMatrix: Array.from(gizmoMatrix.elements),
        };
      }
    } catch {
      // ignore controls state capture errors
    }
  }

  if (!snapshot.target && camera.target && typeof camera.target === 'object') {
    snapshot.target = {
      x: camera.target.x,
      y: camera.target.y,
      z: camera.target.z,
    };
  }

  if (camera.userData && typeof camera.userData === 'object') {
    snapshot.userData = safeCloneJSON(camera.userData);
  }

  return snapshot;
}

export function applyCameraSnapshot(camera, inputSnapshot, {
  controls = null,
  respectParent = true,
  strictType = false,
  overrideAspect = null,
  syncControls = true,
  viewport = null,
} = {}) {
  if (!camera || !camera.isCamera || !inputSnapshot) return false;

  let snapshot = inputSnapshot;
  if (typeof snapshot === 'string') {
    try { snapshot = JSON.parse(snapshot); } catch { return false; }
  }
  if (!snapshot || typeof snapshot !== 'object') return false;

  const srcType = snapshot.type || null;
  if (strictType && srcType) {
    const tgtType = resolveCameraType(camera);
    if (srcType !== tgtType) {
      return false;
    }
  }

  try {
    applyProjection(camera, snapshot.projection, overrideAspect);
  } catch {}

  adjustOrthographicFrustum(camera, snapshot?.projection, viewport);

  if (typeof snapshot.layers === 'number' && camera.layers) {
    camera.layers.mask = snapshot.layers;
  }

  const upVector = extractVector3(snapshot.up) || extractVector3(snapshot.upVector);
  if (upVector) {
    camera.up.set(upVector[0], upVector[1], upVector[2]);
  }

  if (snapshot.userData && typeof snapshot.userData === 'object') {
    camera.userData = safeCloneJSON(snapshot.userData);
  }

  let appliedTransform = false;
  let success = false;
  const matrixArray = Array.isArray(snapshot.worldMatrix) && snapshot.worldMatrix.length === 16
    ? snapshot.worldMatrix
    : null;

  if (matrixArray) {
    try {
      const worldMatrix = new THREE.Matrix4().fromArray(matrixArray);
      const parent = camera.parent || null;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();

      if (respectParent && parent) {
        parent.updateMatrixWorld?.(true);
        const parentInv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
        const localMatrix = new THREE.Matrix4().multiplyMatrices(parentInv, worldMatrix);
        localMatrix.decompose(pos, quat, scl);
      } else {
        worldMatrix.decompose(pos, quat, scl);
      }

      const prevAuto = camera.matrixAutoUpdate;
      camera.matrixAutoUpdate = false;
      camera.position.copy(pos);
      camera.quaternion.copy(quat);
      camera.scale.copy(scl);
      camera.updateMatrix();
      camera.updateMatrixWorld(true);
      camera.matrixAutoUpdate = prevAuto;
      appliedTransform = true;
      success = true;
    } catch {
      appliedTransform = false;
    }
  }

  if (!appliedTransform) {
    const pos = extractVector3(snapshot.position);
    let legacyApplied = false;
    if (pos) {
      camera.position.set(pos[0], pos[1], pos[2]);
      legacyApplied = true;
    }
    const quat = snapshot.quaternion;
    if (quat && typeof quat === 'object') {
      const { x, y, z, w } = quat;
      if ([x, y, z, w].every((v) => Number.isFinite(v))) {
        camera.quaternion.set(x, y, z, w);
        legacyApplied = true;
      }
    }
    if (Number.isFinite(snapshot.zoom)) {
      camera.zoom = snapshot.zoom;
      legacyApplied = true;
    }
    if (Number.isFinite(snapshot.near)) {
      camera.near = snapshot.near;
      legacyApplied = true;
    }
    if (Number.isFinite(snapshot.far)) {
      camera.far = snapshot.far;
      legacyApplied = true;
    }
    if (legacyApplied) {
      camera.updateMatrixWorld?.(true);
      success = true;
    }
  }

  if (!success) {
    try { camera.updateProjectionMatrix?.(); } catch {}
    if (controls) {
      try { controls.update?.(); } catch {}
      try { controls.updateMatrixState?.(); } catch {}
    }
    return false;
  }

  try { camera.updateProjectionMatrix?.(); } catch {}

  const target = snapshot.target || snapshot.controlsTarget;
  const targetArr = extractVector3(target);

  if (controls) {
    syncArcballControls(camera, controls, targetArr, snapshot, syncControls);
  } else if (targetArr && camera.target && typeof camera.target.set === 'function') {
    camera.target.set(targetArr[0], targetArr[1], targetArr[2]);
  }

  return true;
}

export function adjustOrthographicFrustum(camera, projection = null, viewport = null) {
  try {
    if (!camera?.isOrthographicCamera) return;

    const proj = projection || {};

    const top = Number.isFinite(proj.top) ? proj.top : camera.top;
    const bottom = Number.isFinite(proj.bottom) ? proj.bottom : camera.bottom;
    const left = Number.isFinite(proj.left) ? proj.left : camera.left;
    const right = Number.isFinite(proj.right) ? proj.right : camera.right;

    const spanY = (Number.isFinite(top) && Number.isFinite(bottom)) ? (top - bottom) : (camera.top - camera.bottom);
    if (!Number.isFinite(spanY) || Math.abs(spanY) < 1e-9) return;

    const centerY = (Number.isFinite(top) && Number.isFinite(bottom)) ? (top + bottom) * 0.5 : (camera.top + camera.bottom) * 0.5;
    const centerX = (Number.isFinite(left) && Number.isFinite(right)) ? (left + right) * 0.5 : (camera.left + camera.right) * 0.5;

    let aspect = (Number.isFinite(left) && Number.isFinite(right)) ? (right - left) / spanY : (camera.right - camera.left) / spanY;
    const vpW = viewport && Number.isFinite(viewport.width) ? viewport.width : null;
    const vpH = viewport && Number.isFinite(viewport.height) ? viewport.height : null;
    if (vpW && vpH && vpH > 0) {
      aspect = vpW / vpH;
    }
    if (!Number.isFinite(aspect) || aspect <= 1e-9) aspect = 1;

    const halfHeight = spanY * 0.5;
    const halfWidth = halfHeight * aspect;

    camera.top = centerY + halfHeight;
    camera.bottom = centerY - halfHeight;
    camera.left = centerX - halfWidth;
    camera.right = centerX + halfWidth;
    camera.updateProjectionMatrix();
  } catch {}
}

export function makeOverlayLine(a, b, color = undefined) {
  const style = getPMIStyle();
  const resolvedColor = (color == null) ? (style.lineColor ?? 0x93c5fd) : color;
  const geom = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
  const mat = new THREE.LineBasicMaterial({ color: resolvedColor, linewidth: style.lineWidth || 1 });
  mat.depthTest = false; mat.depthWrite = false; mat.transparent = true;
  return new THREE.Line(geom, mat);
}

export function makeOverlayDashedLine(a, b, color = undefined, options = {}) {
  const style = getPMIStyle();
  const { viewer = null, dashPixels = 10, gapPixels = 10 } = options || {};
  const len = a.distanceTo(b);
  if (!(len > 1e-6)) return makeOverlayLine(a, b, color ?? style.lineColor ?? 0x93c5fd);

  const dir = b.clone().sub(a).normalize();
  const midPoint = a.clone().add(b).multiplyScalar(0.5);
  const wpp = worldUnitsPerPixelAtPoint(viewer, midPoint);
  const dashLen = clampDashLength(wpp * dashPixels, len);
  const gapLen = clampGapLength(wpp * gapPixels, len);

  const points = [];
  let travelled = 0;
  let cursor = a.clone();

  while (travelled < len - 1e-6) {
    const dashSegment = Math.min(dashLen, len - travelled);
    const dashEnd = cursor.clone().addScaledVector(dir, dashSegment);
    points.push(cursor.clone(), dashEnd.clone());
    travelled += dashSegment;
    if (travelled >= len) break;
    const gapSegment = Math.min(gapLen, len - travelled);
    cursor = dashEnd.clone().addScaledVector(dir, gapSegment);
    travelled += gapSegment;
  }

  if (points.length < 2) return makeOverlayLine(a, b, color ?? style.lineColor ?? 0x93c5fd);

  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color: (color == null) ? (style.lineColor ?? 0x93c5fd) : color, linewidth: style.lineWidth || 1 });
  mat.depthTest = false; mat.depthWrite = false; mat.transparent = true;
  const line = new THREE.LineSegments(geom, mat);
  line.renderOrder = 9994;
  return line;
}

function worldUnitsPerPixelAtPoint(viewer, point) {
  try {
    const camera = viewer?.camera;
    const renderer = viewer?.renderer;
    if (!camera || !renderer) return 0.01;
    const dom = renderer.domElement;
    const height = Math.max(1, dom?.clientHeight || dom?.height || 600);

    if (camera.isOrthographicCamera) {
      const span = (camera.top - camera.bottom) / Math.max(1e-6, camera.zoom || 1);
      return span / height;
    }

    const camPos = camera.getWorldPosition(new THREE.Vector3());
    const target = point ? point.clone() : camera.getWorldDirection(new THREE.Vector3()).add(camPos);
    const dist = camPos.distanceTo(target);
    const fov = (camera.fov || 50) * Math.PI / 180;
    return 2 * Math.tan(fov / 2) * dist / height;
  } catch {
    return 0.01;
  }
}

function clampDashLength(value, totalLength) {
  if (!Number.isFinite(value) || value <= 0) return totalLength * 0.25;
  const maxDash = Math.max(1e-4, totalLength * 0.5);
  return Math.max(1e-4, Math.min(value, maxDash));
}

function clampGapLength(value, totalLength) {
  if (!Number.isFinite(value) || value < 0) return totalLength * 0.25;
  const maxGap = Math.max(1e-4, totalLength * 0.5);
  return Math.max(1e-4, Math.min(value, maxGap));
}

export function makeOverlaySphere(size, color = undefined) {
  const style = getPMIStyle();
  const resolvedColor = (color == null) ? (style.dotColor ?? 0xffffff) : color;
  const g = new THREE.SphereGeometry(size, 12, 8);
  const m = new THREE.MeshBasicMaterial({ color: resolvedColor });
  m.depthTest = false; m.depthWrite = false; m.transparent = true;
  return new THREE.Mesh(g, m);
}

export function addArrowCone(group, tip, direction, arrowLength, arrowWidth, color) {
  try {
    const style = getPMIStyle();
    const coneGeometry = new THREE.ConeGeometry(arrowWidth, arrowLength, 8);
    const coneMaterial = new THREE.MeshBasicMaterial({ color: (color == null) ? (style.arrowColor ?? 0x93c5fd) : color, depthTest: false, depthWrite: false, transparent: true });
    const arrowCone = new THREE.Mesh(coneGeometry, coneMaterial);
    const conePosition = tip.clone().addScaledVector(direction, -arrowLength * 0.5);
    arrowCone.position.copy(conePosition);
    const upVector = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion();
    quaternion.setFromUnitVectors(upVector, direction.clone().normalize());
    arrowCone.setRotationFromQuaternion(quaternion);
    arrowCone.renderOrder = 9996;
    group.add(arrowCone);
    return arrowCone;
  } catch { return null; }
}

export function screenSizeWorld(viewer, pixels = 1) {
  try {
    const rect = viewer?.renderer?.domElement?.getBoundingClientRect?.() || { width: 800, height: 600 };
    const cam = viewer?.camera;
    const h = Math.max(1, rect.height || 600);
    if (cam && cam.isOrthographicCamera) {
      const span = (cam.top - cam.bottom) / Math.max(1e-6, cam.zoom || 1);
      const wpp = span / h;
      return Math.max(1e-4, wpp * (pixels || 1));
    }
    // Fallback: approximate using distance and fov (perspective)
    if (cam && cam.isPerspectiveCamera) {
      const fovRad = (cam.fov || 50) * Math.PI / 180;
      const dist = cam.position.length();
      const span = 2 * Math.tan(fovRad / 2) * dist;
      const wpp = span / h;
      return Math.max(1e-4, wpp * (pixels || 1));
    }
    return 0.01 * (pixels || 1);
  } catch { return 0.01 * (pixels || 1); }
}

export function getElementDirection(viewer, obj) {
  try {
    if (!obj) return null;
    const userData = obj.userData || {};
    const objType = userData.type || userData.brepType || obj.type;
    if (objType === 'FACE') {
      if (typeof obj.getAverageNormal === 'function') {
        const localNormal = obj.getAverageNormal();
        obj.updateMatrixWorld(true);
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
        return localNormal.applyMatrix3(normalMatrix).normalize();
      }
      const geometry = obj.geometry;
      if (geometry) {
        if (geometry.attributes && geometry.attributes.normal) {
          const normals = geometry.attributes.normal.array;
          if (normals.length >= 3) {
            const avg = new THREE.Vector3();
            const count = normals.length / 3;
            for (let i = 0; i < count; i++) {
              const k = i * 3; avg.add(new THREE.Vector3(normals[k], normals[k + 1], normals[k + 2]));
            }
            avg.divideScalar(count);
            obj.updateMatrixWorld(true);
            const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
            return avg.applyMatrix3(normalMatrix).normalize();
          }
        }
        if (geometry.attributes && geometry.attributes.position) {
          const pos = geometry.attributes.position.array;
          if (pos.length >= 9) {
            const avg = new THREE.Vector3();
            let ct = 0; const p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), p3 = new THREE.Vector3();
            obj.updateMatrixWorld(true);
            const triCount = Math.min(5, Math.floor(pos.length / 9));
            for (let i = 0; i < triCount; i++) {
              const base = i * 9;
              if (base + 8 < pos.length) {
                p1.set(pos[base], pos[base + 1], pos[base + 2]).applyMatrix4(obj.matrixWorld);
                p2.set(pos[base + 3], pos[base + 4], pos[base + 5]).applyMatrix4(obj.matrixWorld);
                p3.set(pos[base + 6], pos[base + 7], pos[base + 8]).applyMatrix4(obj.matrixWorld);
                const n = p2.clone().sub(p1).cross(p3.clone().sub(p1));
                if (n.lengthSq() > 1e-10) { n.normalize(); avg.add(n); ct++; }
              }
            }
            if (ct > 0) return avg.divideScalar(ct).normalize();
          }
        }
      }
      const worldZ = new THREE.Vector3(0, 0, 1);
      obj.updateMatrixWorld(true);
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
      return worldZ.applyMatrix3(normalMatrix).normalize();
    } else if (objType === 'EDGE') {
      const geometry = obj.geometry;
      if (geometry && geometry.attributes && geometry.attributes.position) {
        const positions = geometry.attributes.position.array;
        if (positions.length >= 6) {
          const p1 = new THREE.Vector3(positions[0], positions[1], positions[2]);
          const p2 = new THREE.Vector3(positions[3], positions[4], positions[5]);
          obj.updateMatrixWorld(true);
          p1.applyMatrix4(obj.matrixWorld); p2.applyMatrix4(obj.matrixWorld);
          return p2.clone().sub(p1).normalize();
        }
      }
      const worldX = new THREE.Vector3(1, 0, 0);
      obj.updateMatrixWorld(true);
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(obj.matrixWorld);
      return worldX.applyMatrix3(normalMatrix).normalize();
    }
    return null;
  } catch { return null; }
}

export function objectRepresentativePoint(viewer, obj) {
  try {
    if (!obj) return null;
    const g = obj.geometry;
    if (g) {
      if (typeof obj.getWorldPosition === 'function') {
        const pos = g.attributes && g.attributes.position ? g.attributes.position.array : null;
        if (pos && pos.length >= 3) {
          let sx = 0, sy = 0, sz = 0, c = 0; const v = new THREE.Vector3();
          obj.updateMatrixWorld(true);
          for (let i = 0; i < pos.length; i += 3) { v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(obj.matrixWorld); sx += v.x; sy += v.y; sz += v.z; c++; }
          if (c > 0) return new THREE.Vector3(sx / c, sy / c, sz / c);
        }
      }
      g.computeBoundingBox?.();
      const bb = g.boundingBox; if (bb) return bb.getCenter(new THREE.Vector3()).applyMatrix4(obj.matrixWorld);
    }
    return obj.getWorldPosition(new THREE.Vector3());
  } catch { return null; }
}
