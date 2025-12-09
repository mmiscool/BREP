import { BREP } from '../../BREP/BREP.js';
import { ThreadGeometry, ThreadStandard } from '../../BREP/threadGeometry.js';
import { getClearanceDiameter } from './screwClearance.js';

const inputParamsSchema = {
  id: {
    type: 'string',
    default_value: null,
    hint: 'Unique identifier for the hole feature',
  },
  face: {
    type: 'reference_selection',
    label: 'Placement (sketch)',
    selectionFilter: ['SKETCH'],
    multiple: false,
    minSelections: 1,
    default_value: null,
    hint: 'Select a sketch to place the hole',
  },
  holeType: {
    type: 'options',
    label: 'Hole type',
    options: ['SIMPLE', 'COUNTERSINK', 'COUNTERBORE', 'THREADED'],
    default_value: 'SIMPLE',
    hint: 'Choose the hole style',
  },
    clearanceFit: {
    type: 'options',
    label: 'Screw clearance fit',
    options: ['NONE', 'CLOSE', 'NORMAL', 'LOOSE'],
    default_value: 'NONE',
    hint: 'Use screw clearance data to size the hole (NONE keeps manual diameter)',
  },
  clearanceStandard: {
    type: 'options',
    label: 'Clearance standard',
    options: ['ISO_METRIC', 'UNIFIED'],
    default_value: 'ISO_METRIC',
    hint: 'Standard for clearance hole lookup',
  },
  clearanceDesignation: {
    type: 'thread_designation',
    label: 'Clearance screw size / designation',
    default_value: '',
    hint: 'Size to use for clearance hole lookup (e.g. M6x1, 1/4-20UNC, #10-32UNF)',
    standardField: 'clearanceStandard',
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
  threadStandard: {
    type: 'options',
    label: 'Thread standard',
    options: ['NONE', 'ISO_METRIC', 'UNIFIED', 'TRAPEZOIDAL_METRIC', 'ACME', 'STUB_ACME', 'WHITWORTH', 'NPT'],
    default_value: 'NONE',
    hint: 'Thread specification family',
  },
  threadDesignation: {
    type: 'thread_designation',
    label: 'Thread size / designation',
    default_value: '',
    hint: 'Choose a preset for the selected thread standard or enter a custom size (e.g. M6x1, 1/4-20, Tr16x4, 1/4-18NPT, 10-32)',
  },
  threadMode: {
    type: 'options',
    label: 'Thread modeling',
    options: ['SYMBOLIC', 'MODELED'],
    default_value: 'SYMBOLIC',
    hint: 'Symbolic is faster; modeled is helical geometry',
  },
  threadRadialOffset: {
    type: 'number',
    label: 'Thread radial offset',
    default_value: 0,
    step: 0.01,
    hint: 'Optional clearance (+) or interference (-) applied to the thread profile',
  },
  threadSegmentsPerTurn: {
    type: 'number',
    label: 'Thread segments/turn',
    default_value: 24,
    min: 4,
    step: 1,
    hint: 'Resolution for modeled threads (ignored for symbolic)',
  },
  debugShowSolid: {
    type: 'boolean',
    label: 'Debug: show tool solid',
    default_value: false,
    hint: 'Visualize the cutting solid even if it is non-manifold',
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

function parseNumberLike(value) {
  if (value == null) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  const mixed = raw.match(/^([0-9]+)[-\s]+([0-9]+)\/([0-9]+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (Number.isFinite(whole) && Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      return whole + num / den;
    }
  }
  const frac = raw.match(/^([0-9]+)\/([0-9]+)$/);
  if (frac) {
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function unionSolids(solids) {
  if (!Array.isArray(solids) || solids.length === 0) {
    console.warn('[HoleFeature] unionSolids: no solids provided');
    return null;
  }
  console.log('[HoleFeature] unionSolids: combining', solids.length, 'solids');
  let current = solids[0];
  if (!current) {
    console.warn('[HoleFeature] unionSolids: first solid is null/undefined');
    return null;
  }
  console.log('[HoleFeature] unionSolids: first solid type:', current?.constructor?.name);
  for (let i = 1; i < solids.length; i++) {
    const next = solids[i];
    if (!next) continue;
    try { 
      console.log('[HoleFeature] unionSolids: unioning with solid', i, 'type:', next?.constructor?.name);
      current = current.union(next); 
    }
    catch (error) { console.warn('[HoleFeature] Union failed:', error); }
  }
  console.log('[HoleFeature] unionSolids: final result type:', current?.constructor?.name);
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
  const fallback = new THREE.Vector3(0, 0, 1);
  if (!sketch) return fallback;

  // Prefer an explicit sketch basis if provided by the sketch feature.
  const basis = sketch.userData?.sketchBasis;
  if (basis && Array.isArray(basis.x) && Array.isArray(basis.y)) {
    const bx = new THREE.Vector3().fromArray(basis.x);
    const by = new THREE.Vector3().fromArray(basis.y);
    const bz = Array.isArray(basis.z) ? new THREE.Vector3().fromArray(basis.z) : new THREE.Vector3().crossVectors(bx, by);
    if (bz.lengthSq() > 1e-12) return bz.normalize();
  }

  // Fallback to world transform normal if available.
  try {
    const n = new THREE.Vector3(0, 0, 1);
    const nm = new THREE.Matrix3();
    nm.getNormalMatrix(sketch.matrixWorld || new THREE.Matrix4());
    n.applyMatrix3(nm);
    if (n.lengthSq() > 1e-12) return n.normalize();
  } catch { /* ignore */ }

  return new THREE.Vector3(0, 1, 0);
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

function parseThreadGeometry({ standard, designation, isExternal }) {
  const stdRaw = standard || 'NONE';
  const std = String(stdRaw).toUpperCase();
  const desig = String(designation || '').trim();
  if (!desig || std === 'NONE') return null;

  const clean = desig.replace(/\s+/g, '').toUpperCase();
  const gaugeToInch = (n) => 0.06 + 0.013 * n; // approx formula for # screw sizes
  const tryMetric = () => {
    const normalized = clean.replace(/×/g, 'X').replace(/M(?=\d)/, 'M');
    return ThreadGeometry.fromMetricDesignation(normalized, { isExternal });
  };
  const tryTr = () => {
    const normalized = clean.replace(/×/g, 'X').replace(/^TR?/, 'TR');
    return ThreadGeometry.fromTrapezoidalDesignation(normalized, { isExternal });
  };
  const parseDiaTpi = () => {
    const m = clean.match(/^#?([0-9./]+)-([0-9.]+)([A-Z]+)?$/);
    if (!m) return null;
    const rawDia = m[1];
    const tpi = Number(m[2]);
    const series = m[3] ? m[3].toUpperCase() : null;
    let dia = parseNumberLike(rawDia);
    const intOnly = /^[0-9]+$/.test(rawDia);
    if (intOnly && (!Number.isFinite(dia) || dia > 1.5)) {
      const g = Number(rawDia);
      if (Number.isFinite(g) && g >= 0 && g <= 14) dia = gaugeToInch(g);
    }
    if (!Number.isFinite(dia) || !Number.isFinite(tpi) || dia <= 0 || tpi <= 0) return null;
    return { dia, tpi, series };
  };
  const tryUnified = () => {
    const dt = parseDiaTpi();
    if (!dt) return null;
    const g = ThreadGeometry.fromUnified(dt.dia, dt.tpi, { isExternal });
    if (dt.series) g.series = dt.series;
    return g;
  };
  const tryAcme = () => {
    const dt = parseDiaTpi();
    if (!dt) return null;
    return ThreadGeometry.fromAcme(dt.dia, dt.tpi, { isExternal });
  };
  const tryStubAcme = () => {
    const dt = parseDiaTpi();
    if (!dt) return null;
    return ThreadGeometry.fromStubAcme(dt.dia, dt.tpi, { isExternal });
  };
  const tryWhitworth = () => {
    const dt = parseDiaTpi();
    if (!dt) return null;
    return ThreadGeometry.fromWhitworth(dt.dia, dt.tpi, { isExternal });
  };
  const tryNpt = () => {
    const m = clean.replace(/^NPT/i, '').replace(/NPT$/i, '');
    const m1 = m.match(/^([0-9./]+)-([0-9.]+)$/);
    if (!m1) return null;
    const dia = parseNumberLike(m1[1]);
    const tpi = Number(m1[2]);
    if (!Number.isFinite(dia) || !Number.isFinite(tpi) || dia <= 0 || tpi <= 0) return null;
    return ThreadGeometry.fromNPT(dia, tpi, { isExternal, taperDirection: 1 });
  };

  const tryMap = {
    [ThreadStandard.ISO_METRIC]: tryMetric,
    [ThreadStandard.TRAPEZOIDAL_METRIC]: tryTr,
    [ThreadStandard.UNIFIED]: tryUnified,
    [ThreadStandard.ACME]: tryAcme,
    [ThreadStandard.STUB_ACME]: tryStubAcme,
    [ThreadStandard.WHITWORTH]: tryWhitworth,
    [ThreadStandard.NPT]: tryNpt,
  };

  const primary = tryMap[std];
  if (primary) {
    const g = primary();
    if (g) return g;
    console.warn('[HoleFeature] Thread parse failed for requested standard, attempting fallback:', std, desig);
  }

  // Fallback inference by pattern
  if (/^M\d+/i.test(clean)) {
    const g = tryMetric();
    if (g) return g;
  }
  if (/^TR/i.test(clean)) {
    const g = tryTr();
    if (g) return g;
  }
  if (/NPT/i.test(clean)) {
    const g = tryNpt();
    if (g) return g;
  }
  if (clean.includes('-')) {
    const g = tryUnified() || tryAcme() || tryStubAcme() || tryWhitworth();
    if (g) return g;
  }

  throw new Error(`Unable to parse thread designation "${desig}" for standard ${stdRaw}.`);
}

function makeHoleTool({ holeType, radius, straightDepthTotal, sinkDia, sinkAngle, boreDia, boreDepth, res, featureID, omitStraight = false }) {
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
    if (!omitStraight && coreDepth > 0) {
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
    if (!omitStraight && coreDepth > 0) {
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
    if (!omitStraight && straightDepthTotal > 0) {
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
    const clearanceFit = String(this.inputParams?.clearanceFit || 'NONE').toUpperCase();
    const exclude = [];
    const include = ['holeType', 'face', 'boolean', 'debugShowSolid'];
    const addCommon = () => {
      include.push('depth', 'throughAll', 'clearanceFit');
      if (clearanceFit === 'NONE') {
        include.push('diameter');
      } else {
        include.push('clearanceStandard', 'clearanceDesignation');
        exclude.push('diameter');
      }
    };
    const addCommonThreaded = () => {
      include.push('depth', 'throughAll');
      exclude.push('diameter');
    };
    if (t === 'SIMPLE') {
      addCommon();
      exclude.push('countersinkDiameter', 'countersinkAngle', 'counterboreDiameter', 'counterboreDepth');
    } else if (t === 'COUNTERSINK') {
      addCommon();
      include.push('countersinkDiameter', 'countersinkAngle');
      exclude.push('counterboreDiameter', 'counterboreDepth');
    } else if (t === 'COUNTERBORE') {
      addCommon();
      include.push('counterboreDiameter', 'counterboreDepth');
      exclude.push('countersinkDiameter', 'countersinkAngle');
    } else if (t === 'THREADED') {
      addCommonThreaded();
      include.push('threadStandard', 'threadDesignation', 'threadMode', 'threadRadialOffset', 'threadSegmentsPerTurn');
      exclude.push('countersinkDiameter', 'countersinkAngle', 'counterboreDiameter', 'counterboreDepth', 'clearanceFit', 'clearanceStandard', 'clearanceDesignation');
    }
    return { include, exclude };
  }

  async run(partHistory) {
    const params = this.inputParams || {};
    const featureID = params.featureID || params.id || null;
    const selectionRaw = Array.isArray(params.face) ? params.face.filter(Boolean) : (params.face ? [params.face] : []);
    const sketch = selectionRaw.find((o) => o && o.type === 'SKETCH') || null;
    if (!sketch) throw new Error('HoleFeature requires a sketch selection; individual vertex picks are not supported.');

    const pointObjs = [];
    const sceneSolids = collectSceneSolids(partHistory?.scene);
    let pointPositions = [];

    // Use sketch-defined points (excluding the sketch origin) as hole centers.
    const extraPts = collectSketchVertices(sketch);
    if (extraPts.length) {
      pointObjs.push(...extraPts);
      pointPositions = pointObjs.map((o) => getWorldPosition(o)).filter(Boolean);
    }
    if (!pointPositions.length && partHistory?.scene && sketch?.name) {
      const fallbackPts = collectSketchVerticesByName(partHistory.scene, sketch.name);
      if (fallbackPts.length) {
        pointObjs.push(...fallbackPts);
        pointPositions = pointObjs.map((o) => getWorldPosition(o)).filter(Boolean);
      }
    }

    const hasPoints = pointPositions.length > 0;
    const normal = normalFromSketch(sketch); // keep hole axis perpendicular to the sketch plane
    const center = centerFromObject(sketch);

    const holeType = String(params.holeType || 'SIMPLE').toUpperCase();
    const clearanceFit = String(params.clearanceFit || 'NONE').toUpperCase();
    const clearanceStandard = String(params.clearanceStandard || params.threadStandard || 'ISO_METRIC').toUpperCase();
    const clearanceDesignation = String(params.clearanceDesignation || '').trim();
    const diameterManual = Math.max(0, Number(params.diameter) || 0);
    const straightDepthInput = Math.max(0, Number(params.depth) || 0);
    const throughAll = params.throughAll === true;
    const sinkDia = Math.max(0, Number(params.countersinkDiameter) || 0);
    const sinkAngle = Math.max(1, Math.min(179, Number(params.countersinkAngle) || 82));
    const boreDia = Math.max(0, Number(params.counterboreDiameter) || 0);
    const boreDepth = Math.max(0, Number(params.counterboreDepth) || 0);
    const threaded = String(params.holeType || '').toUpperCase() === 'THREADED';
    const threadStandard = String(params.threadStandard || 'NONE').toUpperCase();
    const threadDesignation = String(params.threadDesignation || params.threadSize || '').trim();
    const threadMode = String(params.threadMode || 'SYMBOLIC').toUpperCase();
    const threadRadialOffset = Number(params.threadRadialOffset ?? 0);
    const threadSegmentsPerTurn = Math.max(4, Math.floor(Number(params.threadSegmentsPerTurn ?? (threadMode === 'MODELED' ? 32 : 12))));
    let threadGeom = null;
    if (threaded && threadStandard !== 'NONE' && threadDesignation) {
      try {
        threadGeom = parseThreadGeometry({
          standard: threadStandard,
          designation: threadDesignation,
          isExternal: false,
        });
      } catch (err) {
        console.warn('[HoleFeature] Thread parse failed:', err);
      }
    }
    const threadUnitScale = threadGeom && threadGeom.units === 'inch' ? 25.4 : 1;
    const threadUnitScaleInv = threadUnitScale !== 0 ? 1 / threadUnitScale : 1;
    let clearanceDia = null;
    if (!threaded && clearanceFit !== 'NONE') {
      const lookupDesig = clearanceDesignation || threadDesignation;
      clearanceDia = getClearanceDiameter({
        standard: clearanceStandard,
        designation: lookupDesig,
        fit: clearanceFit,
      });
    }

    const effectiveDiameter = clearanceDia || diameterManual;

    const radius = Math.max(
      1e-4,
      threadGeom ? (threadGeom.crestDiameter * threadUnitScale * 0.5 + threadRadialOffset) : effectiveDiameter * 0.5,
    );
    const debugShowSolid = params.debugShowSolid === true;

    let booleanParam = params.boolean || { targets: [], operation: 'SUBTRACT' };
    const rawTargets = Array.isArray(booleanParam.targets) ? booleanParam.targets : [];
    const filteredTargets = rawTargets.filter((t) => sceneSolids.includes(t));
    if (!filteredTargets.length) {
      const sketchParent = (sketch && sceneSolids.includes(sketch.parent)) ? sketch.parent : null;
      const firstParent = selectionRaw[0] && sceneSolids.includes(selectionRaw[0].parent)
        ? selectionRaw[0].parent
        : null;
      const candidate = sketchParent || firstParent || null;
      if (candidate) {
        booleanParam = { ...booleanParam, targets: [candidate], operation: booleanParam.operation || 'SUBTRACT' };
      } else if (sceneSolids.length) {
        const nearest = chooseNearestSolid(sceneSolids, center);
        if (nearest) booleanParam = { ...booleanParam, targets: [nearest], operation: booleanParam.operation || 'SUBTRACT' };
      }
    } else {
      booleanParam = { ...booleanParam, targets: filteredTargets };
    }
    if (booleanParam && typeof booleanParam.operation === 'string') {
      booleanParam = { ...booleanParam, operation: String(booleanParam.operation).toUpperCase() };
    }
    const primaryTarget = (booleanParam.targets && booleanParam.targets[0])
      || (sketch && sceneSolids.includes(sketch.parent) ? sketch.parent : null)
      || chooseNearestSolid(sceneSolids, center)
      || null;
    if (primaryTarget) {
      // Choose the normal direction that points into the target solid.
      try {
        const box = new THREE.Box3().setFromObject(primaryTarget);
        const toCenter = box.clampPoint(center, new THREE.Vector3()).sub(center);
        if (toCenter.lengthSq() < 1e-12) {
          toCenter.copy(box.getCenter(new THREE.Vector3()).sub(center));
        }
        if (toCenter.lengthSq() > 1e-10 && normal.dot(toCenter) < 0) {
          normal.multiplyScalar(-1);
        }
      } catch {
        /* ignore orientation flip issues */
      }
    }
    const diag = primaryTarget ? boxDiagonalLength(primaryTarget) : boxDiagonalLength(chooseNearestSolid(sceneSolids, center));
    const straightDepth = throughAll ? Math.max(straightDepthInput, diag * 1.5 || 50) : straightDepthInput;

    const res = 48;
    const backOffset = 1e-5; // small pullback to avoid coincident faces in booleans
    const centers = hasPoints ? pointPositions : [center];
    const sourceNames = hasPoints ? pointObjs.map((o) => o?.name || o?.uuid || null) : [null];
    const tools = [];
    const holeRecords = [];
    const debugVisualizationObjects = []; // Store debug viz objects separately
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
        omitStraight: threaded,
      });
      // annotate faces with hole metadata before union so labels propagate
      const descriptor = descriptors[0] || null;
      const basePos = (c || center).clone();
      const originPos = basePos.clone().addScaledVector(normal, -backOffset);
      if (descriptor) {
        if (holeType === 'THREADED') descriptor.type = 'THREADED';
        descriptor.center = [originPos.x, originPos.y, originPos.z];
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
      }

      if (threadGeom) {
        try {
          const axialBlend = 1e-4;
          let threadLength = Math.max(
            0,
            descriptor?.straightDepth ?? descriptor?.totalDepth ?? straightDepth,
          );
          let threadStart = 0;
          if (descriptor?.type === 'COUNTERSINK') threadStart = descriptor.countersinkHeight || 0;
          else if (descriptor?.type === 'COUNTERBORE') threadStart = descriptor.counterboreDepth || 0;
          threadStart = Math.max(0, threadStart - axialBlend);
          threadLength = Math.max(0, threadLength + axialBlend);
          if (threadLength > 0) {
            console.log('[HoleFeature] Generating thread:', {
              mode: threadMode,
              length: threadLength,
              threadStart,
              majorDiameter: threadGeom.majorDiameter,
              minorDiameter: threadGeom.minorDiameter,
              crestRadius: threadGeom.crestRadius,
              rootRadius: threadGeom.rootRadius,
              pitch: threadGeom.pitch,
              isExternal: threadGeom.isExternal,
              radialOffset: threadRadialOffset,
              segmentsPerTurn: threadSegmentsPerTurn,
            });
            // Scale the thread geometry to millimeters if needed
            let threadGeomScaled = threadGeom;
            if (threadUnitScale !== 1) {
              console.log('[HoleFeature] Creating scaled thread geometry with scale factor', threadUnitScale);
              // Create a new ThreadGeometry with scaled dimensions
              threadGeomScaled = new ThreadGeometry({
                standard: threadGeom.standard,
                nominalDiameter: threadGeom.nominalDiameter * threadUnitScale,
                pitch: threadGeom.pitch * threadUnitScale,
                isExternal: threadGeom.isExternal,
                starts: threadGeom.starts,
                taperDirection: threadGeom.taperDirection,
              });
            }
            // Extend one full pitch past both start and end to avoid flats for modeled threads only
            const extraThreadLength = Math.max(0, threadGeomScaled.pitch || threadGeom.pitch || 0);
            const threadStartEffective = threadMode === 'MODELED'
              ? threadStart - extraThreadLength
              : threadStart;
            const threadLengthEffective = threadMode === 'MODELED'
              ? Math.max(0, threadLength + extraThreadLength * 2)
              : threadLength;

            const threadSolid = threadGeomScaled.toSolid({
              length: threadLengthEffective,
              mode: threadMode === 'MODELED' ? 'modeled' : 'symbolic',
              radialOffset: threadRadialOffset,
              symbolicRadius: 'crest',
              includeCore: false, // Core disabled - helical surface only for now
              resolution: res,
              segmentsPerTurn: threadSegmentsPerTurn,
              name: featureID ? `${featureID}_THREAD_${idx}` : 'THREAD',
              faceName: featureID ? `${featureID}_THREAD_FACE` : 'THREAD',
              axis: [0, 1, 0],
              origin: [0, threadStartEffective, 0],
              xDirection: [1, 0, 0],
            });
            console.log('[HoleFeature] Thread solid created:', {
              type: threadSolid?.constructor?.name,
              hasGeometry: !!threadSolid?.geometry,
              vertexCount: threadSolid?.geometry?.attributes?.position?.count,
              triangleCount: threadSolid?.triangles?.length,
              faceCount: threadSolid?.faces?.size,
            });
            
            // Add a core solid at the minor diameter so the threaded hole removes material fully.
            const minorRadiusAt = (z) => {
              try {
                const d = typeof threadGeomScaled.diametersAtZ === 'function'
                  ? threadGeomScaled.diametersAtZ(z)
                  : null;
                const minorDia = Number(d?.minor ?? threadGeomScaled.minorDiameter ?? threadGeomScaled.crestDiameter);
                if (Number.isFinite(minorDia) && minorDia > 0) {
                  return Math.max(1e-4, minorDia * 0.5 + threadRadialOffset);
                }
              } catch { /* ignore */ }
              return Math.max(1e-4, threadGeomScaled.crestRadius + threadRadialOffset);
            };
            const coreR0 = minorRadiusAt(0);
            const coreR1 = minorRadiusAt(threadLengthEffective);
            const coreName = featureID ? `${featureID}_THREAD_CORE_${idx}` : 'THREAD_CORE';
            const coreHeight = threadLengthEffective;
            if (coreHeight > 0) {
              const coreSolid = threadGeomScaled.isTapered && Math.abs(coreR0 - coreR1) > 1e-6
                ? new BREP.Cone({
                  r1: coreR0,
                  r2: coreR1,
                  h: coreHeight,
                  resolution: res,
                  name: coreName,
                })
                : new BREP.Cylinder({
                  radius: coreR0,
                  height: coreHeight,
                  resolution: res,
                  name: coreName,
                });
              coreSolid.bakeTRS({
                position: [0, threadStartEffective, 0],
                rotationEuler: [0, 0, 0],
                scale: [1, 1, 1],
              });
              if (descriptor) {
                try { coreSolid.setFaceMetadata(`${coreName}_S`, { hole: { ...descriptor } }); } catch { /* best-effort */ }
              }
              toolSolids.push(coreSolid);
            }
            
            toolSolids.push(threadSolid);
            
            if (debugShowSolid) {
              try {
                console.log('[HoleFeature] Creating profile cross-section visualization using primitives...');
                
                // Get the profile points from the thread geometry
                const crestR = threadGeomScaled.crestRadius;
                const rootR = threadGeomScaled.rootRadius;
                const pitch = threadGeomScaled.pitch;
                const halfPitch = pitch / 2;
                
                console.log('[HoleFeature] Profile dimensions:', {
                  crestR,
                  rootR,
                  pitch,
                  halfPitch,
                  depth: rootR - crestR,
                });
                
                // Create small spheres at each corner of the profile to visualize it
                const markerSize = Math.max(0.5, pitch * 0.2);
                const vizCenterZ = threadLengthEffective + 5; // Place it above the thread
                
                // Profile corners in [R, Z] cylindrical coords (R=radial, Z=axial position in thread)
                // We need to display this as a cross-section shape oriented perpendicular to hole axis
                // Map: axial variation (Z in profile) -> X, radial distance (R) -> Y, depth -> Z
                const profileCorners = [
                  [-halfPitch, crestR, vizCenterZ],        // X=axial, Y=radial, Z=depth
                  [-halfPitch * 0.3, rootR, vizCenterZ],
                  [halfPitch * 0.3, rootR, vizCenterZ],
                  [halfPitch, crestR, vizCenterZ],
                ];
                
                // Create a marker at each corner - store separately for debug viz
                for (let i = 0; i < profileCorners.length; i++) {
                  const corner = profileCorners[i];
                  const marker = new BREP.Sphere({
                    radius: markerSize,
                    resolution: 16,
                    name: `PROFILE_MARKER_${featureID}_${idx}_${i}`,
                  });
                  marker.bakeTRS({
                    position: corner,
                    rotationEuler: [0, 0, 0],
                    scale: [1, 1, 1],
                  });
                  debugVisualizationObjects.push(marker);
                  console.log(`[HoleFeature] Added profile marker ${i} at`, corner);
                }
                
                // Also create connecting cylinders to show the edges
                for (let i = 0; i < profileCorners.length; i++) {
                  const p1 = profileCorners[i];
                  const p2 = profileCorners[(i + 1) % profileCorners.length];
                  const dx = p2[0] - p1[0];
                  const dy = p2[1] - p1[1];
                  const dz = p2[2] - p1[2];
                  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
                  
                  if (length > 0.01) {
                    const edge = new BREP.Cylinder({
                      radius: markerSize * 0.3,
                      height: length,
                      resolution: 12,
                      name: `PROFILE_EDGE_${featureID}_${idx}_${i}`,
                    });
                    
                    // Position and orient the cylinder to connect the points
                    const midpoint = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];
                    const angleY = Math.atan2(dx, dy);
                    const angleX = Math.atan2(Math.sqrt(dx * dx + dz * dz), dy);
                    
                    edge.bakeTRS({
                      position: midpoint,
                      rotationEuler: [angleX * 180 / Math.PI, 0, angleY * 180 / Math.PI],
                      scale: [1, 1, 1],
                    });
                    debugVisualizationObjects.push(edge);
                  }
                }
                
              } catch (err) {
                console.warn('[HoleFeature] Profile visualization creation failed:', err);
              }
            }
            if (descriptor) {
              descriptor.thread = {
                standard: threadStandard,
                designation: threadDesignation,
                series: threadGeom?.series || null,
                mode: threadMode,
                radialOffset: threadRadialOffset,
                length: threadLengthEffective,
                startOffset: threadStartEffective,
              };
            }
          }
        } catch (threadErr) {
          console.warn('[HoleFeature] Thread generation failed:', threadErr);
        }
      }

      if (descriptor) {
        holeRecords.push({ ...descriptor });
      }

      console.log('[HoleFeature] Unioning', toolSolids.length, 'solids for hole tool');
      console.log('[HoleFeature] Unioning', toolSolids.length, 'solids for hole tool');
      const tool = unionSolids(toolSolids);
      if (!tool) return;
      if (debugShowSolid) {
        try {
          tool.visualize();
        } catch (err) {
          console.warn('[HoleFeature] Debug visualize failed:', err);
        }
      }
      const basis = buildBasisFromNormal(normal);
      basis.setPosition(originPos);
      try { tool.bakeTransform(basis); }
      catch (error) { console.warn('[HoleFeature] Failed to transform tool:', error); }
      // add centerline for PMI/visualization
      const totalDepth = descriptor?.totalDepth || straightDepth || 1;
      const start = originPos;
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
    
    // Add debug visualization objects to the effects if they exist
    if (debugShowSolid && debugVisualizationObjects.length > 0) {
      console.log('[HoleFeature] Adding', debugVisualizationObjects.length, 'debug visualization objects to scene');
      if (!effects.additions) effects.additions = [];
      
      // Convert each solid to a mesh and add to additions
      for (const vizObj of debugVisualizationObjects) {
        try {
          // Convert to mesh and add type/name metadata
          const mesh = vizObj.toMesh ? vizObj.toMesh() : vizObj;
          mesh.type = 'DEBUG_VIZ';
          mesh.name = vizObj.name || 'DEBUG_VIZ';
          mesh.userData = mesh.userData || {};
          mesh.userData.isDebugVisualization = true;
          effects.additions.push(mesh);
          console.log('[HoleFeature] Added debug viz:', mesh.name, 'to scene');
        } catch (err) {
          console.warn('[HoleFeature] Failed to convert debug viz to mesh:', err);
        }
      }
    }
    
    return effects;
  }
}
