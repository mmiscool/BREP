import { BREP } from '../../BREP/BREP.js';

const inputParamsSchema = {
  id: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the hole feature',
  },
  face: {
    type: 'reference_selection',
    label: 'Placement (sketch or points)',
    selectionFilter: ['SKETCH', 'VERTEX'],
    multiple: true,
    minSelections: 1,
    default_value: [],
    hint: 'Select a sketch plane or 3+ points to place the hole',
  },
  holeType: {
    type: 'options',
    label: 'Hole type',
    options: ['SIMPLE', 'COUNTERSINK', 'COUNTERBORE'],
    default_value: 'SIMPLE',
    hint: 'Choose the hole style',
  },
  diameter: {
    type: 'number',
    label: 'Diameter',
    default_value: 6,
    min: 0,
    step: 0.1,
    hint: 'Straight hole diameter',
  },
  depth: {
    type: 'number',
    label: 'Depth',
    default_value: 10,
    min: 0,
    step: 0.1,
    hint: 'Straight portion depth (ignored when Through All)',
  },
  throughAll: {
    type: 'boolean',
    label: 'Through all',
    default_value: false,
    hint: 'Cut through the entire target thickness',
  },
  countersinkDiameter: {
    type: 'number',
    label: 'Countersink diameter',
    default_value: 10,
    min: 0,
    step: 0.1,
    hint: 'Major diameter of the countersink',
  },
  countersinkAngle: {
    type: 'number',
    label: 'Countersink angle (deg)',
    default_value: 82,
    min: 1,
    max: 179,
    step: 1,
    hint: 'Included angle of the countersink',
  },
  counterboreDiameter: {
    type: 'number',
    label: 'Counterbore diameter',
    default_value: 10,
    min: 0,
    step: 0.1,
    hint: 'Major diameter of the counterbore',
  },
  counterboreDepth: {
    type: 'number',
    label: 'Counterbore depth',
    default_value: 3,
    min: 0,
    step: 0.1,
    hint: 'Depth of the counterbore recess',
  },
  boolean: {
    type: 'boolean_operation',
    label: 'Boolean',
    default_value: { targets: [], operation: 'SUBTRACT' },
    hint: 'Targets to cut; defaults to the selected body',
  },
};

const THREE = BREP.THREE;

function fallbackVector(v, def = new THREE.Vector3()) {
  if (!v || typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') return def.clone();
  return new THREE.Vector3(v.x, v.y, v.z);
}

function buildBasisFromNormal(normal) {
  const up = fallbackVector(normal, new THREE.Vector3(0, 1, 0)).clone();
  if (up.lengthSq() < 1e-12) up.set(0, 1, 0);
  up.normalize();
  const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(ref, up);
  if (x.lengthSq() < 1e-12) x.set(1, 0, 0);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(up, x).normalize();
  const mat = new THREE.Matrix4();
  mat.makeBasis(x, up, z);
  return mat;
}

function boxDiagonalLength(obj) {
  try {
    const box = new THREE.Box3().setFromObject(obj);
    if (!box.isEmpty()) return box.getSize(new THREE.Vector3()).length();
  } catch {
    /* ignore */
  }
  return 0;
}

function unionSolids(solids) {
  if (!Array.isArray(solids) || solids.length === 0) return null;
  let current = solids[0];
  for (let i = 1; i < solids.length; i++) {
    const next = solids[i];
    if (!next) continue;
    try { current = current.union(next); }
    catch (error) { console.warn('[HoleFeature] Union failed:', error); }
  }
  return current;
}

function getWorldPosition(obj) {
  if (!obj) return null;
  if (obj.isVector3) return obj.clone();
  const out = new THREE.Vector3();
  if (typeof obj.getWorldPosition === 'function') {
    try { return obj.getWorldPosition(out); } catch { }
  }
  if (obj.position && typeof obj.position === 'object') {
    out.copy(obj.position);
    try {
      if (obj.matrixWorld && typeof obj.matrixWorld.isMatrix4 === 'boolean') {
        out.applyMatrix4(obj.matrixWorld);
      }
    } catch {
      /* ignore */
    }
    return out;
  }
  return null;
}

function normalFromSketch(sketch) {
  const n = new THREE.Vector3(0, 0, 1);
  if (!sketch) return n;
  try {
    const nm = new THREE.Matrix3();
    nm.getNormalMatrix(sketch.matrixWorld || new THREE.Matrix4());
    n.applyMatrix3(nm);
  } catch {
    /* ignore */
  }
  if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
  n.normalize();
  return n;
}

function centerFromObject(obj) {
  try {
    const box = new THREE.Box3().setFromObject(obj);
    if (!box.isEmpty()) return box.getCenter(new THREE.Vector3());
  } catch {
    /* ignore */
  }
  return new THREE.Vector3();
}

function normalFromPoints(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const a = points[0], b = points[1];
  for (let i = 2; i < points.length; i++) {
    const c = points[i];
    const ab = b.clone().sub(a);
    const ac = c.clone().sub(a);
    const n = new THREE.Vector3().crossVectors(ab, ac);
    if (n.lengthSq() > 1e-12) return n.normalize();
  }
  return null;
}

function collectSceneSolids(scene) {
  const solids = [];
  const pushIfSolid = (obj) => {
    if (!obj || obj === scene) return;
    const solidLike =
      obj.userData?.isSolid
      || obj.isSolid
      || obj.type === 'Solid'
      || obj.constructor?.name === 'Solid'
      || typeof obj._manifoldize === 'function'
      || typeof obj.union === 'function';
    if (solidLike) solids.push(obj);
  };
  if (!scene) return solids;
  if (typeof scene.traverse === 'function') {
    scene.traverse((obj) => pushIfSolid(obj));
  } else if (Array.isArray(scene.children)) {
    for (const obj of scene.children) pushIfSolid(obj);
  }
  return solids;
}

function chooseNearestSolid(solids, point) {
  if (!Array.isArray(solids) || !solids.length || !point) return null;
  let best = null;
  let bestD2 = Infinity;
  const tmpBox = new THREE.Box3();
  const nearestToBox = new THREE.Vector3();
  for (const s of solids) {
    if (!s) continue;
    try {
      tmpBox.setFromObject(s);
      const clamped = tmpBox.clampPoint(point, nearestToBox);
      const d2 = clamped.distanceToSquared(point);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = s;
      }
    } catch {
      /* ignore solids that fail bbox */
    }
  }
  return best;
}

function collectSketchVertices(sketch) {
  const verts = [];
  try {
    if (!sketch || !Array.isArray(sketch.children)) return verts;
    for (const child of sketch.children) {
      if (!child) continue;
      const sid = child?.userData?.sketchPointId;
      const name = child?.name || '';
      const isCenter = sid === 0 || sid === '0' || name === 'P0' || name.endsWith(':P0');
      if (isCenter) continue;
      const isVertexLike = child.type === 'Vertex' || child.isVertex || child.userData?.isVertex || child.userData?.type === 'VERTEX';
      if (isVertexLike) verts.push(child);
    }
  } catch { /* ignore */ }
  return verts;
}

function collectSketchVerticesByName(scene, sketchName) {
  const verts = [];
  if (!scene || !sketchName) return verts;
  const prefix = `${sketchName}:P`;
  const re = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`);
  const walk = (obj) => {
    if (!obj) return;
    const nm = obj.name || '';
    const m = nm.match(re);
    if (m) {
      const id = Number(m[1]);
      if (id !== 0) verts.push(obj);
    }
    const children = Array.isArray(obj.children) ? obj.children : [];
    for (const c of children) walk(c);
  };
  walk(scene);
  return verts;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeHoleTool({ holeType, radius, straightDepthTotal, sinkDia, sinkAngle, boreDia, boreDepth, res, featureID }) {
  const solids = [];
  const descriptors = [];
  if (holeType === 'COUNTERSINK') {
    const sinkRadius = Math.max(radius, sinkDia * 0.5);
    const angleRad = sinkAngle * (Math.PI / 180);
    const sinkHeight = (sinkRadius - radius) / Math.tan(angleRad * 0.5);
    const coreDepth = Math.max(0, straightDepthTotal - sinkHeight);
    if (sinkHeight > 0) {
      solids.push(new BREP.Cone({
        r1: radius,
        r2: sinkRadius,
        h: sinkHeight,
        resolution: res,
        name: featureID ? `${featureID}_CSK` : 'CSK',
      }));
    }
    if (coreDepth > 0) {
      const cyl = new BREP.Cylinder({
        radius,
        height: coreDepth,
        resolution: res,
        name: featureID ? `${featureID}_Hole` : 'Hole',
      });
      cyl.bakeTRS({ position: [0, sinkHeight, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] });
      solids.push(cyl);
    }
    descriptors.push({
      type: 'COUNTERSINK',
      totalDepth: straightDepthTotal,
      straightDepth: coreDepth,
      countersinkHeight: sinkHeight,
      countersinkDiameter: sinkRadius * 2,
      diameter: radius * 2,
      countersinkAngle: sinkAngle,
      counterboreDepth: 0,
      counterboreDiameter: 0,
    });
  } else if (holeType === 'COUNTERBORE') {
    const coreDepth = Math.max(0, straightDepthTotal - boreDepth);
    if (boreDepth > 0) {
      solids.push(new BREP.Cylinder({
        radius: Math.max(radius, boreDia * 0.5),
        height: boreDepth,
        resolution: res,
        name: featureID ? `${featureID}_CBore` : 'CBore',
      }));
    }
    if (coreDepth > 0) {
      const cyl = new BREP.Cylinder({
        radius,
        height: coreDepth,
        resolution: res,
        name: featureID ? `${featureID}_Hole` : 'Hole',
      });
      cyl.bakeTRS({ position: [0, boreDepth, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] });
      solids.push(cyl);
    }
    descriptors.push({
      type: 'COUNTERBORE',
      totalDepth: straightDepthTotal,
      straightDepth: coreDepth,
      countersinkHeight: 0,
      countersinkDiameter: 0,
      diameter: radius * 2,
      countersinkAngle: 0,
      counterboreDepth: boreDepth,
      counterboreDiameter: Math.max(radius, boreDia * 0.5) * 2,
    });
  } else {
    if (straightDepthTotal > 0) {
      solids.push(new BREP.Cylinder({
        radius,
        height: straightDepthTotal,
        resolution: res,
        name: featureID ? `${featureID}_Hole` : 'Hole',
      }));
    }
    descriptors.push({
      type: 'SIMPLE',
      totalDepth: straightDepthTotal,
      straightDepth: straightDepthTotal,
      countersinkHeight: 0,
      countersinkDiameter: 0,
      diameter: radius * 2,
      countersinkAngle: 0,
      counterboreDepth: 0,
      counterboreDiameter: 0,
    });
  }
  return { solids, descriptors };
}

export class HoleFeature {
  static shortName = 'H';
  static longName = 'Hole';
  static inputParamsSchema = inputParamsSchema;

  constructor() {
    this.inputParams = {};
    this.persistentData = {};
  }

  uiFieldsTest() {
    const t = String(this.inputParams?.holeType || 'SIMPLE').toUpperCase();
    const exclude = [];
    const include = [];
    if (t === 'SIMPLE') {
      exclude.push('countersinkDiameter', 'countersinkAngle', 'counterboreDiameter', 'counterboreDepth');
    } else if (t === 'COUNTERSINK') {
      include.push('countersinkDiameter', 'countersinkAngle', 'boolean', 'face', 'holeType', 'diameter', 'depth', 'throughAll');
      exclude.push('counterboreDiameter', 'counterboreDepth');
    } else if (t === 'COUNTERBORE') {
      include.push('counterboreDiameter', 'counterboreDepth', 'boolean', 'face', 'holeType', 'diameter', 'depth', 'throughAll');
      exclude.push('countersinkDiameter', 'countersinkAngle');
    }
    return { include: include.length ? include : null, exclude };
  }

  async run(partHistory) {
    const params = this.inputParams || {};
    const featureID = params.featureID || params.id || null;
    const selectionRaw = Array.isArray(params.face) ? params.face.filter(Boolean) : (params.face ? [params.face] : []);
    if (!selectionRaw.length) throw new Error('HoleFeature requires a sketch or point selection.');
    const sketch = selectionRaw.find((o) => o && o.type === 'SKETCH') || null;
    const faceSel = selectionRaw.find((o) => o && o.type === 'FACE') || null; // legacy fallback
    const pointObjsRaw = selectionRaw.filter((o) => o && (o.type === 'VERTEX' || o.isVertex || o.userData?.isVertex || o.isPoint));
    const includesSketch = !!sketch;
    const pointObjs = pointObjsRaw.filter((pt) => {
      if (!includesSketch) return true;
      const sid = pt?.userData?.sketchPointId;
      const name = pt?.name || '';
      const isCenter = sid === 0 || sid === '0' || name === 'P0' || name.endsWith(':P0');
      if (!isCenter) return true;
      // If user explicitly picked only P0 (and no sketch), keep it; otherwise skip center when sketch is selected.
      const onlyCenterSelected = !sketch && pointObjsRaw.length === 1;
      return onlyCenterSelected;
    });
    let pointPositions = pointObjs.map((o) => getWorldPosition(o)).filter(Boolean);
    let hasPoints = pointPositions.length > 0;

    // If a sketch is selected but no explicit point refs were provided, use its sketch vertices (excluding center).
    if (!hasPoints && sketch) {
      const extraPts = collectSketchVertices(sketch);
      if (extraPts.length) {
        pointObjs.push(...extraPts);
        pointPositions = pointObjs.map((o) => getWorldPosition(o)).filter(Boolean);
        hasPoints = pointPositions.length > 0;
      }
      if (!hasPoints && partHistory?.scene && sketch?.name) {
        const fallbackPts = collectSketchVerticesByName(partHistory.scene, sketch.name);
        if (fallbackPts.length) {
          pointObjs.push(...fallbackPts);
          pointPositions = pointObjs.map((o) => getWorldPosition(o)).filter(Boolean);
          hasPoints = pointPositions.length > 0;
        }
      }
    }

    let normal = new THREE.Vector3(0, 1, 0);
    let center = new THREE.Vector3();

    if (faceSel) {
      normal = typeof faceSel.getAverageNormal === 'function'
        ? fallbackVector(faceSel.getAverageNormal(), new THREE.Vector3(0, 1, 0))
        : normal;
      if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
      normal.normalize();
      center = centerFromObject(faceSel);
    } else if (sketch) {
      normal = normalFromSketch(sketch);
      center = centerFromObject(sketch);
    } else if (hasPoints) {
      center = pointPositions.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / pointPositions.length);
      const n = normalFromPoints(pointPositions);
      if (n) normal = n;
    }

    const holeType = String(params.holeType || 'SIMPLE').toUpperCase();
    const diameter = Math.max(0, Number(params.diameter) || 0);
    const straightDepthInput = Math.max(0, Number(params.depth) || 0);
    const throughAll = params.throughAll === true;
    const sinkDia = Math.max(0, Number(params.countersinkDiameter) || 0);
    const sinkAngle = Math.max(1, Math.min(179, Number(params.countersinkAngle) || 82));
    const boreDia = Math.max(0, Number(params.counterboreDiameter) || 0);
    const boreDepth = Math.max(0, Number(params.counterboreDepth) || 0);
    const radius = Math.max(1e-4, diameter * 0.5);

    let booleanParam = params.boolean || { targets: [], operation: 'SUBTRACT' };
    const rawTargets = Array.isArray(booleanParam.targets) ? booleanParam.targets : [];
    const filteredTargets = rawTargets.filter((t) => collectSceneSolids(partHistory?.scene).includes(t));
    if (!filteredTargets.length) {
      const parent = (faceSel && collectSceneSolids(partHistory?.scene).includes(faceSel.parent)) ? faceSel.parent : null;
      const sketchParent = (sketch && collectSceneSolids(partHistory?.scene).includes(sketch.parent)) ? sketch.parent : null;
      const firstParent = selectionRaw[0] && collectSceneSolids(partHistory?.scene).includes(selectionRaw[0].parent)
        ? selectionRaw[0].parent
        : null;
      const candidate = parent || sketchParent || firstParent || null;
      if (candidate) {
        booleanParam = { ...booleanParam, targets: [candidate], operation: booleanParam.operation || 'SUBTRACT' };
      } else if (partHistory && partHistory.scene) {
        const solids = collectSceneSolids(partHistory.scene);
        const nearest = chooseNearestSolid(solids, center);
        if (nearest) booleanParam = { ...booleanParam, targets: [nearest], operation: booleanParam.operation || 'SUBTRACT' };
      }
    } else {
      booleanParam = { ...booleanParam, targets: filteredTargets };
    }
    if (booleanParam && typeof booleanParam.operation === 'string') {
      booleanParam = { ...booleanParam, operation: String(booleanParam.operation).toUpperCase() };
    }
    const primaryTarget = (booleanParam.targets && booleanParam.targets[0])
      || (faceSel && faceSel.parent)
      || (sketch && sketch.parent)
      || chooseNearestSolid(collectSceneSolids(partHistory?.scene), center)
      || null;
    if (primaryTarget) {
      try {
        const parentCenter = new THREE.Box3().setFromObject(primaryTarget).getCenter(new THREE.Vector3());
        const toCenter = parentCenter.clone().sub(center);
        if (toCenter.lengthSq() > 1e-10 && normal.dot(toCenter) < 0) {
          normal.multiplyScalar(-1);
        }
      } catch {
        /* ignore orientation flip issues */
      }
    }
    const diag = primaryTarget ? boxDiagonalLength(primaryTarget) : boxDiagonalLength(chooseNearestSolid(collectSceneSolids(partHistory?.scene), center));
    const straightDepth = throughAll ? Math.max(straightDepthInput, diag * 1.5 || 50) : straightDepthInput;

    const res = 48;
    const centers = hasPoints ? pointPositions : [center];
    const sourceNames = hasPoints ? pointObjs.map((o) => o?.name || o?.uuid || null) : [null];
    const tools = [];
    const holeRecords = [];
    centers.forEach((c, idx) => {
      const { solids: toolSolids, descriptors } = makeHoleTool({
        holeType,
        radius,
        straightDepthTotal: straightDepth,
        sinkDia,
        sinkAngle,
        boreDia,
        boreDepth,
        res,
        featureID: featureID ? `${featureID}_${idx}` : null,
      });
      // annotate faces with hole metadata before union so labels propagate
      const descriptor = descriptors[0] || null;
      if (descriptor) {
        descriptor.center = [c?.x ?? center.x, c?.y ?? center.y, c?.z ?? center.z];
        descriptor.normal = [normal.x, normal.y, normal.z];
        descriptor.throughAll = throughAll;
        descriptor.targetId = primaryTarget?.uuid || primaryTarget?.id || primaryTarget?.name || null;
        descriptor.featureId = featureID || null;
        descriptor.sourceName = sourceNames[idx] || null;
        for (const solid of toolSolids) {
          if (!solid || !solid.name) continue;
          const sideName = `${solid.name}_S`;
          try { solid.setFaceMetadata(sideName, { hole: { ...descriptor } }); } catch { }
        }
        holeRecords.push({ ...descriptor });
      }

      const tool = unionSolids(toolSolids);
      if (!tool) return;
      const basis = buildBasisFromNormal(normal);
      basis.setPosition(c || center);
      try { tool.bakeTransform(basis); }
      catch (error) { console.warn('[HoleFeature] Failed to transform tool:', error); }
      // add centerline for PMI/visualization
      const totalDepth = descriptor?.totalDepth || straightDepth || 1;
      const start = c || center;
      const end = start.clone().add(normal.clone().multiplyScalar(totalDepth));
      try {
        tool.addCenterline([start.x, start.y, start.z], [end.x, end.y, end.z], featureID ? `${featureID}_AXIS_${idx}` : `HOLE_AXIS_${idx}`, { materialKey: 'OVERLAY' });
      } catch { /* best-effort */ }
      tools.push(tool);
    });

    if (!tools.length) throw new Error('HoleFeature could not build cutting tool geometry.');
    const combinedTool = tools.length === 1 ? tools[0] : unionSolids(tools);

    const effects = await BREP.applyBooleanOperation(partHistory || {}, combinedTool, booleanParam, featureID);
    try { this.persistentData.holes = holeRecords; } catch { }
    return effects;
  }
}
