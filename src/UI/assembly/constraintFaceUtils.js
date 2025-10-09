import * as THREE from 'three';
import { objectRepresentativePoint } from '../pmi/annUtils.js';

export function isFaceObject(object) {
  if (!object) return false;
  const type = object.userData?.type || object.userData?.brepType || object.type;
  return String(type).toUpperCase() === 'FACE';
}

export function computeFaceOrigin(object) {
  if (!object) return null;
  try {
    const pt = objectRepresentativePoint?.(null, object);
    if (pt && typeof pt.clone === 'function') return pt.clone();
  } catch { /* ignore */ }

  const geom = object.geometry;
  if (geom?.computeBoundingBox) {
    try {
      geom.computeBoundingBox();
      const center = geom.boundingBox?.getCenter(new THREE.Vector3());
      if (center) {
        object.updateMatrixWorld?.(true);
        return center.applyMatrix4(object.matrixWorld);
      }
    } catch { /* ignore */ }
  }

  if (typeof object.getWorldPosition === 'function') {
    try {
      return object.getWorldPosition(new THREE.Vector3());
    } catch { /* ignore */ }
  }

  return null;
}

export function computeFaceNormal(object) {
  if (!object) return null;
  try {
    if (typeof object.getAverageNormal === 'function') {
      const avg = object.getAverageNormal();
      if (avg && avg.lengthSq() > 1e-10) return avg.clone().normalize();
    }
  } catch { /* ignore */ }

  const geom = object.geometry;
  if (!geom?.isBufferGeometry) return null;
  const pos = geom.getAttribute?.('position');
  if (!pos || pos.itemSize !== 3 || pos.count < 3) return null;
  const index = geom.getIndex?.();

  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const accum = new THREE.Vector3();

  object.updateMatrixWorld?.(true);

  const triCount = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
  const samples = Math.min(triCount, 60);
  let count = 0;

  for (let tri = 0; tri < samples; tri += 1) {
    let i0;
    let i1;
    let i2;

    if (index) {
      const base = tri * 3;
      if (base + 2 >= index.count) break;
      i0 = index.getX(base);
      i1 = index.getX(base + 1);
      i2 = index.getX(base + 2);
    } else {
      i0 = tri * 3;
      i1 = i0 + 1;
      i2 = i0 + 2;
      if (i2 >= pos.count) break;
    }

    v0.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(object.matrixWorld);
    v1.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(object.matrixWorld);
    v2.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2)).applyMatrix4(object.matrixWorld);

    edge1.subVectors(v1, v0);
    edge2.subVectors(v2, v0);
    const normal = new THREE.Vector3().crossVectors(edge1, edge2);
    if (normal.lengthSq() > 1e-10) {
      accum.add(normal);
      count += 1;
    }
  }

  if (count === 0) return null;

  accum.divideScalar(count);
  if (accum.lengthSq() <= 1e-10) return null;

  return accum.normalize();
}

export function estimateArrowLength(object) {
  const geom = object?.geometry;
  if (geom?.computeBoundingSphere) {
    try {
      geom.computeBoundingSphere();
      const radius = geom.boundingSphere?.radius;
      if (Number.isFinite(radius) && radius > 0) return Math.max(radius, 10);
    } catch { /* ignore */ }
  }
  return 10;
}
