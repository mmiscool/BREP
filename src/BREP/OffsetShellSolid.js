import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import manifold from './setupManifold.js';
import { Solid } from './BetterSolid.js';

const { Manifold } = manifold;

export class OffsetShellSolid extends Solid {
  /**
   * @param {Solid} sourceSolid The solid to offset.
   */
  constructor(sourceSolid) {
    super();
    if (!sourceSolid || typeof sourceSolid._manifoldize !== 'function') {
      throw new Error('OffsetShellSolid requires a valid Solid instance.');
    }
    this.sourceSolid = sourceSolid;
  }

  /**
   * Run the offset operation against the provided source solid.
   * @param {number} distance Signed offset distance.
   * @returns {Solid} New solid representing the offset shell.
   */
  run(distance) {
    return OffsetShellSolid.generate(this.sourceSolid, distance);
  }

  /**
   * Static convenience to perform the offset without instantiating the helper.
   * @param {Solid} sourceSolid Solid to offset.
   * @param {number} distance Signed offset distance.
   * @returns {Solid} New solid representing the offset shell.
   */
  static generate(sourceSolid, distance, options = {}) {
    if (!sourceSolid || typeof sourceSolid._manifoldize !== 'function') {
      throw new Error('OffsetShellSolid.generate requires a valid Solid.');
    }

    const dist = Number(distance);
    if (!Number.isFinite(dist) || dist === 0) return sourceSolid.clone();

    const {
      newSolidName = `${sourceSolid.name || 'Solid'}_${Math.abs(dist)}`,
      featureId = 'OffsetShell',
    } = options;

    const positionsRaw = Array.isArray(sourceSolid._vertProperties)
      ? sourceSolid._vertProperties
      : (sourceSolid._vertProperties ? Array.from(sourceSolid._vertProperties) : []);
    const indicesRaw = Array.isArray(sourceSolid._triVerts)
      ? sourceSolid._triVerts
      : (sourceSolid._triVerts ? Array.from(sourceSolid._triVerts) : []);

    if (positionsRaw.length === 0 || indicesRaw.length === 0) {
      return sourceSolid.clone();
    }

    const triIDsRaw = Array.isArray(sourceSolid._triIDs)
      ? sourceSolid._triIDs
      : (sourceSolid._triIDs ? Array.from(sourceSolid._triIDs) : []);
    const idToFaceName = sourceSolid._idToFaceName instanceof Map
      ? sourceSolid._idToFaceName
      : new Map();

    let geometry = null;
    let bvh = null;
    try {
      const positions = new Float32Array(positionsRaw);
      const triVerts = new Uint32Array(indicesRaw);
      const triVertsOriginal = triVerts.slice();

      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(triVerts, 1));
      geometry.computeBoundingBox();

      const bbox = geometry.boundingBox;
      const diag = bbox ? bbox.max.clone().sub(bbox.min).length() : 1;
      const basePad = Math.max(diag * 0.05, 1e-3);
      const bounds = { min: [0, 0, 0], max: [0, 0, 0] };
      const bboxMin = [
        bbox?.min.x ?? 0,
        bbox?.min.y ?? 0,
        bbox?.min.z ?? 0,
      ];
      const bboxMax = [
        bbox?.max.x ?? 0,
        bbox?.max.y ?? 0,
        bbox?.max.z ?? 0,
      ];

      for (let i = 0; i < 3; i++) {
        if (dist >= 0) {
          const grow = Math.abs(dist) + basePad;
          bounds.min[i] = bboxMin[i] - grow;
          bounds.max[i] = bboxMax[i] + grow;
        } else {
          const inset = Math.abs(dist);
          const pad = Math.max(1e-4, Math.min(basePad * 0.1, inset * 0.05));
          bounds.min[i] = bboxMin[i] + inset - pad;
          bounds.max[i] = bboxMax[i] - inset + pad;
          if (bounds.min[i] > bounds.max[i]) {
            const mid = (bboxMin[i] + bboxMax[i]) * 0.5;
            bounds.min[i] = mid - pad;
            bounds.max[i] = mid + pad;
          }
        }
      }

      const faceCount = triVerts.length / 3;
      let faceNormals = new Float32Array(faceCount * 3);
      const vA = new THREE.Vector3();
      const vB = new THREE.Vector3();
      const vC = new THREE.Vector3();
      const tmp = new THREE.Vector3();
      for (let f = 0; f < faceCount; f++) {
        const ia = triVertsOriginal[f * 3] * 3;
        const ib = triVertsOriginal[f * 3 + 1] * 3;
        const ic = triVertsOriginal[f * 3 + 2] * 3;
        vA.set(positions[ia], positions[ia + 1], positions[ia + 2]);
        vB.set(positions[ib], positions[ib + 1], positions[ib + 2]);
        vC.set(positions[ic], positions[ic + 1], positions[ic + 2]);
        tmp.subVectors(vB, vA).cross(vC.clone().sub(vA));
        if (tmp.lengthSq() === 0) {
          faceNormals[f * 3 + 0] = 0;
          faceNormals[f * 3 + 1] = 0;
          faceNormals[f * 3 + 2] = 0;
        } else {
          tmp.normalize();
          faceNormals[f * 3 + 0] = tmp.x;
          faceNormals[f * 3 + 1] = tmp.y;
          faceNormals[f * 3 + 2] = tmp.z;
        }
      }

      bvh = new MeshBVH(geometry, { lazyGeneration: false });
      const query = new THREE.Vector3();
      const normal = new THREE.Vector3();
      const ray = new THREE.Ray();
      const rayDir = new THREE.Vector3(1, 0.372, 0.529).normalize();
      const rayTmp = new THREE.Vector3();
      const triangle = new THREE.Triangle();

      let triFaceNames = new Array(faceCount);
      for (let t = 0; t < faceCount; t++) {
        const id = triIDsRaw[t] ?? 0;
        const faceName = idToFaceName.get(id) || `${sourceSolid.name || 'Solid'}_FACE_${id}`;
        triFaceNames[t] = faceName;
      }
      try {
        const indexAttr = geometry.getIndex();
        const mutatedIndex = indexAttr?.array;
        if (mutatedIndex && mutatedIndex !== triVertsOriginal) {
          const keyFor = (a, b, c) => {
            const arr = [a, b, c];
            arr.sort((x, y) => x - y);
            return `${arr[0]}/${arr[1]}/${arr[2]}`;
          };
          const originalKeyToIndex = new Map();
          for (let t = 0; t < faceCount; t++) {
            const i0 = triVertsOriginal[t * 3 + 0];
            const i1 = triVertsOriginal[t * 3 + 1];
            const i2 = triVertsOriginal[t * 3 + 2];
            originalKeyToIndex.set(keyFor(i0, i1, i2), t);
          }
          const remap = new Uint32Array(faceCount);
          let remapNeeded = false;
          for (let t = 0; t < faceCount; t++) {
            const i0 = mutatedIndex[t * 3 + 0];
            const i1 = mutatedIndex[t * 3 + 1];
            const i2 = mutatedIndex[t * 3 + 2];
            const key = keyFor(i0, i1, i2);
            const orig = originalKeyToIndex.get(key);
            remap[t] = (orig != null) ? orig : t;
            if (remap[t] !== t) remapNeeded = true;
          }
          if (remapNeeded) {
            const remappedNormals = new Float32Array(faceCount * 3);
            const remappedNames = new Array(faceCount);
            for (let t = 0; t < faceCount; t++) {
              const src = remap[t];
              remappedNormals[t * 3 + 0] = faceNormals[src * 3 + 0];
              remappedNormals[t * 3 + 1] = faceNormals[src * 3 + 1];
              remappedNormals[t * 3 + 2] = faceNormals[src * 3 + 2];
              remappedNames[t] = triFaceNames[src];
            }
            faceNormals = remappedNormals;
            triFaceNames = remappedNames;
          }
        }
      } catch (_) { /* remap best-effort */ }

      const tupleToXYZ = (vec) => {
        if (vec && typeof vec === 'object') {
          if (Array.isArray(vec)) return [vec[0] ?? 0, vec[1] ?? 0, vec[2] ?? 0];
          return [vec.x ?? 0, vec.y ?? 0, vec.z ?? 0];
        }
        return [0, 0, 0];
      };

      const pointInside = (point) => {
        let hits = 0;
        ray.origin.copy(point).addScaledVector(rayDir, 1e-6);
        ray.direction.copy(rayDir);
        bvh.shapecast({
          intersectsBounds: (box) => ray.intersectsBox(box),
          intersectsTriangle: (tri) => {
            triangle.a.copy(tri.a);
            triangle.b.copy(tri.b);
            triangle.c.copy(tri.c);
            const hit = ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, rayTmp);
            if (hit) hits++;
            return false;
          },
        });
        return (hits & 1) === 1;
      };

      const signedDistance = (vec) => {
        const [x, y, z] = tupleToXYZ(vec);
        query.set(x, y, z);
        const closest = bvh.closestPointToPoint(query);
        if (!closest) return Number.NEGATIVE_INFINITY;
        const fi = closest.faceIndex ?? -1;
        if (fi >= 0) {
          normal.set(
            faceNormals[fi * 3],
            faceNormals[fi * 3 + 1],
            faceNormals[fi * 3 + 2]
          );
        } else {
          normal.set(0, 0, 0);
        }
        if (normal.lengthSq() === 0) {
          const idx = (fi >= 0 ? fi : 0) * 3;
          const ia = triVerts[idx] * 3;
          const ib = triVerts[idx + 1] * 3;
          const ic = triVerts[idx + 2] * 3;
          vA.set(positions[ia], positions[ia + 1], positions[ia + 2]);
          vB.set(positions[ib], positions[ib + 1], positions[ib + 2]);
          vC.set(positions[ic], positions[ic + 1], positions[ic + 2]);
          normal.subVectors(vB, vA).cross(vC.clone().sub(vA)).normalize();
        }
        const d = closest.distance ?? 0;
        if (d < 1e-9) return dist >= 0 ? -d : d;
        const inside = pointInside(query);
        return inside ? d : -d;
      };

      const edgeLength = Math.max(
        Math.abs(dist) / 2,
        diag / 120,
        1e-3
      );
      let target = Manifold.levelSet(
        (vec) => signedDistance(vec),
        bounds,
        edgeLength,
        -dist
      );

      const targetMesh = target.getMesh();
      const out = new Solid();
      out.name = newSolidName;

      const tPositions = targetMesh.vertProperties;
      const tTriVerts = targetMesh.triVerts;
      const triOutCount = (tTriVerts.length / 3) | 0;
      const vert = new THREE.Vector3();
      const centroid = new THREE.Vector3();

      const closestInfo = { point: new THREE.Vector3(), faceIndex: -1, distance: 0 };
      const faceNormalTmp = new THREE.Vector3();
      const offsetTmp = new THREE.Vector3();

      const getFaceInfoForPoint = (point) => {
        const closest = bvh.closestPointToPoint(point, closestInfo);
        if (!closest || closest.faceIndex == null || closest.faceIndex < 0) return null;
        const faceIndex = closest.faceIndex;
        const name = triFaceNames[faceIndex] || null;
        if (!name) return null;

        const idx = faceIndex * 3;
        faceNormalTmp.set(
          faceNormals[idx],
          faceNormals[idx + 1],
          faceNormals[idx + 2]
        );
        if (faceNormalTmp.lengthSq() === 0) {
          const ia = triVerts[idx] * 3;
          const ib = triVerts[idx + 1] * 3;
          const ic = triVerts[idx + 2] * 3;
          vA.set(positions[ia], positions[ia + 1], positions[ia + 2]);
          vB.set(positions[ib], positions[ib + 1], positions[ib + 2]);
          vC.set(positions[ic], positions[ic + 1], positions[ic + 2]);
          faceNormalTmp.subVectors(vB, vA).cross(vC.clone().sub(vA));
        }
        if (faceNormalTmp.lengthSq() > 0) faceNormalTmp.normalize();

        let offsetAlignment = 0;
        if (closest.point) {
          offsetTmp.copy(point).sub(closest.point);
          const len = offsetTmp.length();
          if (len > 1e-9) {
            offsetAlignment = offsetTmp.multiplyScalar(1 / len).dot(faceNormalTmp);
          }
        }

        return {
          name,
          distance: closest.distance ?? 0,
          faceIndex,
          offsetAlignment,
        };
      };

      const faceBuckets = new Map();
      const getFaceKey = (names) => names.join('+');

      const triNormal = new THREE.Vector3();
      const triNormalUnit = new THREE.Vector3();
      const closestNormal = new THREE.Vector3();
      const probePoint = new THREE.Vector3();

      for (let t = 0; t < triOutCount; t++) {
        const i0 = tTriVerts[t * 3 + 0] * 3;
        const i1 = tTriVerts[t * 3 + 1] * 3;
        const i2 = tTriVerts[t * 3 + 2] * 3;

        const p0 = [tPositions[i0], tPositions[i0 + 1], tPositions[i0 + 2]];
        const p1 = [tPositions[i1], tPositions[i1 + 1], tPositions[i1 + 2]];
        const p2 = [tPositions[i2], tPositions[i2 + 1], tPositions[i2 + 2]];

        centroid.set(
          (p0[0] + p1[0] + p2[0]) / 3,
          (p0[1] + p1[1] + p2[1]) / 3,
          (p0[2] + p1[2] + p2[2]) / 3
        );

        triNormal.set(
          (p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1]),
          (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]),
          (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])
        );
        const triNormalLenSq = triNormal.lengthSq();
        const triNormalHasDirection = triNormalLenSq > 1e-18;
        if (triNormalHasDirection) {
          const triNormalLen = Math.sqrt(triNormalLenSq);
          if (triNormalLen > 0) {
            triNormalUnit.copy(triNormal).multiplyScalar(1 / triNormalLen);
          } else {
            triNormalUnit.set(0, 0, 0);
          }
        } else {
          triNormalUnit.set(0, 0, 0);
        }

        const contributions = [];
        let centroidInfo = null;
        const addContribution = (info) => {
          if (!info || !info.name) return;
          contributions.push(info);
        };

        vert.set(p0[0], p0[1], p0[2]); addContribution(getFaceInfoForPoint(vert));
        vert.set(p1[0], p1[1], p1[2]); addContribution(getFaceInfoForPoint(vert));
        vert.set(p2[0], p2[1], p2[2]); addContribution(getFaceInfoForPoint(vert));
        centroidInfo = getFaceInfoForPoint(centroid);
        addContribution(centroidInfo);

        const counts = new Map();
        for (const info of contributions) {
          if (!info || !info.name) continue;
          const entry = counts.get(info.name) || {
            count: 0,
            minDist: Infinity,
            faceIndex: null,
            offsetAlignSum: 0,
            offsetAlignSamples: 0
          };
          entry.count += 1;
          const distance = info.distance ?? Infinity;
          if (distance < entry.minDist) {
            entry.minDist = distance;
            if (typeof info.faceIndex === 'number') entry.faceIndex = info.faceIndex;
          } else if (entry.faceIndex == null && typeof info.faceIndex === 'number') {
            entry.faceIndex = info.faceIndex;
          }
          if (Number.isFinite(info.offsetAlignment)) {
            entry.offsetAlignSum += info.offsetAlignment;
            entry.offsetAlignSamples += 1;
          }
          counts.set(info.name, entry);
        }

        let entries = Array.from(counts.entries()).map(([name, entry]) => ({
          name,
          count: entry.count,
          minDist: entry.minDist,
          faceIndex: entry.faceIndex,
          triAlign: (() => {
            if (!triNormalHasDirection || entry.faceIndex == null || entry.faceIndex < 0) return 0;
            const idx = entry.faceIndex * 3;
            closestNormal.set(
              faceNormals[idx],
              faceNormals[idx + 1],
              faceNormals[idx + 2]
            );
            if (closestNormal.lengthSq() === 0) return 0;
            closestNormal.normalize();
            return triNormalUnit.dot(closestNormal);
          })(),
          offsetAlign: (() => {
            if (!entry || !entry.offsetAlignSamples) return 0;
            return entry.offsetAlignSum / entry.offsetAlignSamples;
          })(),
        }));

        if (entries.length === 0) entries = [{
          name: 'OFFSET',
          count: 1,
          minDist: 0,
          faceIndex: null,
          triAlign: 0,
          offsetAlign: 0
        }];

        const distSign = dist >= 0 ? 1 : -1;
        for (const entry of entries) {
          entry.triAlignScore = entry.triAlign;
          entry.triAlignAbs = Math.abs(entry.triAlign);
          entry.offsetAlignScore = entry.offsetAlign * distSign;
        }

        let selected = [];
        let raySelected = null;
        if (triNormalHasDirection) {
          probePoint.copy(centroid);
          const rayOrigin = probePoint;
          const rayLength = Math.abs(dist) + diag * 0.1;
          const hitFaces = [];
          const raycast = ray.clone();
          raycast.origin.copy(rayOrigin);
          raycast.direction.copy(triNormalUnit).negate();
          bvh.shapecast({
            intersectsBounds: (box) => (box && box.min && box.max) ? raycast.intersectsBox(box) : true,
            intersectsTriangle: (tri) => {
              const hitPoint = raycast.intersectTriangle(tri.a, tri.b, tri.c, true, rayTmp);
              if (!hitPoint) return false;
              const hitDist = hitPoint.distanceTo(rayOrigin);
              if (hitDist > rayLength) return false;
              const idx = tri.faceIndex ?? tri.face;
              const fname = (idx != null && idx >= 0) ? triFaceNames[idx] : null;
              if (!fname) return false;
              let alignScore = -Infinity;
              if (idx != null && idx >= 0) {
                const nIdx = idx * 3;
                closestNormal.set(
                  faceNormals[nIdx],
                  faceNormals[nIdx + 1],
                  faceNormals[nIdx + 2]
                );
                if (closestNormal.lengthSq() === 0) {
                  closestNormal.subVectors(tri.b, tri.a).cross(tri.c.clone().sub(tri.a));
                }
                if (closestNormal.lengthSq() > 0) {
                  closestNormal.normalize();
                  alignScore = triNormalUnit.dot(closestNormal);
                }
              }
              hitFaces.push({ name: fname, distance: hitDist, alignScore });
              return true;
            }
          });
          if (hitFaces.length) {
            hitFaces.sort((a, b) => {
              const distDelta = Math.abs(a.distance - Math.abs(dist)) - Math.abs(b.distance - Math.abs(dist));
              if (Math.abs(distDelta) > 1e-6) return distDelta;
              return (b.alignScore ?? -Infinity) - (a.alignScore ?? -Infinity);
            });
            const bestHit = hitFaces.find((hit) => (hit.alignScore ?? -Infinity) > 0.05) || hitFaces[0];
            if (bestHit && (bestHit.alignScore ?? 0) > -0.2) {
              raySelected = bestHit.name;
              selected = [bestHit.name];
            }
          }
        }

        if (selected.length) {
          const matching = entries.find((entry) => entry.name === selected[0]);
          if (matching && matching.triAlignScore < -0.15) {
            selected.length = 0;
          }
        }

        const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
        if (centroidInfo && centroidInfo.name) {
          const centroidEntry = entriesByName.get(centroidInfo.name);
          if (centroidEntry) {
            selected = [centroidEntry.name];
          }
        }

        if (selected.length === 0 && entries.length) {
          entries.sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            if (b.triAlignScore !== a.triAlignScore) return b.triAlignScore - a.triAlignScore;
            if (b.triAlignAbs !== a.triAlignAbs) return b.triAlignAbs - a.triAlignAbs;
            if (b.offsetAlignScore !== a.offsetAlignScore) return b.offsetAlignScore - a.offsetAlignScore;
            if (a.minDist !== b.minDist) return a.minDist - b.minDist;
            return a.name.localeCompare(b.name);
          });

          const primary = entries[0];
          const alignmentThreshold = 0.35;
          if (primary && primary.triAlignScore >= alignmentThreshold) {
            selected.push(primary.name);
          } else {
            for (const entry of entries) {
              if (!entry || !entry.name) continue;
              if (selected.includes(entry.name)) continue;
              if (entry.triAlignScore < -0.2) continue;
              selected.push(entry.name);
              if (selected.length >= 2) break;
            }
            if (!selected.length && primary && primary.triAlignAbs >= 0.25) {
              selected.push(primary.name);
            }
          }
        }

        if (!selected.length) selected.push('OFFSET');

        const uniqueSelected = [];
        for (const name of selected) {
          if (!name) continue;
          if (!uniqueSelected.includes(name)) uniqueSelected.push(name);
        }

        const hasNamedFace = uniqueSelected.some((name) => name && name !== 'OFFSET');
        if (hasNamedFace) {
          const offsetIndex = uniqueSelected.indexOf('OFFSET');
          if (offsetIndex >= 0) uniqueSelected.splice(offsetIndex, 1);
        }

        if (uniqueSelected.length > 2) {
          const ranked = uniqueSelected
            .map((name) => entries.find((e) => e.name === name) || {
              name,
              count: 0,
              triAlignScore: -Infinity,
              triAlignAbs: 0,
              offsetAlignScore: -Infinity,
              minDist: Infinity
            })
            .sort((a, b) => {
              if (b.count !== a.count) return b.count - a.count;
              if (b.triAlignScore !== a.triAlignScore) return b.triAlignScore - a.triAlignScore;
              if (b.triAlignAbs !== a.triAlignAbs) return b.triAlignAbs - a.triAlignAbs;
              if (b.offsetAlignScore !== a.offsetAlignScore) return b.offsetAlignScore - a.offsetAlignScore;
              if (a.minDist !== b.minDist) return a.minDist - b.minDist;
              return a.name.localeCompare(b.name);
            });
          uniqueSelected.length = 0;
          for (let i = 0; i < ranked.length && uniqueSelected.length < 2; i++) {
            uniqueSelected.push(ranked[i].name);
          }
        }

        const sortedFaces = (uniqueSelected.length ? uniqueSelected : ['OFFSET']).sort();
        const key = getFaceKey(sortedFaces.length ? sortedFaces : ['OFFSET']);
        let bucket = faceBuckets.get(key);
        if (!bucket) {
          bucket = { name: `${newSolidName}_${key}`, tris: [] };
          faceBuckets.set(key, bucket);
        }
        bucket.tris.push([p0, p1, p2]);
      }

      for (const bucket of faceBuckets.values()) {
        for (const tri of bucket.tris) {
          out.addTriangle(bucket.name, tri[0], tri[1], tri[2]);
        }
      }

      // Cull tiny disconnected islands created by grid artifacts
      const triOutTotal = (out._triVerts.length / 3) | 0;
      if (triOutTotal > 0) {
        const threshold = Math.max(8, Math.round(triOutTotal * 0.01));
        try {
          out.removeSmallIslands({
            maxTriangles: threshold,
            removeInternal: true,
            removeExternal: true,
          });
        } catch (_) { /* best effort */ }
      }

      out._faceMetadata = new Map(sourceSolid._faceMetadata);
      out._auxEdges = Array.isArray(sourceSolid._auxEdges) ? [...sourceSolid._auxEdges] : [];

      try { if (targetMesh && typeof targetMesh.delete === 'function') targetMesh.delete(); } catch { }
      try { if (typeof target.delete === 'function') target.delete(); } catch { }
      return out;
    } finally {
      try { geometry?.dispose?.(); } catch { }
      try { if (bvh && typeof bvh.dispose === 'function') bvh.dispose(); } catch { }
    }
  }
}
