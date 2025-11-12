import * as THREE_NS from 'three';

// Utility: compose a Matrix4 from TRS values where rotationEuler is in degrees.
// Accepts an optional THREE-like namespace; defaults to imported three.
export function composeTrsMatrixDeg(trs, THREE = THREE_NS) {
  const p = Array.isArray(trs?.position) ? trs.position : [0, 0, 0];
  const r = Array.isArray(trs?.rotationEuler) ? trs.rotationEuler : [0, 0, 0];
  const s = Array.isArray(trs?.scale) ? trs.scale : [1, 1, 1];
  const pos = new THREE.Vector3(
    Number(p[0] || 0),
    Number(p[1] || 0),
    Number(p[2] || 0)
  );
  const eul = new THREE.Euler(
    THREE.MathUtils.degToRad(Number(r[0] || 0)),
    THREE.MathUtils.degToRad(Number(r[1] || 0)),
    THREE.MathUtils.degToRad(Number(r[2] || 0)),
    'XYZ'
  );
  const quat = new THREE.Quaternion().setFromEuler(eul);
  const scl = new THREE.Vector3(
    Number(s[0] || 1),
    Number(s[1] || 1),
    Number(s[2] || 1)
  );
  return new THREE.Matrix4().compose(pos, quat, scl);
}

// Compose absolute transform matrix from a base (pos, quaternion, scale arrays)
// and a delta TRS where rotationEuler is degrees.
export function combineBaseWithDeltaDeg(base, delta, THREE = THREE_NS) {
  const basePos = new THREE.Vector3(
    Number(base?.position?.[0] || 0),
    Number(base?.position?.[1] || 0),
    Number(base?.position?.[2] || 0)
  );
  const baseQuat = new THREE.Quaternion().fromArray(
    Array.isArray(base?.quaternion) && base.quaternion.length >= 4
      ? base.quaternion
      : [0, 0, 0, 1]
  );
  const baseScale = new THREE.Vector3(
    Number(base?.scale?.[0] || 1),
    Number(base?.scale?.[1] || 1),
    Number(base?.scale?.[2] || 1)
  );
  const Mbase = new THREE.Matrix4().compose(basePos, baseQuat, baseScale);
  const Mdelta = composeTrsMatrixDeg(delta, THREE);
  return Mbase.multiply(Mdelta);
}

