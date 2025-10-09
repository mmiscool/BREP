import * as THREE from 'three';
import { objectRepresentativePoint } from '../pmi/annUtils.js';

export function extractWorldPoint(object) {
  if (!object) return null;
  try { object.updateMatrixWorld?.(true); }
  catch { /* ignore */ }

  try {
    if (typeof object.type === 'string'
      && object.type.toUpperCase() === 'EDGE'
      && typeof object.points === 'function') {
      const pts = object.points(true);
      if (Array.isArray(pts) && pts.length) {
        const total = new THREE.Vector3();
        let count = 0;
        for (const pt of pts) {
          if (!pt) continue;
          const x = Number(pt.x);
          const y = Number(pt.y);
          const z = Number(pt.z);
          if ([x, y, z].some((v) => !Number.isFinite(v))) continue;
          total.add(new THREE.Vector3(x, y, z));
          count += 1;
        }
        if (count > 0) {
          total.divideScalar(count);
          return total;
        }
      }
    }
  } catch { /* ignore */ }

  try {
    const rep = objectRepresentativePoint?.(null, object);
    if (rep && typeof rep.clone === 'function') return rep.clone();
    if (rep && rep.isVector3) return rep.clone();
  } catch { /* ignore */ }

  try {
    if (typeof object.getWorldPosition === 'function') {
      return object.getWorldPosition(new THREE.Vector3());
    }
  } catch { /* ignore */ }

  try {
    if (object.isVector3) return object.clone();
  } catch { /* ignore */ }

  try {
    if (object.position) {
      const pos = object.position.clone
        ? object.position.clone()
        : new THREE.Vector3(object.position.x, object.position.y, object.position.z);
      if (object.parent?.matrixWorld) {
        object.parent.updateMatrixWorld?.(true);
        return pos.applyMatrix4(object.parent.matrixWorld);
      }
      return pos;
    }
  } catch { /* ignore */ }

  return null;
}
