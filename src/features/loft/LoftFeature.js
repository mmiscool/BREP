import { BREP } from "../../BREP/BREP.js";
const THREE = BREP.THREE;

const inputParamsSchema = {
  featureID: {
    type: "string",
    default_value: null,
    hint: "unique identifier for the loft feature",
  },
  profiles: {
    type: "reference_selection",
    selectionFilter: ["SKETCH", "FACE"],
    multiple: true,
    default_value: [],
    hint: "Select 2+ profiles (faces) to loft",
  },
  guideCurves: {
    type: "reference_selection",
    selectionFilter: ["EDGE"],
    multiple: true,
    default_value: [],
    hint: "Optional guide curves (unused)",
  },
  loftType: {
    type: "options",
    options: ["normal"],
    default_value: "normal",
    hint: "Type of loft to create",
  },
  boolean: {
    type: "boolean_operation",
    default_value: { targets: [], operation: 'NONE' },
    hint: "Optional boolean operation with selected solids"
  }
};

export class LoftFeature {
  static featureShortName = "LOFT";
  static featureName = "Loft";
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  async run(partHistory) {
    const { profiles } = this.inputParams;
    if (!Array.isArray(profiles) || profiles.length < 2) {
      console.warn("LoftFeature: select at least two profiles (faces or sketches)");
      return [];
    }

    // Resolve input names to FACE objects; allow SKETCH that contains a FACE
    const faces = [];
    const removed = [];
    for (const obj of profiles) {
      if (!obj) continue;
      let faceObj = obj;
      if (obj && obj.type === 'SKETCH') {
        faceObj = obj.children.find(ch => ch.type === 'FACE') || obj.children.find(ch => ch.userData?.faceName);
      }
      if (faceObj && faceObj.type === 'FACE') {
        // If face came from a sketch, mark sketch for removal (structured)
        if (faceObj.parent && faceObj.parent.type === 'SKETCH') removed.push(faceObj.parent);
        faces.push(faceObj);
      }
    }

    if (faces.length < 2) {
      console.warn("LoftFeature: need at least two resolved FACE objects");
      return [];
    }

    // Build a sidewall naming map using ONLY the first face's edge names
    const firstFace = faces[0];
    const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;
    const pointToEdgeNames = new Map(); // key -> Set(edgeName)
    const seedEdgePoint = (edgeName, arrP) => {
      for (const p of arrP) {
        const k = key(p);
        let set = pointToEdgeNames.get(k);
        if (!set) { set = new Set(); pointToEdgeNames.set(k, set); }
        set.add(edgeName);
      }
    };
    const collectEdgePolylineWorld = (edge) => {
      const out = [];
      const cached = edge?.userData?.polylineLocal;
      const isWorld = !!(edge?.userData?.polylineWorld);
      const v = new THREE.Vector3();
      if (Array.isArray(cached) && cached.length >= 2) {
        if (isWorld) return cached.map(p => [p[0], p[1], p[2]]);
        for (const p of cached) { v.set(p[0], p[1], p[2]).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]); }
        return out;
      }
      const posAttr = edge?.geometry?.getAttribute?.('position');
      if (posAttr && posAttr.itemSize === 3 && posAttr.count >= 2) {
        for (let i = 0; i < posAttr.count; i++) { v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]); }
        return out;
      }
      const aStart = edge?.geometry?.attributes?.instanceStart;
      const aEnd = edge?.geometry?.attributes?.instanceEnd;
      if (aStart && aEnd && aStart.itemSize === 3 && aEnd.itemSize === 3 && aStart.count === aEnd.count && aStart.count >= 1) {
        v.set(aStart.getX(0), aStart.getY(0), aStart.getZ(0)).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]);
        for (let i = 0; i < aEnd.count; i++) { v.set(aEnd.getX(i), aEnd.getY(i), aEnd.getZ(i)).applyMatrix4(edge.matrixWorld); out.push([v.x, v.y, v.z]); }
        return out;
      }
      return out;
    };
    const edges0 = Array.isArray(firstFace?.edges) ? firstFace.edges : [];
    for (const e of edges0) {
      const name = e?.name || 'EDGE'; // use raw edge name from first face
      const pts = collectEdgePolylineWorld(e);
      if (pts.length >= 2) seedEdgePoint(name, pts);
    }

    // Helper: unify loop form and cleanup
    const closeAndDedup = (pts) => {
      const pA = pts.slice();
      if (pA.length >= 2) {
        const first = pA[0], last = pA[pA.length - 1];
        if (!(first[0] === last[0] && first[1] === last[1] && first[2] === last[2])) pA.push([first[0], first[1], first[2]]);
      }
      for (let i = pA.length - 2; i >= 0; i--) {
        const a = pA[i], b = pA[i + 1];
        if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) pA.splice(i + 1, 1);
      }
      return pA;
    };

    const getLoops = (face) => {
      const loops = Array.isArray(face?.userData?.boundaryLoopsWorld) ? face.userData.boundaryLoopsWorld : null;
      if (loops && loops.length) return loops.map(l => ({ isHole: !!(l && l.isHole), pts: Array.isArray(l?.pts) ? l.pts : l }));
      // Fallback: approximate a single outer loop by concatenating edge polylines
      const edges = Array.isArray(face?.edges) ? face.edges : [];
      const poly = [];
      for (const e of edges) {
        const pts = collectEdgePolylineWorld(e);
        if (pts.length) poly.push(...pts);
      }
      return poly.length ? [{ isHole: false, pts: poly }] : [];
    };

    const solid = new BREP.Solid();
    solid.name = this.inputParams.featureID || 'Loft';

    // Caps on first and last faces
    const addCapFromFace = (face, capNamePrefix, reverseStart) => {
      const groups = Array.isArray(face?.userData?.profileGroups) ? face.userData.profileGroups : null;
      if (groups && groups.length) {
        for (const g of groups) {
          const contour2D = g.contour2D || [];
          const holes2D = g.holes2D || [];
          const contourW = g.contourW || [];
          const holesW = g.holesW || [];
          if (contour2D.length < 3 || contourW.length !== contour2D.length) continue;
          const contourV2 = contour2D.map(p => new THREE.Vector2(p[0], p[1]));
          const holesV2 = holes2D.map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
          const tris = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);
          const allW = contourW.concat(...holesW);
          for (const t of tris) {
            const p0 = allW[t[0]], p1 = allW[t[1]], p2 = allW[t[2]];
            if (reverseStart) solid.addTriangle(`${capNamePrefix}_START`, p0, p2, p1);
            else solid.addTriangle(`${capNamePrefix}_END`, p0, p1, p2);
          }
        }
      } else {
        const baseGeom = face.geometry;
        const posAttr = baseGeom?.getAttribute?.('position');
        if (posAttr) {
          const idx = baseGeom.getIndex();
          const hasIndex = !!idx;
          const v = new THREE.Vector3();
          const world = new Array(posAttr.count);
          for (let i = 0; i < posAttr.count; i++) { v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(face.matrixWorld); world[i] = [v.x, v.y, v.z]; }
          const addTri = (i0, i1, i2) => {
            const p0 = world[i0], p1 = world[i1], p2 = world[i2];
            if (reverseStart) solid.addTriangle(`${capNamePrefix}_START`, p0, p2, p1);
            else solid.addTriangle(`${capNamePrefix}_END`, p0, p1, p2);
          };
          if (hasIndex) { for (let i = 0; i < idx.count; i += 3) addTri(idx.getX(i+0)>>>0, idx.getX(i+1)>>>0, idx.getX(i+2)>>>0); }
          else { for (let t = 0; t < (posAttr.count/3|0); t++) addTri(3*t+0, 3*t+1, 3*t+2); }
        }
      }
    };

    // Add start and end caps
    addCapFromFace(faces[0], `${faces[0].name || 'Face'}`, true);
    addCapFromFace(faces[faces.length - 1], `${faces[faces.length - 1].name || 'Face'}`, false);

    // Side walls: connect loops between consecutive faces; name from first face's edges
    const loops0 = getLoops(faces[0]).map(l => ({ ...l, pts: closeAndDedup(l.pts) }));
    for (let i = 0; i < faces.length - 1; i++) {
      const A = faces[i];
      const B = faces[i + 1];
      const loopsA = getLoops(A).map(l => ({ ...l, pts: closeAndDedup(l.pts) }));
      const loopsB = getLoops(B).map(l => ({ ...l, pts: closeAndDedup(l.pts) }));
      const L = Math.min(loopsA.length, loopsB.length, loops0.length);
      for (let li = 0; li < L; li++) {
        const isHole = !!loopsA[li].isHole;
        const pA = loopsA[li].pts;
        const pB = loopsB[li].pts;
        const pRef = loops0[li].pts; // reference indices for naming
        const nA = pA.length, nB = pB.length, nR = pRef.length;
        // iterate over A segments; map indices to B and ref by proportional index
        for (let j = 0; j < nA - 1; j++) {
          const a0 = pA[j];
          const a1 = pA[j + 1];
          // proportional mapping
          const t0 = j / (nA - 1);
          const t1 = (j + 1) / (nA - 1);
          const jb0 = Math.max(0, Math.min(nB - 1, Math.round(t0 * (nB - 1))));
          const jb1 = Math.max(0, Math.min(nB - 1, Math.round(t1 * (nB - 1))));
          const b0 = pB[jb0];
          const b1 = pB[jb1];
          // reference points for naming
          const jr0 = Math.max(0, Math.min(nR - 1, Math.round(t0 * (nR - 1))));
          const jr1 = Math.max(0, Math.min(nR - 1, Math.round(t1 * (nR - 1))));
          const r0 = pRef[jr0];
          const r1 = pRef[jr1];

          // pick face name using first face edge names via point match on r0,r1
          const setA = pointToEdgeNames.get(key(r0));
          const setB = pointToEdgeNames.get(key(r1));
          let fname = `${firstFace.name || 'FACE'}_LF`;
          if (setA && setB) { for (const n of setA) { if (setB.has(n)) { fname = n; break; } } }

          // Skip degenerate segments
          const sameA = (a0[0]===a1[0] && a0[1]===a1[1] && a0[2]===a1[2]);
          const sameB = (b0[0]===b1[0] && b0[1]===b1[1] && b0[2]===b1[2]);
          if (sameA && sameB) continue;

          if (isHole) {
            solid.addTriangle(fname, a0, b1, b0);
            solid.addTriangle(fname, a0, a1, b1);
          } else {
            solid.addTriangle(fname, a0, a1, b1);
            solid.addTriangle(fname, a0, b1, b0);
          }
        }
      }
    }

    try { solid.setEpsilon(1e-6); } catch {}
    solid.visualize();
    const effects = await BREP.applyBooleanOperation(partHistory || {}, solid, this.inputParams.boolean, this.inputParams.featureID);
    // Flag removals (sketch parents + boolean effects)
    try { for (const obj of [...removed, ...effects.removed]) { if (obj) obj.remove = true; } } catch {}
    // Return only artifacts to add
    return effects.added || [];
  }
}
