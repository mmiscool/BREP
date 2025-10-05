import * as THREE from 'three';

export function makeOverlayLine(a, b, color = 0x93c5fd) {
  const geom = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
  const mat = new THREE.LineBasicMaterial({ color });
  mat.depthTest = false; mat.depthWrite = false; mat.transparent = true;
  return new THREE.Line(geom, mat);
}

export function makeOverlayDashedLine(a, b, color = 0x93c5fd, options = {}) {
  const { viewer = null, dashPixels = 10, gapPixels = 10 } = options || {};
  const len = a.distanceTo(b);
  if (!(len > 1e-6)) return makeOverlayLine(a, b, color);

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

  if (points.length < 2) return makeOverlayLine(a, b, color);

  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color });
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

export function makeOverlaySphere(size, color = 0xffffff) {
  const g = new THREE.SphereGeometry(size, 12, 8);
  const m = new THREE.MeshBasicMaterial({ color });
  m.depthTest = false; m.depthWrite = false; m.transparent = true;
  return new THREE.Mesh(g, m);
}

export function addArrowCone(group, tip, direction, arrowLength, arrowWidth, color) {
  try {
    const coneGeometry = new THREE.ConeGeometry(arrowWidth, arrowLength, 8);
    const coneMaterial = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
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
